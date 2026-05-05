# Development

Managed with [Bun](https://bun.sh). Node + `npm` also work for type-check + build.

## Setup

```sh
bun install
# or
npm install
```

## Commands

```sh
bun run check           # run tsc type-check (no emit)
bun run check:all       # run offline regression harnesses
bun run build:package   # build packages/preimage/dist/ (ESM + .d.ts)
bun run build:layout-algebra
bun run build:all
bun run build:demos     # static demo + bench output in dist-demos/
bun start               # run the demo site locally on port 3000
bun run bench:remote-loading  # browser sweep against hosted demo photos
```

## Preview deploys (Vercel)

`vercel.json` at the repo root configures Vercel for static-output deploys: `bun install --frozen-lockfile`, `bun run check && bun run build:demos:vercel`, serve `dist-demos/`. The existing GitHub Pages deploy (main only) keeps working alongside Vercel previews — they're independent.

One-time setup (~5 min):

1. Sign in to <https://vercel.com> and import the `somnai-dreams/preimage` repo.
2. Vercel auto-detects `vercel.json`. No build settings to override.
3. Production branch: `main`. Every other branch + PR gets a unique preview URL like `swing-1-preimage-sidecar--preimage.vercel.app`.
4. Pushes update the preview within ~1 minute.

Static deploys work for the demo and bench pages that run entirely in the browser. Pages that depend on `pages/server.ts` endpoints need a matching static build step or an edge/API endpoint before they can deploy as plain files.

Vercel previews redirect `/assets/demos/photos/*` to the GitHub Pages deployment, and the demo runtime chooses that same asset root on `*.vercel.app` and `preimage.dearlarry.co`. `build:demos:vercel` also removes the heavy photo fixtures from `dist-demos` after the normal build. The demos can still be bandwidth-heavy, but Vercel only serves the app shell and redirect responses instead of uploading or serving the image fixtures.

## Layout

| file | role |
|---|---|
| `packages/preimage/src/analysis.ts` | format / declared-dim / normalized-src analysis |
| `packages/preimage/src/measurement.ts` | shared measurement cache records |
| `packages/preimage/src/probe.ts` | DOM-free byte parsers for PNG/JPEG/GIF/BMP/WebP/SVG/AVIF/HEIC/APNG/ICO |
| `packages/preimage/src/prepare.ts` | single-image `prepare()` / `layout()` / `disposePreparedImage()` |
| `packages/preimage/src/prepare-queue.ts` | adaptive queueing, boost/deprioritize, option-aware dedupe |
| `packages/preimage/src/decode-pool.ts` | off-main-thread bitmap decode cache |
| `packages/preimage/src/virtual.ts` | DOM-recycled virtual tile pool + mounted-work priority helpers |
| `packages/preimage/src/loading.ts` | gallery image scheduling and `Gallery.done` orchestration |
| `packages/preimage/src/predict.ts` | scroll prediction baselines for virtual pre-render experiments |
| `packages/preimage/src/manifest.ts` | build-time dimension manifest builder + CLI |
| `packages/preimage/src/pretext-*.ts` | pretext float and inline integrations |
| `packages/layout-algebra/src/index.ts` | DOM-free packers, cursors, visibility, first-screen estimates |
| `pages/demos/virtual.ts` | reference consumer for async image work + DOM recycling + rAF-batched render |

## Remote loading sweeps

`bun run bench:remote-loading` starts a temporary local page, drives Chromium with Playwright, and loads the hosted demo photos from `https://somnai-dreams.github.io/preimage/assets/demos/photos/*.png`. It is not a demo bench: it lives under `scripts/` so it can serve as a local strategy sweep while still exercising real browser image requests.

The default local run compares `visible-first`, `queued`, `after-layout`, and `immediate` with remote cache-busted URLs, scripted scroll, render-concurrency counts, first-image/done timings, and visible pending-tile ratios. It uses the library's default render caps unless `--render-concurrency` is passed. The browser does a tiny ranged warmup plus one untimed one-image app warmup before timed strategy runs, records those warmups in saved JSON, and repeated sweeps alternate strategy order so the first strategy does not pay connection/cache setup alone. The default `check:all` stays offline so CI and routine local checks do not spend hosted image bandwidth. To deliberately include the small remote pass, run `PREIMAGE_CHECK_REMOTE_LOADING=1 bun run check:all`; tune larger experiments with flags such as:

```sh
bun run bench:remote-loading -- --runs 3 --n 68 --strategies visible-first,queued
```

## Full-page loading probes

`bun run bench:full-page` opens real websites in Chromium and injects a document-start shim that can observe image geometry, run preimage dimension probes, and optionally apply probed dimensions to unknown-size `<img>` elements. This is for the "does probing help inside a whole page load?" question: other scripts, CSS, fonts, API calls, native lazy loading, and the browser network scheduler all stay in play.

```sh
bun run bench:full-page -- --url https://example.com --modes control,probe,apply
```

Modes:

- `control` observes image and performance timing without probing.
- `probe` calls `prepare(url, { dimsOnly: true, fallbackToImgOnFetchError: true })` for matching images and records success/failure/timing.
- `apply` does the same probe, then applies the found shape to missing-geometry images with `style.aspectRatio` by default.

Useful flags:

```sh
bun run bench:full-page -- \
  --urls-file ./wild-pages.txt \
  --runs 3 \
  --scroll-distance 2400 \
  --scroll-ms 1200 \
  --probe-scope unknown \
  --image-scope page \
  --apply-shape aspect-ratio \
  --record-har-dir .tmp/full-page-hars
```

For an above-the-fold pass, target only images that are in the viewport when first discovered and skip scripted scrolling:

```sh
bun run bench:full-page -- \
  --url https://www.apple.com/ \
  --modes control,apply \
  --wait-until commit \
  --image-scope viewport \
  --no-save
```

For a visual browser pass, add `--headed --inspect-ms 5000`. The same URL opens once per mode, so use a single page and one or two modes while eyeballing:

```sh
bun run bench:full-page -- \
  --url https://www.apple.com/ \
  --modes control,apply \
  --wait-until commit \
  --image-scope viewport \
  --headed \
  --inspect-ms 5000 \
  --no-save
```

The report is saved under `benchmarks/full-page-loading-*.json` unless `--no-save` is passed. Treat these as explicit, environment-shaped benchmarks, not CI truth. The useful columns are missing-geometry image counts, `firstDims`, `aboveDims`, `aboveImgs`, `allDims`, `allImgs`, CLS, LCP, image bytes, and Range-fetch bytes. `*Dims` is when dimensions became known by either a successful preimage probe or native image load. `*Imgs` is native image load only. If a site needs real product integration, write a site adapter after this generic shim proves the page is worth studying.

### Captured-page replay

`bench:full-page` is a live shim: it arrives after the page's own image strategy has already started. To test the proper integration shape, use `bench:captured-page`: capture the rendered document once, freeze third-party scripts, rewrite missing-geometry target images so they start inert, and replay two local variants:

- `control` restores each target image's `src` at document start.
- `preimage` restores the same `src` and runs a same-origin preimage dimension probe in parallel through the local fixture proxy.

```sh
bun run bench:captured-page -- capture \
  --url https://www.ikea.com/us/en/ \
  --name ikea-us \
  --target-scope viewport

bun run bench:captured-page -- run \
  --fixture benchmarks/captured-pages/ikea-us \
  --modes control,preimage \
  --runs 3 \
  --no-save
```

Captured fixtures contain `source.html`, `control.html`, `preimage.html`, and `manifest.json`. The replay server proxies captured image URLs back through `http://127.0.0.1` so Range probes are same-origin and measure the integration path instead of browser CORS policy. Target images start inert; non-target images still load through the same proxy so the page keeps surrounding image-load pressure without live-site variance. Replay blocks external non-document requests because scripts are frozen. Use this when the question is "does a controlled, preimage-aware loader get dimensions before native image load?" rather than "can a late browser shim patch a random site?"

Replay runs start with a cold `control` warmup by default, then measure three warm repeats per mode in seeded random order and print warm-only averages. This warms connection state through Chromium, the local proxy, and the origin without using cached image bytes; the fixture still sends `no-store` and disables Chromium cache so the measured comparison stays about earlier dimensions, not already-cached images. Pass `--seed` to reproduce a run order, `--order fixed` when debugging a specific sequence, and `--no-warmup-control` only when deliberately measuring the first cold page load.

Good captured-page candidates are not polished commercial homepages. Start with pages where real-user CLS is already poor, then check whether missing image geometry is a plausible cause before capturing. CrUX can find origins with poor field CLS, PageSpeed Insights or Lighthouse can flag pages with unsized image elements, and the final proof is still this harness: `control` should shift while target images are unresolved, and `preimage` should move `aboveDims` earlier without pretending images loaded faster.

## Coverage Matrix

Every public value export and package subpath is assigned to an automated owner in `scripts/coverage-matrix-test.ts`. `bun run check:all` runs that matrix first, so adding a public API without a regression or benchmark surface fails locally and in CI. The human-readable policy lives in `docs/benchmark-regression-matrix.md`.

`check:all` also ends with `benchmark-regression-test.ts`. It reads the JSON files emitted by the preceding offline harnesses and checks them against `benchmarks/baselines/check-all-regression-baselines.json`; per-run files stay ignored, but the baseline thresholds are committed.

## Dependencies

- `@chenglou/pretext` is a `peerDependency`. The main entry does not import it; only the `packages/preimage/src/pretext-*.ts` modules do. Callers that don't use the pretext integration do not need pretext installed.

## Releasing

```sh
npm version patch
npm publish --access public
```
