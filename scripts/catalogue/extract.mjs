// Per-sheet extraction: grid → OCR bind → pictogram, with the name cross-check.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { columnModel, greyAt, greyBoxes, groupRows, median } from './grid.mjs'
import { magick, identify } from './proc.mjs'
import { classifyTier, normalizeSign } from './normalize.mjs'
import { descriptionText, ocrCode, ocrDescription } from './ocr.mjs'
import { cleanSheetScratch, renderPage, traceSegments } from './render.mjs'
import { splitPlates } from './variants.mjs'
import { isDoubleSided, isListedSuperseded, verdictFor } from './names.mjs'
import {
  INDEX_PLAN_DIR, LAST_ROW_BAND, MIN_ROW, PX, RENDER_SCALE, SCRATCH, SIGNS_DIR, STAGING, SYM_INSET_PT, TALL_ROW_RATIO
} from './sheets.mjs'

const sheetTag = s => `${s.prefix}${s.range[0]}-${s.range[1]}`

// A staged half keeps a provisional name until a human confirms which face it is.
const halfFile = (code, half) => `${code}__${half}.png`

// Which suffix does each half get? `--variants` always wins. The measured taper
// is only trusted once a human has seen it: verify.png prints the guess next to
// the source row, so committing a staged sheet IS the confirmation. A bare
// write-through rebuild has no such review, so there the heuristic alone leaves
// the face unshipped — a mislabelled sign must never ship, and L/R is exactly
// the label the vendored list cannot check (it gives both faces identical text).
function resolveSplit(add, overrides, { trustHeuristic = false } = {}) {
  const ov = overrides.get(add.code)
  return add.split.map((h, i) => ({ ...h, dir: ov?.[i] ?? (trustHeuristic ? h.dir : null) }))
}

