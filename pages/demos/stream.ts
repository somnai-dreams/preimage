import { probeImageStream } from '@somnai-dreams/preimage/core'
import { PHOTOS, photoUrl, newCacheBustToken } from './photo-source.js'
import { fmtMs, fmtBytes, setRowValue, resetStats } from './demo-formatting.js'

const speedSlider = document.getElementById('speedSlider') as HTMLInputElement
const speedVal = document.getElementById('speedVal')!
const metaEl = document.getElementById('meta')!
const naiveStage = document.getElementById('naiveStage')!
const measuredStage = document.getElementById('measuredStage')!
const naiveProgress = document.getElementById('naiveProgress')!
const measuredProgress = document.getElementById('measuredProgress')!
const naiveStats = document.getElementById('naiveStats')!
const measuredStats = document.getElementById('measuredStats')!
const runNaiveBtn = document.getElementById('runNaive') as HTMLButtonElement
const runMeasuredBtn = document.getElementById('runMeasured') as HTMLButtonElement

// Pick one photo and stream it. The same URL (with per-run cache-bust)
// is used for both panels so the byte count matches.
const PHOTO = PHOTOS[3]! // 04.png — 816×1456, nice tall portrait

// --- Throttled stream ---
//
// Take a ReadableStream from fetch().body and re-emit its bytes in
// small chunks paced by `bytesPerSec`. Uses a token-bucket: we track
// the expected cumulative byte budget at each tick and sleep until
// the chunk we're about to emit fits under the budget.

function throttleStream(
  source: ReadableStream<Uint8Array>,
  bytesPerSec: number,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader()
      const t0 = performance.now()
      let emitted = 0

      async function pace(bytes: number): Promise<void> {
        const expectedElapsedMs = ((emitted + bytes) / bytesPerSec) * 1000
        const actualElapsedMs = performance.now() - t0
        const wait = expectedElapsedMs - actualElapsedMs
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      }

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // Split the fetch chunk into smaller throttled pieces.
          for (let off = 0; off < value.byteLength; off += chunkSize) {
            const piece = value.slice(off, Math.min(off + chunkSize, value.byteLength))
            await pace(piece.byteLength)
            controller.enqueue(piece)
            emitted += piece.byteLength
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

// --- Shared setup ---

function getBytesPerSec(): number {
  return Number(speedSlider.value) * 1024
}

// Clear and re-seed a stage with a pending figure. Returns the
// figure element ready to be populated.
function seedStage(stage: HTMLElement, progressBar: HTMLElement): HTMLElement {
  // Wipe everything except the progress wrapper (the inner bar's
  // parent). We preserve it so a rerun doesn't lose the progress UI.
  const progressWrapper = stage.querySelector<HTMLElement>('.progress')!
  for (const child of Array.from(stage.children)) {
    if (child === progressWrapper) continue
    child.remove()
  }
  progressBar.style.width = '0%'

  const fig = document.createElement('div')
  fig.className = 'figure pending'
  // Start with a placeholder aspect so the shimmer has a visible box
  // before dims are known. The naive side keeps this size until
  // render; the measured side overwrites it at onDims.
  fig.style.width = '240px'
  fig.style.height = '240px'
  stage.insertBefore(fig, progressWrapper)
  return fig
}

// Full-assignment class transition for a figure: drops the shimmer,
// marks the image visible. Per vibescript, replace the whole className
// rather than toggling members so the branches can't drift.
function markFigureLoaded(fig: HTMLElement, img: HTMLImageElement): void {
  img.classList.add('loaded')
  fig.className = 'figure'
}

// --- Naive run: wait for the entire stream, then render ---

async function runNaive(): Promise<void> {
  runNaiveBtn.disabled = true
  runNaiveBtn.textContent = 'Streaming…'
  resetStats(naiveStats)

  const fig = seedStage(naiveStage, naiveProgress)
  const url = photoUrl(PHOTO, newCacheBustToken())
  const bytesPerSec = getBytesPerSec()
  metaEl.textContent = `Streaming ${PHOTO.file} · ${(bytesPerSec / 1024).toFixed(0)} KB/s`

  const t0 = performance.now()
  const response = await fetch(url)
  const throttled = throttleStream(response.body!, bytesPerSec, 4096)

  // Naive: buffer every chunk into an array, update progress as we
  // go (dims still unknown!), then at the end build a Blob and set
  // img.src. Space only reserves at that final moment.
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = throttled.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      naiveProgress.style.width = `${Math.min(100, (total / (PHOTO.width * PHOTO.height * 0.001)) * 100)}%`
      setRowValue(naiveStats, 1, `<b>${fmtBytes(total)}</b>`)
    }
  } finally {
    reader.releaseLock()
  }
  const streamDoneMs = performance.now() - t0

  const blob = new Blob(chunks as BlobPart[])
  const blobUrl = URL.createObjectURL(blob)
  const img = new Image()
  img.alt = ''
  img.src = blobUrl
  fig.appendChild(img)
  const renderedAt = await new Promise<number>((resolve) => {
    const finish = (): void => {
      markFigureLoaded(fig, img)
      // Resize the figure to the image's natural dims now that we
      // know them — same moment dims are "known" in this model.
      fig.style.height = `${(240 / img.naturalWidth) * img.naturalHeight}px`
      resolve(performance.now() - t0)
    }
    if (img.complete && img.naturalWidth > 0) finish()
    else img.addEventListener('load', finish, { once: true })
  })

  naiveProgress.style.width = '100%'
  setRowValue(naiveStats, 2, `<b>${fmtMs(streamDoneMs)}</b>`) // dims known = stream done
  setRowValue(naiveStats, 3, `<b>${fmtMs(streamDoneMs)}</b>`) // space reserved = stream done
  setRowValue(naiveStats, 4, `<b>${fmtMs(renderedAt)}</b>`)

  runNaiveBtn.disabled = false
  runNaiveBtn.textContent = 'Stream again'
}

