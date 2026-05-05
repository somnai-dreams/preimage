#!/usr/bin/env bun
// Full-page loading benchmark for real websites.
//
// This keeps the page intact and injects a small observer/probe shim at
// document start. It answers whether dimension probing helps earlier
// accurate image geometry in the context of all other page requests.
//
// Usage:
//   bun run bench:full-page -- --url https://example.com
//   bun run bench:full-page -- --urls-file urls.txt --modes control,probe,apply

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright'

type BenchMode = 'control' | 'probe' | 'apply'
type ProbeScope = 'unknown' | 'all'
type ApplyShape = 'aspect-ratio' | 'attrs' | 'both'
type ImageScope = 'page' | 'viewport'
type WaitUntil = 'commit' | 'domcontentloaded' | 'load' | 'networkidle'
type HarNotFound = 'abort' | 'fallback'

type Args = {
  urls: string[]
  urlsFile: string | null
  modes: BenchMode[]
  runs: number
  viewportWidth: number
  viewportHeight: number
  waitUntil: WaitUntil
  timeoutMs: number
  settleMs: number
  probeSettleMs: number
  probeTimeoutMs: number
  probeScope: ProbeScope
  applyShape: ApplyShape
  imageScope: ImageScope
  scrollDistance: number
  scrollMs: number
  headed: boolean
  slowMoMs: number
  inspectMs: number
  save: boolean
  out: string | null
  recordHarDir: string | null
  replayHar: string | null
  harNotFound: HarNotFound
  failOnRunError: boolean
}

type RectSnapshot = {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  inViewport: boolean
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
  id: number
  url: string
  discoveredMs: number
  hadDeclaredGeometry: boolean
  hadWidthAttr: boolean
  hadHeightAttr: boolean
  hadInlineAspectRatio: boolean
  hadCssAspectRatio: boolean
  initialRect: RectSnapshot
  finalRect: RectSnapshot
  loadMs: number | null
  errorMs: number | null
  complete: boolean
  naturalWidth: number
  naturalHeight: number
  probe: ProbeSnapshot | null
  appliedMs: number | null
}

