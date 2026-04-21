// Small helpers shared across the reflow-comparison demos.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Track real Cumulative Layout Shift, scoped to a single panel. Uses the
// Layout Instability API (`PerformanceObserver` with type 'layout-shift'),
// which reports spec-defined CLS values with per-entry `sources` node
// references. We attribute an entry to the panel if any source node is
// descendant of that panel.
export type ShiftMonitor = {
  cls: () => number // the accumulated layout-shift value for this panel
  stop: () => void
}

export function observeLayoutShifts(panel: HTMLElement): ShiftMonitor {
  let cls = 0
  // Some browsers (Safari < 17) still don't expose 'layout-shift'. Fall
  // back gracefully so the demo still runs; cls just stays at 0.
  if (typeof PerformanceObserver === 'undefined') {
    return { cls: () => cls, stop: () => {} }
  }
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // LayoutShift is not in the standard PerformanceEntry lib types yet.
        const shift = entry as PerformanceEntry & {
          value: number
          hadRecentInput: boolean
          sources?: Array<{ node?: Node | null }>
        }
        if (shift.hadRecentInput) continue
        const sources = shift.sources
        if (sources !== undefined && sources.length > 0) {
          let attributed = false
          for (const s of sources) {
            if (s.node !== null && s.node !== undefined && panel.contains(s.node)) {
              attributed = true
              break
            }
          }
          if (!attributed) continue
        }
        cls += shift.value
      }
    })
    observer.observe({ type: 'layout-shift', buffered: true })
  } catch {
    // 'layout-shift' entryType not supported; silent no-op.
  }
  return {
    cls: () => cls,
    stop: () => observer?.disconnect(),
  }
}

// Assign a blob URL to an img element after a simulated network delay.
// Returns a promise that resolves when the image has finished decoding.
export async function loadImgWithLatency(
  img: HTMLImageElement,
  blob: Blob,
  latencyMs: number,
): Promise<void> {
  if (latencyMs > 0) await sleep(latencyMs)
  const url = URL.createObjectURL(blob)
  return await new Promise<void>((resolve) => {
    const done = (): void => {
      img.classList.add('loaded')
      resolve()
    }
    if (img.complete && img.naturalWidth > 0) done()
    else img.onload = done
    img.src = url
  })
}
