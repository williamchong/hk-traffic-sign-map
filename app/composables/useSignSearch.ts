import { refDebounced } from '@vueuse/core'
import {
  SIGN_GROUPS,
  bilingualDescription,
  codesByGroup,
  signIconUrl,
  type SignGroup
} from '~/composables/useSignCatalogue'

interface IndexEntry {
  id: string
  group: SignGroup
  en?: string
  zh?: string
  // Lower-cased haystack for English matching: id + en. Built once so the
  // matcher doesn't toLowerCase on every keystroke.
  enHaystack: string
  // Pre-resolved once at index time — every catalogued sign has a PNG, so
  // this is non-null here and lets the consumer skip a per-row helper call.
  iconUrl: string
}

const INDEX: readonly IndexEntry[] = (() => {
  const all: IndexEntry[] = []
  // Stable group-then-id order: `Object.entries` on the catalogue would key
  // on JSON insertion order which is data-build dependent.
  for (const group of SIGN_GROUPS) {
    for (const id of codesByGroup[group]) {
      const { en, zh } = bilingualDescription(id)
      const iconUrl = signIconUrl(id)
      if (!iconUrl) continue // unreachable for codesByGroup entries
      all.push({
        id, group, en, zh, iconUrl,
        enHaystack: `${id} ${en ?? ''}`.toLowerCase()
      })
    }
  }
  return all
})()

export const SIGN_SEARCH_TOTAL = INDEX.length

export interface SignSearchHit {
  id: string
  group: SignGroup
  description: string | null
  iconUrl: string
}

// Treat any TS/PS/DS/IS/etc. + digits token as a SIGNID query, even if the
// user typed lowercase or with separators ("ts-117", "ts 117"). Lets us hit
// the indexed `id` field cleanly without making every keystroke a substring
// scan against the en haystack as well.
function normaliseIdQuery(raw: string): string | null {
  const cleaned = raw.replace(/[\s_-]+/g, '').toUpperCase()
  return /^[A-Z]{1,4}\d+$/.test(cleaned) ? cleaned : null
}

export function useSignSearch(options: {
  groupFilter: Ref<readonly SignGroup[] | null>
  locale: Ref<'en' | 'zh-HK'>
}) {
  // `query` updates per-keystroke for snappy input echo; `debouncedQuery`
  // drives the matcher at a calmer cadence.
  const query = ref('')
  const debouncedQuery = refDebounced(query, 120)

  // Split into two computeds so toggling a facet chip doesn't re-scan
  // haystacks, and typing doesn't re-filter groups.
  const pool = computed<readonly IndexEntry[]>(() => {
    const groups = options.groupFilter.value
    if (!groups || groups.length === 0) return INDEX
    const groupSet = new Set(groups)
    return INDEX.filter(e => groupSet.has(e.group))
  })

  const matches = computed<SignSearchHit[]>(() => {
    const q = debouncedQuery.value.trim()
    const loc = options.locale.value

    let hits: readonly IndexEntry[]
    if (!q) {
      hits = pool.value
    } else {
      const idQuery = normaliseIdQuery(q)
      const lower = q.toLowerCase()
      const filtered = pool.value.filter((e) => {
        if (idQuery && e.id.startsWith(idQuery)) return true
        if (e.enHaystack.includes(lower)) return true
        if (e.zh && e.zh.includes(q)) return true
        return false
      })
      // Float exact-id then id-prefix above pure-text matches when the
      // query parses as a SIGNID. Text-only matches stay in their original
      // (group-then-id) order via stable sort.
      if (idQuery) {
        const score = (e: IndexEntry) =>
          e.id === idQuery ? 2 : e.id.startsWith(idQuery) ? 1 : 0
        filtered.sort((a, b) => score(b) - score(a))
      }
      hits = filtered
    }

    return hits.map(e => ({
      id: e.id,
      group: e.group,
      iconUrl: e.iconUrl,
      description: loc === 'zh-HK' ? (e.zh || e.en || null) : (e.en || null)
    }))
  })

  return { query, debouncedQuery, matches }
}
