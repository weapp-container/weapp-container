#!/usr/bin/env node
// A library distribution has no HAP identity. Bind the actual N-API libraries,
// required SDK C++ runtime and SDK notices directly to their original producer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHarmonyNativeRelease, parseHarmonyMetadataJson } from './lib/harmony-artifact-contract.mjs';
import { distributionIdentity } from './lib/showcase-policy.mjs';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { SHOWCASE_NATIVE_FONT, readShowcaseNativeFontLicense, verifyShowcaseNativeFontArtifact } from './lib/showcase-native-font.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = (path, bytes) => ({ path, size: bytes.length, sha256: sha(bytes) });
const runtimePath = 'libs/arm64-v8a/libc++_shared.so';
const metadataPath = 'platform-notices/OHOS-NATIVE-SDK.json';
const noticePath = 'platform-notices/OHOS-NATIVE-NOTICE.txt';
const fontLicensePath = 'licenses/noto-sans-sc/LICENSE.OFL.txt';
const runtimeSdkPath = 'native/llvm/lib/aarch64-linux-ohos/libc++_shared.so';
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
function read(path, maximum = 128 * 1024 * 1024) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum, 'Bounded ordinary Harmony library/notice input required');
  const bytes = readFileSync(path); assert.equal(bytes.length, stat.size); return bytes;
}
function relativeInput(root, path) {
  assert.ok(typeof path === 'string' && path.split('/').every(value => value && value !== '.' && value !== '..') && !/[\\:\x00-\x1f]/.test(path), 'Unsafe native producer artifact path');
  const resolved = resolve(root, path); assert.ok(resolved.startsWith(`${root}${sep}`)); return resolved;
}
function checkedReport(report) {
  const identity = distributionIdentity(report);
  assert.equal(identity.distributionProfile, 'restricted-showcase', 'This collector requires an explicit restricted native library producer');
  const platform = report.platforms?.find(value => value.platform === 'harmony');
  assert.equal(report.sdkVersion, SDK_RELEASE_VERSION); assert.equal(platform?.appIntegration?.status, 'passed');
  assert.deepEqual(platform.nativeFont, { ...SHOWCASE_NATIVE_FONT, markerVerified: true }, 'Native producer must verify the fixed embedded font');
  assert.deepEqual(platform.appIntegration.artifacts.map(value => basename(value.path)).sort(), ['libcontainer_host_harmony.so', 'libentry.so']);
  for (const library of platform.appIntegration.artifacts) {
    assert.equal(library.hardening?.debugInfo, false); assert.equal(library.hardening.localBuildPaths, false);
    assert.match(library.hardening.inspectorSha256, /^[a-f0-9]{64}$/);
  }
  return { identity, platform };
}
function sdkIdentity(bytes) {
  const sdk = parseHarmonyMetadataJson(bytes);
  keys(sdk, ['apiVersion', 'displayName', 'meta', 'path', 'releaseType', 'version']); keys(sdk.meta, ['metaVersion']);
  assert.equal(sdk.path, 'native'); assert.equal(sdk.displayName, 'Native'); assert.equal(sdk.releaseType, 'Release');
  assert.match(sdk.apiVersion, /^[1-9][0-9]{0,3}$/); assert.match(sdk.version, /^[0-9]+(?:\.[0-9]+){3}$/);
  assert.match(sdk.meta.metaVersion, /^[0-9]+(?:\.[0-9]+){2}$/);
  return { apiVersion: sdk.apiVersion, version: sdk.version };
}
function aarch64(bytes) {
  assert.ok(bytes.length >= 64 && bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) && bytes.readUInt16LE(18) === 183, 'OHOS runtime must be AArch64 ELF64');
}
export function verifyHarmonyNativePlatformNotices({ directory, report, reportSha256, identitySha256 }) {
  const { identity: distribution, platform } = checkedReport(report);
  assert.match(reportSha256, /^[a-f0-9]{64}$/); assert.match(identitySha256, /^[a-f0-9]{64}$/);
  const identityBytes = read(resolve(directory, 'platform-notices/identity.json'), 1024 * 1024);
  assert.equal(sha(identityBytes), identitySha256, 'Independent platform notice identity mismatch');
  const identity = parseHarmonyMetadataJson(identityBytes);
  const libraries = platform.appIntegration.artifacts.map(value => {
    const path = `libs/arm64-v8a/${basename(value.path)}`, bytes = read(resolve(directory, path)); aarch64(bytes);
    assert.equal(bytes.length, value.bytes); assert.equal(sha(bytes), value.sha256);
    return descriptor(path, bytes);
  }).sort((a, b) => a.path.localeCompare(b.path));
  const rust = libraries.find(value => value.path.endsWith('/libcontainer_host_harmony.so'));
  assertHarmonyNativeRelease(report, resolve(directory, rust.path), distribution);
  verifyShowcaseNativeFontArtifact(read(resolve(directory, rust.path)), SHOWCASE_NATIVE_FONT);
  readShowcaseNativeFontLicense(resolve(directory, fontLicensePath));
  const runtime = read(resolve(directory, runtimePath)); aarch64(runtime);
  const metadata = read(resolve(directory, metadataPath), 1024 * 1024), sdk = sdkIdentity(metadata);
  const notice = read(resolve(directory, noticePath), 16 * 1024 * 1024);
  assert.deepEqual(identity, {
    schemaVersion: 1, kind: 'harmony-native-library-platform-notices', sdkVersion: SDK_RELEASE_VERSION,
    sourceCommit: report.commit, target: platform.target, ...distribution, producerReportSha256: reportSha256,
    sdk: { ...sdk, metadata: descriptor(metadataPath, metadata) }, nativeLibraries: libraries,
    runtime: { ...descriptor(runtimePath, runtime), sdkPath: runtimeSdkPath }, notice: descriptor(noticePath, notice),
  }, 'Harmony native library platform notice identity differs from the actual distribution');
  return identity;
}
export function collectHarmonyNativePlatformNotices({ producerReport, sourceRoot, sdkDirectory, outDirectory, showcaseFontLicense }) {
  const reportBytes = read(producerReport, 16 * 1024 * 1024), report = parseHarmonyMetadataJson(reportBytes);
  const { identity: distribution, platform } = checkedReport(report), source = realpathSync(sourceRoot), sdk = realpathSync(sdkDirectory);
  assert.equal(realpathSync(resolve(sdk, 'native/llvm/bin/aarch64-unknown-linux-ohos-clang')), realpathSync(platform.toolchain.linker), 'Notices must come from the SDK used by the native producer');
  const files = new Map();
  for (const artifact of platform.appIntegration.artifacts) {
    const bytes = read(relativeInput(source, artifact.path)); aarch64(bytes);
    assert.equal(bytes.length, artifact.bytes); assert.equal(sha(bytes), artifact.sha256);
    files.set(`libs/arm64-v8a/${basename(artifact.path)}`, bytes);
  }
  assertHarmonyNativeRelease(report, relativeInput(source, platform.artifact.path), distribution);
  files.set(runtimePath, read(resolve(sdk, runtimeSdkPath)));
  files.set(metadataPath, read(resolve(sdk, 'native/oh-uni-package.json'), 1024 * 1024));
  files.set(noticePath, read(resolve(sdk, 'native/NOTICE.txt'), 16 * 1024 * 1024));
  files.set(fontLicensePath, readShowcaseNativeFontLicense(showcaseFontLicense));
  const sdkVersion = sdkIdentity(files.get(metadataPath));
  const identity = { schemaVersion: 1, kind: 'harmony-native-library-platform-notices', sdkVersion: SDK_RELEASE_VERSION,
    sourceCommit: report.commit, target: platform.target, ...distribution, producerReportSha256: sha(reportBytes),
    sdk: { ...sdkVersion, metadata: descriptor(metadataPath, files.get(metadataPath)) },
    nativeLibraries: [...files].filter(([path]) => path.startsWith('libs/') && path !== runtimePath).map(([path, bytes]) => descriptor(path, bytes)).sort((a, b) => a.path.localeCompare(b.path)),
    runtime: { ...descriptor(runtimePath, files.get(runtimePath)), sdkPath: runtimeSdkPath }, notice: descriptor(noticePath, files.get(noticePath)) };
  const out = resolve(outDirectory); mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  const identityBytes = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`); files.set('platform-notices/identity.json', identityBytes);
  for (const [path, bytes] of files) { mkdirSync(dirname(resolve(out, path)), { recursive: true }); writeFileSync(resolve(out, path), bytes, { flag: 'wx' }); }
  const identitySha256 = sha(identityBytes);
  verifyHarmonyNativePlatformNotices({ directory: out, report, reportSha256: sha(reportBytes), identitySha256 });
  return { status: 'collected-verified', directory: out, identitySha256, identity };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), names = { '--producer-report': 'producerReport', '--source-root': 'sourceRoot', '--sdk': 'sdkDirectory', '--out': 'outDirectory', '--showcase-font-license': 'showcaseFontLicense' }, options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(names[args[index]] && args[index + 1] && !args[index + 1].startsWith('--') && !options[names[args[index]]], 'Unknown/missing/duplicate platform notice option');
    options[names[args[index]]] = args[index + 1];
  }
  assert.equal(Object.keys(options).length, 5, 'Explicit producer report, source, SDK, font license and new staging directory required');
  console.log(JSON.stringify(collectHarmonyNativePlatformNotices(options), null, 2));
}
