// Compare bench JSONs. Accepts any of three shapes we've shipped:
//
//   probe-concurrency (single config per file)  — has `params.strategy`,
//                                                  `params.concurrency`,
//                                                  `results.throughputProbesPerSec`
//   probe-sweep       (browser matrix)           — has `results.sweep[]`
//   probe-sweep-node  (node sweep)               — top-level `sweep[]`
//
// Everything collapses to a flat list of rows, then groups by network
// label so a "home gigabit" run sits next to a "phone tether" run.

type FlatRow = {
  source: string
  networkLabel: string
  networkRttMs: number | null
  protocol: string | null
  n: number
  strategy: string
  concurrency: number
  throughputProbesPerSec: number
  probeP50Ms: number | null
  perceivedP50Ms: number | null
  bytesPerProbe: number | null
  errors: number
}

type LoadedRun = {
  filename: string
  rows: FlatRow[]
}

const dropzone = document.getElementById('dropzone') as HTMLLabelElement
const picker = document.getElementById('picker') as HTMLInputElement
const loadedEl = document.getElementById('loaded-runs')!
const comparisonEl = document.getElementById('comparison')!

const runs: LoadedRun[] = []

picker.addEventListener('change', () => {
  if (picker.files !== null) void ingestFiles(picker.files)
})
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropzone.classList.add('dragover')
})
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
dropzone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropzone.classList.remove('dragover')
  if (e.dataTransfer?.files !== undefined) void ingestFiles(e.dataTransfer.files)
})

async function ingestFiles(files: FileList): Promise<void> {
  for (const file of Array.from(files)) {
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const rows = flatten(json, file.name)
      if (rows.length === 0) {
        console.warn(`compare: ${file.name} has no recognized rows, skipping`)
        continue
      }
      runs.push({ filename: file.name, rows })
    } catch (err) {
      console.warn(`compare: failed to parse ${file.name}:`, err)
    }
  }
  render()
}

function flatten(json: unknown, filename: string): FlatRow[] {
  if (typeof json !== 'object' || json === null) return []
  const obj = json as Record<string, unknown>

  // Shared across shapes:
  const network = (obj.network ?? {}) as { label?: string | null; warmupRttMs?: number | null }
  const protocol = (obj.protocol as string | null | undefined) ?? null
  const networkLabel = network.label ?? '(no label)'
  const networkRttMs = typeof network.warmupRttMs === 'number' ? network.warmupRttMs : null

  // Shape 1: single-config probe-concurrency (has params + results)
  if ('params' in obj && 'results' in obj && !('sweep' in obj)) {
    const params = obj.params as {
      n?: number
      concurrency?: number
      strategy?: string
      dimsOnly?: boolean
    }
    const results = obj.results as Record<string, unknown>
    // Could itself be a sweep container (browser sweep.html shape):
    if ('sweep' in results && Array.isArray(results.sweep)) {
      return flattenSweepRows(results.sweep as Array<Record<string, unknown>>, {
        filename,
        networkLabel,
        networkRttMs,
        protocol,
        defaultN: params.n ?? 0,
      })
    }
    // Otherwise a single-config row:
    return [
      {
        source: filename,
        networkLabel,
        networkRttMs,
        protocol,
        n: params.n ?? 0,
        strategy: params.strategy ?? 'img',
        concurrency: params.concurrency ?? 0,
        throughputProbesPerSec: Number(results.throughputProbesPerSec ?? 0),
        probeP50Ms: dist(results.probeMs, 'p50') ?? dist(results.perProbeMs, 'p50'),
        perceivedP50Ms: dist(results.perceivedMs, 'p50') ?? dist(results.perProbeMs, 'p50'),
        bytesPerProbe: bytesPerProbe(results, params.n ?? 0),
        errors: 0,
      },
    ]
  }

  // Shape 2: node sweep (top-level sweep[])
  if ('sweep' in obj && Array.isArray(obj.sweep)) {
    return flattenSweepRows(obj.sweep as Array<Record<string, unknown>>, {
      filename,
      networkLabel,
      networkRttMs,
      protocol,
      defaultN: Number(obj.n ?? 0),
    })
  }

  return []
}

function flattenSweepRows(
  rows: Array<Record<string, unknown>>,
  ctx: {
    filename: string
    networkLabel: string
    networkRttMs: number | null
    protocol: string | null
    defaultN: number
  },
): FlatRow[] {
  return rows.map((r) => ({
    source: ctx.filename,
    networkLabel: ctx.networkLabel,
    networkRttMs: ctx.networkRttMs,
    protocol: ctx.protocol,
    n: Number(r.n ?? ctx.defaultN),
    strategy: String(r.strategy ?? 'img'),
    concurrency: Number(r.concurrency ?? 0),
    throughputProbesPerSec: Number(r.throughputProbesPerSec ?? 0),
    probeP50Ms: dist(r.probeMs, 'p50'),
    perceivedP50Ms: dist(r.perceivedMs, 'p50') ?? dist(r.probeMs, 'p50'),
    bytesPerProbe:
      typeof r.bytesTransferred === 'number' && Number(r.resolved ?? 0) > 0
        ? Number(r.bytesTransferred) / Number(r.resolved)
        : typeof r.bytesTransferred === 'number' && ctx.defaultN > 0
        ? Number(r.bytesTransferred) / ctx.defaultN
        : null,
    errors: Number(r.errors ?? 0),
  }))
}

