import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import { prepare, getMeasurement } from '../../src/index.js'
import { flowColumnWithFloats } from '../../src/pretext.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveResult = document.getElementById('naiveResult')!
const measuredResult = document.getElementById('measuredResult')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runMeasuredBtn = document.getElementById('runMeasured') as HTMLButtonElement

const COLUMN_WIDTH = 460
const LINE_HEIGHT = 22
const FONT = '14px/22px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'

const ARTICLE = `The first figure sits at the top of this paragraph as a right float. Without declared dimensions, the image starts at zero height and every line below reflows when the browser decodes the real size. Multiply by three figures and you get the cumulative layout shift editorial sites have paid content-policy penalties for since 2020. Almost no CMS, no markdown renderer, and no WYSIWYG editor ships image dimensions in the HTML by default.

The right panel measures each figure before layout runs. Preimage's prepare() streams the first kilobytes of each image, parses the format header for width and height, and returns the concrete rect. Pretext takes those rects as input to its variable-width cursor loop and flows the paragraph text around them in a single synchronous pass.

No author-declared attributes. No intermediate skeleton swap. The column's final height, every line's y-coordinate, and every figure's rect are all known before the first paint. When the bytes finish streaming the figures just fill into their already-reserved positions.`

const FIGURES: readonly PhotoDescriptor[] = [
  { seed: 'preimage-editorial-1', width: 2400, height: 1600, caption: 'landscape' },
  { seed: 'preimage-editorial-2', width: 2400, height: 1350, caption: 'cityscape' },
  { seed: 'preimage-editorial-3', width: 1800, height: 2400, caption: 'portrait' },
]

const FIGURE_TOPS = [0, 210, 420]

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
    return FIGURES.map((p) => {
      const base = picsumUrl(p, cacheBust)
      const sep = base.includes('?') ? '&' : '?'
      return `${base}${sep}panel=${panelTag}`
    })
  }
  const out: string[] = []
  for (let i = 0; i < FIGURES.length; i++) {
    const blob = await generateFallbackBlob(FIGURES[i]!, (i * 43 + panelTag.length) % 360)
    out.push(URL.createObjectURL(blob))
  }
  return out
}

function setMeta(useLive: boolean, cacheBust: string | null): void {
  metaEl.textContent =
    `${FIGURES.length} figures · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')
}

function buildNaiveArticle(panel: HTMLElement): HTMLImageElement[] {
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

// --- Naive run ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Running…'
  naivePanel.innerHTML = ''
  naiveResult.innerHTML = ''
  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust)
  const urls = await resolvePhotos(useLive, cacheBust, 'naive')

  const t0 = performance.now()
  const imgs = buildNaiveArticle(naivePanel)
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
  const totalMs = performance.now() - t0
  const shifts = monitor.shifts()
  naiveResult.innerHTML = `<b>${shifts}</b> layout shifts · <b>${totalMs.toFixed(0)}ms</b> to final layout`
  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Run again'
}

// --- Measured run ---

async function runMeasured(): Promise<void> {
  runMeasuredBtn.disabled = true
  runMeasuredBtn.textContent = 'Running…'
  measuredPanel.innerHTML = ''
  measuredPanel.style.height = '0px'
  measuredResult.innerHTML = ''
  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust)
  const urls = await resolvePhotos(useLive, cacheBust, 'measured')

  const t0 = performance.now()
  const [prepared] = await Promise.all([
    Promise.all(urls.map((u) => prepare(u))),
    document.fonts.ready,
  ])
  const preparedMs = performance.now() - t0

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

  const figImgs: Array<{ img: HTMLImageElement; itemIndex: number }> = []
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
      figImgs.push({ img, itemIndex: item.itemIndex })
    }
  }
  const laidOutMs = performance.now() - t0

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    figImgs.map(({ img, itemIndex }) => {
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
  const shifts = monitor.shifts()
  measuredResult.innerHTML =
    `<b>dims known</b> in <b>${preparedMs.toFixed(0)}ms</b> · ` +
    `column committed at <b>${laidOutMs.toFixed(0)}ms</b> · ` +
    `<b>${shifts}</b> shifts`
  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

runNaiveBtn.addEventListener('click', () => {
  void runNaive()
})
runMeasuredBtn.addEventListener('click', () => {
  void runMeasured()
})
