// Managed concurrency for `prepare()`. Browsers cap parallel requests per
// origin (6 hardcoded for HTTP/1.1; HTTP/2 multiplexes many streams over
// one connection, typically 100+ before server-side flow control pushes
// back). When a gallery page blindly fires `prepare()` for 200 tiles,
// later tiles queue inside the browser's network stack for tens of
// seconds, and there's no way to reprioritize: a tile that scrolls into
// view at t=5s is still stuck behind 194 tiles that nobody is looking at.
//
// `PrepareQueue` is an application-level queue that holds requests before
// they hit the network. It caps concurrency at a configurable limit and
// lets callers reorder pending work: `boost(url)` moves a URL to the
// front so a scroll-into-view trigger actually jumps the line.
//
// The default concurrency is adaptive: 50 for ordinary connections (the
// HTTP/2 sweet spot) and 6 for save-data / slow cellular hints. On
// HTTP/1.1 origins the browser's own 6-slot cap still gatekeeps; pass a
// lower explicit value when you want probes to leave room for render-side
// fetches.
//
//   const queue = new PrepareQueue({ concurrency: 50 })
//   const p1 = queue.enqueue(url1)
//   const p2 = queue.enqueue(url2)
//   // ... user scrolls to url50 ...
//   queue.boost(url50)
//
// Duplicate enqueues for the same URL and equivalent prepare options
// share a single in-flight prepare, so repeated `enqueue(url, options)`
// calls are idempotent and cheap. `clear()` drops the pending backlog
// but does not abort work that's already started.

import { prepare, type PreparedImage, type PrepareOptions } from './prepare.js'
import { normalizeSrc } from './analysis.js'

export type PrepareQueueOptions = {
  /** Cap on in-flight `prepare()` calls. When omitted, the library
   *  picks a value based on `navigator.connection` hints: 6 for
   *  data-saver / 2g / 3g (gentle on metered or slow links), 50
   *  otherwise (HTTP/2 sweet spot). Pass an explicit number to
   *  override this entirely. */
  concurrency?: number
}

/** Pick a reasonable concurrency default from the current environment.
 *  Respects `navigator.connection.saveData` and `effectiveType` so
 *  metered / slow links don't get blasted with 50 parallel probes. */
export function pickAdaptiveConcurrency(): number {
  if (typeof navigator === 'undefined') return 50
  const conn = (navigator as unknown as {
    connection?: { saveData?: boolean; effectiveType?: string }
  }).connection
  if (conn === undefined) return 50
  if (conn.saveData === true) return 6
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g') {
    return 6
  }
  return 50
}

type PendingEntry = {
  key: string
  srcKey: string
  src: string
  options: PrepareOptions
  promise: Promise<PreparedImage>
  resolve: (value: PreparedImage) => void
  reject: (err: unknown) => void
}

let nextSignalId = 1
const signalIds = new WeakMap<AbortSignal, number>()

function signalKey(signal: AbortSignal | undefined): number | null {
  if (signal === undefined) return null
  let id = signalIds.get(signal)
  if (id === undefined) {
    id = nextSignalId++
    signalIds.set(signal, id)
  }
  return id
}

function sortedRangeBytesByFormat(options: PrepareOptions): Array<[string, number]> | null {
  const map = options.rangeBytesByFormat
  if (map === undefined) return null
  return Object.entries(map)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
}

function prepareKey(src: string, options: PrepareOptions): { key: string; srcKey: string } {
  const srcKey = normalizeSrc(src)
  const optionKey = JSON.stringify({
    crossOrigin: options.crossOrigin ?? null,
    dimsOnly: options.dimsOnly ?? null,
    fallbackToImgOnFetchError: options.fallbackToImgOnFetchError ?? null,
    orientation: options.orientation ?? null,
    rangeBytes: options.rangeBytes ?? null,
    rangeBytesByFormat: sortedRangeBytesByFormat(options),
    rangeRetryBytes: options.rangeRetryBytes ?? null,
    signal: signalKey(options.signal),
    strategy: options.strategy ?? null,
  })
  return { key: `${srcKey}\u0000${optionKey}`, srcKey }
}

