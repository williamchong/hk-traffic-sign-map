// Single source of truth for the marketing / help copy. Consumed by the
// /about and /faq pages (incl. their schema.org JSON-LD) AND the in-map
// modal, so the prose never drifts between the SEO pages and the app.

export const SITE = {
  name: 'HK Traffic Sign Map',
  tagline: 'Every Hong Kong road traffic sign, on one interactive map.',
  // One-paragraph plain-language summary (used in meta + the About intro).
  summary: 'HK Traffic Sign Map is a free interactive map of road traffic '
    + 'signs across Hong Kong, built from the Transport Department’s open '
    + 'data. Pan and zoom anywhere in the city to see which regulatory, '
    + 'warning, informatory and other signs are installed on each street.'
} as const

// FAQ doubles as the user guide. Answers are plain text so the exact same
// strings feed both the on-page copy and the FAQPage schema.org markup
// (rich text/links there would not be valid structured data).
export interface FaqItem {
  q: string
  a: string
}

export const FAQ: readonly FaqItem[] = [
  {
    q: 'What is the HK Traffic Sign Map?',
    a: 'It is a free, interactive web map showing the location of road '
      + 'traffic signs throughout Hong Kong. Catalogued signs are drawn as '
      + 'their real pictogram; everything else appears as a colour-coded '
      + 'dot you can click to inspect.'
  },
  {
    q: 'Where does the sign data come from?',
    a: 'From the Hong Kong Transport Department’s open dataset '
      + '“Traffic Aids Drawings (2nd generation)”, published on '
      + 'data.gov.hk. The basemap is © OpenStreetMap contributors.'
  },
  {
    q: 'How current is the data?',
    a: 'The Transport Department refreshes the source dataset roughly '
      + 'monthly. This site is rebuilt from that data, so it reflects the '
      + 'most recent published release rather than live, real-time changes.'
  },
  {
    q: 'How do I find and inspect a sign?',
    a: 'Zoom into any street. Signs spread apart as you zoom in. Click a '
      + 'sign or dot to open its details; if several signs overlap, click '
      + 'again on the same spot to cycle through each one.'
  },
  {
    q: 'What do the colours and categories mean?',
    a: 'Signs are grouped into their Index-Plan classes — Regulatory, '
      + 'Warning, Informatory, Supplementary and Temporary — plus '
      + 'Tourist and uncatalogued Other signs. Each class has its own '
      + 'colour in the legend and can be toggled on or off independently.'
  },
  {
    q: 'Why do some signs show as a coloured dot instead of a picture?',
    a: 'A sign is drawn as its real pictogram once you zoom in past its '
      + 'level-of-detail threshold and if it exists in the pictogram '
      + 'catalogue. Until then, or for not-yet-catalogued signs, it stays '
      + 'a coloured dot so it is never hidden.'
  },
  {
    q: 'Can I filter which signs are shown?',
    a: 'Yes. Use the Categories panel to toggle any sign class on or off, '
      + 'or hide them all at once. The panel can be folded away to give the '
      + 'map more room.'
  },
  {
    q: 'Does it work on a phone?',
    a: 'Yes. The map is responsive, supports touch pan/zoom, and can centre '
      + 'on your location if you grant location permission.'
  },
  {
    q: 'Is this an official government website?',
    a: 'No. It is an independent, informational project that visualises '
      + 'public open data. It is not affiliated with the Transport '
      + 'Department and must not be used for navigation or as a legal '
      + 'authority on road traffic regulations.'
  },
  {
    q: 'Is it free to use?',
    a: 'Yes, it is free. The underlying sign data is provided under the '
      + 'data.gov.hk Terms and Conditions; the basemap is OpenStreetMap.'
  }
] as const
