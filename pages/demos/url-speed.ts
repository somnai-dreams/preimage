import {
  clearCache,
  clearOriginStrategyCache,
  getOriginStrategy,
  prepare,
  type PreparedImage,
} from '@somnai-dreams/preimage'
import { fmtBytes, fmtMs } from './demo-formatting.js'
import { assetUrl } from './photo-source.js'
import { getConcurrency, getStrategy, type ProbeStrategy } from './nav-concurrency.js'

type ParsedUrl = {
  raw: string
  url: string
}

type RowDom = {
  row: HTMLElement
  preview: HTMLElement
  note: HTMLElement
  dims: HTMLElement
  image: HTMLElement
  ttfb: HTMLElement
  download: HTMLElement
  total: HTMLElement
  bytes: HTMLElement
  strategy: HTMLElement
  source: HTMLElement
}

type RowResult = {
  state: 'queued' | 'measuring' | 'loaded' | 'error' | 'cancelled'
  dimsMs: number | null
  imageMs: number | null
  ttfbMs: number | null
  downloadMs: number | null
  totalMs: number | null
  error: string | null
}

type ResourceTimingSummary = {
  ttfbMs: number | null
  downloadMs: number | null
  bytes: number | null
}

type ActiveRun = {
  id: number
  startedAt: number
  controllers: Set<AbortController>
  images: Set<HTMLImageElement>
  results: RowResult[]
  rows: RowDom[]
  cancelled: boolean
}

const URLS_KEY = 'preimage-url-speed-urls'
const MAX_URLS = 200

const urlsInput = document.getElementById('urls') as HTMLTextAreaElement
const runBtn = document.getElementById('run') as HTMLButtonElement
const stopBtn = document.getElementById('stop') as HTMLButtonElement
const sampleBtn = document.getElementById('sample') as HTMLButtonElement
const clearCacheBtn = document.getElementById('clearCache') as HTMLButtonElement
const cacheBustInput = document.getElementById('cacheBust') as HTMLInputElement
const metaEl = document.getElementById('meta')!
const resultsEl = document.getElementById('results')!
const sumComplete = document.getElementById('sumComplete')!
const sumDims = document.getElementById('sumDims')!
const sumImage = document.getElementById('sumImage')!
const sumTotal = document.getElementById('sumTotal')!
const sumErrors = document.getElementById('sumErrors')!

let nextRunId = 0
let activeRun: ActiveRun | null = null

urlsInput.value = localStorage.getItem(URLS_KEY) ?? ''
updateMeta()

urlsInput.addEventListener('input', () => {
  localStorage.setItem(URLS_KEY, urlsInput.value)
  updateMeta()
})
runBtn.addEventListener('click', () => void runSpeedTest())
stopBtn.addEventListener('click', () => stopActiveRun(true))
sampleBtn.addEventListener('click', () => {
  urlsInput.value = sampleUrls()
  localStorage.setItem(URLS_KEY, urlsInput.value)
  updateMeta()
})
clearCacheBtn.addEventListener('click', () => {
  clearCache()
  clearOriginStrategyCache()
  clearCacheBtn.textContent = 'Cleared'
  setTimeout(() => {
    clearCacheBtn.textContent = 'Clear cache'
  }, 900)
})

function sampleUrls(): string {
  return [
    assetUrl('assets/demos/photos/08.png'),
    assetUrl('assets/demos/photos/13.png'),
    assetUrl('assets/demos/photos/28.png'),
    assetUrl('assets/demos/photos/34.png'),
  ].join('\n')
}

function updateMeta(): void {
  const parsed = parseUrls(urlsInput.value)
  const count = parsed.urls.length
  const invalid = parsed.invalid.length
  metaEl.textContent = `${count} URL${count === 1 ? '' : 's'}${invalid === 0 ? '' : ` · ${invalid} invalid`}`
}

function parseUrls(raw: string): { urls: ParsedUrl[]; invalid: string[] } {
  const urls: ParsedUrl[] = []
  const invalid: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = new URL(trimmed, location.href)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        invalid.push(trimmed)
        continue
      }
      urls.push({ raw: trimmed, url: parsed.href })
    } catch {
      invalid.push(trimmed)
    }
  }
  return { urls: urls.slice(0, MAX_URLS), invalid }
}

