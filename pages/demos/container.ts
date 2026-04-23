import { prepare } from '@somnai-dreams/preimage'
import { decodeContainerPrefix, PREIMAGE_CONTAINER_SIZE } from '@somnai-dreams/preimage/container'
import { packShortestColumn } from '@somnai-dreams/layout-algebra'
import { newCacheBustToken, photosManifest } from './photo-source.js'
import { fmtMs, fmtBytes, setRowValue, resetStats } from './demo-formatting.js'

const runBtn = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const prefixDumpEl = document.getElementById('prefixDump')!

const COLUMNS = 4
const GAP = 4

type Strategy = 'container' | 'range' | 'img'

type Handles = {
  grid: HTMLElement
  stats: HTMLElement
}

const HANDLES: Record<Strategy, Handles> = {
  container: {
    grid: document.getElementById('containerGrid') as HTMLElement,
    stats: document.getElementById('containerStats') as HTMLElement,
  },
  range: {
    grid: document.getElementById('rangeGrid') as HTMLElement,
    stats: document.getElementById('rangeStats') as HTMLElement,
  },
  img: {
    grid: document.getElementById('imgGrid') as HTMLElement,
    stats: document.getElementById('imgStats') as HTMLElement,
  },
}

// The .prei endpoint is synthesised by the dev server for any asset
// under /assets/. Client appends ".prei" to the underlying URL; the
// server wraps the real file in a 128-byte container on-the-fly.
function appendPrei(url: string): string {
  const u = new URL(url, location.href)
  u.pathname += '.prei'
  return u.toString()
}

runBtn.addEventListener('click', () => { void run() })

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  metaEl.textContent = ''
  prefixDumpEl.textContent = 'Running…'
  for (const h of Object.values(HANDLES)) {
    h.grid.innerHTML = ''
    h.grid.style.height = '240px'
    resetStats(h.stats)
  }

  // Fresh cache-bust token so each Run goes to the server; the three
  // strategies share the token so they're measuring the same server
  // cost, not browser HTTP cache vs cold fetch.
  const token = newCacheBustToken()
  const manifestEntries = Object.entries(photosManifest())
  const urls = manifestEntries.map(([key]) => `.${key}?v=${token}`)

  // Run the three strategies serially so they don't compete for
  // network slots. Container first, then range, then img.
  const containerResults = await runStrategy('container', urls)
  const rangeResults = await runStrategy('range', urls)
  const imgResults = await runStrategy('img', urls)

  // Dump the decoded prefix of the first container probe into the
  // pre block so the caller can eyeball the 128-byte payload.
  const first = containerResults[0]
  if (first !== undefined) {
    const bytes = await fetchPrefix(first.url)
    const decoded = decodeContainerPrefix(bytes)
    prefixDumpEl.textContent = JSON.stringify(
      decoded,
      (_k, v) => (v instanceof Uint8Array ? Array.from(v).map((b) => b.toString(16).padStart(2, '0')).join('') : v),
      2,
    )
  }

  metaEl.textContent = `${urls.length} photos × 3 strategies`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
}

type RunResult = { url: string; width: number; height: number }

async function runStrategy(strategy: Strategy, urls: readonly string[]): Promise<RunResult[]> {
  const { grid, stats } = HANDLES[strategy]
  const resolvedUrls = strategy === 'container' ? urls.map(appendPrei) : [...urls]

  const byteObserver = observeBytesFor(resolvedUrls)
  const t0 = performance.now()
  const prepared = await Promise.all(
    resolvedUrls.map((u, i) =>
      prepare(u, { dimsOnly: true, strategy }).then((p) => ({
        url: u,
        width: p.width,
        height: p.height,
        index: i,
      })),
    ),
  )
  const wallMs = performance.now() - t0
  await new Promise((r) => setTimeout(r, 100))
  const bytes = byteObserver.stop()

  renderGrid(grid, prepared.map((p) => ({ url: urls[p.index]!, width: p.width, height: p.height })))

  setRowValue(stats, 1, `<b>${fmtMs(wallMs)}</b>`)
  setRowValue(stats, 2, `<b>${fmtBytes(bytes / Math.max(1, prepared.length))}</b>`)
  setRowValue(stats, 3, `<b>${fmtBytes(bytes)}</b>`)

  return prepared.map((p) => ({ url: p.url, width: p.width, height: p.height }))
}

async function fetchPrefix(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${PREIMAGE_CONTAINER_SIZE - 1}` } })
  return new Uint8Array(await response.arrayBuffer())
}

function observeBytesFor(urls: readonly string[]): { stop: () => number } {
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
  return {
    stop: () => {
      observer.disconnect()
      return bytes
    },
  }
}

function renderGrid(
  container: HTMLElement,
  items: readonly { url: string; width: number; height: number }[],
): void {
  const panelWidth = container.getBoundingClientRect().width - GAP * 2
  const aspects = items.map((i) => i.width / i.height)
  const { placements, totalHeight } = packShortestColumn(aspects, {
    columns: COLUMNS,
    gap: GAP,
    panelWidth,
  })
  container.style.height = `${totalHeight + GAP * 2}px`

  const frag = document.createDocumentFragment()
  for (let i = 0; i < placements.length; i++) {
    const place = placements[i]!
    const item = items[i]!
    const tile = document.createElement('div')
    tile.className = 'item'
    tile.style.left = `${place.x + GAP}px`
    tile.style.top = `${place.y + GAP}px`
    tile.style.width = `${place.width}px`
    tile.style.height = `${place.height}px`

    // Paint via the underlying URL (not the .prei wrapper) so the
    // browser can decode it natively. The container path proved dims;
    // render goes through the normal image fetch.
    const img = new Image()
    img.alt = ''
    img.src = item.url
    if (img.complete && img.naturalWidth > 0) img.classList.add('loaded')
    else img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
    tile.appendChild(img)
    frag.appendChild(tile)
  }
  container.appendChild(frag)
}
