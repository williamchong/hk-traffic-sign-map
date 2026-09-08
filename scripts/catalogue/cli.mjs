// Argument parsing + the tool preflight.

import { parseArgs } from 'node:util'

import { requireModel, requireTool, resolveFont } from './proc.mjs'
import { SHEETS } from './sheets.mjs'

export function preflight() {
  requireTool('mutool', 'brew install mupdf-tools') // PDF → SVG + path-geometry trace
  requireTool('rsvg-convert', 'brew install librsvg') // SVG → crisp page raster
  requireTool('magick', 'brew install imagemagick') // crops / normalisation / montages
  requireTool('tesseract', 'brew install tesseract') // No.-column + Description OCR
  requireModel('snum', 'brew reinstall tesseract') // the digits model, bundled with the formula
  return resolveFont()
}

export function parseCli(argv = process.argv.slice(2)) {
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        sheet: { type: 'string' },
        wipe: { type: 'boolean', default: false },
        propose: { type: 'boolean', default: false },
        commit: { type: 'boolean', default: false },
        reject: { type: 'string' },
        variants: { type: 'string' },
        rebind: { type: 'string' }
      }
    }))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  const sheets = values.sheet ? SHEETS.filter(s => s.pdf.includes(values.sheet)) : SHEETS
  if (values.sheet && !sheets.length) {
    console.error(`No sheet matched "${values.sheet}". Available:\n` + SHEETS.map(s => '  ' + s.pdf).join('\n'))
    process.exit(1)
  }
  return {
    ...values,
    sheets,
    reject: new Set((values.reject ?? '').split(',').map(s => s.trim()).filter(Boolean)),
    rebind: parseRebinds(values.rebind)
  }
}

// Reviewer override: `--rebind TS296=TS256,TS299=TS255` — "the crop this row
// produced is right, the NUMBER it was read under is wrong; file it under this
// code instead".
//
// The case it exists for: (TS 206 - 310) reads the bold 5 in rows 252/255/256 as
// a 9, and 292/296/299 all land inside the sheet's printed range, so the range
// gate passes them. The plates are perfect — TS296's crop is pixel-for-pixel the
// reference's TS_256 — they are simply filed 40 apart. Withholding them (the
// only prior remedy) throws away a correct pictogram; rebinding puts it where it
// belongs, and for TS256 REPLACES a plate that is currently wrong.
//
// Applied to the OCR read itself, before every downstream check, so the name
// cross-check then scores the crop against the REBOUND code's reference entry —
// a wrong rebind shows up as `disagree`/`code-misread` in the same verify.png
// the reviewer is already reading, rather than shipping silently.
export function parseRebinds(spec) {
  const out = new Map()
  for (const part of String(spec ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(TS\w+)=(TS\w+)$/i)
    if (!m) {
      console.error(`--rebind: cannot parse "${part}" (expected e.g. TS296=TS256)`)
      process.exit(1)
    }
    out.set(m[1].toUpperCase(), m[2].toUpperCase())
  }
  return out
}
