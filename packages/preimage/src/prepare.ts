// Single-image prepare/layout: the fast path callers reach for when they
// have one image and one box.
//
//   prepare(src) — async. For a URL, creates an <img>, lets the browser
//     start the fetch, and polls naturalWidth until the header bytes are
//     parsed (~5-10ms typical). Returns with the warmed <img> still
//     loading; the image is fully painted once its own onload fires.
//     For a Blob/File, slices the first 4KB and probes with our byte
//     parsers; blob URL is returned for render reuse.
//   layout(prepared, maxWidth, maxHeight?, fit?) — sync. Pure arithmetic
//     over the cached aspect ratio; no DOM, no reflow.
//
// `prepareSync(src, width, height)` is the SSR/hydration path: if you
// already know intrinsic dimensions, skip the network entirely.
// `recordKnownMeasurement` is the lower-level version that writes
// directly into the shared measurement cache.

import { normalizeSrc } from './analysis.js'
import { fitRect, type FittedRect, type ObjectFit } from './fit.js'
import { type OrientationCode } from './orientation.js'
import {
  peekImageMeasurement,
  recordKnownMeasurement,
  type ImageMeasurement,
  type MeasureOptions,
} from './measurement.js'
import { MAX_HEADER_BYTES, probeImageBytes, probeImageStream, type ProbedDimensions } from './probe.js'
import { parseUrlDimensions } from './url-dimensions.js'

// --- Prepared handle ---
//
// The handle returned by `prepare()`. Flat, readable shape so callers can
// do `(await prepare(url)).width` without reaching for a helper. The
// legacy helpers (`getMeasurement`, `getElement`, `measureAspect`,
// `measureNaturalSize`) still work — they now just read the same fields.

export type PreparedImage = {
  /** Display width in CSS pixels, after EXIF orientation. */
  readonly width: number
  /** Display height in CSS pixels, after EXIF orientation. */
  readonly height: number
  /** width / height. */
  readonly aspectRatio: number
  /** Normalized source key (hash stripped). Same key used in the cache. */
  readonly src: string
  /** Warmed `<img>` the library polled to measure, or null when the
   *  measurement came from a non-`<img>` path (cache hit, URL-pattern
   *  shortcut, `dimsOnly`, `prepareSync`). The element may still be
   *  loading its bytes — `prepare` resolves at dims-known time, not
   *  fully-loaded time. Reuse this for rendering to avoid a second
   *  network fetch. */
  readonly element: HTMLImageElement | null
  /** Where the dimensions came from. Lets callers vary UI on the
   *  difference between "dims needed a round-trip" (`'network'`) and
   *  "dims were already in hand" (everything else) — e.g. skip the
   *  skeleton shimmer on cache/manifest hits, fade in only on network
   *  resolves. */
  readonly source: PreparedSource
  /** File size in bytes. Lets callers cap what they'll fetch at full
   *  res, pick between a thumbnail and original, or show a download
   *  progress bar. `null` when the source didn't expose it — notably
   *  the `'img'` URL strategy, cache hits that were originally recorded
   *  without it, and `prepareSync` / manifest-hydrated entries. */
  readonly byteLength: number | null
  /** True if the format header indicates a native alpha channel.
   *  Callers drawing a tinted skeleton background can skip the tint
   *  when `hasAlpha === false` (image will fully cover it anyway). */
  readonly hasAlpha: boolean
  /** True for progressive JPEGs; false for everything else. Progressive
   *  JPEGs render coarse-to-fine as bytes arrive, so the opacity
   *  fade-in that hides a popped-in paint is unnecessary. */
  readonly isProgressive: boolean
  /** Full measurement record (natural dims, orientation, analysis,
   *  blobUrl). Use this when you need fields beyond the common
   *  `.width` / `.height` / `.aspectRatio` triple. */
  readonly measurement: ImageMeasurement
}

/** Provenance of a `PreparedImage`. Every `prepare()` / `prepareSync()`
 *  resolution tags itself so callers can branch behavior on it without
 *  tracking state outside the library. */
