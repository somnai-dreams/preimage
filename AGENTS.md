# AGENTS

How to work effectively in this repo. Read this before making changes.

## What this is

A monorepo home for `@somnai-dreams/preimage` (a browser image-measurement library) and `@somnai-dreams/layout-algebra` (pure-function layout primitives). Shares an ecosystem with `@chenglou/pretext` (text layout) and `@chenglou/vibescript` (UI conventions). Demos and benchmarks live in-repo and deploy to GitHub Pages.

## Layout

```
packages/
  preimage/             main library (0.7.x)
    src/
      prepare.ts        prepare(), PreparedImage, layout/fit math
      prepare-queue.ts  concurrency queue
      decode-pool.ts    off-main-thread decode + LRU bitmap cache
      probe.ts          byte-level probes + probeImageStream
      virtual.ts        createVirtualTilePool
      manifest.ts       buildManifest + preimage-manifest CLI
      manifest-cli.ts
      core.ts           DOM-free re-exports
      pretext.ts        pretext integration entry
      pretext-*.ts
      ... (analysis, orientation, measurement, url-dimensions, fit)
  layout-algebra/       DOM-free layout primitives (0.4.x)
    src/index.ts        packers, cursors, visibleIndices
pages/
  demos/                public demos deployed to GH Pages root
  bench/                benchmark pages deployed to /bench/
  assets/               photos, SVGs, screenshots
  server.ts             bun dev server
scripts/
  distill-har.ts        HAR diagnostic tool
  screenshots.mjs       playwright screenshot automation
  rename-and-manifest.ts  offline helper for the photo set
.github/workflows/
  pages.yml             GH Pages deploy on push to main
```

## Workflow

- **Branch**: work directly on `main`. No feature branches, no PRs. The user okayed this; don't reinstate feature branches without being told.
- **Before each commit**: `bun run check` (root tsc) must pass.
- **Commit messages**: imperative subject under 70 chars, body explains the why. Reference versions (`0.7.1`) when bumping a package.
- **Push**: `git push origin main`. GH Pages workflow redeploys on every push.
- **Claude Code signatures**: don't add them. The commit bodies should read as plain engineering notes.

## Running

```bash
bun install                # sets up workspaces
bun run check              # root tsc over everything
bun run start              # dev server at http://localhost:3000
bun run build:demos        # builds demos + bench to dist-demos/
bun --cwd packages/preimage run build         # package build
bun --cwd packages/layout-algebra run build
```

Dev server lives in `pages/server.ts`. Routes are registered explicitly per page — when adding a new demo or bench page, add its import + a route here or it'll 404.

## Versioning

- Each package has its own `package.json` version and `CHANGELOG.md`. Bump the relevant one when changing its public surface.
- Minor for new exports, patch for fixes, pre-1.0 so minor can also carry non-obvious shape changes. Record the change in CHANGELOG under the new version — humans read it.
- Current versions live at the top of `packages/*/CHANGELOG.md`.

## Subpath exports (preimage)

- `.` main entry — `prepare`, `PrepareQueue`, `DecodePool`, layout math, type exports
- `/core` DOM-free — `probeImageBytes`, `probeImageStream`, URL parsers, measurement cache, EXIF
- `/pretext` pretext integration — float + inline + flow helpers
- `/virtual` — `createVirtualTilePool`
- `/manifest` — `buildManifest` (Node fs)
- `bin: preimage-manifest` CLI

Adding a subpath: update `packages/preimage/package.json` `exports`, add to root `tsconfig.json` paths, add to README's API glossary.

## Code conventions

We follow vibescript. Short version:

- **Classes are full assignments, not toggles.** `el.className = 'vtile pending'` not `classList.add`/`classList.remove` pairs that can drift between branches.
- **Static properties set once at element creation, dynamic every frame.** If a prop appears in both it's a bug.
- **DOM writes live in one phase**, separated from reads. No read-write interleaving. In practice: cache scroll metrics, write `style.height` only in a render function, never mix `.scrollTop` reads with DOM writes in the same callback.
- **Per-frame scheduling**: use `requestAnimationFrame` to batch writes. Event handlers should store transient input state and `scheduleRender()` — logic goes in render, not in handlers.
- **No `Math.random` / `Date.now` for anything animation-related.** Use seeded pseudo-random (lowbias32) or `document.timeline.currentTime` / `performance.now()` depending on whether you need rAF-clock or wall-clock.
- **No per-item `ResizeObserver` or `IntersectionObserver` loops.** Virtualize via a pure-math visibility query + one scroll listener.
- **Image fetch cancellation**: `img.src = ''` before discarding the `<img>`. Removing the node from the DOM alone doesn't stop an in-flight fetch.
- **Cache-hit fast path**: after `img.src = url`, check `img.complete && img.naturalWidth > 0` before attaching a load listener. If true, mark loaded synchronously so no fade-in transition fires.
- **Animations are short**: opacity transitions 20ms max. We're a library about making images load fast; 180ms fades undercut the story.

