#!/usr/bin/env bun
// Corpus harness: fetch real-world images from multiple sources, range-fetch
// the first ~32KB of each, and find the minimum number of header bytes
// each one needs before `probeImageBytes` returns dims. Aggregates a
// per-format percentile distribution so we can decide whether the
// default rangeBytes (4096) is larger than it needs to be for rasters,
// and whether SVG's 4KB ceiling is actually enough for the tail.
//
// Sources:
//   1. Wikimedia Commons — random File: namespace generator, bucketed
//      client-side by MIME. Originals (not re-encoded thumbs) so JPEG
//      EXIF / SVG prolog survives.
//   2. Flickr public feeds — JPEG encoder variance. No API key.
//   3. Curated SVG icon libraries via unpkg — Lucide, Heroicons,
//      Feather, Material Symbols. Hand-authored SVG tail cases.
//   4. Parquet dataset (--sources parquet) — local product-catalog
//      dumps at /Users/max/Documents/Dev/datatset/*.parquet. Each
//      host's schema differs; we auto-describe and pick the best
//      image URL column. Gives real CDN diversity: Amazon/Zara/Etsy
//      JPEGs, eBay WebP, Wayfair/Home Depot arrays, etc.
//
// Not a regression harness: depends on external APIs and the live
// network. Do NOT wire into `check:all`. Run manually when the
// rangeBytes heuristic needs revisiting.
//
// Usage:
//   bun scripts/probe-byte-threshold-corpus.ts
//   bun scripts/probe-byte-threshold-corpus.ts --sources parquet --time-budget 600
//   bun scripts/probe-byte-threshold-corpus.ts --smoke    # tiny smoke test
//
// SIGINT / SIGTERM / --time-budget all flush a JSON report with
// whatever was measured before stopping — you never lose in-flight
// data to a Ctrl-C.

import { writeFile, mkdir } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { probeImageBytes } from '../packages/preimage/src/probe.ts'
import type { ImageFormat } from '../packages/preimage/src/analysis.ts'

type SourceName = 'wikimedia' | 'flickr' | 'iconlib' | 'parquet' | 'modern'

type Args = {
  sources: SourceName[]
  wikimediaTargets: Record<ImageFormat, number>
  flickrCount: number
  iconCount: number
  parquetDir: string
  parquetPerHost: number
  concurrency: number
  probeCeilingBytes: number
  timeBudgetSeconds: number
  fetchTimeoutMs: number
  out: string | null
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    sources: ['wikimedia', 'flickr', 'iconlib', 'parquet', 'modern'],
    // Weighted by how informative each format's tail is. JPEG's the
    // only raster where bytes-to-SOF has meaningful variance — the
    // others (PNG/GIF/WebP) fix the header offset and cluster hard at
    // 128 bytes. SVG's tail depends on hand-authored prolog length.
    wikimediaTargets: { jpeg: 2000, png: 300, gif: 200, webp: 100, svg: 800 },
    flickrCount: 500,
    iconCount: 150,
    parquetDir: '/Users/max/Documents/Dev/datatset',
    parquetPerHost: 250,
    // Wikimedia upload.wikimedia.org rate-limits aggressively; 6 is the
    // sweet spot where 429s are rare. Product CDNs tolerate more — if
    // running --sources parquet only, bump with --concurrency 16.
    concurrency: 6,
    probeCeilingBytes: 32 * 1024,
    timeBudgetSeconds: 0,
    fetchTimeoutMs: 15_000,
    out: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--sources') {
      const raw = argv[++i]!
      const parsed = raw.split(',').map((s) => s.trim()) as SourceName[]
      args.sources = parsed
    } else if (a === '--flickr-count') args.flickrCount = Number(argv[++i])
    else if (a === '--icon-count') args.iconCount = Number(argv[++i])
    else if (a === '--parquet-dir') args.parquetDir = argv[++i]!
    else if (a === '--parquet-per-host') args.parquetPerHost = Number(argv[++i])
    else if (a === '--concurrency') args.concurrency = Number(argv[++i])
    else if (a === '--ceiling-bytes') args.probeCeilingBytes = Number(argv[++i])
    else if (a === '--time-budget') args.timeBudgetSeconds = Number(argv[++i])
    else if (a === '--fetch-timeout-ms') args.fetchTimeoutMs = Number(argv[++i])
    else if (a === '--out') args.out = argv[++i]!
    else if (a === '--smoke') {
      args.wikimediaTargets = { jpeg: 20, png: 20, gif: 20, webp: 20, svg: 20 }
      args.flickrCount = 20
      args.iconCount = 20
      args.parquetPerHost = 15
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'Usage: bun scripts/probe-byte-threshold-corpus.ts [options]',
          '',
          '  --sources list          comma-separated: wikimedia,flickr,iconlib,parquet',
          '  --flickr-count N        Flickr JPEG sample size (default 500)',
          '  --icon-count N          curated icon-lib SVG count (default 150)',
          '  --parquet-dir path      parquet file directory',
          '  --parquet-per-host N    URLs per host (default 250)',
          '  --concurrency N         parallel fetches (default 6)',
          '  --ceiling-bytes N       max bytes to range-fetch per URL (default 32768)',
          '  --time-budget SECS      stop measuring after N seconds (flushes results)',
          '  --fetch-timeout-ms MS   per-fetch timeout (default 15000)',
          '  --smoke                 tiny smoke test',
          '  --out path.json         write report to file',
          '',
          'Graceful shutdown: SIGINT/SIGTERM/--time-budget all flush',
          'a partial report. You never lose in-flight data.',
          '',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return args
}

