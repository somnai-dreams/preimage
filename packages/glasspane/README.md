# `@somnai-dreams/glasspane`

> Status: design proposal, not implemented. Draft PR against `main`. The package directory exists so the proposal and its eventual code can live together.

GPU-resident image rendering for galleries. Sibling to `preimage` (measurement) and `layout-algebra` (pure-math layout) in the monorepo. Where those packages own "what size is this image" and "where does it go," glasspane owns "how does it paint, on which surface, with what effects."

## Problem

Today's preimage render path is CPU-first. `createVirtualTilePool` mounts `<img>` nodes into the DOM; the browser decodes bytes into CPU-side RGBA buffers; the compositor uploads those to the GPU each frame. For galleries this means:

- **Memory pressure.** 200 visible+overscan tiles × 256×256 RGBA = ~50 MB of CPU RAM just for decoded buffers. For 10k-tile feeds on mobile, it's the difference between running and crashing.
- **Virtualization is forced.** We recycle DOM nodes because DOM is expensive and holds CPU-side RGBA. Recycling has mount/unmount churn, layout pressure on `setPlacements`, and subtle bugs (the fix in preimage 0.6.1 shipped to solve one of them).
- **No shader access.** CSS `filter` is coarse and composite-level. Anything beyond `blur()` / `brightness()` / `hue-rotate()` requires manual canvas work, which re-decodes on every frame.
- **Composite-only effects.** Want depth-of-field on hover? Real-time color harmonization across visible tiles? Scroll-velocity motion blur? Not available with CSS. Not cheap to fake.

## Proposal

Images live as **GPU textures from decode to disposal**. The CPU sees bytes and metadata; never decoded pixels. A single scene graph owns the full tile set; the GPU composites what's visible. Shader effects are first-class.

The paradigm shift isn't "faster rendering." It's **"images are drawn content, not DOM nodes."** That reframing unlocks:

1. **No virtualization.** Instancing + atlasing renders 10k tiles as one draw call. LOD streaming replaces mount/unmount — always-present low-res atlas, full-res texture streams in for tiles near the viewport.
2. **Shaders as a creative surface.** Blur, color grade, depth-of-field, perspective warps, motion blur, color harmonization across tiles — all per-pixel, 60fps, trivially composable.
3. **Mobile memory savings.** GPU unified memory pools handle the texture working set natively; the decoded-RGBA-in-CPU-RAM cost goes away. A 10k-tile gallery becomes viable on a mid-range Android.
4. **Future path to spatial UI.** Vision Pro, Quest, spatial browsers are coming. A 2D gallery that's already rendering via WebGPU extends to 3D space (curved walls, reflective floors, volumetric lighting) with compute-shader work — not a rewrite.

## How the pieces compose

```
@somnai-dreams/layout-algebra   pure math, no deps
   ↑
@somnai-dreams/preimage         measurement, prepare(), PrepareQueue, manifest
   ↑
@somnai-dreams/glasspane        GPU-resident rendering + shader effects
                                (new, this package)
```

glasspane consumes preimage for measurement and layout-algebra for placements. preimage doesn't depend on glasspane — sites that don't want WebGPU don't install it and don't pay its install size.

### Public API sketch

```ts
import { createGPUImageScene } from '@somnai-dreams/glasspane'
import { prepare, PrepareQueue } from '@somnai-dreams/preimage'
import { shortestColumnCursor } from '@somnai-dreams/layout-algebra'

const scene = await createGPUImageScene({
  canvas: document.getElementById('gallery-canvas') as HTMLCanvasElement,
  // Scene accepts placements + URLs; handles the texture lifecycle,
  // LOD streaming, and rendering internally.
  initialPlacements: [],
  getUrl: (idx) => urls[idx],
  // Optional shader hooks for creative effects.
  effects: {
    fadeIn: { durationMs: 220 },
    depthOfField: { focusIdx: null, blurRadius: 0 },
  },
})

const queue = new PrepareQueue()
const packer = shortestColumnCursor({ columns: 5, gap: 4, panelWidth: 1200 })
for (const url of urls) {
  const prepared = await queue.enqueue(url, { dimsOnly: true })
  const placement = packer.add(prepared.aspectRatio)
  scene.setPlacement(urls.indexOf(url), placement)
}

// Reactive updates as scroll position changes:
scene.setViewport({ scrollTop, height: 800 })

// Shader effect: focus on tile 42, blur everything else.
scene.setEffects({
  depthOfField: { focusIdx: 42, blurRadius: 8 },
})
```

Contract: the scene owns the canvas, texture lifecycle, render loop, and visibility calculation. Consumers supply placements + URLs; consumers trigger re-renders by setting properties (viewport, placements, effects). No DOM per tile.

### Internal architecture

