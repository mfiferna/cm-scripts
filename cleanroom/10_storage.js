(function (global) {
    'use strict';

    const app = global.CMCleanroom;

    app.getDb = function getDb() {
        if (!app.state.dbPromise) {
            app.state.dbPromise = idb.openDB(app.DB_NAME, app.DB_VERSION, {
                upgrade(database, _old, _new, txn) {
                    const productStore = database.objectStoreNames.contains(app.STORE_PRODUCTS)
                        ? txn.objectStore(app.STORE_PRODUCTS)
                        : database.createObjectStore(app.STORE_PRODUCTS, { keyPath: 'idProduct' });

                    for (const [name, keyPath] of [
                        ['updatedAt', 'updatedAt'],
                        ['priceGuideFetchedAt', 'priceGuide.fetchedAt'],
                        ['hasGraphNonFoil', 'variants.N.hasGraph'],
                        ['hasGraphFoil', 'variants.Y.hasGraph']
                    ]) {
                        if (!productStore.indexNames.contains(name)) productStore.createIndex(name, keyPath, { unique: false });
                    }

                    if (!database.objectStoreNames.contains(app.STORE_META)) {
                        database.createObjectStore(app.STORE_META, { keyPath: 'key' });
                    }
                }
            });
        }
        return app.state.dbPromise;
    };

    app.getMeta = async (key) => (await app.getDb()).get(app.STORE_META, key);
    app.putMeta = async (value) => (await app.getDb()).put(app.STORE_META, value);
    app.getProduct = async (idProduct) => (await app.getDb()).get(app.STORE_PRODUCTS, idProduct);
    app.putProduct = async (record) => (await app.getDb()).put(app.STORE_PRODUCTS, record);

    app.iterateProducts = async function iterateProducts(visitor) {
        const db = await app.getDb();
        const txn = db.transaction(app.STORE_PRODUCTS, 'readwrite');
        let cursor = await txn.store.openCursor();
        while (cursor) {
            visitor(cursor);
            cursor = await cursor.continue();
        }
        await txn.done;
    };

    app.cleanupExpiredCache = async function cleanupExpiredCache() {
        const ttlMs = app.clamp(app.state.settings.cacheExpirationHours, 1, 720) * 60 * 60 * 1000;
        const now = Date.now();
        await app.iterateProducts((cursor) => {
            const record = cursor.value;
            let changed = false;
            if (record.variants?.N?.timestamp && now - record.variants.N.timestamp > ttlMs) {
                delete record.variants.N;
                changed = true;
            }
            if (record.variants?.Y?.timestamp && now - record.variants.Y.timestamp > ttlMs) {
                delete record.variants.Y;
                changed = true;
            }
            if (record.priceGuide?.fetchedAt && now - record.priceGuide.fetchedAt > ttlMs) {
                record.priceGuide = null;
                changed = true;
            }
            const hasVariant = !!(record.variants?.N || record.variants?.Y);
            const hasGuide = !!record.priceGuide;
            if (!hasVariant && !hasGuide) {
                cursor.delete();
                return;
            }
            if (changed) {
                record.updatedAt = now;
                cursor.update(record);
            }
        });
    };

    app.clearAllData = async function clearAllData() {
        const db = await app.getDb();
        await Promise.all([db.clear(app.STORE_PRODUCTS), db.clear(app.STORE_META)]);
    };

    app.getCachedVariantData = async function getCachedVariantData(idProduct, foilKey) {
        const record = await app.getProduct(idProduct);
        return record?.variants?.[foilKey] || null;
    };

    app.saveVariantData = async function saveVariantData(idProduct, foilKey, pageData) {
        const now = Date.now();
        const existing = (await app.getProduct(idProduct)) || { idProduct, updatedAt: now, priceGuide: null, variants: {} };
        existing.updatedAt = now;
        existing.variants = existing.variants || {};
        existing.variants[foilKey] = {
            timestamp: now,
            hasGraph: !!pageData?.chartWrapperHTML,
            pageData
        };
        await app.putProduct(existing);
    };

    app.updateProductPriceGuideFromLookup = async function updateProductPriceGuideFromLookup(idProduct, lookupEntry) {
        if (!lookupEntry) return;
        const now = Date.now();
        const existing = (await app.getProduct(idProduct)) || { idProduct, updatedAt: now, priceGuide: null, variants: {} };
        existing.updatedAt = now;
        existing.priceGuide = {
            cacheVersion: app.PRICE_GUIDE_CACHE_VERSION,
            fetchedAt: now,
            values: lookupEntry
        };
        await app.putProduct(existing);
    };
})(globalThis);
