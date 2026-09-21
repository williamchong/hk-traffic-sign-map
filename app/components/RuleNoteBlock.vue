<script setup lang="ts">
import { noteText, type RuleNote } from '~/composables/useRuleNotes'

// One curated caveat about a rule extent, rendered identically wherever it
// appears: standing alone when its pin is clicked (RuleNotePopup), and inset
// in the rule card when the segment itself is clicked (RulePopup). The two
// entry points must read the same — that is what makes the pin and the line
// feel like one annotation rather than two features.
const props = defineProps<{ note: RuleNote }>()
const { locale } = useI18n()

const title = computed(() => noteText(props.note.title, locale.value))
const body = computed(() => noteText(props.note.body, locale.value))
const source = computed(() =>
  props.note.source ? noteText(props.note.source.label, locale.value) : null
)
// Matches the map pin's glyph and hue (see the note badges in TrafficMap), so
// the card is recognisably the thing the reader clicked.
const icon = computed(() =>
  props.note.icon === 'warning' ? 'i-lucide-triangle-alert' : 'i-lucide-info'
)
const tone = computed(() =>
  props.note.icon === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'
)
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex items-start gap-2">
      <UIcon
        :name="icon"
        class="mt-0.5 size-4 shrink-0"
        :class="tone"
      />
      <p class="text-sm font-medium">
        {{ title }}
      </p>
    </div>
    <p class="text-xs leading-relaxed text-muted">
      {{ body }}
    </p>
    <a
      v-if="source && note.source"
      :href="note.source.url"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
    >
      <UIcon
        name="i-lucide-external-link"
        class="size-3 shrink-0"
      />
      {{ source }}
    </a>
  </div>
</template>
