#!/usr/bin/env node
// One reviewed host driver per child. The parent owns this process, while the
// driver owns and explicitly releases only the host resources it creates.
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks, isBuiltin } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const [requestPath, resultPath] = process.argv.slice(2)
const request = JSON.parse(await readFile(requestPath, 'utf8'))
// Node canonicalizes module parent URLs (notably /var -> /private/var on
// macOS). Compare canonical identities on both sides of the import boundary.
const allowed = new Set(await Promise.all(request.driverModules.map(async path => pathToFileURL(await realpath(path)).href)))
const identities = new Map(await Promise.all(request.driverInputs.map(async input => {
  const url = pathToFileURL(await realpath(input.file)).href
  if (!allowed.has(url) || !/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0)
    throw new Error('Driver input identity is outside its snapshot closure')
  return [url, input]
})))
if (identities.size !== allowed.size || identities.size !== request.driverInputs.length)
  throw new Error('Driver input identities do not cover its exact snapshot closure')
const verifyBytes = url => {
  const expected = identities.get(url), bytes = readFileSync(fileURLToPath(url))
  if (!expected || bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
    throw new Error('Driver input bytes differ from its snapshot identity: ' + url)
}
const metadata = [...allowed].filter(url => url.endsWith('/package.json'))
for (const url of allowed) verifyBytes(url)
const driverUrl = pathToFileURL(await realpath(request.driverModule)).href
const entryUrl = pathToFileURL(await realpath(fileURLToPath(import.meta.url))).href
if (!allowed.has(driverUrl)) throw new Error('Driver entry is outside its snapshot closure')
const hooks = registerHooks({ resolve(specifier, context, next) {
  // Node resolves literal CJS require(), package exports and extensionless
  // relatives. Check its actual canonical target before any module executes.
  // Package metadata is an input to that resolution and stays byte-bound too.
  for (const url of metadata) verifyBytes(url)
  const resolved = next(specifier, context)
  if (isBuiltin(specifier) && resolved.url.startsWith('node:')) return resolved
  const target = resolved.url
  if (!allowed.has(target) || !allowed.has(context.parentURL) && !(context.parentURL === entryUrl && target === driverUrl)) {
    throw new Error(`Driver import is outside its snapshot closure: ${specifier}`)
  }
  verifyBytes(target)
  return resolved
}, load(url, context, next) {
  if (!url.startsWith('node:')) {
    if (!allowed.has(url)) throw new Error('Driver load is outside its snapshot closure: ' + url)
    verifyBytes(url)
  }
  return next(url, context)
} })
const controller = new AbortController()
const abort = () => controller.abort(new Error('Matrix driver interrupted'))
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
let driver
let candidate
let error
let cleanup = { ownedResourcesReleased: false, borrowedResourcesPreserved: false }
try {
  driver = await import(driverUrl)
  if (typeof driver.run !== 'function' || typeof driver.dispose !== 'function') throw new Error('Driver must export run and dispose')
  controller.signal.throwIfAborted()
  candidate = await driver.run({ ...request.context, signal: controller.signal })
  if (controller.signal.aborted) throw controller.signal.reason
} catch (failure) { error = String(failure?.stack ?? failure) }
finally {
  if (typeof driver?.dispose === 'function') {
    try { cleanup = await driver.dispose({ ...request.context, signal: controller.signal }) }
    catch (failure) { error = [error, `Driver cleanup failed: ${failure?.stack ?? failure}`].filter(Boolean).join('\n') }
  }
  hooks.deregister()
  process.off('SIGINT', abort)
  process.off('SIGTERM', abort)
}
await writeFile(resultPath, JSON.stringify({ candidate, cleanup, ...(error ? { error } : {}) }, null, 2) + '\n', { flag: 'wx' })
if (error || cleanup?.ownedResourcesReleased !== true || cleanup?.borrowedResourcesPreserved !== true) process.exitCode = 1
