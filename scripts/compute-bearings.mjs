// Derive an ABSOLUTE face bearing per traffic-sign-abbreviation feature from
// the directed Road Network v2 centreline it stands beside, falling back to the
// (direction-less) road-marking tangent where no centreline is near.
// Output: data/raw/_face_bearings.json — { "<FEATUREID>": [degrees, source] }
//   source 1 = centreline host (absolute facing), 0 = marking host (relative only)
// Also: data/raw/_pole_anchors.json — { "<GG_NAME>": [lng, lat] } (WGS84), the
// surveyed pole position of every sign group that has one, so build-tiles and
// compute-stacks can draw each sign at its pole rather than at TD's label point.
//
// The bearing is the way the PLATE FACES — its outward normal, pointing at the
// traffic it addresses — as a compass bearing clockwise from north. The runtime
// feeds it to `icon-rotate`, so the pictogram's top points at the drivers who
// read the sign.
//
// Why a centreline host, and why the pole: this used to snap the label point
// to the nearest road-marking line (`DTAD_RD_MARK_LINE`) and flip by which side
// of the line the sign fell on. That gives the two carriageways of a road
// bearings 180° apart — but TD's marking chainage direction is unknown, so
// which side counts as "forward" was a coin toss per road, and the same coin
// decided a one-way street's give-way and no-entry plates alike. Road Network
// v2's CENTERLINE is *directed* (TRAVEL_DIRECTION 3 = travel only in the
// digitised direction, 1 = both ways — two thirds of HK's edges are one-way,
// because dual carriageways are opposed one-way pairs), so with the kerb side
// and drive-on-the-left the facing is absolute. The rule is hk-taxi-Q's
// `facing_from_side` (etl/pipeline/signs.py): a sign addresses the traffic
// that passes it, so
//   • on a ONE-WAY edge both kerbs serve the same traffic → both face back
//     against the flow (heading + 180);
//   • on a TWO-WAY edge the NEARSIDE kerb (left of travel, drive-on-left)
//     faces back against the flow (heading + 180) and the offside kerb serves
//     the opposite direction → faces along the heading.
// The host point is the sign's POLE (DTAD_TS_POLE_PT, joined by GG_NAME): the
// abbreviation point is where a draughtsman put the label, a median 2.3 m
// (p90 6.5 m) from the pole and on no particular side of it.
//
// ⚠️ Still ungraded: no published source says which way a sign faces, so this
// is a well-founded derivation, not a checked fact (hk-taxi-Q's turn-
// restriction diff could not grade the kerb side either). Its measured weak
// spot is the corner pole: 57 % of hosts have a second, non-parallel road
// within MAX_NEAR and 30 % within 5 m of the nearest, and nothing in the data
// says which road a junction sign serves — the nearest wins. The per-PLATE
// exception — a "no entry" faces the wrong-way driver, i.e. 180° from its post
// — is applied downstream (compute-stacks / build-tiles via
// AGAINST_TRAFFIC_CODES), so this file holds one meaning: the POST facing.

import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

import { RAW_DIR, RDNET_CENTERLINE_LAYER } from './sign-layers.mjs'
import { attrRx, memberRx, parsePolePoints, ptPosRx, reprojectPoints } from './geo.mjs'

const MIN_SEG_LEN = 3 // metres — drops short cross-road tick marks (marking lines only)
const MAX_NEAR = 25 // metres — beyond this the host road is too far to trust
const GRID = 25 // spatial-index cell size; matched to MAX_NEAR for one-ring search
const PAIR_NEAR = 5 // metres — a second centreline this close = opposed one-way pair (logged)
const ONE_WAY = 3 // Road Network TRAVEL_DIRECTION: travel only in the digitised direction
// The FGDB centrelines arrive with their arcs pre-stroked at ~1.5 cm vertex
// spacing (~12M vertices, 309 MB of WKT HK-wide). GDAL simplifies them on the
// way out with this tolerance (metres, Douglas-Peucker, endpoints kept): a 1 cm
// sagitta on a 10 m-radius corner leaves chords ~0.9 m long whose direction is
// within ~2.6° of the true tangent — noise against the kerb-side call — while
// straight runs collapse to their endpoints.
const SIMPLIFY_M = 0.01

