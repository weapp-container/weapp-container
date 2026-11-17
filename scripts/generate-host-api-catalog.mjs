#!/usr/bin/env node
/**
 * Normalize the checked-in portable API catalog.
 *
 * The catalog is authored data. This utility only removes accidental external
 * provenance and sensitive bridge capabilities before writing a deterministic JSON file.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const catalogPath = resolve(root, 'crates/container-runtime/src/host-api-catalog.json')
const inputPath = process.argv[2] ? resolve(process.argv[2]) : catalogPath
const catalog = JSON.parse(await readFile(inputPath, 'utf8'))

catalog.schemaVersion = 1
catalog.protocolVersion = '1.0'
catalog.baseline = { profile: 'portable-runtime', version: '1' }
catalog.apis = (catalog.apis ?? []).map(api => {
    const normalized = { ...api, baseline: api.baseline === 'extension' ? 'extension' : 'included' }
    delete normalized.documentation
    delete normalized.since
    return normalized
  })
  .sort((left, right) => left.name.localeCompare(right.name, 'en'))

await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
console.log(`Portable API catalog normalized: ${catalog.apis.length} APIs`)
