import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { SHOWCASE_NATIVE_FONT } from './lib/showcase-native-font.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { buildRuntimeArchives, prepareArchivePlans, publishVerifiedArchives, verifyAndroidArchiveInputs } from './dev-player-runtime-archives.mjs';
import { downloadRuntimeArtifact, selectArtifact } from '../sdk/contract/tools/runtime-artifacts.mjs';
import { selectArtifact as selectFlutterArtifact } from '../sdk/flutter/tools/runtime-artifacts.mjs';
import { selectArtifact as selectReactNativeArtifact } from '../sdk/react-native/tools/runtime-artifacts.mjs';
import * as androidNative from '../sdk/android/tools/native-input.mjs';
import * as iosNative from '../sdk/ios/tools/native-input.mjs';
import * as desktopNative from '../sdk/desktop/tools/native-input.mjs';
import { installDesktopConsumerArchive, prepareDesktopConsumerHarness } from './lib/sdk-desktop-consumer-harness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const reviewedSources = new Map();
function reviewedSource(platform) {
  const kind = ['android', 'ios'].includes(platform) ? platform : 'desktop';
  if (reviewedSources.has(kind)) return reviewedSources.get(kind);
  const directory = new URL(`../sdk/${kind}`, import.meta.url).pathname;
  function git(args) { const result = spawnSync('git', ['-C', directory, ...args]); assert.equal(result.status, 0); return result.stdout; }
  const sourceCommit = git(['rev-parse', 'HEAD']).toString().trim();
  const bytes = git(['show', `${sourceCommit}:SOURCE-INVENTORY.json`]);
  const inventory = JSON.parse(bytes);
  const records = inventory.files.filter(record => kind === 'android' ? record.path.startsWith('library/src/main/java/') && record.path.endsWith('.kt') : kind === 'ios' ? record.path.startsWith('Sources/WeappContainer/') && record.path.endsWith('.swift') : record.path.startsWith('include/weapp/') && /\.(h|hpp)$/.test(record.path));
  const noticeRecords = inventory.files.filter(record => ['LICENSE', 'THIRD-PARTY-NOTICES.md'].includes(record.path) || record.path.startsWith('licenses/'));
  const value = { sourceCommit, sourceInventorySha256: hash(bytes), records, noticeRecords, source(path) { return git(['show', `${sourceCommit}:${path}`]); } };
  reviewedSources.set(kind, value); return value;
}
function fixture(platform = 'macos', identity = {}, sourceCommit = '1'.repeat(40)) {
  const directory = mkdtempSync(resolve(tmpdir(), 'player-runtime-archives-'));
  const layouts = { macos: 'desktop/macos-universal', linux: 'desktop/linux-x64', windows: 'desktop/windows-x64', ios: 'ios/WeappContainer', android: 'android' };
  const targetSets = { macos: ['aarch64-apple-darwin', 'x86_64-apple-darwin'], linux: ['x86_64-unknown-linux-gnu'], windows: ['x86_64-pc-windows-msvc'], ios: ['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios'], android: ['aarch64-linux-android', 'x86_64-linux-android'] };
  const runtimeRoot = resolve(directory, 'runtime'), sdk = layouts[platform], reviewed = reviewedSource(platform);
  const write = (name, bytes) => { const path = resolve(runtimeRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); return path; };
  const json = (name, value) => write(name, JSON.stringify(value));
  function licenses(base, target, features) {
    write(`${base}/pkg/LICENSE`, 'third party license\n');
    const packages = [{ name: 'pkg', files: [{ path: 'pkg/LICENSE', sha256: hash('third party license\n') }] }];
    if (identity.distributionProfile === 'restricted-showcase') {
      write(`${base}/noto-sans-sc/LICENSE.OFL.txt`, readFileSync(new URL('../sdk/licenses/noto-sans-sc/LICENSE.OFL.txt', import.meta.url)));
      packages.push({ name: 'NotoSansSC', kind: 'embedded-native-font', license: 'OFL-1.1', files: [{ path: 'noto-sans-sc/LICENSE.OFL.txt', sha256: SHOWCASE_NATIVE_FONT.licenseSha256 }] });
    }
    json(`${base}/licenses.json`, { schemaVersion: 1, target, features, source: { sourceCommit, sourceDirty: false },
      ...(identity.distributionProfile === 'restricted-showcase' ? { nativeFont: SHOWCASE_NATIVE_FONT } : {}), packages });
  }
  const native = [];
  for (const target of targetSets[platform]) {
    const bytes = `fixture native archive ${target}\n${identity.distributionProfile === 'restricted-showcase' ? `weapp-container-distribution:restricted-showcase:${identity.policySha256}\0weapp-container-native-font:${SHOWCASE_NATIVE_FONT.fontSha256}:${SHOWCASE_NATIVE_FONT.licenseSha256}\0` : ''}`;
    const features = [platform === 'android' ? 'quickjs-native-android' : platform === 'ios' ? 'quickjs-native-ios' : 'quickjs-native', ['macos', 'ios'].includes(platform) ? 'skia-gpu-metal' : 'skia-gpu-gles'];
    if (identity.distributionProfile === 'restricted-showcase') features.push('restricted-showcase');
    const receipt = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, abiVersion: 1, ...identity, sourceCommit, sourceDirty: false, target, platform, viewDiagnostics: 'off', profile: 'release', status: 'built', features, artifacts: [] };
    const libraries = platform === 'windows' ? ['weapp_container_sdk.lib', 'weapp_container_sdk.dll', 'weapp_container_sdk.dll.lib'] : ['libweapp_container_sdk.a', `libweapp_container_sdk.${['linux', 'android'].includes(platform) ? 'so' : 'dylib'}`];
    for (const file of libraries) { write(`native/${target}/${file}`, bytes); receipt.artifacts.push({ file, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }); }
    for (const file of ['weapp_container_sdk.h', 'weapp_container_sdk_gl.h']) {
      const bytes = readFileSync(new URL(`../sdk/contract/include/${file}`, import.meta.url));
      write(`native/${target}/${file}`, bytes); receipt.artifacts.push({ file, bytes: bytes.length, sha256: hash(bytes) });
    }
    write(`native/${target}/RUNTIME-LICENSE`, 'proprietary runtime\n');
    json(`native/${target}/build.json`, receipt); native.push(receipt); licenses(`licenses/${target}`, target, features);
    licenses(`${sdk}/${platform === 'ios' ? 'licenses' : 'share/weapp-container/licenses/native'}/${target}`, target, features);
  }
  for (const record of reviewed.records) write(`${sdk}/${record.path}`, reviewed.source(record.path));
  if (platform === 'ios') {
    for (const file of ['Package.swift', 'WeappContainer.podspec', 'README.md', 'LICENSE', 'CONTRACT.md', 'ORIGIN.json', 'docs/EMBEDDING.md', 'docs/window-metrics.md']) write(`${sdk}/${file}`, reviewed.source(file));
    write(`${sdk}/RUNTIME-LICENSE`, 'proprietary runtime\n');
    write(`${sdk}/Frameworks/WeappContainerNative.xcframework/Info.plist`, 'fixture XCFramework metadata');
    for (const slice of ['ios-arm64', 'ios-arm64_x86_64-simulator']) {
      const base = `${sdk}/Frameworks/WeappContainerNative.xcframework/${slice}`;
      write(`${base}/libweapp_container_sdk.a`, 'fixture native framework archive');
      write(`${base}/Headers/module.modulemap`, 'module WeappContainerNative { export * }');
      write(`${base}/Headers/weapp_container_sdk.h`, readFileSync(new URL('../sdk/contract/include/weapp_container_sdk.h', import.meta.url)));
    }
    function records(base, prefix = '') { return readdirSync(resolve(base, prefix), { withFileTypes: true }).flatMap(entry => { const file = `${prefix}${entry.name}`; return entry.isDirectory() ? records(base, `${file}/`) : [{ file, sha256: hash(readFileSync(resolve(base, file))) }]; }); }
    const receipt = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, ...identity, sourceCommit: reviewed.sourceCommit, sourceInventorySha256: reviewed.sourceInventorySha256, sourceDirty: false, profile: 'release', status: 'built', artifacts: records(resolve(runtimeRoot, sdk)), native };
    json(`${sdk}/build.json`, receipt);
    return { directory, runtimeRoot, write, json, receipt, sdk, remove() { rmSync(directory, { recursive: true, force: true }); } };
  }
  write(`${sdk}/lib/cmake/WeappContainerDesktop/WeappContainerDesktopConfig.cmake`, '# public CMake config\n');
  const artifacts = [];
  for (const name of ['desktop', 'sdk']) {
    const bytes = `fixture installed library ${name}\n`; const file = `lib/${platform === 'windows' ? '' : 'lib'}weapp_container_${name}${platform === 'windows' && name === 'sdk' ? '.dll' : ''}.${platform === 'windows' ? 'lib' : 'a'}`;
    write(`${sdk}/${file}`, bytes); artifacts.push({ file, sha256: hash(bytes) });
  }
  if (platform === 'windows') {
    const file = 'bin/weapp_container_sdk.dll', bytes = 'fixture installed exact Windows runtime DLL\n';
    write(`${sdk}/${file}`, bytes); artifacts.push({ file, sha256: hash(bytes) });
  }
  write(`${sdk}/share/weapp-container/LICENSE`, 'wrapper Apache\n');
  write(`${sdk}/share/weapp-container/README.md`, 'public SDK usage\n');
  write(`${sdk}/share/weapp-container/RUNTIME-LICENSE`, 'proprietary runtime\n');
  write(`${sdk}/share/weapp-container/licenses/nlohmann-json-LICENSE.MIT`, 'JSON wrapper third-party notice\n');
  write(`${sdk}/share/weapp-container/consumer/CMakeLists.txt`, '# excluded consumer\n');
  const receipt = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, ...identity, platform: sdk.split('/').at(-1), sourceCommit: reviewed.sourceCommit, sourceInventorySha256: reviewed.sourceInventorySha256, sourceDirty: false, status: 'verified', artifacts, native, checks: [{ exitCode: 0 }] };
  json(`${sdk}/package.json`, receipt);
  return { directory, runtimeRoot, write, json, receipt, sdk, remove() { rmSync(directory, { recursive: true, force: true }); } };
}
function androidSourcesJar(path, { missing = false, changed = false, added = false } = {}) {
  const reviewed = reviewedSource('android');
  const records = reviewed.records.map(record => ({ file: record.path.slice('library/src/main/java/'.length), content: reviewed.source(record.path).toString('base64') }));
  if (missing) records.pop();
  if (changed) records[0].content = Buffer.from('// modified wrapper source').toString('base64');
  if (added) records.push({ file: 'com/sonofmagic/weapp/container/sdk/Unreviewed.kt', content: Buffer.from('// unreviewed').toString('base64') });
  writeZipFixture(path, records, 'w');
}
function androidSdkNoticeEntries() {
  const reviewed = reviewedSource('android');
  return reviewed.noticeRecords.map(record => ({ file: `assets/weapp-container/${record.path === 'LICENSE' ? record.path : `sdk-dependencies/${record.path}`}`, content: reviewed.source(record.path).toString('base64') }));
}
function appendZipEntries(path, entries) {
  writeZipFixture(path, entries, 'a');
}
function writeZipFixture(path, entries, mode) {
  // Give the large source fixture a finite input file. A child waiting for
  // pipe EOF must not hold the whole concurrent validation group indefinitely.
  const payload = `${path}.fixture.json`;
  writeFileSync(payload, JSON.stringify(entries));
  try {
    const result = spawnSync('python3', ['-c', "import base64,json,sys,zipfile\nwith open(sys.argv[2],encoding='utf-8') as f: entries=json.load(f)\nwith zipfile.ZipFile(sys.argv[1],sys.argv[3]) as z:\n for item in entries:z.writestr(item['file'],base64.b64decode(item['content']))", path, payload, mode], { timeout: 60_000, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  } finally { rmSync(payload); }
}

test('tiny clean producer fixtures create exact private SDK/runtime pins and pass the real contract unpack verifier', async () => {
  const f = fixture(); try {
    const output = resolve(f.directory, 'archives');
    const result = await buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['macos'], outDirectory: output });
    assert.equal(result.manifest.runtimeVersion, SDK_RELEASE_VERSION);
    assert.equal(result.manifest.artifacts.length, 3);
    assert.equal(result.provenance.privacy, 'private');
    for (const entry of result.manifest.artifacts) {
      const bytes = readFileSync(resolve(output, entry.fileName));
      assert.equal(bytes.length, entry.size); assert.equal(hash(bytes), entry.sha256);
    }
    const sdk = result.provenance.artifacts.find(value => value.component === 'desktop-sdk');
    assert.ok(sdk.inventory.some(value => value.file === 'package.json'));
    assert.ok(sdk.inventory.some(value => value.file === 'include/weapp/desktop.h' && value.provenance === 'archive-inventory'));
    assert.ok(sdk.inventory.some(value => value.file === 'share/weapp-container/licenses/nlohmann-json-LICENSE.MIT'));
    assert.equal(sdk.inventory.some(value => value.file.includes('/consumer/')), false);
    assert.ok(result.provenance.artifacts.every(value => value.contractVerification.status === 'passed'));
    await assert.rejects(buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['macos'], outDirectory: output }), /new independent directory/);
  } finally { f.remove(); }
});