- **Texture atlas** for low-res (32×32 or 64×64) representations of every known tile. Fits 10k tiles in ~40 MB of VRAM at 64×64×4. Always loaded. Zero-cost to draw at any zoom level below actual-size.
- **Full-res texture pool** for tiles near the viewport. Streams bytes in as tiles approach visible range, evicts furthest-from-viewport when memory pressure hits. Similar eviction logic to the current `createVirtualTilePool`, but operating on GPU textures rather than DOM nodes.
- **Instanced rendering**: one draw call per visible LOD band. All tiles in the same LOD share a pipeline state; vertex shader uses instance ID to look up per-tile transform + texture coordinates.
- **Effect passes**: shader stages run after the tile pass, reading from the scene's color buffer. Blur, depth-of-field, color grade all live as compositable effect functions.

## Reality check

This is the biggest swing we've proposed. Don't undersell the costs.

| Claim | Reality |
|---|---|
| "Works everywhere" | **No.** WebGPU is Chrome 113+, Edge 113+, Safari 17.4+, Firefox 121+ behind a flag. As of Apr 2026 real-world coverage is ~65-75% desktop, ~35-50% mobile. Fallback to preimage's existing DOM pool is mandatory for v1. |
| "No memory cost" | **Mostly false.** GPU texture memory isn't free; it's just cheap per-byte and lives in a pool the GPU can evict smartly. 10k tiles at 1024×1024 RGBA = 40 GB of theoretical texture memory. The LOD + streaming approach manages this, but it's a real design problem, not a solved one. |
| "Custom shaders are easy" | **Depends.** Simple color tint + fade: yes, 20 lines of WGSL. Real-time perceptual blur at arbitrary radii: complex shader engineering, dozens of lines of WGSL + quality tuning per effect. |
| "Scrolls smoother" | **Plausible.** GPU compositing of pre-uploaded textures is faster than CSS re-composite with CPU-decoded sources. But actual mobile framerate depends on GPU power budget and texture bandwidth — needs measurement on real devices. |
| "Ray tracing" | **Not for 2D galleries.** WebGPU compute-shader RT works but is 10-100× slower than hardware RT. The hardware-RT extension is still draft. For 2D image grids, RT is overkill. |
| "5-year spatial UI future" | **Aspirational.** Vision Pro ships spatial browsers today but adoption is single-digit percent. Building now for a market that's 5+ years out is speculative; it's a nice side-benefit, not a justification. |

