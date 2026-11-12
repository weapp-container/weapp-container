#!/usr/bin/env node
/**
 * Run the platform app smoke harnesses on owned Android/iOS/Harmony targets.
 *
 * This is deliberately separate from host-device-smoke.mjs: a reachable shell
 * does not prove that the Rust host was loaded or that a bridge batch rendered.
 * The report keeps command output and classifies missing SDK/app artifacts,
 * unavailable targets and software renderer runs as blocked instead of
 * silently passing them.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { parseGpuProbe, parseSurfaceProbe } from './mobile-gpu-probe.mjs'
import { hasHarmonyRuntimeCrash } from './mobile-runtime-parser.mjs'
import { collectPackExecutionEvidence, inspectPackExecutionReceipt } from './pack-execution-evidence.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 && args[outIndex + 1] ? resolve(args[outIndex + 1]) : null
const apkIndex = args.indexOf('--android-apk')
const iosAppIndex = args.indexOf('--ios-app')
const androidApk = resolve(apkIndex >= 0 && args[apkIndex + 1]
  ? args[apkIndex + 1]
  : 'examples/hosts/android/app/build/outputs/apk/debug/app-debug.apk')
const iosApp = resolve(iosAppIndex >= 0 && args[iosAppIndex + 1]
  ? args[iosAppIndex + 1]
  : 'artifacts/ios-app-metal/WeappContainerApp.app')
const requireAll = args.includes('--require-all')
const engineIndex = args.indexOf('--engine')
const expectedEngine = engineIndex >= 0 ? args[engineIndex + 1] : 'quickjs'
if (!['quickjs', 'v8'].includes(expectedEngine)) throw new Error('--engine must be quickjs or v8')
const requested = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--platform' && args[index + 1]) requested.push(args[index + 1])
}
const platforms = requested.length ? requested : ['android', 'ios', 'harmony']

// A runtime smoke can prove that the bridge and snapshot code executed while
// still using the deterministic software renderer.  That is useful debugging
// evidence, but it cannot satisfy the mobile native-surface gate.  Keep the
// two outcomes separate so a successful process launch never gets reported as
// a native renderer pass.
const NATIVE_RENDERER_REQUIREMENT = 'native-skia-surface'
// A feature-enabled Skia renderer currently owns a CPU raster surface. Only
// an explicitly attached platform GPU context can satisfy this gate. Keep
// backend names versioned so a future host adapter cannot accidentally
// promote a raster readback to device evidence.
const NATIVE_RENDERER_BACKENDS = new Set([
  'skia-gpu',
  'skia-gpu-canvaskit',
  'skia-gpu-window',
  'skia-gpu-gles',
  'skia-gpu-vulkan',
  'skia-gpu-metal',
  'skia-gpu-arkui',
])

function gitRevision(cwd = root) {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function pinnedCompilerCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD:vendor/weapp-vite'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function runtimeEnvironment(target = null) {
  return {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    target,
    rendererRequirement: NATIVE_RENDERER_REQUIREMENT,
  }
}

function artifactDigest(path) {
  if (!path || !existsSync(path)) return null
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

function applyRendererGate(report, rendererBackend) {
  const native = NATIVE_RENDERER_BACKENDS.has(rendererBackend)
  report.rendererBackend = rendererBackend || null
  report.nativeSurface = native
  report.rendererRequirement = NATIVE_RENDERER_REQUIREMENT
  if (!native && report.status === 'passed') {
    report.runtimeStatus = 'passed'
    report.status = 'blocked'
    report.reason = rendererBackend
      ? `renderer backend ${rendererBackend} is not an attached GPU surface`
      : 'renderer backend was not reported by the runtime'
    report.gate = 'blocked-native-renderer'
  } else {
    report.runtimeStatus = report.status
    report.gate = report.status === 'passed' ? 'passed' : 'blocked-runtime'
  }
  return report
}

function commandPath(command) {
  const resolver = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(resolver, [command], { encoding: 'utf8' })
  return result.status === 0 ? (result.stdout || '').trim().split(/\r?\n/)[0] : null
}

function run(command, commandArgs, options = {}) {
  const path = commandPath(command) || command
  const result = spawnSync(path, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeoutMs || 45_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  })
  return {
    command: [path, ...commandArgs].join(' '),
    status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

function firstAndroidSerial(stdout) {
  return stdout.split(/\r?\n/).slice(1)
    .map(line => line.trim().split(/\s+/))
    .find(parts => parts[0] && parts[1] === 'device')?.[0] || null
}

function parsePlistValue(path, key) {
  const result = run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path])
  return result.status === 'passed' ? result.stdout.trim() : null
}

function androidSmoke() {
  const list = run('adb', ['devices'])
  const serial = process.env.WEAPP_CONTAINER_ANDROID_SERIAL || firstAndroidSerial(list.stdout)
  if (!serial) {
    return {
      platform: 'android',
      status: 'blocked',
      runtimeStatus: 'blocked',
      gate: 'blocked-environment',
      reason: 'no online adb device',
      environment: runtimeEnvironment(),
      probes: [list],
    }
  }
  if (!existsSync(androidApk)) {
    return {
      platform: 'android',
      status: 'blocked',
      runtimeStatus: 'blocked',
      gate: 'blocked-artifact',
      serial,
      reason: `APK not found: ${androidApk}`,
      environment: runtimeEnvironment(serial),
      probes: [list],
    }
  }
  const install = run('adb', ['-s', serial, 'install', '-r', androidApk])
  const clear = run('adb', ['-s', serial, 'logcat', '-c'])
  const stop = run('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'com.sonofmagic.weapp.container'])
  const clearReceipt = run('adb', ['-s', serial, 'shell', 'run-as', 'com.sonofmagic.weapp.container', 'rm', '-f', 'files/portable-pack-execution.json'])
  const expectedSessionId = `android-${randomUUID()}`
  const start = run('adb', ['-s', serial, 'shell', 'am', 'start', '-n', 'com.sonofmagic.weapp.container/.MainActivity',
    '--es', 'weappContainerEngine', expectedEngine, '--es', 'weappContainerSessionId', expectedSessionId])
  // Activity startup and native library loading are asynchronous. Give the
  // process a short deterministic window before taking the logcat snapshot;
  // otherwise a successful launch can be misclassified as an empty run.
  run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 2_000 })
  const logcat = run('adb', ['-s', serial, 'logcat', '-d', '-v', 'brief', '-s', 'WEAPP_CONTAINER_SMOKE:I', 'WEAPP_CONTAINER_GPU_PROBE:I', 'WEAPP_CONTAINER_SURFACE_PROBE:I', '*:S'])
  // Logcat truncates individual lines. The app atomically saves the complete
  // startup/manifest/frame receipt after its GPU callback, so large snapshots
  // and module sources are validated from this owned launch's file instead.
  const readReceipt = run('adb', ['-s', serial, 'shell', 'run-as', 'com.sonofmagic.weapp.container', 'cat', 'files/portable-pack-execution.json'])
  // Release the owned launch before parsing untrusted app evidence. A
  // malformed receipt must never strand an activity through a parser error.
  const cleanup = run('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'com.sonofmagic.weapp.container'])
  let executionReceipt = null
  if (clearReceipt.status === 'passed' && readReceipt.status === 'passed') {
    try { executionReceipt = JSON.parse(readReceipt.stdout) } catch { /* Invalid bytes stay missing evidence. */ }
  }
  const executionTarget = { host: 'android', id: serial, kind: serial.startsWith('emulator-') ? 'official-simulator' : 'device' }
  const artifactSha256 = artifactDigest(androidApk)
  const runtimeReceipt = executionReceipt && inspectPackExecutionReceipt({
    ...executionReceipt, target: executionTarget, artifactSha256,
  }, executionReceipt.fixture, { root, expectedCommit: gitRevision(), expectedCompilerCommit: pinnedCompilerCommit() })
  const runtimeBodyPassed = runtimeReceipt && Object.entries(runtimeReceipt.checks)
    .filter(([name]) => !['source', 'build'].includes(name)).every(([, passed]) => passed)
  const smokeLines = logcat.stdout.split(/\r?\n/).filter(line => line.includes('WEAPP_CONTAINER_SMOKE'))
  const gpuProbeLines = logcat.stdout.split(/\r?\n/).filter(line => line.includes('WEAPP_CONTAINER_GPU_PROBE'))
  const surfaceProbeLines = logcat.stdout.split(/\r?\n/).filter(line => line.includes('WEAPP_CONTAINER_SURFACE_PROBE'))
  const gpuProbe = parseGpuProbe(gpuProbeLines, 'android-egl')
  const surfaceProbe = executionReceipt?.surfaceProbe || parseSurfaceProbe(surfaceProbeLines, 'android-gles-window')
  const operations = ['app.init', 'render.commit', 'render.snapshot', 'canvas.draw', 'canvas.snapshot', 'api.call']
  const output = smokeLines.join('\n')
  const missing = operations.filter(operation => !output.includes(` ${operation} `))
  const backendMatch = output.match(/"backend":"([^"]+)"/)
  // `render.commit` reports the runtime's raster backend before a host
  // surface is attached. Once the SurfaceView has successfully rendered into
  // its current FBO through Skia, the surface probe is the authoritative
  // renderer boundary for the native GPU gate. Keep the raster commit value
  // in the raw logs while promoting only an explicit attached GPU probe.
  const directSurface = surfaceProbe.status === 'passed'
    && surfaceProbe.hostSurfaceAttached === true
    && surfaceProbe.containerSurfaceAttached === true
    && surfaceProbe.gpuSurface === true
    && surfaceProbe.rendererBackend?.startsWith('skia-gpu')
  const rendererBackend = directSurface
    ? surfaceProbe.rendererBackend
    : backendMatch?.[1] || null
  const checks = {
    realPortablePack: Boolean(runtimeBodyPassed) && executionReceipt?.engine === expectedEngine && executionReceipt?.sessionId === expectedSessionId,
    appInitOk: runtimeReceipt?.checks.init === true && runtimeReceipt?.checks.session === true,
    renderCommitOk: runtimeReceipt?.checks.render === true && runtimeReceipt?.checks.operations === true,
    renderSnapshotRgba8: runtimeReceipt?.checks.snapshot === true,
    correlatedGpuFrame: runtimeReceipt && Object.entries(runtimeReceipt.gpu.checks)
      .filter(([name]) => name !== 'execution').every(([, passed]) => passed),
    canvasDrawOk: output.includes('"name":"wx.canvas.draw"') && output.includes('"canvasId":"main"'),
    canvasSnapshotRgba8: output.includes('canvas.snapshot') && output.includes('"format":"rgba8-premultiplied"') && output.includes('"pixels":[10,20,30,255'),
    canIUseStorage: output.includes('"name":"wx.canIUse"') && output.includes('"result":true'),
  }
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  const status = install.status === 'passed' && start.status === 'passed' && logcat.status === 'passed' && cleanup.status === 'passed' && missing.length === 0
    && failedChecks.length === 0 ? 'passed'
    : 'failed'
  return applyRendererGate({
    platform: 'android',
    status,
    environment: runtimeEnvironment(serial),
    serial,
    package: 'com.sonofmagic.weapp.container',
    artifact: androidApk,
    artifactDigestFile: androidApk,
    artifactSha256,
    expectedEngine,
    expectedSessionId,
    executionReceipt,
    executionTarget,
    executionReceiptInspection: runtimeReceipt,
    operations,
    rendererBackend,
    missingOperations: missing,
    checks,
    failedChecks,
    gpuProbe,
    surfaceProbe,
    probes: [list, install, clear, stop, clearReceipt, start, logcat, readReceipt, cleanup],
    notes: [
      'The runtime commit may report skia-raster before the host surface is attached; the surface probe records the final draw boundary.',
      'surfaceProbe satisfies the native renderer gate only when it reports skia-gpu-gles with containerSurfaceAttached=true and gpuSurface=true.',
      'The real portable-pack body uses correlated requests, responses and the committed manifest frame from the app-owned receipt. Unknown binary build provenance remains incomplete in the execution matrix.',
    ],
  }, rendererBackend)
}

