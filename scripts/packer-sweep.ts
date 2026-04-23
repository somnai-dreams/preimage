// Offline determinism + scaling sweep for the layout-algebra packers.
// The browser bench at /bench/packing.html measures one (N, seed)
// config at a time; this runs the full grid + pathological-input
// cases + cursor-vs-batch equivalence in a few hundred ms.
//
// Checks:
//   1. packShortestColumn + shortestColumnCursor produce bit-identical
//      output for the same inputs (they should; the batch version
//      is literally a loop over the cursor).
//   2. packJustifiedRows + justifiedRowCursor same thing.
//   3. Determinism: same seed + same config → byte-identical output
//      across repeated calls.
//   4. Scaling: time per call at N ∈ {100, 1k, 10k, 100k}.
//   5. Pathological inputs: 0 aspects, 1 aspect, uniform aspects,
//      extreme aspects (10.0, 0.1), all-tall, all-wide.
//   6. Stability: adding one aspect at the end doesn't change any
//      earlier placement (shortest-column only; justified-rows may
//      reshape the final row).
//
// Output: benchmarks/packer-sweep-<date>.json. Non-zero exit on fail.

import { writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  estimateFirstScreenCount,
  packJustifiedRows,
  packShortestColumn,
  justifiedRowCursor,
  shortestColumnCursor,
  visibleIndices,
  type Placement,
} from '../packages/layout-algebra/src/index.ts'

// --- Deterministic PRNG (Wellons lowbias32) ---

function hash(seed: number): number {
  let n = seed | 0
  n = Math.imul((n >>> 16) ^ n, 0x21f0aaad)
  n = Math.imul((n >>> 15) ^ n, 0x735a2d97)
  return (((n >>> 15) ^ n) >>> 0) / 0x100000000
}

function seededAspects(n: number, seed = 1, min = 0.5, max = 2.0): number[] {
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) out[i] = min + hash(seed + i) * (max - min)
  return out
}

// --- Result infrastructure ---

type Check = { ok: true; case: string; notes?: string } | { ok: false; case: string; reason: string }
const results: Check[] = []

function pass(label: string, notes?: string): void {
  results.push(notes !== undefined ? { ok: true, case: label, notes } : { ok: true, case: label })
}

function fail(label: string, reason: string): void {
  results.push({ ok: false, case: label, reason })
}

function placementsEqual(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!
    const q = b[i]!
    if (p.x !== q.x || p.y !== q.y || p.width !== q.width || p.height !== q.height) return false
  }
  return true
}

// --- Determinism: same seed → same output ---

function checkDeterminism(): void {
  const aspects = seededAspects(500, 42)
  const configSC = { panelWidth: 1200, gap: 4, columns: 5 }
  const configJR = { panelWidth: 1200, gap: 4, targetRowHeight: 220 }

  const a1 = packShortestColumn(aspects, configSC)
  const a2 = packShortestColumn(aspects, configSC)
  if (!placementsEqual(a1.placements, a2.placements) || a1.totalHeight !== a2.totalHeight) {
    fail('determinism/shortest-column', 'non-identical repeat')
  } else {
    pass('determinism/shortest-column', `${a1.placements.length} tiles, height ${a1.totalHeight.toFixed(0)}px`)
  }

  const b1 = packJustifiedRows(aspects, configJR)
  const b2 = packJustifiedRows(aspects, configJR)
  if (!placementsEqual(b1.placements, b2.placements) || b1.totalHeight !== b2.totalHeight) {
    fail('determinism/justified-rows', 'non-identical repeat')
  } else {
    pass('determinism/justified-rows', `${b1.placements.length} tiles, height ${b1.totalHeight.toFixed(0)}px`)
  }
}

// --- Cursor vs batch equivalence ---

