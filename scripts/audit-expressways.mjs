// Audit the curated expressway designation against the plates TD installed on
// the ground and TD's own prohibition rows. Read-only; run after every TD
// refresh (data:fetch) and after every edit to data/expressways/designation.json.
//
// WHY THIS EXISTS. No field in TD's network marks an expressway, so the
// `expressway` layer — and the public-light-bus closures it feeds into the
// cut-off search — is a curated file (see expressways.mjs). What checks it is
// the signage: TS353 "start and continuation of an expressway" and TS354 "end
// of an expressway" (Cap. 374Q Sch. 1 figs 901/902), which by law mark where
// the expressway's rules begin and end. They are an ORACLE, never an input:
// the answer to every finding here is a human edit to designation.json.
//
// Sections:
//   1. items            km per G.N. 8028 item, and any clause that took nothing
//   2. plates           every TS353 / TS354 by where it stands: at a node where
//                       a designated route meets an undesignated one (a
//                       boundary — explained), on an unnamed ramp (the ramps
//                       are withheld, so a plate there is expected), inside
//                       the designation, or beside a named road the file does
//                       not designate (unexplained — list them)
//   3. unsigned ends    nodes where a designated route meets a NAMED
//                       undesignated road with no plate within --radius: the
//                       ends of the rings. Every stretch ends somewhere, and a
//                       ring edge with no plate near it is worth a look.
//   4. PLB rows         TD's own public-light-bus rows on designated routes: a
//                       part-time row on a route the file closes all day is a
//                       reg 24 authorisation the file does not record yet; an
//                       all-day row on a route the file opens part-time is
//                       expected only where TD says so (Kwun Tong Bypass's
//                       Kowloon Bay end).
//
// Usage:
//   node scripts/audit-expressways.mjs [--radius 40] [--show 12]

import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { RAW_DIR, RDNET_CENTERLINE_LAYER, RDNET_RULE_LAYERS, CUTOFF_VEHICLE } from './sign-layers.mjs'
import { requireTool, streamOgrGeoJSON, readSignPoints, reprojectPoints, pointIndex } from './geo.mjs'
import { addressesCutoff, closesForCutoff, nodeKey } from './road-cutoff.mjs'
import { EXPRESSWAY_FILE, CLASSIFY_SQL_COLUMNS, loadDesignation, classifyExpressways } from './expressways.mjs'

const { values: argv } = parseArgs({
  options: { radius: { type: 'string', default: '40' }, show: { type: 'string', default: '12' } }
})
const RADIUS_M = Number(argv.radius)
const SHOW = Number(argv.show)
const CODES = ['TS353', 'TS354']

const RDNET_ZIP = join(RAW_DIR, 'RdNet_IRNP.gdb.zip')
const GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')

requireTool('ogr2ogr', 'brew install gdal')
const designation = await loadDesignation()

const edges = []
const proh = []
let plates = []
async function readCenterline() {
  const first = 'ST_GeometryN(SHAPE, 1)'
  const last = 'ST_GeometryN(SHAPE, ST_NumGeometries(SHAPE))'
  const sql = `SELECT ROUTE_ID, STREET_ENAME, SHAPE_Length, ${CLASSIFY_SQL_COLUMNS},
    ST_X(ST_StartPoint(${first})) AS sx, ST_Y(ST_StartPoint(${first})) AS sy,
    ST_X(ST_EndPoint(${last})) AS ex, ST_Y(ST_EndPoint(${last})) AS ey
    FROM ${RDNET_CENTERLINE_LAYER}`
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', sql])) {
    const st = p.STREET_ENAME && p.STREET_ENAME !== '-99' ? p.STREET_ENAME : null
    edges.push({ routeId: p.ROUTE_ID, st_en: st, len: p.SHAPE_Length, elevation: p.ELEVATION, mx: p.mx, my: p.my, sx: p.sx, sy: p.sy, ex: p.ex, ey: p.ey })
  }
}
async function readProhibitions() {
  const sql = `SELECT PROHIBITION_ID, ROAD_ROUTE_ID, INC_VEH_TYPE, EXC_VEH_TYPE, PART_TIME_PROHIBITION, EFF_ALL_DAYS, OTHER_REST_TYPE_GV, REMARKS FROM ${RDNET_RULE_LAYERS.prohibition}`
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_RULE_LAYERS.prohibition, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', sql])) proh.push(p)
}
async function readPlates() {
  try {
    plates = await readSignPoints(GML, CODES)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    console.warn(`⚠ ${GML} not found — sections 2 and 3 skipped; run data:fetch`)
  }
}
await Promise.all([readCenterline(), readProhibitions(), readPlates()])
const expressways = classifyExpressways(designation, edges)
console.log(`${edges.length} routes, ${expressways.size} designated (${designation.designation}, ${EXPRESSWAY_FILE}), ${plates.length} ${CODES.join('/')} plates, ${proh.length} PROHIBITION rows`)

