# HK Traffic Sign Map

Interactive, high-performance viewer for Hong Kong traffic signs, built on
[OpenStreetMap](https://www.openstreetmap.org) and the Transport Department's
[Traffic Aids Drawings (2nd generation) open data](https://data.gov.hk/en-data/dataset/hk-td-tis_16-traffic-aids-drawings-v2).

Rendering uses [MapLibre GL JS](https://maplibre.org) with vector tiles packed
into a single [PMTiles](https://docs.protomaps.com/pmtiles/) file, so the whole
app deploys as a static site with no tile server or database.

## Prerequisites

- Node.js + [pnpm](https://pnpm.io) (`corepack pnpm` works without a global install)
- For the data pipeline (Phase 1):
  - [GDAL](https://gdal.org) — `brew install gdal` (provides `ogr2ogr` for
    reprojecting HK1980 Grid → WGS84)
  - [tippecanoe](https://github.com/felixlaumon/tippecanoe) — `brew install tippecanoe`
    (builds the vector tiles / PMTiles)
- For the sign-pictogram catalogue (optional; the committed
  `public/signs/` + `app/data/signCatalogue.json` are already built):
  - [Poppler](https://poppler.freedesktop.org) — `brew install poppler`
    (`pdftoppm` rasterises the Index Plan PDFs)
  - [ImageMagick](https://imagemagick.org) — `brew install imagemagick`
  - [Tesseract](https://github.com/tesseract-ocr/tesseract) — `brew install tesseract`

## Setup

```bash
pnpm install
```

## Data pipeline

Download the TD sign data and build `public/data/traffic-signs.pmtiles`:

```bash
pnpm data:build
```

Source data is updated monthly; rerun to refresh. Raw downloads are cached in
`data/raw/` (gitignored).

### Sign pictograms

Above zoom ~13 catalogued signs render as their real pictogram instead of a
coloured dot, with per-complexity level-of-detail (simple iconic signs appear
earlier and smaller; complex/text signs later and larger). The pictograms and
`app/data/signCatalogue.json` are committed, so this step is only needed to
extend coverage:

```bash
pnpm data:catalogue
```

This rasterises the TD **Index Plan** PDFs, auto-detects the table grid (no
hand-tuned pixel constants), and crops each cell to `public/signs/<CODE>.png`.
Code and pictogram come from the *same cell*, so the binding is exact — we
never equate the Cap 374G legal figure numbers with the TD `SIGNID` space
(they diverge above the low regulatory range). A QA contact sheet is written to
`/tmp/sign-catalogue-qa.png` — eyeball it before trusting new output.

**Adding more sign sheets:** drop the PDF path and its title's numeric range
into the `SHEETS` array in `scripts/build-sign-catalogue.mjs`. The range guard
discards any OCR misread outside that span (a missed sign degrades to a dot; a
mislabelled sign must never ship). Currently seeded: the regulatory
`TS 101–205` sheet.

## Development

```bash
pnpm dev      # http://localhost:3000
pnpm build    # production build
pnpm preview  # preview the production build
```

## Deployment

Build a static site and host it on any static/CDN provider:

```bash
pnpm data:build   # produce public/data/traffic-signs.pmtiles
pnpm generate     # static output in .output/public
```

**The host must support HTTP `Range` requests (`206 Partial Content`).**
PMTiles reads the 18 MB archive in small byte-range slices — that is what
keeps the map fast. Cloudflare Pages, Netlify, S3+CloudFront and nginx all
do this by default. The Nuxt Node preview server does **not** (it returns
the whole file with `200`), so use it for local checks only, not as a
production host.

## Data attribution

Contains data from the Transport Department of the Government of the Hong Kong
SAR, available under the
[data.gov.hk Terms and Conditions](https://data.gov.hk/en/terms-and-conditions).
Basemap © OpenStreetMap contributors.
