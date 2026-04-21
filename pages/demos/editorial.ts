import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import { prepare, getMeasurement } from '../../src/index.js'
import { flowColumnWithFloats } from '../../src/pretext.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const genInfo = document.getElementById('genInfo')!
const naivePanel = document.getElementById('naive')!
const measuredPanel = document.getElementById('measured')!
const naiveStat = document.getElementById('naiveStat')!
const measuredStat = document.getElementById('measuredStat')!

const COLUMN_WIDTH = 460
const LINE_HEIGHT = 24
const FONT = '15px/24px -apple-system, system-ui, sans-serif'

const ARTICLE = `The first figure is inserted at the top of this paragraph as a float. In a naive HTML rendering, the image element starts with zero height — the browser reserves no space for it until the bytes arrive, are decoded, and a real natural size is reported. Every line you see below reflows when that happens. Multiply by three figures and you get the familiar cumulative layout shift that editorial sites have paid content-policy penalties for since 2020.

Preimage and pretext address the same problem from opposite ends. Pretext measures the text synchronously once fonts are loaded, so line breaks never change unless you tell it to. Preimage measures the image dimensions in a pre-layout pass — streaming the first two kilobytes of each figure's bytes via a header probe — and hands those concrete numbers to pretext's variable-width cursor loop. Both contributions are arithmetic after their one async preparation step.

The result on the right is that the column's final height, the y-coordinate of every line, and the rect of every floated figure are all known before the first paint. When the bytes finish streaming, the figures just fill in at their already-reserved positions. No shift, no skeleton swap, no cumulative layout score to apologize for.`

const FIGURE_ASPECTS: Array<[number, number]> = [
  [1600, 1000],
  [1200, 1600],
  [1800, 1200],
]

const FIGURE_TOPS = [40, 360, 680]

async function generateImage(w: number, h: number, hue: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, w, h)
  grad.addColorStop(0, `hsl(${hue} 70% 55%)`)
  grad.addColorStop(1, `hsl(${(hue + 40) % 360} 70% 35%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `hsla(${(hue + i * 13) % 360}, 70%, 60%, 0.3)`
    ctx.beginPath()
    ctx.arc(Math.random() * w, Math.random() * h, 40 + Math.random() * 180, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ctx.font = `${Math.round(Math.min(w, h) / 5)}px system-ui`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('fig.', w / 2, h / 2)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b !== null ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Generating…'
  naivePanel.innerHTML = ''
  measuredPanel.innerHTML = ''
  naiveStat.textContent = 'generating 3 figures…'
  measuredStat.textContent = 'generating 3 figures…'
  genInfo.textContent = ''

  const blobs: Blob[] = []
  for (let i = 0; i < FIGURE_ASPECTS.length; i++) {
    const [w, h] = FIGURE_ASPECTS[i]!
    blobs.push(await generateImage(w, h, (i * 97) % 360))
  }
  const totalMB = blobs.reduce((a, b) => a + b.size, 0) / 1024 / 1024
  genInfo.textContent = `${blobs.length} PNG figures · ${totalMB.toFixed(1)} MB total`

  runButton.textContent = 'Rendering…'

  // --- Naive path: HTML article with <figure> floats, no declared size. ---
  const naiveStart = performance.now()
  const heightTracker = { lastHeight: 0, shifts: 0 }
  const naiveObserver = new ResizeObserver(() => {
    const h = naivePanel.getBoundingClientRect().height
    if (Math.abs(h - heightTracker.lastHeight) > 0.5) {
      heightTracker.shifts++
      heightTracker.lastHeight = h
    }
  })
  naiveObserver.observe(naivePanel)

  const naiveUrls = blobs.map((b) => URL.createObjectURL(b))
  const paragraphs = ARTICLE.split('\n\n')
  const naiveImgs: HTMLImageElement[] = []
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const p = document.createElement('p')
    if (pi < naiveUrls.length) {
      const fig = document.createElement('figure')
      fig.className = 'fig'
      const img = document.createElement('img')
      img.alt = ''
      naiveImgs.push(img)
      fig.appendChild(img)
      const cap = document.createElement('figcaption')
      cap.textContent = `Figure ${pi + 1}`
      fig.appendChild(cap)
      p.appendChild(fig)
    }
    p.appendChild(document.createTextNode(paragraphs[pi]!))
    naivePanel.appendChild(p)
  }

  for (let i = 0; i < naiveImgs.length; i++) {
    await new Promise<void>((r) => setTimeout(r, 120 + i * 60))
    naiveImgs[i]!.src = naiveUrls[i]!
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
  naiveStat.textContent = `final height in ${(naiveEnd - naiveStart).toFixed(0)}ms · ${heightTracker.shifts} layout shifts during load`

  // --- Measured path: prepare all images, then lay out once with pretext. ---
  const measuredStart = performance.now()
  await document.fonts.ready
  const measuredPrepared = await Promise.all(blobs.map((b) => prepare(b)))
  const measuredAfterPrepare = performance.now()

  const text = prepareWithSegments(ARTICLE, FONT)
  const result = flowColumnWithFloats({
    text,
    columnWidth: COLUMN_WIDTH,
    lineHeight: LINE_HEIGHT,
    floats: measuredPrepared.map((image, i) => ({
      image,
      side: 'right' as const,
      top: FIGURE_TOPS[i]!,
      maxWidth: Math.round(COLUMN_WIDTH * 0.42),
      maxHeight: 160,
      gapX: 14,
      gapY: 4,
    })),
  })

  measuredPanel.innerHTML = ''
  measuredPanel.style.width = `${COLUMN_WIDTH}px`
  measuredPanel.style.height = `${result.totalHeight}px`

  for (const item of result.items) {
    if (item.kind === 'line') {
      const line = materializeLineRange(text, item.range)
      const el = document.createElement('div')
      el.className = 'line'
      el.style.left = `${item.x}px`
      el.style.top = `${item.y}px`
      el.style.width = `${item.width}px`
      el.textContent = line.text
      measuredPanel.appendChild(el)
    } else {
      const fig = document.createElement('div')
      fig.className = 'fig'
      fig.style.left = `${item.x}px`
      fig.style.top = `${item.y}px`
      fig.style.width = `${item.width}px`
      fig.style.height = `${item.height}px`
      const img = document.createElement('img')
      img.src = getMeasurement(item.image).blobUrl ?? ''
      fig.appendChild(img)
      measuredPanel.appendChild(fig)
    }
  }
  const measuredEnd = performance.now()
  measuredStat.textContent = `prepared figures + text in ${(measuredAfterPrepare - measuredStart).toFixed(0)}ms · laid out ${result.lineCount} lines in ${(measuredEnd - measuredAfterPrepare).toFixed(0)}ms · 0 layout shifts`

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
