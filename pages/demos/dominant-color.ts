import { prepare, getMeasurement, type PreparedImage } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'
import { waitForDominantColor } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const plainPanel = document.getElementById('plain')!
const coloredPanel = document.getElementById('colored')!
const plainStat = document.getElementById('plainStat')!
const coloredStat = document.getElementById('coloredStat')!

const COUNT = 16

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
    // Each panel gets its own URL suffix so the browser doesn't
    // dedupe the two panels' fetches into one.
    return PHOTOS.map((p) => {
      const base = picsumUrl(p, cacheBust)
      const sep = base.includes('?') ? '&' : '?'
      return { url: `${base}${sep}panel=${panelTag}` }
    })
  }
  // Offline: each panel gets its own canvas-fallback blob URL. They're
  // independent memory objects so there's no shared-fetch concern.
  const out: ResolvedPhoto[] = []
  for (let i = 0; i < PHOTOS.length; i++) {
    const blob = await generateFallbackBlob(PHOTOS[i]!, (i * 43 + panelTag.length) % 360)
    out.push({ url: URL.createObjectURL(blob) })
  }
  return out
}

function createTile(): { container: HTMLElement; fill: HTMLElement; img: HTMLImageElement } {
  const container = document.createElement('div')
  container.className = 'tile no-color'
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
  firstTileAt: number
  lastTileAt: number
  allImagesLoadedAt: number
}

// Plain path: plain prepare(), no color. Each tile is rendered the
// moment its own prepare() resolves; img loads and fully-loaded time
// is tracked independently from tile placement.
async function runPlain(urls: readonly string[]): Promise<PlainStats> {
  plainPanel.innerHTML = ''
  const t0 = performance.now()
  const tiles = urls.map(() => {
    const t = createTile()
    plainPanel.appendChild(t.container)
    return t
  })

  let firstTileAt = 0
  let lastTileAt = 0
  let placedCount = 0

  const imgLoads: Promise<void>[] = []

  const placements = urls.map((url, i) =>
    prepare(url).then((prepared) => {
      const tile = tiles[i]!
      const m = getMeasurement(prepared)
      tile.container.style.aspectRatio = `${m.displayWidth} / ${m.displayHeight}`
      const now = performance.now() - t0
      if (firstTileAt === 0) firstTileAt = now
      lastTileAt = now
      placedCount++
      const src = m.blobUrl ?? url
      const p = imgLoaded(tile.img)
      imgLoads.push(p)
      tile.img.addEventListener('load', () => tile.img.classList.add('loaded'), { once: true })
      tile.img.src = src
    }),
  )

  await Promise.all(placements)
  await Promise.all(imgLoads)
  const allImagesLoadedAt = performance.now() - t0
  return { firstTileAt, lastTileAt, allImagesLoadedAt }
}

type ColoredStats = {
  firstTileAt: number
  firstColorAt: number
  lastColorAt: number
  allImagesLoadedAt: number
}

// Colored path: prepare({ extractDominantColor: true }). Tile placement,
// image loading, and color arrival are each driven by their own events
// — no ordering coupling between them.
async function runColored(urls: readonly string[]): Promise<ColoredStats> {
  coloredPanel.innerHTML = ''
  const t0 = performance.now()
  const tiles = urls.map(() => {
    const t = createTile()
    coloredPanel.appendChild(t.container)
    return t
  })

  let firstTileAt = 0
  let firstColorAt = 0
  let lastColorAt = 0
  let colorsPainted = 0

  const imgLoads: Promise<void>[] = []
  const colorArrivals: Promise<void>[] = []

  const placements = urls.map((url, i) =>
    prepare(url, { extractDominantColor: true }).then((prepared: PreparedImage) => {
      const tile = tiles[i]!
      const m = getMeasurement(prepared)
      tile.container.style.aspectRatio = `${m.displayWidth} / ${m.displayHeight}`
      const now = performance.now() - t0
      if (firstTileAt === 0) firstTileAt = now

      // Image load track (independent of color arrival).
      const src = m.blobUrl ?? url
      imgLoads.push(imgLoaded(tile.img))
      tile.img.addEventListener('load', () => tile.img.classList.add('loaded'), { once: true })
      tile.img.src = src

      // Color track (independent of image load).
      colorArrivals.push(
        waitForDominantColor(prepared).then((color) => {
          if (color === null) return
          tile.fill.style.backgroundColor = color
          tile.container.classList.remove('no-color')
          const tc = performance.now() - t0
          if (firstColorAt === 0) firstColorAt = tc
          colorsPainted++
          if (colorsPainted === urls.length) lastColorAt = tc
        }),
      )
    }),
  )

  await Promise.all(placements)
  await Promise.all(imgLoads)
  const allImagesLoadedAt = performance.now() - t0
  await Promise.all(colorArrivals)
  return { firstTileAt, firstColorAt, lastColorAt, allImagesLoadedAt }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  // Stat placeholders are baked into the HTML. Reset to the same
  // placeholder shape between runs so real values drop in without a
  // reflow.
  setStat(plainStat, [
    ['first tile placed at', '—'],
    ['last tile placed at', '—'],
    ['images fully loaded at', '—'],
  ])
  setStat(coloredStat, [
    ['first tile placed at', '—'],
    ['first color painted at', '—'],
    ['all colors painted at', '—'],
    ['images fully loaded at', '—'],
  ])
  plainPanel.innerHTML = ''
  coloredPanel.innerHTML = ''
  metaEl.textContent = ''

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  runButton.textContent = useLive
    ? `Loading ${COUNT} photos from picsum…`
    : `Generating ${COUNT} canvas fallbacks…`

  // Each panel resolves its own URLs — no sharing, no coordination.
  const [plainResolved, coloredResolved] = await Promise.all([
    resolvePhotosForPanel(useLive, cacheBust, 'plain'),
    resolvePhotosForPanel(useLive, cacheBust, 'colored'),
  ])
  const plainUrls = plainResolved.map((r) => r.url)
  const coloredUrls = coloredResolved.map((r) => r.url)

  metaEl.textContent =
    `${COUNT} photos · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')

  runButton.textContent = 'Running…'

  // Two truly independent paths. Each returns its own stats shape
  // measured from its own t0. The Promise.all at the top level is
  // only so the UI unblocks once both finish; neither path depends
  // on the other.
  const plainTask = runPlain(plainUrls).then((stats) => {
    setStat(plainStat, [
      ['first tile placed at', `${stats.firstTileAt.toFixed(0)}ms`],
      ['last tile placed at', `${stats.lastTileAt.toFixed(0)}ms`],
      ['images fully loaded at', `${stats.allImagesLoadedAt.toFixed(0)}ms`],
    ])
  })
  const coloredTask = runColored(coloredUrls).then((stats) => {
    setStat(coloredStat, [
      ['first tile placed at', `${stats.firstTileAt.toFixed(0)}ms`],
      ['first color painted at', `${stats.firstColorAt.toFixed(0)}ms`],
      ['all colors painted at', `${stats.lastColorAt.toFixed(0)}ms`],
      ['images fully loaded at', `${stats.allImagesLoadedAt.toFixed(0)}ms`],
    ])
  })

  await Promise.all([plainTask, coloredTask])

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})

void run()
