// Audit the curated taxi operating areas against the plates TD installed on
// the ground. Read-only; run after every TD refresh (data:fetch) and after
// every edit to data/taxi-zones/areas.json.
//
// WHY THIS EXISTS. The `taxi` layer is the one reading in the road-rules
// overlay whose extent is not TD's own geometry — no such geometry is
// published (see taxi-zones.mjs). So the extent is a curated file, and what
// checks it is the signage: 241 TS329 "END OF PERMITTED AREA FOR NT TAXIS",
// 8 TS569 for Lantau, and the per-colour stand plates. Those plates are an
// ORACLE and never an input: a terminator says only where something stops, and
// rule extents never come from sign points (CLAUDE.md). The answer to every
// finding here is a human edit to areas.json.
//
// Sections:
//   1. terminators        every TS329 / TS569 snapped to its nearest road,
//                         grouped by what the curated extent makes of that
//                         road. A terminator ON a boundary or at the end of a
//                         designated route is explained; one deep inside an
//                         area, or on a road no clause touches, is not.
//   2. unsigned crossings roads where the extent changes between one end and
//                         the other with no terminator within --radius. A
//                         tally, not an error: ramps and slip roads are
//                         genuinely unsigned.
//   3. stand plates       TS818 (NT), TS566 (Lantau) and TS567 (urban) must
//                         stand where their own colour may serve. The check
//                         the terminators cannot give, and the strongest
//                         contradiction available: a green stand outside the
//                         green area means the area is drawn wrong.
//   4. dead clauses       clauses in areas.json that matched no road at all —
//                         a street TD renamed, or a typo.
//   5. reachability       roads a colour may serve that it cannot DRIVE to (or
//                         back from) without leaving its own roads, over the
//                         directed network. A destination drawn as an island
//                         means a connecting route is missing from areas.json —
//                         the gap every other section only hints at, because a
//                         plate cannot say a road between two areas is absent.
//                         The network checks the file here; it never feeds it.
//
// Usage:
//   node scripts/audit-taxi-zones.mjs [--radius 40] [--show 12]

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { existsSync } from 'node:fs'

import { RAW_DIR, TARGET_SRS, RDNET_CENTERLINE_LAYER } from './sign-layers.mjs'
import { requireTool, streamOgrGeoJSON, readSignPoints, reprojectPoints } from './geo.mjs'
import { stateGraph, largestScc, componentsByNodes } from './road-cutoff.mjs'
import {
  TAXI_AREAS_FILE, DISTRICTS_FILE,
  loadTaxiAreas, classifyRoute, classifyPoint, representativePoint
} from './taxi-zones.mjs'

const { values: argv } = parseArgs({
  options: { radius: { type: 'string', default: '40' }, show: { type: 'string', default: '12' } }
})
const RADIUS_M = Number(argv.radius)
const SHOW = Number(argv.show)

const RDNET_ZIP = join(RAW_DIR, 'RdNet_IRNP.gdb.zip')
const GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')

// Why a terminator stands where it does. The two that mean "the curated
// extent does not explain this plate" are compared again below, so they are
// named rather than written twice.
const WHY_INSIDE_AREA = 'inside the permitted area'
const WHY_NO_CLAUSE = 'road no clause touches'
const WHY_NO_ROAD = 'no road in reach'
const WHY_DEST = 'at a fringe destination'
const WHY_ROUTE = 'end of a designated route'
const WHY_BOUNDARY = 'on a boundary road'
const UNEXPLAINED = [WHY_INSIDE_AREA, WHY_NO_CLAUSE, WHY_NO_ROAD]

// What each plate says, and which colour it speaks for.
const TERMINATORS = { TS329: 'nt', TS569: 'lantau' }
const STANDS = { TS818: 'nt', TS566: 'lantau', TS567: 'urban' }

// Degrees → metres at Hong Kong's latitude. The whole audit works in WGS84
// (that is what the classifier reads), and a local scale is exact enough for a
// 40 m test: the territory spans 0.5° of latitude, over which these factors
// move by well under a percent.
const M_PER_DEG_LAT = 110900
const M_PER_DEG_LNG = 102700

requireTool('ogr2ogr', 'brew install gdal')
const DISTRICTS = join(RAW_DIR, DISTRICTS_FILE)
for (const f of [RDNET_ZIP, DISTRICTS]) {
  if (existsSync(f)) continue
  console.error(`${f} not found — run \`corepack pnpm data:fetch\` first.`)
  process.exit(1)
}

const areas = await loadTaxiAreas(TAXI_AREAS_FILE, DISTRICTS)
console.log(`Taxi operating areas — ${TAXI_AREAS_FILE} as of ${areas.asOf}`)
console.log(`  ${areas.source}\n`)

