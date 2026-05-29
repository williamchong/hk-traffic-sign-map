<script setup lang="ts">
import { signIconUrl, signDescription, categoryKeyOf } from '~/composables/useSignCatalogue'
import { CATEGORY_FALLBACK_COLOR } from '~/composables/useSignCategories'

const {
  selectedSign, selectedGroup, categories,
  filterMode, enabledSignIds, hiddenSignIds,
  filterToSign, hideSign, unhideSign
} = useTrafficLayers()
const { t, locale } = useI18n()
const { track } = useAnalytics()

const sign = computed(() => selectedSign.value)

const str = (v: unknown) => (v == null || v === '' ? null : String(v))

// Only `traffic-sign-abbreviation` features carry a SIGNID, so the filter
// actions are gated on its presence — poles/text features can't resolve to a
// sign type to filter by.
const signId = computed(() => str(sign.value?.properties.SIGNID))

// Already the sole sign-id pick — the "show only this" action is a no-op, so
// the button reflects it rather than inviting a redundant click.
const isOnlyThis = computed(() =>
  filterMode.value === 'sign-id' && enabledSignIds.size === 1 && !!signId.value && enabledSignIds.has(signId.value)
)
const isHidden = computed(() => !!signId.value && hiddenSignIds.has(signId.value))

function onFilterToThis() {
  if (!signId.value) return
  filterToSign(signId.value)
  track('filter_signid_only', { sign_id: signId.value })
}

// Hiding closes the popup: the hidden sign vanishes from the map, so leaving it
// selected would strand its highlight overlay at an empty spot. Un-hiding keeps
// the popup open (the sign is back, so its highlight is valid again).
function onToggleHide() {
  const id = signId.value
  if (!id) return
  if (isHidden.value) {
    unhideSign(id)
    track('filter_signid_unhide', { sign_id: id })
  } else {
    hideSign(id)
    track('filter_signid_hide', { sign_id: id })
    selectedSign.value = null
  }
}

const category = computed(() => {
  const props = sign.value?.properties
  return props ? categories.find(c => c.key === categoryKeyOf(props)) : undefined
})

// Localized category name, or null when the feature has no category.
const categoryLabel = computed(() =>
  category.value ? t(`categories.${category.value.key}`) : null
)

// The real pictogram when this SIGNID is catalogued, else null (falls back
// to the category colour dot).
const signImage = computed(() => signIconUrl(sign.value?.properties.SIGNID))

// Human meaning of the sign (curated bilingual, else OCR English).
const description = computed(() =>
  signDescription(sign.value?.properties.SIGNID, locale.value)
)

// Members of the picked sign's co-located assembly. ≥2 ⇒ it shares a signpost,
// so the popup lists the whole post as a navigable thumbnail strip.
const isGrouped = computed(() => selectedGroup.value.length > 1)

// STACK_INDEX is unique within a post and survives the re-query a thumbnail
// click triggers, so it (not object identity) marks the current entry.
const currentStackIndex = computed(() => sign.value?.properties.STACK_INDEX)

// One resolved row per assembly member (pictogram + code + meaning), so the
// template renders the strip without re-running the catalogue lookups inline.
const groupEntries = computed(() => selectedGroup.value.map(m => ({
  member: m,
  signId: str(m.properties.SIGNID),
  icon: signIconUrl(m.properties.SIGNID),
  desc: signDescription(m.properties.SIGNID, locale.value),
  current: m.properties.STACK_INDEX === currentStackIndex.value
})))

// Title prefers the most identifying field available for that sign type.
const title = computed(() => {
  const p = sign.value?.properties ?? {}
  return str(p.SIGNID) ?? str(p.TextString) ?? str(p.REFNAME)
    ?? categoryLabel.value ?? t('signPopup.fallbackTitle')
})

// LAST_UPD_DATE is a packed number: YYYYMMDD or YYYYMMDDhhmmss.
const updated = computed(() => {
  const raw = str(sign.value?.properties.LAST_UPD_DATE)
  return raw && raw.length >= 8
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : null
})

