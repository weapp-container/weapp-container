import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { syncPortablePack } from './portable-pack.mjs'
import { canonicalize, sha256 } from '../tools/container-manifest/src/index.mjs'

async function fixture(root) {
  const source = resolve(root, 'source')
  await mkdir(resolve(source, 'blobs/sha256'), { recursive: true })
  const bytes = [Buffer.from('module.exports={}'), Buffer.from('{"version":1,"nodes":[]}'), Buffer.from('{"version":3,"sources":[]}'), Buffer.from('export const value: number = 1')]
  const hashes = bytes.map(sha256)
  for (const [index, hash] of hashes.entries()) await writeFile(resolve(source, 'blobs/sha256', hash), bytes[index])
  const manifest = { schemaVersion: 2, protocolVersion: '1.0', modules: [{ sha256: hashes[0] }], routes: [{}], templates: [{ wxmlAst: `sha256:${hashes[1]}` }], modernView: {
    compiler: 'weapp-container-modern-view', version: '1.0.0', abi: '1.0', target: 'es2022', units: [{ id: `modern:${'1'.repeat(64)}`, executableSha256: hashes[0], sourceMapSha256: hashes[2], sources: [{ path: 'main.view.ts', sha256: hashes[3] }], documents: [{ documentId: 'pages/index/index.wxml', aliases: ['tools'] }] }],
  }, integrity: { algorithm: 'sha256', root: '' } }
  async function save() {
    manifest.integrity.root = ''
    manifest.integrity.root = sha256(Buffer.from(canonicalize(manifest)))
    await writeFile(resolve(source, 'manifest.json'), canonicalize(manifest))
  }
  await save()
  return { source, manifest, hashes, save }
}

test('host pack sync retains modern executable, raw source and source map; bad candidates preserve accepted pack', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'weapp-modern-host-'))
  try {
    const { source, manifest, hashes, save } = await fixture(root)
    const destination = resolve(root, 'destination')
    const receipt = await syncPortablePack({ source, destination })
    assert.equal(receipt.blobCount, 4)
    await syncPortablePack({ source, destination, check: true })
    const accepted = await readFile(resolve(destination, 'manifest.json'))
    await rm(resolve(source, 'blobs/sha256', hashes[2]))
    await assert.rejects(syncPortablePack({ source, destination }), /ENOENT/)
    assert.deepEqual(await readFile(resolve(destination, 'manifest.json')), accepted)
    manifest.schemaVersion = 1
    await save()
    await assert.rejects(syncPortablePack({ source, destination }), /modernView requires/)
    manifest.schemaVersion = 2
    manifest.modernView.abi = '99.0'
    await save()
    await assert.rejects(syncPortablePack({ source, destination }), /unsupported modernView/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('host pack sync accepts explicit renderer v3 and preserves the last pack after invalid profile changes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'weapp-renderer-host-'))
  try {
    const { source, manifest, save } = await fixture(root)
    manifest.schemaVersion = 3
    manifest.routes = [{ path: 'pages/index/index' }]
    manifest.rendering = { version: '1.0', default: 'skia', pages: { 'pages/index/index': 'webview' } }
    await save()
    const destination = resolve(root, 'destination')
    const receipt = await syncPortablePack({ source, destination })
    assert.equal(receipt.blobCount, 4)
    await syncPortablePack({ source, destination, check: true })
    const accepted = await readFile(resolve(destination, 'manifest.json'))
    manifest.rendering.pages['pages/index/index'] = 'unknown'
    await save()
    await assert.rejects(syncPortablePack({ source, destination }), /rendering page/)
    assert.deepEqual(await readFile(resolve(destination, 'manifest.json')), accepted)
    manifest.rendering.pages = { missing: 'webview' }
    await save()
    await assert.rejects(syncPortablePack({ source, destination }), /rendering page/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
