// Gallery loading patterns. Wraps the probe + pool + packer dance
// with a named pattern knob so callers (and benches) can swap the
// sequencing without rewriting the orchestration each time.
//
// Four patterns ship in v1; add new ones by branching `loadGallery`:
//
//   'streamed'          Mount-with-image-fetch fires per probe resolve.
//                       User sees a growing, heterogeneous layout:
//                       some tiles have images already, others are
//                       skeletons. Fast to first image, jarring under
//                       the viewport.
//
//   'skeleton-first'    Probes run to completion; placements appear as
//                       skeletons progressively; image fetches start
//                       only after every probe has resolved. Full
//                       skeletons before any image → homogeneous
//                       visual state while probing. Slower to first
//                       image, calmer overall.
//
//   'manifest-hydrated' No probe phase. Caller provides aspects up
//                       front (from a build-time manifest or server
//                       headers). Placements commit synchronously,
//                       image fetches start via the pool's mount as
//                       tiles enter view. Fastest possible.
//
//   'throttled'         Probe queue (high concurrency, e.g. 50) and
//                       render queue (low concurrency, e.g. 8) run
//                       in parallel. Probes stay ahead because
//                       their queue isn't bandwidth-bound by full
//                       image fetches. Middle ground between
//                       streamed and skeleton-first.
//
// The orchestrator owns the pool; callers pass container elements
// plus two small renderers (`renderSkeleton`, `renderImage`) and get
// back a `{ pool, destroy, done }` handle.

import { PrepareQueue } from './prepare-queue.js'
import type { PrepareOptions, PreparedImage } from './prepare.js'
import {
  createVirtualTilePool,
  type Placement,
  type VirtualTilePool,
} from './virtual.js'

/** Structural shape of the bits of `PrepareQueue` the loading
 *  orchestrator actually calls. Accepting this instead of a nominal
 *  class reference lets callers pass in a `PrepareQueue` built from
 *  the package entry point without TS complaining about dist-vs-src
 *  type-identity drift in workspace builds. */
type PrepareQueueLike = {
  enqueue(src: string, options?: PrepareOptions): Promise<PreparedImage>
  boostMany(srcs: readonly string[]): void
}

export type LoadingPattern =
  | 'streamed'
  | 'skeleton-first'
  | 'manifest-hydrated'
  | 'throttled'

export type GalleryPhase =
  | 'start'
  | 'first-placement'
  | 'all-placements'
  | 'first-image'
  | 'all-images'
  | 'done'

/** Pure-math packer cursor. Matches the shape of
 *  `shortestColumnCursor` / `justifiedRowCursor` from layout-algebra;
 *  callers pass whichever they like. For justifiedRows the `add` call
 *  may return multiple placements on row-close; the orchestrator
 *  assumes one-placement-per-add today (shortestColumn semantics). */
export type PackerCursor = {
  add(aspect: number): Placement
  totalHeight(): number
}

export type RenderSkeleton = (el: HTMLElement, idx: number, place: Placement) => void
export type RenderImage = (el: HTMLElement, idx: number, url: string) => void
export type ResetTile = (el: HTMLElement, idx: number) => void

export type GalleryConfig = {
  urls: readonly string[]
  scrollContainer: HTMLElement
  contentContainer: HTMLElement
  packer: PackerCursor
  pattern: LoadingPattern

  renderSkeleton: RenderSkeleton
  renderImage: RenderImage
  /** Called on unmount. Cancel in-flight image fetches here
   *  (e.g. `el.querySelector('img')?.src = ''`). */
  resetTile?: ResetTile

  overscan?: number | { ahead: number; behind: number }

  // Probe-based patterns ('streamed', 'skeleton-first', 'throttled'):
  probe?: {
    /** If omitted, a fresh `PrepareQueue` is constructed with
     *  adaptive default concurrency. */
    queue?: PrepareQueueLike
    /** Options passed to every `enqueue`. Defaults to
     *  `{ dimsOnly: true }`. */
    options?: PrepareOptions
    /** If > 0, the leading K URLs get `queue.boostMany` treatment so
     *  their probes jump the queue. */
    boostFirstScreen?: number
  }

  // 'manifest-hydrated' only: aspect ratio per url index.
  aspects?: readonly number[]

  // 'throttled' only: concurrency of the render-phase image fetches.
  renderConcurrency?: number

  /** Called with milestone timestamps relative to `loadGallery` start. */
  onPhase?: (phase: GalleryPhase, elapsedMs: number) => void
}

export type Gallery = {
  pool: VirtualTilePool
  /** Resolves once every probe + viewport-visible image has landed
   *  (or, for manifest-hydrated, once the first-paint frame fires). */
  done: Promise<void>
  destroy(): void
}

