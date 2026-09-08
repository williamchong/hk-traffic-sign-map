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

import { NAMES_DIR, SUFFIX_ALIAS } from './sheets.mjs'

export function loadNames() {
  const names = JSON.parse(readFileSync(join(NAMES_DIR, 'descriptions.json'), 'utf8'))
  const superseded = new Set(JSON.parse(readFileSync(join(NAMES_DIR, 'superseded.json'), 'utf8')))
  const norm = new Map()
  // Every word the reference corpus uses anywhere — the debris test below asks
  // whether a word we read survives repair without appearing in ANY of the
  // 1,329 descriptions. Road-sign English is a closed vocabulary of a few
  // hundred words, so a word outside all of it is OCR noise, not a rare term.
  const vocab = new Set()
  for (const [k, v] of Object.entries(names)) {
    norm.set(k, normalise(v))
    for (const w of String(v).split(/\s+/)) {
      const core = wordCore(w)
      if (core) vocab.add(core)
    }
  }
  return { names, superseded, norm, vocab }
}

// The sheets set their ranges with an en/em dash and tesseract reads one back.
// Both the comparison fold (`normalise`) and the shipping fold (`shippable`)
// have to collapse them to ASCII "-", and they have to agree: when only
// `normalise` folded, a row scored `agree` on a dash the shipped text had lost.
const DASHES = /[‐-―−]/g

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
    .replace(DASHES, '-')
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

// Allocating: a fresh row array per character. Word repair calls this ~52k times
// per full pass (once per token pair in every alignment cell) and that
// allocation IS the cost — module-scoped scratch buffers with `charCodeAt`
// measured 16.2 → 3.5 ms over those 52k calls. Left as it is on purpose: the
// whole repair pass is 20 ms against a single `tesseract` spawn's 62 ms, in a
// pipeline that spawns two per row over ~1,150 rows, and a shared fixed buffer
// would need a length guard on an unbounded OCR read to buy a fifth of one OCR
// call. If this ever shows up in a profile, the buffers are the lever.
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

// Distance between two reference keys, as printed numbers. Adjacency is what
// separates the reference's own row slip from a real misread, and it is asked
// three times in this file.
const keyDist = (a, b) => Math.abs(parseInt(a, 10) - parseInt(b, 10))

// Our own read, tidied for shipping. The Description cell is English-only, so
// anything outside this alphabet came from the OCR guessing at a glyph (the
// sheets' Chinese sub-notes render as noise under `eng`) and is dropped.
//
// The dash fold has to happen FIRST, and it is not cosmetic: the filter below
// keeps only ASCII "-", so "7am — 7pm" shipped as "7am 7pm", losing the range on
// 45 of 1,143 rows (every time plate, and the "MAIN LINE - LANE GAIN" family).
const shippable = s => String(s).replace(DASHES, '-').replace(/[^\w &()'./,:%$-]+/g, ' ').replace(/\s+/g, ' ').trim()

// A word reduced to what OCR can be judged on: letters and digits, case-folded.
// Punctuation is excluded because it is exactly what the sheets' thin rules and
// the OCR's bracket guesses corrupt — `(EXPRESSWAYS` and `EXPRESSWAYS)` are the
// same word read twice.
function wordCore(w) {
  return String(w).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// How far a word may be from the reference's before repair stops calling it the
// same word. Two edits covers the whole observed range of single-word OCR damage
// on these sheets — SFRVICES, MODIFLED, QUT, NOQ., (7FOLL, MIR) — while three
// already reaches genuinely different words.
const MAX_REPAIR_EDITS = 2

// Line our words up with the reference's, allowing for words either side dropped
// or added. Needleman-Wunsch, with substitution priced by normalised character
// distance so a near-identical word costs almost nothing to pair and an unrelated
// one costs about as much as dropping it. POSITIONAL alignment is the point: a
// nearest-word-anywhere match would happily "repair" ROUTE 3 into ROUTE 5, which
// is precisely the digit swap the rest of this file exists to prevent.
function alignWords(ours, theirs) {
  const n = ours.length, m = theirs.length
  const sub = (i, j) => {
    const a = ours[i], b = theirs[j]
    return a === b ? 0 : 1 - sim(a.toUpperCase(), b.toUpperCase())
  }
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) d[i][0] = i
  for (let j = 1; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub(i - 1, j - 1))
    }
  }
  const pairs = []
  let i = n, j = m
  const near = (x, y) => Math.abs(x - y) < 1e-9
  while (i > 0 && j > 0) {
    if (near(d[i][j], d[i - 1][j - 1] + sub(i - 1, j - 1))) {
      pairs.push([i - 1, j - 1])
      i--
      j--
    } else if (near(d[i][j], d[i - 1][j] + 1)) {
      pairs.push([i - 1, null])
      i--
    } else {
      pairs.push([null, j - 1])
      j--
    }
  }
  while (i > 0) {
    i--
    pairs.push([i, null])
  }
  while (j > 0) {
    j--
    pairs.push([null, j])
  }
  return pairs.reverse()
}

