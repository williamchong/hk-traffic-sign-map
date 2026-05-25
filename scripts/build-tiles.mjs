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
  TILE_LAYER, SOURCE_SRS, TARGET_SRS
} from './sign-layers.mjs'

const COMBINED = join(RAW_DIR, '_combined.geojsonl')
const FACE_BEARINGS = join(RAW_DIR, '_face_bearings.json')
const SIGN_STACKS = join(RAW_DIR, '_sign_stacks.json')

// Map<FEATUREID-as-string, faceBearingDegrees>; populated only for the
// traffic-sign-abbreviation layer. If the bearings file is missing (someone
// runs build-tiles without compute-bearings) we silently fall through with
// no FACE_BEARING property and the runtime will leave those signs upright —
// a degraded view, not a broken build.
const faceBearings = existsSync(FACE_BEARINGS)
  ? JSON.parse(await readFile(FACE_BEARINGS, 'utf8'))
  : null
if (!faceBearings) console.warn(`No ${FACE_BEARINGS} — signs will render upright. Run \`node scripts/compute-bearings.mjs\` first.`)

// Map<FEATUREID-as-string, [stackIndex, stackSize]> for signs that belong to a
// co-located GG_NAME assembly (see compute-stacks.mjs). Same fall-through
// contract as bearings: missing file → signs just don't stack (render at their
// own point), never a broken build.
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
// `category` per feature and append to the combined file that tippecanoe reads.
async function convertLayer({ file, category }, out) {
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

  // Only ABV_PT features carry FACE_BEARING / stack order; checked once here.
  const isAbv = category === 'traffic-sign-abbreviation'
  const injectBearing = faceBearings && isAbv
  const injectStack = signStacks && isAbv
  let count = 0, bearingsApplied = 0, stacksApplied = 0
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
      const bearing = faceBearings[fid]
      if (bearing !== undefined) {
        feature.properties.FACE_BEARING = bearing
        bearingsApplied++
      }
    }
    if (injectStack) {
      const stack = signStacks[fid]
      if (stack !== undefined) {
        // Only the stack index is shipped — that's all the runtime icon-offset
        // needs, and MVT can't store the [index, size] array anyway. `size`
        // stays in the JSON for the build log; no tile property carries it.
        feature.properties.STACK_INDEX = stack[0]
        stacksApplied++
      }
    }
    if (!out.write(JSON.stringify(feature) + '\n')) await once(out, 'drain')
    count++
  }
  if (injectBearing) console.log(`    + FACE_BEARING on ${bearingsApplied} / ${count} (${(bearingsApplied / count * 100).toFixed(1)}%)`)
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

const out = createWriteStream(COMBINED)
let total = 0
for (const layer of SIGN_LAYERS) {
  console.log(`Reprojecting ${layer.file} …`)
  try {
    total += await convertLayer(layer, out)
  } catch (err) {
    console.warn(`  ⚠ skipping ${layer.file}: ${err.message}`)
  }
}
out.end()
await once(out, 'finish')

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
// requested. `-zg`: auto-pick the max zoom from feature density.
const COMMON = [
  '-l', TILE_LAYER,
  '-n', 'HK Traffic Signs',
  '-Z', '9',
  '-zg',
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
//    stay complete. This is the default source for the unfiltered map.
await runTippecanoe('Building overview tiles (thinned LOD)', [
  '-o', OUTPUT_PMTILES,
  ...COMMON,
  '--drop-densest-as-needed',
  '--extend-zooms-if-still-dropping',
  COMBINED
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
