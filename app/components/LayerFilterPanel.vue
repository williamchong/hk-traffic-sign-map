<script setup lang="ts">
const { categories, enabled, toggleAll } = useTrafficLayers()

const allOn = computed(() => categories.every(c => enabled[c.key]))

// View-only: folds the list to shrink the panel. Not in useTrafficLayers
// because it doesn't touch the map filter; checkbox state lives there.
const expanded = ref(true)
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
      <div class="flex items-center gap-0.5">
        <!-- Client-only + Lazy: the modal's Dialog/Tabs runtime stays out
             of the prerendered homepage and its preloaded chunks. Safe —
             the SEO/crawl path is the nav links below, not this button,
             and the map itself is already client-only. -->
        <ClientOnly>
          <LazyInfoButton />
        </ClientOnly>
        <ThemeCycleButton />
      </div>
    </div>

    <div class="flex items-center justify-between">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-1 text-xs font-medium text-muted"
        :aria-expanded="expanded"
        aria-controls="category-list"
        @click="expanded = !expanded"
      >
        <UIcon
          :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-3"
        />
        Categories
      </button>
      <UButton
        v-if="expanded"
        size="xs"
        variant="link"
        :label="allOn ? 'Hide all' : 'Show all'"
        @click="toggleAll(!allOn)"
      />
    </div>

    <div
      v-show="expanded"
      id="category-list"
      class="space-y-2"
    >
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

    <!-- Always rendered (not folded) so these stay real <a> tags in the
         prerendered index.html — the crawlable path to the SEO pages. -->
    <nav class="flex gap-x-3 border-t border-default pt-2 text-xs text-muted">
      <NuxtLink
        to="/about"
        class="hover:text-default"
      >
        About
      </NuxtLink>
      <NuxtLink
        to="/faq"
        class="hover:text-default"
      >
        FAQ &amp; guide
      </NuxtLink>
    </nav>
  </UCard>
</template>
