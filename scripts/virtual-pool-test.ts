// Standalone VirtualTilePool coverage. loadGallery exercises this
// indirectly; these cases pin the recycling, overscan, offset, and
// destroy contracts directly.
//
// Usage: bun run scripts/virtual-pool-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createVirtualPriorityContext,
  createVirtualPriorityTracker,
  createVirtualTilePool,
  virtualPlacementPriority,
  type Placement,
} from '../packages/preimage/src/virtual.ts'

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
  scrollTop = 0
  clientHeight = 0
  clientWidth = 0
  rectTop = 0
  rectLeft = 0
  removed = false
  readonly children: FakeElement[] = []
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(tagName = 'DIV') {
    this.tagName = tagName
  }

  appendChild<T extends FakeElement>(child: T): T {
    this.children.push(child)
    return child
  }

  remove(): void {
    this.removed = true
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

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: this.rectLeft,
      y: this.rectTop,
      top: this.rectTop,
      left: this.rectLeft,
      right: this.rectLeft + this.clientWidth,
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
    ResizeObserver?: unknown
  }
  const originalDocument = g.document
  const originalRaf = g.requestAnimationFrame
  const originalResizeObserver = g.ResizeObserver
  g.document = {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
  }
  g.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    setTimeout(() => cb(performance.now()), 0)
    return 1
  }) as typeof requestAnimationFrame
  g.ResizeObserver = undefined
  return () => {
    g.document = originalDocument
    g.requestAnimationFrame = originalRaf
    g.ResizeObserver = originalResizeObserver
  }
}

async function tick(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function placements(): Placement[] {
  return [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 0, y: 120, width: 100, height: 100 },
    { x: 0, y: 240, width: 100, height: 100 },
    { x: 0, y: 360, width: 100, height: 100 },
    { x: 0, y: 480, width: 100, height: 100 },
  ]
}

async function caseDirectionalOverscanAndReuse(): Promise<void> {
  const restore = installFakeDom()
  try {
    const scroll = new FakeElement()
    scroll.clientHeight = 200
    scroll.clientWidth = 100
    const content = new FakeElement()
    content.clientWidth = 100
    const mounts: string[] = []
    const unmounts: number[] = []

    const pool = createVirtualTilePool({
      scrollContainer: scroll as unknown as HTMLElement,
      contentContainer: content as unknown as HTMLElement,
      overscan: { ahead: 100, behind: 0 },
      mount: (idx, el) => {
        mounts.push(`${idx}:${content.children.indexOf(el as unknown as FakeElement)}`)
      },
      unmount: (idx) => {
        unmounts.push(idx)
      },
    })

    pool.setPlacements(placements())
    if (pool.activeCount !== 3) fail('virtual/initial-active-count', `got ${pool.activeCount}`)
    else if (content.children.length !== 3) fail('virtual/initial-node-count', `children=${content.children.length}`)
    else pass('virtual/initial-window')

    scroll.scrollTop = 260
    scroll.dispatch('scroll')
    await tick()
    if (pool.activeCount !== 3) fail('virtual/scroll-down-active-count', `got ${pool.activeCount}`)
    else if (JSON.stringify(unmounts) !== JSON.stringify([0, 1])) {
      fail('virtual/scroll-down-unmounts', `got ${JSON.stringify(unmounts)}`)
    } else if (content.children.length !== 3) {
      fail('virtual/recycle-node-count', `children=${content.children.length}`)
    } else {
      pass('virtual/directional-overscan-reuses-nodes')
    }

    scroll.scrollTop = 0
    scroll.dispatch('scroll')
    await tick()
    if (pool.activeCount !== 2) fail('virtual/scroll-up-active-count', `got ${pool.activeCount}`)
    else pass('virtual/scroll-up-behind-band')

    pool.destroy()
    if (scroll.listenerCount('scroll') !== 0) fail('virtual/destroy-listener', `listeners=${scroll.listenerCount('scroll')}`)
    else if (pool.activeCount !== 0) fail('virtual/destroy-active-count', `got ${pool.activeCount}`)
    else pass('virtual/destroy-cleans-up')
  } finally {
    restore()
  }
}

