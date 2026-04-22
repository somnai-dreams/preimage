import { DecodePool, prepare, getMeasurement } from '@somnai-dreams/preimage'
import { newCacheBustToken, photoUrl, takePhotos, type Photo } from './photo-source.js'

const metaEl = document.getElementById('meta')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runPoolBtn = document.getElementById('runPool') as HTMLButtonElement

const naiveCanvas = document.getElementById('naiveCanvas') as HTMLCanvasElement
const poolCanvas = document.getElementById('poolCanvas') as HTMLCanvasElement
const naiveSlider = document.getElementById('naiveSlider') as HTMLInputElement
const poolSlider = document.getElementById('poolSlider') as HTMLInputElement
const naiveFrameLabel = document.getElementById('naiveFrameLabel')!
const poolFrameLabel = document.getElementById('poolFrameLabel')!
const naiveFrameTag = document.getElementById('naiveFrameTag')!
const poolFrameTag = document.getElementById('poolFrameTag')!
const naiveTimeTag = document.getElementById('naiveTimeTag')!
const poolTimeTag = document.getElementById('poolTimeTag')!
const naiveEmpty = document.getElementById('naiveEmpty')!
const poolEmpty = document.getElementById('poolEmpty')!
const naiveStats = document.getElementById('naiveStats')!
const poolStats = document.getElementById('poolStats')!

const FRAME_COUNT = 16

// Take the first 16 photos from the manifest — PNGs at ~1-3MB each
// are heavy enough that main-thread decode is measurable on every
// scrub. Smaller frames make the naive path look artificially fast.
const FRAMES: Photo[] = takePhotos(FRAME_COUNT)

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

function resolvePhotos(cacheBust: string | null): string[] {
  return FRAMES.map((p) => photoUrl(p, cacheBust))
}

function setMeta(cacheBust: string | null): void {
  metaEl.textContent =
    `${FRAME_COUNT} local frames · ` +
    (cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — each run fetches fresh')
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

function setStatRow(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function resetStatHost(host: HTMLElement): void {
  for (const row of host.querySelectorAll<HTMLElement>('.row')) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
  }
}

function renderStats(el: HTMLElement, stats: Stats): void {
  const avg = stats.scrubCount === 0 ? null : stats.totalScrubMs / stats.scrubCount
  setStatRow(el, 1, `<b>${stats.setupMs.toFixed(0)}ms</b>`)
  setStatRow(el, 2, avg === null ? '<b>—</b>' : `<b>${avg.toFixed(1)}ms</b>`)
  setStatRow(el, 3, stats.scrubCount === 0 ? '<b>—</b>' : `<b>${stats.slowest.toFixed(1)}ms</b>`)
  setStatRow(el, 4, `<b>${stats.scrubCount}</b>`)
}

// --- Naive path ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Loading…'
  resetStatHost(naiveStats)
  naiveEmpty.style.display = 'flex'
  naiveEmpty.textContent = 'loading…'
  naiveFrameTag.textContent = '—'
  naiveTimeTag.textContent = '—'
  naiveTimeTag.className = 'tag'

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const urls = resolvePhotos(cacheBust)

  const t0 = performance.now()
  const images = urls.map((u) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = u
    return img
  })
  const naturalSizes = await Promise.all(
    urls.map(async (u) => {
      const prepared = await prepare(u)
      const m = getMeasurement(prepared)
      return { w: m.displayWidth, h: m.displayHeight }
    }),
  )
  const setupMs = performance.now() - t0
  const ctx = naiveCanvas.getContext('2d')!
  const stats = newStats(setupMs)
  naiveEmpty.style.display = 'none'

  const draw = async (i: number): Promise<void> => {
    const t = performance.now()
    const img = images[i]!
    if (!img.complete || img.naturalWidth === 0) {
      await new Promise<void>((res) => {
        img.addEventListener('load', () => res(), { once: true })
        img.addEventListener('error', () => res(), { once: true })
      })
    }
    if (typeof img.decode === 'function') {
      try {
        await img.decode()
      } catch {
        // some engines reject decode on certain sources
      }
    }
    const { w, h } = sizeCanvas(naiveCanvas)
    const size = naturalSizes[i]!
    drawContain(ctx, img, size.w, size.h, w, h)
    const dt = performance.now() - t
    stats.scrubCount++
    stats.totalScrubMs += dt
    if (dt > stats.slowest) stats.slowest = dt
    updateFrameTag(naiveTimeTag, dt)
    naiveFrameTag.textContent = `frame ${i + 1}`
    renderStats(naiveStats, stats)
  }

  naiveSlider.disabled = false
  naiveSlider.value = '0'
  naiveFrameLabel.textContent = `1 / ${FRAME_COUNT}`
  naiveSlider.addEventListener('input', () => {
    const i = Number(naiveSlider.value)
    naiveFrameLabel.textContent = `${i + 1} / ${FRAME_COUNT}`
    void draw(i)
  })
  await draw(0)
  // The first paint is really setup cost, not a scrub — reset counters
  // so the "avg scrub" reflects actual user drags.
  stats.scrubCount = 0
  stats.totalScrubMs = 0
  stats.slowest = 0
  renderStats(naiveStats, stats)
  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Reload frames'
}

// --- Pool path ---

async function runPool(): Promise<void> {
  runPoolBtn.disabled = true
  runPoolBtn.textContent = 'Warming…'
  resetStatHost(poolStats)
  poolEmpty.style.display = 'flex'
  poolEmpty.textContent = 'warming pool…'
  poolFrameTag.textContent = '—'
  poolTimeTag.textContent = '—'
  poolTimeTag.className = 'tag'
  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const urls = resolvePhotos(cacheBust)

  const t0 = performance.now()
  const pool = new DecodePool({
    concurrency: 4,
    maxCacheEntries: FRAME_COUNT,
  })
  const naturalSizes = await Promise.all(
    urls.map(async (u) => {
      const bitmap = await pool.get(u)
      return { w: bitmap.width, h: bitmap.height }
    }),
  )
  const setupMs = performance.now() - t0
  const ctx = poolCanvas.getContext('2d')!
  const stats = newStats(setupMs)
  poolEmpty.style.display = 'none'

  const draw = async (i: number): Promise<void> => {
    const t = performance.now()
    const bitmap = await pool.get(urls[i]!)
    const { w, h } = sizeCanvas(poolCanvas)
    const size = naturalSizes[i]!
    drawContain(ctx, bitmap, size.w, size.h, w, h)
    const dt = performance.now() - t
    stats.scrubCount++
    stats.totalScrubMs += dt
    if (dt > stats.slowest) stats.slowest = dt
    updateFrameTag(poolTimeTag, dt)
    poolFrameTag.textContent = `frame ${i + 1}`
    renderStats(poolStats, stats)
  }

  poolSlider.disabled = false
  poolSlider.value = '0'
  poolFrameLabel.textContent = `1 / ${FRAME_COUNT}`
  poolSlider.addEventListener('input', () => {
    const i = Number(poolSlider.value)
    poolFrameLabel.textContent = `${i + 1} / ${FRAME_COUNT}`
    void draw(i)
  })
  await draw(0)
  stats.scrubCount = 0
  stats.totalScrubMs = 0
  stats.slowest = 0
  renderStats(poolStats, stats)
  runPoolBtn.disabled = false
  runPoolBtn.textContent = 'Reload frames'
}

runNaiveBtn.addEventListener('click', () => void runNaive())
runPoolBtn.addEventListener('click', () => void runPool())
