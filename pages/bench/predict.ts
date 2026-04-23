import {
  createLinearPredictor,
  createMomentumPredictor,
  createScrollObserver,
  createStationaryPredictor,
  evaluatePrediction,
  type PredictionEvaluation,
  type ScrollSample,
} from '@somnai-dreams/preimage/predict'
import { captureMetadata, type RunMetadata } from './common.js'

const runBtn = document.getElementById('run') as HTMLButtonElement
const metaEl = document.getElementById('meta')!
const resultsHost = document.getElementById('results-host')!
const jsonHost = document.getElementById('json-host')!
const scrollHost = document.getElementById('scrollHost') as HTMLElement
const content = document.getElementById('content') as HTMLElement

type ScrollPattern =
  | 'constant'
  | 'accelerating'
  | 'decelerating'
  | 'direction-change'
  | 'fling'

const HORIZONS_MS = [100, 250, 500, 1000] as const

type PredictorRow = {
  name: string
  horizons: Record<number, PredictionEvaluation>
}

type BenchParams = {
  pattern: ScrollPattern
  peakVelocity: number
  durationMs: number
  tolerancePx: number
}

type BenchResults = {
  sampleCount: number
  scrolledPx: number
  predictors: PredictorRow[]
}

let lastRun: { meta: RunMetadata; params: BenchParams; results: BenchResults } | null = null

runBtn.addEventListener('click', () => { void run() })

async function run(): Promise<void> {
  runBtn.disabled = true
  runBtn.textContent = 'Running…'
  metaEl.textContent = ''
  resultsHost.innerHTML = ''
  jsonHost.innerHTML = ''
  scrollHost.scrollTop = 0

  const patternEl = document.querySelector<HTMLInputElement>('input[name="pattern"]:checked')
  const pattern = (patternEl?.value ?? 'constant') as ScrollPattern
  const peakVelocity = Number((document.getElementById('velInput') as HTMLInputElement).value)
  const durationMs = Number((document.getElementById('durationInput') as HTMLInputElement).value)
  const tolerancePx = Number((document.getElementById('toleranceInput') as HTMLInputElement).value)

  // Set up the scroll surface: tall enough that the max possible
  // displacement fits, with some margin.
  const contentHeight = Math.max(5000, peakVelocity * (durationMs / 1000) * 2)
  content.style.height = `${contentHeight}px`

  // Capture ground-truth samples via an observer during the
  // scripted scroll. We use a smallish sample rate (8ms) to give
  // the evaluator enough history for short-horizon predictions.
  const observer = createScrollObserver(scrollHost, { sampleRateMs: 8, maxSamples: 1024 })
  const capturedSamples: ScrollSample[] = []

  // Sampling loop: run in parallel with the scripted scroll so we
  // get the observer's view of what actually happened.
  const sampleInterval = setInterval(() => {
    const sample = observer.current()
    if (
      capturedSamples.length === 0 ||
      capturedSamples[capturedSamples.length - 1]!.t !== sample.t
    ) {
      capturedSamples.push(sample)
    }
  }, 8)

  await runScrollPattern(scrollHost, pattern, peakVelocity, durationMs, contentHeight)

  clearInterval(sampleInterval)
  observer.destroy()

  // Drop the leading sample if it's at t=0 (stationary pre-run).
  while (capturedSamples.length > 1 && capturedSamples[0]!.scrollY === capturedSamples[1]!.scrollY) {
    capturedSamples.shift()
  }

  // Evaluate each predictor at each horizon.
  const predictorDefs = [
    {
      name: 'stationary',
      build: () => createStationaryPredictor({ current: () => ({ t: 0, scrollY: 0 }) } as never),
    },
    {
      name: 'linear',
      build: (horizonMs: number) =>
        createLinearPredictor(
          { current: () => ({ t: 0, scrollY: 0 }), smoothedVelocity: () => 0, velocity: () => 0, acceleration: () => 0, samples: () => [], destroy: () => {} } as never,
          { horizonMs },
        ),
    },
    {
      name: 'momentum',
      build: (horizonMs: number) =>
        createMomentumPredictor(
          { current: () => ({ t: 0, scrollY: 0 }), smoothedVelocity: () => 0, velocity: () => 0, acceleration: () => 0, samples: () => [], destroy: () => {} } as never,
          { horizonMs, dragPerSec: 3 },
        ),
    },
  ]

  const rows: PredictorRow[] = predictorDefs.map((def) => ({
    name: def.name,
    horizons: {} as Record<number, PredictionEvaluation>,
  }))

  for (let p = 0; p < predictorDefs.length; p++) {
    const predictorName = predictorDefs[p]!.name
    for (const horizonMs of HORIZONS_MS) {
      // For evaluation we need to drive the predictor per-history-slice.
      // Build a closure that reconstructs the relevant state per call.
      const evaluation = evaluatePrediction(
        capturedSamples,
        horizonMs,
        (history) => {
          if (predictorName === 'stationary') {
            return { scrollY: history[history.length - 1]!.scrollY, confidence: 1 }
          }
          // Synthetic observer view: plug in this slice of history.
          const obs = syntheticObserver(history)
          const predictor =
            predictorName === 'linear'
              ? createLinearPredictor(obs, { horizonMs })
              : createMomentumPredictor(obs, { horizonMs, dragPerSec: 3 })
          return predictor.predict()
        },
        tolerancePx,
      )
      rows[p]!.horizons[horizonMs] = evaluation
    }
  }

  const results: BenchResults = {
    sampleCount: capturedSamples.length,
    scrolledPx: scrollHost.scrollTop,
    predictors: rows,
  }

  const meta = await captureMetadata(
    'predict',
    new URL('../assets/preimage-symbol.svg', location.href).href,
  )
  const params: BenchParams = { pattern, peakVelocity, durationMs, tolerancePx }
  lastRun = { meta, params, results }
  void lastRun

  renderResults(rows, tolerancePx)
  const pre = document.createElement('pre')
  pre.className = 'bench-json'
  pre.textContent = JSON.stringify({ ...meta, params, results }, null, 2)
  jsonHost.appendChild(pre)

  metaEl.textContent = `${pattern} · ${peakVelocity} px/s · ${durationMs}ms · ${capturedSamples.length} samples`
  runBtn.disabled = false
  runBtn.textContent = 'Run again'
}

