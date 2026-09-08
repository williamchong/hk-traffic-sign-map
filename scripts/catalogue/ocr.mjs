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

// The three binarisations tried on a No. cell, in order:
//   A. eng: fixed threshold → trim → upscale. Reads clean/thick glyphs.
//   B. eng: upscale → adaptive OTSU → close. Rescues sheets whose strokes are
//      too thin for a fixed threshold.
//   C. snum: upscale → dilate the ink → threshold, read with the digits model
//      Homebrew's tesseract ships alongside eng. The sheets' thin CAD "7" is
//      the case: eng reads 774 as "4" or "174" and 777 as "T", and the 1→7
//      rescue can only undo ONE such digit; snum reads every 7 on (TS 701 -
//      805) (84 of 110 rows against eng's 17) but is weak the other way — it
//      turns 8 into "B" and 1 into "l"/"jI" — so it is a fallback here and a
//      second opinion in extract.mjs, never the first read.
// eng runs with a digit whitelist; snum is digits-trained and gets none (the
// LSTM whitelist is what drops characters it is unsure of).
const ENG_ARGS = ['-c', 'tessedit_char_whitelist=0123456789LTR']
const RECIPES = [
  { args: ENG_ARGS, ops: ['-colorspace', 'Gray', '-threshold', '60%',
    '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '14', '-resize', '300%'] },
  { args: ENG_ARGS, ops: ['-colorspace', 'Gray', '-resize', '200%', '-auto-threshold', 'OTSU',
    '-negate', '-morphology', 'Close', 'Octagon:1', '-negate',
    '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '18'] },
  { args: ['-l', 'snum'], ops: ['-colorspace', 'Gray', '-resize', '300%',
    '-negate', '-morphology', 'Dilate', 'Disk:3', '-negate', '-threshold', '60%',
    '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '30'] }
]
const SNUM = RECIPES[2]

// `ocrCode` and `ocrCodeSecondOpinion` read the SAME cell back to back, so the
// second opinion inherits the first's crop geometry (an `inkBand` page crop it
// would otherwise re-measure) and its snum read when recipe C already ran.
const cellKey = (png, x, y, w, h) => `${png}|${x},${y},${w},${h}`
let lastCell = null

// The crop of a No. cell that OCR reads, as an ImageMagick geometry.
//
// The band is anchored on the cell's INK, not its top edge: on a rowspan /
// "(DOUBLE SIDES)" cell the number is printed vertically CENTRED, so a fixed
// crop from the top read blank and the whole row was lost. Anchoring needs the
// border rule out of the crop first (hence NO_INSET_PT) — with the rule still in,
// the trim latches onto it and reports the entire cell as ink. If the ink still
// spans nearly the whole cell the anchor is untrustworthy, so we fall back to the
// full cell and let the range gate + monotonicity warning do the filtering: no
// better than the old behaviour, never worse.
function codeCropGeom(png, x, y, w, h) {
  const inset = Math.round(RENDER_SCALE * NO_INSET_PT)
  const trimInset = Math.round(RENDER_SCALE * NO_TRIM_INSET_PT)
  const cellW = w - 2 * inset, cellH = h - 2 * inset
  if (cellW < 4 || cellH < 4) return null
  // Measure the ink well inside the rules, then crop for OCR at the narrow inset.
  // The measurement window starts `trimInset` in, so the ink it reports is that
  // much late; back the band off by the same amount (floored at the normal
  // inset) or the top of a normal cell's digits gets sliced off — the "clipped
  // digit tops" regression. The band is lengthened to match, so the reach below
  // the anchor is unchanged.
  const ink = inkBand(png, `${w - 2 * trimInset}x${h - 2 * trimInset}+${x + trimInset}+${y + trimInset}`)
  const anchored = ink && ink.h < (h - 2 * trimInset) * 0.9
  const bandTop = y + Math.max(inset, ink?.y ?? 0)
  return anchored
    ? `${cellW}x${Math.min(PX(NO_BAND_PT) + trimInset, y + h - inset - bandTop)}+${x + inset}+${bandTop}`
    : `${cellW}x${Math.min(cellH, PX(NO_BAND_PT))}+${x + inset}+${y + inset}`
}

function readCode(png, cropGeom, recipe) {
  const cell = join(SCRATCH, 'ocr-no.png')
  magick([png, '-crop', cropGeom, '+repage', ...recipe.ops, cell])
  return tesseract(cell, join(SCRATCH, 'ocr-no'), recipe.args).split(/\s+/).map(s => s.trim()).filter(Boolean)
}

// snum's read of a cell is trusted only in its FIRST token, and only when that is
// bare digits. The cell's second line is the "(TC …)" figure reference, which
// snum renders as "tTC 418D" / "TC 431 D" — a bare "431" there would pass the
// range gate on a 4xx sheet as if it were the code. eng never produces that
// (its whitelist keeps the "T" glued on), so it keeps every token.
const snumCode = tokens => (/^\d{2,4}$/.test(tokens[0] ?? '') ? tokens[0] : null)

// OCR a No. cell (point box) → every number token it contains. The cell holds the
// bold sign code AND a smaller "(TC …)" reference line; both read as numbers but
// sit in DIFFERENT ranges, so the caller's range gate keeps the SIGNID and drops
// the TC figure. `accept` (the range gate) lets us STOP after a recipe once it
// yields an in-range code, so B and C only run where the earlier ones read blank.
export function ocrCode(png, x, y, w, h, accept = () => false) {
  const cropGeom = codeCropGeom(png, x, y, w, h)
  lastCell = { key: cellKey(png, x, y, w, h), cropGeom }
  if (!cropGeom) return []
  const tokens = []
  for (const recipe of RECIPES) {
    const read = readCode(png, cropGeom, recipe)
    if (recipe !== SNUM) {
      tokens.push(...read)
    } else {
      lastCell.snum = snumCode(read)
      if (lastCell.snum) tokens.push(lastCell.snum)
    }
    if (tokens.some(accept)) break
  }
  return tokens
}

// The digits model's own read of a No. cell, for the caller to weigh against
// eng's when the Description column does not back eng's number up. Null when
// snum's first token is not bare digits.
export function ocrCodeSecondOpinion(png, x, y, w, h) {
  const cached = lastCell?.key === cellKey(png, x, y, w, h) ? lastCell : null
  // Recipe C only runs when A and B read nothing in range, so when it DID run
  // the first read already came from snum: re-reading the same crop with the
  // same recipe can only return the same token, and the caller's `!== c.code`
  // test then makes the whole call a no-op. `snum` is absent (not null) when
  // the recipe never ran.
  if (cached && 'snum' in cached) return cached.snum
  const cropGeom = cached ? cached.cropGeom : codeCropGeom(png, x, y, w, h)
  return cropGeom ? snumCode(readCode(png, cropGeom, SNUM)) : null
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
