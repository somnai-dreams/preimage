// Small helpers shared across the reflow-comparison demos.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Count visible layout shifts on a panel by observing its height changes.
// Simpler and more reliable for these demos than the Layout Instability
// API: PerformanceObserver's layout-shift entries batch within a frame
// and its source-attribution filters out shifts whose node set doesn't
// overlap the panel — and browsers disagree on what populates sources.
// Height deltas on the panel's inner grid/container reflect the exact
// shifts a viewer would notice: images loading at natural size push the
// panel height outward, each push is a shift.
export type ShiftMonitor = {
  shifts: () => number
  stop: () => void
}

export function observeShifts(panel: HTMLElement): ShiftMonitor {
  let shifts = 0
  let lastHeight = panel.getBoundingClientRect().height
  const observer = new ResizeObserver(() => {
    const h = panel.getBoundingClientRect().height
    if (Math.abs(h - lastHeight) > 0.5) {
      shifts++
      lastHeight = h
    }
  })
  observer.observe(panel)
  return {
    shifts: () => shifts,
    stop: () => observer.disconnect(),
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

// Wire up a latency slider that lives in the demo's control bar. Returns
// a getter the demo calls at the start of each run to pick up the
// current slider value.
export type LatencyControl = {
  read: () => number
}

export function wireLatencySlider(
  sliderId: string,
  valueId: string,
  defaultMs: number,
): LatencyControl {
  const slider = document.getElementById(sliderId) as HTMLInputElement | null
  const valueEl = document.getElementById(valueId)
  if (slider === null || valueEl === null) {
    return { read: () => defaultMs }
  }
  slider.value = String(defaultMs)
  valueEl.textContent = `${defaultMs}ms`
  slider.addEventListener('input', () => {
    valueEl.textContent = `${slider.value}ms`
  })
  return { read: () => Number(slider.value) }
}
