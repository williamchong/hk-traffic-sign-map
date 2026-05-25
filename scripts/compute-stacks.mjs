// Derive how each traffic-sign-abbreviation feature renders when it belongs to
// a co-located assembly, so the group draws as one rigid signpost.
// Output: data/raw/_sign_stacks.json — keyed by FEATUREID →
//   [ stackIndex, stackSize, picWidth, anchorLng, anchorLat, bearing ]
//
// The grouping key is the GML `GG_NAME` ("sign-group name", e.g. W02R22D_392):
// signs sharing it were gazetted/installed as one unit and carry combined
// meaning (a main sign with its supplementary plate underneath, two warnings
// on one post, …). `GG_NAME` is NOT the sign type (that's REFNAME/SIGNID) nor
// the Index-Plan category (regulatory/warning/…); it's the assembly id.
//
// Members of a group sit at slightly different surveyed coordinates (median
// span ~4 m), so to draw a rigid post the build collapses every member onto
// the *primary's* (stackIndex 0) coordinate (`anchorLng`/`anchorLat`, WGS84)
// and rotates them all by the primary's `bearing`. `picWidth` is recorded for
// a future common-width sizing pass (so wide supplementary plates could render
// proportionally shorter); it is not shipped to tiles yet. We only stack groups of ≥2 *catalogued* signs
// (uncatalogued members have no pictogram) whose span is under SPAN_CAP — a
// guard against the handful of pathological GG_NAMEs reused kilometres apart.

import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'

import { RAW_DIR, SOURCE_SRS, TARGET_SRS } from './sign-layers.mjs'

const SPAN_CAP = 15 // metres — above this the GG_NAME isn't a real co-located assembly

const ABV_GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')
const FACE_BEARINGS = join(RAW_DIR, '_face_bearings.json')
const CATALOGUE = join('app', 'data', 'signCatalogue.json')
const SIGNS_DIR = join('public', 'signs')
const OUT = join(RAW_DIR, '_sign_stacks.json')

// Top-of-post → bottom-of-post ordering. Supplementary plates always sit
// under the main signs (the cardinal rule); the rest follow the Index-Plan
// importance order, with SIGNID as a stable tiebreak.
const RANK = { regulatory: 0, warning: 1, informatory: 2, temporary: 3, supplementary: 9 }

const memberRx = /<core:cityObjectMember>([\s\S]*?)<\/core:cityObjectMember>/g
const ptPosRx = /<gml:pos>([-\d.]+)\s+([-\d.]+)<\/gml:pos>/
const attrRx = (name, kind) => new RegExp(
  `<gen:${kind}Attribute name="${name}">[\\s\\S]*?<gen:value>([^<]*)<\\/gen:value>`
)

const catalogue = JSON.parse(await readFile(CATALOGUE, 'utf8'))
const faceBearings = JSON.parse(await readFile(FACE_BEARINGS, 'utf8'))

// Pictogram pixel width per SIGNID, read straight from the PNG IHDR header
// (bytes 16-19, big-endian) — no decode needed. All pictograms are 120 px tall,
// so width alone gives the aspect the runtime needs to normalise on width.
const widthCache = new Map()
function picWidth(signid) {
  if (widthCache.has(signid)) return widthCache.get(signid)
  let w = 120
  try {
    w = readFileSync(join(SIGNS_DIR, `${signid}.png`)).readUInt32BE(16)
  } catch { /* missing pictogram → keep 120 */ }
  widthCache.set(signid, w)
  return w
}

// --- Parse ABV_PT: FEATUREID, GG_NAME, SIGNID, HK1980 position ---
console.log(`Reading ${ABV_GML}…`)
const abvText = await readFile(ABV_GML, 'utf8')
const fidRx = attrRx('FEATUREID', 'int')
const ggRx = attrRx('GG_NAME', 'string')
const signidRx = attrRx('SIGNID', 'string')

