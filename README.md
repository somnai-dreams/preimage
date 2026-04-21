# Preimage

Pure JavaScript/TypeScript library for loading, measuring & laying out arbitrary images in the browser. Fast, accurate & supports every format the browser can decode. Allows rendering to `<img>`, canvas, SVG, and — given server-side decoding — eventually SSR.

Preimage side-steps the need for DOM measurements (e.g. `img.getBoundingClientRect`, forcing `naturalWidth` reads after layout), which trigger layout reflow, one of the most expensive operations in the browser. It implements its own measurement & layout logic, using the browser's own `HTMLImageElement.decode()` pipeline as ground truth.

It is a structural port of [`@chenglou/pretext`](https://github.com/chenglou/pretext) to the image domain: every module there has an image-equivalent module here, and every API has the same shape.

## Installation

```sh
npm install @somnai-dreams/preimage
```

## API

Preimage serves 2 use cases:

### 1. Measure a single image's rendered size _without ever touching DOM_

```ts
import { prepare, layout } from '@somnai-dreams/preimage'

const prepared = await prepare('https://example.com/photo.jpg')
const { width, height, offsetX, offsetY } = layout(prepared, containerWidth, containerHeight, 'contain')
// pure arithmetics. No DOM layout & reflow!
```

`prepare()` does the one-time work: kick off the browser fetch + decode, normalize the source string, cache the intrinsic dimensions, apply EXIF orientation, and return an opaque handle. `layout()` is the cheap hot path: pure arithmetic over the cached aspect ratio. Do not rerun `prepare()` for the same src; that'd defeat its precomputation. For example, on resize, only rerun `layout()`.

If your server already reports intrinsic dimensions (HTML attributes, a manifest JSON, CDN headers), skip the load entirely:

```ts
import { prepareSync, layout } from '@somnai-dreams/preimage'

const prepared = prepareSync('/photo.jpg', 2400, 1600)
const { width, height } = layout(prepared, columnWidth) // synchronous, fits 'contain' by default
```

If your image carries a known EXIF orientation, pass it so axis-swapped sources render with the correct aspect ratio:

```ts
const prepared = await prepare(src, { orientation: 6 }) // 90° CW rotation
```

The returned size is the crucial last piece for unlocking web UI's:
- proper virtualization/occlusion without guesstimates & caching
- fancy userland layouts: masonry, justified-grid, stacked-cover, etc.
- _development time_ verification (especially now with AI) that images fit inside their chrome without overflowing, browser-free
- prevent layout shift when new images load and you wanna re-anchor the scroll position

### 2. Lay out a gallery manually yourself

Switch out `prepare` with `prepareWithBoxes`, then:

- `layoutWithRows()` gives you every row at a fixed width:

```ts
import { prepareWithBoxes, layoutWithRows } from '@somnai-dreams/preimage'

const prepared = await prepareWithBoxes([
  'a.jpg',
  'b.jpg',
  { src: 'c.jpg', break: 'after' }, // hard row break after this image
  'd.png',
])
const { rows } = layoutWithRows(prepared, 960, 180) // 960px max width, 180px row height
for (const row of rows) {
  for (const p of row.placements) ctx.drawImage(bitmaps[p.itemIndex], p.x, y + p.y, p.width, p.height)
}
```

- `measureRowStats()` and `walkRowRanges()` give you row counts, widths and cursors without building the placement arrays:

```ts
import { measureRowStats, walkRowRanges } from '@somnai-dreams/preimage'

const { rowCount, maxRowWidth } = measureRowStats(prepared, 960, 180)
let maxW = 0
walkRowRanges(prepared, 960, 180, row => { if (row.width > maxW) maxW = row.width })
// maxW is the widest row — the tightest container width that still fits the gallery!
```

- `layoutNextRowRange()` lets you route images one row at a time when the available width changes as you go. If you want the placements too, `materializeRowRange()` turns that one range back into a full row:

```ts
import {
  layoutNextRowRange,
  materializeRowRange,
  prepareWithBoxes,
  type RowCursor,
} from '@somnai-dreams/preimage'

const prepared = await prepareWithBoxes(items)
let cursor: RowCursor = { itemIndex: 0 }
let y = 0

// Flow images around a floated sidebar: rows beside the sidebar are narrower
while (true) {
  const width = y < sidebar.bottom ? columnWidth - sidebar.width : columnWidth
  const range = layoutNextRowRange(prepared, cursor, width, 180)
  if (range === null) break

  const row = materializeRowRange(prepared, range, 180)
  for (const p of row.placements) ctx.drawImage(imgs[p.itemIndex], p.x, y + p.y, p.width, p.height)
  cursor = range.end
  y += row.height + 8
}
```

This usage allows rendering to canvas, SVG, WebGL and (given decoded bitmaps) server-side. See the `/demos/justified-gallery` demo for a richer example.

If your manual layout needs a small helper for rich image inline flow with captions, chrome, and browser-like boundary gap collapse, there is a helper at `@somnai-dreams/preimage/rich-gallery`. It stays row-only on purpose:

```ts
import {
  materializeRichGalleryRowRange,
  prepareRichGallery,
  walkRichGalleryRowRanges,
} from '@somnai-dreams/preimage/rich-gallery'

const prepared = await prepareRichGallery([
  { src: 'hero.jpg' },
  { src: 'avatar.png', aspectRatio: 1, break: 'never', extraWidth: 12 },
  { src: 'detail.webp' },
])

walkRichGalleryRowRanges(prepared, 320, row => {
  const mat = materializeRichGalleryRowRange(prepared, row)
  // each fragment keeps its source item index, display size, gapBefore, and cursors
})
```

It is intentionally narrow:
- raw image items in, including leading/trailing gap positions
- caller-owned `extraWidth` for chrome (padding + border)
- `break: 'never'` for atomic pairs like image + caption chip
- row-only flow
- not a masonry engine and not a general CSS grid replacement

### API Glossary

Use-case 1 APIs:

```ts
prepare(src: string, options?: PrepareOptions): Promise<PreparedImage>
  // one-time load + decode + measurement pass, returns an opaque value to pass
  // to `layout()`. Make sure `orientation` (if provided) is synced with your
  // upload pipeline — most modern pipelines strip EXIF after server-side
  // rotation, in which case the default `orientation: 1` is correct.

prepareSync(src: string, width: number, height: number, options?: { orientation?: OrientationCode }): PreparedImage
  // skip the network and decode entirely when your server has already
  // reported intrinsic dimensions (HTML attrs, manifest, CDN header)

layout(prepared: PreparedImage, maxWidth: number, maxHeight?: number, fit?: ObjectFit): LayoutSize
  // calculates rendered dimensions inside the given box. `fit` is any CSS
  // object-fit value (`contain` | `cover` | `fill` | `scale-down` | `none`).

measureAspect(prepared: PreparedImage): number
measureNaturalSize(prepared: PreparedImage): { width: number, height: number }
layoutForWidth(prepared: PreparedImage, maxWidth: number): LayoutSize
layoutForHeight(prepared: PreparedImage, maxHeight: number): LayoutSize
```

Use-case 2 APIs:

```ts
prepareWithBoxes(items: GalleryItemInput[], options?: PrepareGalleryOptions): Promise<PreparedGalleryWithBoxes>
  // same as `prepare()`, but produces a richer handle wired to the row packer

layoutWithRows(prepared, maxWidth, rowHeight, options?): LayoutRowsResult
  // high-level API for manual layout. Accepts a fixed max width for all rows.

walkRowRanges(prepared, maxWidth, rowHeight, onRow, options?): number
  // low-level API. Calls `onRow` once per row with its start/end cursors and
  // measured width, without building placements.

measureRowStats(prepared, maxWidth, rowHeight, options?): RowStats
  // returns only how many rows this width produces, and how wide the widest is.

measureNaturalWidth(prepared, rowHeight): number
  // the widest forced row when width isn't the thing forcing wraps

layoutNextRowRange(prepared, start, maxWidth, rowHeight, options?): LayoutRowRange | null
  // iterator-like API for variable-width layouts without building placements

layoutNextRow(prepared, start, maxWidth, rowHeight, options?): LayoutRow | null
  // iterator-like API for laying out each row with a different width

materializeRowRange(prepared, range, rowHeight, options?): LayoutRow
  // turns one previously computed row range back into a full row with placements
```

```ts
type RowStats = {
  rowCount: number
  maxRowWidth: number
}
type LayoutRow = {
  placements: RowPlacement[]
  width: number
  height: number
  start: RowCursor
  end: RowCursor
  scale: number
}
type LayoutRowRange = {
  width: number
  height: number
  start: RowCursor
  end: RowCursor
  scale: number
}
type RowCursor = { itemIndex: number }
type RowPlacement = { itemIndex: number, x: number, y: number, width: number, height: number }
type ObjectFit = 'contain' | 'cover' | 'fill' | 'scale-down' | 'none'
```

Helper for rich-gallery flow:

```ts
prepareRichGallery(items, options?): Promise<PreparedRichGallery>
layoutNextRichGalleryRowRange(prepared, maxWidth, start?, rowHeight?): RichGalleryRowRange | null
walkRichGalleryRowRanges(prepared, maxWidth, onRow, rowHeight?): number
materializeRichGalleryRowRange(prepared, row): RichGalleryRow
measureRichGalleryStats(prepared, maxWidth, rowHeight?): RichGalleryStats
```

```ts
type RichGalleryItem = {
  src: string
  aspectRatio?: number
  break?: 'normal' | 'never' | 'before' | 'after'
  extraWidth?: number
  minWidth?: number
  orientation?: OrientationCode
  caption?: string
}
type RichGalleryCursor = { itemIndex: number, graphemeIndex: 0 }
type RichGalleryFragment = {
  itemIndex: number
  gapBefore: number
  occupiedWidth: number
  displayWidth: number
  displayHeight: number
  start: RichGalleryCursor
  end: RichGalleryCursor
}
type RichGalleryRow = {
  fragments: RichGalleryFragment[]
  width: number
  height: number
  end: RichGalleryCursor
}
```

Other helpers:

```ts
clearCache(): void
  // clears preimage's shared internal caches. Useful if your app cycles
  // through many different sources and wants to release the accumulated cache.

recordKnownMeasurement(src, width, height, options?): ImageMeasurement
  // records a measurement without loading. Useful for SSR hydration.

getEngineProfile(): EngineProfile
  // exposes whether this browser has `HTMLImageElement.decode()` and
  // `createImageBitmap`. Read by consumers that want to predict behavior.

readExifOrientation(buffer): OrientationCode | null
  // reads the EXIF orientation tag from a raw JPEG byte buffer
```

Notes:
- `PreparedImage` is the opaque fast-path handle. `PreparedGalleryWithBoxes` is the richer gallery handle.
- `RowCursor` is an item-index cursor, not a raw array offset. Item indices refer to the input passed to `prepareWithBoxes`.
- The richer handle also includes `orientationLevels` for custom-transform rendering. The row packer does not read it.
- Placement widths/heights are after EXIF orientation and row scaling, not raw intrinsic data.
- If a cover/contain fit has no `maxHeight`, the box is treated as infinitely tall and the image fits to `maxWidth`.
- `prepare()` and `prepareWithBoxes()` do horizontal-direction-only work; `rowHeight` is a layout-time input.

## Caveats

Preimage doesn't try to be a full rendering engine (yet?). It currently targets the common image setup:

- Row-based packing: justified rows with per-row uniform height, and fixed-height rows that break on overflow.
- Object-fit modes: `contain`, `cover`, `fill`, `scale-down`, `none`. `object-position` defaults to `center center`; callers can shift placements manually.
- EXIF orientations 1–8. Browser CSS `image-orientation: from-image` is assumed.
- SVG without intrinsic dimensions falls back to `300×150`. Use `measureFromSvgText` if you want the viewBox.
- Animated GIF / APNG / animated WebP report the size of the first frame.
- Color space, CMYK, and 16-bit HDR inputs are decoded by the browser; preimage only reads dimensions.

## Develop

See [DEVELOPMENT.md](DEVELOPMENT.md) for the dev setup and commands.

## Credits

Chenglou's [pretext](https://github.com/chenglou/pretext) established the prepare/layout split and the rich-path streaming cursor approach we kept here. If you measure text and images in the same codebase, mount preimage and pretext side by side — they are designed to share a mental model.
