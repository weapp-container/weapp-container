import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { SDK_VERSION } from '../../sdk/android/tools/native-input.mjs';
import { androidRecoveryGradleArguments, resolveAndroidRecoveryInput, verifyAndroidRecoveryApk } from './sdk-android-recovery-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const targets = ['aarch64-linux-android', 'x86_64-linux-android'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'sdk-recovery-input-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const coreRoot = resolve(directory, 'core'), artifacts = resolve(directory, 'distribution');
  const nativeRoot = resolve(coreRoot, 'artifacts/sdk/native');
  const licensesRoot = resolve(coreRoot, 'artifacts/sdk/licenses');
  mkdirSync(artifacts, { recursive: true });
  const native = [];
  for (const target of targets) {
    const slice = resolve(nativeRoot, target); mkdirSync(slice, { recursive: true });
    const entries = ['libweapp_container_sdk.so', 'libc++_shared.so', 'libweapp_container_sdk.a', 'weapp_container_sdk.h'];
    const receipt = { schemaVersion: 1, sdkVersion: SDK_VERSION, abiVersion: 1, status: 'built',
      target, platform: 'android', profile: 'release', sourceCommit: 'a'.repeat(40), sourceDirty: false,
      features: ['quickjs-native-android', 'skia-gpu-gles'], artifacts: [] };
    for (const file of entries) {
      const bytes = file.endsWith('.h') ? readFileSync(resolve(root, 'sdk/contract/include', file)) : Buffer.from(`${target}/${file}`);
      writeFileSync(resolve(slice, file), bytes);
      receipt.artifacts.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
    }
    json(resolve(slice, 'build.json'), receipt); native.push(receipt);
    const notice = resolve(licensesRoot, target, 'fixture/LICENSE'); mkdirSync(dirname(notice), { recursive: true });
    writeFileSync(notice, 'fixture dependency notice');
    json(resolve(licensesRoot, target, 'licenses.json'), { schemaVersion: 1, target, features: receipt.features,
      packages: [{ name: 'fixture', files: [{ path: 'fixture/LICENSE', sha256: sha256(readFileSync(notice)) }] }] });
  }
  writeFileSync(resolve(nativeRoot, 'RUNTIME-LICENSE'), 'fixture private runtime terms');
  const distribution = { schemaVersion: 1, sdkVersion: SDK_VERSION, status: 'passed', native };
  const save = () => json(resolve(artifacts, 'distribution.json'), distribution); save();
  return { coreRoot, artifacts, nativeRoot, licensesRoot, distribution, save, directory,
    resolve: override => resolveAndroidRecoveryInput({ coreRoot, artifacts, ...override }) };
}
function rewriteNative(f, index, mutate) {
  const path = resolve(f.nativeRoot, targets[index], 'build.json');
  const receipt = JSON.parse(readFileSync(path)); mutate(receipt); json(path, receipt);
}

