// Managed concurrency for `prepare()`. Browsers cap parallel requests per
// origin (typically 6 for HTTP/1.1, ~100 for HTTP/2 but with server-side
// flow control pushing back). When a gallery page blindly fires
// `prepare()` for 200 tiles, the later tiles queue inside the browser's
// network stack for tens of seconds, and there's no way to reprioritize:
// a tile that scrolls into view at t=5s is still stuck behind 194 tiles
// that nobody is looking at.
//
// `PrepareQueue` is an application-level queue that holds requests before
// they hit the network. It caps concurrency at a configurable limit
// (default 6, matching the HTTP/1.1 per-origin pool) and lets callers
// reorder pending work: `boost(url)` moves a URL to the front so a
// scroll-into-view trigger actually jumps the line.
//
//   const queue = new PrepareQueue({ concurrency: 6 })
//   const p1 = queue.enqueue(url1)
//   const p2 = queue.enqueue(url2)
//   // ... user scrolls to url50 ...
//   queue.boost(url50)
//
// Duplicate enqueues for the same URL share a single in-flight prepare,
// so calling `enqueue(url)` is idempotent and cheap. `clear()` drops the
// pending backlog but does not abort work that's already started.

import { prepare, type PreparedImage, type PrepareOptions } from './prepare.js'
import { normalizeSrc } from './analysis.js'

export type PrepareQueueOptions = {
  concurrency?: number
}

type PendingEntry = {
  key: string
  src: string
  options: PrepareOptions
  resolve: (value: PreparedImage) => void
  reject: (err: unknown) => void
}

type InflightEntry = {
  promise: Promise<PreparedImage>
}

export class PrepareQueue {
  readonly concurrency: number
  private readonly pending: PendingEntry[] = []
  private readonly pendingByKey = new Map<string, PendingEntry>()
  private readonly inflight = new Map<string, InflightEntry>()
  private readonly shared = new Map<string, Promise<PreparedImage>>()

  constructor(options: PrepareQueueOptions = {}) {
    const c = options.concurrency ?? 6
    if (!Number.isFinite(c) || c < 1) {
      throw new RangeError(`PrepareQueue: concurrency must be a positive integer, got ${c}.`)
    }
    this.concurrency = Math.floor(c)
  }

  // Enqueue a prepare. Returns a shared promise — calling `enqueue` twice
  // for the same URL reuses the in-flight work.
  enqueue(src: string, options: PrepareOptions = {}): Promise<PreparedImage> {
    const key = normalizeSrc(src)
    const existingShared = this.shared.get(key)
    if (existingShared !== undefined) return existingShared
    const existingPending = this.pendingByKey.get(key)
    if (existingPending !== undefined) {
      // Already pending — reuse the promise that was minted when it was
      // first enqueued. The `shared` map holds that promise.
      const shared = this.shared.get(key)
      if (shared !== undefined) return shared
    }

    let resolveOuter!: (value: PreparedImage) => void
    let rejectOuter!: (err: unknown) => void
    const promise = new Promise<PreparedImage>((resolve, reject) => {
      resolveOuter = resolve
      rejectOuter = reject
    })
    this.shared.set(key, promise)

    const entry: PendingEntry = {
      key,
      src,
      options,
      resolve: resolveOuter,
      reject: rejectOuter,
    }
    this.pending.push(entry)
    this.pendingByKey.set(key, entry)
    this.drain()
    return promise
  }

  // Move a URL to the front of the pending queue. If it's already
  // in-flight or complete, this is a no-op.
  boost(src: string): boolean {
    const key = normalizeSrc(src)
    const entry = this.pendingByKey.get(key)
    if (entry === undefined) return false
    const idx = this.pending.indexOf(entry)
    if (idx <= 0) return idx === 0
    this.pending.splice(idx, 1)
    this.pending.unshift(entry)
    return true
  }

  // Drop everything that hasn't started yet. Requests already in-flight
  // continue to completion — cancelling them would leak partial
  // measurements and require AbortController plumbing that fights the
  // browser's own connection reuse.
  clear(): void {
    for (const entry of this.pending) {
      this.pendingByKey.delete(entry.key)
      this.shared.delete(entry.key)
      entry.reject(new Error('preimage: prepare cancelled — queue cleared.'))
    }
    this.pending.length = 0
  }

  // How many requests are currently blocked waiting on the concurrency
  // cap. Callers use this to decide whether to keep enqueuing or back
  // off (e.g. skip prepare for tiles below the fold).
  get pendingCount(): number {
    return this.pending.length
  }

  get inflightCount(): number {
    return this.inflight.size
  }

  private drain(): void {
    while (this.inflight.size < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!
      this.pendingByKey.delete(entry.key)
      this.start(entry)
    }
  }

  private start(entry: PendingEntry): void {
    const promise = prepare(entry.src, entry.options)
    this.inflight.set(entry.key, { promise })
    promise.then(
      (value) => {
        entry.resolve(value)
      },
      (err) => {
        entry.reject(err)
      },
    ).finally(() => {
      this.inflight.delete(entry.key)
      this.shared.delete(entry.key)
      this.drain()
    })
  }
}
