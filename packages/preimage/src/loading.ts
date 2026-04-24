// Gallery loading patterns. Wraps the probe + pool + packer dance
// with a named pattern knob so callers (and benches) can swap the
// sequencing without rewriting the orchestration each time.
//
// Five patterns ship in v1; add new ones by branching `loadGallery`:
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
//   'viewport-first'    UX-focused sequence: first-screen probes get
//                       placed as skeletons in URL order, then the
//                       current viewport's images jump the render
//                       queue, then the rest of the mounted/overscan
//                       images trickle through the same throttled
//                       render queue. Scroll events keep promoting
//                       newly visible mounted tiles.
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
  | 'viewport-first'

export type GalleryPhase =
  | 'start'
  | 'first-placement'
  | 'all-placements'
  | 'first-image'
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

  // Probe-based patterns ('streamed', 'skeleton-first', 'throttled', 'viewport-first'):
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

  // Aspect ratio per URL index. Required for 'manifest-hydrated';
  // when provided to 'viewport-first', frames can commit immediately
  // while image fetches still follow the viewport-first sequencing.
  aspects?: readonly number[]

  // 'throttled' only: concurrency of the render-phase image fetches.
  renderConcurrency?: number

  /** Called with milestone timestamps relative to `loadGallery` start. */
  onPhase?: (phase: GalleryPhase, elapsedMs: number) => void
}

export type Gallery = {
  pool: VirtualTilePool
  /** Resolves once every probe + initially viewport-visible image has
   *  reached load/error. */
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
    case 'viewport-first':
      return runViewportFirst(config, emit)
  }
}

// --- Pattern: streamed ---

function runStreamed(config: GalleryConfig, emit: (p: GalleryPhase) => void): Gallery {
  const { urls, packer } = config
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  function attachImage(idx: number, el: HTMLElement): Promise<void> | null {
    const url = indexUrl[idx]
    if (url === undefined) return null
    config.renderImage(el, idx, url)
    const load = waitForImage(el, () => {
      if (!firstImageEmitted) {
        firstImageEmitted = true
        emit('first-image')
      }
    })
    imageLoads.set(idx, { el, promise: load })
    return load
  }

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    attachImage(idx, el)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    imageLoads.delete(idx)
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
  ).then(async () => {
    emit('all-placements')
    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    await waitForVisibleLoads(mountedTiles, imageLoads)
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
  const imageLoads = new Map<number, ImageLoad>()
  let renderPhase = false
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  function attachImage(idx: number, el: HTMLElement): Promise<void> | null {
    const url = indexUrl[idx]
    if (url === undefined) return null
    config.renderImage(el, idx, url)
    const load = waitForImage(el, () => {
      if (!firstImageEmitted) {
        firstImageEmitted = true
        emit('first-image')
      }
    })
    imageLoads.set(idx, { el, promise: load })
    return load
  }

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    if (renderPhase) attachImage(idx, el)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    imageLoads.delete(idx)
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
  ).then(async () => {
    // Final placements flush (in case any rAF hadn't fired yet) then
    // flip render phase.
    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    emit('all-placements')
    renderPhase = true
    const visibleLoads: Promise<void>[] = []
    for (const [idx, el] of mountedTiles) {
      const load = attachImage(idx, el)
      if (load !== null) visibleLoads.push(load)
    }
    await Promise.all(visibleLoads)
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
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    config.renderImage(el, idx, urls[idx]!)
    const load = waitForImage(el, () => {
      if (!firstImageEmitted) {
        firstImageEmitted = true
        emit('first-image')
      }
    })
    imageLoads.set(idx, { el, promise: load })
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    imageLoads.delete(idx)
  })

  config.contentContainer.style.height = `${packer.totalHeight()}px`
  pool.setPlacements(placements)
  const done = waitForVisibleLoads(mountedTiles, imageLoads).then(() => {
    emit('done')
  })

  return {
    pool,
    done,
    destroy: () => pool.destroy(),
  }
}