function iosSmoke() {
  const devices = run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'])
  if (devices.status !== 'passed') return {
    platform: 'ios',
    status: 'blocked',
    runtimeStatus: 'blocked',
    gate: 'blocked-environment',
    reason: 'simctl unavailable',
    environment: runtimeEnvironment(),
    probes: [devices],
  }
  let booted = []
  try {
    booted = Object.values(JSON.parse(devices.stdout).devices || {}).flat().filter(device => device.state === 'Booted')
  } catch {
    return {
      platform: 'ios',
      status: 'failed',
      runtimeStatus: 'failed',
      gate: 'blocked-runtime',
      reason: 'simctl JSON was invalid',
      environment: runtimeEnvironment(),
      probes: [devices],
    }
  }
  if (!booted.length) return {
    platform: 'ios',
    status: 'blocked',
    runtimeStatus: 'blocked',
    gate: 'blocked-environment',
    reason: 'no booted simulator',
    environment: runtimeEnvironment(),
    probes: [devices],
  }
  if (!existsSync(iosApp)) {
    return {
      platform: 'ios',
      status: 'blocked',
      runtimeStatus: 'blocked',
      gate: 'blocked-artifact',
      udid: booted[0].udid,
      reason: `app bundle not found: ${iosApp}`,
      environment: runtimeEnvironment(booted[0].udid),
      probes: [devices],
    }
  }
  const bundleId = process.env.WEAPP_CONTAINER_IOS_BUNDLE_ID || parsePlistValue(resolve(iosApp, 'Info.plist'), 'CFBundleIdentifier')
  if (!bundleId) {
    return {
      platform: 'ios',
      status: 'failed',
      runtimeStatus: 'failed',
      gate: 'blocked-runtime',
      udid: booted[0].udid,
      reason: 'CFBundleIdentifier missing',
      environment: runtimeEnvironment(booted[0].udid),
      probes: [devices],
    }
  }
  const install = run('xcrun', ['simctl', 'install', booted[0].udid, iosApp])
  let appEvidence = null
  let evidenceFile = null
  const appContainer = run('xcrun', ['simctl', 'get_app_container', booted[0].udid, bundleId, 'data'])
  if (appContainer.status === 'passed') {
    const container = appContainer.stdout.trim()
    if (container) {
      evidenceFile = resolve(container, 'Library/Caches/weapp-ios-evidence.json')
      // `simctl install -r` preserves the data container. Remove the previous
      // result so a stale passed probe cannot satisfy this launch.
      run('rm', ['-f', evidenceFile])
    }
  }
  // UIKit apps continue running after simctl has returned.  In that mode
  // stdout is not a synchronization channel (and recent simulators may only
  // print the PID), so app-backed harnesses persist the same JSON probe in
  // their sandbox caches.  Keep --console for the executable Swift Package
  // smoke and merge the persisted evidence when it exists.
  // The app-backed harness writes evidence to its sandbox and exits after the
  // Metal command buffer completes. `--console` waits for stdout and can hit
  // its timeout on recent CoreSimulator versions even after the app has
  // produced a valid frame, so launch asynchronously and poll the evidence.
  const launch = run('xcrun', ['simctl', 'launch', booted[0].udid, bundleId], { timeoutMs: 10_000 })
  let output = `${launch.stdout}\n${launch.stderr}`
  if (evidenceFile) {
    const deadline = Date.now() + Number(process.env.WEAPP_CONTAINER_IOS_WAIT_MS || 8_000)
    while (Date.now() < deadline) {
      if (existsSync(evidenceFile)) {
        try {
          const candidate = JSON.parse(readFileSync(evidenceFile, 'utf8'))
          if (candidate && typeof candidate === 'object' && candidate.status) {
            appEvidence = candidate
            if (candidate.status === 'passed' || candidate.status === 'blocked') break
          }
        } catch {
          // The app writes atomically; a transient partial read is retried.
        }
      }
      sleepMs(100)
    }
  }
  if (appEvidence) {
    output += `\nWEAPP_CONTAINER_SURFACE_PROBE ${JSON.stringify(appEvidence)}`
    if (appEvidence.gpuProbe) output += `\nWEAPP_CONTAINER_GPU_PROBE ${JSON.stringify(appEvidence.gpuProbe)}`
    for (const [operation, record] of Object.entries(appEvidence.operations || {})) {
      output += `\nWEAPP_CONTAINER_IOS_SMOKE ${operation} status=${record?.status ?? 'unknown'} bytes=${record?.bytes ?? 0} json=${record?.json || ''}`
    }
  }
  const gpuProbe = parseGpuProbe(output.split(/\r?\n/), 'ios-metal')
  const surfaceProbe = parseSurfaceProbe(output.split(/\r?\n/), 'ios-metal-layer')
  const operations = ['app.init', 'render.commit', 'render.snapshot', 'canvas.draw', 'canvas.snapshot', 'api.call']
  const missing = operations.filter(operation => !output.includes(`WEAPP_CONTAINER_IOS_SMOKE ${operation} `))
  const nonZero = operations.filter(operation => !output.includes(`WEAPP_CONTAINER_IOS_SMOKE ${operation} status=0 `))
  const checks = {
    appInitOk: output.includes('"op":"app.init"') && output.includes('"ok":true'),
    renderCommitOk: output.includes('"op":"render.commit"') && output.includes('"frameId":1'),
    renderSnapshotRgba8: output.includes('"format":"rgba8-premultiplied"') && output.includes('"pixels":[16,32,48,255'),
    canvasDrawOk: output.includes('wx.canvas.draw') && output.includes('"canvasId":"main"'),
    canvasSnapshotRgba8: output.includes('canvas.snapshot') && output.includes('"pixels":[10,20,30,255'),
    canIUseStorage: output.includes('wx.canIUse') && output.includes('"result":true'),
  }
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  const cleanup = run('xcrun', ['simctl', 'terminate', booted[0].udid, bundleId])
  const status = install.status === 'passed' && launch.status === 'passed' && cleanup.status === 'passed'
    && appEvidence?.status === 'passed' && missing.length === 0 && nonZero.length === 0 && failedChecks.length === 0 ? 'passed' : 'failed'
  const backendMatch = output.match(/"backend":"([^"]+)"/)
  // render.commit is emitted before the host surface is attached and normally
  // reports skia-raster. Promote only the direct Rust Skia/CAMetalLayer probe
  // after it confirms that a drawable was rendered by the container context.
  const directSurface = surfaceProbe.status === 'passed'
    && surfaceProbe.hostSurfaceAttached === true
    && surfaceProbe.containerSurfaceAttached === true
    && surfaceProbe.gpuSurface === true
    && surfaceProbe.rendererBackend?.startsWith('skia-gpu')
  const rendererBackend = directSurface
    ? surfaceProbe.rendererBackend
    : backendMatch?.[1] || null
  return applyRendererGate({
    platform: 'ios',
    status,
    environment: runtimeEnvironment(booted[0].udid),
    udid: booted[0].udid,
    bundleId,
    artifact: iosApp,
    artifactDigestFile: resolve(iosApp, process.env.WEAPP_CONTAINER_IOS_EXECUTABLE || 'WeappContainerApp'),
    artifactSha256: artifactDigest(resolve(iosApp, process.env.WEAPP_CONTAINER_IOS_EXECUTABLE || 'WeappContainerApp')),
    operations,
    missingOperations: missing,
    nonZeroOperations: nonZero,
    checks,
    failedChecks,
    gpuProbe,
    surfaceProbe,
    probes: [devices, install, launch, appContainer, cleanup],
    evidenceFile,
    notes: [
      'The iOS smoke requires Rust Skia Ganesh to render directly into the CAMetalLayer drawable before promoting the GPU gate.',
      'A headless standalone layer may not vend a drawable; embedding apps must pass a view-backed CAMetalLayer for direct container-surface evidence.',
    ],
  }, rendererBackend)
}

