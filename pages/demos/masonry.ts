import { prepare, getMeasurement } from '../../src/index.js'
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

function setRowValue(host: HTMLElement, selector: string, html: string): void {
  const b = host.querySelector(`${selector} .value b`)
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

function createTile(place: Placement): { container: HTMLElement; img: HTMLImageElement } {
  const container = document.createElement('div')
  container.className = 'item'
  container.style.left = `${place.x}px`
  container.style.top = `${place.y}px`
  container.style.width = `${place.width}px`
  container.style.height = `${place.height}px`
  const img = document.createElement('img')
  container.appendChild(img)
  return { container, img }
}

function loadTileImage(
  tile: { container: HTMLElement; img: HTMLImageElement },
  url: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      tile.img.classList.add('loaded')
      tile.container.classList.add('has-image')
      resolve()
    }
    if (tile.img.complete && tile.img.naturalWidth > 0) done()
    else {
      tile.img.onload = done
      tile.img.onerror = done
    }
    tile.img.src = url
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
  setMeta(count, cacheBust)
  const urls = buildUrls(count, cacheBust)

  // Click-to-layout timer. Naive: dims, space, and full load all land
  // at the same onload moment per image — nothing reserves space
  // ahead of the bytes.
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
  // Naive: dims and space both arrive per-image as each loads. There's
  // no single "dims known" moment — report the last-image time as the
  // one honest moment where everything is resolved.
  setRowValue(naiveStats, '.row:nth-child(1)', `<b>${fmtMs(totalMs)}</b>`)
  setRowValue(naiveStats, '.row:nth-child(2)', `<b>${fmtMs(totalMs)}</b>`)
  setRowValue(naiveStats, '.row:nth-child(3)', `<b>${fmtMs(totalMs)}</b>`)
  setShifts(naiveStats, monitor.shifts())
  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Run again'
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
  const prepared = await Promise.all(urls.map((u) => prepare(u)))
  const dimsAt = performance.now() - t0

  const panelWidth = measuredPanel.getBoundingClientRect().width
  const aspects = prepared.map((p) => getMeasurement(p).aspectRatio)
  const { placements, totalHeight } = layoutShortestColumn(aspects, panelWidth)
  measuredPanel.style.height = `${totalHeight}px`

  const tiles: Array<{ container: HTMLElement; img: HTMLImageElement }> = []
  const frag = document.createDocumentFragment()
  for (let i = 0; i < placements.length; i++) {
    const tile = createTile(placements[i]!)
    frag.appendChild(tile.container)
    tiles.push(tile)
  }
  measuredPanel.appendChild(frag)
  const reservedAt = performance.now() - t0
  // Report dims + space immediately; images load into already-reserved
  // tiles and the "All tiles loaded" row fills when everything paints.
  setRowValue(measuredStats, '.row:nth-child(1)', `<b>${fmtMs(dimsAt)}</b>`)
  setRowValue(measuredStats, '.row:nth-child(2)', `<b>${fmtMs(reservedAt)}</b>`)

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    tiles.map((tile, i) => {
      const url = getMeasurement(prepared[i]!).blobUrl ?? urls[i]!
      return loadTileImage(tile, url)
    }),
  )
  monitor.stop()
  const loadedAt = performance.now() - t0
  setRowValue(measuredStats, '.row:nth-child(3)', `<b>${fmtMs(loadedAt)}</b>`)
  setShifts(measuredStats, monitor.shifts())
}

async function runMeasuredProgressive(urls: readonly string[]): Promise<void> {
  const t0 = performance.now()
  const panelWidth = measuredPanel.getBoundingClientRect().width
  const colWidth = (panelWidth - GAP * (COLUMNS - 1)) / COLUMNS
  const heights = new Array<number>(COLUMNS).fill(0)

  let firstReservedMs: number | null = null
  let lastReservedMs: number | null = null

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    urls.map((url, idx) =>
      prepare(url).then((p) => {
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

        const tile = createTile({ x, y, width: colWidth, height: h })
        measuredPanel.appendChild(tile.container)

        const now = performance.now() - t0
        if (firstReservedMs === null) {
          firstReservedMs = now
          setRowValue(measuredStats, '.row:nth-child(1)', `<b>${fmtMs(firstReservedMs)}</b>`)
        }
        lastReservedMs = now
        setRowValue(measuredStats, '.row:nth-child(2)', `<b>${fmtMs(lastReservedMs)}</b>`)

        const src = getMeasurement(p).blobUrl ?? url
        return loadTileImage(tile, src)
      }),
    ),
  )
  monitor.stop()
  const loadedAt = performance.now() - t0
  setRowValue(measuredStats, '.row:nth-child(3)', `<b>${fmtMs(loadedAt)}</b>`)
  // Progressive grows the panel at the bottom as each tile lands —
  // that's intentional, not a content-shift. Report 0 shifts because
  // no existing tile moved.
  void monitor.shifts
  setShifts(measuredStats, 0)
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
