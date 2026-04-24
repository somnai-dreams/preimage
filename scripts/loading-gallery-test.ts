// loadGallery orchestration coverage. Uses a tiny fake DOM so the tests
// exercise the real virtual pool and loading modes without launching a
// browser.
//
// Usage: bun run scripts/loading-gallery-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadGallery,
  type GalleryImageLoading,
  type PackerCursor,
} from '../packages/preimage/src/loading.ts'
import type { PreparedImage, PrepareOptions } from '../packages/preimage/src/prepare.ts'

type Check =
  | { ok: true; case: string; notes?: string }
  | { ok: false; case: string; reason: string }

const results: Check[] = []

function pass(label: string, notes?: string): void {
  results.push(notes !== undefined ? { ok: true, case: label, notes } : { ok: true, case: label })
}

function fail(label: string, reason: string): void {
  results.push({ ok: false, case: label, reason })
}

class FakeElement {
  readonly tagName: string
  readonly style = {} as CSSStyleDeclaration
  className = ''
  innerHTML = ''
  scrollTop = 0
  clientHeight = 1000
  clientWidth = 300
  rectTop = 0
  complete = false
  naturalWidth = 0
  private readonly children: FakeElement[] = []
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(tagName = 'DIV') {
    this.tagName = tagName
  }

  appendChild<T extends FakeElement>(child: T): T {
    this.children.push(child)
    return child
  }

  remove(): void {
    this.children.length = 0
  }

  querySelector(selector: string): FakeElement | null {
    if (selector !== 'img') return null
    return this.children.find((child) => child.tagName === 'IMG') ?? null
  }

  addEventListener(type: string, cb: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>()
    set.add(cb)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb)
  }

  dispatch(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb()
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: this.rectTop,
      top: this.rectTop,
      left: 0,
      right: this.clientWidth,
      bottom: this.rectTop + this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight,
      toJSON: () => ({}),
    } as DOMRect
  }
}

function installFakeDom(): () => void {
  const g = globalThis as typeof globalThis & {
    document?: unknown
    requestAnimationFrame?: unknown
  }
  const originalDocument = g.document
  const originalRaf = g.requestAnimationFrame
  g.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  }
  g.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    setTimeout(() => cb(performance.now()), 0)
    return 1
  }) as typeof requestAnimationFrame
  return () => {
    g.document = originalDocument
    g.requestAnimationFrame = originalRaf
  }
}

function makePrepared(src: string, aspectRatio: number): PreparedImage {
  return {
    width: aspectRatio * 100,
    height: 100,
    aspectRatio,
    src,
    element: null,
    source: 'network',
    byteLength: null,
    hasAlpha: false,
    isProgressive: false,
    measurement: {
      src,
      naturalWidth: aspectRatio * 100,
      naturalHeight: 100,
      displayWidth: aspectRatio * 100,
      displayHeight: 100,
      aspectRatio,
      orientation: 1,
      decoded: false,
      analysis: {
        src,
        rawSrc: src,
        format: 'png',
        sourceKind: 'relative',
        isVector: false,
        declaredWidth: null,
        declaredHeight: null,
        aspectHint: null,
      },
      byteLength: null,
      hasAlpha: false,
      isProgressive: false,
    },
  }
}

class ControlledQueue {
  readonly resolvers = new Map<string, (prepared: PreparedImage) => void>()
  cleared = 0
  enqueue(src: string, _options?: PrepareOptions): Promise<PreparedImage> {
    return new Promise((resolve) => {
      this.resolvers.set(src, resolve)
    })
  }
  boostMany(_srcs: readonly string[]): void {}
  clear(): void {
    this.cleared++
  }
  resolve(src: string, aspect: number): void {
    const resolve = this.resolvers.get(src)
    if (resolve === undefined) throw new Error(`missing resolver for ${src}`)
    resolve(makePrepared(src, aspect))
  }
}

function makePacker(): PackerCursor {
  let y = 0
  return {
    add(aspect: number) {
      const placement = { x: 0, y, width: aspect, height: 1 }
      y += 1
      return placement
    },
    totalHeight() {
      return y
    },
  }
}

function makeSpacedPacker(): PackerCursor {
  let y = 0
  return {
    add() {
      const placement = { x: 0, y, width: 100, height: 40 }
      y += 100
      return placement
    },
    totalHeight() {
      return y
    },
  }
}

