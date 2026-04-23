// Scroll-prediction scaffolding. Phase 0 of the predictive-pre-
// rendering swing. Not an ML system — just the observer, predictor
// interface, and two baseline predictors (linear extrapolation,
// momentum-with-drag). A real ML predictor would plug into the same
// shape.
//
// The point of this module is to answer, before any ML investment:
// does a cheap physics-based predictor beat fixed overscan? If yes,
// the ML version is worth building. If no, predictive pre-rendering
// is a dead end for this particular workload.
//
// Composition pattern:
//
//   const observer = createScrollObserver(scrollContainer, { sampleRateMs: 16 })
//   const predictor = createMomentumPredictor(observer, { horizonMs: 500, dragPerSec: 3 })
//   // On every rAF:
//   const { scrollY, confidence } = predictor.predict()
//   // Use scrollY + clientHeight to compute expected visible range.
//
// The predictor doesn't drive anything on its own — the pool or tile
// manager consults it to bias overscan. That keeps the prediction
// module pure (no DOM writes), the integration lives in the caller.

// --- Scroll observer ---

export type ScrollSample = {
  t: number       // performance.now()
  scrollY: number // CSS pixels from top of content
}

export type ScrollObserver = {
  /** Latest sampled scroll position + timestamp. */
  current(): ScrollSample
  /** Rolling window of samples (newest last). */
  samples(): readonly ScrollSample[]
  /** Instantaneous velocity in px/sec, computed from the last two
   *  samples. Positive = scrolling down. Zero when there's only one
   *  sample. */
  velocity(): number
  /** Smoothed velocity over the last N samples (default 4). Less
   *  responsive than `velocity()`, less noisy too. */
  smoothedVelocity(windowSize?: number): number
  /** Acceleration in px/sec². From the last three samples. Zero
   *  with <3 samples. */
  acceleration(): number
  /** Stop observing. The observer stops sampling + detaches its
   *  scroll listener. */
  destroy(): void
}

export type ScrollObserverOptions = {
  /** Time between samples in ms. Default 16 (~60Hz). */
  sampleRateMs?: number
  /** Max samples kept in the rolling window. Default 32. Older
   *  samples are dropped. */
  maxSamples?: number
  /** Scroll-property reader. Defaults to reading `.scrollTop` from
   *  the container. Override for non-standard scroll surfaces (e.g.
   *  transform-based scrollers). */
  readScrollY?: () => number
}

/** Create a scroll observer attached to `container`. Samples at a
 *  steady rate via `setInterval`; the caller can use the observer's
 *  getters at arbitrary times. */
export function createScrollObserver(
  container: HTMLElement | Document,
  options: ScrollObserverOptions = {},
): ScrollObserver {
  const sampleRateMs = options.sampleRateMs ?? 16
  const maxSamples = options.maxSamples ?? 32
  const readScrollY = options.readScrollY ?? defaultReadScrollY(container)

  const samples: ScrollSample[] = []

  function sample(): void {
    samples.push({ t: performance.now(), scrollY: readScrollY() })
    if (samples.length > maxSamples) samples.shift()
  }
  sample() // seed

  const intervalId = setInterval(sample, sampleRateMs)
  const scrollTarget = container === document ? window : container
  const scrollListener = (): void => sample()
  scrollTarget.addEventListener('scroll', scrollListener, { passive: true })

  function current(): ScrollSample {
    return samples[samples.length - 1]!
  }

  function velocity(): number {
    if (samples.length < 2) return 0
    const a = samples[samples.length - 2]!
    const b = samples[samples.length - 1]!
    const dt = (b.t - a.t) / 1000
    if (dt <= 0) return 0
    return (b.scrollY - a.scrollY) / dt
  }

  function smoothedVelocity(windowSize = 4): number {
    if (samples.length < 2) return 0
    const start = Math.max(0, samples.length - windowSize - 1)
    let sum = 0
    let count = 0
    for (let i = start + 1; i < samples.length; i++) {
      const a = samples[i - 1]!
      const b = samples[i]!
      const dt = (b.t - a.t) / 1000
      if (dt <= 0) continue
      sum += (b.scrollY - a.scrollY) / dt
      count++
    }
    return count === 0 ? 0 : sum / count
  }

  function acceleration(): number {
    if (samples.length < 3) return 0
    const a = samples[samples.length - 3]!
    const b = samples[samples.length - 2]!
    const c = samples[samples.length - 1]!
    const dt1 = (b.t - a.t) / 1000
    const dt2 = (c.t - b.t) / 1000
    if (dt1 <= 0 || dt2 <= 0) return 0
    const v1 = (b.scrollY - a.scrollY) / dt1
    const v2 = (c.scrollY - b.scrollY) / dt2
    return (v2 - v1) / dt2
  }

  function destroy(): void {
    clearInterval(intervalId)
    scrollTarget.removeEventListener('scroll', scrollListener)
  }

  return {
    current,
    samples: () => samples.slice(),
    velocity,
    smoothedVelocity,
    acceleration,
    destroy,
  }
}

