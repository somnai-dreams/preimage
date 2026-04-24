// prepare() strategy coverage. The byte-level parser harnesses catch
// header bugs; this one covers the prepare() glue around fetch
// cancellation, Range fallback, and Blob EXIF orientation.
//
// Usage:
//   bun run scripts/prepare-strategy-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clearCache,
  clearOriginStrategyCache,
  disposePreparedImage,
  prepare,
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

// --- Fixture builders ---

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff])
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ])
}

function buildPng(width: number, height: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(25)
  ihdr[3] = 13
  ihdr[4] = 0x49; ihdr[5] = 0x48; ihdr[6] = 0x44; ihdr[7] = 0x52
  ihdr[8] = (width >>> 24) & 0xff; ihdr[9] = (width >>> 16) & 0xff
  ihdr[10] = (width >>> 8) & 0xff; ihdr[11] = width & 0xff
  ihdr[12] = (height >>> 24) & 0xff; ihdr[13] = (height >>> 16) & 0xff
  ihdr[14] = (height >>> 8) & 0xff; ihdr[15] = height & 0xff
  ihdr[16] = 8; ihdr[17] = 6
  return concat(sig, ihdr)
}

function buildSof0(width: number, height: number): Uint8Array {
  return concat(
    new Uint8Array([0xff, 0xc0]),
    u16be(8),
    new Uint8Array([8]),
    u16be(height),
    u16be(width),
    new Uint8Array([3]),
  )
}

function buildExifSegment(orientation: number): Uint8Array {
  const exif = new TextEncoder().encode('Exif\0\0')
  const tiff = concat(
    new Uint8Array([0x4d, 0x4d]), // big-endian "MM"
    u16be(42),
    u32be(8),
    u16be(1),
    u16be(0x0112),
    u16be(3),
    u32be(1),
    u16be(orientation),
    new Uint8Array([0, 0]),
    u32be(0),
  )
  const payload = concat(exif, tiff)
  return concat(new Uint8Array([0xff, 0xe1]), u16be(payload.byteLength + 2), payload)
}

function buildExifJpeg(width: number, height: number, orientation: number): Uint8Array {
  return concat(
    new Uint8Array([0xff, 0xd8]),
    buildExifSegment(orientation),
    buildSof0(width, height),
    new Uint8Array([0xff, 0xd9]),
  )
}

// --- Fetch stub ---

type HeaderFetchStub = {
  aborted: boolean
  fetchCount: number
  pulls: number
  tailSent: boolean
  rangeHeader: string | null
  restore: () => void
}

type FetchCountStub = {
  count: number
  restore: () => void
}

function installCountingFetch(response: () => Response): FetchCountStub {
  const originalFetch = globalThis.fetch
  const stub: FetchCountStub = {
    count: 0,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
  globalThis.fetch = (() => {
    stub.count++
    return Promise.resolve(response())
  }) as typeof fetch
  return stub
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (headers === undefined) return null
  const lower = name.toLowerCase()
  if (headers instanceof Headers) return headers.get(name)
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === lower) return value
    }
    return null
  }
  const record = headers as Record<string, string>
  return record[name] ?? record[lower] ?? null
}

function installHeaderThenTailFetch(status: number): HeaderFetchStub {
  const originalFetch = globalThis.fetch
  const header = buildPng(640, 480)
  const tail = new Uint8Array(1024 * 1024)
  tail.fill(0xaa)
  const stub: HeaderFetchStub = {
    aborted: false,
    fetchCount: 0,
    pulls: 0,
    tailSent: false,
    rangeHeader: null,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }

  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    void input
    stub.fetchCount++
    stub.rangeHeader = headerValue(init?.headers, 'Range')
    const signal = init?.signal
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          'abort',
          () => {
            stub.aborted = true
            controller.error(new DOMException('Aborted', 'AbortError'))
          },
          { once: true },
        )
      },
      async pull(controller) {
        stub.pulls++
        if (stub.pulls === 1) {
          controller.enqueue(header)
        } else {
          await new Promise((resolve) => setTimeout(resolve, 0))
          if (signal?.aborted === true) return
          stub.tailSent = true
          controller.enqueue(tail)
          controller.close()
        }
      },
    })
    return Promise.resolve(
      new Response(stream, {
        status,
        headers: { 'content-length': String(header.byteLength + tail.byteLength) },
      }),
    )
  }) as typeof fetch

  return stub
}

// --- Cases ---

async function caseStreamAbortsAfterDims(): Promise<void> {
  clearCache()
  clearOriginStrategyCache()
  const stub = installHeaderThenTailFetch(200)
  try {
    const prepared = await prepare('https://stream.example/photo.png?case=stream', { strategy: 'stream' })
    if (prepared.width !== 640 || prepared.height !== 480) {
      fail('stream-abort/dims', `got ${prepared.width}x${prepared.height}`)
    } else if (!stub.aborted) {
      fail('stream-abort/abort', 'fetch signal was not aborted after dims')
    } else if (stub.tailSent) {
      fail('stream-abort/tail', 'tail bytes were sent after dims')
    } else {
      pass('stream-abort')
    }
  } finally {
    stub.restore()
  }
}

async function caseRangeFallbackAbortsAfterDims(): Promise<void> {
  clearCache()
  clearOriginStrategyCache()
  const stub = installHeaderThenTailFetch(200)
  try {
    const prepared = await prepare('https://no-range.example/photo.png?case=range', {
      dimsOnly: true,
      strategy: 'range',
    })
    if (prepared.width !== 640 || prepared.height !== 480) {
      fail('range-200-fallback/dims', `got ${prepared.width}x${prepared.height}`)
    } else if (stub.rangeHeader === null) {
      fail('range-200-fallback/range-header', 'missing Range request header')
    } else if (!stub.aborted) {
      fail('range-200-fallback/abort', 'fallback stream was not aborted after dims')
    } else if (stub.tailSent) {
      fail('range-200-fallback/tail', 'tail bytes were sent after dims')
    } else {
      pass('range-200-fallback', stub.rangeHeader)
    }
  } finally {
    stub.restore()
  }
}

