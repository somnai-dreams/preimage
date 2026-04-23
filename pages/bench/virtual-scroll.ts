import { PrepareQueue } from '@somnai-dreams/preimage'
import { createVirtualTilePool } from '@somnai-dreams/preimage/virtual'
import { shortestColumnCursor, type Placement } from '@somnai-dreams/layout-algebra'
import { cycledUrls } from '../demos/photo-source.js'
import {
  captureMetadata,
  distribution,
  getNetworkLabel,
  saveRun,
  setNetworkLabel,
  type Distribution,
  type RunMetadata,
} from './common.js'

const nInput = document.getElementById('nInput') as HTMLInputElement
const velInput = document.getElementById('velInput') as HTMLInputElement
const concInput = document.getElementById('concInput') as HTMLInputElement
const networkLabelEl = document.getElementById('networkLabel') as HTMLInputElement
networkLabelEl.value = getNetworkLabel()
networkLabelEl.addEventListener('input', () => setNetworkLabel(networkLabelEl.value.trim()))
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const statHost = document.getElementById('stat-host')!
const jsonHost = document.getElementById('json-host')!
const scrollBox = document.getElementById('scrollBox') as HTMLElement
const content = document.getElementById('content') as HTMLElement

const COLUMNS = 5
const GAP = 3

type VirtualScrollParams = {
  n: number
  velocityPxPerSec: number
  concurrency: number
  strategy: 'img' | 'stream'
}

type VirtualScrollResults = {
  prepackMs: number
  scrollWallMs: number
  scrolledPx: number
  frames: number
  frameIntervalMs: Distribution
  // Frames whose interval exceeded 2× the expected refresh budget.
  // Counted assuming a 60Hz baseline (16.67ms) with a generous
  // 2× fudge; actual refresh rate comes through from the rAF stream
  // implicitly.
  droppedFrames: number
  activeTileCount: Distribution
  totalMounts: number
  totalUnmounts: number
  // True iff the tab was backgrounded at any point during the scripted
  // scroll. rAF throttles (or stops) while hidden, so the recorded
  // intervals are contaminated — treat the run as advisory only.
  tabHiddenDuring: boolean
}

let lastRun: {
  meta: RunMetadata
  params: VirtualScrollParams
  results: VirtualScrollResults
} | null = null

