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
bun run check:all       # run all offline regression harnesses (~1.3s, 9 harnesses, 562 checks)
bun run build:package   # build dist/ (ESM + .d.ts)
bun start               # run the demo site locally on port 3000
```

## Preview deploys (Vercel)

`vercel.json` at the repo root configures Vercel for static-output deploys: `bun install --frozen-lockfile`, `bun run check && bun run build:demos`, serve `dist-demos/`. The existing GitHub Pages deploy (main only) keeps working alongside Vercel previews — they're independent.

One-time setup (~5 min):

1. Sign in to <https://vercel.com> and import the `somnai-dreams/preimage` repo.
2. Vercel auto-detects `vercel.json`. No build settings to override.
3. Production branch: `main`. Every other branch + PR gets a unique preview URL like `swing-1-preimage-sidecar--preimage.vercel.app`.
4. Pushes update the preview within ~1 minute.

**Branches that work as a static deploy out of the box**: `main`, swing-4 (glasspane), swing-5 (predict), loading-patterns. They're all dev-server-independent.

**Branches that need additional work**:
- **Sidecar (PR #5)**: the demo relies on the dev server synthesizing `.prei` text files on the fly. For static deploy, extend `build:demos` on that branch with a step that writes `.prei` next to each image at build time (run `preimage-sidecar --batch --inplace dist-demos/assets`).
- **Batched probe (PR #3)**: the bench POSTs to `/preimage/probe`, which the dev server implements. Static deploy has no endpoint. Either port the handler to a Vercel Edge Function (`api/probe.ts`) or skip Vercel for that branch and run `bun run start` locally to test.

## Layout

| file | role |
|---|---|
| `src/analysis.ts` | format / declared-dim / normalized-src analysis |
| `src/measurement.ts` | HTMLImageElement.decode()-based intrinsic-dim pass |
| `src/orientation.ts` | EXIF orientation (codes 1–8) |
| `src/fit.ts` | pure CSS object-fit math |
| `src/prepare.ts` | single-image `prepare()` / `layout()` |
| `src/pretext-float.ts` | pretext integration: `flowColumnWithFloats`, `solveFloat` |
| `src/pretext-inline.ts` | pretext integration: `inlineImage`, `resolveMixedInlineItems` |
| `src/index.ts` | main entry barrel |
| `src/pretext.ts` | `./pretext` subpath barrel |

## Dependencies

- `@chenglou/pretext` is a `peerDependency`. The main entry does not import it; only the `src/pretext-*.ts` modules do. Callers that don't use the pretext integration do not need pretext installed.

## Releasing

```sh
npm version patch
npm publish --access public
```
