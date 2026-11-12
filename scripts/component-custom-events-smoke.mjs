#!/usr/bin/env node
/** Raw weapp -> real packer -> native QuickJS/V8 custom-event evidence. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'conformance/fixtures/component-custom-events')
const ALIASES = {
  bare: 'bare', colon: 'colon', both: 'bare', reverse: 'bare',
  'hyphen-bare': null, 'hyphen-colon': 'colon', 'hyphen-both': 'colon',
  'under-bare': 'bare', 'under-colon': 'colon', 'under-both': 'bare',
}
const SCENARIOS = {
  private: ['direct'], capture: ['capture', 'direct'], bubble: ['direct', 'bubble'],
  'capture-bubble': ['capture', 'direct', 'bubble'], caught: ['capture', 'caught'],
  'capture-caught': ['capture', 'caught'], local: ['boundary-direct', 'boundary-bubble'],
  composed: ['boundary-direct', 'boundary-bubble', 'direct', 'bubble'],
}

export function inspectEmission(result, labels, label) {
  assert.ok(result && typeof result === 'object', `${label} executed a component method`)
  assert.deepEqual(result.records?.map(record => record.label), ['before', ...labels, 'after'], `${label} same-turn handler order`)
  assert.equal(result.returnedUndefined, true, `${label} triggerEvent returns undefined`)
  assert.equal(result.circular, true, `${label} circular detail retained inside isolate`)
  assert.equal(result.callable, true, `${label} function detail retained inside isolate`)
  assert.equal(result.handledBeforeReturn, labels.length > 0, `${label} listener writes visible before return`)
  for (const record of result.records.slice(1, -1)) {
    assert.equal(record.sameDetail, true, `${label} exact detail identity`)
    assert.equal(record.circular, true, `${label} handler sees circular reference`)
    assert.equal(record.callable, true, `${label} handler sees callable value`)
    assert.equal(record.value, 7, `${label} original payload value`)
  }
}

export function inspectSummary(summary) {
  assert.equal(summary?.launched, true, 'real App.onLaunch executed before Page.onLoad')
  assert.equal(summary.capability, true, 'manifest and native facade negotiate Component.triggerEvent')
  assert.deepEqual(Object.keys(summary.aliases ?? {}).sort(), Object.keys(ALIASES).sort(), 'complete alias observations')
  const counters = {}
  for (const [id, handler] of Object.entries(ALIASES)) {
    inspectEmission(summary.aliases[id], handler ? [handler] : [], id)
    counters[id] = { bare: Number(handler === 'bare'), colon: Number(handler === 'colon') }
    for (const record of summary.aliases[id].records.slice(1, -1)) {
      assert.equal(record.target, id, `${id} custom-event target`)
      assert.equal(record.current, id, `${id} listener currentTarget`)
      assert.equal(record.owner, 'page', `${id} declaration owner`)
      assert.equal(record.phase, 'target', `${id} direct phase`)
    }
  }
  assert.deepEqual(summary.counters, counters, 'independent listener counters match saved alias oracle rules')
  assert.deepEqual(Object.keys(summary.scenarios ?? {}).sort(), Object.keys(SCENARIOS).sort(), 'complete local option observations')
  for (const [name, labels] of Object.entries(SCENARIOS)) inspectEmission(summary.scenarios[name], labels, name)
  const local = summary.scenarios.local.records.slice(1, -1)
  assert.deepEqual(local.map(record => [record.owner, record.target]), [['boundary', 'nested'], ['boundary', 'nested']], 'non-composed event remains inside component')
  const composed = summary.scenarios.composed.records.slice(1, -1)
  assert.deepEqual(composed.map(record => [record.owner, record.target, record.current, record.phase]), [
    ['boundary', 'nested', 'nested', 'target'],
    ['boundary', 'nested', 'boundary-inner', 'bubble'],
    ['page', 'boundary', 'boundary', 'bubble'],
    ['page', 'boundary', 'outer', 'bubble'],
  ], 'composed event retargets at the component host and uses declaration receivers')
  return summary
}

export function inspectTrace(trace) {
  const records = trace.records ?? trace.events ?? []
  for (const record of records) for (const message of record.response?.messages ?? []) {
    assert.notEqual(message.op, 'error', `unexpected runtime error: ${JSON.stringify(message.payload)}`)
    assert.notEqual(message.payload?.ok, false, `unexpected failed request: ${JSON.stringify(message.payload)}`)
  }
  const payload = matchedResponse(trace, 'inspect-custom-events', 'module.call')
  assert.equal(payload.moduleId, 'module:pages/index/index.js', 'real page module inspected')
  assert.equal(payload.export, 'inspect', 'real exported function called')
  assert.equal(payload.result?.length, 1, 'one native return value')
  const summary = inspectSummary(payload.result[0])
  const renderIndex = records.findIndex(record => record.request?.op === 'render.commit')
  assert.ok(renderIndex >= 0, 'canonical startup committed a real frame')
  const effects = []
  function visit(value, index) {
    if (!value || typeof value !== 'object') return
    if (value.type === 'component.custom.event') effects.push({ index, effect: value })
    for (const child of Object.values(value)) visit(child, index)
  }
  records.forEach((record, index) => visit(record.response, index))
  assert.equal(effects.length, 18, 'every real onLoad emission produced one metadata-only effect')
  for (const { index, effect } of effects) {
    assert.ok(index < renderIndex, 'custom events executed during onLoad before first render')
    assert.equal(Object.hasOwn(effect, 'detail'), false, 'circular/function detail never enters JSON effects')
  }
  return { summary, beforeFirstFrameEmissions: effects.length }
}

function parseArguments(argv) {
  const options = { out: resolve(ROOT, 'artifacts/component-custom-events.json'), timeoutMs: 120_000 }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (name === '--') continue
    if (name === '--help' || name === '-h') return { help: true }
    if (!['--simulator-bin', '--out', '--timeout'].includes(name)) throw new Error(`Unknown option: ${name}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    if (name === '--simulator-bin') options.simulatorBin = resolve(value)
    if (name === '--out') options.out = resolve(value)
    if (name === '--timeout') options.timeoutMs = Number(value)
  }
  if (!options.simulatorBin) throw new Error('--simulator-bin is required; this smoke never starts Cargo')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout must be >= 1000 milliseconds')
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write('Usage: node scripts/component-custom-events-smoke.mjs --simulator-bin <path> [--out <json>] [--timeout <ms>]\n')
    return
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-custom-events-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: options.timeoutMs })
  const { command } = runner
  const report = { schemaVersion: 1, scope: 'component-custom-events', status: 'failed', generatedAt: new Date().toISOString(),
    fixture: { path: relative(ROOT, FIXTURE), kind: 'raw-weapp' }, engines: [], comparison: { status: 'not-run' }, cleanup: {},
    evidenceBoundary: 'Auxiliary real portable pack/native QuickJS/V8 evidence. Saved official lifecycle-compare constrains listener aliases/names only. Options, same-turn ordering, detail identity and composition remain local contracts; no new DevTools, browser, GPU, device, seven-host or performance pass.' }
  try {
    report.sourceCommit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.workingTreeDirty = Boolean((await command('git', ['status', '--short'])).stdout.trim())
    report.fixture.sha256 = await sourceHashes(FIXTURE)
    report.simulator = { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
    const compilerCommit = (await command('git', ['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD'])).stdout.trim()
    const pack = resolve(temporary, 'pack')
    await command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', FIXTURE, '--out', pack, '--compiler-commit', compilerCommit])
    const bytes = await readFile(resolve(pack, 'manifest.json'))
    const manifest = JSON.parse(bytes)
    assert.equal(manifest.capabilities['Component.triggerEvent'], 'partial', 'packer declares the implemented custom-event subset')
    report.pack = { manifestSha256: sha256(bytes), integrityRoot: manifest.integrity.root, compilerCommit, rawFixtureNotCompilerOutput: true }
    const script = resolve(temporary, 'inspect.jsonl')
    await writeFile(script, JSON.stringify({ protocolVersion: '1.0', sessionId: 'simulator-1', requestId: 'inspect-custom-events',
      kind: 'request', op: 'module.call', payload: { moduleId: 'module:pages/index/index.js', export: 'inspect', args: [] } }) + '\n')
    for (const engine of ['quickjs', 'v8']) {
      const entry = { engine, status: 'failed' }
      report.engines.push(entry)
      try {
        const tracePath = resolve(temporary, engine + '.trace.json')
        const reportPath = resolve(temporary, engine + '.report.json')
        const executed = await command(options.simulatorBin, ['run', '--pack', pack, '--engine', engine,
          '--script', script, '--trace', tracePath, '--report', reportPath])
        entry.process = Object.fromEntries(Object.entries(executed).filter(([key]) => key !== 'stdout'))
        const simulator = JSON.parse(await readFile(reportPath, 'utf8'))
        const trace = JSON.parse(await readFile(tracePath, 'utf8'))
        assert.equal(simulator.status, 'passed', 'canonical startup passed')
        assert.equal(simulator.engine, engine, 'actual requested engine without fallback')
        assert.equal(simulator.route, 'pages/index/index', 'actual fixture page')
        assert.equal(simulator.lifecycleState, 'Active', 'real App/Page startup')
        entry.simulator = simulator
        entry.observations = inspectTrace(trace)
        entry.traceSha256 = sha256(await readFile(tracePath))
        entry.trace = trace
        entry.status = 'passed'
      } catch (error) {
        entry.error = error.stack ?? String(error)
        if (error.result) entry.process = error.result
        if (runner.interrupted) throw error
      }
    }
    if (report.engines.every(entry => entry.status === 'passed')) {
      assert.deepEqual(report.engines[0].observations, report.engines[1].observations, 'native engines agree on independently asserted custom-event outcomes')
      report.comparison = { status: 'passed' }
      report.status = 'passed'
    }
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (error.result) report.failedProcess = error.result
  } finally {
    if (runner.active) runner.stop()
    report.cleanup.childProcessClosed = runner.active === null
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true }
    catch (error) { report.cleanup.temporaryRemoved = false; report.cleanup.error = String(error); report.status = 'failed' }
    report.cleanup.noListenerOrBrowserCreated = true
    if (runner.interrupted) { report.interrupted = runner.interrupted; report.status = 'failed' }
    report.finishedAt = new Date().toISOString()
    await mkdir(dirname(options.out), { recursive: true })
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n')
    runner.dispose()
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out, engines: report.engines.map(({ engine, status }) => ({ engine, status })), cleanup: report.cleanup }) + '\n')
  if (runner.interrupted) process.exitCode = runner.interrupted === 'SIGINT' ? 130 : 143
  else if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