test('restricted archives require matching top and native identity, compiled markers and exact notices', async () => {
  const identity = { distributionProfile: 'restricted-showcase', policySha256: 'd'.repeat(64) };
  const f = fixture('macos', identity); try {
    const options = { runtimeRoot: f.runtimeRoot, platforms: ['macos'], expectedDistribution: identity };
    assert.throws(() => prepareArchivePlans({ ...options, expectedDistribution: undefined }), /mismatch/);
    assert.throws(() => prepareArchivePlans({ ...options, expectedDistribution: { ...identity, policySha256: 'e'.repeat(64) } }), /mismatch/);
    const result = await buildRuntimeArchives({ ...options, outDirectory: resolve(f.directory, 'restricted') });
    assert.equal(result.manifest.runtimeVersion, SDK_RELEASE_VERSION);
    assert.equal(result.manifest.distributionProfile, identity.distributionProfile);
    assert.ok(result.manifest.artifacts.every(value => value.fileName.includes('showcase.dddddddddddd')));
    assert.throws(() => selectArtifact(result.manifest, { version: SDK_RELEASE_VERSION, platform: 'macos', arch: 'arm64' }), /schema, runtime version or ABI/);
    for (const select of [selectFlutterArtifact, selectReactNativeArtifact]) {
      const expected = { version: SDK_RELEASE_VERSION, platform: 'macos', arch: 'arm64', ...identity };
      assert.equal(select(result.manifest, expected).policySha256, identity.policySha256);
      assert.throws(() => select(result.manifest, { ...expected, distributionProfile: 'full', policySha256: null }), /policy SHA-256 mismatch/);
    }
    f.json(`${f.sdk}/package.json`, { ...f.receipt, distributionProfile: 'full', policySha256: null });
    assert.throws(() => prepareArchivePlans(options), /mismatch/);
    f.json(`${f.sdk}/package.json`, f.receipt);
    const target = f.receipt.native[0].target;
    f.json(`licenses/${target}/licenses.json`, { schemaVersion: 1, target, features: [], source: { sourceCommit: f.receipt.native[0].sourceCommit, sourceDirty: false }, packages: [{ name: 'pkg', files: [{ path: 'pkg/LICENSE', sha256: hash('third party license\n') }] }] });
    assert.throws(() => prepareArchivePlans(options), /exact source and feature graph/);
  } finally { f.remove(); }
});

