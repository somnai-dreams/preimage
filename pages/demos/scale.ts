import { PrepareQueue, getMeasurement } from '../../src/index.js'
import { cycledUrls } from './photo-source.js'
import { observeShifts } from './demo-utils.js'

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

const COLUMNS = 4
const GAP = 4

function getCount(): number {
  return Number(countSlider.value)
}

function freshToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function setMeta(count: number, running: string): void {
  metaEl.textContent = `${count} tiles · ${running}`
}

// --- Stat helpers ---

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(0)}ms`
}

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function setShifts(host: HTMLElement, n: number): void {
  const row = host.querySelector<HTMLElement>('.row.shift')
  if (row === null) return
  row.classList.toggle('has-shifts', n > 0)
  row.querySelector('.value b')!.innerHTML = String(n)
}

function resetStats(host: HTMLElement): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (const row of rows) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
  }
  host.querySelector<HTMLElement>('.row.shift')?.classList.remove('has-shifts')
}

// --- Layout math (shortest column) ---

type Placement = { x: number; y: number; width: number; height: number }

function layoutShortestColumn(
  aspects: readonly number[],
  panelWidth: number,
): { placements: Placement[]; totalHeight: number } {
  const colWidth = (panelWidth - GAP * (COLUMNS - 1)) / COLUMNS
  const heights = new Array<number>(COLUMNS).fill(0)
  const placements: Placement[] = []
  for (const aspect of aspects) {
    let shortest = 0
    for (let c = 1; c < COLUMNS; c++) {
      if (heights[c]! < heights[shortest]!) shortest = c
    }
    const h = colWidth / aspect
    const x = shortest * (colWidth + GAP)
    const y = heights[shortest]!
    placements.push({ x, y, width: colWidth, height: h })
    heights[shortest] = y + h + GAP
  }
  return { placements, totalHeight: Math.max(...heights) - GAP }
}

// --- Bytes accounting via PerformanceObserver ---

// Watch the Resource Timing API for image fetches that complete
// during our run window. transferSize reflects wire bytes including
// headers; encodedBodySize reflects body bytes (0 for dimsOnly-
// aborted responses in many browsers). Sum both for a rough
// estimate of what the network actually delivered.
type BytesMeter = {
  stop: () => number
}

function measureBytes(predicate: (url: string) => boolean): BytesMeter {
  let total = 0
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntriesByType('resource')) {
      if (!predicate(entry.name)) continue
      // transferSize is 0 for cached responses in some browsers and
      // can be undefined for cross-origin without Timing-Allow-Origin.
      // encodedBodySize is more reliable for body bytes actually
      // received. Use the max of the two as a heuristic.
      const r = entry as PerformanceResourceTiming
      const bytes = Math.max(r.transferSize ?? 0, r.encodedBodySize ?? 0)
      total += bytes
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
  setMeta(count, 'naive running')
  const urls = cycledUrls(count, token)

  const urlSet = new Set(urls)
  const bytesMeter = measureBytes((u) => urlSet.has(new URL(u, location.origin).pathname + (new URL(u, location.origin).search)))

  const t0 = performance.now()
  const monitor = observeShifts(naivePanel)

  // Stock browser behaviour: append every <img>, let them fetch and
  // decode at whatever pace the connection pool allows.
  const imgs = urls.map(() => {
    const img = document.createElement('img')
    img.alt = ''
    naivePanel.appendChild(img)
    return img
  })
  for (let i = 0; i < urls.length; i++) imgs[i]!.src = urls[i]!

  let firstLoadedMs: number | null = null
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            if (firstLoadedMs === null) {
              firstLoadedMs = performance.now() - t0
              setRowValue(naiveStats, 1, `<b>${fmtMs(firstLoadedMs)}</b>`)
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
  monitor.stop()
  setRowValue(naiveStats, 2, `<b>${fmtMs(allLoadedMs)}</b>`)
  setShifts(naiveStats, monitor.shifts())
  // Give resource-timing entries a beat to settle before reading.
  await new Promise((r) => setTimeout(r, 100))
  setRowValue(naiveStats, 4, `<b>${fmtBytes(bytesMeter.stop())}</b>`)

  setMeta(count, 'naive done')
  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Run again'
}

// --- Measured run ---

async function runMeasured(): Promise<void> {
  runMeasuredBtn.disabled = true
  runMeasuredBtn.textContent = 'Running…'
  measuredPanel.innerHTML = ''
  measuredPanel.style.height = '0px'
  resetStats(measuredStats)

  const count = getCount()
  const token = freshToken()
  setMeta(count, 'measured running')
  const urls = cycledUrls(count, token)

  const urlSet = new Set(urls.map((u) => new URL(u, location.origin).pathname + new URL(u, location.origin).search))
  const bytesMeter = measureBytes((u) => {
    const parsed = new URL(u, location.origin)
    return urlSet.has(parsed.pathname + parsed.search)
  })

  const t0 = performance.now()

  // Phase 1: measure every tile with dimsOnly — abort the body fetch
  // after the header bytes arrive. Application-level queue holds the
  // requests so the browser's 6-connection cap isn't fought over
  // with render-side fetches later.
  const queue = new PrepareQueue({ concurrency: 6 })
  const prepared = await Promise.all(urls.map((u) => queue.enqueue(u, { dimsOnly: true })))
  const dimsMs = performance.now() - t0
  setRowValue(measuredStats, 1, `<b>${fmtMs(dimsMs)}</b>`)

  // Phase 2: lay out every tile from the measured aspect ratios.
  const panelWidth = measuredPanel.getBoundingClientRect().width
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const { placements, totalHeight } = layoutShortestColumn(aspects, panelWidth)
  measuredPanel.style.height = `${totalHeight}px`

  const tiles: Array<{ container: HTMLElement; img: HTMLImageElement | null; url: string }> = []
  const frag = document.createDocumentFragment()
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!
    const container = document.createElement('div')
    container.className = 'item pending'
    container.style.left = `${p.x}px`
    container.style.top = `${p.y}px`
    container.style.width = `${p.width}px`
    container.style.height = `${p.height}px`
    frag.appendChild(container)
    tiles.push({ container, img: null, url: urls[i]! })
  }
  measuredPanel.appendChild(frag)
  const laidOutMs = performance.now() - t0
  setRowValue(measuredStats, 2, `<b>${fmtMs(laidOutMs)}</b>`)

  // Phase 3: as tiles scroll into view, commit to a full fetch.
  // The IntersectionObserver fires once per tile — we load it, drop
  // the observer, move on. Tiles never observed keep their dimsOnly
  // savings forever.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const idx = tiles.findIndex((t) => t.container === entry.target)
        if (idx === -1) continue
        const tile = tiles[idx]!
        if (tile.img !== null) continue
        const img = new Image()
        img.alt = ''
        img.addEventListener('load', () => {
          img.classList.add('loaded')
          tile.container.classList.add('has-image')
          tile.container.classList.remove('pending')
        }, { once: true })
        img.src = tile.url
        tile.container.appendChild(img)
        tile.img = img
        io.unobserve(entry.target)
      }
    },
    { root: measuredScroll, rootMargin: '200px' },
  )
  for (const tile of tiles) io.observe(tile.container)

  // Wait for every visible tile to finish loading. "Visible" means
  // intersecting at the time we check — a conservative bound for
  // what the user would see if they didn't scroll.
  await new Promise<void>((resolve) => setTimeout(resolve, 500))
  const visibleTiles = tiles.filter((t) => {
    const rect = t.container.getBoundingClientRect()
    const scrollRect = measuredScroll.getBoundingClientRect()
    return rect.top < scrollRect.bottom && rect.bottom > scrollRect.top
  })
  await Promise.all(
    visibleTiles.map((tile) => {
      if (tile.img === null) return Promise.resolve()
      const img = tile.img
      return new Promise<void>((resolve) => {
        if (img.complete && img.naturalWidth > 0) resolve()
        else {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
        }
      })
    }),
  )
  const visibleLoadedMs = performance.now() - t0
  setRowValue(measuredStats, 3, `<b>${fmtMs(visibleLoadedMs)}</b>`)

  await new Promise((r) => setTimeout(r, 400))
  setRowValue(measuredStats, 4, `<b>${fmtBytes(bytesMeter.stop())}</b>`)

  setMeta(count, 'measured done · scroll to load more tiles')
  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

// --- Controls ---

countSlider.addEventListener('input', () => {
  countVal.textContent = countSlider.value
})
countVal.textContent = countSlider.value

runNaiveBtn.addEventListener('click', () => void runNaive())
runMeasuredBtn.addEventListener('click', () => void runMeasured())
