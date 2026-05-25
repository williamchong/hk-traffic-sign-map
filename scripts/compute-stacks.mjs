// Derive how each traffic-sign-abbreviation feature renders when it belongs to
// a co-located assembly, so the group draws as one rigid signpost.
// Output: data/raw/_sign_stacks.json — keyed by FEATUREID →
//   [ stackIndex, stackSize, picWidth, anchorLng, anchorLat, bearing, stackOff ]
// Also writes app/data/signGroups.json — { SIGNID: [GG_NAME, …] } over the
// same stacked assemblies, so the runtime sign-ID filter can pull in a matched
// sign's post-mates and show the complete signpost (see useTrafficLayers
// mapFilter). Built here because this is where assembly membership is known.
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
// and rotates them all by the primary's `bearing`. Stacked members render at a
// COMMON WIDTH (so a wide supplementary plate comes out as a short wide bar, a
// tall warning sign stays tall — true plate proportions, not equal heights),
// which means each member's vertical extent differs; `stackOff` is the baked,
// per-member cumulative centre offset (source-px, top sign on the anchor, the
// rest hanging below) the runtime lays the column out with. We only stack
// groups of ≥2 *catalogued* signs (uncatalogued members have no pictogram)
// whose span is under SPAN_CAP — a guard against the handful of pathological
// GG_NAMEs reused kilometres apart.

import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'

import { RAW_DIR, SOURCE_SRS, TARGET_SRS } from './sign-layers.mjs'

const SPAN_CAP = 15 // metres — above this the GG_NAME isn't a real co-located assembly

// Stacked plates are re-rendered to this common WIDTH (px) by gen-stacked-icons,
// so within a post every plate is the same width and its height follows its true
// aspect. We bake the layout offsets in that same source space here.
const COMMON_WIDTH = 120 // px — must match gen-stacked-icons' resize width
const STACK_GAP = 10 // px gap between stacked plates (source space)
// Quantize each baked offset to this grid so the runtime can resolve it with a
// finite `match` (icon-offset can't construct [0, value] from a scalar). Must
// match OFFSET_STEP in app/components/TrafficMap.vue (duplicated per the
// two-runtime rule — scripts/ and app/ never cross-import).
const OFFSET_STEP = 8 // px

const ABV_GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')
const FACE_BEARINGS = join(RAW_DIR, '_face_bearings.json')
const CATALOGUE = join('app', 'data', 'signCatalogue.json')
const SIGNS_DIR = join('public', 'signs')
const OUT = join(RAW_DIR, '_sign_stacks.json')
const GROUPS_OUT = join('app', 'data', 'signGroups.json')

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

// Pictogram pixel dimensions per SIGNID, read straight from the PNG IHDR header
// (width bytes 16-19, height 20-23, big-endian) — no decode needed. Most are
// 120 px tall but a handful of very wide signs are shorter, so we read both to
// get each plate's true aspect for the common-width height/offset maths below.
const dimsCache = new Map()
function picDims(signid) {
  let d = dimsCache.get(signid)
  if (d) return d
  d = { w: 120, h: 120 }
  try {
    const buf = readFileSync(join(SIGNS_DIR, `${signid}.png`))
    d = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch { /* missing pictogram → keep 120×120 */ }
  dimsCache.set(signid, d)
  return d
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
const records = [] // { fid, i, size, picW, anchorIdx, bearing, off }
const anchors = [] // [[x, y], …] EPSG:2326, unique per assembly
const anchorIndex = new Map() // "x y" → index into `anchors`
const groupIndex = new Map() // SIGNID → Set(GG_NAME), stacked assemblies only
let stacked = 0, skippedSpan = 0, maxSize = 0, maxOff = 0
for (const [gg, members] of groups) {
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
  // Lay the column out in the common-width source space: each plate is
  // COMMON_WIDTH wide and `COMMON_WIDTH × picH / picW` tall (its true aspect).
  // Member 0's centre sits on the anchor; each subsequent plate hangs below,
  // its centre a half-height + gap + half-height past the previous one's edge.
  // Quantize the centre offset to the runtime's match grid (OFFSET_STEP).
  let cursor = 0 // bottom edge of the last placed plate, source-px below the anchor
  members.forEach((m, i) => {
    const { w, h } = picDims(m.signid)
    const ph = COMMON_WIDTH * h / w
    const center = i === 0 ? 0 : cursor + STACK_GAP + ph / 2
    cursor = center + ph / 2
    const off = Math.round(center / OFFSET_STEP) * OFFSET_STEP
    maxOff = Math.max(maxOff, off)
    records.push({ fid: m.fid, i, size, picW: w, anchorIdx: ai, bearing, off })
  })
  // Index each distinct SIGNID on this post → its GG_NAME, so the runtime can
  // expand a sign-ID filter to the whole assembly (dedup signids repeated on
  // one post — two identical plates shouldn't list the group twice).
  for (const sid of new Set(members.map(m => m.signid))) {
    let set = groupIndex.get(sid)
    if (!set) groupIndex.set(sid, set = new Set())
    set.add(gg)
  }
  stacked++
}
console.log(`  ${stacked} assemblies stacked (${records.length} signs), ${skippedSpan} skipped over ${SPAN_CAP}m span; tallest stack ${maxSize}, max offset ${maxOff}px`)

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
  out[r.fid] = [r.i, r.size, r.picW, +lng.toFixed(6), +lat.toFixed(6), r.bearing, r.off]
}

await writeFile(OUT, JSON.stringify(out))
console.log(`\nWrote ${OUT}`)

const groupObj = {}
for (const [sid, set] of groupIndex) groupObj[sid] = [...set]
await writeFile(GROUPS_OUT, JSON.stringify(groupObj))
console.log(`Wrote ${GROUPS_OUT} (${groupIndex.size} sign IDs → companion groups)`)