function checkCursorBatchEquivalence(): void {
  const aspects = seededAspects(250, 7)
  const configSC = { panelWidth: 1000, gap: 3, columns: 4 }

  const batch = packShortestColumn(aspects, configSC)
  const cursor = shortestColumnCursor(configSC)
  const cursorPlacements = aspects.map((a) => cursor.add(a))
  if (!placementsEqual(batch.placements, cursorPlacements)) {
    fail('cursor-batch-equivalence/shortest-column', 'cursor and batch produced different placements')
  } else if (batch.totalHeight !== cursor.totalHeight()) {
    fail(
      'cursor-batch-equivalence/shortest-column',
      `totalHeight drift: batch=${batch.totalHeight} cursor=${cursor.totalHeight()}`,
    )
  } else {
    pass('cursor-batch-equivalence/shortest-column')
  }

  // Justified rows: cursor buffers into open rows; close flushes.
  const configJR = { panelWidth: 900, gap: 2, targetRowHeight: 180 }
  const jrBatch = packJustifiedRows(aspects, configJR)
  const jrCursor = justifiedRowCursor(configJR)
  // JustifiedRowClose emits one placement per item (index + placement);
  // rebuild placements in index order from the cursor stream.
  const emittedByIndex: Placement[] = new Array(aspects.length)
  for (const a of aspects) {
    const { closed } = jrCursor.add(a)
    for (const c of closed) emittedByIndex[c.index] = c.placement
  }
  for (const c of jrCursor.finish()) emittedByIndex[c.index] = c.placement
  const emittedPlacements = emittedByIndex.filter((p): p is Placement => p !== undefined)

  if (!placementsEqual(jrBatch.placements, emittedPlacements)) {
    fail('cursor-batch-equivalence/justified-rows', 'cursor and batch produced different placements')
  } else if (jrBatch.totalHeight !== jrCursor.totalHeight()) {
    fail(
      'cursor-batch-equivalence/justified-rows',
      `totalHeight drift: batch=${jrBatch.totalHeight} cursor=${jrCursor.totalHeight()}`,
    )
  } else {
    pass('cursor-batch-equivalence/justified-rows')
  }
}

// --- Scaling: timing across N ---

type ScalingRow = {
  packer: 'shortestColumn' | 'justifiedRows'
  n: number
  iterations: number
  avgMs: number
  minMs: number
  maxMs: number
  totalHeight: number
}

function checkScaling(): ScalingRow[] {
  const sizes = [100, 1_000, 10_000, 100_000]
  const rows: ScalingRow[] = []

  for (const n of sizes) {
    const aspects = seededAspects(n, 1)
    const iterations = n < 10_000 ? 50 : n < 100_000 ? 10 : 3
    {
      const config = { panelWidth: 1200, gap: 4, columns: 5 }
      const times: number[] = []
      let totalHeight = 0
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        const r = packShortestColumn(aspects, config)
        times.push(performance.now() - t0)
        totalHeight = r.totalHeight
      }
      const avgMs = times.reduce((s, x) => s + x, 0) / times.length
      rows.push({
        packer: 'shortestColumn',
        n,
        iterations,
        avgMs,
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        totalHeight,
      })
    }
    {
      const config = { panelWidth: 1200, gap: 4, targetRowHeight: 220 }
      const times: number[] = []
      let totalHeight = 0
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        const r = packJustifiedRows(aspects, config)
        times.push(performance.now() - t0)
        totalHeight = r.totalHeight
      }
      const avgMs = times.reduce((s, x) => s + x, 0) / times.length
      rows.push({
        packer: 'justifiedRows',
        n,
        iterations,
        avgMs,
        minMs: Math.min(...times),
        maxMs: Math.max(...times),
        totalHeight,
      })
    }
  }
  pass('scaling-measured', `${rows.length} configs timed`)
  return rows
}

// --- Pathological inputs ---

