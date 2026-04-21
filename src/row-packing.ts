// Row packing — the image analog of pretext's `line-break.ts`. Given a flat
// stream of measured images (plus optional gap and hard-break items), pack
// them into rows that fit under a max width while sharing a common row height.
//
// Two pack modes, matching the two row-based image layouts used in the wild:
//
//   - 'justified': Flickr/Unsplash-style. Caller picks a target row height;
//     the packer fills a row with as many images as fit side-by-side at that
//     height, then scales the row so its total width hits maxWidth exactly.
//     Final row is left un-scaled by default.
//
//   - 'fixed-height': every image is scaled to exactly the target row height,
//     and a row closes once adding the next image would exceed maxWidth. Good
//     for conversation attachment strips where the author wants uniform size.
//
// Mirrors pretext's structure:
//   - `measurePreparedRowGeometry` counts rows without emitting their content
//   - `walkPreparedRows` streams one row at a time without allocating strings
//   - `layoutNextRowRange` is the cursor-driven single-row step for
//     variable-width callers (floated captions, shrinking containers)
//   - `materializeRowRange` converts a range into a full row with placements
//
// A "row" is a sequence of item placements (`x`, `y`, `width`, `height`) plus
// the aggregate row width. Because the input can include gaps and hard breaks,
// a row may legitimately be shorter than maxWidth.

import type { ItemBreakKind } from './analysis.js'

export type PackMode = 'justified' | 'fixed-height'

export type PreparedRowItem = {
  aspectRatio: number // displayWidth / displayHeight of the source image
  breakKind: ItemBreakKind
  extraWidth: number // caller-owned chrome (border + padding, not scaled with the image)
  minWidth: number // caller-declared minimum; the packer never shrinks below this
  weight: number // weight used when distributing rounding error; 0 = fixed, 1 = default
}

export type RowPackOptions = {
  mode: PackMode
  targetRowHeight: number
  maxWidth: number
  gap: number // horizontal gap between items on a row
  minFillRatio: number // in justified mode, rows shorter than this fraction stay unscaled
  scaleLastRow: boolean
  maxScale: number // cap on how much the packer will upscale images (1 = never upscale)
}

export const DEFAULT_ROW_PACK_OPTIONS: RowPackOptions = {
  mode: 'justified',
  targetRowHeight: 160,
  maxWidth: 0,
  gap: 8,
  minFillRatio: 0.6,
  scaleLastRow: false,
  maxScale: 2,
}

export type RowCursor = {
  itemIndex: number // Index into prepared items
}

export type RowPlacement = {
  itemIndex: number
  x: number // horizontal offset from the row start
  y: number // vertical offset from the row start (always 0 in uniform-height modes)
  width: number
  height: number
}

export type InternalRowRange = {
  startItemIndex: number
  endItemIndex: number // exclusive
  width: number
  height: number
  scale: number // factor applied to the natural fit-to-row-height widths
}

export type InternalRow = InternalRowRange & {
  placements: RowPlacement[]
}

export type PreparedRowPack = {
  items: PreparedRowItem[]
  chunkStarts: number[] // hard-break-delimited chunk boundaries, always includes 0 and items.length
}

// --- Build ---

export function buildPreparedRowPack(
  items: PreparedRowItem[],
): PreparedRowPack {
  const chunkStarts = [0]
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.breakKind === 'break' && i + 1 < items.length) {
      chunkStarts.push(i + 1)
    }
  }
  chunkStarts.push(items.length)
  // Dedup trailing duplicates (if items ends with a break).
  for (let i = chunkStarts.length - 1; i > 0; i--) {
    if (chunkStarts[i] === chunkStarts[i - 1]) chunkStarts.splice(i, 1)
  }
  return { items, chunkStarts }
}

// --- Geometry math ---

