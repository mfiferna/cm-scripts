// ==UserScript==
// @name         Cardmarket Refactored
// @namespace    http://tampermonkey.net/
// @version      4.9
// @description  Adds main "💲 All" and per-line "💲" buttons with results wrapped in a bordered container.
// @author       mfiferna
// @homepage     https://github.com/mfiferna/cm-scripts
// @supportURL   https://github.com/mfiferna/cm-scripts/issues
// @downloadURL  https://github.com/mfiferna/cm-scripts/raw/main/refactored_cardmarket.js
// @updateURL    https://github.com/mfiferna/cm-scripts/raw/main/refactored_cardmarket.js
// @match        https://www.cardmarket.com/en/Magic/Users/*/Offers/*
// @match        https://www.cardmarket.com/en/Magic/ShoppingCart
// @match        https://www.cardmarket.com/en/Magic/Products/Singles/*/*
// @grant        GM_log
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(async function () {
    'use strict';

    // Constants
    const CACHE_VERSION = 2;
    const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours
    const REQUEST_DELAY = 1000;
    const DELAY_INCREMENT_ON_429 = 1000;
    const IFRAME_LOAD_TIMEOUT_MS = 15000;
    const IFRAME_READY_TIMEOUT_MS = 5000;
    const IFRAME_READY_INTERVAL_MS = 250;
    const IFRAME_MANUAL_TIMEOUT_MS = 5 * 60 * 1000;
    const IFRAME_MANUAL_POLL_INTERVAL_MS = 500;

    // State
    let requestDelay = REQUEST_DELAY;
    let isProcessing = false;
    let cancelRequested = false;
    let mainButton;

    // Initialize
    cleanupExpiredCache();
    document.addEventListener('DOMContentLoaded', init);

    // ===== INITIALIZATION =====

    function init() {
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
        setLocalCache([productUrl, CACHE_VERSION], pageData);
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

    function loadChartLibrary() {
        if (typeof Chart === 'undefined') {
            const script = document.createElement('script');
            script.src = '//static.cardmarket.com/img/a1aabefc8f2134d2654a5c7bdcf32647/static-code/public/js/Chart_2_7_2.min.js';
            script.async = true;
            document.head.appendChild(script);
        }
    }

    function initializeOffersPage() {
        insertMainButton('.row.g-0.flex-nowrap.align-items-center.pagination.d-none.d-md-flex.mb-2');
        addPerLineFetchButtons('.article-row', '.col-sellerProductInfo');
    }

    function initializeCartPage() {
        insertCartMainButton();
        addCartPerLineFetchButtons();
    }

    // ===== BUTTON CREATION =====

    function insertMainButton(containerSelector) {
        const paginationRow = document.querySelector(containerSelector);
        if (!paginationRow) return;

        const col3Elements = paginationRow.querySelectorAll('.d-none.d-sm-block.col-3');
        if (col3Elements.length < 2) return;

        mainButton = createButton('💲 All', 'btn btn-primary btn-sm ms-3', { marginLeft: '10px', float: 'right' });
        mainButton.addEventListener('click', onMainButtonClick);
        col3Elements[1].appendChild(mainButton);
    }

    function insertCartMainButton() {
        const cardBody = document.querySelector('.card.w-100.cart-overview .card-body.d-flex.flex-column');
        if (!cardBody) return;

        mainButton = createButton('💲 All', 'btn btn-primary btn-sm mt-2');
        mainButton.addEventListener('click', onCartMainButtonClick);
        cardBody.appendChild(mainButton);
    }

    function addPerLineFetchButtons(rowSelector, targetSelector) {
        document.querySelectorAll(rowSelector).forEach(row => {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            const target = row.querySelector(targetSelector);
            if (!link || !target) return;

            const lineContainer = createLineContainer(false);
            const fetchBtn = createButton('💲', 'line-fetch-button btn', { fontSize: 'small', margin: '2px 0 2px 5px' });
            fetchBtn.addEventListener('click', () => handleFetchButtonClick(row, link, fetchBtn));
            
            lineContainer.appendChild(fetchBtn);
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

                outerDiv.append(oldContentDiv, fetchBtn, lineContainer);
                infoCell.appendChild(outerDiv);
            });
        });
    }

    // ===== MAIN CLICK HANDLERS =====

    function onMainButtonClick() {
        if (isProcessing) return requestCancellation();

        const articleRows = Array.from(document.querySelectorAll('.article-row'));
        if (!articleRows.length) return logError('No article rows found to process.');

        loadData(articleRows);
    }

    async function onCartMainButtonClick() {
        const sellers = document.querySelectorAll('section[id*="seller"]');
        const sellerData = {};

        for (const seller of sellers) {
            const articleDiv = seller.querySelector('.item-value')?.parentNode;
            const totalDiv = seller.querySelector('.strong.total')?.parentNode;
            const totalValue = parsePrice(seller.querySelector('.strong.total')?.textContent || '0');

            const cartRows = Array.from(seller.querySelectorAll('table.article-table.product-table tbody tr[data-article-id]'));
            if (!cartRows.length) continue;

            const urlData = await loadDataAsync(cartRows);
            sellerData[seller.id] = urlData;

            const { trend, average } = sumPrices(urlData);

            if (articleDiv) {
                replaceOrInsert(seller, articleDiv, 'value-div', 
                    `Estimated Value`, 
                    `30-day: ${average.toFixed(2)}€ | Trend: ${trend.toFixed(2)} €`);
            }

            if (totalDiv) {
                replaceOrInsert(seller, totalDiv, 'profit-div',
                    `Profit`,
                    `30-day: ${(average - totalValue).toFixed(2)} € | Trend: ${(trend - totalValue).toFixed(2)} €`);
            }
        }

        displayCartTotals(sellerData);
    }

    function displayCartTotals(sellerData) {
        const cartDiv = document.querySelector('.card.w-100.cart-overview .card-body');
        const articleValueDiv = cartDiv.querySelector('.item-value').parentNode;
        const totalValueDiv = [...cartDiv.querySelectorAll('.d-flex')].pop();
        const totalPrice = parsePrice([...totalValueDiv.querySelectorAll('span')].pop().textContent);

        let totalTrend = 0, totalAverage = 0;
        Object.values(sellerData).forEach(data => {
            const { trend, average } = sumPrices(data);
            totalTrend += trend;
            totalAverage += average;
        });

        replaceOrInsert(cartDiv, articleValueDiv, 'value-div',
            `Est. Value`,
            `30-day: ${totalAverage.toFixed(2)}€ | Trend: ${totalTrend.toFixed(2)} €`);

        replaceOrInsert(cartDiv, totalValueDiv, 'profit-div',
            `Total Profit`,
            `30-day: ${(totalAverage - totalPrice).toFixed(2)} € | Trend: ${(totalTrend - totalPrice).toFixed(2)} €`);

        GM_log('Seller Data:', sellerData);
    }

    function handleFetchButtonClick(row, link, fetchBtn) {
        const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
        
        disableButton(fetchBtn, '...');
        fetchProductData(productUrl)
            .then(data => processProductPage(data, row))
            .catch(err => logError('Error fetching product page:', err))
            .finally(() => enableButton(fetchBtn, '💲'));
    }

    // ===== DATA LOADING =====

    function loadDataAsync(articleRows) {
        return new Promise(resolve => loadData(articleRows, resolve));
    }

    function loadData(articleRows, dataCallback = () => {}) {
        const rowData = {};
        const fetchNeeded = [];

        for (const row of articleRows) {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            if (!link) continue;

            const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
            const cachedData = checkLocalCache([productUrl, CACHE_VERSION]);

            if (cachedData) {
                try {
                    rowData[productUrl] = processProductPage(cachedData, row);
                } catch (err) {
                    logError(`Error processing cached data for "${link.textContent.trim()}"`, err);
                }
            } else {
                fetchNeeded.push(row);
            }
        }

        if (fetchNeeded.length > 0) {
            startProcessing(fetchNeeded);
            processQueue(fetchNeeded, data => dataCallback({ ...data, ...rowData }));
        } else {
            GM_log('All items satisfied via cache.');
            dataCallback(rowData);
        }
    }

    function processQueue(queue, finishCallback, progressData = {}) {
        if (queue.length === 0 || cancelRequested) {
            if (queue.length === 0 && finishCallback) finishCallback(progressData);
            return finishProcessing();
        }

        const row = queue.shift();
        const link = row.querySelector('a[href*="/en/Magic/Products/"]');
        if (!link) return processQueue(queue, finishCallback, progressData);

        const productUrl = buildProductUrl(link.href, [getFoilState(row)]);
        const productName = link.textContent.trim() || "Unknown Product";

        fetchProductData(productUrl)
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
                    if (/Non-200 response: 429/.test(err.message)) {
                        requestDelay += DELAY_INCREMENT_ON_429;
                        queue.push(row); // Retry later
                    } else {
                        logError(`Error fetching "${productName}":`, err);
                    }
                }
            })
            .finally(() => {
                if (!cancelRequested) {
                    setTimeout(() => processQueue(queue, finishCallback, progressData), requestDelay);
                } else {
                    finishProcessing();
                }
            });
    }

    // ===== DATA PROCESSING =====

    function processProductPage(data, row) {
        const quantity = getQuantity(row);
        const averagePrice = parsePrice(data.averagePriceText) * quantity;
        const trendPrice = parsePrice(data.trendPriceText) * quantity;
        const sellerPrice = getSellerPrice(row) * quantity;

        displayResults(row, averagePrice, trendPrice, sellerPrice, data.averagePriceText, data.trendPriceText, data.chartWrapperHTML);

        return {
            averagePrice,
            averagePriceText: data.averagePriceText,
            trendPrice,
            trendPriceText: data.trendPriceText,
            sellerPrice,
            quantity
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

    function displayResults(row, averagePrice, trendPrice, sellerPrice, avgText, trendText, chartHTML) {
        const lineContainer = row.querySelector('.line-container');
        if (!lineContainer) return;

        clearOldResults(lineContainer);

        const innerLiner = createInnerLiner(isCartPage());
        innerLiner.append(
            createResultContainer('30-day', avgText, averagePrice / sellerPrice),
            createResultContainer('Trend', trendText, trendPrice / sellerPrice)
        );
        lineContainer.appendChild(innerLiner);

        if (unsafeWindow.attachDraggableBoxIcon && chartHTML) {
            const chartIcon = createButton('📈', 'btn btn-sm', { marginLeft: '5px' });
            const productName = getProductName(row) + (getFoilBool(row) ? ' ⭐' : '');
            const chart = createElementFromHTML(chartHTML);
            unsafeWindow.attachDraggableBoxIcon(chartIcon, chart, productName);
            lineContainer.appendChild(chartIcon);
        }
    }

    function getProductName(row) {
        const link = row.querySelector('a[href*="/en/Magic/Products/"]');
        if (!isCartPage()) return link?.textContent.trim() || 'chart';
        
        const parent = findParentBySelector(row, '.card-body');
        const seller = parent?.querySelector('.seller-info a[href*="/en/Magic/Users/"]')?.textContent.trim() || '';
        return seller ? `${seller} - ${link?.textContent.trim() || ''}` : link?.textContent.trim() || 'chart';
    }

    function createResultContainer(label, priceText, difference) {
        const container = createContainer();
        const diffSign = difference > 1 ? '-' : difference < 1 ? '+' : '';
        const diffValue = `${Math.abs(difference).toFixed(2)} x`;

        container.appendChild(document.createTextNode(`${label}: ${priceText} | Diff: `));
        container.appendChild(createDiffSpan(diffSign, diffValue));

        return container;
    }

    // ===== FETCHING & CACHING =====

    function fetchProductData(productUrl) {
        return getCachedData([productUrl, CACHE_VERSION], CACHE_EXPIRATION_MS, () => fetchProductDataViaIframe(productUrl));
    }

    function fetchProductDataViaIframe(productUrl) {
        return new Promise((resolve, reject) => {
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
            };

            const finalize = (callback, payload) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback(payload);
            };

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

                    if (Date.now() - startedAt >= IFRAME_MANUAL_TIMEOUT_MS) {
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

                    if (Date.now() - startedAt >= IFRAME_READY_TIMEOUT_MS) {
                        GM_log(`[cache] Iframe data timeout for ${productUrl}, using best available data.`);
                        return finalize(resolve, lastData);
                    }
                }, IFRAME_READY_INTERVAL_MS);
            };

            const onError = () => finalize(reject, new Error(`Iframe navigation failed for "${productUrl}"`));

            loadTimeout = setTimeout(() => {
                finalize(reject, new Error(`Iframe load timeout for "${productUrl}"`));
            }, IFRAME_LOAD_TIMEOUT_MS);

            iframe.addEventListener('load', onLoad);
            iframe.addEventListener('error', onError);
            iframe.src = productUrl;
            (document.body || document.documentElement).appendChild(iframe);
        });
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
            'attention required'
        ];

        if (markers.some(marker => title.includes(marker) || bodyText.includes(marker))) {
            return true;
        }

        return Boolean(
            doc.querySelector('#challenge-form') ||
            doc.querySelector('#challenge-running') ||
            doc.querySelector('[name="cf_captcha_kind"]') ||
            doc.querySelector('iframe[src*="challenge"]')
        );
    }

    function extractPageData(doc) {
        let averagePriceText = 'N/A', trendPriceText = 'N/A';
        
        doc.querySelectorAll('dt.col-6.col-xl-5').forEach(dt => {
            const label = dt.textContent.trim();
            if (label === '30-days average price') {
                averagePriceText = dt.nextElementSibling?.querySelector('span')?.textContent.trim() || 'N/A';
            }
            if (label === 'Price Trend') {
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

    async function getCachedData(keyParts, expirationMs, fetchCallback) {
        const storageKey = keyParts.join('|');
        const cachedString = localStorage.getItem(storageKey);

        if (cachedString) {
            try {
                const { timestamp, data } = JSON.parse(cachedString);
                if (Date.now() - timestamp < expirationMs) {
                    return data;
                }
            } catch (err) {
                console.warn(`Failed to parse cached data for key: ${storageKey}`, err);
            }
        }

        const freshData = await fetchCallback();
        localStorage.setItem(storageKey, JSON.stringify({ timestamp: Date.now(), data: freshData }));
        return freshData;
    }

    function setLocalCache(keyParts, data) {
        const storageKey = keyParts.join('|');
        localStorage.setItem(storageKey, JSON.stringify({ timestamp: Date.now(), data }));
    }

    function checkLocalCache(keyParts) {
        const storageKey = keyParts.join('|');
        const cachedString = localStorage.getItem(storageKey);

        if (!cachedString) return null;

        try {
            const { timestamp, data } = JSON.parse(cachedString);
            if (Date.now() - timestamp < CACHE_EXPIRATION_MS) return data;
        } catch (err) {
            console.warn(`Failed to parse cached data for key: ${storageKey}`, err);
        }

        return null;
    }

    function cleanupExpiredCache() {
        const now = Date.now();
        const keysToRemove = [];

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.includes('cardmarket.com') && key.includes('|')) {
                const cachedString = localStorage.getItem(key);
                try {
                    const { timestamp } = JSON.parse(cachedString);
                    if (timestamp && now - timestamp >= CACHE_EXPIRATION_MS) {
                        keysToRemove.push(key);
                    }
                } catch (err) {
                    keysToRemove.push(key); // Remove corrupted entries
                }
            }
        }

        keysToRemove.forEach(key => localStorage.removeItem(key));
        if (keysToRemove.length > 0) {
            console.log(`[cache-cleanup] Removed ${keysToRemove.length} expired entries.`);
        }
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
        return parseFloat(priceText.replace(' €', '').replace(',', '.').trim());
    }

    function getFoilState(row) {
        return getFoilBool(row) ? 'isFoil=Y' : 'isFoil=N';
    }

    function getFoilBool(row) {
        return !!row.querySelector('span.icon[aria-label="Foil"]');
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
        lineContainer.innerHTML = '';
        if (fetchBtn) lineContainer.appendChild(fetchBtn);
    }

    function findParentBySelector(elm, selector) {
        const all = Array.from(document.querySelectorAll(selector));
        let cur = elm.parentNode;
        while (cur && !all.includes(cur)) {
            cur = cur.parentNode;
        }
        return cur;
    }

    function disableButton(button, text) {
        button.disabled = true;
        button.textContent = text;
    }

    function enableButton(button, text) {
        button.disabled = false;
        button.textContent = text;
    }

    function startProcessing(fetchRows) {
        isProcessing = true;
        cancelRequested = false;
        enableButton(mainButton, 'Cancel');
        fetchRows.forEach(row => {
            const fetchBtn = row.querySelector('.line-fetch-button');
            if (fetchBtn) disableButton(fetchBtn, '...');
        });
        GM_log('Processing started...');
    }

    function finishProcessing() {
        isProcessing = false;
        requestDelay = REQUEST_DELAY;
        enableButton(mainButton, '💲 All');
        document.querySelectorAll('.line-fetch-button').forEach(btn => enableButton(btn, '💲'));
        GM_log('Processing finished or canceled.');
    }

    function requestCancellation() {
        cancelRequested = true;
        disableButton(mainButton, 'Cancelling...');
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
