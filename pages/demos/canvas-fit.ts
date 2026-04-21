import { prepare, layout, getMeasurement, type ObjectFit } from '../../src/index.js'

const BOX_W = 480
const BOX_H = 270

const srcInput = document.getElementById('src') as HTMLInputElement
const fitSelect = document.getElementById('fit') as HTMLSelectElement
const goButton = document.getElementById('go') as HTMLButtonElement
const naiveCanvas = document.getElementById('naive') as HTMLCanvasElement
const fittedCanvas = document.getElementById('fitted') as HTMLCanvasElement
const naiveStat = document.getElementById('naiveStat')!
const fittedStat = document.getElementById('fittedStat')!

// Backing store at devicePixelRatio so the canvases look sharp.
function sizeCanvasFor(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

async function draw(): Promise<void> {
  const src = srcInput.value.trim()
  const fit = fitSelect.value as ObjectFit

  const naiveCtx = sizeCanvasFor(naiveCanvas, BOX_W, BOX_H)
  const fittedCtx = sizeCanvasFor(fittedCanvas, BOX_W, BOX_H)
  naiveCtx.fillStyle = '#111'
  naiveCtx.fillRect(0, 0, BOX_W, BOX_H)
  fittedCtx.fillStyle = '#111'
  fittedCtx.fillRect(0, 0, BOX_W, BOX_H)

  let prepared
  try {
    prepared = await prepare(src)
  } catch (e) {
    naiveStat.textContent = `error: ${(e as Error).message}`
    fittedStat.textContent = ''
    return
  }

  // Load a real HTMLImageElement for drawing. prepare() measured intrinsic
  // size; now we need a drawable. (Calling prepare() does not retain a
  // decoded bitmap — by design — so we load once more here for the canvas.)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('load failed'))
    el.src = src
  })

  // Naive: stretch source into box.
  naiveCtx.drawImage(img, 0, 0, BOX_W, BOX_H)

  // Fitted: ask preimage for the correct rect.
  const rect = layout(prepared, BOX_W, BOX_H, fit)
  fittedCtx.drawImage(img, rect.offsetX, rect.offsetY, rect.width, rect.height)

  const m = getMeasurement(prepared)
  naiveStat.textContent = `source ${m.displayWidth}×${m.displayHeight} → stretched to ${BOX_W}×${BOX_H}`
  fittedStat.textContent = `${fit}: ${rect.width.toFixed(1)}×${rect.height.toFixed(1)} @ (${rect.offsetX.toFixed(1)}, ${rect.offsetY.toFixed(1)})`
}

goButton.addEventListener('click', () => {
  void draw()
})
fitSelect.addEventListener('change', () => {
  void draw()
})

void draw()
