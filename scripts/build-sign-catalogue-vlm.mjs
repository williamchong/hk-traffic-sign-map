// VLM-based catalogue extractor. Companion to build-sign-catalogue.mjs:
// instead of cropping each No.-column cell and running tesseract on it, send
// the whole Index Plan page to Sonnet 4.6 once, get back the ordered list of
// codes per column-group, and use that to drive symbol-cell extraction.
//
// Why a separate script: the tesseract pipeline ships ~178 codes accuracy-
// safely already; this is additive. It fills the long tail of cells the
// tesseract+LIS chain can't read (informatory text plates, rowspan'd codes,
// noise-contaminated No. columns) by leveraging the model's ability to read
// the whole table as ONE artifact, with row/column ordering as its own
// self-consistency check.
//
// Two safety nets that the cardinal "never mislabel" rule demands:
//
//   1. GML SIGNID FILTER. The model occasionally hallucinates plausible
//      sequential numbers (TS635 between 634 and 636 when 635 doesn't exist
//      on any actual road). We only KEEP a model-emitted code if it appears
//      at least once in data/raw/DTAD_TS_ABV_PT.gml — the authoritative set
//      of "codes actually on signs in HK". Codes not in this set wouldn't
//      be referenced by any map feature anyway, so dropping them is loss-
//      less for the app and gives us a clean ground-truth filter.
//
//   2. POSITIONAL ALIGNMENT GUARD. We map model positions to detected row
//      bands using the page's actual grid-line geometry. If the model's
//      per-group row count doesn't match the physical gap count we can
//      account for, we SKIP that group — better a dot than a misaligned
//      pictogram (the same sign stored under the wrong code).
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/build-sign-catalogue-vlm.mjs \
//     --sheet "601 - 700"
// Adds codes to the existing app/data/signCatalogue.json without wiping
// public/signs (merge mode). Does not run the QA montage — review manually.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const INDEX_PLAN_DIR = 'data/tadrawings_dataspec/Index Plan'
const SIGNS_DIR = 'public/signs'
const CATALOGUE_JSON = 'app/data/signCatalogue.json'
const GML = 'data/raw/DTAD_TS_ABV_PT.gml'
const DPI = 400
const DESC_HD = 2
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

const sheetFilter = (() => {
  const i = process.argv.indexOf('--sheet')
  return i >= 0 ? process.argv[i + 1] : null
})()
if (!sheetFilter) {
  console.error('--sheet <pattern> is required (matches against PDF filename).')
  process.exit(1)
}

