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
