import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import { prepare, getMeasurement, type PreparedImage } from '../../src/index.js'
import { flowColumnWithFloats } from '../../src/pretext.js'
import {
  newCacheBustToken,
  picsumReachable,
  resolvePhotoUrls,
  type PhotoDescriptor,
} from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveStat = document.getElementById('naiveStat')!
const measuredStat = document.getElementById('measuredStat')!

const COLUMN_WIDTH = 460
const LINE_HEIGHT = 22
const FONT = '14px/22px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'

const ARTICLE = `The first figure sits at the top of this paragraph as a right float. Without declared dimensions, the image starts at zero height and every line below reflows when the browser decodes the real size. Multiply by three figures and you get the cumulative layout shift editorial sites have paid content-policy penalties for since 2020. Almost no CMS, no markdown renderer, and no WYSIWYG editor ships image dimensions in the HTML by default.

The right panel measures each figure before layout runs. Preimage's prepare() streams the first kilobytes of each image, parses the format header for width and height, and returns the concrete rect. Pretext takes those rects as input to its variable-width cursor loop and flows the paragraph text around them in a single synchronous pass.

No author-declared attributes. No intermediate skeleton swap. The column's final height, every line's y-coordinate, and every figure's rect are all known before the first paint. When the bytes finish streaming the figures just fill into their already-reserved positions.`

const FIGURES: readonly PhotoDescriptor[] = [
  { seed: 'preimage-editorial-1', width: 2000, height: 1333, caption: 'landscape' },
  { seed: 'preimage-editorial-2', width: 2000, height: 1125, caption: 'cityscape' },
  { seed: 'preimage-editorial-3', width: 1400, height: 1960, caption: 'portrait' },
]

const FIGURE_TOPS = [0, 210, 420]

function metric(label: string, value: string, highlight: boolean = false): string {
  return `<span class="metric">${label} <b${highlight ? ' style="color:var(--reflow)"' : ''}>${value}</b></span>`
}

function buildArticle(panel: HTMLElement): HTMLImageElement[] {
  panel.innerHTML = ''
  const paragraphs = ARTICLE.split('\n\n')
  const imgs: HTMLImageElement[] = []
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const p = document.createElement('p')
    if (pi < FIGURES.length) {
      const fig = document.createElement('figure')
      const img = document.createElement('img')
      img.alt = ''
      fig.appendChild(img)
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

async function renderNaive(urls: readonly string[]): Promise<{ ms: number; shifts: number }> {
  const t0 = performance.now()
  const imgs = buildArticle(naivePanel)
  const monitor = observeShifts(naivePanel)
  for (let i = 0; i < imgs.length; i++) imgs[i]!.src = urls[i]!
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve()
          else {
            img.onload = () => resolve()
            img.onerror = () => resolve()
          }
        }),
    ),
  )
  monitor.stop()
  return { ms: performance.now() - t0, shifts: monitor.shifts() }
}

async function renderMeasured(
  urls: readonly string[],
  preparedPromise: Promise<PreparedImage[]>,
): Promise<{ ms: number; prepareMs: number; lineCount: number; shifts: number }> {
  const t0 = performance.now()
  measuredPanel.innerHTML = ''
  // fonts.ready and prepare() race in parallel; whichever is slower
  // gates the layout. `preparedPromise` was started earlier in run()
  // so naive's img.src fetches can't queue the prepare fetches behind
  // themselves when the browser dedupes same-URL requests.
  const [prepared] = await Promise.all([preparedPromise, document.fonts.ready])
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
      maxHeight: 160,
      gapX: 12,
      gapY: 2,
    })),
  })

  measuredPanel.style.width = `${COLUMN_WIDTH}px`
  measuredPanel.style.height = `${result.totalHeight}px`

  const figImgs: HTMLImageElement[] = []
  const figItemIndex: number[] = []
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
      figItemIndex.push(item.itemIndex)
    }
  }

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    figImgs.map((img, i) => {
      const itemIndex = figItemIndex[i]!
      const url = getMeasurement(prepared[itemIndex]!).blobUrl ?? urls[itemIndex]!
      return new Promise<void>((resolve) => {
        const done = (): void => {
          img.classList.add('loaded')
          resolve()
        }
        if (img.complete && img.naturalWidth > 0) done()
        else {
          img.onload = done
          img.onerror = done
        }
        img.src = url
      })
    }),
  )
  monitor.stop()
  return {
    ms: performance.now() - t0,
    prepareMs,
    lineCount: result.lineCount,
    shifts: monitor.shifts(),
  }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  naivePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  naiveStat.innerHTML = ''
  measuredStat.innerHTML = ''
  metaEl.textContent = ''

  const useLive = await picsumReachable()
  const cacheBust = newCacheBustToken()
  runButton.textContent = useLive ? 'Loading from picsum…' : 'Generating fallbacks…'
  const resolved = await resolvePhotoUrls(FIGURES, cacheBust, useLive)
  const urls = resolved.map((r) => r.url)

  metaEl.textContent = `${FIGURES.length} figures · ${useLive ? 'picsum.photos (cache-busted)' : 'picsum offline — canvas fallbacks'}`

  runButton.textContent = 'Running…'

  // Kick off prepares before renderNaive starts setting img.src. When
  // both panels fetch the same URL, the browser can stall the second
  // request behind the first's response headers; starting the
  // streaming header-probe first ensures the measured panel isn't
  // queued behind the naive panel's full-image downloads.
  const preparedPromise = Promise.all(urls.map((u) => prepare(u)))

  const [naive, measured] = await Promise.all([
    renderNaive(urls),
    renderMeasured(urls, preparedPromise),
  ])

  naiveStat.innerHTML = [
    metric('loaded at', `${naive.ms.toFixed(0)}ms`),
    metric('visible shifts', String(naive.shifts), naive.shifts > 0),
  ].join('')
  measuredStat.innerHTML = [
    metric('frame placed at', `${measured.prepareMs.toFixed(0)}ms`),
    metric('lines placed', String(measured.lineCount)),
    metric('fully loaded at', `${measured.ms.toFixed(0)}ms`),
    metric('visible shifts', String(measured.shifts), measured.shifts > 0),
  ].join('')

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
