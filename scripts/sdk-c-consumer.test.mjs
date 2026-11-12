import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cConsumerCompileArguments, stageCConsumerNativeInput } from './lib/sdk-c-consumer-input.mjs';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractDirectory = resolve(root, 'sdk/contract/include');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'sdk-c-closure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const nativeDirectory = resolve(directory, 'native'); mkdirSync(nativeDirectory);
  const files = new Map([['libweapp_container_sdk.so', Buffer.from('finite receipt validation bytes; never linked or executed')],
    ...['weapp_container_sdk.h', 'weapp_container_sdk_gl.h'].map(file => [file, readFileSync(resolve(contractDirectory, file))])]);
  for (const [file, bytes] of files) writeFileSync(resolve(nativeDirectory, file), bytes);
  const receipt = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, abiVersion: 1, status: 'built', profile: 'release',
    target: 'x86_64-unknown-linux-gnu', platform: 'linux', sourceCommit: 'a'.repeat(40), sourceDirty: false,
    features: ['quickjs-native', 'skia-gpu-gles'], viewDiagnostics: 'off',
    artifacts: [...files].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha(bytes) })) };
  const save = () => writeFileSync(resolve(nativeDirectory, 'build.json'), JSON.stringify(receipt)); save();
  const destination = resolve(directory, 'consumer');
  return { nativeDirectory, receipt, save, destination, input: () => stageCConsumerNativeInput({ nativeDirectory, contractDirectory, target: receipt.target, destination }) };
}

test('the relocated C consumer receives both reviewed ABI headers and compiles its actual fixture with the runtime version', t => {
  const f = fixture(t), input = f.input();
  assert.deepEqual(input.files.map(value => value.file), ['libweapp_container_sdk.so', 'weapp_container_sdk.h', 'weapp_container_sdk_gl.h']);
  for (const file of input.files) {
    const staged = resolve(f.destination, file.file.endsWith('.h') ? 'include' : 'lib', file.file);
    assert.equal(sha(readFileSync(staged)), file.sha256);
  }
  assert.equal(input.receiptSha256, sha(readFileSync(resolve(f.nativeDirectory, 'build.json'))));
  copyFileSync(resolve(root, 'crates/container-sdk-ffi/tests/c_consumer.c'), resolve(f.destination, 'consumer.c'));
  const args = cConsumerCompileArguments({ directory: f.destination, target: f.receipt.target, sdkVersion: input.receipt.sdkVersion });
  // Compile the real downstream fixture, without executing the finite byte
  // library above. Real linking/execution belongs to sdk-c-consumer.mjs.
  const result = spawnSync(process.env.CC || 'cc', [...args.slice(0, args.indexOf('-L')), '-fsyntax-only'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('a missing or uninventoried public header cannot produce a partial relocated input', t => {
  for (const mutation of ['missing-gl', 'uninventoried-gl', 'missing-core']) {
    const f = fixture(t);
    const name = mutation === 'missing-core' ? 'weapp_container_sdk.h' : 'weapp_container_sdk_gl.h';
    if (mutation.startsWith('missing')) rmSync(resolve(f.nativeDirectory, name));
    else { f.receipt.artifacts = f.receipt.artifacts.filter(record => record.file !== name); f.save(); }
    assert.throws(f.input, /ENOENT|requires an inventoried native input/);
    assert.equal(existsSync(f.destination), false);
  }
});

test('header tampering, independently replaced header receipts and symlinks fail before any input is staged', t => {
  for (const mutation of ['bytes', 'receipt', 'symlink']) {
    const f = fixture(t), name = 'weapp_container_sdk_gl.h', path = resolve(f.nativeDirectory, name);
    if (mutation === 'symlink') { rmSync(path); symlinkSync(resolve(contractDirectory, name), path); }
    else {
      const bytes = Buffer.from('// foreign contract header\n'); writeFileSync(path, bytes);
      if (mutation === 'receipt') { Object.assign(f.receipt.artifacts.find(record => record.file === name), { bytes: bytes.length, sha256: sha(bytes) }); f.save(); }
    }
    assert.throws(f.input, /hash\/size mismatch|differs from the reviewed C contract|symlinks are forbidden/);
    assert.equal(existsSync(f.destination), false);
  }
});
