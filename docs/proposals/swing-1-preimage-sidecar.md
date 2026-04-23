# Swing 1 — `Preimage-*` headers + `.prei` sidecar files

> Status: phase 1 shipped. Draft PR against `main`.
>
> Supersedes [PR #2](https://github.com/somnai-dreams/preimage/pull/2), which proposed a binary wrapper around image bytes. Pivoted after a sense-check: the wrap broke `<img>` compat, needed an edge worker or dual URLs to ship, and the value over `auto`+`range` was marginal in the common case. Sidecar + headers reaches the same metadata payload with less friction and a viable adoption path.

## Problem

`preimage` has accumulated four probe strategies (`img` / `stream` / `range` / `auto`) and a handful of header parsers because an image file on the web doesn't carry its metadata in a way that clients can cheaply ask for. Each strategy is a different workaround for the same problem.

The fundamental fix is a convention where **the origin declares the metadata and the client just reads it.** Not a byte parser. Not a range heuristic. A side-channel whose only purpose is to carry dims, flags, format, and byte counts.

## Proposal

A single wire format in two physical shapes:

### Shape 1: HTTP response headers on the image

```http
HEAD /photos/sunset.jpg HTTP/1.1
---
HTTP/1.1 200 OK
Content-Type: image/jpeg
Content-Length: 483721
Preimage-Version: 1
Preimage-Width: 1920
Preimage-Height: 1080
Preimage-Format: jpeg
Preimage-Byte-Length: 483721
Preimage-Progressive: 1
Preimage-Sha: 7688025819abcdef
Preimage-Thumbhash: 2qcGDQKnh3d6eHd3h3d4iHh4eA==
```

Client probes with `HEAD image-url`, reads the `Preimage-*` headers, **never downloads the body**. One RTT, zero content bytes.

### Shape 2: `.prei` sidecar file

```
GET /photos/sunset.jpg.prei
---
Preimage-Version: 1
Preimage-Width: 1920
Preimage-Height: 1080
Preimage-Format: jpeg
Preimage-Byte-Length: 483721
Preimage-Progressive: 1
Preimage-Sha: 7688025819abcdef
Preimage-Thumbhash: 2qcGDQKnh3d6eHd3h3d4iHh4eA==
```

A plain-text file of **byte-identical format** to the response-header shape. For static origins that can drop files but can't configure custom headers. `preimage-sidecar` CLI walks image directories and writes one `.prei` next to each image. Image bytes are never touched.

### Why it works

The parser is the same for both shapes. Lines of `Key: Value`. HTTP is already this format; the sidecar is just the HTTP headers serialized to disk. Clients try `'headers'` → `'sidecar'` → `'range'` (existing byte probe) in a gracefully-degrading waterfall.

## Field vocabulary (v1)

| Header | Required | Example |
|---|---|---|
| `Preimage-Version` | yes | `1` |
| `Preimage-Width` | yes | `1920` |
| `Preimage-Height` | yes | `1080` |
| `Preimage-Format` | yes | `jpeg` (or `png`, `webp`, `avif`, `gif`, `svg`, `bmp`) |
| `Preimage-Byte-Length` | no | `483721` |
| `Preimage-Has-Alpha` | no | `0` or `1` |
| `Preimage-Progressive` | no | `0` or `1` |
| `Preimage-Sha` | no | first 8 bytes of sha256 as hex |
| `Preimage-Thumbhash` | no | base64-encoded thumbhash |

Unknown fields are ignored (forward-compat). Values are trimmed. Empty lines are ignored. Case-insensitive header names (per HTTP convention) so callers don't get tripped up on `preimage-width` vs `Preimage-Width`.

## Adoption path

The target adopter isn't an existing CDN — it's **the AI-image generator pipeline**. Midjourney, Stable Diffusion-as-a-service, Sora, Imagen-serving apps all:

- Already know every piece of metadata we'd want (dims, format, byte size, alpha, and their generation pipeline could trivially hash or thumbhash).
- Own both the generation and the hosting.
- Serve images into creative apps that suffer from layout-shift problems the web is already tired of.
- Aren't locked into a CDN's feature-request queue — they run their own middleware.

**The pitch for an AI-image-gen backend:**
- "You already have the metadata. Emit it."
- "Every app that renders your outputs gets zero-layout-shift first paint without writing probe code."
- "It's a 15-line change in your image-serving middleware."
- "Your images become differentiably better to display than a stock JPEG."

Zero standards-body work, zero W3C proposal, zero CDN evangelism. Build the tech well, demonstrate it on the bench page, let a few AI-gen startups discover the convention via the cheng-ecosystem story.

**Phase 1 (this PR):**
- `encodeSidecar` / `decodeSidecar` / `decodeSidecarHeaders` / `sidecarToResponseHeaders`
- `strategy: 'headers'` and `strategy: 'sidecar'` in `prepare()`
- `preimage-sidecar` CLI (one file / --batch / --inplace)
- Dev server synthesises `Preimage-*` headers on all image responses AND serves `.prei` files on the fly, so the demo is self-contained
- `pages/demos/sidecar.html` runs headers vs sidecar vs range side by side

**Phase 2 (future, if a real consumer appears):**
- `strategy: 'auto'` opts into `'headers'` as the first tier of the waterfall (HEAD the image, fall to sidecar on miss, fall to range on sidecar miss). Currently callers opt in explicitly because we can't risk a false `Preimage-Version` in the wild.
- Bench extension: `/bench/sweep.html` picker gets `headers` and `sidecar` alongside img/stream/range.

**Phase 3 (aspirational):**
- Pitch a real `Image-Width` / `Image-Height` / `Image-Format` IANA header registry once a meaningful population of origins ships `Preimage-*`. Rename with a deprecation path. If nobody ships `Preimage-*`, no IANA discussion happens and no harm done.

## Open questions

- **Sha field.** Currently first 8 bytes of sha256 as hex (16 chars). Used for dedup across URLs — same bytes hosted at different paths can be cache-collapsed. Nice-to-have, not critical. `--no-sha` skips the compute at encode time.
- **Thumbhash encoding.** Currently a base64 string field, max content-dependent. Decoder in preimage doesn't exist yet (see Swing 3 vote). Field is reserved so pipelines can emit thumbhashes today and clients render them later.
- **HEAD request CORS.** Some origins strip CORS on HEAD. Client code falls through to sidecar transparently if HEAD fails. Worth documenting.
- **Cache-keying.** CDNs may or may not include custom headers in their cache key. Origins that want per-image-response `Preimage-*` need to ensure their CDN preserves them across cache hits. Spec is silent; implementation notes will call this out.
- **Content negotiation.** Do we want `Accept: application/vnd.preimage+json` as a signal that the client understands preimage? Probably not; the presence of `Preimage-Version` in the response is already the opt-in signal. Avoid protocol bloat.

## Size estimate

- `sidecar.ts`: ~180 LoC (encode, decode, decodeFromHeaders, sidecarUrlFor, sidecarToResponseHeaders)
- `prepare.ts` extensions: ~100 LoC for `prepareFromUrlHeaders` + `prepareFromUrlSidecar` + waterfall fallback
- `sidecar-cli.ts`: ~190 LoC (arg parsing, walk, encode, batch/inplace/single modes)
- Dev server synthesis: ~60 LoC (attach headers to image responses, serve `.prei` on-the-fly)
- Demo page + TS: ~220 LoC

**Total: ~750 LoC. In-tree, works end-to-end after `bun run start`.**

## Trade-offs vs the original wrap proposal

| | Binary wrap (archived #2) | Sidecar + headers (this PR) |
|---|---|---|
| Byte size | 128 fixed | ~150-300 typical |
| Browser compat | Breaks `<img>` tags | Zero effect on image |
| Debuggability | Needs hexdump | `curl -I` just works |
| Extensibility | Version byte + reserved bytes | Add another header line |
| Encoder complexity | DataView byte packing + CRC32 | `Object.entries().map().join('\n')` |
| Publisher setup | Transcode step + edge worker or dual URLs | Drop text files OR set response headers |
| Adoption path | Invent a binary format | Reuses HTTP's existing plumbing |

The binary wrap's **one** genuine advantage was atomicity — metadata and payload cannot drift out of sync. For archival workflows that matters; for the web it doesn't. The sidecar is strictly simpler.

## What's out of scope

- Native `Image-*` IANA header registration.
- CDN-level configuration docs (per-CDN plugin guides).
- Middleware for popular frameworks (Next.js, Astro, Vite) — depends on a real consumer asking for it.
- Thumbhash encoder (gated on Swing 3's decision).
- Response-header propagation through service workers and proxy caches (notable in the deployment guide, not this library's job).
