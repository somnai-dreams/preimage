import {
  DEFAULT_RANGE_BYTES_BY_FORMAT,
  clearMeasurementCaches,
  detectImageFormat,
  prepare,
  type ImageFormat,
  type PrepareOptions,
} from '@somnai-dreams/preimage'
import {
  captureMetadata,
  distribution,
  getNetworkLabel,
  saveRun,
  setNetworkLabel,
  wireUploadButton,
  type Distribution,
  type RunMetadata,
} from './common.js'

// The formats we surface in the UI. Covers everything the library
// detects from URL extensions, minus 'ico' and 'apng' which the corpus
// doesn't meaningfully exercise.
const UI_FORMATS: ReadonlyArray<ImageFormat> = [
  'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'heic', 'bmp', 'unknown',
]

// --- DOM ---

const corpusSelect = document.getElementById('corpusSelect') as HTMLSelectElement
const corpusCountEl = document.getElementById('corpusCount')!
const perFormatCapSlider = document.getElementById('perFormatCap') as HTMLInputElement
const perFormatCapVal = document.getElementById('perFormatCapVal')!
const concSlider = document.getElementById('concSlider') as HTMLInputElement
const concVal = document.getElementById('concVal')!
const reRangeEl = document.getElementById('reRange') as HTMLInputElement
const networkLabelEl = document.getElementById('networkLabel') as HTMLInputElement
const formatGridEl = document.getElementById('formatGrid')!
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const uploadBtn = document.getElementById('upload') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const resultsEl = document.getElementById('results')!

networkLabelEl.value = getNetworkLabel()
networkLabelEl.addEventListener('input', () => setNetworkLabel(networkLabelEl.value.trim()))
perFormatCapSlider.addEventListener('input', () => { perFormatCapVal.textContent = perFormatCapSlider.value })
concSlider.addEventListener('input', () => { concVal.textContent = concSlider.value })
corpusSelect.addEventListener('change', () => { void loadAndGroupCorpus() })

// --- Per-format input grid ---

type FormatControl = {
  input: HTMLInputElement
  countEl: HTMLElement
}
const formatControls = new Map<ImageFormat, FormatControl>()

for (const fmt of UI_FORMATS) {
  const cell = document.createElement('div')
  cell.className = 'format-cell'
  const label = document.createElement('div')
  label.className = 'fmt-label'
  label.textContent = fmt
  cell.appendChild(label)

  const subLabel = document.createElement('div')
  subLabel.className = 'sub'
  subLabel.textContent = 'Range bytes'
  cell.appendChild(subLabel)

  const input = document.createElement('input')
  input.type = 'number'
  input.min = '32'
  input.step = '64'
  input.value = String(DEFAULT_RANGE_BYTES_BY_FORMAT[fmt])
  cell.appendChild(input)

  const sub2 = document.createElement('div')
  sub2.className = 'sub'
  sub2.textContent = 'URLs in corpus'
  cell.appendChild(sub2)

  const cnt = document.createElement('div')
  cnt.className = 'cnt'
  cnt.textContent = '…'
  cell.appendChild(cnt)

  formatGridEl.appendChild(cell)
  formatControls.set(fmt, { input, countEl: cnt })
}

// --- Corpus loading ---

type CorpusSample = {
  url: string
  expectedFormat?: string
  detectedFormat?: string | null
  host?: string
}

type FullCorpus = { samples?: CorpusSample[] }

let corpusByFormat: Map<ImageFormat, string[]> = new Map()

async function loadCorpusFile(path: string): Promise<CorpusSample[]> {
  try {
    const r = await fetch(path, { cache: 'no-store' })
    if (!r.ok) return []
    const j = (await r.json()) as FullCorpus
    return j.samples ?? []
  } catch {
    return []
  }
}

async function loadAndGroupCorpus(): Promise<void> {
  const selected = corpusSelect.value
  const sources: string[] = []
  if (selected === 'full' || selected === 'both') sources.push('/benchmarks/probe-byte-threshold-full.json')
  if (selected === 'modern2' || selected === 'both') sources.push('/benchmarks/probe-byte-threshold-modern2.json')

  const lists = await Promise.all(sources.map(loadCorpusFile))
  const samples = lists.flat()

  const grouped = new Map<ImageFormat, string[]>()
  const seen = new Set<string>()
  for (const s of samples) {
    if (seen.has(s.url)) continue
    seen.add(s.url)
    // Prefer detectedFormat (came back from actual probe); fall back
    // to expectedFormat (URL extension guess) or re-detect.
    let fmt: ImageFormat
    if (s.detectedFormat !== null && s.detectedFormat !== undefined && s.detectedFormat !== '') {
      fmt = s.detectedFormat as ImageFormat
    } else if (s.expectedFormat !== undefined && s.expectedFormat !== '') {
      fmt = s.expectedFormat as ImageFormat
    } else {
      fmt = detectImageFormat(s.url)
    }
    const list = grouped.get(fmt) ?? []
    list.push(s.url)
    grouped.set(fmt, list)
  }
  corpusByFormat = grouped

  let total = 0
  for (const fmt of UI_FORMATS) {
    const list = grouped.get(fmt) ?? []
    total += list.length
    const control = formatControls.get(fmt)
    if (control !== undefined) control.countEl.textContent = list.length.toString()
  }
  corpusCountEl.textContent = total.toString()
}

