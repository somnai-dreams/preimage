# Changelog

## 0.10.1

- **Fix: SVG dimension parsing when `width` / `height` are not the first attribute.** Both `probeImageBytes` and `measureFromSvgText` used a regex prefix `[^>"']*` that couldn't skip across quoted attribute values. Effect: `<svg xmlns="..." width="240" height="180">` and `<svg width="240" height="180" xmlns="...">` both failed to find `height` because the regex engine couldn't cross the earlier `"` character. Fix isolates the opening `<svg ...>` tag first, then runs per-attribute regexes over just the attribute block. Caught by `scripts/parser-robustness-test.ts`, a new sweep that exercises the header parsers against ~330 synthetic edge cases plus the real photo corpus.

## 0.10.0

- **`PreparedImage.source`** — every `prepare()` / `prepareSync()` handle now carries a `source: PreparedSource` tag: `'network' | 'cache' | 'url-pattern' | 'declared' | 'manifest' | 'blob'`. Lets callers branch UI on provenance without tracking state outside the library — skip the skeleton shimmer on cache/manifest hits, fade in only when `source === 'network'`. `preparedFromMeasurement(m, 'manifest')` is the integrator path: hydrate the measurement cache via `recordKnownMeasurement` at boot, then mint prepared handles tagged as manifest-sourced so the render layer can treat them as dims-known-at-load.
- **`PreparedImage.byteLength`, `.hasAlpha`, `.isProgressive`**. Header parsers now capture alpha-channel presence (PNG color types 4/6, WebP VP8L/VP8X-with-alpha, SVG) and progressive JPEGs (SOF2 marker); the stream/range paths capture file size from `Content-Length` / `Content-Range` respectively; the blob path uses `blob.size`. `'img'` strategy leaves `byteLength` at `null` — no access to response headers. Callers drawing tinted skeletons can skip the tint when `hasAlpha === false` (image fully covers); callers that want a decode-progress affordance can skip the fade-in when `isProgressive === true` (JPEG already renders coarse-to-fine). `byteLength` shows up on `ImageMeasurement` too for callers that thread through the measurement record.
- **`strategy: 'auto'`** picks per origin. First probe for a new origin tries `'range'`; if the server answers 206 we stay on `'range'`, if 200 we switch to `'stream'` for that origin (cached in a session-scoped `Map<origin, strategy>` shared by every `PrepareQueue` and direct `prepare()` caller). No warmed element on this path. Default strategy is now `'auto'` when `dimsOnly: true` (no element expected anyway); `'img'` stays the default otherwise, preserving the `prepared.element` warmed-image reuse for single-image render flows. Most gallery/virtualization callers get the range speedup with zero code change. `getOriginStrategy(origin)` / `clearOriginStrategyCache()` exposed for diagnostics and across-deploy resets.
- **`PrepareQueue` picks concurrency adaptively.** With no `concurrency` option passed, the queue reads `navigator.connection` and picks 6 on `saveData === true` or `effectiveType` of 2g/3g/slow-2g, 50 otherwise (the HTTP/2 sweet spot). Explicit values still win. `pickAdaptiveConcurrency()` is exported so callers running their own queue can reuse the policy.
- **`PrepareQueue.boostMany(urls[]) / .deprioritizeMany(urls[])`.** Bulk priority: promote a set of URLs to the front (preserving caller order) or move them to the back in one pass, for virtualization / first-screen flows that have enqueued everything up front. Pairs with `estimateFirstScreenCount` from `@somnai-dreams/layout-algebra` — call `queue.boostMany(urls.slice(0, firstScreenK))` right after bulk-enqueue and the first viewport's probes jump the queue without a manual per-URL `boost` loop.

## 0.9.0

- **New `strategy: 'range'` option on `prepare()`.** Sends `Range: bytes=0-4095` with the fetch and parses the 206 Partial Content response directly — no abort dance, no race between "header parsed" and "server noticed." Most deterministic of the three strategies. Falls back silently to the `'stream'` consume-and-abort path when the server answers with 200 (no Range support). Tuneable via `rangeBytes` (default 4096). Best fit for node/CLI workflows scanning many URLs against a CDN; browser callers rendering via `prepared.element` should stick with `'img'`.

## 0.8.0

