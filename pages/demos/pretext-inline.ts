import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange,
} from '@chenglou/pretext/rich-inline'

import { resolveMixedInlineItems, isInlineImageItem } from '../../src/pretext.js'

const FONT = '17px Inter, -apple-system, system-ui, sans-serif'
const LINE_HEIGHT = 24

const widthInput = document.getElementById('width') as HTMLInputElement
const widthVal = document.getElementById('widthVal')!
const bubble = document.getElementById('bubble')!

async function boot(): Promise<void> {
  bubble.textContent = 'Loading…'
  const items = await resolveMixedInlineItems([
    { text: 'Pushed a fix to ', font: FONT },
    {
      kind: 'image',
      src: 'https://picsum.photos/seed/logo/40/40',
      options: { font: FONT, height: 20, extraWidth: 6, break: 'never' },
    },
    { text: ' preimage — the inline image uses ', font: FONT },
    {
      kind: 'image',
      src: 'https://picsum.photos/seed/ring/40/40',
      options: { font: FONT, height: 20, extraWidth: 6, break: 'never' },
    },
    { text: " pretext's own rich-inline line walker now, with ", font: FONT },
    {
      kind: 'image',
      src: 'https://picsum.photos/seed/spark/40/40',
      options: { font: FONT, height: 20, extraWidth: 6, break: 'never' },
    },
    { text: ' zero DOM reflow.', font: FONT },
  ])
  const prepared = prepareRichInline(items)

  function paint(): void {
    const width = Number(widthInput.value)
    widthVal.textContent = String(width)
    bubble.style.width = `${width - 36}px`
    bubble.textContent = ''

    let y = 0
    walkRichInlineLineRanges(prepared, width - 36, (range) => {
      const line = materializeRichInlineLineRange(prepared, range)
      const row = document.createElement('div')
      row.className = 'row'
      row.style.height = `${LINE_HEIGHT}px`
      row.style.position = 'relative'
      row.style.top = `${y}px`

      let x = 0
      for (const frag of line.fragments) {
        const source = items[frag.itemIndex]!
        x += frag.gapBefore
        if (isInlineImageItem(source)) {
          const img = document.createElement('img')
          img.src = (items[frag.itemIndex] as unknown as { image: { measurement: { src: string } } }).image.measurement.src
          const imgSrc = (source as unknown as { image: unknown; imageDisplayWidth: number; imageDisplayHeight: number }) as {
            imageDisplayWidth: number
            imageDisplayHeight: number
          }
          const w = imgSrc.imageDisplayWidth
          const h = imgSrc.imageDisplayHeight
          img.style.left = `${x}px`
          img.style.top = `${(LINE_HEIGHT - h) / 2}px`
          img.style.width = `${w}px`
          img.style.height = `${h}px`
          row.appendChild(img)
          x += frag.occupiedWidth
        } else {
          const span = document.createElement('span')
          span.textContent = frag.text
          span.style.left = `${x}px`
          span.style.top = `0`
          row.appendChild(span)
          x += frag.occupiedWidth
        }
      }

      bubble.appendChild(row)
      y += LINE_HEIGHT
    })
  }

  paint()
  widthInput.addEventListener('input', paint)
}

void boot()
