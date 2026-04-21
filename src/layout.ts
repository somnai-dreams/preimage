// Image measurement & layout for browser environments using the native image
// decoding pipeline.
//
// Problem: DOM-based image measurement (HTMLImageElement.getBoundingClientRect,
// naturalWidth reads after forced reflow) serializes the caller behind layout.
// When a gallery independently measures each image, each access triggers
// synchronous style computation. For a grid with a few hundred images this
// costs tens of milliseconds per scroll frame.
//
// Solution: two-phase measurement centered around `HTMLImageElement.decode()`.
//   prepare(src) — fetch + decode once, cache intrinsic dimensions and format
//     metadata, return an opaque handle. Call when a new image enters the
//     viewport or first renders.
//   layout(prepared, maxWidth, maxHeight?, fit?) — pure arithmetic over the
//     cached aspect ratio. Call on every resize.
//
// i18n / orientation: EXIF orientation is applied as an axis swap before any
//   layout math runs, so callers never see the pre-rotated dimensions leak in.
//
// Gallery flow: `prepareWithBoxes` produces the richer manual-layout handle
//   that mirrors pretext's `prepareWithSegments`. The `layoutWithRows`,
//   `walkRowRanges`, `layoutNextRowRange`, `materializeRowRange`, and
//   `measureRowStats` APIs match pretext's shape exactly.
//
// Limitations:
//   - SVG without an intrinsic size: we fall back to 300×150 to match CSS. If
//     you want the viewBox, call `measureFromSvgText` manually.
//   - `decode()` does not honor CSS image-orientation. If your pipeline strips
//     EXIF after upload, set `orientation: 1` explicitly to skip the axis swap.
//
// Based on the same shape as Chenglou's pretext (text-layout research) but
// ported to the image domain.

import {
  analyzeGallery,
  getCachedAnalysis,
  clearAnalysisCaches,
  type GalleryAnalysis,
  type GalleryItemInput,
  type ImageAnalysis,
  type ItemBreakKind,
} from './analysis.js'
import {
  applyOrientationToSize,
  computeItemOrientationLevels,
  type OrientationCode,
} from './orientation.js'
import {
  clearMeasurementCaches,
  getEngineProfile,
  measureImage,
  measureImages,
  peekImageMeasurement,
  recordKnownMeasurement,
  type ImageMeasurement,
  type MeasureOptions,
} from './measurement.js'
import {
  buildPreparedRowPack,
  countPreparedRows,
  DEFAULT_ROW_PACK_OPTIONS,
  layoutAllRows,
  layoutNextRowRange as stepPreparedRowRange,
  materializeRowRange as materializePreparedRowRange,
  measurePreparedRowGeometry,
  walkPreparedRows,
  type InternalRow,
  type InternalRowRange,
  type PackMode,
  type PreparedRowItem,
  type PreparedRowPack,
  type RowCursor,
  type RowPackOptions,
  type RowPlacement,
} from './row-packing.js'

// --- Public types ---

declare const preparedImageBrand: unique symbol
declare const preparedGalleryBrand: unique symbol

type PreparedImageCore = {
  measurement: ImageMeasurement
  analysis: ImageAnalysis
}

export type PreparedImage = {
  readonly [preparedImageBrand]: true
}

type InternalPreparedImage = PreparedImage & PreparedImageCore

type PreparedGalleryCore = {
  measurements: ImageMeasurement[]
  kinds: ItemBreakKind[]
  analysis: GalleryAnalysis
  packed: PreparedRowPack
  orientationLevels: Int8Array | null
  defaults: RowPackOptions
}

export type PreparedGallery = {
  readonly [preparedGalleryBrand]: true
}

export type PreparedGalleryWithBoxes = PreparedGallery & {
  items: ImageMeasurement[]
}

type InternalPreparedGallery = PreparedGallery & PreparedGalleryCore

// Object-fit: standard CSS fitting modes for a single image in a single box.
export type ObjectFit = 'contain' | 'cover' | 'fill' | 'scale-down' | 'none'

export type LayoutSize = {
  width: number
  height: number
  offsetX: number
  offsetY: number
  scale: number
}

export type LayoutResult = {
  rowCount: number
  height: number
}

export type RowStats = {
  rowCount: number
  maxRowWidth: number
}

export type LayoutRow = {
  placements: RowPlacement[]
  width: number
  height: number
  start: RowCursor
  end: RowCursor
  scale: number
}

export type LayoutRowRange = {
  width: number
  height: number
  start: RowCursor
  end: RowCursor
  scale: number
}

export type LayoutRowsResult = LayoutResult & {
  rows: LayoutRow[]
}

