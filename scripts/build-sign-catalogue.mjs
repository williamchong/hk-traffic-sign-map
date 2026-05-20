// Build the sign catalogue from TD's Index Plan PDFs by sending each page to
// Sonnet 4.6 and asking for an ordered list of {code, desc, y} records per
// column-group. We then use the page's detected grid geometry to crop the
// symbol cell for each code, normalize to a PNG, and write the catalogue.
//
// Replaces an earlier tesseract + 3-layer-LIS pipeline (git history). The
// reason for the swap: with the CAD font and noise-contaminated No.-column
// crops, tesseract needed extensive scaffolding to avoid mislabelling
// (primary-LIS, fallback-LIS, per-gap LIS, vRule snapping, right-cut). The
// VLM reads the whole table as ONE artifact, using row/column ordering as
// its own self-consistency check — so most of that scaffolding becomes
// unnecessary. Two safety nets remain, because they're cheaper than trust:
//
//   1. GML SIGNID FILTER. Vision models occasionally hallucinate plausible
//      sequential numbers (e.g. "635" between 634 and 636 when 635 doesn't
//      exist on any real road). We only KEEP a code if it appears at least
//      once in data/raw/DTAD_TS_ABV_PT.gml — the authoritative set of codes
//      actually on signs in HK. Codes not in this set wouldn't be referenced
//      by any map feature anyway, so the filter is loss-less for the app.
//
//   2. POSITIONAL Y ALIGNMENT. The model emits a `y` hint (row-centre as a
//      fraction of image height) per code. We map each code to the kept
//      rowBand whose centre is nearest by y, gated by `pitch * 0.5` (so the
//      target must land inside that row, not adjacent). A taken-set + a
//      monotone-y-within-group check means each band hosts at most one
//      code and codes can't jump backwards. If y is missing or outside
//      tolerance, the cell silently degrades to a dot — the documented
//      "missed sign is fine, MISLABELLED sign must never ship" invariant.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-...  node scripts/build-sign-catalogue.mjs
//                                                          # full rebuild,
//                                                          # merge mode
//   ... node scripts/build-sign-catalogue.mjs --wipe       # full rebuild,
//                                                          # wipe first
//   ... node scripts/build-sign-catalogue.mjs --sheet "601 - 700"
//                                                          # one sheet only
//
// Cost: roughly $0.15 to rebuild all 16 sheets (one Sonnet call per page).

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  const prompt = `This is one page from the Hong Kong Transport Department "Index Plan" — a reference of all traffic signs. The page is a table whose columns repeat the pattern [No. | Symbol | Description] for each column-group. Codes ("641", "642", …) appear in the small "No." column at the LEFT of each group. Codes go down each group, then continue at the top of the next group to the right.

For each row that has a sign code (skip blank / "SYMBOL NOT AVAILABLE" / placeholder rows entirely — do NOT emit them), return an object:

  { "code": "641", "desc": "DIRECTION TO FOOTBRIDGE", "y": 0.27 }

where:
  - "code" = exact digits in the No. column, preserving any letter suffix (e.g. "636L", "639T").
  - "desc" = the ENGLISH text in the row's Description column, UPPERCASE, with Chinese characters and "(DOUBLE SIDES)" sub-notes omitted. Empty string if the desc column has nothing.
  - "y" = approximate VERTICAL POSITION of the row's centre, as a fraction of the IMAGE HEIGHT (0.0 at the very top of the page, 1.0 at the very bottom). Be reasonably precise (two decimal places is fine).

Return ONLY a JSON array of arrays. Outer array = column-groups, left to right. Inner arrays = the rows of that group with codes. Skip blank rows entirely (no NONE entries needed — y disambiguates position). No markdown fences, no prose.`
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

  // Parse each VLM row into a uniform shape, including the y hint that lets
  // us map by spatial position instead of ordinal index.
  function parseCell(item) {
    if (item == null || item === 'NONE' || typeof item !== 'object') return null
    const raw = String(item.code ?? '').toUpperCase().replace(/\s+/g, '')
    if (!raw || raw === 'NONE') return null
    const m = raw.match(/^(\d{2,4})([A-Z]?)$/)
    if (!m) return null
    const n = +m[1]
    if (n < sheet.range[0] || n > sheet.range[1]) return null
    return {
      code: `${sheet.prefix}${m[1]}${m[2]}`,
      base: `${sheet.prefix}${m[1]}`,
      desc: String(item.desc ?? '').trim().toUpperCase().replace(/\s+/g, ' '),
      y: typeof item.y === 'number' ? item.y : null
    }
  }

  // Kept rowBands in centre-y order, for nearest-band lookup.
  const keptGaps = gaps.filter(g => g.kept).map(g => ({ ...g, center: (g.top + g.bot) / 2 }))
  // Match guard: a code's y-target must lie within `pitch * 0.5` of a kept
  // rowBand centre — i.e. inside that row. Wider than that, the model is
  // pointing somewhere we can't justify as "this row", so we skip and the
  // sign stays a dot.
  const Y_TOL = pitch * 0.5

  // PASS 1 — description fixes for codes already in the catalogue. No
  // positional logic needed; we just match the code string. Runs over EVERY
  // VLM row across every group, regardless of alignment.
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

  // PASS 2 — add NEW pictogram + entry for codes not yet in catalogue. We
  // need to extract the symbol cell, which requires knowing which row the
  // code lives in. Earlier versions matched by ordinal index, which broke
  // whenever the VLM and our geometry disagreed about row count (blank
  // rows, tall multi-row cells, header counted vs not). Instead, ask the
  // VLM for a y-position hint per row and match to the NEAREST kept
  // rowBand by y-coordinate. Robust to count drift, and a band already
  // taken by a previous code in the same group blocks subsequent codes
  // (codes increase down a group, so each kept band hosts at most one
  // code — that property doubles as a sanity check).
  let added = 0, droppedHallucination = 0, droppedAlign = 0, droppedDup = 0, droppedNoY = 0
  for (let g = 0; g < parsed.length; g++) {
    if (g >= symBands.length) {
      console.warn(`  group ${g + 1} from VLM has no matching detected symBand — skipping new-code add`)
      continue
    }
    const [bx0, bx1] = symBands[g]
    const taken = new Set() // rowBand indices already claimed in this group
    let lastCenter = -Infinity // enforce monotone y-progression within a group
    for (const item of (parsed[g] ?? [])) {
      const cell = parseCell(item)
      if (!cell) continue
      if (catalogue[cell.code]) {
        droppedDup++
        continue
      }
      if (!onMap.has(cell.code) && !onMap.has(cell.base)) {
        droppedHallucination++
        continue
      }
      if (cell.y == null) {
        droppedNoY++
        continue
      }
      const targetY = cell.y * H
      let bestIdx = -1, bestDist = Infinity
      for (let i = 0; i < keptGaps.length; i++) {
        if (taken.has(i)) continue
        if (keptGaps[i].center <= lastCenter) continue
        const d = Math.abs(keptGaps[i].center - targetY)
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
        }
      }
      if (bestIdx < 0 || bestDist > Y_TOL) {
        droppedAlign++
        continue
      }
      const gap = keptGaps[bestIdx]
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
      taken.add(bestIdx)
      lastCenter = gap.center
      added++
    }
  }
  console.log(`[${sheet.pdf}] added=${added}  desc-added=${descAdded}  desc-updated=${descUpdated}  hallucination-dropped=${droppedHallucination}  align-dropped=${droppedAlign}  no-y=${droppedNoY}  dup=${droppedDup}`)
  return added
}

// ---- main ----
await mkdir(SIGNS_DIR, { recursive: true })
if (wipe) {
  for (const f of await readdir(SIGNS_DIR).catch(() => [])) {
    if (f.endsWith('.png')) await rm(join(SIGNS_DIR, f))
  }
  console.log('--wipe: cleared public/signs/ and starting from an empty catalogue')
}
const catalogue = wipe || !existsSync(CATALOGUE_JSON)
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
await writeFile(CATALOGUE_JSON, JSON.stringify(catalogue, null, 2) + '\n')
console.log(`\nfinal catalogue: ${Object.keys(catalogue).length} codes (+${totalAdded})`)
