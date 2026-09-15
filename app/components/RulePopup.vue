<script setup lang="ts">
import { ruleRows, ruleTitleKey, rowKeyFor, RULE_ROWS, SPEED_COLORS, NSR_VEH_COLORS, type NsrVehicle } from '~/composables/useRoadRules'
import { formatLngLat } from '~/utils/format'

// Detail card for a clicked rule line (speed limit / bus-only lane /
// prohibition / no stopping / pedestrian zone). Same slot as SignPopup — TrafficMap keeps at most one of
// `selectedSign` / `selectedRule` set, so the two never overlap.
const { selectedRule } = useRoadRules()
const { t, locale } = useI18n()

const rule = computed(() => selectedRule.value)

const title = computed(() => rule.value ? t(ruleTitleKey(rule.value.layer, rule.value.properties)) : '')

// Swatch: a speed limit takes its value's colour, a no-stopping line its
// vehicle type's, everything else its row's.
const color = computed(() => {
  const r = rule.value
  if (!r) return undefined
  const speed = Number(r.properties.speed)
  if (r.layer === 'speed' && SPEED_COLORS[speed]) return SPEED_COLORS[speed]
  const veh = r.properties.veh as NsrVehicle
  if (r.layer === 'nsr' && NSR_VEH_COLORS[veh]) return NSR_VEH_COLORS[veh]
  const kind = typeof r.properties.kind === 'string' ? r.properties.kind : null
  return RULE_ROWS.find(row => row.key === rowKeyFor(r.layer, kind))?.color
})

const rows = computed(() =>
  rule.value ? ruleRows(rule.value.layer, rule.value.properties, t, locale.value) : []
)

const coords = computed(() => rule.value ? formatLngLat(rule.value.lngLat) : '')
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
            {{ $t('rules.source') }}
          </p>
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

    <p class="text-xs text-muted">
      {{ coords }}
    </p>
  </UCard>
</template>
