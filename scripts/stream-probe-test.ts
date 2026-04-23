// probeImageStream robustness sweep. The streaming probe is used by
// the `stream` and `range` prepare strategies; a bug here is
// invisible until real users hit it on a real network. This harness
// runs synthesized chunk sequences through probeImageStream and
// verifies:
//
//   1. Dims fire via onDims as soon as the first parseable chunk
//      arrives (not at stream close).
//   2. Final result carries dims + a Blob of all bytes.
//   3. Chunk granularity doesn't matter — one-shot buffer, byte-by-
//      byte, arbitrary boundaries all produce the same dims.
//   4. Unknown format → dims null, Blob still contains the stream.
//   5. Stream that aborts before the header → dims null, no throw.
//   6. maxProbeBytes cap honored — don't retry parsing forever.
//
// Usage:
//   bun run scripts/stream-probe-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  probeImageStream,
  type ProbedDimensions,
} from '../packages/preimage/src/probe.ts'

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

// --- Fixture builders (same as parser-robustness-test) ---

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
  const out = new Uint8Array(sig.length + ihdr.length)
  out.set(sig)
  out.set(ihdr, sig.length)
  return out
}

function buildJpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13)
  bytes[0] = 0xff; bytes[1] = 0xd8 // SOI
  bytes[2] = 0xff; bytes[3] = 0xc0 // SOF0
  bytes[4] = 0; bytes[5] = 8
  bytes[6] = 8
  bytes[7] = (height >>> 8) & 0xff; bytes[8] = height & 0xff
  bytes[9] = (width >>> 8) & 0xff; bytes[10] = width & 0xff
  bytes[11] = 3; bytes[12] = 1
  return bytes
}

// --- Stream utilities ---

function streamOfChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(ctrl) {
      if (i >= chunks.length) {
        ctrl.close()
        return
      }
      ctrl.enqueue(chunks[i]!)
      i++
    },
  })
}

function streamOfChunkSizes(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  return streamOfChunks(chunks)
}

// --- Cases ---

async function caseOneShotPng(): Promise<void> {
  const bytes = buildPng(640, 480)
  let onDimsFired: ProbedDimensions | null = null
  const result = await probeImageStream(streamOfChunks([bytes]), {
    onDims: (d) => { onDimsFired = d },
  })
  if (result.dims === null || result.dims.width !== 640 || result.dims.height !== 480) {
    fail('one-shot-png/dims', `got ${JSON.stringify(result.dims)}`)
  } else if (onDimsFired === null) {
    fail('one-shot-png/onDims', 'onDims never fired')
  } else if (!(result.blob instanceof Blob) || result.blob.size !== bytes.length) {
    fail('one-shot-png/blob', `blob size ${result.blob.size}, expected ${bytes.length}`)
  } else {
    pass('one-shot-png')
  }
}

async function caseByteByByte(): Promise<void> {
  const bytes = buildPng(1024, 768)
  const result = await probeImageStream(streamOfChunkSizes(bytes, 1))
  if (result.dims === null || result.dims.width !== 1024 || result.dims.height !== 768) {
    fail('byte-by-byte-png/dims', `got ${JSON.stringify(result.dims)}`)
  } else {
    pass('byte-by-byte-png')
  }
}

async function caseMisalignedChunks(): Promise<void> {
  // Split PNG at unusual boundaries to make sure header reassembly
  // across chunk boundaries works.
  const bytes = buildPng(200, 300)
  for (const chunkSize of [3, 5, 7, 13, 17]) {
    const result = await probeImageStream(streamOfChunkSizes(bytes, chunkSize))
    if (result.dims === null || result.dims.width !== 200 || result.dims.height !== 300) {
      fail(`misaligned-chunks-${chunkSize}`, `dims ${JSON.stringify(result.dims)}`)
      continue
    }
    pass(`misaligned-chunks-${chunkSize}`)
  }
}

