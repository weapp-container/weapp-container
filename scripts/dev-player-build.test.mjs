import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { captureOutputDirectory, captureSources, compareSources, runBuild, verifyBuildReceipt } from './dev-player-build.mjs';
import { nativeProducerFixture } from './fixtures/sdk-native-producer.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'player-build-source-'));
  function write(name, bytes) { const path = resolve(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
  function git(directory, args) { const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); }
  function repository(directory) { mkdirSync(directory, { recursive: true }); git(directory, ['init', '-q']); }
  function commit(directory) { git(directory, ['add', '.']); git(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']); }
  repository(root);
  write('.gitignore', 'sdk/\nartifacts/\napps/dev-player/build/\napps/dev-player/macos/Flutter/ephemeral/\n');
  write('Cargo.toml', '[workspace]\n'); write('scripts/dev-player-build.mjs', '// exact fixture helper\n');
  write('apps/dev-player/lib/main.dart', 'void main() {}\n'); write('apps/dev-player/pubspec.lock', 'packages: {}\n');
  write('apps/dev-player/macos/Runner.xcodeproj/project.pbxproj', 'authored project\n');
  commit(root);
  for (const sdk of ['contract', 'android', 'ios', 'desktop', 'flutter']) {
    const directory = resolve(root, 'sdk', sdk); repository(directory);
    write(`sdk/${sdk}/.gitignore`, '**/vendor/\n**/native_shared/\n'); write(`sdk/${sdk}/source.txt`, `SDK ${sdk}\n`); commit(directory);
  }
  const packageReceipt = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'verified', sourceCommit: '1'.repeat(40), sourceDirty: false, platform: 'macos-arm64', native: [nativeProducerFixture()] };
  write('artifacts/runtime/package.json', JSON.stringify(packageReceipt));
  const args = ['--platform', 'macos', '--out', 'artifacts/build', '--desktop-sdk', 'artifacts/runtime', '--flutter', 'fake-flutter'];
  function runner(command, argv) {
    if (argv[0]?.includes('prepare.mjs')) {
      write('sdk/flutter/weapp_container_macos/macos/vendor/lib/runtime.a', 'exact native binary\n');
      write('sdk/flutter/weapp_container_macos/macos/native_shared/header.h', 'reviewed shared header\n');
      write('sdk/flutter/weapp_container_macos/macos/vendor/prepared.json', JSON.stringify({ schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, target: 'macos', sourceDirty: false, packageReceipt }));
    } else if (argv[0] === 'pub') {
      write('apps/dev-player/macos/Flutter/GeneratedPluginRegistrant.swift', '// generated registrant\n');
      write('apps/dev-player/macos/Flutter/ephemeral/generated.xcconfig', 'local toolchain\n');
    } else if (argv[0] === 'build') {
      write('apps/dev-player/macos/Podfile.lock', 'PODS: [reviewed]\n');
      write('apps/dev-player/build/macos/Build/Products/Release/Player.app/Contents/MacOS/Player', 'fixture application output only\n');
    }
    return { status: 0, signal: null };
  }
  return { root, write, args, runner, receipt: resolve(root, 'artifacts/build/macos/build.json'), remove() { rmSync(root, { recursive: true }); } };
}

test('source binding includes dirty/untracked core, player and each independent SDK', () => {
  const f = fixture(); try {
    const before = captureSources(f.root, 'macos');
    assert.deepEqual(before.components.map(value => value.name), ['core', 'player', 'sdk/contract', 'sdk/android', 'sdk/ios', 'sdk/desktop', 'sdk/flutter']);
    f.write('sdk/flutter/new-source.dart', 'new source\n');
    const after = captureSources(f.root, 'macos');
    assert.notEqual(before.authoredSha256, after.authoredSha256);
    assert.equal(after.components.at(-1).dirty, true);
    assert.equal(compareSources(before, after, 'build').status, 'failed');
  } finally { f.remove(); }
});

test('allowed Flutter/Pod generated changes are hashed separately; authored project edits fail', () => {
  const f = fixture(); try {
    const before = captureSources(f.root, 'macos');
    f.write('apps/dev-player/macos/Flutter/GeneratedPluginRegistrant.swift', '// generated\n');
    f.write('apps/dev-player/macos/Podfile.lock', 'PODS: []\n');
    const after = captureSources(f.root, 'macos');
    assert.equal(before.authoredSha256, after.authoredSha256);
    const transition = compareSources(before, after, 'build');
    assert.equal(transition.status, 'bound'); assert.equal(transition.changes.length, 2);
    assert.ok(transition.changes.every(value => value.after.sha256.length === 64));
    assert.equal(compareSources(before, after, 'prepare').status, 'failed');
    f.write('apps/dev-player/macos/Runner.xcodeproj/project.pbxproj', 'unexpected authored setting change\n');
    assert.equal(compareSources(after, captureSources(f.root, 'macos'), 'build').status, 'failed');
  } finally { f.remove(); }
});

test('successful fixture build binds all stages and output; missing hashes and stale sources are rejected', () => {
  const f = fixture(); try {
    const receipt = runBuild(f.args, { root: f.root, host: 'darwin', runner: f.runner });
    assert.equal(receipt.status, 'built', receipt.error);
    assert.equal(verifyBuildReceipt(receipt, captureSources(f.root, 'macos'), receipt.artifacts), true);
    assert.equal(receipt.sourceBinding.snapshots.length, 4);
    assert.ok(receipt.sourceBinding.transitions.some(value => value.changes.some(change => change.kind === 'generated-build-input')));
    const corrupt = structuredClone(receipt); delete corrupt.sourceBinding.snapshots[0].source.components[0].files[0].sha256;
    assert.throws(() => verifyBuildReceipt(corrupt), /identity/);
    assert.throws(() => verifyBuildReceipt({ schemaVersion: 1, sdkVersion: '0.1.0-preview.5.2', status: 'built' }), /source-bound/);
    assert.throws(() => verifyBuildReceipt(receipt), /Current hashed source/);
    const current = captureSources(f.root, 'macos');
    f.write('apps/dev-player/build/macos/Build/Products/Release/Player.app/Contents/MacOS/Player', 'tampered output');
    const modified = captureOutputDirectory(resolve(f.root, receipt.artifacts.path));
    assert.throws(() => verifyBuildReceipt(receipt, current, modified), /output differs/);
    f.write('apps/dev-player/lib/main.dart', 'void main() { print("changed"); }\n');
    assert.throws(() => verifyBuildReceipt(receipt, captureSources(f.root, 'macos')), /Stale/);
  } finally { f.remove(); }
});

test('real failure code is retained; earlier preview.2 receipt survives byte-for-byte', () => {
  const f = fixture(); try {
    const previous = '{"sdkVersion":"0.1.0-preview.2","status":"failed","exitCode":99}\n';
    f.write('artifacts/build/macos/build.json', previous);
    const receipt = runBuild(f.args, { root: f.root, host: 'darwin', runner(command, argv, options) {
      if (argv[0] === 'build') return { status: 65, signal: null };
      return f.runner(command, argv, options);
    } });
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.steps.at(-1).exitCode, 65);
    assert.equal(receipt.signing, 'not-verified'); assert.equal(receipt.artifacts, undefined);
    assert.ok(receipt.sourceBinding.failedFinal);
    assert.equal(readFileSync(resolve(f.root, `artifacts/build/macos/history/build-${sha(previous)}.json`), 'utf8'), previous);
    assert.throws(() => verifyBuildReceipt(receipt), /source-bound/);
  } finally { f.remove(); }
});

