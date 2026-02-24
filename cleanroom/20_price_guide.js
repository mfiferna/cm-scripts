(function (global) {
    'use strict';

    const app = global.CMCleanroom;

    app.normalizeNumber = function normalizeNumber(value) {
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    };

    app.compactPriceGuideEntry = function compactPriceGuideEntry(raw) {
        return [
            Number(raw.idProduct),
            app.normalizeNumber(raw.avg),
            app.normalizeNumber(raw.avg30),
            app.normalizeNumber(raw.trend),
            app.normalizeNumber(raw['avg-foil']),
            app.normalizeNumber(raw['avg30-foil']),
            app.normalizeNumber(raw['trend-foil'])
        ];
    };

    app.compactArrayToLookupEntry = function compactArrayToLookupEntry(compact) {
        return {
            avg: compact[1],
            avg30: compact[2],
            trend: compact[3],
            avgFoil: compact[4],
            avg30Foil: compact[5],
            trendFoil: compact[6]
        };
    };

    app.updatePriceGuideBadge = function updatePriceGuideBadge(text) {
        for (const badge of app.state.priceGuideBadges) badge.textContent = text;
    };

    app.loadCachedPriceGuideLookup = async function loadCachedPriceGuideLookup() {
        const [lookupMeta, guideMeta] = await Promise.all([
            app.getMeta(app.PRICE_GUIDE_LOOKUP_META_KEY),
            app.getMeta(app.PRICE_GUIDE_META_KEY)
        ]);
        if (!lookupMeta?.value?.entries?.length) return null;
        const map = new Map();
        for (const compact of lookupMeta.value.entries) {
            if (!Array.isArray(compact) || compact.length < 7) continue;
            const idProduct = Number(compact[0]);
            if (!Number.isFinite(idProduct)) continue;
            map.set(idProduct, app.compactArrayToLookupEntry(compact));
        }
        app.state.priceGuideLoaded = true;
        app.updatePriceGuideBadge(`guide: cache (${map.size})`);
        if (guideMeta?.fetchedAt) app.gmLog(`cached guide age ${(Date.now() - guideMeta.fetchedAt) / 1000 | 0}s`);
        return map;
    };

    app.fetchPriceGuideJson = async function fetchPriceGuideJson() {
        try {
            const res = await fetch(app.PRICE_GUIDE_URL, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (error) {
            if (typeof GM_xmlhttpRequest !== 'function') throw error;
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: app.PRICE_GUIDE_URL,
                    headers: { 'Cache-Control': 'no-cache' },
                    onload: (resp) => {
                        try {
                            if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
                            resolve(JSON.parse(resp.responseText));
                        } catch (parseError) {
                            reject(parseError);
                        }
                    },
                    onerror: reject,
                    ontimeout: () => reject(new Error('Price guide timeout'))
                });
            });
        }
    };

    app.hydrateProductGuideCache = async function hydrateProductGuideCache(entries, fetchedAt) {
        const db = await app.getDb();
        const chunkSize = 1200;
        for (let i = 0; i < entries.length; i += chunkSize) {
            const txn = db.transaction(app.STORE_PRODUCTS, 'readwrite');
            await Promise.all(entries.slice(i, i + chunkSize).map(async (compact) => {
                const idProduct = compact[0];
                if (!Number.isFinite(idProduct)) return;
                const existing = (await txn.store.get(idProduct)) || { idProduct, updatedAt: fetchedAt, priceGuide: null, variants: {} };
                existing.updatedAt = fetchedAt;
                existing.priceGuide = { cacheVersion: app.PRICE_GUIDE_CACHE_VERSION, fetchedAt, values: app.compactArrayToLookupEntry(compact) };
                await txn.store.put(existing);
            }));
            await txn.done;
        }
    };

    app.warmPriceGuide = async function warmPriceGuide() {
        if (app.state.priceGuideLoadingPromise) return app.state.priceGuideLoadingPromise;
        app.state.priceGuideLoadingPromise = (async () => {
            if (!app.state.priceGuideLookup) app.state.priceGuideLookup = await app.loadCachedPriceGuideLookup();
            app.updatePriceGuideBadge('guide: loading...');
            const fetchedAt = Date.now();
            const json = await app.fetchPriceGuideJson();
            const guides = Array.isArray(json?.priceGuides) ? json.priceGuides : [];
            const compactEntries = [];
            const map = new Map();
            for (const raw of guides) {
                const compact = app.compactPriceGuideEntry(raw);
                const idProduct = compact[0];
                if (!Number.isFinite(idProduct) || idProduct <= 0) continue;
                compactEntries.push(compact);
                map.set(idProduct, app.compactArrayToLookupEntry(compact));
            }
            await Promise.all([
                app.putMeta({ key: app.PRICE_GUIDE_META_KEY, fetchedAt }),
                app.putMeta({ key: app.PRICE_GUIDE_LOOKUP_META_KEY, value: { fetchedAt, entries: compactEntries } })
            ]);
            void app.hydrateProductGuideCache(compactEntries, fetchedAt);
            app.state.priceGuideLookup = map;
            app.state.priceGuideLoaded = true;
            app.updatePriceGuideBadge(`guide: ready (${map.size})`);
            return map;
        })().catch((error) => {
            app.updatePriceGuideBadge('guide: failed');
            app.gmLog(`price guide load failed: ${String(error?.message || error)}`);
            return app.state.priceGuideLookup || new Map();
        });
        return app.state.priceGuideLoadingPromise;
    };
})(globalThis);