// --- the network, classified, indexed ---------------------------------------
// Same read the builder does (1 m simplify, one pass), because the audit must
// classify a road exactly as the map draws it.
// ~400 m. Every segment is binned into EVERY cell its bounding box spans, so
// a segment passing within RADIUS_M of a point always has a piece in that
// point's own cell or one touching it — which is what makes nearestRoad's
// fixed 3x3 window complete for any radius up to CELL. compute-bearings.mjs
// has the metre-space twin of this index, but it bins by SAMPLING long
// segments and therefore needs an expanding-ring scan; do not copy that here
// without widening the window to match.
const CELL = 0.004
const grid = new Map()
const roads = []

for await (const f of streamOgrGeoJSON(RDNET_CENTERLINE_LAYER, [
  `/vsizip/${RDNET_ZIP}`, RDNET_CENTERLINE_LAYER,
  '-t_srs', TARGET_SRS, '-dim', 'XY', '-simplify', '1.0',
  '-select', 'ROUTE_ID,STREET_ENAME,ALIAS_ENAME,TRAVEL_DIRECTION'
])) {
  const at = representativePoint(f.geometry)
  if (!at) continue
  const names = [f.properties.STREET_ENAME, f.properties.ALIAS_ENAME].map(n => (n === '-99' ? null : n))
  const hits = classifyRoute(areas, at[0], at[1], names)
  const parts = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]
  // Both names are kept: a `streets` clause matches either, so probing a
  // road's ends with the primary name alone would make an alias-bound road
  // read as a boundary crossing here and as an unexplained plate above.
  let metres = 0
  for (const part of parts) {
    for (let i = 1; i < part.length; i++) {
      metres += Math.hypot((part[i][0] - part[i - 1][0]) * M_PER_DEG_LNG, (part[i][1] - part[i - 1][1]) * M_PER_DEG_LAT)
    }
  }
  const road = {
    st: names[0], names, hits, metres, at,
    ends: [parts[0][0], parts[parts.length - 1].at(-1)],
    twoWay: f.properties.TRAVEL_DIRECTION === 1
  }
  roads.push(road)
  for (const part of parts) {
    for (let i = 0; i < part.length - 1; i++) {
      const seg = [part[i], part[i + 1], road]
      const [x0, x1] = [Math.min(part[i][0], part[i + 1][0]), Math.max(part[i][0], part[i + 1][0])]
      const [y0, y1] = [Math.min(part[i][1], part[i + 1][1]), Math.max(part[i][1], part[i + 1][1])]
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
        for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
          const k = `${gx},${gy}`
          let a = grid.get(k)
          if (!a) grid.set(k, (a = []))
          a.push(seg)
        }
      }
    }
  }
}
console.log(`${roads.length} routes classified into ${grid.size} cells\n`)

function segMetres(lng, lat, [ax, ay], [bx, by]) {
  const dx = (bx - ax) * M_PER_DEG_LNG
  const dy = (by - ay) * M_PER_DEG_LAT
  const px = (lng - ax) * M_PER_DEG_LNG
  const py = (lat - ay) * M_PER_DEG_LAT
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, (px * dx + py * dy) / len)) : 0
  return Math.hypot(px - t * dx, py - t * dy)
}

function nearestRoad(lng, lat) {
  let best = Infinity
  let road = null
  const gx0 = Math.floor(lng / CELL)
  const gy0 = Math.floor(lat / CELL)
  for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
    for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
      for (const [a, b, r] of grid.get(`${gx},${gy}`) ?? []) {
        const d = segMetres(lng, lat, a, b)
        if (d < best) {
          best = d
          road = r
        }
      }
    }
  }
  return { road, metres: best }
}

// --- the plates -------------------------------------------------------------
const codes = new Set([...Object.keys(TERMINATORS), ...Object.keys(STANDS)])
let plates = []
if (existsSync(GML)) {
  const raw = await readSignPoints(GML, codes)
  const ll = await reprojectPoints(raw.map(p => [p[0], p[1]]))
  plates = raw.map((p, i) => ({ code: p[2], lng: ll[i][0], lat: ll[i][1] }))
} else {
  console.warn(`⚠ ${GML} not found — sections 1–3 skipped; run \`corepack pnpm data:fetch\`\n`)
}

const accessOf = (hits, taxi) => hits.find(h => h.taxi === taxi)?.access ?? null
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
const tally = m => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')

