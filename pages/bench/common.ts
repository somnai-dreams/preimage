// Shared benchmark harness. Two jobs:
//   1. Run a thing and get honest numbers out (min/p50/p95/max over N
//      samples, not just a mean that hides tail latency).
//   2. Serialize a run as JSON the caller can save/download, with
//      enough metadata that a diff against a past run is meaningful
//      (browser, protocol, date, machine hints).
//
// Permanent perf evidence stays compact: a short JSON per run goes
// into benchmark-results/. Raw timelines and CPU profiles don't live
// here — they're investigation-time artifacts, not canonical truth.

export type Distribution = {
  count: number
  min: number
  p50: number
  p95: number
  max: number
  mean: number
}

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  }
}

export type RunMetadata = {
  bench: string
  date: string
  userAgent: string
  origin: string
  commit: string | null
  // `nextHopProtocol` for the first resource seen during the run.
  // Indicates whether the origin served this session over h1/h2/h3 —
  // big effect on PrepareQueue numbers.
  protocol: string | null
}

/** Capture environment metadata to tag a run with. Call once at the
 *  top of a bench so comparisons across runs can filter by protocol
 *  or browser. */
export function captureMetadata(bench: string): RunMetadata {
  // Protocol: peek at the most-recent resource timing entry.
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const firstSameOrigin = entries.find((e) => e.name.startsWith(location.origin))
  const protocol = firstSameOrigin?.nextHopProtocol ?? null
  return {
    bench,
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    origin: location.origin,
    commit: (globalThis as unknown as { __PREIMAGE_COMMIT__?: string }).__PREIMAGE_COMMIT__ ?? null,
    protocol,
  }
}

/** Save a run as a downloaded JSON file. Filename is
 *  `{bench}-{ISO date without punctuation}.json`. */
export function saveRun<T>(meta: RunMetadata, params: unknown, results: T): void {
  const payload = { ...meta, params, results }
  const json = JSON.stringify(payload, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const safeDate = meta.date.replace(/[:.]/g, '-')
  const a = document.createElement('a')
  a.href = url
  a.download = `${meta.bench}-${safeDate}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Render a distribution as a compact human-readable line. */
export function fmtDistribution(d: Distribution, unit = 'ms'): string {
  const f = (n: number): string => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0))
  return `min ${f(d.min)} · p50 ${f(d.p50)} · p95 ${f(d.p95)} · max ${f(d.max)} · n=${d.count} ${unit}`
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Display a JSON object in a <pre>. Truncates large arrays. */
export function renderJson(container: HTMLElement, payload: unknown): void {
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify(payload, null, 2)
  container.innerHTML = ''
  container.appendChild(pre)
}

/** Seeded pseudo-random (Wellons lowbias32). Deterministic per seed,
 *  so benchmarks that generate synthetic input can reproduce runs. */
export function hash(seed: number): number {
  let n = seed | 0
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0x735a2d97)
  return (((n >>> 15) ^ n) >>> 0) / 0x100000000
}

/** Seeded array of aspect ratios in [0.5, 2.0]. Useful for the packer
 *  benches — same seed produces the same array across runs. */
export function seededAspects(n: number, seed = 1): number[] {
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    out[i] = 0.5 + hash(seed + i) * 1.5
  }
  return out
}