function defaultReadScrollY(container: HTMLElement | Document): () => number {
  if (container === document) {
    return () => window.scrollY
  }
  const el = container as HTMLElement
  return () => el.scrollTop
}

// --- Predictors ---

export type ScrollPrediction = {
  /** Predicted scroll-Y at the configured horizon. */
  scrollY: number
  /** 0..1 confidence. 1 = observer is stationary and prediction is
   *  trivially correct; < 0.5 = high-velocity / high-acceleration
   *  regime where the predictor shouldn't be over-trusted. */
  confidence: number
}

export type Predictor = {
  /** Predict the future scroll position at the configured horizon
   *  from the observer's current state. */
  predict(): ScrollPrediction
}

// --- Baseline: stationary ---

/** Returns the current position, confidence 1. Useful as a baseline
 *  and as a fallback when other predictors have too little signal. */
export function createStationaryPredictor(observer: ScrollObserver): Predictor {
  return {
    predict() {
      return { scrollY: observer.current().scrollY, confidence: 1 }
    },
  }
}

// --- Linear extrapolation ---

export type LinearPredictorOptions = {
  /** How far into the future to predict, in ms. Default 500. */
  horizonMs?: number
  /** Window size for velocity smoothing. Default 4. Smaller = more
   *  responsive, noisier; larger = stabler, laggier. */
  velocityWindow?: number
}

/** Extrapolates scroll-Y = current + smoothedVelocity × horizon.
 *  Confidence decays with velocity magnitude above a threshold
 *  (higher velocities = more likely to change direction).
 *
 *  Default `velocityWindow: 2`. Chosen from the sweep at
 *  `scripts/predict-sweep.ts` — a 2-sample window hits 92% within
 *  ±400px at a 500ms horizon across the five standard scroll
 *  patterns, versus 37% for the stationary baseline. Longer windows
 *  smooth noise but lag behind velocity changes; the 2-sample
 *  window tracks genuine scroll behavior closely enough to
 *  dominate smoothed variants. */
export function createLinearPredictor(
  observer: ScrollObserver,
  options: LinearPredictorOptions = {},
): Predictor {
  const horizonMs = options.horizonMs ?? 500
  const velocityWindow = options.velocityWindow ?? 2
  const HIGH_VELOCITY_THRESHOLD = 3000 // px/sec; above here, fling-ish
  return {
    predict() {
      const current = observer.current()
      const v = observer.smoothedVelocity(velocityWindow)
      const scrollY = current.scrollY + v * (horizonMs / 1000)
      const speed = Math.abs(v)
      const confidence = speed < 50 ? 1 : Math.max(0.3, 1 - speed / HIGH_VELOCITY_THRESHOLD)
      return { scrollY, confidence }
    },
  }
}

// --- Momentum with drag ---

