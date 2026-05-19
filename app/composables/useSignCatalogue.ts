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
