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

import { detectImageFormat, normalizeSrc, type ImageFormat } from './analysis.js'
import { fitRect, type FittedRect, type ObjectFit } from './fit.js'
import { readExifOrientation, type OrientationCode } from './orientation.js'
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
   *  without it, and `prepareSync` / manifest entries. */
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
   *  - `'img'`: create an `<img>`, poll `naturalWidth`, abort via
   *    `src = ''`. Produces a warmed `<img>` the caller can reuse for
   *    render via `prepared.element`.
   *  - `'stream'`: `fetch(url)`, feed `response.body` through
   *    `probeImageStream`, abort via `AbortController` the instant the
   *    header bytes parse. No warmed element, but dims land at
   *    header-bytes time instead of poll-loop time — faster at high
   *    concurrency because parsing kicks off the moment bytes arrive,
   *    rather than waiting on the browser's image subsystem to decode
   *    a header before `naturalWidth` flips.
   *  - `'range'`: `fetch(url, { headers: { Range: 'bytes=0-N' } })`.
   *    Server returns 206 Partial Content with just the requested
   *    bytes — no abort dance, no race between "header parsed" and
   *    "server noticed my abort." Most deterministic of the three.
   *    Falls back silently to the `'stream'` behavior if the server
   *    answers with 200 (no Range support).
   *  - `'auto'`: pick per-origin. First probe against a new origin
   *    tries `'range'`; the library remembers whether the server
   *    answered 206 (stay on `'range'`) or 200 (switch to `'stream'`
   *    for this origin). Subsequent probes consult the cache. No
   *    warmed element.
   *
   *  Default: `'auto'` when `dimsOnly === true` (no warmed element is
   *  expected), `'img'` otherwise (caller likely wants to reuse
   *  `prepared.element` for render). Blob sources ignore this entirely;
   *  they always byte-probe directly. */
  strategy?: 'img' | 'stream' | 'range' | 'auto'
  /** Number of bytes to request when `strategy: 'range'`. Applies when
   *  `rangeBytesByFormat` has no matching entry for the detected format
   *  (and when the format can't be detected from the URL).
   *
   *  Default: derived from the per-format table (see `rangeBytesByFormat`).
   *  Pass this to override with a single universal size. */
  rangeBytes?: number
  /** Per-format byte budget for the initial Range request. Keys are
   *  `ImageFormat` values (`'jpeg' | 'png' | ...`); values are bytes.
   *
   *  Defaults (from a 7500-URL corpus sweep; see
   *  `benchmarks/probe-byte-threshold-full.json`):
   *    png  256    gif   256    webp 256    bmp   256
   *    ico  256    apng  256    avif 768    heic  768
   *    svg  2048   jpeg 4096    unknown 4096
   *
   *  JPEG needs the widest budget because EXIF and ICC-profile segments
   *  push the SOF marker past the typical small-header range; its p95
   *  in the corpus is 6KB. Every other raster format lands under 1KB.
   *  SVG needs more headroom because the `<svg>` root tag can trail
   *  comments, XML declarations, and wide attribute lists.
   *
   *  Pass a partial map to override specific formats; undefined entries
   *  fall back to the default table above. */
  rangeBytesByFormat?: Partial<Record<ImageFormat, number>>
  /** Second-chance Range request size when the first probe fails to
   *  parse dimensions. A re-range is issued *only* when the initial
   *  response was 206 and bytes came back short of what the parser
   *  needed; 200-fallback paths consume the full body directly.
   *
   *  Default: 24576 (24KB) — covers the 99.9th-percentile JPEG in the
   *  corpus plus some ICC-profile outliers. Set to 0 to disable. */
  rangeRetryBytes?: number
  /** When `strategy: 'auto'` (or cached from a prior auto-resolved
   *  probe), retry via `strategy: 'img'` if the initial `fetch()`
   *  throws — usually CORS, sometimes hard network failure. Browsers
   *  can't distinguish the two from JS, so both cases fall through
   *  together; if the origin is genuinely down the `<img>` retry fails
   *  too and the caller still gets a rejection.
   *
   *  `<img>` doesn't need CORS for `naturalWidth` reads (tainting only
   *  applies to canvas pixel extraction), so this is the only path
   *  that gets dims out of a CORS-hostile origin. Cost is bandwidth:
   *  the `<img>` probe pulls a TCP receive window's worth of bytes
   *  (tens of KB) instead of the 256B–4KB Range would fetch. The
   *  origin is then cached as `'img'` so subsequent probes skip the
   *  fetch attempt.
   *
   *  Explicit `strategy: 'range'` / `'stream'` / `'img'` never falls
   *  back — callers who opted in specifically get the exact behavior
   *  they asked for, with errors surfaced.
   *
   *  Default: `false`. Enable for gallery / virtualization flows that
   *  want dims-before-paint on mixed-origin URL sets and are willing
   *  to pay the bandwidth on CORS-hostile origins in exchange. */
  fallbackToImgOnFetchError?: boolean
}

