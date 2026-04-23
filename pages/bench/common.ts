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

export type NetworkSignal = {
  /** Median round-trip in ms over a small warmup probe. Always set
   *  if `captureNetwork` was awaited; otherwise null. */
  warmupRttMs: number | null
  /** Total bytes received during warmup. Useful sanity-check that the
   *  RTT measurement landed against the asset we expected. */
  warmupBytes: number | null
  /** `navigator.connection.effectiveType` if exposed (Chromium): one
   *  of '4g', '3g', '2g', 'slow-2g'. Heuristic, not a measurement. */
  effectiveType: string | null
  /** `navigator.connection.downlink` Mbps estimate, capped by Chrome. */
  downlinkMbps: number | null
  /** `navigator.connection.rtt` ms estimate. Less reliable than our
   *  warmup measurement; included for cross-reference. */
  navigatorRttMs: number | null
  /** Whether the user has data-saver enabled. */
  saveData: boolean | null
  /** Free-form label set in the bench UI, persisted to localStorage.
   *  Lets a human distinguish "home gigabit" from "phone tether 5g"
   *  even when warmupRttMs and effectiveType collide. */
  label: string | null
}

export type RunMetadata = {
  bench: string
  date: string
  userAgent: string
  origin: string
  commit: string | null
  /** `nextHopProtocol` for the first resource seen during the run.
   *  Indicates whether the origin served this session over h1/h2/h3 —
   *  big effect on PrepareQueue numbers. */
  protocol: string | null
  network: NetworkSignal
}

const NETWORK_LABEL_STORAGE = 'preimage-bench-network-label'

/** Read the user-supplied network label from localStorage. */
export function getNetworkLabel(): string {
  return localStorage.getItem(NETWORK_LABEL_STORAGE) ?? ''
}

/** Write the user-supplied network label. */
export function setNetworkLabel(label: string): void {
  if (label === '') localStorage.removeItem(NETWORK_LABEL_STORAGE)
  else localStorage.setItem(NETWORK_LABEL_STORAGE, label)
}

/** Time `count` HEAD-or-GET requests against `url`, return the median
 *  round-trip in ms. Bypasses the HTTP cache via cache-busting query. */
async function warmupRtt(
  url: string,
  count: number,
): Promise<{ medianMs: number; bytes: number } | null> {
  const samples: number[] = []
  let bytes = 0
  for (let i = 0; i < count; i++) {
    const t = performance.now()
    try {
      const r = await fetch(`${url}?warmup=${Date.now()}-${i}`, { cache: 'no-store' })
      // Drain the body so the timing reflects a complete round-trip.
      const buf = await r.arrayBuffer()
      bytes += buf.byteLength
      samples.push(performance.now() - t)
    } catch {
      return null
    }
  }
  if (samples.length === 0) return null
  samples.sort((a, b) => a - b)
  return { medianMs: samples[Math.floor(samples.length / 2)]!, bytes }
}

/** Capture a network signal: warmup RTT, navigator.connection hints,
 *  user label. Pass the URL of a small known asset to probe (the
 *  manifest is a good default). Pure measurement at the call site;
 *  no assumptions about what bench is calling. */
export async function captureNetwork(probeUrl: string): Promise<NetworkSignal> {
  const conn = (navigator as unknown as {
    connection?: {
      effectiveType?: string
      downlink?: number
      rtt?: number
      saveData?: boolean
    }
  }).connection
  const warmup = await warmupRtt(probeUrl, 5)
  return {
    warmupRttMs: warmup?.medianMs ?? null,
    warmupBytes: warmup?.bytes ?? null,
    effectiveType: conn?.effectiveType ?? null,
    downlinkMbps: conn?.downlink ?? null,
    navigatorRttMs: conn?.rtt ?? null,
    saveData: conn?.saveData ?? null,
    label: getNetworkLabel() || null,
  }
}

/** Capture environment metadata to tag a run with. Call once at the
 *  top of a bench so comparisons across runs can filter by protocol,
 *  browser, or network conditions. */
