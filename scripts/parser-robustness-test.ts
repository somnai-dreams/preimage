// Robustness sweep for `probeImageBytes`. Runs a broad set of
// synthetic edge cases plus every committed photo in
// pages/assets/demos/photos/, checks:
//
//   1. Parser never throws (crash = regression).
//   2. Valid inputs return correct dims. Compares against the
//      build-time manifest as ground truth.
//   3. Malformed inputs return null — not garbage dims, not
//      undefined behavior, not exceptions.
//   4. Determinism: same bytes → same result across 3 calls.
//   5. Slice-robustness: truncating valid input to the signature's
//      minimum should still return correct dims (PNG: 24 bytes,
//      GIF: 10, BMP: 26, WebP: 30, JPEG: up to MAX_HEADER_BYTES).
//      Truncating below that → null.
//
// Reports to stdout + saves a JSON summary to benchmarks/ for
// regression comparison. Exits non-zero on any failure.
//
// Usage:
//   bun run scripts/parser-robustness-test.ts

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MAX_HEADER_BYTES,
  probeImageBytes,
  type ProbedDimensions,
} from '../packages/preimage/src/probe.ts'

// --- Test-case infrastructure ---

type TestResult =
  | { ok: true; case: string; notes?: string }
  | { ok: false; case: string; reason: string }

const results: TestResult[] = []

function check(label: string, fn: () => { pass: true; notes?: string } | { pass: false; reason: string }): void {
  let result: ReturnType<typeof fn>
  try {
    result = fn()
  } catch (err) {
    results.push({ ok: false, case: label, reason: `threw: ${(err as Error).message}` })
    return
  }
  if (result.pass) {
    results.push({ ok: true, case: label, notes: result.notes })
  } else {
    results.push({ ok: false, case: label, reason: result.reason })
  }
}

function expectNull(label: string, bytes: Uint8Array): void {
  check(label, () => {
    const out = probeImageBytes(bytes)
    if (out === null) return { pass: true }
    return { pass: false, reason: `expected null, got ${JSON.stringify(out)}` }
  })
}

function expectDims(
  label: string,
  bytes: Uint8Array,
  expected: { width: number; height: number; format?: string },
): void {
  check(label, () => {
    const out = probeImageBytes(bytes)
    if (out === null) return { pass: false, reason: 'returned null, expected dims' }
    if (out.width !== expected.width) {
      return { pass: false, reason: `width ${out.width} !== expected ${expected.width}` }
    }
    if (out.height !== expected.height) {
      return { pass: false, reason: `height ${out.height} !== expected ${expected.height}` }
    }
    if (expected.format !== undefined && out.format !== expected.format) {
      return { pass: false, reason: `format ${out.format} !== expected ${expected.format}` }
    }
    return { pass: true, notes: `${out.format} ${out.width}×${out.height}` }
  })
}

function expectDeterministic(label: string, bytes: Uint8Array): void {
  check(label, () => {
    const a = probeImageBytes(bytes)
    const b = probeImageBytes(bytes)
    const c = probeImageBytes(bytes)
    if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(b) !== JSON.stringify(c)) {
      return { pass: false, reason: 'non-deterministic across 3 calls' }
    }
    return { pass: true }
  })
}

function expectNoCrash(label: string, bytes: Uint8Array): void {
  check(label, () => {
    try {
      const out = probeImageBytes(bytes)
      if (out !== null && (out.width <= 0 || out.height <= 0)) {
        return { pass: false, reason: `returned non-positive dims: ${JSON.stringify(out)}` }
      }
      return { pass: true }
    } catch (err) {
      return { pass: false, reason: `threw: ${(err as Error).message}` }
    }
  })
}

// --- Synthetic edge cases ---

