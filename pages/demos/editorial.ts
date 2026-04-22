import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import {
  prepare,
  getMeasurement,
  getElement,
  preparedFromMeasurement,
  recordKnownMeasurement,
  type PreparedImage,
} from '../../src/index.js'
import { flowColumnWithFloats } from '../../src/pretext.js'
import { newCacheBustToken, photoUrl, PHOTOS, type Photo } from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const metaEl = document.getElementById('meta')!
const nativePanel = document.getElementById('native')!
const measuredPanel = document.getElementById('measured')!
const nativeStats = document.getElementById('nativeStats')!
const measuredStats = document.getElementById('measuredStats')!
const runNativeBtn = document.getElementById('runNative') as HTMLButtonElement
const runMeasuredBtn = document.getElementById('runMeasured') as HTMLButtonElement

const COLUMN_WIDTH = 460
const LINE_HEIGHT = 22
const FONT = '14px/22px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'
const FIGURE_MAX_W = Math.round(COLUMN_WIDTH * 0.44)
const FIGURE_MAX_H = 160
const FIGURE_TOPS = [0, 210, 420]

const ARTICLE = `The first figure sits at the top of this paragraph as a right float. Without declared dimensions, the image starts at zero height and every line below reflows when the browser decodes the real size. Multiply by three figures and you get the cumulative layout shift editorial sites have paid content-policy penalties for since 2020. Almost no CMS, no markdown renderer, and no WYSIWYG editor ships image dimensions in the HTML by default.

The right panel measures each figure before layout runs. Preimage's prepare() streams the first kilobytes of each image, parses the format header for width and height, and returns the concrete rect. Pretext takes those rects as input to its variable-width cursor loop and flows the paragraph text around them in a single synchronous pass.

No author-declared attributes. No intermediate skeleton swap. The column's final height, every line's y-coordinate, and every figure's rect are all known before the first paint. When the bytes finish streaming the figures just fill into their already-reserved positions.`

const FIGURES: readonly Photo[] = [
  PHOTOS[12]!, // 13.png landscape
  PHOTOS[22]!, // 23.png landscape
  PHOTOS[3]!,  //  4.png portrait
]

