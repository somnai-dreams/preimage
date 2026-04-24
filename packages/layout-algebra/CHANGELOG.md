# Changelog

## 0.5.0

- **New: `estimateFirstScreenCount({ mode, panelWidth, viewportHeight, gap, ... })`.** Pure-math estimate of how many leading items will land on the first viewport before any aspects are known. `columns` mode assumes roughly-square tiles (`tileHeight ≈ panelWidth / columns`); `rows` mode uses `targetRowHeight` plus `round(panelWidth / targetRowHeight)` items per row. Returns a count, not indices — caller slices their URL array and feeds the slice into `PrepareQueue.boostMany` so those probes jump the queue ahead of the below-fold backlog. Rough by design (no aspects = no exact pack); the whole point is pre-measurement prioritization.
- **Config validation is stricter at the layout boundary.** `shortestColumnCursor()` now rejects fractional/zero columns, non-positive panel widths, negative gaps, and impossible column widths. `estimateFirstScreenCount()` rejects non-positive panel/viewport/target sizes, fractional columns, and negative gaps before those values can turn into bogus queue priorities.

## 0.4.0

- **Normalized config shapes across every packer.** Every config now reads `{ panelWidth, gap, <algorithm-param>, ... }` — same fields in the same positions. Was inconsistent: `packShortestColumn` took `{ columns, gap, panelWidth }`; `packJustifiedRows` took `{ panelWidth, targetRowHeight, gap, lastRowJustified? }`. Field names unchanged, destructuring order doesn't affect JS runtime, but the type declarations now match so IDE tooltips and LLM completions are predictable.
- **JSDoc on every public export** with short `@example` blocks.

## 0.3.0

- **New: `justifiedRowCursor(config)`.** Streaming form of `packJustifiedRows`. `add(aspect)` buffers items into an open row and emits `{ closed: JustifiedRowClose[] }` — a batch of finalized placements — exactly when a row fills. `finish(justifyLast?)` flushes the trailing row. Output matches the batch packer byte-for-byte for the same input sequence; the difference is you can start rendering as soon as each row closes instead of waiting for all aspects to arrive. The packing demo shows the same aspect list through both row and column packers.

## 0.2.0

- **New: `visibleIndices(placements, { viewTop, viewBottom, overscan? })`.** Returns the indices of placements overlapping a vertical window. Linear scan in placement order; pure function over the same `Placement` type the packers emit. Intended for virtual-scroll grids where you need to answer "which tiles should be mounted right now" on every scroll tick.

## 0.1.0

- **New: `packJustifiedRows(aspects, { panelWidth, targetRowHeight, gap, lastRowJustified? })`.** Flickr / Google Photos / Unsplash-style layout. Images flow left-to-right at a target row height; each row closes when the next would overflow `panelWidth` and its items scale uniformly so widths fit exactly. The trailing row keeps `targetRowHeight` by default (leave-whitespace behavior), or scales to fill like every other row when `lastRowJustified: true`. Complements the existing `packShortestColumn` / `shortestColumnCursor`.

## 0.0.1

Initial release. `packShortestColumn` + `shortestColumnCursor` — shortest-column masonry packer, batch and streaming forms. Pure functions over aspect ratios; DOM-free, SSR-safe.
