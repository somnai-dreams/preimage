// Virtual tile pool — DOM recycling for a scrollable grid whose
// tiles come from a `Placement[]` (typically from layout-algebra's
// `packShortestColumn` or `shortestColumnCursor`).
//
// The helper manages:
//   - a pool of reusable `<div>`s that live inside the content
//     container (created lazily, reused as tiles scroll in and out)
//   - a rAF-throttled scroll listener on the scroll container
//   - a Map of currently-mounted tiles keyed by placement index
//   - mount/unmount callbacks where the caller does their rendering
//
// It is intentionally headless about content: the caller's `mount`
// callback receives an absolutely-positioned `<div>` plus the index
// and placement, and fills it with whatever (<img>, canvas, text).
// `unmount` is the place to cancel in-flight image fetches
// (`img.src = ''`), clear innerHTML, release bitmaps, etc.
//
// Usage:
//
//   const pool = createVirtualTilePool({
//     scrollContainer, contentContainer, overscan: 600,
//     mount: (idx, el, place) => {
//       el.style.cssText = `left:${place.x}px; top:${place.y}px; ...`
//       const img = new Image()
//       img.src = urls[idx]
//       el.appendChild(img)
//     },
//     unmount: (idx, el) => {
//       const img = el.querySelector('img')
//       if (img) img.src = '' // cancel in-flight fetch
//       el.innerHTML = ''
//     },
//   })
//
//   // As placements resolve:
//   pool.setPlacements(placements)
//
//   // When the page unmounts:
//   pool.destroy()

export type Placement = {
  x: number
  y: number
  width: number
  height: number
}

export type VirtualTilePoolOptions = {
  // Element whose scroll position drives visibility. Usually the
  // overflow:auto container.
  scrollContainer: HTMLElement
  // Element to which pooled tiles are appended. Its height should be
  // set by the caller (usually to the total layout height) so the
  // scroll container has something to scroll.
  contentContainer: HTMLElement
  // Extra pixels around the viewport that still count as visible.
  // Number form = symmetric band above and below.
  // Object form = asymmetric by scroll direction: `ahead` applies in
  // the direction the user just scrolled, `behind` on the other side.
  // Asymmetric is usually what you want — images coming into view
  // need a head start; images leaving can be released aggressively.
  // Default: 200 symmetric.
  overscan?: number | { ahead: number; behind: number }
  // Called when a tile becomes visible. The element is positioned
  // absolutely inside `contentContainer`; the caller is responsible
  // for setting left/top/width/height from `placement`.
  mount: (index: number, element: HTMLElement, placement: Placement) => void
  // Called when a tile scrolls out of the visible band, before the
  // element is returned to the pool. Use this to cancel in-flight
  // resource fetches and clear content. If omitted, the element is
  // pooled as-is (works when mount fully overwrites on reuse).
  unmount?: (index: number, element: HTMLElement) => void
}

export type VirtualTilePool = {
  // Update the placement array and recompute visibility. Call this
  // whenever new tiles are added (e.g. prepare() resolves) or tiles
  // are re-laid-out.
  setPlacements(placements: readonly Placement[]): void
  // Recompute visibility against the current scroll position without
  // replacing placements. Useful after a layout-affecting change to
  // the scroll container's size.
  refresh(): void
  // Stop listening to scroll and unmount every active tile.
  destroy(): void
  // Number of tiles currently mounted (including those in the
  // overscan band).
  readonly activeCount: number
}

function rafThrottle(fn: () => void): () => void {
  let pending = false
  return () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      fn()
    })
  }
}

