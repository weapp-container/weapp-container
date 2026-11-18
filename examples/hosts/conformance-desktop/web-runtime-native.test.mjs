/** Synthetic IPC and immutable wrapper models; no native/compiler/SDK runs. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { descriptor } from '../../../conformance/recipes/web-runtime-descriptor.mjs'
import { projectOrderedDomNodes } from '../../../conformance/recipes/ordered-dom-projection.mjs'
import { replayCase, caseDefinition, collectorInputs } from './replay.mjs'
import { webRuntimeActionTape } from './web-runtime-replay.mjs'
import { replayWebRuntime } from './web-runtime-replay.mjs'
import { webRuntimeAssertionIds, loadWebRuntimeInputs, assertWebRuntimeStaticOutputs } from './web-runtime-static.mjs'

const COMMIT = '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e', BASELINE = 'wechat-devtools-2.02.2609250-sdk-3.17.3'
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), CASE = descriptor.caseId
const fixture = { manifest: { compiler: { commit: COMMIT }, integrity: { root: 'a'.repeat(64) } } }
const rawGroups = plan => plan.checkpoints[0].queries.map((query, index) => ({ selector: query.selector, query: 'css',
  ...(query.scope ? { scope: [...query.scope] } : {}), count: query.text ? 1 : 3,
  nodes: Array.from({ length: query.text ? 1 : 3 }, (_, at) => ({ text: ` actual ${plan.ordinal}/${index}/${at}\n`, random: 'ignored-value' })) }))
function trace() {
  const events = []
  for (const plan of descriptor.plans) {
    const identity = { planOrdinal: plan.ordinal, checkpointOrdinal: plan.ordinal, route: plan.route }
    events.push({ seq: events.length, atNs: '1', kind: 'lifecycle', op: 'route.active', payload: { ...identity } })
    events.push({ seq: events.length, atNs: '2', kind: 'render', op: 'dom.checkpoint', payload: { ...identity, id: 'initial',
      nodes: projectOrderedDomNodes(rawGroups(plan), plan.checkpoints[0].queries) } })
  }
  return { schemaVersion: 1, caseId: CASE, oracle: 'wechat-devtools', run: { status: 'passed', host: 'devtools', engine: 'wechat',
    environment: { baselineId: BASELINE, compilerCommit: COMMIT, caseSourceSha256: descriptor.sourceSha256, manifestIntegrity: fixture.manifest.integrity.root } },
  events, assertions: webRuntimeAssertionIds().map(id => ({ id, passed: true })) }
}
function wire({ mutate, fail, absentRoot = false } = {}) {
  const calls = []; let pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = 'pages/home/index'
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: 'synthetic-only', route, pageId: String(pageId),
    templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision + 10), renderRevision: String(revision),
    presentationAckRevision: String(revision), actionSeq: String(action), ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  return { calls, request: async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) }); if (fail?.op === op) throw fail.error
    pump++; let value; const plan = () => descriptor.plans.find(plan => plan.route === route)
    if (op === 'render.settle') value = proof()
    else if (op === 'reLaunch') { route = payload.route.slice(1); pageId++; revision++; action++; required = pump + 1; pump++; value = { path: route, completion: proof() } }
    else if (op === 'currentPage') value = { path: route, pageId: String(pageId), completion: proof() }
    else if (op === 'query') {
      assert.equal(payload.route, route)
      // Class-root pages exercise fall-through from absent id roots, including
      // issue1186 and issue459 as in the pinned source fixture.
      const found = !absentRoot && payload.selector === plan().renderedRoots[plan().ordinal === 3 ? 0 : 2]
      value = { route, selector: payload.selector, count: found ? 1 : 0, nodes: found ? [{ id: 'actual-root-' + pageId }] : [],
        frameId: revision + 10, renderRevision: revision, completion: proof() }
    } else if (op === 'checkpoint') {
      assert.equal(payload.route, route); value = { id: payload.checkpoint, route, completion: proof(), nodes: rawGroups(plan()) }
    } else throw new Error('Unplanned synthetic IPC ' + op)
    return mutate?.(value, op, payload) ?? value
  } }
}
const staticFiles = () => ({
  'pages/issue-1186/index.wxml': '<view/>', 'pages/issue-1186/index.json': '{}', 'pages/issue-1186/index.js': 'Page({})',
  'pages/issue-448/index.wxml': '<view class="issue448-page"><text class="issue448-title"/>' + '<text class="issue448-line"/>'.repeat(18) + '</view>',
  'pages/issue-448/index.js': ['installWebRuntimeGlobals', '"fetch"', '"CustomEvent"', 'btoa("AB")', 'atob(encoded)', 'URL.parse("123", "fake://abc")',
    'new URLSearchParams("b=2&a=1&a=0")', 'headers.getSetCookie().length', 'Response.json({ ok: true })', 'Response.error()', 'queueMicrotask', '_runE2E'].join('\n'),
  'pages/issue-459/index.wxml': '<view class="issue459-page"><text class="issue459-title"/>' + '<text class="issue459-line"/>'.repeat(6) + '</view>',
  'pages/issue-459/index.js': ['RequestPolyfill', 'URLPolyfill("/abc", "https://issue-459.invalid")', 'ResponsePolyfill("123")', 'TextDecoderPolyfill',
    'TextEncoderPolyfill', 'Object.keys(response).join(",")', '_runE2E'].join('\n'),
  'pages/issue-804/index.wxml': '<view id="issue804-page"><pressable/></view>',
  'weapp-vendors/a.js': 'resolveMiniProgramPlatform', 'weapp-vendors/z.js': '// every direct child is observed',
  'weapp-vendors/nested/ignored.js': 'request-globals-wevu-web-apis-fetch.js', 'weapp-vendors/ignored.json': 'not JS',
})
function closure({ mutate = () => {}, files = staticFiles() } = {}) {
  const store = new Map(), records = {}
  const put = (key, value) => {
    const replacement = mutate(key, value); if (replacement !== undefined) value = replacement
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    const reference = { path: 'synthetic/' + key, sha256: hash(bytes), bytes: bytes.length }; store.set(reference.path, bytes); records[key] = { value, reference }; return reference
  }
  const generated = Object.entries(files).map(([path, bytes]) => ({ kind: 'file', path, artifact: put(path, bytes) }))
  generated.push({ kind: 'file', path: 'app.json', artifact: put('app.json', '{"pages":[]}') }); mutate('generated', generated)
  const runtime = structuredClone(generated); mutate('runtime', runtime)
  const transaction = put('transaction', { schemaVersion: 1, kind: 'weapp-container.github-producer-transaction', profile: 'github-static-snapshot-v1',
    runtimeRoot: '/synthetic/runtime', runtimeProjectPath: '/synthetic/runtime', snapshotFiles: [...runtime,
      { kind: 'file', path: 'project.config.json', artifact: put('runtime-config', '{}') }] })
  const checkpoint = put('checkpoint', { schemaVersion: 1, kind: 'weapp-container.static-generated-checkpoint', status: 'captured',
    caseId: CASE, sourceSha256: descriptor.sourceSha256, producerTransaction: transaction,
    runtimeObservation: put('runtime-observation', { projectPath: '/synthetic/runtime' }), runtimeGenerated: runtime,
    build: { generated, producerProfile: { profile: 'github-static-snapshot-v1', caseId: CASE, sourceSha256: descriptor.sourceSha256, caseSourcePath: descriptor.caseSourcePath } } })
  const fixtureBuild = put('fixture-build', { schemaVersion: 1, kind: 'weapp-container.fixture-build', status: 'built', caseId: CASE,
    sourceSha256: descriptor.sourceSha256, checkpoint, fixture: put('fixture', structuredClone(fixture)), before: put('before', structuredClone(runtime)), after: put('after', structuredClone(runtime)) })
  const suiteReport = put('suite', { success: true, testResults: [{ name: '/synthetic/' + descriptor.caseSourcePath, status: 'passed',
    assertionResults: webRuntimeAssertionIds().map(fullName => ({ fullName, status: 'passed' })) }] })
  const original = put('trace', trace()), execution = put('execution', { schemaVersion: 1, kind: 'wechat-devtools-case-execution', status: 'passed', caseId: CASE,
    sourceSha256: descriptor.sourceSha256, sourceUnchanged: true, compilerCommit: COMMIT, baseline: { id: BASELINE }, traceSha256: original.sha256,
    manifestIntegrity: fixture.manifest.integrity.root, observedDevtoolsVersion: '2.02.2609250', observedBaseLibraryVersion: '3.17.3', fixtureBuild, suiteReport })
  return { recipe: { caseId: CASE, sourceSha256: descriptor.sourceSha256, fixtureValue: fixture, oracle: { trace: original, execution } },
    store, records, loadArtifact: async reference => store.get(reference.path) }
}
const replay = (ipc, loaded, options = {}) => replayCase({ caseId: CASE, request: ipc.request, oracleTrace: loaded.trace, staticInputs: loaded.staticInputs, ...options })

test('four source plans replay real route/root readiness, raw checkpoints and all 32 static assertions', async () => {
  const data = closure(), loaded = await loadWebRuntimeInputs(data), ipc = wire(), result = await replay(ipc, loaded)
  assert.equal(result.events.length, 8); assert.equal(result.staticCoverage.originalStaticExpectations, 32)
  assert.equal(result.staticCoverage.originalFixedFiles, 8); assert.deepEqual(result.staticCoverage.vendorFiles, ['weapp-vendors/a.js', 'weapp-vendors/z.js'])
  assert.equal(ipc.calls.filter(call => call.op === 'reLaunch').length, 4); assert.equal(ipc.calls.filter(call => call.op === 'checkpoint').length, 4)
  assert.equal(ipc.calls.filter(call => call.op === 'query').length, 10)
  assert.deepEqual(result.assertions, webRuntimeAssertionIds().map(id => ({ id, passed: true })))
  const scoped = ipc.calls.find(call => call.op === 'checkpoint' && call.payload.route.endsWith('804/index')).payload.selectors.at(-1)
  assert.deepEqual(scoped, { selector: '.issue804-pressable', scope: ['#issue804-pressable'] })
  for (const call of ipc.calls) {
    const encoded = JSON.stringify(call.payload)
    assert.equal(/"(?:expected|value|count|planOrdinal|checkpointOrdinal|test)":/.test(encoded), false)
    assert.equal(encoded.includes(' actual '), false); assert.equal(encoded.includes('resolveMiniProgramPlatform'), false)
  }
  assert.equal(loaded.references.some(ref => ref.path.endsWith('weapp-vendors/z.js')), true)
  assert.equal(loaded.references.some(ref => ref.path.endsWith('nested/ignored.js')), false)
})

test('count-only incidental values cannot change traces; actual selected values/counts fail after all four observations', async () => {
  const loaded = await loadWebRuntimeInputs(closure())
  const ignored = wire({ mutate: (value, op) => { if (op === 'checkpoint') for (const group of value.nodes)
    if (!descriptor.plans.find(plan => plan.route === value.route).checkpoints[0].queries.find(query => query.selector === group.selector).text)
      for (const node of group.nodes) node.text = Math.random().toString() } })
  await replay(ignored, loaded)
  for (const variant of ['text', 'count']) {
    const ipc = wire({ mutate: (value, op) => { if (op === 'checkpoint') {
      if (variant === 'text') value.nodes[0].nodes[0].text = 'different actual raw text'
      else { const group = value.nodes.at(-1); group.count++; group.nodes.push({ text: 'extra actual match' }) }
    } } })
    await assert.rejects(replay(ipc, loaded), /complete actual.*trace differs/)
    assert.equal(ipc.calls.filter(call => call.op === 'checkpoint').length, 4)
  }
  const changed = structuredClone(loaded.trace)
  for (const event of changed.events) for (const group of event.payload.nodes ?? []) for (const node of group.nodes)
    if ('text' in node) node.text = 'foreign observed value'
  assert.deepEqual(webRuntimeActionTape(changed), webRuntimeActionTape(loaded.trace))
})

test('missing actual root and page/presentation/scope ownership fail without value-driven readiness', async () => {
  const loaded = await loadWebRuntimeInputs(closure()), missing = wire({ absentRoot: true })
  await assert.rejects(replay(missing, loaded), /no rendered root/)
  assert.equal(missing.calls.filter(call => call.op === 'query').length, 4)
  assert.equal(missing.calls.filter(call => call.op === 'checkpoint').length, 0)
  for (const [op, mutate] of [['currentPage', value => { value.pageId = '999' }], ['query', value => { value.completion.pageId = '999' }],
    ['query', value => { value.selector = '#foreign' }], ['query', value => { value.completion.presented = false }],
    ['checkpoint', value => { value.completion.sessionId = 'foreign' }], ['checkpoint', value => { value.nodes[0].scope = ['#foreign'] }]])
    await assert.rejects(replay(wire({ mutate: (value, actual) => { if (op === actual) mutate(value) } }), loaded))
})

test('exact original IPC errors and abort reasons survive cleanup', async () => {
  const loaded = await loadWebRuntimeInputs(closure())
  for (const op of ['render.settle', 'reLaunch', 'currentPage', 'query', 'checkpoint']) {
    const error = new Error('actual rejected ' + op); await assert.rejects(replay(wire({ fail: { op, error } }), loaded), value => value === error)
  }
  const controller = new AbortController(), reason = new Error('stop replay'); controller.abort(reason)
  const ipc = wire(); await assert.rejects(replay(ipc, loaded, { signal: controller.signal }), value => value === reason); assert.deepEqual(ipc.calls, [])
})

test('trace sequence, source titles, addresses and all four it results reject omissions/substitutions before startup', async () => {
  const foreign = wire()
  await assert.rejects(replayWebRuntime({ caseId: 'foreign', request: foreign.request, oracleTrace: trace() }), /another source case/)
  assert.deepEqual(foreign.calls, [])
  for (const mutate of [value => value.events.pop(), value => value.events.push(value.events[0]), value => { value.events[2].seq = 0 },
    value => { value.events[3].payload.planOrdinal = 0 }, value => { value.events[7].payload.nodes.at(-1).scope = [] },
    value => { value.events[1].payload.nodes[0].selector = '#foreign' }, value => { value.assertions[1].id = value.assertions[0].id },
    value => { value.assertions[3].passed = false }, value => { value.events[1].payload.taskId = 'invented' }]) {
    const original = trace(); mutate(original); const ipc = wire()
    await assert.rejects(replayCase({ caseId: CASE, request: ipc.request, oracleTrace: original })); assert.deepEqual(ipc.calls, [])
  }
  for (const mutate of [suite => suite.testResults[0].assertionResults.pop(), suite => { suite.testResults[0].assertionResults[3].status = 'skipped' },
    suite => { suite.testResults[0].assertionResults[2] = suite.testResults[0].assertionResults[0] }, suite => { suite.testResults[0].name = '/foreign/source.ts' }])
    await assert.rejects(loadWebRuntimeInputs(closure({ mutate: (key, value) => { if (key === 'suite') mutate(value) } })), /four non-skipped it results/)
})

test('all direct-child vendor JS is consumed and forbidden references cannot hide in a later vendor', async () => {
  const files = staticFiles(); files['weapp-vendors/z.js'] = 'request-globals-wevu-web-apis-fetch.js'
  const loaded = await loadWebRuntimeInputs(closure({ files })), ipc = wire()
  await assert.rejects(replay(ipc, loaded), /forbidden request-globals/)
  assert.equal(ipc.calls.filter(call => call.op === 'checkpoint').length, 4)
  const valid = await loadWebRuntimeInputs(closure())
  for (const mutate of [input => input.files.pop(), input => input.directories[0].members.pop(), input => input.files.reverse(),
    input => input.directories[0].members.push('weapp-vendors/nested/ignored.js'), input => { input.files[0].bytes[0] ^= 1 }]) {
    const input = structuredClone(valid.staticInputs)
    // structuredClone turns Buffers into Uint8Arrays; preserve the intended
    // production buffer identity for each independent mutation probe.
    input.files.forEach(file => { file.bytes = Buffer.from(file.bytes) }); mutate(input)
    assert.throws(() => assertWebRuntimeStaticOutputs(input))
  }
  const tampered = closure(); tampered.store.set(tampered.records['weapp-vendors/z.js'].reference.path, Buffer.from('tampered'))
  await assert.rejects(loadWebRuntimeInputs(tampered), /bytes differ/)
})

test('every fixed source-accessed member and complete runtime/packer tree stays bound to the actual fixture', async () => {
  for (const path of descriptor.compiledFiles) {
    const files = staticFiles(); delete files[path]
    await assert.rejects(loadWebRuntimeInputs(closure({ files })), /static member is absent/)
  }
  for (const [key, mutate] of [['runtime', files => { files[0].artifact.bytes++ }], ['after', files => files.pop()],
    ['transaction', value => { value.runtimeProjectPath = '/foreign' }], ['transaction', value => value.snapshotFiles.shift()],
    ['checkpoint', value => { value.build.producerProfile.sourceSha256 = 'f'.repeat(64) }], ['execution', value => { value.sourceUnchanged = false }],
    ['execution', value => { value.observedBaseLibraryVersion = 'foreign' }], ['fixture', value => { value.manifest.integrity.root = 'f'.repeat(64) }]])
    await assert.rejects(loadWebRuntimeInputs(closure({ mutate: (actual, value) => { if (actual === key) mutate(value) } })))
})

test('all 32 static expectations independently extracted from the original AST reject their own changed generated bytes', async () => {
  const bytes = await readFile(new URL('../../../vendor/weapp-vite/' + descriptor.caseSourcePath, import.meta.url))
  assert.equal(hash(bytes), descriptor.sourceSha256)
  const source = ts.createSourceFile('original.ts', bytes.toString(), ts.ScriptTarget.Latest, true), cases = [], obligations = []
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, child => visit(child, fn)) }
  visit(source, node => { if (ts.isCallExpression(node) && node.expression.getText(source) === 'it') cases.push(node.arguments[1].body) })
  for (const [ordinal, body] of cases.entries()) {
    const variables = new Map()
    visit(body, node => {
      if (ts.isVariableDeclaration(node)) {
        const value = node.initializer
        if (value && ts.isAwaitExpression(value) && ts.isCallExpression(value.expression) && value.expression.expression.getText(source) === 'readDistFile')
          variables.set(node.name.getText(source), value.expression.arguments[0].text)
      }
    })
    visit(body, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
      const matcher = node.expression.name.text
      if (!['toBe', 'toContain'].includes(matcher)) return
      let call = node.expression.expression, negative = false
      if (ts.isPropertyAccessExpression(call) && call.name.text === 'not') { negative = true; call = call.expression }
      if (!ts.isCallExpression(call) || call.expression.getText(source) !== 'expect') return
      const actual = call.arguments[0], expected = node.arguments[0]
      if (ts.isAwaitExpression(actual)) {
        assert.equal(ordinal, 0); assert.equal(matcher, 'toBe'); assert.equal(negative, true); assert.equal(expected.text, '')
        const template = actual.expression.arguments[0]
        let extensions
        visit(body, statement => { if (ts.isForOfStatement(statement)) extensions = statement.expression.elements.map(value => value.text) })
        for (const extension of extensions) obligations.push({ kind: 'notEmpty', path: template.head.text + extension + template.templateSpans[0].literal.text })
      } else if (ts.isIdentifier(actual)) {
        assert.equal(matcher, 'toContain'); assert.equal(ts.isStringLiteral(expected), true)
        obligations.push({ kind: negative ? 'notContains' : 'contains', path: variables.get(actual.text), vendor: actual.text === 'vendorJs', expected: expected.text })
      } else {
        assert.equal(matcher, 'toBe'); assert.equal(negative, false); assert.equal(actual.name.text, 'length')
        const match = actual.expression, literal = match.arguments[0].text, last = literal.lastIndexOf('/')
        assert.equal(match.expression.name.text, 'match')
        obligations.push({ kind: 'regexCount', path: variables.get(match.expression.expression.text),
          expression: literal.slice(1, last), flags: literal.slice(last + 1), expected: Number(expected.text) })
      }
    })
  }
  assert.equal(cases.length, 4); assert.equal(obligations.length, 32)
  assert.equal(obligations.filter(value => value.vendor).length, 2)
  for (const obligation of obligations) {
    const files = staticFiles(), path = obligation.vendor ? obligation.kind === 'notContains' ? 'weapp-vendors/z.js' : 'weapp-vendors/a.js' : obligation.path
    assert.equal(typeof files[path], 'string')
    if (obligation.kind === 'notEmpty') files[path] = ''
    else if (obligation.kind === 'contains') { assert.ok(files[path].includes(obligation.expected)); files[path] = files[path].replaceAll(obligation.expected, '') }
    else if (obligation.kind === 'notContains') files[path] += obligation.expected
    else {
      const expression = new RegExp(obligation.expression, obligation.flags)
      assert.equal(files[path].match(expression).length, obligation.expected)
      files[path] = files[path].replace(new RegExp(obligation.expression), '')
    }
    const loaded = await loadWebRuntimeInputs(closure({ files }))
    assert.throws(() => assertWebRuntimeStaticOutputs(loaded.staticInputs), /Original Web runtime static assertion/)
  }
})

test('native registry declares the exact Web collector dependency closure', async () => {
  const definition = caseDefinition(CASE)
  assert.equal(definition.sourceSha256, descriptor.sourceSha256); assert.equal(definition.oracleInputs, 'webRuntime')
  for (const reference of [{ path: definition.collectorPath, sha256: definition.collectorSha256 }, ...definition.collectorDependencies]) {
    assert.equal(hash(await readFile(new URL(reference.path, import.meta.url))), reference.sha256)
    assert.deepEqual(collectorInputs().find(value => value.path === reference.path), reference)
  }
})
