import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const UI_REPORT_FILE = 'weapp-ios-ui-test-report.json'
export const UI_SURFACE_IDENTIFIER = 'weapp-container-surface'
export const UI_PHASES = ['initial', 'tap', 'timer', 'background', 'resumed', 'rotated', 'restored']
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
const integer = value => Number.isSafeInteger(value) && value > 0
export const validUDID = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '')
export const validBundle = value => /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(value ?? '')
export function iosDeviceOrientationForInterface(raw) {
  // Public UIKit/UIOrientation.h already swaps the landscape symbol values:
  // UIInterfaceOrientationLandscapeLeft = UIDeviceOrientationLandscapeRight = 4;
  // UIInterfaceOrientationLandscapeRight = UIDeviceOrientationLandscapeLeft = 3.
  // Portrait is 1 in both enums. The symbolic conversion therefore keeps raw values.
  const mapped = new Map([[1, 1], [3, 3], [4, 4]]).get(raw)
  requireValue(mapped !== undefined, 'window interface orientation is unknown or unsupported')
  return mapped
}

export function inside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false
  if (!isAbsolute(parent) || !isAbsolute(child)) return false
  const path = relative(parent, child)
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)
}

export function parseIOSUIOptions(args, { root, runID }) {
  requireValue(/^[a-zA-Z0-9-]+$/.test(runID ?? ''), 'explicit safe run identity required')
  const result = { engine: 'quickjs', timeoutSeconds: 180, root, runID }
  const names = new Map([['--udid', 'udid'], ['--engine', 'engine'], ['--pack', 'pack'],
    ['--out-dir', 'outDir'], ['--timeout-seconds', 'timeoutSeconds']])
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index])
    requireValue(name && args[index + 1] && !args[index + 1].startsWith('--'), `unknown or incomplete argument: ${args[index]}`)
    requireValue(!Object.hasOwn(result, '_' + name), `duplicate argument: ${args[index]}`)
    result[name] = args[index + 1]
    result['_' + name] = true
  }
  for (const key of Object.keys(result)) if (key.startsWith('_')) delete result[key]
  requireValue(validUDID(result.udid), 'an explicit borrowed simulator --udid is required')
  requireValue(['quickjs', 'v8'].includes(result.engine), 'ERR_ENGINE: engine must be quickjs or v8')
  requireValue(result.pack, '--pack must name a portable interaction fixture with a real JS timer')
  result.pack = resolve(root, result.pack)
  result.outDir = resolve(root, result.outDir ?? `artifacts/ios-embedding-ui/run-${runID}`)
  requireValue(inside(root, result.outDir) && result.outDir.startsWith(resolve(root, 'artifacts') + sep), '--out-dir must be a new directory below the repository artifacts directory')
  result.timeoutSeconds = Number(result.timeoutSeconds)
  requireValue(integer(result.timeoutSeconds) && result.timeoutSeconds >= 30 && result.timeoutSeconds <= 900, 'timeout must be an integer between 30 and 900 seconds')
  result.autBundleId = `com.sonofmagic.weapp.container.uiapp.run-${runID}`
  result.testBundleId = `com.sonofmagic.weapp.container.uitests.run-${runID}`
  return result
}

export function validateIOSUIBuildProduct(product, build, options) {
  requireValue(product?.schemaVersion === 1 && product.engine === options.engine && product.appMode === 'embedding', 'build-only product has the wrong schema, engine or app mode')
  requireValue(product.bundleId === options.autBundleId && typeof product.sessionId === 'string' && product.sessionId.length > 0, 'build-only product has the wrong app identity')
  const buildRoot = resolve(options.outDir, 'app-build')
  for (const field of ['appPath', 'buildReceiptPath', 'runDirectory']) requireValue(inside(buildRoot, product[field]), `build-only ${field} escaped the owned build directory`)
  requireValue(product.appPath.endsWith('.app') && inside(product.runDirectory, product.appPath) && inside(product.runDirectory, product.buildReceiptPath), 'build-only app/receipt must belong to its run directory')
  requireValue(/^[0-9a-f]{64}$/.test(product.buildReceiptSha256 ?? '') && /^[0-9a-f]{64}$/.test(product.artifactSha256 ?? ''), 'build-only artifact and receipt hashes are required')
  requireValue(build?.schemaVersion === 1 && build.status === 'passed' && build.host === 'ios'
    && build.engine === options.engine && build.appMode === 'embedding' && build.workingTreeDirty === false
    && /^[0-9a-f]{64}$/.test(build.artifactSha256 ?? '') && /^[0-9a-f]{40}$/.test(build.sourceCommit ?? ''), 'a clean source-bound embedding build receipt is required')
  return product
}

