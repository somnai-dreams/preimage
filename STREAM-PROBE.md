# Stream-probe prepare — archive branch

Snapshot of the `fetch()`-and-stream-header-probe implementation of
`prepare()` as it existed through 0.0.7. Main dropped this approach in 0.1.0
in favour of a native `<img>` + `setTimeout(0)` `naturalWidth`-polling path
that's smaller, format-agnostic, and avoids the double-fetch gotcha.

This branch is preserved in case the stream-probe approach turns out to have
value we didn't see, or you want to extract pieces (the format-specific
header parsers, `streamAndProbe`, etc.) for another project.

## How it worked

`prepareFromUrl(url)` in `src/prepare.ts`:

1. `fetch(url)` opens the response stream.
2. `reader.read()` pulls chunks. After each chunk, call
   `probeImageBytes(accumulated)` — this lives in `src/probe.ts` and knows
   how to extract dimensions from PNG (IHDR), JPEG (SOF markers), WebP
   (VP8/VP8L/VP8X), GIF, BMP, and SVG headers.
3. As soon as the header parse returns a result, `prepare()` resolves with
   the dimensions.
4. A background `.then()` drains the rest of the stream, accumulates the
   bytes into a `Blob`, and attaches a blob URL to the measurement. The
   intent was for callers to use that blob URL as `<img src>` to avoid a
   second network fetch.

## Why it was dropped

Three reasons, in roughly increasing order of importance:

1. **Over-engineering.** Browsers already parse image headers as bytes
   arrive and expose `img.naturalWidth` before the full image has decoded.
   We reimplemented a capability the platform ships. Polling `<img>` with
   `setTimeout(0)` gets dims in 4-8ms on average — same ballpark as our
   stream probe, with no format-specific JS parsers.

2. **Format coverage.** Our parsers supported PNG, JPEG, WebP, GIF, BMP,
   SVG. The browser supports those plus AVIF, HEIC, and anything new that
   ships. Shifting to the browser's parse means we get every format
   browsers ever add for free.

3. **The blob-URL reuse story didn't work.** `prepare()` resolves at
   dims-known time (header-byte parse, ~first 2KB). The blob URL isn't
   populated until drain completes (full transfer, seconds for big images).
   Callers who want to render right after `prepare()` resolves find
   `blobUrl` still undefined and fall through to the network URL — which
   triggers a *second* fetch to the same URL. The browser's HTTP cache
   usually dedupes it so only one network transfer happens, but the
   "we saved a fetch" claim was only true in theory.

## What's genuinely valuable in this approach

The one capability this branch offers that the new `<img>`-polling approach
does not: **precise, deterministic cancellation after dims are known.** In
0.0.7 `prepare(url, { completeStream: false })` would `reader.cancel()` the
moment the header parse succeeded, saving the remaining MB of transfer
bytes. With `<img>` polling the only abort mechanism is `img.src = ''` —
it fires an error event, has timing-dependent semantics, and by the time
the rAF/setTimeout poll detects dims and triggers cancel you've already
downloaded some amount of body.

If you're building something that needs to measure a lot of remote images
(catalog tooling, SSR precompute, bandwidth-constrained UIs), the stream-
probe approach saves meaningfully more bandwidth than `<img>` abort.

## Map of the relevant code

- `src/prepare.ts` — `prepareFromUrl`, `streamAndProbe`, blob URL wiring.
- `src/probe.ts` — `probeImageBytes`, `MAX_HEADER_BYTES`, format-specific
  header parsers.
- `src/measurement.ts` — `blobUrl?` field on `ImageMeasurement`.
- `src/index.ts` — public exports.

## Using this branch

```sh
git checkout archive/stream-probe-prepare
```

Or cherry-pick the probe primitive:

```sh
git show archive/stream-probe-prepare:src/probe.ts > probe.ts
```

`probeImageBytes()` is still exposed on main as a standalone for File/Blob
inputs; it's just not used by `prepare(url)` anymore. If you want the
full stream-and-cancel machinery, take it from here.
