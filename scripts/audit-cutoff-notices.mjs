// Audit the public-light-bus cut-off inputs against TD's own prohibited-zone
// notices, the standing TS119/TS522 plates, and a list of roads whose status
// every driver knows. Read-only; run after every TD refresh (data:fetch).
//
// WHY THIS EXISTS. The cut-off search (road-cutoff.mjs) is sound; its input,
// the IRNP PROHIBITION layer, is what drifts. Measured 2026-09-22: rows appear
// 1–35 months after the Commissioner's reg 14(1)(a) notice (Wing Tak Street 2,
// Pok Yin Road 27, the Olympic Avenue flyover 32, Pak Sau Road 35), Ng Lau
// Road (notice Aug 2022, two TS119 standing) had no row at all, and Kai Lim
// Road (rescinded Nov 2025) was still sealed by a 2011 row. The notices reach
// back only to 2021-06, so they VERIFY the rows; they cannot replace them.
// What disagrees goes, by a human, into data/zone-notices/overrides.json.
//
// Sections:
//   1. designated, no row   standing PLB designations whose named streets carry
//                           no PLB-addressing row (TS119/TS522 count beside it)
//   2. rescinded, still a row   rescissions whose streets still carry a
//                           CLOSING row — a false cut-off in the making
//   3. rows vs plates       PLB-coded rows with no TS119/TS522 within --radius
//                           (stale-row candidates) and plates with no row
//   4. overrides            entries TD has since caught up with, or that no
//                           longer bind (from applyZoneOverrides)
//   5. known zones          data/zone-notices/known-zones.json rows whose
//                           status the current data changes
//
// A street is bound to a notice by NAME (a CENTERLINE STREET_ENAME found in
// the notice's English text) — coarse on purpose; a notice names sections and
// slip roads the network has no field for, and this audit only has to say
// "go and look". Never derive an extent from a sign point.
//
// Usage:
//   node scripts/audit-cutoff-notices.mjs [--radius 30] [--code TS119,TS522]

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { RAW_DIR, RDNET_CENTERLINE_LAYER, RDNET_TURN_LAYER, RDNET_RULE_LAYERS, CUTOFF_VEHICLE } from './sign-layers.mjs'
import { requireTool, streamOgrGeoJSON, readSignPoints } from './geo.mjs'
import { addressesCutoff, closesForCutoff, computeCutoff } from './road-cutoff.mjs'
import { applyZoneOverrides, loadOverrides, NOTICES_FILE } from './zone-overrides.mjs'

const { values: opts } = parseArgs({
  options: {
    radius: { type: 'string', default: '30' },
    code: { type: 'string', default: 'TS119,TS522' }
  }
})
const RADIUS = Number(opts.radius)
const CODES = opts.code.split(',').map(s => s.trim()).filter(Boolean)
const RDNET_ZIP = join(RAW_DIR, 'RdNet_IRNP.gdb.zip')
const GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')
const KNOWN_FILE = 'data/zone-notices/known-zones.json'

requireTool('ogr2ogr', 'brew install gdal')

// --- inputs -----------------------------------------------------------------
const notices = JSON.parse(await readFile(NOTICES_FILE, 'utf8')).notices
const overrides = await loadOverrides()
const known = JSON.parse(await readFile(KNOWN_FILE, 'utf8')).zones

const routes = new Map() // ROUTE_ID → street
const edges = []
const ends = [] // [x, y, street] for nearest-street lookups
const turns = []
const proh = [] // with its point (the sign position), in HK1980 metres
let allSigns = []

