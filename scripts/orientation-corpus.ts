// Orientation handling coverage. EXIF parsing is byte-level TIFF
// with little/big-endian variants and IFD traversal — historically
// bug-prone. This harness synthesizes minimal JPEG+EXIF blobs with
// each orientation code in both byte orders, plus edge cases
// (missing EXIF, malformed headers, orientation as non-first tag),
// and verifies `readExifOrientation` handles each.
//
// Also covers `applyOrientationToSize` (which codes swap dims),
// `isValidOrientationCode`, and `describeOrientation`.
//
// Usage:
//   bun run scripts/orientation-corpus.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyOrientationToSize,
  describeOrientation,
  isValidOrientationCode,
  readExifOrientation,
  type OrientationCode,
} from '../packages/preimage/src/orientation.ts'

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

// --- Synthetic JPEG+EXIF construction ---

type ByteOrder = 'little' | 'big'

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

function u16(n: number, order: ByteOrder): Uint8Array {
  const out = new Uint8Array(2)
  const view = new DataView(out.buffer)
  view.setUint16(0, n, order === 'little')
  return out
}

function u32(n: number, order: ByteOrder): Uint8Array {
  const out = new Uint8Array(4)
  const view = new DataView(out.buffer)
  view.setUint32(0, n, order === 'little')
  return out
}

/** Build a minimal JPEG-with-EXIF blob carrying the given
 *  orientation tag. Optionally add an earlier tag (to verify that
 *  the parser skips past non-orientation entries). */
function buildExifJpeg(
  orientation: number,
  order: ByteOrder,
  options: { prependTag?: number } = {},
): Uint8Array {
  // APP1 payload: "Exif\0\0" + TIFF header + IFD with orientation entry.
  const exifMagic = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  const byteOrderMark = order === 'little'
    ? new Uint8Array([0x49, 0x49]) // "II"
    : new Uint8Array([0x4d, 0x4d]) // "MM"
  const tiffMagic = u16(0x002a, order)
  const ifdOffset = u32(8, order) // IFD0 starts 8 bytes after TIFF header

  // Optional extra tag (type SHORT, count 1) placed before orientation.
  const extraEntry = options.prependTag !== undefined
    ? concat(
        u16(options.prependTag, order),
        u16(3, order), // SHORT
        u32(1, order), // count
        new Uint8Array(4), // value (4 bytes pad)
      )
    : new Uint8Array(0)

  // Orientation entry: tag 0x0112, type SHORT (3), count 1, value=orientation.
  // Value fits inline; must be padded to 4 bytes total value field.
  const orientationValueBytes = new Uint8Array(4)
  orientationValueBytes.set(u16(orientation, order))
  const orientationEntry = concat(
    u16(0x0112, order),
    u16(3, order),
    u32(1, order),
    orientationValueBytes,
  )

  const entryCount = options.prependTag !== undefined ? 2 : 1
  const ifd = concat(
    u16(entryCount, order),
    extraEntry,
    orientationEntry,
    u32(0, order), // next IFD offset = none
  )

  const tiff = concat(byteOrderMark, tiffMagic, ifdOffset, ifd)
  const app1Payload = concat(exifMagic, tiff)
  const app1SegmentLen = app1Payload.byteLength + 2 // +2 for the length field itself
  const app1 = concat(
    new Uint8Array([0xff, 0xe1]),
    u16(app1SegmentLen, 'big'), // JPEG segment lengths are always big-endian
    app1Payload,
  )
  const soi = new Uint8Array([0xff, 0xd8])
  const eoi = new Uint8Array([0xff, 0xd9])
  return concat(soi, app1, eoi)
}

// --- applyOrientationToSize ---

function checkApplyOrientationToSize(): void {
  // Codes 1-4 preserve dims; 5-8 swap.
  const preserved: OrientationCode[] = [1, 2, 3, 4]
  const swapped: OrientationCode[] = [5, 6, 7, 8]

  for (const code of preserved) {
    const { width, height } = applyOrientationToSize(1920, 1080, code)
    if (width !== 1920 || height !== 1080) {
      fail(`apply/code-${code}-preserves`, `got ${width}x${height}`)
    } else {
      pass(`apply/code-${code}-preserves`)
    }
  }
  for (const code of swapped) {
    const { width, height } = applyOrientationToSize(1920, 1080, code)
    if (width !== 1080 || height !== 1920) {
      fail(`apply/code-${code}-swaps`, `got ${width}x${height} (expected swap)`)
    } else {
      pass(`apply/code-${code}-swaps`)
    }
  }
}

