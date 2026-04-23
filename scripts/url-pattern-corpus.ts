// URL-pattern parser corpus test. The URL-dimension shortcuts in
// url-dimensions.ts skip a network probe entirely for URLs that
// encode dims in the path or query. A parser that fails silently
// on real-world URL shapes is an invisible regression — the library
// still works, it just does more work than it needs to.
//
// This harness runs the five shipped vendor parsers against a
// corpus of representative URLs, checks positive matches + negative
// non-matches, and saves a summary JSON. Non-zero exit on failure.
//
// Usage:
//   bun run scripts/url-pattern-corpus.ts

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cloudinaryParser,
  picsumParser,
  queryParamDimensionParser,
  shopifyParser,
  unsplashParser,
  type UrlDimensionParser,
  type UrlDimensions,
} from '../packages/preimage/src/url-dimensions.ts'

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

function expectMatch(
  parser: UrlDimensionParser,
  label: string,
  url: string,
  expected: UrlDimensions,
): void {
  let out: UrlDimensions | null
  try {
    out = parser(url)
  } catch (err) {
    fail(label, `threw: ${(err as Error).message}`)
    return
  }
  if (out === null) {
    fail(label, 'returned null, expected dims')
    return
  }
  if (out.width !== expected.width || out.height !== expected.height) {
    fail(label, `got ${out.width}x${out.height}, expected ${expected.width}x${expected.height}`)
    return
  }
  pass(label, `${out.width}×${out.height}`)
}

function expectNull(parser: UrlDimensionParser, label: string, url: string): void {
  let out: UrlDimensions | null
  try {
    out = parser(url)
  } catch (err) {
    fail(label, `threw: ${(err as Error).message}`)
    return
  }
  if (out !== null) {
    fail(label, `expected null, got ${JSON.stringify(out)}`)
    return
  }
  pass(label)
}

// --- Cloudinary ---

function runCloudinary(): void {
  const base = 'https://res.cloudinary.com/demo/image/upload'
  expectMatch(cloudinaryParser, 'cloudinary/basic-comma', `${base}/w_400,h_300/sample.jpg`, {
    width: 400,
    height: 300,
  })
  expectMatch(
    cloudinaryParser,
    'cloudinary/multi-transform',
    `${base}/f_auto,q_auto,w_800,h_600/photo.jpg`,
    { width: 800, height: 600 },
  )
  expectMatch(
    cloudinaryParser,
    'cloudinary/slash-separated',
    `${base}/w_1600/h_900/image.png`,
    { width: 1600, height: 900 },
  )
  expectMatch(
    cloudinaryParser,
    'cloudinary/mixed-order',
    `${base}/h_240,w_320/thumb.jpg`,
    { width: 320, height: 240 },
  )
  expectMatch(
    cloudinaryParser,
    'cloudinary/with-query-string',
    `${base}/w_400,h_300/sample.jpg?_a=ABC`,
    { width: 400, height: 300 },
  )
  expectNull(cloudinaryParser, 'cloudinary/no-dims', `${base}/sample.jpg`)
  expectNull(
    cloudinaryParser,
    'cloudinary/width-only',
    `${base}/w_400/sample.jpg`,
  )
  expectNull(cloudinaryParser, 'cloudinary/different-domain', 'https://example.com/w_400,h_300.jpg')

  // Regression: w_400 inside a larger identifier shouldn't match
  // (e.g. a custom public_id that happens to contain "w_400" as a
  // substring). The `(?:^|[/,])` prefix and `(?:[,/]|$)` suffix
  // guard against this.
  expectNull(
    cloudinaryParser,
    'cloudinary/w_in-public-id',
    `${base}/sample_w_400_h_300.jpg`,
  )
}

// --- Shopify ---

function runShopify(): void {
  const base = 'https://cdn.shopify.com/s/files/1/1234/5678/products'
  expectMatch(shopifyParser, 'shopify/basic', `${base}/shirt_640x480.jpg`, {
    width: 640,
    height: 480,
  })
  expectMatch(shopifyParser, 'shopify/with-query', `${base}/shoe_800x1200.png?v=123`, {
    width: 800,
    height: 1200,
  })
  expectMatch(shopifyParser, 'shopify/at-modifier', `${base}/hat_400x400@2x.jpg`, {
    width: 400,
    height: 400,
  })
  expectMatch(shopifyParser, 'shopify/underscore-modifier', `${base}/bag_300x300_grande.jpg`, {
    width: 300,
    height: 300,
  })
  expectNull(shopifyParser, 'shopify/no-dims', `${base}/item.jpg`)
  expectNull(shopifyParser, 'shopify/different-domain', 'https://example.com/product_640x480.jpg')
}

