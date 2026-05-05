#!/usr/bin/env bun
// Capture a live page into a local fixture, then replay controlled
// control/preimage variants against the same saved document.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright'

type CaptureMode = 'control' | 'preimage'
type RunOrder = 'fixed' | 'random'
type RunPhase = 'warmup' | 'measure'
type RunTemperature = 'cold' | 'warm'
type TargetScope = 'viewport' | 'page'
type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle'

type CaptureArgs = {
  command: 'capture'
  url: string
  name: string | null
  outDir: string
  targetScope: TargetScope
  viewportWidth: number
  viewportHeight: number
  waitUntil: WaitUntil
  timeoutMs: number
  settleMs: number
}

type RunArgs = {
  command: 'run'
  fixture: string
  modes: CaptureMode[]
  runs: number
  viewportWidth: number
  viewportHeight: number
  timeoutMs: number
  settleMs: number
  probeSettleMs: number
  probeTimeoutMs: number
  headed: boolean
  inspectMs: number
  save: boolean
  out: string | null
  failOnRunError: boolean
  warmupControl: boolean
  order: RunOrder
  seed: number | null
}

type Args = CaptureArgs | RunArgs

type CapturedImage = {
  id: string
  url: string
  target: boolean
  above: boolean
  hadDeclaredGeometry: boolean
  widthAttr: string | null
  heightAttr: string | null
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
}

type FixtureManifest = {
  version: 1
  url: string
  capturedAt: string
  targetScope: TargetScope
  viewport: { width: number; height: number }
  images: CapturedImage[]
}

type ProbeSnapshot =
  | {
      ok: true
      startedMs: number
      endedMs: number
      durationMs: number
      width: number
      height: number
      source: string
      byteLength: number | null
    }
  | {
      ok: false
      startedMs: number
      endedMs: number
      durationMs: number
      errorName: string
      errorMessage: string
    }

type ImageSnapshot = {
  id: string
  url: string
  above: boolean
  discoveredMs: number
  loadMs: number | null
  errorMs: number | null
  naturalWidth: number
  naturalHeight: number
  probe: ProbeSnapshot | null
  appliedMs: number | null
}

type ClientReport = {
  mode: CaptureMode
  durationMs: number
  images: ImageSnapshot[]
  performance: {
    cls: number
    layoutShifts: Array<{ startTime: number; value: number }>
    firstPaintMs: number | null
    firstContentfulPaintMs: number | null
    largestContentfulPaintMs: number | null
    longTaskCount: number
    longTaskTotalMs: number
  }
}

type NetworkSummary = {
  totalRequests: number
  failedRequests: number
  totalResponseBytes: number
  imageRequests: number
  imageResponseBytes: number
  rangeFetchRequests: number
  rangeFetchResponseBytes: number
}

type RunSummary = {
  targetCount: number
  aboveCount: number
  probeStartedCount: number
  probeSucceededCount: number
  probeFailedCount: number
  aboveProbeStartedCount: number
  aboveProbeSucceededCount: number
  aboveProbeFailedCount: number
  firstDimsKnownMs: number | null
  allAboveDimsKnownMs: number | null
  allAboveImagesLoadedMs: number | null
  allDimsKnownMs: number | null
  allImagesLoadedMs: number | null
  cls: number
  largestContentfulPaintMs: number | null
}

type RunResult =
  | {
      ok: true
      fixture: string
      mode: CaptureMode
      phase: RunPhase
      temperature: RunTemperature
      run: number
      wallMs: number
      client: ClientReport
      network: NetworkSummary
      summary: RunSummary
    }
  | {
      ok: false
      fixture: string
      mode: CaptureMode
      phase: RunPhase
      temperature: RunTemperature
      run: number
      wallMs: number
      errorName: string
      errorMessage: string
    }

type Report = {
  bench: 'captured-page'
  date: string
  fixture: string
  runPlan: RunPlanSummary
  runs: RunResult[]
}

