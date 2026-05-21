import { useLocalStorage } from '@vueuse/core'
import type { FilterSpecification, LngLat } from 'maplibre-gl'
import { SIGN_CATEGORIES } from '~/composables/useSignCategories'
import { categoryKeyExpr } from '~/composables/useSignCatalogue'

// Singleton state (module scope) so the filter panel, popup and the map
// component all share one source of truth without prop drilling.

// Two filter modes, exposed as tabs in the panel. They're MUTUALLY EXCLUSIVE —
// only the active mode's expression feeds the map's setFilter. Keeping both
// modes' state alive (rather than wiping on switch) means toggling tabs is
// non-destructive: a user's sign-ID picks survive a detour through the
// category tab and vice versa.
export type FilterMode = 'category' | 'sign-id'
// Persisted across reloads via localStorage; SSR falls back to 'category'.
const filterMode = useLocalStorage<FilterMode>('hk-signs:filter-mode', 'category')

const enabled = reactive<Record<string, boolean>>(
  Object.fromEntries(SIGN_CATEGORIES.map(c => [c.key, true]))
)

// Explicit allowlist used in 'sign-id' mode.
const enabledSignIds = reactive(new Set<string>())

export interface SelectedSign {
  properties: Record<string, unknown>
  lngLat: LngLat
  // When a click hits several overlapping signs, which one of how many is
  // shown (1-based). Repeated clicks on the same spot cycle through them.
  index?: number
  total?: number
}
const selectedSign = ref<SelectedSign | null>(null)

// Set by TrafficMap when MapLibre can't initialize WebGL. Shared here so the
// filter panel can drop its now-inert category controls while still showing
// the (WebGL-independent) About/FAQ chrome.
const mapUnavailable = ref(false)

// One MapLibre filter expression, switched by `filterMode`. Both forms are
// flat literal `in` expressions — MapLibre evaluates them per-feature on the
// GPU; arrays of a few thousand IDs are well within its happy path.
const mapFilter = computed<FilterSpecification>(() => {
  if (filterMode.value === 'sign-id') {
    const ids = Array.from(enabledSignIds)
    return ['in', ['get', 'SIGNID'], ['literal', ids]] as unknown as FilterSpecification
  }
  const visible = SIGN_CATEGORIES.filter(c => enabled[c.key]).map(c => c.key)
  return ['in', categoryKeyExpr, ['literal', visible]] as unknown as FilterSpecification
})

export function useTrafficLayers() {
  return {
    categories: SIGN_CATEGORIES,
    enabled,
    selectedSign,
    mapUnavailable,
    mapFilter,
    filterMode,
    enabledSignIds,
    toggleAll(value: boolean) {
      for (const c of SIGN_CATEGORIES) enabled[c.key] = value
    }
  }
}
