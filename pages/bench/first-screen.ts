import { prepare, clearCache } from '@somnai-dreams/preimage'
import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'
import { packShortestColumn } from '@somnai-dreams/layout-algebra'
import { cycledUrls, photosManifest } from '../demos/photo-source.js'
import {
  captureMetadata,
  getNetworkLabel,
  saveRun,
  wireUploadButton,
  setNetworkLabel,
  type RunMetadata,
} from './common.js'

const nInput = document.getElementById('nInput') as HTMLInputElement
const colsInput = document.getElementById('colsInput') as HTMLInputElement
const networkLabelEl = document.getElementById('networkLabel') as HTMLInputElement
networkLabelEl.value = getNetworkLabel()
networkLabelEl.addEventListener('input', () => setNetworkLabel(networkLabelEl.value.trim()))
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const uploadBtn = document.getElementById('upload') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const progressEl = document.getElementById('progress')!
const tableHost = document.getElementById('table-host')!
const stagesEl = document.getElementById('stages')!
const jsonHost = document.getElementById('json-host')!

type Strategy = 'naive' | 'prepare-img' | 'prepare-stream' | 'manifest-hydrated'

type StrategyResult = {
  strategy: Strategy
  firstSkeletonMs: number | null
  allSkeletonsMs: number | null
  firstImageMs: number | null
  allImagesMs: number | null
  bytesTransferred: number
  resolved: number
  errors: number
}

type FirstScreenParams = {
  n: number
  columns: number
  strategies: Strategy[]
}

let lastRun: {
  meta: RunMetadata
  params: FirstScreenParams
  results: { runs: StrategyResult[] }
} | null = null

runBtn.addEventListener('click', () => { void run() })
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  saveRun(lastRun.meta, lastRun.params, lastRun.results)
})
wireUploadButton(uploadBtn, () => lastRun)