type RunPlanSummary = {
  warmupControl: boolean
  order: RunOrder
  seed: number | null
  modes: CaptureMode[]
  runsPerMode: number
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const fixturesRoot = resolve(repoRoot, 'benchmarks/captured-pages')
const tempDir = resolve(repoRoot, '.tmp/captured-page-bench')
const loaderEntry = resolve(scriptDir, 'captured-page-loader.ts')
const benchmarksDir = resolve(repoRoot, 'benchmarks')

const DEFAULT_MODES: CaptureMode[] = ['control', 'preimage']

function parseArgs(argv: string[]): Args {
  const command = argv[0]
  if (command === 'capture') return parseCaptureArgs(argv.slice(1))
  if (command === 'run') return parseRunArgs(argv.slice(1))
  printUsage()
  process.exit(command === '--help' || command === '-h' ? 0 : 1)
}

function parseCaptureArgs(argv: string[]): CaptureArgs {
  const args: CaptureArgs = {
    command: 'capture',
    url: '',
    name: null,
    outDir: fixturesRoot,
    targetScope: 'viewport',
    viewportWidth: 1440,
    viewportHeight: 1000,
    waitUntil: 'commit',
    timeoutMs: 30_000,
    settleMs: 3000,
  }
  parseOptions(argv, (arg, next) => {
    switch (arg) {
      case '--url':
        args.url = next()
        break
      case '--name':
        args.name = next()
        break
      case '--out-dir':
        args.outDir = resolve(next())
        break
      case '--target-scope':
        args.targetScope = parseTargetScope(next())
        break
      case '--viewport':
        {
          const [w, h] = parseViewport(next())
          args.viewportWidth = w
          args.viewportHeight = h
        }
        break
      case '--wait-until':
        args.waitUntil = parseWaitUntil(next())
        break
      case '--timeout-ms':
        args.timeoutMs = Number(next())
        break
      case '--settle-ms':
        args.settleMs = Number(next())
        break
      case '--help':
        printUsage()
        process.exit(0)
      default:
        throw new Error(`Unknown capture argument: ${arg}`)
    }
  })
  if (args.url.length === 0) throw new Error('capture needs --url.')
  validatePositiveInteger('viewport width', args.viewportWidth)
  validatePositiveInteger('viewport height', args.viewportHeight)
  validatePositiveNumber('timeoutMs', args.timeoutMs)
  validateNonNegativeNumber('settleMs', args.settleMs)
  return args
}

function parseRunArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    command: 'run',
    fixture: '',
    modes: DEFAULT_MODES.slice(),
    runs: 3,
    viewportWidth: 1440,
    viewportHeight: 1000,
    timeoutMs: 20_000,
    settleMs: 1500,
    probeSettleMs: 3000,
    probeTimeoutMs: 8000,
    headed: false,
    inspectMs: 0,
    save: true,
    out: null,
    failOnRunError: false,
    warmupControl: true,
    order: 'random',
    seed: null,
  }
  parseOptions(argv, (arg, next) => {
    switch (arg) {
      case '--fixture':
        args.fixture = resolve(next())
        break
      case '--modes':
        args.modes = parseModes(next())
        break
      case '--runs':
        args.runs = Number(next())
        break
      case '--viewport':
        {
          const [w, h] = parseViewport(next())
          args.viewportWidth = w
          args.viewportHeight = h
        }
        break
      case '--timeout-ms':
        args.timeoutMs = Number(next())
        break
      case '--settle-ms':
        args.settleMs = Number(next())
        break
      case '--probe-settle-ms':
        args.probeSettleMs = Number(next())
        break
      case '--probe-timeout-ms':
        args.probeTimeoutMs = Number(next())
        break
      case '--headed':
        args.headed = true
        break
      case '--inspect-ms':
        args.inspectMs = Number(next())
        break
      case '--out':
        args.out = resolve(next())
        break
      case '--no-save':
        args.save = false
        break
      case '--fail-on-run-error':
        args.failOnRunError = true
        break
      case '--no-warmup-control':
        args.warmupControl = false
        break
      case '--order':
        args.order = parseRunOrder(next())
        break
      case '--seed':
        args.seed = parseSeed(next())
        break
      case '--help':
        printUsage()
        process.exit(0)
      default:
        throw new Error(`Unknown run argument: ${arg}`)
    }
  })
  if (args.fixture.length === 0) throw new Error('run needs --fixture.')
  validatePositiveInteger('runs', args.runs)
  validatePositiveInteger('viewport width', args.viewportWidth)
  validatePositiveInteger('viewport height', args.viewportHeight)
  validatePositiveNumber('timeoutMs', args.timeoutMs)
  validateNonNegativeNumber('settleMs', args.settleMs)
  validateNonNegativeNumber('probeSettleMs', args.probeSettleMs)
  validatePositiveNumber('probeTimeoutMs', args.probeTimeoutMs)
  validateNonNegativeNumber('inspectMs', args.inspectMs)
  return args
}

