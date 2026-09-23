// Which colour of taxi may serve a road — the `taxi` source-layer of the
// road-rules archive, and the one reading in it whose extent is NOT TD's own
// geometry.
//
// There is none to read. The Road Network FGDB has no taxi layer;
// PROHIBITION's `INC_VEH_TYPE` has a `TX` code with no colour dimension, and
// the colours survive only as free text in REMARKS ("E NT Taxis", "E Urban
// Taxis") on a handful of rows. The authority is Cap. 374E Sch. 7, which TD
// publishes as prose plus a RASTER map — nothing to trace. So the extent is
// curated in data/taxi-zones/areas.json against the Home Affairs Department's
// district partition, and classified onto CENTERLINE here.
//
// This module is pure, like road-cutoff.mjs: the builder and
// audit-taxi-zones.mjs both call it, so the map and the audit can never
// disagree about which roads a colour may serve.
import { readFile } from 'node:fs/promises'

import { pointInPolygon, pointInRing } from './geo.mjs'
import { TAXI_ACCESS, TAXI_CLASSES } from './sign-layers.mjs'

export const TAXI_AREAS_FILE = 'data/taxi-zones/areas.json'
export const DISTRICTS_FILE = 'hksar_18_district_boundary.json'

// Most permissive wins, per colour: a designated route that happens to run
// through permitted territory is simply permitted territory, a route that
// reaches a fringe destination is that destination (there the colour may work
// a rank, not merely pass through), and a colour is never both allowed and
// excluded on one road.
const ACCESS_RANK = { area: 0, dest: 1, route: 2, none: 3 }

// The HAD file names its districts in a property whose key is English, beside
// two Chinese-keyed ones; find it by value rather than by key order.
const districtName = f => f.properties?.District

// The `streets` entry that stands for a road with no STREET_ENAME — the ramps
// and links of an interchange, which TD's red lines run through but which no
// name can select (their ALIAS_ENAME, when present, is just "Slip Road", so it
// is not consulted). Only ever inside an `only` ring (validated below):
// unringed it would claim every unnamed road in the territory.
export const UNNAMED = '(unnamed)'

// A district's bounding box, so a point outside it is rejected before any ray
// cast. The 13 district clauses reference 10 distinct geometries totalling
// 19,430 vertices (North District alone is 3,531), and a MISS is the common
// case — a point is in one district and not the other nine — so without this
// every classification scans the lot. Measured over the whole network: 145 µs
// per call, 9.6 s for the build's taxi pass; with it, classification costs
// less than the ogr2ogr read it rides on (5.2 s), and the audit drops from
// ~20 s to ~6 s. Output is unchanged — a bbox test only ever rejects points a
// ray cast would have rejected too.
function bboxOf(geometry) {
  const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [outer] of parts) {
    for (const [x, y] of outer) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return [x0, y0, x1, y1]
}

export async function loadTaxiAreas(areasPath, districtsPath) {
  const areas = JSON.parse(await readFile(areasPath, 'utf8'))
  const districts = JSON.parse(await readFile(districtsPath, 'utf8'))
  const byName = new Map(districts.features.map(f => [districtName(f), f.geometry]))

  const clauses = areas.clauses.map((c, i) => {
    const where = `clause ${i} (${c.taxi} ${c.access})`
    if (!TAXI_CLASSES.includes(c.taxi)) throw new Error(`${where}: unknown taxi class "${c.taxi}"`)
    if (!TAXI_ACCESS.includes(c.access)) throw new Error(`${where}: unknown access "${c.access}"`)
    if (!c.districts && !c.streets) throw new Error(`${where}: needs districts or streets`)
    if (c.streets?.includes(UNNAMED) && !c.only) throw new Error(`${where}: "${UNNAMED}" needs an \`only\` ring`)

    const geometries = (c.districts ?? []).map((d) => {
      const g = byName.get(d)
      if (!g) throw new Error(`${where}: no district named "${d}" in ${districtsPath}`)
      return g
    })
    const ringOf = (key) => {
      if (key == null) return null
      const r = areas.rings?.[key]
      if (!r) throw new Error(`${where}: no ring named "${key}"`)
      return r
    }
    return {
      ...c,
      geometries,
      bboxes: geometries.map(bboxOf),
      only: ringOf(c.only),
      minus: ringOf(c.minus),
      streets: c.streets ? new Set(c.streets) : null,
      // Bumped by classifyRoute; a clause that stays at 0 is a typo nobody
      // would otherwise notice, so both callers report it.
      matched: 0
    }
  })
  return { source: areas.source, asOf: areas.asOf, districts: areas.districts, rings: areas.rings, clauses }
}

// Does this road satisfy one clause? A district clause tests the road's
// representative point; a street clause tests its name. `only` clips either to
// a ring and `minus` subtracts one — the rings may run outside the district
// freely, since only the intersection is ever used. On a street clause a ring
// takes the stretch of a long street TD's red line actually follows.
function clauseMatches(c, lng, lat, names) {
  if (c.streets) {
    const named = names.some(n => n && c.streets.has(n)) || (c.streets.has(UNNAMED) && !names[0])
    if (!named) return false
  } else {
    const inDistrict = c.geometries.some((g, i) => {
      const [x0, y0, x1, y1] = c.bboxes[i]
      return lng >= x0 && lng <= x1 && lat >= y0 && lat <= y1 && pointInPolygon(lng, lat, g)
    })
    if (!inDistrict) return false
  }
  if (c.only && !pointInRing(lng, lat, c.only)) return false
  if (c.minus && pointInRing(lng, lat, c.minus)) return false
  return true
}

