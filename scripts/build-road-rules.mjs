// Builds the road-rules overlay archive — where a speed limit, a bus-only lane
// or a vehicle prohibition applies — from TD's Road Network v2 FGDB (the
// package fetch-data already downloads for compute-bearings). The extents are
// TD's own; nothing here is derived from sign points. (The evaluation that
// settled this: 26 % of 70 km/h segments and 64 % of bus-lane segments have no
// sign within 30 m, so a sign-walked extent could never match the published
// one — while 90–99 % of the matching signs sit within 15 m of their rule
// feature, which is what the runtime's sign→rule lookup leans on.)
//
// Three tippecanoe source-layers, one per RDNET_RULE_LAYERS key:
//   speed        SPEED_LIMIT lines as-is; `speed` = the int of "70 km/h".
//                50 km/h is the territory default and has no rows.
//   buslane      BUS_ONLY_LANE lines as-is, with the printed hours + day mask.
//   prohibition  PROHIBITION is a POINT at the sign that names, by
//                ROAD_ROUTE_ID, the whole CENTERLINE route it governs — so each
//                row is drawn on that route's line, once per `kind` it
//                addresses (see kindsOf), so a legend row is a plain filter.
// Every feature also carries the route's street name (st_en / st_zh) for the
// popup, joined from CENTERLINE by ROAD_ROUTE_ID.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import {
  RAW_DIR, TARGET_SRS, OUTPUT_PMTILES_RULES,
  RDNET_CENTERLINE_LAYER, RDNET_RULE_LAYERS, PROHIBITION_KINDS
} from './sign-layers.mjs'
import { requireTool, mergeTilesVersion, streamOgrGeoJSON } from './geo.mjs'

const RDNET_ZIP = join(RAW_DIR, 'RdNet_IRNP.gdb.zip')
const scratch = key => join(RAW_DIR, `_rules_${key}.geojsonl`)

// One FGDB layer as WGS84 features. `-dim XY` is mandatory: SPEED_LIMIT,
// BUS_ONLY_LANE and PROHIBITION are *measured* (XYM) geometries and
// tippecanoe would otherwise read the M as elevation. `-select` keeps the
// tiles lean — every property is bytes in every tile the feature touches.
const readLayer = (layer, select) => streamOgrGeoJSON(layer, [
  `/vsizip/${RDNET_ZIP}`, layer,
  '-t_srs', TARGET_SRS,
  '-dim', 'XY',
  '-select', select
])

const text = v => (v == null || v === '' || v === 'NA' ? null : String(v).trim())
// CENTERLINE spells "no name" as -99.
const street = (v) => {
  const s = text(v)
  return s === '-99' ? null : s
}
// Tile properties with the null/undefined entries dropped, so an absent
// remark or street name costs no bytes.
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null))

// Who a PROHIBITION row addresses. INC_VEH_TYPE is the coded field, but two
// of the rules the map wants live only in the free-text REMARKS: learner
// drivers ("LD Proh", coded OTH) and all-motor-vehicle closures ("AMV Proh").
// The remarks follow `<who> Proh/ E <exceptions>`; the head token is enough.
// A row can address several (e.g. "PLB Proh/ LD Proh" → plb + ld); a row none
// of these match is `other` rather than dropped. The head is returned too, so
// the `other` tally can report TD's wording drifting past these rules.
function kindsOf(p) {
  const remarks = p.REMARKS ?? ''
  const head = remarks.split('/')[0].trim()
  const inc = (p.INC_VEH_TYPE ?? '').split(',').map(s => s.trim())
  const kinds = new Set()
  if (/\bLD\s*Proh/i.test(remarks)) kinds.add('ld')
  if (inc.includes('PLB') || /^PLB\s*Proh|^Proh\s+PLB/i.test(head)) kinds.add('plb')
  if (inc.includes('GV') || /^GV\b/i.test(head) || text(p.OTHER_REST_TYPE_GV)) kinds.add('gv')
  if (inc.includes('ALL') || /^AMV\s*Proh|^All vehicles/i.test(head)) kinds.add('all')
  if (!kinds.size) kinds.add('other')
  return { kinds: [...kinds], head: head || '(blank)' }
}