Honest scope:
- Works on modern desktops and recent iPhones/high-end Android.
- Falls back to DOM path on older browsers (re-uses preimage's existing tile pool).
- Real win is on high-tile-count galleries (>500) on memory-constrained devices.
- Ray tracing is not part of this proposal. RT-adjacent compute-shader effects (soft shadows, ambient occlusion, subsurface scattering) are feasible but out of scope for v1.

## Phase 0 — go/no-go gate

Before committing the full multi-month build, spend **~1 week** on a feasibility spike:

1. **Port `createVirtualTilePool` to a WebGPU-texture-backed variant.** Tiles are instanced quads sampled from a texture pool. 1 draw call per frame. DOM nodes eliminated.
2. **Measure vs the CPU path** on three devices: a desktop, a recent iPhone, a mid-range Android (Pixel 6a tier).
3. **Workloads**: 500, 2000, and 10000 tiles at 256×256 source resolution. Scroll top-to-bottom at 2000 px/s.
4. **Metrics**: peak memory (heap + GPU), sustained frame rate, scroll jank count (>33 ms frames per 100), time-to-all-tiles-visible.

**Gate criteria (all three must pass to proceed to the full build):**

1. **Memory.** Peak consumption on the 10k-tile workload must be **<50% of the CPU path** on the mid-range Android. If we're not meaningfully cheaper on memory, the main payoff isn't there.
2. **Framerate.** Sustained ≥55 fps on the 2000-tile workload on the mid-range Android, with <5 jank events per scroll pass. Below this, we've built a slower-but-fancier version of what already works.
3. **Initial-paint latency.** Time-to-first-tile-visible must be within 100ms of the DOM path. If the WebGPU setup overhead dominates, the "feels instant" promise is dead on arrival.

**If any gate fails, update this PR with the measurements and close it.** WebGPU isn't mature enough to build around yet, or our particular use case doesn't win enough to justify the complexity.

## Adoption path (gated on Phase 0 passing)

1. **Phase 1 — MVP render.** `createGPUImageScene` with placements + static image textures + instanced draw. No shader effects beyond fade-in. LOD streaming, eviction. Fallback to preimage's CPU pool detected via `navigator.gpu`. **~3 weeks.**
2. **Phase 2 — shader effects library.** Color grade, gaussian blur, depth-of-field, color harmonization, scroll-velocity motion blur. Each as a composable effect function with clear perf profile. **~4 weeks.**
3. **Phase 3 — mobile optimization.** Profile on real mid-range Android; tune texture formats (BC7, ASTC), atlas sizes, pool eviction thresholds. Ensure framerate targets hold on 4 GB RAM devices. **~3 weeks.**
4. **Phase 4 — editorial/floating demo.** Integration with pretext-flowed text so figures can live as glasspane textures inside a measured-text flow. Validates the composition model. **~2 weeks.**
5. **Phase 5 — spatial UI exploration (optional).** Port the scene to render into a WebXR session. Curved virtual walls, reflective floors, volumetric lighting. Aspirational; only justified if spatial browsers take off. **Indeterminate.**

Phases 1-3 are the shippable scope. Phases 4-5 are speculative future work.

## Expected impact (if Phase 0 passes)

- **Memory on 10k-tile mobile galleries**: 50-80% reduction vs DOM path.
- **Sustained frame rate during scroll**: 55-60 fps consistently, vs 35-50 fps with occasional stalls on DOM path.
- **Virtualization churn**: gone. No mount/unmount events during normal scroll.
- **Shader effects at 60fps**: blur, color grade, depth-of-field, motion blur — all genuinely 60fps even on mid-range devices.
- **Creative-tool design space**: first web image library where shader-level effects are in scope. Differentiator in the AI-image-gen tooling space.
- **Composition with pretext**: pretext computes text layout; glasspane renders image figures inside it. Both libraries compose cleanly without either taking on the other's concern.

## Size estimate

- **Phase 0 spike**: ~600 LoC throwaway. Not merged unless gates pass.
- **Phase 1 MVP**: ~1500 LoC (scene, atlas, LOD pool, instanced rendering, fallback detection, DOM-pool bridge).
- **Phase 2 shader library**: ~1200 LoC (each effect ~100-200 LoC including WGSL shaders).
- **Phase 3 mobile optimization**: ~300 LoC of tuning + measurement harness.
- **Phase 4 pretext integration**: ~400 LoC (text-flow adapter, figure placement handshake).
- **Demo + bench pages**: ~500 LoC.

**Phases 1-3 total: ~3500 LoC.** Significant but in range for a dedicated sibling package.

## Open questions

- **Texture format.** Ship compressed textures (BC7 / ASTC / ETC2) for compactness, or rely on runtime compression from PNG/JPEG sources? Compressed textures save ~4× memory but require build-time transcode or runtime GPU-side encode. Probably phase 3's problem.
- **Atlas hashing.** If two tiles share the same source URL, do they share a texture slot? Cross-tile dedup is free and cheap on GPU; should be on by default.
- **EXIF orientation.** Browser `createImageBitmap` can apply orientation during decode; need to verify the path is lossless into the WebGPU texture.
- **Animated images.** GIF, animated WebP, animated AVIF. Texture streaming per-frame is expensive. Probably out of v1 scope; flag the limitation.
- **Devtools story.** How does a site author inspect the scene state? Needs a debug panel showing LOD assignments, pool occupancy, texture memory, active effect chain.
- **Test strategy.** Headless Chromium with `--enable-unsafe-webgpu` can run WebGPU; reference image comparison for shader output. Need a baseline capture workflow.

## Out of scope

- **Hardware ray tracing.** WebGPU RT extension is draft; compute-shader RT is too slow for 2D galleries. Reconsider when the extension ships (~2-3 years out).
- **Video rendering.** Same pipeline conceptually but different constraints (frame rate, sync). Out of v1.
- **Spatial/3D UI beyond a demo.** Phase 5 is exploratory only.
- **Native custom decoders.** Roll our own JPEG/PNG/WebP/AVIF decoder in WGSL. Too ambitious; rely on `createImageBitmap` for decode, target GPU-resident after that.
- **Cross-browser shader portability harness.** Stick to core WGSL that works on all WebGPU implementations; no WGSL extensions in v1.

## Why this is a sibling package, not a preimage subpath

The scope is genuinely different:

| | preimage | glasspane |
|---|---|---|
| Primary concern | measurement | rendering |
| Browser requirement | HTMLImageElement | WebGPU |
| Failure modes | network errors | GPU context lost, shader compile |
| Code shape | one-shot `prepare()` + queue | imperative frame loop + scene graph |
| Target audience | any site with images | galleries wanting shader-level control |
| Install-size impact of always-bundling | negligible | substantial (WGSL + WebGPU types + LOD logic) |
| Release cadence | tied to measurement API stability | tied to WebGPU spec stability |

A site that wants measurement but not GPU rendering shouldn't install WebGPU types or shader code it will never load. A site that wants GPU rendering but has its own measurement pipeline shouldn't be forced to take preimage's `prepare()` surface.

Sibling package is the honest architectural answer.

## Status of this document

Draft PR against `main`. The package directory exists; the code does not. Merge criteria: either the Phase 0 spike passes and this becomes a real build plan, or it fails and this PR closes with the measurements attached as evidence.
