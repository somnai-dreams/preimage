// Coverage for fit.ts + analysis.ts. Both are pure-math / pure-string
// modules powering layout + source-detection; everything downstream
// relies on their correctness.
//
// Usage: bun run scripts/fit-analysis-test.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fitRect, type ObjectFit } from '../packages/preimage/src/fit.ts'
import {
  detectImageFormat,
  detectSourceKind,
  normalizeSrc,
} from '../packages/preimage/src/analysis.ts'

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

function approxEqual(a: number, b: number, tol = 0.001): boolean {
  return Math.abs(a - b) < tol
}

// --- fitRect ---

function checkFit(): void {
  // Square image in square box, contain.
  let r = fitRect(100, 100, 200, 200, 'contain')
  if (r.width !== 200 || r.height !== 200 || r.offsetX !== 0 || r.offsetY !== 0 || r.scale !== 2) {
    fail('fit/square-contain', JSON.stringify(r))
  } else pass('fit/square-contain')

  // Portrait image in landscape box, contain (height-limited).
  r = fitRect(100, 200, 400, 200, 'contain')
  // Scale = min(4, 1) = 1. width=100, height=200. offsetX=(400-100)/2=150.
  if (r.scale !== 1 || r.width !== 100 || r.height !== 200 || r.offsetX !== 150) {
    fail('fit/portrait-in-landscape-contain', JSON.stringify(r))
  } else pass('fit/portrait-in-landscape-contain')

  // Cover: image fills box, overflows the non-matching axis.
  r = fitRect(100, 200, 400, 200, 'cover')
  // Scale = max(4, 1) = 4. width=400, height=800. offsetY=(200-800)/2=-300.
  if (r.scale !== 4 || r.width !== 400 || r.height !== 800) {
    fail('fit/cover-portrait', JSON.stringify(r))
  } else pass('fit/cover-portrait')

  // Fill: stretches to box, ignores aspect.
  r = fitRect(100, 100, 300, 200, 'fill')
  if (r.width !== 300 || r.height !== 200) {
    fail('fit/fill-stretch', JSON.stringify(r))
  } else pass('fit/fill-stretch')

  // None: no scaling, center in box.
  r = fitRect(100, 100, 300, 200, 'none')
  if (r.width !== 100 || r.height !== 100 || r.scale !== 1 || r.offsetX !== 100 || r.offsetY !== 50) {
    fail('fit/none', JSON.stringify(r))
  } else pass('fit/none')

  // scale-down: image smaller than box → no upscale.
  r = fitRect(100, 100, 300, 300, 'scale-down')
  if (r.width !== 100 || r.height !== 100 || r.scale !== 1) {
    fail('fit/scale-down-small', JSON.stringify(r))
  } else pass('fit/scale-down-small')

  // scale-down: image larger than box → downscale to fit.
  r = fitRect(600, 400, 300, 200, 'scale-down')
  if (r.scale !== 0.5 || r.width !== 300 || r.height !== 200) {
    fail('fit/scale-down-large', JSON.stringify(r))
  } else pass('fit/scale-down-large')

  // Unbounded height (Infinity).
  r = fitRect(100, 200, 400, Infinity, 'contain')
  // Scale = 4 (boxWidth/natWidth, since ry = rx for unbounded).
  // width=400, height=800.
  if (r.scale !== 4 || r.width !== 400 || r.height !== 800 || r.offsetY !== 0) {
    fail('fit/unbounded-height', JSON.stringify(r))
  } else pass('fit/unbounded-height')

  // Degenerate: zero natural width.
  r = fitRect(0, 100, 200, 200, 'contain')
  if (r.width !== 0 || r.height !== 0 || r.scale !== 0) {
    fail('fit/degenerate-zero-width', JSON.stringify(r))
  } else pass('fit/degenerate-zero-width')

  // Degenerate: negative height.
  r = fitRect(100, -100, 200, 200, 'contain')
  if (r.width !== 0 || r.height !== 0) {
    fail('fit/degenerate-negative', JSON.stringify(r))
  } else pass('fit/degenerate-negative')

  // Degenerate: NaN input.
  r = fitRect(Number.NaN, 100, 200, 200, 'contain')
  if (r.width !== 0 || r.height !== 0) {
    fail('fit/degenerate-nan', JSON.stringify(r))
  } else pass('fit/degenerate-nan')

  // Degenerate: zero box width.
  r = fitRect(100, 100, 0, 200, 'contain')
  if (r.width !== 0 || r.height !== 0) {
    fail('fit/degenerate-zero-box-width', JSON.stringify(r))
  } else pass('fit/degenerate-zero-box-width')

  // Same-aspect downscale: all fits converge on 200×200 when the
  // input is larger than the box (scale-down kicks in as contain).
  const downscaleFits: ObjectFit[] = ['contain', 'cover', 'fill', 'scale-down']
  let downscaleMatching = 0
  for (const fit of downscaleFits) {
    const rr = fitRect(400, 400, 200, 200, fit)
    if (rr.width === 200 && rr.height === 200) downscaleMatching++
  }
  if (downscaleMatching === downscaleFits.length) pass('fit/same-aspect-downscale-convergence')
  else fail('fit/same-aspect-downscale-convergence', `${downscaleMatching}/${downscaleFits.length}`)

  // Same-aspect upscale: scale-down does NOT upscale (keeps native),
  // while contain/cover/fill all stretch to 200×200. This is the
  // meaningful difference.
  const scaleDownRes = fitRect(100, 100, 200, 200, 'scale-down')
  if (scaleDownRes.width !== 100 || scaleDownRes.scale !== 1) {
    fail('fit/scale-down-keeps-native-on-upscale', JSON.stringify(scaleDownRes))
  } else pass('fit/scale-down-keeps-native-on-upscale')

  // Scale-down on same-aspect up-fit — stays at scale 1.
  r = fitRect(100, 100, 200, 200, 'scale-down')
  if (r.scale !== 1 || r.width !== 100 || r.height !== 100) {
    fail('fit/scale-down-no-upscale', JSON.stringify(r))
  } else pass('fit/scale-down-no-upscale')

  // Precise geometry check: 16:9 image in 4:3 container, contain.
  r = fitRect(1920, 1080, 800, 600, 'contain')
  // Scale limited by width: 800/1920 = 0.4167 (height: 600/1080 = 0.5556; min is 0.4167)
  // width = 800, height = 450 (centered at y = (600-450)/2 = 75).
  if (!approxEqual(r.scale, 800 / 1920) || r.width !== 800 || !approxEqual(r.height, 450) || !approxEqual(r.offsetY, 75)) {
    fail('fit/16-9-in-4-3-contain', JSON.stringify(r))
  } else pass('fit/16-9-in-4-3-contain')
}

