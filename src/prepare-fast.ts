// Streaming image sizing — the drastic time-to-first-sizing (TTFS) win.
//
// `HTMLImageElement.decode()` only resolves after the image is fully
// transferred AND decoded. For a 5MB hero photo on a 10 Mbps connection
// that's ~4 seconds before dimensions are available. But dimensions live
// in the FIRST ~2KB of every major format, so we can stream the fetch,
// parse the header as bytes arrive, and return dims in ~100-200ms. For
// File/Blob sources: ~5-10ms (no network term).
//
// Strategy, in order:
//   1. Cache hit on the normalized URL → synchronous return.
//   2. String URL → fetch() with a streaming body reader. Accumulate
//      chunks, probe after each. Return the prepared handle as soon as
//      probe succeeds, continue reading in the background, and stash a
//      blob URL on the measurement so callers can render via <img>
//      without re-fetching.
//   3. Blob / File → slice the first MAX_HEADER_BYTES, probe. If probe
//      resolves, done. Otherwise, createImageBitmap(blob) fallback.
//   4. If probing fails for a URL (fetch errored, format we don't parse)
//      → delegate to the classic `prepare()` path so the caller still
//      gets a working PreparedImage via HTMLImageElement.decode().
//
// Fast-path wins relative to prepare():
//   - Large remote photos (≥ 1MB over a throttled connection): 10-100x
//   - Blob/File sources: 5-10x (no decode needed)
//   - Cached sources: identical (both O(1))

import { analyzeImage, normalizeSrc, type ImageAnalysis } from './analysis.js'
import { applyOrientationToSize, type OrientationCode } from './orientation.js'
import {
  peekImageMeasurement,
  recordKnownMeasurement,
  type ImageMeasurement,
  type MeasureOptions,
} from './measurement.js'
import { prepare, preparedFromMeasurement, type PreparedImage } from './prepare.js'
import { MAX_HEADER_BYTES, probeImageBytes, type ProbedDimensions } from './probe.js'

export type PrepareFastOptions = MeasureOptions & {
  orientation?: OrientationCode
  // When true (default), keeps reading the fetch after dims are probed so
  // the bytes can be reused for render via a blob URL. When false, cancels
  // the stream as soon as dims are known — minimum bandwidth, but the
  // caller pays for a second fetch if they later render the image.
  completeStream?: boolean
}

// --- Public API ---

export async function prepareFast(
  src: string | Blob,
  options: PrepareFastOptions = {},
): Promise<PreparedImage> {
  if (typeof Blob !== 'undefined' && src instanceof Blob) {
    return await prepareFastFromBlob(src, options)
  }
  if (typeof src === 'string') {
    return await prepareFastFromUrl(src, options)
  }
  throw new TypeError('prepareFast: src must be a string URL or a Blob.')
}

// --- URL path ---

async function prepareFastFromUrl(
  src: string,
  options: PrepareFastOptions,
): Promise<PreparedImage> {
  const key = normalizeSrc(src)
  const cached = peekImageMeasurement(key)
  if (cached !== null) return preparedFromMeasurement(cached)

  let response: Response
  try {
    response = await fetch(src)
  } catch {
    // Network-level failure or opaque response. Delegate to classic path so
    // the caller still gets a usable error through <img onerror>.
    return await prepare(src, options)
  }

  if (!response.ok || response.body === null) {
    return await prepare(src, options)
  }

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
      // Short-circuit cheap by only probing once enough bytes are present
      // to cover the smallest-header format (GIF at 10 bytes).
      if (total >= 10) {
        probed = probeImageBytes(concat(chunks, total))
      }
    }
    streamDone = done
  }

  if (probed === null) {
    // Header never resolved — format we don't parse (AVIF/HEIC), malformed
    // file, or stream shorter than our probe threshold. Drain what remains
    // and fall back to createImageBitmap, which handles every format the
    // browser supports.
    const rest = await drain(reader)
    return await fallbackFromChunks(
      src,
      [...chunks, ...rest],
      response.headers.get('content-type') ?? undefined,
      options,
    )
  }

  // We have dimensions. Return the prepared handle immediately. In parallel,
  // finish reading the stream so the blob URL can be attached to the cached
  // measurement — callers rendering the same image via <img> later get a
  // free cache hit.
  const completeStream = options.completeStream !== false
  const analysis = analyzeImage(src)
  const measurement = makeMeasurement(key, probed, options, analysis)

  if (completeStream && !streamDone) {
    void drain(reader).then((rest) => {
      const contentType = response.headers.get('content-type')
      const blob = new Blob(
        [...chunks, ...rest] as BlobPart[],
        contentType !== null ? { type: contentType } : {},
      )
      const blobUrl = URL.createObjectURL(blob)
      // Attach the blob URL to the cached measurement for render reuse.
      const cachedEntry = peekImageMeasurement(key)
      if (cachedEntry !== null) cachedEntry.blobUrl = blobUrl
    })
  } else if (!streamDone) {
    void reader.cancel().catch(() => {
      // cancel() can reject on already-closed streams in some browsers.
    })
  }

  return preparedFromMeasurement(measurement)
}