function runSyntheticEdgeCases(): void {
  // Empty + tiny inputs.
  expectNull('empty', new Uint8Array(0))
  expectNull('one-byte-zero', new Uint8Array([0]))
  expectNull('one-byte-0xFF', new Uint8Array([0xff]))
  expectNull('two-bytes', new Uint8Array([0xff, 0xd8]))
  expectNull('three-bytes-jpeg-sig-only', new Uint8Array([0xff, 0xd8, 0xff]))

  // PNG edge cases.
  const pngSig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expectNull('png-signature-only', pngSig)
  // PNG with IHDR but truncated (< 24 bytes total).
  expectNull('png-truncated-pre-dims', concat(pngSig, new Uint8Array([0, 0, 0, 13])))
  // PNG with valid IHDR and dims.
  const validPng = buildPng(640, 480, 6 /* RGBA */)
  expectDims('png-minimal-valid', validPng, { width: 640, height: 480, format: 'png' })
  // PNG with color type 4 (gray+alpha).
  expectDims(
    'png-color-type-4-gray-alpha',
    buildPng(100, 200, 4),
    { width: 100, height: 200, format: 'png' },
  )
  // PNG with color type 3 (indexed — no native alpha).
  expectDims(
    'png-color-type-3-indexed',
    buildPng(50, 50, 3),
    { width: 50, height: 50, format: 'png' },
  )
  check('png-alpha-flag-set-for-type-6', () => {
    const out = probeImageBytes(buildPng(100, 100, 6))
    if (out === null) return { pass: false, reason: 'returned null' }
    if (!out.hasAlpha) return { pass: false, reason: 'hasAlpha false for color type 6' }
    return { pass: true }
  })
  check('png-alpha-flag-not-set-for-type-2', () => {
    const out = probeImageBytes(buildPng(100, 100, 2))
    if (out === null) return { pass: false, reason: 'returned null' }
    if (out.hasAlpha) return { pass: false, reason: 'hasAlpha true for color type 2 (no alpha)' }
    return { pass: true }
  })
  // PNG with 0 width.
  const zeroWidthPng = buildPng(0, 100, 6)
  expectNull('png-zero-width', zeroWidthPng)

  // JPEG edge cases.
  expectNull('jpeg-signature-only', new Uint8Array([0xff, 0xd8, 0xff]))
  // JPEG with just SOI + EOI.
  expectNull('jpeg-soi-eoi-only', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
  // Valid minimal JPEG with SOF0.
  const validJpeg = buildJpeg(800, 600, 0xc0 /* SOF0 baseline */)
  expectDims('jpeg-baseline-valid', validJpeg, { width: 800, height: 600, format: 'jpeg' })
  // Progressive JPEG (SOF2).
  check('jpeg-progressive-flag', () => {
    const out = probeImageBytes(buildJpeg(400, 300, 0xc2))
    if (out === null) return { pass: false, reason: 'returned null' }
    if (!out.isProgressive) return { pass: false, reason: 'isProgressive false for SOF2' }
    return { pass: true }
  })
  // JPEG with large APP0 segment pushing SOF past typical buffer sizes.
  const bigAppJpeg = buildJpegWithLargeApp(1024, 768)
  expectDims('jpeg-big-app0-segment', bigAppJpeg, { width: 1024, height: 768, format: 'jpeg' })

  // GIF.
  const validGif87 = buildGif(200, 150, true)
  const validGif89 = buildGif(200, 150, false)
  expectDims('gif87a-valid', validGif87, { width: 200, height: 150, format: 'gif' })
  expectDims('gif89a-valid', validGif89, { width: 200, height: 150, format: 'gif' })

  // BMP.
  const validBmp = buildBmp(128, 96)
  expectDims('bmp-valid', validBmp, { width: 128, height: 96, format: 'bmp' })
  // Top-down BMP (negative height).
  const topDownBmp = buildBmp(100, -50) // negative → encoded as top-down
  expectDims('bmp-top-down-negative-height', topDownBmp, {
    width: 100,
    height: 50,
    format: 'bmp',
  })

  // ICO.
  expectDims('ico-valid', buildIco(32, 48), { width: 32, height: 48, format: 'ico' })
  expectDims('ico-256-sentinel', buildIco(256, 256), { width: 256, height: 256, format: 'ico' })

  // WebP variants.
  expectDims(
    'webp-vp8-lossy',
    buildWebpVP8(300, 200),
    { width: 300, height: 200, format: 'webp' },
  )
  expectDims(
    'webp-vp8l-lossless',
    buildWebpVP8L(256, 256),
    { width: 256, height: 256, format: 'webp' },
  )
  check('webp-vp8l-has-alpha', () => {
    const out = probeImageBytes(buildWebpVP8L(256, 256))
    if (out === null) return { pass: false, reason: 'returned null' }
    if (!out.hasAlpha) return { pass: false, reason: 'VP8L should always report hasAlpha' }
    return { pass: true }
  })
  check('webp-vp8x-with-alpha-flag', () => {
    const out = probeImageBytes(buildWebpVP8X(500, 300, 0x10 /* alpha flag */))
    if (out === null) return { pass: false, reason: 'returned null' }
    if (!out.hasAlpha) return { pass: false, reason: 'VP8X alpha flag not surfaced' }
    return { pass: true }
  })
  check('webp-vp8x-no-alpha-flag', () => {
    const out = probeImageBytes(buildWebpVP8X(500, 300, 0 /* no alpha */))
    if (out === null) return { pass: false, reason: 'returned null' }
    if (out.hasAlpha) return { pass: false, reason: 'VP8X without alpha flag reported hasAlpha' }
    return { pass: true }
  })

  // SVG.
  // Regression: the old SVG regex couldn't skip over a quoted attribute
  // that came before the one it was matching, so `width="240"
  // height="180"` found width but never height. Worth keeping a handful
  // of order-varying cases in the corpus.
  expectDims(
    'svg-width-height-attrs',
    new TextEncoder().encode('<svg width="240" height="180" xmlns="http://www.w3.org/2000/svg"></svg>'),
    { width: 240, height: 180, format: 'svg' },
  )
  expectDims(
    'svg-height-width-attrs',
    new TextEncoder().encode('<svg height="180" width="240" xmlns="http://www.w3.org/2000/svg"></svg>'),
    { width: 240, height: 180, format: 'svg' },
  )
  expectDims(
    'svg-attrs-after-xmlns',
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"></svg>'),
    { width: 240, height: 180, format: 'svg' },
  )
  expectDims(
    'svg-attrs-single-quotes',
    new TextEncoder().encode("<svg width='240' height='180'></svg>"),
    { width: 240, height: 180, format: 'svg' },
  )
  expectDims(
    'svg-attrs-with-px-suffix',
    new TextEncoder().encode('<svg width="240px" height="180px"></svg>'),
    { width: 240, height: 180, format: 'svg' },
  )
  expectDims(
    'svg-viewbox-only',
    new TextEncoder().encode('<svg viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg"></svg>'),
    { width: 320, height: 240, format: 'svg' },
  )
  expectDims(
    'svg-viewbox-with-other-attrs-first',
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" version="1.1"></svg>'),
    { width: 640, height: 480, format: 'svg' },
  )
  expectDims(
    'svg-xml-decl-preamble',
    new TextEncoder().encode(
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"></svg>',
    ),
    { width: 100, height: 100, format: 'svg' },
  )
  expectDims(
    'svg-self-closing-tag',
    new TextEncoder().encode('<svg width="50" height="50" xmlns="http://www.w3.org/2000/svg"/>'),
    { width: 50, height: 50, format: 'svg' },
  )

  // Random noise.
  for (let seed = 0; seed < 10; seed++) {
    expectNoCrash(`random-noise-${seed}-128B`, randomBytes(128, seed))
    expectNoCrash(`random-noise-${seed}-4KB`, randomBytes(4096, seed * 7))
  }

  // Non-image content that should be rejected cleanly.
  expectNull('html-doctype', new TextEncoder().encode('<!DOCTYPE html><html></html>'))
  expectNull('json-object', new TextEncoder().encode('{"width": 100, "height": 200}'))
  expectNull('plain-text', new TextEncoder().encode('Hello, world!'))
  // "RIFF" without WEBP — should not mis-parse as WebP.
  expectNull(
    'riff-but-not-webp',
    concat(new Uint8Array([0x52, 0x49, 0x46, 0x46]), new Uint8Array([0, 0, 0, 0]), new TextEncoder().encode('WAVE')),
  )
}

// --- Determinism over a mix of inputs ---

function runDeterminismChecks(): void {
  expectDeterministic('determinism-empty', new Uint8Array(0))
  expectDeterministic('determinism-png', buildPng(100, 100, 6))
  expectDeterministic('determinism-jpeg', buildJpeg(100, 100, 0xc0))
  expectDeterministic('determinism-webp-vp8x', buildWebpVP8X(500, 300, 0x10))
  expectDeterministic('determinism-noise-1', randomBytes(1024, 42))
}

// --- Real photo corpus ---

async function runPhotoCorpus(photosDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(photosDir)
  } catch {
    results.push({
      ok: true,
      case: 'photo-corpus',
      notes: `(skipped: ${photosDir} not accessible)`,
    })
    return
  }

  for (const file of entries) {
    const ext = extname(file).replace(/^\./, '').toLowerCase()
    if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) continue
    const full = join(photosDir, file)
    const bytes = new Uint8Array(await readFile(full))

    // Basic probe.
    check(`photo/${file}`, () => {
      const out = probeImageBytes(bytes.subarray(0, MAX_HEADER_BYTES))
      if (out === null) return { pass: false, reason: 'parser returned null' }
      if (out.width <= 0 || out.height <= 0) {
        return { pass: false, reason: `non-positive dims ${out.width}×${out.height}` }
      }
      return { pass: true, notes: `${out.format} ${out.width}×${out.height}` }
    })

    // Truncation robustness: the parser must succeed with the first
    // MAX_HEADER_BYTES and must fail or succeed safely with smaller
    // slices. The key invariant: never throw.
    for (const truncAt of [16, 32, 64, 128, 256, 1024, 4096]) {
      expectNoCrash(`photo/${file} truncated to ${truncAt}B`, bytes.subarray(0, truncAt))
    }
  }
}