## API design (AI-friendliness)

- **Flat handles over opaque brands.** `prepared.width` directly readable, not `getMeasurement(prepared).displayWidth`. Legacy helpers stay as aliases so old code works.
- **Consistent config shapes across similar functions.** `packShortestColumn` and `packJustifiedRows` both accept `{ panelWidth, gap, <algorithm-param>, ... }` in the same order.
- **JSDoc `@example` on every public export.** IDE tooltips and LLM context windows carry the usage shape.
- **Sensible defaults.** `PrepareQueue` defaults to 50 (H2 sweet spot). `overscan` defaults to 200. Users should be able to call constructors with no config.
- **Validate at the boundary, not every layer.** `RangeError` for public-API misuse; internal helpers trust their inputs.

## Performance bar

- No forced reflow per probe resolve. If you write `style.height` and then read `scrollTop` in the same tick, that's thrash. Cache scroll/size metrics and update on scroll events or `ResizeObserver`.
- No per-item observers at 10k-item scale. Linear iteration over placements beats N observers.
- Virtual tile pool: ~40 live DOM nodes regardless of item count. If node count grows with scroll, there's a leak.
- Image fetch during scroll-past: unmount must cancel (`img.src = ''`) or bytes pile up.

## Testing

We don't write unit tests. "Good TypeScript doesn't need them" per the user's call. Verification strategy (from vibescript):

- **Type safety** as the primary first line of defense (strict TS, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **JSDoc contracts** with `@example` blocks on public exports — these are both docs and informal contracts.
- **Smoke tests in scripts or Node one-liners** when landing a feature (e.g. the probeImageStream stream test, the packer determinism check in the bench). Discarded after landing unless it earns a permanent place.
- **Browser-level benchmarks** at `pages/bench/*` for perf-regression detection. Save runs as JSON; diff manually as needed.
- **Live demos** at `pages/demos/*` — they exercise the library in real conditions and serve as visual sanity checks.

Do not stand up a formal test framework without being asked.

## Demos

Each demo has its own `.html` + `.ts` in `pages/demos/`. Conventions:

- Use shared styles from `pages/demos/demo-styles.css`.
- Load both `./nav-concurrency.ts` (injects concurrency select + benchmarks link) and `./warm-cdn.ts` (Warm CDN button) at the end of `<body>`.
- Read photos via `pages/demos/photo-source.ts` (34 committed PNGs; `cycledUrls` gives you arbitrarily-large URL lists by cycling + cache-busting).
- Register the new demo in `pages/server.ts` routes AND in the demo index (`pages/demos/index.html`).

## Benchmarks

`pages/bench/*` pages are non-decorative — no shimmer, no demos, just measurement UIs. Each page:

- Reads run parameters from sliders/inputs.
- Runs the workload, captures a `Distribution` (min/p50/p95/max).
- Renders a stat grid + the full JSON payload in a `<pre>`.
- Offers a "Save as JSON" button that triggers a download with standardized filename and metadata (protocol, date, UA, origin).

Shared utilities live in `pages/bench/common.ts`. When adding a bench, register its route in `pages/server.ts` and link it from `pages/bench/index.html`.

## Commits we've made

Recent canonical patterns to reference:

- `0.7.0` — flattening `PreparedImage` from opaque brand to direct-read fields (`.width`, `.height`, etc). Helpers kept as aliases.
- `0.6.1` — fixed layout thrash by caching scroll metrics in `createVirtualTilePool`.
- `0.5.0` — added `probeImageStream` for WebSocket / AI-gen byte feeds.
- `0.3.0` — DOM-free `/core` subpath.

Read the top of `packages/*/CHANGELOG.md` before making library-shape changes — existing patterns usually answer "how should I structure this new thing."

## Things not to do

- Don't add new build tools, bundlers, or test frameworks without being asked.
- Don't add a React/Vue/Svelte adapter. The library is framework-free on purpose.
- Don't add per-item `ResizeObserver` or `IntersectionObserver` to virtualize. We iterate.
- Don't use `getBoundingClientRect()` during a layout compute. Pure arithmetic from aspect ratios only.
- Don't write placeholder READMEs or docs unless asked. The user reads code more than prose.
- Don't break the `zero-runtime-dep` story on the browser surface. Manifest CLI can have Node-only helpers; `/core` and the main entry stay vanilla.
- Don't rewrite in a full render-loop architecture unless the user asks. Current demos use event-handler-driven structure; the hot path in `virtual.ts` is rAF-batched.

## When in doubt

- Check `packages/preimage/CHANGELOG.md` for the latest stable patterns.
- Look at `pages/demos/virtual.ts` for the reference case of "streaming async work + DOM recycling + rAF-batched render."
- Look at `packages/layout-algebra/src/index.ts` for the pure-math style.
- Ask the user before introducing a dependency. Ask before refactoring across packages.
