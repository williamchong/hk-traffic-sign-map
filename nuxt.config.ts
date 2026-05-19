// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/seo'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  // Canonical host (the GitHub Pages CNAME). Drives canonical URLs,
  // absolute og:image, sitemap.xml and robots.txt.
  site: {
    url: 'https://hk-signs-map.williamchong.cloud',
    name: 'HK Traffic Sign Map',
    // SEO-length (~160 char) variant of SITE.summary in
    // app/composables/useSiteContent.ts (the canonical user-facing copy).
    // Kept in sync by hand: nuxt.config is build-time and can't import an
    // app/ runtime module (the two-runtime boundary; see CLAUDE.md).
    description: 'Browse every Hong Kong road traffic sign on an interactive map, built from Transport Department open data.',
    defaultLocale: 'en'
  },

  routeRules: {
    '/': { prerender: true },
    '/about': { prerender: true },
    '/faq': { prerender: true }
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  // A fixed cover image is supplied (public/og-cover.jpg); the dynamic
  // OG-image renderer would be unused and only bloats the static build.
  ogImage: {
    enabled: false
  }
})
