import { prepare } from '../packages/preimage/src/prepare.ts'

type BenchMode = 'control' | 'probe' | 'apply'
type ProbeScope = 'unknown' | 'all'
type ApplyShape = 'aspect-ratio' | 'attrs' | 'both'
type ImageScope = 'page' | 'viewport'

type ClientConfig = {
  mode: BenchMode
  probeScope: ProbeScope
  applyShape: ApplyShape
  imageScope: ImageScope
  probeTimeoutMs: number
}

type FinishOptions = {
  probeSettleMs: number
}

type RectSnapshot = {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  inViewport: boolean
}

type ProbeSnapshot =
  | {
      ok: true
      startedMs: number
      endedMs: number
      durationMs: number
      width: number
      height: number
      source: string
      byteLength: number | null
    }
  | {
      ok: false
      startedMs: number
      endedMs: number
      durationMs: number
      errorName: string
      errorMessage: string
    }

type ImageSnapshot = {
  id: number
  url: string
  discoveredMs: number
  hadDeclaredGeometry: boolean
  hadWidthAttr: boolean
  hadHeightAttr: boolean
  hadInlineAspectRatio: boolean
  hadCssAspectRatio: boolean
  initialRect: RectSnapshot
  finalRect: RectSnapshot
  loadMs: number | null
  errorMs: number | null
  complete: boolean
  naturalWidth: number
  naturalHeight: number
  probe: ProbeSnapshot | null
  appliedMs: number | null
}

type ClientReport = {
  mode: BenchMode
  href: string
  title: string
  userAgent: string
  durationMs: number
  images: ImageSnapshot[]
  performance: {
    cls: number
    layoutShifts: Array<{ startTime: number; value: number }>
    firstPaintMs: number | null
    firstContentfulPaintMs: number | null
    largestContentfulPaintMs: number | null
    longTaskCount: number
    longTaskTotalMs: number
  }
}

type ImageRecord = {
  id: number
  element: HTMLImageElement
  url: string
  discoveredMs: number
  hadDeclaredGeometry: boolean
  hadWidthAttr: boolean
  hadHeightAttr: boolean
  hadInlineAspectRatio: boolean
  hadCssAspectRatio: boolean
  initialRect: RectSnapshot
  loadMs: number | null
  errorMs: number | null
  probe: ProbeSnapshot | null
  appliedMs: number | null
}

type ProbeTask = {
  startedMs: number
  promise: Promise<ProbeSnapshot>
}

declare global {
  interface Window {
    __PREIMAGE_FULL_PAGE_BENCH_CONFIG__?: ClientConfig
    __preimageFullPageBench?: {
      finish(options: FinishOptions): Promise<ClientReport>
    }
  }
}

const config = window.__PREIMAGE_FULL_PAGE_BENCH_CONFIG__
if (config !== undefined) install(config)

