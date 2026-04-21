import { prepare, getMeasurement } from '../../src/index.js'
import { packGallery, type GalleryItem } from '../../src/gallery.js'
import { loadPhotos, latencyFor, PICSUM_PHOTOS, type PhotoDescriptor } from './photo-source.js'
import { loadImgWithLatency, observeShifts, sleep, wireLatencySlider } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const nativePanel = document.getElementById('native')!
const measuredPanel = document.getElementById('measured')!
const naiveStat = document.getElementById('naiveStat')!
const nativeStat = document.getElementById('nativeStat')!
const measuredStat = document.getElementById('measuredStat')!

const PANEL_WIDTH = 280
const ROW_HEIGHT = 110
const GAP = 6

const latencyControl = wireLatencySlider('latency', 'latencyValue', 800)

async function renderNaive(blobs: Blob[], latencyMs: number): Promise<{ ms: number; shifts: number }> {
  const t0 = performance.now()
  naivePanel.innerHTML = ''
  const imgs = blobs.map(() => {
    const img = document.createElement('img')
    img.alt = ''
    naivePanel.appendChild(img)
    return img
  })
  // Start observing only after the synchronous DOM setup, so the counter
  // measures shifts caused by async image loads — not by clearing+
  // rebuilding the panel between runs.
  const monitor = observeShifts(naivePanel.parentElement!)
  await Promise.all(imgs.map((img, i) => loadImgWithLatency(img, blobs[i]!, latencyMs)))
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts() }
}

async function renderNative(
  blobs: Blob[],
  photos: readonly PhotoDescriptor[],
  latencyMs: number,
): Promise<{ ms: number; shifts: number; frameReadyAt: number }> {
  const t0 = performance.now()
  nativePanel.innerHTML = ''
  const imgs: HTMLImageElement[] = []
  for (let i = 0; i < blobs.length; i++) {
    const p = photos[i]!
    const frame = document.createElement('span')
    frame.className = 'frame'
    frame.style.aspectRatio = `${p.width} / ${p.height}`
    const img = document.createElement('img')
    img.width = p.width
    img.height = p.height
    img.alt = ''
    frame.appendChild(img)
    nativePanel.appendChild(frame)
    imgs.push(img)
  }
  const frameReadyAt = performance.now() - t0
  // Start observing after the frames are in place, so we only count
  // shifts caused by async image loads — the reserved aspect-ratio
  // boxes should absorb the imagery without moving anything.
  const monitor = observeShifts(nativePanel.parentElement!)
  await Promise.all(imgs.map((img, i) => loadImgWithLatency(img, blobs[i]!, latencyMs)))
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts(), frameReadyAt }
}

async function renderMeasured(
  blobs: Blob[],
  latencyMs: number,
): Promise<{ ms: number; shifts: number; prepareMs: number }> {
  const t0 = performance.now()
  measuredPanel.innerHTML = ''
  // In a real network scenario prepare streams from the first-arriving
  // bytes. Model that: wait ~10% of the simulated transfer before
  // measurement returns.
  const probeDelay = Math.round(latencyMs * 0.1)
  if (probeDelay > 0) await sleep(probeDelay)
  const prepared = await Promise.all(blobs.map((b) => prepare(b)))
  const prepareMs = performance.now() - t0

  const items: GalleryItem[] = prepared.map((image) => ({ image }))
  const rows = packGallery(items, {
    maxWidth: PANEL_WIDTH - 20,
    targetRowHeight: ROW_HEIGHT,
    gap: GAP,
  })

  const imgs: HTMLImageElement[] = []
  for (const row of rows) {
    const rowEl = document.createElement('div')
    rowEl.className = 'row'
    rowEl.style.height = `${row.height}px`
    for (const p of row.placements) {
      const item = document.createElement('div')
      item.className = 'item'
      item.style.left = `${p.x}px`
      item.style.width = `${p.width}px`
      item.style.height = `${p.height}px`
      const img = document.createElement('img')
      item.appendChild(img)
      rowEl.appendChild(item)
      imgs.push(img)
    }
    measuredPanel.appendChild(rowEl)
  }

  // Remaining bytes arrive over the rest of the simulated transfer, then
  // each image's cached blobUrl can actually resolve in the DOM. (In
  // the live-picsum case latencyMs == 0, so this is ~instant.)
  const remainingDelay = Math.max(0, latencyMs - probeDelay)
  // Start observing after the frame grid is placed, so only actual
  // image-driven shifts are counted.
  const monitor = observeShifts(measuredPanel.parentElement!)
  await Promise.all(
    imgs.map((img, i) => {
      const url = getMeasurement(prepared[i]!).blobUrl ?? URL.createObjectURL(blobs[i]!)
      return loadImgWithLatencyFromUrl(img, url, remainingDelay)
    }),
  )
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts(), prepareMs }
}

// Same shape as loadImgWithLatency but takes a pre-resolved URL (blobUrl
// from getMeasurement) instead of a raw Blob. The measurement already
// created the URL; we just defer assignment.
async function loadImgWithLatencyFromUrl(
  img: HTMLImageElement,
  url: string,
  latencyMs: number,
): Promise<void> {
  if (latencyMs > 0) await sleep(latencyMs)
  return await new Promise<void>((resolve) => {
    const done = (): void => {
      img.classList.add('loaded')
      resolve()
    }
    if (img.complete && img.naturalWidth > 0) done()
    else img.onload = done
    img.src = url
  })
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Loading photos…'
  naivePanel.innerHTML = ''
  nativePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  naiveStat.textContent = 'loading…'
  nativeStat.textContent = 'loading…'
  measuredStat.textContent = 'loading…'

  const loaded = await loadPhotos(PICSUM_PHOTOS)
  const blobs = loaded.map((l) => l.blob)
  const picsumCount = loaded.filter((l) => l.origin === 'picsum').length
  const latencyMs = latencyControl.read()
  void latencyFor
  const totalMB = blobs.reduce((a, b) => a + b.size, 0) / 1024 / 1024
  metaEl.textContent =
    `${PICSUM_PHOTOS.length} photos · ${totalMB.toFixed(1)} MB · ` +
    (picsumCount > 0 ? `${picsumCount}/${blobs.length} from picsum.photos` : 'picsum offline — canvas fallbacks') +
    ` · simulating ${latencyMs}ms transfer per image`

  runButton.textContent = 'Rendering…'
  naiveStat.textContent = 'rendering…'
  nativeStat.textContent = 'rendering…'
  measuredStat.textContent = 'rendering…'

  const [naive, native, measured] = await Promise.all([
    renderNaive(blobs, latencyMs),
    renderNative(blobs, PICSUM_PHOTOS, latencyMs),
    renderMeasured(blobs, latencyMs),
  ])

  naiveStat.textContent = `loaded in ${naive.ms.toFixed(0)}ms · ${naive.shifts} visible shifts`
  nativeStat.textContent = `frames at t=${native.frameReadyAt.toFixed(0)}ms · loaded in ${native.ms.toFixed(0)}ms · ${native.shifts} visible shifts`
  measuredStat.textContent = `frames at t=${measured.prepareMs.toFixed(0)}ms · loaded in ${measured.ms.toFixed(0)}ms · ${measured.shifts} visible shifts`

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
