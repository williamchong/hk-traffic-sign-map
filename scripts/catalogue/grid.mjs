// The table lattice, read from path geometry rather than hunted for in pixels.
//
// Each sheet repeats [No. | Symbol | Description] per column-group. Columns come
// from the full-height vertical rules; rows are found PER GROUP from the
// horizontal rules spanning that group's width, so a per-group rowspan (one
// number labelling a tall stacked cell on the informatory sheets) reads as ONE
// row. Crucially, each sign's crop box uses that group's OWN dividers — a single
// median symbol width applied to every group used to bleed past the real
// Symbol|Description divider, so the trim couldn't tighten and the sign came out
// a wide sliver. A measured median is now only the fallback for a group whose
// dividers were interrupted (e.g. the bottom-right title block).

import { CB_MERGE, NO_W, RULE_JOIN, SYM_W } from './sheets.mjs'

export const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Reconstruct the column-groups from the vertical rules. Returns groups (points)
// + the table top/bot (points). Each group carries its No., Symbol and
// Description cell x-ranges.
export function columnModel(Vs) {
  const len = v => v.y1 - v.y0
  const maxLen = Math.max(...Vs.map(len))
  const tall = Vs.filter(v => len(v) > maxLen * 0.95)
  const top = median(tall.map(v => v.y0)), bot = median(tall.map(v => v.y1))
  // column boundaries = verticals that START at the table top (every group's
  // dividers begin at the header row, even a ragged right-side group that ends
  // early after a few rows), long enough to be a real divider not a glyph stroke.
  // Requiring full height instead would drop the short ragged groups entirely.
  const xs = Vs.filter(v => v.y0 <= top + 10 && v.y1 - v.y0 > 40).map(v => v.x).sort((a, b) => a - b)
  const cb = []
  for (const x of xs) {
    if (cb.length && x - cb[cb.length - 1] < CB_MERGE) cb[cb.length - 1] = (cb[cb.length - 1] + x) / 2
    else cb.push(x)
  }
  const tableL = cb[0], tableR = cb[cb.length - 1]
  // No-cells = consecutive boundary pairs the width of the narrow No. column,
  // excluding the outer frame's left edge. noIdx[k] is the cb index of a No-left.
  const noIdx = []
  for (let i = 0; i < cb.length - 1; i++) {
    const w = cb[i + 1] - cb[i]
    if (w >= NO_W[0] && w <= NO_W[1] && cb[i] > tableL + 1) noIdx.push(i)
  }
  const lefts = noIdx.map(i => cb[i])
  const pitch = lefts.length >= 2 ? median(lefts.slice(1).map((x, k) => x - lefts[k])) : 109
  const noW = median(noIdx.map(i => cb[i + 1] - cb[i])) || 20
  // measured symbol width = No-right → next boundary; used only for synthesis.
  const symWs = []
  for (const i of noIdx) {
    const nr = cb[i + 1], nxt = cb[i + 2]
    if (nxt && nxt - nr > SYM_W[0] && nxt - nr < SYM_W[1]) symWs.push(nxt - nr)
  }
  const symW = median(symWs) || Math.round(pitch * 0.52)
  const origin = lefts.length ? Math.min(...lefts) : tableL + noW
  const groups = []
  for (let k = 0; k <= 24; k++) {
    const gl = origin + k * pitch
    if (gl + noW + symW > tableR + pitch * 0.3) break
    // snap to a detected No-cell on this lattice point (exact, with the real
    // Symbol|Description divider); otherwise synthesise from measured widths.
    const hit = noIdx.find(i => Math.abs(cb[i] - gl) <= pitch * 0.35)
    if (hit !== undefined) {
      const nL = cb[hit], nR = cb[hit + 1], sR = cb[hit + 2]
      const symRight = (sR && sR - nR > SYM_W[0] && sR - nR < SYM_W[1]) ? sR : nR + symW
      groups.push({ gl, no: [nL, nR], sym: [nR, symRight] })
    } else {
      groups.push({ gl, no: [gl, gl + noW], sym: [gl + noW, gl + noW + symW] })
    }
  }
  // Description cell = Symbol-right → the next ruling line. Do NOT bound it by
  // the next GROUP's No-left: on every sheet the trailing title block snaps to a
  // spurious No-cell whose left edge sits at the last real group's
  // Symbol|Description divider, which collapsed that group's description to
  // nothing. The lattice is the fallback, and also the cap — so a group whose
  // divider was interrupted can't run on into the notes block to the right.
  for (const g of groups) {
    const latticeEnd = g.gl + pitch
    const nextRule = cb.find(x => x > g.sym[1] + 1)
    const right = nextRule !== undefined && nextRule <= latticeEnd + pitch * 0.15 ? nextRule : latticeEnd
    g.desc = [g.sym[1], Math.max(right, g.sym[1] + 1)]
  }
  return { groups, top, bot, pitch }
}