const HARMONY_OPERATIONS = ['app.init', 'render.commit', 'render.snapshot', 'canvas.draw', 'canvas.snapshot', 'api.call']

function sleepMs(milliseconds) {
  if (milliseconds <= 0) return
  // Keep the harness synchronous so every probe remains in report order. The
  // child process does not touch the target; it only gives ArkTS time to run.
  run(process.execPath, ['-e', `setTimeout(() => {}, ${milliseconds})`], {
    timeoutMs: milliseconds + 1_000,
  })
}

function extractJsonValues(text) {
  const values = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue
    const opening = text[start]
    const closing = opening === '{' ? '}' : ']'
    let depth = 0
    let quote = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (quote) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quote = false
        continue
      }
      if (character === '"') {
        quote = true
        continue
      }
      if (character === opening) depth += 1
      else if (character === closing) depth -= 1
      if (depth !== 0) continue
      try {
        values.push(JSON.parse(text.slice(start, index + 1)))
      } catch {
        // A log prefix can contain an unrelated brace. Continue searching for
        // the next complete JSON value on this line.
      }
      break
    }
  }
  return values
}

function findOperationPayload(value, operation) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findOperationPayload(item, operation)
      if (result) return result
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.op === operation) return value.payload && typeof value.payload === 'object' ? value.payload : value
  if (Array.isArray(value.messages)) {
    const result = findOperationPayload(value.messages, operation)
    if (result) return result
  }
  for (const child of Object.values(value)) {
    const result = findOperationPayload(child, operation)
    if (result) return result
  }
  return null
}

