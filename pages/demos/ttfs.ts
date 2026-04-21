import {
  prepare,
  getMeasurement,
  clearMeasurementCaches,
} from '../../src/index.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const blobInfo = document.getElementById('blobInfo')!
const slowTime = document.getElementById('slowTime')!
const slowMeta = document.getElementById('slowMeta')!
const fastTime = document.getElementById('fastTime')!
const fastMeta = document.getElementById('fastMeta')!
const ratio = document.getElementById('ratio')!

async function makeLargePng(width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, width, height)
  grad.addColorStop(0, '#0052cc')
  grad.addColorStop(1, '#ffb600')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `hsla(${(i * 37) % 360}, 70%, 55%, 0.4)`
    ctx.beginPath()
    ctx.arc(Math.random() * width, Math.random() * height, 20 + Math.random() * 120, 0, Math.PI * 2)
    ctx.fill()
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b !== null ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

function fmt(ms: number): string {
  if (ms >= 1) return `${ms.toFixed(1)}ms`
  return `${(ms * 1000).toFixed(0)}µs`
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Generating PNG…'
  slowTime.textContent = '—'
  fastTime.textContent = '—'
  ratio.textContent = ''
  slowMeta.textContent = 'waiting…'
  fastMeta.textContent = 'waiting…'

  const blob = await makeLargePng(4000, 3000)
  blobInfo.textContent = `Blob: ${(blob.size / 1024 / 1024).toFixed(2)} MB PNG, 4000×3000`

  runButton.textContent = 'Measuring…'

  // The default strategy ('auto') uses byte-probing. 'image-element'
  // forces the classic HTMLImageElement.decode() path. Same API, just
  // different pipelines under the hood.
  async function time(strategy: 'image-element' | 'auto'): Promise<{ ms: number; w: number; h: number }> {
    clearMeasurementCaches()
    const url = URL.createObjectURL(blob)
    const t0 = performance.now()
    const prepared =
      strategy === 'image-element'
        ? await prepare(url, { strategy: 'image-element' })
        : await prepare(blob) // Blob path probes directly, no URL indirection
    const t1 = performance.now()
    const m = getMeasurement(prepared)
    URL.revokeObjectURL(url)
    return { ms: t1 - t0, w: m.naturalWidth, h: m.naturalHeight }
  }

  await time('image-element') // warmup
  const slow1 = await time('image-element')
  const slow2 = await time('image-element')
  const slowMs = Math.min(slow1.ms, slow2.ms)

  await time('auto') // warmup
  const fast1 = await time('auto')
  const fast2 = await time('auto')
  const fastMs = Math.min(fast1.ms, fast2.ms)

  slowTime.textContent = fmt(slowMs)
  slowMeta.textContent = `${slow1.w}×${slow1.h} · best of 2 (ignoring warmup)`

  fastTime.textContent = fmt(fastMs)
  fastMeta.textContent = `${fast1.w}×${fast1.h} · best of 2 (ignoring warmup)`

  const r = slowMs / fastMs
  ratio.textContent = r >= 1 ? `${r.toFixed(1)}× faster` : `${(1 / r).toFixed(1)}× slower`

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
