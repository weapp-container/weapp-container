/** Coverage projection after the production fixture-build reader has validated
 * the complete actual generated closure. This does not establish that an
 * original assertion passed, nor replace fixture/compiler/runtime admission. */
import { createHash } from 'node:crypto'
import { descriptor } from './wxml-transform-descriptor.mjs'

export function compiledCoverage({ sourceSha256, generated, readArtifact }) {
  const ensure = (value, message) => { if (!value) throw new Error(message) }
  ensure(sourceSha256 === descriptor.sourceSha256 && Array.isArray(generated) && typeof readArtifact === 'function',
    'Wxml compiled coverage requires the pinned source and a validated generated closure reader')
  const members = new Map()
  for (const item of generated) {
    ensure(item && typeof item.path === 'string' && !item.path.includes('\\') && item.path.split('/').every(part => part && part !== '.' && part !== '..')
      && !members.has(item.path) && item.kind === 'file', 'Wxml compiled coverage member path/kind is unsafe, duplicate or absent')
    const ref = item.artifact
    ensure(ref && Object.keys(ref).sort().join(',') === 'bytes,path,sha256' && typeof ref.path === 'string' && !ref.path.includes('\\')
      && ref.path.split('/').every(part => part && part !== '.' && part !== '..')
      && /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0,
    'Wxml compiled coverage member artifact is malformed')
    members.set(item.path, item)
  }
  return descriptor.compiledFiles.map(path => {
    const item = members.get(path)
    ensure(item, `Wxml original compiled artifact access is uncovered: ${path}`)
    const bytes = readArtifact(item.artifact)
    ensure(Buffer.isBuffer(bytes) && bytes.length === item.artifact.bytes
      && createHash('sha256').update(bytes).digest('hex') === item.artifact.sha256,
    'Wxml compiled coverage artifact bytes differ from the admitted actual generation')
    return { path, sha256: item.artifact.sha256, bytes: bytes.length, source: 'captured-generated-member' }
  })
}