void loadAndGroupCorpus()

// --- Params + results shapes ---

type Params = {
  corpus: string
  perFormatCap: number
  concurrency: number
  reRangeEnabled: boolean
  rangeBytesByFormat: Record<string, number>
}

type PerFormatResult = {
  format: ImageFormat
  attempted: number
  succeeded: number
  failed: number
  successTimeMs: Distribution
  // Byte count reported by ultimate probe success (not always == requested bytes
  // because of 200 fallback full-body reads).
  probeBytes: Distribution
  failureReasons: Record<string, number>
  failingUrls: Array<{ url: string; reason: string }>
}

type Results = {
  wallMs: number
  perFormat: PerFormatResult[]
  overall: {
    attempted: number
    succeeded: number
    failed: number
    corsFailures: number
    probeFailures: number
    networkFailures: number
    successTimeMs: Distribution
  }
}

let lastRun: { meta: RunMetadata; params: Params; results: Results } | null = null

runBtn.addEventListener('click', () => { void run() })
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  saveRun(lastRun.meta, lastRun.params, lastRun.results)
})
wireUploadButton(uploadBtn, () => lastRun)

// --- Runner ---

function categorizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/yielded no dimensions/i.test(msg)) return 'probe-no-dims'
  if (/failed with status (4\d\d)/.test(msg)) {
    const m = msg.match(/status (\d+)/)
    return m !== null ? `http-${m[1]}` : 'http-4xx'
  }
  if (/failed with status (5\d\d)/.test(msg)) return 'http-5xx'
  // Browsers surface CORS as a TypeError with "failed to fetch" / "load failed".
  if (err instanceof TypeError) return 'cors-or-network'
  if (/abort/i.test(msg)) return 'aborted'
  return 'other'
}

