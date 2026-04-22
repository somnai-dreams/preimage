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
