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

// Build-time inputs beyond the sign layers: downloaded by fetch-data and read
// by compute-bearings / build-road-rules. `file` + `ext` name the on-disk file
// in RAW_DIR; `url` overrides the default `DATA_BASE_URL/file.ext` for a
// resource published elsewhere.
//
// • Road Network v2 (TD's Intelligent Road Network Package) as one FGDB zip —
//   17 MB for all 17 layers, where the per-layer GML of CENTERLINE alone is
//   486 MB. Its CENTERLINE is *directed*: TRAVEL_DIRECTION 3 = travel only in
//   the digitised direction, 1 = both ways. That direction is what makes a
//   sign's face bearing absolute (see compute-bearings.mjs). The same package
//   carries the rule-extent layers (RDNET_RULE_LAYERS below) that
//   build-road-rules.mjs tiles into the road-rules overlay archive. GDAL
//   reads the zip in place via /vsizip/.
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

// Rule-extent layers of the same FGDB, tiled by build-road-rules.mjs into the
// road-rules overlay (tippecanoe source-layer name → FGDB layer). SPEED_LIMIT,
// BUS_ONLY_LANE, NSR and PEDESTRIAN_ZONE carry their own line geometry;
// PROHIBITION is a point AT the sign that references the whole CENTERLINE route
// it governs by ROAD_ROUTE_ID, so the builder joins it onto that route's line.
// NSR is the odd one out for the street-name join: it carries no route id at
// all, naming its roads by ST_CODE_1..6 instead, so it joins CENTERLINE on
// ST_CODE (99.0 % of rows resolve) while every other layer joins on ROUTE_ID.
export const RDNET_RULE_LAYERS = {
  speed: 'SPEED_LIMIT',
  buslane: 'BUS_ONLY_LANE',
  prohibition: 'PROHIBITION',
  nsr: 'NSR',
  pedzone: 'PEDESTRIAN_ZONE'
}
// Who a prohibition addresses, derived per row from INC_VEH_TYPE + the REMARKS
// head token (`<who> Proh/ E <exceptions>`); one tile feature per row × kind so
// the runtime legend rows are plain `kind` filters. `other` catches every row
// the rules below don't classify, so nothing is silently dropped. Duplicated
// in app/composables/useRoadRules.ts per the two-runtime rule.
export const PROHIBITION_KINDS = ['plb', 'ld', 'gv', 'all', 'other']
// Turn bans (edge → edge movements, by CENTERLINE OBJECTID), read only to
// derive the cut-off layer below.
export const RDNET_TURN_LAYER = 'TURN'
// The one DERIVED source-layer in the road-rules archive (road-cutoff.mjs):
// roads a vehicle class cannot enter at all because TD's prohibitions and turn
// bans close every way in. Not an FGDB layer, so kept out of RDNET_RULE_LAYERS.
// `CUTOFF_VEHICLE` is the class it is computed for — one public light bus row,
// since green minibuses run on "PLB Proh" roads under route permits and a
// green-minibus layer would contradict the routes riders see.
export const CUTOFF_LAYER = 'cutoff'
export const CUTOFF_VEHICLE = 'PLB'

// NSR (no-stopping restrictions) codes its three descriptive fields as small
// integers, where BUS_ONLY_LANE prints free text — so unlike every other rule
// layer these need the dataspec's tables (rdnet_dataspec.zip §7) to mean
// anything. Each maps to a slug the runtime expands via i18n, per the
// "tile props are lean, words are the runtime's job" rule; an unmapped code
// falls to the catch-all rather than being dropped, as with PROHIBITION_KINDS.
//
// VEHICLE_TYPE deliberately maps onto TD's OWN vehicle codes (the vocabulary
// INC_VEH_TYPE already uses on the prohibition layer), so the runtime reuses
// one set of vehicle translations for both layers instead of gaining a second.
// Territory-wide tallies, as a tripwire for a future TD refresh:
//   ALL 13,367 · OTH 5,198 · PLB 949 · GV 410 · TX 122
export const NSR_VEHICLE_TYPES = { 1: 'ALL', 2: 'TX', 3: 'PLB', 4: 'GV', 5: 'OTH' }
// 1 24 hours · 2 8am-10am and 5pm-7pm · 3 7am-7pm · 4 7am-midnight · 5 others
export const NSR_TIME_ZONES = { 1: '24h', 2: 'peaks', 3: 'day', 4: 'late', 5: 'other' }
// 1 all days · 2 all days except Sundays and PH · 3 Sundays and PH · 4 others
export const NSR_EFFECTIVE_DAYS = { 1: 'all', 2: 'exc-sun-ph', 3: 'sun-ph', 4: 'other' }

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
export const OUTPUT_PMTILES_RULES = 'public/data/road-rules.pmtiles'
export const TILE_LAYER = 'signs'
// The cache-buster hashes the app imports (`?v=<hash>` on each archive URL).
// Both build-tiles and build-road-rules write their own key into it by
// read-merge-write (mergeTilesVersion in geo.mjs), so neither clobbers the other.
export const TILES_VERSION_FILE = 'app/data/tilesVersion.json'
