// Instant masonry. No probe phase, no Run button, no stats. Dims
// come from the build-time manifest via recordKnownMeasurement — the
// packer runs synchronously, all 500 skeletons are placed before the
// first paint, and the DOM-recycling pool loads images only for tiles
// that enter the viewport as the user scrolls.
//
// This is the "what does it look like on a real website" shape. If
// you can ship the manifest (static gallery, CMS with build step,
// AI-image-gen origin that emits Preimage-* headers), this is the
// ceiling: layout is done before anything fetches.

import { preparedFromMeasurement } from '@somnai-dreams/preimage'
import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'
import { createVirtualTilePool } from '@somnai-dreams/preimage/virtual'
import { shortestColumnCursor, type Placement } from '@somnai-dreams/layout-algebra'
import { photosManifest } from './photo-source.js'

const COUNT = 500

const canvas = document.getElementById('canvas') as HTMLElement
const scrollContainer = document.scrollingElement as HTMLElement

function run(): void {
  const panelWidth = canvas.getBoundingClientRect().width
  // Five columns reads well on desktop; if the viewport is narrow,
  // drop to three. No media query needed — we pack once at load and
  // again on resize (below).
  const columns = panelWidth >= 900 ? 5 : panelWidth >= 560 ? 3 : 2
  const gap = 6

  const manifestEntries = Object.entries(photosManifest())
  const packer = shortestColumnCursor({ columns, gap, panelWidth })

  const placements: Placement[] = new Array(COUNT)
  const indexUrl: string[] = new Array(COUNT)

  // Hydrate dims + compute placements synchronously. This entire
  // loop runs in a few ms — the cost is one packer.add() per tile.
  // No network, no DOM writes yet.
  for (let i = 0; i < COUNT; i++) {
    const [manifestKey, dims] = manifestEntries[i % manifestEntries.length]!
    const url = `.${manifestKey}`
    // recordKnownMeasurement is idempotent; repeat entries for cycled
    // photos are fine (and browsers HTTP-cache them on render).
    const measurement = recordKnownMeasurement(url, dims.width, dims.height)
    // preparedFromMeasurement returns a full PreparedImage; we only
    // need the aspect ratio, but hydrating the cache means any other
    // library caller that later passes the same URL to prepare() gets
    // a synchronous resolve.
    void preparedFromMeasurement(measurement, 'manifest')
    placements[i] = packer.add(dims.width / dims.height)
    indexUrl[i] = url
  }

  canvas.style.height = `${packer.totalHeight()}px`

  const pool = createVirtualTilePool({
    scrollContainer,
    contentContainer: canvas,
    overscan: { ahead: 600, behind: 200 },
    mount: (idx, el, place) => {
      el.className = 'vtile'
      el.style.left = `${place.x}px`
      el.style.top = `${place.y}px`
      el.style.width = `${place.width}px`
      el.style.height = `${place.height}px`

      const img = new Image()
      img.alt = ''
      img.src = indexUrl[idx]!
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('loaded')
      } else {
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
      }
      el.appendChild(img)
    },
    unmount: (_idx, el) => {
      // Cancel the in-flight image fetch so a fast scroll-through
      // doesn't leave dozens of abandoned requests in the pipeline.
      const img = el.querySelector('img')
      if (img !== null) img.src = ''
      el.innerHTML = ''
      el.className = 'vtile'
    },
  })
  pool.setPlacements(placements)
}

run()
