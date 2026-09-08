// Turn a raw symbol crop into the shipped pictogram, and read the silhouette
// profiles the double-sided split needs.

import { join } from 'node:path'

import { identify, magick, magickInfo } from './proc.mjs'
import { BLEED_MAX_PT, BLEED_ZONE_PT, PX, SCRATCH } from './sheets.mjs'

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

// The page colour behind a row as an ImageMagick colour: the grey shading of a
// superseded row when the trace found one, else white.
export const pageColor = bgRgb => (bgRgb ? rgbString(bgRgb) : 'white')

// Trim against the PAGE colour, never the corner pixel. `-trim` takes its
// reference from the corners, and on a yellow-backed temporary sign the corner
// IS the sign (the sheet's yellow is a raster, 255,255,48…218, not a flat fill):
// TS907's crop went 230×185 → 217×147 as its yellow margin was "trimmed", TS922
// lost its backing outright. A one-pixel page-coloured border pins the
// reference to the page, so only page margin comes off.
export const trimToPage = (bg, fuzz = '6%') => ['-bordercolor', bg, '-border', '1', '-fuzz', fuzz, '-trim', '+repage']

// Ink as alpha: black-on-page pixels → opaque, everything else (page, a yellow
// backing, a blue plate's white panel) → clear, so `silhouetteProfile` can
// measure where the DRAWING is, independent of what the flood makes of it.
const INK_THRESHOLD = '60%'

export function inkMask(src, out) {
  magick([src, '-alpha', 'off', '-colorspace', 'Gray', '-threshold', INK_THRESHOLD, '-negate',
    '-alpha', 'copy', '-channel', 'RGB', '-evaluate', 'set', '0', '+channel', out])
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
  magick([src, ...trimToPage(bg), trimmed])
  // The trailing trim removes the flooded (now transparent) surround and nothing
  // else: the reference is a transparent border at fuzz 0, because the 12 %
  // flood fuzz would otherwise still be in force and, keyed on an opaque corner,
  // trim a yellow backing as if it were page (see trimToPage).
  magick([trimmed, '-alpha', 'set', '-bordercolor', bg, '-border', '1',
    '-fuzz', '12%', '-fill', 'none', '-draw', 'color 0,0 floodfill',
    '-shave', '1x1', '-channel', 'A', '-morphology', 'Erode', 'Octagon:1',
    '+channel', ...(trimFlood ? ['-bordercolor', 'none', '-border', '1', '-fuzz', '0%', '-trim'] : []), '+repage', flooded])
  return { trimmed, flooded }
}

// Ink coverage below which a profile row counts as clear (two pixels in a
// 430-px row) and above which a row spans the crop like a rule or plate border.
const INK_CLEAR = 0.005
const BLEED_SPAN = 0.5

// Leading ink run at one edge of a row profile that is a SLIVER: thin, spanning
// the width, and followed by a clear row, all within the bleed zone. Returns the
// row to cut at (the sliver's end), or 0 when the edge is genuine content.
function sliverEnd(rows, zone, maxThick) {
  let s = 0
  while (s < zone && rows[s] < INK_CLEAR) s++
  let e = s
  while (e < rows.length && rows[e] >= INK_CLEAR) e++
  if (e === s || e - s > maxThick || e >= rows.length || e > zone) return 0
  return rows.slice(s, e).some(v => v >= BLEED_SPAN) ? e : 0
}

