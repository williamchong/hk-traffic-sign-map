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
//   cutoff       DERIVED (road-cutoff.mjs): CENTERLINE routes public light
//                buses cannot enter at all, because prohibitions and turn bans
//                close every way in; each names the routes that seal its area.
//   taxi         CURATED (taxi-zones.mjs): which colour of taxi may serve a
//                road. The one reading here whose extent is NOT TD's own
//                geometry, because none exists — PROHIBITION's `TX` code has
//                no colour dimension and Cap. 374E Sch. 7 is prose plus a
//                raster map. data/taxi-zones/areas.json carries the extent,
//                classified onto CENTERLINE against HAD's district partition;
//                the TS329 / TS569 terminators AUDIT that file and never feed
//                it (audit-taxi-zones.mjs), so the rule below still holds.
// The PROHIBITION rows lag TD's own prohibited-zone notices by 1–35 months
// (both ways), so data/zone-notices/overrides.json — human-curated, each entry
// citing a notice — closes or reopens named routes BEFORE the prohibition
// lines are written and the cut-off search runs (zone-overrides.mjs). A row
// added that way carries `notice` in its tile props, so the popup names the
// notice instead of the network. Notices verify; they never generate extents.
// Every feature also carries its street name (st_en / st_zh) for the popup,
// joined from CENTERLINE — by ROAD_ROUTE_ID for every layer but NSR, which
// names its roads by ST_CODE instead.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import {
  RAW_DIR, TARGET_SRS, OUTPUT_PMTILES_RULES,
  RDNET_CENTERLINE_LAYER, RDNET_RULE_LAYERS, PROHIBITION_KINDS,
  NSR_VEHICLE_TYPES, NSR_TIME_ZONES, NSR_EFFECTIVE_DAYS,
  RDNET_TURN_LAYER, CUTOFF_LAYER, CUTOFF_VEHICLE, TAXI_LAYER
} from './sign-layers.mjs'
import { requireTool, mergeTilesVersion, streamOgrGeoJSON } from './geo.mjs'
import { DASHES } from './text-similarity.mjs'
import { kindsOf, closesForCutoff, computeCutoff } from './road-cutoff.mjs'
import { applyZoneOverrides, loadOverrides } from './zone-overrides.mjs'
import {
  TAXI_AREAS_FILE, DISTRICTS_FILE,
  loadTaxiAreas, classifyRoute, representativePoint, straddles, shareableAreas
} from './taxi-zones.mjs'

const RDNET_ZIP = join(RAW_DIR, 'RdNet_IRNP.gdb.zip')
const scratch = key => join(RAW_DIR, `_rules_${key}.geojsonl`)
const TILE_LAYERS = [...Object.keys(RDNET_RULE_LAYERS), CUTOFF_LAYER, TAXI_LAYER]
// The shareable resolved extent. It lives beside the file it is generated
// from, NOT in app/data/ — nothing in app/ imports it, and every other file
// there is a runtime import.
const TAXI_AREAS_OUT = 'data/taxi-zones/taxiAreas.json'

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
// CENTERLINE spells "no name" as -99 — plainly in English, but four ways in
// the Chinese column: `–９９` (en dash, full-width digits — 4,216 routes),
// `－９９` (1,299), `-９９` (114) and `-99`. NFKC folds the full-width forms but
// not the en dash, so the dashes are folded too, as the name binds fold them.
const street = (v) => {
  const s = text(v)
  return s?.normalize('NFKC').replace(DASHES, '-') === '-99' ? null : s
}
// Tile properties with the null/undefined entries dropped, so an absent
// remark or street name costs no bytes.
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null))

// Backpressure-aware append of one feature line.
async function writeFeature(out, geometry, properties, tippecanoe) {
  const line = JSON.stringify({ type: 'Feature', geometry, properties, tippecanoe }) + '\n'
  if (!out.write(line)) await once(out, 'drain')
}

