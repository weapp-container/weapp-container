import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createObservedNativeProgram, validateCompletion } from './native-program.mjs'
import { replayCase, caseDefinition } from './replay.mjs'
import { wxmlActionTape, wxmlAssertionIds } from './wxml-replay.mjs'
import { loadWxmlInputs, assertWxmlStaticOutputs } from './wxml-static.mjs'
import { descriptor } from '../../../conformance/recipes/wxml-transform-descriptor.mjs'

const CASE = 'ide-wxml-transform-runtime', SOURCE = descriptor.sourceSha256
const COMMIT = '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e', BASELINE = 'wechat-devtools-2.02.2609250-sdk-3.17.3'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = { manifest: { compiler: { commit: COMMIT }, integrity: { root: 'a'.repeat(64) } } }
const attributes = { 'data-literal': '中文 & "单\'双" \\ {{literal}}', 'data-number': '42', 'data-bool': 'false',
  'data-expression': 'dynamic', 'data-testid': 'keep', 'data-direct-child': 'true', 'data-subtree-visited': 'true' }
const group = (selector, text) => ({ selector, query: 'css', count: 1, nodes: [{ text }] })
const completion = (patch = {}) => ({ kind: 'owner-pump-native-presentation-v1', sessionId: 'synthetic-unit-only',
  route: descriptor.routes[0], pageId: '1', templateRevision: '1', consumedTemplateRevision: '1', frameId: '11',
  renderRevision: '1', presentationAckRevision: '1', actionSeq: '0', ownerPumpSeq: '1', requiredPumpSeq: '0', presented: true, ...patch })

/** Explicit synthetic wire provider. No compiler, SDK, UI or native host is
 * started, and no value here can certify an official/container execution. */
function syntheticWire({ mutate, fail } = {}) {
  let pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = descriptor.routes[0]
  const calls = [], proof = () => completion({ route, pageId: String(pageId), templateRevision: String(revision),
    consumedTemplateRevision: String(revision), frameId: String(revision + 10), renderRevision: String(revision),
    presentationAckRevision: String(revision), ownerPumpSeq: String(pump), actionSeq: String(action), requiredPumpSeq: String(required) })
  const request = async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) })
    if (fail?.op === op) throw fail.error
    pump++
    let result
    if (op === 'render.settle') result = proof()
    else if (op === 'currentPage') result = { path: route, pageId: String(pageId), completion: proof() }
    else if (op === 'reLaunch') {
      route = payload.route.replace(/^\//, ''); pageId++; revision++; action++; required = pump + 1; pump++
      result = { path: route, completion: proof() }
    } else {
      assert.equal(payload.route, route)
      const address = { route, selector: payload.selector, ...(payload.scope ? { scope: payload.scope } : {}),
        frameId: revision + 10, renderRevision: revision, completion: proof() }
      if (op === 'query') result = { ...address, count: payload.selector === '[data-remove-subtree]' || payload.selector === '#missing' ? 0 : 1,
        nodes: payload.selector === '[data-remove-subtree]' || payload.selector === '#missing' ? [] : [{ id: `actual-${payload.selector}` }] }
      else if (op === 'query.attribute') result = { ...address, count: 1, name: payload.name,
        present: Object.hasOwn(attributes, payload.name), value: Object.hasOwn(attributes, payload.name)
          ? { type: 'string', value: attributes[payload.name] } : { type: 'absent' } }
      else if (op === 'query.text') result = { ...address, count: 1, text: 'nested' }
      else if (op === 'checkpoint') result = { id: payload.checkpoint, route, completion: proof(), nodes:
        payload.checkpoint === 'transformed' ? [group('view#renamed', 'renamed'), group('#retained', 'retained')] : [group('#result', '1:track')] }
      else if (op === 'tap') {
        const inputCompletion = proof(), inputFrame = revision + 10, inputRevision = revision
        action++; required = pump + 1; pump++; revision++
        result = { ...address, x: 10, y: 20, frameId: inputFrame, renderRevision: inputRevision,
          inputTransport: 'native-host-coordinate-event', inputCompletion, completion: proof() }
      } else throw new Error(`Unexpected synthetic IPC ${op}`)
    }
    return mutate ? mutate(result, op, payload, calls) ?? result : result
  }
  return { request, calls }
}