export function createVirtualTilePool(options: VirtualTilePoolOptions): VirtualTilePool {
  const { scrollContainer, contentContainer, mount, unmount } = options
  const ahead =
    typeof options.overscan === 'object' ? options.overscan.ahead : (options.overscan ?? 200)
  const behind =
    typeof options.overscan === 'object' ? options.overscan.behind : (options.overscan ?? 200)

  let placements: readonly Placement[] = []
  const pool: HTMLElement[] = []
  const active = new Map<number, HTMLElement>()
  let destroyed = false
  // Scroll direction: +1 = down, -1 = up. Starts down so the initial
  // first-paint favors the below-viewport band (the only band that
  // matters when scrolled to the top).
  let scrollDir: 1 | -1 = 1
  let lastScrollTop = scrollContainer.scrollTop
  // Cached scroll metrics. refresh() is called synchronously from
  // setPlacements on every placement update (e.g. per prepare()
  // resolve in a scale demo). Reading scrollTop/clientHeight from the
  // DOM would force a layout flush on each call — right after the
  // caller likely wrote to contentContainer.style.height — turning
  // the run into N layout thrashes. Instead we read the DOM only when
  // something actually moved: on scroll events, and on container
  // resize via ResizeObserver. refresh() reads the cache and never
  // touches layout.
  let cachedScrollTop = scrollContainer.scrollTop
  let cachedClientHeight = scrollContainer.clientHeight

  function acquire(): HTMLElement {
    const reused = pool.pop()
    if (reused !== undefined) {
      reused.style.display = ''
      return reused
    }
    const el = document.createElement('div')
    el.style.position = 'absolute'
    contentContainer.appendChild(el)
    return el
  }

  function release(idx: number, el: HTMLElement): void {
    if (unmount !== undefined) unmount(idx, el)
    el.style.display = 'none'
    pool.push(el)
  }

  function refresh(): void {
    if (destroyed) return
    const scrollTop = cachedScrollTop
    if (scrollTop > lastScrollTop) scrollDir = 1
    else if (scrollTop < lastScrollTop) scrollDir = -1
    lastScrollTop = scrollTop

    // Apply overscan biased toward the scroll direction: the band
    // ahead of travel is larger (so incoming tiles mount in time to
    // paint), the trailing band is smaller (so departing tiles release
    // quickly and their in-flight fetches get cancelled).
    const topOver = scrollDir === 1 ? behind : ahead
    const bottomOver = scrollDir === 1 ? ahead : behind
    const top = scrollTop - topOver
    const bottom = scrollTop + cachedClientHeight + bottomOver

    const wanted = new Set<number>()
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!
      if (p.y + p.height < top) continue
      if (p.y > bottom) continue
      wanted.add(i)
    }

    for (const [idx, el] of active) {
      if (!wanted.has(idx)) {
        active.delete(idx)
        release(idx, el)
      }
    }

    for (const idx of wanted) {
      if (active.has(idx)) continue
      const el = acquire()
      active.set(idx, el)
      mount(idx, el, placements[idx]!)
    }
  }

  // Scroll handler: update cached scrollTop, then refresh. Throttled
  // to rAF so a burst of scroll events coalesces to one DOM read + one
  // visibility recompute per frame.
  const onScroll = rafThrottle(() => {
    cachedScrollTop = scrollContainer.scrollTop
    refresh()
  })
  scrollContainer.addEventListener('scroll', onScroll, { passive: true })

  // Container resize: refresh cached clientHeight, then recompute.
  // Only path that changes clientHeight — browser resize, container
  // parent layout change, explicit style tweaks all come through here.
  const hasResizeObserver = typeof ResizeObserver !== 'undefined'
  const resizeObserver = hasResizeObserver
    ? new ResizeObserver(() => {
        cachedClientHeight = scrollContainer.clientHeight
        refresh()
      })
    : null
  resizeObserver?.observe(scrollContainer)

  return {
    setPlacements(next): void {
      placements = next
      refresh()
    },
    refresh,
    destroy(): void {
      if (destroyed) return
      destroyed = true
      scrollContainer.removeEventListener('scroll', onScroll)
      resizeObserver?.disconnect()
      for (const [idx, el] of active) {
        if (unmount !== undefined) unmount(idx, el)
        el.remove()
      }
      for (const el of pool) el.remove()
      active.clear()
      pool.length = 0
    },
    get activeCount(): number {
      return active.size
    },
  }
}
