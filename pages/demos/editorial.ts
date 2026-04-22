import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import {
  prepare,
  getMeasurement,
  getElement,
  preparedFromMeasurement,
  recordKnownMeasurement,
  type PreparedImage,
} from '@somnai-dreams/preimage'
import { flowColumnWithFloats } from '@somnai-dreams/preimage/pretext'
import { newCacheBustToken, photoUrl, PHOTOS, type Photo } from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const nativePanel = document.getElementById('native')!
const measuredPanel = document.getElementById('measured')!
const naiveStats = document.getElementById('naiveStats')!
const nativeStats = document.getElementById('nativeStats')!
const measuredStats = document.getElementById('measuredStats')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runNativeBtn = document.getElementById('runNative') as HTMLButtonElement
const runMeasuredBtn = document.getElementById('runMeasured') as HTMLButtonElement

const COLUMN_WIDTH = 400
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

// --- Shared utilities ---

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

// Poll an <img>'s naturalWidth until it becomes nonzero. Same
// mechanism preimage uses internally — the native panel opts into it
// manually so the dim-detection timing is apples-to-apples with the
// measured panel.
function pollForDims(
  img: HTMLImageElement,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    let done = false
    img.addEventListener(
      'error',
      () => {
        if (done) return
        done = true
        reject(new Error('image load failed'))
      },
      { once: true },
    )
    const tick = (): void => {
      if (done) return
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        done = true
        resolve({ width: img.naturalWidth, height: img.naturalHeight })
        return
      }
      if (img.complete) {
        done = true
        reject(new Error('loaded with no dims'))
        return
      }
      setTimeout(tick, 0)
    }
    tick()
  })
}

// --- Naive HTML panel: browser-managed <figure> floats ---

function buildNaiveHtml(panel: HTMLElement): HTMLImageElement[] {
  panel.innerHTML = ''
  panel.style.width = `${COLUMN_WIDTH}px`
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

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Running…'
  naivePanel.innerHTML = ''
  resetStats(naiveStats)

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const urls = buildUrls(cacheBust)

  const t0 = performance.now()
  const imgs = buildNaiveHtml(naivePanel)
  const monitor = observeShifts(naivePanel)

  let firstLoadedMs: number | null = null
  let lastLoadedMs: number | null = null

  for (let i = 0; i < imgs.length; i++) imgs[i]!.src = urls[i]!
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            const t = performance.now() - t0
            if (firstLoadedMs === null) {
              firstLoadedMs = t
              setRowValue(naiveStats, 1, `<b>${fmtMs(firstLoadedMs)}</b>`)
            }
            lastLoadedMs = t
            setRowValue(naiveStats, 2, `<b>${fmtMs(lastLoadedMs)}</b>`)
            resolve()
          }
          if (img.complete && img.naturalWidth > 0) done()
          else {
            img.addEventListener('load', done, { once: true })
            img.addEventListener('error', done, { once: true })
          }
        }),
    ),
  )
  monitor.stop()
  setShifts(naiveStats, monitor.shifts())

  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Run again'
}

// --- Pretext common infrastructure ---

// Pretext needs a PreparedImage per figure. When we only have raw
// width/height (e.g. from polling a native <img>), mint a synthetic
// one via recordKnownMeasurement so pretext's API shape is honoured
// without forcing a separate network fetch.
function syntheticPrepared(
  key: string,
  width: number,
  height: number,
): PreparedImage {
  const measurement = recordKnownMeasurement(key, width, height)
  return preparedFromMeasurement(measurement)
}

type FigureDims = { width: number; height: number }

