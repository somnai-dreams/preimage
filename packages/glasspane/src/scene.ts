// GPU-resident image scene. Phase 0 spike — not production-ready.
//
// Parallel to preimage's `createVirtualTilePool` but drives a `<canvas>`
// instead of DOM nodes:
//   - Placements live in a GPU storage buffer (one tile per instance).
//   - Image bytes decode via `createImageBitmap` and upload to a
//     texture_2d_array on the GPU. CPU never holds RGBA.
//   - Visibility is a CPU-side scroll check that updates which slots
//     in the storage buffer are active; the GPU draws every active
//     instance in one call.
//   - Eviction is LRU — when active tiles exceed the texture array's
//     layer count, the least-recently-used slot gets reclaimed.
//
// Not shipped in v0:
//   - LOD atlas (no low-res always-loaded representation yet).
//   - Shader effects beyond fade-in opacity.
//   - Scroll-velocity adaptation.
//   - Fallback detection (consumer checks `navigator.gpu` before calling).
//
// The goal of this spike is the Phase 0 gate measurement: memory,
// framerate, initial-paint-latency vs the DOM pool at equal
// workloads. See /bench/glasspane-spike.html.

export type Placement = {
  x: number
  y: number
  width: number
  height: number
}

export type GlasspaneSceneOptions = {
  /** Target canvas. Must be sized (via CSS or width/height attributes)
   *  before this is called; the scene reads the canvas's client size. */
  canvas: HTMLCanvasElement
  /** How far beyond the visible range to treat tiles as active.
   *  Default 400px on both sides. */
  overscan?: number | { ahead: number; behind: number }
  /** Max concurrent textures the scene allocates. Sets the upper
   *  bound on how many tiles can be visible + overscanned at any
   *  time. Too low → visible tiles flicker; too high → more VRAM.
   *  Default 256 (covers ~4× a typical first viewport). */
  maxActiveTiles?: number
  /** Per-tile texture size the scene allocates on the GPU. Images
   *  are resized to this during upload. 256 is a good thumbnail
   *  default; 512 for hero galleries; 1024 for high-detail. */
  tileTextureSize?: number
  /** Fade-in duration (ms) when a tile's image becomes ready. */
  fadeMs?: number
}

export type GlasspaneScene = {
  /** Replace the placement array. Typically called once at setup or
   *  whenever the layout recomputes (e.g. viewport resize). */
  setPlacements(placements: readonly Placement[]): void
  /** Update scroll position (CSS pixels from the top of the content).
   *  Triggers a visibility recompute + render on the next frame. */
  setScroll(scrollY: number): void
  /** Fetch an image for a tile and upload it to a GPU texture slot.
   *  The slot is assigned lazily on first request; if the scene is
   *  over capacity, the LRU slot is evicted. */
  setTileImage(idx: number, url: string): Promise<void>
  /** Cancel any in-flight request for this tile. Does not evict the
   *  texture if already uploaded — use `clearTile` for that. */
  cancelTileImage(idx: number): void
  /** Evict a tile's texture slot, freeing it for reuse. */
  clearTile(idx: number): void

  /** Diagnostic: how many tiles currently occupy texture slots. */
  readonly activeTileCount: number
  /** Diagnostic: visible tile indices (excluding overscan). */
  readonly visibleTileCount: number

  /** Stop rendering + release GPU resources. */
  destroy(): void
}

const INSTANCE_STRIDE_FLOATS = 8 // 32 bytes: vec4<f32> xywh + u32 layer + f32 opacity + 2xpadding

const WGSL = /* wgsl */ `
struct Tile {
  xywh: vec4<f32>,
  layer: u32,
  opacity: f32,
  _pad0: f32,
  _pad1: f32,
};

struct Viewport {
  scrollY: f32,
  canvasWidth: f32,
  canvasHeight: f32,
  _pad: f32,
};

@group(0) @binding(0) var<storage, read> tiles: array<Tile>;
@group(0) @binding(1) var<uniform> viewport: Viewport;
@group(0) @binding(2) var tileTextures: texture_2d_array<f32>;
@group(0) @binding(3) var tileSampler: sampler;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) @interpolate(flat) layer: u32,
  @location(2) opacity: f32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) iid: u32,
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
  );
  let c = corners[vid];
  let t = tiles[iid];
  let pixelX = t.xywh.x + c.x * t.xywh.z;
  let pixelY = t.xywh.y - viewport.scrollY + c.y * t.xywh.w;
  let clipX = (pixelX / viewport.canvasWidth) * 2.0 - 1.0;
  let clipY = 1.0 - (pixelY / viewport.canvasHeight) * 2.0;
  var out: VSOut;
  out.position = vec4<f32>(clipX, clipY, 0.0, 1.0);
  out.uv = c;
  out.layer = t.layer;
  out.opacity = t.opacity;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let sampled = textureSample(tileTextures, tileSampler, in.uv, i32(in.layer));
  // Slot layer == 0xFFFFFFFF is the "no texture" sentinel; draw skeleton.
  if (in.layer >= 4294967295u) {
    return vec4<f32>(0.85, 0.87, 0.89, in.opacity);
  }
  return vec4<f32>(sampled.rgb, sampled.a * in.opacity);
}
`

