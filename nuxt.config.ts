// https://nuxt.com/docs/api/configuration/nuxt-config

// Single source for the canonical host so `site.url` and the i18n
// `baseUrl` (used for hreflang/canonical absolute URLs) can't drift.
const siteUrl = 'https://hk-signs-map.williamchong.cloud'

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxt/scripts',
    '@nuxtjs/seo',
    '@nuxtjs/i18n'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  // Drives canonical URLs, absolute og:image, sitemap.xml and robots.txt.
  site: {
    url: siteUrl,
    name: 'HK Traffic Sign Map',
    // SEO-length (~160 char) summary; the canonical long-form copy lives
    // in i18n/locales/en.json (site.summary). Kept in sync by hand —
    // nuxt.config is build-time and can't import locale messages.
    description: 'Browse every Hong Kong road traffic sign on an interactive map, built from Transport Department open data.',
    defaultLocale: 'en'
  },

  routeRules: {
    // `/` is served by the static redirector in public/index.html (the
    // `prefix` strategy has no real page there); every locale is prefixed.
    '/en': { prerender: true },
    '/en/about': { prerender: true },
    '/en/faq': { prerender: true },
    '/zh-HK': { prerender: true },
    '/zh-HK/about': { prerender: true },
    '/zh-HK/faq': { prerender: true }
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

  // `prefix` strategy: every locale gets its own prefixed URL (/en/*,
  // /zh-HK/*) and `/` is served by the static redirector in
  // public/index.html. Fully symmetric URLs — the cleanest shape for
  // hreflang/SEO (no root-vs-locale asymmetry). @nuxtjs/i18n emits
  // hreflang + x-default and og:locale via useLocaleHead(); @nuxtjs/sitemap
  // auto-adds the per-URL <xhtml:link rel="alternate"> entries. The
  // conventional BCP47 `zh-HK` casing is used for both URL and hreflang
  // (Google treats hreflang case-insensitively); the link-checker's
  // lowercase-URL rule is disabled below for that locale subtag.
  i18n: {
    strategy: 'prefix',
    defaultLocale: 'en',
    baseUrl: siteUrl,
    locales: [
      { code: 'en', language: 'en', name: 'English', file: 'en.json' },
      { code: 'zh-HK', language: 'zh-HK', name: '繁體中文', file: 'zh-HK.json' }
    ],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'i18n_redirected',
      // Only the bare entry point redirects; deep links stay crawlable
      // and keep their canonical locale.
      redirectOn: 'root'
    }
  },

  // The locale URL subtag is the conventional BCP47 `zh-HK` (uppercase
  // region); that's valid and Google-accepted, so silence the link
  // checker's general lowercase-URL hygiene rule for it.
  linkChecker: {
    skipInspections: ['no-uppercase-chars']
  },

  // A fixed cover image is supplied (public/og-cover.jpg); the dynamic
  // OG-image renderer would be unused and only bloats the static build.
  ogImage: {
    enabled: false
  },

  // GA4 via Nuxt Scripts. Plain third-party setup by request:
  // bundle/proxy off (loads gtag.js straight from googletagmanager.com,
  // no origin reverse-proxy) and no consent gating (privacy mode off) —
  // i.e. the opposite of Nuxt Scripts' default first-party mode for GA.
  scripts: {
    privacy: false,
    registry: {
      googleAnalytics: {
        id: 'G-7PFV2DE82Q',
        bundle: false,
        proxy: false
      }
    }
  }
})
