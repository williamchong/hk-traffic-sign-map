<script setup lang="ts">
// TrafficMap is wrapped in <ClientOnly>: MapLibre needs window/WebGL and
// is dynamically imported, so it must never render during SSR. The filter
// panel and popup are SSR-safe (state only) and render immediately.
</script>

<template>
  <div class="relative h-dvh w-dvw overflow-hidden">
    <ClientOnly>
      <TrafficMap />
      <template #fallback>
        <div class="flex h-full w-full items-center justify-center text-muted">
          <p>Loading map…</p>
        </div>
      </template>
    </ClientOnly>

    <LayerFilterPanel />
    <SignPopup />
  </div>
</template>
