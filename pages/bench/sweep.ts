import { PrepareQueue } from '@somnai-dreams/preimage'
import { cycledUrls } from '../demos/photo-source.js'
import {
  captureMetadata,
  distribution,
  fmtBytes,
  getNetworkLabel,
  saveRun,
  wireUploadButton,
  setNetworkLabel,
  type Distribution,
  type RunMetadata,
} from './common.js'

const nInput = document.getElementById('nInput') as HTMLInputElement
const concInput = document.getElementById('concInput') as HTMLInputElement
const dimsOnlyEl = document.getElementById('dimsOnly') as HTMLInputElement
const networkLabelEl = document.getElementById('networkLabel') as HTMLInputElement
networkLabelEl.value = getNetworkLabel()
networkLabelEl.addEventListener('input', () => setNetworkLabel(networkLabelEl.value.trim()))
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const uploadBtn = document.getElementById('upload') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const progressEl = document.getElementById('progress')!
const tableHost = document.getElementById('table-host')!
const jsonHost = document.getElementById('json-host')!

type Strategy = 'img' | 'stream' | 'range'

type SweepRow = {
  strategy: Strategy
  concurrency: number
  totalMs: number
  bytesTransferred: number
  perceivedMs: Distribution
  probeMs: Distribution
  queueWaitMs: Distribution
  throughputProbesPerSec: number
  resolved: number
  errors: number
}

type SweepParams = {
  n: number
  concurrencies: number[]
  strategies: Strategy[]
  dimsOnly: boolean
}

type SweepResults = {
  sweep: SweepRow[]
}

let lastRun: { meta: RunMetadata; params: SweepParams; results: SweepResults } | null = null

runBtn.addEventListener('click', () => { void run() })
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  saveRun(lastRun.meta, lastRun.params, lastRun.results)
})
wireUploadButton(uploadBtn, () => lastRun)

