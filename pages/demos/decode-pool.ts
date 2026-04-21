import { DecodePool, prepare, getMeasurement } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const naiveStat = document.getElementById('naiveStat')!
const pooledStat = document.getElementById('pooledStat')!

const naiveCanvas = document.getElementById('naiveCanvas') as HTMLCanvasElement
const pooledCanvas = document.getElementById('pooledCanvas') as HTMLCanvasElement
const naiveSlider = document.getElementById('naiveSlider') as HTMLInputElement
const pooledSlider = document.getElementById('pooledSlider') as HTMLInputElement
const naiveFrameLabel = document.getElementById('naiveFrameLabel')!
const pooledFrameLabel = document.getElementById('pooledFrameLabel')!
const naiveFrameTag = document.getElementById('naiveFrameTag')!
const pooledFrameTag = document.getElementById('pooledFrameTag')!
const naiveTimeTag = document.getElementById('naiveTimeTag')!
const pooledTimeTag = document.getElementById('pooledTimeTag')!

const FRAME_COUNT = 16

const PHOTOS: PhotoDescriptor[] = Array.from({ length: FRAME_COUNT }, (_, i) => ({
  seed: `preimage-pool-${i}`,
  width: 1600,
  height: 900,
  caption: `frame ${i + 1}`,
}))

function metric(label: string, value: string, highlight = false): string {
  return `<span class="metric">${label} <b${highlight ? ' style="color:var(--reflow)"' : ''}>${value}</b></span>`
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

const NAIVE_LABELS = ['setup', 'avg scrub frame', 'slowest frame']
const POOL_LABELS = ['decode pool warm', 'avg scrub frame', 'slowest frame']

function renderPlaceholderStats(): void {
  naiveStat.innerHTML = NAIVE_LABELS.map((l) => metric(l, '—')).join('')
  pooledStat.innerHTML = POOL_LABELS.map((l) => metric(l, '—')).join('')
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
    const blob = await generateFallbackBlob(PHOTOS[i]!, (i * 29) % 360)
    results.push({ url: URL.createObjectURL(blob), origin: 'fallback' })
  }
  return results
}

// Size each canvas to its CSS box, DPR-aware, so drawImage doesn't
// blur when the container is wider than the natural frame.
function sizeCanvas(canvas: HTMLCanvasElement): { w: number; h: number } {
  const dpr = window.devicePixelRatio ?? 1
  const rect = canvas.getBoundingClientRect()
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  return { w, h }
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): void {
  ctx.clearRect(0, 0, dstW, dstH)
  const scale = Math.min(dstW / srcW, dstH / srcH)
  const w = srcW * scale
  const h = srcH * scale
  const x = (dstW - w) / 2
  const y = (dstH - h) / 2
  ctx.drawImage(source, x, y, w, h)
}

function classifyFrameTime(ms: number): 'smooth' | 'jank' {
  return ms > 16 ? 'jank' : 'smooth'
}

function updateFrameTag(tag: HTMLElement, ms: number): void {
  const rounded = ms.toFixed(1)
  const klass = classifyFrameTime(ms)
  tag.textContent = `${rounded}ms`
  tag.className = `tag ${klass}`
}

type NaiveSetup = {
  images: HTMLImageElement[]
  naturalSizes: Array<{ w: number; h: number }>
  setupMs: number
}

async function setupNaive(urls: readonly string[]): Promise<NaiveSetup> {
  // The naive path doesn't pre-decode. It merely creates <img> elements
  // bound to each URL so we can assign them to canvas later. The decode
  // cost is deferred to each scrub tick.
  const t0 = performance.now()
  const images: HTMLImageElement[] = []
  const naturalSizes: Array<{ w: number; h: number }> = []
  for (let i = 0; i < urls.length; i++) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = urls[i]!
    images.push(img)
    // We still want a size for drawContain; prepare() gets us that
    // without forcing a decode here.
    const prepared = await prepare(urls[i]!)
    const m = getMeasurement(prepared)
    naturalSizes.push({ w: m.displayWidth, h: m.displayHeight })
  }
  return { images, naturalSizes, setupMs: performance.now() - t0 }
}

type PoolSetup = {
  pool: DecodePool
  naturalSizes: Array<{ w: number; h: number }>
  setupMs: number
}

async function setupPool(urls: readonly string[]): Promise<PoolSetup> {
  const t0 = performance.now()
  const pool = new DecodePool({
    concurrency: 4,
    maxCacheEntries: FRAME_COUNT,
    imageBitmapOptions: { premultiplyAlpha: 'default' },
  })
  // Warm every frame up front. In a real app you'd warm a window
  // around the playhead; doing them all here keeps the demo simple.
  const naturalSizes: Array<{ w: number; h: number }> = []
  await Promise.all(
    urls.map(async (u, i) => {
      const bitmap = await pool.get(u)
      naturalSizes[i] = { w: bitmap.width, h: bitmap.height }
    }),
  )
  return { pool, naturalSizes, setupMs: performance.now() - t0 }
}

type ScrubStats = {
  totalScrubs: number
  totalMs: number
  slowest: number
}

function newStats(): ScrubStats {
  return { totalScrubs: 0, totalMs: 0, slowest: 0 }
}

