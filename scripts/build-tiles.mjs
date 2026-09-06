// Reprojects every raw sign GML (HK1980 Grid → WGS84) via ogr2ogr, tags each
// feature with its `category`, and packs everything into a single vector-tile
// PMTiles archive via tippecanoe. The browser never touches the ~430 MB of raw
// GML — only the compact tiled output.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'

import {
  SIGN_LAYERS, RAW_DIR, OUTPUT_PMTILES, OUTPUT_PMTILES_FULL,
  TILE_LAYER, SOURCE_SRS, TARGET_SRS, AGAINST_TRAFFIC_CODES
} from './sign-layers.mjs'

const COMBINED = join(RAW_DIR, '_combined.geojsonl')
// A second combined stream for the overview archive. Stacked assemblies are
// rewritten so each reads as one thinnable dot below STACK_LOD_MINZOOM and a
// complete, pinned signpost above it (see the convertLayer write block). The
// full archive is built from COMBINED (no zoom hints) to keep every point at
// every zoom for the sign-ID filter.
const COMBINED_LOD = join(RAW_DIR, '_combined_lod.geojsonl')
const FACE_BEARINGS = join(RAW_DIR, '_face_bearings.json')
const POLE_ANCHORS = join(RAW_DIR, '_pole_anchors.json')
const SIGN_STACKS = join(RAW_DIR, '_sign_stacks.json')

// The zoom at which the stacked pictograms start to form the signpost
// (= TIER_LOD[0].minzoom in app/composables/useSignCatalogue.ts; duplicated
// per the two-runtime rule). Below it, the overview shows one thinnable dot
// per assembly; from it up, every member is pinned so the post is complete.
const STACK_LOD_MINZOOM = 13

// Map<FEATUREID-as-string, [postFacingDeg, source]> (source 1 = directed
// centreline, absolute; 0 = road-marking fallback, relative); populated only
// for the traffic-sign-abbreviation layer. If the bearings file is missing
// (someone runs build-tiles without compute-bearings) we silently fall through
// with no FACE_BEARING property and the runtime will leave those signs upright
// — a degraded view, not a broken build.
const faceBearings = existsSync(FACE_BEARINGS)
  ? JSON.parse(await readFile(FACE_BEARINGS, 'utf8'))
  : null
if (!faceBearings) console.warn(`No ${FACE_BEARINGS} — signs will render upright. Run \`node scripts/compute-bearings.mjs\` first.`)
// Map<GG_NAME, [lng, lat]> — the surveyed pole of every sign group that has
// one (written alongside the bearings). A lone sign is drawn there rather than
// at TD's abbreviation point, which is a label position a median 2.3 m off;
// stacked members get the same pole through _sign_stacks.json.
const poleAnchors = existsSync(POLE_ANCHORS)
  ? JSON.parse(await readFile(POLE_ANCHORS, 'utf8'))
  : null
if (!poleAnchors) console.warn(`No ${POLE_ANCHORS} — lone signs will render at their label point, not their pole.`)
// The no-entry family faces the wrong-way driver: 180° from its post (see
// sign-layers.mjs). Stacked members already carry the turned bearing from
// compute-stacks; lone signs get it here.
const againstTraffic = new Set(AGAINST_TRAFFIC_CODES)

// Map<FEATUREID-as-string, [stackIndex, size, picW, anchorLng, anchorLat,
// bearing, stackOff, primaryTier, stackId]> for signs that belong to a co-located
// signpost — one or more GG_NAME faces sharing a pole point (see
// compute-stacks.mjs). Same fall-through contract as bearings: missing file →
// signs just don't stack (render at their own point), never a broken build.
const signStacks = existsSync(SIGN_STACKS)
  ? JSON.parse(await readFile(SIGN_STACKS, 'utf8'))
  : null
if (!signStacks) console.warn(`No ${SIGN_STACKS} — signs won't stack into signposts. Run \`node scripts/compute-stacks.mjs\` first.`)

function requireTool(cmd, hint) {
  if (spawnSync(cmd, ['--version']).error) {
    console.error(`Missing \`${cmd}\`. Install it: ${hint}`)
    process.exit(1)
  }
}

