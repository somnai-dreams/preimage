import { prepare, getMeasurement, type PreparedImage } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'
import { observeShifts, paintDominantColorBehind, setPanelStatus } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveStat = document.getElementById('naiveStat')!
const measuredStat = document.getElementById('measuredStat')!

const COUNT = 60
const COLUMNS = 3
const GAP = 6

// Generate 60 unique seeds with realistic photo aspect ratios. Picsum
// serves a fresh image per seed at the requested dimensions; the seed
// keeps the visual stable across runs while the cache-bust token still
// forces a network fetch.
const ASPECTS: Array<[number, number]> = [
  [1600, 1067], // 3:2 landscape
  [1200, 1600], // 3:4 portrait
  [1800, 1200], // 3:2 landscape
  [1600, 900],  // 16:9 landscape
  [1000, 1400], // 5:7 portrait
  [1500, 1000], // 3:2 landscape
  [1400, 1400], // 1:1 square
  [1920, 1080], // 16:9 landscape
  [900, 1600],  // 9:16 portrait
  [2000, 1333], // 3:2 landscape
]

const PHOTOS: PhotoDescriptor[] = Array.from({ length: COUNT }, (_, i) => {
  const [w, h] = ASPECTS[i % ASPECTS.length]!
  return {
    seed: `preimage-masonry-${i}`,
    width: w,
    height: h,
    caption: `photo ${i + 1}`,
  }
})

function metric(label: string, value: string, highlight = false): string {
  return `<span class="metric">${label} <b${highlight ? ' style="color:var(--reflow)"' : ''}>${value}</b></span>`
}

// Simple shortest-column masonry. Given an array of {aspectRatio} and a
// panel width, place each into whichever column currently has the least
// accumulated height. Layout logic lives in the demo, not in the library
// — preimage's contribution is providing the measured aspect ratios
// before any paint happens.
type Placement = { col: number; x: number; y: number; width: number; height: number }

function layoutMasonry(
  aspects: readonly number[],
  panelWidth: number,
  columns: number,
  gap: number,
): { placements: Placement[]; totalHeight: number } {
  const colWidth = (panelWidth - gap * (columns - 1)) / columns
  const heights = new Array<number>(columns).fill(0)
  const placements: Placement[] = []
  for (const aspect of aspects) {
    let shortest = 0
    for (let c = 1; c < columns; c++) {
      if (heights[c]! < heights[shortest]!) shortest = c
    }
    const h = colWidth / aspect
    const x = shortest * (colWidth + gap)
    const y = heights[shortest]!
    placements.push({ col: shortest, x, y, width: colWidth, height: h })
    heights[shortest] = y + h + gap
  }
  return { placements, totalHeight: Math.max(...heights) }
}

type ResolvedPhoto = { url: string; origin: 'picsum' | 'fallback' }

async function resolvePhotosForPanel(
  useLive: boolean,
  cacheBust: string | null,
  panelTag: string,
): Promise<ResolvedPhoto[]> {
  if (useLive) {
    // Each panel gets its own URL-space so the second panel isn't
    // served from the HTTP cache populated by the first (which would
    // inflate the faster panel's apparent speed).
    return PHOTOS.map((p) => {
      const base = picsumUrl(p, cacheBust)
      const sep = base.includes('?') ? '&' : '?'
      return { url: `${base}${sep}panel=${panelTag}`, origin: 'picsum' as const }
    })
  }
  const results: ResolvedPhoto[] = []
  for (let i = 0; i < PHOTOS.length; i++) {
    const blob = await generateFallbackBlob(PHOTOS[i]!, (i * 43 + panelTag.length) % 360)
    results.push({ url: URL.createObjectURL(blob), origin: 'fallback' })
  }
  return results
}

async function renderNaive(urls: readonly string[]): Promise<{ ms: number; shifts: number }> {
  naivePanel.innerHTML = ''
  const t0 = performance.now()
  const imgs = urls.map(() => {
    const img = document.createElement('img')
    img.alt = ''
    naivePanel.appendChild(img)
    return img
  })
  const monitor = observeShifts(naivePanel)
  for (let i = 0; i < urls.length; i++) imgs[i]!.src = urls[i]!
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve()
          else {
            img.onload = () => resolve()
            img.onerror = () => resolve()
          }
        }),
    ),
  )
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts() }
}

type Mode = 'batch' | 'progressive'

type BatchResult = {
  mode: 'batch'
  ms: number
  prepareMs: number
  shifts: number
  totalHeight: number
}

