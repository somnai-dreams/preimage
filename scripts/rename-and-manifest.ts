import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { probeImageBytes, MAX_HEADER_BYTES } from '../src/probe.js'

const DIR = 'pages/assets/demos/photos'

const entries = (await readdir(DIR))
  .filter((f) => f.toLowerCase().endsWith('.png'))
  .sort()

const manifest: Array<{ file: string; width: number; height: number; original: string }> = []

for (let i = 0; i < entries.length; i++) {
  const original = entries[i]!
  const buf = await readFile(join(DIR, original))
  const probed = probeImageBytes(new Uint8Array(buf.slice(0, MAX_HEADER_BYTES)))
  if (probed === null) {
    console.error(`probe failed: ${original}`)
    process.exit(1)
  }
  const idx = String(i + 1).padStart(2, '0')
  const next = `${idx}.png`
  await rename(join(DIR, original), join(DIR, next))
  manifest.push({ file: next, width: probed.width, height: probed.height, original })
  console.log(`${next}  ${probed.width}x${probed.height}  (from ${original.slice(0, 60)}${original.length > 60 ? '…' : ''})`)
}

await writeFile(
  join(DIR, 'photos.json'),
  JSON.stringify(manifest, null, 2) + '\n',
)
console.log(`\n${manifest.length} photos renamed, photos.json written`)
