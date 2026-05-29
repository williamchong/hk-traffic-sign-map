// Build the sign catalogue from TD's Index Plan PDFs — PDF → SVG, follow the grid.
//
// The Index Plan PDFs are vector (a MicroStation DGN export): the table ruling
// lines, the printed "No." digits and most pictograms are PATH geometry, with a
// handful of pictograms embedded as raster images. There is no text layer, so
// the digits still have to be READ (OCR), but everything else is recoverable
// from the vector structure. So we DON'T rasterise the whole page and hunt for
// signs in pixels; instead, per page:
//
//   1. RENDER FROM SVG. `mutool draw -F svg` emits the page as an SVG whose
//      viewBox is in PDF points; `rsvg-convert` renders it crisply (vector signs
//      AND the embedded-image ones). One high-resolution page raster per sheet,
//      in the SAME point coordinate system as the grid below.
//
//   2. VECTOR GRID (point-space). `mutool draw -F trace` flattens every path to
//      device coordinates; we keep them in POINTS (no DPI scaling) so geometry
//      and the SVG share one coordinate system. Full-table-height vertical rules
//      are the column dividers; the table repeats [No. | Symbol | Description]
//      per column-group. Rows are found PER GROUP from the horizontal rules
//      spanning that group's width, so a per-group rowspan (one number labelling
//      a tall stacked cell on the informatory sheets) reads as ONE row.
//
//   3. SYMBOL CELL = ACTUAL DIVIDERS. Each sign's crop box is bounded by that
//      group's OWN full-height dividers: symbol-left = the rule after the No.
//      cell, symbol-right = that group's next full-height rule (the Symbol|
//      Description divider). This is the key correctness property — a single
//      median symbol width applied to every group used to bleed past the real
//      divider into the description column on the informatory/rowspan sheets, so
//      the trim couldn't tighten and the sign came out a wide sliver. A measured
//      median width is used ONLY to synthesise a group whose dividers were
//      interrupted (e.g. the bottom-right title block).
//
//   4. OCR BIND. The printed "No." code is read per cell with tesseract from the
//      crisp rsvg render. The symbol is cropped from the SAME row band, so code
//      and pictogram cannot desync.
//
// Misread defenses (the catalogue is the Index Plan's set of DEFINED sign types,
// which is a superset of the installed inventory — so we deliberately do NOT
// filter against the GML point inventory; that would drop real, defined-but-
// not-currently-installed signs):
//
//   - RANGE GATE. A read is kept only if it parses to a number inside this
//     sheet's printed range, so an out-of-range "(TC …)" reference or stray digit
//     can't become a sign.
//   - MONOTONICITY WARNING. The No. column is sorted within a group; an
//     out-of-order read is logged so a digit misread is visible before review.
//   - HUMAN GATE (--propose / --commit). Recovery stages crops + a verify.png
//     (each candidate's SOURCE [printed No. | pictogram] strip, labelled with the
//     OCR'd code) and writes NOTHING to the repo; a human confirms every
//     printed-number↔label before --commit promotes the crops. Upholds the
//     documented "a missed sign degrades to a dot — a MISLABELLED sign must
//     never ship". This is the gate that catches an OCR digit misread.
//
// Descriptions are OPT-IN (--desc): a single Sonnet full-page read per sheet
// gives the bilingual {en, zh} text. Off by default — the runtime sources
// descriptions from curated app/data/signDescriptions.json (it PREFERS that over
// the extracted `desc`), and tesseract here has no Traditional-Chinese model.
// The default image rebuild is fully deterministic and needs NO API key.
//
// Usage:
//   node scripts/build-sign-catalogue.mjs                  # rebuild images, merge
//   ... --wipe --propose                                   # stage a CLEAN full rebuild
//   ... --propose                                          # stage only NEW signs
//   ... --sheet "601 - 700"                                # one sheet only
//   ... --wipe --commit [--reject TS208,TS209]             # replace repo with staged
//   ... --commit [--reject TS208,TS209]                    # merge staged into repo
//   ANTHROPIC_API_KEY=sk-ant-... ... --desc                # also read descriptions
//
// Tools: brew install librsvg mupdf-tools imagemagick tesseract
// Cost: $0 by default (deterministic). With --desc, ~$0.15 to read all 16 sheets.

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const INDEX_PLAN_DIR = 'data/tadrawings_dataspec/Index Plan'
const SIGNS_DIR = 'public/signs'
const CATALOGUE_JSON = 'app/data/signCatalogue.json'
const MODEL = 'claude-sonnet-4-6'
// Page raster scale: SVG user units are PDF points, so rendered px = point × this.
// 8 ≈ 576 DPI — crisp pictograms and legible No.-cell digits for OCR.
const RENDER_SCALE = 8

