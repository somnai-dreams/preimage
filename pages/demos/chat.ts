import {
  prepareRichInline,
  walkRichInlineLineRanges,
  materializeRichInlineLineRange,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline'

import { getMeasurement } from '../../src/index.js'
import {
  inlineImage,
  isInlineImageItem,
  type InlineImageItem,
} from '../../src/pretext.js'
import { photoUrl, PHOTOS } from './photo-source.js'

const widthSlider = document.getElementById('widthSlider') as HTMLInputElement
const widthVal = document.getElementById('widthVal')!
const metaEl = document.getElementById('meta')!
const bubble = document.getElementById('bubble')!

const FONT = '15px/22px -apple-system, "SF Pro Text", Inter, system-ui, sans-serif'
const IMAGE_HEIGHT = 20
const AVATAR_HEIGHT = 40
const PHOTO_HEIGHT = 140

// Script for the bubble. Text runs are plain RichInlineItems; image
// spec entries get turned into inlineImage items later via
// resolveMixedInlineItems. Mixing small icons (emoji-ish), avatars,
// and photo attachments at different heights exercises the full
// wrap/shrink behaviour when the bubble narrows.
type ImageSpec = { src: string; height: number; extraWidth?: number }
type Script = Array<{ kind: 'text'; text: string } | { kind: 'image'; spec: ImageSpec }>

function photo(i: number): string {
  return photoUrl(PHOTOS[i]!, null)
}

const SCRIPT: Script = [
  { kind: 'text', text: 'hey! had an absolute madlad of a weekend ' },
  { kind: 'image', spec: { src: photo(12), height: PHOTO_HEIGHT, extraWidth: 4 } },
  { kind: 'text', text: ' took the dogs ' },
  { kind: 'image', spec: { src: photo(14), height: AVATAR_HEIGHT, extraWidth: 4 } },
  { kind: 'image', spec: { src: photo(15), height: AVATAR_HEIGHT, extraWidth: 4 } },
  { kind: 'text', text: ' up to the ridge ' },
  { kind: 'image', spec: { src: photo(20), height: PHOTO_HEIGHT, extraWidth: 4 } },
  { kind: 'text', text: ' and the light was absurd. bumped into the crew ' },
  { kind: 'image', spec: { src: photo(4), height: AVATAR_HEIGHT, extraWidth: 4 } },
  { kind: 'image', spec: { src: photo(5), height: AVATAR_HEIGHT, extraWidth: 4 } },
  { kind: 'image', spec: { src: photo(17), height: AVATAR_HEIGHT, extraWidth: 4 } },
  { kind: 'text', text: ' who dragged me into one of their moebius-looking lookout spots ' },
  { kind: 'image', spec: { src: photo(18), height: PHOTO_HEIGHT, extraWidth: 4 } },
  { kind: 'text', text: '. anyway wanted to show you the set, drop a ' },
  { kind: 'image', spec: { src: photo(21), height: IMAGE_HEIGHT, extraWidth: 2 } },
  { kind: 'text', text: ' if any of these hit. more tmr once i’ve cleaned the rest up ' },
  { kind: 'image', spec: { src: photo(26), height: IMAGE_HEIGHT, extraWidth: 2 } },
  { kind: 'text', text: ' ✌️' },
]

async function buildItems(): Promise<RichInlineItem[]> {
  const items: RichInlineItem[] = []
  for (const entry of SCRIPT) {
    if (entry.kind === 'text') {
      items.push({ text: entry.text, font: FONT })
      continue
    }
    const item = await inlineImage(entry.spec.src, {
      font: FONT,
      height: entry.spec.height,
      extraWidth: entry.spec.extraWidth ?? 0,
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
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true })
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
