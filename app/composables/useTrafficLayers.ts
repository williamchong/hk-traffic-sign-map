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
// The mode SSR/prerender falls back to (no localStorage on the server). The
// panel seeds its hydration-safe tab mirror with the same value, so keep this
// the single source — if the two drift, the tab indicator desyncs on reload.
export const DEFAULT_FILTER_MODE: FilterMode = 'category'
// Persisted across reloads via localStorage.
const filterMode = useLocalStorage<FilterMode>('hk-signs:filter-mode', DEFAULT_FILTER_MODE)

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

// Every member of the selected sign's co-located GG_NAME assembly, ordered
// top-of-post first (by STACK_INDEX), each as a ready-to-select SelectedSign so
// the popup can list the whole signpost and navigate between its signs. Empty
// for a lone sign. Populated by TrafficMap from the active tile source — it
// owns the map and the maplibre LngLat ctor; see its selection watch.
const selectedGroup = ref<SelectedSign[]>([])

// Set by TrafficMap when MapLibre can't initialize WebGL. Shared here so the
// filter panel can drop its now-inert category controls while still showing
// the (WebGL-independent) About/FAQ chrome.
const mapUnavailable = ref(false)

// Lazily-loaded SIGNID → companion GG_NAME[] index (app/data/signGroups.json,
// built by compute-stacks over the stacked assemblies). Only sign-ID mode needs
// it — to complete a matched sign's signpost — so it's dynamic-imported
// (code-split, ~0.2 MB gzip) the first time that mode is active, never in the
// initial bundle. Until it resolves, the filter falls back to plain SIGNID
// matching and widens to include companions once `mapFilter` recomputes.
const signGroupIndex = ref<Record<string, string[]> | null>(null)
let groupIndexPromise: Promise<unknown> | null = null
function loadGroupIndex() {
  if (!groupIndexPromise) {
    groupIndexPromise = import('~/data/signGroups.json')
      .then((m) => { signGroupIndex.value = m.default as Record<string, string[]> })
      .catch((err) => {
        console.warn('[signGroups] index load failed — sign-ID filter won\'t expand matches to whole signposts', err)
        groupIndexPromise = null // drop the cache so a later call retries
      })
  }
  return groupIndexPromise
}

// One MapLibre filter expression, switched by `filterMode`. The category form
// is a flat literal `in`; the sign-ID form `in`-matches the picked SIGNIDs and,
// once the group index is loaded, also admits every co-located post-mate of a
// match (via a `match` on GG_NAME — MapLibre compiles it to an O(1) lookup,
// which matters since a common sign can sit on thousands of posts) so each
// matched sign shows as its whole signpost, not a lone plate.
const mapFilter = computed<FilterSpecification>(() => {
  if (filterMode.value === 'sign-id') {
    const ids = Array.from(enabledSignIds)
    const base = ['in', ['get', 'SIGNID'], ['literal', ids]]
    const idx = signGroupIndex.value
    if (idx && ids.length) {
      const groups = [...new Set(ids.flatMap(id => idx[id] ?? []))]
      if (groups.length) {
        return ['any', base, ['match', ['get', 'GG_NAME'], groups, true, false]] as unknown as FilterSpecification
      }
    }
    return base as unknown as FilterSpecification
  }
  const visible = SIGN_CATEGORIES.filter(c => enabled[c.key]).map(c => c.key)
  return ['in', categoryKeyExpr, ['literal', visible]] as unknown as FilterSpecification
})

export function useTrafficLayers() {
  return {
    categories: SIGN_CATEGORIES,
    enabled,
    selectedSign,
    selectedGroup,
    mapUnavailable,
    mapFilter,
    filterMode,
    enabledSignIds,
    loadGroupIndex,
    toggleAll(value: boolean) {
      for (const c of SIGN_CATEGORIES) enabled[c.key] = value
    }
  }
}