function findProviderPayload(value, name) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findProviderPayload(item, name)
      if (result) return result
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.payload && typeof value.payload === 'object' && value.payload.name === name) {
    return value.payload
  }
  for (const child of Object.values(value)) {
    const result = findProviderPayload(child, name)
    if (result) return result
  }
  return null
}

function parseHarmonySmoke(lines) {
  const operations = {}
  for (const operation of HARMONY_OPERATIONS) {
    operations[operation] = { seen: false, ok: false, payload: null, lines: [] }
  }
  for (const line of lines) {
    const operation = HARMONY_OPERATIONS.find(candidate => line.includes(candidate))
    if (!operation) continue
    const result = operations[operation]
    result.seen = true
    result.lines.push(line)
    const values = extractJsonValues(line)
    const payload = values.map(value => findOperationPayload(value, operation)).find(Boolean)
    if (payload) result.payload = payload
    if (operation === 'app.init') {
      result.ok = Boolean(payload?.ok === true)
    } else if (operation === 'render.commit') {
      result.ok = Boolean(payload?.ok === true && Number(payload.frameId) === 1 && typeof payload.backend === 'string')
    } else if (operation === 'render.snapshot') {
      const snapshot = values.find(value => value && typeof value === 'object' && value.format === 'rgba8-premultiplied')
      result.payload = snapshot || result.payload
      result.ok = Boolean(snapshot
        && Number(snapshot.frame_id) === 1
        && Number(snapshot.width) > 0
        && Number(snapshot.height) > 0
        && Number(snapshot.stride) >= Number(snapshot.width) * 4
        && Array.isArray(snapshot.pixels)
        && snapshot.pixels.length >= 4)
    } else if (operation === 'canvas.snapshot') {
      const snapshot = values.find(value => value && typeof value === 'object' && value.format === 'rgba8-premultiplied')
      result.payload = snapshot || result.payload
      result.ok = Boolean(snapshot
        && Number(snapshot.width) === 1
        && Number(snapshot.height) === 1
        && Array.isArray(snapshot.pixels)
        && snapshot.pixels.slice(0, 4).join(',') === '10,20,30,255')
    } else if (operation === 'canvas.draw') {
      const providerPayload = values.map(value => findProviderPayload(value, 'wx.canvas.draw')).find(Boolean)
      result.payload = providerPayload || result.payload
      result.ok = Boolean(providerPayload?.ok === true && providerPayload?.result?.canvasId === 'main')
    } else if (operation === 'api.call') {
      result.ok = Boolean(payload?.ok === true && payload.result === true)
    }
  }
  const missingOperations = HARMONY_OPERATIONS.filter(operation => !operations[operation].seen)
  const failedChecks = HARMONY_OPERATIONS.filter(operation => operations[operation].seen && !operations[operation].ok)
  return { operations, missingOperations, failedChecks }
}

