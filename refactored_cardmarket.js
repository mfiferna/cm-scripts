// ==UserScript==
// @name         Cardmarket Refactored
// @namespace    http://tampermonkey.net/
// @version      6.4
// @description  Preloads daily price-guide data, renders ratios immediately, and loads graphs on demand.
// @author       mfiferna
// @homepage     https://github.com/mfiferna/cm-scripts
// @supportURL   https://github.com/mfiferna/cm-scripts/issues
// @downloadURL  https://github.com/mfiferna/cm-scripts/raw/main/refactored_cardmarket.js
// @updateURL    https://github.com/mfiferna/cm-scripts/raw/main/refactored_cardmarket.js
// @match        https://www.cardmarket.com/en/Magic/Users/*/Offers/*
// @match        https://www.cardmarket.com/en/Magic/ShoppingCart
// @match        https://www.cardmarket.com/en/Magic/Products/Singles/*/*
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      downloads.s3.cardmarket.com
// @run-at       document-start
// ==/UserScript==

(async function () {
    'use strict';

    // Constants
    const PRICE_GUIDE_CACHE_VERSION = 1;
    const SETTINGS_VERSION = 2;
    const SETTINGS_STORAGE_KEY = 'cm-refactored-settings';
    const PRICE_GUIDE_URL = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';
    const CACHE_DB_NAME = 'cm-refactored-cache-db';
    const CACHE_DB_VERSION = 2;
    const PRODUCT_CACHE_STORE = 'products';
    const META_CACHE_STORE = 'meta';
    const PRICE_GUIDE_META_KEY = 'price-guide-meta';
    const IFRAME_READY_INTERVAL_MS = 250;
    const IFRAME_MANUAL_POLL_INTERVAL_MS = 500;
    const DEFAULT_SETTINGS = {
        cacheExpirationHours: 24,
        graphRatioThreshold: 1,
        requestDelayMs: 1000,
        maxInFlightRequests: 0,
        delayRandomizationPercent: 15,
        queueMode: 'wait_for_load',
        delayIncrementOn429Ms: 1000,
        iframeLoadTimeoutMs: 15000,
        iframeReadyTimeoutMs: 5000,
        iframeManualTimeoutMinutes: 5
    };
    const SETTINGS_FIELDS = [
        { key: 'cacheExpirationHours', label: 'Cache Expiration (hours)', min: 1, max: 720, step: 1 },
        { key: 'graphRatioThreshold', label: 'Graph Ratio Threshold (x)', min: 0.5, max: 5, step: 0.05, allowFloat: true },
        { key: 'requestDelayMs', label: 'Request Delay (ms)', min: 100, max: 10000, step: 50 },
        { key: 'maxInFlightRequests', label: 'Max In-Flight Requests (0 = unlimited)', min: 0, max: 100, step: 1 },
        { key: 'delayRandomizationPercent', label: 'Delay Randomization (+/- %)', min: 0, max: 100, step: 1 },
        {
            key: 'queueMode',
            label: 'Graph Queue Mode',
            type: 'select',
            options: [
                { value: 'wait_for_load', label: 'A) Load -> wait for load -> delay -> next' },
                { value: 'fixed_delay', label: 'B) Load -> delay -> next (no wait)' }
            ]
        },
        { key: 'delayIncrementOn429Ms', label: '429 Delay Increment (ms)', min: 0, max: 10000, step: 50 },
        { key: 'iframeLoadTimeoutMs', label: 'Iframe Load Timeout (ms)', min: 1000, max: 120000, step: 500 },
        { key: 'iframeReadyTimeoutMs', label: 'Iframe Data Timeout (ms)', min: 500, max: 60000, step: 250 },
        { key: 'iframeManualTimeoutMinutes', label: 'Manual Unblock Timeout (minutes)', min: 1, max: 60, step: 1 }
    ];

    // State
    let settings = loadUserSettings();
    let requestDelay = settings.requestDelayMs;
    let isProcessing = false;
    let cancelRequested = false;
    let mainButtons = [];
    let activeMainButton = null;
    let settingsModal = null;
    let settingsModalClose = null;
    let activeIframeRequests = new Set();
    let nextIframeRequestId = 1;
    let cloudflareGate = null;
    let priceGuideLookup = null;
    let priceGuideWarmupPromise = null;
    let cacheDbPromise = null;
    const priceGuideStatusBadges = new Set();
    const rowChartHtmlMap = new WeakMap(); // row element → chartWrapperHTML string
    const scriptStartMs = Date.now();
    const PERF_DIAGNOSTICS_ENABLED = true;

    function logPerf(message) {
        if (!PERF_DIAGNOSTICS_ENABLED) return;
        GM_log(`[perf] ${message}`);
    }

    // Initialize
    void cleanupExpiredCache();
    document.addEventListener('DOMContentLoaded', init);

    // ===== INITIALIZATION =====

    function init() {
        const elapsedSinceStart = Date.now() - scriptStartMs;
        logPerf(`init start after ${elapsedSinceStart}ms; path=${location.pathname}`);

        if (isOffersPage()) {
            loadChartLibrary();
            initializeOffersPage();
        } else if (isCartPage()) {
            loadChartLibrary();
            initializeCartPage();
        } else if (isProductPage()) {
            initializeProductPageCache();
        }
    }

    function isOffersPage() {
        return /\/Users\/[^/]+\/Offers\//.test(location.pathname);
    }

    function isCartPage() {
        return location.pathname.includes('/en/Magic/ShoppingCart');
    }

    function isProductPage() {
        return /^\/en\/Magic\/Products\/Singles\/[^/]+\/[^/]+\/?$/.test(location.pathname);
    }

    function initializeProductPageCache(attempt = 0) {
        const pageData = extractPageData(document);
        if (!hasCacheableProductData(pageData)) {
            if (attempt < 5) {
                setTimeout(() => initializeProductPageCache(attempt + 1), 500);
            } else {
                GM_log(`[cache] Skipped product-page cache for ${location.href} (missing price data).`);
            }
            return;
        }

        const productUrl = getCurrentProductCacheUrl();
        setLocalCache(productUrl, pageData, {
            idProduct: extractProductIdFromDocument(document, productUrl),
            isFoil: getCurrentFoilStateFromUrl(productUrl) === 'Y'
        });
        GM_log(`[cache] Stored opened product page: ${productUrl}`);
    }

    function hasCacheableProductData(pageData) {
        return (
            pageData.averagePriceText !== 'N/A' ||
            pageData.trendPriceText !== 'N/A' ||
            Boolean(pageData.chartWrapperHTML)
        );
    }

    function getCurrentProductCacheUrl() {
        const url = new URL(location.href);
        const foilState = url.searchParams.get('isFoil') === 'Y' ? 'isFoil=Y' : 'isFoil=N';
        return buildProductUrl(url.toString(), [foilState]);
    }

    function getCurrentFoilStateFromUrl(urlString) {
        try {
            return new URL(urlString).searchParams.get('isFoil') === 'Y' ? 'Y' : 'N';
        } catch (error) {
            return /(?:[?&])isFoil=Y(?:[&#]|$)/i.test(urlString) ? 'Y' : 'N';
        }
    }

    function extractProductIdFromDocument(doc, productUrl = '') {
        const candidates = [
            doc?.querySelector('input[name="idProduct"]')?.value,
            doc?.querySelector('input[name="productId"]')?.value,
            doc?.querySelector('[data-id-product]')?.getAttribute('data-id-product'),
            doc?.querySelector('[data-product-id]')?.getAttribute('data-product-id')
        ];

        const hrefMatch = /(?:[?&])idProduct=(\d+)/i.exec(productUrl)?.[1]
            || /(?:[?&])productId=(\d+)/i.exec(productUrl)?.[1];
        candidates.push(hrefMatch);

        for (const value of candidates) {
            const parsed = parsePositiveInteger(value);
            if (parsed) return parsed;
        }
        return null;
    }

    function loadChartLibrary() {
        if (typeof Chart === 'undefined') {
            const script = document.createElement('script');
            script.src = '//static.cardmarket.com/img/a1aabefc8f2134d2654a5c7bdcf32647/static-code/public/js/Chart_2_7_2.min.js';
            script.async = true;
            document.head.appendChild(script);
        }
    }

    function initializeOffersPage() {
        ensureSettingsModal();
        insertMainButton('.row.g-0.flex-nowrap.align-items-center.pagination.d-none.d-md-flex.mb-2');
        addPerLineFetchButtons('.article-row', '.col-sellerProductInfo');
        runInitialHydration(() => getOfferRows(), null, { label: 'offers' });
    }

    function initializeCartPage() {
        ensureSettingsModal();
        insertCartMainButton();
        addCartPerLineFetchButtons();
        runInitialHydration(() => getCartRows(), displayCartTotals, { label: 'cart' });
    }

    // ===== BUTTON CREATION =====

    function insertMainButton(containerSelector) {
        const paginationRow = document.querySelector(containerSelector);
        if (!paginationRow) return;

        const col3Elements = paginationRow.querySelectorAll('.d-none.d-sm-block.col-3');
        if (col3Elements.length < 2) return;

        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:8px;float:right';
        const allGraphsButton = createMainBatchButton('💲 All', 'btn btn-primary btn-sm', 'graphs-all', () =>
            onMainGraphButtonClick(getOfferRows(), null, allGraphsButton)
        );
        const thresholdButton = createMainBatchButton(
            `💲 >= ${formatRatioThreshold(settings.graphRatioThreshold)}x`,
            'btn btn-outline-primary btn-sm',
            'graphs-threshold',
            () => onMainGraphButtonClick(getOfferRows(), settings.graphRatioThreshold, thresholdButton)
        );
        controls.append(allGraphsButton, thresholdButton, createPriceGuideStatusBadge(), createSettingsButton('btn btn-secondary btn-sm'));
        col3Elements[1].appendChild(controls);
    }

    function insertCartMainButton() {
        const cardBody = document.querySelector('.card.w-100.cart-overview .card-body.d-flex.flex-column');
        if (!cardBody) return;

        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px';
        const allGraphsButton = createMainBatchButton('💲 All', 'btn btn-primary btn-sm', 'graphs-all', () =>
            onMainGraphButtonClick(getCartRows(), null, allGraphsButton)
        );
        const thresholdButton = createMainBatchButton(
            `💲 >= ${formatRatioThreshold(settings.graphRatioThreshold)}x`,
            'btn btn-outline-primary btn-sm',
            'graphs-threshold',
            () => onMainGraphButtonClick(getCartRows(), settings.graphRatioThreshold, thresholdButton)
        );
        controls.append(allGraphsButton, thresholdButton, createPriceGuideStatusBadge(), createSettingsButton('btn btn-secondary btn-sm'));
        cardBody.appendChild(controls);
    }

    function createMainBatchButton(text, className, role, onClick) {
        const button = createButton(text, className);
        button.dataset.role = role;
        button.dataset.idleText = text;
        button.style.whiteSpace = 'nowrap';
        button.addEventListener('click', onClick);
        mainButtons.push(button);
        return button;
    }

    function createPriceGuideStatusBadge() {
        const badge = document.createElement('span');
        badge.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'padding:0.25rem 0.5rem',
            'border-radius:0.2rem',
            'font-size:0.765625rem',
            'line-height:1.5',
            'border:1px solid #bbb',
            'background:#f7f7f7',
            'color:#555',
            'white-space:nowrap'
        ].join(';');
        badge.textContent = 'Data: idle';
        priceGuideStatusBadges.add(badge);
        return badge;
    }

    function createSettingsButton(className) {
        const button = createButton('⚙ Settings', className);
        button.style.whiteSpace = 'nowrap';
        button.addEventListener('click', openSettingsModal);
        return button;
    }

    function addPerLineFetchButtons(rowSelector, targetSelector) {
        document.querySelectorAll(rowSelector).forEach(row => {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            const target = row.querySelector(targetSelector);
            if (!link || !target) return;

            const lineContainer = createLineContainer(false);
            const fetchBtn = createButton('💲', 'line-fetch-button btn', { fontSize: 'small', margin: '2px 0 2px 5px' });
            fetchBtn.addEventListener('click', () => handleFetchButtonClick(row, link, fetchBtn));
            const graphBtn = createGraphButton();
            graphBtn.addEventListener('click', () => onGraphButtonClick(row, link, graphBtn));

            lineContainer.append(fetchBtn, graphBtn);
            target.appendChild(lineContainer);
        });
    }

    function addCartPerLineFetchButtons() {
        document.querySelectorAll('table.article-table.product-table').forEach(table => {
            table.querySelectorAll('tbody tr[data-article-id]').forEach(row => {
                const link = row.querySelector('a[href*="/en/Magic/Products/"]');
                const infoCell = row.querySelector('td.info');
                if (!link || !infoCell) return;

                const outerDiv = document.createElement('div');
                outerDiv.style.cssText = 'display:inline-flex;width:100%';

                const oldContentDiv = document.createElement('div');
                oldContentDiv.style.cssText = 'display:inline-block;min-width:fit-content;margin:auto 0';
                while (infoCell.firstChild) {
                    oldContentDiv.appendChild(infoCell.firstChild);
                }

                const lineContainer = createLineContainer(true);
                const fetchBtn = createButton('💲', 'line-fetch-button btn', {
                    fontSize: 'small',
                    margin: '2px 0 2px 5px',
                    padding: '2px'
                });
                fetchBtn.addEventListener('click', () => handleFetchButtonClick(row, link, fetchBtn));
                const graphBtn = createGraphButton();
                graphBtn.addEventListener('click', () => onGraphButtonClick(row, link, graphBtn));
                lineContainer.append(fetchBtn, graphBtn);

                outerDiv.append(oldContentDiv, lineContainer);
                infoCell.appendChild(outerDiv);
            });
        });
    }

    // ===== MAIN CLICK HANDLERS =====

    async function onMainGraphButtonClick(rows, minRatio, clickedButton) {
        if (isProcessing) return requestCancellation();
        if (!rows.length) return logError('No article rows found to process.');

        if (!priceGuideLookup) {
            try {
                await warmupPriceGuideData();
            } catch (error) {
                logError('Price guide preload failed:', error);
            }
        }

        if (priceGuideLookup) {
            applyPriceGuideToRows(rows);
        }

        const filteredRows = Number.isFinite(minRatio)
            ? rows.filter(row => getRowBestRatio(row) >= minRatio)
            : rows;

        if (!filteredRows.length) {
            GM_log(`[graphs] No rows matched the ${formatRatioThreshold(minRatio)}x threshold.`);
            return;
        }

        const onComplete = isCartPage() ? displayCartTotals : () => {};
        loadData(filteredRows, onComplete, { batchButton: clickedButton });
    }

    function displayCartTotals(urlData) {
        document.querySelectorAll('section[id*="seller"]').forEach(seller => {
            const articleDiv = seller.querySelector('.item-value')?.parentNode;
            const totalDiv = seller.querySelector('.strong.total')?.parentNode;
            const totalValue = parsePrice(seller.querySelector('.strong.total')?.textContent || '0');

            const cartRows = Array.from(seller.querySelectorAll('table.article-table.product-table tbody tr[data-article-id]'));
            let sellerAverage = 0, sellerTrend = 0;
            cartRows.forEach(row => {
                const link = row.querySelector('a[href*="/en/Magic/Products/"]');
                if (!link) return;
                const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
                const data = urlData[productUrl];
                if (data) {
                    sellerAverage += data.averagePrice;
                    sellerTrend += data.trendPrice;
                }
            });

            if (articleDiv) {
                replaceOrInsert(seller, articleDiv, 'value-div',
                    'Estimated Value',
                    `30-day: ${sellerAverage.toFixed(2)} € | Trend: ${sellerTrend.toFixed(2)} €`);
            }
            if (totalDiv) {
                replaceOrInsert(seller, totalDiv, 'profit-div',
                    'Profit',
                    `30-day: ${(sellerAverage - totalValue).toFixed(2)} € | Trend: ${(sellerTrend - totalValue).toFixed(2)} €`);
            }
        });

        const cartDiv = document.querySelector('.card.w-100.cart-overview .card-body');
        if (!cartDiv) return;
        const articleValueDiv = cartDiv.querySelector('.item-value')?.parentNode;
        const totalValueDiv = [...cartDiv.querySelectorAll('.d-flex')].pop();
        const totalPrice = parsePrice([...(totalValueDiv?.querySelectorAll('span') ?? [])].pop()?.textContent || '0');

        const { trend: totalTrend, average: totalAverage } = sumPrices(urlData);

        if (articleValueDiv) {
            replaceOrInsert(cartDiv, articleValueDiv, 'value-div',
                'Est. Value',
                `30-day: ${totalAverage.toFixed(2)} € | Trend: ${totalTrend.toFixed(2)} €`);
        }
        if (totalValueDiv) {
            replaceOrInsert(cartDiv, totalValueDiv, 'profit-div',
                'Total Profit',
                `30-day: ${(totalAverage - totalPrice).toFixed(2)} € | Trend: ${(totalTrend - totalPrice).toFixed(2)} €`);
        }
    }

    function createGraphButton() {
        const btn = createButton('📈', 'graph-btn btn btn-sm', { marginLeft: '3px' });
        btn.style.opacity = '0.3';
        btn.title = 'Graph (click to load)';
        return btn;
    }

    function setGraphButtonStyle(graphBtn, state) {
        if (state === 'ready') {
            graphBtn.style.opacity = '';
            graphBtn.disabled = false;
            graphBtn.title = 'Show graph';
        } else if (state === 'unloaded') {
            graphBtn.style.opacity = '0.3';
            graphBtn.disabled = false;
            graphBtn.title = 'Graph (click to load)';
        } else if (state === 'loading') {
            graphBtn.style.opacity = '0.6';
            graphBtn.disabled = true;
            graphBtn.title = 'Loading graph...';
        }
    }

    function onGraphButtonClick(row, link, graphBtn) {
        // Once attachDraggableBoxIcon has been called on this button, it owns click handling.
        if (graphBtn.dataset.graphBound === '1') return;

        const bindAndShow = (htmlStr) => {
            const chart = createElementFromHTML(htmlStr);
            const productName = getProductName(row) + (getFoilBool(row) ? ' ⭐' : '');
            if (typeof unsafeWindow.attachDraggableBoxIcon === 'function') {
                unsafeWindow.attachDraggableBoxIcon(graphBtn, chart, productName);
                graphBtn.dataset.graphBound = '1';
                // Trigger draggable_box's click handler to show the box immediately.
                graphBtn.dispatchEvent(new MouseEvent('click', { bubbles: false }));
            }
        };

        const cached = rowChartHtmlMap.get(row);
        if (cached) {
            bindGraphButtonIfReady(row, graphBtn);
            bindAndShow(cached);
            return;
        }

        setGraphButtonStyle(graphBtn, 'loading');
        const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
        fetchProductData(productUrl, { row, link })
            .then(data => {
                // Also render ratio data on the row if not already shown.
                processProductPage(data, row);
                if (data.chartWrapperHTML) {
                    // rowChartHtmlMap is populated by processProductPage → displayResults.
                    bindAndShow(data.chartWrapperHTML);
                } else {
                    setGraphButtonStyle(graphBtn, 'unloaded');
                    graphBtn.title = 'No graph available for this product';
                }
            })
            .catch(err => {
                setGraphButtonStyle(graphBtn, 'unloaded');
                logError('Error loading graph:', err);
            });
    }

    function bindGraphButtonIfReady(row, graphBtn) {
        if (!graphBtn || graphBtn.dataset.graphBound === '1') return false;
        const chartHtml = rowChartHtmlMap.get(row);
        if (!chartHtml || typeof unsafeWindow.attachDraggableBoxIcon !== 'function') return false;

        const chart = createElementFromHTML(chartHtml);
        const productName = getProductName(row) + (getFoilBool(row) ? ' ⭐' : '');
        unsafeWindow.attachDraggableBoxIcon(graphBtn, chart, productName);
        graphBtn.dataset.graphBound = '1';
        return true;
    }

    function handleFetchButtonClick(row, link, fetchBtn) {
        const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
        
        disableButton(fetchBtn, '...');
        fetchProductData(productUrl, { row, link })
            .then(data => processProductPage(data, row))
            .catch(err => logError('Error fetching product page:', err))
            .finally(() => enableButton(fetchBtn, '💲'));
    }

    // ===== DATA LOADING =====

    function runInitialHydration(getRows, onComplete = null, options = {}) {
        const maxPasses = Number.isFinite(options.maxPasses) ? options.maxPasses : 10;
        const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 600;
        const label = options.label || 'unknown';
        const hydrationStartedAt = Date.now();
        let hydrationPassInFlight = false;
        let hydrationStopped = false;
        let warmupResolved = false;
        logPerf(`hydration:${label} start maxPasses=${maxPasses} interval=${intervalMs}ms`);
        setHydrationButtonsDisabled(true);

        let timer = null;
        const stopHydration = (reason) => {
            if (hydrationStopped) return;
            hydrationStopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            setHydrationButtonsDisabled(false);
            logPerf(`hydration:${label} stopped early (${reason}) at +${Date.now() - hydrationStartedAt}ms`);
        };

        const hydrateRows = (reason = 'interval', passNumber = 0) => {
            if (hydrationStopped) {
                return Promise.resolve({ rows: 0, cacheHits: 0, priceGuideApplied: 0, skipped: true });
            }

            if (hydrationPassInFlight) {
                if (passNumber <= 2 || reason !== 'interval' || passNumber === maxPasses) {
                    logPerf(`hydration:${label} pass=${passNumber} reason=${reason} skipped (previous pass still running)`);
                }
                return Promise.resolve({ rows: 0, cacheHits: 0, priceGuideApplied: 0, skipped: true });
            }

            const passStartedAt = Date.now();
            const rows = getRows();
            if (!rows.length) {
                logPerf(`hydration:${label} pass=${passNumber} reason=${reason} rows=0`);
                return Promise.resolve({ rows: 0, cacheHits: 0, priceGuideApplied: 0 });
            }

            hydrationPassInFlight = true;
            let priceGuideApplied = 0;

            if (priceGuideLookup) {
                const before = Date.now();
                priceGuideApplied = applyPriceGuideToRows(rows);
                const applyDuration = Date.now() - before;
                if (passNumber <= 2 || reason !== 'interval' || passNumber === maxPasses) {
                    logPerf(`hydration:${label} pass=${passNumber} reason=${reason} priceGuideApplied=${priceGuideApplied} duration=${applyDuration}ms`);
                }
            }

            return autoLoadFromCache(rows, onComplete, { label, reason, passNumber })
                .then(stats => {
                    const passDuration = Date.now() - passStartedAt;
                    if (passNumber <= 2 || reason !== 'interval' || passNumber === maxPasses) {
                        logPerf(`hydration:${label} pass=${passNumber} reason=${reason} rows=${stats.rows} cacheHits=${stats.cacheHits} duration=${passDuration}ms`);
                    }

                    if (warmupResolved && !hydrationStopped && (priceGuideApplied > 0 || stats.cacheHits > 0)) {
                        stopHydration(`warmup-ready cacheHits=${stats.cacheHits} applied=${priceGuideApplied}`);
                    }

                    return { ...stats, priceGuideApplied };
                })
                .catch(error => {
                    logPerf(`hydration:${label} pass=${passNumber} reason=${reason} autoLoad failed: ${error.message}`);
                    return { rows: rows.length, cacheHits: 0, priceGuideApplied };
                })
                .finally(() => {
                    hydrationPassInFlight = false;
                });
        };

        void hydrateRows('initial', 1);

        let passCount = 0;
        timer = setInterval(() => {
            passCount += 1;
            void hydrateRows('interval', passCount + 1);
            if (passCount >= maxPasses) {
                clearInterval(timer);
                timer = null;
                setHydrationButtonsDisabled(false);
                logPerf(`hydration:${label} completed after ${Date.now() - hydrationStartedAt}ms`);
            }
        }, intervalMs);

        void warmupPriceGuideData()
            .then(() => {
                warmupResolved = true;
                void hydrateRows('warmup-ready', passCount + 1);
                logPerf(`hydration:${label} warmup resolved at +${Date.now() - hydrationStartedAt}ms`);
            })
            .catch(error => {
                logError('Price guide preload failed during initial hydration:', error);
                stopHydration(`warmup-failed: ${error.message}`);
                logPerf(`hydration:${label} warmup failed at +${Date.now() - hydrationStartedAt}ms: ${error.message}`);
            });
    }

    function setHydrationButtonsDisabled(disabled) {
        const mark = disabled ? '1' : '';

        mainButtons.forEach(button => {
            if (disabled) {
                button.dataset.cmHydrationDisabled = mark;
                button.disabled = true;
                return;
            }

            if (button.dataset.cmHydrationDisabled !== '1') return;
            delete button.dataset.cmHydrationDisabled;
            if (!isProcessing) {
                enableButton(button, button.dataset.idleText || button.textContent);
            }
        });

        document.querySelectorAll('.line-fetch-button, .graph-btn').forEach(button => {
            if (disabled) {
                button.dataset.cmHydrationDisabled = mark;
                button.disabled = true;
                return;
            }

            if (button.dataset.cmHydrationDisabled !== '1') return;
            delete button.dataset.cmHydrationDisabled;
            if (button.classList.contains('line-fetch-button')) {
                enableButton(button, '💲');
            } else if (button.classList.contains('graph-btn')) {
                button.disabled = false;
            }
        });
    }

    function autoLoadFromCache(rows, onComplete = null, context = {}) {
        const urlData = {};
        const startedAt = Date.now();
        const rowEntries = rows.map(row => {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            if (!link) return null;
            const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
            const productContext = resolveProductContext({ row, link }, productUrl);
            return { row, link, productUrl, productContext };
        }).filter(Boolean);

        const uniqueIds = rowEntries
            .map(entry => entry.productContext.idProduct)
            .filter(Boolean);

        return getProductRecordsByIds(uniqueIds)
            .then(recordsById => {
                rowEntries.forEach(entry => {
                    const { row, link, productUrl, productContext } = entry;
                    const record = recordsById[productContext.idProduct] || null;
                    const variant = getVariantRecord(record, productContext.isFoil);
                    const cachedData = variant?.pageData;
                    const isFresh = Boolean(variant?.timestamp) && Date.now() - variant.timestamp < getCacheExpirationMs();

                    if (!cachedData || !isFresh || !hasCacheableProductData(cachedData)) return;

                    try {
                        urlData[productUrl] = processProductPage(cachedData, row);
                    } catch (err) {
                        logError(`Error auto-loading cached data for "${link.textContent.trim()}"`, err);
                    }
                });
            })
            .then(() => {
                const cacheHits = Object.keys(urlData).length;
                if (onComplete && cacheHits > 0) onComplete(urlData);
                if (context.reason !== 'interval' || (context.passNumber || 0) <= 2) {
                    logPerf(`autoLoad:${context.label || 'unknown'} reason=${context.reason || 'n/a'} pass=${context.passNumber || 0} rows=${rows.length} cacheHits=${cacheHits} duration=${Date.now() - startedAt}ms`);
                }
                return { rows: rows.length, cacheHits };
            })
            .catch(err => {
                logError('Error during cache auto-load:', err);
                logPerf(`autoLoad:${context.label || 'unknown'} failed after ${Date.now() - startedAt}ms: ${err.message}`);
                return { rows: rows.length, cacheHits: 0 };
            });
    }

    function loadData(articleRows, dataCallback = () => {}, options = {}) {
        const rowData = {};
        const fetchNeeded = [];

        Promise.all(articleRows.map(async row => {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            if (!link) return;

            const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
            const cachedData = await checkLocalCache(productUrl, { row, link });

            if (cachedData) {
                try {
                    rowData[productUrl] = processProductPage(cachedData, row);
                } catch (err) {
                    logError(`Error processing cached data for "${link.textContent.trim()}"`, err);
                }
                return;
            }

            fetchNeeded.push(row);
        }))
            .then(() => {
                if (fetchNeeded.length > 0) {
                    startProcessing(fetchNeeded, options.batchButton || null);
                    processQueue(fetchNeeded, data => dataCallback({ ...data, ...rowData }));
                } else {
                    GM_log('All items satisfied via cache.');
                    dataCallback(rowData);
                }
            })
            .catch(err => {
                logError('Error preparing queued requests:', err);
                dataCallback(rowData);
            });
    }

    function createRetryableError(message, code) {
        const error = new Error(message);
        error.code = code;
        error.retryable = true;
        return error;
    }

    function isRetryableFetchError(error) {
        if (!error) return false;
        if (error.retryable) return true;
        return ['CLOUDFLARE_ABORTED', 'CLOUDFLARE_ACTIVE', 'IFRAME_DATA_UNAVAILABLE'].includes(error.code);
    }

    function handleQueueFetchError(err, row, queue, productName) {
        if (/Non-200 response: 429/.test(err.message)) {
            requestDelay += settings.delayIncrementOn429Ms;
            queue.push(row); // Retry later
            return;
        }

        if (isRetryableFetchError(err)) {
            queue.push(row);
            GM_log(`[queue] Retrying "${productName}" after ${err.code || err.message}`);
            return;
        }

        logError(`Error fetching "${productName}":`, err);
    }

    function processQueue(queue, finishCallback, progressData = {}) {
        if (settings.queueMode === 'fixed_delay') {
            return processQueueWithFixedDelay(queue, finishCallback, progressData);
        }

        return processQueueWaitForLoad(queue, finishCallback, progressData);
    }

    function processQueueWaitForLoad(queue, finishCallback, progressData = {}) {
        if (cloudflareGate) {
            return cloudflareGate.promise.finally(() => {
                if (!cancelRequested) {
                    setTimeout(
                        () => processQueueWaitForLoad(queue, finishCallback, progressData),
                        getRandomizedDelayMs(requestDelay)
                    );
                } else {
                    finishProcessing();
                }
            });
        }

        if (queue.length === 0 || cancelRequested) {
            if (queue.length === 0 && finishCallback) finishCallback(progressData);
            return finishProcessing();
        }

        const row = queue.shift();
        const link = row.querySelector('a[href*="/en/Magic/Products/"]');
        if (!link) return processQueueWaitForLoad(queue, finishCallback, progressData);

        const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
        const productName = link.textContent.trim() || "Unknown Product";

        fetchProductData(productUrl, { row, link })
            .then(data => {
                if (!cancelRequested) {
                    try {
                        progressData[productUrl] = processProductPage(data, row);
                    } catch (e) {
                        logError(`Error processing "${productName}":`, e);
                    }
                }
            })
            .catch(err => {
                if (!cancelRequested) {
                    handleQueueFetchError(err, row, queue, productName);
                }
            })
            .finally(() => {
                if (!cancelRequested) {
                    setTimeout(
                        () => processQueueWaitForLoad(queue, finishCallback, progressData),
                        getRandomizedDelayMs(requestDelay)
                    );
                } else {
                    finishProcessing();
                }
            });
    }

    function processQueueWithFixedDelay(queue, finishCallback, progressData = {}) {
        let inFlight = 0;
        let dispatchTimer = null;
        let finished = false;
        let waitingForCloudflare = false;

        const maybeFinish = () => {
            if (finished) return;

            if (cancelRequested) {
                finished = true;
                if (dispatchTimer) clearTimeout(dispatchTimer);
                finishProcessing();
                return;
            }

            if (queue.length === 0 && inFlight === 0) {
                finished = true;
                if (finishCallback) finishCallback(progressData);
                finishProcessing();
            }
        };

        const scheduleNext = (delayMs) => {
            if (finished || cancelRequested || dispatchTimer || queue.length === 0) return;
            dispatchTimer = setTimeout(dispatchNext, getRandomizedDelayMs(delayMs));
        };

        const dispatchNext = () => {
            dispatchTimer = null;
            if (finished || cancelRequested) {
                maybeFinish();
                return;
            }

            if (cloudflareGate) {
                if (!waitingForCloudflare) {
                    waitingForCloudflare = true;
                    cloudflareGate.promise.finally(() => {
                        waitingForCloudflare = false;
                        if (!finished && !cancelRequested) scheduleNext(requestDelay);
                    });
                }
                return;
            }

            if (queue.length === 0) {
                maybeFinish();
                return;
            }

            const maxInFlightRequests = settings.maxInFlightRequests;
            if (maxInFlightRequests > 0 && inFlight >= maxInFlightRequests) {
                scheduleNext(requestDelay);
                return;
            }

            const row = queue.shift();
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            if (!link) {
                scheduleNext(requestDelay);
                maybeFinish();
                return;
            }

            const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
            const productName = link.textContent.trim() || "Unknown Product";
            inFlight += 1;

            fetchProductData(productUrl, { row, link })
                .then(data => {
                    if (!cancelRequested) {
                        try {
                            progressData[productUrl] = processProductPage(data, row);
                        } catch (e) {
                            logError(`Error processing "${productName}":`, e);
                        }
                    }
                })
                .catch(err => {
                    if (!cancelRequested) {
                        handleQueueFetchError(err, row, queue, productName);
                    }
                })
                .finally(() => {
                    inFlight -= 1;
                    if (!cancelRequested) {
                        scheduleNext(requestDelay);
                    }
                    maybeFinish();
                });

            scheduleNext(requestDelay);
        };

        dispatchNext();
    }

    // ===== DATA PROCESSING =====

    function processProductPage(data, row) {
        const quantity = getQuantity(row);
        const averagePrice = parsePrice(data.averagePriceText) * quantity;
        const trendPrice = parsePrice(data.trendPriceText) * quantity;
        const sellerPrice = getSellerPrice(row) * quantity;
        const averageRatio = averagePrice / sellerPrice;
        const trendRatio = trendPrice / sellerPrice;

        setRowRatios(row, averageRatio, trendRatio);
        displayResults(
            row,
            averagePrice,
            trendPrice,
            sellerPrice,
            averageRatio,
            trendRatio,
            data.averagePriceText,
            data.trendPriceText,
            data.chartWrapperHTML
        );

        return {
            averagePrice,
            averagePriceText: data.averagePriceText,
            trendPrice,
            trendPriceText: data.trendPriceText,
            sellerPrice,
            quantity,
            averageRatio,
            trendRatio
        };
    }

    function getQuantity(row) {
        if (!isCartPage()) return 1;
        const qtySelect = row.querySelector('select');
        return qtySelect ? parseInt(qtySelect.value, 10) || 1 : 1;
    }

    function getSellerPrice(row) {
        let priceElement;
        if (isCartPage()) {
            priceElement = row.querySelector('td.price');
        } else {
            priceElement = [...row.querySelectorAll('.price-container span')]
                .find(span => span.textContent.includes('€'));
        }
        return parsePrice(priceElement?.textContent.trim() || 'N/A');
    }

    function displayResults(row, averagePrice, trendPrice, sellerPrice, averageRatio, trendRatio, avgText, trendText, chartHTML) {
        const lineContainer = row.querySelector('.line-container');
        if (!lineContainer) return;

        clearOldResults(lineContainer);

        const innerLiner = createInnerLiner(isCartPage());
        innerLiner.append(
            createResultContainer('30-day', avgText, averageRatio),
            createResultContainer('Trend', trendText, trendRatio)
        );
        lineContainer.appendChild(innerLiner);

        // Re-append graphBtn after innerLiner so it appears after the ratio text.
        const graphBtn = lineContainer.querySelector('.graph-btn');
        if (graphBtn) lineContainer.appendChild(graphBtn);

        if (chartHTML) {
            rowChartHtmlMap.set(row, chartHTML);
            if (graphBtn) {
                setGraphButtonStyle(graphBtn, 'ready');
                bindGraphButtonIfReady(row, graphBtn);
            }
            row.dataset.cmGraphLoaded = '1';
        } else if (!row.dataset.cmGraphLoaded) {
            row.dataset.cmGraphLoaded = '0';
        }
    }

    function getProductName(row) {
        const link = row.querySelector('a[href*="/en/Magic/Products/"]');
        if (!isCartPage()) return link?.textContent.trim() || 'chart';
        
        const parent = row.closest('.card-body');
        const seller = parent?.querySelector('.seller-info a[href*="/en/Magic/Users/"]')?.textContent.trim() || '';
        return seller ? `${seller} - ${link?.textContent.trim() || ''}` : link?.textContent.trim() || 'chart';
    }

    function createResultContainer(label, priceText, difference) {
        const container = createContainer();
        const hasValidDifference = Number.isFinite(difference);
        const diffSign = hasValidDifference ? (difference > 1 ? '-' : difference < 1 ? '+' : '') : '';
        const diffValue = hasValidDifference ? `${Math.abs(difference).toFixed(2)} x` : 'N/A';

        container.appendChild(document.createTextNode(`${label}: ${priceText} | Diff: `));
        container.appendChild(createDiffSpan(diffSign, diffValue));

        return container;
    }

    // ===== FETCHING & CACHING =====

    function waitForCloudflareGate() {
        return cloudflareGate ? cloudflareGate.promise : Promise.resolve();
    }

    function registerActiveIframeRequest(productUrl) {
        const request = {
            id: nextIframeRequestId++,
            productUrl,
            cancel: null,
            isCloudflareOwner: false
        };
        activeIframeRequests.add(request);
        return request;
    }

    function unregisterActiveIframeRequest(request) {
        activeIframeRequests.delete(request);
    }

    function cancelOtherActiveIframeRequests(ownerRequestId, triggeringUrl) {
        const snapshot = Array.from(activeIframeRequests);
        snapshot.forEach(request => {
            if (request.id === ownerRequestId) return;
            if (typeof request.cancel !== 'function') return;
            request.cancel(
                createRetryableError(
                    `Canceled due to Cloudflare challenge while loading "${triggeringUrl}"`,
                    'CLOUDFLARE_ABORTED'
                )
            );
        });
    }

    function openCloudflareGate(ownerRequest, productUrl) {
        if (!cloudflareGate) {
            let resolveGate;
            const gatePromise = new Promise(resolve => {
                resolveGate = resolve;
            });

            cloudflareGate = {
                ownerRequestId: ownerRequest.id,
                productUrl,
                promise: gatePromise,
                resolve: resolveGate
            };

            ownerRequest.isCloudflareOwner = true;
            GM_log(`[cache] Cloudflare challenge detected for ${productUrl}. Pausing other iframe loads.`);
            cancelOtherActiveIframeRequests(ownerRequest.id, productUrl);
            return true;
        }

        return cloudflareGate.ownerRequestId === ownerRequest.id;
    }

    function closeCloudflareGateIfOwner(request) {
        if (!request?.isCloudflareOwner) return;
        request.isCloudflareOwner = false;

        if (!cloudflareGate || cloudflareGate.ownerRequestId !== request.id) return;

        const resolveGate = cloudflareGate.resolve;
        cloudflareGate = null;
        resolveGate();
        GM_log('[cache] Cloudflare gate closed. Resuming queued loads.');
    }

    function fetchProductData(productUrl, context = {}) {
        return getCachedData(productUrl, context, () => fetchProductDataViaIframe(productUrl));
    }

    function fetchProductDataViaIframe(productUrl) {
        return waitForCloudflareGate().then(() => new Promise((resolve, reject) => {
            const request = registerActiveIframeRequest(productUrl);
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none;left:-9999px;top:-9999px';

            let settled = false;
            let loadTimeout;
            let pollInterval;
            let unblockOverlay;
            let manualUnblockStarted = false;

            const cleanup = () => {
                clearTimeout(loadTimeout);
                clearInterval(pollInterval);
                iframe.removeEventListener('load', onLoad);
                iframe.removeEventListener('error', onError);
                if (unblockOverlay?.parentNode) unblockOverlay.remove();
                if (iframe.parentNode) iframe.remove();
                unregisterActiveIframeRequest(request);
            };

            const finalize = (callback, payload) => {
                if (settled) return;
                settled = true;
                cleanup();
                closeCloudflareGateIfOwner(request);
                callback(payload);
            };

            request.cancel = (error = createRetryableError(
                `Iframe request canceled for "${productUrl}"`,
                'IFRAME_CANCELED'
            )) => finalize(reject, error);

            const readFrameState = () => {
                try {
                    const frameDoc = iframe.contentDocument;
                    if (!frameDoc) {
                        return { data: null, blocked: false };
                    }
                    return {
                        data: extractPageData(frameDoc),
                        blocked: isLikelyBlockedDocument(frameDoc)
                    };
                } catch (err) {
                    // Security challenge pages may temporarily be cross-origin.
                    return { data: null, blocked: true };
                }
            };

            const startManualUnblockMode = () => {
                if (manualUnblockStarted) return;
                const ownsCloudflareGate = openCloudflareGate(request, productUrl);
                if (!ownsCloudflareGate) {
                    return finalize(
                        reject,
                        createRetryableError(`Cloudflare challenge already active for "${productUrl}"`, 'CLOUDFLARE_ACTIVE')
                    );
                }

                manualUnblockStarted = true;
                GM_log(`[cache] Request appears blocked for ${productUrl}. Showing interactive iframe.`);

                unblockOverlay = showUnblockOverlay(iframe, productUrl, () => {
                    finalize(reject, new Error(`Manual unblock canceled for "${productUrl}"`));
                });

                const startedAt = Date.now();
                pollInterval = setInterval(() => {
                    const state = readFrameState();
                    if (state.data && hasCacheableProductData(state.data)) {
                        return finalize(resolve, state.data);
                    }

                    if (Date.now() - startedAt >= getIframeManualTimeoutMs()) {
                        return finalize(reject, new Error(`Manual unblock timeout for "${productUrl}"`));
                    }
                }, IFRAME_MANUAL_POLL_INTERVAL_MS);
            };

            const onLoad = () => {
                clearTimeout(loadTimeout);
                const startedAt = Date.now();
                let lastData = { averagePriceText: 'N/A', trendPriceText: 'N/A', chartWrapperHTML: '' };

                const initialState = readFrameState();
                if (initialState.data) lastData = initialState.data;

                if (hasCacheableProductData(lastData)) return finalize(resolve, lastData);
                if (initialState.blocked) return startManualUnblockMode();

                pollInterval = setInterval(() => {
                    const state = readFrameState();
                    if (state.data) lastData = state.data;

                    if (hasCacheableProductData(lastData)) {
                        return finalize(resolve, lastData);
                    }

                    if (state.blocked) {
                        clearInterval(pollInterval);
                        return startManualUnblockMode();
                    }

                    if (Date.now() - startedAt >= settings.iframeReadyTimeoutMs) {
                        GM_log(`[cache] Iframe data timeout for ${productUrl}.`);
                        clearInterval(pollInterval);

                        const finalState = readFrameState();
                        if (finalState.blocked) {
                            return startManualUnblockMode();
                        }

                        if (hasCacheableProductData(lastData)) {
                            return finalize(resolve, lastData);
                        }

                        return finalize(
                            reject,
                            createRetryableError(`Iframe data unavailable for "${productUrl}"`, 'IFRAME_DATA_UNAVAILABLE')
                        );
                    }
                }, IFRAME_READY_INTERVAL_MS);
            };

            const onError = () => finalize(reject, new Error(`Iframe navigation failed for "${productUrl}"`));

            loadTimeout = setTimeout(() => {
                finalize(reject, new Error(`Iframe load timeout for "${productUrl}"`));
            }, settings.iframeLoadTimeoutMs);

            iframe.addEventListener('load', onLoad);
            iframe.addEventListener('error', onError);
            iframe.src = productUrl;
            (document.body || document.documentElement).appendChild(iframe);
        }));
    }

    function showUnblockOverlay(iframe, productUrl, onCancel) {
        const overlay = document.createElement('div');
        overlay.style.cssText = [
            'position:fixed',
            'z-index:2147483647',
            'inset:0',
            'background:rgba(0,0,0,0.55)',
            'display:flex',
            'flex-direction:column',
            'gap:8px',
            'padding:12px'
        ].join(';');

        const panel = document.createElement('div');
        panel.style.cssText = [
            'display:flex',
            'align-items:center',
            'justify-content:space-between',
            'gap:8px',
            'padding:8px 10px',
            'background:#fff',
            'border:1px solid #ccc',
            'font:13px/1.4 sans-serif'
        ].join(';');

        const message = document.createElement('div');
        message.textContent = `Cardmarket blocked background loading for ${productUrl}. Complete the verification below to continue.`;

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'btn btn-sm btn-secondary';
        cancelBtn.style.cssText = 'margin-left:auto;white-space:nowrap';
        cancelBtn.addEventListener('click', onCancel);

        panel.append(message, cancelBtn);

        iframe.style.cssText = [
            'position:relative',
            'display:block',
            'width:100%',
            'height:100%',
            'min-height:320px',
            'border:1px solid #bbb',
            'background:#fff',
            'visibility:visible',
            'pointer-events:auto'
        ].join(';');

        overlay.append(panel, iframe);
        (document.body || document.documentElement).appendChild(overlay);
        return overlay;
    }

    function isLikelyBlockedDocument(doc) {
        const title = (doc.title || '').toLowerCase();
        const bodyText = (doc.body?.innerText || '').toLowerCase();
        const markers = [
            'just a moment',
            'verify you are human',
            'checking your browser',
            'captcha',
            'security check',
            'access denied',
            'attention required',
            'cloudflare',
            'ray id',
            'please wait while we verify',
            'enable javascript and cookies'
        ];

        if (markers.some(marker => title.includes(marker) || bodyText.includes(marker))) {
            return true;
        }

        return Boolean(
            doc.querySelector('#challenge-form') ||
            doc.querySelector('#challenge-running') ||
            doc.querySelector('[name="cf_captcha_kind"]') ||
            doc.querySelector('iframe[src*="challenge"]') ||
            doc.querySelector('script[src*="challenge-platform"]') ||
            doc.querySelector('[data-translate="why_captcha_detail"]') ||
            doc.querySelector('#cf-wrapper')
        );
    }

    function extractPageData(doc) {
        let averagePriceText = 'N/A', trendPriceText = 'N/A';
        
        doc.querySelectorAll('dt.col-6.col-xl-5').forEach(dt => {
            const label = dt.textContent.trim();
            if (label === '30-days average price') {
                averagePriceText = dt.nextElementSibling?.querySelector('span')?.textContent.trim() || 'N/A';
            } else if (label === 'Price Trend') {
                trendPriceText = dt.nextElementSibling?.querySelector('span')?.textContent.trim() || 'N/A';
            }
        });

        const chartWrapper = doc.querySelector('#tabContent-info .chart-wrapper');
        let chartWrapperHTML = '';
        
        if (chartWrapper) {
            // Store the original HTML - unique IDs will be generated at display time
            chartWrapperHTML = chartWrapper.outerHTML;
        }

        return { averagePriceText, trendPriceText, chartWrapperHTML };
    }

    async function getCachedData(productUrl, context, fetchCallback) {
        const now = Date.now();
        const expirationMs = getCacheExpirationMs();
        const productContext = resolveProductContext(context, productUrl);

        if (productContext.idProduct) {
            try {
                const record = await getProductRecord(productContext.idProduct);
                const variant = getVariantRecord(record, productContext.isFoil);
                if (
                    variant?.timestamp &&
                    hasCacheableProductData(variant.pageData) &&
                    now - variant.timestamp < expirationMs
                ) {
                    return variant.pageData;
                }
            } catch (error) {
                GM_log(`[cache] Failed to read unified product cache ${productContext.idProduct}: ${error.message}`);
            }
        }

        const freshData = await fetchCallback();
        if (!hasCacheableProductData(freshData)) {
            throw createRetryableError(`Non-cacheable product data for "${productUrl}"`, 'NON_CACHEABLE_PRODUCT_DATA');
        }

        const timestamp = Date.now();
        if (productContext.idProduct) {
            try {
                await setUnifiedProductPageData(productContext.idProduct, productContext.isFoil, freshData, timestamp);
            } catch (error) {
                GM_log(`[cache] Failed to persist unified cache for ${productContext.idProduct}: ${error.message}`);
            }
        }

        return freshData;
    }

    function setLocalCache(productUrl, data, context = {}) {
        const productContext = resolveProductContext(context, productUrl);
        const timestamp = Date.now();

        if (productContext.idProduct) {
            void setUnifiedProductPageData(productContext.idProduct, productContext.isFoil, data, timestamp)
                .catch(error => GM_log(`[cache] Failed to set unified local cache ${productContext.idProduct}: ${error.message}`));
        }
    }

    async function checkLocalCache(productUrl, context = {}) {
        const productContext = resolveProductContext(context, productUrl);
        if (!productContext.idProduct) return null;

        try {
            const record = await getProductRecord(productContext.idProduct);
            const variant = getVariantRecord(record, productContext.isFoil);
            if (!variant?.pageData) return null;
            if (Date.now() - variant.timestamp < getCacheExpirationMs()) return variant.pageData;
        } catch (error) {
            GM_log(`[cache] Failed to read unified local cache ${productContext.idProduct}: ${error.message}`);
        }

        return null;
    }

    async function cleanupExpiredCache() {
        const now = Date.now();
        let removedUnifiedVariants = 0;

        try {
            await iterateProductRecords(async (record, cursor) => {
                if (!record || typeof record !== 'object') {
                    cursor.delete();
                    return;
                }

                const variants = record.variants && typeof record.variants === 'object' ? record.variants : {};
                let recordChanged = false;

                ['N', 'Y'].forEach(variantKey => {
                    const variant = variants[variantKey];
                    if (!variant) return;
                    const isExpired = !variant.timestamp || now - variant.timestamp >= getCacheExpirationMs();
                    const isInvalid = !hasCacheableProductData(variant.pageData);
                    if (isExpired || isInvalid) {
                        delete variants[variantKey];
                        removedUnifiedVariants += 1;
                        recordChanged = true;
                    }
                });

                const hasPriceGuide = Boolean(record.priceGuide && record.priceGuide.cacheVersion === PRICE_GUIDE_CACHE_VERSION);
                const hasVariants = Boolean(variants.N || variants.Y);
                if (!hasPriceGuide && !hasVariants) {
                    cursor.delete();
                    return;
                }

                if (recordChanged) {
                    record.variants = variants;
                    record.updatedAt = now;
                    cursor.update(record);
                }
            });
        } catch (error) {
            GM_log(`[cache-cleanup] Failed during unified cleanup: ${error.message}`);
        }

        if (removedUnifiedVariants > 0) {
            GM_log(`[cache-cleanup] Removed ${removedUnifiedVariants} unified variants.`);
        }
    }

    async function clearAllCachedData() {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([PRODUCT_CACHE_STORE, META_CACHE_STORE], 'readwrite');
            tx.objectStore(PRODUCT_CACHE_STORE).clear();
            tx.objectStore(META_CACHE_STORE).clear();

            tx.oncomplete = () => {
                priceGuideLookup = null;
                priceGuideWarmupPromise = null;
                setPriceGuideStatus('Data: idle', 'neutral');

                getCurrentRows().forEach(row => {
                    delete row.dataset.cmPriceGuideApplied;
                    delete row.dataset.cmProductId;
                    delete row.dataset.cmRatioAvg;
                    delete row.dataset.cmRatioTrend;
                    delete row.dataset.cmBestRatio;
                });

                resolve();
            };
            tx.onerror = () => reject(tx.error || new Error('Failed to clear cached data.'));
        });
    }

    function getVariantKey(isFoil) {
        return isFoil ? 'Y' : 'N';
    }

    function resolveProductContext(context = {}, productUrl = '') {
        const row = context.row || null;
        const link = context.link || row?.querySelector('a[href*="/en/Magic/Products/"]') || null;
        const idProduct = parsePositiveInteger(context.idProduct) || extractProductIdFromRow(row, link);

        let isFoil = Boolean(context.isFoil);
        if (context.isFoil === undefined) {
            if (row) {
                isFoil = getFoilBool(row);
            } else {
                const sourceUrl = productUrl || link?.href || '';
                try {
                    const parsedUrl = new URL(sourceUrl);
                    isFoil = parsedUrl.searchParams.get('isFoil') === 'Y';
                } catch (error) {
                    isFoil = /(?:[?&])isFoil=Y(?:[&#]|$)/i.test(sourceUrl);
                }
            }
        }

        return {
            idProduct: parsePositiveInteger(idProduct),
            isFoil
        };
    }

    function getVariantRecord(record, isFoil) {
        const variantKey = getVariantKey(isFoil);
        return record?.variants?.[variantKey] || null;
    }

    async function setUnifiedProductPageData(idProduct, isFoil, pageData, timestamp = Date.now()) {
        const parsedId = parsePositiveInteger(idProduct);
        if (!parsedId || !hasCacheableProductData(pageData)) return;

        const existing = await getProductRecord(parsedId);
        const variants = existing?.variants && typeof existing.variants === 'object' ? { ...existing.variants } : {};
        variants[getVariantKey(isFoil)] = {
            timestamp,
            hasGraph: Boolean(pageData?.chartWrapperHTML),
            pageData
        };

        await setProductRecord({
            idProduct: parsedId,
            updatedAt: Date.now(),
            priceGuide: existing?.priceGuide || null,
            variants
        });
    }

    async function loadPriceGuideLookupForRows(rows = getCurrentRows()) {
        const lookup = {};
        const uniqueIds = new Set();

        rows.forEach(row => {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            if (!link) return;
            const idProduct = extractProductIdFromRow(row, link);
            if (idProduct) uniqueIds.add(idProduct);
        });

        const recordsById = await getProductRecordsByIds(Array.from(uniqueIds));

        Array.from(uniqueIds).forEach(idProduct => {
            const record = recordsById[idProduct] || null;
            const priceGuide = record?.priceGuide;
            if (!priceGuide || priceGuide.cacheVersion !== PRICE_GUIDE_CACHE_VERSION || !priceGuide.values) return;
            lookup[idProduct] = priceGuide.values;
        });

        return lookup;
    }

    async function persistPriceGuideToUnifiedStore(priceGuides, fetchedAt) {
        await upsertPriceGuideEntries(priceGuides, fetchedAt, PRICE_GUIDE_CACHE_VERSION);
        await setMetaEntry(PRICE_GUIDE_META_KEY, {
            cacheVersion: PRICE_GUIDE_CACHE_VERSION,
            fetchedAt,
            count: Array.isArray(priceGuides) ? priceGuides.length : 0
        });
    }

    async function warmupPriceGuideData() {
        if (priceGuideWarmupPromise) return priceGuideWarmupPromise;

        const warmupPromise = (async () => {
            const warmupStartedAt = Date.now();
            const now = Date.now();
            let meta = null;
            try {
                const metaStartedAt = Date.now();
                meta = await getMetaEntry(PRICE_GUIDE_META_KEY);
                logPerf(`price-guide meta read in ${Date.now() - metaStartedAt}ms; hasMeta=${Boolean(meta)}`);
            } catch (error) {
                GM_log(`[price-guide] Failed to read unified meta: ${error.message}`);
                logPerf(`price-guide meta read failed in ${Date.now() - warmupStartedAt}ms: ${error.message}`);
            }

            const hasCachedMeta = Boolean(meta?.cacheVersion === PRICE_GUIDE_CACHE_VERSION && Number.isFinite(meta?.fetchedAt));
            const isCachedFresh = hasCachedMeta && now - meta.fetchedAt < getCacheExpirationMs();

            if (hasCachedMeta) {
                try {
                    const cachedLookupStartedAt = Date.now();
                    const rows = getCurrentRows();
                    const cachedLookup = await loadPriceGuideLookupForRows(rows);
                    logPerf(`price-guide row-scoped lookup loaded in ${Date.now() - cachedLookupStartedAt}ms; rows=${rows.length} matchedItems=${Object.keys(cachedLookup).length}`);
                    if (Object.keys(cachedLookup).length > 0) {
                        priceGuideLookup = cachedLookup;
                        applyPriceGuideToRows(rows);
                        if (isCachedFresh) {
                            setPriceGuideStatus(`Data: ready (${formatCacheAge(meta.fetchedAt)})`, 'ready');
                            logPerf(`price-guide warmup satisfied from unified cache in ${Date.now() - warmupStartedAt}ms`);
                            return priceGuideLookup;
                        }
                    }
                } catch (error) {
                    GM_log(`[price-guide] Failed loading unified lookup: ${error.message}`);
                    logPerf(`price-guide unified lookup failed in ${Date.now() - warmupStartedAt}ms: ${error.message}`);
                }
            }

            try {
                setPriceGuideStatus('Data: downloading...', 'loading');
                const downloadStartedAt = Date.now();
                const payload = await fetchJsonWithFallback(PRICE_GUIDE_URL);
                logPerf(`price-guide download complete in ${Date.now() - downloadStartedAt}ms`);
                if (!Array.isArray(payload?.priceGuides)) {
                    throw new Error('Price guide payload missing "priceGuides" array.');
                }

                setPriceGuideStatus('Data: parsing...', 'loading');
                const parseStartedAt = Date.now();
                const lookup = buildPriceGuideLookup(payload.priceGuides);
                logPerf(`price-guide parse complete in ${Date.now() - parseStartedAt}ms; entries=${payload.priceGuides.length}`);
                const fetchedAt = Date.now();
                try {
                    const persistStartedAt = Date.now();
                    await persistPriceGuideToUnifiedStore(payload.priceGuides, fetchedAt);
                    logPerf(`price-guide persist complete in ${Date.now() - persistStartedAt}ms`);
                } catch (error) {
                    GM_log(`[price-guide] Failed to persist unified data: ${error.message}`);
                    logPerf(`price-guide persist failed in ${Date.now() - warmupStartedAt}ms: ${error.message}`);
                }

                priceGuideLookup = lookup;
                applyPriceGuideToRows();
                setPriceGuideStatus(`Data: ready (${Object.keys(lookup).length} items)`, 'ready');
                logPerf(`price-guide warmup complete in ${Date.now() - warmupStartedAt}ms`);
                return lookup;
            } catch (error) {
                if (priceGuideLookup) {
                    setPriceGuideStatus(`Data: stale (${error.message})`, 'warning');
                    logPerf(`price-guide warmup stale fallback after ${Date.now() - warmupStartedAt}ms: ${error.message}`);
                    return priceGuideLookup;
                }

                setPriceGuideStatus(`Data: error (${error.message})`, 'error');
                logPerf(`price-guide warmup failed after ${Date.now() - warmupStartedAt}ms: ${error.message}`);
                throw error;
            }
        })();

        priceGuideWarmupPromise = warmupPromise.catch(error => {
            priceGuideWarmupPromise = null;
            throw error;
        });

        return priceGuideWarmupPromise;
    }

    function buildPriceGuideLookup(priceGuides) {
        const lookup = {};

        priceGuides.forEach(entry => {
            const idProduct = parsePositiveInteger(entry?.idProduct);
            if (!idProduct) return;

            lookup[idProduct] = {
                avg: toNullableNumber(entry.avg),
                avg30: toNullableNumber(entry.avg30),
                trend: toNullableNumber(entry.trend),
                avgFoil: toNullableNumber(entry['avg-foil']),
                avg30Foil: toNullableNumber(entry['avg30-foil']),
                trendFoil: toNullableNumber(entry['trend-foil'])
            };
        });

        return lookup;
    }

    function applyPriceGuideToRows(rows = getCurrentRows()) {
        if (!priceGuideLookup || !rows.length) return 0;

        let updatedRows = 0;
        rows.forEach(row => {
            if (row.dataset.cmGraphLoaded === '1') return;
            if (applyPriceGuideToRow(row)) updatedRows += 1;
        });
        return updatedRows;
    }

    function applyPriceGuideToRow(row) {
        const link = row.querySelector('a[href*="/en/Magic/Products/"]');
        if (!link) return false;

        const idProduct = extractProductIdFromRow(row, link);
        if (!idProduct) return false;

        const entry = priceGuideLookup?.[idProduct];
        if (!entry) return false;

        const isFoil = getFoilBool(row);
        const averageValue = pickFirstNumber(isFoil ? [entry.avg30Foil, entry.avgFoil, entry.avg30, entry.avg] : [entry.avg30, entry.avg]);
        const trendValue = pickFirstNumber(isFoil ? [entry.trendFoil, entry.trend] : [entry.trend]);

        if (!Number.isFinite(averageValue) && !Number.isFinite(trendValue)) return false;

        processProductPage({
            averagePriceText: formatPriceText(averageValue),
            trendPriceText: formatPriceText(trendValue),
            chartWrapperHTML: ''
        }, row);
        row.dataset.cmPriceGuideApplied = '1';
        row.dataset.cmProductId = String(idProduct);
        return true;
    }

    function extractProductIdFromRow(row, link) {
        const setAndReturn = (value) => {
            const parsed = parsePositiveInteger(value);
            if (!parsed) return null;
            if (row?.dataset) row.dataset.cmProductId = String(parsed);
            return parsed;
        };

        const cachedId = setAndReturn(row?.dataset?.cmProductId);
        if (cachedId) return cachedId;

        const directCandidates = [
            row?.dataset?.idProduct,
            row?.dataset?.productId,
            row?.getAttribute('data-id-product'),
            row?.getAttribute('data-product-id'),
            link?.dataset?.idProduct,
            link?.dataset?.productId,
            row?.querySelector('input[name="idProduct"]')?.value,
            row?.querySelector('input[name="productId"]')?.value,
            /(?:[?&])idProduct=(\d+)/i.exec(link?.href || link?.getAttribute('href') || '')?.[1],
            /(?:[?&])productId=(\d+)/i.exec(link?.href || link?.getAttribute('href') || '')?.[1]
        ];

        for (const candidate of directCandidates) {
            const parsed = setAndReturn(candidate);
            if (parsed) return parsed;
        }

        const extractFromText = (text) => {
            if (!text) return null;
            const patterns = [
                /(?:^|[?&])idProduct=(\d+)/i,
                /(?:^|[?&])productId=(\d+)/i,
                /(?:idProduct|productId|data-id-product|data-product-id)[^0-9]{0,16}(\d{1,12})/i,
                /product-images\.s3\.cardmarket\.com\/\d+\/[^/]+\/(\d{1,12})\/\1(?:[./?]|$)/i,
                /\/(\d{5,12})\/\1\.(?:jpg|jpeg|png|webp)(?:[?#]|$)/i
            ];

            for (const pattern of patterns) {
                const match = pattern.exec(String(text));
                const parsed = setAndReturn(match?.[1]);
                if (parsed) return parsed;
            }

            return null;
        };

        const thumbnailTooltip = row?.querySelector('.thumbnail-icon')?.getAttribute('data-bs-title');
        const tooltipId = extractFromText(thumbnailTooltip);
        if (tooltipId) return tooltipId;

        const hrefId = extractFromText(link?.href || link?.getAttribute('href') || '');
        if (hrefId) return hrefId;

        // Last-resort fallback for unusual page variants only.
        const fallbackNodes = [
            row,
            link,
            row?.querySelector('form'),
            row?.closest('form'),
            row?.querySelector('[name*="product" i]'),
            row?.querySelector('[id*="product" i]')
        ].filter(Boolean);

        for (const node of fallbackNodes) {
            for (const attr of Array.from(node.attributes || [])) {
                if (!/product/i.test(attr.name)) continue;
                const parsed = extractFromText(attr.value);
                if (parsed) return parsed;
            }
        }

        const rowHtml = row?.innerHTML || '';
        const htmlParsed = extractFromText(rowHtml);
        if (htmlParsed) return htmlParsed;

        return null;
    }

    function pickFirstNumber(values) {
        for (const value of values) {
            if (Number.isFinite(value)) return value;
        }
        return NaN;
    }

    function toNullableNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function parsePositiveInteger(value) {
        if (typeof value === 'number') {
            return Number.isInteger(value) && value > 0 ? value : null;
        }

        const rawText = String(value ?? '').trim();
        if (!rawText) return null;

        const digitsOnly = /^\d+$/.test(rawText)
            ? rawText
            : /(?:^|\D)(\d{1,12})(?:\D|$)/.exec(rawText)?.[1];
        if (!digitsOnly) return null;

        const parsed = Number(digitsOnly);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function formatPriceText(value) {
        return Number.isFinite(value) ? `${value.toFixed(2)} €` : 'N/A';
    }

    function setPriceGuideStatus(text, tone = 'neutral') {
        const palette = {
            neutral: { background: '#f7f7f7', border: '#bbb', color: '#555' },
            loading: { background: '#fff8e1', border: '#f1c26b', color: '#7a5400' },
            ready: { background: '#edf7ed', border: '#7cc47f', color: '#1d6f22' },
            warning: { background: '#fff4e5', border: '#d99d5c', color: '#8a4b08' },
            error: { background: '#fdecea', border: '#d67a76', color: '#9a1c1c' }
        };

        const style = palette[tone] || palette.neutral;
        priceGuideStatusBadges.forEach(badge => {
            badge.textContent = text;
            badge.style.background = style.background;
            badge.style.borderColor = style.border;
            badge.style.color = style.color;
        });
    }

    function formatCacheAge(timestamp) {
        if (!timestamp) return 'unknown';
        const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.round(minutes / 60);
        return `${hours}h ago`;
    }

    async function fetchJsonWithFallback(url) {
        const startedAt = Date.now();
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} while fetching ${url}`);
            }
            const payload = await response.json();
            logPerf(`fetchJson native fetch succeeded in ${Date.now() - startedAt}ms`);
            return payload;
        } catch (fetchError) {
            logPerf(`fetchJson native fetch failed in ${Date.now() - startedAt}ms, trying GM fallback: ${fetchError.message}`);
            return fetchJsonViaGmRequest(url, fetchError);
        }
    }

    function fetchJsonViaGmRequest(url, fallbackError) {
        if (typeof GM_xmlhttpRequest !== 'function') {
            return Promise.reject(fallbackError);
        }

        const startedAt = Date.now();
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { 'Cache-Control': 'no-cache' },
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} while fetching ${url}`));
                        return;
                    }

                    try {
                        const parsed = JSON.parse(response.responseText);
                        logPerf(`fetchJson GM fallback succeeded in ${Date.now() - startedAt}ms`);
                        resolve(parsed);
                    } catch (error) {
                        reject(new Error(`Failed to parse JSON from ${url}: ${error.message}`));
                    }
                },
                onerror: () => reject(fallbackError || new Error(`Request failed for ${url}`)),
                ontimeout: () => reject(new Error(`Request timed out for ${url}`))
            });
        });
    }

    function openCacheDb() {
        if (cacheDbPromise) return cacheDbPromise;

        cacheDbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB is not available.'));
                return;
            }

            const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (db.objectStoreNames.contains('entries')) {
                    db.deleteObjectStore('entries');
                }
                if (!db.objectStoreNames.contains(PRODUCT_CACHE_STORE)) {
                    const productStore = db.createObjectStore(PRODUCT_CACHE_STORE, { keyPath: 'idProduct' });
                    productStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                    productStore.createIndex('priceGuideFetchedAt', 'priceGuide.fetchedAt', { unique: false });
                    productStore.createIndex('hasGraphNonFoil', 'variants.N.hasGraph', { unique: false });
                    productStore.createIndex('hasGraphFoil', 'variants.Y.hasGraph', { unique: false });
                }
                if (!db.objectStoreNames.contains(META_CACHE_STORE)) {
                    db.createObjectStore(META_CACHE_STORE, { keyPath: 'key' });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Failed to open cache DB.'));
        });

        return cacheDbPromise;
    }

    async function getProductRecord(idProduct) {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PRODUCT_CACHE_STORE, 'readonly');
            const request = tx.objectStore(PRODUCT_CACHE_STORE).get(idProduct);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error(`Failed to read product cache: ${idProduct}`));
        });
    }

    async function getProductRecordsByIds(idProducts) {
        const ids = Array.from(new Set((idProducts || []).map(parsePositiveInteger).filter(Boolean)));
        if (!ids.length) return {};

        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PRODUCT_CACHE_STORE, 'readonly');
            const store = tx.objectStore(PRODUCT_CACHE_STORE);
            const result = {};
            let pending = ids.length;

            ids.forEach(idProduct => {
                const request = store.get(idProduct);
                request.onsuccess = () => {
                    result[idProduct] = request.result || null;
                    pending -= 1;
                    if (pending === 0) resolve(result);
                };
                request.onerror = () => reject(request.error || new Error(`Failed bulk-read for product cache: ${idProduct}`));
            });

            tx.onerror = () => reject(tx.error || new Error('Failed bulk product read transaction.'));
        });
    }

    async function setProductRecord(record) {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PRODUCT_CACHE_STORE, 'readwrite');
            const request = tx.objectStore(PRODUCT_CACHE_STORE).put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error(`Failed to write product cache: ${record?.idProduct}`));
        });
    }

    async function iterateProductRecords(onEntry) {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PRODUCT_CACHE_STORE, 'readwrite');
            const store = tx.objectStore(PRODUCT_CACHE_STORE);
            const request = store.openCursor();

            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                Promise.resolve(onEntry(cursor.value, cursor))
                    .then(() => {
                        cursor.continue();
                    })
                    .catch(reject);
            };

            request.onerror = () => reject(request.error || new Error('Failed to iterate product cache records.'));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed product iteration transaction.'));
        });
    }

    async function getMetaEntry(key) {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(META_CACHE_STORE, 'readonly');
            const request = tx.objectStore(META_CACHE_STORE).get(key);
            request.onsuccess = () => resolve(request.result?.value || null);
            request.onerror = () => reject(request.error || new Error(`Failed to read meta cache key: ${key}`));
        });
    }

    async function setMetaEntry(key, value) {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(META_CACHE_STORE, 'readwrite');
            const request = tx.objectStore(META_CACHE_STORE).put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error(`Failed to write meta cache key: ${key}`));
        });
    }

    async function upsertPriceGuideEntries(priceGuides, fetchedAt, cacheVersion) {
        const db = await openCacheDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PRODUCT_CACHE_STORE, 'readwrite');
            const store = tx.objectStore(PRODUCT_CACHE_STORE);

            priceGuides.forEach(rawEntry => {
                const idProduct = parsePositiveInteger(rawEntry?.idProduct);
                if (!idProduct) return;

                const values = {
                    avg: toNullableNumber(rawEntry.avg),
                    avg30: toNullableNumber(rawEntry.avg30),
                    trend: toNullableNumber(rawEntry.trend),
                    avgFoil: toNullableNumber(rawEntry['avg-foil']),
                    avg30Foil: toNullableNumber(rawEntry['avg30-foil']),
                    trendFoil: toNullableNumber(rawEntry['trend-foil'])
                };

                const getRequest = store.get(idProduct);
                getRequest.onsuccess = () => {
                    const existing = getRequest.result || null;
                    const nextRecord = {
                        idProduct,
                        updatedAt: Date.now(),
                        variants: existing?.variants && typeof existing.variants === 'object' ? existing.variants : {},
                        priceGuide: {
                            cacheVersion,
                            fetchedAt,
                            values
                        }
                    };
                    store.put(nextRecord);
                };
                getRequest.onerror = () => reject(getRequest.error || new Error(`Failed to read product cache during upsert: ${idProduct}`));
            });

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed unified price-guide upsert transaction.'));
        });
    }

    // ===== SETTINGS =====

    function loadUserSettings() {
        const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!stored) return { ...DEFAULT_SETTINGS };

        try {
            const parsed = JSON.parse(stored);
            const source = parsed?.version === SETTINGS_VERSION && parsed?.data ? parsed.data : parsed;
            return sanitizeSettings(source);
        } catch (error) {
            GM_log(`[settings] Failed to parse saved settings. Falling back to defaults. ${error.message}`);
            return { ...DEFAULT_SETTINGS };
        }
    }

    function sanitizeSettings(candidate) {
        const source = candidate && typeof candidate === 'object' ? candidate : {};
        return {
            cacheExpirationHours: sanitizeInteger(source.cacheExpirationHours, DEFAULT_SETTINGS.cacheExpirationHours, 1, 720),
            graphRatioThreshold: sanitizeFloat(source.graphRatioThreshold, DEFAULT_SETTINGS.graphRatioThreshold, 0.5, 5, 2),
            requestDelayMs: sanitizeInteger(source.requestDelayMs, DEFAULT_SETTINGS.requestDelayMs, 100, 10000),
            maxInFlightRequests: sanitizeInteger(source.maxInFlightRequests, DEFAULT_SETTINGS.maxInFlightRequests, 0, 100),
            delayRandomizationPercent: sanitizeInteger(source.delayRandomizationPercent, DEFAULT_SETTINGS.delayRandomizationPercent, 0, 100),
            queueMode: sanitizeQueueMode(source.queueMode),
            delayIncrementOn429Ms: sanitizeInteger(source.delayIncrementOn429Ms, DEFAULT_SETTINGS.delayIncrementOn429Ms, 0, 10000),
            iframeLoadTimeoutMs: sanitizeInteger(source.iframeLoadTimeoutMs, DEFAULT_SETTINGS.iframeLoadTimeoutMs, 1000, 120000),
            iframeReadyTimeoutMs: sanitizeInteger(source.iframeReadyTimeoutMs, DEFAULT_SETTINGS.iframeReadyTimeoutMs, 500, 60000),
            iframeManualTimeoutMinutes: sanitizeInteger(source.iframeManualTimeoutMinutes, DEFAULT_SETTINGS.iframeManualTimeoutMinutes, 1, 60)
        };
    }

    function sanitizeInteger(value, fallback, min, max) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, Math.round(parsed)));
    }

    function sanitizeFloat(value, fallback, min, max, precision = 2) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        const bounded = Math.min(max, Math.max(min, parsed));
        const multiplier = Math.pow(10, precision);
        return Math.round(bounded * multiplier) / multiplier;
    }

    function sanitizeQueueMode(value) {
        return value === 'fixed_delay' ? 'fixed_delay' : 'wait_for_load';
    }

    function getRandomizedDelayMs(baseDelayMs) {
        const safeBaseDelayMs = Math.max(0, Math.round(Number(baseDelayMs) || 0));
        const randomizationPercent = settings.delayRandomizationPercent || 0;
        if (randomizationPercent <= 0) return safeBaseDelayMs;

        const spread = safeBaseDelayMs * (randomizationPercent / 100);
        const minDelay = Math.max(0, safeBaseDelayMs - spread);
        const maxDelay = safeBaseDelayMs + spread;
        return Math.round(minDelay + Math.random() * (maxDelay - minDelay));
    }

    function saveUserSettings(nextSettings) {
        settings = sanitizeSettings(nextSettings);
        requestDelay = settings.requestDelayMs;
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
            version: SETTINGS_VERSION,
            timestamp: Date.now(),
            data: settings
        }));
        refreshThresholdButtonLabels();
        void cleanupExpiredCache();
    }

    function getCacheExpirationMs() {
        return settings.cacheExpirationHours * 60 * 60 * 1000;
    }

    function getIframeManualTimeoutMs() {
        return settings.iframeManualTimeoutMinutes * 60 * 1000;
    }

    function ensureSettingsModal() {
        if (settingsModal) return;

        const overlay = document.createElement('div');
        overlay.id = 'cm-settings-modal';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'display:none',
            'align-items:center',
            'justify-content:center',
            'padding:16px',
            'background:rgba(0, 0, 0, 0.55)',
            'z-index:2147483647'
        ].join(';');

        const panel = document.createElement('div');
        panel.style.cssText = [
            'width:min(560px, 100%)',
            'max-height:calc(100vh - 32px)',
            'overflow:auto',
            'padding:16px',
            'border-radius:8px',
            'background:#fff',
            'border:1px solid #ccc',
            'font:14px/1.4 sans-serif',
            'box-shadow:0 12px 30px rgba(0,0,0,0.25)'
        ].join(';');

        const title = document.createElement('h3');
        title.textContent = 'Cardmarket Script Settings';
        title.style.cssText = 'margin:0 0 6px 0;font-size:18px';

        const subtitle = document.createElement('p');
        subtitle.textContent = 'These values are saved in browser storage and reused on future page loads.';
        subtitle.style.cssText = 'margin:0 0 14px 0;color:#555';

        const form = document.createElement('form');
        form.noValidate = true;

        const fieldsWrapper = document.createElement('div');
        fieldsWrapper.style.cssText = 'display:grid;gap:10px';

        SETTINGS_FIELDS.forEach(field => {
            const row = document.createElement('label');
            row.style.cssText = 'display:grid;gap:4px';

            const labelText = document.createElement('span');
            labelText.textContent = field.label;
            labelText.style.cssText = 'font-size:13px;font-weight:600;color:#333';

            let control;
            if (field.type === 'select') {
                const select = document.createElement('select');
                select.name = field.key;
                select.required = true;
                select.style.cssText = 'padding:6px 8px;border:1px solid #bbb;border-radius:4px;background:#fff';

                field.options.forEach(option => {
                    const optionElement = document.createElement('option');
                    optionElement.value = option.value;
                    optionElement.textContent = option.label;
                    select.appendChild(optionElement);
                });

                control = select;
            } else {
                const input = document.createElement('input');
                input.type = 'number';
                input.name = field.key;
                input.min = String(field.min);
                input.max = String(field.max);
                input.step = String(field.step);
                input.required = true;
                input.style.cssText = 'padding:6px 8px;border:1px solid #bbb;border-radius:4px';
                control = input;
            }

            row.append(labelText, control);
            fieldsWrapper.appendChild(row);
        });

        const errorText = document.createElement('div');
        errorText.className = 'cm-settings-error';
        errorText.style.cssText = 'min-height:18px;margin-top:10px;color:#b00020;font-size:12px';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';

        const clearDataBtn = createButton('Clear Data', 'btn btn-sm btn-outline-danger');
        clearDataBtn.type = 'button';
        clearDataBtn.addEventListener('click', async () => {
            const confirmed = window.confirm('Clear cached price-guide and graph data?');
            if (!confirmed) return;

            const originalText = clearDataBtn.textContent;
            clearDataBtn.disabled = true;
            clearDataBtn.textContent = 'Clearing...';

            try {
                await clearAllCachedData();
                errorText.style.color = '#1d6f22';
                errorText.textContent = 'Cached data cleared.';
                GM_log('[cache] Cleared all cached data via settings.');
            } catch (error) {
                errorText.style.color = '#b00020';
                errorText.textContent = `Failed to clear data: ${error.message}`;
                logError('Failed to clear cached data:', error);
            } finally {
                clearDataBtn.disabled = false;
                clearDataBtn.textContent = originalText;
            }
        });

        const resetBtn = createButton('Defaults', 'btn btn-sm btn-outline-secondary');
        resetBtn.type = 'button';
        resetBtn.addEventListener('click', () => {
            populateSettingsForm(DEFAULT_SETTINGS);
        });

        const cancelBtn = createButton('Cancel', 'btn btn-sm btn-secondary');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', () => settingsModalClose?.());

        const saveBtn = createButton('Save', 'btn btn-sm btn-primary');
        saveBtn.type = 'submit';

        actions.append(clearDataBtn, resetBtn, cancelBtn, saveBtn);
        form.append(fieldsWrapper, errorText, actions);

        form.addEventListener('submit', event => {
            event.preventDefault();
            const parsed = parseSettingsForm();
            if (parsed.error) {
                errorText.textContent = parsed.error;
                return;
            }

            saveUserSettings(parsed.values);
            errorText.style.color = '#b00020';
            errorText.textContent = '';
            settingsModalClose?.();
        });

        overlay.addEventListener('click', event => {
            if (event.target === overlay) {
                settingsModalClose?.();
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && settingsModal?.style.display !== 'none') {
                settingsModalClose?.();
            }
        });

        panel.append(title, subtitle, form);
        overlay.appendChild(panel);
        (document.body || document.documentElement).appendChild(overlay);

        settingsModal = overlay;
        settingsModalClose = () => {
            settingsModal.style.display = 'none';
            document.body.style.overflow = '';
        };
    }

    function openSettingsModal() {
        ensureSettingsModal();
        populateSettingsForm(settings);
        settingsModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    function populateSettingsForm(values) {
        SETTINGS_FIELDS.forEach(field => {
            const control = settingsModal?.querySelector(`[name="${field.key}"]`);
            if (control) control.value = String(values[field.key]);
        });

        const errorText = settingsModal?.querySelector('.cm-settings-error');
        if (errorText) errorText.textContent = '';
    }

    function parseSettingsForm() {
        const values = {};

        for (const field of SETTINGS_FIELDS) {
            const control = settingsModal?.querySelector(`[name="${field.key}"]`);
            if (!control) {
                return { error: 'Settings form is unavailable.' };
            }

            if (field.type === 'select') {
                const value = String(control.value || '');
                const allowedValues = field.options.map(option => option.value);
                if (!allowedValues.includes(value)) {
                    return { error: `${field.label} has an invalid value.` };
                }
                values[field.key] = value;
                continue;
            }

            const value = Number(control.value);
            if (!Number.isFinite(value) || value < field.min || value > field.max) {
                return { error: `${field.label} must be between ${field.min} and ${field.max}.` };
            }

            values[field.key] = field.allowFloat
                ? sanitizeFloat(value, DEFAULT_SETTINGS[field.key], field.min, field.max, 2)
                : Math.round(value);
        }

        return { values };
    }

    // ===== DOM CREATION HELPERS =====

    function createButton(text, className, styles = {}) {
        const button = document.createElement('button');
        button.textContent = text;
        button.className = className;
        Object.assign(button.style, styles);
        return button;
    }

    function createContainer() {
        const container = document.createElement('div');
        container.style.cssText = 'display:inline-block;font-size:small;color:#666;white-space:nowrap;align-content:center;margin:0 5px';
        return container;
    }

    function createLineContainer(isCart) {
        const lineContainer = document.createElement('div');
        lineContainer.className = 'line-container';
        lineContainer.style.cssText = `display:inline-flex;align-items:center;padding-right:5px${isCart ? '' : ';border-right:1px solid #dee2e6'}`;
        return lineContainer;
    }

    function createInnerLiner(isCart) {
        const lineContainer = document.createElement('div');
        lineContainer.style.cssText = `display:inline-flex;align-items:center;padding-right:5px${isCart ? ';flex-wrap:wrap' : ''}`;
        return lineContainer;
    }

    function createDiffSpan(diffSign, diffValue) {
        const span = document.createElement('span');
        span.textContent = diffValue;
        span.style.color = diffSign === '-' ? 'green' : diffSign === '+' ? 'red' : 'gray';
        return span;
    }

    function createElementFromHTML(htmlString) {
        // Generate a unique ID for this chart instance to avoid duplicate ID issues
        // This is important when the same product appears multiple times on the page
        const uniqueId = 'chart-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11);
        
        // Replace the canvas ID with our unique ID
        let modifiedHTML = htmlString.replace(
            /(<canvas[^>]+id=["'])([^"']+)(["'][^>]*>)/,
            `$1${uniqueId}$3`
        );
        
        // Replace references to the old ID in the script tag with the new unique ID
        modifiedHTML = modifiedHTML.replace(
            /getElementById\(['"]([^'"]+)['"]\)/g,
            `getElementById('${uniqueId}')`
        );
        
        const template = document.createElement('template');
        template.innerHTML = modifiedHTML.trim();
        return template.content.firstElementChild;
    }

    function getValueDiv(text, value, className) {
        const div = document.createElement('div');
        div.className = `d-flex ${className}`;
        div.innerHTML = `<span class="flex-grow-1">${text}</span><span>${value}</span>`;
        return div;
    }

    // ===== UTILITY FUNCTIONS =====

    function buildProductUrl(baseUrl, queries) {
        const url = new URL(baseUrl);
        queries.forEach(query => {
            if (!query) return;
            const [key, value] = query.split('=');
            url.searchParams.delete(key);
            url.searchParams.append(key, value);
        });
        return url.toString();
    }

    function parsePrice(priceText) {
        if (!priceText || priceText === 'N/A') return NaN;
        const inputText = String(priceText);
        const isNegative = /^\s*-/.test(inputText);
        const normalizedText = inputText
            .replace(/\s/g, '')
            .replace(/[^\d.,]/g, '');

        if (!normalizedText || normalizedText === '-') return NaN;

        const lastDot = normalizedText.lastIndexOf('.');
        const lastComma = normalizedText.lastIndexOf(',');

        if (lastDot === -1 && lastComma === -1) {
            const parsedNoSeparator = parseFloat(normalizedText);
            return isNegative ? -parsedNoSeparator : parsedNoSeparator;
        }

        const decimalSeparator = lastDot > lastComma ? '.' : ',';
        const thousandSeparator = decimalSeparator === '.' ? ',' : '.';

        const decimalCount = normalizedText.split(decimalSeparator).length - 1;
        const lastDecimalIndex = normalizedText.lastIndexOf(decimalSeparator);
        const decimalDigits = normalizedText.length - lastDecimalIndex - 1;

        const hasThousandsOnly =
            decimalCount > 1 ||
            (decimalCount === 1 && decimalDigits === 3);

        if (hasThousandsOnly) {
            const parsedThousands = parseFloat(normalizedText.replace(/[.,]/g, ''));
            return isNegative ? -parsedThousands : parsedThousands;
        }

        const parsedValue = parseFloat(
            normalizedText
                .split(thousandSeparator)
                .join('')
                .replace(decimalSeparator, '.')
        );
        return isNegative ? -parsedValue : parsedValue;
    }

    function getFoilState(row) {
        return getFoilBool(row) ? 'isFoil=Y' : 'isFoil=N';
    }

    function getFoilBool(row) {
        return !!row.querySelector('span.icon[aria-label="Foil"]');
    }

    function getOfferRows() {
        return Array.from(document.querySelectorAll('.article-row'));
    }

    function getCartRows() {
        return Array.from(document.querySelectorAll('table.article-table.product-table tbody tr[data-article-id]'));
    }

    function getCurrentRows() {
        if (isOffersPage()) return getOfferRows();
        if (isCartPage()) return getCartRows();
        return [];
    }

    function formatRatioThreshold(value) {
        return Number.isFinite(value) ? Number(value).toFixed(2) : Number(settings.graphRatioThreshold).toFixed(2);
    }

    function refreshThresholdButtonLabels() {
        mainButtons
            .filter(button => button.dataset.role === 'graphs-threshold')
            .forEach(button => {
                const label = `💲 >= ${formatRatioThreshold(settings.graphRatioThreshold)}x`;
                button.dataset.idleText = label;
                if (!isProcessing || activeMainButton !== button) {
                    enableButton(button, label);
                }
            });
    }

    function setRowRatios(row, averageRatio, trendRatio) {
        if (Number.isFinite(averageRatio)) {
            row.dataset.cmRatioAvg = averageRatio.toFixed(6);
        } else {
            delete row.dataset.cmRatioAvg;
        }

        if (Number.isFinite(trendRatio)) {
            row.dataset.cmRatioTrend = trendRatio.toFixed(6);
        } else {
            delete row.dataset.cmRatioTrend;
        }

        const candidates = [averageRatio, trendRatio].filter(Number.isFinite);
        if (!candidates.length) {
            delete row.dataset.cmBestRatio;
            return;
        }

        row.dataset.cmBestRatio = Math.max(...candidates).toFixed(6);
    }

    function getRowBestRatio(row) {
        const value = Number(row?.dataset?.cmBestRatio);
        return Number.isFinite(value) ? value : NaN;
    }

    function sumPrices(urlData) {
        let trend = 0, average = 0;
        Object.values(urlData).forEach(({ trendPrice, averagePrice }) => {
            trend += trendPrice;
            average += averagePrice;
        });
        return { trend, average };
    }

    function replaceOrInsert(parent, targetDiv, className, text, value) {
        const existing = parent.getElementsByClassName(className)[0];
        if (existing) existing.remove();
        const newDiv = getValueDiv(text, value, className);
        targetDiv.parentNode.insertBefore(newDiv, targetDiv.nextSibling);
    }

    function clearOldResults(lineContainer) {
        const fetchBtn = lineContainer.querySelector('.line-fetch-button');
        const graphBtn = lineContainer.querySelector('.graph-btn');
        lineContainer.innerHTML = '';
        if (fetchBtn) lineContainer.appendChild(fetchBtn);
        if (graphBtn) lineContainer.appendChild(graphBtn);
    }

    function disableButton(button, text) {
        button.disabled = true;
        button.textContent = text;
    }

    function enableButton(button, text) {
        button.disabled = false;
        button.textContent = text;
    }

    function startProcessing(fetchRows, batchButton = null) {
        isProcessing = true;
        cancelRequested = false;
        activeMainButton = batchButton || activeMainButton || mainButtons[0] || null;
        mainButtons.forEach(button => {
            if (button === activeMainButton) {
                enableButton(button, 'Cancel');
            } else {
                disableButton(button, button.dataset.idleText || button.textContent);
            }
        });
        fetchRows.forEach(row => {
            const fetchBtn = row.querySelector('.line-fetch-button');
            if (fetchBtn) disableButton(fetchBtn, '...');
        });
        GM_log('Processing started...');
    }

    function finishProcessing() {
        isProcessing = false;
        requestDelay = settings.requestDelayMs;
        mainButtons.forEach(button => enableButton(button, button.dataset.idleText || button.textContent));
        activeMainButton = null;
        document.querySelectorAll('.line-fetch-button').forEach(btn => enableButton(btn, '💲'));
        GM_log('Processing finished or canceled.');
    }

    function requestCancellation() {
        cancelRequested = true;
        if (activeMainButton) {
            disableButton(activeMainButton, 'Cancelling...');
        }
        GM_log('Cancellation requested...');
    }

    function logError(message, error) {
        GM_log(`[Error] ${message}`);
        if (error) {
            GM_log(`Message: ${error.message}`);
            if (error.stack) GM_log(`Stack: ${error.stack}`);
        }
    }

})();