// Backpressure-aware append of one feature line.
async function writeFeature(out, geometry, properties) {
  const line = JSON.stringify({ type: 'Feature', geometry, properties }) + '\n'
  if (!out.write(line)) await once(out, 'drain')
}

requireTool('ogr2ogr', 'brew install gdal')
requireTool('tippecanoe', 'brew install tippecanoe')

const t0 = Date.now()

// 1. The three rule layers — small (≈7k rows) so they're held in memory while
//    the CENTERLINE pass below resolves their routes.
console.log(`Reading ${RDNET_ZIP} …`)
const speedRows = []
for await (const f of readLayer(RDNET_RULE_LAYERS.speed, 'ROAD_ROUTE_ID,SPEED_LIMIT,BOUND,REMARKS')) speedRows.push(f)
const busRows = []
for await (const f of readLayer(RDNET_RULE_LAYERS.buslane, 'ROAD_ROUTE_ID,TIME_ZONE,EFFECTIVE_DAY,BOUND,REMARKS')) busRows.push(f)
const prohRows = []
for await (const f of readLayer(RDNET_RULE_LAYERS.prohibition, 'ROAD_ROUTE_ID,INC_VEH_TYPE,EXC_VEH_TYPE,PART_TIME_PROHIBITION,EFF_ALL_DAYS,OTHER_REST_TYPE_GV,REMARKS')) prohRows.push(f)
console.log(`  ${RDNET_RULE_LAYERS.speed}: ${speedRows.length}  ${RDNET_RULE_LAYERS.buslane}: ${busRows.length}  ${RDNET_RULE_LAYERS.prohibition}: ${prohRows.length}`)

// 2. One CENTERLINE pass keeping only the routes those rows reference: the
//    street names for every rule, the line geometry for prohibitions.
const wanted = new Set([...speedRows, ...busRows, ...prohRows].map(f => f.properties.ROAD_ROUTE_ID))
const needGeometry = new Set(prohRows.map(f => f.properties.ROAD_ROUTE_ID))
const routes = new Map()
for await (const f of readLayer(RDNET_CENTERLINE_LAYER, 'ROUTE_ID,STREET_ENAME,STREET_CNAME')) {
  const id = f.properties.ROUTE_ID
  if (!wanted.has(id)) continue
  routes.set(id, {
    st_en: street(f.properties.STREET_ENAME),
    st_zh: street(f.properties.STREET_CNAME),
    geometry: needGeometry.has(id) ? f.geometry : null
  })
}
console.log(`  ${RDNET_CENTERLINE_LAYER}: ${routes.size} of ${wanted.size} referenced routes found`)

const streetProps = (routeId) => {
  const r = routes.get(routeId)
  return { st_en: r?.st_en, st_zh: r?.st_zh }
}

// 3. Write the three scratch streams tippecanoe reads.
await mkdir(dirname(OUTPUT_PMTILES_RULES), { recursive: true })
const outs = Object.fromEntries(Object.keys(RDNET_RULE_LAYERS).map(k => [k, createWriteStream(scratch(k))]))
const counts = { speed: 0, buslane: 0, prohibition: 0 }

let unparsedSpeed = 0
for (const { geometry, properties: p } of speedRows) {
  const speed = parseInt(p.SPEED_LIMIT, 10)
  if (!Number.isFinite(speed)) {
    unparsedSpeed++
    continue
  }
  await writeFeature(outs.speed, geometry, compact({
    speed,
    bound: p.BOUND ?? 0,
    remarks: text(p.REMARKS),
    ...streetProps(p.ROAD_ROUTE_ID)
  }))
  counts.speed++
}
if (unparsedSpeed) console.warn(`  ⚠ ${unparsedSpeed} SPEED_LIMIT rows with an unparseable value skipped`)

