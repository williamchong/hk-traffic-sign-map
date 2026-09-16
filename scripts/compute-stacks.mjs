// Derive how each traffic-sign-abbreviation feature renders when it belongs to
// a co-located assembly, so the group draws as one signpost.
// Output: data/raw/_sign_stacks.json — keyed by FEATUREID →
//   [ stackIndex, stackSize, picWidth, anchorLng, anchorLat, bearing, stackOff, primaryTier, stackId ]
// Also writes app/data/signGroups.json — { SIGNID: [stackId, …] } over the
// same posts, so the runtime sign-ID filter can pull in a matched sign's
// post-mates and show the complete signpost (see useTrafficLayers mapFilter).
// Built here because this is where post membership is known.
//
// The grouping key is the GML `GG_NAME` ("sign-group name", e.g. W02R22D_392):
// signs sharing it were gazetted/installed as one unit and carry combined
// meaning (a main sign with its supplementary plate underneath, two warnings
// on one post, …). `GG_NAME` is NOT the sign type (that's REFNAME/SIGNID) nor
// the Index-Plan category (regulatory/warning/…); it's the assembly id.
//
// A GG_NAME is ONE FACE of a pole, though. TD draws the two faces of a
// back-to-back pole ("Give way" towards the side street, "No entry" towards the
// main road) as two separate groups whose DTAD_TS_POLE_PT points coincide
// (~10.7k such poles; "Give way | No entry" alone is ~1.4k). Nothing in the
// data says which way a face points (the abbreviation ANGLE is a text-
// readability rotation, the pole ANGLE is unrelated to the road), but two
// groups on one pole can only be two faces (TD puts a give-way and a no-entry
// in ONE group 6 times HK-wide, against ~1.4k co-located pairs) — so a POST
// here is every group sharing a pole point. Its faces turn in quarter turns
// from the POST facing that compute-bearings derived at the pole (absolute,
// from the directed Road Network centreline): a face whose top sign is in
// AGAINST_TRAFFIC_CODES (the no-entry family, which addresses the wrong-way
// driver — hk-taxi-Q Q72) takes the BACK of the post first, any other face the
// front first, then the sides, so a "Give way | No entry" pole comes out with
// the give-way looking at the emerging traffic and the no-entry looking the
// other way, and a 3-face pole reads as a crossroad, not a 120° star.
// ⚠️ Corner poles are the ungraded part: 30 % of hosts have a second road
// within 5 m of the nearest (57 % within 25 m), and nothing in the data says
// which road a junction sign serves — compute-bearings hosts it on the nearest,
// as hk-taxi-Q does.
//
// Members of a group sit at slightly different surveyed coordinates (median
// span ~4 m — they're the drawing's label points, not the pole), so to draw a
// rigid post the build collapses every member onto one anchor: the post's POLE
// point (DTAD_TS_POLE_PT, joined by GG_NAME — the surveyed sign position, which
// is also where compute-bearings derived the facing), else the *primary's*
// (stackIndex 0) label coordinate (`anchorLng`/`anchorLat`, WGS84), and rotates
// each member by its FACE's `bearing`. Stacked members render at a COMMON WIDTH (so a wide supplementary
// plate comes out as a short wide bar, a tall warning sign stays tall — true
// plate proportions, not equal heights), which means each member's vertical
// extent differs; `stackOff` is the baked, per-member cumulative centre offset
// (source-px, the main face's top sign on the anchor, the rest hanging below
// in their own face's frame) the runtime lays each column out with. We only
// stack posts of ≥2 *catalogued* signs (uncatalogued members have no
// pictogram); a face whose members span more than SPAN_CAP is dropped — a
// guard against the handful of pathological GG_NAMEs reused kilometres apart.

import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AGAINST_TRAFFIC_CODES, RAW_DIR } from './sign-layers.mjs'
import { attrRx, memberRx, parsePolePoints, ptPosRx, reprojectPoints } from './geo.mjs'

const SPAN_CAP = 15 // metres — above this the GG_NAME isn't a real co-located assembly
// Pole points closer than this are one physical pole (co-located faces sit at
// identical or sub-decimetre-identical coordinates; unrelated poles are metres apart).
const POLE_MERGE = 0.3 // metres
// Bearing offsets a face may take from the POST facing, in order of preference;
// each face takes the first not yet used by an earlier face. Signs on a
// junction pole face along the road axes, so the choices are the front, the
// back and the two sides (quarter turns), never an even 360°/n fan. A face that
// speaks to traffic already on the road wants the front; a no-entry face
// (AGAINST_TRAFFIC_CODES) wants the back. Posts never exceed 4 faces.
const FORWARD_TURNS = [0, 180, 90, 270]
const AGAINST_TURNS = [180, 90, 270, 0]
const againstTraffic = new Set(AGAINST_TRAFFIC_CODES)

