// Small display helpers shared by the sign and rule popups.

// A tile property as display text, or null when absent/blank so a row can
// be filtered out.
export const str = (v: unknown) => (v == null || v === '' ? null : String(v))

// "22.28314, 114.14556" — lat, lng at ~1 m.
export const formatLngLat = (ll: { lat: number, lng: number }) => `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`