function updateStatCells(el: HTMLElement, labels: string[], stats: ScrubStats, setupMs: number): void {
  const avg = stats.totalScrubs === 0 ? 0 : stats.totalMs / stats.totalScrubs
  el.innerHTML = [
    metric(labels[0]!, `${setupMs.toFixed(0)}ms`),
    metric(
      labels[1]!,
      stats.totalScrubs === 0 ? '—' : `${avg.toFixed(1)}ms`,
      avg > 16,
    ),
    metric(
      labels[2]!,
      stats.totalScrubs === 0 ? '—' : `${stats.slowest.toFixed(1)}ms`,
      stats.slowest > 16,
    ),
  ].join('')
}

async function bindNaive(urls: readonly string[]): Promise<void> {
  const setup = await setupNaive(urls)
  const ctx = naiveCanvas.getContext('2d')!
  let { w, h } = sizeCanvas(naiveCanvas)
  const stats = newStats()

  const draw = async (i: number): Promise<void> => {
    const t0 = performance.now()
    const img = setup.images[i]!
    // Force the decode to complete before we draw so the measurement
    // captures the true cost of "scrub = decode + blit".
    if (!img.complete || img.naturalWidth === 0) {
      await new Promise<void>((res, rej) => {
        img.addEventListener('load', () => res(), { once: true })
        img.addEventListener('error', () => rej(new Error('img load failed')), { once: true })
      })
    }
    if (typeof img.decode === 'function') {
      try {
        await img.decode()
      } catch {
        // Safari rejects decode on some sources; fall through to draw.
      }
    }
    ;({ w, h } = sizeCanvas(naiveCanvas))
    const size = setup.naturalSizes[i]!
    drawContain(ctx, img, size.w, size.h, w, h)
    const dt = performance.now() - t0
    stats.totalScrubs++
    stats.totalMs += dt
    if (dt > stats.slowest) stats.slowest = dt
    updateFrameTag(naiveTimeTag, dt)
    naiveFrameTag.textContent = `frame ${i + 1}`
    updateStatCells(naiveStat, NAIVE_LABELS, stats, setup.setupMs)
  }

  naiveSlider.max = String(FRAME_COUNT - 1)
  naiveSlider.addEventListener('input', () => {
    const i = Number(naiveSlider.value)
    naiveFrameLabel.textContent = `${i + 1} / ${FRAME_COUNT}`
    void draw(i)
  })
  await draw(0)
  updateStatCells(naiveStat, NAIVE_LABELS, stats, setup.setupMs)
}

async function bindPool(urls: readonly string[]): Promise<void> {
  const setup = await setupPool(urls)
  const ctx = pooledCanvas.getContext('2d')!
  let { w, h } = sizeCanvas(pooledCanvas)
  const stats = newStats()

  const draw = async (i: number): Promise<void> => {
    const t0 = performance.now()
    const bitmap = await setup.pool.get(urls[i]!)
    ;({ w, h } = sizeCanvas(pooledCanvas))
    const size = setup.naturalSizes[i]!
    drawContain(ctx, bitmap, size.w, size.h, w, h)
    const dt = performance.now() - t0
    stats.totalScrubs++
    stats.totalMs += dt
    if (dt > stats.slowest) stats.slowest = dt
    updateFrameTag(pooledTimeTag, dt)
    pooledFrameTag.textContent = `frame ${i + 1}`
    updateStatCells(pooledStat, POOL_LABELS, stats, setup.setupMs)
  }

  pooledSlider.max = String(FRAME_COUNT - 1)
  pooledSlider.addEventListener('input', () => {
    const i = Number(pooledSlider.value)
    pooledFrameLabel.textContent = `${i + 1} / ${FRAME_COUNT}`
    void draw(i)
  })
  await draw(0)
  updateStatCells(pooledStat, POOL_LABELS, stats, setup.setupMs)
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  renderPlaceholderStats()
  metaEl.textContent = ''
  naiveSlider.value = '0'
  pooledSlider.value = '0'

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  runButton.textContent = useLive
    ? `Loading ${FRAME_COUNT} frames from picsum…`
    : `Generating ${FRAME_COUNT} canvas fallbacks…`
  const resolved = await resolvePhotos(useLive, cacheBust)
  const urls = resolved.map((r) => r.url)

  metaEl.textContent =
    `${FRAME_COUNT} frames · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')

  runButton.textContent = 'Warming…'

  // Split URLs per panel so the browser's same-URL dedupe doesn't
  // merge the naive panel's img fetches with the pool's fetches.
  // blob:/data: URLs are opaque handles — appending a query string
  // breaks them, so leave those untouched (offline fallback path).
  const panelSuffix = (u: string, panel: string): string => {
    if (u.startsWith('blob:') || u.startsWith('data:')) return u
    return u.includes('?') ? `${u}&panel=${panel}` : `${u}?panel=${panel}`
  }
  const naiveUrls = urls.map((u) => panelSuffix(u, 'naive'))
  const pooledUrls = urls.map((u) => panelSuffix(u, 'pool'))

  await Promise.all([bindNaive(naiveUrls), bindPool(pooledUrls)])

  runButton.textContent = 'Reload with new frames'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})

renderPlaceholderStats()
void run()
