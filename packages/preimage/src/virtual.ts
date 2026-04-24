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
//   - optional priority helpers for deciding which mounted resources
//     should load first
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

import {
  createLinearPredictor,
  type ScrollPredictor,
  type ScrollSample,
} from './predict.js'

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

export type VirtualScrollDirection = -1 | 0 | 1

export type VirtualViewportRange = {
  top: number
  bottom: number
  height: number
  center: number
}

export type VirtualPriorityBand =
  | 'visible'
  | 'predicted'
  | 'ahead'
  | 'near'
  | 'behind'

export type VirtualPriorityContext = {
  current: VirtualViewportRange
  predicted: VirtualViewportRange | null
  direction: VirtualScrollDirection
}

export type VirtualPlacementPriority = {
  band: VirtualPriorityBand
  score: number
  distance: number
}

export type VirtualPriorityTrackerOptions = {
  scrollContainer: HTMLElement
  contentContainer: HTMLElement
  predictor?: ScrollPredictor
  horizonMs?: number
  maxSamples?: number
  sampleDedupeMs?: number
  minPredictionDeltaPx?: number
  minPredictionConfidence?: number
  minScrollVelocityPxPerMs?: number
}

export type VirtualPriorityTracker = {
  sample(force?: boolean): ScrollSample
  context(): VirtualPriorityContext
  priority(placement: Placement): VirtualPlacementPriority
  score(placement: Placement): number
}

const VIRTUAL_PRIORITY_VISIBLE = 400_000
const VIRTUAL_PRIORITY_PREDICTED = 300_000
const VIRTUAL_PRIORITY_AHEAD = 200_000
const VIRTUAL_PRIORITY_NEAR = 100_000
const VIRTUAL_PRIORITY_BEHIND = 0
const VIRTUAL_PRIORITY_DISTANCE_CAP = 99_999
const DEFAULT_PRIORITY_HORIZON_MS = 250
const DEFAULT_PRIORITY_MAX_SAMPLES = 12
const DEFAULT_PRIORITY_MIN_DELTA_PX = 8
const DEFAULT_PRIORITY_MIN_CONFIDENCE = 0.2
const DEFAULT_PRIORITY_MIN_VELOCITY_PX_PER_MS = 0.02

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

export function createVirtualPriorityTracker(
  options: VirtualPriorityTrackerOptions,
): VirtualPriorityTracker {
  const predictor = options.predictor ?? createLinearPredictor({ smoothingWindow: 2 })
  const horizonMs = positiveFiniteOption('horizonMs', options.horizonMs, DEFAULT_PRIORITY_HORIZON_MS)
  const maxSamples = positiveIntegerOption('maxSamples', options.maxSamples, DEFAULT_PRIORITY_MAX_SAMPLES)
  const sampleDedupeMs = nonNegativeFiniteOption('sampleDedupeMs', options.sampleDedupeMs, horizonMs)
  const minPredictionDeltaPx = nonNegativeFiniteOption(
    'minPredictionDeltaPx',
    options.minPredictionDeltaPx,
    DEFAULT_PRIORITY_MIN_DELTA_PX,
  )
  const minPredictionConfidence = confidenceOption(
    'minPredictionConfidence',
    options.minPredictionConfidence,
    DEFAULT_PRIORITY_MIN_CONFIDENCE,
  )
  const minScrollVelocityPxPerMs =
    nonNegativeFiniteOption(
      'minScrollVelocityPxPerMs',
      options.minScrollVelocityPxPerMs,
      DEFAULT_PRIORITY_MIN_VELOCITY_PX_PER_MS,
    )
  const samples: ScrollSample[] = []

  function sample(force = false): ScrollSample {
    const y = options.scrollContainer.scrollTop
    const now = performance.now()
    const last = samples[samples.length - 1]
    if (!force && last !== undefined && last.y === y && now - last.t < sampleDedupeMs) {
      return last
    }
    const t = last !== undefined && now <= last.t ? last.t + 0.001 : now
    samples.push({ t, y })
    while (samples.length > maxSamples) samples.shift()
    return samples[samples.length - 1]!
  }

  function context(): VirtualPriorityContext {
    sample()
    return createVirtualPriorityContext({
      scrollContainer: options.scrollContainer,
      contentContainer: options.contentContainer,
      predictor,
      samples,
      horizonMs,
      minPredictionDeltaPx,
      minPredictionConfidence,
      minScrollVelocityPxPerMs,
    })
  }

  sample(true)

  return {
    sample,
    context,
    priority(placement) {
      return virtualPlacementPriority(placement, context())
    },
    score(placement) {
      return scoreVirtualPlacement(placement, context())
    },
  }
}

