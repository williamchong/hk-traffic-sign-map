// Process helpers: the external tools the extractor shells out to.
// (Kept out of cli.mjs so the image modules don't have to import the CLI.)

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export function magick(args, { binary = false } = {}) {
  const r = spawnSync('magick', args, { maxBuffer: 1 << 30, encoding: binary ? 'buffer' : 'utf8' })
  if (r.status !== 0) throw new Error(`magick ${args.join(' ')}\n${r.stderr}`)
  return r.stdout
}

// One-shot `magick … info:` read of a format string, as trimmed text.
export function magickInfo(args, format) {
  const r = spawnSync('magick', [...args, '-format', format, 'info:'], { encoding: 'utf8' })
  return (r.stdout ?? '').trim()
}

// `magick identify` takes the format WITHOUT a trailing `info:` — it is its own
// subcommand, not a pipeline, so it can't go through magickInfo.
export function identify(file) {
  const r = spawnSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' })
  return (r.stdout ?? '').trim().split(/\s+/).map(Number)
}

// The tool check lives in geo.mjs (shared with the tile builders); re-exported
// here so the extractor's callers keep their import.
export { requireTool } from '../geo.mjs'

// A tesseract language/model must be installed in its tessdata dir; the No.
// column is read with both `eng` and the digits model `snum` (see ocr.mjs).
export function requireModel(lang, hint) {
  const r = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8' })
  if (!new RegExp(`^${lang}$`, 'm').test(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)) {
    console.error(`tesseract has no \`${lang}\` model (tesseract --list-langs). Install it: ${hint}`)
    process.exit(1)
  }
}

// ImageMagick registers no fonts in this environment (`magick -list font` is
// empty), so `montage` — used for the review / verify sheets — can't render even
// an empty label without an explicit -font. Resolve one system TTF up front.
// The Road Users' Code review sheet labels each row with its Chinese name, and
// Arial has no CJK coverage — every glyph renders as tofu, which is worse than
// no label because it looks like a rendering bug rather than a missing font.
// Arial Unicode is the one face shipped with macOS that ImageMagick loads
// directly (PingFang and the other system faces are `.ttc` collections that
// FreeType refuses through magick's `-font`).
export function resolveCjkFont() {
  const font = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
  ].find(f => existsSync(f))
  if (!font) {
    console.error('No CJK-capable TTF found for `magick` labels — add one to resolveCjkFont() in scripts/catalogue/proc.mjs')
    process.exit(1)
  }
  return font
}

export function resolveFont() {
  const font = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  ].find(f => existsSync(f))
  if (!font) {
    console.error('No usable TTF found for `magick montage` — add one to resolveFont() in scripts/catalogue/proc.mjs')
    process.exit(1)
  }
  return font
}
