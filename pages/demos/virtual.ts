import { PrepareQueue, getMeasurement } from '@somnai-dreams/preimage'
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

type VirtualTile = {
  idx: number
  url: string
  place: Placement
}

// Scroll handler is rAF-throttled so a fast scroll coalesces to one
// recompute per frame. `pending` is a sticky bit that collapses bursts
// of scroll events.
function rafThrottle(fn: () => void): () => void {
  let pending = false
  return () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      fn()
    })
  }
}

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
  const tiles: VirtualTile[] = []

  // DOM recycling pool. Up to ~(viewport-height / min-tile-height) *
  // COLUMNS tiles visible at once; pool holds everything mounted,
  // `active` maps index to the element currently rendering that tile.
  const pool: HTMLDivElement[] = []
  const active = new Map<number, HTMLDivElement>()

  function getEl(): HTMLDivElement {
    const existing = pool.pop()
    if (existing !== undefined) {
      existing.style.display = 'block'
      return existing
    }
    const el = document.createElement('div')
    el.className = 'vtile pending'
    measuredPanel.appendChild(el)
    return el
  }

  function releaseEl(el: HTMLDivElement): void {
    el.style.display = 'none'
    // Clear the old <img>. Leaving it in place would show stale pixels
    // the next time this pooled element is mounted for a *different*
    // tile. The browser HTTP cache dedupes refetches of the same URL,
    // so scrolling back to a previously-seen tile is effectively free.
    el.innerHTML = ''
    el.classList.remove('has-image')
    el.classList.add('pending')
    pool.push(el)
  }

  function renderVisible(): void {
    const scrollY = measuredScroll.scrollTop
    const vh = measuredScroll.clientHeight
    const top = scrollY - OVERSCAN
    const bot = scrollY + vh + OVERSCAN

    // Collect wanted indices. Linear scan over tiles is fine here —
    // at 10k tiles × 60Hz that's 600k comparisons/sec, nothing.
    // A sorted-by-y structure would be faster but adds insertion cost
    // as dim-probes resolve out of order.
    const wanted = new Set<number>()
    for (const t of tiles) {
      if (t.place.y + t.place.height < top) continue
      if (t.place.y > bot) continue
      wanted.add(t.idx)
    }

    // Unmount tiles that scrolled away.
    for (const [idx, el] of active) {
      if (!wanted.has(idx)) {
        active.delete(idx)
        releaseEl(el)
      }
    }

    // Mount tiles that scrolled in.
    for (const t of tiles) {
      if (!wanted.has(t.idx) || active.has(t.idx)) continue
      const el = getEl()
      el.style.left = `${t.place.x}px`
      el.style.top = `${t.place.y}px`
      el.style.width = `${t.place.width}px`
      el.style.height = `${t.place.height}px`
      el.dataset['idx'] = String(t.idx)

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
      img.src = t.url
      el.appendChild(img)

      active.set(t.idx, el)
    }

    setRowValue(measuredStats, 1, `<b>${fmtCount(active.size)}</b>`)
  }

  const onScroll = rafThrottle(renderVisible)
  measuredScroll.addEventListener('scroll', onScroll, { passive: true })

  // Fire every prepare(dimsOnly) through the queue. concurrency: 20
  // is the H2 sweet spot; on H1 the browser's 6-slot cap gatekeeps
  // automatically with no penalty. Each prepare reads ~4KB of header
  // bytes and aborts — for 10k tiles at 4KB each that's ~40MB vs.
  // hundreds of MB for full-body fetches.
  const queue = new PrepareQueue({ concurrency: 20 })

  let firstPlacedMs: number | null = null
  let dimsProbed = 0

  const placePromises = urls.map((url, idx) =>
    queue.enqueue(url, { dimsOnly: true }).then((prepared) => {
      const aspect = getMeasurement(prepared).aspectRatio
      const place = packer.add(aspect)
      tiles.push({ idx, url, place })

      // Grow the spacer monotonically so the scrollbar length tracks
      // "how much layout exists so far." After the last probe resolves,
      // the height is final and stays put.
      measuredPanel.style.height = `${packer.totalHeight()}px`

      dimsProbed++
      setRowValue(measuredStats, 2, `<b>${fmtCount(dimsProbed)} / ${fmtCount(urls.length)}</b>`)

      if (firstPlacedMs === null) {
        firstPlacedMs = performance.now() - t0
        setRowValue(measuredStats, 3, `<b>${fmtMs(firstPlacedMs)}</b>`)
      }

      // Render only when the newly-placed tile would actually be
      // visible — cheap guard avoids a full recompute for off-screen
      // placements, which is most of them when scrolled to top.
      const scrollY = measuredScroll.scrollTop
      const vh = measuredScroll.clientHeight
      if (place.y + place.height >= scrollY - OVERSCAN && place.y <= scrollY + vh + OVERSCAN) {
        renderVisible()
      }
    }),
  )
  await Promise.all(placePromises)

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
