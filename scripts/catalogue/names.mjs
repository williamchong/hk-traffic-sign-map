// The SECOND bind. The pictogram↔code bind is spatial (symbol and number are
// cropped from the same row band, so they cannot desync) — but a MISREAD number
// still produces a perfectly coherent crop, which is the one failure the
// cardinal rule forbids ("a missed sign degrades to a dot — a mislabelled sign
// must never ship"). So the row's Description is OCR'd too and checked against a
// known list of sign names: a description that matches a DIFFERENT code exposes a
// digit misread, and one that matches this code corroborates it.
//
// The list is the vendored Road Sign Factory snapshot (build-time only, see
// data/sign-names/README.md).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { NAMES_DIR } from './sheets.mjs'

export function loadNames() {
  const names = JSON.parse(readFileSync(join(NAMES_DIR, 'descriptions.json'), 'utf8'))
  const superseded = new Set(JSON.parse(readFileSync(join(NAMES_DIR, 'superseded.json'), 'utf8')))
  const norm = new Map()
  for (const [k, v] of Object.entries(names)) norm.set(k, normalise(v))
  return { names, superseded, norm }
}

// Compare on meaning, not typography: case, the sub-note parentheticals, dash
// and quote variants, and the ½ glyph all differ between our OCR and the list
// without either being wrong.
function normalise(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[[{]/g, '(').replace(/[\]}]/g, ')')
    // Sub-notes go, tolerating a bracket the OCR broke — "STOP (MANUAL }" has to
    // reduce to the same "STOP" the reference's "STOP (MANUAL)" does, or the two
    // read as different signs over a stray glyph.
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/["'‘’“”]/g, '')
    .replace(/½/g, '1/2')
    .replace(/[.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Every digit, in order. Two names that differ only in their digits are two
// DIFFERENT signs — "WEIGHT LIMIT 4 TONNES" vs "… 5.5 TONNES", "10am-8pm" vs
// "10am-9pm" — and on the time-plate and limit families the digits ARE the
// meaning. Levenshtein similarity barely notices a one-digit change (those two
// time plates score ~0.97), so digits get their own comparison. Compared as
// characters, not runs, because OCR splits and joins runs freely ("70" read as
// "7O0" is the same two digits).
const digitsOf = s => (String(s).match(/\d/g) ?? []).join('')
const lettersOf = s => String(s).replace(/[^A-Z]/g, '')

// Did our read merely LOSE digits the reference has, rather than contradict
// them? The sheets' bold CAD "7" reads as "f"/"T"/"Y", so "7am-10pm" comes back
// as "fam-10pm" — every digit we did read is still the reference's, in order.
// That is an OCR shortfall, not a disagreement: ship the reference's wording.
// "10am-8pm" against "10am-9pm" is NOT subsumed, and that is the real conflict.
function digitsSubsumed(ours, theirs) {
  let i = 0
  for (const ch of theirs) if (ch === ours[i]) i++
  return i === ours.length
}

function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length || !b.length) return Math.max(a.length, b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

function sim(a, b) {
  const n = Math.max(a.length, b.length)
  return n ? 1 - levenshtein(a, b) / n : 1
}

// Our own read, tidied for shipping. The Description cell is English-only, so
// anything outside this alphabet came from the OCR guessing at a glyph (the
// sheets' Chinese sub-notes render as noise under `eng`) and is dropped.
const shippable = s => String(s).replace(/[^\w &()'./,:%$-]+/g, ' ').replace(/\s+/g, ' ').trim()

// TD installs `TS2701U`/`N`/`L` for the URBAN / NEW TERRITORIES / LANTAU variants
// of one Index Plan row; the list keys those as `2701-URBAN` etc.
const SUFFIX_ALIAS = { U: '-URBAN', N: '-NT', L: '-LANTAU' }

// Resolve a SIGNID to its list entry. The list has NO bare key for a
// "(DOUBLE SIDES)" row — it keys the two faces (`639L`, `639R`) which carry
// identical text — so a bare base has to fall through to its faces, or every one
// of those rows (636, 639, 649, 651, 653, 659, 660, 691, 694, 2629, 2663, 2668,
// 2674, 2679, 2684, 2691, 3643, 3649, 3650, 3651) would look unknown.
function keyCandidates(code) {
  const key = code.replace(/^TS/, '')
  const m = key.match(/^(\d{2,4})([A-Z])$/)
  if (!m) return [key, `${key}L`, `${key}R`]
  const [, base, suf] = m
  return [key, ...(SUFFIX_ALIAS[suf] ? [base + SUFFIX_ALIAS[suf]] : []), base, `${base}L`, `${base}R`]
}

function lookupName(names, code) {
  for (const t of keyCandidates(code)) {
    if (names[t]) return { key: t, text: names[t] }
  }
  return null
}

// Same key fallthrough for the superseded list, which also keys a double-sided
// row by its faces (`2668L`/`2668R`, never `2668`) — comparing on the bare
// number alone reported three false disagreements on (TS 2601 - 2717).
export function isListedSuperseded(superseded, code) {
  return keyCandidates(code).some(k => superseded.has(k))
}

// Does the list mark this row as printing both faces? Corroboration for the
// geometric split — a split with no such backing is flagged for a harder look in
// verify.png rather than being refused, since the list is a reference, not law.
export function isDoubleSided(names, code) {
  return /DOUBLE SIDES/i.test(lookupName(names, code)?.text ?? '')
}

// Which OTHER list entry does this description name? Used only when the read
// disagrees with its own code — a strong match elsewhere means the CODE was
// misread, not the description.
function bestOtherMatch(norm, ownKey, a) {
  let best = null
  for (const [k, v] of norm) {
    if (k === ownKey || !v) continue
    const s = sim(a, v)
    if (!best || s > best.sim) best = { key: k, sim: s }
  }
  return best
}

// Verdict for one row. `ship` is the English name to write (null = ship the
// pictogram with no description); `withhold` means don't ship the pictogram at
// all — the code itself is in doubt.
export function verdictFor({ names, norm }, code, ocrName) {
  const hit = lookupName(names, code)
  // Nothing to check this row against, so our read is all there is — tidied,
  // since no reference will correct it later.
  if (!hit) return { verdict: 'no-list', ship: shippable(ocrName) || null }
  const a = normalise(ocrName)
  const b = norm.get(hit.key)
  if (!a) return { verdict: 'no-ocr', ship: hit.text, listKey: hit.key }
  const s = sim(a, b)
  const da = digitsOf(a), db = digitsOf(b)
  // CONTRADICTING digits on two otherwise-matching reads is the dangerous case:
  // same family, different member, and the digits are the only discriminator
  // ("SPEED LIMIT 70km/h" vs "…50km/h", "7am-7pm" vs "7am-9pm"). Ship neither
  // wording and flag it.
  //
  // The letters have to match for that to be the story, though. Where they
  // don't, our read simply mangled a letter INTO a digit — "DIRECTION TO
  // PARKING PLACE" comes back as "DIRECTION 10 PARKING PLACE", "GOODS" as
  // "SO0DS" — and there is no rival reading to adjudicate, just noise. Those,
  // and digits we merely failed to read, fall through to `fill`, which ships the
  // reference wording rather than nothing. (Reviewing all 33 flags from a full
  // pass, every one was this: not a single genuine family mix-up.)
  if (da !== db && s >= 0.9 && !digitsSubsumed(da, db) && lettersOf(a) === lettersOf(b)) {
    return { verdict: 'digit-conflict', ship: null, sim: s, listKey: hit.key, listText: hit.text }
  }
  // Ship OUR read only when it matches the reference exactly once normalised, or
  // wholly contains it. Anything short of that, however close, carries OCR
  // debris ("SPEED LIMIT 7O0km/h" scores 0.94), so the reference's clean wording
  // is what ships.
  //
  // Containment matters because the reference abbreviates: it gives TS2148 as
  // `"NO STOPPING" ZONE` where the sheet prints `END OF PLB "NO STOPPING" ZONE`.
  // Scored bluntly that looks like a mismatch, and the misread detector then
  // finds a closer entry among the dozens of near-identical zone signs and
  // withholds a perfectly good pictogram. One read containing the other is
  // corroboration; the longer one is the fuller name. The half-length floor
  // stops a short reference ("GO") from validating a noisy read of it.
  const contains = (x, y) => x.includes(y) && y.length >= x.length * 0.5
  if (a === b || contains(a, b)) return { verdict: 'agree', ship: shippable(ocrName), sim: s, listText: hit.text }
  if (contains(b, a) || s >= 0.6) return { verdict: 'fill', ship: hit.text, sim: s, listKey: hit.key }
  // A description that names a DIFFERENT code exposes a digit misread — the one
  // failure the cardinal rule forbids, since a misread number still yields a
  // perfectly coherent crop. Real ones are far apart, because OCR confuses a
  // digit's SHAPE: 253 read as 293, 430 as 450, 2639 as 2659 — all 20 or 40 out.
  //
  // An alternative one AWAY is a different story, and never withholds. The
  // reference is a hand transcription and can slip a row: it lists the sheet's
  // 2629-2634 (verified against the printed page) as 2630-2635, so every row in
  // that stretch "matches" its successor. Withholding there would drop good
  // pictograms on the strength of someone else's typo.
  const alt = bestOtherMatch(norm, hit.key, a)
  if (alt && alt.sim >= 0.85) {
    const adjacent = Math.abs(parseInt(alt.key, 10) - parseInt(hit.key, 10)) <= 1
    return { verdict: adjacent ? 'shift-suspect' : 'code-misread', ship: null, withhold: !adjacent, altKey: alt.key, sim: alt.sim }
  }
  return { verdict: 'disagree', ship: null, sim: s, listText: hit.text }
}