// Grid geometry thresholds, all in PDF POINTS (the trace/SVG coordinate system).
const CB_MERGE = 4 // cluster verticals closer than this (doublet group separators)
const NO_W = [12, 32] // No.-column cell width band
const SYM_W = [24, 140] // Symbol-cell width band (validates the actual divider)
const MIN_ROW = 5 // drop row bands thinner than this (header slivers / double rules)
const STAGING = '/tmp/sign-recovery'
// Working-tree scratch for tesseract's input crop. It must NOT live under /tmp:
// some sandboxes let a spawned tesseract read only the working tree, so a /tmp
// input silently fails to open (magick is unaffected — it reads /tmp fine).
// data/raw/ is gitignored and always present (the GML lives there).
const SCRATCH = 'data/raw/.sign-cache'
mkdirSync(SCRATCH, { recursive: true })

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
requireTool('mutool', 'brew install mupdf-tools') // PDF → SVG + path-geometry trace
requireTool('rsvg-convert', 'brew install librsvg') // SVG → crisp page raster
requireTool('magick', 'brew install imagemagick') // crops / normalisation / montages
requireTool('tesseract', 'brew install tesseract') // No.-column digit OCR (the bind)
// ImageMagick registers no fonts in this environment (`magick -list font` is
// empty), so `montage` — used for the review / verify sheets — can't render even
// an empty label without an explicit -font. Resolve one system TTF up front.
const FONT = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
].find(f => existsSync(f))
if (!FONT) {
  console.error('No usable TTF found for `magick montage` — set FONT in build-sign-catalogue.mjs')
  process.exit(1)
}