export async function captureMetadata(bench: string, networkProbeUrl: string): Promise<RunMetadata> {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const firstSameOrigin = entries.find((e) => e.name.startsWith(location.origin))
  const protocol = firstSameOrigin?.nextHopProtocol ?? null
  const network = await captureNetwork(networkProbeUrl)
  return {
    bench,
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    origin: location.origin,
    commit: (globalThis as unknown as { __PREIMAGE_COMMIT__?: string }).__PREIMAGE_COMMIT__ ?? null,
    protocol,
    network,
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

// --- Upload to shared gist ---
//
// POSTs a run JSON to /api/bench-runs which appends it as a new file
// to a GitHub gist. Lets a mobile device run a bench via a ?t=<token>
// URL and have the result land where you can diff it against desktop
// runs in compare.html without emailing JSONs around.

const UPLOAD_TOKEN_STORAGE = 'preimage-bench-upload-token'
const UPLOAD_ENDPOINT = '/api/bench-runs'

/** Read the upload token. If the URL has `?t=<token>`, persist it to
 *  localStorage and strip it from the bar (so a shared link doesn't
 *  keep leaking the token into screenshots / history). */
export function getUploadToken(): string | null {
  if (typeof location === 'undefined') return null
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('t')
  if (fromUrl !== null && fromUrl.length > 0) {
    localStorage.setItem(UPLOAD_TOKEN_STORAGE, fromUrl)
    url.searchParams.delete('t')
    history.replaceState(null, '', url.toString())
    return fromUrl
  }
  return localStorage.getItem(UPLOAD_TOKEN_STORAGE)
}

/** Clear the stored upload token. Useful after lending a device. */
export function clearUploadToken(): void {
  localStorage.removeItem(UPLOAD_TOKEN_STORAGE)
}

/** POST the run to /api/bench-runs. Returns the filename the server
 *  wrote, or an error string fit for a UI toast. */
export async function uploadRun<T>(
  meta: RunMetadata,
  params: unknown,
  results: T,
): Promise<{ filename: string } | { error: string }> {
  const token = getUploadToken()
  if (token === null) {
    return { error: 'no upload token — append ?t=<token> to the URL' }
  }
  const body = JSON.stringify({ meta, params, results })
  let response: Response
  try {
    response = await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-upload-token': token },
      body,
    })
  } catch (err) {
    return { error: `network error: ${String(err)}` }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { error: `upload failed (${response.status}): ${text}` }
  }
  try {
    return (await response.json()) as { filename: string }
  } catch {
    return { error: 'upload succeeded but response was not JSON' }
  }
}

/** Wire an Upload button to POST the latest run via uploadRun().
 *  Handles the disabled flicker + transient success/error text so the
 *  bench page doesn't reimplement it five times. `getLastRun` is
 *  called on click — return null if there's nothing yet and the
 *  handler is a no-op. */
export function wireUploadButton<T>(
  button: HTMLButtonElement,
  getLastRun: () => { meta: RunMetadata; params: unknown; results: T } | null,
): void {
  const originalText = button.textContent ?? 'Upload'
  button.addEventListener('click', async () => {
    const run = getLastRun()
    if (run === null) return
    const wasDisabled = button.disabled
    button.disabled = true
    button.textContent = 'Uploading…'
    const r = await uploadRun(run.meta, run.params, run.results)
    const restore = (ms: number): void => {
      setTimeout(() => {
        button.textContent = originalText
        button.title = ''
        button.disabled = wasDisabled
      }, ms)
    }
    if ('error' in r) {
      console.error('bench upload failed:', r.error)
      button.textContent = 'Upload failed'
      button.title = r.error
      restore(4000)
    } else {
      button.textContent = 'Uploaded ✓'
      button.title = r.filename
      restore(3000)
    }
  })
}

export type RemoteRun = { filename: string; rawUrl: string; size: number }

/** List recently-uploaded runs. Empty array on any failure (endpoint
 *  not configured, network error, upstream gist fetch fail) so
 *  callers can no-op gracefully. */
export async function listRemoteRuns(): Promise<RemoteRun[]> {
  try {
    const r = await fetch(UPLOAD_ENDPOINT, { cache: 'no-store' })
    if (!r.ok) return []
    const j = (await r.json()) as { files?: RemoteRun[] }
    return j.files ?? []
  } catch {
    return []
  }
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
