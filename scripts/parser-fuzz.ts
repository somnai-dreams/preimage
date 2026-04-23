// Property-based fuzz for every parser. Generates random byte
// sequences (seeded PRNG for reproducibility) and feeds them
// through probeImageBytes, probeImageStream (one-shot), the EXIF
// parser, and the URL patterns. None should crash, and non-null
// outputs must satisfy the basic invariants (positive finite dims,
// recognized format).
//
// Complements the hand-written corpus in parser-robustness-test.ts
// — corpus targets specific edge cases; fuzz catches the ones we
// haven't imagined.
//
// Usage: bun run scripts/parser-fuzz.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeImageBytes, probeImageStream } from '../packages/preimage/src/probe.ts'
import { readExifOrientation, isValidOrientationCode } from '../packages/preimage/src/orientation.ts'
import {
  cloudinaryParser,
  shopifyParser,
  picsumParser,
  unsplashParser,
  queryParamDimensionParser,
  parseUrlDimensions,
  registerCommonUrlDimensionParsers,
} from '../packages/preimage/src/url-dimensions.ts'

// --- Seeded PRNG (Wellons lowbias32) ---

function mkRandom(seed: number) {
  let x = (seed + 0x9e3779b9) >>> 0
  return {
    nextByte(): number {
      x = (Math.imul(x, 0x85ebca6b) ^ (x >>> 13)) >>> 0
      x = (Math.imul(x, 0xc2b2ae35) ^ (x >>> 16)) >>> 0
      return x & 0xff
    },
    nextInt(max: number): number {
      x = (Math.imul(x, 0x85ebca6b) ^ (x >>> 13)) >>> 0
      x = (Math.imul(x, 0xc2b2ae35) ^ (x >>> 16)) >>> 0
      return ((x >>> 0) % max)
    },
  }
}

function randomBytes(size: number, seed: number): Uint8Array {
  const rng = mkRandom(seed)
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = rng.nextByte()
  return out
}

/** Seed the buffer with one of the known format signatures at the
 *  start, then fill the rest with random noise. Exercises the
 *  parsers' "looks like format X but malformed" code paths. */
function randomWithSignature(size: number, seed: number, sig: number): Uint8Array {
  const out = randomBytes(size, seed)
  const sigs = [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
    [0xff, 0xd8, 0xff],                                 // JPEG
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],              // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],              // GIF89a
    [0x42, 0x4d],                                        // BMP
    // WEBP: RIFF + size + WEBP
    [0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
  ]
  const s = sigs[sig % sigs.length]!
  for (let i = 0; i < s.length && i < out.length; i++) out[i] = s[i]!
  return out
}

// --- Counters ---

type FuzzStats = {
  target: string
  iterations: number
  crashes: number
  nonNull: number
  invariantViolations: number
  invariantDetails: string[]
}

function newStats(target: string): FuzzStats {
  return {
    target,
    iterations: 0,
    crashes: 0,
    nonNull: 0,
    invariantViolations: 0,
    invariantDetails: [],
  }
}

function recordViolation(stats: FuzzStats, detail: string): void {
  stats.invariantViolations++
  if (stats.invariantDetails.length < 20) stats.invariantDetails.push(detail)
}

// --- Fuzz targets ---

async function fuzzProbeImageBytes(iterations: number): Promise<FuzzStats> {
  const stats = newStats('probeImageBytes')
  for (let i = 0; i < iterations; i++) {
    stats.iterations++
    // Alternate between pure noise and signature-seeded noise + varying sizes.
    let bytes: Uint8Array
    if (i % 3 === 0) {
      bytes = randomBytes((i % 256) + 1, i)
    } else if (i % 3 === 1) {
      bytes = randomWithSignature(512 + (i % 4096), i * 7, i % 6)
    } else {
      bytes = randomBytes((i * 13) % 8192, i * 31)
    }
    try {
      const out = probeImageBytes(bytes)
      if (out === null) continue
      stats.nonNull++
      if (!Number.isFinite(out.width) || out.width <= 0 || !Number.isInteger(out.width)) {
        recordViolation(stats, `iter ${i}: width ${out.width}`)
      }
      if (!Number.isFinite(out.height) || out.height <= 0 || !Number.isInteger(out.height)) {
        recordViolation(stats, `iter ${i}: height ${out.height}`)
      }
      const okFormats = ['png', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
      if (!okFormats.includes(out.format)) {
        recordViolation(stats, `iter ${i}: bad format ${out.format}`)
      }
      if (typeof out.hasAlpha !== 'boolean') {
        recordViolation(stats, `iter ${i}: hasAlpha not bool`)
      }
      if (typeof out.isProgressive !== 'boolean') {
        recordViolation(stats, `iter ${i}: isProgressive not bool`)
      }
    } catch (err) {
      stats.crashes++
      if (stats.invariantDetails.length < 20) {
        stats.invariantDetails.push(`iter ${i}: threw ${(err as Error).message}`)
      }
    }
  }
  return stats
}

async function fuzzProbeImageStream(iterations: number): Promise<FuzzStats> {
  const stats = newStats('probeImageStream')
  // Fewer iterations because of async overhead; signatures are
  // already covered by probeImageBytes — here we just check the
  // stream wrapper doesn't throw on random inputs.
  for (let i = 0; i < iterations; i++) {
    stats.iterations++
    const bytes = i % 2 === 0 ? randomBytes((i * 17) % 4096, i) : randomWithSignature(1024, i, i % 6)
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(bytes)
        ctrl.close()
      },
    })
    try {
      const result = await probeImageStream(stream)
      if (!(result.blob instanceof Blob)) {
        recordViolation(stats, `iter ${i}: blob not a Blob`)
      }
      if (result.blob.size !== bytes.length) {
        recordViolation(stats, `iter ${i}: blob size ${result.blob.size} !== input ${bytes.length}`)
      }
      if (result.dims !== null) {
        stats.nonNull++
        if (!Number.isFinite(result.dims.width) || result.dims.width <= 0) {
          recordViolation(stats, `iter ${i}: bad width ${result.dims.width}`)
        }
      }
    } catch (err) {
      stats.crashes++
      if (stats.invariantDetails.length < 20) {
        stats.invariantDetails.push(`iter ${i}: threw ${(err as Error).message}`)
      }
    }
  }
  return stats
}

