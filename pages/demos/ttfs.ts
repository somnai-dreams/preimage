import { prepare, getMeasurement } from '../../src/index.js'
import {
  generateFallbackBlob,
  newCacheBustToken,
  picsumReachable,
  picsumUrl,
  type PhotoDescriptor,
} from './photo-source.js'
import { observeShifts, waitForDominantColor } from './demo-utils.js'

const metaEl = document.getElementById('meta')!
const f1 = document.getElementById('f1')!
const f2 = document.getElementById('f2')!
const f3 = document.getElementById('f3')!
const e1 = document.getElementById('e1')!
const e2 = document.getElementById('e2')!
const e3 = document.getElementById('e3')!
const r1 = document.getElementById('r1')!
const r2 = document.getElementById('r2')!
const r3 = document.getElementById('r3')!
const run1 = document.getElementById('run1') as HTMLButtonElement
const run2 = document.getElementById('run2') as HTMLButtonElement
const run3 = document.getElementById('run3') as HTMLButtonElement

// High-res photo: ~4800×3200 JPEGs weigh in at 2-5MB. That's the
// window where "dims known from first 2KB" vs "dims known after
// full transfer" becomes a visible delta, even on fast connections.
const PHOTO: PhotoDescriptor = {
  seed: 'preimage-ttfs-highres',
  width: 4800,
  height: 3200,
  caption: 'high-res landscape',
}

const PANEL_WIDTH = 340
const MAX_FRAME_HEIGHT = 260

type Event = { label: string; t: number; note?: string }

function renderEvents(host: HTMLElement, events: Event[], shifts: number): void {
  host.innerHTML = ''
  for (const ev of events) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<span>${ev.label}</span><span><b>${ev.t.toFixed(1)}ms</b>${ev.note !== undefined ? ` · ${ev.note}` : ''}</span>`
    host.appendChild(row)
  }
  const shiftRow = document.createElement('div')
  shiftRow.className = 'row'
  shiftRow.innerHTML = `<span>visible shifts</span><span${shifts > 0 ? ' class="shift"' : ''}><b>${shifts}</b></span>`
  host.appendChild(shiftRow)
}

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

async function resolveUrl(
  useLive: boolean,
  cacheBust: string | null,
  panelTag: string,
): Promise<string> {
  if (useLive) {
    const base = picsumUrl(PHOTO, cacheBust)
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}panel=${panelTag}`
  }
  const blob = await generateFallbackBlob(PHOTO, 200 + panelTag.length * 37)
  return URL.createObjectURL(blob)
}

function setMeta(useLive: boolean, cacheBust: string | null): void {
  metaEl.textContent =
    `${PHOTO.width}×${PHOTO.height} · ` +
    (useLive
      ? `picsum.photos (${cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — real network'})`
      : 'picsum offline — canvas fallback (no realistic network time)')
}

function sizedFrame(
  host: HTMLElement,
  naturalW: number,
  naturalH: number,
): HTMLElement {
  host.innerHTML = ''
  host.classList.remove('empty')
  host.classList.add('measured')
  const scale = PANEL_WIDTH / naturalW
  const h = Math.min(naturalH * scale, MAX_FRAME_HEIGHT)
  const w = h * (naturalW / naturalH)
  host.style.width = `${w}px`
  host.style.height = `${h}px`
  return host
}

// --- Panel 1: naive img ---

async function runNaive(): Promise<void> {
  run1.disabled = true
  run1.textContent = 'Running…'
  f1.innerHTML = ''
  f1.classList.add('empty')
  f1.style.width = ''
  f1.style.height = ''
  r1.innerHTML = ''
  renderEvents(e1, [
    { label: 'dims known (onload)', t: 0 },
    { label: 'image painted', t: 0 },
  ], 0)
  e1.innerHTML = `<div class="row"><span>dims known (onload)</span><span><b>&mdash;</b></span></div><div class="row"><span>image painted</span><span><b>&mdash;</b></span></div><div class="row"><span>visible shifts</span><span><b>&mdash;</b></span></div>`

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust)
  const url = await resolveUrl(useLive, cacheBust, 'naive')

  const t0 = performance.now()
  const img = document.createElement('img')
  img.alt = ''
  f1.appendChild(img)
  const stage = f1.parentElement!
  const monitor = observeShifts(stage)
  await new Promise<void>((resolve) => {
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = url
  })
  const t = performance.now() - t0
  monitor.stop()
  renderEvents(
    e1,
    [
      { label: 'dims known (onload)', t },
      { label: 'image painted', t },
    ],
    monitor.shifts(),
  )
  r1.innerHTML = `<b>${t.toFixed(0)}ms</b> · ${monitor.shifts()} shifts`
  run1.disabled = false
  run1.textContent = 'Run again'
}

