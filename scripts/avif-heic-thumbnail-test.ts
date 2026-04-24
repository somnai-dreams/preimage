// AVIF / HEIC thumbnail-item extractor.
//
// Out-of-band test (not part of the library) probing whether
// AVIF/HEIC files in our sample corpus carry embedded thumbnails,
// how big those thumbnails are on disk, and what dims they encode.
//
// Thumbnail model (ISOBMFF/HEIF):
//   - meta box holds iinf (item info), pitm (primary item id), iref
//     (item references), iloc (item locations), iprp (item properties)
//   - A thumbnail is an item whose iref entry has type 'thmb' pointing
//     *from* the thumbnail item *to* the primary item
//   - iloc gives offset+length where the thumbnail's compressed bytes
//     live (typically in mdat near the end of the file)
//   - iprp/ipma maps item_id → property indexes into ipco; the 'ispe'
//     property gives the thumbnail's spatial extents
//
// This script walks the box tree, identifies thumbnail items, reports
// their offset/length/dims, and optionally writes the raw compressed
// byte-blob out (it's HEVC/AV1 — no standalone decoder here; viewing
// requires a tool that understands the codec payload).
//
// Usage:
//   bun scripts/avif-heic-thumbnail-test.ts                (run defaults)
//   bun scripts/avif-heic-thumbnail-test.ts --extract-dir <dir>
//   bun scripts/avif-heic-thumbnail-test.ts --source-file <path-to-json>
//
// Source URLs are pulled from benchmarks/probe-byte-threshold-modern2.json
// (the AVIF/HEIC corpus we already gathered) unless --source-file points
// elsewhere.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'

// --- Box parser primitives ---

type Box = {
  type: string
  start: number // absolute offset of the header
  size: number // total box size including header
  bodyStart: number // absolute offset of the body (after header)
  bodyEnd: number // absolute offset of the byte after the body
}

function u32be(b: Uint8Array, o: number): number {
  return b[o]! * 0x1000000 + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!
}
function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!
}
function u64be(b: Uint8Array, o: number): number {
  // Safe for sizes we'll encounter (well under 2^53).
  const hi = u32be(b, o)
  const lo = u32be(b, o + 4)
  return hi * 0x100000000 + lo
}
function ascii(b: Uint8Array, o: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[o + i]!)
  return s
}

function readBox(bytes: Uint8Array, offset: number): Box | null {
  if (offset + 8 > bytes.length) return null
  let size = u32be(bytes, offset)
  const type = ascii(bytes, offset + 4, 4)
  let headerLen = 8
  if (size === 1) {
    if (offset + 16 > bytes.length) return null
    size = u64be(bytes, offset + 8)
    headerLen = 16
  } else if (size === 0) {
    size = bytes.length - offset
  }
  const end = offset + size
  if (end > bytes.length || size < headerLen) return null
  return { type, start: offset, size, bodyStart: offset + headerLen, bodyEnd: end }
}

function* childBoxes(bytes: Uint8Array, box: Box): Generator<Box> {
  let o = box.bodyStart
  while (o < box.bodyEnd) {
    const child = readBox(bytes, o)
    if (child === null) return
    yield child
    o = child.bodyEnd
  }
}

function findChild(bytes: Uint8Array, box: Box, type: string): Box | null {
  for (const c of childBoxes(bytes, box)) if (c.type === type) return c
  return null
}

// `meta` is a FullBox — its payload begins with a 4-byte version+flags
// header before its children. This helper iterates children with that
// header skipped.
function* fullBoxChildren(bytes: Uint8Array, box: Box): Generator<Box> {
  let o = box.bodyStart + 4
  while (o < box.bodyEnd) {
    const child = readBox(bytes, o)
    if (child === null) return
    yield child
    o = child.bodyEnd
  }
}

function findFullBoxChild(bytes: Uint8Array, box: Box, type: string): Box | null {
  for (const c of fullBoxChildren(bytes, box)) if (c.type === type) return c
  return null
}

// --- Meta-box sub-parsers ---

type IlocExtent = { offset: number; length: number }
type IlocItem = { itemId: number; constructionMethod: number; baseOffset: number; extents: IlocExtent[] }

