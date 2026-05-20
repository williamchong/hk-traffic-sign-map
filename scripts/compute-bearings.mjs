// Derive a face bearing per traffic-sign-abbreviation feature by snapping it
// to the nearest road-marking line and taking that line's compass bearing.
// Output: data/raw/_face_bearings.json — { "<FEATUREID>": <degrees>, ... }
//
// The pipeline ran into a real problem: TD's per-feature ANGLE is the
// MicroStation symbol-cell rotation, not a compass face-normal, so signs on
// opposite carriageways of a divided road end up with the same ANGLE (~59 %
// of nearby same-code pairs in the data) and render misleadingly identical
// when fed to maplibre's icon-rotate (see commit 42c343a). Road markings give
// us free road direction at every sign location — every road that carries
// signs also carries lane / kerb markings — so we derive the bearing once at
// build time and inject it as FACE_BEARING on each ABV_PT feature.
//
// Two-line summary of the math: pick the nearest marking-line segment ≥ 3 m
// (filters out perpendicular ticks like give-way & zebra), project the sign
// onto it for the road tangent direction, and use the cross-product sign of
// (tangent × (sign - projected)) to decide which side of the road we're on.
// Same-side signs get face = tangent; other-side signs get tangent + 180°.
// We don't know which way TD's marking chainage runs along the road — so
// "left" vs "right" is arbitrary, but the relative invariant we care about
// (opposite-carriageway signs are 180° apart) holds either way.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { RAW_DIR } from './sign-layers.mjs'

const MIN_SEG_LEN = 3 // metres — drops short cross-road tick marks
const MAX_NEAR = 25 // metres — beyond this the marking is too far to trust
const GRID = 25 // spatial-index cell size; matched to MAX_NEAR for one-ring search

const ABV_GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')
const MARK_GML = join(RAW_DIR, 'DTAD_RD_MARK_LINE.gml')
const OUT = join(RAW_DIR, '_face_bearings.json')

const memberRx = /<core:cityObjectMember>([\s\S]*?)<\/core:cityObjectMember>/g
const posListRx = /<gml:posList>([^<]+)<\/gml:posList>/g
const ptPosRx = /<gml:pos>([-\d.]+)\s+([-\d.]+)<\/gml:pos>/
const attrRx = (name, kind) => new RegExp(
  `<gen:${kind}Attribute name="${name}">[\\s\\S]*?<gen:value>([^<]*)<\\/gen:value>`
)

// --- 1. Parse road-marking segments ≥ MIN_SEG_LEN into HK1980 metre tuples ---
console.log(`Reading ${MARK_GML}…`)
const t0 = Date.now()
const markText = await readFile(MARK_GML, 'utf8')
const segs = []
const minLen2 = MIN_SEG_LEN * MIN_SEG_LEN
for (const m of markText.matchAll(memberRx)) {
  for (const pm of m[0].matchAll(posListRx)) {
    const nums = pm[1].trim().split(/\s+/).map(parseFloat)
    for (let i = 0; i + 3 < nums.length; i += 2) {
      const ax = nums[i], ay = nums[i + 1], bx = nums[i + 2], by = nums[i + 3]
      if ((bx - ax) ** 2 + (by - ay) ** 2 >= minLen2) segs.push({ ax, ay, bx, by })
    }
  }
}
console.log(`  ${segs.length} marking segments ≥ ${MIN_SEG_LEN}m  (${Date.now() - t0}ms)`)

// --- 2. Spatial index: bin endpoints + intermediate samples every GRID metres ---
const grid = new Map()
function bin(idx, x, y) {
  const k = `${Math.floor(x / GRID)}|${Math.floor(y / GRID)}`
  let cell = grid.get(k)
  if (!cell) {
    cell = []
    grid.set(k, cell)
  }
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

// --- 3. Parse ABV_PT (FEATUREID + HK1980 position) ---
console.log(`Reading ${ABV_GML}…`)
const abvText = await readFile(ABV_GML, 'utf8')
const featuridRx = attrRx('FEATUREID', 'int')
const signs = []
for (const m of abvText.matchAll(memberRx)) {
  const body = m[1]
  const fid = body.match(featuridRx)?.[1]
  const pos = body.match(ptPosRx)
  if (!fid || !pos) continue
  signs.push({ fid, x: parseFloat(pos[1]), y: parseFloat(pos[2]) })
}
console.log(`  ${signs.length} ABV_PT features`)

// --- 4. For each sign: nearest segment within MAX_NEAR, compute face bearing ---
function project(px, py, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay
  const L2 = dx * dx + dy * dy
  let t = ((px - s.ax) * dx + (py - s.ay) * dy) / L2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const qx = s.ax + t * dx, qy = s.ay + t * dy
  return { qx, qy, d: Math.hypot(px - qx, py - qy), dx, dy }
}
function nearest(px, py) {
  const cx = Math.floor(px / GRID), cy = Math.floor(py / GRID)
  let best = null, bestD = MAX_NEAR
  const seen = new Set()
  // 1-cell ring covers MAX_NEAR (= GRID); expand to 2 in case the sign sits
  // near a cell boundary and the closest segment is in a diagonally-adjacent
  // cell that the 1-ring missed.
  for (let r = 0; r <= 2; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
      const cell = grid.get(`${cx + dx}|${cy + dy}`)
      if (!cell) continue
      for (const idx of cell) {
        if (seen.has(idx)) continue
        seen.add(idx)
        const p = project(px, py, segs[idx])
        if (p.d < bestD) {
          bestD = p.d
          best = p
        }
      }
    }
    if (best && bestD < GRID * r) return best
  }
  return best
}

// HK1980 grid is east/north metres → compass bearing CW from north
const compass = (dx, dy) => ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

const out = {}
let matched = 0
for (const a of signs) {
  const n = nearest(a.x, a.y)
  if (!n) continue
  matched++
  const tangent = compass(n.dx, n.dy)
  // z-component of (tangent × displacement); sign tells us which side of the
  // marking the sign sits on. Either side's *absolute* face direction is a
  // guess (TD's chainage isn't traffic direction), but opposite sides differ
  // by 180° — which is the invariant the user actually wanted.
  const z = n.dx * (a.y - n.qy) - n.dy * (a.x - n.qx)
  const face = z > 0 ? tangent : (tangent + 180) % 360
  // Round to 0.1° — keeps the JSON small and is well below the human-noticeable
  // rotation step on a 20-30 px icon.
  out[a.fid] = Math.round(face * 10) / 10
}
console.log(`  ${matched} signs matched (${(matched / signs.length * 100).toFixed(1)}%)`)

await writeFile(OUT, JSON.stringify(out))
console.log(`\nWrote ${OUT}  (${Object.keys(out).length} entries)`)