export async function extractSheet(sheet, catalogue, opts) {
  const { propose, wipe, names, font, overrides, rebind = new Map() } = opts
  const pdf = join(INDEX_PLAN_DIR, sheet.pdf)
  const tag = `${sheet.prefix}-${sheet.range[0]}`
  const png = renderPage(pdf, tag)

  const { Hs, Vs, fills } = traceSegments(pdf, tag)
  const { groups, top, bot } = columnModel(Vs)
  const greys = greyBoxes(fills)
  for (const g of groups) {
    const ys = groupRows(Hs, g.no[0], g.no[1], g.sym[1]).filter(y => y >= top - 1 && y <= bot + 1)
    g.cells = []
    for (let i = 0; i < ys.length - 1; i++) {
      if (ys[i + 1] - ys[i] < MIN_ROW) continue
      g.cells.push([ys[i], ys[i + 1]])
    }
    g.medianRow = median(g.cells.map(([a, b]) => b - a))
    // Close the group's last row against the table bottom when no rule did.
    // Deliberately after the median, so this synthesised cell can't skew it.
    const lastY = ys[ys.length - 1]
    if (g.medianRow && lastY !== undefined) {
      const gap = bot - lastY
      if (gap >= g.medianRow * LAST_ROW_BAND[0] && gap <= g.medianRow * LAST_ROW_BAND[1]) g.cells.push([lastY, bot])
    }
  }
  const totalCells = groups.reduce((n, g) => n + g.cells.length, 0)
  console.log(`[${sheet.pdf}] grid: ${groups.length} groups, rows/group=[${groups.map(g => g.cells.length).join(',')}], ${totalCells} cells, ${greys.length} grey box(es)`)

  // The sheets' bold CAD "7" reads as a "1": (TS 701 - 805) comes back as
  // 101/102/103/…, (TS 2601 - 2717) turns 2707/2709/2712 into 2107/2109/2112.
  // Every one lands OUTSIDE the sheet's printed range, so the range gate drops
  // it and the row is lost silently — 83 unreadable rows on 701-805 alone, and
  // the frozen old-extractor crops behind 22 of the image audit's conflicts.
  //
  // Undo it only where the answer is forced: substitute in an OUT-OF-RANGE read
  // and accept solely when exactly ONE position yields an in-range code. "101"
  // gives 701 (and 107, out of range) so it is unambiguous; a read that could be
  // rescued two ways is left dropped. Every later defense still applies — dup,
  // monotonicity, the name cross-check, the image audit — so this widens what is
  // READ without widening what ships unchecked.
  function rescueDigits(digits) {
    const hits = new Set()
    for (let i = 0; i < digits.length; i++) {
      if (digits[i] !== '1') continue
      const alt = digits.slice(0, i) + '7' + digits.slice(i + 1)
      const n = +alt
      if (n >= sheet.range[0] && n <= sheet.range[1]) hits.add(alt)
    }
    return hits.size === 1 ? [...hits][0] : null
  }

  // Normalise a raw No.-column string to {code}, gated by this sheet's numeric
  // range. Returns null for blanks / out-of-range / malformed reads.
  function parseCode(raw0) {
    const raw = String(raw0 ?? '').toUpperCase().replace(/\s+/g, '')
    if (!raw || raw === 'NONE') return null
    const m = raw.match(/^(\d{2,4})([A-Z]?)$/)
    if (!m) return null
    const n = +m[1]
    if (n < sheet.range[0] || n > sheet.range[1]) {
      const fixed = rescueDigits(m[1])
      if (!fixed) return null
      return { code: `${sheet.prefix}${fixed}${m[2]}`, n: +fixed, rescued: m[1] }
    }
    return { code: `${sheet.prefix}${m[1]}${m[2]}`, n }
  }

  const outDir = propose ? join(STAGING, sheetTag(sheet)) : SIGNS_DIR
  await mkdir(outDir, { recursive: true })

  const adds = []
  const seen = new Set()
  const tally = { empty: 0, dup: 0, unreadable: 0, withheld: 0, rescued: 0 }
  const verdicts = {}
  const supersededDiff = []
  const ins = SYM_INSET_PT

  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi]
    let prevN = 0
    for (const [rtop, rbot] of grp.cells) {
      const rowH = rbot - rtop
      const tokens = ocrCode(png, PX(grp.no[0]), PX(rtop), PX(grp.no[1] - grp.no[0]), PX(rowH), parseCode)
      let c = tokens.map(parseCode).find(Boolean) || null
      if (!c) {
        if (tokens.length) tally.unreadable++
        continue
      }
      // A reviewer's --rebind correction lands here, on the read itself, so the
      // dup check, monotonicity, superseded lookup and name cross-check all see
      // the corrected code. In particular the name check now scores this crop
      // against the REBOUND code's reference entry, so a mistaken rebind is
      // visible as `disagree`/`code-misread` instead of shipping quietly.
      if (c.rescued) tally.rescued++
      const to = rebind.get(c.code)
      if (to) {
        console.warn(`[${sheet.pdf}] ↻ ${c.code} rebound to ${to} (reviewer override, group ${gi}, y≈${rtop.toFixed(0)})`)
        c = { code: to, n: parseInt(to.replace(/^\D+/, ''), 10) }
      }
      // The No. column is sorted within a group — flag (don't drop) an OCR read
      // that breaks it, so a digit misread is visible in the log.
      if (prevN && c.n < prevN) console.warn(`[${sheet.pdf}] ⚠ group ${gi}: OCR ${c.code} < previous ${prevN} (out of order) — check verify.png`)
      prevN = c.n
      // The same code twice on one sheet means one of the two reads is wrong, and
      // the row we KEEP may be the wrong one — that is how a correct pictogram
      // ends up under its neighbour's number. Silently dropping the second is not
      // enough; both rows need a human eye.
      if (seen.has(c.code)) {
        console.warn(`[${sheet.pdf}] ⚠ ${c.code} read twice (group ${gi}, y≈${rtop.toFixed(0)}) — one of the two rows is misread, check verify.png`)
        tally.dup++
        continue
      }
      // A rebind is a correction to something already in the catalogue — usually
      // a WRONG plate (TS256 ships a "P"+lorry) — so it must override the
      // merge-run skip that normally leaves an existing code alone.
      if (!wipe && !to && catalogue[c.code]) {
        tally.dup++
        continue
      }

      // Grey row shading = "SUPERSEDED OR DELETED" (the sheets' own legend). The
      // colour is also the page background behind this sign, so normalizeSign
      // needs it to flood the backdrop away.
      const grey = greyAt(greys, (grp.no[0] + grp.no[1]) / 2, (rtop + rbot) / 2)
      if (!!grey !== isListedSuperseded(names.superseded, c.code)) supersededDiff.push(`${c.code}${grey ? '+' : '-'}`)

      const [sx0, sx1] = grp.sym
      const symRaw = join(SCRATCH, `${c.code}__raw.png`)
      magick([png, '-crop', `${PX(sx1 - sx0 - 2 * ins)}x${PX(rowH - 2 * ins)}+${PX(sx0 + ins)}+${PX(rtop + ins)}`,
        '+repage', '-fuzz', '8%', '-trim', '+repage', symRaw])
      const [sw, sh] = identify(symRaw)
      if (!sw || sw < 24 || sh < 24) {
        tally.empty++
        await rm(symRaw, { force: true })
        continue
      }

      // The second bind: does the row's Description name THIS sign?
      const name = descriptionText(ocrDescription(png, PX(grp.desc[0]), PX(rtop), PX(grp.desc[1] - grp.desc[0]), PX(rowH)))
      const v = verdictFor(names, c.code, name)
      verdicts[v.verdict] = (verdicts[v.verdict] ?? 0) + 1
      if (v.withhold) {
        console.warn(`[${sheet.pdf}] ⚠ ${c.code}: description reads as ${v.altKey} (sim ${v.sim.toFixed(2)}) — pictogram withheld, likely a digit misread`)
        tally.withheld++
        await rm(symRaw, { force: true })
        continue
      }

      const entry = { tier: classifyTier(sw / RENDER_SCALE, sh / RENDER_SCALE), group: sheet.group }
      if (v.ship) entry.desc = { en: v.ship }
      if (grey) entry.superseded = true

      // A rowspan holds two stacked plates — one face each of a double-sided
      // sign. The base code stays (TD installs it bare too: TS694 34 features,
      // TS3643 87, …), taken from the TOP plate, and each face is staged for
      // confirmation.
      const tall = grp.medianRow && rowH > grp.medianRow * TALL_ROW_RATIO
      const split = tall ? splitPlates(symRaw, c.code, grey?.rgb ?? null) : null
      const doubleSided = split ? isDoubleSided(names.names, c.code) : false
      if (split) {
        for (const h of split) {
          const [hw, hh] = identify(h.file)
          h.tier = classifyTier(hw / RENDER_SCALE, hh / RENDER_SCALE)
          normalizeSign(h.file, join(outDir, halfFile(c.code, h.half)), { bgRgb: grey?.rgb ?? null })
        }
        // The base IS the top plate, already normalized just above.
        await copyFile(join(outDir, halfFile(c.code, split[0].half)), join(outDir, `${c.code}.png`))
      } else {
        normalizeSign(symRaw, join(outDir, `${c.code}.png`), { bgRgb: grey?.rgb ?? null })
      }
      await rm(symRaw, { force: true })

      seen.add(c.code)
      // src = the source row box (No.-cell left → symbol-cell right) for a
      // ground-truth [printed number | pictogram] crop at review time.
      adds.push({
        code: c.code,
        ...entry,
        verdict: v.verdict,
        ocr: name,
        ...(v.listText ? { list: v.listText } : {}),
        ...(split ? { split: split.map(h => ({ half: h.half, dir: h.dir, tier: h.tier })), doubleSided } : {}),
        src: { x: grp.no[0], y: rtop, w: sx1 - grp.no[0], h: rowH }
      })
    }
  }

  const summary = Object.entries(verdicts).map(([k, n]) => `${k}=${n}`).join(' ')
  console.log(`[${sheet.pdf}] added=${adds.length} ${summary} | empty=${tally.empty} dup=${tally.dup} unreadable=${tally.unreadable} withheld=${tally.withheld}`)
  // `+` = we saw grey shading the vendored list doesn't have, `-` = the reverse.
  if (supersededDiff.length) console.warn(`[${sheet.pdf}] ⚠ superseded shading differs from the vendored list on ${supersededDiff.length}: ${supersededDiff.join(' ')}`)

  if (propose) {
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ sheet: sheet.pdf, group: sheet.group, adds }, null, 2) + '\n')
    if (adds.length) await writeMontages(adds, outDir, png, font)
    console.log(`[${sheet.pdf}] staged ${adds.length} crop(s) -> ${join(outDir, 'verify.png')}`)
  } else {
    for (const add of adds) {
      applyAdd(add, catalogue, overrides)
      await promoteAdd(add, outDir, outDir, overrides)
    }
  }
  await cleanSheetScratch(tag)
  return adds.length
}

