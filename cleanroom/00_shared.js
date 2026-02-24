(function (global) {
    'use strict';

    const app = global.CMCleanroom || (global.CMCleanroom = {});

    Object.assign(app, {
        PRICE_GUIDE_URL: 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json',
        DB_NAME: 'cm-refactored-cache-db',
        DB_VERSION: 2,
        STORE_PRODUCTS: 'products',
        STORE_META: 'meta',
        SETTINGS_KEY: 'cm-refactored-settings',
        SETTINGS_VERSION: 2,
        PRICE_GUIDE_CACHE_VERSION: 1,
        PRICE_GUIDE_LOOKUP_META_KEY: 'price-guide-lookup-v1',
        PRICE_GUIDE_META_KEY: 'price-guide-meta',
        HYDRATION_PASSES: 10,
        HYDRATION_PASS_DELAY_MS: 600,
        IFRAME_READY_INTERVAL_MS: 250,
        IFRAME_MANUAL_POLL_MS: 500,
        RETRYABLE_CODES: new Set(['CLOUDFLARE_ABORTED', 'CLOUDFLARE_ACTIVE', 'IFRAME_DATA_UNAVAILABLE', 'HTTP_429']),
        CHALLENGE_TEXT_MARKERS: [
            'just a moment', 'verify you are human', 'checking your browser', 'captcha', 'security check',
            'access denied', 'attention required', 'cloudflare', 'ray id', 'please wait while we verify',
            'enable javascript and cookies'
        ],
        CHALLENGE_SELECTORS: [
            '#challenge-form', '#challenge-running', '[name="cf_captcha_kind"]', 'iframe[src*="challenge"]',
            'script[src*="challenge-platform"]', '[data-translate="why_captcha_detail"]', '#cf-wrapper'
        ],
        DEFAULT_SETTINGS: {
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
        },
        SETTINGS_FIELDS: [
            { key: 'cacheExpirationHours', label: 'Cache Expiration (hours)', min: 1, max: 720, step: 1 },
            { key: 'graphRatioThreshold', label: 'Graph Ratio Threshold (x)', min: 0.5, max: 5, step: 0.05 },
            { key: 'requestDelayMs', label: 'Request Delay (ms)', min: 100, max: 10000, step: 50 },
            { key: 'maxInFlightRequests', label: 'Max In-Flight Requests (0 = unlimited)', min: 0, max: 100, step: 1 },
            { key: 'delayRandomizationPercent', label: 'Delay Randomization (+/- %)', min: 0, max: 100, step: 1 },
            { key: 'delayIncrementOn429Ms', label: '429 Delay Increment (ms)', min: 0, max: 10000, step: 50 },
            { key: 'iframeLoadTimeoutMs', label: 'Iframe Load Timeout (ms)', min: 1000, max: 120000, step: 500 },
            { key: 'iframeReadyTimeoutMs', label: 'Iframe Data Timeout (ms)', min: 500, max: 60000, step: 250 },
            { key: 'iframeManualTimeoutMinutes', label: 'Manual Unblock Timeout (minutes)', min: 1, max: 60, step: 1 }
        ]
    });

    app.gmLog = function gmLog(message) {
        if (typeof GM_log === 'function') GM_log(`[cleanroom] ${message}`);
    };

    app.el = function el(tag, props, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (k === 'style') Object.assign(node.style, v);
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node[k] = v;
        }
        if (children.length) node.append(...children.flat().filter(Boolean));
        return node;
    };

    app.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    app.clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    app.sanitizeSettings = function sanitizeSettings(input) {
        const out = structuredClone(app.DEFAULT_SETTINGS);
        for (const [key, value] of Object.entries(input || {})) {
            if (!(key in out)) continue;
            if (key === 'queueMode') {
                out.queueMode = value === 'fixed_delay' ? 'fixed_delay' : 'wait_for_load';
                continue;
            }
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) continue;
            const field = app.SETTINGS_FIELDS.find((f) => f.key === key);
            if (!field) continue;
            out[key] = app.clamp(numeric, field.min, field.max);
        }
        return out;
    };

    app.loadSettings = function loadSettings() {
        const fallback = structuredClone(app.DEFAULT_SETTINGS);
        try {
            const raw = localStorage.getItem(app.SETTINGS_KEY);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== app.SETTINGS_VERSION || !parsed.data) return fallback;
            return app.sanitizeSettings(parsed.data);
        } catch {
            return fallback;
        }
    };

    app.state = {
        settings: app.loadSettings(),
        dbPromise: null,
        priceGuideLookup: null,
        priceGuideLoaded: false,
        priceGuideLoadingPromise: null,
        priceGuideBadges: new Set(),
        mainButtons: [],
        activeMainButton: null,
        requestQueue: null,
        rowChartHtml: new WeakMap(),
        chartContainerByRow: new WeakMap(),
        cloudflareGate: null,
        activeIframeControllers: new Set()
    };

    app.saveSettings = function saveSettings(nextSettings) {
        app.state.settings = app.sanitizeSettings(nextSettings);
        const payload = { version: app.SETTINGS_VERSION, timestamp: Date.now(), data: app.state.settings };
        localStorage.setItem(app.SETTINGS_KEY, JSON.stringify(payload));
        if (app.state.requestQueue) app.state.requestQueue.updateSettings(app.state.settings);
    };

    app.randomizeDelay = function randomizeDelay(ms) {
        const spread = (app.state.settings.delayRandomizationPercent || 0) / 100;
        if (!spread) return ms;
        const factor = 1 + (Math.random() * 2 - 1) * spread;
        return Math.max(0, Math.round(ms * factor));
    };

    app.formatMoney = (value) => Number.isFinite(value) ? `${value.toFixed(2)} €` : 'N/A';

    app.parsePrice = function parsePrice(text) {
        if (typeof text !== 'string') return NaN;
        const normalized = text.trim();
        if (!normalized || /^n\/?a$/i.test(normalized)) return NaN;
        const negative = normalized.startsWith('-');
        let raw = normalized.replace(/[^\d.,-]/g, '').replace(/-/g, '');
        if (!raw) return NaN;
        const lastDot = raw.lastIndexOf('.');
        const lastComma = raw.lastIndexOf(',');
        let decimalSep = '';
        if (lastDot >= 0 && lastComma >= 0) decimalSep = lastDot > lastComma ? '.' : ',';
        else if (lastDot >= 0) decimalSep = '.';
        else if (lastComma >= 0) decimalSep = ',';
        if (decimalSep) {
            const thousandSep = decimalSep === '.' ? ',' : '.';
            raw = raw.split(thousandSep).join('');
            if (decimalSep === ',') raw = raw.replace(',', '.');
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return NaN;
        return negative ? -parsed : parsed;
    };

    app.toFixedRatio = (value) => Number.isFinite(value) ? `${value.toFixed(2)}x` : 'N/A';

    app.extractRowPrice = function extractRowPrice(row, pageType) {
        if (pageType === 'offers') {
            const text = [...row.querySelectorAll('.price-container span')].map((x) => x.textContent || '').find((x) => x.includes('€'));
            return app.parsePrice(text || '');
        }
        const cell = row.querySelector('td.price');
        return app.parsePrice(cell?.textContent || '');
    };

    app.extractQuantity = function extractQuantity(row) {
        const select = row.querySelector('select');
        const value = Number(select?.value || 1);
        return Number.isFinite(value) && value > 0 ? value : 1;
    };

    app.detectFoil = (row) => !!row.querySelector('span.icon[aria-label="Foil"]');

    app.extractProductIdFromText = function extractProductIdFromText(text) {
        if (!text) return null;
        const matches = [
            /(?:idProduct|productId)["'=:\s]+(\d{2,})/i,
            /\/Products\/Singles\/(?:[^/?#]+\/){1,2}(\d{2,})/i,
            /\/\d{2,}\/\d{2,}\/([0-9]{2,})/,
            /(?:product|id)[^\d]{0,8}(\d{2,})/i
        ];
        for (const pattern of matches) {
            const match = text.match(pattern);
            if (match) return Number(match[1]);
        }
        return null;
    };

    app.cacheRowProductId = function cacheRowProductId(row, idProduct) {
        row.dataset.cmProductId = String(idProduct);
        return idProduct;
    };

    app.tryParseUrl = function tryParseUrl(value) {
        try {
            return new URL(value, location.origin);
        } catch {
            return null;
        }
    };

    app.extractProductId = function extractProductId(row) {
        const fromCache = Number(row.dataset.cmProductId);
        if (Number.isFinite(fromCache) && fromCache > 0) return fromCache;
        const directCandidates = [
            row.dataset.idProduct,
            row.dataset.productId,
            row.getAttribute('data-id-product'),
            row.getAttribute('data-product-id')
        ];
        for (const candidate of directCandidates) {
            const value = Number(candidate);
            if (Number.isFinite(value) && value > 0) return app.cacheRowProductId(row, value);
        }

        const link = row.querySelector('a[href*="/Products/Singles/"]');
        const form = row.querySelector('form');
        const hiddenInput = row.querySelector('input[name="idProduct"], input[name="productId"]');
        const nestedCandidates = [link?.dataset.idProduct, link?.dataset.productId, hiddenInput?.value];
        for (const candidate of nestedCandidates) {
            const value = Number(candidate);
            if (Number.isFinite(value) && value > 0) return app.cacheRowProductId(row, value);
        }

        if (link?.href) {
            const url = app.tryParseUrl(link.href);
            const q = Number(url?.searchParams.get('idProduct') || url?.searchParams.get('productId'));
            if (Number.isFinite(q) && q > 0) return app.cacheRowProductId(row, q);
            const fromHref = app.extractProductIdFromText(link.href);
            if (Number.isFinite(fromHref) && fromHref > 0) return app.cacheRowProductId(row, fromHref);
        }

        const tooltipSource = row.querySelector('[data-bs-title]')?.getAttribute('data-bs-title') || '';
        const fromTooltip = app.extractProductIdFromText(tooltipSource);
        if (Number.isFinite(fromTooltip) && fromTooltip > 0) return app.cacheRowProductId(row, fromTooltip);

        const scanElements = [row, link, form].filter(Boolean);
        for (const element of scanElements) {
            for (const attr of element.getAttributeNames()) {
                if (!/product|id/i.test(attr)) continue;
                const value = app.extractProductIdFromText(element.getAttribute(attr) || '');
                if (Number.isFinite(value) && value > 0) return app.cacheRowProductId(row, value);
            }
        }

        const fromHtml = app.extractProductIdFromText(row.innerHTML);
        if (Number.isFinite(fromHtml) && fromHtml > 0) return app.cacheRowProductId(row, fromHtml);
        return null;
    };

    app.firstFinite = function firstFinite(...values) {
        for (const value of values) {
            if (Number.isFinite(value)) return value;
        }
        return NaN;
    };

    app.computePriceSelections = function computePriceSelections(entry, isFoil) {
        if (!entry) return null;
        const average = isFoil
            ? app.firstFinite(entry.avg30Foil, entry.avgFoil, entry.avg30, entry.avg)
            : app.firstFinite(entry.avg30, entry.avg);
        const trend = isFoil ? app.firstFinite(entry.trendFoil, entry.trend) : app.firstFinite(entry.trend);
        return { average, trend };
    };

    app.computeRatios = function computeRatios(marketAverage, marketTrend, sellerPrice, qty) {
        const denominator = sellerPrice * qty;
        const avgTotal = marketAverage * qty;
        const trendTotal = marketTrend * qty;
        const avgRatio = Number.isFinite(avgTotal) && denominator > 0 ? avgTotal / denominator : NaN;
        const trendRatio = Number.isFinite(trendTotal) && denominator > 0 ? trendTotal / denominator : NaN;
        return { avgTotal, trendTotal, avgRatio, trendRatio, bestRatio: Math.max(avgRatio || -Infinity, trendRatio || -Infinity) };
    };

    app.ratioTone = function ratioTone(ratio) {
        if (!Number.isFinite(ratio)) return { color: '#6b7280', prefix: '' };
        if (ratio > 1) return { color: '#0b8f2f', prefix: '-' };
        if (ratio < 1) return { color: '#cf1e1e', prefix: '+' };
        return { color: '#6b7280', prefix: '' };
    };

    app.updateRatioText = function updateRatioText(target, ratios) {
        const avg = app.ratioTone(ratios.avgRatio);
        const trend = app.ratioTone(ratios.trendRatio);
        target.innerHTML = [
            `<span style="color:${avg.color}">30-day: ${app.formatMoney(ratios.avgTotal)} | Diff: ${avg.prefix}${app.toFixedRatio(ratios.avgRatio)}</span>`,
            `<span style="color:${trend.color}">Trend: ${app.formatMoney(ratios.trendTotal)} | Diff: ${trend.prefix}${app.toFixedRatio(ratios.trendRatio)}</span>`
        ].join('<br>');
    };

    app.withQuery = function withQuery(url, params) {
        const parsed = app.tryParseUrl(url);
        if (!parsed) return url;
        for (const [k, v] of Object.entries(params)) parsed.searchParams.set(k, v);
        return parsed.toString();
    };

    app.isOffersPage = () => /\/Users\/[^/]+\/Offers\//.test(location.pathname);
    app.isCartPage = () => location.pathname.includes('/en/Magic/ShoppingCart');
    app.isProductPage = () => /\/Products\/Singles\//.test(location.pathname);
})(globalThis);
