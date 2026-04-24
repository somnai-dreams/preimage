// buildManifest robustness + perf sweep.
//
// Sets up temp directory trees, runs buildManifest, verifies:
//   - Empty directory → empty manifest
//   - Single image → one entry with correct dims
//   - Nested directories → keys use forward slashes, preserve hierarchy
//   - Mixed image + non-image files → non-images ignored
//   - Unsupported image extensions → skipped with onSkip callback
//   - Dotfiles / node_modules → skipped (documented behavior)
//   - Custom base prefix → applied to every key
//   - Custom extensions list → only matching files included
//   - Large-header JPEG → full-file retry when SOF sits past prefix
//   - Large directory (~100 files) → timed for regression baseline
//
// Usage:
//   bun run scripts/manifest-build-test.ts

import { writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildManifest } from '../packages/preimage/src/manifest.ts'

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

// --- Helpers: synthesize minimal valid images ---

function buildPng(width: number, height: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(25)
  // Length (4) = 13 big-endian
  ihdr[0] = 0; ihdr[1] = 0; ihdr[2] = 0; ihdr[3] = 13
  // Type "IHDR"
  ihdr[4] = 0x49; ihdr[5] = 0x48; ihdr[6] = 0x44; ihdr[7] = 0x52
  // Width big-endian u32
  ihdr[8] = (width >>> 24) & 0xff
  ihdr[9] = (width >>> 16) & 0xff
  ihdr[10] = (width >>> 8) & 0xff
  ihdr[11] = width & 0xff
  ihdr[12] = (height >>> 24) & 0xff
  ihdr[13] = (height >>> 16) & 0xff
  ihdr[14] = (height >>> 8) & 0xff
  ihdr[15] = height & 0xff
  ihdr[16] = 8 // bit depth
  ihdr[17] = 6 // color type (RGBA)
  const out = new Uint8Array(sig.length + ihdr.length)
  out.set(sig)
  out.set(ihdr, sig.length)
  return out
}

function buildJpeg(width: number, height: number): Uint8Array {
  const soi = new Uint8Array([0xff, 0xd8])
  const sof = new Uint8Array(11)
  sof[0] = 0xff
  sof[1] = 0xc0 // SOF0
  sof[2] = 0; sof[3] = 8 // segLen = 8
  sof[4] = 8 // precision
  sof[5] = (height >>> 8) & 0xff
  sof[6] = height & 0xff
  sof[7] = (width >>> 8) & 0xff
  sof[8] = width & 0xff
  sof[9] = 3
  sof[10] = 1
  const eoi = new Uint8Array([0xff, 0xd9])
  const out = new Uint8Array(soi.length + sof.length + eoi.length)
  out.set(soi)
  out.set(sof, soi.length)
  out.set(eoi, soi.length + sof.length)
  return out
}

function buildLargeHeaderJpeg(width: number, height: number, appBytes: number): Uint8Array {
  const soi = new Uint8Array([0xff, 0xd8])
  const app = new Uint8Array(appBytes + 4)
  const appLength = appBytes + 2
  app[0] = 0xff
  app[1] = 0xe1
  app[2] = (appLength >>> 8) & 0xff
  app[3] = appLength & 0xff
  app.fill(0xaa, 4)
  const sofAndEoi = buildJpeg(width, height).subarray(2)
  const out = new Uint8Array(soi.length + app.length + sofAndEoi.length)
  out.set(soi)
  out.set(app, soi.length)
  out.set(sofAndEoi, soi.length + app.length)
  return out
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ])
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function buildIsobmff(brand: 'avif' | 'heic', width: number, height: number): Uint8Array {
  const ftyp = concatBytes(
    u32be(20),
    ascii('ftyp'),
    ascii(brand),
    u32be(0),
    ascii(brand),
  )
  const ispe = concatBytes(
    u32be(20),
    ascii('ispe'),
    u32be(0),
    u32be(width),
    u32be(height),
  )
  return concatBytes(ftyp, ispe)
}

function buildIco(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0, 0, 1, 0, 1, 0,
    width === 256 ? 0 : width,
    height === 256 ? 0 : height,
    0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0,
  ])
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

// --- Test utilities ---

