// Localized FAQ items resolved from the i18n `faq.items` message array.
// One source for the rendered list (FaqContent) and the FAQPage
// schema.org markup (pages/faq.vue), so the structured data can never
// drift from the visible copy — across both locales.

export interface FaqItem {
  q: string
  a: string
}

export function useFaqItems() {
  const { tm, rt } = useI18n()
  // tm() returns the raw message array (each value a compiled message,
  // not a string); rt() resolves each to the final localized text.
  type RtArg = Parameters<typeof rt>[0]
  return computed<FaqItem[]>(() =>
    (tm('faq.items') as { q: RtArg, a: RtArg }[]).map(item => ({
      q: rt(item.q),
      a: rt(item.a)
    }))
  )
}