test('independent platform releases retain their exact native source commits in one restricted manifest', async () => {
  const identity = { distributionProfile: 'restricted-showcase', policySha256: 'd'.repeat(64) };
  const macos = fixture('macos', identity, '1'.repeat(40)), linux = fixture('linux', identity, '2'.repeat(40));
  try {
    cpSync(linux.runtimeRoot, macos.runtimeRoot, { recursive: true });
    const result = await buildRuntimeArchives({ runtimeRoot: macos.runtimeRoot, platforms: ['macos', 'linux'],
      expectedDistribution: identity, outDirectory: resolve(macos.directory, 'independent-platforms') });
    assert.equal(result.manifest.artifacts.length, 5);
    for (const platform of ['macos', 'linux']) {
      const expected = (platform === 'macos' ? '1' : '2').repeat(40);
      const artifacts = result.provenance.artifacts.filter(value => value.platform === platform);
      assert.ok(artifacts.length);
      for (const artifact of artifacts) {
        const sources = artifact.component === 'runtime' ? [artifact.producer.sourceCommit]
          : artifact.producer.native.map(value => value.sourceCommit);
        assert.ok(sources.every(value => value === expected));
        assert.equal(artifact.contractVerification.status, 'passed');
      }
    }
  } finally { macos.remove(); linux.remove(); }
});