function officialTrace({ warmup = false } = {}) {
  const events = [], emit = (kind, op, payload) => events.push({ seq: events.length, kind, op, payload, atNs: String(events.length + 100) })
  for (const route of descriptor.routes) {
    if (warmup && route === descriptor.routes[0]) emit('lifecycle', 'route.reLaunch', { requested: '/' + route, route })
    emit('lifecycle', 'route.reLaunch', { requested: '/' + route, route })
    emit('lifecycle', 'route.active', { route })
    emit('render', 'dom.checkpoint', { id: 'transformed', route, nodes: [group('view#renamed', 'renamed'), group('#retained', 'retained')] })
    for (const planned of descriptor.direct) {
      const payload = { route, selector: planned.selector }
      if (planned.op === 'query') payload.result = { type: planned.selector === '[data-remove-subtree]' ? 'null' : 'element' }
      else if (planned.op !== 'tap') {
        if (planned.op === 'attribute') payload.name = planned.name
        payload.value = { type: 'string', value: planned.op === 'text' ? 'nested' : attributes[planned.name] }
      }
      emit(planned.op === 'tap' ? 'event' : 'render', planned.op === 'query' ? 'query.result' : planned.op === 'tap' ? 'tap' : `query.${planned.op}`, payload)
    }
    emit('render', 'dom.checkpoint', { id: 'event', route, nodes: [group('#result', '1:track')] })
  }
  return { schemaVersion: 1, caseId: CASE, oracle: 'wechat-devtools', run: { status: 'passed', host: 'devtools', engine: 'wechat',
    environment: { baselineId: BASELINE, compilerCommit: COMMIT, caseSourceSha256: SOURCE, manifestIntegrity: fixture.manifest.integrity.root } },
  events, assertions: wxmlAssertionIds.map(id => ({ id, passed: true })) }
}

/** A small in-memory immutable closure for negative projection tests only.
 * Full production fixture/compiler-use admission is exercised separately. */
function staticClosure() {
  const store = new Map(), records = {}
  const put = (key, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    const reference = { path: `synthetic/${key}`, sha256: hash(bytes), bytes: bytes.length }
    store.set(reference.path, bytes); records[key] = { value, reference }; return reference
  }
  const generated = descriptor.compiledFiles.map(path => ({ kind: 'file', path, artifact: put(path,
    path.endsWith('.wxml') ? '<view data-analytics="track" data-testid="keep" bindtap="tap" />' : path.endsWith('.json') ? '{}' : 'Page({})') }))
  generated.push({ kind: 'file', path: 'app.json', artifact: put('app.json', '{"pages":[] }') })
  const checkpoint = put('checkpoint', { schemaVersion: 1, kind: 'weapp-container.static-generated-checkpoint', status: 'captured',
    caseId: CASE, sourceSha256: SOURCE, build: { generated } })
  const build = put('fixture-build', { schemaVersion: 1, kind: 'weapp-container.fixture-build', status: 'built', caseId: CASE,
    sourceSha256: SOURCE, checkpoint, fixture: put('fixture', fixture), before: put('before', generated), after: put('after', generated) })
  const trace = put('trace', officialTrace())
  const execution = put('execution', { schemaVersion: 1, kind: 'wechat-devtools-case-execution', status: 'passed', caseId: CASE,
    sourceSha256: SOURCE, sourceUnchanged: true, compilerCommit: COMMIT, baseline: { id: BASELINE }, traceSha256: trace.sha256,
    manifestIntegrity: fixture.manifest.integrity.root, observedDevtoolsVersion: '2.02.2609250', observedBaseLibraryVersion: '3.17.3', fixtureBuild: build })
  const recipe = { caseId: CASE, sourceSha256: SOURCE, fixtureValue: fixture, oracle: { trace, execution } }
  return { recipe, store, records, put, loadArtifact: async reference => store.get(reference.path) }
}
const inputs = async () => loadWxmlInputs(staticClosure())

