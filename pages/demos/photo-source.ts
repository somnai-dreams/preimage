// Local photos used by the reflow/sizing demos. Source is Midjourney output
// committed at `pages/assets/demos/photos/`; the manifest is generated once
// by `scripts/rename-and-manifest.ts`. Kept local rather than pulled from a
// third-party CDN so demos are deterministic, honest about cache-busting,
// and free of redirect chains.

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

// Relative path so the demos work both under our dev server
// (http://host:port/masonry.html → ./assets/... → /assets/...)
// and under a GitHub Pages project path
// (https://user.github.io/preimage/masonry.html → ./assets/... →
// https://user.github.io/preimage/assets/...).
export function photoUrl(p: Photo, cacheBust: string | null): string {
  const base = `./assets/demos/photos/${p.file}`
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
// the scale demo.
export function cycledUrls(count: number, baseToken: string): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const photo = PHOTOS[i % PHOTOS.length]!
    // Relative — matches photoUrl() so the demos work both under our
    // dev server and under a GitHub Pages project path
    // (https://user.github.io/preimage/...).
    const base = `./assets/demos/photos/${photo.file}`
    out.push(`${base}?v=${baseToken}-${i}`)
  }
  return out
}