- **New `strategy: 'stream'` option on `prepare()`.** Default stays `'img'` (create `<img>`, poll `naturalWidth`, abort via `src = ''`), which produces a warmed element the caller can reuse. `'stream'` switches to `fetch(url)` + `probeImageStream`, aborts via `AbortController` the instant header bytes parse. Measured with a 500-image / 200-concurrency HAR: the `'img'` path's `setTimeout(0)` polling loop gets event-loop-starved at high concurrency — each probe's detect-and-abort takes 1-2 seconds even though wire-level transfer is <1 KB. `'stream'` skips the browser's image subsystem entirely, so dims land at header-bytes time (microseconds) instead of polling time. No warmed element on this path; callers rendering via `prepared.element` should stick with `'img'`.
- `PrepareQueue` passes `strategy` through unchanged — `queue.enqueue(url, { dimsOnly: true, strategy: 'stream' })` wires the same option the direct `prepare()` call would accept, so a queued virtual-tile run gets the streaming fast path with no extra plumbing. Probe bench at `/bench/probe.html` now has a strategy toggle for side-by-side comparison.

## 0.7.1

- **`PrepareQueue` default concurrency bumped from 20 → 50.** HTTP/2 servers typically advertise `SETTINGS_MAX_CONCURRENT_STREAMS` of 100, so 20 was leaving throughput on the table for 4KB header probes. On HTTP/1.1 origins the browser's 6-slot cap gatekeeps automatically with no penalty; the only meaningful cost is that 44 probes queue in the browser's network layer ahead of any render-side fetches, so callers with a busy render path should still pass a lower value explicitly.

## 0.7.0

- **`PreparedImage` is flat.** `.width`, `.height`, `.aspectRatio`, `.src`, `.element`, `.measurement` are all directly readable. `(await prepare(url)).width` just works — no import of `getMeasurement`, no reaching through `.measurement.displayWidth`. The legacy helpers (`getMeasurement`, `getElement`, `measureAspect`, `measureNaturalSize`) remain as thin wrappers that just read the corresponding field, and continue to work. AI-generated code coming off this API writes what humans would.
- **JSDoc on every public export** in the main entry and `/core`. Short one-liners plus `@example` blocks so IDE tooltips and LLM context windows carry the usage shape.

## 0.6.2

- **Fix: `createVirtualTilePool` visibility check now translates `contentContainer`'s offset within `scrollContainer`.** Previously the intersection math assumed `placement.y` and `scrollContainer.scrollTop` were in the same coordinate space, which only holds when `contentContainer` is a direct child flush with the scroll area's top. If callers put a header, padding, or sibling above `contentContainer`, tiles silently mis-mounted (treated as visible at `scrollTop = 0` when they were actually below the fold). Offset is measured once at setup via bounding rects and refreshed on scrollContainer resize.

## 0.6.1

- **Fix: `createVirtualTilePool` no longer forces layout on every `setPlacements()` call.** Previously `refresh()` read `scrollContainer.scrollTop` and `clientHeight` inline, so a caller's typical pattern — `contentContainer.style.height = ...; pool.setPlacements(next)` — triggered a forced reflow per call. For a probe-driven flow (one `setPlacements` per prepare() resolve), that's N reflows over the run. Now scroll position is cached and refreshed only on `scroll` events; `clientHeight` is refreshed via `ResizeObserver`. `refresh()` reads from the cache and doesn't touch layout.

## 0.6.0

- **`createVirtualTilePool`'s `overscan` option now accepts an asymmetric `{ ahead, behind }`** in addition to a single number. `ahead` is applied on the side the user just scrolled toward; `behind` on the opposite side. Asymmetric is almost always what you want — tiles coming into view need a head start so their images load before the user sees them, tiles leaving should release quickly so their in-flight fetches get cancelled. Scroll direction flips transparently from the internal scroll handler; callers don't need to tell the pool anything. Number form still works for the symmetric case (default 200).
- Virtual demo tuned to `{ ahead: 400, behind: 150 }` to match.

## 0.5.0

