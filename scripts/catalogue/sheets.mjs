// Sheet manifest + the geometry constants the whole extractor shares.
//
// Every threshold here is in PDF POINTS — the coordinate system `mutool draw
// -F trace` and `mutool draw -F svg` agree on. Pixels only appear at the last
// moment, via `PX()`, so nothing downstream is silently coupled to the render
// scale (see `classifyTier` in normalize.mjs for the one place that used to be).

import { mkdirSync } from 'node:fs'

export const INDEX_PLAN_DIR = 'data/tadrawings_dataspec/Index Plan'
export const SIGNS_DIR = 'public/signs'
export const CATALOGUE_JSON = 'app/data/signCatalogue.json'
export const NAMES_DIR = 'data/sign-names'
export const ABV_GML = 'data/raw/DTAD_TS_ABV_PT.gml'

// Page raster scale: SVG user units are PDF points, so rendered px = point × this.
// 8 ≈ 576 DPI — crisp pictograms and legible No.-cell digits for OCR.
export const RENDER_SCALE = 8
export const PX = pt => Math.round(pt * RENDER_SCALE)

// Grid geometry thresholds, all in PDF POINTS.
export const CB_MERGE = 4 // cluster verticals closer than this (doublet group separators)
export const NO_W = [12, 32] // No.-column cell width band
export const SYM_W = [24, 140] // Symbol-cell width band (validates the actual divider)
export const MIN_ROW = 5 // drop row bands thinner than this (header slivers / double rules)

// Crop insets past a cell's ruling lines, in points.
//
// Two different insets, because they do two different jobs. `NO_TRIM_INSET_PT`
// is used ONLY to measure where a No. cell's ink starts: it must clear the
// border rule outright, because at 0.8pt the rule survives and the trim latches
// onto it, reporting the whole cell as ink (which is why a vertically-centred
// rowspan number stayed unreadable). `NO_INSET_PT` is the crop actually fed to
// tesseract and stays narrow — the No. column is only ~20pt wide and its digits
// nearly fill it, so cropping 2pt off each side clipped them and cost 13 reads
// on (TS 506 - 600).
export const NO_TRIM_INSET_PT = 2.0
export const NO_INSET_PT = 0.8
export const SYM_INSET_PT = 1.5
// Height of the OCR band taken from the top of the No. cell's ink. Two printed
// lines (the code and a smaller "(TC …)" reference) sit further apart than this.
export const NO_BAND_PT = 18

// TD's face/zone suffix alphabet: a sign number can be installed as TS<n>L/R
// (the two faces of a double-sided plate), T/B/F, or U/N/L (urban / New
// Territories / Lantau). Shared so the alias scan and the reviewer's
// `--variants` flag can't drift apart on which letters count.
export const SIGN_SUFFIXES = 'LRTBFUN'

// A row this much taller than its group's median is a rowspan — on the
// informatory sheets that means a "(DOUBLE SIDES)" cell holding two stacked
// plates (see variants.mjs).
export const TALL_ROW_RATIO = 1.6

// Everything transient goes here. It must NOT be /tmp: some sandboxes let a
// spawned tesseract read only the working tree, so a /tmp input silently fails
// to open (magick is unaffected). data/raw/ is gitignored and always present.
// `SIGN_SCRATCH` isolates a second, concurrent run (the OCR staging files are
// fixed names, so two runs sharing a scratch read each other's crops).
export const SCRATCH = process.env.SIGN_SCRATCH || 'data/raw/.sign-cache'
// --propose stages here; a human reviews it before --commit touches the repo.
export const STAGING = 'data/raw/sign-recovery'
mkdirSync(SCRATCH, { recursive: true })

export const SHEETS = [
  { pdf: '(TS 101 - 205).pdf', prefix: 'TS', range: [101, 205], group: 'regulatory' },
  { pdf: '(TS 206 - 310).pdf', prefix: 'TS', range: [206, 310], group: 'regulatory' },
  { pdf: '(TS 311 - 400).pdf', prefix: 'TS', range: [311, 400], group: 'regulatory' },
  { pdf: '(TS 401 - 505).pdf', prefix: 'TS', range: [401, 505], group: 'warning' },
  { pdf: '(TS 506 - 600).pdf', prefix: 'TS', range: [506, 600], group: 'warning' },
  { pdf: '(TS 601 - 700).pdf', prefix: 'TS', range: [601, 700], group: 'informatory' },
  { pdf: '(TS 701 - 805).pdf', prefix: 'TS', range: [701, 805], group: 'supplementary' },
  { pdf: '(TS 806 - 900).pdf', prefix: 'TS', range: [806, 900], group: 'supplementary' },
  { pdf: '(TS 901 - 1000).pdf', prefix: 'TS', range: [901, 1000], group: 'temporary' },
  { pdf: '(TS 2101 - 2205).pdf', prefix: 'TS', range: [2101, 2205], group: 'regulatory' },
  { pdf: '(TS 2206 - 2310).pdf', prefix: 'TS', range: [2206, 2310], group: 'regulatory' },
  { pdf: '(TS 2601 - 2717).pdf', prefix: 'TS', range: [2601, 2717], group: 'informatory' },
  { pdf: '(TS 3601 - 3705).pdf', prefix: 'TS', range: [3601, 3705], group: 'informatory' },
  { pdf: '(TS 3706 - 3810).pdf', prefix: 'TS', range: [3706, 3810], group: 'supplementary' },
  { pdf: '(TS 3811 - 3936).pdf', prefix: 'TS', range: [3811, 3936], group: 'informatory' },
  { pdf: '(TS 3937 - 4062).pdf', prefix: 'TS', range: [3937, 4062], group: 'warning' }
]
