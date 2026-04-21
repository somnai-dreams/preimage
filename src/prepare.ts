// Single-image prepare/layout: the fast path callers reach for when they
// have one image and one box.
//
//   prepare(src) — async. Kicks off `HTMLImageElement.decode()`, reads the
//     intrinsic size, caches by normalized src, returns an opaque handle.
//   layout(prepared, maxWidth, maxHeight?, fit?) — sync. Pure arithmetic
//     over the cached aspect ratio; no DOM, no reflow.
//
// `prepareSync(src, width, height)` is the SSR/hydration path: if your
// server already reports intrinsic dimensions, skip the network entirely.
// `recordKnownMeasurement` is the lower-level version that mutates the
// shared measurement cache directly, for callers who want to pre-warm.

import { fitRect, type FittedRect, type ObjectFit } from './fit.js'
import {
  measureImage,
  recordKnownMeasurement,
  type ImageMeasurement,
  type MeasureOptions,
} from './measurement.js'
import type { OrientationCode } from './orientation.js'

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

// Exposed for adjacent modules (e.g. `prepare-fast.ts`) that need to mint a
// PreparedImage from a measurement they obtained via a different code path.
export function preparedFromMeasurement(measurement: ImageMeasurement): PreparedImage {
  return wrap(measurement)
}

// --- Public API ---

export type PrepareOptions = MeasureOptions & {
  orientation?: OrientationCode
}

export async function prepare(
  src: string,
  options: PrepareOptions = {},
): Promise<PreparedImage> {
  const measurement = await measureImage(src, options)
  return wrap(measurement)
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
