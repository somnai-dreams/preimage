// Image loading & intrinsic-size measurement for browser environments.
//
// Problem: DOM-based image measurement forces the caller to insert an <img>
// and wait for `load`, then read `naturalWidth`/`naturalHeight`. For a gallery
// of N images, this either serializes behind layout reflow or races with it.
// Re-measuring on every resize thrashes the cache.
//
// Solution: two-phase measurement centered around `HTMLImageElement.decode()`.
//   prepare(src) — triggers the browser fetch + decode pipeline once, reads
//     intrinsic dimensions into a typed record, caches by normalized src.
//   layout(prepared, ...) — pure arithmetic over cached intrinsic sizes.
//
// The decode path prefers `HTMLImageElement.prototype.decode` when available
// (Safari 15+, Chrome 63+, Firefox 63+). It falls back to `load`/`error`
// events for older engines and for `data:`/`blob:` URLs on browsers where
// `decode()` rejects without actually decoding.
//
// Limitations:
//   - SVG without an intrinsic size reports (0, 0) on most browsers. Callers
//     should pass `declaredWidth`/`declaredHeight` (via analysis) or use
//     `measureFromSvgText` to extract the viewBox.
//   - Cross-origin images still report dimensions without tainting, because
//     intrinsic width/height are not restricted data. `crossOrigin` only
//     matters if callers later ask for a decoded `ImageBitmap`.

import {
  analyzeImage,
  getCachedAnalysis,
  normalizeSrc,
  type ImageAnalysis,
} from './analysis.js'
import {
  applyOrientationToSize,
  isValidOrientationCode,
  type OrientationCode,
} from './orientation.js'

export type ImageMeasurement = {
  src: string // normalized source key
  naturalWidth: number // raw intrinsic width in CSS pixels (before orientation)
  naturalHeight: number // raw intrinsic height in CSS pixels (before orientation)
  displayWidth: number // width after applying EXIF orientation axis swap
  displayHeight: number // height after applying EXIF orientation axis swap
  aspectRatio: number // displayWidth / displayHeight
  orientation: OrientationCode
  decoded: boolean // true if the browser fully decoded the bitmap
  analysis: ImageAnalysis
  // Set by `prepare` when it streamed the bytes itself (URL streaming or
  // Blob source): a blob URL callers can render via <img> to reuse the
  // same bytes without triggering a second fetch. Undefined for the
  // classic HTMLImageElement.decode() fallback path.
  blobUrl?: string
}

export type EngineProfile = {
  // Analog of pretext's per-browser measurement quirks. For images the main
  // divergence is whether the engine exposes `HTMLImageElement.decode()` and
  // whether `createImageBitmap` is available off the main thread.
  hasImageDecode: boolean
  hasCreateImageBitmap: boolean
  appliesExifToImgElement: boolean // Chrome/Firefox/Safari all do, but custom runtimes may not
  decodesSvgWithoutIntrinsic: boolean // some engines return 300×150 placeholder, others return 0
}

export type MeasureOptions = {
  crossOrigin?: 'anonymous' | 'use-credentials' | null
  orientation?: OrientationCode
  // If the caller already knows intrinsic dimensions (HTML attrs, server hints),
  // we can skip the network fetch entirely.
  declaredWidth?: number
  declaredHeight?: number
  // Optional AbortSignal aborts an in-flight load.
  signal?: AbortSignal
}

// --- Caches ---

const measurementCache = new Map<string, ImageMeasurement>()
const inflightLoads = new Map<string, Promise<ImageMeasurement>>()
let cachedEngineProfile: EngineProfile | null = null

// --- Engine profile ---

