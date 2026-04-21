import { prepareWithSegments, materializeLineRange } from '@chenglou/pretext'

import { prepare } from '../../src/index.js'
import { flowColumnWithFloats } from '../../src/pretext.js'

const ARTICLE = `The figure on the right is a real image — preimage loaded it once via \`prepare()\`, cached its aspect ratio, and now every resize flows pretext's text lines around it with pure arithmetic. When the column narrows, the float narrows with it; when the image's bottom passes, the text returns to full width. No \`getBoundingClientRect\`, no layout reflow, no placeholder skeleton, no sudden image-pop-in shift. This is the one thing pretext's variable-width cursor loop was designed for, and the one thing pretext alone cannot give you — a concrete (width, height) rect for the figure that holds under resize.`

const IMAGE_URL = 'https://picsum.photos/seed/float/800/600'
const FONT = '17px Inter, -apple-system, system-ui, sans-serif'
const LINE_HEIGHT = 26

const widthInput = document.getElementById('width') as HTMLInputElement
const widthVal = document.getElementById('widthVal')!
const sideSelect = document.getElementById('side') as HTMLSelectElement
const topInput = document.getElementById('top') as HTMLInputElement
const topVal = document.getElementById('topVal')!
const columnEl = document.getElementById('column')!
const statsEl = document.getElementById('stats')!

async function boot(): Promise<void> {
  columnEl.textContent = 'Loading…'
  const image = await prepare(IMAGE_URL)
  const text = prepareWithSegments(ARTICLE, FONT)

  function paint(): void {
    const columnWidth = Number(widthInput.value)
    const side = sideSelect.value as 'left' | 'right'
    const top = Number(topInput.value)
    widthVal.textContent = String(columnWidth)
    topVal.textContent = String(top)

    const result = flowColumnWithFloats({
      text,
      columnWidth,
      lineHeight: LINE_HEIGHT,
      floats: [
        {
          image,
          side,
          top,
          maxWidth: Math.min(280, columnWidth - 120),
          maxHeight: 220,
          gapX: 16,
          gapY: 4,
        },
      ],
    })

    columnEl.textContent = ''
    columnEl.style.width = `${columnWidth}px`
    columnEl.style.height = `${result.totalHeight}px`

    for (const item of result.items) {
      if (item.kind === 'line') {
        const line = materializeLineRange(text, item.range)
        const el = document.createElement('div')
        el.className = 'col-line'
        el.style.left = `${item.x}px`
        el.style.top = `${item.y}px`
        el.style.width = `${item.width}px`
        el.textContent = line.text
        columnEl.appendChild(el)
      } else {
        const wrap = document.createElement('div')
        wrap.className = 'col-float'
        const img = document.createElement('img')
        img.src = IMAGE_URL
        img.style.left = `${item.x}px`
        img.style.top = `${item.y}px`
        img.style.width = `${item.width}px`
        img.style.height = `${item.height}px`
        wrap.appendChild(img)
        columnEl.appendChild(wrap)
      }
    }

    statsEl.textContent =
      `lines: ${result.lineCount} · floats: ${result.floatCount} · column height: ${result.totalHeight.toFixed(1)}px`
  }

  paint()
  widthInput.addEventListener('input', paint)
  sideSelect.addEventListener('change', paint)
  topInput.addEventListener('input', paint)
}

void boot()
