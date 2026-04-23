// Shared stat formatters for the demo stat-grid. Demos display sub-ms
// probe times, KB byte counts, and a handful of refresh/reset helpers
// keyed to the `.row .value b` layout baked into `demo-styles.css`. One
// source of truth so all demos show timings in the same shape — no
// drift between "12ms" / "12.3ms" / "0ms" / "340µs" for the same
// underlying magnitude.

// Sub-ms → µs, under 10ms → one decimal, otherwise whole ms. Nulls
// render as an em-dash so empty rows are visibly distinguishable from
// a real 0. Callers wanting tighter control should format locally.
export function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (ms < 10) return `${ms.toFixed(1)}ms`
  return `${ms.toFixed(0)}ms`
}

// Human-readable bytes. MB with one decimal, KB whole, below that
// straight bytes. Nulls render as em-dash.
export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

// Thousands-separated count.
export function fmtCount(n: number): string {
  return n.toLocaleString()
}

// Write `html` into the `<b>` of the n-th `.row` inside `host`. Rows
// are 1-indexed to match `:nth-child`.
export function setRowValue(host: HTMLElement, nth: number, html: string): void {
  const b = host.querySelector(`.row:nth-child(${nth}) .value b`)
  if (b !== null) b.innerHTML = html
}

// Blank every `.row .value b` inside `host`. Used at the start of a
// fresh run so stale numbers don't linger while the run is in flight.
export function resetStats(host: HTMLElement): void {
  const rows = host.querySelectorAll<HTMLElement>('.row')
  for (const row of rows) {
    const b = row.querySelector('.value b')
    if (b !== null) b.innerHTML = '—'
  }
}
