<script setup lang="ts">
import type { VisibleCategoryKey } from '~/composables/useSignCategories'
import { DEFAULT_FILTER_MODE, type FilterMode } from '~/composables/useTrafficLayers'

const { categories, enabled, toggleAll, mapUnavailable, filterMode } = useTrafficLayers()
const localePath = useLocalePath()
const { track } = useAnalytics()
const { t } = useI18n()

const allOn = computed(() => categories.every(c => enabled[c.key]))

// Hydration-safe mirror of `filterMode` that the whole panel UI binds to.
// `filterMode` is a module-scope useLocalStorage, so on the client it already
// holds its persisted value before this prerendered panel hydrates. Vue only
// *patches* attribute bindings (the UTabs active indicator's data-state /
// aria-selected) on a reactive change after mount — during hydration it trusts
// the SSR DOM as-is. So binding the tabs straight to filterMode fires no
// post-hydration change and leaves the prerendered default indicator stuck.
// Seeding with the SSR default and syncing from filterMode after mount makes
// that assignment the change that patches the indicator (and the v-if body).
const tabMode = ref<FilterMode>(DEFAULT_FILTER_MODE)
onMounted(() => {
  tabMode.value = filterMode.value
})
watch(filterMode, (v) => {
  tabMode.value = v
})

// View-only: folds the whole filter body (tabs + active tab) away so the
// panel shrinks to just its header + nav — essential on mobile, where the
// sign-id tab's tall result list otherwise covers most of the viewport.
// Not in useTrafficLayers because it doesn't touch the map filter.
const expanded = ref(true)

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
      <div class="flex items-start justify-between gap-2">
        <h1 class="text-base font-semibold">
          {{ $t('panel.title') }}
        </h1>
        <!-- Fold toggle, top-right corner. Only meaningful when there's a
             filter body to fold, so it's hidden alongside it when WebGL is
             unavailable. -->
        <button
          v-if="!mapUnavailable"
          type="button"
          class="-m-1 shrink-0 cursor-pointer p-1 text-muted hover:text-default"
          :aria-expanded="expanded"
          aria-controls="filter-body"
          :aria-label="expanded ? $t('panel.collapse') : $t('panel.expand')"
          :title="expanded ? $t('panel.collapse') : $t('panel.expand')"
          @click="expanded = !expanded"
        >
          <UIcon
            :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            class="size-4"
          />
        </button>
      </div>
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
      <!-- v-show (not v-if) so the tab/search state is preserved across a
           fold; id is referenced by the header toggle's aria-controls. -->
      <div
        v-show="expanded"
        id="filter-body"
        class="space-y-2"
      >
        <UTabs
          :items="tabItems"
          :model-value="tabMode"
          size="xs"
          variant="link"
          :ui="{ list: 'border-default' }"
          @update:model-value="onTabChange"
        />

        <!-- Category tab: the tabs themselves label the section, so the old
             "Categories ⌄ Hide all" header row is redundant. We keep just the
             hide/show-all link as a small right-aligned action above the list. -->
        <div
          v-if="tabMode === 'category'"
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
          <HiddenSignsRow />
        </div>

        <!-- ClientOnly: useVirtualList touches `window` at setup time and the
             index pulls in JSON that's only useful interactively. Keeps the
             prerendered HTML free of search UI it can't use. -->
        <ClientOnly v-if="tabMode === 'sign-id'">
          <LazySignIdFilterPanel />
        </ClientOnly>
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
