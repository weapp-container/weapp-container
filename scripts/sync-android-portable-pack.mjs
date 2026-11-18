#!/usr/bin/env node

/**
 * Copy a verified portable manifest/blob pack into the Android sample assets.
 *
 * Android loads this directory before creating a runtime session. Validate the
 * content-addressed input here as well so a stale or partially generated pack
 * cannot be checked in by accident.
 */

import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { modernViewBlobHashes } from './modern-view-pack-resources.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
let source = resolve(root, 'artifacts/reference')
let destination = resolve(root, 'examples/hosts/android/app/src/main/assets/portable-pack')
let checkOnly = false
for (let index = 0; index < args.length; index++) {
  const argument = args[index]
  if (argument === '--check') checkOnly = true
  else if (argument === '--source' || argument === '--destination') {
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    if (argument === '--source') source = resolve(root, value)
    else destination = resolve(root, value)
  } else throw new Error(`unknown argument: ${argument}`)
}
if (source === destination || source.startsWith(destination + sep) || destination.startsWith(source + sep)) {
  throw new Error('source and destination packs must be separate directories')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonical(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digestPointer(pointer, label) {
  if (typeof pointer !== 'string') throw new Error(`${label} is not a SHA-256 pointer`)
  const digest = pointer.startsWith('sha256:')
    ? pointer.slice('sha256:'.length)
    : pointer
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${label} is not a SHA-256 pointer`)
  return digest
}

function referencedDigests(manifest) {
  if (Object.hasOwn(manifest, 'viewCompilation')) {
    const compilation = manifest.viewCompilation
    if (compilation === null || typeof compilation !== 'object' || Array.isArray(compilation)
      || !Array.isArray(compilation.modules) || !Array.isArray(compilation.documents)) {
      throw new Error('viewCompilation must be an object with modules and documents arrays')
    }
    for (const document of compilation.documents) {
      if (document === null || typeof document !== 'object' || Array.isArray(document) || !Array.isArray(document.expressions)) {
        throw new Error('viewCompilation documents must contain expressions arrays')
      }
    }
  }
  const digests = new Set(modernViewBlobHashes(manifest))
  for (const module of manifest.modules || []) digests.add(digestPointer(module.sha256, `module ${module.id}`))
  for (const script of manifest.viewScripts || []) digests.add(digestPointer(script.sha256, `view script ${script.id}`))
  for (const style of manifest.styles || []) digests.add(digestPointer(style.wxssIr, `style ${style.id}`))
  for (const template of manifest.templates || []) digests.add(digestPointer(template.wxmlAst, `template ${template.id}`))
  for (const asset of manifest.assets || []) digests.add(digestPointer(asset.sha256, `asset ${asset.path}`))
  for (const module of manifest.viewCompilation?.modules || []) {
    digests.add(digestPointer(module.sourceSha256, `compiled module ${module.id} source`))
    digests.add(digestPointer(module.executableSha256, `compiled module ${module.id} executable`))
  }
  for (const document of manifest.viewCompilation?.documents || []) {
    digests.add(digestPointer(document.wxmlAst, `compiled document ${document.documentId}`))
    for (const expression of document.expressions || []) {
      digests.add(digestPointer(expression.executableSha256, `compiled expression in ${document.documentId}`))
    }
  }
  return [...digests].sort()
}

async function validatePack() {
  const manifestPath = resolve(source, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`portable pack is missing manifest.json: ${source}`)
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes)
  if (![1, 2, 3].includes(manifest.schemaVersion) || manifest.integrity?.algorithm !== 'sha256') {
    throw new Error('only schema v1/v2/v3 SHA-256 packs are supported')
  }
  const expectedRoot = manifest.integrity?.root
  const unsigned = structuredClone(manifest)
  unsigned.integrity.root = ''
  if (sha256(Buffer.from(canonical(unsigned))) !== expectedRoot) {
    throw new Error('manifest integrity root mismatch')
  }
  const digests = referencedDigests(manifest)
  for (const digest of digests) {
    const blobPath = resolve(source, 'blobs', 'sha256', digest)
    if (!existsSync(blobPath)) throw new Error(`manifest blob is missing: ${digest}`)
    if (sha256(await readFile(blobPath)) !== digest) throw new Error(`manifest blob digest mismatch: ${digest}`)
  }
  return { manifestBytes, manifest, digests }
}

async function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const entries = []
  for (const name of await readdir(directory, { withFileTypes: true })) {
    if (name.isDirectory()) {
      for (const child of await filesUnder(resolve(directory, name.name))) entries.push(`${name.name}/${child}`)
    } else entries.push(name.name)
  }
  return entries.sort()
}

const pack = await validatePack()
// Preserve auxiliary diagnostics/capability files alongside the manifest and
// blob store. They are useful to the sample and are checked by hash too.
const expected = await filesUnder(source)
if (checkOnly) {
  const actual = await filesUnder(destination)
  const missing = expected.filter(file => !actual.includes(file))
  const extra = actual.filter(file => !expected.includes(file))
  if (missing.length || extra.length) {
    throw new Error(`asset pack differs (missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'})`)
  }
  for (const relative of expected) {
    const sourceBytes = await readFile(resolve(source, relative))
    const destinationBytes = await readFile(resolve(destination, relative))
    if (sha256(sourceBytes) !== sha256(destinationBytes)) throw new Error(`asset pack differs: ${relative}`)
  }
} else {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(destination)) await rm(resolve(destination, entry), { recursive: true, force: true })
  await cp(source, destination, { recursive: true })
}

console.log(JSON.stringify({
  schemaVersion: 1,
  source,
  destination,
  mode: checkOnly ? 'check' : 'sync',
  integrityRoot: pack.manifest.integrity.root,
  blobCount: pack.digests.length,
  files: expected,
}, null, 2))
