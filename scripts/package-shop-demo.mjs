#!/usr/bin/env node

/**
 * Build one portable shop pack and fan it out to the host packaging inputs.
 * Platform entries deliberately keep toolchain availability separate from
 * compiler failures so a local machine can still produce a useful report.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncPortablePack } from './portable-pack.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const APP = resolve(ROOT, 'examples/apps/shop-demo')
const DEFAULT_OUT = resolve(ROOT, 'artifacts/shop-demo')
const ALL_PLATFORMS = ['web-wasm', 'desktop', 'android', 'ios-simulator', 'harmony']

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const exists = async path => { try { await access(path); return true } catch { return false } }

function parseArgs(args) {
  const options = { out: DEFAULT_OUT, compilerCommit: 'unknown', platforms: [...ALL_PLATFORMS] }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--out' || argument === '--compiler-commit' || argument === '--platform') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      if (argument === '--out') options.out = resolve(ROOT, value)
      else if (argument === '--compiler-commit') options.compilerCommit = value
      else {
        if (!ALL_PLATFORMS.includes(value)) throw new Error(`unknown platform: ${value}`)
        if (options.platforms.length === ALL_PLATFORMS.length) options.platforms = []
        options.platforms.push(value)
      }
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function commandPath(command) {
  if (command.includes('/')) return command
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

async function firstExisting(paths) {
  for (const path of paths) if (path && await exists(path)) return path
  return null
}

function runCommand(command, args, { cwd = ROOT, env = {}, timeout = 15 * 60 * 1000 } = {}) {
  const startedAt = new Date().toISOString()
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  })
  return {
    command: [command, ...args].join(' '), cwd, startedAt, endedAt: new Date().toISOString(),
    status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: (result.stdout || '').slice(-128 * 1024),
    stderr: (result.stderr || '').slice(-128 * 1024),
  }
}

function platformResult(platform, status, details = {}) {
  return { platform, status, evidenceBoundary: 'packaging/build boundary only; runtime, device and GPU claims remain separate', ...details }
}

async function writeReport(path, report) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, json(report))
}

async function packagePack(source, destination) {
  return syncPortablePack({ source, destination })
}

async function packageWebWasm(pack, platformDir) {
  const llvmBin = process.env.WEAPP_CONTAINER_LLVM_BIN
    || commandPath('llvm-config')?.replace(/\/llvm-config$/, '')
    || await firstExisting(['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin'])
  const wasmBindgen = process.env.WEAPP_CONTAINER_WASM_BINDGEN
    || commandPath('wasm-bindgen')
    || await firstExisting([resolve(homedir(), '.cargo/bin/wasm-bindgen')])
  const missingTools = []
  if (!wasmBindgen) missingTools.push('wasm-bindgen')
  if (!llvmBin || !await exists(join(llvmBin, 'clang')) || !await exists(join(llvmBin, 'llvm-ar'))) missingTools.push('LLVM clang + llvm-ar')
  const result = platformResult('web-wasm', 'blocked', { renderer: 'software', execution: 'worker', missingTools })
  if (missingTools.length) return result
  const site = resolve(platformDir, 'site')
  const command = runCommand(process.execPath, [resolve(ROOT, 'scripts/build-web-wasm.mjs'), '--execution', 'worker', '--renderer', 'software', '--pack', pack, '--out-dir', site, '--wasm-bindgen', wasmBindgen, '--llvm-bin', llvmBin])
  result.command = command
  result.status = command.status === 'passed' ? 'passed' : 'failed'
  result.artifact = site
  return result
}

async function packageDesktop(pack, platformDir) {
  const cargo = commandPath('cargo')
  if (!cargo) return platformResult('desktop', 'blocked', { missingTools: ['cargo'] })
  const lockfile = resolve(ROOT, 'examples/hosts/conformance-desktop/Cargo.lock')
  const lock = runCommand(cargo, ['generate-lockfile', '--manifest-path', resolve(ROOT, 'examples/hosts/conformance-desktop/Cargo.toml'), '--offline'])
  if (lock.status !== 'passed') return platformResult('desktop', 'blocked', { missingTools: ['offline Cargo registry cache for the restored desktop host'], lock })
  const buildDir = resolve(platformDir, 'build')
  const command = runCommand(process.execPath, [resolve(ROOT, 'examples/hosts/conformance-desktop/build.mjs'), '--engine', 'quickjs', '--host', 'macos', '--out', buildDir, '--diagnostic'])
  const result = platformResult('desktop', command.status === 'passed' ? 'passed' : 'failed', { lock, lockfile, command })
  if (command.status !== 'passed') return result
  const binary = resolve(buildDir, 'weapp-conformance-desktop')
  if (!await exists(binary)) return platformResult('desktop', 'failed', { command, error: 'desktop build did not produce a binary' })
  const archive = resolve(platformDir, 'morrow-supply-desktop.tar.gz')
  const tar = runCommand('tar', ['-czf', archive, '-C', buildDir, 'weapp-conformance-desktop', '-C', pack, '.'])
  result.archive = archive
  result.archiveSha256 = tar.status === 'passed' ? sha256(await readFile(archive)) : null
  result.tar = tar
  if (tar.status !== 'passed') result.status = 'failed'
  return result
}

async function packageAndroid(pack, platformDir) {
  const gradle = commandPath('gradle') || (await exists(resolve(ROOT, 'examples/hosts/android/gradlew')) ? resolve(ROOT, 'examples/hosts/android/gradlew') : null)
  if (!gradle) return platformResult('android', 'blocked', { missingTools: ['Gradle or examples/hosts/android/gradlew'] })
  const nativeDir = resolve(platformDir, 'native')
  const nativeCommand = runCommand(process.execPath, [resolve(ROOT, 'scripts/build-native-hosts.mjs'), '--build', '--platform', 'android', '--out', nativeDir])
  if (nativeCommand.status !== 'passed') return platformResult('android', 'failed', { nativeCommand })
  const rustLib = resolve(ROOT, 'target/aarch64-linux-android/debug/libcontainer_host_android.so')
  if (!await exists(rustLib)) return platformResult('android', 'failed', { nativeCommand, error: `missing Rust library: ${rustLib}` })
  const project = resolve(platformDir, 'project')
  await cp(resolve(ROOT, 'examples/hosts/android'), project, { recursive: true, filter: source => !['.gradle', 'build', 'local.properties'].includes(source.split('/').at(-1)) })
  await packagePack(pack, resolve(project, 'app/src/main/assets/portable-pack'))
  const androidSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    || resolve(homedir(), 'Library/Android/sdk')
  const gradleCommand = runCommand(gradle, [':app:assembleDebug', '--no-daemon', `-PweappContainerAndroidRustLib=${rustLib}`], {
    cwd: project,
    env: await exists(androidSdk) ? { ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk } : {},
  })
  const apk = resolve(project, 'app/build/outputs/apk/debug/app-debug.apk')
  const result = platformResult('android', gradleCommand.status === 'passed' && await exists(apk) ? 'passed' : 'failed', { nativeCommand, gradleCommand, apk })
  if (result.status === 'passed') result.apkSha256 = sha256(await readFile(apk))
  return result
}

async function packageIOS(pack, platformDir) {
  if (!commandPath('xcrun') || !commandPath('swiftc')) return platformResult('ios-simulator', 'blocked', { missingTools: ['xcrun + swiftc'] })
  const outDir = resolve(platformDir, 'app')
  const command = runCommand(resolve(ROOT, 'scripts/ios-app-smoke'), [], {
    env: {
      WEAPP_CONTAINER_IOS_BUILD_ONLY: '1',
      WEAPP_CONTAINER_IOS_PACK: pack,
      WEAPP_CONTAINER_IOS_APP_OUT_DIR: outDir,
      WEAPP_CONTAINER_IOS_APP_MODE: 'embedding',
    },
  })
  return platformResult('ios-simulator', command.status === 'passed' ? 'passed' : 'failed', {
    command,
    artifactKind: 'simulator-app-build-only',
    physicalDevice: 'unknown',
    certificate: 'ad-hoc simulator signing only',
  })
}

async function packageHarmony(pack, platformDir) {
  const sdk = process.env.OHOS_SDK || '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony'
  const hvigor = process.env.HVIGOR || '/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw'
  if (!await exists(sdk) || !await exists(hvigor)) return platformResult('harmony', 'blocked', { missingTools: ['OpenHarmony SDK', 'Hvigor'] })
  const nativeDir = resolve(platformDir, 'native')
  const nativeCommand = runCommand(process.execPath, [resolve(ROOT, 'scripts/build-native-hosts.mjs'), '--build', '--platform', 'harmony', '--out', nativeDir])
  if (nativeCommand.status !== 'passed') return platformResult('harmony', 'failed', { nativeCommand })
  const rustLib = resolve(ROOT, 'target/aarch64-unknown-linux-ohos/debug/libcontainer_host_harmony.so')
  if (!await exists(rustLib)) return platformResult('harmony', 'failed', { nativeCommand, error: `missing Rust library: ${rustLib}` })
  const hapDir = resolve(platformDir, 'hap')
  const command = runCommand(process.execPath, [resolve(ROOT, 'scripts/build-harmony-hap.mjs'), '--out', hapDir, '--pack', pack, '--bundle', 'com.morrow.supply.demo', '--sdk', sdk, '--hvigor', hvigor, '--rust-lib', rustLib])
  return platformResult('harmony', command.status === 'passed' ? 'passed' : 'failed', { nativeCommand, command, artifactKind: 'unsigned-hap' })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/package-shop-demo.mjs [--out DIR] [--compiler-commit SHA] [--platform web-wasm|desktop|android|ios-simulator|harmony]')
    return
  }
  const out = resolve(options.out)
  const pack = resolve(out, 'pack')
  await mkdir(out, { recursive: true })
  for (const name of ['pack', 'platforms', 'package-report.json']) await rm(resolve(out, name), { recursive: true, force: true })
  await mkdir(resolve(out, 'platforms'), { recursive: true })
  const packCommand = runCommand(process.execPath, [resolve(ROOT, 'tools/container-manifest/bin/container-pack.mjs'), APP, '--out', pack, '--project', APP, '--compiler-commit', options.compilerCommit])
  if (packCommand.status !== 'passed') {
    const report = { schemaVersion: 1, status: 'failed', generatedAt: new Date().toISOString(), app: APP, out, pack, packCommand, platforms: [] }
    await writeReport(resolve(out, 'package-report.json'), report)
    process.exitCode = 1
    return
  }
  const manifestBytes = await readFile(resolve(pack, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const integrity = await syncPortablePack({ source: pack, destination: resolve(out, 'pack-validated') })
  await rm(resolve(out, 'pack-validated'), { recursive: true, force: true })
  const platforms = []
  for (const platform of options.platforms) {
    const platformDir = resolve(out, 'platforms', platform)
    await mkdir(platformDir, { recursive: true })
    const platformPack = resolve(platformDir, 'portable-pack')
    await packagePack(pack, platformPack)
    let result
    if (platform === 'web-wasm') result = await packageWebWasm(pack, platformDir)
    else if (platform === 'desktop') result = await packageDesktop(pack, platformDir)
    else if (platform === 'android') result = await packageAndroid(pack, platformDir)
    else if (platform === 'ios-simulator') result = await packageIOS(pack, platformDir)
    else result = await packageHarmony(pack, platformDir)
    result.pack = platformPack
    result.manifestSha256 = sha256(manifestBytes)
    result.integrityRoot = manifest.integrity.root
    platforms.push(result)
    await writeReport(resolve(platformDir, 'platform-report.json'), result)
  }
  const report = {
    schemaVersion: 1,
    status: 'passed',
    generatedAt: new Date().toISOString(),
    app: APP,
    out,
    pack,
    manifest: { schemaVersion: manifest.schemaVersion, routes: manifest.routes, sha256: sha256(manifestBytes), integrityRoot: manifest.integrity.root, blobCount: integrity.blobCount },
    packCommand,
    platforms,
    limitations: ['Browser behavior is validated separately by demo:shop:browser.', 'A blocked native platform is an unavailable local toolchain, not a runtime failure.', 'No physical iOS device or production signing claim is made.'],
  }
  if (platforms.some(item => item.status === 'failed')) report.status = 'failed'
  await writeReport(resolve(out, 'package-report.json'), report)
  console.log(JSON.stringify({ status: report.status, report: resolve(out, 'package-report.json'), platforms: platforms.map(item => ({ platform: item.platform, status: item.status })) }, null, 2))
  if (report.status === 'failed') process.exitCode = 1
}

try { await main() } catch (error) {
  console.error(error.stack || error)
  process.exitCode = 1
}
