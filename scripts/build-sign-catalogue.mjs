// Build the sign catalogue from TD's Index Plan PDFs.
//
// The Index Plan PDFs are vector (a MicroStation DGN export): the table ruling
// lines, pictograms and digits are all PATH geometry, not a scanned raster
// (mutool trace shows ~55k linetos and zero text ops per page). So we read the
// grid straight from that geometry instead of re-deriving it from rendered
// pixels — no ink-profile thresholds, no hardcoded column lattice, and no VLM
// to bind rows. Per page:
//
//   1. VECTOR GRID. `mutool draw -F trace` flattens every path to device
//      (point) coordinates. Full-table-height vertical rules are the column
//      dividers (pictogram-internal strokes are short and filtered by height);
//      we MEASURE the [No. | Symbol | Description] lattice (origin / pitch /
//      sub-cell widths) from them per sheet, then synthesise any group whose
//      internal dividers were interrupted (e.g. the bottom-right title block).
//      Rows are found PER GROUP from the horizontal rules spanning that group's
//      width — so a per-group rowspan (one number labelling a tall stacked cell
//      on informatory sheets) reads as ONE row, not mis-split by a neighbour
//      group's denser ruling. This is exactly what the old page-wide shared
//      R×C grid could not represent — it dropped the rowspan sheets (601-700,
//      2601-2717, 3601-3705, 3811-3936).
//
//   2. OCR BIND. The printed "No." code is read per cell with tesseract (clean
//      isolated digits — the historical full-extraction tesseract failure
//      doesn't apply to an isolated number cell). The symbol is then cropped
//      from the SAME [top,bot] band, so code and pictogram cannot desync.
//
// Two safety nets remain, because they're cheaper than trust:
//
//   - GML SIGNID FILTER. A code is only KEPT if it appears at least once in
//     data/raw/DTAD_TS_ABV_PT.gml (the codes actually on HK road signs). Drops
//     OCR misreads of non-existent numbers loss-lessly (the app never refs them).
//   - HUMAN GATE (--propose / --commit). Recovery stages crops + a verify.png
//     (each candidate's SOURCE [printed No. | pictogram] strip, labelled with the
//     OCR'd code) and writes NOTHING to the repo; a human confirms every
//     printed-number↔label before --commit promotes the crops. Upholds the
//     documented "a missed sign degrades to a dot — a MISLABELLED sign must
//     never ship". This is the gate that catches an OCR digit misread.
//
// Descriptions are OPT-IN (--desc): a single Sonnet full-page read per sheet
// gives the bilingual {en, zh} text. Off by default — the runtime sources
// descriptions from curated app/data/signDescriptions.json (it PREFERS that
// over the extracted `desc`), and tesseract here has no Traditional-Chinese
// model, so OCR'ing descriptions would lose the Chinese half. The default
// image rebuild is therefore fully deterministic and needs NO API key.
//
// Usage:
//   node scripts/build-sign-catalogue.mjs                  # rebuild images, merge
//   ... --wipe                                             # rebuild, wipe first
//   ... --sheet "601 - 700"                                # one sheet only
//   ... --propose                                          # stage for human review
//   ... --commit [--reject TS208,TS209]                    # promote approved crops
//   ANTHROPIC_API_KEY=sk-ant-... ... --desc                # also read descriptions
//
// Cost: $0 by default (deterministic). With --desc, ~$0.15 to read all 16
// sheets (one Sonnet full-page read per sheet).

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const INDEX_PLAN_DIR = 'data/tadrawings_dataspec/Index Plan'
const SIGNS_DIR = 'public/signs'
const CATALOGUE_JSON = 'app/data/signCatalogue.json'
const GML = 'data/raw/DTAD_TS_ABV_PT.gml'
const DPI = 400
const PT2PX = DPI / 72 // mutool trace is in PDF points (72dpi); pdftoppm renders at DPI
const MODEL = 'claude-sonnet-4-6'

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
requireTool('pdftoppm', 'brew install poppler')
requireTool('magick', 'brew install imagemagick')
requireTool('mutool', 'brew install mupdf-tools') // vector grid extraction
requireTool('tesseract', 'brew install tesseract') // No.-column digit OCR (the bind)
// ImageMagick registers no fonts in this environment (`magick -list font` is
// empty), so `montage` — used for the review / verify sheets — can't render
// even an empty label without an explicit -font. Resolve one system TTF up
// front and fail loud if none exists.
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
// `--wipe` blows away the existing catalogue + public/signs/ before running,
// for a clean full rebuild from source. Without it the script merges into
// what's already there, which lets `--sheet` runs do surgical updates.
const wipe = process.argv.includes('--wipe')
// Human-gated recovery. `--propose` stages crops + review/verify montages + a
// manifest under STAGING and writes NOTHING to the repo; `--commit` promotes
// the approved staged crops into public/signs/ + the catalogue; `--reject
// TS208,TS209` drops specific codes on commit.
const propose = process.argv.includes('--propose')
const doCommit = process.argv.includes('--commit')
const rejectList = (() => {
  const i = process.argv.indexOf('--reject')
  return new Set(i >= 0 ? (process.argv[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : [])
})()
// PASS 1 (descriptions) is additive-only by default — it fills a MISSING desc
// but never clobbers an existing one. `--update-desc` opts back into overwrite.
const updateDesc = process.argv.includes('--update-desc')
// `--desc` opts INTO the VLM bilingual-description read. Off by default (the
// deterministic image rebuild needs no API key); see the file header.
const descMode = process.argv.includes('--desc')
if (descMode && !process.env.ANTHROPIC_API_KEY) {
  console.error('--desc needs ANTHROPIC_API_KEY for the description read')
  process.exit(1)
}
const STAGING = '/tmp/sign-recovery'
// Working-tree scratch for tesseract's input crop. It must NOT live under /tmp:
// some sandboxes let a spawned tesseract read only the working tree, so a
// /tmp input silently fails to open (magick is unaffected — it reads /tmp
// fine). data/raw/ is gitignored and always present (the GML lives there).
const SCRATCH = 'data/raw/.sign-cache'
mkdirSync(SCRATCH, { recursive: true })

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

// ---- vector grid: parse the page geometry from mutool's device-space trace ----
// Returns horizontal + vertical axis-aligned segments in render pixels.
function traceSegments(pdf) {
  const tracePath = '/tmp/sign-trace.xml'
  const r = spawnSync('mutool', ['draw', '-F', 'trace', '-o', tracePath, pdf, '1'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`mutool draw failed: ${r.stderr}`)
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
      const X = (m[0] * px + m[2] * py + m[4]) * PT2PX
      const Y = (m[1] * px + m[3] * py + m[5]) * PT2PX
      if (s[1] === 'moveto') {
        cur = [X, Y]
        continue
      }
      if (cur) {
        const [x0, y0] = cur
        // an axis-aligned segment is a horizontal or vertical ruling candidate;
        // the length floors drop glyph hairlines but keep per-cell borders.
        if (Math.abs(Y - y0) < 1.5 && Math.abs(X - x0) > 15) Hs.push({ y: (Y + y0) / 2, x0: Math.min(x0, X), x1: Math.max(x0, X) })
        if (Math.abs(X - x0) < 1.5 && Math.abs(Y - y0) > 30) Vs.push({ x: (X + x0) / 2, y0: Math.min(y0, Y), y1: Math.max(y0, Y) })
      }
      cur = [X, Y]
    }
  }
  return { Hs, Vs }
}

// Reconstruct the [No. | Symbol | Description] column lattice from the vertical
// table rules. Full-body-height rules are the real dividers; we measure the
// group origin / pitch / sub-cell widths from them (per sheet, exactly) and
// synthesise any group whose dividers were interrupted, so no group is dropped.
function columnModel(Vs) {
  const len = v => v.y1 - v.y0
  const maxLen = Math.max(...Vs.map(len))
  const tall = Vs.filter(v => len(v) > maxLen * 0.95)
  const top = median(tall.map(v => v.y0)), bot = median(tall.map(v => v.y1))
  // column boundaries = verticals spanning the full body, x-clustered so a
  // doublet group-separator (two close lines) merges to one boundary.
  const xs = Vs.filter(v => v.y0 <= top + 60 && v.y1 >= bot - 60).map(v => v.x).sort((a, b) => a - b)
  const cb = []
  for (const x of xs) {
    if (cb.length && x - cb[cb.length - 1] < 22) cb[cb.length - 1] = (cb[cb.length - 1] + x) / 2
    else cb.push(x)
  }
  const tableL = cb[0], tableR = cb[cb.length - 1]
  // No-cells = consecutive boundary pairs the width of the narrow No. column
  // (≈100px), excluding the outer frame's left edge.
  const noPairs = []
  for (let i = 0; i < cb.length - 1; i++) {
    const w = cb[i + 1] - cb[i]
    if (w >= 80 && w <= 140 && cb[i] > tableL + 5) noPairs.push([cb[i], cb[i + 1]])
  }
  const lefts = noPairs.map(p => p[0])
  const pitch = lefts.length >= 2 ? median(lefts.slice(1).map((x, i) => x - lefts[i])) : 606
  const noW = median(noPairs.map(p => p[1] - p[0])) || 102
  // symbol width = the gap from a No-cell's right edge to the next boundary.
  const symWs = []
  for (const [, nr] of noPairs) {
    const next = cb.find(x => x > nr + 5)
    if (next && next - nr > 150 && next - nr < 480) symWs.push(next - nr)
  }
  const symW = median(symWs) || Math.round(pitch * 0.52)
  const origin = lefts.length ? Math.min(...lefts) : tableL + 100
  const groups = []
  for (let k = 0; k <= 24; k++) {
    const gl = Math.round(origin + k * pitch)
    if (gl + noW + symW > tableR + pitch * 0.3) break
    // snap to a detected No-cell when one lands on this lattice point (exact
    // crop); otherwise synthesise a centred window from the measured widths.
    const hit = noPairs.find(p => Math.abs(p[0] - gl) <= pitch * 0.35)
    const no = hit ? [Math.round(hit[0]), Math.round(hit[1])] : [gl, Math.round(gl + noW)]
    groups.push({ no, sym: [no[1], Math.round(no[1] + symW)] })
  }
  return { groups, top, bot }
}

// Per-group row rules: the horizontal table borders are drawn per-cell (short
// collinear segments), so we cluster H-segments by y and keep a y only where
// the segments collectively span most of the group's width. A rowspan is just
// a larger gap between two consecutive kept rules — no uniform pitch assumed.
function groupRows(Hs, xL, xR) {
  const W = xR - xL
  const segs = Hs.filter(h => h.x1 > xL && h.x0 < xR).sort((a, b) => a.y - b.y)
  const clusters = []
  for (const h of segs) {
    const c = clusters[clusters.length - 1]
    if (c && h.y - c.y < 8) c.segs.push(h)
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
    if (cov > W * 0.6) ys.push(Math.round(c.y))
  }
  return ys
}

// OCR a No. cell with tesseract → the list of number tokens it contains, top to
// bottom. The cell holds the bold sign code AND a smaller "(TC …)" reference
// line; both read as numbers, but they sit in DIFFERENT ranges, so the caller's
// sheet-range gate (parseCode) keeps the SIGNID and drops the TC figure — no
// need to isolate the bold line geometrically. Preprocessing matters: the CAD
// digits are thin on some sheets, and a fixed threshold-then-resize erodes them
// to nothing (reads blank). So we crop the cell (inset past the border rules —
// x/y land ON the dividers, and a black edge defeats the trim), upscale 4×
// BEFORE binarising, use an adaptive **OTSU** threshold (handles thin and thick
// strokes alike) + a morphological **close** (thickens hairline digits), then
// trim to ink and white-pad. Whitelist = digits + L/T/R suffix letters.
function ocrCode(png, x, y, w, h) {
  const cell = join(SCRATCH, 'ocr-no.png')
  const outBase = join(SCRATCH, 'ocr-no')
  magick([png, '-crop', `${w - 10}x${Math.min(h - 10, 120)}+${x + 5}+${y + 5}`, '+repage',
    '-colorspace', 'Gray', '-resize', '400%', '-auto-threshold', 'OTSU',
    '-negate', '-morphology', 'Close', 'Octagon:1', '-negate',
    '-fuzz', '5%', '-trim', '+repage', '-bordercolor', 'white', '-border', '18', cell])
  const r = spawnSync('tesseract', [cell, outBase, '--psm', '6',
    '-c', 'tessedit_char_whitelist=0123456789LTR'], { encoding: 'utf8' })
  if (r.status !== 0) return []
  return readFileSync(`${outBase}.txt`, 'utf8').split(/\s+/).map(s => s.trim()).filter(Boolean)
}

// Does a catalogue entry already carry a description? `desc` is either the
// legacy bare-string form or the {en?, zh?} object — both are checked.
function descExists(raw) {
  const p = typeof raw === 'string' ? { en: raw } : raw
  return !!(p && (p.en || p.zh))
}
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

// ---- ground-truth SIGNID set (codes that appear on real road signs) ----
const gmlText = readFileSync(GML, 'utf8')
const onMap = new Set()
for (const m of gmlText.matchAll(/<gen:value>(TS\d{2,4}[A-Z]?)<\/gen:value>/g)) onMap.add(m[1])
console.log(`GML ground-truth: ${onMap.size} distinct SIGNIDs`)

// ---- VLM call (descriptions only, opt-in via --desc) ----
const sleep = ms => new Promise(r => setTimeout(r, ms))
// The model usually returns bare JSON, but occasionally prepends prose. Salvage
// by extracting the outermost array; return null only if even that won't parse.
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
// One JPEG + one text prompt → the model's raw text reply (markdown fences
// stripped), with retry/backoff and fail-loud-on-truncation.
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
      // A network-level failure (EPIPE / ECONNRESET / DNS / timeout) makes
      // fetch REJECT rather than return a status. Retry on the same backoff
      // schedule; give up only once that's exhausted.
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
// Full-page read — column-groups of {code, en, zh}. Used only for descriptions
// when --desc is set; the row binding comes from the OCR grid, not these rows.
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
  const base = `/tmp/sign-${sheet.prefix}-${sheet.range[0]}`
  spawnSync('pdftoppm', ['-png', '-r', String(DPI), '-singlefile', pdf, base])
  const png = `${base}.png`

  // Vector grid: columns + per-group rows (deterministic, rowspan-aware).
  const { Hs, Vs } = traceSegments(pdf)
  const { groups, top, bot } = columnModel(Vs)
  for (const g of groups) {
    const ys = groupRows(Hs, g.no[0], g.sym[1]).filter(y => y >= top - 4 && y <= bot + 4)
    g.cells = []
    for (let i = 0; i < ys.length - 1; i++) {
      if (ys[i + 1] - ys[i] < 30) continue // header sliver / double rule
      g.cells.push([ys[i], ys[i + 1]])
    }
  }
  const totalCells = groups.reduce((n, g) => n + g.cells.length, 0)
  console.log(`[${sheet.pdf}] grid: ${groups.length} groups, rows/group=[${groups.map(g => g.cells.length).join(',')}], ${totalCells} cells`)

  // Normalise a raw No.-column string to {code, base}, gated by this sheet's
  // numeric range. Returns null for blanks / out-of-range / malformed reads.
  function parseCode(raw0) {
    const raw = String(raw0 ?? '').toUpperCase().replace(/\s+/g, '')
    if (!raw || raw === 'NONE') return null
    const m = raw.match(/^(\d{2,4})([A-Z]?)$/)
    if (!m) return null
    const n = +m[1]
    if (n < sheet.range[0] || n > sheet.range[1]) return null
    return { code: `${sheet.prefix}${m[1]}${m[2]}`, base: `${sheet.prefix}${m[1]}` }
  }
  // Parse a full-page (--desc) row into {code, base, desc}. `desc` is the
  // {en?, zh?} shape that matches signDescriptions.json.
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
    const jpg = `${base}.jpg`
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

  // `--propose` stages everything under /tmp; otherwise write into public/signs/.
  const sheetTag = `${sheet.prefix}${sheet.range[0]}-${sheet.range[1]}`
  const outDir = propose ? join(STAGING, sheetTag) : SIGNS_DIR
  if (propose) await mkdir(outDir, { recursive: true })

  // PASS 1 — additive descriptions for codes already in the catalogue. Only
  // populated when --desc ran above; otherwise this loop is a no-op.
  let descAdded = 0, descUpdated = 0
  const descAdds = []
  for (const [code, desc] of descByCode) {
    if (!catalogue[code]) continue
    const prevRaw = catalogue[code].desc
    const prev = typeof prevRaw === 'string' ? { en: prevRaw } : prevRaw
    const hasPrev = descExists(prevRaw)
    if (hasPrev && !updateDesc) continue
    if (descEqual(prev, desc)) continue
    hasPrev ? descUpdated++ : descAdded++
    if (propose) descAdds.push({ code, desc })
    else catalogue[code].desc = desc
  }

  // PASS 2 — pictograms. For each grid cell: OCR the No. cell → code, GML-
  // filter, then crop the symbol from the SAME [top,bot] band so code and
  // pictogram cannot desync. An empty symbol cell ("SYMBOL NOT AVAILABLE")
  // trims to nothing and degrades to a dot rather than shipping a blank crop.
  let added = 0, droppedHallucination = 0, droppedSmall = 0, droppedDup = 0, droppedUnread = 0
  const adds = []
  const seen = new Set()
  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi]
    let prevN = 0
    for (const [rtop, rbot] of grp.cells) {
      // Scan the cell's tokens top-to-bottom; the range gate keeps the SIGNID
      // and drops the out-of-range "(TC …)" reference figure.
      const tokens = ocrCode(png, grp.no[0], rtop, grp.no[1] - grp.no[0], rbot - rtop)
      const c = tokens.map(parseCode).find(Boolean) || null
      if (!c) {
        if (tokens.length) droppedUnread++
        continue
      }
      // The No. column is a sorted sequence within a group — flag (don't drop)
      // an OCR read that breaks it, so a digit misread is visible in the log
      // even before the human gate's verify.png.
      const n = parseInt(c.code.replace(/\D/g, ''), 10)
      if (prevN && n < prevN) console.warn(`[${sheet.pdf}] ⚠ group ${gi}: OCR ${c.code} < previous ${prevN} (out of order) — check verify.png`)
      prevN = n
      if (catalogue[c.code] || seen.has(c.code)) {
        droppedDup++
        continue
      }
      if (!onMap.has(c.code) && !onMap.has(c.base)) {
        droppedHallucination++
        continue
      }
      const [bx0, bx1] = grp.sym
      const symRaw = '/tmp/sym.png'
      magick([png, '-crop', `${bx1 - bx0 + 12}x${rbot - rtop - 8}+${bx0 - 6}+${rtop + 4}`,
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
      // src = the source row box from the No.-cell left edge through the symbol
      // cell right edge, for a ground-truth [printed number | pictogram] crop at
      // review time (the only view that catches an OCR digit misread).
      if (propose) adds.push({ code: c.code, ...entry, src: { x: grp.no[0], y: rtop, w: bx1 - grp.no[0], h: rbot - rtop } })
      else catalogue[c.code] = entry
      added++
    }
  }
  console.log(`[${sheet.pdf}] added=${added} desc-added=${descAdded} desc-updated=${descUpdated} hallucination=${droppedHallucination} empty=${droppedSmall} dup=${droppedDup} unreadable=${droppedUnread}`)

  // In propose mode write nothing to the repo — stage a manifest + a review
  // montage (the normalized asset, labelled) + a verify montage (each
  // candidate's SOURCE [printed No. | pictogram] strip, labelled with the OCR'd
  // code) so a human can confirm every code↔crop before --commit.
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
        magick([png, '-crop', `${w + 8}x${h - 4}+${Math.max(0, x - 4)}+${y + 2}`, '+repage', '-resize', '440x180', vf])
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
  const catalogue = JSON.parse(await readFile(CATALOGUE_JSON, 'utf8'))
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
// --propose never mutates the repo, so even with --wipe we keep the real
// catalogue + public/signs/ intact (we only read them for dup/desc checks).
if (wipe && !propose) {
  for (const f of await readdir(SIGNS_DIR).catch(() => [])) {
    if (f.endsWith('.png')) await rm(join(SIGNS_DIR, f))
  }
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
  const n = await extractSheet(sheet, catalogue)
  totalAdded += n
}
if (propose) {
  console.log(`\nproposed ${totalAdded} new pictogram(s) across ${sheetsToRun.length} sheet(s). Review each <sheet>/verify.png under ${STAGING}, then: node scripts/build-sign-catalogue.mjs --commit [--reject TS###,TS###]`)
} else {
  await writeFile(CATALOGUE_JSON, JSON.stringify(catalogue, null, 2) + '\n')
  console.log(`\nfinal catalogue: ${Object.keys(catalogue).length} codes (+${totalAdded})`)
}
