// Off-main-thread decode pool. `createImageBitmap(blob)` is one of the
// few browser APIs that actually decodes pixels off the main thread —
// the decoded `ImageBitmap` can then be drawn to a canvas in a single
// main-thread blit, with no jank from the decode step itself. For
// image-heavy canvas/WebGL apps (scrubbable timelines, map tiles, photo
// editors), decoding 20+ images off the main thread is the difference
// between a smooth 60fps paint and a 200ms jank spike.
//
// `DecodePool` wraps that API with three things the raw call doesn't
// provide:
//   1. Concurrency cap. Decoding 200 images in parallel starves memory
//      and fights the GC. Default 4.
//   2. LRU cache keyed by source. Re-asking for the same URL returns
//      the cached bitmap (or the in-flight decode promise) instead of
//      decoding twice.
//   3. In-flight dedupe. Two simultaneous `get(url)` calls share one
//      decode.
//
// Bitmaps are retained until evicted by LRU or released by `release(src)`.
// Evicted bitmaps have `close()` called to hand the GPU memory back
// immediately instead of waiting on GC.
//
//   const pool = new DecodePool({ concurrency: 4, maxCacheEntries: 64 })
//   const bitmap = await pool.get('https://.../photo.jpg')
//   ctx.drawImage(bitmap, x, y) // main-thread blit, no decode cost

import { prepare, getElement } from './prepare.js'
import { normalizeSrc } from './analysis.js'

export type DecodePoolOptions = {
  concurrency?: number
  maxCacheEntries?: number
  // Passed straight to createImageBitmap. Most callers leave this alone;
  // set `imageOrientation: 'from-image'` to honor EXIF, or
  // `premultiplyAlpha: 'none'` for WebGL textures.
  imageBitmapOptions?: ImageBitmapOptions
}

type CacheEntry = {
  key: string
  bitmap: ImageBitmap
  size: number // width * height, for LRU-of-pixels heuristics
}

export class DecodePool {
  readonly concurrency: number
  readonly maxCacheEntries: number
  private readonly bitmapOptions: ImageBitmapOptions | undefined

  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<ImageBitmap>>()
  private readonly queue: Array<() => void> = []
  private active = 0
  private generation = 0

  constructor(options: DecodePoolOptions = {}) {
    const c = options.concurrency ?? 4
    if (!Number.isFinite(c) || c < 1) {
      throw new RangeError(`DecodePool: concurrency must be a positive integer, got ${c}.`)
    }
    const m = options.maxCacheEntries ?? 64
    if (!Number.isFinite(m) || m < 1) {
      throw new RangeError(`DecodePool: maxCacheEntries must be a positive integer, got ${m}.`)
    }
    this.concurrency = Math.floor(c)
    this.maxCacheEntries = Math.floor(m)
    this.bitmapOptions = options.imageBitmapOptions
  }

  // Get a decoded bitmap. Returns the cached bitmap if available, or
  // the in-flight decode if one is already running. `prepare()` is run
  // as part of the decode so callers also get the side-effect of a
  // populated measurement cache.
  async get(src: string): Promise<ImageBitmap> {
    const key = normalizeSrc(src)
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      // Refresh LRU: re-insertion moves this to the end of the Map's
      // iteration order.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached.bitmap
    }
    const inflight = this.inflight.get(key)
    if (inflight !== undefined) return inflight

    const generation = this.generation
    const promise = this.runBounded(async () => {
      const bitmap = await this.decode(src)
      if (generation === this.generation) this.store(key, bitmap)
      return bitmap
    })
    this.inflight.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    }
  }

  // Peek without triggering a decode. Useful when painting a frame and
  // you only want to draw bitmaps that are already ready.
  peek(src: string): ImageBitmap | null {
    const key = normalizeSrc(src)
    return this.cache.get(key)?.bitmap ?? null
  }

  // Drop a bitmap and close it. Use this when a tile scrolls far out
  // of view and you want the GPU memory back sooner than LRU would
  // reclaim it.
  release(src: string): boolean {
    const key = normalizeSrc(src)
    const entry = this.cache.get(key)
    if (entry === undefined) return false
    this.cache.delete(key)
    if (typeof entry.bitmap.close === 'function') entry.bitmap.close()
    return true
  }

  // Close every bitmap and clear the cache. In-flight decodes continue
  // to completion but their results are discarded on arrival.
  clear(): void {
    this.generation++
    for (const entry of this.cache.values()) {
      if (typeof entry.bitmap.close === 'function') entry.bitmap.close()
    }
    this.cache.clear()
    this.inflight.clear()
  }

  get cacheSize(): number {
    return this.cache.size
  }

  get inflightCount(): number {
    return this.inflight.size
  }

  private store(key: string, bitmap: ImageBitmap): void {
    // If the cache was cleared while we were decoding, drop this one
    // on the floor — the caller's Promise still resolves, but we don't
    // want the bitmap to linger in the next generation of the cache.
    while (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) break
      const evicted = this.cache.get(oldestKey)!
      this.cache.delete(oldestKey)
      if (typeof evicted.bitmap.close === 'function') evicted.bitmap.close()
    }
    const entry: CacheEntry = {
      key,
      bitmap,
      size: bitmap.width * bitmap.height,
    }
    this.cache.set(key, entry)
  }

  private async decode(src: string): Promise<ImageBitmap> {
    if (typeof createImageBitmap !== 'function') {
      throw new Error('preimage: DecodePool requires createImageBitmap support.')
    }
    // Route through prepare() so the measurement cache gets populated
    // and we can reuse its warmed <img> element — createImageBitmap
    // accepts HTMLImageElement, so once the img's own load completes
    // we can decode directly from it. One fetch total.
    const prepared = await prepare(src)
    const img = getElement(prepared)
    if (img !== null) {
      if (!img.complete) {
        await new Promise<void>((resolve, reject) => {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener(
            'error',
            () => reject(new Error(`preimage: DecodePool load failed for ${src}.`)),
            { once: true },
          )
        })
      }
      return this.bitmapOptions !== undefined
        ? await createImageBitmap(img, this.bitmapOptions)
        : await createImageBitmap(img)
    }
    // Fallback for the cases where prepare() doesn't hand back an
    // element (URL-pattern shortcut, dimsOnly, synthetic measurements):
    // fetch the bytes ourselves.
    const response = await fetch(src)
    if (!response.ok) {
      throw new Error(`preimage: DecodePool fetch failed for ${src} (${response.status}).`)
    }
    const blob = await response.blob()
    return this.bitmapOptions !== undefined
      ? await createImageBitmap(blob, this.bitmapOptions)
      : await createImageBitmap(blob)
  }

  private async runBounded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) {
      this.active++
      try {
        return await fn()
      } finally {
        this.active--
        const next = this.queue.shift()
        if (next !== undefined) next()
      }
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next !== undefined) next()
    }
  }
}
