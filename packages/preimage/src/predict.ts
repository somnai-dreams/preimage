// Scroll-position prediction helpers. These are intentionally small
// baselines, not a learning system: enough to answer whether cheap
// physics gives a virtual pool useful lookahead before building a
// heavier pre-rendering path.

export type ScrollSample = {
  /** Monotonic timestamp in ms. */
  readonly t: number
  /** Scroll position in px. */
  readonly y: number
}

export type ScrollObserverOptions = {
  /** Background sampling interval. Defaults to 50ms. */
  sampleRateMs?: number
  /** Maximum rolling samples retained. Defaults to 40. */
  maxSamples?: number
  /** Test hook; defaults to `performance.now()`. */
  now?: () => number
}

export type ScrollObserver = {
  /** Capture the container's current `scrollTop` now. */
  sample(): ScrollSample
  /** Rolling samples, oldest first. */
  samples(): readonly ScrollSample[]
  /** Latest sample, or null before the first sample. */
  current(): ScrollSample | null
  /** Recent velocity in px/ms. */
  velocityPxPerMs(): number
  /** Recent acceleration in px/ms^2. */
  accelerationPxPerMs2(): number
  /** Remove listeners and stop background sampling. */
  destroy(): void
}

export type ScrollPrediction = {
  /** Predicted scroll position at `now + horizonMs`. */
  readonly y: number
  /** 0..1 confidence score. */
  readonly confidence: number
}

export type ScrollPredictor = {
  readonly name: string
  predict(samples: readonly ScrollSample[], horizonMs: number): ScrollPrediction
}

export type LinearPredictorOptions = {
  /** Number of recent velocity segments used for smoothing. */
  smoothingWindow?: number
  /** Confidence stays high below this velocity, then decays. */
  confidenceVelocityPxPerMs?: number
}

export type MomentumPredictorOptions = LinearPredictorOptions & {
  /** Exponential velocity decay per ms. `0` degenerates to linear. */
  dragPerMs?: number
}

export type PredictionEvaluationOptions = {
  horizonMs: number
  /** Count a prediction as a hit when abs error <= this value. */
  tolerancePx?: number
  /** Minimum history samples before making predictions. */
  minHistory?: number
}

export type PredictionEvaluation = {
  predictor: string
  horizonMs: number
  tolerancePx: number
  count: number
  meanErrorPx: number
  p50ErrorPx: number
  p95ErrorPx: number
  maxErrorPx: number
  hitRate: number
  meanConfidence: number
}

export function createScrollObserver(
  container: HTMLElement,
  options: ScrollObserverOptions = {},
): ScrollObserver {
  const sampleRateMs = positiveFinite(options.sampleRateMs ?? 50, 'sampleRateMs')
  const maxSamples = positiveInteger(options.maxSamples ?? 40, 'maxSamples')
  const now = options.now ?? defaultNow
  const samples: ScrollSample[] = []
  let destroyed = false

  function pushSample(sample: ScrollSample): ScrollSample {
    const last = samples[samples.length - 1]
    if (last !== undefined && sample.t <= last.t) {
      samples[samples.length - 1] = { t: last.t + 0.001, y: sample.y }
    } else {
      samples.push(sample)
    }
    while (samples.length > maxSamples) samples.shift()
    return samples[samples.length - 1]!
  }

  const observer: ScrollObserver = {
    sample() {
      if (destroyed) return samples[samples.length - 1] ?? { t: now(), y: container.scrollTop }
      return pushSample({ t: now(), y: container.scrollTop })
    },
    samples() {
      return samples.slice()
    },
    current() {
      return samples[samples.length - 1] ?? null
    },
    velocityPxPerMs() {
      return velocityPxPerMs(samples)
    },
    accelerationPxPerMs2() {
      return accelerationPxPerMs2(samples)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      clearInterval(interval)
      container.removeEventListener('scroll', onScroll)
    },
  }

  const onScroll = (): void => {
    observer.sample()
  }
  const interval = setInterval(() => {
    observer.sample()
  }, sampleRateMs)
  container.addEventListener('scroll', onScroll, { passive: true })
  observer.sample()
  return observer
}

export function createStationaryPredictor(): ScrollPredictor {
  return {
    name: 'stationary',
    predict(samples) {
      const latest = samples[samples.length - 1]
      return { y: latest?.y ?? 0, confidence: 1 }
    },
  }
}

export function createLinearPredictor(options: LinearPredictorOptions = {}): ScrollPredictor {
  const smoothingWindow = positiveInteger(options.smoothingWindow ?? 4, 'smoothingWindow')
  const confidenceVelocityPxPerMs = positiveFinite(
    options.confidenceVelocityPxPerMs ?? 4,
    'confidenceVelocityPxPerMs',
  )
  return {
    name: 'linear',
    predict(samples, horizonMs) {
      const latest = samples[samples.length - 1]
      if (latest === undefined) return { y: 0, confidence: 0 }
      const velocity = smoothedVelocity(samples, smoothingWindow)
      return {
        y: latest.y + velocity * Math.max(0, horizonMs),
        confidence: velocityConfidence(velocity, confidenceVelocityPxPerMs),
      }
    },
  }
}

