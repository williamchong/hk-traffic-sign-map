<script setup lang="ts">
const title = 'FAQ & User Guide'
const description = 'Frequently asked questions and a quick user guide for the '
  + 'HK Traffic Sign Map: data source, how to read and filter signs, update '
  + 'frequency, and mobile use.'

useSeoMeta({
  title,
  description,
  ogTitle: `${title} — ${SITE.name}`,
  ogDescription: description
})

// FAQPage + one Question node per item, from the same FAQ array the page
// renders, so the structured data can never disagree with the visible copy.
useSchemaOrg([
  defineWebPage({ '@type': ['CollectionPage', 'FAQPage'] }),
  ...FAQ.map(item => defineQuestion({
    name: item.q,
    acceptedAnswer: item.a
  }))
])
</script>

<template>
  <ContentShell title="FAQ & User Guide">
    <FaqContent />
  </ContentShell>
</template>
