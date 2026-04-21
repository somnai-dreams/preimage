// Rich-gallery inline-flow helper — the image analog of pretext's
// `rich-inline.ts`. Lets callers compose a mixed-weight gallery of images
// where each item carries its own display chrome, minimum size, and
// "atomic" break behavior.
//
// Intentionally narrow, matching pretext's rich-inline scope:
//   - raw item list in, including leading/trailing gap items
//   - caller-owned `extraWidth` for pill/border chrome (does not scale with
//     the image, unlike justified-row scaling)
//   - `break: 'never'` keeps an image and its neighbor glued on the same row,
//     useful for image + caption-chip pairs
//   - row-only: no grid/masonry; if the caller wants columnar flow they
//     should build it on top of `walkRowRanges` in `layout.ts`
//   - a single aspect-ratio field per item lets callers declare known sizes
//     and skip the async load entirely
//
// Unlike `layout.ts`, the rich gallery operates on the *declared* aspect
// ratio directly, without a required measurement pass. This is the analog of
// pretext's rich-inline items carrying their own `font` shorthand and
// `extraWidth` up front.

import {
  applyOrientationToSize,
  isValidOrientationCode,
  type OrientationCode,
} from './orientation.js'
import { measureImage, type ImageMeasurement } from './measurement.js'
import { DEFAULT_ROW_PACK_OPTIONS } from './row-packing.js'

// --- Input shape ---

export type RichGalleryItem = {
  src: string // used for async measurement; ignored if aspectRatio is provided
  aspectRatio?: number // displayWidth / displayHeight; skip loading if provided
  break?: 'normal' | 'never' | 'before' | 'after'
  extraWidth?: number // chrome around the image (not scaled)
  minWidth?: number // never shrink below this width
  orientation?: OrientationCode
  caption?: string // opaque payload; preserved for custom rendering
}

export type RichGalleryCursor = {
  itemIndex: number
  graphemeIndex: 0 // placeholder for API symmetry with pretext; images are atomic
}

export type RichGalleryFragment = {
  itemIndex: number // index back into the original RichGalleryItem array
  gapBefore: number // collapsed boundary gap paid before this fragment on this row
  occupiedWidth: number // image display width plus extraWidth
  displayWidth: number
  displayHeight: number
  start: RichGalleryCursor
  end: RichGalleryCursor
}

export type RichGalleryRow = {
  fragments: RichGalleryFragment[]
  width: number
  height: number
  end: RichGalleryCursor
}

export type RichGalleryFragmentRange = {
  itemIndex: number
  gapBefore: number
  occupiedWidth: number
  displayWidth: number
  displayHeight: number
  start: RichGalleryCursor
  end: RichGalleryCursor
}

export type RichGalleryRowRange = {
  fragments: RichGalleryFragmentRange[]
  width: number
  height: number
  end: RichGalleryCursor
}

export type RichGalleryStats = {
  rowCount: number
  maxRowWidth: number
}

// --- Prepared handle ---

declare const preparedRichGalleryBrand: unique symbol

type PreparedRichGalleryCore = {
  items: RichGalleryItem[]
  aspectRatios: number[]
  extraWidths: number[]
  minWidths: number[]
  naturalHeights: number[] // captured only when measurements were needed
  naturalWidths: number[]
  boundaryGaps: number[] // collapsed gap carried across item boundaries
  breakBefore: boolean[]
  breakAfter: boolean[]
  atomic: boolean[]
  defaultRowHeight: number
  gap: number
}

export type PreparedRichGallery = {
  readonly [preparedRichGalleryBrand]: true
}

type InternalPreparedRichGallery = PreparedRichGallery & PreparedRichGalleryCore

// --- Public prepare ---

export type PrepareRichGalleryOptions = {
  rowHeight?: number
  gap?: number
  crossOrigin?: 'anonymous' | 'use-credentials' | null
}