type ProgressiveResult = {
  mode: 'progressive'
  ms: number
  firstPlacedMs: number
  lastPlacedMs: number
  totalHeight: number
}

function getMode(): Mode {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')
  return (checked?.value === 'batch' ? 'batch' : 'progressive')
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

const NAIVE_LABELS = ['loaded at', 'visible shifts']
const BATCH_LABELS = ['frames placed at', 'fully loaded at', 'column height', 'visible shifts']
const PROGRESSIVE_LABELS = ['first frame at', 'last frame at', 'fully loaded at', 'column height']

function renderPlaceholderStats(mode: Mode): void {
  naiveStat.innerHTML = NAIVE_LABELS.map((l) => metric(l, '—')).join('')
  const labels = mode === 'batch' ? BATCH_LABELS : PROGRESSIVE_LABELS
  measuredStat.innerHTML = labels.map((l) => metric(l, '—')).join('')
}

async function renderMeasuredBatch(urls: readonly string[]): Promise<BatchResult> {
  measuredPanel.innerHTML = ''
  const t0 = performance.now()
  // extractDominantColor populates measurement.dominantColor once the
  // stream drains; paintDominantColorBehind waits on it and paints
  // the tile background.
  const prepared = await Promise.all(
    urls.map((u) => prepare(u, { extractDominantColor: true })),
  )
  const prepareMs = performance.now() - t0

  // Layout entirely from the measured aspect ratios. No library
  // involvement beyond prepare()/getMeasurement().
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const panelWidth = measuredPanel.getBoundingClientRect().width
  const { placements, totalHeight } = layoutMasonry(aspects, panelWidth, COLUMNS, GAP)
  measuredPanel.style.height = `${totalHeight}px`

  const imgs: HTMLImageElement[] = []
  const items: HTMLElement[] = []
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!
    const item = document.createElement('div')
    item.className = 'item framed'
    item.style.left = `${p.x}px`
    item.style.top = `${p.y}px`
    item.style.width = `${p.width}px`
    item.style.height = `${p.height}px`
    const img = document.createElement('img')
    item.appendChild(img)
    measuredPanel.appendChild(item)
    imgs.push(img)
    items.push(item)
    // Dominant color arrives asynchronously and paints the tile's
    // background so the placeholder is the photo's actual palette,
    // not the page's default surface tone.
    void paintDominantColorBehind(prepared[i]!, item)
  }

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    imgs.map((img, i) => {
      const cachedUrl = getMeasurement(prepared[i]!).blobUrl ?? urls[i]!
      return new Promise<void>((resolve) => {
        const done = (): void => {
          img.classList.add('loaded')
          resolve()
        }
        if (img.complete && img.naturalWidth > 0) done()
        else {
          img.onload = done
          img.onerror = done
        }
        img.src = cachedUrl
      })
    }),
  )
  monitor.stop()
  return {
    mode: 'batch',
    ms: performance.now() - t0,
    prepareMs,
    shifts: monitor.shifts(),
    totalHeight,
  }
}

// Progressive: each frame is placed the instant its own prepare()
// resolves, using whichever column is currently shortest. Nothing
// waits for the slowest image. Existing frames never move once
// placed, so the layout is still stable frame-by-frame — it just
// grows as bytes arrive.
async function renderMeasuredProgressive(urls: readonly string[]): Promise<ProgressiveResult> {
  measuredPanel.innerHTML = ''
  measuredPanel.style.height = '0px'
  const t0 = performance.now()
  const panelWidth = measuredPanel.getBoundingClientRect().width
  const colWidth = (panelWidth - GAP * (COLUMNS - 1)) / COLUMNS
  const heights = new Array<number>(COLUMNS).fill(0)
  let firstPlacedMs = 0
  let lastPlacedMs = 0
  const prepares = urls.map((u) => prepare(u, { extractDominantColor: true }))

  await Promise.all(
    urls.map((url, idx) =>
      prepares[idx]!.then((p) => {
        const now = performance.now() - t0
        if (firstPlacedMs === 0) firstPlacedMs = now
        lastPlacedMs = now

        const aspect = getMeasurement(p).aspectRatio
        let shortest = 0
        for (let c = 1; c < COLUMNS; c++) {
          if (heights[c]! < heights[shortest]!) shortest = c
        }
        const x = shortest * (colWidth + GAP)
        const y = heights[shortest]!
        const h = colWidth / aspect
        heights[shortest] = y + h + GAP
        measuredPanel.style.height = `${Math.max(...heights)}px`

        const item = document.createElement('div')
        item.className = 'item framed'
        item.style.left = `${x}px`
        item.style.top = `${y}px`
        item.style.width = `${colWidth}px`
        item.style.height = `${h}px`
        const img = document.createElement('img')
        item.appendChild(img)
        measuredPanel.appendChild(item)
        void paintDominantColorBehind(p, item)

        const cachedUrl = getMeasurement(p).blobUrl ?? url
        return new Promise<void>((resolve) => {
          const done = (): void => {
            img.classList.add('loaded')
            resolve()
          }
          if (img.complete && img.naturalWidth > 0) done()
          else {
            img.onload = done
            img.onerror = done
          }
          img.src = cachedUrl
        })
      }),
    ),
  )

  return {
    mode: 'progressive',
    ms: performance.now() - t0,
    firstPlacedMs,
    lastPlacedMs,
    totalHeight: Math.max(...heights),
  }
}