function dist(obj: unknown, key: 'p50' | 'p95' | 'min' | 'max' | 'mean'): number | null {
  if (typeof obj !== 'object' || obj === null) return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : null
}

function bytesPerProbe(results: unknown, n: number): number | null {
  if (typeof results !== 'object' || results === null) return null
  const r = results as Record<string, unknown>
  const b = typeof r.bytesTransferred === 'number' ? r.bytesTransferred : null
  if (b === null || n <= 0) return null
  return b / n
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.round(bytes)} B`
}

function render(): void {
  loadedEl.innerHTML = ''
  if (runs.length === 0) {
    loadedEl.innerHTML = '<div class="empty-msg">No runs loaded yet.</div>'
    comparisonEl.innerHTML = '<div class="empty-msg">Load two or more runs to see the comparison table.</div>'
    return
  }

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!
    const card = document.createElement('div')
    card.className = 'run-card'
    const networkLabels = Array.from(new Set(run.rows.map((r) => r.networkLabel))).join(', ')
    const rtts = run.rows.map((r) => r.networkRttMs).filter((v): v is number => v !== null)
    const rttBit = rtts.length > 0 ? ` · rtt ${(rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(0)}ms` : ''
    card.innerHTML = `
      <div>
        <div class="file">${escape(run.filename)}</div>
        <div class="meta">${run.rows.length} rows · ${escape(networkLabels)}${rttBit}</div>
      </div>
      <button data-idx="${i}">remove</button>`
    card.querySelector('button')!.addEventListener('click', () => {
      runs.splice(i, 1)
      render()
    })
    loadedEl.appendChild(card)
  }

  if (runs.length < 1) {
    comparisonEl.innerHTML = '<div class="empty-msg">Load two or more runs to see the comparison table.</div>'
    return
  }

  // Flatten everything, group by network label.
  const all: FlatRow[] = runs.flatMap((r) => r.rows)
  const byLabel = new Map<string, FlatRow[]>()
  for (const row of all) {
    const list = byLabel.get(row.networkLabel)
    if (list === undefined) byLabel.set(row.networkLabel, [row])
    else list.push(row)
  }

  const table = document.createElement('table')
  table.className = 'cmp'
  const thead = document.createElement('thead')
  thead.innerHTML = `<tr>
    <th>Strategy</th><th>c</th><th>N</th>
    <th>Throughput</th><th>Probe p50</th><th>Perceived p50</th>
    <th>Bytes/probe</th><th>Errors</th><th>Source</th>
  </tr>`
  table.appendChild(thead)
  const tbody = document.createElement('tbody')

  const sortedLabels = Array.from(byLabel.keys()).sort()
  for (const label of sortedLabels) {
    const group = byLabel.get(label)!.sort(
      (a, b) => a.strategy.localeCompare(b.strategy) || a.concurrency - b.concurrency,
    )
    const rtts = group.map((r) => r.networkRttMs).filter((v): v is number => v !== null)
    const rttText = rtts.length > 0 ? ` · rtt median ${median(rtts).toFixed(0)}ms` : ''
    const protocolText =
      group[0]?.protocol !== null && group[0]?.protocol !== undefined ? ` · ${group[0].protocol}` : ''
    const header = document.createElement('tr')
    header.className = 'group-header'
    header.innerHTML = `<td colspan="9">${escape(label)}${protocolText}${rttText}</td>`
    tbody.appendChild(header)

    // Best throughput within the group, for highlight.
    const bestTp = Math.max(...group.map((r) => r.throughputProbesPerSec))
    for (const row of group) {
      const tr = document.createElement('tr')
      const isBest = row.throughputProbesPerSec === bestTp
      tr.innerHTML = `
        <td class="label">${escape(row.strategy)}</td>
        <td>${row.concurrency}</td>
        <td>${row.n}</td>
        <td class="${isBest ? 'best' : ''}">${row.throughputProbesPerSec.toFixed(1)}/s</td>
        <td>${row.probeP50Ms !== null ? row.probeP50Ms.toFixed(1) + 'ms' : '—'}</td>
        <td>${row.perceivedP50Ms !== null ? row.perceivedP50Ms.toFixed(0) + 'ms' : '—'}</td>
        <td>${row.bytesPerProbe !== null ? fmtBytes(row.bytesPerProbe) : '—'}</td>
        <td>${row.errors}</td>
        <td class="meta" style="color: var(--text-soft); font-size: 11px;">${escape(row.source)}</td>`
      tbody.appendChild(tr)
    }
  }
  table.appendChild(tbody)
  comparisonEl.innerHTML = ''
  comparisonEl.appendChild(table)
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

render()
