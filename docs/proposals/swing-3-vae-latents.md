# Swing 3 — Ship VAE latents, not images

> Status: research. Draft PR against `main`. Not merged, probably months of work, non-trivial probability of not panning out. Worth trying.

## Problem

Every perceptual-quality placeholder approach today is a smudge:

- Blurhash / thumbhash → colored blur, 20-40 bytes. Recognizable as "roughly this color in that corner," not as "this image."
- LQIP → base64-encoded 16×16 JPEG. Squinting required.
- Dominant color → a single swatch.
- Shimmer skeleton → confesses nothing about the image at all.

The real image arrives 100-400 ms later (per our benchmarks, once actual bytes flow and decode completes). During that window we show the user a lie: "something is loading," when we could be showing the user **the image**, just at lower fidelity.

Separately, images on the wire are fat. A typical photography portfolio JPEG is 300-500 KB. Even with aggressive re-encoding and responsive variants, you're shipping hundreds of KB per above-the-fold image. For 10k-tile catalogs this is multi-megabyte territory.

## Proposal

Encode each image server-side to a **small latent representation** using a VAE (variational autoencoder). Ship the latent (~4 KB) in the manifest. Client decodes the latent via **WebGPU inference** to get a full-resolution, color-accurate, recognisable approximation of the real image. Paint that as first paint. When the real image bytes arrive over the normal path, replace the latent-decoded version with the crisp one — if the latent reconstruction is faithful enough, the user may not consciously notice the swap.

This isn't a blur placeholder that happens to be colorful. **It is a low-rank image compression scheme** whose decoder happens to be a small neural network.

### What changes

- Manifest grows a `latent: Uint8Array` field per entry (~4 KB base64 or binary).
- Client fetches a small WebGPU model (~20 MB, cached across all preimage-using origins) once.
- On page load, for every above-the-fold image, decode the latent → paint. Time to first paint = latent-decode time (projected: <5 ms per image on consumer GPUs, batched across multiple images per shader dispatch).
- Real image bytes are still fetched via the existing `prepare()` machinery; when they arrive, `prepared.element.src = url` and the `<img>` fade replaces the latent paint.

### Why it works

A typical Stable Diffusion VAE reduces a 512×512×3 image (786 KB) to a 64×64×4 latent tensor (~16 KB). Quantizing the latent tensor from float32 to int8 drops that to ~4 KB. The decoder reverses this: tensor → image. Reconstruction loss is the squared-error between the decoded image and the original. Published SD-VAE reconstructions are faithful enough that most viewers can't distinguish decoded-from-latent vs original at thumbnail sizes, and the errors they do contain are in high-frequency texture — exactly the stuff that's invisible while an image is loading.

**"First paint" flips from a colored blur to a full-resolution image that's within 2-3 dB PSNR of the real thing.** That's the paradigm shift.

## How the pieces fit

### Encoder (server-side, build-time)

```bash
preimage-latent ./public/photos --model sd-vae-f8 --out ./public/photos-latents.json
```

- Loads each image, resizes to the VAE's input resolution (typically 256×256 or 512×512).
- Runs the encoder network to get a latent tensor.
- Quantizes to int8 via a fitted scale + zero-point.
- Serializes as compact bytes (raw or base64).
- Writes a manifest entry: `{ width, height, latent: "base64…", latentScale: 0.18 }`.

Dependency: **ONNX Runtime or a small VAE port.** This is the real dep question for this swing. Options:
- `onnxruntime-node`: ~200 MB, supports any VAE exported to ONNX. Best coverage, biggest install.
- `transformers.js` (@huggingface): Node-compatible, ships CPU inference via WASM, smaller.
- **Custom-trained small VAE**: train a 4-channel VAE specifically for compression-quality at 4 KB budget. ~5M params, ships as a 20 MB model weight. Own the whole pipeline.

Custom-trained VAE is the research swing. Start with an off-the-shelf SDXL-VAE port for prototyping.

### Decoder (client-side, runtime)

```ts
import { createLatentDecoder } from '@somnai-dreams/preimage/latent'

const decoder = await createLatentDecoder({ model: '/models/preimage-vae-decoder.wbn' })
// WebGPU compute shader, one-time model load

// Paint the latent as first paint:
const img = await decoder.decode(entry.latent, entry.latentScale, { width, height })
ctx.drawImage(img, x, y)
```

Decoder lives behind the `@somnai-dreams/preimage/latent` subpath export so callers who don't want WebGPU weight on their bundle never pay the cost. `pages/demos/latent.html` is the flagship demo.

Critical path: latent arrives as part of the manifest → decoder emits `ImageBitmap` → paint. No network per-image for first paint; only the real-image fetch.

### Rendering integration

```ts
// Consumer code:
const entry = manifest[url]
const prepared = preparedFromMeasurement(
  recordKnownMeasurement(url, entry.width, entry.height),
  'manifest',
)
// Use the latent for first paint:
const bitmap = await decoder.decode(entry.latent, entry.latentScale)
tile.style.backgroundImage = `url(${bitmapToDataUrl(bitmap)})`
// Eventually replace with the real thing:
const img = new Image()
img.src = url
img.onload = () => {
  tile.removeAttribute('style') // drop the background
  tile.appendChild(img)
}
```

Clean composition with Swing 1: the `.prei` container could carry latent bytes in its reserved block, making latent + image + dims a single fetch.

## Adoption path

