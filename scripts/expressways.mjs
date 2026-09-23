// Which CENTERLINE routes are expressways — the `expressway` source-layer of
// the road-rules archive, and an input to the public-light-bus cut-off search.
//
// Nothing in TD's network says so. CENTERLINE has no road-class field and the
// ban that matters here has almost no PROHIBITION rows: Cap. 374Q reg 4 lets
// onto an expressway only the vehicles it lists — a public light bus is not
// one of them — and reg 5 bars learner drivers, so TD posts no "PLB Proh" on
// most of Fanling Highway, Yuen Long Highway or San Tin Highway, and the
// cut-off search, which reads only rows, left ~390 of ~440 km of them open.
// The authority is the designation itself (s.123(1) of Cap. 374), which TD's
// boundary advice lists item by item, so the extent is curated in
// data/expressways/designation.json, one clause per item, and classified onto
// CENTERLINE here — the taxi-zones.mjs pattern.
//
// Pure like road-cutoff.mjs and taxi-zones.mjs: the builder and both audits
// call it, so the map and the audits close the same roads.
import { readFile } from 'node:fs/promises'

import { pointInRing } from './geo.mjs'
import { closureRow } from './road-cutoff.mjs'

export const EXPRESSWAY_FILE = 'data/expressways/designation.json'

// The columns a CENTERLINE `-dialect SQLite` read adds so a route can be
// classified without reading its line: the middle vertex of its first part,
// reprojected by SpatiaLite (a vertex, not an interpolated midpoint, so the
// point is always ON the road), and ELEVATION, which marks a tunnel (< 0).
// CENTERLINE's arcs arrive pre-stroked, so the middle vertex is never far off.
const MID = 'ST_Transform(ST_PointN(ST_GeometryN(SHAPE, 1), ST_NumPoints(ST_GeometryN(SHAPE, 1)) / 2 + 1), 4326)'
export const CLASSIFY_SQL_COLUMNS = `ELEVATION, ST_X(${MID}) AS mx, ST_Y(${MID}) AS my`

export async function loadDesignation(path = EXPRESSWAY_FILE) {
  const d = JSON.parse(await readFile(path, 'utf8'))
  const ringOf = (key, where) => {
    const r = d.rings?.[key]
    if (!r) throw new Error(`${where}: no ring named "${key}"`)
    return r
  }
  const clauses = d.clauses.map((c, i) => {
    const where = `clause ${i} (${c.item})`
    if (!c.item || !c.cite) throw new Error(`${where}: needs item and cite`)
    if (!c.streets?.length) throw new Error(`${where}: needs streets`)
    if (c.plb && !(c.plb.en && c.plb.zh && c.plb.evidence)) throw new Error(`${where}: plb needs en, zh and evidence`)
    return {
      ...c,
      streets: new Set(c.streets),
      only: c.only ? ringOf(c.only, where) : null,
      except: (c.except ?? []).map(e => ({ only: ringOf(e.only, where), tunnel: !!e.tunnel })),
      // Bumped by classifyExpressways; a clause left at 0 is a street TD
      // renamed or a mis-drawn ring, and both callers report it.
      matched: 0,
      lenM: 0
    }
  })
  return { source: d.source, designation: d.designation, asOf: d.asOf, clauses }
}

function clauseMatches(c, e) {
  if (!c.streets.has(e.st_en)) return false
  if (c.only && !pointInRing(e.mx, e.my, c.only)) return false
  return !c.except.some(x => (!x.tunnel || e.elevation < 0) && pointInRing(e.mx, e.my, x.only))
}

// edges: [{ routeId, st_en, elevation, mx, my, len }] — the cut-off graph's
//        edges plus the WGS84 middle vertex (CLASSIFY_SQL_COLUMNS)
// → Map routeId → clause (the first one the route matches)
//
// Named routes only. s.123(1) designates a road "including any access thereto
// or exit therefrom", but CENTERLINE's unnamed links cannot tell a ramp from a
// carriageway: a walk that took every unnamed one-way link off a designated
// route took Castle Peak Road's own westbound pieces at the Siu Lam junction
// as Tuen Mun Road slips, and closing them stranded 1,043 km of the north-west
// New Territories. So the ramps are withheld — an exit ramp still comes out of
// the cut-off search as cut off, since it can only be reached from the
// expressway, and audit-expressways.mjs counts the TS353/TS354 plates that
// stand on one.
export function classifyExpressways(designation, edges) {
  const out = new Map()
  for (const e of edges) {
    if (!e.st_en) continue
    const c = designation.clauses.find(c => clauseMatches(c, e))
    if (!c) continue
    c.matched++
    c.lenM += e.len ?? 0
    out.set(e.routeId, c)
  }
  return out
}

// One synthetic closing row (road-cutoff.mjs `closureRow`) per designated
// route PLBs may not use; its "E WP" fits, since reg 4(2) and 24 let a permit
// holder through. A clause with `plb` gets no row: a reg 24 authorisation
// opens it for part of the day, and the cut-off search treats a part-time ban
// as open. These rows feed the cut-off search only — the `expressway` layer
// draws the routes, so they are not written as 400 km of prohibition dashes.
export const expresswayClosures = classified => [...classified]
  .filter(([, clause]) => !clause.plb)
  .map(([routeId]) => closureRow(`expressway-${routeId}`, routeId, 0))
