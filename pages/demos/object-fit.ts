import { prepare, layout, measureNaturalSize, type ObjectFit } from '../../src/index.js'

const BOX_W = 320
const BOX_H = 180
const FITS: ObjectFit[] = ['contain', 'cover', 'fill', 'scale-down', 'none']

const grid = document.getElementById('grid')!
const srcInput = document.getElementById('src') as HTMLInputElement
const goButton = document.getElementById('go') as HTMLButtonElement
const naturalEl = document.getElementById('natural')!

async function render(src: string): Promise<void> {
  grid.textContent = 'Loading…'
  try {
    const prepared = await prepare(src)
    const nat = measureNaturalSize(prepared)
    naturalEl.textContent = `natural size: ${Math.round(nat.width)} × ${Math.round(nat.height)}`
    grid.textContent = ''
    for (const fit of FITS) {
      const size = layout(prepared, BOX_W, BOX_H, fit)
      const wrap = document.createElement('div')
      const label = document.createElement('div')
      label.className = 'label'
      label.textContent = `${fit} — ${size.width.toFixed(1)} × ${size.height.toFixed(1)}`
      const box = document.createElement('div')
      box.className = 'box'
      const img = document.createElement('img')
      img.src = src
      img.style.left = `${size.offsetX}px`
      img.style.top = `${size.offsetY}px`
      img.style.width = `${size.width}px`
      img.style.height = `${size.height}px`
      box.appendChild(img)
      wrap.appendChild(label)
      wrap.appendChild(box)
      grid.appendChild(wrap)
    }
  } catch (e) {
    grid.textContent = `error: ${(e as Error).message}`
  }
}

goButton.addEventListener('click', () => {
  void render(srcInput.value.trim())
})

void render(srcInput.value.trim())
