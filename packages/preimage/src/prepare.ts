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
import { MAX_HEADER_BYTES, probeImageBytes } from './probe.js'
import { parseUrlDimensions } from './url-dimensions.js'

// --- Opaque prepared handle ---

declare const preparedImageBrand: unique symbol

type PreparedImageCore = {
  measurement: ImageMeasurement
  element: HTMLImageElement | null
}

export type PreparedImage = {
  readonly [preparedImageBrand]: true
}

type InternalPreparedImage = PreparedImage & PreparedImageCore

function wrap(
  measurement: ImageMeasurement,
  element: HTMLImageElement | null = null,
): PreparedImage {
  return { measurement, element } as unknown as InternalPreparedImage
}

// Exposed for adjacent modules that need to mint a PreparedImage from a
// measurement they obtained via a different code path.
export function preparedFromMeasurement(measurement: ImageMeasurement): PreparedImage {
  return wrap(measurement, null)
}

// --- Public types ---

export type PrepareOptions = MeasureOptions & {
  orientation?: OrientationCode
  // If true, abort the image load after dimensions are known by clearing
  // the <img>'s src. The returned PreparedImage has no warmed element —
  // callers that later decide to render must fetch the image themselves.
  // Trades bandwidth for the time-to-dims window: useful when planning
  // a layout from many URLs where most won't be rendered (off-screen
  // tiles, image catalogs, SSR precompute).
  dimsOnly?: boolean
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
  return wrap(recordKnownMeasurement(src, width, height, options), null)
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

// Return the warmed <img> the library used to measure the URL, or null
// if the caller opted into `dimsOnly`, used a Blob source, or used
// `prepareSync`. The element may still be loading its bytes when
// returned — the prepare() promise resolves at dims-known time, not
// fully-loaded time. Use this for render to avoid a second fetch.
export function getElement(prepared: PreparedImage): HTMLImageElement | null {
  return (prepared as unknown as InternalPreparedImage).element
}

// --- URL path: <img> + poll naturalWidth ---

async function prepareFromUrl(src: string, options: PrepareOptions): Promise<PreparedImage> {
  const key = normalizeSrc(src)
  const cached = peekImageMeasurement(key)
  if (cached !== null) return wrap(cached, null)

  // URL-pattern shortcut: Cloudinary, Shopify, picsum, Unsplash etc all
  // encode dimensions in the URL. String-parse → zero network.
  const urlDims = parseUrlDimensions(src)
  if (urlDims !== null) {
    const measurement = recordKnownMeasurement(key, urlDims.width, urlDims.height, {
      orientation: options.orientation ?? 1,
    })
    return wrap(measurement, null)
  }

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
  return wrap(measurement, options.dimsOnly === true ? null : img)
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
    })
    measurement.blobUrl = url
    return wrap(measurement, null)
  }

  // Header didn't match any parser — probably AVIF/HEIC/unknown. Fall
  // back to loading the blob URL in an <img> and polling.
  const measurement = await fallbackFromBlobUrl(url, options)
  measurement.blobUrl = url
  return wrap(measurement, null)
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