function install(config: ClientConfig): void {
  const imageIds = new WeakMap<HTMLImageElement, number>()
  const listenedImages = new WeakSet<HTMLImageElement>()
  const records = new Map<number, ImageRecord>()
  const probeByUrl = new Map<string, ProbeTask>()
  const pendingProbePromises = new Set<Promise<ProbeSnapshot>>()
  let nextImageId = 1
  let scanScheduled = false

  const perf = installPerformanceObservers()

  function elapsed(): number {
    return performance.now()
  }

  function imageUrl(img: HTMLImageElement): string | null {
    const raw = img.currentSrc || img.src
    if (raw.length === 0) return null
    try {
      return new URL(raw, document.baseURI).href
    } catch {
      return null
    }
  }

  function rectSnapshot(img: HTMLImageElement): RectSnapshot {
    const rect = img.getBoundingClientRect()
    const inViewport =
      rect.width > 0 &&
      rect.bottom >= 0 &&
      rect.right > 0 &&
      rect.top <= window.innerHeight &&
      rect.left < window.innerWidth
    const visible =
      inViewport &&
      rect.width > 0 &&
      rect.height > 0
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visible,
      inViewport,
    }
  }

  function positiveAttr(img: HTMLImageElement, name: 'width' | 'height'): boolean {
    const raw = img.getAttribute(name)
    if (raw === null) return false
    const value = Number(raw)
    return Number.isFinite(value) && value > 0
  }

  function hasInlineAspectRatio(img: HTMLImageElement): boolean {
    return img.style.aspectRatio.trim() !== ''
  }

  function hasCssAspectRatio(img: HTMLImageElement): boolean {
    const inline = hasInlineAspectRatio(img)
    if (inline) return true
    const value = getComputedStyle(img).aspectRatio.trim()
    return value !== '' && value !== 'auto' && value !== 'auto auto'
  }

  function makeRecord(img: HTMLImageElement, url: string): ImageRecord {
    const hadWidthAttr = positiveAttr(img, 'width')
    const hadHeightAttr = positiveAttr(img, 'height')
    const hadInlineAspectRatio = hasInlineAspectRatio(img)
    const hadCssAspectRatio = hasCssAspectRatio(img)
    return {
      id: nextImageId++,
      element: img,
      url,
      discoveredMs: elapsed(),
      hadDeclaredGeometry: (hadWidthAttr && hadHeightAttr) || hadCssAspectRatio,
      hadWidthAttr,
      hadHeightAttr,
      hadInlineAspectRatio,
      hadCssAspectRatio,
      initialRect: rectSnapshot(img),
      loadMs: null,
      errorMs: null,
      probe: null,
      appliedMs: null,
    }
  }

  function shouldProbe(record: ImageRecord): boolean {
    if (config.mode !== 'probe' && config.mode !== 'apply') return false
    if (config.imageScope === 'viewport' && !record.initialRect.inViewport) return false
    return config.probeScope === 'all' || !record.hadDeclaredGeometry
  }

  function trackImage(img: HTMLImageElement): void {
    const url = imageUrl(img)
    if (url === null) return

    const existingId = imageIds.get(img)
    const existing = existingId === undefined ? undefined : records.get(existingId)
    if (existing !== undefined && existing.url === url) {
      if (img.complete && img.naturalWidth > 0 && existing.loadMs === null) existing.loadMs = elapsed()
      return
    }

    const record = makeRecord(img, url)
    imageIds.set(img, record.id)
    records.set(record.id, record)

    if (!listenedImages.has(img)) {
      listenedImages.add(img)
      img.addEventListener('load', () => {
        const id = imageIds.get(img)
        if (id === undefined) return
        const current = records.get(id)
        if (current !== undefined && current.loadMs === null) current.loadMs = elapsed()
      }, true)
      img.addEventListener('error', () => {
        const id = imageIds.get(img)
        if (id === undefined) return
        const current = records.get(id)
        if (current !== undefined && current.errorMs === null) current.errorMs = elapsed()
      }, true)
    }

    if (img.complete && img.naturalWidth > 0) record.loadMs = elapsed()
    if (shouldProbe(record)) attachProbe(record)
  }

  function scanImages(): void {
    for (const img of Array.from(document.images)) trackImage(img)
  }

  function scheduleScan(): void {
    if (scanScheduled) return
    scanScheduled = true
    requestAnimationFrame(() => {
      scanScheduled = false
      scanImages()
    })
  }

  function probeUrl(url: string): ProbeTask {
    const existing = probeByUrl.get(url)
    if (existing !== undefined) return existing

    const startedMs = elapsed()
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), config.probeTimeoutMs)
    const promise = prepare(url, {
      dimsOnly: true,
      strategy: 'auto',
      fallbackToImgOnFetchError: true,
      signal: controller.signal,
    }).then<ProbeSnapshot>(
      (prepared) => {
        const endedMs = elapsed()
        return {
          ok: true,
          startedMs,
          endedMs,
          durationMs: endedMs - startedMs,
          width: prepared.width,
          height: prepared.height,
          source: prepared.source,
          byteLength: prepared.byteLength,
        }
      },
      (err: unknown) => {
        const endedMs = elapsed()
        const e = err instanceof Error ? err : new Error(String(err))
        return {
          ok: false,
          startedMs,
          endedMs,
          durationMs: endedMs - startedMs,
          errorName: e.name,
          errorMessage: e.message,
        }
      },
    ).finally(() => {
      window.clearTimeout(timer)
      pendingProbePromises.delete(promise)
    })

    const task = { startedMs, promise }
    probeByUrl.set(url, task)
    pendingProbePromises.add(promise)
    return task
  }

  function attachProbe(record: ImageRecord): void {
    const task = probeUrl(record.url)
    void task.promise.then((result) => {
      record.probe = result
      if (config.mode === 'apply' && result.ok && !record.hadDeclaredGeometry) {
        applyDimensions(record, result.width, result.height)
      }
    })
  }

  function applyDimensions(record: ImageRecord, width: number, height: number): void {
    const img = record.element
    if (!img.isConnected) return
    if (config.applyShape === 'aspect-ratio' || config.applyShape === 'both') {
      img.style.aspectRatio = `${width} / ${height}`
    }
    if (config.applyShape === 'attrs' || config.applyShape === 'both') {
      if (!record.hadWidthAttr) img.setAttribute('width', String(Math.round(width)))
      if (!record.hadHeightAttr) img.setAttribute('height', String(Math.round(height)))
    }
    record.appliedMs = elapsed()
  }

  async function waitForProbeIdle(maxMs: number): Promise<void> {
    const deadline = performance.now() + maxMs
    for (;;) {
      if (pendingProbePromises.size === 0) return
      const remaining = deadline - performance.now()
      if (remaining <= 0) return
      const current = Array.from(pendingProbePromises)
      await Promise.race([
        Promise.allSettled(current),
        new Promise((resolve) => window.setTimeout(resolve, Math.min(remaining, 100))),
      ])
    }
  }

  function summarizeImage(record: ImageRecord): ImageSnapshot {
    const img = record.element
    return {
      id: record.id,
      url: record.url,
      discoveredMs: record.discoveredMs,
      hadDeclaredGeometry: record.hadDeclaredGeometry,
      hadWidthAttr: record.hadWidthAttr,
      hadHeightAttr: record.hadHeightAttr,
      hadInlineAspectRatio: record.hadInlineAspectRatio,
      hadCssAspectRatio: record.hadCssAspectRatio,
      initialRect: record.initialRect,
      finalRect: rectSnapshot(img),
      loadMs: record.loadMs,
      errorMs: record.errorMs,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      probe: record.probe,
      appliedMs: record.appliedMs,
    }
  }

  const observer = new MutationObserver(() => scheduleScan())
  observer.observe(document.documentElement ?? document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'sizes', 'style', 'class'],
  })

  scanImages()
  document.addEventListener('DOMContentLoaded', scanImages, { once: true })
  window.addEventListener('load', scanImages, { once: true })

  window.__preimageFullPageBench = {
    async finish(options: FinishOptions): Promise<ClientReport> {
      scanImages()
      await waitForProbeIdle(options.probeSettleMs)
      scanImages()
      observer.disconnect()
      return {
        mode: config.mode,
        href: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        durationMs: elapsed(),
        images: Array.from(records.values()).map(summarizeImage),
        performance: perf.snapshot(),
      }
    },
  }
}

