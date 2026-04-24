import { clearCache, PrepareQueue, recordKnownMeasurement } from '@somnai-dreams/preimage'
import {
  loadGallery,
  type GalleryPhase,
  type GalleryImageLoading,
  type PackerCursor,
} from '@somnai-dreams/preimage/loading'
import {
  estimateFirstScreenCount,
  shortestColumnCursor,
  type Placement,
} from '@somnai-dreams/layout-algebra'
import { cycledUrls, PHOTOS } from './photo-source.js'
import { getConcurrency, getStrategy } from './nav-concurrency.js'
import { fmtMs, fmtBytes, fmtCount, setRowValue, resetStats } from './demo-formatting.js'

const countSlider = document.getElementById('countSlider') as HTMLInputElement
const countVal = document.getElementById('countVal')!
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveScroll = document.getElementById('naiveScroll')!
const measuredScroll = document.getElementById('measuredScroll')!
const naiveStats = document.getElementById('naiveStats')!
const measuredStats = document.getElementById('measuredStats')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runMeasuredBtn = document.getElementById('runMeasured') as HTMLButtonElement

const COLUMNS = 5
const GAP = 3
// Symmetric overscan. Asymmetric biasing sounded like a win on paper
// but the ticker rate regressed measurably — restore the old 600 and
// investigate before reintroducing direction-aware behavior.
const OVERSCAN = 600

// Retained across runs so "Run again" tears down the prior gallery's
// scroll listener, ResizeObserver, queued renders, and recycled nodes.
let activeMeasuredGallery: { destroy: () => void } | null = null

function getCount(): number {
  return Number(countSlider.value)
}

function getImageLoading(): GalleryImageLoading {
  const checked = document.querySelector<HTMLInputElement>('input[name="loading"]:checked')
  const value = checked?.value
  switch (value) {
    case 'visible-first':
    case 'after-layout':
    case 'queued':
    case 'immediate':
      return value
  }
  return 'queued'
}

function getUseManifestDims(): boolean {
  return (document.getElementById('manifestDims') as HTMLInputElement | null)?.checked === true
}

function freshToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function cycledAspects(count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const photo = PHOTOS[i % PHOTOS.length]!
    out.push(photo.width / photo.height)
  }
  return out
}

function hydrateCycledMeasurements(urls: readonly string[]): void {
  for (let i = 0; i < urls.length; i++) {
    const photo = PHOTOS[i % PHOTOS.length]!
    recordKnownMeasurement(urls[i]!, photo.width, photo.height)
  }
}

function setMeta(msg: string): void {
  metaEl.textContent = msg
}

// --- Bytes accounting via PerformanceObserver ---

type BytesMeter = { stop: () => number }

function measureBytes(predicate: (url: string) => boolean): BytesMeter {
  let total = 0
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntriesByType('resource')) {
      if (!predicate(entry.name)) continue
      const r = entry as PerformanceResourceTiming
      total += Math.max(r.transferSize ?? 0, r.encodedBodySize ?? 0)
    }
  })
  observer.observe({ type: 'resource', buffered: true })
  return {
    stop: () => {
      observer.disconnect()
      return total
    },
  }
}

