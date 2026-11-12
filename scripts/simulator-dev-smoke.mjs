#!/usr/bin/env node
/** End-to-end compiler -> pack -> runtime -> Web development smoke. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectDevEvents, installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'
import { assertDiagnosticResponse } from './simulator-dev-assertions.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/simulator-dev-smoke.mjs [options]
  --project <dir>   project (default: examples/apps/reference-app)
  --wxss <file>     source WXSS, relative to project (default: first source WXSS)
  --port <number>   listener port (default: 0, allocated by OS)
  --engine <name>   quickjs (default) or v8
  --timeout <ms>    startup/reload deadline (default: 120000)
  --out <file>      write JSON report
  --keep           preserve this run's unique staging directory`)
  process.exit(0)
}
const project = resolve(valueAfter('--project', 'examples/apps/reference-app'))
const port = Number(valueAfter('--port', '0'))
const engine = valueAfter('--engine', 'quickjs')
const timeoutMs = Number(valueAfter('--timeout', '120000'))
const reportPath = valueAfter('--out', null)
const keep = args.includes('--keep')
if (!existsSync(project)) throw new Error(`project does not exist: ${project}`)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${port}`)
if (!['quickjs', 'v8'].includes(engine)) throw new Error(`invalid --engine: ${engine}`)
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error(`invalid --timeout: ${timeoutMs}`)

function sourceFiles(directory) {
  const ignored = new Set(['.git', '.weapp-container', 'dist', 'node_modules'])
  const files = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(resolve(current, entry.name))
      else if (entry.isFile()) files.push(resolve(current, entry.name))
    }
  }
  visit(directory)
  return files.sort()
}
const files = sourceFiles(project)
const wxssArg = valueAfter('--wxss', null)
const source = wxssArg ? resolve(project, wxssArg) : files.find(path => path.endsWith('.wxss'))
if (!source || !existsSync(source)) throw new Error('fixture has no source WXSS file')
if (!source.startsWith(`${project}${sep}`)) throw new Error('--wxss must point inside the project')
const appJson = files.find(path => path.endsWith(`${sep}app.json`))
const appScript = appJson && ['app.js', 'app.ts', 'app.mjs'].map(name => resolve(dirname(appJson), name)).find(existsSync)
if (!appJson || !appScript) throw new Error('smoke requires source app.json and app.js/app.ts/app.mjs')
const originals = new Map([source, appScript, appJson].map(path => [path, readFileSync(path, 'utf8')]))
const expected = new Map(originals)
function edit(path, text, restoring = false) {
  if (!restoring) signals.signal.throwIfAborted()
  if (readFileSync(path, 'utf8') !== expected.get(path)) throw new Error(`source changed concurrently; refusing overwrite: ${path}`)
  writeFileSync(path, text)
  expected.set(path, text)
}
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const provenance = {
  commit: git(['rev-parse', 'HEAD']),
  workspaceVendorCommit: git(['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD']),
  workspaceVendorDirty: git(['-C', 'vendor/weapp-vite', 'status', '--porcelain']).length > 0,
  environment: { platform: process.platform, arch: process.arch, node: process.version },
}
const startedAt = Date.now()
const signals = installSmokeSignals()
let simulator
let sse
let report
try {
  simulator = await startDevSimulator({ root, project, port, engine, timeoutMs, signal: signals.signal,
    onOutput: (text, stderr) => (stderr ? process.stderr : process.stdout).write(text) })
  const initial = await simulator.waitForState(value => value.revision > 0 && value.status === 'ready', 'initial generation')
  if (!initial.sessionId || initial.engine !== engine) throw new Error('initial engine/session mismatch')
  const frame = await simulator.json('/api/snapshot')
  if (!(frame.width > 0 && frame.height > 0) || frame.pixels?.length !== frame.width * frame.height * 4) {
    throw new Error('invalid RGBA snapshot')
  }
  sse = await connectDevEvents(simulator.url, timeoutMs, { signal: signals.signal })
  const reloadPromise = sse.nextEvent('reload', value => value.revision > initial.revision)
  reloadPromise.catch(() => {})
  edit(source, `${originals.get(source)}\n/* weapp simulator smoke ${Date.now()} */\n`)
  const [styled, reload] = await Promise.all([
    simulator.waitForState(value => value.revision > initial.revision, 'WXSS in-place reload'), reloadPromise,
  ])
  if (reload.kind !== 'InPlace' || styled.sessionId !== initial.sessionId || reload.revision !== styled.revision) {
    throw new Error('WXSS reload did not preserve the session or SSE revision')
  }
  await sse.close()
  sse = null
  edit(appScript, `${originals.get(appScript)}\nglobalThis.__weappContainerDevSmokeRevision = ${Date.now()};\n`)
  const restarted = await simulator.waitForState(value => value.revision > styled.revision && value.status === 'ready', 'JS restart')
  if (restarted.sessionId === styled.sessionId) throw new Error('JS reload did not rotate the session')
  edit(appJson, '{ invalid weapp smoke JSON')
  const broken = await simulator.waitForState(value => value.diagnostics?.some(row => row.code === 'BUILD_FAILED'), 'build error diagnostic')
  if (broken.sessionId !== restarted.sessionId || broken.revision !== restarted.revision) {
    throw new Error('failed build replaced the last working session/generation')
  }
  const requestId = `dev-smoke-live-${Date.now()}`
  sse = await connectDevEvents(simulator.url, timeoutMs, { signal: signals.signal })
  const request = {
    protocolVersion: '1.0', sessionId: restarted.sessionId, requestId,
    kind: 'request', op: 'diagnostic', payload: { message: 'last valid generation remains usable' },
  }
  const bridgeResponse = sse.nextEvent('bridge', batch => batch.messages?.some(message => message.requestId === requestId && message.kind === 'response'))
  const [, bridgeBatch] = await Promise.all([simulator.json('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }), bridgeResponse])
  assertDiagnosticResponse(bridgeBatch, request)
  await sse.close()
  sse = null
  edit(appJson, originals.get(appJson))
  const recovered = await simulator.waitForState(value => value.status === 'ready' && !value.diagnostics?.length, 'build recovery')
  if (!recovered.diagnosticHistory.records.some(row => row.code === 'BUILD_FAILED')) throw new Error('recovery lost diagnostic history')
  report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'simulator-dev-smoke', ...provenance,
    status: 'passed', project, source: relative(project, source), surface: 'web-software', engine,
    compiler: initial.compiler,
    url: simulator.url, staging: simulator.staging,
    initialRevision: initial.revision, reloadRevision: styled.revision, restartRevision: restarted.revision,
    initialSessionId: initial.sessionId, reloadSessionId: styled.sessionId, restartSessionId: restarted.sessionId,
    initialSnapshot: { width: frame.width, height: frame.height, pixelBytes: frame.pixels.length },
    reloadEvent: { type: 'reload', revision: reload.revision, kind: reload.kind },
    checks: { wxssInPlace: 'passed', jsRestart: 'passed', buildErrorDiagnostic: 'passed', bridgeDuringBuildFailure: 'passed', recoveryHistory: 'passed' },
    elapsedMs: Date.now() - startedAt,
    evidence: 'development simulator only; no DevTools/GPU/device gate',
  }
} catch (error) {
  report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'simulator-dev-smoke', ...provenance,
    status: 'failed', project, engine, elapsedMs: Date.now() - startedAt,
    error: String(error?.stack || error), outputTail: simulator?.outputTail(),
  }
  process.exitCode ||= 1
} finally {
  const cleanupErrors = []
  const cleanup = async (name, fn) => { try { return await fn() } catch (error) { cleanupErrors.push(`${name}: ${error.stack || error}`) } }
  for (const [path, original] of [...originals].reverse()) {
    if (expected.get(path) !== original) await cleanup(`restore ${path}`, () => edit(path, original, true))
  }
  await cleanup('SSE', async () => { if (sse) await sse.close() })
  report.cleanup = await cleanup('simulator', async () => simulator?.stop({ keep }))
  if (cleanupErrors.length) {
    report.status = 'failed'
    report.cleanupErrors = cleanupErrors
    process.exitCode = 1
  }
  signals.dispose()
}
const serialized = `${JSON.stringify(report, null, 2)}\n`
process.stdout.write(serialized)
if (reportPath) {
  mkdirSync(dirname(resolve(reportPath)), { recursive: true })
  writeFileSync(resolve(reportPath), serialized)
}
