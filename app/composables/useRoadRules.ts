import { useLocalStorage } from '@vueuse/core'
import type { LngLat } from 'maplibre-gl'
import { str } from '~/utils/format'

// Road-rules overlay state — where a speed limit, bus-only lane, vehicle
// prohibition, no-stopping restriction or pedestrian zone applies. The
// extents are TD's Road Network v2 layers tiled by
// scripts/build-road-rules.mjs into public/data/road-rules.pmtiles; nothing
// is derived from sign points (see CLAUDE.md, pipeline step 5). Singleton
// module state like useTrafficLayers, shared by the panel, the map and the
// popups.

// tippecanoe source-layer names in the archive — RDNET_RULE_LAYERS keys,
// CUTOFF_LAYER and PROHIBITION_KINDS / NSR_VEHICLE_TYPES in
// scripts/sign-layers.mjs, duplicated per the two-runtime rule.
// `cutoff` is the one DERIVED layer: roads public light buses cannot enter at
// all, because TD's prohibitions and turn bans close every way in
// (scripts/road-cutoff.mjs) — its popup says so rather than citing a rule.
export type RuleLayer = 'speed' | 'buslane' | 'prohibition' | 'nsr' | 'pedzone' | 'cutoff'
export type ProhibitionKind = 'plb' | 'ld' | 'gv' | 'all' | 'other'
export type NsrVehicle = 'ALL' | 'TX' | 'PLB' | 'GV' | 'OTH'
export type NsrTimeZone = '24h' | 'peaks' | 'day' | 'late' | 'other'
export const RULE_SOURCE = 'rules'

export interface RuleRow {
  // Legend row + localStorage key; `rules.rows.<key>` is its label.
  key: string
  layer: RuleLayer
  // Prohibition rows are one source-layer split by `kind`.
  kind?: ProhibitionKind
  color: string
  // On for a visitor who has never touched the overlay (see rulesEnabled).
  defaultOn?: boolean
}

// Legend order. Colours are hex literals so the same value feeds the legend
// swatch (inline style) and the MapLibre `line-color` expression; mid-tones
// that read on both the light OSM and the dark CARTO basemap (no near-black).
// Bus lanes are blue like their plates; prohibitions are dashed on the map,
// so a hue shared with a speed value doesn't confuse.
export const RULE_ROWS: RuleRow[] = [
  { key: 'speed', layer: 'speed', color: '#f59e0b' },
  { key: 'buslane', layer: 'buslane', color: '#2563eb' },
  // ONE row for TWO source-layers: TD's "PLB Proh" lines and the derived
  // `cutoff` band behind them (rowKeyFor sends both here). A ban and the area
  // it seals off answer the same question — where a public light bus cannot
  // go — and the band is unreadable without the dashes that cause it, so
  // splitting them only asked the reader to tick two boxes for one answer.
  // The one row that starts ON: it is the overlay's most useful reading and
  // needs no legend to parse, unlike a speed or no-stopping colour scale.
  { key: 'plb', layer: 'prohibition', kind: 'plb', color: '#0d9488', defaultOn: true },
  { key: 'proh-ld', layer: 'prohibition', kind: 'ld', color: '#7c3aed' },
  { key: 'proh-gv', layer: 'prohibition', kind: 'gv', color: '#b45309' },
  { key: 'proh-all', layer: 'prohibition', kind: 'all', color: '#e11d48' },
  { key: 'proh-other', layer: 'prohibition', kind: 'other', color: '#64748b' },
  // Non-prohibition rows keep key === layer (rowKeyFor relies on it) and never
  // carry a `kind` — prohibitionColorStops is built from the rows that do.
  { key: 'nsr', layer: 'nsr', color: '#db2777' },
  { key: 'pedzone', layer: 'pedzone', color: '#65a30d' }
]

// Speed-limit lines are coloured by value (the row colour is only its swatch
// fallback). 50 km/h is the territory default and has no rows in the data.
export const SPEED_COLORS: Record<number, string> = {
  30: '#0891b2',
  70: '#ca8a04',
  80: '#ea580c',
  100: '#dc2626',
  110: '#7c3aed'
}
export const SPEED_VALUES = Object.keys(SPEED_COLORS).map(Number)
export const speedColorStops = SPEED_VALUES.flatMap(v => [v, SPEED_COLORS[v]!])
// No-stopping lines are coloured by who may not stop (`veh`, TD's vehicle
// code), in a pink/magenta family that no other row or speed value uses —
// the dotted pattern already marks them as kerbside, the hue says whose rule.
export const NSR_VEH_COLORS: Record<NsrVehicle, string> = {
  ALL: '#db2777',
  TX: '#f472b6',
  PLB: '#c026d3',
  GV: '#86198f',
  OTH: '#e879f9'
}
export const NSR_VEH_VALUES = Object.keys(NSR_VEH_COLORS) as NsrVehicle[]
export const nsrColorStops = NSR_VEH_VALUES.flatMap(v => [v, NSR_VEH_COLORS[v]!])
export const prohibitionColorStops = RULE_ROWS.filter(r => r.kind).flatMap(r => [r.kind!, r.color])
// The cut-off band's own colour — a lighter teal than the PLB prohibition
// dashes it shares a row with, so the wide translucent band reads as "the
// area behind those dashes" and not as a second rule. It has no row of its
// own to hold it, so it is a constant.
export const CUTOFF_COLOR = '#2dd4bf'
// A legend row's colour, by key — the map paint, the popup swatch and the
// legend chips all resolve it here instead of each scanning RULE_ROWS.
export const ruleColor = (key: string) => RULE_ROWS.find(r => r.key === key)!.color

