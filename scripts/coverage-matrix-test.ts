// Public coverage matrix. This is a meta-regression test: every
// public value export and package subpath must be assigned to at least
// one automated regression or benchmark surface.
//
// Usage: bun run scripts/coverage-matrix-test.ts

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type CoverageArea = {
  area: string
  exports: string[]
  ciScripts: string[]
  benchScripts?: string[]
  benchPages?: string[]
  notes: string
}

type Check =
  | { ok: true; case: string; notes?: string }
  | { ok: false; case: string; reason: string }

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(scriptDir, '..')

const PUBLIC_VALUE_SOURCES = [
  'packages/preimage/src/index.ts',
  'packages/preimage/src/core.ts',
  'packages/preimage/src/manifest.ts',
  'packages/preimage/src/virtual.ts',
  'packages/preimage/src/loading.ts',
  'packages/preimage/src/predict.ts',
  'packages/preimage/src/pretext.ts',
  'packages/layout-algebra/src/index.ts',
]

const EXPECTED_PACKAGE_EXPORTS: Record<string, string[]> = {
  'packages/preimage/package.json': [
    '.',
    './pretext',
    './core',
    './manifest',
    './virtual',
    './loading',
    './predict',
  ],
  'packages/layout-algebra/package.json': ['.'],
}

const COVERAGE: CoverageArea[] = [
  {
    area: 'single image measurement and layout',
    exports: [
      'prepare',
      'prepareSync',
      'preparedFromMeasurement',
      'layout',
      'layoutForWidth',
      'layoutForHeight',
      'measureAspect',
      'measureNaturalSize',
      'getMeasurement',
      'getElement',
      'disposePreparedImage',
      'getOriginStrategy',
      'clearOriginStrategyCache',
      'DEFAULT_RANGE_BYTES_BY_FORMAT',
    ],
    ciScripts: ['prepare-strategy-test.ts', 'stream-probe-test.ts'],
    benchScripts: ['bench-probe-node.ts', 'remote-loading-strategy-bench.ts'],
    benchPages: ['probe.html', 'range-sizing.html', 'compare.html'],
    notes: 'prepare strategies, URL/cache shortcuts, layout helpers, disposal, origin strategy, byte budgets',
  },
  {
    area: 'byte probing and format parsing',
    exports: ['probeImageBytes', 'probeImageStream', 'MAX_HEADER_BYTES'],
    ciScripts: ['parser-robustness-test.ts', 'parser-fuzz.ts', 'stream-probe-test.ts'],
    benchScripts: ['probe-byte-threshold-corpus.ts', 'bench-probe-node.ts'],
    benchPages: ['probe.html', 'range-sizing.html'],
    notes: 'header parsers, streaming parser, fuzz cases, range byte thresholds',
  },
  {
    area: 'source analysis and measurement cache',
    exports: [
      'analyzeImage',
      'getCachedAnalysis',
      'clearAnalysisCaches',
      'detectImageFormat',
      'detectSourceKind',
      'normalizeSrc',
      'peekImageMeasurement',
      'recordKnownMeasurement',
      'measureFromSvgText',
      'clearMeasurementCaches',
      'listCachedMeasurements',
      'clearCache',
    ],
    ciScripts: ['parser-robustness-test.ts', 'url-pattern-corpus.ts', 'prepare-strategy-test.ts'],
    benchPages: ['probe.html'],
    notes: 'source kind/format detection, normalized cache keys, SVG text measurement, global cache clearing',
  },
  {
    area: 'URL dimension parsers',
    exports: [
      'registerUrlDimensionParser',
      'registerCommonUrlDimensionParsers',
      'clearUrlDimensionParsers',
      'parseUrlDimensions',
      'queryParamDimensionParser',
      'cloudinaryParser',
      'shopifyParser',
      'picsumParser',
      'unsplashParser',
    ],
    ciScripts: ['url-pattern-corpus.ts', 'prepare-strategy-test.ts'],
    notes: 'built-in vendor parsers, parser registration, malformed URL tolerance',
  },
  {
    area: 'orientation handling',
    exports: [
      'applyOrientationToSize',
      'describeOrientation',
      'isValidOrientationCode',
      'readExifOrientation',
      'computeItemOrientationLevels',
    ],
    ciScripts: ['orientation-corpus.ts', 'prepare-strategy-test.ts'],
    notes: 'EXIF parsing, display-size transform, image-item orientation levels',
  },
  {
    area: 'object fitting',
    exports: ['fitRect'],
    ciScripts: ['fit-analysis-test.ts', 'pretext-integration-test.ts'],
    benchPages: ['compare.html'],
    notes: 'contain/cover/fill/none/scale-down geometry and pretext float sizing',
  },
  {
    area: 'prepare scheduling and decode cache',
    exports: ['PrepareQueue', 'pickAdaptiveConcurrency', 'DecodePool'],
    ciScripts: ['prepare-queue-test.ts', 'decode-pool-test.ts'],
    benchPages: ['probe.html', 'range-sizing.html'],
    notes: 'queue dedupe, boosting/deprioritization, adaptive concurrency, decode clear/cache behavior',
  },
  {
    area: 'build-time manifest',
    exports: ['buildManifest'],
    ciScripts: ['manifest-build-test.ts'],
    notes: 'recursive file walk, supported default extensions, SVG/raster probing, skip handling',
  },
  {
    area: 'layout algebra',
    exports: [
      'packShortestColumn',
      'shortestColumnCursor',
      'packJustifiedRows',
      'justifiedRowCursor',
      'visibleIndices',
      'estimateFirstScreenCount',
    ],
    ciScripts: ['packer-sweep.ts'],
    benchPages: ['packing.html', 'first-screen.html'],
    notes: 'batch/cursor equivalence, deterministic placement, pathologies, first-screen estimates, scaling',
  },
  {
    area: 'virtualized tile pool',
    exports: ['createVirtualTilePool'],
    ciScripts: ['virtual-pool-test.ts', 'loading-gallery-test.ts'],
    benchPages: ['virtual-scroll.html'],
    notes: 'DOM recycling, directional overscan, content offset, destroy cleanup, indirect gallery integration',
  },
  {
    area: 'gallery loading orchestration',
    exports: ['loadGallery'],
    ciScripts: ['loading-gallery-test.ts'],
    benchScripts: ['remote-loading-strategy-bench.ts'],
    benchPages: ['loading-pattern.html'],
    notes: 'loading modes, URL-order placement, destroy settling, remote visible-image scheduling metrics',
  },
  {
    area: 'scroll prediction',
    exports: [
      'createScrollObserver',
      'createStationaryPredictor',
      'createLinearPredictor',
      'createMomentumPredictor',
      'evaluatePrediction',
      'velocityPxPerMs',
      'accelerationPxPerMs2',
    ],
    ciScripts: ['predict-test.ts'],
    benchPages: ['predict.html'],
    notes: 'observer lifecycle, stationary/linear/momentum baselines, evaluation metrics',
  },
  {
    area: 'pretext integration',
    exports: [
      'solveFloat',
      'flowColumnWithFloats',
      'measureColumnFlow',
      'inlineImage',
      'inlineImageItem',
      'resolveMixedInlineItems',
      'isInlineImageItem',
      'PREIMAGE_INLINE_MARKER',
    ],
    ciScripts: ['pretext-integration-test.ts'],
    notes: 'float sizing, variable-width text flow, inline image sentinel, mixed inline resolution',
  },
]

