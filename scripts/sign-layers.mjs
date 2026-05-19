// Traffic-sign feature classes from the HK TD "Traffic Aids Drawings (2nd
// generation)" dataset that this viewer covers. The full dataset has ~50
// classes (road markings, traffic lights, railings, tactile paths, levels…);
// we deliberately scope to sign poles and sign faces only.
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
  { file: 'DTAD_PS_ANNO_PT', category: 'tourist-sign', geometry: 'point', label: 'Tourist sign' },
  { file: 'DTAD_TS_FILLED', category: 'traffic-sign-face', geometry: 'polygon', label: 'Traffic sign face' },
  { file: 'DTAD_PS_FILLED', category: 'pedestrian-sign-face', geometry: 'polygon', label: 'Pedestrian sign face' },
  { file: 'DTAD_DS_FILLED', category: 'directional-sign-face', geometry: 'polygon', label: 'Directional sign face' }
]

export const DATA_BASE_URL = 'https://static.data.gov.hk/td/traffic-aids-drawings-v2'

// HK TD spatial data is published in HK1980 Grid (EPSG:2326). Web maps need
// WGS84 (EPSG:4326); ogr2ogr reprojects with these in build-tiles.mjs.
export const SOURCE_SRS = 'EPSG:2326'
export const TARGET_SRS = 'EPSG:4326'

export const RAW_DIR = 'data/raw'
export const OUTPUT_PMTILES = 'public/data/traffic-signs.pmtiles'
export const TILE_LAYER = 'signs'
