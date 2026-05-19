import catalogueJson from '~/data/signCatalogue.json'

// Real sign pictograms extracted from the TD Index Plan, keyed by SIGNID
// (e.g. "TS101"). `tier` is a visual-complexity band that drives level-of-
// detail: simple iconic signs (roundels, triangles) stay legible small and
// appear early; complex/text-heavy signs appear later and larger.
export interface SignCatalogueEntry {
  tier: 0 | 1 | 2
}

const catalogue = catalogueJson as Record<string, SignCatalogueEntry>

// Per-tier LOD. `minzoom` is when the pictogram replaces the cheap dot;
// `size` are [zoom, icon-size] stops (source plates are 128px, so a size of
// ~0.19 ≈ 24px on screen). Complex signs come in later and bigger so they're
// readable; simple ones come in earlier and smaller because they aren't.
export const TIER_LOD = [
  { minzoom: 13, size: [13, 0.14, 16, 0.24, 19, 0.36] },
  { minzoom: 14.5, size: [14.5, 0.18, 17, 0.30, 19, 0.42] },
  { minzoom: 16, size: [16, 0.26, 19, 0.58] }
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
