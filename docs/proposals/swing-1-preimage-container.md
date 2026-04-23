# Swing 1 — Self-describing image container (`.prei`)

> Status: exploratory. Draft PR against `main`. Not merged, not targeted at a release.

## Problem

Everything preimage does today is a workaround for the fact that an image file's dimensions are expensive to get at. Four strategies (`img` / `stream` / `range` / `auto`), five format parsers (PNG / JPEG / WebP / GIF / BMP / SVG), origin-cap heuristics, concurrency tuning, abort-race handling — all of it exists to shave round-trips off of "tell me how big this thing is."

From the sweep data in `benchmarks/probe-sweep-2026-04-23T02-57-21-533Z.json`:
- `img` at c=100: 15.7 probes/sec, ~340 KB/probe wasted bandwidth from late aborts
- `stream` at c=100: 22.5 probes/sec, ~0.3 KB/probe, abort-race
- `range` at c=100: 1350 probes/sec, ~4.4 KB/probe, deterministic but server-dependent

Even the fastest strategy (`range`) is doing 4 KB of guesswork-budget per image. Every parser is a best-effort walk of byte structure that might or might not land within the budget. JPEGs with heavy EXIF payloads push SOF markers past 4KB. SVGs with long DOCTYPEs push `<svg>` past the regex window. AVIF isn't covered at all because its `ispe` box can sit anywhere.

## Proposal

Define a **fixed-layout 128-byte prefix** that wraps any image and carries everything preimage wants to know:

```
offset  size  field
 0       4   magic "PREI"
 4       2   version (u16 big-endian, starts at 1)
 6       2   flags   (u16 — hasAlpha, isProgressive, colorspace bits)
 8       4   width   (u32 big-endian)
12       4   height  (u32 big-endian)
16       8   payloadByteLength (u64 big-endian — total image bytes after prefix)
24       4   payloadFormat ("jpeg" | "png " | "webp" | "avif" — 4 ASCII)
28      24   thumbhash (raw bytes, right-padded if shorter)
52       8   sha256Prefix (first 8 bytes of sha256 of payload — dedup/cache key)
60      60   reserved (zeros, for post-v1 additions)
120      4   crc32 over bytes 0-119 (u32 big-endian)
124      4   reserved (for alignment)
128     ...  original image payload (JPEG/PNG/WebP/AVIF bytes, untouched)
```

Container is **transparent**: the image payload after byte 128 is the exact bytes of the original JPEG/PNG/WebP, unmodified. A browser pointed at a `.prei` URL sees the prefix as junk and fails to decode; a preimage-aware consumer fetches a 128-byte range, parses deterministically, and knows everything.

Probe becomes **one deterministic fetch**: `Range: bytes=0-127`. No format dispatch, no parser walk, no abort race. The 128 bytes arrive in a single TCP flight, always.

## How the pieces fit

### Client

`prepare(url, { strategy: 'container' })` — new strategy. Fetches `bytes=0-127`, validates magic + CRC, populates measurement. If the server returns 404 or non-PREI bytes, falls back to `auto` transparently.

Existing `prepare.ts` grows a branch:

```ts
if (strategy === 'container') {
  return await prepareFromContainer(src, key, options)
}
```

`prepareFromContainer` is ~60 LoC: range-fetch 128B, DataView-parse, `recordKnownMeasurement` with all fields populated including `byteLength`, `hasAlpha`, `isProgressive`, and the new `thumbhash` (if Swing 1 ships before thumbhash land, reserve the bytes as zero).

`auto` learns a fourth possible outcome. After the per-origin cache records `'container'` support, every subsequent probe is 128 bytes, one RTT.

### Server (transcode CLI)

`preimage-transcode <in> <out>` — new CLI. Reads an image, probes dims + alpha + progressive using the **existing** header parsers (no decode, no new deps), optionally computes a thumbhash or skips, emits a `.prei` file.

```bash
preimage-transcode photo.jpg photo.prei
preimage-transcode --batch ./public/photos ./public/photos-prei
```

Output is the 128-byte prefix concatenated with the original bytes. **No re-encoding** — payload is byte-identical. Reversible: `preimage-transcode --extract photo.prei photo.jpg` strips the prefix.

CDN/origin serves `.prei` with a mime type (`image/vnd.preimage+jpeg`, or just let the content-type come from the underlying format — caller needs to know by extension anyway). When a non-preimage-aware browser requests the same URL, the origin can:
- (a) strip the prefix on-the-fly based on `Accept` header (preferred for production)
- (b) serve two separate URLs: `.jpg` for browsers, `.prei` for preimage — caller opts in

For v1, ship option (b). Option (a) is a later optimization.

### Adoption path

