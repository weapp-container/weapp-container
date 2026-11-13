#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { verifySkiaInput } from './lib/sdk-skia-input.mjs';
import { parseNativeBuildArgs, nativeBuildPlan } from './lib/sdk-native-features.mjs';
import { SDK_RELEASE_VERSION, assertCleanNativeSource, captureNativeSource, isNativeRuntimeLibrary } from './lib/sdk-current-release.mjs';
import { loadDistributionInput, verifyDistributionInput, verifyDistributionArtifact } from './lib/showcase-policy.mjs';
import { loadShowcaseNativeFont, retainShowcaseNativeFont, verifyShowcaseNativeFont, showcaseNativeFontEnvironment, verifyShowcaseNativeFontArtifact } from './lib/showcase-native-font.mjs';
import { hardenLinuxStaticArchive } from './lib/sdk-native-hardening.mjs';
import { hardenDarwinStaticArchive } from './lib/sdk-darwin-hardening.mjs';
import { portableNativeReceipt } from './lib/sdk-portable-native-receipt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseNativeBuildArgs(process.argv.slice(2));
if (options['--help']) {
  console.log(`Build ${SDK_RELEASE_VERSION} native runtime: --target <triple> [--profile release|dev] [--out directory] [--target-dir directory] [--view-diagnostics off|cpu|atrace] [--distribution-profile full|restricted-showcase] [--showcase-policy file] [--showcase-font file] [--showcase-font-license file] [--llvm-strip executable] [--offline]`);
  process.exit(0);
}
const option = (name, fallback) => options[name] ?? fallback;
function query(command, argv) {
  const r = spawnSync(command, argv, { encoding: 'utf8', cwd: root });
  if (r.error || r.status !== 0) throw new Error(`${command} ${argv.join(' ')}: ${r.error?.message || r.stderr}`);
  return r.stdout.trim();
}
const cargo = query('rustup', ['which', 'cargo']);
const rustc = query('rustup', ['which', 'rustc']);
const nativeHost = query(rustc, ['-vV']).match(/^host: (.+)$/m)?.[1];
const target = option('--target', nativeHost);
const profile = option('--profile', 'release');
if (!['release', 'dev'].includes(profile)) throw new Error('--profile must be release or dev');
const distribution = loadDistributionInput({ distributionProfile: option('--distribution-profile', 'full'),
  showcasePolicy: option('--showcase-policy'), profile, viewDiagnostics: option('--view-diagnostics', 'off') });
const plan = nativeBuildPlan(target, option('--view-diagnostics', 'off'), distribution.distributionProfile);
const { platform, viewDiagnostics } = plan;
const features = plan.features.join(',');
if (['ios', 'macos'].includes(platform) && process.platform !== 'darwin') throw new Error('Apple SDKs require macOS/Xcode');
if (platform === 'windows' && process.platform !== 'win32') throw new Error('Windows SDK requires a Windows MSVC runner');
if (platform === 'linux' && process.platform !== 'linux') throw new Error('Linux SDK requires a Linux runner');
const output = resolve(option('--out', resolve(root, 'artifacts/sdk/native')), target);
// Share normal workspace Cargo outputs unless the caller selects a cache.
// Cargo resolves relative environment paths from its working directory.
const targetDir = options['--target-dir'] !== undefined
  ? resolve(options['--target-dir'])
  : resolve(root, process.env.CARGO_TARGET_DIR || 'target');
mkdirSync(output, { recursive: true });
const nativeFont = retainShowcaseNativeFont(loadShowcaseNativeFont({ distributionProfile: distribution.distributionProfile,
  font: option('--showcase-font'), license: option('--showcase-font-license') }), resolve(output, 'inputs'));
