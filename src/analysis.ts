// Image analysis: given an image source (URL, data URL, blob URL, or raw
// byte-prefix header), classify format, detect animation hints, parse declared
// dimensions from the source when present, and chunk heterogeneous gallery
// inputs into a normalized item stream for the row packer.
//
// This is the image analog of pretext's text analysis pass:
//   - segmenting: images are the atomic segments; a hard "gap" or "break" is
//     carried alongside as a break kind, just like pretext's space/hard-break.
//   - normalization: we normalize the declared source string (trim fragments
//     out of `#foo` anchors, collapse duplicate whitespace in srcset-ish lists)
//     so the cache keys stay stable.
//   - classification: we derive a lightweight format hint from extension /
//     data-URL mime / magic-byte prefix to drive downstream decoding choices.
//
// Analysis is pure and synchronous. The asynchronous part — actually loading
// bytes and asking the browser for `naturalWidth`/`naturalHeight` — lives in
// `measurement.ts`, so callers can drive their own load scheduling.

export type ImageFormat =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'avif'
  | 'svg'
  | 'bmp'
  | 'ico'
  | 'apng'
  | 'heic'
  | 'unknown'

export type SourceKind = 'http' | 'data' | 'blob' | 'relative' | 'unknown'

// Parallels pretext's SegmentBreakKind. An `image` is the atomic renderable
// (a word, in pretext), `gap` is a collapsible caption/spacer slot (a space),
// and `break` is an unconditional row break (a hard newline).
export type ItemBreakKind = 'image' | 'gap' | 'break'

export type ImageAnalysis = {
  src: string // the normalized source string used as a cache key
  rawSrc: string // the original, un-normalized source string
  format: ImageFormat
  sourceKind: SourceKind
  isVector: boolean // svg or (in theory) pdf — never needs raster upscaling
  isAnimated: boolean | null // null = unknown; true = gif/apng/animated webp heuristic
  hasAlpha: boolean | null // null = unknown; heuristic only
  declaredWidth: number | null // parsed from ?w=... or intrinsic hints; layout uses this if measurement is skipped
  declaredHeight: number | null
  aspectHint: number | null // width/height if both declared
}

export type AnalysisChunk = {
  // Precompiled contiguous run of items separated by hard breaks. Mirrors
  // pretext's `AnalysisChunk` that splits text on `\n`.
  startIndex: number
  endIndex: number // exclusive
}

export type GalleryAnalysis = {
  items: ImageAnalysis[]
  kinds: ItemBreakKind[] // one per item, parallel to items
  chunks: AnalysisChunk[] // hard-break delimited runs
  len: number
}

// --- Format detection ---

const EXT_FORMAT: Record<string, ImageFormat> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jfif: 'jpeg',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
  svg: 'svg',
  bmp: 'bmp',
  ico: 'ico',
  apng: 'apng',
  heic: 'heic',
  heif: 'heic',
}

const DATA_MIME_FORMAT: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/apng': 'apng',
  'image/heic': 'heic',
  'image/heif': 'heic',
}

const vectorFormats: ReadonlySet<ImageFormat> = new Set(['svg'])
const animatedOnlyFormats: ReadonlySet<ImageFormat> = new Set(['gif', 'apng'])
const alphaCapableFormats: ReadonlySet<ImageFormat> = new Set([
  'png',
  'webp',
  'avif',
  'svg',
  'gif',
  'apng',
  'ico',
  'heic',
])

