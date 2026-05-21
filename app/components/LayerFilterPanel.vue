<script setup lang="ts">
import type { VisibleCategoryKey } from '~/composables/useSignCategories'
import type { FilterMode } from '~/composables/useTrafficLayers'

const { categories, enabled, toggleAll, mapUnavailable, filterMode } = useTrafficLayers()
const localePath = useLocalePath()
const { track } = useAnalytics()
const { t } = useI18n()

const allOn = computed(() => categories.every(c => enabled[c.key]))

// Tabs are label-only — icons added visual noise in a 288px-wide panel
// without aiding recognition; the labels are short and self-explanatory.
const tabItems = computed(() => [
  { value: 'category' as const, label: t('panel.tabs.category') },
  { value: 'sign-id' as const, label: t('panel.tabs.signId') }
])

function onCategoryToggle(key: VisibleCategoryKey, value: boolean) {
  enabled[key] = value
  track('filter_category_toggle', { category: key, enabled: value })
}

function onToggleAll() {
  const next = !allOn.value
  toggleAll(next)
  track('filter_toggle_all', { enabled: next })
}

// UTabs only emits update:model-value on real change, so no need to
// short-circuit unchanged values here.
function onTabChange(value: string | number) {
  const next = value as FilterMode
  filterMode.value = next
  track('filter_mode_switch', { mode: next })
}
</script>

<template>
  <UCard
    class="absolute left-4 top-4 z-10 w-72 max-w-[calc(100vw-2rem)]"
    :ui="{ body: 'p-4 sm:p-4 space-y-2' }"
  >
    <!-- Header is two rows so the title and subtitle each get the full
         panel width (no wrap), with the button cluster right-aligned below.
         The previous single-row layout squeezed the title into ~140px and
         forced both lines to wrap. -->
    <div class="space-y-1">
      <h1 class="text-base font-semibold">
        {{ $t('panel.title') }}
      </h1>
      <div class="flex items-center justify-between gap-2">
        <p class="truncate text-xs text-muted">
          {{ $t('panel.subtitle') }}
        </p>
        <div class="flex shrink-0 items-center gap-0.5">
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
    </div>

    <!-- The filter only acts on the map, so it's dropped when WebGL is
         unavailable — but the header above and the About/FAQ nav below
         stay (both work without WebGL, and the nav is the SEO/crawl path). -->
    <template v-if="!mapUnavailable">
      <UTabs
        :items="tabItems"
        :model-value="filterMode"
        size="xs"
        variant="link"
        :ui="{ list: 'border-default' }"
        @update:model-value="onTabChange"
      />

      <!-- Category tab: the tabs themselves label the section, so the old
           "Categories ⌄ Hide all" header row is redundant. We keep just the
           hide/show-all link as a small right-aligned action above the list. -->
      <div
        v-if="filterMode === 'category'"
        class="space-y-2"
      >
        <div class="flex justify-end">
          <UButton
            size="xs"
            variant="link"
            :padded="false"
            :label="allOn ? $t('panel.hideAll') : $t('panel.showAll')"
            @click="onToggleAll"
          />
        </div>
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

      <!-- ClientOnly: useVirtualList touches `window` at setup time and the
           index pulls in JSON that's only useful interactively. Keeps the
           prerendered HTML free of search UI it can't use. -->
      <ClientOnly v-if="filterMode === 'sign-id'">
        <LazySignIdFilterPanel />
      </ClientOnly>
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
