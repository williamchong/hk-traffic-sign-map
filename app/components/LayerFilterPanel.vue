<script setup lang="ts">
import type { VisibleCategoryKey } from '~/composables/useSignCategories'
import { DEFAULT_FILTER_MODE, type FilterMode } from '~/composables/useTrafficLayers'
import { SPEED_VALUES, SPEED_COLORS, NSR_VEH_VALUES, NSR_VEH_COLORS, ROW_SIGN_CODES, CUTOFF_COLOR, TAXI_CHIP_ACCESS, ruleColor } from '~/composables/useRoadRules'

const { categories, enabled, toggleAll, mapUnavailable, filterMode, addSigns, removeSigns } = useTrafficLayers()
const { rows: ruleRows, rulesEnabled, anyRuleOn } = useRoadRules()
const localePath = useLocalePath()
const { track } = useAnalytics()
const { t } = useI18n()

const allOn = computed(() => categories.every(c => enabled[c.key]))

// The road-rules section sits under both filter tabs: its lines are an
// overlay, drawn whichever tab is active, and ticking a row also filters the
// signs to the plates that announce it (see `onRuleToggle`). Unfolded on
// desktop (Tailwind `md`+),
// where the panel has room for the legend; on a phone folded unless something
// is already on — set after mount, since `rulesEnabled` is localStorage-backed
// and the viewport is unknown to the prerender (see the hydration note on
// `tabMode` below; the section renders client-only for the same reason).
const rulesOpen = ref(false)

// View-only fold of the whole filter body (tabs + active tab), down to header
// + nav — on a phone the open card covers most of the map. Same screen-size
// default as `rulesOpen`. Not in useTrafficLayers: it doesn't touch the map filter.
const expanded = ref(false)

onMounted(() => {
  const desktop = window.matchMedia('(min-width: 768px)').matches
  expanded.value = desktop
  rulesOpen.value = anyRuleOn.value || desktop
})

// Legend chips for a row that draws more than ONE reading — by colour for
// speed limits (km/h) and no-stopping (vehicle type), by source-layer for the
// PLB row (TD's ban lines and the cut-off band behind them), and by `access`
// for the NT taxi row, whose three readings share one hue and differ only in
// width. `ink` overrides the chip's white text where the colour is too light.
const ruleChips = computed<Record<string, { label: string, color: string, ink?: string }[]>>(() => ({
  'speed': SPEED_VALUES.map(v => ({ label: String(v), color: SPEED_COLORS[v]! })),
  'nsr': NSR_VEH_VALUES.map(v => ({ label: t(`rules.veh.${v}`), color: NSR_VEH_COLORS[v] })),
  'plb': [
    { label: t('rules.chips.plbBan'), color: ruleColor('plb') },
    { label: t('rules.chips.plbCutoff'), color: CUTOFF_COLOR, ink: '#134e4a' }
  ],
  // The NT row draws three readings of one colour: its operating area, the
  // fringe facilities TD lets it serve, and the designated through-routes
  // between them. One hue, three widths on the map — so the chips carry the
  // wording rather than a colour scale, and only the row that has all three
  // needs them (Lantau has only an area, urban only its exclusions).
  'taxi-nt': TAXI_CHIP_ACCESS.map(a => ({
    label: t(`rules.taxiAccess.${a}`), color: ruleColor('taxi-nt')
  }))
}))

// A rule row means "draw this reading, and show the plates that announce it":
// its codes join the sign-ID allowlist, which is an OR, so several rows read
// as a union. Add/remove rather than replace, so a row can join or leave a
// hand-picked filter without clearing it, and an untick is the same gesture
// undone. Driven from here — the only user write path into `rulesEnabled` —
// rather than a watcher, which would also fire on `mergeDefaults` writing a
// newly-added row key and on mount, where the `plb` default-on row would
// filter a first visit down to its two plates.
function onRuleToggle(key: string, value: boolean) {
  rulesEnabled.value[key] = value
  // ONLY this row's codes, never a recompute over every row that is on. That
  // recompute was tried and reverted: `plb` starts on and so never fires this
  // handler, so it folded TS119/TS522 in on the first tick of ANY other row —
  // which both expanded the filter the user did not ask about (ticking bus
  // lanes added speed plates) and broke the undo, since unticking their one
  // row then left plb's two plates instead of every sign. Per-row keeps each
  // gesture to its own plates and makes the untick land back where it started;
  // the cost is that a row already on contributes nothing until toggled, which
  // is what the user asked for and nothing worse.
  const codes = ROW_SIGN_CODES[key]!
  if (codes.length) {
    if (value) addSigns(codes)
    else removeSigns(codes)
  }
  track('rule_layer_toggle', { layer: key, enabled: value, signs: codes.length })
}

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
    class="absolute left-4 top-4 z-10 max-h-[calc(100dvh-2rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
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

        <!-- Road-rules overlay legend: shown under BOTH tabs. Client-only
             because its toggles read localStorage, which the prerendered
             HTML can't know. -->
        <ClientOnly>
          <div class="border-t border-default pt-2">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-medium text-muted">
                {{ $t('rules.title') }}
              </p>
              <button
                type="button"
                class="-m-1 shrink-0 cursor-pointer p-1 text-muted hover:text-default"
                :aria-expanded="rulesOpen"
                aria-controls="rules-body"
                :aria-label="rulesOpen ? $t('rules.collapse') : $t('rules.expand')"
                :title="rulesOpen ? $t('rules.collapse') : $t('rules.expand')"
                @click="rulesOpen = !rulesOpen"
              >
                <UIcon
                  :name="rulesOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                  class="size-4"
                />
              </button>
            </div>
            <div
              v-show="rulesOpen"
              id="rules-body"
              class="mt-2 space-y-2"
            >
              <p class="text-xs text-muted">
                {{ $t('rules.hint') }}
              </p>
              <template
                v-for="r in ruleRows"
                :key="r.key"
              >
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <UCheckbox
                    :model-value="!!rulesEnabled[r.key]"
                    @update:model-value="v => onRuleToggle(r.key, !!v)"
                  />
                  <span
                    class="h-1 w-4 shrink-0 rounded-full"
                    :style="{ backgroundColor: r.color }"
                  />
                  <span class="truncate">{{ $t(`rules.rows.${r.key}`) }}</span>
                </label>
                <!-- A row whose lines are coloured by value shows its scale while on. -->
                <div
                  v-if="ruleChips[r.key] && rulesEnabled[r.key]"
                  class="ml-6 flex flex-wrap gap-1"
                >
                  <span
                    v-for="c in ruleChips[r.key]"
                    :key="c.label"
                    class="rounded px-1 text-[10px] font-medium text-white"
                    :style="{ backgroundColor: c.color, color: c.ink }"
                  >{{ c.label }}</span>
                </div>
              </template>
            </div>
          </div>
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
