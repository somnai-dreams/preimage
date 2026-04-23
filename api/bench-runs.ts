// Uploads bench-run JSONs to a private GitHub Gist, and lists them.
// Lets a friend run any /bench/ page on a phone via ?t=<token>, hit
// Upload, and have the JSON land in a gist you can diff against your
// own runs.
//
// POST /api/bench-runs
//   Header: X-Upload-Token: <BENCH_UPLOAD_TOKEN>
//   Body:   { meta, params, results }  — same shape saveRun() downloads
//   → 201 { filename } on success
//   → 401 if the token is missing/wrong
//   → 413 if the payload is > 2 MB
//   → 502 if the gist write fails
//
// GET /api/bench-runs
//   → 200 { files: [{ filename, rawUrl, size }] } newest-first
//
// Setup (one-time, on the Vercel project):
//   1. Create a GitHub fine-grained PAT with `gist` scope only.
//   2. Create a private gist on gist.github.com (any placeholder file
//      is fine); copy the ID from the URL.
//   3. In Vercel → project → Settings → Environment Variables, add:
//        GIST_PAT           — the PAT from step 1
//        BENCH_GIST_ID      — the gist ID from step 2
//        BENCH_UPLOAD_TOKEN — any random string; share it via ?t= URL
//                             param with whoever should be allowed to
//                             upload (friends, test devices).
//   4. Redeploy the project.

export const config = { runtime: 'edge' }

const GITHUB_API = 'https://api.github.com'

export default async function handler(req: Request): Promise<Response> {
  const gistId = process.env.BENCH_GIST_ID
  const pat = process.env.GIST_PAT
  const uploadToken = process.env.BENCH_UPLOAD_TOKEN
  if (gistId === undefined || pat === undefined || uploadToken === undefined) {
    return json({ error: 'server not configured' }, 503)
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  if (req.method === 'GET') {
    return await listFiles(gistId, pat)
  }
  if (req.method === 'POST') {
    return await uploadRun(req, gistId, pat, uploadToken)
  }
  return json({ error: 'method not allowed' }, 405)
}

async function listFiles(gistId: string, pat: string): Promise<Response> {
  const r = await fetch(`${GITHUB_API}/gists/${gistId}`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'preimage-bench-runs',
    },
  })
  if (!r.ok) return json({ error: `gist fetch failed: ${r.status}` }, 502)
  const gist = (await r.json()) as {
    files: Record<string, { filename: string; raw_url: string; size: number }>
  }
  const files = Object.values(gist.files)
    .map((f) => ({ filename: f.filename, rawUrl: f.raw_url, size: f.size }))
    .sort((a, b) => b.filename.localeCompare(a.filename))
  return json({ files }, 200, { 'cache-control': 'no-store' })
}

async function uploadRun(
  req: Request,
  gistId: string,
  pat: string,
  uploadToken: string,
): Promise<Response> {
  if (req.headers.get('x-upload-token') !== uploadToken) {
    return json({ error: 'unauthorized' }, 401)
  }
  const body = await req.text()
  if (body.length > 2 * 1024 * 1024) {
    return json({ error: 'payload too large' }, 413)
  }
  let parsed: {
    meta?: { bench?: string; date?: string; network?: { label?: string } }
  }
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  if (parsed.meta === undefined || typeof parsed.meta.bench !== 'string') {
    return json({ error: 'missing meta.bench' }, 400)
  }
  const bench = safeSegment(parsed.meta.bench)
  const date = (parsed.meta.date ?? new Date().toISOString()).replace(/[:.]/g, '-')
  const label = safeSegment(parsed.meta.network?.label ?? 'nolabel').slice(0, 32)
  // Random suffix so two uploads in the same millisecond with the
  // same label don't collide and overwrite.
  const suffix = Math.random().toString(36).slice(2, 6)
  const filename = `${bench}--${date}--${label}--${suffix}.json`

  const r = await fetch(`${GITHUB_API}/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'preimage-bench-runs',
    },
    body: JSON.stringify({ files: { [filename]: { content: body } } }),
  })
  if (!r.ok) return json({ error: `gist write failed: ${r.status}` }, 502)
  return json({ filename }, 201)
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(), ...extra },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-upload-token',
  }
}

function safeSegment(s: string): string {
  return s.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}
