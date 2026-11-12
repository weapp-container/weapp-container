/** CPU contracts over the exact pinned helper bodies. No official execution. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { descriptor } from './issue1182-descriptor.mjs'
import { createCollector } from './issue1182-collector.mjs'
import { instrumentPinnedAutomator } from '../../scripts/conformance-devtools-isolation.mjs'
import { createRuntimeTraceCollector } from '../../scripts/conformance-recipes.mjs'

const pinned = readFileSync(new URL('../../vendor/weapp-vite/e2e/utils/automator.ts', import.meta.url), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
assert.equal(hash(pinned), descriptor.sourceGuards['e2e/utils/automator.ts'])
const transformed = instrumentPinnedAutomator(pinned)
const selection = source => {
  const ensureStart = source.indexOf('function ensureRuntimeLogMeta(')
  const ensureEnd = source.indexOf('\nfunction isLikelyDevtoolsInfraErrorMessage', ensureStart)
  const closeStart = source.indexOf('function finalizeRuntimeLogMeta(')
  const closeEnd = source.indexOf('\nexport function resetAutomatorRuntimeLogs', closeStart)
  assert.ok(ensureStart > 0 && ensureEnd > ensureStart && closeStart > ensureEnd && closeEnd > closeStart)
  return source.slice(ensureStart, ensureEnd) + source.slice(closeStart, closeEnd).replace('export function', 'function')
}
const helper = (collector, mutate) => {
  const source = mutate ? mutate(transformed) : transformed
  return vm.runInNewContext(ts.transpileModule(selection(source), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
    + '\n({ enhanceMiniProgramWithRuntimeLogs, ensureRuntimeLogMeta })', {
    recordConformanceExceptionAuxiliary: (observation, invoke) => collector.exceptionAuxiliary(observation, invoke),
    RUNTIME_LOG_META_KEY: '__syntheticRuntimeLogMeta',
    normalizeRuntimeConsoleText: entry => entry?.message ?? '', resolveConsoleLevel: () => 'log',
    appendIdeReportEvent() {}, registerRuntimeConsoleSession: () => () => {}, logRuntimeStats() {},
  })
}
const plan = descriptor.plans[0]
const groups = step => step.queries.map(({ fields, ...query }, at) => ({ ...query, count: 1, nodes: [{ text: `actual-unit/${step.ordinal}/${at}` }] }))
function fixture({ mutate, closeError, disconnectError, closeEvent, official = true, collector: suppliedCollector } = {}) {
  const program = new EventEmitter(), events = [], errors = [], calls = [], pages = []
  program.currentPage = async () => pages.at(-1)
  program.reLaunch = async function (route) {
    calls.push({ op: 'reLaunch', receiver: this, route })
    const page = { path: route.replace(/^\//, ''), pageId: pages.length + 1, async callMethod(...args) { calls.push({ op: 'method', receiver: this, args }) } }
    pages.push(page); return page
  }
  program.flushConsole = async () => calls.push({ op: 'flushConsole' })
  program.disconnect = async function () {
    await Promise.resolve()
    if (closeEvent) program.emit('exception', closeEvent)
    if (disconnectError) throw disconnectError
  }
  program.close = async function () { await this.disconnect(); if (closeError) throw closeError; return 'actual-close-result' }
  const collector = suppliedCollector ?? createCollector({ emit: event => events.push({ ...structuredClone(event), seq: events.length }),
    ...(official ? { context: { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256 } } : {}) })
  const attachment = collector.attach(program)
  const actualHelper = helper(collector, mutate)
  const enhance = () => actualHelper.enhanceMiniProgramWithRuntimeLogs(program, 'synthetic-owned-project')
  const listen = callback => { const listener = callback ?? function (event) { assert.equal(this, program); errors.push(event.message) }
    assert.equal(program.on('exception', listener), program); return listener }
  const run = async () => {
    let page = await program.reLaunch('/' + plan.route)
    for (const step of plan.steps) {
      if (step.kind === 'checkpoint') collector.checkpoint({ evidence: { id: step.id, route: plan.route, nodes: groups(step) } }, { session: program, page })
      else if (step.kind === 'reLaunch') page = await program.reLaunch('/' + step.route)
      else await page.callMethod(step.method, ...step.args)
    }
  }
  return { program, collector, attachment, actualHelper, enhance, listen, run, events, errors, calls, pages }
}

test('exact pinned helper registers/disposes its actual auxiliary callback while the source interval remains intact', async () => {
  const f = fixture(); assert.equal(f.enhance(), f.program)
  assert.equal(f.program.rawListeners('exception').length, 1)
  const warmup = await f.program.reLaunch('/' + plan.route)
  assert.equal(await f.program.currentPage(), warmup)
  assert.equal(f.events.length, 0, 'launch warmup precedes source interval')
  const helperClose = f.program.close, helperRelaunch = f.program.reLaunch
  f.listen(); await f.run()
  assert.equal(await f.program.close(), 'actual-close-result')
  f.collector.flush()
  const diagnostics = f.collector.diagnostics().exceptionCapture
  assert.equal(diagnostics.failure, null); assert.equal(diagnostics.requireAuxiliary, true)
  assert.equal(diagnostics.ended, true); assert.equal(diagnostics.auxiliaryState, 'removed')
  assert.deepEqual(diagnostics.auxiliaryJournal.map(event => event.phase), ['register', 'remove'])
  assert.ok(diagnostics.auxiliaryJournal.every(event => event.actualCalls === 1 && event.actualCallbackIdentity && event.returnedOwner))
  assert.equal(f.program.rawListeners('exception').length, 1)
  assert.equal(f.program.close, helperClose); assert.equal(f.program.reLaunch, helperRelaunch)
  assert.equal(f.events[0].op, 'exceptions.begin'); assert.equal(f.events.at(-1).op, 'exceptions.end')
  assert.equal(f.calls.filter(call => call.op === 'method').length, 5)
})

test('the exact pinned helper bodies preserve callback receiver, payload identity and thrown callback errors', async () => {
  const f = fixture(), payload = { message: 'actual exception payload' }, error = new Error('actual callback error')
  f.enhance(); f.listen(function (value) { assert.equal(this, f.program); assert.equal(value, payload); throw error })
  assert.throws(() => f.program.emit('exception', payload), actual => actual === error)
  assert.deepEqual(f.collector.diagnostics().exceptionCapture.messages, [{ seq: 0, message: payload.message }])
  await f.run(); await f.program.close(); assert.throws(() => f.collector.flush(), /actual exception messages/)
})

test('async exceptions emitted during the pinned source close are retained after auxiliary dispose', async () => {
  const payload = { message: 'during-close' }, f = fixture({ closeEvent: payload })
  f.enhance(); f.listen(); await f.run(); await f.program.close()
  assert.deepEqual(f.errors, ['during-close'])
  assert.deepEqual(f.collector.diagnostics().exceptionCapture.messages, [{ seq: 0, message: payload.message }])
  assert.throws(() => f.collector.flush(), /actual exception messages/)
})

test('the exact pinned close and disconnect errors retain their original identity', async () => {
  for (const field of ['closeError', 'disconnectError']) {
    const error = new Error('actual ' + field), f = fixture({ [field]: error })
    f.enhance(); f.listen(); await f.run()
    await assert.rejects(f.program.close(), actual => actual === error)
    assert.throws(() => f.collector.flush(), /successful source registration and close/)
  }
})

test('official source registration requires the actual fixed auxiliary registration, not an empty attach window', () => {
  const f = fixture(); f.listen()
  assert.throws(() => f.collector.flush(), /lacks its fixed helper auxiliary registration/)
  assert.equal(f.events.length, 0)
})

test('unaltered helper auxiliary mutation without the exact observer hook fails closed', () => {
  const f = fixture({ mutate: () => pinned }); f.enhance(); f.listen()
  assert.throws(() => f.collector.flush(), /subscription was changed/)
})

test('wrong helper hash, callsite, phase, owner or callback cannot authorize an auxiliary mutation', () => {
  const mutations = [source => source.replaceAll(descriptor.exceptionCapture.auxiliaryListener.helperSha256, '0'.repeat(64)),
    source => source.replace("'e2e/utils/automator.ts:548'", "'e2e/utils/automator.ts:547'"),
    source => source.replace("phase: 'register'", "phase: 'remove'"),
    source => source.replace('program: miniProgram', 'program: {}'),
    source => source.replace('listener: onException', 'listener: () => {}')]
  for (const mutate of mutations) {
    const f = fixture({ mutate }); f.enhance(); f.listen()
    assert.throws(() => f.collector.flush(), /auxiliary exception|actual exception subscription/)
  }
})

test('source and auxiliary removal outside close, extra subscriptions, and forged no-op hooks are rejected', async () => {
  for (const operation of [f => f.program.addListener('exception', () => {}), f => f.program.removeAllListeners('exception'),
    f => f.program.removeListener('exception', f.program.rawListeners('exception')[0]),
    f => f.program.off('exception', f.program.rawListeners('exception')[1]),
    f => f.program.on('exception', () => {})]) {
    const f = fixture(); f.enhance(); f.listen(); operation(f)
    assert.throws(() => f.collector.flush(), /subscription was changed|registration is duplicate/)
  }
  const f = fixture(), auxiliary = () => {}
  const returned = f.collector.exceptionAuxiliary({ program: f.program, phase: 'register', event: 'exception', listener: auxiliary,
    sourceCallsite: descriptor.exceptionCapture.auxiliaryListener.registerCallsite,
    helperSha256: descriptor.exceptionCapture.auxiliaryListener.helperSha256 }, () => 'actual-non-mutation-return')
  assert.equal(returned, 'actual-non-mutation-return')
  assert.throws(() => f.collector.flush(), /single successful actual mutation/)
})

test('missing source close or altered auxiliary disposal cannot claim a complete source interval', async () => {
  const noClose = fixture(); noClose.enhance(); noClose.listen(); await noClose.run()
  assert.throws(() => noClose.collector.flush(), /successful source registration and close/)
  for (const mutate of [source => source.replace("phase: 'remove'", "phase: 'register'"),
    source => source.replace("'e2e/utils/automator.ts:558'", "'e2e/utils/automator.ts:559'"),
    source => source.replace("() => miniProgram.removeListener('exception', onException)", '() => miniProgram'),
    source => source.replace("miniProgram.removeListener('exception', onException))", "miniProgram.removeAllListeners('exception'))")]) {
    const f = fixture({ mutate }); f.enhance(); f.listen(); await f.run(); await f.program.close()
    assert.throws(() => f.collector.flush(), /auxiliary exception|subscription was changed/)
  }
})

test('the instrumentation rejects missing/duplicate auxiliary registration and disposal anchors', () => {
  for (const anchor of ["  addListener('exception', onException)", "      miniProgram.removeListener('exception', onException)"]) {
    assert.throws(() => instrumentPinnedAutomator(pinned.replace(anchor, '')), /missing or ambiguous/)
    assert.throws(() => instrumentPinnedAutomator(pinned + '\n' + anchor), /missing or ambiguous/)
  }
})

test('the real worker collector forwards synchronous helper hooks and persists complete source and auxiliary observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'exception-worker-'))
  try {
    const recipePath = join(directory, 'recipe.json'), outputFile = join(directory, 'events.json')
    const recipe = JSON.parse(readFileSync(new URL('./issue1182-v1.json', import.meta.url))).recipes[0]
    const resolve = path => fileURLToPath(new URL('../../' + path, import.meta.url))
    await writeFile(recipePath, JSON.stringify({ caseId: recipe.caseId, sourceSha256: recipe.sourceSha256,
      fixtureProfile: 'captured-static-v1', collectorPath: resolve(recipe.collector.path), collectorInputPaths: recipe.collectorInputs.map(ref => resolve(ref.path)) }))
    const collector = await createRuntimeTraceCollector({ recipePath, outputFile })
    collector.bindFixtureCheckpoint({ path: 'synthetic/fixture.json', sha256: 'a'.repeat(64), bytes: 1 })
    const f = fixture({ collector }); await f.attachment
    assert.equal(f.enhance(), f.program)
    f.listen(); await f.run(); assert.equal(await f.program.close(), 'actual-close-result'); await collector.flush()
    const observed = JSON.parse(await readFile(outputFile, 'utf8'))
    assert.equal(observed.status, 'passed'); assert.deepEqual(observed.failures, []); assert.equal(observed.events.length, 16)
    const diagnostics = JSON.parse(await readFile(join(directory, 'collector-query-diagnostics.json'), 'utf8')).exceptionCapture
    assert.equal(diagnostics.requireAuxiliary, true); assert.equal(diagnostics.auxiliaryJournal.length, 2); assert.equal(diagnostics.ended, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unselected collectors preserve synchronous helper operation returns and exact thrown errors', async () => {
  const collector = await createRuntimeTraceCollector({}), value = {}, error = new Error('actual operation rejection')
  let calls = 0
  assert.equal(collector.exceptionAuxiliary({}, () => { calls++; return value }), value)
  assert.equal(calls, 1)
  assert.throws(() => collector.exceptionAuxiliary({}, () => { throw error }), actual => actual === error)
})
