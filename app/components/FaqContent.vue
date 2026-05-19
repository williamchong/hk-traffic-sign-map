<script setup lang="ts">
// Presentational only — shared by /faq and the in-map info modal.
// Plain semantic <h*>/<p> (no accordion) so every answer is in the
// prerendered DOM and crawlable; the same localized FAQ array feeds
// FAQPage schema.org on the /faq page.
const faq = useFaqItems()
const localePath = useLocalePath()
</script>

<template>
  <div class="space-y-5 text-sm leading-relaxed">
    <section
      v-for="item in faq"
      :key="item.q"
      class="space-y-1"
    >
      <h2 class="text-sm font-semibold">
        {{ item.q }}
      </h2>
      <p class="text-muted">
        {{ item.a }}
      </p>
    </section>

    <nav class="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-sm">
      <NuxtLink
        :to="localePath('/')"
        class="text-primary underline"
      >
        {{ $t('nav.openMap') }}
      </NuxtLink>
      <NuxtLink
        :to="localePath('/about')"
        class="text-primary underline"
      >
        {{ $t('nav.aboutProject') }}
      </NuxtLink>
    </nav>
  </div>
</template>
