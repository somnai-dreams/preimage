import { prepare, getMeasurement } from '../../src/index.js'
import { loadPhoto, latencyFor, PICSUM_PHOTOS } from './photo-source.js'
import { loadImgWithLatency, observeShifts, sleep, wireLatencySlider } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const f1 = document.getElementById('f1')!
const f2 = document.getElementById('f2')!
const f3 = document.getElementById('f3')!
const e1 = document.getElementById('e1')!
const e2 = document.getElementById('e2')!
const e3 = document.getElementById('e3')!

const PANEL_WIDTH = 280
const MAX_FRAME_HEIGHT = 220

const latencyControl = wireLatencySlider('latency', 'latencyValue', 800)

type Event = { label: string; t: number; note?: string }

function setFrame(host: HTMLElement, width: number, height: number, label: string, framed: boolean): HTMLElement {
  host.innerHTML = ''
  const frame = document.createElement('div')
  frame.className = 'image-frame' + (framed ? '' : ' unframed')
  frame.style.width = `${width}px`
  frame.style.height = `${height}px`
  if (framed) frame.textContent = label
  host.appendChild(frame)
  return frame
}

function renderEvents(host: HTMLElement, events: Event[], shifts: number): void {
  host.innerHTML = ''
  for (const ev of events) {
    const row = document.createElement('div')
    row.className = 'event'
    const label = document.createElement('span')
    label.textContent = ev.label
    const time = document.createElement('span')
    time.innerHTML = `<b>${ev.t.toFixed(1)}ms</b>${ev.note ? ` · ${ev.note}` : ''}`
    row.appendChild(label)
    row.appendChild(time)
    host.appendChild(row)
  }
  const row = document.createElement('div')
  row.className = 'event'
  const label = document.createElement('span')
  label.textContent = 'visible shifts'
  const time = document.createElement('span')
  time.innerHTML =
    shifts > 0
      ? `<span class="shift-marker">${shifts}</span>`
      : `<b>0</b>`
  row.appendChild(label)
  row.appendChild(time)
  host.appendChild(row)
}

// Each strategy starts from the same Blob (so byte-arrival is identical
// across panels) and reports when dims become known + when the image is
// fully painted. They all run in parallel. `latencyMs` simulates a
// network transfer on top of the in-memory decode — the naive path
// waits before seeing any bytes; the preimage path still returns dims
// via its byte-probe after the first chunk would have arrived (modelled
// here as ~10% of the total latency).

async function runNaive(blob: Blob, latencyMs: number): Promise<{ events: Event[]; shifts: number }> {
  const host = f1
  host.innerHTML = ''
  const stage = host.parentElement!
  const t0 = performance.now()
  const img = document.createElement('img')
  img.style.maxWidth = `${PANEL_WIDTH}px`
  img.style.display = 'block'
  host.appendChild(img)
  const monitor = observeShifts(stage)
  await loadImgWithLatency(img, blob, latencyMs)
  const events: Event[] = [
    { label: 'dims known (onload)', t: performance.now() - t0 },
    { label: 'image painted', t: performance.now() - t0 },
  ]
  monitor.stop()
  return { events, shifts: monitor.shifts() }
}

async function runNative(
  blob: Blob,
  declaredWidth: number,
  declaredHeight: number,
  latencyMs: number,
): Promise<{ events: Event[]; shifts: number }> {
  const host = f2
  host.innerHTML = ''
  const stage = host.parentElement!
  const t0 = performance.now()
  const scale = PANEL_WIDTH / declaredWidth
  const frameH = Math.min(declaredHeight * scale, MAX_FRAME_HEIGHT)
  const frameW = frameH * (declaredWidth / declaredHeight)
  const frame = setFrame(host, frameW, frameH, `reserved ${declaredWidth}×${declaredHeight}`, true)
  const events: Event[] = [{ label: 'dims known (from attrs)', t: performance.now() - t0 }]
  const img = document.createElement('img')
  img.width = declaredWidth
  img.height = declaredHeight
  frame.appendChild(img)
  const monitor = observeShifts(stage)
  await loadImgWithLatency(img, blob, latencyMs)
  events.push({ label: 'image painted', t: performance.now() - t0 })
  monitor.stop()
  return { events, shifts: monitor.shifts() }
}

async function runPreimage(
  blob: Blob,
  latencyMs: number,
): Promise<{ events: Event[]; shifts: number }> {
  const host = f3
  host.innerHTML = ''
  const stage = host.parentElement!
  const t0 = performance.now()
  // Simulate: the first bytes arrive quickly (~10% of the total transfer
  // on a streaming connection), enough for the header probe. prepare()
  // would return after that first chunk.
  const probeDelay = Math.round(latencyMs * 0.1)
  if (probeDelay > 0) await sleep(probeDelay)
  const prepared = await prepare(blob)
  const m = getMeasurement(prepared)
  const dimsKnownAt = performance.now() - t0
  const scale = PANEL_WIDTH / m.naturalWidth
  const frameH = Math.min(m.naturalHeight * scale, MAX_FRAME_HEIGHT)
  const frameW = frameH * (m.naturalWidth / m.naturalHeight)
  const frame = setFrame(host, frameW, frameH, `measured ${m.naturalWidth}×${m.naturalHeight}`, true)
  const events: Event[] = [
    { label: 'dims known (prepare)', t: dimsKnownAt, note: `${m.naturalWidth}×${m.naturalHeight}` },
  ]
  const img = document.createElement('img')
  frame.appendChild(img)
  // Observe only the remaining-bytes phase — the frame is in place.
  const monitor = observeShifts(stage)
  // The remaining bytes arrive over the rest of the simulated transfer.
  const remainingDelay = Math.max(0, latencyMs - probeDelay)
  await loadImgWithLatency(img, blob, remainingDelay)
  events.push({ label: 'image painted', t: performance.now() - t0 })
  monitor.stop()
  return { events, shifts: monitor.shifts() }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Loading photo…'
  metaEl.textContent = ''
  f1.innerHTML = ''
  f2.innerHTML = ''
  f3.innerHTML = ''
  e1.innerHTML = ''
  e2.innerHTML = ''
  e3.innerHTML = ''

  const photo = PICSUM_PHOTOS[0]!
  const loaded = await loadPhoto(photo, 200)
  const latencyMs = latencyControl.read()
  void latencyFor // retained export; slider overrides the default
  metaEl.textContent =
    `${photo.caption ?? photo.seed} · ${photo.width}×${photo.height} · ${(loaded.blob.size / 1024 / 1024).toFixed(2)} MB · ` +
    (loaded.origin === 'picsum' ? 'picsum.photos (live)' : 'picsum offline — canvas fallback') +
    ` · simulating ${latencyMs}ms transfer per image`

  runButton.textContent = 'Running…'

  const [naive, native, preimaged] = await Promise.all([
    runNaive(loaded.blob, latencyMs),
    runNative(loaded.blob, photo.width, photo.height, latencyMs),
    runPreimage(loaded.blob, latencyMs),
  ])

  renderEvents(e1, naive.events, naive.shifts)
  renderEvents(e2, native.events, native.shifts)
  renderEvents(e3, preimaged.events, preimaged.shifts)

  runButton.textContent = 'Run again'
  runButton.disabled = false
}

runButton.addEventListener('click', () => {
  void run()
})
void run()
