<script setup lang="ts">
import { ruleRows, ruleTitleKey, rowKeyFor, rowValueOf, linkedSignCodes, ruleColor, SPEED_COLORS, NSR_VEH_COLORS, CUTOFF_COLOR, type NsrVehicle, type RuleLayer } from '~/composables/useRoadRules'
import { useRuleNotes } from '~/composables/useRuleNotes'
import { formatLngLat } from '~/utils/format'
import { tdTrafficNoticesUrl } from '~/utils/links'
import tilesVersion from '~/data/tilesVersion.json'

// Detail card for a clicked rule line (speed limit / bus-only lane /
// prohibition / no stopping / pedestrian zone). Same slot as SignPopup — TrafficMap keeps at most one of
// `selectedSign` / `selectedRule` set, so the two never overlap.
const { selectedRule } = useRoadRules()
// Curated caveats covering the clicked line. Read from the SAME `activeNotes`
// the map highlights from, rather than re-deriving them here, so the card and
// the highlighted segments can never disagree — a rule pick clears
// `selectedNote`, so while this card is open those notes are this line's.
const { activeNotes } = useRuleNotes()
const { addSigns, hasAllSigns } = useTrafficLayers()
const { t, locale } = useI18n()
const { track } = useAnalytics()

const rule = computed(() => selectedRule.value)

const title = computed(() => rule.value ? t(ruleTitleKey(rule.value.layer, rule.value.properties)) : '')

// Swatch: a speed limit takes its value's colour, a no-stopping line its
// vehicle type's, the cut-off band its own (it shares the PLB row, whose
// colour is the ban lines'), everything else its row's.
const color = computed(() => {
  const r = rule.value
  if (!r) return undefined
  const speed = Number(r.properties.speed)
  if (r.layer === 'speed' && SPEED_COLORS[speed]) return SPEED_COLORS[speed]
  const veh = r.properties.veh as NsrVehicle
  if (r.layer === 'nsr' && NSR_VEH_COLORS[veh]) return NSR_VEH_COLORS[veh]
  if (r.layer === 'cutoff') return CUTOFF_COLOR
  // A split layer resolves its row from its own property — `taxi` for a taxi
  // band, `kind` for a prohibition — via the same helper the map picks with.
  return ruleColor(rowKeyFor(r.layer, rowValueOf(r.layer, r.properties)))
})

const rows = computed(() =>
  rule.value ? ruleRows(rule.value.layer, rule.value.properties, t, locale.value) : []
)

const coords = computed(() => rule.value ? formatLngLat(rule.value.lngLat) : '')

// A ban the build added from a TD traffic notice rather than a road-network
// row (scripts/zone-overrides.mjs) carries the notice number; the source line
// then names the notice instead of the network, and links the notice feed.
const notice = computed(() => {
  const n = rule.value?.properties.notice
  return typeof n === 'string' ? n : null
})
const NOTICES_URL = 'https://data.gov.hk/en-data/dataset/hk-td-tis_22-traffic-notices'

// Where this reading comes from. Every layer but three is read straight off
// TD's road network; the cut-off band is worked out from it, and the taxi and
// expressway bands are curated from the law (Cap. 374E Sch. 7's list of
// permitted roads; the G.N. 8028/2018 designation) because no network layer
// carries them. Saying so is the point — a reader deserves to know which
// answers are TD's own geometry.
const SOURCE_KEY: Partial<Record<RuleLayer, string>> = {
  cutoff: 'rules.cutoffSource',
  taxi: 'rules.taxiSource',
  expressway: 'rules.expresswaySource'
}

// How old this reading is: the day TD's network was fetched for every layer
// read straight off it, the date of the source each curated layer was checked
// against, and the older of the two for the cut-off, which is derived from
// both. A notice-backed row has none — the notice is its date. Written by
// build-road-rules.mjs as YYYY-MM-DD, so formatted in UTC to stay that day.
const AS_OF: Record<string, string> = tilesVersion.rulesAsOf
const asOf = computed(() => {
  const r = rule.value
  if (!r || notice.value) return null
  const iso = AS_OF[r.layer in AS_OF ? r.layer : 'network']
  return iso ? new Date(iso).toLocaleDateString(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }) : null
})

