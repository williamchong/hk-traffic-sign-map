<script setup lang="ts">
import type { Map as MaplibreMap, ExpressionSpecification, FilterSpecification, MapGeoJSONFeature, GeoJSONFeature, GeoJSONSource, LineLayerSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { CATEGORY_FALLBACK_COLOR, categoryColorStops } from '~/composables/useSignCategories'
import { TIER_LOD, SIGN_FIRST_SIZE, codesByTier, categoryKeyExpr, categoryKeyOf, plateSizeFactorExpr } from '~/composables/useSignCatalogue'
import type { FilterMode, SelectedSign } from '~/composables/useTrafficLayers'
import {
  RULE_SOURCE, SIGN_RULE_LINKS, SIGN_RULE_RADIUS_M, CUTOFF_COLOR, ruleColor,
  speedColorStops, prohibitionColorStops, nsrColorStops, type RuleLayer, type SignRuleLink
} from '~/composables/useRoadRules'
import { pointToLineMetres } from '~/utils/geo'
import tilesVersion from '~/data/tilesVersion.json'

// maplibre-gl touches `window` at import time and is large; it's
// dynamically imported inside onMounted so it never enters the SSR pass
// and is code-split out of the initial bundle.
let detachProtocol: (() => void) | undefined

const { mapFilter, selectedSign, selectedGroup, mapUnavailable, filterMode, loadGroupIndex } = useTrafficLayers()
const { rulesEnabled, enabledKinds, isRowEnabled, selectedRule, governingRule } = useRoadRules()
const colorMode = useColorMode()
const { track } = useAnalytics()

// Two PMTiles archives (built by scripts/build-tiles.mjs): a thinned LOD
// overview and a retain-all full set. The sign layers read whichever one the
// active filter mode wants — category/overview gets the thinned scatter,
// sign-ID filter gets every point so a code's true distribution shows at low
// zoom. One pyramid can't do both because tippecanoe's drop is filter-blind.
const SOURCE_LOD = 'signs-lod'
const SOURCE_FULL = 'signs-full'
type SignSource = typeof SOURCE_LOD | typeof SOURCE_FULL
const SOURCE_LAYER = 'signs' // tippecanoe layer name, same in both archives
const sourceForMode = (mode: FilterMode): SignSource => mode === 'sign-id' ? SOURCE_FULL : SOURCE_LOD

// Hong Kong, centred so most signed road network is in view on load.
const HK_CENTER: [number, number] = [114.155, 22.34]
// Lock the viewport to HK — also caps the basemap/tile working set.
const HK_BOUNDS: [[number, number], [number, number]] = [[113.80, 22.13], [114.45, 22.58]]
// Map max zoom; also the upper anchor of the per-tier icon-size ramp so the
// "proper" sign height is reached exactly at full zoom-in.
const MAX_ZOOM = 19

const OSM_ATTRIB = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
// CARTO Basemaps key for the dark raster tiles: without it every tile is
// stamped "API KEY REQUIRED". A tile key is public by design — it rides on
// every tile request — so it sits here rather than in an env var, which the
// static GitHub Pages deploy has no secrets step to fill anyway.
const CARTO_KEY = 'cb1_2y7w_1_240b0b843b318318c4f7eef1'

const container = ref<HTMLDivElement>()
const map = shallowRef<MaplibreMap>()

// Colour each feature by its resolved sign-class key (catalogued group, or
// tile category for tourist / uncatalogued), falling back to grey. Spreading
// a string[] defeats maplibre's tuple typing, so widen through `unknown`.
const categoryColor = [
  'match', categoryKeyExpr,
  ...categoryColorStops,
  CATEGORY_FALLBACK_COLOR
] as unknown as ExpressionSpecification

// maplibre's tuple typing rejects spread/dynamic expressions that are valid at
// runtime; this is the one documented place we widen through `unknown`.
const expr = (e: unknown) => e as ExpressionSpecification

// FACE_BEARING is the way the plate faces (its outward normal, toward the
// drivers who read it), computed at build time by scripts/compute-bearings.mjs
// and rotated here so the pictogram's top points the OPPOSITE way — the plan
// view draws the plate as if tipped flat onto the map, and a vertical plate
// tipped BACKWARD (away from the traffic it addresses) lands face-up with its
// top edge behind it. So `icon-rotate` is FACE_BEARING + 180: a plate facing
// south reads upright on a north-up map, which is also what its driver sees,
// since they travel at FACE_BEARING + 180. Rotating by the bearing itself
// tips the plate FORWARD instead — that buries the face in the ground and
// draws the artwork upside down for everyone who can actually read the sign
// (a southbound "EXPRESSWAY" plate came out mirrored). The sign's POLE is
// snapped to the nearest Road Network v2 centreline, which is *directed*, so
// with the kerb side and drive-on-the-left the facing is absolute: on a
// one-way edge both kerbs face back against the flow, on a two-way edge the
// nearside kerb faces back and the offside faces along it (hk-taxi-Q's
// `facing_from_side`). A "no entry" (TS115/TS116) speaks to the wrong-way
// driver and is turned 180° from its post. TD's raw `ANGLE` looked like it
// should fill this role but is the MicroStation label rotation (commit
// 42c343a), unrelated to the road.
//
// Coverage is ~98 % of the 178k signs; ~1 % fall back to the old road-marking
// tangent (relative only — FACE_ABS 0) and ~1 % (off-network piers, gantries)
// have no FACE_BEARING and take the rotation's 0 arm → upright. Nothing
// publishes a facing to grade this against, and a corner pole 5.7 m from one
// street and 5.8 m from the other is hosted on the nearest — the known weak
// spot (see CLAUDE.md, pipeline step 2).
//
// Stacked post members carry their FACE's bearing: compute-stacks gives each
// face a quarter turn from the post facing by meaning — a forward face takes
// the front, a no-entry face the back, further faces the sides — so "Give
// way" and "No entry" on one pole point opposite ways instead of sharing a
// rotation.
//
// `icon-rotation-alignment: 'map'` keeps the bearing geo-aligned through
// map rotation — without it the rotation would lock to the viewport and the
// orientation cue would be meaningless.
const iconRotation = {
  // The +180 rides INSIDE the has-check, never after a `coalesce` to 0: a sign
  // with no bearing must stay upright, not be turned upside down.
  'icon-rotate': expr([
    'case', ['has', 'FACE_BEARING'], ['+', ['get', 'FACE_BEARING'], 180], 0
  ]),
  'icon-rotation-alignment': 'map' as const
}

// Signs sharing a post (STACK_ID — one or more GG_NAME faces on one pole
// point) are stacked into a vertical signpost. Each plate is re-rendered to a
// common WIDTH (see /signs-stacked + the icon-image below), so heights vary by
// true aspect — a wide supplementary plate becomes a short wide bar, a tall
// sign stays tall. compute-stacks.mjs bakes each member's cumulative centre
// offset down its face's column into STACK_OFF (icon source-px, quantized to
// OFFSET_STEP; the main face's top sign on the anchor, the rest below).
// `icon-offset` can't construct [0, value] from a scalar, so we enumerate a
// fixed grid of `match` arms (value → [0, value]); a member's baked STACK_OFF
// always lands on one. The offset is in icon source-px, so it scales with
// `icon-size` (the column stays proportional at every zoom — the icon-size
// factor cancels out of the spacing) and rides `icon-rotate`, so each member's
// column hangs along its own FACE_BEARING: a back-to-back pole's faces (fanned
// apart at build time, their offsets starting past the anchor plate) read as
// columns pointing away from the anchor in different directions, not one
// column. Non-stacked signs have no STACK_OFF → the [0, 0] default.
// OFFSET_STEP must match scripts/compute-stacks.mjs (duplicated per the
// two-runtime rule); OFFSET_MAX has headroom over the tallest post
// (compute-stacks logs it) — a larger offset falls to [0, 0] rather than error.
const OFFSET_STEP = 8
const OFFSET_MAX = 2000
// `icon-offset` = [0, <prop>] over a fixed grid of `step` px up to `max`;
// a value off the grid falls to [0, 0] rather than error.
const offsetGrid = (prop: string, step: number, max: number) => expr([
  'match', ['get', prop],
  ...Array.from(
    { length: max / step + 1 },
    (_, k) => [k * step, ['literal', [0, k * step]]]
  ).flat(),
  ['literal', [0, 0]]
])
const stackOffset = offsetGrid('STACK_OFF', OFFSET_STEP, OFFSET_MAX)

// Facing mark for the *selected* sign: a rotationally symmetric pictogram (a
// plain roundel, a circular "no stopping") gives no clue which way its top —
// i.e. its FACE_BEARING — points once rotated, so the highlight underlines
// the plate. The bar sits just past the pictogram's bottom edge and rides the
// same `icon-rotate`/`icon-size` as the plate, so it reads as the plate's
// physical base seen from above: with the tipped-flat convention above, that
// base is the edge nearest the traffic, and the artwork lies back from it,
// away from the drivers, exactly as a plate tipped backward would lie.
// Sizes are icon source px (pictogram space): a lone
// pictogram is height-normalized to PICTO_PX, a stacked member is
// width-normalized so its height is read back from the loaded image. Each
// feature carries its own MARK_OFF (the bar's centre offset); one bar per
// post *face* (under that face's bottom plate) keeps a tall column uncluttered.
// PICTO_PX is the authored pictogram size — every /signs plate is 120 px tall
// (useSignCatalogue.ts) and every /signs-stacked plate 120 px wide
// (COMMON_WIDTH in scripts/compute-stacks.mjs; duplicated per the two-runtime
// rule) — so it is also the square fallback for a stacked image not yet loaded.
const PICTO_PX = 120
const MARK_W = 72
const MARK_H = 8
const MARK_GAP = 12
const MARK_STEP = 4
const MARK_MAX = 800 // headroom over the tallest post's bottom edge (~576 + a plate)
const markOffset = offsetGrid('MARK_OFF', MARK_STEP, MARK_MAX)
const markOffFor = (plateHeight: number) =>
  Math.round((plateHeight / 2 + MARK_GAP + MARK_H / 2) / MARK_STEP) * MARK_STEP

const tierLayerId = (t: number) => `sign-tier-${t}`
// The SIGNID set per tier is static, so precompute that clause once and only
// swap the (changing) category `base` in the watcher.
const tierClause = TIER_LOD.map(
  (_, t) => ['in', ['get', 'SIGNID'], ['literal', codesByTier[t] ?? []]]
)
// Tier filter for LONE signs only — stacked post members are drawn by the one
// `sign-stack` layer below (so the whole post shares a size), hence excluded
// here. Split by tier so each lone tier keeps its own reveal zoom + size ramp.
const tierFilter = (t: number, base: ExpressionSpecification) =>
  expr(['all', base, tierClause[t], ['!', ['has', 'STACK_INDEX']]])
// Per-tier on-screen size ramp for lone signs: the shared SIGN_FIRST_SIZE at
// the tier's reveal zoom up to its `size` at MAX_ZOOM, then scaled down for
// solid rectangular plates (plateSizeFactorExpr is 1 for circles/triangles) so a
// full-bleed square like the blue "P" doesn't read heavier than a same-tier
// roundel. Stacked posts keep their own width-normalized sizing (sign-stack).
// The plate shrink rides in the interpolate's STOP OUTPUTS (data-driven `match`),
// not as an outer `*` — MapLibre only allows a `zoom` input directly under a
// top-level interpolate, so the factor has to fold into each stop value.
const tierSizeRamp = (lod: typeof TIER_LOD[number]) => expr([
  'interpolate', ['linear'], ['zoom'],
  lod.minzoom, ['*', SIGN_FIRST_SIZE, plateSizeFactorExpr],
  MAX_ZOOM, ['*', lod.size, plateSizeFactorExpr]
])

// A co-located signpost is ONE sizing unit: every member is drawn by this single
// `sign-stack` layer at one icon-size, so the width-normalized plates keep their
// real-life height ratio at every zoom (per-tier sizing scaled members
// differently and skewed it). Members reveal together at the base stack zoom
// (≥2 tiers in a post would otherwise pop in at different zooms). `hideStack`
// drops one post (by STACK_ID) so the group-highlight overlay can redraw it
// enlarged without doubling.
const STACK_MINZOOM = TIER_LOD[0].minzoom
const stackFilter = (base: ExpressionSpecification, hideStack: string | null = null) =>
  expr(['all', base, ['has', 'STACK_INDEX'], ...(hideStack ? [['!=', ['get', 'STACK_ID'], hideStack]] : [])])
// Shared post size ramp, branching on the primary tier (baked STACK_TIER) so a
// post matches the prominence of its main sign while every member scales alike.
const stackSizeRamp = expr([
  'interpolate', ['linear'], ['zoom'],
  STACK_MINZOOM, SIGN_FIRST_SIZE,
  MAX_ZOOM, ['match', ['get', 'STACK_TIER'],
    ...TIER_LOD.flatMap((lod, t) => [t, lod.size]),
    TIER_LOD[0].size
  ]
])
// Enlarged emphasis size for a *selected* sign/assembly — bigger than any
// tier's ramp so it reads as picked. Shared by the single-sign `sel-icon` and
// the whole-group overlay, so a lone click and a group click enlarge alike.
const EMPHASIS_SIZE = expr([
  'interpolate', ['linear'], ['zoom'], 13, 0.35, MAX_ZOOM, 0.62
])
// Zoom-faded opacity shared by the lone tier pictograms and the stacked-post
// pictograms: 0.55 while crowded (z13) easing to a 0.9 ceiling (never fully
// opaque, so residual high-zoom overlap stays legible-through; collision is off).
const ICON_OPACITY = expr([
  'interpolate', ['linear'], ['zoom'], 13, 0.55, 17, 0.9
])
// One dot under every sign at all zooms; the pictogram is drawn on top once
// its tier's minzoom is reached. The icon covers the small centred dot, so
// the dot only shows through below the tier's minzoom (collision is disabled,
// so a sign is never dropped once its tier is in range).
const signLayerIds = ['sign-points', 'sign-stack', ...TIER_LOD.map((_, t) => tierLayerId(t))]

// Road-rules overlay: line layers from the third archive
// (public/data/road-rules.pmtiles, one source-layer per RuleLayer). Each kind
// is two layers — a wide, fully transparent `-hit` line that is ALWAYS on, and
// the visible line the legend toggles. The hit line does two jobs: it gives
// clicks tolerance on a 1–6 px line, and it keeps the source's tiles resident
// even when every overlay is off, because MapLibre only loads tiles for
// non-hidden layers and the sign popup's "applies here" lookup
// (querySourceFeatures below) needs them loaded regardless. Rule ids stay OUT
// of signLayerIds: the click handler's featureKey assumes point geometry.
// Draw order: `cutoff` first, so its wide band sits under every rule line.
const RULE_LAYERS: RuleLayer[] = ['cutoff', 'speed', 'buslane', 'prohibition', 'nsr', 'pedzone']
const ruleLayerId = (layer: RuleLayer) => `rule-${layer}`
const ruleHitLayerId = (layer: RuleLayer) => `rule-${layer}-hit`
// `cutoff` gets NO hit line. It is the one rule drawn as a wide band (4 px at
// z11 to 22 px at z17), so it is already its own click target, and a 14 px
// transparent twin would mean a second bucket and a second hit-test per
// pointer move over ~4.7k territory-wide lines that draw nothing — a cost
// every visitor now pays, since the PLB row that owns the band is on by
// default. The other five keep theirs: they are 1-6 px lines, and their
// always-on hit layers are what keep the source's tiles resident.
const RULE_HIT_LAYERS: RuleLayer[] = RULE_LAYERS.filter(l => l !== 'cutoff')
// What a click or hover hit-tests: those hit lines plus the band itself. A
// hidden layer returns no features, so the band is unpickable when its row is
// off — the hit lines need `isRowEnabled` for that, being always on.
const rulePickLayerIds = [...RULE_HIT_LAYERS.map(ruleHitLayerId), ruleLayerId('cutoff')]
// Speed limits run for kilometres and read at the overview; bus lanes and
// prohibitions are short urban segments that only make sense street-level;
// no-stopping's 20k kerb lines are a smear until the streets separate.
const RULE_MINZOOM: Record<RuleLayer, number> = { speed: 9, buslane: 11, prohibition: 11, nsr: 12, pedzone: 12, cutoff: 11 }
const RULE_LINE_WIDTH = expr(['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3, 17, 6])
// A bus lane's `bound` is its side of the centreline in the digitised
// direction (1 left, -1 right, 0 both); `line-offset` is positive to the
// right of the line, so the lane draws on its own side. The side factor rides
// in the interpolate's STOP OUTPUTS — a zoom input is only legal directly
// under a top-level interpolate, so it can't be an outer `*`.
const busLaneSide = expr(['match', ['get', 'bound'], 1, -1, -1, 1, 0])
const RULE_PAINT: Record<RuleLayer, LineLayerSpecification['paint']> = {
  speed: {
    'line-color': expr(['match', ['get', 'speed'], ...speedColorStops, ruleColor('speed')])
  },
  buslane: {
    'line-color': ruleColor('buslane'),
    'line-offset': expr(['interpolate', ['linear'], ['zoom'], 12, ['*', busLaneSide, 1], 17, ['*', busLaneSide, 5]])
  },
  prohibition: {
    'line-color': expr(['match', ['get', 'kind'], ...prohibitionColorStops, ruleColor('proh-other')]),
    'line-dasharray': [2, 1.5]
  },
  // Dotted (a near-zero dash with round caps draws dots), distinct from the
  // prohibition dashes, and read as a kerb line. No offset: NSR has no BOUND
  // field to say which kerb.
  nsr: {
    'line-color': expr(['match', ['get', 'veh'], ...nsrColorStops, ruleColor('nsr')]),
    'line-dasharray': [0.1, 2]
  },
  pedzone: {
    'line-color': ruleColor('pedzone')
  },
  // A wide, faint band rather than a line: it marks roads no rule names, the
  // area behind the PLB prohibitions that seal it, not a rule of its own — so
  // its colour is a constant, not a row's (it shares the PLB row's checkbox).
  cutoff: {
    'line-color': CUTOFF_COLOR,
    'line-width': expr(['interpolate', ['linear'], ['zoom'], 11, 4, 14, 10, 17, 22]),
    'line-opacity': 0.35
  }
}
// Which features of the link's source-layer count as the sign's rule
// (undefined = any of them).
const ruleLinkFilter = (link: SignRuleLink): ExpressionSpecification | undefined => {
  switch (link.layer) {
    case 'speed': return expr(['==', ['get', 'speed'], link.speed])
    case 'prohibition': return expr(['==', ['get', 'kind'], link.kind])
    case 'nsr': return expr(['all', ['==', ['get', 'veh'], link.veh], ['==', ['get', 'tz'], link.tz]])
    case 'buslane': return undefined
  }
}

// Pictogram icon-id prefixes. Lone signs draw from the height-normalized set
// (`sign-` → /signs/); stacked post members (those carrying STACK_INDEX) draw
// the width-normalized variant (`signw-` → /signs-stacked/) so the post reads
// at true plate proportions. The lazy loader strips whichever prefix to fetch
// the PNG. ('signw-' deliberately doesn't start with 'sign-' so they don't
// collide.) Both sets share one SIGNID space, so PICTO_CODES gates either.
const PICTO_PREFIX = 'sign-'
const STACKED_PREFIX = 'signw-'
// Each prefix paired with the public dir the lazy loader fetches its PNG from,
// so the prefix and its folder can't drift apart on a rename.
const PICTO_DIR = { [PICTO_PREFIX]: 'signs', [STACKED_PREFIX]: 'signs-stacked' } as const
const PICTO_CODES = new Set(codesByTier.flat())
// `icon-image` for every pictogram layer: the SIGNID prefixed by the set it
// should draw from — the width-normalized variant for a stacked post member,
// the plain one otherwise.
const PICTO_ICON = expr([
  'concat',
  ['case', ['has', 'STACK_INDEX'], STACKED_PREFIX, PICTO_PREFIX],
  ['get', 'SIGNID']
])

// Set on teardown so the async pictogram loader doesn't addImage on a removed map.
let disposed = false

onMounted(async () => {
  const [{ default: maplibregl }, { Protocol, PMTiles }] = await Promise.all([
    import('maplibre-gl'),
    import('pmtiles')
  ])
  // Guard: with <ClientOnly> the container is in the DOM by onMounted, but
  // the dynamic import is async so re-check before constructing.
  if (!container.value) return

  // pmtiles serves vector tiles out of one static file via HTTP range
  // requests — registered once as a custom maplibre protocol. The custom
  // Source falls back to a whole-file download (with a console.warn) if
  // the host returns 200 instead of 206 for a Range request — see
  // app/utils/pmtilesSource.ts. `?v=<hash>` is the cache-buster: each
  // tile rebuild writes a fresh hash to tilesVersion.json so returning
  // visitors don't stitch cached chunks of the old archive together
  // with newly-fetched chunks of the new one.
  const base = window.location.origin
  const lodUrl = `${base}/data/traffic-signs.pmtiles?v=${tilesVersion.version}`
  const fullUrl = `${base}/data/traffic-signs-full.pmtiles?v=${tilesVersion.version}`
  // The road-rules archive has its own hash: it is rebuilt on its own cadence
  // by scripts/build-road-rules.mjs and must not bust the sign cache.
  const rulesUrl = `${base}/data/road-rules.pmtiles?v=${tilesVersion.rulesVersion}`
  const protocol = new Protocol()
  protocol.add(new PMTiles(new RangeOrWholeSource(lodUrl)))
  protocol.add(new PMTiles(new RangeOrWholeSource(fullUrl)))
  protocol.add(new PMTiles(new RangeOrWholeSource(rulesUrl)))
  maplibregl.addProtocol('pmtiles', protocol.tile)
  detachProtocol = () => maplibregl.removeProtocol('pmtiles')

  let m: MaplibreMap
  try {
    m = new maplibregl.Map({
      container: container.value,
      center: HK_CENTER,
      zoom: 11,
      minZoom: 9,
      maxZoom: MAX_ZOOM,
      maxBounds: HK_BOUNDS,
      attributionControl: { compact: true },
      style: {
        version: 8,
        sources: {
          'osm-light': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution: OSM_ATTRIB
          },
          'osm-dark': {
            type: 'raster',
            tiles: [
              `https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`,
              `https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`
            ],
            tileSize: 256,
            maxzoom: 19,
            attribution: `${OSM_ATTRIB} © <a href="https://carto.com/attributions">CARTO</a>`
          }
        },
        // Both basemaps exist; visibility toggles by colour mode so the
        // theme switch never rebuilds the vector source above it.
        layers: [
          { id: 'basemap-light', type: 'raster', source: 'osm-light' },
          { id: 'basemap-dark', type: 'raster', source: 'osm-dark', layout: { visibility: 'none' } }
        ]
      }
    })
  } catch (err) {
    // MapLibre initializes WebGL synchronously in the constructor and throws
    // here when it's unavailable (disabled, blocklisted GPU, ancient browser).
    // No map instance exists yet, so the m.on('error') handler below can never
    // fire for this — surface a message instead of a blank container.
    console.error('[maplibre] WebGL unavailable', err)
    mapUnavailable.value = true
    track('map_init_failed')
    detachProtocol?.()
    detachProtocol = undefined
    return
  }

  m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
  m.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true
  }), 'top-right')
  m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

  m.on('load', () => {
    // Two PMTiles archives, both registered on the protocol above. The sign
    // layers read ONE of them per filter mode (see `sourceForMode`): the
    // thinned `signs-lod` for the unfiltered overview, the retain-all
    // `signs-full` when filtering by sign ID. A single pyramid can't serve
    // both, so we swap the source by re-adding the layers when the mode
    // flips. Both carry the same attribution and `signs` source-layer name.
    // The road-rules overlay is the same publisher and licence (Road Network
    // v2), so one attribution string covers all three archives.
    const ATTRIB = 'Traffic sign & road network data © Transport Department, HKSAR'
    m.addSource(SOURCE_LOD, { type: 'vector', url: `pmtiles://${lodUrl}`, attribution: ATTRIB })
    m.addSource(SOURCE_FULL, { type: 'vector', url: `pmtiles://${fullUrl}`, attribution: ATTRIB })
    m.addSource(RULE_SOURCE, { type: 'vector', url: `pmtiles://${rulesUrl}`, attribution: ATTRIB })

    const circlePaint = {
      // Smaller dots when zoomed out keep dense areas readable.
      'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6, 19, 9]),
      'circle-color': categoryColor,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': expr(['interpolate', ['linear'], ['zoom'], 11, 0.3, 16, 1]),
      'circle-opacity': 0.9
    }

    // Group-highlight overlay (drawn beneath the single-sign `sel` overlay):
    // clicking any sign in a post (STACK_ID) fills this with every member so
    // the whole signpost lights up and enlarges together (see the layers
    // below). A soft disc, drawn once here and reused, sits behind each
    // pictogram as the highlight ring — a touch larger than the 120 px
    // pictograms; rotating it is a no-op but its `icon-offset` must ride
    // `icon-rotate` like the pictograms' to stay aligned with the stack.
    // Rasterise a `w`×`h` (icon source px) overlay glyph at 2× into the style.
    const addDrawnImage = (id: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
      const canvas = document.createElement('canvas')
      canvas.width = w * 2
      canvas.height = h * 2
      const ctx = canvas.getContext('2d')!
      ctx.scale(2, 2)
      draw(ctx)
      m.addImage(id, ctx.getImageData(0, 0, w * 2, h * 2), { pixelRatio: 2 })
    }
    const GLOW_PX = 150
    addDrawnImage('sel-glow', GLOW_PX, GLOW_PX, (ctx) => {
      ctx.beginPath()
      ctx.arc(GLOW_PX / 2, GLOW_PX / 2, GLOW_PX / 2 - 4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(37,99,235,0.16)'
      ctx.fill()
      ctx.lineWidth = 5
      ctx.strokeStyle = '#2563eb'
      ctx.stroke()
    })
    // The facing underline (see MARK_*): a black bar with a thin white halo so
    // it stands out on both basemaps; the canvas is padded by the halo.
    const MARK_PAD = 3
    const markW = MARK_W + MARK_PAD * 2
    const markH = MARK_H + MARK_PAD * 2
    addDrawnImage('sel-facing', markW, markH, (ctx) => {
      ctx.lineCap = 'round'
      for (const [width, color] of [[MARK_H + 3, '#ffffff'], [MARK_H, '#000000']] as const) {
        ctx.lineWidth = width
        ctx.strokeStyle = color
        ctx.beginPath()
        ctx.moveTo(MARK_PAD + MARK_H / 2, markH / 2)
        ctx.lineTo(markW - MARK_PAD - MARK_H / 2, markH / 2)
        ctx.stroke()
      }
    })

    m.addSource('sel-group', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    // Two layers (a uniform EMPHASIS_SIZE means one zoom-interpolate, so no
    // per-tier split is needed): the glow disc rings each member, then the
    // pictogram is re-drawn enlarged on top. Every member shares the same
    // size + `stackOffset`, so the whole post enlarges together as one unit.
    // The selected post's base pictograms (on the `sign-stack` layer) are hidden
    // (see stackFilter's hideStack) so they don't show doubled under the enlarged copy.
    for (const [id, image] of [['sel-group-glow', 'sel-glow'], ['sel-group-top', null]] as const) {
      m.addLayer({
        id,
        type: 'symbol',
        source: 'sel-group',
        layout: {
          'icon-image': image ?? PICTO_ICON,
          'icon-size': EMPHASIS_SIZE,
          ...iconRotation,
          'icon-offset': stackOffset,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      })
    }

    // Highlight overlay for the sign shown in the detail panel. Added BEFORE
    // the sign layers so they can be inserted beneath the overlays (the
    // beforeId below): the picked sign then always draws on top — even after
    // the sign layers are removed and re-added on a filter-mode switch —
    // which is why the cluster-cycle highlight stays visible above the soup.
    m.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    m.addLayer({
      id: 'sel-halo',
      type: 'circle',
      source: 'sel',
      paint: {
        'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 12, 14, 16, 22, 19, 30]),
        'circle-color': 'rgba(37,99,235,0.12)',
        'circle-stroke-color': '#2563eb',
        'circle-stroke-width': 3
      }
    })
    m.addLayer({
      id: 'sel-dot',
      type: 'circle',
      source: 'sel',
      paint: {
        'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 11, 3, 16, 6, 19, 9]),
        'circle-color': categoryColor,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1
      }
    })
    m.addLayer({
      id: 'sel-icon',
      type: 'symbol',
      source: 'sel',
      layout: {
        'icon-image': PICTO_ICON,
        // EMPHASIS_SIZE stays ≥ the largest tier size so this enlarged overlay
        // fully covers the sign's own tier pictogram underneath (no double
        // image). Only lone signs reach `sel` — grouped signs are suppressed
        // from it and handled by the group overlay — so no stack offset here.
        'icon-size': EMPHASIS_SIZE,
        ...iconRotation,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true
      }
    })
    // Facing underline for the highlighted sign — one layer per overlay
    // source (lone sign / post members), drawn topmost so a neighbouring
    // plate never covers it. Only features given a MARK_OFF get a bar (the
    // bottom plate of each post face; every lone sign).
    for (const [id, source] of [['sel-group-facing', 'sel-group'], ['sel-facing', 'sel']] as const) {
      m.addLayer({
        id,
        type: 'symbol',
        source,
        filter: expr(['has', 'MARK_OFF']),
        layout: {
          'icon-image': 'sel-facing',
          'icon-size': EMPHASIS_SIZE,
          ...iconRotation,
          'icon-offset': markOffset,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      })
    }

    // Pictograms load lazily: MapLibre fires `styleimagemissing` once per
    // unknown icon-image a visible tile references, and we fetch that one
    // PNG on demand. The always-on `sign-points` dot is the fallback while
    // its pictogram is in flight, and uncatalogued SIGNIDs are dropped so
    // selecting one doesn't 404 the same code on every render tick.
    const inFlight = new Set<string>()
    // Stacked codes whose image the last selection sync needed for a facing
    // mark but couldn't find in the style yet (see syncSelection): when one
    // lands, the sync re-runs once to place that mark from the real height.
    const pendingMarkCodes = new Set<string>()
    m.on('styleimagemissing', ({ id }) => {
      // Stacked members request `signw-<code>` (width-normalized, /signs-stacked);
      // everything else `sign-<code>` (/signs). Check the stacked prefix first —
      // 'signw-' doesn't start with 'sign-', so the two never alias.
      const prefix = id.startsWith(STACKED_PREFIX) ? STACKED_PREFIX : PICTO_PREFIX
      if (!id.startsWith(prefix) || inFlight.has(id) || m.hasImage(id)) return
      const code = id.slice(prefix.length)
      if (!PICTO_CODES.has(code)) return
      inFlight.add(id)
      m.loadImage(`/${PICTO_DIR[prefix]}/${code}.png`)
        .then((img) => {
          if (disposed) return
          m.addImage(id, img.data)
          if (pendingMarkCodes.delete(code)) syncSelection()
        })
        .catch(err => console.error('[signs]', err))
        .finally(() => inFlight.delete(id))
    })

    // The STACK_ID whose base pictograms are currently hidden from the sign-stack
    // layer because a post is selected (the overlay draws them enlarged).
    let hiddenStack: string | null = null

    // The sign layers — always-on dot, per-tier lone pictograms, and the
    // single sign-stack layer for signposts — all read whichever archive the
    // active filter mode wants. They're inserted
    // beneath the overlays (the `sel-group`/`sel` layers, anchored on
    // `sel-group-glow`) so selection stays on top, and removed/re-added to
    // swap source on a mode flip (MapLibre can't repoint a live layer).
    const addSignLayers = (source: SignSource) => {
      // One dot under every visible sign at all zooms — the baseline marker.
      // Pictogram layers draw on top from their tier's minzoom; the icon
      // covers the small centred dot, so the dot only shows where the sign
      // isn't rendered yet (below its tier's minzoom).
      m.addLayer({
        'id': 'sign-points',
        'type': 'circle',
        'source': source,
        'source-layer': SOURCE_LAYER,
        'filter': mapFilter.value,
        'paint': { ...circlePaint }
      }, 'sel-group-glow')

      // LOD: at each tier's minzoom the pictogram is drawn over the dot,
      // later/larger the more complex the sign. Layers are added before any
      // pictogram exists; the lazy loader above fills them in as tiles arrive.
      TIER_LOD.forEach((lod, t) => {
        if (!codesByTier[t]?.length) return
        m.addLayer({
          'id': tierLayerId(t),
          'type': 'symbol',
          'source': source,
          'source-layer': SOURCE_LAYER,
          'minzoom': lod.minzoom,
          'filter': tierFilter(t, expr(mapFilter.value)),
          'layout': {
            'icon-image': PICTO_ICON,
            // Normalised first-display height (SIGN_FIRST_SIZE, shared by
            // every tier) at the tier's reveal zoom, ramping up to the
            // tier's "proper" size by max zoom. Safe to grow now that
            // collision is off — it can't push already-shown signs away,
            // and zooming in frees the space to render detail bigger.
            'icon-size': tierSizeRamp(lod),
            ...iconRotation,
            // No icon-offset here: stacked post members (the only signs with an
            // offset) are drawn by the sign-stack layer; lone signs sit at [0,0].
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // Lower tier draws on top, so simple regulatory signs sit above
            // decorative ones where pictograms overlap.
            'symbol-sort-key': t
          },
          'paint': { 'icon-opacity': ICON_OPACITY }
        }, 'sel-group-glow')
      })

      // Every co-located signpost is drawn here as ONE unit (see stackFilter /
      // stackSizeRamp): all members share one icon-size keyed by the post's
      // primary tier, so the width-normalized plates keep their real-life height
      // ratio at any zoom and the whole post reveals together at STACK_MINZOOM.
      m.addLayer({
        'id': 'sign-stack',
        'type': 'symbol',
        'source': source,
        'source-layer': SOURCE_LAYER,
        'minzoom': STACK_MINZOOM,
        'filter': stackFilter(expr(mapFilter.value), hiddenStack),
        'layout': {
          'icon-image': PICTO_ICON,
          'icon-size': stackSizeRamp,
          ...iconRotation,
          // Hang each member at its baked STACK_OFF down its face's column (main
          // on top, supplementary at the bottom); the offset rides the member's
          // own icon-rotate (its face's bearing) + scales with icon-size, so each
          // face stays a rigid, proportional column hanging along its facing.
          'icon-offset': stackOffset,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          // Main sign (lowest STACK_INDEX) draws on top where plates overlap.
          'symbol-sort-key': expr(['get', 'STACK_INDEX'])
        },
        'paint': { 'icon-opacity': ICON_OPACITY }
      }, 'sel-group-glow')
    }
    const removeSignLayers = () => {
      for (const id of signLayerIds) if (m.getLayer(id)) m.removeLayer(id)
    }

    // Rule lines go in BEFORE the sign layers, anchored on the same overlay
    // (`sel-group-glow`): MapLibre inserts immediately before the anchor, so
    // whatever is added later lands on top — the sign layers now, and again
    // every time a filter-mode flip re-adds them. Roads stay under signs.
    for (const layer of RULE_LAYERS) {
      const common = { 'source': RULE_SOURCE, 'source-layer': layer, 'minzoom': RULE_MINZOOM[layer] } as const
      if (RULE_HIT_LAYERS.includes(layer)) {
        m.addLayer({
          id: ruleHitLayerId(layer),
          type: 'line',
          ...common,
          paint: { 'line-color': '#000000', 'line-opacity': 0, 'line-width': 14 }
        }, 'sel-group-glow')
      }
      m.addLayer({
        id: ruleLayerId(layer),
        type: 'line',
        ...common,
        // Butt caps on the translucent cut-off band: round caps of adjoining
        // edges overlap at every junction and stack into bright dots.
        layout: { 'line-cap': layer === 'cutoff' ? 'butt' : 'round', 'line-join': 'round', 'visibility': 'none' },
        paint: { 'line-width': RULE_LINE_WIDTH, 'line-opacity': 0.75, ...RULE_PAINT[layer] }
      }, 'sel-group-glow')
    }
    // Legend → layers: every non-prohibition layer by visibility, via
    // isRowEnabled (NOT the layer name — `cutoff` rides the PLB row); the one
    // prohibition layer by a `kind` filter over the rows that are on (hidden
    // when none).
    // Every setLayoutProperty/setFilter dirties the style and repaints even
    // when the value is unchanged, and a real change reloads every resident
    // tile of the source — so write only on a difference. This watch also
    // fires on a cross-tab storage event, where nothing has actually moved.
    const syncRuleLayers = () => {
      const kinds = enabledKinds.value
      const kindFilter = expr(['in', ['get', 'kind'], ['literal', kinds]])
      for (const layer of RULE_LAYERS) {
        const id = ruleLayerId(layer)
        if (!m.getLayer(id)) continue
        const on = layer === 'prohibition' ? kinds.length > 0 : isRowEnabled(layer)
        const vis = on ? 'visible' : 'none'
        if (m.getLayoutProperty(id, 'visibility') !== vis) m.setLayoutProperty(id, 'visibility', vis)
        if (layer === 'prohibition' && JSON.stringify(m.getFilter(id)) !== JSON.stringify(kindFilter)) {
          m.setFilter(id, kindFilter)
        }
      }
    }
    watch(rulesEnabled, syncRuleLayers, { immediate: true, deep: true })

    addSignLayers(sourceForMode(filterMode.value))
    // In sign-ID mode, fetch the companion-group index so the filter can grow
    // each matched sign into its whole signpost; `mapFilter` re-widens (and the
    // watch below re-applies it) once it resolves.
    if (filterMode.value === 'sign-id') loadGroupIndex()

    // Re-apply just the sign-stack filter — the only sign layer that depends on
    // `hiddenStack` (the selected post to hide while its enlarged overlay draws).
    // The selection path calls this alone; the tier layers don't carry it.
    const refreshStackFilter = () => {
      if (m.getLayer('sign-stack')) m.setFilter('sign-stack', stackFilter(expr(mapFilter.value), hiddenStack))
    }
    // Re-apply ALL sign-layer filters — for a category-visibility (`mapFilter`)
    // change, a GPU-side filter instant across 316k features (no DOM/refetch),
    // which affects the lone tier layers and the stack alike.
    const refreshSignFilters = () => {
      TIER_LOD.forEach((_, t) => {
        const ico = tierLayerId(t)
        if (m.getLayer(ico)) m.setFilter(ico, tierFilter(t, expr(mapFilter.value)))
      })
      refreshStackFilter()
    }
    watch(mapFilter, (f) => {
      if (m.getLayer('sign-points')) m.setFilter('sign-points', f)
      refreshSignFilters()
    }, { immediate: true })

    // Flipping between the category and sign-ID tabs swaps which archive the
    // sign layers read. MapLibre can't repoint a live layer's source, so
    // remove and re-add against the right archive — cheap, since this only
    // fires on a tab click. `addSignLayers` re-inserts beneath `sel-halo`, so
    // selection stays on top, and the lazy loader refills icons on demand.
    watch(filterMode, (mode) => {
      if (mode === 'sign-id') loadGroupIndex()
      removeSignLayers()
      addSignLayers(sourceForMode(mode))
    })

    watch(() => colorMode.value, (mode) => {
      const dark = mode === 'dark'
      m.setLayoutProperty('basemap-dark', 'visibility', dark ? 'visible' : 'none')
      m.setLayoutProperty('basemap-light', 'visibility', dark ? 'none' : 'visible')
    }, { immediate: true })

    // Mirror the selected sign into the highlight source. The sel layers are
    // added above the sign layers (which insert beneath `sel-halo`), so the
    // picked sign always draws on top — no explicit re-ordering needed, even
    // after the sign layers are swapped on a filter-mode flip.
    const sel = m.getSource('sel') as GeoJSONSource
    const selGroup = m.getSource('sel-group') as GeoJSONSource
    const syncSelection = () => {
      const s = selectedSign.value
      // A picked sign in a co-located post (STACK_ID — every GG_NAME face on
      // that pole) is shown via the *group* overlay (the whole post enlarges
      // together), so the single-sign `sel` overlay is suppressed for it —
      // otherwise only the clicked member would balloon and its halo would sit
      // at the post anchor, not on the offset pictogram. Lone signs keep the
      // single-sign overlay.
      const idRaw = s?.properties?.STACK_ID
      const stackId = typeof idRaw === 'string' ? idRaw : null
      const grouped = !!s && s.properties?.STACK_INDEX !== undefined && stackId !== null
      sel.setData({
        type: 'FeatureCollection',
        features: s && !grouped
          ? [{
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [s.lngLat.lng, s.lngLat.lat] },
              // Lone pictograms are height-normalized, so the facing underline
              // always hangs the same distance below the anchor.
              properties: { ...s.properties, MARK_OFF: markOffFor(PICTO_PX) }
            }]
          : []
      })
      // Gather every member of the post from the active *source* — not the
      // tier layers, since we hide the selected post's plates just below (and a
      // source query also survives re-clicking the same post). build-tiles
      // already collapsed each member onto the post anchor with its face's
      // bearing (see compute-stacks.mjs), so these are already a rigid post;
      // just dedup the tile-boundary copies by STACK_INDEX (one sign per
      // stack position — unique across all faces).
      let members: GeoJSON.Feature[] = []
      if (grouped) {
        const seen = new Set<unknown>()
        members = m
          .querySourceFeatures(sourceForMode(filterMode.value), {
            sourceLayer: SOURCE_LAYER,
            filter: ['==', ['get', 'STACK_ID'], stackId] as FilterSpecification
          })
          .filter(f => f.properties.STACK_INDEX !== undefined && !seen.has(f.properties.STACK_INDEX) && seen.add(f.properties.STACK_INDEX))
          .map(f => ({ type: 'Feature' as const, geometry: f.geometry, properties: { ...f.properties } }))
          .sort((a, b) => Number(a.properties.STACK_INDEX) - Number(b.properties.STACK_INDEX))
        // One facing underline per face — under the face's bottom plate (its
        // largest STACK_OFF; members of one face share a FACE_BEARING). The
        // bar hangs past that plate's bottom edge, whose height is the
        // width-normalized image's (read from the style once loaded; until
        // then a square is assumed and the loader re-syncs when it lands).
        const bottomByFace = new Map<unknown, GeoJSON.Feature>()
        for (const f of members) {
          const prev = bottomByFace.get(f.properties!.FACE_BEARING)
          if (!prev || Number(f.properties!.STACK_OFF ?? 0) > Number(prev.properties!.STACK_OFF ?? 0)) bottomByFace.set(f.properties!.FACE_BEARING, f)
        }
        pendingMarkCodes.clear()
        for (const f of bottomByFace.values()) {
          const code = String(f.properties!.SIGNID)
          const img = m.getImage(STACKED_PREFIX + code)
          if (!img) pendingMarkCodes.add(code)
          f.properties!.MARK_OFF = Number(f.properties!.STACK_OFF ?? 0) + markOffFor(img?.data.height ?? PICTO_PX)
        }
      }
      selGroup.setData({ type: 'FeatureCollection', features: members })
      // Publish the post to the popup as ready-to-select entries (top-of-post
      // first, face by face). Every member was collapsed onto the post anchor
      // at build time, so each shares one coordinate — a plain LngLat from it
      // is enough for the popup to re-select via `selectedSign = member`.
      selectedGroup.value = members.map(f => ({
        properties: f.properties as Record<string, unknown>,
        lngLat: new maplibregl.LngLat(...(f.geometry as GeoJSON.Point).coordinates as [number, number])
      }))
      // Hide the selected post's base pictograms on the sign-stack layer (the
      // overlay draws them enlarged on top); restore when a lone sign / nothing
      // is picked. Only re-filter when it actually changes — cycling within one
      // post / through lone signs leaves it unchanged and shouldn't re-run setFilter.
      const nextHiddenStack = grouped ? stackId : null
      if (nextHiddenStack !== hiddenStack) {
        hiddenStack = nextHiddenStack
        refreshStackFilter()
      }
    }
    watch(selectedSign, syncSelection)

    // "Applies here": for a sign whose plate announces a rule the archive has
    // an extent for (SIGN_RULE_LINKS), find the nearest matching rule feature
    // within SIGN_RULE_RADIUS_M of the sign and hand it to the sign popup.
    // querySourceFeatures reads the loaded tiles — resident at every zoom
    // thanks to the always-on hit layers — so this is a local, synchronous
    // lookup; a sign too far from any matching feature just shows no block.
    const lookupGoverningRule = (s: SelectedSign | null) => {
      const code = typeof s?.properties.SIGNID === 'string' ? s.properties.SIGNID : null
      const link = code ? SIGN_RULE_LINKS[code] : undefined
      if (!s || !link) {
        governingRule.value = null
        return
      }
      const filter = ruleLinkFilter(link)
      let best: GeoJSONFeature | null = null
      let bestD = SIGN_RULE_RADIUS_M
      // `validate: false`: the filter is built from typed constants, so skip
      // MapLibre's per-call style-spec validation of it.
      for (const f of m.querySourceFeatures(RULE_SOURCE, { sourceLayer: link.layer, filter, validate: false })) {
        const g = f.geometry
        if (g.type !== 'LineString' && g.type !== 'MultiLineString') continue
        const d = pointToLineMetres(s.lngLat.lng, s.lngLat.lat, g.coordinates)
        if (d <= bestD) {
          bestD = d
          best = f
        }
      }
      governingRule.value = best ? { layer: link.layer, properties: best.properties } : null
    }
    watch(selectedSign, lookupGoverningRule, { immediate: true })
  })

  // A click can land on several overlapping/collided signs. Collect them all
  // and, when the user clicks the same spot again, advance to the next one so
  // every sign under the pointer is reachable despite collision.
  let cycleKey = ''
  let cycleIdx = 0
  const featureKey = (f: MapGeoJSONFeature) => {
    const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates
    const p = f.properties
    // STACK_INDEX keeps two faces of one post apart when they carry the same
    // code at the same anchor (a "Taxi stand" plate facing each way).
    return `${lng.toFixed(6)},${lat.toFixed(6)}|${p.SIGNID ?? p.POLEID ?? p.REFNAME ?? ''}|${p.category ?? ''}|${p.STACK_INDEX ?? ''}`
  }

  m.on('click', (e) => {
    const layers = signLayerIds.filter(id => m.getLayer(id))
    const box: [[number, number], [number, number]] = [
      [e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]
    ]
    // De-dupe: a catalogued sign appears in both its dot and pictogram layer.
    const seen = new Set<string>()
    const hits = m.queryRenderedFeatures(box, { layers }).filter((f) => {
      const k = featureKey(f)
      return seen.has(k) ? false : (seen.add(k), true)
    })

    if (!hits.length) {
      selectedSign.value = null
      cycleKey = ''
      // No sign under the pointer: try the rule lines. Signs always win a
      // contested click (a rule line runs under many signs), and only a row
      // the legend has on is pickable — the transparent hit lines are always
      // present, so an off overlay must not open a popup.
      const rule = m.queryRenderedFeatures(box, { layers: rulePickLayerIds.filter(id => m.getLayer(id)) })
        .find(f => isRowEnabled(f.sourceLayer as RuleLayer, f.properties.kind as string | undefined))
      selectedRule.value = rule
        ? { layer: rule.sourceLayer as RuleLayer, properties: rule.properties, lngLat: e.lngLat }
        : null
      if (rule) {
        track('rule_select', {
          layer: rule.sourceLayer as string,
          kind: typeof rule.properties.kind === 'string' ? rule.properties.kind : null,
          zoom: Math.round(m.getZoom() * 10) / 10
        })
      }
      return
    }
    // Same set of hits as the previous click → cycle; otherwise restart.
    const key = hits.map(featureKey).join('~')
    cycleIdx = key === cycleKey ? (cycleIdx + 1) % hits.length : 0
    cycleKey = key

    const f = hits[cycleIdx]
    if (!f) return
    const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates
    selectedRule.value = null // a sign pick replaces a rule pick; one popup at a time
    selectedSign.value = {
      properties: f.properties,
      lngLat: new maplibregl.LngLat(lng, lat),
      index: cycleIdx + 1,
      total: hits.length
    }
    // `sign_id` is the catalogued SIGNID where present (the most informative
    // dimension — "which signs do people click?"); uncatalogued features
    // (poles, tourist signs) fall back to category so the event still groups
    // usefully. `cluster_size` >1 means the click landed on overlapping signs.
    const signId = typeof f.properties.SIGNID === 'string' ? f.properties.SIGNID : null
    track('sign_select', {
      sign_id: signId,
      category: categoryKeyOf(f.properties),
      cluster_size: hits.length,
      zoom: Math.round(m.getZoom() * 10) / 10
    })
  })

  // Layer-scoped enter/leave only fire on transitions — far cheaper than
  // hit-testing 316k features on every mousemove.
  for (const id of signLayerIds) {
    m.on('mouseenter', id, () => (m.getCanvas().style.cursor = 'pointer'))
    m.on('mouseleave', id, () => (m.getCanvas().style.cursor = ''))
  }
  // Rule lines: ONE delegated pair over all the hit layers (each
  // layer-scoped listener is its own hit-test per mousemove). `mousemove`
  // rather than `mouseenter`, because the enter latch would stick on a line
  // whose row is off and never re-fire for an enabled line reached without
  // leaving the hit layers. It only ever SETS the pointer — the lines run
  // under nearly every sign, so clearing here would undo a sign's own cue.
  // Leaving the lines clears it unless a sign is still under the pointer.
  m.on('mousemove', rulePickLayerIds, (e) => {
    if (e.features?.some(f => isRowEnabled(f.sourceLayer as RuleLayer, f.properties.kind as string | undefined))) {
      m.getCanvas().style.cursor = 'pointer'
    }
  })
  m.on('mouseleave', rulePickLayerIds, (e) => {
    const layers = signLayerIds.filter(id => m.getLayer(id))
    if (!m.queryRenderedFeatures(e.point, { layers }).length) m.getCanvas().style.cursor = ''
  })

  m.on('error', e => console.error('[maplibre]', e.error?.message ?? e))

  map.value = m
})

onBeforeUnmount(() => {
  disposed = true
  map.value?.remove()
  detachProtocol?.()
})

defineExpose({ map })
</script>

<template>
  <div
    v-if="mapUnavailable"
    class="flex h-full w-full items-center justify-center p-6 text-center text-muted"
  >
    <p class="max-w-sm text-sm">
      {{ $t('map.webglUnsupported') }}
    </p>
  </div>
  <div
    v-else
    ref="container"
    class="h-full w-full"
  />
</template>
