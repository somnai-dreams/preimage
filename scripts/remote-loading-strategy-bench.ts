// Remote gallery loading sweep.
//
// This is intentionally separate from pages/bench/*. The demo benches
// measure user-facing pages; this harness gives CI and local tuning a
// repeatable browser run against hosted image bytes.
//
// Usage:
//   bun run scripts/remote-loading-strategy-bench.ts
//   bun run scripts/remote-loading-strategy-bench.ts --runs 3 --n 68

import { writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser } from 'playwright'

type Strategy = 'visible-first' | 'queued' | 'after-layout' | 'immediate'

type PhotoEntry = {
  file: string
  width: number
  height: number
}

type Args = {
  origin: string
  n: number
  runs: number
  strategies: Strategy[]
  concurrency: number
  renderConcurrency: number
  panelWidth: number
  viewportHeight: number
  scrollMs: number
  scrollDistance: number
  timeoutMs: number
  settleMs: number
  save: boolean
  failOnComparison: boolean
}

type BrowserRunConfig = {
  strategy: Strategy
  urls: string[]
  byteLengthByPath: Record<string, number>
  origin: string
  n: number
  concurrency: number
  renderConcurrency: number
  panelWidth: number
  viewportHeight: number
  scrollMs: number
  scrollDistance: number
  timeoutMs: number
  settleMs: number
}

type StrategyMetrics = {
  strategy: Strategy
  run: number
  n: number
  firstPlacementMs: number | null
  allPlacementsMs: number | null
  firstImageMs: number | null
  doneMs: number | null
  wallMs: number
  bytesTransferred: number
  estimatedLoadedImageBytes: number
  probedImageBytes: number
  resourceEntries: number
  probeResolves: number
  probeRejects: number
  renderStarts: number
  renderLoads: number
  renderErrors: number
  maxRenderInflight: number
  activeTilesAtDone: number
  sampleCount: number
  maxPendingVisible: number
  p95PendingVisibleRatio: number
  meanPendingVisibleRatio: number
  droppedFrames: number
}

type Check =
  | { ok: true; case: string; notes?: string }
  | { ok: false; case: string; reason: string }

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const photosPath = resolve(repoRoot, 'pages/assets/demos/photos/photos.json')
const tempDir = resolve(repoRoot, '.tmp/remote-loading-strategy-bench')

const DEFAULT_ORIGIN = 'https://preimage.dearlarry.co'
const DEFAULT_STRATEGIES: Strategy[] = ['visible-first', 'queued', 'after-layout', 'immediate']

