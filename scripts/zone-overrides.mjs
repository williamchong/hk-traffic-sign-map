// Notice-backed corrections to TD's PROHIBITION rows, applied before the
// public-light-bus cut-off search (road-cutoff.mjs) and drawn as ban lines.
//
// WHY. The IRNP PROHIBITION layer lags the Commissioner's reg 14(1)(a)
// notices (data/zone-notices/prohibited-zones.json) by 1–35 months, both ways:
// a road designated in 2022 had no row in the 2026-09 network while its two
// TS119 plates stood on it (Ng Lau Road), and a road rescinded in 2025 was
// still sealed by a 2011 row (Kai Lim Road). The search itself is sound — its
// input is stale. So a small, human-curated file (overrides.json) closes or
// reopens named routes, each entry citing the notice that says so.
//
// A `close` becomes a synthetic PROHIBITION-shaped row so it goes through the
// unchanged `closesFor`/`kindsOf`; it carries `notice` so the tile props and
// the popup can say where it came from. An `open` drops a row by id, guarded
// by the street it must sit on. Both warn when TD has caught up (the row
// appeared / disappeared), so the file shrinks rather than fossilises.
//
// Extents still come only from TD's own instruments — a row or a notice —
// never from sign points; signs corroborate in audit-cutoff-notices.mjs.

import { readFile } from 'node:fs/promises'

import { CUTOFF_VEHICLE } from './sign-layers.mjs'
import { addressesCutoff } from './road-cutoff.mjs'

export const OVERRIDES_FILE = 'data/zone-notices/overrides.json'
export const NOTICES_FILE = 'data/zone-notices/prohibited-zones.json'

export async function loadOverrides(file = OVERRIDES_FILE) {
  try {
    const o = JSON.parse(await readFile(file, 'utf8'))
    return { close: o.close ?? [], open: o.open ?? [] }
  } catch (err) {
    if (err.code === 'ENOENT') return { close: [], open: [] }
    throw err
  }
}

export async function loadNoticeTitles(file = NOTICES_FILE) {
  try {
    const d = JSON.parse(await readFile(file, 'utf8'))
    return new Map(d.notices.map(n => [n.tnid, n.title?.en ?? '']))
  } catch (err) {
    if (err.code === 'ENOENT') return new Map()
    throw err
  }
}

// rows:     PROHIBITION property objects (ROAD_ROUTE_ID, PROHIBITION_ID, …)
// streetOf: routeId → STREET_ENAME (upper case, as CENTERLINE spells it)
// → { rows, applied: { close, open }, warnings: [string] }
export function applyZoneOverrides(rows, streetOf, overrides) {
  const warnings = []
  const byStreet = new Map()
  for (const [id, st] of streetOf) {
    if (!st) continue
    byStreet.has(st) ? byStreet.get(st).push(id) : byStreet.set(st, [id])
  }
  const byId = new Map(rows.map(r => [r.PROHIBITION_ID, r]))

  const dropped = new Set()
  for (const o of overrides.open) {
    const row = byId.get(o.prohibitionId)
    if (!row) {
      warnings.push(`open ${o.st} (notice ${o.notice}): row ${o.prohibitionId} is gone from PROHIBITION — TD caught up, drop this entry`)
      continue
    }
    const st = streetOf.get(row.ROAD_ROUTE_ID)
    if (st !== o.st) {
      warnings.push(`open ${o.st} (notice ${o.notice}): row ${o.prohibitionId} now sits on ${st ?? '?'} — id reused, NOT applied`)
      continue
    }
    dropped.add(row)
  }
  const kept = rows.filter(r => !dropped.has(r))

  // A route TD already bans for the class gets no synthetic twin: the tile
  // would carry two lines over one segment, and which popup a click opened
  // would depend on draw order. The warning says the entry is on its way out.
  const addressed = new Set(kept.filter(addressesCutoff).map(r => r.ROAD_ROUTE_ID))
  const added = []
  for (const c of overrides.close) {
    const ids = c.routeIds ?? byStreet.get(c.st) ?? []
    if (!ids.length) {
      warnings.push(`close ${c.st} (notice ${c.notice}): no CENTERLINE route carries that name — NOT applied`)
      continue
    }
    const covered = ids.filter(id => addressed.has(id))
    if (covered.length) {
      warnings.push(`close ${c.st} (notice ${c.notice}): TD now bans ${CUTOFF_VEHICLE} on ${covered.length} of its ${ids.length} route(s) — ${covered.length === ids.length ? 'drop this entry' : 'check whether it is still needed'}`)
    }
    for (const id of ids) {
      if (addressed.has(id)) continue
      added.push({
        PROHIBITION_ID: -Number(c.notice),
        ROAD_ROUTE_ID: id,
        INC_VEH_TYPE: CUTOFF_VEHICLE,
        EXC_VEH_TYPE: 'NA',
        PART_TIME_PROHIBITION: 'N',
        EFF_ALL_DAYS: 'Y',
        OTHER_REST_TYPE_GV: 'NA',
        REMARKS: `${CUTOFF_VEHICLE} Proh/ E WP`,
        BOUND: c.bound ?? 0,
        notice: String(c.notice)
      })
    }
  }
  return { rows: kept.concat(added), applied: { close: added.length, open: dropped.size }, warnings }
}