test('native binary mutation during Flutter build cannot produce a successful receipt', () => {
  const f = fixture(); try {
    const receipt = runBuild(f.args, { root: f.root, host: 'darwin', runner(command, argv, options) {
      const result = f.runner(command, argv, options);
      if (argv[0] === 'build') f.write('sdk/flutter/weapp_container_macos/macos/vendor/lib/runtime.a', 'unexpected replacement');
      return result;
    } });
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.steps.at(-1).exitCode, 0);
    assert.match(receipt.error, /changed unexpectedly/);
    assert.equal(receipt.sourceBinding.transitions.at(-1).status, 'failed');
    assert.ok(existsSync(f.receipt));
  } finally { f.remove(); }
});

test('Android NDK selection is explicit, recorded and bound to the Flutter build command', () => {
  for (const version of [undefined, '27.1.12297006']) {
    const f = fixture(); try {
      f.write('sdk/flutter/.gitignore', '**/vendor/\n**/native_shared/\n**/native/\n');
      const args = ['--platform', 'android', '--out', 'artifacts/build', '--flutter', 'fake-flutter'];
      if (version) args.push('--android-ndk-version', version);
      const receipt = runBuild(args, { root: f.root, host: 'darwin', runner(command, argv) {
        if (argv[0]?.includes('prepare-native.mjs')) {
          f.write('sdk/flutter/weapp_container_android/native/runtime.aar', 'fixture native AAR only\n');
          f.write('sdk/flutter/weapp_container_android/native/.runtime-install.json', JSON.stringify({ schemaVersion: 1, identity: { runtimeVersion: SDK_RELEASE_VERSION, abiVersion: 1, platform: 'android', component: 'android-sdk' }, archiveSha256: 'a'.repeat(64) }));
          f.write('sdk/flutter/weapp_container_android/native/distribution.json', JSON.stringify({ schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: 'passed', sourceCommit: '1'.repeat(40), sourceDirty: false, native: ['aarch64-linux-android', 'x86_64-linux-android'].map(target => nativeProducerFixture(target)) }));
        }
        if (argv[0] === 'build') f.write('apps/dev-player/build/app/outputs/flutter-apk/app-release.apk', 'fixture APK only\n');
        return { status: 0, signal: null };
      } });
      assert.equal(receipt.status, 'built', receipt.error);
      assert.equal(receipt.androidNdkOverride, version ?? null);
      assert.deepEqual(receipt.steps.at(-1).argv.filter(value => value.startsWith('--android-project-arg=')), version ? [`--android-project-arg=weappContainerNdkVersion=${version}`] : []);
      const current = captureSources(f.root, 'android');
      assert.equal(verifyBuildReceipt(receipt, current, receipt.artifacts), true);
      const changed = structuredClone(receipt);
      changed.androidNdkOverride = version ? '28.2.13676358' : '27.1.12297006';
      assert.throws(() => verifyBuildReceipt(changed, current, receipt.artifacts), /selection does not match/);
    } finally { f.remove(); }
  }
});

