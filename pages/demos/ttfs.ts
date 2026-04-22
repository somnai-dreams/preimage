import { prepare, getMeasurement, getElement } from '@somnai-dreams/preimage'
import { newCacheBustToken, photoUrl, PHOTOS } from './photo-source.js'
import { observeShifts } from './demo-utils.js'

const metaEl = document.getElementById('meta')!
const f1 = document.getElementById('f1')!
const f2 = document.getElementById('f2')!
const f3 = document.getElementById('f3')!
const e1 = document.getElementById('e1')!
const e2 = document.getElementById('e2')!
const e3 = document.getElementById('e3')!
const run1 = document.getElementById('run1') as HTMLButtonElement
const run2 = document.getElementById('run2') as HTMLButtonElement
const run3 = document.getElementById('run3') as HTMLButtonElement

// The biggest PNG in the manifest — 13.png (battle field) is
// 1344×896 at ~2.9MB. PNGs at this scale take meaningful time to
// transfer, which is the window where "dims from first 2KB" beats
// "dims after full transfer".
const PHOTO = PHOTOS[12]!

const PANEL_WIDTH = 340
const MAX_FRAME_HEIGHT = 260

function getCacheBust(): string | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="cache"]:checked')
  return checked?.value === 'off' ? null : newCacheBustToken()
}

function resolveUrl(cacheBust: string | null): string {
  return photoUrl(PHOTO, cacheBust)
}

function setMeta(cacheBust: string | null): void {
  metaEl.textContent =
    `${PHOTO.width}×${PHOTO.height} · local PNG · ` +
    (cacheBust === null ? 'HTTP cache allowed' : 'cache-busted — each run fetches fresh')
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

// --- Stat rendering: fill the pre-rendered rows by index. Values swap
//     into fixed slots so nothing reflows. ---

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(1)}ms`
}

function fill(
  host: HTMLElement,
  values: Array<{ value: string; note?: string }>,
  shifts: number,
): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    const row = rows[i]
    if (row === undefined) continue
    const b = row.querySelector('.value b')!
    b.innerHTML = v.value
    const existingNote = row.querySelector('.value .note')
    if (existingNote) existingNote.remove()
    if (v.note !== undefined) {
      const n = document.createElement('span')
      n.className = 'note'
      n.textContent = v.note
      row.querySelector('.value')!.appendChild(n)
    }
  }
  const shiftRow = host.querySelector<HTMLElement>('.row.shift')
  if (shiftRow !== null) {
    shiftRow.classList.toggle('has-shifts', shifts > 0)
    shiftRow.querySelector('.value b')!.innerHTML = String(shifts)
  }
}

function resetStatHost(host: HTMLElement): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (const row of rows) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
    const note = row.querySelector('.value .note')
    if (note) note.remove()
  }
  host.querySelector<HTMLElement>('.row.shift')?.classList.remove('has-shifts')
}

// --- Panel 1: naive img ---

async function runNaive(): Promise<void> {
  run1.disabled = true
  run1.textContent = 'Running…'
  f1.innerHTML = ''
  f1.classList.add('empty')
  f1.style.width = ''
  f1.style.height = ''
  resetStatHost(e1)

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const url = resolveUrl(cacheBust)

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
  // Naive: dims, space, and image all land at onload — no placeholder
  // reserves space beforehand.
  fill(
    e1,
    [
      { value: fmtMs(t) },
      { value: fmtMs(t) },
      { value: fmtMs(t) },
    ],
    monitor.shifts(),
  )
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
  resetStatHost(e2)

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const url = resolveUrl(cacheBust)

  const t0 = performance.now()
  // With declared attrs, dims are known the instant the <img> tag is
  // constructed — no network, no decode. Sizing the frame is the same
  // tick.
  const frame = sizedFrame(f2, PHOTO.width, PHOTO.height)
  const dimsAt = performance.now() - t0
  const reservedAt = performance.now() - t0
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
  fill(
    e2,
    [
      { value: fmtMs(dimsAt) },
      { value: fmtMs(reservedAt) },
      { value: fmtMs(paintedAt) },
    ],
    monitor.shifts(),
  )
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
  resetStatHost(e3)

  const cacheBust = getCacheBust()
  setMeta(cacheBust)
  const url = resolveUrl(cacheBust)

  const t0 = performance.now()
  const prepared = await prepare(url)
  const m = getMeasurement(prepared)
  const dimsAt = performance.now() - t0
  const frame = sizedFrame(f3, m.naturalWidth, m.naturalHeight)
  const reservedAt = performance.now() - t0
  // Reuse the warmed <img> prepare() already has in flight so there's
  // exactly one network fetch. Only fall back to a fresh element when
  // the prepared measurement came from a non-<img> path (cache hit,
  // URL-pattern shortcut).
  const warmed = getElement(prepared)
  const img = warmed ?? new Image()
  if (warmed === null) img.src = url
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
      img.addEventListener('load', done, { once: true })
      img.addEventListener('error', done, { once: true })
    }
  })
  const paintedAt = performance.now() - t0
  monitor.stop()
  fill(
    e3,
    [
      { value: fmtMs(dimsAt), note: `${m.naturalWidth}×${m.naturalHeight}` },
      { value: fmtMs(reservedAt) },
      { value: fmtMs(paintedAt) },
    ],
    monitor.shifts(),
  )
  run3.disabled = false
  run3.textContent = 'Run again'
}

run1.addEventListener('click', () => void runNaive())
run2.addEventListener('click', () => void runNative())
run3.addEventListener('click', () => void runPreimage())
