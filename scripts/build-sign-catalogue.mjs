// Build the sign catalogue from TD's Index Plan PDFs with Sonnet 4.6 vision.
// Each page is a table of [No. | Symbol | Description] column-groups. We bind
// every code to its exact row by reading the printed "No." column per cell,
// then crop the symbol from that same row by pure geometry, normalize to a
// PNG, and write the catalogue.
//
// Replaces an earlier tesseract + 3-layer-LIS pipeline (git history): with the
// CAD font and noise-contaminated No.-column crops, tesseract needed extensive
// scaffolding (primary/fallback/per-gap LIS, vRule snapping, right-cut) to
// avoid mislabelling. The VLM reads a clean isolated-cell montage instead.
// Three safety nets remain, because they're cheaper than trust:
//
//   1. NO.-COLUMN GRID BIND. The row a code occupies comes from reading the
//      No. cell of THAT row — not a holistic y-hint, which drifted across the
//      blank / "SYMBOL NOT AVAILABLE" rows and mis-cropped (the bug that got
//      an earlier recovery reverted). We crop every No. cell into a fixed R×C
//      montage in reading order and read it in one call; a blank row reads ""
//      in its own slot and can't shift the codes below it. The symbol is then
//      cropped from the SAME rowBand, so code and pictogram cannot desync.
//
//   2. GML SIGNID FILTER. Vision models occasionally hallucinate plausible
//      sequential numbers (e.g. "635" between 634 and 636 when 635 doesn't
//      exist on any real road). We only KEEP a code if it appears at least
//      once in data/raw/DTAD_TS_ABV_PT.gml — the authoritative set of codes
//      actually on signs in HK. Codes not in this set wouldn't be referenced
//      by any map feature anyway, so the filter is loss-less for the app.
//
//   3. HUMAN GATE (--propose / --commit). Recovery stages crops + a review
//      montage and writes NOTHING to the repo; a human verifies every
//      code↔crop before --commit promotes them. Upholds the documented
//      "a missed sign degrades to a dot — a MISLABELLED sign must never ship".
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-...  node scripts/build-sign-catalogue.mjs
//                                                # full rebuild, merge mode
//   ... build-sign-catalogue.mjs --wipe          # full rebuild, wipe first
//   ... build-sign-catalogue.mjs --sheet "601 - 700"   # one sheet only
//   ... build-sign-catalogue.mjs --propose       # stage candidates, write
//                                                # nothing (human review)
//   ... build-sign-catalogue.mjs --commit [--reject TS208,TS209]
//                                                # promote approved staged crops
//
// Cost: ~$0.30 to rebuild all 16 sheets (two Sonnet calls per page — the
// full-page description read + the No.-column grid bind).

import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const INDEX_PLAN_DIR = 'data/tadrawings_dataspec/Index Plan'
const SIGNS_DIR = 'public/signs'
const CATALOGUE_JSON = 'app/data/signCatalogue.json'
const GML = 'data/raw/DTAD_TS_ABV_PT.gml'
const DPI = 400
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

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set')
  process.exit(1)
}
function requireTool(cmd, hint) {
  if (spawnSync(cmd, ['--version']).error) {
    console.error(`Missing \`${cmd}\`. Install it: ${hint}`)
    process.exit(1)
  }
}
requireTool('pdftoppm', 'brew install poppler')
requireTool('magick', 'brew install imagemagick')
// ImageMagick registers no fonts in this environment (`magick -list font` is
// empty), so `montage` — used for the No.-column grid read and the review
// sheet — can't render even an empty label without an explicit -font. Resolve
// one system TTF up front and fail loud if none exists.
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
// match against the PDF filename. Omitted → all 16 sheets (the canonical
// `data:catalogue` build).
const sheetFilter = (() => {
  const i = process.argv.indexOf('--sheet')
  return i >= 0 ? process.argv[i + 1] : null
})()
// `--wipe` blows away the existing catalogue + public/signs/ before running,
// for a clean full rebuild from source. Without it the script merges into
// what's already there, which lets `--sheet` runs do surgical updates.
const wipe = process.argv.includes('--wipe')