export function loadGallery(config: GalleryConfig): Gallery {
  const t0 = performance.now()
  const emit = (phase: GalleryPhase): void => {
    if (config.onPhase !== undefined) config.onPhase(phase, performance.now() - t0)
  }
  emit('start')

  switch (config.pattern) {
    case 'streamed':
      return runStreamed(config, emit)
    case 'skeleton-first':
      return runSkeletonFirst(config, emit)
    case 'manifest-hydrated':
      return runManifestHydrated(config, emit)
    case 'throttled':
      return runThrottled(config, emit)
  }
}

// --- Pattern: streamed ---

function runStreamed(config: GalleryConfig, emit: (p: GalleryPhase) => void): Gallery {
  const { urls, packer } = config
  const placements: Placement[] = []
  const indexUrl: string[] = []
  let firstPlacementEmitted = false
  let firstImageEmitted = false
  let imagesLoaded = 0

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    const url = indexUrl[idx]
    if (url !== undefined) {
      config.renderImage(el, idx, url)
      markImageListener(el, () => {
        if (!firstImageEmitted) {
          firstImageEmitted = true
          emit('first-image')
        }
        imagesLoaded++
      })
    }
  })

  const queue = getQueue(config)
  const options = getProbeOptions(config)
  const done = Promise.all(
    urls.map((url) =>
      queue.enqueue(url, options).then((prepared) => {
        placements.push(packer.add(prepared.aspectRatio))
        indexUrl.push(url)
        if (!firstPlacementEmitted) {
          firstPlacementEmitted = true
          emit('first-placement')
        }
        scheduleRender(config, placements, pool)
      }),
    ),
  ).then(() => {
    emit('all-placements')
    // Streamed's "all images" milestone is harder — we can't know
    // without tracking mount-to-load per tile across the whole run.
    // The mount callback increments imagesLoaded; we just emit done.
    emit('done')
  })

  maybeBoost(queue, urls, config)
  return {
    pool,
    done,
    destroy: () => pool.destroy(),
  }
}

// --- Pattern: skeleton-first ---

function runSkeletonFirst(config: GalleryConfig, emit: (p: GalleryPhase) => void): Gallery {
  const { urls, packer } = config
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  let renderPhase = false
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  function attachImage(idx: number, el: HTMLElement): void {
    const url = indexUrl[idx]
    if (url === undefined) return
    config.renderImage(el, idx, url)
    markImageListener(el, () => {
      if (!firstImageEmitted) {
        firstImageEmitted = true
        emit('first-image')
      }
    })
  }

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    if (renderPhase) attachImage(idx, el)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
  })

  const queue = getQueue(config)
  const options = getProbeOptions(config)
  const done = Promise.all(
    urls.map((url) =>
      queue.enqueue(url, options).then((prepared) => {
        placements.push(packer.add(prepared.aspectRatio))
        indexUrl.push(url)
        if (!firstPlacementEmitted) {
          firstPlacementEmitted = true
          emit('first-placement')
        }
        scheduleRender(config, placements, pool)
      }),
    ),
  ).then(() => {
    // Final placements flush (in case any rAF hadn't fired yet) then
    // flip render phase.
    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    emit('all-placements')
    renderPhase = true
    for (const [idx, el] of mountedTiles) attachImage(idx, el)
    emit('done')
  })

  maybeBoost(queue, urls, config)
  return {
    pool,
    done,
    destroy: () => pool.destroy(),
  }
}

// --- Pattern: manifest-hydrated ---

function runManifestHydrated(config: GalleryConfig, emit: (p: GalleryPhase) => void): Gallery {
  const { urls, packer, aspects } = config
  if (aspects === undefined || aspects.length !== urls.length) {
    throw new Error("loadGallery: pattern 'manifest-hydrated' requires aspects[] of equal length")
  }
  const placements: Placement[] = []
  for (let i = 0; i < urls.length; i++) placements.push(packer.add(aspects[i]!))
  emit('first-placement')
  emit('all-placements')

  let firstImageEmitted = false

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    config.renderImage(el, idx, urls[idx]!)
    markImageListener(el, () => {
      if (!firstImageEmitted) {
        firstImageEmitted = true
        emit('first-image')
      }
    })
  })

  config.contentContainer.style.height = `${packer.totalHeight()}px`
  pool.setPlacements(placements)
  emit('done')

  return {
    pool,
    done: Promise.resolve(),
    destroy: () => pool.destroy(),
  }
}

// --- Pattern: throttled ---

