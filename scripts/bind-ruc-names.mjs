// Bind the Road Users' Code's bilingual sign names (harvested by
// `fetch-ruc-names.mjs`) to a TD `SIGNID`, and stage the Chinese wording for
// review before any of it reaches `app/data/signDescriptions.json`.
//
// The bind problem: the Code's pages carry no sign numbers, and CLAUDE.md's
// standing rule forbids equating a Road Users' Code / Cap 374G figure number
// with a `SIGNID` even where one appears. So the bind has to be earned. Two
// independent lines of evidence are available, and they fail in different
// places, which is exactly what makes the pair worth having:
//
//   • THE PICTURE. The Code prints the sign; so does the Index Plan, and
//     `public/signs/<code>.png` is our crop of it. Comparing them is the same
//     oracle `audit-sign-images.mjs` runs against Road Sign Factory's plates.
//     This is the PRIMARY bind — it is the only one that survives the Code's
//     own caption defects. Colour is kept, and it is doing real work: in
//     greyscale "ahead only" ranks 9th among the blue roundels because the
//     arrow is a small share of the pixels, and 1st once the blue is scored.
//   • THE NAME. The Code's English caption against the English we already ship
//     for that code (curated, else the Index Plan's Description column). This
//     is CORROBORATION ONLY. On the `_n` rows — the ones TD revised most
//     recently — the English caption is stale and describes a different sign
//     altogether while the Chinese is correct, so a name-led bind would be
//     wrong precisely where it matters most.
//
// A row ships only on `agree` (both binds land on one code) or a picture match
// strong enough to stand alone, and even then `--commit` is a human saying so
// after reading `verify.png`. `signDescriptions.json` stays a curated file:
// this script proposes, a reviewer disposes.
//
// Usage:
//   node scripts/bind-ruc-names.mjs                 # propose, write nothing
//   node scripts/bind-ruc-names.mjs --commit [--reject TS#,TS#]
//   node scripts/bind-ruc-names.mjs --all           # also show already-curated codes
//   node scripts/bind-ruc-names.mjs --code TS102,TS115

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { magick, requireTool, resolveCjkFont } from './catalogue/proc.mjs'
import { digitsOf, normalise, sim } from './text-similarity.mjs'
import { CACHE, cachePathFor } from './fetch-ruc-names.mjs'

const RUC = 'data/sign-names/ruc.json'
const VECTORS = path.join(CACHE, '_vectors.json')
const SIGNS = 'public/signs'
const CATALOGUE = 'app/data/signCatalogue.json'
const DESCRIPTIONS = 'app/data/signDescriptions.json'
const OUT = 'data/raw/ruc-names'

// Comparison geometry. Both sides are flattened onto white, trimmed to ink and
// squared to one grid, so a 48 px Code GIF and a 120 px Index Plan crop become
// comparable. 16×16 in colour is small enough that all ~1,500 images fit in
// memory as vectors — which is the point: 262 rows × 1,217 plates is 319k
// comparisons, and at one `magick compare` subprocess each that is roughly an
// hour. Done as arithmetic over cached vectors it is under a second.
const GRID = 16
const TRIM_FUZZ = '10%'

// A picture match good enough to bind on its own, and the margin it must hold
// over the runner-up. Both were read off the observed distribution: a correct
// bind lands ~0.14-0.31 and the sign families cluster tightly above that (the
// prohibition roundels sit within 0.03 of each other), so the margin is what
// separates "this sign" from "this family".
const IMAGE_BIND = 0.34
const IMAGE_MARGIN = 0.035
// Aspect ratio gates the candidate list before scoring: a tall time plate and a
// square roundel are never the same sign, and squaring both to one grid throws
// that away.
const AR_TOLERANCE = 0.25
// The name is corroboration, so its bar is high — a loose text match is what
// collapses "taxi stand", "urban taxi stand" and "Lantau taxi stand" onto one
// code.
const NAME_AGREE = 0.72

// This script's verdicts, kept as one object because `names.mjs` defines an
// overlapping but DIFFERENT vocabulary for a different question ('agree',
// 'disagree', 'fill', 'code-misread'…). Two adjacent string universes in one
// feature area is how a typo becomes a silent no-match.
const V = {
  AGREE: 'agree',
  IMAGE_ONLY: 'image-only',
  NAME_ONLY: 'name-only',
  WEAK: 'weak',
  NONE: 'none',
  NO_IMAGE: 'no-image',
  COLLISION: 'collision',
  SHARED_NAME: 'shared-name',
  DUPLICATE_ROW: 'duplicate-row'
}
const SHIPPABLE = [V.AGREE, V.IMAGE_ONLY, V.NAME_ONLY]

