// Argument parsing + the tool preflight.

import { parseArgs } from 'node:util'

import { requireTool, resolveFont } from './proc.mjs'
import { SHEETS } from './sheets.mjs'

export function preflight() {
  requireTool('mutool', 'brew install mupdf-tools') // PDF → SVG + path-geometry trace
  requireTool('rsvg-convert', 'brew install librsvg') // SVG → crisp page raster
  requireTool('magick', 'brew install imagemagick') // crops / normalisation / montages
  requireTool('tesseract', 'brew install tesseract') // No.-column + Description OCR
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
        variants: { type: 'string' }
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
    reject: new Set((values.reject ?? '').split(',').map(s => s.trim()).filter(Boolean))
  }
}
