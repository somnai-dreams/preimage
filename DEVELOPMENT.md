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
bun run check:all       # run all offline regression harnesses
bun run build:package   # build packages/preimage/dist/ (ESM + .d.ts)
bun run build:layout-algebra
bun run build:all
bun run build:demos     # static demo + bench output in dist-demos/
bun start               # run the demo site locally on port 3000
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

## Dependencies

- `@chenglou/pretext` is a `peerDependency`. The main entry does not import it; only the `packages/preimage/src/pretext-*.ts` modules do. Callers that don't use the pretext integration do not need pretext installed.

## Releasing

```sh
npm version patch
npm publish --access public
```