function cacheBust(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_rc=${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

async function runBatch<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  const workers: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      while (true) {
        const j = idx++
        if (j >= items.length) return
        await worker(items[j]!)
      }
    })())
  }
  await Promise.all(workers)
}

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  saveBtn.disabled = true
  uploadBtn.disabled = true
  metaEl.textContent = ''
  resultsEl.innerHTML = ''

  const perFormatCap = Number(perFormatCapSlider.value)
  const concurrency = Number(concSlider.value)
  const reRangeEnabled = reRangeEl.checked

  const rangeBytesByFormat: Partial<Record<ImageFormat, number>> = {}
  for (const [fmt, control] of formatControls) {
    const v = Number(control.input.value)
    if (Number.isFinite(v) && v > 0) rangeBytesByFormat[fmt] = Math.floor(v)
  }

  // Start from a clean slate so cache hits don't skew timings.
  clearMeasurementCaches()

  const perFormatState = new Map<ImageFormat, {
    timings: number[]
    bytes: number[]
    succeeded: number
    failed: number
    attempted: number
    reasons: Map<string, number>
    failing: Array<{ url: string; reason: string }>
  }>()

  const allWork: Array<{ format: ImageFormat; url: string }> = []
  for (const fmt of UI_FORMATS) {
    const urls = corpusByFormat.get(fmt) ?? []
    const picked = urls.slice(0, perFormatCap)
    perFormatState.set(fmt, {
      timings: [], bytes: [], succeeded: 0, failed: 0, attempted: picked.length,
      reasons: new Map(), failing: [],
    })
    for (const u of picked) allWork.push({ format: fmt, url: u })
  }

  const t0 = performance.now()
  await runBatch(allWork, concurrency, async ({ format, url }) => {
    const state = perFormatState.get(format)!
    const prepareOptions: PrepareOptions = {
      strategy: 'range',
      dimsOnly: true,
      rangeBytesByFormat,
      rangeRetryBytes: reRangeEnabled ? 24576 : 0,
    }
    const t = performance.now()
    try {
      const p = await prepare(cacheBust(url), prepareOptions)
      const elapsed = performance.now() - t
      state.timings.push(elapsed)
      if (p.byteLength !== null) state.bytes.push(p.byteLength)
      state.succeeded++
    } catch (err) {
      const reason = categorizeError(err)
      state.failed++
      state.reasons.set(reason, (state.reasons.get(reason) ?? 0) + 1)
      if (state.failing.length < 10) {
        state.failing.push({ url, reason: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  const wallMs = performance.now() - t0

  const perFormat: PerFormatResult[] = []
  const allSuccessTimes: number[] = []
  let totalAttempted = 0
  let totalSucceeded = 0
  let totalFailed = 0
  let corsCount = 0
  let probeCount = 0
  let networkCount = 0
  for (const fmt of UI_FORMATS) {
    const state = perFormatState.get(fmt)
    if (state === undefined || state.attempted === 0) continue
    const reasons: Record<string, number> = {}
    for (const [k, v] of state.reasons) {
      reasons[k] = v
      if (k === 'cors-or-network') { corsCount += v; networkCount += v }
      else if (k === 'probe-no-dims') probeCount += v
    }
    for (const t of state.timings) allSuccessTimes.push(t)
    totalAttempted += state.attempted
    totalSucceeded += state.succeeded
    totalFailed += state.failed
    perFormat.push({
      format: fmt,
      attempted: state.attempted,
      succeeded: state.succeeded,
      failed: state.failed,
      successTimeMs: distribution(state.timings),
      probeBytes: distribution(state.bytes),
      failureReasons: reasons,
      failingUrls: state.failing,
    })
  }

  const results: Results = {
    wallMs,
    perFormat,
    overall: {
      attempted: totalAttempted,
      succeeded: totalSucceeded,
      failed: totalFailed,
      corsFailures: corsCount,
      probeFailures: probeCount,
      networkFailures: networkCount,
      successTimeMs: distribution(allSuccessTimes),
    },
  }

  const meta = await captureMetadata(
    'range-sizing',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  const params: Params = {
    corpus: corpusSelect.value,
    perFormatCap,
    concurrency,
    reRangeEnabled,
    rangeBytesByFormat: rangeBytesByFormat as Record<string, number>,
  }
  lastRun = { meta, params, results }
  renderResults(results, meta, params)

  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  metaEl.textContent = `c=${concurrency} · ${meta.protocol ?? '?'}${labelBit} · ${totalSucceeded}/${totalAttempted} ok · ${wallMs.toFixed(0)}ms wall`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
  uploadBtn.disabled = false
}

// --- Rendering ---

function renderResults(r: Results, meta: RunMetadata, params: Params): void {
  resultsEl.innerHTML = ''

  // Results table
  const table = document.createElement('table')
  table.className = 'results'
  const thead = document.createElement('thead')
  thead.innerHTML = `
    <tr>
      <th>Format</th>
      <th>Range bytes</th>
      <th>Attempted</th>
      <th>OK</th>
      <th>Fail</th>
      <th>p50 ms</th>
      <th>p95 ms</th>
      <th>Reasons</th>
    </tr>`
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  for (const row of r.perFormat) {
    const tr = document.createElement('tr')
    const rangeBytes = (params.rangeBytesByFormat as Record<string, number>)[row.format] ?? ''
    const reasonBits: string[] = []
    for (const [k, v] of Object.entries(row.failureReasons)) reasonBits.push(`${k}:${v}`)
    tr.innerHTML = `
      <td class="fmt">${row.format}</td>
      <td>${rangeBytes}</td>
      <td>${row.attempted}</td>
      <td class="ok">${row.succeeded}</td>
      <td class="${row.failed > 0 ? 'fail' : ''}">${row.failed}</td>
      <td>${row.successTimeMs.p50.toFixed(0)}</td>
      <td>${row.successTimeMs.p95.toFixed(0)}</td>
      <td style="font-size: 11px; color: var(--text-muted);">${reasonBits.join(', ')}</td>`
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  resultsEl.appendChild(table)

  // Overall
  const overall = document.createElement('div')
  overall.style.cssText = 'font-size: 13px; color: var(--text); margin-bottom: 14px;'
  overall.innerHTML = `
    <strong>Overall</strong>:
    ${r.overall.succeeded}/${r.overall.attempted} ok · ${r.overall.failed} failed
    (CORS/net ${r.overall.corsFailures}, probe ${r.overall.probeFailures}) ·
    p50 <span style="font-variant-numeric: tabular-nums;">${r.overall.successTimeMs.p50.toFixed(0)}ms</span>,
    p95 <span style="font-variant-numeric: tabular-nums;">${r.overall.successTimeMs.p95.toFixed(0)}ms</span> ·
    wall <span style="font-variant-numeric: tabular-nums;">${r.wallMs.toFixed(0)}ms</span>`
  resultsEl.appendChild(overall)

  // Failing URLs per format (first 10 each)
  for (const row of r.perFormat) {
    if (row.failingUrls.length === 0) continue
    const det = document.createElement('details')
    det.className = 'failures'
    det.innerHTML = `<summary>${row.format}: ${row.failingUrls.length} failures (first 10)</summary>`
    const ul = document.createElement('ul')
    for (const f of row.failingUrls) {
      const li = document.createElement('li')
      li.textContent = `[${f.reason}] ${f.url}`
      ul.appendChild(li)
    }
    det.appendChild(ul)
    resultsEl.appendChild(det)
  }

  // Raw JSON
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results: r }, null, 2)
  resultsEl.appendChild(pre)
}
