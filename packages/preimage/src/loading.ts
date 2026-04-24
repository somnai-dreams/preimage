// Gallery image loading helper. Wraps the probe + pool + packer dance
// while keeping the public API around two separate facts:
//
//   aspects       Caller already knows dimensions for each URL. When
//                 present, layout can commit without a probe phase.
//
//   imageLoading  When mounted tiles should start their visible image
//                 requests: visible-first, immediate, after-layout, or
//                 queued.
//
// The orchestrator owns the pool; callers pass container elements
// plus two small renderers (`renderSkeleton`, `renderImage`) and get
// back a `{ pool, destroy, done }` handle.

import { PrepareQueue } from './prepare-queue.js'
import type { PrepareOptions, PreparedImage } from './prepare.js'
import {
  createLinearPredictor,
  type ScrollPredictor,
  type ScrollSample,
} from './predict.js'
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

export type GalleryImageLoading =
  /** Prioritize current viewport images, then let mounted/overscan
   *  images continue through the same bounded render queue. */
  | 'visible-first'
  /** Start an image request as soon as a tile mounts. */
  | 'immediate'
  /** Place the skeleton layout first; start visible image requests
   *  only after every placement is known. */
  | 'after-layout'
  /** Place skeletons as dimensions arrive, then send mounted images
   *  through a bounded queue that promotes visible and predicted-near
   *  viewport tiles. */
  | 'queued'

export type GalleryPhase =
  | 'start'
  | 'first-placement'
  | 'all-placements'
  | 'first-image'
  | 'done'

/** Pure-math packer cursor with shortest-column semantics: every
 *  `add(aspect)` returns exactly one finalized placement. */
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
  /** Controls when mounted tiles start visible image requests.
   *  Defaults to `'queued'`. */
  imageLoading?: GalleryImageLoading

  renderSkeleton: RenderSkeleton
  renderImage: RenderImage
  /** Called on unmount. Cancel in-flight image fetches here
   *  (e.g. `el.querySelector('img')?.src = ''`). */
  resetTile?: ResetTile

  overscan?: number | { ahead: number; behind: number }

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

  // Aspect ratio per URL index. When provided, frames can commit
  // without probing; image fetch sequencing still follows
  // `imageLoading`.
  aspects?: readonly number[]

  // Used by 'visible-first' and 'queued': concurrency of the
  // render-phase image fetches.
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
  const state = createGalleryState()
  const t0 = performance.now()
  const emit = (phase: GalleryPhase): void => {
    if (state.cancelled) return
    if (config.onPhase !== undefined) config.onPhase(phase, performance.now() - t0)
  }
  emit('start')

  const imageLoading = config.imageLoading ?? 'queued'
  switch (imageLoading) {
    case 'immediate':
      return runImmediate(config, state, emit)
    case 'after-layout':
      return runAfterLayout(config, state, emit)
    case 'queued':
      return runQueued(config, state, emit)
    case 'visible-first':
      return runVisibleFirst(config, state, emit)
  }
}

type GalleryState = {
  cancelled: boolean
  abortController: AbortController
  cancelPromise: Promise<void>
  cancel: () => void
  cleanup: Array<() => void>
}

function createGalleryState(): GalleryState {
  let resolveCancel!: () => void
  const state: GalleryState = {
    cancelled: false,
    abortController: new AbortController(),
    cancelPromise: new Promise<void>((resolve) => {
      resolveCancel = resolve
    }),
    cancel: () => {
      if (state.cancelled) return
      state.cancelled = true
      state.abortController.abort(new DOMException('Gallery destroyed', 'AbortError'))
      resolveCancel()
    },
    cleanup: [],
  }
  return state
}

function finishGallery(state: GalleryState, pool: VirtualTilePool, work: Promise<void>): Gallery {
  const guardedWork = work.catch((err) => {
    if (state.cancelled) return
    throw err
  })
  const done = Promise.race([guardedWork, state.cancelPromise]).then(() => {})
  return {
    pool,
    done,
    destroy: () => {
      if (state.cancelled) return
      state.cancel()
      for (const cleanup of state.cleanup.splice(0)) cleanup()
      pool.destroy()
    },
  }
}

// --- Image loading: immediate ---