export class PrepareQueue {
  readonly concurrency: number
  private readonly pending: PendingEntry[] = []
  private readonly pendingByKey = new Map<string, PendingEntry>()
  // Key → the outer promise callers hold. Used for dedup: a repeat
  // enqueue for the same URL while work is running returns this same
  // promise. Deleted in `start`'s finally so a post-resolution enqueue
  // kicks off fresh work.
  private readonly inflight = new Map<string, Promise<PreparedImage>>()

  constructor(options: PrepareQueueOptions = {}) {
    const c = options.concurrency ?? pickAdaptiveConcurrency()
    if (!Number.isFinite(c) || c < 1) {
      throw new RangeError(`PrepareQueue: concurrency must be a positive integer, got ${c}.`)
    }
    this.concurrency = Math.floor(c)
  }

  // Enqueue a prepare. Returns a shared promise — calling `enqueue` twice
  // for the same URL with equivalent options reuses the in-flight work.
  enqueue(src: string, options: PrepareOptions = {}): Promise<PreparedImage> {
    const { key, srcKey } = prepareKey(src, options)
    const existingInflight = this.inflight.get(key)
    if (existingInflight !== undefined) return existingInflight
    const existingPending = this.pendingByKey.get(key)
    if (existingPending !== undefined) return existingPending.promise

    let resolveOuter!: (value: PreparedImage) => void
    let rejectOuter!: (err: unknown) => void
    const promise = new Promise<PreparedImage>((resolve, reject) => {
      resolveOuter = resolve
      rejectOuter = reject
    })

    const entry: PendingEntry = {
      key,
      srcKey,
      src,
      options,
      promise,
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
    const srcKey = normalizeSrc(src)
    const idx = this.pending.findIndex((entry) => entry.srcKey === srcKey)
    if (idx < 0) return false
    if (idx <= 0) return idx === 0
    const entry = this.pending[idx]!
    this.pending.splice(idx, 1)
    this.pending.unshift(entry)
    return true
  }

  // Move a set of URLs to the front of the pending queue in the order
  // given. Primary caller: a virtualization or gallery flow that has
  // enqueued everything up front, then computed which K items will
  // land in the first viewport — `boostMany(firstScreenUrls)` jumps
  // them ahead of the below-fold backlog in one pass. URLs already
  // in-flight, absent, or reordered by this same call are handled
  // idempotently.
  boostMany(srcs: readonly string[]): void {
    if (srcs.length === 0) return
    const keys = new Set(srcs.map(normalizeSrc))
    // Pull every matching entry out of its current position while
    // preserving caller-supplied order at the front.
    const matched = new Map<string, PendingEntry[]>()
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const entry = this.pending[i]!
      if (keys.has(entry.srcKey)) {
        const list = matched.get(entry.srcKey) ?? []
        list.unshift(entry)
        matched.set(entry.srcKey, list)
        this.pending.splice(i, 1)
      }
    }
    const front: PendingEntry[] = []
    for (const src of srcs) {
      const entries = matched.get(normalizeSrc(src))
      if (entries !== undefined) front.push(...entries)
    }
    this.pending.unshift(...front)
  }

  // Move a set of URLs to the back of the pending queue — the inverse
  // of `boostMany`. Useful when the caller knows specific URLs are
  // below-fold or low-priority and wants to unblock everything else.
  deprioritizeMany(srcs: readonly string[]): void {
    if (srcs.length === 0) return
    const keys = new Set(srcs.map(normalizeSrc))
    const moved: PendingEntry[] = []
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const entry = this.pending[i]!
      if (keys.has(entry.srcKey)) {
        moved.unshift(entry) // preserve original relative order
        this.pending.splice(i, 1)
      }
    }
    this.pending.push(...moved)
  }

  // Drop everything that hasn't started yet. Requests already in-flight
  // continue to completion — cancelling them would leak partial
  // measurements and require AbortController plumbing that fights the
  // browser's own connection reuse.
  clear(): void {
    for (const entry of this.pending) {
      this.pendingByKey.delete(entry.key)
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
    this.inflight.set(entry.key, entry.promise)
    prepare(entry.src, entry.options).then(
      (value) => {
        entry.resolve(value)
      },
      (err) => {
        entry.reject(err)
      },
    ).finally(() => {
      this.inflight.delete(entry.key)
      this.drain()
    })
  }
}
