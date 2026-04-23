// `.prei` sidecar + HTTP response-header convention. Single wire format
// in two physical shapes:
//
//   (1) HTTP response headers on the image itself (preferred path).
//       A preimage-aware origin sets `Preimage-Width`, `Preimage-Height`,
//       etc. on the image GET response. Client does a HEAD and reads
//       them — zero body bytes transferred for the probe.
//
//   (2) A plain-text sidecar file next to the image (fallback for static
//       origins that can't be configured to set headers). Same `Key:
//       Value` format. Client fetches `photo.jpg.prei` and parses the
//       lines identically.
//
// Both shapes are byte-identical in the parser's eyes: one parse path,
// two sources of bytes. The sidecar file literally IS the header set
// the origin would have sent.
//
// Field vocabulary (v1):
//
//   Preimage-Version: 1                    (required)
//   Preimage-Width: 1920                   (required)
//   Preimage-Height: 1080                  (required)
//   Preimage-Format: jpeg|png|webp|avif|gif|svg|bmp   (required)
//   Preimage-Byte-Length: 483721           (optional)
//   Preimage-Has-Alpha: 0|1                (optional, default 0)
//   Preimage-Progressive: 0|1              (optional, default 0)
//   Preimage-Sha: <hex, first 8 bytes of sha256(payload)>  (optional)
//   Preimage-Thumbhash: <base64>           (optional)
//
// Unknown fields are ignored (forward-compat). Whitespace around the
// colon and around values is trimmed. Empty lines are ignored.

export const SIDECAR_VERSION = 1
export const SIDECAR_EXTENSION = '.prei'

// Header name constants. Used verbatim in both the sidecar text format
// and the HTTP response headers an origin would send.
export const SIDECAR_HEADERS = {
  Version: 'Preimage-Version',
  Width: 'Preimage-Width',
  Height: 'Preimage-Height',
  Format: 'Preimage-Format',
  ByteLength: 'Preimage-Byte-Length',
  HasAlpha: 'Preimage-Has-Alpha',
  Progressive: 'Preimage-Progressive',
  Sha: 'Preimage-Sha',
  Thumbhash: 'Preimage-Thumbhash',
} as const

export type SidecarFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'svg' | 'bmp'

const SIDECAR_FORMATS: ReadonlySet<string> = new Set([
  'jpeg', 'png', 'webp', 'avif', 'gif', 'svg', 'bmp',
])

export type SidecarMetadata = {
  version: number
  width: number
  height: number
  format: SidecarFormat
  byteLength: number | null
  hasAlpha: boolean
  isProgressive: boolean
  /** First 8 bytes of sha256(payload) as hex. Empty string when absent. */
  sha: string
  /** Base64-encoded thumbhash. Empty string when absent. */
  thumbhash: string
}

export type DecodedSidecar =
  | { valid: true; meta: SidecarMetadata }
  | { valid: false; reason: SidecarFailure }

export type SidecarFailure =
  | 'empty'
  | 'missing-version'
  | 'unknown-version'
  | 'missing-dims'
  | 'bad-dims'
  | 'missing-format'
  | 'bad-format'

// --- Encode ---

/** Build the text body of a sidecar. Optional fields are omitted when
 *  their value is the type default (byteLength null, flags false, sha
 *  / thumbhash empty) — keeps the file tight and makes `diff` useful. */
export function encodeSidecar(meta: Omit<SidecarMetadata, 'version'>): string {
  const lines: string[] = []
  lines.push(`${SIDECAR_HEADERS.Version}: ${SIDECAR_VERSION}`)
  lines.push(`${SIDECAR_HEADERS.Width}: ${meta.width}`)
  lines.push(`${SIDECAR_HEADERS.Height}: ${meta.height}`)
  lines.push(`${SIDECAR_HEADERS.Format}: ${meta.format}`)
  if (meta.byteLength !== null) {
    lines.push(`${SIDECAR_HEADERS.ByteLength}: ${meta.byteLength}`)
  }
  if (meta.hasAlpha) lines.push(`${SIDECAR_HEADERS.HasAlpha}: 1`)
  if (meta.isProgressive) lines.push(`${SIDECAR_HEADERS.Progressive}: 1`)
  if (meta.sha !== '') lines.push(`${SIDECAR_HEADERS.Sha}: ${meta.sha}`)
  if (meta.thumbhash !== '') lines.push(`${SIDECAR_HEADERS.Thumbhash}: ${meta.thumbhash}`)
  return lines.join('\n') + '\n'
}

/** Convert sidecar metadata into a `Headers`-compatible object. Use
 *  when setting HTTP response headers on an image GET from a
 *  preimage-aware origin. */
