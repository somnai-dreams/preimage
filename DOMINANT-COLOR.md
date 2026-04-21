# Dominant color — stash branch

This branch preserves the dominant-color extraction work that was in preimage
through 0.0.6. It was removed from `main` in 0.0.7 because:

1. The extraction runs on the fully-assembled blob (post-stream-drain). Color
   arrives at roughly the same time the real image paints, so it can't
   function as a loading placeholder — the one use case the feature was
   advertised for.
2. The primitive and the API shape are fine; they just don't belong in an
   image-measurement library. Color extraction is its own problem.

Snapshot is kept so the work isn't lost — if you (or someone else) want to
build a proper standalone color library later, start here.

## What's on this branch

Source:

- `src/dominant-color.ts` — the core. `extractDominantColorFromBlob(blob)`
  returns a CSS `rgb(...)`/`rgba(...)` string via
  `createImageBitmap(blob, {resizeWidth:1, resizeHeight:1, resizeQuality:'low'})`
  + `OffscreenCanvas` `getImageData`. The browser's native resampler does the
  averaging; no JS-side pixel sampling loop. Also exports
  `extractDominantRgbaFromBlob` (returns `{r, g, b, a}` instead of a CSS
  string) and `rgbaToCss`.
- `src/prepare.ts` — `extractDominantColor?: boolean` on `PrepareOptions`.
  When set, `streamAndProbe` forces `completeStream=true` and runs the
  extraction in a detached `.then()` after the stream drain completes.
  `prepareFromBlob` does the same for blob sources.
- `src/measurement.ts` — `dominantColor?: string` field on
  `ImageMeasurement`. Populated asynchronously after the stream drain.
- `src/index.ts` — public exports.

Demos:

- `pages/demos/demo-utils.ts` — `waitForDominantColor(prepared, {timeout?})`
  polls the measurement via rAF until `dominantColor` appears (or the
  timeout elapses). `paintDominantColorBehind(prepared, el)` paints the
  color as an element's `background-color` when it lands.
- Various demos use those helpers to paint tile backgrounds.

Docs:

- `README.md` "Dominant color" section.
- `CHANGELOG.md` 0.0.6 entry.

## Known limitations

- **Post-drain timing.** Color arrives when the full image has finished
  streaming. No value as a placeholder; useful only for palette uses where
  timing doesn't matter (theming accent colors, sidebar decorations).
- **Canvas taint on cross-origin sources.** `createImageBitmap` on a blob
  fetched CORS-less will throw on `getImageData`. The library currently
  returns `null` in that case. Real fix needs a CORS-aware fetch.
- **No worker offload.** The decode runs on whatever thread calls
  `createImageBitmap` — typically main. For a real library you'd want the
  extraction inside a dedicated worker pool.

## What a real version would look like

The compelling version isn't "color from full image." It's
**color from the first 2KB of bytes** — same window we already use for
dimension probing. A proper library would:

1. **Progressive-JPEG DC coefficient parse.** The first scan of a progressive
   JPEG is an 8×8-block-averaged thumbnail encoded in ~1-3KB. Average the DC
   coefficients → a single color from partial bytes. This is the missing
   primitive that would make color-before-pixels actually work. No public
   JS library does this.
2. **AVIF preview-layer extraction.** AVIF-with-preview encodes a low-res
   thumbnail in the `ispe`/`pitm` boxes. Parse it out of partial bytes.
3. **Graceful fallback to full-blob resize** (what this branch does) when
   neither of the above applies — baseline JPEGs, PNGs, non-previewed AVIFs.
4. **Palette extraction** — dominant + 3-5 secondary colors, harmonized for
   UI accent use.
5. **Worker-based decode pool** so extraction never hits the main thread.

## Using this branch

```sh
git checkout feat/dominant-color
# or
git log feat/dominant-color -- src/dominant-color.ts pages/demos/demo-utils.ts
```

To extract just the feature without the surrounding demos:

```sh
git show feat/dominant-color:src/dominant-color.ts > dominant-color.ts
```

Or cherry-pick specific commits — the feature was introduced in
`a2c7290` ("Add dominant color, PrepareQueue, DecodePool (0.0.6)") with
follow-up fixes in later commits on this branch.