/** Default range-byte budget per format (see `rangeBytesByFormat`). Derived
 *  from corpus measurements; exposed for benches and diagnostics. */
export const DEFAULT_RANGE_BYTES_BY_FORMAT: Readonly<Record<ImageFormat, number>> = Object.freeze({
  png: 256,
  jpeg: 4096,
  webp: 256,
  gif: 256,
  bmp: 256,
  avif: 768,
  heic: 768,
  svg: 2048,
  ico: 256,
  apng: 256,
  unknown: 4096,
})

const DEFAULT_RANGE_RETRY_BYTES = 24576

function validateByteBudget(name: string, value: number, allowZero = false): number {
  const min = allowZero ? 0 : 1
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    const adjective = allowZero ? 'a non-negative integer' : 'a positive integer'
    throw new RangeError(`${name} must be ${adjective}, got ${value}.`)
  }
  return value
}

function rangeBytesFor(src: string, options: PrepareOptions): number {
  const format = detectImageFormat(src)
  const perFormat = options.rangeBytesByFormat
  if (perFormat !== undefined) {
    const override = perFormat[format]
    if (override !== undefined) return validateByteBudget(`prepare: rangeBytesByFormat.${format}`, override)
  }
  if (options.rangeBytes !== undefined) return validateByteBudget('prepare: rangeBytes', options.rangeBytes)
  return DEFAULT_RANGE_BYTES_BY_FORMAT[format]
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

/** Release caller-owned resources attached to a prepared image. This is
 *  mainly for `prepare(Blob)` results, where the library creates a
 *  `blob:` URL so the caller can render the bytes without another
 *  allocation. Call once the preview is gone. URL/cache/manifest
 *  handles without retained resources are no-ops. */
export function disposePreparedImage(prepared: PreparedImage): void {
  const blobUrl = prepared.measurement.blobUrl
  if (blobUrl !== undefined && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(blobUrl)
    delete prepared.measurement.blobUrl
  }
}

// --- URL path dispatch ---

type ConcreteStrategy = 'img' | 'stream' | 'range'

// Per-origin strategy memory. First probe against a new origin tries
// 'range'; the result records which strategy the server actually
// supports, so every subsequent probe for the same origin skips the
// fallback dance. Outcomes:
//   'range'  → 206 Partial Content, stays on range
//   'stream' → 200 OK, server ignored the Range header
//   'img'    → fetch threw (CORS or hard network), and the caller
//              opted into `fallbackToImgOnFetchError`
// Scoped to the module (shared across PrepareQueue instances and
// direct prepare() callers in the same page).
const originStrategyCache = new Map<string, ConcreteStrategy>()

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): void {
  if (signal === undefined) return
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
  signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
}

function originOf(src: string): string | null {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined
    return new URL(src, base).origin
  } catch {
    return null
  }
}

function rememberOriginStrategy(src: string, strategy: ConcreteStrategy): void {
  const origin = originOf(src)
  if (origin !== null) originStrategyCache.set(origin, strategy)
}

// Decide whether a thrown error should trigger the img fallback.
// `fetch()` throws a `TypeError` for CORS and hard network failures;
// both are opaque to JS (browsers deliberately don't distinguish them,
// so a misconfigured origin can't probe for whether the target exists).
// Everything else — AbortError from `options.signal`, HTTP-status
// errors (which arrive as `response.ok === false`, not throws), parse
// errors — should not trigger fallback.
function isFetchNetworkError(err: unknown): boolean {
  return err instanceof TypeError
}

/** Read the remembered strategy for an origin, or `null` if nothing
 *  has been recorded yet. Exposed for diagnostics and caller-side
 *  pre-warming flows. */
export function getOriginStrategy(origin: string): ConcreteStrategy | null {
  return originStrategyCache.get(origin) ?? null
}

/** Clear the per-origin strategy cache. Useful in tests or when a
 *  server's Range support changes between deploys. */
export function clearOriginStrategyCache(): void {
  originStrategyCache.clear()
}

/** Resolve an `options.strategy` to a concrete one, applying:
 *   - explicit `'img' | 'stream' | 'range'` passes through
 *   - `'auto'` consults the origin cache; first-probe tries `'range'`
 *   - undefined strategy picks `'auto'` when `dimsOnly === true`
 *     (no warmed element is expected), `'img'` otherwise
 *
 *  Returns `fromAuto: true` when the strategy came from `'auto'`
 *  resolution (explicit or cached). Callers use this to gate writes to
 *  `originStrategyCache`: only auto-originated probes record their
 *  outcome, including the fetch-error → img fallback. Without the
 *  gate, explicit selections (e.g. a user picking `'stream'` from a
 *  demo nav) would overwrite whatever auto had discovered, so
 *  switching back to `'auto'` would silently inherit the manual
 *  choice instead of rediscovering. */
