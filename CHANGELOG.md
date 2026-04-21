# Changelog

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
