// PDF → crisp page raster, and PDF → path geometry, in ONE coordinate system.
//
// The Index Plan PDFs are vector (a MicroStation DGN export): the table ruling
// lines, the printed "No." digits and most pictograms are PATH geometry, with a
// handful of pictograms embedded as raster images. There is no text layer, so
// the digits still have to be READ (OCR), but the table structure is recoverable
// exactly. `mutool draw -F svg` gives a page whose viewBox is in PDF points and
// `mutool draw -F trace` gives the same geometry in the same points, so the grid
// found below and the raster cropped above never disagree.

import { readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { RENDER_SCALE, SCRATCH } from './sheets.mjs'

// Render the page from its SVG (points → crisp raster).
export function renderPage(pdf, tag) {
  const svg = join(SCRATCH, `page-${tag}.svg`)
  const r = spawnSync('mutool', ['draw', '-F', 'svg', '-o', svg, pdf, '1'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`mutool svg failed: ${r.stderr}`)
  // -b white: rsvg renders a TRANSPARENT background by default, which every
  // downstream grayscale op (OCR threshold, symbol trim/flood) composites as
  // black — erasing the page. A white page is what the pipeline expects.
  const png = join(SCRATCH, `page-${tag}.png`)
  const c = spawnSync('rsvg-convert', ['-z', String(RENDER_SCALE), '-b', 'white', svg, '-o', png], { maxBuffer: 1 << 30 })
  if (c.status !== 0) throw new Error(`rsvg-convert failed: ${c.stderr}`)
  // Hand back a memory-mapped copy, not the PNG. Every cell crop re-decodes its
  // whole source, and the page is ~32 Mpx: from the PNG that costs ~196 ms, from
  // MPC ~10 ms. With four to six crops per cell over ~150 cells × 16 sheets, that
  // decode was about two thirds of the entire run (~50 min → ~17 min). The .mpc
  // and its .cache sidecar are large and are swept with the rest of the sheet's
  // scratch; the PNG stays for anything that wants a portable page image.
  const mpc = join(SCRATCH, `page-${tag}.mpc`)
  const m = spawnSync('magick', [png, mpc], { maxBuffer: 1 << 30 })
  if (m.status !== 0) throw new Error(`magick mpc failed: ${m.stderr}`)
  return mpc
}

const PATH_RE = /<(stroke_path|fill_path)\b([^>]*)>([\s\S]*?)<\/\1>/g
const TF_RE = /transform="([^"]+)"/
const COLOR_RE = /color="([-\d. ]+)"/
const PT_RE = /<(moveto|lineto) x="([-\d.]+)" y="([-\d.]+)"/g

// Parse the page's path geometry in POINTS: axis-aligned ruling segments (the
// table lattice) plus the bounding box and colour of every filled path (the
// grey row shading that marks a superseded sign — see grid.mjs).
export function traceSegments(pdf, tag) {
  const tracePath = join(SCRATCH, `trace-${tag}.xml`)
  const r = spawnSync('mutool', ['draw', '-F', 'trace', '-o', tracePath, pdf, '1'], { maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`mutool trace failed: ${r.stderr}`)
  const xml = readFileSync(tracePath, 'utf8')
  const Hs = [], Vs = [], fills = []
  for (const pm of xml.matchAll(PATH_RE)) {
    const tf = TF_RE.exec(pm[2])
    const m = tf ? tf[1].split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0]
    const isFill = pm[1] === 'fill_path'
    const rgb = isFill ? (COLOR_RE.exec(pm[2])?.[1] ?? '').split(/\s+/).map(Number) : null
    let cur = null
    let x0b = Infinity, y0b = Infinity, x1b = -Infinity, y1b = -Infinity
    for (const s of pm[3].matchAll(PT_RE)) {
      const px = +s[2], py = +s[3]
      const X = m[0] * px + m[2] * py + m[4] // POINTS
      const Y = m[1] * px + m[3] * py + m[5]
      if (s[1] === 'lineto' && cur) {
        const [x0, y0] = cur
        // length floors (in points) drop glyph hairlines but keep cell borders.
        if (Math.abs(Y - y0) < 0.3 && Math.abs(X - x0) > 3) Hs.push({ y: (Y + y0) / 2, x0: Math.min(x0, X), x1: Math.max(x0, X) })
        if (Math.abs(X - x0) < 0.3 && Math.abs(Y - y0) > 5) Vs.push({ x: (X + x0) / 2, y0: Math.min(y0, Y), y1: Math.max(y0, Y) })
      }
      if (isFill) {
        if (X < x0b) x0b = X
        if (X > x1b) x1b = X
        if (Y < y0b) y0b = Y
        if (Y > y1b) y1b = Y
      }
      cur = [X, Y]
    }
    // Colour components: 1 on the sheets drawn in a grayscale colorspace,
    // 3 on the sRGB ones. Both carry the grey row shading.
    if (isFill && (rgb?.length === 1 || rgb?.length === 3) && x1b > x0b) {
      fills.push({ rgb, x0: x0b, y0: y0b, x1: x1b, y1: y1b })
    }
  }
  return { Hs, Vs, fills }
}

// A sheet's page raster, its SVG and its trace are ~10 MB together and are of no
// use once the sheet is extracted; so are the per-sign intermediates the split
// leaves behind. They used to live in /tmp under one fixed name, so they
// self-limited and the OS swept them — under per-tag names in the working tree
// they just pile up (266 MB observed). Bounded per sheet by the tag, but any
// one-off tag accumulates forever, so sweep explicitly.
export async function cleanSheetScratch(tag) {
  const intermediate = /-(trim|sil|ink|top|bottom)\.png$/
  for (const f of await readdir(SCRATCH).catch(() => [])) {
    if (f.startsWith(`page-${tag}.`) || f.startsWith(`trace-${tag}.`) || intermediate.test(f)) {
      await rm(join(SCRATCH, f), { force: true })
    }
  }
}
