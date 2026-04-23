// Shared measurement record + cache used by prepare().
//
// This module is intentionally small: prepare() (in prepare.ts) owns the
// URL- and Blob-specific measurement pipelines and writes results into
// this cache via `recordKnownMeasurement`. This file exposes the types,
// the cache readers, and the SVG viewBox helper.
//
// Limitations:
//   - SVG without an intrinsic size reports (0, 0) on most browsers.
//     Callers should use `measureFromSvgText` to extract the viewBox
//     when they have the raw markup in hand.

import { getCachedAnalysis, normalizeSrc, type ImageAnalysis } from './analysis.js'
import { applyOrientationToSize, type OrientationCode } from './orientation.js'

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
  // Populated by `prepare(Blob)` — a blob URL pointing at the caller's
  // bytes. Undefined for URL inputs (the new prepare path uses an
  // <img> element directly; use getElement(prepared) to retrieve it).
  blobUrl?: string
  /** File size in bytes. Sourced from Content-Length (stream strategy),
   *  Content-Range total (range strategy's 206), or the Blob's `.size`
   *  (blob path). `null` when unavailable — notably the `'img'` URL
   *  strategy, which has no access to response headers. */
  byteLength: number | null
  /** True if the format header indicates a native alpha channel.
   *  See `ProbedDimensions.hasAlpha` for per-format semantics. */
  hasAlpha: boolean
  /** True for progressive JPEGs; false for everything else. */
  isProgressive: boolean
}

export type MeasureOptions = {
  crossOrigin?: 'anonymous' | 'use-credentials' | null
  orientation?: OrientationCode
  // Optional AbortSignal aborts an in-flight load.
  signal?: AbortSignal
}

// --- Caches ---

const measurementCache = new Map<string, ImageMeasurement>()

// --- Public readers ---

export function getMeasurementCacheKey(src: string): string {
  return normalizeSrc(src)
}

export function peekImageMeasurement(src: string): ImageMeasurement | null {
  return measurementCache.get(getMeasurementCacheKey(src)) ?? null
}

// If the caller already knows intrinsic dimensions (HTML attributes,
// server manifest), they can record them synchronously and skip the
// load entirely. This is the image analog of pretext's "cold path
// avoided" fast track, used by server-rendered pages where the layout
// must run before hydration.
export function recordKnownMeasurement(
  src: string,
  width: number,
  height: number,
  options: {
    orientation?: OrientationCode
    decoded?: boolean
    byteLength?: number | null
    hasAlpha?: boolean
    isProgressive?: boolean
  } = {},
): ImageMeasurement {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError(
      `recordKnownMeasurement: width and height must be positive finite numbers.`,
    )
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
    byteLength: options.byteLength ?? null,
    hasAlpha: options.hasAlpha ?? false,
    isProgressive: options.isProgressive ?? false,
  }
  measurementCache.set(key, measurement)
  return measurement
}

// --- SVG viewBox helper ---

// Extract intrinsic dimensions from a raw SVG document. Used by callers
// that fetch SVG bytes themselves (e.g. to inline into a shadow DOM)
// and want to avoid the browser's size-less-SVG fallback.
export function measureFromSvgText(svgText: string): { width: number; height: number } | null {
  // Isolate the opening <svg ...> tag first so per-attribute regexes
  // can match regardless of attribute order (previously the shared
  // [^>"']* prefix couldn't skip over a quoted attribute that came
  // before the one being matched).
  const tagMatch = svgText.match(/<svg\b([^>]*)>/i)
  const attrs = tagMatch !== null ? tagMatch[1]! : svgText
  const widthMatch = attrs.match(/\swidth\s*=\s*["']?([0-9.]+)(?:px)?["']?/i)
  const heightMatch = attrs.match(/\sheight\s*=\s*["']?([0-9.]+)(?:px)?["']?/i)
  if (widthMatch !== null && heightMatch !== null) {
    const w = Number(widthMatch[1])
    const h = Number(heightMatch[1])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h }
    }
  }
  const viewBoxMatch = attrs.match(
    /\sviewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i,
  )
  if (viewBoxMatch !== null) {
    const w = Number(viewBoxMatch[1])
    const h = Number(viewBoxMatch[2])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h }
    }
  }
  return null
}

// --- Cache management ---

export function clearMeasurementCaches(): void {
  measurementCache.clear()
}

export function listCachedMeasurements(): ImageMeasurement[] {
  return Array.from(measurementCache.values())
}