// --- 1. terminators ---------------------------------------------------------
// A terminator is EXPLAINED when the road it stands on is the edge of the
// thing it names: either the road carries a designated route (the route ends
// here) or the extent changes along that road. It is UNEXPLAINED when the road
// sits squarely inside the permitted area, or when no clause touches it at
// all — the first says the boundary is drawn too wide, the second that a
// designated route is missing from areas.json.
console.log(`1. Terminators (${Object.keys(TERMINATORS).join(', ')}) — nearest road within ${RADIUS_M} m`)
const unexplained = []
const termTally = new Map()
for (const p of plates) {
  const taxi = TERMINATORS[p.code]
  if (!taxi) continue
  const { road, metres } = nearestRoad(p.lng, p.lat)
  if (!road || metres > RADIUS_M) {
    bump(termTally, WHY_NO_ROAD)
    unexplained.push({ ...p, taxi, why: WHY_NO_ROAD, st: null, metres })
    continue
  }
  const access = accessOf(road.hits, taxi)
  const endsDiffer = classifyPoint(areas, ...road.ends[0], road.names).map(h => `${h.taxi}:${h.access}`).join()
    !== classifyPoint(areas, ...road.ends[1], road.names).map(h => `${h.taxi}:${h.access}`).join()
  let why = WHY_NO_CLAUSE
  if (access === 'dest') why = WHY_DEST
  else if (access === 'route') why = WHY_ROUTE
  else if (endsDiffer) why = WHY_BOUNDARY
  else if (access === 'area') why = WHY_INSIDE_AREA
  bump(termTally, why)
  if (UNEXPLAINED.includes(why)) unexplained.push({ ...p, taxi, why, st: road.st, metres })
}
console.log(`   ${tally(termTally) || 'no terminators read'}`)
if (unexplained.length) {
  const byStreet = new Map()
  for (const u of unexplained) bump(byStreet, `${u.code} ${u.st ?? '(unnamed)'} — ${u.why}`)
  console.log(`   ${unexplained.length} unexplained:`)
  for (const [k, n] of [...byStreet].sort((a, b) => b[1] - a[1]).slice(0, SHOW)) console.log(`      ${String(n).padStart(3)}  ${k}`)
  if (byStreet.size > SHOW) console.log(`      … and ${byStreet.size - SHOW} more street(s)`)
}

// --- 2. unsigned crossings --------------------------------------------------
console.log(`\n2. Boundary roads with no terminator within ${RADIUS_M} m`)
const termPoints = plates.filter(p => TERMINATORS[p.code])
let crossings = 0
let unsigned = 0
const unsignedStreets = new Map()
for (const r of roads) {
  const a = classifyPoint(areas, ...r.ends[0], r.names).map(h => `${h.taxi}:${h.access}`).sort().join()
  const b = classifyPoint(areas, ...r.ends[1], r.names).map(h => `${h.taxi}:${h.access}`).sort().join()
  if (a === b) continue
  crossings++
  const near = termPoints.some(p =>
    Math.abs(p.lat - r.ends[0][1]) * M_PER_DEG_LAT < RADIUS_M * 3
    && segMetres(p.lng, p.lat, r.ends[0], r.ends[1]) < RADIUS_M)
  if (!near) {
    unsigned++
    bump(unsignedStreets, r.st ?? '(unnamed)')
  }
}
console.log(`   ${crossings} boundary road(s), ${unsigned} with no terminator in reach`)
if (unsigned) console.log(`      ${tally(unsignedStreets).split(' · ').slice(0, SHOW).join(' · ')}`)

// --- 3. stand plates --------------------------------------------------------
console.log(`\n3. Stand plates standing where their own colour may not serve`)
for (const [code, taxi] of Object.entries(STANDS)) {
  const mine = plates.filter(p => p.code === code)
  if (!mine.length) continue
  const bad = []
  for (const p of mine) {
    const { road, metres } = nearestRoad(p.lng, p.lat)
    if (!road || metres > RADIUS_M) continue
    const access = accessOf(road.hits, taxi)
    // urban is emitted only where red may NOT go, so for it a hit is the
    // contradiction; for nt / lantau the ABSENCE of one is.
    const wrong = taxi === 'urban' ? access === 'none' : access == null
    if (wrong) bad.push(road.st ?? '(unnamed)')
  }
  const byStreet = new Map()
  for (const s of bad) bump(byStreet, s)
  const verdict = bad.length ? `${bad.length} of ${mine.length} — ${tally(byStreet).split(' · ').slice(0, SHOW).join(' · ')}` : `none of ${mine.length}`
  console.log(`   ${code} (${taxi}): ${verdict}`)
}

