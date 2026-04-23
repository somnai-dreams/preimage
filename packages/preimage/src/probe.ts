// Parse image dimensions from format headers — no decode, no browser
// HTMLImageElement, no async. Each of PNG / JPEG / WebP / GIF / BMP / SVG /
// AVIF / HEIC encodes width and height in the first few bytes of the
// file. Parsing those bytes directly returns dimensions in sub-millisecond
// time, and lets streaming callers stop waiting for the rest of a fetch
// once they have what they need.
//
// Format coverage:
//   PNG         — 24 bytes: IHDR chunk (offsets 16-23, width/height big-endian u32)
//   JPEG        — SOFn marker; typically within first 512 bytes, almost always <2KB
//   GIF         — 10 bytes: logical screen descriptor (offsets 6-9 little-endian u16)
//   BMP         — 26 bytes: BITMAPINFOHEADER (offsets 18-25 little-endian, height i32)
//   WebP        — 30 bytes: VP8 / VP8L / VP8X chunk
//   SVG         — regex scan of <svg ... width height viewBox> in the first 4KB
//   AVIF / HEIC — ISOBMFF `ftyp` sniff + scan for `ispe` (image spatial
//                 extents) box. Empirically lands in the first <1KB for
//                 sample corpora we measured; 4KB budget is comfortable.
//
// Intentionally NOT covered (v1):
//   TIFF / ICO / JPEG 2000 — low-demand; add if someone asks.
//
// All parsers are pure over a Uint8Array and return null if the input is
// too short, not the expected format, or has zero dimensions.

import type { ImageFormat } from './analysis.js'

export type ProbedDimensions = {
  width: number
  height: number
  format: ImageFormat
  /** True if the format header indicates an alpha channel. PNG color
   *  types 4 (grayscale+α) and 6 (RGBA) and WebP VP8L / VP8X-with-
   *  alpha-flag set this; JPEG is always false; SVG is treated as true
   *  (SVGs composite onto the page background). GIF transparency and
   *  PNG tRNS-chunk-indexed-alpha are reported as false — detecting
   *  them correctly requires parsing past the header. */
  hasAlpha: boolean
  /** True for progressive JPEGs (SOF2 marker), false for baseline
   *  (SOF0). Meaningless on other formats; reported as false. */
  isProgressive: boolean
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
const FTYP_SIG = [0x66, 0x74, 0x79, 0x70] // 'ftyp'
const ISPE_SIG = [0x69, 0x73, 0x70, 0x65] // 'ispe'

// ftyp major_brand sits at bytes 8-11. Compatible brands follow and we
// don't walk those; a handful of image brands cover ~everything in the
// wild.
const AVIF_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis'])
const HEIC_BRANDS: ReadonlySet<string> = new Set(['heic', 'heix', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])

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
  if (bytes.length < 26) return null
  // IHDR chunk lives at byte 8: [length:4][type:4='IHDR'][width:4][height:4]
  //                             [bitDepth:1][colorType:1][...]
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null
  }
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width === 0 || height === 0) return null
  // Color types with a native alpha channel: 4 (grayscale+α), 6 (RGBA).
  // Type 3 (indexed) can carry alpha via a later tRNS chunk; detecting
  // that would require walking past IHDR, which we don't.
  const colorType = bytes[25]!
  const hasAlpha = colorType === 4 || colorType === 6
  return { width, height, format: 'png', hasAlpha, isProgressive: false }
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
      // SOF2 (0xC2) = progressive DCT; SOF0/SOF1/others = baseline/
      // sequential. Progressive JPEGs render mid-decode so callers can
      // skip the opacity fade-in.
      const isProgressive = marker === 0xC2
      return { width, height, format: 'jpeg', hasAlpha: false, isProgressive }
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
  return { width, height, format: 'gif', hasAlpha: false, isProgressive: false }
}

// --- BMP ---

function probeBmp(bytes: Uint8Array): ProbedDimensions | null {
  if (!matches(bytes, BMP_SIG)) return null
  if (bytes.length < 26) return null
  const width = i32le(bytes, 18)
  const heightRaw = i32le(bytes, 22)
  const height = Math.abs(heightRaw) // negative = top-down DIB
  if (width <= 0 || height <= 0) return null
  return { width, height, format: 'bmp', hasAlpha: false, isProgressive: false }
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
    return { width: w, height: h, format: 'webp', hasAlpha: false, isProgressive: false }
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
    // VP8L always carries alpha (spec-wise; the channel may be
    // all-0xFF but callers can't know without decode).
    return { width, height, format: 'webp', hasAlpha: true, isProgressive: false }
  }
  if (chunkType === 'VP8X') {
    // Extended: flags byte at offset 20. Bit 4 (0x10) = alpha present.
    const flags = bytes[20]!
    const hasAlpha = (flags & 0x10) !== 0
    // Canvas width-1 at offset 24 (3 bytes LE), height-1 at 27.
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1
    if (width === 0 || height === 0) return null
    return { width, height, format: 'webp', hasAlpha, isProgressive: false }
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
  // Isolate the `<svg ...>` opening tag's attributes so the per-
  // attribute regexes can freely match quoted values that appear
  // before the one they care about. The old pattern — greedy
  // `[^>"']*` inside each regex — failed when a quoted width
  // attribute sat before height, because it couldn't skip past the
  // `"` character.
  const tagMatch = text.match(/<svg\b([^>]*)>/i)
  if (tagMatch === null) return null
  const attrs = tagMatch[1]!

  const widthMatch = attrs.match(/\swidth\s*=\s*["']?([0-9.]+)(?:px)?["']?/i)
  const heightMatch = attrs.match(/\sheight\s*=\s*["']?([0-9.]+)(?:px)?["']?/i)
  if (widthMatch !== null && heightMatch !== null) {
    const w = Number(widthMatch[1])
    const h = Number(heightMatch[1])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h, format: 'svg', hasAlpha: true, isProgressive: false }
    }
  }
  const viewBoxMatch = attrs.match(
    /\sviewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i,
  )
  if (viewBoxMatch !== null) {
    const w = Number(viewBoxMatch[1])
    const h = Number(viewBoxMatch[2])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h, format: 'svg', hasAlpha: true, isProgressive: false }
    }
  }
  return null
}

