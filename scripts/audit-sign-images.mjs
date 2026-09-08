// Cross-check our extracted pictograms against Road Sign Factory's plates.
//
// WHY THIS EXISTS. names.mjs validates the OCR'd `No.` against the row's
// Description — the No.↔DESCRIPTION bind. Nothing validated the
// No.↔PICTOGRAM bind, so a crop taken from the wrong row ships under a
// perfectly corroborated description and every existing defense passes. Two
// live examples found on a 39-code sample: TS256 (description "TOLL AREA",
// pictogram a "P" + lorry) and TS776 (description "800M", pictogram
// "STOP 100 m"). Both had an `agree` name verdict. That is exactly the failure
// the cardinal rule forbids — "a missed sign degrades to a dot, a MISLABELLED
// sign must never ship" — and only a second IMAGE of the sign can catch it.
//
// LICENCE — READ BEFORE CHANGING ANYTHING HERE. roadsignfactory.hk's source
// repo (github.com/G1213123/TrafficSign) carries NO LICENCE. This script is a
// comparison oracle and nothing else: it renders their SVG to a scratch file,
// measures it against ours, and reports. No RSF-derived image may ever reach
// public/signs/ or app/data/ — do not add a "copy the better one" mode. Their
// plates are redrawn in their own editor rather than traced from the Index
// Plan, so they are not authoritative anyway; the printed TD sheet is.
//
// A DISAGREEMENT IS NOT A VERDICT. It means "go look at the printed sheet".
// RSF's numbering has a documented row slip (see data/sign-names/README.md), and
// our plates legitimately lack the borders theirs draw, because the extractor
// floods the white plate away on purpose (commit 01e8f7d). Expect real
// false positives; rank, montage, and let a human read the page.
//
// Deliberately OUTSIDE data:catalogue and data:build — on demand, writes nothing
// to the repo, everything under gitignored data/raw/.
//
// Usage:
//   node scripts/audit-sign-images.mjs                  # audit public/signs/
//   node scripts/audit-sign-images.mjs --staged         # audit data/raw/sign-recovery/
//   node scripts/audit-sign-images.mjs --code TS256     # one code (repeatable, comma-ok)
//   node scripts/audit-sign-images.mjs --top 60         # montage size (default 40)
//   node scripts/audit-sign-images.mjs --refresh        # re-fetch the SVG cache
//
// Tools: brew install librsvg imagemagick

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { identify, magick, requireTool, resolveFont } from './catalogue/proc.mjs'
import { cacheWrite, makePacer } from './fetch-cache.mjs'
import { readCatalogue } from './catalogue/store.mjs'
import { SIGNS_DIR, STAGING, SUFFIX_ALIAS } from './catalogue/sheets.mjs'

const RSF_ORIGIN = 'https://roadsignfactory.hk'
const RSF_INDEX = `${RSF_ORIGIN}/data/signs.json`
// The plates are NOT served at /data/svgs/ directly (that 404s) — the site
// proxies them, and the proxy is the only public route to them.
const rsfAsset = filename => `${RSF_ORIGIN}/api/proxy?asset=${encodeURIComponent(`/data/svgs/${filename}`)}`

const CACHE = 'data/raw/.rsf-cache'
const OUT = 'data/raw/sign-audit'
const FETCH_DELAY_MS = 250 // one-off audit against someone else's endpoint — be polite

// Scratch consumed within a single iteration. Fixed names on purpose: at ~1,200
// codes, `${code}__…` variants would strand thousands of dead files, the exact
// pile-up CLAUDE.md records costing 266 MB in .sign-cache. Only the `__ours` /
// `__rsf` pair survives an iteration, and only for the rows the montage shows.
const SC_OURS_SQ = 'data/raw/sign-audit/_scratch_ours_sq.png'
const SC_REF = 'data/raw/sign-audit/_scratch_rsf.png'
const SC_REF_RAW = 'data/raw/sign-audit/_scratch_rsf_raw.png'
const SC_REF_SQ = 'data/raw/sign-audit/_scratch_rsf_sq.png'

// Both sides are trimmed to ink before anything is measured. RSF renders every
// sign onto a common 566x269 frame, so without the trim every aspect ratio comes
// out 2.11 and the comparison is meaningless.
const TRIM_FUZZ = '8%'
const RENDER_H = 400 // render tall, then downscale — trim on a coarse raster loses thin rules
const CMP_H = 128
const CMP_BOX = '96x96!'

// Verdict bands, calibrated on the sample that found TS256/TS776. Deliberately
// coarse: these rank a review queue, they do not decide anything.
const AGREE_RMSE = 0.25, AGREE_AR = 0.15
const CONFLICT_RMSE = 0.40, CONFLICT_AR = 0.35

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    staged: { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
    code: { type: 'string', multiple: true },
    top: { type: 'string' },
    limit: { type: 'string' }
  }
})
const TOP = Number(values.top ?? 40)
const LIMIT = values.limit ? Number(values.limit) : Infinity
const ONLY = new Set((values.code ?? []).flatMap(c => c.split(',')).map(c => c.trim().toUpperCase()).filter(Boolean))

