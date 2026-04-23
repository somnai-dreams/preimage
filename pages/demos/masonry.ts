import { prepare } from '@somnai-dreams/preimage'
import {
  justifiedRowCursor,
  packJustifiedRows,
  packShortestColumn,
  shortestColumnCursor,
  type Placement,
} from '@somnai-dreams/layout-algebra'
import { newCacheBustToken, photoUrl, takePhotos, PHOTO_COUNT } from './photo-source.js'
import { observeShifts } from './demo-utils.js'
import { fmtMs, setRowValue, resetStats } from './demo-formatting.js'

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
// Target row height for justified-rows layout. Sized so a typical row
// of 3-4 photos reads similar in scale to the 3-column masonry view.
const TARGET_ROW_HEIGHT = 220

type Mode = 'batch' | 'progressive'
type Layout = 'column' | 'rows'

function getCount(): number {
  return Math.min(Number(countSlider.value), PHOTO_COUNT)
}

function getMode(): Mode {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')
  return checked?.value === 'progressive' ? 'progressive' : 'batch'
}

function getLayout(): Layout {
  const checked = document.querySelector<HTMLInputElement>('input[name="layout"]:checked')
  return checked?.value === 'rows' ? 'rows' : 'column'
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
  // If the bytes were already in hand when the tile mounts (warmed
  // <img> from getElement(), or a browser HTTP-cache hit), flag as
  // loaded before DOM insertion so no fade-in transition fires.
  if (img.complete && img.naturalWidth > 0) {
    img.classList.add('loaded')
    container.classList.add('has-image')
  }
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
  const layout = getLayout()
  setMeta(count, cacheBust)
  const urls = buildUrls(count, cacheBust)

  if (mode === 'batch') {
    await runMeasuredBatch(urls, layout)
  } else {
    await runMeasuredProgressive(urls, layout)
  }

  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Run again'
}

async function runMeasuredBatch(urls: readonly string[], layout: Layout): Promise<void> {
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
  const aspects = prepared.map((p) => p.aspectRatio)
  const { placements, totalHeight } =
    layout === 'rows'
      ? packJustifiedRows(aspects, {
          panelWidth,
          targetRowHeight: TARGET_ROW_HEIGHT,
          gap: GAP,
        })
      : packShortestColumn(aspects, {
          columns: COLUMNS,
          gap: GAP,
          panelWidth,
        })
  measuredPanel.style.height = `${totalHeight}px`

  const tiles: Tile[] = []
  const frag = document.createDocumentFragment()
  for (let i = 0; i < placements.length; i++) {
    const img = imgForPrepared(urls[i]!, prepared[i]!.element)
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

async function runMeasuredProgressive(urls: readonly string[], layout: Layout): Promise<void> {
  const t0 = performance.now()
  const panelWidth = measuredPanel.getBoundingClientRect().width

  // Pick the cursor. Shortest-column emits a Placement per add();
  // justified-rows buffers items in an open row and emits batches
  // (one row's worth) when a row fills.
  const column = layout === 'column'
    ? shortestColumnCursor({ columns: COLUMNS, gap: GAP, panelWidth })
    : null
  const rows = layout === 'rows'
    ? justifiedRowCursor({ panelWidth, targetRowHeight: TARGET_ROW_HEIGHT, gap: GAP })
    : null

  // Warmed <img> + URL for each addIndex — the cursor returns
  // placements keyed by addIndex, so we look up render inputs here.
  const urlByIdx: string[] = []
  const warmedByIdx: (HTMLImageElement | null)[] = []
  let addOrder = 0

  const tiles: Tile[] = []
  let firstReservedMs: number | null = null
  let lastReservedMs: number | null = null
  const dimTimes: number[] = []

  function placeAt(idx: number, place: Placement): void {
    const img = imgForPrepared(urlByIdx[idx]!, warmedByIdx[idx]!)
    const tile = createTile(place, img)
    measuredPanel.appendChild(tile.container)
    tiles.push(tile)
  }

  function reportPlacement(): void {
    const now = performance.now() - t0
    if (firstReservedMs === null) {
      firstReservedMs = now
      setRowValue(measuredStats, 1, `<b>${fmtMs(firstReservedMs)}</b>`)
    }
    lastReservedMs = now
    const avg = dimTimes.reduce((a, b) => a + b, 0) / dimTimes.length
    setRowValue(measuredStats, 2, `<b>${fmtMs(avg)}</b>`)
    setRowValue(measuredStats, 3, `<b>${fmtMs(lastReservedMs)}</b>`)
  }

  await Promise.all(
    urls.map((url) =>
      prepare(url).then((p) => {
        dimTimes.push(performance.now() - t0)
        const aspect = p.aspectRatio
        const idx = addOrder++
        urlByIdx[idx] = url
        warmedByIdx[idx] = p.element

        if (column !== null) {
          const place = column.add(aspect)
          measuredPanel.style.height = `${column.totalHeight()}px`
          placeAt(idx, place)
          reportPlacement()
        } else {
          const { closed } = rows!.add(aspect)
          for (const c of closed) placeAt(c.index, c.placement)
          measuredPanel.style.height = `${rows!.totalHeight()}px`
          if (closed.length > 0) reportPlacement()
        }
      }),
    ),
  )

  if (rows !== null) {
    // Flush the trailing row. `justifyLast: false` keeps it at
    // targetRowHeight with whatever whitespace remains — matches
    // Flickr-style "what's newest" trailing strips.
    const trailing = rows.finish(false)
    for (const c of trailing) placeAt(c.index, c.placement)
    measuredPanel.style.height = `${rows.totalHeight()}px`
    if (trailing.length > 0) reportPlacement()
  }

  await Promise.all(tiles.map((tile) => waitForImage(tile)))
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