async function readCenterline() {
  const first = 'ST_GeometryN(SHAPE, 1)'
  const last = 'ST_GeometryN(SHAPE, ST_NumGeometries(SHAPE))'
  const sql = `SELECT OBJECTID, ROUTE_ID, STREET_ENAME, TRAVEL_DIRECTION, SHAPE_Length,
    ST_X(ST_StartPoint(${first})) AS sx, ST_Y(ST_StartPoint(${first})) AS sy,
    ST_X(ST_EndPoint(${last})) AS ex, ST_Y(ST_EndPoint(${last})) AS ey
    FROM ${RDNET_CENTERLINE_LAYER}`
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', sql])) {
    const st = p.STREET_ENAME && p.STREET_ENAME !== '-99' ? p.STREET_ENAME : null
    routes.set(p.ROUTE_ID, st)
    edges.push({ fid: p.OBJECTID, routeId: p.ROUTE_ID, dir: p.TRAVEL_DIRECTION, sx: p.sx, sy: p.sy, ex: p.ex, ey: p.ey, len: p.SHAPE_Length })
    if (st) ends.push([p.sx, p.sy, st], [p.ex, p.ey, st])
  }
}
async function readTurns() {
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_TURN_LAYER, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', `SELECT EDGE1END, EDGE1FID, EDGE2FID, EDGE3FID, INC_VEH_TYPE, EXC_VEH_TYPE, PART_TIME_REST, EFF_ALL_DAYS, OTHER_REST_TYPE, REMARKS FROM ${RDNET_TURN_LAYER}`])) turns.push(p)
}
async function readProhibitions() {
  for await (const { properties: p } of streamOgrGeoJSON(RDNET_RULE_LAYERS.prohibition, [`/vsizip/${RDNET_ZIP}`, '-dialect', 'SQLite', '-sql', `SELECT PROHIBITION_ID, ROAD_ROUTE_ID, INC_VEH_TYPE, EXC_VEH_TYPE, PART_TIME_PROHIBITION, EFF_ALL_DAYS, OTHER_REST_TYPE_GV, REMARKS, BOUND, CRE_DATE, ST_X(SHAPE) AS x, ST_Y(SHAPE) AS y FROM ${RDNET_RULE_LAYERS.prohibition}`])) proh.push(p)
}
// Every sign, not only the plates: a PLB-coded row with NO sign of any kind
// beside it is a stale-row candidate, while one beside a no-entry roundel and
// an "except …" plate (TS116 + TS815/TS852 — 79 rows in 2026-09) is merely
// announced by another face and is not reported row by row.
async function readSigns() {
  try {
    allSigns = await readSignPoints(GML, null)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    console.warn(`⚠ ${GML} not found — section 3 (rows vs plates) skipped; run data:fetch`)
  }
}
// Four independent reads (three ogr2ogr subprocesses + a 206 MB GML stream):
// concurrently they cost the longest one, not the sum.
await Promise.all([readCenterline(), readTurns(), readProhibitions(), readSigns()])
const signs = allSigns.filter(s => CODES.includes(s[2]))
console.log(`${routes.size} routes, ${proh.length} PROHIBITION rows, ${turns.length} TURN rows, ${signs.length} ${CODES.join('/')} plates (${allSigns.length} signs), ${notices.length} notices`)

// --- helpers ----------------------------------------------------------------
const CELL = 50
const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
const index = (items, x = v => v[0], y = v => v[1]) => {
  const g = new Map()
  for (const v of items) {
    const k = key(x(v), y(v))
    g.has(k) ? g.get(k).push(v) : g.set(k, [v])
  }
  return (px, py, r, filter = () => true) => {
    const out = []
    const c = Math.ceil(r / CELL)
    const cx = Math.floor(px / CELL)
    const cy = Math.floor(py / CELL)
    for (let i = -c; i <= c; i++) {
      for (let j = -c; j <= c; j++) {
        for (const v of g.get(`${cx + i},${cy + j}`) ?? []) {
          if (!filter(v)) continue
          const d = Math.hypot(x(v) - px, y(v) - py)
          if (d <= r) out.push([d, v])
        }
      }
    }
    return out.sort((a, b) => a[0] - b[0])
  }
}
const nearEnds = index(ends)
const nearSigns = index(signs)
const nearAny = index(allSigns)
const plbRows = proh.filter(addressesCutoff)
const plbCoded = proh.filter(p => (p.INC_VEH_TYPE ?? '').split(',').map(s => s.trim()).includes(CUTOFF_VEHICLE))
const nearPlbRows = index(plbRows, v => v.x, v => v.y)
const rowsByStreet = new Map()
for (const p of plbRows) {
  const st = routes.get(p.ROAD_ROUTE_ID)
  if (!st) continue
  rowsByStreet.has(st) ? rowsByStreet.get(st).push(p) : rowsByStreet.set(st, [p])
}
const streetNames = [...new Set([...routes.values()].filter(n => n && n.length > 6))]
const streetsIn = (text) => {
  const t = text.toUpperCase()
  return streetNames.filter(n => t.includes(n))
}
const isTemporary = n => /temporar|extension of/i.test(n.title.en) || /\bto\s+\d{1,2}[.:]\d\d\s*[ap]\.?m\.?\s+on\s+\d/i.test(n.content.en)
// A notice is about a PLB driving ban when its TITLE says so; a 14(1)(b)
// "Restricted Zone" (a stopping ban) or a 3-tonne zone merely mentions PLBs.
const isPlbZone = n => /public light bus|PLB/i.test(n.title.en) && !/restricted zone/i.test(n.title.en)
const isPartTime = n => /from\s+\d{1,2}[.:]\d\d\s*[ap]\.?m\.?\s+to\s+\d{1,2}[.:]\d\d\s*[ap]\.?m/i.test(n.content.en)
const platesOn = st => signs.filter(s => nearEnds(s[0], s[1], 40).some(([, e]) => e[2] === st)).length
const overriddenStreets = new Set([...overrides.close.map(c => c.st), ...overrides.open.map(o => o.st)])
const date = v => (v ?? '').slice(0, 10)

// --- 1. designated, no row --------------------------------------------------
console.log(`\n## 1. Standing ${CUTOFF_VEHICLE} designations whose streets carry no ${CUTOFF_VEHICLE} row`)
let n1 = 0
for (const n of notices) {
  if (!n.kinds.includes('plb') || n.rescission || isTemporary(n) || !isPlbZone(n)) continue
  const streets = streetsIn(n.content.en)
  const missing = streets.filter(st => !(rowsByStreet.get(st) ?? []).length)
  if (!streets.length || !missing.length) continue
  n1++
  console.log(`  #${n.tnid} ${n.startEffectiveDate}  ${n.title.en}`)
  for (const st of missing) console.log(`     ${st}: no row · ${platesOn(st)} plate(s) on it${overriddenStreets.has(st) ? ' · in overrides.json' : ''}`)
}
if (!n1) console.log('  none')

