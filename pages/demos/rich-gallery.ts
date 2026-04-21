import {
  prepareRichGallery,
  walkRichGalleryRowRanges,
  materializeRichGalleryRowRange,
  type RichGalleryItem,
} from '../../src/rich-gallery.js'

const items: RichGalleryItem[] = [
  { src: 'https://picsum.photos/seed/hero-a/800/450', aspectRatio: 800 / 450 },
  { src: 'https://picsum.photos/seed/chip-a/80/80', aspectRatio: 1, break: 'never', extraWidth: 6 },
  { src: 'https://picsum.photos/seed/wide-b/1200/600', aspectRatio: 1200 / 600 },
  { src: 'https://picsum.photos/seed/portrait-c/400/600', aspectRatio: 400 / 600 },
  { src: 'https://picsum.photos/seed/chip-d/80/80', aspectRatio: 1, break: 'never', extraWidth: 6 },
  { src: 'https://picsum.photos/seed/wide-e/1600/900', aspectRatio: 1600 / 900 },
  { src: 'https://picsum.photos/seed/sq-f/600/600', aspectRatio: 1 },
]

const out = document.getElementById('out')!
const widthInput = document.getElementById('width') as HTMLInputElement
const widthVal = document.getElementById('widthVal')!

async function boot(): Promise<void> {
  const prepared = await prepareRichGallery(items, { rowHeight: 96, gap: 8 })

  function paint(): void {
    const width = Number(widthInput.value)
    widthVal.textContent = String(width)

    out.textContent = ''
    walkRichGalleryRowRanges(prepared, width, (range) => {
      const row = materializeRichGalleryRowRange(prepared, range)
      const rowEl = document.createElement('div')
      rowEl.className = 'row'
      for (const frag of row.fragments) {
        const src = items[frag.itemIndex]!
        const box = document.createElement('div')
        box.className = src.break === 'never' ? 'frag chip' : 'frag'
        box.style.width = `${frag.displayWidth}px`
        box.style.height = `${frag.displayHeight}px`
        const img = document.createElement('img')
        img.src = src.src
        img.loading = 'lazy'
        box.appendChild(img)
        rowEl.appendChild(box)
      }
      out.appendChild(rowEl)
    })
  }

  paint()
  widthInput.addEventListener('input', paint)
}

void boot()
