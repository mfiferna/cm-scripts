// ==UserScript==
// @name         Cardmarket Refactored
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  Adds main "💲 All" and per-line "💲" buttons with results wrapped in a bordered container.
// @match        https://www.cardmarket.com/en/Magic/Users/*/Offers/*
// @match        https://www.cardmarket.com/en/Magic/ShoppingCart
// @grant        GM_xmlhttpRequest
// @grant        GM_log
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      www.cardmarket.com
// @run-at       document-start
// ==/UserScript==

(async function () {
    'use strict';

    const extraQuery = '';
    let requestDelay = 1000;
    const delayIncrementOn429 = 1000;
    let isProcessing = false;
    let cancelRequested = false;
    let mainButton;
    const cacheDataVersion = 2;
    const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

    // Instead of always calling initializeScript, decide which page we’re on:
    document.addEventListener('DOMContentLoaded', () => {
        if (isOffersPage()) {
            // Run original offers logic
            initializeScript();
        } else if (isCartPage()) {
            // Run new cart logic
            initializeCartScript();
        }
    });

    function isOffersPage() {
        // Checks for URLs like /en/Magic/Users/SomeUser/Offers/...
        return /\/Users\/[^/]+\/Offers\//.test(location.pathname);
    }

    function isCartPage() {
        // Adjust if your actual cart path differs
        return location.pathname.includes('/en/Magic/ShoppingCart');
    }

    function initializeCartScript() {
        initChart();
        insertCartMainButton();
        addCartPerLineFetchButtons();
        // initMutationObserver();
    }

    function initializeScript() {
        initChart();
        insertMainButton();
        addPerLineFetchButtons();
    }

    function initChart() {
        if(typeof Chart === 'undefined') {
            var script = document.createElement('script');
            script.src = '//static.cardmarket.com/img/a1aabefc8f2134d2654a5c7bdcf32647/static-code/public/js/Chart_2_7_2.min.js';
            script.type = 'text/javascript';
            script.async = true;  // Optional: Load asynchronously
            document.head.appendChild(script);  // Append to the <head> or <body>
        }
    }

    function initMutationObserver() {
        //init mutations on id="shipments-col"
        var targetNode = document.getElementById('shipments-col');
        var config = { childList: true, subtree: true };
        var callback = function(mutationsList, observer) {
            for(var mutation of mutationsList) {
                if (mutation.type == 'childList') {
                    GM_log(mutation);
                }
            }
        };
        var observer = new MutationObserver(callback);
        observer.observe(targetNode, config);
    }

    /**
     * Adds per-line "💲" fetch buttons to each cart row for all cart tables on the page.
     */
    function addCartPerLineFetchButtons() {
        // Each seller’s items are in a separate table.article-table.product-table
        const cartTables = document.querySelectorAll('table.article-table.product-table');
        cartTables.forEach(table => {
            // Grab each row that has a "data-article-id"
            const cartRows = table.querySelectorAll('tbody tr[data-article-id]');
            cartRows.forEach(row => {
                // Find the product link
                const link = row.querySelector('a[href*="/en/Magic/Products/"]');
                if (!link) return; // skip if no link

                // Decide where to place the button. For example, place it at the end of .info cell:
                const infoCell = row.querySelector('td.info');
                if (!infoCell) return;

                const outerDiv = document.createElement('div');
                outerDiv.style.display = 'inline-flex';
                outerDiv.style.width = '100%';

                // Wrap the existing contents in an inline-block div
                const oldContentDiv = document.createElement('div');
                oldContentDiv.style.display = 'inline-block';
                oldContentDiv.style.minWidth = 'fit-content';
                oldContentDiv.style.marginTop = 'auto';
                oldContentDiv.style.marginBottom = 'auto';
                // Move all existing child nodes of infoCell into oldContentDiv
                while (infoCell.firstChild) {
                    oldContentDiv.appendChild(infoCell.firstChild);
                }

                outerDiv.appendChild(oldContentDiv);

                // Create the container + button
                const lineContainer = createLineContainer(true);
                const fetchBtn = createButton('💲', 'line-fetch-button btn', {
                    fontSize: 'small',
                    margin: '2px 0 2px 5px',
                    padding: '2px'
                });


                // Reuse the existing click handler from Offers (or adapt as needed):
                fetchBtn.addEventListener('click', () => handleFetchButtonClick(row, link, fetchBtn));

                outerDiv.appendChild(fetchBtn);
                outerDiv.appendChild(lineContainer);

                infoCell.appendChild(outerDiv);
            });
        });
    }

    /**
     * Inserts a main "💲 All" button into the bottom of the cart overview card.
     */
    function insertCartMainButton() {
        // Locate the container div: .card.w-100.cart-overview > .card-body.d-flex.flex-column
        const cardBody = document.querySelector('.card.w-100.cart-overview .card-body.d-flex.flex-column');
        if (!cardBody) {
            logError('Cart overview container not found. Cannot insert cart fetch-all button.');
            return;
        }

        // Create the button (reuse your existing `createButton` if you have it)
        const mainCartButton = document.createElement('button');
        mainCartButton.textContent = '💲 All';
        mainCartButton.className = 'btn btn-primary btn-sm mt-2'; // add margin-top for spacing

        // Attach your existing fetch-all logic (like onMainButtonClick in Offers)
        mainCartButton.addEventListener('click', onCartMainButtonClick);

        // Insert at the bottom of the div
        cardBody.appendChild(mainCartButton);

        mainButton = mainCartButton;
    }

    /**
     * Handler that fetches data for all lines in all cart tables.
     */
    async function onCartMainButtonClick() {
        const sellers = document.querySelectorAll('section[id*="seller"');

        const sellerData = {};

        for(const seller of sellers) {

            let articleDiv;
            let articleValue = 0;
            let totalDiv;
            let totalValue = 0;

            let innerArticleValueDiv = seller.querySelector('.item-value');
            let innerTotalValueDiv = seller.querySelector('.strong.total');

            if(innerArticleValueDiv) {
                articleValue = parsePrice(innerArticleValueDiv.textContent);
                articleDiv = innerArticleValueDiv.parentNode;
            }

            if(innerTotalValueDiv) {
                totalValue = parsePrice(innerTotalValueDiv.textContent);
                totalDiv = innerTotalValueDiv.parentNode;
            }

            const cartTables = seller.querySelectorAll('table.article-table.product-table');
            const cartRows = [];
            cartTables.forEach(table => {
                const rows = table.querySelectorAll('tbody tr[data-article-id]');
                cartRows.push(...rows);
            });

            if (!cartRows.length) {
                logError('No cart rows found to process.');
                return;
            }

            let urlData = await loadDataAsync(cartRows);

            sellerData[seller.id] = urlData;

            let estimatedTrendValue = 0;
            let estimated30DayValue = 0;
            for(const key in urlData) {
                estimatedTrendValue += urlData[key].trendPrice;
                estimated30DayValue += urlData[key].averagePrice;
            }

            if(articleDiv) {
                let text = "Estimated Value";
                let value = "30-day: " + estimated30DayValue.toFixed(2) + "€ | Trend: " + estimatedTrendValue.toFixed(2) + " €";
                let newDiv = getValueDiv(text, value, "value-div");

                //remove existing div based on id
                let existingDiv = seller.getElementsByClassName("value-div")[0];
                if(existingDiv) {
                    existingDiv.remove();
                }

                articleDiv.parentNode.insertBefore(newDiv, articleDiv.nextSibling);
            }

            if(totalDiv) {
                let text = "Profit"
                let trendValue = "Trend: " + (estimatedTrendValue - totalValue).toFixed(2) + " €";
                let thirtyDayValue = "30-day: " + (estimated30DayValue - totalValue).toFixed(2) + " €";
                let profitDiv = getValueDiv(text, thirtyDayValue + " | " + trendValue, "profit-div");

                //remove existing div based on class
                let existingDiv = seller.getElementsByClassName("profit-div")[0];
                if(existingDiv) {
                    existingDiv.remove();
                }

                totalDiv.parentNode.insertBefore(profitDiv, totalDiv.nextSibling);
            }
        }

        let shoppingCartDiv = document.querySelector('.card.w-100.cart-overview .card-body');

        let articleValueDiv = shoppingCartDiv.querySelector('.item-value').parentNode;
        let totalValueDiv = [...shoppingCartDiv.querySelectorAll('.d-flex')].slice(-1)[0];

        let totalPriceText = [...totalValueDiv.querySelectorAll('span')].slice(-1)[0].textContent;
        let totalPriceValue = parsePrice(totalPriceText);

        let totalEstimatedTrendValue = 0;
        let totalEstimated30DayValue = 0;
        for(const key in sellerData) {
            for(const innerKey in sellerData[key]) {
                totalEstimatedTrendValue += sellerData[key][innerKey].trendPrice;
                totalEstimated30DayValue += sellerData[key][innerKey].averagePrice;
            }
        }

        let text = "Est. Value";
        let value = "30-day: " + totalEstimated30DayValue.toFixed(2) + "€ | Trend: " + totalEstimatedTrendValue.toFixed(2) + " €";
        let newDiv = getValueDiv(text, value, "value-div");

        //remove existing div based on class
        let existingDiv = shoppingCartDiv.getElementsByClassName("value-div")[0];

        if(existingDiv) {
            existingDiv.remove();
        }

        articleValueDiv.parentNode.insertBefore(newDiv, articleValueDiv.nextSibling);

        let text2 = "Total Profit"
        let totalEstimated30DayProfit = -1 * totalPriceValue;
        let totalEstimatedTrendProfit = -1 * totalPriceValue;
        for(const key in sellerData) {
            for(const innerKey in sellerData[key]) {
                totalEstimatedTrendProfit += sellerData[key][innerKey].trendPrice;
                totalEstimated30DayProfit += sellerData[key][innerKey].averagePrice;
            }
        }


        let trendValue = "Trend: " + totalEstimatedTrendProfit.toFixed(2) + " €";
        let thirtyDayValue = "30-day: " + totalEstimated30DayProfit.toFixed(2) + " €";

        //remove existing div based on class
        let existingDiv2 = shoppingCartDiv.getElementsByClassName("profit-div")[0];
        if(existingDiv2) {
            existingDiv2.remove();
        }

        let profitDiv = getValueDiv(text2, thirtyDayValue + " | " + trendValue, "profit-div");

        totalValueDiv.parentNode.insertBefore(profitDiv, totalValueDiv.nextSibling);

        GM_log('Seller Data:', sellerData);
    }

    function getValueDiv(text, value, className) {
        const div = document.createElement('div');
        div.className = 'd-flex ' + className;
        div.innerHTML = `
        <span class="flex-grow-1">${text}</span>
        <span class="">${value}</span>
        `;
        return div;
    }

    function insertMainButton() {
        const paginationRow = document.querySelector('.row.g-0.flex-nowrap.align-items-center.pagination.d-none.d-md-flex.mb-2');
        if (!paginationRow) return logError('Pagination row not found. Cannot insert main fetch button.');

        const col3Elements = paginationRow.querySelectorAll('.d-none.d-sm-block.col-3');
        if (col3Elements.length < 2) return logError('Not enough col-3 elements found. Cannot insert main button.');

        const rightContainer = col3Elements[1];
        mainButton = createButton('💲 All', 'btn btn-primary btn-sm ms-3', { marginLeft: '10px', float: 'right' });
        rightContainer.appendChild(mainButton);
        mainButton.addEventListener('click', onMainButtonClick);
    }

    function addPerLineFetchButtons() {
        const articleRows = Array.from(document.querySelectorAll('.article-row'));
        for (const row of articleRows) {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            const infoColumn = row.querySelector('.col-sellerProductInfo');
            if (link && infoColumn) createPerLineButton(row, link, infoColumn);
        }
    }

    function createPerLineButton(row, link, infoColumn) {
        const lineContainer = createLineContainer();
        const fetchBtn = createButton('💲', 'line-fetch-button btn', { fontSize: 'small', margin: '2px 0 2px 5px' });

        fetchBtn.addEventListener('click', () => handleFetchButtonClick(row, link, fetchBtn));
        lineContainer.appendChild(fetchBtn);
        infoColumn.appendChild(lineContainer);
    }

    function handleFetchButtonClick(row, link, fetchBtn) {
        const foilQuery = getFoilState(row);
        const productUrl = buildProductUrl(link.href, [extraQuery, foilQuery]);

        disableButton(fetchBtn, '...');
        fetchProductData(productUrl)
            .then(data => processProductPage(data, row))
            .catch(err => logError('Error fetching product page:', err))
            .finally(() => enableButton(fetchBtn, '💲'));
    }

    function onMainButtonClick() {
        if (isProcessing) {
            // If already processing, clicking again requests cancellation.
            return requestCancellation();
        }

        const articleRows = Array.from(document.querySelectorAll('.article-row'));

        if (articleRows.length === 0) {
            return logError('No article rows found to process.');
        }

        loadData(articleRows);
    }

    function loadDataAsync(articleRows) {
        return new Promise((resolve, reject) => {
            loadData(articleRows, resolve);
        });
    }

    function loadData(articleRows, dataCallback = () => {}) {

        const rowData = {};

        // 1. Separate rows that are cached vs. need fetch
        const fetchNeeded = [];
        for (const row of articleRows) {
            const link = row.querySelector('a[href*="/en/Magic/Products/"]');
            if (!link) {
                continue; // no link → skip entirely
            }
            const foilQuery = getFoilState(row);
            const productUrl = buildProductUrl(link.href, [extraQuery, foilQuery]);

            // 2. Try local cache
            const cachedData = checkLocalCache([productUrl, cacheDataVersion]);
            if (cachedData) {
                // Process immediately, no delay
                try {
                    const prices = processProductPage(cachedData, row);
                    rowData[productUrl] = prices;
                } catch (err) {
                    logError(`Error processing cached data for "${link.textContent.trim()}"`, err);
                }
            } else {
                // We'll need to queue this for an actual fetch
                fetchNeeded.push(row);
            }
        }

        // 3. Now only process fetchNeeded with the normal delayed queue
        if (fetchNeeded.length > 0) {
            startProcessing(fetchNeeded);
            processQueue(fetchNeeded, (data) => dataCallback({...data, ...rowData}));
        } else {
            GM_log('All items satisfied via cache. Nothing left to fetch.');
            dataCallback(rowData);
        }
    }

    function processQueue(queue, finishCallback, progressData = {}) {
        if(queue.length === 0) {
            if(finishCallback) {
                finishCallback(progressData);
            }
        }

        if (queue.length === 0 || cancelRequested) {
            return finishProcessing();
        }

        const row = queue.shift();
        const link = row.querySelector('a[href*="/en/Magic/Products/"]');
        if (!link) {
            // If no link, skip the row and proceed to next
            return skipRow(queue, finishCallback, progressData);
        }

        const foilQuery = getFoilState(row);
        const productUrl = buildProductUrl(link.href, [extraQuery, foilQuery]);
        const productName = link.textContent.trim() || "Unknown Product Name";

        fetchProductData(productUrl)
            .then(data => handlePageFetchSuccess(data, row, queue, productName, productUrl, progressData))
            .catch(err => handlePageFetchError(err, queue, productName, productUrl))
            .finally(() => continueProcessing(queue, finishCallback, progressData));
    }

    function continueProcessing(queue, finishCallback, progressData) {
        if (!cancelRequested) {
            // Add a delay before the next fetch
            setTimeout(() => {
                processQueue(queue, finishCallback, progressData);
            }, requestDelay);
        } else {
            // If canceled in-between
            finishProcessing();
        }
    }

    function handlePageFetchSuccess(data, row, queue, productName, productUrl, progressData) {
        if (cancelRequested) return resetState();
        try {
            let prices = processProductPage(data, row);
            progressData[productUrl] = prices;
        } catch (e) {
            logError(`Error processing product page for "${productName}" (${productUrl}):`, e);
        }
    }

    function handlePageFetchError(err, queue, productName, productUrl) {
        if (cancelRequested) return resetState();
        if (err instanceof Error && /Non-200 response: 429/.test(err.message)) {
            // If we get a 429, back off by increasing requestDelay
            requestDelay += delayIncrementOn429;
            // Reinsert this item at the end of the queue to retry
            queue.push(queue.shift());
        } else {
            logError(`Error fetching product page for "${productName}" (${productUrl}):`, err);
            // Skip it completely
            queue.shift();
        }
    }

    function processPrices(data, row) {
        // Attempt to read the row’s quantity from the <select> (default=1 if none)
        let quantity = 1; // fallback

        if(isCartPage()) {

            const qtySelect = row.querySelector('select');
            if (qtySelect && !isNaN(parseInt(qtySelect.value))) {
                quantity = parseInt(qtySelect.value, 10);
            }
        }

        const averagePrice = parsePrice(data.averagePriceText) * quantity;
        const trendPrice   = parsePrice(data.trendPriceText)   * quantity;

        // The seller’s displayed price for a single item:
        let priceElement;
        if(isCartPage()) {
            priceElement =  row.querySelector('td.price');
        } else {
            const potentialPriceElements = [...row.querySelectorAll('.price-container span')]; // [...] converts to array
            priceElement = potentialPriceElements.find(span => span.textContent.includes('€'));
        }

        const singleSellerPrice = parsePrice(priceElement?.textContent.trim() || 'N/A');

        const sellerPrice = isNaN(singleSellerPrice)
            ? NaN
            : singleSellerPrice * quantity;

        return {
            averagePrice,
            averagePriceText: data.averagePriceText,
            trendPrice,
            trendPriceText: data.trendPriceText,
            sellerPrice,
            quantity, // optional, if you ever want to reference it later
        };
    }

    function processProductPage(data, row) {

        var prices = processPrices(data, row);

        displayResults(row,
            prices.averagePrice,
            prices.trendPrice,
            prices.sellerPrice,
            prices.averagePriceText,
            prices.trendPriceText,
            data.chartWrapperHTML);

        return prices;
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

        let chartWrapperHTML = '';

        // Extracting chart-wrapper as HTML
        const chartWrapper = doc.querySelector('#tabContent-info .chart-wrapper');
        if (chartWrapper) {
            chartWrapperHTML = chartWrapper.outerHTML; // Get the full HTML as a string
        }

        return { averagePriceText, trendPriceText, chartWrapperHTML };
    }

    function createElementFromHTML(htmlString) {
        const template = document.createElement('template');
        template.innerHTML = htmlString.trim(); // Trim to remove excess whitespace
        return template.content.firstElementChild; // Return the first element from the template
    }

    function displayResults(row, averagePrice, trendPrice, sellerPrice, averagePriceText, trendPriceText, chartWrapperHTML) {
        // const infoColumn = row.querySelector('.col-sellerProductInfo');
        // if (!infoColumn) return;

        let productName = 'chart';
        const isFoil = getFoilBool(row);
        if(isCartPage()) {
            const sellerName = findParentBySelector(row, '.card-body').querySelector('.seller-info a[href*="/en/Magic/Users/"]').textContent.trim() ?? '';
            productName = sellerName + ' - ' + row.querySelector('a[href*="/en/Magic/Products/"]').textContent.trim();
        } else {
            productName = row.querySelector('a[href*="/en/Magic/Products/"]').textContent.trim();
        }
        
        const name = productName + (isFoil ? ' ⭐' : '');

        const lineContainer = row.querySelector('.line-container');
        if (lineContainer) {
            // Clear out any old results in the lineContainer (but keep the fetch button)
            clearOldResults(lineContainer);
        }
        //create inner div
        const innerLiner = createInnerLiner(isCartPage());

        // Insert new results
        innerLiner.appendChild(createResultContainer('30-day', averagePriceText, averagePrice / sellerPrice));
        innerLiner.appendChild(createResultContainer('Trend', trendPriceText, trendPrice / sellerPrice));
        lineContainer.appendChild(innerLiner);

        if(unsafeWindow.attachDraggableBoxIcon)
        {
            // 📈 chart icon button
            let chartIcon = createButton('📈', 'btn btn-sm', { marginLeft: '5px' })
            lineContainer.appendChild(chartIcon);

            var chart = createElementFromHTML(chartWrapperHTML);

            unsafeWindow.attachDraggableBoxIcon(chartIcon, chart, name);
        }

    }

    function createResultContainer(label, priceText, difference) {
        const container = createContainer();
        const diffSign = difference > 1 ? '-' : difference < 1 ? '+' : '';
        const diffValue = `${Math.abs(difference).toFixed(2)} x`;

        container.appendChild(document.createTextNode(`${label}: ${priceText} | Diff: `));
        container.appendChild(createDiffSpan(diffSign, diffValue));

        return container;
    }

    // Utility functions

    function createContainer() {
        const container = document.createElement('div');
        container.style.display = 'inline-block';
        container.style.fontSize = 'small';
        container.style.color = '#666';
        container.style.whiteSpace = 'nowrap';
        container.style.alignContent = 'center';
        container.style.marginLeft = '5px';
        container.style.marginRight = '5px';
        return container;
    }

    function createLineContainer(cart) {
        const lineContainer = document.createElement('div');
        lineContainer.className = 'line-container';
        if(!cart)
            lineContainer.style.borderRight = '1px solid #dee2e6';
        lineContainer.style.display = 'inline-flex';
        lineContainer.style.alignItems = 'center';
        lineContainer.style.paddingRight = '5px';


        return lineContainer;
    }

    function createInnerLiner(cart) {
        const lineContainer = document.createElement('div');
        lineContainer.style.display = 'inline-flex';
        lineContainer.style.alignItems = 'center';
        lineContainer.style.paddingRight = '5px';
        if(!!cart)
            lineContainer.style.flexWrap = 'wrap';
        return lineContainer;
    }

    function createButton(text, className, styles = {}) {
        const button = document.createElement('button');
        button.textContent = text;
        button.className = className;
        Object.assign(button.style, styles);
        return button;
    }

    function buildProductUrl(baseUrl, queries) {
        GM_log('BaseUrl:', baseUrl);
        GM_log('Building URL with queries:', queries);

        // Create a URL object to easily manage query parameters
        const url = new URL(baseUrl);

        // Iterate over each query (e.g., "foo=bar")
        for (const query of queries) {
            if (!query) continue;
            // Each query is key=value
            const [key, value] = query.split('=');

            // Remove any existing param with the same key
            url.searchParams.delete(key);

            // Append the new/updated key-value pair
            url.searchParams.append(key, value);
        }

        const finishedUrl = url.toString();
        GM_log('Finished URL:', finishedUrl);
        return finishedUrl;
    }

    function parseHtml(responseText) {
        GM_log('Parsing HTML response:', responseText);
        const parser = new DOMParser();
        return parser.parseFromString(responseText, 'text/html');
    }

    function parsePrices(averagePriceText, trendPriceText) {
        const averagePrice = parsePrice(averagePriceText);
        const trendPrice = parsePrice(trendPriceText);
        return { averagePrice, trendPrice };
    }

    function logError(message, error) {
        GM_log(`[Error] ${message}`);
        if (error) {
            GM_log(`Message: ${error.message}`);
            if (error.stack) GM_log(`Stack: ${error.stack}`);
        }
    }

    function disableButton(button, text) {
        button.disabled = true;
        button.textContent = text;
    }

    function enableButton(button, text) {
        button.disabled = false;
        button.textContent = text;
    }

    function parsePrice(priceText) {
        if (!priceText || priceText === 'N/A') return NaN;
        let clean = priceText.replace(' €', '').trim(); // Remove euro symbol
        clean = clean.replace(',', '.');
        return parseFloat(clean);
    }

    function startProcessing(fetchRows) {
        isProcessing = true;
        cancelRequested = false;
        enableButton(mainButton, 'Cancel');

        for(const row of fetchRows) {
            //find fetch btn
            const fetchBtn = row.querySelector('.line-fetch-button');

            if(fetchBtn) {
                disableButton(fetchBtn, '...');
            }
        }


        GM_log('Processing started...');
    }

    function getFoilState(row) {
        return getFoilBool(row) ? 'isFoil=Y' : 'isFoil=N';
    }

    function getFoilBool(row) {
        return !!row.querySelector('span.icon[aria-label="Foil"]');
    }

    /**
     * Creates a <span> element showing the +/- difference value.
     * Example usage: container.appendChild(createDiffSpan('+', '1.05x'));
     */
    function createDiffSpan(diffSign, diffValue) {
        const span = document.createElement('span');
        span.textContent = diffValue;
        // Simple color-coding
        if (diffSign === '-') {
            span.style.color = 'green';
        } else if (diffSign === '+') {
            span.style.color = 'red';
        } else {
            span.style.color = 'gray';
        }
        return span;
    }

    /**
     * Clears old results from the lineContainer but keeps the fetch button if present.
     */
    function clearOldResults(lineContainer) {
        const fetchBtn = lineContainer.querySelector('.line-fetch-button');
        lineContainer.innerHTML = '';
        if (fetchBtn) {
            // Re-append the fetch button
            lineContainer.appendChild(fetchBtn);
        }
    }

    /**
     * Resets variables and re-enables the mainButton to its default state.
     */
    function resetState() {
        isProcessing = false;
        requestDelay = 1000;
        enableButton(mainButton, '💲 All');

        //find all line fetch buttons and re-enable them
        const fetchBtns = document.querySelectorAll('.line-fetch-button');
        for(const btn of fetchBtns) {
            enableButton(btn, '💲')
        };

        GM_log('State reset.');
    }

    /**
     * If there's no link in a row, skip it and move on to the next.
     */
    function skipRow(queue, finishCallback, progressData) {
        queue.shift();
        processQueue(queue, finishCallback, progressData);
    }

    /**
     * Called when we’re done (queue is empty) or if canceled.
     */
    function finishProcessing() {
        GM_log('Processing finished or canceled.');
        resetState(); // finalize
    }

    /**
     * Trigger a cancellation in the middle of processing.
     */
    function requestCancellation() {
        cancelRequested = true;
        GM_log('Cancellation requested...');
        disableButton(mainButton, 'Cancelling...');
    }

    function collectionHas(a, b) { //helper function (see below)
        for(var i = 0, len = a.length; i < len; i ++) {
            if(a[i] == b) return true;
        }
        return false;
    }
    function findParentBySelector(elm, selector) {
        var all = document.querySelectorAll(selector);
        var cur = elm.parentNode;
        while(cur && !collectionHas(all, cur)) { //keep going up until you find a match
            cur = cur.parentNode; //go up
        }
        return cur; //will return null if not found
    }

    // /**
    //  * Retrieve data from a cache or use a callback to fetch it.
    //  *
    //  * @param {string[]} keyParts       - Parts of the compound key (e.g. ["url", "foil"]).
    //  * @param {number}   expirationMs   - How long to keep the cache (in milliseconds).
    //  * @param {Function} fetchCallback  - Asynchronous function returning fresh data if cache is expired or missing.
    //  *
    //  * @returns {Promise<any>}          - The requested data.
    //  */
    // async function getCachedData(keyParts, expirationMs, fetchCallback) {
    //     const storageKey = keyParts.join('|');

    //     const cachedString = GM_getValue(storageKey, null);

    //     if (cachedString) {
    //         try {
    //             const cachedObj = JSON.parse(cachedString);
    //             const { timestamp, data } = cachedObj;

    //             // Check if still valid
    //             if (Date.now() - timestamp < expirationMs) {
    //                 console.log(`[cache] Returning cached data for key: ${storageKey}`);
    //                 return data;
    //             }
    //         } catch (err) {
    //             console.warn(`Failed to parse cached data for key: ${storageKey}`, err);
    //         }
    //     }

    //     // Cache miss or expired – fetch fresh data
    //     const freshData = await fetchCallback();

    //     GM_setValue(
    //         storageKey,
    //         JSON.stringify({
    //             timestamp: Date.now(),
    //             data: freshData
    //         })
    //     );

    //     console.log(`[cache] Fetched and stored fresh data for key: ${storageKey}`);
    //     return freshData;
    // }

    /**
     * Retrieve data from localStorage or use a callback to fetch it.
     *
     * @param {string[]} keyParts       - Parts of the compound key (e.g. ["user", "details"]).
     * @param {number}   expirationMs   - How long to keep the cache (in milliseconds).
     * @param {Function} fetchCallback  - Asynchronous function returning fresh data if cache is expired or missing.
     *
     * @returns {Promise<any>}          - The requested data.
     */
    async function getCachedData(keyParts, expirationMs, fetchCallback) {
        // Construct a single string key (e.g. "user_details" or "user|details")
        const storageKey = keyParts.join('|');

        // Retrieve existing cache entry from localStorage
        const cachedString = localStorage.getItem(storageKey);

        if (cachedString) {
            try {
                const cachedObj = JSON.parse(cachedString);
                const { timestamp, data } = cachedObj;

                // Check if still valid
                if (Date.now() - timestamp < expirationMs) {
                    // Still within the expiration period
                    console.log(`[cache] Returning cached data for key: ${storageKey}`);
                    return data;
                }
            } catch (err) {
                console.warn(`Failed to parse cached data for key: ${storageKey}`, err);
            }
        }

        // Cache miss or expired – fetch fresh data
        const freshData = await fetchCallback();

        // Store new data along with timestamp in localStorage
        localStorage.setItem(
            storageKey,
            JSON.stringify({
                timestamp: Date.now(),
                data: freshData
            })
        );

        console.log(`[cache] Fetched and stored fresh data for key: ${storageKey}`);
        return freshData;
    }

    /**
     * Fetch or retrieve from cache the relevant product price data.
     *
     * @param {string} productUrl - The URL for the product page.
     * @returns {Promise<{ averagePriceText: string, trendPriceText: string }>}
     */
    function fetchProductData(productUrl) {

        return getCachedData(
            [productUrl, cacheDataVersion],
            CACHE_EXPIRATION_MS,
            async () => {

                // 1. Actually fetch the page
                const doc = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: productUrl,
                        onload: response => {
                            if (response.status === 200) {
                                const parser = new DOMParser();
                                resolve(parser.parseFromString(response.responseText, 'text/html'));
                            } else {
                                reject(new Error(`Non-200 response: ${response.status}`));
                            }
                        },
                        onerror: reject
                    });
                });

                // 2. Extract the data we really want:
                const data = extractPageData(doc);

                // 3. Return only the data we need to store
                return data;
            }
        );
    }

    /**
     * Check localStorage for data by keyParts without fetching from the network.
     * Returns the cached data if valid and not expired, otherwise null.
     */
    function checkLocalCache(keyParts) {
        const storageKey = keyParts.join('|');
        const cachedString = localStorage.getItem(storageKey);

        if (!cachedString) {
            return null;
        }
        try {
            const cachedObj = JSON.parse(cachedString);
            const { timestamp, data } = cachedObj;
            if (Date.now() - timestamp < CACHE_EXPIRATION_MS) {
                // Not expired
                return data;
            }
        } catch (err) {
            console.warn(`Failed to parse cached data for key: ${storageKey}`, err);
        }

        // Expired or invalid
        return null;
    }

})();
