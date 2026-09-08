// Traffic-sign feature classes from the HK TD "Traffic Aids Drawings (2nd
// generation)" dataset that this viewer covers. The full dataset has ~50
// classes (road markings, traffic lights, railings, tactile paths, levels…);
// we deliberately scope to sign point classes only (~316k features).
//
// `file`     base name of the resource on static.data.gov.hk (no extension)
// `category` stable key written onto every feature as a `category` property;
//            the map styles/filters off this
// `geometry` source geometry kind (point poles vs. filled sign-face polygons)
// `label`    human-readable name for the legend / filter panel

export const SIGN_LAYERS = [
  { file: 'DTAD_TS_POLE_PT', category: 'traffic-sign-pole', geometry: 'point', label: 'Traffic sign pole' },
  { file: 'DTAD_TS_ABV_PT', category: 'traffic-sign-abbreviation', geometry: 'point', label: 'Traffic sign abbreviation' },
  { file: 'DTAD_PS_POLE_PT', category: 'pedestrian-sign-pole', geometry: 'point', label: 'Pedestrian sign pole' },
  { file: 'DTAD_DS_POLE_PT', category: 'directional-sign-pole', geometry: 'point', label: 'Directional sign pole' },
  { file: 'DTAD_PS_ANNO_PT', category: 'tourist-sign', geometry: 'point', label: 'Tourist sign' }
  // The *_FILLED sign-face polygon classes are intentionally excluded: their
  // GML geometry is non-standard (CityGML solids) and GDAL cannot parse it.
  // Sign locations live in the pole/abbreviation point classes above.
]

// Build-time-only inputs: downloaded by fetch-data, consumed by
// compute-bearings, but never tiled into PMTiles. `file` + `ext` name the
// on-disk file in RAW_DIR; `url` overrides the default `DATA_BASE_URL/file.ext`
// for a resource published elsewhere.
//
// • Road Network v2 (TD's Intelligent Road Network Package) as one FGDB zip —
//   17 MB for all 17 layers, where the per-layer GML of CENTERLINE alone is
//   486 MB. Its CENTERLINE is *directed*: TRAVEL_DIRECTION 3 = travel only in
//   the digitised direction, 1 = both ways. That direction is what makes a
//   sign's face bearing absolute (see compute-bearings.mjs). GDAL reads the
//   zip in place via /vsizip/.
// • Road-marking lines (the densest road-geometry layer in the TAD set: lane
//   lines, kerb edges) stay as the fallback host for signs no centreline
//   reaches — they give a road tangent but no direction. Not tiled: ~155 MB
//   of short strokes that don't render usefully at the viewer's zooms.
export const BUILD_TIME_DATA = [
  {
    file: 'RdNet_IRNP.gdb', ext: 'zip',
    url: 'https://static.data.gov.hk/td/road-network-v2/RdNet_IRNP.gdb.zip',
    label: 'Road Network v2 (directed centrelines, for absolute face bearings)'
  },
  { file: 'DTAD_RD_MARK_LINE', ext: 'gml', label: 'Road marking line (fallback face-bearing host)' }
]
// Layer name inside the Road Network FGDB that carries the directed centrelines.
export const RDNET_CENTERLINE_LAYER = 'CENTERLINE'

// Sign codes that address the driver coming the WRONG way — the "no entry"
// family. Every other plate speaks to traffic already legally on the road and
// faces back at it; these stand at the mouth a driver must not enter by, so
// they face 180° from their post (hk-taxi-Q decision Q72: "a NO ENTRY faces the
// traffic it forbids, not the traffic it stands beside"). Applied by
// compute-stacks (post faces) and build-tiles (lone signs); the runtime never
// needs it — it only ever reads the final FACE_BEARING.
//   TS115 No entry for all vehicles · TS116 All vehicles prohibited both directions
export const AGAINST_TRAFFIC_CODES = ['TS115', 'TS116']

export const DATA_BASE_URL = 'https://static.data.gov.hk/td/traffic-aids-drawings-v2'

// HK TD spatial data is published in HK1980 Grid (EPSG:2326). Web maps need
// WGS84 (EPSG:4326); ogr2ogr reprojects with these in build-tiles.mjs.
export const SOURCE_SRS = 'EPSG:2326'
export const TARGET_SRS = 'EPSG:4326'

export const RAW_DIR = 'data/raw'
// Two archives, both built by build-tiles.mjs from the same combined input:
//   OUTPUT_PMTILES      — thinned overview (drop-densest LOD), the default
//                         source for the unfiltered category view.
//   OUTPUT_PMTILES_FULL — every point retained, abbreviation class only;
//                         the source for sign-ID filter mode so a filtered
//                         code shows its true distribution at low zoom.
// See the long comment in build-tiles.mjs for why one pyramid can't do both.
export const OUTPUT_PMTILES = 'public/data/traffic-signs.pmtiles'
export const OUTPUT_PMTILES_FULL = 'public/data/traffic-signs-full.pmtiles'
export const TILE_LAYER = 'signs'
// The cache-buster hashes the app imports (`?v=<hash>` on each archive URL).
// Both build-tiles and build-road-rules write their own key into it by
// read-merge-write (mergeTilesVersion in geo.mjs), so neither clobbers the other.
export const TILES_VERSION_FILE = 'app/data/tilesVersion.json'