test('owner completion rejects stale/foreign/unacknowledged/unconsumed/unpumped and malformed actual facts', () => {
  const prior = completion(), valid = completion({ ownerPumpSeq: '3', actionSeq: '1', requiredPumpSeq: '2' })
  assert.deepEqual(validateCompletion(valid, prior, { action: true }), valid)
  for (const patch of [{ sessionId: 'foreign' }, { ownerPumpSeq: '1' }, { presentationAckRevision: '0' },
    { consumedTemplateRevision: '2' }, { presented: false }, { requiredPumpSeq: '4' }, { actionSeq: '0' },
    { requiredPumpSeq: '1' }, { frameId: '0' }, { pageId: '01' }, { ownerPumpSeq: '18446744073709551616' }])
    assert.throws(() => validateCompletion({ ...valid, ...patch }, prior, { action: true }))
  for (const patch of [{ route: 'pages/foreign/index' }, { pageId: '2' }, { actionSeq: '1' }, { requiredPumpSeq: '1' }])
    assert.throws(() => validateCompletion(completion({ ownerPumpSeq: '2', ...patch }), prior))
})

test('actual currentPage identity is cached; zero matches return null and present empty/raw strings stay intact', async () => {
  const wire = syntheticWire({ mutate: (value, op, payload) => op === 'query.attribute' && payload.name === 'empty'
    ? { ...value, present: true, value: { type: 'string', value: '' } } : op === 'query.text' ? { ...value, text: '  raw\ntext  ' } : value })
  const program = createObservedNativeProgram(wire.request), page = await program.reLaunch('/' + descriptor.routes[0])
  assert.equal(await program.currentPage(), page)
  assert.equal(await page.$('#missing'), null)
  const element = await page.$('#tap')
  assert.equal(await element.attribute('empty'), '')
  assert.equal(await element.text(), '  raw\ntext  ')
  await element.tap()
  assert.equal(program.completions().at(-1).actionSeq, '2')
})

test('missing rendered attribute never fabricates null/undefined, and malformed absence cannot pass', async () => {
  for (const replacement of [undefined, { type: 'null' }, { type: 'undefined' }, null, { type: 'absent', value: null }]) {
    const wire = syntheticWire({ mutate: (value, op) => op === 'query.attribute' && replacement !== undefined ? { ...value, value: replacement } : value })
    const program = createObservedNativeProgram(wire.request), page = await program.reLaunch('/' + descriptor.routes[0])
    await assert.rejects((await page.$('#tap')).attribute('absent'))
  }
})

test('actual address/frame/tap input proof failures and original IPC rejection identities propagate', async () => {
  for (const [op, change] of [['query', { route: 'pages/other/index' }], ['query', { frameId: 999 }],
    ['tap', { inputTransport: 'synthetic' }], ['tap', { frameId: 999 }], ['tap', { inputCompletion: completion() }]]) {
    const wire = syntheticWire({ mutate: (value, actual) => actual === op ? { ...value, ...change } : value })
    const program = createObservedNativeProgram(wire.request), page = await program.reLaunch('/' + descriptor.routes[0])
    await assert.rejects(op === 'query' ? page.$('#tap') : (async () => (await page.$('#tap')).tap())())
  }
  const error = new Error('original IPC rejected'), wire = syntheticWire({ fail: { op: 'query.attribute', error } })
  const program = createObservedNativeProgram(wire.request), page = await program.reLaunch('/' + descriptor.routes[0])
  await assert.rejects((await page.$('#tap')).attribute('data-number'), value => value === error)
})

