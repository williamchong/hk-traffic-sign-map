// Text comparison primitives shared by the two name binds: the Index Plan's
// OCR'd Description column against the vendored reference (`catalogue/names.mjs`)
// and the Road Users' Code's captions against the English we already ship
// (`bind-ruc-names.mjs`).
//
// They live here rather than in `names.mjs` for two reasons. The obvious one is
// that both callers need them. The load-bearing one is that `names.mjs` reaches
// `sheets.mjs` for its paths, and `sheets.mjs` runs `mkdirSync` on the
// extractor's scratch directory AT MODULE LOAD — so importing two string
// helpers from it made the unrelated RUC binder create `data/raw/.sign-cache`
// just by starting up. Nothing in this file touches the disk.
//
// ⚠ `normalise` is tuned for TESSERACT's reading of the printed sheets (broken
// brackets, CAD dashes). The RUC captions are hand-authored HTML and were never
// OCR'd, so they need less of it — but a fold that is merely generous is still
// correct there, and one shared implementation beats two that drift.

// Both the comparison fold (`normalise`) and the shipping fold (`shippable`)
// have to collapse them to ASCII "-", and they have to agree: when only
// `normalise` folded, a row scored `agree` on a dash the shipped text had lost.
export const DASHES = /[‐-―−]/g

// Compare on meaning, not typography: case, the sub-note parentheticals, dash
// and quote variants, and the ½ glyph all differ between our OCR and the list
// without either being wrong.
export function normalise(s) {
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
export const digitsOf = s => (String(s).match(/\d/g) ?? []).join('')
// Allocating: a fresh row array per character. Word repair calls this ~52k times
// per full pass (once per token pair in every alignment cell) and that
// allocation IS the cost — module-scoped scratch buffers with `charCodeAt`
// measured 16.2 → 3.5 ms over those 52k calls. Left as it is on purpose: the
// whole repair pass is 20 ms against a single `tesseract` spawn's 62 ms, in a
// pipeline that spawns two per row over ~1,150 rows, and a shared fixed buffer
// would need a length guard on an unbounded OCR read to buy a fifth of one OCR
// call. If this ever shows up in a profile, the buffers are the lever.
export function levenshtein(a, b) {
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

export function sim(a, b) {
  const n = Math.max(a.length, b.length)
  return n ? 1 - levenshtein(a, b) / n : 1
}