requireTool('rsvg-convert', 'brew install librsvg')
requireTool('magick', 'brew install imagemagick')
const font = resolveFont()

const paceFetch = makePacer(FETCH_DELAY_MS)

// RSF keys an Index Plan number without the `TS`, and spells the TS2701 variants
// out in full. It has NO bare key for a "(DOUBLE SIDES)" row — only <n>L/<n>R —
// so a bare base of ours has to fall through to that pair (same convention the
// name list uses; see data/sign-names/README.md).
function rsfToSignId(key) {
  for (const [letter, spelled] of Object.entries(SUFFIX_ALIAS)) {
    if (key.endsWith(spelled)) return `TS${key.slice(0, -spelled.length)}${letter}`
  }
  return `TS${key}`
}

async function fetchRsfIndex() {
  const cached = join(CACHE, 'signs.json')
  if (!values.refresh) {
    const hit = await readFile(cached, 'utf8').catch(() => null)
    if (hit) return JSON.parse(hit)
  }
  const res = await fetch(RSF_INDEX)
  if (!res.ok) throw new Error(`RSF index: HTTP ${res.status}`)
  const body = await res.text()
  await cacheWrite(cached, body)
  return JSON.parse(body)
}

// Returns the cached path, or null if the plate could not be fetched.
async function fetchPlate(filename) {
  const dst = join(CACHE, filename)
  if (!values.refresh && existsSync(dst)) return dst
  await paceFetch()
  const res = await fetch(rsfAsset(filename), { headers: { Referer: `${RSF_ORIGIN}/sign-index` } })
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('svg')) {
    console.warn(`⚠ ${filename}: HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`)
    return null
  }
  await cacheWrite(dst, Buffer.from(await res.arrayBuffer()))
  return dst
}

// `magick compare` exits 1 when the images merely DIFFER, which is the normal
// case here — only status 2 is a real failure. The metric goes to stderr.
function rmseOf(a, b) {
  const r = spawnSync('magick', ['compare', '-metric', 'RMSE', a, b, 'null:'], { encoding: 'utf8' })
  if (r.status === 2) return null
  const m = (r.stderr ?? '').match(/\(([\d.]+)\)/)
  return m ? Number(m[1]) : null
}

// Both sides finish identically — trim to ink, normalise height, measure — and
// differ only in how they become a raster, so that is all a caller passes.
function trimAndMeasure(pre, dst) {
  magick([...pre, '-fuzz', TRIM_FUZZ, '-trim', '+repage', '-resize', `x${CMP_H}`, dst])
  return identify(dst)
}

const normalizedOurs = (src, dst) =>
  trimAndMeasure([src, '-background', 'white', '-alpha', 'remove', '-alpha', 'off'], dst)

function normalizedRsf(svg, raw, dst) {
  const r = spawnSync('rsvg-convert', ['-h', String(RENDER_H), '-b', 'white', svg, '-o', raw], { encoding: 'buffer' })
  if (r.status !== 0) return null
  return trimAndMeasure([raw], dst)
}

function squash(src, dst) {
  magick([src, '-colorspace', 'gray', '-resize', CMP_BOX, dst])
}

// Deliberately a separate, coarser vocabulary from names.mjs's text verdicts
// (`agree`/`fill`/`digit-conflict`/`code-misread`/…): these are image-similarity
// bands ranking a review queue, not a decision about what to ship.
function verdictOf(rmse, arDelta) {
  if (rmse === null) return 'no-compare'
  if (rmse < AGREE_RMSE && arDelta < AGREE_AR) return 'agree'
  if (rmse >= CONFLICT_RMSE && arDelta >= CONFLICT_AR) return 'conflict'
  return 'check'
}

// Where our pictograms live. --staged reads the crops a --propose run put up for
// review, so a rebuild can be audited BEFORE it is committed.
async function ourPictograms() {
  if (!values.staged) {
    const files = (await readdir(SIGNS_DIR).catch(() => [])).filter(f => f.endsWith('.png'))
    return new Map(files.map(f => [f.slice(0, -4), join(SIGNS_DIR, f)]))
  }
  // Driven off each sheet's manifest rather than globbing the directory: it also
  // holds review/verify montages and provisional __top/__bottom halves, and
  // those filename conventions are extract.mjs's private business to change.
  const out = new Map()
  for (const dir of (await readdir(STAGING).catch(() => []))) {
    const mf = await readFile(join(STAGING, dir, 'manifest.json'), 'utf8').catch(() => null)
    if (!mf) continue
    for (const add of (JSON.parse(mf).adds ?? [])) out.set(add.code, join(STAGING, dir, `${add.code}.png`))
  }
  return out
}