async function runSpeedTest(): Promise<void> {
  stopActiveRun(false)
  const parsed = parseUrls(urlsInput.value)
  updateMeta()
  if (parsed.urls.length === 0) {
    renderEmpty(parsed.invalid.length === 0 ? 'Paste image URLs and run the speed test.' : 'No valid HTTP(S) image URLs found.')
    resetSummary()
    return
  }

  const urls = parsed.urls.map((item, index) => ({
    raw: item.raw,
    url: cacheBustInput.checked ? withCacheBust(item.url, index) : item.url,
  }))
  performance.clearResourceTimings()
  performance.setResourceTimingBufferSize?.(Math.max(3000, urls.length * 6))
  const rows = urls.map((item, index) => createRow(index, item.raw, item.url))
  const run: ActiveRun = {
    id: ++nextRunId,
    startedAt: performance.now(),
    controllers: new Set(),
    images: new Set(),
    results: urls.map(() => ({
      state: 'queued',
      dimsMs: null,
      imageMs: null,
      ttfbMs: null,
      downloadMs: null,
      totalMs: null,
      error: null,
    })),
    rows,
    cancelled: false,
  }
  activeRun = run

  resultsEl.replaceChildren(...rows.map((row) => row.row))
  resetSummary()
  updateSummary(run)
  runBtn.disabled = true
  stopBtn.disabled = false
  runBtn.textContent = 'Running...'

  const concurrency = Math.min(getConcurrency(), urls.length)
  let next = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (isActive(run)) {
      const index = next++
      if (index >= urls.length) return
      await measureOne(run, rows[index]!, urls[index]!.url, index)
    }
  })
  await Promise.all(workers)

  if (activeRun === run) {
    activeRun = null
    runBtn.disabled = false
    stopBtn.disabled = true
    runBtn.textContent = 'Run again'
    updateSummary(run)
  }
}

async function measureOne(run: ActiveRun, row: RowDom, url: string, index: number): Promise<void> {
  const controller = new AbortController()
  run.controllers.add(controller)
  const t0 = performance.now()
  setRowState(run, index, row, 'measuring', 'Measuring dimensions')

  let img: HTMLImageElement | null = null
  try {
    const strategy = getStrategy()
    const preparedResult = await prepareWithImgFallback(url, strategy, controller.signal)
    if (!isActive(run)) return

    const dimsAt = performance.now() - t0
    const prepared = preparedResult.prepared
    run.results[index]!.dimsMs = dimsAt
    row.dims.textContent = fmtMs(dimsAt)
    row.note.textContent = `${prepared.width}×${prepared.height}`
    row.strategy.textContent = strategyLabel(strategy, url, prepared, preparedResult.fallback)
    row.source.textContent = prepared.source
    applyTiming(row, run.results[index]!, url, prepared.byteLength)

    img = prepared.element ?? new Image()
    img.alt = ''
    img.decoding = 'async'
    run.images.add(img)
    row.preview.classList.remove('tile-shimmer')
    row.preview.replaceChildren(img)
    if (prepared.element === null) img.src = url

    await waitForImage(img, controller.signal)
    if (!isActive(run)) return

    const imageAt = performance.now() - t0
    const totalAt = performance.now() - run.startedAt
    row.image.textContent = fmtMs(imageAt)
    row.total.textContent = fmtMs(totalAt)
    applyTiming(row, run.results[index]!, url, prepared.byteLength)
    setRowState(run, index, row, 'loaded', `${prepared.width}×${prepared.height}`)
    run.results[index]!.imageMs = imageAt
    run.results[index]!.totalMs = totalAt
    updateSummary(run)
  } catch (err) {
    if (controller.signal.aborted || !isActive(run)) {
      markCancelled(run, row, index)
      return
    }
    const message = errorMessage(err)
    run.results[index]!.error = message
    setRowState(run, index, row, 'error', message)
    updateSummary(run)
  } finally {
    run.controllers.delete(controller)
    if (img !== null) run.images.delete(img)
  }
}