// `--sheet <pattern>` filters which Index Plan sheets to process by substring
// match against the PDF filename. Omitted → all 16 sheets.
const sheetFilter = (() => {
  const i = process.argv.indexOf('--sheet')
  return i >= 0 ? process.argv[i + 1] : null
})()
// `--wipe` is a CLEAN rebuild: in --propose it stages every sign (no dup-skip
// against the existing catalogue); in --commit it clears public/signs/ and resets
// the catalogue to {} before promoting, so the rebuild REPLACES rather than merges.
const wipe = process.argv.includes('--wipe')
// Human-gated recovery. `--propose` stages crops + review/verify montages + a
// manifest under STAGING and writes NOTHING to the repo; `--commit` promotes the
// approved staged crops; `--reject TS208,TS209` drops specific codes on commit.
const propose = process.argv.includes('--propose')
const doCommit = process.argv.includes('--commit')
const rejectList = (() => {
  const i = process.argv.indexOf('--reject')
  return new Set(i >= 0 ? (process.argv[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : [])
})()
// PASS 1 (descriptions) is additive-only by default — it fills a MISSING desc but
// never clobbers an existing one. `--update-desc` opts back into overwrite.
const updateDesc = process.argv.includes('--update-desc')
// `--desc` opts INTO the VLM bilingual-description read. Off by default.
const descMode = process.argv.includes('--desc')
if (descMode && !process.env.ANTHROPIC_API_KEY) {
  console.error('--desc needs ANTHROPIC_API_KEY for the description read')
  process.exit(1)
}

// ---- small process / image helpers ----
function magick(args, { binary = false } = {}) {
  const r = spawnSync('magick', args, { maxBuffer: 1 << 30, encoding: binary ? 'buffer' : 'utf8' })
  if (r.status !== 0) throw new Error(`magick ${args.join(' ')}\n${r.stderr}`)
  return r.stdout
}
function identify(file) {
  const out = spawnSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' })
  return out.stdout.trim().split(/\s+/).map(Number)
}
const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const PX = pt => Math.round(pt * RENDER_SCALE) // points → page-raster pixels
async function clearSignsDir() {
  for (const f of await readdir(SIGNS_DIR).catch(() => [])) {
    if (f.endsWith('.png')) await rm(join(SIGNS_DIR, f))
  }
}

// ---- render the page from its SVG (points → crisp raster) ----
function renderPage(pdf, tag) {
  const svg = `/tmp/sign-${tag}.svg`
  const r = spawnSync('mutool', ['draw', '-F', 'svg', '-o', svg, pdf, '1'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`mutool svg failed: ${r.stderr}`)
  // -b white: rsvg renders a TRANSPARENT background by default, which every
  // downstream grayscale op (OCR threshold, symbol trim/flood) composites as
  // black — erasing the page. A white page is what the pipeline expects.
  const png = `/tmp/sign-${tag}.png`
  const c = spawnSync('rsvg-convert', ['-z', String(RENDER_SCALE), '-b', 'white', svg, '-o', png], { maxBuffer: 1 << 30 })
  if (c.status !== 0) throw new Error(`rsvg-convert failed: ${c.stderr}`)
  return png
}

// ---- vector grid: parse axis-aligned ruling segments from the trace, in POINTS ----
function traceSegments(pdf) {
  const tracePath = '/tmp/sign-trace.xml'
  const r = spawnSync('mutool', ['draw', '-F', 'trace', '-o', tracePath, pdf, '1'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`mutool trace failed: ${r.stderr}`)
  const xml = readFileSync(tracePath, 'utf8')
  const pathRe = /<(stroke_path|fill_path)\b([^>]*)>([\s\S]*?)<\/\1>/g
  const tfRe = /transform="([^"]+)"/
  const ptRe = /<(moveto|lineto) x="([-\d.]+)" y="([-\d.]+)"/g
  const Hs = [], Vs = []
  for (const pm of xml.matchAll(pathRe)) {
    const tf = tfRe.exec(pm[2])
    const m = tf ? tf[1].split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0]
    let cur = null
    for (const s of pm[3].matchAll(ptRe)) {
      const px = +s[2], py = +s[3]
      const X = m[0] * px + m[2] * py + m[4] // POINTS
      const Y = m[1] * px + m[3] * py + m[5]
      if (s[1] === 'lineto' && cur) {
        const [x0, y0] = cur
        // length floors (in points) drop glyph hairlines but keep cell borders.
        if (Math.abs(Y - y0) < 0.3 && Math.abs(X - x0) > 3) Hs.push({ y: (Y + y0) / 2, x0: Math.min(x0, X), x1: Math.max(x0, X) })
        if (Math.abs(X - x0) < 0.3 && Math.abs(Y - y0) > 5) Vs.push({ x: (X + x0) / 2, y0: Math.min(y0, Y), y1: Math.max(y0, Y) })
      }
      cur = [X, Y]
    }
  }
  return { Hs, Vs }
}

// Reconstruct the [No. | Symbol | Description] column-groups from the full-height
// vertical rules. Each group's symbol cell is bounded by that group's OWN
// dividers; a measured median width only synthesises a group whose dividers were
// interrupted. Returns groups (points) + the table top/bot (points).
function columnModel(Vs) {
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
      groups.push({ no: [nL, nR], sym: [nR, symRight] })
    } else {
      groups.push({ no: [gl, gl + noW], sym: [gl + noW, gl + noW + symW] })
    }
  }
  return { groups, top, bot }
}

// Per-group row rules: horizontal borders are drawn per-cell (short collinear
// segments), so cluster H-segments by y and keep a y only where the segments
// collectively span most of the group's width. A rowspan is just a larger gap
// between two kept rules — no uniform pitch assumed.
function groupRows(Hs, xL, xR) {
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
    let cov = 0, cur = -1
    for (const [a, b] of iv) {
      const s = Math.max(a, cur)
      if (b > s) cov += b - s
      cur = Math.max(cur, b)
    }
    if (cov > W * 0.6) ys.push(c.y)
  }
  return ys
}

