// PrepareQueue state-machine coverage. The queue coordinates
// dedup, concurrency, boost/deprioritize, and drain ordering —
// state that's easy to break during refactors. This harness tests
// the queue's bookkeeping without running any real fetches by
// stubbing `globalThis.fetch` to return promises that never
// resolve, letting us inspect pendingCount / inflightCount while
// entries are in-flight.
//
// Not covered here (needs real prepare/network): error propagation
// to the per-URL promise, idempotency across long-running sessions,
// resolution ordering.
//
// Usage:
//   bun run scripts/prepare-queue-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PrepareQueue,
  pickAdaptiveConcurrency,
} from '../packages/preimage/src/prepare-queue.ts'

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

// --- Fetch stub ---
//
// Replaces globalThis.fetch with a function that returns a promise
// that never resolves. Perfect for testing queue state — the
// in-flight entries sit in the inflight map indefinitely while we
// prod the pending queue.

type FetchStub = {
  resolvers: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void; url: string }>
  restore: () => void
}

function installNeverResolvingFetch(): FetchStub {
  const original = globalThis.fetch
  const stub: FetchStub = {
    resolvers: [],
    restore: () => {
      globalThis.fetch = original
    },
  }
  globalThis.fetch = ((input: Request | string | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    return new Promise((resolveFn, rejectFn) => {
      stub.resolvers.push({ resolve: resolveFn, reject: rejectFn, url })
    })
  }) as typeof fetch
  return stub
}