// Catalogue entries for one add: the base sign plus, for a double-sided row,
// one per confirmed face.
export function applyAdd(add, catalogue, overrides = new Map(), opts = {}) {
  const { code, tier, group, desc, superseded } = add
  const base = { tier, group }
  if (desc) base.desc = desc
  if (superseded) base.superseded = true
  catalogue[code] = base
  if (!add.split) return [code]
  const written = [code]
  for (const h of resolveSplit(add, overrides, opts)) {
    if (!h.dir) continue
    const vc = `${code}${h.dir}`
    catalogue[vc] = { ...base, tier: h.tier ?? tier }
    written.push(vc)
  }
  return written
}

// Put one add's pictograms in their final place: the base code, plus the
// provisional `__top` / `__bottom` crops moved onto their confirmed face codes.
// A half with no direction (measurement inconclusive and no --variants) is
// dropped rather than guessed.
export async function promoteAdd(add, srcDir, dstDir, overrides = new Map(), opts = {}) {
  const inPlace = srcDir === dstDir
  if (!inPlace) await copyFile(join(srcDir, `${add.code}.png`), join(dstDir, `${add.code}.png`))
  if (!add.split) return
  for (const h of resolveSplit(add, overrides, opts)) {
    const from = join(srcDir, halfFile(add.code, h.half))
    if (h.dir) await copyFile(from, join(dstDir, `${add.code}${h.dir}.png`))
    else console.warn(`  ${add.code} ${h.half}: face unconfirmed — review with --propose, or pass --variants ${add.code}=<top><bottom>`)
    if (inPlace) await rm(from, { force: true })
  }
}

