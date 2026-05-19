import type { ExpressionSpecification, FilterSpecification, LngLat } from 'maplibre-gl'
import { SIGN_CATEGORIES } from '~/composables/useSignCategories'

// Singleton state (module scope) so the filter panel, popup and the map
// component all share one source of truth without prop drilling.

const enabled = reactive<Record<string, boolean>>(
  Object.fromEntries(SIGN_CATEGORIES.map(c => [c.key, true]))
)

export interface SelectedSign {
  properties: Record<string, unknown>
  lngLat: LngLat
}
const selectedSign = ref<SelectedSign | null>(null)

// With 316k signs, attribute text search isn't actionable (matches stay
// scattered off-screen) and the fields are internal codes — so the only
// filter is category visibility, applied GPU-side via setFilter.
const mapFilter = computed<FilterSpecification>(() => {
  const visible = SIGN_CATEGORIES.filter(c => enabled[c.key]).map(c => c.key)
  return ['in', ['get', 'category'], ['literal', visible]] as ExpressionSpecification
})

export function useTrafficLayers() {
  return {
    categories: SIGN_CATEGORIES,
    enabled,
    selectedSign,
    mapFilter,
    toggleAll(value: boolean) {
      for (const c of SIGN_CATEGORIES) enabled[c.key] = value
    }
  }
}
