// Harvest the bilingual sign names published in the Transport Department's
// Road Users' Code, chapter 8 ("The language of the road"), and vendor them as
// a build-time reference for the Chinese side of `app/data/signDescriptions.json`.
//
// Why this source: the Index Plan's Description column is English-only by
// construction (see CLAUDE.md, data pipeline step 5), so nothing the catalogue
// extractor reads can ever yield Chinese. The Road Users' Code is the same
// department describing the same signs, and it publishes each sign as a
// picture with a name, in `en` and `tc` editions of the identical page.
//
// What this script does NOT do is bind a name to a `SIGNID`. The Code's pages
// carry no sign numbers at all, and CLAUDE.md's standing rule — never equate a
// Road Users' Code / Cap 374G figure number with a TD `SIGNID` — means a bind
// has to be earned from evidence. That is `bind-ruc-names.mjs`'s job, and it
// earns it from the pictures.
//
// ⚠ The two language editions do not agree with each other. 71 of the 262
// images are shared verbatim (the `tc` page links them out of
// `/filemanager/en/`), and on several of those the two pages caption the SAME
// file with two different signs — `102c3_n.gif` is a variable speed limit LED,
// correctly captioned 「可變速度限制」 and wrongly captioned "except for access
// if no alternative route"; `104b6_n.gif`/`104b7_n.gif` are taxi and PLB
// parking time plates, again right in Chinese and wrong in English. So the
// English caption is at its least reliable exactly on the rows that were
// revised most recently. It is recorded here as corroboration only; it is
// never the bind.
//
// Output: `data/sign-names/ruc.json` (vendored, reviewed) + the source images
// cached under `data/raw/.ruc-cache` (gitignored) for the binder to compare.
//
// Usage: node scripts/fetch-ruc-names.mjs [--refresh]

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { cacheWrite, makePacer } from './fetch-cache.mjs'

const ORIGIN = 'https://www.td.gov.hk'
const PAGE = `${ORIGIN}/LANG/road_safety/road_users_code/index/chapter_8_the_language_of_the_road/SECTION/index.html`

// Chapter 8's sign-plate sections. Deliberately excludes the sections that are
// not sign plates and so can never resolve to a `SIGNID`: road markings, the
// signal/traffic-light pages, route numbers, and the prose "signing system".
const SECTIONS = [
  'signs_giving_orders_',
  'signs_giving_warning_',
  'signs_giving_information_',
  'temporary_signs_',
  'direction_signs_'
]

const OUT = 'data/sign-names/ruc.json'
export const CACHE = 'data/raw/.ruc-cache'
const FETCH_DELAY_MS = 250 // someone else's web server — be polite