function checkPathological(): void {
  const configSC = { panelWidth: 800, gap: 4, columns: 3 }
  const configJR = { panelWidth: 800, gap: 4, targetRowHeight: 200 }

  // 0 aspects.
  try {
    const sc = packShortestColumn([], configSC)
    if (sc.placements.length !== 0) fail('pathological/sc-empty', 'non-empty placements for empty input')
    else pass('pathological/sc-empty')
  } catch (err) {
    fail('pathological/sc-empty', `threw: ${(err as Error).message}`)
  }
  try {
    const jr = packJustifiedRows([], configJR)
    if (jr.placements.length !== 0) fail('pathological/jr-empty', 'non-empty placements for empty input')
    else pass('pathological/jr-empty')
  } catch (err) {
    fail('pathological/jr-empty', `threw: ${(err as Error).message}`)
  }

  // 1 aspect.
  try {
    const sc = packShortestColumn([1.5], configSC)
    if (sc.placements.length !== 1) fail('pathological/sc-one', `got ${sc.placements.length}`)
    else pass('pathological/sc-one')
  } catch (err) {
    fail('pathological/sc-one', `threw: ${(err as Error).message}`)
  }
  try {
    const jr = packJustifiedRows([1.5], configJR)
    if (jr.placements.length !== 1) fail('pathological/jr-one', `got ${jr.placements.length}`)
    else pass('pathological/jr-one')
  } catch (err) {
    fail('pathological/jr-one', `threw: ${(err as Error).message}`)
  }

  // Uniform aspects (all 1:1).
  try {
    const aspects = new Array(100).fill(1)
    const sc = packShortestColumn(aspects, configSC)
    if (sc.placements.length !== 100) fail('pathological/sc-uniform', `got ${sc.placements.length}`)
    else pass('pathological/sc-uniform')
    const jr = packJustifiedRows(aspects, configJR)
    if (jr.placements.length !== 100) fail('pathological/jr-uniform', `got ${jr.placements.length}`)
    else pass('pathological/jr-uniform')
  } catch (err) {
    fail('pathological/uniform', `threw: ${(err as Error).message}`)
  }

  // Extreme aspects (very wide, very tall).
  try {
    const aspects = [10, 0.1, 10, 0.1, 10, 0.1]
    const sc = packShortestColumn(aspects, configSC)
    if (sc.placements.length !== aspects.length) {
      fail('pathological/sc-extreme', `got ${sc.placements.length}`)
    } else pass('pathological/sc-extreme')
    const jr = packJustifiedRows(aspects, configJR)
    if (jr.placements.length !== aspects.length) {
      fail('pathological/jr-extreme', `got ${jr.placements.length}`)
    } else pass('pathological/jr-extreme')
  } catch (err) {
    fail('pathological/extreme', `threw: ${(err as Error).message}`)
  }

  // Invalid config (0 columns / negative gap / etc.) — must throw.
  try {
    packShortestColumn([1], { panelWidth: 800, gap: 4, columns: 0 })
    fail('pathological/sc-zero-columns', 'did not throw on columns=0')
  } catch {
    pass('pathological/sc-zero-columns')
  }
  try {
    packJustifiedRows([1], { panelWidth: 0, gap: 4, targetRowHeight: 200 })
    fail('pathological/jr-zero-panelwidth', 'did not throw on panelWidth=0')
  } catch {
    pass('pathological/jr-zero-panelwidth')
  }
}

// --- Append stability (shortest-column) ---
//
// If you pack N aspects, then pack N+1 (same first N plus one new),
// the first N placements should be identical. shortest-column has
// this property by construction.

function checkAppendStability(): void {
  const aspects = seededAspects(100, 13)
  const config = { panelWidth: 1000, gap: 3, columns: 4 }
  const pN = packShortestColumn(aspects, config)
  const pN1 = packShortestColumn([...aspects, 1.2], config)
  const firstN = pN1.placements.slice(0, aspects.length)
  if (!placementsEqual(pN.placements, firstN)) {
    fail('append-stability/shortest-column', 'first N placements changed on append')
  } else {
    pass('append-stability/shortest-column')
  }
}

