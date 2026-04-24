import { PrepareQueue } from '@somnai-dreams/preimage'
import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'
import {
  loadGallery,
  type GalleryPhase,
  type GalleryImageLoading,
} from '@somnai-dreams/preimage/loading'
import {
  estimateFirstScreenCount,
  shortestColumnCursor,
} from '@somnai-dreams/layout-algebra'
import { cycledUrls, photosManifest } from '../demos/photo-source.js'
import {
  captureMetadata,
  fmtBytes,
  getNetworkLabel,
  saveRun,
  setNetworkLabel,
  type RunMetadata,
} from './common.js'

const nInput = document.getElementById('nInput') as HTMLInputElement
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
const canvas = document.getElementById('canvas') as HTMLElement

const COLUMNS = 4
const GAP = 4

type LoadingRunParams = {
  n: number
  imageLoading: GalleryImageLoading
  knownAspects: boolean
  concurrency: number
}

type LoadingRunResults = {
  firstPlacementMs: number | null
  allPlacementsMs: number | null
  firstImageMs: number | null
  doneMs: number | null
  bytesTransferred: number
  resolved: number
  errors: number
  activeTilesAtDone: number
}

let lastRun: { meta: RunMetadata; params: LoadingRunParams; results: LoadingRunResults } | null = null
let activeGallery: ReturnType<typeof loadGallery> | null = null

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
  if (activeGallery !== null) {
    activeGallery.destroy()
    activeGallery = null
  }
  canvas.innerHTML = ''
  canvas.style.height = '0px'
  scrollBox.scrollTop = 0

  const n = Number(nInput.value)
  const concurrency = Number(concInput.value)
  const imageLoadingEl = document.querySelector<HTMLInputElement>('input[name="imageLoading"]:checked')
  const imageLoading = (imageLoadingEl?.value ?? 'queued') as GalleryImageLoading
  const knownAspects = (document.getElementById('knownAspects') as HTMLInputElement).checked

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(n, token)
  const panelWidth = canvas.getBoundingClientRect().width
  const packer = shortestColumnCursor({ columns: COLUMNS, gap: GAP, panelWidth })

  // Byte accounting across the window of this run. Filter by the set
  // of URLs we enqueued so other fetches don't pollute.
  const urlSet = new Set(
    urls.map((u) => {
      const parsed = new URL(u, location.href)
      return parsed.pathname + parsed.search
    }),
  )
  let bytes = 0
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntriesByType('resource')) {
      const parsed = new URL(entry.name, location.href)
      if (!urlSet.has(parsed.pathname + parsed.search)) continue
      const r = entry as PerformanceResourceTiming
      bytes += Math.max(r.transferSize ?? 0, r.encodedBodySize ?? 0)
    }
  })
  observer.observe({ type: 'resource', buffered: true })

  const phaseTimes: Partial<Record<GalleryPhase, number>> = {}

  // Known aspects are independent from image scheduling. When this
  // is on, layout can commit from local manifest dimensions and the
  // selected imageLoading mode only controls visible image fetches.
  let aspects: number[] | undefined = undefined
  if (knownAspects) {
    const manifest = photosManifest()
    const manifestEntries = Object.entries(manifest)
    aspects = urls.map((_url, i) => {
      const [, dims] = manifestEntries[i % manifestEntries.length]!
      return dims.width / dims.height
    })
    // Also hydrate the library's measurement cache so any downstream
    // prepare() resolves synchronously. Match the normalized URL
    // (library strips the cache-bust query to one canonical form).
    for (let i = 0; i < urls.length; i++) {
      const [, dims] = manifestEntries[i % manifestEntries.length]!
      recordKnownMeasurement(urls[i]!, dims.width, dims.height)
    }
  }

  // First-screen prioritization parameter. Modes that run a probe
  // queue feed this into boostMany.
  const firstK = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth,
    viewportHeight: scrollBox.getBoundingClientRect().height,
    gap: GAP,
    columns: COLUMNS,
  })

  const queue = new PrepareQueue({ concurrency })
  let errors = 0
  let firstImageMs: number | null = null

  const gallery = loadGallery({
    urls,
    scrollContainer: scrollBox,
    contentContainer: canvas,
    packer,
    imageLoading,
    overscan: 400,
    probe: {
      queue,
      options: { dimsOnly: true, strategy: 'auto' },
      boostFirstScreen: firstK,
    },
    ...(aspects !== undefined ? { aspects } : {}),
    renderConcurrency: 8,
    renderSkeleton: (el, _idx, place) => {
      el.className = 'vtile'
      el.style.left = `${place.x}px`
      el.style.top = `${place.y}px`
      el.style.width = `${place.width}px`
      el.style.height = `${place.height}px`
    },
    renderImage: (el, _idx, url) => {
      const img = new Image()
      img.alt = ''
      img.src = url
      if (img.complete && img.naturalWidth > 0) img.classList.add('loaded')
      else img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
      img.addEventListener('error', () => { errors++ }, { once: true })
      el.appendChild(img)
    },
    resetTile: (el) => {
      const img = el.querySelector('img')
      if (img !== null) img.src = ''
      el.innerHTML = ''
    },
    onPhase: (phase, elapsedMs) => {
      phaseTimes[phase] = elapsedMs
      if (phase === 'first-image' && firstImageMs === null) firstImageMs = elapsedMs
    },
  })
  activeGallery = gallery

  await gallery.done
  // Let in-flight image requests settle into the PerformanceObserver
  // buffer so the byte count is honest.
  await new Promise((r) => setTimeout(r, 250))
  observer.disconnect()

  const activeTilesAtDone = gallery.pool.activeCount
  const results: LoadingRunResults = {
    firstPlacementMs: phaseTimes['first-placement'] ?? null,
    allPlacementsMs: phaseTimes['all-placements'] ?? null,
    firstImageMs,
    doneMs: phaseTimes['done'] ?? null,
    bytesTransferred: bytes,
    resolved: urls.length - errors,
    errors,
    activeTilesAtDone,
  }

  const meta = await captureMetadata(
    'loading-pattern',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  const params: LoadingRunParams = { n, imageLoading, knownAspects, concurrency }
  lastRun = { meta, params, results }

  renderStats(results)
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results }, null, 2)
  jsonHost.appendChild(pre)

  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  const rttBit = meta.network.warmupRttMs !== null ? ` · rtt ${meta.network.warmupRttMs.toFixed(0)}ms` : ''
  const aspectBit = knownAspects ? 'known aspects' : 'probed aspects'
  metaEl.textContent = `${imageLoading} · ${aspectBit} · n=${n} · c=${concurrency} · ${meta.protocol ?? '?'}${rttBit}${labelBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false

  // Leave the canvas populated so the caller can scroll around and
  // inspect. The pool owns its own scroll listener.
  void gallery
}

function renderStats(r: LoadingRunResults): void {
  const grid = document.createElement('div')
  grid.className = 'stat-grid'
  const add = (label: string, value: string, unit = ''): void => {
    const cell = document.createElement('div')
    cell.className = 'stat-cell'
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
  add('First placement', r.firstPlacementMs !== null ? r.firstPlacementMs.toFixed(0) : '—', 'ms')
  add('All placements', r.allPlacementsMs !== null ? r.allPlacementsMs.toFixed(0) : '—', 'ms')
  add('First image', r.firstImageMs !== null ? r.firstImageMs.toFixed(0) : '—', 'ms')
  add('Done', r.doneMs !== null ? r.doneMs.toFixed(0) : '—', 'ms')
  add('Bytes transferred', fmtBytes(r.bytesTransferred))
  add('Bytes / tile', fmtBytes(r.bytesTransferred / Math.max(1, r.resolved)))
  add('Active tiles at done', String(r.activeTilesAtDone))
  add('Errors', String(r.errors))
  statHost.innerHTML = ''
  statHost.appendChild(grid)
}
