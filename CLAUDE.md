# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

`pnpm` is broken in this environment — always use `corepack pnpm`.

- `corepack pnpm dev` — dev server (http://localhost:3000)
- `corepack pnpm lint` / `corepack pnpm typecheck` — must both pass before any commit
- `corepack pnpm generate` — static build to `.output/public`; also used as the final pre-commit gate (it exercises the SSR/prerender path the dev server doesn't)
- `corepack pnpm data:build` — fetch TD GML + (re)build `public/data/traffic-signs.pmtiles`
- `corepack pnpm data:catalogue` — re-extract sign pictograms + `app/data/signCatalogue.json` from the Index Plan PDFs (Sonnet 4.6 vision; needs `ANTHROPIC_API_KEY`, costs ~$0.15 to rebuild all 16 sheets)

There is no test suite; verification is lint + typecheck + `generate`, plus a real-browser smoke test via the chrome-devtools MCP when map behaviour changes (the map only runs client-side with WebGL).

Dev gotcha: after dependency/cache changes the Vite dep-optimizer can 504 ("Outdated Optimize Dep") and the map never mounts. Fix: kill dev, `rm -rf node_modules/.vite node_modules/.cache .nuxt/cache`, restart.

## Two runtimes — do not cross-import

`scripts/*.mjs` are Node build-time tools; `app/` ships to the browser. Shared constants (tile layer name, category/`SIGNID` conventions) are **intentionally duplicated** across the boundary rather than imported. `app/composables/useSignCategories.ts` keys must stay consistent with the category logic in `useSignCatalogue.ts`; `scripts/sign-layers.mjs` is the manifest the pipeline tags features with.

## Data pipeline (build-time)

1. `fetch-data.mjs` → raw GML into `data/raw/` (gitignored, resumable).
2. `build-tiles.mjs` → `ogr2ogr` reprojects each layer **EPSG:2326 (HK1980 Grid) → EPSG:4326**, injects a `category` property per the `sign-layers.mjs` manifest, then `tippecanoe` packs everything into one `public/data/traffic-signs.pmtiles`. Source id and source-layer are both `signs`. tippecanoe maxzoom settles at 15 (MapLibre overzooms past it — fine for points).
3. `build-sign-catalogue.mjs` (independent) sends each rendered TD **Index Plan** page to Sonnet 4.6, gets back `{code, desc, y}` per row per column-group, then uses page geometry to crop the symbol cell for each code and writes `public/signs/<CODE>.png` + `app/data/signCatalogue.json` (`{ tier, group, desc? }`). Two safety nets enforce the cardinal "a missed sign degrades to a dot — a *mislabelled* sign must never ship" rule:

   - **GML SIGNID filter**: a model-emitted code is only kept if it appears at least once in `data/raw/DTAD_TS_ABV_PT.gml` (the ground-truth set of codes on real road signs in HK). Codes the app would never reference are dropped — loss-less filter that also catches the model's occasional sequential-number hallucinations.
   - **Y-position alignment**: the model emits a `y` hint (row-centre as a fraction of image height) per code; we map it to the nearest detected `rowBand` whose centre is within `pitch * 0.5`. A taken-set + monotone-y check per group means each kept rowBand hosts at most one code and codes can't jump backwards. Out-of-tolerance reads silently degrade to dots.

   Modes: bare `data:catalogue` does a full rebuild merging into the existing catalogue (extra coverage if anything was added by hand). `--wipe` clears `public/signs/` and the catalogue first for a from-scratch build. `--sheet "<pattern>"` processes only matching sheets — surgical iteration without re-OCRing the others. Same prompt also returns the **English description** for each row; the script writes it as `desc` on the catalogue entry. Authoritative bilingual meanings still live in hand-curated `app/data/signDescriptions.json` (`{ "<CODE>": { en?, zh? } }`, sourced from the TD Road Users' Code) which the runtime prefers over `desc` and is edited **independently — no pipeline re-run**. The Road Users' Code figure numbers do **not** map to `SIGNID`, so that file is curated by hand, never auto-derived. Never equate Cap 374G legal figure numbers with TD `SIGNID` above the low regulatory range.

   History (git log): an earlier tesseract + 3-layer-LIS pipeline (`b00a1df`…`f111fd8`) extracted ~457 codes before being replaced by the VLM extractor (`56a1a84` onwards) at 753+ codes, ~$0.15 per full rebuild vs minutes of OCR. The LIS scaffolding became archaeology when the reader's error model changed.

Key dataset fact: **`SIGNID` exists only on the `traffic-sign-abbreviation` class.** Pole classes (`DTAD_TS/PS/DS_POLE_PT`) have no `SIGNID` and no sign content — they are bare posts. Only abbreviation features can resolve to a pictogram; everything that maps to category key `none` (poles) is never rendered.

## Runtime architecture (the part that needs multiple files)

- `useSignCatalogue.ts` is the hub: loads `signCatalogue.json` + `signDescriptions.json`, exposes **`signDescription(signId, locale)`** (curated zh/en override → curated en → OCR `desc` → null; English shows verbatim in the zh UI when no zh override exists), derives `codesByTier`/`codesByGroup`, and exports **`categoryKeyExpr`** — one static MapLibre expression mapping any feature to its category key: a catalogued Index-Plan group (`regulatory|warning|informatory|supplementary|temporary`), else by tile `category` → `tourist`/`other-traffic`, else `none`. `TIER_LOD` defines per-tier `minzoom` and the top-of-ramp `icon-size`; `SIGN_FIRST_SIZE` is the shared normalised height every tier shows at its reveal zoom.
- `useSignCategories.ts` = legend/filter rows + colours, keyed by those category keys.
- `useTrafficLayers.ts` = singleton state: `enabled` per category, `selectedSign`, and `mapFilter` = `['in', categoryKeyExpr, enabledKeys]` — the one filter every layer rides.
- `TrafficMap.vue` builds the map: an always-on `sign-points` circle (coloured by `categoryColor` = `match` on `categoryKeyExpr`) as the baseline marker; per-tier `sign-tier-N` symbol layers (`minzoom` = tier minzoom, `icon-size` ramps from shared `SIGN_FIRST_SIZE` up to the tier size, collision fully disabled); a `sel` GeoJSON highlight overlay (halo+dot+icon) moved to the top on every selection; click collects all signs in a 6px box, de-dupes, and cycles through them on repeat clicks.

### Invariants that caused churn — keep them

- **Collision is disabled** (`icon-allow-overlap`/`icon-ignore-placement` always `true`) because orientation is conveyed by sign rotation, so a sign must never be dropped or nudged by a neighbour. The old "constant `icon-size`, never zoom-interpolated" rule existed *only* to stop growing icons from collision-hiding already-shown signs — with collision off that coupling is gone, so it was deliberately retired. Do not reinstate per-zoom collision.
- `icon-opacity` is **zoom-faded** (0.55 at z13 → 0.9 at z17, held at 0.9 — never fully opaque) on the tier layers. With collision off, signs pile up zoomed out and can still overlap at max zoom; the hard fade lets the stack show through while crowded, and the permanent 0.9 ceiling keeps residual high-zoom overlaps legible-through. Per-*sign* "is it overlapped" opacity is **not expressible in MapLibre** (collision can only hide, not report) — don't attempt it; this fade-by-zoom plus the constant ceiling is the deliberate substitute.
- `icon-size` now ramps per tier: every tier starts at the **shared** `SIGN_FIRST_SIZE` at its reveal `minzoom` (normalised on-screen height — pictograms are all 120px tall) and interpolates up to the tier's `size` at `MAX_ZOOM`. Keep the *first-display* size shared across tiers (visual consistency); only the top-of-ramp size is tier-specific (legibility for complex signs).
- The always-on dot is the fallback so a sign is **never invisible** below its tier's minzoom. This was tried both ways; the always-on dot won because the alternative left a confusing zoom band with neither dot nor sign.
- All instances of a `SIGNID` are in exactly one tier ⇒ one appearance zoom.

## Deployment

Static (`corepack pnpm generate` → `.output/public`). **The host MUST serve HTTP `Range` (`206 Partial Content`)** — PMTiles reads the ~18 MB archive in byte-range slices. GitHub Pages, Cloudflare Pages, Netlify, S3+CloudFront, nginx all do. `nuxt preview` does **not** (returns the whole file with `200`) — local checks only.

Commit style: gitmoji, phase-tagged (see `git log`).
