// Suffix variants that reuse their base sign's pictogram.
//
// TD's inventory installs TS<n> with a face/zone suffix — TS639L, TS3643B,
// TS2701U — where the Index Plan prints one row for the family. Where the
// catalogue builder can split the row into real per-face plates it does
// (variants.mjs); everything else is the SAME artwork under another code, so it
// gets the base pictogram and an `alias` back-pointer rather than staying
// uncatalogued (which renders as a bare dot).
//
// Worth ~963 installed features today: TS639L 135, TS639R 131, TS636L 79,
// TS694R 67, TS2701N 32, …
//
// Runs after the catalogue build and before compute-sign-shapes, so the copied
// PNGs get classified too.

import { copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readSignIdCounts } from '../geo.mjs'
import { readCatalogue, writeCatalogue } from './store.mjs'
import { ABV_GML, SIGN_SUFFIXES, SIGNS_DIR } from './sheets.mjs'

const VARIANT_RE = new RegExp(`^(TS\\d{2,4})([${SIGN_SUFFIXES}])$`)

if (!existsSync(ABV_GML)) {
  console.warn(`no ${ABV_GML} — skipping variant aliases (run \`corepack pnpm data:fetch\` to enable)`)
  process.exit(0)
}

const catalogue = await readCatalogue()
const counts = await readSignIdCounts(ABV_GML)

// Drop aliases whose base has since left the catalogue, so a rebuild can't leave
// an entry pointing at a pictogram that no longer exists.
let stale = 0
for (const [code, entry] of Object.entries(catalogue)) {
  if (entry.alias && !catalogue[entry.alias]) {
    delete catalogue[code]
    stale++
  }
}

let added = 0, features = 0
for (const [code, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  const m = code.match(VARIANT_RE)
  if (!m || catalogue[code]) continue
  const base = catalogue[m[1]]
  if (!base) continue
  await copyFile(join(SIGNS_DIR, `${m[1]}.png`), join(SIGNS_DIR, `${code}.png`))
  catalogue[code] = { tier: base.tier, group: base.group, alias: m[1], ...(base.superseded ? { superseded: true } : {}) }
  added++
  features += n
}

await writeCatalogue(catalogue)
console.log(`variant aliases: +${added} code(s) covering ${features} installed feature(s)${stale ? `, ${stale} stale removed` : ''}`)
