// Batched probe client + wire format. Phase 1 of Swing 2.
//
// Coalesces many `prepare()` calls against a preimage-aware origin
// into a single POST request. The origin returns one binary response
// with a probe record per URL — {clientIndex, status, dims, flags,
// byteLength}. The client fans the results back out to the pending
// `prepare()` promises.
//
// This is the "direct client" implementation. A transparent service
// worker that intercepts image-probe fetches and coalesces them
// without consumer code changes is phase 3 (PR #3 doc). For the
// spike we opt in explicitly via `strategy: 'batched'`.
//
// Wire format (everything big-endian):
//
//   request  (POST /preimage/probe body):
//     u32 urlCount
//     for each url:
//       u16 urlLen
//       u8[urlLen] urlUtf8
//
//   response:
//     u32 recordCount
//     for each record:
//       u32 clientIndex    (index into the urls[] the client sent)
//       u8  status         (0 ok, 1 not-found, 2 probe-failed, 3 denied)
//       if status == 0:
//         u32 width
//         u32 height
//         u16 flags        (bit 0 hasAlpha, bit 1 progressive,
//                           bits 2-3 format:
//                             0=jpeg 1=png 2=webp 3=other)
//         u32 byteLength
//
// The clientIndex correlation lets servers reorder records for
// parallel probing without constraining the wire.

export type BatchedProbeStatus = 'ok' | 'not-found' | 'probe-failed' | 'denied'

export type BatchedProbeFormat = 'jpeg' | 'png' | 'webp' | 'other'

export type BatchedProbeRecord =
  | {
      clientIndex: number
      status: 'ok'
      width: number
      height: number
      hasAlpha: boolean
      isProgressive: boolean
      format: BatchedProbeFormat
      byteLength: number
    }
  | {
      clientIndex: number
      status: Exclude<BatchedProbeStatus, 'ok'>
    }

// --- Flag bits ---

const FLAG_HAS_ALPHA = 0x0001
const FLAG_PROGRESSIVE = 0x0002
const FORMAT_SHIFT = 2
const FORMAT_MASK = 0x000c
const FORMAT_CODES: Record<BatchedProbeFormat, number> = {
  jpeg: 0,
  png: 1,
  webp: 2,
  other: 3,
}
const FORMAT_BY_CODE: readonly BatchedProbeFormat[] = ['jpeg', 'png', 'webp', 'other']

const STATUS_CODES: Record<BatchedProbeStatus, number> = {
  ok: 0,
  'not-found': 1,
  'probe-failed': 2,
  denied: 3,
}
const STATUS_BY_CODE: readonly BatchedProbeStatus[] = ['ok', 'not-found', 'probe-failed', 'denied']

// --- Encode: request ---

export function encodeBatchedRequest(urls: readonly string[]): Uint8Array {
  const encoder = new TextEncoder()
  const encoded = urls.map((u) => encoder.encode(u))
  const total =
    4 + // u32 count
    encoded.reduce((sum, bytes) => sum + 2 + bytes.byteLength, 0) // u16 len + bytes
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let off = 0
  view.setUint32(off, urls.length, false)
  off += 4
  for (const bytes of encoded) {
    if (bytes.byteLength > 0xffff) {
      throw new RangeError(
        `encodeBatchedRequest: URL exceeds u16 length (${bytes.byteLength} bytes)`,
      )
    }
    view.setUint16(off, bytes.byteLength, false)
    off += 2
    out.set(bytes, off)
    off += bytes.byteLength
  }
  return out
}

export function decodeBatchedRequest(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let off = 0
  const count = view.getUint32(off, false)
  off += 4
  const urls: string[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const len = view.getUint16(off, false)
    off += 2
    urls[i] = decoder.decode(bytes.subarray(off, off + len))
    off += len
  }
  return urls
}

// --- Encode: response ---

const RECORD_OK_SIZE = 4 + 1 + 4 + 4 + 2 + 4 // clientIndex + status + w + h + flags + byteLength
const RECORD_ERR_SIZE = 4 + 1 // clientIndex + status

export function encodeBatchedResponse(records: readonly BatchedProbeRecord[]): Uint8Array {
  const total =
    4 +
    records.reduce((sum, r) => sum + (r.status === 'ok' ? RECORD_OK_SIZE : RECORD_ERR_SIZE), 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let off = 0
  view.setUint32(off, records.length, false)
  off += 4
  for (const r of records) {
    view.setUint32(off, r.clientIndex, false)
    off += 4
    view.setUint8(off, STATUS_CODES[r.status])
    off += 1
    if (r.status === 'ok') {
      view.setUint32(off, r.width, false)
      off += 4
      view.setUint32(off, r.height, false)
      off += 4
      let flags = 0
      if (r.hasAlpha) flags |= FLAG_HAS_ALPHA
      if (r.isProgressive) flags |= FLAG_PROGRESSIVE
      flags |= (FORMAT_CODES[r.format] << FORMAT_SHIFT) & FORMAT_MASK
      view.setUint16(off, flags, false)
      off += 2
      view.setUint32(off, r.byteLength, false)
      off += 4
    }
  }
  return out
}

export function decodeBatchedResponse(bytes: Uint8Array): BatchedProbeRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 0
  const count = view.getUint32(off, false)
  off += 4
  const records: BatchedProbeRecord[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const clientIndex = view.getUint32(off, false)
    off += 4
    const statusByte = view.getUint8(off)
    off += 1
    const status = STATUS_BY_CODE[statusByte]
    if (status === undefined) throw new RangeError(`decodeBatchedResponse: bad status ${statusByte}`)
    if (status === 'ok') {
      const width = view.getUint32(off, false)
      off += 4
      const height = view.getUint32(off, false)
      off += 4
      const flags = view.getUint16(off, false)
      off += 2
      const byteLength = view.getUint32(off, false)
      off += 4
      const formatCode = (flags & FORMAT_MASK) >> FORMAT_SHIFT
      const format = FORMAT_BY_CODE[formatCode] ?? 'other'
      records[i] = {
        clientIndex,
        status: 'ok',
        width,
        height,
        hasAlpha: (flags & FLAG_HAS_ALPHA) !== 0,
        isProgressive: (flags & FLAG_PROGRESSIVE) !== 0,
        format,
        byteLength,
      }
    } else {
      records[i] = { clientIndex, status }
    }
  }
  return records
}

