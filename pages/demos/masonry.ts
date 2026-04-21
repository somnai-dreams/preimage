import { prepare, getMeasurement } from '../../src/index.js'
import { packGallery, type GalleryItem } from '../../src/gallery.js'
import { loadPhotos, PICSUM_PHOTOS, type PhotoDescriptor } from './photo-source.js'

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

function observeShifts(panel: HTMLElement): { shifts: () => number; stop: () => void } {
  let shifts = 0
  let lastHeight = panel.getBoundingClientRect().height
  const observer = new ResizeObserver(() => {
    const h = panel.getBoundingClientRect().height
    if (Math.abs(h - lastHeight) > 0.5) {
      shifts++
      lastHeight = h
    }
  })
  observer.observe(panel)
  return { shifts: () => shifts, stop: () => observer.disconnect() }
}

async function renderNaive(blobs: Blob[]): Promise<{ ms: number; shifts: number }> {
  const t0 = performance.now()
  naivePanel.innerHTML = ''
  const monitor = observeShifts(naivePanel)
  const imgs = blobs.map(() => {
    const img = document.createElement('img')
    img.alt = ''
    naivePanel.appendChild(img)
    return img
  })
  for (let i = 0; i < blobs.length; i++) imgs[i]!.src = URL.createObjectURL(blobs[i]!)
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve()
          else img.onload = () => resolve()
        }),
    ),
  )
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts() }
}

async function renderNative(
  blobs: Blob[],
  photos: readonly PhotoDescriptor[],
): Promise<{ ms: number; shifts: number; frameReadyAt: number }> {
  const t0 = performance.now()
  nativePanel.innerHTML = ''
  const monitor = observeShifts(nativePanel)
  // Build all the frames first so the caller-declared aspects reserve
  // space immediately — this is what <img width height> is designed for.
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
  // Reserve-at-t=0 is the whole point of the native strategy.
  const frameReadyAt = performance.now() - t0
  for (let i = 0; i < blobs.length; i++) imgs[i]!.src = URL.createObjectURL(blobs[i]!)
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            img.classList.add('loaded')
            resolve()
          }
          if (img.complete && img.naturalWidth > 0) done()
          else img.onload = done
        }),
    ),
  )
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts(), frameReadyAt }
}

async function renderMeasured(blobs: Blob[]): Promise<{ ms: number; shifts: number; prepareMs: number }> {
  const t0 = performance.now()
  measuredPanel.innerHTML = ''
  const monitor = observeShifts(measuredPanel)
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
      const url = getMeasurement(prepared[p.itemIndex]!).blobUrl ?? ''
      const item = document.createElement('div')
      item.className = 'item'
      item.style.left = `${p.x}px`
      item.style.width = `${p.width}px`
      item.style.height = `${p.height}px`
      const img = document.createElement('img')
      img.src = url
      item.appendChild(img)
      rowEl.appendChild(item)
      imgs.push(img)
    }
    measuredPanel.appendChild(rowEl)
  }

  // Fade the photos in when the browser finishes decoding each, so the
  // frames visibly precede the filled imagery.
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            img.classList.add('loaded')
            resolve()
          }
          if (img.complete && img.naturalWidth > 0) done()
          else img.onload = done
        }),
    ),
  )
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts(), prepareMs }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Loading photos…'
  naivePanel.innerHTML = ''
  nativePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  naivePanel.style.minHeight = '500px'
  nativePanel.style.minHeight = '500px'
  measuredPanel.style.minHeight = '500px'
  naiveStat.textContent = 'loading…'
  nativeStat.textContent = 'loading…'
  measuredStat.textContent = 'loading…'

  const loaded = await loadPhotos(PICSUM_PHOTOS)
  const blobs = loaded.map((l) => l.blob)
  const origins = loaded.map((l) => l.origin)
  const picsumCount = origins.filter((o) => o === 'picsum').length
  const totalMB = blobs.reduce((a, b) => a + b.size, 0) / 1024 / 1024
  metaEl.textContent = `${PICSUM_PHOTOS.length} photos · ${totalMB.toFixed(1)} MB · ${picsumCount > 0 ? `${picsumCount}/${blobs.length} from picsum.photos` : 'picsum offline — using canvas fallbacks at the same aspects'}`

  runButton.textContent = 'Rendering…'
  naiveStat.textContent = 'rendering…'
  nativeStat.textContent = 'rendering…'
  measuredStat.textContent = 'rendering…'

  const [naive, native, measured] = await Promise.all([
    renderNaive(blobs),
    renderNative(blobs, PICSUM_PHOTOS),
    renderMeasured(blobs),
  ])

  naivePanel.style.minHeight = ''
  nativePanel.style.minHeight = ''
  measuredPanel.style.minHeight = ''
  naiveStat.textContent = `fully loaded in ${naive.ms.toFixed(0)}ms · ${naive.shifts} layout shifts`
  nativeStat.textContent = `frames reserved at t=${native.frameReadyAt.toFixed(0)}ms · fully loaded at ${native.ms.toFixed(0)}ms · ${native.shifts} layout shifts`
  measuredStat.textContent = `measured in ${measured.prepareMs.toFixed(0)}ms · fully loaded at ${measured.ms.toFixed(0)}ms · ${measured.shifts} layout shifts`

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
