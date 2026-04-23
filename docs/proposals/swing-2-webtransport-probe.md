# Swing 2 — Batched probing over a persistent transport

> Status: exploratory. Draft PR against `main`. Not merged, not targeted at a release.

## Problem

500 probes today = 500 HTTP/2 streams. Even at the optimal `range` strategy on a fast 5G tether we max out at **1350 probes/sec** (from `benchmarks/probe-sweep-2026-04-23T02-57-21-533Z.json`), bandwidth-bound by 2.2 MB of range payloads. Per-probe marginal cost:

- TCP slow-start amortized across the connection — mostly free at steady state.
- One H2 stream per probe — framing overhead, HEADERS + DATA per request.
- Server-side per-request work: open file, seek, read 4KB, build 206 response.
- Client-side per-request work: `fetch()`, Response object, arrayBuffer promise chain.

At 1350/s the wall time for 10k probes is ~7.4 seconds. For 100k probes (a product catalog, a photo archive), it's 74 seconds. Layout-first flows fall apart at that scale.

The fundamental waste: **each probe reopens a conversation.** Server doesn't know the next request exists until it arrives. Client can't amortize parser or framing setup across requests. We have 500 tiny conversations when we could have one big one.

## Proposal

A preimage-aware server endpoint that accepts **a batch of URLs in a single request** and streams back a **single framed response** with probe results. Client-side runs inside a **service worker** so consumer code (`prepare(url)`) doesn't change — the SW intercepts image-probe-range-fetches and coalesces them.

Two transport options, both on the table:

**Option A: HTTP/2 POST batch.** `POST /preimage/probe` with body `{ urls: ["..."] }`, response body is a length-prefixed stream of `{ url, width, height, hasAlpha, isProgressive, byteLength, thumbhash? }` records. One request, one response. Simple. Works over existing H2 infra.

**Option B: WebTransport datagram stream.** `CONNECT` a WebTransport session at the start of the page. Every `prepare()` sends a QUIC datagram with the URL; server responds on a bidirectional stream with the probe result. No TCP head-of-line blocking, sub-RTT cancellation, per-datagram retry, persistent session across pages via SW.

Option A is shippable this quarter. Option B is the ceiling. Design the protocol to fit both.

## Protocol sketch

Wire format, language-agnostic, stays stable across A/B:

```
request:  [u32 url-count] ( [u16 url-len] [url-utf8] )*
response: [u32 result-count] ( record )*

record:
  [u16 url-len] [url-utf8]   — echo the URL for correlation
  [u8 status]                 — 0 ok, 1 not-found, 2 probe-failed, 3 denied
  if status == 0:
    [u32 width] [u32 height]
    [u16 flags]               — hasAlpha, isProgressive, colorspace, format
    [u64 byteLength]
    [u8 thumbhashLen] [thumbhash bytes]  — 0 if none
```

Server is a static-file probe in the simplest deploy. For each URL:
1. Resolve to a local path or S3 key.
2. Read first 4 KB via `fs.read` or S3 `Range: bytes=0-4095`.
3. Run `probeImageBytes` — the existing preimage header parser.
4. Append a record to the response.

Server can parallelize the 4KB reads internally (thread pool / libuv), but the **client pays one RTT** for the entire batch regardless.

## How the pieces fit

### Client (service worker)

Existing `prepare()` / `PrepareQueue` code doesn't change at all. The SW intercepts network requests matching the probe pattern and coalesces them:

```
pages load → registers SW
consumer code → queue.enqueue(url, { dimsOnly: true })
prepare() → fetch(url, { headers: { Range: 'bytes=0-4095' } })
SW intercept.onFetch(event) →
  if event.request is a preimage probe →
    push URL onto a batch, wait up to 8ms or 100 URLs
    POST /preimage/probe { urls: [...] }
    on response:
      for each result, synthesise a 206 Response with { dims encoded as fake JPEG bytes? }
      respond to the original fetch() with that synthesised response
```

The tricky bit: `prepare()` expects to parse actual image bytes. Two paths:

**Path A — synthesize a minimal valid header.** SW receives `{ width, height }` and constructs a minimal PNG IHDR chunk (24 bytes) matching those dims. `probeImageBytes` parses it, returns the right answer. Hacky but localised.

