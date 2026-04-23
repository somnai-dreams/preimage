#!/usr/bin/env node
// preimage-sidecar — emit `.prei` text files next to images.
//
//   preimage-sidecar <in.jpg> <out.jpg.prei>              one file
//   preimage-sidecar --batch <in-dir> [--inplace]         walk a tree
//
// The sidecar is a plain-text `Key: Value` file, same format as the
// HTTP response headers a preimage-aware origin would set. Image
// payload is untouched — the sidecar sits next to it.
//
//   preimage-sidecar photo.jpg photo.jpg.prei
//   # writes:
//   #   Preimage-Version: 1
//   #   Preimage-Width: 1920
//   #   Preimage-Height: 1080
//   #   Preimage-Format: jpeg
//   #   Preimage-Byte-Length: 483721
//   #   Preimage-Progressive: 1
//   #   Preimage-Sha: 7688025819abcdef
//
// --batch walks a directory. --inplace writes sidecars next to their
// source files (`photo.jpg` → `photo.jpg.prei`); omitted, a mirror
// output directory is required as the second positional.

import { createHash } from 'node:crypto'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

import { probeImageBytes } from './probe.js'
import {
  encodeSidecar,
  SIDECAR_EXTENSION,
  type SidecarFormat,
} from './sidecar.js'

type ParsedArgs = {
  batch: boolean
  inplace: boolean
  input: string | null
  output: string | null
  help: boolean
  computeSha: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    batch: false,
    inplace: false,
    input: null,
    output: null,
    help: false,
    computeSha: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--batch') args.batch = true
    else if (a === '--inplace') args.inplace = true
    else if (a === '--no-sha') args.computeSha = false
    else if (!a.startsWith('-') && args.input === null) args.input = a
    else if (!a.startsWith('-') && args.output === null) args.output = a
    else {
      process.stderr.write(`preimage-sidecar: unknown arg "${a}"\n`)
      process.exit(2)
    }
  }
  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  preimage-sidecar <in> <out>                     wrap one file',
      '  preimage-sidecar --batch <in-dir> <out-dir>     mirror a tree',
      '  preimage-sidecar --batch --inplace <dir>        write next to sources',
      '',
      'Options:',
      '  --no-sha        Skip sha256 prefix computation (faster)',
      '  --help, -h      Show this message',
      '',
      'Produces text files of Preimage-* headers. Image payload is untouched.',
      '',
    ].join('\n'),
  )
}

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
])

function extToFormat(ext: string): SidecarFormat | null {
  const e = ext.toLowerCase()
  if (e === 'jpg' || e === 'jpeg') return 'jpeg'
  if (e === 'png') return 'png'
  if (e === 'webp') return 'webp'
  if (e === 'gif') return 'gif'
  if (e === 'bmp') return 'bmp'
  if (e === 'avif') return 'avif'
  if (e === 'svg') return 'svg'
  return null
}

async function writeSidecarFor(inputPath: string, outputPath: string, computeSha: boolean): Promise<void> {
  const payload = await readFile(inputPath)
  const ext = extname(inputPath).replace(/^\./, '')
  const format = extToFormat(ext)
  if (format === null) {
    throw new Error(`preimage-sidecar: unsupported input extension ".${ext}"`)
  }

  const probed = probeImageBytes(payload.subarray(0, 4096))
  if (probed === null) {
    throw new Error(`preimage-sidecar: header probe of ${inputPath} yielded no dimensions`)
  }

  let sha = ''
  if (computeSha) {
    const hex = createHash('sha256').update(payload).digest('hex')
    sha = hex.slice(0, 16) // first 8 bytes as hex
  }

  const text = encodeSidecar({
    width: probed.width,
    height: probed.height,
    format,
    byteLength: payload.byteLength,
    hasAlpha: probed.hasAlpha,
    isProgressive: probed.isProgressive,
    sha,
    thumbhash: '',
  })

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, text, 'utf8')
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile() && !full.endsWith(SIDECAR_EXTENSION)) yield full
  }
}

async function batch(inputDir: string, outputDir: string | null, computeSha: boolean): Promise<void> {
  const rootIn = resolve(inputDir)
  const rootOut = outputDir !== null ? resolve(outputDir) : null
  let wrote = 0
  let skipped = 0
  for await (const absPath of walk(rootIn)) {
    const ext = extname(absPath).replace(/^\./, '').toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      skipped++
      continue
    }
    const rel = relative(rootIn, absPath)
    const sidecarPath =
      rootOut !== null
        ? join(rootOut, rel) + SIDECAR_EXTENSION
        : absPath + SIDECAR_EXTENSION
    try {
      await writeSidecarFor(absPath, sidecarPath, computeSha)
      wrote++
    } catch (err) {
      skipped++
      process.stderr.write(`skip ${rel}: ${(err as Error).message}\n`)
    }
  }
  process.stderr.write(`preimage-sidecar: wrote ${wrote}, skipped ${skipped}\n`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.input === null) {
    process.stderr.write('preimage-sidecar: need <input>. Run with --help.\n')
    process.exit(2)
  }

  const inputStat = await stat(args.input).catch(() => null)
  if (inputStat === null) {
    process.stderr.write(`preimage-sidecar: ${args.input} not found\n`)
    process.exit(1)
  }

  if (args.batch || inputStat.isDirectory()) {
    const outputDir = args.inplace ? null : args.output
    if (!args.inplace && outputDir === null) {
      process.stderr.write(
        'preimage-sidecar: batch mode needs <out-dir> or --inplace. Run with --help.\n',
      )
      process.exit(2)
    }
    await batch(args.input, outputDir, args.computeSha)
    return
  }

  if (args.output === null) {
    process.stderr.write('preimage-sidecar: single-file mode needs <out>. Run with --help.\n')
    process.exit(2)
  }
  await writeSidecarFor(args.input, args.output, args.computeSha)
}

main().catch((err) => {
  process.stderr.write(`preimage-sidecar: ${(err as Error).message}\n`)
  process.exit(1)
})