// Stacked plates are re-rendered to this common WIDTH (px) by gen-stacked-icons,
// so within a post every plate is the same width and its height follows its true
// aspect. We bake the layout offsets in that same source space here.
const COMMON_WIDTH = 120 // px — must match gen-stacked-icons' resize width
const STACK_GAP = 10 // px gap between stacked plates (source space)
// Quantize each baked offset to this grid so the runtime can resolve it with a
// finite `match` (icon-offset can't construct [0, value] from a scalar). Must
// match OFFSET_STEP in app/components/TrafficMap.vue (duplicated per the
// two-runtime rule — scripts/ and app/ never cross-import).
const OFFSET_STEP = 8 // px

const ABV_GML = join(RAW_DIR, 'DTAD_TS_ABV_PT.gml')
const POLE_GML = join(RAW_DIR, 'DTAD_TS_POLE_PT.gml')
const FACE_BEARINGS = join(RAW_DIR, '_face_bearings.json')
const POLE_ANCHORS = join(RAW_DIR, '_pole_anchors.json')
const CATALOGUE = join('app', 'data', 'signCatalogue.json')
const SIGNS_DIR = join('public', 'signs')
const OUT = join(RAW_DIR, '_sign_stacks.json')
const GROUPS_OUT = join('app', 'data', 'signGroups.json')

// Top-of-post → bottom-of-post ordering. Supplementary plates always sit
// under the main signs (the cardinal rule); the rest follow the Index-Plan
// importance order, with SIGNID as a stable tiebreak.
const RANK = { regulatory: 0, warning: 1, informatory: 2, temporary: 3, supplementary: 9 }

const catalogue = JSON.parse(await readFile(CATALOGUE, 'utf8'))
// { FEATUREID: [postFacingDeg, source] } — see compute-bearings.mjs; only the
// facing is used here (the source flag rides into the tiles from build-tiles).
const faceBearings = JSON.parse(await readFile(FACE_BEARINGS, 'utf8'))
const postFacing = fid => faceBearings[fid]?.[0]
// { GG_NAME: [lng, lat] } — every sign-hosting pole, already reprojected by
// compute-bearings; a pole-anchored post reads its WGS84 anchor from here.
const poleAnchors = JSON.parse(await readFile(POLE_ANCHORS, 'utf8'))