requireTool('ogr2ogr', 'brew install gdal')
requireTool('tippecanoe', 'brew install tippecanoe')
// Validated here rather than at its own pass below: loadTaxiAreas throws on an
// unknown taxi class, access, district or ring name, and a typo in a
// hand-edited file should abort at the preflight, not ten seconds in.
const taxiAreas = await loadTaxiAreas(TAXI_AREAS_FILE, join(RAW_DIR, DISTRICTS_FILE))

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
// PROHIBITION_ID is read for the overrides' `open` lookup only; it never
// reaches the tiles (the feature loop picks its props explicitly).
for await (const f of readLayer(RDNET_RULE_LAYERS.prohibition, 'PROHIBITION_ID,ROAD_ROUTE_ID,INC_VEH_TYPE,EXC_VEH_TYPE,PART_TIME_PROHIBITION,EFF_ALL_DAYS,OTHER_REST_TYPE_GV,REMARKS,BOUND')) prohRows.push(f)
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
//    • as a directed graph, for the derived cut-off layer — every edge's
//      endpoints and TRAVEL_DIRECTION (see road-cutoff.mjs).
//    Names + endpoints are one SQLite-dialect read (1 s): its SELECT decodes
//    geometry only for the four ST_ endpoint calls, never serialising a line
//    (OGR SQL and `-nlt NONE` serialise every route). CENTERLINE's arcs arrive
//    pre-stroked (~12M vertices), and a single full read decoded, reprojected
//    and serialised all 36k routes' geometry (~400 MB of JSON, ~10 s) to keep
//    the few thousand the tiles need — so line geometry is fetched with an OGR
//    `-where` on just those route ids: the prohibition routes beside that read,
//    the cut-off edges once computeCutoff has named them. Never put that IN list through `-dialect SQLite`: it took
//    272 s. The geometry is simplified at 1 cm on the way out (source metres,
//    as in compute-bearings): serialising the pre-stroked arcs was most of that
//    read — 54 MB of JSON → 1 MB, and the same bytes again per prohibition
//    `kind` in tippecanoe's input — and 1 cm is ~1/28 of a z15 tile unit, so
//    no drawn line moves.
const routes = new Map()
const streetsByCode = new Map()
const graphEdges = []
const turnRows = []

// Prints "No SRS set on layer" — harmless: the SELECT carries no geometry, and
// no SRS flag quiets it (`--config CPL_LOG /dev/null` would, but it also hides
// the text of a real failure).
async function readNamesAndGraph() {
  const first = 'ST_GeometryN(SHAPE, 1)'
  const last = 'ST_GeometryN(SHAPE, ST_NumGeometries(SHAPE))'
  const sql = `SELECT OBJECTID, ROUTE_ID, ST_CODE, STREET_ENAME, STREET_CNAME, TRAVEL_DIRECTION, SHAPE_Length,
    ST_X(ST_StartPoint(${first})) AS sx, ST_Y(ST_StartPoint(${first})) AS sy,
    ST_X(ST_EndPoint(${last})) AS ex, ST_Y(ST_EndPoint(${last})) AS ey
    FROM ${RDNET_CENTERLINE_LAYER}`
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', sql])) {
    const names = { st_en: street(p.STREET_ENAME), st_zh: street(p.STREET_CNAME) }
    if (p.ST_CODE != null && !streetsByCode.has(p.ST_CODE)) streetsByCode.set(p.ST_CODE, names)
    routes.set(p.ROUTE_ID, names)
    graphEdges.push({ fid: p.OBJECTID, routeId: p.ROUTE_ID, dir: p.TRAVEL_DIRECTION, sx: p.sx, sy: p.sy, ex: p.ex, ey: p.ey, len: p.SHAPE_Length })
  }
}

async function readTurns() {
  const sql = `SELECT EDGE1END, EDGE1FID, EDGE2FID, EDGE3FID, INC_VEH_TYPE, EXC_VEH_TYPE, PART_TIME_REST, EFF_ALL_DAYS, OTHER_REST_TYPE, REMARKS FROM ${RDNET_TURN_LAYER}`
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_TURN_LAYER, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', sql])) turnRows.push(p)
}

// Line geometry lands in its own map and is attached to `routes` only once
// every read is done: the names read creates the entries, and the two overlap.
// In concurrent chunks: OGR's `-where` parser exhausts its memory on an IN list
// of ~6k ids (2.2k parsed fine). An empty id list starts no read, so no `IN ()`.
const geometries = new Map()
const GEOMETRY_CHUNK = 2000
const readGeometries = ids => Promise.all(Array.from({ length: Math.ceil(ids.length / GEOMETRY_CHUNK) }, async (_, c) => {
  const read = streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [
    `/vsizip/${RDNET_ZIP}`, RDNET_CENTERLINE_LAYER,
    '-t_srs', TARGET_SRS,
    '-dim', 'XY',
    '-simplify', '0.01',
    '-select', 'ROUTE_ID',
    '-where', `ROUTE_ID IN (${ids.slice(c * GEOMETRY_CHUNK, (c + 1) * GEOMETRY_CHUNK).join(',')})`
  ])
  for await (const f of read) geometries.set(f.properties.ROUTE_ID, f.geometry)
}))

