// ==UserScript==
// @name         Cardmarket Refactored
// @namespace    http://tampermonkey.net/
// @version      4.5
// @description  Adds main "💲 All" and per-line "💲" buttons with results wrapped in a bordered container.
// @author       mfiferna
// @homepage     https://github.com/mfiferna/cm-scripts
// @supportURL   https://github.com/mfiferna/cm-scripts/issues
// @downloadURL  https://github.com/mfiferna/cm-scripts/raw/main/refactored_cardmarket.js
// @updateURL    https://github.com/mfiferna/cm-scripts/raw/main/refactored_cardmarket.js
// @match        https://www.cardmarket.com/en/Magic/Users/*/Offers/*
// @match        https://www.cardmarket.com/en/Magic/ShoppingCart
// @grant        GM_xmlhttpRequest
// @grant        GM_log
// @grant        unsafeWindow
// @connect      www.cardmarket.com
// @run-at       document-start
// ==/UserScript==

(async function () {
    'use strict';

    // Constants
    const CACHE_VERSION = 2;
    const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours
    const REQUEST_DELAY = 1000;
    const DELAY_INCREMENT_ON_429 = 1000;

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
        loadChartLibrary();
        if (isOffersPage()) {
            initializeOffersPage();
        } else if (isCartPage()) {
            initializeCartPage();
        }
    }

    function isOffersPage() {
        return /\/Users\/[^/]+\/Offers\//.test(location.pathname);
    }

    function isCartPage() {
        return location.pathname.includes('/en/Magic/ShoppingCart');
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
        return getCachedData([productUrl, CACHE_VERSION], CACHE_EXPIRATION_MS, async () => {
            const doc = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: productUrl,
                    onload: response => {
                        if (response.status === 200) {
                            resolve(new DOMParser().parseFromString(response.responseText, 'text/html'));
                        } else {
                            reject(new Error(`Non-200 response: ${response.status}`));
                        }
                    },
                    onerror: reject
                });
            });
            return extractPageData(doc);
        });
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
            // Generate a unique ID for this chart to avoid duplicate ID issues
            const uniqueId = 'chart-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            chartWrapperHTML = chartWrapper.outerHTML;
            
            // Replace the canvas ID with our unique ID
            // Match patterns like id="priceGuide-123" or id='priceGuide-123'
            chartWrapperHTML = chartWrapperHTML.replace(
                /(<canvas[^>]+id=["'])([^"']+)(["'][^>]*>)/,
                `$1${uniqueId}$3`
            );
            
            // Replace references to the old ID in the script tag with the new unique ID
            // This handles Chart initialization like: document.getElementById('priceGuide-123')
            chartWrapperHTML = chartWrapperHTML.replace(
                /getElementById\(['"]([^'"]+)['"]\)/g,
                `getElementById('${uniqueId}')`
            );
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
        const template = document.createElement('template');
        template.innerHTML = htmlString.trim();
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