test('dirty, failed, missing or incompatible producers never yield an archive plan', () => {
  const f = fixture(); try {
    for (const patch of [{ sourceDirty: true }, { status: 'failed' }, { sdkVersion: '0.1.0-preview.2' }, { sdkVersion: '0.1.0-preview.5.1' }, { sdkVersion: '0.1.0-preview.5.2' }]) {
      f.json(`${f.sdk}/package.json`, { ...f.receipt, ...patch });
      assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['macos'] }), /clean .*producer receipt/);
    }
    f.json(`${f.sdk}/package.json`, f.receipt);
    const dirty = structuredClone(f.receipt); dirty.native[0].sourceDirty = true;
    f.json(`${f.sdk}/package.json`, dirty);
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['macos'] }), /clean .*producer receipt/);
    for (const oldVersion of ['0.1.0-preview.5.1', '0.1.0-preview.5.2', '0.1.0-preview.5.3']) {
      const mixed = structuredClone(f.receipt); mixed.native[0].sdkVersion = oldVersion;
      f.json(`${f.sdk}/package.json`, mixed);
      assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['macos'] }), /clean .* native producer receipt/);
    }
    const mixedSource = structuredClone(f.receipt); mixedSource.native[0].sourceCommit = '2'.repeat(40);
    f.json(`${f.sdk}/package.json`, mixedSource);
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['macos'] }), /one clean producer source/);
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['ios'] }), /ENOENT/);
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['windows'] }), /ENOENT/);
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['unsupported'] }), /absent platforms/);
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['macos', 'macos'] }), /distinct/);
  } finally { f.remove(); }
});

test('producer hash mutation, foreign files, core sources and symlinks are rejected', () => {
  for (const mutation of ['binary', 'license', 'unlisted-license', 'source', 'foreign', 'link', 'unhashed-library', 'header']) {
    const f = fixture(); try {
      if (mutation === 'binary') f.write(`${f.sdk}/lib/libweapp_container_sdk.a`, 'tampered');
      if (mutation === 'license') f.write('licenses/aarch64-apple-darwin/pkg/LICENSE', 'tampered');
      if (mutation === 'unlisted-license') f.write('licenses/aarch64-apple-darwin/private.java', 'unlisted private source');
      if (mutation === 'source') f.write(`${f.sdk}/include/core.rs`, 'private source');
      if (mutation === 'foreign') f.write(`${f.sdk}/include/secret.txt`, 'foreign');
      if (mutation === 'link') symlinkSync('/etc/passwd', resolve(f.runtimeRoot, f.sdk, 'include/linked'));
      if (mutation === 'unhashed-library') { f.receipt.artifacts.pop(); f.json(`${f.sdk}/package.json`, f.receipt); }
      if (mutation === 'header') {
        const native = f.receipt.native[0];
        const header = native.artifacts.find(value => value.file === 'weapp_container_sdk.h');
        f.write(`native/${native.target}/weapp_container_sdk.h`, 'unreviewed ABI'); header.bytes = Buffer.byteLength('unreviewed ABI'); header.sha256 = hash('unreviewed ABI');
        f.json(`native/${native.target}/build.json`, native); f.json(`${f.sdk}/package.json`, f.receipt);
      }
      assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['macos'] }), /mismatch|forbidden|whitelist|Links|Unlisted|missing its producer hash|reviewed SDK contract/);
    } finally { f.remove(); }
  }
});

test('existing output files, directories and dangling symlinks remain unchanged', async () => {
  const f = fixture(); try {
    for (const kind of ['file', 'directory', 'dangling-link']) {
      const out = resolve(f.directory, `existing-${kind}`);
      if (kind === 'file') writeFileSync(out, 'user data');
      else if (kind === 'directory') mkdirSync(out);
      else symlinkSync('missing-user-target', out);
      await assert.rejects(buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['macos'], outDirectory: out }), /new independent directory/);
      if (kind === 'file') assert.equal(readFileSync(out, 'utf8'), 'user data');
      else if (kind === 'directory') assert.deepEqual(readdirSync(out), []);
      else { assert.equal(lstatSync(out).isSymbolicLink(), true); assert.equal(readlinkSync(out), 'missing-user-target'); }
    }
  } finally { f.remove(); }
});