// Which legend row draws this feature. `cutoff` has no row: it rides the PLB
// prohibition row, so both source-layers map to that one key.
export const rowKeyFor = (layer: RuleLayer, kind?: string | null) => {
  if (layer === 'cutoff') return 'plb'
  if (layer !== 'prohibition') return layer
  return kind === 'plb' ? 'plb' : `proh-${kind ?? 'other'}`
}

// Persisted, unlike the category toggles: someone who turned on speed limits
// wants them back on the next visit. Every row is an opt-in reading of the
// map except the PLB one, which starts on (`defaultOn`). `mergeDefaults` so a
// row added later starts at its default instead of undefined — which is also
// why a row whose default CHANGES needs a new key to reach anyone who already
// has the old one stored (the merged PLB row is `plb`, not `proh-plb`).
const rulesEnabled = useLocalStorage<Record<string, boolean>>(
  'hk-signs:road-rules',
  Object.fromEntries(RULE_ROWS.map(r => [r.key, !!r.defaultOn])),
  { mergeDefaults: true }
)
const anyRuleOn = computed(() => RULE_ROWS.some(r => rulesEnabled.value[r.key]))
const enabledKinds = computed(() =>
  RULE_ROWS.filter(r => r.kind && rulesEnabled.value[r.key]).map(r => r.kind!)
)
const isRowEnabled = (layer: RuleLayer, kind?: string | null) => !!rulesEnabled.value[rowKeyFor(layer, kind)]

export interface SelectedRule {
  layer: RuleLayer
  properties: Record<string, unknown>
  // Where the click landed (a line has no single point to anchor on).
  lngLat: LngLat
}
const selectedRule = ref<SelectedRule | null>(null)

// The rule feature found for the selected SIGN (see SIGN_RULE_LINKS and the
// lookup in TrafficMap): shown inside the sign popup as "applies here".
export interface GoverningRule {
  layer: RuleLayer
  properties: Record<string, unknown>
}
const governingRule = ref<GoverningRule | null>(null)

// Sign codes whose plate announces a rule the archive has an extent for, and
// what to match. The lookup takes the nearest matching feature within
// SIGN_RULE_RADIUS_M of the sign — 90–99 % of these signs sit that close to
// their rule (measured over the whole territory), so a miss usually means
// the sign is a repeater on a segment TD keyed differently, not a wrong rule.
// No-stopping needs TD's vehicle code AND the time band the plate prints — a
// veh-only match would hand a 7am–7pm plate the 24-hour line on the next kerb.
export type SignRuleLink
  = | { layer: 'speed', speed: number }
    | { layer: 'buslane' }
    | { layer: 'prohibition', kind: ProhibitionKind }
    | { layer: 'nsr', veh: NsrVehicle, tz: NsrTimeZone }
