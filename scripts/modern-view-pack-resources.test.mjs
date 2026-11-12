import assert from 'node:assert/strict'
import test from 'node:test'
import { modernViewBlobHashes } from './modern-view-pack-resources.mjs'

const rendering = () => ({ version: '1.0', default: 'skia', pages: { page: 'webview' } })
const modern = () => ({ compiler: 'weapp-container-modern-view', version: '1.0.0', abi: '1.0', target: 'es2022',
  units: [{ id: `modern:${'1'.repeat(64)}`, executableSha256: '2'.repeat(64), sourceMapSha256: '3'.repeat(64),
    sources: [{ path: 'view/main.view.ts', sha256: '4'.repeat(64) }],
    documents: [{ documentId: 'page.wxml', aliases: ['main'] }] }] })

test('pack resource collector validates v1, modern v2, and explicit renderer v3 separately', () => {
  assert.deepEqual(modernViewBlobHashes({ schemaVersion: 1 }), [])
  assert.equal(modernViewBlobHashes({ schemaVersion: 2, modernView: modern() }).length, 3)
  const v3 = { schemaVersion: 3, rendering: rendering(), routes: [{ path: 'page' }] }
  assert.deepEqual(modernViewBlobHashes(v3), [])
  assert.equal(modernViewBlobHashes({ ...v3, modernView: modern() }).length, 3)
  assert.throws(() => modernViewBlobHashes({ schemaVersion: 1, modernView: modern() }), /modernView/)
  assert.throws(() => modernViewBlobHashes({ schemaVersion: 2 }), /modernView/)
  assert.throws(() => modernViewBlobHashes({ schemaVersion: 3 }), /rendering/)
  assert.throws(() => modernViewBlobHashes({ schemaVersion: 1, rendering: rendering() }), /rendering/)
  assert.throws(() => modernViewBlobHashes({ schemaVersion: 2, modernView: modern(), rendering: rendering() }), /rendering/)
})

test('v3 renderer admission cannot bypass profile, version, route, or modern validation', () => {
  const good = { schemaVersion: 3, rendering: rendering(), routes: [{ path: 'page' }] }
  for (const invalid of [null, {}, { ...rendering(), version: '2.0' }, { ...rendering(), default: 'skyline' },
    { ...rendering(), pages: [] }, { ...rendering(), pages: { missing: 'webview' } },
    { ...rendering(), pages: { 'page.wxml': 'webview' } }, { ...rendering(), pages: { page: 'anything' } },
    { ...rendering(), fallback: 'skia' }]) {
    assert.throws(() => modernViewBlobHashes({ ...good, rendering: invalid }), /rendering/)
  }
  assert.throws(() => modernViewBlobHashes({ ...good, modernView: null }), /modernView/)
  const invalid = modern()
  invalid.units[0].executableSha256 = 'invalid'
  assert.throws(() => modernViewBlobHashes({ ...good, modernView: invalid }), /blob hash/)
})