const ABV_GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')
const POLE_GML = join(RAW_DIR, 'DTAD_TS_POLE_PT.gml')
const MARK_GML = join(RAW_DIR, 'DTAD_RD_MARK_LINE.gml')
const RDNET_ZIP = join(RAW_DIR, 'RdNet_IRNP.gdb.zip')
const OUT = join(RAW_DIR, '_face_bearings.json')
const POLES_OUT = join(RAW_DIR, '_pole_anchors.json')

const posListRx = /<gml:posList>([^<]+)<\/gml:posList>/g

// HK1980 grid is east/north metres → compass bearing CW from north
const compass = (dx, dy) => ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

// --- Spatial index over line segments: bin endpoints + samples every GRID m ---
function buildIndex(segs) {
  const grid = new Map()
  const bin = (idx, x, y) => {
    const k = `${Math.floor(x / GRID)}|${Math.floor(y / GRID)}`
    let cell = grid.get(k)
    if (!cell) grid.set(k, cell = [])
    cell.push(idx)
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    bin(i, s.ax, s.ay)
    bin(i, s.bx, s.by)
    const len = Math.hypot(s.bx - s.ax, s.by - s.ay)
    if (len > GRID) {
      const steps = Math.ceil(len / GRID)
      for (let k = 1; k < steps; k++) {
        const t = k / steps
        bin(i, s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t)
      }
    }
  }
  return { segs, grid }
}

function project(px, py, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay
  const L2 = dx * dx + dy * dy
  let t = ((px - s.ax) * dx + (py - s.ay) * dy) / L2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const qx = s.ax + t * dx, qy = s.ay + t * dy
  return { qx, qy, d: Math.hypot(px - qx, py - qy), dx, dy, seg: s }
}

// Nearest segment within MAX_NEAR (optionally only those passing `accept`),
// plus (for the pair diagnostic) whether a segment of a DIFFERENT feature also
// lies within PAIR_NEAR. The diagnostic pass costs ~10 % of this loop.
function nearest(index, px, py, accept = null) {
  const cx = Math.floor(px / GRID), cy = Math.floor(py / GRID)
  let best = null, bestD = MAX_NEAR
  let second = false
  const seen = new Set()
  // 1-cell ring covers MAX_NEAR (= GRID); expand to 2 in case the point sits
  // near a cell boundary and the closest segment is in a diagonally-adjacent
  // cell that the 1-ring missed.
  for (let r = 0; r <= 2; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
      const cell = index.grid.get(`${cx + dx}|${cy + dy}`)
      if (!cell) continue
      for (const idx of cell) {
        if (seen.has(idx)) continue
        seen.add(idx)
        if (accept && !accept(index.segs[idx])) continue
        const p = project(px, py, index.segs[idx])
        if (p.d < bestD) {
          bestD = p.d
          best = p
        }
      }
    }
    if (best && bestD < GRID * r) break
  }
  if (best) {
    for (const idx of seen) {
      const s = index.segs[idx]
      if (s.feature === best.seg.feature) continue
      if (project(px, py, s).d <= PAIR_NEAR) {
        second = true
        break
      }
    }
  }
  return { best, second }
}