// OCR a No. cell (point box) → every number token it contains. The cell holds the
// bold sign code AND a smaller "(TC …)" reference line; both read as numbers but
// sit in DIFFERENT ranges, so the caller's range gate keeps the SIGNID and drops
// the TC figure. Two binarisations are tried in order:
//   A. fixed threshold → trim → upscale. Reads clean/thick glyphs.
//   B. upscale → adaptive OTSU → close. Rescues sheets whose strokes are too thin
//      for a fixed threshold.
// `accept` (the range gate) lets us STOP after A once it yields an in-range code,
// so B only runs where A reads blank. We inset the crop past the border rules (a
// black edge would defeat the trim) and cap the height so a tall rowspan cell
// doesn't pull in unrelated text. Whitelist = digits + L/T/R suffix letters.
function ocrCode(png, x, y, w, h, accept = () => false) {
  const cell = join(SCRATCH, 'ocr-no.png')
  const outBase = join(SCRATCH, 'ocr-no')
  const inset = Math.round(RENDER_SCALE * 0.8)
  const cropGeom = `${w - 2 * inset}x${Math.min(h - 2 * inset, PX(18))}+${x + inset}+${y + inset}`
  const recipes = [
    ['-colorspace', 'Gray', '-threshold', '60%',
      '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '14', '-resize', '300%'],
    ['-colorspace', 'Gray', '-resize', '200%', '-auto-threshold', 'OTSU',
      '-negate', '-morphology', 'Close', 'Octagon:1', '-negate',
      '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '18']
  ]
  const tokens = []
  for (const recipe of recipes) {
    magick([png, '-crop', cropGeom, '+repage', ...recipe, cell])
    const r = spawnSync('tesseract', [cell, outBase, '--psm', '6',
      '-c', 'tessedit_char_whitelist=0123456789LTR'], { encoding: 'utf8' })
    if (r.status === 0) tokens.push(...readFileSync(`${outBase}.txt`, 'utf8').split(/\s+/).map(s => s.trim()).filter(Boolean))
    if (tokens.some(accept)) break
  }
  return tokens
}

// Does a catalogue entry already carry a description? `desc` is either the legacy
// bare-string form or the {en?, zh?} object — both are checked.
const descObj = raw => (typeof raw === 'string' ? { en: raw } : raw) || null
function descExists(raw) {
  const p = descObj(raw)
  return !!(p && (p.en || p.zh))
}
// Visual-complexity band (controls the runtime reveal zoom + top-of-ramp size).
function classifyTier(w, h) {
  const aspect = w / h
  if (aspect > 1.7 || aspect < 0.58) return 2
  const big = Math.max(w, h)
  if (aspect > 1.25 || aspect < 0.8 || big > 320) return 1
  return 0
}
function opaqueFraction(file) {
  const r = spawnSync('magick', [file, '-alpha', 'extract', '-format', '%[fx:mean]', 'info:'], { encoding: 'utf8' })
  return parseFloat(r.stdout) || 0
}
// Trim to content, flood-fill the contiguous background to transparent, and size
// to fit 320×120 as 32-bit PNG. The flood removes the cell's white margin around
// an inscribed sign (circle/triangle); but for a filled rectangular plate the
// flood would eat the whole sign, so if too little opaque area survives we fall
// back to the plain trimmed (opaque) crop.
function normalizeSign(symRaw, outPath) {
  const trimmed = '/tmp/sym-t.png'
  magick([symRaw, '-fuzz', '6%', '-trim', '+repage', trimmed])
  const flooded = '/tmp/sym-f.png'
  magick([trimmed, '-alpha', 'set', '-bordercolor', 'white', '-border', '1',
    '-fuzz', '12%', '-fill', 'none', '-draw', 'color 0,0 floodfill',
    '-shave', '1x1', '-channel', 'A', '-morphology', 'Erode', 'Octagon:1',
    '+channel', '-trim', '+repage', flooded])
  const base = opaqueFraction(flooded) < 0.40
    ? [trimmed, '-alpha', 'set']
    : [flooded]
  magick([...base, '-resize', '320x120', '-background', 'none', '+repage', `PNG32:${outPath}`])
}

// ---- VLM call (descriptions only, opt-in via --desc) ----
const sleep = ms => new Promise(r => setTimeout(r, ms))
function parseJsonLoose(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    const i = raw.indexOf('['), j = raw.lastIndexOf(']')
    if (i < 0 || j <= i) return null
    try {
      return JSON.parse(raw.slice(i, j + 1))
    } catch {
      return null
    }
  }
}
async function callVLM(jpgBuf, prompt) {
  const body = {
    model: MODEL,
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpgBuf.toString('base64') } },
        { type: 'text', text: prompt }
      ]
    }]
  }
  const backoffs = [15_000, 30_000, 60_000, 120_000]
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      })
    } catch (err) {
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message
      if (attempt >= backoffs.length) {
        console.error(`network error after ${attempt + 1} attempts: ${reason}`)
        process.exit(1)
      }
      console.error(`  network error (${reason}) on attempt ${attempt + 1} — backing off ${backoffs[attempt] / 1000}s`)
      await sleep(backoffs[attempt])
      continue
    }
    if (res.ok) {
      const j = await res.json()
      if (j.stop_reason === 'max_tokens') {
        console.error(`API truncated at max_tokens (${body.max_tokens}) — raise the cap; refusing a partial read.`)
        process.exit(1)
      }
      const raw = (j.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
      return { raw, usage: j.usage }
    }
    const txt = await res.text()
    const retriable = res.status === 429 || res.status === 529 || res.status >= 500
    if (!retriable || attempt >= backoffs.length) {
      console.error(`API ${res.status}:`, txt.slice(0, 300))
      process.exit(1)
    }
    console.error(`  ${res.status} on attempt ${attempt + 1} — backing off ${backoffs[attempt] / 1000}s`)
    await sleep(backoffs[attempt])
  }
}
async function readSheetVLM(jpgBuf) {
  const prompt = `This is one page from the Hong Kong Transport Department "Index Plan" — a reference of all traffic signs. The page is a table whose columns repeat the pattern [No. | Symbol | Description] for each column-group. Codes ("641", "642", …) appear in the small "No." column at the LEFT of each group. Codes go down each group, then continue at the top of the next group to the right.

For each row that has a sign code (skip blank / "SYMBOL NOT AVAILABLE" / placeholder rows entirely — do NOT emit them), return an object:

  { "code": "641", "en": "DIRECTION TO FOOTBRIDGE", "zh": "通往人行天橋" }

where:
  - "code" = exact digits in the No. column, preserving any letter suffix (e.g. "636L", "639T").
  - "en"   = the ENGLISH text in the row's Description column, UPPERCASE, with Chinese characters and "(DOUBLE SIDES)" sub-notes omitted. Empty string if the column has no English.
  - "zh"   = the TRADITIONAL CHINESE (Hong Kong, 繁體中文) text in the SAME Description column. Omit any English/digits/parentheses/whitespace separators. Empty string if the column has no Chinese.

Return ONLY a JSON array of arrays. Outer array = column-groups, left to right. Inner arrays = the rows of that group with codes. Skip blank rows entirely. No markdown fences, no prose.`
  for (let attempt = 0; attempt < 3; attempt++) {
    const { raw, usage } = await callVLM(jpgBuf, prompt)
    const parsed = parseJsonLoose(raw)
    if (Array.isArray(parsed)) return { parsed, usage }
    console.error(`  full-page read non-JSON (starts "${raw.slice(0, 40).replace(/\s+/g, ' ')}…") — re-asking (attempt ${attempt + 1}/3)`)
  }
  return null
}

