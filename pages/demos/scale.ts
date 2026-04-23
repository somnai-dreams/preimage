import { PrepareQueue } from '@somnai-dreams/preimage'
import { shortestColumnCursor } from '@somnai-dreams/layout-algebra'
import { cycledUrls } from './photo-source.js'
import { observeShifts } from './demo-utils.js'
import { getConcurrency, getStrategy } from './nav-concurrency.js'
import { fmtMs, fmtBytes, setRowValue, resetStats } from './demo-formatting.js'

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

function setShifts(host: HTMLElement, n: number): void {
  const row = host.querySelector<HTMLElement>('.row.shift')
  if (row === null) return
  row.classList.toggle('has-shifts', n > 0)
  row.querySelector('.value b')!.innerHTML = String(n)
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

  const urlSet = new Set(urls.map((u) => new URL(u, location.href).pathname + new URL(u, location.href).search))
  const bytesMeter = measureBytes((u) => {
    const parsed = new URL(u, location.href)
    return urlSet.has(parsed.pathname + parsed.search)
  })

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

  const urlSet = new Set(urls.map((u) => new URL(u, location.href).pathname + new URL(u, location.href).search))
  const bytesMeter = measureBytes((u) => {
    const parsed = new URL(u, location.href)
    return urlSet.has(parsed.pathname + parsed.search)
  })

  const t0 = performance.now()

  // Shortest-column cursor. Each time prepare() resolves we hand the
  // aspect to the cursor, get back a { x, y, width, height }, drop a
  // tile there. Existing tiles never move, so there's no reflow —
  // just growth at the bottom.
  const packer = shortestColumnCursor({
    columns: COLUMNS,
    gap: GAP,
    panelWidth: measuredPanel.getBoundingClientRect().width,
  })

  type Tile = { container: HTMLElement; img: HTMLImageElement | null; url: string }
  const tiles: Tile[] = []
  let firstTileMs: number | null = null
  let lastTileMs: number | null = null

  // IntersectionObserver watches each tile as it gets placed. When a
  // tile intersects the scroll viewport (with 200px rootMargin) we
  // spin up a fresh <img> for the full fetch. Tiles that never
  // scroll into view keep their dimsOnly savings.
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const tile = tiles.find((t) => t.container === entry.target)
        if (tile === undefined || tile.img !== null) continue
        const img = new Image()
        img.alt = ''
        img.src = tile.url
        if (img.complete && img.naturalWidth > 0) {
          img.classList.add('loaded')
          tile.container.classList.add('has-image')
          tile.container.classList.remove('pending')
        } else {
          img.addEventListener(
            'load',
            () => {
              img.classList.add('loaded')
              tile.container.classList.add('has-image')
              tile.container.classList.remove('pending')
            },
            { once: true },
          )
        }
        tile.container.appendChild(img)
        tile.img = img
        io.unobserve(entry.target)
      }
    },
    { root: measuredScroll, rootMargin: '200px' },
  )

  // Application-level queue. concurrency: 20 hits the sweet spot on
  // HTTP/2 origins (this site is H2 under GitHub Pages); on HTTP/1.1
  // the browser's 6-slot cap gatekeeps automatically with no penalty.
  const queue = new PrepareQueue({ concurrency: getConcurrency() })
  const strategy = getStrategy()

  await Promise.all(
    urls.map((url) =>
      queue.enqueue(url, { dimsOnly: true, strategy }).then((prepared) => {
        const place = packer.add(prepared.aspectRatio)
        measuredPanel.style.height = `${packer.totalHeight()}px`

        const container = document.createElement('div')
        container.className = 'item pending'
        container.style.left = `${place.x}px`
        container.style.top = `${place.y}px`
        container.style.width = `${place.width}px`
        container.style.height = `${place.height}px`
        measuredPanel.appendChild(container)

        const tile: Tile = { container, img: null, url }
        tiles.push(tile)
        io.observe(container)

        const now = performance.now() - t0
        if (firstTileMs === null) {
          firstTileMs = now
          setRowValue(measuredStats, 1, `<b>${fmtMs(firstTileMs)}</b>`)
        }
        lastTileMs = now
        setRowValue(measuredStats, 2, `<b>${fmtMs(lastTileMs)}</b>`)
      }),
    ),
  )

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