// Pictogram pixel dimensions per SIGNID, read straight from the PNG IHDR header
// (width bytes 16-19, height 20-23, big-endian) — no decode needed. Most are
// 120 px tall but a handful of very wide signs are shorter, so we read both to
// get each plate's true aspect for the common-width height/offset maths below.
const dimsCache = new Map()
function picDims(signid) {
  let d = dimsCache.get(signid)
  if (d) return d
  d = { w: 120, h: 120 }
  try {
    const buf = readFileSync(join(SIGNS_DIR, `${signid}.png`))
    d = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch { /* missing pictogram → keep 120×120 */ }
  dimsCache.set(signid, d)
  return d
}
// A plate's height once re-rendered to COMMON_WIDTH (its true aspect).
const plateHeight = (signid) => {
  const { w, h } = picDims(signid)
  return COMMON_WIDTH * h / w
}

// --- Parse ABV_PT: FEATUREID, GG_NAME, SIGNID, HK1980 position ---
console.log(`Reading ${ABV_GML}…`)
const abvText = await readFile(ABV_GML, 'utf8')
const fidRx = attrRx('FEATUREID', 'int')
const ggRx = attrRx('GG_NAME', 'string')
const signidRx = attrRx('SIGNID', 'string')

const groups = new Map() // GG_NAME → [{ fid, signid, group, rank, tier, x, y }]
let parsed = 0
for (const m of abvText.matchAll(memberRx)) {
  const body = m[1]
  const fid = body.match(fidRx)?.[1]
  const gg = body.match(ggRx)?.[1]?.trim()
  const signid = body.match(signidRx)?.[1]?.trim()
  const pos = body.match(ptPosRx)
  if (!fid || !pos) continue
  parsed++
  // Only catalogued signs render a pictogram, so only they can be stacked.
  // Ungrouped signs (empty GG_NAME) are never part of an assembly.
  const entry = signid ? catalogue[signid] : undefined
  if (!gg || !entry) continue
  let arr = groups.get(gg)
  if (!arr) groups.set(gg, arr = [])
  arr.push({ fid, signid, group: entry.group, rank: RANK[entry.group] ?? 5, tier: entry.tier ?? 0, x: +pos[1], y: +pos[2] })
}
console.log(`  ${parsed} ABV_PT features, ${groups.size} GG_NAME groups with catalogued members`)

// --- Parse POLE_PT: GG_NAME → HK1980 pole position (groups with signs only) ---
console.log(`Reading ${POLE_GML}…`)
const poleByGroup = parsePolePoints(await readFile(POLE_GML, 'utf8'), gg => groups.has(gg))
console.log(`  ${poleByGroup.size} of those groups have a pole point`)

// --- Merge groups whose pole points coincide into one post (its faces) ---
const cellOf = (x, y) => `${Math.floor(x)}|${Math.floor(y)}`
const poleCells = new Map() // 1 m cell → [GG_NAME, …]
for (const [gg, { x, y }] of poleByGroup) {
  const k = cellOf(x, y)
  let c = poleCells.get(k)
  if (!c) poleCells.set(k, c = [])
  c.push(gg)
}
const assigned = new Set()
const posts = [] // [GG_NAME, …] per physical pole — one entry for the common single-face case
for (const gg of groups.keys()) {
  if (assigned.has(gg)) continue
  const faces = [gg]
  assigned.add(gg)
  const p = poleByGroup.get(gg)
  if (p) {
    const cx = Math.floor(p.x), cy = Math.floor(p.y)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of poleCells.get(`${cx + dx}|${cy + dy}`) ?? []) {
          if (assigned.has(other)) continue
          const q = poleByGroup.get(other)
          if (Math.hypot(q.x - p.x, q.y - p.y) > POLE_MERGE) continue
          faces.push(other)
          assigned.add(other)
        }
      }
    }
  }
  posts.push(faces)
}