// ogr2ogr streams the layer as newline-delimited GeoJSON to stdout; we inject
// `category` per feature and append to both combined files tippecanoe reads —
// `out` (full archive) and `outLod` (overview, with the per-assembly LOD zoom
// hints applied in the write block below).
async function convertLayer({ file, category }, out, outLod) {
  const src = join(RAW_DIR, `${file}.gml`)
  const ogr = spawn('ogr2ogr', [
    '-f', 'GeoJSONSeq', '/vsistdout/', src,
    '-s_srs', SOURCE_SRS, '-t_srs', TARGET_SRS,
    '-lco', 'RS=NO',
    // Don't let a handful of malformed GML geometries abort an otherwise
    // good layer — skip the bad features and keep going.
    '-skipfailures',
    '--config', 'GML_SKIP_CORRUPTED_FEATURES', 'YES'
  ])
  ogr.stderr.on('data', d => process.stderr.write(`[ogr2ogr ${file}] ${d}`))

  // Only ABV_PT features carry FACE_BEARING / stack order / a pole; checked once here.
  const isAbv = category === 'traffic-sign-abbreviation'
  const injectBearing = faceBearings && isAbv
  const injectPole = poleAnchors && isAbv
  const injectStack = signStacks && isAbv
  let count = 0, bearingsApplied = 0, stacksApplied = 0, polesApplied = 0
  const rl = createInterface({ input: ogr.stdout, crlfDelay: Infinity })
  for await (const line of rl) {
    // GeoJSONSeq may prefix records with the RFC 8142 record separator
    // (0x1E); we pass `-lco RS=NO` to suppress it but strip defensively.
    const trimmed = (line.charCodeAt(0) === 0x1e ? line.slice(1) : line).trim()
    if (!trimmed) continue
    const feature = JSON.parse(trimmed)
    feature.properties = { ...feature.properties, category }
    // FEATUREID is keyed as a string in both lookup JSONs; GeoJSON properties
    // may surface it as number or string. Coerce once and reuse.
    const fid = (injectBearing || injectStack) ? String(feature.properties.FEATUREID ?? '') : ''
    if (injectBearing) {
      const fb = faceBearings[fid]
      if (fb !== undefined) {
        const [facing, source] = fb
        // Plate facing = post facing, turned 180° for a no-entry (Q72). A stacked
        // member's is overridden below with its face's (already turned) bearing.
        const flip = againstTraffic.has(feature.properties.SIGNID) ? 180 : 0
        feature.properties.FACE_BEARING = (facing + flip) % 360
        feature.properties.FACE_ABS = source
        bearingsApplied++
      }
    }
    if (injectPole) {
      // Draw the sign at its surveyed pole; a stacked member is moved again to
      // its post anchor below (the same pole, via compute-stacks).
      const pole = poleAnchors[feature.properties.GG_NAME]
      if (pole) {
        feature.geometry.coordinates = [pole[0], pole[1]]
        polesApplied++
      }
    }
    if (injectStack) {
      const stack = signStacks[fid]
      if (stack !== undefined) {
        // Collapse the member onto its post's anchor and adopt its FACE's
        // bearing (the main face's road-derived one; the other faces of a
        // back-to-back pole are fanned apart from it), so the whole post renders
        // as one rigid signpost (see compute-stacks.mjs). STACK_INDEX marks the
        // member as stacked (the runtime swaps in the width-normalized pictogram
        // for it); STACK_OFF is its baked offset down its face's column;
        // STACK_TIER is the primary's tier, so the runtime sizes the whole post
        // as one unit and the plates keep their real-life ratio; STACK_ID names
        // the post (its main face's GG_NAME) — the runtime groups by it, since a
        // multi-face post spans several GG_NAMEs. (`size`/`picW` stay in the
        // JSON only for the build log; no tile property carries them.)
        const [index, , , anchorLng, anchorLat, bearing, stackOff, tier, stackId] = stack
        feature.geometry.coordinates = [anchorLng, anchorLat]
        feature.properties.STACK_INDEX = index
        feature.properties.STACK_OFF = stackOff
        feature.properties.STACK_TIER = tier
        feature.properties.STACK_ID = stackId
        if (bearing === null) delete feature.properties.FACE_BEARING
        else feature.properties.FACE_BEARING = bearing
        stacksApplied++
      }
    }
    const json = JSON.stringify(feature) + '\n'
    if (!out.write(json)) await once(out, 'drain')
    // Overview copy — make a co-located assembly read as ONE object when
    // zoomed out and a COMPLETE signpost once zoomed in:
    //   • z < STACK_LOD_MINZOOM: only the primary (index 0) is emitted, as a
    //     plain thinnable dot (`maxzoom` STACK_LOD_MINZOOM-1, no minzoom) — it
    //     stands in for the whole group and drop-densest thins it like any lone
    //     sign, so the overview stays uncrowded (non-primaries aren't emitted
    //     here at all).
    //   • z ≥ STACK_LOD_MINZOOM: every member is emitted with an explicit
    //     `minzoom`, which tippecanoe keeps through `--drop-densest-as-needed`
    //     (un-pinned neighbours thin instead) — so no member, least of all the
    //     primary, gets thinned out of the post mid-zoom.
    if (injectStack && feature.properties.STACK_INDEX !== undefined) {
      if (feature.properties.STACK_INDEX === 0) {
        feature.tippecanoe = { maxzoom: STACK_LOD_MINZOOM - 1 }
        if (!outLod.write(JSON.stringify(feature) + '\n')) await once(outLod, 'drain')
      }
      feature.tippecanoe = { minzoom: STACK_LOD_MINZOOM }
      if (!outLod.write(JSON.stringify(feature) + '\n')) await once(outLod, 'drain')
    } else if (!outLod.write(json)) {
      await once(outLod, 'drain')
    }
    count++
  }
  if (injectBearing) console.log(`    + FACE_BEARING on ${bearingsApplied} / ${count} (${(bearingsApplied / count * 100).toFixed(1)}%)`)
  if (injectPole) console.log(`    + ${polesApplied} / ${count} drawn at their pole`)
  if (injectStack) console.log(`    + STACK order on ${stacksApplied} / ${count} (${(stacksApplied / count * 100).toFixed(1)}%)`)

  const [code] = await once(ogr, 'close')
  if (code !== 0) throw new Error(`ogr2ogr failed for ${file} (exit ${code})`)
  console.log(`  ${category}: ${count} features`)
  return count
}