async function prepareWithImgFallback(
  url: string,
  strategy: ProbeStrategy,
  signal: AbortSignal,
): Promise<{ prepared: PreparedImage; fallback: boolean }> {
  try {
    return {
      prepared: await prepare(url, {
        strategy,
        fallbackToImgOnFetchError: true,
        signal,
      }),
      fallback: false,
    }
  } catch (err) {
    if (signal.aborted || strategy === 'img') throw err
    return {
      prepared: await prepare(url, { strategy: 'img', signal }),
      fallback: true,
    }
  }
}

function createRow(index: number, rawUrl: string, measuredUrl: string): RowDom {
  const row = document.createElement('div')
  row.className = 'speed-row'

  const preview = document.createElement('div')
  preview.className = 'preview tile-shimmer'
  const previewIndex = document.createElement('span')
  previewIndex.className = 'preview-index'
  previewIndex.textContent = String(index + 1)
  preview.appendChild(previewIndex)

  const urlCell = document.createElement('div')
  urlCell.className = 'url-cell'
  const link = document.createElement('a')
  link.href = measuredUrl
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = rawUrl
  const note = document.createElement('span')
  note.className = 'row-note'
  note.textContent = 'Queued'
  urlCell.append(link, note)

  const dims = metric('Dims')
  const image = metric('Image')
  const ttfb = metric('TTFB')
  const download = metric('Download')
  const total = metric('Total')
  const bytes = metric('Size')
  const strategy = metric('Strategy')
  const source = metric('Source')
  row.append(
    preview,
    urlCell,
    dims.host,
    image.host,
    ttfb.host,
    download.host,
    total.host,
    bytes.host,
    strategy.host,
    source.host,
  )
  return {
    row,
    preview,
    note,
    dims: dims.value,
    image: image.value,
    ttfb: ttfb.value,
    download: download.value,
    total: total.value,
    bytes: bytes.value,
    strategy: strategy.value,
    source: source.value,
  }
}

function metric(labelText: string): { host: HTMLElement; value: HTMLElement } {
  const host = document.createElement('div')
  host.className = 'metric'
  const label = document.createElement('span')
  label.className = 'metric-label'
  label.textContent = labelText
  const value = document.createElement('span')
  value.className = 'metric-value'
  value.textContent = '—'
  host.append(label, value)
  return { host, value }
}

function setRowState(
  run: ActiveRun,
  index: number,
  row: RowDom,
  state: RowResult['state'],
  note: string,
): void {
  run.results[index]!.state = state
  row.row.classList.toggle('is-error', state === 'error')
  row.note.textContent = note
  if (state === 'loaded') row.preview.classList.remove('tile-shimmer')
  updateSummary(run)
}

function markCancelled(run: ActiveRun, row: RowDom, index: number): void {
  run.results[index]!.state = 'cancelled'
  row.preview.classList.remove('tile-shimmer')
  row.note.textContent = 'Cancelled'
  updateSummary(run)
}

function waitForImage(img: HTMLImageElement, signal: AbortSignal): Promise<void> {
  if (img.complete) {
    return img.naturalWidth > 0
      ? Promise.resolve()
      : Promise.reject(new Error('image failed to load'))
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      img.removeEventListener('load', onLoad)
      img.removeEventListener('error', onError)
    }
    const onLoad = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('image failed to load'))
    }
    const onAbort = (): void => {
      cleanup()
      reject(new DOMException('Image load aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    img.addEventListener('load', onLoad, { once: true })
    img.addEventListener('error', onError, { once: true })
  })
}

function withCacheBust(url: string, index: number): string {
  const parsed = new URL(url)
  parsed.searchParams.set('_preimage_speed', `${Date.now().toString(36)}-${nextRunId + 1}-${index}`)
  return parsed.href
}

function strategyLabel(
  selected: ProbeStrategy,
  url: string,
  prepared: PreparedImage,
  fallback: boolean,
): string {
  if (fallback) return `${selected} → img`
  if (selected !== 'auto') return selected
  const actual = getOriginStrategy(originOf(url))
  if (actual !== null) return `auto → ${actual}`
  if (prepared.source === 'cache') return 'auto · cache'
  if (prepared.source === 'url-pattern') return 'auto · URL'
  return 'auto'
}

