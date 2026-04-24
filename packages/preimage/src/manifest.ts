// Build-time manifest builder. Walks a directory, reads just the header
// bytes of each image, probes dimensions with the DOM-free core parsers,
// and returns a record keyed by a caller-chosen URL path.
//
// Intended use: call from a bundler plugin / build script, emit the
// result to JSON, have the client `recordKnownMeasurement(key, w, h)`
// each entry at startup. Result: first-load pages skip the network-
// for-dims step entirely — prepare(url) resolves synchronously from
// cache on every URL in the manifest.
//
// Uses `node:fs`, so this module is Node-only. The browser-safe
// primitives live in `./core` (probeImageBytes, measureFromSvgText).

import { open, readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { MAX_HEADER_BYTES, measureFromSvgText, probeImageBytes } from './core.js'

export type ManifestEntry = {
  width: number
  height: number
}

export type Manifest = Record<string, ManifestEntry>

export type BuildManifestOptions = {
  // Directory to walk recursively.
  root: string
  // Prefix prepended to each manifest key. Typical value: the URL
  // path your bundler serves the directory under (e.g. '/assets/').
  // Joined with forward slashes regardless of platform.
  base?: string
  // File extensions to include (lowercase, no dot). Defaults to the
  // formats probeImageBytes supports.
  extensions?: readonly string[]
  // Called for each file the probe skipped — unsupported format,
  // unreadable header, zero dims. Defaults to console.warn on stderr.
  onSkip?: (path: string, reason: string) => void
}

const DEFAULT_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'] as const
const JPEG_EXTENSIONS = new Set(['jpg', 'jpeg'])

export async function buildManifest(options: BuildManifestOptions): Promise<Manifest> {
  const root = resolve(options.root)
  const base = normalizeBase(options.base ?? '')
  const extensions = new Set((options.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()))
  const onSkip = options.onSkip ?? defaultOnSkip

  const manifest: Manifest = {}
  for await (const absPath of walk(root)) {
    const ext = extname(absPath)
    if (!extensions.has(ext)) continue

    const entry = await probeFile(absPath, ext)
    if (entry === null) {
      onSkip(absPath, `probe returned no dimensions (${ext})`)
      continue
    }

    const relPath = relative(root, absPath).split(/[\\/]/).join('/')
    const key = base === '' ? relPath : `${base}${relPath}`
    manifest[key] = entry
  }
  return manifest
}

// Walk: async iterator over every file path under root. Skips node_modules
// and dotfiles because those are almost never what you want to probe and
// they can make a `preimage-manifest .` against a source tree crawl for
// minutes.
async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

async function probeFile(path: string, ext: string): Promise<ManifestEntry | null> {
  if (ext === 'svg') {
    const text = await readFile(path, 'utf8')
    const dims = measureFromSvgText(text)
    return dims === null ? null : { width: dims.width, height: dims.height }
  }
  const bytes = await readPrefix(path, MAX_HEADER_BYTES)
  if (bytes === null) return null
  let probed = probeImageBytes(bytes)
  if (probed === null && JPEG_EXTENSIONS.has(ext)) {
    const fullBytes = await readFileBytes(path)
    if (fullBytes !== null && fullBytes.byteLength > bytes.byteLength) {
      probed = probeImageBytes(fullBytes)
    }
  }
  return probed === null ? null : { width: probed.width, height: probed.height }
}

// Read only the prefix most parsers need. JPEG gets a full-file retry
// in probeFile because EXIF / ICC APP segments can push SOF past 4KB.
async function readPrefix(path: string, maxBytes: number): Promise<Uint8Array | null> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (info.size === 0) return null
    const length = Math.min(maxBytes, info.size)
    const bytes = new Uint8Array(length)
    const { bytesRead } = await file.read(bytes, 0, length, 0)
    return bytesRead === length ? bytes : bytes.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const bytes = await readFile(path)
  if (bytes.length === 0) return null
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function extname(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return ''
  return path.slice(dot + 1).toLowerCase()
}

function normalizeBase(base: string): string {
  if (base === '') return ''
  return base.endsWith('/') ? base : `${base}/`
}

function defaultOnSkip(path: string, reason: string): void {
  process.stderr.write(`preimage-manifest: skipped ${path} (${reason})\n`)
}