const env = { ...process.env, RUSTC: rustc, RUSTDOC: query('rustup', ['which', 'rustdoc']), PATH: `${dirname(cargo)}${delimiter}${process.env.PATH || ''}` };
delete env.WEAPP_SHOWCASE_POLICY;
delete env.WEAPP_SHOWCASE_FONT;
delete env.WEAPP_SHOWCASE_FONT_LICENSE;
if (nativeFont) Object.assign(env, showcaseNativeFontEnvironment(nativeFont));
if (distribution.policy) {
  const policyFile = resolve(output, 'inputs/showcase-policy.json');
  mkdirSync(dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, distribution.canonical);
  env.WEAPP_SHOWCASE_POLICY = policyFile;
  env.CARGO_PROFILE_RELEASE_DEBUG = '0';
  env.CARGO_PROFILE_RELEASE_STRIP = 'debuginfo';
}
// LLVM utilities live deeper than rustc and some rustup distributions omit
// their library rpath. Resolve against this exact selected compiler, without
// modifying the user's installed toolchain or picking a Homebrew LLVM version.
if (process.platform === 'darwin') {
  env.DYLD_FALLBACK_LIBRARY_PATH = [resolve(dirname(rustc), '../lib'), env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(delimiter);
}
const toolchain = { rustc: query(rustc, ['--version']), cargo: query(cargo, ['--version']) };
// Keep local checkout locations out of distributed native debug/panic metadata.
const cargoSourceHome = resolve(env.CARGO_HOME || resolve(os.homedir(), '.cargo'));
// Dependency panic locations and generated bindings also embed source paths.
// Put specific mappings last: rustc resolves overlapping remaps from the end.
const sourcePathMappings = [
  [os.homedir(), 'build-home'],
  [cargoSourceHome, 'cargo'],
  [targetDir, 'weapp-container-build'],
  [root, 'weapp-container'],
];
env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS,
  ...sourcePathMappings.map(([source, destination]) => `--remap-path-prefix=${source}=${destination}`),
].filter(Boolean).join('\x1f');
// cc-based dependencies (QuickJS, ring and Skia bindings) expand __FILE__ in
// native code. rustc's source maps do not affect those compilation units.
const nativePathFlags = sourcePathMappings.map(([source, destination]) =>
  target.endsWith('-msvc') ? `/pathmap:${source}=${destination}` : `-ffile-prefix-map=${source}=${destination}`);