async function tick(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function caseImageLoadingOrder(imageLoading: GalleryImageLoading): Promise<void> {
  const restore = installFakeDom()
  try {
    const queue = new ControlledQueue()
    const skeletonWidths: number[] = []
    const gallery = loadGallery({
      urls: ['/a.png', '/b.png', '/c.png'],
      scrollContainer: new FakeElement(),
      contentContainer: new FakeElement(),
      packer: makePacker(),
      imageLoading,
      probe: { queue },
      renderConcurrency: 1,
      renderSkeleton: (_el, _idx, place) => {
        skeletonWidths.push(place.width)
      },
      renderImage: () => {},
    })
    await tick()
    queue.resolve('/b.png', 2)
    queue.resolve('/c.png', 3)
    await tick()
    queue.resolve('/a.png', 1)
    await gallery.done
    if (JSON.stringify(skeletonWidths) !== JSON.stringify([1, 2, 3])) {
      fail(`loading-order/${imageLoading}`, `got ${JSON.stringify(skeletonWidths)}`)
    } else {
      pass(`loading-order/${imageLoading}`)
    }
  } finally {
    restore()
  }
}

async function caseKnownAspectsSkipProbe(): Promise<void> {
  const restore = installFakeDom()
  try {
    const queue = new ControlledQueue()
    const skeletonWidths: number[] = []
    const gallery = loadGallery({
      urls: ['/a.png', '/b.png', '/c.png'],
      scrollContainer: new FakeElement(),
      contentContainer: new FakeElement(),
      packer: makePacker(),
      imageLoading: 'queued',
      probe: { queue },
      aspects: [1, 2, 3],
      renderSkeleton: (_el, _idx, place) => {
        skeletonWidths.push(place.width)
      },
      renderImage: () => {},
    })
    await gallery.done
    if (queue.resolvers.size !== 0) {
      fail('loading-known-aspects/skips-probe', `queued ${queue.resolvers.size} probes`)
    } else if (JSON.stringify(skeletonWidths) !== JSON.stringify([1, 2, 3])) {
      fail('loading-known-aspects/order', `got ${JSON.stringify(skeletonWidths)}`)
    } else {
      pass('loading-known-aspects/skips-probe')
    }
  } finally {
    restore()
  }
}

async function caseDoneIgnoresOverscanLoads(imageLoading: GalleryImageLoading): Promise<void> {
  const restore = installFakeDom()
  try {
    const scrollContainer = new FakeElement()
    const contentContainer = new FakeElement()
    scrollContainer.clientHeight = 40
    const activeImgs = new Map<number, FakeElement>()
    const gallery = loadGallery({
      urls: ['/a.png', '/b.png', '/c.png'],
      scrollContainer,
      contentContainer,
      packer: makeSpacedPacker(),
      imageLoading,
      aspects: [1, 1, 1],
      overscan: 400,
      renderConcurrency: 3,
      renderSkeleton: () => {},
      renderImage: (el, idx) => {
        const img = new FakeElement('IMG')
        const tile = el as unknown as FakeElement
        tile.appendChild(img)
        activeImgs.set(idx, img)
      },
    })
    await tick()
    if (activeImgs.size < 2) {
      fail(`loading-done-visible-only/${imageLoading}/mounted-overscan`, `imgs=${activeImgs.size}`)
      gallery.destroy()
      return
    }
    const firstImg = activeImgs.get(0)
    if (firstImg === undefined) {
      fail(`loading-done-visible-only/${imageLoading}/visible-started`, `imgs=${activeImgs.size}`)
      gallery.destroy()
      return
    }
    firstImg.complete = true
    firstImg.naturalWidth = 100
    firstImg.dispatch('load')
    const settled = await Promise.race([
      gallery.done.then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    if (settled !== 'done') {
      fail(`loading-done-visible-only/${imageLoading}/settles`, `got ${settled}`)
    } else {
      pass(`loading-done-visible-only/${imageLoading}`)
    }
    gallery.destroy()
  } finally {
    restore()
  }
}

async function caseDestroySettlesAndIgnoresLateProbe(): Promise<void> {
  const restore = installFakeDom()
  try {
    const queue = new ControlledQueue()
    let skeletons = 0
    let images = 0
    const gallery = loadGallery({
      urls: ['/a.png'],
      scrollContainer: new FakeElement(),
      contentContainer: new FakeElement(),
      packer: makePacker(),
      imageLoading: 'immediate',
      probe: { queue },
      renderSkeleton: () => {
        skeletons++
      },
      renderImage: () => {
        images++
      },
    })
    gallery.destroy()
    const settled = await Promise.race([
      gallery.done.then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    queue.resolve('/a.png', 1)
    await tick()
    if (settled !== 'done') fail('loading-destroy/settles', `got ${settled}`)
    else if (queue.cleared !== 0) fail('loading-destroy/external-queue-clear', `cleared=${queue.cleared}`)
    else if (skeletons !== 0 || images !== 0) {
      fail('loading-destroy/late-render', `skeletons=${skeletons} images=${images}`)
    } else {
      pass('loading-destroy/settles-and-ignores-late-probe')
    }
  } finally {
    restore()
  }
}

async function caseQueuedPromotesScrolledViewport(): Promise<void> {
  const restore = installFakeDom()
  try {
    const scrollContainer = new FakeElement()
    const contentContainer = new FakeElement()
    scrollContainer.clientHeight = 40
    const starts: number[] = []
    const activeImgs = new Map<number, FakeElement>()
    const gallery = loadGallery({
      urls: ['/a.png', '/b.png', '/c.png', '/d.png'],
      scrollContainer,
      contentContainer,
      packer: makeSpacedPacker(),
      imageLoading: 'queued',
      aspects: [1, 1, 1, 1],
      overscan: 400,
      renderConcurrency: 1,
      renderSkeleton: () => {},
      renderImage: (el, idx) => {
        starts.push(idx)
        const img = new FakeElement('IMG')
        const tile = el as unknown as FakeElement
        tile.appendChild(img)
        activeImgs.set(idx, img)
      },
    })
    await tick()
    scrollContainer.scrollTop = 220
    contentContainer.rectTop = -scrollContainer.scrollTop
    scrollContainer.dispatch('scroll')
    await tick()
    const firstImg = activeImgs.get(0)
    if (firstImg === undefined) {
      fail('queued-promotion/started-first', `starts=${JSON.stringify(starts)}`)
      gallery.destroy()
      return
    }
    firstImg.complete = true
    firstImg.naturalWidth = 100
    firstImg.dispatch('load')
    await tick()
    if (JSON.stringify(starts.slice(0, 2)) !== JSON.stringify([0, 2])) {
      fail('queued-promotion/visible-jumps-queue', `starts=${JSON.stringify(starts)}`)
    } else {
      pass('queued-promotion/visible-jumps-queue')
    }
    gallery.destroy()
  } finally {
    restore()
  }
}

async function caseQueuedPromotesPredictedViewport(): Promise<void> {
  const restore = installFakeDom()
  try {
    const scrollContainer = new FakeElement()
    const contentContainer = new FakeElement()
    scrollContainer.clientHeight = 40
    const starts: number[] = []
    const activeImgs = new Map<number, FakeElement>()
    const gallery = loadGallery({
      urls: ['/a.png', '/b.png', '/c.png', '/d.png'],
      scrollContainer,
      contentContainer,
      packer: makeSpacedPacker(),
      imageLoading: 'queued',
      aspects: [1, 1, 1, 1],
      overscan: 400,
      renderConcurrency: 1,
      renderSkeleton: () => {},
      renderImage: (el, idx) => {
        starts.push(idx)
        const img = new FakeElement('IMG')
        const tile = el as unknown as FakeElement
        tile.appendChild(img)
        activeImgs.set(idx, img)
      },
    })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 80))
    scrollContainer.scrollTop = 40
    contentContainer.rectTop = -scrollContainer.scrollTop
    scrollContainer.dispatch('scroll')
    await tick()
    const firstImg = activeImgs.get(0)
    if (firstImg === undefined) {
      fail('queued-prediction/started-first', `starts=${JSON.stringify(starts)}`)
      gallery.destroy()
      return
    }
    firstImg.complete = true
    firstImg.naturalWidth = 100
    firstImg.dispatch('load')
    await tick()
    if (JSON.stringify(starts.slice(0, 2)) !== JSON.stringify([0, 2])) {
      fail('queued-prediction/predicted-jumps-ahead', `starts=${JSON.stringify(starts)}`)
    } else {
      pass('queued-prediction/predicted-jumps-ahead')
    }
    gallery.destroy()
  } finally {
    restore()
  }
}

async function main(): Promise<void> {
  const t0 = performance.now()
  await caseImageLoadingOrder('immediate')
  await caseImageLoadingOrder('after-layout')
  await caseImageLoadingOrder('queued')
  await caseImageLoadingOrder('visible-first')
  await caseKnownAspectsSkipProbe()
  await caseDoneIgnoresOverscanLoads('immediate')
  await caseDoneIgnoresOverscanLoads('after-layout')
  await caseDoneIgnoresOverscanLoads('queued')
  await caseDestroySettlesAndIgnoresLateProbe()
  await caseQueuedPromotesScrolledViewport()
  await caseQueuedPromotesPredictedViewport()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== loading-gallery-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `loading-gallery-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'loading-gallery', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
      null,
      2,
    ),
  )
  process.stdout.write(`=== Saved ${outPath} ===\n`)
  if (failed.length > 0) process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
