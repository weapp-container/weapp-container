/** Synthetic contract tests only. No actual compiler, native host, SDK or UI. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { replayCase, caseDefinition, collectorInputs } from './replay.mjs'
import { subpackageActionTape } from './subpackage-replay.mjs'
import { loadSubpackageInputs, assertSubpackageStaticOutputs, subpackageDescriptor, subpackageAssertionIds } from './subpackage-static.mjs'

const COMMIT = '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e', BASELINE = 'wechat-devtools-2.02.2609250-sdk-3.17.3'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const caseOf = kind => 'ide-github-issues-runtime-subpackage-' + kind
const texts = kind => kind === 'item' ? ['ITEM:ready:instance', 'issue317ItemNpmReady', 'item-login-required:issue-340:shared']
  : ['USER:ready:instance', 'Issue317 user npm ready', 'user-register-form:issue-340:shared']
const group = (selector, text) => ({ selector, query: 'css', count: 1, nodes: [{ text }] })
const fixture = { manifest: { compiler: { commit: COMMIT }, integrity: { root: 'a'.repeat(64) } } }
function originalTrace(kind) {
  const descriptor = subpackageDescriptor(caseOf(kind)), events = []
  for (const plan of descriptor.plans) {
    const identity = { planOrdinal: plan.ordinal, checkpointOrdinal: plan.ordinal, route: plan.route }
    events.push({ seq: events.length, kind: 'lifecycle', op: 'route.active', payload: { ...identity }, atNs: '100' })
    events.push({ seq: events.length, kind: 'render', op: 'dom.checkpoint', payload: { ...identity, id: 'initial',
      nodes: plan.checkpoints[0].queries.map((query, index) => group(query.selector, texts(kind)[plan.ordinal === 0 ? index : 2])) }, atNs: '101' })
  }
  return { schemaVersion: 1, caseId: descriptor.caseId, oracle: 'wechat-devtools', run: { status: 'passed', host: 'devtools', engine: 'wechat',
    environment: { baselineId: BASELINE, compilerCommit: COMMIT, caseSourceSha256: descriptor.sourceSha256, manifestIntegrity: fixture.manifest.integrity.root } },
  events, assertions: subpackageAssertionIds(descriptor.caseId).map(id => ({ id, passed: true })) }
}

function syntheticWire(kind, { mutate, fail } = {}) {
  const descriptor = subpackageDescriptor(caseOf(kind)), calls = []
  let pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = 'pages/home/index'
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: 'synthetic-unit-only', route, pageId: String(pageId),
    templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision + 10), renderRevision: String(revision),
    presentationAckRevision: String(revision), actionSeq: String(action), ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  return { calls, request: async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) })
    if (fail?.op === op) throw fail.error
    pump++
    let value
    if (op === 'render.settle') value = proof()
    else if (op === 'reLaunch') {
      route = payload.route.replace(/^\//, ''); pageId++; revision++; action++; required = pump + 1; pump++
      value = { path: route, completion: proof() }
    } else if (op === 'currentPage') value = { path: route, pageId: String(pageId), completion: proof() }
    else if (op === 'checkpoint') {
      assert.equal(payload.route, route)
      const plan = descriptor.plans.find(plan => plan.route === route)
      value = { id: payload.checkpoint, route, completion: proof(), nodes: plan.checkpoints[0].queries.map((query, index) =>
        group(query.selector, texts(kind)[plan.ordinal === 0 ? index : 2])) }
    } else throw new Error('Unplanned synthetic IPC ' + op)
    return mutate?.(value, op, payload) ?? value
  } }
}

/** Immutable in-memory wrapper closure for negative projection tests only.
 * Full compiler/fixture/original-execution admission remains in production. */
