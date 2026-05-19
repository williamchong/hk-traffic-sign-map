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
//   app/data/signCatalogue.json    { "<CODE>": { tier } }

import { mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const INDEX_PLAN_DIR = '/Users/william/Downloads/tadrawings_dataspec/Index Plan'
const SIGNS_DIR = 'public/signs'
const CATALOGUE_JSON = 'app/data/signCatalogue.json'
const QA_MONTAGE = '/tmp/sign-catalogue-qa.png'
const DPI = 400

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

function ocrLine(pngBuf, whitelist) {
  const args = ['stdin', 'stdout', '--psm', '7']
  if (whitelist) args.push('-c', `tessedit_char_whitelist=${whitelist}`)
  const r = spawnSync('tesseract', args, { input: pngBuf, maxBuffer: 1 << 26 })
  return r.status === 0 ? r.stdout.toString('utf8').trim() : ''
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

async function extractSheet(sheet, catalogue) {
  const pdf = join(INDEX_PLAN_DIR, sheet.pdf)
  const base = `/tmp/idx-${sheet.prefix}`
  spawnSync('pdftoppm', ['-png', '-r', String(DPI), '-singlefile', pdf, base])
  const png = `${base}.png`
  const [W, H] = identify(png)

  // Columns: pictogram ink forms wide vertical bands = the Symbol columns.
  const colProf = profile(png, W, H, 'x')
  const symBands = runs(colProf, 25, 70)
  // Rows: full-width grid lines peak near 255 in the 1×H projection, while
  // text/pictograms only partially fill a scanline — so a high threshold
  // isolates the rule lines.
  const rowProf = profile(png, W, H, 'y')
  const lineIdx = []
  for (let i = 0; i < rowProf.length; i++) if (rowProf[i] >= 120) lineIdx.push(i)
  const gridLines = cluster(lineIdx, 3)
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

  let extracted = 0
  for (const [bx0, bx1] of symBands) {
    for (const [rowTop, rowBot] of rowBands) {
      const y = rowTop
      const rh = rowBot - rowTop
      // Symbol cell, trimmed to ink. Empty cells (e.g. spare numbers) vanish.
      const symRaw = `/tmp/sym.png`
      magick([png, '-crop', `${bx1 - bx0 + 24}x${rh - 8}+${bx0 - 12}+${y + 4}`,
        '+repage', '-fuzz', '8%', '-trim', '+repage', symRaw])
      const [sw, sh] = identify(symRaw)
      if (!sw || sw < 24 || sh < 24) continue // blank / divider speck

      // No. cell: the big code sits in the upper ~46% of the row (above the
      // "(... )" reg-fig line). Trim to the glyphs and upscale so tesseract
      // doesn't confuse 1↔4 / 9↔3 on the thin print.
      const noBuf = magick([png,
        '-crop', `${noW}x${Math.round(rh * 0.46)}+${bx0 - noW - 8}+${y + 6}`,
        '+repage', '-colorspace', 'Gray', '-threshold', '58%',
        '-fuzz', '30%', '-trim', '+repage',
        '-bordercolor', 'white', '-border', '18', '-resize', '220%', 'png:-'],
      { binary: true })
      const raw = ocrLine(noBuf, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
        .replace(/\s+/g, '').toUpperCase()
      const m = raw.match(/^(\d{2,4})([A-Z]?)$/)
      if (!m) continue
      const num = Number(m[1])
      if (num < sheet.range[0] || num > sheet.range[1]) continue // misread
      const code = `${sheet.prefix}${m[1]}${m[2]}`
      if (catalogue[code]) continue // first (left-most) occurrence wins

      // Flood-fill the white sheet background away from the edges so the sign
      // sits transparently on the map (interior whites — STOP text, sign
      // centres — are enclosed by colour and survive). Then normalise to a
      // constant 120px height (width follows the true aspect, capped at 320)
      // so one icon-size renders every sign at the same on-screen height.
      magick([symRaw,
        '-alpha', 'set', '-bordercolor', 'white', '-border', '1',
        '-fuzz', '12%', '-fill', 'none', '-draw', 'color 1,1 floodfill',
        '-shave', '1x1', '-trim', '+repage', '-resize', '320x120',
        '+repage', join(SIGNS_DIR, `${code}.png`)])
      catalogue[code] = { tier: classifyTier(sw, sh), group: sheet.group }
      extracted++
    }
  }
  return extracted
}

requireTool('pdftoppm', 'brew install poppler')
requireTool('magick', 'brew install imagemagick')
requireTool('tesseract', 'brew install tesseract')

await mkdir(SIGNS_DIR, { recursive: true })
for (const f of await readdir(SIGNS_DIR).catch(() => [])) {
  if (f.endsWith('.png')) await rm(join(SIGNS_DIR, f))
}

const catalogue = {}
for (const sheet of SHEETS) {
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
