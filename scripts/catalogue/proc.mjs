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

export function requireTool(cmd, hint) {
  if (spawnSync(cmd, ['--version']).error) {
    console.error(`Missing \`${cmd}\`. Install it: ${hint}`)
    process.exit(1)
  }
}

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