// One point → the colours that may serve it, at most one entry per colour.
// A colour with no matching clause is absent, not "denied": `urban` is emitted
// only where red taxis may NOT go, because drawing the 3,900 km they can use
// would say nothing.
function classify(areas, lng, lat, names, onMatch) {
  const best = new Map()
  for (const c of areas.clauses) {
    if (!clauseMatches(c, lng, lat, names)) continue
    onMatch(c)
    const prev = best.get(c.taxi)
    if (!prev || ACCESS_RANK[c.access] < ACCESS_RANK[prev.access]) best.set(c.taxi, c)
  }
  return [...best.values()].map(c => ({ taxi: c.taxi, access: c.access, n: c.n, dest: c.dest }))
}

// Classifying a ROAD records that its clauses bind, which is what the
// dead-clause report reads. Classifying a bare POINT — the straddle test, the
// audit's probes at a road's two ends — must not, or a clause would look alive
// because something merely looked near it. Two names rather than a boolean
// flag: the flag toggled a side effect and not the return value, so a call
// site that forgot it corrupted the report silently instead of failing.
const bindClause = (c) => {
  c.matched++
}
const ignoreClause = () => {}
export const classifyRoute = (areas, lng, lat, names) => classify(areas, lng, lat, names, bindClause)
export const classifyPoint = (areas, lng, lat, names) => classify(areas, lng, lat, names, ignoreClause)

// The point a road is classified at: the vertex halfway along its longest
// part. A vertex, not an interpolated midpoint, so the point is always ON the
// road — a road that loops out of its district and back would otherwise be
// classified somewhere it never goes.
export function representativePoint(geometry) {
  if (!geometry) return null
  const parts = geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates]
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0] ?? [])
  return longest.length ? longest[Math.floor(longest.length / 2)] : null
}

// ── The shareable artefact ────────────────────────────────────────────────
// A copy of this file's recipe with the district polygons INLINED, so another
// project (../should-i-take-taxi, whose NT_TAXI_BOXES is three rectangles its
// own comment calls "a coarse fit, not the gazetted operating area") can
// answer "may this colour serve this point?" with nothing but the file and a
// ray cast: inside any `polygons` entry, or a `streets` name match ("(unnamed)"
// matching a road with no STREET_ENAME) — and in both cases inside `only` if present,
// outside `minus` if present.
//
// It is the recipe rather than the clipped result because intersecting the
// rings into single polygons needs real boolean geometry, where evaluating
// three predicates needs twenty lines. Vertices are thinned to ~33 m, which no
// service-area decision turns on: 4,632 vertices, ~100 kB written compact
// (pretty-printed it would be 398 kB).
const THIN_DEG = 0.0003

function thinRing(ring) {
  const out = [ring[0]]
  for (const p of ring.slice(1, -1)) {
    const last = out[out.length - 1]
    if (Math.abs(p[0] - last[0]) > THIN_DEG || Math.abs(p[1] - last[1]) > THIN_DEG) out.push(p)
  }
  out.push(ring[ring.length - 1])
  return out.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)])
}

const thinGeometry = g => ({
  type: g.type,
  coordinates: g.type === 'Polygon'
    ? g.coordinates.map(thinRing)
    : g.coordinates.map(part => part.map(thinRing))
})

export function shareableAreas(areas) {
  return {
    source: areas.source,
    asOf: areas.asOf,
    districts: areas.districts,
    note: 'Generated by scripts/build-road-rules.mjs from data/taxi-zones/areas.json. A point is served by `taxi` at `access` when it is inside any `polygons` entry — or, for a `streets` clause, on a road whose CENTERLINE.STREET_ENAME / ALIAS_ENAME is listed ("(unnamed)" = a road with no STREET_ENAME) — and in both cases inside `only` (if given) and outside `minus` (if given). Most permissive access per colour wins: area > dest > route > none. Ring vertices are thinned to ~33 m.',
    clauses: areas.clauses.map(c => ({
      taxi: c.taxi,
      access: c.access,
      ...(c.n != null ? { n: c.n } : {}),
      ...(c.cite ? { cite: c.cite } : {}),
      ...(c.dest ? { dest: c.dest } : {}),
      ...(c.streets ? { streets: [...c.streets] } : {}),
      ...(c.geometries.length ? { polygons: c.geometries.map(thinGeometry) } : {}),
      ...(c.only ? { only: c.only } : {}),
      ...(c.minus ? { minus: c.minus } : {})
    }))
  }
}

// A road whose two ends fall in different areas straddles the boundary, so
// whichever end the representative point sat nearer decided it. Not an error
// — every boundary has such roads — but the count is how coarse the curated
// rings are, so both callers print it.
export function straddles(areas, geometry, names) {
  const parts = geometry?.type === 'MultiLineString' ? geometry.coordinates : [geometry?.coordinates ?? []]
  // The two ends, read in place — flattening every vertex to take the first
  // and last allocated the whole coordinate array for two lookups.
  const first = parts[0]?.[0]
  const last = parts.at(-1)?.at(-1)
  if (!first || !last) return false
  const key = p => classifyPoint(areas, p[0], p[1], names).map(r => `${r.taxi}:${r.access}`).sort().join(',')
  return key(first) !== key(last)
}
