# HK Traffic Sign Map

Interactive, high-performance viewer for every traffic sign the Hong Kong
Transport Department has surveyed, built on
[OpenStreetMap](https://www.openstreetmap.org) and the TD's
[Traffic Aids Drawings (2nd generation) open data](https://data.gov.hk/en-data/dataset/hk-td-tis_16-traffic-aids-drawings-v2).

Rendering uses [MapLibre GL JS](https://maplibre.org) over vector tiles packed
into [PMTiles](https://docs.protomaps.com/pmtiles/) archives, so the whole app
deploys as a static site — no tile server, no database.

## What it shows

- **~179,000 installed signs**, grouped into their Index-Plan classes —
  Regulatory, Warning, Informatory, Supplementary, Temporary, plus Tourist and
  (uncatalogued) Other — each independently toggleable and colour-coded. Bare
  sign poles (no `SIGNID`, no sign content) are not rendered.
- **Real pictograms, not dots.** 1,217 sign plates extracted from the TD Index
  Plan drawings cover **87.7 %** of installed sign features. They reveal by
  complexity tier — simple iconic signs from z13, text-heavy ones from z16 —
  and below that a colour-coded dot always stands in, so a sign is never
  invisible.
- **Which way each sign faces.** Every sign is turned to its real-world
  facing, derived at build time from the directed Road Network centreline that
  hosts its pole (absolute for 97.7 % of signs). Each plate is drawn as if
  tipped flat onto the map, so it reads upright to the drivers it addresses —
  its top points away from them.
- **Signposts, not loose plates.** 34,836 posts carrying 79,201 signs are
  drawn as rigid assemblies: members stack in a column in Index-Plan order
  (main signs first, supplementary last) and 8,725 multi-face posts hang each
  face's column in its own direction, so a back-to-back "Give way | No entry"
  pole reads correctly on the map.
- **Filter by class or by sign number**, with descriptions in English for
  85.9 % of installed sign features and Traditional Chinese for 34.6 %
  (English shows through where no Chinese exists). Matching one sign pulls in
  its whole signpost.
- **Where the rules apply.** A road-rules overlay draws speed limits, bus-only
  lanes, vehicle prohibitions, no-stopping restrictions and pedestrian zones
  along the roads they govern, straight from TD's Road Network data. Clicking a
  line — or a legend row — filters the map to the signs that announce that
  rule, and the popup of a speed-limit, bus-lane, prohibition or no-stopping
  sign shows the rule line it stands beside, where one lies within 15 m.
- **Where minibuses cannot go at all.** "Minibus no-go roads" (on by default)
  pairs TD's public-light-bus prohibitions with a shaded band over the roads
  they seal off — every way in closed by a ban or a turn restriction, like
  Laguna City's Sin Fat Road. That band is derived from TD's own bans over
  TD's network, and its popup says so.

## Prerequisites

Running the app needs only Node.js and [pnpm](https://pnpm.io) (`corepack pnpm`
works without a global install). The build outputs are committed, so **you do
not need any of the tools below to develop or deploy.**

To re-run the tile pipeline:

- [GDAL](https://gdal.org) — `brew install gdal` (`ogr2ogr` and
  `gdaltransform` reproject HK1980 Grid → WGS84)
- [tippecanoe](https://github.com/felt/tippecanoe) — `brew install tippecanoe`

To re-run the sign-pictogram catalogue, additionally:

- `brew install mupdf-tools librsvg imagemagick tesseract`
  — `mutool` renders each Index Plan page to SVG and dumps its ruling-line
  geometry, `rsvg-convert` rasterises it, `magick` crops and normalises the
  plates, and `tesseract` reads the No. and Description columns. Tesseract's
  bundled `snum` digits model is required as a second opinion; if it is
  missing, `brew reinstall tesseract`.

The extractor is fully deterministic — no API key, no model calls, $0 per run.

## Setup

```bash
corepack pnpm install
```

## Development

```bash
corepack pnpm dev        # http://localhost:3000
corepack pnpm lint       # must pass before any commit
corepack pnpm typecheck  # must pass before any commit
corepack pnpm generate   # static build to .output/public — the final gate
```

There is no test suite: verification is lint + typecheck + `generate` (which
exercises the SSR/prerender path the dev server doesn't), plus a real-browser
check when map behaviour changes — the map only runs client-side, with WebGL.

## Data pipeline

```bash
corepack pnpm data:build
```

Downloads the TD sign data and builds both PMTiles archives. Raw downloads are
cached in `data/raw/` (gitignored, resumable); TD publishes updates monthly, so
rerun to refresh. The stages, each runnable on its own:

| Step | Script | What it does |
|---|---|---|
| 1 | `data:fetch` | TD sign GML + Road Network v2 + road markings → `data/raw/` |
| 2 | `data:bearings` | Derives each sign's absolute facing from the directed road centreline hosting its pole |
| 3 | `data:stacks` | Groups signs into signposts and faces; bakes each member's column offset |
| 4 | `data:stacked-icons` | Re-renders in-signpost pictograms to a common width |
| 5 | `data:tiles` | Reprojects, injects facing/stack properties, packs both PMTiles archives |
| 6 | `data:road-rules` | Tiles the Road Network's speed-limit, bus-only-lane, vehicle-prohibition, no-stopping and pedestrian-zone extents, plus the derived minibus cut-off areas, into the road-rules overlay archive |

Two sign archives are built on purpose. `traffic-signs.pmtiles` (~25 MB) is
thinned for the zoomed-out overview; `traffic-signs-full.pmtiles` (~45 MB)
retains every feature so a sign-number filter finds all of them at any zoom.
One pyramid cannot serve both, because tile thinning happens before the
runtime filter is known.

A third, small archive, `road-rules.pmtiles` (~3.9 MB), holds *where a rule
applies*: speed-limit segments, bus-only lanes with their hours, the routes
each vehicle prohibition (public light buses, learner drivers, goods vehicles,
all motor vehicles) covers, no-stopping restrictions by vehicle type, hours
and days, and pedestrian zones. These extents come straight from the
Transport Department's Road Network (2nd generation) layers — the same
package step 2 reads for centrelines — and are never inferred from sign
positions. The one derived layer is `cutoff`: roads public light buses
cannot enter at all — edges of TD's directed centreline graph that, once every
unconditional PLB prohibition is closed and its turn bans applied, can no
longer be reached from the main network. It
has its own cache-buster key because it rebuilds on its own cadence.

**Re-cropping a pictogram invalidates the tiles.** Column offsets are baked
from each plate's pixel dimensions, so a catalogue change means re-running
steps 3–5 (step 2 is pure road geometry and can be skipped).

## Sign catalogue

```bash
corepack pnpm data:catalogue
```

Reads the 16 TD **Index Plan** sheets — tables of `[No. | Symbol |
Description]` — and writes `public/signs/<CODE>.png` plus
`app/data/signCatalogue.json`. The PDFs are vector (a MicroStation export with
zero text operators), so the page is rendered *from its SVG* and the table grid
is read straight from path geometry rather than hunted for in pixels.

The governing rule is **"a missed sign degrades to a dot — a *mislabelled*
sign must never ship."** Every code is bound to its plate by four independent
checks: the printed No. and the pictogram are cropped from the *same* table
row; a range gate rejects reads outside the sheet's printed span; the row's
Description is OCR'd and matched against a reference list, so a description
matching a *different* code exposes a digit misread and withholds the plate;
and duplicate or out-of-order reads are flagged. Numbers are never equated
with Cap 374G legal figure numbers — the two spaces diverge above the low
regulatory range.

Coverage is effectively complete at **87.7 % against an 87.8 % ceiling**: the
remaining 12.2 % is `TSSEPA`, a separator marker with no pictogram to extract.

Useful flags: `--sheet "<pattern>"` limits to matching sheets; `--propose`
stages crops and a `verify.png` triage montage under `data/raw/sign-recovery`
without touching the repo, and `--commit` promotes them (with `--reject`,
`--variants` and `--rebind` as reviewer overrides).

The extracted descriptions are English only — the Index Plan's Description
column has no Chinese on any sheet. Bilingual meanings live separately in
`app/data/signDescriptions.json`, which the runtime prefers over the extracted
text and which is edited independently of any pipeline run.

### Chinese descriptions

```bash
node scripts/fetch-ruc-names.mjs   # vendor the bilingual name list
node scripts/bind-ruc-names.mjs    # propose SIGNID binds for review
```

The TD **Road Users' Code**, chapter 8, prints each sign as a picture with a
name, in English and Traditional Chinese editions of the same page — the one
public source that gives these signs Chinese. It carries no sign numbers, so a
name has to be *bound* to a `SIGNID` rather than looked up, and the binder earns
that bind from the picture: the Code's image is compared against our own crop of
the Index Plan, the same oracle the image audit runs against Road Sign Factory.

The English caption is corroboration only, never the bind, because it is
demonstrably unreliable on exactly the rows that matter. The two editions share
71 image files and caption several of them with two different signs — TD's
`102c3_n.gif` is a variable speed limit, correctly named 「可變速度限制」 and
wrongly named "except for access if no alternative route". Two further guards
withhold on the Code's own row slips: one Chinese name claimed by two codes, or
one code claimed by two names, means a caption has drifted and neither ships.

As with the catalogue, `--commit` is a human confirming a `verify.png` review
sheet. Chinese now covers **34.6 % of installed sign features**, up from 17.4 %.

### Quality audits

Two on-demand oracles, outside both npm chains. Neither modifies a tracked
file unless asked — the image audit writes only into gitignored `data/raw/`,
and the name audit reports unless given `--write`:

```bash
node scripts/audit-sign-images.mjs   # No. ↔ pictogram
node scripts/audit-sign-names.mjs    # No. ↔ description
```

The first cross-checks each shipped plate against a second publisher's image
for the same number, worst-first into a triage montage — the one bind no text
check can make. The second replays the current verdict logic over the
descriptions already in the catalogue, catching rows written by earlier
extractor generations that an ordinary rebuild never revisits.

## Repository layout

`scripts/*.mjs` are Node build-time tools; `app/` ships to the browser. The two
never import each other — shared constants are intentionally duplicated across
the boundary. `app/data/` holds the generated artefacts the runtime reads.

Deeper design notes, and the reasoning behind decisions that are easy to
"fix" back into bugs, are in [`CLAUDE.md`](CLAUDE.md).

## Deployment

```bash
corepack pnpm data:build   # only when refreshing the data
corepack pnpm generate     # static output in .output/public
```

**The host must support HTTP `Range` requests (`206 Partial Content`).**
PMTiles reads the archives in small byte-range slices — that is what keeps the
map fast. GitHub Pages, Cloudflare Pages, Netlify, S3+CloudFront and nginx all
do this by default. The Nuxt Node preview server does **not** (it returns the
whole file with `200`), so use it for local checks only.

## Data attribution

Contains data from the Transport Department of the Government of the Hong Kong
SAR, available under the
[data.gov.hk Terms and Conditions](https://data.gov.hk/en/terms-and-conditions).
Basemap © OpenStreetMap contributors; dark basemap tiles ©
[CARTO](https://carto.com/attributions).

The build-time sign-name reference in `data/sign-names/` is a third-party
transcription used only to validate OCR output; see the README there for its
provenance and the limits on its use.

## Licence

[GPL-3.0](LICENSE).