export const SIGN_RULE_LINKS: Record<string, SignRuleLink> = {
  TS173: { layer: 'speed', speed: 30 },
  TS175: { layer: 'speed', speed: 70 },
  TS176: { layer: 'speed', speed: 80 },
  TS177: { layer: 'speed', speed: 100 },
  TS197: { layer: 'speed', speed: 110 },
  TS121: { layer: 'buslane' },
  TS122: { layer: 'buslane' },
  TS123: { layer: 'buslane' },
  TS124: { layer: 'buslane' },
  TS125: { layer: 'buslane' },
  TS126: { layer: 'buslane' },
  TS127: { layer: 'buslane' },
  TS129: { layer: 'buslane' },
  TS373: { layer: 'buslane' },
  TS119: { layer: 'prohibition', kind: 'plb' },
  TS522: { layer: 'prohibition', kind: 'plb' },
  TS130: { layer: 'prohibition', kind: 'ld' },
  // No-stopping zones, each held to the same bar as the links above: the
  // share of the code's installs within SIGN_RULE_RADIUS_M of an NSR line of
  // the SAME veh + tz, measured territory-wide at the tile (pole) position —
  // ALL 95.1–97.9 %, PLB 91.2–100 %, GV 95.6–100 %, bus (TD codes it OTH)
  // 88.9–100 % over a 96.4 % family. Codes under 10 installs ride on their
  // (veh, tz) group's rate. Deliberately NOT linked, because TD's lines don't
  // agree with the plate: the 7am–7pm and 8–10am & 5–7pm all-vehicle zones
  // (TS2133 18.5 %, TS2134 23.6 %, TS2230 17.1 %, TS184 47.2 % — TD codes
  // most of those kerbs OTH, not ALL), the clearway TS183 (70.9 %), TS2138
  // (83.0 %), and every plate whose hours fall in NSR's "other" band except
  // goods vehicles'. The END-of-zone plates mark where a zone stops, not
  // where it applies, so they never link.
  TS2131: { layer: 'nsr', veh: 'ALL', tz: 'late' },
  TS2132: { layer: 'nsr', veh: 'ALL', tz: 'late' },
  TS188: { layer: 'nsr', veh: 'ALL', tz: 'late' },
  TS2137: { layer: 'nsr', veh: 'ALL', tz: '24h' },
  TS189: { layer: 'nsr', veh: 'ALL', tz: '24h' },
  TS2140: { layer: 'nsr', veh: 'PLB', tz: 'late' },
  TS2141: { layer: 'nsr', veh: 'PLB', tz: 'late' },
  TS204: { layer: 'nsr', veh: 'PLB', tz: 'late' },
  TS2142: { layer: 'nsr', veh: 'PLB', tz: 'day' },
  TS2143: { layer: 'nsr', veh: 'PLB', tz: 'day' },
  TS200: { layer: 'nsr', veh: 'PLB', tz: 'day' },
  TS2146: { layer: 'nsr', veh: 'PLB', tz: '24h' },
  TS2147: { layer: 'nsr', veh: 'PLB', tz: '24h' },
  TS205: { layer: 'nsr', veh: 'PLB', tz: '24h' },
  TS2149: { layer: 'nsr', veh: 'GV', tz: 'late' },
  TS2150: { layer: 'nsr', veh: 'GV', tz: 'late' },
  TS2151: { layer: 'nsr', veh: 'GV', tz: 'day' },
  TS2152: { layer: 'nsr', veh: 'GV', tz: 'day' },
  TS2153: { layer: 'nsr', veh: 'GV', tz: 'other' },
  TS2154: { layer: 'nsr', veh: 'GV', tz: 'other' },
  TS2155: { layer: 'nsr', veh: 'GV', tz: '24h' },
  TS2156: { layer: 'nsr', veh: 'GV', tz: '24h' },
  TS2158: { layer: 'nsr', veh: 'OTH', tz: 'late' },
  TS2159: { layer: 'nsr', veh: 'OTH', tz: 'late' },
  TS2160: { layer: 'nsr', veh: 'OTH', tz: 'day' },
  TS2161: { layer: 'nsr', veh: 'OTH', tz: 'day' },
  TS2164: { layer: 'nsr', veh: 'OTH', tz: '24h' },
  TS2165: { layer: 'nsr', veh: 'OTH', tz: '24h' }
}
export const SIGN_RULE_RADIUS_M = 15

// Does this rule feature carry what the link matches on? JS twin of
// TrafficMap's `ruleLinkFilter` (a MapLibre expression) — keep the two in step.
function ruleLinkMatches(link: SignRuleLink, layer: RuleLayer, p: Record<string, unknown>): boolean {
  if (link.layer !== layer) return false
  switch (link.layer) {
    case 'speed': return Number(p.speed) === link.speed
    case 'prohibition': return p.kind === link.kind
    case 'nsr': return p.veh === link.veh && p.tz === link.tz
    case 'buslane': return true
  }
}

// The reverse of SIGN_RULE_LINKS: every sign code that announces a rule like
// this one. Empty for a rule no plate is linked to (pedestrian zones, the
// unlinked prohibition kinds and no-stopping bands).
export const linkedSignCodes = (layer: RuleLayer, p: Record<string, unknown>) =>
  Object.entries(SIGN_RULE_LINKS).filter(([, link]) => ruleLinkMatches(link, layer, p)).map(([code]) => code)
// The same, per legend row key: every code linked to any rule the row draws
// (all speed values, every no-stopping band). Unlinked rows map to [].
export const ROW_SIGN_CODES: Record<string, string[]> = Object.fromEntries(RULE_ROWS.map(r => [
  r.key,
  Object.entries(SIGN_RULE_LINKS)
    .filter(([, link]) => rowKeyFor(link.layer, link.layer === 'prohibition' ? link.kind : null) === r.key)
    .map(([code]) => code)
]))
// The 50 km/h plate: the default limit, which TD's data does not draw.
export const DEFAULT_SPEED_CODES = new Set(['TS174'])

