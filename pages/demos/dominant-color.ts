import { prepare, getMeasurement, type PreparedImage } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'
import { setPanelStatus, waitForDominantColor } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const plainPanel = document.getElementById('plain')!
const coloredPanel = document.getElementById('colored')!
const plainPanelEl = plainPanel.closest('.panel') as HTMLElement
const coloredPanelEl = coloredPanel.closest('.panel') as HTMLElement
const plainStat = document.getElementById('plainStat')!
const coloredStat = document.getElementById('coloredStat')!

const COUNT = 16
const COLUMNS = 4
const GAP = 10

const ASPECTS: Array<[number, number, string]> = [
  [1600, 1067, 'preimage-dominant-warm-1'],
  [1200, 1600, 'preimage-dominant-cool-1'],
  [1400, 1400, 'preimage-dominant-square-1'],
  [1600, 900, 'preimage-dominant-wide-1'],
  [1000, 1400, 'preimage-dominant-portrait-1'],
  [1500, 1000, 'preimage-dominant-land-1'],
  [1400, 1400, 'preimage-dominant-square-2'],
  [1600, 1067, 'preimage-dominant-warm-2'],
  [1200, 1600, 'preimage-dominant-cool-2'],
  [1500, 1000, 'preimage-dominant-land-2'],
  [1000, 1400, 'preimage-dominant-portrait-2'],
  [1600, 900, 'preimage-dominant-wide-2'],
  [1400, 1400, 'preimage-dominant-square-3'],
  [1200, 1600, 'preimage-dominant-cool-3'],
  [1600, 1067, 'preimage-dominant-warm-3'],
  [1500, 1000, 'preimage-dominant-land-3'],
]

const PHOTOS: PhotoDescriptor[] = ASPECTS.map(([w, h, seed], i) => ({
  seed,
  width: w,
  height: h,
  caption: `tile ${i + 1}`,
}))

function metric(label: string, value: string): string {
  return `<span class="metric">${label} <b>${value}</b></span>`
}

function setStat(el: HTMLElement, pairs: ReadonlyArray<[string, string]>): void {
  el.innerHTML = pairs.map(([l, v]) => metric(l, v)).join('')
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

type ResolvedPhoto = { url: string }

async function resolvePhotosForPanel(
  useLive: boolean,
  cacheBust: string | null,
  panelTag: string,
): Promise<ResolvedPhoto[]> {
  if (useLive) {
    return PHOTOS.map((p) => {
      const base = picsumUrl(p, cacheBust)
      const sep = base.includes('?') ? '&' : '?'
      return { url: `${base}${sep}panel=${panelTag}` }
    })
  }
  const out: ResolvedPhoto[] = []
  for (let i = 0; i < PHOTOS.length; i++) {
    const blob = await generateFallbackBlob(PHOTOS[i]!, (i * 43 + panelTag.length) % 360)
    out.push({ url: URL.createObjectURL(blob) })
  }
  return out
}

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

type Tile = { container: HTMLElement; fill: HTMLElement; img: HTMLImageElement }

function createTile(place: Placement, withNoColor: boolean): Tile {
  const container = document.createElement('div')
  container.className = withNoColor ? 'tile no-color' : 'tile'
  container.style.left = `${place.x}px`
  container.style.top = `${place.y}px`
  container.style.width = `${place.width}px`
  container.style.height = `${place.height}px`
  const fill = document.createElement('div')
  fill.className = 'fill'
  const img = document.createElement('img')
  img.alt = ''
  container.appendChild(fill)
  container.appendChild(img)
  return { container, fill, img }
}

function imgLoaded(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true })
    img.addEventListener('error', () => resolve(), { once: true })
  })
}

type PlainStats = {
  measuredMs: number
  laidOutMs: number
  imagesLoadedMs: number
}

async function runPlain(urls: readonly string[]): Promise<PlainStats> {
  // Panel timer starts only when this panel actually begins its work.
  const t0 = performance.now()
  plainPanel.innerHTML = ''
  plainPanel.style.height = '0px'

  // 1. Measure every image up front. This is the library's contract:
  //    dimensions known before layout runs, no thrashing while each
  //    one's aspect ratio arrives.
  const prepared = await Promise.all(urls.map((u) => prepare(u)))
  const measuredMs = performance.now() - t0

  // 2. Lay out the shortest-column grid from the measured aspects
  //    and commit the panel height + every tile's (x, y, w, h) in
  //    one synchronous pass.
  const panelWidth = plainPanel.getBoundingClientRect().width
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const { placements, totalHeight } = layoutShortestColumn(aspects, panelWidth)
  plainPanel.style.height = `${totalHeight}px`

  const frag = document.createDocumentFragment()
  const tiles = prepared.map((_, i) => {
    const tile = createTile(placements[i]!, false)
    frag.appendChild(tile.container)
    return tile
  })
  plainPanel.appendChild(frag)
  const laidOutMs = performance.now() - t0

  // 3. Kick off image loads; fully-loaded time measured independently.
  const imgLoads = tiles.map((tile, i) => {
    const src = getMeasurement(prepared[i]!).blobUrl ?? urls[i]!
    const p = imgLoaded(tile.img)
    tile.img.addEventListener('load', () => tile.img.classList.add('loaded'), { once: true })
    tile.img.src = src
    return p
  })
  await Promise.all(imgLoads)
  const imagesLoadedMs = performance.now() - t0
  return { measuredMs, laidOutMs, imagesLoadedMs }
}