type ClientReport = {
  mode: BenchMode
  href: string
  title: string
  userAgent: string
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

type NetworkEntry = {
  url: string
  method: string
  resourceType: string
  startMs: number
  endMs: number | null
  status: number | null
  failed: boolean
  failureText: string | null
  contentType: string | null
  requestRange: string | null
  responseBodySize: number
  responseHeadersSize: number
}

type NetworkSummary = {
  totalRequests: number
  failedRequests: number
  totalResponseBytes: number
  imageRequests: number
  imageResponseBytes: number
  rangeFetchRequests: number
  rangeFetchResponseBytes: number
  byResourceType: Record<string, { count: number; responseBytes: number }>
}

type RunSummary = {
  imageCount: number
  unknownImageCount: number
  visibleUnknownImageCount: number
  viewportUnknownImageCount: number
  loadedUnknownImageCount: number
  probeStartedCount: number
  probeSucceededCount: number
  probeFailedCount: number
  viewportProbeStartedCount: number
  viewportProbeSucceededCount: number
  viewportProbeFailedCount: number
  firstDimsKnownMs: number | null
  allViewportDimsKnownMs: number | null
  allViewportImagesLoadedMs: number | null
  allDimsKnownMs: number | null
  allImagesLoadedMs: number | null
  firstUnknownLoadMs: number | null
  allUnknownLoadMs: number | null
  firstUnknownProbeMs: number | null
  allUnknownProbeMs: number | null
  firstUnknownAppliedMs: number | null
  allUnknownAppliedMs: number | null
  allViewportUnknownLoadMs: number | null
  allViewportUnknownProbeMs: number | null
  allViewportUnknownAppliedMs: number | null
  cls: number
  firstContentfulPaintMs: number | null
  largestContentfulPaintMs: number | null
  longTaskTotalMs: number
}

type RunResult =
  | {
      ok: true
      url: string
      mode: BenchMode
      run: number
      wallMs: number
      client: ClientReport
      network: NetworkSummary
      summary: RunSummary
    }
  | {
      ok: false
      url: string
      mode: BenchMode
      run: number
      wallMs: number
      errorName: string
      errorMessage: string
    }

type Report = {
  bench: 'full-page-loading'
  date: string
  params: Omit<Args, 'urlsFile'>
  runs: RunResult[]
  aggregate: Array<{
    url: string
    mode: BenchMode
    runs: number
    median: RunSummary & NetworkSummary
  }>
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const tempDir = resolve(repoRoot, '.tmp/full-page-loading-bench')
const clientEntry = resolve(scriptDir, 'full-page-bench-client.ts')
const benchmarksDir = resolve(repoRoot, 'benchmarks')

const DEFAULT_MODES: BenchMode[] = ['control', 'probe', 'apply']
const ALL_MODES: BenchMode[] = ['control', 'probe', 'apply']

function parseArgs(argv: string[]): Args {
  const args: Args = {
    urls: [],
    urlsFile: null,
    modes: DEFAULT_MODES.slice(),
    runs: 1,
    viewportWidth: 1440,
    viewportHeight: 1000,
    waitUntil: 'load',
    timeoutMs: 45_000,
    settleMs: 1500,
    probeSettleMs: 3000,
    probeTimeoutMs: 8000,
    probeScope: 'unknown',
    applyShape: 'aspect-ratio',
    imageScope: 'page',
    scrollDistance: 0,
    scrollMs: 0,
    headed: false,
    slowMoMs: 0,
    inspectMs: 0,
    save: true,
    out: null,
    recordHarDir: null,
    replayHar: null,
    harNotFound: 'fallback',
    failOnRunError: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} expects a value.`)
      return value
    }
    switch (arg) {
      case '--url':
        args.urls.push(next())
        break
      case '--urls':
        args.urls.push(...next().split(',').map((url) => url.trim()).filter(Boolean))
        break
      case '--urls-file':
        args.urlsFile = next()
        break
      case '--modes':
        args.modes = parseModes(next())
        break
      case '--runs':
        args.runs = Number(next())
        break
      case '--viewport':
        {
          const [w, h] = next().split('x').map((v) => Number(v))
          args.viewportWidth = w ?? NaN
          args.viewportHeight = h ?? NaN
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
      case '--probe-settle-ms':
        args.probeSettleMs = Number(next())
        break
      case '--probe-timeout-ms':
        args.probeTimeoutMs = Number(next())
        break
      case '--probe-scope':
        args.probeScope = parseProbeScope(next())
        break
      case '--apply-shape':
        args.applyShape = parseApplyShape(next())
        break
      case '--image-scope':
        args.imageScope = parseImageScope(next())
        break
      case '--scroll-distance':
        args.scrollDistance = Number(next())
        break
      case '--scroll-ms':
        args.scrollMs = Number(next())
        break
      case '--headed':
        args.headed = true
        break
      case '--slow-mo-ms':
        args.slowMoMs = Number(next())
        break
      case '--inspect-ms':
        args.inspectMs = Number(next())
        break
      case '--out':
        args.out = next()
        break
      case '--record-har-dir':
        args.recordHarDir = next()
        break
      case '--replay-har':
        args.replayHar = next()
        break
      case '--har-not-found':
        args.harNotFound = parseHarNotFound(next())
        break
      case '--no-save':
        args.save = false
        break
      case '--fail-on-run-error':
        args.failOnRunError = true
        break
      case '--help':
        printUsage()
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  validateArgs(args)
  return args
}

function parseModes(raw: string): BenchMode[] {
  const modes = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (modes.length === 0) throw new Error('--modes must name at least one mode.')
  for (const mode of modes) {
    if (!ALL_MODES.includes(mode as BenchMode)) {
      throw new Error(`Unknown mode "${mode}". Expected one of ${ALL_MODES.join(', ')}.`)
    }
  }
  return modes as BenchMode[]
}

function parseWaitUntil(raw: string): WaitUntil {
  if (raw === 'commit' || raw === 'domcontentloaded' || raw === 'load' || raw === 'networkidle') return raw
  throw new Error('--wait-until must be commit, domcontentloaded, load, or networkidle.')
}

function parseProbeScope(raw: string): ProbeScope {
  if (raw === 'unknown' || raw === 'all') return raw
  throw new Error('--probe-scope must be unknown or all.')
}

function parseApplyShape(raw: string): ApplyShape {
  if (raw === 'aspect-ratio' || raw === 'attrs' || raw === 'both') return raw
  throw new Error('--apply-shape must be aspect-ratio, attrs, or both.')
}

function parseImageScope(raw: string): ImageScope {
  if (raw === 'page' || raw === 'viewport') return raw
  throw new Error('--image-scope must be page or viewport.')
}

function parseHarNotFound(raw: string): HarNotFound {
  if (raw === 'abort' || raw === 'fallback') return raw
  throw new Error('--har-not-found must be abort or fallback.')
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

function validateArgs(args: Args): void {
  validatePositiveInteger('runs', args.runs)
  validatePositiveInteger('viewport width', args.viewportWidth)
  validatePositiveInteger('viewport height', args.viewportHeight)
  validatePositiveNumber('timeoutMs', args.timeoutMs)
  validateNonNegativeNumber('settleMs', args.settleMs)
  validateNonNegativeNumber('probeSettleMs', args.probeSettleMs)
  validatePositiveNumber('probeTimeoutMs', args.probeTimeoutMs)
  validateNonNegativeNumber('scrollDistance', args.scrollDistance)
  validateNonNegativeNumber('scrollMs', args.scrollMs)
  validateNonNegativeNumber('slowMoMs', args.slowMoMs)
  validateNonNegativeNumber('inspectMs', args.inspectMs)
  if (args.urls.length === 0 && args.urlsFile === null) throw new Error('Pass at least one --url or --urls-file.')
  if (args.modes.length === 0) throw new Error('Pass at least one mode.')
}

function printUsage(): void {
  process.stdout.write(`Full-page loading benchmark

Options:
  --url URL                    URL to benchmark. Repeatable.
  --urls URL1,URL2             Comma-separated URLs.
  --urls-file PATH             Newline-delimited URL list. # starts comments.
  --modes LIST                 control,probe,apply (default: ${DEFAULT_MODES.join(',')})
  --runs N                     Repeats per URL/mode (default: 1)
  --viewport WIDTHxHEIGHT      Browser viewport (default: 1440x1000)
  --wait-until STATE           commit,domcontentloaded,load,networkidle (default: load)
  --settle-ms MS               Wait after load/scroll before reading report (default: 1500)
  --probe-settle-ms MS         Extra time for outstanding probes (default: 3000)
  --probe-timeout-ms MS        Per-probe timeout in the injected shim (default: 8000)
  --probe-scope unknown|all    Probe missing-geometry images or every image (default: unknown)
  --apply-shape MODE           aspect-ratio, attrs, or both (default: aspect-ratio)
  --image-scope page|viewport  Target every image or first-discovered viewport images (default: page)
  --scroll-distance PX         Scripted scroll distance after load (default: 0)
  --scroll-ms MS               Scripted scroll duration (default: 0)
  --headed                     Open a visible Chromium window.
  --slow-mo-ms MS              Delay Playwright actions in headed/debug runs.
  --inspect-ms MS              Keep each browser window open after measurement.
  --record-har-dir DIR         Save one HAR per run for replay/debugging.
  --replay-har PATH            Replay from a Playwright HAR.
  --har-not-found MODE         abort or fallback for HAR misses (default: fallback)
  --out PATH                   Write JSON report to this path.
  --no-save                    Do not write benchmarks/*.json.
  --fail-on-run-error          Exit non-zero if any individual run fails.
`)
}

async function loadUrls(args: Args): Promise<string[]> {
  const urls = args.urls.slice()
  if (args.urlsFile !== null) {
    const raw = await readFile(args.urlsFile, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      urls.push(trimmed)
    }
  }
  const normalized: string[] = []
  for (const raw of urls) {
    const url = new URL(raw)
    normalized.push(url.href)
  }
  return Array.from(new Set(normalized))
}

async function buildBrowserBundle(): Promise<string> {
  await rm(tempDir, { recursive: true, force: true })
  await mkdir(tempDir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [clientEntry],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    sourcemap: 'none',
  })
  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join('\n')
    throw new Error(`Full-page bench client bundle failed:\n${logs}`)
  }
  const entries = await readdir(tempDir)
  const bundleName = entries.find((entry) => entry.endsWith('.js'))
  if (bundleName === undefined) throw new Error(`Browser bundle missing in ${tempDir}.`)
  return await readFile(join(tempDir, bundleName), 'utf8')
}

async function runOne(
  args: Args,
  bundleSource: string,
  url: string,
  mode: BenchMode,
  run: number,
): Promise<RunResult> {
  const t0 = performance.now()
  let browser: Browser | null = null
  let context: BrowserContext | null = null
  const runTimeoutMs = args.timeoutMs + args.settleMs + args.probeSettleMs + args.scrollMs + args.inspectMs + 10_000
  let runTimedOut = false
  let contextClosePromise: Promise<void> | null = null
  let browserClosePromise: Promise<void> | null = null

  const closeContext = (): Promise<void> => {
    if (context === null) return Promise.resolve()
    contextClosePromise ??= context.close().catch(() => {})
    return contextClosePromise
  }
  const closeBrowser = (): Promise<void> => {
    if (browser === null) return Promise.resolve()
    browserClosePromise ??= browser.close().catch(() => {})
    return browserClosePromise
  }

  const runTimer = setTimeout(() => {
    runTimedOut = true
    void closeContext()
    void closeBrowser()
  }, runTimeoutMs)

  try {
    const harPath = args.recordHarDir === null
      ? null
      : resolve(args.recordHarDir, `${sanitizeFilePart(new URL(url).hostname)}-${mode}-${run}.har`)
    if (harPath !== null) await mkdir(dirname(harPath), { recursive: true })

    browser = await chromium.launch({
      headless: !args.headed,
      slowMo: args.slowMoMs > 0 ? args.slowMoMs : undefined,
    })
    context = await browser.newContext({
      viewport: { width: args.viewportWidth, height: args.viewportHeight },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      recordHar: harPath === null ? undefined : { path: harPath, content: 'attach' },
    })
    if (args.replayHar !== null) {
      await context.routeFromHAR(args.replayHar, { notFound: args.harNotFound })
    }

    const page = context.pages()[0] ?? await context.newPage()
    page.setDefaultTimeout(args.timeoutMs)
    page.setDefaultNavigationTimeout(args.timeoutMs)
    await installNoCache(page)

    const network = createNetworkTracker()
    network.attach(page)
    page.on('pageerror', (err) => {
      process.stderr.write(`[${mode} ${url}] pageerror: ${err.message}\n`)
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') process.stderr.write(`[${mode} ${url}] console: ${msg.text()}\n`)
    })

    const config = {
      mode,
      probeScope: args.probeScope,
      applyShape: args.applyShape,
      imageScope: args.imageScope,
      probeTimeoutMs: args.probeTimeoutMs,
    }
    await page.addInitScript({
      content:
        `window.__PREIMAGE_FULL_PAGE_BENCH_CONFIG__=${JSON.stringify(config)};\n` +
        bundleSource,
    })

    await withTimeout(
      page.goto(url, { waitUntil: args.waitUntil, timeout: args.timeoutMs }),
      args.timeoutMs + 1000,
      `Navigation exceeded ${args.timeoutMs}ms.`,
    )
    if (args.scrollDistance > 0) {
      await withTimeout(
        scriptedScroll(page, args.scrollDistance, args.scrollMs),
        args.scrollMs + 3000,
        'Scripted scroll timed out.',
      )
    }
    if (args.settleMs > 0) {
      await withTimeout(page.waitForTimeout(args.settleMs), args.settleMs + 1000, 'Post-load settle timed out.')
    }

    const client = await withTimeout(
      page.evaluate(async (options) => {
        const bench = window.__preimageFullPageBench
        if (bench === undefined) throw new Error('preimage full-page bench shim did not install.')
        return await bench.finish(options)
      }, { probeSettleMs: args.probeSettleMs }),
      args.probeSettleMs + 5000,
      'Client report collection timed out.',
    )

    await network.waitForSettled(3000)
    const networkSummary = network.summary()
    if (args.inspectMs > 0) {
      await withTimeout(page.waitForTimeout(args.inspectMs), args.inspectMs + 1000, 'Inspect pause timed out.')
    }
    const wallMs = performance.now() - t0
    return {
      ok: true,
      url,
      mode,
      run,
      wallMs,
      client,
      network: networkSummary,
      summary: summarizeRun(client),
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    return {
      ok: false,
      url,
      mode,
      run,
      wallMs: performance.now() - t0,
      errorName: runTimedOut ? 'TimeoutError' : e.name,
      errorMessage: runTimedOut ? `Run exceeded ${runTimeoutMs}ms and was closed.` : e.message,
    }
  } finally {
    clearTimeout(runTimer)
    await closeQuietly(closeContext(), 'browser context')
    await closeQuietly(closeBrowser(), 'browser')
  }
}

async function closeQuietly(closePromise: Promise<void>, label: string): Promise<void> {
  try {
    await withTimeout(closePromise, 3000, `Timed out closing ${label}.`)
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

async function installNoCache(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('Network.enable')
    await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  } catch {
    // CDP is Chromium-only; this script currently launches Chromium,
    // but leave this non-fatal so HAR replay/debug modes still run.
  }
}

async function scriptedScroll(page: Page, distance: number, durationMs: number): Promise<void> {
  await page.evaluate(async ({ distance, durationMs }) => {
    const start = window.scrollY
    if (durationMs <= 0) {
      window.scrollTo(0, start + distance)
      return
    }
    const t0 = performance.now()
    await new Promise<void>((resolveFn) => {
      function frame(now: number): void {
        const t = Math.min(1, (now - t0) / durationMs)
        window.scrollTo(0, start + distance * t)
        if (t >= 1) resolveFn()
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
  }, { distance, durationMs })
}

function createNetworkTracker(): {
  attach(page: Page): void
  waitForSettled(timeoutMs: number): Promise<void>
  summary(): NetworkSummary
} {
  const entries = new Map<Request, NetworkEntry>()
  const pending: Promise<void>[] = []
  const t0 = performance.now()

  function startMs(): number {
    return performance.now() - t0
  }

  function ensure(request: Request): NetworkEntry {
    let entry = entries.get(request)
    if (entry !== undefined) return entry
    const headers = request.headers()
    entry = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      startMs: startMs(),
      endMs: null,
      status: null,
      failed: false,
      failureText: null,
      contentType: null,
      requestRange: headers.range ?? null,
      responseBodySize: 0,
      responseHeadersSize: 0,
    }
    entries.set(request, entry)
    return entry
  }

  async function finishRequest(request: Request, failed: boolean): Promise<void> {
    const entry = ensure(request)
    entry.endMs = startMs()
    entry.failed = failed
    if (failed) entry.failureText = request.failure()?.errorText ?? 'request failed'
    const response = await request.response().catch(() => null)
    if (response !== null) {
      entry.status = response.status()
      entry.contentType = response.headers()['content-type'] ?? null
    }
    const sizes = await request.sizes().catch(() => null)
    if (sizes !== null) {
      entry.responseBodySize = sizes.responseBodySize
      entry.responseHeadersSize = sizes.responseHeadersSize
    }
  }

  return {
    attach(page: Page): void {
      page.on('request', (request) => {
        ensure(request)
      })
      page.on('requestfinished', (request) => {
        pending.push(finishRequest(request, false))
      })
      page.on('requestfailed', (request) => {
        pending.push(finishRequest(request, true))
      })
    },
    async waitForSettled(timeoutMs: number): Promise<void> {
      try {
        await withTimeout(Promise.allSettled(pending).then(() => undefined), timeoutMs, 'Timed out waiting for network accounting.')
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        process.stderr.write(`${e.message}\n`)
      }
    },
    summary(): NetworkSummary {
      const byResourceType: NetworkSummary['byResourceType'] = {}
      let failedRequests = 0
      let totalResponseBytes = 0
      let imageRequests = 0
      let imageResponseBytes = 0
      let rangeFetchRequests = 0
      let rangeFetchResponseBytes = 0

      for (const entry of entries.values()) {
        if (entry.failed) failedRequests++
        const responseBytes = entry.responseBodySize + entry.responseHeadersSize
        totalResponseBytes += responseBytes
        const bucket = byResourceType[entry.resourceType] ?? { count: 0, responseBytes: 0 }
        bucket.count++
        bucket.responseBytes += responseBytes
        byResourceType[entry.resourceType] = bucket

        const isImage = entry.resourceType === 'image' || (entry.contentType?.startsWith('image/') ?? false)
        if (isImage) {
          imageRequests++
          imageResponseBytes += responseBytes
        }
        if (entry.resourceType === 'fetch' && entry.requestRange !== null) {
          rangeFetchRequests++
          rangeFetchResponseBytes += responseBytes
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
        byResourceType,
      }
    },
  }
}

function summarizeRun(client: ClientReport): RunSummary {
  const unknown = client.images.filter((image) => !image.hadDeclaredGeometry)
  const visibleUnknown = unknown.filter((image) => image.initialRect.visible || image.finalRect.visible)
  const viewportUnknown = unknown.filter((image) => image.initialRect.inViewport)
  const loadedUnknown = unknown.filter((image) => image.loadMs !== null)
  const probeStarted = unknown.filter((image) => image.probe !== null)
  const probeSucceeded = probeStarted.filter((image) => image.probe?.ok === true)
  const probeFailed = probeStarted.filter((image) => image.probe?.ok === false)
  const viewportProbeStarted = viewportUnknown.filter((image) => image.probe !== null)
  const viewportProbeSucceeded = viewportProbeStarted.filter((image) => image.probe?.ok === true)
  const viewportProbeFailed = viewportProbeStarted.filter((image) => image.probe?.ok === false)
  return {
    imageCount: client.images.length,
    unknownImageCount: unknown.length,
    visibleUnknownImageCount: visibleUnknown.length,
    viewportUnknownImageCount: viewportUnknown.length,
    loadedUnknownImageCount: loadedUnknown.length,
    probeStartedCount: probeStarted.length,
    probeSucceededCount: probeSucceeded.length,
    probeFailedCount: probeFailed.length,
    viewportProbeStartedCount: viewportProbeStarted.length,
    viewportProbeSucceededCount: viewportProbeSucceeded.length,
    viewportProbeFailedCount: viewportProbeFailed.length,
    firstDimsKnownMs: minTime(unknown.map(dimsKnownMs)),
    allViewportDimsKnownMs: allTime(viewportUnknown.map(dimsKnownMs)),
    allViewportImagesLoadedMs: allTime(viewportUnknown.map((image) => image.loadMs)),
    allDimsKnownMs: allTime(unknown.map(dimsKnownMs)),
    allImagesLoadedMs: allTime(unknown.map((image) => image.loadMs)),
    firstUnknownLoadMs: minTime(unknown.map((image) => image.loadMs)),
    allUnknownLoadMs: allTime(unknown.map((image) => image.loadMs)),
    firstUnknownProbeMs: minTime(probeStarted.map((image) => image.probe?.endedMs ?? null)),
    allUnknownProbeMs: allTime(probeStarted.map((image) => image.probe?.endedMs ?? null)),
    firstUnknownAppliedMs: minTime(unknown.map((image) => image.appliedMs)),
    allUnknownAppliedMs: allTime(unknown.map((image) => image.appliedMs)),
    allViewportUnknownLoadMs: allTime(viewportUnknown.map((image) => image.loadMs)),
    allViewportUnknownProbeMs: allTime(viewportProbeStarted.map((image) => image.probe?.endedMs ?? null)),
    allViewportUnknownAppliedMs: allTime(viewportUnknown.map((image) => image.appliedMs)),
    cls: client.performance.cls,
    firstContentfulPaintMs: client.performance.firstContentfulPaintMs,
    largestContentfulPaintMs: client.performance.largestContentfulPaintMs,
    longTaskTotalMs: client.performance.longTaskTotalMs,
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[idx]!
}

function medianNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return percentile(present, 0.5)
}

function aggregateRuns(runs: RunResult[]): Report['aggregate'] {
  const groups = new Map<string, { url: string; mode: BenchMode; runs: Array<Extract<RunResult, { ok: true }>> }>()
  for (const run of runs) {
    if (!run.ok) continue
    const key = `${run.url}\u0000${run.mode}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { url: run.url, mode: run.mode, runs: [] }
      groups.set(key, group)
    }
    group.runs.push(run)
  }

  const out: Report['aggregate'] = []
  for (const group of groups.values()) {
    const summaries = group.runs.map((run) => run.summary)
    const networks = group.runs.map((run) => run.network)
    out.push({
      url: group.url,
      mode: group.mode,
      runs: group.runs.length,
      median: {
        imageCount: medianNumber(summaries.map((s) => s.imageCount)),
        unknownImageCount: medianNumber(summaries.map((s) => s.unknownImageCount)),
        visibleUnknownImageCount: medianNumber(summaries.map((s) => s.visibleUnknownImageCount)),
        viewportUnknownImageCount: medianNumber(summaries.map((s) => s.viewportUnknownImageCount)),
        loadedUnknownImageCount: medianNumber(summaries.map((s) => s.loadedUnknownImageCount)),
        probeStartedCount: medianNumber(summaries.map((s) => s.probeStartedCount)),
        probeSucceededCount: medianNumber(summaries.map((s) => s.probeSucceededCount)),
        probeFailedCount: medianNumber(summaries.map((s) => s.probeFailedCount)),
        viewportProbeStartedCount: medianNumber(summaries.map((s) => s.viewportProbeStartedCount)),
        viewportProbeSucceededCount: medianNumber(summaries.map((s) => s.viewportProbeSucceededCount)),
        viewportProbeFailedCount: medianNumber(summaries.map((s) => s.viewportProbeFailedCount)),
        firstDimsKnownMs: medianNullable(summaries.map((s) => s.firstDimsKnownMs)),
        allViewportDimsKnownMs: medianNullable(summaries.map((s) => s.allViewportDimsKnownMs)),
        allViewportImagesLoadedMs: medianNullable(summaries.map((s) => s.allViewportImagesLoadedMs)),
        allDimsKnownMs: medianNullable(summaries.map((s) => s.allDimsKnownMs)),
        allImagesLoadedMs: medianNullable(summaries.map((s) => s.allImagesLoadedMs)),
        firstUnknownLoadMs: medianNullable(summaries.map((s) => s.firstUnknownLoadMs)),
        allUnknownLoadMs: medianNullable(summaries.map((s) => s.allUnknownLoadMs)),
        firstUnknownProbeMs: medianNullable(summaries.map((s) => s.firstUnknownProbeMs)),
        allUnknownProbeMs: medianNullable(summaries.map((s) => s.allUnknownProbeMs)),
        firstUnknownAppliedMs: medianNullable(summaries.map((s) => s.firstUnknownAppliedMs)),
        allUnknownAppliedMs: medianNullable(summaries.map((s) => s.allUnknownAppliedMs)),
        allViewportUnknownLoadMs: medianNullable(summaries.map((s) => s.allViewportUnknownLoadMs)),
        allViewportUnknownProbeMs: medianNullable(summaries.map((s) => s.allViewportUnknownProbeMs)),
        allViewportUnknownAppliedMs: medianNullable(summaries.map((s) => s.allViewportUnknownAppliedMs)),
        cls: medianNumber(summaries.map((s) => s.cls)),
        firstContentfulPaintMs: medianNullable(summaries.map((s) => s.firstContentfulPaintMs)),
        largestContentfulPaintMs: medianNullable(summaries.map((s) => s.largestContentfulPaintMs)),
        longTaskTotalMs: medianNumber(summaries.map((s) => s.longTaskTotalMs)),
        totalRequests: medianNumber(networks.map((n) => n.totalRequests)),
        failedRequests: medianNumber(networks.map((n) => n.failedRequests)),
        totalResponseBytes: medianNumber(networks.map((n) => n.totalResponseBytes)),
        imageRequests: medianNumber(networks.map((n) => n.imageRequests)),
        imageResponseBytes: medianNumber(networks.map((n) => n.imageResponseBytes)),
        rangeFetchRequests: medianNumber(networks.map((n) => n.rangeFetchRequests)),
        rangeFetchResponseBytes: medianNumber(networks.map((n) => n.rangeFetchResponseBytes)),
        byResourceType: {},
      },
    })
  }
  return out
}

function medianNumber(values: number[]): number {
  return percentile(values, 0.5)
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page'
}

function serializableArgs(args: Args): Omit<Args, 'urlsFile'> {
  const { urlsFile: _urlsFile, ...rest } = args
  return rest
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
  if (!result.ok) {
    process.stdout.write(
      `  x ${result.mode.padEnd(7)} run ${result.run}: ${result.errorName}: ${result.errorMessage}\n`,
    )
    return
  }
  const s = result.summary
  const n = result.network
  process.stdout.write(
    [
      `  ✓ ${result.mode.padEnd(7)} run ${result.run}`,
      `imgs ${s.imageCount}`,
      `unknown ${s.unknownImageCount}`,
      `above ${s.viewportUnknownImageCount}`,
      `probe ${s.probeSucceededCount}/${s.probeStartedCount}`,
      `aboveProbe ${s.viewportProbeSucceededCount}/${s.viewportProbeStartedCount}`,
      `firstDims ${formatMs(s.firstDimsKnownMs)}`,
      `aboveDims ${formatMs(s.allViewportDimsKnownMs)}`,
      `aboveImgs ${formatMs(s.allViewportImagesLoadedMs)}`,
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

async function writeReport(args: Args, report: Report): Promise<string | null> {
  if (!args.save && args.out === null) return null
  const outPath = args.out === null
    ? join(benchmarksDir, `full-page-loading-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    : resolve(args.out)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(report, null, 2))
  return outPath
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const urls = await loadUrls(args)
  const bundleSource = await buildBrowserBundle()
  const runs: RunResult[] = []

  process.stdout.write(`=== full-page-loading: ${urls.length} URL(s), modes ${args.modes.join(', ')} ===\n\n`)
  for (const url of urls) {
    process.stdout.write(`${url}\n`)
    for (let run = 1; run <= args.runs; run++) {
      for (const mode of args.modes) {
        const result = await runOne(args, bundleSource, url, mode, run)
        runs.push(result)
        printRun(result)
      }
    }
    process.stdout.write('\n')
  }

  const report: Report = {
    bench: 'full-page-loading',
    date: new Date().toISOString(),
    params: { ...serializableArgs(args), urls },
    runs,
    aggregate: aggregateRuns(runs),
  }
  const outPath = await writeReport(args, report)
  if (outPath !== null) process.stdout.write(`saved ${outPath.replace(`${repoRoot}/`, '')}\n`)

  const failed = runs.filter((run) => !run.ok)
  const passed = runs.length - failed.length
  process.stdout.write(`=== full-page-loading: ${passed}/${runs.length} runs completed ===\n`)
  const exitCode = (args.failOnRunError && failed.length > 0) || passed === 0 ? 1 : 0
  process.exit(exitCode)
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
