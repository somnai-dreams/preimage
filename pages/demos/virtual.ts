import { PrepareQueue, getMeasurement } from '@somnai-dreams/preimage'
import { createVirtualTilePool } from '@somnai-dreams/preimage/virtual'
import { shortestColumnCursor, type Placement } from '@somnai-dreams/layout-algebra'
import { cycledUrls } from './photo-source.js'

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
// How far above/below the viewport to mount tiles — wider overscan
// means fewer mount/unmount churns when scrolling fast, narrower
// means fewer DOM nodes at any one time. 600px is a comfortable
// compromise: a fast scroll scrolls ~1500px/sec and we want ~400ms
// of buffer.
const OVERSCAN = 600

function getCount(): number {
  return Number(countSlider.value)
}

function freshToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function setMeta(msg: string): void {
  metaEl.textContent = msg
}

// --- Stat helpers (same shape as scale.ts so the visual reads
// identically when both demos are open side by side) ---

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(0)}ms`
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function fmtCount(n: number): string {
  return n.toLocaleString()
}

function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function resetStats(host: HTMLElement): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (const row of rows) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
  }
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

async function runMeasured(): Promise<void> {
  runMeasuredBtn.disabled = true
  runMeasuredBtn.textContent = 'Running…'
  measuredPanel.innerHTML = ''
  measuredPanel.style.height = '0px'
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

  // `placements[i]` is the i-th resolved tile in resolution order.
  // `indexUrl[i]` is the URL that `mount` should render for that
  // tile. Both arrays grow monotonically as prepare() resolves fire.
  const placements: Placement[] = []
  const indexUrl: string[] = []

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
      el.dataset['idx'] = String(idx)

      const img = new Image()
      img.alt = ''
      img.addEventListener(
        'load',
        () => {
          img.classList.add('loaded')
          el.classList.add('has-image')
          el.classList.remove('pending')
        },
        { once: true },
      )
      img.src = indexUrl[idx]!
      el.appendChild(img)

      setRowValue(measuredStats, 1, `<b>${fmtCount(pool.activeCount)}</b>`)
    },
    unmount: (_idx, el) => {
      // Cancel any in-flight image fetch before discarding the <img>.
      // Removing the element from the DOM alone doesn't stop the
      // browser from finishing the request in the background.
      const img = el.querySelector('img')
      if (img !== null) img.src = ''
      el.innerHTML = ''
      el.classList.remove('has-image')
      el.classList.add('pending')
      setRowValue(measuredStats, 1, `<b>${fmtCount(pool.activeCount)}</b>`)
    },
  })

  // Fire every prepare(dimsOnly) through the queue. concurrency: 20
  // is the H2 sweet spot; on H1 the browser's 6-slot cap gatekeeps
  // automatically with no penalty. Each prepare reads ~4KB of header
  // bytes and aborts — for 10k tiles at 4KB each that's ~40MB vs.
  // hundreds of MB for full-body fetches.
  const queue = new PrepareQueue({ concurrency: 20 })

  let firstPlacedMs: number | null = null
  let dimsProbed = 0

  // Don't start mounting tiles (and kicking off their full-image
  // fetches) until we've packed enough placements to cover the first
  // screen. Until that threshold, dim probes run unopposed for
  // connection slots — so the first screen of real images starts
  // loading from a state where 20+ parallel GETs are available
  // instead of sharing with in-flight probes.
  const firstScreenThreshold =
    measuredScroll.clientHeight + OVERSCAN
  let mountingStarted = false

  const placePromises = urls.map((url) =>
    queue.enqueue(url, { dimsOnly: true }).then((prepared) => {
      const aspect = getMeasurement(prepared).aspectRatio
      const place = packer.add(aspect)
      placements.push(place)
      indexUrl.push(url)

      // Grow the spacer monotonically so the scrollbar length tracks
      // "how much layout exists so far." After the last probe resolves,
      // the height is final and stays put.
      measuredPanel.style.height = `${packer.totalHeight()}px`

      // Gate the tile-pool: feed placements only once the first
      // screen is covered (or this is the final tile, whichever
      // comes first). After the gate opens, every subsequent resolve
      // feeds normally so new tiles mount as they scroll into view.
      if (!mountingStarted && packer.totalHeight() >= firstScreenThreshold) {
        mountingStarted = true
      }
      if (mountingStarted) pool.setPlacements(placements)

      dimsProbed++
      setRowValue(measuredStats, 2, `<b>${fmtCount(dimsProbed)} / ${fmtCount(urls.length)}</b>`)

      if (mountingStarted && firstPlacedMs === null) {
        firstPlacedMs = performance.now() - t0
        setRowValue(measuredStats, 3, `<b>${fmtMs(firstPlacedMs)}</b>`)
      }
    }),
  )
  await Promise.all(placePromises)

  // Final safety net: if the whole layout is shorter than the first
  // screen (count small enough that the gate never triggered), mount
  // everything now.
  if (!mountingStarted) pool.setPlacements(placements)

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