1. **Phase 0** — literature review + model choice. Pick SD-VAE-f8 (from Stable Diffusion 1.5/2.1) as baseline. Benchmark reconstruction quality at 256×256 output on a 100-image test corpus.
2. **Phase 1** — offline prototype. Node script: encode 100 images to latents, decode on a single-page WebGPU demo. Measure: latent bytes, decode latency, PSNR vs original, subjective "would I notice the swap" on N observers.
3. **Phase 2** — integration. `preimage-latent` CLI, `@somnai-dreams/preimage/latent` client module. Demo page showing gallery-of-latents vs gallery-of-thumbhashes vs gallery-of-skeletons, side by side.
4. **Phase 3** — mobile GPU feasibility. Measure decode latency on mid-range phones (Pixel 6, iPhone 13). Quality knob: is the decoder too heavy on mobile? Drop to a smaller custom VAE if so.
5. **Phase 4** — custom-trained small VAE. Train a 4-channel VAE with a compression loss optimizing for 4 KB budget. Publish weights, ship with the library. This is the ambitious version.

Phase 1 is the gate: if decode latency at 256×256 is >50 ms on a typical laptop GPU, abandon. If quality is worse than a base64-JPEG LQIP at the same byte budget, abandon. If either hurdle is cleared, push to phase 2.

## Open questions

- **Model size in the browser.** 20 MB is cacheable but initial download hurts. Ship a tiny model (~5 MB) good enough for thumbnails; opt into the larger model for hero images. Or host the model via a CDN with long TTL so it's amortized across every site using preimage.
- **Decoder output resolution.** Display at thumbnail size (256×256 or smaller) is always fine. Displaying at hero size (1920×1080) requires a decoder that upscales — tile-based decode, or a super-resolution head.
- **Color accuracy vs subjective quality.** VAEs can drift colors by a few percent. For product photography this matters; for editorial it doesn't.
- **Non-photo content.** Diagrams, screenshots, UI mockups look weird through a photo-VAE. Fall back to thumbhash or skeleton for `format === 'png' && hasAlpha`.
- **Latent quantization tradeoff.** int8 halves the bytes of int16, reducing quality. Custom 4-bit quantization (GPTQ-style) halves again. Find the pareto point.
- **Reproducibility across model updates.** If we ship VAE v1 now and v2 in a year, every site's latents need re-encoding. Version the model in the manifest entry; client must fetch the correct decoder.
- **Privacy.** VAE-decoded images reveal the scene before the user chose to decode it. Accessibility + consent similar to autoplay video. Probably fine for own-content; think about user-uploaded content (social feeds) before shipping.
- **Decode order in a grid.** 5000 tiles can't all decode simultaneously. Batch N tiles per shader dispatch; decode lazily based on viewport visibility. Same logic as virtual scroll; the latent decode IS the first paint, so it should prioritize visible tiles first.
- **Compose with animation.** Still frames only for v1. Animated images (GIF, animated WebP) would need temporal extension.

## Expected impact

- **First paint** goes from "colored blur" to "recognizable image at 2-3 dB below original." For galleries, this is a massive perceptual win; the page feels instant-and-correct rather than instant-and-empty.
- **Bytes on the wire**: per-image latent is 4 KB vs a typical 300 KB JPEG (75× less). If the real image is never needed (thumbnail-only gallery), latents become the sole delivery, and the site is 75× lighter.
- **Decode compute**: shifts from zero (browser native JPEG decode) to ~5 ms per image via WebGPU. Good on desktop, TBD on mobile.
- **New capabilities fall out for free**:
  - Super-resolution: run the decoder at 2x, 4x resolution for crisp zoom. No source bytes needed.
  - Aspect re-cropping: sample the latent differently for 16:9 vs 1:1 without re-fetching.
  - Style interpolation: `lerp(latentA, latentB, 0.5)` gives a blended image. Design system transitions become natural.
  - Content-aware compression: latent preserves semantic content even under aggressive quantization.

## Size estimate

- Encoder CLI + Node VAE inference: ~400 LoC + model weights.
- WebGPU decoder + shader: ~800 LoC (shader authoring dominates).
- Manifest shape extension + SDK integration: ~100 LoC.
- Demo + benchmarks + A/B harness: ~300 LoC.
- Research notebooks (offline, not in-tree): ~1k LoC Python.

**Core library: ~1600 LoC. Plus model engineering (weeks to months) for the custom-VAE path.**

## Out of scope for this PR

- Training a custom VAE. Use off-the-shelf SD-VAE for phases 1-3.
- Video / animation.
- Non-WebGPU fallback (safari pre-17.4 has no WebGPU). Define the API to fall back to thumbhash on those browsers.
- Mobile optimization beyond a feasibility check.
- Accessibility audit of "perceived image before load" as a pattern.

## Why this is the "paradigm shift" swing

Swings 1 and 2 make preimage faster at the thing it already does. Swing 3 **changes what "an image on the web" is.** If you're convinced the model-size cost amortizes (cacheable, reused across sites), then the 300 KB JPEG becomes historical baggage — you'd ship latents, decode locally, fetch full pixels only for user-facing zoom. Images become semantic-content-over-the-wire instead of pixel-data-over-the-wire.

Nobody has done this generally for the web. There's prior art in specific contexts (ML-augmented streaming video, research papers on neural image compression), but no production-shipped library wrapping it for `<img>`-level consumption. If this works, preimage stops being "the image measurement library" and starts being "the image delivery library."

High-risk, high-reward. The reason to put a draft PR up now is to reserve the architecture slot and start measuring quality against real corpora.