const { values } = parseArgs({
  options: {
    commit: { type: 'boolean' },
    all: { type: 'boolean' },
    reject: { type: 'string', multiple: true },
    code: { type: 'string', multiple: true }
  }
})
const splitCodes = v => new Set((v ?? []).flatMap(c => c.split(',')).map(c => c.trim().toUpperCase()).filter(Boolean))
const REJECT = splitCodes(values.reject)
const ONLY = splitCodes(values.code)

requireTool('magick', 'brew install imagemagick')
const font = resolveCjkFont()

if (!existsSync(RUC)) {
  console.error(`Missing ${RUC} — run: node scripts/fetch-ruc-names.mjs`)
  process.exit(1)
}
const ruc = JSON.parse(readFileSync(RUC, 'utf8'))
const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8'))
const curated = JSON.parse(readFileSync(DESCRIPTIONS, 'utf8'))

// ── Image vectors ──────────────────────────────────────────────────────────
// Cached by source path + mtime: the plates change only when the catalogue is
// rebuilt, and re-deriving 1,500 of them costs ~3 `magick` spawns each.
const vectorCache = existsSync(VECTORS) ? JSON.parse(readFileSync(VECTORS, 'utf8')) : {}
// Keys read or written this run. The cache is rewritten from these alone, so a
// code deleted from the catalogue (TS360, TS853) drops out instead of lingering.
const touched = new Set()
let derived = 0

function vectorFor(src) {
  // Keyed on the parameters that DETERMINE the vector, not just the file. With
  // `src` alone, changing GRID leaves every stored entry "valid" at the old
  // length; `rmse` then walks past the end of the shorter side, reads
  // `undefined` and returns NaN, which fails every threshold — so the script
  // would bind nothing at all rather than fail loudly.
  const key = `${src}|${GRID}|${TRIM_FUZZ}`
  try {
    const stamp = statSync(src).mtimeMs
    const hit = vectorCache[key]
    if (hit && hit.stamp === stamp) {
      touched.add(key)
      return hit
    }
    // One invocation for both the trimmed aspect ratio and the pixels:
    // `-write info:-` fires mid-pipeline, before the resize, so stdout is the
    // dimensions followed by exactly GRID×GRID×3 bytes. Writing a temp PNG and
    // re-decoding it twice instead cost three spawns per image over ~1,500
    // images, and measured 2.5× slower over a 200-plate sample. It also
    // removes a single fixed scratch path that two concurrent runs shared.
    const out = magick([src,
      '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
      '-fuzz', TRIM_FUZZ, '-trim', '+repage',
      '-format', '%w %h\n', '-write', 'info:-',
      '-resize', `${GRID}x${GRID}!`, '-depth', '8', 'RGB:-'], { binary: true })
    const bytes = GRID * GRID * 3
    if (out.length < bytes) return null
    const [w, h] = out.subarray(0, out.length - bytes).toString('latin1').trim().split(/\s+/).map(Number)
    if (!w || !h) return null
    const rec = { stamp, ar: w / h, px: out.subarray(out.length - bytes).toString('base64') }
    vectorCache[key] = rec
    touched.add(key)
    derived++
    return rec
  } catch {
    return null
  }
}

// Root-mean-square difference over the RGB grid, on magick's 0..1 scale so the
// thresholds above read the same as `audit-sign-images.mjs`'s.
function rmse(a, b) {
  let acc = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    acc += d * d
  }
  return Math.sqrt(acc / a.length) / 255
}

// ── Our side: the catalogue's plates ───────────────────────────────────────
const ourCodes = readdirSync(SIGNS).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4))
  .filter(c => catalogue[c])
process.stderr.write(`Vectorising ${ourCodes.length} catalogue plates … `)
const plates = []
for (const code of ourCodes) {
  const v = vectorFor(path.join(SIGNS, `${code}.png`))
  if (v) plates.push({ code, ar: v.ar, px: Buffer.from(v.px, 'base64') })
}
console.error(`${plates.length} ok (${derived} newly derived)`)