async function fuzzExif(iterations: number): Promise<FuzzStats> {
  const stats = newStats('readExifOrientation')
  for (let i = 0; i < iterations; i++) {
    stats.iterations++
    const bytes = i % 2 === 0 ? randomBytes((i % 512) + 4, i) : randomWithSignature(256, i, 1) // JPEG-signature + noise
    try {
      const out = readExifOrientation(bytes.buffer)
      if (out === null) continue
      stats.nonNull++
      if (!isValidOrientationCode(out)) {
        recordViolation(stats, `iter ${i}: invalid orientation ${out}`)
      }
    } catch (err) {
      stats.crashes++
      if (stats.invariantDetails.length < 20) {
        stats.invariantDetails.push(`iter ${i}: threw ${(err as Error).message}`)
      }
    }
  }
  return stats
}

async function fuzzUrlParsers(iterations: number): Promise<FuzzStats> {
  const stats = newStats('url-parsers')
  // Register the common parsers so parseUrlDimensions has candidates.
  const unregister = registerCommonUrlDimensionParsers()
  const parsers = [
    cloudinaryParser,
    shopifyParser,
    picsumParser,
    unsplashParser,
    queryParamDimensionParser((u) => u.includes('.'), 'w', 'h'),
  ]
  try {
    for (let i = 0; i < iterations; i++) {
      stats.iterations++
      // Mix of shaped and purely random URLs.
      let url: string
      const rng = mkRandom(i)
      if (i % 4 === 0) {
        // Purely random string up to 512 bytes.
        const len = rng.nextInt(512) + 1
        const bytes = new Uint8Array(len)
        for (let j = 0; j < len; j++) bytes[j] = rng.nextByte()
        url = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      } else if (i % 4 === 1) {
        url = `https://res.cloudinary.com/demo/image/upload/w_${rng.nextInt(99999)},h_${rng.nextInt(99999)}/file_${i}.jpg`
      } else if (i % 4 === 2) {
        url = `https://cdn.shopify.com/s/files/1/1/1/products/item_${rng.nextInt(99999)}x${rng.nextInt(99999)}.jpg`
      } else {
        url = `https://picsum.photos/${rng.nextInt(9999)}/${rng.nextInt(9999)}?seed=${i}`
      }
      try {
        const dims = parseUrlDimensions(url)
        if (dims !== null) {
          stats.nonNull++
          if (!Number.isFinite(dims.width) || dims.width <= 0) {
            recordViolation(stats, `iter ${i}: bad width ${dims.width} for url ${url.slice(0, 120)}`)
          }
        }
        for (const parser of parsers) {
          const result = parser(url)
          if (result !== null) {
            if (!Number.isFinite(result.width) || result.width <= 0) {
              recordViolation(stats, `iter ${i}: vendor parser returned bad width ${result.width}`)
            }
          }
        }
      } catch (err) {
        stats.crashes++
        if (stats.invariantDetails.length < 20) {
          stats.invariantDetails.push(`iter ${i}: threw ${(err as Error).message}`)
        }
      }
    }
  } finally {
    unregister()
  }
  return stats
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  const ITERATIONS = 10_000
  const STREAM_ITERS = 500 // stream wrapper has async overhead

  process.stderr.write(`parser-fuzz: running ${ITERATIONS} iterations per target\n`)
  const probeStats = await fuzzProbeImageBytes(ITERATIONS)
  const streamStats = await fuzzProbeImageStream(STREAM_ITERS)
  const exifStats = await fuzzExif(ITERATIONS)
  const urlStats = await fuzzUrlParsers(ITERATIONS)
  const wallMs = performance.now() - t0

  const all = [probeStats, streamStats, exifStats, urlStats]
  const ok = all.filter((s) => s.crashes === 0 && s.invariantViolations === 0).length
  process.stdout.write(
    `=== parser-fuzz: ${ok}/${all.length} passed in ${wallMs.toFixed(0)}ms ===\n\n`,
  )
  for (const stats of all) {
    const mark = stats.crashes === 0 && stats.invariantViolations === 0 ? '✓' : '✗'
    process.stdout.write(
      `  ${mark} ${stats.target.padEnd(20)} iterations=${String(stats.iterations).padStart(5)}  nonNull=${stats.nonNull}  crashes=${stats.crashes}  violations=${stats.invariantViolations}\n`,
    )
    if (stats.invariantDetails.length > 0) {
      for (const d of stats.invariantDetails.slice(0, 5)) {
        process.stdout.write(`      ${d}\n`)
      }
      if (stats.invariantDetails.length > 5) {
        process.stdout.write(`      ... and ${stats.invariantDetails.length - 5} more\n`)
      }
    }
  }

  const failed = all.some((s) => s.crashes > 0 || s.invariantViolations > 0)

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `parser-fuzz-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'parser-fuzz', date: new Date().toISOString(), wallMs, targets: all },
      null,
      2,
    ),
  )
  process.stdout.write(`\n=== Saved ${outPath} ===\n`)
  if (failed) process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
