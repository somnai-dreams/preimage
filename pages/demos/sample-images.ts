// Inline sample images as data URIs so demos run fully offline.
// Each image is a colored SVG gradient at a specified intrinsic size, so
// preimage's measurement path gets real naturalWidth / naturalHeight numbers.

function svgDataUri(width: number, height: number, hue: number, label: string): string {
  const h2 = (hue + 35) % 360
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' width='${width}' height='${height}'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue} 70% 55%)'/>` +
    `<stop offset='1' stop-color='hsl(${h2} 70% 35%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='${width}' height='${height}' fill='url(#g)'/>` +
    `<text x='50%' y='50%' text-anchor='middle' dominant-baseline='middle' ` +
    `font-family='system-ui, sans-serif' font-size='${Math.round(Math.min(width, height) / 6)}' ` +
    `font-weight='700' fill='rgba(255,255,255,0.9)'>${label}</text>` +
    `</svg>`
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
}

export const SAMPLES = {
  landscape16x9: svgDataUri(1600, 900, 220, '16 : 9'),
  landscape4x3: svgDataUri(1200, 900, 170, '4 : 3'),
  square: svgDataUri(1000, 1000, 330, '1 : 1'),
  portrait3x4: svgDataUri(900, 1200, 20, '3 : 4'),
  portrait9x16: svgDataUri(900, 1600, 280, '9 : 16'),
  icon: (hue: number, label: string): string => svgDataUri(80, 80, hue, label),
}