await mkdir(CACHE, { recursive: true })
await mkdir(OUT, { recursive: true })

const index = await fetchRsfIndex()
const bySignId = new Map()
for (const e of index) bySignId.set(rsfToSignId(e.signNumber), e.filename)

const ours = await ourPictograms()
const catalogue = await readCatalogue()
console.log(`ours: ${ours.size} pictogram(s) from ${values.staged ? STAGING : SIGNS_DIR} | RSF: ${index.length} plate(s)`)

// Candidate RSF plates for one of our codes: the exact key, else — for a bare
// double-sided base, which RSF never keys bare — its L/R pair, best match wins.
const candidatesFor = code => (bySignId.has(code)
  ? [bySignId.get(code)]
  : ['L', 'R'].map(s => bySignId.get(`${code}${s}`)).filter(Boolean))

const rows = []
let noRef = 0, done = 0
for (const [code, file] of ours) {
  if (ONLY.size && !ONLY.has(code)) continue
  if (done >= LIMIT) break
  const cands = candidatesFor(code)
  if (!cands.length) {
    noRef++
    continue
  }
  done++

  const oursN = join(OUT, `${code}__ours.png`)
  let best = null
  try {
    const [ow, oh] = normalizedOurs(file, oursN)
    const arOurs = ow / oh
    squash(oursN, SC_OURS_SQ)

    for (const filename of cands) {
      const svg = await fetchPlate(filename)
      if (!svg) continue
      const dim = normalizedRsf(svg, SC_REF_RAW, SC_REF)
      if (!dim) {
        console.warn(`⚠ ${code}: rsvg-convert failed on ${filename}`)
        continue
      }
      squash(SC_REF, SC_REF_SQ)
      const rmse = rmseOf(SC_OURS_SQ, SC_REF_SQ)
      const arRef = dim[0] / dim[1]
      const arDelta = Math.abs(Math.log(arOurs / arRef))
      const score = (rmse ?? 1) + Math.min(arDelta, 1)
      if (best && score >= best.score) continue
      best = { filename, rmse, arRef, arDelta, score, arOurs }
      // Retain the WINNER's raster. Rendering every candidate to one path left
      // whichever rendered last on disk, so an L/R pair could show one face
      // under the other's label in the montage.
      await copyFile(SC_REF, join(OUT, `${code}__rsf.png`))
    }
  } catch (err) {
    console.warn(`⚠ ${code}: comparison failed — ${err.message.split('\n')[0]}`)
    continue
  }
  if (!best) {
    noRef++
    continue
  }

  rows.push({
    code,
    ref: best.filename,
    verdict: verdictOf(best.rmse, best.arDelta),
    rmse: best.rmse === null ? null : Number(best.rmse.toFixed(3)),
    arOurs: Number(best.arOurs.toFixed(2)),
    arRef: Number(best.arRef.toFixed(2)),
    arDelta: Number(best.arDelta.toFixed(3)),
    score: Number(best.score.toFixed(3)),
    desc: catalogue[code]?.desc?.en ?? null,
    source: file
  })
  if (rows.length % 100 === 0) console.log(`  … ${rows.length} compared`)
}

rows.sort((a, b) => b.score - a.score)
for (const r of rows.slice(TOP)) {
  await rm(join(OUT, `${r.code}__ours.png`), { force: true })
  await rm(join(OUT, `${r.code}__rsf.png`), { force: true })
}
for (const f of [SC_OURS_SQ, SC_REF, SC_REF_RAW, SC_REF_SQ]) await rm(f, { force: true })
const tally = rows.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {})
await writeFile(join(OUT, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: values.staged ? STAGING : SIGNS_DIR,
  compared: rows.length,
  noReference: noRef,
  tally,
  rows
}, null, 2) + '\n')

// Triage montage: worst first, ours beside theirs, so a human reads pictograms
// rather than numbers. This is the artefact to actually look at.
const worst = rows.slice(0, TOP)
if (worst.length) {
  const args = ['montage', '-font', font]
  for (const r of worst) {
    args.push('-label', `${r.code} ${r.verdict} rmse=${r.rmse ?? '?'} ar=${r.arOurs}/${r.arRef}`, join(OUT, `${r.code}__ours.png`))
    args.push('-label', `RSF ${r.ref.replace(/\.svg$/, '')}`, join(OUT, `${r.code}__rsf.png`))
  }
  magick([...args, '-tile', '4x', '-geometry', '260x120+8+8',
    '-background', 'white', '-fill', 'black', '-pointsize', '15', join(OUT, 'verify.png')])
}

console.log(`\ncompared ${rows.length}; no RSF plate for ${noRef}`)
console.log(`verdicts: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`)
console.log(`review ${join(OUT, 'verify.png')} worst-first (${worst.length} shown), full table in ${join(OUT, 'manifest.json')}`)
console.log('A disagreement means "read the printed sheet" — RSF is a cross-check, not the authority.')