// --- Measured run: probeImageStream reserves space mid-stream ---

async function runMeasured(): Promise<void> {
  runMeasuredBtn.disabled = true
  runMeasuredBtn.textContent = 'Streaming…'
  resetStats(measuredStats)

  const fig = seedStage(measuredStage, measuredProgress)
  const url = photoUrl(PHOTO, newCacheBustToken())
  const bytesPerSec = getBytesPerSec()
  metaEl.textContent = `Streaming ${PHOTO.file} · ${(bytesPerSec / 1024).toFixed(0)} KB/s`

  const t0 = performance.now()
  const response = await fetch(url)
  const throttled = throttleStream(response.body!, bytesPerSec, 4096)

  // Tee the stream: one branch feeds probeImageStream, the other
  // drives the progress bar + bytes counter. probeImageStream will
  // also collect the full Blob, so we could render from that — but
  // splitting makes the bytes counter honest about when chunks
  // actually arrived (probeImageStream only exposes dims + final).
  const [forProbe, forProgress] = throttled.tee()

  // Feed the progress branch.
  ;(async () => {
    const reader = forProgress.getReader()
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        measuredProgress.style.width = `${Math.min(100, (total / (PHOTO.width * PHOTO.height * 0.001)) * 100)}%`
        setRowValue(measuredStats, 1, `<b>${fmtBytes(total)}</b>`)
      }
    } finally {
      reader.releaseLock()
    }
  })()

  let dimsAtMs: number | null = null
  let reservedAtMs: number | null = null
  const { dims, blob } = await probeImageStream(forProbe, {
    onDims: (d) => {
      dimsAtMs = performance.now() - t0
      setRowValue(measuredStats, 2, `<b>${fmtMs(dimsAtMs)}</b>`)
      // Reserve space the instant dims are known.
      fig.style.width = '240px'
      fig.style.height = `${(240 / d.width) * d.height}px`
      reservedAtMs = performance.now() - t0
      setRowValue(measuredStats, 3, `<b>${fmtMs(reservedAtMs)}</b>`)
    },
  })
  const streamDoneMs = performance.now() - t0

  if (dims === null) {
    fig.textContent = 'probe failed'
    runMeasuredBtn.disabled = false
    runMeasuredBtn.textContent = 'Stream again'
    return
  }

  const blobUrl = URL.createObjectURL(blob)
  const img = new Image()
  img.alt = ''
  img.src = blobUrl
  fig.appendChild(img)
  const renderedAt = await new Promise<number>((resolve) => {
    const finish = (): void => {
      markFigureLoaded(fig, img)
      resolve(performance.now() - t0)
    }
    if (img.complete && img.naturalWidth > 0) finish()
    else img.addEventListener('load', finish, { once: true })
  })

  measuredProgress.style.width = '100%'
  setRowValue(measuredStats, 4, `<b>${fmtMs(renderedAt)}</b>`)
  void streamDoneMs // referenced for clarity; render time is what's shown

  runMeasuredBtn.disabled = false
  runMeasuredBtn.textContent = 'Stream again'
}

// --- Controls ---

speedSlider.addEventListener('input', () => {
  speedVal.textContent = `${speedSlider.value} KB/s`
})
speedVal.textContent = `${speedSlider.value} KB/s`

runNaiveBtn.addEventListener('click', () => {
  void runNaive()
})
runMeasuredBtn.addEventListener('click', () => {
  void runMeasured()
})
