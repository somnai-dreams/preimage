import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import { prepare, getMeasurement } from '../../src/index.js'
import { flowColumnWithFloats } from '../../src/pretext.js'
import { loadPhotos, latencyFor, type PhotoDescriptor } from './photo-source.js'
import { loadImgWithLatency, observeShifts, sleep, wireLatencySlider } from './demo-utils.js'

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

const latencyControl = wireLatencySlider('latency', 'latencyValue', 800)

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

async function renderNaive(blobs: Blob[], latencyMs: number): Promise<{ ms: number; shifts: number }> {
  const t0 = performance.now()
  const monitor = observeShifts(naivePanel.parentElement!)
  const imgs = buildArticleHtml(naivePanel, false, FIGURES)
  await Promise.all(imgs.map((img, i) => loadImgWithLatency(img, blobs[i]!, latencyMs)))
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts() }
}

async function renderNative(blobs: Blob[], latencyMs: number): Promise<{ ms: number; shifts: number; frameReadyAt: number }> {
  const t0 = performance.now()
  const monitor = observeShifts(nativePanel.parentElement!)
  const imgs = buildArticleHtml(nativePanel, true, FIGURES)
  const frameReadyAt = performance.now() - t0
  await Promise.all(imgs.map((img, i) => loadImgWithLatency(img, blobs[i]!, latencyMs)))
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts(), frameReadyAt }
}

async function renderMeasured(
  blobs: Blob[],
  latencyMs: number,
): Promise<{ ms: number; shifts: number; prepareMs: number; lineCount: number }> {
  const t0 = performance.now()
  measuredPanel.innerHTML = ''
  const monitor = observeShifts(measuredPanel.parentElement!)
  await document.fonts.ready
  const probeDelay = Math.round(latencyMs * 0.1)
  if (probeDelay > 0) await sleep(probeDelay)
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
  const figIndexByItem: number[] = []
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
      fig.appendChild(img)
      measuredPanel.appendChild(fig)
      figImgs.push(img)
      figIndexByItem.push(item.itemIndex)
    }
  }

  const remainingDelay = Math.max(0, latencyMs - probeDelay)
  await Promise.all(
    figImgs.map(async (img, i) => {
      const itemIndex = figIndexByItem[i]!
      const blob = blobs[itemIndex]!
      const cachedUrl = getMeasurement(prepared[itemIndex]!).blobUrl
      if (remainingDelay > 0) await sleep(remainingDelay)
      return await new Promise<void>((resolve) => {
        const done = (): void => {
          img.classList.add('loaded')
          resolve()
        }
        if (img.complete && img.naturalWidth > 0) done()
        else img.onload = done
        img.src = cachedUrl ?? URL.createObjectURL(blob)
      })
    }),
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
  const picsumCount = loaded.filter((l) => l.origin === 'picsum').length
  const latencyMs = latencyControl.read()
  void latencyFor
  const totalMB = blobs.reduce((a, b) => a + b.size, 0) / 1024 / 1024
  metaEl.textContent =
    `${FIGURES.length} photos · ${totalMB.toFixed(1)} MB · ` +
    (picsumCount > 0 ? `${picsumCount}/${blobs.length} from picsum.photos` : 'picsum offline — canvas fallbacks') +
    ` · simulating ${latencyMs}ms transfer per image`

  runButton.textContent = 'Rendering…'
  naiveStat.textContent = 'rendering…'
  nativeStat.textContent = 'rendering…'
  measuredStat.textContent = 'rendering…'

  const [naive, native, measured] = await Promise.all([
    renderNaive(blobs, latencyMs),
    renderNative(blobs, latencyMs),
    renderMeasured(blobs, latencyMs),
  ])

  naiveStat.textContent = `loaded in ${naive.ms.toFixed(0)}ms · ${naive.shifts} visible shifts`
  nativeStat.textContent = `frames at t=${native.frameReadyAt.toFixed(0)}ms · loaded in ${native.ms.toFixed(0)}ms · ${native.shifts} visible shifts`
  measuredStat.textContent = `frames at t=${measured.prepareMs.toFixed(0)}ms · ${measured.lineCount} lines placed · loaded in ${measured.ms.toFixed(0)}ms · ${measured.shifts} visible shifts`

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