// --- Pattern: throttled ---

function runThrottled(config: GalleryConfig, emit: (p: GalleryPhase) => void): Gallery {
  const { urls, packer } = config
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  // Internal render queue: simple FIFO with a concurrency cap. We
  // don't reuse PrepareQueue because its semantics (dedup by key,
  // boost, etc.) don't match an image-render backlog — here we want
  // plain FIFO with bounded in-flight.
  const renderCap = config.renderConcurrency ?? 8
  const renderQueue: RenderJob[] = []
  let renderInflight = 0
  function pumpRender(): void {
    while (renderInflight < renderCap && renderQueue.length > 0) {
      const job = renderQueue.shift()!
      const currentLoad = imageLoads.get(job.idx)
      const currentEl = mountedTiles.get(job.idx)
      if (
        currentLoad === undefined ||
        currentLoad.el !== job.el ||
        currentLoad.promise !== job.promise ||
        currentEl !== job.el ||
        job.el.querySelector('img') !== null
      ) {
        if (currentLoad?.el === job.el && currentLoad.promise === job.promise) {
          imageLoads.delete(job.idx)
        }
        job.resolve()
        continue
      }
      renderInflight++
      config.renderImage(job.el, job.idx, job.url)
      void waitForImage(job.el, () => {
        if (!firstImageEmitted) {
          firstImageEmitted = true
          emit('first-image')
        }
      }).then(job.resolve).finally(() => {
        const latest = imageLoads.get(job.idx)
        if (latest?.el === job.el && latest.promise === job.promise) {
          imageLoads.delete(job.idx)
        }
        renderInflight--
        pumpRender()
      })
    }
  }
  function enqueueRender(idx: number, el: HTMLElement, url: string): Promise<void> {
    const existing = imageLoads.get(idx)
    if (existing?.el === el) return existing.promise
    let resolveJob!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveJob = resolve
    })
    imageLoads.set(idx, { el, promise })
    renderQueue.push({ idx, el, url, promise, resolve: resolveJob })
    pumpRender()
    return promise
  }

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    const url = indexUrl[idx]
    if (url !== undefined) enqueueRender(idx, el, url)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    const load = imageLoads.get(idx)
    if (load?.el === _el) imageLoads.delete(idx)
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
  ).then(async () => {
    emit('all-placements')
    // After all probes resolve, ensure any still-mounted tiles
    // without an in-flight render get queued. mount fires before
    // indexUrl is set if probe resolution order differs from pool
    // mount order; guard against that by sweeping here.
    const visibleLoads: Promise<void>[] = []
    for (const [idx, el] of mountedTiles) {
      const url = indexUrl[idx]
      if (url !== undefined && el.querySelector('img') === null) {
        visibleLoads.push(enqueueRender(idx, el, url))
      } else {
        const load = imageLoads.get(idx)
        if (load?.el === el) visibleLoads.push(load.promise)
      }
    }
    await Promise.all(visibleLoads)
    emit('done')
  })

  maybeBoost(queue, urls, config)
  return {
    pool,
    done,
    destroy: () => pool.destroy(),
  }
}

// --- Pattern: viewport-first ---

