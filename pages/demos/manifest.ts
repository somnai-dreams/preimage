import { prepare, clearCache } from '@somnai-dreams/preimage'
import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'
import { packShortestColumn } from '@somnai-dreams/layout-algebra'
import { newCacheBustToken, photosManifest } from './photo-source.js'
import { getStrategy } from './nav-concurrency.js'
import { fmtMs, setRowValue, resetStats } from './demo-formatting.js'

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

// --- Source of truth is the manifest itself ---
//
// Every URL the demo uses comes from iterating manifest entries. The
// manifest keys are root-absolute server paths (e.g. `/assets/demos/
// photos/01.png`); to keep GitHub Pages-friendly relative resolution,
// we prepend `.` to turn them into `./assets/...` before fetching,
// and append `?v=<token>` to defeat HTTP cache between runs.

const manifest = photosManifest()
const manifestEntries = Object.entries(manifest)
manifestSize.textContent = String(manifestEntries.length)
manifestPreview.innerHTML = manifestEntries
  .slice(0, 6)
  .map(([src, { width, height }]) => `<b>${src}</b>: { width: ${width}, height: ${height} }`)
  .join('<br>') + (manifestEntries.length > 6 ? `<br>… and ${manifestEntries.length - 6} more` : '')

type HydratableEntry = {
  manifestKey: string
  url: string
  width: number
  height: number
}

function freshEntries(token: string): HydratableEntry[] {
  return manifestEntries.map(([manifestKey, dims]) => ({
    manifestKey,
    url: `.${manifestKey}?v=${token}`,
    width: dims.width,
    height: dims.height,
  }))
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
    if (img.complete && img.naturalWidth > 0) img.classList.add('loaded')
    else img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
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
  const entries = freshEntries(newCacheBustToken())

  const t0 = performance.now()
  const strategy = getStrategy()
  let firstMs: number | null = null
  const prepared = await Promise.all(
    entries.map((e) =>
      prepare(e.url, { strategy }).then((p) => {
        if (firstMs === null) {
          firstMs = performance.now() - t0
          setRowValue(coldStats, 2, `<b>${fmtMs(firstMs)}</b>`)
        }
        return {
          url: e.url,
          width: p.width,
          height: p.height,
          element: p.element,
        }
      }),
    ),
  )
  const layoutMs = performance.now() - t0

  setRowValue(coldStats, 1, `<b>${entries.length}</b>`)
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
  const entries = freshEntries(newCacheBustToken())

  // Hydrate the measurement cache for every URL we're about to
  // prepare(). `entries` zips manifest dims with the cache-busted
  // URL so there's no lookup table that could go stale.
  const tHydrate0 = performance.now()
  for (const e of entries) {
    recordKnownMeasurement(e.url, e.width, e.height)
  }
  const hydrateMs = performance.now() - tHydrate0
  setRowValue(hydratedStats, 2, `<b>${fmtMs(hydrateMs)}</b>`)

  // prepare() now sees a cached measurement for every URL and
  // resolves synchronously. No <img> is created by the library,
  // no polling, no network round-trip for dims.
  const t0 = performance.now()
  const prepared = await Promise.all(
    entries.map((e) =>
      prepare(e.url).then((p) => ({
        url: e.url,
        width: p.width,
        height: p.height,
        element: p.element,
      })),
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