// --- Panel 2: declared width/height attrs ---

async function runNative(): Promise<void> {
  run2.disabled = true
  run2.textContent = 'Running…'
  f2.innerHTML = ''
  f2.classList.add('empty')
  f2.style.width = ''
  f2.style.height = ''
  r2.innerHTML = ''
  e2.innerHTML = `<div class="row"><span>dims known (from attrs)</span><span><b>&mdash;</b></span></div><div class="row"><span>image painted</span><span><b>&mdash;</b></span></div><div class="row"><span>visible shifts</span><span><b>&mdash;</b></span></div>`

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust)
  const url = await resolveUrl(useLive, cacheBust, 'native')

  const t0 = performance.now()
  const frame = sizedFrame(f2, PHOTO.width, PHOTO.height)
  const frameAt = performance.now() - t0
  const img = document.createElement('img')
  img.width = PHOTO.width
  img.height = PHOTO.height
  frame.appendChild(img)
  const stage = f2.parentElement!
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
  renderEvents(
    e2,
    [
      { label: 'dims known (from attrs)', t: frameAt },
      { label: 'image painted', t: paintedAt },
    ],
    monitor.shifts(),
  )
  r2.innerHTML = `<b>${paintedAt.toFixed(0)}ms</b> · ${monitor.shifts()} shifts`
  run2.disabled = false
  run2.textContent = 'Run again'
}

// --- Panel 3: prepare() ---

async function runPreimage(): Promise<void> {
  run3.disabled = true
  run3.textContent = 'Running…'
  f3.innerHTML = ''
  f3.classList.add('empty')
  f3.style.width = ''
  f3.style.height = ''
  r3.innerHTML = ''
  e3.innerHTML = `<div class="row"><span>dims known (prepare)</span><span><b>&mdash;</b></span></div><div class="row"><span>image painted</span><span><b>&mdash;</b></span></div><div class="row"><span>dominant color at</span><span><b>&mdash;</b></span></div><div class="row"><span>visible shifts</span><span><b>&mdash;</b></span></div>`

  const useLive = await picsumReachable()
  const cacheBust = getCacheBust()
  setMeta(useLive, cacheBust)
  const url = await resolveUrl(useLive, cacheBust, 'preimage')

  const t0 = performance.now()
  const prepared = await prepare(url, { extractDominantColor: true })
  const m = getMeasurement(prepared)
  const preparedAt = performance.now() - t0
  const frame = sizedFrame(f3, m.naturalWidth, m.naturalHeight)
  let colorAt = 0
  const colorPromise = waitForDominantColor(prepared).then((color) => {
    if (color === null) return null
    frame.style.backgroundColor = color
    colorAt = performance.now() - t0
    return color
  })
  const img = document.createElement('img')
  frame.appendChild(img)
  const stage = f3.parentElement!
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
  const color = await colorPromise
  monitor.stop()
  const events: Event[] = [
    { label: 'dims known (prepare)', t: preparedAt, note: `${m.naturalWidth}×${m.naturalHeight}` },
    { label: 'image painted', t: paintedAt },
    { label: 'dominant color at', t: colorAt, note: color ?? 'unavailable' },
  ]
  renderEvents(e3, events, monitor.shifts())
  r3.innerHTML = `dims in <b>${preparedAt.toFixed(0)}ms</b> · painted at <b>${paintedAt.toFixed(0)}ms</b> · ${monitor.shifts()} shifts`
  run3.disabled = false
  run3.textContent = 'Run again'
}

run1.addEventListener('click', () => void runNaive())
run2.addEventListener('click', () => void runNative())
run3.addEventListener('click', () => void runPreimage())