export type PreparedSource =
  /** Library probed the URL just now (img/stream/range path). */
  | 'network'
  /** `peekImageMeasurement` returned an existing entry — a prior
   *  `prepare()` in this session already measured this URL. */
  | 'cache'
  /** `parseUrlDimensions` found dims in the URL itself (Cloudinary /
   *  picsum / Shopify-style size params). */
  | 'url-pattern'
  /** `prepareSync(src, w, h)` — caller supplied dims at call time. */
  | 'declared'
  /** `preparedFromMeasurement(m, 'manifest')` — caller hydrated the
   *  measurement cache from a build-time manifest. */
  | 'manifest'
  /** `prepare(Blob)` byte-probe or its `<img>` fallback. */
  | 'blob'

function wrap(
  measurement: ImageMeasurement,
  element: HTMLImageElement | null,
  source: PreparedSource,
): PreparedImage {
  return {
    width: measurement.displayWidth,
    height: measurement.displayHeight,
    aspectRatio: measurement.aspectRatio,
    src: measurement.src,
    element,
    source,
    byteLength: measurement.byteLength,
    hasAlpha: measurement.hasAlpha,
    isProgressive: measurement.isProgressive,
    measurement,
  }
}

/** Mint a `PreparedImage` from a measurement obtained through a
 *  different code path (e.g. an adjacent module's probe, or a manifest
 *  the caller hydrated via `recordKnownMeasurement`). Exposed for
 *  library integrators; most callers should use `prepare()` instead.
 *
 *  `source` tags the provenance; defaults to `'cache'` since by the
 *  time this function runs the measurement is already in the cache.
 *  Callers hydrating from a build-time manifest should pass
 *  `'manifest'` so downstream rendering code can branch on it. */
export function preparedFromMeasurement(
  measurement: ImageMeasurement,
  source: PreparedSource = 'cache',
): PreparedImage {
  return wrap(measurement, null, source)
}

// --- Public types ---

/** Options for `prepare()`. */
export type PrepareOptions = MeasureOptions & {
  /** Explicit EXIF orientation override (1–8). Otherwise read from the
   *  image bytes (for Blob sources) or inferred as 1. */
  orientation?: OrientationCode
  /** If true, abort the image load after dimensions are known by clearing
   *  the `<img>`'s `src`. The returned `PreparedImage` has no warmed
   *  element — callers that later decide to render must fetch the image
   *  themselves. Trades bandwidth for the time-to-dims window: useful
   *  when planning a layout from many URLs where most won't be rendered
   *  (off-screen tiles, image catalogs, SSR precompute). */
  dimsOnly?: boolean
  /** Probe strategy for URL sources:
   *  - `'img'` (default): create an `<img>`, poll `naturalWidth`, abort
   *    via `src = ''`. Produces a warmed `<img>` the caller can reuse
   *    for render via `prepared.element`.
   *  - `'stream'`: `fetch(url)`, feed `response.body` through
   *    `probeImageStream`, abort via `AbortController` the instant the
   *    header bytes parse. No warmed element, but dims land at
   *    header-bytes time instead of poll-loop time — much faster at
   *    high concurrency (~200 parallel probes), where the `'img'`
   *    path's `setTimeout(0)` polling gets event-loop-starved.
   *  - `'range'`: `fetch(url, { headers: { Range: 'bytes=0-N' } })`.
   *    Server returns 206 Partial Content with just the requested
   *    bytes — no abort dance, no race between "header parsed" and
   *    "server noticed my abort." Most deterministic of the three.
   *    Falls back silently to the `'stream'` behavior if the server
   *    answers with 200 (no Range support).
   *
   *  Blob sources ignore this; they always byte-probe directly. */
  strategy?: 'img' | 'stream' | 'range'
  /** Number of bytes to request when `strategy: 'range'`. Defaults to
   *  4096 — comfortably past any supported header parser's max. */
  rangeBytes?: number
}

// --- Public API ---

/** Prepare an image for layout: measure its dimensions, return a flat
 *  handle whose `.width`, `.height`, `.aspectRatio` are immediately
 *  readable. The caller can reuse `handle.element` (if non-null) as
 *  the rendered `<img>` to share one network fetch between probe and
 *  paint.
 *
 *  @example
 *    const img = await prepare('/photo.jpg')
 *    console.log(img.width, img.height, img.aspectRatio)
 *    // Reuse the warmed <img> for zero extra fetches:
 *    container.appendChild(img.element ?? new Image(...))
 *
 *  @example
 *    // Measure many URLs cheaply, then pick which to fully fetch:
 *    const probed = await Promise.all(
 *      urls.map(u => prepare(u, { dimsOnly: true }))
 *    ) */
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