// --- Stop coordination ---

// Single AbortController coordinates three stop sources: SIGINT,
// SIGTERM, and `--time-budget` elapsed. Anything checking
// `shutdownSignal.aborted` returns early; fetches plumb the signal
// through so in-flight requests are cut. `main` uses try/finally to
// guarantee the JSON report flushes no matter how we stop.
const shutdownController = new AbortController()
const shutdownSignal = shutdownController.signal

function requestShutdown(reason: string): void {
  if (shutdownSignal.aborted) return
  process.stdout.write(`\n\n[${reason} — flushing data and exiting cleanly]\n`)
  shutdownController.abort()
}

process.on('SIGINT', () => requestShutdown('SIGINT received'))
process.on('SIGTERM', () => requestShutdown('SIGTERM received'))

// --- Gatherers ---

const USER_AGENT = 'preimage-bench/0 (https://github.com/chenglou/preimage; benchmarking header-byte distribution)'

type GatheredUrl = {
  url: string
  source: SourceName
  host: string
  expectedFormat: ImageFormat | null
}

const MIME_TO_FORMAT: Record<string, ImageFormat> = {
  'image/jpeg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/svg': 'svg',
}

function inferFormatFromUrl(url: string): ImageFormat | null {
  // Cheap pattern (vetted by bench-svg-sniff.ts — regex sniff is ~17ns).
  // Strip query/hash before the tail check.
  const cut = url.search(/[?#]/)
  const path = cut < 0 ? url : url.slice(0, cut)
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpeg'
  if (lower.endsWith('.png')) return 'png'
  if (lower.endsWith('.gif')) return 'gif'
  if (lower.endsWith('.webp')) return 'webp'
  if (lower.endsWith('.svg')) return 'svg'
  return null
}

function inferHostFromUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

async function gatherWikimedia(targets: Record<ImageFormat, number>): Promise<GatheredUrl[]> {
  const buckets: Record<ImageFormat, GatheredUrl[]> = {
    jpeg: [], png: [], gif: [], webp: [], svg: [],
  }
  const formats = Object.keys(buckets) as ImageFormat[]
  const isDone = () => formats.every((f) => buckets[f].length >= targets[f])
  const maxIterations = 5000
  const progressEvery = 25
  const startedAt = performance.now()
  for (let iter = 0; iter < maxIterations; iter++) {
    if (shutdownSignal.aborted) break
    if (isDone()) break
    if (iter > 0 && iter % progressEvery === 0) {
      const elapsed = ((performance.now() - startedAt) / 1000).toFixed(0)
      const counts = formats.map((f) => `${f}:${buckets[f].length}/${targets[f]}`).join(' ')
      process.stdout.write(`  wikimedia iter ${iter} [${elapsed}s] ${counts}\n`)
    }
    const params = new URLSearchParams({
      action: 'query',
      generator: 'random',
      grnnamespace: '6',
      grnlimit: '20',
      prop: 'imageinfo',
      iiprop: 'url|mime|size',
      format: 'json',
      formatversion: '2',
      origin: '*',
    })
    const url = `https://commons.wikimedia.org/w/api.php?${params.toString()}`
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: shutdownSignal,
      })
      if (!res.ok) {
        if (res.status === 429 || res.status === 503) {
          await sleep(500 + Math.random() * 500)
          continue
        }
        throw new Error(`wikimedia random fetch failed: ${res.status}`)
      }
      const json = (await res.json()) as {
        query?: { pages?: Array<{ imageinfo?: Array<{ url?: string; mime?: string; size?: number }> }> }
      }
      const pages = json.query?.pages ?? []
      for (const page of pages) {
        const info = page.imageinfo?.[0]
        if (info === undefined || info.url === undefined || info.mime === undefined) continue
        if (info.size === 0) continue
        const format = MIME_TO_FORMAT[info.mime]
        if (format === undefined) continue
        if (buckets[format].length >= targets[format]) continue
        buckets[format].push({
          url: info.url,
          source: 'wikimedia',
          host: inferHostFromUrl(info.url),
          expectedFormat: format,
        })
      }
    } catch (err) {
      if (shutdownSignal.aborted) break
      process.stdout.write(`  wikimedia iter ${iter}: ${(err as Error).message}\n`)
      await sleep(500)
    }
  }
  for (const f of Object.keys(buckets) as ImageFormat[]) {
    process.stdout.write(`  wikimedia ${f.padEnd(4)}: gathered ${buckets[f].length} URLs\n`)
  }
  return [...buckets.jpeg, ...buckets.png, ...buckets.gif, ...buckets.webp, ...buckets.svg]
}

