// Turn a raw symbol crop into the shipped pictogram, and read the silhouette
// profiles the double-sided split needs.

import { join } from 'node:path'

import { magick, magickInfo } from './proc.mjs'
import { SCRATCH } from './sheets.mjs'

// Visual-complexity band (controls the runtime reveal zoom + top-of-ramp size).
// Sizes are in POINTS so the bands don't shift when RENDER_SCALE changes.
const BIG_PT = 40
export function classifyTier(wPt, hPt) {
  const aspect = wPt / hPt
  if (aspect > 1.7 || aspect < 0.58) return 2
  if (aspect > 1.25 || aspect < 0.8 || Math.max(wPt, hPt) > BIG_PT) return 1
  return 0
}

function opaqueFraction(file) {
  return parseFloat(magickInfo([file, '-alpha', 'extract'], '%[fx:mean]')) || 0
}

// The trace gives one component on a grayscale sheet, three on an sRGB one.
const rgbString = (rgb) => {
  const c = rgb.length === 1 ? [rgb[0], rgb[0], rgb[0]] : rgb
  return `srgb(${c.map(v => Math.round(v * 255)).join(',')})`
}

// Trim to content and flood-fill the contiguous background to transparent. The
// flood removes the cell's margin around an inscribed sign (circle/triangle);
// for a filled rectangular plate it would eat the whole sign, so the caller
// falls back to the opaque trimmed crop when too little survives.
//
// `bg` is the page colour behind the sign. It is white on a normal row but the
// shading GREY on a superseded one — a white-seeded flood leaves that in place,
// which is why superseded plates used to ship on an opaque grey rectangle.
//
// It only reaches grey OUTSIDE the sign, though. Some plates are drawn as an
// unfilled outline, so the row shading is the plate's own interior (TS847 and
// ~22 others); the flood correctly stops at the outline and the grey stays.
// That is faithful to the sheet — repainting the interior would be inventing
// pixels — so those keep their grey and only the surround is cleared.
function floodBackground(src, bg, { trimFlood = true } = {}) {
  const trimmed = join(SCRATCH, 'sym-t.png')
  const flooded = join(SCRATCH, 'sym-f.png')
  magick([src, '-fuzz', '6%', '-trim', '+repage', trimmed])
  magick([trimmed, '-alpha', 'set', '-bordercolor', bg, '-border', '1',
    '-fuzz', '12%', '-fill', 'none', '-draw', 'color 0,0 floodfill',
    '-shave', '1x1', '-channel', 'A', '-morphology', 'Erode', 'Octagon:1',
    '+channel', ...(trimFlood ? ['-trim'] : []), '+repage', flooded])
  return { trimmed, flooded }
}

// Trim, drop the background, and size to fit 320×120 as 32-bit PNG.
export function normalizeSign(symRaw, outPath, { bgRgb = null } = {}) {
  const { trimmed, flooded } = floodBackground(symRaw, bgRgb ? rgbString(bgRgb) : 'white')
  const base = opaqueFraction(flooded) < 0.40 ? [trimmed, '-alpha', 'set'] : [flooded]
  magick([...base, '-resize', '320x120', '-background', 'none', '+repage', `PNG32:${outPath}`])
}

// Mean coverage per row (`axis: 'y'`) or per column (`axis: 'x'`) of the sign's
// silhouette, 0–1. Squeezing the alpha channel to a 1-pixel strip lets
// ImageMagick do the averaging in one pass.
export function silhouetteProfile(file, axis, n) {
  const geom = axis === 'y' ? `1x${n}!` : `${n}x1!`
  const txt = magick([file, '-alpha', 'extract', '-resize', geom, '-depth', '8', 'txt:-'])
  const out = new Array(n).fill(0)
  for (const line of txt.split('\n')) {
    const m = line.match(/^(\d+),(\d+):\s*\(([\d.,\s]+)\)/)
    if (!m) continue
    const i = axis === 'y' ? +m[2] : +m[1]
    const vals = m[3].split(',').map(Number)
    if (i < n) out[i] = vals.reduce((a, b) => a + b, 0) / vals.length / 255
  }
  return out
}

// The trimmed crop and its silhouette, written to caller-named files (the
// double-sided split measures the plate shape, then cuts the SAME trimmed image,
// so the two must stay in one coordinate space).
export function silhouetteOf(symRaw, tag, bgRgb = null) {
  // No trailing trim on the flood here: the caller measures the cut position on
  // the silhouette and then applies it to `trimmed`, so the two must be one
  // coordinate space. Trimming the flood can shrink it past `trimmed` whenever
  // the flood clears a margin the 6% content trim left behind, and the cut would
  // then land in the wrong place.
  const { flooded, trimmed } = floodBackground(symRaw, bgRgb ? rgbString(bgRgb) : 'white', { trimFlood: false })
  const trimOut = join(SCRATCH, `${tag}-trim.png`)
  const silOut = join(SCRATCH, `${tag}-sil.png`)
  magick([trimmed, '+repage', trimOut])
  // A solid plate defeats the flood (nothing survives) — fall back to the opaque
  // trim, whose alpha is uniformly 1, i.e. a full rectangle. That is the correct
  // silhouette for a plate anyway.
  const src = opaqueFraction(flooded) < 0.40 ? [trimmed, '-alpha', 'set'] : [flooded]
  magick([...src, '+repage', `PNG32:${silOut}`])
  return { trimmed: trimOut, silhouette: silOut }
}