function caseContentOffset(): void {
  const restore = installFakeDom()
  try {
    const scroll = new FakeElement()
    scroll.clientHeight = 100
    scroll.clientWidth = 100
    const content = new FakeElement()
    content.clientWidth = 100
    content.rectTop = 120

    const pool = createVirtualTilePool({
      scrollContainer: scroll as unknown as HTMLElement,
      contentContainer: content as unknown as HTMLElement,
      overscan: 0,
      mount: () => {},
    })
    pool.setPlacements([{ x: 0, y: 0, width: 100, height: 50 }])
    if (pool.activeCount !== 0) fail('virtual/content-offset', `mounted ${pool.activeCount} offscreen tile`)
    else pass('virtual/content-offset')
    pool.destroy()
  } finally {
    restore()
  }
}

function caseVirtualPriorityBands(): void {
  const restore = installFakeDom()
  try {
    const scroll = new FakeElement()
    scroll.clientHeight = 40
    scroll.clientWidth = 100
    const content = new FakeElement()
    content.clientWidth = 100
    const context = createVirtualPriorityContext({
      scrollContainer: scroll as unknown as HTMLElement,
      contentContainer: content as unknown as HTMLElement,
      predictor: {
        name: 'fixture',
        predict: () => ({ y: 120, confidence: 1 }),
      },
      samples: [{ t: 0, y: 0 }, { t: 100, y: 40 }],
    })
    const visible = virtualPlacementPriority({ x: 0, y: 0, width: 100, height: 40 }, context)
    const predicted = virtualPlacementPriority({ x: 0, y: 120, width: 100, height: 40 }, context)
    const ahead = virtualPlacementPriority({ x: 0, y: 220, width: 100, height: 40 }, context)
    const behind = virtualPlacementPriority({ x: 0, y: -100, width: 100, height: 40 }, context)

    const stationary = createVirtualPriorityContext({
      scrollContainer: scroll as unknown as HTMLElement,
      contentContainer: content as unknown as HTMLElement,
      predictor: {
        name: 'stationary',
        predict: () => ({ y: 0, confidence: 1 }),
      },
      samples: [{ t: 0, y: 0 }],
    })
    const near = virtualPlacementPriority({ x: 0, y: 80, width: 100, height: 40 }, stationary)

    const bands = [visible.band, predicted.band, ahead.band, behind.band, near.band]
    const scores = [visible.score, predicted.score, ahead.score, behind.score]
    if (JSON.stringify(bands) !== JSON.stringify(['visible', 'predicted', 'ahead', 'behind', 'near'])) {
      fail('virtual/priority-bands', `bands=${JSON.stringify(bands)}`)
    } else if (!(scores[0]! > scores[1]! && scores[1]! > scores[2]! && scores[2]! > scores[3]!)) {
      fail('virtual/priority-order', `scores=${JSON.stringify(scores)}`)
    } else {
      pass('virtual/priority-bands')
    }
  } finally {
    restore()
  }
}

function caseVirtualPriorityValidation(): void {
  const restore = installFakeDom()
  try {
    const scroll = new FakeElement()
    const content = new FakeElement()
    try {
      createVirtualPriorityTracker({
        scrollContainer: scroll as unknown as HTMLElement,
        contentContainer: content as unknown as HTMLElement,
        maxSamples: 0,
      })
      fail('virtual/priority-validation', 'accepted maxSamples=0')
    } catch (err) {
      if (err instanceof RangeError) pass('virtual/priority-validation')
      else fail('virtual/priority-validation', String(err))
    }
  } finally {
    restore()
  }
}

async function main(): Promise<void> {
  const t0 = performance.now()
  await caseDirectionalOverscanAndReuse()
  caseContentOffset()
  caseVirtualPriorityBands()
  caseVirtualPriorityValidation()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== virtual-pool-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `virtual-pool-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'virtual-pool', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