// The prohibition routes are known now, so their geometry reads beside the
// graph; only the cut-off edges must wait for computeCutoff below.
await Promise.all([readNamesAndGraph(), readTurns(), readGeometries([...new Set(prohRows.map(f => f.properties.ROAD_ROUTE_ID))])])

// Notice-backed overrides (zone-overrides.mjs), applied to the rows BOTH the
// prohibition lines and the cut-off search read, so a road TD's notice closes
// is drawn as a ban and seals what lies behind it. The class test lives in
// road-cutoff.mjs (`addressesCutoff`): coded INC_VEH_TYPE first, remarks head
// only for OTH/NA rows — see the note there on why a loose head costs whole
// districts. TURN rows go through the same test, but their 184 uncoded
// remarks carry no `<who> Proh` head, so they are not applied: a missed
// closure, never an invented one.
const overrides = applyZoneOverrides(prohRows.map(f => f.properties), new Map([...routes].map(([id, r]) => [id, r.st_en])), await loadOverrides())
const prohProps = overrides.rows
for (const w of overrides.warnings) console.warn(`  ⚠ override: ${w}`)

const cutoff = computeCutoff({
  edges: graphEdges,
  prohibitions: prohProps,
  turns: turnRows,
  closes: closesForCutoff
})

// Geometry for the cut-off edges and for any route an override closed (the
// prohibition read above only fetched TD's own rows' routes).
await readGeometries([...new Set([...cutoff.groups.flatMap(g => g.edges.map(e => e.routeId)), ...prohProps.map(p => p.ROAD_ROUTE_ID)])].filter(id => !geometries.has(id)))
for (const [id, geometry] of geometries) if (routes.has(id)) routes.get(id).geometry = geometry
console.log(`  ${RDNET_CENTERLINE_LAYER}: ${routes.size} routes named, ${geometries.size} geometries, ${streetsByCode.size} street codes named; ${RDNET_TURN_LAYER}: ${turnRows.length}`)

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
const outs = Object.fromEntries(TILE_LAYERS.map(k => [k, createWriteStream(scratch(k))]))
const counts = Object.fromEntries(TILE_LAYERS.map(k => [k, 0]))

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
    notice: p.notice,
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
    notice: p.notice,
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
    notice: p.notice,
    ...streetProps(p.ROAD_ROUTE_ID)
  }))
  counts.pedzone++
}

