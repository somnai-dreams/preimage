// Warm the browser HTTP cache with every photo in the manifest. Lets
// demo runs start from steady-state instead of first-load. Each URL is
// fetched via `new Image()`; once `load` fires we drop the reference
// and let GC reclaim the bitmap. The browser HTTP cache keeps the
// bytes regardless.
//
// Runs on every demo page via its own <script type="module">. No
// effect unless a `#warmCdn` button exists in the DOM.

import manifest from '../assets/demos/photos-manifest.json'

const urls = Object.keys(manifest).map((key) => `.${key}`)

const btn = document.getElementById('warmCdn') as HTMLButtonElement | null
if (btn !== null) {
  btn.addEventListener('click', () => {
    void warm(btn)
  })
}

async function warm(btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent ?? 'Warm CDN'
  btn.disabled = true
  btn.classList.remove('done')
  let done = 0
  btn.textContent = `Warming 0/${urls.length}…`

  const t0 = performance.now()
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const img = new Image()
          const finish = (): void => {
            done++
            btn.textContent = `Warming ${done}/${urls.length}…`
            resolve()
          }
          img.addEventListener('load', finish, { once: true })
          img.addEventListener('error', finish, { once: true })
          img.src = url
        }),
    ),
  )
  const ms = Math.round(performance.now() - t0)
  btn.classList.add('done')
  btn.textContent = `Warmed · ${ms}ms`
  btn.disabled = false

  // Revert to the idle label after a moment so a repeat warm can be
  // triggered without the stale timing hanging around.
  setTimeout(() => {
    btn.textContent = original
    btn.classList.remove('done')
  }, 3000)
}