- **New: `probeImageStream(readable, { onDims, maxProbeBytes? })`** in `@somnai-dreams/preimage/core`. Consume a `ReadableStream<Uint8Array>` — WebSocket bytes, `fetch().body`, AI-gen output, whatever — and fire dimensions the moment the header is in hand (PNG: 24 bytes; JPEG: usually under 2KB). The returned promise resolves with the dims and a complete `Blob` after the stream drains; `URL.createObjectURL(blob)` gives a renderable `<img src>` without a second network fetch. DOM-free surface: runs in Node, Deno, Bun, workers, edge runtimes. Replaces the concat-and-retry loop every streaming caller would otherwise have to write.

## 0.4.0

- **New subpath `@somnai-dreams/preimage/virtual`.** `createVirtualTilePool({ scrollContainer, contentContainer, overscan, mount, unmount })` returns a DOM-recycled tile pool for scrollable grids of `Placement[]`. Pairs naturally with `shortestColumnCursor` from layout-algebra: feed placements in via `pool.setPlacements(next)` as prepare() resolves fire, and the pool mounts/unmounts tiles as the user scrolls. Handles the scroll listener (rAF-throttled), the pool of reusable `<div>`s, the active-index map, and cleanup. `unmount` is the place to cancel in-flight image fetches (`img.src = ''`) so a fast scroll through 10k tiles doesn't leave dozens of abandoned requests in the pipeline.
- Virtual demo refactored to use `createVirtualTilePool`; ~70 lines of hand-rolled pool/scroll bookkeeping removed.

## 0.3.0

- **New bin `preimage-manifest` + subpath `@somnai-dreams/preimage/manifest`.** A build-time CLI that walks a directory, header-probes every image via the DOM-free core (no decode, reads only the first 4KB of each file), and emits a JSON manifest keyed by URL path with `{ width, height }`. Clients hydrate at startup with `recordKnownMeasurement` from `/core` — `prepare(url)` then resolves synchronously from cache on first paint, skipping the network-for-dims step entirely. Usage: `preimage-manifest ./public/photos --base /photos/ --out ./src/photos.json`. Programmatic access via `buildManifest({ root, base })`. Covers PNG/JPEG/GIF/BMP/WebP/SVG (the formats `probeImageBytes` handles); skips AVIF/HEIC with a stderr warning.

## 0.2.0

- **New subpath `@somnai-dreams/preimage/core`** — DOM-free exports. `probeImageBytes`, `fitRect`, the URL-dimension parsers, `measureFromSvgText`, EXIF orientation helpers, `recordKnownMeasurement`/`peekImageMeasurement`, analysis helpers. No `Image`, no `HTMLImageElement`, no `createImageBitmap` — runs in Node, Deno, Bun, Web Workers, and edge runtimes. Use for SSR precompute, build-time manifest generation, and worker-side byte probing. The main entry still ships `prepare`, `PrepareQueue`, `DecodePool`, and pretext integration; those require the DOM.
- No changes to the main entry's public surface.

## 0.1.1

- **`PrepareQueue` default concurrency bumped from 6 → 20.** Sized for HTTP/2 origins, which is most modern deployment targets (GitHub Pages, Cloudflare, Vercel, Netlify, any CDN built in the last decade). On HTTP/1.1 origins the browser's 6-slot connection cap gatekeeps automatically — firing 20 means the browser accepts all into its own queue, runs 6 in parallel, serves the rest in FIFO order. Same throughput as the old default, no penalty. Callers who know they're on H1 and want to leave slots free for render-side fetches can pass `concurrency: 6` explicitly.
- Scale demo now passes `concurrency: 20` explicitly rather than relying on the default, so the code reads as "here's the recommended setting for bulk workloads" rather than "here's a magic number."
- README's `PrepareQueue` section rewritten around the protocol-awareness story.

## 0.1.0

Breaking: `prepare(url)` now uses a native `<img>` element with `setTimeout(0)` polling of `naturalWidth` instead of a custom `fetch()` + stream-and-header-parse pipeline. The refactor pays off three things at once — it's smaller (~30% fewer lines in `src/`), format-agnostic (free AVIF/HEIC/anything-the-browser-supports), and **actually one fetch** for the common render case.

### What changed

