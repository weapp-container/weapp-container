#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertIOSBundleAbsent } from './ios-simulator-apps.mjs'
import { validateIOSEmbeddingEvidence } from './validate-ios-app-evidence.mjs'
import { syncPortablePack } from './portable-pack.mjs'
import { acquireIOSUILease, cleanupIOSUIResources, observeIOSUIPIDs } from './ios-ui-test-resources.mjs'
import { configureIOSUIXctestrun, inside, iosUIExecutionArguments, iosUIXctestrunTarget, parseIOSUIOptions,
  sha256, UI_PHASES, UI_REPORT_FILE, validateIOSUIBuildProduct, validateIOSUIReport, validateIOSUITrace } from './ios-ui-test-contracts.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = path => JSON.parse(readFileSync(path))
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n')
  renameSync(path + '.tmp', path)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }

/** One detached process group per command; cancellation never selects by process name. */
export function createIOSUICommandRunner(outDir, { signal } = {}) {
  let sequence = 0
  const commands = []
  function begin(command, args) {
    const id = String(++sequence).padStart(3, '0')
    const logPath = resolve(outDir, `commands/${id}.log`)
    mkdirSync(dirname(logPath), { recursive: true })
    const record = { schemaVersion: 1, command, args, startedAt: new Date().toISOString(), logPath }
    commands.push(record)
    write(resolve(outDir, `commands/${id}.json`), record)
    return { id, record, logPath }
  }
  function finish(state, status, signal, extra = {}) {
    Object.assign(state.record, { exitCode: status, signal: signal ?? null, completedAt: new Date().toISOString(), ...extra,
      logSha256: sha256(readFileSync(state.logPath)) })
    write(resolve(outDir, `commands/${state.id}.json`), state.record)
    return { status, stdout: readFileSync(state.logPath, 'utf8'), stderr: extra.error ?? '', ...extra }
  }
  function sync(command, args, options = {}) {
    const { allowAborted = false, ...spawnOptions } = options
    if (!allowAborted) signal?.throwIfAborted()
    const state = begin(command, args)
    const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...spawnOptions })
    writeFileSync(state.logPath, (result.stdout ?? '') + (result.stderr ?? ''))
    return { ...finish(state, result.status ?? -1, result.signal, result.error ? { error: result.error.message } : {}),
      stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' }
  }
  function checked(command, args, options = {}) {
    const result = sync(command, args, options)
    requireValue(result.status === 0, `${command} failed (${result.status}); inspect ${commands.at(-1).logPath}`)
    return result.stdout
  }
  async function owned(command, args, { env = process.env, timeoutMs = 900000, observe } = {}) {
    signal?.throwIfAborted()
    const state = begin(command, args)
    const descriptor = openSync(state.logPath, 'wx')
    let child
    try { child = spawn(command, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', descriptor, descriptor] }) }
    finally { closeSync(descriptor) }
    state.record.pid = child.pid ?? null
    write(resolve(outDir, `commands/${state.id}.json`), state.record)
    let reason = null
    let killTimer
    let completed = false
    const stop = message => {
      if (completed || reason !== null) return
      reason = message
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') reason += '; ' + error.message }
        killTimer = setTimeout(() => {
          if (completed) return
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') reason += '; ' + error.message }
        }, 5000)
      }
    }
    const interrupt = () => stop(signal.reason?.message ?? 'command interrupted')
    signal?.addEventListener('abort', interrupt, { once: true })
    const deadline = setTimeout(() => stop('command exceeded its deadline'), timeoutMs)
    const monitor = observe ? setInterval(() => { try { observe() } catch (error) { stop(error.message) } }, 250) : null
    let error
    const result = await new Promise(resolve => {
      child.once('error', value => { error = value.message })
      child.once('close', (status, signal) => resolve({ status: status ?? -1, signal }))
    })
    completed = true
    clearTimeout(deadline)
    clearTimeout(killTimer)
    if (monitor) clearInterval(monitor)
    signal?.removeEventListener('abort', interrupt)
    if (observe && !reason && !error) { try { observe() } catch (value) { reason = value.message } }
    return finish(state, result.status, result.signal, reason || error ? { error: reason ?? error } : {})
  }
  return { commands, sync, checked, owned }
}

