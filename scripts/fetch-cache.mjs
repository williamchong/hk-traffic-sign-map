// Shared plumbing for the two scripts that read from someone else's web server
// and cache the result under `data/raw/`: the Road Sign Factory image oracle
// (`audit-sign-images.mjs`) and the Road Users' Code name harvest
// (`fetch-ruc-names.mjs`).

import { writeFile, rename } from 'node:fs/promises'

// A minimum INTERVAL between requests, not a nap taken after each one:
// measuring from the last request lets the caller's own work (a render, a
// compare, a parse) fill the gap rather than extend it, and the request rate
// still never exceeds the declared floor.
//
// Returned as a closure per caller so two pacers cannot share one clock — the
// module-level `lastFetchAt` this replaces would have coupled any two importers
// into one rate limit.
export function makePacer(delayMs) {
  let lastAt = 0
  return async function pace() {
    const wait = delayMs - (Date.now() - lastAt)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastAt = Date.now()
  }
}

// `writeFile` is not atomic. An interrupted run would otherwise leave a
// truncated file in the cache that looks valid forever, with only a full
// `--refresh` to escape it.
export async function cacheWrite(dst, data) {
  const tmp = `${dst}.part`
  await writeFile(tmp, data)
  await rename(tmp, dst)
}