test('the new Player refuses old clean wrapper and native producer generations before Flutter builds', () => {
  for (const version of ['0.1.0-preview.5.1', '0.1.0-preview.5.2', '0.1.0-preview.5.3']) {
    const f = fixture(); try {
      const path = resolve(f.root, 'artifacts/runtime/package.json');
      const receipt = JSON.parse(readFileSync(path)); receipt.sdkVersion = version;
      f.write('artifacts/runtime/package.json', JSON.stringify(receipt));
      let calls = 0;
      const result = runBuild(f.args, { root: f.root, host: 'darwin', runner() { calls++; return { status: 0 }; } });
      assert.equal(result.status, 'failed'); assert.match(result.error, /clean .* SDK producer receipt/); assert.equal(calls, 0);
      receipt.sdkVersion = SDK_RELEASE_VERSION; receipt.native[0].sdkVersion = version;
      f.write('artifacts/runtime/package.json', JSON.stringify(receipt));
      const mixed = runBuild(f.args, { root: f.root, host: 'darwin', runner() { calls++; return { status: 0 }; } });
      assert.equal(mixed.status, 'failed'); assert.match(mixed.error, /clean .* native producer receipt/); assert.equal(calls, 0);
    } finally { f.remove(); }
  }
});

test('Android NDK override rejects malformed versions and use on another platform before building', () => {
  const f = fixture(); try {
    let calls = 0;
    const options = { root: f.root, host: 'darwin', runner() { calls++; return { status: 0 }; } };
    assert.throws(() => runBuild([...f.args, '--android-ndk-version', '27.1.12297006'], options), /only valid for Android/);
    for (const value of ['latest', '27', '27.1', '27.1.12297006-preview', '27.01.12297006', '27.1.12297006\n', '27.1.12297006;echo']) {
      assert.throws(() => runBuild(['--platform', 'android', '--android-ndk-version', value], options), /exact major.minor.build/);
    }
    assert.throws(() => runBuild(['--platform', 'android', '--android-ndk-version'], options), /requires a value/);
    assert.equal(calls, 0);
  } finally { f.remove(); }
});