export function captureIOSUIHarnessSource(root) {
  const inputs = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates', 'examples/hosts/ios',
    'examples/hosts/ios-app', 'examples/hosts/ios-ui-tests', 'examples/apps/ios-interaction-app', 'scripts/ios-app-smoke', 'scripts/ios-embedding-smoke',
    'scripts/ios-embedding-ui-smoke', 'scripts/ios-embedding-ui-smoke.mjs', 'scripts/ios-ui-test-*',
    'scripts/ios-app-*.mjs', 'scripts/ios-simulator-apps.mjs', 'scripts/validate-ios-app-evidence.mjs',
    'scripts/sync-ios-portable-pack.mjs', 'scripts/portable-pack.mjs', 'scripts/fixtures/ios-ui-*']
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    requireValue(result.status === 0, 'cannot capture harness source inventory')
    return result.stdout
  }
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs]).split('\0').filter(Boolean))].sort()
  return { sourceCommit: git(['rev-parse', 'HEAD']).trim(), workingTreeScope: inputs,
    workingTreeDirty: Boolean(git(['status', '--porcelain', '--untracked-files=all', '--', ...inputs]).trim()),
    files: Object.fromEntries(files.filter(path => existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile())
      .map(path => [path, sha256(readFileSync(resolve(root, path)))])) }
}

/** Hash every regular file and symlink target without following bundle symlinks. */
export function fingerprintIOSUITree(directory) {
  const files = {}
  function visit(folder, prefix = '') {
    for (const name of readdirSync(folder).sort()) {
      const path = resolve(folder, name)
      const key = prefix + name
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) files[key] = { kind: 'symlink', target: readlinkSync(path) }
      else if (stat.isDirectory()) visit(path, key + '/')
      else if (stat.isFile()) files[key] = { kind: 'file', size: stat.size, sha256: sha256(readFileSync(path)) }
      else throw new Error(`unsupported bundle resource: ${key}`)
    }
  }
  visit(directory)
  return { schemaVersion: 1, root: sha256(JSON.stringify(files)), files }
}

function generatedRunner(generated, testRoot) {
  const target = iosUIXctestrunTarget(generated)
  const expand = (path, host = '') => path?.replaceAll('__TESTROOT__', testRoot).replaceAll('__TESTHOST__', host)
  const runnerApp = resolve(expand(target.TestHostPath) ?? '')
  requireValue(inside(testRoot, runnerApp) && runnerApp.endsWith('.app') && existsSync(runnerApp), 'generated test host must be an owned runner App')
  const testBundle = resolve(expand(target.TestBundlePath, runnerApp) ?? '')
  requireValue(inside(runnerApp, testBundle) && existsSync(testBundle), 'generated test bundle escaped the runner App')
  return { runnerApp, testBundle, testBundleRelativePath: relative(runnerApp, testBundle) }
}

function copyIfPresent(source, destination) {
  if (!existsSync(source)) return false
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  return true
}

