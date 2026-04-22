import { prepare, getMeasurement } from '../../src/index.js'

const dropArea = document.getElementById('dropArea')!
const pickBtn = document.getElementById('pickBtn') as HTMLButtonElement
const picker = document.getElementById('picker') as HTMLInputElement
const metaEl = document.getElementById('meta')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveStats = document.getElementById('naiveStats')!
const measuredStats = document.getElementById('measuredStats')!

const IMAGE_HEIGHT = 100
const SAMPLE_TEXT =
  "Here's what came up in today's lineup: we ran through a long list of candidates, drafted headlines for each, and then drop the selects in so everyone can see which made the cut. Placeholder text trailing around each image so you can see how surrounding content reacts."

// Running totals for stats.
let naiveCount = 0
let measuredCount = 0
let naiveTimingTotal = 0 // per-image width-known time (from drop to onload)
let measuredTimingTotal = 0 // per-image prepare(blob) time

function initFlows(): void {
  for (const panel of [naivePanel, measuredPanel]) {
    panel.innerHTML = ''
    const span = document.createElement('span')
    span.className = 'leading-text'
    span.textContent = SAMPLE_TEXT + ' '
    panel.appendChild(span)
  }
  naiveCount = 0
  measuredCount = 0
  naiveTimingTotal = 0
  measuredTimingTotal = 0
  renderStats()
}

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(1)}ms`
}

function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function renderStats(): void {
  setRowValue(naiveStats, 1, `<b>${naiveCount}</b>`)
  setRowValue(
    naiveStats,
    2,
    naiveCount === 0 ? '<b>—</b>' : `<b>${fmtMs(naiveTimingTotal / naiveCount)}</b>`,
  )

  setRowValue(measuredStats, 1, `<b>${measuredCount}</b>`)
  setRowValue(
    measuredStats,
    2,
    measuredCount === 0
      ? '<b>—</b>'
      : `<b>${fmtMs(measuredTimingTotal / measuredCount)}</b>`,
  )
}

async function addNaive(file: File): Promise<void> {
  // Stock browser behaviour: set src on an <img> with only a height.
  // Width becomes known at onload (full decode). Measure how long
  // that takes — it's what the browser inherently costs you.
  const url = URL.createObjectURL(file)
  const img = document.createElement('img')
  img.alt = ''
  img.height = IMAGE_HEIGHT
  img.src = url
  naivePanel.appendChild(img)
  naivePanel.appendChild(document.createTextNode(' '))
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const done = (): void => resolve()
    if (img.complete && img.naturalWidth > 0) done()
    else {
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
    }
  })
  const widthKnownMs = performance.now() - t0
  naiveCount++
  naiveTimingTotal += widthKnownMs
  renderStats()
}

async function addMeasured(file: File): Promise<void> {
  // Byte-probe path. prepare(Blob) slices the first 4KB and parses
  // the format header — takes ~5ms regardless of file size. We now
  // know width + height; write both into the <img> before inserting
  // so the browser reserves the correct box from the first frame.
  const t0 = performance.now()
  const prepared = await prepare(file)
  const prepareMs = performance.now() - t0
  const m = getMeasurement(prepared)
  const displayWidth = m.aspectRatio * IMAGE_HEIGHT
  const img = document.createElement('img')
  img.alt = ''
  img.width = Math.round(displayWidth)
  img.height = IMAGE_HEIGHT
  img.src = m.blobUrl ?? URL.createObjectURL(file)
  measuredPanel.appendChild(img)
  measuredPanel.appendChild(document.createTextNode(' '))
  measuredCount++
  measuredTimingTotal += prepareMs
  renderStats()
}

async function handleFiles(files: FileList): Promise<void> {
  const incoming = Array.from(files).filter((f) => f.type.startsWith('image/'))
  if (incoming.length === 0) return
  metaEl.textContent = `processing ${incoming.length} file${incoming.length === 1 ? '' : 's'}…`
  // Fire both panels in parallel so each measures its own latency
  // against roughly the same page state.
  await Promise.all([
    ...incoming.map((f) => addNaive(f)),
    ...incoming.map((f) => addMeasured(f)),
  ])
  metaEl.textContent = `${measuredCount} image${measuredCount === 1 ? '' : 's'} dropped · drop more to keep comparing`
}

// --- Event wiring ---

dropArea.addEventListener('click', (e) => {
  // Avoid double-picking when the button inside is clicked.
  if ((e.target as HTMLElement).tagName !== 'BUTTON') picker.click()
})
pickBtn.addEventListener('click', () => picker.click())
picker.addEventListener('change', () => {
  if (picker.files !== null) void handleFiles(picker.files)
  picker.value = ''
})
dropArea.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropArea.classList.add('dragover')
})
dropArea.addEventListener('dragleave', () => {
  dropArea.classList.remove('dragover')
})
dropArea.addEventListener('drop', (e) => {
  e.preventDefault()
  dropArea.classList.remove('dragover')
  if (e.dataTransfer?.files !== undefined) void handleFiles(e.dataTransfer.files)
})

// Reset the panels & stats if the user clicks the drop area with no
// files (acts as a nudge and keeps things predictable between demos).
initFlows()
