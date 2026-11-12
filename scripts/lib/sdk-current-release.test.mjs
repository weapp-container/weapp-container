import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { nativeIdentity } from '../../sdk/desktop/tools/native-input.mjs';
import { nativeProducerFixture } from '../fixtures/sdk-native-producer.mjs';
import { SDK_RELEASE_VERSION, assertCleanNativeSource, assertNativeProducer, assertNativeProducerSet, assertSdkProducer, captureNativeSource, isNativeRuntimeLibrary, verifyNativeProducerFiles } from './sdk-current-release.mjs';

test('runtime bodies and MSVC link interfaces retain distinct verification roles', () => {
  for (const file of ['weapp_container_sdk.dll', 'weapp_container_sdk.lib', 'libweapp_container_sdk.a', 'libweapp_container_sdk.so', 'libweapp_container_sdk.dylib', 'native/weapp_container_sdk.dll']) {
    assert.equal(isNativeRuntimeLibrary(file), true, file);
  }
  for (const file of ['weapp_container_sdk.dll.lib', 'weapp_container_sdk.dll.exp', 'weapp_container_sdk.pdb', 'libc++_shared.so', 'not_weapp_container_sdk.lib']) {
    assert.equal(isNativeRuntimeLibrary(file), false, file);
  }
  const directory = mkdtempSync(resolve(tmpdir(), 'native-link-interface-'));
  try {
    // Import libraries contain linking symbols, never the runtime's embedded
    // policy/font bytes. Their exact original bytes are still mandatory.
    const name = 'weapp_container_sdk.dll.lib', bytes = Buffer.from('inert MSVC link interface; no runtime body');
    const receipt = nativeProducerFixture('x86_64-pc-windows-msvc', { files: { [name]: bytes } });
    Object.assign(receipt, { distributionProfile: 'restricted-showcase', policySha256: 'a'.repeat(64) });
    receipt.features.push('restricted-showcase');
    writeFileSync(resolve(directory, name), bytes);
    assert.doesNotThrow(() => verifyNativeProducerFiles(directory, receipt, receipt.target, receipt));
    writeFileSync(resolve(directory, name), Buffer.from('altered linking symbols'));
    assert.throws(() => verifyNativeProducerFiles(directory, receipt, receipt.target, receipt), /hash\/size/);
    // A runtime DLL with those same non-runtime bytes must still be rejected.
    const dll = nativeProducerFixture('x86_64-pc-windows-msvc', { files: { 'weapp_container_sdk.dll': bytes } });
    Object.assign(dll, { distributionProfile: receipt.distributionProfile, policySha256: receipt.policySha256 });
    dll.features.push('restricted-showcase');
    writeFileSync(resolve(directory, 'weapp_container_sdk.dll'), bytes);
    assert.throws(() => verifyNativeProducerFiles(directory, dll, dll.target, dll), /policy identity/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('new native producers and actual desktop wrapper identity projections require one clean current release source', () => {
  const first = nativeProducerFixture(), second = nativeProducerFixture('x86_64-apple-darwin');
  assert.equal(SDK_RELEASE_VERSION, SDK_RELEASE_VERSION);
  assert.equal(assertNativeProducer(first), first);
  assert.doesNotThrow(() => assertNativeProducer(nativeIdentity(first)));
  assert.doesNotThrow(() => assertNativeProducerSet([first, second], [first.target, second.target]));
  for (const patch of [{ sdkVersion: '0.1.0-preview.5.3' }, { sdkVersion: '0.1.0-preview.5.1' }, { sdkVersion: '0.1.0-preview.5.2' }, { sourceDirty: true }, { sourceDirty: null }, { sourceCommit: null }, { status: 'failed' }, { profile: 'dev' }, { abiVersion: 2 }, { exitCode: 1 }, { features: ['quickjs-native'] }, { artifacts: [] }]) assert.throws(() => assertNativeProducer({ ...first, ...patch }));
  assert.throws(() => assertNativeProducer(first, 'x86_64-apple-darwin'));
  assert.throws(() => assertNativeProducer({ ...first, sourceAfterBuild: { sourceCommit: first.sourceCommit, sourceDirty: true } }), /clean committed source/);
  assert.throws(() => assertNativeProducer({ ...first, sourceBeforePublication: { sourceCommit: '2'.repeat(40), sourceDirty: false } }), /changed during compilation/);
  assert.throws(() => assertNativeProducerSet([first, first]), /distinct/);
  assert.throws(() => assertNativeProducerSet([first, { ...second, sourceCommit: '2'.repeat(40) }]), /one clean producer source/);
  assert.throws(() => assertNativeProducerSet([first], [first.target, second.target]), /Complete/);
  const wrapper = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, sourceCommit: '3'.repeat(40), sourceDirty: false, status: 'verified', native: [nativeIdentity(first)] };
  assert.doesNotThrow(() => assertSdkProducer(wrapper, 'verified', 'macos'));
  for (const patch of [{ sdkVersion: '0.1.0-preview.5.2' }, { sourceDirty: true }, { checks: [{ status: 'blocked' }] }]) assert.throws(() => assertSdkProducer({ ...wrapper, ...patch }, 'verified', 'macos'));
  assert.throws(() => assertSdkProducer(wrapper, 'verified', 'linux'), /platform/);
});

test('native input files bind complete producer hashes and sizes and reject escaping links', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'native-producer-input-'));
  try {
    const binary = Buffer.from('inert native fixture only\n'), receipt = nativeProducerFixture(undefined, { files: { 'libweapp_container_sdk.a': binary } });
    const file = resolve(directory, 'libweapp_container_sdk.a');
    writeFileSync(file, binary);
    assert.doesNotThrow(() => verifyNativeProducerFiles(directory, receipt));
    writeFileSync(file, Buffer.from('different native bytes\n'));
    assert.throws(() => verifyNativeProducerFiles(directory, receipt), /hash\/size/);
    writeFileSync(file, binary);
    const corrupt = structuredClone(receipt); corrupt.artifacts[0].bytes++;
    assert.throws(() => verifyNativeProducerFiles(directory, corrupt), /hash\/size/);
    rmSync(file); symlinkSync('/etc/hosts', file);
    assert.throws(() => verifyNativeProducerFiles(directory, receipt), /symlink/);
    for (const name of ['../escape', 'sub/../escape', '/absolute', 'C:\\escape']) {
      const escaped = structuredClone(receipt); escaped.artifacts[0].file = name;
      assert.throws(() => assertNativeProducer(escaped), /artifact/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('retained Linux hardening binds original compilation and final bytes without rebinding provenance', () => {
  const original = nativeProducerFixture('x86_64-unknown-linux-gnu', { files: { 'libweapp_container_sdk.a': Buffer.from('original static archive') } });
  Object.assign(original, { distributionProfile: 'restricted-showcase', policySha256: 'a'.repeat(64) }); original.features.push('restricted-showcase');
  const text = JSON.stringify(original, null, 2) + '\n', digest = value => createHash('sha256').update(value).digest('hex');
  const final = structuredClone(original), output = Buffer.from('hardened static archive');
  final.artifacts[0] = { file: original.artifacts[0].file, bytes: output.length, sha256: digest(output) };
  final.nativePostProcessing = { schemaVersion: 1, operation: 'retained-native-debug-hardening', compilationExecuted: false,
    source: { sourceCommit: '2'.repeat(40), sourceDirty: false }, originalSourceCommit: original.sourceCommit,
    originalReceipt: { file: 'original-producer-receipt.json', bytes: Buffer.byteLength(text), sha256: digest(text) },
    operations: [{ schemaVersion: 1, file: final.artifacts[0].file, operation: 'strip-debug-static-archive', tool: { name: 'strip', version: 'GNU strip fixture' },
      input: { bytes: original.artifacts[0].bytes, sha256: original.artifacts[0].sha256 }, output: { bytes: output.length, sha256: digest(output) },
      members: 1, removedDebugSections: 1, remainingDebugSections: 0, linkableSectionsSymbolsAndRelocationsPreserved: true, producerSourcePrefixMatches: 0 }] };
  final.originalNativeProducerReceipt = text;
  assert.doesNotThrow(() => assertNativeProducer(final, final.target, final));
  const projected = nativeIdentity(final);
  assert.deepEqual(projected.nativePostProcessing, final.nativePostProcessing);
  assert.equal(Object.hasOwn(projected, 'originalNativeProducerReceipt'), false);
  assert.doesNotThrow(() => assertNativeProducer(projected, final.target, final));
  for (const mutate of [value => { value.nativePostProcessing.source.sourceDirty = true; }, value => { value.nativePostProcessing.originalSourceCommit = 'f'.repeat(40); },
    value => { value.nativePostProcessing.operations[0].input.sha256 = 'f'.repeat(64); }, value => { value.nativePostProcessing.operations[0].output.sha256 = 'f'.repeat(64); },
    value => { value.nativePostProcessing.operations[0].remainingDebugSections = 1; }, value => { value.nativePostProcessing.operations[0].linkableSectionsSymbolsAndRelocationsPreserved = false; },
    value => { value.originalNativeProducerReceipt += ' '; }]) {
    const corrupt = structuredClone(final); mutate(corrupt); assert.throws(() => assertNativeProducer(corrupt, corrupt.target, corrupt));
  }
});

test('production source preflight preserves real dirty state and detects a clean HEAD change', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'native-producer-source-'));
  const git = args => { const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']); };
  try {
    git(['init', '-q']); writeFileSync(resolve(directory, 'Cargo.toml'), '[workspace]\n'); commit();
    const original = captureNativeSource(directory); assert.equal(original.sourceDirty, false); assertCleanNativeSource(original);
    const nested = resolve(directory, 'nested'); mkdirSync(nested);
    assert.throws(() => captureNativeSource(nested), /own source repository/);
    writeFileSync(resolve(directory, 'new.rs'), 'fn dirty() {}\n');
    const dirty = captureNativeSource(directory); assert.equal(dirty.sourceDirty, true);
    assert.throws(() => assertCleanNativeSource(dirty), /clean committed source/);
    assert.equal(dirty.sourceDirty, true, 'rejection must not normalize the failed receipt');
    commit(); const changed = captureNativeSource(directory); assert.equal(changed.sourceDirty, false);
    assert.throws(() => assertCleanNativeSource(changed, original), /changed during compilation/);
    assert.equal(readFileSync(resolve(directory, 'new.rs'), 'utf8'), 'fn dirty() {}\n');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
