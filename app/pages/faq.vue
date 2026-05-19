<script setup lang="ts">
const { t } = useI18n()
const faq = useFaqItems()

const fullTitle = `${t('faq.metaTitle')} — ${t('site.name')}`

useSeoMeta({
  title: () => t('faq.metaTitle'),
  description: () => t('faq.metaDescription'),
  ogTitle: () => fullTitle,
  ogDescription: () => t('faq.metaDescription')
})

// FAQPage + one Question node per item, from the same localized FAQ array
// the page renders, so the structured data can't disagree with the visible
// copy in either locale.
useSchemaOrg([
  defineWebPage({ '@type': ['CollectionPage', 'FAQPage'] }),
  ...faq.value.map(item => defineQuestion({
    name: item.q,
    acceptedAnswer: item.a
  }))
])
</script>

<template>
  <ContentShell :title="$t('faq.h1')">
    <FaqContent />
  </ContentShell>
</template>