// --- 4. dead clauses --------------------------------------------------------
console.log(`\n4. Clauses in ${TAXI_AREAS_FILE} that matched no road`)
const dead = areas.clauses.filter(c => !c.matched)
if (!dead.length) console.log(`   none — all ${areas.clauses.length} clauses bind`)
for (const c of dead) {
  console.log(`   ${c.taxi} ${c.access}${c.n != null ? ` #${c.n}` : ''}: ${c.streets ? [...c.streets].join(', ') : (c.districts ?? []).join(', ')}`)
}

// --- 5. reachability --------------------------------------------------------
// The same edge × direction states the cut-off search walks (road-cutoff.mjs),
// keyed here by WGS84 endpoints rounded to ~1 m: the 1 m simplify keeps every
// endpoint, and the two edges meeting at a junction reproject the same source
// coordinate, so they still coincide. A colour's own roads are every road it
// may serve (area, dest or route); its CORE is their largest strongly
// connected piece, and a road is reachable when some state of it can be
// driven to from the core AND back. Turn bans are not applied — an unapplied
// ban can only hide a gap here, never invent one. `urban` has no roads of its
// own in this file (it is drawn only where red may NOT go), so it has nothing
// to walk.
console.log(`\n5. Roads a colour may serve but cannot drive to and back from on its own roads`)
const nodeKey = ([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`
const graph = stateGraph(roads.map(r => nodeKey(r.ends[0])), roads.map(r => nodeKey(r.ends[1])), roads.map(r => r.twoWay))
const arriving = new Map()
for (let s = 0; s < 2 * roads.length; s++) {
  if (!graph.exists(s)) continue
  const node = graph.head(s)
  arriving.has(node) ? arriving.get(node).push(s) : arriving.set(node, [s])
}
function walk(seeds, next) {
  const seen = new Uint8Array(2 * roads.length)
  const queue = [...seeds]
  for (const s of seeds) seen[s] = 1
  while (queue.length) {
    for (const t of next(queue.pop())) {
      if (!seen[t]) {
        seen[t] = 1
        queue.push(t)
      }
    }
  }
  return seen
}
const labelOf = (road, hit) => hit.access === 'dest'
  ? `dest ${hit.dest?.en}`
  : `${hit.access}${hit.n != null ? ` #${hit.n}` : ''} ${road.st ?? '(unnamed)'}`
for (const taxi of Object.values(TERMINATORS)) {
  const own = roads.map(r => r.hits.find(h => h.taxi === taxi && h.access !== 'none'))
  const usable = s => graph.exists(s) && own[graph.edgeOf(s)]
  const forward = s => (graph.leaving.get(graph.head(s)) ?? []).filter(usable)
  const backward = s => (arriving.get(graph.tail(s)) ?? []).filter(usable)
  const core = largestScc(2 * roads.length, s => (usable(s) ? forward(s) : []))
  const into = walk(core, forward)
  const outOf = walk(core, backward)
  const statesOf = i => (graph.exists(2 * i + 1) ? [2 * i, 2 * i + 1] : [2 * i])
  // A stranded road is one no state of which is both reachable from the core
  // and able to return to it.
  const stranded = new Set()
  let total = 0
  own.forEach((hit, i) => {
    if (!hit) return
    total++
    if (!statesOf(i).some(s => into[s] && outOf[s])) stranded.add(i)
  })
  // Stranded roads joined through shared nodes into ISLANDS, ranked by length:
  // a missing corridor strands kilometres at once, while a footprint ring that
  // clips a car park's aisles strands a few metres, and the two must not read
  // alike. Each island is named by the reading it carries most of.
  const islands = componentsByNodes([...stranded], i => [graph.tail(2 * i), graph.head(2 * i)]).map((members) => {
    const label = new Map()
    let metres = 0
    let longest = members[0]
    for (const i of members) {
      metres += roads[i].metres
      if (roads[i].metres > roads[longest].metres) longest = i
      const k = labelOf(roads[i], own[i])
      label.set(k, (label.get(k) ?? 0) + roads[i].metres)
    }
    return { metres, label: [...label].sort((a, b) => b[1] - a[1])[0][0], at: roads[longest].at }
  })
  islands.sort((a, b) => b.metres - a.metres)
  const km = m => (m / 1000).toFixed(1)
  console.log(`   ${taxi}: ${total} routes, ${stranded.size} stranded in ${islands.length} island(s), ${km(islands.reduce((a, b) => a + b.metres, 0))} km`)
  for (const { metres, label, at } of islands.slice(0, SHOW)) {
    console.log(`      ${km(metres).padStart(6)} km  ${label}  @ ${at[0].toFixed(4)},${at[1].toFixed(4)}`)
  }
  if (islands.length > SHOW) console.log(`           … and ${islands.length - SHOW} more`)
}
