import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHash } from 'node:crypto'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const unsupportedShell = process.platform === 'win32'

// Exercise the complete CLI configuration boundary with recording tools. No
// Rust, CMake, emulator, APK or native runtime is executed by these fixtures.
function fixture(t) {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'weapp-native-api-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(resolve(dir, 'scripts'), { recursive: true })
  cpSync(resolve(root, 'scripts/build-native-hosts.mjs'), resolve(dir, 'scripts/build-native-hosts.mjs'))
  mkdirSync(resolve(dir, 'scripts/lib'))
  cpSync(resolve(root, 'scripts/lib/harmony-skia-build.mjs'), resolve(dir, 'scripts/lib/harmony-skia-build.mjs'))
  for (const file of ['sdk-current-release.mjs', 'sdk-native-features.mjs', 'showcase-policy.mjs', 'showcase-native-font.mjs']) cpSync(resolve(root, 'scripts/lib', file), resolve(dir, 'scripts/lib', file))
  // CLI/environment wiring uses a finite synthetic font and inert compiler.
  // Production font pins are separately checked against reviewed asset pins.
  const font = resolve(dir, 'font-fixture.bin'), fontLicense = resolve(dir, 'font-license.txt'), fontBytes = Buffer.from('finite reviewed font fixture')
  writeFileSync(font, fontBytes); cpSync(resolve(root, 'sdk/licenses/noto-sans-sc/LICENSE.OFL.txt'), fontLicense)
  const fontHelper = resolve(dir, 'scripts/lib/showcase-native-font.mjs')
  writeFileSync(fontHelper, readFileSync(fontHelper, 'utf8').replace('a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da', createHash('sha256').update(fontBytes).digest('hex')).replace('fontBytes: 17772300', `fontBytes: ${fontBytes.length}`))
  const project = 'examples/hosts/android'
  for (const file of ['settings.gradle.kts', 'build.gradle.kts', 'app/build.gradle.kts', 'app/src']) {
    const target = resolve(dir, project, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolve(root, project, file), target, { recursive: true })
  }
  for (const file of ['Package.swift', 'Sources']) {
    const target = resolve(dir, 'examples/hosts/ios', file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolve(root, 'examples/hosts/ios', file), target, { recursive: true })
  }
  cpSync(resolve(root, 'examples/hosts/harmony'), resolve(dir, 'examples/hosts/harmony'), {
    recursive: true,
    filter: path => !['.hvigor', '.cxx', 'build', 'oh_modules', 'node_modules'].includes(basename(path)),
  })
  const bin = resolve(dir, 'bin')
  mkdirSync(bin)
  const recorder = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]);
