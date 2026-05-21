// Categories shown in the viewer's legend/filter. A feature is mapped to one
// of these keys by `categoryKeyExpr` in useSignCatalogue (catalogued signs by
// their Index-Plan group; the rest by tile `category`). Anything that maps to
// 'none' — notably the bare "*-sign-pole" classes with no SIGNID — is absent
// here, so the map filter never renders it.

import type { CategoryKey } from '~/composables/useSignCatalogue'

// The 'none' bucket is never rendered, so it has no legend entry — every
// SignCategory must carry a visible CategoryKey.
export type VisibleCategoryKey = Exclude<CategoryKey, 'none'>

export interface SignCategory {
  key: VisibleCategoryKey
  color: string
}

// Keys match the CategoryKey values produced by useSignCatalogue: the five
// Index-Plan classes, plus uncatalogued traffic signs and tourist signs.
// The display label is localized via the i18n key `categories.<key>`.
export const SIGN_CATEGORIES: SignCategory[] = [
  { key: 'regulatory', color: '#dc2626' },
  { key: 'warning', color: '#f59e0b' },
  { key: 'informatory', color: '#2563eb' },
  { key: 'supplementary', color: '#0d9488' },
  { key: 'temporary', color: '#ea580c' },
  { key: 'other-traffic', color: '#64748b' },
  { key: 'tourist', color: '#9333ea' }
]

// Flat [value, color, value, color, …] list for a MapLibre `match` expression.
export const categoryColorStops = SIGN_CATEGORIES.flatMap(c => [c.key, c.color])

// Single source for the "unknown category" colour, shared between the
// MapLibre `match` tail in TrafficMap and the JS-side dot fallbacks in
// SignPopup / SignIdFilterPanel. Picked to read as muted slate against
// both the light and dark basemaps.
export const CATEGORY_FALLBACK_COLOR = '#94a3b8'

const byKey = new Map<VisibleCategoryKey, SignCategory>(
  SIGN_CATEGORIES.map(c => [c.key, c])
)

// O(1) colour lookup by category key with the shared fallback. Use from
// JS; for MapLibre style expressions use `categoryColorStops` instead.
export function categoryColor(key: VisibleCategoryKey): string {
  return byKey.get(key)?.color ?? CATEGORY_FALLBACK_COLOR
}
