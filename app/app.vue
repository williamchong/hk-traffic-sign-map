<script setup lang="ts">
// Site-wide defaults, locale-aware. app.vue is the persistent root across
// route changes, so title/meta MUST be reactive getters — switching locale
// navigates here without remounting. useLocaleHead() supplies the per-locale
// <html lang>, hreflang/x-default alternates and og:locale; @nuxtjs/seo
// resolves canonical + absolute og:image from the site config, and
// @nuxtjs/sitemap adds the per-URL alternates to sitemap.xml.
const { t } = useI18n()

// Per-locale <html lang>, hreflang/x-default alternates and og:locale.
// Passing the ref straight to useHead is the documented i18n pattern.
useHead(useLocaleHead())

useHead({
  // Pages pass a short title ("About"); the brand is appended once.
  titleTemplate: (title?: string) =>
    (title && title !== t('site.name') ? `${title} — ${t('site.name')}` : t('site.name')),
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
  title: () => t('site.name'),
  description: () => t('site.summary'),
  ogTitle: () => t('site.name'),
  ogDescription: () => t('site.summary'),
  ogType: 'website',
  // Relative path is rewritten to an absolute URL by @nuxtjs/seo using
  // site.url; required for Open Graph / Twitter to resolve the image.
  ogImage: '/og-cover.jpg',
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: 'image/jpeg',
  ogImageAlt: () => t('site.tagline'),
  twitterCard: 'summary_large_image',
  twitterImage: '/og-cover.jpg'
})
</script>

<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