/** Synchronous counterpart to `prepare()` when dimensions are already
 *  known (SSR manifest, server-sent image metadata, declared width and
 *  height attrs). No network, no polling — just writes into the cache
 *  and returns the handle.
 *
 *  @example
 *    const img = prepareSync('/photo.jpg', 1920, 1080) */
export function prepareSync(
  src: string,
  width: number,
  height: number,
  options: { orientation?: OrientationCode } = {},
): PreparedImage {
  return wrap(recordKnownMeasurement(src, width, height, options), null, 'declared')
}

/** Fit a `PreparedImage` into a max-width and optional max-height box.
 *  Pure arithmetic — no DOM reads. Returns `{ x, y, width, height }`.
 *
 *  @example
 *    const p = await prepare(url)
 *    const { width, height } = layout(p, 400)            // fit in 400px wide
 *    const rect = layout(p, 400, 300, 'cover')           // cover 400×300 */
export function layout(
  prepared: PreparedImage,
  maxWidth: number,
  maxHeight?: number,
  fit: ObjectFit = 'contain',
): FittedRect {
  return fitRect(
    prepared.width,
    prepared.height,
    Math.max(0, maxWidth),
    maxHeight != null ? Math.max(0, maxHeight) : Infinity,
    fit,
  )
}

/** Shorthand for `layout(prepared, maxWidth)` — fit by width, contain. */
export function layoutForWidth(prepared: PreparedImage, maxWidth: number): FittedRect {
  return layout(prepared, maxWidth, undefined, 'contain')
}

/** Shorthand for fitting by height while preserving aspect ratio. */
export function layoutForHeight(prepared: PreparedImage, maxHeight: number): FittedRect {
  return layout(prepared, maxHeight * prepared.aspectRatio, maxHeight, 'contain')
}

/** Alias for `prepared.aspectRatio`. Kept for ergonomic reads. */
export function measureAspect(prepared: PreparedImage): number {
  return prepared.aspectRatio
}

/** Alias for `{ width: prepared.width, height: prepared.height }`. */
export function measureNaturalSize(prepared: PreparedImage): { width: number; height: number } {
  return { width: prepared.width, height: prepared.height }
}

/** Alias for `prepared.measurement` — the full measurement record. */
export function getMeasurement(prepared: PreparedImage): ImageMeasurement {
  return prepared.measurement
}

/** Alias for `prepared.element` — the warmed `<img>` the library polled
 *  to measure, or null. Reuse for rendering to share one network fetch
 *  between probe and paint. */
export function getElement(prepared: PreparedImage): HTMLImageElement | null {
  return prepared.element
}

// --- URL path dispatch ---

async function prepareFromUrl(src: string, options: PrepareOptions): Promise<PreparedImage> {
  const key = normalizeSrc(src)
  const cached = peekImageMeasurement(key)
  if (cached !== null) return wrap(cached, null, 'cache')

  // URL-pattern shortcut: Cloudinary, Shopify, picsum, Unsplash etc all
  // encode dimensions in the URL. String-parse → zero network.
  const urlDims = parseUrlDimensions(src)
  if (urlDims !== null) {
    const measurement = recordKnownMeasurement(key, urlDims.width, urlDims.height, {
      orientation: options.orientation ?? 1,
    })
    return wrap(measurement, null, 'url-pattern')
  }

  if (options.strategy === 'range') {
    return await prepareFromUrlRange(src, key, options)
  }
  if (options.strategy === 'stream') {
    return await prepareFromUrlStream(src, key, options)
  }
  return await prepareFromUrlImg(src, key, options)
}

// --- URL path: HTTP Range request ---
//
// Asks the server upfront for `bytes=0-(rangeBytes-1)`. Server returns
// 206 Partial Content with just those bytes. No streaming, no abort
// dance, no race between "we parsed the header" and "server noticed."
// Best for node/CLI workflows scanning many URLs and for any host that
// honors Range (most static CDNs do).
//
// Fallback: if the server returns 200 instead of 206 it doesn't honor
// Range. We fall through to the stream path so the caller still gets
// dims rather than a hard error.