export function getEngineProfile(): EngineProfile {
  if (cachedEngineProfile !== null) return cachedEngineProfile

  const hasImage = typeof HTMLImageElement !== 'undefined'
  const hasDecode = hasImage && typeof HTMLImageElement.prototype.decode === 'function'
  const hasBitmap = typeof createImageBitmap === 'function'

  let appliesExifToImgElement = true
  let decodesSvgWithoutIntrinsic = true

  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent
    const isSafari =
      navigator.vendor === 'Apple Computer, Inc.' &&
      ua.includes('Safari/') &&
      !ua.includes('Chrome/') &&
      !ua.includes('Chromium/') &&
      !ua.includes('CriOS/')
    // Safari historically returns 0×0 for SVGs without an explicit width/height.
    // Chrome/Firefox substitute 300×150. Treat them uniformly in downstream code.
    decodesSvgWithoutIntrinsic = !isSafari
  }

  cachedEngineProfile = {
    hasImageDecode: hasDecode,
    hasCreateImageBitmap: hasBitmap,
    appliesExifToImgElement,
    decodesSvgWithoutIntrinsic,
  }
  return cachedEngineProfile
}

// --- Public measurement entry points ---

export function getMeasurementCacheKey(src: string): string {
  return normalizeSrc(src)
}

export function peekImageMeasurement(src: string): ImageMeasurement | null {
  return measurementCache.get(getMeasurementCacheKey(src)) ?? null
}

export async function measureImage(
  src: string,
  options: MeasureOptions = {},
): Promise<ImageMeasurement> {
  const key = getMeasurementCacheKey(src)
  const cached = measurementCache.get(key)
  if (cached !== undefined) return cached

  const inflight = inflightLoads.get(key)
  if (inflight !== undefined) return inflight

  const promise = loadAndMeasure(src, key, options)
  inflightLoads.set(key, promise)
  try {
    const result = await promise
    measurementCache.set(key, result)
    return result
  } finally {
    inflightLoads.delete(key)
  }
}

export async function measureImages(
  sources: readonly string[],
  options: MeasureOptions = {},
): Promise<ImageMeasurement[]> {
  return await Promise.all(sources.map(async (src) => await measureImage(src, options)))
}

// If the caller already knows intrinsic dimensions (HTML attributes, server
// manifest), they can record them synchronously and skip the load entirely.
// This is the image analog of pretext's "cold path avoided" fast track, used
// by server-rendered pages where the layout must run before hydration.
export function recordKnownMeasurement(
  src: string,
  width: number,
  height: number,
  options: { orientation?: OrientationCode; decoded?: boolean } = {},
): ImageMeasurement {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError(`recordKnownMeasurement: width and height must be positive finite numbers.`)
  }
  const key = getMeasurementCacheKey(src)
  const orientation = options.orientation ?? 1
  const oriented = applyOrientationToSize(width, height, orientation)
  const measurement: ImageMeasurement = {
    src: key,
    naturalWidth: width,
    naturalHeight: height,
    displayWidth: oriented.width,
    displayHeight: oriented.height,
    aspectRatio: oriented.width / oriented.height,
    orientation,
    decoded: options.decoded ?? false,
    analysis: getCachedAnalysis(src),
  }
  measurementCache.set(key, measurement)
  return measurement
}

// --- Internal load pipeline ---

