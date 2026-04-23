// Instant masonry. No probe-manifest shortcut — this page runs the
// full probe-then-render pipeline on load, the same `prepare()` +
// `PrepareQueue` + virtual tile pool that a real site without a
// build step would use. No Run button, no stats panel, no bench
// furniture. Just the gallery as a production site would render it.
//
// Probe phase: `dimsOnly: true` at concurrency 50, strategy: 'auto'
//   (picks 'range' on any origin that honors it, which GitHub Pages
//   and most static CDNs do). Skeletons appear as placements resolve.
// Render phase: after every probe is in, flip the render flag and
//   attach images to currently-mounted tiles in one pass. Future
//   scroll-triggered mounts attach images immediately.
//
// The point of the demo: if probing 500 images over the network is
// ~300-800 ms on a fast connection, the experience is nearly
// indistinguishable from manifest hydration — skeletons land fast,
// images come in smoothly, no layout shift.

import { PrepareQueue } from '@somnai-dreams/preimage'
import { createVirtualTilePool } from '@somnai-dreams/preimage/virtual'
import {
  estimateFirstScreenCount,
  shortestColumnCursor,
  type Placement,
} from '@somnai-dreams/layout-algebra'
import { cycledUrls } from './photo-source.js'

const COUNT = 500
const GAP = 6

const canvas = document.getElementById('canvas') as HTMLElement
const scrollContainer = document.scrollingElement as HTMLElement

async function run(): Promise<void> {
  const panelWidth = canvas.getBoundingClientRect().width
  const columns = panelWidth >= 900 ? 5 : panelWidth >= 560 ? 3 : 2

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(COUNT, token)

  const packer = shortestColumnCursor({ columns, gap: GAP, panelWidth })
  const placements: Placement[] = []
  const indexUrl: string[] = []

  // Phase-separated rendering. mount places the skeleton only;
  // image bytes start fetching once all probes are in. See the
  // virtual demo for the rationale — probes are ~4 KB, images are
  // ~1 MB, sharing the network pipe starves the probes. Full
  // skeletons first, then images, is faster overall and visually
  // homogeneous throughout the probe phase.
  let renderPhase = false
  const mountedTiles = new Map<number, HTMLElement>()

  function attachImage(idx: number, el: HTMLElement): void {
    if (el.querySelector('img') !== null) return
    const img = new Image()
    img.alt = ''
    img.src = indexUrl[idx]!
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('loaded')
    } else {
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
    }
    el.appendChild(img)
  }

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
      mountedTiles.set(idx, el)
      if (renderPhase) attachImage(idx, el)
    },
    unmount: (idx, el) => {
      const img = el.querySelector('img')
      if (img !== null) img.src = ''
      el.innerHTML = ''
      el.className = 'vtile'
      mountedTiles.delete(idx)
    },
  })

  // rAF-batched render: coalesce per-probe DOM writes into one pass
  // per frame. Without this, 50 probe resolves arriving in one tick
  // do 50 setPlacements calls; the pool still handles that fine, but
  // rAF keeps the scheduling honest.
  let renderPending = false
  function scheduleRender(): void {
    if (renderPending) return
    renderPending = true
    requestAnimationFrame(() => {
      renderPending = false
      canvas.style.height = `${packer.totalHeight()}px`
      pool.setPlacements(placements)
    })
  }

  const queue = new PrepareQueue({ concurrency: 50 })

  const placePromises = urls.map((url) =>
    queue.enqueue(url, { dimsOnly: true, strategy: 'auto' }).then((prepared) => {
      placements.push(packer.add(prepared.aspectRatio))
      indexUrl.push(url)
      scheduleRender()
    }),
  )

  // First-screen prioritization: probes for the tiles that will land
  // in the first viewport jump the queue, so their skeletons appear
  // first and their images start loading first when the render phase
  // flips.
  const firstK = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth,
    viewportHeight: window.innerHeight,
    gap: GAP,
    columns,
  })
  queue.boostMany(urls.slice(0, firstK))

  await Promise.all(placePromises)

  // Final placements flush + render phase flip.
  canvas.style.height = `${packer.totalHeight()}px`
  pool.setPlacements(placements)
  renderPhase = true
  for (const [idx, el] of mountedTiles) attachImage(idx, el)
}

void run()