export async function prepareRichGallery(
  items: readonly RichGalleryItem[],
  options: PrepareRichGalleryOptions = {},
): Promise<PreparedRichGallery> {
  const defaultRowHeight = options.rowHeight ?? DEFAULT_ROW_PACK_OPTIONS.targetRowHeight
  const gap = options.gap ?? DEFAULT_ROW_PACK_OPTIONS.gap

  const aspectRatios = new Array<number>(items.length)
  const naturalHeights = new Array<number>(items.length)
  const naturalWidths = new Array<number>(items.length)
  const extraWidths = new Array<number>(items.length)
  const minWidths = new Array<number>(items.length)
  const breakBefore = new Array<boolean>(items.length)
  const breakAfter = new Array<boolean>(items.length)
  const atomic = new Array<boolean>(items.length)

  // Kick off measurements for items without a declared aspectRatio, in
  // parallel. Items that have a declared ratio skip the load entirely.
  const pending: Array<Promise<{ index: number; measurement: ImageMeasurement }>> = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    extraWidths[i] = item.extraWidth ?? 0
    minWidths[i] = item.minWidth ?? 0
    breakBefore[i] = item.break === 'before'
    breakAfter[i] = item.break === 'after'
    atomic[i] = item.break === 'never'

    const orientation: OrientationCode =
      item.orientation != null && isValidOrientationCode(item.orientation) ? item.orientation : 1

    if (item.aspectRatio !== undefined && item.aspectRatio > 0) {
      const oriented = applyOrientationToSize(item.aspectRatio, 1, orientation)
      aspectRatios[i] = oriented.width / oriented.height
      naturalWidths[i] = oriented.width
      naturalHeights[i] = oriented.height
      continue
    }

    aspectRatios[i] = 1
    naturalWidths[i] = 0
    naturalHeights[i] = 0
    pending.push(
      (async () => ({
        index: i,
        measurement: await measureImage(item.src, {
          crossOrigin: options.crossOrigin ?? null,
          orientation,
        }),
      }))(),
    )
  }

  const resolved = await Promise.all(pending)
  for (const { index, measurement } of resolved) {
    aspectRatios[index] = measurement.aspectRatio
    naturalWidths[index] = measurement.displayWidth
    naturalHeights[index] = measurement.displayHeight
  }

  // Collapse boundary gaps between adjacent items. Carries the "would-have-
  // been-paid" gap so row packing can absorb it at row edges (browser CSS
  // collapses leading/trailing whitespace around inline boxes). We keep this
  // parallel to how pretext collapses between inline runs.
  const boundaryGaps = new Array<number>(items.length)
  for (let i = 0; i < items.length; i++) {
    boundaryGaps[i] = i === 0 ? 0 : gap
  }

  const prepared: InternalPreparedRichGallery = {
    items: items.slice(),
    aspectRatios,
    extraWidths,
    minWidths,
    naturalHeights,
    naturalWidths,
    boundaryGaps,
    breakBefore,
    breakAfter,
    atomic,
    defaultRowHeight,
    gap,
  } as unknown as InternalPreparedRichGallery

  return prepared
}

// --- Row stepping ---

function itemDisplayWidth(prep: InternalPreparedRichGallery, i: number, rowHeight: number): number {
  const unscaled = prep.aspectRatios[i]! * rowHeight
  const minW = prep.minWidths[i]!
  return unscaled > minW ? unscaled : minW
}

function rowCursor(itemIndex: number): RichGalleryCursor {
  return { itemIndex, graphemeIndex: 0 }
}

