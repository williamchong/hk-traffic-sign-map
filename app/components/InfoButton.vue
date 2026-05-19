<script setup lang="ts">
// In-map "About / FAQ" affordance: a small icon button that opens a modal
// with the same content as the /about and /faq pages, so users get the
// explanation without leaving the map. The SEO/crawlable path is the
// separate prerendered links + pages, not this modal.
const open = ref(false)

const tabs = [
  { label: 'About', slot: 'about' as const, icon: 'i-lucide-info' },
  { label: 'FAQ & Guide', slot: 'faq' as const, icon: 'i-lucide-circle-help' }
]
</script>

<template>
  <UModal
    v-model:open="open"
    :title="SITE.name"
    :description="SITE.tagline"
  >
    <UButton
      icon="i-lucide-info"
      size="xs"
      color="neutral"
      variant="ghost"
      aria-label="About this map and FAQ"
    />

    <template #body>
      <UTabs
        :items="tabs"
        variant="link"
        class="max-h-[70vh] overflow-y-auto"
      >
        <template #about>
          <AboutContent class="pt-4" />
        </template>
        <template #faq>
          <FaqContent class="pt-4" />
        </template>
      </UTabs>
    </template>
  </UModal>
</template>