async function loadAndMeasure(
  src: string,
  key: string,
  options: MeasureOptions,
): Promise<ImageMeasurement> {
  if (typeof HTMLImageElement === 'undefined') {
    throw new Error('preimage: measurement requires an HTMLImageElement environment.')
  }

  const analysis = analyzeImage(src)
  const profile = getEngineProfile()

  // If the caller provided dimensions, skip network I/O entirely. This is the
  // analog of pretext's "segment widths already cached" fast path.
  const declaredW = options.declaredWidth ?? analysis.declaredWidth
  const declaredH = options.declaredHeight ?? analysis.declaredHeight
  if (declaredW !== null && declaredH !== null && declaredW > 0 && declaredH > 0) {
    const orientation = options.orientation ?? 1
    const oriented = applyOrientationToSize(declaredW, declaredH, orientation)
    return {
      src: key,
      naturalWidth: declaredW,
      naturalHeight: declaredH,
      displayWidth: oriented.width,
      displayHeight: oriented.height,
      aspectRatio: oriented.width / oriented.height,
      orientation,
      decoded: false,
      analysis,
    }
  }

  const img = new Image()
  if (options.crossOrigin !== undefined && options.crossOrigin !== null) {
    img.crossOrigin = options.crossOrigin
  }
  img.decoding = 'async'

  let aborted = false
  const onAbort = (): void => {
    aborted = true
    img.src = ''
  }
  if (options.signal !== undefined) {
    if (options.signal.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    options.signal.addEventListener('abort', onAbort, { once: true })
  }

  const loadPromise = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error(`preimage: failed to load image "${src}"`))
  })

  img.src = src

  try {
    if (profile.hasImageDecode) {
      try {
        await img.decode()
      } catch {
        await loadPromise
      }
    } else {
      await loadPromise
    }
  } finally {
    if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
  }

  if (aborted) throw new DOMException('Aborted', 'AbortError')

  let naturalWidth = img.naturalWidth
  let naturalHeight = img.naturalHeight
  if (naturalWidth === 0 || naturalHeight === 0) {
    if (declaredW !== null && declaredH !== null) {
      naturalWidth = declaredW
      naturalHeight = declaredH
    } else if (analysis.isVector) {
      // Fall back to a CSS-like default for size-less SVGs so the row packer
      // still receives a valid aspect ratio. Downstream code may override.
      naturalWidth = 300
      naturalHeight = 150
    }
  }

  if (naturalWidth === 0 || naturalHeight === 0) {
    throw new Error(`preimage: "${src}" loaded but reported zero intrinsic size.`)
  }

  const orientation = resolveOrientation(options.orientation)
  const oriented = applyOrientationToSize(naturalWidth, naturalHeight, orientation)

  return {
    src: key,
    naturalWidth,
    naturalHeight,
    displayWidth: oriented.width,
    displayHeight: oriented.height,
    aspectRatio: oriented.width / oriented.height,
    orientation,
    decoded: profile.hasImageDecode,
    analysis,
  }
}

function resolveOrientation(input: OrientationCode | undefined): OrientationCode {
  if (input === undefined) return 1
  return isValidOrientationCode(input) ? input : 1
}

// --- Decoded bitmap helper ---

// Optional: fully decode a cached image into an `ImageBitmap` for cheap
// canvas/WebGL reuse. This is separate from measurement because bitmaps are
// expensive to hold and most callers only need intrinsic dimensions.
export async function decodeImageBitmap(
  src: string,
  options: MeasureOptions = {},
): Promise<ImageBitmap | null> {
  const profile = getEngineProfile()
  if (!profile.hasCreateImageBitmap) return null
  const measurement = await measureImage(src, options)
  // createImageBitmap needs a fresh image since the HTMLImageElement used for
  // measurement may have been garbage collected. This keeps `measureImage`
  // memory-light and avoids holding decoded pixels behind every cached entry.
  const img = new Image()
  if (options.crossOrigin !== undefined && options.crossOrigin !== null) {
    img.crossOrigin = options.crossOrigin
  }
  img.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error(`preimage: failed to load image "${src}"`))
    img.src = src
  })
  try {
    return await createImageBitmap(img)
  } catch {
    return null
  } finally {
    void measurement
  }
}

// --- SVG viewBox helper ---

// Extract intrinsic dimensions from a raw SVG document. Used by callers that
// fetch SVG bytes themselves (e.g. to inline into a shadow DOM) and want to
// avoid the browser's size-less-SVG fallback.
export function measureFromSvgText(svgText: string): { width: number; height: number } | null {
  const widthMatch = svgText.match(/<svg\b[^>]*\swidth=["']?([0-9.]+)(?:px)?["']?/i)
  const heightMatch = svgText.match(/<svg\b[^>]*\sheight=["']?([0-9.]+)(?:px)?["']?/i)
  if (widthMatch !== null && heightMatch !== null) {
    const w = Number(widthMatch[1])
    const h = Number(heightMatch[1])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h }
    }
  }
  const viewBoxMatch = svgText.match(/<svg\b[^>]*\sviewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i)
  if (viewBoxMatch !== null) {
    const w = Number(viewBoxMatch[1])
    const h = Number(viewBoxMatch[2])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h }
    }
  }
  return null
}

// --- Cache clearing ---

export function clearMeasurementCaches(): void {
  measurementCache.clear()
  inflightLoads.clear()
  cachedEngineProfile = null
}

// --- Iteration / inspection (debug helpers) ---

export function listCachedMeasurements(): ImageMeasurement[] {
  return Array.from(measurementCache.values())
}
