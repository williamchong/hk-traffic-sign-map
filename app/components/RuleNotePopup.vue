<script setup lang="ts">
import { useRuleNotes } from '~/composables/useRuleNotes'

// The card for a clicked note pin. Shares the popup slot with SignPopup and
// RulePopup — TrafficMap keeps at most one of the three selections set, so
// they never stack.
const { selectedNote } = useRuleNotes()
</script>

<template>
  <UCard
    v-if="selectedNote"
    class="absolute bottom-8 left-4 z-10 w-72 max-w-[calc(100vw-2rem)]"
    :ui="{ body: 'p-4 sm:p-4 space-y-3' }"
  >
    <div class="flex items-start justify-between gap-2">
      <RuleNoteBlock :note="selectedNote" />
      <UButton
        icon="i-lucide-x"
        size="xs"
        color="neutral"
        variant="ghost"
        :aria-label="$t('rules.close')"
        @click="selectedNote = null"
      />
    </div>
  </UCard>
</template>