const results: Check[] = []

function pass(label: string, notes?: string): void {
  results.push(notes !== undefined ? { ok: true, case: label, notes } : { ok: true, case: label })
}

function fail(label: string, reason: string): void {
  results.push({ ok: false, case: label, reason })
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function parseExportBlock(block: string): string[] {
  return block
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith('type '))
    .map((part) => {
      const alias = part.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      if (alias !== null) return alias[1]!
      const match = part.match(/^([A-Za-z_$][\w$]*)/)
      return match?.[1] ?? ''
    })
    .filter(Boolean)
}

async function exportedValuesFrom(relativePath: string): Promise<Set<string>> {
  const source = stripComments(await readFile(resolve(repoRoot, relativePath), 'utf8'))
  const names = new Set<string>()
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!)
  for (const match of source.matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!)
  for (const match of source.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!)
  for (const match of source.matchAll(/\bexport\s*{([\s\S]*?)}(?:\s+from\s+['"][^'"]+['"])?/g)) {
    for (const name of parseExportBlock(match[1]!)) names.add(name)
  }
  return names
}

async function allPublicValues(): Promise<Set<string>> {
  const values = new Set<string>()
  for (const source of PUBLIC_VALUE_SOURCES) {
    const exported = await exportedValuesFrom(source)
    for (const name of exported) values.add(name)
  }
  return values
}

