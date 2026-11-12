import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { SDK_RELEASE_VERSION } from './sdk-current-release.mjs';
import { linuxValidationInput } from './sdk-linux-validation-input.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, viewDiagnostics = 'off') {
  const root = mkdtempSync(resolve(tmpdir(), 'linux-validation-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = resolve(root, 'x86_64-unknown-linux-gnu'); mkdirSync(directory);
  const content = 'finite byte fixture, never executed';
  writeFileSync(resolve(directory, 'libweapp_container_sdk.so'), content);
  const features = ['quickjs-native', 'skia-gpu-gles', ...(viewDiagnostics === 'cpu' ? ['view-batch-diagnostics'] : [])];
  const receipt = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, abiVersion: 1, status: 'built', profile: 'release',
    sourceCommit: 'a'.repeat(40), sourceDirty: false, target: 'x86_64-unknown-linux-gnu', platform: 'linux', viewDiagnostics, features,
    artifacts: [{ file: 'libweapp_container_sdk.so', bytes: Buffer.byteLength(content), sha256: sha(content) }] };
  const save = () => writeFileSync(resolve(directory, 'build.json'), JSON.stringify(receipt)); save();
  const source = { sourceCommit: receipt.sourceCommit, sourceDirty: false };
  return { root, directory, receipt, source, save };
}

test('Linux license and contract features retain the exact verified runtime graph, including diagnostics', t => {
  for (const diagnostics of ['off', 'cpu']) {
    const f = fixture(t, diagnostics), input = linuxValidationInput(f.root, f.source);
    assert.deepEqual(input.features.split(','), f.receipt.features);
    assert.equal(input.native.sourceCommit, f.receipt.sourceCommit);
    assert.equal(input.receiptSha256, sha(readFileSync(resolve(f.directory, 'build.json'))));
    assert.ok(input.features.includes('skia-gpu-gles'));
  }
});

test('stale, dirty, foreign-target and byte-mismatched runtime inputs cannot supply validation features', t => {
  for (const mutation of ['backend-only', 'dirty', 'foreign', 'bytes', 'unlisted-runtime']) {
    const f = fixture(t);
    if (mutation === 'backend-only') f.receipt.features = ['quickjs-native', 'skia-backend'];
    if (mutation === 'dirty') f.receipt.sourceDirty = true;
    if (mutation === 'foreign') { f.receipt.target = 'aarch64-apple-darwin'; f.receipt.platform = 'macos'; }
    if (mutation === 'bytes') writeFileSync(resolve(f.directory, 'libweapp_container_sdk.so'), 'foreign library');
    if (mutation === 'unlisted-runtime') {
      writeFileSync(resolve(f.directory, 'README'), 'listed bytes');
      f.receipt.artifacts = [{ file: 'README', bytes: 12, sha256: sha('listed bytes') }];
    }
    f.save();
    assert.throws(() => linuxValidationInput(f.root, f.source), /successful clean|features do not match|hash\/size mismatch|inventoried dynamic runtime/);
  }
});

test('skip-build cannot validate old native bytes against another or dirty current source', t => {
  const f = fixture(t);
  for (const source of [undefined, { ...f.source, sourceDirty: true }, { ...f.source, sourceCommit: 'b'.repeat(40) }]) {
    assert.throws(() => linuxValidationInput(f.root, source), /clean committed source|source changed during compilation/);
  }
  assert.equal(linuxValidationInput(f.root, f.source).native.sourceCommit, f.source.sourceCommit);
});