function installPerformanceObservers(): { snapshot: () => ClientReport['performance'] } {
  let cls = 0
  const layoutShifts: Array<{ startTime: number; value: number }> = []
  let firstPaintMs: number | null = null
  let firstContentfulPaintMs: number | null = null
  let largestContentfulPaintMs: number | null = null
  let longTaskCount = 0
  let longTaskTotalMs = 0

  function observe(type: string, callback: (entry: PerformanceEntry) => void): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) callback(entry)
      })
      observer.observe({ type, buffered: true })
    } catch {
      // Some entry types are browser/version gated.
    }
  }

  observe('paint', (entry) => {
    if (entry.name === 'first-paint') firstPaintMs = entry.startTime
    if (entry.name === 'first-contentful-paint') firstContentfulPaintMs = entry.startTime
  })

  observe('largest-contentful-paint', (entry) => {
    largestContentfulPaintMs = entry.startTime
  })

  observe('layout-shift', (entry) => {
    const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }
    if (shift.hadRecentInput === true) return
    const value = shift.value ?? 0
    cls += value
    layoutShifts.push({ startTime: entry.startTime, value })
  })

  observe('longtask', (entry) => {
    longTaskCount++
    longTaskTotalMs += entry.duration
  })

  return {
    snapshot: () => ({
      cls,
      layoutShifts,
      firstPaintMs,
      firstContentfulPaintMs,
      largestContentfulPaintMs,
      longTaskCount,
      longTaskTotalMs,
    }),
  }
}
