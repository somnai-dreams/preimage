import { PrepareQueue } from '@somnai-dreams/preimage'
import {
  packJustifiedRows,
  packShortestColumn,
  type Placement,
} from '@somnai-dreams/layout-algebra'
import { newCacheBustToken, photoUrl, takePhotos, PHOTO_COUNT } from './photo-source.js'
import { getConcurrency, getStrategy } from './nav-concurrency.js'
import { fmtMs, resetStats, setRowValue } from './demo-formatting.js'

const countSlider = document.getElementById('countSlider') as HTMLInputElement
const countVal = document.getElementById('countVal')!
const columnsSlider = document.getElementById('columnsSlider') as HTMLInputElement
const columnsVal = document.getElementById('columnsVal')!
const rowHeightSlider = document.getElementById('rowHeightSlider') as HTMLInputElement
const rowHeightVal = document.getElementById('rowHeightVal')!
const metaEl = document.getElementById('meta')!
const shortestPanel = document.getElementById('shortest')!
const justifiedPanel = document.getElementById('justified')!
const shortestStats = document.getElementById('shortestStats')!
const justifiedStats = document.getElementById('justifiedStats')!
const runBtn = document.getElementById('runPacking') as HTMLButtonElement

const GAP = 6

type PackedLayout = {
  placements: Placement[]
  totalHeight: number
}

function getCount(): number {
  return Math.min(Number(countSlider.value), PHOTO_COUNT)
}

function getColumns(): number {
  return Number(columnsSlider.value)
}

function getTargetRowHeight(): number {
  return Number(rowHeightSlider.value)
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

function buildUrls(count: number, cacheBust: string | null): string[] {
  return takePhotos(count).map((p) => photoUrl(p, cacheBust))
}

function setMeta(count: number, cacheBust: string | null, message: string): void {
  metaEl.textContent =
    `${count} local photos · ${message} · ` +
    (cacheBust === null
      ? 'HTTP cache allowed'
      : 'cache-busted — each run fetches fresh')
}

function fmtPx(n: number): string {
  return `${Math.round(n).toLocaleString()}px`
}

function clearPanels(): void {
  for (const panel of [shortestPanel, justifiedPanel]) {
    panel.innerHTML = ''
    panel.style.height = '320px'
  }
  resetStats(shortestStats)
  resetStats(justifiedStats)
}

function setBothStats(row: number, html: string): void {
  setRowValue(shortestStats, row, html)
  setRowValue(justifiedStats, row, html)
}

async function probeAspects(urls: readonly string[], cacheBust: string | null): Promise<{ aspects: number[]; elapsedMs: number }> {
  const queue = new PrepareQueue({ concurrency: getConcurrency() })
  const strategy = getStrategy()
  const t0 = performance.now()
  let completed = 0
  setBothStats(1, `<b>0 / ${urls.length}</b>`)

  const aspects = await Promise.all(
    urls.map((url) =>
      queue.enqueue(url, { dimsOnly: true, strategy }).then((prepared) => {
        completed++
        setBothStats(1, `<b>${completed} / ${urls.length}</b>`)
        setMeta(urls.length, cacheBust, `probing ${completed} / ${urls.length}`)
        return prepared.aspectRatio
      }),
    ),
  )

  return { aspects, elapsedMs: performance.now() - t0 }
}

function renderPacked(container: HTMLElement, urls: readonly string[], layout: PackedLayout): void {
  container.innerHTML = ''
  container.style.height = `${layout.totalHeight}px`

  const fragment = document.createDocumentFragment()
  for (let i = 0; i < layout.placements.length; i++) {
    const place = layout.placements[i]!
    const tile = document.createElement('div')
    tile.className = 'item'
    tile.style.left = `${place.x}px`
    tile.style.top = `${place.y}px`
    tile.style.width = `${place.width}px`
    tile.style.height = `${place.height}px`

    const img = new Image()
    img.alt = ''
    img.draggable = false
    const done = (): void => {
      img.classList.add('loaded')
      tile.className = 'item has-image'
    }
    img.addEventListener('load', done, { once: true })
    img.addEventListener('error', done, { once: true })
    img.src = urls[i]!
    if (img.complete && img.naturalWidth > 0) done()

    tile.appendChild(img)
    fragment.appendChild(tile)
  }
  container.appendChild(fragment)
}

function reportLayout(
  stats: HTMLElement,
  dimsMs: number,
  packMs: number,
  totalHeight: number,
  tileCount: number,
): void {
  setRowValue(stats, 1, `<b>${fmtMs(dimsMs)}</b>`)
  setRowValue(stats, 2, `<b>${fmtMs(packMs)}</b>`)
  setRowValue(stats, 3, `<b>${fmtPx(totalHeight)}</b>`)
  setRowValue(stats, 4, `<b>${tileCount}</b>`)
}

async function runPacking(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Packing...'
  clearPanels()

  const count = getCount()
  const cacheBust = getCacheBust()
  const columns = getColumns()
  const targetRowHeight = getTargetRowHeight()
  const urls = buildUrls(count, cacheBust)
  setMeta(count, cacheBust, 'probing dimensions')

  const { aspects, elapsedMs: dimsMs } = await probeAspects(urls, cacheBust)

  const shortestWidth = shortestPanel.getBoundingClientRect().width
  const justifiedWidth = justifiedPanel.getBoundingClientRect().width

  const shortestStart = performance.now()
  const shortest = packShortestColumn(aspects, {
    columns,
    gap: GAP,
    panelWidth: shortestWidth,
  })
  const shortestMs = performance.now() - shortestStart

  const justifiedStart = performance.now()
  const justified = packJustifiedRows(aspects, {
    panelWidth: justifiedWidth,
    targetRowHeight,
    gap: GAP,
  })
  const justifiedMs = performance.now() - justifiedStart

  renderPacked(shortestPanel, urls, shortest)
  renderPacked(justifiedPanel, urls, justified)
  reportLayout(shortestStats, dimsMs, shortestMs, shortest.totalHeight, shortest.placements.length)
  reportLayout(justifiedStats, dimsMs, justifiedMs, justified.totalHeight, justified.placements.length)
  setMeta(count, cacheBust, `${columns} columns · ${targetRowHeight}px rows`)

  runBtn.disabled = false
  runBtn.textContent = 'Pack again'
}

function updateLabels(): void {
  countSlider.max = String(PHOTO_COUNT)
  countVal.textContent = countSlider.value
  columnsVal.textContent = columnsSlider.value
  rowHeightVal.textContent = `${rowHeightSlider.value}px`
}

countSlider.addEventListener('input', updateLabels)
columnsSlider.addEventListener('input', updateLabels)
rowHeightSlider.addEventListener('input', updateLabels)
runBtn.addEventListener('click', () => {
  void runPacking()
})

updateLabels()
