// Dev server for the demo pages. Each demo HTML is a Bun HTML entry
// (bundling its TS + CSS dependencies on request); anything under
// /assets/ is served as static bytes. Bun's built-in HTML-only mode
// (`bun pages/*.html`) doesn't serve arbitrary static files, so we
// wrap it in a tiny server here.
import { serve } from 'bun'
import { join } from 'node:path'

import indexHtml from './demos/index.html'
import masonryHtml from './demos/masonry.html'
import editorialHtml from './demos/editorial.html'
import ttfsHtml from './demos/ttfs.html'
import decodePoolHtml from './demos/decode-pool.html'
import scaleHtml from './demos/scale.html'
import virtualHtml from './demos/virtual.html'
import manifestHtml from './demos/manifest.html'
import streamHtml from './demos/stream.html'
import dropzoneHtml from './demos/dropzone.html'
import chatHtml from './demos/chat.html'
import instantHtml from './demos/instant.html'
import benchIndexHtml from './bench/index.html'
import benchProbeHtml from './bench/probe.html'
import benchSweepHtml from './bench/sweep.html'
import benchPackingHtml from './bench/packing.html'
import benchCompareHtml from './bench/compare.html'
import benchFirstScreenHtml from './bench/first-screen.html'
import benchVirtualScrollHtml from './bench/virtual-scroll.html'
import benchLoadingPatternHtml from './bench/loading-pattern.html'
import benchRangeSizingHtml from './bench/range-sizing.html'
import benchPredictHtml from './bench/predict.html'

const startPort = readPort(Bun.env.PORT, 3000)
const hostname = Bun.env.HOST ?? '0.0.0.0'
const pagesRoot = import.meta.dir
const repoRoot = join(pagesRoot, '..')

const routes = {
  '/': indexHtml,
  '/index.html': indexHtml,
  '/masonry.html': masonryHtml,
  '/editorial.html': editorialHtml,
  '/ttfs.html': ttfsHtml,
  '/decode-pool.html': decodePoolHtml,
  '/scale.html': scaleHtml,
  '/virtual.html': virtualHtml,
  '/manifest.html': manifestHtml,
  '/stream.html': streamHtml,
  '/dropzone.html': dropzoneHtml,
  '/chat.html': chatHtml,
  '/instant.html': instantHtml,
  '/bench/': benchIndexHtml,
  '/bench/index.html': benchIndexHtml,
  '/bench/probe.html': benchProbeHtml,
  '/bench/sweep.html': benchSweepHtml,
  '/bench/packing.html': benchPackingHtml,
  '/bench/compare.html': benchCompareHtml,
  '/bench/first-screen.html': benchFirstScreenHtml,
  '/bench/virtual-scroll.html': benchVirtualScrollHtml,
  '/bench/loading-pattern.html': benchLoadingPatternHtml,
  '/bench/range-sizing.html': benchRangeSizingHtml,
  '/bench/predict.html': benchPredictHtml,
  '/benchmarks/*': async (req: Request) => {
    // Serve bench-output JSON corpora so browser-side bench pages can
    // iterate over URLs collected by the node-side harnesses.
    const url = new URL(req.url)
    const rel = url.pathname.replace(/^\/+/, '')
    const file = Bun.file(join(repoRoot, rel))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    return new Response(file, { headers: { 'content-type': 'application/json' } })
  },
  '/assets/*': async (req: Request) => {
    // Strip leading "/" and map into pages/assets/.
    const url = new URL(req.url)
    const rel = url.pathname.replace(/^\/+/, '')
    const file = Bun.file(join(pagesRoot, rel))
    if (!(await file.exists())) {
      return new Response('not found', { status: 404 })
    }
    return new Response(file)
  },
}

const server = serveWithPortFallback(startPort)

console.log(`preimage demos: http://${server.hostname}:${server.port}`)

function serveWithPortFallback(port: number): ReturnType<typeof serve> {
  const maxAttempts = 50
  for (let offset = 0; offset < maxAttempts && port + offset <= 65535; offset++) {
    const candidate = port + offset
    try {
      const server = serve({
        port: candidate,
        hostname,
        routes,
        development: true,
      })
      if (candidate !== port) {
        console.warn(`port ${port} busy; using ${candidate}`)
      }
      return server
    } catch (err) {
      if (!isPortInUseError(err)) throw err
    }
  }
  throw new Error(`No open port found from ${port} through ${Math.min(65535, port + maxAttempts - 1)}`)
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RangeError(`PORT must be an integer between 1 and 65535; got ${value}`)
  }
  return port
}

function isPortInUseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code
  return code === 'EADDRINUSE' || /address already in use|port .*in use|EADDRINUSE/i.test(err.message)
}
