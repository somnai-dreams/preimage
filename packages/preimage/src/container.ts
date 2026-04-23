// `.prei` container format. A 128-byte fixed prefix wrapping any
// image payload (JPEG/PNG/WebP/AVIF) with everything preimage wants
// to know about it: dimensions, alpha, progressive flag, format,
// byteLength, optional thumbhash, crc32 for integrity.
//
// Client fetches `Range: bytes=0-127`, parses deterministically, has
// enough metadata to lay out without touching the image payload at
// all. Payload after byte 128 is the original JPEG/PNG/WebP/AVIF
// bytes, unmodified — a `.prei` file can be "unwrapped" by stripping
// the prefix, producing a byte-identical original.
//
// Byte layout (big-endian throughout):
//
//   offset  size  field
//    0       4   magic "PREI"
//    4       2   version (u16)
//    6       2   flags   (u16)
//    8       4   width   (u32)
//   12       4   height  (u32)
//   16       8   payloadByteLength (u64)
//   24       4   format  (4 ASCII: "jpeg"|"png "|"webp"|"avif")
//   28      24   thumbhash (right-padded with zeros if shorter)
//   52       8   sha256Prefix (first 8 bytes of sha256(payload))
//   60      60   reserved (zeros, for post-v1 additions)
//  120       4   crc32 over bytes 0-119 (u32)
//  124       4   reserved (alignment)
//  128     ...   payload (original image bytes)
//
// Flags layout (u16):
//   bit 0  hasAlpha
//   bit 1  isProgressive
//   bits 2-15 reserved

export const PREIMAGE_CONTAINER_SIZE = 128
export const PREIMAGE_CONTAINER_VERSION = 1
export const PREIMAGE_MAGIC = new Uint8Array([0x50, 0x52, 0x45, 0x49]) // "PREI"

export type ContainerFormat = 'jpeg' | 'png' | 'webp' | 'avif'

export type ContainerMetadata = {
  version: number
  width: number
  height: number
  hasAlpha: boolean
  isProgressive: boolean
  payloadByteLength: number
  format: ContainerFormat
  /** 24-byte thumbhash (or zero-padded if shorter; all-zero = absent). */
  thumbhash: Uint8Array
  /** First 8 bytes of sha256(payload). All-zero = absent. */
  sha256Prefix: Uint8Array
}

export type DecodedContainer =
  | { valid: true; meta: ContainerMetadata }
  | { valid: false; reason: DecodeFailure }

export type DecodeFailure =
  | 'too-short'
  | 'bad-magic'
  | 'unknown-version'
  | 'bad-crc'
  | 'bad-format'

// --- CRC32 (IEEE 802.3, reflected) ---

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xFF]! ^ (c >>> 8)
  }
  return (c ^ 0xFFFFFFFF) >>> 0
}

// --- Format ASCII ---

const FORMAT_TAGS: Record<ContainerFormat, Uint8Array> = {
  jpeg: new Uint8Array([0x6A, 0x70, 0x65, 0x67]), // "jpeg"
  png: new Uint8Array([0x70, 0x6E, 0x67, 0x20]), // "png "
  webp: new Uint8Array([0x77, 0x65, 0x62, 0x70]), // "webp"
  avif: new Uint8Array([0x61, 0x76, 0x69, 0x66]), // "avif"
}

function formatFromTag(tag: Uint8Array): ContainerFormat | null {
  for (const [name, expected] of Object.entries(FORMAT_TAGS) as [ContainerFormat, Uint8Array][]) {
    if (tag[0] === expected[0] && tag[1] === expected[1] && tag[2] === expected[2] && tag[3] === expected[3]) {
      return name
    }
  }
  return null
}

// --- Flags ---

const FLAG_HAS_ALPHA = 0x0001
const FLAG_IS_PROGRESSIVE = 0x0002

// --- Encode ---

/** Build the 128-byte prefix. The caller concatenates this with the
 *  image payload bytes to produce a complete `.prei` file. */
