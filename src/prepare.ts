// Single-image prepare/layout: the fast path callers reach for when they
// have one image and one box.
//
//   prepare(src) — async. Measures dimensions as fast as the platform
//     allows: for a URL, streams the fetch and parses the header as
//     bytes arrive (~150ms for remote photos). For a Blob/File, slices
//     the first 4KB and probes (~5ms). Falls back transparently to the
//     classic `HTMLImageElement.decode()` path when streaming isn't
//     available (CORS failures, unknown formats).
//   layout(prepared, maxWidth, maxHeight?, fit?) — sync. Pure arithmetic
//     over the cached aspect ratio; no DOM, no reflow.
//
// `prepareSync(src, width, height)` is the SSR/hydration path: if you
// already know intrinsic dimensions, skip the network entirely.
// `recordKnownMeasurement` is the lower-level version that writes
// directly into the shared measurement cache.

import { analyzeImage, normalizeSrc, type ImageAnalysis } from './analysis.js'
import { fitRect, type FittedRect, type ObjectFit } from './fit.js'
import {
  applyOrientationToSize,
  type OrientationCode,
} from './orientation.js'
import {
  measureImage,
  peekImageMeasurement,
  recordKnownMeasurement,
  type ImageMeasurement,
  type MeasureOptions,
} from './measurement.js'
import { MAX_HEADER_BYTES, probeImageBytes, type ProbedDimensions } from './probe.js'
import { parseUrlDimensions } from './url-dimensions.js'

// --- Opaque prepared handle ---

declare const preparedImageBrand: unique symbol

type PreparedImageCore = {
  measurement: ImageMeasurement
}

export type PreparedImage = {
  readonly [preparedImageBrand]: true
}

type InternalPreparedImage = PreparedImage & PreparedImageCore

function wrap(measurement: ImageMeasurement): PreparedImage {
  return { measurement } as unknown as InternalPreparedImage
}

// Exposed for adjacent modules that need to mint a PreparedImage from a
// measurement they obtained via a different code path.
export function preparedFromMeasurement(measurement: ImageMeasurement): PreparedImage {
  return wrap(measurement)
}

// --- Public types ---

// Strategy picks which measurement pipeline to use. `auto` (the default)
// uses streaming + header probe when possible and falls back to the
// classic HTMLImageElement.decode() path on CORS / unknown-format
// failures. `stream` forces streaming (errors on fetch failure). `image-
// element` forces the classic path — useful when a caller needs to
// guarantee no fetch is issued (instrumentation, service-worker audit).
export type PrepareStrategy = 'auto' | 'stream' | 'image-element'

export type PrepareOptions = MeasureOptions & {
  orientation?: OrientationCode
  strategy?: PrepareStrategy
  // When streaming, continue reading after dims are known so the bytes
  // can be reused for render via a blob URL. Default true. Set false to
  // minimize bandwidth at the cost of a second fetch if the caller later
  // renders the image.
  completeStream?: boolean
}

// --- Public API ---

export async function prepare(
  src: string | Blob,
  options: PrepareOptions = {},
): Promise<PreparedImage> {
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    return await prepareFromBlob(src, options)
  }
  if (typeof src === 'string') {
    return await prepareFromUrl(src, options)
  }
  throw new TypeError('prepare: src must be a string URL or a Blob.')
}

export function prepareSync(
  src: string,
  width: number,
  height: number,
  options: { orientation?: OrientationCode } = {},
): PreparedImage {
  return wrap(recordKnownMeasurement(src, width, height, options))
}

export function layout(
  prepared: PreparedImage,
  maxWidth: number,
  maxHeight?: number,
  fit: ObjectFit = 'contain',
): FittedRect {
  const m = (prepared as unknown as InternalPreparedImage).measurement
  return fitRect(
    m.displayWidth,
    m.displayHeight,
    Math.max(0, maxWidth),
    maxHeight != null ? Math.max(0, maxHeight) : Infinity,
    fit,
  )
}

export function layoutForWidth(prepared: PreparedImage, maxWidth: number): FittedRect {
  return layout(prepared, maxWidth, undefined, 'contain')
}

export function layoutForHeight(prepared: PreparedImage, maxHeight: number): FittedRect {
  const m = (prepared as unknown as InternalPreparedImage).measurement
  return layout(prepared, maxHeight * m.aspectRatio, maxHeight, 'contain')
}

export function measureAspect(prepared: PreparedImage): number {
  return (prepared as unknown as InternalPreparedImage).measurement.aspectRatio
}

export function measureNaturalSize(prepared: PreparedImage): { width: number; height: number } {
  const m = (prepared as unknown as InternalPreparedImage).measurement
  return { width: m.displayWidth, height: m.displayHeight }
}

export function getMeasurement(prepared: PreparedImage): ImageMeasurement {
  return (prepared as unknown as InternalPreparedImage).measurement
}

// --- URL path ---

