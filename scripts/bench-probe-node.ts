#!/usr/bin/env bun
// Node/Bun-side probe benchmark. Runs the same "N probes × concurrency"
// sweep the browser bench at /bench/probe.html runs, but via the
// DOM-free /core API (`probeImageStream`) against a real URL list.
//
// Usage:
//   # against the local dev server (bun run start on port 3000)
//   bun scripts/bench-probe-node.ts --base http://localhost:3000 --n 500
//
//   # against GH Pages (or any public host)
//   bun scripts/bench-probe-node.ts \
//     --base https://somnai-dreams.github.io/preimage \
//     --n 500 --c 50,100,200
//
// Writes a JSON report to stdout (or `--out path.json`) in the same
// shape as /bench/probe.html saves, so a run can sit next to the
// browser runs in `benchmarks/`.

import { writeFile } from 'node:fs/promises'
import { probeImageStream } from '../packages/preimage/dist/core.js'

type Strategy = 'stream' | 'range'

type Args = {
  base: string
  n: number
  concurrencies: number[]
  strategies: Strategy[]
  rangeBytes: number
  networkLabel: string | null
  out: string | null
  photosPath: string
  photoCount: number
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    base: 'http://localhost:3000',
    n: 500,
    concurrencies: [6, 20, 50, 100, 200],
    strategies: ['stream'],
    rangeBytes: 4096,
    networkLabel: null,
    out: null,
    photosPath: '/assets/demos/photos',
    photoCount: 34,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--base') args.base = argv[++i]!
    else if (a === '--n') args.n = Number(argv[++i])
    else if (a === '--c') args.concurrencies = argv[++i]!.split(',').map((s) => Number(s))
    else if (a === '--strategy' || a === '--strategies') {
      const raw = argv[++i]!
      const list = raw.split(',').map((s) => s.trim())
      for (const s of list) {
        if (s !== 'stream' && s !== 'range') {
          process.stderr.write(`bench-probe-node: --strategies entries must be 'stream' or 'range', got ${s}\n`)
          process.exit(2)
        }
      }
      args.strategies = list as Strategy[]
    } else if (a === '--range-bytes') args.rangeBytes = Number(argv[++i])
    else if (a === '--network-label') args.networkLabel = argv[++i]!
    else if (a === '--out') args.out = argv[++i]!
    else if (a === '--photos-path') args.photosPath = argv[++i]!
    else if (a === '--photo-count') args.photoCount = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'Usage: bun scripts/bench-probe-node.ts [options]',
          '',
          '  --base URL                  origin to probe against (default localhost:3000)',
          '  --n N                       number of probes (default 500)',
          '  --c 6,20,50,100,200         comma-separated concurrency sweep',
          '  --strategies stream,range   comma-separated strategy sweep (default stream)',
          '  --range-bytes N             bytes to request in range mode (default 4096)',
          '  --network-label LABEL       free-form label like "home gigabit"',
          '  --out path.json             write JSON to file instead of stdout',
          '',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return args
}

function cycledUrls(args: Args, token: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.n; i++) {
    const n = String((i % args.photoCount) + 1).padStart(2, '0')
    out.push(`${args.base}${args.photosPath}/${n}.png?v=${token}-${i}`)
  }
  return out
}

function distribution(samples: readonly number[]): {
  count: number
  min: number
  p50: number
  p95: number
  max: number
  mean: number
} {
  if (samples.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  }
}

async function probeOneStream(url: string): Promise<{ probeMs: number; bytes: number } | null> {
  const tStart = performance.now()
  const controller = new AbortController()
  let probeMs: number | null = null
  let aborted = false
  let bytes = 0
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || response.body === null) return null
    const [forProbe, forCount] = response.body.tee()
    ;(async () => {
      const reader = forCount.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
        }
      } catch {
        // Reader cancelled when we abort; ignore.
      }
    })()
    await probeImageStream(forProbe, {
      onDims: () => {
        probeMs = performance.now() - tStart
        aborted = true
        controller.abort()
      },
    })
  } catch {
    if (!aborted) return null
  }
  return probeMs === null ? null : { probeMs, bytes }
}

