(function (global) {
    'use strict';

    const app = global.CMCleanroom;

    app.createError = function createError(code, message) {
        const error = new Error(message || code);
        error.code = code;
        return error;
    };

    app.challengeDetected = function challengeDetected(doc) {
        if (!doc) return false;
        const hay = `${doc.title || ''}\n${doc.body?.textContent || ''}`.toLowerCase();
        if (app.CHALLENGE_TEXT_MARKERS.some((marker) => hay.includes(marker))) return true;
        return app.CHALLENGE_SELECTORS.some((selector) => !!doc.querySelector(selector));
    };

    app.abortOtherIframeRequests = function abortOtherIframeRequests() {
        for (const controller of app.state.activeIframeControllers) {
            if (!controller.__keepAlive) controller.abort(app.createError('CLOUDFLARE_ABORTED', 'Aborted due to Cloudflare gate'));
        }
    };

    app.openCloudflareGate = async function openCloudflareGate(iframe, timeoutMinutes) {
        if (app.state.cloudflareGate?.active) return app.state.cloudflareGate.promise;
        app.abortOtherIframeRequests();
        Object.assign(iframe.style, { position: 'relative', width: '100%', height: '100%', opacity: '1', pointerEvents: 'auto', border: '0' });
        const overlay = app.el('div',
            { style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.65)', zIndex: '2147483646', display: 'flex', flexDirection: 'column', padding: '10px' } },
            app.el('div', { textContent: 'Cloudflare challenge detected. Please complete verification to resume queue.', style: { color: '#fff', fontWeight: '600', marginBottom: '8px' } }),
            iframe
        );
        document.body.appendChild(overlay);
        const timeoutAt = Date.now() + timeoutMinutes * 60 * 1000;

        const promise = (async () => {
            while (Date.now() < timeoutAt) {
                const doc = iframe.contentDocument;
                if (doc && !app.challengeDetected(doc)) {
                    overlay.remove();
                    app.state.cloudflareGate = null;
                    return;
                }
                await app.sleep(app.IFRAME_MANUAL_POLL_MS);
            }
            overlay.remove();
            app.state.cloudflareGate = null;
            throw app.createError('CLOUDFLARE_ACTIVE', 'Manual Cloudflare timeout');
        })();

        app.state.cloudflareGate = { active: true, promise };
        return promise;
    };

    app.waitForIframeLoad = function waitForIframeLoad(iframe, timeoutMs, signal) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(app.createError('IFRAME_LOAD_TIMEOUT'));
            }, timeoutMs);
            const onLoad = () => {
                cleanup();
                resolve();
            };
            const onAbort = () => {
                cleanup();
                reject(signal.reason || app.createError('CLOUDFLARE_ABORTED'));
            };
            function cleanup() {
                clearTimeout(timer);
                iframe.removeEventListener('load', onLoad);
                signal.removeEventListener('abort', onAbort);
            }
            iframe.addEventListener('load', onLoad, { once: true });
            signal.addEventListener('abort', onAbort, { once: true });
        });
    };

    app.scrapeProductPageData = function scrapeProductPageData(doc) {
        const dts = [...doc.querySelectorAll('dt.col-6.col-xl-5')];
        const findValue = (label) => {
            const dt = dts.find((x) => (x.textContent || '').trim().toLowerCase() === label.toLowerCase());
            return dt?.nextElementSibling?.querySelector('span')?.textContent?.trim() || 'N/A';
        };
        const averagePriceText = findValue('30-days average price');
        const trendPriceText = findValue('Price Trend');
        const chartWrapperHTML = doc.querySelector('#tabContent-info .chart-wrapper')?.outerHTML || '';
        return { averagePriceText, trendPriceText, chartWrapperHTML };
    };

    app.pollIframeData = async function pollIframeData(iframe, timeoutMs, signal) {
        const timeoutAt = Date.now() + timeoutMs;
        while (Date.now() < timeoutAt) {
            if (signal.aborted) throw signal.reason || app.createError('CLOUDFLARE_ABORTED');
            const doc = iframe.contentDocument;
            if (doc) {
                if (app.challengeDetected(doc)) throw app.createError('CLOUDFLARE_ACTIVE', 'Cloudflare challenge');
                const data = app.scrapeProductPageData(doc);
                const hasPrice = data.averagePriceText !== 'N/A' || data.trendPriceText !== 'N/A';
                if (hasPrice || data.chartWrapperHTML) return data;
            }
            await app.sleep(app.IFRAME_READY_INTERVAL_MS);
        }
        throw app.createError('IFRAME_DATA_UNAVAILABLE');
    };

    app.fetchProductPageViaIframe = async function fetchProductPageViaIframe(url, settings) {
        if (app.state.cloudflareGate?.active) throw app.createError('CLOUDFLARE_ACTIVE');
        const iframe = document.createElement('iframe');
        Object.assign(iframe.style, {
            position: 'fixed', left: '-10000px', top: '0', width: '1280px', height: '900px',
            opacity: '0', pointerEvents: 'none', zIndex: '2147483645'
        });
        document.body.appendChild(iframe);

        const controller = new AbortController();
        app.state.activeIframeControllers.add(controller);
        try {
            iframe.src = url;
            await app.waitForIframeLoad(iframe, settings.iframeLoadTimeoutMs, controller.signal);
            const doc = iframe.contentDocument;
            if (app.challengeDetected(doc)) {
                controller.__keepAlive = true;
                await app.openCloudflareGate(iframe, settings.iframeManualTimeoutMinutes);
                if (!iframe.isConnected) document.body.appendChild(iframe);
                iframe.style.left = '-10000px';
                iframe.style.opacity = '0';
                iframe.style.pointerEvents = 'none';
                return await app.pollIframeData(iframe, settings.iframeReadyTimeoutMs, controller.signal);
            }
            const data = await app.pollIframeData(iframe, settings.iframeReadyTimeoutMs, controller.signal);
            if (data?.averagePriceText?.includes('429') || data?.trendPriceText?.includes('429')) {
                throw app.createError('HTTP_429', 'Rate limited');
            }
            return data;
        } finally {
            app.state.activeIframeControllers.delete(controller);
            if (iframe.isConnected) iframe.remove();
        }
    };

    app.RequestQueue = class RequestQueue {
        constructor() {
            this.queue = [];
            this.running = false;
            this.active = 0;
            this.canceled = false;
            this.settings = app.state.settings;
        }

        updateSettings(next) {
            this.settings = next;
        }

        cancelAll() {
            this.canceled = true;
            this.queue.length = 0;
        }

        enqueue(job) {
            return new Promise((resolve, reject) => {
                this.queue.push({ ...job, resolve, reject, attempts: 0 });
                if (!this.running) void this.run();
            });
        }

        async run() {
            this.running = true;
            this.canceled = false;
            while (!this.canceled && this.queue.length) {
                if (this.settings.queueMode === 'fixed_delay') {
                    const maxInFlight = this.settings.maxInFlightRequests;
                    if (maxInFlight > 0 && this.active >= maxInFlight) {
                        await app.sleep(25);
                        continue;
                    }
                    const next = this.queue.shift();
                    if (!next) continue;
                    this.active += 1;
                    void this.runOne(next).finally(() => {
                        this.active -= 1;
                    });
                    await app.sleep(app.randomizeDelay(this.settings.requestDelayMs));
                    continue;
                }
                const next = this.queue.shift();
                if (!next) continue;
                await this.runOne(next);
                await app.sleep(app.randomizeDelay(this.settings.requestDelayMs));
            }
            while (this.active > 0) await app.sleep(30);
            this.running = false;
            this.canceled = false;
        }

        async runOne(item) {
            if (this.canceled) {
                item.reject(new Error('Canceled'));
                return;
            }
            try {
                const pageData = await app.fetchProductPageViaIframe(item.url, this.settings);
                item.resolve({ timestamp: Date.now(), hasGraph: !!pageData.chartWrapperHTML, pageData });
            } catch (error) {
                const code = String(error?.code || error?.message || '');
                if (code === 'HTTP_429') {
                    this.settings.requestDelayMs = app.clamp(this.settings.requestDelayMs + this.settings.delayIncrementOn429Ms, 100, 20000);
                }
                if (app.RETRYABLE_CODES.has(code) && item.attempts < 3 && !this.canceled) {
                    item.attempts += 1;
                    this.queue.push(item);
                    return;
                }
                item.reject(error);
            }
        }
    };
})(globalThis);
