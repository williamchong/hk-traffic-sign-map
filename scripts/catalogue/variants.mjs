// "(DOUBLE SIDES)" rows: one printed number, two stacked pictograms.
//
// TD installs these as TS<n>L and TS<n>R (1,552 features across the L/R/T/B/F/U/N
// suffixes), but the Index Plan prints ONE row for the pair, so a single crop of
// the cell yields a two-plate image that belongs to neither code. This splits the
// cell at the gap between the plates and works out which face each half is.
//
// The order is NOT fixed — on (TS 2601 - 2717) every such row is top=RIGHT /
// bottom=LEFT, while on (TS 601 - 700) rows 649/651/653/659 are top=LEFT and
// 660/691/694 are top=RIGHT — so the direction has to be measured per plate, not
// assumed from position. These plates are chevron-ended: the pointed end tapers,
// so its outer column carries less of the silhouette than the flat end's.
//
// The vendored name list gives L and R IDENTICAL text, so it cannot check this
// assignment. The human gate (`--variants TS2663=RL`) is the only real check —
// which is exactly where "a mislabelled sign must never ship" bites hardest.

import { join } from 'node:path'

import { identify, magick } from './proc.mjs'
import { inkMask, pageColor, silhouetteProfile, silhouetteOf, trimToPage } from './normalize.mjs'
import { SCRATCH, SIGN_SUFFIXES } from './sheets.mjs'

const EDGE_FRAC = 0.08 // outer slice of a plate compared for taper
const GAP_MAX = 0.05 // silhouette coverage a row must be under to count as gap
const GAP_MIN_FRAC = 0.025 // a real gap between plates spans at least this much
const GAP_MIN_PX = 6 // …and at least this many rows, however short the cell
// A gap FLANKED by two rows that each span the width — one plate's bottom border
// facing the next plate's top border — is a pair however narrow it is. TS3650
// and TS3651 sit 5 px (0.6 pt) apart, half of GAP_MIN, between two 99 % rows.
const GAP_FLANK_COV = 0.9
const GAP_FLANKED_MIN_PX = 2

// Which way does this plate point? `null` when the two edges are too close to
// call, so the reviewer isn't handed a confident guess that is really a coin flip.
function pointing(silhouette) {
  const [w] = identify(silhouette)
  const n = Math.max(12, Math.min(w, 200))
  const cols = silhouetteProfile(silhouette, 'x', n)
  const edge = Math.max(1, Math.round(n * EDGE_FRAC))
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length
  const left = mean(cols.slice(0, edge))
  const right = mean(cols.slice(n - edge))
  if (Math.abs(left - right) < 0.05) return null
  return left > right ? 'R' : 'L'
}

// Split a symbol crop into its two stacked plates. Returns null when the cell
// doesn't actually hold two separated shapes (so a merely tall row — a title
// block, a two-line description — is never split).
export function splitPlates(symRaw, tag, bgRgb = null) {
  const { trimmed, silhouette, solid } = silhouetteOf(symRaw, tag, bgRgb)
  const [w, h] = identify(silhouette)
  if (!w || h < 48) return null
  // When the flood collapsed to a solid rectangle (a plate whose outline it
  // leaked through — TS3650's is open at the corners) the silhouette has no gap
  // to find; the drawing's own ink still does. Same trimmed image, so the cut
  // measured here lands on the same rows.
  let profile = silhouette
  if (solid) {
    profile = join(SCRATCH, `${tag}-ink.png`)
    inkMask(trimmed, profile)
  }
  const rows = silhouetteProfile(profile, 'y', h)
  // every interior run of near-empty rows
  const runs = []
  let start = -1
  for (let i = 0; i <= h; i++) {
    const empty = i < h && rows[i] < GAP_MAX
    if (empty && start < 0) start = i
    if (!empty && start >= 0) {
      if (start > 0 && i < h) runs.push({ start, end: i - 1 })
      start = -1
    }
  }
  const balanced = (r) => {
    const c = (r.start + r.end) / 2
    return c >= h * 0.25 && c <= h * 0.75
  }
  // A flanked gap wins outright — the one nearest the middle if there are
  // several — else the longest run has to be a real gap on its own.
  const flanked = runs.filter(r => r.end - r.start + 1 >= GAP_FLANKED_MIN_PX && rows[r.start - 1] >= GAP_FLANK_COV && rows[r.end + 1] >= GAP_FLANK_COV && balanced(r))
  let best = flanked.sort((a, b) => Math.abs((a.start + a.end) / 2 - h / 2) - Math.abs((b.start + b.end) / 2 - h / 2))[0] ?? null
  if (!best) {
    best = runs.reduce((b, r) => (!b || r.end - r.start > b.end - b.start ? r : b), null)
    if (!best || best.end - best.start < Math.max(GAP_MIN_PX, h * GAP_MIN_FRAC)) return null
    if (!balanced(best)) return null // not a balanced pair
  }
  const cut = Math.round((best.start + best.end) / 2)
  const halves = []
  for (const [half, y, hh] of [['top', 0, cut], ['bottom', cut, h - cut]]) {
    const file = join(SCRATCH, `${tag}-${half}.png`)
    magick([trimmed, '-crop', `${w}x${hh}+0+${y}`, '+repage', ...trimToPage(pageColor(bgRgb)), file])
    const { silhouette: sil } = silhouetteOf(file, `${tag}-${half}`, bgRgb)
    halves.push({ half, file, dir: pointing(sil) })
  }
  // Two plates pointing the same way means the measurement failed; fall back to
  // the sheet-neutral pair so the reviewer still sees both candidates.
  if (halves[0].dir && halves[0].dir === halves[1].dir) halves[1].dir = null
  return halves
}

// Reviewer override: `--variants TS2663=RL,TS639=LR` — first letter is the TOP
// plate, second the bottom.
export function parseVariantOverrides(spec) {
  const out = new Map()
  for (const part of String(spec ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(new RegExp(`^(TS\\w+)=([${SIGN_SUFFIXES}])([${SIGN_SUFFIXES}])$`, 'i'))
    if (!m) {
      console.error(`--variants: cannot parse "${part}" (expected e.g. TS2663=RL)`)
      process.exit(1)
    }
    out.set(m[1].toUpperCase(), [m[2].toUpperCase(), m[3].toUpperCase()])
  }
  return out
}