async function prepareFromUrlRange(
  src: string,
  key: string,
  options: PrepareOptions,
): Promise<PreparedImage> {
  const rangeBytes = options.rangeBytes ?? 4096
  const credentials =
    options.crossOrigin === 'use-credentials'
      ? 'include'
      : options.crossOrigin === 'anonymous'
      ? 'omit'
      : 'same-origin'

  const fetchInit: RequestInit = {
    headers: { Range: `bytes=0-${rangeBytes - 1}` },
    credentials,
  }
  if (options.signal !== undefined) fetchInit.signal = options.signal
  const response = await fetch(src, fetchInit)
  if (!response.ok && response.status !== 206) {
    throw new Error(`preimage: fetch ${src} failed with status ${response.status}`)
  }

  // 200 means the server ignored our Range header. Fall back to the
  // stream path so we still abort once dims are known.
  if (response.status === 200) {
    if (response.body === null) {
      throw new Error(`preimage: fetch ${src} returned no body`)
    }
    return await consumeStreamForDims(src, key, response.body, options, undefined, parseContentLength(response))
  }

  // 206: read the partial body and parse directly. No abort needed —
  // the response body is already short.
  const bytes = new Uint8Array(await response.arrayBuffer())
  const probed = probeImageBytes(bytes)
  if (probed === null) {
    throw new Error(
      `preimage: range probe of ${src} (${bytes.length} bytes) yielded no dimensions`,
    )
  }
  // 206 responses put the full resource size after the slash in
  // Content-Range: `bytes 0-4095/12345`. Falls back to null when the
  // header is missing or malformed.
  const byteLength = parseContentRangeTotal(response) ?? parseContentLength(response)
  const measurement = recordKnownMeasurement(key, probed.width, probed.height, {
    orientation: options.orientation ?? 1,
    byteLength,
    hasAlpha: probed.hasAlpha,
    isProgressive: probed.isProgressive,
  })
  return wrap(measurement, null, 'network')
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseContentRangeTotal(response: Response): number | null {
  const raw = response.headers.get('content-range')
  if (raw === null) return null
  const match = raw.match(/\/(\d+)\s*$/)
  if (match === null) return null
  const n = Number(match[1])
  return Number.isFinite(n) && n >= 0 ? n : null
}

// --- URL path: fetch + probeImageStream ---
//
// Runs a single fetch, feeds the response body through probeImageStream,
// aborts via AbortController the moment header bytes parse. Skips the
// browser's image subsystem entirely — no setTimeout polling, no decode
// queue, no `<img>` allocation. Massively faster at high concurrency.
// Downside: no warmed `<img>` to hand back, so callers that want to
// render via prepared.element must fetch again or hold on to the Blob
// themselves.

async function prepareFromUrlStream(
  src: string,
  key: string,
  options: PrepareOptions,
): Promise<PreparedImage> {
  const controller = new AbortController()
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const credentials =
    options.crossOrigin === 'use-credentials'
      ? 'include'
      : options.crossOrigin === 'anonymous'
      ? 'omit'
      : 'same-origin'

  const response = await fetch(src, { signal: controller.signal, credentials })
  if (!response.ok) {
    throw new Error(`preimage: fetch ${src} failed with status ${response.status}`)
  }
  if (response.body === null) {
    throw new Error(`preimage: fetch ${src} returned no body`)
  }
  return await consumeStreamForDims(src, key, response.body, options, controller, parseContentLength(response))
}

/** Read a body stream through `probeImageStream`, abort the optional
 *  controller as soon as dims are known when `dimsOnly`. Shared by
 *  the stream strategy and the range strategy's 200-fallback path. */
async function consumeStreamForDims(
  src: string,
  key: string,
  body: ReadableStream<Uint8Array>,
  options: PrepareOptions,
  controller: AbortController | undefined,
  byteLength: number | null,
): Promise<PreparedImage> {
  let aborted = false
  let probed: ProbedDimensions | null = null
  try {
    const result = await probeImageStream(body, {
      onDims: (d) => {
        probed = d
        if (options.dimsOnly === true && controller !== undefined) {
          aborted = true
          controller.abort()
        }
      },
    })
    if (probed === null && result.dims !== null) {
      probed = result.dims
    }
  } catch (err) {
    // Intentional cancellation after dims known is expected; any other
    // failure bubbles.
    if (!aborted) throw err
  }

  if (probed === null) {
    throw new Error(`preimage: stream probe of ${src} yielded no dimensions`)
  }

  const measurement = recordKnownMeasurement(key, probed.width, probed.height, {
    orientation: options.orientation ?? 1,
    byteLength,
    hasAlpha: probed.hasAlpha,
    isProgressive: probed.isProgressive,
  })
  return wrap(measurement, null, 'network')
}

// --- URL path: <img> + poll naturalWidth ---

async function prepareFromUrlImg(
  src: string,
  key: string,
  options: PrepareOptions,
): Promise<PreparedImage> {
  if (typeof HTMLImageElement === 'undefined') {
    throw new Error('preimage: prepare(url) requires an HTMLImageElement environment.')
  }

  const img = new Image()
  if (options.crossOrigin !== undefined && options.crossOrigin !== null) {
    img.crossOrigin = options.crossOrigin
  }
  img.decoding = 'async'

  // Subscribe to abort BEFORE setting src so a same-tick abort lands.
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
    options.signal.addEventListener(
      'abort',
      () => {
        img.src = ''
      },
      { once: true },
    )
  }

  img.src = src
  const dims = await pollForNaturalSize(img)

  if (options.dimsOnly === true) {
    // Abort the rest of the transfer. Some bytes between dims-known
    // and this cancellation will have been downloaded — browsers give
    // us no sub-task cancellation primitive for <img>.
    img.src = ''
  }

  const measurement = recordKnownMeasurement(key, dims.width, dims.height, {
    orientation: options.orientation ?? 1,
  })
  return wrap(measurement, options.dimsOnly === true ? null : img, 'network')
}

