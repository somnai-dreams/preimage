// Pretext subpath coverage. These are integration-shape tests for the
// preimage/pretext adapter layer; pretext itself owns text engine
// correctness.
//
// Usage: bun run scripts/pretext-integration-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareWithSegments } from '@chenglou/pretext'

import {
  flowColumnWithFloats,
  measureColumnFlow,
  solveFloat,
} from '../packages/preimage/src/pretext-float.ts'
import {
  inlineImageItem,
  isInlineImageItem,
  PREIMAGE_INLINE_MARKER,
  resolveMixedInlineItems,
} from '../packages/preimage/src/pretext-inline.ts'
import type { PreparedImage } from '../packages/preimage/src/prepare.ts'
import { clearCache, registerUrlDimensionParser } from '../packages/preimage/src/index.ts'

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

class FakeCanvasContext {
  font = '16px sans-serif'
  measureText(text: string): TextMetrics {
    return { width: text.length * 8 } as TextMetrics
  }
}

class FakeOffscreenCanvas {
  constructor(_width: number, _height: number) {}
  getContext(type: string): FakeCanvasContext | null {
    return type === '2d' ? new FakeCanvasContext() : null
  }
}

function installFakeCanvas(): () => void {
  const g = globalThis as typeof globalThis & { OffscreenCanvas?: unknown }
  const original = g.OffscreenCanvas
  g.OffscreenCanvas = FakeOffscreenCanvas
  return () => {
    g.OffscreenCanvas = original
  }
}

function makePrepared(src: string, width: number, height: number): PreparedImage {
  return {
    width,
    height,
    aspectRatio: width / height,
    src,
    element: null,
    source: 'manifest',
    byteLength: null,
    hasAlpha: false,
    isProgressive: false,
    measurement: {
      src,
      naturalWidth: width,
      naturalHeight: height,
      displayWidth: width,
      displayHeight: height,
      aspectRatio: width / height,
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

function caseSolveFloat(): void {
  const image = makePrepared('/wide.png', 400, 200)
  const unconstrained = solveFloat({ image, side: 'left', top: 0, maxWidth: 150 }, 300)
  const heightConstrained = solveFloat({ image, side: 'left', top: 0, maxWidth: 150, maxHeight: 50 }, 300)
  if (unconstrained.width !== 150 || unconstrained.height !== 75) {
    fail('pretext/solve-float-width', `${unconstrained.width}x${unconstrained.height}`)
  } else if (heightConstrained.width !== 100 || heightConstrained.height !== 50) {
    fail('pretext/solve-float-height', `${heightConstrained.width}x${heightConstrained.height}`)
  } else {
    pass('pretext/solve-float')
  }
}

function caseInlineImageItem(): void {
  const image = makePrepared('/icon.png', 120, 60)
  const item = inlineImageItem(image, { font: '16px sans-serif', height: 24, extraWidth: 6 })
  if (!isInlineImageItem(item)) fail('pretext/inline-marker', 'type guard returned false')
  else if (item[PREIMAGE_INLINE_MARKER] !== true) fail('pretext/inline-marker-field', 'missing sentinel')
  else if (item.imageDisplayWidth !== 48 || item.imageDisplayHeight !== 24 || item.extraWidth !== 54) {
    fail('pretext/inline-dimensions', `${item.imageDisplayWidth}x${item.imageDisplayHeight} extra=${item.extraWidth}`)
  } else {
    pass('pretext/inline-image-item')
  }
}

function caseFlowColumnWithFloats(): void {
  const text = prepareWithSegments('alpha beta gamma delta epsilon zeta eta theta', '16px sans-serif')
  const image = makePrepared('/float.png', 400, 200)
  const result = flowColumnWithFloats({
    text,
    columnWidth: 200,
    lineHeight: 20,
    floats: [{ image, side: 'left', top: 0, maxWidth: 80, gapX: 10 }],
  })
  const measured = measureColumnFlow({
    text,
    columnWidth: 200,
    lineHeight: 20,
    floats: [{ image, side: 'left', top: 0, maxWidth: 80, gapX: 10 }],
  })
  const float = result.items.find((item) => item.kind === 'float')
  const firstLine = result.items.find((item) => item.kind === 'line')
  if (float === undefined || float.width !== 80 || float.height !== 40) {
    fail('pretext/flow-float-placement', float === undefined ? 'missing float' : `${float.width}x${float.height}`)
  } else if (firstLine === undefined || firstLine.x !== 90 || firstLine.width !== 110) {
    fail('pretext/flow-line-reservation', firstLine === undefined ? 'missing line' : `x=${firstLine.x} width=${firstLine.width}`)
  } else if (measured.totalHeight !== result.totalHeight || measured.lineCount !== result.lineCount) {
    fail('pretext/measure-column-flow', `measure=${measured.totalHeight}/${measured.lineCount} flow=${result.totalHeight}/${result.lineCount}`)
  } else {
    pass('pretext/flow-column-with-floats', `${result.lineCount} lines`)
  }
}

async function caseResolveMixedInlineItems(): Promise<void> {
  clearCache()
  const unregister = registerUrlDimensionParser((url) => {
    if (!url.includes('pretext-inline.example')) return null
    return { width: 200, height: 100 }
  })
  try {
    const items = await resolveMixedInlineItems([
      { text: 'Before ', font: '16px sans-serif' },
      {
        kind: 'image',
        src: 'https://pretext-inline.example/image.png',
        options: { font: '16px sans-serif', height: 20 },
      },
      { text: ' after', font: '16px sans-serif' },
    ])
    if (items.length !== 3) fail('pretext/resolve-mixed-length', `length=${items.length}`)
    else if (!isInlineImageItem(items[1]!)) fail('pretext/resolve-mixed-image', 'middle item is not inline image')
    else pass('pretext/resolve-mixed-inline-items')
  } finally {
    unregister()
    clearCache()
  }
}

async function main(): Promise<void> {
  const restore = installFakeCanvas()
  const t0 = performance.now()
  try {
    caseSolveFloat()
    caseInlineImageItem()
    caseFlowColumnWithFloats()
    await caseResolveMixedInlineItems()
  } finally {
    restore()
  }
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== pretext-integration-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `pretext-integration-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'pretext-integration', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
