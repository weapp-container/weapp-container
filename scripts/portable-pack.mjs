#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalize, sha256 } from '../tools/container-manifest/src/json-integrity.mjs'

import { modernViewBlobHashes } from './modern-view-pack-resources.mjs'

const digestPattern = /^[0-9a-f]{64}$/

async function filesUnder(directory) {
  try { await access(directory) } catch { return [] }
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`pack must not contain symlinks: ${entry.name}`)
    if (entry.isDirectory()) {
      for (const child of await filesUnder(resolve(directory, entry.name))) files.push(`${entry.name}/${child}`)
    } else files.push(entry.name)
  }
  return files.sort()
}

export async function syncPortablePack({ source, destination, check = false }) {
  source = resolve(source)
  destination = resolve(destination)
  if (source === destination || source.startsWith(destination + '/') || destination.startsWith(source + '/')) {
    throw new Error('source and destination packs must be separate directories')
  }
  const manifestBytes = await readFile(resolve(source, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  if (![1, 2, 3].includes(manifest.schemaVersion) || manifest.integrity?.algorithm !== 'sha256' || !digestPattern.test(manifest.integrity.root)) {
    throw new Error('expected schema v1/v2/v3 SHA-256 portable pack')
  }
  const unsigned = structuredClone(manifest)
  unsigned.integrity.root = ''
  if (sha256(Buffer.from(canonicalize(unsigned))) !== manifest.integrity.root) throw new Error('manifest integrity root mismatch')
  const hashes = new Set(modernViewBlobHashes(manifest))
  function addDigest(reference, label) {
    const hash = typeof reference === 'string' ? reference.replace(/^sha256:/, '') : ''
    if (!digestPattern.test(hash)) throw new Error(`invalid ${label} digest`)
    hashes.add(hash)
  }
  for (const [collection, field] of [['modules', 'sha256'], ['viewScripts', 'sha256'], ['templates', 'wxmlAst'], ['styles', 'wxssIr'], ['assets', 'sha256']]) {
    for (const item of manifest[collection] ?? []) {
      addDigest(item[field], `${collection}.${field}`)
    }
  }
  if (manifest.viewCompilation !== undefined) {
    const compilation = manifest.viewCompilation
    if (!compilation || typeof compilation !== 'object' || Array.isArray(compilation)
        || !Array.isArray(compilation.modules) || !Array.isArray(compilation.documents)) {
      throw new Error('viewCompilation must declare modules and documents arrays')
    }
    for (const module of compilation.modules) {
      addDigest(module?.sourceSha256, 'viewCompilation.modules.sourceSha256')
      addDigest(module?.executableSha256, 'viewCompilation.modules.executableSha256')
    }
    for (const document of compilation.documents) {
      addDigest(document?.wxmlAst, 'viewCompilation.documents.wxmlAst')
      if (!Array.isArray(document?.expressions)) throw new Error('viewCompilation document must declare expressions array')
      for (const expression of document.expressions) {
        addDigest(expression?.executableSha256, 'viewCompilation.documents.expressions.executableSha256')
      }
    }
  }
  if (!manifest.modules?.length || !manifest.routes?.length || !manifest.templates?.length) throw new Error('pack needs modules, routes and templates')
  const files = ['manifest.json', ...[...hashes].sort().map(hash => `blobs/sha256/${hash}`)].sort()
  const inputBytes = new Map([['manifest.json', manifestBytes]])
  for (const file of files) {
    const path = resolve(source, file)
    if (!(await lstat(path)).isFile()) throw new Error(`pack file is not regular: ${file}`)
    const bytes = await readFile(path)
    if (file !== 'manifest.json' && sha256(bytes) !== file.split('/').at(-1)) throw new Error(`blob SHA-256 mismatch: ${file}`)
    inputBytes.set(file, bytes)
  }
  for (const asset of manifest.assets ?? []) {
    const hash = asset.sha256.replace(/^sha256:/, '')
    if (!Number.isSafeInteger(asset.size) || asset.size < 0 || inputBytes.get(`blobs/sha256/${hash}`).length !== asset.size) throw new Error(`asset size mismatch: ${asset.path}`)
  }
  if (check) {
    const actualFiles = await filesUnder(destination)
    if (JSON.stringify(actualFiles) !== JSON.stringify(files)) throw new Error('portable pack file inventory differs')
    for (const file of files) if (!(await readFile(resolve(destination, file))).equals(inputBytes.get(file))) throw new Error(`iOS pack bytes differ: ${file}`)
  } else {
    const staging = `${destination}.stage-${randomUUID()}`
    const backup = `${destination}.backup-${randomUUID()}`
    let moved = false
    try {
      await mkdir(resolve(staging, 'blobs/sha256'), { recursive: true })
      for (const file of files) await writeFile(resolve(staging, file), inputBytes.get(file))
      try { await rename(destination, backup); moved = true } catch (error) { if (error.code !== 'ENOENT') throw error }
      try { await rename(staging, destination) }
      catch (error) { if (moved) await rename(backup, destination); throw error }
      if (moved) await rm(backup, { recursive: true })
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  return { schemaVersion: 1, mode: check ? 'check' : 'sync', source, destination, integrityRoot: manifest.integrity.root, blobCount: hashes.size, files }
}