export function createVirtualPriorityContext(options: {
  scrollContainer: HTMLElement
  contentContainer: HTMLElement
  predictor: ScrollPredictor
  samples: readonly ScrollSample[]
  horizonMs?: number
  minPredictionDeltaPx?: number
  minPredictionConfidence?: number
  minScrollVelocityPxPerMs?: number
}): VirtualPriorityContext {
  const horizonMs = positiveFiniteOption('horizonMs', options.horizonMs, DEFAULT_PRIORITY_HORIZON_MS)
  const minPredictionDeltaPx = nonNegativeFiniteOption(
    'minPredictionDeltaPx',
    options.minPredictionDeltaPx,
    DEFAULT_PRIORITY_MIN_DELTA_PX,
  )
  const minPredictionConfidence = confidenceOption(
    'minPredictionConfidence',
    options.minPredictionConfidence,
    DEFAULT_PRIORITY_MIN_CONFIDENCE,
  )
  const minScrollVelocityPxPerMs =
    nonNegativeFiniteOption(
      'minScrollVelocityPxPerMs',
      options.minScrollVelocityPxPerMs,
      DEFAULT_PRIORITY_MIN_VELOCITY_PX_PER_MS,
    )
  const current = getVirtualViewportRange(options.scrollContainer, options.contentContainer)
  const prediction = options.predictor.predict(options.samples, horizonMs)
  const delta = prediction.y - options.scrollContainer.scrollTop
  const velocity = latestVelocity(options.samples)
  const direction = virtualScrollDirection(delta, velocity, minPredictionDeltaPx, minScrollVelocityPxPerMs)
  const predicted =
    prediction.confidence > minPredictionConfidence &&
    Math.abs(delta) >= minPredictionDeltaPx
      ? shiftRange(current, delta)
      : null
  return { current, predicted, direction }
}

export function getVirtualViewportRange(
  scrollContainer: HTMLElement,
  contentContainer: HTMLElement,
): VirtualViewportRange {
  const scrollTop = scrollContainer.scrollTop
  const scrollRect = scrollContainer.getBoundingClientRect()
  const contentRect = contentContainer.getBoundingClientRect()
  const contentOffsetTop = contentRect.top - scrollRect.top + scrollTop
  const top = scrollTop - contentOffsetTop
  const bottom = scrollTop + scrollContainer.clientHeight - contentOffsetTop
  return { top, bottom, height: bottom - top, center: (top + bottom) / 2 }
}

export function placementGapToRange(place: Placement, range: VirtualViewportRange): number {
  const placeBottom = place.y + place.height
  if (placeBottom < range.top) return range.top - placeBottom
  if (place.y > range.bottom) return place.y - range.bottom
  return 0
}

export function placementIntersectsRange(place: Placement, range: VirtualViewportRange): boolean {
  return placementGapToRange(place, range) === 0
}

export function scoreVirtualPlacement(place: Placement, context: VirtualPriorityContext): number {
  return virtualPlacementPriority(place, context).score
}

export function virtualPlacementPriority(
  place: Placement,
  context: VirtualPriorityContext,
): VirtualPlacementPriority {
  const visibleGap = placementGapToRange(place, context.current)
  if (visibleGap === 0) {
    const distance = distanceToRangeCenter(place, context.current)
    return {
      band: 'visible',
      distance,
      score: VIRTUAL_PRIORITY_VISIBLE - cappedDistance(distance),
    }
  }

  if (context.predicted !== null && placementGapToRange(place, context.predicted) === 0) {
    const distance = distanceToRangeCenter(place, context.predicted)
    return {
      band: 'predicted',
      distance,
      score: VIRTUAL_PRIORITY_PREDICTED - cappedDistance(distance),
    }
  }

  const aheadDistance = distanceAhead(place, context.current, context.direction)
  if (aheadDistance !== null) {
    return {
      band: 'ahead',
      distance: aheadDistance,
      score: VIRTUAL_PRIORITY_AHEAD - cappedDistance(aheadDistance),
    }
  }

  if (context.direction === 0) {
    return {
      band: 'near',
      distance: visibleGap,
      score: VIRTUAL_PRIORITY_NEAR - cappedDistance(visibleGap),
    }
  }

  return {
    band: 'behind',
    distance: visibleGap,
    score: VIRTUAL_PRIORITY_BEHIND - cappedDistance(visibleGap),
  }
}

function shiftRange(range: VirtualViewportRange, delta: number): VirtualViewportRange {
  const top = range.top + delta
  const bottom = range.bottom + delta
  return { top, bottom, height: range.height, center: range.center + delta }
}

function distanceToRangeCenter(place: Placement, range: VirtualViewportRange): number {
  return Math.abs(place.y + place.height / 2 - range.center)
}