export function sidecarToResponseHeaders(
  meta: Omit<SidecarMetadata, 'version'>,
): Record<string, string> {
  const out: Record<string, string> = {}
  out[SIDECAR_HEADERS.Version] = String(SIDECAR_VERSION)
  out[SIDECAR_HEADERS.Width] = String(meta.width)
  out[SIDECAR_HEADERS.Height] = String(meta.height)
  out[SIDECAR_HEADERS.Format] = meta.format
  if (meta.byteLength !== null) out[SIDECAR_HEADERS.ByteLength] = String(meta.byteLength)
  if (meta.hasAlpha) out[SIDECAR_HEADERS.HasAlpha] = '1'
  if (meta.isProgressive) out[SIDECAR_HEADERS.Progressive] = '1'
  if (meta.sha !== '') out[SIDECAR_HEADERS.Sha] = meta.sha
  if (meta.thumbhash !== '') out[SIDECAR_HEADERS.Thumbhash] = meta.thumbhash
  return out
}

// --- Decode ---

/** Parse the text body of a sidecar file. Same format as HTTP response
 *  headers, so a round-tripped `response.headers.entries()` parses
 *  equivalently through `decodeSidecarHeaders`. */
export function decodeSidecar(text: string): DecodedSidecar {
  const headers = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name === '') continue
    // Normalize name to title-case-ish by lower-casing for lookup,
    // so callers don't need to worry about case on either side.
    headers.set(name.toLowerCase(), value)
  }
  return decodeSidecarFromMap(headers)
}

/** Parse a `Headers` instance (or any `.get(name) → string | null`
 *  object) — the HEAD-request path. */
export function decodeSidecarHeaders(headers: {
  get: (name: string) => string | null
}): DecodedSidecar {
  const map = new Map<string, string>()
  for (const key of Object.values(SIDECAR_HEADERS)) {
    const v = headers.get(key)
    if (v !== null) map.set(key.toLowerCase(), v)
  }
  return decodeSidecarFromMap(map)
}

function decodeSidecarFromMap(headers: Map<string, string>): DecodedSidecar {
  if (headers.size === 0) return { valid: false, reason: 'empty' }

  const versionRaw = headers.get(SIDECAR_HEADERS.Version.toLowerCase())
  if (versionRaw === undefined) return { valid: false, reason: 'missing-version' }
  const version = Number(versionRaw)
  if (!Number.isFinite(version) || version !== SIDECAR_VERSION) {
    return { valid: false, reason: 'unknown-version' }
  }

  const widthRaw = headers.get(SIDECAR_HEADERS.Width.toLowerCase())
  const heightRaw = headers.get(SIDECAR_HEADERS.Height.toLowerCase())
  if (widthRaw === undefined || heightRaw === undefined) {
    return { valid: false, reason: 'missing-dims' }
  }
  const width = Number(widthRaw)
  const height = Number(heightRaw)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { valid: false, reason: 'bad-dims' }
  }

  const formatRaw = headers.get(SIDECAR_HEADERS.Format.toLowerCase())
  if (formatRaw === undefined) return { valid: false, reason: 'missing-format' }
  const format = formatRaw.toLowerCase()
  if (!SIDECAR_FORMATS.has(format)) return { valid: false, reason: 'bad-format' }

  const byteLengthRaw = headers.get(SIDECAR_HEADERS.ByteLength.toLowerCase())
  let byteLength: number | null = null
  if (byteLengthRaw !== undefined) {
    const n = Number(byteLengthRaw)
    if (Number.isFinite(n) && n >= 0) byteLength = n
  }

  const hasAlpha = parseFlag(headers.get(SIDECAR_HEADERS.HasAlpha.toLowerCase()))
  const isProgressive = parseFlag(headers.get(SIDECAR_HEADERS.Progressive.toLowerCase()))

  return {
    valid: true,
    meta: {
      version,
      width: Math.round(width),
      height: Math.round(height),
      format: format as SidecarFormat,
      byteLength,
      hasAlpha,
      isProgressive,
      sha: headers.get(SIDECAR_HEADERS.Sha.toLowerCase()) ?? '',
      thumbhash: headers.get(SIDECAR_HEADERS.Thumbhash.toLowerCase()) ?? '',
    },
  }
}

function parseFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

// --- Helpers ---

/** Compute the sidecar URL for an image URL. Appends `.prei` to the
 *  pathname, preserves query string. Browsers treat the `.prei` URL
 *  as a separate resource — the underlying image URL is unchanged. */
export function sidecarUrlFor(imageUrl: string): string {
  try {
    const u = new URL(imageUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/')
    u.pathname += SIDECAR_EXTENSION
    return u.toString()
  } catch {
    // Not a parseable URL (bare path?). Fall back to string concat.
    const [path, query] = imageUrl.split('?', 2)
    return (path ?? '') + SIDECAR_EXTENSION + (query !== undefined ? '?' + query : '')
  }
}