// --- 2. rescinded, still a row ---------------------------------------------
console.log(`\n## 2. Rescissions whose streets still carry a CLOSING ${CUTOFF_VEHICLE} row`)
let n2 = 0
for (const n of notices) {
  if (!n.kinds.includes('plb') || !n.rescission || isTemporary(n) || !isPlbZone(n)) continue
  const partTime = isPartTime(n) ? ' (part-time rescission — rows may rightly stay)' : ''
  for (const st of streetsIn(n.content.en)) {
    const closing = (rowsByStreet.get(st) ?? []).filter(closesForCutoff)
    if (!closing.length) continue
    n2++
    console.log(`  #${n.tnid} ${n.startEffectiveDate}  ${n.title.en}${partTime}\n     ${st}: ${closing.map(p => `row ${p.PROHIBITION_ID} "${p.REMARKS}" cre ${date(p.CRE_DATE)}`).join('; ')}${overriddenStreets.has(st) ? ' · in overrides.json' : ''}`)
  }
}
if (!n2) console.log('  none')

// --- 3. rows vs plates ------------------------------------------------------
if (signs.length) {
  console.log(`\n## 3. ${CUTOFF_VEHICLE}-coded rows vs ${CODES.join('/')} plates within ${RADIUS} m`)
  const unsigned = plbCoded.filter(p => !nearSigns(p.x, p.y, RADIUS).length)
  const bare = unsigned.filter(p => !nearAny(p.x, p.y, RADIUS).length)
  console.log(`  ${plbCoded.length} ${CUTOFF_VEHICLE}-coded rows: ${plbCoded.length - unsigned.length} have a plate within ${RADIUS} m; ${unsigned.length - bare.length} are announced by other signs only; ${bare.length} have NO sign at all (stale-row candidates):`)
  for (const p of bare) console.log(`     row ${p.PROHIBITION_ID} ${routes.get(p.ROAD_ROUTE_ID) ?? '?'} "${p.REMARKS}" cre ${date(p.CRE_DATE)}`)
  const orphans = signs.filter(s => !nearPlbRows(s[0], s[1], RADIUS).length)
  const byStreet = new Map()
  for (const s of orphans) {
    const st = nearEnds(s[0], s[1], 60)[0]?.[1]?.[2] ?? '(off network)'
    byStreet.set(st, (byStreet.get(st) ?? 0) + 1)
  }
  console.log(`  ${signs.length} plates: ${orphans.length} have no ${CUTOFF_VEHICLE} row within ${RADIUS} m (${(100 * orphans.length / signs.length).toFixed(1)} %), by nearest street:`)
  for (const [st, c] of [...byStreet].sort((a, b) => b[1] - a[1])) console.log(`     ${String(c).padStart(3)}  ${st}${overriddenStreets.has(st) ? ' · in overrides.json' : ''}`)
}

// --- 4. overrides -----------------------------------------------------------
console.log('\n## 4. Overrides (data/zone-notices/overrides.json)')
const applied = applyZoneOverrides(proh, routes, overrides)
console.log(`  ${overrides.close.length} close, ${overrides.open.length} open → ${applied.applied.close} route(s) closed, ${applied.applied.open} row(s) reopened`)
for (const w of applied.warnings) console.log(`  ⚠ ${w}`)
if (!applied.warnings.length) console.log('  all entries still bind')

// --- 5. known zones ---------------------------------------------------------
console.log('\n## 5. Known zones (data/zone-notices/known-zones.json) — status under the CURRENT data + overrides')
const cutoff = computeCutoff({ edges, prohibitions: applied.rows, turns, closes: closesForCutoff })
const cutStreets = new Set()
for (const g of cutoff.groups) for (const e of g.edges) cutStreets.add(routes.get(e.routeId))
const rowsNow = new Map()
for (const p of applied.rows.filter(addressesCutoff)) {
  const st = routes.get(p.ROAD_ROUTE_ID)
  if (st) rowsNow.has(st) ? rowsNow.get(st).push(p) : rowsNow.set(st, [p])
}
const statusOf = (st) => {
  const rows = rowsNow.get(st) ?? []
  if (rows.some(closesForCutoff)) return 'banned'
  if (rows.length) return 'timed'
  return cutStreets.has(st) ? 'cutoff' : 'open'
}
let changed = 0
for (const z of known) {
  const now = statusOf(z.st)
  if (now === z.status) continue
  changed++
  console.log(`  ${z.st}: was ${z.status}, now ${now}${z.note ? ` — ${z.note}` : ''}`)
}
console.log(changed ? `  ${changed} of ${known.length} changed — read the rows before touching known-zones.json` : `  all ${known.length} as recorded`)
const km = cutoff.groups.reduce((s, g) => s + g.lenM, 0) / 1000
console.log(`\ncut-off with overrides: ${cutoff.stats.closedRoutes} closed routes → ${km.toFixed(0)} km in ${cutoff.groups.length} areas`)