function parseIloc(bytes: Uint8Array, box: Box): IlocItem[] {
  const version = bytes[box.bodyStart]!
  let o = box.bodyStart + 4
  const packed1 = bytes[o]!
  const packed2 = bytes[o + 1]!
  const offsetSize = (packed1 >> 4) & 0xF
  const lengthSize = packed1 & 0xF
  const baseOffsetSize = (packed2 >> 4) & 0xF
  const indexSize = version === 1 || version === 2 ? packed2 & 0xF : 0
  o += 2
  const itemCount = version < 2 ? u16be(bytes, o) : u32be(bytes, o)
  o += version < 2 ? 2 : 4

  const items: IlocItem[] = []
  const readSized = (n: number): number => {
    if (n === 0) return 0
    if (n === 4) { const v = u32be(bytes, o); o += 4; return v }
    if (n === 8) { const v = u64be(bytes, o); o += 8; return v }
    if (n === 2) { const v = u16be(bytes, o); o += 2; return v }
    throw new Error(`iloc: unsupported size ${n}`)
  }

  for (let i = 0; i < itemCount; i++) {
    const itemId = version < 2 ? u16be(bytes, o) : u32be(bytes, o)
    o += version < 2 ? 2 : 4
    let constructionMethod = 0
    if (version === 1 || version === 2) {
      constructionMethod = u16be(bytes, o) & 0xF
      o += 2
    }
    o += 2 // data_reference_index
    const baseOffset = readSized(baseOffsetSize)
    const extentCount = u16be(bytes, o); o += 2
    const extents: IlocExtent[] = []
    for (let e = 0; e < extentCount; e++) {
      if (version === 1 || version === 2) {
        o += indexSize // extent_index (skip)
      }
      const offset = readSized(offsetSize)
      const length = readSized(lengthSize)
      extents.push({ offset, length })
    }
    items.push({ itemId, constructionMethod, baseOffset, extents })
  }
  return items
}

type IinfEntry = { itemId: number; itemType: string; itemName: string }

function parseIinf(bytes: Uint8Array, box: Box): IinfEntry[] {
  const version = bytes[box.bodyStart]!
  let o = box.bodyStart + 4
  const entryCount = version === 0 ? u16be(bytes, o) : u32be(bytes, o)
  o += version === 0 ? 2 : 4
  const entries: IinfEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    const child = readBox(bytes, o)
    if (child === null) break
    o = child.bodyEnd
    if (child.type !== 'infe') continue
    const infeVersion = bytes[child.bodyStart]!
    let p = child.bodyStart + 4
    if (infeVersion === 2 || infeVersion === 3) {
      const itemId = infeVersion === 2 ? u16be(bytes, p) : u32be(bytes, p)
      p += infeVersion === 2 ? 2 : 4
      p += 2 // item_protection_index
      const itemType = ascii(bytes, p, 4)
      p += 4
      let nameEnd = p
      while (nameEnd < child.bodyEnd && bytes[nameEnd] !== 0) nameEnd++
      const itemName = ascii(bytes, p, nameEnd - p)
      entries.push({ itemId, itemType, itemName })
    }
  }
  return entries
}

type IrefEntry = { type: string; fromItemId: number; toItemIds: number[] }

function parseIref(bytes: Uint8Array, box: Box): IrefEntry[] {
  const version = bytes[box.bodyStart]!
  let o = box.bodyStart + 4
  const entries: IrefEntry[] = []
  while (o < box.bodyEnd) {
    const child = readBox(bytes, o)
    if (child === null) break
    o = child.bodyEnd
    let p = child.bodyStart
    const fromItemId = version === 0 ? u16be(bytes, p) : u32be(bytes, p)
    p += version === 0 ? 2 : 4
    const refCount = u16be(bytes, p); p += 2
    const toItemIds: number[] = []
    for (let i = 0; i < refCount; i++) {
      const id = version === 0 ? u16be(bytes, p) : u32be(bytes, p)
      p += version === 0 ? 2 : 4
      toItemIds.push(id)
    }
    entries.push({ type: child.type, fromItemId, toItemIds })
  }
  return entries
}

function parsePitm(bytes: Uint8Array, box: Box): number {
  const version = bytes[box.bodyStart]!
  const o = box.bodyStart + 4
  return version === 0 ? u16be(bytes, o) : u32be(bytes, o)
}

type Ispe = { width: number; height: number }

function parseIpco(bytes: Uint8Array, box: Box): Map<number, Ispe> {
  // Return property-index → ispe. ipma later maps item_id → property
  // indexes, which we cross-reference.
  const props = new Map<number, Ispe>()
  let idx = 1 // ipma uses 1-based indexes
  for (const child of childBoxes(bytes, box)) {
    if (child.type === 'ispe') {
      const p = child.bodyStart + 4
      const width = u32be(bytes, p)
      const height = u32be(bytes, p + 4)
      props.set(idx, { width, height })
    }
    idx++
  }
  return props
}