// --- 1. Directed centreline segments from the Road Network FGDB ---
async function readCentrelines() {
  // Stream the layer as CSV + WKT in its native HK1980 grid: the maths below are
  // in metres, and GDAL's GeoJSON drivers reproject to WGS84 unconditionally
  // (RFC 7946), so WKT is the format that keeps the grid coordinates. GDAL
  // opens the FGDB inside the zip directly. Columns: SHAPE,TRAVEL_DIRECTION,
  // ELEVATION — the WKT is double-quoted and contains no quotes.
  const ogr = spawn('ogr2ogr', [
    '-f', 'CSV', '/vsistdout/',
    `/vsizip/${RDNET_ZIP}`, RDNET_CENTERLINE_LAYER,
    '-lco', 'GEOMETRY=AS_WKT',
    '-select', 'TRAVEL_DIRECTION,ELEVATION',
    '-simplify', String(SIMPLIFY_M)
  ])
  let stderr = ''
  ogr.stderr.on('data', d => (stderr += d))
  const rl = createInterface({ input: ogr.stdout, crlfDelay: Infinity })
  const rowRx = /^"([^"]*)",(-?\d*),(-?\d*)/
  const partRx = /\(([^()]+)\)/g
  const segs = []
  let features = 0, oneWayFeatures = 0
  for await (const line of rl) {
    const row = line.match(rowRx)
    if (!row) continue // header, or a row without geometry
    const oneWay = Number(row[2]) === ONE_WAY
    const elev = Number(row[3]) || 0
    features++
    if (oneWay) oneWayFeatures++
    // Each innermost (…) group of the MULTILINESTRING is one directed part, in
    // digitised order; every vertex pair is a directed segment.
    for (const part of row[1].matchAll(partRx)) {
      const nums = part[1].trim().split(/[\s,]+/).map(Number)
      for (let i = 0; i + 3 < nums.length; i += 2) {
        const ax = nums[i], ay = nums[i + 1], bx = nums[i + 2], by = nums[i + 3]
        if (ax === bx && ay === by) continue
        segs.push({ ax, ay, bx, by, oneWay, elev, feature: features })
      }
    }
  }
  const [code] = await once(ogr, 'close')
  if (code !== 0) {
    console.error(`ogr2ogr failed reading the Road Network FGDB (exit ${code}) — is GDAL installed with OpenFileGDB? (brew install gdal)\n${stderr}`)
    process.exit(code)
  }
  console.log(`  ${features} centrelines (${(oneWayFeatures / features * 100).toFixed(1)}% one-way) → ${segs.length} directed segments`)
  return segs
}

// --- 2. Fallback host: road-marking segments ≥ MIN_SEG_LEN ---
// Scoped in a function so the 160 MB GML string is collectable once parsed.
async function readMarkingSegments() {
  const text = await readFile(MARK_GML, 'utf8')
  const segs = []
  const minLen2 = MIN_SEG_LEN * MIN_SEG_LEN
  let feature = 0
  for (const m of text.matchAll(memberRx)) {
    feature++
    for (const pm of m[0].matchAll(posListRx)) {
      const nums = pm[1].trim().split(/\s+/).map(parseFloat)
      for (let i = 0; i + 3 < nums.length; i += 2) {
        const ax = nums[i], ay = nums[i + 1], bx = nums[i + 2], by = nums[i + 3]
        if ((bx - ax) ** 2 + (by - ay) ** 2 >= minLen2) segs.push({ ax, ay, bx, by, feature })
      }
    }
  }
  console.log(`  ${segs.length} marking segments ≥ ${MIN_SEG_LEN}m`)
  return segs
}

// --- 3. Signs: FEATUREID, GG_NAME, label position ---
async function readSigns() {
  const text = await readFile(ABV_GML, 'utf8')
  const fidRx = attrRx('FEATUREID', 'int')
  const ggRx = attrRx('GG_NAME', 'string')
  const signs = []
  for (const m of text.matchAll(memberRx)) {
    const body = m[1]
    const fid = body.match(fidRx)?.[1]
    const pos = body.match(ptPosRx)
    if (!fid || !pos) continue
    signs.push({ fid, gg: body.match(ggRx)?.[1]?.trim() ?? '', x: parseFloat(pos[1]), y: parseFloat(pos[2]) })
  }
  console.log(`  ${signs.length} ABV_PT features`)
  return signs
}

let t0 = Date.now()
console.log(`Reading ${RDNET_ZIP}:${RDNET_CENTERLINE_LAYER} …`)
const roadIndex = buildIndex(await readCentrelines())
console.log(`  (${Date.now() - t0}ms)`)
t0 = Date.now()
console.log(`Reading ${MARK_GML}…`)
const markIndex = buildIndex(await readMarkingSegments())
console.log(`  (${Date.now() - t0}ms)`)
console.log(`Reading ${POLE_GML}…`)
const poleByGroup = parsePolePoints(await readFile(POLE_GML, 'utf8'))
console.log(`  ${poleByGroup.size} pole groups`)
console.log(`Reading ${ABV_GML}…`)
const signs = await readSigns()

