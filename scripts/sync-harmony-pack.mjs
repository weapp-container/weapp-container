#!/usr/bin/env node
/**
 * Copy a verified portable container pack into the Harmony rawfile bundle.
 *
 * Harmony resources are part of the HAP, so the ArkTS sample must consume a
 * real manifest/blob store instead of carrying an inline fixture. This helper
 * keeps that copy deterministic while retaining the source pack's hashes.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { modernViewBlobHashes } from './modern-view-pack-resources.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)

function valueAfter(flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const source = resolve(root, valueAfter('--pack', 'artifacts/reference'))
const destination = resolve(root, valueAfter(
  '--out',
  'examples/hosts/harmony/entry/src/main/resources/rawfile',
))
const checkOnly = args.includes('--check')

function fail(message) {
  console.error(`sync-harmony-pack: ${message}`)
  process.exitCode = 1
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function pointerHash(pointer, label) {
  if (typeof pointer !== 'string') throw new Error(`${label} must be a string`)
  const hash = pointer.startsWith('sha256:') ? pointer.slice('sha256:'.length) : pointer
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} is not a SHA-256 pointer: ${pointer}`)
  return hash
}

function collectHashes(manifest) {
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
  const hashes = new Set(modernViewBlobHashes(manifest))
  for (const module of manifest.modules || []) hashes.add(pointerHash(module.sha256, `module ${module.id}`))
  for (const script of manifest.viewScripts || []) hashes.add(pointerHash(script.sha256, `view script ${script.id}`))
  for (const style of manifest.styles || []) hashes.add(pointerHash(style.wxssIr, `style ${style.id}`))
  for (const template of manifest.templates || []) hashes.add(pointerHash(template.wxmlAst, `template ${template.id}`))
  for (const asset of manifest.assets || []) hashes.add(pointerHash(asset.sha256, `asset ${asset.path}`))
  for (const module of manifest.viewCompilation?.modules || []) {
    hashes.add(pointerHash(module.sourceSha256, `compiled module ${module.id} source`))
    hashes.add(pointerHash(module.executableSha256, `compiled module ${module.id} executable`))
  }
  for (const document of manifest.viewCompilation?.documents || []) {
    hashes.add(pointerHash(document.wxmlAst, `compiled document ${document.documentId}`))
    for (const expression of document.expressions || []) {
      hashes.add(pointerHash(expression.executableSha256, `compiled expression in ${document.documentId}`))
    }
  }
  return [...hashes].sort()
}

function canonical(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function checkSource() {
  const manifestPath = resolve(source, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`)
  const manifestBytes = readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes)
  if (![1, 2, 3].includes(manifest.schemaVersion) || manifest.integrity?.algorithm !== 'sha256') {
    throw new Error('only schema v1/v2/v3 SHA-256 packs are supported')
  }
  const unsigned = structuredClone(manifest)
  unsigned.integrity.root = ''
  if (createHash('sha256').update(canonical(unsigned)).digest('hex') !== manifest.integrity.root) {
    throw new Error('manifest integrity root mismatch')
  }
  const hashes = collectHashes(manifest)
  for (const hash of hashes) {
    const blob = resolve(source, 'blobs', 'sha256', hash)
    if (!existsSync(blob)) throw new Error(`manifest blob is missing: ${hash}`)
    if (digest(blob) !== hash) throw new Error(`manifest blob digest mismatch: ${hash}`)
  }
  return { manifestBytes, manifest, hashes }
}

function listRelativeFiles(directory) {
  if (!existsSync(directory)) return []
  const output = []
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name)
    if (statSync(path).isDirectory()) {
      for (const child of listRelativeFiles(path)) output.push(`${name}/${child}`)
    } else {
      output.push(name)
    }
  }
  return output.sort()
}

try {
  if (source === destination || source.startsWith(destination + sep) || destination.startsWith(source + sep)) {
    throw new Error('source and destination packs must be separate directories')
  }
  const { manifestBytes, manifest, hashes } = checkSource()
  const expected = [
    'manifest.json',
    ...hashes.map(hash => `blobs/sha256/${hash}`),
  ]
  if (checkOnly) {
    const actual = listRelativeFiles(destination)
    const missing = expected.filter(file => !actual.includes(file))
    const extra = actual.filter(file => !expected.includes(file))
    if (missing.length || extra.length) {
      throw new Error(`rawfile pack differs (missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'})`)
    }
    for (const file of expected) {
      const sourcePath = resolve(source, file)
      const destinationPath = resolve(destination, file)
      if (digest(sourcePath) !== digest(destinationPath)) throw new Error(`rawfile differs: ${file}`)
    }
  } else {
    mkdirSync(resolve(destination, 'blobs', 'sha256'), { recursive: true })
    // Only generated pack files are removed. Parent resource files (images,
    // profiles and elements) stay untouched.
    const oldManifest = resolve(destination, 'manifest.json')
    if (existsSync(oldManifest)) rmSync(oldManifest)
    const oldBlobs = resolve(destination, 'blobs', 'sha256')
    if (existsSync(oldBlobs)) rmSync(oldBlobs, { recursive: true, force: true })
    mkdirSync(oldBlobs, { recursive: true })
    writeFileSync(resolve(destination, 'manifest.json'), manifestBytes)
    for (const hash of hashes) {
      copyFileSync(resolve(source, 'blobs', 'sha256', hash), resolve(oldBlobs, hash))
    }
  }
  const report = {
    schemaVersion: 1,
    source,
    destination,
    mode: checkOnly ? 'check' : 'sync',
    manifestSha256: digest(resolve(source, 'manifest.json')),
    integrityRoot: manifest.integrity.root,
    blobCount: hashes.length,
    files: expected,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
