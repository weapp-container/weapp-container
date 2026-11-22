import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { canonicalize } from '../../tools/container-manifest/src/json-integrity.mjs'
import { adaptNativeSkiaPack } from './native-skia-pack.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('native Skia pack adaptation rewrites every route and refreshes manifest integrity', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'native-skia-pack-'))
  try {
    const manifest = {
      schemaVersion: 3,
      protocolVersion: '1.0',
      routes: [{ path: 'pages/home/index' }, { path: 'pages/detail/index' }],
      rendering: { version: '1.0', default: 'webview', pages: { 'pages/home/index': 'webview' } },
      integrity: { algorithm: 'sha256', root: '' },
    }
    const unsigned = structuredClone(manifest)
    manifest.integrity.root = sha256(Buffer.from(canonicalize(unsigned)))
    mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest))

    const result = await adaptNativeSkiaPack(directory)
    const adapted = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
    const adaptedUnsigned = structuredClone(adapted)
    adaptedUnsigned.integrity.root = ''

    assert.deepEqual(result.source, manifest.rendering)
    assert.deepEqual(result.effective, {
      version: '1.0', default: 'skia',
      pages: { 'pages/home/index': 'skia', 'pages/detail/index': 'skia' },
    })
    assert.equal(adapted.integrity.root, sha256(Buffer.from(canonicalize(adaptedUnsigned))))
    assert.equal(result.integrityRoot, adapted.integrity.root)
    assert.equal(result.manifestSha256, sha256(readFileSync(resolve(directory, 'manifest.json'))))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