**Path B — new strategy `batched`.** `prepare()` gains a strategy that skips the parser and reads dims from a side channel (the SW's structured response). Cleaner. Requires SW registration to be a hard prerequisite, which it isn't today.

Go with Path B for the initial PR. Path A is a retrofit for no-SW environments.

### Server

A small Bun/Node service: `bun run preimage-probe-server ./public/photos --port 3001`. Accepts batches, reads header bytes from disk, responds in the wire format above. Ships as part of `@somnai-dreams/preimage` (or a sibling `@somnai-dreams/preimage-server` package).

For S3/GCS origins, use `GetObject` with a `Range` header under the hood — server-side range is free and keeps the archive as source of truth. Server process can run next to the app or as an edge worker (Cloudflare Worker, Vercel Edge Function, Fastly Compute).

### Adoption path

1. **Phase 0** — protocol lock + lossless roundtrip test with a fixture corpus.
2. **Phase 1** — reference server (Bun). Client-side SW + `'batched'` strategy. Localhost demo: `pages/demos/batched.html` shows 5000 URLs resolving in one RTT.
3. **Phase 2** — production-ready server. Rate limiting, auth pluggable, S3 adapter, observability. Deployed at `probe.preimage.dev` or wherever.
4. **Phase 3** — WebTransport transport as an alternative binding of the same protocol. Zero-RTT resume for returning visitors.
5. **Phase 4** — work with image CDNs (Cloudinary, imgix, Bunny) to expose native batch probes as `/multi-dims`. The SW-intercept becomes a thin shim.

Phases 1-2 are shippable scope. Phase 3 is the "crazy swing" half of this proposal.

## API sketch

```ts
// SW registration helper:
import { registerBatchedProbe } from '@somnai-dreams/preimage/sw'

registerBatchedProbe({
  endpoint: 'https://probe.example.com/preimage/probe',
  maxBatchSize: 100,
  maxBatchDelayMs: 8,
  fallback: 'auto', // if the endpoint errors or is unreachable
})

// Consumer code is unchanged:
const prepared = await prepare(url, { dimsOnly: true, strategy: 'batched' })

// Or via PrepareQueue, unchanged:
queue.enqueue(url, { dimsOnly: true, strategy: 'batched' })
```

## Open questions

- **Correlation.** Request ordering isn't guaranteed equal to response ordering in a streaming protocol. Echo the URL in the response record (above). Overhead is real (~50 bytes per URL); for 5000 URLs that's 250 KB. Compress by echoing a `u16 clientIndex` into the original urls array instead of the full URL string. Subtract ~95% of the overhead.
- **Batching trigger.** Time-window vs size-window. 8ms delay before first batch flushes is conservative — shorter for small batches, longer for sustained load. Adaptive based on inter-arrival rate is ideal. Start with fixed 8ms.
- **Failure modes.** Endpoint down → each enqueue falls back to `auto` per-url. Partial failures (some URLs 404) reported per-record, not as a batch failure. Transient 5xx → retry the batch once, then fall through.
- **Auth.** Probes can leak which URLs you're interested in. Production deploys need signed tokens or IP allowlists. First version: same-origin only.
- **Cache semantics.** The SW can maintain its own probe cache separate from the library's `measurementCache`. Dedup batches per-SW-session. Never promote batched probes to the browser's HTTP cache — they're dimensional metadata, not image bytes.
- **Service worker registration friction.** SW needs HTTPS, a scope, a registration flow. Not a dealbreaker but it's a chunk of adopter overhead. Document clearly. Worst case, expose a non-SW direct-POST strategy `'batched-direct'` that coalesces in-JS without interception.
- **Connection reuse with WebTransport.** Phase 3 wants the session to persist across navigations. Service workers survive navigations; the SW owns the WebTransport session. Clean architecture.

## Expected impact

Baseline (range, c=100, 5G): 1350 probes/sec, 2.2 MB total transfer for 500 URLs, ~370ms wall.

Projected (batched, one POST per 500 URLs):
- Transfer: 500 × ~50B correlation data + 2.2 MB server-side seek-and-read → but **server sends only the probe results, ~40 bytes per URL**. 500 × 40 = 20 KB response.
- **Total transfer: ~25 KB for 500 URLs** (vs 2.2 MB). 90× less data.
- Wall: one RTT + server parallel-probe time. ~100ms for 500 URLs on the same 5G network.
- **Throughput ceiling: 5000 probes/sec** at the client. Server-bound beyond that (proportional to its probe-per-URL cost, typically 0.1-1ms on warm disk).

Net: **5× throughput, 90× less bandwidth**. For 10k URLs, drops from 7.4s to ~2s.

## Size estimate

- Service worker + `batched` strategy + registerBatchedProbe helper: ~250 LoC.
- Reference server (Bun): ~200 LoC. Reuses `probeImageBytes` from `@somnai-dreams/preimage/core`.
- Wire-format encoder/decoder: ~150 LoC (shared between client and server).
- Demo page + bench extension: ~150 LoC.
- WebTransport binding (phase 3): +200 LoC.

**Phases 1-2 total: ~750 LoC. One and a half person-weeks.**

## Out of scope for this PR

- Distribution: hosted endpoint, DNS, TLS certs, operator cost.
- Rate limiting, DoS protection beyond obvious same-origin enforcement.
- Caching in an intermediary CDN layer.
- Proactive scraping of URLs the client hasn't asked about yet.

## Composability note

This swing stacks with Swing 1 (container) beautifully: a batched-probe server that serves `.prei`-wrapped images can respond with just the 128-byte prefix per URL instead of parsing payloads at probe time. Batched + container = **~5 KB total for 500 probes**. That's within a single UDP datagram cluster.