function runImmediate(
  config: GalleryConfig,
  state: GalleryState,
  emit: (p: GalleryPhase) => void,
): Gallery {
  if (config.aspects !== undefined) return runKnownAspectsImmediate(config, state, emit)
  const { urls, packer } = config
  const readyAspects: Array<number | null> = new Array(urls.length).fill(null)
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()
  let nextPlaceIndex = 0
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  function attachImage(idx: number, el: HTMLElement): Promise<void> | null {
    if (state.cancelled) return null
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

  function placeReadyAspects(): void {
    if (state.cancelled) return
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
    if (placements.length > 0) scheduleRender(config, state, placements, pool)
  }

  const pool = createPool(config, (idx, el, place) => {
    if (state.cancelled) return
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    attachImage(idx, el)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    imageLoads.delete(idx)
  })

  const { queue, owned } = getQueue(config)
  if (owned) clearQueueOnCancel(state, queue)
  const options = getProbeOptions(config, state)
  const work = Promise.all(
    urls.map((url, index) =>
      queue.enqueue(url, options).then((prepared) => {
        if (state.cancelled) return
        readyAspects[index] = prepared.aspectRatio
        placeReadyAspects()
      }),
    ),
  ).then(async () => {
    if (state.cancelled) return
    placeReadyAspects()
    emit('all-placements')
    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    await waitForVisibleLoads(mountedTiles, imageLoads)
    if (state.cancelled) return
    emit('done')
  })

  maybeBoost(queue, urls, config)
  return finishGallery(state, pool, work)
}

// --- Image loading: after-layout ---

function runAfterLayout(
  config: GalleryConfig,
  state: GalleryState,
  emit: (p: GalleryPhase) => void,
): Gallery {
  const { urls, packer } = config
  const readyAspects: Array<number | null> = new Array(urls.length).fill(null)
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()
  let nextPlaceIndex = 0
  let renderPhase = false
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  function attachImage(idx: number, el: HTMLElement): Promise<void> | null {
    if (state.cancelled) return null
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

  function placeReadyAspects(): void {
    if (state.cancelled) return
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
    if (placements.length > 0) scheduleRender(config, state, placements, pool)
  }

  const pool = createPool(config, (idx, el, place) => {
    if (state.cancelled) return
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    if (renderPhase) attachImage(idx, el)
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    imageLoads.delete(idx)
  })

  async function finishLayoutThenLoad(): Promise<void> {
    if (state.cancelled) return
    placeReadyAspects()
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
    if (state.cancelled) return
    emit('done')
  }

  if (config.aspects !== undefined) {
    validateAspects(config)
    const work = (async (): Promise<void> => {
      for (let i = 0; i < urls.length; i++) readyAspects[i] = config.aspects![i]!
      await finishLayoutThenLoad()
    })()
    return finishGallery(state, pool, work)
  }

  const { queue, owned } = getQueue(config)
  if (owned) clearQueueOnCancel(state, queue)
  const options = getProbeOptions(config, state)
  const work = Promise.all(
    urls.map((url, index) =>
      queue.enqueue(url, options).then((prepared) => {
        if (state.cancelled) return
        readyAspects[index] = prepared.aspectRatio
        placeReadyAspects()
      }),
    ),
  ).then(finishLayoutThenLoad)

  maybeBoost(queue, urls, config)
  return finishGallery(state, pool, work)
}

// --- Known aspects + immediate image loading ---

function runKnownAspectsImmediate(
  config: GalleryConfig,
  state: GalleryState,
  emit: (p: GalleryPhase) => void,
): Gallery {
  const { urls, packer, aspects } = config
  validateAspects(config)
  const placements: Placement[] = []
  for (let i = 0; i < urls.length; i++) placements.push(packer.add(aspects![i]!))
  emit('first-placement')
  emit('all-placements')

  let firstImageEmitted = false
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()

  const pool = createPool(config, (idx, el, place) => {
    if (state.cancelled) return
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
  const work = waitForVisibleLoads(mountedTiles, imageLoads).then(() => {
    if (state.cancelled) return
    emit('done')
  })

  return finishGallery(state, pool, work)
}

// --- Image loading: queued ---

function runQueued(
  config: GalleryConfig,
  state: GalleryState,
  emit: (p: GalleryPhase) => void,
): Gallery {
  const { urls, packer } = config
  const readyAspects: Array<number | null> = new Array(urls.length).fill(null)
  const placements: Placement[] = []
  const indexUrl: string[] = []
  const mountedTiles = new Map<number, HTMLElement>()
  const imageLoads = new Map<number, ImageLoad>()
  let nextPlaceIndex = 0
  let firstPlacementEmitted = false
  let firstImageEmitted = false

  // Internal render queue with a concurrency cap. We don't reuse
  // PrepareQueue because render work is tile-element owned: a recycled
  // node invalidates the queued job even when the URL matches.
  const renderCap = config.renderConcurrency ?? 8
  const renderQueue: PriorityRenderJob[] = []
  const activeRenderJobs = new Set<PriorityRenderJob>()
  const scrollSamples: ScrollSample[] = []
  const scrollPredictor = createLinearPredictor({ smoothingWindow: 2 })
  let renderInflight = 0

  function recordScrollSample(force = false): void {
    const y = config.scrollContainer.scrollTop
    const now = performance.now()
    const last = scrollSamples[scrollSamples.length - 1]
    if (!force && last !== undefined && last.y === y && now - last.t < QUEUED_LOOKAHEAD_MS) return
    const t = last !== undefined && now <= last.t ? last.t + 0.001 : now
    scrollSamples.push({ t, y })
    while (scrollSamples.length > QUEUED_MAX_SCROLL_SAMPLES) scrollSamples.shift()
  }
  recordScrollSample(true)

  function pumpRender(): void {
    if (state.cancelled) return
    while (renderInflight < renderCap && renderQueue.length > 0) {
      const job = renderQueue.shift()!
      if (state.cancelled) {
        job.resolve()
        continue
      }
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
      activeRenderJobs.add(job)
      config.renderImage(job.el, job.idx, job.url)
      void waitForImage(job.el, () => {
        if (!firstImageEmitted) {
          firstImageEmitted = true
          emit('first-image')
        }
      }).then(job.resolve).finally(() => {
        activeRenderJobs.delete(job)
        const latest = imageLoads.get(job.idx)
        if (latest?.el === job.el && latest.promise === job.promise) {
          imageLoads.delete(job.idx)
        }
        renderInflight--
        if (state.cancelled) return
        pumpRender()
      })
    }
  }
  function enqueueRender(
    idx: number,
    el: HTMLElement,
    url: string,
    priority: number,
  ): Promise<void> {
    if (state.cancelled) return Promise.resolve()
    const existing = imageLoads.get(idx)
    if (existing?.el === el) {
      updateRenderJobPriority(renderQueue, idx, el, existing.promise, priority)
      return existing.promise
    }
    if (el.querySelector('img') !== null) return Promise.resolve()

    let resolveJob!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveJob = resolve
    })
    const job: PriorityRenderJob = { idx, el, url, priority, promise, resolve: resolveJob, started: false }
    imageLoads.set(idx, { el, promise })
    pushRenderJob(renderQueue, job)
    pumpRender()
    return promise
  }

  function enqueueMountedImage(
    idx: number,
    el: HTMLElement,
    priorityContext: RenderPriorityContext,
  ): Promise<void> | null {
    if (state.cancelled) return null
    const url = indexUrl[idx]
    const place = placements[idx]
    if (url === undefined || place === undefined) return null
    return enqueueRender(idx, el, url, scoreRenderPriority(place, priorityContext))
  }

  function enqueueMountedImages(): Promise<void>[] {
    if (state.cancelled) return []
    recordScrollSample()
    const priorityContext = makeRenderPriorityContext(config, scrollPredictor, scrollSamples)
    const loads: Promise<void>[] = []
    for (const [idx, el] of mountedTiles) {
      const load = enqueueMountedImage(idx, el, priorityContext)
      if (load !== null) loads.push(load)
    }
    return loads
  }

  function placeReadyAspects(): void {
    if (state.cancelled) return
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
    if (placements.length > 0) scheduleRender(config, state, placements, pool)
  }

  state.cleanup.push(() => {
    for (const job of renderQueue.splice(0)) job.resolve()
    for (const job of activeRenderJobs) job.resolve()
    activeRenderJobs.clear()
    imageLoads.clear()
  })

  const pool = createPool(config, (idx, el, place) => {
    if (state.cancelled) return
    config.renderSkeleton(el, idx, place)
    mountedTiles.set(idx, el)
    recordScrollSample()
    enqueueMountedImage(idx, el, makeRenderPriorityContext(config, scrollPredictor, scrollSamples))
  }, (idx, _el) => {
    mountedTiles.delete(idx)
    const load = imageLoads.get(idx)
    if (load?.el === _el) imageLoads.delete(idx)
  })

  let viewportBoostPending = false
  function scheduleViewportBoost(): void {
    if (state.cancelled) return
    recordScrollSample(true)
    if (viewportBoostPending) return
    viewportBoostPending = true
    requestAnimationFrame(() => {
      viewportBoostPending = false
      if (state.cancelled) return
      enqueueMountedImages()
    })
  }
  config.scrollContainer.addEventListener('scroll', scheduleViewportBoost, { passive: true })
  state.cleanup.push(() => {
    config.scrollContainer.removeEventListener('scroll', scheduleViewportBoost)
  })

  async function finishQueuedLayout(): Promise<void> {
    if (state.cancelled) return
    placeReadyAspects()
    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    emit('all-placements')
    // After all probes resolve, ensure any still-mounted tiles
    // without an in-flight render get queued. mount fires before
    // indexUrl is set if probe resolution order differs from pool
    // mount order; guard against that by sweeping here.
    const visibleLoads = enqueueMountedImages()
    await Promise.all(visibleLoads)
    if (state.cancelled) return
    emit('done')
  }

  if (config.aspects !== undefined) {
    validateAspects(config)
    const work = (async (): Promise<void> => {
      for (let i = 0; i < urls.length; i++) readyAspects[i] = config.aspects![i]!
      await finishQueuedLayout()
    })()
    return finishGallery(state, pool, work)
  }

  const { queue, owned } = getQueue(config)
  if (owned) clearQueueOnCancel(state, queue)
  const options = getProbeOptions(config, state)
  const work = Promise.all(
    urls.map((url, index) =>
      queue.enqueue(url, options).then((prepared) => {
        if (state.cancelled) return
        readyAspects[index] = prepared.aspectRatio
        placeReadyAspects()
      }),
    ),
  ).then(finishQueuedLayout)

  maybeBoost(queue, urls, config)
  return finishGallery(state, pool, work)
}

// --- Image loading: visible-first ---

function runVisibleFirst(
  config: GalleryConfig,
  state: GalleryState,
  emit: (p: GalleryPhase) => void,
): Gallery {
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
  const activeRenderJobs = new Set<PriorityRenderJob>()
  let renderInflight = 0

  function pumpRender(): void {
    if (state.cancelled) return
    while (renderInflight < renderCap && renderQueue.length > 0) {
      const job = renderQueue.shift()!
      if (state.cancelled) {
        job.resolve()
        continue
      }
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
      activeRenderJobs.add(job)
      config.renderImage(job.el, job.idx, job.url)
      void waitForImage(job.el, () => {
        if (!firstImageEmitted) {
          firstImageEmitted = true
          emit('first-image')
        }
      }).then(job.resolve).finally(() => {
        activeRenderJobs.delete(job)
        const latest = imageLoads.get(job.idx)
        if (latest?.el === job.el && latest.promise === job.promise) {
          imageLoads.delete(job.idx)
        }
        renderInflight--
        if (state.cancelled) return
        pumpRender()
      })
    }
  }

  function enqueueRender(
    idx: number,
    el: HTMLElement,
    url: string,
    priority: number,
  ): Promise<void> {
    if (state.cancelled) return Promise.resolve()
    const existing = imageLoads.get(idx)
    if (existing?.el === el) {
      updateRenderJobPriority(renderQueue, idx, el, existing.promise, priority)
      return existing.promise
    }
    if (el.querySelector('img') !== null) return Promise.resolve()

    let resolveJob!: () => void
    const promise = new Promise<void>((resolve) => {
      resolveJob = resolve
    })
    const job: PriorityRenderJob = { idx, el, url, priority, promise, resolve: resolveJob, started: false }
    imageLoads.set(idx, { el, promise })
    pushRenderJob(renderQueue, job)
    pumpRender()
    return promise
  }

  function enqueueMountedImage(idx: number, el: HTMLElement): Promise<void> | null {
    if (state.cancelled) return null
    if (!viewportRenderStarted) return null
    const url = indexUrl[idx]
    const place = placements[idx]
    if (url === undefined || place === undefined) return null
    const isViewport = isInViewport(config, place)
    if (!isViewport && !normalRenderEnabled) return null
    return enqueueRender(idx, el, url, isViewport ? RENDER_PRIORITY_VISIBLE : RENDER_PRIORITY_NORMAL)
  }

  function enqueueMountedImages(): Promise<void>[] {
    if (state.cancelled) return []
    const loads: Promise<void>[] = []
    for (const [idx, el] of mountedTiles) {
      const load = enqueueMountedImage(idx, el)
      if (load !== null) loads.push(load)
    }
    return loads
  }

  function startViewportRenderIfReady(): void {
    if (state.cancelled) return
    if (viewportRenderStarted) return
    if (urls.length > 0 && placements.length === 0) return
    if (nextPlaceIndex < firstScreenTarget) return

    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    viewportRenderStarted = true
    const firstViewportLoads = enqueueMountedImages()
    void Promise.all(firstViewportLoads).then(() => {
      if (state.cancelled) return
      normalRenderEnabled = true
      enqueueMountedImages()
    })
  }

  function placeReadyAspects(): void {
    if (state.cancelled) return
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
    if (placements.length > 0) scheduleRender(config, state, placements, pool)
    startViewportRenderIfReady()
  }

  state.cleanup.push(() => {
    for (const job of renderQueue.splice(0)) job.resolve()
    for (const job of activeRenderJobs) job.resolve()
    activeRenderJobs.clear()
    imageLoads.clear()
  })

  const pool = createPool(config, (idx, el, place) => {
    if (state.cancelled) return
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
    if (state.cancelled) return
    if (viewportBoostPending) return
    viewportBoostPending = true
    requestAnimationFrame(() => {
      viewportBoostPending = false
      if (state.cancelled) return
      enqueueMountedImages()
    })
  }
  config.scrollContainer.addEventListener('scroll', scheduleViewportBoost, { passive: true })
  state.cleanup.push(() => {
    config.scrollContainer.removeEventListener('scroll', scheduleViewportBoost)
  })

  if (config.aspects !== undefined) {
    validateAspects(config)
    const work = (async (): Promise<void> => {
      for (let i = 0; i < urls.length; i++) readyAspects[i] = config.aspects![i]!
      placeReadyAspects()
      if (state.cancelled) return
      config.contentContainer.style.height = `${packer.totalHeight()}px`
      pool.setPlacements(placements)
      emit('all-placements')
      startViewportRenderIfReady()
      await waitForVisibleLoads(mountedTiles, imageLoads)
      if (state.cancelled) return
      emit('done')
    })()
    return finishGallery(state, pool, work)
  }

  const { queue, owned } = getQueue(config)
  if (owned) clearQueueOnCancel(state, queue)
  const options = getProbeOptions(config, state)
  const work = Promise.all(
    urls.map((url, index) =>
      queue.enqueue(url, options).then((prepared) => {
        if (state.cancelled) return
        readyAspects[index] = prepared.aspectRatio
        placeReadyAspects()
      }),
    ),
  ).then(async () => {
    if (state.cancelled) return
    placeReadyAspects()
    config.contentContainer.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    emit('all-placements')
    startViewportRenderIfReady()
    normalRenderEnabled = true
    enqueueMountedImages()
    await waitForVisibleLoads(mountedTiles, imageLoads)
    if (state.cancelled) return
    emit('done')
  })

  maybeBoost(queue, urls, config)
  return finishGallery(state, pool, work)
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

function validateAspects(config: GalleryConfig): void {
  if (config.aspects === undefined || config.aspects.length !== config.urls.length) {
    throw new Error('loadGallery: aspects[] must match urls.length')
  }
}

function getQueue(config: GalleryConfig): { queue: PrepareQueueLike; owned: boolean } {
  if (config.probe?.queue !== undefined) return { queue: config.probe.queue, owned: false }
  return { queue: new PrepareQueue(), owned: true }
}

function clearQueueOnCancel(state: GalleryState, queue: PrepareQueueLike): void {
  const maybeClear = (queue as PrepareQueueLike & { clear?: () => void }).clear
  if (typeof maybeClear === 'function') {
    state.cleanup.push(() => {
      maybeClear.call(queue)
    })
  }
}

function getProbeOptions(config: GalleryConfig, state: GalleryState): PrepareOptions {
  const base = config.probe?.options ?? { dimsOnly: true }
  return {
    ...base,
    signal: combineAbortSignals(base.signal, state.abortController.signal, state),
  }
}

function combineAbortSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
  state: GalleryState,
): AbortSignal {
  if (external === undefined) return internal
  if (external.aborted) return external
  if (internal.aborted) return internal

  const controller = new AbortController()
  const abortFromExternal = (): void => {
    controller.abort(external.reason)
  }
  const abortFromInternal = (): void => {
    controller.abort(internal.reason)
  }
  external.addEventListener('abort', abortFromExternal, { once: true })
  internal.addEventListener('abort', abortFromInternal, { once: true })
  state.cleanup.push(() => {
    external.removeEventListener('abort', abortFromExternal)
    internal.removeEventListener('abort', abortFromInternal)
  })
  return controller.signal
}

function maybeBoost(queue: PrepareQueueLike, urls: readonly string[], config: GalleryConfig): void {
  const k = config.probe?.boostFirstScreen
  if (k !== undefined && k > 0) queue.boostMany(urls.slice(0, k))
}

/** rAF-batched setPlacements so N probes resolving in one tick
 *  collapse into one pool.setPlacements call + one height write. */
function scheduleRender(
  config: GalleryConfig,
  galleryState: GalleryState,
  placements: readonly Placement[],
  pool: VirtualTilePool,
): void {
  if (galleryState.cancelled) return
  const state = renderState.get(pool)
  if (state !== undefined && state.pending) return
  const s = state ?? { pending: true }
  s.pending = true
  renderState.set(pool, s)
  requestAnimationFrame(() => {
    s.pending = false
    if (galleryState.cancelled) return
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

const RENDER_PRIORITY_VISIBLE = 400_000
const RENDER_PRIORITY_PREDICTED = 300_000
const RENDER_PRIORITY_AHEAD = 200_000
const RENDER_PRIORITY_NEAR = 100_000
const RENDER_PRIORITY_NORMAL = 0
const RENDER_PRIORITY_DISTANCE_CAP = 99_999
const QUEUED_LOOKAHEAD_MS = 250
const QUEUED_MAX_SCROLL_SAMPLES = 12
const QUEUED_MIN_PREDICTION_DELTA_PX = 8
const QUEUED_MIN_PREDICTION_CONFIDENCE = 0.2
const QUEUED_MIN_SCROLL_VELOCITY_PX_PER_MS = 0.02

type ViewportRange = {
  top: number
  bottom: number
  height: number
  center: number
}

type RenderPriorityContext = {
  current: ViewportRange
  predicted: ViewportRange | null
  direction: -1 | 0 | 1
}

type PriorityRenderJob = RenderJob & {
  priority: number
  started: boolean
}

function pushRenderJob(renderQueue: PriorityRenderJob[], job: PriorityRenderJob): void {
  const firstLowerPriority = renderQueue.findIndex((queued) => queued.priority < job.priority)
  if (firstLowerPriority === -1) renderQueue.push(job)
  else renderQueue.splice(firstLowerPriority, 0, job)
}

function updateRenderJobPriority(
  renderQueue: PriorityRenderJob[],
  idx: number,
  el: HTMLElement,
  promise: Promise<void>,
  priority: number,
): void {
  const queuedIndex = renderQueue.findIndex(
    (job) => !job.started && job.idx === idx && job.el === el && job.promise === promise,
  )
  if (queuedIndex < 0) return
  const job = renderQueue[queuedIndex]!
  if (job.priority === priority) return
  renderQueue.splice(queuedIndex, 1)
  job.priority = priority
  pushRenderJob(renderQueue, job)
}

function isInViewport(config: GalleryConfig, place: Placement): boolean {
  return gapToRange(place, getViewportRange(config)) === 0
}

function makeRenderPriorityContext(
  config: GalleryConfig,
  predictor: ScrollPredictor,
  samples: readonly ScrollSample[],
): RenderPriorityContext {
  const current = getViewportRange(config)
  const prediction = predictor.predict(samples, QUEUED_LOOKAHEAD_MS)
  const delta = prediction.y - config.scrollContainer.scrollTop
  const velocity = latestVelocity(samples)
  const direction = scrollDirection(delta, velocity)
  const predicted =
    prediction.confidence > QUEUED_MIN_PREDICTION_CONFIDENCE &&
    Math.abs(delta) >= QUEUED_MIN_PREDICTION_DELTA_PX
      ? shiftRange(current, delta)
      : null
  return { current, predicted, direction }
}

function scoreRenderPriority(place: Placement, context: RenderPriorityContext): number {
  const visibleGap = gapToRange(place, context.current)
  if (visibleGap === 0) {
    return RENDER_PRIORITY_VISIBLE - cappedDistance(distanceToRangeCenter(place, context.current))
  }

  if (context.predicted !== null && gapToRange(place, context.predicted) === 0) {
    return RENDER_PRIORITY_PREDICTED - cappedDistance(distanceToRangeCenter(place, context.predicted))
  }

  const aheadDistance = distanceAhead(place, context.current, context.direction)
  if (aheadDistance !== null) {
    return RENDER_PRIORITY_AHEAD - cappedDistance(aheadDistance)
  }

  if (context.direction === 0) {
    return RENDER_PRIORITY_NEAR - cappedDistance(visibleGap)
  }

  return RENDER_PRIORITY_NORMAL - cappedDistance(visibleGap)
}

function getViewportRange(config: GalleryConfig): ViewportRange {
  const scrollTop = config.scrollContainer.scrollTop
  const scrollRect = config.scrollContainer.getBoundingClientRect()
  const contentRect = config.contentContainer.getBoundingClientRect()
  const contentOffsetTop = contentRect.top - scrollRect.top + scrollTop
  const top = scrollTop - contentOffsetTop
  const bottom = scrollTop + config.scrollContainer.clientHeight - contentOffsetTop
  return { top, bottom, height: bottom - top, center: (top + bottom) / 2 }
}

function shiftRange(range: ViewportRange, delta: number): ViewportRange {
  const top = range.top + delta
  const bottom = range.bottom + delta
  return { top, bottom, height: range.height, center: range.center + delta }
}

function gapToRange(place: Placement, range: ViewportRange): number {
  const placeBottom = place.y + place.height
  if (placeBottom < range.top) return range.top - placeBottom
  if (place.y > range.bottom) return place.y - range.bottom
  return 0
}

function distanceToRangeCenter(place: Placement, range: ViewportRange): number {
  return Math.abs(place.y + place.height / 2 - range.center)
}

function distanceAhead(place: Placement, range: ViewportRange, direction: -1 | 0 | 1): number | null {
  if (direction > 0 && place.y >= range.bottom) return place.y - range.bottom
  if (direction < 0 && place.y + place.height <= range.top) return range.top - (place.y + place.height)
  return null
}

function scrollDirection(delta: number, velocity: number): -1 | 0 | 1 {
  if (Math.abs(delta) >= QUEUED_MIN_PREDICTION_DELTA_PX) return delta > 0 ? 1 : -1
  if (Math.abs(velocity) >= QUEUED_MIN_SCROLL_VELOCITY_PX_PER_MS) return velocity > 0 ? 1 : -1
  return 0
}

function cappedDistance(distance: number): number {
  return Math.min(distance, RENDER_PRIORITY_DISTANCE_CAP)
}

function latestVelocity(samples: readonly ScrollSample[]): number {
  if (samples.length < 2) return 0
  const a = samples[samples.length - 2]!
  const b = samples[samples.length - 1]!
  const dt = b.t - a.t
  return dt > 0 ? (b.y - a.y) / dt : 0
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
