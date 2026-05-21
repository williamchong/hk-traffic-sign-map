<script setup lang="ts">
// Cycles the colour-mode *preference* through light → dark → system.
// The map needs no wiring: TrafficMap.vue watches colorMode.value (the
// resolved light/dark), and @nuxtjs/color-mode keeps that reactive — incl.
// to OS theme changes while preference is 'system' — so it follows for free.
const colorMode = useColorMode()
const { track } = useAnalytics()

const MODES = ['light', 'dark', 'system'] as const
type Mode = typeof MODES[number]

// Mode labels are localized via the i18n key `theme.<mode>`.
const ICON: Record<Mode, string> = {
  light: 'i-lucide-sun',
  dark: 'i-lucide-moon',
  system: 'i-lucide-monitor'
}

const isMode = (v: string): v is Mode => (MODES as readonly string[]).includes(v)

const current = computed<Mode>(() =>
  isMode(colorMode.preference) ? colorMode.preference : 'system'
)

function cycle() {
  const next = MODES[(MODES.indexOf(current.value) + 1) % MODES.length] ?? 'system'
  colorMode.preference = next
  track('theme_change', { mode: next })
}
</script>

<template>
  <ClientOnly>
    <UButton
      size="xs"
      variant="ghost"
      color="neutral"
      :icon="ICON[current]"
      :title="$t('theme.title', { mode: $t(`theme.${current}`) })"
      :aria-label="$t('theme.aria', { mode: $t(`theme.${current}`) })"
      @click="cycle"
    />
    <template #fallback>
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-monitor"
        disabled
      />
    </template>
  </ClientOnly>
</template>
