#!/usr/bin/env node
// preimage-manifest <dir> [--base <prefix>] [--out <path>]
//
// Walks <dir>, probes image headers, emits a JSON manifest of
// { "<base><relative-path>": { width, height } }. If --out is omitted,
// writes to stdout. --base is the URL prefix your bundler serves the
// directory under (e.g. '/assets/photos/'); it defaults to empty, in
// which case keys are bare relative paths.
//
// Typical wiring:
//   preimage-manifest ./public/photos --base /photos/ --out ./src/photos.json
//
// Then at client startup:
//   import manifest from './photos.json'
//   import { recordKnownMeasurement } from '@somnai-dreams/preimage/core'
//   for (const [src, { width, height }] of Object.entries(manifest))
//     recordKnownMeasurement(src, width, height)

import { writeFile } from 'node:fs/promises'

import { buildManifest } from './manifest.js'

type ParsedArgs = {
  dir: string | null
  base: string
  out: string | null
  help: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { dir: null, base: '', out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') {
      args.help = true
    } else if (a === '--base') {
      args.base = argv[++i] ?? ''
    } else if (a === '--out' || a === '-o') {
      args.out = argv[++i] ?? null
    } else if (!a.startsWith('-') && args.dir === null) {
      args.dir = a
    } else {
      process.stderr.write(`preimage-manifest: unknown arg "${a}"\n`)
      process.exit(2)
    }
  }
  return args
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: preimage-manifest <dir> [options]',
      '',
      'Walks <dir> recursively, probes image headers, emits a JSON',
      'manifest keyed by URL path with { width, height } values.',
      '',
      'Options:',
      '  --base <prefix>   URL prefix prepended to each key (e.g. /assets/)',
      '  --out, -o <path>  Write manifest to file (default: stdout)',
      '  --help, -h        Show this help',
      '',
      'Exit codes: 0 ok · 1 no images found · 2 bad args',
      '',
    ].join('\n'),
  )
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return 0
  }
  if (args.dir === null) {
    process.stderr.write('preimage-manifest: missing <dir> (see --help)\n')
    return 2
  }

  const manifest = await buildManifest({ root: args.dir, base: args.base })
  const count = Object.keys(manifest).length
  if (count === 0) {
    process.stderr.write(`preimage-manifest: no images found under ${args.dir}\n`)
    return 1
  }

  const json = JSON.stringify(manifest, null, 2)
  if (args.out === null) {
    process.stdout.write(`${json}\n`)
  } else {
    await writeFile(args.out, `${json}\n`)
    process.stderr.write(`preimage-manifest: wrote ${count} entries to ${args.out}\n`)
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`preimage-manifest: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
