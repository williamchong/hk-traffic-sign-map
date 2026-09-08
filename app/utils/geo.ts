// Small planar geometry over WGS84 degrees, good enough at Hong Kong's scale
// (an equirectangular metre scale at the territory's latitude; error well
// under 1 % over the few tens of metres these helpers are asked about).
const LAT_M = 110_574
const HK_LAT = 22.35
const LNG_M = 111_320 * Math.cos(HK_LAT * Math.PI / 180)

type Position = number[]

// Squared distance from (px, py) to the segment (ax, ay)–(bx, by), all in
// metres — squared so the scan below compares without a sqrt per segment.
function segmentDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  const ex = px - (ax + t * dx), ey = py - (ay + t * dy)
  return ex * ex + ey * ey
}

// Distance in metres from [lng, lat] to the nearest point of a LineString or
// MultiLineString's coordinates.
export function pointToLineMetres(lng: number, lat: number, coords: Position[] | Position[][]) {
  const px = lng * LNG_M, py = lat * LAT_M
  const lines = (typeof coords[0]?.[0] === 'number' ? [coords] : coords) as Position[][]
  let best = Infinity
  for (const line of lines) {
    if (line.length < 2) continue
    let ax = line[0]![0]! * LNG_M, ay = line[0]![1]! * LAT_M
    for (let i = 1; i < line.length; i++) {
      const bx = line[i]![0]! * LNG_M, by = line[i]![1]! * LAT_M
      const d2 = segmentDist2(px, py, ax, ay, bx, by)
      if (d2 < best) best = d2
      ax = bx
      ay = by
    }
  }
  return Math.sqrt(best)
}
