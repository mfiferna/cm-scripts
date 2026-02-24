(function (global) {
    'use strict';

    const app = global.CMCleanroom;

    app.initializeOffersPage = async function initializeOffersPage() {
        app.state.requestQueue = new app.RequestQueue();
        app.injectMainToolbar('offers');
        await app.hydrateRowsFromCache('offers');
        const warmPromise = app.warmPriceGuide();
        await app.runHydrationPasses('offers');
        await warmPromise;
        await app.hydrateRowsFromCache('offers');
    };

    app.initializeCartPage = async function initializeCartPage() {
        app.state.requestQueue = new app.RequestQueue();
        app.injectMainToolbar('cart');
        await app.hydrateRowsFromCache('cart');
        const warmPromise = app.warmPriceGuide();
        await app.runHydrationPasses('cart');
        await warmPromise;
        await app.hydrateRowsFromCache('cart');
    };

    app.initializeProductPageCache = async function initializeProductPageCache() {
        await app.warmPriceGuide();
        const productRoot = document.querySelector('main') || document.body;
        const idProduct = app.extractProductId(productRoot) || Number(new URL(location.href).searchParams.get('idProduct'));
        if (!Number.isFinite(idProduct) || idProduct <= 0) return;
        const foilKey = app.detectFoil(document.body) ? 'Y' : 'N';
        const data = app.scrapeProductPageData(document);
        await app.saveVariantData(idProduct, foilKey, data);
        const lookup = app.state.priceGuideLookup?.get(idProduct);
        if (lookup) await app.updateProductPriceGuideFromLookup(idProduct, lookup);
    };

    app.initialize = async function initialize() {
        await app.cleanupExpiredCache();
        if (app.isOffersPage()) {
            await app.initializeOffersPage();
            return;
        }
        if (app.isCartPage()) {
            await app.initializeCartPage();
            return;
        }
        if (app.isProductPage()) {
            await app.initializeProductPageCache();
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        void app.initialize();
    });
})(globalThis);