type Translate = (key: string, params?: Record<string, unknown>) => string
type Locale = 'en' | 'zh-HK'

// "OTH,PLB" → localised vehicle names; an unknown code shows verbatim. TD
// codes a learner-driver ban as `OTH` (the driver, not a vehicle class), so
// for a row whose title already names who is banned, `OTH` is dropped from
// the list — "Applies to: Other vehicles" under "Learner drivers prohibited"
// would contradict the title. The `other` kind keeps it: there it IS the info.
function vehicles(codes: unknown, t: Translate, dropOther = false) {
  const list = (str(codes)?.split(',').map(c => c.trim()).filter(Boolean) ?? [])
    .filter(c => !(dropOther && c === 'OTH'))
  return list.length ? list.map(c => t(`rules.veh.${c}`)).join(', ') : null
}

// TD's 8-flag day mask (Mon…Sun + public holidays, 'Y'/'N') → short summary.
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'ph']
function dayMask(mask: unknown, t: Translate) {
  const m = str(mask)
  if (!m || m.length !== 8) return null
  const on = [...m].map(c => c === 'Y')
  if (on.every(Boolean)) return t('rules.days.daily')
  const parts: string[] = []
  if (on.slice(0, 5).every(Boolean)) parts.push(t('rules.days.weekdays'))
  else parts.push(...DAY_KEYS.slice(0, 5).filter((_, i) => on[i]).map(k => t(`rules.days.${k}`)))
  parts.push(...DAY_KEYS.slice(5).filter((_, i) => on[5 + i]).map(k => t(`rules.days.${k}`)))
  return parts.join(', ') || null
}

// The popup rows for one rule feature — shared by the rule popup and the sign
// popup's "applies here" block so both read identically.
export function ruleRows(layer: RuleLayer, p: Record<string, unknown>, t: Translate, locale: Locale): [string, string][] {
  const pick = (zh: unknown, en: unknown) => locale === 'zh-HK' ? (str(zh) ?? str(en)) : (str(en) ?? str(zh))
  const street = pick(p.st_zh, p.st_en)
  const rows: [string, string | null][] = []
  if (layer === 'speed') {
    rows.push([t('rules.fields.speed'), p.speed != null ? t('rules.speedValue', { n: p.speed }) : null])
  } else if (layer === 'nsr') {
    rows.push([t('rules.fields.vehicles'), vehicles(p.veh, t)])
    rows.push([t('rules.fields.hours'), str(p.tz) ? t(`rules.nsrHours.${p.tz}`) : null])
    rows.push([t('rules.fields.days'), str(p.eday) ? t(`rules.nsrDays.${p.eday}`) : null])
  } else if (layer === 'cutoff') {
    rows.push([t('rules.fields.vehicles'), vehicles(p.veh, t)])
    rows.push([t('rules.fields.sealedBy'), pick(p.via_zh, p.via_en)])
    rows.push([t('rules.fields.areaLength'), p.area_m != null ? t('rules.kmValue', { n: (Number(p.area_m) / 1000).toFixed(1) }) : null])
  } else if (layer === 'buslane' || layer === 'pedzone') {
    rows.push([t('rules.fields.hours'), str(p.hours)])
    rows.push([t('rules.fields.days'), dayMask(p.days, t)])
  } else {
    rows.push([t('rules.fields.vehicles'), vehicles(p.inc, t, p.kind !== 'other')])
    rows.push([t('rules.fields.except'), vehicles(p.exc, t)])
    const when = [
      p.part_time ? t('rules.values.partTime') : null,
      p.all_days === false ? t('rules.values.notAllDays') : null
    ].filter(Boolean).join(' · ')
    rows.push([t('rules.fields.when'), when || null])
  }
  rows.push([t('rules.fields.street'), street])
  rows.push([t('rules.fields.remarks'), str(p.remarks)])
  return rows.filter((r): r is [string, string] => !!r[1])
}

// Popup title: the legend row's label (a prohibition names its kind). The PLB
// row is the exception — its label covers the cut-off band too, so a clicked
// line takes its own wording and still says which of the two it is.
export const ruleTitleKey = (layer: RuleLayer, p: Record<string, unknown>) => {
  if (layer !== 'prohibition') return `rules.popup.${layer}`
  const key = rowKeyFor(layer, str(p.kind))
  return key === 'plb' ? 'rules.popup.proh-plb' : `rules.rows.${key}`
}

export function useRoadRules() {
  return {
    rows: RULE_ROWS,
    rulesEnabled,
    anyRuleOn,
    enabledKinds,
    isRowEnabled,
    selectedRule,
    governingRule
  }
}
