# Preimage

Fast image size probing for earlier, accurate layout paint.

Preimage is for JS-owned image layouts: [pretext](https://github.com/chenglou/pretext)-flowed articles, canvas/WebGL renderers, masonry grids, virtualized galleries, upload previews. It gets the image's intrinsic width and height early, then lets the layout paint the correct boxes before the full image bytes finish loading and decoding.

This is not an "images load faster" library. Images still download at network speed and decode at browser speed. The win is that text flow, card placement, canvas draw rects, and virtual scroll geometry do not need to wait for `img.onload` or a full decode just to know the right shape.

## Core idea

If JS owns the layout, JS needs the image dimensions before it can paint the right geometry.

```ts
import { prepare, layout, getElement } from '@somnai-dreams/preimage'

const image = await prepare('/hero.jpg')
const rect = layout(image, 640, 480, 'contain')

// The layout can now paint an accurate box. The image element is still
// loading, and can be reused for the final pixels when they arrive.
const el = getElement(image)
if (el !== null) container.appendChild(el)
```

`prepare()` resolves at dimensions-known time, not image-loaded time. The returned `PreparedImage` is the reusable fact: width, height, aspect ratio, source provenance, and often the warmed `<img>` element already in flight.

There are several ways to get that fact:

- `prepare(url)` — browser `<img>` path for render-friendly single images.
- `prepare(url, { dimsOnly: true })` — bulk URL dimension probing, usually via a short Range request or stream-abort path.
- `prepare(blob)` / `probeImageBytes(bytes)` — byte-level File/Blob probing for upload previews and workers.
- `prepareSync(src, w, h)` / `recordKnownMeasurement(...)` — no-network path when dimensions came from HTML attrs, a CMS, SSR, or a manifest.
- URL dimension parsers — zero-network dimensions when a CDN encodes size in the URL.
- `preimage-manifest` / `buildManifest()` — build-time dimension manifests for static assets.

The rest of the package is supporting machinery around that first fact: small adapters and draft utilities for using early dimensions in fast layouts without turning every app into a custom image loader.

## What it gives you

- **Fast dimension facts** — parse or infer width/height before the full image paints.
- **Earlier accurate layout paint** — flow text, place cards, size canvas/WebGL draw rects, and mount virtual rows with real geometry.
- **`flowColumnWithFloats`** — drives pretext's cursor loop, reserves horizontal space for floated images, yields placed lines and placed figures with absolute `(x, y, w, h)`.
- **`inlineImage` / `resolveMixedInlineItems`** — return pretext `RichInlineItem` values whose `extraWidth` reserves the measured image's rendered width. Pretext treats them as atomic pills that wrap with surrounding text.
- **`prepare`, `layout`, `fitRect`, `getElement`** — the primitives those adapters are built on, usable standalone.
- **Draft utility: `PrepareQueue`** — application-level concurrency cap with `boost(url)` priority for "this just scrolled into view, jump the queue."
- **Draft utility: `DecodePool`** — off-main-thread decode cache for canvas timelines and WebGL scenarios where you want `ctx.drawImage(bitmap, …)` to be a single blit, not a decode.
- **Draft utility: `loadGallery` / `createVirtualTilePool`** — gallery loading and DOM recycling helpers for measured image grids.
- **Draft utility: `createScrollObserver` / scroll predictors** — cheap predictive pre-rendering baselines for virtualized surfaces.
- **`buildManifest`** — build-time dimension manifests for PNG, JPEG, GIF, BMP, WebP, SVG, AVIF, HEIC/HEIF, APNG, and ICO.

## What `prepare()` actually does

```ts
import { prepare, getMeasurement, getElement, layout } from '@somnai-dreams/preimage'

const img = await prepare('/hero.jpg')
// Resolves once the browser has parsed the header bytes and set
// naturalWidth on the underlying <img>. ~5-10ms typical for URLs.
// The same <img> is still fetching the rest of the bytes. Layout can
// paint now; final pixels arrive later.

const { naturalWidth, naturalHeight, aspectRatio } = getMeasurement(img)
const rect = layout(img, 640, 480, 'contain')

// Render by reusing the <img> the library already has in flight. One
// fetch total — no second request to the same URL.
const el = getElement(img)
if (el !== null) container.appendChild(el)
```

Default URL behavior is render-friendly: create an `<img>`, set `src`, poll `naturalWidth` on a shared `setTimeout(0)` tick until the browser exposes it, resolve. The returned handle keeps that warmed element so rendering can reuse the same request.

For bulk dimension probing, `dimsOnly: true` defaults to `strategy: 'auto'`: try a short HTTP Range request per origin, remember whether that origin supports Range or needs streaming, and skip the warmed element. Explicit strategies are `img`, `range`, `stream`, and `auto`.

For **File/Blob** inputs (upload previews), we parse bytes directly — the standalone `probeImageBytes(bytes)` reads PNG, JPEG, WebP, GIF, BMP, SVG, AVIF, HEIC/HEIF, APNG, and ICO headers without going through the network. Blob preparations can carry a `measurement.blobUrl`; call `disposePreparedImage(prepared)` when the preview is gone.

### `dimsOnly` — measure without committing to load

```ts
const prepared = await prepare(url, { dimsOnly: true })
// Dims known. The rest of the transfer is aborted.
// getElement(prepared) returns null — the caller re-fetches if they
// later decide to render.
```

For "I need to plan a layout from 200 URLs but only render the visible 30" scenarios: catalogs, above-the-fold precompute, bandwidth-metered contexts. The point is early geometry. Abort isn't free — browsers cancel lazily once bytes are in flight, so some header-adjacent bytes land before the cancel takes effect — but it avoids committing every probed URL to a full image load.

### `prepareSync(src, w, h)` — no-network-path

Already know the dimensions (HTML attrs, server manifest, SSR)? Skip the DOM entirely:

```ts
const prepared = prepareSync('/hero.jpg', 1920, 1080)
// Sync, no fetch. Goes straight into the measurement cache.
```

## URL-pattern dimension extraction

Many CDNs encode dimensions in the URL — Cloudinary's `w_400,h_300/`, Shopify's `_400x300.jpg`, picsum's `/800/600`, Unsplash's `?w=400&h=300`. When `prepare(url)` sees a registered parser match, it resolves dims from the string alone — no network.

```ts
import {
  prepare,
  registerCommonUrlDimensionParsers,
  registerUrlDimensionParser,
  queryParamDimensionParser,
} from '@somnai-dreams/preimage'

registerCommonUrlDimensionParsers()  // Cloudinary, Shopify, picsum, Unsplash

// Or define your own:
registerUrlDimensionParser(
  queryParamDimensionParser((u) => u.includes('my-cdn.example.com/'), 'width', 'height'),
)

const prepared = await prepare(cloudinaryUrl)   // zero network
```

Parsers are `(url: string) => { width, height } | null` functions — register as many as you need.

## Draft utility: `PrepareQueue`

Browsers cap parallel requests per origin (6 hardcoded for HTTP/1.1; HTTP/2 multiplexes many streams over one connection, typically ~100). Firing `prepare()` for 200 tiles means the later tiles queue inside the browser's network stack where you can't reorder them.

```ts
import { PrepareQueue } from '@somnai-dreams/preimage'

const queue = new PrepareQueue()   // adaptive default: 50, or 6 on save-data / slow links

for (const tile of tiles) {
  tile.prepared = queue.enqueue(tile.src, { dimsOnly: true })
}

// User scrolls to tile 50 before tile 10 has started:
queue.boost(tiles[50].src)
```

With no explicit `concurrency`, the queue reads `navigator.connection`: `6` on save-data / slow-2g / 2g / 3g, `50` otherwise. HTTP/2 origins usually benefit from the wider queue; HTTP/1.1 origins still gate at the browser's per-origin connection cap.

Dedupes by normalized URL plus measurement-affecting options. Two callers asking for the same URL with different `dimsOnly`, strategy, range, CORS, fallback, orientation, or abort-signal semantics get separate promises. `clear()` drops the pending backlog; in-flight work continues.

This is a lightweight helper around dimension work, not a claim that image bytes load faster. It keeps dimension probes reorderable before they enter the browser's opaque network queue.

## Draft utility: `DecodePool`

`createImageBitmap(element-or-blob)` decodes off the main thread. For canvas/WebGL scenarios — scrubbable timelines, map tiles, photo editors — drawing from a cached `ImageBitmap` is a single blit with no decode cost on the hot path.

```ts
import { DecodePool } from '@somnai-dreams/preimage'

const pool = new DecodePool({ concurrency: 4, maxCacheEntries: 64 })

function paint() {
  for (const frame of visibleFrames) {
    const bitmap = pool.peek(frame.src)        // non-blocking
    if (bitmap !== null) ctx.drawImage(bitmap, frame.x, frame.y)
    else void pool.get(frame.src)              // kick off decode for next paint
  }
}
```

Internally uses `prepare()` to get dimensions and the warmed `<img>` element, then `createImageBitmap(img)` directly — one fetch shared between measurement, cache, and the bitmap decode. Bitmaps evicted by LRU have `.close()` called to release GPU memory.

## Demos

Browser demos live at [the demos page](./pages/demos/). Most panels have their own Run button so you feel the click-to-accurate-layout delay for each strategy:

- **Packing** — runtime-probed local PNGs packed through shortest columns and justified rows.
- **Editorial** — pretext + native `<img>` (re-flows on every figure's `onload`) vs pretext + preimage (flows once with measured dims).
- **TTFS** — one ~3MB PNG, three strategies: naive, declared `<img width height>`, `prepare()`.
- **Decode pool** — canvas scrub timeline, decode-per-scrub vs warmed pool.

Run them: `bun install && bun run start`, then open the URL printed by the server. It starts at <http://localhost:3000/> and auto-increments when that port is busy.

## Installation

```sh
npm install @somnai-dreams/preimage @chenglou/pretext
```

Pretext is a `peerDependency` — the main entry (`@somnai-dreams/preimage`) does not import it, but `@somnai-dreams/preimage/pretext` does.

## Pretext integration

### Float a figure beside a text column

```ts
import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'
import { prepare } from '@somnai-dreams/preimage'
import { flowColumnWithFloats } from '@somnai-dreams/preimage/pretext'

const image = await prepare('/figure.jpg')
const text = prepareWithSegments(article, FONT)

const { items, totalHeight } = flowColumnWithFloats({
  text,
  columnWidth,
  lineHeight: 26,
  floats: [
    { image, side: 'right', top: 26, maxWidth: 280, maxHeight: 220, gapX: 16 },
  ],
})

for (const item of items) {
  if (item.kind === 'line') {
    const line = materializeLineRange(text, item.range)
    ctx.fillText(line.text, item.x, item.y)
  } else {
    ctx.drawImage(bitmap, item.x, item.y, item.width, item.height)
  }
}
```

`solveFloat(spec, columnWidth)` is the low-level version — just the `{ width, height }` for one floated image, for callers driving pretext's loop themselves.

### Inline images in rich-inline text flow

```ts
import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange,
} from '@chenglou/pretext/rich-inline'
import {
  resolveMixedInlineItems,
  isInlineImageItem,
} from '@somnai-dreams/preimage/pretext'

const items = await resolveMixedInlineItems([
  { text: 'Pushed a fix to ', font: FONT },
  { kind: 'image', src: iconSrc, options: { font: FONT, height: 20, extraWidth: 6 } },
  { text: ' preimage', font: FONT },
])
const prepared = prepareRichInline(items)

walkRichInlineLineRanges(prepared, maxWidth, (range) => {
  const line = materializeRichInlineLineRange(prepared, range)
  for (const frag of line.fragments) {
    const item = items[frag.itemIndex]
    if (isInlineImageItem(item)) drawInlineImage(item, frag)
    else drawInlineText(item, frag)
  }
})
```

`inlineImage(src, options)` returns a `RichInlineItem` whose `text` is a single word joiner (U+2060) and whose `extraWidth` is the measured image's rendered width plus any caller-supplied chrome. Pretext packs it as an atomic pill with `break: 'never'` by default. The returned item also carries `imageDisplayWidth`, `imageDisplayHeight`, and a reference to the `PreparedImage`, so the caller has everything needed to render at the fragment's computed position.

`inlineImageItem(preparedImage, options)` is the sync version for callers that already have the image measured.

## API glossary

### Core (`@somnai-dreams/preimage`)

```ts
// Prepare
prepare(src: string | Blob, options?): Promise<PreparedImage>
prepareSync(src, width, height, { orientation? }?): PreparedImage
disposePreparedImage(prepared): void

// Handle readers
getMeasurement(prepared): ImageMeasurement
getElement(prepared): HTMLImageElement | null   // warmed <img> for render reuse
measureAspect(prepared): number
measureNaturalSize(prepared): { width, height }

// Layout math (pure, DOM-free)
layout(prepared, maxWidth, maxHeight?, fit?): FittedRect
layoutForWidth(prepared, maxWidth): FittedRect
layoutForHeight(prepared, maxHeight): FittedRect
fitRect(naturalW, naturalH, boxW, boxH, fit?): FittedRect
   // fit is 'contain' | 'cover' | 'fill' | 'scale-down' | 'none'

// Caching + cache-awareness
recordKnownMeasurement(src, w, h, { orientation?, decoded? }?): ImageMeasurement
peekImageMeasurement(src): ImageMeasurement | null
listCachedMeasurements(): ImageMeasurement[]
clearCache(): void

// Byte-level primitives (for File/Blob consumers)
probeImageBytes(bytes: Uint8Array): { width, height } | null
MAX_HEADER_BYTES: number
measureFromSvgText(svgText): { width, height } | null

// EXIF
readExifOrientation(buffer): OrientationCode | null
applyOrientationToSize(w, h, orientation): { width, height }

// Concurrency + decode pool
pickAdaptiveConcurrency(): number
new PrepareQueue({ concurrency? })
  queue.enqueue(src, options?): Promise<PreparedImage>
  queue.boost(src): boolean
  queue.boostMany(srcs): void
  queue.deprioritizeMany(srcs): void
  queue.clear(): void
  queue.pendingCount / queue.inflightCount

new DecodePool({ concurrency?, maxCacheEntries?, imageBitmapOptions? })
  pool.get(src): Promise<ImageBitmap>
  pool.peek(src): ImageBitmap | null
  pool.release(src): boolean
  pool.clear(): void
```

### DOM-free core (`@somnai-dreams/preimage/core`)

The subset of the main entry that doesn't touch `Image`, `HTMLImageElement`, or `createImageBitmap`. Runs in Node, Deno, Bun, Web Workers, and edge runtimes.

```ts
// Byte-level probing
probeImageBytes(bytes): { width, height } | null
MAX_HEADER_BYTES: number
measureFromSvgText(svgText): { width, height } | null

// URL analysis + declared-dimension parsers
analyzeImage(src): ImageAnalysis
normalizeSrc, detectImageFormat, detectSourceKind
parseUrlDimensions, registerCommonUrlDimensionParsers
cloudinaryParser, shopifyParser, picsumParser, unsplashParser

// Measurement cache seeding
recordKnownMeasurement(src, w, h, options?): ImageMeasurement
peekImageMeasurement(src): ImageMeasurement | null
listCachedMeasurements(): ImageMeasurement[]

// EXIF + layout math
readExifOrientation(buffer): OrientationCode | null
applyOrientationToSize(w, h, orientation): { width, height }
fitRect(naturalW, naturalH, boxW, boxH, fit?): FittedRect
```

Use for SSR precompute, build-time manifest generation, and worker-side byte probing. For rendering-path APIs (`prepare`, `PrepareQueue`, `DecodePool`, pretext integration), import from the main entry or `./pretext`.

### Build-time manifest (`preimage-manifest` + `@somnai-dreams/preimage/manifest`)

Ship dimensions in the bundle so the client skips network-for-dims on every URL in the manifest.

```bash
npx preimage-manifest ./public/photos --base /photos/ --out ./src/photos.json
```

```ts
import manifest from './photos.json'
import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'

for (const [src, { width, height }] of Object.entries(manifest)) {
  recordKnownMeasurement(src, width, height)
}
// prepare(url) now resolves synchronously from cache for any URL in the manifest
```

Programmatic (e.g. from a vite plugin or astro integration):

```ts
import { buildManifest } from '@somnai-dreams/preimage/manifest'
const manifest = await buildManifest({ root: './public/photos', base: '/photos/' })
```

Reads only `MAX_HEADER_BYTES` (4KB) per file; the full image is never decoded except for the JPEG retry path when metadata pushes SOF past the header budget. Defaults cover PNG, JPEG, GIF, BMP, WebP, SVG, AVIF, HEIC/HEIF, APNG, and ICO.

### Draft utility subpaths: virtual pools and image loading

`@somnai-dreams/preimage/virtual` exports `createVirtualTilePool`, the DOM-recycled tile pool used by the demos. Feed it `Placement[]`; it mounts only visible/overscan tiles and calls `unmount` so renderers can cancel image work. The same subpath also exports virtual priority helpers (`createVirtualPriorityTracker`, `virtualPlacementPriority`, `scoreVirtualPlacement`) so resource schedulers can rank mounted work as visible, predicted, ahead, near, or behind without reimplementing viewport math.

`@somnai-dreams/preimage/loading` exports `loadGallery`. Pass `aspects` when dimensions are already known; otherwise the helper probes dimensions through `PrepareQueue`. Separately, `imageLoading` controls when mounted tiles start visible image requests: `queued` caps visible image fetches and uses the virtual priority helpers to score mounted work by visible tiles, short-horizon predicted tiles, then scroll-direction distance; `visible-first` gates overscan work until the first viewport has loaded; `after-layout` waits until the frame layer is complete; and `immediate` starts image requests as tiles mount. The default is `queued`: render work starts at concurrency 2 while dimensions are still probing, rises to 4 for viewport work after layout completes, then can rise to 6 after the viewport has no pending image and scrolling has gone idle.

These helpers are intentionally draft-shaped: small, fast approaches for using early dimensions in virtualized surfaces. Treat them as orchestration helpers around the core dimension fact, not as the main reason to adopt the package.

### Draft utility subpath: scroll prediction baselines

`@somnai-dreams/preimage/predict` exports the phase-0 pieces for predictive pre-render experiments: `createScrollObserver(container)`, `createStationaryPredictor()`, `createLinearPredictor()`, `createMomentumPredictor()`, and `evaluatePrediction(predictor, samples, { horizonMs })`. The bench at `/bench/predict.html` runs scripted scroll traces before this touches the virtual pool.

### Pretext integration (`@somnai-dreams/preimage/pretext`)

```ts
solveFloat(spec, columnWidth): { width, height }
flowColumnWithFloats({ text, columnWidth, lineHeight, floats }): ColumnFlowResult
measureColumnFlow(opts): { totalHeight, lineCount }

inlineImage(src, options): Promise<InlineImageItem>
inlineImageItem(preparedImage, options): InlineImageItem
resolveMixedInlineItems(items): Promise<RichInlineItem[]>
isInlineImageItem(item): item is InlineImageItem
```

Shapes:

```ts
type FloatSpec = {
  image: PreparedImage
  side: 'left' | 'right'
  top: number
  maxWidth: number
  maxHeight?: number
  gapX?: number   // default 12
  gapY?: number   // default 0
}

type ColumnFlowItem =
  | { kind: 'line'; y, x, width; range: LayoutLineRange }
  | { kind: 'float'; y, x, width, height; image; itemIndex; side }

type InlineImageItem = RichInlineItem & {
  __preimageInline: true
  image: PreparedImage
  imageDisplayWidth: number
  imageDisplayHeight: number
  chromeWidth: number
}
```

## Why this exists

Pretext solves a sharp problem: "measure text without triggering reflow, then do line breaking with pure arithmetic." Preimage's job is to deliver the *one other input* those layouts need before first accurate paint: image width and height.

For anything else images do in a browser, the platform has better answers: `aspect-ratio` handles CLS, `object-fit` handles single-image fitting inside a CSS box, `<picture>` handles responsive sources, and native image loading still owns the final pixels. Preimage doesn't reinvent those. It fills the specific gap where a JS layout engine — pretext, a canvas renderer, a WebGL scene, a measured masonry layout — needs numeric dimensions before it can paint the right geometry.

## Caveats

- The inline adapter's word-joiner (U+2060) sentinel measures 0px in every font we've tested. If you hit a font that gives `⁠` a non-zero glyph width, the reserved width will be off by that amount.
- `flowColumnWithFloats` handles any number of floats, but a line's available width is `columnWidth - (widest active left float) - (widest active right float) - gaps`. Side-by-side floats on the same side stack to the width of the larger one, not sum — matching CSS float behavior.
- EXIF orientations 1–8 are respected for measurement axes; canvas rendering still needs to apply the transform manually. Browser `<img>` rendering applies it automatically.
- SVG without an intrinsic size returns `(0, 0)` on most browsers; use `measureFromSvgText(svgText)` to extract the viewBox.
- `dimsOnly: true` cancel isn't instantaneous — browsers let the in-flight request settle a bit before aborting. The main win is earlier layout geometry; bandwidth savings are useful but not surgical.

## Develop

See [DEVELOPMENT.md](DEVELOPMENT.md).

## Credits

Built on top of Chenglou's [pretext](https://github.com/chenglou/pretext). The two-phase prepare/layout split, the opaque prepared handle, and the cursor-driven streaming API are all pretext's design — preimage just follows its shape for the image side of the same problems.