export function detectImageFormat(src: string): ImageFormat {
  if (src.length === 0) return 'unknown'

  if (src.startsWith('data:')) {
    const semi = src.indexOf(';')
    const comma = src.indexOf(',')
    const end = semi === -1 ? comma : semi
    if (end <= 5) return 'unknown'
    const mime = src.slice(5, end).toLowerCase()
    return DATA_MIME_FORMAT[mime] ?? 'unknown'
  }

  // Strip the query and fragment before asking about the extension. Otherwise
  // CDN query params (e.g. `?v=3`) mask the real extension.
  let cleanEnd = src.length
  const q = src.indexOf('?')
  if (q !== -1) cleanEnd = Math.min(cleanEnd, q)
  const h = src.indexOf('#')
  if (h !== -1) cleanEnd = Math.min(cleanEnd, h)
  const cleaned = src.slice(0, cleanEnd)

  const dot = cleaned.lastIndexOf('.')
  if (dot === -1) return 'unknown'
  const ext = cleaned.slice(dot + 1).toLowerCase()
  return EXT_FORMAT[ext] ?? 'unknown'
}

export function detectSourceKind(src: string): SourceKind {
  if (src.length === 0) return 'unknown'
  if (src.startsWith('data:')) return 'data'
  if (src.startsWith('blob:')) return 'blob'
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//')) return 'http'
  return 'relative'
}

// --- Source normalization ---

export function normalizeSrc(src: string): string {
  // Trim the URL fragment: it never affects what bytes the browser fetches,
  // so keying caches on it would balloon memory for identical assets.
  if (src.startsWith('data:')) return src
  const hash = src.indexOf('#')
  if (hash === -1) return src
  return src.slice(0, hash)
}

// --- Declared dimension parsing ---

// Pretext reads declared font/line-height out of the `font` shorthand. For
// images, callers often encode their chosen display size in the URL itself via
// `?w=320&h=200` (CDN imgix/cloudinary conventions) or as HTML attributes on
// the source element. `analyzeImage` folds both in.

type DeclaredHints = {
  width?: number | null
  height?: number | null
}

const WIDTH_PARAM_KEYS = ['w', 'width', 'max-width', 'maxw', 'cw', 'tr:w']
const HEIGHT_PARAM_KEYS = ['h', 'height', 'max-height', 'maxh', 'ch', 'tr:h']