if (name === 'rustup') {
  if (process.argv[2] !== 'which') process.exit(1);
  console.log(path.join(path.dirname(process.argv[1]), process.argv[3]));
} else if (name === 'cargo') {
  const receipt = JSON.stringify({ args: process.argv.slice(2), env: process.env });
  fs.writeFileSync(path.join(process.cwd(), 'cargo.json'), receipt);
  fs.appendFileSync(path.join(process.cwd(), 'cargo-history.jsonl'), receipt + '\\n');
  const targetArg = process.argv.indexOf('--target-dir');
  const targetDir = path.resolve(process.cwd(), targetArg < 0 ? process.env.CARGO_TARGET_DIR || 'target' : process.argv[targetArg + 1]);
  const target = path.join(targetDir, (process.argv.includes('container-host-ios')
    ? 'aarch64-apple-ios-sim/debug/libcontainer_host_ios.a'
    : process.argv.includes('container-host-harmony')
      ? 'aarch64-unknown-linux-ohos/debug/libcontainer_host_harmony.so'
      : 'aarch64-linux-android/debug/libcontainer_host_android.so').replace('/debug/', process.argv.includes('--release') ? '/release/' : '/debug/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let bytes = Buffer.from('recording fixture, not a native library');
  if (process.env.WEAPP_SHOWCASE_POLICY) bytes = Buffer.concat([bytes, Buffer.from('weapp-container-distribution:restricted-showcase:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(process.env.WEAPP_SHOWCASE_POLICY)).digest('hex') + String.fromCharCode(0))]);
  if (process.env.WEAPP_SHOWCASE_FONT) { const font=fs.readFileSync(process.env.WEAPP_SHOWCASE_FONT),license=fs.readFileSync(process.env.WEAPP_SHOWCASE_FONT_LICENSE),hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');bytes=Buffer.concat([bytes,font,Buffer.from('weapp-container-native-font:'+hash(font)+':'+hash(license)+String.fromCharCode(0))]); }
  if (process.env.WEAPP_NATIVE_TEST_PATH_LEAK) bytes = Buffer.concat([bytes, Buffer.from(process.env.WEAPP_NATIVE_TEST_PATH_LEAK)]);
  fs.writeFileSync(target, bytes);
  if (process.env.WEAPP_NATIVE_TEST_MUTATE_SOURCE) fs.appendFileSync(path.join(process.cwd(), 'examples/hosts/android/settings.gradle.kts'), '\\n// recording fixture mutation\\n');
  if (process.env.WEAPP_NATIVE_TEST_STDOUT) fs.writeSync(1, process.env.WEAPP_NATIVE_TEST_STDOUT);
  if (process.env.WEAPP_NATIVE_TEST_STDERR) fs.writeSync(2, process.env.WEAPP_NATIVE_TEST_STDERR);
  if (process.env.WEAPP_NATIVE_TEST_EXIT_CODE) process.exit(Number(process.env.WEAPP_NATIVE_TEST_EXIT_CODE));
} else if (name === 'llvm-readelf') {
  if (process.env.WEAPP_NATIVE_TEST_SECTIONS) process.stdout.write(process.env.WEAPP_NATIVE_TEST_SECTIONS);
} else if (name === 'cmake') {
  fs.appendFileSync(path.join(process.cwd(), 'cmake.jsonl'), JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');
  if (process.env.WEAPP_SHOWCASE_POLICY && process.argv.includes('--build')) {
    const output = process.argv[process.argv.indexOf('--build') + 1]; fs.mkdirSync(output, { recursive:true });
    fs.writeFileSync(path.join(output, 'libentry.so'), 'inert N-API fixture' + (process.env.WEAPP_NATIVE_TEST_NAPI_PATH_LEAK || ''));
    const records = fs.readFileSync(path.join(process.cwd(), 'cmake.jsonl'), 'utf8').trim().split('\\n').map(JSON.parse);
    const library = records.flatMap(record => record.args).findLast(arg => arg.startsWith('-DWEAPP_CONTAINER_HARMONY_RUST_LIB='));
    fs.copyFileSync(library.slice(library.indexOf('=') + 1), path.join(output, 'libcontainer_host_harmony.so'));
  }
}
`
  for (const name of ['rustup', 'cargo', 'rustc', 'rustdoc', 'cmake', 'swift']) {
    writeFileSync(resolve(bin, name), recorder)
    chmodSync(resolve(bin, name), 0o755)
  }
  const ndk = resolve(dir, 'ndk')
  const host = process.platform === 'linux' ? 'linux-x86_64' : 'darwin-aarch64'
  const prebuilt = resolve(ndk, 'toolchains/llvm/prebuilt', host)
  mkdirSync(resolve(prebuilt, 'bin'), { recursive: true })
  for (const api of [26, 30]) {
    for (const suffix of ['clang', 'clang++']) {
      writeFileSync(resolve(prebuilt, 'bin', `aarch64-linux-android${api}-${suffix}`), '')
    }
    mkdirSync(resolve(prebuilt, 'sysroot/usr/lib/aarch64-linux-android', String(api)), { recursive: true })
  }
  const harmonySdk = resolve(dir, 'harmony-sdk')
  mkdirSync(resolve(harmonySdk, 'native/llvm/bin'), { recursive: true })
  for (const name of ['aarch64-unknown-linux-ohos-clang', 'aarch64-unknown-linux-ohos-clang++', 'llvm-ar', 'llvm-ranlib']) {
    writeFileSync(resolve(harmonySdk, 'native/llvm/bin', name), '')
  }
  writeFileSync(resolve(harmonySdk, 'native/llvm/bin/llvm-readelf'), recorder, { mode: 0o755 })
  mkdirSync(resolve(harmonySdk, 'native/sysroot'), { recursive: true })
  mkdirSync(resolve(harmonySdk, 'native/build/cmake'), { recursive: true })
  writeFileSync(resolve(harmonySdk, 'native/build/cmake/ohos.toolchain.cmake'), '')
  return { dir, bin, ndk, prebuilt, harmonySdk, font, fontLicense }
}

function run(value, api, extraEnv = {}, additionalPlatforms = [], extraArgs = [], toolFile = resolve(value.dir, 'scripts/build-native-hosts.mjs')) {
  const env = {
    ...process.env,
    PATH: `${value.bin}:${process.env.PATH || ''}`,
    ANDROID_NDK_HOME: value.ndk,
    HARMONY_HOME: value.harmonySdk,
    ...extraEnv,
  }
  delete env.ANDROID_API_LEVEL
  delete env.BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android
  // Recording fixtures own their synthetic target tree. A workspace test
  // runner's cache path must not leak into the fixtures; explicit per-scenario
  // overrides below exercise inherited and CLI-selected shared caches.
  for (const key of ['CARGO_TARGET_DIR', 'SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH', 'DOCS_RS']) delete env[key]
  if (api !== undefined) env.ANDROID_API_LEVEL = api
  Object.assign(env, extraEnv)
  const result = spawnSync(process.execPath, [
    toolFile,
    '--build', '--platform', 'android', '--engine', 'quickjs', '--out', resolve(value.dir, 'report.json'),
    ...additionalPlatforms.flatMap(platform => ['--platform', platform]),
    ...extraArgs,
  ], { cwd: value.dir, env, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(result.error)
  assert.ok(existsSync(resolve(value.dir, 'report.json')), `Native fixture exited ${result.status} before writing its receipt:\n${result.stderr}`)
  const report = JSON.parse(readFileSync(resolve(value.dir, 'report.json'), 'utf8'))
  return { result, report, platform: report.platforms[0] }
}

function commitFixture(value) {
  writeFileSync(resolve(value.dir, '.gitignore'), '/target/\n/cargo*.json*\n/cmake.jsonl\n/report.json\n')
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Finite fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'finite producer fixture']]) {
    const result = spawnSync('git', args, { cwd: value.dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
}

test('restricted Harmony producer pins the policy and verifies both Rust and N-API integration bytes', { skip: unsupportedShell }, t => {
  const value = fixture(t), policy = resolve(value.dir, 'policy.json'), output = resolve(value.dir, 'target/showcase/build.json')
  writeFileSync(policy, JSON.stringify({ schemaVersion: 1, allowedPackRoots: ['a'.repeat(64)], allowedApis: ['wx.timer'] }))
  commitFixture(value)
  const env = { ...process.env, PATH: `${value.bin}:${process.env.PATH || ''}`, HARMONY_HOME: value.harmonySdk }
  for (const key of ['CARGO_TARGET_DIR', 'SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH', 'DOCS_RS']) delete env[key]
  const argv = [resolve(value.dir, 'scripts/build-native-hosts.mjs'), '--build', '--platform', 'harmony', '--profile', 'release',
    '--out', output, '--distribution-profile', 'restricted-showcase', '--showcase-policy', policy,
    '--showcase-font', value.font, '--showcase-font-license', value.fontLicense]
  const result = spawnSync(process.execPath, argv, { cwd: value.dir, env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(readFileSync(output)), platform = report.platforms[0]
  assert.equal(report.distributionProfile, 'restricted-showcase'); assert.match(report.policySha256, /^[a-f0-9]{64}$/)
  assert.equal(report.sourceAfter.sourceDirty, false); assert.equal(platform.policySha256, report.policySha256)
  assert.ok(platform.features.split(',').includes('restricted-showcase')); assert.equal(platform.compiledIdentity.markerVerified, true)
  assert.deepEqual(platform.appIntegration.artifacts.map(value => value.path.split('/').at(-1)), ['libentry.so', 'libcontainer_host_harmony.so'])
  assert.equal(platform.appIntegration.artifacts[1].sha256, platform.artifact.sha256)
  assert.equal(platform.appIntegration.artifacts[0].hardening.debugInfo, false)
  assert.equal(platform.artifact.hardening.localBuildPaths, false)
  const invocation = JSON.parse(readFileSync(resolve(value.dir, 'cargo.json')))
  assert.equal(invocation.env.CARGO_PROFILE_RELEASE_DEBUG, '0'); assert.equal(invocation.env.CARGO_PROFILE_RELEASE_STRIP, 'debuginfo')
  assert.equal(invocation.env.WEAPP_SHOWCASE_POLICY, report.distributionPolicy.retainedPath)
  assert.notEqual(invocation.env.WEAPP_SHOWCASE_POLICY, policy)
  assert.equal(platform.nativeFont.markerVerified, true)
  assert.equal(invocation.env.WEAPP_SHOWCASE_FONT, report.nativeFontInput.retainedFontPath)
  assert.equal(invocation.env.WEAPP_SHOWCASE_FONT_LICENSE, report.nativeFontInput.retainedLicensePath)
  assert.notEqual(invocation.env.WEAPP_SHOWCASE_FONT, value.font)
  const rejectedOutput = resolve(value.dir, 'target/rejected/build.json'), rejectedArgs = [...argv]
  rejectedArgs[rejectedArgs.indexOf('--out') + 1] = rejectedOutput
  const rejected = spawnSync(process.execPath, rejectedArgs, { cwd: value.dir, env: { ...env, WEAPP_NATIVE_TEST_SECTIONS: '[12] .debug_info' }, encoding: 'utf8', timeout: 30_000 })
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /still contains debug sections/)
  assert.equal(existsSync(rejectedOutput), false)
})

test('restricted Harmony remaps and scans external cache aliases without adopting caller cache ownership', { skip: unsupportedShell }, t => {
  for (const scenario of ['argument', 'environment', 'rust-logical-leak', 'rust-physical-leak', 'napi-physical-leak']) {
    const value = fixture(t), policy = resolve(value.dir, 'policy.json'), output = resolve(value.dir, 'target/showcase/build.json')
    const cacheRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'weapp-harmony-external-cache-')))
    t.after(() => rmSync(cacheRoot, { recursive: true, force: true }))
    const physicalCache = resolve(cacheRoot, 'physical cache'), cacheAlias = resolve(cacheRoot, 'cache alias')
    mkdirSync(physicalCache); symlinkSync(physicalCache, cacheAlias, 'dir')
    writeFileSync(resolve(physicalCache, 'caller-cache.txt'), 'keep caller data')
    writeFileSync(policy, JSON.stringify({ schemaVersion: 1, allowedPackRoots: ['a'.repeat(64)], allowedApis: ['wx.timer'] }))
    commitFixture(value)
    const env = { ...process.env, PATH: `${value.bin}:${process.env.PATH || ''}`, HARMONY_HOME: value.harmonySdk }
    for (const key of ['CARGO_TARGET_DIR', 'SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH', 'DOCS_RS']) delete env[key]
    if (scenario === 'environment') env.CARGO_TARGET_DIR = cacheAlias
    if (scenario === 'rust-logical-leak') env.WEAPP_NATIVE_TEST_PATH_LEAK = cacheAlias
    if (scenario === 'rust-physical-leak') env.WEAPP_NATIVE_TEST_PATH_LEAK = physicalCache
    if (scenario === 'napi-physical-leak') env.WEAPP_NATIVE_TEST_NAPI_PATH_LEAK = physicalCache
    const argv = [resolve(value.dir, 'scripts/build-native-hosts.mjs'), '--build', '--platform', 'harmony', '--profile', 'release',
      '--out', output, '--distribution-profile', 'restricted-showcase', '--showcase-policy', policy,
      '--showcase-font', value.font, '--showcase-font-license', value.fontLicense,
      ...(scenario === 'environment' ? [] : ['--target-dir', cacheAlias])]
    const result = spawnSync(process.execPath, argv, { cwd: value.dir, env, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(result.error)
    const invocation = JSON.parse(readFileSync(resolve(value.dir, 'cargo.json')))
    assert.equal(invocation.args[invocation.args.indexOf('--target-dir') + 1], cacheAlias)
    for (const path of [cacheAlias, physicalCache]) {
      assert.ok(invocation.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').includes(`--remap-path-prefix=${path}=weapp-container-build`))
      for (const key of ['CFLAGS', 'CXXFLAGS']) assert.ok(invocation.env[key].includes(JSON.stringify(`-ffile-prefix-map=${path}=weapp-container-build`)))
    }
    assert.equal(readFileSync(resolve(physicalCache, 'caller-cache.txt'), 'utf8'), 'keep caller data')
    assert.equal(realpathSync(cacheAlias), physicalCache, 'the caller alias and persistent cache remain intact')
    if (scenario.endsWith('leak')) {
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /still contains a local build path/)
      assert.equal(existsSync(output), false, 'unreviewed bytes cannot produce a successful receipt')
    } else {
      assert.equal(result.status, 0, result.stderr)
      const report = JSON.parse(readFileSync(output)), platform = report.platforms[0]
      assert.equal(report.targetDir, cacheAlias)
      assert.ok(report.buildHardening.sourcePathMappings.some(value => value.source === cacheAlias))
      assert.ok(report.buildHardening.sourcePathMappings.some(value => value.source === physicalCache))
      assert.equal(platform.artifact.path, resolve(cacheAlias, 'aarch64-unknown-linux-ohos/release/libcontainer_host_harmony.so'))
      assert.equal(platform.artifact.hardening.localBuildPaths, false)
      assert.equal(platform.appIntegration.artifacts.length, 2)
      assert.equal(platform.appIntegration.artifacts[1].sha256, platform.artifact.sha256)
    }
  }
})

test('release native profile records exact bytes and rejects source mutation without certifying runtime readiness', { skip: unsupportedShell }, t => {
  for (const mutate of [false, true]) {
    const value = fixture(t); commitFixture(value)
    const { result, report, platform } = run(value, undefined, mutate ? { WEAPP_NATIVE_TEST_MUTATE_SOURCE: '1' } : {}, [], ['--profile', 'release', '--source-root', value.dir], mutate ? undefined : resolve(root, 'scripts/build-native-hosts.mjs'))
    assert.equal(result.status, mutate ? 1 : 0, result.stderr)
    assert.equal(report.profile, 'release'); assert.equal(platform.profile, 'release')
    assert.equal(report.sourceBefore.sourceDirty, false); assert.equal(report.sourceAfter.sourceDirty, mutate)
    assert.equal(Boolean(report.sourceError), mutate)
    assert.match(platform.artifact.path, /\/release\//); assert.match(platform.artifact.sha256, /^[a-f0-9]{64}$/)
    assert.equal(platform.artifact.bytes, Buffer.byteLength('recording fixture, not a native library'))
    assert.ok(JSON.parse(readFileSync(resolve(value.dir, 'cargo.json'))).args.includes('--release'))
    assert.equal(report.producerTool.files.length, 6)
    if (!mutate) assert.notEqual(report.producerTool.sourceCommit, report.sourceBefore.sourceCommit, 'source and externally supplied build tool identities remain distinct')
  }
})

test('native discovery rejects malformed profiles and target directory options before invoking Cargo', { skip: unsupportedShell }, t => {
  const value = fixture(t)
  for (const [args, env] of [[['--profile', 'bogus'], {}], [['--profile'], {}], [['--profile', 'dev', '--profile', 'release'], {}], [['--target-dir'], {}], [['--target-dir', 'one', '--target-dir', 'two'], {}]]) {
    const result = spawnSync(process.execPath, [resolve(value.dir, 'scripts/build-native-hosts.mjs'), '--build', ...args], { cwd: value.dir, encoding: 'utf8', env: { ...process.env, PATH: `${value.bin}:${process.env.PATH || ''}`, ...env } })
    assert.equal(result.status, 1); assert.equal(existsSync(resolve(value.dir, 'cargo.json')), false)
    assert.match(result.stderr, /profile|target-dir/)
  }
})

test('native host artifact discovery follows the selected persistent cache in dev and release', { skip: unsupportedShell }, t => {
  for (const profile of ['dev', 'release']) {
    for (const selection of ['default', 'environment', 'explicit']) {
      const value = fixture(t)
      const shared = realpathSync(mkdtempSync(resolve(tmpdir(), 'weapp-native-shared-cache-')))
      t.after(() => rmSync(shared, { recursive: true, force: true }))
      const inherited = 'target/inherited cache'
      const targetDir = selection === 'explicit' ? shared : resolve(value.dir, selection === 'environment' ? inherited : 'target')
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(resolve(targetDir, 'keep-cache.txt'), 'caller-owned cache')
      if (profile === 'release') commitFixture(value)
      const env = selection === 'default' ? {} : { CARGO_TARGET_DIR: inherited }
      const args = ['--profile', profile, ...(selection === 'explicit' ? ['--target-dir', shared] : [])]
      const { result, report, platform } = run(value, undefined, env, [], args)
      assert.equal(result.status, 0, result.stderr)
      const artifactPath = resolve(targetDir, 'aarch64-linux-android', profile === 'release' ? 'release' : 'debug', 'libcontainer_host_android.so')
      assert.equal(report.targetDir, targetDir)
      assert.equal(platform.artifact.path, artifactPath)
      assert.equal(platform.artifact.exists, true)
      assert.equal(platform.artifact.bytes, Buffer.byteLength('recording fixture, not a native library'))
      assert.match(platform.artifact.sha256, /^[a-f0-9]{64}$/)
      const cargo = JSON.parse(readFileSync(resolve(value.dir, 'cargo.json'), 'utf8'))
      assert.equal(cargo.args[cargo.args.indexOf('--target-dir') + 1], targetDir)
      const configure = JSON.parse(readFileSync(resolve(value.dir, 'cmake.jsonl'), 'utf8').split('\n')[0])
      assert.ok(configure.args.includes(`-DWEAPP_CONTAINER_ANDROID_RUST_LIB=${artifactPath}`))
      assert.equal(readFileSync(resolve(targetDir, 'keep-cache.txt'), 'utf8'), 'caller-owned cache')
      assert.equal(existsSync(artifactPath), true, 'persistent build output remains available after the command')
      if (profile === 'release') {
        assert.equal(report.sourceBefore.sourceDirty, false)
        assert.equal(report.sourceAfter.sourceDirty, false)
      }
    }
  }
})

function assertConfiguration(value, platform, api) {
  assert.equal(platform.status, 'passed')
  assert.equal(platform.toolchain.apiLevel, api)
  assert.equal(platform.toolchain.sampleMinSdk, 26)
  assert.equal(platform.toolchain.skiaMinimumApi, 26)
  assert.equal(platform.toolchain.skiaApiSource, 'skia-bindings-0.153.3-pinned-default')
  assert.equal(platform.toolchain.compatibility, 'not-verified')
  const cargo = JSON.parse(readFileSync(resolve(value.dir, 'cargo.json'), 'utf8'))
  const linker = resolve(value.prebuilt, 'bin', `aarch64-linux-android${api}-clang`)
  assert.equal(cargo.env.CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER, linker)
  assert.equal(cargo.env.CC_aarch64_linux_android, linker)
  assert.equal(cargo.env.CXX_aarch64_linux_android, `${linker}++`)
  assert.match(cargo.env.BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android, new RegExp(`--target=aarch64-linux-android${api}(?: |$)`))
  assert.ok(cargo.env.BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android.includes(`--sysroot=${JSON.stringify(resolve(value.prebuilt, 'sysroot'))}`))
  assert.ok(cargo.args.includes('android,gles,skia-gpu-gles,quickjs-native-android'))
  const cmake = readFileSync(resolve(value.dir, 'cmake.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(cmake[0].args.includes(`-DANDROID_PLATFORM=android-${api}`))
  assert.deepEqual(cmake[1].args.slice(0, 1), ['--build'])
}

test('Android native default matches sample minSdk through Rust, bindgen and JNI', { skip: unsupportedShell }, (t) => {
  const value = fixture(t)
  const { result, report, platform } = run(value)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(platform.toolchain.apiSource, 'sample-min-sdk')
  const gradle = readFileSync(resolve(root, 'examples/hosts/android/app/build.gradle.kts'), 'utf8')
  assert.match(gradle, new RegExp(`^\\s*minSdk\\s*=\\s*${platform.toolchain.apiLevel}\\s*$`, 'm'))
  const lockfile = readFileSync(resolve(root, 'Cargo.lock'), 'utf8')
  assert.match(lockfile, /name = "skia-bindings"\nversion = "0\.153\.3"/)
  assertConfiguration(value, platform, 26)
  assert.ok(report.notes.some(note => note.includes('not Android, iOS or Harmony emulator/device conformance')))
})

test('Android explicit API reaches Rust, QuickJS and JNI with a separate pinned Skia floor', { skip: unsupportedShell }, (t) => {
  const value = fixture(t)
  const { result, platform } = run(value, '30', {
    BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android: '-DWEAPP_BINDGEN_TEST=1 --target=aarch64-linux-android35',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(platform.toolchain.apiSource, 'ANDROID_API_LEVEL')
  assertConfiguration(value, platform, 30)
  const args = JSON.parse(readFileSync(resolve(value.dir, 'cargo.json'), 'utf8')).env.BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android
  assert.ok(args.startsWith('-DWEAPP_BINDGEN_TEST=1 '))
  assert.ok(args.lastIndexOf('--target=aarch64-linux-android30') > args.indexOf('--target=aarch64-linux-android35'))
})

for (const exitCode of [0, 39]) {
  test(`native Cargo diagnostics retain complete stdout/stderr on exit ${exitCode}`, { skip: unsupportedShell }, (t) => {
    const value = fixture(t)
    const stdout = `stdout-prefix:${'a'.repeat(7000)}:stdout-middle:${'b'.repeat(7000)}:stdout-tail`
    const stderr = `stderr-prefix:${'c'.repeat(7000)}:stderr-middle:${'d'.repeat(7000)}:stderr-tail`
    const { result, platform } = run(value, undefined, {
      WEAPP_NATIVE_TEST_STDOUT: stdout,
      WEAPP_NATIVE_TEST_STDERR: stderr,
      WEAPP_NATIVE_TEST_EXIT_CODE: String(exitCode),
    })
    assert.equal(result.status, exitCode === 0 ? 0 : 1)
    assert.equal(platform.cargo.status, exitCode === 0 ? 'passed' : 'failed')
    assert.equal(platform.cargo.exitCode, exitCode)
    assert.equal(platform.cargo.stdout, stdout)
    assert.equal(platform.cargo.stderr, stderr)
    assert.equal(platform.cargo.errorCode, null)
    if (exitCode !== 0) assert.equal(platform.appIntegration.status, 'not-run')
  })
}

test('Android isolates inherited SDK roots for Cargo and JNI while preserving the subsequent iOS host environment', { skip: unsupportedShell }, (t) => {
  const value = fixture(t)
  const appleSdk = '/recording-host/MacOSX.sdk'
  const foreignTargetSdk = '/recording-foreign/sysroot'
  const { result, report, platform } = run(value, undefined, {
    SDKROOT: appleSdk,
    SDKTARGETSYSROOT: foreignTargetSdk,
  }, ['ios'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(platform.toolchain.ignoredSdkEnvironment, ['SDKROOT', 'SDKTARGETSYSROOT'])
  const cargo = readFileSync(resolve(value.dir, 'cargo-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(cargo.length, 2)
  assert.ok(cargo[0].args.includes('container-host-android'))
  assert.equal(cargo[0].env.SDKROOT, undefined)
  assert.equal(cargo[0].env.SDKTARGETSYSROOT, undefined)
  const cmake = readFileSync(resolve(value.dir, 'cmake.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  for (const invocation of cmake) {
    assert.equal(invocation.env.SDKROOT, undefined)
    assert.equal(invocation.env.SDKTARGETSYSROOT, undefined)
  }
  assert.ok(cargo[1].args.includes('container-host-ios'))
  assert.equal(cargo[1].env.SDKROOT, appleSdk)
  assert.equal(cargo[1].env.SDKTARGETSYSROOT, foreignTargetSdk)
  assert.equal(report.platforms[1].status, 'passed')
})

for (const api of ['', '25', '30oops', '35.0', '-1', '9007199254740992']) {
  test(`Android rejects invalid API ${JSON.stringify(api)} before running build tools`, { skip: unsupportedShell }, (t) => {
    const value = fixture(t)
    const { result, platform } = run(value, api)
    assert.equal(result.status, 1)
    assert.equal(platform.status, 'failed')
    assert.equal(platform.toolchain.apiLevel, null)
    assert.match(platform.toolchain.error, /ANDROID_API_LEVEL must be an integer >= 26/)
    assert.equal(platform.cargo.status, 'not-run')
    assert.equal(platform.appIntegration.status, 'not-run')
    assert.equal(existsSync(resolve(value.dir, 'cargo.json')), false)
    assert.equal(existsSync(resolve(value.dir, 'cmake.jsonl')), false)
  })
}

test('Android missing explicit API compiler fails without silently selecting a different NDK target', { skip: unsupportedShell }, (t) => {
  const value = fixture(t)
  const { result, platform } = run(value, '35')
  assert.equal(result.status, 1)
  assert.equal(platform.toolchain.apiLevel, 35)
  assert.match(platform.toolchain.error, /API 35 is unavailable/)
  assert.equal(platform.cargo.status, 'not-run')
  assert.equal(existsSync(resolve(value.dir, 'cargo.json')), false)
})

test('Android missing API sysroot fails before Cargo can reuse an old artifact', { skip: unsupportedShell }, (t) => {
  const value = fixture(t)
  rmSync(resolve(value.prebuilt, 'sysroot/usr/lib/aarch64-linux-android/26'), { recursive: true })
  const { result, platform } = run(value)
  assert.equal(result.status, 1)
  assert.match(platform.toolchain.error, /sysroot libraries for API 26 are unavailable/)
  assert.equal(platform.cargo.status, 'not-run')
  assert.equal(platform.appIntegration.status, 'not-run')
  assert.equal(existsSync(resolve(value.dir, 'cmake.jsonl')), false)
})

test('Harmony forces bundled font decoding without mutating the adjacent native host environments', { skip: unsupportedShell }, t => {
  const value = fixture(t)
  const inherited = 'custom_value="a b" skia_use_freetype=false # retained user settings'
  const { result, report } = run(value, undefined, {
    SKIA_GN_ARGS: inherited,
    FORCE_SKIA_BUILD: '0',
  }, ['harmony', 'ios'])
  assert.equal(result.status, 0, result.stderr)
  const history = readFileSync(resolve(value.dir, 'cargo-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(history.length, 3)
  assert.ok(history[1].args.includes('container-host-harmony'))
  assert.ok(history[1].args.includes('harmony,arkui,skia-gpu-gles,quickjs-native-harmony'))
  const required = 'skia_use_freetype=true skia_use_system_freetype2=false skia_enable_fontmgr_custom_empty=true'
  assert.equal(history[1].env.SKIA_GN_ARGS, `${inherited}\n${required}`)
  assert.equal(history[1].env.FORCE_SKIA_BUILD, '1')
  const harmony = report.platforms[1]
  assert.equal(harmony.status, 'passed')
  assert.equal(harmony.toolchain.skia.effectiveGnArgs, history[1].env.SKIA_GN_ARGS)
  assert.equal(harmony.toolchain.skia.forceSourceBuild, true)
  assert.equal(harmony.toolchain.skia.fontDecoder, 'bundled-freetype')
  assert.equal(harmony.toolchain.skia.verified, false)
  for (const invocation of [history[0], history[2]]) {
    assert.equal(invocation.env.SKIA_GN_ARGS, inherited)
    assert.equal(invocation.env.FORCE_SKIA_BUILD, '0')
  }
})

for (const key of ['SKIA_SOURCE_DIR', 'SKIA_LIBRARY_SEARCH_PATH', 'DOCS_RS']) {
  test(`Harmony rejects ${key} before Cargo can reuse an unverified native library`, { skip: unsupportedShell }, t => {
    const value = fixture(t)
    const { result, report } = run(value, undefined, { [key]: '/unverified/build' }, ['harmony'])
    assert.equal(result.status, 1, result.stderr)
    const harmony = report.platforms[1]
    assert.equal(harmony.status, 'failed')
    assert.match(harmony.toolchain.error, /Harmony Skia requires/)
    assert.equal(harmony.cargo.status, 'not-run')
    assert.equal(harmony.appIntegration.status, 'not-run')
    const history = readFileSync(resolve(value.dir, 'cargo-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(history.length, 1)
    assert.ok(history[0].args.includes('container-host-android'))
  })
}
