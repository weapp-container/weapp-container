import assert from 'node:assert/strict'
import test from 'node:test'
import { definePlugin, validatePluginManifest } from '../dist/index.mjs'

test('validates and freezes a namespaced plugin manifest', () => {
  const manifest = definePlugin({
    id: 'fixture',
    version: '1.0.0',
    protocolVersion: 1,
    apis: [{
      name: 'weappContainer.plugin.fixture.run',
      kind: 'async',
      owner: 'plugin',
      support: 'full',
    }],
    componentNamespaces: ['plugin://fixture/components'],
  })
  assert.equal(Object.isFrozen(manifest), true)
  assert.equal(manifest.apis?.[0].name, 'weappContainer.plugin.fixture.run')
})

test('rejects public and cross-plugin names', () => {
  assert.throws(() => validatePluginManifest({
    id: 'fixture',
    version: '1.0.0',
    protocolVersion: 1,
    apis: [{ name: 'wx.request', kind: 'async', owner: 'plugin', support: 'full' }],
  }))
  assert.throws(() => validatePluginManifest({
    id: 'fixture',
    version: '1.0.0',
    protocolVersion: 1,
    componentNamespaces: ['plugin://other/components'],
  }))
})
