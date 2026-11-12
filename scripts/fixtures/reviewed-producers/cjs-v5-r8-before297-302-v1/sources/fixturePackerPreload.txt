// Exact archived module closure for the static portable packer child.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
const config = JSON.parse(readFileSync(process.env.WEAPP_CONTAINER_FIXTURE_PACKER_CONFIG, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const allowed = new Map(config.files.map(item => [item.file, item]))
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context)
  if (result.url.startsWith('node:')) return result
  if (!result.url.startsWith('file:') || !allowed.has(realpathSync(fileURLToPath(result.url)))) throw new Error(`Packer import outside archived closure: ${specifier}`)
  return result
}, load(url, context, next) {
  if (url.startsWith('node:')) return next(url, context)
  const file = realpathSync(fileURLToPath(url)), expected = allowed.get(file), bytes = readFileSync(file)
  if (!expected || hash(bytes) !== expected.sha256 || bytes.length !== expected.bytes) throw new Error('Packer module changed before load')
  const result = next(url, context)
  appendFileSync(config.log, JSON.stringify({ file, sha256: expected.sha256, bytes: expected.bytes,
    pid: process.pid, at: new Date().toISOString(), sourceSha256: result.source == null ? null : hash(Buffer.from(result.source)) }) + '\n')
  return result
} })
