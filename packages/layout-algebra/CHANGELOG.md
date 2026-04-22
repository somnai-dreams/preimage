# Changelog

## 0.2.0

- **New: `visibleIndices(placements, { viewTop, viewBottom, overscan? })`.** Returns the indices of placements overlapping a vertical window. Linear scan in placement order; pure function over the same `Placement` type the packers emit. Intended for virtual-scroll grids where you need to answer "which tiles should be mounted right now" on every scroll tick.

## 0.1.0

- **New: `packJustifiedRows(aspects, { panelWidth, targetRowHeight, gap, lastRowJustified? })`.** Flickr / Google Photos / Unsplash-style layout. Images flow left-to-right at a target row height; each row closes when the next would overflow `panelWidth` and its items scale uniformly so widths fit exactly. The trailing row keeps `targetRowHeight` by default (leave-whitespace behavior), or scales to fill like every other row when `lastRowJustified: true`. Complements the existing `packShortestColumn` / `shortestColumnCursor`.

## 0.0.1

Initial release. `packShortestColumn` + `shortestColumnCursor` — shortest-column masonry packer, batch and streaming forms. Pure functions over aspect ratios; DOM-free, SSR-safe.