export type PrepareOptions = MeasureOptions & {
  orientation?: OrientationCode
}

export type PrepareGalleryOptions = PrepareOptions & {
  defaults?: Partial<RowPackOptions>
}

// --- Public API: single image ---

export async function prepare(
  src: string,
  options: PrepareOptions = {},
): Promise<PreparedImage> {
  const measurement = await measureImage(src, options)
  const analysis = measurement.analysis
  const prepared: InternalPreparedImage = {
    measurement,
    analysis,
  } as unknown as InternalPreparedImage
  return prepared
}

export function prepareSync(
  src: string,
  width: number,
  height: number,
  options: { orientation?: OrientationCode } = {},
): PreparedImage {
  const measurement = recordKnownMeasurement(src, width, height, options)
  return { measurement, analysis: measurement.analysis } as unknown as InternalPreparedImage
}

// The core fit math. Pure arithmetic — no DOM reads, no decodes. Mirrors the
// contract that layout() makes with its caller in pretext.
export function layout(
  prepared: PreparedImage,
  maxWidth: number,
  maxHeight?: number,
  fit: ObjectFit = 'contain',
): LayoutSize {
  const { measurement } = prepared as unknown as InternalPreparedImage
  const boxW = Math.max(0, maxWidth)
  const boxH = maxHeight != null ? Math.max(0, maxHeight) : Infinity

  const natW = measurement.displayWidth
  const natH = measurement.displayHeight

  if (natW <= 0 || natH <= 0) {
    return { width: 0, height: 0, offsetX: 0, offsetY: 0, scale: 0 }
  }

  let width: number
  let height: number
  let scale: number

  switch (fit) {
    case 'fill': {
      width = boxW
      height = Number.isFinite(boxH) ? boxH : natH * (boxW / natW)
      scale = width / natW
      break
    }
    case 'cover': {
      const rx = boxW / natW
      const ry = Number.isFinite(boxH) ? boxH / natH : rx
      scale = Math.max(rx, ry)
      width = natW * scale
      height = natH * scale
      break
    }
    case 'none': {
      width = natW
      height = natH
      scale = 1
      break
    }
    case 'scale-down': {
      const rx = boxW / natW
      const ry = Number.isFinite(boxH) ? boxH / natH : rx
      const containScale = Math.min(rx, ry)
      scale = Math.min(1, containScale)
      width = natW * scale
      height = natH * scale
      break
    }
    case 'contain':
    default: {
      const rx = boxW / natW
      const ry = Number.isFinite(boxH) ? boxH / natH : rx
      scale = Math.min(rx, ry)
      width = natW * scale
      height = natH * scale
      break
    }
  }

  const containerH = Number.isFinite(boxH) ? boxH : height
  const offsetX = (boxW - width) / 2
  const offsetY = (containerH - height) / 2

  return { width, height, offsetX, offsetY, scale }
}

export function measureAspect(prepared: PreparedImage): number {
  const { measurement } = prepared as unknown as InternalPreparedImage
  return measurement.aspectRatio
}

export function measureNaturalSize(prepared: PreparedImage): { width: number; height: number } {
  const { measurement } = prepared as unknown as InternalPreparedImage
  return { width: measurement.displayWidth, height: measurement.displayHeight }
}

export function layoutForWidth(prepared: PreparedImage, maxWidth: number): LayoutSize {
  return layout(prepared, maxWidth, undefined, 'contain')
}

export function layoutForHeight(prepared: PreparedImage, maxHeight: number): LayoutSize {
  const { measurement } = prepared as unknown as InternalPreparedImage
  const width = maxHeight * measurement.aspectRatio
  return layout(prepared, width, maxHeight, 'contain')
}

// --- Public API: gallery ---

function buildPreparedRowItems(
  measurements: ImageMeasurement[],
  kinds: ItemBreakKind[],
): PreparedRowItem[] {
  const items: PreparedRowItem[] = []
  for (let i = 0; i < measurements.length; i++) {
    const m = measurements[i]!
    const kind = kinds[i] ?? 'image'
    items.push({
      aspectRatio: m.aspectRatio,
      breakKind: kind,
      extraWidth: 0,
      minWidth: 0,
      weight: kind === 'image' ? 1 : 0,
    })
  }
  return items
}

function mergeRowPackOptions(
  defaults: RowPackOptions,
  overrides: Partial<RowPackOptions> | undefined,
  maxWidth: number,
): RowPackOptions {
  return {
    ...defaults,
    ...(overrides ?? {}),
    maxWidth,
  }
}

