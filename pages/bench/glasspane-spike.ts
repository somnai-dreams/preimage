// Phase 0 spike for the glasspane swing. Runs the same workload
// through two render backends and reports the gate metrics:
//
//   - peak JS heap (proxy for CPU-side memory pressure)
//   - sustained framerate during a scripted constant-velocity scroll
//   - dropped frames (> 33 ms intervals)
//   - time-to-first-tile-visible
//
// The user runs this on each target device (desktop / recent iPhone /
// mid-range Android) and compares the saved JSONs via the existing
// /bench/compare.html. The gate criteria from the design doc:
//
//   1. peak memory on 10k tiles < 50% of DOM path on mid-range Android
//   2. sustained fps on 2000 tiles ≥ 55 with < 5 jank events
//   3. time-to-first-tile within 100ms of DOM path

import { PrepareQueue } from '@somnai-dreams/preimage'
import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'
import { createVirtualTilePool } from '@somnai-dreams/preimage/virtual'
import { createGlasspaneScene, type GlasspaneScene } from '@somnai-dreams/glasspane'
import { shortestColumnCursor, type Placement } from '@somnai-dreams/layout-algebra'
import { cycledUrls, photosManifest } from '../demos/photo-source.js'
import {
  captureMetadata,
  distribution,
  getNetworkLabel,
  saveRun,
  setNetworkLabel,
  wireUploadButton,
  type Distribution,
  type RunMetadata,
} from './common.js'

const COLUMNS = 5
const GAP = 3
const CANVAS_HEIGHT = 620

const nInput = document.getElementById('nInput') as HTMLInputElement
const velInput = document.getElementById('velInput') as HTMLInputElement
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const uploadBtn = document.getElementById('upload') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const statHost = document.getElementById('stat-host')!
const jsonHost = document.getElementById('json-host')!
const renderHost = document.getElementById('renderHost') as HTMLElement
const gpuSupportEl = document.getElementById('gpu-support')!

// --- WebGPU availability check ---

if (navigator.gpu === undefined) {
  gpuSupportEl.style.display = 'block'
  gpuSupportEl.innerHTML =
    '<strong>WebGPU not supported in this browser.</strong> The GPU backend will error out; only the DOM backend is runnable. As of Apr 2026: Chrome 113+, Edge 113+, Safari 17.4+, Firefox 121+ behind a flag.'
}

type Backend = 'dom' | 'gpu'

type SpikeParams = {
  n: number
  backend: Backend
  velocityPxPerSec: number
}

type SpikeResults = {
  prepMs: number
  scrollWallMs: number
  scrolledPx: number
  frames: number
  frameIntervalMs: Distribution
  droppedFrames: number
  timeToFirstTileMs: number | null
  peakHeapMB: number | null
  endHeapMB: number | null
  gpuAdapterInfo: string | null
  activeTilesAtEnd: number
  visibleTilesAtEnd: number
  // True iff the tab was backgrounded at any point during the scripted
  // scroll. rAF throttles when `document.hidden`, so the recorded
  // frame-interval distribution is contaminated — treat the run as
  // advisory only.
  tabHiddenDuring: boolean
}

type MemorySnapshot = {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

let lastRun: {
  meta: RunMetadata
  params: SpikeParams
  results: SpikeResults
} | null = null

runBtn.addEventListener('click', () => { void run() })
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  saveRun(lastRun.meta, lastRun.params, lastRun.results)
})
wireUploadButton(uploadBtn, () => lastRun)