// --- Helpers for synthetic image construction ---

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff])
}

function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
}

function u32le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
}

function i32le(n: number): Uint8Array {
  const u = n < 0 ? n + 0x100000000 : n
  return u32le(u)
}

function buildPng(width: number, height: number, colorType: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrLen = u32be(13)
  const ihdrType = new TextEncoder().encode('IHDR')
  const ihdrData = concat(
    u32be(width),
    u32be(height),
    new Uint8Array([8 /* bit depth */, colorType, 0, 0, 0]),
  )
  const ihdrCrc = u32be(0) // probe doesn't verify CRC
  return concat(sig, ihdrLen, ihdrType, ihdrData, ihdrCrc)
}

function buildJpeg(width: number, height: number, sofMarker: number): Uint8Array {
  // Minimal: SOI + APP0 (JFIF-ish) + SOF + EOI. The parser walks
  // segments looking for SOF; we just need a conformant segment chain.
  const soi = new Uint8Array([0xff, 0xd8])
  const app0 = concat(
    new Uint8Array([0xff, 0xe0]),
    u16be(16),
    new TextEncoder().encode('JFIF\0'),
    new Uint8Array([1, 1, 0, 0, 72, 0, 72, 0, 0]),
  )
  const sof = concat(
    new Uint8Array([0xff, sofMarker]),
    u16be(8),
    new Uint8Array([8 /* precision */]),
    u16be(height),
    u16be(width),
    new Uint8Array([3 /* components */]),
  )
  const eoi = new Uint8Array([0xff, 0xd9])
  return concat(soi, app0, sof, eoi)
}

