// DecodePool lifecycle coverage. Focuses on clear() while decode work is
// in-flight: the caller's promise should still resolve, but the completed
// bitmap must not repopulate the cache generation that was just cleared.
//
// Usage: bun run scripts/decode-pool-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clearCache,
  DecodePool,
  recordKnownMeasurement,
} from '../packages/preimage/src/index.ts'

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

type FakeBitmap = ImageBitmap & { closed: boolean }

function makeBitmap(width: number, height: number): FakeBitmap {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true
    },
  } as FakeBitmap
}

async function caseClearSkipsInflightStore(): Promise<void> {
  clearCache()
  recordKnownMeasurement('/bitmap.png', 10, 20)

  const g = globalThis as typeof globalThis & {
    createImageBitmap?: unknown
    fetch?: typeof fetch
  }
  const originalCreateImageBitmap = g.createImageBitmap
  const originalFetch = g.fetch

  let releaseBitmap!: (bitmap: FakeBitmap) => void
  const decodeStarted = new Promise<void>((resolveStarted) => {
    g.createImageBitmap = (() => {
      resolveStarted()
      return new Promise<ImageBitmap>((resolveBitmap) => {
        releaseBitmap = resolveBitmap
      })
    }) as typeof createImageBitmap
  })
  g.fetch = (() => Promise.resolve(new Response(new Blob([new Uint8Array([1, 2, 3])])))) as typeof fetch

  try {
    const pool = new DecodePool({ concurrency: 1, maxCacheEntries: 4 })
    const pending = pool.get('/bitmap.png')
    await decodeStarted
    pool.clear()
    const bitmap = makeBitmap(10, 20)
    releaseBitmap(bitmap)
    const resolved = await pending
    if (resolved !== bitmap) {
      fail('decode-pool/clear-inflight-result', 'pending get resolved with a different bitmap')
    } else if (pool.cacheSize !== 0) {
      fail('decode-pool/clear-inflight-cache', `cacheSize ${pool.cacheSize}`)
    } else if (bitmap.closed) {
      fail('decode-pool/clear-inflight-closed', 'bitmap returned to caller was closed')
    } else {
      pass('decode-pool/clear-inflight')
    }
  } finally {
    g.createImageBitmap = originalCreateImageBitmap
    g.fetch = originalFetch
  }
}

async function main(): Promise<void> {
  const t0 = performance.now()
  await caseClearSkipsInflightStore()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== decode-pool-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `decode-pool-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'decode-pool', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