// --- Client: direct batching (no service worker) ---

export type BatchedProbeClientOptions = {
  /** URL to POST batched requests to. Server must speak the wire
   *  format above. */
  endpoint: string
  /** How many pending URLs trigger an immediate flush. Default 100. */
  maxBatchSize?: number
  /** Max delay between a `probe()` call and the batch POST. Shorter
   *  = lower per-probe latency; longer = more batching. Default 8ms. */
  maxBatchDelayMs?: number
  /** How many batches can be in-flight simultaneously. Default 4. */
  maxInflightBatches?: number
}

type PendingProbe = {
  url: string
  resolve: (record: BatchedProbeRecord) => void
  reject: (err: unknown) => void
}

/** Client for the batched-probe endpoint. One instance per origin;
 *  `prepare()` routes through this when `strategy: 'batched'`. */
export class BatchedProbeClient {
  readonly endpoint: string
  private readonly maxBatchSize: number
  private readonly maxBatchDelayMs: number
  private readonly maxInflightBatches: number
  private pending: PendingProbe[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private inflight = 0

  constructor(options: BatchedProbeClientOptions) {
    this.endpoint = options.endpoint
    this.maxBatchSize = options.maxBatchSize ?? 100
    this.maxBatchDelayMs = options.maxBatchDelayMs ?? 8
    this.maxInflightBatches = options.maxInflightBatches ?? 4
  }

  /** Enqueue a URL for batched probing. Resolves with the record
   *  when the batch lands. Errors (network failure, 5xx) are thrown
   *  via `reject`; status-level failures (not-found, probe-failed,
   *  denied) resolve normally with the corresponding status. */
  probe(url: string): Promise<BatchedProbeRecord> {
    return new Promise((resolve, reject) => {
      this.pending.push({ url, resolve, reject })
      if (this.pending.length >= this.maxBatchSize) {
        this.flushNow()
      } else if (this.flushTimer === null) {
        this.flushTimer = setTimeout(() => this.flushNow(), this.maxBatchDelayMs)
      }
    })
  }

  private flushNow(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pending.length === 0) return
    // Respect the inflight cap. If we're full, re-schedule a short
    // retry; we don't want to silently block probes.
    if (this.inflight >= this.maxInflightBatches) {
      this.flushTimer = setTimeout(() => this.flushNow(), this.maxBatchDelayMs)
      return
    }
    const batch = this.pending
    this.pending = []
    void this.sendBatch(batch)
  }

  private async sendBatch(batch: readonly PendingProbe[]): Promise<void> {
    this.inflight++
    try {
      const urls = batch.map((p) => p.url)
      const body = encodeBatchedRequest(urls)
      // Convert to a proper ArrayBuffer — modern TS narrows
      // `Uint8Array<ArrayBufferLike>` too strictly for BodyInit,
      // so we hand fetch an ArrayBuffer directly.
      const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: buf,
      })
      if (!response.ok) {
        const err = new Error(
          `batched-probe: ${this.endpoint} returned ${response.status}`,
        )
        for (const p of batch) p.reject(err)
        return
      }
      const responseBytes = new Uint8Array(await response.arrayBuffer())
      const records = decodeBatchedResponse(responseBytes)
      // Correlate by clientIndex. The server can reorder records
      // freely; we just look up the right pending probe.
      for (const record of records) {
        const pending = batch[record.clientIndex]
        if (pending === undefined) continue
        pending.resolve(record)
      }
      // Reject any pending that didn't get a record (server dropped it).
      for (let i = 0; i < batch.length; i++) {
        const pending = batch[i]!
        const received = records.some((r) => r.clientIndex === i)
        if (!received) {
          pending.reject(
            new Error(`batched-probe: server returned no record for index ${i}`),
          )
        }
      }
    } catch (err) {
      for (const p of batch) p.reject(err)
    } finally {
      this.inflight--
      // If more probes accumulated while we were in-flight and no
      // timer is pending, kick another flush.
      if (this.pending.length > 0 && this.flushTimer === null) {
        if (this.pending.length >= this.maxBatchSize) this.flushNow()
        else this.flushTimer = setTimeout(() => this.flushNow(), this.maxBatchDelayMs)
      }
    }
  }
}

// --- Module-level singleton for prepare.ts integration ---

let activeClient: BatchedProbeClient | null = null

/** Configure the batched probe client. Must be called before any
 *  `prepare(url, { strategy: 'batched' })` call; otherwise the
 *  strategy throws. */
export function configureBatchedProbe(options: BatchedProbeClientOptions): void {
  activeClient = new BatchedProbeClient(options)
}

/** Clear the active batched probe client. Subsequent strategy:
 *  'batched' calls throw until `configureBatchedProbe` runs again. */
export function clearBatchedProbeClient(): void {
  activeClient = null
}

/** Internal API used by `prepareFromUrlBatched` in prepare.ts. */
export function getActiveBatchedProbeClient(): BatchedProbeClient | null {
  return activeClient
}