test('exclusive publication refuses late output collisions and publishes the manifest last', () => {
  const f = fixture(); try {
    const staging = resolve(f.directory, 'verified-staging'); mkdirSync(staging);
    writeFileSync(resolve(staging, 'fixture.tar.gz'), 'verified fixture bytes');
    writeFileSync(resolve(staging, 'runtime-artifacts.lock.json'), '{}');
    for (const kind of ['directory', 'dangling-link']) {
      const collision = resolve(f.directory, `late-${kind}`);
      if (kind === 'directory') { mkdirSync(collision); writeFileSync(resolve(collision, 'owned-by-other-task'), 'preserve'); }
      else symlinkSync('not-created', collision);
      assert.throws(() => publishVerifiedArchives(staging, collision), /EEXIST/);
      if (kind === 'directory') assert.equal(readFileSync(resolve(collision, 'owned-by-other-task'), 'utf8'), 'preserve');
      else assert.equal(readlinkSync(collision), 'not-created');
    }
    const output = resolve(f.directory, 'new-publication'); publishVerifiedArchives(staging, output);
    assert.equal(readFileSync(resolve(output, 'fixture.tar.gz'), 'utf8'), 'verified fixture bytes');
    assert.equal(existsSync(resolve(output, 'runtime-artifacts.lock.json')), true);
  } finally { f.remove(); }
});

test('an output parent alias into the producer tree is rejected', async () => {
  const f = fixture(); try {
    const alias = resolve(f.directory, 'producer-alias'); symlinkSync(f.runtimeRoot, alias);
    await assert.rejects(buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['macos'], outDirectory: resolve(alias, 'must-not-appear') }), /resolves inside producer inputs/);
    assert.equal(existsSync(resolve(f.runtimeRoot, 'must-not-appear')), false);
  } finally { f.remove(); }
});

test('nested classes.jar cannot smuggle core source inside a producer-hashed Android AAR', async () => {
  const f = fixture(); try {
    const native = [];
    const targets = ['aarch64-linux-android', 'x86_64-linux-android'];
    for (const [i, old] of f.receipt.native.entries()) {
      const target = targets[i], value = structuredClone(old);
      value.target = target; value.platform = 'android'; value.features = ['quickjs-native-android', 'skia-gpu-gles'];
      for (const artifact of value.artifacts) {
        const original = artifact.file;
        if (artifact.file.endsWith('.dylib')) artifact.file = 'libweapp_container_sdk.so';
        f.write(`native/${target}/${artifact.file}`, readFileSync(resolve(f.runtimeRoot, 'native', old.target, original)));
      }
      f.write(`native/${target}/RUNTIME-LICENSE`, 'runtime license');
      f.json(`native/${target}/build.json`, value); native.push(value);
      cpSync(resolve(f.runtimeRoot, 'licenses', old.target), resolve(f.runtimeRoot, 'licenses', target), { recursive: true });
      const licenseIndex = JSON.parse(readFileSync(resolve(f.runtimeRoot, 'licenses', target, 'licenses.json'), 'utf8'));
      f.json(`licenses/${target}/licenses.json`, { ...licenseIndex, target });
    }
    f.write('native/RUNTIME-LICENSE', 'runtime license');
    const file = `com/sonofmagic/weapp/weapp-container-android/${SDK_RELEASE_VERSION}/weapp-container-android-${SDK_RELEASE_VERSION}.aar`;
    const path = f.write(`android/maven/${file}`, '');
    const made = spawnSync('python3', ['-c', "import io,sys,zipfile\ninner=io.BytesIO()\nwith zipfile.ZipFile(inner,'w') as z:z.writestr('private/core.rs','private core source')\nwith zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('classes.jar',inner.getvalue())", path]);
    assert.equal(made.status, 0);
    const sourcesFile = file.replace(/\.aar$/, '-sources.jar');
    const sourcesPath = f.write(`android/maven/${sourcesFile}`, ''); androidSourcesJar(sourcesPath);
    const reviewed = reviewedSource('android');
    f.json('android/distribution.json', { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'passed', sourceCommit: reviewed.sourceCommit, sourceInventorySha256: reviewed.sourceInventorySha256, sourceDirty: false, native, mavenArtifacts: [{ file, sha256: hash(readFileSync(path)) }, { file: sourcesFile, sha256: hash(readFileSync(sourcesPath)) }] });
    const out = resolve(f.directory, 'must-not-publish');
    await assert.rejects(buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['android'], outDirectory: out }), /ERR_ARCHIVE_SOURCE_MEMBER: private\/core\.rs/);
    assert.equal(existsSync(out), false);
    assert.equal(readdirSync(f.directory).some(value => value.startsWith('.must-not-publish-')), false);
  } finally { f.remove(); }
});