test('default native directory follows private core output, never the removed SDK-local copy', t => {
  const f = fixture(t), input = f.resolve();
  assert.equal(input.nativeRoot, f.nativeRoot); assert.equal(input.selectedBy, 'core-default');
  assert.equal(input.licensesRoot, f.licensesRoot); assert.equal(input.licensesSelectedBy, 'core-default');
  assert.equal(input.native.length, 2); assert.equal(input.distributionSha256, sha256(readFileSync(resolve(f.artifacts, 'distribution.json'))));
});
test('explicit path wins over stale distribution path and binds exactly the same identities', t => {
  const f = fixture(t); f.distribution.nativeRoot = resolve(f.directory, 'stale'); f.save();
  const input = f.resolve({ nativeRoot: f.nativeRoot }); assert.equal(input.selectedBy, 'explicit');
});
test('legacy declared distribution path wins over core default without guessing', t => {
  const f = fixture(t), relocated = resolve(f.directory, 'declared-runtime');
  cpSync(f.nativeRoot, relocated, { recursive: true }); rmSync(f.nativeRoot, { recursive: true });
  f.distribution.nativeRoot = relocated; f.save();
  assert.equal(f.resolve().nativeRoot, relocated); assert.equal(f.resolve().selectedBy, 'distribution');
});
test('stale explicit or declared root fails instead of falling back to a valid core root', t => {
  const f = fixture(t), absent = resolve(f.directory, 'absent');
  assert.throws(() => f.resolve({ nativeRoot: absent }), /ENOENT/);
  f.distribution.nativeRoot = absent; f.save(); assert.throws(() => f.resolve(), /ENOENT/);
});
test('missing distribution receipt cannot turn an arbitrary native directory into accepted evidence', t => {
  const f = fixture(t); unlinkSync(resolve(f.artifacts, 'distribution.json'));
  assert.throws(() => f.resolve({ nativeRoot: f.nativeRoot }), /ENOENT/);
});
test('explicit notices override stale declared notices without changing runtime selection', t => {
  const f = fixture(t); f.distribution.licensesRoot = resolve(f.directory, 'stale-licenses'); f.save();
  assert.equal(f.resolve({ licensesRoot: f.licensesRoot }).licensesSelectedBy, 'explicit');
});
test('legacy declared notices are honored and stale notices never fall back', t => {
  const f = fixture(t), relocated = resolve(f.directory, 'declared-notices');
  cpSync(f.licensesRoot, relocated, { recursive: true }); f.distribution.licensesRoot = relocated; f.save();
  assert.equal(f.resolve().licensesRoot, relocated);
  rmSync(relocated, { recursive: true }); assert.throws(() => f.resolve(), /ENOENT/);
  assert.throws(() => f.resolve({ licensesRoot: relocated }), /ENOENT/);
});
test('missing or modified dependency notice fails before a Gradle preBuild can package it', t => {
  const f = fixture(t), notice = resolve(f.licensesRoot, targets[1], 'fixture/LICENSE');
  writeFileSync(notice, 'altered'); assert.throws(() => f.resolve(), /notice integrity mismatch/);
  unlinkSync(notice); assert.throws(() => f.resolve(), /ENOENT/);
});
test('wrong target notice inventory is rejected', t => {
  const f = fixture(t), file = resolve(f.licensesRoot, targets[0], 'licenses.json');
  const inventory = JSON.parse(readFileSync(file)); inventory.target = targets[1]; json(file, inventory);
  assert.throws(() => f.resolve(), /Complete native dependency notices/);
});
test('private runtime terms are required alongside dependency notices', t => {
  const f = fixture(t); writeFileSync(resolve(f.nativeRoot, 'RUNTIME-LICENSE'), '');
  assert.throws(() => f.resolve(), /private runtime license is empty/);
});
test('notice inventory must match the runtime features and contain dependency files', t => {
  const f = fixture(t), file = resolve(f.licensesRoot, targets[0], 'licenses.json');
  const inventory = JSON.parse(readFileSync(file)); inventory.features = ['quickjs-native-android']; json(file, inventory);
  assert.throws(() => f.resolve(), /native\/notices feature mismatch/);
  inventory.features.push('skia-gpu-gles'); inventory.packages = []; json(file, inventory);
  assert.throws(() => f.resolve(), /Complete native dependency notices/);
});
test('Gradle invocation covers every mandatory SDK project property, preserving offline policy', t => {
  const f = fixture(t), input = f.resolve(), argv = androidRecoveryGradleArguments(input, true);
  const build = readFileSync(resolve(root, 'sdk/android/library/build.gradle.kts'), 'utf8');
  const required = [...build.matchAll(/^val \w+ = providers\.gradleProperty\("([^"]+)"\)(.*)$/gm)]
    .filter(match => !match[2].includes('.orElse(')).map(match => match[1]);
  assert.deepEqual(required.sort(), ['weappSdkLicensesDir', 'weappSdkNativeDir']);
  const properties = Object.fromEntries(argv.filter(arg => arg.startsWith('-P')).map(arg => {
    const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)];
  }));
  for (const key of required) assert.ok(properties[key], `Missing mandatory Gradle property ${key}`);
  assert.equal(properties.weappSdkNativeDir, input.nativeRoot); assert.equal(properties.weappSdkLicensesDir, input.licensesRoot);
  assert.ok(argv.includes('--offline')); assert.ok(!androidRecoveryGradleArguments(input).includes('--offline'));
});
for (const [field, value] of [['schemaVersion', 2], ['sdkVersion', '0.1.0-preview.1'], ['status', 'building']]) {
  test(`rejects unaccepted distribution ${field}`, t => {
    const f = fixture(t); f.distribution[field] = value; f.save(); assert.throws(() => f.resolve(), /passed Android SDK distribution/);
  });
}
test('distribution must contain both and only Android target identities', t => {
  const f = fixture(t); f.distribution.native[1] = structuredClone(f.distribution.native[0]); f.save();
  assert.throws(() => f.resolve(), /target inventory must be exact/);
});
for (const [field, value] of [['abiVersion', 2], ['target', 'aarch64-apple-ios'], ['sourceCommit', 'b'.repeat(40)],
  ['sourceDirty', true], ['profile', 'dev'], ['platform', 'ios']]) {
  test(`rejects native ${field} differing from distribution`, t => {
    const f = fixture(t); rewriteNative(f, 0, receipt => { receipt[field] = value; }); assert.throws(() => f.resolve());
  });
}
test('slices with individually matching receipts must still share one source commit', t => {
  const f = fixture(t); rewriteNative(f, 1, receipt => { receipt.sourceCommit = 'b'.repeat(40); });
  f.distribution.native[1].sourceCommit = 'b'.repeat(40); f.save();
  assert.throws(() => f.resolve(), /one producer source identity/);
});
test('renderer and engine features cannot silently differ', t => {
  const f = fixture(t); rewriteNative(f, 0, receipt => { receipt.features.push('unreviewed'); });
  assert.throws(() => f.resolve(), /feature mismatch/);
});
test('mutated runtime library is rejected before Gradle or device use', t => {
  const f = fixture(t); writeFileSync(resolve(f.nativeRoot, targets[0], 'libweapp_container_sdk.so'), 'changed');
  assert.throws(() => f.resolve(), /Native hash mismatch/);
});
test('rehashing a changed library cannot change the pinned distribution identity', t => {
  const f = fixture(t), bytes = Buffer.from('different valid hash');
  writeFileSync(resolve(f.nativeRoot, targets[0], 'libweapp_container_sdk.so'), bytes);
  rewriteNative(f, 0, receipt => { Object.assign(receipt.artifacts[0], { bytes: bytes.length, sha256: sha256(bytes) }); });
  assert.throws(() => f.resolve(), /inventory mismatch/);
});
test('byte-count lies fail even on full producer receipt path', t => {
  const f = fixture(t); rewriteNative(f, 0, receipt => { receipt.artifacts[0].bytes++; });
  f.distribution.native[0].artifacts[0].bytes++; f.save(); assert.throws(() => f.resolve(), /size mismatch/);
});
test('duplicate or escaping inventory does not alias a real library', t => {
  const f = fixture(t); f.distribution.native[0].artifacts.push({ ...f.distribution.native[0].artifacts[0] }); f.save();
  assert.throws(() => f.resolve(), /Invalid native inventory/);
  f.distribution.native[0].artifacts.pop(); f.distribution.native[0].artifacts[0].file = '../escape'; f.save();
  assert.throws(() => f.resolve(), /Invalid native inventory/);
});
test('native symlink cannot bypass verified artifact ownership', t => {
  const f = fixture(t), library = resolve(f.nativeRoot, targets[0], 'libweapp_container_sdk.so');
  const outside = resolve(f.directory, 'borrowed-library'); cpSync(library, outside); unlinkSync(library); symlinkSync(outside, library);
  assert.throws(() => f.resolve(), /symlink is forbidden/);
});
test('exact archive selection may omit only the unused Android static library', t => {
  const f = fixture(t), slice = resolve(f.nativeRoot, targets[0]), receipt = f.distribution.native[0];
  const omittedArtifacts = receipt.artifacts.filter(item => item.file.endsWith('.a'));
  const selectedArtifacts = receipt.artifacts.filter(item => !item.file.endsWith('.a'));
  const sidecar = { schemaVersion: 1, sdkVersion: receipt.sdkVersion, abiVersion: 1, target: targets[0],
    sourceCommit: receipt.sourceCommit, sourceDirty: false, selectedArtifacts, omittedArtifacts,
    producerReceipt: { file: 'build.json', sha256: sha256(readFileSync(resolve(slice, 'build.json'))) } };
  json(resolve(slice, 'runtime-distribution.json'), sidecar); unlinkSync(resolve(slice, omittedArtifacts[0].file));
  assert.equal(f.resolve().native.length, 2);
  sidecar.producerReceipt.sha256 = '0'.repeat(64); json(resolve(slice, 'runtime-distribution.json'), sidecar);
  assert.throws(() => f.resolve(), /producer receipt mismatch/);
});