// --- AVIF / HEIC (ISOBMFF ispe box) ---
//
// AVIF and HEIC are ISOBMFF containers whose first box is `ftyp` at
// offset 0. We confirm the container via the major_brand at bytes 8-11,
// then scan the first N bytes for the `ispe` (image spatial extents)
// box, whose 20-byte layout is:
//   [size:4 BE = 20][type:4 = 'ispe'][version+flags:4][width:4 BE][height:4 BE]
// The preceding 4-byte size check filters false-positive byte matches on
// the 'ispe' tag.
//
// We don't walk the full `meta`→`iprp`→`ipco` hierarchy — images with
// multiple `ispe` entries (thumbnails) return the first one found, which
// in practice is the primary since thumbnails are stored after the main
// item's properties. A caller needing surgical primary-item handling
// should parse the full structure; for layout purposes any ispe yields
// the right aspect ratio.
//
// hasAlpha is reported as `true` conservatively: AVIF/HEIC can carry
// alpha via an `auxC` auxiliary image item, but detecting that requires
// walking the full property hierarchy. Reporting `true` means callers
// keep their skeleton tint — a safe default.

function guessIsobmffFormat(bytes: Uint8Array): 'avif' | 'heic' | null {
  if (bytes.length < 12) return null
  if (!matches(bytes, FTYP_SIG, 4)) return null
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
  if (AVIF_BRANDS.has(brand)) return 'avif'
  if (HEIC_BRANDS.has(brand)) return 'heic'
  return null
}

function probeIsobmff(bytes: Uint8Array): ProbedDimensions | null {
  const format = guessIsobmffFormat(bytes)
  if (format === null) return null
  // Scan for `ispe` starting after the ftyp box. We start at offset 4
  // (the tag follows the size field) and require 16 bytes after the
  // tag for the rest of the box payload.
  const limit = bytes.length - 16
  for (let i = 4; i <= limit; i++) {
    if (
      bytes[i] === ISPE_SIG[0] &&
      bytes[i + 1] === ISPE_SIG[1] &&
      bytes[i + 2] === ISPE_SIG[2] &&
      bytes[i + 3] === ISPE_SIG[3]
    ) {
      if (u32be(bytes, i - 4) !== 20) continue
      const width = u32be(bytes, i + 8)
      const height = u32be(bytes, i + 12)
      // Sanity: reject absurd values that only arise when the size-20
      // check happens to pass on unrelated data.
      if (width === 0 || height === 0) continue
      if (width >= 100_000 || height >= 100_000) continue
      return { width, height, format, hasAlpha: true, isProgressive: false }
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
    probeIsobmff(bytes) ??
    probeSvg(bytes) ??
    null
  )
}

// --- Streaming probe ---
//
// Consume a ReadableStream of image bytes (WebSocket, fetch().body,
// AI-gen output, anything producing Uint8Array chunks), retrying
// probeImageBytes on the growing buffer after each chunk arrives.
// Dimensions fire as soon as the header is in hand — for PNG that's
// the first 24 bytes, for JPEG typically under 2KB — via `onDims`.
// The returned promise resolves with the dims and the complete Blob
// once the stream drains.
//
// The Blob is assembled from every chunk so the caller can turn it
// into a blob URL (URL.createObjectURL(result.blob)) and pass to an
// <img> for render — no second network fetch needed.
//
// maxProbeBytes caps how many bytes we'll retain as a contiguous
// buffer for retrying the probe. After that threshold we stop
// retrying but keep buffering for the final Blob. Default 64KB —
// comfortably past the largest header any supported format needs.
//
// `dims` is null when the probe never succeeded: either the stream
// is a format probeImageBytes doesn't recognize, or the header was
// malformed, or maxProbeBytes was reached before a header resolved.
// `onDims` is not fired in that case. Callers that need to render a
// best-effort <img> even without dims can still use `blob` — the
// browser's own decoder is more lenient than our header parser.

export type ProbeImageStreamOptions = {
  onDims?: (dims: ProbedDimensions) => void
  maxProbeBytes?: number
}

export type ProbeImageStreamResult = {
  dims: ProbedDimensions | null
  blob: Blob
}

export async function probeImageStream(
  readable: ReadableStream<Uint8Array>,
  options: ProbeImageStreamOptions = {},
): Promise<ProbeImageStreamResult> {
  const maxProbeBytes = options.maxProbeBytes ?? 64 * 1024
  const onDims = options.onDims

  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let dims: ProbedDimensions | null = null
  let probingDone = false

  const reader = readable.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      totalBytes += value.byteLength

      if (!probingDone) {
        const probed = probeImageBytes(concatChunks(chunks, totalBytes))
        if (probed !== null) {
          dims = probed
          probingDone = true
          if (onDims !== undefined) onDims(probed)
        } else if (totalBytes >= maxProbeBytes) {
          // Stop retrying — we've buffered more than any supported
          // header needs. Stream continues draining into the Blob.
          probingDone = true
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { dims, blob: new Blob(chunks as BlobPart[]) }
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const buf = new Uint8Array(totalBytes)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return buf
}