// Per-group row rules: horizontal borders are drawn per-cell (short collinear
// segments), so cluster H-segments by y and keep a y only where the segments
// collectively span most of the group's width AND cross the No.|Symbol divider
// (`noR`). A rowspan is just a larger gap between two kept rules — no uniform
// pitch assumed.
//
// The crossing test is the one that matters. A row divider separates two printed
// numbers, so it must run through the No. column; a sign's own plate outline sits
// entirely inside the Symbol cell and never does. Width alone cannot tell them
// apart: real rules cover 98-100 % of the group but a full-bleed pictogram
// reaches ~74 % (Symbol cell ÷ group width), so a 60 % floor admits the wider
// plates. That mis-read TS3643's rowspan as three slivers — its vertically
// centred number then straddled a false divider, both halves OCR'd to garbage,
// and the row vanished silently (TS3649 likewise shipped a truncated half-row).
// The 60 % floor is kept as a cheap guard on a degenerate lattice.
export function groupRows(Hs, noL, noR, symR) {
  const [xL, xR] = [noL, symR]
  const W = xR - xL
  const segs = Hs.filter(h => h.x1 > xL && h.x0 < xR).sort((a, b) => a.y - b.y)
  const clusters = []
  for (const h of segs) {
    const c = clusters[clusters.length - 1]
    if (c && h.y - c.y < 2) c.segs.push(h)
    else clusters.push({ y: h.y, segs: [h] })
  }
  const ys = []
  for (const c of clusters) {
    const iv = c.segs.map(h => [Math.max(xL, h.x0), Math.min(xR, h.x1)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0])
    // Merge into runs first: a row rule's borders are drawn per CELL, so its No.
    // and Symbol halves meet exactly at `noR` and neither half crosses it alone.
    const runs = []
    for (const [a, b] of iv) {
      const last = runs[runs.length - 1]
      if (last && a <= last[1] + RULE_JOIN) last[1] = Math.max(last[1], b)
      else runs.push([a, b])
    }
    const cov = runs.reduce((s, [a, b]) => s + (b - a), 0)
    if (cov > W * 0.6 && runs.some(([a, b]) => a < noR && b > noR)) ys.push(c.y)
  }
  return ys
}

// Grey row shading = "SUPERSEDED OR DELETED" (the sheets' own legend). Keep the
// filled paths that are a neutral mid-grey and big enough to be a row band, not
// a grey detail inside a pictogram.
export function greyBoxes(fills) {
  return fills.filter((f) => {
    // A grayscale sheet gives one component, an sRGB one gives three.
    const neutral = f.rgb.length === 1 || Math.max(...f.rgb) - Math.min(...f.rgb) < 0.05
    const v = f.rgb[0]
    return neutral && v > 0.5 && v < 0.98 && f.x1 - f.x0 > 20 && f.y1 - f.y0 > 5
  })
}

// Is this point inside a grey box? Callers pass a No.-cell centre, so a grey
// pictogram detail elsewhere in the row can't flag the sign.
export function greyAt(greys, x, y) {
  return greys.find(f => x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1) ?? null
}
