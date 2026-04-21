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
bun run build:package   # build dist/ (ESM + .d.ts)
bun start               # run the demo site locally on port 3000
```

## Layout

| file | role |
|---|---|
| `src/analysis.ts` | format / declared-dim / normalized-src analysis |
| `src/measurement.ts` | HTMLImageElement.decode()-based intrinsic-dim pass |
| `src/orientation.ts` | EXIF orientation (codes 1–8) |
| `src/fit.ts` | pure CSS object-fit math |
| `src/prepare.ts` | single-image `prepare()` / `layout()` |
| `src/gallery.ts` | standalone justified / fixed-height row packer |
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
