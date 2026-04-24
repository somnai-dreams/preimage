// Run every regression harness in sequence. Used as the
// `bun run check:all` entrypoint so one command answers "is
// everything still green?" Outputs one line per harness with
// pass/fail count + wall time; exits non-zero on any failure so
// this slots into CI unchanged. Network-heavy sweeps stay out of
// the default list unless explicitly enabled.
//
// Harnesses live in scripts/ and save their own JSON summaries to
// benchmarks/. This runner invokes them as subprocesses and
// aggregates the headline result.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))

const HARNESSES: Array<{ name: string; script: string; args?: string[] }> = [
  { name: 'coverage-matrix', script: 'coverage-matrix-test.ts' },
  { name: 'parser-robustness', script: 'parser-robustness-test.ts' },
  { name: 'packer-sweep', script: 'packer-sweep.ts' },
  { name: 'url-pattern-corpus', script: 'url-pattern-corpus.ts' },
  { name: 'orientation-corpus', script: 'orientation-corpus.ts' },
  { name: 'manifest-build', script: 'manifest-build-test.ts' },
  { name: 'stream-probe', script: 'stream-probe-test.ts' },
  { name: 'prepare-strategy', script: 'prepare-strategy-test.ts' },
  { name: 'prepare-queue', script: 'prepare-queue-test.ts' },
  { name: 'decode-pool', script: 'decode-pool-test.ts' },
  { name: 'pretext-integration', script: 'pretext-integration-test.ts' },
  { name: 'virtual-pool', script: 'virtual-pool-test.ts' },
  { name: 'loading-gallery', script: 'loading-gallery-test.ts' },
  { name: 'predict', script: 'predict-test.ts' },
  { name: 'fit-analysis', script: 'fit-analysis-test.ts' },
  { name: 'parser-fuzz', script: 'parser-fuzz.ts' },
  { name: 'benchmark-regression', script: 'benchmark-regression-test.ts' },
]

const REMOTE_LOADING_HARNESS = {
  name: 'remote-loading',
  script: 'remote-loading-strategy-bench.ts',
  args: ['--n', '8', '--strategies', 'visible-first,queued', '--scroll-ms', '600', '--timeout-ms', '30000'],
}

if (process.env.PREIMAGE_CHECK_REMOTE_LOADING === '1') {
  const regression = HARNESSES.pop()
  HARNESSES.push(REMOTE_LOADING_HARNESS)
  if (regression !== undefined) HARNESSES.push(regression)
}

type HarnessResult = {
  name: string
  script: string
  wallMs: number
  exitCode: number
  stdoutSummary: string
}

async function runHarness(name: string, scriptPath: string, args: string[] = []): Promise<HarnessResult> {
  const t0 = performance.now()
  return await new Promise((resolveFn) => {
    const child = spawn('bun', ['run', scriptPath, ...args], {
      cwd: resolve(scriptDir, '..'),
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      const wallMs = performance.now() - t0
      // Grab the first line matching "=== <name>: N/N passed" if present.
      const summaryMatch = stdout.match(/^=== .+?: (\d+)\/(\d+) passed in/m)
      const stdoutSummary = summaryMatch !== null ? summaryMatch[0] : stderr.slice(0, 200) || '(no summary)'
      resolveFn({
        name,
        script: scriptPath,
        wallMs,
        exitCode: code ?? 0,
        stdoutSummary,
      })
    })
  })
}

async function main(): Promise<void> {
  process.stdout.write(`=== Running ${HARNESSES.length} harnesses ===\n\n`)
  const results: HarnessResult[] = []
  for (const { name, script, args } of HARNESSES) {
    const result = await runHarness(name, `scripts/${script}`, args)
    results.push(result)
    const marker = result.exitCode === 0 ? '✓' : '✗'
    process.stdout.write(
      `  ${marker} ${name.padEnd(22)} ${result.wallMs.toFixed(0).padStart(5)}ms  ${result.stdoutSummary}\n`,
    )
  }

  const failed = results.filter((r) => r.exitCode !== 0)
  process.stdout.write(`\n=== ${results.length - failed.length}/${results.length} harnesses passed ===\n`)
  if (failed.length > 0) {
    for (const f of failed) {
      process.stdout.write(`  ✗ ${f.name} (exit ${f.exitCode})\n`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