async function setupTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `preimage-mbt-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeImage(dir: string, rel: string, bytes: Uint8Array): Promise<void> {
  const full = join(dir, rel)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, bytes)
}

// --- Cases ---

async function caseEmpty(): Promise<void> {
  const dir = await setupTempDir('empty')
  try {
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    if (Object.keys(m).length !== 0) {
      fail('empty-dir', `expected empty, got ${JSON.stringify(m)}`)
    } else {
      pass('empty-dir')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseSingleFile(): Promise<void> {
  const dir = await setupTempDir('single')
  try {
    await writeImage(dir, 'test.png', buildPng(100, 200))
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    const keys = Object.keys(m)
    if (keys.length !== 1) {
      fail('single-file', `expected 1 entry, got ${keys.length}`)
      return
    }
    const entry = m[keys[0]!]!
    if (entry.width !== 100 || entry.height !== 200) {
      fail('single-file-dims', `got ${entry.width}x${entry.height}, expected 100x200`)
    } else {
      pass('single-file', `${keys[0]}: ${entry.width}×${entry.height}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseNested(): Promise<void> {
  const dir = await setupTempDir('nested')
  try {
    await writeImage(dir, 'a.png', buildPng(100, 100))
    await writeImage(dir, 'sub1/b.jpg', buildJpeg(200, 300))
    await writeImage(dir, 'sub1/sub2/c.png', buildPng(400, 500))
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    const keys = Object.keys(m).sort()
    const expected = ['a.png', 'sub1/b.jpg', 'sub1/sub2/c.png']
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      fail('nested', `expected ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`)
    } else {
      pass('nested')
    }
    // Verify forward slashes on all platforms.
    if (keys.some((k) => k.includes('\\'))) {
      fail('nested/slashes', 'backslash in manifest key')
    } else {
      pass('nested/slashes')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseNonImageFilesIgnored(): Promise<void> {
  const dir = await setupTempDir('non-images')
  try {
    await writeImage(dir, 'image.png', buildPng(100, 100))
    await writeImage(dir, 'readme.md', new TextEncoder().encode('# readme\n'))
    await writeImage(dir, 'data.json', new TextEncoder().encode('{}'))
    await writeImage(dir, 'script.js', new TextEncoder().encode('console.log("x")\n'))
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    const keys = Object.keys(m)
    if (keys.length !== 1 || keys[0] !== 'image.png') {
      fail('non-image-ignore', `expected only image.png, got ${JSON.stringify(keys)}`)
    } else {
      pass('non-image-ignore')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseDotfileIgnored(): Promise<void> {
  const dir = await setupTempDir('dotfiles')
  try {
    await writeImage(dir, '.hidden.png', buildPng(100, 100))
    await writeImage(dir, 'visible.png', buildPng(200, 200))
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    const keys = Object.keys(m)
    if (keys.includes('.hidden.png')) {
      fail('dotfile-ignore', `dotfile was included: ${JSON.stringify(keys)}`)
    } else if (keys.length !== 1 || keys[0] !== 'visible.png') {
      fail('dotfile-ignore', `expected [visible.png], got ${JSON.stringify(keys)}`)
    } else {
      pass('dotfile-ignore')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseNodeModulesIgnored(): Promise<void> {
  const dir = await setupTempDir('node-modules')
  try {
    await writeImage(dir, 'node_modules/pkg/image.png', buildPng(100, 100))
    await writeImage(dir, 'own.png', buildPng(200, 200))
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    const keys = Object.keys(m)
    if (keys.some((k) => k.startsWith('node_modules'))) {
      fail('node-modules-ignore', `included: ${JSON.stringify(keys)}`)
    } else if (keys.length !== 1 || keys[0] !== 'own.png') {
      fail('node-modules-ignore', `expected [own.png], got ${JSON.stringify(keys)}`)
    } else {
      pass('node-modules-ignore')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseBasePrefix(): Promise<void> {
  const dir = await setupTempDir('base')
  try {
    await writeImage(dir, 'a.png', buildPng(10, 10))
    await writeImage(dir, 'sub/b.png', buildPng(20, 20))
    const m = await buildManifest({ root: dir, base: '/assets/', onSkip: () => {} })
    const keys = Object.keys(m).sort()
    const expected = ['/assets/a.png', '/assets/sub/b.png']
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      fail('base-prefix', `expected ${JSON.stringify(expected)}, got ${JSON.stringify(keys)}`)
    } else {
      pass('base-prefix')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseCustomExtensions(): Promise<void> {
  const dir = await setupTempDir('ext')
  try {
    await writeImage(dir, 'a.png', buildPng(10, 10))
    await writeImage(dir, 'b.jpg', buildJpeg(20, 20))
    // Restrict to png only.
    const m = await buildManifest({ root: dir, extensions: ['png'], onSkip: () => {} })
    const keys = Object.keys(m).sort()
    if (JSON.stringify(keys) !== '["a.png"]') {
      fail('custom-ext', `expected [a.png], got ${JSON.stringify(keys)}`)
    } else {
      pass('custom-ext')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseCorruptImageSkipped(): Promise<void> {
  const dir = await setupTempDir('corrupt')
  try {
    await writeImage(dir, 'valid.png', buildPng(100, 100))
    // Corrupt: PNG signature with truncated IHDR.
    await writeImage(dir, 'bad.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]))
    const skips: string[] = []
    const m = await buildManifest({ root: dir, onSkip: (p) => skips.push(p) })
    if (Object.keys(m).length !== 1 || m['valid.png'] === undefined) {
      fail('corrupt-skip', `manifest: ${JSON.stringify(m)}`)
    } else if (skips.length !== 1) {
      fail('corrupt-skip/onSkip', `expected 1 skip callback, got ${skips.length}`)
    } else {
      pass('corrupt-skip')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseLargeHeaderJpeg(): Promise<void> {
  const dir = await setupTempDir('large-jpeg')
  try {
    await writeImage(dir, 'large.jpg', buildLargeHeaderJpeg(321, 123, 8192))
    const skips: string[] = []
    const m = await buildManifest({ root: dir, onSkip: (p, reason) => skips.push(`${p}: ${reason}`) })
    const entry = m['large.jpg']
    if (entry === undefined) {
      fail('large-header-jpeg', `missing entry, skips: ${JSON.stringify(skips)}`)
    } else if (entry.width !== 321 || entry.height !== 123) {
      fail('large-header-jpeg/dims', `got ${entry.width}x${entry.height}, expected 321x123`)
    } else if (skips.length !== 0) {
      fail('large-header-jpeg/skips', `unexpected skips: ${JSON.stringify(skips)}`)
    } else {
      pass('large-header-jpeg')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function caseDefaultModernExtensions(): Promise<void> {
  const dir = await setupTempDir('modern-ext')
  try {
    await writeImage(dir, 'image.avif', buildIsobmff('avif', 111, 222))
    await writeImage(dir, 'image.heic', buildIsobmff('heic', 333, 444))
    await writeImage(dir, 'image.heif', buildIsobmff('heic', 555, 666))
    await writeImage(dir, 'animated.apng', buildPng(77, 88))
    await writeImage(dir, 'icon.ico', buildIco(32, 48))
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    const expected: Record<string, { width: number; height: number }> = {
      'image.avif': { width: 111, height: 222 },
      'image.heic': { width: 333, height: 444 },
      'image.heif': { width: 555, height: 666 },
      'animated.apng': { width: 77, height: 88 },
      'icon.ico': { width: 32, height: 48 },
    }
    for (const [key, dims] of Object.entries(expected)) {
      const entry = m[key]
      if (entry === undefined) {
        fail(`modern-ext/${key}`, `missing from manifest: ${JSON.stringify(Object.keys(m).sort())}`)
      } else if (entry.width !== dims.width || entry.height !== dims.height) {
        fail(`modern-ext/${key}`, `got ${entry.width}x${entry.height}`)
      } else {
        pass(`modern-ext/${key}`)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function casePerfLargeDir(): Promise<{ wallMs: number; count: number }> {
  const dir = await setupTempDir('perf')
  try {
    const count = 100
    const writePromises: Promise<void>[] = []
    for (let i = 0; i < count; i++) {
      writePromises.push(writeImage(dir, `img-${i}.png`, buildPng(100 + i, 100 + i)))
    }
    await Promise.all(writePromises)
    const t0 = performance.now()
    const m = await buildManifest({ root: dir, onSkip: () => {} })
    const wallMs = performance.now() - t0
    if (Object.keys(m).length !== count) {
      fail('perf/large-dir', `expected ${count} entries, got ${Object.keys(m).length}`)
    } else {
      pass('perf/large-dir', `${count} files in ${wallMs.toFixed(0)}ms`)
    }
    return { wallMs, count }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  await caseEmpty()
  await caseSingleFile()
  await caseNested()
  await caseNonImageFilesIgnored()
  await caseDotfileIgnored()
  await caseNodeModulesIgnored()
  await caseBasePrefix()
  await caseCustomExtensions()
  await caseCorruptImageSkipped()
  await caseLargeHeaderJpeg()
  await caseDefaultModernExtensions()
  const perf = await casePerfLargeDir()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== manifest-build-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `manifest-build-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'manifest-build',
        date: new Date().toISOString(),
        wallMs,
        total,
        passed,
        failed: failed.length,
        perf,
        results,
      },
      null,
      2,
    ),
  )
  process.stdout.write(`=== Saved ${outPath} ===\n`)
  if (failed.length > 0) process.exit(1)
}

// Suppress unused imports.
void readFile

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
