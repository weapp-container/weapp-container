#!/usr/bin/env node
/** Actual pinned-compiler ingress test. No runtime, device, or shared project is used. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { resolveWatchBackend } from './simulator-watch.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const hash = data => createHash('sha256').update(data).digest('hex')
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const ensure = (condition, code) => { if (!condition) throw new Error(code) }

export function parseOptions(args) {
  const options = { backend: 'auto' }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    ensure(['--out', '--backend'].includes(key) && typeof args[i + 1] === 'string', 'ERR_SMOKE_ARGUMENT')
    ensure(!Object.hasOwn(options, key.slice(2)) || key === '--backend', 'ERR_SMOKE_DUPLICATE_ARGUMENT')
    options[key.slice(2)] = args[i + 1]
  }
  ensure(typeof options.out === 'string' && options.out.length > 0, 'ERR_SMOKE_OUTPUT_REQUIRED')
  options.out = resolve(options.out)
  options.selection = resolveWatchBackend(options.backend)
  return options
}

function put(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents, { flag: 'wx', mode: 0o600 })
}

function atomicReplace(path, contents) {
  const temporary = `${path}.next-${randomUUID()}`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}

function inputs(round) {
  const suffix = String(round).padStart(2, '0')
  return {
    'app.js': `App({ globalData: { watchBackendMarker: "watch-javascript-${suffix}" } })\n`,
    'pages/home/index.wxml': `<view class="probe">watch-template-${suffix}</view>\n`,
    'pages/home/index.wxss': `.probe { width: ${370 + round}px; }\n`,
  }
}

function matches(snapshot, round) {
  const suffix = String(round).padStart(2, '0')
  return readFileSync(resolve(snapshot, 'app.js'), 'utf8').includes(`watch-javascript-${suffix}`)
    && readFileSync(resolve(snapshot, 'pages/home/index.wxml'), 'utf8').includes(`watch-template-${suffix}`)
    && readFileSync(resolve(snapshot, 'pages/home/index.wxss'), 'utf8').replace(/\s/g, '').includes(`width:${370 + round}px`)
}

/** Every wait has one fixed deadline. A failed iteration is never repeated. */
export async function runSmoke(options) {
  const out = options.out
  ensure(!existsSync(out), 'ERR_SMOKE_FRESH_OUTPUT_REQUIRED')
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const project = resolve(out, 'project'), output = resolve(out, 'compiler-output')
  const receipts = resolve(out, 'receipt-session'), diagnostics = resolve(out, 'watch-diagnostics')
  mkdirSync(output)
  put(resolve(project, 'project.config.json'), '{"appid":"touristappid","compileType":"miniprogram","miniprogramRoot":"dist/","srcMiniprogramRoot":"."}\n')
  put(resolve(project, 'app.json'), '{"pages":["pages/home/index"]}\n')
  put(resolve(project, 'pages/home/index.js'), 'Page({ data: {} })\n')
  for (const [name, contents] of Object.entries(inputs(0))) put(resolve(project, name), contents)
  const adapter = resolve(root, 'scripts/simulator-watch.mjs')
  const log = resolve(out, 'compiler.private.log')
  const fd = openSync(log, 'wx', 0o600)
  const report = {
    schemaVersion: 1, kind: 'actual-pinned-compiler-watch-ingress', status: 'running',
    selectedBackend: options.selection.selected, requestedBackend: options.backend,
    watchOptions: options.selection.options, platform: process.platform, nodeVersion: process.version,
    adapter: { path: 'scripts/simulator-watch.mjs', sha256: hash(readFileSync(adapter)) },
    iterationDeadlineMs: 10_000, initialDeadlineMs: 15_000,
    noRuntimeDeviceOrPerformanceCredit: true, retries: 0, iterations: [],
  }
  const beforeParentEnvironment = Object.fromEntries(['CHOKIDAR_USEPOLLING', 'CHOKIDAR_INTERVAL', 'CHOKIDAR_BINARY_INTERVAL']
    .map(key => [key, { present: Object.hasOwn(process.env, key), value: process.env[key] }]))
  let child, done, exit, activeStage = 'spawn', forcedCleanup = false, interrupted = false
  const stop = () => { interrupted = true; child?.kill('SIGTERM') }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try {
    child = spawn(process.execPath, [adapter, '--project', project, '--output-root', output,
      '--wv-bin', resolve(root, 'vendor/weapp-vite/node_modules/.bin/wv')], {
      cwd: root,
      env: {
        ...process.env, WEAPP_CONTAINER_SIMULATOR_WATCH_BACKEND: options.backend,
        WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR: receipts, WEAPP_CONTAINER_SIMULATOR_SESSION_ID: `watch-ingress-${randomUUID()}`,
        WEAPP_CONTAINER_SIMULATOR_WATCH_DIAGNOSTICS: diagnostics,
        // Deliberately conflict with the selection: the owned adapter must
        // normalize all compiler watcher implementations before they import.
        CHOKIDAR_USEPOLLING: String(!options.selection.options.usePolling),
        CHOKIDAR_INTERVAL: '9000', CHOKIDAR_BINARY_INTERVAL: '10000',
      },
      stdio: ['ignore', fd, fd],
    })
    done = new Promise((resolveDone, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { exit = { code, signal }; resolveDone(exit) })
    })
    // The terminal promise is always consumed in finally, including spawn and
    // first-receipt failures. No unhandled late child rejection is possible.
    void done.catch(() => {})
    const awaitSnapshot = async (round, after, deadlineMs) => {
      const start = performance.now(), deadline = start + deadlineMs
      while (performance.now() < deadline) {
        ensure(!interrupted, 'ERR_SMOKE_INTERRUPTED')
        ensure(exit === undefined, 'ERR_SMOKE_COMPILER_EXIT')
        const directory = resolve(receipts, 'receipts')
        if (existsSync(directory)) {
          for (const name of readdirSync(directory).filter(name => /^[0-9]{20}\.json$/.test(name)).sort()) {
            const path = resolve(directory, name), data = readFileSync(path), value = JSON.parse(data)
            if (value.sequence <= after) continue
            ensure(value.kind !== 'error', 'ERR_SMOKE_COMPILER_BUILD')
            if (value.kind !== 'success') continue
            ensure(typeof value.snapshot === 'string' && /^snapshots\/[0-9a-f-]+$/.test(value.snapshot), 'ERR_SMOKE_SNAPSHOT_PATH')
            const snapshot = resolve(receipts, value.snapshot)
            if (matches(snapshot, round)) {
              ensure(performance.now() <= deadline, 'ERR_SMOKE_INGRESS_DEADLINE')
              return { round, sequence: value.sequence, snapshot: value.snapshot,
                receiptSha256: hash(data), elapsedMs: performance.now() - start, compilerCommit: value.compilerCommit }
            }
          }
        }
        await delay(Math.min(20, Math.max(0, deadline - performance.now())))
      }
      throw new Error('ERR_SMOKE_INGRESS_DEADLINE')
    }
    activeStage = 'initial'
    report.initial = await awaitSnapshot(0, 0, report.initialDeadlineMs)
    let sequence = report.initial.sequence
    for (let round = 1; round <= 10; round += 1) {
      activeStage = `atomic-replace-${round}`
      const start = performance.now()
      for (const [name, contents] of Object.entries(inputs(round))) atomicReplace(resolve(project, name), contents)
      const row = await awaitSnapshot(round, sequence, report.iterationDeadlineMs)
      row.replaceToSnapshotMs = performance.now() - start
      ensure(row.compilerCommit === report.initial.compilerCommit, 'ERR_SMOKE_COMPILER_CHANGED')
      // Earlier immutable snapshots must remain untouched by later rebuilds.
      ensure(matches(resolve(receipts, report.initial.snapshot), 0), 'ERR_SMOKE_SNAPSHOT_MUTATED')
      report.iterations.push(row); sequence = row.sequence
    }
    activeStage = 'compiler-close'
  } catch (error) {
    report.status = 'failed'
    report.failedStage = activeStage
    report.code = /^ERR_[A-Z_]+$/.test(error?.message) ? error.message : 'ERR_SMOKE_INTERNAL'
  } finally {
    if (child && done) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await Promise.race([done.catch(() => {}), delay(2_000)])
      if (child.exitCode === null && child.signalCode === null) {
        forcedCleanup = true
        child.kill('SIGKILL')
      }
      try { await done } catch { report.cleanupError = 'ERR_SMOKE_CHILD_SPAWN' }
    }
    closeSync(fd)
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    report.childExit = exit ?? null
    report.forcedCleanup = forcedCleanup
    report.parentEnvironmentUnchanged = Object.entries(beforeParentEnvironment).every(([key, value]) =>
      Object.hasOwn(process.env, key) === value.present && process.env[key] === value.value)
    report.log = { path: 'compiler.private.log', bytes: readFileSync(log).length, sha256: hash(readFileSync(log)) }
    if (report.status !== 'failed') {
      try {
        assert.deepEqual(exit, { code: 0, signal: null })
        ensure(!forcedCleanup && !report.cleanupError && report.parentEnvironmentUnchanged, 'ERR_SMOKE_CLEANUP')
        const traces = readdirSync(diagnostics).filter(name => name.endsWith('.jsonl'))
        ensure(traces.length === 1, 'ERR_SMOKE_CONTEXT_COUNT')
        const trace = readFileSync(resolve(diagnostics, traces[0]))
        const records = trace.toString('utf8').trim().split('\n').map(JSON.parse)
        report.trace = { path: `watch-diagnostics/${traces[0]}`, bytes: trace.length, sha256: hash(trace) }
        report.configuredWatchers = records.filter(row => row.kind === 'watcher.configure')
          .map(row => ({ configuredOptions: row.configuredOptions, resolvedOptions: row.resolvedOptions }))
        ensure(report.configuredWatchers.length > 0 && report.configuredWatchers.every(row =>
          row.resolvedOptions.usePolling === options.selection.options.usePolling
          && row.resolvedOptions.interval === 150 && row.resolvedOptions.binaryInterval === 300), 'ERR_SMOKE_BACKEND_NOT_ACTUAL')
        ensure(records.at(-1)?.kind === 'trace.stop' && records.at(-1).traceState?.complete === true, 'ERR_SMOKE_TRACE_INCOMPLETE')
        report.status = 'passed'
      } catch (error) {
        report.status = 'failed'; report.failedStage = activeStage
        report.code = /^ERR_[A-Z_]+$/.test(error?.message) ? error.message : 'ERR_SMOKE_CLEANUP'
      }
    }
    put(resolve(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runSmoke(parseOptions(process.argv.slice(2)))).then(report => {
    console.log(JSON.stringify({ status: report.status, rounds: report.iterations.length,
      selectedBackend: report.selectedBackend, code: report.code ?? null }))
    process.exitCode = report.status === 'passed' ? 0 : 1
  }).catch(error => {
    console.error(JSON.stringify({ status: 'refused', code: /^ERR_[A-Z_]+$/.test(error?.message) ? error.message : 'ERR_SMOKE_ARGUMENT' }))
    process.exitCode = 1
  })
}
