# Swing 3 — Ship VAE latents, not images

> Status: research. Draft PR against `main`. Not merged, probably months of work, non-trivial probability of not panning out. Worth trying.
>
> **A 2-3 day phase-0 feasibility spike gates everything below.** See "Reality check" and "Phase 0 — go/no-go gate" sections. Do the spike before committing any of the projected scope.

## Problem

Every perceptual-quality placeholder approach today is a smudge:

- Blurhash / thumbhash → colored blur, 20-40 bytes. Recognizable as "roughly this color in that corner," not as "this image."
- LQIP → base64-encoded 16×16 JPEG. Squinting required.
- Dominant color → a single swatch.
- Shimmer skeleton → confesses nothing about the image at all.

The real image arrives 100-400 ms later (per our benchmarks, once actual bytes flow and decode completes). During that window we show the user a lie: "something is loading," when we could be showing the user **the image**, just at lower fidelity.

Separately, images on the wire are fat. A typical photography portfolio JPEG is 300-500 KB. Even with aggressive re-encoding and responsive variants, you're shipping hundreds of KB per above-the-fold image. For 10k-tile catalogs this is multi-megabyte territory.

## Proposal

Encode each image server-side to a **small latent representation** using a VAE (variational autoencoder). Ship the latent (~4-8 KB for a 256×256 thumbnail, ~16 KB for 512×512) in the manifest. Client decodes the latent via **WebGPU inference** to get a color-accurate, recognisable approximation of the real image. Paint that as first paint. When the real image bytes arrive over the normal path, replace the latent-decoded version with the crisp one — if the latent reconstruction is faithful enough, the user may not consciously notice the swap.

This isn't a blur placeholder that happens to be colorful. **It is a low-rank image compression scheme** whose decoder happens to be a small neural network.

### What changes

- Manifest grows a `latent: Uint8Array` field per entry (~4 KB base64 or binary).
- Client fetches a small WebGPU model (~20 MB, cached across all preimage-using origins) once.
- On page load, for every above-the-fold image, decode the latent → paint. Time to first paint = latent-decode time (projected: <5 ms per image on consumer GPUs, batched across multiple images per shader dispatch).
- Real image bytes are still fetched via the existing `prepare()` machinery; when they arrive, `prepared.element.src = url` and the `<img>` fade replaces the latent paint.

### Why it works

A typical Stable Diffusion VAE (SD-VAE-f8) reduces a 512×512×3 image (786 KB raw) to a 64×64×4 latent tensor. Raw float32 that's 64 KB; quantized to int8 it's **16 KB**. To fit a 4 KB budget you run at 256×256 input → 32×32×4 latent → ~4 KB at int8. That's the tradeoff — tighter byte budget means smaller decoded resolution.

Published SD-VAE reconstructions at 256×256, int8-quantized: **25-28 dB PSNR, LPIPS ~0.1-0.15**. Soft but recognizable. The errors tend to sit in high-frequency texture and crisp edges (logos, text, line art look melty); smooth photographic content reconstructs well. Scales to larger display sizes with additional softness; 1920px hero images are a stretch without a super-resolution head.

**"First paint" flips from a colored blur to a recognizable photographic image.** That's the paradigm shift — when it works. For text-heavy or UI-heavy content it doesn't work, and the fallback has to kick in.

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

## Reality check

The original version of this proposal oversold. Calibrated numbers:

| Claim | Reality |
|---|---|
| "~4 KB per latent" | 4 KB at 256×256 input, **16 KB at 512×512**. Tighter budget = smaller decoded resolution. |
| "<5 ms WebGPU decode" | **20-100 ms** on a mid-range laptop GPU, **50-150 ms on mobile GPUs**. First decode adds WebGPU warmup. |
| "75× smaller than JPEG" | True vs a 400 KB hero JPEG. Only **10-20× smaller** vs the responsive 40-100 KB thumbnail a real site ships. |
| "20 MB model cached across all sites" | Cross-origin cache partitioning in modern browsers means **every origin pays its own 25 MB first-load**. Not amortized. |
| "Full-resolution first paint" | 256×256 is thumbnail-fit. Hero images need tile-decode or a super-resolution head. |
| "Recognisable as the real image" | Yes for photographic content. **Falls apart on text, logos, UI, line art** (VAE makes them melty). Fallback required. |
| "Weeks to months of work" | Phases 0-2 on pretrained SD-VAE: **2-3 person-months**. Phase 4b from-scratch training: **6-12 months**. |

The hard gate is subjective quality. A latent→real swap that users find jarring kills the premise — you've spent months to ship something worse than a skeleton. Nobody has shipped this in production for general web images; it's research territory, not "apply known technique."

WebGPU coverage is another real constraint. Safari <17.4 and older Android have no WebGPU, so the library needs a thumbhash fallback anyway, which partially defeats the point.

## Phase 0 — go/no-go gate

Before any of the phased scope below, spend **2-3 days** answering one question: *is off-the-shelf SD-VAE at browser-decode speeds producing imagery that's better than thumbhash at the same byte budget, on a real gallery corpus?*

**Spike deliverable:**
- Pull SD-VAE-f8 weights (public, MIT-licensed, Hugging Face).
- Export the decoder to ONNX, wire it through `onnxruntime-web` or a hand-written WebGPU shader — whichever lands faster.
- Encode 20 photos from `pages/assets/demos/photos` at 256×256 to int8 latents via an offline Python script.
- Render a single-page demo: latent-decoded version side-by-side with thumbhash at equal byte budget, side-by-side with the real image.
- Measure decode latency on one desktop browser + one mobile browser with WebGPU available.