// Human-gated recovery (see PASS 2). `--propose` extracts candidate pictograms
// but writes NOTHING to the repo: it stages crops + a review montage + a
// manifest under STAGING so a human can eyeball every code↔crop before it
// ships. `--commit` then promotes the approved staged crops into public/signs/
// + the catalogue; `--reject TS208,TS209` drops specific codes on commit.
// Neither flag → the original write-through behaviour (the documented
// `data:catalogue` build), now with grid-anchored crops and additive descs.
const propose = process.argv.includes('--propose')
const doCommit = process.argv.includes('--commit')
const rejectList = (() => {
  const i = process.argv.indexOf('--reject')
  return new Set(i >= 0 ? (process.argv[i + 1] ?? '').split(',').map(s => s.trim()).filter(Boolean) : [])
})()
// PASS 1 is additive-only by default — it fills a MISSING desc but never
// clobbers an existing one (re-running a sheet used to silently corrupt good
// descriptions when the VLM mis-paired a code with a neighbour's text).
// `--update-desc` opts back into overwriting, for a deliberate desc refresh.
const updateDesc = process.argv.includes('--update-desc')
const STAGING = '/tmp/sign-recovery'

// ---- geometry helpers — column-band and grid-line detection on the rendered
// page, used to locate the symbol-cell crop for each VLM-emitted code. The
// VLM gives us a y-position hint per code; geometry tells us where the
// nearest cell actually starts and ends so we crop the right pixels. ----
function magick(args, { binary = false } = {}) {
  const r = spawnSync('magick', args, { maxBuffer: 1 << 30, encoding: binary ? 'buffer' : 'utf8' })
  if (r.status !== 0) throw new Error(`magick ${args.join(' ')}\n${r.stderr}`)
  return r.stdout
}
function identify(file) {
  const out = spawnSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' })
  return out.stdout.trim().split(/\s+/).map(Number)
}
function profile(png, w, h, axis) {
  const size = axis === 'x' ? `${w}x1` : `1x${h}`
  const buf = magick([png, '-colorspace', 'Gray', '-threshold', '55%', '-negate',
    '-resize', `${size}!`, '-depth', '8', 'gray:-'], { binary: true })
  return Uint8Array.from(buf)
}
// Like `profile` but counts ANY non-white pixel as content, not just dark ink.
// Bright symbols (the green chainage/route markers on TS 3601-3705) read above
// the 55% gray threshold and vanish from the ink profile, so their columns go
// undetected. `+opaque white` paints every non-near-white pixel black, so a
// colour band registers like an ink band. Used only as a fallback when the ink
// profile under-reads (see symbol-band detection), so dark-ink sheets are
// unaffected.
function contentProfile(png, w, h, axis) {
  const size = axis === 'x' ? `${w}x1` : `1x${h}`
  const buf = magick([png, '-fuzz', '25%', '-fill', 'black', '+opaque', 'white',
    '-colorspace', 'Gray', '-negate', '-resize', `${size}!`, '-depth', '8', 'gray:-'], { binary: true })
  return Uint8Array.from(buf)
}
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
function ruleCentres(prof, thresh, merge) {
  const idx = []
  for (let i = 0; i < prof.length; i++) if (prof[i] >= thresh) idx.push(i)
  return cluster(idx, merge)
}
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
function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
// Symbol-column lattice. Every Index Plan sheet is the same CT174/51 grid
// rendered at DPI=400, so the symbol cells sit on a fixed horizontal lattice:
// a constant ~606 px pitch, with the first column at one of two template
// origins (~472 on the wider informatory sheets, ~776 on the rest). Both
// constants are empirical — they're identical across all 16 sheets, as stable
// as DPI itself.
//
// runs(colProf,…) only finds a symbol band where the cell carries enough ink,
// so faint columns are missed: light-fill plates (the yellow "no stopping"
// rows on TS 2206-2310), or groups left half-empty beside the bottom-right
// title block (TS 206-310). The old code mapped VLM group g → symBands[g] by
// position, so a missed LEFT column shifted every later band's index — it both
// SKIPPED trailing groups *and* mis-cropped the survivors (e.g. on TS 2206-2310
// the only bands found were groups 2 & 3, yet group 0's codes were cropped from
// group 2's column).
//
// We instead reconstruct the lattice and emit exactly `groupCount` columns —
// groupCount being the VLM's group count, which reads the page reliably. Where
// a detected band already lands on a lattice point we reuse its exact ink
// extent, so sheets that already detect every group are byte-for-byte
// unchanged; only the missing / mis-indexed columns differ.
const SYM_PITCH = 606 // px between adjacent symbol columns at DPI=400
const SYM_ORIGINS = [472, 776] // the two template first-column centres
function symbolColumns(symBands, groupCount, W) {
  // No early-out on empty symBands: with zero detected bands we still
  // synthesise all groupCount columns from the default origin — recovering
  // them is the whole point — rather than silently skipping every group.
  if (groupCount <= 0) return symBands
  const centres = symBands.map(([a, b]) => (a + b) / 2)
  const bw = median(symBands.map(([a, b]) => b - a)) || 260
  // Pick the template origin whose lattice (origin + k·pitch) best fits the
  // detected band centres. Robust even with just a couple of bands, or
  // slightly off-lattice ones, because the two origins are ~300 px apart —
  // far more than any per-band jitter.
  let O = SYM_ORIGINS[0], best = Infinity
  for (const o of SYM_ORIGINS) {
    let err = 0
    for (const c of centres) {
      const k = Math.max(0, Math.round((c - o) / SYM_PITCH))
      err += Math.abs(c - (o + k * SYM_PITCH))
    }
    if (err < best) {
      best = err
      O = o
    }
  }
  const cols = []
  for (let k = 0; k < groupCount; k++) {
    const x = O + k * SYM_PITCH
    // Reuse a real detected band when one sits on this lattice point (keeps
    // existing crops identical); otherwise synthesise a centred window. The
    // ±0.4·pitch window is < half a pitch, so each band claims one column.
    const hit = symBands.find(([a, b]) => Math.abs((a + b) / 2 - x) <= SYM_PITCH * 0.4)
    cols.push(hit ?? [Math.max(0, Math.round(x - bw / 2)), Math.min(W, Math.round(x + bw / 2))])
  }
  return cols
}
// No.-column lattice. Every group is [No. | Symbol | Description]; the printed
// code number sits in the narrow "No." cell immediately LEFT of the symbol
// cell. Reading that cell per row is the authoritative bind that the VLM's
// y-hint failed to give (it drifted across blank rows). We locate the No. cell
// from the page's vertical rules: the two rules bracketing the symbol cell's
// left edge bound it. Where rules are faint, fall back to a fixed offset left
// of the symbol-cell centre — stable across both CT174/51 templates.
const NO_COL_DX = 233 // px from symbol-cell centre to No.-cell centre (fallback)
const NO_COL_W = 150 // px No.-cell width (fallback)
function noColumns(symCols, vRules, W) {
  return symCols.map(([a, b]) => {
    // Anchor on the symbol cell's LEFT EDGE (a), not its centre. Dense sign
    // graphics throw spurious full-height rules INSIDE the symbol cell, and a
    // centre-based search grabs those — on TS 206-310 it put group 4's "No."
    // window on top of the pictogram. The two rules immediately left of the
    // left edge bracket the No. cell: [1] = its left border, [0] = the
    // No|Symbol divider. Works for synthesized columns too (their lattice left
    // edge sits at the same offset from the divider as a detected band's).
    const left = vRules.filter(r => r < a - 8).sort((p, q) => q - p)
    const w = left.length >= 2 ? left[0] - left[1] : 0
    if (w > 40 && w < 320) return [left[1], left[0]]
    const cx = (a + b) / 2
    return [Math.max(0, Math.round(cx - NO_COL_DX - NO_COL_W / 2)), Math.min(W, Math.round(cx - NO_COL_DX + NO_COL_W / 2))]
  })
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

// ---- VLM call ----
const sleep = ms => new Promise(r => setTimeout(r, ms))
// The model usually returns bare JSON, but occasionally prepends prose ("I'll
// read each column…") despite the instruction. Salvage by extracting the
// outermost array; return null only if even that won't parse (caller re-asks).
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
// stripped). Shared by the full-page read and the No.-column grid read so both
// inherit the same retry/backoff and fail-loud-on-truncation behaviour.
async function callVLM(jpgBuf, prompt) {
  const body = {
    model: MODEL,
    // 4096 tokens truncates the chainage-dense TS 3601-3705 mid-token; the
    // richest sheets that fit use ~3.4k output tokens, so 8192 is comfortable.
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
      // fetch REJECT rather than return a status — so it bypasses the HTTP
      // retry below and would otherwise crash the whole multi-call run. Retry
      // it on the same backoff schedule; give up only once that's exhausted.
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
      // A `max_tokens` stop would truncate the JSON — sometimes at a valid
      // boundary, silently dropping the trailing codes. Fail loud instead so a
      // bumped limit (or a split sheet) is an explicit decision, never a
      // quietly-short extraction.
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
// Full-page read — column-groups of {code, en, zh}. Used for descriptions
// (PASS 1) and to count the column-groups; the page's row binding now comes
// from the No.-column grid read below, not from these rows' y-hints.
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
// No.-column grid read — the authoritative code↔row bind. The montage is a
// clean R×C grid of isolated No.-cell crops in reading order, so the model
// reads pure numbers cell-by-cell with no row-skipping ambiguity. The reply
// MUST be exactly R×C — a misshapen one means the bind would be misaligned, so
// it is never accepted. But the model is stochastic, so we re-ask a few times
// before giving up; on persistent failure we return null and the caller SKIPS
// the sheet (re-runnable with --sheet) rather than crashing the whole run.
async function readNoGridVLM(jpgBuf, R, C) {
  const prompt = `This image is a GRID of cells cropped from the "No." column of a Hong Kong traffic-sign index table. It has exactly ${R} rows and ${C} columns, laid out in reading order: left-to-right within each row, then top-to-bottom. EVERY cell is a slot — including empty ones — so there are exactly ${R}×${C} = ${R * C} cells.

Each cell shows EITHER a bold sign-code number (e.g. "208", "636L", "639T"), optionally above a smaller "(TC ...)" reference line, OR nothing.

For each cell, return the bold code as a string — the digits plus any trailing letter, WITHOUT the "(TC ...)" part — or "" if the cell has no code. Do NOT skip empty cells; emit "" for them so every row has exactly ${C} entries.

Return ONLY a JSON array of ${R} arrays, each containing exactly ${C} strings. No prose, no markdown fences.`
  const shapeOf = g => Array.isArray(g) ? `${g.length}×[${g.map(r => Array.isArray(r) ? r.length : '?').join(',')}]` : 'non-array'
  for (let attempt = 0; attempt < 3; attempt++) {
    const { raw, usage } = await callVLM(jpgBuf, prompt)
    const grid = parseJsonLoose(raw)
    if (Array.isArray(grid) && grid.length === R && grid.every(row => Array.isArray(row) && row.length === C)) {
      return { grid, usage }
    }
    console.error(`  no-grid read got ${shapeOf(grid)}, expected ${R}×${C} — re-asking (attempt ${attempt + 1}/3)`)
  }
  return null
}

// ---- per-sheet extraction ----
async function extractSheetVLM(sheet, catalogue) {
  const pdf = join(INDEX_PLAN_DIR, sheet.pdf)
  const base = `/tmp/vlm-${sheet.prefix}`
  spawnSync('pdftoppm', ['-png', '-r', String(DPI), '-singlefile', pdf, base])
  const png = `${base}.png`
  const [W, H] = identify(png)

  // Geometry — same as build-sign-catalogue.mjs, so codes land at the same
  // symbol/desc coords this script eventually writes.
  const colProf = profile(png, W, H, 'x')
  const symBands = runs(colProf, 25, 70)
  // Vertical table rules run the full page height, so their columns saturate
  // the ink profile (~255) while symbol/number ink stays well below — the same
  // high-threshold peak-find we use for horizontal grid lines. These bound the
  // No. cells (see noColumns).
  const vRules = ruleCentres(colProf, 120, 5)
  const rowProf = profile(png, W, H, 'y')
  const gridLines = ruleCentres(rowProf, 120, 3)
  const pitch = modalGap(gridLines)
  // Build the full per-gap list, marking which are candidate rowBands. A
  // gap is kept as long as it's big enough to plausibly hold a sign cell —
  // anything from ~pitch tall up to a "rowspan" multi-row cell (e.g. the
  // 300+ px gaps on informatory sheets where one number labels two stacked
  // pictograms). Smaller gaps (header rules, divider speck) are dropped.
  // These kept gaps become the rows of the No.-column grid bind below: each
  // one is read once and its symbol cropped from the same [top, bot] range.
  const gaps = []
  for (let i = 1; i < gridLines.length; i++) {
    const top = gridLines[i - 1], bot = gridLines[i]
    const h = bot - top
    gaps.push({ top, bot, h, kept: h >= pitch * 0.6 })
  }
  console.log(`[${sheet.pdf}] geom: ${symBands.length} groups, ${gaps.length} grid gaps (${gaps.filter(g => g.kept).length} kept as rowBands)`)

  // VLM call on a 1600-wide JPEG of the page.
  const jpg = `${base}.jpg`
  magick([png, '-resize', '1600x', '-quality', '92', jpg])
  const jpgBuf = readFileSync(jpg)
  const pageRes = await readSheetVLM(jpgBuf)
  if (!pageRes) {
    console.error(`[${sheet.pdf}] full-page read never returned valid JSON after retries — SKIPPING (re-run: --propose --sheet "${sheet.range[0]} - ${sheet.range[1]}")`)
    return 0
  }
  const { parsed, usage } = pageRes
  console.log(`[${sheet.pdf}] vlm: ${parsed.length} groups, usage in=${usage?.input_tokens} out=${usage?.output_tokens}`)

  // Resolve the symbol-column x-range for each VLM group from the fixed grid
  // lattice, recovering columns runs(colProf,…) missed (see symbolColumns).
  // When the dark-ink profile finds fewer than HALF the page's groups, the
  // symbols are likely bright/coloured (green route markers on TS 3601-3705)
  // and read above the gray threshold — re-detect counting any non-white
  // content so the lattice fits real anchors instead of guessing. The <half
  // gate keeps every sheet the ink profile reads adequately byte-stable.
  let bands = symBands
  if (symBands.length < parsed.length / 2) {
    const cb = runs(contentProfile(png, W, H, 'x'), 25, 70)
    if (cb.length > symBands.length) {
      console.log(`[${sheet.pdf}] ink found ${symBands.length} band(s) for ${parsed.length} groups — color-aware detection found ${cb.length}`)
      bands = cb
    }
  }
  const symCols = symbolColumns(bands, parsed.length, W)
  console.log(`[${sheet.pdf}] symbol cols: ${bands.length} band(s) detected -> ${symCols.length} lattice column(s) at [${symCols.map(c => Math.round((c[0] + c[1]) / 2)).join(', ')}]`)
  // The No. cell sits left of each symbol cell — this is the row anchor.
  const noCols = noColumns(symCols, vRules, W)

  // Normalise a raw No.-column string to {code, base}, gated by this sheet's
  // numeric range. Used for both the grid codes (PASS 2) and the full-page
  // rows (PASS 1). Returns null for blanks / out-of-range / malformed reads.
  function parseCode(raw0) {
    const raw = String(raw0 ?? '').toUpperCase().replace(/\s+/g, '')
    if (!raw || raw === 'NONE') return null
    const m = raw.match(/^(\d{2,4})([A-Z]?)$/)
    if (!m) return null
    const n = +m[1]
    if (n < sheet.range[0] || n > sheet.range[1]) return null
    return { code: `${sheet.prefix}${m[1]}${m[2]}`, base: `${sheet.prefix}${m[1]}` }
  }
  // Parse a full-page row into {code, base, desc}. `desc` is the {en?, zh?}
  // bilingual shape that matches signDescriptions.json — empty strings are
  // dropped so we only ever store a populated field.
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
  // Compare two desc objects shallowly — used to skip no-op writes.
  function descEqual(a, b) {
    if (!a || !b) return a === b
    return a.en === b.en && a.zh === b.zh
  }
  // Full-page descriptions keyed by code (last read wins). Drives PASS 1 and
  // supplies the additive desc for brand-new codes added in PASS 2.
  const descByCode = new Map()
  for (const group of parsed) {
    for (const item of (group ?? [])) {
      const cell = parseCell(item)
      if (cell && (cell.desc.en || cell.desc.zh)) descByCode.set(cell.code, cell.desc)
    }
  }

  const keptGaps = gaps.filter(g => g.kept)

  // STAGE 1 — bind each code to its rowBand by reading the No. column. Crop
  // every No.-cell (group g × rowBand i) into a clean R×C montage in reading
  // order and read it in one call. Each cell is isolated and positionally
  // fixed, so a blank / "SYMBOL NOT AVAILABLE" row reads "" in its slot — it
  // can't shift the codes below it, which is exactly how the old y-hint bind
  // drifted and mis-cropped. The grid read's shape is asserted R×C upstream.
  const C = symCols.length
  const R = keptGaps.length
  const cellFiles = []
  for (let i = 0; i < R; i++) {
    for (let g = 0; g < C; g++) {
      const [nx0, nx1] = noCols[g]
      const gp = keptGaps[i]
      const cf = `/tmp/nocell-${i}-${g}.png`
      magick([png, '-crop', `${nx1 - nx0}x${Math.max(1, gp.bot - gp.top - 6)}+${nx0}+${gp.top + 3}`, '+repage', cf])
      cellFiles.push(cf)
    }
  }
  const gridJpg = `${base}-nogrid.jpg`
  // -label '' suppresses montage's default per-tile filename caption so the
  // model sees clean number cells; -font is required even for the empty label.
  magick(['montage', ...cellFiles, '-tile', `${C}x${R}`, '-geometry', '220x96+3+3', '-background', '#dddddd', '-font', FONT, '-label', '', '-quality', '92', gridJpg])
  const gridRes = await readNoGridVLM(readFileSync(gridJpg), R, C)
  if (!gridRes) {
    console.error(`[${sheet.pdf}] no-grid read never matched ${R}×${C} after retries — SKIPPING (re-run: --propose --sheet "${sheet.range[0]} - ${sheet.range[1]}")`)
    return 0
  }
  const { grid, usage: gridUsage } = gridRes
  console.log(`[${sheet.pdf}] no-grid: ${R}×${C} cells, usage in=${gridUsage?.input_tokens} out=${gridUsage?.output_tokens}`)

  // `--propose` stages everything under /tmp; otherwise we write straight into
  // public/signs/ (the documented build).
  const sheetTag = `${sheet.prefix}${sheet.range[0]}-${sheet.range[1]}`
  const outDir = propose ? join(STAGING, sheetTag) : SIGNS_DIR
  if (propose) await mkdir(outDir, { recursive: true })

  // PASS 1 — description fixes for codes already in the catalogue, matched by
  // code string. Additive-only by default: fill a MISSING desc, never clobber
  // an existing one (re-running a sheet used to corrupt good descriptions when
  // the VLM mis-paired a code with a neighbour's text). `--update-desc` opts
  // back into overwriting.
  let descAdded = 0, descUpdated = 0
  const descAdds = []
  for (const [code, desc] of descByCode) {
    if (!catalogue[code]) continue
    const prevRaw = catalogue[code].desc
    const prev = typeof prevRaw === 'string' ? { en: prevRaw } : prevRaw
    const hasPrev = !!(prev && (prev.en || prev.zh))
    if (hasPrev && !updateDesc) continue
    if (descEqual(prev, desc)) continue
    hasPrev ? descUpdated++ : descAdded++
    if (propose) descAdds.push({ code, desc })
    else catalogue[code].desc = desc
  }

  // PASS 2 — add a NEW pictogram + entry for each code the No.-column grid
  // bound to a rowBand. The symbol crop is pure geometry: symbol column g ×
  // rowBand i, taken from the SAME row whose No. cell yielded the code, so it
  // cannot drift. GML filter and dup check are retained; a row whose symbol
  // cell is empty (a "SYMBOL NOT AVAILABLE" code) trims to nothing and
  // degrades to a dot rather than shipping a blank crop.
  let added = 0, droppedHallucination = 0, droppedSmall = 0, droppedDup = 0
  const adds = []
  const seen = new Set()
  for (let i = 0; i < R; i++) {
    const gap = keptGaps[i]
    const rh = gap.bot - gap.top
    for (let g = 0; g < C; g++) {
      const c = parseCode(grid[i][g])
      if (!c) continue
      if (catalogue[c.code] || seen.has(c.code)) {
        droppedDup++
        continue
      }
      if (!onMap.has(c.code) && !onMap.has(c.base)) {
        droppedHallucination++
        continue
      }
      const [bx0, bx1] = symCols[g]
      const symRaw = '/tmp/sym.png'
      magick([png, '-crop', `${bx1 - bx0 + 12}x${rh - 8}+${bx0 - 6}+${gap.top + 4}`,
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
      // review time (the bind is only trustworthy if that pairing checks out).
      if (propose) adds.push({ code: c.code, ...entry, src: { x: noCols[g][0], y: gap.top, w: bx1 - noCols[g][0], h: rh } })
      else catalogue[c.code] = entry
      added++
    }
  }
  console.log(`[${sheet.pdf}] added=${added}  desc-added=${descAdded}  desc-updated=${descUpdated}  hallucination-dropped=${droppedHallucination}  empty-cell-dropped=${droppedSmall}  dup=${droppedDup}`)

  // In propose mode write nothing to the repo — stage a manifest + a review
  // montage (each candidate's code beside its crop) so a human can verify
  // every code↔crop before --commit promotes them.
  if (propose) {
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ sheet: sheet.pdf, group: sheet.group, adds, descAdds }, null, 2) + '\n')
    if (adds.length) {
      // review.png — the normalized asset that will actually ship, labelled.
      const labelArgs = []
      for (const a of adds) labelArgs.push('-label', a.code, join(outDir, `${a.code}.png`))
      magick(['montage', '-font', FONT, ...labelArgs, '-tile', '6x', '-geometry', '200x160+8+8', '-background', 'white', '-fill', 'black', '-pointsize', '22', join(outDir, 'review.png')])
      // verify.png — the GATE: each candidate's SOURCE row [printed No. |
      // pictogram] cropped straight from the page, labelled with the bound
      // code. Confirm the printed number matches the label before --commit;
      // this is the only view that can catch a misread No.-column digit.
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
      // Pick only catalogue fields — never the verification-only `src` box.
      const entry = { tier: a.tier, group: a.group }
      if (a.desc) entry.desc = a.desc
      catalogue[a.code] = entry
      committed++
    }
    // Desc-adds stay additive on commit too (only fill a missing desc) unless
    // --update-desc, mirroring PASS 1.
    for (const da of (mf.descAdds ?? [])) {
      if (rejectList.has(da.code) || !catalogue[da.code]) continue
      const prevRaw = catalogue[da.code].desc
      const hasPrev = typeof prevRaw === 'string' ? !!prevRaw : !!(prevRaw && (prevRaw.en || prevRaw.zh))
      if (hasPrev && !updateDesc) continue
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
console.log(`existing catalogue: ${before} codes`)

const sheetsToRun = sheetFilter
  ? SHEETS.filter(s => s.pdf.includes(sheetFilter))
  : SHEETS
if (sheetFilter && !sheetsToRun.length) {
  console.error(`No sheet matched "${sheetFilter}". Available:\n` + SHEETS.map(s => '  ' + s.pdf).join('\n'))
  process.exit(1)
}
let totalAdded = 0
for (const sheet of sheetsToRun) {
  const n = await extractSheetVLM(sheet, catalogue)
  totalAdded += n
}
if (propose) {
  console.log(`\nproposed ${totalAdded} new pictogram(s) across ${sheetsToRun.length} sheet(s). Review each <sheet>/review.png under ${STAGING}, then: node scripts/build-sign-catalogue.mjs --commit [--reject TS###,TS###]`)
} else {
  await writeFile(CATALOGUE_JSON, JSON.stringify(catalogue, null, 2) + '\n')
  console.log(`\nfinal catalogue: ${Object.keys(catalogue).length} codes (+${totalAdded})`)
}
