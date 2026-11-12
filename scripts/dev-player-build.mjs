#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_RELEASE_VERSION, assertSdkProducer } from './lib/sdk-current-release.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkVersion = SDK_RELEASE_VERSION;
const ndkVersionPattern = /^[1-9]\d*\.(?:0|[1-9]\d*)\.[1-9]\d*$/;
const validNdkVersion = value => typeof value === 'string' && value.length <= 64 && value.trim() === value && ndkVersionPattern.test(value);
const ndkPropertyPrefix = '--android-project-arg=weappContainerNdkVersion=';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const portable = path => path.split(sep).join('/');
const contains = (base, path) => { const name = relative(base, path); return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name); };
const generated = [
  'macos/Flutter/GeneratedPluginRegistrant.swift', 'macos/Podfile.lock',
  'ios/Runner/GeneratedPluginRegistrant.h', 'ios/Runner/GeneratedPluginRegistrant.m', 'ios/Podfile.lock',
  'windows/flutter/generated_plugin_registrant.cc', 'windows/flutter/generated_plugin_registrant.h', 'windows/flutter/generated_plugins.cmake',
  'linux/flutter/generated_plugin_registrant.cc', 'linux/flutter/generated_plugin_registrant.h', 'linux/flutter/generated_plugins.cmake',
  'android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java',
].map(path => `apps/dev-player/${path}`);
const sourceScopes = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates', 'scripts', 'package.json', 'pnpm-lock.yaml', '.gitmodules'];
const sdks = ['contract', 'android', 'ios', 'desktop', 'flutter'];

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`Cannot identify source repository: ${root}`);
  return result.stdout;
}
function fileIdentity(base, name) {
  const path = resolve(base, name), stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path);
    if (isAbsolute(target) || !contains(realpathSync(base), realpathSync(path))) throw Error(`Nonportable source/input symlink: ${name}`);
    return { path: portable(name), kind: 'symlink', target, sha256: hash(`symlink:${target}`) };
  }
  if (!stat.isFile()) throw Error(`Source/input is not a regular file: ${name}`);
  return { path: portable(name), kind: 'file', size: stat.size, executable: Boolean(stat.mode & 0o111), sha256: hash(readFileSync(path)) };
}
function treeIdentity(base) {
  const files = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else files.push(fileIdentity(base, relative(base, path)));
    }
  }
  walk(base);
  return { files, sha256: digest(files) };
}
export const captureOutputDirectory = directory => treeIdentity(resolve(directory));
function component(root, name, scopes, excluded = []) {
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== realpathSync(root)) throw Error(`Expected an independent source repository: ${name}`);
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('A concrete source commit is required');
  const paths = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scopes]).split('\0').filter(Boolean))].sort();
  const files = paths.filter(path => !excluded.includes(portable(path))).map(path => fileIdentity(root, path));
  if (!files.length) throw Error(`Empty source identity: ${name}`);
  const identity = { name, commit, scopes, files };
  return { ...identity, dirty: Boolean(git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...scopes]).trim()), sha256: digest(identity) };
}
export function captureSources(root, platform) {
  const components = [component(root, 'core', sourceScopes), component(root, 'player', ['apps/dev-player'], generated)];
  for (const sdk of sdks) components.push(component(resolve(root, 'sdk', sdk), `sdk/${sdk}`, ['.']));
  const generatedFiles = generated.filter(path => existsSync(resolve(root, path))).map(path => fileIdentity(root, path));
  const nativeDirectories = platform === 'android' ? ['sdk/flutter/weapp_container_android/native']
    : platform === 'ios' ? ['sdk/flutter/weapp_container_ios/ios/vendor']
      : [`sdk/flutter/weapp_container_${platform}/${platform}/vendor`, `sdk/flutter/weapp_container_${platform}/${platform}/native_shared`];
  const nativeInputs = nativeDirectories.filter(path => existsSync(resolve(root, path))).map(path => ({ path, ...treeIdentity(resolve(root, path)) }));
  return { components, authoredSha256: digest(components.map(({ name, sha256 }) => ({ name, sha256 }))), generatedFiles,
    generatedSha256: digest(generatedFiles), nativeInputs, nativeSha256: digest(nativeInputs) };
}
export function compareSources(before, after, phase) {
  const changes = [];
  if (before.authoredSha256 !== after.authoredSha256) changes.push({ kind: 'authored-source-change', allowed: false });
  const previous = new Map(before.generatedFiles.map(file => [file.path, file]));
  const next = new Map(after.generatedFiles.map(file => [file.path, file]));
  for (const path of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    if (digest(previous.get(path) ?? null) !== digest(next.get(path) ?? null)) changes.push({ path, kind: 'generated-build-input', allowed: phase !== 'prepare', before: previous.get(path) ?? null, after: next.get(path) ?? null });
  }
  if (before.nativeSha256 !== after.nativeSha256) changes.push({ kind: 'prepared-native-input', allowed: phase === 'prepare' });
  return { phase, status: changes.some(change => !change.allowed) ? 'failed' : 'bound', changes };
}
function assertSnapshot(snapshot) {
  if (!snapshot?.components?.length || !/^[a-f0-9]{64}$/.test(snapshot.authoredSha256 ?? '')) throw Error('Missing hashed source identity');
  for (const value of snapshot.components) {
    if (!/^[a-f0-9]{40}$/.test(value.commit ?? '') || !value.files?.length || value.files.some(file => !/^[a-f0-9]{64}$/.test(file.sha256 ?? ''))) throw Error('Invalid component source identity');
    const { name, commit, scopes, files } = value;
    if (digest({ name, commit, scopes, files }) !== value.sha256) throw Error('Source inventory hash mismatch');
  }
  if (digest(snapshot.components.map(({ name, sha256 }) => ({ name, sha256 }))) !== snapshot.authoredSha256 || digest(snapshot.generatedFiles) !== snapshot.generatedSha256 || digest(snapshot.nativeInputs) !== snapshot.nativeSha256) throw Error('Source snapshot hash mismatch');
  if (digest(snapshot.components.map(value => value.name)) !== digest(['core', 'player', ...sdks.map(sdk => `sdk/${sdk}`)])) throw Error('Incomplete component source identity');
  for (const file of snapshot.generatedFiles) if (!generated.includes(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw Error('Unknown generated build input');
  for (const input of snapshot.nativeInputs) {
    if (!input.files?.length || input.files.some(file => !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) || digest(input.files) !== input.sha256) throw Error('Incomplete prepared binary identity');
  }
}
export function verifyBuildReceipt(receipt, current, output) {
  const binding = receipt.sourceBinding;
  if (receipt.schemaVersion !== 2 || receipt.sdkVersion !== sdkVersion || receipt.status !== 'built' || binding?.version !== '1.0' || binding.status !== 'bound' || binding.snapshots?.length !== 4 || binding.transitions?.length !== 3) throw Error(`A completed source-bound ${SDK_RELEASE_VERSION} build is required`);
  if (digest(binding.generatedPolicy) !== digest(generated) || receipt.steps?.length !== 3 || receipt.steps.some(step => step.exitCode !== 0 || step.signal || step.spawnError)) throw Error('Incomplete successful build steps or unknown source policy');
  if (receipt.platform === 'android') {
    const override = receipt.androidNdkOverride;
    const supplied = receipt.steps.at(-1).argv.filter(value => value.startsWith(ndkPropertyPrefix));
    if (override !== null && !validNdkVersion(override)) throw Error('Missing or invalid Android NDK selection');
    if (digest(supplied) !== digest(override === null ? [] : [`${ndkPropertyPrefix}${override}`])) throw Error('Android NDK selection does not match the build command');
  }
  const names = ['initial', 'prepared', 'dependencies', 'built'];
  for (let i = 0; i < names.length; i++) {
    if (binding.snapshots[i].phase !== names[i]) throw Error('Incomplete source stage sequence');
    assertSnapshot(binding.snapshots[i].source);
    if (i) {
      const phase = ['prepare', 'dependencies', 'build'][i - 1];
      const expected = compareSources(binding.snapshots[i - 1].source, binding.snapshots[i].source, phase);
      if (expected.status !== 'bound' || digest(expected) !== digest(binding.transitions[i - 1])) throw Error('Unexpected source changes during build');
    }
  }
  const final = binding.snapshots.at(-1).source;
  if (!final.nativeInputs.length) throw Error('Prepared native inputs are missing');
  if (!current) throw Error('Current hashed source identity is required');
  assertSnapshot(current);
  if (current.authoredSha256 !== final.authoredSha256 || current.generatedSha256 !== final.generatedSha256 || current.nativeSha256 !== final.nativeSha256) throw Error('Stale build receipt: current source/native inputs differ');
  if (!receipt.artifacts?.files?.length || receipt.artifacts.files.some(file => !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) || receipt.artifacts.sha256 !== digest(receipt.artifacts.files)) throw Error('Missing artifact hash inventory');
  if (!output?.files?.length || digest(output.files) !== output.sha256) throw Error('Current hashed application output identity is required');
  if (output.sha256 !== receipt.artifacts.sha256) throw Error('Stale build receipt: application output differs');
  return true;
}
function findOutput(root, platform, simulator) {
  const app = resolve(root, 'apps/dev-player/build');
  if (platform === 'android') return resolve(app, 'app/outputs/flutter-apk');
  if (platform === 'windows') return resolve(app, 'windows/x64/runner/Release');
  if (platform === 'linux') return resolve(app, 'linux/x64/release/bundle');
  const directory = platform === 'macos' ? resolve(app, 'macos/Build/Products/Release') : resolve(app, simulator ? 'ios/iphonesimulator' : 'ios/iphoneos');
  const candidates = readdirSync(directory).filter(name => name.endsWith('.app'));
  if (candidates.length !== 1) throw Error('Build output must contain exactly one application bundle');
  return resolve(directory, candidates[0]);
}

export function runBuild(args, { root = repository, runner = spawnSync, host = process.platform } = {}) {
  const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} requires a value`); return args[i + 1]; };
  if (args.includes('--help')) { process.stdout.write(`Build private ${SDK_RELEASE_VERSION} Dev Player: --platform android|ios|macos|windows|linux [--flutter executable] [--out directory] [--desktop-sdk verified-directory] [--arch exact-arch] [--manifest file] [--artifact-dir directory] [--simulator] [--android-ndk-version major.minor.build]\nAndroid uses the pinned Flutter NDK unless an explicit version is selected; no automatic fallback.\nSource-bound compilation only; no signing policy changes or installation/GPU acceptance.\n`); return; }
  const platform = option('--platform', host === 'darwin' ? 'macos' : host === 'win32' ? 'windows' : 'linux');
  const hosts = { macos: 'darwin', ios: 'darwin', windows: 'win32', linux: 'linux', android: host };
  if (!Object.hasOwn(hosts, platform) || hosts[platform] !== host) throw Error('Build on the target platform; Apple builds require macOS');
  const androidNdkOverride = option('--android-ndk-version');
  if (androidNdkOverride !== undefined) {
    if (platform !== 'android') throw Error('--android-ndk-version is only valid for Android');
    if (!validNdkVersion(androidNdkOverride)) throw Error('--android-ndk-version requires an exact major.minor.build version');
  }
  const flutter = option('--flutter', process.env.FLUTTER_BIN ?? 'flutter');
  const out = resolve(root, option('--out', 'artifacts/dev-player'), platform); mkdirSync(out, { recursive: true });
  const path = resolve(out, 'build.json');
  if (existsSync(path)) {
    const bytes = readFileSync(path), history = resolve(out, 'history'); mkdirSync(history, { recursive: true });
    const archived = resolve(history, `build-${hash(bytes)}.json`);
    if (!existsSync(archived)) copyFileSync(path, archived);
    else if (hash(readFileSync(archived)) !== hash(bytes)) throw Error('Historical build receipt hash mismatch; preserving current receipt');
  }
  const receipt = { schemaVersion: 2, sdkVersion, platform, status: 'building', execution: 'not-run', signing: 'not-verified', startedAt: new Date().toISOString(), steps: [], sourceBinding: { version: '1.0', status: 'collecting', scope: 'Workspace sources and exact prepared binaries; original native producer provenance remains in hashed prepared receipts.', generatedPolicy: generated, snapshots: [], transitions: [] } };
  if (platform === 'android') receipt.androidNdkOverride = androidNdkOverride ?? null;
  function write() { const temporary = `${path}.tmp-${process.pid}`; writeFileSync(temporary, JSON.stringify(receipt, null, 2) + '\n'); renameSync(temporary, path); }
  function snapshot(phase) { const source = captureSources(root, platform); receipt.sourceBinding.snapshots.push({ phase, source }); write(); return source; }
  function run(command, argv, cwd = root) {
    const step = { command, argv, startedAt: new Date().toISOString() }; receipt.steps.push(step); write();
    const result = runner(command, argv, { cwd, stdio: 'inherit' });
    step.exitCode = result.status; step.signal = result.signal ?? null; step.finishedAt = new Date().toISOString();
    if (result.error) step.spawnError = result.error.code ?? 'SPAWN_FAILED';
    write();
    if (result.error || result.status !== 0) throw Error('Dev Player build step failed; inspect the build receipt');
  }
  function transition(before, after, phase) { const result = compareSources(before, after, phase); receipt.sourceBinding.transitions.push(result); write(); if (result.status !== 'bound') throw Error('Source or prepared native inputs changed unexpectedly during build'); }
  write();
  try {
    const initial = snapshot('initial');
    const desktop = option('--desktop-sdk');
    if (desktop) {
      if (!['macos', 'windows', 'linux'].includes(platform)) throw Error('--desktop-sdk is only valid for desktop');
      const packageReceipt = JSON.parse(readFileSync(resolve(root, desktop, 'package.json'), 'utf8'));
      assertSdkProducer(packageReceipt, 'verified', platform);
      run(process.execPath, ['sdk/flutter/native_desktop/prepare.mjs', '--target', platform, '--from', resolve(root, desktop)]);
    } else {
      const arch = option('--arch', ['android', 'ios', 'macos'].includes(platform) ? 'universal' : 'x86_64');
      const prepare = ['sdk/flutter/tools/prepare-native.mjs', '--platform', platform, '--arch', arch];
      for (const name of ['--manifest', '--artifact-dir']) if (option(name)) prepare.push(name, resolve(root, option(name)));
      run(process.execPath, prepare);
    }
    const prepared = snapshot('prepared'); transition(initial, prepared, 'prepare');
    if (!prepared.nativeInputs.length || prepared.nativeInputs.some(input => !input.files.length)) throw Error('Prepared native runtime input inventory is missing');
    if (['android', 'ios'].includes(platform)) {
      const directory = resolve(root, platform === 'android' ? 'sdk/flutter/weapp_container_android/native' : 'sdk/flutter/weapp_container_ios/ios/vendor/WeappContainer');
      const installed = JSON.parse(readFileSync(resolve(directory, '.runtime-install.json'), 'utf8'));
      if (installed.schemaVersion !== 1 || installed.identity?.runtimeVersion !== sdkVersion || installed.identity?.abiVersion !== 1
        || installed.identity?.platform !== platform || installed.identity?.component !== `${platform}-sdk`
        || !/^[a-f0-9]{64}$/.test(installed.archiveSha256 ?? '')) throw Error(`A matching ${SDK_RELEASE_VERSION} prepared mobile SDK installation is required`);
      assertSdkProducer(JSON.parse(readFileSync(resolve(directory, platform === 'android' ? 'distribution.json' : 'build.json'), 'utf8')), platform === 'android' ? 'passed' : 'built', platform);
    } else {
      const prepared = JSON.parse(readFileSync(resolve(root, `sdk/flutter/weapp_container_${platform}/${platform}/vendor/prepared.json`), 'utf8'));
      if (prepared.schemaVersion !== 1 || prepared.sdkVersion !== sdkVersion || prepared.target !== platform || prepared.sourceDirty !== false) throw Error(`A matching ${SDK_RELEASE_VERSION} prepared desktop SDK installation is required`);
      assertSdkProducer(prepared.packageReceipt, 'verified', platform);
    }
    run(flutter, ['pub', 'get', '--enforce-lockfile'], resolve(root, 'apps/dev-player'));
    const dependencies = snapshot('dependencies'); transition(prepared, dependencies, 'dependencies');
    const build = platform === 'android' ? ['build', 'apk', '--release', '--target-platform', 'android-arm64,android-x64', ...(androidNdkOverride ? [`${ndkPropertyPrefix}${androidNdkOverride}`] : [])]
      : platform === 'ios' ? ['build', 'ios', ...(args.includes('--simulator') ? ['--simulator', '--debug'] : ['--release'])]
        : ['build', platform, '--release'];
    run(flutter, build, resolve(root, 'apps/dev-player'));
    const built = snapshot('built'); transition(dependencies, built, 'build');
    const output = findOutput(root, platform, args.includes('--simulator'));
    receipt.artifacts = { path: portable(relative(root, output)), ...treeIdentity(output) };
    if (!receipt.artifacts.files.length) throw Error('Build produced no application files');
    receipt.sourceBinding.status = 'bound'; receipt.status = 'built';
    receipt.limits = 'Source/binary-bound compilation only; installation, native GPU presentation, signing, physical device and performance require independent evidence.';
    verifyBuildReceipt(receipt, built, receipt.artifacts);
  } catch (error) {
    receipt.status = 'failed'; receipt.error = error.message; receipt.sourceBinding.status = 'failed';
    try { receipt.sourceBinding.failedFinal = captureSources(root, platform); } catch (captureError) { receipt.sourceBinding.finalCaptureError = captureError.message; }
  }
  receipt.finishedAt = new Date().toISOString(); write();
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const receipt = runBuild(process.argv.slice(2)); if (receipt?.status === 'failed') { process.stderr.write(`${receipt.error}\n`); process.exitCode = 1; } }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