function parseIpma(bytes: Uint8Array, box: Box): Map<number, number[]> {
  const version = bytes[box.bodyStart]!
  const flags = (bytes[box.bodyStart + 1]! << 16) | (bytes[box.bodyStart + 2]! << 8) | bytes[box.bodyStart + 3]!
  let o = box.bodyStart + 4
  const entryCount = u32be(bytes, o); o += 4
  const map = new Map<number, number[]>()
  for (let i = 0; i < entryCount; i++) {
    const itemId = version < 1 ? u16be(bytes, o) : u32be(bytes, o)
    o += version < 1 ? 2 : 4
    const associationCount = bytes[o]!; o += 1
    const indexes: number[] = []
    for (let a = 0; a < associationCount; a++) {
      let index: number
      if ((flags & 1) !== 0) {
        // 15-bit index
        const hi = bytes[o]! & 0x7F
        const lo = bytes[o + 1]!
        index = (hi << 8) | lo
        o += 2
      } else {
        index = bytes[o]! & 0x7F
        o += 1
      }
      indexes.push(index)
    }
    map.set(itemId, indexes)
  }
  return map
}

// --- Top-level analyzer ---

type ThumbnailInfo = {
  thumbnailItemId: number
  primaryItemId: number
  itemType: string // 'hvc1' for HEIC thumbnails, 'av01' for AVIF
  offset: number // absolute offset into the file
  length: number
  ispe: Ispe | null
}

type AnalysisResult = {
  url: string
  fileBytes: number
  brand: string
  primaryItemId: number | null
  primaryIspe: Ispe | null
  items: number
  thumbnails: ThumbnailInfo[]
  error?: string
}

function findMetaBox(bytes: Uint8Array): Box | null {
  let o = 0
  while (o < bytes.length) {
    const box = readBox(bytes, o)
    if (box === null) return null
    if (box.type === 'meta') return box
    o = box.bodyEnd
  }
  return null
}

function analyze(url: string, bytes: Uint8Array): AnalysisResult {
  const result: AnalysisResult = {
    url,
    fileBytes: bytes.length,
    brand: '',
    primaryItemId: null,
    primaryIspe: null,
    items: 0,
    thumbnails: [],
  }

  if (bytes.length < 12 || ascii(bytes, 4, 4) !== 'ftyp') {
    result.error = 'no ftyp box at offset 0'
    return result
  }
  result.brand = ascii(bytes, 8, 4)

  const meta = findMetaBox(bytes)
  if (meta === null) {
    result.error = 'no meta box'
    return result
  }

  const pitmBox = findFullBoxChild(bytes, meta, 'pitm')
  const iinfBox = findFullBoxChild(bytes, meta, 'iinf')
  const irefBox = findFullBoxChild(bytes, meta, 'iref')
  const ilocBox = findFullBoxChild(bytes, meta, 'iloc')
  const iprpBox = findFullBoxChild(bytes, meta, 'iprp')

  const primary = pitmBox !== null ? parsePitm(bytes, pitmBox) : null
  const iinf = iinfBox !== null ? parseIinf(bytes, iinfBox) : []
  const iref = irefBox !== null ? parseIref(bytes, irefBox) : []
  const iloc = ilocBox !== null ? parseIloc(bytes, ilocBox) : []

  let ipco: Map<number, Ispe> = new Map()
  let ipma: Map<number, number[]> = new Map()
  if (iprpBox !== null) {
    const ipcoBox = findChild(bytes, iprpBox, 'ipco')
    const ipmaBox = findChild(bytes, iprpBox, 'ipma')
    if (ipcoBox !== null) ipco = parseIpco(bytes, ipcoBox)
    if (ipmaBox !== null) ipma = parseIpma(bytes, ipmaBox)
  }

  const ispeForItem = (itemId: number): Ispe | null => {
    const props = ipma.get(itemId)
    if (props === undefined) return null
    for (const idx of props) {
      const ispe = ipco.get(idx)
      if (ispe !== undefined) return ispe
    }
    return null
  }

  result.primaryItemId = primary
  result.items = iinf.length
  if (primary !== null) result.primaryIspe = ispeForItem(primary)

  const infoById = new Map<number, IinfEntry>()
  for (const entry of iinf) infoById.set(entry.itemId, entry)
  const ilocById = new Map<number, IlocItem>()
  for (const item of iloc) ilocById.set(item.itemId, item)

  for (const ref of iref) {
    if (ref.type !== 'thmb') continue
    // 'thmb' iref: fromItemId is the thumbnail, toItemIds point at the
    // image(s) the thumbnail represents.
    const thumbItemId = ref.fromItemId
    const targetItemId = ref.toItemIds[0] ?? -1
    const loc = ilocById.get(thumbItemId)
    if (loc === undefined || loc.extents.length === 0) continue
    // Most files have a single extent. When there are multiple, we take
    // the first's offset and sum the total length for reporting.
    const first = loc.extents[0]!
    const totalLength = loc.extents.reduce((acc, e) => acc + e.length, 0)
    const absOffset = loc.baseOffset + first.offset
    const info = infoById.get(thumbItemId)
    result.thumbnails.push({
      thumbnailItemId: thumbItemId,
      primaryItemId: targetItemId,
      itemType: info?.itemType ?? '?',
      offset: absOffset,
      length: totalLength,
      ispe: ispeForItem(thumbItemId),
    })
  }

  return result
}

