// Harvest the Transport Department's "Notices on Prohibited Zone" feed across
// its whole published history, and vendor the notices as a build-time
// reference for what a prohibition actually COVERS.
//
// Why this source. The IRNP's `PROHIBITION` layer records where a restriction
// was logged, not how far it runs: a row resolves to ONE `CENTERLINE` link,
// median 81 m, covering 18 % of its street (`SPEED_LIMIT`, by contrast, covers
// 72 %). So the map draws a stub at the sign and nothing on the road behind it
// — which is exactly the gap a reader notices when a whole district is closed
// to public light buses and only its approach roads are shaded.
//
// The extent lives instead in the Commissioner's own directions under
// regulation 14(1)(a) of the Road Traffic (Traffic Control) Regulations
// (Cap. 374G), published as traffic notices and gazetted. Reg 14(1) lets the
// Commissioner "designate any area", and 14(2) then prohibits driving "on any
// road within" it — but in practice the directions name **slip roads and
// part-roads**, and the district-wide effect emerges from connectivity. TD's
// 2021 Tsing Yi direction is the clearest specimen: it rescinds two zones to
// open a corridor to the Vehicle Examination Complex, then designates
// eighteen slip roads and directional sections to seal every exit off it.
//
// That is the same shape as `road-cutoff.mjs` — close the ways in, let the
// graph say what is stranded — so these notices are the input that layer has
// always been missing, not a new mechanism.
//
// ⚠ This script VENDORS the notices. It does not bind them to the network and
// it does not move a line on the map. Binding a notice's prose ("the slip road
// from Cheung Tsing Highway southbound to Lantau Link") onto `CENTERLINE`
// links is a separate, human-gated job, for the same reason the Road Users'
// Code names are earned rather than assumed: the text names a *movement*
// between two roads, and the network has no field for one.
//
// ⚠ A zone is a LIVE artefact, not a fact. Sai Tso Wan Road's boundary moved
// three times in four months — 693 m west of its junction (31 May 2021), then
// past 693 m (11 June), then 750 m (10 Sept) — each notice rescinding the last.
// So the corpus records every version with the window it was observed in, and
// `supersededBy` is left to the binder: only the prose says which rescinds which.
//
// Source: https://data.gov.hk/en-data/dataset/hk-td-tis_22-traffic-notices
// Archive: data.gov.hk keeps a dated snapshot of every file it lists. The
// prohibited-zone feed has ~1,130 snapshots from 2021-06-25; the live feed
// alone holds only the ~50 notices current today, so the history is where the
// standing designations are.
//
// Output: `data/zone-notices/prohibited-zones.json` (vendored, reviewed) +
// snapshots cached under `data/raw/.notice-cache` (gitignored, deduped by
// content hash — consecutive snapshots are usually identical).
//
// Usage: node scripts/fetch-zone-notices.mjs [--refresh] [--feed <name>]
//                                            [--start YYYYMMDD] [--limit N]

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import path from 'node:path'

import { cacheWrite, makePacer } from './fetch-cache.mjs'

const ARCHIVE = 'https://api.data.gov.hk/v1/historical-archive'
const FEED_BASE = 'https://www.td.gov.hk/datagovhk_tis/traffic-notices'

// The eight feeds the dataset publishes. Only the prohibited-zone one carries
// reg 14(1)(a) designations, which is what an extent needs; the others are
// harvestable with `--feed` but describe different instruments (a clearway, a
// temporary closure, a restricted zone under 14(1)(b) — a stopping ban, not a
// driving ban).
const FEEDS = [
  'Notices_on_Prohibited_Zone',
  'Notices_on_Temporary_Speed_Limits',
  'Notices_on_Temporary_Road_Closure',
  'Notices_on_Clearways',
  'Notices_on_Public_Transports',
  'Special_Traffic_and_Transport_Arrangement',
  'Notices_on_Expressways',
  'Other_Notices'
]

const CACHE = 'data/raw/.notice-cache'
const OUT_DIR = 'data/zone-notices'