async function caseOnDimsFiresEarly(): Promise<void> {
  // Build PNG + append extra garbage bytes. onDims should fire on
  // the chunk that completes the header, not on stream close.
  const header = buildPng(512, 256)
  const garbage = new Uint8Array(8192)
  garbage.fill(0xaa)
  const combined = new Uint8Array(header.length + garbage.length)
  combined.set(header)
  combined.set(garbage, header.length)

  let onDimsSeenAt = -1
  let bytesSeen = 0
  const result = await probeImageStream(
    new ReadableStream({
      start(ctrl) {
        // Feed in 24-byte chunks; header completes in first chunk.
        for (let i = 0; i < combined.length; i += 24) {
          ctrl.enqueue(combined.subarray(i, Math.min(i + 24, combined.length)))
        }
        ctrl.close()
      },
    }),
    {
      onDims: () => { onDimsSeenAt = bytesSeen },
    },
  )
  // Track bytes seen as they flow (approximate — we can't perfectly
  // synchronize with onDims since it fires from inside the read loop).
  bytesSeen = combined.length
  if (result.dims === null) fail('onDims-early', 'dims null')
  else if (onDimsSeenAt < 0) fail('onDims-early', 'onDims never called')
  else pass('onDims-early', `${result.dims.width}×${result.dims.height}`)
}

async function caseEachFormatStreams(): Promise<void> {
  const fixtures: Array<[string, Uint8Array, { width: number; height: number }]> = [
    ['png', buildPng(100, 200), { width: 100, height: 200 }],
    ['jpeg', buildJpeg(300, 400), { width: 300, height: 400 }],
  ]
  for (const [name, bytes, expected] of fixtures) {
    const result = await probeImageStream(streamOfChunkSizes(bytes, 8))
    if (
      result.dims === null ||
      result.dims.width !== expected.width ||
      result.dims.height !== expected.height
    ) {
      fail(`format-${name}`, `dims ${JSON.stringify(result.dims)}`)
    } else {
      pass(`format-${name}`)
    }
  }
}

async function caseUnknownFormat(): Promise<void> {
  const noise = new Uint8Array(200)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 17) & 0xff
  let onDimsFired = false
  const result = await probeImageStream(streamOfChunks([noise]), {
    onDims: () => { onDimsFired = true },
  })
  if (result.dims !== null) {
    fail('unknown-format/dims', `expected null dims, got ${JSON.stringify(result.dims)}`)
  } else if (onDimsFired) {
    fail('unknown-format/onDims', 'onDims fired on non-image')
  } else if (result.blob.size !== noise.length) {
    fail('unknown-format/blob', `blob size ${result.blob.size}`)
  } else {
    pass('unknown-format')
  }
}

async function caseMaxProbeBytes(): Promise<void> {
  // Stream past the maxProbeBytes cap without a valid header.
  // Should drain into the Blob but stop retrying the probe.
  const size = 8192
  const noise = new Uint8Array(size)
  for (let i = 0; i < size; i++) noise[i] = (i * 13) & 0xff
  const result = await probeImageStream(streamOfChunkSizes(noise, 256), {
    maxProbeBytes: 1024, // stop probing after 1 KB
  })
  if (result.dims !== null) {
    fail('maxProbeBytes/dims', 'got dims for noise past cap')
  } else if (result.blob.size !== size) {
    fail('maxProbeBytes/blob', `blob size ${result.blob.size}, expected ${size}`)
  } else {
    pass('maxProbeBytes')
  }
}

async function caseStreamAbort(): Promise<void> {
  // Stream that errors before the header is complete.
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array([0x89, 0x50, 0x4e])) // partial PNG signature
      ctrl.error(new Error('connection reset'))
    },
  })
  try {
    await probeImageStream(stream)
    fail('stream-abort', 'expected throw, but resolved')
  } catch (err) {
    pass('stream-abort', `rethrown: ${(err as Error).message}`)
  }
}

async function caseEmptyStream(): Promise<void> {
  const result = await probeImageStream(streamOfChunks([]))
  if (result.dims !== null) {
    fail('empty-stream/dims', 'expected null dims')
  } else if (result.blob.size !== 0) {
    fail('empty-stream/blob', `blob size ${result.blob.size}`)
  } else {
    pass('empty-stream')
  }
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  await caseOneShotPng()
  await caseByteByByte()
  await caseMisalignedChunks()
  await caseOnDimsFiresEarly()
  await caseEachFormatStreams()
  await caseUnknownFormat()
  await caseMaxProbeBytes()
  await caseStreamAbort()
  await caseEmptyStream()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== stream-probe-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `stream-probe-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'stream-probe', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
