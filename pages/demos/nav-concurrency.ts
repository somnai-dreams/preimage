// Nav-level knobs for demos. Persists the user's preferred
// PrepareQueue concurrency and probe strategy in localStorage, injects
// two <select>s into the demo nav (between the Warm CDN button and the
// GitHub link). Demos import `getConcurrency()` / `getStrategy()` and
// pass them when constructing their queues or calling prepare() —
// changes take effect on the next Run, not mid-flight.

import { clearOriginStrategyCache } from '@somnai-dreams/preimage'

const CONCURRENCY_KEY = 'preimage-concurrency'
const CONCURRENCY_OPTIONS = [6, 20, 50, 100, 200]
const CONCURRENCY_DEFAULT = 50

const STRATEGY_KEY = 'preimage-strategy'
const STRATEGY_OPTIONS = ['auto', 'img', 'stream', 'range'] as const
const STRATEGY_DEFAULT: ProbeStrategy = 'auto'

export type ProbeStrategy = 'auto' | 'img' | 'stream' | 'range'

/** Read the user's currently-selected concurrency. Call at the top of
 *  each demo's run-function so the latest nav value is picked up. */
export function getConcurrency(): number {
  const raw = localStorage.getItem(CONCURRENCY_KEY)
  if (raw === null) return CONCURRENCY_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : CONCURRENCY_DEFAULT
}

/** Read the user's currently-selected probe strategy. Passed straight
 *  to `prepare()` or `PrepareQueue.enqueue()` as `{ strategy }`. Blob
 *  sources ignore it. `'auto'` (default) lets preimage pick per-origin:
 *  first probe tries `'range'`; 206 → stay on range, 200 → cache as
 *  `'stream'` for that origin. */
export function getStrategy(): ProbeStrategy {
  const raw = localStorage.getItem(STRATEGY_KEY)
  if (raw === 'auto' || raw === 'img' || raw === 'stream' || raw === 'range') return raw
  return STRATEGY_DEFAULT
}

// --- Nav injection ---

function makeKnob(
  labelText: string,
  title: string,
  options: readonly (string | number)[],
  current: string,
  onChange: (value: string) => void,
): HTMLLabelElement {
  const label = document.createElement('label')
  label.className = 'concurrency-knob'
  label.title = title

  const text = document.createElement('span')
  text.textContent = labelText
  label.appendChild(text)

  const select = document.createElement('select')
  for (const opt of options) {
    const o = document.createElement('option')
    o.value = String(opt)
    o.textContent = String(opt)
    if (o.value === current) o.selected = true
    select.appendChild(o)
  }
  select.addEventListener('change', () => onChange(select.value))
  label.appendChild(select)
  return label
}

const nav = document.querySelector<HTMLElement>('.demo-nav')
const warmBtn = document.getElementById('warmCdn')
if (nav !== null) {
  const concurrencyKnob = makeKnob(
    'Concurrency',
    'PrepareQueue concurrency. 6 ≈ HTTP/1.1; 50 is the H2 sweet spot; 100+ maxes a fast H2 CDN.',
    CONCURRENCY_OPTIONS,
    String(getConcurrency()),
    (v) => localStorage.setItem(CONCURRENCY_KEY, v),
  )
  const strategyKnob = makeKnob(
    'Strategy',
    'prepare() probe strategy. img polls <img>.naturalWidth; stream reads fetch() body and aborts at header; range requests just the header bytes.',
    STRATEGY_OPTIONS,
    getStrategy(),
    (v) => {
      localStorage.setItem(STRATEGY_KEY, v)
      // Wipe the per-origin auto-discovery cache on every change so
      // auto rediscovers from scratch next run. Belt-and-suspenders
      // with the library-side fix (explicit strategies no longer write
      // to the cache) — guarantees a clean state even if the cache
      // was already populated by a prior auto run the user now wants
      // to re-probe.
      clearOriginStrategyCache()
    },
  )

  // Insert before the Warm CDN button if present, else before .gh.
  const anchor = warmBtn ?? nav.querySelector('.gh')
  if (anchor !== null) {
    nav.insertBefore(concurrencyKnob, anchor)
    nav.insertBefore(strategyKnob, anchor)
  } else {
    nav.appendChild(concurrencyKnob)
    nav.appendChild(strategyKnob)
  }

  // Also inject the URL speed lab so it is reachable from older demo
  // navs without editing every HTML file.
  if (nav.querySelector('a[href$="url-speed.html"]') === null) {
    const speedLink = document.createElement('a')
    speedLink.href = './url-speed.html'
    speedLink.textContent = 'URL speed'
    if (anchor !== null) nav.insertBefore(speedLink, anchor)
    else nav.appendChild(speedLink)
  }

  // Also inject a "benchmarks" link so the bench pages are reachable
  // from any demo nav without editing every HTML file.
  if (nav.querySelector('a[href$="/bench/"]') === null) {
    const benchLink = document.createElement('a')
    benchLink.href = './bench/'
    benchLink.textContent = 'benchmarks'
    if (anchor !== null) nav.insertBefore(benchLink, concurrencyKnob)
    else nav.appendChild(benchLink)
  }
}