for (const { geometry, properties: p } of busRows) {
  await writeFeature(outs.buslane, geometry, compact({
    hours: text(p.TIME_ZONE),
    days: text(p.EFFECTIVE_DAY),
    bound: p.BOUND ?? 0,
    remarks: text(p.REMARKS),
    ...streetProps(p.ROAD_ROUTE_ID)
  }))
  counts.buslane++
}

const kindTally = Object.fromEntries(PROHIBITION_KINDS.map(k => [k, 0]))
const otherHeads = new Map()
let noRoute = 0
for (const { properties: p } of prohRows) {
  const route = routes.get(p.ROAD_ROUTE_ID)
  if (!route?.geometry) {
    noRoute++
    continue
  }
  const { kinds, head } = kindsOf(p)
  if (kinds.includes('other')) otherHeads.set(head, (otherHeads.get(head) ?? 0) + 1)
  const shared = compact({
    inc: text(p.INC_VEH_TYPE),
    exc: text(p.EXC_VEH_TYPE),
    part_time: p.PART_TIME_PROHIBITION === 'Y',
    all_days: p.EFF_ALL_DAYS !== 'N',
    remarks: text(p.REMARKS),
    ...streetProps(p.ROAD_ROUTE_ID)
  })
  for (const kind of kinds) {
    await writeFeature(outs.prohibition, route.geometry, { kind, ...shared })
    kindTally[kind]++
    counts.prohibition++
  }
}
if (noRoute) console.warn(`  ⚠ ${noRoute} PROHIBITION rows reference a route missing from CENTERLINE — skipped`)

for (const out of Object.values(outs)) out.end()
await Promise.all(Object.values(outs).map(out => once(out, 'finish')))

console.log(`  features → speed ${counts.speed}, buslane ${counts.buslane}, prohibition ${counts.prohibition} (rows × kinds)`)
console.log(`  prohibition kinds: ${PROHIBITION_KINDS.map(k => `${k} ${kindTally[k]}`).join(', ')}`)
// The heads that fell to `other` are TD's wording drifting past kindsOf —
// review after every refresh; a new common head means a new rule or a regex fix.
const heads = [...otherHeads].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ×${n}`)
console.log(`  \`other\` remark heads: ${heads.join(' · ') || 'none'}`)

if (counts.speed + counts.buslane + counts.prohibition === 0) {
  console.error('No rule features converted — aborting before tippecanoe.')
  process.exit(1)
}

// 4. One archive, one named layer per kind. Lines are never rate-dropped, so
//    no `-r`; `-Z 9` / `-z 15` match the sign archives and the map's zoom
//    range (never `-zg` — see build-tiles.mjs).
console.log('\nBuilding road-rules tiles …')
const tip = spawn('tippecanoe', [
  '-o', OUTPUT_PMTILES_RULES,
  '-n', 'HK Road Rules',
  '-Z', '9',
  '-z', '15',
  '--no-feature-limit',
  '--no-tile-size-limit',
  '--quiet',
  '--force',
  ...Object.keys(RDNET_RULE_LAYERS).map(k => `-L${k}:${scratch(k)}`)
], { stdio: 'inherit' })
const [tipCode] = await once(tip, 'close')
if (tipCode !== 0) process.exit(tipCode)

for (const k of Object.keys(RDNET_RULE_LAYERS)) await rm(scratch(k), { force: true })

// Own cache-buster key: this archive rebuilds independently of the sign
// archives, so it must not invalidate their byte-range cache (and vice versa).
const rulesVersion = createHash('sha256').update(await readFile(OUTPUT_PMTILES_RULES)).digest('hex').slice(0, 12)
await mergeTilesVersion({ rulesVersion })

console.log(`\nDone → ${OUTPUT_PMTILES_RULES} (v${rulesVersion}, ${Date.now() - t0} ms)`)
