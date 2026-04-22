// Pure-function layout primitives over aspect-ratio arrays.
//
// Nothing here touches the DOM. Every function takes plain numbers
// (aspect ratios, pixel counts) and returns placements. Usable from
// Bun, Node, workers, SSR, anywhere — as long as the caller has
// measured the images elsewhere.

export type Placement = {
  x: number
  y: number
  width: number
  height: number
}

// --- Shortest-column masonry packer ---
//
// Given a stream of aspect ratios and a fixed column count, drop
// each item into whichever column is currently the shortest. Classic
// Pinterest/Flickr-style masonry; tiles never move once placed, so
// the layout is stable under incremental appending.

export type ShortestColumnConfig = {
  columns: number
  gap: number
  panelWidth: number
}

export function packShortestColumn(
  aspects: readonly number[],
  config: ShortestColumnConfig,
): { placements: Placement[]; totalHeight: number } {
  const cursor = shortestColumnCursor(config)
  const placements = aspects.map((a) => cursor.add(a))
  return { placements, totalHeight: cursor.totalHeight() }
}

// Cursor form — add one aspect at a time. Pretext-style: caller
// holds state externally and drives the loop. Useful when aspects
// arrive from an async stream (e.g. prepare() promises resolving
// in a queue) and you want placements as-they-come rather than
// accumulating into an array first.

export type PackingCursor = {
  add(aspect: number): Placement
  totalHeight(): number
  snapshot(): { placements: Placement[]; totalHeight: number }
  count(): number
  reset(): void
}

export function shortestColumnCursor(config: ShortestColumnConfig): PackingCursor {
  const { columns, gap, panelWidth } = config
  if (columns < 1 || !Number.isFinite(columns)) {
    throw new RangeError(`shortestColumnCursor: columns must be a positive integer, got ${columns}.`)
  }
  const colWidth = (panelWidth - gap * (columns - 1)) / columns
  let heights = new Array<number>(columns).fill(0)
  const placements: Placement[] = []

  return {
    add(aspect: number): Placement {
      if (!Number.isFinite(aspect) || aspect <= 0) {
        throw new RangeError(`shortestColumnCursor.add: aspect must be a positive finite number.`)
      }
      let shortest = 0
      for (let c = 1; c < columns; c++) {
        if (heights[c]! < heights[shortest]!) shortest = c
      }
      const h = colWidth / aspect
      const x = shortest * (colWidth + gap)
      const y = heights[shortest]!
      heights[shortest] = y + h + gap
      const placement: Placement = { x, y, width: colWidth, height: h }
      placements.push(placement)
      return placement
    },
    totalHeight(): number {
      // The last gap is spurious — subtract it so the container
      // sizes to the actual bottom of the last tile in each column.
      const maxStackHeight = Math.max(...heights)
      return Math.max(0, maxStackHeight - gap)
    },
    snapshot(): { placements: Placement[]; totalHeight: number } {
      return {
        placements: placements.slice(),
        totalHeight: Math.max(0, Math.max(...heights) - gap),
      }
    },
    count(): number {
      return placements.length
    },
    reset(): void {
      heights = new Array<number>(columns).fill(0)
      placements.length = 0
    },
  }
}

// --- Justified-rows packer ---
//
// Flickr / Google Photos / Unsplash-style: images flow left-to-right
// at a target row height. Each row closes when the next image would
// overflow `panelWidth`; the closed row's items are scaled uniformly
// so their widths fit exactly. Rows have different heights between
// rows but uniform height within a row — the opposite trade-off from
// shortest-column masonry.
//
// Trailing row: if `lastRowJustified` is false (default), the last
// row keeps `targetRowHeight` and whatever trailing whitespace is
// left. If true, the last row is scaled up to fill the panel like
// every other row — visually tidier but distorts the final tiles if
// they're meant to be consumed as a "what's newest" stripe.

export type JustifiedRowsConfig = {
  panelWidth: number
  targetRowHeight: number
  gap: number
  lastRowJustified?: boolean
}

