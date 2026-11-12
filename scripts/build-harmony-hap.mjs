#!/usr/bin/env node
// Compile an isolated, inspectable Harmony example with the official SDK.
// No install, signing, emulator or GPU acceptance is implied by this command.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SDK_RELEASE_VERSION, assertCleanNativeSource, captureNativeSource } from './lib/sdk-current-release.mjs'
import { assertHarmonyNativeRelease, collectHarmonyGeneratedMetadata, inspectHarmonyHap, preserveHarmonyNativeLibraries } from './lib/harmony-artifact-contract.mjs'

const toolRoot = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf(name) !== index) throw new Error(`${name} requires one value`)
  return args[index + 1]
}
const root = resolve(option('--source-root', toolRoot))
const profile = option('--profile', 'dev')
if (!['dev', 'release'].includes(profile)) throw new Error('--profile must be dev or release')
const nativeReceiptPath = option('--native-receipt', null)
if (profile === 'release' && !nativeReceiptPath) throw new Error('Release HAP requires --native-receipt from a clean release native producer')
const out = resolve(option('--out', `artifacts/harmony-hap-${randomUUID()}`))
const projectSource = resolve(root, 'examples/hosts/harmony')
const project = join(out, 'project')
const sdkCandidate = resolve(option('--sdk', process.env.OHOS_SDK || '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony'))
const sdk = existsSync(join(sdkCandidate, 'openharmony/native')) ? join(sdkCandidate, 'openharmony') : sdkCandidate
const hvigor = resolve(option('--hvigor', '/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw'))
const rustLib = resolve(option('--rust-lib', join(root, `target/aarch64-unknown-linux-ohos/${profile === 'release' ? 'release' : 'debug'}/libcontainer_host_harmony.so`)))
const bundle = option('--bundle', null)
const pack = option('--pack', null)
const report = { schemaVersion: 1, sdkVersion: SDK_RELEASE_VERSION, profile, startedAt: new Date().toISOString(), scope: 'harmony-hap-build', status: 'running', sourceFiles: [], commands: [], evidenceBoundary: 'official SDK compilation and unsigned packaging only; no device/GPU/DevTools acceptance' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function save() { writeFileSync(join(out, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`) }
async function run(name, command, commandArgs, cwd, env = {}) {
  const receipt = { name, command, args: commandArgs, cwd, environmentOverrides: env, startedAt: new Date().toISOString() }
  report.commands.push(receipt)
  save()
  const log = []
  const child = spawn(command, commandArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log.push(bytes); process.stdout.write(bytes) })
  const status = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  writeFileSync(join(out, `${name}.log`), Buffer.concat(log))
  Object.assign(receipt, status, { completedAt: new Date().toISOString(), log: `${name}.log` })
  save()
  if (status.code !== 0) throw new Error(`${name} failed (${status.code ?? status.signal})`)
}
function copySources(source, destination, relative = '') {
  mkdirSync(destination)
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    // These are compiler outputs/local dependency state, never source inputs.
    if (['.hvigor', '.cxx', 'build', 'oh_modules', 'node_modules', 'local.properties'].includes(entry.name)) continue
    const path = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`source symlink is not permitted: ${path}`)
    if (entry.isDirectory()) copySources(join(source, entry.name), join(destination, entry.name), path)
    else if (entry.isFile()) {
      copyFileSync(join(source, entry.name), join(destination, entry.name))
      report.sourceFiles.push({ path, sha256: sha(readFileSync(join(destination, entry.name))) })
    }
  }
}

if (existsSync(out)) throw new Error(`output already exists; use a new run directory: ${out}`)
// Resolve existing ancestors too: a symlink alias must not allow the copy to
// recursively consume its own output under the source project.
let existingParent = out
const suffix = []
while (!existsSync(existingParent)) {
  suffix.unshift(basename(existingParent))
  existingParent = dirname(existingParent)
}
const resolvedOut = join(realpathSync(existingParent), ...suffix)
const resolvedSource = realpathSync(projectSource)
if (resolvedOut === resolvedSource || resolvedOut.startsWith(`${resolvedSource}${sep}`)) throw new Error('output must be outside the Harmony source project')
if (!existsSync(rustLib) || !statSync(rustLib).isFile()) throw new Error(`build the Harmony Rust library first: ${rustLib}`)
if (!existsSync(hvigor)) throw new Error(`official Hvigor is missing: ${hvigor}`)
if (bundle !== null && !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(bundle)) throw new Error('invalid --bundle name')
mkdirSync(dirname(out), { recursive: true })
mkdirSync(out)
try {
  report.sourceBefore = captureNativeSource(root)
  if (profile === 'release') assertCleanNativeSource(report.sourceBefore)
  report.producerTool = { ...captureNativeSource(toolRoot), files: ['scripts/build-harmony-hap.mjs', 'scripts/lib/harmony-artifact-contract.mjs', 'scripts/lib/sdk-current-release.mjs', 'scripts/lib/sdk-native-features.mjs'].map(path => ({ path, sha256: sha(readFileSync(join(toolRoot, path))) })) }
  if (nativeReceiptPath) {
    const bytes = readFileSync(nativeReceiptPath), native = assertHarmonyNativeRelease(JSON.parse(bytes), rustLib)
    if (native.sourceCommit !== report.sourceBefore.sourceCommit) throw new Error('HAP source and native release producer commits must match')
    report.nativeRelease = { ...native, receiptSha256: sha(bytes), receiptBytes: bytes.length }
  }
  copySources(projectSource, project)
  report.rustLibrary = { path: rustLib, sha256: sha(readFileSync(rustLib)), bytes: statSync(rustLib).size }
  const appPath = join(project, 'AppScope/app.json5')
  const app = JSON.parse(readFileSync(appPath, 'utf8'))
  if (bundle !== null) {
    app.app.bundleName = bundle
    writeFileSync(appPath, `${JSON.stringify(app, null, 2)}\n`)
  }
  report.bundle = app.app.bundleName
  // Hvigor's generic -p nativeArgs is not a CMake forwarding contract. Set
  // the copied module's documented externalNativeOptions.arguments instead,
  // so isolated builds never depend on a repository-relative fallback path.
  const nativeProfilePath = join(project, 'entry/build-profile.json5')
  const nativeProfile = preserveHarmonyNativeLibraries(JSON.parse(readFileSync(nativeProfilePath, 'utf8')))
  // Hvigor passes each argument directly to CMake, without a shell removing
  // quotes. Quoting the value here would make quotes part of the file path.
  const nativeArgument = `-DWEAPP_CONTAINER_HARMONY_RUST_LIB=${rustLib}`
  nativeProfile.buildOption.externalNativeOptions.arguments = nativeArgument
  writeFileSync(nativeProfilePath, `${JSON.stringify(nativeProfile, null, 2)}\n`)
  report.nativeArguments = nativeArgument
  report.nativePackaging = { strip: false, exclude: [], policy: 'preserve-exact-native-producer-bytes', profileSha256: sha(readFileSync(nativeProfilePath)) }
  if (pack !== null) await run('pack-sync', process.execPath, [join(root, 'scripts/sync-harmony-pack.mjs'), '--pack', resolve(pack), '--out', join(project, 'entry/src/main/resources/rawfile')], root)
  // DevEco ships a flat SDK while Hvigor resolves the versioned OpenHarmony
  // layout. This run owns the symlinks; the SDK installation stays untouched.
  const compileSdk = JSON.parse(readFileSync(join(project, 'build-profile.json5'), 'utf8')).app.products[0].compileSdkVersion
  const sdkRoot = join(out, 'sdk')
  mkdirSync(join(sdkRoot, String(compileSdk)), { recursive: true })
  const components = ['ets', 'js', 'native', 'previewer', 'toolchains']
  for (const component of components) {
    if (!existsSync(join(sdk, component))) throw new Error(`SDK component is missing: ${component}`)
    symlinkSync(join(sdk, component), join(sdkRoot, String(compileSdk), component), 'dir')
  }
  report.sdk = { source: sdk, versionedLayout: sdkRoot, compileSdk, components }
  save()
  await run('hvigor', hvigor, ['assembleApp', '-p', 'product=default', ...(profile === 'release' ? ['-p', 'buildMode=release'] : []), '--no-daemon'], project, { OHOS_BASE_SDK_HOME: sdkRoot })
  if (sha(readFileSync(rustLib)) !== report.rustLibrary.sha256) throw new Error('Rust library changed during packaging')
  const hap = join(project, 'entry/build/default/outputs/default/entry-default-unsigned.hap')
  if (!existsSync(hap)) throw new Error('Hvigor did not produce the expected unsigned HAP')
  report.artifact = { path: hap, sha256: sha(readFileSync(hap)), bytes: statSync(hap).size, signing: 'unsigned' }
  if (profile === 'release') {
    report.generatedMetadata = collectHarmonyGeneratedMetadata(project)
    report.artifact.members = inspectHarmonyHap(hap, report.nativeRelease, { metadata: report.generatedMetadata })
  }
  report.generatedManifestSha256 = sha(readFileSync(join(project, 'entry/src/main/resources/rawfile/manifest.json')))
  report.sourceAfter = captureNativeSource(root)
  if (profile === 'release') assertCleanNativeSource(report.sourceAfter, report.sourceBefore)
  report.protocols = { hostServices: '1.0', nativeBridge: '1.0' }
  report.protocolVerification = 'source-build; runtime handshake remains unverified'
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  process.exitCode = 1
} finally {
  report.completedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify({ status: report.status, report: join(out, 'build-report.json'), artifact: report.artifact ?? null }))
}