function harmonySmoke() {
  const targetProbe = run('hdc', ['list', 'targets'])
  const target = process.env.WEAPP_CONTAINER_HARMONY_TARGET || targetProbe.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  if (!target) return {
    platform: 'harmony',
    status: 'blocked',
    runtimeStatus: 'blocked',
    gate: 'blocked-environment',
    reason: 'no online hdc target',
    environment: runtimeEnvironment(),
    probes: [targetProbe],
  }
  const hap = process.env.WEAPP_CONTAINER_HARMONY_HAP
  const bundle = process.env.WEAPP_CONTAINER_HARMONY_BUNDLE
  const ability = process.env.WEAPP_CONTAINER_HARMONY_ABILITY
  if (!hap || !bundle || !ability || !existsSync(resolve(hap))) {
    return {
      platform: 'harmony',
      status: 'blocked',
      runtimeStatus: 'blocked',
      gate: 'blocked-artifact',
      target,
      reason: 'set WEAPP_CONTAINER_HARMONY_HAP, WEAPP_CONTAINER_HARMONY_BUNDLE and WEAPP_CONTAINER_HARMONY_ABILITY after DevEco produces a HAP',
      environment: runtimeEnvironment(target),
      probes: [targetProbe],
    }
  }
  const install = run('hdc', ['-t', target, 'install', '-r', resolve(hap)], { timeoutMs: 90_000 })
  const clear = run('hdc', ['-t', target, 'shell', 'hilog', '-r'])
  const stop = run('hdc', ['-t', target, 'shell', 'aa', 'force-stop', bundle])
  const start = run('hdc', ['-t', target, 'shell', 'aa', 'start', '-a', ability, '-b', bundle])
  const timeoutMs = Number(process.env.WEAPP_CONTAINER_HARMONY_WAIT_MS || 5_000)
  const pollMs = Math.max(100, Number(process.env.WEAPP_CONTAINER_HARMONY_POLL_MS || 250))
  const startedAt = Date.now()
  let logProbe = null
  let smokeLines = []
  let gpuProbeLines = []
  let surfaceProbeLines = []
  let parsed = parseHarmonySmoke([])
  while (Date.now() - startedAt <= timeoutMs) {
    // Collect the complete stream because DevEco projects may emit the
    // runtime batch under `WEAPP_CONTAINER_SMOKE` and the platform-owned device probe
    // under `WEAPP_CONTAINER_GPU_PROBE`. Filter locally so the two evidence boundaries
    // remain visible without relying on hilog's tag-expression syntax.
    logProbe = run('hdc', ['-t', target, 'shell', 'hilog', '-x'], { timeoutMs: 20_000 })
    const output = `${logProbe.stdout}\n${logProbe.stderr}`
    smokeLines = output.split(/\r?\n/).filter(line => line.includes('WEAPP_CONTAINER_SMOKE'))
    gpuProbeLines = output.split(/\r?\n/).filter(line => line.includes('WEAPP_CONTAINER_GPU_PROBE'))
    surfaceProbeLines = output.split(/\r?\n/).filter(line => line.includes('WEAPP_CONTAINER_SURFACE_PROBE'))
    parsed = parseHarmonySmoke(smokeLines)
    if (parsed.missingOperations.length === 0) break
    sleepMs(Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - startedAt))))
  }
  // The smoke owns this launch; always stop it after collecting logs, even on
  // a failed launch, so a diagnostic run does not leave the shared emulator
  // foregrounded.
  const cleanup = run('hdc', ['-t', target, 'shell', 'aa', 'force-stop', bundle])
  const crash = hasHarmonyRuntimeCrash(`${logProbe?.stdout || ''}\n${logProbe?.stderr || ''}`)
  const status = install.status === 'passed'
    && clear.status === 'passed'
    && stop.status === 'passed'
    && start.status === 'passed'
    && logProbe?.status === 'passed'
    && cleanup.status === 'passed'
    && parsed.missingOperations.length === 0
    && parsed.failedChecks.length === 0
    && !crash ? 'passed' : 'failed'
  const surfaceProbe = parseSurfaceProbe(surfaceProbeLines, 'harmony-arkui-xcomponent')
  const directSurface = surfaceProbe.status === 'passed'
    && surfaceProbe.hostSurfaceAttached === true
    && surfaceProbe.containerSurfaceAttached === true
    && surfaceProbe.gpuSurface === true
    && surfaceProbe.rendererBackend?.startsWith('skia-gpu')
  const rendererBackend = directSurface
    ? surfaceProbe.rendererBackend
    : parsed.operations['render.commit']?.payload?.backend || null
  const gpuProbe = parseGpuProbe(gpuProbeLines, 'harmony-arkui')
  return applyRendererGate({
    platform: 'harmony',
    status,
    environment: runtimeEnvironment(target),
    target,
    bundle,
    ability,
    artifact: resolve(hap),
    artifactDigestFile: resolve(hap),
    artifactSha256: artifactDigest(resolve(hap)),
    operations: HARMONY_OPERATIONS,
    missingOperations: parsed.missingOperations,
    failedChecks: parsed.failedChecks,
    checks: Object.fromEntries(HARMONY_OPERATIONS.map(operation => [operation, parsed.operations[operation].ok])),
    smokeLogs: smokeLines,
    gpuProbe,
    surfaceProbe,
    probes: [targetProbe, install, clear, stop, start, logProbe, cleanup].filter(Boolean),
    notes: [
      'Harmony evidence is accepted only when WEAPP_CONTAINER_SMOKE logs contain successful app.init, render.commit, render.snapshot and api.call payloads.',
      'The XComponent adapter is promoted only by a separate WEAPP_CONTAINER_SURFACE_PROBE with a skia-gpu-gles framebuffer submission.',
      'HAP output and ability names must come from the DevEco project.',
    ],
  }, rendererBackend)
}

