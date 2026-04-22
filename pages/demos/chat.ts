import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline'

import { getMeasurement } from '@somnai-dreams/preimage'
import {
  inlineImage,
  isInlineImageItem,
  type InlineImageItem,
} from '@somnai-dreams/preimage/pretext'
import { photoUrl, PHOTOS } from './photo-source.js'

const widthSlider = document.getElementById('widthSlider') as HTMLInputElement
const widthVal = document.getElementById('widthVal')!
const metaEl = document.getElementById('meta')!
const bubble = document.getElementById('bubble')!

const FONT = '15px/28px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'
const INLINE_HEIGHT = 24 // every inline image fits inside a 28px line

function photo(i: number): string {
  return photoUrl(PHOTOS[i]!, null)
}

// All inline items share one line-height. Mixing icon-size and photo-
// size items in pretext rich-inline doesn't work — pretext gives
// every fragment a single line-height, so tall items would overflow
// into adjacent lines. Chat messages with inline media are the right
// fit: small reaction icons and avatars intermixed with text.
type Script = Array<{ kind: 'text'; text: string } | { kind: 'image'; src: string; extraWidth?: number }>

const SCRIPT: Script = [
  { kind: 'text', text: 'morning ' },
  { kind: 'image', src: photo(4), extraWidth: 3 },
  { kind: 'text', text: ' crew! pushing the weekend recap to the channel ' },
  { kind: 'image', src: photo(17), extraWidth: 3 },
  { kind: 'image', src: photo(27), extraWidth: 3 },
  { kind: 'text', text: ' — mostly camera roll dumps from the ridge ' },
  { kind: 'image', src: photo(20), extraWidth: 3 },
  { kind: 'text', text: ' plus a couple of keepers from that late-afternoon session ' },
  { kind: 'image', src: photo(0), extraWidth: 3 },
  { kind: 'image', src: photo(25), extraWidth: 3 },
  { kind: 'text', text: '. drop a ' },
  { kind: 'image', src: photo(21), extraWidth: 3 },
  { kind: 'text', text: ' on the ones worth blowing up. i’ll send the raws once i’ve cleaned the sequence ' },
  { kind: 'image', src: photo(14), extraWidth: 3 },
  { kind: 'text', text: ' ✌️' },
]

async function buildItems(): Promise<RichInlineItem[]> {
  const items: RichInlineItem[] = []
  for (const entry of SCRIPT) {
    if (entry.kind === 'text') {
      items.push({ text: entry.text, font: FONT })
      continue
    }
    const item = await inlineImage(entry.src, {
      font: FONT,
      height: INLINE_HEIGHT,
      extraWidth: entry.extraWidth ?? 0,
    })
    items.push(item)
  }
  return items
}

function getWidth(): number {
  return Number(widthSlider.value)
}

function renderBubble(items: readonly RichInlineItem[], width: number): void {
  bubble.innerHTML = ''
  bubble.style.width = `${width}px`
  const prepared = prepareRichInline(items as RichInlineItem[])
  walkRichInlineLineRanges(prepared, width, (range) => {
    const line = materializeRichInlineLineRange(prepared, range)
    const lineDiv = document.createElement('div')
    lineDiv.className = 'line'
    bubble.appendChild(lineDiv)

    for (const frag of line.fragments) {
      const source = items[frag.itemIndex]!
      if (isInlineImageItem(source)) {
        const imageItem = source as InlineImageItem
        const container = document.createElement('span')
        container.className = 'frag-img'
        container.style.width = `${imageItem.imageDisplayWidth}px`
        container.style.height = `${imageItem.imageDisplayHeight}px`
        container.style.marginLeft = `${frag.gapBefore}px`
        const img = document.createElement('img')
        img.src = getMeasurement(imageItem.image).src
        if (img.complete && img.naturalWidth > 0) img.classList.add('loaded')
        else img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
        container.appendChild(img)
        lineDiv.appendChild(container)
      } else {
        const span = document.createElement('span')
        span.className = 'frag'
        span.textContent = frag.text
        span.style.font = source.font
        span.style.marginLeft = `${frag.gapBefore}px`
        lineDiv.appendChild(span)
      }
    }
  })
}

async function main(): Promise<void> {
  metaEl.textContent = 'preparing images…'
  const t0 = performance.now()
  const items = await buildItems()
  const prepareMs = performance.now() - t0
  metaEl.textContent = `${items.length} inline items ready · prepare took ${prepareMs.toFixed(0)}ms`

  const flush = (): void => {
    const w = getWidth()
    widthVal.textContent = `${w}px`
    const t = performance.now()
    renderBubble(items, w)
    const dt = performance.now() - t
    metaEl.textContent = `${items.length} inline items · reflow ${dt.toFixed(1)}ms at ${w}px`
  }

  widthSlider.addEventListener('input', flush)
  flush()
}

void main()
