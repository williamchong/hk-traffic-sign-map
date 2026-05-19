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
// `size` are [zoom, icon-size] stops. Every pictogram is rasterised to the
// same 120px height, so a given icon-size renders every sign at the same
// on-screen height regardless of its shape (a wide plate just gets wider).
// Tier sets that common height: simple signs come in earlier and a touch
// smaller; complex/detailed signs come in later and noticeably bigger so
// their detail stays legible.
export const TIER_LOD = [
  { minzoom: 13, size: [13, 0.20, 16, 0.24, 19, 0.30] },
  { minzoom: 14.5, size: [14.5, 0.26, 17, 0.32, 19, 0.38] },
  { minzoom: 16, size: [16, 0.38, 19, 0.54] }
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