const quotedNativeFlags = nativePathFlags.map(flag => JSON.stringify(flag)).join(' ');
// cc otherwise splits only on whitespace and passes quote characters to clang.
env.CC_SHELL_ESCAPED_FLAGS = '1';
for (const variable of ['CFLAGS', 'CXXFLAGS']) {
  env[variable] = [env[variable], quotedNativeFlags].filter(Boolean).join(' ');
}
if (platform === 'windows') {
  // Upstream cached Skia libraries retain their producer's __FILE__ paths.
  // Rebuild this dependency with Clang's path maps and preserve its other GN flags.
  const flags = sourcePathMappings.map(([source, destination]) =>
    `/clang:-ffile-prefix-map=${source.replaceAll('\\', '/')}=${destination}`);
  env.FORCE_SKIA_BUILD = '1';
  env.SKIA_GN_ARGS = [env.SKIA_GN_ARGS, `extra_cflags += ${JSON.stringify(flags)}`].filter(Boolean).join('\n');
  env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, '-C', 'link-arg=/PDBALTPATH:weapp_container_sdk.pdb'].filter(Boolean).join('\x1f');
  toolchain.skiaSourceBuild = true;
  toolchain.skiaSourcePathsRemapped = true;
}
const runtimeDependencies = [];
const runtimeNotices = [];
if (platform === 'android') {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || resolve(os.homedir(), 'Library/Android/sdk');
  const ndkRoot = resolve(sdk, 'ndk');
  const ndkVersions = existsSync(ndkRoot) ? readdirSync(ndkRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  const ndk = env.ANDROID_NDK_HOME || env.ANDROID_NDK_ROOT || (ndkVersions[0] && resolve(ndkRoot, ndkVersions[0]));
  if (!ndk) throw new Error('Android NDK is required');
  const hosts = process.platform === 'darwin' ? ['darwin-aarch64', 'darwin-x86_64'] : process.platform === 'win32' ? ['windows-x86_64'] : ['linux-x86_64'];
  const prebuilt = hosts.map(h => resolve(ndk, 'toolchains/llvm/prebuilt', h)).find(existsSync);
  if (!prebuilt) throw new Error('Android NDK host toolchain is missing');
  const bin = resolve(prebuilt, 'bin');
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const linker = resolve(bin, `${target}26-clang${suffix}`);
  const cxx = resolve(bin, `${target}26-clang++${suffix}`);
  if (!existsSync(linker) || !existsSync(cxx)) throw new Error('Android API 26 compiler is missing');
  const key = target.replaceAll('-', '_');
  delete env.SDKROOT;
  delete env.SDKTARGETSYSROOT;
  env[`CARGO_TARGET_${key.toUpperCase()}_LINKER`] = linker;
  env[`CC_${key}`] = linker;
  env[`CXX_${key}`] = cxx;
  env[`AR_${key}`] = resolve(bin, process.platform === 'win32' ? 'llvm-ar.exe' : 'llvm-ar');
  env[`BINDGEN_EXTRA_CLANG_ARGS_${key}`] = `--target=${target}26 --sysroot="${resolve(prebuilt, 'sysroot')}"`;
  env.ANDROID_NDK = ndk;
  env.PATH = `${bin}${delimiter}${env.PATH}`;
  const nativeLibclang = ['/opt/homebrew/opt/llvm/lib', resolve(prebuilt, 'lib64')].find(p => ['libclang.dylib', 'libclang.so', 'libclang.dll'].some(f => existsSync(resolve(p, f))));
  if (!env.LIBCLANG_PATH && nativeLibclang) env.LIBCLANG_PATH = nativeLibclang;
  // The exported ELF must resolve by SONAME and support 16 KB Android pages.
  env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, '-C', 'link-arg=-Wl,-soname,libweapp_container_sdk.so', '-C', 'link-arg=-Wl,-z,max-page-size=16384'].filter(Boolean).join('\x1f');
  toolchain.androidNdk = basename(ndk);
  toolchain.androidApi = 26;
  const cppRuntime = resolve(prebuilt, 'sysroot/usr/lib', target, 'libc++_shared.so');
  if (!existsSync(cppRuntime)) throw new Error(`Android C++ runtime is missing: ${cppRuntime}`);
  runtimeDependencies.push(cppRuntime);
  for (const name of ['NOTICE', 'NOTICE.toolchain']) {
    const path = resolve(ndk, name);
    if (!existsSync(path)) throw new Error(`Android NDK ${name} is required`);
    runtimeNotices.push([path, `android-ndk-${basename(ndk)}-${name}`]);
  }
}
if (platform === 'ios') {
  env.IPHONEOS_DEPLOYMENT_TARGET = '16.0';
  toolchain.xcode = query('xcodebuild', ['-version']);
}
if (platform === 'macos') env.MACOSX_DEPLOYMENT_TARGET = '12.0';
if (['ios', 'macos'].includes(platform)) {
  // Do not let C++ exceptions cross the Rust ABI, or let -fno-rtti Skia
  // bindings inject private libc++ exception typeinfo into the embedding app.
  // cc-rs applies this target-specific input after generic CXXFLAGS. Keep this
  // explicit in exported-source builds as well as the workspace Cargo config.
  const cppFlags = `CXXFLAGS_${target.replaceAll('-', '_')}`;
  env[cppFlags] = [env[cppFlags], '-fno-exceptions'].filter(Boolean).join(' ');
  toolchain.cppExceptions = 'disabled-at-rust-ffi-boundary';
}
const cargoArgs = ['build', '-p', 'container-sdk-ffi', '--no-default-features', '--features', features, '--target', target, '--target-dir', targetDir, '--profile', profile, '--locked', '--message-format=json-render-diagnostics'];
if (options['--offline']) cargoArgs.push('--offline');
const receipt = {
  schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, abiVersion: 1, ...captureNativeSource(root),
  target, targetDir, platform, profile, viewDiagnostics, features: [...plan.features], toolchain,
  distributionProfile: distribution.distributionProfile, policySha256: distribution.policySha256,
  distributionPolicy: distribution.policyInput,
  ...(nativeFont ? { nativeFontInput: nativeFont } : {}),
  ...(distribution.policy ? { buildHardening: { debugInfo: false, strip: 'debuginfo', pathsRemapped: true } } : {}),
  startedAt: new Date().toISOString(), status: 'building', artifacts: [],
  thirdPartyInputs: [],
};
const receiptPath = resolve(output, 'build.json');
if (existsSync(receiptPath)) {
  const bytes = readFileSync(receiptPath), previous = JSON.parse(bytes);
  if (previous.sdkVersion !== SDK_RELEASE_VERSION) throw new Error('Existing native producer belongs to another version; select a new --out directory to preserve its bytes and evidence');
  const history = resolve(output, 'history'); mkdirSync(history, { recursive: true });
  const previousPath = resolve(history, `build-${createHash('sha256').update(bytes).digest('hex')}.json`);
  if (!existsSync(previousPath)) writeFileSync(previousPath, bytes, { flag: 'wx' });
}
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
let stdout = '';
let spawnError;
let exitCode;
try {
  if (profile === 'release') assertCleanNativeSource(receipt);
  receipt.thirdPartyInputs = verifySkiaInput(env, target, root);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const child = spawn(cargo, cargoArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  exitCode = await new Promise(done => {
    child.once('error', error => { spawnError = error.message; done(1); });
    child.once('close', code => done(code ?? 1));
  });
} catch (error) {
  spawnError = error.message;
  exitCode = 1;
}
writeFileSync(resolve(output, 'cargo-build.jsonl'), stdout);
receipt.finishedAt = new Date().toISOString();
receipt.status = exitCode === 0 ? 'built' : 'failed';
receipt.exitCode = exitCode;
if (spawnError) receipt.error = spawnError;
try { if (exitCode === 0) {
  const finalSource = captureNativeSource(root);
  verifyDistributionInput(distribution);
  verifyShowcaseNativeFont(nativeFont);
  if (distribution.policy && createHash('sha256').update(readFileSync(env.WEAPP_SHOWCASE_POLICY)).digest('hex') !== distribution.policySha256) throw Error('Retained showcase policy changed during compilation');
  receipt.sourceAfterBuild = finalSource;
  if (profile === 'release') assertCleanNativeSource(finalSource, receipt);
  if (JSON.stringify(verifySkiaInput(env, target, root)) !== JSON.stringify(receipt.thirdPartyInputs)) {
    throw new Error('Skia dependency inputs changed during native compilation');
  }
  const artifact = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .findLast(item => item?.reason === 'compiler-artifact' && item.target?.name === 'weapp_container_sdk');
  const files = artifact?.filenames.filter(f => /\.(?:a|so|dylib|dll|lib)$/.test(f)) || [];
  if (!files.length) throw new Error('Successful Cargo build did not report the SDK native artifact');
  for (const file of [...files, ...runtimeDependencies]) {
    const destination = resolve(output, basename(file));
    copyFileSync(file, destination);
    if (platform === 'linux' && basename(file) === 'libweapp_container_sdk.a') {
      receipt.artifactHardening ??= [];
      receipt.artifactHardening.push({ file: basename(file), ...hardenLinuxStaticArchive(destination, {
        sourcePrefixes: sourcePathMappings.map(([source]) => source),
      }) });
    }
    if (distribution.policy && ['ios', 'macos'].includes(platform) && basename(file) === 'libweapp_container_sdk.a') {
      receipt.artifactHardening ??= [];
      receipt.artifactHardening.push({ file: basename(file), ...hardenDarwinStaticArchive(destination, {
        strip: option('--llvm-strip', 'llvm-strip'),
        sourcePrefixes: sourcePathMappings.map(([source]) => source),
      }) });
    }
    if (platform === 'macos' && destination.endsWith('.dylib')) {
      query('install_name_tool', ['-id', `@rpath/${basename(file)}`, destination]);
      // Changing a Mach-O load command invalidates its linker signature.
      query('codesign', ['--force', '--sign', '-', destination]);
      receipt.installName = `@rpath/${basename(file)}`;
      receipt.signing = 'ad-hoc';
    }
    const bytes = readFileSync(destination);
    if (isNativeRuntimeLibrary(basename(file))) {
      receipt.distributionIdentity = verifyDistributionArtifact(bytes, distribution);
      if (nativeFont) receipt.nativeFont = verifyShowcaseNativeFontArtifact(bytes, nativeFont);
    }
    receipt.artifacts.push({ file: basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const [file, name] of runtimeNotices) {
    const destination = resolve(output, 'platform-notices', name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
    const bytes = readFileSync(destination);
    receipt.artifacts.push({ file: `platform-notices/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  // The GLES-compatible ABI stays unchanged. Desktop GL 3.3 uses an optional,
  // separately versioned resolver extension instead of changing that header.
  for (const name of ['weapp_container_sdk.h', 'weapp_container_sdk_gl.h']) {
    const header = resolve(output, name);
    copyFileSync(resolve(root, 'sdk/contract/include', name), header);
    const headerBytes = readFileSync(header);
    receipt.artifacts.push({ file: name, bytes: headerBytes.length, sha256: createHash('sha256').update(headerBytes).digest('hex') });
  }
  if (platform === 'macos') {
    const validation = resolve(output, 'validation'); mkdirSync(validation, { recursive: true });
    const fixture = resolve(root, 'scripts/fixtures/native-cpp-exception-consumer.cpp');
    const executable = resolve(validation, 'cpp-exception-consumer');
    const frameworks = ['AppKit', 'Metal', 'MetalKit', 'QuartzCore', 'CoreGraphics', 'CoreText',
      'CoreFoundation', 'Foundation', 'IOSurface', 'Security', 'SystemConfiguration', 'IOKit'];
    const argv = ['clang++', '-std=c++17', '-arch', target.startsWith('aarch64') ? 'arm64' : 'x86_64',
      '-mmacosx-version-min=12.0', '-I', output, fixture, resolve(output, 'libweapp_container_sdk.a'),
      ...frameworks.flatMap(name => ['-framework', name]), '-liconv', '-lresolv', '-o', executable];
    query('xcrun', argv);
    const nativeExecution = target === nativeHost;
    if (nativeExecution) query(executable, []);
    receipt.cppAbiValidation = {
      status: nativeExecution ? 'passed' : 'pending-cross-architecture-execution',
      scope: 'Actual static runtime linked into an independent C++ host with typed standard-exception catches',
      sourceSha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
      binarySha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
      compileCommand: ['xcrun', ...argv], executed: nativeExecution,
    };
  }
  const sourceBeforePublication = captureNativeSource(root);
  receipt.sourceBeforePublication = sourceBeforePublication;
  if (profile === 'release') assertCleanNativeSource(sourceBeforePublication, receipt);
  copyFileSync(resolve(root, 'LICENSE'), resolve(output, 'RUNTIME-LICENSE'));
  copyFileSync(resolve(root, 'LICENSE'), resolve(dirname(output), 'RUNTIME-LICENSE'));
} } catch (error) {
  receipt.status = 'failed';
  receipt.exitCode = 1;
  receipt.error = error.message;
}
receipt.finishedAt = new Date().toISOString();
const localEvidence = `${JSON.stringify(receipt, null, 2)}\n`;
const validationDirectory = resolve(output, 'validation');
mkdirSync(validationDirectory, { recursive: true });
writeFileSync(resolve(validationDirectory, 'producer.json'), localEvidence);
const publishedReceipt = receipt.status === 'built' && receipt.distributionProfile === 'full'
  ? portableNativeReceipt(receipt, createHash('sha256').update(localEvidence).digest('hex')) : receipt;
writeFileSync(receiptPath, `${JSON.stringify(publishedReceipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, target, receipt: receiptPath, artifacts: receipt.artifacts }, null, 2));
process.exitCode = receipt.exitCode;