// --- Blob path ---

async function prepareFastFromBlob(
  blob: Blob,
  options: PrepareFastOptions,
): Promise<PreparedImage> {
  const headBytes = new Uint8Array(await blob.slice(0, MAX_HEADER_BYTES).arrayBuffer())
  const probed = probeImageBytes(headBytes)
  const url = URL.createObjectURL(blob)

  if (probed !== null) {
    const analysis = analyzeImage(url)
    const measurement = makeMeasurement(url, probed, options, analysis)
    measurement.blobUrl = url
    return preparedFromMeasurement(measurement)
  }

  // Unknown header — ask the browser to decode. createImageBitmap is the
  // preferred fallback because it works in Workers and doesn't require a
  // DOM-attached HTMLImageElement.
  return await fallbackFromBlob(url, blob, options)
}

// --- Fallback decode paths ---

async function fallbackFromChunks(
  src: string,
  chunks: Uint8Array[],
  contentType: string | undefined,
  options: PrepareFastOptions,
): Promise<PreparedImage> {
  const blob = new Blob(
    chunks as BlobPart[],
    contentType !== undefined ? { type: contentType } : {},
  )
  // For URL sources we want the cache key to remain the original URL, not
  // the object URL, so re-record under the normalized src.
  const dims = await decodeBlobDimensions(blob)
  if (dims === null) return await prepare(src, options)
  const key = normalizeSrc(src)
  const analysis = analyzeImage(src)
  const measurement = makeMeasurement(
    key,
    { width: dims.width, height: dims.height, format: analysis.format },
    options,
    analysis,
  )
  measurement.blobUrl = URL.createObjectURL(blob)
  measurement.decoded = true
  return preparedFromMeasurement(measurement)
}

async function fallbackFromBlob(
  url: string,
  blob: Blob,
  options: PrepareFastOptions,
): Promise<PreparedImage> {
  const dims = await decodeBlobDimensions(blob)
  if (dims === null) {
    throw new Error('preimage: prepareFast could not determine image size.')
  }
  const analysis = analyzeImage(url)
  const measurement = makeMeasurement(
    url,
    { width: dims.width, height: dims.height, format: analysis.format },
    options,
    analysis,
  )
  measurement.blobUrl = url
  measurement.decoded = true
  return preparedFromMeasurement(measurement)
}

async function decodeBlobDimensions(
  blob: Blob,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob)
      const dims = { width: bitmap.width, height: bitmap.height }
      // Free the decoded pixel store; we only needed dimensions.
      if (typeof bitmap.close === 'function') bitmap.close()
      if (dims.width > 0 && dims.height > 0) return dims
    } catch {
      // Fall through to Image-based decode.
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

function makeMeasurement(
  key: string,
  dims: ProbedDimensions,
  options: PrepareFastOptions,
  analysis: ImageAnalysis,
): ImageMeasurement {
  const orientation = options.orientation ?? 1
  const oriented = applyOrientationToSize(dims.width, dims.height, orientation)
  const measurement: ImageMeasurement = {
    src: key,
    naturalWidth: dims.width,
    naturalHeight: dims.height,
    displayWidth: oriented.width,
    displayHeight: oriented.height,
    aspectRatio: oriented.width / oriented.height,
    orientation,
    decoded: false,
    analysis,
  }
  // Use recordKnownMeasurement so the measurement is inserted into the
  // shared cache. It re-derives the oriented dims from the same inputs, so
  // we just trust its return value.
  return recordKnownMeasurement(key, dims.width, dims.height, { orientation })
}

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
