// Standalone image-gallery row packer. Useful on its own for Flickr/Unsplash
// justified grids, *not* part of the pretext integration — the pretext-
// facing value in this library lives in `pretext-float.ts` and
// `pretext-inline.ts`.
//
// Included because the same prepared measurements callers use for the
// pretext float helper can be fed into this packer at no extra cost, and
// because re-implementing a justified-gallery algorithm on top of a measured
// dimension cache is the single most common follow-up ask.
//
// Two pack modes:
//   'justified': fill each row at a target height, then scale the row to
//     exactly maxWidth (final row left un-scaled unless `scaleLastRow`).
//   'fixed-height': every row stays at the target height and closes on
//     overflow.

import type { PreparedImage } from './prepare.js'
import { getMeasurement } from './prepare.js'

export type PackMode = 'justified' | 'fixed-height'

export type GalleryItem = {
  image: PreparedImage
  extraWidth?: number // caller-owned chrome (border, padding); not scaled
  break?: 'normal' | 'after'
}

export type RowPackOptions = {
  mode?: PackMode
  targetRowHeight?: number
  maxWidth: number
  gap?: number
  minFillRatio?: number // justified mode: don't scale a row below this fill fraction
  scaleLastRow?: boolean
  maxScale?: number // cap justified up-scaling; 1 = never upscale
}

export type RowPlacement = {
  itemIndex: number
  x: number
  y: number
  width: number
  height: number
}

export type GalleryRow = {
  placements: RowPlacement[]
  width: number
  height: number
  startItemIndex: number
  endItemIndex: number // exclusive
  scale: number
}

const DEFAULTS = {
  mode: 'justified' as PackMode,
  targetRowHeight: 160,
  gap: 8,
  minFillRatio: 0.6,
  scaleLastRow: false,
  maxScale: 2,
}

function resolveOptions(opts: RowPackOptions): Required<RowPackOptions> {
  return {
    mode: opts.mode ?? DEFAULTS.mode,
    targetRowHeight: opts.targetRowHeight ?? DEFAULTS.targetRowHeight,
    maxWidth: opts.maxWidth,
    gap: opts.gap ?? DEFAULTS.gap,
    minFillRatio: opts.minFillRatio ?? DEFAULTS.minFillRatio,
    scaleLastRow: opts.scaleLastRow ?? DEFAULTS.scaleLastRow,
    maxScale: opts.maxScale ?? DEFAULTS.maxScale,
  }
}

type Prepared = {
  aspects: number[]
  extras: number[]
  hardBreakAfter: boolean[]
}

function prepareItems(items: readonly GalleryItem[]): Prepared {
  const aspects = new Array<number>(items.length)
  const extras = new Array<number>(items.length)
  const hardBreakAfter = new Array<boolean>(items.length)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    aspects[i] = getMeasurement(item.image).aspectRatio
    extras[i] = item.extraWidth ?? 0
    hardBreakAfter[i] = item.break === 'after'
  }
  return { aspects, extras, hardBreakAfter }
}

function findRowEnd(
  prep: Prepared,
  startIndex: number,
  opts: Required<RowPackOptions>,
): { endIndex: number; naturalWidth: number; extrasTotal: number } {
  let naturalWidth = 0
  let extrasTotal = 0
  let i = startIndex
  let placed = 0

  while (i < prep.aspects.length) {
    const unscaled = prep.aspects[i]! * opts.targetRowHeight
    const extra = prep.extras[i]!
    const addend = unscaled + extra + (placed > 0 ? opts.gap : 0)
    const candidate = naturalWidth + extrasTotal + addend

    if (candidate > opts.maxWidth && placed > 0) {
      if (opts.mode === 'fixed-height') break
      break // justified: overflow still closes the row; we scale it down below
    }

    naturalWidth += unscaled
    extrasTotal += extra + (placed > 0 ? opts.gap : 0)
    i++
    placed++

    if (prep.hardBreakAfter[i - 1]) break
  }

  return { endIndex: i, naturalWidth, extrasTotal }
}

function pickScale(
  naturalWidth: number,
  extrasTotal: number,
  maxWidth: number,
  isLastRow: boolean,
  opts: Required<RowPackOptions>,
): number {
  if (naturalWidth <= 0 || opts.mode !== 'justified') return 1
  const fitWidth = Math.max(0, maxWidth - extrasTotal)
  const raw = fitWidth / naturalWidth
  if (!Number.isFinite(raw) || raw <= 0) return 1
  if (isLastRow && !opts.scaleLastRow) {
    const fillRatio = naturalWidth / Math.max(1, maxWidth - extrasTotal)
    if (fillRatio < opts.minFillRatio) return 1
  }
  return raw > opts.maxScale ? opts.maxScale : raw
}

export function packGallery(items: readonly GalleryItem[], options: RowPackOptions): GalleryRow[] {
  const opts = resolveOptions(options)
  if (opts.maxWidth <= 0) return []
  const prep = prepareItems(items)
  const rows: GalleryRow[] = []

  let index = 0
  while (index < items.length) {
    const { endIndex, naturalWidth, extrasTotal } = findRowEnd(prep, index, opts)
    if (endIndex === index) break
    const isLastRow = endIndex >= items.length
    const scale = pickScale(naturalWidth, extrasTotal, opts.maxWidth, isLastRow, opts)
    const rowHeight = opts.targetRowHeight * scale

    const placements: RowPlacement[] = []
    let x = 0
    for (let i = index; i < endIndex; i++) {
      if (i > index) x += opts.gap
      const width = prep.aspects[i]! * opts.targetRowHeight * scale
      placements.push({ itemIndex: i, x, y: 0, width, height: rowHeight })
      x += width + prep.extras[i]!
    }

    const rowWidth = Math.min(opts.maxWidth, naturalWidth * scale + extrasTotal)
    rows.push({
      placements,
      width: rowWidth,
      height: rowHeight,
      startItemIndex: index,
      endItemIndex: endIndex,
      scale,
    })

    index = endIndex
  }

  return rows
}

export function measureGalleryHeight(
  items: readonly GalleryItem[],
  options: RowPackOptions,
): { rowCount: number; height: number; maxRowWidth: number } {
  const rows = packGallery(items, options)
  let height = 0
  let maxRowWidth = 0
  const gap = options.gap ?? DEFAULTS.gap
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    height += row.height
    if (i < rows.length - 1) height += gap
    if (row.width > maxRowWidth) maxRowWidth = row.width
  }
  return { rowCount: rows.length, height, maxRowWidth }
}