const runners = { android: androidSmoke, ios: iosSmoke, harmony: harmonySmoke }
const platformReports = platforms.map(platform => {
  const runner = runners[platform]
  return runner ? runner() : { platform, status: 'failed', reason: `unknown platform: ${platform}` }
})
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'native-mobile-runtime-smoke',
  sourceCommit: gitRevision(),
  sourceCommitScope: 'smoke-harness-checkout',
  artifactBuildSourcesVerified: false,
  weappViteCommit: gitRevision(resolve(root, 'vendor/weapp-vite')),
  requireAll,
  expectedEngine,
  environment: runtimeEnvironment(),
  platforms: platformReports,
  executionEvidence: collectPackExecutionEvidence(platformReports),
  notes: [
    'sourceCommit identifies the smoke harness checkout; artifactSha256 identifies each tested binary. This run does not rebuild or verify the source provenance of prebuilt APK, app or HAP artifacts.',
    'A passed entry proves the selected app smoke harness ran on the selected emulator/device; nativeSurface and the GPU gate remain separate fields.',
    'runtimeStatus=passed with status=blocked is diagnostic bridge evidence that did not satisfy the native renderer gate.',
    'gpuProbe is an independent platform EGL/Metal/ArkUI device-context observation; containerSurfaceAttached must remain false until the host adapter owns the runtime surface.',
    'It does not prove GPU backend, production signing, full API conformance, or performance gates.',
    'Harmony requires a DevEco-built HAP, ability launch and four WEAPP_CONTAINER_SMOKE bridge/render records; install or launch alone never passes.',
  ],
}
const output = `${JSON.stringify(report, null, 2)}\n`
process.stdout.write(output)
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, output, 'utf8')
}
if (requireAll && report.platforms.some(platform => platform.status !== 'passed')) process.exitCode = 1
