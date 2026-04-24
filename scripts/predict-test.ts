// Predictive scroll baselines coverage.
//
// Usage: bun run scripts/predict-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createLinearPredictor,
  createMomentumPredictor,
  createScrollObserver,
  createStationaryPredictor,
  evaluatePrediction,
  type ScrollSample,
} from '../packages/preimage/src/predict.ts'

type Check =
  | { ok: true; case: string; notes?: string }
  | { ok: false; case: string; reason: string }

const results: Check[] = []

function pass(label: string, notes?: string): void {
  results.push(notes !== undefined ? { ok: true, case: label, notes } : { ok: true, case: label })
}

function fail(label: string, reason: string): void {
  results.push({ ok: false, case: label, reason })
}

function samplesFrom(fn: (t: number) => number): ScrollSample[] {
  const samples: ScrollSample[] = []
  for (let t = 0; t <= 4000; t += 16) samples.push({ t, y: fn(t) })
  return samples
}

function caseLinearBeatsStationary(): void {
  const samples = samplesFrom((t) => t * 2)
  const stationary = evaluatePrediction(createStationaryPredictor(), samples, {
    horizonMs: 500,
    tolerancePx: 50,
    minHistory: 4,
  })
  const linear = evaluatePrediction(createLinearPredictor(), samples, {
    horizonMs: 500,
    tolerancePx: 50,
    minHistory: 4,
  })
  if (linear.hitRate < 0.95) {
    fail('predict/linear-constant-hit-rate', `hitRate=${linear.hitRate}`)
  } else if (stationary.hitRate > 0.05) {
    fail('predict/stationary-constant-baseline', `hitRate=${stationary.hitRate}`)
  } else {
    pass('predict/linear-beats-stationary')
  }
}

function caseMomentumDecelerates(): void {
  const samples = samplesFrom((t) => 8000 * (1 - Math.exp(-0.002 * t)))
  const linear = evaluatePrediction(createLinearPredictor(), samples, {
    horizonMs: 500,
    tolerancePx: 250,
    minHistory: 4,
  })
  const momentum = evaluatePrediction(createMomentumPredictor({ dragPerMs: 0.004 }), samples, {
    horizonMs: 500,
    tolerancePx: 250,
    minHistory: 4,
  })
  if (momentum.p95ErrorPx >= linear.p95ErrorPx) {
    fail('predict/momentum-deceleration', `linear=${linear.p95ErrorPx} momentum=${momentum.p95ErrorPx}`)
  } else {
    pass('predict/momentum-deceleration')
  }
}

function caseObserverRollingWindow(): void {
  let t = 0
  const listeners = new Set<() => void>()
  const fake = {
    scrollTop: 0,
    addEventListener(_type: string, cb: () => void) {
      listeners.add(cb)
    },
    removeEventListener(_type: string, cb: () => void) {
      listeners.delete(cb)
    },
  }
  const observer = createScrollObserver(fake as unknown as HTMLElement, {
    sampleRateMs: 1000,
    maxSamples: 3,
    now: () => t,
  })
  for (let i = 1; i <= 5; i++) {
    t += 100
    fake.scrollTop = i * 10
    observer.sample()
  }
  const samples = observer.samples()
  const velocity = observer.velocityPxPerMs()
  observer.destroy()
  if (samples.length !== 3) {
    fail('predict/observer-window', `length=${samples.length}`)
  } else if (velocity <= 0) {
    fail('predict/observer-velocity', `velocity=${velocity}`)
  } else if (listeners.size !== 0) {
    fail('predict/observer-destroy', `listeners=${listeners.size}`)
  } else {
    pass('predict/observer-rolling-window')
  }
}

function caseValidation(): void {
  try {
    createLinearPredictor({ smoothingWindow: 0 })
    fail('predict/validation', 'no throw')
  } catch (err) {
    if (err instanceof RangeError) pass('predict/validation')
    else fail('predict/validation', String(err))
  }
}

async function main(): Promise<void> {
  const t0 = performance.now()
  caseLinearBeatsStationary()
  caseMomentumDecelerates()
  caseObserverRollingWindow()
  caseValidation()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== predict-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `predict-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'predict', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
      null,
      2,
    ),
  )
  process.stdout.write(`=== Saved ${outPath} ===\n`)
  if (failed.length > 0) process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
