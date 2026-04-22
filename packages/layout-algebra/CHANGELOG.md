# Changelog

## 0.1.0

- **New: `packJustifiedRows(aspects, { panelWidth, targetRowHeight, gap, lastRowJustified? })`.** Flickr / Google Photos / Unsplash-style layout. Images flow left-to-right at a target row height; each row closes when the next would overflow `panelWidth` and its items scale uniformly so widths fit exactly. The trailing row keeps `targetRowHeight` by default (leave-whitespace behavior), or scales to fill like every other row when `lastRowJustified: true`. Complements the existing `packShortestColumn` / `shortestColumnCursor`.

## 0.0.1

Initial release. `packShortestColumn` + `shortestColumnCursor` — shortest-column masonry packer, batch and streaming forms. Pure functions over aspect ratios; DOM-free, SSR-safe.