async function gatherFlickr(count: number): Promise<GatheredUrl[]> {
  const tags = [
    'landscape', 'portrait', 'macro', 'street', 'architecture',
    'wildlife', 'concert', 'food', 'wedding', 'sports',
    'astrophotography', 'blackandwhite', 'drone', 'skateboarding', 'travel',
    'mountain', 'beach', 'urban', 'night', 'nature',
    'flower', 'sunset', 'river', 'snow', 'forest',
    'cat', 'dog', 'bird', 'desert', 'city',
    'motorcycle', 'train', 'airplane', 'boat', 'festival',
    'museum', 'garden', 'bridge', 'lake', 'tree',
    'fog', 'rain', 'ice', 'volcano', 'canyon',
    'ship', 'bicycle', 'skyline', 'reflection', 'silhouette',
    'cosplay', 'graffiti', 'marathon', 'parade', 'library',
  ]
  const out: GatheredUrl[] = []
  for (const tag of tags) {
    if (shutdownSignal.aborted) break
    if (out.length >= count) break
    try {
      const url = `https://api.flickr.com/services/feeds/photos_public.gne?format=json&nojsoncallback=1&tags=${encodeURIComponent(tag)}`
      const res = await fetch(url, { signal: shutdownSignal })
      if (!res.ok) continue
      const body = await res.text()
      const start = body.indexOf('{')
      const end = body.lastIndexOf('}')
      if (start < 0 || end < 0) continue
      const json = JSON.parse(body.slice(start, end + 1)) as { items?: Array<{ media?: { m?: string } }> }
      const items = json.items ?? []
      for (const item of items) {
        const m = item.media?.m
        if (m === undefined) continue
        const bigger = m.replace(/_m\.jpg$/, '_b.jpg')
        out.push({
          url: bigger,
          source: 'flickr',
          host: inferHostFromUrl(bigger),
          expectedFormat: 'jpeg',
        })
      }
    } catch {
      // continue to next tag
    }
  }
  return out.slice(0, count)
}

function gatherIconLibs(count: number): GatheredUrl[] {
  const iconNames = [
    'home', 'user', 'search', 'settings', 'mail',
    'phone', 'heart', 'star', 'menu', 'close',
    'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'check',
    'plus', 'minus', 'edit', 'trash', 'download',
    'upload', 'cloud', 'folder', 'file', 'image',
    'bell', 'calendar', 'clock', 'map', 'lock',
    'unlock', 'eye', 'camera', 'film', 'video',
    'printer', 'book', 'tag', 'link', 'share',
    'copy', 'paste', 'save', 'repeat', 'shuffle',
  ]
  const libs: Array<(name: string) => string | null> = [
    (n) => `https://unpkg.com/lucide-static@latest/icons/${n}.svg`,
    (n) => `https://unpkg.com/feather-icons@latest/dist/icons/${n}.svg`,
    (n) => `https://unpkg.com/@material-symbols/svg-400@latest/outlined/${n}.svg`,
    (n) => n === 'edit' ? null : `https://unpkg.com/heroicons@latest/24/outline/${n}.svg`,
  ]
  const out: GatheredUrl[] = []
  for (const lib of libs) {
    for (const name of iconNames) {
      const url = lib(name)
      if (url === null) continue
      out.push({
        url,
        source: 'iconlib',
        host: inferHostFromUrl(url),
        expectedFormat: 'svg',
      })
      if (out.length >= count) return out
    }
  }
  return out
}

// --- Modern-format sample gatherer ---
//
// AVIF and HEIC are rare in product CDNs and Wikimedia's random pool.
// Point directly at public conformance / sample repos so we actually
// have enough URLs to produce a distribution. Samples deliberately
// span encoder profiles (8bpc / 10bpc / 12bpc, 420 / 422 / 444,
// monochrome, odd dims, rotation metadata, grid variants) — those
// are the settings most likely to push the ispe box past the first
// few hundred bytes.

type GitHubContent = { name: string; download_url: string | null; type: string }