export type MomentumPredictorOptions = {
  /** Horizon in ms. Default 500. */
  horizonMs?: number
  /** Velocity window for smoothing. Default 4. */
  velocityWindow?: number
  /** Drag coefficient in 1/sec. Velocity decays as
   *  `v(t) = v(0) × exp(-drag × t)`. 0 = no decay (same as linear),
   *  3 = typical browser fling, 10 = snappy. Default 3. */
  dragPerSec?: number
}

/** Physics-based predictor: integrate velocity with exponential
 *  drag over the horizon. More realistic than linear for user-
 *  initiated scrolls (flings decelerate), worse than linear for
 *  programmatic scroll animations (which ignore drag). */
export function createMomentumPredictor(
  observer: ScrollObserver,
  options: MomentumPredictorOptions = {},
): Predictor {
  const horizonMs = options.horizonMs ?? 500
  const velocityWindow = options.velocityWindow ?? 4
  const dragPerSec = options.dragPerSec ?? 3
  return {
    predict() {
      const current = observer.current()
      const v0 = observer.smoothedVelocity(velocityWindow)
      const t = horizonMs / 1000
      // Integral of v0 * exp(-drag * s) from 0 to t
      //   = v0 / drag * (1 - exp(-drag * t))
      const displacement =
        dragPerSec === 0 ? v0 * t : (v0 / dragPerSec) * (1 - Math.exp(-dragPerSec * t))
      const scrollY = current.scrollY + displacement
      const speed = Math.abs(v0)
      const confidence = speed < 50 ? 1 : Math.max(0.4, 1 - speed / 4000)
      return { scrollY, confidence }
    },
  }
}

// --- Evaluator ---

export type PredictionEvaluation = {
  /** Number of predict() calls evaluated. */
  count: number
  /** Mean absolute error between prediction and ground truth, px. */
  meanAbsError: number
  /** 50th / 95th percentile error, px. */
  p50Error: number
  p95Error: number
  /** Max error, px. */
  maxError: number
  /** Fraction of predictions whose error was <= `tolerancePx`.
   *  "hit rate" — how often the predicted range covered the actual. */
  hitRate: number
}

/** Evaluate a predictor against a ground-truth scroll trajectory.
 *  `samples` is the actual scroll history; for each sample at time
 *  `t`, we ask "what did the predictor (looking at samples up to
 *  `t - horizonMs`) think scroll-Y would be at `t`?" and compare
 *  with the actual.
 *
 *  For the bench: run a scripted scroll, capture samples, then
 *  evaluate each candidate predictor. Cheap; doesn't require
 *  re-running the scroll per predictor. */
export function evaluatePrediction(
  samples: readonly ScrollSample[],
  horizonMs: number,
  predictAt: (historyUpTo: readonly ScrollSample[]) => ScrollPrediction,
  tolerancePx: number,
): PredictionEvaluation {
  const errors: number[] = []
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!
    // Find the history up to (sample.t - horizonMs); if we don't
    // have enough, skip.
    const cutoffT = sample.t - horizonMs
    let cutoffIdx = -1
    for (let j = i - 1; j >= 0; j--) {
      if (samples[j]!.t <= cutoffT) {
        cutoffIdx = j
        break
      }
    }
    if (cutoffIdx < 1) continue
    const history = samples.slice(0, cutoffIdx + 1)
    const prediction = predictAt(history)
    errors.push(Math.abs(prediction.scrollY - sample.scrollY))
  }
  if (errors.length === 0) {
    return { count: 0, meanAbsError: 0, p50Error: 0, p95Error: 0, maxError: 0, hitRate: 0 }
  }
  const sorted = [...errors].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    meanAbsError: sum / sorted.length,
    p50Error: sorted[Math.floor(sorted.length * 0.5)]!,
    p95Error: sorted[Math.floor(sorted.length * 0.95)]!,
    maxError: sorted[sorted.length - 1]!,
    hitRate: sorted.filter((e) => e <= tolerancePx).length / sorted.length,
  }
}
