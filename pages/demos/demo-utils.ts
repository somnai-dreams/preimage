// Shared timing + shift-observation helpers for the reflow demos.

import { getMeasurement, type PreparedImage } from '../../src/index.js'

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

// Poll the measurement cache for `dominantColor` to appear. The lib
// populates the field asynchronously after `prepare({ extractDominantColor:
// true })` drains the stream — demos that want to paint the color need a
// way to wait for it. Resolves null if the timeout elapses or extraction
// failed (missing createImageBitmap, cross-origin canvas taint, etc).
export function waitForDominantColor(
  prepared: PreparedImage,
  opts: { timeout?: number } = {},
): Promise<string | null> {
  const deadline = performance.now() + (opts.timeout ?? 3000)
  return new Promise((resolve) => {
    const tick = (): void => {
      const color = getMeasurement(prepared).dominantColor
      if (color !== undefined) {
        resolve(color)
        return
      }
      if (performance.now() >= deadline) {
        resolve(null)
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

// Convenience: waits for the dominant color and paints it as the
// target element's background-color. Returns the painted color, or
// null if extraction didn't land in time.
export async function paintDominantColorBehind(
  prepared: PreparedImage,
  el: HTMLElement,
  opts?: { timeout?: number },
): Promise<string | null> {
  const color = await waitForDominantColor(prepared, opts)
  if (color !== null) el.style.backgroundColor = color
  return color
}

// Per-panel status: queued / running / done. Renders a small pill into
// the panel header replacing the existing badge, and toggles a
// `is-queued` class on the panel root so CSS can dim the panel while
// it's waiting its turn. Sequential demos use this to make the
// wait-then-run order obvious.
export type PanelStatus = 'queued' | 'running' | 'done'

export function setPanelStatus(panel: HTMLElement, status: PanelStatus, label?: string): void {
  panel.classList.toggle('is-queued', status === 'queued')
  const header = panel.querySelector<HTMLElement>('.panel-header')
  if (header === null) return
  let pill = header.querySelector<HTMLElement>('.panel-status')
  if (pill === null) {
    // Insert the pill after the existing kind-badge (reflow/stable)
    // so both sit together on the right of the header.
    pill = document.createElement('span')
    pill.className = 'panel-status'
    header.appendChild(pill)
  }
  pill.className = `panel-status ${status}`
  pill.textContent = label ?? defaultStatusLabel(status)
}

export function clearPanelStatus(panel: HTMLElement): void {
  panel.classList.remove('is-queued')
  const pill = panel.querySelector<HTMLElement>('.panel-status')
  if (pill !== null) pill.remove()
}

function defaultStatusLabel(status: PanelStatus): string {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'running'
  return 'done'
}