// Where a fetched image lands. Exported because `bind-ruc-names.mjs` has to
// find exactly what this script wrote — two copies of this expression would let
// the cache layout drift on one side and silently starve the binder.
export const cachePathFor = src =>
  path.join(CACHE, src.split('/filemanager/')[1].replace(/\//g, '_'))

const pace = makePacer(FETCH_DELAY_MS)
async function paceFetch(url, { binary = false } = {}) {
  await pace()
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`)
  return binary ? Buffer.from(await r.arrayBuffer()) : await r.text()
}

// Attributes are pulled out of the whole tag rather than matched in a fixed
// order: the two editions were authored at different times and do not order
// `title`/`src`/`alt` consistently, and a fixed-order pattern silently drops
// the rows that differ — which would renumber the list and misalign every
// caption after them.
function imagesIn(html) {
  const out = []
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\bsrc="([^"]*)"/i)?.[1]
    const title = tag.match(/\btitle="([^"]*)"/i)?.[1] ?? tag.match(/\balt="([^"]*)"/i)?.[1]
    if (!src?.includes('/filemanager/') || !title) continue
    out.push({ src, title: title.trim() })
  }
  return out
}

async function section(sec) {
  // Sequential, not `Promise.all`: the pacer stamps its clock after the wait,
  // so two callers entering together compute the same delay and fire as one
  // burst — which is exactly the thing the 250 ms is there to avoid.
  const en = imagesIn(await paceFetch(PAGE.replace('LANG', 'en').replace('SECTION', sec)))
  const tc = imagesIn(await paceFetch(PAGE.replace('LANG', 'tc').replace('SECTION', sec)))

  // The two editions lay the same signs out in the same order, so position is
  // the join. Assert it rather than trust it: a length mismatch means TD has
  // revised one edition and not the other, and every pairing past that point
  // would be off by one — silently attaching the wrong Chinese to a sign.
  if (en.length !== tc.length) {
    console.warn(`  ⚠ ${sec}: en has ${en.length} images, tc has ${tc.length} — SKIPPED (cannot pair by position)`)
    return []
  }

  const rows = en.map((e, i) => ({
    section: sec,
    src: e.src,
    // Set ONLY when the two editions show a genuinely different picture, which
    // the BASENAME decides and the directory does not: measured across all 262
    // rows, every one of the 189 pairs sharing a basename under different
    // language directories is byte-identical, and both pairs with different
    // basenames are different images. Keying on the directory instead marked
    // 191 rows as divergent and cost 189 pointless downloads.
    //
    // It matters to the binder, not just to provenance: where the pictures
    // differ, the Chinese caption describes the CHINESE edition's picture, so
    // that is the image the bind has to be scored against.
    tcSrc: path.basename(tc[i].src) === path.basename(e.src) ? undefined : tc[i].src,
    en: e.title,
    zh: tc[i].title
  }))
  const diverged = rows.filter(r => r.tcSrc).length
  console.error(`  ${sec}: ${rows.length} signs${diverged ? ` (${diverged} showing a different picture per edition)` : ''}`)
  return rows
}

async function cacheImage(src, refresh) {
  const dst = cachePathFor(src)
  if (existsSync(dst) && !refresh) return dst
  try {
    const buf = await paceFetch(ORIGIN + src, { binary: true })
    // TD answers a missing file with a ~1.4 kB HTML error page rather than a
    // 404, so a byte count is not enough — check for an image magic number.
    // Chapter 8 is almost all GIF, but a few later additions are JPEG or PNG.
    const magic = buf.subarray(0, 8)
    const isImage = magic.subarray(0, 3).toString('latin1') === 'GIF'
      || (magic[0] === 0xff && magic[1] === 0xd8)
      || magic.subarray(1, 4).toString('latin1') === 'PNG'
    if (!isImage) {
      console.warn(`  ⚠ not an image: ${src}`)
      return null
    }
    await cacheWrite(dst, buf)
  } catch (e) {
    console.warn(`  ⚠ ${e.message}`)
    return null
  }
  return dst
}

// Guarded so the module can be IMPORTED for `CACHE`/`cachePathFor` without
// running. `bind-ruc-names.mjs` needs the cache layout, and an unguarded
// top-level body meant importing it re-parsed the binder's own flags as this
// script's and started fetching td.gov.hk.
async function main() {
  const { values } = parseArgs({ options: { refresh: { type: 'boolean' } } })

  mkdirSync(CACHE, { recursive: true })
  mkdirSync(path.dirname(OUT), { recursive: true })

  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : []

  console.error('Fetching Road Users\' Code chapter 8 …')
  const rows = []
  for (const sec of SECTIONS) rows.push(...await section(sec))

  const wanted = new Set(rows.flatMap(r => [r.src, r.tcSrc]).filter(Boolean))
  console.error(`Caching ${wanted.size} images …`)
  let cached = 0
  for (const src of wanted) {
    if (await cacheImage(src, values.refresh)) cached++
  }

  // Sort is by page order within section, which is the order a reviewer reads the
  // verify sheet in; the file is vendored, so keep it stable across re-runs.
  writeFileSync(OUT, JSON.stringify(rows, null, 2) + '\n')

  console.error(`\n${rows.length} signs, ${rows.filter(r => r.zh).length} with Chinese, ${cached} images cached`)
  console.error(`→ ${OUT}${prev.length && prev.length !== rows.length ? ` (was ${prev.length} rows)` : ''}`)
  console.error('Next: node scripts/bind-ruc-names.mjs   (proposes SIGNID binds for review)')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
