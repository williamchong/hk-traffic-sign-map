// Shared build-time helpers for the TD GML and for reprojection, used by the
// scripts that read the raw layers (compute-bearings, compute-stacks). Node
// only — app/ never imports from scripts/ (see CLAUDE.md, "Two runtimes").

import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

import { SOURCE_SRS, TARGET_SRS, TILES_VERSION_FILE } from './sign-layers.mjs'

// Abort early with an install hint when a shelled-out tool is missing.
export function requireTool(cmd, hint) {
  if (spawnSync(cmd, ['--version']).error) {
    console.error(`Missing \`${cmd}\`. Install it: ${hint}`)
    process.exit(1)
  }
}

// Stream one ogr2ogr layer as parsed GeoJSON features (`-f GeoJSONSeq` to
// stdout, one record per line; `args` is everything after that — source,
// layer, SRS, -select …). Throws after the stream drains if ogr2ogr exits
// non-zero, so the caller chooses between skip-and-warn (build-tiles) and
// abort (build-road-rules). stderr passes through live under a label so a
// GDAL warning is still visible mid-stream.
export async function* streamOgrGeoJSON(label, args) {
  const ogr = spawn('ogr2ogr', ['-f', 'GeoJSONSeq', '/vsistdout/', ...args, '-lco', 'RS=NO'])
  ogr.stderr.on('data', d => process.stderr.write(`[ogr2ogr ${label}] ${d}`))
  const closed = once(ogr, 'close')
  const rl = createInterface({ input: ogr.stdout, crlfDelay: Infinity })
  for await (const line of rl) {
    // GeoJSONSeq may prefix records with the RFC 8142 record separator
    // (0x1E); `-lco RS=NO` suppresses it but strip defensively.
    const trimmed = (line.charCodeAt(0) === 0x1e ? line.slice(1) : line).trim()
    if (trimmed) yield JSON.parse(trimmed)
  }
  const [code] = await closed
  if (code !== 0) throw new Error(`ogr2ogr failed for ${label} (exit ${code}) — is GDAL installed? (brew install gdal)`)
}

// Merge `patch` (e.g. `{ version }` or `{ rulesVersion }`) into the committed
// tilesVersion.json the app imports, keeping every other key — the sign
// archives and the road-rules archive are rebuilt by different scripts.
export async function mergeTilesVersion(patch) {
  let current = {}
  try {
    current = JSON.parse(await readFile(TILES_VERSION_FILE, 'utf8'))
  } catch {
    // first build, or an unreadable file — start fresh
  }
  await writeFile(TILES_VERSION_FILE, JSON.stringify({ ...current, ...patch }, null, 2) + '\n')
}

// TD's CityGML: one <core:cityObjectMember> per feature, generic attributes as
// <gen:{kind}Attribute name="…"><gen:value>…</gen:value>, a point as <gml:pos>.
export const memberRx = /<core:cityObjectMember>([\s\S]*?)<\/core:cityObjectMember>/g
export const ptPosRx = /<gml:pos>([-\d.]+)\s+([-\d.]+)<\/gml:pos>/
export const attrRx = (name, kind) => new RegExp(
  `<gen:${kind}Attribute name="${name}">[\\s\\S]*?<gen:value>([^<]*)<\\/gen:value>`
)

const ggRx = attrRx('GG_NAME', 'string')
const elevRx = attrRx('ELEVATION', 'string')

// DTAD_TS_POLE_PT → Map<GG_NAME, { x, y, elev }> in HK1980 metres. The pole is
// the surveyed signpost; each face's sign group carries the same GG_NAME as its
// pole point, which is the only join the sign layer has. A handful of GG_NAMEs
// list several poles (gantries) — the first wins. `keep(gg)` lets a caller skip
// groups it has no signs for. `elev` is TD's 3-char relative level ("" = at
// grade, "A01"…), kept as text.
export function parsePolePoints(gmlText, keep = () => true) {
  const poles = new Map()
  for (const m of gmlText.matchAll(memberRx)) {
    const body = m[1]
    const gg = body.match(ggRx)?.[1]?.trim()
    if (!gg || poles.has(gg) || !keep(gg)) continue
    const pos = body.match(ptPosRx)
    if (!pos) continue
    poles.set(gg, { x: parseFloat(pos[1]), y: parseFloat(pos[2]), elev: body.match(elevRx)?.[1]?.trim() ?? '' })
  }
  return poles
}

// Installed SIGNID → feature count, straight off DTAD_TS_ABV_PT.gml. Streamed
// line-by-line rather than regexed over the whole text: the file is ~206 MB and
// callers only want the tally. `SIGNID` exists on the abbreviation class alone
// (pole classes are bare posts), and its <gen:value> sits on the line after the
// attribute tag.
export async function readSignIdCounts(gmlPath) {
  const counts = new Map()
  const rl = createInterface({ input: createReadStream(gmlPath), crlfDelay: Infinity })
  let pending = false
  for await (const line of rl) {
    if (pending) {
      const v = line.match(/<gen:value>([^<]*)<\/gen:value>/)?.[1]?.trim()
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
      pending = false
    } else if (line.includes('<gen:stringAttribute name="SIGNID">')) {
      pending = true
    }
  }
  return counts
}

// The label points of every installed sign whose SIGNID is in `codes` (null =
// every sign), as
// [x, y, code] in HK1980 metres — streamed like readSignIdCounts, since the
// audit that wants them needs a few thousand points out of a 206 MB file.
// A member's <gml:pos> precedes its SIGNID attribute, so the position is held
// until the member closes.
export async function readSignPoints(gmlPath, codes) {
  const want = codes ? new Set(codes) : null
  const points = []
  const rl = createInterface({ input: createReadStream(gmlPath), crlfDelay: Infinity })
  let pos = null
  let id = null
  let pending = false
  for await (const line of rl) {
    if (line.includes('<core:cityObjectMember>')) {
      pos = null
      id = null
    }
    const m = line.match(ptPosRx)
    if (m) pos = [parseFloat(m[1]), parseFloat(m[2])]
    if (pending) {
      id = line.match(/<gen:value>([^<]*)<\/gen:value>/)?.[1]?.trim() ?? null
      pending = false
    } else if (line.includes('<gen:stringAttribute name="SIGNID">')) {
      pending = true
    }
    if (line.includes('</core:cityObjectMember>') && pos && id && (!want || want.has(id))) points.push([pos[0], pos[1], id])
  }
  return points
}

// Reproject HK1980 [x, y] pairs to WGS84 [lng, lat] (6 dp, ~0.1 m) in ONE
// gdaltransform pass. Callers dedupe their inputs first; this only pipes.
export async function reprojectPoints(points) {
  const gt = spawn('gdaltransform', ['-s_srs', SOURCE_SRS, '-t_srs', TARGET_SRS])
  let out = ''
  gt.stdout.on('data', (d) => {
    out += d
  })
  gt.stderr.on('data', () => { /* gdaltransform chatters on stderr; ignore */ })
  for (const [x, y] of points) gt.stdin.write(`${x} ${y}\n`)
  gt.stdin.end()
  const [code] = await once(gt, 'close')
  if (code !== 0) {
    console.error('gdaltransform failed — is GDAL installed? (brew install gdal)')
    process.exit(code)
  }
  return out.trim().split('\n').map((l) => {
    const [lng, lat] = l.trim().split(/\s+/).map(Number)
    return [+lng.toFixed(6), +lat.toFixed(6)]
  })
}