test('AGP AAR metadata and public SDK sources are accepted; foreign members produce bounded redacted diagnostics', () => {
  const f = fixture(); try {
    const aar = f.write('standard.aar', ''), sources = f.write('public-sources.jar', ''), foreign = f.write('foreign.aar', '');
    const made = spawnSync('python3', ['-c', `import io,sys,zipfile
inner=io.BytesIO()
with zipfile.ZipFile(inner,'w') as z:z.writestr('com/sonofmagic/weapp/container/sdk/Models.class',b'fixture class bytes')
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('META-INF/com/android/build/gradle/aar-metadata.properties','aarFormatVersion=1.0')
 z.writestr('classes.jar',inner.getvalue())
with zipfile.ZipFile(sys.argv[3],'w') as z:z.writestr('META-INF/ghp_examplecredential/foreign.properties','rejected')`, aar, sources, foreign]);
    assert.equal(made.status, 0);
    androidSourcesJar(sources);
    appendZipEntries(aar, androidSdkNoticeEntries());
    assert.deepEqual(verifyAndroidArchiveInputs([aar, sources]), { status: 'passed', files: 2, scope: 'Read-only ZIP member closure; no production archive generated' });
    assert.throws(() => verifyAndroidArchiveInputs([foreign]), error => {
      assert.match(error.message, /ERR_ARCHIVE_ANDROID_MEMBER: META-INF\/\[REDACTED\]\/foreign\.properties/);
      assert.equal(error.message.includes('ghp_examplecredential'), false);
      assert.ok(error.message.length < 512);
      return true;
    });
  } finally { f.remove(); }
});

test('Android notices must retain the committed SDK closure and cannot admit foreign platform or unreviewed dependency texts', () => {
  const f = fixture(); try {
    for (const mutation of ['missing', 'changed', 'foreign', 'platform']) {
      const path = f.write(`notices-${mutation}.aar`, '');
      const made = spawnSync('python3', ['-c', "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w'):pass", path]);
      assert.equal(made.status, 0);
      const entries = androidSdkNoticeEntries();
      if (mutation === 'missing') entries.pop();
      if (mutation === 'changed') entries[0].content = Buffer.from('changed notice').toString('base64');
      if (mutation === 'foreign') entries.push({ file: 'assets/weapp-container/sdk-dependencies/licenses/unreviewed-LICENSE.txt', content: Buffer.from('foreign').toString('base64') });
      if (mutation === 'platform') entries.push({ file: 'assets/weapp-container/licenses/aarch64-apple-ios/licenses.json', content: Buffer.from('{}').toString('base64') });
      appendZipEntries(path, entries);
      assert.throws(() => verifyAndroidArchiveInputs([path]), mutation === 'missing' ? /ERR_ARCHIVE_ANDROID_NOTICE_CLOSURE/ : mutation === 'changed' ? /ERR_ARCHIVE_ANDROID_NOTICE_HASH/ : /ERR_ARCHIVE_ANDROID_MEMBER/);
    }
  } finally { f.remove(); }
});

test('runtime layout installs offline and is accepted by the actual independent SDK native/notices readers', async () => {
  const f = fixture(); try {
    const out = resolve(f.directory, 'release'), prepared = await buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['macos'], outDirectory: out });
    const target = 'aarch64-apple-darwin', nativeRoot = resolve(f.directory, 'installed/native'), licensesRoot = resolve(f.directory, 'installed/licenses');
    const installed = resolve(nativeRoot, target);
    await downloadRuntimeArtifact({ manifestPath: resolve(out, 'runtime-artifacts.lock.json'), version: SDK_RELEASE_VERSION, platform: 'macos', arch: 'arm64', component: 'runtime',
      artifactDirectory: out, outDirectory: resolve(f.directory, 'downloads'), installDirectory: installed, fetchImpl() { throw Error('Offline fixture must not use network'); } });
    cpSync(resolve(installed, 'licenses'), resolve(licensesRoot, target), { recursive: true });
    cpSync(resolve(installed, 'RUNTIME-LICENSE'), resolve(nativeRoot, 'RUNTIME-LICENSE'));
    const original = readFileSync(resolve(f.runtimeRoot, 'native', target, 'build.json'));
    assert.deepEqual(readFileSync(resolve(installed, 'build.json')), original);
    assert.equal(existsSync(resolve(installed, 'native-build.json')), false);
    const distribution = JSON.parse(readFileSync(resolve(installed, 'runtime-distribution.json'), 'utf8'));
    assert.deepEqual(distribution.producerReceipt, { file: 'build.json', sha256: hash(original) });
    for (const consumer of [androidNative, iosNative, desktopNative]) {
      assert.equal(consumer.readNative(nativeRoot, target, ['libweapp_container_sdk.a']).distribution.target, target);
      assert.ok(consumer.readNotices(nativeRoot, licensesRoot, target).runtimeLicense);
    }
    const license = readFileSync(new URL('../sdk/contract/LICENSE', import.meta.url));
    assert.deepEqual(readFileSync(resolve(installed, 'SDK-CONTRACT-LICENSE')), license);
    const notice = JSON.parse(readFileSync(resolve(installed, 'SDK-CONTRACT-NOTICE.json'), 'utf8'));
    assert.equal(notice.license, 'Apache-2.0'); assert.equal(notice.licenseSha256, hash(license));
    assert.equal(notice.publicHeaders[0].sha256, androidNative.HEADER_SHA256);
    assert.match(notice.scope, /Runtime binaries remain under RUNTIME-LICENSE/);
    assert.ok(prepared.provenance.artifacts.every(artifact => artifact.inventory.some(file => file.file === 'SDK-CONTRACT-LICENSE')));
  } finally { f.remove(); }
});

