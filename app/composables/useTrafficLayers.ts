import type { FilterSpecification, LngLat } from 'maplibre-gl'
import { SIGN_CATEGORIES } from '~/composables/useSignCategories'
import { categoryKeyExpr } from '~/composables/useSignCatalogue'

// Singleton state (module scope) so the filter panel, popup and the map
// component all share one source of truth without prop drilling.

const enabled = reactive<Record<string, boolean>>(
  Object.fromEntries(SIGN_CATEGORIES.map(c => [c.key, true]))
)

export interface SelectedSign {
  properties: Record<string, unknown>
  lngLat: LngLat
  // When a click hits several overlapping signs, which one of how many is
  // shown (1-based). Repeated clicks on the same spot cycle through them.
  index?: number
  total?: number
}
const selectedSign = ref<SelectedSign | null>(null)

// The only filter is category visibility, applied GPU-side via setFilter.
// `categoryKeyExpr` maps each feature to its sign-class key (catalogued group
// or tile category); we keep the ones the user has enabled.
const mapFilter = computed<FilterSpecification>(() => {
  const visible = SIGN_CATEGORIES.filter(c => enabled[c.key]).map(c => c.key)
  return ['in', categoryKeyExpr, ['literal', visible]] as unknown as FilterSpecification
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
