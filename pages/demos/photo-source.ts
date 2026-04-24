// Demo photos used by the reflow/sizing demos. Source is Midjourney
// output committed at `pages/assets/demos/photos/`; the manifest is
// generated once by `scripts/rename-and-manifest.ts`.

import manifest from '../assets/demos/photos/photos.json'

export type Photo = {
  index: number // 1-based
  file: string // e.g. "01.png"
  width: number // natural width in pixels
  height: number // natural height in pixels
}

export const PHOTOS: Photo[] = manifest.map((m, i) => ({
  index: i + 1,
  file: m.file,
  width: m.width,
  height: m.height,
}))

export const PHOTO_COUNT = PHOTOS.length
const GITHUB_PAGES_ASSET_ROOT = 'https://somnai-dreams.github.io/preimage/'
const VERCEL_PHOTO_HOSTS = new Set([
  'preimage.dearlarry.co',
])

// Directory that contains `assets/`, resolved from the current HTML page.
// Demos live at `<root>/foo.html`; bench pages live at `<root>/bench/foo
// .html` — both need `<root>/assets/…` to resolve the same way. Vercel
// deploys use the GitHub Pages copy for photo bytes so static preview
// bandwidth is spent on the app shell, not repeated image fixtures.
// Computed from `document.baseURI` rather than `import.meta.url` so the
// bundler's module flattening doesn't shift the anchor; the HTML path
// always tracks the page's position in the served tree. Cached because it
// never changes within a page.
//
// If a new nested subdirectory of pages/ is ever added alongside `bench/`,
// extend the pop-list below.
let cachedAssetsRoot: string | null = null
function assetsRoot(): string {
  if (cachedAssetsRoot !== null) return cachedAssetsRoot
  const here = new URL(document.baseURI)
  const segs = here.pathname.split('/')
  segs.pop() // drop filename
  if (segs[segs.length - 1] === 'bench') segs.pop()
  segs.push('') // trailing slash
  cachedAssetsRoot = shouldUseGitHubPagesAssets(here)
    ? GITHUB_PAGES_ASSET_ROOT
    : `${here.origin}${segs.join('/')}`
  return cachedAssetsRoot
}

function shouldUseGitHubPagesAssets(here: URL): boolean {
  return here.hostname.endsWith('.vercel.app') || VERCEL_PHOTO_HOSTS.has(here.hostname)
}

// Absolute URL for an asset path like `assets/demos/photos/01.png`. Rooted
// at the current page's effective directory unless the deployment has an
// explicit external photo host.
export function assetUrl(rel: string): string {
  return assetsRoot() + rel
}

export function photoUrl(p: Photo, cacheBust: string | null): string {
  const base = assetUrl(`assets/demos/photos/${p.file}`)
  return cacheBust === null ? base : `${base}?v=${cacheBust}`
}

// Fresh cache-bust token. Because we control the URL space (unlike
// picsum, where the CDN redirects to a fastly hostname that reshuffles
// query params), a simple `?v=<token>` actually forces a new fetch
// against the server that owns the bytes.
export function newCacheBustToken(): string {
  return String(Date.now())
}

// Pick the first N photos. Used by demos that want a deterministic
// subset at the requested count.
export function takePhotos(count: number): Photo[] {
  return PHOTOS.slice(0, Math.min(count, PHOTOS.length))
}

// Scale beyond the 34-photo manifest by cycling and appending a
// per-slot cache-bust token. Each returned URL is unique from the
// browser's perspective (and from our server's) so HTTP cache can't
// collapse them, even though the underlying bytes repeat. Used by
// virtual and benchmark demos.
export function cycledUrls(count: number, baseToken: string): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const photo = PHOTOS[i % PHOTOS.length]!
    const base = assetUrl(`assets/demos/photos/${photo.file}`)
    out.push(`${base}?v=${baseToken}-${i}`)
  }
  return out
}

// Manifest shape as emitted by the `preimage-manifest` CLI: a flat
// `{ [urlPath]: { width, height } }` map. The manifest demo consumes
// this to illustrate build-time hydration without committing a second
// JSON file that could drift from `photos.json`.
export type ManifestEntries = Record<string, { width: number; height: number }>

export function photosManifest(): ManifestEntries {
  const out: ManifestEntries = {}
  for (const p of PHOTOS) {
    out[`/assets/demos/photos/${p.file}`] = { width: p.width, height: p.height }
  }
  return out
}