// --- Stat helpers ---

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(0)}ms`
}

function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function setShifts(host: HTMLElement, n: number): void {
  const row = host.querySelector<HTMLElement>('.row.shift')
  if (row === null) return
  row.classList.toggle('has-shifts', n > 0)
  row.querySelector('.value b')!.innerHTML = String(n)
}

function resetStats(host: HTMLElement): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (const row of rows) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
  }
  host.querySelector<HTMLElement>('.row.shift')?.classList.remove('has-shifts')
}

// --- Shared pretext flow + render ---

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

function buildUrls(cacheBust: string | null): string[] {
  return FIGURES.map((p) => photoUrl(p, cacheBust))
}

function setMeta(cacheBust: string | null): void {
  metaEl.textContent =
    `${FIGURES.length} figures · ` +
    (cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — each run fetches fresh')
}

// Pretext needs a PreparedImage per figure. When we only have raw
// width/height (e.g. from native onload), mint a synthetic one via
// recordKnownMeasurement so pretext's API shape is honoured without
// forcing a network fetch from this code path.
function syntheticPrepared(
  url: string,
  width: number,
  height: number,
): PreparedImage {
  // Use a unique cache key per url+size so multiple reflows with
  // different dims don't collide.
  const key = `editorial-native:${url}:${width}x${height}`
  const measurement = recordKnownMeasurement(key, width, height)
  return preparedFromMeasurement(measurement)
}

type FigureDims = { width: number; height: number }

function flowArticle(
  dims: ReadonlyArray<FigureDims | null>,
  urls: readonly string[],
): { items: ReturnType<typeof flowColumnWithFloats>['items']; totalHeight: number; lineCount: number } {
  const text = prepareWithSegments(ARTICLE, FONT)
  // For figures whose dims aren't known yet, give pretext a 1×1
  // placeholder rect so it still knows where to put the float box.
  // When real dims land we reflow with them.
  const floats = dims.map((d, i) => {
    const w = d?.width ?? 1
    const h = d?.height ?? 1
    return {
      image: syntheticPrepared(urls[i]!, w, h),
      side: 'right' as const,
      top: FIGURE_TOPS[i]!,
      maxWidth: FIGURE_MAX_W,
      maxHeight: FIGURE_MAX_H,
      gapX: 12,
      gapY: 2,
    }
  })
  const result = flowColumnWithFloats({
    text,
    columnWidth: COLUMN_WIDTH,
    lineHeight: LINE_HEIGHT,
    floats,
  })
  return { items: result.items, totalHeight: result.totalHeight, lineCount: result.lineCount }
}

function renderFlow(
  panel: HTMLElement,
  urls: readonly string[],
  result: { items: ReturnType<typeof flowColumnWithFloats>['items']; totalHeight: number },
): { figs: HTMLElement[]; imgs: HTMLImageElement[] } {
  panel.innerHTML = ''
  panel.style.width = `${COLUMN_WIDTH}px`
  panel.style.height = `${result.totalHeight}px`

  const text = prepareWithSegments(ARTICLE, FONT)
  const figs: HTMLElement[] = []
  const imgs: HTMLImageElement[] = []
  for (const item of result.items) {
    if (item.kind === 'line') {
      const line = materializeLineRange(text, item.range)
      const el = document.createElement('div')
      el.className = 'line'
      el.style.left = `${item.x}px`
      el.style.top = `${item.y}px`
      el.style.width = `${item.width}px`
      el.textContent = line.text
      panel.appendChild(el)
    } else {
      const fig = document.createElement('div')
      fig.className = 'fig'
      fig.style.left = `${item.x}px`
      fig.style.top = `${item.y}px`
      fig.style.width = `${item.width}px`
      fig.style.height = `${item.height}px`
      const img = document.createElement('img')
      fig.appendChild(img)
      panel.appendChild(fig)
      figs.push(fig)
      imgs.push(img)
    }
  }
  void urls
  return { figs, imgs }
}

// --- Native run: dims come from img.naturalWidth after onload ---

async function runNative(): Promise<void> {
  runNativeBtn.disabled = true
  runNativeBtn.textContent = 'Running…'
  nativePanel.innerHTML = ''
  resetStats(nativeStats)

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const urls = buildUrls(cacheBust)

  const t0 = performance.now()

  // Start loading every image up front. At click-time we have no dims
  // yet, so pretext flows the article with 1x1 placeholders — the
  // float boxes are essentially absent. As each image's onload fires
  // we update its dims and re-flow.
  const dims: Array<FigureDims | null> = FIGURES.map(() => null)
  let flowRuns = 0
  let firstFlowMs: number | null = null
  let finalFlowMs: number | null = null

  const doFlow = (): void => {
    flowRuns++
    const result = flowArticle(dims, urls)
    renderFlow(nativePanel, urls, result)
    const now = performance.now() - t0
    if (firstFlowMs === null) firstFlowMs = now
    finalFlowMs = now
    setRowValue(nativeStats, 1, `<b>${flowRuns}</b>`)
    setRowValue(nativeStats, 2, `<b>${fmtMs(firstFlowMs)}</b>`)
    setRowValue(nativeStats, 3, `<b>${fmtMs(finalFlowMs)}</b>`)
  }

  // Initial pass: all dims unknown.
  doFlow()
  const monitor = observeShifts(nativePanel)

  // Start fetches outside pretext. When each one's dims are known,
  // re-flow.
  await Promise.all(
    urls.map(
      (url, i) =>
        new Promise<void>((resolve) => {
          const probe = new Image()
          probe.onload = () => {
            dims[i] = { width: probe.naturalWidth, height: probe.naturalHeight }
            doFlow()
            resolve()
          }
          probe.onerror = () => resolve()
          probe.src = url
        }),
    ),
  )

  // After all dims land and all flows are done, set the actual
  // <img src> on the rendered figures so they paint.
  const text = prepareWithSegments(ARTICLE, FONT)
  void text
  // Re-render one more time to be sure + attach images to the final
  // figures rendered. Since doFlow already re-rendered after the last
  // dim arrival, we just need to wire images into the current figs.
  const figNodes = nativePanel.querySelectorAll<HTMLElement>('.fig')
  figNodes.forEach((fig, i) => {
    const img = fig.querySelector('img')
    if (img === null) return
    img.onload = () => {
      img.classList.add('loaded')
      fig.classList.add('has-image')
    }
    img.onerror = () => fig.classList.add('has-image')
    img.src = urls[i]!
  })

  await Promise.all(
    Array.from(figNodes).map(
      (fig) =>
        new Promise<void>((resolve) => {
          const img = fig.querySelector('img')
          if (img === null) {
            resolve()
            return
          }
          if (img.complete && img.naturalWidth > 0) {
            resolve()
            return
          }
          const onDone = (): void => resolve()
          img.addEventListener('load', onDone, { once: true })
          img.addEventListener('error', onDone, { once: true })
        }),
    ),
  )
  monitor.stop()
  setShifts(nativeStats, monitor.shifts())
  runNativeBtn.disabled = false
  runNativeBtn.textContent = 'Run again'
}

// --- Measured run: dims from preimage.prepare() ---

async function runMeasured(): Promise<void> {
  runMeasuredBtn.disabled = true
  runMeasuredBtn.textContent = 'Running…'
  measuredPanel.innerHTML = ''
  resetStats(measuredStats)

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const urls = buildUrls(cacheBust)

  const t0 = performance.now()
  const [prepared] = await Promise.all([
    Promise.all(urls.map((u) => prepare(u))),
    document.fonts.ready,
  ])

  const dims: FigureDims[] = prepared.map((p) => {
    const m = getMeasurement(p)
    return { width: m.displayWidth, height: m.displayHeight }
  })
  const result = flowArticle(dims, urls)
  const { figs } = renderFlow(measuredPanel, urls, result)
  const flowMs = performance.now() - t0
  setRowValue(measuredStats, 1, `<b>1</b>`)
  setRowValue(measuredStats, 2, `<b>${fmtMs(flowMs)}</b>`)
  setRowValue(measuredStats, 3, `<b>${fmtMs(flowMs)}</b>`)

  const monitor = observeShifts(measuredPanel)
  // Replace each figure's fresh <img> with the warmed one prepare()
  // already had in flight. That's the only way to get "one fetch per
  // figure" — reusing the same element the library used to measure.
  await Promise.all(
    figs.map((fig, i) => {
      const placeholder = fig.querySelector('img') as HTMLImageElement | null
      if (placeholder === null) return Promise.resolve()
      const warmed = getElement(prepared[i]!)
      const img = warmed ?? placeholder
      if (warmed !== null && warmed !== placeholder) {
        fig.replaceChild(warmed, placeholder)
      }
      if (warmed === null) img.src = urls[i]!
      return new Promise<void>((resolve) => {
        const done = (): void => {
          img.classList.add('loaded')
          fig.classList.add('has-image')
          resolve()
        }
        if (img.complete && img.naturalWidth > 0) done()
        else {
          img.addEventListener('load', done, { once: true })
          img.addEventListener('error', done, { once: true })
        }
      })
    }),
  )
  monitor.stop()
  setShifts(measuredStats, monitor.shifts())
  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

runNativeBtn.addEventListener('click', () => void runNative())
runMeasuredBtn.addEventListener('click', () => void runMeasured())
