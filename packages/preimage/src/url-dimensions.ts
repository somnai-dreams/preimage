// URL pattern parsers that extract intrinsic image dimensions directly
// from the URL, so `prepare()` can skip the network entirely. Many
// CDNs encode dimensions in their URL schemes:
//
//   Cloudinary:  .../image/upload/w_400,h_300/public_id
//   Shopify:     .../files/photo_400x300.jpg
//   Picsum:      .../800/600 or .../seed/<seed>/800/600
//   Unsplash:    ...?w=400&h=300
//
// Registering the appropriate parser turns measurement into
// microsecond string parsing instead of a network roundtrip. Parsers
// must be confident — a wrong answer means laying out at the wrong
// aspect ratio and distorting the image. Built-ins scope by hostname;
// use `queryParamDimensionParser` to register a custom per-domain
// matcher for setups the built-ins don't cover.

export type UrlDimensions = { width: number; height: number }

export type UrlDimensionParser = (url: string) => UrlDimensions | null

const parsers: UrlDimensionParser[] = []

// Register a parser. Parsers are tried in registration order; first
// non-null, valid result wins. Returns an unregister function.
export function registerUrlDimensionParser(parser: UrlDimensionParser): () => void {
  parsers.push(parser)
  return () => {
    const i = parsers.indexOf(parser)
    if (i >= 0) parsers.splice(i, 1)
  }
}

export function clearUrlDimensionParsers(): void {
  parsers.length = 0
}

// Try each registered parser; return the first valid result, or null.
export function parseUrlDimensions(url: string): UrlDimensions | null {
  for (const parser of parsers) {
    let result: UrlDimensions | null
    try {
      result = parser(url)
    } catch {
      result = null
    }
    if (result !== null && isValidDims(result)) return result
  }
  return null
}

function isValidDims(d: UrlDimensions): boolean {
  return (
    Number.isFinite(d.width) &&
    Number.isFinite(d.height) &&
    d.width > 0 &&
    d.height > 0
  )
}

// --- Built-in vendor parsers ---

/** Return `dims` only when they pass the valid-dims predicate.
 *  Every vendor parser threads its candidate match through this
 *  so individual parsers stay robust when called directly —
 *  `parseUrlDimensions` already filters, but exported parsers get
 *  called standalone by consumers writing custom pipelines. */
function validated(width: number, height: number): UrlDimensions | null {
  const dims = { width, height }
  return isValidDims(dims) ? dims : null
}

// Cloudinary: https://res.cloudinary.com/<account>/image/upload/<transforms>/<public_id>
// Transforms are slash- or comma-separated; both w_<n> and h_<n> must
// appear for a confident match.
export const cloudinaryParser: UrlDimensionParser = (url) => {
  if (!url.includes('res.cloudinary.com/')) return null
  const wMatch = url.match(/(?:^|[/,])w_(\d+)(?:[,/]|$)/)
  const hMatch = url.match(/(?:^|[/,])h_(\d+)(?:[,/]|$)/)
  if (wMatch === null || hMatch === null) return null
  return validated(Number(wMatch[1]), Number(hMatch[1]))
}

// Shopify CDN: https://cdn.shopify.com/.../<name>_<W>x<H>.<ext>
// Shopify universally serves from cdn.shopify.com; the _WxH suffix
// appears before the file extension or another underscore-delimited
// modifier.
export const shopifyParser: UrlDimensionParser = (url) => {
  if (!url.includes('cdn.shopify.com/')) return null
  const m = url.match(/_(\d+)x(\d+)(?:\.|_|@|\?|$)/)
  if (m === null) return null
  return validated(Number(m[1]), Number(m[2]))
}

// Picsum: https://picsum.photos/<W>/<H> or /seed/<seed>/<W>/<H>
// Terminating with `/`, `?`, or end-of-string avoids matching
// downstream path segments.
export const picsumParser: UrlDimensionParser = (url) => {
  if (!url.includes('picsum.photos/')) return null
  const m = url.match(/picsum\.photos\/(?:[^/?#]+\/[^/?#]+\/)?(\d+)\/(\d+)(?:[/?#]|$)/)
  if (m === null) return null
  return validated(Number(m[1]), Number(m[2]))
}

// Unsplash images: https://images.unsplash.com/photo-...?w=400&h=300
// Both w and h must be declared as query params; w-only responses get
// auto-height and can't be resolved from the URL alone.
export const unsplashParser: UrlDimensionParser = (url) => {
  if (!url.includes('images.unsplash.com/')) return null
  return extractQueryDims(url, 'w', 'h')
}

// Generic query-param parser. Useful for imgix, Next/image, Cloudflare
// Images, custom CDNs — any setup where a single site encodes
// dimensions in predictable query keys. Supply a domain predicate and
// the key names to look up.
export function queryParamDimensionParser(
  domainPredicate: (url: string) => boolean,
  widthKey: string,
  heightKey: string,
): UrlDimensionParser {
  return (url: string) => {
    if (!domainPredicate(url)) return null
    return extractQueryDims(url, widthKey, heightKey)
  }
}

function extractQueryDims(url: string, wKey: string, hKey: string): UrlDimensions | null {
  const queryStart = url.indexOf('?')
  if (queryStart < 0) return null
  const params = new URLSearchParams(url.slice(queryStart + 1))
  const w = params.get(wKey)
  const h = params.get(hKey)
  if (w === null || h === null) return null
  return validated(Number(w), Number(h))
}

// Convenience: register every vendor parser the library ships with.
// Returns an unregister function that removes only what this call
// added, leaving any user-registered parsers intact.
export function registerCommonUrlDimensionParsers(): () => void {
  const unregs = [
    registerUrlDimensionParser(cloudinaryParser),
    registerUrlDimensionParser(shopifyParser),
    registerUrlDimensionParser(picsumParser),
    registerUrlDimensionParser(unsplashParser),
  ]
  return () => {
    for (const u of unregs) u()
  }
}
