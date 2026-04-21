# Changelog

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
