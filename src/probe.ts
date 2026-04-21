// Parse image dimensions from format headers — no decode, no browser
// HTMLImageElement, no async. Each of PNG / JPEG / WebP / GIF / BMP / SVG
// encodes width and height in the first few bytes of the file. Parsing
// those bytes directly returns dimensions in sub-millisecond time, and
// lets streaming callers stop waiting for the rest of a fetch once they
// have what they need.
//
// Format coverage:
//   PNG   — 24 bytes: IHDR chunk (offsets 16-23, width/height big-endian u32)
//   JPEG  — SOFn marker; typically within first 512 bytes, almost always <2KB
//   GIF   — 10 bytes: logical screen descriptor (offsets 6-9 little-endian u16)
//   BMP   — 26 bytes: BITMAPINFOHEADER (offsets 18-25 little-endian, height i32)
//   WebP  — 30 bytes: VP8 / VP8L / VP8X chunk
//   SVG   — regex scan of <svg ... width height viewBox> in the first 4KB
//
// Intentionally NOT covered (v1):
//   AVIF / HEIC — ISOBMFF containers; `ispe` boxes can sit anywhere in the
//     first few KB with nested `meta` structures. Callers fall back to
//     createImageBitmap for these; streaming still helps because bytes are
//     already buffered in memory when decode starts.
//   TIFF / ICO / JPEG 2000 — low-demand; add if someone asks.
//
// All parsers are pure over a Uint8Array and return null if the input is
// too short, not the expected format, or has zero dimensions.

import type { ImageFormat } from './analysis.js'

export type ProbedDimensions = {
  width: number
  height: number
  format: ImageFormat
}

// Minimum byte budget callers should buffer before calling `probeImageBytes`.
// Picked to comfortably cover every supported format's worst case, including
// JPEGs whose SOF marker sits past a few APP segments.
export const MAX_HEADER_BYTES = 4096

// --- Signatures ---

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const JPEG_SIG = [0xFF, 0xD8, 0xFF]
const GIF87_SIG = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]
const GIF89_SIG = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const BMP_SIG = [0x42, 0x4D]
const RIFF_SIG = [0x52, 0x49, 0x46, 0x46]
const WEBP_SIG = [0x57, 0x45, 0x42, 0x50]

function matches(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false
  }
  return true
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!
}
function u32be(b: Uint8Array, o: number): number {
  return b[o]! * 0x1000000 + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8)
}
function i32le(b: Uint8Array, o: number): number {
  // Signed to handle BMP's top-down negative height.
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) | 0
}

// --- PNG ---

function probePng(bytes: Uint8Array): ProbedDimensions | null {
  if (!matches(bytes, PNG_SIG)) return null
  if (bytes.length < 24) return null
  // IHDR chunk lives at byte 8: [length:4][type:4='IHDR'][width:4][height:4]
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null
  }
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width === 0 || height === 0) return null
  return { width, height, format: 'png' }
}

// --- JPEG ---

// SOF markers that carry dimensions. Excludes DHT (C4), JPG (C8), DAC (CC).
const SOF_MARKERS: ReadonlySet<number> = new Set([
  0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
  0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
])

function probeJpeg(bytes: Uint8Array): ProbedDimensions | null {
  if (!matches(bytes, JPEG_SIG)) return null
  let offset = 2
  while (offset + 4 < bytes.length) {
    // Walk fill bytes (0xFF repeats).
    while (offset < bytes.length && bytes[offset] === 0xFF) offset++
    if (offset >= bytes.length) return null
    const marker = bytes[offset]!
    offset++
    // Standalone markers with no payload/length.
    if (marker === 0x00 || marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      continue
    }
    if (offset + 2 > bytes.length) return null
    const segLen = u16be(bytes, offset)
    if (segLen < 2) return null
    if (SOF_MARKERS.has(marker)) {
      // Segment payload: [precision:1][height:2][width:2]
      if (offset + 7 > bytes.length) return null
      const height = u16be(bytes, offset + 3)
      const width = u16be(bytes, offset + 5)
      if (width === 0 || height === 0) return null
      return { width, height, format: 'jpeg' }
    }
    offset += segLen
  }
  return null
}