export function packJustifiedRows(
  aspects: readonly number[],
  config: JustifiedRowsConfig,
): { placements: Placement[]; totalHeight: number } {
  const { panelWidth, targetRowHeight, gap } = config
  const lastRowJustified = config.lastRowJustified ?? false

  if (!Number.isFinite(panelWidth) || panelWidth <= 0) {
    throw new RangeError(`packJustifiedRows: panelWidth must be positive, got ${panelWidth}.`)
  }
  if (!Number.isFinite(targetRowHeight) || targetRowHeight <= 0) {
    throw new RangeError(
      `packJustifiedRows: targetRowHeight must be positive, got ${targetRowHeight}.`,
    )
  }
  if (!Number.isFinite(gap) || gap < 0) {
    throw new RangeError(`packJustifiedRows: gap must be non-negative, got ${gap}.`)
  }

  const placements: Placement[] = new Array(aspects.length)
  let y = 0
  let rowStart = 0

  // Walk items, tentatively adding to the current row. When adding
  // item i would overflow panelWidth at targetRowHeight, close the
  // row with [rowStart, i) and start a new row with i.
  for (let i = 0; i < aspects.length; i++) {
    const aspect = aspects[i]!
    if (!Number.isFinite(aspect) || aspect <= 0) {
      throw new RangeError(
        `packJustifiedRows: aspect at index ${i} must be a positive finite number, got ${aspect}.`,
      )
    }

    if (rowStart < i) {
      // Would adding this item push the row past panelWidth?
      const countWithNew = i - rowStart + 1
      const widthAtTarget = sumWidthsAtTarget(aspects, rowStart, i + 1, targetRowHeight)
      const totalGap = gap * (countWithNew - 1)
      if (widthAtTarget + totalGap > panelWidth) {
        // Close [rowStart, i) justified; item i begins a new row.
        y = placeJustifiedRow(aspects, rowStart, i, targetRowHeight, gap, panelWidth, y, placements, true)
        rowStart = i
      }
    }
  }
  // Flush the final row.
  if (rowStart < aspects.length) {
    y = placeJustifiedRow(
      aspects,
      rowStart,
      aspects.length,
      targetRowHeight,
      gap,
      panelWidth,
      y,
      placements,
      lastRowJustified,
    )
  }

  // y currently includes a trailing gap after the last row; undo it
  // so the container sizes to the actual bottom of the last row.
  return { placements, totalHeight: Math.max(0, y - gap) }
}

function sumWidthsAtTarget(
  aspects: readonly number[],
  start: number,
  end: number,
  targetH: number,
): number {
  let sum = 0
  for (let i = start; i < end; i++) sum += aspects[i]! * targetH
  return sum
}

// Place items [start, end) as one row, advancing y. If `justify` is
// true, scale the row so widths + gaps == panelWidth exactly. If
// false (last row, default behavior), keep items at targetRowHeight
// and leave whatever whitespace is natural.
function placeJustifiedRow(
  aspects: readonly number[],
  start: number,
  end: number,
  targetH: number,
  gap: number,
  panelWidth: number,
  y: number,
  out: Placement[],
  justify: boolean,
): number {
  const count = end - start
  const totalGap = gap * Math.max(0, count - 1)
  const widthAtTarget = sumWidthsAtTarget(aspects, start, end, targetH)
  const availWidth = panelWidth - totalGap

  const rowH = justify ? targetH * (availWidth / widthAtTarget) : targetH

  let x = 0
  for (let i = start; i < end; i++) {
    const w = aspects[i]! * rowH
    out[i] = { x, y, width: w, height: rowH }
    x += w + gap
  }
  return y + rowH + gap
}

// --- Justified-rows cursor (streaming) ---
//
// Cursor form of the justified-row packer. Aspects arrive one at a
// time; the cursor buffers them into an "open" row and only emits
// placements when a row closes (the next aspect would overflow
// panelWidth at targetRowHeight). A trailing `finish()` flushes any
// items still in the buffer.
//
// This is stable under incremental appending the same way the
// shortest-column cursor is: once a row is closed, its placements
// never change. Items still in the buffer don't have placements yet
// — callers that want to show a pending state can track the add-
// order index and render a placeholder.
//
// Unlike `shortestColumnCursor`, `add(aspect)` does not return a
// single Placement; it returns the items (possibly zero) that this
// add just finalized by closing the prior row.

export type JustifiedRowsCursorConfig = {
  panelWidth: number
  targetRowHeight: number
  gap: number
}

export type JustifiedRowClose = {
  index: number
  placement: Placement
}

export type JustifiedRowAddResult = {
  // Items whose placements were finalized by this add. Empty when
  // the new aspect fit into the open row without closing it. Non-
  // empty when this add triggered a row close (the closed row's
  // items are placed, then the new aspect opens a fresh row).
  closed: JustifiedRowClose[]
}

