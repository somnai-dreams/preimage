# Preimage

Image utilities for [pretext](https://github.com/chenglou/pretext)-flowed layouts and canvas/WebGL renderers. Measure images once, lay them out many times — no DOM reflow, no `await img.onload` before layout runs. Plus opt-in utilities for common "I have a lot of images" problems: concurrency capping, off-main-thread decode caching, `object-fit` math for canvas, URL-pattern dimension shortcuts.

## What it does

Pretext's variable-width cursor loop — `layoutNextLineRange(prepared, cursor, maxWidth)` — is built for the case where a figure sits beside a column of text and each line has to know how wide it's allowed to be. Pretext takes `{ width, height, bottom }` as input and leaves the question of *how you got those numbers* to the caller. Preimage answers that question.

Two pretext adapters and a small set of adjacent utilities:

- **`flowColumnWithFloats`** — drives pretext's cursor loop, reserves horizontal space for floated images, yields placed lines and placed figures with absolute `(x, y, w, h)`.
- **`inlineImage` / `resolveMixedInlineItems`** — return pretext `RichInlineItem` values whose `extraWidth` reserves the measured image's rendered width. Pretext treats them as atomic pills that wrap with surrounding text.
- **`prepare`, `layout`, `fitRect`, `getElement`** — the primitives those adapters are built on, usable standalone.
- **`PrepareQueue`** — application-level concurrency cap with `boost(url)` priority for "this just scrolled into view, jump the queue."
- **`DecodePool`** — off-main-thread decode cache for canvas timelines and WebGL scenarios where you want `ctx.drawImage(bitmap, …)` to be a single blit, not a decode.

## What `prepare()` actually does

```ts
import { prepare, getMeasurement, getElement, layout } from '@somnai-dreams/preimage'

const img = await prepare('/hero.jpg')
// Resolves once the browser has parsed the header bytes and set
// naturalWidth on the underlying <img>. ~5-10ms typical for URLs.
// The same <img> is still fetching the rest of the bytes.

const { naturalWidth, naturalHeight, aspectRatio } = getMeasurement(img)
const rect = layout(img, 640, 480, 'contain')

// Render by reusing the <img> the library already has in flight. One
// fetch total — no second request to the same URL.
const el = getElement(img)
if (el !== null) container.appendChild(el)
```

Under the hood: create an `<img>`, set `src`, poll `naturalWidth` on a `setTimeout(0)` tick until the browser exposes it, resolve. No custom byte parsing, no `fetch()`, no blob-URL shuffling. The browser does all the work; we just observe the handoff.

For **File/Blob** inputs (upload previews), we do parse bytes ourselves — the standalone `probeImageBytes(bytes)` reads PNG, JPEG, WebP, GIF, BMP, and SVG headers without going through an `<img>`. Useful when you already have the bytes in JS and don't want the round trip.

### `dimsOnly` — measure without committing to load

```ts
const prepared = await prepare(url, { dimsOnly: true })
// Dims known. The rest of the transfer is aborted.
// getElement(prepared) returns null — the caller re-fetches if they
// later decide to render.
```

For "I need to plan a layout from 200 URLs but only render the visible 30" scenarios: catalogs, above-the-fold precompute, bandwidth-metered contexts. Abort isn't free — browsers cancel lazily once bytes are in flight, so some header-adjacent bytes land before the cancel takes effect — but it's meaningfully cheaper than a full load.

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

## `PrepareQueue`

Browsers cap parallel requests per origin (6 hardcoded for HTTP/1.1; HTTP/2 multiplexes many streams over one connection, typically ~100). Firing `prepare()` for 200 tiles means the later tiles queue inside the browser's network stack where you can't reorder them.

```ts
import { PrepareQueue } from '@somnai-dreams/preimage'

const queue = new PrepareQueue({ concurrency: 20 })   // default is 20

for (const tile of tiles) {
  tile.prepared = queue.enqueue(tile.src, { dimsOnly: true })
}

// User scrolls to tile 50 before tile 10 has started:
queue.boost(tiles[50].src)
```

**Default concurrency is 20**, sized for HTTP/2 origins (any modern CDN — GitHub Pages, Cloudflare, Vercel, Netlify, etc). On HTTP/1.1 origins the browser's 6-slot cap gatekeeps automatically: we fire 20, the browser accepts all, runs 6 in parallel, queues the rest. Same throughput as setting `concurrency: 6` would give you — no penalty, no manual tuning. Set a lower value if you're knowingly on H1 and want to leave slots free for render-side fetches.

Dedupes by normalized URL. `clear()` drops the pending backlog; in-flight work continues.

## `DecodePool`

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

Internally uses `prepare()` to get dims and the warmed `<img>` element, then `createImageBitmap(img)` directly — one fetch shared between measurement, cache, and the bitmap decode. Bitmaps evicted by LRU have `.close()` called to release GPU memory.

## Demos

Four side-by-side demos at [the demos page](./pages/demos/). Each panel has its own Run button so you feel the click-to-layout delay for each strategy:

- **Masonry** — ~30 local PNGs, naive `<img>` grid vs measured shortest-column layout. Naive shifts on every image decode; measured commits the grid in one pass.
- **Editorial** — pretext + native `<img>` (re-flows on every figure's `onload`) vs pretext + preimage (flows once with measured dims).
- **TTFS** — one ~3MB PNG, three strategies: naive, declared `<img width height>`, `prepare()`.
- **Decode pool** — canvas scrub timeline, decode-per-scrub vs warmed pool.

Run them: `bun install && bun start`, then open <http://localhost:3000/>.

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
new PrepareQueue({ concurrency? })
  queue.enqueue(src, options?): Promise<PreparedImage>
  queue.boost(src): boolean
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

Pretext solves a sharp problem: "measure text without triggering reflow, then do line breaking with pure arithmetic." Preimage's job is to deliver the *one other input* pretext needs to cover the scenarios its own README describes: editorial article layout with floated figures, rich-note with inline icon images, chat bubbles with inline attachments, masonry layouts mixing text and image cards.

For anything else images do in a browser, the platform has better answers: `aspect-ratio` handles CLS, `object-fit` handles single-image fitting inside a CSS box, `<picture>` handles responsive sources. Preimage doesn't reinvent those. It fills the specific gap where a JS layout engine — pretext, a canvas renderer, a WebGL scene — needs numeric dimensions *before* paint.

## Caveats

- The inline adapter's word-joiner (U+2060) sentinel measures 0px in every font we've tested. If you hit a font that gives `⁠` a non-zero glyph width, the reserved width will be off by that amount.
- `flowColumnWithFloats` handles any number of floats, but a line's available width is `columnWidth - (widest active left float) - (widest active right float) - gaps`. Side-by-side floats on the same side stack to the width of the larger one, not sum — matching CSS float behavior.
- EXIF orientations 1–8 are respected for measurement axes; canvas rendering still needs to apply the transform manually. Browser `<img>` rendering applies it automatically.
- SVG without an intrinsic size returns `(0, 0)` on most browsers; use `measureFromSvgText(svgText)` to extract the viewBox.
- `dimsOnly: true` cancel isn't instantaneous — browsers let the in-flight request settle a bit before aborting. Bandwidth savings are real but not surgical.

## Develop

See [DEVELOPMENT.md](DEVELOPMENT.md).

## Credits

Built on top of Chenglou's [pretext](https://github.com/chenglou/pretext). The two-phase prepare/layout split, the opaque prepared handle, and the cursor-driven streaming API are all pretext's design — preimage just follows its shape for the image side of the same problems.
