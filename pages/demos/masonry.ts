import { prepare, getMeasurement } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'
import { observeShifts } from './demo-utils.js'

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

async function resolvePhotos(useLive: boolean, cacheBust: string): Promise<ResolvedPhoto[]> {
  if (useLive) {
    return PHOTOS.map((p) => ({ url: picsumUrl(p, cacheBust), origin: 'picsum' as const }))
  }
  const results: ResolvedPhoto[] = []
  for (let i = 0; i < PHOTOS.length; i++) {
    const blob = await generateFallbackBlob(PHOTOS[i]!, (i * 43) % 360)
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

async function renderMeasured(urls: readonly string[]): Promise<{
  ms: number
  prepareMs: number
  shifts: number
  totalHeight: number
}> {
  measuredPanel.innerHTML = ''
  const t0 = performance.now()
  const prepared = await Promise.all(urls.map((u) => prepare(u)))
  const prepareMs = performance.now() - t0

  // Layout entirely from the measured aspect ratios. No library
  // involvement beyond prepare()/getMeasurement().
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const panelWidth = measuredPanel.getBoundingClientRect().width
  const { placements, totalHeight } = layoutMasonry(aspects, panelWidth, COLUMNS, GAP)
  measuredPanel.style.height = `${totalHeight}px`

  const items: HTMLDivElement[] = []
  const imgs: HTMLImageElement[] = []
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
    items.push(item)
    imgs.push(img)
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
  return { ms: performance.now() - t0, prepareMs, shifts: monitor.shifts(), totalHeight }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  naivePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  naiveStat.innerHTML = ''
  measuredStat.innerHTML = ''
  metaEl.textContent = ''

  const useLive = await picsumReachable()
  const cacheBust = newCacheBustToken()
  runButton.textContent = useLive
    ? `Loading ${COUNT} photos from picsum…`
    : `Generating ${COUNT} canvas fallbacks…`
  const resolved = await resolvePhotos(useLive, cacheBust)
  const urls = resolved.map((r) => r.url)

  metaEl.textContent =
    `${COUNT} photos · ${useLive ? 'picsum.photos (cache-busted — real network)' : 'picsum offline — canvas fallbacks'}`

  runButton.textContent = 'Running…'

  const [naive, measured] = await Promise.all([renderNaive(urls), renderMeasured(urls)])

  naiveStat.innerHTML = [
    metric('loaded at', `${naive.ms.toFixed(0)}ms`),
    metric('visible shifts', String(naive.shifts), naive.shifts > 0),
  ].join('')

  measuredStat.innerHTML = [
    metric('frame placed at', `${measured.prepareMs.toFixed(0)}ms`),
    metric('fully loaded at', `${measured.ms.toFixed(0)}ms`),
    metric('column height', `${Math.round(measured.totalHeight)}px`),
    metric('visible shifts', String(measured.shifts), measured.shifts > 0),
  ].join('')

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