// --- 4. Per sign: host point → nearest centreline → absolute facing; else marking tangent ---
const out = {}
const usedPoles = new Map() // GG_NAME → pole — poles that host at least one sign
const atGrade = s => s.elev === 0
let onPole = 0, viaRoad = 0, viaMark = 0, oneWayHosts = 0, paired = 0, elevMismatch = 0, elevRescued = 0
for (const a of signs) {
  const pole = poleByGroup.get(a.gg)
  const hx = pole ? pole.x : a.x, hy = pole ? pole.y : a.y
  if (pole) {
    onPole++
    usedPoles.set(a.gg, pole)
  }
  let { best: r, second } = nearest(roadIndex, hx, hy)
  // Flyover guard: a ground-level pole (TD ELEVATION empty) whose nearest
  // centreline is off-grade has most likely snapped to the road overhead. If an
  // at-grade centreline is also within reach, that is its host. (Measured before
  // this was added: 8,262 of 175k hosts, 4.7%.)
  if (r && r.seg.elev !== 0 && (!pole || pole.elev === '')) {
    const ground = nearest(roadIndex, hx, hy, atGrade)
    if (ground.best) {
      r = ground.best
      second = ground.second
      elevRescued++
    }
  }
  if (r) {
    // Heading of travel along the digitised direction; z > 0 ⇔ the host lies
    // LEFT of travel (the left normal of (dx,dy) is (−dy,dx), and its dot with
    // (host − foot) is exactly this cross product) — the nearside kerb under
    // drive-on-the-left. A point on the line counts as nearside.
    const heading = compass(r.dx, r.dy)
    const z = r.dx * (hy - r.qy) - r.dy * (hx - r.qx)
    const face = (r.seg.oneWay || z >= 0) ? (heading + 180) % 360 : heading
    out[a.fid] = [Math.round(face * 10) / 10, 1]
    viaRoad++
    if (r.seg.oneWay) oneWayHosts++
    if (second) paired++
    if (r.seg.elev !== 0 && pole && pole.elev === '') elevMismatch++
    continue
  }
  const { best: n } = nearest(markIndex, hx, hy)
  if (!n) continue
  // Relative fallback (the pre-Road-Network rule): the marking's tangent, flipped
  // by which side of it the host falls on. Either side's absolute direction is a
  // guess (TD's chainage isn't traffic direction), but opposite sides differ by
  // 180°, which is the invariant this fallback keeps.
  const tangent = compass(n.dx, n.dy)
  const z = n.dx * (hy - n.qy) - n.dy * (hx - n.qx)
  const face = z > 0 ? tangent : (tangent + 180) % 360
  out[a.fid] = [Math.round(face * 10) / 10, 0]
  viaMark++
}
const pct = n => (n / signs.length * 100).toFixed(1)
console.log(`  hosts: ${onPole} at their pole (${pct(onPole)}%), ${signs.length - onPole} at the label point (no pole)`)
console.log(`  bearings: ${viaRoad} via centreline (${pct(viaRoad)}%, ${(oneWayHosts / viaRoad * 100).toFixed(1)}% on one-way edges), ${viaMark} via marking fallback (${pct(viaMark)}%), ${signs.length - viaRoad - viaMark} none (${pct(signs.length - viaRoad - viaMark)}%)`)
console.log(`  diagnostics: ${paired} hosts had a second centreline within ${PAIR_NEAR} m (opposed one-way pairs); ${elevRescued} ground poles re-hosted from an off-grade centreline to an at-grade one, ${elevMismatch} still off-grade (no at-grade road in reach)`)

// --- 5. Reproject the used pole positions once (EPSG:2326 → WGS84) ---
console.log(`Reprojecting ${usedPoles.size} pole anchors …`)
const keys = [...usedPoles.keys()]
const wgs = await reprojectPoints(keys.map(k => [usedPoles.get(k).x, usedPoles.get(k).y]))
const poles = {}
keys.forEach((k, i) => {
  poles[k] = wgs[i]
})

await writeFile(OUT, JSON.stringify(out))
console.log(`\nWrote ${OUT}  (${Object.keys(out).length} entries)`)
await writeFile(POLES_OUT, JSON.stringify(poles))
console.log(`Wrote ${POLES_OUT}  (${keys.length} pole anchors)`)