function coveredValues(): Set<string> {
  const values = new Set<string>()
  for (const area of COVERAGE) {
    for (const name of area.exports) values.add(name)
  }
  return values
}

function assertNoDuplicateCoverage(): void {
  const seen = new Map<string, string>()
  for (const area of COVERAGE) {
    for (const name of area.exports) {
      const prev = seen.get(name)
      if (prev !== undefined) fail(`coverage/duplicate/${name}`, `${prev} and ${area.area}`)
      else seen.set(name, area.area)
    }
  }
  pass('coverage/no-duplicate-export-assignments', `${seen.size} exports`)
}

async function assertPublicValuesCovered(): Promise<void> {
  const publicValues = await allPublicValues()
  const covered = coveredValues()
  const missing = [...publicValues].filter((name) => !covered.has(name)).sort()
  const stale = [...covered].filter((name) => !publicValues.has(name)).sort()
  if (missing.length > 0) fail('coverage/public-values/missing', missing.join(', '))
  else pass('coverage/public-values/missing', `${publicValues.size} public values covered`)
  if (stale.length > 0) fail('coverage/public-values/stale', stale.join(', '))
  else pass('coverage/public-values/stale')
}

async function assertPackageExports(): Promise<void> {
  for (const [packagePath, expected] of Object.entries(EXPECTED_PACKAGE_EXPORTS)) {
    const pkg = await Bun.file(resolve(repoRoot, packagePath)).json() as { exports?: Record<string, unknown> }
    const actual = Object.keys(pkg.exports ?? {}).filter((key) => key !== './package.json').sort()
    const sortedExpected = expected.slice().sort()
    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      fail(`coverage/package-exports/${packagePath}`, `expected ${sortedExpected.join(', ')} got ${actual.join(', ')}`)
    } else {
      pass(`coverage/package-exports/${packagePath}`, actual.join(', '))
    }
  }
}

function assertHarnessFilesExist(): void {
  const scripts = new Set<string>()
  const pages = new Set<string>()
  for (const area of COVERAGE) {
    for (const script of [...area.ciScripts, ...(area.benchScripts ?? [])]) scripts.add(script)
    for (const page of area.benchPages ?? []) pages.add(page)
  }
  for (const script of scripts) {
    const path = resolve(repoRoot, 'scripts', script)
    if (!existsSync(path)) fail(`coverage/script-exists/${script}`, 'missing script')
  }
  for (const page of pages) {
    const path = resolve(repoRoot, 'pages/bench', page)
    const demoPath = resolve(repoRoot, 'pages/demos', page)
    if (!existsSync(path) && !existsSync(demoPath)) fail(`coverage/page-exists/${page}`, 'missing bench/demo page')
  }
  if (results.every((r) => r.ok || !r.case.startsWith('coverage/script-exists/'))) {
    pass('coverage/script-files-exist', `${scripts.size} scripts`)
  }
  if (results.every((r) => r.ok || !r.case.startsWith('coverage/page-exists/'))) {
    pass('coverage/page-files-exist', `${pages.size} pages`)
  }
}

async function assertCiScriptsRegistered(): Promise<void> {
  const runner = await readFile(resolve(repoRoot, 'scripts/run-all-harnesses.ts'), 'utf8')
  const ciScripts = new Set<string>()
  for (const area of COVERAGE) for (const script of area.ciScripts) ciScripts.add(script)
  const missing = [...ciScripts].filter((script) => !runner.includes(`'${script}'`) && !runner.includes(`"${script}"`))
  if (missing.length > 0) fail('coverage/ci-scripts-registered', missing.join(', '))
  else pass('coverage/ci-scripts-registered', `${ciScripts.size} scripts`)
}

async function main(): Promise<void> {
  const t0 = performance.now()
  assertNoDuplicateCoverage()
  await assertPublicValuesCovered()
  await assertPackageExports()
  assertHarnessFilesExist()
  await assertCiScriptsRegistered()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== coverage-matrix-test: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  x ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  const outDir = resolve(repoRoot, 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `coverage-matrix-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'coverage-matrix',
        date: new Date().toISOString(),
        wallMs,
        total,
        passed,
        failed: failed.length,
        publicSources: PUBLIC_VALUE_SOURCES,
        expectedPackageExports: EXPECTED_PACKAGE_EXPORTS,
        coverage: COVERAGE,
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