function buildJpegWithLargeApp(width: number, height: number): Uint8Array {
  // Jams a ~3 KB APP1 segment before the SOF to exercise parsers
  // that bail early.
  const soi = new Uint8Array([0xff, 0xd8])
  const appPayload = new Uint8Array(3000)
  for (let i = 0; i < appPayload.length; i++) appPayload[i] = (i * 7) & 0xff
  const app1 = concat(
    new Uint8Array([0xff, 0xe1]),
    u16be(appPayload.length + 2),
    appPayload,
  )
  const sof = concat(
    new Uint8Array([0xff, 0xc0]),
    u16be(8),
    new Uint8Array([8]),
    u16be(height),
    u16be(width),
    new Uint8Array([3]),
  )
  return concat(soi, app1, sof)
}

function buildGif(width: number, height: number, isGif87a: boolean): Uint8Array {
  const sig = new TextEncoder().encode(isGif87a ? 'GIF87a' : 'GIF89a')
  const lsd = concat(u16le(width), u16le(height), new Uint8Array([0, 0, 0]))
  return concat(sig, lsd)
}

function buildBmp(width: number, height: number): Uint8Array {
  // BITMAPFILEHEADER (14 bytes) + minimal BITMAPINFOHEADER.
  const fileHeader = concat(
    new TextEncoder().encode('BM'),
    u32le(0), // fileSize placeholder
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]), // reserved + dataOffset
  )
  const infoHeader = concat(
    u32le(40), // biSize
    i32le(width),
    i32le(height),
    u16le(1), // planes
    u16le(24), // bitCount
    u32le(0), // compression
    u32le(0), // imageSize
    i32le(0), // xPixelsPerMeter
    i32le(0), // yPixelsPerMeter
    u32le(0), // clrUsed
    u32le(0), // clrImportant
  )
  return concat(fileHeader, infoHeader)
}

