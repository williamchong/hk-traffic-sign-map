import type { CategoryKey } from '~/composables/useSignCatalogue'
import type { FilterMode } from '~/composables/useTrafficLayers'

// The @nuxt/scripts proxy queues calls placed before gtag.js loads and
// replays them on hydration, so call sites don't need to gate on readiness.

type ThemeMode = 'light' | 'dark' | 'system'

// One entry per custom GA4 event the app fires. Keeping this exhaustive
// makes `track()` autocomplete the name and enforce the param shape, the
// same pattern the rest of the app uses for sign groups and category keys.
interface AnalyticsEvents {
  sign_select: { sign_id: string | null, category: CategoryKey, cluster_size: number, zoom: number }
  filter_category_toggle: { category: CategoryKey, enabled: boolean }
  filter_toggle_all: { enabled: boolean }
  filter_mode_switch: { mode: FilterMode }
  filter_signid_toggle: { sign_id: string, enabled: boolean }
  filter_signid_bulk: { count: number, enabled: boolean }
  filter_signid_clear: undefined
  filter_signid_only: { sign_id: string }
  filter_signid_hide: { sign_id: string }
  filter_signid_unhide: { sign_id: string }
  locale_switch: { from: string, to: string }
  theme_change: { mode: ThemeMode }
  info_open: undefined
  map_init_failed: undefined
}

export function useAnalytics() {
  const ga = useScriptGoogleAnalytics()

  function track<K extends keyof AnalyticsEvents>(
    name: K,
    ...[params]: AnalyticsEvents[K] extends undefined ? [] : [AnalyticsEvents[K]]
  ) {
    ga.proxy.gtag('event', name, params)
  }

  return { track }
}
