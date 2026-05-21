// Reprojects every raw sign GML (HK1980 Grid → WGS84) via ogr2ogr, tags each
// feature with its `category`, and packs everything into a single vector-tile
// PMTiles archive via tippecanoe. The browser never touches the ~430 MB of raw
// GML — only the compact tiled output.

import { mkdir, readFile, rm } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'

import {
  SIGN_LAYERS, RAW_DIR, OUTPUT_PMTILES, TILE_LAYER, SOURCE_SRS, TARGET_SRS
} from './sign-layers.mjs'

const COMBINED = join(RAW_DIR, '_combined.geojsonl')
const FACE_BEARINGS = join(RAW_DIR, '_face_bearings.json')

// Map<FEATUREID-as-string, faceBearingDegrees>; populated only for the
// traffic-sign-abbreviation layer. If the bearings file is missing (someone
// runs build-tiles without compute-bearings) we silently fall through with
// no FACE_BEARING property and the runtime will leave those signs upright —
// a degraded view, not a broken build.
const faceBearings = existsSync(FACE_BEARINGS)
  ? JSON.parse(await readFile(FACE_BEARINGS, 'utf8'))
  : null
if (!faceBearings) console.warn(`No ${FACE_BEARINGS} — signs will render upright. Run \`node scripts/compute-bearings.mjs\` first.`)

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

  // Only ABV_PT features get a FACE_BEARING; checked once outside the loop.
  const injectBearing = faceBearings && category === 'traffic-sign-abbreviation'
  let count = 0, bearingsApplied = 0
  const rl = createInterface({ input: ogr.stdout, crlfDelay: Infinity })
  for await (const line of rl) {
    // GeoJSONSeq may prefix records with the RFC 8142 record separator
    // (0x1E); we pass `-lco RS=NO` to suppress it but strip defensively.
    const trimmed = (line.charCodeAt(0) === 0x1e ? line.slice(1) : line).trim()
    if (!trimmed) continue
    const feature = JSON.parse(trimmed)
    feature.properties = { ...feature.properties, category }
    if (injectBearing) {
      // FEATUREID is keyed as a string in the bearings JSON; GeoJSON
      // properties may surface it as number or string. Coerce once.
      const fid = String(feature.properties.FEATUREID ?? '')
      const bearing = faceBearings[fid]
      if (bearing !== undefined) {
        feature.properties.FACE_BEARING = bearing
        bearingsApplied++
      }
    }
    if (!out.write(JSON.stringify(feature) + '\n')) await once(out, 'drain')
    count++
  }
  if (injectBearing) console.log(`    + FACE_BEARING on ${bearingsApplied} / ${count} (${(bearingsApplied / count * 100).toFixed(1)}%)`)

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

console.log('\nBuilding vector tiles with tippecanoe …')
const tip = spawn('tippecanoe', [
  '-o', OUTPUT_PMTILES,
  '-l', TILE_LAYER,
  '-n', 'HK Traffic Signs',
  // Build only from the map's minZoom up. Below z9 the viewport is locked
  // out, so those tiles would never be requested. Auto-picks the max from
  // feature density (-zg).
  '-Z', '9',
  '-zg',
  // Retain every point at every zoom. Default `-r 2.5` drops ~326k
  // features at z11 (visible in the archive's `strategies` metadata),
  // which broke the sign-id filter's distribution-at-a-glance view —
  // unfiltered tiles "looked" complete because survivors were spatially
  // representative, but filtered tiles only contained whichever IDs
  // happened to win the drop lottery.
  '-r1',
  '--no-feature-limit',
  '--no-tile-size-limit',
  '--quiet',
  '--force',
  COMBINED
], { stdio: 'inherit' })

const [tipCode] = await once(tip, 'close')
if (tipCode !== 0) process.exit(tipCode)
await rm(COMBINED, { force: true })
console.log(`\nDone → ${OUTPUT_PMTILES}`)