// `agree` ships OUR wording, and the check that earns it is blind in two places:
// `normalise` DELETES every parenthetical before comparing (so "(SCHEDULED
// SFRVICES)" and "(SCHEDULED SERVICES)" are the same string to it), and the
// containment arm tolerates up to half our read being text the reference has no
// word for. Both are deliberate — the parenthetical strip is what lets a sub-note
// the OCR mangled still match, and containment is what keeps our fuller END OF
// PLB "NO STOPPING" ZONE over the reference's abbreviated one. But together they
// mean letter garble ships: 102 of the catalogue's 1,071 agree rows differed from
// the reference, and about a third carried debris a reader can see.
//
// So repair rather than re-decide. Word by word, against the word the reference
// has in that position: within MAX_REPAIR_EDITS it is the same word spelled badly
// and the reference's spelling wins; beyond it, it is OUR word and the sheet's
// phrasing stands. Nothing the reference has and we did not read is inserted —
// that is `fill`'s job, not this one, and our read being SHORTER is not an error
// (TS3613 reads "MERGING AHEAD SIGN ON MAIN LINE" where the reference adds
// "(EXPRESSWAYS)").
//
// Two guards on the swap:
//   - digits are meaning (the doctrine `digit-conflict` enforces), so a word is
//     never repaired into one with different digits.
//   - a difference of case ALONE is the reference's house style, not our error —
//     it transcribes "PUBLiC" — so ours stands, EXCEPT where the word carries a
//     digit, which is the unit case ("1Km", "2KM", "11M" against the reference's
//     "1km", "2km", "11m") and there the reference's SI casing is right.
// A word of ours with no counterpart at all is kept, unless it holds no letter or
// digit: a lone ")" left over once the word before it absorbed its bracket is
// never the sheet's phrasing.
function repairRead(ourText, refText) {
  const ours = String(ourText).split(/\s+/).filter(Boolean)
  const theirs = String(refText).split(/\s+/).filter(Boolean)
  const out = []
  const kept = []
  for (const [oi, ti] of alignWords(ours, theirs)) {
    if (oi === null) continue
    const a = ours[oi]
    if (ti === null) {
      if (wordCore(a)) {
        out.push(a)
        kept.push(a)
      }
      continue
    }
    const b = theirs[ti]
    if (a === b) {
      out.push(a)
      continue
    }
    const caseOnly = a.toUpperCase() === b.toUpperCase()
    const swappable = levenshtein(a, b) <= MAX_REPAIR_EDITS
      && digitsOf(a) === digitsOf(b)
      && (!caseOnly || /\d/.test(a))
    if (swappable) {
      out.push(b)
      continue
    }
    out.push(a)
    if (wordCore(a) && wordCore(a) !== wordCore(b)) kept.push(a)
  }
  return { text: out.join(' '), kept }
}

// What repair could not account for. A word we kept — because the reference had
// no word close to it — that appears NOWHERE in the reference corpus is not the
// sheet's phrasing, it is noise: CVDOECOMWAVS, SOVDBECCWAVES, BTeuUT,
// NIDOCTIANES, CDORILITON:. On a full pass this fires on 34 of 1,071 agree rows
// and every one is genuine debris, because road-sign English reuses a small
// vocabulary — a word outside all 1,329 descriptions is a word nobody wrote.
function debrisIn(vocab, kept) {
  return kept.filter(w => wordCore(w) && !vocab.has(wordCore(w)))
}

// TD installs `TS2701U`/`N`/`L` for the URBAN / NEW TERRITORIES / LANTAU variants
// of one Index Plan row; the list keys those as `2701-URBAN` etc.
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
// Both callers act on the result only at ALT_MIN_SIM or better, so the search
// may skip anything that cannot reach it. Levenshtein is at least the length
// difference, so a length gap wider than this already puts `sim` under the bar —
// the prefilter changes nothing observable and cuts the scan from 7.3 ms to
// 1.6 ms, on a function the arbitration now calls up to three times a row.
const ALT_MIN_SIM = 0.85