async function run(): Promise<void> {
  const n = Number(nInput.value)
  const concurrencies = concInput.value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x) && x >= 1)
  const strategies = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="strategy"]:checked'),
  ).map((el) => el.value as Strategy)
  const dimsOnly = dimsOnlyEl.checked

  if (concurrencies.length === 0 || strategies.length === 0) {
    progressEl.textContent = 'Pick at least one strategy and one concurrency.'
    return
  }

  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  saveBtn.disabled = true
  uploadBtn.disabled = true
  metaEl.textContent = ''
  progressEl.textContent = ''
  jsonHost.innerHTML = ''

  const meta = await captureMetadata(
    'probe-sweep',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )

  const params: SweepParams = { n, concurrencies, strategies, dimsOnly }
  const rows: SweepRow[] = []
  renderTable(rows, strategies, concurrencies)

  const total = strategies.length * concurrencies.length
  let done = 0
  for (const strategy of strategies) {
    for (const concurrency of concurrencies) {
      done++
      progressEl.textContent = `[${done}/${total}] strategy=${strategy} c=${concurrency} · running…`
      renderTable(rows, strategies, concurrencies, { strategy, concurrency })
      const row = await runOne(n, concurrency, strategy, dimsOnly)
      rows.push(row)
      renderTable(rows, strategies, concurrencies)
      // Yield a tick so the DOM updates between sub-runs.
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  progressEl.textContent = `[${total}/${total}] done · ${rows.length} sub-runs`
  lastRun = { meta, params, results: { sweep: rows } }
  renderJson(meta, params, rows)
  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  const rttBit = meta.network.warmupRttMs !== null ? ` · rtt ${meta.network.warmupRttMs.toFixed(0)}ms` : ''
  metaEl.textContent = `${meta.protocol ?? '?'}${rttBit}${labelBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
  uploadBtn.disabled = false
}

async function runOne(n: number, concurrency: number, strategy: Strategy, dimsOnly: boolean): Promise<SweepRow> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(n, token)

  const urlSet = new Set(
    urls.map((u) => new URL(u, location.href).pathname + new URL(u, location.href).search),
  )
  let bytes = 0
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntriesByType('resource')) {
      const parsed = new URL(entry.name, location.href)
      if (!urlSet.has(parsed.pathname + parsed.search)) continue
      const r = entry as PerformanceResourceTiming
      bytes += Math.max(r.transferSize ?? 0, r.encodedBodySize ?? 0)
    }
  })
  observer.observe({ type: 'resource', buffered: true })

  const queue = new PrepareQueue({ concurrency })
  const t0 = performance.now()
  const perceived: number[] = []
  let errors = 0

  await Promise.all(
    urls.map((url) => {
      const tEnqueue = performance.now()
      return queue
        .enqueue(url, { dimsOnly, strategy })
        .then(() => perceived.push(performance.now() - tEnqueue))
        .catch(() => { errors++ })
    }),
  )
  const totalMs = performance.now() - t0
  await new Promise((r) => setTimeout(r, 60))
  observer.disconnect()

  const firstBatch = [...perceived].sort((a, b) => a - b).slice(0, Math.min(concurrency, n))
  const probeEstimate = firstBatch.length > 0 ? firstBatch[Math.floor(firstBatch.length / 2)]! : 0
  const probes: number[] = []
  const waits: number[] = []
  for (const p of perceived) {
    probes.push(Math.min(p, probeEstimate * 2))
    waits.push(Math.max(0, p - probeEstimate))
  }

  return {
    strategy,
    concurrency,
    totalMs,
    bytesTransferred: bytes,
    perceivedMs: distribution(perceived),
    probeMs: distribution(probes),
    queueWaitMs: distribution(waits),
    throughputProbesPerSec: (n / totalMs) * 1000,
    resolved: perceived.length,
    errors,
  }
}

function renderTable(
  rows: readonly SweepRow[],
  strategies: readonly Strategy[],
  concurrencies: readonly number[],
  active?: { strategy: Strategy; concurrency: number },
): void {
  // Build the full grid including pending cells so the table shape
  // doesn't jump as sub-runs complete.
  type Cell = { row?: SweepRow; running?: boolean; pending?: boolean }
  const grid: Array<Array<{ strategy: Strategy; concurrency: number } & Cell>> = []
  for (const strategy of strategies) {
    const line: Array<{ strategy: Strategy; concurrency: number } & Cell> = []
    for (const concurrency of concurrencies) {
      const done = rows.find((r) => r.strategy === strategy && r.concurrency === concurrency)
      if (done !== undefined) line.push({ strategy, concurrency, row: done })
      else if (active?.strategy === strategy && active.concurrency === concurrency) {
        line.push({ strategy, concurrency, running: true })
      } else line.push({ strategy, concurrency, pending: true })
    }
    grid.push(line)
  }

  // Find best tp per strategy so we can highlight it.
  const bestByStrategy = new Map<Strategy, number>()
  for (const r of rows) {
    const cur = bestByStrategy.get(r.strategy)
    if (cur === undefined || r.throughputProbesPerSec > cur) {
      bestByStrategy.set(r.strategy, r.throughputProbesPerSec)
    }
  }

  const table = document.createElement('table')
  table.className = 'sweep-table'
  const thead = document.createElement('thead')
  thead.innerHTML = `<tr>
    <th>Strategy</th><th>c</th>
    <th>Total</th><th>Throughput</th>
    <th>Probe p50</th><th>Perceived p50</th><th>Perceived p95</th>
    <th>Bytes/probe</th><th>Errors</th>
  </tr>`
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  for (const line of grid) {
    for (const cell of line) {
      const tr = document.createElement('tr')
      if (cell.running === true) tr.className = 'running'
      else if (cell.row !== undefined) {
        tr.className = 'done'
        if (bestByStrategy.get(cell.strategy) === cell.row.throughputProbesPerSec) {
          tr.classList.add('best')
        }
      }
      if (cell.row !== undefined) {
        const r = cell.row
        tr.innerHTML = `
          <td class="strat">${cell.strategy}</td>
          <td>${cell.concurrency}</td>
          <td>${r.totalMs.toFixed(0)}ms</td>
          <td class="tp">${r.throughputProbesPerSec.toFixed(1)}/s</td>
          <td>${r.probeMs.p50.toFixed(1)}ms</td>
          <td>${r.perceivedMs.p50.toFixed(0)}ms</td>
          <td>${r.perceivedMs.p95.toFixed(0)}ms</td>
          <td>${fmtBytes(r.bytesTransferred / r.resolved)}</td>
          <td>${r.errors}</td>`
      } else if (cell.running === true) {
        tr.innerHTML = `<td class="strat">${cell.strategy}</td><td>${cell.concurrency}</td><td colspan="7">running…</td>`
      } else {
        tr.innerHTML = `<td class="strat">${cell.strategy}</td><td>${cell.concurrency}</td><td colspan="7">—</td>`
      }
      tbody.appendChild(tr)
    }
  }
  table.appendChild(tbody)
  tableHost.innerHTML = ''
  tableHost.appendChild(table)
}

function renderJson(meta: RunMetadata, params: SweepParams, rows: SweepRow[]): void {
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results: { sweep: rows } }, null, 2)
  jsonHost.innerHTML = ''
  jsonHost.appendChild(pre)
}
