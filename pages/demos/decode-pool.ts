import { DecodePool, prepare, getMeasurement } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'

const metaEl = document.getElementById('meta')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runPoolBtn = document.getElementById('runPool') as HTMLButtonElement
const naiveResult = document.getElementById('naiveResult')!
const poolResult = document.getElementById('poolResult')!

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

const FRAME_COUNT = 16

// 2000×1125 JPEGs are heavy enough (≈250-500KB each) that main-thread
// decode is measurable on every scrub. Smaller frames make the naive
// path look artificially fast.
const PHOTOS: PhotoDescriptor[] = Array.from({ length: FRAME_COUNT }, (_, i) => ({
  seed: `preimage-pool-${i}`,
  width: 2000,
  height: 1125,
  caption: `frame ${i + 1}`,
}))

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

async function resolvePhotos(
  useLive: boolean,
  cacheBust: string | null,
  panelTag: string,
): Promise<string[]> {
  if (useLive) {
    return PHOTOS.map((p) => {
      const base = picsumUrl(p, cacheBust)
      const sep = base.includes('?') ? '&' : '?'
      return `${base}${sep}panel=${panelTag}`
    })
  }
  const out: string[] = []
  for (let i = 0; i < PHOTOS.length; i++) {
    const blob = await generateFallbackBlob(PHOTOS[i]!, (i * 29 + panelTag.length) % 360)
    out.push(URL.createObjectURL(blob))
  }
  return out
}

function setMeta(useLive: boolean, cacheBust: string | null): void {
  metaEl.textContent =
    `${FRAME_COUNT} frames @ ${PHOTOS[0]!.width}×${PHOTOS[0]!.height} · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')
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

function renderResult(el: HTMLElement, stats: Stats, setupLabel: string): void {
  const avg = stats.scrubCount === 0 ? 0 : stats.totalScrubMs / stats.scrubCount
  const parts = [`${setupLabel} <b>${stats.setupMs.toFixed(0)}ms</b>`]
  if (stats.scrubCount > 0) {
    parts.push(`avg scrub <b>${avg.toFixed(1)}ms</b>`)
    parts.push(`slowest <b>${stats.slowest.toFixed(1)}ms</b>`)
    parts.push(`<b>${stats.scrubCount}</b> scrubs`)
  }
  el.innerHTML = parts.join(' · ')
}

// --- Naive path ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Loading…'
  naiveResult.innerHTML = ''
  naiveEmpty.style.display = 'flex'
  naiveEmpty.textContent = 'loading…'
  naiveFrameTag.textContent = '—'
  naiveTimeTag.textContent = '—'
  naiveTimeTag.className = 'tag'

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust)
  const urls = await resolvePhotos(useLive, cacheBust, 'naive')

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
    renderResult(naiveResult, stats, 'setup')
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
  renderResult(naiveResult, stats, 'setup')
  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Reload frames'
}

// --- Pool path ---

async function runPool(): Promise<void> {
  runPoolBtn.disabled = true
  runPoolBtn.textContent = 'Warming…'
  poolResult.innerHTML = ''
  poolEmpty.style.display = 'flex'
  poolEmpty.textContent = 'warming pool…'
  poolFrameTag.textContent = '—'
  poolTimeTag.textContent = '—'
  poolTimeTag.className = 'tag'
  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust)
  const urls = await resolvePhotos(useLive, cacheBust, 'pool')

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
    renderResult(poolResult, stats, 'warm')
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
  renderResult(poolResult, stats, 'warm')
  runPoolBtn.disabled = false
  runPoolBtn.textContent = 'Reload frames'
}

runNaiveBtn.addEventListener('click', () => void runNaive())
runPoolBtn.addEventListener('click', () => void runPool())