// --- GIF ---

function probeGif(bytes: Uint8Array): ProbedDimensions | null {
  if (!matches(bytes, GIF87_SIG) && !matches(bytes, GIF89_SIG)) return null
  if (bytes.length < 10) return null
  const width = u16le(bytes, 6)
  const height = u16le(bytes, 8)
  if (width === 0 || height === 0) return null
  return { width, height, format: 'gif' }
}

// --- BMP ---

function probeBmp(bytes: Uint8Array): ProbedDimensions | null {
  if (!matches(bytes, BMP_SIG)) return null
  if (bytes.length < 26) return null
  const width = i32le(bytes, 18)
  const heightRaw = i32le(bytes, 22)
  const height = Math.abs(heightRaw) // negative = top-down DIB
  if (width <= 0 || height <= 0) return null
  return { width, height, format: 'bmp' }
}

// --- WebP ---

function probeWebp(bytes: Uint8Array): ProbedDimensions | null {
  if (!matches(bytes, RIFF_SIG, 0)) return null
  if (!matches(bytes, WEBP_SIG, 8)) return null
  if (bytes.length < 30) return null
  const chunkType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (chunkType === 'VP8 ') {
    // Lossy: 3-byte sync (0x9D 0x01 0x2A) at offset 23, then W:2 H:2.
    // 14-bit widths are packed at offsets 26 and 28.
    const w = u16le(bytes, 26) & 0x3FFF
    const h = u16le(bytes, 28) & 0x3FFF
    if (w === 0 || h === 0) return null
    return { width: w, height: h, format: 'webp' }
  }
  if (chunkType === 'VP8L') {
    // Lossless: 14-bit width-1 / height-1 packed across 4 bytes at offset 21.
    const b0 = bytes[21]!
    const b1 = bytes[22]!
    const b2 = bytes[23]!
    const b3 = bytes[24]!
    const width = (((b1 & 0x3F) << 8) | b0) + 1
    const height = (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)) + 1
    if (width === 0 || height === 0) return null
    return { width, height, format: 'webp' }
  }
  if (chunkType === 'VP8X') {
    // Extended: canvas width-1 at offset 24 (3 bytes LE), height-1 at 27.
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1
    if (width === 0 || height === 0) return null
    return { width, height, format: 'webp' }
  }
  return null
}

// --- SVG ---

function probeSvg(bytes: Uint8Array): ProbedDimensions | null {
  // Sniff for `<svg` in the first 4KB. XML declaration and comments can
  // precede the root element.
  const head = Math.min(bytes.length, MAX_HEADER_BYTES)
  let found = false
  for (let i = 0; i <= head - 4; i++) {
    if (bytes[i] === 0x3C && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x76 && bytes[i + 3] === 0x67) {
      found = true
      break
    }
  }
  if (!found) return null
  const text = new TextDecoder().decode(bytes.subarray(0, head))
  const widthMatch = text.match(/<svg\b[^>]*\swidth=["']?([0-9.]+)(?:px)?["']?/i)
  const heightMatch = text.match(/<svg\b[^>]*\sheight=["']?([0-9.]+)(?:px)?["']?/i)
  if (widthMatch !== null && heightMatch !== null) {
    const w = Number(widthMatch[1])
    const h = Number(heightMatch[1])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h, format: 'svg' }
    }
  }
  const viewBoxMatch = text.match(
    /<svg\b[^>]*\sviewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i,
  )
  if (viewBoxMatch !== null) {
    const w = Number(viewBoxMatch[1])
    const h = Number(viewBoxMatch[2])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h, format: 'svg' }
    }
  }
  return null
}

// --- Public dispatch ---

export function probeImageBytes(bytes: Uint8Array): ProbedDimensions | null {
  return (
    probePng(bytes) ??
    probeJpeg(bytes) ??
    probeGif(bytes) ??
    probeWebp(bytes) ??
    probeBmp(bytes) ??
    probeSvg(bytes) ??
    null
  )
}
