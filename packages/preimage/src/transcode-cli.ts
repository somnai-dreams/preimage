#!/usr/bin/env node
// preimage-transcode — wrap image files in the `.prei` container.
//
//   preimage-transcode <in> <out>                wrap one file
//   preimage-transcode --batch <in-dir> <out-dir> walk a directory
//   preimage-transcode --extract <in.prei> <out> strip the prefix back
//
// Wrapping does not re-encode: the image payload is byte-identical to
// the input. The 128-byte prefix carries dims + alpha flag +
// progressive flag + byteLength + format, all extracted via the
// existing header parsers (the same ones preimage-manifest uses). A
// later encoder pass can fill in thumbhash + sha256 if requested.
//
// Supported formats for v1: jpeg, png, webp. GIF/BMP/AVIF/SVG aren't
// wrapped today — GIF/BMP are low-demand, AVIF needs an `ispe` walker
// we don't yet have, SVG is text and doesn't want a binary container.

import { createHash } from 'node:crypto'
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

import { probeImageBytes } from './probe.js'
import {
  buildContainer,
  decodeContainerPrefix,
  PREIMAGE_CONTAINER_SIZE,
  type ContainerFormat,
} from './container.js'

type Mode = 'wrap-file' | 'wrap-dir' | 'extract-file'

type ParsedArgs = {
  mode: Mode
  input: string | null
  output: string | null
  help: boolean
  computeSha: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    mode: 'wrap-file',
    input: null,
    output: null,
    help: false,
    computeSha: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--batch') args.mode = 'wrap-dir'
    else if (a === '--extract') args.mode = 'extract-file'
    else if (a === '--no-sha') args.computeSha = false
    else if (!a.startsWith('-') && args.input === null) args.input = a
    else if (!a.startsWith('-') && args.output === null) args.output = a
    else {
      process.stderr.write(`preimage-transcode: unknown arg "${a}"\n`)
      process.exit(2)
    }
  }
  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage:',
      '  preimage-transcode <in> <out>                   wrap one file',
      '  preimage-transcode --batch <in-dir> <out-dir>   walk a directory',
      '  preimage-transcode --extract <in.prei> <out>    strip the prefix',
      '',
      'Options:',
      '  --no-sha        Skip sha256 prefix computation (faster, less dedup power)',
      '  --help, -h      Show this message',
      '',
      'Supported payload formats (for --wrap): jpeg, png, webp',
      '',
    ].join('\n'),
  )
}

const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
])

function extToFormat(ext: string): ContainerFormat | null {
  const e = ext.toLowerCase()
  if (e === 'jpg' || e === 'jpeg') return 'jpeg'
  if (e === 'png') return 'png'
  if (e === 'webp') return 'webp'
  if (e === 'avif') return 'avif'
  return null
}

async function wrapFile(inputPath: string, outputPath: string, computeSha: boolean): Promise<void> {
  const payload = await readFile(inputPath)
  const ext = extname(inputPath).replace(/^\./, '')
  const format = extToFormat(ext)
  if (format === null) {
    throw new Error(`preimage-transcode: unsupported input extension ".${ext}"`)
  }

  // Probe the first 4KB for dims, alpha, progressive. Reuses the
  // existing parser stack so coverage follows probeImageBytes exactly.
  const probed = probeImageBytes(payload.subarray(0, 4096))
  if (probed === null) {
    throw new Error(`preimage-transcode: header probe of ${inputPath} yielded no dimensions`)
  }

  const sha256Prefix = new Uint8Array(8)
  if (computeSha) {
    const h = createHash('sha256').update(payload).digest()
    sha256Prefix.set(h.subarray(0, 8))
  }

  const container = buildContainer(
    {
      width: probed.width,
      height: probed.height,
      format,
      hasAlpha: probed.hasAlpha,
      isProgressive: probed.isProgressive,
      thumbhash: new Uint8Array(24),
      sha256Prefix,
    },
    payload,
  )

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, container)
}

async function extractFile(inputPath: string, outputPath: string): Promise<void> {
  const bytes = await readFile(inputPath)
  const decoded = decodeContainerPrefix(bytes)
  if (!decoded.valid) {
    throw new Error(`preimage-transcode: ${inputPath} is not a valid container (${decoded.reason})`)
  }
  const payload = bytes.subarray(PREIMAGE_CONTAINER_SIZE)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, payload)
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

async function wrapDir(inputDir: string, outputDir: string, computeSha: boolean): Promise<void> {
  const rootIn = resolve(inputDir)
  const rootOut = resolve(outputDir)
  let wrapped = 0
  let skipped = 0
  for await (const absPath of walk(rootIn)) {
    const ext = extname(absPath).replace(/^\./, '').toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      skipped++
      continue
    }
    const rel = relative(rootIn, absPath)
    const outPath = join(rootOut, rel) + '.prei'
    try {
      await wrapFile(absPath, outPath, computeSha)
      wrapped++
    } catch (err) {
      skipped++
      process.stderr.write(`skip ${rel}: ${(err as Error).message}\n`)
    }
  }
  process.stderr.write(`preimage-transcode: wrapped ${wrapped}, skipped ${skipped}\n`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }
  if (args.input === null || args.output === null) {
    process.stderr.write('preimage-transcode: need <input> and <output>. Run with --help.\n')
    process.exit(2)
  }

  const inputStat = await stat(args.input).catch(() => null)
  if (inputStat === null) {
    process.stderr.write(`preimage-transcode: ${args.input} not found\n`)
    process.exit(1)
  }

  if (args.mode === 'extract-file') {
    await extractFile(args.input, args.output)
    return
  }
  if (args.mode === 'wrap-dir' || inputStat.isDirectory()) {
    await wrapDir(args.input, args.output, args.computeSha)
    return
  }
  await wrapFile(args.input, args.output, args.computeSha)
}

main().catch((err) => {
  process.stderr.write(`preimage-transcode: ${(err as Error).message}\n`)
  process.exit(1)
})
