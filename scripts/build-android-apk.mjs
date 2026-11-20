#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { sourceInventorySha256 } from './lib/android-apk-build-receipt.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const hashPattern = /^[0-9a-f]{64}$/

function option(name, fallback = null) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf(name) !== index) {
    throw new Error(`${name} requires one value`)
  }
  return args[index + 1]
}

function help() {
  process.stdout.write('Usage: node scripts/build-android-apk.mjs --out-dir <external-path> [--engine quickjs|v8]\n')
}

if (args.includes('--help') || args.includes('-h')) {
  help()
  process.exit(0)
}

const engine = option('--engine', 'quickjs')
if (!['quickjs', 'v8'].includes(engine)) throw new Error('--engine must be quickjs or v8')
const outDirArg = option('--out-dir')
if (!outDirArg) throw new Error('--out-dir is required')
const outDir = resolve(outDirArg)
if (outDir === root || outDir.startsWith(`${root}${sep}`)) throw new Error('--out-dir must be outside the checkout')
const nativeReceiptPath = resolve(outDir, 'android-native-build.json')
const apkPath = resolve(outDir, 'app-debug.apk')
const reportPath = resolve(outDir, 'android-apk-build.json')
let stageRoot = null

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function sourceState() {
  return {
    sourceCommit: git(['rev-parse', 'HEAD']),
    workingTreeDirty: Boolean(git(['status', '--short'])),
  }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function sourceInputs() {
  const androidFiles = git(['ls-files', '--', 'examples/hosts/android']).split(/\r?\n/).filter(Boolean)
  const supportFiles = [
    'scripts/build-android-apk.mjs',
    'scripts/lib/android-apk-build-receipt.mjs',
    'scripts/mobile-runtime-smoke.mjs',
    'scripts/lib/mobile-smoke-checks.mjs',
    'scripts/pack-execution-evidence.mjs',
  ]
  const paths = [...new Set([...androidFiles, ...supportFiles])].sort()
  return paths.map(path => {
    const absolute = resolve(root, path)
    const stat = lstatSync(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Android build input is not a regular file: ${path}`)
    return { path, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') }
  })
}

function findAndroidSdk() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    resolve(process.env.HOME || '', 'Library/Android/sdk')].filter(Boolean)
  return candidates.find(path => existsSync(resolve(path, 'platform-tools/adb'))) || null
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    env: options.env || process.env,
    shell: options.shell || false,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs || 10 * 60 * 1000,
  })
  return {
    command: [command, ...commandArgs].join(' '),
    status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : null,
  }
}

function stageAndroidProject() {
  const tracked = git(['ls-files', '-z', '--', 'examples/hosts/android']).split('\0').filter(Boolean)
  for (const path of tracked) {
    const source = resolve(root, path)
    const stat = lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Android project input is not a regular file: ${path}`)
    const destination = resolve(stageRoot, relative(root, source))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  return resolve(stageRoot, 'examples/hosts/android')
}

function hashArchiveEntry(archive, entry) {
  return new Promise(resolveEntry => {
    const child = spawn('unzip', ['-p', archive, entry], { stdio: ['ignore', 'pipe', 'pipe'] })
    const hash = createHash('sha256')
    let bytes = 0
    let stderr = ''
    child.stdout.on('data', chunk => { hash.update(chunk); bytes += chunk.length })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => resolveEntry({ status: 'error', bytes, sha256: null, error: error.message }))
    child.on('close', code => resolveEntry({
      status: code === 0 ? 'passed' : 'failed',
      bytes,
      sha256: code === 0 ? hash.digest('hex') : null,
      error: code === 0 ? null : stderr.trim() || `unzip exited with ${code}`,
    }))
  })
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  stageRoot = mkdtempSync(join(tmpdir(), 'weapp-container-android-'))
  const before = sourceState()
  const sourceFilesBefore = sourceInputs()
  const report = {
    schemaVersion: 1,
    scope: 'android-apk-build',
    generatedAt: new Date().toISOString(),
    host: 'android',
    engine,
    variant: 'debug',
    abi: 'arm64-v8a',
    sourceCommit: before.sourceCommit,
    workingTreeDirty: before.workingTreeDirty,
    sourceFiles: sourceFilesBefore,
    sourceInventorySha256: sourceInventorySha256(sourceFilesBefore),
    native: { status: 'not-run' },
    gradle: { status: 'not-run', variant: 'debug' },
    package: { status: 'not-run', abi: 'arm64-v8a' },
    apk: { path: apkPath, sha256: null, bytes: null },
    errors: [],
  }

  try {
    if (before.workingTreeDirty) throw new Error('Android APK build requires a clean Git working tree')
    const sdk = findAndroidSdk()
    if (!sdk) throw new Error('Android SDK is unavailable; set ANDROID_HOME or ANDROID_SDK_ROOT')

    const nativeRun = run(process.execPath, [
      'scripts/build-native-hosts.mjs', '--build', '--platform', 'android', '--engine', engine,
      '--profile', 'dev', '--out', nativeReceiptPath,
    ])
    if (nativeRun.status !== 'passed' || !existsSync(nativeReceiptPath)) {
      report.errors.push(`Android native host build ${nativeRun.status}: ${nativeRun.error || nativeRun.stderr.trim()}`)
      report.native = { status: 'failed', command: nativeRun.command, exitCode: nativeRun.exitCode }
      return finish(report, sourceFilesBefore)
    }
    const nativeReceiptBytes = readFileSync(nativeReceiptPath)
    const nativeReceipt = JSON.parse(nativeReceiptBytes.toString('utf8'))
    const platform = nativeReceipt.platforms?.find(value => value.platform === 'android')
    const nativeArtifact = platform?.artifact
    report.native = {
      status: platform?.status === 'passed' ? 'passed' : 'failed',
      sourceCommit: nativeReceipt.producerTool?.sourceCommit || nativeReceipt.commit || null,
      workingTreeDirty: nativeReceipt.producerTool?.sourceDirty ?? null,
      host: platform?.platform || 'android',
      engine: platform?.engine || nativeReceipt.engine || null,
      abi: platform?.toolchain?.abi || null,
      target: platform?.target || null,
      artifactPath: nativeArtifact?.path || null,
      artifactSha256: nativeArtifact?.sha256 || null,
      artifactBytes: nativeArtifact?.bytes || null,
      buildReceiptSha256: createHash('sha256').update(nativeReceiptBytes).digest('hex'),
    }
    if (report.native.status !== 'passed' || report.native.sourceCommit !== before.sourceCommit
      || report.native.workingTreeDirty !== false || report.native.engine !== engine
      || report.native.abi !== 'arm64-v8a' || !nativeArtifact?.exists || !hashPattern.test(nativeArtifact.sha256 || '')) {
      report.errors.push('Android native receipt does not match the selected clean source, engine and ABI')
      return finish(report, sourceFilesBefore)
    }

    const stagedProject = stageAndroidProject()
    const gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
    const gradleOptions = {
      cwd: stagedProject,
      env: { ...process.env, ANDROID_HOME: sdk },
      shell: process.platform === 'win32',
    }
    const gradleVersion = run(gradleCommand, ['--version'], gradleOptions)
    const gradleRun = run(gradleCommand, [
      '--no-daemon', ':app:assembleDebug',
      `-PweappContainerAndroidRustLibArm64=${nativeArtifact.path}`,
    ], gradleOptions)
    report.gradle = {
      status: gradleRun.status,
      variant: 'debug',
      version: gradleVersion.stdout.match(/Gradle\s+(\S+)/)?.[1] || null,
      command: gradleRun.command,
      exitCode: gradleRun.exitCode,
      stdoutTail: gradleRun.stdout.slice(-3000),
      stderrTail: gradleRun.stderr.slice(-3000),
    }
    if (gradleRun.status !== 'passed') {
      report.errors.push(`isolated Gradle build ${gradleRun.status}: ${gradleRun.error || gradleRun.stderr.trim()}`)
      return finish(report, sourceFilesBefore)
    }

    const builtApk = resolve(stagedProject, 'app/build/outputs/apk/debug/app-debug.apk')
    if (!existsSync(builtApk)) {
      report.errors.push('Gradle completed without producing app-debug.apk')
      return finish(report, sourceFilesBefore)
    }
    const mergedNativePath = resolve(stagedProject,
      'app/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/arm64-v8a/libcontainer_host_android.so')
    const strippedNativePath = resolve(stagedProject,
      'app/build/intermediates/stripped_native_libs/debug/stripDebugDebugSymbols/out/lib/arm64-v8a/libcontainer_host_android.so')
    const mergedNative = existsSync(mergedNativePath) ? await hashFile(mergedNativePath) : null
    const strippedNative = existsSync(strippedNativePath) ? await hashFile(strippedNativePath) : null
    report.gradle.nativeInputArtifactSha256 = mergedNative
    report.gradle.strippedNativeArtifactSha256 = strippedNative
    if (mergedNative !== nativeArtifact.sha256 || !hashPattern.test(strippedNative || '')) {
      report.errors.push('Gradle did not preserve the exact Rust artifact before Android symbol stripping')
      return finish(report, sourceFilesBefore)
    }
    const entriesRun = run('unzip', ['-Z1', builtApk], { cwd: stagedProject })
    const entries = entriesRun.stdout.split(/\r?\n/).filter(Boolean)
    const libraryEntry = 'lib/arm64-v8a/libcontainer_host_android.so'
    const bridgeEntry = 'lib/arm64-v8a/libweapp_container.so'
    const embeddedNative = entriesRun.status === 'passed' && entries.includes(libraryEntry)
      ? await hashArchiveEntry(builtApk, libraryEntry)
      : { status: 'failed', bytes: 0, sha256: null, error: `APK is missing ${libraryEntry}` }
    report.package = {
      status: entriesRun.status === 'passed' && embeddedNative.status === 'passed'
        && embeddedNative.sha256 === strippedNative && entries.includes(bridgeEntry) ? 'passed' : 'failed',
      abi: 'arm64-v8a',
      nativeArtifactPath: libraryEntry,
      nativeArtifactSha256: nativeArtifact.sha256,
      strippedNativeArtifactSha256: strippedNative,
      embeddedNativeArtifactSha256: embeddedNative.sha256,
      embeddedNativeArtifactBytes: embeddedNative.bytes,
      jniBridgePresent: entries.includes(bridgeEntry),
    }
    if (report.package.status !== 'passed') {
      report.errors.push(embeddedNative.error || 'APK did not package the exact Android Rust artifact and JNI bridge')
      return finish(report, sourceFilesBefore)
    }

    copyFileSync(builtApk, apkPath)
    report.apk = { path: apkPath, sha256: await hashFile(apkPath), bytes: lstatSync(apkPath).size }
    report.package.status = report.apk.sha256 ? 'passed' : 'failed'
    return finish(report, sourceFilesBefore)
  } catch (error) {
    report.errors.push(error.message || String(error))
    return finish(report, sourceFilesBefore)
  } finally {
    if (stageRoot) rmSync(stageRoot, { recursive: true, force: true })
    rmSync(nativeReceiptPath, { force: true })
  }
}

function finish(report, sourceFilesBefore) {
  let sourceFilesAfter = []
  try { sourceFilesAfter = sourceInputs() } catch (error) { report.errors.push(error.message || String(error)) }
  const after = sourceState()
  const stableInputs = JSON.stringify(sourceFilesBefore) === JSON.stringify(sourceFilesAfter)
  report.workingTreeDirty = after.workingTreeDirty
  report.sourceFiles = sourceFilesAfter
  report.sourceInventorySha256 = sourceInventorySha256(sourceFilesAfter)
  report.sourceStable = after.sourceCommit === report.sourceCommit && !after.workingTreeDirty && stableInputs
  if (!report.sourceStable) report.errors.push('Android build source changed during the build')
  report.status = report.sourceStable && report.native.status === 'passed' && report.gradle.status === 'passed'
    && report.package.status === 'passed' && hashPattern.test(report.apk.sha256 || '') ? 'passed' : 'failed'
  const output = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(reportPath, output, 'utf8')
  process.stdout.write(`${report.status}: Android debug APK ${report.apk.sha256 || 'not produced'}\n${reportPath}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}

await main()
