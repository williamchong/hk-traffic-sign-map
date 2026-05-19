<script setup lang="ts">
// Cycles the colour-mode *preference* through light → dark → system.
// The map needs no wiring: TrafficMap.vue watches colorMode.value (the
// resolved light/dark), and @nuxtjs/color-mode keeps that reactive — incl.
// to OS theme changes while preference is 'system' — so it follows for free.
const colorMode = useColorMode()

const MODES = ['light', 'dark', 'system'] as const
type Mode = typeof MODES[number]

const META: Record<Mode, { icon: string, label: string }> = {
  light: { icon: 'i-lucide-sun', label: 'Light' },
  dark: { icon: 'i-lucide-moon', label: 'Dark' },
  system: { icon: 'i-lucide-monitor', label: 'System' }
}

const isMode = (v: string): v is Mode => (MODES as readonly string[]).includes(v)

const current = computed<Mode>(() =>
  isMode(colorMode.preference) ? colorMode.preference : 'system'
)

function cycle() {
  const next = MODES[(MODES.indexOf(current.value) + 1) % MODES.length]
  colorMode.preference = next ?? 'system'
}
</script>

<template>
  <ClientOnly>
    <UButton
      size="xs"
      variant="ghost"
      color="neutral"
      :icon="META[current].icon"
      :title="`Theme: ${META[current].label} (click to cycle)`"
      :aria-label="`Theme: ${META[current].label}. Click to cycle light, dark, system.`"
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
