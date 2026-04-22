import { prepare, getMeasurement } from '@somnai-dreams/preimage'

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

let naiveCount = 0
let measuredCount = 0
let naiveResized = 0 // imgs whose measured width changed post-insert
let measuredResized = 0

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
  naiveResized = 0
  measuredResized = 0
  renderStats()
}

function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

function setShiftRow(host: HTMLElement, count: number, total: number): void {
  const row = host.querySelector<HTMLElement>('.row.shift')
  if (row === null) return
  row.classList.toggle('has-shifts', count > 0)
  row.querySelector('.value b')!.innerHTML = `${count} / ${total}`
}

function renderStats(): void {
  setRowValue(naiveStats, 1, `<b>${naiveCount}</b>`)
  setShiftRow(naiveStats, naiveResized, naiveCount)
  setRowValue(measuredStats, 1, `<b>${measuredCount}</b>`)
  setShiftRow(measuredStats, measuredResized, measuredCount)
}

// Watch an <img>'s width from the moment of insert. If the rendered
// width changes later (because naturalWidth arrived and the browser
// resolved the missing dimension), count it as a "resized after
// insert" event — the concrete signal the user sees as text shifting
// horizontally next to the image.
function watchForResize(img: HTMLImageElement, onResize: () => void): void {
  // Double-rAF so we read layout after the browser has committed the
  // initial render. Then record the starting width and poll.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const initial = img.getBoundingClientRect().width
      if (img.complete && img.naturalWidth > 0 && initial > 0) {
        // Already fully sized — no resize will happen.
        return
      }
      let done = false
      const check = (): void => {
        if (done) return
        const current = img.getBoundingClientRect().width
        if (Math.abs(current - initial) > 0.5) {
          done = true
          onResize()
          return
        }
        if (img.complete && img.naturalWidth > 0) {
          done = true
          const final = img.getBoundingClientRect().width
          if (Math.abs(final - initial) > 0.5) onResize()
          return
        }
        setTimeout(check, 16)
      }
      check()
    })
  })
}

function addNaive(file: File): void {
  // Stock browser behaviour: <img height=100> with no width. The
  // browser renders the box at 0 × 100 until the bytes decode; then
  // it resolves width from naturalWidth. That's the visible shift.
  const url = URL.createObjectURL(file)
  const img = document.createElement('img')
  img.alt = ''
  img.height = IMAGE_HEIGHT
  img.src = url
  naivePanel.appendChild(img)
  naivePanel.appendChild(document.createTextNode(' '))
  naiveCount++
  watchForResize(img, () => {
    naiveResized++
    renderStats()
  })
  renderStats()
}

async function addMeasured(file: File): Promise<void> {
  // Byte-probe path. prepare(Blob) slices the first 4KB and parses
  // the format header. width + aspectRatio are written into the
  // <img> element's attrs before insert, so the browser reserves
  // the correct box from the first frame.
  const prepared = await prepare(file)
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
  watchForResize(img, () => {
    measuredResized++
    renderStats()
  })
  renderStats()
}

async function handleFiles(files: FileList): Promise<void> {
  const incoming = Array.from(files).filter((f) => f.type.startsWith('image/'))
  if (incoming.length === 0) return
  metaEl.textContent = `processing ${incoming.length} file${incoming.length === 1 ? '' : 's'}…`
  // Fire both panels in parallel.
  for (const f of incoming) addNaive(f)
  await Promise.all(incoming.map((f) => addMeasured(f)))
  metaEl.textContent = `${measuredCount} image${measuredCount === 1 ? '' : 's'} dropped · drop more to keep comparing`
}

// --- Event wiring ---

dropArea.addEventListener('click', (e) => {
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

initFlows()
