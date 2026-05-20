// Extracts real sign pictograms from the TD "Index Plan" PDFs.
//
// Why this is accuracy-safe: each Index Plan cell contains BOTH the TD sign
// code (the "Traffic Sign No." column) AND its official symbol in the SAME
// row. Cropping per-cell binds code↔image with no cross-numbering join, so we
// never mislabel a sign (the Cap 374G legal figure numbers and the TD SIGNID
// space diverge above the low regulatory range — we must not equate them).
//
// The table grid is auto-detected from the rendered raster (no hand-tuned
// pixel constants), so adding the remaining sheets later is just appending to
// SHEETS below — see README "Adding more sign sheets".
//
// Output:
//   public/signs/<CODE>.png        trimmed pictogram, one per code
//   app/data/signCatalogue.json    { "<CODE>": { tier, group, desc? } }
//
// `desc` is OCR'd from the Description column of the SAME row/group as the
// code & symbol — no cross-numbering join — so it can never describe a
// different sign. A blank or garbled read is dropped (the sign keeps its
// pictogram, just without meaning text) rather than shipping a wrong meaning.
// It is English best-effort only: app/data/signDescriptions.json holds
// hand-curated bilingual overrides (TD Road Users' Code) that the RUNTIME
// prefers over this — edited independently, no pipeline re-run needed.

import { mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const INDEX_PLAN_DIR = 'data/tadrawings_dataspec/Index Plan'
const SIGNS_DIR = 'public/signs'
const CATALOGUE_JSON = 'app/data/signCatalogue.json'
const QA_MONTAGE = '/tmp/sign-catalogue-qa.png'
const DPI = 400
// Description OCR runs on a DPI×DESC_HD raster (sharper digits/units).
const DESC_HD = 2

// Sheets to extract. SIGNID in the dataset is `TS` + the No.-column value, so
// `prefix` is prepended to each cropped code. The grid auto-detects, so adding
// a sheet is just appending its PDF + title range here.
// `range` is the inclusive numeric span the sheet covers (from its title). Any
// OCR result outside it is treated as a misread and dropped — a missed sign
// degrades to a dot, which is acceptable; a MISLABELLED sign is not.
// `group` is the sheet's drawing-title class (TRAFFIC SIGNS (REGULATORY) etc.),
// written onto every code so the viewer can filter/colour by sign class.
const SHEETS = [
  { pdf: '(TS 101 - 205).pdf', prefix: 'TS', range: [101, 205], group: 'regulatory' },
  { pdf: '(TS 206 - 310).pdf', prefix: 'TS', range: [206, 310], group: 'regulatory' },
  { pdf: '(TS 311 - 400).pdf', prefix: 'TS', range: [311, 400], group: 'regulatory' },
  { pdf: '(TS 401 - 505).pdf', prefix: 'TS', range: [401, 505], group: 'warning' },
  { pdf: '(TS 506 - 600).pdf', prefix: 'TS', range: [506, 600], group: 'warning' },
  { pdf: '(TS 601 - 700).pdf', prefix: 'TS', range: [601, 700], group: 'informatory' },
  { pdf: '(TS 701 - 805).pdf', prefix: 'TS', range: [701, 805], group: 'supplementary' },
  { pdf: '(TS 806 - 900).pdf', prefix: 'TS', range: [806, 900], group: 'supplementary' },
  { pdf: '(TS 901 - 1000).pdf', prefix: 'TS', range: [901, 1000], group: 'temporary' },
  { pdf: '(TS 2101 - 2205).pdf', prefix: 'TS', range: [2101, 2205], group: 'regulatory' },
  { pdf: '(TS 2206 - 2310).pdf', prefix: 'TS', range: [2206, 2310], group: 'regulatory' },
  { pdf: '(TS 2601 - 2717).pdf', prefix: 'TS', range: [2601, 2717], group: 'informatory' },
  { pdf: '(TS 3601 - 3705).pdf', prefix: 'TS', range: [3601, 3705], group: 'informatory' },
  { pdf: '(TS 3706 - 3810).pdf', prefix: 'TS', range: [3706, 3810], group: 'supplementary' },
  { pdf: '(TS 3811 - 3936).pdf', prefix: 'TS', range: [3811, 3936], group: 'informatory' },
  { pdf: '(TS 3937 - 4062).pdf', prefix: 'TS', range: [3937, 4062], group: 'warning' }
]

function requireTool(cmd, hint) {
  if (spawnSync(cmd, ['--version']).error) {
    console.error(`Missing \`${cmd}\`. Install it: ${hint}`)
    process.exit(1)
  }
}

function magick(args, { binary = false } = {}) {
  const r = spawnSync('magick', args, {
    maxBuffer: 1 << 30,
    encoding: binary ? 'buffer' : 'utf8'
  })
  if (r.status !== 0) throw new Error(`magick ${args.join(' ')}\n${r.stderr}`)
  return r.stdout
}

// [width, height] of an image file, in pixels.
function identify(file) {
  const out = spawnSync('magick', ['identify', '-format', '%w %h', file],
    { encoding: 'utf8' })
  return out.stdout.trim().split(/\s+/).map(Number)
}

// One greyscale sample per axis pixel: dark coverage 0..255 (255 = all ink).
function profile(png, w, h, axis) {
  const size = axis === 'x' ? `${w}x1` : `1x${h}`
  const buf = magick(
    [png, '-colorspace', 'Gray', '-threshold', '55%', '-negate',
      '-resize', `${size}!`, '-depth', '8', 'gray:-'],
    { binary: true }
  )
  return Uint8Array.from(buf)
}

// Contiguous runs where value >= thresh, each at least `min` long.
function runs(arr, thresh, min) {
  const out = []
  let s = -1
  for (let i = 0; i <= arr.length; i++) {
    if (i < arr.length && arr[i] >= thresh) {
      if (s < 0) s = i
    } else if (s >= 0) {
      if (i - s >= min) out.push([s, i - 1])
      s = -1
    }
  }
  return out
}

// Indices of the longest strictly-increasing subsequence of `vals`, returned
// as a Set for membership tests. Used to filter row-major OCR'd code numbers:
// the true codes are monotonic in row-major order (codes increase down each
// group then jump to the next group), so any outlier — a misread, a number
// hallucinated from sign text — is off the LIS and can be dropped.
function lisIndices(vals) {
  const n = vals.length
  if (!n) return new Set()
  const tails = [], tIdx = [], prev = new Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < vals[i]) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tIdx[lo - 1] : -1
    tails[lo] = vals[i]
    tIdx[lo] = i
  }
  const keep = new Set()
  let k = tIdx[tails.length - 1]
  while (k !== -1) {
    keep.add(k)
    k = prev[k]
  }
  return keep
}

// Cluster near-adjacent indices (within `merge`px) to their centres — turns a
// thresholded profile into a list of line positions.
function cluster(indices, merge) {
  if (!indices.length) return []
  const out = []
  let s = indices[0], p = indices[0]
  for (const x of indices.slice(1)) {
    if (x - p > merge) {
      out.push(Math.round((s + p) / 2))
      s = x
    }
    p = x
  }
  out.push(Math.round((s + p) / 2))
  return out
}

// Centres of the strong runs in a 1-px ink profile — the table's rule lines.
// Used for both the horizontal grid rules and the vertical column rules
// (they only differ in the profile axis, threshold and merge distance).
function ruleCentres(prof, thresh, merge) {
  const idx = []
  for (let i = 0; i < prof.length; i++) if (prof[i] >= thresh) idx.push(i)
  return cluster(idx, merge)
}