**Gate criteria (all three must pass to proceed):**

1. **Subjective A/B.** Show the demo to 5+ people (ideally a mix of technical and non-technical). More than half must rate the latent-decoded version as "better placeholder" than thumbhash. If it's a coin-flip or worse, kill it.
2. **Decode latency.** Desktop: <100 ms single-image, <400 ms for a batch of 8. Mobile: <500 ms single-image (looser bound; mobile is the weak link). If it's multiples worse, kill it.
3. **Content coverage.** Test corpus must include at least one text-heavy image, one logo/UI, and one product photo. If the latent reconstruction visibly corrupts non-photo content more than a skeleton would, document which content types need the thumbhash fallback and whether that fallback rate makes the feature worth shipping at all.

**If any gate fails, update this PR with the measurements and close it.** A bad gate result is a successful spike — the cost of learning is 2-3 days, not 2-3 months.

## Adoption path (gated on Phase 0 passing)

1. **Phase 1 — ship with SD-VAE off-the-shelf.** No ML work. Node-side encoder via ONNX runtime + WebGPU decoder + `@somnai-dreams/preimage/latent` subpath + manifest extension + thumbhash fallback for non-WebGPU browsers and non-photographic content. Demo page with A/B harness. **2-3 person-months.**
2. **Phase 2 — mobile hardening.** Measure decode latency on Pixel 6, iPhone 13, mid-range Android. Batch-decode in a worker, prioritize visible tiles, lazy-decode below the fold. Drop the 25 MB model to an int4-quantized 12 MB version if mobile decode is too slow. **+3-4 weeks.**
3. **Phase 4a — distilled small VAE (the realistic custom-model path).** Use SD-VAE as a frozen teacher; train a student decoder 3-10× smaller on ~100k images. Student preserves quality within ~1-2 dB PSNR with much faster decode. **+1-2 months engineering, ~$5k compute.** Most projects stop here.
4. **Phase 4b — from-scratch rate-distortion-optimized VAE.** Only justified if phase 4a can't hit the quality or size targets for a specific use case. ~6-12 months with 1 ML engineer, **$25-300k in compute** across 5-20 training runs. This is the research lab version.

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

## Expected impact (if Phase 0 passes)

- **First paint** goes from "colored blur" to "recognizable photographic image at 25-28 dB PSNR." For photo-heavy galleries, perceptual win is real. For mixed content (text, UI, diagrams), less so — those fall back to thumbhash.
- **Bytes on the wire**: 4 KB latent at 256×256 vs a typical 40-100 KB responsive thumbnail → **10-20× smaller**. Against a 400 KB hero JPEG it's ~75× smaller, but real sites don't ship hero-sized images for thumbnail slots anyway.
- **Decode compute**: 20-100 ms per image on desktop via WebGPU, 50-150 ms on mobile. Requires lazy/batched decode for galleries above ~50 tiles.
- **Model download**: 25 MB one-time per origin (cache-partitioned). Measurable cost on first visit; free thereafter for that origin.
- **New capabilities fall out for free** (speculative until Phase 2):
  - Super-resolution: decode at 2×, 4× for crisp zoom without re-fetching.
  - Aspect re-cropping: sample the latent differently for 16:9 vs 1:1.
  - Style interpolation: `lerp(latentA, latentB, 0.5)` gives a blended image. Design system transitions.
  - Content-aware compression: latent preserves semantic content under aggressive quantization.

## Size estimate

- **Phase 0 spike** (2-3 days, throwaway code): ~200 LoC Python + ~300 LoC single-page WebGPU demo. Not merged.
- **Phase 1** (2-3 person-months if Phase 0 passes):
  - Encoder CLI + Node ONNX runtime inference: ~400 LoC + model weights download step.
  - WebGPU decoder + shader: ~800 LoC (shader authoring dominates).
  - `@somnai-dreams/preimage/latent` subpath + manifest extension + thumbhash fallback glue: ~200 LoC.
  - Demo + benchmarks + subjective A/B harness: ~300 LoC.
- **Phase 2 mobile hardening**: +300 LoC (worker-based batch decode, visibility prioritization).
- **Phase 4a distillation**: ~500 LoC training code (Python, separate repo) + ~$5k compute.
- **Phase 4b from-scratch**: ~2k LoC training code (Python) + 6-12 months + $25-300k compute.

**Phases 0-2 in-tree: ~2000 LoC.** Phase 4a adds a separate training repo. Phase 4b is a research project.

## Out of scope for this PR

- Training a custom VAE from scratch (Phase 4b). Use pretrained SD-VAE for Phases 0-2, distill for Phase 4a.
- Video / animation.
- Mobile optimization beyond Phase 2's feasibility check + lazy decode.
- Accessibility audit of "perceived image before load" as a UX pattern.
- Thumbhash fallback implementation details (deferred; may live in a separate PR).

## Why this is the "paradigm shift" swing

Swings 1 and 2 make preimage faster at the thing it already does. Swing 3 **changes what "an image on the web" is.** If you're convinced the model-size cost amortizes (cacheable, reused across sites), then the 300 KB JPEG becomes historical baggage — you'd ship latents, decode locally, fetch full pixels only for user-facing zoom. Images become semantic-content-over-the-wire instead of pixel-data-over-the-wire.

Nobody has done this generally for the web. There's prior art in specific contexts (ML-augmented streaming video, research papers on neural image compression), but no production-shipped library wrapping it for `<img>`-level consumption. If this works, preimage stops being "the image measurement library" and starts being "the image delivery library."

High-risk, high-reward. The reason to put a draft PR up now is to reserve the architecture slot and start measuring quality against real corpora.