// --- 1. items ------------------------------------------------------------------
console.log('\n## 1. Items')
const byItem = new Map()
for (const c of designation.clauses) {
  const t = byItem.get(c.item) ?? { routes: 0, lenM: 0 }
  byItem.set(c.item, { routes: t.routes + c.matched, lenM: t.lenM + c.lenM })
}
for (const [item, t] of byItem) console.log(`  (${item})  ${String(t.routes).padStart(4)} routes  ${(t.lenM / 1000).toFixed(1).padStart(5)} km`)
const dead = designation.clauses.filter(c => !c.matched)
console.log(dead.length ? `  ⚠ ${dead.length} clause(s) matched no road: ${dead.map(c => `(${c.item}) ${[...c.streets].join(', ')}`).join('; ')}` : '  every clause matched')

// --- nodes -------------------------------------------------------------------
// A node is an endpoint rounded to the metre, as in road-cutoff.mjs. Each
// carries the routes that touch it, so a node is a BOUNDARY when a designated
// route and an undesignated one meet there.
const nodes = new Map()
for (const e of edges) {
  for (const [x, y] of [[e.sx, e.sy], [e.ex, e.ey]]) {
    const k = nodeKey(x, y)
    const n = nodes.get(k) ?? { x, y, routes: [] }
    n.routes.push(e)
    nodes.set(k, n)
  }
}
const designated = e => expressways.has(e.routeId)
const boundaries = [...nodes.values()].filter(n => n.routes.some(designated) && n.routes.some(e => !designated(e)))

const nearest = (items) => {
  const near = pointIndex(items, v => v.x, v => v.y)
  return (px, py, r) => near(px, py, r)[0]?.[1] ?? null
}
const nearBoundary = nearest(boundaries)
const nearNode = nearest([...nodes.values()])
const groupBy = (items, keyOf) => {
  const m = new Map()
  for (const v of items) {
    const k = keyOf(v)
    m.has(k) ? m.get(k).push(v) : m.set(k, [v])
  }
  return [...m].sort((a, b) => b[1].length - a[1].length)
}

// Every WGS84 position sections 2 and 3 print goes through ONE gdaltransform
// pass: their lines are collected with a placeholder for the position, then
// printed together once it is back.
const lines = []
const toPlace = []
const place = (p) => {
  toPlace.push(p)
  return toPlace.length - 1
}

