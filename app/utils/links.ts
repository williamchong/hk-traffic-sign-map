// td.gov.hk publishes each page twice, under /en/ and /tc/.
export const tdLang = (locale: string) => (locale === 'zh-HK' ? 'tc' : 'en')

// TD's own traffic-notice listing, where temporary closures and new
// restrictions are announced first — the page every "check before you drive"
// caveat points at.
export const tdTrafficNoticesUrl = (locale: string) =>
  `https://www.td.gov.hk/${tdLang(locale)}/traffic_notices/index.html`
