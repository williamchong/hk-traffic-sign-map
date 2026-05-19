<script setup lang="ts">
// Presentational only — shared by /about and the in-map info modal.
// Internal links are real <NuxtLink>s (localePath-aware) so they stay
// crawlable in the active locale wherever this renders into prerendered
// HTML. The attribution paragraph uses <i18n-t> so the external links
// stay intact inside a translatable sentence.
const localePath = useLocalePath()

const LINKS = {
  dataGovHk: 'https://data.gov.hk/en-data/dataset/hk-td-tis_16-traffic-aids-drawings-v2',
  terms: 'https://data.gov.hk/en/terms-and-conditions',
  osm: 'https://www.openstreetmap.org/copyright'
}
</script>

<template>
  <div class="space-y-6 text-sm leading-relaxed">
    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        {{ $t('about.whatTitle') }}
      </h2>
      <p>{{ $t('site.summary') }}</p>
      <p>{{ $t('about.whatP2') }}</p>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        {{ $t('about.howTitle') }}
      </h2>
      <ul class="list-disc space-y-1 pl-5">
        <li>{{ $t('about.how1') }}</li>
        <li>{{ $t('about.how2') }}</li>
        <li>{{ $t('about.how3') }}</li>
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
        <template #dataGovHk>
          <a
            :href="LINKS.dataGovHk"
            target="_blank"
            rel="noopener"
            class="text-primary underline"
          >{{ $t('about.dataGovHkLabel') }}</a>
        </template>
        <template #terms>
          <a
            :href="LINKS.terms"
            target="_blank"
            rel="noopener"
            class="text-primary underline"
          >{{ $t('about.termsLabel') }}</a>
        </template>
        <template #osm>
          <a
            :href="LINKS.osm"
            target="_blank"
            rel="noopener"
            class="text-primary underline"
          >{{ $t('about.osmLabel') }}</a>
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
  </div>
</template>