function parsePositiveNumber(v: string | null): number | null {
  if (v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function readDeclaredFromQuery(src: string): DeclaredHints {
  const q = src.indexOf('?')
  if (q === -1) return {}
  const query = src.slice(q + 1).split('#')[0] ?? ''
  if (query.length === 0) return {}

  let width: number | null = null
  let height: number | null = null

  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = decodeURIComponent(pair.slice(0, eq)).toLowerCase()
    const value = decodeURIComponent(pair.slice(eq + 1))
    if (width === null && WIDTH_PARAM_KEYS.includes(key)) {
      width = parsePositiveNumber(value)
    } else if (height === null && HEIGHT_PARAM_KEYS.includes(key)) {
      height = parsePositiveNumber(value)
    }
    if (width !== null && height !== null) break
  }

  // imgix/cloudinary also support combined `tr=w-320,h-200` style tokens.
  // Only probe if the plain params didn't yield anything.
  if (width === null && height === null) {
    const trMatch = query.match(/(?:^|&)tr=([^&#]+)/i)
    if (trMatch !== null) {
      const parts = trMatch[1]!.split(',')
      for (const part of parts) {
        const [key, value] = part.split('-')
        if (key === undefined || value === undefined) continue
        const n = parsePositiveNumber(value)
        if (n === null) continue
        if (key === 'w') width = width ?? n
        else if (key === 'h') height = height ?? n
      }
    }
  }

  return { width, height }
}

export function analyzeImage(rawSrc: string, declared?: DeclaredHints): ImageAnalysis {
  const src = normalizeSrc(rawSrc)
  const format = detectImageFormat(src)
  const sourceKind = detectSourceKind(src)

  const parsedDeclared = readDeclaredFromQuery(rawSrc)
  const declaredWidth = declared?.width ?? parsedDeclared.width ?? null
  const declaredHeight = declared?.height ?? parsedDeclared.height ?? null
  let aspectHint: number | null = null
  if (
    declaredWidth !== null &&
    declaredHeight !== null &&
    declaredWidth > 0 &&
    declaredHeight > 0
  ) {
    aspectHint = declaredWidth / declaredHeight
  }

  const isVector = vectorFormats.has(format)
  const hasAlpha = alphaCapableFormats.has(format) ? (format === 'jpeg' ? false : null) : false

  // For `gif` and `apng` we can assume animation is possible but not guaranteed.
  // We expose `null` for "unknown" in the public type rather than assuming.
  const isAnimated = animatedOnlyFormats.has(format) ? null : format === 'webp' ? null : false

  return {
    src,
    rawSrc,
    format,
    sourceKind,
    isVector,
    isAnimated,
    hasAlpha,
    declaredWidth,
    declaredHeight,
    aspectHint,
  }
}

// --- Gallery-level analysis ---

export type GalleryItemInput =
  | string // plain src, treated as an image
  | {
      src: string
      declaredWidth?: number
      declaredHeight?: number
      break?: 'normal' | 'before' | 'after' | 'never'
      gapBefore?: boolean // insert a gap slot before this image
    }

function normalizeItemInput(input: GalleryItemInput): {
  analysis: ImageAnalysis
  hardBreakBefore: boolean
  hardBreakAfter: boolean
  gapBefore: boolean
} {
  if (typeof input === 'string') {
    return {
      analysis: analyzeImage(input),
      hardBreakBefore: false,
      hardBreakAfter: false,
      gapBefore: false,
    }
  }
  const br = input.break
  return {
    analysis: analyzeImage(input.src, {
      width: input.declaredWidth ?? null,
      height: input.declaredHeight ?? null,
    }),
    hardBreakBefore: br === 'before',
    hardBreakAfter: br === 'after',
    gapBefore: input.gapBefore === true,
  }
}

export function analyzeGallery(inputs: readonly GalleryItemInput[]): GalleryAnalysis {
  const items: ImageAnalysis[] = []
  const kinds: ItemBreakKind[] = []
  const chunks: AnalysisChunk[] = []

  let chunkStart = 0

  function closeChunk(upTo: number): void {
    if (upTo > chunkStart) chunks.push({ startIndex: chunkStart, endIndex: upTo })
    chunkStart = upTo
  }

  for (let i = 0; i < inputs.length; i++) {
    const normalized = normalizeItemInput(inputs[i]!)

    if (normalized.hardBreakBefore && items.length > 0) {
      items.push(normalized.analysis) // keep the item itself
      kinds.push('break')
      closeChunk(items.length - 1)
      kinds[kinds.length - 1] = 'image'
      continue
    }

    if (normalized.gapBefore && items.length > 0) {
      items.push(normalized.analysis)
      kinds.push('gap')
      continue
    }

    items.push(normalized.analysis)
    kinds.push('image')

    if (normalized.hardBreakAfter) {
      closeChunk(items.length)
    }
  }

  closeChunk(items.length)

  return { items, kinds, chunks, len: items.length }
}

// --- Utility predicates used by the row packer ---

export function isHardBreak(kind: ItemBreakKind): boolean {
  return kind === 'break'
}

export function isGap(kind: ItemBreakKind): boolean {
  return kind === 'gap'
}

export function isAtomicImage(kind: ItemBreakKind): boolean {
  return kind === 'image'
}

// --- Caches ---
// Pretext maintains a tiny per-locale segmenter cache. Our analog is per-source
// cached ImageAnalysis, since computing format+query parsing is cheap but
// called for every gallery item on every re-render.

const analysisCache = new Map<string, ImageAnalysis>()

export function getCachedAnalysis(src: string): ImageAnalysis {
  const key = normalizeSrc(src)
  let cached = analysisCache.get(key)
  if (cached === undefined) {
    cached = analyzeImage(src)
    analysisCache.set(key, cached)
  }
  return cached
}

export function clearAnalysisCaches(): void {
  analysisCache.clear()
}
