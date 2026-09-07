// Build the sign catalogue from TD's Index Plan PDFs — PDF → SVG, follow the grid.
//
// Deterministic and key-free. Per sheet:
//
//   1. RENDER FROM SVG (render.mjs). `mutool draw -F svg` emits the page as an
//      SVG whose viewBox is in PDF points; `rsvg-convert` renders it crisply
//      (vector signs AND the embedded-image ones).
//   2. VECTOR GRID in the same points (grid.mjs). Full-table-height vertical
//      rules give the [No. | Symbol | Description] column-groups; rows are found
//      PER GROUP, so a rowspan reads as ONE row. Each sign's crop box uses that
//      group's OWN dividers.
//   3. OCR BIND (ocr.mjs). The printed "No." is read per cell with tesseract; the
//      symbol is cropped from the SAME row band, so code and pictogram cannot
//      desync. The band follows the cell's ink, so a rowspan cell's vertically
//      centred number reads too.
//   4. NAME CROSS-CHECK (names.mjs). The Description column is OCR'd and matched
//      against a vendored list of sign names. A description that names a
//      DIFFERENT code exposes a digit misread — the one failure the cardinal rule
//      forbids: "a missed sign degrades to a dot — a MISLABELLED sign must never
//      ship."
//   5. DOUBLE-SIDED ROWS (variants.mjs). A "(DOUBLE SIDES)" rowspan holds two
//      stacked plates, one per face; they are split and staged as TS<n>L/TS<n>R,
//      the codes TD actually installs. The bare base is still emitted — TD
//      installs that too.
//
// Misread defenses: a RANGE GATE (a read must parse inside the sheet's printed
// range, killing the "(TC …)" reference line), a per-group MONOTONICITY warning,
// the name cross-check above, and the HUMAN GATE (--propose → verify.png →
// --commit) which is the only check on which face of a double-sided row is which.
//
// Usage:
//   node scripts/build-sign-catalogue.mjs                  # rebuild images, merge
//   ... --wipe --propose                                   # stage a CLEAN full rebuild
//   ... --propose                                          # stage only NEW signs
//   ... --sheet "601 - 700"                                # one sheet only
//   ... --commit [--reject TS208,TS209]                    # merge staged into repo
//   ... --wipe --commit                                    # REPLACE repo with staged
//   ... --commit --variants TS2663=RL,TS639=LR             # confirm double-sided faces
//
// Tools: brew install librsvg mupdf-tools imagemagick tesseract

import { mkdir } from 'node:fs/promises'

import { parseCli, preflight } from './catalogue/cli.mjs'
import { extractSheet } from './catalogue/extract.mjs'
import { loadNames } from './catalogue/names.mjs'
import { parseVariantOverrides } from './catalogue/variants.mjs'
import { clearSignsDir, commitStaged, readCatalogue, writeCatalogue } from './catalogue/store.mjs'
import { SIGNS_DIR, STAGING } from './catalogue/sheets.mjs'

const font = preflight()
const opts = parseCli()
const overrides = parseVariantOverrides(opts.variants)

if (opts.commit) {
  await commitStaged({ wipe: opts.wipe, sheet: opts.sheet, reject: opts.reject, overrides })
  process.exit(0)
}

await mkdir(SIGNS_DIR, { recursive: true })
// --propose never mutates the repo, so even with --wipe we keep the real
// catalogue + public/signs/ intact here (they're only read for the dup check;
// --wipe in propose just means "stage every sign").
if (opts.wipe && !opts.propose) {
  await clearSignsDir()
  console.log('--wipe: cleared public/signs/ and starting from an empty catalogue')
}
const catalogue = opts.wipe && !opts.propose ? {} : await readCatalogue()
console.log(`existing catalogue: ${Object.keys(catalogue).length} codes`)

const names = loadNames()
let totalAdded = 0
for (const sheet of opts.sheets) {
  totalAdded += await extractSheet(sheet, catalogue, { propose: opts.propose, wipe: opts.wipe, names, font, overrides })
}

if (opts.propose) {
  const hint = opts.wipe
    ? 'node scripts/build-sign-catalogue.mjs --wipe --commit [--reject TS###,TS###]'
    : 'node scripts/build-sign-catalogue.mjs --commit [--reject TS###,TS###]'
  console.log(`\nproposed ${totalAdded} pictogram(s) across ${opts.sheets.length} sheet(s). Review each <sheet>/verify.png under ${STAGING}, then: ${hint}`)
} else {
  await writeCatalogue(catalogue)
  console.log(`\nfinal catalogue: ${Object.keys(catalogue).length} codes (+${totalAdded})`)
}
