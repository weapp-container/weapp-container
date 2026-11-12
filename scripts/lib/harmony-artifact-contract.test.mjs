import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { assertHarmonyNativeRelease, collectHarmonyGeneratedMetadata, HARMONY_RELEASE_FEATURES, inspectHarmonyHap, preserveHarmonyNativeLibraries } from './harmony-artifact-contract.mjs'
import { SDK_RELEASE_VERSION } from './sdk-current-release.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value))
const context = () => Object.fromEntries([
  ['entry', false, 'src/main/'], ['libentry.so', true, ''],
].map(([name, isSO, entryPath]) => [name, { isSO, moduleName: '', bundleName: '', dependencyAlias: '', packageName: name, entryPath, version: '' }]))
function rpcid(api, capabilities) {
  const header = Buffer.from([0, api | 128, 0, 2, capabilities.length & 255, capabilities.length >> 8])
  return Buffer.concat([header, ...capabilities.map(value => { const record = Buffer.alloc(256); record.write(value.slice(17)); return record })])
}
function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'harmony-metadata-contract-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const native = Buffer.alloc(96); native.set([127, 69, 76, 70, 2, 1]); native.writeUInt16LE(183, 18)
  const input = { api_version: 24, syscap: ['SystemCapability.ArkUI.ArkUI.Circle', 'SystemCapability.ArkUI.ArkUI.Full'] }
  const intermediate = resolve(directory, 'entry/build/default/intermediates')
  mkdirSync(resolve(intermediate, 'syscap/default'), { recursive: true })
  mkdirSync(resolve(intermediate, 'loader/default'), { recursive: true })
  writeFileSync(resolve(intermediate, 'syscap/default/rpcid.json'), json(input))
  const entries = new Map([
    ['rpcid.sc', rpcid(input.api_version, input.syscap)], ['pkgContextInfo.json', json(context())],
  ])
  for (const [name, bytes] of entries) {
    // The loader and official packing-tool use different JSON field orders.
    const compilerInput = name === 'pkgContextInfo.json' ? json(Object.fromEntries(Object.entries(context()).map(([name, value]) => [name, Object.fromEntries(Object.entries(value).reverse())]))) : bytes
    writeFileSync(resolve(intermediate, name === 'rpcid.sc' ? `syscap/default/${name}` : `loader/default/${name}`), compilerInput)
  }
  const metadata = collectHarmonyGeneratedMetadata(directory), hap = resolve(directory, 'finite.hap')
  const expected = { sha256: hash(native), bytes: native.length }
  const make = (files = entries, rust = native) => {
    const result = spawnSync('python3', ['-c', `import base64,json,sys,zipfile
v=json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1],'w') as z:
 for p in ('module.json','resources.index','ets/modules.abc'):z.writestr(p,b'finite')
 for p in ('libs/arm64-v8a/libentry.so','libs/arm64-v8a/libcontainer_host_harmony.so'):z.writestr(p,base64.b64decode(v['rust']))
 for p,b in v['files']:z.writestr(p,base64.b64decode(b))`, hap], {
      input: JSON.stringify({ rust: rust.toString('base64'), files: [...files].map(([path, bytes]) => [path, bytes.toString('base64')]) }), encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return hap
  }
  return { directory, intermediate, entries, metadata, native, expected, make, hap }
}
function rebound(metadata, path, bytes) {
  return metadata.map(item => item.path === path ? { ...item, sha256: hash(bytes), size: bytes.length } : item)
}

test('restricted Harmony native identity requires the exact compiled policy and explicit expected distribution', t => {
  const f = fixture(t), identity = { distributionProfile: 'restricted-showcase', policySha256: 'b'.repeat(64) }
  const bytes = Buffer.concat([f.native, Buffer.from(`weapp-container-distribution:restricted-showcase:${identity.policySha256}\0`)])
  const library = resolve(f.directory, 'libcontainer_host_harmony.so'); writeFileSync(library, bytes)
  const source = { sourceCommit: 'a'.repeat(40), sourceDirty: false }
  const platform = { platform: 'harmony', ...identity, status: 'passed', mode: 'build', profile: 'release', target: 'aarch64-unknown-linux-ohos', engine: 'quickjs',
    features: [...HARMONY_RELEASE_FEATURES, 'restricted-showcase'].join(','), cargo: { status: 'passed', exitCode: 0 },
    artifact: { path: 'target/aarch64-unknown-linux-ohos/release/libcontainer_host_harmony.so', exists: true, bytes: bytes.length, sha256: hash(bytes) } }
  const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, ...identity, commit: source.sourceCommit, mode: 'build', profile: 'release', sourceBefore: source, sourceAfter: source, platforms: [platform] }
  assert.throws(() => assertHarmonyNativeRelease(report, library), /mismatch/)
  assert.equal(assertHarmonyNativeRelease(report, library, identity).policySha256, identity.policySha256)
  assert.throws(() => assertHarmonyNativeRelease(report, library, { ...identity, policySha256: 'c'.repeat(64) }), /mismatch/)
  writeFileSync(library, f.native); platform.artifact.bytes = f.native.length; platform.artifact.sha256 = hash(f.native)
  assert.throws(() => assertHarmonyNativeRelease(report, library, identity), /missing the exact distribution/)
})