// Review montage (the normalized assets) + verify montage (each candidate's
// SOURCE [printed No. | pictogram] strip, labelled with the OCR'd code and the
// name-check verdict, so a human can triage instead of eyeballing every row).
async function writeMontages(adds, outDir, png, font) {
  const labelArgs = []
  for (const a of adds) labelArgs.push('-label', a.code, join(outDir, `${a.code}.png`))
  magick(['montage', '-font', font, ...labelArgs, '-tile', '6x', '-geometry', '200x160+8+8',
    '-background', 'white', '-fill', 'black', '-pointsize', '22', join(outDir, 'review.png')])

  const vArgs = ['montage', '-font', font]
  for (const a of adds) {
    const { x, y, w, h } = a.src
    const vf = join(outDir, `${a.code}__src.png`)
    magick([png, '-crop', `${PX(w) + 8}x${PX(h) - 4}+${Math.max(0, PX(x) - 4)}+${PX(y) + 2}`, '+repage', '-resize', '440x180', vf])
    // A split the list doesn't corroborate gets a "?" — look at that one hardest.
    const dirs = a.split ? ` [${a.split.map(s => `${s.half[0]}:${s.dir ?? '?'}`).join(' ')}]${a.doubleSided ? '' : '?'}` : ''
    vArgs.push('-label', `${a.code} · ${a.verdict}${dirs}`, vf)
  }
  vArgs.push('-tile', '3x', '-geometry', '460x200+8+8', '-background', 'white', '-fill', 'black', '-pointsize', '26', join(outDir, 'verify.png'))
  magick(vArgs)
  for (const a of adds) await rm(join(outDir, `${a.code}__src.png`), { force: true })
}