function runThrottled(config: GalleryConfig, emit: (p: GalleryPhase) => void): Gallery {
  const { urls, packer } = config
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  // Internal render queue: simple FIFO with a concurrency cap. We
  // don't reuse PrepareQueue because its semantics (dedup by key,
  // boost, etc.) don't match an image-render backlog — here we want
  // plain FIFO with bounded in-flight.
  const renderCap = config.renderConcurrency ?? 8
  const renderQueue: Array<() => Promise<void>> = []
  let renderInflight = 0
  function pumpRender(): void {
    while (renderInflight < renderCap && renderQueue.length > 0) {
      const task = renderQueue.shift()!
      renderInflight++
      void task().finally(() => {
        renderInflight--
        pumpRender()
      })
    }
  }
  function enqueueRender(idx: number, el: HTMLElement, url: string): void {
    renderQueue.push(
      () =>
        new Promise<void>((resolve) => {
          config.renderImage(el, idx, url)
          markImageListener(el, () => {
            if (!firstImageEmitted) {
              firstImageEmitted = true
              emit('first-image')
            }
            resolve()
          })
        }),
    )
    pumpRender()
  }

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    const url = indexUrl[idx]
    if (url !== undefined) enqueueRender(idx, el, url)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
  })

  const queue = getQueue(config)
  const options = getProbeOptions(config)
  const done = Promise.all(
    urls.map((url) =>
      queue.enqueue(url, options).then((prepared) => {
        placements.push(packer.add(prepared.aspectRatio))
        indexUrl.push(url)
        if (!firstPlacementEmitted) {
          firstPlacementEmitted = true
          emit('first-placement')
        }
        scheduleRender(config, placements, pool)
      }),
    ),
  ).then(() => {
    emit('all-placements')
    // After all probes resolve, ensure any still-mounted tiles
    // without an in-flight render get queued. mount fires before
    // indexUrl is set if probe resolution order differs from pool
    // mount order; guard against that by sweeping here.
    for (const [idx, el] of mountedTiles) {
      const url = indexUrl[idx]
      if (url !== undefined && el.querySelector('img') === null) {
        enqueueRender(idx, el, url)
      }
    }
    emit('done')
  })

  maybeBoost(queue, urls, config)
  return {
    pool,
    done,
    destroy: () => pool.destroy(),
  }
}

// --- Shared helpers ---

function createPool(
  config: GalleryConfig,
  mount: (idx: number, el: HTMLElement, place: Placement) => void,
  unmount?: (idx: number, el: HTMLElement) => void,
): VirtualTilePool {
  return createVirtualTilePool({
    scrollContainer: config.scrollContainer,
    contentContainer: config.contentContainer,
    overscan: config.overscan ?? 400,
    mount,
    unmount: (idx, el) => {
      if (config.resetTile !== undefined) config.resetTile(el, idx)
      if (unmount !== undefined) unmount(idx, el)
    },
  })
}

function getQueue(config: GalleryConfig): PrepareQueueLike {
  return config.probe?.queue ?? new PrepareQueue()
}

function getProbeOptions(config: GalleryConfig): PrepareOptions {
  return config.probe?.options ?? { dimsOnly: true }
}

function maybeBoost(queue: PrepareQueueLike, urls: readonly string[], config: GalleryConfig): void {
  const k = config.probe?.boostFirstScreen
  if (k !== undefined && k > 0) queue.boostMany(urls.slice(0, k))
}

/** rAF-batched setPlacements so N probes resolving in one tick
 *  collapse into one pool.setPlacements call + one height write. */
function scheduleRender(
  config: GalleryConfig,
  placements: readonly Placement[],
  pool: VirtualTilePool,
): void {
  const state = renderState.get(pool)
  if (state !== undefined && state.pending) return
  const s = state ?? { pending: true }
  s.pending = true
  renderState.set(pool, s)
  requestAnimationFrame(() => {
    s.pending = false
    config.contentContainer.style.height = `${config.packer.totalHeight()}px`
    pool.setPlacements(placements)
  })
}
const renderState = new WeakMap<VirtualTilePool, { pending: boolean }>()

/** Hook a one-shot load/error listener on the first `<img>` under
 *  `el`. No-op if there isn't one. */
function markImageListener(el: HTMLElement, onLoad: () => void): void {
  const img = el.querySelector('img')
  if (img === null) return
  if (img.complete && img.naturalWidth > 0) {
    onLoad()
    return
  }
  img.addEventListener('load', onLoad, { once: true })
  img.addEventListener('error', onLoad, { once: true })
}

export type { Placement, VirtualTilePool, PreparedImage, PrepareQueueLike }
