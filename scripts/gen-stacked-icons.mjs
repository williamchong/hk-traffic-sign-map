// Re-render every pictogram that appears on a multi-sign signpost to a COMMON
// WIDTH, so when the runtime stacks them into a post each plate keeps its true
// aspect (a wide supplementary plate becomes a short wide bar, a tall warning
// sign stays tall) instead of all plates being forced to one height.
//
// The canonical pictograms in public/signs/ are HEIGHT-normalized (all ~120 px
// tall, width follows aspect); the runtime renders them at a per-tier
// `icon-size`, so on screen they share a height. Stacked members instead need a
// shared WIDTH, so we resize each to COMMON_WIDTH here → public/signs-stacked/.
// The runtime swaps in the `signw-` variant for any member carrying STACK_INDEX
// (see TrafficMap.vue) and lays them out with the matching `STACK_OFF` baked by
// compute-stacks.mjs. Only signs that actually appear on a stacked assembly
// (the keys of signGroups.json) are re-rendered — everything else is never
// requested with the stacked prefix.
//
// Cheap (one `magick -resize` per code, no VLM) and derives entirely from the
// already-committed public/signs/ set, so it's safe to re-run any time the
// catalogue or assemblies change. Note: narrow signs are upscaled from their
// 120-tall source, a minor sharpness loss; re-cropping from the source PDFs
// would be crisper but needs the (expensive) catalogue pipeline.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const COMMON_WIDTH = 120 // px — must match COMMON_WIDTH in scripts/compute-stacks.mjs
const SIGNS_DIR = join('public', 'signs')
const OUT_DIR = join('public', 'signs-stacked')
const GROUPS = join('app', 'data', 'signGroups.json')

if (spawnSync('magick', ['--version']).error) {
  console.error('Missing `magick`. Install it: brew install imagemagick')
  process.exit(1)
}
if (!existsSync(GROUPS)) {
  console.error(`No ${GROUPS} — run \`node scripts/compute-stacks.mjs\` first.`)
  process.exit(1)
}

const codes = Object.keys(JSON.parse(await readFile(GROUPS, 'utf8')))

// Rebuild from scratch so codes that leave the stacked set don't linger.
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

let written = 0, missing = 0
for (const code of codes) {
  const src = join(SIGNS_DIR, `${code}.png`)
  if (!existsSync(src)) {
    missing++
    continue
  }
  const r = spawnSync('magick', [src, '-resize', `${COMMON_WIDTH}x`, '+repage', `PNG32:${join(OUT_DIR, `${code}.png`)}`])
  if (r.status !== 0) throw new Error(`magick failed for ${code}\n${r.stderr}`)
  written++
}

console.log(`Wrote ${written} width-normalized pictograms → ${OUT_DIR}${missing ? ` (${missing} stacked codes had no source pictogram)` : ''}`)