/** Xcode emits v1 for schemes without a test plan and v2 for test configurations. */
export function iosUIXctestrunTarget(generated) {
  const format = generated?.__xctestrun_metadata__?.FormatVersion
  let target
  if (format === 1) {
    requireValue(!Object.hasOwn(generated, 'TestConfigurations'), 'format 1 cannot contain format 2 test configurations')
    const targets = Object.entries(generated).filter(([name]) => name !== '__xctestrun_metadata__')
    requireValue(targets.length === 1 && targets[0][0] === 'WeappContainerUITests', 'exactly one named format 1 UI test target required')
    target = targets[0][1]
  } else if (format === 2) {
    requireValue(!Object.values(generated).some(value => value?.IsUITestBundle === true || value?.ProductModuleName), 'format 2 cannot contain format 1 top-level test targets')
    requireValue(Array.isArray(generated.TestConfigurations), 'format 2 requires test configurations')
    const configurations = generated.TestConfigurations.filter(value => value?.IsEnabled !== false)
    requireValue(configurations.length === 1 && Array.isArray(configurations[0].TestTargets)
      && configurations[0].TestTargets.length === 1, 'exactly one enabled configuration and UI test target required')
    target = configurations[0].TestTargets[0]
  } else throw new Error('xcodebuild must generate supported xctestrun format 1 or 2')
  requireValue(target && typeof target === 'object' && !Array.isArray(target), 'invalid generated UI testing target')
  requireValue(target.ProductModuleName === 'WeappContainerUITests' && target.IsUITestBundle === true, 'unexpected generated UI testing target')
  requireValue(target.TestingEnvironmentVariables && typeof target.TestingEnvironmentVariables === 'object'
    && !Array.isArray(target.TestingEnvironmentVariables), 'generated XCTest bootstrap environment is missing')
  return target
}

/** Simulator execution retains Xcode's local runner artifacts and bootstrap. */
export function configureIOSUIXctestrun(generated, options) {
  const result = structuredClone(generated)
  const target = iosUIXctestrunTarget(result)
  requireValue(validBundle(options.runnerBundleId) && validBundle(options.autBundleId) && options.runnerBundleId !== options.autBundleId, 'distinct runner and app bundle identities required')
  requireValue(/^PlugIns\/[A-Za-z0-9_.-]+\.xctest$/.test(options.testBundleRelativePath), 'test bundle must be the generated runner PlugIns bundle')
  requireValue(target.UseDestinationArtifacts !== true && !Object.hasOwn(target, 'TestBundleDestinationRelativePath'), 'destination artifacts are device-only and cannot be used for simulator testing')
  requireValue(target.TestHostBundleIdentifier === options.runnerBundleId, 'generated runner bundle differs from the acknowledged task bundle')
  requireValue(typeof target.TestHostPath === 'string' && /^__TESTROOT__\/[A-Za-z0-9_.\/-]+\.app$/.test(target.TestHostPath)
    && !target.TestHostPath.split('/').includes('..'), 'generated simulator runner path is missing or invalid')
  const expectedBundlePath = '__TESTHOST__/' + options.testBundleRelativePath
  requireValue(target.TestBundlePath === expectedBundlePath
    || target.TestBundlePath === target.TestHostPath + '/' + options.testBundleRelativePath, 'generated test bundle must belong to the local runner App')
  requireValue(Array.isArray(target.DependentProductPaths) && target.DependentProductPaths.length > 0
    && target.DependentProductPaths.every(path => path === target.TestHostPath || path === target.TestHostPath + '/' + options.testBundleRelativePath),
  'generated dependent products must belong only to the task runner')
  requireValue(target.UseUITargetAppProvidedByTests === true && !Object.hasOwn(target, 'UITargetAppPath')
    && !Object.hasOwn(target, 'UITargetAppBundleIdentifier'), 'standalone UI runner must use only the App explicitly supplied by the test')
  target.EnvironmentVariables = { ...target.EnvironmentVariables,
    WEAPP_CONTAINER_UI_TARGET_BUNDLE_ID: options.autBundleId,
    WEAPP_CONTAINER_UI_SESSION_ID: options.sessionId }
  target.OnlyTestIdentifiers = ['WeappContainerUITests/testNativeInteraction']
  target.ParallelizationEnabled = false
  target.SystemAttachmentLifetime = 'keepAlways'
  target.UserAttachmentLifetime = 'keepAlways'
  return result
}

