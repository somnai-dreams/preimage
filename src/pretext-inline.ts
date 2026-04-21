// Inline images inside pretext's rich-inline flow.
//
// Pretext's `prepareRichInline` accepts a list of `{ text, font, break?,
// extraWidth? }` items and packs them into rows with browser-like boundary
// whitespace collapse. It has no concept of "the next item is an image" —
// but it does not need to. Each item carries an `extraWidth` field for
// caller-owned chrome; we can reserve the image's rendered width there.
//
// The one subtlety is that pretext drops items whose text trims to empty
// via `[ \t\n\f\r]+` (so a bare `''` or `' '` would vanish), AND it also
// drops items whose analysis resolves to "soft-break only, no rendered
// content" — which is how U+200B zero-width space ends up being skipped.
// U+2060 WORD JOINER is explicitly a zero-width non-break character, so
// it survives both gates.
//
// Usage:
//   const icon = await inlineImage(iconSrc, { font: '17px Inter', height: 20 })
//   const prepared = prepareRichInline([
//     { text: 'Check out ', font: '17px Inter' },
//     icon,
//     { text: ' in Figma', font: '17px Inter' },
//   ])
//
// When iterating fragments via pretext's `walkRichInlineLineRanges`, the
// caller reads the source item at `fragment.itemIndex` — if it carries the
// `preimageInline` sentinel, render the image; otherwise render text. That
// is the entire integration.

import type { RichInlineItem } from '@chenglou/pretext/rich-inline'

import { prepare, getMeasurement, type PreparedImage } from './prepare.js'

// Word joiner (U+2060). We need an invisible, zero-width character that
// survives pretext's `[ \t\n\f\r]+` trim AND doesn't trip pretext's
// rich-inline pipeline into treating the item as empty.
//
// U+200B (zero-width space) looks tempting but fails: pretext analyzes it
// as a pure soft-break opportunity with no rendered content, so
// `prepareRichInline` silently drops the item. U+2060 is explicitly a
// "join without break" character: it measures 0px wide in every font we
// tested, survives trim, and pretext keeps it as a real segment.
//
// If a caller hits a font that gives U+2060 a non-zero glyph width, the
// reserved width will be off by that amount — report it as a font-specific
// quirk.
const INVISIBLE_SENTINEL = '⁠'

export const PREIMAGE_INLINE_MARKER = '__preimageInline' as const

export type InlineImageOptions = {
  font: string // pretext font shorthand, so the fragment's line-height aligns with neighboring text
  height: number // rendered image height in px; image width = aspectRatio * height
  extraWidth?: number // additional chrome (border, gap) on top of the image width
  break?: 'normal' | 'never' // default 'never' keeps the image atomic
}

export type InlineImageItem = RichInlineItem & {
  [PREIMAGE_INLINE_MARKER]: true
  image: PreparedImage
  imageDisplayWidth: number
  imageDisplayHeight: number
  chromeWidth: number // purely the non-image extraWidth (padding / border)
}

export function isInlineImageItem(item: RichInlineItem): item is InlineImageItem {
  return (item as InlineImageItem)[PREIMAGE_INLINE_MARKER] === true
}

// Build a pretext-compatible item from an already-measured image. Sync;
// requires the caller to have awaited `prepare()` or `prepareSync()`.
export function inlineImageItem(
  image: PreparedImage,
  options: InlineImageOptions,
): InlineImageItem {
  const m = getMeasurement(image)
  const imageDisplayWidth = m.aspectRatio * options.height
  const chromeWidth = options.extraWidth ?? 0
  return {
    text: INVISIBLE_SENTINEL,
    font: options.font,
    break: options.break ?? 'never',
    extraWidth: imageDisplayWidth + chromeWidth,
    [PREIMAGE_INLINE_MARKER]: true,
    image,
    imageDisplayWidth,
    imageDisplayHeight: options.height,
    chromeWidth,
  }
}

// Convenience that prepares + builds in one call.
export async function inlineImage(
  src: string,
  options: InlineImageOptions,
): Promise<InlineImageItem> {
  const image = await prepare(src)
  return inlineImageItem(image, options)
}

// Prepare a mixed-mode inline flow of text + image items in parallel. Image
// items load in parallel; text items pass through untouched. The returned
// array is ready to hand to pretext's `prepareRichInline`.
export type MixedInlineItem =
  | RichInlineItem
  | {
      kind: 'image'
      src: string
      options: InlineImageOptions
    }

export async function resolveMixedInlineItems(
  items: readonly MixedInlineItem[],
): Promise<RichInlineItem[]> {
  const slots = new Array<RichInlineItem | null>(items.length).fill(null)
  const pending: Array<Promise<void>> = []
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]!
    if ('kind' in entry && entry.kind === 'image') {
      const idx = i
      pending.push(
        (async () => {
          slots[idx] = await inlineImage(entry.src, entry.options)
        })(),
      )
    } else {
      slots[i] = entry as RichInlineItem
    }
  }
  await Promise.all(pending)
  return slots.map((slot) => {
    if (slot === null) throw new Error('preimage: inline slot resolved to null unexpectedly')
    return slot
  })
}