// "Show signs for this rule": the plates that announce it, added to the
// sign-ID filter — the retain-all archive, so they are complete at every zoom
// (a category-mode emphasis would only reach the thinned overview's
// survivors). Narrower than the legend row's checkbox: a clicked 70 km/h line
// adds TS175 alone, where the row covers every speed value. No button when no
// plate is linked to the rule.
const signCodes = computed(() => rule.value ? linkedSignCodes(rule.value.layer, rule.value.properties) : [])
// Already among the picks — the button reflects it, as SignPopup's does.
// Containment, not equality: the filter is a union this is one member of.
const isShowingThese = computed(() => hasAllSigns(signCodes.value))

// No need to turn the row's lines on: this card only opens from a clicked
// line, and TrafficMap picks a rule only when `isRowEnabled` says its row is
// on — so the extent these plates announce is already drawn.
function onShowSigns() {
  if (!rule.value || !signCodes.value.length || isShowingThese.value) return
  addSigns(signCodes.value)
  track('filter_rule_signs', { layer: rule.value.layer, count: signCodes.value.length, from: 'popup' })
}
</script>

<template>
  <UCard
    v-if="rule"
    class="absolute bottom-8 left-4 z-10 w-72 max-w-[calc(100vw-2rem)]"
    :ui="{ body: 'p-4 sm:p-4 space-y-3' }"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 items-start gap-3">
        <span
          class="mt-1.5 h-1.5 w-6 shrink-0 rounded-full"
          :style="{ backgroundColor: color }"
        />
        <div class="min-w-0">
          <h2 class="truncate font-semibold">
            {{ title }}
          </h2>
          <p class="mt-0.5 text-xs text-muted">
            <a
              v-if="notice"
              :href="NOTICES_URL"
              target="_blank"
              rel="noopener"
              class="underline decoration-dotted underline-offset-2"
            >{{ $t('rules.noticeSource', { n: notice }) }}</a>
            <template v-else>
              {{ $t(SOURCE_KEY[rule.layer] ?? 'rules.source') }}
            </template>
          </p>
          <p
            v-if="asOf"
            class="text-xs text-dimmed"
          >
            {{ $t('rules.asOf', { date: asOf }) }}
          </p>
          <!-- Every reading can lag the road, and some are worked out rather
               than posted, so each card names the plates and TD's own notices
               as the authority. -->
          <i18n-t
            keypath="rules.verify"
            tag="p"
            scope="global"
            class="mt-1 text-xs text-muted"
          >
            <template #notices>
              <a
                :href="tdTrafficNoticesUrl(locale)"
                target="_blank"
                rel="noopener"
                class="underline decoration-dotted underline-offset-2"
              >{{ $t('rules.noticesLabel') }}</a>
            </template>
          </i18n-t>
        </div>
      </div>
      <UButton
        icon="i-lucide-x"
        size="xs"
        color="neutral"
        variant="ghost"
        :aria-label="$t('rules.close')"
        @click="selectedRule = null"
      />
    </div>

    <KeyValueRows :rows="rows" />

    <div
      v-for="note in activeNotes"
      :key="note.id"
      class="rounded-md border border-default bg-elevated/50 p-2.5"
    >
      <RuleNoteBlock :note="note" />
    </div>

    <UButton
      v-if="signCodes.length"
      size="xs"
      :variant="isShowingThese ? 'soft' : 'solid'"
      color="primary"
      block
      icon="i-lucide-filter"
      :label="t('rules.showSigns')"
      @click="onShowSigns"
    />

    <p class="text-xs text-muted">
      {{ coords }}
    </p>
  </UCard>
</template>