function resolveStrategy(
  src: string,
  options: PrepareOptions,
): { strategy: ConcreteStrategy; fromAuto: boolean } {
  const s = options.strategy
  if (s === 'img' || s === 'stream' || s === 'range') return { strategy: s, fromAuto: false }
  if (s !== 'auto' && options.dimsOnly !== true) return { strategy: 'img', fromAuto: false }
  const origin = originOf(src)
  if (origin !== null) {
    const cached = originStrategyCache.get(origin)
    if (cached !== undefined) return { strategy: cached, fromAuto: true }
  }
  return { strategy: 'range', fromAuto: true }
}

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

  const { strategy, fromAuto } = resolveStrategy(src, options)
  if (strategy === 'range') return await prepareFromUrlRange(src, key, options, fromAuto)
  if (strategy === 'stream') return await prepareFromUrlStream(src, key, options, fromAuto)
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
  fromAuto: boolean,
): Promise<PreparedImage> {
  const initialRangeBytes = rangeBytesFor(src, options)
  const controller = new AbortController()
  forwardAbort(options.signal, controller)

  const credentials =
    options.crossOrigin === 'use-credentials'
      ? 'include'
      : options.crossOrigin === 'anonymous'
      ? 'omit'
      : 'same-origin'

  const doRangeFetch = async (bytesRequested: number): Promise<Response> => {
    const init: RequestInit = {
      headers: { Range: `bytes=0-${bytesRequested - 1}` },
      credentials,
      signal: controller.signal,
    }
    return await fetch(src, init)
  }

  let response: Response
  try {
    response = await doRangeFetch(initialRangeBytes)
  } catch (err) {
    if (
      fromAuto &&
      options.fallbackToImgOnFetchError === true &&
      isFetchNetworkError(err)
    ) {
      rememberOriginStrategy(src, 'img')
      return await prepareFromUrlImg(src, key, options)
    }
    throw err
  }
  if (!response.ok && response.status !== 206) {
    throw new Error(`preimage: fetch ${src} failed with status ${response.status}`)
  }

  // 200 means the server ignored our Range header. Fall back to the
  // stream path so we still abort once dims are known. When we got
  // here via auto-resolution, remember the origin as stream-only so
  // subsequent auto probes skip the 206-roundtrip; an explicit
  // `strategy: 'range'` caller doesn't pollute the auto-discovery
  // cache (see resolveStrategy docstring for why).
  if (response.status === 200) {
    if (response.body === null) {
      throw new Error(`preimage: fetch ${src} returned no body`)
    }
    if (fromAuto) rememberOriginStrategy(src, 'stream')
    return await consumeStreamForDims(src, key, response.body, options, controller, parseContentLength(response))
  }

  // 206: read the partial body and parse directly. No abort needed —
  // the response body is already short.
  let bytes = new Uint8Array(await response.arrayBuffer())
  let probed = probeImageBytes(bytes)
  let byteLength = parseContentRangeTotal(response) ?? parseContentLength(response)

  // Re-range: if the initial budget was too stingy (rare but real for
  // JPEGs with huge EXIF), make one larger request before giving up.
  // Only worth trying when the retry window is actually larger than
  // what we already have and when the full resource itself is larger
  // still — otherwise we already have the whole file.
  const retryBytes = validateByteBudget(
    'prepare: rangeRetryBytes',
    options.rangeRetryBytes ?? DEFAULT_RANGE_RETRY_BYTES,
    true,
  )
  if (probed === null && retryBytes > bytes.length && (byteLength === null || byteLength > bytes.length)) {
    const retry = await doRangeFetch(retryBytes)
    if (retry.status === 206 || retry.ok) {
      const retryBody = new Uint8Array(await retry.arrayBuffer())
      const retryProbed = probeImageBytes(retryBody)
      if (retryProbed !== null) {
        bytes = retryBody
        probed = retryProbed
        byteLength = parseContentRangeTotal(retry) ?? parseContentLength(retry) ?? byteLength
      }
    }
  }

  if (probed === null) {
    throw new Error(
      `preimage: range probe of ${src} (${bytes.length} bytes) yielded no dimensions`,
    )
  }
  if (fromAuto) rememberOriginStrategy(src, 'range')
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
  fromAuto: boolean,
): Promise<PreparedImage> {
  const controller = new AbortController()
  forwardAbort(options.signal, controller)

  const credentials =
    options.crossOrigin === 'use-credentials'
      ? 'include'
      : options.crossOrigin === 'anonymous'
      ? 'omit'
      : 'same-origin'

  let response: Response
  try {
    response = await fetch(src, { signal: controller.signal, credentials })
  } catch (err) {
    if (
      fromAuto &&
      options.fallbackToImgOnFetchError === true &&
      isFetchNetworkError(err)
    ) {
      rememberOriginStrategy(src, 'img')
      return await prepareFromUrlImg(src, key, options)
    }
    throw err
  }
  if (!response.ok) {
    throw new Error(`preimage: fetch ${src} failed with status ${response.status}`)
  }
  if (response.body === null) {
    throw new Error(`preimage: fetch ${src} returned no body`)
  }
  if (fromAuto) rememberOriginStrategy(src, 'stream')
  return await consumeStreamForDims(src, key, response.body, options, controller, parseContentLength(response))
}