const rows = computed(() => {
  const p = sign.value?.properties ?? {}
  return [
    [t('signPopup.fields.reference'), str(p.REFNAME)],
    [t('signPopup.fields.poleId'), str(p.POLEID)],
    [t('signPopup.fields.type'), str(p.TYPE)],
    [t('signPopup.fields.group'), str(p.GG_NAME)],
    [t('signPopup.fields.bearing'), p.ANGLE != null ? `${Math.round(Number(p.ANGLE))}°` : null],
    [t('signPopup.fields.updated'), updated.value]
  ].filter(([, v]) => v) as [string, string][]
})

const coords = computed(() => {
  const ll = sign.value?.lngLat
  return ll ? `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}` : ''
})

// Shown when a click landed on several overlapping signs — but not for an
// assembly, where the group strip is the better (and direct) way to navigate.
const cycleHint = computed(() => {
  const s = sign.value
  return s?.total && s.total > 1 && !isGrouped.value
    ? t('signPopup.cycleHint', { index: s.index, total: s.total })
    : null
})

// Pictogram a11y/hover label: its meaning, else the popup title.
const signLabel = computed(() => description.value ?? title.value)
</script>

<template>
  <UCard
    v-if="sign"
    class="absolute bottom-8 left-4 z-10 w-72 max-w-[calc(100vw-2rem)]"
    :ui="{ body: 'p-4 sm:p-4 space-y-3' }"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 items-start gap-3">
        <img
          v-if="signImage"
          :src="signImage"
          :alt="signLabel"
          :title="signLabel"
          class="size-12 shrink-0 object-contain"
        >
        <span
          v-else
          class="mt-1 size-3 shrink-0 rounded-full"
          :style="{ backgroundColor: category?.color ?? CATEGORY_FALLBACK_COLOR }"
        />
        <div class="min-w-0">
          <h2 class="truncate font-semibold">
            {{ title }}
          </h2>
          <p class="mt-0.5 text-xs text-muted">
            {{ categoryLabel ?? $t('signPopup.unknown') }}
          </p>
          <p
            v-if="cycleHint"
            class="mt-0.5 text-xs text-primary"
          >
            {{ cycleHint }}
          </p>
        </div>
      </div>
      <UButton
        icon="i-lucide-x"
        size="xs"
        color="neutral"
        variant="ghost"
        :aria-label="$t('signPopup.close')"
        @click="selectedSign = null"
      />
    </div>

    <p
      v-if="description"
      class="text-sm font-medium"
    >
      {{ description }}
    </p>

    <div
      v-if="signId"
      class="flex gap-2"
    >
      <UButton
        size="xs"
        :variant="isOnlyThis ? 'soft' : 'solid'"
        color="primary"
        block
        class="flex-1"
        icon="i-lucide-filter"
        :label="t('signPopup.filterOnly')"
        @click="onFilterToThis"
      />
      <UButton
        size="xs"
        variant="outline"
        :color="isHidden ? 'primary' : 'neutral'"
        block
        class="flex-1"
        :icon="isHidden ? 'i-lucide-eye' : 'i-lucide-eye-off'"
        :label="isHidden ? t('signPopup.showAgain') : t('signPopup.hide')"
        @click="onToggleHide"
      />
    </div>

    <div v-if="isGrouped">
      <p class="text-xs text-muted">
        {{ $t('signPopup.groupHeading', { count: groupEntries.length }) }}
      </p>
      <ul class="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto">
        <li
          v-for="e in groupEntries"
          :key="String(e.member.properties.STACK_INDEX)"
        >
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-elevated"
            :class="e.current ? 'bg-elevated ring-1 ring-primary' : ''"
            :title="e.desc ?? e.signId ?? undefined"
            @click="selectedSign = e.member"
          >
            <img
              v-if="e.icon"
              :src="e.icon"
              :alt="e.desc ?? e.signId ?? ''"
              class="shrink-0 object-contain"
              :class="e.current ? 'size-9' : 'size-7'"
              loading="lazy"
            >
            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span class="truncate text-sm font-medium">
                {{ e.signId ?? $t('signPopup.fallbackTitle') }}
              </span>
              <span
                v-if="e.desc"
                class="truncate text-xs text-muted"
              >
                {{ e.desc }}
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <template
        v-for="[label, value] in rows"
        :key="label"
      >
        <dt class="text-muted">
          {{ label }}
        </dt>
        <dd class="truncate text-right">
          {{ value }}
        </dd>
      </template>
    </dl>

    <p class="text-xs text-muted">
      {{ coords }}
    </p>
  </UCard>
</template>
