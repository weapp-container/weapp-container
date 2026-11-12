#!/usr/bin/env node
/**
 * Exercise the shared host bridge through every host crate.
 *
 * This is a protocol/resource smoke, not a GPU or device gate.  The report
 * records the batch validation, deadline/cancellation and FFI buffer release
 * assertions, then keeps native GPU evidence explicitly blocked until a host
 * attaches a real platform surface.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = outIndex >= 0 && args[outIndex + 1]
  ? resolve(args[outIndex + 1])
  : null
const requireNative = args.includes('--require-native')
const cargo = process.env.CARGO || 'cargo'
const hostCrates = [
  'container-host-common',
  'container-host-web',
  'container-host-desktop',
  'container-host-android',
  'container-host-ios',
  'container-host-harmony',
]
// The common crate has no feature forwarding of its own.  The platform
// adapters all expose the same two engine feature names, so run the matrix on
// those adapters to prove that each host reports the selected provider
// consistently.  This is a compile/protocol gate only; it does not attach a
// native surface or certify GPU/device execution.
const engineHostCrates = hostCrates.filter(crate => crate !== 'container-host-common')

function commandResult(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    command: [command, ...commandArgs].join(' '),
    status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

const test = commandResult(cargo, [
  'test',
  '--lib',
  '--locked',
  ...hostCrates.flatMap(crate => ['-p', crate]),
])
const bridgePassed = test.status === 'passed'

function engineTest(engine) {
  return commandResult(cargo, [
    'test',
    '--lib',
    '--locked',
    '--no-default-features',
    '--features', `${engine}-native`,
    ...engineHostCrates.flatMap(crate => ['-p', crate]),
  ])
}

const engineTests = {
  quickjs: engineTest('quickjs'),
  v8: engineTest('v8'),
}
const enginePassed = Object.values(engineTests).every(result => result.status === 'passed')

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'host-bridge-batch-smoke',
  commit: gitCommit(),
  test: {
    status: test.status,
    command: test.command,
    exitCode: test.exitCode,
    assertions: [
      'canonical messages batch envelope invariants are validated before runtime mutation',
      'batch messages preserve order across app.init and page.push',
      'deadline expiry returns ERR_TIMEOUT without page mutation',
      'cancel followed by a cancelled request returns ERR_CANCELLED',
      'FFI output buffers are released and cleared idempotently',
      'web, desktop, Android, iOS and Harmony host crates compile and run their host smoke tests',
      'each platform adapter forwards quickjs-native and v8-native into the shared runtime',
      'each platform adapter reports provider availability from the selected compile-time feature',
    ],
    stdoutTail: test.stdout.slice(-4000),
    stderrTail: test.stderr.slice(-4000),
  },
  engines: Object.fromEntries(Object.entries(engineTests).map(([engine, result]) => [engine, {
    status: result.status,
    command: result.command,
    exitCode: result.exitCode,
    stdoutTail: result.stdout.slice(-4000),
    stderrTail: result.stderr.slice(-4000),
  }])),
  hosts: ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony'].map(platform => ({
    platform,
    bridgeBatch: bridgePassed ? 'passed' : 'failed',
    rendererBackend: 'software-fallback',
    nativeSurface: false,
    gpuGate: 'blocked',
    reason: 'bridge smoke does not attach a platform GPU surface',
  })),
  gates: {
    bridge: bridgePassed ? 'passed' : 'failed',
    engineProviders: enginePassed ? 'passed' : 'failed',
    nativeGpu: 'blocked',
    performance: 'unavailable',
  },
  status: bridgePassed && enginePassed ? 'passed' : 'failed',
  releaseReady: false,
  notes: [
    'A passed bridge status proves only shared batch protocol and FFI ownership behavior.',
    'A passed engineProviders status proves only feature forwarding and capability metadata; module execution remains covered by the engine conformance suite.',
    'software-fallback and host metadata never satisfy the native GPU gate.',
    'Use host-device-smoke and native-runtime-smoke for emulator/runtime evidence.',
  ],
}

const output = `${JSON.stringify(report, null, 2)}\n`
process.stdout.write(output)
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  // A smoke can be started by a local terminal and CI at the same time.  Do
  // not let their writes interleave into a JSON document that the gate
  // checker cannot parse; publish a complete report with one rename.
  const temporaryPath = `${outPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temporaryPath, output, 'utf8')
  try {
    renameSync(temporaryPath, outPath)
  } catch (error) {
    // Windows may reject rename over an existing destination.  Remove only
    // this task's known report path, then finish the replacement; POSIX keeps
    // the single atomic rename path above.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
    rmSync(outPath, { force: true })
    renameSync(temporaryPath, outPath)
  }
}
if (!bridgePassed || !enginePassed || (requireNative && report.gates.nativeGpu !== 'passed')) process.exitCode = 1