function parseArgs(argv: string[]): Args {
  const args: Args = {
    origin: process.env.PREIMAGE_REMOTE_ORIGIN ?? DEFAULT_ORIGIN,
    n: Number(process.env.PREIMAGE_REMOTE_N ?? 24),
    runs: Number(process.env.PREIMAGE_REMOTE_RUNS ?? 1),
    strategies: DEFAULT_STRATEGIES.slice(),
    concurrency: Number(process.env.PREIMAGE_REMOTE_CONCURRENCY ?? 12),
    renderConcurrency: Number(process.env.PREIMAGE_REMOTE_RENDER_CONCURRENCY ?? 8),
    panelWidth: Number(process.env.PREIMAGE_REMOTE_PANEL_WIDTH ?? 840),
    viewportHeight: Number(process.env.PREIMAGE_REMOTE_VIEWPORT_HEIGHT ?? 620),
    scrollMs: Number(process.env.PREIMAGE_REMOTE_SCROLL_MS ?? 1400),
    scrollDistance: Number(process.env.PREIMAGE_REMOTE_SCROLL_DISTANCE ?? 2600),
    timeoutMs: Number(process.env.PREIMAGE_REMOTE_TIMEOUT_MS ?? 45000),
    settleMs: Number(process.env.PREIMAGE_REMOTE_SETTLE_MS ?? 250),
    save: process.env.PREIMAGE_REMOTE_NO_SAVE !== '1',
    failOnComparison: process.env.PREIMAGE_REMOTE_FAIL_ON_COMPARISON === '1',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} expects a value.`)
      return value
    }
    switch (arg) {
      case '--origin':
        args.origin = next()
        break
      case '--n':
        args.n = Number(next())
        break
      case '--runs':
        args.runs = Number(next())
        break
      case '--strategies':
        args.strategies = parseStrategies(next())
        break
      case '--concurrency':
        args.concurrency = Number(next())
        break
      case '--render-concurrency':
        args.renderConcurrency = Number(next())
        break
      case '--panel-width':
        args.panelWidth = Number(next())
        break
      case '--viewport-height':
        args.viewportHeight = Number(next())
        break
      case '--scroll-ms':
        args.scrollMs = Number(next())
        break
      case '--scroll-distance':
        args.scrollDistance = Number(next())
        break
      case '--timeout-ms':
        args.timeoutMs = Number(next())
        break
      case '--settle-ms':
        args.settleMs = Number(next())
        break
      case '--no-save':
        args.save = false
        break
      case '--fail-on-comparison':
        args.failOnComparison = true
        break
      case '--help':
        printUsage()
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  validateArgs(args)
  args.origin = args.origin.replace(/\/+$/, '')
  return args
}

function parseStrategies(raw: string): Strategy[] {
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (parsed.length === 0) throw new Error('--strategies must name at least one strategy.')
  for (const strategy of parsed) {
    if (!DEFAULT_STRATEGIES.includes(strategy as Strategy)) {
      throw new Error(`Unknown strategy "${strategy}". Expected one of ${DEFAULT_STRATEGIES.join(', ')}.`)
    }
  }
  return parsed as Strategy[]
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
  validatePositiveInteger('n', args.n)
  validatePositiveInteger('runs', args.runs)
  validatePositiveInteger('concurrency', args.concurrency)
  validatePositiveInteger('renderConcurrency', args.renderConcurrency)
  validatePositiveNumber('panelWidth', args.panelWidth)
  validatePositiveNumber('viewportHeight', args.viewportHeight)
  validatePositiveNumber('timeoutMs', args.timeoutMs)
  validateNonNegativeNumber('scrollMs', args.scrollMs)
  validateNonNegativeNumber('scrollDistance', args.scrollDistance)
  validateNonNegativeNumber('settleMs', args.settleMs)
  if (args.strategies.length === 0) throw new Error('At least one strategy is required.')
}

function printUsage(): void {
  process.stdout.write(`Remote loading strategy bench

Options:
  --origin URL                 Hosted image origin (default: ${DEFAULT_ORIGIN})
  --n COUNT                    Images per strategy run (default: 24)
  --runs COUNT                 Repeats per strategy (default: 1)
  --strategies LIST            Comma list: ${DEFAULT_STRATEGIES.join(',')}
  --concurrency COUNT          PrepareQueue concurrency (default: 12)
  --render-concurrency COUNT   Visible image render concurrency (default: 8)
  --scroll-ms MS               Scripted scroll duration (default: 1400)
  --scroll-distance PX         Scripted scroll distance (default: 2600)
  --timeout-ms MS              Per-strategy timeout (default: 45000)
  --no-save                    Do not write benchmarks/*.json
  --fail-on-comparison         Fail if queued trails visible-first by the soft UX guard
`)
}

async function loadPhotos(): Promise<PhotoEntry[]> {
  const photos = await Bun.file(photosPath).json() as PhotoEntry[]
  if (!Array.isArray(photos) || photos.length === 0) throw new Error(`No photos found at ${photosPath}.`)
  return photos
}

function urlsForRun(photos: PhotoEntry[], args: Args, run: number, strategy: Strategy): string[] {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${run}-${strategy}`
  const urls: string[] = []
  for (let i = 0; i < args.n; i++) {
    const file = photos[i % photos.length]!.file
    urls.push(`${args.origin}/assets/demos/photos/${file}?v=${token}-${i}`)
  }
  return urls
}

async function fetchContentLength(url: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal })
    if (!response.ok) return 0
    const raw = response.headers.get('content-length')
    if (raw === null) return 0
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  } finally {
    clearTimeout(timer)
  }
}

async function loadRemoteByteLengths(photos: PhotoEntry[], args: Args): Promise<Record<string, number>> {
  const files = new Set<string>()
  for (let i = 0; i < args.n; i++) files.add(photos[i % photos.length]!.file)
  const byPath: Record<string, number> = {}
  for (const file of files) {
    const pathname = `/assets/demos/photos/${file}`
    try {
      byPath[pathname] = await fetchContentLength(`${args.origin}${pathname}`, 10_000)
    } catch {
      byPath[pathname] = 0
    }
  }
  return byPath
}

async function buildBrowserBundle(): Promise<string> {
  await rm(tempDir, { recursive: true, force: true })
  await mkdir(tempDir, { recursive: true })
  const entryPath = join(tempDir, 'entry.ts')
  await writeFile(entryPath, browserEntrySource())
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: tempDir,
    target: 'browser',
    format: 'esm',
    sourcemap: 'inline',
  })
  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join('\n')
    throw new Error(`Browser bundle failed:\n${logs}`)
  }
  const bundlePath = join(tempDir, 'entry.js')
  if (!existsSync(bundlePath)) throw new Error(`Browser bundle missing at ${bundlePath}.`)
  return bundlePath
}

async function withServer<T>(bundlePath: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>remote-loading-strategy-bench</title>
  </head>
  <body>
    <script type="module" src="/entry.js"></script>
  </body>
</html>`
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/entry.js') {
        return new Response(Bun.file(bundlePath), {
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        })
      }
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  try {
    return await fn(`http://127.0.0.1:${server.port}`)
  } finally {
    server.stop(true)
  }
}

async function openBrowser(): Promise<Browser> {
  return await chromium.launch()
}

async function runBrowserSweep(
  args: Args,
  photos: PhotoEntry[],
  bundlePath: string,
  byteLengthByPath: Record<string, number>,
): Promise<StrategyMetrics[]> {
  return await withServer(bundlePath, async (baseUrl) => {
    const browser = await openBrowser()
    try {
      const page = await browser.newPage({
        viewport: {
          width: Math.max(1024, args.panelWidth + 80),
          height: Math.max(768, args.viewportHeight + 120),
        },
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: true,
      })
      page.on('pageerror', (err) => {
        process.stderr.write(`[browser pageerror] ${err.message}\n`)
      })
      page.on('console', (msg) => {
        if (msg.type() === 'error') process.stderr.write(`[browser console] ${msg.text()}\n`)
      })
      await page.goto(baseUrl, { waitUntil: 'load' })
      await page.waitForFunction(() => typeof (window as Window & { __runRemoteLoadingBench?: unknown }).__runRemoteLoadingBench === 'function')

      const runs: StrategyMetrics[] = []
      for (let run = 1; run <= args.runs; run++) {
        for (const strategy of args.strategies) {
          const config: BrowserRunConfig = {
            strategy,
            urls: urlsForRun(photos, args, run, strategy),
            byteLengthByPath,
            origin: args.origin,
            n: args.n,
            concurrency: args.concurrency,
            renderConcurrency: args.renderConcurrency,
            panelWidth: args.panelWidth,
            viewportHeight: args.viewportHeight,
            scrollMs: args.scrollMs,
            scrollDistance: args.scrollDistance,
            timeoutMs: args.timeoutMs,
            settleMs: args.settleMs,
          }
          const result = await page.evaluate(async (runConfig) => {
            const runner = (window as Window & {
              __runRemoteLoadingBench: (config: BrowserRunConfig) => Promise<StrategyMetrics>
            }).__runRemoteLoadingBench
            return await runner(runConfig)
          }, config)
          runs.push({ ...result, run })
        }
      }
      await page.close()
      return runs
    } finally {
      await browser.close()
    }
  })
}

function browserEntrySource(): string {
  return `
import { PrepareQueue } from '../../packages/preimage/src/prepare-queue.ts'
import { loadGallery } from '../../packages/preimage/src/loading.ts'
import { estimateFirstScreenCount, shortestColumnCursor } from '../../packages/layout-algebra/src/index.ts'

const COLUMNS = 4
const GAP = 4

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
  })
}

function createHarness(config) {
  document.body.innerHTML = ''
  document.body.style.margin = '0'
  document.body.style.background = '#fff'

  const scrollBox = document.createElement('div')
  scrollBox.id = 'remote-loading-scrollbox'
  scrollBox.style.cssText = [
    'position:relative',
    'box-sizing:border-box',
    'width:' + config.panelWidth + 'px',
    'height:' + config.viewportHeight + 'px',
    'overflow:auto',
    'border:0',
    'background:#f6f7f9',
    'contain:strict',
  ].join(';')

  const canvas = document.createElement('div')
  canvas.id = 'remote-loading-canvas'
  canvas.style.cssText = [
    'position:relative',
    'width:' + config.panelWidth + 'px',
    'height:0px',
    'background:#f6f7f9',
  ].join(';')

  const style = document.createElement('style')
  style.textContent = [
    '.bench-tile{position:absolute;box-sizing:border-box;overflow:hidden;background:#d8dde6;}',
    '.bench-tile::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,#d8dde6 0%,#eef1f5 45%,#d8dde6 100%);background-size:220% 100%;animation:remoteBenchPulse 1.2s linear infinite;}',
    '.bench-tile.has-image::before{display:none;}',
    '.bench-tile img{display:block;width:100%;height:100%;object-fit:cover;opacity:0;}',
    '.bench-tile img.loaded{opacity:1;}',
    '.bench-tile.image-error{background:#f7d7d7;}',
    '@keyframes remoteBenchPulse{from{background-position:0 0}to{background-position:-220% 0}}',
  ].join('\\n')

  scrollBox.appendChild(canvas)
  document.head.appendChild(style)
  document.body.appendChild(scrollBox)
  return { scrollBox, canvas, style }
}

function isTileVisible(tile, hostRect) {
  const rect = tile.getBoundingClientRect()
  return rect.bottom > hostRect.top && rect.top < hostRect.bottom && rect.right > hostRect.left && rect.left < hostRect.right
}

function summarizeSamples(samples) {
  const ratios = samples.map((sample) => sample.visible === 0 ? 0 : sample.pending / sample.visible)
  return {
    sampleCount: samples.length,
    maxPendingVisible: samples.reduce((max, sample) => Math.max(max, sample.pending), 0),
    p95PendingVisibleRatio: percentile(ratios, 95),
    meanPendingVisibleRatio: ratios.length === 0 ? 0 : ratios.reduce((sum, v) => sum + v, 0) / ratios.length,
    droppedFrames: samples.filter((sample) => sample.frameMs > 50).length,
  }
}

function collectResourceBytes(urlSet) {
  let bytes = 0
  let entries = 0
  for (const entry of performance.getEntriesByType('resource')) {
    const parsed = new URL(entry.name, location.href)
    const key = parsed.pathname + parsed.search
    if (!urlSet.has(key)) continue
    const resource = entry
    bytes += Math.max(resource.transferSize || 0, resource.encodedBodySize || 0)
    entries++
  }
  return { bytes, entries }
}

async function runRemoteLoadingBench(config) {
  performance.clearResourceTimings()
  performance.setResourceTimingBufferSize?.(Math.max(3000, config.urls.length * 8))
  const t0 = performance.now()
  const { scrollBox, canvas, style } = createHarness(config)
  await nextFrame()

  const packer = shortestColumnCursor({ columns: COLUMNS, gap: GAP, panelWidth: config.panelWidth })
  const firstK = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth: config.panelWidth,
    viewportHeight: config.viewportHeight,
    gap: GAP,
    columns: COLUMNS,
  })
  const phaseTimes = {}
  const samples = []
  const imageByTile = new WeakMap()
  let renderStarts = 0
  let renderLoads = 0
  let renderErrors = 0
  let renderInflight = 0
  let maxRenderInflight = 0
  let estimatedLoadedImageBytes = 0
  let probedImageBytes = 0
  let probeResolves = 0
  let probeRejects = 0
  let scrollStarted = false
  let scrollPromise = Promise.resolve()
  let lastFrameAt = performance.now()
  const innerQueue = new PrepareQueue({ concurrency: config.concurrency })
  const queue = {
    enqueue(src, options) {
      return innerQueue.enqueue(src, options).then((prepared) => {
        probeResolves++
        probedImageBytes += prepared.byteLength || 0
        return prepared
      }, (err) => {
        probeRejects++
        throw err
      })
    },
    boostMany(srcs) {
      innerQueue.boostMany(srcs)
    },
  }

  const urlSet = new Set(config.urls.map((raw) => {
    const parsed = new URL(raw, location.href)
    return parsed.pathname + parsed.search
  }))

  function sample() {
    const now = performance.now()
    const hostRect = scrollBox.getBoundingClientRect()
    let visible = 0
    let pending = 0
    for (const tile of Array.from(canvas.querySelectorAll('.bench-tile'))) {
      if (!isTileVisible(tile, hostRect)) continue
      visible++
      if (!tile.classList.contains('has-image')) pending++
    }
    samples.push({
      t: now - t0,
      frameMs: now - lastFrameAt,
      visible,
      pending,
      scrollTop: scrollBox.scrollTop,
    })
    lastFrameAt = now
  }

  function startScroll() {
    if (scrollStarted || config.scrollMs <= 0) return
    scrollStarted = true
    scrollPromise = new Promise((resolve) => {
      const start = performance.now()
      const step = (now) => {
        const elapsed = now - start
        const progress = Math.min(1, elapsed / config.scrollMs)
        const eased = 1 - Math.pow(1 - progress, 3)
        const maxScroll = Math.max(0, canvas.scrollHeight - scrollBox.clientHeight)
        scrollBox.scrollTop = Math.min(maxScroll, config.scrollDistance * eased)
        sample()
        if (progress < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }

  const gallery = loadGallery({
    urls: config.urls,
    scrollContainer: scrollBox,
    contentContainer: canvas,
    packer,
    imageLoading: config.strategy,
    overscan: { ahead: 620, behind: 160 },
    probe: {
      queue,
      options: { dimsOnly: true, strategy: 'auto', fallbackToImgOnFetchError: true },
      boostFirstScreen: firstK,
    },
    renderConcurrency: config.renderConcurrency,
    renderSkeleton(el, idx, place) {
      el.className = 'bench-tile'
      el.dataset.index = String(idx)
      el.style.left = place.x + 'px'
      el.style.top = place.y + 'px'
      el.style.width = place.width + 'px'
      el.style.height = place.height + 'px'
    },
    renderImage(el, _idx, url) {
      if (imageByTile.get(el) === url && el.querySelector('img') !== null) return
      const previous = el.querySelector('img')
      if (previous !== null) {
        previous.dataset.cancelled = '1'
        previous.src = ''
      }
      el.textContent = ''
      el.className = 'bench-tile'
      imageByTile.set(el, url)
      const img = new Image()
      img.alt = ''
      renderStarts++
      renderInflight++
      maxRenderInflight = Math.max(maxRenderInflight, renderInflight)
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        renderInflight--
        const stillCurrent = imageByTile.get(el) === url && img.dataset.cancelled !== '1'
        if (!stillCurrent) return
        if (ok) {
          renderLoads++
          const pathname = new URL(url, location.href).pathname
          estimatedLoadedImageBytes += config.byteLengthByPath[pathname] || 0
          img.className = 'loaded'
          el.className = 'bench-tile has-image'
        } else {
          renderErrors++
          el.className = 'bench-tile image-error'
        }
      }
      img.addEventListener('load', () => finish(true), { once: true })
      img.addEventListener('error', () => finish(false), { once: true })
      img.src = url
      el.appendChild(img)
      if (img.complete && img.naturalWidth > 0) finish(true)
    },
    resetTile(el) {
      const img = el.querySelector('img')
      if (img !== null) {
        img.dataset.cancelled = '1'
        img.src = ''
      }
      imageByTile.delete(el)
      el.textContent = ''
      el.className = 'bench-tile'
    },
    onPhase(phase, elapsedMs) {
      phaseTimes[phase] = elapsedMs
      if (phase === 'first-placement') startScroll()
    },
  })

  try {
    await Promise.race([gallery.done, timeout(config.timeoutMs, config.strategy)])
    await scrollPromise
    if (config.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, config.settleMs))
    sample()
    const resource = collectResourceBytes(urlSet)
    const sampleSummary = summarizeSamples(samples)
    return {
      strategy: config.strategy,
      run: 0,
      n: config.n,
      firstPlacementMs: phaseTimes['first-placement'] ?? null,
      allPlacementsMs: phaseTimes['all-placements'] ?? null,
      firstImageMs: phaseTimes['first-image'] ?? null,
      doneMs: phaseTimes.done ?? null,
      wallMs: performance.now() - t0,
      bytesTransferred: resource.bytes,
      estimatedLoadedImageBytes,
      probedImageBytes,
      resourceEntries: resource.entries,
      probeResolves,
      probeRejects,
      renderStarts,
      renderLoads,
      renderErrors,
      maxRenderInflight,
      activeTilesAtDone: canvas.querySelectorAll('.bench-tile').length,
      ...sampleSummary,
    }
  } finally {
    gallery.destroy()
    scrollBox.remove()
    style.remove()
  }
}

window.__runRemoteLoadingBench = runRemoteLoadingBench
`
}

function formatMs(value: number | null): string {
  if (value === null) return '-'
  if (value < 1) return `${value.toFixed(2)}ms`
  return `${value.toFixed(0)}ms`
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function aggregateByStrategy(runs: StrategyMetrics[]): StrategyMetrics[] {
  const grouped = new Map<Strategy, StrategyMetrics[]>()
  for (const run of runs) {
    const list = grouped.get(run.strategy) ?? []
    list.push(run)
    grouped.set(run.strategy, list)
  }
  const out: StrategyMetrics[] = []
  for (const [strategy, list] of grouped) {
    const first = list[0]!
    const nullableMean = (key: keyof StrategyMetrics): number | null => {
      const values = list.map((run) => run[key]).filter((value): value is number => typeof value === 'number')
      return values.length === 0 ? null : mean(values)
    }
    out.push({
      ...first,
      strategy,
      run: 0,
      firstPlacementMs: nullableMean('firstPlacementMs'),
      allPlacementsMs: nullableMean('allPlacementsMs'),
      firstImageMs: nullableMean('firstImageMs'),
      doneMs: nullableMean('doneMs'),
      wallMs: mean(list.map((run) => run.wallMs)),
      bytesTransferred: mean(list.map((run) => run.bytesTransferred)),
      estimatedLoadedImageBytes: mean(list.map((run) => run.estimatedLoadedImageBytes)),
      probedImageBytes: mean(list.map((run) => run.probedImageBytes)),
      resourceEntries: mean(list.map((run) => run.resourceEntries)),
      probeResolves: mean(list.map((run) => run.probeResolves)),
      probeRejects: mean(list.map((run) => run.probeRejects)),
      renderStarts: mean(list.map((run) => run.renderStarts)),
      renderLoads: mean(list.map((run) => run.renderLoads)),
      renderErrors: mean(list.map((run) => run.renderErrors)),
      maxRenderInflight: mean(list.map((run) => run.maxRenderInflight)),
      activeTilesAtDone: mean(list.map((run) => run.activeTilesAtDone)),
      sampleCount: mean(list.map((run) => run.sampleCount)),
      maxPendingVisible: mean(list.map((run) => run.maxPendingVisible)),
      p95PendingVisibleRatio: mean(list.map((run) => run.p95PendingVisibleRatio)),
      meanPendingVisibleRatio: mean(list.map((run) => run.meanPendingVisibleRatio)),
      droppedFrames: mean(list.map((run) => run.droppedFrames)),
    })
  }
  return out
}

function printMetrics(runs: StrategyMetrics[]): void {
  const aggregate = aggregateByStrategy(runs)
  process.stdout.write('\nstrategy        firstPlace  allPlace  firstImg  done     imgBytes  imgStarts  maxImg  meanPend  dropped\n')
  process.stdout.write('-----------------------------------------------------------------------------------------------------\n')
  for (const run of aggregate) {
    process.stdout.write(
      `${run.strategy.padEnd(15)} ` +
      `${formatMs(run.firstPlacementMs).padStart(10)} ` +
      `${formatMs(run.allPlacementsMs).padStart(9)} ` +
      `${formatMs(run.firstImageMs).padStart(8)} ` +
      `${formatMs(run.doneMs).padStart(8)} ` +
      `${formatBytes(run.estimatedLoadedImageBytes).padStart(8)} ` +
      `${run.renderStarts.toFixed(1).padStart(9)} ` +
      `${run.maxRenderInflight.toFixed(1).padStart(6)} ` +
      `${(run.meanPendingVisibleRatio * 100).toFixed(0).padStart(8)}% ` +
      `${run.droppedFrames.toFixed(1).padStart(7)}\n`,
    )
  }
  const queued = aggregate.find((run) => run.strategy === 'queued')
  const visible = aggregate.find((run) => run.strategy === 'visible-first')
  if (queued !== undefined && visible !== undefined) {
    const firstImageDelta = (queued.firstImageMs ?? 0) - (visible.firstImageMs ?? 0)
    const pendingDelta = queued.meanPendingVisibleRatio - visible.meanPendingVisibleRatio
    process.stdout.write(
      `\nqueued vs visible-first: first image ${firstImageDelta >= 0 ? '+' : ''}${firstImageDelta.toFixed(0)}ms, ` +
      `mean pending visible ${(pendingDelta * 100 >= 0 ? '+' : '')}${(pendingDelta * 100).toFixed(0)} points\n`,
    )
  }
}

function checkResults(runs: StrategyMetrics[], args: Args): Check[] {
  const checks: Check[] = []
  for (const run of runs) {
    const prefix = `remote-loading/${run.strategy}/run-${run.run}`
    if (run.firstPlacementMs === null) checks.push({ ok: false, case: `${prefix}/first-placement`, reason: 'missing first-placement phase' })
    else checks.push({ ok: true, case: `${prefix}/first-placement`, notes: formatMs(run.firstPlacementMs) })
    if (run.allPlacementsMs === null) checks.push({ ok: false, case: `${prefix}/all-placements`, reason: 'missing all-placements phase' })
    else checks.push({ ok: true, case: `${prefix}/all-placements`, notes: formatMs(run.allPlacementsMs) })
    if (run.firstImageMs === null) checks.push({ ok: false, case: `${prefix}/first-image`, reason: 'no visible image reached load' })
    else checks.push({ ok: true, case: `${prefix}/first-image`, notes: formatMs(run.firstImageMs) })
    if (run.doneMs === null) checks.push({ ok: false, case: `${prefix}/done`, reason: 'missing done phase' })
    else checks.push({ ok: true, case: `${prefix}/done`, notes: formatMs(run.doneMs) })
    if (run.renderErrors > 0) checks.push({ ok: false, case: `${prefix}/image-errors`, reason: `${run.renderErrors} image errors` })
    else checks.push({ ok: true, case: `${prefix}/image-errors` })
    if (run.probeRejects > 0) checks.push({ ok: false, case: `${prefix}/probe-errors`, reason: `${run.probeRejects} probe errors` })
    else checks.push({ ok: true, case: `${prefix}/probe-errors` })
    if (run.renderStarts < 1) checks.push({ ok: false, case: `${prefix}/render-starts`, reason: 'no visible image requests started' })
    else checks.push({ ok: true, case: `${prefix}/render-starts`, notes: `${run.renderStarts}` })
    if (run.renderLoads < 1) checks.push({ ok: false, case: `${prefix}/render-loads`, reason: 'no visible image requests loaded' })
    else checks.push({ ok: true, case: `${prefix}/render-loads`, notes: `${run.renderLoads}` })
    if (run.activeTilesAtDone < 1) checks.push({ ok: false, case: `${prefix}/active-tiles`, reason: 'no mounted tiles at done' })
    else checks.push({ ok: true, case: `${prefix}/active-tiles`, notes: `${run.activeTilesAtDone}` })
    if (args.scrollMs > 0 && run.sampleCount < 2) checks.push({ ok: false, case: `${prefix}/scroll-samples`, reason: `${run.sampleCount} samples` })
    else checks.push({ ok: true, case: `${prefix}/scroll-samples`, notes: `${run.sampleCount}` })
  }

  if (args.failOnComparison) {
    const aggregate = aggregateByStrategy(runs)
    const queued = aggregate.find((run) => run.strategy === 'queued')
    const visible = aggregate.find((run) => run.strategy === 'visible-first')
    if (queued !== undefined && visible !== undefined) {
      const queuedFirstImage = queued.firstImageMs ?? Number.POSITIVE_INFINITY
      const visibleFirstImage = visible.firstImageMs ?? Number.POSITIVE_INFINITY
      const pendingSlack = visible.meanPendingVisibleRatio + 0.20
      if (queuedFirstImage > visibleFirstImage + 1000 || queued.meanPendingVisibleRatio > pendingSlack) {
        checks.push({
          ok: false,
          case: 'remote-loading/queued-vs-visible-first',
          reason: `queued firstImage=${formatMs(queued.firstImageMs)}, visible-first=${formatMs(visible.firstImageMs)}, queued mean pending=${(queued.meanPendingVisibleRatio * 100).toFixed(0)}%, visible-first=${(visible.meanPendingVisibleRatio * 100).toFixed(0)}%`,
        })
      } else {
        checks.push({ ok: true, case: 'remote-loading/queued-vs-visible-first' })
      }
    }
  }

  return checks
}

async function saveRun(
  args: Args,
  runs: StrategyMetrics[],
  checks: Check[],
  wallMs: number,
  byteLengthByPath: Record<string, number>,
): Promise<string | null> {
  if (!args.save) return null
  const outDir = resolve(repoRoot, 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `remote-loading-strategy-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'remote-loading-strategy',
        date: new Date().toISOString(),
        origin: args.origin,
        byteLengthByPath,
        wallMs,
        params: {
          n: args.n,
          runs: args.runs,
          strategies: args.strategies,
          concurrency: args.concurrency,
          renderConcurrency: args.renderConcurrency,
          panelWidth: args.panelWidth,
          viewportHeight: args.viewportHeight,
          scrollMs: args.scrollMs,
          scrollDistance: args.scrollDistance,
          timeoutMs: args.timeoutMs,
          failOnComparison: args.failOnComparison,
        },
        results: {
          aggregate: aggregateByStrategy(runs),
          runs,
          checks,
        },
      },
      null,
      2,
    ),
  )
  return outPath
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const t0 = performance.now()
  try {
    const photos = await loadPhotos()
    const byteLengthByPath = await loadRemoteByteLengths(photos, args)
    const bundlePath = await buildBrowserBundle()
    const runs = await runBrowserSweep(args, photos, bundlePath, byteLengthByPath)
    const wallMs = performance.now() - t0
    const checks = checkResults(runs, args)
    const passed = checks.filter((check) => check.ok).length
    const failed = checks.filter((check) => !check.ok)

    printMetrics(runs)
    process.stdout.write(`\n=== remote-loading-strategy: ${passed}/${checks.length} passed in ${wallMs.toFixed(0)}ms ===\n`)
    if (failed.length > 0) {
      process.stdout.write(`\n=== FAILURES (${failed.length}) ===\n`)
      for (const check of failed) {
        if (!check.ok) process.stdout.write(`  x ${check.case}: ${check.reason}\n`)
      }
    }
    const outPath = await saveRun(args, runs, checks, wallMs, byteLengthByPath)
    if (outPath !== null) process.stdout.write(`=== Saved ${outPath} ===\n`)
    if (failed.length > 0) process.exit(1)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`)
  process.exit(1)
})