export async function runIOSUIHarness(options) {
  requireValue(!existsSync(options.outDir), 'output directory already exists; evidence is never overwritten')
  mkdirSync(dirname(options.outDir), { recursive: true })
  mkdirSync(options.outDir)
  const abort = new AbortController()
  const onInterrupt = () => abort.abort(new Error('harness interrupted by SIGINT'))
  const onTerminate = () => abort.abort(new Error('harness interrupted by SIGTERM'))
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  const command = createIOSUICommandRunner(options.outDir, { signal: abort.signal })
  const report = { schemaVersion: 1, status: 'running', evidenceBoundary: 'xctest-os-interaction',
    engine: options.engine, udid: options.udid, runID: options.runID, startedAt: new Date().toISOString(),
    simulatorOwned: false, limitations: ['Official simulator interaction only', 'No DevTools, physical-device GPU, near-parity or performance acceptance'] }
  const reportPath = resolve(options.outDir, 'report.json')
  write(reportPath, report)
  const resources = []
  let lease
  let source
  let containers
  let failure
  let product
  let frozenArtifacts
  let artifactPaths
  try {
    lease = acquireIOSUILease(options)
    report.lease = lease.directory
    const devices = JSON.parse(command.checked('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']))
    const matches = Object.entries(devices.devices ?? {}).flatMap(([runtime, values]) => values.filter(device => device.udid === options.udid && device.state === 'Booted').map(device => ({ runtime, ...device })))
    requireValue(matches.length === 1, 'selected borrowed simulator is not uniquely booted')
    report.target = matches[0]
    report.xcode = command.checked('xcodebuild', ['-version']).trim()
    source = captureIOSUIHarnessSource(options.root)
    write(resolve(options.outDir, 'source-before.json'), source)
    requireValue(source.workingTreeDirty === false, 'commit UI harness and interaction fixture sources before official execution')
    const appBuild = await command.owned(resolve(options.root, 'scripts/ios-app-smoke'), [], { env: { ...process.env,
      WEAPP_CONTAINER_IOS_BUILD_ONLY: '1', WEAPP_CONTAINER_IOS_UI_OBSERVATION: '1', WEAPP_CONTAINER_IOS_APP_MODE: 'embedding',
      WEAPP_CONTAINER_IOS_ENGINE: options.engine, WEAPP_CONTAINER_IOS_PACK: options.pack,
      WEAPP_CONTAINER_IOS_BUNDLE_ID: options.autBundleId, WEAPP_CONTAINER_IOS_APP_OUT_DIR: resolve(options.outDir, 'app-build') } })
    requireValue(appBuild.status === 0 && !appBuild.error, 'build-only App command failed; inspect command receipt')
    const buildRoot = resolve(options.outDir, 'app-build')
    const products = readdirSync(buildRoot).filter(name => name.startsWith('run-')).map(name => resolve(buildRoot, name, 'build-product.json')).filter(existsSync)
    requireValue(products.length === 1, 'build-only command must emit exactly one build-product.json')
    product = read(products[0])
    for (const field of ['appPath', 'buildReceiptPath', 'runDirectory']) requireValue(inside(buildRoot, product[field]), `untrusted build-only ${field}`)
    const build = read(product.buildReceiptPath)
    validateIOSUIBuildProduct(product, build, options)
    requireValue(build.sourceCommit === source.sourceCommit, 'App build and harness source commits differ')
    requireValue(sha256(readFileSync(product.buildReceiptPath)) === product.buildReceiptSha256
      && product.artifactSha256 === build.artifactSha256, 'build product receipt hash differs')
    const executable = resolve(product.appPath, 'WeappContainerApp')
    requireValue(sha256(readFileSync(executable)) === build.artifactSha256, 'signed App executable differs from the frozen build')
    const appInfo = JSON.parse(command.checked('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', resolve(product.appPath, 'Info.plist')]))
    requireValue(appInfo.CFBundleIdentifier === options.autBundleId && appInfo.WeappContainerSessionID === product.sessionId
      && appInfo.WeappContainerAppMode === 'embedding' && appInfo.WeappContainerUIObservation === true, 'App identity, mode or read-only observation opt-in differs')
    report.appBuild = { product: relative(options.outDir, products[0]), executableSha256: build.artifactSha256, sourceCommit: build.sourceCommit }
    const pack = await syncPortablePack({ source: options.pack, destination: resolve(product.appPath, 'portable-pack'), check: true })
    report.pack = { source: options.pack, integrityRoot: pack.integrityRoot, blobCount: pack.blobCount }
    const derived = resolve(options.outDir, 'DerivedData')
    const runnerBuild = await command.owned('xcodebuild', ['build-for-testing', '-project', resolve(options.root, 'examples/hosts/ios-ui-tests/WeappContainerUITests.xcodeproj'),
      '-scheme', 'WeappContainerUITests', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', derived, `WEAPP_CONTAINER_UI_TEST_BUNDLE_ID=${options.testBundleId}`, 'CODE_SIGN_IDENTITY=-'])
    requireValue(runnerBuild.status === 0 && !runnerBuild.error, 'official UI runner build failed; inspect command receipt')
    const testRoot = resolve(derived, 'Build/Products')
    const generatedPaths = readdirSync(testRoot).filter(name => name.endsWith('.xctestrun'))
    requireValue(generatedPaths.length === 1, 'xcodebuild must emit exactly one generated xctestrun')
    const generatedPath = resolve(testRoot, generatedPaths[0])
    const generatedBytes = readFileSync(generatedPath)
    const generated = JSON.parse(command.checked('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', generatedPath]))
    const runner = generatedRunner(generated, testRoot)
    const runnerInfo = JSON.parse(command.checked('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', resolve(runner.runnerApp, 'Info.plist')]))
    const runnerBundleId = runnerInfo.CFBundleIdentifier
    requireValue(runnerBundleId === options.testBundleId + '.xctrunner', 'runner bundle is not the unique generated test host')
    const configured = configureIOSUIXctestrun(generated, { ...runner, runnerBundleId, autBundleId: options.autBundleId, sessionId: product.sessionId })
    // Keep Xcode's __TESTROOT__ bootstrap paths relative to Build/Products.
    // The copy at the evidence root is for review, never execution.
    const xctestrun = resolve(testRoot, 'WeappContainerUIInteraction.xctestrun')
    command.checked('/usr/bin/plutil', ['-convert', 'xml1', '-o', xctestrun, '--', '-'], { input: JSON.stringify(configured) })
    copyFileSync(generatedPath, resolve(options.outDir, 'generated.xctestrun'))
    copyFileSync(xctestrun, resolve(options.outDir, 'interaction.xctestrun'))
    report.runner = { bundleId: runnerBundleId, generatedXctestrunSha256: sha256(generatedBytes), configuredXctestrunSha256: sha256(readFileSync(xctestrun)),
      executableSha256: sha256(readFileSync(resolve(runner.runnerApp, runnerInfo.CFBundleExecutable))),
      testBundleRoot: fingerprintIOSUITree(runner.testBundle).root }
    artifactPaths = { app: product.appPath, runner: runner.runnerApp, inputPack: options.pack }
    frozenArtifacts = { trees: Object.fromEntries(Object.entries(artifactPaths).map(([name, path]) => [name, fingerprintIOSUITree(path)])),
      files: Object.fromEntries([products[0], product.buildReceiptPath, generatedPath, xctestrun,
        resolve(options.outDir, 'generated.xctestrun'), resolve(options.outDir, 'interaction.xctestrun')].map(path => [path, sha256(readFileSync(path))])) }
    write(resolve(options.outDir, 'artifacts-before.json'), frozenArtifacts)
    const inventory = (udid, bundleId) => assertIOSBundleAbsent(udid, bundleId, (name, args, extra) => command.checked(name, args, extra))
    for (const [role, bundleId, app] of [['aut', options.autBundleId, product.appPath], ['runner', runnerBundleId, runner.runnerApp]]) {
      inventory(options.udid, bundleId)
      const owner = { owned: true, role, udid: options.udid, bundleId, installed: false, installAttempted: false, pid: null, simulatorOwned: false }
      resources.push(owner)
      owner.installAttempted = true
      write(resolve(options.outDir, 'resources.json'), { schemaVersion: 1, resources })
      const installed = command.sync('xcrun', ['simctl', 'install', options.udid, app])
      requireValue(installed.status === 0, `installation never acknowledged; preserve ambiguous ${bundleId}`)
      owner.installed = true
      write(resolve(options.outDir, 'resources.json'), { schemaVersion: 1, resources })
    }
    containers = Object.fromEntries(resources.map(owner => [owner.role, command.checked('xcrun', ['simctl', 'get_app_container', owner.udid, owner.bundleId, 'data']).trim()]))
    const observe = () => {
      const listing = command.checked('xcrun', ['simctl', 'spawn', options.udid, 'launchctl', 'list'])
      if (observeIOSUIPIDs(resources, listing)) write(resolve(options.outDir, 'resources.json'), { schemaVersion: 1, resources })
    }
    const execution = await command.owned('xcodebuild', iosUIExecutionArguments({ ...options, xctestrun }),
      { timeoutMs: (options.timeoutSeconds + 60) * 1000, observe })
    report.execution = { exitCode: execution.status, error: execution.error ?? null }
    // Official simulator test execution may reinstall our uniquely owned runner.
    // Resolve its current data container after Xcode exits instead of assuming
    // the directory from our acknowledged pre-install is still current.
    containers = Object.fromEntries(resources.map(owner => [owner.role, command.checked('xcrun', ['simctl', 'get_app_container', owner.udid, owner.bundleId, 'data']).trim()]))
    const runnerCache = resolve(containers.runner, 'Library/Caches')
    copyIfPresent(resolve(runnerCache, UI_REPORT_FILE), resolve(options.outDir, 'runner/report.json'))
    for (const phase of UI_PHASES) copyIfPresent(resolve(runnerCache, 'screenshots', phase + '.png'), resolve(options.outDir, 'runner/screenshots', phase + '.png'))
    requireValue(execution.status === 0 && !execution.error, 'official UI test failed; original xcresult and receipts retained')
    const uiReport = read(resolve(options.outDir, 'runner/report.json'))
    const expected = { ...options, runnerBundleId, sessionId: product.sessionId }
    report.interaction = validateIOSUIReport(uiReport, expected)
    for (const owner of resources) requireValue(owner.pid === (owner.role === 'aut' ? uiReport.targetPid : uiReport.runnerPid), 'UI report and observed process identity differ')
    for (const step of uiReport.steps) requireValue(sha256(readFileSync(resolve(options.outDir, 'runner', step.screenshot.file))) === step.screenshot.sha256, 'OS screenshot differs from the runner receipt')
    const appCache = resolve(containers.aut, 'Library/Caches')
    const tracePath = resolve(appCache, 'weapp-ios-embedding-trace.json')
    const deadline = performance.now() + 5000
    let traceError
    do {
      try {
        const bytes = readFileSync(tracePath)
        report.trace = validateIOSUITrace(JSON.parse(bytes), uiReport)
        mkdirSync(resolve(options.outDir, 'app'), { recursive: true })
        writeFileSync(resolve(options.outDir, 'app/embedding-trace.json'), bytes)
        traceError = null
        break
      } catch (error) { traceError = error }
      await wait(100)
    } while (performance.now() < deadline)
    if (traceError) throw traceError
    const evidencePath = resolve(appCache, 'weapp-ios-evidence.json')
    copyIfPresent(evidencePath, resolve(options.outDir, 'app/evidence.json'))
    const evidence = read(evidencePath)
    requireValue(evidence.sessionId === product.sessionId && evidence.engine === options.engine, 'App Metal evidence belongs to another session/engine')
    report.firstFrame = validateIOSEmbeddingEvidence(evidence, read(resolve(product.appPath, 'portable-pack/manifest.json')))
    report.status = 'passed'
  } catch (error) {
    failure = error
    report.status = 'failed'
    report.error = error.message
  } finally {
    const finalize = async (name, task) => {
      try { await task() }
      catch (error) {
        report.status = 'failed'
        ;(report.finalizationErrors ??= []).push({ phase: name, message: error.message })
      }
    }
    if (containers) {
      await finalize('collect-app', () => {
        const cache = resolve(containers.aut, 'Library/Caches')
        for (const [name, file] of [['weapp-ios-evidence.json', 'raw-evidence.json'], ['weapp-ios-embedding-trace.json', 'raw-embedding-trace.json']]) {
          copyIfPresent(resolve(cache, name), resolve(options.outDir, 'app', file))
        }
      })
      await finalize('collect-runner', () => {
        const cache = resolve(containers.runner, 'Library/Caches')
        copyIfPresent(resolve(cache, UI_REPORT_FILE), resolve(options.outDir, 'runner/raw-report.json'))
        for (const phase of UI_PHASES) copyIfPresent(resolve(cache, 'screenshots', phase + '.png'), resolve(options.outDir, 'runner/raw-screenshots', phase + '.png'))
      })
    }
    if (resources.length) {
      await finalize('cleanup', () => {
        report.cleanup = cleanupIOSUIResources(resources, args => command.sync('xcrun', ['simctl', ...args], { allowAborted: true }),
          (udid, bundleId) => assertIOSBundleAbsent(udid, bundleId, (name, args, extra) => command.checked(name, args, { ...extra, allowAborted: true })))
        write(resolve(options.outDir, 'cleanup.json'), report.cleanup)
        if (report.cleanup.status !== 'passed') { report.status = 'failed'; report.cleanupFailure = 'one or more exact task resources could not be released' }
      })
    }
    if (frozenArtifacts) {
      await finalize('artifact-integrity', () => {
        const after = { trees: Object.fromEntries(Object.entries(artifactPaths).map(([name, path]) => [name, fingerprintIOSUITree(path)])),
          files: Object.fromEntries(Object.keys(frozenArtifacts.files).map(path => [path, sha256(readFileSync(path))])) }
        write(resolve(options.outDir, 'artifacts-after.json'), after)
        report.artifactsUnchanged = JSON.stringify(frozenArtifacts) === JSON.stringify(after)
        requireValue(report.artifactsUnchanged, 'App, runner, portable pack, build receipt or xctestrun bytes changed during execution')
      })
    }
    if (source) {
      await finalize('source-integrity', () => {
        const after = captureIOSUIHarnessSource(options.root)
        write(resolve(options.outDir, 'source-after.json'), after)
        report.sourceUnchanged = JSON.stringify(source) === JSON.stringify(after)
        if (!report.sourceUnchanged) { report.status = 'failed'; report.sourceFailure = 'harness/App source changed during execution' }
      })
    }
    if (lease) {
      await finalize('lease-release', () => { lease.release(); report.leaseReleased = true })
    }
    if (abort.signal.aborted) { report.status = 'failed'; report.error ??= abort.signal.reason.message }
    report.completedAt = new Date().toISOString()
    report.commandCount = command.commands.length
    try { write(reportPath, report) }
    finally {
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
    }
  }
  if (failure || report.status !== 'passed') throw new Error(`${report.error ?? report.cleanupFailure ?? report.sourceFailure ?? report.finalizationErrors?.[0]?.message}; evidence: ${reportPath}`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) {
      console.log('usage: ios-embedding-ui-smoke --udid <booted-simulator> --pack <portable-interaction-pack> [--engine quickjs|v8] [--out-dir artifacts/<new-run>] [--timeout-seconds 180]')
    } else {
      const options = parseIOSUIOptions(process.argv.slice(2), { root: ROOT, runID: randomUUID().replaceAll('-', '').slice(0, 12) })
      const report = await runIOSUIHarness(options)
      console.log(JSON.stringify({ status: report.status, evidence: resolve(options.outDir, 'report.json') }, null, 2))
    }
  } catch (error) { console.error(`[ios-ui] ${error.message}`); process.exitCode = 1 }
}
