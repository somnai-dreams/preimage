# Development

This repo is managed with [Bun](https://bun.sh). Node + `npm` also work for the build + type-check paths.

## Setup

```sh
bun install
# or
npm install
```

## Commands

```sh
bun run check           # run tsc type-check
bun run build:package   # build dist/ (ESM + .d.ts)
bun start               # run the demo site locally on port 3000
```

## Layout

- `src/analysis.ts` — image analysis: format detection, declared-dimension parsing, gallery item analysis. Analog of pretext's `analysis.ts`.
- `src/measurement.ts` — image load + decode, intrinsic-dimension caching. Analog of pretext's `measurement.ts`.
- `src/orientation.ts` — EXIF orientation handling. Analog of pretext's `bidi.ts`.
- `src/row-packing.ts` — row packer for a gallery. Analog of pretext's `line-break.ts`.
- `src/layout.ts` — main public API. Analog of pretext's `layout.ts`.
- `src/rich-gallery.ts` — rich-gallery inline-flow helper. Analog of pretext's `rich-inline.ts`.

## Testing

Run `bun test` once source tests land. The main-branch baseline ships with type-check + demo-site smoke tests only.

## Releasing

```sh
npm version patch
npm publish --access public
```
