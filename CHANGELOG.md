# Changelog

## 0.0.1

Initial release. Full structural port of [@chenglou/pretext](https://github.com/chenglou/pretext) to the image domain.

- `prepare()` / `layout()` — single-image fast path with CSS `object-fit` modes (`contain` | `cover` | `fill` | `scale-down` | `none`).
- `prepareWithBoxes()` / `layoutWithRows()` / `walkRowRanges()` / `measureRowStats()` / `layoutNextRowRange()` / `materializeRowRange()` — gallery manual-layout API mirroring pretext's streaming line-break shape.
- `@somnai-dreams/preimage/rich-gallery` — rich-gallery inline-flow helper mirroring pretext's rich-inline module.
- EXIF orientation support (codes 1–8) with `readExifOrientation()` for raw JPEG byte buffers.
- `prepareSync()` / `recordKnownMeasurement()` for SSR / hydration paths that already know intrinsic dimensions.
- Demo site under `pages/demos/`.