async function run(): Promise<void> {
  runBtn.disabled = true
  saveBtn.disabled = true
  uploadBtn.disabled = true
  runBtn.textContent = 'Running…'
  metaEl.textContent = ''
  statHost.innerHTML = ''
  jsonHost.innerHTML = ''
  renderHost.innerHTML = ''

  const n = Number(nInput.value)
  const velocityPxPerSec = Number(velInput.value)
  const backendEl = document.querySelector<HTMLInputElement>('input[name="backend"]:checked')
  const backend = (backendEl?.value ?? 'dom') as Backend

  // --- Shared setup: hydrate dims from manifest, build placements. ---
  // We use the manifest path so both backends start with identical
  // placement arrays; the spike is measuring render-path cost, not
  // probe-path cost.
  const prepStart = performance.now()
  const manifestEntries = Object.entries(photosManifest())
  const urls: string[] = new Array(n)
  const placements: Placement[] = new Array(n)

  const panelWidth = renderHost.clientWidth
  const packer = shortestColumnCursor({ columns: COLUMNS, gap: GAP, panelWidth })
  for (let i = 0; i < n; i++) {
    const [manifestKey, dims] = manifestEntries[i % manifestEntries.length]!
    const url = `..${manifestKey}`
    recordKnownMeasurement(url, dims.width, dims.height)
    placements[i] = packer.add(dims.width / dims.height)
    urls[i] = url
  }
  const contentHeight = packer.totalHeight()
  const prepMs = performance.now() - prepStart

  const memBefore = takeMemorySnapshot()

  let timeToFirstTileMs: number | null = null
  let activeTilesAtEnd = 0
  let visibleTilesAtEnd = 0
  let gpuAdapterInfo: string | null = null

  // --- Backend: DOM ---

  if (backend === 'dom') {
    const content = document.createElement('div')
    content.className = 'dom-content'
    content.style.height = `${contentHeight}px`
    renderHost.appendChild(content)

    let firstMounted = false
    const tStart = performance.now()
    const pool = createVirtualTilePool({
      scrollContainer: renderHost,
      contentContainer: content,
      overscan: 400,
      mount: (idx, el, place) => {
        el.className = 'dom-tile'
        el.style.left = `${place.x}px`
        el.style.top = `${place.y}px`
        el.style.width = `${place.width}px`
        el.style.height = `${place.height}px`
        const img = new Image()
        img.alt = ''
        img.src = urls[idx]!
        if (img.complete && img.naturalWidth > 0) {
          img.classList.add('loaded')
        } else {
          img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
        }
        el.appendChild(img)
        if (!firstMounted) {
          firstMounted = true
          timeToFirstTileMs = performance.now() - tStart
        }
      },
      unmount: (_idx, el) => {
        const img = el.querySelector('img')
        if (img !== null) img.src = ''
        el.innerHTML = ''
        el.className = 'dom-tile'
      },
    })
    pool.setPlacements(placements)

    const scroll = await scriptedScroll(renderHost, contentHeight, velocityPxPerSec)
    activeTilesAtEnd = pool.activeCount
    visibleTilesAtEnd = pool.activeCount // pool doesn't separate visible vs overscan externally

    const memAfter = takeMemorySnapshot()
    const memPeak = snapshotPeak(memBefore, memAfter)
    const results = buildResults({
      prepMs,
      scroll,
      timeToFirstTileMs,
      activeTilesAtEnd,
      visibleTilesAtEnd,
      memPeak,
      memEnd: memAfter,
      gpuAdapterInfo: null,
    })
    await finalize({ n, backend, velocityPxPerSec }, results)
    pool.destroy()
    return
  }

  // --- Backend: GPU ---

  if (navigator.gpu === undefined) {
    metaEl.textContent = 'WebGPU not available in this browser.'
    runBtn.disabled = false
    runBtn.textContent = 'Run again'
    return
  }

  const canvas = document.createElement('canvas')
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(panelWidth * dpr)
  canvas.height = Math.floor(CANVAS_HEIGHT * dpr)
  canvas.style.width = `${panelWidth}px`
  canvas.style.height = `${CANVAS_HEIGHT}px`
  renderHost.appendChild(canvas)
  const content = document.createElement('div')
  content.style.position = 'absolute'
  content.style.top = '0'
  content.style.left = '0'
  content.style.width = '1px'
  content.style.height = `${contentHeight}px`
  content.style.pointerEvents = 'none'
  renderHost.appendChild(content)

  // Capture adapter info for the report.
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter !== null && 'info' in adapter) {
    const info = (adapter as unknown as { info?: { vendor?: string; architecture?: string; device?: string } }).info
    if (info !== undefined) {
      gpuAdapterInfo = [info.vendor, info.architecture, info.device].filter(Boolean).join(' · ') || null
    }
  }

  const tStart = performance.now()
  const scene = await createGlasspaneScene({
    canvas,
    overscan: 400,
    maxActiveTiles: 256,
    tileTextureSize: 256,
  })
  scene.setPlacements(placements)

  // Fire image fetches in parallel for all visible + overscan tiles.
  // The scene handles slot claim + fade-in internally. Track
  // first-tile-ready.
  let firstReady = false
  const initialFetches: Promise<void>[] = []
  const visibleInitial = visibleIndicesFor(placements, 0, CANVAS_HEIGHT, 400)
  for (const idx of visibleInitial) {
    initialFetches.push(
      scene.setTileImage(idx, urls[idx]!).then(() => {
        if (!firstReady) {
          firstReady = true
          timeToFirstTileMs = performance.now() - tStart
        }
      }),
    )
  }

  // Kick off remaining tile fetches lazily via scroll handler.
  const remaining = new Set<number>()
  for (let i = 0; i < placements.length; i++) {
    if (!visibleInitial.includes(i)) remaining.add(i)
  }

  const scroll = await scriptedScrollCanvas(renderHost, contentHeight, velocityPxPerSec, (sy) => {
    scene.setScroll(sy)
    const visible = visibleIndicesFor(placements, sy, CANVAS_HEIGHT, 400)
    for (const idx of visible) {
      if (remaining.has(idx)) {
        remaining.delete(idx)
        void scene.setTileImage(idx, urls[idx]!)
      }
    }
  })

  // Wait briefly for remaining in-flight fetches to settle before
  // taking the end snapshot.
  await new Promise((r) => setTimeout(r, 150))
  activeTilesAtEnd = scene.activeTileCount
  visibleTilesAtEnd = scene.visibleTileCount

  const memAfter = takeMemorySnapshot()
  const memPeak = snapshotPeak(memBefore, memAfter)
  const results = buildResults({
    prepMs,
    scroll,
    timeToFirstTileMs,
    activeTilesAtEnd,
    visibleTilesAtEnd,
    memPeak,
    memEnd: memAfter,
    gpuAdapterInfo,
  })
  await finalize({ n, backend, velocityPxPerSec }, results)
  scene.destroy()
}

