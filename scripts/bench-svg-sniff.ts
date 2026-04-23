#!/usr/bin/env bun
// Micro-bench: how expensive is it to decide "is this URL an SVG?" before
// issuing a range request. Motivation: we want to size the range header
// smaller for raster formats (~2-3KB) and only pay 4KB for SVG, whose
// opening <svg ...> tag can sit past 2KB. Cost of the upfront sniff
// must be negligible next to one HTTP roundtrip (~10-100ms), but we
// should know the actual number — especially for the "500 off-screen
// tiles being prepared at once" case.
//
// Compares four strategies against a realistic URL mix (bare paths,
// query strings, hashes, full origins, both .svg and non-.svg):
//   1. endsWith         — string.endsWith('.svg') (wrong for ?v=1 tails)
//   2. regex            — /\.svg(\?|#|$)/i.test(url)
//   3. manualIndexOf    — split on '?' / '#' manually, compare tail
//   4. urlPathname      — new URL(src).pathname.endsWith('.svg')
//
// Prints per-strategy ns/op and total ms for n=500 (one first-screen
// pass). Writes a JSON summary to benchmarks/.
//
// Usage:
//   bun scripts/bench-svg-sniff.ts
//   bun scripts/bench-svg-sniff.ts --iters 2000000

import { writeFile } from 'node:fs/promises'

type Args = { iters: number; out: string | null }

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { iters: 1_000_000, out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--iters') args.iters = Number(argv[++i])
    else if (a === '--out') args.out = argv[++i]!
  }
  return args
}

// Representative URL shapes. Mix of hits (.svg) and misses (.png/.jpg/.webp),
// with and without query strings, hashes, and full origins.
const CORPUS: readonly string[] = [
  '/photo.jpg',
  '/photo.png',
  '/icons/logo.svg',
  '/icons/logo.svg?v=42',
  '/hero.webp',
  '/thumbs/11.jpg?w=400&h=300',
  '/thumbs/11.jpg#crop-a',
  'https://cdn.example.com/assets/diagram.svg',
  'https://cdn.example.com/assets/diagram.svg?cache=1',
  'https://cdn.example.com/path/deep/folder/photo.png?v=12345&foo=bar',
  'https://images.example.com/seed/abc/800/600',
  'https://example.com/avatar',
  '/spritesheet.svg#icon-home',
  '/uploads/2026/04/scan-0042.png',
  '/uploads/2026/04/scan-0042.svg',
  'https://host.example/a/b/c/d/e/f/g/h/i/file.jpg?x=1&y=2&z=3&foo=bar&baz=qux',
]

type Sniff = (src: string) => boolean

const strategies: Array<{ name: string; fn: Sniff }> = [
  {
    name: 'endsWith',
    fn: (src) => src.endsWith('.svg'),
  },
  {
    name: 'regex',
    fn: (src) => /\.svg(\?|#|$)/i.test(src),
  },
  {
    name: 'manualIndexOf',
    fn: (src) => {
      const q = src.indexOf('?')
      const h = src.indexOf('#')
      const cutCandidates = [q, h].filter((i) => i >= 0)
      const cut = cutCandidates.length === 0 ? src.length : Math.min(...cutCandidates)
      if (cut < 4) return false
      return (
        src.charCodeAt(cut - 4) === 0x2e /* . */ &&
        (src.charCodeAt(cut - 3) | 0x20) === 0x73 /* s */ &&
        (src.charCodeAt(cut - 2) | 0x20) === 0x76 /* v */ &&
        (src.charCodeAt(cut - 1) | 0x20) === 0x67 /* g */
      )
    },
  },
  {
    name: 'urlPathname',
    fn: (src) => {
      try {
        return new URL(src, 'http://x').pathname.endsWith('.svg')
      } catch {
        return false
      }
    },
  },
]

function verifyAgreement(): void {
  const reference = strategies[0]!
  const disagreements: Array<{ url: string; results: Record<string, boolean> }> = []
  for (const url of CORPUS) {
    const results: Record<string, boolean> = {}
    for (const s of strategies) results[s.name] = s.fn(url)
    const anyTrue = Object.values(results).some((v) => v)
    const anyFalse = Object.values(results).some((v) => !v)
    if (anyTrue && anyFalse) disagreements.push({ url, results })
  }
  if (disagreements.length > 0) {
    process.stdout.write(`note: strategies disagree on ${disagreements.length} URLs (expected — .svg?v=1 tails):\n`)
    for (const d of disagreements) {
      process.stdout.write(`  ${d.url}\n`)
      for (const [k, v] of Object.entries(d.results)) {
        process.stdout.write(`    ${k.padEnd(16)} → ${v}\n`)
      }
    }
    process.stdout.write('\n')
  }
  void reference
}

function measure(fn: Sniff, iters: number): number {
  // Preload the corpus into a cycled array so we're not paying for % in the hot loop.
  const n = CORPUS.length
  // Warmup
  for (let i = 0; i < 10_000; i++) fn(CORPUS[i % n]!)
  const t0 = performance.now()
  let hits = 0
  for (let i = 0; i < iters; i++) {
    if (fn(CORPUS[i % n]!)) hits++
  }
  const t1 = performance.now()
  if (hits < 0) process.stdout.write('unreachable\n') // prevent DCE
  return t1 - t0
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  process.stdout.write(`=== bench-svg-sniff: ${args.iters.toLocaleString()} iters over ${CORPUS.length} URLs ===\n\n`)

  verifyAgreement()

  type Row = { name: string; totalMs: number; nsPerOp: number; msPer500: number }
  const rows: Row[] = []
  for (const s of strategies) {
    const totalMs = measure(s.fn, args.iters)
    const nsPerOp = (totalMs * 1_000_000) / args.iters
    const msPer500 = (nsPerOp * 500) / 1_000_000
    rows.push({ name: s.name, totalMs, nsPerOp, msPer500 })
  }

  // Print ranked fastest → slowest
  rows.sort((a, b) => a.nsPerOp - b.nsPerOp)
  process.stdout.write('strategy          ns/op      total ms    per-500-URLs (µs)\n')
  process.stdout.write('---------------   --------   ---------   -----------------\n')
  for (const r of rows) {
    process.stdout.write(
      `${r.name.padEnd(15)}   ${r.nsPerOp.toFixed(1).padStart(8)}   ${r.totalMs.toFixed(1).padStart(9)}   ${(r.msPer500 * 1000).toFixed(1).padStart(17)}\n`,
    )
  }

  const report = {
    date: new Date().toISOString(),
    runtime: `${process.versions.bun !== undefined ? 'bun ' + process.versions.bun : 'node ' + process.versions.node}`,
    iters: args.iters,
    corpusSize: CORPUS.length,
    strategies: rows,
  }

  const outPath = args.out ?? `benchmarks/svg-sniff-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  await writeFile(outPath, JSON.stringify(report, null, 2))
  process.stdout.write(`\nwrote ${outPath}\n`)
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
