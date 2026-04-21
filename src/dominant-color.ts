// Dominant-color extraction. Given the bytes of an image, produce a single
// CSS color string — the averaged 1×1 resample of the image. Useful as a
// placeholder background on an image container: the box shows the average
// color until the full image paints, and the color persists after load so
// out-of-viewport images still contribute a palette hint.
//
// Implementation: `createImageBitmap(blob, {resizeWidth: 1, resizeHeight: 1,
// resizeQuality: 'low'})` hands the averaging to the browser's highly-tuned
// native resampler — cheaper and more accurate than sampling in JS. The
// result is read via an OffscreenCanvas / <canvas> `getImageData`.
//
// Failures return null. Cross-origin images without CORS headers will taint
// the canvas and throw on `getImageData`; callers should supply a
// same-origin blob (prepare()'s streaming path provides this automatically)
// or configure CORS on the server.

export type RGBA = { r: number; g: number; b: number; a: number }

// Extract a single averaged pixel from an image blob. Returns a CSS color
// string (rgba) suitable for `background-color`, or null if extraction
// failed (decode error, canvas taint, unsupported runtime).
export async function extractDominantColorFromBlob(blob: Blob): Promise<string | null> {
  const rgba = await extractDominantRgbaFromBlob(blob)
  if (rgba === null) return null
  return rgbaToCss(rgba)
}

export async function extractDominantRgbaFromBlob(blob: Blob): Promise<RGBA | null> {
  if (typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: 1,
      resizeHeight: 1,
      resizeQuality: 'low',
    })
  } catch {
    return null
  }
  try {
    return readSinglePixel(bitmap)
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

function readSinglePixel(bitmap: ImageBitmap): RGBA | null {
  // Prefer OffscreenCanvas — it's available in workers and doesn't thrash
  // the DOM. Fall back to a detached <canvas>.
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(1, 1)
      const ctx = canvas.getContext('2d')
      if (ctx === null) return null
      ctx.drawImage(bitmap, 0, 0)
      const data = ctx.getImageData(0, 0, 1, 1).data
      return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! }
    } catch {
      // fall through to <canvas>
    }
  }
  if (typeof document === 'undefined') return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (ctx === null) return null
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, 1, 1).data
    return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! }
  } catch {
    return null
  }
}

export function rgbaToCss(rgba: RGBA): string {
  const alpha = rgba.a / 255
  if (alpha >= 0.999) {
    return `rgb(${rgba.r}, ${rgba.g}, ${rgba.b})`
  }
  // Round alpha to 3 decimals to keep the string compact.
  const a = Math.round(alpha * 1000) / 1000
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${a})`
}
