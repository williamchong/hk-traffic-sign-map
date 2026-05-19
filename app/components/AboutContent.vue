<script setup lang="ts">
// Presentational only — shared by /about and the in-map info modal.
// Internal links are real <NuxtLink>s so they stay crawlable wherever
// this renders into prerendered HTML.
</script>

<template>
  <div class="space-y-6 text-sm leading-relaxed">
    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        What this is
      </h2>
      <p>{{ SITE.summary }}</p>
      <p>
        Hong Kong has hundreds of thousands of road signs. This project puts
        every one in the Transport Department’s open dataset onto a single
        fast, zoomable map so you can see exactly which signs stand on any
        street — useful for drivers and learner drivers, road-safety and
        town-planning research, accessibility audits, or simple curiosity.
      </p>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        How to use it
      </h2>
      <ul class="list-disc space-y-1 pl-5">
        <li>Pan and zoom to any street; signs spread apart as you zoom in.</li>
        <li>
          Click a sign or dot to inspect it. Click the same spot again to
          cycle through several overlapping signs.
        </li>
        <li>
          Use the <strong>Categories</strong> panel to toggle sign classes on
          or off; fold the panel away for a larger map.
        </li>
      </ul>
    </section>

    <section class="space-y-2">
      <h2 class="text-base font-semibold">
        Data &amp; attribution
      </h2>
      <p>
        Sign data is from the Hong Kong Transport Department’s
        “Traffic Aids Drawings (2nd generation)” open dataset on
        <a
          href="https://data.gov.hk/en-data/dataset/hk-td-tis_16-traffic-aids-drawings-v2"
          target="_blank"
          rel="noopener"
          class="text-primary underline"
        >data.gov.hk</a>, used under the
        <a
          href="https://data.gov.hk/en/terms-and-conditions"
          target="_blank"
          rel="noopener"
          class="text-primary underline"
        >data.gov.hk Terms and Conditions</a>. The basemap is
        © <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener"
          class="text-primary underline"
        >OpenStreetMap</a> contributors.
      </p>
      <p class="text-muted">
        This is an independent, informational project. It is not affiliated
        with the Transport Department and must not be relied on for
        navigation or as a legal authority on road traffic regulations.
      </p>
    </section>

    <nav class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <NuxtLink
        to="/"
        class="text-primary underline"
      >
        Open the map
      </NuxtLink>
      <NuxtLink
        to="/faq"
        class="text-primary underline"
      >
        FAQ &amp; user guide
      </NuxtLink>
    </nav>
  </div>
</template>
