import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { collectHarmonyNativePlatformNotices, verifyHarmonyNativePlatformNotices } from './harmony-native-platform-notices.mjs';
import { HARMONY_RELEASE_FEATURES } from './lib/harmony-artifact-contract.mjs';
import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { SHOWCASE_NATIVE_FONT } from './lib/showcase-native-font.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('Native-library notices bind the exact N-API, core, SDK runtime and notices without claiming HAP evidence', t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'harmony-library-notices-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = resolve(directory, 'source'), sdk = resolve(directory, 'sdk'), out = resolve(directory, 'stage');
  const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  const elf = Buffer.alloc(96); elf.set([127, 69, 76, 70, 2, 1]); elf.writeUInt16LE(183, 18);
  const distribution = { distributionProfile: 'restricted-showcase', policySha256: 'b'.repeat(64) };
  const core = Buffer.concat([elf, Buffer.from(`weapp-container-distribution:restricted-showcase:${distribution.policySha256}\0weapp-container-native-font:${SHOWCASE_NATIVE_FONT.fontSha256}:${SHOWCASE_NATIVE_FONT.licenseSha256}\0`)]);
  const artifact = { path: 'target/aarch64-unknown-linux-ohos/release/libcontainer_host_harmony.so', exists: true, bytes: core.length, sha256: hash(core) };
  write(resolve(source, artifact.path), core);
  const artifacts = [['libentry.so', elf], ['libcontainer_host_harmony.so', core]].map(([name, bytes]) => {
    const path = `target/native-host-integration/harmony/${name}`; write(resolve(source, path), bytes);
    return { path, bytes: bytes.length, sha256: hash(bytes), hardening: { debugInfo: false, localBuildPaths: false, inspectorSha256: 'e'.repeat(64) } };
  });
  const linker = resolve(sdk, 'native/llvm/bin/aarch64-unknown-linux-ohos-clang'); write(linker, 'compiler');
  write(resolve(sdk, 'native/llvm/lib/aarch64-linux-ohos/libc++_shared.so'), elf);
  write(resolve(sdk, 'native/NOTICE.txt'), 'actual native SDK notice');
  write(resolve(sdk, 'native/oh-uni-package.json'), JSON.stringify({ apiVersion: '24', displayName: 'Native', meta: { metaVersion: '3.0.0' }, path: 'native', releaseType: 'Release', version: '6.1.1.125' }));
  const sourceIdentity = { sourceCommit: 'a'.repeat(40), sourceDirty: false };
  const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, ...distribution, commit: sourceIdentity.sourceCommit,
    mode: 'build', profile: 'release', sourceBefore: sourceIdentity, sourceAfter: sourceIdentity, platforms: [{
      platform: 'harmony', ...distribution, target: 'aarch64-unknown-linux-ohos', status: 'passed', mode: 'build', profile: 'release', engine: 'quickjs',
      features: [...HARMONY_RELEASE_FEATURES, 'restricted-showcase'].join(','), cargo: { status: 'passed', exitCode: 0 },
      artifact, appIntegration: { status: 'passed', artifacts }, toolchain: { linker }, nativeFont: { ...SHOWCASE_NATIVE_FONT, markerVerified: true },
    }] };
  const producerReport = resolve(directory, 'build.json'), reportBytes = Buffer.from(JSON.stringify(report)); write(producerReport, reportBytes);
  const result = collectHarmonyNativePlatformNotices({ producerReport, sourceRoot: source, sdkDirectory: sdk, outDirectory: out,
    showcaseFontLicense: new URL('../sdk/licenses/noto-sans-sc/LICENSE.OFL.txt', import.meta.url) });
  assert.equal(result.status, 'collected-verified'); assert.equal(result.identity.kind, 'harmony-native-library-platform-notices');
  const verify = (actual = report, digest = hash(reportBytes)) => verifyHarmonyNativePlatformNotices({ directory: out, report: actual, reportSha256: digest, identitySha256: result.identitySha256 });
  assert.deepEqual(verify(), result.identity);
  assert.throws(() => verify(report, 'f'.repeat(64)), /differs/);
  const runtime = resolve(out, 'libs/arm64-v8a/libc++_shared.so'), original = readFileSync(runtime);
  const changed = Buffer.from(original); changed[70] ^= 1; writeFileSync(runtime, changed);
  assert.throws(() => verify(), /differs/); writeFileSync(runtime, original);
  const unverified = structuredClone(report); unverified.platforms[0].appIntegration.artifacts[0].hardening.debugInfo = true;
  assert.throws(() => verify(unverified));
  const notice = resolve(out, 'platform-notices/OHOS-NATIVE-NOTICE.txt'); writeFileSync(notice, 'other SDK notice');
  assert.throws(() => verify(), /differs/);
});