function staticClosure(kind, { mutate = () => {} } = {}) {
  const descriptor = subpackageDescriptor(caseOf(kind)), store = new Map(), records = {}
  const put = (key, value) => {
    const replacement = mutate(key, value); if (replacement !== undefined) value = replacement
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    const reference = { path: 'synthetic/' + key, sha256: hash(bytes), bytes: bytes.length }
    store.set(reference.path, bytes); records[key] = { value, reference }; return reference
  }
  const generated = descriptor.compiledFiles.map((path, index) => ({ kind: 'file', path,
    artifact: put('file-' + index, index === 0 ? '' : 'Page({marker:' + JSON.stringify(texts(kind)[2]) + '})') }))
  generated.push({ kind: 'file', path: 'app.json', artifact: put('app.json', '{"pages":[]}') })
  mutate('generated', generated)
  const runtime = structuredClone(generated); mutate('runtime', runtime)
  const transaction = put('transaction', { schemaVersion: 1, kind: 'weapp-container.github-producer-transaction', profile: 'github-static-snapshot-v1',
    runtimeRoot: '/synthetic/runtime', runtimeProjectPath: '/synthetic/runtime', snapshotFiles: [...runtime,
      { kind: 'file', path: 'project.config.json', artifact: put('runtime-config', '{}') }] })
  const checkpoint = put('checkpoint', { schemaVersion: 1, kind: 'weapp-container.static-generated-checkpoint', status: 'captured',
    caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, producerTransaction: transaction,
    runtimeObservation: put('runtime-observation', { projectPath: '/synthetic/runtime' }), runtimeGenerated: runtime,
    build: { generated, producerProfile: { profile: 'github-static-snapshot-v1', caseId: descriptor.caseId,
      sourceSha256: descriptor.sourceSha256, caseSourcePath: descriptor.caseSourcePath } } })
  const fixtureBuild = put('fixture-build', { schemaVersion: 1, kind: 'weapp-container.fixture-build', status: 'built',
    caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, checkpoint, fixture: put('fixture', structuredClone(fixture)),
    before: put('before', structuredClone(runtime)), after: put('after', structuredClone(runtime)) })
  const suiteReport = put('suite', { success: true, testResults: [{ name: '/synthetic/checkout/' + descriptor.caseSourcePath, status: 'passed',
    assertionResults: subpackageAssertionIds(descriptor.caseId).map(fullName => ({ fullName, status: 'passed' })) }] })
  const trace = put('trace', originalTrace(kind))
  const execution = put('execution', { schemaVersion: 1, kind: 'wechat-devtools-case-execution', status: 'passed',
    caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, sourceUnchanged: true, compilerCommit: COMMIT, baseline: { id: BASELINE },
    traceSha256: trace.sha256, manifestIntegrity: fixture.manifest.integrity.root, observedDevtoolsVersion: '2.02.2609250',
    observedBaseLibraryVersion: '3.17.3', fixtureBuild, suiteReport })
  return { recipe: { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, fixtureValue: fixture, oracle: { trace, execution } },
    store, records, loadArtifact: async reference => store.get(reference.path) }
}

