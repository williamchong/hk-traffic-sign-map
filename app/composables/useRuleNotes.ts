import type { ExpressionSpecification, FilterSpecification } from 'maplibre-gl'
import notesData from '~/data/ruleNotes.json'
import { useRoadRules, type ProhibitionKind, type RuleLayer } from '~/composables/useRoadRules'

// Curated annotations on the road-rules overlay: what TD's data says vs what
// actually applies on the ground. The overlay's extents are TD's own and are
// drawn verbatim (CLAUDE.md, "Rule extents come from the IRNP layers"), which
// is right — but a rule can be relaxed by an arrangement that lives in a press
// release and in NO field of the dataset, and then the map states the ban
// without the exception. A note says so in place, rather than silently bending
// the data to match.
//
// The notes live in app/data/ruleNotes.json, edited INDEPENDENTLY — no tile
// rebuild, no pipeline re-run — exactly like the curated signDescriptions.json
// the sign popups prefer over the extracted catalogue. Their prose is in that
// file rather than i18n because it is content, not UI chrome: one note is one
// bilingual record that a reviewer reads and edits as a unit.

export interface NoteText { en: string, zh?: string }

// Which rule features a note is about. Declarative (not a raw MapLibre
// filter) so the SAME clause compiles to both a map filter, for the
// highlight, and a JS predicate, for "does this clicked line have a note?" —
// the ruleLinkFilter / ruleLinkMatches pattern in useRoadRules. Fields are
// ANDed; `st` matches the feature's street exactly, `via` matches a substring
// of the cut-off band's comma-joined sealing streets.
export interface NoteCover {
  layer: RuleLayer
  kind?: ProhibitionKind
  st?: string[]
  via?: string[]
}

export interface RuleNote {
  id: string
  icon: 'info' | 'warning'
  // Legend row keys the note belongs to: its pins show only while one of them
  // is on, so a note about minibus bans doesn't float over an overlay the
  // reader has turned off.
  rows: string[]
  // One pin per position — a designated route can run for kilometres, so a
  // single marker would sit nowhere near most of what the note covers.
  at: [number, number][]
  title: NoteText
  body: NoteText
  source?: { label: NoteText, url: string }
  covers: NoteCover[]
}

export const RULE_NOTES = notesData as RuleNote[]
export const NOTE_SOURCE = 'rule-notes'
export const NOTE_LAYER = 'rule-note'
// Only the source-layers some note actually covers get a highlight layer —
// no dead line layers on a source whose tiles every visitor loads.
export const NOTE_COVER_LAYERS = [...new Set(RULE_NOTES.flatMap(n => n.covers.map(c => c.layer)))]

const asExpr = (e: unknown) => e as ExpressionSpecification

// A filter that matches nothing, for a highlight layer with no note active.
// `boolean` rather than `literal`, which the style spec defines for arrays and
// objects — the validator is entitled to reject a boolean there.
export const NOTE_FILTER_NONE = asExpr(['boolean', false]) as FilterSpecification

// MapLibre filter for a set of cover clauses on ONE source-layer. `to-string`
// guards the null property: `in` wants a string on both sides, and a cut-off
// band with no sealing street would otherwise throw rather than just miss.
export const coversFilter = (covers: NoteCover[]): FilterSpecification => asExpr([
  'any',
  ...covers.map((c) => {
    const clauses: unknown[] = []
    if (c.kind) clauses.push(['==', ['get', 'kind'], c.kind])
    if (c.st) clauses.push(['in', ['to-string', ['get', 'st_en']], ['literal', c.st]])
    if (c.via) clauses.push(['any', ...c.via.map(v => ['in', v, ['to-string', ['get', 'via_en']]])])
    return clauses.length ? ['all', ...clauses] : ['boolean', true]
  })
])

// JS twin of coversFilter for one clause — keep the two in step.
function coverMatches(c: NoteCover, layer: RuleLayer, p: Record<string, unknown>): boolean {
  if (c.layer !== layer) return false
  if (c.kind && p.kind !== c.kind) return false
  if (c.st && !c.st.includes(String(p.st_en ?? ''))) return false
  if (c.via && !c.via.some(v => String(p.via_en ?? '').includes(v))) return false
  return true
}

// Every note that speaks to this rule feature — so a clicked line carries its
// own caveat, not just the pin next to it.
export const notesFor = (layer: RuleLayer, p: Record<string, unknown>) =>
  RULE_NOTES.filter(n => n.covers.some(c => coverMatches(c, layer, p)))

export const noteText = (text: NoteText, locale: 'en' | 'zh-HK') =>
  locale === 'zh-HK' ? (text.zh ?? text.en) : text.en

// A pin the reader clicked. Cleared whenever a sign or a rule is picked —
// one card at a time, as with selectedSign / selectedRule.
const selectedNote = ref<RuleNote | null>(null)
const { selectedRule } = useRoadRules()
// What the highlight draws: the clicked pin, else the notes covering the
// clicked rule line. So "click the pin" and "click the segment" light up the
// same roads and show the same words, which is the point of the feature.
// Module scope, like useRoadRules' anyRuleOn and useTrafficLayers' mapFilter:
// every caller shares the one computed rather than building its own.
const activeNotes = computed<RuleNote[]>(() => {
  if (selectedNote.value) return [selectedNote.value]
  const rule = selectedRule.value
  return rule ? notesFor(rule.layer, rule.properties) : []
})

export function useRuleNotes() {
  return { selectedNote, activeNotes }
}