export function iosUIExecutionArguments({ xctestrun, udid, outDir, timeoutSeconds }) {
  requireValue(validUDID(udid), 'explicit simulator UDID required')
  return ['test-without-building', '-xctestrun', xctestrun, '-destination', `platform=iOS Simulator,id=${udid}`,
    '-parallel-testing-enabled', 'NO', '-maximum-concurrent-test-simulator-destinations', '1',
    '-disable-concurrent-destination-testing', '-test-timeouts-enabled', 'YES',
    '-default-test-execution-time-allowance', String(timeoutSeconds),
    '-maximum-test-execution-time-allowance', String(timeoutSeconds),
    '-resultBundlePath', resolve(outDir, 'interaction.xcresult')]
}

export function validateIOSUIReport(report, expected) {
  requireValue(report?.schemaVersion === 1 && report.status === 'passed' && report.evidenceBoundary === 'xctest-os-interaction', 'no passed official UI interaction receipt')
  requireValue(report.recordedFailureCount === 0, 'XCTest receipt must record exactly zero failures')
  requireValue(report.targetBundleId === expected.autBundleId && report.runnerBundleId === expected.runnerBundleId
    && report.sessionId === expected.sessionId && report.surfaceIdentifier === UI_SURFACE_IDENTIFIER, 'UI receipt identity differs from this run')
  requireValue(integer(report.targetPid) && integer(report.runnerPid) && report.targetPid !== report.runnerPid, 'distinct observed app and runner PIDs required')
  requireValue(report.orientationRestored === true, 'borrowed simulator orientation was not restored')
  requireValue(Array.isArray(report.steps) && report.steps.length === UI_PHASES.length
    && report.steps.every((step, index) => step.phase === UI_PHASES[index]), 'UI sequence is missing, duplicated or reordered')
  let lastTime = -1
  for (const step of report.steps) {
    requireValue(Number.isFinite(step.atUnixMs) && step.atUnixMs >= lastTime, 'UI receipt timestamps are not ordered')
    lastTime = step.atUnixMs
    requireValue(step.screenshot && /^[0-9a-f]{64}$/.test(step.screenshot.sha256 ?? '')
      && step.screenshot.file === `screenshots/${step.phase}.png`, 'every UI phase requires its own hashed OS screenshot')
    if (step.phase === 'background') {
      requireValue([2, 3].includes(step.appState) && !Object.hasOwn(step, 'surface'), 'background must be observed from XCUIApplication.state')
      continue
    }
    const surface = step.surface
    requireValue(step.appState === 4 && surface?.schemaVersion === 1 && surface.sessionId === expected.sessionId
      && surface.pid === report.targetPid && surface.foreground === true && surface.closed === false && surface.failed === false,
    'foreground surface does not belong to the same live app/session')
    requireValue(integer(surface.frameId) && surface.presentedFrameId === surface.frameId, 'surface has no matching completed presentation')
    requireValue(surface.viewport && Number.isFinite(surface.viewport.width) && Number.isFinite(surface.viewport.height)
      && surface.viewport.width > 80 && surface.viewport.height > 80
      && Math.abs(surface.viewport.width - step.surfaceFrame?.width) <= 1
      && Math.abs(surface.viewport.height - step.surfaceFrame?.height) <= 1, 'AX surface geometry differs from runtime logical viewport')
    requireValue(surface.pageData && Array.isArray(surface.pageData.lifecycleTrace), 'read-only page state is missing')
    iosDeviceOrientationForInterface(surface.interfaceOrientation)
    requireValue(surface.interfaceOrientation === 1 ? surface.viewport.height > surface.viewport.width
      : surface.viewport.width > surface.viewport.height, 'window interface orientation differs from the logical viewport aspect')
  }
  const phases = Object.fromEntries(report.steps.map(step => [step.phase, step]))
  const initial = phases.initial.surface
  const orientation = report.initialOrientation
  requireValue(orientation?.source === 'UIWindowScene.interfaceOrientation'
    && Number.isInteger(orientation.deviceSensorRawValue) && orientation.deviceSensorRawValue >= 0 && orientation.deviceSensorRawValue <= 6
    && orientation.interfaceRawValue === initial.interfaceOrientation
    && orientation.restoreDeviceRawValue === iosDeviceOrientationForInterface(initial.interfaceOrientation),
  'initial window orientation, sensor observation and exact restore mapping are required')
  for (const phase of ['tap', 'timer', 'resumed', 'restored']) requireValue(phases[phase].surface.interfaceOrientation === initial.interfaceOrientation,
    'window interface orientation changed before rotation or was not exactly restored')
  requireValue(initial.pageData.count === 0 && initial.pageData.timerCount === 0 && initial.pageData.microtaskCount === 0
    && !initial.pageData.lifecycleTrace.includes('page:hide'), 'initial session was not pristine or emitted artificial hide')
  requireValue(phases.tap.surface.pageData.count === 1, 'official coordinate tap did not update page data')
  for (const phase of ['timer', 'resumed', 'rotated', 'restored']) {
    requireValue(phases[phase].surface.pageData.count === 1 && phases[phase].surface.pageData.timerCount === 1
      && phases[phase].surface.pageData.microtaskCount === 1, 'real JS timer/microtask result or page state was lost')
    requireValue(phases[phase].surface.frameId > initial.frameId, 'interaction did not produce a later frame')
  }
  const lifecycle = phases.resumed.surface.pageData.lifecycleTrace
  const hide = lifecycle.indexOf('page:hide')
  requireValue(hide >= 0 && lifecycle.indexOf('page:show', hide + 1) > hide, 'Home and activation did not produce hide then show')
  const rotated = phases.rotated.surface.viewport
  const rotatedInterface = phases.rotated.surface.interfaceOrientation
  requireValue((rotatedInterface === 1) !== (initial.interfaceOrientation === 1), 'rotation must change the window interface orientation aspect')
  requireValue(Math.abs(rotated.width - initial.viewport.width) > 1 && Math.abs(rotated.height - initial.viewport.height) > 1, 'device orientation did not resize the actual app surface')
  const restored = phases.restored.surface.viewport
  requireValue(Math.abs(restored.width - initial.viewport.width) <= 1 && Math.abs(restored.height - initial.viewport.height) <= 1, 'original logical viewport was not restored')
  requireValue(report.actions?.tap?.logicalX === 40 && report.actions?.tap?.logicalY === 40
    && report.actions.tap.api === 'XCUICoordinate.tap' && report.actions.home?.api === 'XCUIDevice.press(home)'
    && report.actions.resume?.api === 'XCUIApplication.activate'
    && report.actions.rotate?.api === 'XCUIDevice.orientation'
    && report.actions.rotate.fromInterfaceRawValue === initial.interfaceOrientation
    && report.actions.rotate.toInterfaceRawValue === rotatedInterface
    && report.actions.rotate.deviceRawValue === iosDeviceOrientationForInterface(rotatedInterface)
    && report.actions.restore?.api === 'XCUIDevice.orientation'
    && report.actions.restore.interfaceRawValue === initial.interfaceOrientation
    && report.actions.restore.deviceRawValue === orientation.restoreDeviceRawValue,
  'official OS action provenance or exact interface/device orientation mapping is incomplete')
  return { schemaVersion: 1, status: 'passed', evidenceBoundary: report.evidenceBoundary,
    sessionId: expected.sessionId, targetPid: report.targetPid, runnerPid: report.runnerPid,
    phases: UI_PHASES, limitations: ['Official simulator OS interaction only', 'No physical-device GPU, DevTools parity or performance acceptance', 'The timer runs in the foreground; background timer scheduling is not certified'] }
}

