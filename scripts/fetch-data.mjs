// Downloads the raw GML (+ .gfs schema sidecar) for every sign layer into
// data/raw/. Re-running is cheap: a file is skipped when its on-disk size
// already matches the server's Content-Length, so an interrupted run resumes
// without re-fetching the 100+ MB sign files.

import { mkdir, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

import { SIGN_LAYERS, DATA_BASE_URL, RAW_DIR } from './sign-layers.mjs'

async function localSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

async function download(url, dest) {
  const head = await fetch(url, { method: 'HEAD' })
  if (!head.ok) throw new Error(`HEAD ${url} -> ${head.status}`)
  const remote = Number(head.headers.get('content-length') ?? -1)

  if (remote > 0 && (await localSize(dest)) === remote) {
    console.log(`✓ up to date  ${dest}`)
    return
  }

  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  console.log(`↓ downloaded  ${dest} (${(remote / 1e6).toFixed(1)} MB)`)
}

await mkdir(RAW_DIR, { recursive: true })

for (const { file } of SIGN_LAYERS) {
  for (const ext of ['gml', 'gfs']) {
    const name = `${file}.${ext}`
    await download(`${DATA_BASE_URL}/${name}`, join(RAW_DIR, name))
  }
}

console.log(`\nDone. ${SIGN_LAYERS.length} layers in ${RAW_DIR}/`)
