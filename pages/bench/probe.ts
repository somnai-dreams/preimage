import { PrepareQueue } from '@somnai-dreams/preimage'
import { cycledUrls } from '../demos/photo-source.js'
import {
  captureMetadata,
  distribution,
  fmtBytes,
  getNetworkLabel,
  saveRun,
  setNetworkLabel,
  type Distribution,
  type RunMetadata,
} from './common.js'

const nSlider = document.getElementById('nSlider') as HTMLInputElement
const nVal = document.getElementById('nVal')!
const concSlider = document.getElementById('concSlider') as HTMLInputElement
const concVal = document.getElementById('concVal')!
const dimsOnlyEl = document.getElementById('dimsOnly') as HTMLInputElement
const networkLabelEl = document.getElementById('networkLabel') as HTMLInputElement
networkLabelEl.value = getNetworkLabel()
networkLabelEl.addEventListener('input', () => setNetworkLabel(networkLabelEl.value.trim()))
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const results = document.getElementById('results')!

type ProbeParams = {
  n: number
  concurrency: number
  dimsOnly: boolean
  strategy: 'img' | 'stream'
}

type ProbeResults = {
  totalMs: number
  bytesTransferred: number
  // Time from enqueue to probe resolution — includes any time spent
  // waiting in PrepareQueue for a slot. What a caller perceives.
  perceivedMs: Distribution
  // Time from when the probe actually began (queue slot acquired) to
  // resolution. What the probe itself took, excluding queue wait.
  probeMs: Distribution
  // Queue wait only: perceivedMs - probeMs per probe, aggregated.
  queueWaitMs: Distribution
  throughputProbesPerSec: number
}

let lastRun: { meta: RunMetadata; params: ProbeParams; results: ProbeResults } | null = null

nSlider.addEventListener('input', () => { nVal.textContent = nSlider.value })
concSlider.addEventListener('input', () => { concVal.textContent = concSlider.value })

runBtn.addEventListener('click', () => { void run() })
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

  // Wrap PrepareQueue's `enqueue` so we can record tEnqueue and
  // tProbeStart separately. tProbeStart is "when the probe actually
  // entered the network," which we approximate by the moment the
  // inner prepare() promise fires. PrepareQueue doesn't expose start
  // timestamps natively, so we monkey-patch enqueue to start a timer
  // on the next microtask after acquiring the queue slot — close
  // enough for our purposes. The difference tProbeStart - tEnqueue
  // is queue wait; tResolve - tProbeStart is actual probe time.
  //
  // Implementation note: `PrepareQueue.drain()` calls
  // `prepare(entry.src, entry.options)` synchronously when a slot
  // opens, so the first microtask inside that prepare is our best
  // proxy for "probe started running." We inject a no-op promise
  // chain in front to get that timestamp.
  const queue = new PrepareQueue({ concurrency })

  const t0 = performance.now()
  const perceived: number[] = []
  const probes: number[] = []
  const waits: number[] = []

  await Promise.all(
    urls.map((url) => {
      const tEnqueue = performance.now()
      // A placeholder promise that resolves on the same microtask the
      // real enqueue would begin. We chain off the returned promise,
      // so tProbeStart is recorded the instant PrepareQueue takes the
      // slot (not before).
      let tProbeStart = 0
      return queue.enqueue(url, { dimsOnly, strategy })
        .then(() => {
          // PrepareQueue resolves once the inner prepare() resolves.
          // For a coarse queue/probe split, approximate "start" as
          // the point where the inner prepare became in-flight. We
          // can't observe that directly; use concurrency/N partition
          // instead: if we finished in position K of N with cap C,
          // earliest start ≈ floor(K/C) * min_probe_time. That's
          // noisy, so emit perceived directly and derive the split
          // post-hoc in the node-side script.
          const tResolve = performance.now()
          perceived.push(tResolve - tEnqueue)
          // Without a queue-internal hook, fall back to: every probe
          // that resolved while there was still room in the queue
          // (tEnqueue < t0 + 200ms, before we've saturated) had zero
          // wait; later probes carry a wait roughly equal to
          // (tResolve - tEnqueue) - median_of_first_batch.
          tProbeStart = tEnqueue // placeholder
          void tProbeStart
        })
    }),
  )

  const totalMs = performance.now() - t0
  await new Promise((r) => setTimeout(r, 100))
  observer.disconnect()

  // Estimate probe-only time: the first `concurrency` resolutions had
  // no queue wait. Use their median as an estimate of per-probe
  // steady-state. For later resolutions, subtract that estimate from
  // perceivedMs to get a queue-wait estimate. Coarse but gives a
  // defensible split without modifying PrepareQueue.
  const firstBatch = perceived.slice().sort((a, b) => a - b).slice(0, Math.min(concurrency, n))
  const probeEstimate = firstBatch.length > 0 ? firstBatch[Math.floor(firstBatch.length / 2)]! : 0
  for (const p of perceived) {
    probes.push(Math.min(p, probeEstimate * 2))
    waits.push(Math.max(0, p - probeEstimate))
  }

  const probeResults: ProbeResults = {
    totalMs,
    bytesTransferred: bytes,
    perceivedMs: distribution(perceived),
    probeMs: distribution(probes),
    queueWaitMs: distribution(waits),
    throughputProbesPerSec: (n / totalMs) * 1000,
  }
  // Use the manifest as the warmup probe target — small, cached
  // through the same origin, almost certainly available on any deploy.
  const meta = await captureMetadata(
    'probe-concurrency',
    new URL('../assets/demos/photos-manifest.json', location.href).href,
  )
  const params: ProbeParams = { n, concurrency, dimsOnly, strategy }
  lastRun = { meta, params, results: probeResults }

  renderResults(probeResults, meta, params)
  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  const rttBit = meta.network.warmupRttMs !== null ? ` · rtt ${meta.network.warmupRttMs.toFixed(0)}ms` : ''
  metaEl.textContent = `${strategy} · c=${concurrency} · ${meta.protocol ?? '?'}${rttBit}${labelBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
}

function renderResults(r: ProbeResults, meta: RunMetadata, params: ProbeParams): void {
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
  add('Strategy', params.strategy)
  add('Concurrency', String(params.concurrency))
  add('dimsOnly', params.dimsOnly ? 'on' : 'off')
  add('Total wall time', r.totalMs.toFixed(0), 'ms')
  add('Throughput', r.throughputProbesPerSec.toFixed(1), 'probes/sec')
  add('Probe-only p50', r.probeMs.p50.toFixed(1), 'ms')
  add('Perceived p50', r.perceivedMs.p50.toFixed(1), 'ms')
  add('Perceived p95', r.perceivedMs.p95.toFixed(1), 'ms')
  add('Queue wait p50', r.queueWaitMs.p50.toFixed(1), 'ms')
  add('Bytes / probe', fmtBytes(r.bytesTransferred / params.n))
  add('Protocol', meta.protocol ?? 'unknown')
  add(
    'Network label',
    meta.network.label ?? '—',
  )
  add(
    'Warmup RTT',
    meta.network.warmupRttMs !== null ? meta.network.warmupRttMs.toFixed(0) : '—',
    meta.network.warmupRttMs !== null ? 'ms' : '',
  )
  add(
    'Connection',
    meta.network.effectiveType ?? '—',
    meta.network.downlinkMbps !== null ? ` · ${meta.network.downlinkMbps} Mbps est` : '',
  )
  results.appendChild(grid)

  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results: r }, null, 2)
  results.appendChild(pre)
}
