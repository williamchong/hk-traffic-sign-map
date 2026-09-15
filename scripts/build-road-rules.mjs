// Builds the road-rules overlay archive — where a speed limit, a bus-only lane,
// a vehicle prohibition, a no-stopping restriction or a pedestrian zone
// applies — from TD's Road Network v2 FGDB (the
// package fetch-data already downloads for compute-bearings). The extents are
// TD's own; nothing here is derived from sign points. (The evaluation that
// settled this: 26 % of 70 km/h segments and 64 % of bus-lane segments have no
// sign within 30 m, so a sign-walked extent could never match the published
// one — while 90–99 % of the matching signs sit within 15 m of their rule
// feature, which is what the runtime's sign→rule lookup leans on.)
//
// One tippecanoe source-layer per RDNET_RULE_LAYERS key:
//   speed        SPEED_LIMIT lines as-is; `speed` = the int of "70 km/h".
//                50 km/h is the territory default and has no rows.
//   buslane      BUS_ONLY_LANE lines as-is, with the printed hours + day mask.
//   prohibition  PROHIBITION is a POINT at the sign that names, by
//                ROAD_ROUTE_ID, the whole CENTERLINE route it governs — so each
//                row is drawn on that route's line, once per `kind` it
//                addresses (see kindsOf), so a legend row is a plain filter.
//   nsr          NSR (no-stopping) lines as-is — the biggest layer here by far
//                (20k rows), and the only one whose descriptive fields are
//                CODED (see the NSR_* tables in sign-layers.mjs) rather than
//                printed. It is also the only one with no route id, so it is
//                streamed straight through rather than buffered for a join.
//   pedzone      PEDESTRIAN_ZONE lines as-is; same hours + day mask as buslane.
// Every feature also carries its street name (st_en / st_zh) for the popup,
// joined from CENTERLINE — by ROAD_ROUTE_ID for every layer but NSR, which
// names its roads by ST_CODE instead.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import {
  RAW_DIR, TARGET_SRS, OUTPUT_PMTILES_RULES,
  RDNET_CENTERLINE_LAYER, RDNET_RULE_LAYERS, PROHIBITION_KINDS,
  NSR_VEHICLE_TYPES, NSR_TIME_ZONES, NSR_EFFECTIVE_DAYS
} from './sign-layers.mjs'
import { requireTool, mergeTilesVersion, streamOgrGeoJSON } from './geo.mjs'

const RDNET_ZIP = join(RAW_DIR, 'RdNet_IRNP.gdb.zip')
const scratch = key => join(RAW_DIR, `_rules_${key}.geojsonl`)

// One FGDB layer as WGS84 features. `-dim XY` is mandatory: every rule layer
// but NSR is a *measured* (XYM) geometry and tippecanoe would otherwise read
// the M as elevation. `-select` keeps the tiles lean — every property is bytes
// in every tile the feature touches.
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
async function writeFeature(out, geometry, properties, tippecanoe) {
  const line = JSON.stringify({ type: 'Feature', geometry, properties, tippecanoe }) + '\n'
  if (!out.write(line)) await once(out, 'drain')
}

requireTool('ogr2ogr', 'brew install gdal')
requireTool('tippecanoe', 'brew install tippecanoe')

const t0 = Date.now()

// 1. The route-referencing rule layers — small (≈7k rows) so they're held in
//    memory while the CENTERLINE pass below resolves their routes. NSR is
//    deliberately NOT read here: at 20k line features it is bigger than all of
//    these together, and since it needs no route join there is nothing to hold
//    it in memory FOR — it streams straight to its scratch file in step 3.
console.log(`Reading ${RDNET_ZIP} …`)
const speedRows = []
for await (const f of readLayer(RDNET_RULE_LAYERS.speed, 'ROAD_ROUTE_ID,SPEED_LIMIT,BOUND,REMARKS')) speedRows.push(f)
const busRows = []
for await (const f of readLayer(RDNET_RULE_LAYERS.buslane, 'ROAD_ROUTE_ID,TIME_ZONE,EFFECTIVE_DAY,BOUND,REMARKS')) busRows.push(f)
const prohRows = []
for await (const f of readLayer(RDNET_RULE_LAYERS.prohibition, 'ROAD_ROUTE_ID,INC_VEH_TYPE,EXC_VEH_TYPE,PART_TIME_PROHIBITION,EFF_ALL_DAYS,OTHER_REST_TYPE_GV,REMARKS')) prohRows.push(f)
const pedRows = []
for await (const f of readLayer(RDNET_RULE_LAYERS.pedzone, 'ROAD_ROUTE_ID,TIME_ZONE,EFFECTIVE_DAY,REMARKS')) pedRows.push(f)
console.log(`  ${RDNET_RULE_LAYERS.speed}: ${speedRows.length}  ${RDNET_RULE_LAYERS.buslane}: ${busRows.length}  ${RDNET_RULE_LAYERS.prohibition}: ${prohRows.length}  ${RDNET_RULE_LAYERS.pedzone}: ${pedRows.length}`)