// ---- per-sheet extraction ----
async function extractSheet(sheet, catalogue) {
  const pdf = join(INDEX_PLAN_DIR, sheet.pdf)
  const tag = `${sheet.prefix}-${sheet.range[0]}`
  const png = renderPage(pdf, tag)

  // Vector grid: columns (actual dividers) + per-group rows, all in points.
  const { Hs, Vs } = traceSegments(pdf)
  const { groups, top, bot } = columnModel(Vs)
  for (const g of groups) {
    const ys = groupRows(Hs, g.no[0], g.sym[1]).filter(y => y >= top - 1 && y <= bot + 1)
    g.cells = []
    for (let i = 0; i < ys.length - 1; i++) {
      if (ys[i + 1] - ys[i] < MIN_ROW) continue
      g.cells.push([ys[i], ys[i + 1]])
    }
  }
  const totalCells = groups.reduce((n, g) => n + g.cells.length, 0)
  console.log(`[${sheet.pdf}] grid: ${groups.length} groups, rows/group=[${groups.map(g => g.cells.length).join(',')}], ${totalCells} cells`)

  // Normalise a raw No.-column string to {code}, gated by this sheet's numeric
  // range. Returns null for blanks / out-of-range / malformed reads.
  function parseCode(raw0) {
    const raw = String(raw0 ?? '').toUpperCase().replace(/\s+/g, '')
    if (!raw || raw === 'NONE') return null
    const m = raw.match(/^(\d{2,4})([A-Z]?)$/)
    if (!m) return null
    const n = +m[1]
    if (n < sheet.range[0] || n > sheet.range[1]) return null
    return { code: `${sheet.prefix}${m[1]}${m[2]}` }
  }
  function parseCell(item) {
    if (item == null || typeof item !== 'object') return null
    const c = parseCode(item.code)
    if (!c) return null
    const en = String(item.en ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
    const zh = String(item.zh ?? '').trim().replace(/\s+/g, '')
    const desc = {}
    if (en) desc.en = en
    if (zh) desc.zh = zh
    return { ...c, desc }
  }
  function descEqual(a, b) {
    if (!a || !b) return a === b
    return a.en === b.en && a.zh === b.zh
  }

  // Optional bilingual descriptions (--desc): one Sonnet full-page read.
  const descByCode = new Map()
  if (descMode) {
    const jpg = `/tmp/sign-${tag}.jpg`
    magick([png, '-resize', '1600x', '-quality', '92', jpg])
    const pageRes = await readSheetVLM(readFileSync(jpg))
    if (!pageRes) {
      console.error(`[${sheet.pdf}] description read failed after retries — continuing without descs`)
    } else {
      for (const grp of pageRes.parsed) {
        for (const item of (grp ?? [])) {
          const cell = parseCell(item)
          if (cell && (cell.desc.en || cell.desc.zh)) descByCode.set(cell.code, cell.desc)
        }
      }
      console.log(`[${sheet.pdf}] descriptions: ${descByCode.size} codes, usage out=${pageRes.usage?.output_tokens}`)
    }
  }

  const sheetTag = `${sheet.prefix}${sheet.range[0]}-${sheet.range[1]}`
  const outDir = propose ? join(STAGING, sheetTag) : SIGNS_DIR
  if (propose) await mkdir(outDir, { recursive: true })

  // PASS 1 — additive descriptions for codes already in the catalogue.
  let descAdded = 0, descUpdated = 0
  const descAdds = []
  for (const [code, desc] of descByCode) {
    if (!catalogue[code]) continue
    const prevRaw = catalogue[code].desc
    const prev = descObj(prevRaw)
    const hasPrev = descExists(prevRaw)
    if (hasPrev && !updateDesc) continue
    if (descEqual(prev, desc)) continue
    hasPrev ? descUpdated++ : descAdded++
    if (propose) descAdds.push({ code, desc })
    else catalogue[code].desc = desc
  }

  // PASS 2 — pictograms. For each grid cell: OCR the No. cell → code (range-gated),
  // then crop the symbol from the SAME row band so code and pictogram can't
  // desync. With --wipe we re-extract every code (clean rebuild); otherwise a code
  // already in the catalogue is skipped as a dup.
  let added = 0, droppedSmall = 0, droppedDup = 0, droppedUnread = 0
  const adds = []
  const seen = new Set()
  const ins = 1.5 // point inset past the cell ruling lines
  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi]
    let prevN = 0
    for (const [rtop, rbot] of grp.cells) {
      const tokens = ocrCode(png, PX(grp.no[0]), PX(rtop), PX(grp.no[1] - grp.no[0]), PX(rbot - rtop), parseCode)
      const c = tokens.map(parseCode).find(Boolean) || null
      if (!c) {
        if (tokens.length) droppedUnread++
        continue
      }
      // The No. column is sorted within a group — flag (don't drop) an OCR read
      // that breaks it, so a digit misread is visible in the log.
      const n = parseInt(c.code.replace(/\D/g, ''), 10)
      if (prevN && n < prevN) console.warn(`[${sheet.pdf}] ⚠ group ${gi}: OCR ${c.code} < previous ${prevN} (out of order) — check verify.png`)
      prevN = n
      if (seen.has(c.code) || (!wipe && catalogue[c.code])) {
        droppedDup++
        continue
      }
      const [sx0, sx1] = grp.sym
      const symRaw = '/tmp/sym.png'
      magick([png, '-crop', `${PX(sx1 - sx0 - 2 * ins)}x${PX(rbot - rtop - 2 * ins)}+${PX(sx0 + ins)}+${PX(rtop + ins)}`,
        '+repage', '-fuzz', '8%', '-trim', '+repage', symRaw])
      const [sw, sh] = identify(symRaw)
      if (!sw || sw < 24 || sh < 24) {
        droppedSmall++
        continue
      }
      normalizeSign(symRaw, join(outDir, `${c.code}.png`))
      const entry = { tier: classifyTier(sw, sh), group: sheet.group }
      const desc = descByCode.get(c.code)
      if (desc && (desc.en || desc.zh)) entry.desc = desc
      seen.add(c.code)
      // src = the source row box (No.-cell left → symbol-cell right) for a
      // ground-truth [printed number | pictogram] crop at review time.
      if (propose) adds.push({ code: c.code, ...entry, src: { x: grp.no[0], y: rtop, w: sx1 - grp.no[0], h: rbot - rtop } })
      else catalogue[c.code] = entry
      added++
    }
  }
  console.log(`[${sheet.pdf}] added=${added} desc-added=${descAdded} desc-updated=${descUpdated} empty=${droppedSmall} dup=${droppedDup} unreadable=${droppedUnread}`)

  // In propose mode write nothing to the repo — stage a manifest + a review
  // montage (the normalized asset) + a verify montage (each candidate's SOURCE
  // [printed No. | pictogram] strip) so a human can confirm every code↔crop.
  if (propose) {
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ sheet: sheet.pdf, group: sheet.group, adds, descAdds }, null, 2) + '\n')
    if (adds.length) {
      const labelArgs = []
      for (const a of adds) labelArgs.push('-label', a.code, join(outDir, `${a.code}.png`))
      magick(['montage', '-font', FONT, ...labelArgs, '-tile', '6x', '-geometry', '200x160+8+8', '-background', 'white', '-fill', 'black', '-pointsize', '22', join(outDir, 'review.png')])
      const vArgs = ['montage', '-font', FONT]
      for (const a of adds) {
        const { x, y, w, h } = a.src
        const vf = `/tmp/vsrc-${a.code}.png`
        magick([png, '-crop', `${PX(w) + 8}x${PX(h) - 4}+${Math.max(0, PX(x) - 4)}+${PX(y) + 2}`, '+repage', '-resize', '440x180', vf])
        vArgs.push('-label', a.code, vf)
      }
      vArgs.push('-tile', '3x', '-geometry', '460x200+8+8', '-background', 'white', '-fill', 'black', '-pointsize', '26', join(outDir, 'verify.png'))
      magick(vArgs)
    }
    console.log(`[${sheet.pdf}] staged ${adds.length} crop(s) + ${descAdds.length} desc-add(s) -> ${join(outDir, 'verify.png')}`)
  }
  return added
}

