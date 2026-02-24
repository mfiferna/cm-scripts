# Feature Spec: `refactored_cardmarket.js`

> Analysis of the Tampermonkey/Greasemonkey userscript for Cardmarket (Magic: The Gathering).
> Purpose: serve as a reference for a future re-implementation.

---

## 1. Overview

`refactored_cardmarket.js` is a **browser userscript** (Tampermonkey / Greasemonkey) that augments the [Cardmarket](https://www.cardmarket.com) website for Magic: The Gathering card trading. It adds **price-comparison data, ratio indicators, and interactive price-history charts** directly into the existing Cardmarket UI.

### Target Pages

| Page Type | URL Pattern | Entry Point |
|---|---|---|
| **Seller Offers** | `https://www.cardmarket.com/en/Magic/Users/*/Offers/*` | `initializeOffersPage()` |
| **Shopping Cart** | `https://www.cardmarket.com/en/Magic/ShoppingCart` | `initializeCartPage()` |
| **Product Single** | `https://www.cardmarket.com/en/Magic/Products/Singles/*/*` | `initializeProductPageCache()` |

### Companion Script

Works alongside `draggable_box.js`, which provides a reusable `attachDraggableBoxIcon(iconElement, contentElement, title)` function for displaying chart content in draggable overlay boxes.

---

## 2. Data Sources

### 2.1 Price Guide JSON (Bulk Download)

- **URL**: `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json`
- **Fetched via**: `fetch()` with `{ cache: 'no-store' }`, with a fallback to `GM_xmlhttpRequest` (for cross-origin support)
- **Purpose**: Provides bulk pricing data for all products, enabling **instant ratio display** without loading individual product pages

#### Price Guide Schema

Each entry in the `priceGuides` array contains:

| Field | Type | Description |
|---|---|---|
| `idProduct` | integer | Unique product identifier |
| `idCategory` | integer | Product category |
| `avg` | number \| null | Average price (all-time) |
| `avg1` | number \| null | Average price (1-day) |
| `avg7` | number \| null | Average price (7-day) |
| `avg30` | number \| null | Average price (30-day) |
| `trend` | number \| null | Price trend |
| `low` | number \| null | Lowest price |
| `avg-foil` | number \| null | Average foil price |
| `avg1-foil` | number \| null | 1-day average foil price |
| `avg7-foil` | number \| null | 7-day average foil price |
| `avg30-foil` | number \| null | 30-day average foil price |
| `trend-foil` | number \| null | Foil price trend |
| `low-foil` | number \| null | Lowest foil price |

#### Price Guide Lookup Construction

The script builds an in-memory lookup keyed by `idProduct`:

```
lookup[idProduct] = {
    avg, avg30, trend,           // non-foil values
    avgFoil, avg30Foil, trendFoil // foil values
}
```

**Value selection priority** (for applying to rows):
- **Non-foil**: `avg30` → `avg`
- **Foil**: `avg30Foil` → `avgFoil` → `avg30` → `avg`
- **Trend non-foil**: `trend`
- **Trend foil**: `trendFoil` → `trend`

### 2.2 Individual Product Pages (Scraped via Hidden Iframes)

When a user requests detailed data (graphs, exact prices), the script loads individual product pages in hidden `<iframe>` elements and scrapes their DOM.

#### Scraped Data Points

| Data | Source Selector | Extraction Method |
|---|---|---|
| **30-day average price** | `dt.col-6.col-xl-5` where text = `"30-days average price"` | `dt.nextElementSibling.querySelector('span').textContent` |
| **Price trend** | `dt.col-6.col-xl-5` where text = `"Price Trend"` | `dt.nextElementSibling.querySelector('span').textContent` |
| **Chart HTML** | `#tabContent-info .chart-wrapper` | `.outerHTML` (full HTML including chart `<canvas>` and `<script>` tags) |

#### Extracted Data Shape

```js
{
    averagePriceText: string,    // e.g. "1.50 €" or "N/A"
    trendPriceText: string,      // e.g. "1.75 €" or "N/A"
    chartWrapperHTML: string     // Raw HTML string of the chart widget
}
```

### 2.3 Seller Listing Prices (Scraped from Current Page)

| Context | Source Selector | Notes |
|---|---|---|
| **Offers page** | `.price-container span` (first containing `€`) | Single seller price |
| **Cart page** | `td.price` | Per-row price in cart table |
| **Cart quantity** | `select` element within row | Defaults to `1` if not present |

### 2.4 Product ID Extraction

The script uses a multi-strategy approach to extract `idProduct` from DOM rows, in order of priority:

1. `row.dataset.cmProductId` (cached from previous extraction)
2. `row.dataset.idProduct` / `row.dataset.productId`
3. `row.getAttribute('data-id-product')` / `row.getAttribute('data-product-id')`
4. `link.dataset.idProduct` / `link.dataset.productId`
5. `input[name="idProduct"]` / `input[name="productId"]` within row
6. URL query params: `?idProduct=` or `?productId=`
7. Thumbnail tooltip (`data-bs-title` attribute) parsed for product image URL patterns
8. Link `href` parsed for product ID patterns
9. **Last resort**: scan all attributes of row/link/form elements for `product`-containing attribute names, then scan `row.innerHTML`

### 2.5 Foil Detection

- **Selector**: `span.icon[aria-label="Foil"]` within the row
- **Returns**: boolean; serialized as URL query parameter `isFoil=Y` or `isFoil=N`

---

## 3. Caching Architecture

### 3.1 IndexedDB (Primary Cache)

- **Database name**: `cm-refactored-cache-db`
- **Database version**: `2`

#### Object Stores

| Store | Key Path | Purpose |
|---|---|---|
| `products` | `idProduct` | Per-product cache (scraped data + price guide data) |
| `meta` | `key` | Metadata (e.g., price guide fetch timestamp) |

#### Product Record Schema

```js
{
    idProduct: number,
    updatedAt: number,              // timestamp
    priceGuide: {
        cacheVersion: number,
        fetchedAt: number,          // timestamp
        values: {
            avg, avg30, trend,
            avgFoil, avg30Foil, trendFoil
        }
    } | null,
    variants: {
        "N": {                      // non-foil
            timestamp: number,
            hasGraph: boolean,
            pageData: {
                averagePriceText: string,
                trendPriceText: string,
                chartWrapperHTML: string
            }
        },
        "Y": { ... }               // foil (same shape)
    }
}
```

#### Indexes

| Index Name | Key Path | Purpose |
|---|---|---|
| `updatedAt` | `updatedAt` | Ordering by recency |
| `priceGuideFetchedAt` | `priceGuide.fetchedAt` | Price guide freshness |
| `hasGraphNonFoil` | `variants.N.hasGraph` | Filter products with graphs |
| `hasGraphFoil` | `variants.Y.hasGraph` | Filter foil products with graphs |

### 3.2 localStorage (Settings Only)

- **Key**: `cm-refactored-settings`
- **Format**: `{ version: 2, timestamp: number, data: { ...settings } }`

### 3.3 Cache Expiration

- **Default**: 24 hours (configurable via settings, range 1–720 hours)
- **Cleanup**: Runs on script initialization; iterates all product records and deletes expired variants or empty records
- **Clear all**: Available via Settings modal → "Clear Data" button

### 3.4 Product Page Auto-Caching

When a user naturally visits a **Product Singles** page, the script automatically extracts and caches the page data (prices + chart HTML) for future use, without requiring any user action.

---

## 4. Core Features

### 4.1 Initial Hydration

On page load, the script runs a **multi-pass hydration loop** to populate ratio data as quickly as possible:

1. **Immediately** applies any cached data from IndexedDB to visible rows
2. **Starts downloading** the price guide JSON in parallel
3. **Runs up to 10 passes** (every 600ms) to catch dynamically-rendered rows
4. **Stops early** once the price guide is loaded and data has been applied
5. Disables batch buttons during hydration to prevent conflicts

### 4.2 Price Ratio Display

For each product row, the script computes and displays:

| Metric | Formula | Display Format |
|---|---|---|
| **30-day average ratio** | `(avg30_price × quantity) / (seller_price × quantity)` | `"30-day: 1.50 € \| Diff: 1.25 x"` |
| **Trend ratio** | `(trend_price × quantity) / (seller_price × quantity)` | `"Trend: 1.75 € \| Diff: 0.95 x"` |

**Color coding**:
- Ratio > 1 (seller price below market): **green** with `-` prefix → good deal
- Ratio < 1 (seller price above market): **red** with `+` prefix → overpriced
- Ratio = 1: **gray**, no prefix

### 4.3 Batch Operations

#### "💲 All" Button
- Fetches data for **all** visible product rows
- Uses cached data first; queues remaining rows for iframe-based fetching
- Shows "Cancel" during processing

#### "💲 >= Nx" Button (Threshold Filter)
- Only processes rows where the **best ratio** (max of average ratio and trend ratio) meets or exceeds a configurable threshold (default: `1.00x`)
- Requires the price guide to be loaded first

### 4.4 Per-Line Fetch Buttons

Each product row gets a **"💲" button** for on-demand individual fetching, and a **"📈" button** for on-demand chart loading.

### 4.5 Chart Display

- Charts are loaded from the product page's `#tabContent-info .chart-wrapper` HTML
- The HTML includes a `<canvas>` element and `<script>` tags for Chart.js rendering
- **Canvas IDs are deduplicated** at display time to avoid conflicts when the same product appears multiple times
- Charts are displayed in **draggable overlay boxes** via the companion `draggable_box.js` script
- Chart boxes show on hover, toggle permanent visibility on click, and can be dragged by their header

### 4.6 Shopping Cart Totals

On the cart page, after fetching all product data, the script computes and displays:

| Metric | Scope | Display |
|---|---|---|
| **Estimated Value** | Per seller section | `"30-day: X.XX € \| Trend: Y.YY €"` |
| **Profit** | Per seller section | `"30-day: X.XX € \| Trend: Y.YY €"` (value − cart total) |
| **Est. Value** | Whole cart | Combined across all sellers |
| **Total Profit** | Whole cart | Combined value − combined cart total |

---

## 5. Iframe-Based Product Fetching

### 5.1 Mechanism

Instead of using `GM_xmlhttpRequest` (as in the old version), the refactored script loads product pages in **hidden `<iframe>` elements**. This approach:

- Avoids cross-origin restrictions that block `GM_xmlhttpRequest` on some setups
- Allows full DOM parsing including dynamically-rendered content (e.g., Chart.js charts)
- Enables Cloudflare challenge pass-through (since the iframe shares the user's session)

### 5.2 Iframe Lifecycle

```
1. Wait for Cloudflare gate (if active)
2. Create hidden iframe (off-screen, invisible)
3. Set iframe.src = productUrl
4. Wait for 'load' event (timeout: 15s default)
5. Poll iframe.contentDocument every 250ms for data readiness (timeout: 5s default)
6. If data found → resolve with extracted page data
7. If blocked (Cloudflare challenge) → enter manual unblock mode
8. Cleanup iframe on completion
```

### 5.3 Cloudflare Challenge Handling

When a Cloudflare challenge is detected (via text markers and DOM selectors), the script:

1. **Opens a "Cloudflare gate"** — pauses all other iframe requests
2. **Cancels in-flight iframe requests** (they will retry later)
3. **Shows a full-screen overlay** with the iframe made visible for user interaction
4. **Polls** the iframe for successful page load every 500ms
5. **Closes the gate** once the challenge is solved, resuming queued requests

**Cloudflare detection markers** (checked in title and body text):
- `just a moment`, `verify you are human`, `checking your browser`, `captcha`, `security check`, `access denied`, `attention required`, `cloudflare`, `ray id`, `please wait while we verify`, `enable javascript and cookies`

**DOM selectors for challenge detection**:
- `#challenge-form`, `#challenge-running`, `[name="cf_captcha_kind"]`, `iframe[src*="challenge"]`, `script[src*="challenge-platform"]`, `[data-translate="why_captcha_detail"]`, `#cf-wrapper`

---

## 6. Request Queue System

### 6.1 Queue Modes

| Mode | Behavior |
|---|---|
| **`wait_for_load`** (default) | Load page → wait for response → delay → next request |
| **`fixed_delay`** | Load page → delay → next request (doesn't wait; allows concurrency) |

### 6.2 Rate Limiting

- **Base delay**: configurable (default: 1000ms)
- **Delay randomization**: ±15% by default (configurable 0–100%)
- **429 handling**: On HTTP 429, increases delay by `delayIncrementOn429Ms` (default: 1000ms) and requeues the failed item
- **Max in-flight**: Configurable limit on concurrent requests in `fixed_delay` mode (default: 0 = unlimited)

### 6.3 Retryable Errors

Errors with these codes are automatically retried by re-adding the row to the queue:
- `CLOUDFLARE_ABORTED` — canceled due to another request's Cloudflare challenge
- `CLOUDFLARE_ACTIVE` — a Cloudflare gate is already owned by another request
- `IFRAME_DATA_UNAVAILABLE` — iframe loaded but data extraction timed out
- HTTP 429 — rate limited

---

## 7. User Settings

### 7.1 Storage

Settings are stored in `localStorage` under `cm-refactored-settings` as a versioned JSON object (version 2).

### 7.2 Configurable Parameters

| Setting | Default | Range | Description |
|---|---|---|---|
| `cacheExpirationHours` | 24 | 1–720 | How long cached data remains valid |
| `graphRatioThreshold` | 1.00 | 0.50–5.00 | Minimum ratio for threshold batch button |
| `requestDelayMs` | 1000 | 100–10000 | Base delay between requests |
| `maxInFlightRequests` | 0 | 0–100 | Max concurrent iframe requests (0 = unlimited) |
| `delayRandomizationPercent` | 15 | 0–100 | Random spread applied to delay |
| `queueMode` | `wait_for_load` | select | Queue processing strategy |
| `delayIncrementOn429Ms` | 1000 | 0–10000 | Additional delay added on 429 responses |
| `iframeLoadTimeoutMs` | 15000 | 1000–120000 | Max time to wait for iframe `load` event |
| `iframeReadyTimeoutMs` | 5000 | 500–60000 | Max time to poll for data after iframe loads |
| `iframeManualTimeoutMinutes` | 5 | 1–60 | Max time for manual Cloudflare unblock |

### 7.3 Settings Modal UI

- Accessible via **"⚙ Settings"** button
- Rendered as a fixed overlay with form inputs
- Includes **"Clear Data"** to wipe all IndexedDB caches
- Includes **"Defaults"** to reset to factory settings
- Closes on Escape key, overlay click, or Cancel button

---

## 8. Price Parsing

The `parsePrice()` function handles European and international number formats:

- Strips currency symbols (€) and whitespace
- Detects decimal separator (`.` vs `,`) by position
- Handles thousand separators (`1.234,56` → `1234.56` and `1,234.56` → `1234.56`)
- Handles negative values (leading `-`)
- Returns `NaN` for `'N/A'` or unparseable input

---

## 9. UI Injection Points

### 9.1 Offers Page

| Element | Location | Purpose |
|---|---|---|
| Batch buttons + badge + settings | `.pagination` row → second `.col-3` | "💲 All", "💲 >= Nx", status badge, "⚙ Settings" |
| Per-line container | Each `.article-row` → `.col-sellerProductInfo` | "💲" fetch button + "📈" graph button + ratio text |

### 9.2 Cart Page

| Element | Location | Purpose |
|---|---|---|
| Batch buttons + badge + settings | `.cart-overview .card-body` | "💲 All", "💲 >= Nx", status badge, "⚙ Settings" |
| Per-line container | Each `tr[data-article-id]` → `td.info` | "💲" fetch button + "📈" graph button + ratio text |
| Value/Profit summaries | Per `section[id*="seller"]` and cart overview | Estimated value and profit calculations |

### 9.3 Product Page

No visible UI changes — the script only **caches** the page data silently for later use.

---

## 10. External Dependencies

| Dependency | Source | Purpose |
|---|---|---|
| **Chart.js 2.7.2** | `//static.cardmarket.com/.../Chart_2_7_2.min.js` | Renders price history charts (loaded from Cardmarket's own CDN) |
| **`draggable_box.js`** | Companion userscript | Provides `attachDraggableBoxIcon()` for chart overlay boxes |

### Userscript Grants

| Grant | Usage |
|---|---|
| `GM_log` | Logging / diagnostics |
| `GM_xmlhttpRequest` | Fallback JSON fetcher for price guide download |
| `unsafeWindow` | Access to `attachDraggableBoxIcon` from companion script |

---

## 11. Key Differences from Old Version (`refactored_cardmarket_old.js`)

| Aspect | Old Version (v4.2) | Current Version (v6.4) |
|---|---|---|
| **Data fetching** | `GM_xmlhttpRequest` (cross-origin HTTP) | Hidden `<iframe>` (same-origin, session-aware) |
| **Caching** | `localStorage` with pipe-delimited keys | **IndexedDB** with structured product records |
| **Price guide** | Not used | Bulk JSON download for instant ratio display |
| **Initial hydration** | None | Multi-pass hydration loop on page load |
| **Chart display** | Inline in row (always loaded) | On-demand via "📈" button + draggable overlay |
| **Batch modes** | "All" only | "All" + "≥ threshold" with configurable ratio |
| **Queue modes** | Single sequential mode | `wait_for_load` + `fixed_delay` with concurrency control |
| **Cloudflare handling** | None | Gate system with manual unblock overlay |
| **Settings** | Hardcoded | Full settings modal with persistence |
| **Product page** | Not matched | Auto-caches visited product pages |
| **Rate limiting** | Basic delay + 429 backoff | Randomized delays + configurable 429 increment |
| **Product ID** | Not extracted | Multi-strategy extraction for IndexedDB keying |
| **Performance logging** | None | Detailed `[perf]` diagnostics via `GM_log` |

---

## 12. Architectural Notes for Re-implementation

### 12.1 Recommended Separation of Concerns

1. **Data Layer**: Price guide fetching, product data scraping, caching (IndexedDB)
2. **Queue/Scheduler**: Request queuing, rate limiting, retry logic, Cloudflare gate
3. **UI Layer**: Button injection, ratio display, chart overlays, settings modal
4. **Page Adapters**: Per-page-type logic (offers, cart, product) including DOM selectors and row discovery

### 12.2 Critical Selectors to Monitor

These CSS selectors are tightly coupled to Cardmarket's DOM and may break if the site changes:

| Selector | Purpose |
|---|---|
| `.article-row` | Offer rows on seller page |
| `table.article-table.product-table tbody tr[data-article-id]` | Cart rows |
| `a[href*="/en/Magic/Products/"]` | Product links |
| `dt.col-6.col-xl-5` | Price label elements on product page |
| `#tabContent-info .chart-wrapper` | Chart container on product page |
| `.price-container span` | Seller price on offers page |
| `td.price` | Price cell in cart |
| `span.icon[aria-label="Foil"]` | Foil indicator |
| `.col-sellerProductInfo` | Info column on offers page |
| `.card.w-100.cart-overview .card-body` | Cart overview container |
| `section[id*="seller"]` | Per-seller sections in cart |
| `.thumbnail-icon[data-bs-title]` | Thumbnail tooltip (product ID extraction) |

### 12.3 Key Design Decisions to Preserve

1. **Price guide first**: Download bulk pricing on load for instant ratios; fall back to per-product scraping for charts
2. **Iframe over XHR**: Iframes share the browser session (cookies, Cloudflare clearance), making them more reliable for authenticated scraping
3. **Auto-cache on visit**: Silently cache any product page the user visits naturally
4. **Chart ID deduplication**: Generate unique canvas IDs at render time to prevent conflicts
5. **Graceful degradation**: Script functions with or without the companion `draggable_box.js`; chart buttons are hidden/dimmed when unavailable