// The English we already ship for a code, following an alias to its base —
// the same resolution order the runtime's `signDescription()` uses.
function ourEnglish(code) {
  const base = catalogue[code]?.alias ?? code
  return curated[base]?.en ?? catalogue[base]?.desc?.en ?? null
}
const ourNames = new Map(ourCodes.map(c => [c, normalise(ourEnglish(c) ?? '')]).filter(([, n]) => n))

// Digits are the meaning on the limit and time-plate families ("WEIGHT LIMIT 4
// TONNES" vs "5.5 TONNES"), and Levenshtein barely registers a one-digit
// change — so a digit disagreement caps the score below the bar outright.
function nameCandidates(en) {
  const mine = normalise(en)
  if (!mine) return []
  const myDigits = digitsOf(mine)
  return [...ourNames].map(([code, theirs]) => {
    let s = sim(mine, theirs)
    // Containment is corroboration, not identity: the Code writes "no
    // through road" where the Index Plan writes "NO THROUGH ROAD ON LEFT".
    // Scored as a near-match it collapses three distinct signs onto one code,
    // so it is capped below the agreement bar and has to win on margin.
    if (mine && theirs && (theirs.includes(mine) || mine.includes(theirs))) s = Math.max(s, 0.70)
    if (digitsOf(theirs) !== myDigits) s = Math.min(s, 0.5)
    return { code, s }
  }).sort((a, b) => b.s - a.s)
}

// ── Bind ───────────────────────────────────────────────────────────────────
// The picture the Chinese caption describes. Normally both editions print the
// same file, but where they diverge (`tcSrc`) the zh names the tc edition's
// image — scoring our plate against the en one would bind the wrong sign.
// A missing file needs no pre-check: `vectorFor` returns null through its catch.
const captionImage = entry => cachePathFor(entry.tcSrc ?? entry.src)

const rows = []
for (const entry of ruc) {
  const img = captionImage(entry)
  const v = vectorFor(img)
  const row = { ...entry, img, verdict: V.NO_IMAGE, image: [], name: [] }

  if (v) {
    const px = Buffer.from(v.px, 'base64')
    row.image = plates
      .filter(p => Math.abs(p.ar - v.ar) / Math.max(p.ar, v.ar) < AR_TOLERANCE)
      .map(p => ({ code: p.code, r: rmse(px, p.px) }))
      .sort((a, b) => a.r - b.r).slice(0, 5)
      .map(c => ({ ...c, r: +c.r.toFixed(3) }))
  }
  row.name = nameCandidates(entry.en).slice(0, 3).map(c => ({ ...c, s: +c.s.toFixed(3) }))

  const bestImage = row.image[0]
  const bestName = row.name[0]
  const imageMargin = row.image[1] ? row.image[1].r - (bestImage?.r ?? 0) : 1
  const imageStrong = bestImage && bestImage.r <= IMAGE_BIND && imageMargin >= IMAGE_MARGIN
  const nameStrong = bestName && bestName.s >= NAME_AGREE

  if (bestImage && nameStrong && bestImage.code === bestName.code) {
    // Two independent sources, one answer. The strongest evidence available.
    row.verdict = V.AGREE
    row.code = bestImage.code
  } else if (imageStrong && nameStrong && row.image.some(c => c.code === bestName.code)) {
    // The name's pick is in the picture's shortlist — same sign family, and the
    // picture decides which member.
    row.verdict = V.AGREE
    row.code = bestImage.code
  } else if (imageStrong) {
    // The `_n` class: the picture is unambiguous and the Code's English is
    // stale. Proposable, but it is the reviewer who confirms it.
    row.verdict = V.IMAGE_ONLY
    row.code = bestImage.code
  } else if (nameStrong && bestName.s >= 0.95) {
    row.verdict = V.NAME_ONLY
    row.code = bestName.code
  } else {
    row.verdict = bestImage || bestName ? V.WEAK : V.NONE
  }
  rows.push(row)
}