1. **Phase 0** — design lock. Container layout finalized, magic bytes registered internally, CRC polynomial chosen (IEEE 802.3).
2. **Phase 1** — transcode CLI + container strategy, working on localhost. Demo page: `pages/demos/container.html` shows a gallery served from `.prei` files.
3. **Phase 2** — manifest integration. `preimage-manifest` can emit a manifest of `.prei` URLs instead of dims-in-JSON; downstream is equivalent.
4. **Phase 3** — CDN adapter. A small edge worker (Cloudflare Workers / Vercel Edge) that wraps any image request in a container on-the-fly if the request has `Accept: image/vnd.preimage+*`. No pre-transcoding required.
5. **Phase 4** — lobby a browser vendor or WICG for native support. `<img src="photo.prei">` paints correctly without the manual strip.

Phases 1-3 are the shippable scope. Phase 4 is aspirational.

## Open questions

- **CRC vs HMAC?** CRC catches corruption; HMAC catches tampering. For image dims, CRC is enough. Leave HMAC for a later version field.
- **Thumbhash inclusion.** 24 bytes is generous. Could be smaller. Could also be replaced with a "reserved" block and filled later — callers who don't compute thumbhash ship zeros. No size cost either way; cost is the transcode-time decode.
- **Big-endian everywhere.** Network byte order. Consistent with PNG/JPEG. Avoids platform confusion. Never overrule.
- **Versioning.** `version` is a u16 at offset 4. v1 is the layout above. v2 could add color profile LUT indexes, EXIF orientation, WebP animation-frame hints. Unknown version = client refuses to parse, falls back to `auto`.
- **AVIF/HEIC payloads.** Container wraps any payload; we just copy bytes. But the probe-from-prefix metadata (`width`, `height`, `hasAlpha`) is already extracted at transcode time via the existing parsers, which don't handle AVIF. Transcode CLI would need AVIF dim extraction — shell out to `ffprobe`, or add a minimal `ispe` walker (~40 LoC). Worth doing since `.prei` is the natural home for AVIF support.
- **Security model.** A malicious CDN could ship wrong dims in the prefix. Today's `img` path lets the browser decode and get real dims; container path trusts the prefix. Mitigation: clients can spot-check by decoding N% of images and comparing. Nice-to-have, not a v1 requirement.

## API sketch

```ts
// In @somnai-dreams/preimage, new export:
import { encodeContainer, decodeContainer, PREIMAGE_CONTAINER_SIZE } from '@somnai-dreams/preimage/container'

// Encode side (Node, CLI):
const prefix: Uint8Array = encodeContainer({
  width: 1920,
  height: 1080,
  format: 'jpeg',
  payloadByteLength: 483721,
  hasAlpha: false,
  isProgressive: true,
  thumbhash: hashBytes, // optional, default zeros
  colorSpace: 'srgb',
})
// Client-side:
const parsed = decodeContainer(bytes128)
// → { width, height, format, hasAlpha, ..., valid: true }

// prepare() gains:
prepare(url, { strategy: 'container' })
// or: prepare(url, { strategy: 'auto' }) learns container support per-origin
```

## Size estimate

- Container encode/decode: ~120 LoC. Fixed layout, no branches.
- `prepareFromContainer`: ~60 LoC.
- `auto` extension to cache `'container'` outcome: ~15 LoC.
- Transcode CLI: ~150 LoC (arg parsing, directory walk, AVIF probe, batch mode).
- AVIF `ispe` walker (optional): ~40 LoC.
- Demo page + stats: ~120 LoC.
- Tests / bench extension: ~200 LoC. Container strategy added to `bench/sweep.html` and `bench/probe.html` pickers.

**Total: ~700 LoC. One person-week of focused work.**

## Expected impact

- **Probe cost**: from 4 KB best-case to 128 bytes. Roughly 30× less data per probe.
- **Probe latency**: from ~170 ms (range, c=100, 5G) to ~80 ms (one RTT, no slow-start ramp for 128B).
- **Parser complexity**: from five format parsers + SOF walker + SVG regex to one DataView unpack. Dead code volume drops.
- **Zero format gaps**: AVIF, HEIC, JPEG-XL all work the same way — wrap in container.
- **CRC verification**: every probe is cryptographically verified for transfer integrity, free.

The downside is server adoption: nobody's images are in `.prei` today. The upside is the adoption path is gradient (one origin at a time, edge-worker accelerator, opt-in per image).

## Out of scope for this PR

- Browser-native support (phase 4).
- Color profile round-tripping.
- EXIF orientation preservation in the prefix (today's orientation lives in the JPEG payload, which is unchanged).
- Container-aware CDN pricing model negotiation.