// --- Naive run ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Running…'
  naivePanel.innerHTML = ''
  resetStats(naiveStats)

  const count = getCount()
  const token = freshToken()
  setMeta(`${fmtCount(count)} tiles · naive building`)
  const urls = cycledUrls(count, token)

  const urlSet = new Set(
    urls.map((u) => new URL(u, location.href).pathname + new URL(u, location.href).search),
  )
  const bytesMeter = measureBytes((u) => {
    const parsed = new URL(u, location.href)
    return urlSet.has(parsed.pathname + parsed.search)
  })

  const t0 = performance.now()

  // Dump every <img> into the column container at once. This is what
  // happens when you "just render" a 10k-item grid — DOM construction
  // is O(n), every image kicks off a fetch, the browser queues 6 (H1)
  // or many (H2) and stalls the rest, and the CSS column layout has
  // to recalculate every time an image's natural size arrives.
  const frag = document.createDocumentFragment()
  for (const url of urls) {
    const img = document.createElement('img')
    img.alt = ''
    img.src = url
    frag.appendChild(img)
  }
  naivePanel.appendChild(frag)
  setRowValue(naiveStats, 1, `<b>${fmtCount(naivePanel.querySelectorAll('img').length)}</b>`)

  let firstLoadedMs: number | null = null
  const imgs = Array.from(naivePanel.querySelectorAll('img'))
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            if (firstLoadedMs === null) {
              firstLoadedMs = performance.now() - t0
              setRowValue(naiveStats, 2, `<b>${fmtMs(firstLoadedMs)}</b>`)
            }
            resolve()
          }
          if (img.complete && img.naturalWidth > 0) done()
          else {
            img.addEventListener('load', done, { once: true })
            img.addEventListener('error', done, { once: true })
          }
        }),
    ),
  )
  const allLoadedMs = performance.now() - t0
  setRowValue(naiveStats, 3, `<b>${fmtMs(allLoadedMs)}</b>`)
  await new Promise((r) => setTimeout(r, 100))
  setRowValue(naiveStats, 4, `<b>${fmtBytes(bytesMeter.stop())}</b>`)

  setMeta(`${fmtCount(count)} tiles · naive done`)
  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Run again'
}

// --- Measured run with true DOM recycling ---
//
// Vibescript-shaped: transient state lives in a few locals, probe
// resolves mutate state and schedule a frame, the frame does all DOM
// writes in one pass. Per-probe DOM writes were re-doing style.height,
// pool.setPlacements, and two stat rows on every one of thousands of
// microtasks — rAF-batching collapses them to one pass per frame.

function markTileLoaded(el: HTMLElement, img: HTMLImageElement): void {
  img.classList.add('loaded')
  // Full className assignment (not a toggle) per vibescript: every
  // branch sets the complete attribute value so nothing from a prior
  // state leaks through.
  el.className = 'vtile has-image'
}

