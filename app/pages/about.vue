<script setup lang="ts">
const title = 'About'
const fullTitle = `About — ${SITE.name}`
const description = SITE.summary

useSeoMeta({
  title,
  description,
  ogTitle: fullTitle,
  ogDescription: description
})

// AboutPage node; WebSite/WebPage identity is injected globally by
// @nuxtjs/seo from the site config.
useSchemaOrg([
  defineWebPage({
    '@type': 'AboutPage',
    'name': fullTitle,
    description
  })
])
</script>

<template>
  <ContentShell title="About the HK Traffic Sign Map">
    <AboutContent />
  </ContentShell>
</template>
