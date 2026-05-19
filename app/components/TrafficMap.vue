<script setup lang="ts">
import type { Map as MaplibreMap, ExpressionSpecification, MapGeoJSONFeature, GeoJSONSource } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { categoryColorStops } from '~/composables/useSignCategories'
import { TIER_LOD, SIGN_FIRST_SIZE, codesByTier, categoryKeyExpr } from '~/composables/useSignCatalogue'

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
  '#94a3b8'
] as unknown as ExpressionSpecification

// maplibre's tuple typing rejects spread/dynamic expressions that are valid at
// runtime; this is the one documented place we widen through `unknown`.
const expr = (e: unknown) => e as ExpressionSpecification

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

    // One dot under every visible sign at all zooms — the baseline marker.
    // Pictogram layers draw on top from their tier's minzoom; the icon covers
    // the small centred dot, so the dot only shows where the sign isn't
    // rendered yet (below its tier's minzoom).
    m.addLayer({
      'id': 'sign-points',
      'type': 'circle',
      'source': TILE_SOURCE,
      'source-layer': SOURCE_LAYER,
      'filter': mapFilter.value,
      'paint': { ...circlePaint }
    })

    // Highlight overlay for the sign shown in the detail panel. Its own
    // GeoJSON source + overlap-allowed layers, raised to the very top on
    // every selection, so the picked sign (especially while cycling through
    // an overlapping cluster) is always visible above the collision soup.
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
        'icon-image': expr(['concat', 'sign-', ['get', 'SIGNID']]),
        'icon-size': 0.4,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true
      }
    })

    // LOD: at each tier's minzoom the pictogram is drawn over the dot,
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
              // Collision disabled outright: orientation is conveyed by sign
              // rotation, so every sign must stay exactly where it is and
              // never be dropped or nudged by a neighbour.
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
      m.setFilter('sign-points', f)
      TIER_LOD.forEach((_, t) => {
        const ico = tierLayerId(t)
        if (m.getLayer(ico)) m.setFilter(ico, tierFilter(t, expr(f)))
      })
    }, { immediate: true })

    watch(() => colorMode.value, (mode) => {
      const dark = mode === 'dark'
      m.setLayoutProperty('basemap-dark', 'visibility', dark ? 'visible' : 'none')
      m.setLayoutProperty('basemap-light', 'visibility', dark ? 'none' : 'visible')
    }, { immediate: true })

    // Mirror the selected sign into the highlight source and lift those
    // layers above everything (incl. the async-added tier layers) so the
    // sign in the panel is always drawn on top.
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
      if (s) for (const id of ['sel-halo', 'sel-dot', 'sel-icon']) m.moveLayer(id)
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
