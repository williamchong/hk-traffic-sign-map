<script setup lang="ts">
// Presentational only — shared by /faq and the in-map info modal.
// Plain semantic <h*>/<p> (no accordion) so every answer is in the
// prerendered DOM and crawlable; the same FAQ array feeds FAQPage
// schema.org on the /faq page.
</script>

<template>
  <div class="space-y-5 text-sm leading-relaxed">
    <section
      v-for="item in FAQ"
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
        to="/"
        class="text-primary underline"
      >
        Open the map
      </NuxtLink>
      <NuxtLink
        to="/about"
        class="text-primary underline"
      >
        About this project
      </NuxtLink>
    </nav>
  </div>
</template>
