import { prepare, getMeasurement, getElement } from '../../src/index.js'
import { newCacheBustToken, photoUrl, takePhotos, PHOTO_COUNT } from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const countSlider = document.getElementById('countSlider') as HTMLInputElement
const countVal = document.getElementById('countVal')!
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveStats = document.getElementById('naiveStats')!
const measuredStats = document.getElementById('measuredStats')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runMeasuredBtn = document.getElementById('runMeasured') as HTMLButtonElement

const COLUMNS = 3
const GAP = 6

type Mode = 'batch' | 'progressive'

function getCount(): number {
  return Math.min(Number(countSlider.value), PHOTO_COUNT)
}

function getMode(): Mode {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')
  return checked?.value === 'progressive' ? 'progressive' : 'batch'
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

function buildUrls(count: number, cacheBust: string | null): string[] {
  return takePhotos(count).map((p) => photoUrl(p, cacheBust))
}

function setMeta(count: number, cacheBust: string | null): void {
  metaEl.textContent =
    `${count} local photos · ` +
    (cacheBust === null
      ? 'HTTP cache allowed'
      : 'cache-busted — each run fetches fresh')
}

// --- Shared stats helpers: update pre-rendered rows in place ---

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(0)}ms`
}

function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function fillStats(
  host: HTMLElement,
  firstReservedMs: number,
  avgDimMs: number,
  allReservedMs: number,
): void {
  setRowValue(host, 1, `<b>${fmtMs(firstReservedMs)}</b>`)
  setRowValue(host, 2, `<b>${fmtMs(avgDimMs)}</b>`)
  setRowValue(host, 3, `<b>${fmtMs(allReservedMs)}</b>`)
}

function resetStats(host: HTMLElement): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (const row of rows) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
  }
}

// --- Layout: shortest-column fill ---

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

type Tile = { container: HTMLElement; img: HTMLImageElement }

// Create a tile container around an already-existing <img>. When the
// caller passes the <img> that prepare() was warming, no new network
// request happens — the same element the library fetched to measure is
// the one the user sees. Fall back to a fresh <img> with src=url for
// cases where prepare() returned no element (cache hits, URL-pattern
// shortcut, dimsOnly).
function createTile(place: Placement, img: HTMLImageElement): Tile {
  const container = document.createElement('div')
  container.className = 'item'
  container.style.left = `${place.x}px`
  container.style.top = `${place.y}px`
  container.style.width = `${place.width}px`
  container.style.height = `${place.height}px`
  img.alt = ''
  container.appendChild(img)
  return { container, img }
}

function imgForPrepared(url: string, warmed: HTMLImageElement | null): HTMLImageElement {
  if (warmed !== null) return warmed
  const img = new Image()
  img.src = url
  return img
}

function waitForImage(tile: Tile): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      tile.img.classList.add('loaded')
      tile.container.classList.add('has-image')
      resolve()
    }
    if (tile.img.complete && tile.img.naturalWidth > 0) done()
    else {
      tile.img.addEventListener('load', done, { once: true })
      tile.img.addEventListener('error', done, { once: true })
    }
  })
}

// --- Naive run ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Running…'
  naivePanel.innerHTML = ''
  resetStats(naiveStats)

  const count = getCount()
  const cacheBust = getCacheBust()
  const mode = getMode()
  setMeta(count, cacheBust)
  const urls = buildUrls(count, cacheBust)

  if (mode === 'batch') {
    await runNaiveBatch(urls)
  } else {
    await runNaiveProgressive(urls)
  }

  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Run again'
}

// Progressive: standard browser behavior. Each <img> reserves space
// the moment its own bytes have been decoded enough to know dims.
async function runNaiveProgressive(urls: readonly string[]): Promise<void> {
  const t0 = performance.now()
  const imgs = urls.map(() => {
    const img = document.createElement('img')
    img.alt = ''
    naivePanel.appendChild(img)
    return img
  })
  for (let i = 0; i < urls.length; i++) imgs[i]!.src = urls[i]!

  let firstReservedMs: number | null = null
  const dimTimes: number[] = []
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            const t = performance.now() - t0
            if (firstReservedMs === null) {
              firstReservedMs = t
              setRowValue(naiveStats, 1, `<b>${fmtMs(firstReservedMs)}</b>`)
            }
            dimTimes.push(t)
            resolve()
          }
          if (img.complete && img.naturalWidth > 0) done()
          else {
            img.onload = done
            img.onerror = done
          }
        }),
    ),
  )
  const allReservedMs = performance.now() - t0
  const avgMs = dimTimes.reduce((a, b) => a + b, 0) / dimTimes.length
  fillStats(naiveStats, firstReservedMs ?? allReservedMs, avgMs, allReservedMs)
}

// Batch: load every image off-DOM, wait for all to decode, then
// commit them to the panel in one shot. Until the last image is
// done, the user sees an empty panel — the price of waiting for
// "everything to be ready" without a measurement library.
async function runNaiveBatch(urls: readonly string[]): Promise<void> {
  const t0 = performance.now()
  const imgs = urls.map((u) => {
    const img = new Image()
    img.alt = ''
    img.src = u
    return img
  })
  const dimTimes: number[] = []
  await Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            dimTimes.push(performance.now() - t0)
            resolve()
          }
          if (img.complete && img.naturalWidth > 0) done()
          else {
            img.onload = done
            img.onerror = done
          }
        }),
    ),
  )
  // Now insert into the DOM. Space is reserved at this moment for
  // every image at once.
  for (const img of imgs) naivePanel.appendChild(img)
  const allReservedMs = performance.now() - t0
  const avgMs = dimTimes.reduce((a, b) => a + b, 0) / dimTimes.length
  // First and All reserved are the same in batch — every tile lands
  // at the same instant.
  fillStats(naiveStats, allReservedMs, avgMs, allReservedMs)
}

// --- Measured runs ---

async function runMeasured(): Promise<void> {
  runMeasuredBtn.disabled = true
  runMeasuredBtn.textContent = 'Running…'
  measuredPanel.innerHTML = ''
  measuredPanel.style.height = '0px'
  resetStats(measuredStats)

  const count = getCount()
  const cacheBust = getCacheBust()
  const mode = getMode()
  setMeta(count, cacheBust)
  const urls = buildUrls(count, cacheBust)

  if (mode === 'batch') {
    await runMeasuredBatch(urls)
  } else {
    await runMeasuredProgressive(urls)
  }

  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

async function runMeasuredBatch(urls: readonly string[]): Promise<void> {
  const t0 = performance.now()
  // Track each prepare()'s individual resolve time for the "average
  // dim fetch" stat. Promise.all only gives us the all-done time.
  const dimTimes: number[] = []
  const prepared = await Promise.all(
    urls.map((u) =>
      prepare(u).then((p) => {
        dimTimes.push(performance.now() - t0)
        return p
      }),
    ),
  )

  const panelWidth = measuredPanel.getBoundingClientRect().width
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const { placements, totalHeight } = layoutShortestColumn(aspects, panelWidth)
  measuredPanel.style.height = `${totalHeight}px`

  const tiles: Tile[] = []
  const frag = document.createDocumentFragment()
  for (let i = 0; i < placements.length; i++) {
    const img = imgForPrepared(urls[i]!, getElement(prepared[i]!))
    const tile = createTile(placements[i]!, img)
    frag.appendChild(tile.container)
    tiles.push(tile)
  }
  measuredPanel.appendChild(frag)
  const reservedAt = performance.now() - t0
  const avgDimMs = dimTimes.reduce((a, b) => a + b, 0) / dimTimes.length
  // Report stats once tiles are placed. In batch every tile lands at
  // the same moment so first/all reserved are identical.
  fillStats(measuredStats, reservedAt, avgDimMs, reservedAt)

  await Promise.all(tiles.map((tile) => waitForImage(tile)))
}

async function runMeasuredProgressive(urls: readonly string[]): Promise<void> {
  const t0 = performance.now()
  const panelWidth = measuredPanel.getBoundingClientRect().width
  const colWidth = (panelWidth - GAP * (COLUMNS - 1)) / COLUMNS
  const heights = new Array<number>(COLUMNS).fill(0)

  let firstReservedMs: number | null = null
  let lastReservedMs: number | null = null
  const dimTimes: number[] = []

  await Promise.all(
    urls.map((url) =>
      prepare(url).then((p) => {
        const dimMs = performance.now() - t0
        dimTimes.push(dimMs)

        const aspect = getMeasurement(p).aspectRatio
        const h = colWidth / aspect
        let shortest = 0
        for (let c = 1; c < COLUMNS; c++) {
          if (heights[c]! < heights[shortest]!) shortest = c
        }
        const x = shortest * (colWidth + GAP)
        const y = heights[shortest]!
        heights[shortest] = y + h + GAP
        measuredPanel.style.height = `${Math.max(...heights) - GAP}px`

        const img = imgForPrepared(url, getElement(p))
        const tile = createTile({ x, y, width: colWidth, height: h }, img)
        measuredPanel.appendChild(tile.container)

        const now = performance.now() - t0
        if (firstReservedMs === null) {
          firstReservedMs = now
          setRowValue(measuredStats, 1, `<b>${fmtMs(firstReservedMs)}</b>`)
        }
        lastReservedMs = now
        const avgSoFar = dimTimes.reduce((a, b) => a + b, 0) / dimTimes.length
        setRowValue(measuredStats, 2, `<b>${fmtMs(avgSoFar)}</b>`)
        setRowValue(measuredStats, 3, `<b>${fmtMs(lastReservedMs)}</b>`)

        return waitForImage(tile)
      }),
    ),
  )
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
