// ==UserScript==
// @name         Cardmarket Refactored
// @namespace    http://tampermonkey.net/
// @version      5.7
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
    const SETTINGS_VERSION = 1;
    const SETTINGS_STORAGE_KEY = 'cm-refactored-settings';
    const IFRAME_READY_INTERVAL_MS = 250;
    const IFRAME_MANUAL_POLL_INTERVAL_MS = 500;
    const DEFAULT_SETTINGS = {
        cacheExpirationHours: 24,
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
        { key: 'requestDelayMs', label: 'Request Delay (ms)', min: 100, max: 10000, step: 50 },
        { key: 'maxInFlightRequests', label: 'Max In-Flight Requests (0 = unlimited)', min: 0, max: 100, step: 1 },
        { key: 'delayRandomizationPercent', label: 'Delay Randomization (+/- %)', min: 0, max: 100, step: 1 },
        {
            key: 'queueMode',
            label: '$ All Queue Mode',
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
    let mainButton;
    let settingsModal = null;
    let settingsModalClose = null;
    let activeIframeRequests = new Set();
    let nextIframeRequestId = 1;
    let cloudflareGate = null;

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
        ensureSettingsModal();
        insertMainButton('.row.g-0.flex-nowrap.align-items-center.pagination.d-none.d-md-flex.mb-2');
        addPerLineFetchButtons('.article-row', '.col-sellerProductInfo');
    }

    function initializeCartPage() {
        ensureSettingsModal();
        insertCartMainButton();
        addCartPerLineFetchButtons();
    }

    // ===== BUTTON CREATION =====

    function insertMainButton(containerSelector) {
        const paginationRow = document.querySelector(containerSelector);
        if (!paginationRow) return;

        const col3Elements = paginationRow.querySelectorAll('.d-none.d-sm-block.col-3');
        if (col3Elements.length < 2) return;

        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:8px;float:right';

        mainButton = createButton('💲 All', 'btn btn-primary btn-sm');
        mainButton.addEventListener('click', onMainButtonClick);
        controls.append(mainButton, createSettingsButton('btn btn-secondary btn-sm'));
        col3Elements[1].appendChild(controls);
    }

    function insertCartMainButton() {
        const cardBody = document.querySelector('.card.w-100.cart-overview .card-body.d-flex.flex-column');
        if (!cardBody) return;

        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px';

        mainButton = createButton('💲 All', 'btn btn-primary btn-sm');
        mainButton.addEventListener('click', onCartMainButtonClick);
        controls.append(mainButton, createSettingsButton('btn btn-secondary btn-sm'));
        cardBody.appendChild(controls);
    }

    function createSettingsButton(className) {
        const button = createButton('⚙ Settings', className);
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

    function fetchProductData(productUrl) {
        return getCachedData([productUrl, CACHE_VERSION], getCacheExpirationMs(), () => fetchProductDataViaIframe(productUrl));
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
        if (!hasCacheableProductData(freshData)) {
            throw createRetryableError(`Non-cacheable product data for "${storageKey}"`, 'NON_CACHEABLE_PRODUCT_DATA');
        }

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
            if (!hasCacheableProductData(data)) {
                localStorage.removeItem(storageKey);
                return null;
            }

            if (Date.now() - timestamp < getCacheExpirationMs()) return data;
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
                    const { timestamp, data } = JSON.parse(cachedString);
                    const looksLikeProductPayload = Boolean(
                        data &&
                        typeof data === 'object' &&
                        ('averagePriceText' in data || 'trendPriceText' in data || 'chartWrapperHTML' in data)
                    );

                    if (looksLikeProductPayload && !hasCacheableProductData(data)) {
                        keysToRemove.push(key);
                        continue;
                    }

                    if (timestamp && now - timestamp >= getCacheExpirationMs()) {
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
        cleanupExpiredCache();
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
        subtitle.textContent = 'These values are saved to localStorage and reused on future page loads.';
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

        actions.append(resetBtn, cancelBtn, saveBtn);
        form.append(fieldsWrapper, errorText, actions);

        form.addEventListener('submit', event => {
            event.preventDefault();
            const parsed = parseSettingsForm();
            if (parsed.error) {
                errorText.textContent = parsed.error;
                return;
            }

            saveUserSettings(parsed.values);
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

            values[field.key] = Math.round(value);
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
        requestDelay = settings.requestDelayMs;
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