/** Read a body stream through `probeImageStream`, aborting the optional
 *  controller as soon as dims are known. The stream/range-fallback paths
 *  do not return a warmed element or retained blob, so reading past the
 *  header would only waste bandwidth. */
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
        if (controller !== undefined) {
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

  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    }
  }

  // Subscribe to abort BEFORE setting src so a same-tick abort lands.
  const dimsPromise = pollForNaturalSize(img, options.signal)
  img.src = src
  const dims = await dimsPromise

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

// Shared `<img>.naturalWidth` poll. One `setTimeout(0)` timer walks every
// pending image per tick, instead of N timers each rescheduling themselves
// independently. Matters at high concurrency (virtualized grids probing
// 200+ URLs at once): the per-image loop spawned one timer per image, and
// each timer contended for the event loop, pushing dims-known latency up
// and starving unrelated tasks. One shared timer keeps the tick cost O(N)
// per frame rather than O(N) timers × O(1) per timer.
//
// `setTimeout(0)` over `requestAnimationFrame` because we're not syncing
// to a paint — we just want to wake as soon as the browser hands JS back
// after a decode completes. rAF is gated on display vsync (~16ms on
// 60Hz), which would add a frame of latency for no benefit.

type PollWaiter = {
  img: HTMLImageElement
  resolve: (dims: { width: number; height: number }) => void
  reject: (err: unknown) => void
  cleanup: () => void
  done: boolean
}

const pollWaiters = new Set<PollWaiter>()
let pollScheduled = false

function schedulePollTick(): void {
  if (pollScheduled) return
  pollScheduled = true
  setTimeout(runPollTick, 0)
}

function settlePollWaiter(
  waiter: PollWaiter,
  result: { width: number; height: number } | null,
  err?: unknown,
): void {
  if (waiter.done) return
  waiter.done = true
  pollWaiters.delete(waiter)
  waiter.cleanup()
  if (result !== null) waiter.resolve(result)
  else waiter.reject(err)
}

function runPollTick(): void {
  pollScheduled = false
  for (const waiter of pollWaiters) {
    if (waiter.done) {
      pollWaiters.delete(waiter)
      continue
    }
    const img = waiter.img
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      settlePollWaiter(waiter, { width: img.naturalWidth, height: img.naturalHeight })
      continue
    }
    if (img.complete) {
      // Load finished but no dims — corrupt image, SVG without
      // intrinsic size, etc. (The `error` listener normally catches
      // outright load failures before we get here.)
      settlePollWaiter(waiter, null, new Error('preimage: image loaded with no dimensions'))
    }
  }
  if (pollWaiters.size > 0) schedulePollTick()
}

function pollForNaturalSize(
  img: HTMLImageElement,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    let waiter!: PollWaiter
    const onError = (): void => {
      settlePollWaiter(waiter, null, new Error('preimage: image load failed'))
    }
    const onAbort = (): void => {
      img.src = ''
      settlePollWaiter(waiter, null, signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    waiter = {
      img,
      resolve,
      reject,
      done: false,
      cleanup: () => {
        img.removeEventListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
      },
    }
    img.addEventListener('error', onError)
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    pollWaiters.add(waiter)
    schedulePollTick()
  })
}

// --- Blob path: byte-probe the first ~4KB, fall back to decode ---

async function prepareFromBlob(blob: Blob, options: PrepareOptions): Promise<PreparedImage> {
  const headBuffer = await blob.slice(0, MAX_HEADER_BYTES).arrayBuffer()
  const headBytes = new Uint8Array(headBuffer)
  const probed = probeImageBytes(headBytes)
  const url = URL.createObjectURL(blob)
  const orientation = options.orientation ?? readExifOrientation(headBuffer) ?? 1

  if (probed !== null) {
    const measurement = recordKnownMeasurement(url, probed.width, probed.height, {
      orientation,
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
  const dimsPromise = pollForNaturalSize(img, options.signal)
  img.src = url
  const dims = await dimsPromise
  return recordKnownMeasurement(url, dims.width, dims.height, {
    orientation: options.orientation ?? 1,
    decoded: true,
  })
}
