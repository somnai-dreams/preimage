// Dev server for the demo pages. Each demo HTML is a Bun HTML entry
// (bundling its TS + CSS dependencies on request); anything under
// /assets/ is served as static bytes. Bun's built-in HTML-only mode
// (`bun pages/*.html`) doesn't serve arbitrary static files, so we
// wrap it in a tiny server here.
//
// Also hosts the reference implementation of the batched-probe
// endpoint (Swing 2 spike): POST /preimage/probe accepts a
// binary-encoded list of URLs, returns a binary-encoded record per
// URL with dims + flags read from the local file's first 4KB. One
// RTT for N probes.
import { serve } from 'bun'
import { join } from 'node:path'

import { probeImageBytes } from '@somnai-dreams/preimage/core'
import {
  decodeBatchedRequest,
  encodeBatchedResponse,
  type BatchedProbeFormat,
  type BatchedProbeRecord,
} from '@somnai-dreams/preimage/batched-probe'

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
import benchBatchedProbeHtml from './bench/batched-probe.html'

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
    '/bench/batched-probe.html': benchBatchedProbeHtml,
    '/preimage/probe': async (req) => {
      if (req.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const bytes = new Uint8Array(await req.arrayBuffer())
      let urls: string[]
      try {
        urls = decodeBatchedRequest(bytes)
      } catch {
        return new Response('malformed request', { status: 400 })
      }
      const records = await Promise.all(urls.map((url, i) => probeUrlForBatch(url, i)))
      const out = encodeBatchedResponse(records)
      const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
      return new Response(buf, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
        },
      })
    },
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

// --- Batched-probe endpoint impl ---

const PROBE_FORMAT_MAP: Record<string, BatchedProbeFormat> = {
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
}

async function probeUrlForBatch(url: string, clientIndex: number): Promise<BatchedProbeRecord> {
  // Support relative URLs (from the same origin) and absolute URLs
  // that map into the pages/ tree. For the spike we only handle
  // same-origin paths — production impls would validate + whitelist.
  let relPath: string
  try {
    const parsed = new URL(url, `http://${hostname}:${port}`)
    relPath = parsed.pathname.replace(/^\/+/, '')
  } catch {
    return { clientIndex, status: 'not-found' }
  }
  const file = Bun.file(join(pagesRoot, relPath))
  if (!(await file.exists())) return { clientIndex, status: 'not-found' }
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  const probed = probeImageBytes(head)
  if (probed === null) return { clientIndex, status: 'probe-failed' }
  const format = PROBE_FORMAT_MAP[probed.format] ?? 'other'
  return {
    clientIndex,
    status: 'ok',
    width: probed.width,
    height: probed.height,
    hasAlpha: probed.hasAlpha,
    isProgressive: probed.isProgressive,
    format,
    byteLength: file.size,
  }
}