- **`prepare(url)` internals**: no more `fetch()`, no more `streamAndProbe`, no more PNG/JPEG/WebP/GIF/BMP-specific parsers in the URL path. An `<img>` is created, `src` is set, and the library polls `naturalWidth` on a `setTimeout(0)` tick (empirically 4-8ms to dims-known, ~5× faster than `requestAnimationFrame`). Blob/File inputs keep the existing byte-probe path via `probeImageBytes` — that code still ships standalone for direct use.
- **New: `getElement(prepared)`** returns the warmed `<img>` element the library used to measure. Callers render by inserting that same element (or `replaceChild`-ing it) — the `<img>` is still loading its bytes when `prepare()` resolves, but it's the same network request, not a second one. Render and measure share one fetch.
- **New: `{ dimsOnly: true }`** option. After dims are known, `img.src = ''` aborts the rest of the transfer. Use this when you need dims for many URLs but will only render a subset (catalog planning, SSR precompute, bandwidth-constrained UIs). Bandwidth savings are smaller than the stream-cancel approach we had before — browsers cancel lazily once bytes are in flight — but it's a real knob when you need it.
- **Demos updated**: masonry, editorial, and TTFS now pass `getElement(prepared)` into their rendered DOM instead of setting a fresh `img.src`. On the wire this means exactly one request per image; previously the "HTTP cache dedupes" story was usually but not always true.

### Removed from the public surface

These were all building blocks of the old stream-probe pipeline; none of them have consumers after the refactor. Shape of the `PreparedImage` handle, `layout()`, `fitRect()`, `recordKnownMeasurement`, `probeImageBytes`, URL parsers, `PrepareQueue`, `DecodePool`, and pretext integration are all unchanged.

- `strategy: 'auto' | 'stream' | 'image-element'` on `PrepareOptions` — the new path has only one strategy.
- `completeStream` on `PrepareOptions` — replaced by `dimsOnly` (inverse intent).
- `measureImage`, `measureImages` — the old classic path. `prepare()` covers their use cases.
- `decodeImageBitmap` — use `DecodePool.get(src)` instead; it also handles caching and off-main-thread decode.
- `getEngineProfile`, `EngineProfile` — the polling path doesn't branch on engine capabilities.
- `PrepareStrategy` type — no longer exposed.

### Snapshot of the old stream-probe implementation

Preserved on branch `archive/stream-probe-prepare` with a `STREAM-PROBE.md` explaining what's there, why it was dropped, and the one thing it does that the new approach can't (deterministic bandwidth-savings cancellation after the header bytes). If you want to build on that primitive for a catalog/SSR tool, start there.

## 0.0.7

- **Removed dominant-color extraction.** `prepare({extractDominantColor: true})`, `measurement.dominantColor`, and the `extractDominantColorFromBlob` / `extractDominantRgbaFromBlob` / `rgbaToCss` exports are gone. The extraction ran on the fully-assembled blob *after* the stream drain, so the color arrived at roughly the same moment the real image paints — it couldn't function as a loading placeholder, which was the only story the feature was advertised for. Color extraction is a real problem worth solving but doesn't belong in an image-measurement library. The code is preserved on the `feat/dominant-color` branch for anyone who wants to build a proper standalone color library (the compelling version extracts color from the partial bytes already streamed for dimension probing — progressive-JPEG DC coefficients, AVIF preview layers — which nobody ships).

## 0.0.6

Three value-adds for image-heavy pages.

- **Dominant color extraction.** `prepare(url, { extractDominantColor: true })` asynchronously populates `measurement.dominantColor` (CSS `rgb`/`rgba` string) once the bytes are available. Implemented via `createImageBitmap(blob, { resizeWidth: 1, resizeHeight: 1, resizeQuality: 'low' })` + canvas `getImageData` — the browser's native resampler does the averaging. Useful as a placeholder background color while the image decodes: the box shows the average color until the full image paints, and the color persists after load so out-of-viewport tiles still contribute a palette hint. New exports: `extractDominantColorFromBlob`, `extractDominantRgbaFromBlob`, `rgbaToCss`, `RGBA`.
- **`PrepareQueue` for managed concurrency.** Browsers cap parallel requests per origin (6 for HTTP/1.1); firing `prepare()` for 200 tiles means later tiles queue inside the browser's network stack where you can't reorder them. `PrepareQueue` is an application-level queue that holds requests before they hit the network and lets you `boost(url)` to move a URL to the front when it scrolls into view. Deduplicates by normalized URL. Default concurrency 6.
- **`DecodePool` for off-main-thread decode.** `createImageBitmap(blob)` decodes off the main thread; `DecodePool` adds a concurrency cap (default 4), an LRU cache of decoded `ImageBitmap`s (default 64 entries), and in-flight dedupe. For canvas/WebGL apps (scrubbable timelines, map tiles, photo editors), drawing from a cached `ImageBitmap` is a single main-thread blit — no decode cost on the hot path. Bitmaps evicted by LRU have `.close()` called to release GPU memory immediately.