test('full original two-route tape replays all reads and real warmup commands with no expected IPC data', async () => {
  const wire = syntheticWire(), loaded = await inputs(), oracleTrace = officialTrace({ warmup: true })
  const result = await replayCase({ caseId: CASE, request: wire.request, oracleTrace, staticInputs: loaded.staticInputs })
  assert.equal(result.events.length, 37)
  assert.equal(wire.calls.filter(call => call.op === 'reLaunch').length, 3)
  assert.equal(wire.calls.filter(call => call.op === 'query.attribute').length, 14)
  assert.equal(wire.calls.filter(call => call.op === 'query.text').length, 2)
  assert.equal(wire.calls.filter(call => call.op === 'tap').length, 2)
  assert.equal(result.staticCoverage.originalAccesses, 6)
  assert.equal(result.staticCoverage.originalStaticExpectations, 12)
  assert.deepEqual(result.assertions, wxmlAssertionIds.map(id => ({ id, passed: true })))
  assert.equal(caseDefinition(CASE).requiresOracleTrace, true)
  assert.ok(result.completionFacts.length > wire.calls.length, 'tap retains actual input and result completions')
  for (const call of wire.calls) {
    assert.ok(Object.keys(call.payload).every(key => ['route', 'selector', 'name', 'checkpoint', 'selectors'].includes(key)))
    assert.equal(/"(?:expected|text|value|count|result)":/.test(JSON.stringify(call.payload)), false)
    for (const actual of Object.values(attributes)) assert.equal(Object.values(call.payload).includes(actual), false)
  }
})

test('oracle value disagreement never changes readiness/action counts; full observations finish before comparison', async () => {
  for (const divergence of ['attribute', 'text', 'query-null', 'checkpoint']) {
    const wire = syntheticWire({ mutate: (value, op, payload) => {
      if (divergence === 'attribute' && op === 'query.attribute') return { ...value, value: { type: 'string', value: 'actual different' } }
      if (divergence === 'text' && op === 'query.text') return { ...value, text: 'actual different' }
      if (divergence === 'query-null' && op === 'query' && payload.selector === '[data-remove-subtree]') return { ...value, count: 1, nodes: [{ id: 'actually-retained' }] }
      if (divergence === 'checkpoint' && op === 'checkpoint') return { ...value, nodes: value.nodes.map(group => ({ ...group, nodes: [{ text: 'actual different' }] })) }
      return value
    } })
    await assert.rejects(replayCase({ caseId: CASE, request: wire.request, oracleTrace: officialTrace(), staticInputs: (await inputs()).staticInputs }), /complete actual.*trace differs/)
    assert.equal(wire.calls.filter(call => call.op === 'query.attribute').length, 14)
    assert.equal(wire.calls.filter(call => call.op === 'query.text').length, 2)
    assert.equal(wire.calls.filter(call => call.op === 'tap').length, 2)
    assert.equal(wire.calls.at(-1).payload.checkpoint, 'event')
  }
})

test('incomplete, reordered, duplicate, inferred navigation and foreign assertion tapes fail before native startup', async () => {
  for (const mutate of [trace => trace.events.splice(0, 1), trace => trace.events.push(structuredClone(trace.events.at(-1))),
    trace => { [trace.events[4], trace.events[5]] = [trace.events[5], trace.events[4]] },
    trace => { trace.events[0].payload.requested = '/pages/foreign/index' },
    trace => { trace.assertions[0].id = 'unrelated successful test' }, trace => { trace.events[3].payload.selector = '#foreign' }]) {
    const trace = officialTrace(); mutate(trace)
    const wire = syntheticWire()
    await assert.rejects(replayCase({ caseId: CASE, request: wire.request, oracleTrace: trace }))
    assert.equal(wire.calls.length, 0)
  }
  const trace = officialTrace(), original = wxmlActionTape(trace)
  for (const event of trace.events) {
    if (event.payload.value) event.payload.value = { type: 'string', value: 'another actual oracle value' }
    for (const group of event.payload.nodes ?? []) for (const node of group.nodes) node.text = 'another actual oracle value'
  }
  assert.deepEqual(wxmlActionTape(trace), original)
})

