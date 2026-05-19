<script setup lang="ts">
// In-map "About / FAQ" affordance: a small icon button that opens a modal
// with the same content as the /about and /faq pages, so users get the
// explanation without leaving the map. The SEO/crawlable path is the
// separate prerendered links + pages, not this modal.
const { t } = useI18n()
const open = ref(false)

const tabs = computed(() => [
  { label: t('tabs.about'), slot: 'about' as const, icon: 'i-lucide-info' },
  { label: t('tabs.faq'), slot: 'faq' as const, icon: 'i-lucide-circle-help' }
])
</script>

<template>
  <UModal
    v-model:open="open"
    :title="$t('site.name')"
    :description="$t('site.tagline')"
  >
    <UButton
      icon="i-lucide-info"
      size="xs"
      color="neutral"
      variant="ghost"
      :aria-label="$t('info.aria')"
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