// --- Corpus loader + runner ---

type CorpusEntry = { url: string; format: string }

type CorpusSample = {
  url: string
  expectedFormat?: string
  detectedFormat?: string | null
}

async function loadCorpus(path: string): Promise<CorpusEntry[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as { samples?: CorpusSample[] }
  const all = raw.samples ?? []
  const out: CorpusEntry[] = []
  for (const s of all) {
    const fmt = s.detectedFormat ?? s.expectedFormat ?? ''
    if (fmt === 'avif' || fmt === 'heic') out.push({ url: s.url, format: fmt })
  }
  return out
}

function parseArgs(): { corpus: string; extractDir: string | null; max: number } {
  const args = process.argv.slice(2)
  let corpus = resolve(process.cwd(), 'benchmarks/probe-byte-threshold-modern2.json')
  let extractDir: string | null = null
  let max = 40
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--source-file' && i + 1 < args.length) { corpus = resolve(process.cwd(), args[++i]!) }
    else if (a === '--extract-dir' && i + 1 < args.length) { extractDir = resolve(process.cwd(), args[++i]!) }
    else if (a === '--max' && i + 1 < args.length) { max = Number(args[++i]!) }
  }
  return { corpus, extractDir, max }
}

async function fetchBytes(url: string, timeoutMs: number): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`status ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

async function main(): Promise<void> {
  const { corpus, extractDir, max } = parseArgs()
  const entries = (await loadCorpus(corpus)).slice(0, max)
  console.log(`Corpus: ${corpus}`)
  console.log(`Entries (AVIF/HEIC): ${entries.length}`)
  if (extractDir !== null) {
    await mkdir(extractDir, { recursive: true })
    console.log(`Extract dir: ${extractDir}`)
  }
  console.log()

  const results: AnalysisResult[] = []
  let withThumb = 0
  let withoutThumb = 0
  let failed = 0

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    try {
      const bytes = await fetchBytes(entry.url, 15000)
      const analysis = analyze(entry.url, bytes)
      results.push(analysis)
      if (analysis.thumbnails.length > 0) {
        withThumb++
        const t = analysis.thumbnails[0]!
        const size = t.ispe !== null ? `${t.ispe.width}x${t.ispe.height}` : '?'
        const primSize = analysis.primaryIspe !== null
          ? `${analysis.primaryIspe.width}x${analysis.primaryIspe.height}`
          : '?'
        console.log(
          `[${i + 1}/${entries.length}] ${entry.format} thumb=${size} ` +
          `(${t.itemType}, ${fmtBytes(t.length)}) primary=${primSize} ` +
          `file=${fmtBytes(analysis.fileBytes)} · ${basename(entry.url)}`,
        )
        if (extractDir !== null) {
          const outName = `${i.toString().padStart(3, '0')}-${basename(entry.url)}.thumb.${t.itemType}`
          const blob = bytes.subarray(t.offset, t.offset + t.length)
          await writeFile(join(extractDir, outName), blob)
        }
      } else {
        withoutThumb++
        const primSize = analysis.primaryIspe !== null
          ? `${analysis.primaryIspe.width}x${analysis.primaryIspe.height}`
          : '?'
        console.log(
          `[${i + 1}/${entries.length}] ${entry.format} no-thumb primary=${primSize} ` +
          `file=${fmtBytes(analysis.fileBytes)} · ${basename(entry.url)}`,
        )
      }
    } catch (err) {
      failed++
      console.log(`[${i + 1}/${entries.length}] ${entry.format} FAILED: ${(err as Error).message} · ${entry.url}`)
    }
  }

  console.log()
  console.log('Summary:')
  console.log(`  files checked:    ${entries.length}`)
  console.log(`  with thumbnail:   ${withThumb}`)
  console.log(`  without:          ${withoutThumb}`)
  console.log(`  fetch failed:     ${failed}`)

  // Thumbnail size distribution
  const thumbSizes = results.flatMap((r) => r.thumbnails.map((t) => t.length))
  if (thumbSizes.length > 0) {
    thumbSizes.sort((a, b) => a - b)
    const q = (p: number): number => thumbSizes[Math.min(thumbSizes.length - 1, Math.floor(thumbSizes.length * p))]!
    console.log(`  thumb bytes:      min=${fmtBytes(thumbSizes[0]!)} p50=${fmtBytes(q(0.5))} p95=${fmtBytes(q(0.95))} max=${fmtBytes(thumbSizes.at(-1)!)}`)
  }

  // Write full JSON report next to the corpus.
  const outPath = resolve(process.cwd(), 'benchmarks/avif-heic-thumbnails.json')
  await writeFile(outPath, JSON.stringify({ date: new Date().toISOString(), corpus, results }, null, 2))
  console.log(`  report:           ${outPath}`)
}

void main()