// Given a row's natural total width (at target row height) and its maxWidth,
// pick the scale factor. Returns `1` when we refuse to scale (underfilled
// last row, over-maxScale upscales).
function pickScale(
  naturalWidth: number,
  extraWidthTotal: number,
  maxWidth: number,
  opts: {
    isLastRow: boolean
    minFillRatio: number
    scaleLastRow: boolean
    maxScale: number
  },
): number {
  if (naturalWidth <= 0) return 1
  const fitWidth = Math.max(0, maxWidth - extraWidthTotal)
  const raw = fitWidth / naturalWidth
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const fillRatio = naturalWidth / Math.max(1, maxWidth - extraWidthTotal)
  if (opts.isLastRow && !opts.scaleLastRow && fillRatio < opts.minFillRatio) return 1
  if (raw > opts.maxScale) return opts.maxScale
  return raw
}

// Find the inclusive end of a row that starts at `startIndex`. Works in both
// 'justified' and 'fixed-height' modes. Returns the item index *after* the
// last item that fit, so callers can pass it straight through as the next
// row's start.
function findRowEnd(
  prepared: PreparedRowPack,
  startIndex: number,
  opts: RowPackOptions,
): { endIndex: number; naturalWidth: number; extraWidthTotal: number; hitHardBreak: boolean } {
  const { items } = prepared
  const { maxWidth, gap, targetRowHeight } = opts

  let naturalWidth = 0
  let extraWidthTotal = 0
  let i = startIndex
  let placedCount = 0
  let hitHardBreak = false

  while (i < items.length) {
    const item = items[i]!
    if (item.breakKind === 'break' && placedCount > 0) {
      hitHardBreak = true
      break
    }
    if (item.breakKind === 'break' && placedCount === 0) {
      // A break at the very start doesn't create an empty row; skip it.
      i++
      continue
    }
    const unscaledWidth =
      item.breakKind === 'gap'
        ? Math.max(item.minWidth, 0)
        : Math.max(item.aspectRatio * targetRowHeight, item.minWidth)

    const addend = unscaledWidth + item.extraWidth + (placedCount > 0 ? gap : 0)
    const candidate = naturalWidth + extraWidthTotal + addend

    if (candidate > maxWidth && placedCount > 0) {
      if (opts.mode === 'fixed-height') break
      // In justified mode we still need to know whether the row's natural
      // width overflows — the packer will scale it down to fit maxWidth
      // exactly. But if we haven't placed anything yet and a single image
      // overflows, we place it anyway (and the scale factor will shrink it).
      break
    }

    naturalWidth += unscaledWidth
    extraWidthTotal += item.extraWidth + (placedCount > 0 ? gap : 0)
    i++
    placedCount++

    if (opts.mode === 'fixed-height' && item.breakKind === 'gap') continue
  }

  if (placedCount === 0 && i < items.length) {
    // Degenerate case: first item is a break. Advance past it so the caller
    // doesn't loop forever.
    return { endIndex: i + 1, naturalWidth: 0, extraWidthTotal: 0, hitHardBreak: true }
  }

  return { endIndex: i, naturalWidth, extraWidthTotal, hitHardBreak }
}

function computeRowRange(
  prepared: PreparedRowPack,
  startIndex: number,
  opts: RowPackOptions,
  isLastRow: boolean,
): InternalRowRange | null {
  if (startIndex >= prepared.items.length) return null
  const { endIndex, naturalWidth, extraWidthTotal } = findRowEnd(prepared, startIndex, opts)
  if (endIndex === startIndex) return null

  const scale =
    opts.mode === 'justified'
      ? pickScale(naturalWidth, extraWidthTotal, opts.maxWidth, {
          isLastRow,
          minFillRatio: opts.minFillRatio,
          scaleLastRow: opts.scaleLastRow,
          maxScale: opts.maxScale,
        })
      : 1

  const scaledNaturalWidth = naturalWidth * scale
  const height = opts.targetRowHeight * scale
  const width = Math.min(opts.maxWidth, scaledNaturalWidth + extraWidthTotal)

  return {
    startItemIndex: startIndex,
    endItemIndex: endIndex,
    width,
    height,
    scale,
  }
}

// --- Public walking / iteration ---

