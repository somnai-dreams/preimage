// Float images in a pretext-flowed text column.
//
// Pretext's `layoutNextLineRange(prepared, cursor, maxWidth)` is designed for
// variable-width lines: at each step the caller decides how wide the next
// line may be, and pretext breaks a single row accordingly. The pretext
// README's canonical example is exactly this — wrap text around a floated
// image — but pretext stops short of computing the float's dimensions or
// driving the loop.
//
// This module closes that gap:
//
//   solveFloat(spec, columnWidth)      — one measured image in a column →
//                                         concrete (width, height) rect
//   flowColumnWithFloats({...})        — drives pretext's cursor loop, yields
//                                         a stream of placed lines + placed
//                                         images with absolute (x, y, w, h)
//
// The driver keeps track of which floats are active at the current `y`,
// reserves horizontal room on the appropriate side, and emits line
// placements the caller can render directly. Floats whose bottom extends
// below the last line contribute to the column's total height.
//
// Pure arithmetic, no DOM reads. The one-time cost is `prepareWithSegments`
// (pretext) + `prepare()` (preimage). Re-flowing on resize is arithmetic.

import {
  layoutNextLineRange,
  type LayoutCursor,
  type LayoutLineRange,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'

import { fitRect } from './fit.js'
import { getMeasurement, type PreparedImage } from './prepare.js'

export type FloatSide = 'left' | 'right'

// A single floated image the caller wants to place in the column. `top` is
// measured from the column's own origin (y=0). `maxWidth` is an upper bound
// — the actual width is the smaller of `maxWidth` and the column's
// available width. The image is always fit with `contain` semantics: scale
// down until it fits inside the (maxWidth, maxHeight) box.
export type FloatSpec = {
  image: PreparedImage
  side: FloatSide
  top: number
  maxWidth: number
  maxHeight?: number
  gapX?: number // horizontal gap between float and the flowing text
  gapY?: number // vertical gap between the float and whatever line neighbors it
}

export type PlacedFloat = {
  itemIndex: number
  side: FloatSide
  x: number
  y: number
  width: number
  height: number
  image: PreparedImage
}

export type PlacedLine = {
  y: number
  x: number // horizontal offset from column start (floats shift this right)
  width: number // available width for this line after subtracting active floats
  range: LayoutLineRange
}

export type ColumnFlowItem =
  | ({ kind: 'line' } & PlacedLine)
  | ({ kind: 'float' } & PlacedFloat)

export type ColumnFlowOptions = {
  text: PreparedTextWithSegments
  columnWidth: number
  lineHeight: number
  floats?: readonly FloatSpec[]
}

export type ColumnFlowResult = {
  items: ColumnFlowItem[]
  totalHeight: number
  lineCount: number
  floatCount: number
}

// --- solveFloat ---

// One measured image, one column. Returns the rect (width, height) the float
// will occupy at that column width.
export function solveFloat(
  spec: FloatSpec,
  columnWidth: number,
): { width: number; height: number } {
  const m = getMeasurement(spec.image)
  const capW = Math.min(spec.maxWidth, columnWidth)
  const capH = spec.maxHeight ?? Infinity
  const rect = fitRect(m.displayWidth, m.displayHeight, capW, capH, 'contain')
  return { width: rect.width, height: rect.height }
}

// --- flowColumnWithFloats ---

type SolvedFloat = {
  spec: FloatSpec
  itemIndex: number
  width: number
  height: number
  top: number
  bottom: number
  x: number // absolute x inside the column
  gapX: number
  gapY: number
}

function solveAllFloats(
  floats: readonly FloatSpec[],
  columnWidth: number,
): SolvedFloat[] {
  const solved: SolvedFloat[] = []
  for (let i = 0; i < floats.length; i++) {
    const spec = floats[i]!
    const gapX = spec.gapX ?? 12
    const gapY = spec.gapY ?? 0
    const { width, height } = solveFloat(spec, columnWidth)
    const x = spec.side === 'left' ? 0 : columnWidth - width
    solved.push({
      spec,
      itemIndex: i,
      width,
      height,
      top: spec.top,
      bottom: spec.top + height,
      x,
      gapX,
      gapY,
    })
  }
  // Sort by `top` so the active-float scan is cheap.
  solved.sort((a, b) => a.top - b.top)
  return solved
}

type ActiveWidths = {
  left: number
  right: number
  leftGap: number
  rightGap: number
}

function activeWidthsAt(floats: SolvedFloat[], y: number, lineHeight: number): ActiveWidths {
  // A float is active on a line whose vertical span [y, y+lineHeight) overlaps
  // [top, bottom). This matches how browsers flow text past the bottom edge
  // of a float.
  let left = 0
  let right = 0
  let leftGap = 0
  let rightGap = 0
  for (const f of floats) {
    if (f.bottom <= y - f.gapY) continue
    if (f.top >= y + lineHeight + f.gapY) continue
    if (f.spec.side === 'left') {
      if (f.width > left) left = f.width
      if (f.gapX > leftGap) leftGap = f.gapX
    } else {
      if (f.width > right) right = f.width
      if (f.gapX > rightGap) rightGap = f.gapX
    }
  }
  return { left, right, leftGap, rightGap }
}

export function flowColumnWithFloats(options: ColumnFlowOptions): ColumnFlowResult {
  const { text, columnWidth, lineHeight } = options
  const solved = solveAllFloats(options.floats ?? [], columnWidth)

  const items: ColumnFlowItem[] = []
  for (const f of solved) {
    items.push({
      kind: 'float',
      itemIndex: f.itemIndex,
      side: f.spec.side,
      x: f.x,
      y: f.top,
      width: f.width,
      height: f.height,
      image: f.spec.image,
    })
  }

  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }
  let y = 0
  let lineCount = 0
  let safety = 0
  const MAX_ITERATIONS = 200_000

  while (true) {
    if (++safety > MAX_ITERATIONS) break
    const widths = activeWidthsAt(solved, y, lineHeight)
    const available = Math.max(
      1,
      columnWidth - widths.left - widths.right - widths.leftGap - widths.rightGap,
    )
    const range = layoutNextLineRange(text, cursor, available)
    if (range === null) break

    const x = widths.left + widths.leftGap
    items.push({ kind: 'line', y, x, width: available, range })

    lineCount++
    cursor = range.end
    y += lineHeight
  }

  // Column height: whichever is lower — the last text baseline, or the
  // bottom edge of the lowest float.
  let totalHeight = y
  for (const f of solved) {
    if (f.bottom > totalHeight) totalHeight = f.bottom
  }

  return { items, totalHeight, lineCount, floatCount: solved.length }
}

// Convenience for callers that only care about column height (sizing a
// scroll container, say) without materializing lines.
export function measureColumnFlow(options: ColumnFlowOptions): {
  totalHeight: number
  lineCount: number
} {
  const { totalHeight, lineCount } = flowColumnWithFloats(options)
  return { totalHeight, lineCount }
}
