<script setup lang="ts">
// Hidden codes (the denylist), shown in both filter tabs so a sign hidden from
// the detail panel is always visible and reversible regardless of which tab is
// open. Reads the singleton state directly — no props needed.
const { filterMode, enabledSignIds, hiddenSignIds, unhideSign } = useTrafficLayers()
const { t } = useI18n()
const { track } = useAnalytics()

const hiddenList = computed(() => Array.from(hiddenSignIds).sort())

// In the sign-ID tab with no positive picks the denylist is the whole filter,
// so it reads as "show all except these"; otherwise it's just a hidden count.
const label = computed(() =>
  filterMode.value === 'sign-id' && enabledSignIds.size === 0
    ? t('panel.signSearch.showingAllExcept', { n: hiddenList.value.length })
    : t('panel.signSearch.hiddenCount', { n: hiddenList.value.length })
)

function onUnhide(id: string) {
  unhideSign(id)
  track('filter_signid_unhide', { sign_id: id })
}
</script>

<template>
  <div
    v-if="hiddenList.length"
    class="space-y-1 border-b border-default pb-2"
  >
    <p class="flex items-center gap-1 text-xs text-muted">
      <UIcon
        name="i-lucide-eye-off"
        class="size-3"
      />
      {{ label }}
    </p>
    <div class="flex flex-wrap gap-1">
      <span
        v-for="id in hiddenList"
        :key="id"
        class="flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-xs text-muted line-through"
      >
        {{ id }}
        <button
          type="button"
          class="cursor-pointer text-muted hover:text-default"
          :aria-label="t('panel.signSearch.unhideChip', { id })"
          @click="onUnhide(id)"
        >
          <UIcon
            name="i-lucide-x"
            class="size-3 no-underline"
          />
        </button>
      </span>
    </div>
  </div>
</template>