export function layoutNextRowRange(
  prepared: PreparedRowPack,
  start: RowCursor,
  opts: RowPackOptions,
): InternalRowRange | null {
  if (start.itemIndex >= prepared.items.length) return null
  // We don't know yet whether this is the last row, so we compute tentatively.
  // The same function is called with isLastRow=true when the next findRowEnd
  // returns nothing. Callers that care about "is last row" scaling should use
  // walkPreparedRows, which computes it precisely.
  const range = computeRowRange(prepared, start.itemIndex, opts, /*isLastRow*/ false)
  if (range === null) return null
  // Re-check: if the range consumes the remaining items AND the caller opted
  // in to last-row scaling, we need the justified scale to match. Recompute
  // with isLastRow=true.
  if (range.endItemIndex >= prepared.items.length) {
    return computeRowRange(prepared, start.itemIndex, opts, /*isLastRow*/ true)
  }
  return range
}

export function walkPreparedRows(
  prepared: PreparedRowPack,
  opts: RowPackOptions,
  onRow: (row: InternalRowRange) => void,
): number {
  let index = 0
  let rowCount = 0
  while (index < prepared.items.length) {
    // Pre-compute the next end to know whether this row is the final one.
    const { endIndex } = findRowEnd(prepared, index, opts)
    if (endIndex === index) break
    const isLastRow = endIndex >= prepared.items.length
    const range = computeRowRange(prepared, index, opts, isLastRow)
    if (range === null) break
    onRow(range)
    rowCount++
    index = range.endItemIndex
  }
  return rowCount
}

export function countPreparedRows(prepared: PreparedRowPack, opts: RowPackOptions): number {
  let count = 0
  walkPreparedRows(prepared, opts, () => {
    count++
  })
  return count
}

export function measurePreparedRowGeometry(
  prepared: PreparedRowPack,
  opts: RowPackOptions,
): { rowCount: number; maxRowWidth: number; totalHeight: number } {
  let rowCount = 0
  let maxRowWidth = 0
  let totalHeight = 0
  walkPreparedRows(prepared, opts, (row) => {
    rowCount++
    if (row.width > maxRowWidth) maxRowWidth = row.width
    totalHeight += row.height
  })
  return { rowCount, maxRowWidth, totalHeight }
}

// --- Materialization ---

export function materializeRowRange(
  prepared: PreparedRowPack,
  range: InternalRowRange,
  opts: RowPackOptions,
): InternalRow {
  const placements: RowPlacement[] = []
  let x = 0
  let placed = 0
  for (let i = range.startItemIndex; i < range.endItemIndex; i++) {
    const item = prepared.items[i]!
    if (item.breakKind === 'break') continue

    if (placed > 0) x += opts.gap

    const unscaledWidth =
      item.breakKind === 'gap'
        ? Math.max(item.minWidth, 0)
        : Math.max(item.aspectRatio * opts.targetRowHeight, item.minWidth)

    const width = unscaledWidth * range.scale
    const height = range.height
    placements.push({ itemIndex: i, x, y: 0, width, height })
    x += width + item.extraWidth
    placed++
  }

  // Redistribute rounding error so the row's total width lands exactly on
  // range.width (matches pretext's approach of assigning the line's residual
  // to the trailing space). We spread across image (non-gap, non-break) items.
  if (placements.length > 0 && opts.mode === 'justified') {
    const lastPlacement = placements[placements.length - 1]!
    const overshoot = x - range.width
    if (Math.abs(overshoot) > 1e-6) {
      // Find the last image placement to absorb the residual on.
      for (let j = placements.length - 1; j >= 0; j--) {
        const place = placements[j]!
        const item = prepared.items[place.itemIndex]!
        if (item.breakKind === 'image') {
          place.width -= overshoot
          for (let k = j + 1; k < placements.length; k++) {
            placements[k]!.x -= overshoot
          }
          break
        }
      }
      void lastPlacement
    }
  }

  return { ...range, placements }
}

// --- Convenience: resolve a full layout in one call ---

export function layoutAllRows(
  prepared: PreparedRowPack,
  opts: RowPackOptions,
): { rows: InternalRow[]; totalHeight: number } {
  const rows: InternalRow[] = []
  let totalHeight = 0
  walkPreparedRows(prepared, opts, (range) => {
    const row = materializeRowRange(prepared, range, opts)
    rows.push(row)
    totalHeight += row.height
  })
  return { rows, totalHeight }
}