// 2. CENTERLINE, serving two different joins:
//    • by ROUTE_ID, for the layers that reference a route — street names for
//      all of them, plus the line geometry for prohibitions (points only).
//    • by ST_CODE, for NSR, which carries no route id. This one is built
//      UNFILTERED: NSR hasn't been read yet (it streams later), so its street
//      codes aren't knowable here — and at ~5.8k distinct codes holding names
//      for every street costs nothing.
//    Names and geometry are two separate reads, run concurrently. CENTERLINE's
//    arcs arrive pre-stroked (~12M vertices), and a single read decoded,
//    reprojected and serialised all 36k routes' geometry (~400 MB of JSON,
//    ~10 s) to keep the 2.2k prohibitions need. Names alone go through the
//    SQLite dialect, whose SELECT never touches the geometry column (0.4 s —
//    OGR SQL and `-nlt NONE` both still decode it); geometry is fetched with
//    an OGR `-where` on just those route ids (2 s). Never put that IN list
//    through `-dialect SQLite`: it took 272 s. The geometry is simplified at
//    1 cm on the way out (source metres, as in compute-bearings): serialising
//    the pre-stroked arcs was most of that read — 54 MB of JSON → 1 MB, and
//    the same bytes again per prohibition `kind` in tippecanoe's input — and
//    1 cm is ~1/28 of a z15 tile unit, so no drawn line moves.
const wanted = new Set([...speedRows, ...busRows, ...prohRows, ...pedRows].map(f => f.properties.ROAD_ROUTE_ID))
const needGeometry = new Set(prohRows.map(f => f.properties.ROAD_ROUTE_ID))
const routes = new Map()
const streetsByCode = new Map()
// Kept apart from `routes` until both reads finish: the two interleave, and
// the names read creates the `routes` entry a geometry would be attached to.
const geometries = new Map()

// Prints "No SRS set on layer" — harmless: the SELECT carries no geometry, and
// no SRS flag quiets it (`--config CPL_LOG /dev/null` would, but it also hides
// the text of a real failure).
async function readNames() {
  const sql = `SELECT ROUTE_ID, ST_CODE, STREET_ENAME, STREET_CNAME FROM ${RDNET_CENTERLINE_LAYER}`
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', sql])) {
    const names = { st_en: street(p.STREET_ENAME), st_zh: street(p.STREET_CNAME) }
    if (p.ST_CODE != null && !streetsByCode.has(p.ST_CODE)) streetsByCode.set(p.ST_CODE, names)
    if (wanted.has(p.ROUTE_ID)) routes.set(p.ROUTE_ID, names)
  }
}

async function readProhibitionGeometries() {
  // An empty set would render `IN ()`, which OGR rejects.
  if (!needGeometry.size) return
  const read = streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [
    `/vsizip/${RDNET_ZIP}`, RDNET_CENTERLINE_LAYER,
    '-t_srs', TARGET_SRS,
    '-dim', 'XY',
    '-simplify', '0.01',
    '-select', 'ROUTE_ID',
    '-where', `ROUTE_ID IN (${[...needGeometry].join(',')})`
  ])
  for await (const f of read) geometries.set(f.properties.ROUTE_ID, f.geometry)
}

await Promise.all([readNames(), readProhibitionGeometries()])
for (const [id, geometry] of geometries) if (routes.has(id)) routes.get(id).geometry = geometry
console.log(`  ${RDNET_CENTERLINE_LAYER}: ${routes.size} of ${wanted.size} referenced routes found, ${geometries.size} geometries, ${streetsByCode.size} street codes named`)

// A miss yields undefineds that `compact` drops.
const namesFrom = (map, key) => {
  const r = map.get(key)
  return { st_en: r?.st_en, st_zh: r?.st_zh }
}
const streetProps = routeId => namesFrom(routes, routeId)
const streetPropsByCode = stCode => namesFrom(streetsByCode, stCode)

