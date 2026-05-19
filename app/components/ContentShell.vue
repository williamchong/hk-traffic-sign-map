<script setup lang="ts">
// Chrome for the standalone /about and /faq pages. Deliberately a plain
// component (not a Nuxt layout) so the map page's structure is untouched.
defineProps<{ title: string }>()

const localePath = useLocalePath()
</script>

<template>
  <div class="min-h-dvh bg-default text-default">
    <header class="border-b border-default">
      <div class="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-3">
        <NuxtLink
          :to="localePath('/')"
          class="text-sm font-semibold"
        >
          {{ $t('site.name') }}
        </NuxtLink>
        <div class="flex items-center gap-0.5">
          <LocaleSwitcher />
          <ThemeCycleButton />
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-2xl px-4 py-8">
      <h1 class="mb-6 text-xl font-bold">
        {{ title }}
      </h1>
      <slot />
    </main>
  </div>
</template>