// Modal spacing of a sorted centre list, to the nearest pixel.
function modalGap(centres) {
  const counts = new Map()
  for (let i = 1; i < centres.length; i++) {
    const g = Math.round(centres[i] - centres[i - 1])
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let best = 0, bestN = 0
  for (const [g, n] of counts) {
    if (n > bestN && g > 20) {
      bestN = n
      best = g
    }
  }
  return best
}

function tesseractOcr(pngBuf, psm, whitelist) {
  const args = ['stdin', 'stdout', '--psm', String(psm)]
  if (whitelist) args.push('-c', `tessedit_char_whitelist=${whitelist}`)
  const r = spawnSync('tesseract', args, { input: pngBuf, maxBuffer: 1 << 26 })
  return r.status === 0 ? r.stdout.toString('utf8') : ''
}
// psm 7 = one text line — the No. column's single token.
const ocrLine = (pngBuf, whitelist) => tesseractOcr(pngBuf, 7, whitelist).trim()
// psm 6 = uniform block — Description cells wrap onto 2–3 lines that
// cleanDescription() re-joins into one phrase.
const ocrBlock = (pngBuf, whitelist) => tesseractOcr(pngBuf, 6, whitelist)

// Normalise an OCR'd description: collapse all whitespace/newlines to single
// spaces, tidy spacing around the "(...)" sub-note, and reject reads with too
// little alphabetic signal to be a real meaning (blank continuation rows, a
// stray rule line). Source text is authored ALL-CAPS — kept verbatim because
// that is how the sign legend itself reads.
function cleanDescription(raw) {
  const s = raw
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
  return (s.match(/[A-Z]/g)?.length ?? 0) >= 2 ? s : ''
}

// Trimmed-symbol shape → LOD tier. Rectangular plates / text panels read only
// when large (tier 2); near-square roundels & triangles stay legible small
// (tier 0); everything else is tier 1. Kept as a transparent, tunable proxy.
function classifyTier(w, h) {
  const aspect = w / h
  if (aspect > 1.7 || aspect < 0.58) return 2
  const big = Math.max(w, h)
  if (aspect > 1.25 || aspect < 0.8 || big > 320) return 1
  return 0
}

// Mean alpha (0..1) of an image — the opaque fraction of its bounding box.
function opaqueFraction(file) {
  const r = spawnSync('magick', [file, '-alpha', 'extract',
    '-format', '%[fx:mean]', 'info:'], { encoding: 'utf8' })
  return parseFloat(r.stdout) || 0
}

// Turn a trimmed sheet-crop into the final pictogram. Round/triangular signs
// have white bbox corners, so flood-filling the sheet white from the edge
// shapes them cleanly. Bordered rectangular plates (no-stopping, route, text
// panels) have an inked perimeter and no outside white — flood-filling them
// would bleed through and eat the white face, so if the flood removes most of
// the sign we keep the opaque rectangle instead. Output is always PNG32 so it
// never degrades to an alpha-less greyscale image.
function normalizeSign(symRaw, outPath) {
  const trimmed = '/tmp/sym-t.png'
  magick([symRaw, '-fuzz', '6%', '-trim', '+repage', trimmed])

  const flooded = '/tmp/sym-f.png'
  magick([trimmed, '-alpha', 'set', '-bordercolor', 'white', '-border', '1',
    '-fuzz', '12%', '-fill', 'none', '-draw', 'color 0,0 floodfill',
    '-shave', '1x1', '-channel', 'A', '-morphology', 'Erode', 'Octagon:1',
    '+channel', '-trim', '+repage', flooded])

  // < 0.40 ⇒ the flood ate the sign (a white-faced/borderless plate) →
  // fall back to the intact opaque rectangle. Triangles sit near 0.5 and
  // round signs higher, so they keep the shaped transparent version.
  const base = opaqueFraction(flooded) < 0.40
    ? [trimmed, '-alpha', 'set']
    : [flooded]
  magick([...base, '-resize', '320x120', '-background', 'none',
    '+repage', `PNG32:${outPath}`])
}

async function extractSheet(sheet, catalogue) {
  const pdf = join(INDEX_PLAN_DIR, sheet.pdf)
  const base = `/tmp/idx-${sheet.prefix}`
  spawnSync('pdftoppm', ['-png', '-r', String(DPI), '-singlefile', pdf, base])
  const png = `${base}.png`
  const [W, H] = identify(png)

  // Description text is thin CAD lettering; OCR'ing it off the 400-DPI sheet
  // raster (tuned for pictogram extraction) loses digit/unit detail. Render
  // a second raster at HD× for the description pass only — geometry stays on
  // the 400-DPI raster, coords just scale by HD.
  const pngHD = `${base}-hd.png`
  spawnSync('pdftoppm', ['-png', '-r', String(DPI * DESC_HD),
    '-singlefile', pdf, `${base}-hd`])

  // Columns: pictogram ink forms wide vertical bands = the Symbol columns.
  const colProf = profile(png, W, H, 'x')
  const symBands = runs(colProf, 25, 70)
  // Rows: full-width grid lines peak near 255 in the 1×H projection, while
  // text/pictograms only partially fill a scanline — so a high threshold
  // isolates the rule lines.
  const rowProf = profile(png, W, H, 'y')
  const gridLines = ruleCentres(rowProf, 120, 3)
  const pitch = modalGap(gridLines)
  // Row bands = consecutive grid lines one pitch apart (drops the irregular
  // header rule and the bottom title block automatically).
  const rowBands = []
  for (let i = 1; i < gridLines.length; i++) {
    const h = gridLines[i] - gridLines[i - 1]
    if (Math.abs(h - pitch) < pitch * 0.15) {
      rowBands.push([gridLines[i - 1], gridLines[i]])
    }
  }
  // No. column sits immediately left of every symbol band. Size it from the
  // column-group pitch (band-to-band distance), wide enough to hold the code
  // but short of the previous group's Description.
  const groupPitch = symBands.length > 1
    ? (symBands.at(-1)[0] - symBands[0][0]) / (symBands.length - 1)
    : symBands[0][0]
  const noW = Math.round(groupPitch * 0.32)

  // Vertical column rules: a full-height rule line is ~all-ink in the 1-px
  // x-projection, while a pictogram column only partly fills it — so a high
  // threshold isolates the table's vertical rules (stable across 150–230).
  const vRules = ruleCentres(colProf, 150, 4)

  // The Description cell is a FIXED grid cell (its width does not track the
  // symbol ink): bounded by the Symbol|Description rule and the next rule.
  // Snapping to detected rules survives wide signs whose ink overruns the
  // cell; if the bracketing rules look wrong we fall back to a fixed
  // fraction of the group (calibrated: desc ≈ 0.69–0.98 of groupPitch from
  // the group's left/No.-column edge).
  function descCell(bx0) {
    const r2 = vRules.find(x => x > bx0 + groupPitch * 0.10)
    const r3 = r2 != null ? vRules.find(x => x > r2 + groupPitch * 0.05) : null
    if (r2 != null && r3 != null) {
      const w = r3 - r2
      if (w > groupPitch * 0.12 && w < groupPitch * 0.45) return [r2 + 4, r3 - 2]
    }
    const gl = bx0 - noW - 8
    return [gl + Math.round(groupPitch * 0.69), gl + Math.round(groupPitch * 0.98)]
  }

  // Merged vertical rules for the No.-cell rule-snap fallback. The raw
  // `vRules` list double-counts thick cell borders (two close rule lines
  // ~15-25px apart); collapsing close rules into one logical line per ~30px
  // gives the cell-divider positions we want to snap to.
  const vrMerged = cluster(vRules, 30)
  // No.-cell horizontal extent for `bx0`, snapped to the two logical rules
  // immediately left of the symbol band: rR = No.|Symbol divider,
  // rL = previous group's Description-end / this group's No-start (shared
  // border). Returns null if the bracketing rules look implausible
  // (narrower than 40px or wider than 60% of groupPitch) — better a dot
  // than a misread from the wrong cell.
  function noCellVR(bx0) {
    const left = vrMerged.filter(x => x < bx0 - 4)
    const rR = left.at(-1), rL = left.at(-2)
    if (rR == null || rL == null) return null
    const w = rR - rL
    return (w < 40 || w > groupPitch * 0.6) ? null : [rL, rR]
  }

  // The No. cell read, threshold+trim, psm-7 single line. Returns
  // [digits, suffix, num] validated by the regex + sheet range, or null
  // (no/misread/out-of-range — all indistinguishable here and all correctly
  // mean "no code").
  const RNO = 45 // absolute px at the fixed 400-DPI render
  function readNo(bx0, y, rh, cropW) {
    const noBuf = magick([png,
      '-crop', `${cropW}x${Math.round(rh * 0.46)}+${bx0 - noW - 8}+${y + 6}`,
      '+repage', '-colorspace', 'Gray', '-threshold', '58%',
      '-fuzz', '30%', '-trim', '+repage',
      '-bordercolor', 'white', '-border', '18', '-resize', '220%', 'png:-'],
    { binary: true })
    const raw = ocrLine(noBuf, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
      .replace(/\s+/g, '').toUpperCase()
    const mm = raw.match(/^(\d{2,4})([A-Z]?)$/)
    if (!mm) return null
    const n = Number(mm[1])
    if (n < sheet.range[0] || n > sheet.range[1]) return null
    return [mm[1], mm[2], n]
  }
  // vRule-snap read: snap horizontally to the detected No-cell rule pair,
  // and read a CENTRED vertical band. Regulatory No. cells have the number
  // top-aligned above a "TC nnn" reg-ref, but informatory cells hold ONLY
  // the number, vertically centred — so the upper-46% crop slices it off.
  // Try upper-46% first (matches regulatory), then the centred 66% band.
  function readNoVR(bx0, y, rh) {
    const c = noCellVR(bx0)
    if (!c) return null
    for (const vf of [0.46, 0.66]) {
      const ch = Math.round(rh * vf)
      const oy = y + Math.round(rh * (1 - vf) / 2)
      const buf = magick([png,
        '-crop', `${c[1] - c[0] - 10}x${ch}+${c[0] + 5}+${oy}`,
        '+repage', '-colorspace', 'Gray', '-threshold', '58%',
        '-fuzz', '30%', '-trim', '+repage',
        '-bordercolor', 'white', '-border', '18', '-resize', '220%', 'png:-'],
      { binary: true })
      const raw = ocrLine(buf, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
        .replace(/\s+/g, '').toUpperCase()
      const mm = raw.match(/^(\d{2,4})([A-Z]?)$/)
      if (!mm) continue
      const n = Number(mm[1])
      if (n < sheet.range[0] || n > sheet.range[1]) continue
      return [mm[1], mm[2], n]
    }
    return null
  }
  // Description cell, snapped to the grid rules (same row & group as the
  // code/symbol — no cross-numbering). Cropped from the HD raster at the
  // matching scale; grayscale+normalize (no hard threshold — it ate thin
  // strokes), then a uniform-block OCR since cells wrap onto 2–3 lines.
  function readDesc(bx0, y, rh) {
    const [dc0, dc1] = descCell(bx0)
    const descX0 = Math.max(0, dc0)
    const descX1 = Math.min(W - 2, dc1)
    if (descX1 - descX0 <= 30) return ''
    const cw = (descX1 - descX0) * DESC_HD
    const ch = (rh - 10) * DESC_HD
    const cx = descX0 * DESC_HD
    const cy = (y + 5) * DESC_HD
    const descBuf = magick([pngHD,
      '-crop', `${cw}x${ch}+${cx}+${cy}`,
      '+repage', '-colorspace', 'Gray', '-normalize',
      '-bordercolor', 'white', '-border', '18', 'png:-'],
    { binary: true })
    return cleanDescription(ocrBlock(descBuf,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ()/&-.,'))
  }

  // Per-cell scratch shared between Pass 1 (primary, inline) and Pass 2
  // (vRule fallback, sequence-guarded). Row-major: g outer, ri inner.
  const cells = []
  let extracted = 0

  // PASS 1 — gather primary OCR results per cell (proxy noW + 45px right-cut
  // fallback). Do NOT commit yet: the primary path can itself misread (e.g.
  // a row's sign-text bleeds in and parses to an in-range but wrong number),
  // and committing eagerly would (a) ship a mislabelled sign and (b) anchor
  // pass 2's monotone guard to a wrong value, blocking valid recoveries on
  // every subsequent row. The LIS filter below cleans this.
  for (let g = 0; g < symBands.length; g++) {
    const [bx0, bx1] = symBands[g]
    for (let ri = 0; ri < rowBands.length; ri++) {
      const [rowTop, rowBot] = rowBands[ri]
      const y = rowTop, rh = rowBot - rowTop
      // Symbol cell, trimmed to ink. Tight horizontal padding (6px) so a
      // neighbouring column's grid line isn't captured as a side border.
      magick([png, '-crop', `${bx1 - bx0 + 12}x${rh - 8}+${bx0 - 6}+${y + 4}`,
        '+repage', '-fuzz', '8%', '-trim', '+repage', '/tmp/sym.png'])
      const [sw, sh] = identify('/tmp/sym.png')
      const entry = { g, ri, bx0, bx1, rt: rowTop, rb: rowBot, rh, sw, sh,
        symEmpty: !sw || sw < 24 || sh < 24, primNum: null, primCode: null }
      cells.push(entry)
      if (entry.symEmpty) continue
      const m = readNo(bx0, y, rh, noW)
        ?? (noW - RNO >= 24 ? readNo(bx0, y, rh, noW - RNO) : null)
      if (!m) continue
      entry.primNum = m[2]
      entry.primCode = `${sheet.prefix}${m[0]}${m[1]}`
    }
  }

  // LIS FILTER — primary reads should be strictly monotonic in row-major
  // order (codes go down each group then jump up to the next). Any primary
  // that breaks the backbone is an OCR misread; off-LIS entries are dropped
  // here and re-tried by pass 2's vRule fallback. This also auto-removes
  // pre-existing mislabels from `catalogue` in --sheet (merge) mode: if a
  // prior run committed a misread code, the new LIS-filtered primary set
  // doesn't include it, and we delete the stale catalogue entry + PNG so
  // it doesn't keep shipping the wrong pictogram.
  const primCells = cells.filter(c => c.primNum != null)
  const lisSet = lisIndices(primCells.map(c => c.primNum))
  const droppedCodes = []
  primCells.forEach((c, j) => {
    if (lisSet.has(j)) return
    droppedCodes.push(c.primCode)
    c.primNum = null
    c.primCode = null
  })
  for (const code of droppedCodes) {
    if (catalogue[code]) {
      delete catalogue[code]
      await rm(join(SIGNS_DIR, `${code}.png`)).catch(() => {})
    }
  }

  // COMMIT PASS 1 — for every cell with an LIS-kept primary, run the symbol
  // normalize + description OCR and add to catalogue. Identical work to the
  // old inline path; just deferred until after the filter.
  for (const c of cells) {
    if (c.primNum == null || catalogue[c.primCode]) continue
    magick([png, '-crop', `${c.bx1 - c.bx0 + 12}x${c.rh - 8}+${c.bx0 - 6}+${c.rt + 4}`,
      '+repage', '-fuzz', '8%', '-trim', '+repage', '/tmp/sym.png'])
    const desc = readDesc(c.bx0, c.rt, c.rh)
    normalizeSign('/tmp/sym.png', join(SIGNS_DIR, `${c.primCode}.png`))
    catalogue[c.primCode] = { tier: classifyTier(c.sw, c.sh), group: sheet.group }
    if (desc) catalogue[c.primCode].desc = desc
    extracted++
  }

  // PASS 2 — vRule-snap fallback for cells without a kept primary. Done as
  // per-gap LIS over fallback CANDIDATES rather than greedy accept-as-you-go:
  // a consistent-but-wrong fallback misread (a number that happens to fit the
  // bounds) would otherwise permanently raise the lower bound and block all
  // subsequent legitimate lower codes. Within each gap bounded by two LIS-
  // kept primaries, we collect every candidate read, drop those outside the
  // primary bounds, then keep only the longest monotone subset — so a single
  // outlier can't poison the chain.
  function commitFallback(c, code) {
    if (catalogue[code]) return
    magick([png, '-crop', `${c.bx1 - c.bx0 + 12}x${c.rh - 8}+${c.bx0 - 6}+${c.rt + 4}`,
      '+repage', '-fuzz', '8%', '-trim', '+repage', '/tmp/sym.png'])
    const desc = readDesc(c.bx0, c.rt, c.rh)
    normalizeSign('/tmp/sym.png', join(SIGNS_DIR, `${code}.png`))
    catalogue[code] = { tier: classifyTier(c.sw, c.sh), group: sheet.group }
    if (desc) catalogue[code].desc = desc
    extracted++
  }
  let gapLow = -Infinity
  let gapCands = [] // { cell, num, code }
  function flushGap(gapHigh) {
    if (!gapCands.length) return
    const fit = gapCands.filter(c => c.num > gapLow && c.num < gapHigh)
    const keep = lisIndices(fit.map(c => c.num))
    fit.forEach((c, j) => {
      if (keep.has(j)) commitFallback(c.cell, c.code)
    })
    gapCands = []
  }
  for (const c of cells) {
    if (c.primNum != null) {
      flushGap(c.primNum)
      gapLow = c.primNum
      continue
    }
    if (c.symEmpty) continue
    const m = readNoVR(c.bx0, c.rt, c.rh)
    if (!m) continue
    gapCands.push({ cell: c, num: m[2], code: `${sheet.prefix}${m[0]}${m[1]}` })
  }
  flushGap(Infinity)
  return extracted
}

// Optional dev sheet filter: `--sheet <pat>` processes ONLY sheets whose PDF
// filename contains <pat>, merges into the existing signCatalogue.json (no
// wipe), and overwrites PNGs only for codes from the matched sheets. The
// canonical build runs unfiltered — full wipe + full regen across all 16
// sheets — and stays the source of truth; this is purely for fast targeted
// iteration on one sheet without re-OCRing the others.
const sheetFilter = (() => {
  const i = process.argv.indexOf('--sheet')
  return i >= 0 ? process.argv[i + 1] : null
})()

requireTool('pdftoppm', 'brew install poppler')
requireTool('magick', 'brew install imagemagick')
requireTool('tesseract', 'brew install tesseract')

await mkdir(SIGNS_DIR, { recursive: true })
const catalogue = {}
if (sheetFilter) {
  try {
    Object.assign(catalogue, JSON.parse(await readFile(CATALOGUE_JSON, 'utf8')))
    console.log(`--sheet "${sheetFilter}" → merging into existing ${Object.keys(catalogue).length} codes`)
  } catch { /* no existing catalogue → start fresh */ }
} else {
  for (const f of await readdir(SIGNS_DIR).catch(() => [])) {
    if (f.endsWith('.png')) await rm(join(SIGNS_DIR, f))
  }
}

const sheetsToRun = sheetFilter
  ? SHEETS.filter(s => s.pdf.includes(sheetFilter))
  : SHEETS
if (sheetFilter && !sheetsToRun.length) {
  console.error(`No sheet matched "${sheetFilter}". Available:\n`
    + SHEETS.map(s => '  ' + s.pdf).join('\n'))
  process.exit(1)
}
for (const sheet of sheetsToRun) {
  process.stdout.write(`Extracting ${sheet.pdf} … `)
  const n = await extractSheet(sheet, catalogue)
  console.log(`${n} signs`)
}

const codes = Object.keys(catalogue).sort()
await writeFile(CATALOGUE_JSON, JSON.stringify(catalogue, null, 2) + '\n')

// Contact sheet for human spot-check: filename (= code) labels each cell.
spawnSync('montage', [
  ...codes.map(c => `${join(SIGNS_DIR, `${c}.png`)}`),
  '-tile', '10x', '-geometry', '120x120+4+20',
  '-background', 'white', '-label', '%t', QA_MONTAGE
])

console.log(`\n${codes.length} codes → ${CATALOGUE_JSON}`)
console.log(`QA montage → ${QA_MONTAGE} (review before trusting output)`)