test('Harmony disables native symbol stripping in the copied base and build mode profiles without mutating source', () => {
  const source = { buildOption: { externalNativeOptions: { arguments: 'retained' }, nativeLib: { filter: { excludes: [] }, debugSymbol: { strip: true, exclude: ['keep.so'] } } }, buildOptionSet: [{ name: 'release', nativeLib: { debugSymbol: { strip: true } } }] }
  const before = structuredClone(source), copied = preserveHarmonyNativeLibraries(source)
  assert.deepEqual(source, before)
  assert.deepEqual(copied.buildOption.nativeLib.debugSymbol, { strip: false, exclude: [] })
  assert.deepEqual(copied.buildOptionSet[0].nativeLib.debugSymbol, { strip: false, exclude: [] })
  assert.equal(copied.buildOption.externalNativeOptions.arguments, 'retained')
  assert.deepEqual(copied.buildOption.nativeLib.filter, { excludes: [] })
})

test('Harmony accepts exact, independently checked official metadata and still rejects a stripped native library', t => {
  const f = fixture(t)
  const compilerInput = readFileSync(resolve(f.intermediate, 'loader/default/pkgContextInfo.json'))
  assert.notEqual(hash(compilerInput), hash(f.entries.get('pkgContextInfo.json')))
  assert.equal(f.metadata.find(item => item.path === 'pkgContextInfo.json').inputSha256, hash(compilerInput))
  assert.equal(inspectHarmonyHap(f.make(), f.expected, { metadata: f.metadata }).length, 7)
  assert.throws(() => inspectHarmonyHap(f.hap, f.expected), /unreviewed HAP delivery member/)
  assert.throws(() => inspectHarmonyHap(f.make(f.entries, f.native.subarray(0, 80)), f.expected, { metadata: f.metadata }), /packaged Rust library differs/)
  const missing = new Map(f.entries); missing.delete('rpcid.sc')
  assert.throws(() => inspectHarmonyHap(f.make(missing), f.expected, { metadata: f.metadata }), /missing compiler metadata/)
})

test('Rehashed package metadata cannot smuggle unknown fields, duplicate fields, paths or boolean coercions', t => {
  const f = fixture(t)
  for (const mutate of [
    value => { value.entry.sourceFile = '/private/source.ets' },
    value => { value.entry.entryPath = '../../private/' },
    value => { value.entry.isSO = 0 },
    value => { value.other = structuredClone(value.entry) },
  ]) {
    const value = context(); mutate(value)
    const bytes = json(value), files = new Map(f.entries).set('pkgContextInfo.json', bytes)
    assert.throws(() => inspectHarmonyHap(f.make(files), f.expected, { metadata: rebound(f.metadata, 'pkgContextInfo.json', bytes) }), /unreviewed package context fields/)
  }
  const bytes = Buffer.from(json(context()).toString().replace('"bundleName":""', '"bundleName":"private","bundleName":""'))
  assert.throws(() => inspectHarmonyHap(f.make(new Map(f.entries).set('pkgContextInfo.json', bytes)), f.expected, { metadata: rebound(f.metadata, 'pkgContextInfo.json', bytes) }), /duplicate metadata field/)
})

test('Rehashed RPC metadata must retain its exact bounded capability schema, padding, API and compiler identity', t => {
  const f = fixture(t)
  for (const mutate of [
    bytes => { bytes[1] = 128 | 23 },
    bytes => { bytes[20] ^= 1 },
    bytes => { bytes[255] = 1 },
  ]) {
    const bytes = Buffer.from(f.entries.get('rpcid.sc')); mutate(bytes)
    assert.throws(() => inspectHarmonyHap(f.make(new Map(f.entries).set('rpcid.sc', bytes)), f.expected, { metadata: rebound(f.metadata, 'rpcid.sc', bytes) }), /invalid RPCID v2/)
  }
  for (const mutate of [
    items => { items[0].unknown = 'private' },
    items => { items[0].path = 'resources/rpcid.sc' },
    items => { items[0].systemCapabilities[0] = 'SystemCapability.ArkUI.\n' },
    items => { items[0].systemCapabilities.push(items[0].systemCapabilities[0]) },
  ]) {
    const metadata = structuredClone(f.metadata); mutate(metadata)
    assert.throws(() => inspectHarmonyHap(f.make(), f.expected, { metadata }), /metadata|capability/)
  }
  const changed = new Map(f.entries).set('rpcid.sc', Buffer.from('arbitrary private payload'))
  assert.throws(() => inspectHarmonyHap(f.make(changed), f.expected, { metadata: f.metadata }), /differs from compiler output/)
})

test('Harmony metadata collection rejects unknown compiler input fields and never treats a report field as a source path', t => {
  const f = fixture(t)
  const path = resolve(f.intermediate, 'syscap/default/rpcid.json'), input = JSON.parse(readFileSync(path))
  input.private = 'file:///private/source'
  writeFileSync(path, json(input))
  assert.throws(() => collectHarmonyGeneratedMetadata(f.directory))
})

test('Compiler context and RPC duplicates are rejected before normalization can discard them', t => {
  const f = fixture(t)
  for (const [relative, mutate] of [
    ['loader/default/pkgContextInfo.json', value => value.replace('"bundleName":""', '"bundleName":"private","bundleName":""')],
    ['loader/default/pkgContextInfo.json', value => value.replace('{"entry":', '{"entry":{},"entry":')],
    ['syscap/default/rpcid.json', value => value.replace('"api_version":24', '"api_version":1,"api_version":24')],
    ['syscap/default/rpcid.json', value => value.replace('"syscap":', '"syscap":[],"syscap":')],
  ]) {
    const path = resolve(f.intermediate, relative), original = readFileSync(path, 'utf8'), duplicate = mutate(original)
    assert.notEqual(duplicate, original)
    writeFileSync(path, duplicate)
    try { assert.throws(() => collectHarmonyGeneratedMetadata(f.directory), /duplicate compiler JSON field/) }
    finally { writeFileSync(path, original) }
  }
})
