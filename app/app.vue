<script setup lang="ts">
// Site-wide defaults. /about and /faq override title/description per page;
// @nuxtjs/seo resolves canonical URLs, og:url and the absolute og:image
// from the `site` config in nuxt.config.ts.
useHead({
  // Own the title template so pages pass a short title ("About") and the
  // brand is appended once — overrides @nuxtjs/seo's default which would
  // otherwise double the site name (and on home: "X | X").
  titleTemplate: t => (t && t !== SITE.name ? `${t} — ${SITE.name}` : SITE.name),
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
    { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
    { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }
  ]
})

useSeoMeta({
  title: SITE.name,
  description: SITE.summary,
  ogTitle: SITE.name,
  ogDescription: SITE.summary,
  ogType: 'website',
  // Relative path is rewritten to an absolute URL by @nuxtjs/seo using
  // site.url; required for Open Graph / Twitter to resolve the image.
  ogImage: '/og-cover.jpg',
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: 'image/jpeg',
  ogImageAlt: 'Hong Kong traffic signs shown on the interactive map',
  twitterCard: 'summary_large_image',
  twitterImage: '/og-cover.jpg'
})
</script>

<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