// --- Lay out each post: face order, per-face bearing, stack order + offsets ---
// Every member of a post shares its anchor. A pole-anchored post's WGS84 anchor
// comes from compute-bearings' `_pole_anchors.json`; only the posts with no
// pole (anchored on their primary's label point) go through gdaltransform here,
// deduped into `anchors` so each is reprojected once.
const records = [] // { fid, i, size, picW, anchor: [lng, lat] | null, anchorIdx, bearing, off, tier, stackId }
const anchors = [] // [[x, y], …] EPSG:2326, unique per label-anchored post
const anchorIndex = new Map() // "x y" → index into `anchors`
const groupIndex = new Map() // SIGNID → Set(stackId), stacked posts only
let stacked = 0, multiFace = 0, skippedSpan = 0, maxSize = 0, maxFaces = 0, maxOff = 0
for (const faceNames of posts) {
  const faces = []
  for (const gg of faceNames) {
    const members = groups.get(gg)
    const span = Math.max(
      Math.max(...members.map(m => m.x)) - Math.min(...members.map(m => m.x)),
      Math.max(...members.map(m => m.y)) - Math.min(...members.map(m => m.y))
    )
    if (span > SPAN_CAP) {
      skippedSpan++
      continue
    }
    members.sort((a, b) => a.rank - b.rank || a.signid.localeCompare(b.signid))
    faces.push({ gg, members })
  }
  const size = faces.reduce((s, f) => s + f.members.length, 0)
  if (size < 2) continue // a lone sign renders at its own point, untouched
  // Face 0 is the forward face (if any) whose top sign ranks highest: its
  // primary sits on the anchor, the whole post is sized by its tier, and its
  // GG_NAME names the post. No-entry faces sort after every forward face so the
  // anchor plate is the sign that reads with the post facing.
  const isAgainst = face => againstTraffic.has(face.members[0].signid)
  faces.sort((a, b) =>
    Number(isAgainst(a)) - Number(isAgainst(b))
    || a.members[0].rank - b.members[0].rank
    || a.members[0].signid.localeCompare(b.members[0].signid)
    || a.gg.localeCompare(b.gg)
  )
  const primary = faces[0].members[0]
  const multi = faces.length > 1
  maxSize = Math.max(maxSize, size)
  maxFaces = Math.max(maxFaces, faces.length)
  // Anchor on the physical pole whenever the post has one (every face of a
  // pole shares it, and it is where the facing was derived); only a post with
  // no pole record keeps its primary's label point.
  const anchor = poleAnchors[faces[0].gg] ?? null
  let ai = -1
  if (!anchor) {
    const key = `${primary.x} ${primary.y}`
    ai = anchorIndex.get(key) ?? -1
    if (ai === -1) {
      ai = anchors.length
      anchorIndex.set(key, ai)
      anchors.push([primary.x, primary.y])
    }
  }
  // The POST facing: the primary's, else any member's (every member of a post
  // was hosted at the same pole, so they agree unless one is missing). A
  // multi-face post with no bearing at all still turns its faces apart from 0
  // (upright), so the faces never draw on top of each other; a single-face
  // post without one stays null → upright at runtime (no FACE_BEARING) — unless it
  // is a no-entry face, which then turns to 180 so it still reads as opposed to
  // its neighbours.
  const raw = postFacing(primary.fid)
    ?? faces.flatMap(f => f.members).map(m => postFacing(m.fid)).find(b => b !== undefined)
    ?? null
  const base = raw ?? (multi || isAgainst(faces[0]) ? 0 : null)
  // The whole post is sized as one unit by its primary's tier (so every member
  // shares one icon-size at runtime → the width-normalized plates keep their
  // real-life height ratio; see TrafficMap's sign-stack layer).
  const tier = primary.tier
  const stackId = faces[0].gg
  // Each face takes the first turn its kind prefers that no earlier face took
  // (forward: front, back, sides; no-entry: back, sides, front).
  const taken = new Set()
  const turnFor = (face) => {
    const turn = (isAgainst(face) ? AGAINST_TURNS : FORWARD_TURNS).find(t => !taken.has(t))
    taken.add(turn)
    return turn
  }
  // Lay each face's column out in the common-width source space: each plate is
  // COMMON_WIDTH wide and `COMMON_WIDTH × picH / picW` tall (its true aspect).
  // Face 0's top sign is centred on the anchor and the rest hang below it. Every
  // other face hangs along ITS OWN bearing (the offset rides icon-rotate at
  // runtime), starting just past face 0's top plate so it clears the anchor
  // plate whichever way it points. Offsets quantize to the runtime's grid.
  const h0 = plateHeight(primary.signid)
  let index = 0
  faces.forEach((face, k) => {
    const turn = turnFor(face)
    const bearing = base === null
      ? null
      : Math.round(((base + turn) % 360) * 10) / 10
    let cursor = k === 0 ? 0 : h0 / 2 // bottom edge of the last placed plate, source-px past the anchor
    face.members.forEach((m, i) => {
      const { w } = picDims(m.signid)
      const ph = plateHeight(m.signid)
      const center = (k === 0 && i === 0) ? 0 : cursor + STACK_GAP + ph / 2
      cursor = center + ph / 2
      const off = Math.round(center / OFFSET_STEP) * OFFSET_STEP
      maxOff = Math.max(maxOff, off)
      records.push({ fid: m.fid, i: index++, size, picW: w, anchor, anchorIdx: ai, bearing, off, tier, stackId })
    })
    // Index each distinct SIGNID on this post → its stackId, so the runtime can
    // expand a sign-ID filter to the whole post (dedup signids repeated on one
    // face — two identical plates shouldn't list the post twice).
    for (const sid of new Set(face.members.map(m => m.signid))) {
      let set = groupIndex.get(sid)
      if (!set) groupIndex.set(sid, set = new Set())
      set.add(stackId)
    }
  })
  stacked++
  if (multi) multiFace++
}
console.log(`  ${stacked} posts stacked (${records.length} signs; ${multiFace} multi-face, up to ${maxFaces} faces), ${skippedSpan} faces skipped over ${SPAN_CAP}m span; tallest post ${maxSize}, max offset ${maxOff}px`)

// --- Reproject the label-point anchors EPSG:2326 → WGS84 in one pass ---
console.log(`Reprojecting ${anchors.length} label-point anchors (pole anchors come pre-projected) …`)
const wgs = anchors.length ? await reprojectPoints(anchors) : []

const out = {}
for (const r of records) {
  const [lng, lat] = r.anchor ?? wgs[r.anchorIdx]
  out[r.fid] = [r.i, r.size, r.picW, lng, lat, r.bearing, r.off, r.tier, r.stackId]
}

await writeFile(OUT, JSON.stringify(out))
console.log(`\nWrote ${OUT}`)

const groupObj = {}
for (const [sid, set] of groupIndex) groupObj[sid] = [...set]
await writeFile(GROUPS_OUT, JSON.stringify(groupObj))
console.log(`Wrote ${GROUPS_OUT} (${groupIndex.size} sign IDs → companion posts)`)
