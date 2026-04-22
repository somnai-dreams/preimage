import { prepare, getMeasurement } from '../../src/index.js'
import { newCacheBustToken, photoUrl, takePhotos, PHOTO_COUNT } from './photo-source.js'
import { observeShifts } from './demo-utils.js'

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

function getCount(): number {
  return Math.min(Number(countSlider.value), PHOTO_COUNT)
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

function buildUrls(count: number, cacheBust: string | null): string[] {
  return takePhotos(count).map((p) => photoUrl(p, cacheBust))
}

// Shortest-column fill. Pure arithmetic over aspect ratios.
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

function setMeta(count: number, cacheBust: string | null): void {
  metaEl.textContent =
    `${count} local photos · ` +
    (cacheBust === null
      ? 'HTTP cache allowed'
      : 'cache-busted — each run fetches fresh')
}

// --- Naive run ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Running…'
  naivePanel.innerHTML = ''
  naiveResult.innerHTML = ''

  const count = getCount()
  const cacheBust = getCacheBust()
  setMeta(count, cacheBust)
  const urls = buildUrls(count, cacheBust)

  // Click-to-layout timer. Everything after this is what the user
  // actually waits on.
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
  const cacheBust = getCacheBust()
  setMeta(count, cacheBust)
  const urls = buildUrls(count, cacheBust)

  // Timer starts at the click. The library's work: measure dims, solve
  // layout, commit DOM — then images load into the reserved tiles.
  const t0 = performance.now()
  const prepared = await Promise.all(urls.map((u) => prepare(u)))
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

countSlider.max = String(PHOTO_COUNT)
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
