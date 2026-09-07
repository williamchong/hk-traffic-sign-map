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
import { silhouetteProfile, silhouetteOf } from './normalize.mjs'
import { SCRATCH, SIGN_SUFFIXES } from './sheets.mjs'

const EDGE_FRAC = 0.08 // outer slice of a plate compared for taper
const GAP_MAX = 0.05 // silhouette coverage a row must be under to count as gap
const GAP_MIN_FRAC = 0.025 // a real gap between plates spans at least this much
const GAP_MIN_PX = 6 // …and at least this many rows, however short the cell

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
  const { trimmed, silhouette } = silhouetteOf(symRaw, tag, bgRgb)
  const [w, h] = identify(silhouette)
  if (!w || h < 48) return null
  const rows = silhouetteProfile(silhouette, 'y', h)
  // longest interior run of near-empty rows = the gap between the two plates
  let best = null, start = -1
  for (let i = 0; i < h; i++) {
    const empty = rows[i] < GAP_MAX
    if (empty && start < 0) start = i
    if ((!empty || i === h - 1) && start >= 0) {
      const end = empty ? i : i - 1
      if (start > 0 && end < h - 1 && (!best || end - start > best.end - best.start)) best = { start, end }
      start = -1
    }
  }
  if (!best || best.end - best.start < Math.max(GAP_MIN_PX, h * GAP_MIN_FRAC)) return null
  const cut = Math.round((best.start + best.end) / 2)
  if (cut < h * 0.25 || cut > h * 0.75) return null // not a balanced pair
  const halves = []
  for (const [half, y, hh] of [['top', 0, cut], ['bottom', cut, h - cut]]) {
    const file = join(SCRATCH, `${tag}-${half}.png`)
    magick([trimmed, '-crop', `${w}x${hh}+0+${y}`, '+repage', '-fuzz', '6%', '-trim', '+repage', file])
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
