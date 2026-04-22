// EXIF orientation helper. Image analog of pretext's `bidi.ts`: a lightweight
// metadata pass that classifies each item into a "display level" that the
// layout walker does not consume directly, but that rich rendering code can
// use to emit the correct transform.
//
// EXIF codes map rotation/flip combinations to a single byte (1..8). Modern
// browsers apply orientation automatically when rendering <img>, but not when
// drawing to canvas via `drawImage`. For both paths the layout math must know
// whether the image's rendered width/height swap — orientations 5–8 add a 90°
// rotation, so the declared (W, H) must be flipped before fitting.

export type OrientationCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export type OrientationInfo = {
  code: OrientationCode
  rotation: 0 | 90 | 180 | 270 // clockwise degrees
  flipHorizontal: boolean
  flipVertical: boolean
  swapsAxes: boolean // true when rendered width/height come from source height/width
}

const TABLE: Record<OrientationCode, Omit<OrientationInfo, 'code'>> = {
  1: { rotation: 0, flipHorizontal: false, flipVertical: false, swapsAxes: false },
  2: { rotation: 0, flipHorizontal: true, flipVertical: false, swapsAxes: false },
  3: { rotation: 180, flipHorizontal: false, flipVertical: false, swapsAxes: false },
  4: { rotation: 0, flipHorizontal: false, flipVertical: true, swapsAxes: false },
  5: { rotation: 90, flipHorizontal: false, flipVertical: true, swapsAxes: true },
  6: { rotation: 90, flipHorizontal: false, flipVertical: false, swapsAxes: true },
  7: { rotation: 270, flipHorizontal: false, flipVertical: true, swapsAxes: true },
  8: { rotation: 270, flipHorizontal: false, flipVertical: false, swapsAxes: true },
}

export function describeOrientation(code: OrientationCode): OrientationInfo {
  return { code, ...TABLE[code] }
}

export function isValidOrientationCode(n: number): n is OrientationCode {
  return Number.isInteger(n) && n >= 1 && n <= 8
}

// Apply the orientation's axis swap to an intrinsic (width, height) pair.
// This is the only function `layout.ts` actually needs: the rest of the
// orientation metadata is for custom rendering.
export function applyOrientationToSize(
  width: number,
  height: number,
  code: OrientationCode,
): { width: number; height: number } {
  if (code < 5) return { width, height }
  return { width: height, height: width }
}

// Cheap EXIF orientation reader for JPEG byte prefixes. Most callers won't use
// this — they'll pass a known orientation alongside the source — but it lets
// the measurement pass recover orientation when given a `Blob` or `ArrayBuffer`
// directly, before the browser has stripped it.
//
// Returns `null` if the buffer isn't JPEG, the EXIF block is missing, or the
// orientation tag is malformed.
export function readExifOrientation(buffer: ArrayBuffer): OrientationCode | null {
  const view = new DataView(buffer)
  if (view.byteLength < 4) return null
  if (view.getUint16(0) !== 0xFFD8) return null // not JPEG SOI

  let offset = 2
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset)
    offset += 2
    if ((marker & 0xFF00) !== 0xFF00) return null
    const segmentLength = view.getUint16(offset)
    if (segmentLength < 2) return null
    if (marker === 0xFFE1) {
      // APP1 — candidate EXIF segment.
      if (offset + 10 > view.byteLength) return null
      const hdr0 = view.getUint32(offset + 2)
      const hdr1 = view.getUint16(offset + 6)
      // "Exif\0\0"
      if (hdr0 !== 0x45786966 || hdr1 !== 0x0000) {
        offset += segmentLength
        continue
      }
      const tiffStart = offset + 8
      if (tiffStart + 8 > view.byteLength) return null
      const byteOrder = view.getUint16(tiffStart)
      const little = byteOrder === 0x4949
      const big = byteOrder === 0x4D4D
      if (!little && !big) return null
      if (view.getUint16(tiffStart + 2, little) !== 0x002A) return null
      const ifdOffset = view.getUint32(tiffStart + 4, little)
      const ifdStart = tiffStart + ifdOffset
      if (ifdStart + 2 > view.byteLength) return null
      const entryCount = view.getUint16(ifdStart, little)
      for (let i = 0; i < entryCount; i++) {
        const entryOffset = ifdStart + 2 + i * 12
        if (entryOffset + 12 > view.byteLength) return null
        const tag = view.getUint16(entryOffset, little)
        if (tag !== 0x0112) continue
        const rawValue = view.getUint16(entryOffset + 8, little)
        if (isValidOrientationCode(rawValue)) return rawValue
        return null
      }
      return null
    }
    offset += segmentLength
  }
  return null
}

// Gallery-level helper. Produces an Int8Array of orientation codes parallel to
// the item list, mirroring pretext's `segLevels`. Callers that don't know the
// orientation for an item get a `1` (identity) by default.
export function computeItemOrientationLevels(
  orientations: ReadonlyArray<OrientationCode | null | undefined>,
): Int8Array {
  const levels = new Int8Array(orientations.length)
  for (let i = 0; i < orientations.length; i++) {
    const value = orientations[i]
    levels[i] = value != null && isValidOrientationCode(value) ? value : 1
  }
  return levels
}
