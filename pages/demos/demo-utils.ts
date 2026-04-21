// Shared timing + shift-observation helpers for the reflow demos.

export type ShiftMonitor = {
  shifts: () => number
  stop: () => void
}

// Count visible layout shifts on a container by watching height deltas.
// Start the monitor AFTER the synchronous DOM setup has completed so the
// clear+append that happens between runs doesn't inflate the count; only
// async image-load-driven changes should register.
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