function parseOptions(argv: string[], visit: (arg: string, next: () => string) => void): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} expects a value.`)
      return value
    }
    visit(arg, next)
  }
}

function parseModes(raw: string): CaptureMode[] {
  const modes = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (modes.length === 0) throw new Error('--modes must name at least one mode.')
  for (const mode of modes) {
    if (mode !== 'control' && mode !== 'preimage') throw new Error(`Unknown mode "${mode}".`)
  }
  return modes as CaptureMode[]
}

function parseTargetScope(raw: string): TargetScope {
  if (raw === 'viewport' || raw === 'page') return raw
  throw new Error('--target-scope must be viewport or page.')
}

function parseRunOrder(raw: string): RunOrder {
  if (raw === 'fixed' || raw === 'random') return raw
  throw new Error('--order must be fixed or random.')
}

function parseWaitUntil(raw: string): WaitUntil {
  if (raw === 'commit' || raw === 'domcontentloaded' || raw === 'load' || raw === 'networkidle') return raw
  throw new Error('--wait-until must be commit, domcontentloaded, load, or networkidle.')
}

function parseViewport(raw: string): [number, number] {
  const [w, h] = raw.split('x').map((v) => Number(v))
  return [w ?? NaN, h ?? NaN]
}

function parseSeed(raw: string): number {
  const seed = Number(raw)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('--seed must be an integer from 0 to 4294967295.')
  }
  return seed
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}.`)
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive, got ${value}.`)
}

function validateNonNegativeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative, got ${value}.`)
}

function printUsage(): void {
  process.stdout.write(`Captured-page benchmark

Capture:
  bun run bench:captured-page -- capture --url https://example.com --name example

Run:
  bun run bench:captured-page -- run --fixture benchmarks/captured-pages/example --modes control,preimage

Capture options:
  --url URL                    Page to capture.
  --name NAME                  Fixture directory name.
  --out-dir DIR                Fixture root (default: benchmarks/captured-pages).
  --target-scope viewport|page Target missing-geometry viewport images or all missing images.
  --viewport WIDTHxHEIGHT      Capture viewport (default: 1440x1000).
  --wait-until STATE           commit,domcontentloaded,load,networkidle (default: commit).
  --timeout-ms MS              Navigation timeout (default: 30000).
  --settle-ms MS               Wait after navigation before freezing DOM (default: 3000).

Run options:
  --fixture DIR                Captured fixture directory.
  --modes LIST                 control,preimage (default: control,preimage).
  --runs N                     Warm measured repeats per mode (default: 3).
  --viewport WIDTHxHEIGHT      Replay viewport (default: 1440x1000).
  --timeout-ms MS              Navigation timeout (default: 20000).
  --settle-ms MS               Wait before reading report (default: 1500).
  --probe-settle-ms MS         Extra wait for probes (default: 3000).
  --probe-timeout-ms MS        Per-probe timeout (default: 8000).
  --headed                     Open visible Chromium.
  --inspect-ms MS              Keep each run open after measurement.
  --out PATH                   Write JSON report to this path.
  --no-save                    Do not write benchmarks/*.json.
  --fail-on-run-error          Exit non-zero if any individual run fails.
  --no-warmup-control          Skip the default cold control warmup before measured runs.
  --order fixed|random         Measured mode order after warmup (default: random).
  --seed N                     Deterministic seed for random order.
`)
}

async function buildLoaderBundle(): Promise<string> {
  await rm(tempDir, { recursive: true, force: true })
  await mkdir(tempDir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [loaderEntry],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    sourcemap: 'none',
  })
  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join('\n')
    throw new Error(`Captured-page loader bundle failed:\n${logs}`)
  }
  const entries = await readdir(tempDir)
  const bundleName = entries.find((entry) => entry.endsWith('.js'))
  if (bundleName === undefined) throw new Error(`Browser bundle missing in ${tempDir}.`)
  return await readFile(join(tempDir, bundleName), 'utf8')
}

