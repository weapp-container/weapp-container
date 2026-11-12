/** Synthetic adapter/admission contracts only; never official/native evidence. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { descriptor } from '../../../conformance/recipes/issue1013-descriptor.mjs'
import { replayCase, caseDefinition, collectorInputs } from './replay.mjs'
import { issue1013ActionTape } from './issue1013-replay.mjs'
import { issue1013AssertionIds, loadIssue1013Inputs, assertIssue1013StaticOutputs } from './issue1013-static.mjs'
import { createObservedNativeProgram } from './native-program.mjs'
import { run as runNative, runDiagnostic } from './driver.mjs'
import { replaySourcePlan } from './source-plan-replay.mjs'

const CASE = descriptor.caseId, SOURCE = descriptor.sourceSha256, plan = descriptor.plans[0]
const COMMIT = '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e', BASELINE = 'wechat-devtools-2.02.2609250-sdk-3.17.3'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = { manifest: { compiler: { commit: COMMIT }, integrity: { root: 'a'.repeat(64) } } }
const generatedWxml = '<view data-title="{{staticTitle}}" bindtap="__weapp_vite_inline" data-wd-ready="1" bindready="__weapp_vite_inline" />'
const checkpointNodes = step => step.queries.map(({ fields, ...address }, index) => ({ ...structuredClone(address), count: 1,
  nodes: [{ text: `synthetic observation ${step.ordinal}/${index}`, ...(fields.attributes.length ? {
    attributes: Object.fromEntries(fields.attributes.map(name => [name, `synthetic field ${step.ordinal}`])) } : {}) }] }))
function originalTrace() {
  const events = [{ seq: 0, kind: 'lifecycle', op: 'route.active', payload: { planOrdinal: 0, route: plan.route }, atNs: '100' }]
  for (const step of plan.steps) events.push({ seq: events.length, kind: step.kind === 'tap' ? 'event' : 'render',
    op: step.kind === 'tap' ? 'tap' : 'dom.checkpoint', payload: step.kind === 'tap'
      ? { planOrdinal: 0, route: plan.route, actionOrdinal: step.ordinal, ...step.address }
      : { planOrdinal: 0, route: plan.route, checkpointOrdinal: step.ordinal, id: step.id, nodes: checkpointNodes(step) }, atNs: String(events.length + 100) })
  return { schemaVersion: 1, caseId: CASE, oracle: 'wechat-devtools', run: { status: 'passed', host: 'devtools', engine: 'wechat',
    environment: { baselineId: BASELINE, compilerCommit: COMMIT, caseSourceSha256: SOURCE, manifestIntegrity: fixture.manifest.integrity.root } },
  events, assertions: issue1013AssertionIds.map(id => ({ id, passed: true })) }
}
function syntheticWire({ mutate, fail } = {}) {
  const calls = []; let pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = 'pages/home/index'
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: 'synthetic-unit-only', route, pageId: String(pageId),
    templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision + 10), renderRevision: String(revision),
    presentationAckRevision: String(revision), actionSeq: String(action), ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  const request = async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) })
    if (op === fail?.op) throw fail.error
    pump++
    let value
    if (op === 'render.settle') value = proof()
    else if (op === 'reLaunch') { route = payload.route.replace(/^\//, ''); pageId++; revision++; action++; required = pump + 1; pump++; value = { path: route, completion: proof() } }
    else if (op === 'currentPage') value = { path: route, pageId: String(pageId), completion: proof() }
    else {
      assert.equal(payload.route, route)
      const address = { route, selector: payload.selector, ...(payload.scope ? { scope: structuredClone(payload.scope) } : {}),
        frameId: revision + 10, renderRevision: revision, completion: proof() }
      if (op === 'query') value = { ...address, count: 1, nodes: [{ id: 'actual/' + payload.selector, componentScopeId: null }] }
      else if (op === 'query.attribute') value = { ...address, count: 1, name: payload.name, present: true, value: { type: 'string', value: 'synthetic-ready-marker' } }
      else if (op === 'tap') {
        const inputCompletion = proof(), frameId = revision + 10, renderRevision = revision
        action++; required = pump + 1; pump++; revision++
        value = { ...address, frameId, renderRevision, x: 10, y: 20, inputTransport: 'native-host-coordinate-event', inputCompletion, completion: proof() }
      } else if (op === 'checkpoint') {
        const step = plan.steps.find(step => step.kind === 'checkpoint' && step.id === payload.checkpoint)
        value = { id: step.id, route, nodes: checkpointNodes(step), completion: proof() }
      } else throw new Error('Unplanned synthetic native operation ' + op)
    }
    return mutate?.(value, op, payload, calls) ?? value
  }
  return { calls, request }
}
function staticClosure(mutate = () => {}) {
  const store = new Map(), records = {}
  const put = (key, value) => {
    const replacement = mutate(key, value); if (replacement !== undefined) value = replacement
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    const reference = { path: 'synthetic/' + key, sha256: hash(bytes), bytes: bytes.length }
    store.set(reference.path, bytes); records[key] = { value, reference }; return reference
  }
  const generated = descriptor.compiledFiles.map((path, index) => ({ kind: 'file', path,
    artifact: put('file-' + index, path === 'pages/issue-1013/index.wxml' ? generatedWxml : path.endsWith('.json') ? '{}' : '') }))
  generated.push({ kind: 'file', path: 'app.json', artifact: put('app', '{"pages":[]}') }); mutate('generated', generated)
  const runtime = structuredClone(generated); mutate('runtime', runtime)
  const transaction = put('transaction', { schemaVersion: 1, kind: 'weapp-container.github-producer-transaction', profile: 'github-static-snapshot-v1',
    runtimeRoot: '/synthetic/runtime', runtimeProjectPath: '/synthetic/runtime', snapshotFiles: [...runtime,
      { kind: 'file', path: 'project.config.json', artifact: put('runtime-config', '{}') }] })
  const checkpoint = put('checkpoint', { schemaVersion: 1, kind: 'weapp-container.static-generated-checkpoint', status: 'captured',
    caseId: CASE, sourceSha256: SOURCE, producerTransaction: transaction, runtimeGenerated: runtime,
    runtimeObservation: put('runtime-observation', { projectPath: '/synthetic/runtime' }),
    build: { generated, producerProfile: { profile: 'github-static-snapshot-v1', caseId: CASE, sourceSha256: SOURCE, caseSourcePath: descriptor.caseSourcePath } } })
  const fixtureBuild = put('fixture-build', { schemaVersion: 1, kind: 'weapp-container.fixture-build', status: 'built', caseId: CASE, sourceSha256: SOURCE,
    checkpoint, fixture: put('fixture', structuredClone(fixture)), before: put('before', structuredClone(runtime)), after: put('after', structuredClone(runtime)) })
  const suiteReport = put('suite', { success: true, testResults: [{ name: '/synthetic/checkout/' + descriptor.caseSourcePath, status: 'passed',
    assertionResults: issue1013AssertionIds.map(fullName => ({ fullName, status: 'passed' })) }] })
  const trace = put('trace', originalTrace())
  const execution = put('execution', { schemaVersion: 1, kind: 'wechat-devtools-case-execution', status: 'passed', caseId: CASE, sourceSha256: SOURCE,
    sourceUnchanged: true, compilerCommit: COMMIT, baseline: { id: BASELINE }, traceSha256: trace.sha256, manifestIntegrity: fixture.manifest.integrity.root,
    observedDevtoolsVersion: '2.02.2609250', observedBaseLibraryVersion: '3.17.3', fixtureBuild, suiteReport })
  return { recipe: { caseId: CASE, sourceSha256: SOURCE, fixtureValue: fixture, oracle: { trace, execution } }, records, store, loadArtifact: async ref => store.get(ref.path) }
}
async function replay(wire, oracleTrace = originalTrace(), closure = staticClosure()) {
  const loaded = await loadIssue1013Inputs(closure)
  return replayCase({ caseId: CASE, request: wire.request, oracleTrace, staticInputs: loaded.staticInputs })
}

test('1013 executes the original three checkpoints and Page.$$→unique Element.tap twice with all twelve static assertions', async () => {
  const wire = syntheticWire(), result = await replay(wire)
  assert.deepEqual(wire.calls.map(call => call.op), ['render.settle', 'reLaunch', 'currentPage', 'checkpoint', 'query', 'tap', 'checkpoint', 'query', 'tap', 'checkpoint'])
  assert.deepEqual(result.events, originalTrace().events.map(({ atNs, ...event }) => event))
  assert.equal(result.staticCoverage.originalStaticExpectations, 12); assert.equal(result.staticCoverage.originalAccesses, 7)
  assert.deepEqual(result.assertions, issue1013AssertionIds.map(id => ({ id, passed: true })))
  const queries = wire.calls.filter(call => call.op === 'checkpoint').flatMap(call => call.payload.selectors)
  assert.equal(queries.length, 10); assert.deepEqual(queries[4].scope, [{ has: '#issue-1013-child' }])
  assert.equal(queries.filter(query => query.fields.attributes.includes('data-title')).length, 2)
  assert.ok(wire.calls.every(call => !JSON.stringify(call.payload).includes('synthetic observation') && !JSON.stringify(call.payload).includes('synthetic field')))
  assert.equal(result.completionFacts.at(-1).actionSeq, '3')
})
test('address tape is independent of raw counts/text/attribute values and ignores only atNs in the final comparison', async () => {
  const trace = originalTrace(), baseline = issue1013ActionTape(trace)
  trace.events[1].payload.nodes[0].count = 0; trace.events[1].payload.nodes[0].nodes = []
  trace.events[1].payload.nodes[3].nodes[0].attributes['data-title'] = null
  assert.deepEqual(issue1013ActionTape(trace), baseline)
  const wire = syntheticWire(); await assert.rejects(replay(wire, trace), /complete actual seq\/kind\/op\/payload trace differs/)
  assert.equal(wire.calls.filter(call => call.op === 'tap').length, 2)
  const timed = originalTrace(); for (const event of timed.events) event.atNs = '999999'
  assert.equal((await replay(syntheticWire(), timed)).assertions.length, 1)
})
test('raw native count/text/attribute divergences are compared after all source actions, without oracle polling', async () => {
  for (const kind of ['count', 'text', 'attribute']) {
    const wire = syntheticWire({ mutate(value, op, payload) {
      if (op === 'checkpoint' && payload.checkpoint === 'initial') {
        if (kind === 'count') { value.nodes[0].count = 0; value.nodes[0].nodes = [] }
        if (kind === 'text') value.nodes[0].nodes[0].text = 'different actual text'
        if (kind === 'attribute') value.nodes[3].nodes[0].attributes['data-title'] = false
      }
    } })
    await assert.rejects(replay(wire), /complete actual seq\/kind\/op\/payload trace differs/)
    assert.equal(wire.calls.filter(call => call.op === 'checkpoint').length, 3); assert.equal(wire.calls.filter(call => call.op === 'tap').length, 2)
  }
})
test('missing, duplicate, swapped, extra and substituted oracle actions/assertion identities cannot drive native IPC', async () => {
  for (const mutate of [trace => trace.events.splice(2, 1), trace => trace.events.push(trace.events.at(-1)),
    trace => { [trace.events[2], trace.events[4]] = [trace.events[4], trace.events[2]] },
    trace => { trace.events[2].payload.selector = '#substitute' }, trace => { trace.events[2].payload.expected = true },
    trace => { trace.events[1].payload.nodes[4].scope = ['component'] }, trace => { trace.assertions[0].id += ' other' }]) {
    const trace = originalTrace(); mutate(trace); const wire = syntheticWire()
    await assert.rejects(replay(wire, trace)); assert.equal(wire.calls.length, 0)
  }
})
test('actual action acquisition must be a unique rendered node; absent/ambiguous queries and foreign coordinate proofs reject', async () => {
  for (const count of [0, 2]) {
    const wire = syntheticWire({ mutate(value, op) { if (op === 'query') { value.count = count; value.nodes = Array.from({ length: count }, (_, id) => ({ id: 'actual-' + id })) } } })
    await assert.rejects(replay(wire), /one actual rendered control/); assert.equal(wire.calls.some(call => call.op === 'tap'), false)
  }
  for (const patch of [{ selector: '#foreign' }, { inputTransport: 'script-handler' }, { frameId: 1 }]) {
    const wire = syntheticWire({ mutate(value, op) { return op === 'tap' ? { ...value, ...patch } : value } })
    await assert.rejects(replay(wire), /coordinate-input proof|another accepted input presentation/)
    assert.equal(wire.calls.filter(call => call.op === 'tap').length, 1)
  }
})
test('native rejection preserves its exact error and stops before later source steps', async () => {
  for (const op of ['query', 'tap', 'checkpoint']) {
    const error = new Error('actual native ' + op + ' rejection'), wire = syntheticWire({ fail: { op, error } })
    await assert.rejects(replay(wire), caught => caught === error)
    assert.equal(wire.calls.at(-1).op, op)
  }
})
test('native $$ returns actual node identities/host metadata and refuses ambiguous concrete Element operations', async () => {
  const wire = syntheticWire({ mutate(value, op) { if (op === 'query') { value.count = 2; value.nodes = [
    { id: 'runtime-host', componentScopeId: 'actual-runtime-component' }, { id: 'runtime-leaf', componentScopeId: null }] } } })
  const program = createObservedNativeProgram(wire.request), page = await program.reLaunch('/' + plan.route), nodes = await page.$$('*')
  assert.equal(nodes[0].id, 'runtime-host'); assert.equal(nodes[0].tagName, 'component'); assert.equal(nodes[0].componentScopeId, 'actual-runtime-component')
  assert.equal(nodes[1].id, 'runtime-leaf'); assert.equal(Object.hasOwn(nodes[1], 'tagName'), false)
  await assert.rejects(nodes[0].tap(), /unique current actual acquisition/)
  await assert.rejects(nodes[0].$$('#descendant'), /unique current actual acquisition/)
  assert.equal(wire.calls.filter(call => call.op === 'tap').length, 0)
})
test('static input loader binds the one original it, exact versions, runtime generation and every original member', async () => {
  const closure = staticClosure(), loaded = await loadIssue1013Inputs(closure)
  assert.equal(assertIssue1013StaticOutputs(loaded.staticInputs).originalStaticExpectations, 12)
  assert.equal(loaded.trace.assertions.length, 1); assert.ok(loaded.references.length > 15)
  const mutations = [
    ['trace', value => { value.caseId = 'foreign' }], ['execution', value => { value.observedDevtoolsVersion = '2.02.2608080' }],
    ['execution', value => { value.traceSha256 = '0'.repeat(64) }], ['execution', value => { value.sourceUnchanged = false }],
    ['suite', value => { value.testResults[0].assertionResults[0].status = 'skipped' }],
    ['suite', value => { value.testResults[0].assertionResults.push(value.testResults[0].assertionResults[0]) }],
    ['suite', value => { value.testResults[0].name = '/foreign.test.ts' }],
    ['checkpoint', value => { value.build.producerProfile.sourceSha256 = '0'.repeat(64) }],
    ['transaction', value => { value.runtimeRoot = '/foreign-runtime' }],
    ['after', value => { value.pop() }], ['runtime', value => { value[0].artifact.sha256 = '0'.repeat(64) }],
    ['generated', value => { value.splice(1, 1) }],
  ]
  for (const [key, mutate] of mutations) await assert.rejects(loadIssue1013Inputs(staticClosure((name, value) => { if (name === key) mutate(value) })))
  const changed = staticClosure(); changed.store.set(changed.records['file-2'].reference.path, Buffer.from('changed'))
  await assert.rejects(loadIssue1013Inputs(changed), /bytes differ/)
})
test('all six WXML controls and six existence assertions remain final host assertions over actual bytes', async () => {
  for (const value of [generatedWxml + ' attr="dynamic"', generatedWxml + ' bindevent="dynamic"',
    ...['data-title="{{staticTitle}}"', 'bindtap="__weapp_vite_inline"', 'data-wd-ready="1"', 'bindready="__weapp_vite_inline"'].map(literal => generatedWxml.replace(literal, ''))]) {
    const closure = staticClosure((key, bytes) => key === 'file-2' ? value : undefined), wire = syntheticWire()
    await assert.rejects(replay(wire, originalTrace(), closure), /original WXML/)
    assert.equal(wire.calls.filter(call => call.op === 'tap').length, 2)
  }
  const loaded = await loadIssue1013Inputs(staticClosure())
  for (let at = 0; at < 6; at++) {
    const input = { ...loaded.staticInputs, files: loaded.staticInputs.files.filter((_, index) => index !== at) }
    assert.throws(() => assertIssue1013StaticOutputs(input), /coverage is incomplete/)
  }
})
test('1013 recipe/native registration closes over current expected-free collector bytes and preserves the pinned original source', async () => {
  const definition = caseDefinition(CASE); assert.equal(definition.requiresOracleTrace, true); assert.equal(definition.oracleInputs, 'sourcePlan1013')
  const recipe = JSON.parse(await readFile(new URL('../../../conformance/recipes/issue1013-v1.json', import.meta.url), 'utf8')).recipes[0]
  for (const ref of [recipe.collector, ...recipe.collectorInputs]) {
    const bytes = await readFile(new URL('../../../' + ref.path, import.meta.url)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes)
    assert.ok(collectorInputs().some(input => input.path === '../../../' + ref.path && input.sha256 === ref.sha256))
  }
  assert.equal(hash(await readFile(new URL('../../../vendor/weapp-vite/' + descriptor.caseSourcePath, import.meta.url))), SOURCE)
  assert.deepEqual(descriptor.plans.map(plan => plan.fullName), issue1013AssertionIds)
})
test('1013 native profile preserves admitted oracle identity before file, host, build or collector work', async () => {
  for (const kind of ['missing', 'trace', 'execution', 'case', 'source']) {
    const oracle = { trace: { path: 'actual/trace.json', sha256: 'a'.repeat(64), bytes: 1 }, execution: { path: 'actual/execution.json', sha256: 'b'.repeat(64), bytes: 2 } }
    const context = { root: '/unavailable', outputDirectory: '/unavailable/output', job: { caseId: CASE, sourceSha256: SOURCE, host: 'web', engine: 'quickjs' },
      recipe: { caseId: CASE, sourceSha256: SOURCE, oracle, get collector() { throw new Error('collector work was touched') } } }
    if (kind !== 'missing') {
      context.admittedOracle = { caseId: CASE, sourceSha256: SOURCE, oracle: structuredClone(oracle) }
      if (kind === 'trace' || kind === 'execution') context.admittedOracle.oracle[kind].sha256 = 'c'.repeat(64)
      if (kind === 'case') context.admittedOracle.caseId = 'foreign'
      if (kind === 'source') context.admittedOracle.sourceSha256 = 'd'.repeat(64)
    }
    await assert.rejects(runNative(context), /differs from its admitted source\/trace\/execution identity/)
    if (kind !== 'missing') await assert.rejects(runDiagnostic(context), /differs from its admitted source\/trace\/execution identity/)
  }
})
test('optional source-plan observation reads actual fields after currentPage and defers host assertions until complete trace comparison', async () => {
  const value = structuredClone(descriptor); value.plans[0].readiness = { selector: '#ready', attributes: ['data-ready'] }
  const wire = syntheticWire(), original = originalTrace(), input = { actualInput: true }; let final = false, raw
  const result = await replaySourcePlan({ descriptor: value, oracleTrace: original, request: wire.request, staticInputs: input,
    async observePlan({ plan, page, program }) {
      assert.equal(wire.calls.at(-1).op, 'currentPage'); assert.equal(page, await program.currentPage())
      const node = await page.$(plan.readiness.selector)
      raw = { selector: plan.readiness.selector, attributes: { [plan.readiness.attributes[0]]: await node.attribute(plan.readiness.attributes[0]) } }
      return raw
    },
    assertStatic(actual, { planObservations }) {
      assert.equal(actual, input); assert.equal(wire.calls.filter(call => call.op === 'tap').length, 2)
      assert.equal(wire.calls.at(-1).op, 'checkpoint'); final = true
      assert.deepEqual(planObservations, [{ planOrdinal: 0, route: plan.route, value: { selector: '#ready', attributes: { 'data-ready': 'synthetic-ready-marker' } } }])
      return { originalStaticExpectations: 12 }
    } })
  assert.equal(final, true); raw.attributes['data-ready'] = 'late mutation'
  assert.equal(result.planObservations[0].value.attributes['data-ready'], 'synthetic-ready-marker')
  assert.equal(JSON.stringify(wire.calls).includes('synthetic-ready-marker'), false)
  const originalError = new Error('actual readiness provider rejection'), stopped = syntheticWire()
  await assert.rejects(replaySourcePlan({ descriptor: value, oracleTrace: original, request: stopped.request,
    observePlan: async () => { throw originalError }, assertStatic: () => { throw new Error('must not assert') } }), error => error === originalError)
  assert.equal(stopped.calls.at(-1).op, 'currentPage')
})
