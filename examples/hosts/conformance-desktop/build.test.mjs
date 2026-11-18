import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { selectExecutable, verifyBuild } from './build.mjs'

const root = '/source', targetDir = '/source/target', target = 'aarch64-apple-darwin'
const artifact = () => ({ reason: 'compiler-artifact', manifest_path: '/source/examples/hosts/conformance-desktop/Cargo.toml',
  target: { name: 'weapp-conformance-desktop', kind: ['bin'], src_path: '/source/examples/hosts/conformance-desktop/src/main.rs' },
  features: ['v8-native'], executable: '/source/target/aarch64-apple-darwin/debug/weapp-conformance-desktop', package_id: 'native-host', fresh: false })
const messages = value => [value, { reason: 'build-finished', success: true }].map(value => JSON.stringify(value)).join('\n')

test('selects only Cargo emitted target executable with the requested engine', () => {
  const selected = selectExecutable(messages(artifact()), { root, targetDir, target, engine: 'v8' })
  assert.equal(selected.path, resolve(targetDir, target, 'debug/weapp-conformance-desktop'))
  for (const mutate of [
    value => value.features.push('quickjs-native'),
    value => { value.manifest_path = '/source/another/Cargo.toml' },
    value => { value.target.src_path = '/source/examples/hosts/desktop-metal/src/main.rs' },
    value => { value.executable = '/source/target/debug/weapp-conformance-desktop' },
  ]) {
    const value = artifact(); mutate(value)
    assert.throws(() => selectExecutable(messages(value), { root, targetDir, target, engine: 'v8' }), /differs/)
  }
  assert.throws(() => selectExecutable(messages(artifact()), { root, targetDir, target, engine: 'quickjs' }), /differs/)
})

test('failed or duplicate Cargo completion/artifact cannot certify an executable', () => {
  const args = { root, targetDir, target, engine: 'v8' }
  assert.throws(() => selectExecutable(JSON.stringify(artifact()), args), /successful build/)
  assert.throws(() => selectExecutable(messages(artifact()) + '\n' + JSON.stringify(artifact()), args), /exactly one/)
  assert.throws(() => selectExecutable(messages(artifact()).replace('"success":true', '"success":false'), args), /successful build/)
})

test('formal driver rejects a diagnostic or dirty receipt before opening its binary', async () => {
  await assert.rejects(verifyBuild('/absent-source', { schemaVersion: 1, kind: 'weapp-conformance-native-build', status: 'diagnostic',
    host: 'macos', engine: 'v8', workingTreeDirty: true }, 'v8'), /Clean successful exact/)
  await assert.rejects(verifyBuild('/absent-source', { schemaVersion: 1, kind: 'weapp-conformance-native-build', status: 'passed',
    host: 'macos', engine: 'v8', workingTreeDirty: true }, 'v8'), /Clean successful exact/)
})
