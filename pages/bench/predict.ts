import {
  createLinearPredictor,
  createMomentumPredictor,
  createStationaryPredictor,
  evaluatePrediction,
  type PredictionEvaluation,
  type ScrollPredictor,
  type ScrollSample,
} from '@somnai-dreams/preimage/predict'
import {
  captureMetadata,
  getNetworkLabel,
  saveRun,
  setNetworkLabel,
  type RunMetadata,
} from './common.js'

const durationInput = document.getElementById('durationInput') as HTMLInputElement
const intervalInput = document.getElementById('intervalInput') as HTMLInputElement
const toleranceInput = document.getElementById('toleranceInput') as HTMLInputElement
const networkLabelEl = document.getElementById('networkLabel') as HTMLInputElement
networkLabelEl.value = getNetworkLabel()
networkLabelEl.addEventListener('input', () => setNetworkLabel(networkLabelEl.value.trim()))
const runBtn = document.getElementById('run') as HTMLButtonElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const summaryHost = document.getElementById('summary-host')!
const tableHost = document.getElementById('table-host')!
const jsonHost = document.getElementById('json-host')!

const PATTERNS = ['constant', 'accelerating', 'decelerating', 'direction-change', 'fling'] as const
const HORIZONS = [100, 250, 500, 1000] as const
const MAX_SCROLL = 8000

type PatternName = (typeof PATTERNS)[number]

type PredictParams = {
  durationMs: number
  sampleIntervalMs: number
  tolerancePx: number
  horizonsMs: readonly number[]
  patterns: readonly PatternName[]
}

type PatternResult = {
  pattern: PatternName
  samples: number
  evaluations: PredictionEvaluation[]
  deltaAt500: number
}

type PredictResults = {
  gatePassed: boolean
  patterns: PatternResult[]
}

let lastRun: { meta: RunMetadata; params: PredictParams; results: PredictResults } | null = null

runBtn.addEventListener('click', () => { void run() })
saveBtn.addEventListener('click', () => {
  if (lastRun === null) return
  saveRun(lastRun.meta, lastRun.params, lastRun.results)
})

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running...'
  saveBtn.disabled = true
  metaEl.textContent = ''
  summaryHost.innerHTML = ''
  tableHost.innerHTML = ''
  jsonHost.innerHTML = ''

  const params: PredictParams = {
    durationMs: readPositiveInput(durationInput, 4000),
    sampleIntervalMs: readPositiveInput(intervalInput, 16),
    tolerancePx: readPositiveInput(toleranceInput, 250),
    horizonsMs: HORIZONS,
    patterns: PATTERNS,
  }
  const predictors = makePredictors()
  const results: PredictResults = {
    gatePassed: true,
    patterns: [],
  }

  for (const pattern of PATTERNS) {
    const samples = makeSamples(pattern, params.durationMs, params.sampleIntervalMs)
    const evaluations: PredictionEvaluation[] = []
    for (const horizonMs of HORIZONS) {
      for (const predictor of predictors) {
        evaluations.push(
          evaluatePrediction(predictor, samples, {
            horizonMs,
            tolerancePx: params.tolerancePx,
            minHistory: 4,
          }),
        )
      }
    }
    const baseline = evaluations.find((e) => e.horizonMs === 500 && e.predictor === 'stationary')
    const best = evaluations
      .filter((e) => e.horizonMs === 500 && e.predictor !== 'stationary')
      .reduce((winner, e) => (e.hitRate > winner.hitRate ? e : winner))
    const deltaAt500 = best.hitRate - (baseline?.hitRate ?? 0)
    if (deltaAt500 <= 0.2) results.gatePassed = false
    results.patterns.push({
      pattern,
      samples: samples.length,
      evaluations,
      deltaAt500,
    })
  }

  const meta = await captureMetadata(
    'predict',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  lastRun = { meta, params, results }

  renderSummary(results)
  renderTable(results)
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results }, null, 2)
  jsonHost.appendChild(pre)

  const labelBit = meta.network.label !== null ? ` · ${meta.network.label}` : ''
  metaEl.textContent = `${results.gatePassed ? 'gate passed' : 'gate failed'} · ${meta.protocol ?? '?'}${labelBit} · ${new Date(meta.date).toLocaleTimeString()}`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
  saveBtn.disabled = false
}

function makePredictors(): ScrollPredictor[] {
  return [
    createStationaryPredictor(),
    createLinearPredictor({ smoothingWindow: 4, confidenceVelocityPxPerMs: 4 }),
    createMomentumPredictor({ smoothingWindow: 4, confidenceVelocityPxPerMs: 4, dragPerMs: 0.004 }),
  ]
}

function makeSamples(
  pattern: PatternName,
  durationMs: number,
  intervalMs: number,
): ScrollSample[] {
  const samples: ScrollSample[] = []
  for (let t = 0; t <= durationMs; t += intervalMs) {
    const p = durationMs === 0 ? 1 : Math.min(1, t / durationMs)
    samples.push({ t, y: yForPattern(pattern, p) })
  }
  return samples
}

function readPositiveInput(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value)
  if (Number.isFinite(value) && value > 0) return value
  input.value = String(fallback)
  return fallback
}

function yForPattern(pattern: PatternName, p: number): number {
  switch (pattern) {
    case 'constant':
      return MAX_SCROLL * p
    case 'accelerating':
      return MAX_SCROLL * p * p
    case 'decelerating':
      return MAX_SCROLL * (1 - (1 - p) * (1 - p))
    case 'direction-change':
      return p < 0.5 ? MAX_SCROLL * p * 1.4 : MAX_SCROLL * (0.7 - (p - 0.5) * 1.1)
    case 'fling': {
      const drag = 5
      return MAX_SCROLL * ((1 - Math.exp(-drag * p)) / (1 - Math.exp(-drag)))
    }
  }
}

function renderSummary(results: PredictResults): void {
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
  add('Gate', results.gatePassed ? 'pass' : 'fail')
  for (const result of results.patterns) {
    add(`${result.pattern} 500ms`, `${(result.deltaAt500 * 100).toFixed(0)}`, 'pt')
  }
  summaryHost.innerHTML = ''
  summaryHost.appendChild(grid)
}

function renderTable(results: PredictResults): void {
  const table = document.createElement('table')
  table.className = 'bench-table'
  table.innerHTML = `
    <thead>
      <tr>
        <th>Pattern</th>
        <th>Horizon</th>
        <th>Predictor</th>
        <th>Hit rate</th>
        <th>Mean error</th>
        <th>p95 error</th>
        <th>Confidence</th>
      </tr>
    </thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')!
  for (const patternResult of results.patterns) {
    for (const evaluation of patternResult.evaluations) {
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td>${patternResult.pattern}</td>
        <td>${evaluation.horizonMs}ms</td>
        <td>${evaluation.predictor}</td>
        <td>${(evaluation.hitRate * 100).toFixed(1)}%</td>
        <td>${evaluation.meanErrorPx.toFixed(0)}px</td>
        <td>${evaluation.p95ErrorPx.toFixed(0)}px</td>
        <td>${(evaluation.meanConfidence * 100).toFixed(0)}%</td>
      `
      tbody.appendChild(tr)
    }
  }
  tableHost.innerHTML = ''
  tableHost.appendChild(table)
}
