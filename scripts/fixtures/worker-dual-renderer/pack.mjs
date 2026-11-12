#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packContainer } from '../../../tools/container-manifest/src/index.mjs'

// Hand-authored inputs deliberately use a sentinel compiler commit: the
// packer's fixed weapp-vite name must not imply an upstream build was executed.
const here = dirname(fileURLToPath(import.meta.url)), args = process.argv.slice(2)
assert.equal(args.length, 2, 'Usage: node scripts/fixtures/worker-dual-renderer/pack.mjs --out-dir /new/pack')
assert.equal(args[0], '--out-dir')
const out = resolve(args[1])
assert.ok(out !== here && !out.startsWith(here + sep), 'Pack output must be outside fixture source')
await mkdir(out, { recursive: false })
const result = await packContainer(resolve(here, 'raw'), out, {compilerCommit: 'fixture-worker-dual-renderer-v1', project: resolve(here, 'raw')})
const inputs = []
async function visit(path = '') {
  for (const entry of (await readdir(resolve(here, 'raw', path), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path ? path + '/' + entry.name : entry.name
    assert.ok(entry.isDirectory() || entry.isFile(), 'Fixture inputs must be regular')
    if (entry.isDirectory()) await visit(name)
    else {
      const bytes = await readFile(resolve(here, 'raw', name))
      inputs.push({path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')})
    }
  }
}
await visit()
const manifest = await readFile(result.manifestPath)
const receipt = {schemaVersion: 1, fixture: 'worker-dual-renderer-v1', inputKind: 'hand-authored-public-fixture',
  upstreamBuildExecuted: false, compilerCommit: 'fixture-worker-dual-renderer-v1', inputs,
  manifestSha256: createHash('sha256').update(manifest).digest('hex'), integrityRoot: result.manifest.integrity.root}
await writeFile(resolve(out, 'fixture-source.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({pack: out, manifestSha256: receipt.manifestSha256, integrityRoot: receipt.integrityRoot}))
