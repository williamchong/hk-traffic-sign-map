<script setup lang="ts">
import type { Map as MaplibreMap, ExpressionSpecification, MapGeoJSONFeature, GeoJSONSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { CATEGORY_FALLBACK_COLOR, categoryColorStops } from '~/composables/useSignCategories'
import { TIER_LOD, SIGN_FIRST_SIZE, codesByTier, categoryKeyExpr, categoryKeyOf } from '~/composables/useSignCatalogue'
import type { FilterMode } from '~/composables/useTrafficLayers'
import tilesVersion from '~/data/tilesVersion.json'

// maplibre-gl touches `window` at import time and is large; it's
// dynamically imported inside onMounted so it never enters the SSR pass
// and is code-split out of the initial bundle.
let detachProtocol: (() => void) | undefined

const { mapFilter, selectedSign, mapUnavailable, filterMode } = useTrafficLayers()
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

// FACE_BEARING is computed at build time by scripts/compute-bearings.mjs:
// each abbreviation point is snapped to the nearest ≥3 m road-marking line,
// its compass tangent is taken, and the sign's side of the line (cross-
// product sign) flips one carriageway by 180° so opposite-bound signs end
// up 180° apart in the data. TD's raw `ANGLE` looked like it should fill
// this role but turned out to be the MicroStation symbol-cell rotation
// (commit 42c343a), which gave both carriageways the same value.
//
// Coverage is ~76 % of the 178k signs; the rest (off-network ferry piers,
// gantries set back from the carriageway, signs already inside junction
// geometry) have no FACE_BEARING and fall through `coalesce` to 0 → upright,
// matching the pre-rotation state for them.
//
// `icon-rotation-alignment: 'map'` keeps the bearing geo-aligned through
// map rotation — without it the rotation would lock to the viewport and the
// orientation cue would be meaningless.
const iconRotation = {
  'icon-rotate': expr(['coalesce', ['get', 'FACE_BEARING'], 0]),
  'icon-rotation-alignment': 'map' as const
}

// Signs sharing a GG_NAME assembly are stacked into a vertical signpost: each
// member carries a build-time STACK_INDEX (0 = top, supplementary last; see
// scripts/compute-stacks.mjs). `icon-offset` hangs each pictogram one
// icon-height below the previous. The offset is in the icon's source-pixel
// space (icons are 120 px tall), so it scales with `icon-size` — the column
// stays proportional at every zoom — and, since the tier layers also set
// `icon-rotate`, it rotates with FACE_BEARING so the post leans the way the
// signs face. MVT can't store arrays, so STACK_INDEX is a scalar and `match`
// enumerates the offsets; non-stacked signs have no STACK_INDEX → [0, 0].
// MAX_STACK has headroom over the tallest assembly the data produces
// (compute-stacks logs it — currently 6); a taller stack's overflow members
// fall to the [0, 0] default and pile onto the top sign rather than erroring.
const STACK_GAP = 130
const MAX_STACK = 8
const stackOffset = expr([
  'match', ['get', 'STACK_INDEX'],
  ...Array.from({ length: MAX_STACK }, (_, i) => [i, ['literal', [0, i * STACK_GAP]]]).flat(),
  ['literal', [0, 0]]
])

const tierLayerId = (t: number) => `sign-tier-${t}`
// The SIGNID set per tier is static, so precompute that clause once and only
// swap the (changing) category `base` in the watcher.
const tierClause = TIER_LOD.map(
  (_, t) => ['in', ['get', 'SIGNID'], ['literal', codesByTier[t] ?? []]]
)
const tierFilter = (t: number, base: ExpressionSpecification) =>
  expr(['all', base, tierClause[t]])
// One dot under every sign at all zooms; the pictogram is drawn on top once
// its tier's minzoom is reached. The icon covers the small centred dot, so
// the dot only shows through below the tier's minzoom (collision is disabled,
// so a sign is never dropped once its tier is in range).
const signLayerIds = ['sign-points', ...TIER_LOD.map((_, t) => tierLayerId(t))]

// Shared icon-id prefix: feature SIGNIDs map to `${PICTO_PREFIX}${SIGNID}`
// for every layer that draws a pictogram (tier symbols + selection overlay),
// and the lazy loader strips the prefix back off to fetch the PNG.
const PICTO_PREFIX = 'sign-'
const PICTO_CODES = new Set(codesByTier.flat())

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
  const protocol = new Protocol()
  protocol.add(new PMTiles(new RangeOrWholeSource(lodUrl)))
  protocol.add(new PMTiles(new RangeOrWholeSource(fullUrl)))
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
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
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
    const ATTRIB = 'Traffic sign data © Transport Department, HKSAR'
    m.addSource(SOURCE_LOD, { type: 'vector', url: `pmtiles://${lodUrl}`, attribution: ATTRIB })
    m.addSource(SOURCE_FULL, { type: 'vector', url: `pmtiles://${fullUrl}`, attribution: ATTRIB })

    const circlePaint = {
      // Smaller dots when zoomed out keep dense areas readable.
      'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6, 19, 9]),
      'circle-color': categoryColor,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': expr(['interpolate', ['linear'], ['zoom'], 11, 0.3, 16, 1]),
      'circle-opacity': 0.9
    }

    // Highlight overlay for the sign shown in the detail panel. Added BEFORE
    // the sign layers so they can be inserted beneath `sel-halo` (the
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
        'icon-image': expr(['concat', PICTO_PREFIX, ['get', 'SIGNID']]),
        // Must stay ≥ the largest tier's zoom-ramped size at every zoom
        // (TIER_LOD max is 0.55 at MAX_ZOOM): the selected sign is also
        // drawn by its always-on sign-tier-N layer underneath, so a
        // smaller overlay would let the bigger tier icon poke out as a
        // double image. Slightly above the envelope → it fully covers
        // and reads as one emphasised pictogram in the halo.
        'icon-size': expr([
          'interpolate', ['linear'], ['zoom'], 13, 0.35, MAX_ZOOM, 0.62
        ]),
        ...iconRotation,
        // Track the stack so the emphasis lands on the picked pictogram, not
        // the bottom of the post. (The offset scales with this layer's larger
        // icon-size, so it isn't pixel-identical to the tier pictogram's —
        // close enough to read as one emphasised sign.)
        'icon-offset': stackOffset,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true
      }
    })

    // Pictograms load lazily: MapLibre fires `styleimagemissing` once per
    // unknown icon-image a visible tile references, and we fetch that one
    // PNG on demand. The always-on `sign-points` dot is the fallback while
    // its pictogram is in flight, and uncatalogued SIGNIDs are dropped so
    // selecting one doesn't 404 the same code on every render tick.
    const inFlight = new Set<string>()
    m.on('styleimagemissing', ({ id }) => {
      if (!id.startsWith(PICTO_PREFIX) || inFlight.has(id) || m.hasImage(id)) return
      const code = id.slice(PICTO_PREFIX.length)
      if (!PICTO_CODES.has(code)) return
      inFlight.add(id)
      m.loadImage(`/signs/${code}.png`)
        .then((img) => {
          if (!disposed) m.addImage(id, img.data)
        })
        .catch(err => console.error('[signs]', err))
        .finally(() => inFlight.delete(id))
    })

    // The sign layers — always-on dot + per-tier pictograms — all read
    // whichever archive the active filter mode wants. They're inserted
    // beneath `sel-halo` so selection stays on top, and removed/re-added to
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
      }, 'sel-halo')

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
            'icon-image': expr(['concat', PICTO_PREFIX, ['get', 'SIGNID']]),
            // Normalised first-display height (SIGN_FIRST_SIZE, shared by
            // every tier) at the tier's reveal zoom, ramping up to the
            // tier's "proper" size by max zoom. Safe to grow now that
            // collision is off — it can't push already-shown signs away,
            // and zooming in frees the space to render detail bigger.
            'icon-size': expr([
              'interpolate', ['linear'], ['zoom'],
              lod.minzoom, SIGN_FIRST_SIZE,
              MAX_ZOOM, lod.size
            ]),
            ...iconRotation,
            // Co-located GG_NAME assemblies hang as a vertical signpost: each
            // member is offset one icon-height below the previous (main signs
            // on top, supplementary at the bottom). Non-stacked signs get a
            // [0, 0] offset and render exactly where they always did.
            'icon-offset': stackOffset,
            // Collision disabled outright: every sign must stay exactly where
            // it is and never be dropped or nudged by a neighbour. Each point
            // is a real installed sign with a 1:1 ground meaning, so hiding it
            // (even when icons overlap) breaks the map's contract.
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // Lower tier draws on top, so simple regulatory signs sit above
            // decorative ones where pictograms overlap.
            'symbol-sort-key': t
          },
          'paint': {
            // Collision is off, so signs pile up when zoomed out — and can
            // still overlap even at max zoom. Fade hard while crowded (0.55
            // at z13) so the stack shows through, easing to a 0.9 ceiling
            // (never fully opaque): MapLibre can't tell which signs overlap,
            // so the slight residual transparency keeps any leftover
            // overlap at high zoom legible-through without hurting reading.
            'icon-opacity': expr([
              'interpolate', ['linear'], ['zoom'], 13, 0.55, 17, 0.9
            ])
          }
        }, 'sel-halo')
      })
    }
    const removeSignLayers = () => {
      for (const id of signLayerIds) if (m.getLayer(id)) m.removeLayer(id)
    }
    addSignLayers(sourceForMode(filterMode.value))

    // Category visibility is a GPU-side filter — toggling is instant even
    // across 316k features (no DOM, no data refetch). The pictogram tiers
    // ride the same filter, scoped to their own code set.
    watch(mapFilter, (f) => {
      if (m.getLayer('sign-points')) m.setFilter('sign-points', f)
      TIER_LOD.forEach((_, t) => {
        const ico = tierLayerId(t)
        if (m.getLayer(ico)) m.setFilter(ico, tierFilter(t, expr(f)))
      })
    }, { immediate: true })

    // Flipping between the category and sign-ID tabs swaps which archive the
    // sign layers read. MapLibre can't repoint a live layer's source, so
    // remove and re-add against the right archive — cheap, since this only
    // fires on a tab click. `addSignLayers` re-inserts beneath `sel-halo`, so
    // selection stays on top, and the lazy loader refills icons on demand.
    watch(filterMode, (mode) => {
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
    watch(selectedSign, (s) => {
      sel.setData({
        type: 'FeatureCollection',
        features: s
          ? [{
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [s.lngLat.lng, s.lngLat.lat] },
              properties: s.properties
            }]
          : []
      })
    })
  })

  // A click can land on several overlapping/collided signs. Collect them all
  // and, when the user clicks the same spot again, advance to the next one so
  // every sign under the pointer is reachable despite collision.
  let cycleKey = ''
  let cycleIdx = 0
  const featureKey = (f: MapGeoJSONFeature) => {
    const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates
    const p = f.properties
    return `${lng.toFixed(6)},${lat.toFixed(6)}|${p.SIGNID ?? p.POLEID ?? p.REFNAME ?? ''}|${p.category ?? ''}`
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
      return
    }
    // Same set of hits as the previous click → cycle; otherwise restart.
    const key = hits.map(featureKey).join('~')
    cycleIdx = key === cycleKey ? (cycleIdx + 1) % hits.length : 0
    cycleKey = key

    const f = hits[cycleIdx]
    if (!f) return
    const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates
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