// --- detectImageFormat ---

function checkDetectImageFormat(): void {
  const cases: Array<[string, string]> = [
    ['photo.jpg', 'jpeg'],
    ['photo.jpeg', 'jpeg'],
    ['photo.PNG', 'png'],
    ['path/to/image.webp', 'webp'],
    ['image.gif', 'gif'],
    ['photo.avif', 'avif'],
    ['icon.svg', 'svg'],
    ['pixmap.bmp', 'bmp'],
    ['favicon.ico', 'ico'],
    ['animated.apng', 'apng'],
    ['camera.heic', 'heic'],
    // Query string / hash should be stripped.
    ['photo.jpg?v=1', 'jpeg'],
    ['photo.jpg#anchor', 'jpeg'],
    ['photo.jpg?v=1#hash', 'jpeg'],
    // No extension.
    ['no-extension', 'unknown'],
    ['path/to/file', 'unknown'],
    // Empty.
    ['', 'unknown'],
    // Unknown extension.
    ['doc.pdf', 'unknown'],
    ['data.json', 'unknown'],
    // data: URL with mime.
    ['data:image/png;base64,abcd', 'png'],
    ['data:image/jpeg,junk', 'jpeg'],
    ['data:image/webp;base64,xxx', 'webp'],
    ['data:text/plain;base64,xxx', 'unknown'],
    ['data:application/octet-stream,xxx', 'unknown'],
  ]
  for (const [input, expected] of cases) {
    const out = detectImageFormat(input)
    if (out !== expected) {
      fail(`format/${JSON.stringify(input)}`, `got ${out}, expected ${expected}`)
    } else {
      pass(`format/${JSON.stringify(input)}`)
    }
  }
}

// --- detectSourceKind ---

function checkDetectSourceKind(): void {
  const cases: Array<[string, string]> = [
    ['https://example.com/photo.jpg', 'http'],
    ['http://example.com/photo.jpg', 'http'],
    ['//cdn.example.com/img.png', 'http'],
    ['data:image/png;base64,abcd', 'data'],
    ['blob:https://example.com/uuid', 'blob'],
    ['/absolute/path.jpg', 'relative'],
    ['relative/path.jpg', 'relative'],
    ['./photo.jpg', 'relative'],
    ['', 'unknown'],
  ]
  for (const [input, expected] of cases) {
    const out = detectSourceKind(input)
    if (out !== expected) {
      fail(`kind/${JSON.stringify(input)}`, `got ${out}, expected ${expected}`)
    } else {
      pass(`kind/${JSON.stringify(input)}`)
    }
  }
}

// --- normalizeSrc ---

function checkNormalizeSrc(): void {
  const cases: Array<[string, string]> = [
    ['photo.jpg', 'photo.jpg'],
    ['photo.jpg#hash', 'photo.jpg'],
    ['photo.jpg?v=1', 'photo.jpg?v=1'], // query preserved
    ['photo.jpg?v=1#hash', 'photo.jpg?v=1'],
    ['data:image/png;base64,abcd', 'data:image/png;base64,abcd'],
    ['data:image/png;base64,abcd#x', 'data:image/png;base64,abcd#x'], // data: untouched entirely
    ['', ''],
    ['#only-hash', ''],
  ]
  for (const [input, expected] of cases) {
    const out = normalizeSrc(input)
    if (out !== expected) {
      fail(`normalize/${JSON.stringify(input)}`, `got ${JSON.stringify(out)}, expected ${JSON.stringify(expected)}`)
    } else {
      pass(`normalize/${JSON.stringify(input)}`)
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  checkFit()
  checkDetectImageFormat()
  checkDetectSourceKind()
  checkNormalizeSrc()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== fit-analysis-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `fit-analysis-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      { bench: 'fit-analysis', date: new Date().toISOString(), wallMs, total, passed, failed: failed.length, results },
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