async function runMeasured(): Promise<void> {
  runMeasuredBtn.disabled = true
  runMeasuredBtn.textContent = 'Running…'

  const count = getCount()
  const token = freshToken()
  const imageLoading = getImageLoading()
  const useManifestDims = getUseManifestDims()
  const urls = cycledUrls(count, token)
  const aspects = useManifestDims ? cycledAspects(count) : undefined
  if (useManifestDims) {
    hydrateCycledMeasurements(urls)
  } else {
    // The demo defaults to measuring dimensions at runtime. Clear any
    // manifest/cache data from a previous run so "manifest off" stays
    // honest even after the toggle has been enabled once.
    clearCache()
  }

  if (activeMeasuredGallery !== null) {
    activeMeasuredGallery.destroy()
    activeMeasuredGallery = null
  }
  measuredPanel.innerHTML = ''
  measuredPanel.style.height = '0px'
  measuredScroll.scrollTop = 0
  resetStats(measuredStats)

  const dimsLabel = useManifestDims ? 'manifest dims' : 'probed dims'
  setMeta(`${fmtCount(count)} tiles · measured building · ${imageLoading} · ${dimsLabel}`)

  const urlSet = new Set(
    urls.map((u) => new URL(u, location.href).pathname + new URL(u, location.href).search),
  )
  const bytesMeter = measureBytes((u) => {
    const parsed = new URL(u, location.href)
    return urlSet.has(parsed.pathname + parsed.search)
  })

  const t0 = performance.now()

  const packer: PackerCursor = shortestColumnCursor({
    columns: COLUMNS,
    gap: GAP,
    panelWidth: measuredPanel.getBoundingClientRect().width,
  })
  let dimsProbed = 0
  let liveTiles = 0
  setRowValue(
    measuredStats,
    2,
    useManifestDims ? '<b>manifest</b>' : `<b>0 / ${fmtCount(urls.length)}</b>`,
  )

  function reportLiveTiles(): void {
    setRowValue(measuredStats, 1, `<b>${fmtCount(liveTiles)}</b>`)
  }

  const queue = new PrepareQueue({ concurrency: getConcurrency() })
  const strategy = getStrategy()
  const trackedQueue = {
    enqueue(src: string, options?: Parameters<PrepareQueue['enqueue']>[1]) {
      return queue.enqueue(src, options).then((prepared) => {
        dimsProbed++
        setRowValue(measuredStats, 2, `<b>${fmtCount(dimsProbed)} / ${fmtCount(urls.length)}</b>`)
        return prepared
      })
    },
    boostMany(srcs: readonly string[]) {
      queue.boostMany(srcs)
    },
  }

  const firstK = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth: measuredPanel.getBoundingClientRect().width,
    viewportHeight: measuredScroll.getBoundingClientRect().height,
    gap: GAP,
    columns: COLUMNS,
  })

  const phaseTimes: Partial<Record<GalleryPhase, number>> = {}
  const gallery = loadGallery({
    urls,
    scrollContainer: measuredScroll,
    contentContainer: measuredPanel,
    packer,
    imageLoading,
    overscan: OVERSCAN,
    probe: {
      queue: trackedQueue,
      options: { dimsOnly: true, strategy },
      boostFirstScreen: firstK,
    },
    ...(aspects !== undefined ? { aspects } : {}),
    renderConcurrency: 4,
    renderSkeleton: (el, _idx, place) => {
      el.className = 'vtile pending'
      el.style.left = `${place.x}px`
      el.style.top = `${place.y}px`
      el.style.width = `${place.width}px`
      el.style.height = `${place.height}px`
      liveTiles++
      reportLiveTiles()
    },
    renderImage: (el, _idx, url) => {
      if (el.querySelector('img') !== null) return
      const img = new Image()
      img.alt = ''
      el.appendChild(img)
      const onLoad = (): void => markTileLoaded(el, img)
      img.addEventListener('load', onLoad, { once: true })
      img.src = url
      if (img.complete && img.naturalWidth > 0) onLoad()
    },
    resetTile: (el) => {
      const img = el.querySelector('img')
      if (img !== null) img.src = ''
      el.innerHTML = ''
      el.className = 'vtile pending'
      liveTiles = Math.max(0, liveTiles - 1)
      reportLiveTiles()
    },
    onPhase: (phase, elapsedMs) => {
      phaseTimes[phase] = elapsedMs
      if (phase === 'first-placement') {
        setRowValue(measuredStats, 3, `<b>${fmtMs(elapsedMs)}</b>`)
      } else if (phase === 'all-placements') {
        setRowValue(measuredStats, 4, `<b>${fmtMs(elapsedMs)}</b>`)
      }
    },
  })
  activeMeasuredGallery = gallery

  await gallery.done
  if (phaseTimes['first-placement'] === undefined) {
    setRowValue(measuredStats, 3, `<b>${fmtMs(performance.now() - t0)}</b>`)
  }
  if (phaseTimes['all-placements'] === undefined) {
    setRowValue(measuredStats, 4, `<b>${fmtMs(performance.now() - t0)}</b>`)
  }

  // Give the first paint of in-viewport tiles a beat to settle, then
  // snapshot bytes. Byte count here is probes + whatever full fetches
  // the viewport triggered.
  await new Promise((r) => setTimeout(r, 500))
  setRowValue(measuredStats, 5, `<b>${fmtBytes(bytesMeter.stop())}</b>`)

  setMeta(`${fmtCount(count)} tiles · measured done · ${imageLoading} · ${dimsLabel} · scroll to load more tiles`)
  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

// --- Controls ---

countSlider.addEventListener('input', () => {
  countVal.textContent = Number(countSlider.value).toLocaleString()
})
countVal.textContent = Number(countSlider.value).toLocaleString()

runNaiveBtn.addEventListener('click', () => {
  void runNaive()
})
runMeasuredBtn.addEventListener('click', () => {
  void runMeasured()
})