const kindTally = Object.fromEntries(PROHIBITION_KINDS.map(k => [k, 0]))
const otherHeads = new Map()
let noRoute = 0
for (const p of prohProps) {
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
    notice: p.notice,
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

// Cut-off roads, one feature per edge, each carrying its area's length and
// the streets of the closed routes that seal it (`via_*`, de-duplicated,
// unnamed routes dropped). Kept out of the z9–10 tiles like NSR — the always-on
// speed hit layer loads those for every visitor, and nothing draws this there
// (= RULE_MINZOOM.cutoff).
const CUTOFF_TILE_ZOOM = { minzoom: 11 }
const joinNames = (ids, key, limit) => [...new Set(ids.map(id => routes.get(id)?.[key]).filter(Boolean))].slice(0, limit).join(', ') || null
for (const g of cutoff.groups) {
  const shared = compact({
    veh: CUTOFF_VEHICLE,
    area_m: g.lenM,
    via_en: joinNames(g.entryRouteIds, 'st_en'),
    via_zh: joinNames(g.entryRouteIds, 'st_zh')
  })
  for (const e of g.edges) {
    const route = routes.get(e.routeId)
    if (!route?.geometry) continue
    await writeFeature(outs.cutoff, route.geometry, { ...shared, ...streetProps(e.routeId) }, CUTOFF_TILE_ZOOM)
    counts.cutoff++
  }
}

// Taxi operating areas — the second derived layer, and the only reading in
// this archive whose extent is not TD's own geometry (there is none to read;
// see taxi-zones.mjs and data/taxi-zones/README.md). One feature per route ×
// colour, as prohibitions emit per kind, so a legend row is a plain filter.
// z10 up: a zone is a thing you read zoomed out, unlike the kerbside layers.
const TAXI_TILE_ZOOM = { minzoom: 10 }
const taxiTally = new Map()
let taxiStraddling = 0
// ONE unfiltered CENTERLINE read at 1 m, not the chunked `-where ROUTE_ID IN`
// the prohibition and cut-off routes use: nearly half the network classifies
// here, so nine more full-layer scans would cost more than a single pass — and
// a wide translucent band has no use for the 1 cm geometry those layers need
// (5.4 MB of WKT for all 36k routes at 1 m against 54 MB at 1 cm). Classified
// and written as it streams, so no second copy of the network is ever held.
const taxiRead = streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [
  `/vsizip/${RDNET_ZIP}`, RDNET_CENTERLINE_LAYER,
  '-t_srs', TARGET_SRS,
  '-dim', 'XY',
  '-simplify', '1.0',
  '-select', 'ROUTE_ID,STREET_ENAME,ALIAS_ENAME'
])
for await (const f of taxiRead) {
  const at = representativePoint(f.geometry)
  if (!at) continue
  const names = [street(f.properties.STREET_ENAME), street(f.properties.ALIAS_ENAME)]
  const hits = classifyRoute(taxiAreas, at[0], at[1], names)
  if (!hits.length) continue
  if (straddles(taxiAreas, f.geometry, names)) taxiStraddling++
  for (const h of hits) {
    await writeFeature(outs.taxi, f.geometry, compact({
      taxi: h.taxi,
      access: h.access,
      route_n: h.n,
      // Bilingual like the street names — the popup picks by locale.
      dest_en: h.dest?.en,
      dest_zh: h.dest?.zh,
      ...streetProps(f.properties.ROUTE_ID)
    }), TAXI_TILE_ZOOM)
    counts.taxi++
    bump(taxiTally, `${h.taxi}/${h.access}`)
  }
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
// The derived layer's inputs and its largest areas — review after every TD
// refresh: a new multi-km area is either a real new closure or a ban whose
// wording closesFor no longer reads as conditional.
const { stats } = cutoff
const totalKm = cutoff.groups.reduce((s, g) => s + g.lenM, 0) / 1000
console.log(`  overrides: ${overrides.applied.close} route(s) closed, ${overrides.applied.open} row(s) reopened from ${'data/zone-notices/overrides.json'}${overrides.warnings.length ? ` — ${overrides.warnings.length} warning(s) above` : ''}`)
console.log(`  cutoff (${CUTOFF_VEHICLE}): ${stats.closedRoutes} closed routes, ${stats.bannedTurns} turn bans applied (${stats.turnsSkipped} skipped) → ${stats.cutEdges} edges, ${totalKm.toFixed(0)} km in ${cutoff.groups.length} areas`)
for (const g of cutoff.groups.slice(0, 8)) {
  console.log(`    ${(g.lenM / 1000).toFixed(1)} km  ${joinNames(g.edges.map(e => e.routeId), 'st_en', 3) ?? '(unnamed)'}  ← ${joinNames(g.entryRouteIds, 'st_en') ?? '(unnamed)'}`)
}
// The curated layer's own tallies — review after every TD refresh AND after
// every edit to areas.json. A clause that matched nothing is the failure mode
// that hides: a street renamed by TD, or a typo, silently draws no band.
console.log(`  taxi (${taxiAreas.asOf}, ${TAXI_AREAS_FILE}): ${tally(taxiTally)}`)
console.log(`  taxi: ${taxiStraddling} route(s) straddle a boundary (classified by their midpoint)`)
const deadClauses = taxiAreas.clauses.filter(c => !c.matched)
if (deadClauses.length) {
  console.warn(`  ⚠ taxi: ${deadClauses.length} clause(s) matched no road — check for a renamed street or a mis-drawn ring:`)
  for (const c of deadClauses) console.warn(`      ${c.taxi} ${c.access}${c.n != null ? ` #${c.n}` : ''}: ${c.streets ? [...c.streets].join(', ') : (c.districts ?? []).join(', ')}`)
}
// The resolved extent, for any other project that needs the gazetted shape.
// Compact, like signGroups.json: it is bulk generated data, and pretty-printing
// nested coordinate arrays quadrupled it (398 kB against 102 kB).
await writeFile(TAXI_AREAS_OUT, `${JSON.stringify(shareableAreas(taxiAreas))}\n`)
console.log(`  taxi: shareable extent → ${TAXI_AREAS_OUT}`)

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
  ...TILE_LAYERS.map(k => `-L${k}:${scratch(k)}`)
], { stdio: 'inherit' })
const [tipCode] = await once(tip, 'close')
if (tipCode !== 0) process.exit(tipCode)

for (const k of TILE_LAYERS) await rm(scratch(k), { force: true })

// Own cache-buster key: this archive rebuilds independently of the sign
// archives, so it must not invalidate their byte-range cache (and vice versa).
const rulesVersion = createHash('sha256').update(await readFile(OUTPUT_PMTILES_RULES)).digest('hex').slice(0, 12)
await mergeTilesVersion({ rulesVersion })

console.log(`\nDone → ${OUTPUT_PMTILES_RULES} (v${rulesVersion}, ${Date.now() - t0} ms)`)
