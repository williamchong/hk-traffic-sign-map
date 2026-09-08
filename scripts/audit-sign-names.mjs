// Re-check every SHIPPED description against the vendored name list.
//
// WHY THIS EXISTS. `names.mjs` checks a description at the moment it is
// extracted, and `audit-sign-images.mjs` checks the No.↔PICTOGRAM bind against
// Road Sign Factory's plates. Nothing checked the No.↔DESCRIPTION bind of the
// text ALREADY IN THE CATALOGUE — and that text does not age out. A merge run
// leaves an existing code completely alone (extract.mjs: the row's OCR and
// verdict are computed and then discarded, no crop, no `desc` update), so a
// description written by an older extractor is never revisited by any ordinary
// rebuild. 71 such rows survived three generations of the extractor that way,
// including TS438 shipping "WEIGHT RESTRICTED AHEAD 4.0M" for a HEIGHT sign.
//
// So: run the current `verdictFor` over the stored `desc.en` of every entry and
// report anything it would not ship today. A stored `fill` description IS the
// reference's wording, so it re-verdicts as `agree` — anything that does not is
// either legacy or a genuine disagreement worth a human's eyes.
//
// WHAT --write MAY TOUCH. Only the two verdicts whose `ship` IS the list's
// wording — `fill` and `ocr-debris` — and only their `desc.en`. Writing those
// is the pipeline's own decision replayed, not a judgment. `disagree` ships no
// description and `code-misread` withholds the pictogram: acting on either
// without reading the printed sheet would invent a decision the pipeline never
// makes, so they are reported and left alone. Same for `no-list` — no reference
// key exists, our read is all there is, and nothing can check it.
//
// A DISAGREEMENT IS NOT A VERDICT — it means "go read the printed sheet". The
// name list is a hand transcription with a documented row slip (see
// data/sign-names/README.md); the TD Index Plan is the authority.
//
// Deliberately OUTSIDE data:catalogue and data:build — on demand, and read-only
// unless --write is passed.
//
// Usage:
//   node scripts/audit-sign-names.mjs                    # report only
//   node scripts/audit-sign-names.mjs --write            # apply the `fill` rows
//   node scripts/audit-sign-names.mjs --code TS438,TS452 # narrow to some codes

import { parseArgs } from 'node:util'

import { loadNames, verdictFor } from './catalogue/names.mjs'
import { readCatalogue, writeCatalogue } from './catalogue/store.mjs'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    write: { type: 'boolean', default: false },
    code: { type: 'string', multiple: true, default: [] }
  }
})

const ONLY = new Set(values.code.flatMap(c => c.split(',')).map(c => c.trim().toUpperCase()).filter(Boolean))

// Worst first: the two that would change what SHIPS lead, then the two that
// ship the list's wording, then the ones nothing can check. A verdict missing
// from this list still reports — it sorts and prints last rather than vanishing,
// because `names.mjs` owns the verdict set and will grow it again (`ocr-debris`
// was added after this script and went unlisted, tallied but never itemised).
const ORDER = ['code-misread', 'digit-conflict', 'disagree', 'shift-suspect', 'ocr-debris', 'fill', 'no-ocr', 'no-list']
const rank = v => (ORDER.indexOf(v) + 1 || ORDER.length + 1)

const catalogue = await readCatalogue()
const names = loadNames()

const rows = []
let described = 0
for (const [code, entry] of Object.entries(catalogue)) {
  const en = entry.desc?.en
  if (!en) continue
  if (ONLY.size && !ONLY.has(code)) continue
  described++
  const v = verdictFor(names, code, en)
  if (v.verdict === 'agree') continue
  rows.push({ code, verdict: v.verdict, sim: v.sim, ours: en, ship: v.ship, altKey: v.altKey, debris: v.debris })
}
rows.sort((a, b) => rank(a.verdict) - rank(b.verdict) || a.code.localeCompare(b.code))

const present = [...new Set(rows.map(r => r.verdict))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
for (const v of present) {
  const group = rows.filter(r => r.verdict === v)
  console.log(`\n${v} — ${group.length}`)
  for (const r of group) {
    const score = r.sim === undefined ? '' : ` sim=${r.sim.toFixed(2)}`
    const alt = r.altKey ? ` reads as ${r.altKey}` : ''
    console.log(`  ${r.code.padEnd(9)}${score}${alt}`)
    console.log(`    ours ${JSON.stringify(r.ours)}`)
    if (r.ship && r.ship !== r.ours) console.log(`    list ${JSON.stringify(r.ship)}`)
    if (r.debris?.length) console.log(`    noise ${r.debris.join(' ')}`)
  }
}

// The verdicts that carry the list's own wording; see WHAT --write MAY TOUCH.
const REPLAYABLE = new Set(['fill', 'ocr-debris'])
const replayable = rows.filter(r => REPLAYABLE.has(r.verdict) && r.ship && r.ship !== r.ours)
const tally = rows.reduce((t, r) => ({ ...t, [r.verdict]: (t[r.verdict] ?? 0) + 1 }), {})
console.log(`\nchecked ${described} description(s); ${rows.length} are not what the current check would ship`)
console.log(`verdicts: ${Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`)

// `no-list` is not a finding to act on — there is no reference key for the code,
// so our read is the only wording there is. Everything else left over is a real
// disagreement, and the only thing that settles one is the printed sheet.
const contested = rows.filter(r => r.verdict !== 'no-list' && !REPLAYABLE.has(r.verdict))
const sheetNote = contested.length
  ? `; ${contested.length} disagree with the list and need the printed sheet (${contested.map(r => r.code).join(', ')})`
  : ''

if (!values.write) {
  console.log(`\n--write would rewrite ${replayable.length} row(s) to the list's wording${sheetNote}.`)
  process.exit(0)
}

for (const r of replayable) catalogue[r.code].desc = { en: r.ship }
await writeCatalogue(catalogue)
console.log(`\nrewrote ${replayable.length} row(s)${sheetNote}.`)