const STRATEGIES: Strategy[] = ['naive', 'prepare-img', 'prepare-stream', 'manifest-hydrated']

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  saveBtn.disabled = true
  uploadBtn.disabled = true
  metaEl.textContent = ''
  progressEl.textContent = ''
  tableHost.innerHTML = ''
  stagesEl.innerHTML = ''
  jsonHost.innerHTML = ''

  const n = Number(nInput.value)
  const columns = Number(colsInput.value)

  // Pre-create the four stage panels so all four appear at once.
  const stagePanels = new Map<Strategy, HTMLElement>()
  const LABELS: Record<Strategy, string> = {
    'naive': 'Naive <img>',
    'prepare-img': 'prepare() img',
    'prepare-stream': 'prepare() stream',
    'manifest-hydrated': 'Manifest hydrated',
  }
  for (const s of STRATEGIES) {
    const panel = document.createElement('div')
    panel.className = 'stage-panel'
    panel.innerHTML = `<h3>${LABELS[s]}</h3><div class="tiles"></div>`
    stagesEl.appendChild(panel)
    stagePanels.set(s, panel.querySelector('.tiles') as HTMLElement)
  }

  const meta = await captureMetadata(
    'first-screen',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )

  const results: StrategyResult[] = []
  renderTable(results)
  for (const strategy of STRATEGIES) {
    progressEl.textContent = `[${results.length + 1}/${STRATEGIES.length}] ${LABELS[strategy]} — running…`
    renderTable(results, strategy)
    // Fresh cache-bust token per strategy so they don't share browser HTTP cache.
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${strategy}`
    const urls = cycledUrls(n, token)
    const tileHost = stagePanels.get(strategy)!
    tileHost.innerHTML = ''
    clearCache()
    const result = await runStrategy(strategy, urls, columns, tileHost)
    results.push(result)
    renderTable(results)
    await new Promise((r) => setTimeout(r, 200))
  }

  progressEl.textContent = `[${STRATEGIES.length}/${STRATEGIES.length}] done`
  lastRun = { meta, params: { n, columns, strategies: STRATEGIES }, results: { runs: results } }

  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params: lastRun.params, results: lastRun.results }, null, 2)
  jsonHost.appendChild(pre)

  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  const rttBit = meta.network.warmupRttMs !== null ? ` · rtt ${meta.network.warmupRttMs.toFixed(0)}ms` : ''
  metaEl.textContent = `${meta.protocol ?? '?'}${rttBit}${labelBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
  uploadBtn.disabled = false
}

async function runStrategy(
  strategy: Strategy,
  urls: readonly string[],
  columns: number,
  tileHost: HTMLElement,
): Promise<StrategyResult> {
  const urlSet = new Set(
    urls.map((u) => new URL(u, location.href).pathname + new URL(u, location.href).search),
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

  const panelWidth = tileHost.getBoundingClientRect().width || 240
  const gap = 4

  const t0 = performance.now()
  let firstSkeletonMs: number | null = null
  let allSkeletonsMs: number | null = null
  let firstImageMs: number | null = null
  let allImagesMs: number | null = null
  let errors = 0

  // --- Naive: drop <img> with no dims, let browser decode + reflow ---
  if (strategy === 'naive') {
    const imgs = urls.map(() => {
      const img = document.createElement('img')
      img.alt = ''
      img.style.width = `${Math.floor((panelWidth - gap * (columns - 1)) / columns)}px`
      img.style.marginBottom = `${gap}px`
      img.style.marginRight = `${gap}px`
      img.style.display = 'inline-block'
      img.style.verticalAlign = 'top'
      tileHost.appendChild(img)
      return img
    })
    for (let i = 0; i < urls.length; i++) imgs[i]!.src = urls[i]!
    const loadTimes: number[] = []
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((resolve) => {
            const done = (): void => {
              const t = performance.now() - t0
              if (firstImageMs === null) firstImageMs = t
              loadTimes.push(t)
              resolve()
            }
            if (img.complete && img.naturalWidth > 0) done()
            else {
              img.addEventListener('load', done, { once: true })
              img.addEventListener('error', () => {
                errors++
                done()
              }, { once: true })
            }
          }),
      ),
    )
    // "Skeleton" for naive is the moment dims are known = image loaded.
    firstSkeletonMs = firstImageMs
    allSkeletonsMs = Math.max(...loadTimes, 0)
    allImagesMs = allSkeletonsMs
  } else {
    // --- Three prepare-based strategies ---
    const prepareOptions =
      strategy === 'prepare-img' ? { dimsOnly: true, strategy: 'img' as const }
      : strategy === 'prepare-stream' ? { dimsOnly: true, strategy: 'stream' as const }
      : null // manifest-hydrated: no probe needed

    if (strategy === 'manifest-hydrated') {
      const manifest = photosManifest()
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]!
        // Strip cache-bust to find the manifest key.
        const key = '/' + new URL(url, location.href).pathname.replace(/^\/+/, '')
        const dims = manifest[key]
        if (dims !== undefined) recordKnownMeasurement(url, dims.width, dims.height)
      }
    }

    type TileRec = { idx: number; url: string; aspect: number; el: HTMLElement }
    const tiles: TileRec[] = []
    const aspects: number[] = []

    // Probe each URL (or hydrate from manifest cache). For naive/
    // manifest-hydrated the probe is effectively free.
    const probeResults = await Promise.all(
      urls.map(async (url, idx) => {
        const p =
          prepareOptions === null
            ? await prepare(url)
            : await prepare(url, prepareOptions)
        const tSkel = performance.now() - t0
        return { idx, url, aspect: p.width / p.height, tSkel }
      }),
    )

    // Once all aspects known, pack the layout synchronously. "Skeleton
    // placed" for this model is pack+append time. First skeleton is
    // the first probe's resolve; we've already tracked that.
    for (const r of probeResults) aspects[r.idx] = r.aspect
    for (const r of probeResults) {
      if (firstSkeletonMs === null) firstSkeletonMs = r.tSkel
      else firstSkeletonMs = Math.min(firstSkeletonMs, r.tSkel)
    }
    allSkeletonsMs = performance.now() - t0
    const { placements } = packShortestColumn(aspects, { panelWidth, gap, columns })
    for (let i = 0; i < placements.length; i++) {
      const place = placements[i]!
      const tile = document.createElement('div')
      tile.className = 'tile pending'
      tile.style.left = `${place.x}px`
      tile.style.top = `${place.y}px`
      tile.style.width = `${place.width}px`
      tile.style.height = `${place.height}px`
      tileHost.appendChild(tile)
      tiles.push({ idx: i, url: urls[i]!, aspect: aspects[i]!, el: tile })
    }

    // Render images. For prepare-img we could reuse the warmed <img>
    // but at this stage we've done dimsOnly so there's nothing warmed
    // to reuse anyway. Consistent path: fresh <img> per tile.
    const loadTimes: number[] = []
    await Promise.all(
      tiles.map(
        (t) =>
          new Promise<void>((resolve) => {
            const img = new Image()
            img.alt = ''
            img.src = t.url
            const done = (): void => {
              const ts = performance.now() - t0
              if (firstImageMs === null) firstImageMs = ts
              loadTimes.push(ts)
              img.classList.add('loaded')
              t.el.classList.remove('pending')
              resolve()
            }
            if (img.complete && img.naturalWidth > 0) done()
            else {
              img.addEventListener('load', done, { once: true })
              img.addEventListener('error', () => {
                errors++
                done()
              }, { once: true })
            }
            t.el.appendChild(img)
          }),
      ),
    )
    allImagesMs = Math.max(...loadTimes, 0)
  }

  await new Promise((r) => setTimeout(r, 80))
  observer.disconnect()

  return {
    strategy,
    firstSkeletonMs,
    allSkeletonsMs,
    firstImageMs,
    allImagesMs,
    bytesTransferred: bytes,
    resolved: urls.length - errors,
    errors,
  }
}

