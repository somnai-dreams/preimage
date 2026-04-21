// CSS object-fit math as a pure function. The only platform-independent piece
// of single-image layout: no DOM, no browser quirks. Same rules the browser
// applies, expressed as arithmetic over `(naturalWidth, naturalHeight,
// boxWidth, boxHeight)`. Pass `Infinity` for either box dimension to mean
// "unconstrained on this axis".
//
// This module has no image-specific concerns — it operates on any pair of
// source dimensions. The single-image `layout()` in `prepare.ts` is a
// one-line wrapper that feeds it the cached intrinsic size from a prepared
// handle. The pretext float helper uses it to decide how big a figure ends
// up in a given column.

export type ObjectFit = 'contain' | 'cover' | 'fill' | 'scale-down' | 'none'

export type FittedRect = {
  width: number // rendered width in CSS px
  height: number // rendered height in CSS px
  offsetX: number // horizontal offset inside the box when the rect is centered
  offsetY: number // vertical offset inside the box when the rect is centered
  scale: number // width / naturalWidth (after fit); 0 for degenerate inputs
}

// `boxHeight` may be `Infinity` to mean the caller only constrains width. In
// that case the returned `offsetY` is `0` because the box has no bottom edge
// to center against.
export function fitRect(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: ObjectFit = 'contain',
): FittedRect {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    boxWidth <= 0
  ) {
    return { width: 0, height: 0, offsetX: 0, offsetY: 0, scale: 0 }
  }

  const boxH = boxHeight > 0 ? boxHeight : 0
  const unboundedHeight = !Number.isFinite(boxH)

  let width: number
  let height: number
  let scale: number

  switch (fit) {
    case 'fill': {
      width = boxWidth
      height = unboundedHeight ? naturalHeight * (boxWidth / naturalWidth) : boxH
      scale = width / naturalWidth
      break
    }
    case 'cover': {
      const rx = boxWidth / naturalWidth
      const ry = unboundedHeight ? rx : boxH / naturalHeight
      scale = Math.max(rx, ry)
      width = naturalWidth * scale
      height = naturalHeight * scale
      break
    }
    case 'none': {
      width = naturalWidth
      height = naturalHeight
      scale = 1
      break
    }
    case 'scale-down': {
      const rx = boxWidth / naturalWidth
      const ry = unboundedHeight ? rx : boxH / naturalHeight
      scale = Math.min(1, Math.min(rx, ry))
      width = naturalWidth * scale
      height = naturalHeight * scale
      break
    }
    case 'contain':
    default: {
      const rx = boxWidth / naturalWidth
      const ry = unboundedHeight ? rx : boxH / naturalHeight
      scale = Math.min(rx, ry)
      width = naturalWidth * scale
      height = naturalHeight * scale
      break
    }
  }

  const containerH = unboundedHeight ? height : boxH
  const offsetX = (boxWidth - width) / 2
  const offsetY = (containerH - height) / 2
  return { width, height, offsetX, offsetY, scale }
}