test('all committed iOS identity, device and cleanup wrappers are archived with their reviewed source inventory', async () => {
  const f = fixture('ios'); try {
    const output = resolve(f.directory, 'ios-archives');
    const result = await buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['ios'], outDirectory: output });
    assert.equal(result.manifest.artifacts.length, 4);
    const sdk = result.provenance.artifacts.find(value => value.component === 'ios-sdk');
    for (const record of reviewedSource('ios').records) assert.ok(sdk.inventory.some(file => file.file === record.path && file.sha256 === record.sha256));
    assert.ok(sdk.inventory.some(file => file.file === 'Sources/WeappContainer/AccountCleanupQueue.swift'));
    for (const file of ['docs/EMBEDDING.md', 'docs/window-metrics.md']) {
      assert.ok(sdk.inventory.some(record => record.file === file && record.sha256 === hash(reviewedSource('ios').source(file))));
    }
    assert.equal(sdk.producer.sourceInventorySha256, reviewedSource('ios').sourceInventorySha256);
    assert.ok(sdk.inventory.some(file => file.file === 'SDK-SOURCE-INVENTORY.json' && file.sha256 === sdk.producer.sourceInventorySha256));
  } finally { f.remove(); }
});

test('iOS public documentation requires exact reviewed bytes and a complete explicit closure', () => {
  for (const file of ['docs/EMBEDDING.md', 'docs/window-metrics.md']) for (const mutation of ['changed', 'missing']) {
    const f = fixture('ios'); try {
      if (mutation === 'changed') {
        f.write(`${f.sdk}/${file}`, 'producer-authorized but unreviewed documentation');
        f.receipt.artifacts.find(record => record.file === file).sha256 = hash('producer-authorized but unreviewed documentation');
      } else {
        f.receipt.artifacts = f.receipt.artifacts.filter(record => record.file !== file);
      }
      f.json(`${f.sdk}/build.json`, f.receipt);
      assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['ios'] }), /hash\/size mismatch|documentation closure is incomplete/);
    } finally { f.remove(); }
  }
  const f = fixture('ios'); try {
    const file = 'docs/private-host-configuration.md';
    f.write(`${f.sdk}/${file}`, 'not a public release document');
    f.receipt.artifacts.push({ file, sha256: hash('not a public release document') });
    f.json(`${f.sdk}/build.json`, f.receipt);
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['ios'] }), /outside release whitelist/);
  } finally { f.remove(); }
});

test('Windows and Linux exact native layouts produce single-architecture archives that install through the real contract', async () => {
  for (const platform of ['windows', 'linux']) {
    const f = fixture(platform); try {
      const output = resolve(f.directory, `${platform}-archives`);
      const result = await buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: [platform], outDirectory: output });
      assert.equal(result.manifest.artifacts.length, 2);
      assert.ok(result.manifest.artifacts.every(file => file.arch === 'x86_64' && file.architectures === undefined));
      for (const component of ['runtime', 'desktop-sdk']) {
        const installed = resolve(f.directory, `installed-${component}`);
        if (component === 'desktop-sdk') {
          const workDirectory = resolve(f.directory, 'consumer-work'); mkdirSync(workDirectory);
          const evidence = await installDesktopConsumerArchive({ manifestPath: resolve(output, 'runtime-artifacts.lock.json'), platform, artifactDirectory: output, workDirectory, installDirectory: installed });
          assert.equal(evidence.kind, 'fresh-runtime-archive');
          assert.equal(evidence.installation.reused, false);
          assert.equal(evidence.archiveSha256, result.manifest.artifacts.find(file => file.component === component).sha256);
          assert.equal(evidence.manifestSha256, hash(readFileSync(resolve(output, 'runtime-artifacts.lock.json'))));
        } else await downloadRuntimeArtifact({ manifestPath: resolve(output, 'runtime-artifacts.lock.json'), version: SDK_RELEASE_VERSION, platform, arch: 'x86_64', component, artifactDirectory: output, outDirectory: resolve(f.directory, 'downloads'), installDirectory: installed, fetchImpl() { throw Error('Offline fixture must not use network'); } });
        assert.ok(existsSync(resolve(installed, component === 'runtime' ? platform === 'windows' ? 'weapp_container_sdk.dll' : 'libweapp_container_sdk.so' : `lib/${platform === 'windows' ? 'weapp_container_desktop.lib' : 'libweapp_container_desktop.a'}`)));
        if (platform === 'windows') {
          assert.equal(existsSync(resolve(installed, component === 'runtime' ? 'weapp_container_sdk.lib' : 'lib/weapp_container_sdk.lib')), false);
          assert.ok(existsSync(resolve(installed, component === 'runtime' ? 'weapp_container_sdk.dll.lib' : 'lib/weapp_container_sdk.dll.lib')));
          if (component === 'desktop-sdk') assert.ok(existsSync(resolve(installed, 'bin/weapp_container_sdk.dll')));
        }
        if (component === 'desktop-sdk') {
          assert.ok(existsSync(resolve(installed, 'include/weapp/device_apis.hpp')));
          assert.equal(existsSync(resolve(installed, 'share/weapp-container/consumer')), false);
          const harness = resolve(f.directory, 'external-consumer');
          const receipt = JSON.parse(readFileSync(resolve(installed, 'package.json')));
          const consumer = prepareDesktopConsumerHarness({ sourceRoot: new URL('../sdk/desktop', import.meta.url).pathname, receipt, destination: harness });
          assert.equal(consumer.kind, 'external-reviewed-sdk-examples');
          assert.equal(consumer.sourceCommit, receipt.sourceCommit);
          assert.equal(consumer.files.length, 8);
          assert.match(readFileSync(resolve(harness, 'CMakeLists.txt'), 'utf8'), /find_package\(WeappContainerDesktop CONFIG REQUIRED\)/);
        }
      }
    } finally { f.remove(); }
  }
});

