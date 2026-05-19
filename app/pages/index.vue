<script setup lang="ts">
// TrafficMap is a `.client.vue` component: Nuxt skips SSR for it entirely
// (MapLibre needs WebGL/window), rendering its fallback until hydration.
</script>

<template>
  <div class="relative h-dvh w-dvw overflow-hidden">
    <TrafficMap>
      <template #fallback>
        <div class="flex h-full w-full items-center justify-center text-muted">
          <p>Loading map…</p>
        </div>
      </template>
    </TrafficMap>

    <LayerFilterPanel />
    <SignPopup />
  </div>
</template>
