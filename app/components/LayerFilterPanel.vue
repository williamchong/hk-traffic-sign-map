<script setup lang="ts">
const { categories, enabled, toggleAll } = useTrafficLayers()

const allOn = computed(() => categories.every(c => enabled[c.key]))
</script>

<template>
  <UCard
    class="absolute left-4 top-4 z-10 w-72 max-w-[calc(100vw-2rem)]"
    :ui="{ body: 'p-4 sm:p-4 space-y-3' }"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="space-y-1">
        <h1 class="text-base font-semibold">
          HK Traffic Signs
        </h1>
        <p class="text-xs text-muted">
          Transport Department open data
        </p>
      </div>
      <ThemeCycleButton />
    </div>

    <div class="flex items-center justify-between">
      <span class="text-xs font-medium text-muted">Categories</span>
      <UButton
        size="xs"
        variant="link"
        :label="allOn ? 'Hide all' : 'Show all'"
        @click="toggleAll(!allOn)"
      />
    </div>

    <div class="space-y-2">
      <label
        v-for="c in categories"
        :key="c.key"
        class="flex cursor-pointer items-center gap-2 text-sm"
      >
        <UCheckbox v-model="enabled[c.key]" />
        <span
          class="size-3 shrink-0 rounded-full"
          :style="{ backgroundColor: c.color }"
        />
        <span class="truncate">{{ c.label }}</span>
      </label>
    </div>
  </UCard>
</template>