function renderTable(results: readonly StrategyResult[], running?: Strategy): void {
  const LABELS: Record<Strategy, string> = {
    'naive': 'Naive <img>',
    'prepare-img': 'prepare() img',
    'prepare-stream': 'prepare() stream',
    'manifest-hydrated': 'Manifest hydrated',
  }
  const table = document.createElement('table')
  table.className = 'fs'
  const thead = document.createElement('thead')
  thead.innerHTML = `<tr>
    <th>Strategy</th>
    <th>First skeleton</th>
    <th>All skeletons</th>
    <th>First image</th>
    <th>All images</th>
    <th>Bytes</th>
    <th>Errors</th>
  </tr>`
  table.appendChild(thead)
  const tbody = document.createElement('tbody')

  // Best skeleton time across done rows.
  const doneFirstSkel = results.map((r) => r.firstSkeletonMs).filter((v): v is number => v !== null)
  const bestFirstSkel = doneFirstSkel.length > 0 ? Math.min(...doneFirstSkel) : null
  const doneAllImg = results.map((r) => r.allImagesMs).filter((v): v is number => v !== null)
  const bestAllImg = doneAllImg.length > 0 ? Math.min(...doneAllImg) : null

  for (const strategy of STRATEGIES) {
    const row = results.find((r) => r.strategy === strategy)
    const tr = document.createElement('tr')
    if (row === undefined && strategy === running) tr.className = 'running'
    const firstSkel = row?.firstSkeletonMs
    const allImg = row?.allImagesMs
    const cell = (v: number | null | undefined, best: number | null): string => {
      if (v === null || v === undefined) return row === undefined ? '—' : 'n/a'
      const bestClass = best !== null && Math.abs(v - best) < 0.5 ? ' class="best"' : ''
      return `<td${bestClass}>${v.toFixed(0)}ms</td>`
    }
    tr.innerHTML = `
      <td class="strategy">${LABELS[strategy]}${strategy === running ? ' (running…)' : ''}</td>
      ${cell(firstSkel, bestFirstSkel)}
      <td>${row === undefined ? '—' : row.allSkeletonsMs?.toFixed(0) + 'ms'}</td>
      <td>${row === undefined ? '—' : row.firstImageMs?.toFixed(0) + 'ms'}</td>
      ${cell(allImg, bestAllImg)}
      <td>${row === undefined ? '—' : fmtBytes(row.bytesTransferred)}</td>
      <td>${row === undefined ? '—' : row.errors}</td>`
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  tableHost.innerHTML = ''
  tableHost.appendChild(table)
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.round(bytes)} B`
}