function makeApk(f, input, entries) {
  const apk = resolve(f.directory, 'recovery.apk');
  const files = input.native.flatMap(receipt => receipt.artifacts.map(item => ({
    entry: `lib/${receipt.target === targets[0] ? 'arm64-v8a' : 'x86_64'}/${item.file}`,
    file: resolve(input.nativeRoot, receipt.target, item.file),
  })));
  const result = spawnSync('python3', ['-c', `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for entry in json.loads(sys.argv[2]): archive.write(entry['file'],entry['entry'])`, apk, JSON.stringify(entries ? entries(files) : files)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return apk;
}
test('actual recovery APK must carry byte-identical pinned runtime for both ABIs', t => {
  const f = fixture(t), input = f.resolve(), apk = makeApk(f, input);
  assert.equal(verifyAndroidRecoveryApk(apk, input).length, 4);
});
test('stale --skip-build APK is rejected even when input receipts pass', t => {
  const f = fixture(t), input = f.resolve(), replacement = resolve(f.directory, 'stale'); writeFileSync(replacement, 'stale');
  const apk = makeApk(f, input, entries => entries.map((entry, index) => index ? entry : { ...entry, file: replacement }));
  assert.throws(() => verifyAndroidRecoveryApk(apk, input), /Pinned APK library size mismatch/);
});
test('APK cannot omit one target or carry duplicate pinned entries', t => {
  const f = fixture(t), input = f.resolve();
  assert.throws(() => verifyAndroidRecoveryApk(makeApk(f, input, entries => entries.slice(1)), input), /Missing or duplicate/);
  assert.throws(() => verifyAndroidRecoveryApk(makeApk(f, input, entries => [...entries, entries[0]]), input), /Missing or duplicate/);
});
