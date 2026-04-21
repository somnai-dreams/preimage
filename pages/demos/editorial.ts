import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import { prepare, getMeasurement } from '../../src/index.js'
import { flowColumnWithFloats } from '../../src/pretext.js'
import { loadPhotos, type PhotoDescriptor } from './photo-source.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const nativePanel = document.getElementById('native')!
const measuredPanel = document.getElementById('measured')!
const naiveStat = document.getElementById('naiveStat')!
const nativeStat = document.getElementById('nativeStat')!
const measuredStat = document.getElementById('measuredStat')!

const COLUMN_WIDTH = 340
const LINE_HEIGHT = 22
const FONT = '14px/22px -apple-system, system-ui, sans-serif'

const ARTICLE = `The first figure sits at the top of this paragraph as a right float. Without declared dimensions, the image starts at zero height and every line below reflows when the browser decodes the real size. Multiply by three figures and you get the cumulative layout shift editorial sites have paid content-policy penalties for since 2020.

The middle panel shows the simplest modern answer: declare the image width and height as HTML attributes. The browser uses them to derive an aspect-ratio box and reserves the frame from the first paint. No library required — but the author had to know each figure's dimensions ahead of time.

The right panel uses preimage plus pretext. Preimage measures each figure in a pre-layout pass, streaming the first kilobytes of each file's bytes via a header probe. Pretext lays out the text around those measured rects synchronously. No shift, no skeleton swap, no author-declared attributes — and nothing that depends on the server cooperating.`

const FIGURES: readonly PhotoDescriptor[] = [
  { seed: 'preimage-editorial-1', width: 1600, height: 1067, caption: 'landscape' },
  { seed: 'preimage-editorial-2', width: 1600, height: 900, caption: 'cityscape' },
  { seed: 'preimage-editorial-3', width: 1000, height: 1400, caption: 'portrait' },
]

const FIGURE_TOPS = [0, 170, 330]

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

function buildArticleHtml(
  panel: HTMLElement,
  useDeclaredDims: boolean,
  photos: readonly PhotoDescriptor[],
): HTMLImageElement[] {
  panel.innerHTML = ''
  const paragraphs = ARTICLE.split('\n\n')
  const imgs: HTMLImageElement[] = []
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const p = document.createElement('p')
    if (pi < photos.length) {
      const fig = document.createElement('figure')
      const photo = photos[pi]!
      const img = document.createElement('img')
      if (useDeclaredDims) {
        img.width = photo.width
        img.height = photo.height
        const frame = document.createElement('span')
        frame.className = 'frame'
        frame.style.aspectRatio = `${photo.width} / ${photo.height}`
        frame.appendChild(img)
        fig.appendChild(frame)
      } else {
        fig.appendChild(img)
      }
      imgs.push(img)
      const cap = document.createElement('figcaption')
      cap.textContent = `Figure ${pi + 1}`
      fig.appendChild(cap)
      p.appendChild(fig)
    }
    p.appendChild(document.createTextNode(paragraphs[pi]!))
    panel.appendChild(p)
  }
  return imgs
}

async function renderNaive(blobs: Blob[]): Promise<{ ms: number; shifts: number }> {
  const t0 = performance.now()
  const monitor = observeShifts(naivePanel)
  const imgs = buildArticleHtml(naivePanel, false, FIGURES)
  for (let i = 0; i < imgs.length; i++) imgs[i]!.src = URL.createObjectURL(blobs[i]!)
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

async function renderNative(blobs: Blob[]): Promise<{ ms: number; shifts: number; frameReadyAt: number }> {
  const t0 = performance.now()
  const monitor = observeShifts(nativePanel)
  const imgs = buildArticleHtml(nativePanel, true, FIGURES)
  const frameReadyAt = performance.now() - t0
  for (let i = 0; i < imgs.length; i++) imgs[i]!.src = URL.createObjectURL(blobs[i]!)
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

async function renderMeasured(blobs: Blob[]): Promise<{ ms: number; shifts: number; prepareMs: number; lineCount: number }> {
  const t0 = performance.now()
  measuredPanel.innerHTML = ''
  const monitor = observeShifts(measuredPanel)
  await document.fonts.ready
  const prepared = await Promise.all(blobs.map((b) => prepare(b)))
  const prepareMs = performance.now() - t0

  const text = prepareWithSegments(ARTICLE, FONT)
  const result = flowColumnWithFloats({
    text,
    columnWidth: COLUMN_WIDTH,
    lineHeight: LINE_HEIGHT,
    floats: prepared.map((image, i) => ({
      image,
      side: 'right' as const,
      top: FIGURE_TOPS[i]!,
      maxWidth: Math.round(COLUMN_WIDTH * 0.44),
      maxHeight: 130,
      gapX: 10,
      gapY: 2,
    })),
  })

  measuredPanel.style.width = `${COLUMN_WIDTH}px`
  measuredPanel.style.height = `${result.totalHeight}px`

  const figImgs: HTMLImageElement[] = []
  for (const item of result.items) {
    if (item.kind === 'line') {
      const line = materializeLineRange(text, item.range)
      const el = document.createElement('div')
      el.className = 'line'
      el.style.left = `${item.x}px`
      el.style.top = `${item.y}px`
      el.style.width = `${item.width}px`
      el.textContent = line.text
      measuredPanel.appendChild(el)
    } else {
      const fig = document.createElement('div')
      fig.className = 'fig'
      fig.style.left = `${item.x}px`
      fig.style.top = `${item.y}px`
      fig.style.width = `${item.width}px`
      fig.style.height = `${item.height}px`
      const img = document.createElement('img')
      img.src = getMeasurement(item.image).blobUrl ?? ''
      fig.appendChild(img)
      measuredPanel.appendChild(fig)
      figImgs.push(img)
    }
  }
  await Promise.all(
    figImgs.map(
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
  return { ms: performance.now() - t0, shifts: monitor.shifts(), prepareMs, lineCount: result.lineCount }
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

  const loaded = await loadPhotos(FIGURES)
  const blobs = loaded.map((l) => l.blob)
  const origins = loaded.map((l) => l.origin)
  const picsumCount = origins.filter((o) => o === 'picsum').length
  const totalMB = blobs.reduce((a, b) => a + b.size, 0) / 1024 / 1024
  metaEl.textContent = `${FIGURES.length} photos · ${totalMB.toFixed(1)} MB · ${picsumCount > 0 ? `${picsumCount}/${blobs.length} from picsum.photos` : 'picsum offline — using canvas fallbacks at the same aspects'}`

  runButton.textContent = 'Rendering…'
  naiveStat.textContent = 'rendering…'
  nativeStat.textContent = 'rendering…'
  measuredStat.textContent = 'rendering…'

  const [naive, native, measured] = await Promise.all([
    renderNaive(blobs),
    renderNative(blobs),
    renderMeasured(blobs),
  ])

  naiveStat.textContent = `fully loaded in ${naive.ms.toFixed(0)}ms · ${naive.shifts} layout shifts`
  nativeStat.textContent = `frames reserved at t=${native.frameReadyAt.toFixed(0)}ms · fully loaded at ${native.ms.toFixed(0)}ms · ${native.shifts} layout shifts`
  measuredStat.textContent = `measured in ${measured.prepareMs.toFixed(0)}ms · ${measured.lineCount} lines placed · fully loaded at ${measured.ms.toFixed(0)}ms · ${measured.shifts} layout shifts`

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