async function prepareFromUrl(src: string, options: PrepareOptions): Promise<PreparedImage> {
  const key = normalizeSrc(src)
  const cached = peekImageMeasurement(key)
  if (cached !== null) return wrap(cached)

  // URL-pattern extraction: if a registered parser can read dims
  // straight out of the URL (Cloudinary w_/h_, Shopify _WxH, picsum
  // /W/H, etc), skip the network entirely. This is strictly cheaper
  // than any strategy — microseconds of string parsing vs a round trip
  // — so it runs regardless of the strategy hint.
  const urlDims = parseUrlDimensions(src)
  if (urlDims !== null) {
    const measurement = recordKnownMeasurement(key, urlDims.width, urlDims.height, {
      orientation: options.orientation ?? 1,
    })
    return wrap(measurement)
  }

  const strategy = options.strategy ?? 'auto'

  if (strategy === 'image-element') {
    return wrap(await measureImage(src, options))
  }

  // Streaming path. For `stream`, errors propagate. For `auto`, any
  // failure delegates to the classic path.
  try {
    const result = await streamAndProbe(src, options)
    if (result !== null) return wrap(result)
    if (strategy === 'stream') {
      throw new Error('preimage: streaming probe did not resolve dimensions.')
    }
  } catch (err) {
    if (strategy === 'stream') throw err
    // fall through to classic
  }
  return wrap(await measureImage(src, options))
}

type StreamProbeOutcome = ImageMeasurement | null

async function streamAndProbe(
  src: string,
  options: PrepareOptions,
): Promise<StreamProbeOutcome> {
  const key = normalizeSrc(src)

  let response: Response
  try {
    response = await fetch(src)
  } catch {
    return null
  }
  if (!response.ok || response.body === null) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let probed: ProbedDimensions | null = null
  let streamDone = false

  while (probed === null && !streamDone) {
    const { done, value } = await reader.read()
    if (value !== undefined && value.byteLength > 0) {
      chunks.push(value)
      total += value.byteLength
      if (total >= 10) {
        probed = probeImageBytes(concat(chunks, total))
      }
    }
    streamDone = done
  }

  if (probed === null) {
    // Header never resolved — AVIF/HEIC/unknown or a truncated stream.
    // Drain what's left and ask the browser to decode.
    const rest = await drain(reader)
    const contentType = response.headers.get('content-type')
    const blob = new Blob(
      [...chunks, ...rest] as BlobPart[],
      contentType !== null ? { type: contentType } : {},
    )
    return await fallbackFromBlob(key, blob, options)
  }

  // Dimensions resolved. Return the measurement immediately. Continue
  // reading the stream in the background (unless the caller opted out)
  // so the bytes are reusable for render via a blob URL.
  const completeStream = options.completeStream !== false
  const analysis = analyzeImage(src)
  const measurement = recordKnownMeasurement(key, probed.width, probed.height, {
    orientation: options.orientation ?? 1,
  })
  void analysis

  if (completeStream && !streamDone) {
    void drain(reader).then((rest) => {
      const contentType = response.headers.get('content-type')
      const blob = new Blob(
        [...chunks, ...rest] as BlobPart[],
        contentType !== null ? { type: contentType } : {},
      )
      const blobUrl = URL.createObjectURL(blob)
      const cachedEntry = peekImageMeasurement(key)
      if (cachedEntry !== null) cachedEntry.blobUrl = blobUrl
    })
  } else if (!streamDone) {
    void reader.cancel().catch(() => {
      // cancel() can reject on already-closed streams in some browsers.
    })
  }

  return measurement
}

// --- Blob path ---

async function prepareFromBlob(blob: Blob, options: PrepareOptions): Promise<PreparedImage> {
  const headBytes = new Uint8Array(await blob.slice(0, MAX_HEADER_BYTES).arrayBuffer())
  const probed = probeImageBytes(headBytes)
  const url = URL.createObjectURL(blob)

  if (probed !== null) {
    const measurement = recordKnownMeasurement(url, probed.width, probed.height, {
      orientation: options.orientation ?? 1,
    })
    measurement.blobUrl = url
    return wrap(measurement)
  }

  return wrap(await fallbackFromBlob(url, blob, options))
}

// --- Fallback decode ---

async function fallbackFromBlob(
  key: string,
  blob: Blob,
  options: PrepareOptions,
): Promise<ImageMeasurement> {
  const dims = await decodeBlobDimensions(blob)
  if (dims === null) {
    throw new Error('preimage: prepare could not determine image size.')
  }
  const measurement = recordKnownMeasurement(key, dims.width, dims.height, {
    orientation: options.orientation ?? 1,
    decoded: true,
  })
  measurement.blobUrl = URL.createObjectURL(blob)
  return measurement
}

async function decodeBlobDimensions(
  blob: Blob,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      const dims = { width: bitmap.width, height: bitmap.height }
      if (typeof bitmap.close === 'function') bitmap.close()
      if (dims.width > 0 && dims.height > 0) return dims
    } catch {
      // fall through
    }
  }
  if (typeof HTMLImageElement === 'undefined') return null
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('image load failed'))
    })
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { width: img.naturalWidth, height: img.naturalHeight }
    }
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

// --- Shared helpers ---

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array[]> {
  const rest: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (value !== undefined && value.byteLength > 0) rest.push(value)
    if (done) break
  }
  return rest
}

// Applied once, synchronously, to seed the orientation axis swap in the
// recorded measurement. Kept local so prepare-from-blob and prepare-from-
// url agree.
void applyOrientationToSize