export function createMomentumPredictor(options: MomentumPredictorOptions = {}): ScrollPredictor {
  const smoothingWindow = positiveInteger(options.smoothingWindow ?? 4, 'smoothingWindow')
  const confidenceVelocityPxPerMs = positiveFinite(
    options.confidenceVelocityPxPerMs ?? 4,
    'confidenceVelocityPxPerMs',
  )
  const dragPerMs = nonNegativeFinite(options.dragPerMs ?? 0.004, 'dragPerMs')
  return {
    name: 'momentum',
    predict(samples, horizonMs) {
      const latest = samples[samples.length - 1]
      if (latest === undefined) return { y: 0, confidence: 0 }
      const h = Math.max(0, horizonMs)
      const velocity = smoothedVelocity(samples, smoothingWindow)
      const displacement =
        dragPerMs === 0
          ? velocity * h
          : (velocity * (1 - Math.exp(-dragPerMs * h))) / dragPerMs
      const horizonPenalty = Math.exp(-h / 1200)
      return {
        y: latest.y + displacement,
        confidence: velocityConfidence(velocity, confidenceVelocityPxPerMs) * horizonPenalty,
      }
    },
  }
}

export function evaluatePrediction(
  predictor: ScrollPredictor,
  samples: readonly ScrollSample[],
  options: PredictionEvaluationOptions,
): PredictionEvaluation {
  const horizonMs = positiveFinite(options.horizonMs, 'horizonMs')
  const tolerancePx = nonNegativeFinite(options.tolerancePx ?? 250, 'tolerancePx')
  const minHistory = positiveInteger(options.minHistory ?? 2, 'minHistory')
  const ordered = [...samples].sort((a, b) => a.t - b.t)
  const errors: number[] = []
  const confidences: number[] = []
  let hits = 0

  for (let i = minHistory - 1; i < ordered.length; i++) {
    const current = ordered[i]!
    const targetT = current.t + horizonMs
    const actual = interpolateY(ordered, targetT, i)
    if (actual === null) continue
    const history = ordered.slice(0, i + 1)
    const prediction = predictor.predict(history, horizonMs)
    const error = Math.abs(prediction.y - actual)
    errors.push(error)
    confidences.push(clamp01(prediction.confidence))
    if (error <= tolerancePx) hits++
  }

  const errorDist = distribution(errors)
  const confidenceMean =
    confidences.length === 0
      ? 0
      : confidences.reduce((sum, value) => sum + value, 0) / confidences.length
  return {
    predictor: predictor.name,
    horizonMs,
    tolerancePx,
    count: errors.length,
    meanErrorPx: errorDist.mean,
    p50ErrorPx: errorDist.p50,
    p95ErrorPx: errorDist.p95,
    maxErrorPx: errorDist.max,
    hitRate: errors.length === 0 ? 0 : hits / errors.length,
    meanConfidence: confidenceMean,
  }
}

export function velocityPxPerMs(samples: readonly ScrollSample[]): number {
  const n = samples.length
  if (n < 2) return 0
  const a = samples[n - 2]!
  const b = samples[n - 1]!
  return segmentVelocity(a, b)
}

export function accelerationPxPerMs2(samples: readonly ScrollSample[]): number {
  const n = samples.length
  if (n < 3) return 0
  const a = samples[n - 3]!
  const b = samples[n - 2]!
  const c = samples[n - 1]!
  const v0 = segmentVelocity(a, b)
  const v1 = segmentVelocity(b, c)
  const dt = c.t - b.t
  return dt > 0 ? (v1 - v0) / dt : 0
}

function smoothedVelocity(samples: readonly ScrollSample[], windowSize: number): number {
  if (samples.length < 2) return 0
  const start = Math.max(1, samples.length - windowSize)
  let weighted = 0
  let weightSum = 0
  for (let i = start; i < samples.length; i++) {
    const weight = i - start + 1
    weighted += segmentVelocity(samples[i - 1]!, samples[i]!) * weight
    weightSum += weight
  }
  return weightSum > 0 ? weighted / weightSum : 0
}

function segmentVelocity(a: ScrollSample, b: ScrollSample): number {
  const dt = b.t - a.t
  return dt > 0 ? (b.y - a.y) / dt : 0
}

function velocityConfidence(velocity: number, threshold: number): number {
  const speed = Math.abs(velocity)
  if (speed <= threshold) return 1
  return clamp01(threshold / speed)
}

function interpolateY(
  samples: readonly ScrollSample[],
  targetT: number,
  startIndex: number,
): number | null {
  for (let i = startIndex + 1; i < samples.length; i++) {
    const before = samples[i - 1]!
    const after = samples[i]!
    if (targetT < before.t) return null
    if (targetT <= after.t) {
      const span = after.t - before.t
      if (span <= 0) return after.y
      const p = (targetT - before.t) / span
      return before.y + (after.y - before.y) * p
    }
  }
  return null
}

function distribution(samples: readonly number[]): {
  mean: number
  p50: number
  p95: number
  max: number
} {
  if (samples.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return {
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1]!,
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return value
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`)
  }
  return value
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number`)
  }
  return value
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