const groups = new Map() // GG_NAME → [{ fid, signid, group, rank, x, y }]
let parsed = 0
for (const m of abvText.matchAll(memberRx)) {
  const body = m[1]
  const fid = body.match(fidRx)?.[1]
  const gg = body.match(ggRx)?.[1]?.trim()
  const signid = body.match(signidRx)?.[1]?.trim()
  const pos = body.match(ptPosRx)
  if (!fid || !pos) continue
  parsed++
  // Only catalogued signs render a pictogram, so only they can be stacked.
  // Ungrouped signs (empty GG_NAME) are never part of an assembly.
  const entry = signid ? catalogue[signid] : undefined
  if (!gg || !entry) continue
  let arr = groups.get(gg)
  if (!arr) groups.set(gg, arr = [])
  arr.push({ fid, signid, group: entry.group, rank: RANK[entry.group] ?? 5, x: +pos[1], y: +pos[2] })
}
console.log(`  ${parsed} ABV_PT features, ${groups.size} GG_NAME groups with catalogued members`)

// --- Assign stack order within each tight, multi-sign group ---
// Every member of an assembly shares the primary's anchor, so records point at
// a deduped `anchors` list (one entry per assembly) — we reproject each anchor
// once, not once per member.
const records = [] // { fid, i, size, picW, anchorIdx, bearing }
const anchors = [] // [[x, y], …] EPSG:2326, unique per assembly
const anchorIndex = new Map() // "x y" → index into `anchors`
let stacked = 0, skippedSpan = 0, maxSize = 0
for (const members of groups.values()) {
  if (members.length < 2) continue
  const span = Math.max(
    Math.max(...members.map(m => m.x)) - Math.min(...members.map(m => m.x)),
    Math.max(...members.map(m => m.y)) - Math.min(...members.map(m => m.y))
  )
  if (span > SPAN_CAP) {
    skippedSpan++
    continue
  }
  members.sort((a, b) => a.rank - b.rank || a.signid.localeCompare(b.signid))
  const size = members.length
  maxSize = Math.max(maxSize, size)
  const primary = members[0]
  const bearing = faceBearings[primary.fid] ?? null // whole post rotates by the primary's facing
  const key = `${primary.x} ${primary.y}`
  let ai = anchorIndex.get(key)
  if (ai === undefined) {
    ai = anchors.length
    anchorIndex.set(key, ai)
    anchors.push([primary.x, primary.y])
  }
  members.forEach((m, i) => {
    records.push({ fid: m.fid, i, size, picW: picWidth(m.signid), anchorIdx: ai, bearing })
  })
  stacked++
}
console.log(`  ${stacked} assemblies stacked (${records.length} signs), ${skippedSpan} skipped over ${SPAN_CAP}m span; tallest stack ${maxSize}`)

// --- Reproject the unique anchor points EPSG:2326 → WGS84 in one pass ---
console.log(`Reprojecting ${anchors.length} anchors …`)
const gt = spawn('gdaltransform', ['-s_srs', SOURCE_SRS, '-t_srs', TARGET_SRS])
let gtOut = ''
gt.stdout.on('data', (d) => {
  gtOut += d
})
gt.stderr.on('data', () => { /* gdaltransform chatters on stderr; ignore */ })
for (const [x, y] of anchors) gt.stdin.write(`${x} ${y}\n`)
gt.stdin.end()
const [gtCode] = await once(gt, 'close')
if (gtCode !== 0) {
  console.error('gdaltransform failed — is GDAL installed? (brew install gdal)')
  process.exit(gtCode)
}
const wgs = gtOut.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number))

const out = {}
for (const r of records) {
  const [lng, lat] = wgs[r.anchorIdx]
  out[r.fid] = [r.i, r.size, r.picW, +lng.toFixed(6), +lat.toFixed(6), r.bearing]
}

await writeFile(OUT, JSON.stringify(out))
console.log(`\nWrote ${OUT}`)