// --- Scroll patterns ---

async function runScrollPattern(
  container: HTMLElement,
  pattern: ScrollPattern,
  peakVelocity: number,
  durationMs: number,
  contentHeight: number,
): Promise<void> {
  const maxScroll = Math.max(0, contentHeight - container.clientHeight)
  return await new Promise<void>((resolve) => {
    const t0 = performance.now()
    function step(now: number): void {
      const elapsed = now - t0
      const progress = Math.min(1, elapsed / durationMs)
      let scrollY: number
      switch (pattern) {
        case 'constant':
          scrollY = Math.min(maxScroll, peakVelocity * (elapsed / 1000))
          break
        case 'accelerating':
          // Quadratic ramp from 0 to peakVelocity over durationMs:
          //   v(t) = peakVelocity * (t / durationMs)
          //   s(t) = ∫v = peakVelocity * t² / (2 * durationMs)
          scrollY = Math.min(maxScroll, (peakVelocity * elapsed * elapsed) / (2 * durationMs))
          break
        case 'decelerating':
          // Inverse: full velocity at start, zero at end.
          //   v(t) = peakVelocity * (1 - t / durationMs)
          //   s(t) = peakVelocity * (t - t²/(2*durationMs))
          scrollY = Math.min(
            maxScroll,
            peakVelocity * (elapsed - (elapsed * elapsed) / (2 * durationMs)) / 1000 * 1000,
          )
          // Adjust for proper seconds scale
          scrollY = Math.min(maxScroll, (peakVelocity / 1000) * (elapsed - (elapsed * elapsed) / (2 * durationMs)))
          break
        case 'direction-change': {
          // Scroll down for half, then up.
          const half = durationMs / 2
          if (elapsed < half) {
            scrollY = Math.min(maxScroll, peakVelocity * (elapsed / 1000))
          } else {
            const downFinal = peakVelocity * (half / 1000)
            const upElapsed = elapsed - half
            scrollY = Math.max(0, downFinal - peakVelocity * (upElapsed / 1000))
          }
          break
        }
        case 'fling': {
          // Exponential decay: v(t) = peakVelocity * exp(-drag * t)
          //   s(t) = peakVelocity / drag * (1 - exp(-drag * t))
          const drag = 4 // /sec
          const t = elapsed / 1000
          scrollY = Math.min(maxScroll, (peakVelocity / drag) * (1 - Math.exp(-drag * t)))
          break
        }
      }
      container.scrollTop = Math.round(scrollY)
      if (progress < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
}

// --- Helpers ---

/** Minimal observer shape over a fixed history slice. Used by the
 *  evaluator to feed `createLinearPredictor` / `createMomentumPredictor`
 *  their per-slice view without mutating state. */
function syntheticObserver(history: readonly ScrollSample[]): Parameters<typeof createLinearPredictor>[0] {
  return {
    current: () => history[history.length - 1]!,
    samples: () => history,
    velocity: () => {
      if (history.length < 2) return 0
      const a = history[history.length - 2]!
      const b = history[history.length - 1]!
      const dt = (b.t - a.t) / 1000
      return dt > 0 ? (b.scrollY - a.scrollY) / dt : 0
    },
    smoothedVelocity: (windowSize = 4) => {
      if (history.length < 2) return 0
      const start = Math.max(0, history.length - windowSize - 1)
      let sum = 0
      let count = 0
      for (let i = start + 1; i < history.length; i++) {
        const a = history[i - 1]!
        const b = history[i]!
        const dt = (b.t - a.t) / 1000
        if (dt <= 0) continue
        sum += (b.scrollY - a.scrollY) / dt
        count++
      }
      return count === 0 ? 0 : sum / count
    },
    acceleration: () => 0,
    destroy: () => {},
  }
}

// --- Reporting ---

function renderResults(rows: readonly PredictorRow[], tolerancePx: number): void {
  const table = document.createElement('table')
  table.className = 'predict-table'
  const thead = document.createElement('thead')
  const tr = document.createElement('tr')
  tr.innerHTML = `<th>Predictor</th>` + HORIZONS_MS.flatMap((h) => [
    `<th>${h}ms · mean err</th>`,
    `<th>${h}ms · p95</th>`,
    `<th>${h}ms · hit @ ±${tolerancePx}px</th>`,
  ]).join('')
  thead.appendChild(tr)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  // Find the best hit-rate per horizon to highlight.
  const bestHitByHorizon: Record<number, { name: string; rate: number }> = {}
  for (const horizonMs of HORIZONS_MS) {
    let best = { name: '', rate: -1 }
    for (const row of rows) {
      const rate = row.horizons[horizonMs]?.hitRate ?? 0
      if (rate > best.rate) best = { name: row.name, rate }
    }
    bestHitByHorizon[horizonMs] = best
  }

  for (const row of rows) {
    const trRow = document.createElement('tr')
    const cells: string[] = [`<td>${row.name}</td>`]
    for (const horizonMs of HORIZONS_MS) {
      const e = row.horizons[horizonMs]
      if (e === undefined || e.count === 0) {
        cells.push(`<td>—</td><td>—</td><td>—</td>`)
        continue
      }
      const isBest = bestHitByHorizon[horizonMs]!.name === row.name
      const hitClass = isBest ? ' class="metric"' : ''
      cells.push(
        `<td>${e.meanAbsError.toFixed(0)}px</td>`,
        `<td>${e.p95Error.toFixed(0)}px</td>`,
        `<td${hitClass}>${(e.hitRate * 100).toFixed(0)}%</td>`,
      )
    }
    trRow.innerHTML = cells.join('')
    tbody.appendChild(trRow)
  }
  table.appendChild(tbody)
  resultsHost.innerHTML = ''
  resultsHost.appendChild(table)
}
