import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { compiledCoverage } from './wxml-transform-artifacts.mjs'
import { descriptor } from './wxml-transform-descriptor.mjs'

function fixture() {
  const objects = new Map()
  const generated = [...descriptor.compiledFiles, 'app.json'].map(path => {
    const data = Buffer.from(`actual synthetic compiled bytes for ${path}`), sha256 = createHash('sha256').update(data).digest('hex')
    objects.set(sha256, data)
    return { path, kind: 'file', artifact: { path: `objects/${sha256}`, sha256, bytes: data.length } }
  })
  return { sourceSha256: descriptor.sourceSha256, generated, readArtifact: ref => objects.get(ref.sha256) }
}
test('all six original access members are bound to their captured bytes without evaluating expected WXML patterns', () => {
  const f = fixture(), coverage = compiledCoverage(f)
  assert.deepEqual(coverage.map(item => item.path), descriptor.compiledFiles)
  for (let index = 0; index < coverage.length; index++) assert.deepEqual(coverage[index], {
    path: f.generated[index].path, sha256: f.generated[index].artifact.sha256, bytes: f.generated[index].artifact.bytes, source: 'captured-generated-member',
  })
  assert.equal(JSON.stringify(coverage).includes('passed'), false)
})
test('no missing JS/JSON/WXML file can be replaced by another generated output', () => {
  for (const path of descriptor.compiledFiles) {
    const f = fixture(); f.generated = f.generated.filter(item => item.path !== path)
    assert.throws(() => compiledCoverage(f), /uncovered/)
  }
})
test('foreign source, duplicate/unsafe path, symlink, malformed reference and altered payload are rejected', () => {
  for (const mutate of [
    f => { f.sourceSha256 = 'f'.repeat(64) },
    f => { f.generated.push(structuredClone(f.generated[0])) },
    f => { f.generated[0].path = '../outside.wxml' },
    f => { f.generated[0].path = '/outside.wxml' },
    f => { f.generated[0].path = 'pages\\outside.wxml' },
    f => { f.generated[0].kind = 'link' },
    f => { f.generated[0].artifact.bytes++ },
    f => { f.generated[0].artifact.extra = true },
    f => { f.readArtifact = () => Buffer.from('other bytes') },
    f => { f.readArtifact = () => undefined },
  ]) {
    const f = fixture(); mutate(f); assert.throws(() => compiledCoverage(f), /pinned|unsafe|malformed|differ/)
  }
})
