import { prepare, getMeasurement } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'
import { observeShifts, paintDominantColorBehind } from './demo-utils.js'

const countSlider = document.getElementById('countSlider') as HTMLInputElement
const countVal = document.getElementById('countVal')!
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveResult = document.getElementById('naiveResult')!
const measuredResult = document.getElementById('measuredResult')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runMeasuredBtn = document.getElementById('runMeasured') as HTMLButtonElement

const COLUMNS = 3
const GAP = 6

// Larger source dimensions than previous iterations — picsum serves
// real photos at whatever size you ask for, and meaningful reflow
// windows need meaningful transfer times. At 2400×1600 each photo is
// ~400KB-1MB; scaled down to column width the detail is still visible.
const ASPECTS: Array<[number, number]> = [
  [2400, 1600], // 3:2 landscape
  [1800, 2400], // 3:4 portrait
  [2700, 1800], // 3:2 landscape
  [2400, 1350], // 16:9 landscape
  [1500, 2100], // 5:7 portrait
  [2250, 1500], // 3:2 landscape
  [2000, 2000], // 1:1 square
  [2560, 1440], // 16:9 landscape
  [1350, 2400], // 9:16 portrait
  [2400, 1600], // 3:2 landscape
]

function buildPhotos(count: number): PhotoDescriptor[] {
  return Array.from({ length: count }, (_, i) => {
    const [w, h] = ASPECTS[i % ASPECTS.length]!
    return {
      seed: `preimage-masonry-${i}`,
      width: w,
      height: h,
      caption: `photo ${i + 1}`,
    }
  })
}

// Layout: shortest-column fill. Returns (x, y, w, h) per tile plus
// the container's total height. Pure arithmetic over aspect ratios.
type Placement = { x: number; y: number; width: number; height: number }

function layoutShortestColumn(
  aspects: readonly number[],
  panelWidth: number,
): { placements: Placement[]; totalHeight: number } {
  const colWidth = (panelWidth - GAP * (COLUMNS - 1)) / COLUMNS
  const heights = new Array<number>(COLUMNS).fill(0)
  const placements: Placement[] = []
  for (const aspect of aspects) {
    let shortest = 0
    for (let c = 1; c < COLUMNS; c++) {
      if (heights[c]! < heights[shortest]!) shortest = c
    }
    const h = colWidth / aspect
    const x = shortest * (colWidth + GAP)
    const y = heights[shortest]!
    placements.push({ x, y, width: colWidth, height: h })
    heights[shortest] = y + h + GAP
  }
  return { placements, totalHeight: Math.max(...heights) - GAP }
}

function getCount(): number {
  return Number(countSlider.value)
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

type ResolvedPhoto = { url: string; origin: 'picsum' | 'fallback' }

async function resolvePhotos(
  photos: readonly PhotoDescriptor[],
  useLive: boolean,
  cacheBust: string | null,
  panelTag: string,
): Promise<ResolvedPhoto[]> {
  if (useLive) {
    return photos.map((p) => {
      const base = picsumUrl(p, cacheBust)
      const sep = base.includes('?') ? '&' : '?'
      return { url: `${base}${sep}panel=${panelTag}`, origin: 'picsum' as const }
    })
  }
  const results: ResolvedPhoto[] = []
  for (let i = 0; i < photos.length; i++) {
    const blob = await generateFallbackBlob(photos[i]!, (i * 43 + panelTag.length) % 360)
    results.push({ url: URL.createObjectURL(blob), origin: 'fallback' })
  }
  return results
}

function setMeta(useLive: boolean, cacheBust: string | null, count: number): void {
  metaEl.textContent =
    `${count} photos · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallbacks')
}

// --- Naive run ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Running…'
  naivePanel.innerHTML = ''
  naiveResult.innerHTML = ''

  const count = getCount()
  const photos = buildPhotos(count)
  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust, count)
  const resolved = await resolvePhotos(photos, useLive, cacheBust, 'naive')
  const urls = resolved.map((r) => r.url)

  // Click-to-layout timer starts the moment we actually begin the
  // render. Everything before this (photo prep, network probe) is
  // setup — not what the user cares about.
  const t0 = performance.now()
  const imgs = urls.map(() => {
    const img = document.createElement('img')
    img.alt = ''
    naivePanel.appendChild(img)
    return img
  })
  const monitor = observeShifts(naivePanel)
  for (let i = 0; i < urls.length; i++) imgs[i]!.src = urls[i]!
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

  const count = getCount()
  const photos = buildPhotos(count)
  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust, count)
  const resolved = await resolvePhotos(photos, useLive, cacheBust, 'measured')
  const urls = resolved.map((r) => r.url)

  // Timer starts at the moment of the click (after resolving — the
  // user's click is the last thing before this function runs). The
  // library's work is everything after t0: measure dims, solve
  // layout, commit DOM.
  const t0 = performance.now()
  const prepared = await Promise.all(
    urls.map((u) => prepare(u, { extractDominantColor: true })),
  )
  const measuredMs = performance.now() - t0

  const panelWidth = measuredPanel.getBoundingClientRect().width
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const { placements, totalHeight } = layoutShortestColumn(aspects, panelWidth)
  measuredPanel.style.height = `${totalHeight}px`

  const tiles: Array<{ container: HTMLElement; img: HTMLImageElement }> = []
  const frag = document.createDocumentFragment()
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!
    const container = document.createElement('div')
    container.className = 'item'
    container.style.left = `${p.x}px`
    container.style.top = `${p.y}px`
    container.style.width = `${p.width}px`
    container.style.height = `${p.height}px`
    const img = document.createElement('img')
    container.appendChild(img)
    frag.appendChild(container)
    tiles.push({ container, img })
    void paintDominantColorBehind(prepared[i]!, container)
  }
  measuredPanel.appendChild(frag)
  const laidOutMs = performance.now() - t0

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    tiles.map(({ img }, i) => {
      const url = getMeasurement(prepared[i]!).blobUrl ?? urls[i]!
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
    `<b>dims known</b> in <b>${measuredMs.toFixed(0)}ms</b> · ` +
    `layout committed at <b>${laidOutMs.toFixed(0)}ms</b> · ` +
    `<b>${shifts}</b> shifts`
  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

// --- Controls ---

countSlider.addEventListener('input', () => {
  countVal.textContent = countSlider.value
})
countVal.textContent = countSlider.value

runNaiveBtn.addEventListener('click', () => {
  void runNaive()
})
runMeasuredBtn.addEventListener('click', () => {
  void runMeasured()
})
