import { prepare, getMeasurement } from '../../src/index.js'
import { packGallery, type GalleryItem } from '../../src/gallery.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const genInfo = document.getElementById('genInfo')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveStat = document.getElementById('naiveStat')!
const measuredStat = document.getElementById('measuredStat')!

const COUNT = 24
const PANEL_WIDTH = 520
const ROW_HEIGHT = 140
const GAP = 6

// A spread of aspect ratios so the masonry layout has real variation.
const ASPECTS: Array<[number, number]> = [
  [1600, 900], [1200, 900], [800, 1200], [1000, 1000],
  [1800, 1200], [900, 1600], [1400, 700], [1000, 1400],
]

async function generateImage(w: number, h: number, hue: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, `hsl(${hue} 70% 55%)`)
  grad.addColorStop(1, `hsl(${(hue + 35) % 360} 70% 35%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  // Add a bit of content so PNG compression doesn't shrink these to nothing.
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `hsla(${(hue + i * 11) % 360}, 70%, 60%, 0.35)`
    ctx.beginPath()
    ctx.arc(Math.random() * w, Math.random() * h, 30 + Math.random() * 140, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = `${Math.round(Math.min(w, h) / 6)}px system-ui`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${w}×${h}`, w / 2, h / 2)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b !== null ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Generating…'
  naivePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  naivePanel.style.minHeight = '520px'
  measuredPanel.style.minHeight = '520px'
  naiveStat.textContent = 'generating 24 images…'
  measuredStat.textContent = 'generating 24 images…'
  genInfo.textContent = ''

  const blobs: Blob[] = []
  for (let i = 0; i < COUNT; i++) {
    const [w, h] = ASPECTS[i % ASPECTS.length]!
    blobs.push(await generateImage(w, h, (i * 43) % 360))
  }
  const totalMB = blobs.reduce((a, b) => a + b.size, 0) / 1024 / 1024
  genInfo.textContent = `${COUNT} PNG Blobs · ${totalMB.toFixed(1)} MB total`

  runButton.textContent = 'Rendering…'

  // --- Naive path: append <img> with no declared dimensions. ---
  // Stagger the src assignments slightly so the browser decodes arrive out
  // of order — closer to how real disk-cold fetches behave over a network.
  const naiveStart = performance.now()
  const naiveImgs: HTMLImageElement[] = []
  for (let i = 0; i < COUNT; i++) {
    const img = document.createElement('img')
    img.alt = ''
    naivePanel.appendChild(img)
    naiveImgs.push(img)
  }
  const naiveShiftCount = { n: 0, lastHeight: naivePanel.getBoundingClientRect().height }
  const naiveObserver = new ResizeObserver(() => {
    const h = naivePanel.getBoundingClientRect().height
    if (Math.abs(h - naiveShiftCount.lastHeight) > 0.5) {
      naiveShiftCount.n++
      naiveShiftCount.lastHeight = h
    }
  })
  naiveObserver.observe(naivePanel)

  for (let i = 0; i < COUNT; i++) {
    await new Promise<void>((r) => setTimeout(r, 30 + Math.random() * 70))
    const url = URL.createObjectURL(blobs[i]!)
    naiveImgs[i]!.src = url
  }
  await Promise.all(
    naiveImgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) resolve()
          else img.onload = () => resolve()
        }),
    ),
  )
  const naiveEnd = performance.now()
  naiveObserver.disconnect()
  naiveStat.textContent = `final height in ${(naiveEnd - naiveStart).toFixed(0)}ms · ${naiveShiftCount.n} layout shifts during load`

  // --- Preimage path: await all prepare(), then render at known dims. ---
  const measuredStart = performance.now()
  const prepared = await Promise.all(blobs.map((b) => prepare(b)))
  const measuredAfterPrepare = performance.now()
  const items: GalleryItem[] = prepared.map((image) => ({ image }))
  const rows = packGallery(items, {
    maxWidth: PANEL_WIDTH - 24,
    targetRowHeight: ROW_HEIGHT,
    gap: GAP,
  })
  measuredPanel.innerHTML = ''
  measuredPanel.style.minHeight = ''
  for (const row of rows) {
    const rowEl = document.createElement('div')
    rowEl.className = 'row'
    rowEl.style.height = `${row.height}px`
    for (const p of row.placements) {
      const url = getMeasurement(prepared[p.itemIndex]!).blobUrl ?? ''
      const item = document.createElement('div')
      item.className = 'item'
      item.style.left = `${p.x}px`
      item.style.width = `${p.width}px`
      item.style.height = `${p.height}px`
      const img = document.createElement('img')
      img.src = url
      img.loading = 'lazy'
      item.appendChild(img)
      rowEl.appendChild(item)
    }
    measuredPanel.appendChild(rowEl)
  }
  const measuredEnd = performance.now()
  measuredStat.textContent = `measured ${COUNT} images in ${(measuredAfterPrepare - measuredStart).toFixed(0)}ms · rendered in ${(measuredEnd - measuredAfterPrepare).toFixed(0)}ms · 0 layout shifts`

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