// Trailing 標誌 ("sign") and 告示牌 ("warning notice") are the Code naming the
// artefact, not the meaning — the curated entries already read 「讓路」, not
// 「讓路標誌」. The optional 新 goes with them: TD marks a redrawn plate
// 「停車新標誌」 ("STOP — new sign"), and taking only 標誌 leaves 「停車新」,
// which is not Chinese. 字牌 ("plate") is left alone: on the time plates it IS
// the noun (「的士站時間字牌」).
//
// The trailing 的 goes too, and only after the noun it modified has gone: TD
// writes 「前面有『停車』或『讓路』標誌的告示牌」, where the inner 標誌 is part of
// the meaning and only the final 告示牌 is the artefact. Removing that noun
// strands its possessive, leaving a phrase that ends mid-clause.
const cleanZh = s => String(s).replace(/新?(標誌|告示牌)$/u, '').replace(/的$/u, '').trim()

// Persisted here, before the montage: the review sheet shells out to `magick`
// with a caller-supplied font and can throw, and the vectors are the expensive
// part of the run (~30 s cold) — losing them to a labelling failure means
// re-deriving all ~1,500. Rebuilt from `touched` so a plate that has since left
// the catalogue drops out rather than accumulating.
if (derived) {
  writeFileSync(VECTORS, JSON.stringify(Object.fromEntries(
    [...touched].map(k => [k, vectorCache[k]]))))
}

// A Chinese name is a claim about one sign. Where two Code rows land on the
// same code with DIFFERENT wording, at least one of them is bound wrong — the
// urban / NT / Lantau taxi stands are three signs and one of them is not TS324
// — so neither ships. Identical wording on both is just the Code printing a
// sign twice, and is fine.
const byCode = new Map()
for (const r of rows) {
  if (!r.code) continue
  if (!byCode.has(r.code)) byCode.set(r.code, [])
  byCode.get(r.code).push(r)
}
for (const [code, group] of byCode) {
  if (group.length < 2) continue
  // Compared on the CLEANED name, as the `byName` guard below is: two rows that
  // print one sign and differ only by a decorative 標誌/新 suffix are the Code
  // repeating itself, not two claims in conflict.
  if (new Set(group.map(g => cleanZh(g.zh))).size === 1) {
    for (const g of group.slice(1)) {
      g.verdict = V.DUPLICATE_ROW
      g.code = undefined
    }
    continue
  }
  for (const g of group) {
    g.verdict = V.COLLISION
    g.collidesOn = code
    g.code = undefined
  }
}

// The mirror of a collision, and it catches a different defect. Where one
// Chinese name is claimed by two DIFFERENT codes, the Code has captioned two
// pictures with one name — 「前面有行人在行車道上」 arrived on both the
// pedestrian warning and the cyclist warning, 「前面有超速攝影機」 on both the
// road-hump triangle and the enforcement camera. The picture bind is right in
// each case; TD's caption has slipped a row. One of the two is wrong and
// nothing here can say which, so neither ships.
const byName = new Map()
for (const r of rows) {
  if (!r.code) continue
  const zh = cleanZh(r.zh)
  if (!byName.has(zh)) byName.set(zh, [])
  byName.get(zh).push(r)
}
for (const [, group] of byName) {
  if (group.length < 2) continue
  for (const g of group) {
    g.verdict = V.SHARED_NAME
    g.sharedWith = group.map(o => o.code)
    g.code = undefined
  }
}

const proposals = rows.filter(r => r.code && SHIPPABLE.includes(r.verdict))
  .filter(r => !REJECT.has(r.code))
  .filter(r => ONLY.size === 0 || ONLY.has(r.code))
  .filter(r => values.all || !curated[catalogue[r.code]?.alias ?? r.code]?.zh)

// ── Review sheet ───────────────────────────────────────────────────────────
// One strip per proposal: our plate beside the Code's picture, captioned with
// the code, the verdict and both names. Reading it IS the gate — a reviewer who
// cannot tell from the two pictures that they are the same sign should reject.
mkdirSync(OUT, { recursive: true })
for (const f of readdirSync(OUT).filter(f => f.startsWith('verify') || f.startsWith('_strip_'))) {
  rmSync(path.join(OUT, f))
}