async function capture(args: CaptureArgs): Promise<void> {
  const loaderSource = await buildLoaderBundle()
  const url = new URL(args.url)
  const slug = args.name ?? sanitizeFilePart(url.hostname + url.pathname.replace(/\/$/, ''))
  const fixtureDir = resolve(args.outDir, slug)
  await mkdir(fixtureDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: args.viewportWidth, height: args.viewportHeight },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(args.timeoutMs)
  page.setDefaultNavigationTimeout(args.timeoutMs)
  page.on('pageerror', (err) => {
    process.stderr.write(`[capture ${args.url}] pageerror: ${err.message}\n`)
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') process.stderr.write(`[capture ${args.url}] console: ${msg.text()}\n`)
  })

  try {
    await page.goto(args.url, { waitUntil: args.waitUntil, timeout: args.timeoutMs })
    if (args.settleMs > 0) await page.waitForTimeout(args.settleMs)
    const captured = await page.evaluate(({ targetScope }) => {
      function doctype(): string {
        const dt = document.doctype
        if (dt === null) return '<!doctype html>\n'
        return `<!doctype ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>\n`
      }
      function positiveAttr(img: HTMLImageElement, name: 'width' | 'height'): boolean {
        const raw = img.getAttribute(name)
        if (raw === null) return false
        const value = Number(raw)
        return Number.isFinite(value) && value > 0
      }
      function hasCssAspectRatio(img: HTMLImageElement): boolean {
        if (img.style.aspectRatio.trim() !== '') return true
        const value = getComputedStyle(img).aspectRatio.trim()
        return value !== '' && value !== 'auto' && value !== 'auto auto'
      }
      function inViewport(rect: DOMRect): boolean {
        return rect.width > 0 && rect.bottom >= 0 && rect.right > 0 && rect.top <= window.innerHeight && rect.left < window.innerWidth
      }
      function absolute(raw: string): string | null {
        if (raw.length === 0) return null
        try {
          return new URL(raw, document.baseURI).href
        } catch {
          return null
        }
      }
      function removeCsp(): void {
        for (const meta of Array.from(document.querySelectorAll<HTMLMetaElement>('meta[http-equiv]'))) {
          if (meta.httpEquiv.toLowerCase() === 'content-security-policy') meta.remove()
        }
      }
      function disableScripts(): void {
        for (const script of Array.from(document.scripts)) {
          const template = document.createElement('template')
          template.dataset.preimageCapturedScript = '1'
          if (script.src.length > 0) template.dataset.src = script.src
          script.replaceWith(template)
        }
      }
      function cleanupLinks(): void {
        for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link'))) {
          const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
          const as = (link.getAttribute('as') ?? '').toLowerCase()
          const remove =
            rel.includes('modulepreload') ||
            rel.includes('preload') ||
            rel.includes('prefetch') ||
            rel.includes('prerender') ||
            rel.includes('dns-prefetch') ||
            rel.includes('preconnect') ||
            rel.includes('manifest') ||
            as === 'script' ||
            as === 'fetch' ||
            as === 'worker'
          if (remove) {
            const template = document.createElement('template')
            template.dataset.preimageCapturedLink = rel.join(' ') || 'unknown'
            if (link.href.length > 0) template.dataset.href = link.href
            link.replaceWith(template)
            continue
          }
          if (rel.includes('stylesheet')) {
            link.removeAttribute('crossorigin')
            link.removeAttribute('integrity')
            link.removeAttribute('referrerpolicy')
          }
        }
      }
      function disableEmbeds(): void {
        for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[src]'))) {
          iframe.dataset.preimageCapturedSrc = iframe.src
          iframe.removeAttribute('src')
          iframe.setAttribute('srcdoc', '')
        }
        for (const source of Array.from(document.querySelectorAll<HTMLSourceElement>('source[src], source[srcset]'))) {
          if (source.src.length > 0) source.dataset.preimageCapturedSrc = source.src
          const srcset = source.getAttribute('srcset')
          if (srcset !== null) source.dataset.preimageCapturedSrcset = srcset
          source.removeAttribute('src')
          source.removeAttribute('srcset')
        }
        for (const media of Array.from(document.querySelectorAll<HTMLMediaElement>('audio[src], video[src]'))) {
          media.dataset.preimageCapturedSrc = media.currentSrc || media.src
          media.removeAttribute('src')
          media.preload = 'none'
        }
      }
      function ensureBase(): void {
        const existing = document.querySelector('base')
        if (existing !== null) existing.setAttribute('href', location.href)
        else {
          const base = document.createElement('base')
          base.href = location.href
          document.head.prepend(base)
        }
      }
      const sourceHtml = doctype() + document.documentElement.outerHTML
      const images: CapturedImage[] = []
      let id = 0
      for (const img of Array.from(document.images)) {
        const url = absolute(img.currentSrc || img.src)
        if (url === null) continue
        const rect = img.getBoundingClientRect()
        const hadDeclaredGeometry = (positiveAttr(img, 'width') && positiveAttr(img, 'height')) || hasCssAspectRatio(img)
        const above = inViewport(rect)
        const target = !hadDeclaredGeometry && (targetScope === 'page' || above)
        const imageId = String(id++)
        img.dataset.preimageCapturedId = imageId
        const item: CapturedImage = {
          id: imageId,
          url,
          target,
          above,
          hadDeclaredGeometry,
          widthAttr: img.getAttribute('width'),
          heightAttr: img.getAttribute('height'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
        images.push(item)
        const fixtureUrl = `/__preimage_asset/${imageId}`
        if (target) {
          img.dataset.preimageCapturedTarget = '1'
          img.dataset.preimageCapturedSrc = fixtureUrl
          img.dataset.preimageCapturedAbove = above ? '1' : '0'
          img.removeAttribute('src')
          img.removeAttribute('srcset')
          img.removeAttribute('sizes')
          img.setAttribute('loading', 'eager')
          img.setAttribute('decoding', 'async')
        } else {
          img.dataset.preimageCapturedPassive = '1'
          img.dataset.preimageCapturedSrc = fixtureUrl
          img.removeAttribute('src')
          img.removeAttribute('srcset')
          img.removeAttribute('sizes')
        }
      }
      removeCsp()
      disableScripts()
      cleanupLinks()
      disableEmbeds()
      ensureBase()
      return {
        sourceHtml,
        templateHtml: doctype() + document.documentElement.outerHTML,
        images,
      }
    }, { targetScope: args.targetScope })

    const manifest: FixtureManifest = {
      version: 1,
      url: args.url,
      capturedAt: new Date().toISOString(),
      targetScope: args.targetScope,
      viewport: { width: args.viewportWidth, height: args.viewportHeight },
      images: captured.images,
    }
    const controlHtml = injectLoader(captured.templateHtml, loaderSource, 'control', 8000)
    const preimageHtml = injectLoader(captured.templateHtml, loaderSource, 'preimage', 8000)

    await writeFile(join(fixtureDir, 'source.html'), captured.sourceHtml)
    await writeFile(join(fixtureDir, 'control.html'), controlHtml)
    await writeFile(join(fixtureDir, 'preimage.html'), preimageHtml)
    await writeFile(join(fixtureDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    const targetCount = manifest.images.filter((image) => image.target).length
    const aboveCount = manifest.images.filter((image) => image.target && image.above).length
    process.stdout.write(`captured ${fixtureDir.replace(`${repoRoot}/`, '')}\n`)
    process.stdout.write(`images ${manifest.images.length}, targets ${targetCount}, above ${aboveCount}\n`)
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

async function runFixture(args: RunArgs): Promise<void> {
  const manifest = await readManifest(args.fixture)
  const server = startFixtureServer(args.fixture, manifest)
  let browser: Browser | null = null
  const runs: RunResult[] = []
  const runPlan = buildRunPlan(args)
  try {
    const base = `http://127.0.0.1:${server.port}`
    browser = await chromium.launch({ headless: !args.headed })
    process.stdout.write(`=== captured-page: ${args.fixture.replace(`${repoRoot}/`, '')} ===\n\n`)
    printRunPlan(runPlan)
    if (args.warmupControl) {
      const result = await runOne(args, browser, base, 'control', 0, 'warmup', 'cold')
      runs.push(result)
      printRun(result)
    }
    for (const step of runPlan.steps) {
      const result = await runOne(args, browser, base, step.mode, step.run, 'measure', 'warm')
      runs.push(result)
      printRun(result)
    }
  } finally {
    if (browser !== null) await closeQuietly(browser.close(), 'browser')
    server.stop(true)
  }

  const report: Report = {
    bench: 'captured-page',
    date: new Date().toISOString(),
    fixture: args.fixture,
    runPlan: {
      warmupControl: args.warmupControl,
      order: runPlan.order,
      seed: runPlan.seed,
      modes: args.modes,
      runsPerMode: args.runs,
    },
    runs,
  }
  const outPath = await writeReport(args, report)
  if (outPath !== null) process.stdout.write(`saved ${outPath.replace(`${repoRoot}/`, '')}\n`)
  printAverages(runs, args.modes)
  const failed = runs.filter((run) => !run.ok)
  const passed = runs.length - failed.length
  process.stdout.write(`=== captured-page: ${passed}/${runs.length} runs completed ===\n`)
  process.exit((args.failOnRunError && failed.length > 0) || passed === 0 ? 1 : 0)
}

function buildRunPlan(args: RunArgs): { order: RunOrder; seed: number | null; steps: Array<{ mode: CaptureMode; run: number }> } {
  const seed = args.order === 'random' ? args.seed ?? randomSeed() : null
  const random = seed === null ? null : createRandom(seed)
  const steps: Array<{ mode: CaptureMode; run: number }> = []
  for (let run = 1; run <= args.runs; run++) {
    const modes = args.modes.slice()
    if (random !== null) shuffleInPlace(modes, random)
    for (const mode of modes) steps.push({ mode, run })
  }
  return { order: args.order, seed, steps }
}

function printRunPlan(plan: { order: RunOrder; seed: number | null; steps: Array<{ mode: CaptureMode; run: number }> }): void {
  const measured = plan.steps.map((step) => `${step.mode}:${step.run}`).join(', ')
  const seed = plan.seed === null ? '-' : String(plan.seed)
  process.stdout.write(`plan order ${plan.order} seed ${seed} measured ${measured}\n`)
}

async function readManifest(fixtureDir: string): Promise<FixtureManifest> {
  const raw = await readFile(join(fixtureDir, 'manifest.json'), 'utf8')
  const parsed = JSON.parse(raw) as FixtureManifest
  if (parsed.version !== 1) throw new Error(`Unsupported fixture manifest version ${parsed.version}.`)
  return parsed
}

function injectLoader(html: string, loaderSource: string, mode: CaptureMode, probeTimeoutMs: number): string {
  const safeLoader = loaderSource.replace(/<\/script/gi, '<\\/script')
  const script =
    `<script>window.__PREIMAGE_CAPTURED_CONFIG__=${JSON.stringify({ mode, probeTimeoutMs })};\n` +
    `${safeLoader}</script>`
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>\n${script}`)
  return html.replace(/<html([^>]*)>/i, `<html$1>\n<head>${script}</head>`)
}

function startFixtureServer(fixtureDir: string, manifest: FixtureManifest): { port: number; stop(force?: boolean): void } {
  const images = new Map(manifest.images.map((image) => [image.id, image]))
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/__preimage_asset/')) {
        const id = decodeURIComponent(url.pathname.slice('/__preimage_asset/'.length))
        const image = images.get(id)
        if (image === undefined) return new Response('asset not found', { status: 404 })
        return await proxyAsset(req, image, manifest.url)
      }
      const file = url.pathname === '/' ? 'control.html' : url.pathname.slice(1)
      if (file !== 'control.html' && file !== 'preimage.html' && file !== 'source.html' && file !== 'manifest.json') {
        return new Response('not found', { status: 404 })
      }
      const path = join(fixtureDir, file)
      const body = await readFile(path).catch(() => null)
      if (body === null) return new Response('not found', { status: 404 })
      const contentType = file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'
      return new Response(body, { headers: { 'content-type': contentType, 'cache-control': 'no-store' } })
    },
  })
  return server
}

async function proxyAsset(req: globalThis.Request, image: CapturedImage, referer: string): Promise<Response> {
  const headers = new Headers()
  const range = req.headers.get('range')
  if (range !== null) headers.set('range', range)
  headers.set('accept', req.headers.get('accept') ?? 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8')
  headers.set('user-agent', req.headers.get('user-agent') ?? 'Mozilla/5.0 preimage-captured-page-bench')
  headers.set('referer', referer)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  req.signal.addEventListener('abort', () => controller.abort(), { once: true })
  let upstream: Response
  try {
    upstream = await fetch(image.url, { headers, redirect: 'follow', signal: controller.signal })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    return new Response(e.message, { status: controller.signal.aborted ? 504 : 502 })
  } finally {
    clearTimeout(timeout)
  }
  const outHeaders = new Headers()
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name)
    if (value !== null) outHeaders.set(name, value)
  }
  outHeaders.set('access-control-allow-origin', '*')
  outHeaders.set('cache-control', 'no-store')
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders })
}

async function runOne(
  args: RunArgs,
  browser: Browser,
  base: string,
  mode: CaptureMode,
  run: number,
  phase: RunPhase,
  temperature: RunTemperature,
): Promise<RunResult> {
  const t0 = performance.now()
  let context: BrowserContext | null = null
  try {
    context = await browser.newContext({
      viewport: { width: args.viewportWidth, height: args.viewportHeight },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    })
    await routeReplayRequests(context, base)
    const page = await context.newPage()
    page.setDefaultTimeout(args.timeoutMs)
    page.setDefaultNavigationTimeout(args.timeoutMs)
    await installNoCache(page)
    const network = createNetworkTracker()
    network.attach(page)
    page.on('pageerror', (err) => {
      process.stderr.write(`[${mode}] pageerror: ${err.message}\n`)
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') process.stderr.write(`[${mode}] console: ${msg.text()}\n`)
    })

    await withTimeout(
      page.goto(`${base}/${mode}.html`, { waitUntil: 'commit', timeout: args.timeoutMs }),
      args.timeoutMs + 1000,
      `Navigation exceeded ${args.timeoutMs}ms.`,
    )
    if (args.settleMs > 0) await page.waitForTimeout(args.settleMs)
    const client = await withTimeout(
      page.evaluate(async (options) => {
        const bench = window.__preimageCapturedBench
        if (bench === undefined) throw new Error('captured-page bench loader did not install.')
        return await bench.finish(options)
      }, { probeSettleMs: args.probeSettleMs }),
      args.probeSettleMs + 5000,
      'Client report collection timed out.',
    )
    await network.waitForSettled(3000)
    const networkSummary = network.summary()
    if (args.inspectMs > 0) await page.waitForTimeout(args.inspectMs)
    return {
      ok: true,
      fixture: args.fixture,
      mode,
      phase,
      temperature,
      run,
      wallMs: performance.now() - t0,
      client,
      network: networkSummary,
      summary: summarizeRun(client),
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    return {
      ok: false,
      fixture: args.fixture,
      mode,
      phase,
      temperature,
      run,
      wallMs: performance.now() - t0,
      errorName: e.name,
      errorMessage: e.message,
    }
  } finally {
    if (context !== null) await closeQuietly(context.close(), 'browser context')
  }
}

async function routeReplayRequests(context: BrowserContext, base: string): Promise<void> {
  const localOrigin = new URL(base).origin
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === localOrigin || request.resourceType() === 'document') {
      await route.continue()
      return
    }
    await route.fulfill({ status: 204, body: '' })
  })
}

async function installNoCache(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  } catch {
    // Chromium-only.
  }
}

function createNetworkTracker(): {
  attach(page: Page): void
  waitForSettled(timeoutMs: number): Promise<void>
  summary(): NetworkSummary
} {
  const entries = new Map<Request, {
    resourceType: string
    failed: boolean
    requestRange: string | null
    contentType: string | null
    responseBytes: number
  }>()
  const pending: Promise<void>[] = []

  function ensure(request: Request): {
    resourceType: string
    failed: boolean
    requestRange: string | null
    contentType: string | null
    responseBytes: number
  } {
    let entry = entries.get(request)
    if (entry !== undefined) return entry
    entry = {
      resourceType: request.resourceType(),
      failed: false,
      requestRange: request.headers().range ?? null,
      contentType: null,
      responseBytes: 0,
    }
    entries.set(request, entry)
    return entry
  }

  async function finishRequest(request: Request, failed: boolean): Promise<void> {
    const entry = ensure(request)
    entry.failed = failed
    const response = await request.response().catch(() => null)
    if (response !== null) entry.contentType = response.headers()['content-type'] ?? null
    const sizes = await request.sizes().catch(() => null)
    if (sizes !== null) entry.responseBytes = sizes.responseBodySize + sizes.responseHeadersSize
  }

  return {
    attach(page: Page): void {
      page.on('request', (request) => ensure(request))
      page.on('requestfinished', (request) => pending.push(finishRequest(request, false)))
      page.on('requestfailed', (request) => pending.push(finishRequest(request, true)))
    },
    async waitForSettled(timeoutMs: number): Promise<void> {
      await withTimeout(Promise.allSettled(pending).then(() => undefined), timeoutMs, 'Timed out waiting for network accounting.').catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err))
        process.stderr.write(`${e.message}\n`)
      })
    },
    summary(): NetworkSummary {
      let failedRequests = 0
      let totalResponseBytes = 0
      let imageRequests = 0
      let imageResponseBytes = 0
      let rangeFetchRequests = 0
      let rangeFetchResponseBytes = 0
      for (const entry of entries.values()) {
        if (entry.failed) failedRequests++
        totalResponseBytes += entry.responseBytes
        const isImage = entry.resourceType === 'image' || (entry.contentType?.startsWith('image/') ?? false)
        if (isImage) {
          imageRequests++
          imageResponseBytes += entry.responseBytes
        }
        if (entry.resourceType === 'fetch' && entry.requestRange !== null) {
          rangeFetchRequests++
          rangeFetchResponseBytes += entry.responseBytes
        }
      }
      return {
        totalRequests: entries.size,
        failedRequests,
        totalResponseBytes,
        imageRequests,
        imageResponseBytes,
        rangeFetchRequests,
        rangeFetchResponseBytes,
      }
    },
  }
}

function summarizeRun(client: ClientReport): RunSummary {
  const images = client.images
  const above = images.filter((image) => image.above)
  const probeStarted = images.filter((image) => image.probe !== null)
  const probeSucceeded = probeStarted.filter((image) => image.probe?.ok === true)
  const probeFailed = probeStarted.filter((image) => image.probe?.ok === false)
  const aboveProbeStarted = above.filter((image) => image.probe !== null)
  const aboveProbeSucceeded = aboveProbeStarted.filter((image) => image.probe?.ok === true)
  const aboveProbeFailed = aboveProbeStarted.filter((image) => image.probe?.ok === false)
  return {
    targetCount: images.length,
    aboveCount: above.length,
    probeStartedCount: probeStarted.length,
    probeSucceededCount: probeSucceeded.length,
    probeFailedCount: probeFailed.length,
    aboveProbeStartedCount: aboveProbeStarted.length,
    aboveProbeSucceededCount: aboveProbeSucceeded.length,
    aboveProbeFailedCount: aboveProbeFailed.length,
    firstDimsKnownMs: minTime(images.map(dimsKnownMs)),
    allAboveDimsKnownMs: allTime(above.map(dimsKnownMs)),
    allAboveImagesLoadedMs: allTime(above.map((image) => image.loadMs)),
    allDimsKnownMs: allTime(images.map(dimsKnownMs)),
    allImagesLoadedMs: allTime(images.map((image) => image.loadMs)),
    cls: client.performance.cls,
    largestContentfulPaintMs: client.performance.largestContentfulPaintMs,
  }
}

function dimsKnownMs(image: ImageSnapshot): number | null {
  const probeMs = image.probe?.ok === true ? image.probe.endedMs : null
  if (probeMs === null) return image.loadMs
  if (image.loadMs === null) return probeMs
  return Math.min(probeMs, image.loadMs)
}

function minTime(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return Math.min(...present)
}

function allTime(values: Array<number | null>): number | null {
  if (values.length === 0) return null
  if (values.some((value) => value === null)) return null
  return Math.max(...(values as number[]))
}

function formatMs(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)}ms`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
  return `${(value / (1024 * 1024)).toFixed(1)}MB`
}

function printRun(result: RunResult): void {
  const runLabel = result.phase === 'warmup' ? 'warmup' : `run ${result.run}`
  const tempLabel = result.temperature === 'cold' ? 'cold' : 'warm'
  if (!result.ok) {
    process.stdout.write(`  x ${result.mode.padEnd(8)} ${runLabel.padEnd(8)} ${tempLabel}: ${result.errorName}: ${result.errorMessage}\n`)
    return
  }
  const s = result.summary
  const n = result.network
  process.stdout.write(
    [
      `  ✓ ${result.mode.padEnd(8)} ${runLabel.padEnd(8)}`,
      tempLabel,
      `targets ${s.targetCount}`,
      `above ${s.aboveCount}`,
      `probe ${s.probeSucceededCount}/${s.probeStartedCount}`,
      `aboveProbe ${s.aboveProbeSucceededCount}/${s.aboveProbeStartedCount}`,
      `firstDims ${formatMs(s.firstDimsKnownMs)}`,
      `aboveDims ${formatMs(s.allAboveDimsKnownMs)}`,
      `aboveImgs ${formatMs(s.allAboveImagesLoadedMs)}`,
      `allDims ${formatMs(s.allDimsKnownMs)}`,
      `allImgs ${formatMs(s.allImagesLoadedMs)}`,
      `CLS ${s.cls.toFixed(3)}`,
      `LCP ${formatMs(s.largestContentfulPaintMs)}`,
      `req ${n.totalRequests}`,
      `img ${formatBytes(n.imageResponseBytes)}`,
      `range ${formatBytes(n.rangeFetchResponseBytes)}`,
    ].join('  ') + '\n',
  )
}

function printAverages(runs: RunResult[], modes: CaptureMode[]): void {
  const okRuns = runs.filter((run): run is Extract<RunResult, { ok: true }> => run.ok && run.phase === 'measure')
  if (okRuns.length === 0) return
  process.stdout.write('\n=== warm measured averages ===\n')
  for (const mode of modes) {
    const modeRuns = okRuns.filter((run) => run.mode === mode)
    if (modeRuns.length === 0) continue
    process.stdout.write(
      [
        `  ${mode.padEnd(8)} n ${modeRuns.length}`,
        `firstDims ${formatMs(meanTime(modeRuns.map((run) => run.summary.firstDimsKnownMs)))}`,
        `aboveDims ${formatMs(meanTime(modeRuns.map((run) => run.summary.allAboveDimsKnownMs)))}`,
        `aboveImgs ${formatMs(meanTime(modeRuns.map((run) => run.summary.allAboveImagesLoadedMs)))}`,
        `allDims ${formatMs(meanTime(modeRuns.map((run) => run.summary.allDimsKnownMs)))}`,
        `allImgs ${formatMs(meanTime(modeRuns.map((run) => run.summary.allImagesLoadedMs)))}`,
        `CLS ${meanNumber(modeRuns.map((run) => run.summary.cls)).toFixed(3)}`,
        `LCP ${formatMs(meanTime(modeRuns.map((run) => run.summary.largestContentfulPaintMs)))}`,
        `req ${Math.round(meanNumber(modeRuns.map((run) => run.network.totalRequests)))}`,
        `img ${formatBytes(meanNumber(modeRuns.map((run) => run.network.imageResponseBytes)))}`,
        `range ${formatBytes(meanNumber(modeRuns.map((run) => run.network.rangeFetchResponseBytes)))}`,
      ].join('  ') + '\n',
    )
  }
}

async function writeReport(args: RunArgs, report: Report): Promise<string | null> {
  if (!args.save && args.out === null) return null
  const outPath = args.out ?? join(benchmarksDir, `captured-page-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(report, null, 2))
  return outPath
}

async function closeQuietly(promise: Promise<void>, label: string): Promise<void> {
  try {
    await withTimeout(promise, 3000, `Timed out closing ${label}.`)
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    process.stderr.write(`${e.message}\n`)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page'
}

function meanTime(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null
  return meanNumber(values as number[])
}

function meanNumber(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function randomSeed(): number {
  const bytes = new Uint32Array(1)
  crypto.getRandomValues(bytes)
  return bytes[0]!
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function shuffleInPlace<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const item = items[i]!
    items[i] = items[j]!
    items[j] = item
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'capture') await capture(args)
  else await runFixture(args)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