function stepRowRange(
  prep: InternalPreparedRichGallery,
  startItemIndex: number,
  maxWidth: number,
  rowHeight: number,
): RichGalleryRowRange | null {
  const { items, extraWidths, atomic, breakBefore } = prep

  if (startItemIndex >= items.length) return null

  const fragments: RichGalleryFragmentRange[] = []
  let width = 0
  let index = startItemIndex
  let placed = 0

  while (index < items.length) {
    if (breakBefore[index] && placed > 0) break

    const displayWidth = itemDisplayWidth(prep, index, rowHeight)
    const extra = extraWidths[index]!
    const gapBefore = placed > 0 ? prep.gap : 0
    const addend = displayWidth + extra + gapBefore

    // Atomic pair: current item is glued to the next by `break: 'never'`. If
    // pairing would overflow and we've already placed something, close the row.
    const nextIsAtomic = atomic[index] === true && index + 1 < items.length
    let pairAddend = addend
    if (nextIsAtomic) {
      const nextIdx = index + 1
      const nextDisplayWidth = itemDisplayWidth(prep, nextIdx, rowHeight)
      const nextExtra = extraWidths[nextIdx]!
      pairAddend += nextDisplayWidth + nextExtra + prep.gap
    }

    if (width + pairAddend > maxWidth && placed > 0) break

    fragments.push({
      itemIndex: index,
      gapBefore,
      occupiedWidth: displayWidth + extra,
      displayWidth,
      displayHeight: rowHeight,
      start: rowCursor(index),
      end: rowCursor(index + 1),
    })
    width += addend
    placed++

    if (nextIsAtomic) {
      const nextIdx = index + 1
      const nextDisplayWidth = itemDisplayWidth(prep, nextIdx, rowHeight)
      const nextExtra = extraWidths[nextIdx]!
      fragments.push({
        itemIndex: nextIdx,
        gapBefore: prep.gap,
        occupiedWidth: nextDisplayWidth + nextExtra,
        displayWidth: nextDisplayWidth,
        displayHeight: rowHeight,
        start: rowCursor(nextIdx),
        end: rowCursor(nextIdx + 1),
      })
      width += nextDisplayWidth + nextExtra + prep.gap
      placed++
      index += 2
    } else {
      index += 1
    }

    if (prep.breakAfter[index - 1]) break
  }

  if (placed === 0) return null

  return {
    fragments,
    width,
    height: rowHeight,
    end: rowCursor(index),
  }
}

// --- Public streaming API ---

export function layoutNextRichGalleryRowRange(
  prepared: PreparedRichGallery,
  maxWidth: number,
  start?: RichGalleryCursor,
  rowHeight?: number,
): RichGalleryRowRange | null {
  const prep = prepared as unknown as InternalPreparedRichGallery
  const startIdx = start?.itemIndex ?? 0
  const h = rowHeight ?? prep.defaultRowHeight
  return stepRowRange(prep, startIdx, maxWidth, h)
}

export function walkRichGalleryRowRanges(
  prepared: PreparedRichGallery,
  maxWidth: number,
  onRow: (row: RichGalleryRowRange) => void,
  rowHeight?: number,
): number {
  const prep = prepared as unknown as InternalPreparedRichGallery
  const h = rowHeight ?? prep.defaultRowHeight
  let idx = 0
  let count = 0
  while (idx < prep.items.length) {
    const range = stepRowRange(prep, idx, maxWidth, h)
    if (range === null) break
    onRow(range)
    count++
    if (range.end.itemIndex === idx) break
    idx = range.end.itemIndex
  }
  return count
}

export function measureRichGalleryStats(
  prepared: PreparedRichGallery,
  maxWidth: number,
  rowHeight?: number,
): RichGalleryStats {
  let rowCount = 0
  let maxRowWidth = 0
  walkRichGalleryRowRanges(
    prepared,
    maxWidth,
    (row) => {
      rowCount++
      if (row.width > maxRowWidth) maxRowWidth = row.width
    },
    rowHeight,
  )
  return { rowCount, maxRowWidth }
}

export function materializeRichGalleryRowRange(
  prepared: PreparedRichGallery,
  range: RichGalleryRowRange,
): RichGalleryRow {
  void prepared
  return {
    fragments: range.fragments.map((f) => ({
      itemIndex: f.itemIndex,
      gapBefore: f.gapBefore,
      occupiedWidth: f.occupiedWidth,
      displayWidth: f.displayWidth,
      displayHeight: f.displayHeight,
      start: f.start,
      end: f.end,
    })),
    width: range.width,
    height: range.height,
    end: range.end,
  }
}

export function layoutRichGalleryWithRows(
  prepared: PreparedRichGallery,
  maxWidth: number,
  rowHeight?: number,
): { rows: RichGalleryRow[]; height: number; rowCount: number } {
  const prep = prepared as unknown as InternalPreparedRichGallery
  const h = rowHeight ?? prep.defaultRowHeight
  const rows: RichGalleryRow[] = []
  let totalHeight = 0
  walkRichGalleryRowRanges(
    prepared,
    maxWidth,
    (range) => {
      rows.push(materializeRichGalleryRowRange(prepared, range))
      totalHeight += range.height
    },
    h,
  )
  return { rows, height: totalHeight, rowCount: rows.length }
}