test('replay keeps primary native rejection identity even when its collector remains incomplete', async () => {
  const error = new Error('actual native tap failure'), wire = syntheticWire({ fail: { op: 'tap', error } })
  await assert.rejects(replayCase({ caseId: CASE, request: wire.request, oracleTrace: officialTrace(), staticInputs: (await inputs()).staticInputs }), value => value === error)
  assert.equal(wire.calls.at(-1).op, 'tap')
})

test('six original compiled accesses bind exact actual bytes and immutable wrapper/packer closure', async () => {
  const closure = staticClosure(), loaded = await loadWxmlInputs(closure), report = assertWxmlStaticOutputs(loaded.staticInputs)
  assert.equal(report.files.length, 6)
  assert.deepEqual(report.files.map(file => file.path), descriptor.compiledFiles)
  assert.ok(loaded.references.every(reference => hash(closure.store.get(reference.path)) === reference.sha256))
  for (const path of descriptor.compiledFiles) {
    const bad = staticClosure(); bad.store.set(bad.records[path].reference.path, Buffer.from('actual changed'))
    await assert.rejects(loadWxmlInputs(bad), /bytes differ/)
  }
})

test('static projection rejects foreign wrappers, missing files, runtime substitution and detached packer members', async () => {
  for (const [key, mutate] of [['execution', value => { value.observedDevtoolsVersion = '2.02.2608080' }],
    ['execution', value => { value.traceSha256 = 'f'.repeat(64) }], ['execution', value => { delete value.fixtureBuild }],
    ['trace', value => { value.run.environment.caseSourceSha256 = 'f'.repeat(64) }],
    ['fixture', value => { value.manifest.integrity.root = 'f'.repeat(64) }],
    ['checkpoint', value => { value.build.generated = value.build.generated.slice(1) }],
    ['checkpoint', value => { value.runtimeGenerated = structuredClone(value.build.generated); value.runtimeGenerated[0].artifact.bytes++ }],
    ['after', value => { value.pop() }]]) {
    const bad = staticClosure(), record = bad.records[key], bytes = Buffer.from(JSON.stringify(record.value))
    const value = JSON.parse(bytes); mutate(value)
    // Propagate valid reference hashes through wrappers to reach semantic checks.
    const replacement = bad.put(key + '-changed', value)
    const build = structuredClone(bad.records['fixture-build'].value), execution = structuredClone(bad.records.execution.value)
    if (key === 'execution') bad.recipe.oracle.execution = replacement
    else if (key === 'trace') bad.recipe.oracle.trace = replacement
    else {
      build[key] = replacement
      execution.fixtureBuild = bad.put('fixture-build-changed', build)
      bad.recipe.oracle.execution = bad.put('execution-changed', execution)
    }
    await assert.rejects(loadWxmlInputs(bad))
  }
})

test('static expectation failures run after all runtime observations and cannot affect command payloads', async () => {
  const wire = syntheticWire(), loaded = await inputs(), file = loaded.staticInputs.files.find(file => file.path.endsWith('.wxml'))
  file.bytes = Buffer.from('actual bad output'); file.sha256 = hash(file.bytes); file.length = file.bytes.length
  await assert.rejects(replayCase({ caseId: CASE, request: wire.request, oracleTrace: officialTrace(), staticInputs: loaded.staticInputs }), /Original Wxml output/)
  assert.equal(wire.calls.filter(call => call.op === 'tap').length, 2)
  assert.equal(wire.calls.at(-1).payload.checkpoint, 'event')
})