async function probeOneRange(
  url: string,
  rangeBytes: number,
): Promise<{ probeMs: number; bytes: number; fellBackTo200: boolean } | null> {
  const tStart = performance.now()
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${rangeBytes - 1}` },
    })
    if (!response.ok && response.status !== 206) return null
    const buf = new Uint8Array(await response.arrayBuffer())
    return {
      probeMs: performance.now() - tStart,
      bytes: buf.byteLength,
      fellBackTo200: response.status === 200,
    }
  } catch {
    return null
  }
}

async function warmupRtt(probeUrl: string, count: number): Promise<number | null> {
  const samples: number[] = []
  for (let i = 0; i < count; i++) {
    const t = performance.now()
    try {
      const r = await fetch(`${probeUrl}?warmup=${Date.now()}-${i}`, { cache: 'no-store' })
      await r.arrayBuffer()
      samples.push(performance.now() - t)
    } catch {
      return null
    }
  }
  if (samples.length === 0) return null
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]!
}

async function runSweep(args: Args, concurrency: number, strategy: Strategy): Promise<{
  totalMs: number
  probeMs: ReturnType<typeof distribution>
  bytesTransferred: number
  throughputProbesPerSec: number
  resolved: number
  errors: number
  rangeFellBackTo200: number
}> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(args, token)

  const t0 = performance.now()
  let idx = 0
  const probes: number[] = []
  let totalBytes = 0
  let errors = 0
  let rangeFellBackTo200 = 0

  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < urls.length) {
      const i = idx++
      const url = urls[i]!
      const r = strategy === 'range'
        ? await probeOneRange(url, args.rangeBytes)
        : await probeOneStream(url)
      if (r === null) {
        errors++
      } else {
        probes.push(r.probeMs)
        totalBytes += r.bytes
        if ('fellBackTo200' in r && r.fellBackTo200) rangeFellBackTo200++
      }
    }
  })
  await Promise.all(workers)
  const totalMs = performance.now() - t0

  return {
    totalMs,
    probeMs: distribution(probes),
    bytesTransferred: totalBytes,
    throughputProbesPerSec: (args.n / totalMs) * 1000,
    resolved: probes.length,
    errors,
    rangeFellBackTo200,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Warmup probe against a tiny known asset to capture network RTT
  // independent of the bench workload. The preimage symbol SVG is
  // ~1KB and ships on every deploy.
  const probeUrl = `${args.base}/assets/preimage-symbol.svg`
  process.stderr.write(`warmup ${probeUrl} …`)
  const warmupRttMs = await warmupRtt(probeUrl, 5)
  process.stderr.write(`  median rtt ${warmupRttMs?.toFixed(0) ?? '?'}ms\n`)

  const report = {
    bench: 'probe-sweep-node',
    date: new Date().toISOString(),
    runtime: `${process.release.name ?? 'unknown'} ${process.version}`,
    base: args.base,
    n: args.n,
    concurrencies: args.concurrencies,
    strategies: args.strategies,
    rangeBytes: args.strategies.includes('range') ? args.rangeBytes : null,
    network: {
      label: args.networkLabel,
      warmupRttMs,
    },
    sweep: [] as Array<
      { concurrency: number; strategy: Strategy } & Awaited<ReturnType<typeof runSweep>>
    >,
  }

  for (const strategy of args.strategies) {
    for (const c of args.concurrencies) {
      process.stderr.write(`c=${String(c).padStart(3)} ${strategy} …`)
      const result = await runSweep(args, c, strategy)
      report.sweep.push({ strategy, concurrency: c, ...result })
      const fallbackBit = result.rangeFellBackTo200 > 0 ? `  ⚠ ${result.rangeFellBackTo200} 200-fallbacks` : ''
      process.stderr.write(
        `  total=${result.totalMs.toFixed(0)}ms  tp=${result.throughputProbesPerSec.toFixed(0)}/s  probe p50=${result.probeMs.p50.toFixed(0)}ms  p95=${result.probeMs.p95.toFixed(0)}ms  bytes=${(result.bytesTransferred / 1024 / 1024).toFixed(2)}MB  errors=${result.errors}${fallbackBit}\n`,
      )
    }
  }

  const json = JSON.stringify(report, null, 2)
  if (args.out !== null) {
    await writeFile(args.out, json)
    process.stderr.write(`wrote ${args.out}\n`)
  } else {
    process.stdout.write(`${json}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`bench-probe-node: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
