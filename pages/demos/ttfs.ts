import { prepare, getMeasurement } from '../../src/index.js'
import {
  newCacheBustToken,
  picsumReachable,
  resolvePhotoUrl,
  PICSUM_PHOTOS,
} from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const runButton = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const f1 = document.getElementById('f1')!
const f2 = document.getElementById('f2')!
const f3 = document.getElementById('f3')!
const e1 = document.getElementById('e1')!
const e2 = document.getElementById('e2')!
const e3 = document.getElementById('e3')!

const PANEL_WIDTH = 320
const MAX_FRAME_HEIGHT = 220

type Event = { label: string; t: number; note?: string }

function renderEvents(host: HTMLElement, events: Event[], shifts: number): void {
  host.innerHTML = ''
  for (const ev of events) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<span>${ev.label}</span><span><b>${ev.t.toFixed(1)}ms</b>${ev.note ? ` · ${ev.note}` : ''}</span>`
    host.appendChild(row)
  }
  const shiftRow = document.createElement('div')
  shiftRow.className = 'row'
  shiftRow.innerHTML = `<span>visible shifts</span><span${shifts > 0 ? ' class="shift"' : ''}><b>${shifts}</b></span>`
  host.appendChild(shiftRow)
}

function aspectFrame(
  host: HTMLElement,
  naturalW: number,
  naturalH: number,
  label: string,
): HTMLElement {
  host.innerHTML = ''
  const scale = PANEL_WIDTH / naturalW
  const h = Math.min(naturalH * scale, MAX_FRAME_HEIGHT)
  const w = h * (naturalW / naturalH)
  const frame = document.createElement('div')
  frame.className = 'frame-skeleton'
  frame.style.width = `${w}px`
  frame.style.height = `${h}px`
  const tag = document.createElement('span')
  tag.style.cssText = 'position:absolute;top:6px;left:8px;color:var(--frame);font-size:10.5px;letter-spacing:0.03em;text-transform:uppercase;font-weight:600;z-index:1;'
  tag.textContent = label
  frame.appendChild(tag)
  host.appendChild(frame)
  return frame
}

async function runNaive(url: string): Promise<{ events: Event[]; shifts: number }> {
  f1.innerHTML = ''
  const stage = f1.parentElement!
  const t0 = performance.now()
  const img = document.createElement('img')
  img.alt = ''
  f1.appendChild(img)
  const monitor = observeShifts(stage)
  await new Promise<void>((resolve) => {
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = url
  })
  const t = performance.now() - t0
  monitor.stop()
  return {
    events: [
      { label: 'dims known (onload)', t },
      { label: 'image painted', t },
    ],
    shifts: monitor.shifts(),
  }
}

async function runNative(
  url: string,
  declaredWidth: number,
  declaredHeight: number,
): Promise<{ events: Event[]; shifts: number }> {
  f2.innerHTML = ''
  const stage = f2.parentElement!
  const t0 = performance.now()
  const frame = aspectFrame(f2, declaredWidth, declaredHeight, `reserved ${declaredWidth}×${declaredHeight}`)
  const frameAt = performance.now() - t0
  const img = document.createElement('img')
  img.width = declaredWidth
  img.height = declaredHeight
  frame.appendChild(img)
  const monitor = observeShifts(stage)
  await new Promise<void>((resolve) => {
    img.onload = () => {
      img.classList.add('loaded')
      resolve()
    }
    img.onerror = () => resolve()
    img.src = url
  })
  const paintedAt = performance.now() - t0
  monitor.stop()
  return {
    events: [
      { label: 'dims known (from attrs)', t: frameAt },
      { label: 'image painted', t: paintedAt },
    ],
    shifts: monitor.shifts(),
  }
}

async function runPreimage(url: string): Promise<{ events: Event[]; shifts: number }> {
  f3.innerHTML = ''
  const stage = f3.parentElement!
  const t0 = performance.now()
  const prepared = await prepare(url)
  const m = getMeasurement(prepared)
  const preparedAt = performance.now() - t0
  const frame = aspectFrame(f3, m.naturalWidth, m.naturalHeight, `measured ${m.naturalWidth}×${m.naturalHeight}`)
  const img = document.createElement('img')
  frame.appendChild(img)
  const monitor = observeShifts(stage)
  await new Promise<void>((resolve) => {
    const done = (): void => {
      img.classList.add('loaded')
      resolve()
    }
    if (img.complete && img.naturalWidth > 0) done()
    else {
      img.onload = done
      img.onerror = done
    }
    img.src = m.blobUrl ?? url
  })
  const paintedAt = performance.now() - t0
  monitor.stop()
  return {
    events: [
      { label: 'dims known (prepare)', t: preparedAt, note: `${m.naturalWidth}×${m.naturalHeight}` },
      { label: 'image painted', t: paintedAt },
    ],
    shifts: monitor.shifts(),
  }
}

async function run(): Promise<void> {
  runButton.disabled = true
  runButton.textContent = 'Checking network…'
  metaEl.textContent = ''
  f1.innerHTML = ''
  f2.innerHTML = ''
  f3.innerHTML = ''
  e1.innerHTML = ''
  e2.innerHTML = ''
  e3.innerHTML = ''

  const photo = PICSUM_PHOTOS[0]!
  const useLive = await picsumReachable()
  const cacheBust = newCacheBustToken()
  runButton.textContent = useLive ? 'Fetching from picsum…' : 'Generating fallback…'
  const resolved = await resolvePhotoUrl(photo, cacheBust, useLive, 200)

  metaEl.textContent =
    `${photo.caption ?? photo.seed} · ${photo.width}×${photo.height} · ` +
    (useLive ? 'picsum.photos (cache-busted — real network)' : 'picsum offline — canvas fallback (same aspect, no network term)')

  runButton.textContent = 'Running…'

  // The naive and native panels use the direct URL (real network). The
  // preimage panel calls prepare(url), which internally streams the same
  // URL — so all three race against the same network condition.
  const [naive, native, preimaged] = await Promise.all([
    runNaive(resolved.url),
    runNative(resolved.url, photo.width, photo.height),
    runPreimage(resolved.url),
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
