#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_RELEASE_VERSION, assertSdkProducer } from './lib/sdk-current-release.mjs';
import { inflateRawSync } from 'node:zlib';
import { captureOutputDirectory, captureSources, verifyBuildReceipt } from './dev-player-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = SDK_RELEASE_VERSION;
const linuxExecutable = 'weapp_container_dev_player';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (base, path) => { const part = relative(base, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const mobile = platform => ['android', 'ios'].includes(platform);
const flutterHeaders = new Set('Flutter FlutterAppDelegate FlutterBinaryMessenger FlutterCallbackCache FlutterChannels FlutterCodecs FlutterDartProject FlutterEngine FlutterEngineGroup FlutterHeadlessDartRunner FlutterHourFormat FlutterMacros FlutterPlatformViews FlutterPlugin FlutterPluginAppLifeCycleDelegate FlutterSceneDelegate FlutterSceneLifeCycle FlutterTexture FlutterViewController'.split(' ').map(name => `Frameworks/Flutter.framework/Headers/${name}.h`));
const forbiddenPath = file => /(^|\/)(\.git|\.env[^/]*|node_modules|target)(\/|$)|\.(rs|dart|cpp|cc|c|hpp|h|pdb)$/i.test(file);
const credential = bytes => /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(bytes.toString('latin1'));
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
const crc32 = bytes => { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; };
export const linuxLauncher = () => `#!/bin/sh\nset -eu\napp_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\ncd "$app_dir/app"\nexec ./${linuxExecutable} "$@"\n`;
export function inventory(directory, { simulator = false } = {}) {
  const base = realpathSync(directory), files = [];
  function visit(path) {
    const stat = lstatSync(path), file = relative(base, path).split(sep).join('/');
    if (forbiddenPath(file) && !(simulator && flutterHeaders.has(file))) throw Error(`Source, credentials or build cache forbidden: ${file}`);
    if (stat.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(path)) || !inside(base, realpathSync(path))) throw Error(`Nonportable or escaping symlink: ${file}`);
      files.push({ file, kind: 'symlink', target: readlinkSync(path), sha256: sha(`symlink:${readlinkSync(path)}`) });
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(resolve(path, name));
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      if (credential(bytes)) throw Error(`GitHub credential forbidden: ${file}`);
      files.push({ file, kind: 'file', size: bytes.length, executable: Boolean(stat.mode & 0o111), sha256: sha(bytes) });
    } else throw Error(`Unsupported file type: ${file}`);
  }
  for (const name of readdirSync(base).sort()) visit(resolve(base, name));
  return files;
}
/** Inspect entries in the original APK without extracting or rewriting it. */
export function inspectApk(bytes) {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) throw Error('Invalid single-volume APK ZIP');
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), length = bytes.readUInt32LE(end + 12);
  if (!count || count === 65535 || start + length !== end) throw Error('Unsupported APK ZIP64 or directory bounds');
  const entries = new Map(); let offset = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw Error('Invalid APK directory entry');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || size > 256 * 1024 ** 2 || (total += size) > 2 * 1024 ** 3) throw Error('APK entry bounds, encryption or compression unsupported');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength), name = nameBytes.toString('utf8');
    if (!name || !Buffer.from(name).equals(nameBytes) || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..') || entries.has(name) || forbiddenPath(name) || (bytes.readUInt32LE(offset + 38) >>> 16 & 0xf000) === 0xa000) throw Error('Unsafe, duplicate or source-bearing APK entry');
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method) throw Error('Invalid APK local entry');
    const localNameLength = bytes.readUInt16LE(local + 26), data = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (!bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) || data + compressed > start) throw Error('APK entry path or data bounds mismatch');
    const stored = bytes.subarray(data, data + compressed), content = method === 0 ? stored : inflateRawSync(stored, { maxOutputLength: size + 1 });
    if (content.length !== size || crc32(content) !== bytes.readUInt32LE(offset + 16) || credential(content)) throw Error('APK entry size, CRC or credential mismatch');
    entries.set(name, { bytes: content, sha256: sha(content) }); offset = next;
  }
  if (offset !== end || !entries.has('AndroidManifest.xml') || !entries.has('classes.dex') || entries.has('assets/flutter_assets/kernel_blob.bin')) throw Error('A release Android application APK is required');
  for (const file of ['LICENSE', 'RUNTIME-LICENSE', 'licenses/aarch64-linux-android/licenses.json', 'licenses/x86_64-linux-android/licenses.json']) if (!entries.has(`assets/weapp-container/${file}`)) throw Error('APK must carry runtime, SDK and both Android native license inventories');
  const architectures = ['arm64-v8a', 'x86_64'];
  for (const [arch, machine] of [['arm64-v8a', 183], ['x86_64', 62]]) {
    for (const library of ['libweapp_container_sdk.so', 'libflutter.so', 'libapp.so']) {
      const elf = entries.get(`lib/${arch}/${library}`)?.bytes;
      if (!elf || elf.length < 20 || elf.toString('binary', 0, 4) !== '\x7fELF' || elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== machine) throw Error(`APK requires actual ${arch} ${library}`);
    }
  }
  if ([...entries.keys()].some(name => name.startsWith('lib/') && !architectures.includes(name.split('/')[1]))) throw Error('Unexpected APK native architecture');
  return { architectures, entries: [...entries].map(([file, value]) => ({ file, size: value.bytes.length, sha256: value.sha256 })) };
}
export function validateInputs({ platform, input, buildReceipt, runtimeDir, sourceRoot = root }) {
  if (!['macos', 'windows', 'linux', 'android', 'ios'].includes(platform)) throw Error('Unsupported Player platform');
  const build = JSON.parse(readFileSync(buildReceipt, 'utf8'));
  if (build.status !== 'built' || build.sdkVersion !== version || build.platform !== platform) throw Error(`A matching successful ${SDK_RELEASE_VERSION} Player build receipt is required`);
  if (!build.artifacts?.path || isAbsolute(build.artifacts.path) || !inside(resolve(sourceRoot), resolve(sourceRoot, build.artifacts.path)) || realpathSync(resolve(sourceRoot, build.artifacts.path)) !== realpathSync(input)) throw Error('--input must be the exact application output bound by the build receipt');
  verifyBuildReceipt(build, captureSources(sourceRoot, platform), captureOutputDirectory(input));
  if (mobile(platform)) {
    const native = platform === 'android' ? 'sdk/flutter/weapp_container_android/native' : 'sdk/flutter/weapp_container_ios/ios/vendor/WeappContainer';
    if (realpathSync(runtimeDir) !== realpathSync(resolve(sourceRoot, native))) throw Error('Mobile runtime must be the exact prepared native input bound by the build receipt');
    const install = JSON.parse(readFileSync(resolve(runtimeDir, '.runtime-install.json'), 'utf8'));
    if (install.schemaVersion !== 1 || install.identity?.runtimeVersion !== version || install.identity?.abiVersion !== 1 || install.identity?.platform !== platform || install.identity?.component !== `${platform}-sdk` || !/^[a-f0-9]{64}$/.test(install.archiveSha256 ?? '')) throw Error(`A matching ${SDK_RELEASE_VERSION} prepared mobile SDK installation receipt is required`);
    const producerPath = resolve(runtimeDir, platform === 'android' ? 'distribution.json' : 'build.json');
    const producer = JSON.parse(readFileSync(producerPath, 'utf8'));
    const targets = platform === 'android' ? ['aarch64-linux-android', 'x86_64-linux-android'] : ['aarch64-apple-ios-sim', 'x86_64-apple-ios'];
    assertSdkProducer(producer, platform === 'android' ? 'passed' : 'built', platform);
    if (!targets.every(target => producer.native.some(value => value.target === target))) throw Error('Matching QuickJS and native GPU mobile producer evidence is required');
    const noticeSources = ['RUNTIME-LICENSE', 'SDK-CONTRACT-LICENSE', 'SDK-CONTRACT-NOTICE.json', 'licenses'].map(file => ({ from: resolve(runtimeDir, file), file }));
    noticeSources.push({ from: resolve(sourceRoot, `sdk/${platform}/LICENSE`), file: 'SDK-WRAPPER-LICENSE' });
    const noticesInventory = noticeSources.flatMap(({ from, file }) => {
      if (lstatSync(from).isSymbolicLink() || !inside(realpathSync(sourceRoot), realpathSync(from))) throw Error('Mobile notices must be contained regular source-bound inputs');
      if (lstatSync(from).isDirectory()) return inventory(from).map(value => ({ ...value, file: `${file}/${value.file}` }));
      const bytes = readFileSync(from); if (credential(bytes)) throw Error('Credentials are forbidden in notices');
      return [{ file, kind: 'file', size: bytes.length, executable: Boolean(lstatSync(from).mode & 0o111), sha256: sha(bytes) }];
    });
    if (!noticesInventory.some(file => file.file.endsWith('/licenses.json'))) throw Error('Native license inventories are required');
    const files = inventory(input, { simulator: platform === 'ios' });
    const command = build.steps.at(-1).argv;
    let apk;
    if (platform === 'android') {
      if (command[0] !== 'build' || command[1] !== 'apk' || !command.includes('--release') || !files.some(file => file.file === 'app-release.apk') || files.some(file => file.file.endsWith('.apk') && file.file !== 'app-release.apk')) throw Error('An exact single release APK build output is required');
      apk = inspectApk(readFileSync(resolve(input, 'app-release.apk')));
      if (apk.entries.find(file => file.file === 'assets/weapp-container/RUNTIME-LICENSE').sha256 !== sha(readFileSync(resolve(runtimeDir, 'RUNTIME-LICENSE')))) throw Error('APK runtime license differs from the prepared runtime');
    } else if (command[0] !== 'build' || command[1] !== 'ios' || !command.includes('--simulator') || !command.includes('--debug') || !input.endsWith('.app') || !existsSync(resolve(input, 'Info.plist')) || !files.some(file => file.file.startsWith('Frameworks/Flutter.framework/'))) throw Error('Only an exact iOS Simulator .app build is supported; device IPA is not produced');
    return { files, noticeSources, noticesInventory, apk, buildReceiptSha256: sha(readFileSync(buildReceipt)), runtimeReceiptSha256: sha(readFileSync(producerPath)), nativeArchiveSha256: install.archiveSha256 };
  }
  const runtime = JSON.parse(readFileSync(resolve(runtimeDir, 'package.json'), 'utf8'));
  assertSdkProducer(runtime, 'verified', platform);
  if (!runtime.artifacts?.length || !runtime.platform?.startsWith(platform)) throw Error(`A matching verified ${SDK_RELEASE_VERSION} desktop runtime distribution is required`);
  for (const artifact of runtime.artifacts) {
    if (typeof artifact.file !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw Error('Malformed runtime artifact');
    const path = resolve(runtimeDir, artifact.file);
    if (!inside(resolve(runtimeDir), path) || !inside(realpathSync(runtimeDir), realpathSync(path)) || !lstatSync(path).isFile() || sha(readFileSync(path)) !== artifact.sha256) throw Error('Runtime artifact hash/path mismatch');
  }
  const notices = resolve(runtimeDir, 'share/weapp-container');
  if (!existsSync(resolve(notices, 'RUNTIME-LICENSE')) || !existsSync(resolve(notices, 'licenses/native'))) throw Error('Runtime license and native third-party notices are required');
  const noticesInventory = inventory(notices);
  if (!noticesInventory.some(file => file.file.endsWith('/licenses.json'))) throw Error('Native license inventories are required');
  const files = inventory(input);
  if (platform === 'macos' && (!input.endsWith('.app') || !existsSync(resolve(input, 'Contents/Info.plist')) || !files.some(f => f.file.startsWith('Contents/MacOS/')))) throw Error('--input must be the exact built .app directory');
  if (platform === 'windows' && (!files.some(f => /^[^/]+\.exe$/i.test(f.file)) || !existsSync(resolve(input, 'flutter_windows.dll')))) throw Error('Windows Flutter executable/runtime output is missing');
  if (platform === 'linux' && (!existsSync(resolve(input, 'lib/libflutter_linux_gtk.so')) || !existsSync(resolve(input, linuxExecutable)))) throw Error('Linux Flutter executable/runtime output is missing');
  if (platform !== 'macos' && !existsSync(resolve(input, 'data/flutter_assets'))) throw Error('Flutter assets are missing');
  return { files, notices, noticesInventory, buildReceiptSha256: sha(readFileSync(buildReceipt)), runtimeReceiptSha256: sha(readFileSync(resolve(runtimeDir, 'package.json'))) };
}
const help = `Private Dev Player packaging (no installation/GPU/signing acceptance implied)
  node scripts/dev-player-package.mjs --platform macos|windows|linux|android|ios
    --input <exact Flutter output .app/bundle/flutter-apk directory> --out <new artifacts/ directory>
    --build-receipt <successful build.json> --runtime-dir <verified ${SDK_RELEASE_VERSION} desktop SDK or exact prepared mobile native directory>
  Android preserves app-release.apk byte-for-byte; signature and production identity remain not verified.
  iOS accepts only --simulator --debug builds, produces a simulator .app ZIP and never a device IPA.
  Linux additionally requires --appimagetool <absolute executable> --appimagetool-sha256 <sha256>.
  Run on the target OS. Linux packaging requires actual Ubuntu 22.04 x64.
  macOS accepts existing ad-hoc development signatures and records verification; it never disables OS security.
`;
export function main(args, { sourceRoot = root, host = process.platform, runner = spawnSync } = {}) {
  if (args.includes('--help')) { process.stdout.write(help); return; }
  const allowed = new Set(['--platform', '--input', '--out', '--build-receipt', '--runtime-dir', '--appimagetool', '--appimagetool-sha256']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || options[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Unknown, duplicate or missing option; use --help');
    options[args[i]] = args[i + 1];
  }
  for (const key of ['--platform', '--input', '--out', '--build-receipt', '--runtime-dir']) if (!options[key]) throw Error(`${key} is required`);
  const platform = options['--platform'];
  if ({ macos: 'darwin', ios: 'darwin', windows: 'win32', linux: 'linux', android: host }[platform] !== host) throw Error('Packaging requires the target host OS');
  const input = resolve(options['--input']), out = resolve(options['--out']);
  const artifactRoot = resolve(sourceRoot, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  if (!inside(artifactRoot, out) || out === artifactRoot || existsSync(out) || inside(input, out)) throw Error('--out must be a new private directory under repository artifacts/ outside input');
  mkdirSync(dirname(out), { recursive: true });
  if (!inside(realpathSync(artifactRoot), realpathSync(dirname(out)))) throw Error('Output parent escapes artifacts/');
  const checked = validateInputs({ platform, input, buildReceipt: resolve(options['--build-receipt']), runtimeDir: resolve(options['--runtime-dir']), sourceRoot });
  function run(command, argv, extra = {}) {
    const result = runner(command, argv, { encoding: 'utf8', ...extra });
    if (result.error || result.status !== 0) throw Error(`Packaging tool failed: ${command} (${result.status ?? 'spawn error'})`);
    return result;
  }
  let architectures;
  if (platform === 'macos' || platform === 'ios') {
    const plist = resolve(input, platform === 'macos' ? 'Contents/Info.plist' : 'Info.plist');
    const executable = run('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]).stdout.trim();
    if (!executable || basename(executable) !== executable) throw Error('Invalid Apple bundle executable');
    const binary = platform === 'macos' ? resolve(input, 'Contents/MacOS', executable) : resolve(input, executable);
    architectures = run('/usr/bin/lipo', ['-archs', binary]).stdout.trim().split(/\s+/).sort();
    if (platform === 'macos' && (!architectures.includes('arm64') || !architectures.includes('x86_64'))) throw Error('macOS Player must be an actual universal arm64/x86_64 app');
    if (platform === 'ios') {
      const platforms = [...run('/usr/bin/xcrun', ['vtool', '-show-build', binary]).stdout.matchAll(/\bplatform\s+(\S+)/g)].map(match => match[1]);
      if (!architectures.length || architectures.some(arch => !['arm64', 'x86_64'].includes(arch)) || !platforms.length || platforms.some(value => value !== 'IOSSIMULATOR') || run('/usr/bin/plutil', ['-extract', 'DTPlatformName', 'raw', '-o', '-', plist]).stdout.trim() !== 'iphonesimulator') throw Error('Actual iOS Simulator binary and bundle metadata are required; no device IPA is produced');
    }
  } else if (platform === 'android') {
    architectures = checked.apk.architectures;
  } else if (platform === 'windows') {
    const executable = checked.files.find(file => /^[^/]+\.exe$/i.test(file.file));
    const bytes = readFileSync(resolve(input, executable.file));
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw Error('Invalid Windows executable');
    const offset = bytes.readUInt32LE(60);
    if (offset + 6 > bytes.length || bytes.toString('binary', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664) throw Error('Windows Player must be an actual x64 executable');
    architectures = ['x86_64'];
  } else {
    const bytes = readFileSync(resolve(input, linuxExecutable));
    if (bytes.length < 20 || bytes.toString('binary', 0, 4) !== '\x7fELF' || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw Error('Linux Player must be an actual x86_64 ELF executable');
    architectures = ['x86_64'];
  }
  let tool;
  if (platform === 'linux') {
    const os = readFileSync('/etc/os-release', 'utf8');
    if (!/^ID=\"?ubuntu\"?$/m.test(os) || !/^VERSION_ID=\"?22\.04\"?$/m.test(os) || process.arch !== 'x64') throw Error('Actual Ubuntu 22.04 x64 packaging host required; no baseline inferred from compilation');
    tool = options['--appimagetool'];
    if (!tool || !isAbsolute(tool) || !/^[a-f0-9]{64}$/.test(options['--appimagetool-sha256'] ?? '') || sha(readFileSync(tool)) !== options['--appimagetool-sha256']) throw Error('Explicit appimagetool executable and matching SHA-256 are required');
  }
  const staging = mkdtempSync(resolve(dirname(out), '.player-package-'));
  try {
    const receipt = { schemaVersion: 1, sdkVersion: version, platform, architectures, status: 'packaged', privacy: 'private', acceptance: { installation: 'not-run', gpu: 'not-run', physicalDevice: 'not-run', performance: 'not-run' }, source: { packagerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), buildReceiptSha256: checked.buildReceiptSha256, runtimeReceiptSha256: checked.runtimeReceiptSha256, ...(checked.nativeArchiveSha256 ? { nativeArchiveSha256: checked.nativeArchiveSha256 } : {}) }, input: checked.files, notices: checked.noticesInventory };
    const payload = resolve(staging, 'payload'); mkdirSync(payload);
    const target = resolve(payload, ['macos', 'ios'].includes(platform) ? basename(input) : platform === 'android' ? 'WeappContainerDevPlayer-android.apk' : 'WeappContainerDevPlayer');
    cpSync(platform === 'android' ? resolve(input, 'app-release.apk') : input, target, { recursive: true, dereference: false });
    const notices = ['macos', 'ios', 'android'].includes(platform) ? resolve(payload, 'WeappContainerNotices') : resolve(target, 'WeappContainerNotices');
    if (checked.noticeSources) {
      mkdirSync(notices);
      for (const { from, file } of checked.noticeSources) cpSync(from, resolve(notices, file), { recursive: true });
    } else cpSync(checked.notices, notices, { recursive: true });
    const ordered = files => [...files].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    if (JSON.stringify(ordered(inventory(notices))) !== JSON.stringify(ordered(checked.noticesInventory))) throw Error('Copied notice bytes differ from their validated inputs');
    if (platform === 'android' ? sha(readFileSync(target)) !== checked.files.find(file => file.file === 'app-release.apk').sha256 : JSON.stringify(inventory(target, { simulator: platform === 'ios' })) !== JSON.stringify(checked.files)) throw Error('Copied application bytes differ from their validated inputs');
    let archive;
    if (platform === 'macos') {
      // Preserve the supplied identity and entitlements. Notices stay beside
      // the app, outside its resource seal. Never alter Gatekeeper policy.
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
      const details = run('/usr/bin/codesign', ['-d', '--verbose=4', target]);
      receipt.signing = { kind: /Signature=adhoc/.test(details.stderr) ? 'ad-hoc-development' : 'existing-signature', verified: true, notarization: 'not-run' };
      archive = resolve(staging, 'WeappContainerDevPlayer-macos.zip');
      run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', payload, archive]);
    } else if (platform === 'ios') {
      const details = runner('/usr/bin/codesign', ['-d', '--verbose=4', target], { encoding: 'utf8' });
      if (details.error) throw Error('Could not inspect iOS Simulator signing state');
      if (details.status === 0) {
        run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
        receipt.signing = { kind: /Signature=adhoc/.test(details.stderr) ? 'ad-hoc-development' : 'existing-signature', verified: true, deviceProvisioning: 'not-verified', productionIdentity: 'not-verified' };
      } else if (/code object is not signed at all/.test(details.stderr ?? '')) receipt.signing = { kind: 'unsigned', verified: false, deviceProvisioning: 'not-applicable', productionIdentity: 'not-verified' };
      else throw Error('Unknown iOS Simulator signing state');
      receipt.distributionTarget = 'ios-simulator';
      receipt.deviceInstallEligible = false;
      receipt.debugKernel = checked.files.some(file => file.file.endsWith('/kernel_blob.bin'));
      receipt.qualification = 'Private simulator-only debug application; debug assets may contain Dart kernel data. No device IPA, provisioning, App Store distribution or device acceptance is produced.';
      archive = resolve(staging, 'WeappContainerDevPlayer-ios-simulator.zip');
      run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', payload, archive]);
    } else if (platform === 'android') {
      archive = resolve(staging, basename(target));
      renameSync(target, archive);
      renameSync(notices, resolve(staging, 'WeappContainerNotices'));
      receipt.signing = { kind: 'not-verified', verified: false, productionIdentity: 'not-verified', qualification: 'Original APK bytes are preserved; no signing or re-signing is performed. Build configuration alone is not signature verification.' };
      receipt.apkEntries = checked.apk.entries;
      receipt.qualification = 'Private release APK plus adjacent runtime and SDK notices. Packaging does not prove installation, signature, device, GPU or performance acceptance.';
    } else if (platform === 'windows') {
      archive = resolve(staging, 'WeappContainerDevPlayer-windows-x64.zip');
      // Paths are environment values, never PowerShell source interpolation.
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:WEAPP_PLAYER_PACKAGE_INPUT -DestinationPath $env:WEAPP_PLAYER_PACKAGE_OUTPUT -CompressionLevel Optimal -ErrorAction Stop'], { env: { ...process.env, WEAPP_PLAYER_PACKAGE_INPUT: target, WEAPP_PLAYER_PACKAGE_OUTPUT: archive } });
      receipt.signing = { kind: 'not-verified', authenticode: 'not-run' };
    } else {
      const appDir = resolve(staging, 'WeappContainerDevPlayer.AppDir'); mkdirSync(appDir);
      renameSync(target, resolve(appDir, 'app'));
      cpSync(resolve(root, 'apps/dev-player/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_256.png'), resolve(appDir, 'weapp-dev-player.png'));
      writeFileSync(resolve(appDir, 'weapp-dev-player.desktop'), '[Desktop Entry]\nType=Application\nName=Weapp Container Dev Player\nExec=AppRun\nIcon=weapp-dev-player\nCategories=Development;\n');
      writeFileSync(resolve(appDir, 'AppRun'), linuxLauncher(), { mode: 0o755 });
      archive = resolve(staging, 'WeappContainerDevPlayer-linux-x64.AppImage');
      run(tool, [appDir, archive], { env: { ...process.env, ARCH: 'x86_64' } });
      receipt.tool = { appimagetoolSha256: options['--appimagetool-sha256'], buildHostBaseline: 'Ubuntu 22.04 x64', x11: 'not-run', wayland: 'not-run' };
    }
    if (!existsSync(archive) || !lstatSync(archive).size) throw Error('Packaging tool produced no archive');
    // The supplied build receipt and all bound inputs must still identify the
    // same sources and output after packaging tools finish. No rebinding occurs.
    const buildBytes = readFileSync(resolve(options['--build-receipt']));
    if (sha(buildBytes) !== checked.buildReceiptSha256) throw Error('Build receipt changed during packaging');
    verifyBuildReceipt(JSON.parse(buildBytes), captureSources(sourceRoot, platform), captureOutputDirectory(input));
    receipt.artifact = { file: basename(archive), size: lstatSync(archive).size, sha256: sha(readFileSync(archive)) };
    rmSync(payload, { recursive: true });
    if (existsSync(resolve(staging, 'WeappContainerDevPlayer.AppDir'))) rmSync(resolve(staging, 'WeappContainerDevPlayer.AppDir'), { recursive: true });
    writeFileSync(resolve(staging, 'package.json'), JSON.stringify(receipt, null, 2) + '\n');
    renameSync(staging, out);
    process.stdout.write(`${resolve(out, receipt.artifact.file)}\n`);
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