// --- Scripted scroll ---

type ScrollResult = {
  scrollWallMs: number
  scrolledPx: number
  frames: number
  frameIntervals: number[]
  // Set if the user alt-tabbed / switched spaces / locked the screen
  // at any point. rAF throttles to ~1 Hz (or stops) when the tab is
  // hidden, so the interval captured on the next rAF after return
  // includes the whole backgrounded gap — it looks like a single
  // 20-second frame. We discard those post-hidden samples and taint
  // the whole run.
  tabHiddenDuring: boolean
}

// Listen for visibility transitions across the scripted scroll. When
// the tab becomes hidden we flag `tainted = true`; when it returns we
// reset the clock so the very next frame's interval starts from now,
// not from before the background gap.
function trackVisibility(state: { tainted: boolean; lastFrameTs: number }): () => void {
  const onChange = (): void => {
    if (document.hidden) {
      state.tainted = true
    } else {
      // Next rAF will measure `now - lastFrameTs`; reset to now so the
      // post-return interval doesn't include the hidden gap.
      state.lastFrameTs = performance.now()
    }
  }
  document.addEventListener('visibilitychange', onChange)
  return () => { document.removeEventListener('visibilitychange', onChange) }
}

async function scriptedScroll(
  container: HTMLElement,
  contentHeight: number,
  velocityPxPerSec: number,
): Promise<ScrollResult> {
  const target = Math.max(0, contentHeight - container.clientHeight)
  const scrollDurationMs = (target / velocityPxPerSec) * 1000
  const t0 = performance.now()
  const frameIntervals: number[] = []
  const state = { tainted: false, lastFrameTs: t0 }
  const untrack = trackVisibility(state)
  await new Promise<void>((resolve) => {
    function step(now: number): void {
      const elapsed = now - t0
      const progress = Math.min(1, elapsed / scrollDurationMs)
      container.scrollTop = progress * target
      frameIntervals.push(now - state.lastFrameTs)
      state.lastFrameTs = now
      if (progress < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
  untrack()
  return {
    scrollWallMs: performance.now() - t0,
    scrolledPx: target,
    frames: frameIntervals.length,
    frameIntervals,
    tabHiddenDuring: state.tainted,
  }
}

async function scriptedScrollCanvas(
  container: HTMLElement,
  contentHeight: number,
  velocityPxPerSec: number,
  onScroll: (scrollY: number) => void,
): Promise<ScrollResult> {
  const target = Math.max(0, contentHeight - container.clientHeight)
  const scrollDurationMs = (target / velocityPxPerSec) * 1000
  const t0 = performance.now()
  const frameIntervals: number[] = []
  const state = { tainted: false, lastFrameTs: t0 }
  const untrack = trackVisibility(state)
  await new Promise<void>((resolve) => {
    function step(now: number): void {
      const elapsed = now - t0
      const progress = Math.min(1, elapsed / scrollDurationMs)
      const sy = progress * target
      container.scrollTop = sy
      onScroll(sy)
      frameIntervals.push(now - state.lastFrameTs)
      state.lastFrameTs = now
      if (progress < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
  untrack()
  return {
    scrollWallMs: performance.now() - t0,
    scrolledPx: target,
    frames: frameIntervals.length,
    frameIntervals,
    tabHiddenDuring: state.tainted,
  }
}

function visibleIndicesFor(
  placements: readonly Placement[],
  scrollY: number,
  viewportHeight: number,
  overscan: number,
): number[] {
  const top = scrollY - overscan
  const bottom = scrollY + viewportHeight + overscan
  const out: number[] = []
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!
    if (p.y + p.height < top) continue
    if (p.y > bottom) continue
    out.push(i)
  }
  return out
}

// --- Memory ---

function takeMemorySnapshot(): MemorySnapshot | null {
  const perf = performance as unknown as { memory?: MemorySnapshot }
  if (perf.memory === undefined) return null
  return {
    usedJSHeapSize: perf.memory.usedJSHeapSize,
    totalJSHeapSize: perf.memory.totalJSHeapSize,
    jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
  }
}

function snapshotPeak(
  a: MemorySnapshot | null,
  b: MemorySnapshot | null,
): MemorySnapshot | null {
  if (a === null) return b
  if (b === null) return a
  return {
    usedJSHeapSize: Math.max(a.usedJSHeapSize, b.usedJSHeapSize),
    totalJSHeapSize: Math.max(a.totalJSHeapSize, b.totalJSHeapSize),
    jsHeapSizeLimit: Math.max(a.jsHeapSizeLimit, b.jsHeapSizeLimit),
  }
}

// --- Reporting ---

function buildResults(input: {
  prepMs: number
  scroll: ScrollResult
  timeToFirstTileMs: number | null
  activeTilesAtEnd: number
  visibleTilesAtEnd: number
  memPeak: MemorySnapshot | null
  memEnd: MemorySnapshot | null
  gpuAdapterInfo: string | null
}): SpikeResults {
  const intervals = input.scroll.frameIntervals.slice(1) // drop first (setup → first rAF)
  const dropped = intervals.filter((i) => i > 33).length
  return {
    prepMs: input.prepMs,
    scrollWallMs: input.scroll.scrollWallMs,
    scrolledPx: input.scroll.scrolledPx,
    frames: input.scroll.frames,
    frameIntervalMs: distribution(intervals),
    droppedFrames: dropped,
    timeToFirstTileMs: input.timeToFirstTileMs,
    peakHeapMB: input.memPeak !== null ? input.memPeak.usedJSHeapSize / 1024 / 1024 : null,
    endHeapMB: input.memEnd !== null ? input.memEnd.usedJSHeapSize / 1024 / 1024 : null,
    gpuAdapterInfo: input.gpuAdapterInfo,
    activeTilesAtEnd: input.activeTilesAtEnd,
    visibleTilesAtEnd: input.visibleTilesAtEnd,
    tabHiddenDuring: input.scroll.tabHiddenDuring,
  }
}

async function finalize(params: SpikeParams, results: SpikeResults): Promise<void> {
  const meta = await captureMetadata(
    'glasspane-spike',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  lastRun = { meta, params, results }

  renderStats(results, params)
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results }, null, 2)
  jsonHost.appendChild(pre)

  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  metaEl.textContent = `${params.backend} · n=${params.n} · ${meta.protocol ?? '?'}${labelBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
  uploadBtn.disabled = false
}

function renderStats(r: SpikeResults, params: SpikeParams): void {
  const grid = document.createElement('div')
  grid.className = 'stat-grid'
  const add = (label: string, value: string, unit = '', tone: 'good' | 'bad' | '' = ''): void => {
    const cell = document.createElement('div')
    cell.className = 'stat-cell' + (tone !== '' ? ` ${tone}` : '')
    const l = document.createElement('div')
    l.className = 'label'
    l.textContent = label
    const v = document.createElement('div')
    v.className = 'value'
    v.innerHTML = unit !== '' ? `${value}<span class="unit">${unit}</span>` : value
    cell.appendChild(l)
    cell.appendChild(v)
    grid.appendChild(cell)
  }

  // Gate: fps >= 55 on 2000 tiles, <5 jank, peak memory < 50% of baseline.
  // We don't have a baseline here (that's cross-run), so just flag
  // the raw numbers and let compare.html do the diff.
  const fps = r.frameIntervalMs.p50 > 0 ? 1000 / r.frameIntervalMs.p50 : 0
  add('Backend', params.backend)
  add('Tiles', String(params.n))
  add('Time-to-first-tile', r.timeToFirstTileMs !== null ? r.timeToFirstTileMs.toFixed(0) : '—', 'ms')
  add('Prep time', r.prepMs.toFixed(1), 'ms')
  add('Scroll wall', r.scrollWallMs.toFixed(0), 'ms')
  add('FPS (from p50)', fps.toFixed(1), '',
    fps >= 55 ? 'good' : fps >= 30 ? '' : 'bad')
  add('Frame p50', r.frameIntervalMs.p50.toFixed(1), 'ms')
  add('Frame p95', r.frameIntervalMs.p95.toFixed(1), 'ms')
  add('Frame max', r.frameIntervalMs.max.toFixed(0), 'ms')
  add('Dropped frames (>33ms)', String(r.droppedFrames), '',
    r.droppedFrames < 5 ? 'good' : r.droppedFrames < 20 ? '' : 'bad')
  add('Peak JS heap', r.peakHeapMB !== null ? r.peakHeapMB.toFixed(1) : '—', 'MB')
  add('End JS heap', r.endHeapMB !== null ? r.endHeapMB.toFixed(1) : '—', 'MB')
  add('Active tiles at end', String(r.activeTilesAtEnd))
  add('Visible at end', String(r.visibleTilesAtEnd))
  if (r.gpuAdapterInfo !== null) add('GPU adapter', r.gpuAdapterInfo)
  if (r.tabHiddenDuring) {
    add('Tab backgrounded', 'yes — run tainted', '', 'bad')
  }

  statHost.innerHTML = ''
  statHost.appendChild(grid)
}

void setNetworkLabel
void getNetworkLabel
