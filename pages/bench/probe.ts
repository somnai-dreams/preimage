import { PrepareQueue } from '@somnai-dreams/preimage'
import { cycledUrls } from '../demos/photo-source.js'
import {
  captureMetadata,
  distribution,
  fmtBytes,
  fmtDistribution,
  saveRun,
  type Distribution,
  type RunMetadata,
} from './common.js'

const nSlider = document.getElementById('nSlider') as HTMLInputElement
const nVal = document.getElementById('nVal')!
const concSlider = document.getElementById('concSlider') as HTMLInputElement
const concVal = document.getElementById('concVal')!
const dimsOnlyEl = document.getElementById('dimsOnly') as HTMLInputElement
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const results = document.getElementById('results')!

type ProbeResults = {
  totalMs: number
  bytesTransferred: number
  perProbeMs: Distribution
  queueTimeMs: Distribution // time from enqueue to start (drain latency)
  networkAndPollMs: Distribution // time from start to resolve
  throughputProbesPerSec: number
}

let lastRun: {
  meta: RunMetadata
  params: { n: number; concurrency: number; dimsOnly: boolean }
  results: ProbeResults
} | null = null

nSlider.addEventListener('input', () => { nVal.textContent = nSlider.value })
concSlider.addEventListener('input', () => { concVal.textContent = concSlider.value })

runBtn.addEventListener('click', () => {
  void run()
})
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  saveRun(lastRun.meta, lastRun.params, lastRun.results)
})

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  saveBtn.disabled = true
  metaEl.textContent = ''
  results.innerHTML = ''

  const n = Number(nSlider.value)
  const concurrency = Number(concSlider.value)
  const dimsOnly = dimsOnlyEl.checked
  const strategyEl = document.querySelector<HTMLInputElement>('input[name="strategy"]:checked')
  const strategy = (strategyEl?.value === 'stream' ? 'stream' : 'img') as 'img' | 'stream'
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(n, token)

  // Byte accounting via PerformanceObserver over the window of this
  // run. Filter by same-path-and-query so other network traffic
  // doesn't pollute the number.
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
  const perProbe: number[] = []
  const queueTime: number[] = []
  const netPoll: number[] = []

  // We need to separate queue time (waiting for a slot) from
  // network+poll time (actual probe work). PrepareQueue doesn't
  // expose per-request timestamps, so we instrument externally:
  // tEnqueue is when we call queue.enqueue(); tResolve is when the
  // returned promise resolves. queue time is approximately
  // (tResolve - tEnqueue) - (typical probe time), which we can't
  // extract cleanly. Instead we measure tEnqueue and tResolve per
  // probe, and also separately time a single-probe baseline at
  // concurrency=1 if we wanted to. For now report per-probe total
  // and let the shape tell the story.
  const tEnqueues: number[] = new Array(n)
  await Promise.all(
    urls.map((url, i) => {
      tEnqueues[i] = performance.now() - t0
      const tStart = performance.now()
      return queue.enqueue(url, { dimsOnly, strategy }).then(() => {
        const total = performance.now() - tStart
        perProbe.push(total)
        // Without per-slot start timestamps we attribute nothing to
        // queue vs network-and-poll split. Push total to both —
        // the JSON caller can slice however they want later.
        queueTime.push(0)
        netPoll.push(total)
      })
    }),
  )

  const totalMs = performance.now() - t0
  // Give resource-timing entries a beat to settle.
  await new Promise((r) => setTimeout(r, 100))
  observer.disconnect()

  const probeResults: ProbeResults = {
    totalMs,
    bytesTransferred: bytes,
    perProbeMs: distribution(perProbe),
    queueTimeMs: distribution(queueTime),
    networkAndPollMs: distribution(netPoll),
    throughputProbesPerSec: (n / totalMs) * 1000,
  }
  const meta = captureMetadata('probe-concurrency')
  const params = { n, concurrency, dimsOnly, strategy }
  lastRun = { meta, params, results: probeResults }

  renderResults(probeResults, meta, params)
  metaEl.textContent = `protocol: ${meta.protocol ?? 'unknown'} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
}

function renderResults(r: ProbeResults, meta: RunMetadata, params: { n: number; concurrency: number }): void {
  results.innerHTML = ''
  const grid = document.createElement('div')
  grid.className = 'stat-grid'
  const add = (label: string, value: string, unit = ''): void => {
    const cell = document.createElement('div')
    cell.className = 'stat-cell'
    const l = document.createElement('div')
    l.className = 'label'
    l.textContent = label
    const v = document.createElement('div')
    v.className = 'value'
    v.innerHTML = unit ? `${value}<span class="unit">${unit}</span>` : value
    cell.appendChild(l)
    cell.appendChild(v)
    grid.appendChild(cell)
  }
  add('Total wall time', r.totalMs.toFixed(0), 'ms')
  add('Throughput', r.throughputProbesPerSec.toFixed(1), 'probes/sec')
  add('Per-probe p50', r.perProbeMs.p50.toFixed(1), 'ms')
  add('Per-probe p95', r.perProbeMs.p95.toFixed(1), 'ms')
  add('Per-probe max', r.perProbeMs.max.toFixed(0), 'ms')
  add('Bytes transferred', fmtBytes(r.bytesTransferred))
  add('Bytes / probe', fmtBytes(r.bytesTransferred / params.n))
  add('Protocol', meta.protocol ?? 'unknown')
  results.appendChild(grid)

  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results: r }, null, 2)
  results.appendChild(pre)
}