runBtn.addEventListener('click', () => { void run() })
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  saveRun(lastRun.meta, lastRun.params, lastRun.results)
})

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  saveBtn.disabled = true
  metaEl.textContent = ''
  statHost.innerHTML = ''
  jsonHost.innerHTML = ''
  content.innerHTML = ''
  content.style.height = '0px'
  scrollBox.scrollTop = 0

  const n = Number(nInput.value)
  const velocityPxPerSec = Number(velInput.value)
  const concurrency = Number(concInput.value)
  const strategyEl = document.querySelector<HTMLInputElement>('input[name="strategy"]:checked')
  const strategy = (strategyEl?.value === 'img' ? 'img' : 'stream') as 'img' | 'stream'

  // Pack phase: probe all N URLs, set up the pool, wait for all
  // placements. We want to measure scroll-phase behavior with the
  // layout already stable.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(n, token)
  const packer = shortestColumnCursor({
    columns: COLUMNS,
    gap: GAP,
    panelWidth: content.getBoundingClientRect().width,
  })
  const placements: Placement[] = []
  const indexUrl: string[] = []
  let mounts = 0
  let unmounts = 0

  const pool = createVirtualTilePool({
    scrollContainer: scrollBox,
    contentContainer: content,
    overscan: 600,
    mount: (idx, el, place) => {
      el.className = 'vtile pending'
      el.style.left = `${place.x}px`
      el.style.top = `${place.y}px`
      el.style.width = `${place.width}px`
      el.style.height = `${place.height}px`
      const img = new Image()
      img.alt = ''
      img.src = indexUrl[idx]!
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('loaded')
        el.className = 'vtile has-image'
      } else {
        img.addEventListener(
          'load',
          () => {
            img.classList.add('loaded')
            el.className = 'vtile has-image'
          },
          { once: true },
        )
      }
      el.appendChild(img)
      mounts++
    },
    unmount: (_idx, el) => {
      const img = el.querySelector('img')
      if (img !== null) img.src = ''
      el.innerHTML = ''
      el.className = 'vtile pending'
      unmounts++
    },
  })

  const tPrepack0 = performance.now()
  const queue = new PrepareQueue({ concurrency })
  await Promise.all(
    urls.map((url) =>
      queue
        .enqueue(url, { dimsOnly: true, strategy })
        .then((prepared) => {
          const place = packer.add(prepared.aspectRatio)
          placements.push(place)
          indexUrl.push(url)
        })
        .catch(() => { /* tolerate probe errors */ }),
    ),
  )
  content.style.height = `${packer.totalHeight()}px`
  pool.setPlacements(placements)
  const prepackMs = performance.now() - tPrepack0

  // Reset the mount/unmount counters now that the initial pack-driven
  // mounts have settled — we want to measure only scroll-phase churn.
  mounts = 0
  unmounts = 0

  // Scripted scroll: linear from top to bottom at the configured
  // velocity. One rAF per frame, compute target scrollTop from elapsed
  // time, write. Sample every rAF.
  const contentHeight = packer.totalHeight()
  const targetScroll = Math.max(0, contentHeight - scrollBox.clientHeight)
  const scrollDurationMs = (targetScroll / velocityPxPerSec) * 1000

  const tScroll0 = performance.now()
  const frameIntervals: number[] = []
  const activeCounts: number[] = []
  // Tracking object so the visibilitychange listener can mutate
  // lastFrameTs (reset on return-from-hidden) and tainted (set on hide)
  // without a closure rebind.
  const scrollState = { lastFrameTs: tScroll0, tainted: false }
  const onVisibility = (): void => {
    if (document.hidden) {
      scrollState.tainted = true
    } else {
      // Next rAF measures `now - lastFrameTs`; reset so the
      // post-return interval doesn't include the hidden gap.
      scrollState.lastFrameTs = performance.now()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  await new Promise<void>((resolve) => {
    function step(now: number): void {
      const elapsed = now - tScroll0
      const progress = Math.min(1, elapsed / scrollDurationMs)
      scrollBox.scrollTop = progress * targetScroll
      frameIntervals.push(now - scrollState.lastFrameTs)
      activeCounts.push(pool.activeCount)
      scrollState.lastFrameTs = now
      if (progress < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
  document.removeEventListener('visibilitychange', onVisibility)
  const scrollWallMs = performance.now() - tScroll0

  const intervalDist = distribution(frameIntervals.slice(1)) // drop first frame (contains setup-to-first-rAF gap)
  const droppedFrames = frameIntervals.filter((f) => f > 33).length // > 2 × 16.67ms

  const results: VirtualScrollResults = {
    prepackMs,
    scrollWallMs,
    scrolledPx: targetScroll,
    frames: frameIntervals.length,
    frameIntervalMs: intervalDist,
    droppedFrames,
    activeTileCount: distribution(activeCounts),
    totalMounts: mounts,
    totalUnmounts: unmounts,
    tabHiddenDuring: scrollState.tainted,
  }

  const meta = await captureMetadata(
    'virtual-scroll',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  const params: VirtualScrollParams = { n, velocityPxPerSec, concurrency, strategy }
  lastRun = { meta, params, results }

  renderStats(results)
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results }, null, 2)
  jsonHost.appendChild(pre)

  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  metaEl.textContent = `strategy=${strategy} · ${meta.protocol ?? '?'}${labelBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false

  pool.destroy()
}

function renderStats(r: VirtualScrollResults): void {
  const grid = document.createElement('div')
  grid.className = 'stat-grid'
  const add = (label: string, value: string, unit = '', tone: 'bad' | '' = ''): void => {
    const cell = document.createElement('div')
    cell.className = 'stat-cell' + (tone !== '' ? ` ${tone}` : '')
    const l = document.createElement('div')
    l.className = 'label'
    l.textContent = label
    const v = document.createElement('div')
    v.className = 'value'
    v.innerHTML = unit ? `${value}<span class="unit">${unit}</span>` : value
    cell.appendChild(l)
    cell.appendChild(v)
    grid.appendChild(cell)
  }
  add('Pre-pack time', r.prepackMs.toFixed(0), 'ms')
  add('Scroll wall time', r.scrollWallMs.toFixed(0), 'ms')
  add('Frames', String(r.frames))
  add('Frame p50', r.frameIntervalMs.p50.toFixed(1), 'ms')
  add('Frame p95', r.frameIntervalMs.p95.toFixed(1), 'ms')
  add('Frame max', r.frameIntervalMs.max.toFixed(0), 'ms')
  add('Dropped frames (>33ms)', String(r.droppedFrames))
  add('Active tiles p50', r.activeTileCount.p50.toFixed(0))
  add('Active tiles max', r.activeTileCount.max.toFixed(0))
  add('Mounts', String(r.totalMounts))
  add('Unmounts', String(r.totalUnmounts))
  if (r.tabHiddenDuring) {
    add('Tab backgrounded', 'yes — run tainted', '', 'bad')
  }
  statHost.innerHTML = ''
  statHost.appendChild(grid)
}