// --- isValidOrientationCode ---

function checkIsValidOrientationCode(): void {
  for (let code = 1; code <= 8; code++) {
    if (!isValidOrientationCode(code)) fail(`valid/${code}-true`, 'returned false for valid code')
    else pass(`valid/${code}-true`)
  }
  for (const invalid of [0, 9, 10, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    if (isValidOrientationCode(invalid)) fail(`valid/${invalid}-false`, 'returned true for invalid code')
    else pass(`valid/${invalid}-false`)
  }
}

// --- describeOrientation ---

function checkDescribeOrientation(): void {
  for (let code = 1; code <= 8; code++) {
    try {
      const info = describeOrientation(code as OrientationCode)
      if (typeof info !== 'object' || info === null) {
        fail(`describe/${code}`, `non-object: ${JSON.stringify(info)}`)
      } else {
        pass(`describe/${code}`)
      }
    } catch (err) {
      fail(`describe/${code}`, `threw: ${(err as Error).message}`)
    }
  }
}

// --- readExifOrientation ---

function checkReadExifOrientation(): void {
  // All 8 orientation codes, in both byte orders.
  for (const order of ['little', 'big'] as const) {
    for (let code = 1; code <= 8; code++) {
      const bytes = buildExifJpeg(code, order)
      const result = readExifOrientation(bytes.buffer)
      if (result !== code) {
        fail(`read/${order}/code-${code}`, `expected ${code}, got ${result}`)
      } else {
        pass(`read/${order}/code-${code}`)
      }
    }
  }

  // Orientation as the second IFD entry (parser must iterate).
  const bytes = buildExifJpeg(6, 'little', { prependTag: 0x010f /* Make tag */ })
  const result = readExifOrientation(bytes.buffer)
  if (result !== 6) {
    fail('read/second-ifd-entry', `expected 6, got ${result}`)
  } else {
    pass('read/second-ifd-entry')
  }

  // No EXIF: plain JPEG (SOI + EOI only).
  const noExif = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
  if (readExifOrientation(noExif.buffer) !== null) {
    fail('read/no-exif', 'expected null')
  } else {
    pass('read/no-exif')
  }

  // JPEG with a non-EXIF APP1 (e.g. XMP). APP1 header must start
  // with "Exif\0\0"; anything else should be skipped.
  const xmpApp1 = concat(
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe1]),
    u16(10, 'big'), // segment length
    new Uint8Array([0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f]), // "http://"
    new Uint8Array([0, 0]),
    new Uint8Array([0xff, 0xd9]),
  )
  if (readExifOrientation(xmpApp1.buffer) !== null) {
    fail('read/xmp-app1-not-exif', 'expected null')
  } else {
    pass('read/xmp-app1-not-exif')
  }

  // Not a JPEG at all.
  const notJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic
  if (readExifOrientation(notJpeg.buffer) !== null) {
    fail('read/not-jpeg', 'expected null')
  } else {
    pass('read/not-jpeg')
  }

  // Empty buffer.
  if (readExifOrientation(new Uint8Array(0).buffer) !== null) {
    fail('read/empty', 'expected null')
  } else {
    pass('read/empty')
  }

  // Truncated just after SOI.
  if (readExifOrientation(new Uint8Array([0xff, 0xd8]).buffer) !== null) {
    fail('read/truncated-after-soi', 'expected null')
  } else {
    pass('read/truncated-after-soi')
  }

  // Invalid byte order in EXIF TIFF header: should return null.
  const badOrderBytes = concat(
    new Uint8Array([0xff, 0xd8]),
    new Uint8Array([0xff, 0xe1]),
    u16(20, 'big'),
    new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), // Exif\0\0
    new Uint8Array([0xaa, 0xaa]), // Bad byte order
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
    new Uint8Array([0xff, 0xd9]),
  )
  if (readExifOrientation(badOrderBytes.buffer) !== null) {
    fail('read/bad-byte-order', 'expected null')
  } else {
    pass('read/bad-byte-order')
  }

  // Orientation code out of range (e.g. 99).
  const bogusOrientation = buildExifJpeg(99, 'little')
  if (readExifOrientation(bogusOrientation.buffer) !== null) {
    fail('read/bogus-orientation-value', 'expected null for invalid orientation value')
  } else {
    pass('read/bogus-orientation-value')
  }
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  checkApplyOrientationToSize()
  checkIsValidOrientationCode()
  checkDescribeOrientation()
  checkReadExifOrientation()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== orientation-corpus: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `orientation-corpus-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'orientation-corpus', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
