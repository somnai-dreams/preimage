import { DecodePool, prepare, getMeasurement } from '../../src/index.js'
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
const naiveCanvasWrap = naiveCanvas.parentElement!
const pooledCanvasWrap = pooledCanvas.parentElement!

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
    const blob = await generateFallbackBlob(PHOTOS[i]!, (i * 29 + panelTag.length) % 360)
    out.push({ url: URL.createObjectURL(blob) })
  }
  return out
}

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

function updateFrameTag(tag: HTMLElement, ms: number): void {
  const klass = ms > 16 ? 'jank' : 'smooth'
  tag.textContent = `${ms.toFixed(1)}ms`
  tag.className = `tag ${klass}`
}

type Stats = {
  setupMs: number
  scrubCount: number
  totalScrubMs: number
  slowest: number
}

function newStats(setupMs: number): Stats {
  return { setupMs, scrubCount: 0, totalScrubMs: 0, slowest: 0 }
}

function recordScrub(stats: Stats, dt: number): void {
  stats.scrubCount++
  stats.totalScrubMs += dt
  if (dt > stats.slowest) stats.slowest = dt
}

function renderStats(el: HTMLElement, stats: Stats): void {
  const avg = stats.scrubCount === 0 ? 0 : stats.totalScrubMs / stats.scrubCount
  el.innerHTML = [
    metric('setup', `${stats.setupMs.toFixed(0)}ms`),
    metric(
      'avg scrub frame',
      stats.scrubCount === 0 ? '—' : `${avg.toFixed(1)}ms`,
      avg > 16,
    ),
    metric(
      'slowest scrub',
      stats.scrubCount === 0 ? '—' : `${stats.slowest.toFixed(1)}ms`,
      stats.slowest > 16,
    ),
    metric('scrubs', String(stats.scrubCount)),
  ].join('')
}

// --- Naive path: truly naive. No library. img.src per scrub, decode
//     on every scrub, drawImage. prepare() is only used up front to
//     pull dominant colors (the demo's "color-before-pixels" backdrop)
//     — that's independent of the scrub-time cost measured here.
async function bindNaive(urls: readonly string[]): Promise<void> {
  const t0 = performance.now()

  // Pre-create <img> elements. We DO set src up front (this is
  // unavoidable to have anything scrubbable), but we don't await
  // decode — the naive path's point is that decode happens on scrub.
  const images = urls.map((u) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = u
    return img
  })
  const colorByIndex: Array<string | undefined> = new Array(urls.length)
  // Natural sizes needed for object-fit math. Fetch via prepare(),
  // which is fast (header probe). Dominant color is extracted
  // alongside — it populates colorByIndex on its own schedule,
  // independent of the scrub-time path.
  const naturalSizes = await Promise.all(
    urls.map(async (u, i) => {
      const prepared = await prepare(u, { extractDominantColor: true })
      const m = getMeasurement(prepared)
      void waitForDominantColor(prepared).then((color) => {
        if (color !== null) colorByIndex[i] = color
      })
      return { w: m.displayWidth, h: m.displayHeight }
    }),
  )

  const setupMs = performance.now() - t0
  const ctx = naiveCanvas.getContext('2d')!
  const stats = newStats(setupMs)
  renderStats(naiveStat, stats)

  const draw = async (i: number): Promise<void> => {
    const t = performance.now()
    // Paint the dominant color immediately so the viewer sees the
    // "color before pixels" flash that's the headline of this feature.
    const color = colorByIndex[i]
    if (color !== undefined) naiveCanvasWrap.style.backgroundColor = color

    const img = images[i]!
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
        // Safari rejects decode on some sources — fall through to draw.
      }
    }
    const { w, h } = sizeCanvas(naiveCanvas)
    const size = naturalSizes[i]!
    drawContain(ctx, img, size.w, size.h, w, h)
    const dt = performance.now() - t
    recordScrub(stats, dt)
    updateFrameTag(naiveTimeTag, dt)
    naiveFrameTag.textContent = `frame ${i + 1}`
    renderStats(naiveStat, stats)
  }

  naiveSlider.max = String(FRAME_COUNT - 1)
  naiveSlider.addEventListener('input', () => {
    const i = Number(naiveSlider.value)
    naiveFrameLabel.textContent = `${i + 1} / ${FRAME_COUNT}`
    void draw(i)
  })
  // Initial render. Doesn't count as a scrub — the measured cost is
  // the first decode, which naive paths always pay on page load.
  await draw(0)
  stats.scrubCount = 0
  stats.totalScrubMs = 0
  stats.slowest = 0
  renderStats(naiveStat, stats)
}