function pollForNaturalSize(
  img: HTMLImageElement,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    let finished = false
    const onError = (): void => {
      if (finished) return
      finished = true
      reject(new Error('preimage: image load failed'))
    }
    img.addEventListener('error', onError, { once: true })

    const tick = (): void => {
      if (finished) return
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        finished = true
        resolve({ width: img.naturalWidth, height: img.naturalHeight })
        return
      }
      if (img.complete) {
        // Load finished but no dims — corrupt image, SVG without
        // intrinsic size, etc.
        finished = true
        reject(new Error('preimage: image loaded with no dimensions'))
        return
      }
      // setTimeout(0) polling is ~5x faster than requestAnimationFrame
      // (which is gated on display vsync) and avoids the task-starvation
      // pitfall of MessageChannel spinning. Empirically ~4-8ms to
      // dims-known after bytes arrive.
      setTimeout(tick, 0)
    }
    tick()
  })
}

// --- Blob path: byte-probe the first ~4KB, fall back to decode ---

async function prepareFromBlob(blob: Blob, options: PrepareOptions): Promise<PreparedImage> {
  const headBytes = new Uint8Array(await blob.slice(0, MAX_HEADER_BYTES).arrayBuffer())
  const probed = probeImageBytes(headBytes)
  const url = URL.createObjectURL(blob)

  if (probed !== null) {
    const measurement = recordKnownMeasurement(url, probed.width, probed.height, {
      orientation: options.orientation ?? 1,
      byteLength: blob.size,
      hasAlpha: probed.hasAlpha,
      isProgressive: probed.isProgressive,
    })
    measurement.blobUrl = url
    return wrap(measurement, null, 'blob')
  }

  // Header didn't match any parser — probably AVIF/HEIC/unknown. Fall
  // back to loading the blob URL in an <img> and polling.
  const measurement = await fallbackFromBlobUrl(url, options)
  measurement.blobUrl = url
  measurement.byteLength = blob.size
  return wrap(measurement, null, 'blob')
}

async function fallbackFromBlobUrl(
  url: string,
  options: PrepareOptions,
): Promise<ImageMeasurement> {
  if (typeof HTMLImageElement === 'undefined') {
    throw new Error('preimage: prepare(Blob) for unknown formats needs an HTMLImageElement.')
  }
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  const dims = await pollForNaturalSize(img)
  return recordKnownMeasurement(url, dims.width, dims.height, {
    orientation: options.orientation ?? 1,
    decoded: true,
  })
}
