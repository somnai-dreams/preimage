// Offline hyperparameter sweep for the scroll predictors.
//
// Synthesizes scroll trajectories for each pattern × peak velocity,
// evaluates every (predictor, config, horizon) combination, reports
// the Pareto-optimal configs. The browser bench at
// /bench/predict.html measures one config at a time on a real DOM
// scroll; this harness lets us grid-search hyperparameters in seconds
// instead of clicking through the UI one config at a time.
//
// Methodology matches the browser bench:
//   1. Synthesize a scroll trajectory as a ScrollSample[] (regular
//      sampling at sampleRateMs).
//   2. For each sample at time T, the predictor looks at samples up
//      to (T - horizonMs) and predicts scroll-Y at T. We compare to
//      the actual sample.
//   3. Report mean / p50 / p95 / max error and hit-rate within a
//      tolerance band.
//
// Output:
//   - benchmarks/predict-sweep-<iso-date>.json  (full matrix)
//   - console summary: best config per (pattern, horizon) by hit-rate
//   - delta summary: best predictor config vs stationary baseline
//
// Usage:
//   bun run scripts/predict-sweep.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLinearPredictor,
  createMomentumPredictor,
  evaluatePrediction,
  type PredictionEvaluation,
  type ScrollSample,
} from '../packages/preimage/src/predict.ts'

// --- Sweep grid ---

const PATTERNS = [
  'constant',
  'accelerating',
  'decelerating',
  'direction-change',
  'fling',
] as const
type Pattern = (typeof PATTERNS)[number]

const PEAK_VELOCITIES = [1000, 2500, 5000] // px/sec
const HORIZONS_MS = [100, 250, 500, 1000]
const TOLERANCES_PX = [200, 400, 800]
const DURATION_MS = 2000
const SAMPLE_RATE_MS = 8

const VELOCITY_WINDOWS = [2, 3, 4, 5, 6, 8, 12]
const DRAG_PER_SEC = [0, 0.5, 1, 2, 3, 4, 5, 6, 8, 10]

// --- Trajectory synthesis ---

function synthesizeTrajectory(
  pattern: Pattern,
  peakVelocity: number,
  durationMs: number,
  sampleRateMs: number,
): ScrollSample[] {
  const samples: ScrollSample[] = []
  for (let t = 0; t <= durationMs; t += sampleRateMs) {
    samples.push({ t, scrollY: computeScrollY(pattern, peakVelocity, t, durationMs) })
  }
  return samples
}

function computeScrollY(
  pattern: Pattern,
  peakVelocity: number,
  elapsed: number,
  durationMs: number,
): number {
  switch (pattern) {
    case 'constant':
      return peakVelocity * (elapsed / 1000)
    case 'accelerating':
      // v ramps linearly 0 → peak over durationMs.
      //   v(t_sec) = peak × (t_sec / (durationMs/1000))
      //   s(t_sec) = peak × t_sec² × 1000 / (2 × durationMs)
      // With elapsed in ms, t_sec = elapsed / 1000, so:
      //   s = peak × elapsed² / (2000 × durationMs)
      return (peakVelocity * elapsed * elapsed) / (2000 * durationMs)
    case 'decelerating':
      // v(t) = peak * (1 - t/dur); s(t) = peak/1000 × (t - t²/(2·dur))
      return (peakVelocity / 1000) * (elapsed - (elapsed * elapsed) / (2 * durationMs))
    case 'direction-change': {
      const half = durationMs / 2
      if (elapsed < half) return peakVelocity * (elapsed / 1000)
      const downFinal = peakVelocity * (half / 1000)
      const upElapsed = elapsed - half
      return Math.max(0, downFinal - peakVelocity * (upElapsed / 1000))
    }
    case 'fling': {
      const drag = 4
      const t = elapsed / 1000
      return (peakVelocity / drag) * (1 - Math.exp(-drag * t))
    }
  }
}

// --- Synthetic observer over a history slice ---

type MinimalObserver = Parameters<typeof createLinearPredictor>[0]