// ---- geometry helpers (mirror build-sign-catalogue.mjs so a sheet's symbol
// crop / row-band detection / desc snapping land on the same pixels) ----
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
async function readSheetVLM(jpgBuf) {
  const prompt = `This is one page from the Hong Kong Transport Department "Index Plan" — a reference of all traffic signs. The page is a table whose columns repeat the pattern [No. | Symbol | Description] for each column-group. Codes ("641", "642", …) appear in the small "No." column at the LEFT of each group. Codes go down each group, then continue at the top of the next group to the right. Blank rows (no symbol or just a placeholder like "SYMBOL NOT AVAILABLE") also exist.

For each column-group on this page, list EVERY ROW in top-to-bottom visual order. Each row is either the string "NONE" (no code / deleted / placeholder cell), or an object {"code": "641", "desc": "DIRECTION TO FOOTBRIDGE"}.

  - "code" is the exact digits visible in the No. column, possibly with a letter suffix (e.g. "636L", "639T") — preserve the suffix.
  - "desc" is the ENGLISH text in the row's Description column, in UPPERCASE. Omit any Chinese characters and any "(DOUBLE SIDES)" sub-notes. If the desc column is empty, return desc: "".

Count rows starting from the first data row (skip the column header strip). Return ONLY a JSON array of arrays. Outer array = column-groups, left to right. Inner arrays = rows top to bottom. No markdown fences, no prose.`
  const body = {
    model: MODEL,
    max_tokens: 4096,
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
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (res.ok) {
      const j = await res.json()
      const raw = (j.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
      return { parsed: JSON.parse(raw), usage: j.usage }
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

// ---- per-sheet extraction ----
async function extractSheetVLM(sheet, catalogue) {
  const pdf = join(INDEX_PLAN_DIR, sheet.pdf)
  const base = `/tmp/vlm-${sheet.prefix}`
  spawnSync('pdftoppm', ['-png', '-r', String(DPI), '-singlefile', pdf, base])
  spawnSync('pdftoppm', ['-png', '-r', String(DPI * DESC_HD), '-singlefile', pdf, `${base}-hd`])
  const png = `${base}.png`
  const [W, H] = identify(png)

  // Geometry — same as build-sign-catalogue.mjs, so codes land at the same
  // symbol/desc coords this script eventually writes.
  const colProf = profile(png, W, H, 'x')
  const symBands = runs(colProf, 25, 70)
  const rowProf = profile(png, W, H, 'y')
  const gridLines = ruleCentres(rowProf, 120, 3)
  const pitch = modalGap(gridLines)
  // Build the full per-gap list, marking which were kept as rowBands.
  const gaps = []
  for (let i = 1; i < gridLines.length; i++) {
    const top = gridLines[i - 1], bot = gridLines[i]
    const h = bot - top
    gaps.push({ top, bot, h, kept: Math.abs(h - pitch) < pitch * 0.15 })
  }
  console.log(`[${sheet.pdf}] geom: ${symBands.length} groups, ${gaps.length} grid gaps (${gaps.filter(g => g.kept).length} kept as rowBands)`)

  // VLM call on a 1600-wide JPEG of the page.
  const jpg = `${base}.jpg`
  magick([png, '-resize', '1600x', '-quality', '92', jpg])
  const jpgBuf = readFileSync(jpg)
  const { parsed, usage } = await readSheetVLM(jpgBuf)
  console.log(`[${sheet.pdf}] vlm: ${parsed.length} groups, usage in=${usage?.input_tokens} out=${usage?.output_tokens}`)

  // Parse each cell into a uniform shape — { code, desc, raw } — so the
  // two later passes (description-update for known codes, new-code add for
  // new codes) can iterate it without re-parsing.
  function parseCell(item) {
    if (item == null || item === 'NONE') return null
    let code = null, desc = ''
    if (typeof item === 'string') code = item
    else if (typeof item === 'object') {
      code = item.code
      desc = item.desc ?? ''
    }
    if (!code || code === 'NONE') return null
    const raw = String(code).toUpperCase().replace(/\s+/g, '')
    const m = raw.match(/^(\d{2,4})([A-Z]?)$/)
    if (!m) return null
    const n = +m[1]
    if (n < sheet.range[0] || n > sheet.range[1]) return null
    return {
      code: `${sheet.prefix}${m[1]}${m[2]}`,
      base: `${sheet.prefix}${m[1]}`,
      desc: String(desc).trim().toUpperCase().replace(/\s+/g, ' ')
    }
  }

  // PASS 1 — description fixes for codes ALREADY in the catalogue. Works on
  // every group regardless of alignment: we only need code-string match, no
  // symbol-cell extraction, so even alignment-skipped groups contribute.
  let descAdded = 0, descUpdated = 0
  for (const group of parsed) {
    for (const item of (group ?? [])) {
      const cell = parseCell(item)
      if (!cell || !catalogue[cell.code] || !cell.desc) continue
      const prev = catalogue[cell.code].desc
      if (prev === cell.desc) continue
      if (prev == null) descAdded++
      else descUpdated++
      catalogue[cell.code].desc = cell.desc
    }
  }

  // PASS 2 — add NEW pictogram + entry for codes not yet in catalogue. This
  // path needs symbol-cell extraction, which requires the alignment guard:
  // VLM row index → grid gap index. If the per-group count doesn't match
  // (with offset 0 or 1 to allow for the column header), skip that group
  // entirely; better a dot than a misaligned pictogram.
  let added = 0, droppedHallucination = 0, droppedAlign = 0, droppedDup = 0
  for (let g = 0; g < parsed.length; g++) {
    if (g >= symBands.length) {
      console.warn(`  group ${g + 1} from VLM has no matching detected symBand — skipping new-code add`)
      continue
    }
    const items = parsed[g] ?? []
    let offset
    if (items.length === gaps.length) offset = 0
    else if (items.length === gaps.length - 1) offset = 1
    else {
      console.warn(`  group ${g + 1}: VLM count ${items.length} vs geom gaps ${gaps.length} — alignment ambiguous, skipping new-code add`)
      continue
    }
    const [bx0, bx1] = symBands[g]
    for (let p = 0; p < items.length; p++) {
      const cell = parseCell(items[p])
      if (!cell) continue
      if (catalogue[cell.code]) {
        droppedDup++
        continue
      }
      // GML filter — only ship codes that exist on real road signs. Suffix
      // variants (TS636L/R/T) share a base pictogram with TS636, so accept
      // if EITHER the exact code or its base is present in GML.
      if (!onMap.has(cell.code) && !onMap.has(cell.base)) {
        droppedHallucination++
        continue
      }
      const gap = gaps[p + offset]
      if (!gap || !gap.kept) continue // header / tall multi-row — extraction unreliable
      const rh = gap.bot - gap.top
      const symRaw = '/tmp/sym.png'
      magick([png, '-crop', `${bx1 - bx0 + 12}x${rh - 8}+${bx0 - 6}+${gap.top + 4}`,
        '+repage', '-fuzz', '8%', '-trim', '+repage', symRaw])
      const [sw, sh] = identify(symRaw)
      if (!sw || sw < 24 || sh < 24) {
        droppedAlign++
        continue
      }
      normalizeSign(symRaw, join(SIGNS_DIR, `${cell.code}.png`))
      catalogue[cell.code] = { tier: classifyTier(sw, sh), group: sheet.group }
      if (cell.desc) catalogue[cell.code].desc = cell.desc
      added++
    }
  }
  console.log(`[${sheet.pdf}] added=${added}  desc-added=${descAdded}  desc-updated=${descUpdated}  hallucination-dropped=${droppedHallucination}  align-dropped=${droppedAlign}  dup=${droppedDup}`)
  return added
}

// ---- main ----
await mkdir(SIGNS_DIR, { recursive: true })
const catalogue = JSON.parse(existsSync(CATALOGUE_JSON) ? await readFile(CATALOGUE_JSON, 'utf8') : '{}')
const before = Object.keys(catalogue).length
console.log(`existing catalogue: ${before} codes`)

const sheetsToRun = SHEETS.filter(s => s.pdf.includes(sheetFilter))
if (!sheetsToRun.length) {
  console.error(`No sheet matched "${sheetFilter}". Available:\n` + SHEETS.map(s => '  ' + s.pdf).join('\n'))
  process.exit(1)
}
let totalAdded = 0
for (const sheet of sheetsToRun) {
  const n = await extractSheetVLM(sheet, catalogue)
  totalAdded += n
}
await writeFile(CATALOGUE_JSON, JSON.stringify(catalogue, null, 2) + '\n')
console.log(`\nfinal catalogue: ${Object.keys(catalogue).length} codes (+${totalAdded})`)
