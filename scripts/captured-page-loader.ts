import { prepare } from '../packages/preimage/src/prepare.ts'

type CaptureMode = 'control' | 'preimage'

type LoaderConfig = {
  mode: CaptureMode
  probeTimeoutMs: number
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
  id: string
  url: string
  above: boolean
  discoveredMs: number
  loadMs: number | null
  errorMs: number | null
  naturalWidth: number
  naturalHeight: number
  probe: ProbeSnapshot | null
  appliedMs: number | null
}

type ClientReport = {
  mode: CaptureMode
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

type FinishOptions = {
  probeSettleMs: number
}

type ImageRecord = {
  id: string
  element: HTMLImageElement
  url: string
  above: boolean
  discoveredMs: number
  loadMs: number | null
  errorMs: number | null
  probe: ProbeSnapshot | null
  appliedMs: number | null
}

declare global {
  interface Window {
    __PREIMAGE_CAPTURED_CONFIG__?: LoaderConfig
    __preimageCapturedBench?: {
      finish(options: FinishOptions): Promise<ClientReport>
    }
  }
}

const config = window.__PREIMAGE_CAPTURED_CONFIG__
if (config !== undefined) install(config)

function install(config: LoaderConfig): void {
  const records = new Map<string, ImageRecord>()
  const pendingProbePromises = new Set<Promise<ProbeSnapshot>>()
  let scanScheduled = false

  const perf = installPerformanceObservers()

  function elapsed(): number {
    return performance.now()
  }

  function targetUrl(img: HTMLImageElement): string | null {
    const raw = img.dataset.preimageCapturedSrc
    if (raw === undefined || raw.length === 0) return null
    if (raw.startsWith('/__preimage_asset/')) return `${location.origin}${raw}`
    try {
      return new URL(raw, document.baseURI).href
    } catch {
      return null
    }
  }

  function trackImage(img: HTMLImageElement): void {
    const id = img.dataset.preimageCapturedId
    if (id === undefined || records.has(id)) return
    const url = targetUrl(img)
    if (url === null) return

    const record: ImageRecord = {
      id,
      element: img,
      url,
      above: img.dataset.preimageCapturedAbove === '1',
      discoveredMs: elapsed(),
      loadMs: null,
      errorMs: null,
      probe: null,
      appliedMs: null,
    }
    records.set(id, record)

    img.addEventListener('load', () => {
      if (record.loadMs === null) record.loadMs = elapsed()
    }, true)
    img.addEventListener('error', () => {
      if (record.errorMs === null) record.errorMs = elapsed()
    }, true)

    if (config.mode === 'preimage') startProbe(record)
    startNativeLoad(record)
  }

  function startNativeLoad(record: ImageRecord): void {
    const img = record.element
    img.loading = 'eager'
    img.decoding = 'async'
    img.src = record.url
    if (img.complete && img.naturalWidth > 0 && record.loadMs === null) record.loadMs = elapsed()
  }

  function restorePassiveImage(img: HTMLImageElement): void {
    if (img.dataset.preimageCapturedPassive !== '1') return
    const url = targetUrl(img)
    if (url === null) return
    img.dataset.preimageCapturedPassive = 'loaded'
    img.src = url
  }

  function startProbe(record: ImageRecord): void {
    const startedMs = elapsed()
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), config.probeTimeoutMs)
    const promise = prepare(record.url, {
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

    pendingProbePromises.add(promise)
    void promise.then((result) => {
      record.probe = result
      if (result.ok) applyDimensions(record, result.width, result.height)
    })
  }

  function applyDimensions(record: ImageRecord, width: number, height: number): void {
    const img = record.element
    if (!img.isConnected) return
    img.style.aspectRatio = `${width} / ${height}`
    record.appliedMs = elapsed()
  }

  function scanImages(): void {
    for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img[data-preimage-captured-passive="1"]'))) {
      restorePassiveImage(img)
    }
    for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img[data-preimage-captured-target="1"]'))) {
      trackImage(img)
    }
  }

  function scheduleScan(): void {
    if (scanScheduled) return
    scanScheduled = true
    requestAnimationFrame(() => {
      scanScheduled = false
      scanImages()
    })
  }

  async function waitForProbeIdle(maxMs: number): Promise<void> {
    const deadline = performance.now() + maxMs
    for (;;) {
      if (pendingProbePromises.size === 0) return
      const remaining = deadline - performance.now()
      if (remaining <= 0) return
      await Promise.race([
        Promise.allSettled(Array.from(pendingProbePromises)),
        new Promise((resolve) => window.setTimeout(resolve, Math.min(remaining, 100))),
      ])
    }
  }

  function summarizeImage(record: ImageRecord): ImageSnapshot {
    const img = record.element
    return {
      id: record.id,
      url: record.url,
      above: record.above,
      discoveredMs: record.discoveredMs,
      loadMs: record.loadMs,
      errorMs: record.errorMs,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      probe: record.probe,
      appliedMs: record.appliedMs,
    }
  }

  const observer = new MutationObserver(() => scheduleScan())
  observer.observe(document.documentElement ?? document, { subtree: true, childList: true })
  scanImages()
  document.addEventListener('DOMContentLoaded', scanImages, { once: true })

  window.__preimageCapturedBench = {
    async finish(options: FinishOptions): Promise<ClientReport> {
      scanImages()
      await waitForProbeIdle(options.probeSettleMs)
      scanImages()
      observer.disconnect()
      return {
        mode: config.mode,
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
