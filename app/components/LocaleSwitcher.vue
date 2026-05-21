<script setup lang="ts">
// Two-locale toggle: a real link (via switchLocalePath) to the current
// route in the other locale — crawlable, and the same target as the
// hreflang alternate, so it doubles as an SEO discovery path.
const { locale, locales } = useI18n()
const switchLocalePath = useSwitchLocalePath()
const { track } = useAnalytics()

const other = computed(() =>
  locales.value.find(l => l.code !== locale.value)
)

function onSwitch() {
  if (!other.value) return
  track('locale_switch', { from: locale.value, to: other.value.code })
}
</script>

<template>
  <UButton
    v-if="other"
    :to="switchLocalePath(other.code)"
    :label="other.name"
    icon="i-lucide-languages"
    size="xs"
    variant="ghost"
    color="neutral"
    :aria-label="$t('localeSwitch.aria')"
    @click="onSwitch"
  />
</template>