function renderMeasured(
  urls: readonly string[],
  mode: Mode,
): Promise<BatchResult | ProgressiveResult> {
  return mode === 'batch' ? renderMeasuredBatch(urls) : renderMeasuredProgressive(urls)
}

const measuredSubEl = document.getElementById('measuredSub')!

function setMeasuredSub(mode: Mode): void {
  measuredSubEl.textContent =
    mode === 'batch'
      ? 'all dimensions probed in parallel · layout committed before paint'
      : 'each frame placed the moment its dimensions arrive · layout grows as bytes stream in'
}

const naivePanelEl = naivePanel.closest('.panel') as HTMLElement
const measuredPanelEl = measuredPanel.closest('.panel') as HTMLElement

async function run(): Promise<void> {
  const mode = getMode()
  setMeasuredSub(mode)
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  naivePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  renderPlaceholderStats(mode)
  metaEl.textContent = ''
  setPanelStatus(naivePanelEl, 'queued')
  setPanelStatus(measuredPanelEl, 'queued')

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  runButton.textContent = useLive
    ? `Loading ${COUNT} photos from picsum…`
    : `Generating ${COUNT} canvas fallbacks…`

  metaEl.textContent =
    `${COUNT} photos · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')

  // Sequential: each panel gets the full connection budget while it's
  // the one running, so timings aren't polluted by pool contention.
  // Each panel resolves its own URLs (with its own panel=X suffix)
  // so the second one isn't a cache hit against the first.
  setPanelStatus(naivePanelEl, 'running')
  runButton.textContent = 'Panel 1 (naive)…'
  const naiveUrls = (await resolvePhotosForPanel(useLive, cacheBust, 'naive')).map((r) => r.url)
  const naive = await renderNaive(naiveUrls)
  naiveStat.innerHTML = [
    metric('loaded at', `${naive.ms.toFixed(0)}ms`),
    metric('visible shifts', String(naive.shifts), naive.shifts > 0),
  ].join('')
  setPanelStatus(naivePanelEl, 'done')

  setPanelStatus(measuredPanelEl, 'running')
  runButton.textContent = 'Panel 2 (measured)…'
  const measuredUrls = (
    await resolvePhotosForPanel(useLive, cacheBust, 'measured')
  ).map((r) => r.url)
  const measured = await renderMeasured(measuredUrls, mode)
  if (measured.mode === 'batch') {
    measuredStat.innerHTML = [
      metric('frames placed at', `${measured.prepareMs.toFixed(0)}ms`),
      metric('fully loaded at', `${measured.ms.toFixed(0)}ms`),
      metric('column height', `${Math.round(measured.totalHeight)}px`),
      metric('visible shifts', String(measured.shifts), measured.shifts > 0),
    ].join('')
  } else {
    measuredStat.innerHTML = [
      metric('first frame at', `${measured.firstPlacedMs.toFixed(0)}ms`),
      metric('last frame at', `${measured.lastPlacedMs.toFixed(0)}ms`),
      metric('fully loaded at', `${measured.ms.toFixed(0)}ms`),
      metric('column height', `${Math.round(measured.totalHeight)}px`),
    ].join('')
  }
  setPanelStatus(measuredPanelEl, 'done')

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})

// Update the right-panel subtitle + placeholder-stat shape
// immediately on mode toggle so the user sees what the next Run will
// produce, without re-fetching 60 photos.
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  input.addEventListener('change', () => {
    const mode = getMode()
    setMeasuredSub(mode)
    renderPlaceholderStats(mode)
  })
}

renderPlaceholderStats(getMode())
setMeasuredSub(getMode())
void run()