// --- Picsum ---

function runPicsum(): void {
  expectMatch(picsumParser, 'picsum/plain', 'https://picsum.photos/200/300', {
    width: 200,
    height: 300,
  })
  expectMatch(picsumParser, 'picsum/with-seed', 'https://picsum.photos/seed/abc/400/500', {
    width: 400,
    height: 500,
  })
  expectMatch(picsumParser, 'picsum/with-id', 'https://picsum.photos/id/237/640/480', {
    width: 640,
    height: 480,
  })
  expectMatch(picsumParser, 'picsum/with-query', 'https://picsum.photos/200/300?blur=2', {
    width: 200,
    height: 300,
  })
  expectMatch(picsumParser, 'picsum/with-fragment', 'https://picsum.photos/200/300#hash', {
    width: 200,
    height: 300,
  })
  expectNull(picsumParser, 'picsum/no-dims', 'https://picsum.photos/')
  expectNull(picsumParser, 'picsum/different-domain', 'https://example.com/200/300')
}

// --- Unsplash ---

function runUnsplash(): void {
  expectMatch(
    unsplashParser,
    'unsplash/w-and-h',
    'https://images.unsplash.com/photo-1234567?w=400&h=300',
    { width: 400, height: 300 },
  )
  expectMatch(
    unsplashParser,
    'unsplash/h-and-w-reversed',
    'https://images.unsplash.com/photo-abc?h=500&w=800',
    { width: 800, height: 500 },
  )
  expectMatch(
    unsplashParser,
    'unsplash/with-other-params',
    'https://images.unsplash.com/photo-xyz?w=400&h=300&fit=crop&auto=format',
    { width: 400, height: 300 },
  )
  expectNull(
    unsplashParser,
    'unsplash/w-only',
    'https://images.unsplash.com/photo-xyz?w=400',
  )
  expectNull(
    unsplashParser,
    'unsplash/no-query',
    'https://images.unsplash.com/photo-xyz',
  )
  expectNull(unsplashParser, 'unsplash/different-domain', 'https://example.com/photo?w=400&h=300')
}

// --- Generic queryParamDimensionParser ---

function runQueryParam(): void {
  // Simulating imgix: domain predicate + standard w/h keys.
  const imgixParser = queryParamDimensionParser(
    (url) => url.includes('.imgix.net/'),
    'w',
    'h',
  )
  expectMatch(imgixParser, 'query/imgix-basic', 'https://account.imgix.net/photo.jpg?w=500&h=300', {
    width: 500,
    height: 300,
  })
  expectMatch(
    imgixParser,
    'query/imgix-with-other-params',
    'https://account.imgix.net/photo.jpg?fit=crop&w=800&h=600&auto=format',
    { width: 800, height: 600 },
  )
  expectNull(imgixParser, 'query/imgix-w-only', 'https://account.imgix.net/photo.jpg?w=500')
  expectNull(imgixParser, 'query/imgix-no-query', 'https://account.imgix.net/photo.jpg')
  expectNull(
    imgixParser,
    'query/imgix-different-domain',
    'https://other.com/photo.jpg?w=500&h=300',
  )

  // Custom keys: Next/image uses `w` but no native h (it derives from
  // intrinsic ratio). Can't use the generic parser without both keys.
  // Simulate a setup that uses different keys:
  const customParser = queryParamDimensionParser(
    (url) => url.includes('cdn.example.com/'),
    'width',
    'height',
  )
  expectMatch(
    customParser,
    'query/custom-keys',
    'https://cdn.example.com/asset.jpg?width=1920&height=1080',
    { width: 1920, height: 1080 },
  )
  expectNull(
    customParser,
    'query/custom-keys-standard-keys',
    'https://cdn.example.com/asset.jpg?w=1920&h=1080',
  )

  // Numeric validation — dims must be finite positive.
  expectNull(
    imgixParser,
    'query/negative-height',
    'https://account.imgix.net/p.jpg?w=500&h=-100',
  )
  expectNull(
    imgixParser,
    'query/zero-width',
    'https://account.imgix.net/p.jpg?w=0&h=100',
  )
  expectNull(
    imgixParser,
    'query/non-numeric',
    'https://account.imgix.net/p.jpg?w=auto&h=100',
  )
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  runCloudinary()
  runShopify()
  runPicsum()
  runUnsplash()
  runQueryParam()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(
    `=== url-pattern-corpus: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`,
  )
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `url-pattern-corpus-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'url-pattern-corpus',
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

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
