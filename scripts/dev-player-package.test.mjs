import { SDK_RELEASE_VERSION } from './lib/sdk-current-release.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { crc32, deflateRawSync } from 'node:zlib';
import { inspectApk, inventory, linuxLauncher, main, validateInputs } from './dev-player-package.mjs';
import { runBuild } from './dev-player-build.mjs';
import { nativeProducerFixture } from './fixtures/sdk-native-producer.mjs';

function apkEntries() {
  const elf = machine => { const bytes = Buffer.alloc(20); bytes.write('\x7fELF', 'binary'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(machine, 18); return bytes; };
  return [['AndroidManifest.xml', Buffer.from('inert test manifest')], ['classes.dex', Buffer.from('inert test dex')], ['assets/weapp-container/LICENSE', Buffer.from('SDK Apache-2.0 license fixture')], ['assets/weapp-container/RUNTIME-LICENSE', Buffer.from('private runtime license')], ...['aarch64-linux-android', 'x86_64-linux-android'].map(target => [`assets/weapp-container/licenses/${target}/licenses.json`, Buffer.from('{}')]), ...[['arm64-v8a', 183], ['x86_64', 62]].flatMap(([arch, machine]) => ['libweapp_container_sdk.so', 'libflutter.so', 'libapp.so'].map(name => [`lib/${arch}/${name}`, elf(machine)]))];
}
// Valid ZIP structure with inert payloads: no Android execution/signature claim.
function apkFixture(entries = apkEntries()) {
  const local = [], central = []; let offset = 0;
  for (const [file, bytes] of entries) {
    const name = Buffer.from(file), content = deflateRawSync(bytes), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, content); central.push(directory, name); offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixture(platform = 'macos') {
  const root = mkdtempSync(resolve(tmpdir(), 'player-package-test-'));
  const mobile = ['android', 'ios'].includes(platform);
  const input = resolve(root, 'apps/dev-player/build', platform === 'macos' ? 'macos/Build/Products/Release/Player.app' : platform === 'android' ? 'app/outputs/flutter-apk' : platform === 'ios' ? 'ios/iphonesimulator/Player.app' : 'linux/x64/release/bundle');
  const runtimeDir = resolve(root, mobile ? platform === 'android' ? 'sdk/flutter/weapp_container_android/native' : 'sdk/flutter/weapp_container_ios/ios/vendor/WeappContainer' : 'artifacts/runtime'), buildReceipt = resolve(root, `artifacts/build/${platform}/build.json`);
  const write = (path, value) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value); };
  const git = (directory, args) => { const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  function init(directory) { mkdirSync(directory, { recursive: true }); git(directory, ['init', '-q']); }
  function commit(directory) { git(directory, ['add', '.']); git(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']); }
  init(root);
  write(resolve(root, '.gitignore'), 'sdk/\nartifacts/\napps/dev-player/build/\n');
  write(resolve(root, 'Cargo.toml'), '[workspace]\n');
  write(resolve(root, 'scripts/dev-player-build.mjs'), '// build source fixture\n');
  write(resolve(root, 'apps/dev-player/lib/main.dart'), 'void main() {}\n');
  commit(root);
  for (const sdk of ['contract', 'android', 'ios', 'desktop', 'flutter']) {
    const directory = resolve(root, 'sdk', sdk); init(directory);
    write(resolve(directory, '.gitignore'), '**/vendor/\n**/native_shared/\n**/native/\n');
    write(resolve(directory, 'source.txt'), `SDK ${sdk}\n`);
    write(resolve(directory, 'LICENSE'), 'SDK Apache-2.0 license fixture'); commit(directory);
  }
  if (platform === 'macos') {
    write(resolve(input, 'Contents/Info.plist'), '<plist/>');
    write(resolve(input, 'Contents/MacOS/Player'), 'test fixture only');
  } else if (platform === 'android') {
    write(resolve(input, 'app-release.apk'), apkFixture());
  } else if (platform === 'ios') {
    write(resolve(input, 'Info.plist'), '<plist/>');
    write(resolve(input, 'Player'), 'inert simulator binary fixture');
    write(resolve(input, 'Frameworks/Flutter.framework/Headers/Flutter.h'), 'public Flutter engine API fixture');
    write(resolve(input, 'Frameworks/Flutter.framework/Flutter'), 'inert Flutter engine fixture');
  } else {
    mkdirSync(input, { recursive: true });
    writeFileSync(resolve(input, 'weapp_container_dev_player'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$1"\n', { mode: 0o755 });
    write(resolve(input, 'lib/libflutter_linux_gtk.so'), 'fixture only'); mkdirSync(resolve(input, 'data/flutter_assets'), { recursive: true });
  }
  if (mobile) {
    write(resolve(runtimeDir, '.runtime-install.json'), JSON.stringify({ schemaVersion: 1, identity: { runtimeVersion: SDK_RELEASE_VERSION, abiVersion: 1, component: `${platform}-sdk`, platform }, archiveSha256: 'a'.repeat(64) }));
    write(resolve(runtimeDir, 'RUNTIME-LICENSE'), 'private runtime license');
    write(resolve(runtimeDir, 'SDK-CONTRACT-LICENSE'), 'Apache-2.0 public C ABI');
    write(resolve(runtimeDir, 'SDK-CONTRACT-NOTICE.json'), '{}');
    write(resolve(runtimeDir, 'licenses/native/licenses.json'), '{}');
    write(resolve(runtimeDir, platform === 'android' ? 'distribution.json' : 'build.json'), JSON.stringify({ schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, status: platform === 'android' ? 'passed' : 'built', sourceCommit: '1'.repeat(40), sourceDirty: false, native: (platform === 'android' ? ['aarch64-linux-android', 'x86_64-linux-android'] : ['aarch64-apple-ios-sim', 'x86_64-apple-ios']).map(target => nativeProducerFixture(target)) }));
  } else {
    write(resolve(runtimeDir, 'lib/runtime.a'), 'reviewed runtime fixture');
    write(resolve(runtimeDir, 'share/weapp-container/RUNTIME-LICENSE'), 'private runtime license');
    write(resolve(runtimeDir, 'share/weapp-container/licenses/native/macos-arm64/licenses.json'), '{}');
    write(resolve(runtimeDir, 'package.json'), JSON.stringify({ schemaVersion: 1, status: 'verified', sdkVersion: SDK_RELEASE_VERSION, sourceCommit: '1'.repeat(40), sourceDirty: false, platform: `${platform}-fixture`, native: [nativeProducerFixture(platform === 'macos' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu')], artifacts: [{ file: 'lib/runtime.a', sha256: createHash('sha256').update('reviewed runtime fixture').digest('hex') }] }));
  }
  const receipt = runBuild(['--platform', platform, '--out', 'artifacts/build', ...(mobile ? platform === 'ios' ? ['--simulator'] : [] : ['--desktop-sdk', runtimeDir])], { root, host: ['macos', 'ios'].includes(platform) ? 'darwin' : 'linux', runner(command, argv) {
    if (argv[0]?.includes('prepare.mjs')) {
      write(resolve(root, `sdk/flutter/weapp_container_${platform}/${platform}/vendor/lib/runtime.a`), 'reviewed runtime fixture');
      write(resolve(root, `sdk/flutter/weapp_container_${platform}/${platform}/native_shared/header.h`), 'reviewed header fixture');
      write(resolve(root, `sdk/flutter/weapp_container_${platform}/${platform}/vendor/prepared.json`), JSON.stringify({ schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, target: platform, sourceDirty: false, packageReceipt: JSON.parse(readFileSync(resolve(runtimeDir, 'package.json'))) }));
    }
    return { status: 0, signal: null };
  } });
  assert.equal(receipt.status, 'built', receipt.error);
  return { root, sourceRoot: root, input, runtimeDir, buildReceipt, platform, write };
}

const packageArgs = (f, out) => ['--platform', f.platform, '--input', f.input, '--out', out, '--build-receipt', f.buildReceipt, '--runtime-dir', f.runtimeDir];
function appleTools({ signing = 'unsigned', platform = 'IOSSIMULATOR', architectures = 'arm64' } = {}) {
  const calls = [];
  const runner = (command, argv) => {
    calls.push([command, ...argv]);
    let stdout = '', stderr = '', status = 0;
    if (command.endsWith('/plutil')) stdout = argv.includes('CFBundleExecutable') ? 'Player\n' : 'iphonesimulator\n';
    else if (command.endsWith('/lipo')) stdout = `${architectures}\n`;
    else if (command.endsWith('/xcrun')) stdout = `platform ${platform}\n`;
    else if (command.endsWith('/codesign') && argv.includes('-d')) {
      if (signing === 'unsigned') { status = 1; stderr = 'code object is not signed at all'; }
      else if (signing === 'ad-hoc-development') stderr = 'Signature=adhoc';
      else { status = 1; stderr = 'unrecognized signing failure'; }
    } else if (command.endsWith('/ditto')) writeFileSync(argv.at(-1), 'inert test archive only; no native execution evidence');
    else if (!command.endsWith('/codesign')) assert.fail(`Unexpected packaging command: ${command}`);
    return { status, signal: null, stdout, stderr };
  };
  return { runner, calls };
}

test('input inventory is sorted, byte-bound and unchanged without publication', () => {
  const f = fixture(); try {
    const first = validateInputs(f), second = validateInputs(f);
    assert.deepEqual(first, second);
    assert.equal(first.files.length, 2);
    assert.equal(first.buildReceiptSha256.length, 64);
    assert.match(first.files[1].sha256, /^[a-f0-9]{64}$/);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('missing runtime, wrong binary hash, absent notices and foreign platform fail closed', () => {
  for (const mutate of [
    f => rmSync(resolve(f.runtimeDir, 'lib/runtime.a')),
    f => f.write(resolve(f.runtimeDir, 'lib/runtime.a'), 'tampered'),
    f => rmSync(resolve(f.runtimeDir, 'share/weapp-container/RUNTIME-LICENSE')),
    f => { f.platform = 'windows'; },
    f => f.write(f.buildReceipt, JSON.stringify({ status: 'built', sdkVersion: '0.1.0-preview.2', platform: 'macos' })),
  ]) {
    const f = fixture(); try { mutate(f); assert.throws(() => validateInputs(f)); }
    finally { rmSync(f.root, { recursive: true }); }
  }
});

test('core source, credential bytes and escaping symlinks are rejected', () => {
  for (const mutate of [
    f => f.write(resolve(f.input, 'private.rs'), 'fn core() {}'),
    f => f.write(resolve(f.input, 'secret'), 'github_pat_abcdefghijklmnopqrstuvwxyz123456'),
    f => symlinkSync(f.buildReceipt, resolve(f.input, 'escape')),
  ]) {
    const f = fixture(); try { mutate(f); assert.throws(() => inventory(f.input)); }
    finally { rmSync(f.root, { recursive: true }); }
  }
});

test('relative internal framework links retain deterministic identity', () => {
  const f = fixture(); try {
    symlinkSync('MacOS/Player', resolve(f.input, 'Contents/Player'));
    const link = inventory(f.input).find(file => file.kind === 'symlink');
    assert.equal(link.target, 'MacOS/Player'); assert.equal(link.sha256.length, 64);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('packaging rejects legacy receipts, changed sources/binaries and copied output ownership', () => {
  const f = fixture(); try {
    const originalReceipt = readFileSync(f.buildReceipt);
    const receipt = JSON.parse(originalReceipt);
    delete receipt.sourceBinding;
    f.write(f.buildReceipt, JSON.stringify(receipt));
    assert.throws(() => validateInputs(f), /source-bound/);
    f.write(f.buildReceipt, originalReceipt);
    f.write(resolve(f.sourceRoot, 'apps/dev-player/lib/main.dart'), 'void main() { print("changed"); }\n');
    assert.throws(() => validateInputs(f), /Stale/);
    f.write(resolve(f.sourceRoot, 'apps/dev-player/lib/main.dart'), 'void main() {}\n');
    const executable = resolve(f.input, 'Contents/MacOS/Player');
    const originalExecutable = readFileSync(executable);
    f.write(executable, 'different binary');
    assert.throws(() => validateInputs(f), /output differs/);
    f.write(executable, originalExecutable);
    const copy = resolve(f.root, 'Copied.app'); cpSync(f.input, copy, { recursive: true });
    assert.throws(() => validateInputs({ ...f, input: copy }), /exact application output/);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('help and foreign-host refusal never fabricate a distributable', () => {
  const help = spawnSync(process.execPath, ['scripts/dev-player-package.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /appimagetool-sha256/);
  const result = spawnSync(process.execPath, ['scripts/dev-player-package.mjs', '--platform', process.platform === 'win32' ? 'linux' : 'windows', '--input', '/missing', '--out', 'artifacts/must-not-exist', '--build-receipt', '/missing', '--runtime-dir', '/missing'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /target host OS/);
});

test('Linux launcher and output validation bind the actual Flutter CMake binary name', () => {
  const cmake = readFileSync(new URL('../apps/dev-player/linux/CMakeLists.txt', import.meta.url), 'utf8');
  const binary = cmake.match(/set\(BINARY_NAME\s+"([^"]+)"\)/)?.[1];
  assert.equal(binary, 'weapp_container_dev_player');
  const f = fixture('linux'); try {
    const appDir = resolve(f.root, 'App Dir'), app = resolve(appDir, 'app');
    mkdirSync(appDir, { recursive: true }); cpSync(f.input, app, { recursive: true });
    writeFileSync(resolve(appDir, 'AppRun'), linuxLauncher(), { mode: 0o755 });
    const result = spawnSync(resolve(appDir, 'AppRun'), ['an argument with spaces'], { cwd: tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout, `${app}\nan argument with spaces\n`);
    assert.doesNotThrow(() => validateInputs(f));
    rmSync(resolve(f.input, binary));
    assert.throws(() => validateInputs(f));
  } finally { rmSync(f.root, { recursive: true }); }
});

test('Android packaging preserves the source-bound APK and adjacent notices without claiming signature acceptance', () => {
  const f = fixture('android'); try {
    const original = readFileSync(resolve(f.input, 'app-release.apk'));
    const checked = validateInputs(f);
    assert.deepEqual(checked.apk.architectures, ['arm64-v8a', 'x86_64']);
    const out = resolve(f.root, 'artifacts/android-player');
    main(packageArgs(f, out), { sourceRoot: f.root, host: 'darwin' });
    const receipt = JSON.parse(readFileSync(resolve(out, 'package.json')));
    assert.equal(receipt.status, 'packaged'); assert.equal(receipt.privacy, 'private'); assert.equal(receipt.sdkVersion, SDK_RELEASE_VERSION);
    assert.equal(receipt.signing.verified, false); assert.equal(receipt.signing.productionIdentity, 'not-verified');
    assert.equal(receipt.acceptance.installation, 'not-run'); assert.equal(receipt.acceptance.physicalDevice, 'not-run');
    assert.deepEqual(readFileSync(resolve(out, receipt.artifact.file)), original);
    assert.equal(receipt.artifact.sha256, createHash('sha256').update(original).digest('hex'));
    assert.ok(existsSync(resolve(out, 'WeappContainerNotices/RUNTIME-LICENSE')));
    assert.ok(existsSync(resolve(out, 'WeappContainerNotices/SDK-WRAPPER-LICENSE')));
    assert.equal(receipt.source.nativeArchiveSha256, 'a'.repeat(64));
  } finally { rmSync(f.root, { recursive: true }); }
});

test('APK inspection checks compressed entries, both ELF architectures and source/credential/ZIP boundaries', () => {
  assert.equal(inspectApk(apkFixture()).entries.length, 12);
  for (const entries of [
    [...apkEntries(), ['../escape', Buffer.from('x')]],
    [...apkEntries(), ['private.rs', Buffer.from('fn private() {}')]],
    [...apkEntries(), ['assets/token', Buffer.from('github_pat_abcdefghijklmnopqrstuvwxyz123456')]],
    [...apkEntries(), ['classes.dex', Buffer.from('duplicate')]],
    [...apkEntries(), ['assets/flutter_assets/kernel_blob.bin', Buffer.from('debug kernel')]],
    apkEntries().filter(([file]) => file !== 'lib/x86_64/libweapp_container_sdk.so'),
    apkEntries().filter(([file]) => file !== 'assets/weapp-container/RUNTIME-LICENSE'),
    apkEntries().map(([file, bytes]) => [file, file === 'lib/arm64-v8a/libapp.so' ? Buffer.from('not ELF') : bytes]),
  ]) assert.throws(() => inspectApk(apkFixture(entries)));
  const corrupted = apkFixture();
  corrupted.writeUInt32LE(1, corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
  assert.throws(() => inspectApk(corrupted), /CRC/);
  assert.throws(() => inspectApk(apkFixture().subarray(0, 50)), /ZIP/);
});

test('mobile packaging refuses stale source/output/native bytes and copied native inputs', () => {
  for (const mutate of [
    f => f.write(resolve(f.input, 'app-release.apk'), Buffer.from('changed output')),
    f => f.write(resolve(f.root, 'apps/dev-player/lib/main.dart'), 'void changed() {}'),
    f => f.write(resolve(f.runtimeDir, 'RUNTIME-LICENSE'), 'changed native input'),
    f => { const copy = resolve(f.root, 'artifacts/copied-native'); cpSync(f.runtimeDir, copy, { recursive: true }); f.runtimeDir = copy; },
  ]) {
    const f = fixture('android'); try { mutate(f); assert.throws(() => validateInputs(f), /Stale|exact prepared/); }
    finally { rmSync(f.root, { recursive: true }); }
  }
});

test('iOS Simulator distribution preserves unsigned or ad-hoc bundles and never produces a device IPA', () => {
  for (const signing of ['unsigned', 'ad-hoc-development']) {
    const f = fixture('ios'); try {
      const checked = validateInputs(f), before = inventory(f.input, { simulator: true });
      assert.ok(checked.files.some(file => file.file.endsWith('/Headers/Flutter.h')));
      const out = resolve(f.root, 'artifacts/ios-player'), tools = appleTools({ signing });
      main(packageArgs(f, out), { sourceRoot: f.root, host: 'darwin', runner: tools.runner });
      const receipt = JSON.parse(readFileSync(resolve(out, 'package.json')));
      assert.equal(receipt.distributionTarget, 'ios-simulator'); assert.equal(receipt.deviceInstallEligible, false);
      assert.deepEqual(receipt.architectures, ['arm64']);
      assert.match(receipt.artifact.file, /ios-simulator\.zip$/); assert.equal(receipt.privacy, 'private');
      assert.equal(receipt.signing.kind, signing); assert.equal(receipt.signing.verified, signing !== 'unsigned');
      assert.equal(receipt.signing.productionIdentity, 'not-verified');
      assert.equal(tools.calls.some(call => call[0].endsWith('/codesign') && call.includes('--verify')), signing !== 'unsigned');
      assert.equal(tools.calls.some(call => call.includes('--sign')), false);
      assert.deepEqual(inventory(f.input, { simulator: true }), before);
      assert.equal(receipt.acceptance.gpu, 'not-run'); assert.equal(receipt.acceptance.installation, 'not-run');
    } finally { rmSync(f.root, { recursive: true }); }
  }
});

test('Simulator header exception is limited to the explicit public Flutter engine headers', () => {
  const f = fixture('ios'); try {
    assert.throws(() => inventory(f.input), /Source/);
    assert.doesNotThrow(() => inventory(f.input, { simulator: true }));
    for (const name of ['Private.h', 'Frameworks/Flutter.framework/Headers/WeappPrivate.h', 'src/core.rs', 'src/player.dart']) {
      f.write(resolve(f.input, name), 'private source');
      assert.throws(() => inventory(f.input, { simulator: true }), /Source/);
      rmSync(resolve(f.input, name));
    }
  } finally { rmSync(f.root, { recursive: true }); }
});

test('iOS packaging rejects a device build, device Mach-O or unknown signing state without publishing', () => {
  const f = fixture('ios'); try {
    const original = readFileSync(f.buildReceipt), receipt = JSON.parse(original);
    receipt.steps.at(-1).argv = ['build', 'ios', '--release'];
    f.write(f.buildReceipt, JSON.stringify(receipt));
    assert.throws(() => validateInputs(f), /Simulator/);
    f.write(f.buildReceipt, original);
    for (const [name, toolOptions] of [['device', { platform: 'IOS' }], ['signing', { signing: 'unknown' }]]) {
      const out = resolve(f.root, `artifacts/refused-${name}`);
      assert.throws(() => main(packageArgs(f, out), { sourceRoot: f.root, host: 'darwin', runner: appleTools(toolOptions).runner }), /Simulator|signing/);
      assert.equal(existsSync(out), false);
    }
  } finally { rmSync(f.root, { recursive: true }); }
});

test('packaging revalidates source and native input ownership after external tools finish', () => {
  const f = fixture('ios'); try {
    for (const [name, path] of [['source', resolve(f.root, 'apps/dev-player/lib/main.dart')], ['native', resolve(f.runtimeDir, 'RUNTIME-LICENSE')], ['output', resolve(f.input, 'Player')]]) {
      const original = readFileSync(path), tools = appleTools(), out = resolve(f.root, `artifacts/raced-${name}`);
      assert.throws(() => main(packageArgs(f, out), { sourceRoot: f.root, host: 'darwin', runner(command, argv, options) {
        const result = tools.runner(command, argv, options);
        if (command.endsWith('/ditto')) writeFileSync(path, 'changed while packaging');
        return result;
      } }), /Stale/);
      assert.equal(existsSync(out), false);
      writeFileSync(path, original);
    }
  } finally { rmSync(f.root, { recursive: true }); }
});