// --- Pool path: DecodePool warms every frame up front. Each scrub
//     is a single blit from a cached ImageBitmap.
async function bindPool(urls: readonly string[]): Promise<void> {
  const t0 = performance.now()
  const pool = new DecodePool({
    concurrency: 4,
    maxCacheEntries: FRAME_COUNT,
  })
  const colorByIndex: Array<string | undefined> = new Array(urls.length)
  const naturalSizes = await Promise.all(
    urls.map(async (u, i) => {
      // Extract dominant color alongside the pool warm-up.
      const prepared = await prepare(u, { extractDominantColor: true })
      void waitForDominantColor(prepared).then((color) => {
        if (color !== null) colorByIndex[i] = color
      })
      const bitmap = await pool.get(u)
      return { w: bitmap.width, h: bitmap.height }
    }),
  )
  const setupMs = performance.now() - t0
  const ctx = pooledCanvas.getContext('2d')!
  const stats = newStats(setupMs)
  renderStats(pooledStat, stats)

  const draw = async (i: number): Promise<void> => {
    const t = performance.now()
    const color = colorByIndex[i]
    if (color !== undefined) pooledCanvasWrap.style.backgroundColor = color
    const bitmap = await pool.get(urls[i]!)
    const { w, h } = sizeCanvas(pooledCanvas)
    const size = naturalSizes[i]!
    drawContain(ctx, bitmap, size.w, size.h, w, h)
    const dt = performance.now() - t
    recordScrub(stats, dt)
    updateFrameTag(pooledTimeTag, dt)
    pooledFrameTag.textContent = `frame ${i + 1}`
    renderStats(pooledStat, stats)
  }

  pooledSlider.max = String(FRAME_COUNT - 1)
  pooledSlider.addEventListener('input', () => {
    const i = Number(pooledSlider.value)
    pooledFrameLabel.textContent = `${i + 1} / ${FRAME_COUNT}`
    void draw(i)
  })
  await draw(0)
  stats.scrubCount = 0
  stats.totalScrubMs = 0
  stats.slowest = 0
  renderStats(pooledStat, stats)
}

function resetStats(): void {
  for (const el of [naiveStat, pooledStat]) {
    el.innerHTML = [
      metric('setup', '—'),
      metric('avg scrub frame', '—'),
      metric('slowest scrub', '—'),
      metric('scrubs', '—'),
    ].join('')
  }
  naiveTimeTag.textContent = '—'
  naiveTimeTag.className = 'tag'
  pooledTimeTag.textContent = '—'
  pooledTimeTag.className = 'tag'
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  resetStats()
  metaEl.textContent = ''
  naiveSlider.value = '0'
  pooledSlider.value = '0'
  naiveCanvasWrap.style.backgroundColor = ''
  pooledCanvasWrap.style.backgroundColor = ''

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  runButton.textContent = useLive
    ? `Loading ${FRAME_COUNT} frames from picsum…`
    : `Generating ${FRAME_COUNT} canvas fallbacks…`

  const [naiveResolved, pooledResolved] = await Promise.all([
    resolvePhotosForPanel(useLive, cacheBust, 'naive'),
    resolvePhotosForPanel(useLive, cacheBust, 'pool'),
  ])

  metaEl.textContent =
    `${FRAME_COUNT} frames · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')

  runButton.textContent = 'Warming…'

  // Each panel runs its own independent setup + bind. No shared state,
  // no shared promises — each owns its own clock.
  await Promise.all([
    bindNaive(naiveResolved.map((r) => r.url)),
    bindPool(pooledResolved.map((r) => r.url)),
  ])

  runButton.textContent = 'Reload with new frames'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})

void run()
