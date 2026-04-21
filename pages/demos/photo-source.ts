// Shared helper for the reflow-comparison demos: load a real photo from
// picsum.photos (when the network allows) or fall back to a locally-
// generated canvas Blob at the same aspect ratio. Every demo uses this
// so all panels start from the same Blob set — the comparison stays
// fair even when the network isn't available.
//
// We use picsum.photos rather than images.unsplash.com directly because
// picsum serves photos with open CORS, exact-dimension URLs, and stable
// seeded results. (Direct Unsplash URLs require an API key and don't
// always honor requested dimensions.)

export type PhotoDescriptor = {
  seed: string // picsum seed — same seed always returns the same photo
  width: number
  height: number
  caption?: string
}

// Curated seeds with distinct aspect ratios so the masonry packer has
// variety to work with. Seeds are stable: reloading the demo returns
// the same photos.
export const PICSUM_PHOTOS: PhotoDescriptor[] = [
  { seed: 'preimage-mountain', width: 1600, height: 1067, caption: 'landscape' },
  { seed: 'preimage-portrait', width: 1200, height: 1600, caption: 'portrait' },
  { seed: 'preimage-forest', width: 1800, height: 1200, caption: 'forest' },
  { seed: 'preimage-city', width: 1600, height: 900, caption: 'cityscape' },
  { seed: 'preimage-arch', width: 1000, height: 1400, caption: 'architecture' },
  { seed: 'preimage-shore', width: 1500, height: 1000, caption: 'shore' },
  { seed: 'preimage-square', width: 1400, height: 1400, caption: 'square' },
  { seed: 'preimage-desert', width: 1800, height: 1200, caption: 'desert' },
]

// Back-compat alias for any older demo still importing the Unsplash name.
export const UNSPLASH_PHOTOS = PICSUM_PHOTOS

function picsumUrl(p: PhotoDescriptor): string {
  return `https://picsum.photos/seed/${encodeURIComponent(p.seed)}/${p.width}/${p.height}`
}

// Canvas fallback: paint something photo-like (gradient + bokeh + vignette)
// at the exact aspect ratio. Used when picsum isn't reachable.
async function generateFallback(
  width: number,
  height: number,
  hue: number,
  caption: string,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, width, height)
  grad.addColorStop(0, `hsl(${hue} 55% 45%)`)
  grad.addColorStop(0.5, `hsl(${(hue + 20) % 360} 60% 35%)`)
  grad.addColorStop(1, `hsl(${(hue + 200) % 360} 45% 18%)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `hsla(${(hue + i * 17) % 360}, 55%, 65%, 0.12)`
    ctx.beginPath()
    ctx.arc(Math.random() * width, Math.random() * height, 80 + Math.random() * 240, 0, Math.PI * 2)
    ctx.fill()
  }
  const vign = ctx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) / 3,
    width / 2, height / 2, Math.max(width, height) * 0.7,
  )
  vign.addColorStop(0, 'rgba(0,0,0,0)')
  vign.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = vign
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.font = `${Math.round(Math.min(width, height) / 14)}px system-ui`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(caption, width / 2, height / 2)
  ctx.font = `${Math.round(Math.min(width, height) / 28)}px system-ui`
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillText('(picsum offline — canvas fallback)', width / 2, height / 2 + Math.min(width, height) / 10)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b !== null ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      0.82,
    )
  })
}

export type LoadedPhoto = {
  blob: Blob
  origin: 'picsum' | 'fallback'
}

export async function loadPhoto(
  p: PhotoDescriptor,
  fallbackHue: number,
): Promise<LoadedPhoto> {
  try {
    const res = await fetch(picsumUrl(p), { mode: 'cors' })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const blob = await res.blob()
    return { blob, origin: 'picsum' }
  } catch {
    const blob = await generateFallback(
      p.width,
      p.height,
      fallbackHue,
      p.caption ?? 'photo',
    )
    return { blob, origin: 'fallback' }
  }
}

export async function loadPhotos(
  photos: readonly PhotoDescriptor[],
): Promise<LoadedPhoto[]> {
  return await Promise.all(
    photos.map((p, i) => loadPhoto(p, (i * 43) % 360)),
  )
}

// When the live picsum URL is reachable the network provides its own
// transfer latency — the demo shows reality. When the fallback path is
// used (picsum blocked, offline, CI sandbox), the blob is already in
// memory and decodes in a couple of ms, collapsing the frame-before-
// image story into a single tick. This helper returns a sensible
// simulated delay so the demo reads correctly either way.
export function latencyFor(loaded: readonly LoadedPhoto[]): number {
  const anyLive = loaded.some((l) => l.origin === 'picsum')
  return anyLive ? 0 : 600
}