export type JustifiedRowCursor = {
  add(aspect: number): JustifiedRowAddResult
  // Place the items still buffered in the open row and return their
  // placements. `justifyLast: false` (default) leaves the trailing
  // row at targetRowHeight; `true` scales it to fill panelWidth.
  finish(justifyLast?: boolean): JustifiedRowClose[]
  totalHeight(): number
  count(): number
  // Number of items currently buffered in the open row (not yet
  // placed). Useful for callers that want to show a placeholder for
  // pending items.
  pendingCount(): number
  reset(): void
}

export function justifiedRowCursor(config: JustifiedRowsCursorConfig): JustifiedRowCursor {
  const { panelWidth, targetRowHeight, gap } = config
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) {
    throw new RangeError(`justifiedRowCursor: panelWidth must be positive, got ${panelWidth}.`)
  }
  if (!Number.isFinite(targetRowHeight) || targetRowHeight <= 0) {
    throw new RangeError(
      `justifiedRowCursor: targetRowHeight must be positive, got ${targetRowHeight}.`,
    )
  }
  if (!Number.isFinite(gap) || gap < 0) {
    throw new RangeError(`justifiedRowCursor: gap must be non-negative, got ${gap}.`)
  }

  let openAspects: number[] = []
  let openIndices: number[] = []
  let nextIndex = 0
  let y = 0

  function closeOpen(justify: boolean): JustifiedRowClose[] {
    if (openAspects.length === 0) return []
    const count = openAspects.length
    const totalGap = gap * Math.max(0, count - 1)
    let widthAtTarget = 0
    for (let i = 0; i < count; i++) widthAtTarget += openAspects[i]! * targetRowHeight
    const availWidth = panelWidth - totalGap
    const rowH = justify ? targetRowHeight * (availWidth / widthAtTarget) : targetRowHeight
    const closed: JustifiedRowClose[] = []
    let x = 0
    for (let i = 0; i < count; i++) {
      const w = openAspects[i]! * rowH
      closed.push({ index: openIndices[i]!, placement: { x, y, width: w, height: rowH } })
      x += w + gap
    }
    y += rowH + gap
    openAspects = []
    openIndices = []
    return closed
  }

  return {
    add(aspect: number): JustifiedRowAddResult {
      if (!Number.isFinite(aspect) || aspect <= 0) {
        throw new RangeError(`justifiedRowCursor.add: aspect must be positive, got ${aspect}.`)
      }
      const idx = nextIndex++

      if (openAspects.length > 0) {
        let widthIfAdded = aspect * targetRowHeight
        for (let i = 0; i < openAspects.length; i++) {
          widthIfAdded += openAspects[i]! * targetRowHeight
        }
        const gapsIfAdded = gap * openAspects.length
        if (widthIfAdded + gapsIfAdded > panelWidth) {
          const closed = closeOpen(true)
          openAspects.push(aspect)
          openIndices.push(idx)
          return { closed }
        }
      }
      openAspects.push(aspect)
      openIndices.push(idx)
      return { closed: [] }
    },
    finish(justifyLast = false): JustifiedRowClose[] {
      return closeOpen(justifyLast)
    },
    totalHeight(): number {
      // Whatever's been closed so far. Pending items contribute
      // nothing until finish() is called.
      return Math.max(0, y - gap)
    },
    count(): number {
      return nextIndex
    },
    pendingCount(): number {
      return openAspects.length
    },
    reset(): void {
      openAspects = []
      openIndices = []
      nextIndex = 0
      y = 0
    },
  }
}

// --- Visibility query ---
//
// Given a set of placements and a vertical window [viewTop, viewBottom],
// return the indices of placements that overlap. Optional `overscan`
// widens the window above and below — useful for pre-mounting tiles
// that are about to scroll into view so the user doesn't see blank
// space during a fast scroll.
//
// Linear scan in placement order. For ~10k placements at 60Hz that's
// under a millisecond per frame. Callers with larger sets or tighter
// budgets can index by y-bucket externally; the math here doesn't
// assume sortedness because shortest-column placements are emitted in
// item-add order, not y-order.

export type VisibilityWindow = {
  viewTop: number
  viewBottom: number
  overscan?: number
}

export function visibleIndices(
  placements: readonly Placement[],
  window: VisibilityWindow,
): number[] {
  const overscan = window.overscan ?? 0
  const top = window.viewTop - overscan
  const bottom = window.viewBottom + overscan
  const out: number[] = []
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!
    if (p.y + p.height < top) continue
    if (p.y > bottom) continue
    out.push(i)
  }
  return out
}