export function validateIOSUITrace(trace, report) {
  requireValue(trace?.schemaVersion === 1 && trace.sessionId === report.sessionId
    && trace.dropped === 0 && Array.isArray(trace.events), 'native trace is missing, belongs to another session or dropped events')
  requireValue(trace.events.every(event => event.requestTruncated !== true && event.responseTruncated !== true), 'native interaction trace was truncated')
  const operations = trace.events.filter(event => event.kind === 'operation')
  const requests = operations.map(event => ({ op: event.op, request: JSON.parse(event.requestJson) }))
  const taps = requests.filter(event => event.op === 'event.batch').flatMap(event => {
    requireValue(event.request.sessionId === report.sessionId, 'native input belongs to another session')
    return event.request.payload?.events ?? []
  })
  requireValue(taps.some(event => event.type === 'touchstart') && taps.some(event => event.type === 'touchend')
    && taps.some(event => event.type === 'tap'), 'native trace did not receive the official tap sequence')
  const lifecycle = requests.filter(event => event.op === 'app.lifecycle').map(event => {
    requireValue(event.request.sessionId === report.sessionId, 'native lifecycle belongs to another session')
    return event.request.payload?.event
  })
  const hide = lifecycle.indexOf('hide')
  requireValue(hide >= 0 && lifecycle.indexOf('show', hide + 1) > hide, 'native trace has no Home/activate hide/show pair')
  requireValue(requests.filter(event => event.op === 'host.resize').length >= 2, 'native trace has no rotation/restore resizes')
  const lastFrame = report.steps.at(-1).surface.frameId
  requireValue(requests.some(event => event.op === 'render.commit' && event.request.sessionId === report.sessionId
    && event.request.payload?.frameId === lastFrame), 'final presented frame is not yet persisted in native trace')
  return { schemaVersion: 1, status: 'passed', sessionId: trace.sessionId, eventCount: trace.events.length,
    finalPresentedFrameId: lastFrame, dropped: trace.dropped }
}