requireTool('ogr2ogr', 'brew install gdal')
requireTool('tippecanoe', 'brew install tippecanoe')

await mkdir(dirname(OUTPUT_PMTILES), { recursive: true })
await rm(COMBINED, { force: true })
await rm(COMBINED_LOD, { force: true })

const out = createWriteStream(COMBINED)
const outLod = createWriteStream(COMBINED_LOD)
let total = 0
for (const layer of SIGN_LAYERS) {
  console.log(`Reprojecting ${layer.file} …`)
  try {
    total += await convertLayer(layer, out, outLod)
  } catch (err) {
    console.warn(`  ⚠ skipping ${layer.file}: ${err.message}`)
  }
}
out.end()
outLod.end()
await Promise.all([once(out, 'finish'), once(outLod, 'finish')])

if (total === 0) {
  console.error('No features converted — aborting before tippecanoe.')
  process.exit(1)
}

async function runTippecanoe(label, args) {
  console.log(`\n${label} …`)
  const tip = spawn('tippecanoe', args, { stdio: 'inherit' })
  const [code] = await once(tip, 'close')
  if (code !== 0) process.exit(code)
}

// Flags shared by both archives. `-Z 9`: build only from the map's minZoom
// up — below z9 the viewport is locked out so those tiles are never
// requested. `-z 15`: pin the max zoom — MapLibre overzooms past it, which is
// fine for points. It used to be `-zg` (guess from feature spacing), which
// settled at 15 while every sign sat at its own label point; once signs were
// collapsed onto shared pole anchors the guess jumped to 20, tripling both
// archives with z16–20 tiles the app never requests, splitting the directory
// into leaves (an extra range request per cold tile) and re-calibrating the
// drop-densest thinning so the z11 overview came out ~30× sparser.
const COMMON = [
  '-l', TILE_LAYER,
  '-n', 'HK Traffic Signs',
  '-Z', '9',
  '-z', '15',
  '--no-tile-size-limit',
  '--quiet',
  '--force'
]

// One vector-tile pyramid can't serve both views, because tippecanoe's
// feature-dropping is filter-blind — it decides what to keep per tile
// before knowing what the user will filter on. So we build two:
//
// 1) Overview (thinned LOD) — `--drop-densest-as-needed` trims the dense
//    urban cores at low zoom into a readable, spatially representative
//    scatter; dropped features return by ~z14, so zoomed-in category views
//    stay complete. This is the default source for the unfiltered map. Built
//    from COMBINED_LOD so co-located assemblies collapse to their primary
//    below STACK_LOD_MINZOOM (one object per signpost in the thinned view).
await runTippecanoe('Building overview tiles (thinned LOD)', [
  '-o', OUTPUT_PMTILES,
  ...COMMON,
  '--drop-densest-as-needed',
  COMBINED_LOD
])

// 2) Full (retain-all) — `-r1 --no-feature-limit` keeps every point at every
//    zoom so sign-ID filter mode shows a code's true distribution at a
//    glance (default `-r 2.5` dropped ~326k features at z11; commit 5a1ad4e).
//    Restricted to the abbreviation class via `-j`: only DTAD_TS_ABV_PT
//    carries SIGNID, so poles/tourist signs — which no sign-ID filter can
//    ever match — are excluded here, roughly halving this archive.
await runTippecanoe('Building full tiles (retain-all, abbreviation only)', [
  '-o', OUTPUT_PMTILES_FULL,
  ...COMMON,
  '-r1',
  '--no-feature-limit',
  '-j', '{"*":["==","category","traffic-sign-abbreviation"]}',
  COMBINED
])

await rm(COMBINED, { force: true })
await rm(COMBINED_LOD, { force: true })

// Hash both archives together and write a tiny version file the app imports.
// The runtime appends `?v=<hash>` to each PMTiles URL so a rebuild
// invalidates the byte-range cache on returning visitors — otherwise the
// browser would stitch cached chunks of the old archive together with newly
// fetched chunks of the new one. Both archives always rebuild together, so a
// single combined hash (changes if either file's bytes change) is enough.
const hash = createHash('sha256')
hash.update(await readFile(OUTPUT_PMTILES))
hash.update(await readFile(OUTPUT_PMTILES_FULL))
const version = hash.digest('hex').slice(0, 12)
const VERSION_FILE = join('app', 'data', 'tilesVersion.json')
await writeFile(VERSION_FILE, JSON.stringify({ version }, null, 2) + '\n')

console.log(`\nDone → ${OUTPUT_PMTILES} + ${OUTPUT_PMTILES_FULL} (v${version})`)
