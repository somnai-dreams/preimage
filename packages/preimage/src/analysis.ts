// Image analysis: given a source string (URL, data URL, blob URL), classify
// format, detect vector vs raster, and parse any dimensions the caller
// encoded into the URL itself (imgix/cloudinary conventions). Cheap,
// synchronous, cached by normalized source.
//
// This is the image analog of pretext's text analysis pass, but much smaller:
// images don't segment the way text does, and most of the hard-won text
// analysis work (Intl.Segmenter, grapheme widths, kinsoku, emoji correction)
// has no equivalent here. The bulk of image-specific measurement lives in
// `measurement.ts`; this module just feeds it stable cache keys and a
// declared-dimension fast path for SSR.

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

export type ImageAnalysis = {
  src: string // normalized source, used as the cache key
  rawSrc: string // original, un-normalized source
  format: ImageFormat
  sourceKind: SourceKind
  isVector: boolean
  declaredWidth: number | null // parsed from ?w=... / ?width=... / imgix tr=w-...
  declaredHeight: number | null
  aspectHint: number | null
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

export function normalizeSrc(src: string): string {
  if (src.startsWith('data:')) return src
  const hash = src.indexOf('#')
  if (hash === -1) return src
  return src.slice(0, hash)
}

// --- Declared dimension parsing ---

const WIDTH_PARAM_KEYS = ['w', 'width', 'max-width', 'maxw', 'cw']
const HEIGHT_PARAM_KEYS = ['h', 'height', 'max-height', 'maxh', 'ch']

function parsePositiveNumber(v: string | null): number | null {
  if (v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function readDeclaredFromQuery(src: string): { width: number | null; height: number | null } {
  const q = src.indexOf('?')
  if (q === -1) return { width: null, height: null }
  const query = src.slice(q + 1).split('#')[0] ?? ''
  if (query.length === 0) return { width: null, height: null }

  let width: number | null = null
  let height: number | null = null
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = decodeURIComponent(pair.slice(0, eq)).toLowerCase()
    const value = decodeURIComponent(pair.slice(eq + 1))
    if (width === null && WIDTH_PARAM_KEYS.includes(key)) width = parsePositiveNumber(value)
    else if (height === null && HEIGHT_PARAM_KEYS.includes(key)) height = parsePositiveNumber(value)
    if (width !== null && height !== null) break
  }

  if (width === null && height === null) {
    const trMatch = query.match(/(?:^|&)tr=([^&#]+)/i)
    if (trMatch !== null) {
      for (const part of trMatch[1]!.split(',')) {
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

// --- Public analysis ---

export function analyzeImage(
  rawSrc: string,
  declared?: { width?: number | null; height?: number | null },
): ImageAnalysis {
  const src = normalizeSrc(rawSrc)
  const format = detectImageFormat(src)
  const sourceKind = detectSourceKind(src)
  const parsedDeclared = readDeclaredFromQuery(rawSrc)
  const declaredWidth = declared?.width ?? parsedDeclared.width ?? null
  const declaredHeight = declared?.height ?? parsedDeclared.height ?? null
  const aspectHint =
    declaredWidth !== null &&
    declaredHeight !== null &&
    declaredWidth > 0 &&
    declaredHeight > 0
      ? declaredWidth / declaredHeight
      : null
  return {
    src,
    rawSrc,
    format,
    sourceKind,
    isVector: vectorFormats.has(format),
    declaredWidth,
    declaredHeight,
    aspectHint,
  }
}

// --- Caches ---

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
