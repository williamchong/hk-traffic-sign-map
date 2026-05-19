// Display metadata for the 8 sign categories the pipeline tags features with.
// Keys MUST stay in sync with `category` values in scripts/sign-layers.mjs
// (separate runtime: that file is a Node build script, this ships to the
// browser, so the list is intentionally duplicated rather than imported).

export interface SignCategory {
  key: string
  label: string
  color: string
}

export const SIGN_CATEGORIES: SignCategory[] = [
  { key: 'traffic-sign-pole', label: 'Traffic sign pole', color: '#e11d48' },
  { key: 'traffic-sign-abbreviation', label: 'Traffic sign abbreviation', color: '#f59e0b' },
  { key: 'pedestrian-sign-pole', label: 'Pedestrian sign pole', color: '#2563eb' },
  { key: 'directional-sign-pole', label: 'Directional sign pole', color: '#16a34a' },
  { key: 'tourist-sign', label: 'Tourist sign', color: '#9333ea' }
]

// Flat [value, color, value, color, …] list for a MapLibre `match` expression.
export const categoryColorStops = SIGN_CATEGORIES.flatMap(c => [c.key, c.color])

export function useSignCategories() {
  return { categories: SIGN_CATEGORIES }
}
