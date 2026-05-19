// Categories shown in the viewer's legend/filter. A feature is mapped to one
// of these keys by `categoryKeyExpr` in useSignCatalogue (catalogued signs by
// their Index-Plan group; the rest by tile `category`). Anything that maps to
// 'none' — notably the bare "*-sign-pole" classes with no SIGNID — is absent
// here, so the map filter never renders it.

export interface SignCategory {
  key: string
  label: string
  color: string
}

// Keys match the CategoryKey values produced by useSignCatalogue: the five
// Index-Plan classes, plus uncatalogued traffic signs and tourist signs.
export const SIGN_CATEGORIES: SignCategory[] = [
  { key: 'regulatory', label: 'Regulatory', color: '#dc2626' },
  { key: 'warning', label: 'Warning', color: '#f59e0b' },
  { key: 'informatory', label: 'Informatory', color: '#2563eb' },
  { key: 'supplementary', label: 'Supplementary', color: '#0d9488' },
  { key: 'temporary', label: 'Temporary', color: '#ea580c' },
  { key: 'other-traffic', label: 'Other traffic sign', color: '#64748b' },
  { key: 'tourist', label: 'Tourist sign', color: '#9333ea' }
]

// Flat [value, color, value, color, …] list for a MapLibre `match` expression.
export const categoryColorStops = SIGN_CATEGORIES.flatMap(c => [c.key, c.color])
