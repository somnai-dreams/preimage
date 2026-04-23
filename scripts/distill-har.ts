#!/usr/bin/env bun
// Distill a HAR file down to just the fields useful for diagnosing
// probe concurrency, server timing, and connection reuse. Typical
// HAR files are 150-500 MB because they embed every response body as
// base64; the distilled output is usually <1 MB.
//
// Usage:
//   bun scripts/distill-har.ts path/to/capture.har
//   # writes path/to/capture.distilled.json next to the input
//
// What's kept per entry:
//   url, method, status, httpVersion, startedDateTime, timings,
//   connectionId, response bytes, mime type, cache info.
//
// What's dropped:
//   response.content.text (base64 body — the bulk of the file size)
//   pageTimings, cookies, headers beyond a few diagnostic ones.
//
// Summary block at the top:
//   unique connections, peak concurrent requests, protocol, total
//   wall time, per-timing-phase distribution across all entries.

import { readFile, writeFile } from 'node:fs/promises'

type HarTimings = {
  blocked?: number
  dns?: number
  connect?: number
  ssl?: number
  send?: number
  wait?: number
  receive?: number
}

type HarEntry = {
  startedDateTime: string
  time: number
  request: { method: string; url: string; httpVersion: string }
  response: {
    status: number
    httpVersion: string
    content: { size: number; mimeType: string; text?: string }
    _transferSize?: number
  }
  timings: HarTimings
  cache?: unknown
  _connectionId?: string
  _initiator?: unknown
}

type Har = { log: { entries: HarEntry[] } }

type DistilledEntry = {
  url: string
  method: string
  status: number
  httpVersion: string
  startedDateTime: string
  startMs: number
  time: number
  timings: HarTimings
  connectionId: string | null
  size: number
  transferSize: number
  mime: string
  fromCache: boolean
}

function distilledOf(entry: HarEntry, t0: number): DistilledEntry {
  return {
    url: entry.request.url,
    method: entry.request.method,
    status: entry.response.status,
    httpVersion: entry.response.httpVersion || entry.request.httpVersion,
    startedDateTime: entry.startedDateTime,
    startMs: new Date(entry.startedDateTime).getTime() - t0,
    time: entry.time,
    timings: entry.timings,
    connectionId: entry._connectionId ?? null,
    size: entry.response.content.size,
    transferSize: entry.response._transferSize ?? 0,
    mime: entry.response.content.mimeType,
    fromCache: Boolean(entry.cache && Object.keys(entry.cache as object).length > 0 && (entry.cache as { beforeRequest?: unknown }).beforeRequest !== undefined),
  }
}

function distribution(samples: readonly number[]): {
  count: number
  min: number
  p50: number
  p95: number
  max: number
  mean: number
} {
  if (samples.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const sum = sorted.reduce((a, b) => a + b, 0)
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  }
}

function peakConcurrency(entries: readonly DistilledEntry[]): number {
  // Sweep-line: +1 at start, -1 at start+time.
  const events: Array<[number, number]> = []
  for (const e of entries) {
    events.push([e.startMs, 1])
    events.push([e.startMs + e.time, -1])
  }
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let active = 0
  let peak = 0
  for (const [, delta] of events) {
    active += delta
    if (active > peak) peak = active
  }
  return peak
}

async function main(): Promise<void> {
  const input = process.argv[2]
  if (input === undefined) {
    process.stderr.write('usage: bun scripts/distill-har.ts <file.har>\n')
    process.exit(2)
  }

  const raw = await readFile(input, 'utf8')
  const har = JSON.parse(raw) as Har
  const allEntries = har.log.entries

  // t0: earliest startedDateTime across all entries. Used to
  // normalize startMs to a zero origin.
  const t0 = Math.min(...allEntries.map((e) => new Date(e.startedDateTime).getTime()))

  const entries = allEntries.map((e) => distilledOf(e, t0))

  // Group by origin so we can isolate the probe traffic. Most HARs
  // captured during a demo run include the page itself, its JS/CSS,
  // and N photo probes; we want a per-origin breakdown.
  const byOrigin = new Map<string, DistilledEntry[]>()
  for (const e of entries) {
    const origin = new URL(e.url).origin
    const list = byOrigin.get(origin)
    if (list === undefined) byOrigin.set(origin, [e])
    else list.push(e)
  }

  const originSummaries = Array.from(byOrigin.entries()).map(([origin, list]) => {
    const connections = new Set(list.map((e) => e.connectionId).filter((id) => id !== null))
    const protocols = new Set(list.map((e) => e.httpVersion))
    const totals = {
      count: list.length,
      peakConcurrent: peakConcurrency(list),
      uniqueConnections: connections.size,
      protocols: Array.from(protocols),
    }
    const phases = {
      total: distribution(list.map((e) => e.time)),
      blocked: distribution(list.map((e) => e.timings.blocked ?? 0)),
      wait: distribution(list.map((e) => e.timings.wait ?? 0)),
      receive: distribution(list.map((e) => e.timings.receive ?? 0)),
    }
    return { origin, ...totals, phases }
  })

  const output = {
    source: input,
    distilledAt: new Date().toISOString(),
    totalEntries: entries.length,
    timelineMs: Math.max(...entries.map((e) => e.startMs + e.time)),
    origins: originSummaries,
    entries,
  }

  const outPath = input.replace(/\.har$/, '') + '.distilled.json'
  await writeFile(outPath, JSON.stringify(output, null, 2))
  const sizeIn = raw.length
  const sizeOut = (await readFile(outPath)).length
  process.stderr.write(
    `distilled ${entries.length} entries  ${(sizeIn / 1024 / 1024).toFixed(1)} MB → ${(sizeOut / 1024 / 1024).toFixed(2)} MB\n`,
  )
  process.stderr.write(`wrote ${outPath}\n`)
}

main().catch((err) => {
  process.stderr.write(`distill-har: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