export function encodeContainerPrefix(meta: Omit<ContainerMetadata, 'version'>): Uint8Array {
  const prefix = new Uint8Array(PREIMAGE_CONTAINER_SIZE)
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)

  prefix.set(PREIMAGE_MAGIC, 0)
  view.setUint16(4, PREIMAGE_CONTAINER_VERSION, false)

  let flags = 0
  if (meta.hasAlpha) flags |= FLAG_HAS_ALPHA
  if (meta.isProgressive) flags |= FLAG_IS_PROGRESSIVE
  view.setUint16(6, flags, false)

  view.setUint32(8, meta.width, false)
  view.setUint32(12, meta.height, false)
  // u64 setBigUint64. Payload sizes above 2^53 aren't representable
  // as JS numbers anyway, but callers pass Number here so we split
  // high/low manually rather than forcing BigInt on the caller side.
  const hi = Math.floor(meta.payloadByteLength / 0x100000000)
  const lo = meta.payloadByteLength >>> 0
  view.setUint32(16, hi, false)
  view.setUint32(20, lo, false)

  prefix.set(FORMAT_TAGS[meta.format], 24)

  // Thumbhash: up to 24 bytes, right-padded with zeros.
  prefix.set(meta.thumbhash.subarray(0, 24), 28)

  // sha256 prefix: exactly 8 bytes.
  prefix.set(meta.sha256Prefix.subarray(0, 8), 52)

  // CRC over bytes 0-119.
  const crc = crc32(prefix.subarray(0, 120))
  view.setUint32(120, crc, false)

  return prefix
}

// --- Decode ---

/** Parse a 128-byte prefix. Returns `{ valid: false, reason }` on any
 *  failure (too-short input, bad magic, bad CRC, unknown version,
 *  unknown format); no exceptions on the fast path. */
export function decodeContainerPrefix(bytes: Uint8Array): DecodedContainer {
  if (bytes.length < PREIMAGE_CONTAINER_SIZE) return { valid: false, reason: 'too-short' }

  if (
    bytes[0] !== PREIMAGE_MAGIC[0] ||
    bytes[1] !== PREIMAGE_MAGIC[1] ||
    bytes[2] !== PREIMAGE_MAGIC[2] ||
    bytes[3] !== PREIMAGE_MAGIC[3]
  ) {
    return { valid: false, reason: 'bad-magic' }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, PREIMAGE_CONTAINER_SIZE)
  const version = view.getUint16(4, false)
  if (version !== PREIMAGE_CONTAINER_VERSION) {
    return { valid: false, reason: 'unknown-version' }
  }

  const expectedCrc = view.getUint32(120, false)
  const actualCrc = crc32(bytes.subarray(0, 120))
  if (expectedCrc !== actualCrc) return { valid: false, reason: 'bad-crc' }

  const flags = view.getUint16(6, false)
  const width = view.getUint32(8, false)
  const height = view.getUint32(12, false)
  const hi = view.getUint32(16, false)
  const lo = view.getUint32(20, false)
  const payloadByteLength = hi * 0x100000000 + lo

  const formatTag = bytes.subarray(24, 28)
  const format = formatFromTag(formatTag)
  if (format === null) return { valid: false, reason: 'bad-format' }

  // Copy out thumbhash + sha256 so callers don't hold views into the
  // original 128-byte buffer longer than the decode call.
  const thumbhash = new Uint8Array(24)
  thumbhash.set(bytes.subarray(28, 52))
  const sha256Prefix = new Uint8Array(8)
  sha256Prefix.set(bytes.subarray(52, 60))

  return {
    valid: true,
    meta: {
      version,
      width,
      height,
      hasAlpha: (flags & FLAG_HAS_ALPHA) !== 0,
      isProgressive: (flags & FLAG_IS_PROGRESSIVE) !== 0,
      payloadByteLength,
      format,
      thumbhash,
      sha256Prefix,
    },
  }
}

// --- Convenience ---

/** Concatenate a prefix with a payload into a complete container
 *  buffer. Used by the transcode CLI when writing files. */
export function buildContainer(
  meta: Omit<ContainerMetadata, 'version' | 'payloadByteLength'>,
  payload: Uint8Array,
): Uint8Array {
  const prefix = encodeContainerPrefix({ ...meta, payloadByteLength: payload.byteLength })
  const out = new Uint8Array(PREIMAGE_CONTAINER_SIZE + payload.byteLength)
  out.set(prefix, 0)
  out.set(payload, PREIMAGE_CONTAINER_SIZE)
  return out
}

/** Convenience check for "is this the 128-byte prefix of a container?"
 *  without paying the CRC cost. Use before a full decode when the
 *  caller just wants to branch. */
export function isContainerPrefix(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === PREIMAGE_MAGIC[0] &&
    bytes[1] === PREIMAGE_MAGIC[1] &&
    bytes[2] === PREIMAGE_MAGIC[2] &&
    bytes[3] === PREIMAGE_MAGIC[3]
  )
}