type ColoredStats = {
  measuredMs: number
  laidOutMs: number
  firstColorMs: number
  allColorsMs: number
  imagesLoadedMs: number
}

async function runColored(urls: readonly string[]): Promise<ColoredStats> {
  const t0 = performance.now()
  coloredPanel.innerHTML = ''
  coloredPanel.style.height = '0px'

  const prepared = await Promise.all(
    urls.map((u) => prepare(u, { extractDominantColor: true })),
  )
  const measuredMs = performance.now() - t0

  const panelWidth = coloredPanel.getBoundingClientRect().width
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const { placements, totalHeight } = layoutShortestColumn(aspects, panelWidth)
  coloredPanel.style.height = `${totalHeight}px`

  const frag = document.createDocumentFragment()
  const tiles = prepared.map((_, i) => {
    const tile = createTile(placements[i]!, true)
    frag.appendChild(tile.container)
    return tile
  })
  coloredPanel.appendChild(frag)
  const laidOutMs = performance.now() - t0

  let firstColorMs = 0
  let allColorsMs = 0
  let colorsPainted = 0
  const colorArrivals = prepared.map((p, i) =>
    waitForDominantColor(p).then((color) => {
      if (color === null) return
      const tile = tiles[i]!
      tile.fill.style.backgroundColor = color
      tile.container.classList.remove('no-color')
      const now = performance.now() - t0
      if (firstColorMs === 0) firstColorMs = now
      colorsPainted++
      if (colorsPainted === prepared.length) allColorsMs = now
    }),
  )

  const imgLoads = tiles.map((tile, i) => {
    const src = getMeasurement(prepared[i]!).blobUrl ?? urls[i]!
    const pr = imgLoaded(tile.img)
    tile.img.addEventListener('load', () => tile.img.classList.add('loaded'), { once: true })
    tile.img.src = src
    return pr
  })
  await Promise.all(imgLoads)
  const imagesLoadedMs = performance.now() - t0
  await Promise.all(colorArrivals)
  return { measuredMs, laidOutMs, firstColorMs, allColorsMs, imagesLoadedMs }
}

function resetStats(): void {
  setStat(plainStat, [
    ['dimensions measured', '—'],
    ['grid laid out', '—'],
    ['images loaded', '—'],
  ])
  setStat(coloredStat, [
    ['dimensions measured', '—'],
    ['grid laid out', '—'],
    ['first color', '—'],
    ['all colors', '—'],
    ['images loaded', '—'],
  ])
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  resetStats()
  plainPanel.innerHTML = ''
  coloredPanel.innerHTML = ''
  plainPanel.style.height = '0px'
  coloredPanel.style.height = '0px'
  metaEl.textContent = ''

  // Sequential: plain first, then colored. Each gets the full
  // connection-pool budget while it's running, so the timings
  // aren't polluted by contention with the other panel.
  setPanelStatus(plainPanelEl, 'running', 'running')
  setPanelStatus(coloredPanelEl, 'queued', 'queued')

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  runButton.textContent = useLive
    ? `Loading ${COUNT} photos from picsum…`
    : `Generating ${COUNT} canvas fallbacks…`

  const plainResolved = await resolvePhotosForPanel(useLive, cacheBust, 'plain')

  metaEl.textContent =
    `${COUNT} photos · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')

  runButton.textContent = 'Panel 1 (plain)…'
  const plainStats = await runPlain(plainResolved.map((r) => r.url))
  setStat(plainStat, [
    ['dimensions measured', `${plainStats.measuredMs.toFixed(0)}ms`],
    ['grid laid out', `${plainStats.laidOutMs.toFixed(0)}ms`],
    ['images loaded', `${plainStats.imagesLoadedMs.toFixed(0)}ms`],
  ])
  setPanelStatus(plainPanelEl, 'done', 'done')

  runButton.textContent = 'Resolving panel 2…'
  setPanelStatus(coloredPanelEl, 'running', 'running')
  const coloredResolved = await resolvePhotosForPanel(useLive, cacheBust, 'colored')

  runButton.textContent = 'Panel 2 (dominant color)…'
  const coloredStats = await runColored(coloredResolved.map((r) => r.url))
  setStat(coloredStat, [
    ['dimensions measured', `${coloredStats.measuredMs.toFixed(0)}ms`],
    ['grid laid out', `${coloredStats.laidOutMs.toFixed(0)}ms`],
    ['first color', `${coloredStats.firstColorMs.toFixed(0)}ms`],
    ['all colors', `${coloredStats.allColorsMs.toFixed(0)}ms`],
    ['images loaded', `${coloredStats.imagesLoadedMs.toFixed(0)}ms`],
  ])
  setPanelStatus(coloredPanelEl, 'done', 'done')

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})

void run()
