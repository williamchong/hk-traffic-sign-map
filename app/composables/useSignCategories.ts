// Categories shown in the viewer. The pipeline also tags features with the
// three "*-sign-pole" classes (DTAD_TS/PS/DS_POLE_PT), but those records are
// just bare post locations — no SIGNID, no sign content — so they're
// deliberately omitted here, which filters them out of every layer (the map
// filter only renders categories present in this list).
//
// Keys MUST stay in sync with `category` values in scripts/sign-layers.mjs
// (separate runtime: that file is a Node build script, this ships to the
// browser, so the list is intentionally duplicated rather than imported).

export interface SignCategory {
  key: string
  label: string
  color: string
}

export const SIGN_CATEGORIES: SignCategory[] = [
  { key: 'traffic-sign-abbreviation', label: 'Traffic sign', color: '#f59e0b' },
  { key: 'tourist-sign', label: 'Tourist sign', color: '#9333ea' }
]

// Flat [value, color, value, color, …] list for a MapLibre `match` expression.
export const categoryColorStops = SIGN_CATEGORIES.flatMap(c => [c.key, c.color])
