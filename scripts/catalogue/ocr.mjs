// The two OCR reads: the printed "No." code (the bind) and the Description
// column's English name (the cross-check).

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { magick, magickInfo } from './proc.mjs'
import { NO_BAND_PT, NO_INSET_PT, NO_TRIM_INSET_PT, PX, RENDER_SCALE, SCRATCH } from './sheets.mjs'

function tesseract(cell, base, extra) {
  const r = spawnSync('tesseract', [cell, base, '--psm', '6', ...extra], { encoding: 'utf8' })
  return r.status === 0 ? readFileSync(`${base}.txt`, 'utf8') : ''
}

// Where does the ink start inside a cell, and how tall is it? Returns null when
// the cell is blank (nothing survives the trim).
function inkBand(png, geom) {
  const out = magickInfo([png, '-crop', geom, '+repage', '-colorspace', 'Gray',
    '-threshold', '60%', '-fuzz', '5%', '-trim'], '%[fx:page.y] %h')
  const [y, h] = out.split(/\s+/).map(Number)
  return Number.isFinite(y) && Number.isFinite(h) && h > 1 ? { y, h } : null
}

// OCR a No. cell (point box) → every number token it contains. The cell holds the
// bold sign code AND a smaller "(TC …)" reference line; both read as numbers but
// sit in DIFFERENT ranges, so the caller's range gate keeps the SIGNID and drops
// the TC figure. Two binarisations are tried in order:
//   A. fixed threshold → trim → upscale. Reads clean/thick glyphs.
//   B. upscale → adaptive OTSU → close. Rescues sheets whose strokes are too thin
//      for a fixed threshold.
// `accept` (the range gate) lets us STOP after A once it yields an in-range code,
// so B only runs where A reads blank.
//
// The band is anchored on the cell's INK, not its top edge: on a rowspan /
// "(DOUBLE SIDES)" cell the number is printed vertically CENTRED, so a fixed
// crop from the top read blank and the whole row was lost. Anchoring needs the
// border rule out of the crop first (hence NO_INSET_PT) — with the rule still in,
// the trim latches onto it and reports the entire cell as ink. If the ink still
// spans nearly the whole cell the anchor is untrustworthy, so we fall back to the
// full cell and let the range gate + monotonicity warning do the filtering: no
// better than the old behaviour, never worse.
export function ocrCode(png, x, y, w, h, accept = () => false) {
  const cell = join(SCRATCH, 'ocr-no.png')
  const outBase = join(SCRATCH, 'ocr-no')
  const inset = Math.round(RENDER_SCALE * NO_INSET_PT)
  const trimInset = Math.round(RENDER_SCALE * NO_TRIM_INSET_PT)
  const cellW = w - 2 * inset, cellH = h - 2 * inset
  if (cellW < 4 || cellH < 4) return []
  // Measure the ink well inside the rules, then crop for OCR at the narrow inset.
  // The measurement window starts `trimInset` in, so the ink it reports is that
  // much late; back the band off by the same amount (floored at the normal
  // inset) or the top of a normal cell's digits gets sliced off — the "clipped
  // digit tops" regression. The band is lengthened to match, so the reach below
  // the anchor is unchanged.
  const ink = inkBand(png, `${w - 2 * trimInset}x${h - 2 * trimInset}+${x + trimInset}+${y + trimInset}`)
  const anchored = ink && ink.h < (h - 2 * trimInset) * 0.9
  const bandTop = y + Math.max(inset, ink?.y ?? 0)
  const cropGeom = anchored
    ? `${cellW}x${Math.min(PX(NO_BAND_PT) + trimInset, y + h - inset - bandTop)}+${x + inset}+${bandTop}`
    : `${cellW}x${Math.min(cellH, PX(NO_BAND_PT))}+${x + inset}+${y + inset}`
  const recipes = [
    ['-colorspace', 'Gray', '-threshold', '60%',
      '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '14', '-resize', '300%'],
    ['-colorspace', 'Gray', '-resize', '200%', '-auto-threshold', 'OTSU',
      '-negate', '-morphology', 'Close', 'Octagon:1', '-negate',
      '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '18']
  ]
  const tokens = []
  for (const recipe of recipes) {
    magick([png, '-crop', cropGeom, '+repage', ...recipe, cell])
    tokens.push(...tesseract(cell, outBase, ['-c', 'tessedit_char_whitelist=0123456789LTR'])
      .split(/\s+/).map(s => s.trim()).filter(Boolean))
    if (tokens.some(accept)) break
  }
  return tokens
}

// OCR the Description cell of the SAME row band. The column is English-only on
// every sheet (the Chinese on these pages is sign-FACE text inside the
// pictograms, not description text), so plain `eng` is the right model.
export function ocrDescription(png, x, y, w, h) {
  const cell = join(SCRATCH, 'ocr-desc.png')
  const outBase = join(SCRATCH, 'ocr-desc')
  const inset = Math.round(RENDER_SCALE * NO_INSET_PT)
  const cellW = w - 2 * inset, cellH = h - 2 * inset
  if (cellW < 40 || cellH < 8) return ''
  // threshold 60% also flattens the grey shading of a superseded row to white.
  magick([png, '-crop', `${cellW}x${cellH}+${x + inset}+${y + inset}`, '+repage',
    '-colorspace', 'Gray', '-threshold', '60%', '-fuzz', '5%', '-trim', '+repage',
    '-bordercolor', 'white', '-border', '16', '-resize', '200%', cell])
  return tesseract(cell, outBase, ['-l', 'eng'])
}

// The description read as one line. The WHOLE cell is the sign's name: an
// earlier version kept only the leading run of upper-case lines and treated a
// qualifier like "(A) 7am-7pm" as a droppable sub-note, but on the time-plate
// and limit families that qualifier IS the name — it's the only thing telling
// TS185 from TS188 — and dropping it made 38 of 97 rows on (TS 101 - 205) look
// like digit conflicts. Rows where the cell also holds Chinese (which `eng`
// renders as noise) simply score lower and fall to the `fill` verdict, which
// ships the reference wording instead.
export function descriptionText(raw) {
  return String(raw ?? '').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').trim()
}
