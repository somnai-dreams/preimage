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
bun run check:all       # run all regression harnesses
bun run build:package   # build packages/preimage/dist/ (ESM + .d.ts)
bun run build:layout-algebra
bun run build:all
bun run build:demos     # static demo + bench output in dist-demos/
bun start               # run the demo site locally on port 3000
bun run bench:remote-loading  # browser sweep against hosted demo photos
```

## Preview deploys (Vercel)

`vercel.json` at the repo root configures Vercel for static-output deploys: `bun install --frozen-lockfile`, `bun run check && bun run build:demos`, serve `dist-demos/`. The existing GitHub Pages deploy (main only) keeps working alongside Vercel previews — they're independent.

One-time setup (~5 min):

1. Sign in to <https://vercel.com> and import the `somnai-dreams/preimage` repo.
2. Vercel auto-detects `vercel.json`. No build settings to override.
3. Production branch: `main`. Every other branch + PR gets a unique preview URL like `swing-1-preimage-sidecar--preimage.vercel.app`.
4. Pushes update the preview within ~1 minute.

Static deploys work for the demo and bench pages that run entirely in the browser. Pages that depend on `pages/server.ts` endpoints need a matching static build step or an edge/API endpoint before they can deploy as plain files.

## Layout

| file | role |
|---|---|
| `packages/preimage/src/analysis.ts` | format / declared-dim / normalized-src analysis |
| `packages/preimage/src/measurement.ts` | shared measurement cache records |
| `packages/preimage/src/probe.ts` | DOM-free byte parsers for PNG/JPEG/GIF/BMP/WebP/SVG/AVIF/HEIC/APNG/ICO |
| `packages/preimage/src/prepare.ts` | single-image `prepare()` / `layout()` / `disposePreparedImage()` |
| `packages/preimage/src/prepare-queue.ts` | adaptive queueing, boost/deprioritize, option-aware dedupe |
| `packages/preimage/src/decode-pool.ts` | off-main-thread bitmap decode cache |
| `packages/preimage/src/virtual.ts` | DOM-recycled virtual tile pool |
| `packages/preimage/src/loading.ts` | gallery image scheduling and `Gallery.done` orchestration |
| `packages/preimage/src/predict.ts` | scroll prediction baselines for virtual pre-render experiments |
| `packages/preimage/src/manifest.ts` | build-time dimension manifest builder + CLI |
| `packages/preimage/src/pretext-*.ts` | pretext float and inline integrations |
| `packages/layout-algebra/src/index.ts` | DOM-free packers, cursors, visibility, first-screen estimates |
| `pages/demos/virtual.ts` | reference consumer for async image work + DOM recycling + rAF-batched render |

## Remote loading sweeps

`bun run bench:remote-loading` starts a temporary local page, drives Chromium with Playwright, and loads the hosted demo photos from `https://preimage.dearlarry.co/assets/demos/photos/*.png`. It is not a demo bench: it lives under `scripts/` so it can serve as both a CI regression harness and a local strategy sweep while still exercising real browser image requests.

The default local run compares `visible-first`, `queued`, `after-layout`, and `immediate` with remote cache-busted URLs, scripted scroll, first-image/done timings, max render concurrency, and visible pending-tile ratios. CI runs a smaller `visible-first` versus `queued` pass through `bun run check:all`; tune larger experiments with flags such as:

```sh
bun run bench:remote-loading -- --runs 3 --n 68 --strategies visible-first,queued
```

## Coverage Matrix

Every public value export and package subpath is assigned to an automated owner in `scripts/coverage-matrix-test.ts`. `bun run check:all` runs that matrix first, so adding a public API without a regression or benchmark surface fails locally and in CI. The human-readable policy lives in `docs/benchmark-regression-matrix.md`.

## Dependencies

- `@chenglou/pretext` is a `peerDependency`. The main entry does not import it; only the `packages/preimage/src/pretext-*.ts` modules do. Callers that don't use the pretext integration do not need pretext installed.

## Releasing

```sh
npm version patch
npm publish --access public
```