async function listGitHubRepoFiles(
  owner: string,
  repo: string,
  path: string,
  extFilter: string,
): Promise<string[]> {
  // Hit the contents API. `master` or `main` is resolved automatically.
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const res = await fetch(api, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
    signal: shutdownSignal,
  })
  if (!res.ok) return []
  const entries = (await res.json()) as GitHubContent[]
  const out: string[] = []
  for (const e of entries) {
    if (e.type !== 'file') continue
    if (!e.name.toLowerCase().endsWith(extFilter)) continue
    if (e.download_url !== null) out.push(e.download_url)
  }
  return out
}

async function gatherModernFormatSamples(): Promise<GatheredUrl[]> {
  const out: GatheredUrl[] = []
  // link-u/avif-sample-images has ~100 AVIFs spanning encoder profiles.
  const linkuAvifs = await listGitHubRepoFiles('link-u', 'avif-sample-images', '', '.avif').catch(() => [])
  for (const url of linkuAvifs) {
    out.push({ url, source: 'modern', host: 'link-u/avif-sample-images', expectedFormat: 'avif' })
  }
  // nokiatech/heif ships an HEIC sample set on gh-pages.
  const nokiaHeics = await listGitHubRepoFiles('nokiatech', 'heif', 'content/images', '.heic').catch(() => [])
  // The gh-pages branch needs an explicit ref query — fall back to
  // the known-good raw URL prefix if the API returned nothing.
  const heicUrls = nokiaHeics.length > 0 ? nokiaHeics : [
    'https://raw.githubusercontent.com/nokiatech/heif/gh-pages/content/images/autumn_1440x960.heic',
    'https://raw.githubusercontent.com/nokiatech/heif/gh-pages/content/images/season_collection_1440x960.heic',
    'https://raw.githubusercontent.com/nokiatech/heif/gh-pages/content/images/old_bridge_1440x960.heic',
    'https://raw.githubusercontent.com/nokiatech/heif/gh-pages/content/images/winter_1440x960.heic',
  ]
  for (const url of heicUrls) {
    out.push({ url, source: 'modern', host: inferHostFromUrl(url), expectedFormat: 'heic' })
  }
  return out
}

// --- Parquet gatherer ---

// Candidate image-URL columns in priority order. Arrays first — they
// give many URLs per row, so a small SAMPLE yields diverse CDN paths.
// Scalar columns are fallback when arrays aren't present.
const PARQUET_COLUMN_CANDIDATES: ReadonlyArray<{ name: string; preferArray: boolean }> = [
  { name: 'images', preferArray: true },
  { name: 'image_urls', preferArray: true },
  { name: 'image_slider', preferArray: true },
  { name: 'image', preferArray: true },    // lazada has image VARCHAR[], luxury has image VARCHAR
  { name: 'main_image', preferArray: false },
  { name: 'primary_image', preferArray: false },
  { name: 'image_url', preferArray: false },
  { name: 'thumbnail', preferArray: false },
]

type ParquetColumn = { name: string; type: string }

function describeParquet(path: string): ParquetColumn[] {
  const r = spawnSync(
    'duckdb',
    ['-csv', '-noheader', '-c', `DESCRIBE SELECT * FROM '${path}' LIMIT 0;`],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
  if (r.status !== 0) return []
  const cols: ParquetColumn[] = []
  for (const line of r.stdout.split('\n')) {
    if (line.trim() === '') continue
    // Split on first two commas only (type may contain parens/commas when quoted).
    const match = line.match(/^([^,]+),("(?:[^"]|"")*"|[^,]+),/)
    if (match === null) continue
    const name = match[1]!
    let type = match[2]!
    if (type.startsWith('"') && type.endsWith('"')) {
      type = type.slice(1, -1).replace(/""/g, '"')
    }
    cols.push({ name, type })
  }
  return cols
}

function pickImageColumn(cols: readonly ParquetColumn[]): { name: string; isArray: boolean } | null {
  const byName = new Map(cols.map((c) => [c.name, c]))
  for (const candidate of PARQUET_COLUMN_CANDIDATES) {
    const col = byName.get(candidate.name)
    if (col === undefined) continue
    const isArray = col.type.includes('[]')
    return { name: candidate.name, isArray }
  }
  return null
}

function extractUrlsFromParquet(path: string, col: string, isArray: boolean, n: number): string[] {
  // For arrays, UNNEST after sampling N rows. We may get more than N
  // URLs total; cap with LIMIT at the outer layer.
  const quoted = `"${col.replace(/"/g, '""')}"`
  const sql = isArray
    ? `SELECT u FROM (SELECT UNNEST(${quoted}) AS u FROM '${path}' WHERE ${quoted} IS NOT NULL AND array_length(${quoted}) > 0 USING SAMPLE ${n} ROWS) WHERE u IS NOT NULL AND u != '' LIMIT ${n * 4};`
    : `SELECT ${quoted} AS u FROM '${path}' WHERE ${quoted} IS NOT NULL AND ${quoted} != '' USING SAMPLE ${n} ROWS;`
  const r = spawnSync(
    'duckdb',
    ['-csv', '-noheader', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (r.status !== 0) {
    process.stdout.write(`  parquet ${path}: duckdb error: ${r.stderr.slice(0, 200)}\n`)
    return []
  }
  return r.stdout
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed === '') return ''
      // Strip enclosing CSV quotes; DuckDB quotes strings containing commas etc.
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"')
      }
      return trimmed
    })
    .filter((s) => s !== '' && (s.startsWith('http://') || s.startsWith('https://')))
}