function bestOtherMatch(norm, ownKey, a) {
  // On a tie, the NEAREST key: whole families share one text ("LANE DIRECTIONS"
  // is 2601, 2634, 626, 627, …), and which of them is reported decides
  // adjacent-or-not below — the reference's row slip lists 2633's text under
  // 2634, and reporting 2601 for it turned that slip into a "misread" that
  // withheld the plate.
  const nearer = (k, other) => ownKey && keyDist(k, ownKey) < keyDist(other, ownKey)
  let best = null
  for (const [k, v] of norm) {
    if (k === ownKey || !v) continue
    if (Math.abs(a.length - v.length) > (1 - ALT_MIN_SIM) * Math.max(a.length, v.length)) continue
    const s = sim(a, v)
    if (!best || s > best.sim || (s === best.sim && nearer(k, best.key))) best = { key: k, sim: s, text: v }
  }
  // A match only names a code if the wording belongs to ONE code. 546 of the
  // reference's 1,329 keys share their text with another (whole families read
  // "LIGHT SIGNAL" or "DIRECTION TO MASS TRANSIT RAILWAY"), so a perfect score
  // against a shared string says nothing about WHICH code we read — treating it
  // as proof of a misread withholds correct plates for defined-but-unlisted
  // signs, which the catalogue legitimately carries.
  if (best) {
    let seenText = 0
    for (const v of norm.values()) if (v === best.text && ++seenText > 1) break
    best.unique = seenText === 1
  }
  return best
}

// Verdict for one row. `ship` is the English name to write (null = ship the
// pictogram with no description); `withhold` means don't ship the pictogram at
// all — the code itself is in doubt.
export function verdictFor({ names, norm, vocab }, code, ocrName) {
  const hit = lookupName(names, code)
  // A code the reference has never heard of is the case MOST likely to be a
  // misread, not the one to skip the misread check on. The catalogue really is
  // a superset of the list (defined-but-uninstalled signs are legitimate), so
  // an unlisted code is not itself suspicious — but an unlisted code whose
  // description is another code's description is a digit misread, and returning
  // early here shipped exactly that: (TS 206 - 310) reads the bold 5 in 252,
  // 255 and 256 as a 9, and 292/296/299 are all inside the sheet's printed
  // range, so the range gate passes them too. TS296 shipped row 256's TOLL AREA
  // plate and wording; nothing else in the pipeline looks at the number again.
  if (!hit) {
    const a = normalise(ocrName)
    const alt = a ? bestOtherMatch(norm, null, a) : null
    // Same ±1 exemption as the listed branch below: the reference is a hand
    // transcription that slips rows, so a neighbour match is its typo, not ours.
    if (alt?.unique && alt.sim >= ALT_MIN_SIM && keyDist(alt.key, String(code).replace(/^TS/, '')) > 1) {
      return { verdict: 'code-misread', ship: null, withhold: true, altKey: alt.key, sim: alt.sim }
    }
    // Nothing to check this row against, so our read is all there is — tidied,
    // since no reference will correct it later.
    return { verdict: 'no-list', ship: shippable(ocrName) || null }
  }
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
  if (a === b || contains(a, b)) {
    const { text, kept } = repairRead(shippable(ocrName), hit.text)
    // Repair could not place every word: what is left is noise the two blind
    // spots above let through, and our wording cannot be trusted as a whole.
    // The row is still BACKED — the description matched its own code, which is
    // all the misread check ever claimed — so this is not a withhold; it just
    // falls back to the reference's clean wording the way `fill` does, under its
    // own label so the per-sheet summary says how often our read was that noisy.
    const debris = debrisIn(vocab, kept)
    if (debris.length) return { verdict: 'ocr-debris', ship: hit.text, sim: s, listKey: hit.key, debris }
    return { verdict: 'agree', ship: text, sim: s, listText: hit.text }
  }
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
  if (alt && alt.sim >= ALT_MIN_SIM) {
    const adjacent = keyDist(alt.key, hit.key) <= 1
    return { verdict: adjacent ? 'shift-suspect' : 'code-misread', ship: null, withhold: !adjacent, altKey: alt.key, sim: alt.sim }
  }
  return { verdict: 'disagree', ship: null, sim: s, listText: hit.text }
}
