// Catalogue I/O and the --commit promotion.

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { applyAdd, promoteAdd } from './extract.mjs'
import { CATALOGUE_JSON, SIGNS_DIR, STAGING } from './sheets.mjs'

// One shape for `desc`, on EVERY write: `{ en }`.
//
// Older builds wrote a bare string, and a VLM pass wrote `{en, zh}` whose zh was
// read off the sign FACE ("停", "Bus巴士", "3tonnes公噸") or off a time plate
// ("上午七時至下午九時") — sign-face text, not a description. The Index Plan's
// Description column is English-only, so Chinese can only come from curation:
// app/data/signDescriptions.json is the single source of zh and the runtime
// prefers it anyway.
function tidyCatalogue(catalogue) {
  for (const entry of Object.values(catalogue)) {
    const d = typeof entry.desc === 'string' ? { en: entry.desc } : entry.desc
    const en = d?.en?.trim()
    if (en) entry.desc = { en }
    else delete entry.desc
  }
  return catalogue
}

export async function readCatalogue() {
  if (!existsSync(CATALOGUE_JSON)) return {}
  return JSON.parse(await readFile(CATALOGUE_JSON, 'utf8'))
}

export async function writeCatalogue(catalogue) {
  await writeFile(CATALOGUE_JSON, JSON.stringify(tidyCatalogue(catalogue), null, 2) + '\n')
}

export async function clearSignsDir() {
  for (const f of await readdir(SIGNS_DIR).catch(() => [])) {
    if (f.endsWith('.png')) await rm(join(SIGNS_DIR, f))
  }
}

// Promote the crops staged by --propose into public/signs/ + the catalogue.
export async function commitStaged({ wipe, sheet, reject, overrides }) {
  if (!existsSync(CATALOGUE_JSON)) {
    console.error(`no catalogue at ${CATALOGUE_JSON} to commit into`)
    process.exit(1)
  }
  await mkdir(SIGNS_DIR, { recursive: true })
  let catalogue = await readCatalogue()
  if (wipe) {
    await clearSignsDir()
    catalogue = {}
    console.log('--wipe commit: cleared public/signs/ and reset the catalogue')
  }
  let committed = 0, rejected = 0
  for (const dir of (await readdir(STAGING).catch(() => []))) {
    const mfPath = join(STAGING, dir, 'manifest.json')
    if (!existsSync(mfPath)) continue
    const mf = JSON.parse(await readFile(mfPath, 'utf8'))
    if (sheet && !mf.sheet.includes(sheet)) continue
    for (const add of (mf.adds ?? [])) {
      if (reject.has(add.code)) {
        rejected++
        continue
      }
      // The reviewer has seen verify.png (which labels each half with the
      // measured face), so committing confirms it.
      const confirmed = { trustHeuristic: true }
      await promoteAdd(add, join(STAGING, dir), SIGNS_DIR, overrides, confirmed)
      committed += applyAdd(add, catalogue, overrides, confirmed).length
    }
  }
  await writeCatalogue(catalogue)
  console.log(`committed ${committed} pictogram(s); rejected ${rejected}`)
}
