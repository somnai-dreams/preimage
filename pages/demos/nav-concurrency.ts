// Nav-level concurrency knob for demos. Persists the user's preferred
// PrepareQueue concurrency in localStorage, injects a <select> into
// the demo nav (between the Warm CDN button and the GitHub link).
// Demos import `getConcurrency()` and pass it when constructing their
// queues — changes take effect on the next Run, not mid-flight.

const STORAGE_KEY = 'preimage-concurrency'
const OPTIONS = [6, 20, 50, 100, 200]
const DEFAULT = 50

/** Read the user's currently-selected concurrency. Call at the top of
 *  each demo's run-function so the latest nav value is picked up. */
export function getConcurrency(): number {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT
}

// --- Nav injection ---

const nav = document.querySelector<HTMLElement>('.demo-nav')
const warmBtn = document.getElementById('warmCdn')
if (nav !== null) {
  const label = document.createElement('label')
  label.className = 'concurrency-knob'
  label.title = 'PrepareQueue concurrency. 6 ≈ HTTP/1.1; 50 is the H2 sweet spot; 100+ maxes a fast H2 CDN.'

  const text = document.createElement('span')
  text.textContent = 'Concurrency'
  label.appendChild(text)

  const select = document.createElement('select')
  const current = getConcurrency()
  for (const n of OPTIONS) {
    const opt = document.createElement('option')
    opt.value = String(n)
    opt.textContent = String(n)
    if (n === current) opt.selected = true
    select.appendChild(opt)
  }
  select.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEY, select.value)
  })
  label.appendChild(select)

  // Insert before the Warm CDN button if present, else before .gh.
  const anchor = warmBtn ?? nav.querySelector('.gh')
  if (anchor !== null) nav.insertBefore(label, anchor)
  else nav.appendChild(label)

  // Also inject a "benchmarks" link so the bench pages are reachable
  // from any demo nav without editing every HTML file.
  if (nav.querySelector('a[href$="/bench/"]') === null) {
    const benchLink = document.createElement('a')
    benchLink.href = './bench/'
    benchLink.textContent = 'benchmarks'
    if (anchor !== null) nav.insertBefore(benchLink, label)
    else nav.appendChild(benchLink)
  }
}
