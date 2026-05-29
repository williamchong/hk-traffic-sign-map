<script setup lang="ts">
import { useVirtualList } from '@vueuse/core'
import {
  SIGN_GROUPS,
  type SignGroup
} from '~/composables/useSignCatalogue'
import { categoryColor } from '~/composables/useSignCategories'
import { SIGN_SEARCH_TOTAL, useSignSearch } from '~/composables/useSignSearch'

const { enabledSignIds, selectSign } = useTrafficLayers()
const { t, locale } = useI18n()
const { track } = useAnalytics()

// Category facet chips: a multi-select narrowing the search pool BEFORE the
// substring matcher runs. Only the five Index-Plan groups are searchable
// (those are the only codes in the catalogue); 'tourist' / 'other-traffic'
// have no SIGNID-level data to search.
const activeGroups = ref<SignGroup[]>([])
const groupFilter = computed<readonly SignGroup[] | null>(() =>
  activeGroups.value.length ? activeGroups.value : null
)

const { query, matches } = useSignSearch({ groupFilter, locale })

// useVirtualList keeps DOM size constant regardless of how many codes match —
// at 769 rows with thumbnails it'd be ~60 MB of decoded images otherwise.
const ITEM_HEIGHT = 44
const { list: virtualMatches, containerProps, wrapperProps } = useVirtualList(matches, {
  itemHeight: ITEM_HEIGHT,
  overscan: 6
})

// True when every visible match is selected — flips the bulk button between
// "Select all matches" and "Deselect all matches".
const allMatchesSelected = computed(() =>
  matches.value.length > 0 && matches.value.every(m => enabledSignIds.has(m.id))
)

function onToggleSign(id: string, value: boolean) {
  if (value) selectSign(id)
  else enabledSignIds.delete(id)
  track('filter_signid_toggle', { sign_id: id, enabled: value })
}

function onBulkApplyMatches() {
  const next = !allMatchesSelected.value
  for (const m of matches.value) {
    if (next) enabledSignIds.add(m.id)
    else enabledSignIds.delete(m.id)
  }
  track('filter_signid_bulk', { count: matches.value.length, enabled: next })
}

function onClearAll() {
  if (enabledSignIds.size === 0) return
  enabledSignIds.clear()
  track('filter_signid_clear')
}

function onToggleGroup(group: SignGroup) {
  const idx = activeGroups.value.indexOf(group)
  if (idx >= 0) activeGroups.value.splice(idx, 1)
  else activeGroups.value.push(group)
}

function isGroupActive(group: SignGroup) {
  return activeGroups.value.includes(group)
}

// Persistent allowlist drawn as chips above the result list. Survives the
// search filter — clearing the query doesn't drop them.
const selectedList = computed(() =>
  enabledSignIds.size ? Array.from(enabledSignIds).sort() : []
)
</script>

<template>
  <div class="space-y-2">
    <UInput
      v-model="query"
      icon="i-lucide-search"
      size="sm"
      :placeholder="t('panel.signSearch.placeholder', { total: SIGN_SEARCH_TOTAL })"
      :aria-label="t('panel.signSearch.placeholder', { total: SIGN_SEARCH_TOTAL })"
      class="w-full"
    />

    <!-- Category facet chips. Toggle-on narrows the search pool; none active
         = all five groups in scope. Coloured dot mirrors the legend in the
         category tab so the visual identity carries across. -->
    <div class="flex flex-wrap gap-1">
      <button
        v-for="g in SIGN_GROUPS"
        :key="g"
        type="button"
        class="flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors"
        :class="isGroupActive(g)
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-default text-muted hover:text-default'"
        :aria-pressed="isGroupActive(g)"
        @click="onToggleGroup(g)"
      >
        <span
          class="size-2 rounded-full"
          :style="{ backgroundColor: categoryColor(g) }"
        />
        {{ t(`categories.${g}`) }}
      </button>
    </div>

    <div class="flex items-center justify-between text-xs text-muted">
      <span>
        {{ t('panel.signSearch.matchCount', { n: matches.length }) }}
        <span
          v-if="enabledSignIds.size > 0"
          class="ml-1"
        >
          · {{ t('panel.signSearch.selectedCount', { n: enabledSignIds.size }) }}
        </span>
      </span>
      <div class="flex items-center gap-2">
        <UButton
          v-if="matches.length > 0"
          size="xs"
          variant="link"
          :label="allMatchesSelected ? t('panel.signSearch.deselectMatches') : t('panel.signSearch.selectMatches')"
          @click="onBulkApplyMatches"
        />
        <UButton
          v-if="enabledSignIds.size > 0"
          size="xs"
          variant="link"
          color="neutral"
          :label="t('panel.signSearch.clearAll')"
          @click="onClearAll"
        />
      </div>
    </div>

    <div
      v-if="selectedList.length"
      class="flex flex-wrap gap-1 border-b border-default pb-2"
    >
      <span
        v-for="id in selectedList"
        :key="id"
        class="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
      >
        {{ id }}
        <button
          type="button"
          class="cursor-pointer text-primary/70 hover:text-primary"
          :aria-label="t('panel.signSearch.removeChip', { id })"
          @click="onToggleSign(id, false)"
        >
          <UIcon
            name="i-lucide-x"
            class="size-3"
          />
        </button>
      </span>
    </div>

    <HiddenSignsRow />

    <div
      v-bind="containerProps"
      class="h-72 overflow-y-auto rounded-md border border-default"
    >
      <div v-bind="wrapperProps">
        <label
          v-for="row in virtualMatches"
          :key="row.data.id"
          class="flex cursor-pointer items-center gap-2 px-2 text-sm hover:bg-elevated"
          :style="{ height: `${ITEM_HEIGHT}px` }"
        >
          <UCheckbox
            :model-value="enabledSignIds.has(row.data.id)"
            @update:model-value="v => onToggleSign(row.data.id, !!v)"
          />
          <!-- Every INDEX entry is catalogued by construction (the search
               iterates `codesByGroup`), so `iconUrl` is always present and
               we don't need a coloured-dot fallback here. -->
          <img
            :src="row.data.iconUrl"
            :alt="row.data.id"
            class="size-7 shrink-0 object-contain"
            loading="lazy"
          >
          <span class="flex min-w-0 flex-col leading-tight">
            <span class="truncate font-medium">{{ row.data.id }}</span>
            <span
              v-if="row.data.description"
              class="truncate text-xs text-muted"
            >
              {{ row.data.description }}
            </span>
          </span>
        </label>
      </div>
      <p
        v-if="matches.length === 0"
        class="p-3 text-center text-xs text-muted"
      >
        {{ t('panel.signSearch.noMatches') }}
      </p>
    </div>
  </div>
</template>
