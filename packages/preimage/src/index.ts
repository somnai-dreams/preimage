// Main entry. Core image-measurement primitives + single-image layout.
// Pretext-integration lives in the `./pretext` subpath.

export {
  prepare,
  prepareSync,
  layout,
  layoutForWidth,
  layoutForHeight,
  measureAspect,
  measureNaturalSize,
  getMeasurement,
  getElement,
  preparedFromMeasurement,
  getOriginStrategy,
  clearOriginStrategyCache,
  DEFAULT_RANGE_BYTES_BY_FORMAT,
  type PreparedImage,
  type PreparedSource,
  type PrepareOptions,
} from './prepare.js'

export {
  probeImageBytes,
  MAX_HEADER_BYTES,
  type ProbedDimensions,
} from './probe.js'

export { fitRect, type FittedRect, type ObjectFit } from './fit.js'

export {
  registerUrlDimensionParser,
  registerCommonUrlDimensionParsers,
  clearUrlDimensionParsers,
  parseUrlDimensions,
  queryParamDimensionParser,
  cloudinaryParser,
  shopifyParser,
  picsumParser,
  unsplashParser,
  type UrlDimensions,
  type UrlDimensionParser,
} from './url-dimensions.js'

export { PrepareQueue, pickAdaptiveConcurrency, type PrepareQueueOptions } from './prepare-queue.js'

export { DecodePool, type DecodePoolOptions } from './decode-pool.js'

export {
  peekImageMeasurement,
  recordKnownMeasurement,
  measureFromSvgText,
  clearMeasurementCaches,
  listCachedMeasurements,
  type ImageMeasurement,
  type MeasureOptions,
} from './measurement.js'

export {
  analyzeImage,
  getCachedAnalysis,
  clearAnalysisCaches,
  detectImageFormat,
  detectSourceKind,
  normalizeSrc,
  type ImageAnalysis,
  type ImageFormat,
  type SourceKind,
} from './analysis.js'

export {
  applyOrientationToSize,
  describeOrientation,
  isValidOrientationCode,
  readExifOrientation,
  computeItemOrientationLevels,
  type OrientationCode,
  type OrientationInfo,
} from './orientation.js'

// Top-level clearCache — clears all preimage caches at once, matching
// pretext's top-level clearCache() convenience.
import { clearMeasurementCaches } from './measurement.js'
import { clearAnalysisCaches } from './analysis.js'

export function clearCache(): void {
  clearMeasurementCaches()
  clearAnalysisCaches()
}
