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
import benchIndexHtml from './bench/index.html'
import benchProbeHtml from './bench/probe.html'
import benchSweepHtml from './bench/sweep.html'
import benchPackingHtml from './bench/packing.html'
import benchCompareHtml from './bench/compare.html'
import benchFirstScreenHtml from './bench/first-screen.html'
import benchVirtualScrollHtml from './bench/virtual-scroll.html'

const port = Number(Bun.env.PORT ?? 3000)
const hostname = Bun.env.HOST ?? '0.0.0.0'
const pagesRoot = import.meta.dir

const server = serve({
  port,
  hostname,
  routes: {
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
    '/bench/': benchIndexHtml,
    '/bench/index.html': benchIndexHtml,
    '/bench/probe.html': benchProbeHtml,
    '/bench/sweep.html': benchSweepHtml,
    '/bench/packing.html': benchPackingHtml,
    '/bench/compare.html': benchCompareHtml,
    '/bench/first-screen.html': benchFirstScreenHtml,
    '/bench/virtual-scroll.html': benchVirtualScrollHtml,
    '/assets/*': async (req) => {
      // Strip leading "/" and map into pages/assets/.
      const url = new URL(req.url)
      const rel = url.pathname.replace(/^\/+/, '')
      const file = Bun.file(join(pagesRoot, rel))
      if (!(await file.exists())) {
        return new Response('not found', { status: 404 })
      }
      return new Response(file)
    },
  },
  development: true,
})

console.log(`preimage demos: http://${server.hostname}:${server.port}`)