function runViewportFirst(config: GalleryConfig, emit: (p: GalleryPhase) => void): Gallery {
  const { urls, packer } = config
  const readyAspects: Array<number | null> = new Array(urls.length).fill(null)
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()
  let nextPlaceIndex = 0
  let firstPlacementEmitted = false
  let firstImageEmitted = false
  let viewportRenderStarted = false
  let normalRenderEnabled = false

  const firstScreenTarget = Math.min(config.probe?.boostFirstScreen ?? 0, urls.length)
  const renderCap = config.renderConcurrency ?? 8
  const renderQueue: PriorityRenderJob[] = []
  let renderInflight = 0

  function pumpRender(): void {
    while (renderInflight < renderCap && renderQueue.length > 0) {
      const job = renderQueue.shift()!
      job.started = true
      const currentLoad = imageLoads.get(job.idx)
      const currentEl = mountedTiles.get(job.idx)
      if (
        currentLoad === undefined ||
        currentLoad.el !== job.el ||
        currentLoad.promise !== job.promise ||
        currentEl !== job.el ||
        job.el.querySelector('img') !== null
      ) {
        if (currentLoad?.el === job.el && currentLoad.promise === job.promise) {
          imageLoads.delete(job.idx)
        }
        job.resolve()
        continue
      }
      renderInflight++
      config.renderImage(job.el, job.idx, job.url)
      void waitForImage(job.el, () => {
        if (!firstImageEmitted) {
          firstImageEmitted = true
          emit('first-image')
        }
      }).then(job.resolve).finally(() => {
        const latest = imageLoads.get(job.idx)
        if (latest?.el === job.el && latest.promise === job.promise) {
          imageLoads.delete(job.idx)
        }
        renderInflight--
        pumpRender()
      })
    }
  }

  function promoteQueuedJob(idx: number, el: HTMLElement, promise: Promise<void>): void {
    const queuedIndex = renderQueue.findIndex(
      (job) => !job.started && job.idx === idx && job.el === el && job.promise === promise,
    )
    if (queuedIndex <= 0) return
    const [job] = renderQueue.splice(queuedIndex, 1)
    if (job !== undefined) {
      job.priority = 'high'
      renderQueue.unshift(job)
    }
  }

  function enqueueRender(
    idx: number,
    el: HTMLElement,
    url: string,
    priority: RenderPriority,
  ): Promise<void> {
    const existing = imageLoads.get(idx)
    if (existing?.el === el) {
      if (priority === 'high') promoteQueuedJob(idx, el, existing.promise)
      return existing.promise
    }
    if (el.querySelector('img') !== null) return Promise.resolve()

    let resolveJob!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveJob = resolve
    })
    const job: PriorityRenderJob = { idx, el, url, priority, promise, resolve: resolveJob, started: false }
    imageLoads.set(idx, { el, promise })
    if (priority === 'high') renderQueue.unshift(job)
    else renderQueue.push(job)
    pumpRender()
    return promise
  }

  function enqueueMountedImage(idx: number, el: HTMLElement): Promise<void> | null {
    if (!viewportRenderStarted) return null
    const url = indexUrl[idx]
    const place = placements[idx]
    if (url === undefined || place === undefined) return null
    const isViewport = isInViewport(config, place)
    if (!isViewport && !normalRenderEnabled) return null
    return enqueueRender(idx, el, url, isViewport ? 'high' : 'normal')
  }

  function enqueueMountedImages(): Promise<void>[] {
    const loads: Promise<void>[] = []
    for (const [idx, el] of mountedTiles) {
      const load = enqueueMountedImage(idx, el)
      if (load !== null) loads.push(load)
    }
    return loads
  }

  function startViewportRenderIfReady(): void {
    if (viewportRenderStarted) return
    if (urls.length > 0 && placements.length === 0) return
    if (nextPlaceIndex < firstScreenTarget) return

    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    viewportRenderStarted = true
    const firstViewportLoads = enqueueMountedImages()
    void Promise.all(firstViewportLoads).then(() => {
      normalRenderEnabled = true
      enqueueMountedImages()
    })
  }

  function placeReadyAspects(): void {
    while (nextPlaceIndex < urls.length) {
      const aspect = readyAspects[nextPlaceIndex]
      if (aspect === null || aspect === undefined) break
      placements.push(packer.add(aspect))
      indexUrl.push(urls[nextPlaceIndex]!)
      nextPlaceIndex++
      if (!firstPlacementEmitted) {
        firstPlacementEmitted = true
        emit('first-placement')
      }
    }
    if (placements.length > 0) scheduleRender(config, placements, pool)
    startViewportRenderIfReady()
  }

  const pool = createPool(config, (idx, el, place) => {
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    enqueueMountedImage(idx, el)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    const load = imageLoads.get(idx)
    if (load?.el === _el) imageLoads.delete(idx)
  })

  let viewportBoostPending = false
  function scheduleViewportBoost(): void {
    if (viewportBoostPending) return
    viewportBoostPending = true
    requestAnimationFrame(() => {
      viewportBoostPending = false
      enqueueMountedImages()
    })
  }
  config.scrollContainer.addEventListener('scroll', scheduleViewportBoost, { passive: true })

  if (config.aspects !== undefined) {
    if (config.aspects.length !== urls.length) {
      throw new Error("loadGallery: aspects[] must match urls.length")
    }
    const done = (async (): Promise<void> => {
      for (let i = 0; i < urls.length; i++) readyAspects[i] = config.aspects![i]!
      placeReadyAspects()
      config.contentContainer.style.height = `${packer.totalHeight()}px`
      pool.setPlacements(placements)
      emit('all-placements')
      startViewportRenderIfReady()
      await waitForVisibleLoads(mountedTiles, imageLoads)
      emit('done')
    })()
    return {
      pool,
      done,
      destroy: () => {
        config.scrollContainer.removeEventListener('scroll', scheduleViewportBoost)
        pool.destroy()
      },
    }
  }

  const queue = getQueue(config)
  const options = getProbeOptions(config)
  const done = Promise.all(
    urls.map((url, index) =>
      queue.enqueue(url, options).then((prepared) => {
        readyAspects[index] = prepared.aspectRatio
        placeReadyAspects()
      }),
    ),
  ).then(async () => {
    placeReadyAspects()
    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    emit('all-placements')
    startViewportRenderIfReady()
    normalRenderEnabled = true
    enqueueMountedImages()
    await waitForVisibleLoads(mountedTiles, imageLoads)
    emit('done')
  })

  maybeBoost(queue, urls, config)
  return {
    pool,
    done,
    destroy: () => {
      config.scrollContainer.removeEventListener('scroll', scheduleViewportBoost)
      pool.destroy()
    },
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

type ImageLoad = {
  el: HTMLElement
  promise: Promise<void>
}

type RenderJob = {
  idx: number
  el: HTMLElement
  url: string
  promise: Promise<void>
  resolve: () => void
}

type RenderPriority = 'high' | 'normal'

type PriorityRenderJob = RenderJob & {
  priority: RenderPriority
  started: boolean
}

function isInViewport(config: GalleryConfig, place: Placement): boolean {
  const scrollTop = config.scrollContainer.scrollTop
  const scrollRect = config.scrollContainer.getBoundingClientRect()
  const contentRect = config.contentContainer.getBoundingClientRect()
  const contentOffsetTop = contentRect.top - scrollRect.top + scrollTop
  const top = scrollTop - contentOffsetTop
  const bottom = scrollTop + config.scrollContainer.clientHeight - contentOffsetTop
  return place.y + place.height >= top && place.y <= bottom
}

function waitForVisibleLoads(
  mountedTiles: ReadonlyMap<number, HTMLElement>,
  imageLoads: ReadonlyMap<number, ImageLoad>,
): Promise<void> {
  const visibleLoads: Promise<void>[] = []
  for (const [idx, el] of mountedTiles) {
    const load = imageLoads.get(idx)
    if (load?.el === el) visibleLoads.push(load.promise)
  }
  return Promise.all(visibleLoads).then(() => {})
}

/** Resolve when the first `<img>` under `el` reaches load/error. No-op
 *  if the renderer did not create one. */
function waitForImage(el: HTMLElement, onLoad: () => void): Promise<void> {
  const img = el.querySelector('img')
  if (img === null) return Promise.resolve()
  if (img.complete) {
    onLoad()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      onLoad()
      resolve()
    }
    img.addEventListener('load', done, { once: true })
    img.addEventListener('error', done, { once: true })
  })
}

export type { Placement, VirtualTilePool, PreparedImage, PrepareQueueLike }