## 0.0.5

- **Added URL-pattern dimension extraction.** Many CDNs encode intrinsic dimensions directly in the URL (Cloudinary's `w_400,h_300`, Shopify's `_400x300.jpg`, picsum's `/800/600`, Unsplash `?w=400&h=300`). `prepare(url)` now consults a pluggable registry of `UrlDimensionParser`s before hitting the network — a match skips the network entirely and resolves dimensions in microseconds.
- New exports: `registerUrlDimensionParser`, `registerCommonUrlDimensionParsers`, `clearUrlDimensionParsers`, `parseUrlDimensions`, `queryParamDimensionParser`, plus the built-in vendor parsers `cloudinaryParser`, `shopifyParser`, `picsumParser`, `unsplashParser`. Built-ins are opt-in — users register whichever match their traffic.

## 0.0.4

- Removed `@somnai-dreams/preimage/gallery`. Row packing isn't part of preimage's remit — it's a layout concern that lives at the caller. Deleted `src/gallery.ts` and dropped the subpath export.

## 0.0.3

Time-to-first-sizing.

- **`prepare(src: string | Blob, options?)`** streams the fetch for URLs and byte-probes the first ~2KB, or slices and probes the first 4KB of a Blob. Measured TTFS ~374ms → ~700µs on an 11MB in-memory PNG; for large remote images the delta is larger (the classic path also waits for full transfer).
- **Added `probeImageBytes(bytes: Uint8Array)`** as a standalone public helper — covers PNG, JPEG, WebP (VP8 / VP8L / VP8X), GIF, BMP, SVG.
- **Added `blobUrl` to `ImageMeasurement`** — when `prepare` streamed the bytes itself, it exposes an object URL so `<img src>` renders reuse the same bytes without a second fetch.
- **Added `strategy` to `PrepareOptions`** — `'auto'` (default, streams with classic fallback), `'stream'` (streaming only, errors on CORS failure), `'image-element'` (classic `HTMLImageElement.decode()` path, for instrumentation or audit contexts that must not issue a fetch).
- Automatic transparent fallback to `createImageBitmap(blob)` for AVIF / HEIC / anything without a header parser.

## 0.0.2

Reshaped as a pretext companion, not a pretext parallel.

- **Added `@somnai-dreams/preimage/pretext`** with the two integrations that justify the library's existence:
  - `flowColumnWithFloats({ text, columnWidth, lineHeight, floats })` — drives pretext's `layoutNextLineRange` cursor loop, reserves horizontal space for floated figures, yields placed lines + placed images with absolute `(x, y, w, h)`.
  - `solveFloat(spec, columnWidth)` — low-level `{ width, height }` for one floated image in a column.
  - `inlineImage(src, options)` / `inlineImageItem(preparedImage, options)` — return pretext `RichInlineItem` values whose `extraWidth` reserves the measured image's rendered width, using a zero-width-space sentinel that survives pretext's whitespace trim.
  - `resolveMixedInlineItems(items)` — parallel preparation for mixed text + image inline flows.
- **Added `fitRect()`** as the standalone pure-arithmetic `object-fit` math, usable outside `layout()`.
- **Split `layout()`** into focused modules: `src/prepare.ts` (single-image prepare/layout), `src/fit.ts` (object-fit math), `src/gallery.ts` (standalone row packer, opt-in via `@somnai-dreams/preimage/gallery`).
- **Removed** the rich-gallery parallel to pretext's rich-inline. Pretext's rich-inline is now the canonical inline flow — images plug in as `RichInlineItem`s.
- **Removed** the gallery-level analysis in `analysis.ts`; image analysis now covers format detection, declared-dimension parsing, and caching only.
- Main entry is now `dist/index.js`; pretext integration at `./pretext`; gallery at `./gallery`.

## 0.0.1

Initial release (now superseded). A one-for-one parallel of pretext; replaced in 0.0.2 by an integration-shaped library that extends pretext rather than imitating it.
