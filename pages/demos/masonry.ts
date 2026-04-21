import { prepare, getMeasurement } from '../../src/index.js'
import { packGallery, type GalleryItem } from '../../src/gallery.js'
import {
  newCacheBustToken,
  picsumReachable,
  resolvePhotoUrls,
  PICSUM_PHOTOS,
  type PhotoDescriptor,
} from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveStat = document.getElementById('naiveStat')!
const measuredStat = document.getElementById('measuredStat')!

const PANEL_WIDTH = 460
const ROW_HEIGHT = 130
const GAP = 6

function metric(label: string, value: string, highlight: boolean = false): string {
  return `<span class="metric">${label} <b${highlight ? ' style="color:var(--reflow)"' : ''}>${value}</b></span>`
}

async function renderNaive(urls: readonly string[]): Promise<{ ms: number; shifts: number }> {
  naivePanel.innerHTML = ''
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
  return { ms: performance.now() - t0, shifts: monitor.shifts() }
}

async function renderMeasured(
  urls: readonly string[],
): Promise<{ ms: number; prepareMs: number; shifts: number }> {
  measuredPanel.innerHTML = ''
  const t0 = performance.now()
  const prepared = await Promise.all(urls.map((u) => prepare(u)))
  const prepareMs = performance.now() - t0

  const items: GalleryItem[] = prepared.map((image) => ({ image }))
  const rows = packGallery(items, {
    maxWidth: PANEL_WIDTH,
    targetRowHeight: ROW_HEIGHT,
    gap: GAP,
  })

  const imgs: HTMLImageElement[] = []
  for (const row of rows) {
    const rowEl = document.createElement('div')
    rowEl.className = 'row'
    rowEl.style.height = `${row.height}px`
    for (const p of row.placements) {
      const item = document.createElement('div')
      item.className = 'item framed'
      item.style.left = `${p.x}px`
      item.style.width = `${p.width}px`
      item.style.height = `${p.height}px`
      const img = document.createElement('img')
      item.appendChild(img)
      rowEl.appendChild(item)
      imgs.push(img)
    }
    measuredPanel.appendChild(rowEl)
  }

  const monitor = observeShifts(measuredPanel)
  await Promise.all(
    imgs.map((img, i) => {
      const cachedUrl = getMeasurement(prepared[i]!).blobUrl ?? urls[i]!
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
        img.src = cachedUrl
      })
    }),
  )
  monitor.stop()
  return { ms: performance.now() - t0, prepareMs, shifts: monitor.shifts() }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  naivePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  naiveStat.innerHTML = ''
  measuredStat.innerHTML = ''
  metaEl.textContent = ''

  const useLive = await picsumReachable()
  const cacheBust = newCacheBustToken()
  runButton.textContent = useLive ? 'Loading from picsum…' : 'Generating fallbacks…'
  const resolved = await resolvePhotoUrls(PICSUM_PHOTOS as readonly PhotoDescriptor[], cacheBust, useLive)
  const urls = resolved.map((r) => r.url)

  metaEl.textContent =
    `${PICSUM_PHOTOS.length} photos · ${useLive ? 'picsum.photos (cache-busted — real network transfer)' : 'picsum offline — canvas fallbacks (size comparable, but no network term)'}`

  runButton.textContent = 'Running…'

  const [naive, measured] = await Promise.all([renderNaive(urls), renderMeasured(urls)])

  naiveStat.innerHTML = [
    metric('loaded at', `${naive.ms.toFixed(0)}ms`),
    metric('visible shifts', String(naive.shifts), naive.shifts > 0),
  ].join('')

  measuredStat.innerHTML = [
    metric('frame placed at', `${measured.prepareMs.toFixed(0)}ms`),
    metric('fully loaded at', `${measured.ms.toFixed(0)}ms`),
    metric('visible shifts', String(measured.shifts), measured.shifts > 0),
  ].join('')

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
