#!/usr/bin/env node
/** An explicit, owned Android app launch; never chooses or shuts down a device. */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE = 'com.sonofmagic.weapp.container'
const COMPONENT = `${PACKAGE}/.MainActivity`
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonFile = path => JSON.parse(readFileSync(path, 'utf8'))
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
const defaultExecute = (command, args, options) => spawnSync(command, args, {
  encoding: null, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function parseArgs(args) {
  const names = new Map([
    ['--serial', 'serial'], ['--apk', 'apk'], ['--out-dir', 'outDir'],
    ['--expected-avd', 'expectedAvd'], ['--engine', 'engine'],
    ['--build-receipt', 'buildReceipt'], ['--repo-root', 'repoRoot'],
    ['--timeout-ms', 'timeoutMs'], ['--poll-ms', 'pollMs'], ['--adb', 'adb'],
    ['--fixture-id', 'fixtureId'],
    ['--expected-source-commit', 'expectedSourceCommit'],
    ['--interaction-plan', 'interactionPlan'],
  ])
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const key = names.get(args[index])
    requireCondition(key && args[index + 1] && !args[index + 1].startsWith('--'), `Unknown option or missing value: ${args[index]}`)
    requireCondition(options[key] === undefined, `Duplicate option: ${args[index]}`)
    options[key] = args[++index]
  }
  return options
}

function validateOptions(options) {
  for (const key of ['serial', 'apk', 'outDir']) requireCondition(typeof options[key] === 'string' && options[key].trim(), `--${key === 'outDir' ? 'out-dir' : key} is required`)
  requireCondition(/^[A-Za-z0-9_.:-]+$/.test(options.serial), 'Invalid explicit device serial')
  if (options.serial.startsWith('emulator-')) requireCondition(typeof options.expectedAvd === 'string' && options.expectedAvd.trim(), '--expected-avd is required for an emulator')
  const result = {
    ...options, apk: resolve(options.apk), outDir: resolve(options.outDir),
    repoRoot: resolve(options.repoRoot || process.cwd()), engine: options.engine || 'quickjs',
    timeoutMs: Number(options.timeoutMs || 30_000), pollMs: Number(options.pollMs || 150), adb: options.adb || 'adb',
  }
  requireCondition(['quickjs', 'v8'].includes(result.engine), '--engine must be quickjs or v8')
  requireCondition(result.interactionPlan === undefined || result.interactionPlan === 'reference', '--interaction-plan must be reference')
  if (result.interactionPlan) requireCondition(result.serial.startsWith('emulator-'), 'Reference resize exercise requires an explicitly selected emulator')
  requireCondition(Number.isSafeInteger(result.timeoutMs) && result.timeoutMs >= 100 && result.timeoutMs <= 300_000, 'Invalid --timeout-ms')
  requireCondition(Number.isSafeInteger(result.pollMs) && result.pollMs >= 1 && result.pollMs <= 5_000, 'Invalid --poll-ms')
  if (result.expectedSourceCommit !== undefined) requireCondition(/^[0-9a-f]{40}$/i.test(result.expectedSourceCommit), '--expected-source-commit must be a full commit SHA')
  requireCondition(existsSync(result.apk), `APK not found: ${result.apk}`)
  requireCondition(!existsSync(result.outDir) || readdirSync(result.outDir).length === 0, 'Output directory must be empty; existing evidence is never overwritten')
  return result
}

/** Validate the saved clean-native -> isolated assembly -> APK hash chain. */
export function inspectAndroidBuildReceipt(path, apkSha256, engine) {
  if (!path) return { status: 'unknown', reason: 'No --build-receipt supplied; binary source provenance remains unknown' }
  const receiptPath = resolve(path)
  const directory = dirname(receiptPath)
  const apk = jsonFile(receiptPath)
  const assemblyPath = resolve(directory, 'gradle-assemble.json')
  const inputPath = resolve(directory, 'native-input.json')
  const assembly = jsonFile(assemblyPath)
  const input = jsonFile(inputPath)
  const nativePath = resolve(input.nativeValidation)
  const native = jsonFile(nativePath)
  const nativeSha256 = digest(readFileSync(nativePath))
  const sourceCommit = apk.sourceCommit
  requireCondition(/^[0-9a-f]{40}$/.test(sourceCommit || ''), 'Build receipt source commit is invalid')
  requireCondition(apk.status === 'passed' && apk.sourceStable === true && apk.cleanupStatus === 'passed', 'APK validation did not pass')
  requireCondition(apk.apk?.sha256 === apkSha256 && assembly.apk?.sha256 === apkSha256, 'APK bytes do not match saved build receipts')
  requireCondition(apk.package === PACKAGE && apk.abi?.includes('arm64-v8a'), 'Unexpected APK package or ABI in validation receipt')
  requireCondition(apk.assemblyReceiptSha256 === digest(readFileSync(assemblyPath)), 'Assembly receipt SHA-256 mismatch')
  requireCondition(assembly.status === 'passed' && assembly.exitCode === 0 && assembly.sourceStable === true && assembly.cleanupStatus === 'passed', 'Assembly provenance did not pass')
  requireCondition([assembly.sourceCommit, input.sourceCommit, native.sourceCommit].every(commit => commit === sourceCommit), 'Native/assembly/APK source commits differ')
  requireCondition([apk.nativeBuildValidationSha256, assembly.nativeValidationSha256, input.nativeValidationSha256].every(value => value === nativeSha256), 'Native validation SHA-256 chain differs')
  requireCondition(native.status === 'passed' && native.sourceStable === true && native.workingTreeDirty === false && native.buildProvenanceStatus === 'passed' && native.cleanupStatus === 'passed', 'Native clean-source provenance did not pass')
  requireCondition(native.host === 'android' && native.engine === engine, 'Native receipt host/engine differs')
  const rawHash = apk.libraries?.libcontainer_host_android?.rawSha256 || apk.libraries?.['libcontainer_host_android.so']?.rawSha256
  requireCondition(rawHash && [input.sha256, assembly.nativeInputSha256, native.artifacts?.[0]?.sha256].every(value => value === rawHash), 'Native input library hash chain differs')
  return {
    status: 'passed', sourceCommit, artifactSha256: apkSha256, host: 'android', engine,
    workingTreeDirty: false, workingTreeScope: native.workingTreeScope,
    receiptPath, receiptSha256: digest(readFileSync(receiptPath)), nativeValidationSha256: nativeSha256,
    assemblyReceiptSha256: apk.assemblyReceiptSha256,
    manifestIntegrity: apk.manifestIntegrityRoot, compilerCommit: apk.compilerCommit,
    evidenceBoundary: 'Clean scoped native input, isolated archived Android sources, and exact packaged APK bytes',
  }
}

function processStartTicks(text, pid) {
  const end = text.lastIndexOf(')')
  requireCondition(text.startsWith(`${pid} (`) && end > 0, 'Owned /proc PID identity is invalid')
  const fields = text.slice(end + 1).trim().split(/\s+/)
  requireCondition(/^\d+$/.test(fields[19] || ''), 'Owned process start time is missing')
  return fields[19]
}

function foregroundPackage(text) {
  const matches = [...text.matchAll(/\b(?:mResumedActivity|topResumedActivity)\s*[:=][^\n]*?\s([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/g)]
  const packages = [...new Set(matches.map(match => match[1]))]
  requireCondition(packages.length === 1, 'Cannot establish a single foreground Activity package')
  return packages[0]
}

function pngMetadata(bytes) {
  requireCondition(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR', 'screencap did not return a PNG')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  requireCondition(width > 0 && height > 0, 'Screenshot dimensions are invalid')
  return { width, height, size: bytes.length, sha256: digest(bytes) }
}

function matchesLaunch(receipt, sessionId, fixtureId, engine) {
  return receipt?.sessionId === sessionId && receipt?.fixtureId === fixtureId
    && receipt?.fixture?.id === fixtureId && receipt?.engine === engine
}

function gpuAttached(receipt) {
  const probe = receipt.surfaceProbe
  return probe?.status === 'passed' && probe.sessionId === receipt.sessionId
    && probe.engine === receipt.engine && probe.host === 'android'
    && probe.hostSurfaceAttached === true && probe.containerSurfaceAttached === true
    && probe.gpuSurface === true && probe.rendererBackend === 'skia-gpu-gles'
    && probe.evidenceBoundary === 'runtime-skia-gles-framebuffer'
}

/** Dependency injection is limited to command execution, clock, UUID and the existing receipt inspector. */
export async function runAndroidAppSmoke(rawOptions, dependencies = {}) {
  const options = validateOptions(rawOptions)
  const execute = dependencies.execute || defaultExecute
  const now = dependencies.now || Date.now
  const wait = dependencies.wait || defaultWait
  const unique = (dependencies.uuid || randomUUID)()
  const sessionId = `android-${unique}`
  const fixtureId = options.fixtureId || `android-app-${unique}`
  mkdirSync(options.outDir, { recursive: true })
  mkdirSync(resolve(options.outDir, 'commands'))
  const report = {
    schemaVersion: 1, status: 'failed', scope: 'android-owned-app-startup-gpu-and-os-screen-capture',
    serial: options.serial, expectedAvd: options.expectedAvd || null, engine: options.engine,
    sessionId, fixtureId, package: PACKAGE, apk: options.apk,
    artifactSha256: digest(readFileSync(options.apk)), startedAt: new Date(now()).toISOString(),
    harnessCommit: null, expectedSourceCommit: options.expectedSourceCommit || null,
    harnessScriptSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    ownsInstallation: false, screenshot: null, visualStatus: 'unknown', diagnostics: [], commands: [],
    hardwareAcceleration: { status: 'unknown', hardwareAccelerated: null,
      evidenceBoundary: 'An attached Skia GLES surface does not establish hardware acceleration' },
    cleanup: { status: 'not-needed' },
    limitations: ['OS screenshot capture is not visual conformance', 'Startup/GPU evidence does not establish touch, resize, background lifecycle or near-parity conformance'],
  }
  let commandNumber = 0
  let installed = false
  let ownedIdentity = null
  let rawReceipt = null
  const aborted = () => requireCondition(!dependencies.signal?.aborted, 'Run aborted')
  function command(args, { timeoutMs = 5_000, allowFailure = false, cleanup = false } = {}) {
    if (!cleanup) aborted()
    const id = String(++commandNumber).padStart(3, '0')
    const started = now()
    let response
    try { response = execute(options.adb, ['-s', options.serial, ...args], { timeoutMs }) }
    catch (error) { response = { status: null, error, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } }
    const stdout = Buffer.isBuffer(response.stdout) ? response.stdout : Buffer.from(response.stdout || '')
    const stderr = Buffer.isBuffer(response.stderr) ? response.stderr : Buffer.from(response.stderr || '')
    const metadata = {
      id, command: [options.adb, '-s', options.serial, ...args], startedAt: new Date(started).toISOString(),
      elapsedMs: now() - started, timeoutMs, exitCode: response.status ?? null,
      signal: response.signal || null, error: response.error?.message || null,
      stdoutFile: `commands/${id}.stdout.bin`, stderrFile: `commands/${id}.stderr.bin`,
      stdoutSha256: digest(stdout), stderrSha256: digest(stderr), stdoutBytes: stdout.length, stderrBytes: stderr.length,
    }
    writeFileSync(resolve(options.outDir, metadata.stdoutFile), stdout)
    writeFileSync(resolve(options.outDir, metadata.stderrFile), stderr)
    writeFileSync(resolve(options.outDir, `commands/${id}.json`), `${JSON.stringify(metadata, null, 2)}\n`)
    report.commands.push(metadata)
    const result = { ok: response.status === 0 && !response.error, stdout, stderr, text: stdout.toString('utf8'), metadata }
    requireCondition(allowFailure || result.ok, `adb command ${id} failed: ${args.join(' ')} (${metadata.error || stderr.toString('utf8').trim() || metadata.exitCode})`)
    return result
  }
  const packagePresent = cleanup => {
    const lines = command(['shell', 'pm', 'list', 'packages', '-u', PACKAGE], { cleanup }).text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    requireCondition(lines.every(line => /^package:[A-Za-z0-9_.]+$/.test(line)), 'Package query returned invalid output')
    return lines.includes(`package:${PACKAGE}`)
  }
  function identity({ allowMissing = false, cleanup = false } = {}) {
    const result = command(['shell', 'pidof', PACKAGE], { allowFailure: true, cleanup })
    const pids = result.text.trim().split(/\s+/).filter(Boolean)
    if (!result.ok || pids.length === 0) {
      const confirmedAbsent = pids.length === 0 && !result.metadata.error && result.stderr.length === 0
        && (result.ok || result.metadata.exitCode === 1)
      if (allowMissing && confirmedAbsent) return null
      requireCondition(confirmedAbsent, 'Cannot query owned application PID (device/transport failure)')
      throw new Error('Owned application PID died')
    }
    requireCondition(pids.length === 1 && /^\d+$/.test(pids[0]), 'Expected exactly one application process')
    const pid = Number(pids[0])
    const stat = command(['shell', 'run-as', PACKAGE, 'cat', `/proc/${pid}/stat`], { cleanup })
    return { pid, startTicks: processStartTicks(stat.text, pid) }
  }
  const sameIdentity = current => requireCondition(current && current.pid === ownedIdentity.pid && current.startTicks === ownedIdentity.startTicks, 'Owned application PID changed or died')
  const foreground = () => {
    const pkg = foregroundPackage(command(['shell', 'dumpsys', 'activity', 'activities']).text)
    requireCondition(pkg === PACKAGE, `Application is not foreground: ${pkg}`)
    return pkg
  }
  try {
    const git = dependencies.git || ((args) => spawnSync('git', args, { cwd: options.repoRoot, encoding: 'utf8' }).stdout?.trim())
    report.harnessCommit = git(['rev-parse', 'HEAD']) || null
    report.expectedSourceCommit = options.expectedSourceCommit || report.harnessCommit
    report.build = (dependencies.inspectBuild || inspectAndroidBuildReceipt)(options.buildReceipt, report.artifactSha256, options.engine)
    requireCondition(command(['get-state']).text.trim() === 'device', 'Explicit target is not online')
    if (options.serial.startsWith('emulator-')) {
      const avd = command(['emu', 'avd', 'name']).text.split(/\r?\n/).filter(line => line.trim() && line.trim() !== 'OK').join('\n').trim()
      requireCondition(avd === options.expectedAvd, `AVD mismatch: expected ${options.expectedAvd}, observed ${avd}`)
      report.observedAvd = avd
    }
    requireCondition(!packagePresent(false), 'Package already exists; refusing to overwrite or remove an existing application')
    const install = command(['install', options.apk], { timeoutMs: 60_000, allowFailure: true })
    // Only an acknowledged plain install grants ownership. Ambiguous transport
    // failures never grant authority to delete a pre-existing/concurrent app.
    if (!install.ok || !/(?:^|\r?\n)Success\s*(?:\r?\n|$)/.test(install.text)) {
      try {
        const present = packagePresent(false)
        report.cleanup = { status: present ? 'blocked-unowned' : 'not-needed', packageAbsent: !present,
          reason: 'Installation was not acknowledged; ownership is unproven, so no package may be deleted' }
      } catch (error) { report.cleanup = { status: 'unknown', reason: error.message } }
      throw new Error('Plain APK install was not acknowledged')
    }
    installed = true
    report.ownsInstallation = true
    requireCondition(packagePresent(false), 'Installed package is not visible')
    const start = command(['shell', 'am', 'start', '-W', '-n', COMPONENT,
      '--es', 'weappContainerEngine', options.engine,
      '--es', 'weappContainerSessionId', sessionId, '--es', 'weappContainerFixtureId', fixtureId], { timeoutMs: 15_000 })
    requireCondition(!/^Error(?:\s|:)/m.test(start.text), 'Activity launch returned an Android error')
    const deadline = now() + options.timeoutMs
    while (now() < deadline) {
      aborted()
      const current = identity({ allowMissing: !ownedIdentity })
      if (current) {
        if (ownedIdentity) sameIdentity(current)
        else { ownedIdentity = current; report.ownedProcess = current }
      }
      const read = command(['shell', 'run-as', PACKAGE, 'cat', 'files/portable-pack-execution.json'], { allowFailure: true })
      if (read.ok) {
        try {
          const candidate = JSON.parse(read.text)
          if (matchesLaunch(candidate, sessionId, fixtureId, options.engine) && gpuAttached(candidate)) {
            requireCondition(ownedIdentity, 'Receipt exists without an owned live PID')
            rawReceipt = candidate
            writeFileSync(resolve(options.outDir, 'execution-receipt.raw.json'), read.stdout)
            break
          }
          report.lastReceipt = { sessionId: candidate.sessionId || null, engine: candidate.engine || null, fixtureId: candidate.fixtureId || null, gpuAttached: gpuAttached(candidate) }
        } catch (error) { report.diagnostics.push({ phase: 'receipt-poll', message: error.message }) }
      }
      await wait(Math.min(options.pollMs, Math.max(0, deadline - now())))
    }
    requireCondition(rawReceipt, 'Deadline expired before a matching session/engine/fixture attached-GPU receipt')
    if (report.build.status === 'passed') {
      requireCondition(rawReceipt.manifestIntegrity === report.build.manifestIntegrity && rawReceipt.fixture?.manifest?.compiler?.commit === report.build.compilerCommit, 'Executed pack differs from build validation receipt')
    }
    if (options.interactionPlan) {
      report.interaction = {}
      const { exerciseAndroidReference, inspectInteractionReceipt } = await import('./android-reference-interaction.mjs')
      const { captureAndroidReference } = await import('./android-reference-capture.mjs')
      const expected = { sessionId, engine: options.engine, manifestIntegrity: rawReceipt.manifestIntegrity }
      const readInteraction = () => {
        const read = command(['shell', 'run-as', PACKAGE, 'cat', 'files/portable-pack-interaction.json'], { allowFailure: true })
        if (!read.ok && /No such file or directory/.test(read.stderr.toString('utf8'))) return null
        requireCondition(read.ok, 'Cannot read the owned interaction receipt')
        return inspectInteractionReceipt(JSON.parse(read.text), expected)
      }
      await exerciseAndroidReference({
        serial: options.serial, package: PACKAGE, expected, evidence: report.interaction,
        command, now, wait, timeoutMs: options.timeoutMs,
        assertLive: checkForeground => { sameIdentity(identity()); if (checkForeground) foreground() },
        read: readInteraction,
        save: (label, receipt) => writeFileSync(resolve(options.outDir, `interaction-${label}.json`), `${JSON.stringify(receipt, null, 2)}\n`),
        capture: async label => {
          const accepted = await captureAndroidReference({ label, read: readInteraction,
            assertLive: () => { sameIdentity(identity()); foreground() },
            capture: () => command(['exec-out', 'screencap', '-p']).stdout,
            now, wait, timeoutMs: Math.min(options.timeoutMs, 5_000), pollMs: 150,
            save: attempt => {
              const stem = `interaction-${label}-attempt-${attempt.attempt}`
              const { png, ...record } = attempt
              if (png) writeFileSync(resolve(options.outDir, `${stem}.png`), png)
              writeFileSync(resolve(options.outDir, `${stem}.json`), `${JSON.stringify({ ...record,
                screenshot: png ? `${stem}.png` : null }, null, 2)}\n`)
            },
          })
          const { before, png, inspection } = accepted
          const metadata = pngMetadata(png)
          const path = `interaction-${label}.png`
          writeFileSync(resolve(options.outDir, path), png)
          const geometryPath = `interaction-${label}-visual.json`
          writeFileSync(resolve(options.outDir, geometryPath), `${JSON.stringify(inspection, null, 2)}\n`)
          const screenReceiptPath = `interaction-${label}-screen.json`
          writeFileSync(resolve(options.outDir, screenReceiptPath), `${JSON.stringify(accepted.after, null, 2)}\n`)
          report.interaction.screenshots ||= []
          report.interaction.screenshots.push({ label, path, ...metadata, frameId: before.frame.frame_id,
            presentationSequence: before.surface.presentationSequence, acceptedAttempt: accepted.attempt,
            revision: accepted.after.revision, screenReceiptPath,
            geometryStatus: inspection.status, geometryReport: geometryPath,
            visualStatus: 'unknown', source: 'adb-exec-out-screencap',
            evidenceBoundary: 'Same session/PID/foreground and stable presented drawable around capture; reference background geometry checked, official image equivalence remains unknown' })
          return accepted.after
        },
      })
    }
    const before = identity()
    sameIdentity(before)
    const foregroundBefore = foreground()
    const capture = command(['exec-out', 'screencap', '-p'])
    const screen = pngMetadata(capture.stdout)
    writeFileSync(resolve(options.outDir, 'screen.png'), capture.stdout)
    report.screenshot = { status: 'captured-unverified', visualStatus: 'unknown', path: 'screen.png', ...screen,
      processBefore: before, foregroundBefore, source: 'adb-exec-out-screencap',
      evidenceBoundary: 'OS screen bytes retained; process/foreground correlation is not yet verified' }
    const after = identity()
    sameIdentity(after)
    const foregroundAfter = foreground()
    const finalRead = command(['shell', 'run-as', PACKAGE, 'cat', 'files/portable-pack-execution.json'])
    const finalReceipt = JSON.parse(finalRead.text)
    requireCondition(matchesLaunch(finalReceipt, sessionId, fixtureId, options.engine) && gpuAttached(finalReceipt)
      && finalReceipt.manifestIntegrity === rawReceipt.manifestIntegrity, 'Receipt identity changed around screenshot capture')
    writeFileSync(resolve(options.outDir, 'execution-receipt.after-screen.raw.json'), finalRead.stdout)
    report.screenshot = { status: 'captured', visualStatus: 'unknown', path: 'screen.png', ...screen, processBefore: before, processAfter: after, foregroundBefore, foregroundAfter, source: 'adb-exec-out-screencap', evidenceBoundary: 'OS screen capture only; pixels require separate visual comparison',
      runtimePhase: options.interactionPlan ? 'after-reference-interaction' : 'startup' }
    const target = { host: 'android', id: options.serial, kind: options.serial.startsWith('emulator-') ? 'official-simulator' : 'device' }
    const normalized = {
      ...rawReceipt, target, artifactSha256: report.artifactSha256,
      sourceCommit: report.build.sourceCommit || null, build: report.build,
    }
    const inspect = dependencies.inspectReceipt || (await import(pathToFileURL(resolve(options.repoRoot, 'scripts/pack-execution-evidence.mjs')).href)).inspectPackExecutionReceipt
    const expectedCompilerCommit = git(['rev-parse', 'HEAD:vendor/weapp-vite']) || null
    report.executionInspection = inspect(normalized, rawReceipt.fixture, { root: options.repoRoot, expectedCommit: report.expectedSourceCommit, expectedCompilerCommit })
    report.executionEvidence = { schemaVersion: 1, fixture: rawReceipt.fixture, receipts: [normalized] }
    report.sourceCommit = report.build.sourceCommit || null
    report.runtimeStatus = 'passed'
    report.status = report.executionInspection.status === 'passed' && report.executionInspection.gpu?.status === 'passed' ? 'passed' : 'incomplete'
  } catch (error) {
    report.status = 'failed'
    report.diagnostics.push({ phase: 'run', message: error.message })
  } finally {
    if (ownedIdentity && installed) {
      try {
        const logs = command(['logcat', '-d', '-v', 'threadtime', '-t', '300', `--pid=${ownedIdentity.pid}`], { allowFailure: true, cleanup: true })
        // This is an app-owned context report, independent of the runtime's
        // attached-surface gate. Keep its heuristic hardware claim explicit.
        for (const line of logs.text.split(/\r?\n/).filter(line => line.includes('WEAPP_CONTAINER_GPU_PROBE'))) {
          try {
            const probe = JSON.parse(line.slice(line.indexOf('{')))
            if (probe.schemaVersion === 1 && probe.contextCreated === true && probe.evidenceBoundary === 'device-context-only'
              && typeof probe.hardwareAccelerated === 'boolean') {
              report.graphicsContextProbe = probe
              report.hardwareAcceleration = { status: 'reported', hardwareAccelerated: probe.hardwareAccelerated,
                source: 'owned-pid-egl-context-probe', process: ownedIdentity,
                evidenceBoundary: 'App reports EGL vendor/renderer heuristic; attached Skia GPU does not imply hardware acceleration' }
            }
          } catch { /* Raw command bytes retain malformed/truncated context probes. */ }
        }
      }
      catch (error) { report.diagnostics.push({ phase: 'logcat', message: error.message }) }
    }
    if (installed) {
      const failures = []
      let packageAbsent = null
      let processAbsent = null
      // Try every cleanup action even if force-stop itself fails. Never target
      // other packages, targets, the adb server, or the emulator process.
      for (const args of [['shell', 'am', 'force-stop', PACKAGE], ['uninstall', PACKAGE]]) {
        try {
          const result = command(args, { timeoutMs: 30_000, allowFailure: true, cleanup: true })
          if (!result.ok || (args[0] === 'uninstall' && !/Success/.test(result.text))) failures.push(`Cleanup failed: ${args.join(' ')}`)
        } catch (error) { failures.push(error.message) }
      }
      try { packageAbsent = !packagePresent(true); if (!packageAbsent) failures.push('Owned package remains installed') }
      catch (error) { failures.push(error.message) }
      try { processAbsent = !identity({ allowMissing: true, cleanup: true }); if (!processAbsent) failures.push('Owned application process remains alive') }
      catch (error) { failures.push(error.message) }
      report.cleanup = { status: failures.length ? 'failed' : 'passed', packageAbsent, processAbsent, failures }
      if (failures.length) report.status = 'failed'
    }
    report.finishedAt = new Date(now()).toISOString()
    writeFileSync(resolve(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const report = await runAndroidAppSmoke(parseArgs(process.argv.slice(2)), { signal: controller.signal })
    process.stdout.write(`${JSON.stringify({ status: report.status, cleanup: report.cleanup, sessionId: report.sessionId, screenshot: report.screenshot, interaction: report.interaction || null, diagnostics: report.diagnostics }, null, 2)}\n`)
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
}
