import { prepare } from '@somnai-dreams/preimage'
import { SIDECAR_HEADERS, sidecarUrlFor } from '@somnai-dreams/preimage/sidecar'
import { packShortestColumn } from '@somnai-dreams/layout-algebra'
import { newCacheBustToken, photosManifest } from './photo-source.js'
import { fmtMs, fmtBytes, setRowValue, resetStats } from './demo-formatting.js'

const runBtn = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const headerDumpEl = document.getElementById('headerDump')!
const sidecarDumpEl = document.getElementById('sidecarDump')!

const COLUMNS = 4
const GAP = 4

type Strategy = 'headers' | 'sidecar' | 'range'

type Handles = {
  grid: HTMLElement
  stats: HTMLElement
}

const HANDLES: Record<Strategy, Handles> = {
  headers: {
    grid: document.getElementById('headersGrid') as HTMLElement,
    stats: document.getElementById('headersStats') as HTMLElement,
  },
  sidecar: {
    grid: document.getElementById('sidecarGrid') as HTMLElement,
    stats: document.getElementById('sidecarStats') as HTMLElement,
  },
  range: {
    grid: document.getElementById('rangeGrid') as HTMLElement,
    stats: document.getElementById('rangeStats') as HTMLElement,
  },
}

runBtn.addEventListener('click', () => { void run() })

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  metaEl.textContent = ''
  headerDumpEl.textContent = 'Running…'
  sidecarDumpEl.textContent = 'Running…'
  for (const h of Object.values(HANDLES)) {
    h.grid.innerHTML = ''
    h.grid.style.height = '240px'
    resetStats(h.stats)
  }

  const token = newCacheBustToken()
  const manifestEntries = Object.entries(photosManifest())
  const urls = manifestEntries.map(([key]) => `.${key}?v=${token}`)

  await runStrategy('headers', urls)
  await runStrategy('sidecar', urls)
  await runStrategy('range', urls)

  // Dump the raw Preimage-* HEAD response for the first image, and
  // the text of its sidecar, so callers can eyeball the byte-exact
  // equivalence between the two paths.
  const first = urls[0]
  if (first !== undefined) {
    const headersResp = await fetch(first, { method: 'HEAD' })
    const relevantHeaders: string[] = []
    for (const key of Object.values(SIDECAR_HEADERS)) {
      const v = headersResp.headers.get(key)
      if (v !== null) relevantHeaders.push(`${key}: ${v}`)
    }
    headerDumpEl.textContent = relevantHeaders.length > 0 ? relevantHeaders.join('\n') : '(no Preimage-* headers in HEAD response)'

    const sidecarResp = await fetch(sidecarUrlFor(first))
    sidecarDumpEl.textContent = sidecarResp.ok ? await sidecarResp.text() : `(sidecar fetch failed: ${sidecarResp.status})`
  }

  metaEl.textContent = `${urls.length} photos × 3 strategies`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
}

async function runStrategy(strategy: Strategy, urls: readonly string[]): Promise<void> {
  const { grid, stats } = HANDLES[strategy]

  // The strategy: 'sidecar' path fetches <url>.prei URLs internally;
  // the strategy: 'headers' path does HEAD on the image URL itself.
  // Byte accounting watches both sets of URLs so numbers land in the
  // right bucket regardless of physical path.
  const observed = strategy === 'sidecar' ? urls.map(sidecarUrlFor) : [...urls]
  const byteObserver = observeBytesFor(observed)

  const t0 = performance.now()
  const prepared = await Promise.all(
    urls.map((u, i) =>
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