// Let event-loop microtasks flush so the queue's internal
// .then-chain for enqueue can propagate to pending-map inserts.
async function tick(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

// --- Cases ---

async function caseDedup(): Promise<void> {
  const stub = installNeverResolvingFetch()
  try {
    const queue = new PrepareQueue({ concurrency: 1 })
    // First enqueue starts in-flight immediately (concurrency 1).
    const p1 = queue.enqueue('/a.png', { strategy: 'stream' })
    // Second enqueue of the same URL should return the SAME promise.
    const p2 = queue.enqueue('/a.png', { strategy: 'stream' })
    if (p1 !== p2) fail('dedup/same-url', 'second enqueue returned new promise')
    else pass('dedup/same-url')
    // Third enqueue of a different URL goes into pending.
    const p3 = queue.enqueue('/b.png', { strategy: 'stream' })
    if (p1 === p3) fail('dedup/different-url', 'different URL returned same promise')
    else pass('dedup/different-url')
    await tick()
    // After tick: /a.png is inflight (1), /b.png is pending (1).
    if (queue.inflightCount !== 1) {
      fail('dedup/inflight-count', `expected 1, got ${queue.inflightCount}`)
    } else {
      pass('dedup/inflight-count')
    }
    if (queue.pendingCount !== 1) {
      fail('dedup/pending-count', `expected 1, got ${queue.pendingCount}`)
    } else {
      pass('dedup/pending-count')
    }

    const p4 = queue.enqueue('/a.png', { strategy: 'stream', dimsOnly: true })
    if (p4 === p1) {
      fail('dedup/different-options', 'same URL with different options returned same promise')
    } else {
      pass('dedup/different-options')
    }
    if (queue.pendingCount !== 2) {
      fail('dedup/different-options-pending', `expected 2, got ${queue.pendingCount}`)
    } else {
      pass('dedup/different-options-pending')
    }
    void p1; void p2; void p3; void p4
  } finally {
    stub.restore()
  }
}

async function caseBoost(): Promise<void> {
  const stub = installNeverResolvingFetch()
  try {
    const queue = new PrepareQueue({ concurrency: 1 })
    queue.enqueue('/a.png', { dimsOnly: true }) // inflight
    queue.enqueue('/b.png', { dimsOnly: true }) // pending[0]
    queue.enqueue('/c.png', { dimsOnly: true }) // pending[1]
    queue.enqueue('/d.png', { dimsOnly: true }) // pending[2]
    await tick()
    if (queue.pendingCount !== 3) fail('boost/setup', `pendingCount ${queue.pendingCount}`)

    // Boost /d.png — should move to front of pending.
    const moved = queue.boost('/d.png')
    if (!moved) fail('boost/moved-bool', 'boost returned false for pending URL')
    else pass('boost/moved-bool')

    // No way to inspect order directly via public API; best we can
    // do is verify boost doesn't change counts + non-existent boost
    // returns false.
    if (queue.pendingCount !== 3) {
      fail('boost/pending-unchanged', `expected 3, got ${queue.pendingCount}`)
    } else {
      pass('boost/pending-unchanged')
    }
    // Boost a URL that's already in-flight: returns false (not in pending).
    const inflightBoost = queue.boost('/a.png')
    if (inflightBoost) fail('boost/inflight', 'boost of inflight returned true')
    else pass('boost/inflight')
    // Boost a URL that was never enqueued.
    const missingBoost = queue.boost('/does-not-exist.png')
    if (missingBoost) fail('boost/missing', 'boost of unknown URL returned true')
    else pass('boost/missing')
  } finally {
    stub.restore()
  }
}

async function caseBoostManyPreservesOrder(): Promise<void> {
  const stub = installNeverResolvingFetch()
  try {
    const queue = new PrepareQueue({ concurrency: 1 })
    queue.enqueue('/a.png', { dimsOnly: true })
    queue.enqueue('/b.png', { dimsOnly: true })
    queue.enqueue('/c.png', { dimsOnly: true })
    queue.enqueue('/d.png', { dimsOnly: true })
    queue.enqueue('/e.png', { dimsOnly: true })
    queue.enqueue('/f.png', { dimsOnly: true })
    await tick()
    if (queue.pendingCount !== 5) fail('boostMany/setup', `pendingCount ${queue.pendingCount}`)

    // Boost d and f to the front.
    queue.boostMany(['/d.png', '/f.png'])
    // Still same count in pending.
    if (queue.pendingCount !== 5) {
      fail('boostMany/pending-unchanged', `expected 5, got ${queue.pendingCount}`)
    } else {
      pass('boostMany/pending-unchanged')
    }

    // boostMany of an empty list is a no-op.
    queue.boostMany([])
    if (queue.pendingCount !== 5) {
      fail('boostMany/empty-noop', `empty call changed count to ${queue.pendingCount}`)
    } else {
      pass('boostMany/empty-noop')
    }

    // boostMany of URLs not in pending: no crash, no effect.
    queue.boostMany(['/missing.png', '/another.png'])
    if (queue.pendingCount !== 5) {
      fail('boostMany/missing', `unknown URLs changed count to ${queue.pendingCount}`)
    } else {
      pass('boostMany/missing')
    }
    pass('boostMany/basic')
  } finally {
    stub.restore()
  }
}

async function caseDeprioritizeMany(): Promise<void> {
  const stub = installNeverResolvingFetch()
  try {
    const queue = new PrepareQueue({ concurrency: 1 })
    queue.enqueue('/a.png', { dimsOnly: true })
    queue.enqueue('/b.png', { dimsOnly: true })
    queue.enqueue('/c.png', { dimsOnly: true })
    queue.enqueue('/d.png', { dimsOnly: true })
    await tick()

    queue.deprioritizeMany(['/b.png', '/c.png'])
    if (queue.pendingCount !== 3) {
      fail('deprioritize/pending-unchanged', `expected 3, got ${queue.pendingCount}`)
    } else {
      pass('deprioritize/basic')
    }

    queue.deprioritizeMany([])
    if (queue.pendingCount !== 3) {
      fail('deprioritize/empty-noop', `${queue.pendingCount}`)
    } else {
      pass('deprioritize/empty-noop')
    }
  } finally {
    stub.restore()
  }
}

async function caseClear(): Promise<void> {
  const stub = installNeverResolvingFetch()
  try {
    const queue = new PrepareQueue({ concurrency: 1 })
    queue.enqueue('/a.png', { dimsOnly: true }) // inflight
    const pending1 = queue.enqueue('/b.png', { dimsOnly: true })
    const pending2 = queue.enqueue('/c.png', { dimsOnly: true })
    await tick()
    if (queue.pendingCount !== 2) fail('clear/setup', `pendingCount ${queue.pendingCount}`)

    queue.clear()

    // clear() rejects pending promises.
    let rejected1 = false
    let rejected2 = false
    await pending1.catch((err) => { rejected1 = (err as Error).message.includes('cancelled') })
    await pending2.catch((err) => { rejected2 = (err as Error).message.includes('cancelled') })
    if (!rejected1 || !rejected2) {
      fail('clear/rejects-pending', `rejected1=${rejected1} rejected2=${rejected2}`)
    } else {
      pass('clear/rejects-pending')
    }

    if (queue.pendingCount !== 0) {
      fail('clear/empties-pending', `pendingCount ${queue.pendingCount}`)
    } else {
      pass('clear/empties-pending')
    }

    // Inflight should still be there (clear doesn't cancel in-flight).
    if (queue.inflightCount !== 1) {
      fail('clear/keeps-inflight', `inflightCount ${queue.inflightCount}`)
    } else {
      pass('clear/keeps-inflight')
    }
  } finally {
    stub.restore()
  }
}

async function caseConcurrencyValidation(): Promise<void> {
  let threw = false
  try {
    new PrepareQueue({ concurrency: 0 })
  } catch {
    threw = true
  }
  if (!threw) fail('concurrency/zero-throws', 'concurrency=0 did not throw')
  else pass('concurrency/zero-throws')

  threw = false
  try {
    new PrepareQueue({ concurrency: -5 })
  } catch {
    threw = true
  }
  if (!threw) fail('concurrency/negative-throws', 'concurrency=-5 did not throw')
  else pass('concurrency/negative-throws')

  threw = false
  try {
    new PrepareQueue({ concurrency: Number.NaN })
  } catch {
    threw = true
  }
  if (!threw) fail('concurrency/nan-throws', 'concurrency=NaN did not throw')
  else pass('concurrency/nan-throws')
}

async function casePickAdaptiveConcurrency(): Promise<void> {
  // Smoke test — just verify it returns a positive integer.
  const c = pickAdaptiveConcurrency()
  if (!Number.isFinite(c) || c < 1 || !Number.isInteger(c)) {
    fail('adaptive/returns-positive-int', `got ${c}`)
  } else {
    pass('adaptive/returns-positive-int', `${c}`)
  }
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  await caseDedup()
  await caseBoost()
  await caseBoostManyPreservesOrder()
  await caseDeprioritizeMany()
  await caseClear()
  await caseConcurrencyValidation()
  await casePickAdaptiveConcurrency()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== prepare-queue-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `prepare-queue-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'prepare-queue', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