function parquetHostLabel(filename: string): string {
  // amazon_products_bd_20251202_202342_1.parquet → amazon_products
  // luxury-2025-02_bd_20251202_214728_1.parquet → luxury-2025-02
  // moynat_products_bd_...            → moynat_products
  return filename.replace(/\.parquet$/, '').split('_bd_')[0] ?? filename
}

function gatherParquet(dir: string, perHostTarget: number): GatheredUrl[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.parquet'))
  } catch (err) {
    process.stdout.write(`  parquet dir ${dir}: ${(err as Error).message}\n`)
    return []
  }
  // One file per host label. If the user has sharded files, this only
  // samples from one shard — that's fine for byte-distribution work.
  const byHost = new Map<string, string>()
  for (const f of files) {
    const host = parquetHostLabel(f)
    if (!byHost.has(host)) byHost.set(host, join(dir, f))
  }
  const out: GatheredUrl[] = []
  for (const [host, path] of byHost) {
    if (shutdownSignal.aborted) break
    const cols = describeParquet(path)
    if (cols.length === 0) {
      process.stdout.write(`  parquet ${host}: DESCRIBE returned no columns\n`)
      continue
    }
    const picked = pickImageColumn(cols)
    if (picked === null) {
      process.stdout.write(`  parquet ${host}: no recognized image column\n`)
      continue
    }
    const urls = extractUrlsFromParquet(path, picked.name, picked.isArray, perHostTarget)
    const capped = urls.slice(0, perHostTarget)
    for (const u of capped) {
      out.push({
        url: u,
        source: 'parquet',
        host: `parquet:${host}`,
        expectedFormat: inferFormatFromUrl(u),
      })
    }
    process.stdout.write(
      `  parquet ${host.padEnd(32)}: col=${picked.name}${picked.isArray ? '[]' : ''} → ${capped.length} URLs\n`,
    )
  }
  return out
}

// --- Modern-format (AVIF / HEIC / HEIF) ispe probe ---
//
// AVIF and HEIC are ISOBMFF containers. Dimensions live in an
// `ispe` box (ImageSpatialExtentsProperty) nested inside
// meta→iprp→ipco. Box layout:
//   [size:4 BE][type='ispe':4][version+flags:4][width:4 BE][height:4 BE]
//
// Walking the full box hierarchy would be ~150 lines. This scanner
// does something cheaper: scan for the 4-byte 'ispe' tag with a
// preceding size field of exactly 20 (the fixed ispe box size). False
// positives in the 4-byte tag are possible in arbitrary bytes, but
// the size-check downstream cuts them to near-zero in practice.
//
// `probeImageBytes` in the library does NOT recognize AVIF/HEIC
// (see probe.ts header). This harness stays standalone so we can
// answer "how many bytes would we need?" without committing to a
// library extension.

function u32beLocal(b: Uint8Array, o: number): number {
  return b[o]! * 0x1000000 + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
}

type IspeResult = { width: number; height: number; ispeOffset: number }

function probeIsobmffIspe(bytes: Uint8Array): IspeResult | null {
  const limit = bytes.length - 16
  for (let i = 4; i <= limit; i++) {
    if (
      bytes[i] === 0x69 && bytes[i + 1] === 0x73 &&
      bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65
    ) {
      // ispe box has fixed length 20 — the 4 bytes preceding the tag
      // must be a big-endian 20. Filters out accidental byte matches.
      if (u32beLocal(bytes, i - 4) !== 20) continue
      const w = u32beLocal(bytes, i + 8)
      const h = u32beLocal(bytes, i + 12)
      if (w > 0 && h > 0 && w < 100_000 && h < 100_000) {
        return { width: w, height: h, ispeOffset: i }
      }
    }
  }
  return null
}