function distanceAhead(
  place: Placement,
  range: VirtualViewportRange,
  direction: VirtualScrollDirection,
): number | null {
  if (direction > 0 && place.y >= range.bottom) return place.y - range.bottom
  if (direction < 0 && place.y + place.height <= range.top) return range.top - (place.y + place.height)
  return null
}

function virtualScrollDirection(
  delta: number,
  velocity: number,
  minPredictionDeltaPx: number,
  minScrollVelocityPxPerMs: number,
): VirtualScrollDirection {
  if (Math.abs(delta) >= minPredictionDeltaPx) return delta > 0 ? 1 : -1
  if (Math.abs(velocity) >= minScrollVelocityPxPerMs) return velocity > 0 ? 1 : -1
  return 0
}

function cappedDistance(distance: number): number {
  return Math.min(distance, VIRTUAL_PRIORITY_DISTANCE_CAP)
}

function positiveFiniteOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`virtual priority: ${name} must be positive, got ${resolved}.`)
  }
  return resolved
}

function nonNegativeFiniteOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`virtual priority: ${name} must be non-negative, got ${resolved}.`)
  }
  return resolved
}

function positiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new RangeError(`virtual priority: ${name} must be a positive integer, got ${resolved}.`)
  }
  return resolved
}

function confidenceOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new RangeError(`virtual priority: ${name} must be between 0 and 1, got ${resolved}.`)
  }
  return resolved
}

function latestVelocity(samples: readonly ScrollSample[]): number {
  if (samples.length < 2) return 0
  const a = samples[samples.length - 2]!
  const b = samples[samples.length - 1]!
  const dt = b.t - a.t
  return dt > 0 ? (b.y - a.y) / dt : 0
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
  // resolve in a probe-driven gallery). Reading scrollTop/clientHeight from the
  // DOM would force a layout flush on each call — right after the
  // caller likely wrote to contentContainer.style.height — turning
  // the run into N layout thrashes. Instead we read the DOM only when
  // something actually moved: on scroll events, and on container
  // resize via ResizeObserver. refresh() reads the cache and never
  // touches layout.
  let cachedScrollTop = scrollContainer.scrollTop
  let cachedClientHeight = scrollContainer.clientHeight
  // Offset of contentContainer within scrollContainer's content. Matters
  // when contentContainer isn't flush with the top of the scroll area —
  // e.g. a header/sibling above it or padding on scrollContainer. Without
  // this translation, tiles placed at p.y = 0 in contentContainer's frame
  // would be treated as visible at scrollTop = 0 even when there's a
  // 100px header pushing them below the fold.
  let cachedContentOffsetTop = measureContentOffsetTop()

  function measureContentOffsetTop(): number {
    const scrollRect = scrollContainer.getBoundingClientRect()
    const contentRect = contentContainer.getBoundingClientRect()
    return contentRect.top - scrollRect.top + scrollContainer.scrollTop
  }

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
    //
    // `cachedContentOffsetTop` translates scrollContainer-frame scroll
    // position into contentContainer-frame so placements (which are in
    // contentContainer-frame) can be compared directly.
    const topOver = scrollDir === 1 ? behind : ahead
    const bottomOver = scrollDir === 1 ? ahead : behind
    const top = scrollTop - topOver - cachedContentOffsetTop
    const bottom = scrollTop + cachedClientHeight + bottomOver - cachedContentOffsetTop

    const wanted = new Map<number, Placement>()
    for (const [i, p] of placements.entries()) {
      if (p.y + p.height < top) continue
      if (p.y > bottom) continue
      wanted.set(i, p)
    }

    for (const [idx, el] of active) {
      if (!wanted.has(idx)) {
        active.delete(idx)
        release(idx, el)
      }
    }

    for (const [idx, p] of wanted) {
      if (active.has(idx)) continue
      const el = acquire()
      active.set(idx, el)
      mount(idx, el, p)
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

  // Container resize: refresh cached clientHeight AND the content
  // offset, then recompute. Observing scrollContainer catches browser
  // resize and parent layout changes. We intentionally don't observe
  // contentContainer: the caller typically sets contentContainer.style
  // .height to the total layout height on every placement update, so
  // observing it would fire on every probe resolve and undo the
  // scroll-metric caching we just did. Callers whose layouts have
  // siblings above contentContainer that change size independently
  // should call pool.refresh() themselves after the mutation.
  const hasResizeObserver = typeof ResizeObserver !== 'undefined'
  const resizeObserver = hasResizeObserver
    ? new ResizeObserver(() => {
        cachedClientHeight = scrollContainer.clientHeight
        cachedContentOffsetTop = measureContentOffsetTop()
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
