import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'pages', 'assets', 'screenshots')
const BASE = process.env.PREIMAGE_DEMO_BASE ?? 'http://127.0.0.1:3000'

const targets = [
  {
    name: 'demo-index',
    url: `${BASE}/`,
    viewport: { width: 960, height: 720 },
    wait: 500,
  },
  {
    name: 'canvas-fit',
    url: `${BASE}/canvas-fit`,
    viewport: { width: 1280, height: 720 },
    wait: 2500,
  },
  {
    name: 'ttfs',
    url: `${BASE}/ttfs`,
    viewport: { width: 1280, height: 720 },
    wait: 6000,
  },
  {
    name: 'pretext-float',
    url: `${BASE}/pretext-float`,
    viewport: { width: 1280, height: 900 },
    wait: 3000,
  },
  {
    name: 'pretext-inline',
    url: `${BASE}/pretext-inline`,
    viewport: { width: 1280, height: 720 },
    wait: 3000,
  },
]

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const t of targets) {
      const ctx = await browser.newContext({
        viewport: t.viewport,
        deviceScaleFactor: 2,
        ignoreHTTPSErrors: true,
      })
      const page = await ctx.newPage()
      page.on('pageerror', (err) => console.error(`[${t.name}] pageerror:`, err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.error(`[${t.name}] console.error:`, msg.text())
      })
      console.log(`→ ${t.name}: ${t.url}`)
      await page.goto(t.url, { waitUntil: 'networkidle' })
      await page.waitForTimeout(t.wait)
      const out = join(OUT_DIR, `${t.name}.png`)
      await page.screenshot({ path: out, fullPage: true })
      console.log(`  saved ${out}`)
      await ctx.close()
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
