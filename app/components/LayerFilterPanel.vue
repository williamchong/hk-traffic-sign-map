<script setup lang="ts">
const { categories, enabled, toggleAll, mapUnavailable } = useTrafficLayers()
const localePath = useLocalePath()
const { track } = useAnalytics()

const allOn = computed(() => categories.every(c => enabled[c.key]))

// View-only: folds the list to shrink the panel. Not in useTrafficLayers
// because it doesn't touch the map filter; checkbox state lives there.
const expanded = ref(true)

function onCategoryToggle(key: string, value: boolean) {
  enabled[key] = value
  track('filter_category_toggle', { category: key, enabled: value })
}

function onToggleAll() {
  const next = !allOn.value
  toggleAll(next)
  track('filter_toggle_all', { enabled: next })
}
</script>

<template>
  <UCard
    class="absolute left-4 top-4 z-10 w-72 max-w-[calc(100vw-2rem)]"
    :ui="{ body: 'p-4 sm:p-4 space-y-3' }"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="space-y-1">
        <h1 class="text-base font-semibold">
          {{ $t('panel.title') }}
        </h1>
        <p class="text-xs text-muted">
          {{ $t('panel.subtitle') }}
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
        <LocaleSwitcher />
        <ThemeCycleButton />
      </div>
    </div>

    <!-- The category filter only acts on the map, so it's dropped when WebGL
         is unavailable — but the header above and the About/FAQ nav below
         stay (both work without WebGL, and the nav is the SEO/crawl path). -->
    <template v-if="!mapUnavailable">
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
          {{ $t('panel.categories') }}
        </button>
        <UButton
          v-if="expanded"
          size="xs"
          variant="link"
          :label="allOn ? $t('panel.hideAll') : $t('panel.showAll')"
          @click="onToggleAll"
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
          <UCheckbox
            :model-value="enabled[c.key]"
            @update:model-value="v => onCategoryToggle(c.key, !!v)"
          />
          <span
            class="size-3 shrink-0 rounded-full"
            :style="{ backgroundColor: c.color }"
          />
          <span class="truncate">{{ $t(`categories.${c.key}`) }}</span>
        </label>
      </div>
    </template>

    <!-- Always rendered (not folded) so these stay real <a> tags in the
         prerendered HTML — the crawlable path to the SEO pages. localePath
         keeps the link in the active locale (e.g. /zh-HK/about). -->
    <nav class="flex gap-x-3 border-t border-default pt-2 text-xs text-muted">
      <NuxtLink
        :to="localePath('/about')"
        class="hover:text-default"
      >
        {{ $t('nav.about') }}
      </NuxtLink>
      <NuxtLink
        :to="localePath('/faq')"
        class="hover:text-default"
      >
        {{ $t('nav.faqGuide') }}
      </NuxtLink>
    </nav>
  </UCard>
</template>
