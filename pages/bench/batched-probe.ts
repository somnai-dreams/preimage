import { prepare } from '@somnai-dreams/preimage'
import { configureBatchedProbe } from '@somnai-dreams/preimage/batched-probe'
import { cycledUrls } from '../demos/photo-source.js'
import {
  captureMetadata,
  distribution,
  fmtBytes,
  type Distribution,
  type RunMetadata,
} from './common.js'

const nInput = document.getElementById('nInput') as HTMLInputElement
const batchSizeInput = document.getElementById('batchSize') as HTMLInputElement
const batchDelayInput = document.getElementById('batchDelay') as HTMLInputElement
const runBtn = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const statHost = document.getElementById('stat-host')!
const jsonHost = document.getElementById('json-host')!

type BenchParams = {
  n: number
  strategy: 'batched' | 'auto'
  batchSize: number
  batchDelayMs: number
}

type BenchResults = {
  totalMs: number
  bytesOnWire: number
  perceivedMs: Distribution
  throughputProbesPerSec: number
  resolved: number
  errors: number
  requestCount: number
}

let lastRun: { meta: RunMetadata; params: BenchParams; results: BenchResults } | null = null

runBtn.addEventListener('click', () => { void run() })

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  metaEl.textContent = ''
  statHost.innerHTML = ''
  jsonHost.innerHTML = ''

  const n = Number(nInput.value)
  const batchSize = Number(batchSizeInput.value)
  const batchDelayMs = Number(batchDelayInput.value)
  const strategyEl = document.querySelector<HTMLInputElement>('input[name="strategy"]:checked')
  const strategy = (strategyEl?.value ?? 'batched') as 'batched' | 'auto'

  configureBatchedProbe({
    endpoint: new URL('/preimage/probe', location.href).href,
    maxBatchSize: batchSize,
    maxBatchDelayMs: batchDelayMs,
  })

  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(n, token)

  // Byte accounting. For strategy=batched, byte accounting covers
  // the /preimage/probe request+response (the measurement payload).
  // For strategy=auto, it covers the range/stream fetches per URL.
  const startEntries = performance.getEntriesByType('resource').length
  // Count POSTs to the probe endpoint for the batch-count metric.
  const probeEndpointPath = new URL('/preimage/probe', location.href).pathname
  const urlSet = new Set(
    urls.map((u) => {
      const parsed = new URL(u, location.href)
      return parsed.pathname + parsed.search
    }),
  )

  const t0 = performance.now()
  const perceived: number[] = []
  let errors = 0
  await Promise.all(
    urls.map((url) => {
      const tEnqueue = performance.now()
      return prepare(url, { dimsOnly: true, strategy })
        .then(() => {
          perceived.push(performance.now() - tEnqueue)
        })
        .catch(() => {
          errors++
        })
    }),
  )
  const totalMs = performance.now() - t0
  // Small settle to let the PerformanceObserver buffer flush.
  await new Promise((r) => setTimeout(r, 100))

  // Scan resource entries since run start.
  const allEntries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const relevant = allEntries.slice(startEntries)
  let bytesOnWire = 0
  let requestCount = 0
  for (const entry of relevant) {
    const parsed = new URL(entry.name, location.href)
    if (parsed.pathname === probeEndpointPath) {
      bytesOnWire += Math.max(entry.transferSize ?? 0, entry.encodedBodySize ?? 0)
      requestCount++
    } else if (urlSet.has(parsed.pathname + parsed.search)) {
      bytesOnWire += Math.max(entry.transferSize ?? 0, entry.encodedBodySize ?? 0)
      requestCount++
    }
  }

  const results: BenchResults = {
    totalMs,
    bytesOnWire,
    perceivedMs: distribution(perceived),
    throughputProbesPerSec: (n / totalMs) * 1000,
    resolved: perceived.length,
    errors,
    requestCount,
  }

  const meta = await captureMetadata(
    'batched-probe',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  const params: BenchParams = { n, strategy, batchSize, batchDelayMs }
  lastRun = { meta, params, results }
  void lastRun

  renderStats(results, params)
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results }, null, 2)
  jsonHost.appendChild(pre)

  const rttBit = meta.network.warmupRttMs !== null ? ` · rtt ${meta.network.warmupRttMs.toFixed(0)}ms` : ''
  metaEl.textContent = `${strategy} · n=${n} · ${meta.protocol ?? '?'}${rttBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
}

function renderStats(r: BenchResults, params: BenchParams): void {
  const grid = document.createElement('div')
  grid.className = 'stat-grid'
  const add = (label: string, value: string, unit = '', tone: 'good' | '' = ''): void => {
    const cell = document.createElement('div')
    cell.className = 'stat-cell' + (tone !== '' ? ` ${tone}` : '')
    const l = document.createElement('div')
    l.className = 'label'
    l.textContent = label
    const v = document.createElement('div')
    v.className = 'value'
    v.innerHTML = unit !== '' ? `${value}<span class="unit">${unit}</span>` : value
    cell.appendChild(l)
    cell.appendChild(v)
    grid.appendChild(cell)
  }
  add('Strategy', params.strategy)
  add('N URLs', String(params.n))
  add('Wall time', r.totalMs.toFixed(0), 'ms')
  add('Throughput', r.throughputProbesPerSec.toFixed(1), 'probes/s')
  add('HTTP requests', String(r.requestCount),
    '',
    params.strategy === 'batched' && r.requestCount <= Math.ceil(params.n / params.batchSize) ? 'good' : '')
  add('Bytes on wire', fmtBytes(r.bytesOnWire))
  add('Bytes / probe', fmtBytes(r.bytesOnWire / Math.max(1, r.resolved)))
  add('Perceived p50', r.perceivedMs.p50.toFixed(0), 'ms')
  add('Perceived p95', r.perceivedMs.p95.toFixed(0), 'ms')
  add('Errors', String(r.errors))
  statHost.innerHTML = ''
  statHost.appendChild(grid)
}
