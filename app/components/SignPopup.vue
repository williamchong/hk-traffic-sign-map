<script setup lang="ts">
import { signIconUrl, signDescription, categoryKeyOf } from '~/composables/useSignCatalogue'

const { selectedSign, categories } = useTrafficLayers()
const { t, locale } = useI18n()

const sign = computed(() => selectedSign.value)

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

const str = (v: unknown) => (v == null || v === '' ? null : String(v))

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

// Shown when a click landed on several overlapping signs.
const cycleHint = computed(() => {
  const s = sign.value
  return s?.total && s.total > 1
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
          :style="{ backgroundColor: category?.color ?? '#94a3b8' }"
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
