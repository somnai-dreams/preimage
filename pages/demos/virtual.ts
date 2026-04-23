import { PrepareQueue } from '@somnai-dreams/preimage'
import { createVirtualTilePool } from '@somnai-dreams/preimage/virtual'
import {
  estimateFirstScreenCount,
  shortestColumnCursor,
  type Placement,
} from '@somnai-dreams/layout-algebra'
import { cycledUrls } from './photo-source.js'
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

// Retained across runs so "Run again" can tear down the pool from the
// prior run before creating a new one. Without this, each run leaks a
// scroll listener + ResizeObserver on measuredScroll; the stale pool
// still holds the previous run's placements and on every scroll event
// re-appends its orphaned recycled elements into measuredPanel at the
// old placement coordinates. Result: ghost tiles from earlier runs
// overlaid on top of the current grid.
let activeMeasuredPool: { destroy: () => void } | null = null

function getCount(): number {
  return Number(countSlider.value)
}

function freshToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
// pool.setPlacements, and two stat rows on every one of up to 2000
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
  if (activeMeasuredPool !== null) {
    activeMeasuredPool.destroy()
    activeMeasuredPool = null
  }
  measuredPanel.innerHTML = ''
  measuredPanel.style.height = '0px'
  measuredScroll.scrollTop = 0
  resetStats(measuredStats)

  const count = getCount()
  const token = freshToken()
  setMeta(`${fmtCount(count)} tiles · measured building`)
  const urls = cycledUrls(count, token)

  const urlSet = new Set(
    urls.map((u) => new URL(u, location.href).pathname + new URL(u, location.href).search),
  )
  const bytesMeter = measureBytes((u) => {
    const parsed = new URL(u, location.href)
    return urlSet.has(parsed.pathname + parsed.search)
  })

  const t0 = performance.now()

  const packer = shortestColumnCursor({
    columns: COLUMNS,
    gap: GAP,
    panelWidth: measuredPanel.getBoundingClientRect().width,
  })

  // Transient state. Promise resolves only mutate these; all DOM
  // writes live in render().
  const placements: Placement[] = []
  const indexUrl: string[] = []
  let dimsProbed = 0
  let firstPlacedMs: number | null = null

  const pool = createVirtualTilePool({
    scrollContainer: measuredScroll,
    contentContainer: measuredPanel,
    overscan: OVERSCAN,
    mount: (idx, el, place) => {
      el.className = 'vtile pending'
      el.style.left = `${place.x}px`
      el.style.top = `${place.y}px`
      el.style.width = `${place.width}px`
      el.style.height = `${place.height}px`

      const img = new Image()
      img.alt = ''
      img.src = indexUrl[idx]!
      // Cache-hit fast path: scroll-back re-mounts a tile whose
      // bytes the browser already has. `complete` is synchronously
      // true after src is set when cached — apply the final class
      // state before the node is inserted so no fade runs.
      if (img.complete && img.naturalWidth > 0) {
        markTileLoaded(el, img)
      } else {
        img.addEventListener('load', () => markTileLoaded(el, img), { once: true })
      }
      el.appendChild(img)
    },
    unmount: (_idx, el) => {
      // Cancel any in-flight image fetch before discarding the <img>.
      // Removing the element from the DOM alone doesn't stop the
      // browser from finishing the request in the background.
      const img = el.querySelector('img')
      if (img !== null) img.src = ''
      el.innerHTML = ''
      el.className = 'vtile pending'
    },
  })
  activeMeasuredPool = pool

  // rAF-batched render. All the DOM writes that used to fire per
  // probe-resolve now coalesce into one pass per frame. With up to
  // 20 concurrent probes per frame this trims 20× redundant layout
  // reads inside pool.setPlacements and 20× stat-row innerHTML ops
  // down to a single pass.
  let renderPending = false
  function scheduleRender(): void {
    if (renderPending) return
    renderPending = true
    requestAnimationFrame(() => {
      renderPending = false
      render()
    })
  }
  function render(): void {
    measuredPanel.style.height = `${packer.totalHeight()}px`
    pool.setPlacements(placements)
    setRowValue(measuredStats, 1, `<b>${fmtCount(pool.activeCount)}</b>`)
    setRowValue(measuredStats, 2, `<b>${fmtCount(dimsProbed)} / ${fmtCount(urls.length)}</b>`)
    if (firstPlacedMs !== null) {
      setRowValue(measuredStats, 3, `<b>${fmtMs(firstPlacedMs)}</b>`)
    }
  }

  // Fire every prepare(dimsOnly) through the queue. concurrency: 20
  // is the H2 sweet spot; on H1 the browser's 6-slot cap gatekeeps
  // automatically with no penalty. Each prepare reads ~4KB of header
  // bytes and aborts — for 10k tiles at 4KB each that's ~40MB vs.
  // hundreds of MB for full-body fetches.
  const queue = new PrepareQueue({ concurrency: getConcurrency() })
  const strategy = getStrategy()

  const placePromises = urls.map((url) =>
    queue.enqueue(url, { dimsOnly: true, strategy }).then((prepared) => {
      const aspect = prepared.aspectRatio
      placements.push(packer.add(aspect))
      indexUrl.push(url)
      dimsProbed++
      if (firstPlacedMs === null) firstPlacedMs = performance.now() - t0
      scheduleRender()
    }),
  )

  // First-screen prioritization: ask layout-algebra how many leading
  // tiles will land in the first viewport under our columns/gap/width
  // config, then boost just those URLs to the front of the queue so
  // they probe before the below-fold backlog. The probe-per-tile cost
  // is the same, but the tiles you're actually looking at land first.
  const firstK = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth: measuredPanel.getBoundingClientRect().width,
    viewportHeight: measuredScroll.getBoundingClientRect().height,
    gap: GAP,
    columns: COLUMNS,
  })
  queue.boostMany(urls.slice(0, firstK))

  await Promise.all(placePromises)

  // Final render — inline, not rAF, because we're reporting the
  // terminal state and a possibly-still-pending scheduled rAF would
  // race with the stat writes below.
  render()
  const allPlacedMs = performance.now() - t0
  setRowValue(measuredStats, 4, `<b>${fmtMs(allPlacedMs)}</b>`)

  // Give the first paint of in-viewport tiles a beat to settle, then
  // snapshot bytes. Byte count here is probes + whatever full fetches
  // the viewport triggered.
  await new Promise((r) => setTimeout(r, 500))
  setRowValue(measuredStats, 5, `<b>${fmtBytes(bytesMeter.stop())}</b>`)

  setMeta(`${fmtCount(count)} tiles · measured done · scroll to load more tiles`)
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