// --- visibleIndices coverage ---

function checkVisibleIndices(): void {
  const placements: Placement[] = [
    { x: 0, y: 0, width: 200, height: 200 },     // 0-200
    { x: 0, y: 210, width: 200, height: 200 },   // 210-410
    { x: 0, y: 420, width: 200, height: 200 },   // 420-620
    { x: 0, y: 630, width: 200, height: 200 },   // 630-830
    { x: 0, y: 840, width: 200, height: 200 },   // 840-1040
  ]

  // Empty input → empty output.
  const empty = visibleIndices([], { viewTop: 0, viewBottom: 500 })
  if (empty.length !== 0) fail('visibleIndices/empty', `expected [], got ${JSON.stringify(empty)}`)
  else pass('visibleIndices/empty')

  // Full viewport covering all placements.
  const all = visibleIndices(placements, { viewTop: 0, viewBottom: 2000 })
  if (all.length !== placements.length) fail('visibleIndices/all', `expected 5, got ${all.length}`)
  else pass('visibleIndices/all')

  // Window above everything.
  const above = visibleIndices(placements, { viewTop: -1000, viewBottom: -100 })
  if (above.length !== 0) fail('visibleIndices/above', `expected [], got ${JSON.stringify(above)}`)
  else pass('visibleIndices/above')

  // Window below everything.
  const below = visibleIndices(placements, { viewTop: 5000, viewBottom: 6000 })
  if (below.length !== 0) fail('visibleIndices/below', `expected [], got ${JSON.stringify(below)}`)
  else pass('visibleIndices/below')

  // Middle window catching indices 1 and 2.
  const middle = visibleIndices(placements, { viewTop: 300, viewBottom: 500 })
  if (JSON.stringify(middle) !== '[1,2]') fail('visibleIndices/middle', `got ${JSON.stringify(middle)}`)
  else pass('visibleIndices/middle')

  // Edge: top of placement exactly at viewBottom — should include.
  // placement 1 spans 210-410; viewBottom 210 should include it.
  const edge = visibleIndices(placements, { viewTop: 0, viewBottom: 210 })
  if (!edge.includes(1)) fail('visibleIndices/edge-top', `missing index 1, got ${JSON.stringify(edge)}`)
  else pass('visibleIndices/edge-top')

  // Overscan: add 100px each side, should pull in neighbors.
  const withOverscan = visibleIndices(placements, {
    viewTop: 300,
    viewBottom: 500,
    overscan: 100,
  })
  // Effective window: [200, 600]. Placement 0 ends at 200 (includes),
  // placements 1 (210-410), 2 (420-620) both inside. Placement 3 starts
  // at 630, outside.
  const expected = [0, 1, 2]
  if (JSON.stringify(withOverscan) !== JSON.stringify(expected)) {
    fail('visibleIndices/overscan', `expected ${JSON.stringify(expected)}, got ${JSON.stringify(withOverscan)}`)
  } else {
    pass('visibleIndices/overscan')
  }

  // Zero-size viewport (viewTop === viewBottom): only placements
  // intersecting that exact y line.
  const zero = visibleIndices(placements, { viewTop: 300, viewBottom: 300 })
  if (!zero.includes(1)) fail('visibleIndices/zero-size', `expected index 1, got ${JSON.stringify(zero)}`)
  else pass('visibleIndices/zero-size')
}

// --- estimateFirstScreenCount coverage ---

