import { prepareWithBoxes, layoutWithRows } from '../../src/layout.js'

const SEEDS = [
  'palermo', 'kyoto', 'lisbon', 'reykjavik', 'marrakech',
  'wellington', 'prague', 'hanoi', 'quito', 'bergen',
  'tbilisi', 'santiago', 'chennai', 'sarajevo', 'vilnius',
]

const sources = SEEDS.map((seed, i) => {
  const w = [1600, 900, 1200, 1800, 1000][i % 5]!
  const h = [900, 1600, 900, 1200, 1500][i % 5]!
  return `https://picsum.photos/seed/${seed}/${w}/${h}`
})

const rowHeightInput = document.getElementById('rowHeight') as HTMLInputElement
const rowHeightValue = document.getElementById('rowHeightValue')!
const maxWidthInput = document.getElementById('maxWidth') as HTMLInputElement
const maxWidthValue = document.getElementById('maxWidthValue')!
const galleryEl = document.getElementById('gallery')!

async function boot(): Promise<void> {
  galleryEl.textContent = 'Loading…'
  const prepared = await prepareWithBoxes(sources, { defaults: { gap: 8 } })

  function paint(): void {
    const rowHeight = Number(rowHeightInput.value)
    const maxWidth = Number(maxWidthInput.value)
    rowHeightValue.textContent = String(rowHeight)
    maxWidthValue.textContent = String(maxWidth)

    const { rows } = layoutWithRows(prepared, maxWidth, rowHeight)
    galleryEl.style.width = `${maxWidth}px`
    galleryEl.textContent = ''
    let y = 0
    for (const row of rows) {
      const rowEl = document.createElement('div')
      rowEl.className = 'row'
      rowEl.style.height = `${row.height}px`
      for (const p of row.placements) {
        const item = document.createElement('div')
        item.className = 'item'
        item.style.left = `${p.x}px`
        item.style.width = `${p.width}px`
        item.style.height = `${p.height}px`
        const img = document.createElement('img')
        img.src = sources[p.itemIndex]!
        img.loading = 'lazy'
        item.appendChild(img)
        rowEl.appendChild(item)
      }
      galleryEl.appendChild(rowEl)
      y += row.height + 8
    }
    void y
  }

  paint()
  rowHeightInput.addEventListener('input', paint)
  maxWidthInput.addEventListener('input', paint)
}

void boot()