export async function prepareWithBoxes(
  inputs: readonly GalleryItemInput[],
  options: PrepareGalleryOptions = {},
): Promise<PreparedGalleryWithBoxes> {
  const analysis = analyzeGallery(inputs)

  // Parallel measurement: the measurement module handles per-src caching and
  // in-flight deduping, so we can fire them all and await en masse.
  const sources = analysis.items.map((a) => a.rawSrc)
  const measurements = await measureImages(sources, options)

  const packed = buildPreparedRowPack(buildPreparedRowItems(measurements, analysis.kinds))
  const orientationLevels = computeItemOrientationLevels(
    measurements.map((m) => m.orientation),
  )

  const defaults: RowPackOptions = {
    ...DEFAULT_ROW_PACK_OPTIONS,
    ...(options.defaults ?? {}),
  }

  const prepared: InternalPreparedGallery & { items: ImageMeasurement[] } = {
    measurements,
    kinds: analysis.kinds,
    analysis,
    packed,
    orientationLevels,
    defaults,
    items: measurements,
  } as unknown as InternalPreparedGallery & { items: ImageMeasurement[] }
  return prepared
}

export function prepareGallery(
  inputs: readonly GalleryItemInput[],
  options: PrepareGalleryOptions = {},
): Promise<PreparedGallery> {
  return prepareWithBoxes(inputs, options)
}

export function layoutWithRows(
  prepared: PreparedGallery,
  maxWidth: number,
  rowHeight: number,
  options: Partial<RowPackOptions> = {},
): LayoutRowsResult {
  const internal = prepared as unknown as InternalPreparedGallery
  const opts = mergeRowPackOptions(
    internal.defaults,
    { targetRowHeight: rowHeight, ...options },
    maxWidth,
  )
  const { rows, totalHeight } = layoutAllRows(internal.packed, opts)
  const layoutRows: LayoutRow[] = rows.map((r) => toLayoutRow(r))
  return {
    rowCount: rows.length,
    height: totalHeight,
    rows: layoutRows,
  }
}

export function walkRowRanges(
  prepared: PreparedGallery,
  maxWidth: number,
  rowHeight: number,
  onRow: (row: LayoutRowRange) => void,
  options: Partial<RowPackOptions> = {},
): number {
  const internal = prepared as unknown as InternalPreparedGallery
  const opts = mergeRowPackOptions(
    internal.defaults,
    { targetRowHeight: rowHeight, ...options },
    maxWidth,
  )
  return walkPreparedRows(internal.packed, opts, (range) => {
    onRow(toLayoutRowRange(range))
  })
}

export function countRows(
  prepared: PreparedGallery,
  maxWidth: number,
  rowHeight: number,
  options: Partial<RowPackOptions> = {},
): number {
  const internal = prepared as unknown as InternalPreparedGallery
  const opts = mergeRowPackOptions(
    internal.defaults,
    { targetRowHeight: rowHeight, ...options },
    maxWidth,
  )
  return countPreparedRows(internal.packed, opts)
}

export function measureRowStats(
  prepared: PreparedGallery,
  maxWidth: number,
  rowHeight: number,
  options: Partial<RowPackOptions> = {},
): RowStats {
  const internal = prepared as unknown as InternalPreparedGallery
  const opts = mergeRowPackOptions(
    internal.defaults,
    { targetRowHeight: rowHeight, ...options },
    maxWidth,
  )
  const { rowCount, maxRowWidth } = measurePreparedRowGeometry(internal.packed, opts)
  return { rowCount, maxRowWidth }
}

export function measureNaturalWidth(
  prepared: PreparedGallery,
  rowHeight: number,
): number {
  // The widest forced row when no maxWidth would ever wrap: pack all items at
  // the target row height with infinite max width, then each chunk is one row.
  const internal = prepared as unknown as InternalPreparedGallery
  let widest = 0
  for (let c = 0; c + 1 < internal.packed.chunkStarts.length; c++) {
    const start = internal.packed.chunkStarts[c]!
    const end = internal.packed.chunkStarts[c + 1]!
    let rowWidth = 0
    let placed = 0
    for (let i = start; i < end; i++) {
      const item = internal.packed.items[i]!
      if (item.breakKind === 'break') continue
      const unscaledWidth =
        item.breakKind === 'gap'
          ? Math.max(item.minWidth, 0)
          : Math.max(item.aspectRatio * rowHeight, item.minWidth)
      rowWidth += unscaledWidth + item.extraWidth + (placed > 0 ? internal.defaults.gap : 0)
      placed++
    }
    if (rowWidth > widest) widest = rowWidth
  }
  return widest
}

