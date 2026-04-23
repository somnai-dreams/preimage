import {
  packJustifiedRows,
  packShortestColumn,
  type Placement,
} from '@somnai-dreams/layout-algebra'
import {
  captureMetadata,
  distribution,
  seededAspects,
  type Distribution,
  type RunMetadata,
} from './common.js'

const nSlider = document.getElementById('nSlider') as HTMLInputElement
const nVal = document.getElementById('nVal')!
const kSlider = document.getElementById('kSlider') as HTMLInputElement
const kVal = document.getElementById('kVal')!
const seedSlider = document.getElementById('seedSlider') as HTMLInputElement
const seedVal = document.getElementById('seedVal')!
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const results = document.getElementById('results')!

type PackerResults = {
  shortestColumn: { perCallMs: Distribution; deterministic: boolean; totalHeight: number }
  justifiedRows: { perCallMs: Distribution; deterministic: boolean; totalHeight: number }
}

type Params = { n: number; k: number; seed: number }

let lastRun: { meta: RunMetadata; params: Params; results: PackerResults } | null = null

nSlider.addEventListener('input', () => { nVal.textContent = Number(nSlider.value).toLocaleString() })
kSlider.addEventListener('input', () => { kVal.textContent = kSlider.value })
seedSlider.addEventListener('input', () => { seedVal.textContent = seedSlider.value })
nVal.textContent = Number(nSlider.value).toLocaleString()

runBtn.addEventListener('click', () => {
  void run()
})
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  const json = JSON.stringify(lastRun, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const safeDate = lastRun.meta.date.replace(/[:.]/g, '-')
  const a = document.createElement('a')
  a.href = url
  a.download = `${lastRun.meta.bench}-${safeDate}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
})

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  saveBtn.disabled = true
  results.innerHTML = ''

  const n = Number(nSlider.value)
  const k = Number(kSlider.value)
  const seed = Number(seedSlider.value)
  const aspects = seededAspects(n, seed)

  // Yield once so the UI updates to "Running…" before blocking the
  // main thread on K packer calls at 100k aspects.
  await new Promise((r) => setTimeout(r, 0))

  // packShortestColumn
  const scTimes: number[] = []
  const scRef = packShortestColumn(aspects, { panelWidth: 1200, gap: 4, columns: 5 })
  for (let i = 0; i < k; i++) {
    const t = performance.now()
    packShortestColumn(aspects, { panelWidth: 1200, gap: 4, columns: 5 })
    scTimes.push(performance.now() - t)
  }
  const scAgain = packShortestColumn(aspects, { panelWidth: 1200, gap: 4, columns: 5 })
  const scDeterministic = placementsEqual(scRef.placements, scAgain.placements)

  // packJustifiedRows
  const jrTimes: number[] = []
  const jrRef = packJustifiedRows(aspects, { panelWidth: 1200, gap: 4, targetRowHeight: 220 })
  for (let i = 0; i < k; i++) {
    const t = performance.now()
    packJustifiedRows(aspects, { panelWidth: 1200, gap: 4, targetRowHeight: 220 })
    jrTimes.push(performance.now() - t)
  }
  const jrAgain = packJustifiedRows(aspects, { panelWidth: 1200, gap: 4, targetRowHeight: 220 })
  const jrDeterministic = placementsEqual(jrRef.placements, jrAgain.placements)

  // Pure-math bench, but still capture network so cross-bench JSONs
  // share metadata shape. Probe target is the preimage symbol SVG
  // (small, same origin, ships on every deploy).
  const meta = await captureMetadata(
    'packing',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  const params: Params = { n, k, seed }
  const packerResults: PackerResults = {
    shortestColumn: {
      perCallMs: distribution(scTimes),
      deterministic: scDeterministic,
      totalHeight: scRef.totalHeight,
    },
    justifiedRows: {
      perCallMs: distribution(jrTimes),
      deterministic: jrDeterministic,
      totalHeight: jrRef.totalHeight,
    },
  }
  lastRun = { meta, params, results: packerResults }

  renderResults(packerResults, meta, params)
  metaEl.textContent = `${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
}

function placementsEqual(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!
    const q = b[i]!
    if (p.x !== q.x || p.y !== q.y || p.width !== q.width || p.height !== q.height) return false
  }
  return true
}

function renderResults(r: PackerResults, meta: RunMetadata, params: Params): void {
  results.innerHTML = ''
  const grid = document.createElement('div')
  grid.className = 'stat-grid'
  const add = (label: string, value: string, unit = '', cls = ''): void => {
    const cell = document.createElement('div')
    cell.className = 'stat-cell'
    const l = document.createElement('div')
    l.className = 'label'
    l.textContent = label
    const v = document.createElement('div')
    v.className = 'value' + (cls ? ' ' + cls : '')
    v.innerHTML = unit ? `${value}<span class="unit">${unit}</span>` : value
    cell.appendChild(l)
    cell.appendChild(v)
    grid.appendChild(cell)
  }
  add('SC · p50', r.shortestColumn.perCallMs.p50.toFixed(2), 'ms')
  add('SC · p95', r.shortestColumn.perCallMs.p95.toFixed(2), 'ms')
  add('SC · deterministic', r.shortestColumn.deterministic ? 'yes' : 'no', '', r.shortestColumn.deterministic ? 'det-pass' : 'det-fail')
  add('JR · p50', r.justifiedRows.perCallMs.p50.toFixed(2), 'ms')
  add('JR · p95', r.justifiedRows.perCallMs.p95.toFixed(2), 'ms')
  add('JR · deterministic', r.justifiedRows.deterministic ? 'yes' : 'no', '', r.justifiedRows.deterministic ? 'det-pass' : 'det-fail')
  results.appendChild(grid)

  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results: r }, null, 2)
  results.appendChild(pre)
}
