// Derive a vertical stack order per traffic-sign-abbreviation feature so that
// signs installed together as one assembly render as a signpost on the map.
// Output: data/raw/_sign_stacks.json — { "<FEATUREID>": [index, size], ... }
//
// The grouping key is the GML `GG_NAME` ("sign-group name", e.g. W02R22D_392):
// signs sharing it were gazetted/installed as one unit and carry combined
// meaning (a main sign with its supplementary plate underneath, two warnings
// on one post, …). `GG_NAME` is NOT the sign type (that's REFNAME/SIGNID) nor
// the Index-Plan category (regulatory/warning/…); it's the assembly id.
//
// Members of a group sit at slightly different surveyed coordinates (median
// span ~4 m), so the runtime keeps each sign at its real location and uses a
// per-feature `icon-offset` keyed by the stack index to draw the column — see
// TrafficMap.vue. We only emit a stack for groups of ≥2 *catalogued* signs
// (uncatalogued members have no pictogram to stack and stay as their own dot)
// whose span is under SPAN_CAP — a guard against the handful of pathological
// GG_NAMEs reused across signs kilometres apart.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { RAW_DIR } from './sign-layers.mjs'

const SPAN_CAP = 15 // metres — above this the GG_NAME isn't a real co-located assembly

const ABV_GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')
const CATALOGUE = join('app', 'data', 'signCatalogue.json')
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
const out = {}
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
  members.forEach((m, i) => {
    out[m.fid] = [i, size]
  })
  stacked++
}
console.log(`  ${stacked} assemblies stacked (${Object.keys(out).length} signs), ${skippedSpan} skipped over ${SPAN_CAP}m span; tallest stack ${maxSize}`)

await writeFile(OUT, JSON.stringify(out))
console.log(`\nWrote ${OUT}`)