export function layoutNextRowRange(
  prepared: PreparedGallery,
  start: RowCursor,
  maxWidth: number,
  rowHeight: number,
  options: Partial<RowPackOptions> = {},
): LayoutRowRange | null {
  const internal = prepared as unknown as InternalPreparedGallery
  const opts = mergeRowPackOptions(
    internal.defaults,
    { targetRowHeight: rowHeight, ...options },
    maxWidth,
  )
  const range = stepPreparedRowRange(internal.packed, start, opts)
  if (range === null) return null
  return toLayoutRowRange(range)
}

export function layoutNextRow(
  prepared: PreparedGallery,
  start: RowCursor,
  maxWidth: number,
  rowHeight: number,
  options: Partial<RowPackOptions> = {},
): LayoutRow | null {
  const internal = prepared as unknown as InternalPreparedGallery
  const opts = mergeRowPackOptions(
    internal.defaults,
    { targetRowHeight: rowHeight, ...options },
    maxWidth,
  )
  const range = stepPreparedRowRange(internal.packed, start, opts)
  if (range === null) return null
  const materialized = materializePreparedRowRange(internal.packed, range, opts)
  return toLayoutRowFromMaterialized(materialized)
}

export function materializeRowRange(
  prepared: PreparedGallery,
  range: LayoutRowRange,
  rowHeight: number,
  options: Partial<RowPackOptions> = {},
): LayoutRow {
  const internal = prepared as unknown as InternalPreparedGallery
  const opts = mergeRowPackOptions(
    internal.defaults,
    { targetRowHeight: rowHeight, ...options },
    range.width,
  )
  const internalRange: InternalRowRange = {
    startItemIndex: range.start.itemIndex,
    endItemIndex: range.end.itemIndex,
    width: range.width,
    height: range.height,
    scale: range.scale,
  }
  const materialized = materializePreparedRowRange(internal.packed, internalRange, opts)
  return toLayoutRowFromMaterialized(materialized)
}

// --- Internal shape converters ---

function toLayoutRowRange(range: InternalRowRange): LayoutRowRange {
  return {
    width: range.width,
    height: range.height,
    start: { itemIndex: range.startItemIndex },
    end: { itemIndex: range.endItemIndex },
    scale: range.scale,
  }
}

function toLayoutRowFromMaterialized(row: InternalRow): LayoutRow {
  return {
    placements: row.placements,
    width: row.width,
    height: row.height,
    start: { itemIndex: row.startItemIndex },
    end: { itemIndex: row.endItemIndex },
    scale: row.scale,
  }
}

function toLayoutRow(row: InternalRow): LayoutRow {
  return toLayoutRowFromMaterialized(row)
}

// --- Inspection helpers ---

export function getItemMeasurement(
  prepared: PreparedGallery,
  itemIndex: number,
): ImageMeasurement | null {
  const internal = prepared as unknown as InternalPreparedGallery
  return internal.measurements[itemIndex] ?? null
}

export function getItemAnalysis(
  prepared: PreparedGallery,
  itemIndex: number,
): ImageAnalysis | null {
  const internal = prepared as unknown as InternalPreparedGallery
  return internal.analysis.items[itemIndex] ?? null
}

export function getOrientationLevels(prepared: PreparedGallery): Int8Array | null {
  const internal = prepared as unknown as InternalPreparedGallery
  return internal.orientationLevels
}

// --- Cache management ---

export function clearCache(): void {
  clearMeasurementCaches()
  clearAnalysisCaches()
}

// Optional hook to warm the analysis cache without triggering a load. Useful
// for server-rendered pages where HTML attributes give you the declared size.
export function warmupAnalysis(src: string): ImageAnalysis {
  return getCachedAnalysis(src)
}

// --- Re-exports so consumers pick everything up from the main entry ---

export {
  getEngineProfile,
  measureImage,
  measureImages,
  peekImageMeasurement,
  recordKnownMeasurement,
  type ImageMeasurement,
  type MeasureOptions,
  type EngineProfile,
} from './measurement.js'
export {
  analyzeImage,
  analyzeGallery,
  detectImageFormat,
  detectSourceKind,
  normalizeSrc,
  type GalleryItemInput,
  type ImageAnalysis,
  type ImageFormat,
  type ItemBreakKind,
  type SourceKind,
} from './analysis.js'
export {
  applyOrientationToSize,
  describeOrientation,
  isValidOrientationCode,
  readExifOrientation,
  type OrientationCode,
  type OrientationInfo,
} from './orientation.js'
export {
  DEFAULT_ROW_PACK_OPTIONS,
  type PackMode,
  type RowPackOptions,
  type RowPlacement,
  type RowCursor,
} from './row-packing.js'
