<script setup lang="ts">
import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'
import { categoryColorStops } from '~/composables/useSignCategories'

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
const map = shallowRef<maplibregl.Map>()

// Colour each feature by its `category` (falls back to grey if unmapped).
// Spreading a string[] into the expression defeats maplibre's tuple typing,
// so widen through `unknown` — the runtime shape is a valid `match`.
const categoryColor = [
  'match', ['get', 'category'],
  ...categoryColorStops,
  '#94a3b8'
] as unknown as maplibregl.ExpressionSpecification

onMounted(() => {
  // pmtiles serves vector tiles out of one static file via HTTP range
  // requests — registered once as a custom maplibre protocol.
  maplibregl.addProtocol('pmtiles', new Protocol().tile)

  const m = new maplibregl.Map({
    container: container.value!,
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

    m.addLayer({
      'id': 'sign-points',
      'type': 'circle',
      'source': TILE_SOURCE,
      'source-layer': SOURCE_LAYER,
      'paint': {
        // Smaller dots when zoomed out keep dense areas readable.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 6, 19, 9],
        'circle-color': categoryColor,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 16, 1],
        'circle-opacity': 0.9
      }
    })

    // Category visibility is a GPU-side filter — toggling is instant even
    // across 316k features (no DOM, no data refetch).
    watch(mapFilter, f => m.setFilter('sign-points', f), { immediate: true })

    watch(() => colorMode.value, (mode) => {
      const dark = mode === 'dark'
      m.setLayoutProperty('basemap-dark', 'visibility', dark ? 'visible' : 'none')
      m.setLayoutProperty('basemap-light', 'visibility', dark ? 'none' : 'visible')
    }, { immediate: true })
  })

  // One click handler: a sign under the cursor selects it, empty space
  // clears the popup.
  m.on('click', (e) => {
    const [hit] = m.queryRenderedFeatures(e.point, { layers: ['sign-points'] })
    selectedSign.value = hit
      ? { properties: hit.properties, lngLat: e.lngLat }
      : null
  })

  m.on('mouseenter', 'sign-points', () => (m.getCanvas().style.cursor = 'pointer'))
  m.on('mouseleave', 'sign-points', () => (m.getCanvas().style.cursor = ''))

  m.on('error', e => console.error('[maplibre]', e.error?.message ?? e))

  map.value = m
})

onBeforeUnmount(() => {
  map.value?.remove()
  maplibregl.removeProtocol('pmtiles')
})

defineExpose({ map })
</script>

<template>
  <div
    ref="container"
    class="h-full w-full"
  />
</template>