// --- 2. plates -----------------------------------------------------------------
if (plates.length) {
  lines.push(`\n## 2. ${CODES.join(' / ')} plates (boundary = within ${RADIUS_M} m of a node where a designated route meets an undesignated one)`)
  const groups = { boundary: [], ramp: [], inside: [], off: [], far: [] }
  for (const [x, y, code] of plates) {
    if (nearBoundary(x, y, RADIUS_M)) {
      groups.boundary.push({ x, y, code })
      continue
    }
    const n = nearNode(x, y, 200)
    if (!n) groups.far.push({ x, y, code })
    else if (n.routes.every(designated)) groups.inside.push({ x, y, code })
    else if (n.routes.every(e => !e.st_en)) groups.ramp.push({ x, y, code })
    else groups.off.push({ x, y, code, st: n.routes.find(e => e.st_en)?.st_en })
  }
  lines.push(`  ${groups.boundary.length} at a boundary · ${groups.ramp.length} on an unnamed ramp (ramps are withheld) · ${groups.inside.length} inside the designation · ${groups.off.length} beside an undesignated named road · ${groups.far.length} with no node within 200 m`)
  if (groups.inside.length) {
    lines.push('  inside the designation (a ring may run past the real end):')
    for (const p of groups.inside.slice(0, SHOW)) lines.push([`     ${p.code}  `, place(p), ''])
  }
  if (groups.off.length) {
    lines.push('  beside an undesignated named road, by street (a designation the file lacks, or a ramp end past a junction):')
    for (const [st, ps] of groupBy(groups.off, p => p.st).slice(0, SHOW)) {
      lines.push([`    ${String(ps.length).padStart(3)}  ${st}  (e.g. ${ps[0].code} at `, place(ps[0]), ')'])
    }
  }

  // --- 3. unsigned ends ------------------------------------------------------------
  const nearPlate = nearest(plates.map(([x, y]) => ({ x, y })))
  const ends = boundaries.filter(n => n.routes.some(e => !designated(e) && e.st_en))
  const unsigned = ends.filter(n => !nearPlate(n.x, n.y, RADIUS_M))
  lines.push(`\n## 3. Designated routes meeting a named undesignated road: ${ends.length} nodes, ${unsigned.length} with no plate within ${RADIUS_M} m`)
  const pairOf = n => `${n.routes.find(designated).st_en} → ${n.routes.find(e => !designated(e) && e.st_en).st_en}`
  for (const [k, ns] of groupBy(unsigned, pairOf).slice(0, SHOW)) {
    lines.push([`    ${String(ns.length).padStart(3)}  ${k}  (e.g. `, place(ns[0]), ')'])
  }
}
const placed = toPlace.length ? await reprojectPoints(toPlace.map(p => [p.x, p.y])) : []
for (const l of lines) console.log(typeof l === 'string' ? l : `${l[0]}${placed[l[1]].map(v => v.toFixed(5)).join(', ')}${l[2]}`)

// --- 4. PLB rows -------------------------------------------------------------------
console.log(`\n## 4. TD's own ${CUTOFF_VEHICLE} rows on designated routes`)
const plbRows = proh.filter(p => addressesCutoff(p) && expressways.has(p.ROAD_ROUTE_ID))
const street = new Map(edges.map(e => [e.routeId, e.st_en]))
const openedWithoutRecord = plbRows.filter(p => !closesForCutoff(p) && !expressways.get(p.ROAD_ROUTE_ID).plb)
const closedOnOpen = plbRows.filter(p => closesForCutoff(p) && expressways.get(p.ROAD_ROUTE_ID).plb)
console.log(`  ${plbRows.length} rows; ${plbRows.filter(closesForCutoff).length} close all day (redundant with reg 4 on a closed route)`)
console.log(`  ${openedWithoutRecord.length} part-time or conditional on a route the file closes all day — a reg 24 authorisation to record as \`plb\`?`)
for (const p of openedWithoutRecord.slice(0, SHOW)) console.log(`     ${p.PROHIBITION_ID}  ${street.get(p.ROAD_ROUTE_ID)}  "${p.REMARKS}"`)
console.log(`  ${closedOnOpen.length} all-day on a route the file opens part-time (TD closes that route regardless):`)
for (const p of closedOnOpen.slice(0, SHOW)) console.log(`     ${p.PROHIBITION_ID}  ${street.get(p.ROAD_ROUTE_ID)}  "${p.REMARKS}"`)
