// Main entry. Core image-measurement primitives + single-image layout.
// Pretext-integration lives in the `./pretext` subpath; gallery packing in
// `./gallery`.

export {
  prepare,
  prepareSync,
  layout,
  layoutForWidth,
  layoutForHeight,
  measureAspect,
  measureNaturalSize,
  getMeasurement,
  type PreparedImage,
  type PrepareOptions,
} from './prepare.js'

export { fitRect, type FittedRect, type ObjectFit } from './fit.js'

export {
  measureImage,
  measureImages,
  peekImageMeasurement,
  recordKnownMeasurement,
  decodeImageBitmap,
  measureFromSvgText,
  getEngineProfile,
  clearMeasurementCaches,
  listCachedMeasurements,
  type ImageMeasurement,
  type MeasureOptions,
  type EngineProfile,
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
