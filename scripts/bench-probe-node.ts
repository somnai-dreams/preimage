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

type Args = {
  base: string
  n: number
  concurrencies: number[]
  out: string | null
  photosPath: string
  photoCount: number
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    base: 'http://localhost:3000',
    n: 500,
    concurrencies: [6, 20, 50, 100, 200],
    out: null,
    photosPath: '/assets/demos/photos',
    photoCount: 34,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--base') args.base = argv[++i]!
    else if (a === '--n') args.n = Number(argv[++i])
    else if (a === '--c') args.concurrencies = argv[++i]!.split(',').map((s) => Number(s))
    else if (a === '--out') args.out = argv[++i]!
    else if (a === '--photos-path') args.photosPath = argv[++i]!
    else if (a === '--photo-count') args.photoCount = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'bun scripts/bench-probe-node.ts [--base URL] [--n N] [--c 6,20,50,100,200] [--out path.json]\n',
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

async function probeOne(url: string): Promise<{ probeMs: number; bytes: number } | null> {
  const tStart = performance.now()
  const controller = new AbortController()
  let probeMs: number | null = null
  let aborted = false
  let bytes = 0
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || response.body === null) return null
    // Tee the body to count bytes received (since transferSize isn't
    // exposed without server Timing-Allow-Origin).
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
  } catch (err) {
    if (!aborted) return null
  }
  return probeMs === null ? null : { probeMs, bytes }
}

async function runSweep(args: Args, concurrency: number): Promise<{
  totalMs: number
  probeMs: ReturnType<typeof distribution>
  bytesTransferred: number
  throughputProbesPerSec: number
  resolved: number
  errors: number
}> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const urls = cycledUrls(args, token)

  const t0 = performance.now()
  let idx = 0
  const probes: number[] = []
  let totalBytes = 0
  let errors = 0

  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < urls.length) {
      const i = idx++
      const r = await probeOne(urls[i]!)
      if (r === null) {
        errors++
      } else {
        probes.push(r.probeMs)
        totalBytes += r.bytes
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
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const report = {
    bench: 'probe-concurrency-node',
    date: new Date().toISOString(),
    runtime: `${process.release.name ?? 'unknown'} ${process.version}`,
    base: args.base,
    n: args.n,
    concurrencies: args.concurrencies,
    sweep: [] as Array<{ concurrency: number } & Awaited<ReturnType<typeof runSweep>>>,
  }

  for (const c of args.concurrencies) {
    process.stderr.write(`c=${String(c).padStart(3)} …`)
    const result = await runSweep(args, c)
    report.sweep.push({ concurrency: c, ...result })
    process.stderr.write(
      `  total=${result.totalMs.toFixed(0)}ms  tp=${result.throughputProbesPerSec.toFixed(0)}/s  probe p50=${result.probeMs.p50.toFixed(0)}ms  p95=${result.probeMs.p95.toFixed(0)}ms  bytes=${(result.bytesTransferred / 1024 / 1024).toFixed(2)}MB  errors=${result.errors}\n`,
    )
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
