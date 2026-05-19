<script setup lang="ts">
import type { Map as MaplibreMap, ExpressionSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { categoryColorStops } from '~/composables/useSignCategories'
import { TIER_LOD, codesByTier, categoryKeyExpr } from '~/composables/useSignCatalogue'

// maplibre-gl touches `window` at import time and is large; it's
// dynamically imported inside onMounted so it never enters the SSR pass
// and is code-split out of the initial bundle.
let detachProtocol: (() => void) | undefined

const { mapFilter, selectedSign } = useTrafficLayers()
const colorMode = useColorMode()

const TILE_SOURCE = 'signs'
const SOURCE_LAYER = 'signs' // tippecanoe layer name (see scripts/sign-layers.mjs)

// Hong Kong, centred so most signed road network is in view on load.
const HK_CENTER: [number, number] = [114.155, 22.34]
// Lock the viewport to HK — also caps the basemap/tile working set.
const HK_BOUNDS: [[number, number], [number, number]] = [[113.80, 22.13], [114.45, 22.58]]

const OSM_ATTRIB = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

const container = ref<HTMLDivElement>()
const map = shallowRef<MaplibreMap>()

// Colour each feature by its `category` (falls back to grey if unmapped).
// Spreading a string[] into the expression defeats maplibre's tuple typing,
// so widen through `unknown` — the runtime shape is a valid `match`.
// Colour each feature by its resolved sign-class key (catalogued group, or
// tile category for tourist / uncatalogued), falling back to grey.
const categoryColor = [
  'match', categoryKeyExpr,
  ...categoryColorStops,
  '#94a3b8'
] as unknown as ExpressionSpecification

// maplibre's tuple typing rejects spread/dynamic expressions that are valid at
// runtime; this is the one documented place we widen through `unknown`.
const expr = (e: unknown) => e as ExpressionSpecification

const tierLayerId = (t: number) => `sign-tier-${t}`
const tierDotId = (t: number) => `sign-dot-${t}`
// The SIGNID set per tier is static, so precompute that clause once and only
// swap the (changing) category `base` in the watcher.
const tierClause = TIER_LOD.map(
  (_, t) => ['in', ['get', 'SIGNID'], ['literal', codesByTier[t] ?? []]]
)
const tierFilter = (t: number, base: ExpressionSpecification) =>
  expr(['all', base, tierClause[t]])
// Features whose SIGNID has no pictogram keep the always-on dot; catalogued
// ones get a per-tier dot that ends exactly where the pictogram begins.
const notCatalogued = ['!', ['in', ['get', 'SIGNID'], ['literal', codesByTier.flat()]]]
const uncataloguedFilter = (base: ExpressionSpecification) =>
  expr(['all', base, notCatalogued])
const signLayerIds = [
  'sign-points',
  ...TIER_LOD.map((_, t) => tierDotId(t)),
  ...TIER_LOD.map((_, t) => tierLayerId(t))
]

// Set on teardown so the async pictogram loader doesn't addLayer on a removed map.
let disposed = false

onMounted(async () => {
  const [{ default: maplibregl }, { Protocol }] = await Promise.all([
    import('maplibre-gl'),
    import('pmtiles')
  ])
  // Guard: with <ClientOnly> the container is in the DOM by onMounted, but
  // the dynamic import is async so re-check before constructing.
  if (!container.value) return

  // pmtiles serves vector tiles out of one static file via HTTP range
  // requests — registered once as a custom maplibre protocol.
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  detachProtocol = () => maplibregl.removeProtocol('pmtiles')

  const m = new maplibregl.Map({
    container: container.value,
    center: HK_CENTER,
    zoom: 11,
    minZoom: 9,
    maxZoom: 19,
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

  m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right')
  m.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true
  }), 'top-right')
  m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

  m.on('load', () => {
    m.addSource(TILE_SOURCE, {
      type: 'vector',
      url: `pmtiles://${window.location.origin}/data/traffic-signs.pmtiles`,
      attribution: 'Traffic sign data © Transport Department, HKSAR'
    })

    const circlePaint = {
      // Smaller dots when zoomed out keep dense areas readable.
      'circle-radius': expr(['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6, 19, 9]),
      'circle-color': categoryColor,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': expr(['interpolate', ['linear'], ['zoom'], 11, 0.3, 16, 1]),
      'circle-opacity': 0.9
    }

    // Uncatalogued signs (and pole features with no SIGNID): always a dot.
    m.addLayer({
      'id': 'sign-points',
      'type': 'circle',
      'source': TILE_SOURCE,
      'source-layer': SOURCE_LAYER,
      'filter': uncataloguedFilter(expr(mapFilter.value)),
      'paint': { ...circlePaint }
    })

    // Catalogued signs: a dot only *below* their tier's pictogram minzoom, so
    // the dot vanishes exactly when the real sign appears (no double-draw).
    TIER_LOD.forEach((lod, t) => {
      if (!codesByTier[t]?.length) return
      m.addLayer({
        'id': tierDotId(t),
        'type': 'circle',
        'source': TILE_SOURCE,
        'source-layer': SOURCE_LAYER,
        'maxzoom': lod.minzoom,
        'filter': expr(['all', mapFilter.value, tierClause[t]]),
        'paint': { ...circlePaint }
      })
    })

    // LOD: at each tier's minzoom the pictogram replaces the dot, drawn
    // later/larger the more complex the sign.
    void (async () => {
      try {
        await Promise.all(codesByTier.flat().map(async (code) => {
          const id = `sign-${code}`
          if (m.hasImage(id)) return
          const img = await m.loadImage(`/signs/${code}.png`)
          if (!m.hasImage(id)) m.addImage(id, img.data)
        }))
        if (disposed || !m.getSource(TILE_SOURCE)) return

        TIER_LOD.forEach((lod, t) => {
          if (!codesByTier[t]?.length) return
          m.addLayer({
            'id': tierLayerId(t),
            'type': 'symbol',
            'source': TILE_SOURCE,
            'source-layer': SOURCE_LAYER,
            'minzoom': lod.minzoom,
            'filter': tierFilter(t, expr(mapFilter.value)),
            'layout': {
              'icon-image': expr(['concat', 'sign-', ['get', 'SIGNID']]),
              'icon-size': expr(['interpolate', ['linear'], ['zoom'], ...lod.size]),
              'icon-allow-overlap': false,
              'icon-padding': 2,
              // Lower tier = higher placement priority in a collision, so the
              // simple regulatory signs win over decorative ones.
              'symbol-sort-key': t
            }
          })
        })
      } catch (err) {
        // A missing pictogram or a teardown mid-load just leaves dots.
        console.error('[signs]', err)
      }
    })()

    // Category visibility is a GPU-side filter — toggling is instant even
    // across 316k features (no DOM, no data refetch). The pictogram tiers
    // ride the same filter, scoped to their own code set.
    watch(mapFilter, (f) => {
      m.setFilter('sign-points', uncataloguedFilter(expr(f)))
      TIER_LOD.forEach((_, t) => {
        const dot = tierDotId(t)
        if (m.getLayer(dot)) m.setFilter(dot, expr(['all', f, tierClause[t]]))
        const ico = tierLayerId(t)
        if (m.getLayer(ico)) m.setFilter(ico, tierFilter(t, expr(f)))
      })
    }, { immediate: true })

    watch(() => colorMode.value, (mode) => {
      const dark = mode === 'dark'
      m.setLayoutProperty('basemap-dark', 'visibility', dark ? 'visible' : 'none')
      m.setLayoutProperty('basemap-light', 'visibility', dark ? 'none' : 'visible')
    }, { immediate: true })
  })

  // A sign (dot or pictogram) under the cursor selects it; empty space clears
  // the popup. Querying only existing layers avoids an error before the async
  // tier layers are added.
  m.on('click', (e) => {
    const layers = signLayerIds.filter(id => m.getLayer(id))
    const [hit] = m.queryRenderedFeatures(e.point, { layers })
    selectedSign.value = hit
      ? { properties: hit.properties, lngLat: e.lngLat }
      : null
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
    ref="container"
    class="h-full w-full"
  />
</template>