// Diagnostic tallies: count per key, printed most-common first.
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
const tally = (m, sep = ' ') => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}${sep}${n}`).join(' · ')

// 3. Write the scratch streams tippecanoe reads, one per layer.
await mkdir(dirname(OUTPUT_PMTILES_RULES), { recursive: true })
const outs = Object.fromEntries(Object.keys(RDNET_RULE_LAYERS).map(k => [k, createWriteStream(scratch(k))]))
const counts = Object.fromEntries(Object.keys(RDNET_RULE_LAYERS).map(k => [k, 0]))

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

// Same printed hours + day mask as a bus lane, minus the BOUND: a pedestrian
// zone closes the whole street, so there is no side of the centreline to
// offset the line onto.
for (const { geometry, properties: p } of pedRows) {
  await writeFeature(outs.pedzone, geometry, compact({
    hours: text(p.TIME_ZONE),
    days: text(p.EFFECTIVE_DAY),
    remarks: text(p.REMARKS),
    ...streetProps(p.ROAD_ROUTE_ID)
  }))
  counts.pedzone++
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
  if (kinds.includes('other')) bump(otherHeads, head)
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

// NSR streams feature-by-feature: its own geometry, and a street name from the
// by-code map already built, so nothing is held. The three coded fields become
// slugs (`veh` is TD's vehicle code, shared with the prohibition layer's i18n);
// deliberately `tz` / `eday` rather than buslane's `hours` / `days`, which hold
// free text and a Y/N mask — one property name, one value space.
// Kept out of the z9–11 tiles entirely (= RULE_MINZOOM.nsr in TrafficMap.vue):
// nothing draws NSR there, but the always-on speed hit layer loads those tiles
// for every visitor, overlay or not — and 18.9k lines at z9 roughly
// quadrupled them. The sign popup's lookup finds no NSR line below z12, where
// simplification already makes a 15 m match unreliable.
const NSR_TILE_ZOOM = { minzoom: 12 }
const nsrTally = { veh: new Map(), tz: new Map(), eday: new Map() }
let nsrNoStreet = 0
let othBlank = 0
for await (const { geometry, properties: p } of readLayer(RDNET_RULE_LAYERS.nsr, 'VEHICLE_TYPE,TIME_ZONE,EFFECTIVE_DAY,ST_CODE_1,REMARKS')) {
  const veh = NSR_VEHICLE_TYPES[p.VEHICLE_TYPE] ?? 'OTH'
  const tz = NSR_TIME_ZONES[p.TIME_ZONE] ?? 'other'
  const eday = NSR_EFFECTIVE_DAYS[p.EFFECTIVE_DAY] ?? 'other'
  const remarks = text(p.REMARKS)
  const names = streetPropsByCode(p.ST_CODE_1)
  if (!names.st_en && !names.st_zh) nsrNoStreet++
  if (veh === 'OTH' && !remarks) othBlank++
  bump(nsrTally.veh, veh)
  bump(nsrTally.tz, tz)
  bump(nsrTally.eday, eday)
  await writeFeature(outs.nsr, geometry, compact({ veh, tz, eday, remarks, ...names }), NSR_TILE_ZOOM)
  counts.nsr++
}

for (const out of Object.values(outs)) out.end()
await Promise.all(Object.values(outs).map(out => once(out, 'finish')))

console.log(`  features → ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ')} (prohibition = rows × kinds)`)
console.log(`  prohibition kinds: ${PROHIBITION_KINDS.map(k => `${k} ${kindTally[k]}`).join(', ')}`)
// The heads that fell to `other` are TD's wording drifting past kindsOf —
// review after every refresh; a new common head means a new rule or a regex fix.
console.log(`  \`other\` remark heads: ${tally(otherHeads, ' ×') || 'none'}`)
// NSR's code distribution, to read against the tallies in sign-layers.mjs: a
// shifted count means TD re-coded a table and a slug now says the wrong thing.
console.log(`  nsr veh: ${tally(nsrTally.veh)}`)
console.log(`  nsr tz: ${tally(nsrTally.tz)}  eday: ${tally(nsrTally.eday)}`)
console.log(`  nsr: ${othBlank} OTH rows carry no REMARKS; ${nsrNoStreet} rows name no street`)

if (Object.values(counts).every(n => n === 0)) {
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