// ---- commit: promote staged (--propose) crops into public/signs/ + catalogue ----
if (doCommit) {
  if (!existsSync(CATALOGUE_JSON)) {
    console.error(`no catalogue at ${CATALOGUE_JSON} to commit into`)
    process.exit(1)
  }
  await mkdir(SIGNS_DIR, { recursive: true })
  // --wipe commit REPLACES: clear public/signs/ + start the catalogue from {}.
  let catalogue = JSON.parse(await readFile(CATALOGUE_JSON, 'utf8'))
  if (wipe) {
    await clearSignsDir()
    catalogue = {}
    console.log('--wipe commit: cleared public/signs/ and reset the catalogue')
  }
  let committed = 0, rejected = 0, descApplied = 0
  for (const dir of (await readdir(STAGING).catch(() => []))) {
    const mfPath = join(STAGING, dir, 'manifest.json')
    if (!existsSync(mfPath)) continue
    const mf = JSON.parse(await readFile(mfPath, 'utf8'))
    if (sheetFilter && !mf.sheet.includes(sheetFilter)) continue
    for (const a of (mf.adds ?? [])) {
      if (rejectList.has(a.code)) {
        rejected++
        continue
      }
      await copyFile(join(STAGING, dir, `${a.code}.png`), join(SIGNS_DIR, `${a.code}.png`))
      const entry = { tier: a.tier, group: a.group }
      if (a.desc) entry.desc = a.desc
      catalogue[a.code] = entry
      committed++
    }
    for (const da of (mf.descAdds ?? [])) {
      if (rejectList.has(da.code) || !catalogue[da.code]) continue
      if (descExists(catalogue[da.code].desc) && !updateDesc) continue
      catalogue[da.code].desc = da.desc
      descApplied++
    }
  }
  await writeFile(CATALOGUE_JSON, JSON.stringify(catalogue, null, 2) + '\n')
  console.log(`committed ${committed} pictogram(s) + ${descApplied} desc(s); rejected ${rejected}`)
  process.exit(0)
}

