<script setup lang="ts">
// Presentational only — shared by /about and the in-map info modal.
// Internal links are real <NuxtLink>s (localePath-aware) so they stay
// crawlable in the active locale wherever this renders into prerendered
// HTML. The attribution paragraph uses <i18n-t> so the external links
// stay intact inside a translatable sentence.
const localePath = useLocalePath()
const { locale } = useI18n()

const UTM = '?utm_source=hk-traffic-sign-map&utm_medium=about'

const LINKS = {
  tad: 'https://data.gov.hk/en-data/dataset/hk-td-tis_16-traffic-aids-drawings-v2',
  roadNetwork: 'https://data.gov.hk/en-data/dataset/hk-td-tis_15-road-network-v2',
  terms: 'https://data.gov.hk/en/terms-and-conditions',
  osm: 'https://www.openstreetmap.org/copyright',
  source: `https://github.com/williamchong/hk-traffic-sign-map${UTM}`,
  author: `https://blog.williamchong.cloud/${UTM}`
}

// One <i18n-t> slot per link, each labelled by `about.<slot>Label`. The
// Road Users' Code is published as separate English and Chinese pages.
const attributionLinks = computed(() => ({
  tad: LINKS.tad,
  roadNetwork: LINKS.roadNetwork,
  ruc: `https://www.td.gov.hk/${locale.value === 'zh-HK' ? 'tc' : 'en'}/road_safety/road_users_code/index/chapter_8_the_language_of_the_road/`,
  terms: LINKS.terms,
  osm: LINKS.osm
}))
</script>

<template>
  <div class="space-y-6 text-sm leading-relaxed">
    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        {{ $t('about.whatTitle') }}
      </h2>
      <p>{{ $t('site.summary') }}</p>
      <p>{{ $t('about.whatP2') }}</p>
      <p>{{ $t('about.whatP3') }}</p>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        {{ $t('about.howTitle') }}
      </h2>
      <ul class="list-disc space-y-1 pl-5">
        <li>{{ $t('about.how1') }}</li>
        <li>{{ $t('about.how2') }}</li>
        <li>{{ $t('about.how3') }}</li>
        <li>{{ $t('about.how4') }}</li>
        <li>{{ $t('about.how5') }}</li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        {{ $t('about.dataTitle') }}
      </h2>
      <i18n-t
        keypath="about.attribution"
        tag="p"
        scope="global"
      >
        <template
          v-for="(href, slot) in attributionLinks"
          :key="slot"
          #[slot]
        >
          <a
            :href="href"
            target="_blank"
            rel="noopener"
            class="text-primary underline"
          >{{ $t(`about.${slot}Label`) }}</a>
        </template>
      </i18n-t>
      <p class="text-muted">
        {{ $t('about.disclaimer') }}
      </p>
    </section>

    <nav class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <NuxtLink
        :to="localePath('/')"
        class="text-primary underline"
      >
        {{ $t('nav.openMap') }}
      </NuxtLink>
      <NuxtLink
        :to="localePath('/faq')"
        class="text-primary underline"
      >
        {{ $t('nav.faqUserGuide') }}
      </NuxtLink>
    </nav>

    <i18n-t
      keypath="about.colophon"
      tag="p"
      scope="global"
      class="text-muted text-xs"
    >
      <template #author>
        <a
          :href="LINKS.author"
          target="_blank"
          rel="noopener"
          class="underline"
        >{{ $t('about.authorLabel') }}</a>
      </template>
      <template #source>
        <a
          :href="LINKS.source"
          target="_blank"
          rel="noopener"
          class="underline"
        >{{ $t('about.sourceLabel') }}</a>
      </template>
    </i18n-t>
  </div>
</template>
