<script setup lang="ts">
const { t } = useI18n()

// setup re-runs per locale route (each is prerendered separately, and a
// locale switch navigates), so reading t() here is correct per locale.
const fullTitle = `${t('about.metaTitle')} — ${t('site.name')}`
const description = t('site.summary')

useSeoMeta({
  title: () => t('about.metaTitle'),
  description: () => t('site.summary'),
  ogTitle: () => fullTitle,
  ogDescription: () => t('site.summary')
})

// AboutPage node; WebSite/WebPage identity + canonical/hreflang are
// injected globally by @nuxtjs/seo + @nuxtjs/i18n.
useSchemaOrg([
  defineWebPage({
    '@type': 'AboutPage',
    'name': fullTitle,
    description
  })
])
</script>

<template>
  <ContentShell :title="$t('about.h1')">
    <AboutContent />
  </ContentShell>
</template>