function observerOver(history: readonly ScrollSample[]): MinimalObserver {
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

// --- Config space ---

type LinearConfig = { predictor: 'linear'; velocityWindow: number }
type MomentumConfig = { predictor: 'momentum'; velocityWindow: number; dragPerSec: number }
type StationaryConfig = { predictor: 'stationary' }
type PredictorConfig = LinearConfig | MomentumConfig | StationaryConfig

function* allConfigs(): Iterable<PredictorConfig> {
  yield { predictor: 'stationary' }
  for (const velocityWindow of VELOCITY_WINDOWS) {
    yield { predictor: 'linear', velocityWindow }
  }
  for (const velocityWindow of VELOCITY_WINDOWS) {
    for (const dragPerSec of DRAG_PER_SEC) {
      yield { predictor: 'momentum', velocityWindow, dragPerSec }
    }
  }
}

function evaluateConfig(
  config: PredictorConfig,
  samples: readonly ScrollSample[],
  horizonMs: number,
  tolerancePx: number,
): PredictionEvaluation {
  return evaluatePrediction(
    samples,
    horizonMs,
    (history) => {
      if (config.predictor === 'stationary') {
        return { scrollY: history[history.length - 1]!.scrollY, confidence: 1 }
      }
      const obs = observerOver(history)
      const predictor =
        config.predictor === 'linear'
          ? createLinearPredictor(obs, {
              horizonMs,
              velocityWindow: config.velocityWindow,
            })
          : createMomentumPredictor(obs, {
              horizonMs,
              velocityWindow: config.velocityWindow,
              dragPerSec: config.dragPerSec,
            })
      return predictor.predict()
    },
    tolerancePx,
  )
}

// --- Run the sweep ---

type ResultRow = {
  pattern: Pattern
  peakVelocity: number
  horizonMs: number
  tolerancePx: number
  config: PredictorConfig
  eval: PredictionEvaluation
}

function runSweep(): ResultRow[] {
  const rows: ResultRow[] = []
  const configs = Array.from(allConfigs())
  let progress = 0
  const totalOuter = PATTERNS.length * PEAK_VELOCITIES.length
  for (const pattern of PATTERNS) {
    for (const peakVelocity of PEAK_VELOCITIES) {
      progress++
      process.stderr.write(
        `[${progress}/${totalOuter}] ${pattern} · ${peakVelocity} px/s × ${configs.length} configs × ${HORIZONS_MS.length} horizons × ${TOLERANCES_PX.length} tolerances\n`,
      )
      const samples = synthesizeTrajectory(pattern, peakVelocity, DURATION_MS, SAMPLE_RATE_MS)
      for (const horizonMs of HORIZONS_MS) {
        for (const tolerancePx of TOLERANCES_PX) {
          for (const config of configs) {
            rows.push({
              pattern,
              peakVelocity,
              horizonMs,
              tolerancePx,
              config,
              eval: evaluateConfig(config, samples, horizonMs, tolerancePx),
            })
          }
        }
      }
    }
  }
  return rows
}

// --- Summary ---

function configKey(c: PredictorConfig): string {
  if (c.predictor === 'stationary') return 'stationary'
  if (c.predictor === 'linear') return `linear/w=${c.velocityWindow}`
  return `momentum/w=${c.velocityWindow}/d=${c.dragPerSec}`
}

function bestByAvgHitRate(
  rows: readonly ResultRow[],
  filter: (r: ResultRow) => boolean,
): { config: PredictorConfig; avgHitRate: number } | null {
  const byConfig = new Map<string, { config: PredictorConfig; sum: number; count: number }>()
  for (const row of rows) {
    if (!filter(row)) continue
    const key = configKey(row.config)
    const existing = byConfig.get(key)
    if (existing === undefined) {
      byConfig.set(key, { config: row.config, sum: row.eval.hitRate, count: 1 })
    } else {
      existing.sum += row.eval.hitRate
      existing.count += 1
    }
  }
  let best: { config: PredictorConfig; avgHitRate: number } | null = null
  for (const entry of byConfig.values()) {
    const avg = entry.sum / entry.count
    if (best === null || avg > best.avgHitRate) best = { config: entry.config, avgHitRate: avg }
  }
  return best
}

function summarize(rows: readonly ResultRow[]): {
  bestPerHorizon: Record<number, { config: PredictorConfig; avgHitRate: number } | null>
  bestOverall: { config: PredictorConfig; avgHitRate: number } | null
  stationaryBaseline: Record<number, number>
  worstCasePattern: Record<string, { config: PredictorConfig; avgHitRate: number } | null>
} {
  const bestPerHorizon: Record<number, { config: PredictorConfig; avgHitRate: number } | null> = {}
  for (const horizonMs of HORIZONS_MS) {
    bestPerHorizon[horizonMs] = bestByAvgHitRate(
      rows,
      (r) => r.horizonMs === horizonMs && r.tolerancePx === 400,
    )
  }
  const bestOverall = bestByAvgHitRate(rows, (r) => r.tolerancePx === 400)

  // Stationary baseline for comparison at tolerance=400.
  const stationaryBaseline: Record<number, number> = {}
  for (const horizonMs of HORIZONS_MS) {
    const matching = rows.filter(
      (r) =>
        r.config.predictor === 'stationary' &&
        r.horizonMs === horizonMs &&
        r.tolerancePx === 400,
    )
    const sum = matching.reduce((s, r) => s + r.eval.hitRate, 0)
    stationaryBaseline[horizonMs] = matching.length > 0 ? sum / matching.length : 0
  }

  // Worst-case: for each pattern, find the best config (averaged
  // across peak velocity / horizon / tolerance=400).
  const worstCasePattern: Record<string, { config: PredictorConfig; avgHitRate: number } | null> = {}
  for (const pattern of PATTERNS) {
    worstCasePattern[pattern] = bestByAvgHitRate(
      rows,
      (r) => r.pattern === pattern && r.tolerancePx === 400,
    )
  }

  return { bestPerHorizon, bestOverall, stationaryBaseline, worstCasePattern }
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  const rows = runSweep()
  const wallMs = performance.now() - t0
  process.stderr.write(`sweep done in ${wallMs.toFixed(0)}ms · ${rows.length} rows\n\n`)

  const summary = summarize(rows)
  process.stdout.write('=== Best configs (averaged hit-rate across patterns × velocities, tolerance=400px) ===\n\n')
  for (const horizonMs of HORIZONS_MS) {
    const best = summary.bestPerHorizon[horizonMs]
    const baseline = summary.stationaryBaseline[horizonMs]!
    if (best === null) continue
    const delta = best.avgHitRate - baseline
    process.stdout.write(
      `  ${String(horizonMs).padStart(4)}ms  best=${configKey(best.config).padEnd(24)}  hit=${(best.avgHitRate * 100).toFixed(1)}%  (baseline ${(baseline * 100).toFixed(1)}%, Δ ${(delta * 100).toFixed(1)}%)\n`,
    )
  }

  process.stdout.write('\n=== Best overall (averaged across all horizons × patterns × velocities) ===\n\n')
  if (summary.bestOverall !== null) {
    process.stdout.write(
      `  ${configKey(summary.bestOverall.config)}  avgHit=${(summary.bestOverall.avgHitRate * 100).toFixed(1)}%\n`,
    )
  }

  process.stdout.write('\n=== Best config per pattern (tolerance=400px) ===\n\n')
  for (const pattern of PATTERNS) {
    const best = summary.worstCasePattern[pattern]
    if (best === null) continue
    process.stdout.write(
      `  ${pattern.padEnd(18)}  best=${configKey(best.config).padEnd(24)}  hit=${(best.avgHitRate * 100).toFixed(1)}%\n`,
    )
  }

  // Determine whether the best predictor beats stationary by a clear
  // margin — the gate for recommending default changes.
  const avgStationaryAt500 = summary.stationaryBaseline[500] ?? 0
  const bestAt500 = summary.bestPerHorizon[500]
  const delta500 =
    bestAt500 !== null ? bestAt500.avgHitRate - avgStationaryAt500 : 0
  process.stdout.write('\n=== Gate evaluation (500ms horizon) ===\n\n')
  if (delta500 >= 0.2) {
    process.stdout.write(
      `  PASS: best predictor beats stationary by ${(delta500 * 100).toFixed(1)}%. Consider updating createLinearPredictor/createMomentumPredictor defaults to match the winner.\n`,
    )
  } else if (delta500 >= 0.05) {
    process.stdout.write(
      `  MARGINAL: best predictor beats stationary by ${(delta500 * 100).toFixed(1)}%. Worth building the pool integration to validate against real scroll patterns; current defaults may not need changing.\n`,
    )
  } else {
    process.stdout.write(
      `  FAIL: best predictor only beats stationary by ${(delta500 * 100).toFixed(1)}%. Predictive pre-rendering may not be worth pursuing for typical scroll patterns.\n`,
    )
  }

  // Save the full matrix.
  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `predict-sweep-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'predict-sweep',
        date: new Date().toISOString(),
        grid: {
          patterns: PATTERNS,
          peakVelocities: PEAK_VELOCITIES,
          horizons: HORIZONS_MS,
          tolerances: TOLERANCES_PX,
          durationMs: DURATION_MS,
          sampleRateMs: SAMPLE_RATE_MS,
          velocityWindows: VELOCITY_WINDOWS,
          dragPerSec: DRAG_PER_SEC,
        },
        summary,
        // Keep rows lean — flatten the config shape, drop samples.
        rows: rows.map((r) => ({
          pattern: r.pattern,
          peakVelocity: r.peakVelocity,
          horizonMs: r.horizonMs,
          tolerancePx: r.tolerancePx,
          config: r.config,
          meanAbsError: r.eval.meanAbsError,
          p95Error: r.eval.p95Error,
          maxError: r.eval.maxError,
          hitRate: r.eval.hitRate,
        })),
      },
      null,
      2,
    ),
  )
  process.stdout.write(`\n=== Saved ${outPath} ===\n`)
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
