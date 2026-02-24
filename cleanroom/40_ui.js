(function (global) {
    'use strict';

    const app = global.CMCleanroom;

    app.getOffersRows = () => [...document.querySelectorAll('.article-row')];
    app.getCartRows = () => [...document.querySelectorAll('tr[data-article-id]')];
    app.getRowsByPage = (pageType) => pageType === 'offers' ? app.getOffersRows() : app.getCartRows();

    app.ensureRowUi = function ensureRowUi(row, pageType) {
        const host = pageType === 'offers' ? row.querySelector('.col-sellerProductInfo') : row.querySelector('td.info');
        if (!host) return null;
        let container = row.querySelector('.cm-cleanroom-row');
        if (container) return container;
        container = app.el('div', { className: 'cm-cleanroom-row', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginTop: '6px' } },
            app.el('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary cm-fetch-line', textContent: '💲' }),
            app.el('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary cm-chart-line', textContent: '📈' }),
            app.el('small', { className: 'cm-ratio-text', style: { lineHeight: '1.2' } })
        );
        host.appendChild(container);
        return container;
    };

    app.attachRowHandlers = function attachRowHandlers(row, pageType) {
        const ui = app.ensureRowUi(row, pageType);
        if (!ui || row.dataset.cmHandlersAttached === 'Y') return;
        row.dataset.cmHandlersAttached = 'Y';
        const fetchBtn = ui.querySelector('.cm-fetch-line');
        const chartBtn = ui.querySelector('.cm-chart-line');
        const ratio = ui.querySelector('.cm-ratio-text');

        fetchBtn.addEventListener('click', async () => {
            fetchBtn.disabled = true;
            try {
                await app.fetchAndApplyRow(row, pageType, { requireChart: false, ratioNode: ratio });
            } finally {
                fetchBtn.disabled = false;
            }
        });

        chartBtn.addEventListener('click', async () => {
            chartBtn.disabled = true;
            try {
                await app.fetchAndApplyRow(row, pageType, { requireChart: true, ratioNode: ratio });
                const chartHtml = app.state.rowChartHtml.get(row);
                if (chartHtml) app.showChartForRow(row, chartHtml);
            } finally {
                chartBtn.disabled = false;
            }
        });
    };

    app.hydrateRowsFromCache = async function hydrateRowsFromCache(pageType) {
        const rows = app.getRowsByPage(pageType);
        for (const row of rows) {
            app.attachRowHandlers(row, pageType);
            await app.applyCachedRatioForRow(row, pageType);
        }
    };

    app.applyCachedRatioForRow = async function applyCachedRatioForRow(row, pageType) {
        const idProduct = app.extractProductId(row);
        if (!idProduct) return false;
        const ui = app.ensureRowUi(row, pageType);
        const ratioNode = ui?.querySelector('.cm-ratio-text');
        if (!ratioNode) return false;
        const foilKey = app.detectFoil(row) ? 'Y' : 'N';
        const qty = app.extractQuantity(row);
        const sellerPrice = app.extractRowPrice(row, pageType);
        if (!Number.isFinite(sellerPrice) || sellerPrice <= 0) return false;

        const fromLookup = app.state.priceGuideLookup?.get(idProduct) || null;
        const selection = app.computePriceSelections(fromLookup, foilKey === 'Y');
        if (!selection || (!Number.isFinite(selection.average) && !Number.isFinite(selection.trend))) return false;
        const ratios = app.computeRatios(selection.average, selection.trend, sellerPrice, qty);
        app.updateRatioText(ratioNode, ratios);
        void app.updateProductPriceGuideFromLookup(idProduct, fromLookup);
        return true;
    };

    app.runHydrationPasses = async function runHydrationPasses(pageType) {
        for (let pass = 0; pass < app.HYDRATION_PASSES; pass += 1) {
            await app.hydrateRowsFromCache(pageType);
            if (app.state.priceGuideLoaded && pass >= 1) break;
            await app.sleep(app.HYDRATION_PASS_DELAY_MS);
        }
    };

    app.getOffersToolbarHost = function getOffersToolbarHost() {
        const pagination = document.querySelector('.pagination');
        const host = pagination?.querySelector('.col-3:nth-of-type(2)') || pagination || document.body;
        return { host };
    };

    app.getCartToolbarHost = function getCartToolbarHost() {
        const host = document.querySelector('.cart-overview .card-body') || document.body;
        return { host };
    };

    app.injectMainToolbar = function injectMainToolbar(pageType) {
        const { host } = pageType === 'offers' ? app.getOffersToolbarHost() : app.getCartToolbarHost();
        if (!host || host.querySelector('.cm-cleanroom-toolbar')) return;
        const allBtn = app.el('button', { type: 'button', textContent: '💲 All', className: 'btn btn-sm btn-primary' });
        const thresholdBtn = app.el('button', { type: 'button', textContent: `💲 >= ${app.state.settings.graphRatioThreshold.toFixed(2)}x`, className: 'btn btn-sm btn-outline-primary' });
        const badge = app.el('span', { className: 'badge bg-secondary', textContent: 'guide: idle' });
        const settingsBtn = app.el('button', { type: 'button', textContent: '⚙ Settings', className: 'btn btn-sm btn-outline-secondary' });
        host.appendChild(app.el('div', { className: 'cm-cleanroom-toolbar', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', margin: '8px 0' } },
            allBtn, thresholdBtn, badge, settingsBtn
        ));
        app.state.priceGuideBadges.add(badge);
        app.state.mainButtons.push(allBtn, thresholdBtn);
        allBtn.addEventListener('click', () => void app.runBatch(pageType, 'all', allBtn, thresholdBtn));
        thresholdBtn.addEventListener('click', () => void app.runBatch(pageType, 'threshold', thresholdBtn, allBtn));
        settingsBtn.addEventListener('click', () => app.openSettingsModal(thresholdBtn));
    };

    app.toggleMainButtons = function toggleMainButtons(disabled, activeButton) {
        for (const button of app.state.mainButtons) {
            button.disabled = disabled;
            if (activeButton && button === activeButton) {
                button.dataset.cmOriginalText = button.dataset.cmOriginalText || button.textContent;
                button.textContent = 'Cancel';
            } else if (button.dataset.cmOriginalText) {
                button.textContent = button.dataset.cmOriginalText;
            }
        }
        app.state.activeMainButton = disabled ? activeButton : null;
    };

    app.extractBestRatioFromNode = function extractBestRatioFromNode(node) {
        if (!node) return NaN;
        const matches = [...(node.textContent || '').matchAll(/([+-]?\d+\.\d+)x/g)].map((m) => Number(m[1]));
        if (!matches.length) return NaN;
        return Math.max(...matches.filter(Number.isFinite));
    };

    app.runBatch = async function runBatch(pageType, mode, clicked, sibling) {
        if (app.state.activeMainButton && app.state.activeMainButton === clicked) {
            app.state.requestQueue?.cancelAll();
            app.toggleMainButtons(false, null);
            return;
        }
        app.toggleMainButtons(true, clicked);
        if (sibling) sibling.disabled = true;
        try {
            await app.warmPriceGuide();
            const rows = app.getRowsByPage(pageType);
            const jobs = [];
            for (const row of rows) {
                const applied = await app.applyCachedRatioForRow(row, pageType);
                const ratioNode = row.querySelector('.cm-ratio-text');
                if (!applied || mode === 'all') {
                    jobs.push({ row, ratioNode, pageType });
                    continue;
                }
                if (mode === 'threshold') {
                    const best = app.extractBestRatioFromNode(ratioNode);
                    if (!Number.isFinite(best) || best >= app.state.settings.graphRatioThreshold) jobs.push({ row, ratioNode, pageType });
                }
            }
            for (const job of jobs) {
                await app.fetchAndApplyRow(job.row, pageType, { requireChart: false, ratioNode: job.ratioNode });
            }
            if (pageType === 'cart') app.renderCartTotals();
        } finally {
            app.toggleMainButtons(false, null);
        }
    };

    app.fetchAndApplyRow = async function fetchAndApplyRow(row, pageType, options) {
        const ratioNode = options?.ratioNode || row.querySelector('.cm-ratio-text');
        const idProduct = app.extractProductId(row);
        if (!idProduct || !ratioNode) return;
        const foilKey = app.detectFoil(row) ? 'Y' : 'N';
        const productLink = row.querySelector('a[href*="/Products/Singles/"]')?.href;
        const url = app.withQuery(productLink || location.href, { idProduct: String(idProduct), isFoil: foilKey });

        let variant = await app.getCachedVariantData(idProduct, foilKey);
        if (!variant || (options?.requireChart && !variant.hasGraph)) {
            variant = await app.state.requestQueue.enqueue({ idProduct, foilKey, url, row });
            if (variant?.pageData) await app.saveVariantData(idProduct, foilKey, variant.pageData);
        }

        const sellerPrice = app.extractRowPrice(row, pageType);
        const qty = app.extractQuantity(row);
        const lookupEntry = app.state.priceGuideLookup?.get(idProduct) || null;
        const fromVariant = {
            avg30: app.parsePrice(variant?.pageData?.averagePriceText || ''),
            trend: app.parsePrice(variant?.pageData?.trendPriceText || '')
        };

        const average = app.firstFinite(lookupEntry?.avg30, lookupEntry?.avg, fromVariant.avg30);
        const trend = app.firstFinite(lookupEntry?.trend, fromVariant.trend);
        const foilAverage = foilKey === 'Y' ? app.firstFinite(lookupEntry?.avg30Foil, lookupEntry?.avgFoil, average) : average;
        const foilTrend = foilKey === 'Y' ? app.firstFinite(lookupEntry?.trendFoil, trend) : trend;
        app.updateRatioText(ratioNode, app.computeRatios(foilAverage, foilTrend, sellerPrice, qty));

        if (variant?.pageData?.chartWrapperHTML) app.state.rowChartHtml.set(row, variant.pageData.chartWrapperHTML);
    };

    app.uniqueChartHtml = function uniqueChartHtml(html, suffix) {
        if (!html) return html;
        return html.replace(/id="([^"]+)"/g, (m, id) => {
            if (!/^chart|canvas|cm/i.test(id)) return m;
            return `id="${id}-${suffix}"`;
        });
    };

    app.mountChartHtml = function mountChartHtml(target, html) {
        target.innerHTML = '';
        const fragment = document.createRange().createContextualFragment(html);
        const scripts = [...fragment.querySelectorAll('script')];
        for (const script of scripts) {
            const fresh = document.createElement('script');
            for (const attr of script.getAttributeNames()) fresh.setAttribute(attr, script.getAttribute(attr) || '');
            fresh.textContent = script.textContent;
            script.replaceWith(fresh);
        }
        target.appendChild(fragment);
    };

    app.showChartForRow = function showChartForRow(row, chartHtml) {
        const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
        const html = app.uniqueChartHtml(chartHtml, suffix);
        let content = app.state.chartContainerByRow.get(row);
        if (!content) {
            content = app.el('div', { style: { minWidth: '480px', minHeight: '240px' } });
            app.state.chartContainerByRow.set(row, content);
        }
        app.mountChartHtml(content, html);

        const draggableApi = unsafeWindow?.attachDraggableBoxIcon || window.attachDraggableBoxIcon;
        const trigger = row.querySelector('.cm-chart-line');
        if (typeof draggableApi === 'function' && trigger) {
            draggableApi(trigger, content, 'Price history');
            trigger.click();
            return;
        }

        let fallback = document.querySelector('#cm-cleanroom-fallback-chart');
        if (!fallback) {
            fallback = app.el('div', { id: 'cm-cleanroom-fallback-chart', style: { position: 'fixed', inset: '8% 8% auto 8%', maxHeight: '80vh', overflow: 'auto', background: '#fff', border: '1px solid #ddd', zIndex: '2147483647', padding: '12px' } });
            document.body.appendChild(fallback);
        }
        fallback.innerHTML = '';
        fallback.appendChild(content);
    };

    app.upsertSummary = function upsertSummary(host, selector, text) {
        let node = host.querySelector(selector);
        if (!node) {
            node = document.createElement('div');
            node.className = selector.replace('.', '');
            node.style.marginTop = '6px';
            node.style.fontWeight = '600';
            host.appendChild(node);
        }
        node.textContent = text;
    };

    app.renderCartTotals = function renderCartTotals() {
        const sections = [...document.querySelectorAll('section[id*="seller"]')];
        let globalSellerTotal = 0;
        let globalAvg = 0;
        let globalTrend = 0;

        for (const section of sections) {
            const rows = [...section.querySelectorAll('tr[data-article-id]')];
            let sellerTotal = 0;
            let avgTotal = 0;
            let trendTotal = 0;
            for (const row of rows) {
                const price = app.extractRowPrice(row, 'cart');
                const qty = app.extractQuantity(row);
                if (Number.isFinite(price)) sellerTotal += price * qty;
                const ratioText = row.querySelector('.cm-ratio-text')?.textContent || '';
                const matches = [...ratioText.matchAll(/(30-day|Trend):\s*([\d.,]+)\s*€/g)];
                for (const [, label, valueText] of matches) {
                    const value = app.parsePrice(valueText);
                    if (!Number.isFinite(value)) continue;
                    if (label === '30-day') avgTotal += value;
                    else trendTotal += value;
                }
            }
            globalSellerTotal += sellerTotal;
            globalAvg += avgTotal;
            globalTrend += trendTotal;
            app.upsertSummary(section, '.cm-seller-estimated', `Estimated Value: 30-day: ${app.formatMoney(avgTotal)} | Trend: ${app.formatMoney(trendTotal)}`);
            app.upsertSummary(section, '.cm-seller-profit', `Profit: 30-day: ${app.formatMoney(avgTotal - sellerTotal)} | Trend: ${app.formatMoney(trendTotal - sellerTotal)}`);
        }

        const overview = document.querySelector('.cart-overview .card-body');
        if (overview) {
            app.upsertSummary(overview, '.cm-total-estimated', `Est. Value: 30-day: ${app.formatMoney(globalAvg)} | Trend: ${app.formatMoney(globalTrend)}`);
            app.upsertSummary(overview, '.cm-total-profit', `Total Profit: 30-day: ${app.formatMoney(globalAvg - globalSellerTotal)} | Trend: ${app.formatMoney(globalTrend - globalSellerTotal)}`);
        }
    };

    app.openSettingsModal = function openSettingsModal(thresholdBtn) {
        if (document.querySelector('#cm-cleanroom-settings')) return;
        const fieldRow = (label, input) => app.el('label', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center', marginBottom: '8px' } }, app.el('span', { textContent: label }), input);
        const form = app.el('form', {},
            ...app.SETTINGS_FIELDS.map((f) => fieldRow(f.label,
                app.el('input', { type: 'number', name: f.key, value: String(app.state.settings[f.key]), min: String(f.min), max: String(f.max), step: String(f.step), style: { width: '120px' } })
            )),
            fieldRow('Graph Queue Mode', (() => {
                const s = app.el('select', { name: 'queueMode' });
                s.innerHTML = '<option value="wait_for_load">wait_for_load</option><option value="fixed_delay">fixed_delay</option>';
                s.value = app.state.settings.queueMode;
                return s;
            })())
        );

        const saveBtn = app.el('button', { type: 'submit', className: 'btn btn-sm btn-primary', textContent: 'Save' });
        const defaultsBtn = app.el('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary', textContent: 'Defaults' });
        const clearBtn = app.el('button', { type: 'button', className: 'btn btn-sm btn-outline-danger', textContent: 'Clear Data' });
        const cancelBtn = app.el('button', { type: 'button', className: 'btn btn-sm btn-light', textContent: 'Cancel' });
        form.appendChild(app.el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' } }, saveBtn, defaultsBtn, clearBtn, cancelBtn));

        const modal = app.el('div', { style: { width: 'min(560px, 94vw)', maxHeight: '88vh', overflow: 'auto', background: '#fff', borderRadius: '10px', padding: '14px' } }, app.el('h3', { textContent: 'Cardmarket settings', style: { margin: '0 0 10px 0' } }), form);
        const overlay = app.el('div', { id: 'cm-cleanroom-settings', style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: '2147483647' } }, modal);
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        document.addEventListener('keydown', function onKey(event) {
            if (event.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onKey);
            }
        }, { once: true });

        cancelBtn.addEventListener('click', close);
        defaultsBtn.addEventListener('click', () => {
            app.saveSettings(app.DEFAULT_SETTINGS);
            close();
            thresholdBtn.textContent = `💲 >= ${app.state.settings.graphRatioThreshold.toFixed(2)}x`;
        });

        clearBtn.addEventListener('click', async () => {
            clearBtn.disabled = true;
            try {
                await app.clearAllData();
                app.state.priceGuideLookup = null;
                app.state.priceGuideLoadingPromise = null;
                app.updatePriceGuideBadge('guide: cleared');
            } finally {
                clearBtn.disabled = false;
            }
        });

        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const formData = new FormData(form);
            const next = { ...app.state.settings };
            for (const [key, value] of formData.entries()) {
                if (key === 'queueMode') {
                    next.queueMode = value === 'fixed_delay' ? 'fixed_delay' : 'wait_for_load';
                    continue;
                }
                next[key] = Number(value);
            }
            app.saveSettings(next);
            thresholdBtn.textContent = `💲 >= ${app.state.settings.graphRatioThreshold.toFixed(2)}x`;
            close();
        });
    };
})(globalThis);