async function caseBlobExifOrientation(): Promise<void> {
  clearCache()
  const bytes = buildExifJpeg(300, 400, 6)
  const prepared = await prepare(new Blob([bytes], { type: 'image/jpeg' }))
  if (prepared.measurement.orientation !== 6) {
    fail('blob-exif/orientation', `got ${prepared.measurement.orientation}`)
  } else if (prepared.measurement.naturalWidth !== 300 || prepared.measurement.naturalHeight !== 400) {
    fail(
      'blob-exif/natural',
      `got ${prepared.measurement.naturalWidth}x${prepared.measurement.naturalHeight}`,
    )
  } else if (prepared.width !== 400 || prepared.height !== 300) {
    fail('blob-exif/display', `got ${prepared.width}x${prepared.height}`)
  } else {
    pass('blob-exif-orientation')
  }
}

async function caseDisposeBlobPreparedImage(): Promise<void> {
  clearCache()
  const urlApi = URL as unknown as {
    createObjectURL: (blob: Blob) => string
    revokeObjectURL: (url: string) => void
  }
  const originalCreateObjectUrl = urlApi.createObjectURL
  const originalRevokeObjectUrl = urlApi.revokeObjectURL
  const revoked: string[] = []
  urlApi.createObjectURL = () => 'blob:preimage-test'
  urlApi.revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
  try {
    const prepared = await prepare(new Blob([buildPng(20, 10)], { type: 'image/png' }))
    disposePreparedImage(prepared)
    disposePreparedImage(prepared)
    if (prepared.measurement.blobUrl !== undefined) {
      fail('dispose-blob/blobUrl', `still set to ${prepared.measurement.blobUrl}`)
    } else if (JSON.stringify(revoked) !== JSON.stringify(['blob:preimage-test'])) {
      fail('dispose-blob/revoke', `got ${JSON.stringify(revoked)}`)
    } else {
      pass('dispose-blob')
    }
  } finally {
    urlApi.createObjectURL = originalCreateObjectUrl
    urlApi.revokeObjectURL = originalRevokeObjectUrl
  }
}

async function caseImgAbortRejects(): Promise<void> {
  clearCache()
  const g = globalThis as typeof globalThis & {
    Image?: unknown
    HTMLImageElement?: unknown
  }
  const originalImage = g.Image
  const originalHtmlImageElement = g.HTMLImageElement
  class FakeImage {
    naturalWidth = 0
    naturalHeight = 0
    complete = false
    decoding = ''
    src = ''
    private readonly listeners = new Map<string, Set<() => void>>()
    addEventListener(type: string, cb: () => void): void {
      const set = this.listeners.get(type) ?? new Set<() => void>()
      set.add(cb)
      this.listeners.set(type, set)
    }
    removeEventListener(type: string, cb: () => void): void {
      this.listeners.get(type)?.delete(cb)
    }
  }
  g.Image = FakeImage
  g.HTMLImageElement = FakeImage
  const controller = new AbortController()
  try {
    const promise = prepare('https://img-abort.example/photo.jpg', {
      strategy: 'img',
      signal: controller.signal,
    })
    controller.abort(new DOMException('Aborted', 'AbortError'))
    const result = await Promise.race([
      promise.then(
        () => 'resolved',
        (err) => (err instanceof DOMException ? err.name : err instanceof Error ? err.name : String(err)),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])
    if (result !== 'AbortError') fail('img-abort/rejects', `got ${result}`)
    else pass('img-abort/rejects')
  } finally {
    g.Image = originalImage
    g.HTMLImageElement = originalHtmlImageElement
  }
}

async function caseInvalidRangeOptions(): Promise<void> {
  clearCache()
  clearOriginStrategyCache()
  const noFetch = installCountingFetch(() => new Response(new Uint8Array(), { status: 206 }))
  try {
    let threw = false
    try {
      await prepare('https://range-invalid.example/photo.png?case=zero', {
        dimsOnly: true,
        strategy: 'range',
        rangeBytes: 0,
      })
    } catch (err) {
      threw = err instanceof RangeError
    }
    if (!threw) fail('range-options/rangeBytes-zero', 'did not throw RangeError')
    else if (noFetch.count !== 0) fail('range-options/rangeBytes-zero-fetch', `fetch count ${noFetch.count}`)
    else pass('range-options/rangeBytes-zero')
  } finally {
    noFetch.restore()
  }

  const badRetry = installCountingFetch(
    () => new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: { 'content-range': 'bytes 0-2/100' },
    }),
  )
  try {
    let threw = false
    try {
      await prepare('https://range-invalid.example/photo.png?case=retry', {
        dimsOnly: true,
        strategy: 'range',
        rangeRetryBytes: -1,
      })
    } catch (err) {
      threw = err instanceof RangeError
    }
    if (!threw) fail('range-options/rangeRetry-negative', 'did not throw RangeError')
    else if (badRetry.count !== 1) fail('range-options/rangeRetry-fetch-count', `fetch count ${badRetry.count}`)
    else pass('range-options/rangeRetry-negative')
  } finally {
    badRetry.restore()
  }
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  await caseStreamAbortsAfterDims()
  await caseRangeFallbackAbortsAfterDims()
  await caseBlobExifOrientation()
  await caseDisposeBlobPreparedImage()
  await caseImgAbortRejects()
  await caseInvalidRangeOptions()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== prepare-strategy-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `prepare-strategy-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'prepare-strategy', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
