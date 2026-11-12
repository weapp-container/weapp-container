import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadRuntimeArtifact } from '../../sdk/contract/tools/runtime-artifacts.mjs';
import { reviewedSdkSource } from './sdk-reviewed-sources.mjs';
import { SDK_RELEASE_VERSION, assertSdkProducer } from './sdk-current-release.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const ANDROID_CONSUMER_FILES = Object.freeze([
  'build.gradle.kts', 'consumer-test.pro', 'gradle.properties', 'settings.gradle.kts',
  'src/androidTest/AndroidManifest.xml', 'src/androidTest/java/com/sonofmagic/weapp/container/consumer/SdkInstrumentation.kt',
  'src/main/AndroidManifest.xml', 'src/main/java/com/sonofmagic/weapp/container/consumer/ConsumerActivity.kt',
]);
export const ANDROID_COORDINATE = { group: 'com.sonofmagic.weapp', name: 'weapp-container-android', version: SDK_RELEASE_VERSION };
const safe = path => {
  assert.ok(typeof path === 'string' && path && !path.startsWith('/') && !/[\\:\x00-\x20\x7f]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe Android consumer file path');
  return path;
};
export function ordinaryFile(directory, path) {
  const file = resolve(directory, safe(path)), stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && realpathSync(file) === file && stat.size <= 512 * 1024 * 1024, 'Consumer input must be a bounded ordinary file');
  return readFileSync(file);
}
export function treeRecords(directory, prefix = '') {
  return readdirSync(resolve(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = `${prefix}${entry.name}`; safe(path);
    assert.ok(!entry.isSymbolicLink(), 'Consumer tree cannot contain symlinks');
    return entry.isDirectory() ? treeRecords(directory, `${path}/`) : [{ path, size: ordinaryFile(directory, path).length, sha256: sha256(ordinaryFile(directory, path)) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
export function verifyInstalledAndroidArchive(directory) {
  const install = JSON.parse(ordinaryFile(directory, '.runtime-install.json'));
  assert.equal(install.schemaVersion, 1); assert.equal(install.identity.component, 'android-sdk'); assert.equal(install.identity.platform, 'android'); assert.equal(install.identity.arch, 'universal');
  const expected = install.files.filter(file => file.sha256).map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a,b)=>a.path.localeCompare(b.path));
  assert.deepEqual(treeRecords(directory).filter(file => file.path !== '.runtime-install.json'), expected, 'Installed SDK changed or acquired unreviewed files');
  const distributionBytes = ordinaryFile(directory, 'distribution.json'), distribution = JSON.parse(distributionBytes);
  assertSdkProducer(distribution, 'passed', 'android'); assert.equal(distribution.artifactRoot, 'maven');
  const inventory = ordinaryFile(directory, 'SDK-SOURCE-INVENTORY.json');
  assert.equal(sha256(inventory), distribution.sourceInventorySha256, 'Installed source inventory differs from SDK producer');
  assert.ok(Array.isArray(distribution.mavenArtifacts) && distribution.mavenArtifacts.length > 0);
  const maven = resolve(directory, 'maven'), bound = new Map();
  for (const record of distribution.mavenArtifacts) {
    safe(record.file); assert.ok(!bound.has(record.file), 'Duplicate Maven inventory entry');
    const bytes = ordinaryFile(maven, record.file); assert.equal(sha256(bytes), record.sha256, 'Installed Maven artifact checksum mismatch');
    bound.set(record.file, { path: record.file, size: bytes.length, sha256: record.sha256 });
  }
  assert.deepEqual(treeRecords(maven), [...bound.values()].sort((a,b)=>a.path.localeCompare(b.path)), 'Maven closure differs from distribution');
  const aarFiles = [...bound.values()].filter(record => record.path.endsWith('.aar'));
  assert.equal(aarFiles.length, 1, 'One original release AAR is required');
  const expectedAar = `com/sonofmagic/weapp/weapp-container-android/${SDK_RELEASE_VERSION}/weapp-container-android-${SDK_RELEASE_VERSION}.aar`;
  assert.equal(aarFiles[0].path, expectedAar);
  const binaries = distribution.binaries;
  assert.ok(Array.isArray(binaries));
  assert.deepEqual(binaries.map(value => `${value.abi}/${value.library}`).sort(), ['arm64-v8a', 'x86_64'].flatMap(abi => ['libweapp_container_sdk.so', 'libweapp_container_android.so', 'libc++_shared.so'].map(lib => `${abi}/${lib}`)).sort(), 'Complete original AAR native closure is required');
  for (const binary of binaries) {
    if (binary.library === 'libweapp_container_android.so') continue;
    const target = binary.abi === 'arm64-v8a' ? 'aarch64-linux-android' : 'x86_64-linux-android';
    const native = distribution.native.find(value => value.target === target)?.artifacts.find(value => value.file === binary.library);
    assert.equal(binary.sha256, native?.sha256, 'Original AAR differs from pinned runtime producer');
  }
  return { distribution, distributionSha256: sha256(distributionBytes), maven, aar: resolve(maven, expectedAar), aarRecord: aarFiles[0], binaries,
    installedFiles: expected, installationSha256: sha256(ordinaryFile(directory, '.runtime-install.json')) };
}

export async function installAndroidConsumerArchive({ manifestPath, expectedManifestSha256, artifactDirectory, workDirectory, installDirectory }) {
  try { lstatSync(installDirectory); throw Error('Android archive acceptance requires a never-existing install directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = readFileSync(manifestPath), manifestSha256 = sha256(bytes);
  if (expectedManifestSha256 !== undefined) assert.equal(manifestSha256, expectedManifestSha256, 'Independent manifest pin mismatch');
  const snapshot = resolve(workDirectory, 'runtime-artifacts.lock.json'); writeFileSync(snapshot, bytes, { flag: 'wx' });
  const prepared = await downloadRuntimeArtifact({ manifestPath: snapshot, version: SDK_RELEASE_VERSION, component: 'android-sdk', platform: 'android', arch: 'universal',
    artifactDirectory, outDirectory: resolve(workDirectory, 'downloads'), installDirectory });
  assert.equal(prepared.installation.reused, false, 'Archive consumer cannot reuse an existing install');
  return { kind: 'fresh-runtime-archive', manifestSha256, archiveSha256: prepared.receipt.sha256, archive: prepared.receipt, installation: prepared.installation };
}

export function prepareAndroidConsumerHarness({ sourceRoot, receipt, destination }) {
  const reviewed = reviewedSdkSource('android', receipt, { android: sourceRoot });
  const actual = [...reviewed.records.keys()].filter(path => path.startsWith('consumer/')).sort();
  assert.deepEqual(actual, ANDROID_CONSUMER_FILES.map(path => `consumer/${path}`).sort(), 'Android consumer differs from explicitly reviewed source closure');
  const files = ANDROID_CONSUMER_FILES.map(path => { const bytes = reviewed.readSource(`consumer/${path}`); return { path, bytes, size: bytes.length, sha256: sha256(bytes) }; });
  mkdirSync(destination);
  try {
    for (const file of files) { const target = resolve(destination, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.bytes, { flag: 'wx' }); }
  } catch (error) { rmSync(destination, { recursive: true }); throw error; }
  return { kind: 'external-reviewed-SDK-consumer', sourceCommit: receipt.sourceCommit, sourceInventorySha256: reviewed.inventory.sha256,
    files: files.map(({ bytes, ...record }) => record), boundary: 'Only consumer sources; wrapper, Cargo, CMake, JNI and SDK build outputs are excluded' };
}

export function inspectAndroidConsumerPackage({ archive, kind, binaries = [], files = [], workDirectory }) {
  assert.ok(['aar', 'apk', 'test-apk'].includes(kind));
  const options = resolve(workDirectory, `.android-package-${randomUUID()}.json`);
  writeFileSync(options, JSON.stringify({ archive, kind, binaries, files }), { flag: 'wx' });
  try {
    // A file-backed request avoids large synchronous stdin pipes. The inspector
    // has a finite timeout and never extracts or executes ZIP members.
    const result = spawnSync(process.env.PYTHON ?? 'python3', [resolve(root, 'scripts/lib/inspect-android-consumer.py'), options], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error(result.stderr?.trim() || result.error?.message || 'Android package inspection failed');
    return JSON.parse(result.stdout);
  } finally { rmSync(options, { force: true }); }
}

export function verifyAndroidConsumerDependencies({ receiptPath, maven, aarSha256 }) {
  const receipt = JSON.parse(readFileSync(receiptPath));
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.configuration, 'releaseRuntimeClasspath');
  assert.equal(receipt.sdkRepository, realpathSync(maven)); assert.equal(receipt.sdkRepositoryPolicy, 'exclusive-installed-Maven-module');
  assert.ok(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0);
  const selected = receipt.artifacts.filter(item => item.group === ANDROID_COORDINATE.group && item.name === ANDROID_COORDINATE.name);
  assert.equal(selected.length, 1, 'Exactly one original SDK dependency is required');
  assert.equal(selected[0].version, SDK_RELEASE_VERSION); assert.equal(selected[0].extension, 'aar'); assert.equal(selected[0].sha256, aarSha256, 'Gradle resolved a different SDK AAR');
  const identities = new Set();
  for (const item of receipt.artifacts) {
    const identity = `${item.group}:${item.name}:${item.version}:${item.classifier}:${item.extension}`;
    assert.ok(!identities.has(identity), 'Duplicate resolved dependency'); identities.add(identity);
    assert.ok(Number.isSafeInteger(item.size) && item.size > 0 && /^[a-f0-9]{64}$/.test(item.sha256));
    const bytes = ordinaryFile(dirname(item.file), item.file.slice(dirname(item.file).length + 1));
    assert.equal(bytes.length, item.size); assert.equal(sha256(bytes), item.sha256, 'Resolved dependency bytes changed');
  }
  return { ...receipt, sha256: sha256(readFileSync(receiptPath)) };
}
