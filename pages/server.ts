// Dev server for the demo pages. Each demo HTML is a Bun HTML entry
// (bundling its TS + CSS dependencies on request); anything under
// /assets/ is served as static bytes. Bun's built-in HTML-only mode
// (`bun pages/*.html`) doesn't serve arbitrary static files, so we
// wrap it in a tiny server here.
//
// Also synthesises `.prei` container responses on-the-fly: a request
// for `/assets/.../foo.png.prei` wraps the real PNG with a 128-byte
// preimage container prefix. This lets the container demo work
// against the existing photo asset tree with no pre-built files.
import { serve } from 'bun'
import { join } from 'node:path'

import { probeImageBytes } from '@somnai-dreams/preimage/core'
import { encodeContainerPrefix, PREIMAGE_CONTAINER_SIZE, type ContainerFormat } from '@somnai-dreams/preimage/container'

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
import containerHtml from './demos/container.html'
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
    '/container.html': containerHtml,
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

      // .prei synthesis: wrap the underlying file in a 128-byte
      // preimage container. Demonstrates the Phase 3 "edge-worker
      // adapter" pattern from the swing-1 proposal — origins can ship
      // containers without pre-building files.
      if (rel.endsWith('.prei')) {
        return await servePreiContainer(rel, req)
      }

      const file = Bun.file(join(pagesRoot, rel))
      if (!(await file.exists())) {
        return new Response('not found', { status: 404 })
      }
      return new Response(file)
    },
  },
  development: true,
})

async function servePreiContainer(rel: string, req: Request): Promise<Response> {
  const underlyingRel = rel.slice(0, -'.prei'.length)
  const file = Bun.file(join(pagesRoot, underlyingRel))
  if (!(await file.exists())) return new Response('not found', { status: 404 })
  const payload = new Uint8Array(await file.arrayBuffer())
  const probed = probeImageBytes(payload.subarray(0, 4096))
  if (probed === null) return new Response('probe failed', { status: 500 })
  const format: ContainerFormat | null =
    probed.format === 'jpeg' ? 'jpeg'
    : probed.format === 'png' ? 'png'
    : probed.format === 'webp' ? 'webp'
    : null
  if (format === null) return new Response(`unsupported format ${probed.format}`, { status: 415 })
  const prefix = encodeContainerPrefix({
    width: probed.width,
    height: probed.height,
    format,
    hasAlpha: probed.hasAlpha,
    isProgressive: probed.isProgressive,
    thumbhash: new Uint8Array(24),
    sha256Prefix: new Uint8Array(8),
    payloadByteLength: payload.byteLength,
  })
  const fullLength = prefix.length + payload.length

  // Respect `Range: bytes=a-b` so `strategy: 'container'` fetches
  // exactly 128 bytes and the server answers in one TCP flight. If
  // the range is entirely within the prefix, skip reading the
  // payload into memory at all (it's already on disk).
  const rangeHeader = req.headers.get('range')
  if (rangeHeader !== null) {
    const match = rangeHeader.match(/^bytes=(\d+)-(\d+)?$/)
    if (match !== null) {
      const start = Number(match[1])
      const end = match[2] !== undefined ? Number(match[2]) : fullLength - 1
      if (start <= end && end < fullLength) {
        const out = new Uint8Array(end - start + 1)
        // Copy from prefix and/or payload as needed.
        const prefixEnd = Math.min(end + 1, prefix.length)
        if (start < prefix.length) out.set(prefix.subarray(start, prefixEnd), 0)
        if (end >= prefix.length) {
          const payloadStart = Math.max(0, start - prefix.length)
          const payloadEnd = end - prefix.length + 1
          const offset = start < prefix.length ? prefix.length - start : 0
          out.set(payload.subarray(payloadStart, payloadEnd), offset)
        }
        return new Response(out, {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${fullLength}`,
            'content-length': String(out.length),
            'accept-ranges': 'bytes',
            'content-type': 'application/octet-stream',
          },
        })
      }
    }
  }

  // No range: full container.
  const full = new Uint8Array(fullLength)
  full.set(prefix, 0)
  full.set(payload, prefix.length)
  return new Response(full, {
    status: 200,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(fullLength),
      'content-type': 'application/octet-stream',
    },
  })
}

console.log(`preimage demos: http://${server.hostname}:${server.port}`)
