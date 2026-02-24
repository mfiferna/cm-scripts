// ==UserScript==
// @name         Cardmarket Cleanroom
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Clean-room Cardmarket enhancer with fast ratio hydration, iframe fetch queue, and chart overlays.
// @author       mfiferna
// @homepage     https://github.com/mfiferna/cm-scripts
// @supportURL   https://github.com/mfiferna/cm-scripts/issues
// @match        https://www.cardmarket.com/en/Magic/Users/*/Offers/*
// @match        https://www.cardmarket.com/en/Magic/ShoppingCart
// @match        https://www.cardmarket.com/en/Magic/Products/Singles/*/*
// @grant        GM_log
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      downloads.s3.cardmarket.com
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/idb@8/build/umd.js
// @require      https://cdn.jsdelivr.net/gh/mfiferna/cm-scripts@rework/cleanroom/00_shared.js
// @require      https://cdn.jsdelivr.net/gh/mfiferna/cm-scripts@rework/cleanroom/10_storage.js
// @require      https://cdn.jsdelivr.net/gh/mfiferna/cm-scripts@rework/cleanroom/20_price_guide.js
// @require      https://cdn.jsdelivr.net/gh/mfiferna/cm-scripts@rework/cleanroom/30_queue_iframe.js
// @require      https://cdn.jsdelivr.net/gh/mfiferna/cm-scripts@rework/cleanroom/40_ui.js
// @require      https://cdn.jsdelivr.net/gh/mfiferna/cm-scripts@rework/cleanroom/50_pages_bootstrap.js
// ==/UserScript==

(function () {
    'use strict';
})();
