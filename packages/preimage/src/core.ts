// DOM-free core. Everything exported here runs in Node, Deno, Bun,
// Web Workers, edge runtimes, and build-time tooling — no `Image`,
// no `HTMLImageElement`, no `createImageBitmap`. The surface is
// either pure arithmetic (fitRect, URL parsers), byte-level probing
// (probeImageBytes, EXIF orientation), or cache access that doesn't
// touch the network.
//
// Typical use:
//   - SSR / build-time: classify URLs, extract dimensions from
//     CDN-encoded paths, seed the measurement cache from a manifest.
//   - Workers: probe image bytes without pulling main-thread DOM.
//   - Catalog tooling: walk a directory of files, parse headers, emit
//     a pre-computed manifest for the client to consume.
//
// The main entry (`@somnai-dreams/preimage`) adds `prepare`,
// `PrepareQueue`, `DecodePool`, and the pretext integration — all of
// which require the DOM or `createImageBitmap`.

export {
  probeImageBytes,
  probeImageStream,
  MAX_HEADER_BYTES,
  type ProbedDimensions,
  type ProbeImageStreamOptions,
  type ProbeImageStreamResult,
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