function guessIsobmffFormat(bytes: Uint8Array): ImageFormat {
  // ftyp box starts at offset 0. Major brand at bytes 8–11.
  if (bytes.length < 12) return 'avif'
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
  if (brand === 'avif' || brand === 'avis') return 'avif'
  if (brand === 'heic' || brand === 'heix' || brand === 'mif1' ||
      brand === 'msf1' || brand === 'hevc' || brand === 'heis') return 'heic'
  // Fallback: sniff the ftyp compatible-brands list (starts at byte 16)
  // for 'avif' or 'heic'. Some encoders write mif1 as major + avif in
  // compatible brands.
  const scan = String.fromCharCode(...Array.from(bytes.subarray(12, Math.min(bytes.length, 64))))
  if (scan.includes('avif') || scan.includes('avis')) return 'avif'
  if (scan.includes('heic') || scan.includes('heix') || scan.includes('heis')) return 'heic'
  return 'avif'
}

// --- Measurement ---

const PROBE_WINDOWS: readonly number[] = [
  128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768,
]

type Measurement = {
  url: string
  source: SourceName
  host: string
  expectedFormat: ImageFormat | null
  detectedFormat: ImageFormat | null
  fetchedBytes: number
  bytesNeeded: number | null
  failureReason: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function combinedSignal(signalA: AbortSignal, signalB: AbortSignal): AbortSignal {
  // AbortSignal.any isn't available on all Bun versions we want to support;
  // emulate with a fresh controller.
  const c = new AbortController()
  if (signalA.aborted) c.abort()
  if (signalB.aborted) c.abort()
  signalA.addEventListener('abort', () => c.abort(), { once: true })
  signalB.addEventListener('abort', () => c.abort(), { once: true })
  return c.signal
}

async function fetchWithRetry(
  url: string,
  ceilingBytes: number,
  fetchTimeoutMs: number,
): Promise<Response> {
  const maxAttempts = 4
  let attempt = 0
  for (;;) {
    attempt++
    if (shutdownSignal.aborted) throw new Error('aborted')
    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs)
    const signal = combinedSignal(timeoutSignal, shutdownSignal)
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${ceilingBytes - 1}`, 'user-agent': USER_AGENT },
        redirect: 'follow',
        signal,
      })
      if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 500 * 2 ** (attempt - 1) + Math.random() * 250
        await sleep(wait)
        continue
      }
      return res
    } catch (err) {
      if (shutdownSignal.aborted) throw err
      if (attempt >= maxAttempts) throw err
      await sleep(200 * attempt)
    }
  }
}

async function measureUrl(
  entry: GatheredUrl,
  ceilingBytes: number,
  fetchTimeoutMs: number,
): Promise<Measurement> {
  const m: Measurement = {
    url: entry.url,
    source: entry.source,
    host: entry.host,
    expectedFormat: entry.expectedFormat,
    detectedFormat: null,
    fetchedBytes: 0,
    bytesNeeded: null,
    failureReason: null,
  }
  try {
    const res = await fetchWithRetry(entry.url, ceilingBytes, fetchTimeoutMs)
    if (!res.ok && res.status !== 206) {
      m.failureReason = `http ${res.status}`
      return m
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    m.fetchedBytes = buf.byteLength
    for (const w of PROBE_WINDOWS) {
      if (w > buf.byteLength) break
      const sub = buf.subarray(0, w)
      const probed = probeImageBytes(sub)
      if (probed !== null) {
        m.bytesNeeded = w
        m.detectedFormat = probed.format
        return m
      }
      // ISOBMFF (AVIF/HEIC) fallback — not covered by probeImageBytes.
      const ispe = probeIsobmffIspe(sub)
      if (ispe !== null) {
        m.bytesNeeded = w
        m.detectedFormat = guessIsobmffFormat(buf)
        return m
      }
    }
    const probedFull = probeImageBytes(buf)
    if (probedFull !== null) {
      m.bytesNeeded = buf.byteLength
      m.detectedFormat = probedFull.format
      return m
    }
    const ispeFull = probeIsobmffIspe(buf)
    if (ispeFull !== null) {
      m.bytesNeeded = buf.byteLength
      m.detectedFormat = guessIsobmffFormat(buf)
      return m
    }
    m.failureReason = 'no dims within ceiling'
    return m
  } catch (err) {
    m.failureReason = (err as Error).message.slice(0, 120)
    return m
  }
}

async function runWithConcurrency(
  entries: readonly GatheredUrl[],
  concurrency: number,
  ceilingBytes: number,
  fetchTimeoutMs: number,
  sink: Measurement[],
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  // `sink` is shared mutable — push as we go so partial results survive
  // an abort. We DON'T preallocate a dense array because that would
  // leave undefined holes on early stop.
  let nextIdx = 0
  let done = 0
  async function worker(): Promise<void> {
    for (;;) {
      if (shutdownSignal.aborted) return
      const i = nextIdx++
      if (i >= entries.length) return
      const measurement = await measureUrl(entries[i]!, ceilingBytes, fetchTimeoutMs)
      sink.push(measurement)
      done++
      if (done % 25 === 0 || done === entries.length) onProgress(done, entries.length)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, () => worker())
  await Promise.all(workers)
}

// --- Aggregation ---

type Distribution = {
  n: number
  min: number
  p50: number
  p90: number
  p95: number
  p99: number
  max: number
  mean: number
}

function distribution(samples: readonly number[]): Distribution | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
  let sum = 0
  for (const s of sorted) sum += s
  return {
    n: sorted.length,
    min: sorted[0]!,
    p50: pick(0.5),
    p90: pick(0.9),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  }
}

function histogramByWindow(samples: readonly number[]): Record<string, number> {
  const buckets: Record<string, number> = {}
  for (const w of PROBE_WINDOWS) buckets[String(w)] = 0
  for (const s of samples) {
    const w = PROBE_WINDOWS.find((w) => w >= s) ?? PROBE_WINDOWS[PROBE_WINDOWS.length - 1]!
    buckets[String(w)] = (buckets[String(w)] ?? 0) + 1
  }
  return buckets
}

type FormatReport = {
  distribution: Distribution | null
  histogram: Record<string, number>
  successes: number
  failures: number
  failureReasons: Record<string, number>
}

function aggregateByFormat(measurements: readonly Measurement[]): Record<string, FormatReport> {
  const byFormat: Record<string, Measurement[]> = {}
  for (const m of measurements) {
    const key = m.detectedFormat ?? m.expectedFormat ?? 'unknown'
    ;(byFormat[key] ??= []).push(m)
  }
  const out: Record<string, FormatReport> = {}
  for (const [format, group] of Object.entries(byFormat)) {
    const needed: number[] = []
    for (const m of group) if (m.bytesNeeded !== null) needed.push(m.bytesNeeded)
    const failureReasons: Record<string, number> = {}
    for (const m of group) {
      if (m.failureReason !== null) failureReasons[m.failureReason] = (failureReasons[m.failureReason] ?? 0) + 1
    }
    out[format] = {
      distribution: distribution(needed),
      histogram: histogramByWindow(needed),
      successes: needed.length,
      failures: group.length - needed.length,
      failureReasons,
    }
  }
  return out
}

function aggregateByHost(measurements: readonly Measurement[]): Record<string, FormatReport> {
  const byHost: Record<string, Measurement[]> = {}
  for (const m of measurements) {
    ;(byHost[m.host] ??= []).push(m)
  }
  const out: Record<string, FormatReport> = {}
  for (const [host, group] of Object.entries(byHost)) {
    const needed: number[] = []
    for (const m of group) if (m.bytesNeeded !== null) needed.push(m.bytesNeeded)
    const failureReasons: Record<string, number> = {}
    for (const m of group) {
      if (m.failureReason !== null) failureReasons[m.failureReason] = (failureReasons[m.failureReason] ?? 0) + 1
    }
    out[host] = {
      distribution: distribution(needed),
      histogram: histogramByWindow(needed),
      successes: needed.length,
      failures: group.length - needed.length,
      failureReasons,
    }
  }
  return out
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  process.stdout.write(`=== probe-byte-threshold-corpus ===\n`)
  process.stdout.write(
    `config: sources=[${args.sources.join(',')}] concurrency=${args.concurrency} ceiling=${args.probeCeilingBytes} time-budget=${args.timeBudgetSeconds}s\n`,
  )
  if (args.sources.includes('wikimedia')) {
    const targetStr = Object.entries(args.wikimediaTargets).map(([f, n]) => `${f}:${n}`).join(' ')
    process.stdout.write(`  wikimedia targets: ${targetStr}\n`)
  }
  if (args.sources.includes('parquet')) {
    process.stdout.write(`  parquet dir: ${args.parquetDir} per-host=${args.parquetPerHost}\n`)
  }
  process.stdout.write('\n')

  // Start time budget timer (if set). It races with normal completion;
  // if we finish first, the timer just never fires. .unref() lets the
  // process exit naturally after writeFile if main() is already done.
  if (args.timeBudgetSeconds > 0) {
    setTimeout(
      () => requestShutdown(`time budget ${args.timeBudgetSeconds}s exceeded`),
      args.timeBudgetSeconds * 1000,
    ).unref?.()
  }

  const urls: GatheredUrl[] = []
  const measurements: Measurement[] = []
  const startedAt = performance.now()
  let wikimediaGathered = 0
  let flickrGathered = 0
  let iconGathered = 0
  let parquetGathered = 0
  let modernGathered = 0

  try {
    process.stdout.write(`gathering URLs...\n`)

    // Parquet is synchronous (spawnSync + disk), do it first so network
    // gatherers can run alongside other work if we ever parallelize.
    if (args.sources.includes('parquet') && !shutdownSignal.aborted) {
      const parquet = gatherParquet(args.parquetDir, args.parquetPerHost)
      urls.push(...parquet)
      parquetGathered = parquet.length
      process.stdout.write(`  parquet: gathered ${parquet.length} URLs total\n`)
    }

    // Network gatherers in parallel.
    const netPromises: Array<Promise<GatheredUrl[]>> = []
    if (args.sources.includes('wikimedia') && !shutdownSignal.aborted) {
      netPromises.push(gatherWikimedia(args.wikimediaTargets))
    } else {
      netPromises.push(Promise.resolve([]))
    }
    if (args.sources.includes('flickr') && !shutdownSignal.aborted) {
      netPromises.push(
        gatherFlickr(args.flickrCount).catch((err) => {
          process.stdout.write(`  flickr FAILED: ${(err as Error).message}\n`)
          return [] as GatheredUrl[]
        }),
      )
    } else {
      netPromises.push(Promise.resolve([]))
    }
    const [wikimedia, flickr] = await Promise.all(netPromises)
    urls.push(...wikimedia, ...flickr)
    wikimediaGathered = wikimedia.length
    flickrGathered = flickr.length

    if (args.sources.includes('iconlib') && !shutdownSignal.aborted) {
      const icons = gatherIconLibs(args.iconCount)
      urls.push(...icons)
      iconGathered = icons.length
      process.stdout.write(`  iconlib svg: gathered ${icons.length} URLs\n`)
    }

    if (args.sources.includes('modern') && !shutdownSignal.aborted) {
      const modern = await gatherModernFormatSamples()
      urls.push(...modern)
      modernGathered = modern.length
      process.stdout.write(`  modern (avif/heic): gathered ${modern.length} URLs\n`)
    }

    process.stdout.write(`\ntotal: ${urls.length} URLs to measure\n\n`)

    if (urls.length > 0 && !shutdownSignal.aborted) {
      await runWithConcurrency(
        urls,
        args.concurrency,
        args.probeCeilingBytes,
        args.fetchTimeoutMs,
        measurements,
        (done, total) => {
          const pct = ((done / total) * 100).toFixed(0)
          const elapsed = ((performance.now() - startedAt) / 1000).toFixed(0)
          process.stdout.write(`  ${done}/${total} (${pct}%) [${elapsed}s]\n`)
        },
      )
    }
  } finally {
    const wallMs = performance.now() - startedAt
    const byFormat = aggregateByFormat(measurements)
    const byHost = aggregateByHost(measurements)

    process.stdout.write(`\n=== Results (wall ${(wallMs / 1000).toFixed(1)}s, ${measurements.length} measured) ===\n\n`)
    process.stdout.write(`format   n     p50      p90      p95      p99      max      fail\n`)
    process.stdout.write(`------   ---   ------   ------   ------   ------   ------   ----\n`)
    for (const [format, report] of Object.entries(byFormat)) {
      const d = report.distribution
      const row = d === null
        ? `${format.padEnd(6)}   -     -        -        -        -        -        ${report.failures}`
        : `${format.padEnd(6)}   ${String(d.n).padStart(3)}   ${String(d.p50).padStart(6)}   ${String(d.p90).padStart(6)}   ${String(d.p95).padStart(6)}   ${String(d.p99).padStart(6)}   ${String(d.max).padStart(6)}   ${String(report.failures).padStart(4)}`
      process.stdout.write(`${row}\n`)
    }

    const report = {
      date: new Date().toISOString(),
      runtime: process.versions.bun !== undefined ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
      wallMs,
      aborted: shutdownSignal.aborted,
      abortReason: shutdownSignal.aborted ? 'SIGINT/SIGTERM/time-budget' : null,
      config: {
        sources: args.sources,
        wikimediaTargets: args.wikimediaTargets,
        flickrCount: args.flickrCount,
        iconCount: args.iconCount,
        parquetDir: args.parquetDir,
        parquetPerHost: args.parquetPerHost,
        concurrency: args.concurrency,
        probeCeilingBytes: args.probeCeilingBytes,
        probeWindows: PROBE_WINDOWS,
        timeBudgetSeconds: args.timeBudgetSeconds,
        fetchTimeoutMs: args.fetchTimeoutMs,
      },
      sources: {
        wikimedia: { gathered: wikimediaGathered },
        flickr: { gathered: flickrGathered },
        iconlib: { gathered: iconGathered },
        parquet: { gathered: parquetGathered },
        modern: { gathered: modernGathered },
      },
      byFormat,
      byHost,
      samples: measurements,
    }

    const iso = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = args.out ?? `benchmarks/probe-byte-threshold-${iso}.json`
    try {
      await mkdir('benchmarks', { recursive: true })
      await writeFile(outPath, JSON.stringify(report, null, 2))
      process.stdout.write(`\nwrote ${outPath}\n`)
    } catch (err) {
      process.stderr.write(`\nfailed to write report: ${(err as Error).message}\n`)
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`)
  process.exit(1)
})
