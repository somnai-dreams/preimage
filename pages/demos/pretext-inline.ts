import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange,
} from '@chenglou/pretext/rich-inline'

import { getMeasurement } from '../../src/index.js'
import { resolveMixedInlineItems, isInlineImageItem } from '../../src/pretext.js'

const FONT = '17px Inter, -apple-system, system-ui, sans-serif'
const LINE_HEIGHT = 24
const BUBBLE_PADDING_X = 36 // matches CSS padding 14px 18px

const widthInput = document.getElementById('width') as HTMLInputElement
const widthVal = document.getElementById('widthVal')!
const bubble = document.getElementById('bubble')!

async function boot(): Promise<void> {
  bubble.textContent = 'Loading…'

  const items = await resolveMixedInlineItems([
    { text: 'Pushed a fix to ', font: FONT },
    {
      kind: 'image',
      src: 'https://picsum.photos/seed/logo/80/80',
      options: { font: FONT, height: 20, extraWidth: 6, break: 'never' },
    },
    { text: ' preimage — the inline image uses ', font: FONT },
    {
      kind: 'image',
      src: 'https://picsum.photos/seed/ring/80/80',
      options: { font: FONT, height: 20, extraWidth: 6, break: 'never' },
    },
    { text: " pretext's own rich-inline walker, with ", font: FONT },
    {
      kind: 'image',
      src: 'https://picsum.photos/seed/spark/80/80',
      options: { font: FONT, height: 20, extraWidth: 6, break: 'never' },
    },
    { text: ' zero DOM reflow.', font: FONT },
  ])

  const prepared = prepareRichInline(items)

  function paint(): void {
    const width = Number(widthInput.value)
    widthVal.textContent = String(width)
    const innerWidth = width - BUBBLE_PADDING_X
    bubble.style.width = `${innerWidth}px`
    bubble.style.position = 'relative'
    bubble.textContent = ''

    let y = 0
    walkRichInlineLineRanges(prepared, innerWidth, (range) => {
      const line = materializeRichInlineLineRange(prepared, range)
      const row = document.createElement('div')
      row.className = 'row'
      row.style.position = 'absolute'
      row.style.left = '0'
      row.style.right = '0'
      row.style.top = `${y}px`
      row.style.height = `${LINE_HEIGHT}px`

      let x = 0
      for (const frag of line.fragments) {
        x += frag.gapBefore
        const source = items[frag.itemIndex]!
        if (isInlineImageItem(source)) {
          const img = document.createElement('img')
          img.src = getMeasurement(source.image).src
          img.style.left = `${x}px`
          img.style.top = `${(LINE_HEIGHT - source.imageDisplayHeight) / 2}px`
          img.style.width = `${source.imageDisplayWidth}px`
          img.style.height = `${source.imageDisplayHeight}px`
          row.appendChild(img)
        } else {
          const span = document.createElement('span')
          span.textContent = frag.text
          span.style.left = `${x}px`
          span.style.top = '0'
          row.appendChild(span)
        }
        x += frag.occupiedWidth
      }

      bubble.appendChild(row)
      y += LINE_HEIGHT
    })

    bubble.style.height = `${y}px`
  }

  paint()
  widthInput.addEventListener('input', paint)
}

void boot()