test('SDK source identity, complete wrapper closure and wrapper bytes are enforced independently of producer hashes', () => {
  for (const platform of ['macos', 'ios']) for (const mutation of ['inventory', 'source', 'missing', 'foreign']) {
    const f = fixture(platform); try {
      const receiptPath = platform === 'ios' ? 'build.json' : 'package.json';
      const record = reviewedSource(platform).records[0];
      if (mutation === 'inventory') f.receipt.sourceInventorySha256 = '0'.repeat(64);
      if (mutation === 'source') {
        f.write(`${f.sdk}/${record.path}`, 'changed public wrapper');
        const producer = f.receipt.artifacts.find(file => file.file === record.path);
        if (producer) producer.sha256 = hash('changed public wrapper');
      }
      if (mutation === 'missing') {
        rmSync(resolve(f.runtimeRoot, f.sdk, record.path));
        f.receipt.artifacts = f.receipt.artifacts.filter(file => file.file !== record.path);
      }
      if (mutation === 'foreign') {
        const file = platform === 'ios' ? 'Sources/WeappContainer/Unreviewed.swift' : 'include/weapp/unreviewed.hpp';
        f.write(`${f.sdk}/${file}`, 'unreviewed public wrapper');
        f.receipt.artifacts.push({ file, sha256: hash('unreviewed public wrapper') });
      }
      f.json(`${f.sdk}/${receiptPath}`, f.receipt);
      assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: [platform] }), /inventory hash mismatch|hash\/size mismatch|closure is incomplete|outside release whitelist/);
    } finally { f.remove(); }
  }
});

test('Android sources require every exact committed Kotlin wrapper and reject additions or changed bytes', () => {
  for (const mutation of ['missing', 'changed', 'added']) {
    const f = fixture(); try {
      const path = f.write(`${mutation}-sources.jar`, '');
      androidSourcesJar(path, { [mutation]: true });
      assert.throws(() => verifyAndroidArchiveInputs([path]), /ERR_ARCHIVE_ANDROID_SOURCE_CLOSURE|ERR_ARCHIVE_ANDROID_SOURCE_HASH|ERR_ARCHIVE_ANDROID_MEMBER/);
    } finally { f.remove(); }
  }
});

test('foreign native formats are rejected for each platform producer', () => {
  for (const platform of ['windows', 'linux']) {
    const f = fixture(platform); try {
      const receipt = f.receipt.native[0], file = platform === 'windows' ? 'libweapp_container_sdk.a' : 'weapp_container_sdk.dll';
      f.write(`native/${receipt.target}/${file}`, 'foreign native bytes');
      receipt.artifacts.push({ file, bytes: Buffer.byteLength('foreign native bytes'), sha256: hash('foreign native bytes') });
      f.json(`native/${receipt.target}/build.json`, receipt); f.json(`${f.sdk}/package.json`, f.receipt);
      assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: [platform] }), /outside the release whitelist/);
    } finally { f.remove(); }
  }
});


test('runtime-only release validates native bytes and offline installation without a wrapper claim', async () => {
  const f = fixture('linux');
  try {
    rmSync(resolve(f.runtimeRoot, f.sdk), { recursive: true });
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['linux'] }));
    const result = await buildRuntimeArchives({ runtimeRoot: f.runtimeRoot, platforms: ['linux'], runtimeOnly: true, outDirectory: resolve(f.directory, 'native-only') });
    assert.deepEqual(result.manifest.artifacts.map(value => value.component), ['runtime']);
    assert.equal(result.provenance.artifacts[0].contractVerification.status, 'passed');
    const target = 'x86_64-unknown-linux-gnu';
    f.write(`native/${target}/libweapp_container_sdk.so`, 'changed bytes');
    assert.throws(() => prepareArchivePlans({ runtimeRoot: f.runtimeRoot, platforms: ['linux'], runtimeOnly: true }), /hash|size/i);
  } finally { f.remove(); }
});

test('runtime-only release rejects mixed source revisions across selected platforms', () => {
  const a = fixture('macos'), b = fixture('linux', {}, '2'.repeat(40));
  try {
    const target = 'x86_64-unknown-linux-gnu';
    for (const name of ['native', 'licenses']) cpSync(resolve(b.runtimeRoot, name, target), resolve(a.runtimeRoot, name, target), { recursive: true });
    assert.throws(() => prepareArchivePlans({ runtimeRoot: a.runtimeRoot, platforms: ['macos', 'linux'], runtimeOnly: true }), /one clean producer source/);
  } finally { a.remove(); b.remove(); }
});
