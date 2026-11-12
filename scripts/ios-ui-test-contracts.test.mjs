import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { captureIOSUIHarnessSource, createIOSUICommandRunner, fingerprintIOSUITree } from './ios-embedding-ui-smoke.mjs'
import { configureIOSUIXctestrun, inside, iosDeviceOrientationForInterface, iosUIExecutionArguments, iosUIXctestrunTarget, parseIOSUIOptions, sha256,
  UI_PHASES, validateIOSUIBuildProduct, validateIOSUIReport, validateIOSUITrace } from './ios-ui-test-contracts.mjs'
import { acquireIOSUILease, cleanupIOSUIResources, observeIOSUIPIDs } from './ios-ui-test-resources.mjs'

const udid = 'A1234567-B123-C123-D123-E123456789AB'
const expected = { autBundleId: 'com.example.aut', runnerBundleId: 'com.example.runner', sessionId: 'test-session' }
const root = '/repo'
const temp = t => { const path = mkdtempSync(resolve(tmpdir(), 'weapp-ui-contract-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path }
const options = () => parseIOSUIOptions(['--udid', udid, '--pack', 'fixture-pack'], { root, runID: 'test123' })
const edit = (value, change) => { const copy = structuredClone(value); change(copy); return copy }

function uiReport() {
  return { schemaVersion: 1, status: 'passed', recordedFailureCount: 0, evidenceBoundary: 'xctest-os-interaction', ...expected,
    targetBundleId: expected.autBundleId, targetPid: 111, runnerPid: 222, surfaceIdentifier: 'weapp-container-surface', orientationRestored: true,
    initialOrientation: { source: 'UIWindowScene.interfaceOrientation', deviceSensorRawValue: 0, interfaceRawValue: 1, restoreDeviceRawValue: 1 },
    actions: { tap: { api: 'XCUICoordinate.tap', logicalX: 40, logicalY: 40 }, home: { api: 'XCUIDevice.press(home)' },
      resume: { api: 'XCUIApplication.activate' },
      rotate: { api: 'XCUIDevice.orientation', fromInterfaceRawValue: 1, toInterfaceRawValue: 4, deviceRawValue: 4 },
      restore: { api: 'XCUIDevice.orientation', interfaceRawValue: 1, deviceRawValue: 1 } },
    steps: UI_PHASES.map((phase, index) => {
      const step = { phase, atUnixMs: 1000 + index * 100, appState: phase === 'background' ? 3 : 4,
        screenshot: { file: `screenshots/${phase}.png`, sha256: sha256(phase) } }
      if (phase === 'background') return step
      const rotated = phase === 'rotated'
      const viewport = { width: rotated ? 844 : 390, height: rotated ? 390 : 844 }
      return { ...step, surfaceFrame: viewport, surface: { schemaVersion: 1, sessionId: expected.sessionId, pid: 111,
        frameId: index + 1, presentedFrameId: index + 1, viewport, interfaceOrientation: rotated ? 4 : 1,
        foreground: true, closed: false, failed: false,
        pageData: { count: index ? 1 : 0, timerCount: index >= 2 ? 1 : 0, microtaskCount: index >= 2 ? 1 : 0,
          lifecycleTrace: index >= 4 ? ['page:show', 'page:hide', 'page:show'] : ['page:show'] } } }
    }) }
}
function traceFor(report) {
  const operation = (op, payload) => ({ kind: 'operation', op, requestJson: JSON.stringify({ sessionId: expected.sessionId, payload }) })
  return { schemaVersion: 1, sessionId: expected.sessionId, dropped: 0, events: [
    operation('event.batch', { events: ['touchstart', 'touchend', 'tap'].map(type => ({ type })) }),
    operation('app.lifecycle', { event: 'hide' }), operation('app.lifecycle', { event: 'show' }),
    operation('host.resize', { width: 844, height: 390 }), operation('host.resize', { width: 390, height: 844 }),
    operation('render.commit', { frameId: report.steps.at(-1).surface.frameId }) ] }
}

test('explicit destination, engine, timeout and new artifact directory are bounded', () => {
  const value = options()
  assert.equal(value.engine, 'quickjs')
  assert.equal(value.pack, '/repo/fixture-pack')
  assert.equal(value.udid, udid)
  assert.equal(inside(root, root), false)
  assert.equal(inside(root, undefined), false)
  for (const args of [[], ['--udid', udid], ['--udid', udid, '--pack', 'x', '--engine', 'fallback'],
    ['--udid', udid, '--pack', 'x', '--out-dir', '../artifacts/x'],
    ['--udid', udid, '--pack', 'x', '--timeout-seconds', '29'],
    ['--udid', udid, '--pack', 'x', '--udid', udid]]) {
    assert.throws(() => parseIOSUIOptions(args, { root, runID: 'test123' }))
  }
  assert.throws(() => parseIOSUIOptions(['--udid', udid, '--pack', 'x'], { root, runID: 'unsafe/identity' }))
})

test('build-only receipts require confined clean source-bound embedding artifacts', () => {
  const value = options()
  const runDirectory = resolve(value.outDir, 'app-build/run-123')
  const product = { schemaVersion: 1, engine: 'quickjs', appMode: 'embedding', bundleId: value.autBundleId, sessionId: 'session',
    runDirectory, appPath: resolve(runDirectory, 'Test.app'), buildReceiptPath: resolve(runDirectory, 'build.json'),
    artifactSha256: 'a'.repeat(64), buildReceiptSha256: 'b'.repeat(64) }
  const build = { schemaVersion: 1, status: 'passed', host: 'ios', engine: 'quickjs', appMode: 'embedding',
    workingTreeDirty: false, artifactSha256: 'a'.repeat(64), sourceCommit: 'c'.repeat(40) }
  assert.equal(validateIOSUIBuildProduct(product, build, value), product)
  assert.throws(() => validateIOSUIBuildProduct({ ...product, buildReceiptPath: '/tmp/foreign.json' }, build, value), /escaped/)
  assert.throws(() => validateIOSUIBuildProduct(product, { ...build, workingTreeDirty: true }, value), /clean/)
  assert.throws(() => validateIOSUIBuildProduct(product, { ...build, engine: 'v8' }, value), /clean/)
})

test('format 2 simulator xctestrun retains generated local runner paths and bootstrap', () => {
  const target = { ProductModuleName: 'WeappContainerUITests', IsUITestBundle: true,
    TestingEnvironmentVariables: { DYLD_FRAMEWORK_PATH: '__PLATFORMS__/official' }, EnvironmentVariables: { INHERITED: 'yes' },
    TestBundlePath: '__TESTROOT__/runner.app/PlugIns/Test.xctest', TestHostPath: '__TESTROOT__/runner.app',
    TestHostBundleIdentifier: expected.runnerBundleId, UseUITargetAppProvidedByTests: true,
    DependentProductPaths: ['__TESTROOT__/runner.app', '__TESTROOT__/runner.app/PlugIns/Test.xctest'] }
  const generated = { __xctestrun_metadata__: { FormatVersion: 2 }, TestConfigurations: [{ IsEnabled: true, TestTargets: [target] }] }
  const result = configureIOSUIXctestrun(generated, { ...expected, testBundleRelativePath: 'PlugIns/Test.xctest' })
  const configured = result.TestConfigurations[0].TestTargets[0]
  assert.deepEqual(configured.TestingEnvironmentVariables, target.TestingEnvironmentVariables)
  assert.equal(Object.hasOwn(configured, 'TestBundleDestinationRelativePath'), false)
  assert.equal(Object.hasOwn(configured, 'UseDestinationArtifacts'), false)
  assert.equal(Object.hasOwn(configured, 'UITargetAppBundleIdentifier'), false)
  assert.equal(configured.EnvironmentVariables.INHERITED, 'yes')
  assert.equal(configured.EnvironmentVariables.WEAPP_CONTAINER_UI_SESSION_ID, expected.sessionId)
  assert.equal(configured.ParallelizationEnabled, false)
  for (const key of ['TestHostPath', 'TestBundlePath', 'DependentProductPaths', 'TestHostBundleIdentifier', 'UseUITargetAppProvidedByTests']) {
    assert.deepEqual(configured[key], target[key])
  }
  assert.deepEqual(generated.TestConfigurations[0].TestTargets[0], target)
  assert.throws(() => configureIOSUIXctestrun(edit(generated, x => x.TestConfigurations[0].TestTargets.push(target)), { ...expected, testBundleRelativePath: 'PlugIns/Test.xctest' }), /exactly one/)
  assert.throws(() => configureIOSUIXctestrun(edit(generated, x => { x.WeappContainerUITests = target }), { ...expected, testBundleRelativePath: 'PlugIns/Test.xctest' }), /top-level/)
  assert.throws(() => configureIOSUIXctestrun(generated, { ...expected, testBundleRelativePath: '../foreign.xctest' }), /PlugIns/)
  const args = iosUIExecutionArguments({ ...options(), xctestrun: '/owned/run.xctestrun' })
  assert(args.includes(`platform=iOS Simulator,id=${udid}`))
  assert(args.includes('-disable-concurrent-destination-testing'))
  assert.equal(args[args.indexOf('-parallel-testing-enabled') + 1], 'NO')
})

test('actual Xcode format 1 simulator fixture retains generated artifacts and the App supplied by tests', () => {
  // Extracted from local Xcode build-for-testing output; unique bundle IDs are
  // normalized and all product locations retain Xcode's official placeholders.
  const generated = JSON.parse(readFileSync(new URL('./fixtures/ios-ui-xctestrun-format1.json', import.meta.url)))
  const original = structuredClone(generated)
  const target = iosUIXctestrunTarget(generated)
  assert.equal(generated.__xctestrun_metadata__.FormatVersion, 1)
  assert.equal(target.UseUITargetAppProvidedByTests, true)
  assert.equal(target.TestBundlePath, '__TESTHOST__/PlugIns/WeappContainerUITests.xctest')
  assert.equal(target.TestHostPath, '__TESTROOT__/Debug-iphonesimulator/WeappContainerUITests-Runner.app')
  const configuration = { ...expected, runnerBundleId: target.TestHostBundleIdentifier, testBundleRelativePath: 'PlugIns/WeappContainerUITests.xctest' }
  const result = configureIOSUIXctestrun(generated, configuration)
  const configured = iosUIXctestrunTarget(result)
  assert.equal(result.__xctestrun_metadata__.FormatVersion, 1)
  assert.deepEqual(configured.TestingEnvironmentVariables, target.TestingEnvironmentVariables)
  assert.deepEqual(configured.UITargetAppEnvironmentVariables, target.UITargetAppEnvironmentVariables)
  assert.equal(configured.UseUITargetAppProvidedByTests, true)
  for (const key of ['UseDestinationArtifacts', 'TestBundleDestinationRelativePath', 'UITargetAppBundleIdentifier', 'UITargetAppPath']) assert.equal(Object.hasOwn(configured, key), false)
  for (const key of ['TestBundlePath', 'TestHostPath', 'DependentProductPaths', 'TestHostBundleIdentifier']) assert.deepEqual(configured[key], target[key])
  assert.deepEqual(generated, original)
  for (const mutate of [x => { x.__xctestrun_metadata__.FormatVersion = 3 },
    x => { x.TestConfigurations = [] }, x => { x.OtherTarget = structuredClone(x.WeappContainerUITests) },
    x => { x.WeappContainerUITests.IsUITestBundle = false },
    x => { x.WeappContainerUITests.TestingEnvironmentVariables = [] },
    x => { x.WrongName = x.WeappContainerUITests; delete x.WeappContainerUITests }]) {
    assert.throws(() => configureIOSUIXctestrun(edit(generated, mutate), configuration))
  }
  // The real failed run demonstrated that this option is rejected for an
  // iOS Simulator. Fail before installation if it re-enters the configuration.
  for (const mutate of [x => { x.WeappContainerUITests.UseDestinationArtifacts = true },
    x => { x.WeappContainerUITests.TestBundleDestinationRelativePath = '__TESTHOST__/PlugIns/WeappContainerUITests.xctest' },
    x => { x.WeappContainerUITests.TestHostBundleIdentifier = 'com.example.unowned' },
    x => { x.WeappContainerUITests.TestHostPath = '__TESTROOT__/../foreign.app' },
    x => { x.WeappContainerUITests.TestBundlePath = '__TESTROOT__/foreign.app/PlugIns/Foreign.xctest' },
    x => { x.WeappContainerUITests.DependentProductPaths.push('__TESTROOT__/Foreign.app') },
    x => { x.WeappContainerUITests.UITargetAppPath = '/Applications/Unowned.app' },
    x => { x.WeappContainerUITests.UITargetAppBundleIdentifier = 'com.example.unowned' },
    x => { x.WeappContainerUITests.UseUITargetAppProvidedByTests = false }]) {
    assert.throws(() => configureIOSUIXctestrun(edit(generated, mutate), configuration))
  }
})

test('source-clean gate includes UI harness and interaction fixture, with hashes before and after', t => {
  const folder = temp(t)
  const git = args => execFileSync('git', args, { cwd: folder, encoding: 'utf8' })
  git(['init', '-q'])
  mkdirSync(resolve(folder, 'scripts'), { recursive: true })
  mkdirSync(resolve(folder, 'examples/apps/ios-interaction-app'), { recursive: true })
  writeFileSync(resolve(folder, 'scripts/ios-ui-test-contracts.mjs'), 'export const version = 1\n')
  writeFileSync(resolve(folder, 'examples/apps/ios-interaction-app/app.js'), 'App({})\n')
  git(['add', '.'])
  git(['-c', 'user.name=Contract Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'])
  const before = captureIOSUIHarnessSource(folder)
  assert.equal(before.workingTreeDirty, false)
  writeFileSync(resolve(folder, 'scripts/ios-ui-test-uncommitted.mjs'), 'export const unsafe = true\n')
  const after = captureIOSUIHarnessSource(folder)
  assert.equal(after.sourceCommit, before.sourceCommit)
  assert.equal(after.workingTreeDirty, true)
  assert(after.files['scripts/ios-ui-test-uncommitted.mjs'])
  rmSync(resolve(folder, 'scripts/ios-ui-test-uncommitted.mjs'))
  writeFileSync(resolve(folder, 'examples/apps/ios-interaction-app/app.js'), 'App({ changed: true })\n')
  assert.equal(captureIOSUIHarnessSource(folder).workingTreeDirty, true)
  git(['checkout', '--', 'examples/apps/ios-interaction-app/app.js'])
  writeFileSync(resolve(folder, 'unrelated.txt'), 'outside execution inputs')
  assert.deepEqual(captureIOSUIHarnessSource(folder), before)
})

test('official report passes only with same-session presented frames, actual state and restored geometry', () => {
  const report = uiReport()
  const result = validateIOSUIReport(report, expected)
  assert.equal(result.status, 'passed')
  assert(result.limitations.some(text => text.includes('background timer')))
  const mutations = [
    x => { x.status = 'unknown' }, x => { x.targetPid = 0 }, x => { x.runnerPid = x.targetPid },
    x => { delete x.recordedFailureCount }, x => { x.recordedFailureCount = 1 }, x => { x.recordedFailureCount = '0' },
    x => { x.steps[2].surface.sessionId = 'replacement' }, x => { x.steps[2].surface.pid = 333 },
    x => { x.steps[2].surface.presentedFrameId = 1 }, x => { x.steps[2].surfaceFrame.width = 1 },
    x => { x.steps[0].surface.pageData.count = 1 }, x => { x.steps[2].surface.pageData.timerCount = 0 },
    x => { x.steps[2].surface.pageData.microtaskCount = 0 }, x => { x.steps[3].appState = 4 },
    x => { x.steps[3].surface = x.steps[2].surface }, x => { x.steps[4].surface.pageData.lifecycleTrace = ['page:show'] },
    x => { x.steps[5].surface.viewport = x.steps[0].surface.viewport; x.steps[5].surfaceFrame = x.steps[0].surfaceFrame },
    x => { x.steps[6].surface.viewport = x.steps[5].surface.viewport; x.steps[6].surfaceFrame = x.steps[5].surfaceFrame },
    x => { x.orientationRestored = false }, x => { x.actions.resume.api = 'XCUIApplication.launch' },
    x => { x.steps[2].screenshot.file = '../outside.png' }, x => { x.steps[2].screenshot.file = 'screenshots/initial.png' },
    x => { x.steps.reverse() }, x => { x.steps[2].atUnixMs = 1 }
  ]
  for (const mutate of mutations) assert.throws(() => validateIOSUIReport(edit(report, mutate), expected))
})

test('orientation uses the observed UIWindowScene interface, preserves unknown sensor and restores exact landscape mapping', () => {
  // UIOrientation.h: interface landscape-left aliases device landscape-right;
  // interface landscape-right aliases device landscape-left. Raw values already match.
  assert.equal(iosDeviceOrientationForInterface(1), 1)
  assert.equal(iosDeviceOrientationForInterface(3), 3)
  assert.equal(iosDeviceOrientationForInterface(4), 4)
  for (const raw of [0, 2, 5, 6, null, '1']) assert.throws(() => iosDeviceOrientationForInterface(raw), /unknown or unsupported/)
  const report = uiReport()
  assert.equal(validateIOSUIReport(report, expected).status, 'passed')
  for (const interfaceRaw of [3, 4]) {
    const landscape = edit(report, x => {
      x.initialOrientation = { source: 'UIWindowScene.interfaceOrientation', deviceSensorRawValue: 0, interfaceRawValue: interfaceRaw, restoreDeviceRawValue: interfaceRaw }
      x.actions.rotate = { api: 'XCUIDevice.orientation', fromInterfaceRawValue: interfaceRaw, toInterfaceRawValue: 1, deviceRawValue: 1 }
      x.actions.restore = { api: 'XCUIDevice.orientation', interfaceRawValue: interfaceRaw, deviceRawValue: interfaceRaw }
      for (const step of x.steps.filter(value => value.surface)) {
        const rotated = step.phase === 'rotated'
        step.surface.interfaceOrientation = rotated ? 1 : interfaceRaw
        step.surface.viewport = rotated ? { width: 390, height: 844 } : { width: 844, height: 390 }
        step.surfaceFrame = step.surface.viewport
      }
    })
    assert.equal(validateIOSUIReport(landscape, expected).status, 'passed')
    const doubleSwapped = edit(landscape, x => {
      x.initialOrientation.restoreDeviceRawValue = interfaceRaw === 3 ? 4 : 3
      x.actions.restore.deviceRawValue = x.initialOrientation.restoreDeviceRawValue
    })
    assert.throws(() => validateIOSUIReport(doubleSwapped, expected), /exact restore mapping/)
  }
  for (const mutate of [x => { x.steps[0].surface.interfaceOrientation = 0 },
    x => { x.steps[5].surface.interfaceOrientation = 3 },
    x => { x.steps[6].surface.interfaceOrientation = 3 },
    x => { x.initialOrientation.restoreDeviceRawValue = 4 },
    x => { x.initialOrientation.source = 'guessed-from-width' },
    x => { x.initialOrientation.deviceSensorRawValue = 7 },
    x => { x.actions.rotate.deviceRawValue = 3 },
    x => { x.actions.restore.deviceRawValue = 4 },
    x => { x.steps[4].surface.interfaceOrientation = 3 },
    x => { delete x.initialOrientation }]) {
    assert.throws(() => validateIOSUIReport(edit(report, mutate), expected))
  }
})

test('native trace binds OS input, hide/show, resize and persisted final presentation', () => {
  const report = uiReport()
  const trace = traceFor(report)
  assert.equal(validateIOSUITrace(trace, report).finalPresentedFrameId, 7)
  for (const mutate of [x => { x.dropped = 1 }, x => { x.sessionId = 'foreign' },
    x => { x.events[0].requestTruncated = true }, x => { x.events.shift() },
    x => { x.events.splice(1, 1) }, x => { x.events.splice(3, 1) }, x => { x.events.pop() },
    x => { x.events[0].requestJson = JSON.stringify({ sessionId: 'foreign', payload: { events: [] } }) }]) {
    assert.throws(() => validateIOSUITrace(edit(trace, mutate), report))
  }
})

test('lease never steals stale ownership and refuses modified release identity', t => {
  const base = temp(t)
  const first = acquireIOSUILease({ udid, runID: 'first', base, pid: 123 })
  assert.throws(() => acquireIOSUILease({ udid, runID: 'second', base, pid: 456 }), /already exists/)
  const ownerPath = resolve(first.directory, 'owner.json')
  const original = readFileSync(ownerPath)
  writeFileSync(ownerPath, JSON.stringify({ token: 'foreign', pid: 123, runID: 'first' }))
  assert.throws(() => first.release(), /identity changed/)
  assert(existsSync(first.directory))
  writeFileSync(ownerPath, original)
  first.release()
  assert.equal(existsSync(first.directory), false)
})

test('PID observation adopts only acknowledged exact unique bundles and rejects replacement', () => {
  const resources = [{ installed: true, bundleId: 'com.example.owned', pid: null }]
  const line = pid => `${pid}\t0\tUIKitApplication:com.example.owned[ABCD]\n444\t0\tUIKitApplication:com.example.other[DDDD]`
  assert.equal(observeIOSUIPIDs(resources, line(111)), true)
  assert.equal(resources[0].pid, 111)
  assert.equal(observeIOSUIPIDs(resources, line(111)), false)
  assert.throws(() => observeIOSUIPIDs(resources, line(222)), /identity changed/)
  assert.throws(() => observeIOSUIPIDs([{ ...resources[0], installed: false }], line(111)), /unacknowledged/)
})

test('cleanup independently preserves ambiguity and verifies exact acknowledged bundle absence', () => {
  const owner = bundleId => ({ owned: true, udid, bundleId, installed: true, installAttempted: true, pid: 111 })
  const resources = [owner('com.example.good'), { ...owner('com.example.ambiguous'), installed: false }]
  const commands = []
  const absence = []
  const result = cleanupIOSUIResources(resources, args => {
    commands.push(args)
    return { status: 0, stdout: args[0] === 'spawn' ? '111 0 UIKitApplication:com.example.good[A]' : '', stderr: '' }
  }, (_, bundleId) => absence.push(bundleId))
  assert.equal(result.status, 'failed')
  assert.equal(result.items[0].status, 'blocked-unowned')
  assert.deepEqual(absence, ['com.example.good'])
  assert.equal(commands.some(args => args.includes('com.example.ambiguous')), false)
  const failed = cleanupIOSUIResources([owner('com.example.good'), owner('com.example.changed')], args => {
    commands.push(args)
    return { status: 0, stdout: args[0] === 'spawn' ? '222 0 UIKitApplication:com.example.changed[A]' : '', stderr: '' }
  }, () => {})
  assert.equal(failed.items[0].status, 'failed')
  assert.equal(failed.items[1].status, 'passed')
})

test('tree fingerprints bind file bytes and link targets without traversing symlinks', t => {
  const folder = temp(t)
  writeFileSync(resolve(folder, 'Info.plist'), 'first')
  symlinkSync('/never-follow-this', resolve(folder, 'framework'))
  const first = fingerprintIOSUITree(folder)
  assert.equal(first.files.framework.target, '/never-follow-this')
  writeFileSync(resolve(folder, 'Info.plist'), 'second')
  assert.notEqual(fingerprintIOSUITree(folder).root, first.root)
})

test('command receipts retain combined logs but stdout remains machine-parseable', t => {
  const runner = createIOSUICommandRunner(temp(t))
  const result = runner.sync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ok:true})); process.stderr.write("notice")'])
  assert.deepEqual(JSON.parse(result.stdout), { ok: true })
  assert.equal(result.stderr, 'notice')
  assert.equal(readFileSync(runner.commands[0].logPath, 'utf8'), '{"ok":true}notice')
})

test('owned subprocess abort is scoped and cleanup commands remain available', async t => {
  const controller = new AbortController()
  const runner = createIOSUICommandRunner(temp(t), { signal: controller.signal })
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  t.after(() => { if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill('SIGTERM') })
  const pending = runner.owned(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 3000 })
  const timer = setTimeout(() => controller.abort(new Error('contract cancellation')), 100)
  const result = await pending
  clearTimeout(timer)
  assert.match(result.error, /contract cancellation/)
  assert.equal(unrelated.exitCode, null)
  assert.equal(unrelated.signalCode, null)
  assert.throws(() => runner.sync(process.execPath, ['-e', '']), /contract cancellation/)
  assert.equal(runner.sync(process.execPath, ['-e', ''], { allowAborted: true }).status, 0)
})

test('owned subprocess deadline produces a failed command receipt', async t => {
  const runner = createIOSUICommandRunner(temp(t))
  const result = await runner.owned(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 })
  assert.match(result.error, /deadline/)
  assert.notEqual(result.status, 0)
  assert.equal(runner.commands[0].error, result.error)
})