function originOf(url: string): string {
  try {
    return new URL(url, location.href).origin
  } catch {
    return ''
  }
}

function applyTiming(
  row: RowDom,
  result: RowResult,
  url: string,
  preparedByteLength: number | null,
): void {
  const timing = resourceTiming(url)
  result.ttfbMs = timing.ttfbMs
  result.downloadMs = timing.downloadMs
  row.ttfb.textContent = fmtMs(timing.ttfbMs)
  row.download.textContent = fmtMs(timing.downloadMs)
  row.bytes.textContent = fmtBytes(preparedByteLength ?? timing.bytes)
}

function resourceTiming(url: string): ResourceTimingSummary {
  const entries = performance.getEntriesByName(url)
    .filter((entry): entry is PerformanceResourceTiming => entry.entryType === 'resource')
  const preferred = latestResource(entries.filter((entry) => entry.initiatorType === 'img'))
  const resource = preferred ?? latestResource(entries)
  if (resource === null) {
    return { ttfbMs: null, downloadMs: null, bytes: null }
  }
  return {
    ttfbMs: timingDelta(resource.requestStart, resource.responseStart),
    downloadMs: timingDelta(resource.responseStart, resource.responseEnd),
    bytes: resourceBytes(resource),
  }
}

function latestResource(entries: PerformanceResourceTiming[]): PerformanceResourceTiming | null {
  let latest: PerformanceResourceTiming | null = null
  for (const entry of entries) {
    if (latest === null || entry.startTime > latest.startTime) latest = entry
  }
  return latest
}

function timingDelta(start: number, end: number): number | null {
  if (start <= 0 || end <= 0 || end < start) return null
  return end - start
}

function resourceBytes(resource: PerformanceResourceTiming): number | null {
  const bytes = Math.max(resource.transferSize || 0, resource.encodedBodySize || 0)
  return bytes > 0 ? bytes : null
}

function stopActiveRun(markRows: boolean): void {
  const run = activeRun
  if (run === null) return
  run.cancelled = true
  for (const controller of run.controllers) controller.abort()
  for (const img of run.images) img.src = ''
  if (markRows) {
    for (let i = 0; i < run.results.length; i++) {
      const result = run.results[i]!
      if (result.state === 'queued' || result.state === 'measuring') {
        result.state = 'cancelled'
        const row = run.rows[i]
        if (row !== undefined) {
          row.preview.classList.remove('tile-shimmer')
          row.note.textContent = 'Cancelled'
        }
      }
    }
    updateSummary(run)
  }
  activeRun = null
  runBtn.disabled = false
  stopBtn.disabled = true
  runBtn.textContent = 'Run again'
}

function isActive(run: ActiveRun): boolean {
  return activeRun === run && !run.cancelled
}

function updateSummary(run: ActiveRun): void {
  const complete = run.results.filter((result) => result.state === 'loaded').length
  const errors = run.results.filter((result) => result.state === 'error').length
  const dimsTimes = run.results.map((result) => result.dimsMs).filter((value): value is number => value !== null)
  const imageTimes = run.results.map((result) => result.imageMs).filter((value): value is number => value !== null)
  const totalTimes = run.results.map((result) => result.totalMs).filter((value): value is number => value !== null)
  sumComplete.textContent = `${complete}/${run.results.length}`
  sumDims.textContent = dimsTimes.length === 0 ? '—' : fmtMs(Math.min(...dimsTimes))
  sumImage.textContent = imageTimes.length === 0 ? '—' : fmtMs(Math.min(...imageTimes))
  sumTotal.textContent = totalTimes.length === 0 ? '—' : fmtMs(Math.max(...totalTimes))
  sumErrors.textContent = String(errors)
}

function resetSummary(): void {
  sumComplete.textContent = '—'
  sumDims.textContent = '—'
  sumImage.textContent = '—'
  sumTotal.textContent = '—'
  sumErrors.textContent = '—'
}

function renderEmpty(text: string): void {
  const div = document.createElement('div')
  div.className = 'empty-state'
  div.textContent = text
  resultsEl.replaceChildren(div)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
