import { prepare, getMeasurement } from '../../src/index.js'
import { loadPhoto, PICSUM_PHOTOS } from './photo-source.js'

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
  if (shifts > 0) {
    const row = document.createElement('div')
    row.className = 'event'
    const label = document.createElement('span')
    label.textContent = 'layout shifts observed'
    const time = document.createElement('span')
    time.innerHTML = `<span class="shift-marker">${shifts}</span>`
    row.appendChild(label)
    row.appendChild(time)
    host.appendChild(row)
  }
}

function observePanel(panel: HTMLElement): { shifts: () => number; stop: () => void } {
  let shifts = 0
  let lastHeight = panel.getBoundingClientRect().height
  const observer = new ResizeObserver(() => {
    const h = panel.getBoundingClientRect().height
    if (Math.abs(h - lastHeight) > 0.5) {
      shifts++
      lastHeight = h
    }
  })
  observer.observe(panel)
  return { shifts: () => shifts, stop: () => observer.disconnect() }
}

// Each strategy takes a Blob (so the byte-arrival time is identical across
// panels) and reports back when the dims become known + when the image is
// fully painted. They all run concurrently.
async function runNaive(blob: Blob, width: number): Promise<{ events: Event[]; shifts: number }> {
  const host = f1
  host.innerHTML = ''
  const stage = host.parentElement!
  const monitor = observePanel(stage)
  const t0 = performance.now()
  const img = document.createElement('img')
  img.style.maxWidth = `${width}px`
  img.style.display = 'block'
  host.appendChild(img)
  const events: Event[] = []
  await new Promise<void>((resolve) => {
    img.onload = () => {
      events.push({ label: 'dims known (onload)', t: performance.now() - t0 })
      events.push({ label: 'image painted', t: performance.now() - t0 })
      resolve()
    }
    img.src = URL.createObjectURL(blob)
  })
  monitor.stop()
  return { events, shifts: monitor.shifts() }
}

async function runNative(
  blob: Blob,
  declaredWidth: number,
  declaredHeight: number,
  displayWidth: number,
): Promise<{ events: Event[]; shifts: number }> {
  const host = f2
  host.innerHTML = ''
  const stage = host.parentElement!
  const monitor = observePanel(stage)
  const t0 = performance.now()
  const scale = displayWidth / declaredWidth
  const frameH = Math.min(declaredHeight * scale, MAX_FRAME_HEIGHT)
  const frameW = frameH * (declaredWidth / declaredHeight)
  const frame = setFrame(host, frameW, frameH, `reserved ${declaredWidth}×${declaredHeight}`, true)
  const events: Event[] = [{ label: 'dims known (from attrs)', t: performance.now() - t0 }]
  const img = document.createElement('img')
  img.width = declaredWidth
  img.height = declaredHeight
  frame.appendChild(img)
  await new Promise<void>((resolve) => {
    img.onload = () => {
      img.classList.add('loaded')
      events.push({ label: 'image painted', t: performance.now() - t0 })
      resolve()
    }
    img.src = URL.createObjectURL(blob)
  })
  monitor.stop()
  return { events, shifts: monitor.shifts() }
}

async function runPreimage(
  blob: Blob,
  displayWidth: number,
): Promise<{ events: Event[]; shifts: number }> {
  const host = f3
  host.innerHTML = ''
  const stage = host.parentElement!
  const monitor = observePanel(stage)
  const t0 = performance.now()
  const prepared = await prepare(blob)
  const m = getMeasurement(prepared)
  const dimsKnownAt = performance.now() - t0
  const scale = displayWidth / m.naturalWidth
  const frameH = Math.min(m.naturalHeight * scale, MAX_FRAME_HEIGHT)
  const frameW = frameH * (m.naturalWidth / m.naturalHeight)
  const frame = setFrame(host, frameW, frameH, `measured ${m.naturalWidth}×${m.naturalHeight}`, true)
  const events: Event[] = [
    { label: 'dims known (prepare)', t: dimsKnownAt, note: `${m.naturalWidth}×${m.naturalHeight}` },
  ]
  const img = document.createElement('img')
  img.src = m.blobUrl ?? URL.createObjectURL(blob)
  frame.appendChild(img)
  await new Promise<void>((resolve) => {
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add('loaded')
      events.push({ label: 'image painted', t: performance.now() - t0 })
      resolve()
    } else {
      img.onload = () => {
        img.classList.add('loaded')
        events.push({ label: 'image painted', t: performance.now() - t0 })
        resolve()
      }
    }
  })
  monitor.stop()
  return { events, shifts: monitor.shifts() }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Loading photo…'
  metaEl.textContent = ''
  // Reset panels.
  f1.innerHTML = ''
  f2.innerHTML = ''
  f3.innerHTML = ''
  e1.innerHTML = ''
  e2.innerHTML = ''
  e3.innerHTML = ''

  const photo = PICSUM_PHOTOS[0]!
  const { blob, origin } = await loadPhoto(photo, 200)
  metaEl.textContent = `${photo.caption ?? photo.seed} · ${photo.width}×${photo.height} · ${(blob.size / 1024 / 1024).toFixed(2)} MB · ${origin === 'picsum' ? 'picsum.photos (live)' : 'picsum offline — canvas fallback at same aspect'}`

  runButton.textContent = 'Running…'

  // All three pipelines start from the SAME Blob at the SAME tick, so any
  // timing differences are strategy differences, not input-arrival
  // differences.
  const [naive, native, preimaged] = await Promise.all([
    runNaive(blob, PANEL_WIDTH),
    runNative(blob, photo.width, photo.height, PANEL_WIDTH),
    runPreimage(blob, PANEL_WIDTH),
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