// Shave a neighbouring row's bleed off the top and bottom of a symbol crop.
//
// Tall plates overflow their 27 pt row on the informatory sheets, so the row
// ABOVE's bottom border lands in the first pixels of this row's crop (TS2632,
// TS2174/2179, TS2712: a full-width line at the top edge, nothing at the
// sides). One such sliver defeats every trim — the box stays cell-wide, the
// flood clears the interior, and the fallback ships the whole white rectangle
// (aspect 2.2 against the plate's 0.78). A sliver is unmistakable in the ink
// profile: a run no thicker than BLEED_MAX_PT that spans at least half the width
// and is followed by a clear row, all within BLEED_ZONE_PT of the edge; a
// plate's own border never qualifies, because its interior rows still carry the
// side borders. Repeated, since a bleed can be several stacked lines (TS2174
// has three). Left and right are left alone on purpose: no horizontal bleed has
// been observed, and TS560's end ticks are drawn on the sheet and must survive.
export function shaveRowBleed(symRaw, bg) {
  const zone = PX(BLEED_ZONE_PT), maxThick = PX(BLEED_MAX_PT)
  let size = identify(symRaw)
  for (let pass = 0; pass < 4; pass++) {
    const [w, h] = size
    if (!w || h < 3 * zone) break
    const rows = inkProfile(symRaw, 'y', h)
    const top = sliverEnd(rows, zone, maxThick)
    const bot = sliverEnd([...rows].reverse(), zone, maxThick)
    if (!top && !bot) break
    magick([symRaw, '-crop', `${w}x${h - top - bot}+0+${top}`, '+repage', ...trimToPage(bg), symRaw])
    size = identify(symRaw)
  }
  return size
}

// Trim, drop the background, and size to fit 320×120 as 32-bit PNG.
export function normalizeSign(symRaw, outPath, { bgRgb = null } = {}) {
  const { trimmed, flooded } = floodBackground(symRaw, pageColor(bgRgb))
  const base = opaqueFraction(flooded) < 0.40 ? [trimmed, '-alpha', 'set'] : [flooded]
  magick([...base, '-resize', '320x120', '-background', 'none', '+repage', `PNG32:${outPath}`])
}

// Mean coverage per row (`axis: 'y'`) or per column (`axis: 'x'`) of the sign's
// silhouette, 0–1. Squeezing the alpha channel to a 1-pixel strip lets
// ImageMagick do the averaging in one pass.
function profileOf(pre, axis, n) {
  const geom = axis === 'y' ? `1x${n}!` : `${n}x1!`
  const txt = magick([...pre, '-resize', geom, '-depth', '8', 'txt:-'])
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

export const silhouetteProfile = (file, axis, n) => profileOf([file, '-alpha', 'extract'], axis, n)

// The same measurement over INK instead of alpha, in ONE command: going via an
// `inkMask` file wrote a PNG and immediately re-decoded it, which cost more than
// the measurement itself (75 ms against 31 ms on a 900x216 crop).
export const inkProfile = (file, axis, n) =>
  profileOf([file, '-alpha', 'off', '-colorspace', 'Gray', '-threshold', INK_THRESHOLD, '-negate'], axis, n)

// The trimmed crop and its silhouette, written to caller-named files (the
// double-sided split measures the plate shape, then cuts the SAME trimmed image,
// so the two must stay in one coordinate space).
export function silhouetteOf(symRaw, tag, bgRgb = null) {
  // No trailing trim on the flood here: the caller measures the cut position on
  // the silhouette and then applies it to `trimmed`, so the two must be one
  // coordinate space. Trimming the flood can shrink it past `trimmed` whenever
  // the flood clears a margin the 6% content trim left behind, and the cut would
  // then land in the wrong place.
  const { flooded, trimmed } = floodBackground(symRaw, pageColor(bgRgb), { trimFlood: false })
  const trimOut = join(SCRATCH, `${tag}-trim.png`)
  const silOut = join(SCRATCH, `${tag}-sil.png`)
  magick([trimmed, '+repage', trimOut])
  // A solid plate defeats the flood (nothing survives) — fall back to the opaque
  // trim, whose alpha is uniformly 1, i.e. a full rectangle. That is the correct
  // silhouette for a plate anyway. `solid` tells the caller it happened: a
  // rectangle has no gap in it, so a split has to look at the ink instead.
  const solid = opaqueFraction(flooded) < 0.40
  const src = solid ? [trimmed, '-alpha', 'set'] : [flooded]
  magick([...src, '+repage', `PNG32:${silOut}`])
  return { trimmed: trimOut, silhouette: silOut, solid }
}
