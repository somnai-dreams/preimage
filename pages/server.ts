// Dev server for the demo pages. Each demo HTML is a Bun HTML entry
// (bundling its TS + CSS dependencies on request); anything under
// /assets/ is served as static bytes. Bun's built-in HTML-only mode
// (`bun pages/*.html`) doesn't serve arbitrary static files, so we
// wrap it in a tiny server here.
//
// Image requests under /assets/ also carry the preimage header
// convention — `Preimage-Width`, `Preimage-Height`, etc. — so the
// `strategy: 'headers'` probe resolves via a HEAD with zero body
// bytes. And requests for `<image-url>.prei` get synthesized text
// sidecars on the fly, demonstrating the static-file-origin path.
import { serve } from 'bun'
import { extname, join } from 'node:path'

import { probeImageBytes } from '@somnai-dreams/preimage/core'
import {
  encodeSidecar,
  SIDECAR_EXTENSION,
  sidecarToResponseHeaders,
  type SidecarFormat,
} from '@somnai-dreams/preimage/sidecar'

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
import sidecarHtml from './demos/sidecar.html'
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
    '/sidecar.html': sidecarHtml,
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

      // Sidecar synthesis: `<image-url>.prei` returns a text file of
      // Preimage-* fields, parseable by strategy: 'sidecar'.
      if (rel.endsWith(SIDECAR_EXTENSION)) {
        return await servePreiSidecar(rel)
      }

      const file = Bun.file(join(pagesRoot, rel))
      if (!(await file.exists())) {
        return new Response('not found', { status: 404 })
      }

      // Preimage-aware origin path: for image responses, attach the
      // Preimage-* headers so strategy: 'headers' resolves via HEAD
      // with zero body transfer.
      const format = extToFormat(rel)
      if (format !== null) {
        const headers = await buildImageHeaders(file, format)
        if (headers !== null) {
          if (req.method === 'HEAD') {
            return new Response(null, { status: 200, headers })
          }
          return new Response(file, { status: 200, headers })
        }
      }

      return new Response(file)
    },
  },
  development: true,
})

async function servePreiSidecar(rel: string): Promise<Response> {
  const underlyingRel = rel.slice(0, -SIDECAR_EXTENSION.length)
  const file = Bun.file(join(pagesRoot, underlyingRel))
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  const format = extToFormat(underlyingRel)
  if (format === null) {
    return new Response(`unsupported format`, { status: 415 })
  }
  const payload = new Uint8Array(await file.arrayBuffer())
  const probed = probeImageBytes(payload.subarray(0, 4096))
  if (probed === null) return new Response('probe failed', { status: 500 })
  const text = encodeSidecar({
    width: probed.width,
    height: probed.height,
    format,
    byteLength: payload.byteLength,
    hasAlpha: probed.hasAlpha,
    isProgressive: probed.isProgressive,
    sha: '',
    thumbhash: '',
  })
  return new Response(text, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(text, 'utf8')),
    },
  })
}

async function buildImageHeaders(
  file: ReturnType<typeof Bun.file>,
  format: SidecarFormat,
): Promise<Record<string, string> | null> {
  // Read the first 4KB for the probe without materializing the whole
  // payload. Bun.file.slice returns a Blob view, so arrayBuffer() is
  // the range read.
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const probed = probeImageBytes(head)
  if (probed === null) return null
  return sidecarToResponseHeaders({
    width: probed.width,
    height: probed.height,
    format,
    byteLength: file.size,
    hasAlpha: probed.hasAlpha,
    isProgressive: probed.isProgressive,
    sha: '',
    thumbhash: '',
  })
}

function extToFormat(path: string): SidecarFormat | null {
  const ext = extname(path).replace(/^\./, '').toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  if (ext === 'png') return 'png'
  if (ext === 'webp') return 'webp'
  if (ext === 'gif') return 'gif'
  if (ext === 'bmp') return 'bmp'
  return null
}

console.log(`preimage demos: http://${server.hostname}:${server.port}`)