function checkEstimateFirstScreenCount(): void {
  // Columns mode: tile height = (panelWidth - gap*(cols-1))/cols
  // = (1200 - 4*4)/5 = (1200 - 16)/5 = 236.8 px. rowCount =
  // ceil(720 / (236.8 + 4)) = ceil(2.99) = 3. count = 3*5 = 15.
  const cols = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth: 1200,
    viewportHeight: 720,
    gap: 4,
    columns: 5,
  })
  if (cols !== 15) fail('estimate/columns-basic', `expected 15, got ${cols}`)
  else pass('estimate/columns-basic')

  // Minimum: always at least `columns` (even at viewportHeight=0).
  const colsMin = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth: 800,
    viewportHeight: 0,
    gap: 4,
    columns: 3,
  })
  if (colsMin !== 3) fail('estimate/columns-min', `expected 3, got ${colsMin}`)
  else pass('estimate/columns-min')

  // Tiny viewport, one column wide — at least 1.
  const single = estimateFirstScreenCount({
    mode: 'columns',
    panelWidth: 400,
    viewportHeight: 10,
    gap: 0,
    columns: 1,
  })
  if (single < 1) fail('estimate/columns-single', `expected >= 1, got ${single}`)
  else pass('estimate/columns-single', `${single} tiles`)

  // Rows mode: rowCount = ceil(viewportHeight / (targetRowHeight + gap))
  // itemsPerRow = max(2, round(panelWidth / targetRowHeight))
  // panelWidth 1200, targetRowHeight 200: itemsPerRow = round(6) = 6
  // viewportHeight 720, gap 4: rowCount = ceil(720/204) = 4
  // total = 24
  const rows = estimateFirstScreenCount({
    mode: 'rows',
    panelWidth: 1200,
    viewportHeight: 720,
    gap: 4,
    targetRowHeight: 200,
  })
  if (rows !== 24) fail('estimate/rows-basic', `expected 24, got ${rows}`)
  else pass('estimate/rows-basic')

  // Rows mode minimum: at least 2 items per row (the hard floor).
  const rowsMin = estimateFirstScreenCount({
    mode: 'rows',
    panelWidth: 100,
    viewportHeight: 10,
    gap: 0,
    targetRowHeight: 200,
  })
  if (rowsMin < 2) fail('estimate/rows-min', `expected >= 2, got ${rowsMin}`)
  else pass('estimate/rows-min', `${rowsMin} tiles`)
}

// --- Main ---

async function main(): Promise<void> {
  const t0 = performance.now()
  checkDeterminism()
  checkCursorBatchEquivalence()
  checkPathological()
  checkAppendStability()
  checkVisibleIndices()
  checkEstimateFirstScreenCount()
  const scalingRows = checkScaling()
  const wallMs = performance.now() - t0

  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  process.stdout.write(`=== packer-sweep: ${passed}/${total} passed in ${wallMs.toFixed(0)}ms ===\n\n`)
  if (failed.length > 0) {
    process.stdout.write(`=== FAILURES (${failed.length}) ===\n`)
    for (const f of failed) if (!f.ok) process.stdout.write(`  ✗ ${f.case}: ${f.reason}\n`)
    process.stdout.write('\n')
  }

  process.stdout.write('=== Scaling ===\n')
  for (const row of scalingRows) {
    process.stdout.write(
      `  ${row.packer.padEnd(16)} n=${String(row.n).padStart(6)}  avg=${row.avgMs.toFixed(3)}ms  min=${row.minMs.toFixed(3)}ms  max=${row.maxMs.toFixed(3)}ms  (h=${row.totalHeight.toFixed(0)}px)\n`,
    )
  }

  // Save the summary.
  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const outDir = resolve(scriptDir, '..', 'benchmarks')
  await mkdir(outDir, { recursive: true })
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = join(outDir, `packer-sweep-${iso}.json`)
  await writeFile(
    outPath,
    JSON.stringify(
      {
        bench: 'packer-sweep',
        date: new Date().toISOString(),
        wallMs,
        total,
        passed,
        failed: failed.length,
        scaling: scalingRows,
        results,
      },
      null,
      2,
    ),
  )
  process.stdout.write(`\n=== Saved ${outPath} ===\n`)
  if (failed.length > 0) process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exit(1)
})
