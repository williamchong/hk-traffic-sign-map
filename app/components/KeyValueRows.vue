<script setup lang="ts">
// The label/value definition list the sign and rule popups share. `truncate`
// clips long values to one line (the sign popup's ids); a rule's remarks are
// left to wrap.
defineProps<{
  rows: [string, string][]
  dense?: boolean
  truncate?: boolean
}>()
</script>

<template>
  <dl
    class="grid grid-cols-[auto_1fr] gap-x-3 text-sm"
    :class="dense ? 'gap-y-0.5' : 'gap-y-1'"
  >
    <template
      v-for="[label, value] in rows"
      :key="label"
    >
      <dt class="text-muted">
        {{ label }}
      </dt>
      <dd
        class="text-right"
        :class="{ truncate }"
      >
        {{ value }}
      </dd>
    </template>
  </dl>
</template>