for (const kind of ['item', 'user']) {
  const caseId = caseOf(kind), descriptor = subpackageDescriptor(caseId)
  test(kind + ': exact two source plans replay actual Page readiness and both initial checkpoints without business actions', async () => {
    const wire = syntheticWire(kind), closure = staticClosure(kind), loaded = await loadSubpackageInputs(closure)
    const result = await replayCase({ caseId, request: wire.request, oracleTrace: loaded.trace, staticInputs: loaded.staticInputs })
    assert.deepEqual(wire.calls.map(call => call.op), ['render.settle', 'reLaunch', 'currentPage', 'checkpoint', 'reLaunch', 'currentPage', 'checkpoint'])
    assert.equal(result.events.length, 4)
    assert.deepEqual(result.events.filter(event => event.op === 'dom.checkpoint').map(event => [event.payload.id, event.payload.planOrdinal, event.payload.checkpointOrdinal]), [['initial', 0, 0], ['initial', 1, 1]])
    assert.equal(result.completionFacts.length, 7)
    assert.equal(result.staticCoverage.originalAccesses, 2); assert.equal(result.staticCoverage.originalStaticExpectations, 2)
    assert.deepEqual(result.assertions, subpackageAssertionIds(caseId).map(id => ({ id, passed: true })))
    assert.equal(loaded.staticInputs.files[0].length, 0, 'original pathExists permits an existing empty regular shared chunk')
    for (const call of wire.calls) {
      assert.equal(/"(?:text|value|expected|count|planOrdinal|checkpointOrdinal|test)":/.test(JSON.stringify(call.payload)), false)
      for (const expected of texts(kind)) assert.equal(JSON.stringify(call.payload).includes(expected), false)
    }
  })

  test(kind + ': raw text/count disagreement completes all observations before the full trace comparison', async () => {
    const loaded = await loadSubpackageInputs(staticClosure(kind))
    for (const variant of ['text', 'count']) {
      const wire = syntheticWire(kind, { mutate: (value, op) => {
        if (op === 'checkpoint') {
          if (variant === 'text') value.nodes[0].nodes[0].text = ' actual different raw\ntext '
          else { value.nodes[0].count = 2; value.nodes[0].nodes.push({ text: 'extra real match' }) }
        }
      } })
      await assert.rejects(replayCase({ caseId, request: wire.request, oracleTrace: loaded.trace, staticInputs: loaded.staticInputs }), /complete actual.*trace differs/)
      assert.equal(wire.calls.filter(call => call.op === 'checkpoint').length, 2)
      assert.equal(wire.calls.at(-1).payload.route, descriptor.plans[1].route)
    }
    const changed = structuredClone(loaded.trace)
    for (const event of changed.events) for (const group of event.payload.nodes ?? []) group.nodes[0].text = 'foreign oracle value'
    assert.deepEqual(subpackageActionTape(caseId, changed), subpackageActionTape(caseId, loaded.trace))
  })

  test(kind + ': missing/reordered/duplicated/foreign operations, ordinals and source assertion names fail before native startup', async () => {
    for (const mutate of [trace => trace.events.pop(), trace => trace.events.push(trace.events[0]),
      trace => { trace.events[0].seq = 1 }, trace => { trace.events[2].payload.planOrdinal = 0 },
      trace => { trace.events[3].payload.checkpointOrdinal = 0 }, trace => { trace.events[3].payload.id = 'other' },
      trace => { trace.events[1].payload.nodes[0].selector = '.foreign' }, trace => { trace.events[2].payload.route = descriptor.plans[0].route },
      trace => { trace.assertions[1].id = trace.assertions[0].id }, trace => { trace.assertions[1].passed = false },
      trace => { trace.events[1].payload.taskId = 'invented' }, trace => { trace.caseId = caseOf(kind === 'item' ? 'user' : 'item') }]) {
      const trace = originalTrace(kind); mutate(trace); const wire = syntheticWire(kind)
      await assert.rejects(replayCase({ caseId, request: wire.request, oracleTrace: trace }))
      assert.equal(wire.calls.length, 0)
    }
  })

  test(kind + ': actual Page/presentation ownership failures and original request errors remain failures', async () => {
    for (const [op, mutate] of [['currentPage', value => { value.pageId = '999' }],
      ['currentPage', value => { value.path = descriptor.plans[1].route }], ['reLaunch', value => { value.completion.presented = false }],
      ['checkpoint', value => { value.completion.pageId = '999' }], ['checkpoint', value => { value.completion.sessionId = 'foreign' }]]) {
      const wire = syntheticWire(kind, { mutate: (value, actual) => { if (op === actual) mutate(value) } })
      await assert.rejects(replayCase({ caseId, request: wire.request, oracleTrace: originalTrace(kind) }))
    }
    for (const op of ['render.settle', 'reLaunch', 'currentPage', 'checkpoint']) {
      const error = new Error('actual ' + op + ' rejected'), wire = syntheticWire(kind, { fail: { op, error } })
      await assert.rejects(replayCase({ caseId, request: wire.request, oracleTrace: originalTrace(kind) }), value => value === error)
    }
    const controller = new AbortController(), reason = new Error('stop actual replay'); controller.abort(reason)
    const wire = syntheticWire(kind)
    await assert.rejects(replayCase({ caseId, request: wire.request, oracleTrace: originalTrace(kind), signal: controller.signal }), value => value === reason)
    assert.equal(wire.calls.length, 0)
  })

  test(kind + ': only exact original two passed fullName results from this source satisfy static projection', async () => {
    for (const mutate of [suite => suite.testResults[0].assertionResults.pop(), suite => suite.testResults[0].assertionResults.push(suite.testResults[0].assertionResults[0]),
      suite => { suite.testResults[0].assertionResults[1] = suite.testResults[0].assertionResults[0] },
      suite => { suite.testResults[0].assertionResults[1].status = 'skipped' }, suite => { suite.testResults[0].name = '/foreign/source.ts' },
      suite => { suite.testResults[0].assertionResults[0].fullName = descriptor.plans[0].test }, suite => { suite.testResults.push({ name: '/foreign/source.ts' }) },
      suite => { suite.success = false }]) {
      const closure = staticClosure(kind, { mutate: (key, value) => { if (key === 'suite') mutate(value) } })
      await assert.rejects(loadSubpackageInputs(closure), /two non-skipped it results/)
    }
  })

  test(kind + ': actual static artifact bytes, full producer/packer closure and wrapper identities fail closed under mutation', async () => {
    for (const [key, mutate] of [['generated', files => { files[0].path = '../common.js' }], ['generated', files => { files.push(files[0]) }],
      ['runtime', files => { files[0].artifact.bytes++ }], ['after', files => { files.pop() }],
      ['checkpoint', value => { delete value.runtimeGenerated }], ['checkpoint', value => { delete value.producerTransaction }],
      ['checkpoint', value => { value.build.producerProfile.sourceSha256 = 'f'.repeat(64) }],
      ['transaction', value => { value.runtimeProjectPath = '/foreign' }], ['transaction', value => { value.snapshotFiles.shift() }],
      ['runtime-observation', value => { value.projectPath = '/foreign' }], ['execution', value => { value.sourceUnchanged = false }],
      ['execution', value => { value.observedDevtoolsVersion = 'foreign' }], ['execution', value => { value.traceSha256 = 'f'.repeat(64) }],
      ['trace', value => { value.run.environment.caseSourceSha256 = 'f'.repeat(64) }], ['fixture', value => { value.manifest.integrity.root = 'f'.repeat(64) }]]) {
      const closure = staticClosure(kind, { mutate: (actual, value) => { if (actual === key) mutate(value) } })
      await assert.rejects(loadSubpackageInputs(closure))
    }
    for (const index of [0, 1]) {
      const closure = staticClosure(kind); closure.store.set(closure.records['file-' + index].reference.path, Buffer.from('actual tampering'))
      await assert.rejects(loadSubpackageInputs(closure), /bytes differ/)
    }
  })

  test(kind + ': missing original common chunk and failed actual page-JS substring cannot supply static assertions', async () => {
    const missing = staticClosure(kind, { mutate: (key, value) => { if (key === 'generated') value.splice(0, 1) } })
    await assert.rejects(loadSubpackageInputs(missing), /static member is absent/)
    const closure = staticClosure(kind, { mutate: (key, value) => key === 'file-1' ? 'Page({actual:"different marker"})' : undefined })
    const loaded = await loadSubpackageInputs(closure), wire = syntheticWire(kind)
    await assert.rejects(replayCase({ caseId, request: wire.request, oracleTrace: loaded.trace, staticInputs: loaded.staticInputs }), /page JS does not contain/)
    assert.equal(wire.calls.filter(call => call.op === 'checkpoint').length, 2, 'static expected string never gates native readiness')
    const other = await loadSubpackageInputs(staticClosure(kind === 'item' ? 'user' : 'item'))
    await assert.rejects(replayCase({ caseId, request: syntheticWire(kind).request, oracleTrace: loaded.trace, staticInputs: other.staticInputs }), /another source case/)
  })

  test(kind + ': native registration binds the exact collector/descriptor/shared-core import closure', async () => {
    const definition = caseDefinition(caseId)
    assert.equal(definition.sourceSha256, descriptor.sourceSha256); assert.equal(definition.oracleInputs, 'subpackage')
    for (const reference of [{ path: definition.collectorPath, sha256: definition.collectorSha256 }, ...definition.collectorDependencies]) {
      const bytes = await readFile(new URL(reference.path, import.meta.url))
      assert.equal(hash(bytes), reference.sha256)
      assert.deepEqual(collectorInputs().find(value => value.path === reference.path), reference)
    }
    assert.equal(assertSubpackageStaticOutputs((await loadSubpackageInputs(staticClosure(kind))).staticInputs).files.length, 2)
  })
}
