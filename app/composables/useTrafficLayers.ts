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

// Explicit *denylist* — SIGNIDs the user has chosen to hide. Unlike the
// allowlist it's not mode-specific: it subtracts from whatever the active mode
// shows (category OR sign-id), applied LAST in `mapFilter`. This is the only
// way to truly hide a sign type while its co-located signpost-mates stay
// visible — an allowlist can't (group-expansion would re-admit it on any
// shared post), and "select all then unselect one" both floods the picked-list
// chips and leaks back through that same expansion. Subtracting last sidesteps
// both. Driven from the sign detail panel (see `hideSign`/`unhideSign`).
const hiddenSignIds = reactive(new Set<string>())

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
  // Negative clause, applied last to whatever the mode selects. Null when
  // nothing is hidden so the common case stays the same flat expression.
  const hidden = Array.from(hiddenSignIds)
  const notHidden = hidden.length
    ? ['!', ['in', ['get', 'SIGNID'], ['literal', hidden]]]
    : null
  const subtract = (base: unknown) =>
    (notHidden ? ['all', base, notHidden] : base) as unknown as FilterSpecification

  if (filterMode.value === 'sign-id') {
    const ids = Array.from(enabledSignIds)
    if (!ids.length) {
      // No positive picks: the denylist (if any) IS the whole filter — "show
      // everything except these" (the exclude-only state the detail panel
      // produces); with no denylist either, an empty allowlist shows nothing.
      return (notHidden ?? ['in', ['get', 'SIGNID'], ['literal', []]]) as unknown as FilterSpecification
    }
    const allow = ['in', ['get', 'SIGNID'], ['literal', ids]]
    const idx = signGroupIndex.value
    if (idx) {
      const groups = [...new Set(ids.flatMap(id => idx[id] ?? []))]
      if (groups.length) {
        return subtract(['any', allow, ['match', ['get', 'GG_NAME'], groups, true, false]])
      }
    }
    return subtract(allow)
  }
  const visible = SIGN_CATEGORIES.filter(c => enabled[c.key]).map(c => c.key)
  return subtract(['in', categoryKeyExpr, ['literal', visible]])
})

// Filter actions driven from the sign detail panel. Centralised here (not in
// the popup) so the allowlist/denylist invariants live with the state.

// Add a code to the allowlist. Picking a sign always un-hides it — otherwise
// the denylist would keep subtracting a code the user just asked to see.
function selectSign(id: string) {
  enabledSignIds.add(id)
  hiddenSignIds.delete(id)
}

// "Show only this sign": replace the allowlist with this one code and switch to
// sign-id mode. Switching modes is wanted here — sign-id mode is exactly the
// "show only these abbreviation signs" view.
function filterToSign(id: string) {
  enabledSignIds.clear()
  selectSign(id)
  filterMode.value = 'sign-id'
}

// "Hide this sign": add to the denylist and drop it from the allowlist if it
// was a pick. Deliberately does NOT switch modes — the subtraction works in
// place, so a hide from the category view hides it there (whereas flipping to
// sign-id mode would drop every non-abbreviation sign, since that mode reads
// the abbreviation-only archive).
function hideSign(id: string) {
  hiddenSignIds.add(id)
  enabledSignIds.delete(id)
}

function unhideSign(id: string) {
  hiddenSignIds.delete(id)
}

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
    hiddenSignIds,
    loadGroupIndex,
    selectSign,
    filterToSign,
    hideSign,
    unhideSign,
    toggleAll(value: boolean) {
      for (const c of SIGN_CATEGORIES) enabled[c.key] = value
    }
  }
}
