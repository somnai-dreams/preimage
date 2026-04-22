import { prepare, getMeasurement, getElement, clearCache } from '@somnai-dreams/preimage'
import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'
import { packShortestColumn } from '@somnai-dreams/layout-algebra'
import { PHOTOS, photoUrl, newCacheBustToken, type Photo } from './photo-source.js'
import manifest from '../assets/demos/photos-manifest.json'

const coldGrid = document.getElementById('coldGrid')!
const hydratedGrid = document.getElementById('hydratedGrid')!
const coldStats = document.getElementById('coldStats')!
const hydratedStats = document.getElementById('hydratedStats')!
const runColdBtn = document.getElementById('runCold') as HTMLButtonElement
const runHydratedBtn = document.getElementById('runHydrated') as HTMLButtonElement
const manifestPreview = document.getElementById('manifestPreview')!
const manifestSize = document.getElementById('manifestSize')!

const COLUMNS = 3
const GAP = 4

// --- Stat helpers ---

function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (ms < 10) return `${ms.toFixed(2)}ms`
  return `${ms.toFixed(1)}ms`
}

function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function resetStats(host: HTMLElement): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (const row of rows) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
  }
}

// --- Manifest preview (top of page) ---

const manifestEntries = Object.entries(manifest) as Array<[string, { width: number; height: number }]>
manifestSize.textContent = String(manifestEntries.length)
manifestPreview.innerHTML = manifestEntries
  .slice(0, 6)
  .map(([src, { width, height }]) => `<b>${src}</b>: { width: ${width}, height: ${height} }`)
  .join('<br>') + (manifestEntries.length > 6 ? `<br>… and ${manifestEntries.length - 6} more` : '')

// Turn a demo URL like `./assets/demos/photos/01.png?v=123` into the
// manifest key `/assets/demos/photos/01.png` by stripping the query
// and making the path absolute relative to the page. Used to look up
// dims during hydration.
function manifestKeyFor(photo: Photo): string {
  return `/assets/demos/photos/${photo.file}`
}

// --- Shared layout + render ---

function renderGrid(
  container: HTMLElement,
  preparedList: Array<{ url: string; width: number; height: number; element: HTMLImageElement | null }>,
): void {
  container.innerHTML = ''
  const panelWidth = container.getBoundingClientRect().width - GAP * 2
  const aspects = preparedList.map((p) => p.width / p.height)
  const { placements, totalHeight } = packShortestColumn(aspects, {
    columns: COLUMNS,
    gap: GAP,
    panelWidth,
  })
  container.style.height = `${totalHeight + GAP * 2}px`

  const frag = document.createDocumentFragment()
  for (let i = 0; i < placements.length; i++) {
    const place = placements[i]!
    const p = preparedList[i]!
    const tile = document.createElement('div')
    tile.className = 'item'
    tile.style.left = `${place.x + GAP}px`
    tile.style.top = `${place.y + GAP}px`
    tile.style.width = `${place.width}px`
    tile.style.height = `${place.height}px`

    // Reuse the warmed <img> from prepare() when we have one; for the
    // hydrated path we never did a prepare fetch, so mint a fresh
    // <img>. Either way the browser HTTP cache means the actual
    // network request happens once per image URL in the session.
    const img = p.element ?? new Image()
    img.alt = ''
    if (p.element === null) img.src = p.url
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
    if (img.complete && img.naturalWidth > 0) img.classList.add('loaded')
    tile.appendChild(img)
    frag.appendChild(tile)
  }
  container.appendChild(frag)
}

// --- Cold run: no hydration, prepare() probes each URL over the network ---

async function runCold(): Promise<void> {
  runColdBtn.disabled = true
  runColdBtn.textContent = 'Running…'
  resetStats(coldStats)
  coldGrid.innerHTML = ''
  coldGrid.style.height = '300px'

  // Clear library measurement cache. Cache-bust URLs so the browser
  // HTTP cache can't collapse a second run — each Run issues fresh
  // GETs that actually go to the server.
  clearCache()
  const token = newCacheBustToken()
  const urls = PHOTOS.map((p) => photoUrl(p, token))

  const t0 = performance.now()
  let firstMs: number | null = null
  const prepared = await Promise.all(
    urls.map((url) =>
      prepare(url).then((p) => {
        if (firstMs === null) {
          firstMs = performance.now() - t0
          setRowValue(coldStats, 2, `<b>${fmtMs(firstMs)}</b>`)
        }
        const m = getMeasurement(p)
        return {
          url,
          width: m.displayWidth,
          height: m.displayHeight,
          element: getElement(p),
        }
      }),
    ),
  )
  const layoutMs = performance.now() - t0

  setRowValue(coldStats, 1, `<b>${urls.length}</b>`)
  setRowValue(coldStats, 3, `<b>${fmtMs(layoutMs)}</b>`)
  renderGrid(coldGrid, prepared)

  runColdBtn.disabled = false
  runColdBtn.textContent = 'Run again'
}

// --- Hydrated run: recordKnownMeasurement from manifest, prepare() is sync ---

async function runHydrated(): Promise<void> {
  runHydratedBtn.disabled = true
  runHydratedBtn.textContent = 'Running…'
  resetStats(hydratedStats)
  hydratedGrid.innerHTML = ''
  hydratedGrid.style.height = '300px'

  clearCache()
  const token = newCacheBustToken()
  const urls = PHOTOS.map((p) => photoUrl(p, token))

  // Hydrate the measurement cache for the URLs we're about to
  // prepare(). The manifest key is the un-busted path; we record
  // the ephemeral URL so normalizeSrc matches on lookup.
  const tHydrate0 = performance.now()
  for (let i = 0; i < PHOTOS.length; i++) {
    const dims = manifest[manifestKeyFor(PHOTOS[i]!) as keyof typeof manifest]
    if (dims !== undefined) {
      recordKnownMeasurement(urls[i]!, dims.width, dims.height)
    }
  }
  const hydrateMs = performance.now() - tHydrate0
  setRowValue(hydratedStats, 2, `<b>${fmtMs(hydrateMs)}</b>`)

  // prepare() now sees a cached measurement for every URL and
  // resolves synchronously. No <img> is created by the library,
  // no polling, no network round-trip for dims.
  const t0 = performance.now()
  const prepared = await Promise.all(
    urls.map((url) =>
      prepare(url).then((p) => {
        const m = getMeasurement(p)
        return {
          url,
          width: m.displayWidth,
          height: m.displayHeight,
          element: getElement(p),
        }
      }),
    ),
  )
  const layoutMs = performance.now() - t0

  setRowValue(hydratedStats, 1, `<b>0</b>`)
  setRowValue(hydratedStats, 3, `<b>${fmtMs(layoutMs)}</b>`)
  renderGrid(hydratedGrid, prepared)

  runHydratedBtn.disabled = false
  runHydratedBtn.textContent = 'Run again'
}

// --- Controls ---

runColdBtn.addEventListener('click', () => {
  void runCold()
})
runHydratedBtn.addEventListener('click', () => {
  void runHydrated()
})
