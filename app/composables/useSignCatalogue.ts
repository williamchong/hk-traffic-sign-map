import catalogueJson from '~/data/signCatalogue.json'
import descOverridesJson from '~/data/signDescriptions.json'

// Real sign pictograms extracted from the TD Index Plan, keyed by SIGNID
// (e.g. "TS101"). `tier` is a visual-complexity band that drives level-of-
// detail; `group` is the Index-Plan drawing-title class (the sheet the sign
// came from), used to filter/colour by sign class.
export type SignGroup
  = 'regulatory' | 'warning' | 'informatory' | 'supplementary' | 'temporary'

export interface SignCatalogueEntry {
  tier: 0 | 1 | 2
  group: SignGroup
  // Bilingual meaning extracted from the Index Plan Description column by the
  // catalogue builder. Same `{en?, zh?}` shape as `signDescriptions.json`
  // (which still wins at runtime when curated). Legacy entries from older
  // builds may carry a bare string here — treated as `{en: <string>}` by
  // `signDescription` below. The fields are independent: a sign can have
  // English-only, Chinese-only, both, or neither.
  desc?: string | { en?: string, zh?: string }
}

const catalogue = catalogueJson as Record<string, SignCatalogueEntry>

// Hand-curated, authoritative meanings from the TD Road Users' Code, keyed by
// SIGNID. Wins over the OCR `desc` and carries the zh-HK wording. Extend this
// file alone (no pipeline re-run) as more signs are matched to the Code.
const descOverrides = descOverridesJson as Record<
  string, { en?: string, zh?: string }
>

// Every feature resolves to one category key: a catalogued group, or — via
// the tile `category` — 'tourist' / 'other-traffic'. Poles have no SIGNID
// and no pictogram → 'none', which no filter enables, so they never render.
export type CategoryKey = SignGroup | 'other-traffic' | 'tourist' | 'none'

// Every pictogram is authored 120px tall, so on-screen height is purely
// `icon-size`. At the moment a tier's pictogram first replaces the cheap dot
// (its `minzoom`) every sign is rendered at the SAME shared height —
// `SIGN_FIRST_SIZE` — for visual consistency across tiers. From there the
// icon ramps up to the tier's `size` (its "proper", legible height) by max
// zoom: collision is disabled, so growing icons can no longer push
// already-shown signs out of view, and zooming in spreads points apart,
// freeing the space to draw each sign bigger. Tiers still differ at the top
// of the ramp — simple signs appear earlier and stay compact, complex ones
// appear later and grow larger so their detail stays readable.
export const SIGN_FIRST_SIZE = 0.16
export const TIER_LOD = [
  { minzoom: 13, size: 0.30 },
  { minzoom: 14.5, size: 0.40 },
  { minzoom: 16, size: 0.55 }
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

// Both languages a sign has, regardless of UI locale. Curated overrides
// still win per-language so a hand-edited zh wording never gets clobbered
// by a VLM-extracted one; the catalogue's bilingual `desc` fills gaps the
// curated file hasn't reached. Useful when both languages are needed at
// once — e.g. building a search index that should match either.
export function bilingualDescription(
  signId: unknown
): { en?: string, zh?: string } {
  if (typeof signId !== 'string') return {}
  const o = descOverrides[signId] ?? {}
  // Legacy entries had `desc: string` (English only). Newer entries are
  // `{ en?, zh? }`. Normalise once so the merge below is symmetric.
  const c = catalogue[signId]?.desc
  const cat = typeof c === 'string' ? { en: c } : (c ?? {})
  return { en: o.en ?? cat.en, zh: o.zh ?? cat.zh }
}

// A sign's human meaning for the given UI locale. Resolution order:
//   curated zh (if zh UI) → catalogue zh (if zh UI) → curated en →
//   catalogue en → null. English shows verbatim in the zh UI when neither
// source has zh — source beats an empty field.
export function signDescription(
  signId: unknown,
  locale: 'en' | 'zh-HK'
): string | null {
  const { en, zh } = bilingualDescription(signId)
  if (locale === 'zh-HK') return zh || en || null
  return en || null
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
