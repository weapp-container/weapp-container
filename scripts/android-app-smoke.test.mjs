import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { PACKAGE, inspectAndroidBuildReceipt, parseArgs, runAndroidAppSmoke } from './android-app-smoke.mjs'

function scenario(overrides = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'android-app-smoke-'))
  const apk = resolve(root, 'app.apk')
  writeFileSync(apk, 'fake APK bytes')
  let time = 1_000
  let installed = overrides.preexisting || false
  let launched = false
  let sessionId = null
  let fixtureId = null
  let reads = 0
  let identities = 0
  let uninstalled = false
  const calls = []
  const screenshot = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(screenshot)
  screenshot.writeUInt32BE(13, 8)
  screenshot.write('IHDR', 12)
  screenshot.writeUInt32BE(400, 16)
  screenshot.writeUInt32BE(800, 20)
  const receipt = () => ({
    schemaVersion: 1, sessionId, fixtureId, engine: 'quickjs', manifestIntegrity: 'a'.repeat(64),
    fixture: { id: fixtureId, manifest: { compiler: { commit: 'b'.repeat(40) } } },
    surfaceProbe: {
      status: 'passed', sessionId, host: 'android', engine: 'quickjs',
      hostSurfaceAttached: true, containerSurfaceAttached: true, gpuSurface: true,
      rendererBackend: 'skia-gpu-gles', evidenceBoundary: 'runtime-skia-gles-framebuffer',
    },
  })
  const success = stdout => ({ status: 0, stdout: stdout || '', stderr: '' })
  const failure = stderr => ({ status: 1, stdout: '', stderr })
  const deps = {
    uuid: () => 'unique-launch', now: () => time, wait: async ms => { time += ms },
    inspectBuild: () => ({ status: 'unknown' }),
    git: args => args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'c'.repeat(40) : 'b'.repeat(40),
    inspectReceipt: () => ({ status: 'passed', gpu: { status: 'passed' } }),
    execute: (command, allArgs) => {
      assert.equal(command, 'adb')
      assert.deepEqual(allArgs.slice(0, 2), ['-s', 'emulator-5572'])
      const args = allArgs.slice(2)
      const text = args.join(' ')
      calls.push(args)
      if (text === 'get-state') return success('device\n')
      if (text === 'emu avd name') return success(`${overrides.avd || 'OwnedAvd'}\nOK\n`)
      if (text === `shell pm list packages -u ${PACKAGE}`) {
        if (uninstalled && overrides.offlineAfterUninstall) return failure('error: device offline')
        return success(installed ? `package:${PACKAGE}\n` : '')
      }
      if (args[0] === 'install') {
        assert.equal(args.length, 2)
        if (overrides.installFailure) return failure('INSTALL_FAILED_INVALID_APK')
        installed = true
        return success('Performing Streamed Install\nSuccess\n')
      }
      if (text.startsWith('shell am start ')) {
        launched = true
        sessionId = args[args.indexOf('weappContainerSessionId') + 1]
        fixtureId = args[args.indexOf('weappContainerFixtureId') + 1]
        overrides.onStart?.()
        return success('Starting: Intent { cmp=com.sonofmagic.weapp.container/.MainActivity }\nStatus: ok\n')
      }
      if (text === `shell pidof ${PACKAGE}`) {
        if (uninstalled && overrides.offlineAfterUninstall) return failure('error: device offline')
        if (!installed || !launched) return failure('')
        identities += 1
        if (overrides.diesAfterIdentity && identities > overrides.diesAfterIdentity) return failure('')
        return success(`${overrides.changedPidAfter && identities > overrides.changedPidAfter ? 445 : 444}\n`)
      }
      if (text.includes('/proc/')) {
        const pid = text.includes('/445/') ? 445 : 444
        return success(`${pid} (app process) S ${Array(18).fill('0').join(' ')} 12345 0 0\n`)
      }
      if (text.endsWith('cat files/portable-pack-execution.json')) {
        reads += 1
        if (overrides.readError) throw new Error('transport dropped while reading receipt')
        if (overrides.neverReady) return success(JSON.stringify({ ...receipt(), sessionId: 'stale-session' }))
        if (overrides.malformedFirst && reads === 1) return success('{broken json')
        if (overrides.staleFirst && reads === 1) return success(JSON.stringify({ ...receipt(), sessionId: 'stale-session' }))
        if (overrides.fallback) return success(JSON.stringify({ ...receipt(), surfaceProbe: { status: 'passed', rendererBackend: 'gles-window-blit', gpuSurface: false } }))
        return success(JSON.stringify(receipt()))
      }
      if (text === 'shell dumpsys activity activities') return success(`  topResumedActivity=ActivityRecord{foo u0 ${overrides.foreground || PACKAGE}/.MainActivity t4}\n`)
      if (text === 'exec-out screencap -p') {
        if (overrides.screencapThrows) throw new Error('screenshot transport error')
        return success(overrides.badPng ? Buffer.from('not PNG') : screenshot)
      }
      if (args[0] === 'logcat') return success('owned process logs\n')
      if (text === `shell am force-stop ${PACKAGE}`) {
        if (overrides.stopFails) return failure('stop failure')
        launched = false
        return success('')
      }
      if (text === `uninstall ${PACKAGE}`) {
        if (overrides.uninstallFails) return failure('delete failed')
        installed = false
        launched = false
        uninstalled = true
        return success('Success\n')
      }
      throw new Error(`Unexpected command: ${text}`)
    },
  }
  const options = { serial: 'emulator-5572', expectedAvd: 'OwnedAvd', apk, outDir: resolve(root, 'out'), timeoutMs: 100, pollMs: 10, repoRoot: root }
  return { root, apk, options, deps, calls, get installed() { return installed }, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('requires explicit target and expected emulator AVD before any device call', async () => {
  const s = scenario()
  try {
    for (const [key, value] of [['serial', undefined], ['expectedAvd', undefined]]) {
      await assert.rejects(runAndroidAppSmoke({ ...s.options, [key]: value }, s.deps), /required/)
    }
    assert.deepEqual(s.calls, [])
    assert.throws(() => parseArgs(['--serial']), /missing value/)
    assert.throws(() => parseArgs(['--unknown', 'yes']), /Unknown option/)
  } finally { s.cleanup() }
})

for (const [name, settings, error] of [
  ['wrong AVD', { avd: 'UserAvd' }, /AVD mismatch/],
  ['existing package', { preexisting: true }, /Package already exists/],
  ['failed install', { installFailure: true }, /not acknowledged/],
]) {
  test(`refuses ${name} without granting cleanup ownership`, async () => {
    const s = scenario(settings)
    try {
      const result = await runAndroidAppSmoke(s.options, s.deps)
      assert.equal(result.status, 'failed')
      assert.match(result.diagnostics[0].message, error)
      assert.equal(result.ownsInstallation, false)
      assert.equal(s.calls.some(args => args[0] === 'uninstall'), false)
      assert.equal(s.calls.some(args => args.join(' ').includes('force-stop')), false)
      if (settings.preexisting) assert.equal(s.installed, true)
    } finally { s.cleanup() }
  })
}

test('polls past stale and malformed receipts; captures PNG between same PID and foreground checks; removes only owned app', async () => {
  const s = scenario({ malformedFirst: true })
  try {
    const result = await runAndroidAppSmoke(s.options, s.deps)
    assert.equal(result.status, 'passed')
    assert.equal(result.runtimeStatus, 'passed')
    assert.equal(result.screenshot.status, 'captured')
    assert.equal(result.screenshot.visualStatus, 'unknown')
    assert.equal(result.visualStatus, 'unknown')
    assert.equal(result.screenshot.processBefore.pid, 444)
    assert.deepEqual(result.screenshot.processBefore, result.screenshot.processAfter)
    assert.equal(result.screenshot.foregroundBefore, PACKAGE)
    assert.equal(result.screenshot.foregroundAfter, PACKAGE)
    assert.equal(result.cleanup.status, 'passed')
    assert.equal(s.installed, false)
    assert.equal(result.diagnostics.some(item => item.phase === 'receipt-poll'), true)
    assert.equal(readFileSync(resolve(s.options.outDir, 'screen.png')).length, 33)
    assert.equal(s.calls.some(args => args.includes('-c') || args.includes('-r') || args.includes('kill')), false)
    assert.equal(s.calls.some(args => args[0] === 'devices'), false)
    assert.equal(s.calls.filter(args => args[0] === 'uninstall').length, 1)
    const screenshotIndex = s.calls.findIndex(args => args[0] === 'exec-out')
    assert.equal(s.calls.slice(0, screenshotIndex).some(args => args.join(' ').includes('dumpsys activity')), true)
    assert.equal(s.calls.slice(screenshotIndex + 1).some(args => args.join(' ').includes('dumpsys activity')), true)
    for (const command of result.commands) {
      assert.equal(readFileSync(resolve(s.options.outDir, command.stdoutFile)).length, command.stdoutBytes)
      assert.equal(readFileSync(resolve(s.options.outDir, command.stderrFile)).length, command.stderrBytes)
      assert.equal(JSON.parse(readFileSync(resolve(s.options.outDir, `commands/${command.id}.json`))).id, command.id)
    }
  } finally { s.cleanup() }
})

test('a stale session cannot satisfy the receipt deadline', async () => {
  const s = scenario({ neverReady: true })
  try {
    const result = await runAndroidAppSmoke(s.options, s.deps)
    assert.equal(result.status, 'failed')
    assert.match(result.diagnostics.at(-1).message, /Deadline/)
    assert.equal(result.screenshot, null)
    assert.equal(result.cleanup.status, 'passed')
    assert.equal(s.installed, false)
  } finally { s.cleanup() }
})

test('GLES software upload cannot satisfy the attached-GPU requirement', async () => {
  const s = scenario({ fallback: true })
  try {
    const result = await runAndroidAppSmoke(s.options, s.deps)
    assert.equal(result.status, 'failed')
    assert.equal(result.screenshot, null)
    assert.equal(result.lastReceipt.gpuAttached, false)
    assert.equal(result.cleanup.status, 'passed')
  } finally { s.cleanup() }
})

for (const [name, settings, message] of [
  ['owned PID death', { diesAfterIdentity: 1, staleFirst: true }, /PID died/],
  ['owned PID replacement', { changedPidAfter: 1 }, /PID changed/],
  ['wrong foreground package', { foreground: 'com.example.user' }, /not foreground/],
  ['screencap exception', { screencapThrows: true }, /command.*failed/],
  ['malformed screen bytes', { badPng: true }, /did not return a PNG/],
]) {
  test(`${name} keeps diagnostics and still cleans owned installation`, async () => {
    const s = scenario(settings)
    try {
      const result = await runAndroidAppSmoke(s.options, s.deps)
      assert.equal(result.status, 'failed')
      assert.match(result.diagnostics.at(-1).message, message)
      assert.equal(result.cleanup.status, 'passed')
      assert.equal(s.installed, false)
      assert.equal(JSON.parse(readFileSync(resolve(s.options.outDir, 'report.json'))).status, 'failed')
    } finally { s.cleanup() }
  })
}

test('uninstall is still attempted when force-stop fails; cleanup failure is visible', async () => {
  const s = scenario({ stopFails: true })
  try {
    const result = await runAndroidAppSmoke(s.options, s.deps)
    assert.equal(result.status, 'failed')
    assert.equal(result.cleanup.status, 'failed')
    assert.equal(s.calls.some(args => args[0] === 'uninstall'), true)
    assert.equal(s.installed, false)
  } finally { s.cleanup() }
})

test('failed uninstall reports the exact owned package as remaining', async () => {
  const s = scenario({ uninstallFails: true })
  try {
    const result = await runAndroidAppSmoke(s.options, s.deps)
    assert.equal(result.status, 'failed')
    assert.equal(result.cleanup.status, 'failed')
    assert.equal(result.cleanup.packageAbsent, false)
    assert.equal(s.installed, true)
  } finally { s.cleanup() }
})

test('device transport loss during cleanup cannot become verified package/process absence', async () => {
  const s = scenario({ offlineAfterUninstall: true })
  try {
    const result = await runAndroidAppSmoke(s.options, s.deps)
    assert.equal(result.status, 'failed')
    assert.equal(result.cleanup.status, 'failed')
    assert.equal(result.cleanup.packageAbsent, null)
    assert.equal(result.cleanup.processAbsent, null)
  } finally { s.cleanup() }
})

test('PID replacement around capture retains raw screen bytes without claiming screenshot correlation', async () => {
  const s = scenario({ changedPidAfter: 2 })
  try {
    const result = await runAndroidAppSmoke(s.options, s.deps)
    assert.equal(result.status, 'failed')
    assert.equal(result.screenshot.status, 'captured-unverified')
    assert.equal(result.visualStatus, 'unknown')
    assert.equal(result.cleanup.status, 'passed')
    assert.equal(readFileSync(resolve(s.options.outDir, 'screen.png')).length, 33)
  } finally { s.cleanup() }
})

test('interrupt after owned installation follows the same cleanup boundary', async () => {
  const controller = new AbortController()
  const s = scenario({ onStart: () => controller.abort() })
  try {
    const result = await runAndroidAppSmoke(s.options, { ...s.deps, signal: controller.signal })
    assert.equal(result.status, 'failed')
    assert.match(result.diagnostics.at(-1).message, /aborted/)
    assert.equal(result.cleanup.status, 'passed')
    assert.equal(s.installed, false)
  } finally { s.cleanup() }
})

test('pre-existing output files are never overwritten', async () => {
  const s = scenario()
  try {
    mkdirSync(s.options.outDir)
    writeFileSync(resolve(s.options.outDir, 'report.json'), 'existing evidence')
    await assert.rejects(runAndroidAppSmoke(s.options, s.deps), /must be empty/)
    assert.equal(readFileSync(resolve(s.options.outDir, 'report.json'), 'utf8'), 'existing evidence')
    assert.deepEqual(s.calls, [])
  } finally { s.cleanup() }
})

test('explicit immutable source baseline is separate from the supervisor checkout and binary receipt', async () => {
  const s = scenario()
  try {
    const expected = 'e'.repeat(40)
    let inspected = null
    const result = await runAndroidAppSmoke({ ...s.options, expectedSourceCommit: expected }, {
      ...s.deps, inspectReceipt: (receipt, fixture, options) => {
        inspected = { receipt, fixture, options }
        return { status: 'passed', gpu: { status: 'passed' } }
      },
    })
    assert.equal(result.status, 'passed')
    assert.equal(result.harnessCommit, 'c'.repeat(40))
    assert.equal(result.expectedSourceCommit, expected)
    assert.equal(inspected.options.expectedCommit, expected)
    assert.equal(inspected.receipt.sourceCommit, null, 'An expected baseline cannot invent binary source provenance')
    assert.equal(inspected.receipt.build.status, 'unknown')
    assert.equal(result.hardwareAcceleration.status, 'unknown', 'An attached surface cannot imply hardware acceleration')
    assert.match(result.harnessScriptSha256, /^[a-f0-9]{64}$/)
  } finally { s.cleanup() }
})

test('default source baseline is HEAD and an invalid explicit SHA fails before device commands', async () => {
  const invalid = scenario()
  try {
    await assert.rejects(runAndroidAppSmoke({ ...invalid.options, expectedSourceCommit: 'HEAD' }, invalid.deps), /full commit SHA/)
    assert.deepEqual(invalid.calls, [])
  } finally { invalid.cleanup() }
  const s = scenario()
  try {
    let expectedCommit = null
    const result = await runAndroidAppSmoke(s.options, { ...s.deps, inspectReceipt: (_receipt, _fixture, options) => {
      expectedCommit = options.expectedCommit
      return { status: 'passed', gpu: { status: 'passed' } }
    } })
    assert.equal(result.expectedSourceCommit, 'c'.repeat(40))
    assert.equal(expectedCommit, result.harnessCommit)
  } finally { s.cleanup() }
})

test('missing build evidence remains unknown and invalid build input cannot be promoted', () => {
  assert.equal(inspectAndroidBuildReceipt(null, 'a'.repeat(64), 'quickjs').status, 'unknown')
  const s = scenario()
  try {
    writeFileSync(resolve(s.root, 'apk-validation.json'), '{}')
    assert.throws(() => inspectAndroidBuildReceipt(resolve(s.root, 'apk-validation.json'), 'a'.repeat(64), 'quickjs'))
    assert.equal(readdirSync(s.root).length > 0, true)
  } finally { s.cleanup() }
})

test('actual receipt inspector input is granted build provenance only through matching native/assembly/APK hashes', () => {
  const s = scenario()
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const save = (name, value) => { const p = resolve(s.root, name); writeFileSync(p, JSON.stringify(value)); return hash(readFileSync(p)) }
  try {
    const commit = 'a'.repeat(40)
    const librarySha256 = 'b'.repeat(64)
    const apkSha256 = hash(readFileSync(s.apk))
    const native = { status: 'passed', sourceCommit: commit, sourceStable: true, workingTreeDirty: false,
      buildProvenanceStatus: 'passed', cleanupStatus: 'passed', host: 'android', engine: 'quickjs',
      artifacts: [{ sha256: librarySha256 }] }
    const nativeSha256 = save('native-validation.json', native)
    save('native-input.json', { sourceCommit: commit, sha256: librarySha256, nativeValidation: resolve(s.root, 'native-validation.json'), nativeValidationSha256: nativeSha256 })
    const assembly = { status: 'passed', sourceCommit: commit, sourceStable: true, cleanupStatus: 'passed', exitCode: 0,
      apk: { sha256: apkSha256 }, nativeValidationSha256: nativeSha256, nativeInputSha256: librarySha256 }
    const assemblySha256 = save('gradle-assemble.json', assembly)
    const apk = { status: 'passed', sourceCommit: commit, sourceStable: true, cleanupStatus: 'passed',
      apk: { sha256: apkSha256 }, package: PACKAGE, abi: ['arm64-v8a'], assemblyReceiptSha256: assemblySha256,
      nativeBuildValidationSha256: nativeSha256, libraries: { 'libcontainer_host_android.so': { rawSha256: librarySha256 } } }
    save('apk-validation.json', apk)
    const path = resolve(s.root, 'apk-validation.json')
    assert.equal(inspectAndroidBuildReceipt(path, apkSha256, 'quickjs').status, 'passed')
    assert.throws(() => inspectAndroidBuildReceipt(path, 'f'.repeat(64), 'quickjs'), /APK bytes/)
    assert.throws(() => inspectAndroidBuildReceipt(path, apkSha256, 'v8'), /engine differs/)
    save('native-validation.json', { ...native, workingTreeDirty: true })
    assert.throws(() => inspectAndroidBuildReceipt(path, apkSha256, 'quickjs'), /SHA-256 chain/)
    save('native-validation.json', native)
    save('gradle-assemble.json', { ...assembly, sourceStable: false })
    assert.throws(() => inspectAndroidBuildReceipt(path, apkSha256, 'quickjs'), /Assembly receipt SHA/)
  } finally { s.cleanup() }
})
