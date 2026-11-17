#!/usr/bin/env node
// Actual pinned-compiler watcher evidence; no browser or device is created.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectDevEvents, installSmokeSignals, readDevSessionPaths, startDevSimulator } from './simulator-dev-harness.mjs'
import { assertDiagnosticResponse } from './simulator-dev-assertions.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
if (args.includes('--help')) {
  console.log('Usage: node scripts/modern-view-watch-smoke.mjs [--simulator-bin path] [--engine quickjs|v8] [--project-local-output] [--out report.json]')
  process.exit(0)
}
const engine = option('--engine', 'quickjs')
const binary = resolve(option('--simulator-bin', join(root, 'target/debug/weapp-simulator')))
const output = resolve(option('--out', join(root, `artifacts/modern-view-watch/${engine}.json`)))
const owned = await mkdtemp(join(tmpdir(), 'weapp-modern-watch-'))
const project = join(owned, 'project')
const signals = installSmokeSignals()
const report = {
  schemaVersion: 1, status: 'failed', kind: 'real-compiler-modern-watch', engine,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  compilerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, 'vendor/weapp-vite'), encoding: 'utf8' }).trim(),
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  generatedAt: new Date().toISOString(), resources: {}, checks: {},
  limitations: ['not official WXS or DevTools evidence', 'not GPU/device or performance acceptance'],
}
let simulator, failure, preparation, events
const cleanupErrors = []
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function stable(state, label, duration = 1800) {
  const deadline = Date.now() + duration
  let samples = 0
  while (Date.now() < deadline) {
    signals.signal.throwIfAborted()
    const current = await simulator.json('/api/state')
    assert.equal(current.status, 'ready', `${label}: generated artifacts must not restart the compiler`)
    assert.equal(current.revision, state.revision, `${label}: revision must remain stable without source changes`)
    assert.equal(current.sessionId, state.sessionId, `${label}: session must remain stable`)
    assert.equal(current.diagnostics.length, 0, `${label}: no incomplete raw snapshot may be published`)
    samples++
    await sleep(100)
  }
  return { revision: state.revision, samples, durationMs: duration }
}
try {
  report.sourceHashes = Object.fromEntries(await Promise.all([
    'scripts/simulator-watch.mjs', 'scripts/modern-view-watch-smoke.mjs',
    'crates/container-simulator/src/dev.rs', 'tools/container-manifest/src/modern-view.ts',
  ].map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
  await cp(join(root, 'examples/apps/modern-view-app'), project, { recursive: true,
    filter: source => !['dist', '.weapp-vite', '.weapp-container', 'node_modules'].includes(source.split(sep).at(-1)) })
  simulator = await startDevSimulator({ root, project, engine, port: 0, timeoutMs: 60_000,
    launcher: { command: binary, mode: 'simulator' }, signal: signals.signal,
    ...(args.includes('--project-local-output') ? { stagingRoot: join(project, '.weapp-container') } : {}),
    onOutput: (text, stderr) => (stderr ? process.stderr : process.stdout).write(text) })
  report.resources = { simulatorPid: simulator.child.pid, url: simulator.url, project, outDir: simulator.staging }
  assert.equal(simulator.staging.startsWith(project + sep), args.includes('--project-local-output'))
  const initial = await simulator.waitForState(state => (state.status === 'ready' && state.revision > 0)
    || state.diagnostics?.some(item => item.severity === 'error'), 'initial real watcher generation')
  assert.equal(initial.status, 'ready', `initial pack rejected: ${JSON.stringify(initial.diagnostics)}`)
  report.checks.initialStable = { status: 'passed', ...await stable(initial, 'initial watch') }
  const paths = readDevSessionPaths(simulator.staging, simulator.child.pid, project)
  preparation = paths.preparationRoot
  assert.ok(!preparation.startsWith(await realpath(project) + sep))
  assert.equal(simulator.compilerOutput(), paths.compilerOutput)
  assert.deepEqual(JSON.parse(await readFile(join(paths.compilerOutput, 'app.json'), 'utf8')).pages, ['pages/home/index'])
  report.resources.preparation = preparation
  const sourcePath = join(project, 'view/format.view.ts')
  const source = await readFile(sourcePath, 'utf8')
  const updated = source.replace('Standard JS: [].constructor === Array', 'Modern watcher update verified')
  assert.notEqual(updated, source)
  await writeFile(sourcePath, updated)
  const reloaded = await simulator.waitForState(state => state.status === 'ready' && state.revision > initial.revision, 'modern-only source reload')
  assert.notEqual(reloaded.sessionId, initial.sessionId)
  report.checks.modernOnlyStable = { status: 'passed', ...await stable(reloaded, 'modern-only watch') }
  await writeFile(sourcePath, 'export const syntaxError = ;\n')
  const failed = await simulator.waitForState(state => state.diagnostics?.some(item => item.code === 'BUILD_FAILED'), 'modern syntax failure')
  assert.equal(failed.sessionId, reloaded.sessionId, 'a rejected pack must keep the accepted runtime')
  // The bridge still responds while the source compiler is in a failed state.
  events = await connectDevEvents(simulator.url, 10_000, { signal: signals.signal })
  const request = {
    protocolVersion: '1.0', sessionId: reloaded.sessionId, requestId: 'modern-watch-rejected-generation',
    kind: 'request', op: 'diagnostic', payload: { message: 'rejected generation retains responsive runtime' },
  }
  const response = events.nextEvent('bridge', batch => batch.messages?.some(message => message.requestId === request.requestId && message.kind === 'response'))
  response.catch(() => {})
  const [, batch] = await Promise.all([
    simulator.json('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }), response,
  ])
  assertDiagnosticResponse(batch, request)
  await events.close()
  events = null
  report.checks.failurePreservesSession = { status: 'passed', revision: failed.revision }
  await writeFile(sourcePath, source)
  const recovered = await simulator.waitForState(state => state.status === 'ready' && state.revision > failed.revision, 'modern source recovery')
  report.checks.recoveryStable = { status: 'passed', ...await stable(recovered, 'recovered watch') }
  report.status = 'passed'
} catch (error) {
  failure = error
  report.error = { message: error.message, stack: error.stack, output: simulator?.outputTail() }
} finally {
  for (const [name, close] of [
    ['events', () => events?.close()],
    ['simulator', () => simulator?.stop()],
    ['project', () => rm(owned, { recursive: true, force: true })],
  ]) {
    try { await close() } catch (error) { cleanupErrors.push({ name, message: error.message }) }
  }
  if (preparation) {
    try {
      await readdir(preparation)
      cleanupErrors.push({ name: 'preparation', message: 'owned compiler preparation remains after shutdown' })
    } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push({ name: 'preparation', message: error.message }) }
  }
  signals.dispose()
  report.cleanup = { status: cleanupErrors.length ? 'failed' : 'passed', errors: cleanupErrors }
  if (cleanupErrors.length) report.status = 'failed'
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ status: report.status, report: output, checks: Object.keys(report.checks), cleanup: report.cleanup }))
if (failure) throw failure
if (cleanupErrors.length) throw new Error(`modern watcher cleanup failed: ${JSON.stringify(cleanupErrors)}`)
