// Compare the latest saved harness outputs against committed baseline
// thresholds. Intended to run at the end of `bun run check:all`, after
// the other harnesses have written their per-run JSON files.
//
// Usage: bun run scripts/benchmark-regression-test.ts

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Op = 'eq' | 'min' | 'max'

type PathCheck = {
  label: string
  path: string
  op: Op
  value: unknown
}

type EveryCheck = {
  label: string
  arrayPath: string
  path: string
  op: Op
  value: unknown
}

type BenchBaseline = {
  bench: string
  pattern: string
  checks?: PathCheck[]
  every?: EveryCheck[]
}

type BaselineFile = {
  version: number
  benches: BenchBaseline[]
}

type Check =
  | { ok: true; case: string; notes?: string }
  | { ok: false; case: string; reason: string }

type LoadedBench = {
  baseline: BenchBaseline
  path: string
  data: unknown
}

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const benchmarksDir = resolve(repoRoot, 'benchmarks')
const baselinePath = resolve(benchmarksDir, 'baselines/check-all-regression-baselines.json')

const results: Check[] = []

function pass(label: string, notes?: string): void {
  results.push(notes !== undefined ? { ok: true, case: label, notes } : { ok: true, case: label })
}

function fail(label: string, reason: string): void {
  results.push({ ok: false, case: label, reason })
}

function patternParts(pattern: string): { prefix: string; suffix: string } {
  const star = pattern.indexOf('*')
  if (star === -1) return { prefix: pattern, suffix: '' }
  return { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1) }
}

async function latestMatching(pattern: string): Promise<string | null> {
  const { prefix, suffix } = patternParts(pattern)
  const entries = await readdir(benchmarksDir)
  const matches = entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix))
  if (matches.length === 0) return null
  const ranked = await Promise.all(
    matches.map(async (entry) => {
      const path = join(benchmarksDir, entry)
      const info = await stat(path)
      return { path, mtimeMs: info.mtimeMs }
    }),
  )
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return ranked[0]!.path
}

async function loadBaseline(): Promise<BaselineFile> {
  const raw = await readFile(baselinePath, 'utf8')
  const parsed = JSON.parse(raw) as BaselineFile
  if (parsed.version !== 1) throw new Error(`Unsupported benchmark baseline version ${parsed.version}.`)
  return parsed
}

async function loadLatestBenches(baseline: BaselineFile): Promise<LoadedBench[]> {
  const loaded: LoadedBench[] = []
  for (const bench of baseline.benches) {
    const latest = await latestMatching(bench.pattern)
    if (latest === null) {
      fail(`benchmark-regression/${bench.bench}/file`, `no file matched ${bench.pattern}`)
      continue
    }
    const data = JSON.parse(await readFile(latest, 'utf8')) as unknown
    pass(`benchmark-regression/${bench.bench}/file`, latest.replace(`${repoRoot}/`, ''))
    loaded.push({ baseline: bench, path: latest, data })
  }
  return loaded
}

function parseSelector(raw: string): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=')
    if (key === undefined || value === undefined) throw new Error(`Invalid selector [${raw}]`)
    const numeric = Number(value)
    out[key] = Number.isFinite(numeric) && value.trim() !== '' ? numeric : value
  }
  return out
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return a === b
}

function selectorMatches(item: unknown, selector: Record<string, string | number>): boolean {
  if (item === null || typeof item !== 'object') return false
  const record = item as Record<string, unknown>
  for (const [key, value] of Object.entries(selector)) {
    if (!valuesEqual(record[key], value)) return false
  }
  return true
}

function getPath(root: unknown, path: string): unknown {
  let current = root
  for (const segment of path.split('.')) {
    if (segment === 'length') {
      if (!Array.isArray(current) && typeof current !== 'string') return undefined
      current = current.length
      continue
    }
    const match = segment.match(/^([A-Za-z_$][\w$]*)(?:\[(.+)\])?$/)
    if (match === null) return undefined
    const key = match[1]!
    const selectorRaw = match[2]
    if (current === null || typeof current !== 'object') return undefined
    const next = (current as Record<string, unknown>)[key]
    if (selectorRaw === undefined) {
      current = next
      continue
    }
    if (!Array.isArray(next)) return undefined
    const selector = parseSelector(selectorRaw)
    current = next.find((item) => selectorMatches(item, selector))
  }
  return current
}

function compare(actual: unknown, op: Op, expected: unknown): boolean {
  if (op === 'eq') return valuesEqual(actual, expected)
  if (typeof actual !== 'number' || typeof expected !== 'number') return false
  if (op === 'min') return actual >= expected
  return actual <= expected
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

function runPathCheck(bench: string, data: unknown, check: PathCheck): void {
  const actual = getPath(data, check.path)
  if (actual === undefined) {
    fail(`benchmark-regression/${bench}/${check.label}`, `missing path ${check.path}`)
    return
  }
  if (!compare(actual, check.op, check.value)) {
    fail(
      `benchmark-regression/${bench}/${check.label}`,
      `${check.path}=${describeValue(actual)} expected ${check.op} ${describeValue(check.value)}`,
    )
    return
  }
  pass(`benchmark-regression/${bench}/${check.label}`, `${check.path}=${describeValue(actual)}`)
}

function runEveryCheck(bench: string, data: unknown, check: EveryCheck): void {
  const value = getPath(data, check.arrayPath)
  if (!Array.isArray(value)) {
    fail(`benchmark-regression/${bench}/${check.label}`, `missing array ${check.arrayPath}`)
    return
  }
  for (let i = 0; i < value.length; i++) {
    const actual = getPath(value[i], check.path)
    if (!compare(actual, check.op, check.value)) {
      fail(
        `benchmark-regression/${bench}/${check.label}`,
        `${check.arrayPath}[${i}].${check.path}=${describeValue(actual)} expected ${check.op} ${describeValue(check.value)}`,
      )
      return
    }
  }
  pass(`benchmark-regression/${bench}/${check.label}`, `${value.length} entries`)
}

function checkLoadedBench(loaded: LoadedBench): void {
  for (const check of loaded.baseline.checks ?? []) {
    runPathCheck(loaded.baseline.bench, loaded.data, check)
  }
  for (const check of loaded.baseline.every ?? []) {
    runEveryCheck(loaded.baseline.bench, loaded.data, check)
  }
}

async function main(): Promise<void> {
  const t0 = performance.now()
  const baseline = await loadBaseline()
  const loaded = await loadLatestBenches(baseline)
  for (const bench of loaded) checkLoadedBench(bench)
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== benchmark-regression-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const outDir = benchmarksDir
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `benchmark-regression-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'benchmark-regression',
        date: new Date().toISOString(),
        baseline: baselinePath.replace(`${repoRoot}/`, ''),
        wallMs,
        total,
        passed,
        failed: failed.length,
        checkedFiles: loaded.map((entry) => ({
          bench: entry.baseline.bench,
          path: entry.path.replace(`${repoRoot}/`, ''),
        })),
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
