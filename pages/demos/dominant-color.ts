import { prepare, getMeasurement } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const plainPanel = document.getElementById('plain')!
const coloredPanel = document.getElementById('colored')!
const plainStat = document.getElementById('plainStat')!
const coloredStat = document.getElementById('coloredStat')!

const COUNT = 16

// Tiles are 4 columns; mix portraits, landscapes, and squares so the
// dominant-color effect is legible (a warm desert vs a blue seascape vs
// a green forest).
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

function metric(label: string, value: string, highlight = false): string {
  return `<span class="metric">${label} <b${highlight ? ' style="color:var(--reflow)"' : ''}>${value}</b></span>`
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

const PLAIN_LABELS = ['tiles rendered at', 'images fully loaded at']
const COLORED_LABELS = [
  'tiles rendered at',
  'first color at',
  'all colors at',
  'images fully loaded at',
]

function renderPlaceholderStats(): void {
  plainStat.innerHTML = PLAIN_LABELS.map((l) => metric(l, '—')).join('')
  coloredStat.innerHTML = COLORED_LABELS.map((l) => metric(l, '—')).join('')
}

type ResolvedPhoto = { url: string; origin: 'picsum' | 'fallback' }

async function resolvePhotos(
  useLive: boolean,
  cacheBust: string | null,
): Promise<ResolvedPhoto[]> {
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

type PlainResult = { ms: number; renderedAtMs: number }
type ColoredResult = {
  ms: number
  renderedAtMs: number
  firstColorMs: number
  allColorsMs: number
}

async function renderPlain(urls: readonly string[]): Promise<PlainResult> {
  plainPanel.innerHTML = ''
  const t0 = performance.now()
  const prepared = await Promise.all(urls.map((u) => prepare(u)))
  const renderedAtMs = performance.now() - t0
  const imgs: HTMLImageElement[] = []
  for (let i = 0; i < prepared.length; i++) {
    const m = getMeasurement(prepared[i]!)
    const tile = createTile()
    tile.container.style.aspectRatio = `${m.displayWidth} / ${m.displayHeight}`
    plainPanel.appendChild(tile.container)
    imgs.push(tile.img)
    const src = m.blobUrl ?? urls[i]!
    tile.img.onload = () => tile.img.classList.add('loaded')
    tile.img.onerror = () => tile.img.classList.add('loaded')
    tile.img.src = src
  }
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve()
          else {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          }
        }),
    ),
  )
  return { ms: performance.now() - t0, renderedAtMs }
}

async function renderColored(urls: readonly string[]): Promise<ColoredResult> {
  coloredPanel.innerHTML = ''
  const t0 = performance.now()
  const prepared = await Promise.all(
    urls.map((u) => prepare(u, { extractDominantColor: true })),
  )
  const renderedAtMs = performance.now() - t0

  type TileEntry = {
    container: HTMLElement
    fill: HTMLElement
    img: HTMLImageElement
    key: string
  }
  const tiles: TileEntry[] = []
  for (let i = 0; i < prepared.length; i++) {
    const m = getMeasurement(prepared[i]!)
    const tile = createTile()
    tile.container.style.aspectRatio = `${m.displayWidth} / ${m.displayHeight}`
    coloredPanel.appendChild(tile.container)
    tiles.push({ container: tile.container, fill: tile.fill, img: tile.img, key: m.src })
    const src = m.blobUrl ?? urls[i]!
    tile.img.onload = () => tile.img.classList.add('loaded')
    tile.img.onerror = () => tile.img.classList.add('loaded')
    tile.img.src = src
  }

  // Poll the measurement cache to land dominant colors as they arrive.
  // The color is populated asynchronously by prepare(); we don't know
  // when it resolves without polling or extra plumbing. A cheap rAF
  // loop watches the cached measurements and paints the color on
  // first appearance.
  let firstColorMs = 0
  let allColorsMs = 0
  let coloredCount = 0
  const painted = new Set<number>()
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      for (let i = 0; i < prepared.length; i++) {
        if (painted.has(i)) continue
        const m = getMeasurement(prepared[i]!)
        if (m.dominantColor !== undefined) {
          const tile = tiles[i]!
          tile.fill.style.backgroundColor = m.dominantColor
          tile.container.classList.remove('no-color')
          painted.add(i)
          const now = performance.now() - t0
          if (firstColorMs === 0) firstColorMs = now
          coloredCount++
          if (coloredCount === prepared.length) allColorsMs = now
        }
      }
      if (painted.size === prepared.length) {
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })

  await Promise.all(
    tiles.map(
      (t) =>
        new Promise<void>((res) => {
          if (t.img.complete && t.img.naturalWidth > 0) res()
          else {
            t.img.addEventListener('load', () => res(), { once: true })
            t.img.addEventListener('error', () => res(), { once: true })
          }
        }),
    ),
  )
  return {
    ms: performance.now() - t0,
    renderedAtMs,
    firstColorMs,
    allColorsMs,
  }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  plainPanel.innerHTML = ''
  coloredPanel.innerHTML = ''
  renderPlaceholderStats()
  metaEl.textContent = ''

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  runButton.textContent = useLive
    ? `Loading ${COUNT} photos from picsum…`
    : `Generating ${COUNT} canvas fallbacks…`
  const resolved = await resolvePhotos(useLive, cacheBust)
  const urls = resolved.map((r) => r.url)

  metaEl.textContent =
    `${COUNT} photos · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')

  runButton.textContent = 'Running…'

  // Split the URL list across the two panels so each panel gets a
  // distinct request, dodging the browser's same-URL dedupe that would
  // otherwise let one panel piggyback on the other's fetch. Only
  // applies to http(s) URLs — blob: URLs are opaque handles and break
  // if we append query strings.
  const panelSuffix = (u: string, panel: string): string => {
    if (u.startsWith('blob:') || u.startsWith('data:')) return u
    return u.includes('?') ? `${u}&panel=${panel}` : `${u}?panel=${panel}`
  }
  const plainUrls = urls.map((u) => panelSuffix(u, 'plain'))
  const coloredUrls = urls.map((u) => panelSuffix(u, 'colored'))

  const [plain, colored] = await Promise.all([
    renderPlain(plainUrls),
    renderColored(coloredUrls),
  ])

  plainStat.innerHTML = [
    metric('tiles rendered at', `${plain.renderedAtMs.toFixed(0)}ms`),
    metric('images fully loaded at', `${plain.ms.toFixed(0)}ms`),
  ].join('')

  coloredStat.innerHTML = [
    metric('tiles rendered at', `${colored.renderedAtMs.toFixed(0)}ms`),
    metric('first color at', `${colored.firstColorMs.toFixed(0)}ms`),
    metric('all colors at', `${colored.allColorsMs.toFixed(0)}ms`),
    metric('images fully loaded at', `${colored.ms.toFixed(0)}ms`),
  ].join('')

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})

renderPlaceholderStats()
void run()