const PAGE_ROWS = 12
const strips = []
for (const [i, r] of proposals.entries()) {
  const strip = path.join(OUT, `_strip_${i}.png`)
  const caption = `${r.code}  [${r.verdict}]  rmse ${r.image[0]?.r ?? '-'}\n`
    + `RUC en: ${r.en}\n`
    + `ours:   ${ourEnglish(r.code) ?? '(none)'}\n`
    + `zh →    ${cleanZh(r.zh)}`
  magick([
    '(', path.join(SIGNS, `${r.code}.png`), '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
    '-resize', 'x110', '-bordercolor', 'white', '-border', '6', ')',
    '(', r.img, '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
    '-resize', 'x110', '-bordercolor', 'white', '-border', '6', ')',
    '+append', '-background', 'white', '-gravity', 'west', '-extent', '300x128',
    '(', '-background', 'white', '-fill', 'black', '-font', font, '-pointsize', '17',
    '-interline-spacing', '3', `label:${caption}`, '-gravity', 'west', '-extent', '760x128', ')',
    '+append', '-bordercolor', '#c8c8c8', '-border', '1', strip
  ])
  strips.push(strip)
}
const pages = []
for (let i = 0; i < strips.length; i += PAGE_ROWS) {
  const page = path.join(OUT, `verify-${String(i / PAGE_ROWS + 1).padStart(2, '0')}.png`)
  magick([...strips.slice(i, i + PAGE_ROWS), '-background', 'white', '-append', page])
  pages.push(page)
}
strips.forEach(f => rmSync(f))

const tally = rows.reduce((a, r) => (a[r.verdict] = (a[r.verdict] ?? 0) + 1, a), {})
console.error(`\n${ruc.length} Road Users' Code rows → ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`)
console.error(`${proposals.length} proposal(s) staged across ${pages.length} review page(s) in ${OUT}/`)

writeFileSync(path.join(OUT, 'proposal.json'), JSON.stringify(
  proposals.map(r => ({ code: r.code, verdict: r.verdict, zh: cleanZh(r.zh), rucEn: r.en, ourEn: ourEnglish(r.code), rmse: r.image[0]?.r })), null, 2) + '\n')

// Everything the binder could not settle, so a reviewer can see what was left
// behind rather than only what was taken.
writeFileSync(path.join(OUT, 'withheld.json'), JSON.stringify(
  rows.filter(r => !proposals.includes(r)).map(r => ({
    verdict: r.verdict, rucEn: r.en, zh: r.zh,
    collidesOn: r.collidesOn, sharedWith: r.sharedWith,
    image: r.image.slice(0, 3), name: r.name.slice(0, 2)
  })), null, 2) + '\n')

if (!values.commit) {
  console.error(`\nReview ${OUT}/verify-*.png, then:`)
  console.error('  node scripts/bind-ruc-names.mjs --commit [--reject TS#,TS#]')
  process.exit(0)
}

// ── Commit ─────────────────────────────────────────────────────────────────
// Only `zh` is written. The English already in the catalogue is our own read of
// the Index Plan, bound to its code by two checks the Code's captions do not
// meet — there is no reason to overwrite it with a caption that is demonstrably
// stale on the newest rows.
let added = 0
const kept = []
for (const r of proposals) {
  const base = catalogue[r.code]?.alias ?? r.code
  const zh = cleanZh(r.zh)
  if (!zh) continue
  const entry = curated[base] ?? (curated[base] = {})
  if (entry.zh === zh) continue
  // Never overwrite curated wording, not even under `--all`. The Code's own
  // transcription has typos — it prints 「只淮向前駛」 for TS106 (淮, a river,
  // for 准, "permit") and 「三輛車」 for TS137's 三輪車 — and the curated value
  // is the one a human already fixed. `--all` exists to SHOW those rows on the
  // review sheet, not to overwrite them.
  if (entry.zh) {
    kept.push(`${base}: kept 「${entry.zh}」 over 「${zh}」`)
    continue
  }
  // `zh` only. The runtime already falls through to the catalogue's `desc.en`
  // when a curated entry has no English (`bilingualDescription`), so copying it
  // here would duplicate the wording into a second file and freeze it there —
  // the copy would not track the next catalogue rebuild.
  entry.zh = zh
  added++
}
const sorted = Object.fromEntries(Object.keys(curated).sort((a, b) =>
  (parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10)) || a.localeCompare(b))
  .map(k => [k, curated[k]]))
writeFileSync(DESCRIPTIONS, JSON.stringify(sorted, null, 2) + '\n')
console.error(`\nWrote ${added} Chinese description(s) → ${DESCRIPTIONS} (${Object.keys(sorted).length} entries total)`)
if (kept.length) {
  console.error(`Left ${kept.length} existing curated description(s) alone:`)
  for (const line of kept) console.error(`  ${line}`)
}