const { values: opts } = parseArgs({
  options: {
    refresh: { type: 'boolean', default: false },
    feed: { type: 'string', default: FEEDS[0] },
    start: { type: 'string', default: '20100101' },
    limit: { type: 'string' }
  }
})

if (!FEEDS.includes(opts.feed)) {
  console.error(`Unknown feed "${opts.feed}". One of:\n  ${FEEDS.join('\n  ')}`)
  process.exit(1)
}

// The archive refuses an `end` later than yesterday, so ask for yesterday.
const yesterday = () => {
  const d = new Date(Date.now() - 86_400_000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

const pace = makePacer(400)

async function getText(url) {
  await pace()
  const res = await fetch(url, { headers: { 'User-Agent': 'hk-traffic-sign-map/zone-notices' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.text()
}

// TD's notice XML: one <Notice> per record, with parallel EN/TC/SC fields and
// the body as escaped HTML. `TNID` is the notice's own id and is stable across
// snapshots, which is what makes the history dedupable.
const NOTICE_RX = /<Notice>([\s\S]*?)<\/Notice>/g
const field = (body, name) => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? ''

// Two layers of escaping: the XML feed escapes the HTML body, so `&nbsp;` in
// the body arrives as `&amp;nbsp;`. Decode the XML layer (`&amp;` and friends)
// FIRST, then the HTML entities — the other order left ~1,000 literal
// `&nbsp;` in the vendored text.
const unescapeXml = s => s
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, '\'').replace(/&apos;/g, '\'')
  .replace(/&nbsp;/g, ' ')

// Body text with the HTML stripped and whitespace collapsed. The notices are
// pasted from Word, so they carry `<p>`, `<span style=…>` and runs of &nbsp;
// that would otherwise land in the vendored file verbatim.
const plain = html => unescapeXml(html)
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

// Which vehicle classes a notice speaks to, in the same vocabulary as
// `PROHIBITION_KINDS` in sign-layers.mjs, so a bound notice can later feed the
// legend row it belongs to. Text-derived and deliberately generous: a notice
// matching nothing is kept as `other`, never dropped.
function kindsOf(text) {
  const t = text.toLowerCase()
  const kinds = new Set()
  if (/public light bus|light bus/.test(t)) kinds.add('plb')
  if (/goods vehicle|exceeding \d+(\.\d+)? tonnes/.test(t)) kinds.add('gv')
  if (/learner driver/.test(t)) kinds.add('ld')
  if (/all (motor )?vehicles/.test(t)) kinds.add('all')
  if (!kinds.size) kinds.add('other')
  return [...kinds]
}

// A rescission reads as one; the binder needs to know before it draws anything.
const isRescission = title => /rescission|rescind|recession/i.test(title)

mkdirSync(path.join(CACHE, opts.feed), { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

const feedUrl = `${FEED_BASE}/${opts.feed}.xml`
console.log(`Feed: ${feedUrl}`)

const listUrl = `${ARCHIVE}/list-file-versions?${new URLSearchParams({ url: feedUrl, start: opts.start, end: yesterday() })}`
const listed = JSON.parse(await getText(listUrl))
let timestamps = listed.timestamps ?? []
if (!timestamps.length) {
  console.error('No archived versions returned:', listed)
  process.exit(1)
}
if (opts.limit) {
  const n = Number(opts.limit)
  const step = Math.max(1, Math.floor(timestamps.length / n))
  timestamps = timestamps.filter((_, i) => i % step === 0)
}
console.log(`  ${timestamps.length} snapshots, ${timestamps[0]} → ${timestamps.at(-1)}`)

// Cache is keyed by CONTENT hash, not by timestamp: the feed changes only when
// a notice is added or withdrawn, so most consecutive snapshots are byte
// identical and storing one copy each would be ~500 MB of duplicates. The
// timestamp→hash index is what makes a re-run free.
const indexPath = path.join(CACHE, opts.feed, '_index.json')
const index = !opts.refresh && existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {}

let fetched = 0
let reused = 0
for (const [i, ts] of timestamps.entries()) {
  if (index[ts] && existsSync(path.join(CACHE, opts.feed, `${index[ts]}.xml`))) {
    reused++
    continue
  }
  const url = `${ARCHIVE}/get-file?${new URLSearchParams({ url: feedUrl, time: ts })}`
  let xml
  try {
    xml = await getText(url)
  } catch (err) {
    console.warn(`  ⚠ ${ts}: ${err.message}`)
    continue
  }
  const hash = createHash('sha1').update(xml).digest('hex').slice(0, 16)
  const dst = path.join(CACHE, opts.feed, `${hash}.xml`)
  if (!existsSync(dst)) await cacheWrite(dst, xml)
  index[ts] = hash
  fetched++
  if (fetched % 25 === 0) {
    writeFileSync(indexPath, JSON.stringify(index))
    process.stdout.write(`  ${i + 1}/${timestamps.length} snapshots (${fetched} fetched, ${reused} cached)\r`)
  }
}
writeFileSync(indexPath, JSON.stringify(index))
console.log(`  ${fetched} fetched, ${reused} already cached, ${new Set(Object.values(index)).size} distinct bodies`)

// Replay the snapshots in order. A notice is recorded once, under its TNID,
// with the window it was observed in — `firstSeen` is roughly when it was
// published, `lastSeen` when it left the live feed. Neither is its effective
// date, which is in the prose and is the binder's business.
const notices = new Map()
for (const ts of timestamps) {
  const hash = index[ts]
  if (!hash) continue
  const file = path.join(CACHE, opts.feed, `${hash}.xml`)
  if (!existsSync(file)) continue
  const xml = readFileSync(file, 'utf8')
  for (const [, body] of xml.matchAll(NOTICE_RX)) {
    const tnid = field(body, 'TNID').trim()
    if (!tnid) continue
    const titleEn = plain(field(body, 'Title_EN'))
    const contentEn = plain(field(body, 'Content_EN'))
    const prev = notices.get(tnid)
    if (prev) {
      prev.lastSeen = ts
      continue
    }
    notices.set(tnid, {
      tnid,
      title: { en: titleEn, tc: plain(field(body, 'Title_TC')) },
      startEffectiveDate: field(body, 'StartEffectiveDate').trim() || null,
      districtId: field(body, 'TrafficNoticesDistrictID').trim() || null,
      kinds: kindsOf(`${titleEn} ${contentEn}`),
      rescission: isRescission(titleEn),
      content: { en: contentEn, tc: plain(field(body, 'Content_TC')) },
      firstSeen: ts,
      lastSeen: ts
    })
  }
}

const all = [...notices.values()].sort((a, b) => Number(a.tnid) - Number(b.tnid))
const plb = all.filter(n => n.kinds.includes('plb'))

const out = {
  source: {
    dataset: 'https://data.gov.hk/en-data/dataset/hk-td-tis_22-traffic-notices',
    feed: feedUrl,
    archive: ARCHIVE,
    legalBasis: 'Road Traffic (Traffic Control) Regulations (Cap. 374G) reg 14(1)(a)'
  },
  harvestedAt: new Date().toISOString().slice(0, 10),
  snapshots: { count: timestamps.length, from: timestamps[0], to: timestamps.at(-1) },
  counts: {
    notices: all.length,
    plb: plb.length,
    plbDesignations: plb.filter(n => !n.rescission).length,
    plbRescissions: plb.filter(n => n.rescission).length
  },
  notices: all
}
const outPath = path.join(OUT_DIR, `${opts.feed === FEEDS[0] ? 'prohibited-zones' : opts.feed.toLowerCase()}.json`)
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')

const tally = new Map()
for (const n of all) for (const k of n.kinds) tally.set(k, (tally.get(k) ?? 0) + 1)
console.log(`\n${outPath}: ${all.length} distinct notices`)
console.log(`  by class: ${[...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
console.log(`  public light bus: ${plb.length} (${out.counts.plbDesignations} designations, ${out.counts.plbRescissions} rescissions)`)