export async function createGlasspaneScene(
  options: GlasspaneSceneOptions,
): Promise<GlasspaneScene> {
  if (navigator.gpu === undefined) {
    throw new Error('glasspane: navigator.gpu is undefined. WebGPU not supported here.')
  }

  const canvas = options.canvas
  const maxActiveTiles = options.maxActiveTiles ?? 256
  const tileTextureSize = options.tileTextureSize ?? 256
  const fadeMs = options.fadeMs ?? 220
  const overscanAhead =
    typeof options.overscan === 'object' ? options.overscan.ahead : (options.overscan ?? 400)
  const overscanBehind =
    typeof options.overscan === 'object' ? options.overscan.behind : (options.overscan ?? 400)

  // --- Device ---
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter === null) throw new Error('glasspane: no GPU adapter available.')
  const device = await adapter.requestDevice()
  const rawContext = canvas.getContext('webgpu')
  if (rawContext === null) throw new Error('glasspane: canvas.getContext("webgpu") returned null.')
  const context = rawContext as GPUCanvasContext
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format: presentationFormat, alphaMode: 'premultiplied' })

  // --- Texture array for tile content ---
  const tileTextureArray = device.createTexture({
    size: { width: tileTextureSize, height: tileTextureSize, depthOrArrayLayers: maxActiveTiles },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const tileSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  })

  // --- Instance storage buffer ---
  // One slot per placement. We size generously (up to 100k) to cover
  // large catalogs; actual visible count is capped by maxActiveTiles.
  const MAX_INSTANCES = 100_000
  const instanceBuffer = device.createBuffer({
    size: MAX_INSTANCES * INSTANCE_STRIDE_FLOATS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })

  // --- Viewport uniform ---
  const viewportBuffer = device.createBuffer({
    size: 16, // 4 floats × 4 bytes
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // --- Pipeline ---
  const shaderModule = device.createShaderModule({ code: WGSL })
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d-array' },
      },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  })
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shaderModule, entryPoint: 'vs_main' },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [
        {
          format: presentationFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  })
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: instanceBuffer } },
      { binding: 1, resource: { buffer: viewportBuffer } },
      { binding: 2, resource: tileTextureArray.createView() },
      { binding: 3, resource: tileSampler },
    ],
  })

  // --- Scene state ---
  let placements: readonly Placement[] = []
  let scrollY = 0
  let destroyed = false

  // Texture slot bookkeeping. `slotByTile` maps tile idx → layer idx
  // (0..maxActiveTiles); `tileBySlot` is the inverse. LRU is a Map
  // keyed on tile idx (Map preserves insertion order → eviction walks
  // the oldest first).
  const slotByTile = new Map<number, number>()
  const tileBySlot = new Array<number>(maxActiveTiles).fill(-1)
  const lru = new Map<number, number>() // tile idx → slot (preserves recency)
  const opacityByTile = new Map<number, { current: number; target: number; startedAt: number }>()
  const inflightFetches = new Map<number, AbortController>()

  const NO_TEXTURE_SENTINEL = 0xffffffff

  function touchLRU(idx: number, slot: number): void {
    lru.delete(idx)
    lru.set(idx, slot)
  }

  function claimSlot(idx: number): number {
    const existing = slotByTile.get(idx)
    if (existing !== undefined) {
      touchLRU(idx, existing)
      return existing
    }
    // Find a free slot (initial fill).
    for (let s = 0; s < maxActiveTiles; s++) {
      if (tileBySlot[s] === -1) {
        slotByTile.set(idx, s)
        tileBySlot[s] = idx
        touchLRU(idx, s)
        return s
      }
    }
    // Evict the LRU slot.
    const lruIter = lru.keys().next()
    if (lruIter.done === true) {
      throw new Error('glasspane: slot pool exhausted but LRU empty — invariant broken')
    }
    const evictTile = lruIter.value as number
    const evictSlot = lru.get(evictTile)!
    lru.delete(evictTile)
    slotByTile.delete(evictTile)
    opacityByTile.delete(evictTile)
    tileBySlot[evictSlot] = idx
    slotByTile.set(idx, evictSlot)
    touchLRU(idx, evictSlot)
    return evictSlot
  }

  function setPlacements(next: readonly Placement[]): void {
    placements = next
    scheduleRender()
  }

  function setScroll(value: number): void {
    scrollY = value
    scheduleRender()
  }

  async function setTileImage(idx: number, url: string): Promise<void> {
    // Cancel any prior in-flight fetch for this tile.
    inflightFetches.get(idx)?.abort()
    const controller = new AbortController()
    inflightFetches.set(idx, controller)

    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`glasspane: fetch ${url} → ${response.status}`)
      }
      const blob = await response.blob()
      if (controller.signal.aborted) return
      const bitmap = await createImageBitmap(blob, {
        resizeWidth: tileTextureSize,
        resizeHeight: tileTextureSize,
        resizeQuality: 'medium',
      })
      if (controller.signal.aborted) {
        bitmap.close()
        return
      }
      if (destroyed) {
        bitmap.close()
        return
      }

      const slot = claimSlot(idx)
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: tileTextureArray, origin: { x: 0, y: 0, z: slot } },
        { width: tileTextureSize, height: tileTextureSize, depthOrArrayLayers: 1 },
      )
      bitmap.close()

      // Kick off fade-in.
      opacityByTile.set(idx, { current: 0, target: 1, startedAt: performance.now() })
      scheduleRender()
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      throw err
    } finally {
      if (inflightFetches.get(idx) === controller) inflightFetches.delete(idx)
    }
  }

  function cancelTileImage(idx: number): void {
    const controller = inflightFetches.get(idx)
    if (controller !== undefined) controller.abort()
    inflightFetches.delete(idx)
  }

  function clearTile(idx: number): void {
    cancelTileImage(idx)
    const slot = slotByTile.get(idx)
    if (slot === undefined) return
    slotByTile.delete(idx)
    tileBySlot[slot] = -1
    lru.delete(idx)
    opacityByTile.delete(idx)
    // We don't zero the GPU texture; the slot is marked free and
    // whichever tile reuses it will overwrite the pixels. The
    // sentinel-layer logic in the shader handles never-loaded tiles.
    scheduleRender()
  }

  // --- Visibility + render loop ---

  let rafPending = false
  let lastVisibleCount = 0

  function scheduleRender(): void {
    if (rafPending || destroyed) return
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      render()
    })
  }

  function render(): void {
    if (destroyed) return

    const canvasWidth = canvas.width
    const canvasHeight = canvas.height

    // Update viewport uniform.
    const viewportData = new Float32Array([scrollY, canvasWidth, canvasHeight, 0])
    device.queue.writeBuffer(viewportBuffer, 0, viewportData)

    // Advance fade-in animations.
    const now = performance.now()
    let anyFading = false
    for (const [, state] of opacityByTile) {
      const t = Math.min(1, (now - state.startedAt) / fadeMs)
      state.current = state.target * t
      if (t < 1) anyFading = true
    }

    // Build the instance array: one entry per visible (+ overscan) tile.
    // For tiles without a texture slot yet, write the sentinel layer
    // so the shader paints a skeleton.
    const viewTop = scrollY - overscanBehind
    const viewBottom = scrollY + canvasHeight + overscanAhead
    const instances = new Float32Array(maxActiveTiles * INSTANCE_STRIDE_FLOATS)
    let instanceCount = 0
    let visibleCount = 0
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!
      if (p.y + p.height < viewTop) continue
      if (p.y > viewBottom) continue
      visibleCount++

      const slot = slotByTile.get(i)
      const opacity = opacityByTile.get(i)?.current ?? (slot === undefined ? 1 : 0)
      const layer = slot ?? NO_TEXTURE_SENTINEL

      const o = instanceCount * INSTANCE_STRIDE_FLOATS
      instances[o + 0] = p.x
      instances[o + 1] = p.y
      instances[o + 2] = p.width
      instances[o + 3] = p.height
      // u32 layer stored in float slot via reinterpretation — we
      // write the bits through a shared buffer.
      const asU32 = new Uint32Array(instances.buffer, (o + 4) * 4, 1)
      asU32[0] = layer >>> 0
      instances[o + 5] = opacity
      instances[o + 6] = 0
      instances[o + 7] = 0

      instanceCount++
      if (instanceCount >= maxActiveTiles) break
    }
    lastVisibleCount = visibleCount

    device.queue.writeBuffer(instanceBuffer, 0, instances, 0, instanceCount * INSTANCE_STRIDE_FLOATS)

    // Encode + submit.
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0.95, g: 0.96, b: 0.97, a: 1 },
        },
      ],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(6, instanceCount)
    pass.end()
    device.queue.submit([encoder.finish()])

    if (anyFading) scheduleRender()
  }

  // --- Public API ---

  function destroy(): void {
    destroyed = true
    for (const controller of inflightFetches.values()) controller.abort()
    inflightFetches.clear()
    // Buffers + textures are released when GPUDevice is dropped;
    // explicit destroy on resources helps release VRAM sooner in
    // long-running pages.
    instanceBuffer.destroy()
    viewportBuffer.destroy()
    tileTextureArray.destroy()
  }

  scheduleRender()

  return {
    setPlacements,
    setScroll,
    setTileImage,
    cancelTileImage,
    clearTile,
    get activeTileCount() {
      return slotByTile.size
    },
    get visibleTileCount() {
      return lastVisibleCount
    },
    destroy,
  }
}
