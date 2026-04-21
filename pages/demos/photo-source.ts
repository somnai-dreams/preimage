// Shared helper for the reflow-comparison demos: produces picsum.photos
// URLs for real-network comparisons. Each run gets a fresh cache-busting
// token so the browser actually re-fetches — the demo stays honest about
// first-load behavior instead of quietly serving from the HTTP cache on
// subsequent runs.

export type PhotoDescriptor = {
  seed: string
  width: number
  height: number
  caption?: string
}

// Curated seeds with distinct aspect ratios. Stable across runs; fresh
// bytes are forced via a cache-bust query token the browser honors.
export const PICSUM_PHOTOS: PhotoDescriptor[] = [
  { seed: 'preimage-mountain', width: 2560, height: 1707, caption: 'landscape' },
  { seed: 'preimage-portrait', width: 1440, height: 1920, caption: 'portrait' },
  { seed: 'preimage-forest', width: 2560, height: 1707, caption: 'forest' },
  { seed: 'preimage-city', width: 2560, height: 1440, caption: 'cityscape' },
  { seed: 'preimage-arch', width: 1440, height: 1920, caption: 'architecture' },
  { seed: 'preimage-shore', width: 2560, height: 1707, caption: 'shore' },
  { seed: 'preimage-square', width: 2000, height: 2000, caption: 'square' },
  { seed: 'preimage-desert', width: 2560, height: 1707, caption: 'desert' },
]

// Back-compat alias.
export const UNSPLASH_PHOTOS = PICSUM_PHOTOS

export function picsumUrl(p: PhotoDescriptor, cacheBust: string | null): string {
  // picsum ignores unknown query params but the browser keys its cache on
  // the full URL, so when `cacheBust` is set it forces a real network
  // fetch each run. When null, the canonical URL is used and the
  // browser's HTTP cache takes over on subsequent runs.
  const base = `https://picsum.photos/seed/${encodeURIComponent(p.seed)}/${p.width}/${p.height}`
  return cacheBust === null ? base : `${base}?_=${cacheBust}`
}

export function newCacheBustToken(): string {
  return String(Date.now())
}

// --- Offline fallback ---
// Used only when a direct fetch to picsum fails (sandboxed envs, offline,
// broken CORS). Each demo may use this to stand up a Blob URL that still
// carries the right aspect ratio so the layout comparison reads
// correctly even without live photos.

export async function generateFallbackBlob(
  p: PhotoDescriptor,
  hue: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = p.width
  canvas.height = p.height
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, p.width, p.height)
  grad.addColorStop(0, `hsl(${hue} 55% 45%)`)
  grad.addColorStop(0.5, `hsl(${(hue + 20) % 360} 60% 35%)`)
  grad.addColorStop(1, `hsl(${(hue + 200) % 360} 45% 18%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, p.width, p.height)
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `hsla(${(hue + i * 17) % 360}, 55%, 65%, 0.12)`
    ctx.beginPath()
    ctx.arc(
      Math.random() * p.width,
      Math.random() * p.height,
      80 + Math.random() * 240,
      0,
      Math.PI * 2,
    )
    ctx.fill()
  }
  const vign = ctx.createRadialGradient(
    p.width / 2, p.height / 2, Math.min(p.width, p.height) / 3,
    p.width / 2, p.height / 2, Math.max(p.width, p.height) * 0.7,
  )
  vign.addColorStop(0, 'rgba(0,0,0,0)')
  vign.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = vign
  ctx.fillRect(0, 0, p.width, p.height)
  ctx.fillStyle = 'rgba(255,255,255,0.7)'
  ctx.font = `${Math.round(Math.min(p.width, p.height) / 14)}px system-ui`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(p.caption ?? 'photo', p.width / 2, p.height / 2)
  ctx.font = `${Math.round(Math.min(p.width, p.height) / 32)}px system-ui`
  ctx.fillStyle = 'rgba(255,255,255,0.45)'
  ctx.fillText('picsum offline — canvas fallback', p.width / 2, p.height / 2 + Math.min(p.width, p.height) / 11)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b !== null ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      0.82,
    )
  })
}

// Test whether picsum is reachable with a tiny HEAD-ish fetch. Used by
// demos to decide whether to use live URLs or the offline fallback.
export async function picsumReachable(): Promise<boolean> {
  try {
    const res = await fetch(`https://picsum.photos/seed/preimage-probe/16/16?_=${Date.now()}`, {
      mode: 'cors',
      cache: 'no-store',
    })
    return res.ok
  } catch {
    return false
  }
}

// Resolve a photo's URL to use in the demo. When picsum is live, returns
// the cache-busted CDN URL — naive <img src> and preimage prepare() both
// hit the real network. When offline, returns a blob URL for a canvas
// fallback that carries the same aspect ratio.
export async function resolvePhotoUrl(
  p: PhotoDescriptor,
  cacheBust: string | null,
  useLive: boolean,
  hue: number,
): Promise<{ url: string; origin: 'picsum' | 'fallback' }> {
  if (useLive) {
    return { url: picsumUrl(p, cacheBust), origin: 'picsum' }
  }
  const blob = await generateFallbackBlob(p, hue)
  return { url: URL.createObjectURL(blob), origin: 'fallback' }
}

export async function resolvePhotoUrls(
  photos: readonly PhotoDescriptor[],
  cacheBust: string | null,
  useLive: boolean,
): Promise<Array<{ url: string; origin: 'picsum' | 'fallback' }>> {
  return await Promise.all(
    photos.map((p, i) => resolvePhotoUrl(p, cacheBust, useLive, (i * 43) % 360)),
  )
}
