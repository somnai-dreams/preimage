// Shared helper for the reflow-comparison demos: load a real photo from
// Unsplash (when the network allows it) or fall back to a locally-generated
// canvas Blob that mimics the same aspect ratio. All demos use this so
// every panel starts from the same Blob set — the comparison stays fair
// even when the network isn't available.

export type PhotoDescriptor = {
  slug: string // Unsplash photo id
  width: number
  height: number
  caption?: string
}

// Curated Unsplash photos with stable IDs. Each aspect ratio is distinct
// so the masonry packer has variety to work with. Using fixed IDs means
// demos look the same across runs when online.
export const UNSPLASH_PHOTOS: PhotoDescriptor[] = [
  { slug: 'JmVaNyemtN8', width: 1600, height: 1067, caption: 'mountain lake' },
  { slug: 'sNr_MitXwQY', width: 1200, height: 1600, caption: 'portrait figure' },
  { slug: 'FV3GConVSss', width: 1800, height: 1200, caption: 'autumn forest' },
  { slug: 'DqgMHzeio7Q', width: 1600, height: 900, caption: 'cityscape' },
  { slug: 'T87DV5FvtEE', width: 1000, height: 1400, caption: 'architecture' },
  { slug: 'B8A7wFrGCIY', width: 1500, height: 1000, caption: 'ocean shore' },
  { slug: 'gKXKBY-C-Dk', width: 1400, height: 1400, caption: 'square still' },
  { slug: '4hbJ-eymZ1o', width: 1800, height: 1200, caption: 'desert' },
]

function unsplashUrl(slug: string, width: number): string {
  // `&q=80` keeps the file small enough to stream quickly while still
  // looking like a real photo on the screen.
  return `https://images.unsplash.com/photo-${slug}?w=${width}&q=80&auto=format&fit=crop`
}

// Canvas fallback: paint something photo-like (gradient + noise + vignette)
// that keeps the exact aspect ratio. Used when Unsplash isn't reachable.
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
  // Large soft blobs to feel like bokeh.
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `hsla(${(hue + i * 17) % 360}, 55%, 65%, 0.12)`
    ctx.beginPath()
    ctx.arc(Math.random() * width, Math.random() * height, 80 + Math.random() * 240, 0, Math.PI * 2)
    ctx.fill()
  }
  // Vignette.
  const vign = ctx.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) / 3,
    width / 2, height / 2, Math.max(width, height) * 0.7,
  )
  vign.addColorStop(0, 'rgba(0,0,0,0)')
  vign.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = vign
  ctx.fillRect(0, 0, width, height)
  // Caption stamp.
  ctx.fillStyle = 'rgba(255,255,255,0.75)'
  ctx.font = `${Math.round(Math.min(width, height) / 14)}px system-ui`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(caption, width / 2, height / 2)
  ctx.font = `${Math.round(Math.min(width, height) / 28)}px system-ui`
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.fillText('(Unsplash offline fallback)', width / 2, height / 2 + Math.min(width, height) / 10)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b !== null ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      0.82,
    )
  })
}

// Load one photo. Tries Unsplash first; if the fetch fails (CORS, offline,
// host_not_allowed in sandboxed contexts), generates a canvas-based
// fallback at the same aspect ratio.
export async function loadPhoto(
  p: PhotoDescriptor,
  renderWidth: number,
  fallbackHue: number,
): Promise<{ blob: Blob; origin: 'unsplash' | 'fallback' }> {
  try {
    const res = await fetch(unsplashUrl(p.slug, renderWidth), { mode: 'cors' })
    if (!res.ok) throw new Error(`status ${res.status}`)
    const blob = await res.blob()
    return { blob, origin: 'unsplash' }
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
  renderWidth: number,
): Promise<Array<{ blob: Blob; origin: 'unsplash' | 'fallback' }>> {
  return await Promise.all(
    photos.map((p, i) => loadPhoto(p, renderWidth, (i * 43) % 360)),
  )
}