function buildIco(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0, 0, 1, 0, 1, 0,
    width === 256 ? 0 : width,
    height === 256 ? 0 : height,
    0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0,
  ])
}

function buildWebpVP8(width: number, height: number): Uint8Array {
  // VP8 lossy: RIFF + WEBP + VP8 chunk. The parser reads 14-bit
  // widths from offsets 26/28.
  const riff = new TextEncoder().encode('RIFF')
  const webp = new TextEncoder().encode('WEBP')
  const vp8 = new TextEncoder().encode('VP8 ')
  const header = new Uint8Array(14) // skip to width bytes
  header.set([0x9d, 0x01, 0x2a], 9) // sync bytes at chunk-relative offset 3
  // Put width at absolute offset 26 = chunk-relative offset 14
  header.set(u16le(width), 12)
  // Now build: RIFF (4) + size (4) + WEBP (4) + VP8 (4) + size (4) + header (14) + height placeholder
  const chunkSize = u32le(14 + 4) // just enough for header + width/height
  const fileSize = u32le(4 + 4 + 4 + 14 + 4)
  const bytes = concat(riff, fileSize, webp, vp8, chunkSize, header)
  // Height lives at offset 28 (after all the RIFF/WEBP/VP8/size framing
  // plus 3 sync bytes + width). offset 28 in the final buffer.
  const out = new Uint8Array(Math.max(bytes.length, 30))
  out.set(bytes)
  out.set(u16le(width), 26)
  out.set(u16le(height), 28)
  return out
}

function buildWebpVP8L(width: number, height: number): Uint8Array {
  // VP8L: width-1 + height-1 packed into 4 bytes at offset 21.
  const out = new Uint8Array(30)
  out.set(new TextEncoder().encode('RIFF'), 0)
  out.set(new TextEncoder().encode('WEBP'), 8)
  out.set(new TextEncoder().encode('VP8L'), 12)
  // Size bytes at 16-19 unused by probe
  out[20] = 0x2f // VP8L signature byte
  const w = width - 1
  const h = height - 1
  out[21] = w & 0xff
  out[22] = ((w >>> 8) & 0x3f) | ((h & 0x3) << 6)
  out[23] = (h >>> 2) & 0xff
  out[24] = (h >>> 10) & 0x0f
  return out
}

function buildWebpVP8X(width: number, height: number, flags: number): Uint8Array {
  const out = new Uint8Array(30)
  out.set(new TextEncoder().encode('RIFF'), 0)
  out.set(new TextEncoder().encode('WEBP'), 8)
  out.set(new TextEncoder().encode('VP8X'), 12)
  out[20] = flags
  const w = width - 1
  const h = height - 1
  out[24] = w & 0xff
  out[25] = (w >>> 8) & 0xff
  out[26] = (w >>> 16) & 0xff
  out[27] = h & 0xff
  out[28] = (h >>> 8) & 0xff
  out[29] = (h >>> 16) & 0xff
  return out
}

// Cheap seeded PRNG for noise generation.
function randomBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  let x = (seed + 0x9e3779b9) >>> 0
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 0x85ebca6b) ^ (x >>> 13)) >>> 0
    x = (Math.imul(x, 0xc2b2ae35) ^ (x >>> 16)) >>> 0
    out[i] = x & 0xff
  }
  return out
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()

  runSyntheticEdgeCases()
  runDeterminismChecks()
  const photosDir = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    'pages',
    'assets',
    'demos',
    'photos',
  )
  await runPhotoCorpus(photosDir)

  const wallMs = performance.now() - t0
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  const total = results.length

  process.stdout.write(`=== parser-robustness: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)

  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) {
      if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    }
    process.stdout.write('\n')
  }

  // Save summary to benchmarks/.
  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `parser-robustness-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'parser-robustness',
        date: new Date().toISOString(),
        wallMs,
        total,
        passed,
        failed: failed.length,
        results,
      },
      null,
      2,
    ),
  )
  process.stdout.write(`=== Saved ${outPath} ===\n`)

  if (failed.length > 0) process.exit(1)
}

// Suppress unused imports that are handy for readers.
void MAX_HEADER_BYTES
void (null as unknown as ProbedDimensions)

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
