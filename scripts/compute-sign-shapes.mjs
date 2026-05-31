// Classify each pictogram by SHAPE so the runtime can shrink solid rectangular
// plates relative to circular/triangular signs (see TrafficMap.vue's tier
// `icon-size`). All pictograms are HEIGHT-normalized (~120 px tall) and rendered
// at a shared on-screen height, so a sign's on-screen *area* is set by how much
// of its bounding box the shape fills — and a solid square plate (the blue "P",
// TS280) fills ~100 % of its box while a circular roundel fills only ~π/4 ≈ 78 %
// and a warning triangle ~55 %. At equal height the square therefore reads much
// heavier than a same-tier circle even though both are real, equal-size plates.
//
// The catalogue PNGs are trimmed with a TRANSPARENT background outside the sign
// shape, so the mean of the alpha channel IS that bounding-box coverage — no
// colour analysis needed. Measured across the catalogue the values cluster
// cleanly: triangles/octagons ~0.45–0.65, circles ~0.75–0.82, rectangular
// plates ~0.85–1.0, with a natural valley at ~0.83. We classify a code as a
// PLATE above PLATE_COVERAGE and list those codes; the runtime shrinks exactly
// that set (everything else — circles, triangles — is left at full size, so an
// unlisted or newly-added sign safely degrades to no shrink).
//
// Cheap (one `magick` alpha read per code, no VLM) and derives entirely from the
// already-committed public/signs/ set, so it's safe to re-run any time the
// catalogue changes — it's chained after `data:catalogue`.

import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Coverage at/above which a pictogram is treated as a solid rectangular plate.
// Sits in the empty valley between the circle cluster (≤0.82) and the rectangle
// cluster (≥0.85), so circles/triangles never cross it.
const PLATE_COVERAGE = 0.85
const SIGNS_DIR = join('public', 'signs')
const CATALOGUE = join('app', 'data', 'signCatalogue.json')
const OUT = join('app', 'data', 'signShapes.json')

if (spawnSync('magick', ['--version']).error) {
  console.error('Missing `magick`. Install it: brew install imagemagick')
  process.exit(1)
}
if (!existsSync(CATALOGUE)) {
  console.error(`No ${CATALOGUE} — run \`node scripts/build-sign-catalogue.mjs\` first.`)
  process.exit(1)
}

const codes = Object.keys(JSON.parse(await readFile(CATALOGUE, 'utf8')))

const plates = []
let missing = 0
for (const code of codes) {
  const src = join(SIGNS_DIR, `${code}.png`)
  if (!existsSync(src)) {
    missing++
    continue
  }
  // Mean of the alpha channel in [0,1] = the sign shape's bounding-box coverage.
  const r = spawnSync('magick', [src, '-alpha', 'extract', '-format', '%[fx:mean]', 'info:'])
  if (r.status !== 0) throw new Error(`magick failed for ${code}\n${r.stderr}`)
  const coverage = Number.parseFloat(r.stdout.toString())
  if (Number.isFinite(coverage) && coverage >= PLATE_COVERAGE) plates.push(code)
}

plates.sort()
await writeFile(OUT, `${JSON.stringify(plates)}\n`)
console.log(`Wrote ${plates.length} rectangular-plate codes → ${OUT}${missing ? ` (${missing} catalogue codes had no pictogram)` : ''}`)