// ---- main ----
await mkdir(SIGNS_DIR, { recursive: true })
// --propose never mutates the repo, so even with --wipe we keep the real catalogue
// + public/signs/ intact here (we only read them for the dup/desc checks; --wipe
// in propose just means "stage every sign", handled in extractSheet).
if (wipe && !propose) {
  await clearSignsDir()
  console.log('--wipe: cleared public/signs/ and starting from an empty catalogue')
}
const catalogue = (wipe && !propose) || !existsSync(CATALOGUE_JSON)
  ? {}
  : JSON.parse(await readFile(CATALOGUE_JSON, 'utf8'))
const before = Object.keys(catalogue).length
console.log(`existing catalogue: ${before} codes${descMode ? ' (--desc: reading bilingual descriptions)' : ''}`)

const sheetsToRun = sheetFilter
  ? SHEETS.filter(s => s.pdf.includes(sheetFilter))
  : SHEETS
if (sheetFilter && !sheetsToRun.length) {
  console.error(`No sheet matched "${sheetFilter}". Available:\n` + SHEETS.map(s => '  ' + s.pdf).join('\n'))
  process.exit(1)
}
let totalAdded = 0
for (const sheet of sheetsToRun) {
  totalAdded += await extractSheet(sheet, catalogue)
}
if (propose) {
  const commitHint = wipe
    ? 'node scripts/build-sign-catalogue.mjs --wipe --commit [--reject TS###,TS###]'
    : 'node scripts/build-sign-catalogue.mjs --commit [--reject TS###,TS###]'
  console.log(`\nproposed ${totalAdded} pictogram(s) across ${sheetsToRun.length} sheet(s). Review each <sheet>/verify.png under ${STAGING}, then: ${commitHint}`)
} else {
  await writeFile(CATALOGUE_JSON, JSON.stringify(catalogue, null, 2) + '\n')
  console.log(`\nfinal catalogue: ${Object.keys(catalogue).length} codes (+${totalAdded})`)
}