function flowArticle(
  dims: ReadonlyArray<FigureDims | null>,
  urls: readonly string[],
  keyPrefix: string,
): { items: ReturnType<typeof flowColumnWithFloats>['items']; totalHeight: number } {
  const text = prepareWithSegments(ARTICLE, FONT)
  const floats = dims.map((d, i) => {
    const w = d?.width ?? 1
    const h = d?.height ?? 1
    // Cache key varies with dims so re-flows don't collide on the
    // measurement cache.
    return {
      image: syntheticPrepared(`${keyPrefix}:${urls[i]!}:${w}x${h}`, w, h),
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
  return { items: result.items, totalHeight: result.totalHeight }
}

function renderFlow(
  panel: HTMLElement,
  result: { items: ReturnType<typeof flowColumnWithFloats>['items']; totalHeight: number },
): { figs: HTMLElement[] } {
  panel.innerHTML = ''
  panel.style.width = `${COLUMN_WIDTH}px`
  panel.style.height = `${result.totalHeight}px`

  const text = prepareWithSegments(ARTICLE, FONT)
  const figs: HTMLElement[] = []
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
    }
  }
  return { figs }
}

// --- Native + polling ---

async function runNative(): Promise<void> {
  runNativeBtn.disabled = true
  runNativeBtn.textContent = 'Running…'
  nativePanel.innerHTML = ''
  resetStats(nativeStats)

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const urls = buildUrls(cacheBust)

  const t0 = performance.now()

  // No dims yet — start with 1×1 placeholders. Each time a figure's
  // polled dims arrive we update `dims[i]` and re-run pretext.
  const dims: Array<FigureDims | null> = FIGURES.map(() => null)
  let flowRuns = 0
  let firstFlowMs: number | null = null
  let finalFlowMs: number | null = null

  const doFlow = (): void => {
    flowRuns++
    const result = flowArticle(dims, urls, 'editorial-native')
    renderFlow(nativePanel, result)
    const now = performance.now() - t0
    if (firstFlowMs === null) firstFlowMs = now
    finalFlowMs = now
    setRowValue(nativeStats, 1, `<b>${flowRuns}</b>`)
    setRowValue(nativeStats, 2, `<b>${fmtMs(firstFlowMs)}</b>`)
    setRowValue(nativeStats, 3, `<b>${fmtMs(finalFlowMs)}</b>`)
  }

  doFlow()
  const monitor = observeShifts(nativePanel)

  await Promise.all(
    urls.map((url, i) => {
      const probe = new Image()
      probe.src = url
      return pollForDims(probe)
        .then((d) => {
          dims[i] = d
          doFlow()
        })
        .catch(() => {
          // load failed; leave this figure at 1×1 placeholder
        })
    }),
  )

  // All dims known; attach real rendered imgs with src = url. The
  // browser's HTTP cache should serve from the probe fetch.
  const figNodes = nativePanel.querySelectorAll<HTMLElement>('.fig')
  await Promise.all(
    Array.from(figNodes).map((fig, i) => {
      const img = fig.querySelector('img')
      if (img === null) return Promise.resolve()
      img.src = urls[i]!
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('loaded')
        fig.classList.add('has-image')
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        const done = (): void => {
          img.classList.add('loaded')
          fig.classList.add('has-image')
          resolve()
        }
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
      })
    }),
  )

  monitor.stop()
  setShifts(nativeStats, monitor.shifts())
  runNativeBtn.disabled = false
  runNativeBtn.textContent = 'Run again'
}

// --- Measured (pretext + preimage) ---

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
  const result = flowArticle(dims, urls, 'editorial-measured')
  const { figs } = renderFlow(measuredPanel, result)
  const flowMs = performance.now() - t0
  setRowValue(measuredStats, 1, `<b>1</b>`)
  setRowValue(measuredStats, 2, `<b>${fmtMs(flowMs)}</b>`)
  setRowValue(measuredStats, 3, `<b>${fmtMs(flowMs)}</b>`)

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    figs.map((fig, i) => {
      const placeholder = fig.querySelector('img') as HTMLImageElement | null
      if (placeholder === null) return Promise.resolve()
      const warmed = getElement(prepared[i]!)
      const img = warmed ?? placeholder
      if (warmed === null) img.src = urls[i]!
      // If the warmed <img> (or the newly-set src) already has bytes,
      // flag before replaceChild so the element enters the DOM at
      // opacity: 1 with no fade-in.
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('loaded')
        fig.classList.add('has-image')
      }
      if (warmed !== null && warmed !== placeholder) {
        fig.replaceChild(warmed, placeholder)
      }
      return new Promise<void>((resolve) => {
        if (img.complete && img.naturalWidth > 0) {
          resolve()
          return
        }
        const done = (): void => {
          img.classList.add('loaded')
          fig.classList.add('has-image')
          resolve()
        }
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
      })
    }),
  )
  monitor.stop()
  setShifts(measuredStats, monitor.shifts())
  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

runNaiveBtn.addEventListener('click', () => void runNaive())
runNativeBtn.addEventListener('click', () => void runNative())
runMeasuredBtn.addEventListener('click', () => void runMeasured())
