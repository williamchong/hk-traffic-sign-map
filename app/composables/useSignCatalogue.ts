import catalogueJson from '~/data/signCatalogue.json'

// Real sign pictograms extracted from the TD Index Plan, keyed by SIGNID
// (e.g. "TS101"). `tier` is a visual-complexity band that drives level-of-
// detail; `group` is the Index-Plan drawing-title class (the sheet the sign
// came from), used to filter/colour by sign class.
export type SignGroup
  = 'regulatory' | 'warning' | 'informatory' | 'supplementary' | 'temporary'

export interface SignCatalogueEntry {
  tier: 0 | 1 | 2
  group: SignGroup
}

const catalogue = catalogueJson as Record<string, SignCatalogueEntry>

// Every feature resolves to one category key: a catalogued group, or — via
// the tile `category` — 'tourist' / 'other-traffic'. Poles have no SIGNID
// and no pictogram → 'none', which no filter enables, so they never render.
export type CategoryKey = SignGroup | 'other-traffic' | 'tourist' | 'none'

// Per-tier LOD. `minzoom` is when the pictogram replaces the cheap dot;
// `size` is a CONSTANT icon-size (not zoom-interpolated) on purpose: if it
// grew with zoom, zooming in would enlarge every icon and push already-shown
// signs out by collision. Holding it constant means zooming in only spreads
// points apart, so collisions monotonically decrease and a visible sign never
// disappears as you zoom in. Every pictogram is 120px tall, so one constant
// renders every sign at the same on-screen height; tiers set that height —
// simple signs appear earlier and smaller, complex/detailed ones later and
// bigger so their detail stays legible.
export const TIER_LOD = [
  { minzoom: 13, size: 0.22 },
  { minzoom: 14.5, size: 0.30 },
  { minzoom: 16, size: 0.44 }
] as const

// Codes grouped by tier — used to filter one symbol layer per tier so each
// can carry its own minzoom/size without a per-feature catalogue lookup.
export const codesByTier: readonly (readonly string[])[] = (() => {
  const acc: string[][] = TIER_LOD.map(() => [])
  for (const [code, { tier }] of Object.entries(catalogue)) acc[tier]?.push(code)
  return acc
})()

// Public path of a sign's pictogram, or null if it isn't catalogued. Shared
// by the map (icon registration) and the details panel so the path contract
// lives in one place.
export function signIconUrl(signId: unknown): string | null {
  return typeof signId === 'string' && signId in catalogue
    ? `/signs/${signId}.png`
    : null
}

export const SIGN_GROUPS: readonly SignGroup[]
  = ['regulatory', 'warning', 'informatory', 'supplementary', 'temporary']

// SIGNIDs per group — drives both the colour/filter expression and the
// per-group icon registration.
export const codesByGroup: Record<SignGroup, string[]> = {
  regulatory: [], warning: [], informatory: [], supplementary: [], temporary: []
}
for (const [code, { group }] of Object.entries(catalogue)) {
  codesByGroup[group]?.push(code)
}

// MapLibre expression: a feature → its CategoryKey. Static (the catalogue is
// fixed), so it's built once and reused for colour and the visibility filter.
// SIGNID is only on the abbreviation class; poles fall through to 'none'.
export const categoryKeyExpr: unknown = [
  'case',
  ...SIGN_GROUPS.flatMap(g => [
    ['in', ['get', 'SIGNID'], ['literal', codesByGroup[g]]], g
  ]),
  ['==', ['get', 'category'], 'tourist-sign'], 'tourist',
  ['==', ['get', 'category'], 'traffic-sign-abbreviation'], 'other-traffic',
  'none'
]

// Same classification in JS, for the details panel.
export function categoryKeyOf(props: Record<string, unknown>): CategoryKey {
  const signId = props.SIGNID
  if (typeof signId === 'string') {
    const entry = catalogue[signId]
    if (entry) return entry.group
  }
  if (props.category === 'tourist-sign') return 'tourist'
  if (props.category === 'traffic-sign-abbreviation') return 'other-traffic'
  return 'none'
}
