#!/usr/bin/env node
/**
 * Validate/build the native host integration points.
 *
 * This command intentionally stops at the Rust library + platform project
 * boundary.  An Android APK, an Xcode app and a DevEco package need their
 * vendor SDKs and signing setup; their availability is reported explicitly and
 * never turned into a false device-conformance claim.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { harmonySkiaBuild } from './lib/harmony-skia-build.mjs'
import { createHash } from 'node:crypto'
import { SDK_RELEASE_VERSION, assertCleanNativeSource, captureNativeSource } from './lib/sdk-current-release.mjs'
import { loadDistributionInput, verifyDistributionInput, verifyDistributionArtifact } from './lib/showcase-policy.mjs'
import { loadShowcaseNativeFont, retainShowcaseNativeFont, verifyShowcaseNativeFont, showcaseNativeFontEnvironment, verifyShowcaseNativeFontArtifact } from './lib/showcase-native-font.mjs'

const toolRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf(name) !== index) throw new Error(`${name} requires one value`)
  return args[index + 1]
}
const root = resolve(option('--source-root', toolRoot))
// Prefer the binaries selected by rustup over a separately installed
// Homebrew compiler.  The latter can have the same version string while
// lacking the rustup-managed target standard libraries (for example
// aarch64-linux-android), which makes a native check fail before Cargo ever
// reaches the host crate.  Keep the fallback for machines that do not have
// rustup installed.
function rustupWhich(binary) {
  const result = spawnSync('rustup', ['which', binary], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 ? result.stdout.trim() : null
}

const rustupCargo = rustupWhich('cargo')
const rustupRustc = rustupWhich('rustc')
const rustupRustdoc = rustupWhich('rustdoc')
const cargoBin = [rustupCargo, '/opt/homebrew/opt/rustup/bin/cargo', `${process.env.HOME || ''}/.cargo/bin/cargo`]
  .find(candidate => candidate && existsSync(candidate)) || 'cargo'
const cargoEnv = cargoBin.includes('/')
  ? {
      PATH: `${dirname(cargoBin)}:${process.env.PATH || ''}`,
      ...(rustupRustc && existsSync(rustupRustc) ? { RUSTC: rustupRustc } : {}),
      ...(rustupRustdoc && existsSync(rustupRustdoc) ? { RUSTDOC: rustupRustdoc } : {}),
      ...(process.platform === 'darwin' && rustupRustc ? { DYLD_FALLBACK_LIBRARY_PATH: [resolve(dirname(rustupRustc), '../lib'), process.env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':') } : {}),
    }
  : {}
const mode = args.includes('--build') ? 'build' : 'check'
const profile = option('--profile', 'dev')
if (!['dev', 'release'].includes(profile)) throw new Error('--profile must be dev or release')
const distribution = loadDistributionInput({ distributionProfile: option('--distribution-profile', 'full'), showcasePolicy: option('--showcase-policy'), profile })
const explicitTargetDir = option('--target-dir')
const targetDir = explicitTargetDir !== undefined
  ? resolve(explicitTargetDir)
  : resolve(root, process.env.CARGO_TARGET_DIR || 'target')
// Cargo may create a cache below a symlinked parent. Resolve the existing
// ancestor as well so generated source paths cannot leak its physical alias.
function realBuildPath(path) {
  let ancestor = path
  for (;;) {
    try { return resolve(realpathSync(ancestor), relative(ancestor, path)) }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
      ancestor = dirname(ancestor)
    }
  }
}
const restrictedSourcePathMappings = []
if (distribution.policy) {
  const mappings = new Map()
  for (const [input, destination] of [[process.env.HOME, 'build-home'], [root, 'weapp-container'], [targetDir, 'weapp-container-build']]) {
    if (!input) continue
    const source = resolve(input)
    for (const path of new Set([source, realBuildPath(source)])) {
      if (path.length <= 1 || /[\x00-\x1f\x7f=]/.test(path)) throw new Error('Build path cannot be represented by the fixed source remapping')
      mappings.set(path, destination)
    }
  }
  for (const [source, destination] of mappings) restrictedSourcePathMappings.push({ source, destination })
}
const sourceBefore = profile === 'release' ? captureNativeSource(root) : null
if (sourceBefore) assertCleanNativeSource(sourceBefore)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 ? resolve(args[outIndex + 1]) : null
const requested = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--platform' && args[index + 1]) requested.push(args[index + 1])
}
const platforms = requested.length ? requested : ['android', 'ios', 'harmony']
if (distribution.policy && (platforms.length !== 1 || platforms[0] !== 'harmony')) throw new Error('Restricted native-host producer requires exactly --platform harmony; other targets use sdk-native-build.mjs')
let retainedPolicy
if (distribution.policy) {
  if (!outPath) throw new Error('Restricted Harmony producer requires --out for retained policy provenance')
  retainedPolicy = resolve(dirname(outPath), 'inputs/showcase-policy.json')
  mkdirSync(dirname(retainedPolicy), { recursive: true })
  writeFileSync(retainedPolicy, distribution.canonical)
}
const nativeFont = retainShowcaseNativeFont(loadShowcaseNativeFont({ distributionProfile: distribution.distributionProfile,
  font: option('--showcase-font'), license: option('--showcase-font-license') }), resolve(dirname(outPath || root), 'inputs'))
const engineIndex = args.indexOf('--engine')
const engine = engineIndex < 0 ? 'quickjs' : args[engineIndex + 1]
if (!['quickjs', 'v8'].includes(engine)) throw new Error('ERR_ENGINE: --engine must be quickjs or v8')

const specs = {
  android: {
    crate: 'container-host-android',
    // Match the sample APK's minSdk; a higher compile SDK does not raise the
    // native deployment floor. Explicit overrides apply to Rust and JNI.
    minimumApi: 26,
    feature: 'android,gles,skia-gpu-gles,quickjs-native-android',
    target: 'aarch64-linux-android',
    project: 'examples/hosts/android',
    files: [
      'settings.gradle.kts',
      'build.gradle.kts',
      'app/build.gradle.kts',
      'app/src/main/AndroidManifest.xml',
      'app/src/main/java/com/sonofmagic/weapp/container/MainActivity.kt',
      'app/src/main/java/com/sonofmagic/weapp/container/PortablePack.kt',
      'app/src/main/java/com/sonofmagic/weapp/container/PortablePackSession.kt',
      'app/src/main/java/com/sonofmagic/weapp/container/AndroidWindowObservation.kt',
      'app/src/main/java/com/sonofmagic/weapp/container/GlesSnapshotView.kt',
      'app/src/main/cpp/CMakeLists.txt',
      'app/src/main/cpp/weapp_jni.cpp',
      'app/src/main/cpp/weapp_container_android_ffi.h',
    ],
    ffiSymbols: ['weapp_container_android_host_new', 'weapp_container_android_host_capabilities', 'weapp_container_android_host_load_manifest', 'weapp_container_android_host_load_manifest_with_config', 'weapp_container_android_host_start', 'weapp_container_android_host_dispatch_batch_json', 'weapp_container_android_host_render_snapshot', 'weapp_container_android_host_inspect_state', 'weapp_container_android_host_resize_viewport', 'weapp_container_android_host_update_window_metrics_json', 'weapp_container_android_host_poll_timers', 'weapp_container_android_host_canvas_snapshot', 'weapp_container_android_host_attach_gles_context', 'weapp_container_android_host_render_gles_framebuffer', 'weapp_container_android_host_detach_gles_context'],
    artifact: 'target/aarch64-linux-android/debug/libcontainer_host_android.so',
  },
  ios: {
    crate: 'container-host-ios',
    feature: 'ios,metal,quickjs-native-ios',
    target: 'aarch64-apple-ios-sim',
    project: 'examples/hosts/ios',
    files: [
      'Package.swift',
      'Sources/WeappContainerFFI/include/weapp_container_ios_ffi.h',
      'Sources/WeappContainerHost/Bridge.swift',
      'Sources/WeappContainerHost/PortablePack.swift',
    ],
    ffiSymbols: ['weapp_container_ios_host_new', 'weapp_container_ios_host_capabilities', 'weapp_container_ios_host_load_manifest', 'weapp_container_ios_host_load_manifest_with_config', 'weapp_container_ios_host_start', 'weapp_container_ios_host_dispatch_batch_json', 'weapp_container_ios_host_render_snapshot', 'weapp_container_ios_host_attach_metal_context', 'weapp_container_ios_host_render_metal_texture', 'weapp_container_ios_host_detach_metal_context', 'weapp_container_ios_host_canvas_snapshot', 'weapp_container_ios_host_session_state', 'weapp_container_ios_host_inspect_state', 'weapp_container_ios_host_resize_viewport', 'weapp_container_ios_host_poll_timers', 'weapp_container_ios_host_unload'],
    artifact: 'target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a',
  },
  harmony: {
    crate: 'container-host-harmony',
    // OpenHarmony has no bundled rquickjs bindings. Keep bindgen explicit in
    // the feature so this target check exercises the actual QuickJS provider
    // instead of only compiling the metadata/stub host.
    feature: 'harmony,arkui,skia-gpu-gles,quickjs-native-harmony',
    target: 'aarch64-unknown-linux-ohos',
    project: 'examples/hosts/harmony',
    files: [
      'oh-package.json5',
      'build-profile.json5',
      'hvigorfile.ts',
      'entry/hvigorfile.ts',
      'entry/src/main/module.json5',
      'entry/src/main/ets/entryability/EntryAbility.ets',
      'entry/src/main/ets/Application.ets',
      'entry/src/main/ets/pages/Index.ets',
      'entry/src/main/ets/session/PortablePack.ts',
      'entry/src/main/ets/session/LiveSession.ts',
      'entry/src/main/ets/session/AbilityLifecycle.ts',
      'entry/src/main/resources/rawfile/manifest.json',
      'entry/src/main/cpp/CMakeLists.txt',
      'entry/src/main/cpp/native_bridge.cpp',
      'entry/src/main/cpp/bridge_numbers.h',
      'entry/src/main/cpp/weapp_container_harmony_ffi.h',
    ],
    ffiSymbols: ['weapp_container_harmony_host_new', 'weapp_container_harmony_host_capabilities', 'weapp_container_harmony_host_load_manifest', 'weapp_container_harmony_host_load_manifest_with_config', 'weapp_container_harmony_host_start', 'weapp_container_harmony_host_lifecycle', 'weapp_container_harmony_host_dispatch_batch_json', 'weapp_container_harmony_host_inspect_state', 'weapp_container_harmony_host_resize_viewport', 'weapp_container_harmony_host_poll_timers', 'weapp_container_harmony_host_unload', 'weapp_container_harmony_host_render_snapshot', 'weapp_container_harmony_host_canvas_snapshot', 'weapp_container_harmony_host_attach_gles_context', 'weapp_container_harmony_host_render_gles_framebuffer', 'weapp_container_harmony_host_detach_gles_context'],
    // Host state is scoped to each N-API environment through instance data.
    // Keep the source contract aligned with the bridge implementation so a
    // stale cleanup-hook symbol cannot make an otherwise valid Harmony
    // integration fail its boundary check.
    sourceSymbols: ['Start', 'LoadManifest', 'LoadManifestWithConfig', 'Dispatch', 'DispatchBatch', 'InspectState', 'ResizeViewport', 'PollTimers', 'Lifecycle', 'Unload', 'Snapshot', 'AttachSurface', 'RenderSurface', 'DetachSurfaceApi', 'Destroy', 'napi_get_instance_data', 'napi_set_instance_data', 'OH_NativeWindow_CreateNativeWindowFromSurfaceId', 'eglCreateWindowSurface', 'eglSwapBuffers'],
    artifact: 'target/aarch64-unknown-linux-ohos/debug/libcontainer_host_harmony.so',
  },
}

function run(command, commandArgs, extraEnv = {}) {
  const childEnv = { ...process.env, ...extraEnv }
  delete childEnv.WEAPP_SHOWCASE_POLICY
  delete childEnv.WEAPP_SHOWCASE_FONT
  delete childEnv.WEAPP_SHOWCASE_FONT_LICENSE
  if (nativeFont) Object.assign(childEnv, showcaseNativeFontEnvironment(nativeFont))
  if (distribution.policy) {
    childEnv.WEAPP_SHOWCASE_POLICY = retainedPolicy
    childEnv.CARGO_PROFILE_RELEASE_DEBUG = '0'
    childEnv.CARGO_PROFILE_RELEASE_STRIP = 'debuginfo'
    childEnv.CARGO_ENCODED_RUSTFLAGS = [childEnv.CARGO_ENCODED_RUSTFLAGS, ...restrictedSourcePathMappings.map(({ source, destination }) => `--remap-path-prefix=${source}=${destination}`)].filter(Boolean).join('\x1f')
    childEnv.CC_SHELL_ESCAPED_FLAGS = '1'
    for (const key of ['CFLAGS', 'CXXFLAGS']) childEnv[key] = [childEnv[key], ...restrictedSourcePathMappings.map(({ source, destination }) => JSON.stringify(`-ffile-prefix-map=${source}=${destination}`))].filter(Boolean).join(' ')
  }
  // A null override removes a variable from this child only. Cross builds
  // must not mutate the SDK environment used by subsequent host platforms.
  for (const key of Object.keys(childEnv)) if (childEnv[key] == null) delete childEnv[key]
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: childEnv,
    timeout: 10 * 60 * 1000,
    // Compiler diagnostics are provenance evidence, including their beginning
    // and middle. Bound capture explicitly; ENOBUFS remains an error below.
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    command: [command, ...commandArgs].join(' '),
    status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
    errorCode: result.error?.code || null,
  }
}

function gitRevision(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function gitDirty(args) {
  const result = spawnSync('git', [...args, 'status', '--short'], {
    cwd: root,
    encoding: 'utf8',
  })
  return result.status === 0 ? Boolean(result.stdout.trim()) : null
}

function producerToolIdentity() {
  let source
  try { source = captureNativeSource(toolRoot) }
  catch (error) { source = { sourceCommit: null, sourceDirty: null, sourceError: error.message } }
  return { ...source, files: ['scripts/build-native-hosts.mjs', 'scripts/lib/harmony-skia-build.mjs', 'scripts/lib/sdk-current-release.mjs', 'scripts/lib/sdk-native-features.mjs', 'scripts/lib/showcase-policy.mjs', 'scripts/lib/showcase-native-font.mjs'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(resolve(toolRoot, path))).digest('hex') })) }
}

function validateProject(spec) {
  const missing = spec.files.filter(file => !existsSync(resolve(root, spec.project, file)))
  const headerCandidates = spec.files.filter(file => file.endsWith('.h')).map(file => resolve(root, spec.project, file))
  const headers = headerCandidates.filter(file => existsSync(file)).map(file => readFileSync(file, 'utf8')).join('\n')
  const missingSymbols = spec.ffiSymbols.filter(symbol => !headers.includes(symbol))
  const sourceCandidates = spec.files.filter(file => file.endsWith('.cpp')).map(file => resolve(root, spec.project, file))
  const sources = sourceCandidates.filter(file => existsSync(file)).map(file => readFileSync(file, 'utf8')).join('\n')
  const missingSourceSymbols = (spec.sourceSymbols || []).filter(symbol => !sources.includes(symbol))
  return {
    status: missing.length || missingSymbols.length || missingSourceSymbols.length ? 'failed' : 'passed',
    missing,
    missingSymbols,
    missingSourceSymbols,
  }
}

function findAndroidNdk() {
  const configured = process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT
  if (configured && existsSync(configured)) return configured
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || `${process.env.HOME || ''}/Library/Android/sdk`
  const root = resolve(sdk, 'ndk')
  if (!existsSync(root)) return null
  const versions = readdirSync(root).filter(version => existsSync(resolve(root, version, 'toolchains/llvm/prebuilt'))).sort().reverse()
  return versions.length ? resolve(root, versions[0]) : null
}

function nativeToolchain(name) {
  if (name === 'android') {
    const ndk = findAndroidNdk()
    const configuredApi = process.env.ANDROID_API_LEVEL
    const apiSource = configuredApi === undefined ? 'sample-min-sdk' : 'ANDROID_API_LEVEL'
    const rawApi = configuredApi === undefined ? String(specs.android.minimumApi) : configuredApi
    const validApi = /^[1-9][0-9]*$/.test(rawApi) && Number.isSafeInteger(Number(rawApi))
      && Number(rawApi) >= specs.android.minimumApi
    const apiLevel = validApi ? Number(rawApi) : null
    const base = { env: {}, linker: null, sdk: ndk, apiLevel, apiSource, minimumApi: specs.android.minimumApi }
    if (!validApi) return {
      ...base,
      error: `ANDROID_API_LEVEL must be an integer >= ${specs.android.minimumApi}; received ${JSON.stringify(rawApi)}`,
    }
    if (!ndk) return { ...base, error: 'Android NDK is unavailable; no host compiler fallback is permitted' }
    const prebuilt = resolve(ndk, 'toolchains/llvm/prebuilt')
    const hostCandidates = process.platform === 'win32'
      ? ['windows-x86_64']
      : process.platform === 'linux'
        ? ['linux-x86_64']
        : ['darwin-aarch64', 'darwin-x86_64']
    const hosts = hostCandidates.find(host => existsSync(resolve(prebuilt, host))) || null
    const linker = hosts ? resolve(prebuilt, hosts, 'bin', `aarch64-linux-android${apiLevel}-clang`) : null
    const cxx = linker ? `${linker}++` : null
    const sysroot = hosts ? resolve(prebuilt, hosts, 'sysroot') : null
    if (!linker || !existsSync(linker) || !cxx || !existsSync(cxx)) return {
      ...base,
      error: `Android NDK C/C++ compiler for API ${apiLevel} is unavailable`,
    }
    if (!sysroot || !existsSync(resolve(sysroot, 'usr/lib/aarch64-linux-android', String(apiLevel)))) return {
      ...base,
      error: `Android NDK sysroot libraries for API ${apiLevel} are unavailable`,
    }
    const libclang = [process.env.LIBCLANG_PATH, '/opt/homebrew/opt/llvm/lib', '/usr/local/opt/llvm/lib',
      hosts ? resolve(prebuilt, hosts, 'lib64') : null].filter(Boolean)
      .find(path => ['libclang.dylib', 'libclang.so', 'libclang.so.1', 'libclang.dll'].some(name => existsSync(resolve(path, name))))
    return {
      ...base,
      linker,
      env: {
        // skia-bindings consumes these generic sysroot variables before its
        // Android platform setup. An inherited Xcode/Yocto sysroot would be
        // injected into GN's target flags. Let NDK select its own sysroot;
        // Apple host dependencies can still discover their SDK via xcrun.
        SDKROOT: null,
        SDKTARGETSYSROOT: null,
        CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: linker,
        // skia-bindings compiles C++ locally through cc-rs. Cargo's linker
        // setting does not configure it, so select both NDK drivers.
        CC_aarch64_linux_android: linker,
        CXX_aarch64_linux_android: cxx,
        PATH: `${dirname(linker)}:${process.env.PATH || ''}`,
        // skia-bindings needs ANDROID_NDK when the target binary cache is
        // unavailable and it must build its GLES backend locally.
        ANDROID_NDK: ndk,
        // QuickJS Android bindgen must use the same target and libc ABI.
        ...(libclang ? { LIBCLANG_PATH: libclang } : {}),
        BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android: [
          process.env.BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android,
          // Keep the selected target/sysroot last, so extra include or
          // define flags cannot silently switch QuickJS to another ABI.
          `--target=aarch64-linux-android${apiLevel}`,
          `--sysroot=${JSON.stringify(sysroot)}`,
          `-isystem ${JSON.stringify(resolve(sysroot, 'usr/include/aarch64-linux-android'))}`,
        ].filter(Boolean).join(' '),
      },
    }
  }
  if (name === 'harmony') {
    const skiaBuild = harmonySkiaBuild(process.env)
    if (skiaBuild.error) return {
      linker: null, env: {}, sdk: null, skiaBuild: skiaBuild.report, error: skiaBuild.error,
    }
    const homeCandidates = [
      process.env.HARMONY_HOME,
      process.env.OHOS_NDK_HOME,
      resolve(process.env.HOME || '', 'Library/Huawei/Sdk'),
      resolve(process.env.HOME || '', 'Library/OpenHarmony/Sdk'),
      '/Applications/DevEco-Studio.app/Contents/sdk/default',
    ].filter(Boolean)
    // DevEco Studio 5.x ships two SDK layouts side by side. The OpenHarmony
    // headers/toolchain are commonly under `<sdk>/openharmony`, while the
    // BiSheng compiler used by the native build lives under `<sdk>/hms`.
    // Probe both trees so an installed DevEco SDK is not misreported as an
    // unavailable Harmony toolchain merely because the compiler and CMake
    // files are in different siblings.
    const roots = homeCandidates.flatMap(home => [
      home,
      resolve(home, 'openharmony'),
      resolve(home, 'hms'),
      resolve(home, 'hms', 'openharmony'),
    ])
    const candidates = roots.flatMap(home => [
      resolve(home, 'toolchains/llvm/bin/aarch64-linux-ohos-clang'),
      resolve(home, 'toolchains/llvm/bin/aarch64-unknown-linux-ohos-clang'),
      resolve(home, 'native/llvm/bin/aarch64-linux-ohos-clang'),
      resolve(home, 'native/llvm/bin/aarch64-unknown-linux-ohos-clang'),
      resolve(home, 'native/BiSheng/bin/aarch64-unknown-linux-ohos-clang'),
      resolve(home, 'native/BiSheng/bin/aarch64-linux-ohos-clang'),
    ])
    const linker = candidates.find(candidate => existsSync(candidate)) || null
    // Keep the SDK root in the report even when only the system image is
    // installed. A detected image is not a native build toolchain, so the
    // caller still receives an explicit unavailable integration status.
    const sdk = homeCandidates.find(home => {
      const sdkRoots = [
        home,
        resolve(home, 'openharmony'),
        resolve(home, 'hms'),
        resolve(home, 'hms', 'openharmony'),
      ]
      return sdkRoots.some(root => [
        resolve(root, 'toolchains/llvm/bin/aarch64-linux-ohos-clang'),
        resolve(root, 'toolchains/llvm/bin/aarch64-unknown-linux-ohos-clang'),
        resolve(root, 'native/llvm/bin/aarch64-linux-ohos-clang'),
        resolve(root, 'native/llvm/bin/aarch64-unknown-linux-ohos-clang'),
        resolve(root, 'native/BiSheng/bin/aarch64-unknown-linux-ohos-clang'),
        resolve(root, 'native/BiSheng/bin/aarch64-linux-ohos-clang'),
      ].includes(linker))
    }) || homeCandidates.find(home => existsSync(home)) || null
    if (!linker) return { linker: null, env: skiaBuild.env, sdk, skiaBuild: skiaBuild.report }

    // rquickjs-sys builds QuickJS from C and invokes bindgen for targets that
    // do not have bundled bindings. Cargo's linker setting alone does not
    // configure cc-rs, nor does bindgen infer the OHOS sysroot from the Rust
    // triple (target_os=linux, target_env=ohos). Pass every target tool
    // explicitly so an incomplete SDK fails at this boundary instead of
    // producing a host-ABI QuickJS archive.
    const nativeRoot = [
      sdk,
      resolve(sdk || '', 'openharmony/native'),
      resolve(sdk || '', 'native'),
    ].filter(Boolean).find(candidate => existsSync(resolve(candidate, 'llvm')) || existsSync(resolve(candidate, 'toolchains/llvm'))) || null
    const llvmRoot = nativeRoot && resolve(nativeRoot, 'llvm')
    const sysroot = nativeRoot && resolve(nativeRoot, 'sysroot')
    const targetCompiler = linker
    const targetCxxCandidate = resolve(dirname(linker), 'aarch64-unknown-linux-ohos-clang++')
    const targetCxx = existsSync(targetCxxCandidate)
      ? targetCxxCandidate
      : llvmRoot && resolve(llvmRoot, 'bin/clang++')
    const targetAr = llvmRoot && resolve(llvmRoot, 'bin/llvm-ar')
    const targetRanlib = llvmRoot && resolve(llvmRoot, 'bin/llvm-ranlib')
    const existingBindgenArgs = process.env.BINDGEN_EXTRA_CLANG_ARGS || ''
    const bindgenArgs = [
      '--target=aarch64-unknown-linux-ohos',
      sysroot && existsSync(sysroot) ? `--sysroot=${sysroot}` : null,
      existingBindgenArgs,
    ].filter(Boolean).join(' ')
    // GN/Ninja invokes bare `ar` and `ranlib` while the OpenHarmony SDK only
    // ships llvm-ar/llvm-ranlib. Keep aliases in a generated task directory;
    // explicit AR/RANLIB remain set for cc-rs and Cargo.
    const toolAliasDir = resolve(root, 'target/native-host-toolchain/harmony/bin')
    mkdirSync(toolAliasDir, { recursive: true })
    if (llvmRoot && existsSync(resolve(llvmRoot, 'bin'))) {
      for (const [alias, target] of [['ar', 'llvm-ar'], ['ranlib', 'llvm-ranlib']]) {
        const aliasPath = resolve(toolAliasDir, alias)
        try {
          rmSync(aliasPath, { force: true })
          symlinkSync(resolve(llvmRoot, 'bin', target), aliasPath)
        } catch {
          // Read-only workspaces still get explicit AR/RANLIB below.
        }
      }
    }
    const env = {
      ...skiaBuild.env,
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER: linker,
      CC_aarch64_unknown_linux_ohos: targetCompiler,
      CXX_aarch64_unknown_linux_ohos: targetCxx && existsSync(targetCxx) ? targetCxx : undefined,
      AR_aarch64_unknown_linux_ohos: targetAr && existsSync(targetAr) ? targetAr : undefined,
      RANLIB_aarch64_unknown_linux_ohos: targetRanlib && existsSync(targetRanlib) ? targetRanlib : undefined,
      // QuickJS/skia build scripts also compile host-side helper programs.
      // Keep those C/C++ invocations on the macOS ABI instead of leaking the
      // OHOS compiler into the rustup host target.
      CC_aarch64_apple_darwin: process.env.HOST_CC || process.env.CC || 'cc',
      CXX_aarch64_apple_darwin: process.env.HOST_CXX || process.env.CXX || 'c++',
      HOST_CC: process.env.HOST_CC || process.env.CC || 'cc',
      HOST_CXX: process.env.HOST_CXX || process.env.CXX || 'c++',
      // GN's generated toolchain invokes `ar` by name rather than reading
      // Cargo's target-specific AR variable. LLVM ar accepts both OHOS and
      // host object formats, so expose it for that nested build as well.
      AR: targetAr && existsSync(targetAr) ? targetAr : undefined,
      BINDGEN_EXTRA_CLANG_ARGS: bindgenArgs,
      ohos_sdk_native: nativeRoot || undefined,
      OHOS_NDK_HOME: sdk || undefined,
      SDKTARGETSYSROOT: sysroot && existsSync(sysroot) ? sysroot : undefined,
      CLANGCC: targetCompiler,
      CLANGCXX: targetCxx && existsSync(targetCxx) ? targetCxx : undefined,
      // skia-bindings invokes a bare `clang` while compiling its generated
      // target sources. The SDK clang driver supplies the OHOS sysroot when
      // selected from this directory; target-specific CC/CXX above still
      // keeps ordinary cc-rs calls explicit.
      PATH: llvmRoot && existsSync(resolve(llvmRoot, 'bin'))
        ? `${toolAliasDir}:${resolve(llvmRoot, 'bin')}:${process.env.PATH || ''}`
        : process.env.PATH || '',
    }
    // Do not prepend the OHOS clang directory globally: rquickjs-sys also
    // compiles a host build-script dependency and must keep the host C ABI.
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
    return { linker, env, sdk, skiaBuild: skiaBuild.report }
  }
  return { env: {}, linker: null }
}

function buildProjectIntegration(name, spec, toolchain, artifactPath) {
  if (mode !== 'build') return { status: 'not-run', reason: 'check mode' }
  if (name === 'android' && toolchain.sdk) {
    const cmakeBuild = resolve(root, 'target/native-host-integration/android')
    const cmakeToolchain = resolve(toolchain.sdk, 'build/cmake/android.toolchain.cmake')
    const configureArgs = [
      '-S', resolve(root, spec.project, 'app/src/main/cpp'),
      '-B', cmakeBuild,
      '-G', 'Ninja',
      `-DCMAKE_TOOLCHAIN_FILE=${cmakeToolchain}`,
      '-DANDROID_ABI=arm64-v8a',
      `-DANDROID_PLATFORM=android-${toolchain.apiLevel}`,
      `-DWEAPP_CONTAINER_ANDROID_RUST_LIB=${artifactPath}`,
    ]
    let configure = run('cmake', configureArgs, toolchain.env)
    let recovery = null
    // CMake/Ninja can leave a stale recompaction database in a generated
    // build directory after an interrupted process or a toolchain update.
    // The Rust artifact and source tree are still valid in that case. Retry
    // once from a clean generated directory, while preserving the first
    // failure in the report so recovery is auditable and never hidden.
    if (configure.status !== 'passed' && /failed recompaction|ninja: error:.*No such file or directory/i.test(`${configure.stdout}\n${configure.stderr}`)) {
      rmSync(cmakeBuild, { recursive: true, force: true })
      recovery = {
        action: 'remove-stale-cmake-build-and-reconfigure',
        initialConfigure: configure,
      }
      configure = run('cmake', configureArgs, toolchain.env)
      recovery.retryConfigure = configure
    }
    if (configure.status !== 'passed') return { status: 'failed', configure, recovery }
    const build = run('cmake', ['--build', cmakeBuild], toolchain.env)
    return { status: build.status, configure, build, recovery }
  }
  if (name === 'ios') {
    // The default SwiftPM host product is intentionally library-only.  The
    // optional simulator executable links the Rust staticlib and therefore
    // needs an explicit iOS simulator triple plus WEAPP_CONTAINER_IOS_RUST_LIB; building
    // it on the macOS host would otherwise produce misleading undefined
    // symbol failures.  Keep this integration gate deterministic and leave
    // the simulator smoke command explicit in the iOS host README.
    const swift = run('swift', [
      'build',
      '--package-path',
      resolve(root, spec.project),
      '--product',
      'WeappContainerHost',
    ])
    return { status: swift.status, swift, product: 'WeappContainerHost' }
  }
  if (name === 'harmony' && toolchain.linker && toolchain.sdk) {
    const nativeRoots = [
      resolve(toolchain.sdk, 'openharmony/native'),
      resolve(toolchain.sdk, 'native'),
    ]
    const nativeRoot = nativeRoots.find(candidate => existsSync(candidate))
    const cmakeToolchain = nativeRoot && resolve(nativeRoot, 'build/cmake/ohos.toolchain.cmake')
    const cmakeBin = nativeRoot && resolve(nativeRoot, 'build-tools/cmake/bin/cmake')
    if (!nativeRoot || !cmakeToolchain || !existsSync(cmakeToolchain)) {
      return {
        status: 'not-run',
        reason: 'OpenHarmony native CMake toolchain is missing from the detected SDK',
      }
    }
    const cmakeBuild = resolve(root, 'target/native-host-integration/harmony')
    const configure = run(existsSync(cmakeBin) ? cmakeBin : 'cmake', [
      '-S', resolve(root, spec.project, 'entry/src/main/cpp'),
      '-B', cmakeBuild,
      '-G', 'Ninja',
      `-DCMAKE_TOOLCHAIN_FILE=${cmakeToolchain}`,
      '-DOHOS_ARCH=arm64-v8a',
      ...(distribution.policy ? ['-DCMAKE_BUILD_TYPE=Release', '-DWEAPP_CONTAINER_RESTRICTED_SHOWCASE=ON', `-DCMAKE_CXX_FLAGS=-ffile-prefix-map=${root}=weapp-container`] : []),
      `-DWEAPP_CONTAINER_HARMONY_RUST_LIB=${artifactPath}`,
    ])
    if (configure.status !== 'passed') return { status: 'failed', configure }
    const build = run(existsSync(cmakeBin) ? cmakeBin : 'cmake', ['--build', cmakeBuild])
    return { status: build.status, configure, build }
  }
  return {
    status: 'not-run',
    reason: name === 'harmony' ? 'DevEco/Harmony SDK and OpenHarmony native CMake toolchain are required for N-API packaging' : 'platform SDK unavailable',
  }
}

function verifyRestrictedHarmonyLibrary(path, toolchain) {
  const inspector = [resolve(toolchain.sdk, 'openharmony/native/llvm/bin/llvm-readelf'), resolve(toolchain.sdk, 'native/llvm/bin/llvm-readelf')].find(existsSync)
  if (!inspector) throw new Error('Restricted Harmony output requires the official LLVM section inspector')
  const checked = run(inspector, ['--sections', path])
  if (checked.status !== 'passed' || /\.(?:z?debug[_\.]|gnu_debuglink)/.test(checked.stdout)) throw new Error('Restricted Harmony library still contains debug sections or cannot be inspected')
  const bytes = readFileSync(path)
  for (const { source } of restrictedSourcePathMappings) {
    for (const prefix of new Set([source, source.replaceAll('\\', '/'), source.replaceAll('/', '\\')])) {
      if (bytes.includes(Buffer.from(prefix))) throw new Error('Restricted Harmony library still contains a local build path')
    }
  }
  return { debugInfo: false, localBuildPaths: false, sourcePrefixesChecked: restrictedSourcePathMappings.length, inspectorSha256: createHash('sha256').update(readFileSync(inspector)).digest('hex') }
}

function runPlatform(name) {
  const spec = specs[name]
  if (!spec) return { platform: name, status: 'failed', error: `unknown platform ${name}` }
  const project = validateProject(spec)
  const toolchain = nativeToolchain(name)
  const engineFeatures = engine === 'quickjs' ? spec.feature
    : spec.feature.split(',').filter(feature => !feature.startsWith('quickjs-native')).concat('v8-native').join(',')
  const features = engineFeatures + (distribution.policy ? ',restricted-showcase' : '')
  const cargo = toolchain.error
    ? { status: 'not-run', reason: toolchain.error }
    : run(cargoBin, [mode === 'build' ? 'build' : 'check', '-p', spec.crate, '--no-default-features', '--features', features, '--target', spec.target, '--target-dir', targetDir, '--locked', ...(profile === 'release' ? ['--release'] : [])], { ...cargoEnv, ...toolchain.env })
  const artifactFile = (profile === 'release' ? spec.artifact.replace('/debug/', '/release/') : spec.artifact).replace(/^target\//, '')
  const artifactPath = resolve(targetDir, artifactFile)
  const artifactBytes = mode === 'build' && cargo.status === 'passed' && existsSync(artifactPath) ? readFileSync(artifactPath) : null
  const compiledIdentity = artifactBytes && distribution.policy ? verifyDistributionArtifact(artifactBytes, distribution) : null
  const compiledNativeFont = artifactBytes && nativeFont ? verifyShowcaseNativeFontArtifact(artifactBytes, nativeFont) : null
  const artifact = mode === 'build' ? { path: artifactPath, exists: existsSync(artifactPath), ...(artifactBytes ? { bytes: artifactBytes.length, sha256: createHash('sha256').update(artifactBytes).digest('hex'), ...(distribution.policy ? { hardening: verifyRestrictedHarmonyLibrary(artifactPath, toolchain) } : {}) } : {}) } : null
  const appIntegration = cargo.status === 'passed'
    ? buildProjectIntegration(name, spec, toolchain, artifactPath)
    : { status: 'not-run', reason: 'requested Rust engine/target did not build; previous native artifacts were not used' }
  if (distribution.policy && appIntegration.status === 'passed') {
    appIntegration.artifacts = ['libentry.so', 'libcontainer_host_harmony.so'].map(name => {
      const path = `target/native-host-integration/harmony/${name}`, bytes = readFileSync(resolve(root, path))
      if (name === 'libcontainer_host_harmony.so' && !bytes.equals(artifactBytes)) throw new Error('N-API integration changed the restricted Rust library')
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), hardening: verifyRestrictedHarmonyLibrary(resolve(root, path), toolchain) }
    })
  }
  const status = project.status === 'passed' && cargo.status === 'passed' && (!artifact || artifact.exists)
    && !['failed', 'error'].includes(appIntegration.status) ? 'passed' : 'failed'
  return {
    platform: name,
    target: spec.target,
    engine,
    features,
    mode,
    profile,
    distributionProfile: distribution.distributionProfile,
    policySha256: distribution.policySha256,
    ...(compiledIdentity ? { compiledIdentity } : {}),
    ...(compiledNativeFont ? { nativeFont: compiledNativeFont } : {}),
    status,
    project,
    toolchain: {
      sdk: toolchain.sdk || null,
      linker: toolchain.linker,
      ...(name === 'harmony' ? { skia: toolchain.skiaBuild, error: toolchain.error || null } : {}),
      ...(name === 'android' ? {
        apiLevel: toolchain.apiLevel,
        apiSource: toolchain.apiSource,
        sampleMinSdk: toolchain.minimumApi,
        // Locked skia-bindings 0.153.3 keeps its internal ndk_api at 26;
        // ANDROID_API_LEVEL selects Rust/QuickJS/JNI, not Skia internals.
        skiaMinimumApi: 26,
        skiaApiSource: 'skia-bindings-0.153.3-pinned-default',
        ignoredSdkEnvironment: ['SDKROOT', 'SDKTARGETSYSROOT'].filter(key => process.env[key] !== undefined),
        compatibility: 'not-verified',
        error: toolchain.error || null,
      } : {}),
    },
    cargo,
    artifact,
    appIntegration,
  }
}

const report = {
  schemaVersion: 1,
  sdkVersion: SDK_RELEASE_VERSION,
  profile,
  distributionProfile: distribution.distributionProfile,
  policySha256: distribution.policySha256,
  ...(distribution.policy ? { distributionPolicy: { ...distribution.policyInput, retainedPath: retainedPolicy }, buildHardening: { debugInfo: false, strip: 'debuginfo', pathsRemapped: true, sourcePathMappings: restrictedSourcePathMappings } } : {}),
  ...(nativeFont ? { nativeFontInput: nativeFont } : {}),
  targetDir,
  sourceBefore,
  producerTool: producerToolIdentity(),
  generatedAt: new Date().toISOString(),
  mode,
  engine,
  scope: 'native-host-integration-boundary',
  // Native checks are frequently run on a host with generated artifacts that
  // outlive the source checkout. Record the exact source and vendor revisions
  // so a report can be rejected as stale instead of being mistaken for
  // current-head evidence. The vendor tree may intentionally be dirty while
  // preserving the checked-out commit; that state is recorded separately.
  commit: gitRevision(['rev-parse', 'HEAD']),
  vendor: {
    weappViteCommit: gitRevision(['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD']),
    weappViteDirty: gitDirty(['-C', 'vendor/weapp-vite']),
  },
  platforms: platforms.map(runPlatform),
  notes: [
    'check validates each platform project and runs cargo check for the pinned Rust target.',
    'build emits a Rust cdylib/staticlib consumed by the platform project; SDK packaging and signing remain explicit host steps.',
    'A passed entry is not Android, iOS or Harmony emulator/device conformance evidence.',
  ],
}
if (sourceBefore) {
  report.sourceAfter = captureNativeSource(root)
  try { assertCleanNativeSource(report.sourceAfter, sourceBefore) }
  catch (error) { report.sourceError = error.message; process.exitCode = 1 }
}
verifyDistributionInput(distribution)
verifyShowcaseNativeFont(nativeFont)
if (distribution.policy && createHash('sha256').update(readFileSync(retainedPolicy)).digest('hex') !== distribution.policySha256) throw new Error('Retained showcase policy changed during compilation')
const output = `${JSON.stringify(report, null, 2)}\n`
process.stdout.write(output)
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, output, 'utf8')
}
if (report.platforms.some(platform => platform.status !== 'passed')) process.exitCode = 1
