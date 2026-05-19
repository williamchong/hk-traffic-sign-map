// Reprojects every raw sign GML (HK1980 Grid → WGS84) via ogr2ogr, tags each
// feature with its `category`, and packs everything into a single vector-tile
// PMTiles archive via tippecanoe. The browser never touches the ~430 MB of raw
// GML — only the compact tiled output.

import { mkdir, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'

import {
  SIGN_LAYERS, RAW_DIR, OUTPUT_PMTILES, TILE_LAYER, SOURCE_SRS, TARGET_SRS
} from './sign-layers.mjs'

const COMBINED = join(RAW_DIR, '_combined.geojsonl')

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
    '-lco', 'RS=NO'
  ])
  ogr.stderr.on('data', d => process.stderr.write(`[ogr2ogr ${file}] ${d}`))

  let count = 0
  const rl = createInterface({ input: ogr.stdout, crlfDelay: Infinity })
  for await (const line of rl) {
    // GeoJSONSeq may prefix records with the RFC 8142 record separator
    // (0x1E); we pass `-lco RS=NO` to suppress it but strip defensively.
    const trimmed = (line.charCodeAt(0) === 0x1e ? line.slice(1) : line).trim()
    if (!trimmed) continue
    const feature = JSON.parse(trimmed)
    feature.properties = { ...feature.properties, category }
    if (!out.write(JSON.stringify(feature) + '\n')) await once(out, 'drain')
    count++
  }

  const [code] = await once(ogr, 'close')
  if (code !== 0) throw new Error(`ogr2ogr failed for ${file} (exit ${code})`)
  console.log(`  ${category}: ${count} features`)
}

requireTool('ogr2ogr', 'brew install gdal')
requireTool('tippecanoe', 'brew install tippecanoe')

await mkdir(dirname(OUTPUT_PMTILES), { recursive: true })
await rm(COMBINED, { force: true })

const out = createWriteStream(COMBINED)
for (const layer of SIGN_LAYERS) {
  console.log(`Reprojecting ${layer.file} …`)
  await convertLayer(layer, out)
}
out.end()
await once(out, 'finish')

console.log('\nBuilding vector tiles with tippecanoe …')
const tip = spawn('tippecanoe', [
  '-o', OUTPUT_PMTILES,
  '-l', TILE_LAYER,
  '-n', 'HK Traffic Signs',
  '-zg', // pick max zoom automatically from feature density
  '--drop-densest-as-needed', // thin dense areas at low zoom, keep them fast
  '--extend-zooms-if-still-dropping',
  '--no-tile-size-limit',
  '--quiet', // suppress per-tile progress spam
  '--force',
  COMBINED
], { stdio: 'inherit' })

const [tipCode] = await once(tip, 'close')
if (tipCode !== 0) process.exit(tipCode)
await rm(COMBINED, { force: true })
console.log(`\nDone → ${OUTPUT_PMTILES}`)
