import { useLocalStorage } from '@vueuse/core'
import type { LngLat } from 'maplibre-gl'
import { str } from '~/utils/format'

// Road-rules overlay state — where a speed limit, bus-only lane or vehicle
// prohibition applies. The extents are TD's Road Network v2 layers tiled by
// scripts/build-road-rules.mjs into public/data/road-rules.pmtiles; nothing
// is derived from sign points (see CLAUDE.md, pipeline step 5). Singleton
// module state like useTrafficLayers, shared by the panel, the map and the
// popups.

// tippecanoe source-layer names in the archive — RDNET_RULE_LAYERS keys and
// PROHIBITION_KINDS in scripts/sign-layers.mjs, duplicated per the
// two-runtime rule.
export type RuleLayer = 'speed' | 'buslane' | 'prohibition'
export type ProhibitionKind = 'plb' | 'ld' | 'gv' | 'all' | 'other'
export const RULE_SOURCE = 'rules'

export interface RuleRow {
  // Legend row + localStorage key; `rules.rows.<key>` is its label.
  key: string
  layer: RuleLayer
  // Prohibition rows are one source-layer split by `kind`.
  kind?: ProhibitionKind
  color: string
}

// Legend order. Colours are hex literals so the same value feeds the legend
// swatch (inline style) and the MapLibre `line-color` expression; mid-tones
// that read on both the light OSM and the dark CARTO basemap (no near-black).
// Bus lanes are blue like their plates; prohibitions are dashed on the map,
// so a hue shared with a speed value doesn't confuse.
export const RULE_ROWS: RuleRow[] = [
  { key: 'speed', layer: 'speed', color: '#f59e0b' },
  { key: 'buslane', layer: 'buslane', color: '#2563eb' },
  { key: 'proh-plb', layer: 'prohibition', kind: 'plb', color: '#0d9488' },
  { key: 'proh-ld', layer: 'prohibition', kind: 'ld', color: '#7c3aed' },
  { key: 'proh-gv', layer: 'prohibition', kind: 'gv', color: '#b45309' },
  { key: 'proh-all', layer: 'prohibition', kind: 'all', color: '#e11d48' },
  { key: 'proh-other', layer: 'prohibition', kind: 'other', color: '#64748b' }
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
export const prohibitionColorStops = RULE_ROWS.filter(r => r.kind).flatMap(r => [r.kind!, r.color])

export const rowKeyFor = (layer: RuleLayer, kind?: string | null) =>
  layer === 'prohibition' ? `proh-${kind ?? 'other'}` : layer

// Off by default — the overlay is an opt-in reading of the map — and
// persisted, unlike the category toggles: someone who turned on speed limits
// wants them back on the next visit. `mergeDefaults` so a row added later
// starts off instead of undefined.
const rulesEnabled = useLocalStorage<Record<string, boolean>>(
  'hk-signs:road-rules',
  Object.fromEntries(RULE_ROWS.map(r => [r.key, false])),
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
export interface SignRuleLink {
  layer: RuleLayer
  speed?: number
  kind?: ProhibitionKind
}
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
  TS130: { layer: 'prohibition', kind: 'ld' }
}
export const SIGN_RULE_RADIUS_M = 15
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
  const street = locale === 'zh-HK' ? (str(p.st_zh) ?? str(p.st_en)) : (str(p.st_en) ?? str(p.st_zh))
  const rows: [string, string | null][] = []
  if (layer === 'speed') {
    rows.push([t('rules.fields.speed'), p.speed != null ? t('rules.speedValue', { n: p.speed }) : null])
  } else if (layer === 'buslane') {
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

// Popup title: the legend row's label (a prohibition names its kind).
export const ruleTitleKey = (layer: RuleLayer, p: Record<string, unknown>) =>
  layer === 'prohibition' ? `rules.rows.${rowKeyFor(layer, str(p.kind))}` : `rules.popup.${layer}`

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
