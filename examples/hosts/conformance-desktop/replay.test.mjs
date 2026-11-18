import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRequire, isBuiltin } from 'node:module'
import ts from 'typescript'
import { assertCheckpoint, caseDefinition, collectorInputs, createNativeProgram, replayCase, uniqueCollectorInputs } from './replay.mjs'
import { createDriverRegistry } from './driver-registry.mjs'
import closureFixture from './fixtures/template-driver-closure.json' with { type: 'json' }
import desktopHostInputs from './fixtures/desktop-host-inputs.mjs'
import sourceMethodHostInputs from './fixtures/source-method-host-inputs.mjs'
import importMetaHostInputs from './fixtures/import-meta-host-inputs.mjs'
import sourceExceptionHostInputs from './fixtures/source-exception-host-inputs.mjs'
import recipeCompositionHostInputs from './fixtures/recipe-composition-host-inputs.mjs'
import nativeExceptionHostInputs from './fixtures/native-exception-host-inputs.mjs'
import issue941HostInputs from './fixtures/issue941-host-inputs.mjs'
import issue1009HostInputs from './fixtures/issue1009-host-inputs.mjs'
import issue1008HostInputs from './fixtures/issue1008-host-inputs.mjs'
import issue826HostInputs from './fixtures/issue826-host-inputs.mjs'
import opaqueNodeHostInputs from './fixtures/opaque-node-host-inputs.mjs'
import issue1011HostInputs from './fixtures/issue1011-host-inputs.mjs'

const issue1011Override = value => issue1011HostInputs.updates.find(override => override.path === value.path) ?? value
const opaqueNodeOverride = value => opaqueNodeHostInputs.updates.find(override => override.path === value.path) ?? value
const issue1009Override = value => issue1009HostInputs.updates.find(override => override.path === value.path) ?? value
const issue826Override = value => issue826HostInputs.updates.find(override => override.path === value.path) ?? value
const issue1008Override = value => issue1008HostInputs.updates.find(override => override.path === value.path) ?? value
const issue941Override = value => issue941HostInputs.updates.find(override => override.path === value.path) ?? value
const compositionOverride = value => issue1011Override(issue826Override(issue941Override(issue1009Override(issue1008Override(recipeCompositionHostInputs.updates.find(override => override.path === value.path) ?? value)))))

const issue1058 = 'ide-issue-1058-template-tags-runtime', issue1185 = 'ide-issue-1185-sibling-entry-runtime', issue1072 = 'ide-issue-1072-json-context-runtime'
const issue1012 = 'ide-github-issues-runtime-issue1012'

/** Synthetic IPC unit provider only. These calls never certify a native host,
 * render, fixture, SDK observation, or conformance execution. */
function syntheticNative(caseId, { badCheckpoint, pollRetry = false } = {}) {
  const calls = [], reads = new Map(), counts = new Map()
  let route, visible = true
  const request = async (op, payload) => {
    calls.push({ op, payload: structuredClone(payload) })
    assert.equal(JSON.stringify(payload).includes('"text"'), false, 'expected strings must never enter native IPC requests')
    if (op === 'reLaunch') {
      route = payload.route.replace(/^\//, '')
      counts.set(route, 0)
      return { path: route }
    }
    assert.equal(payload.route, route)
    const scope = payload.scope ?? [], address = { route, selector: payload.selector, ...(scope.length ? { scope } : {}) }
    if (op === 'query') {
      if (payload.selector === '#missing') return { ...address, count: 0, nodes: [] }
      return { ...address, count: 1, nodes: [{ id: `actual-${payload.selector}`, componentScopeId: payload.selector === '#foo' ? 'runtime-component-foo' : null }] }
    }
    if (op === 'query.text') {
      const read = reads.get(route) ?? 0
      reads.set(route, read + 1)
      return { ...address, count: 1, text: pollRetry && read === 0 ? 'actual pending render' : String(counts.get(route)) }
    }
    if (op === 'tap') {
      counts.set(route, counts.get(route) + 1)
      if (payload.selector === '#toggle') visible = !visible
      return { ...address, inputTransport: 'native-host-coordinate-event', x: 15, y: 25, frameId: 17, renderRevision: 21 }
    }
    assert.equal(op, 'checkpoint')
    const count = counts.get(route)
    const text = selector => {
      if (caseId === issue1058) return ({ '#builtin': 'builtin', '#pascal': `pascal-${count}`, '#kebab': `kebab-${count}`,
        '#duplicate': `duplicate-${count}`, '#increment': String(count), '#lowercase': 'explicit-lowercase',
        '#explicit-pascal': 'explicit-pascal', '#toggle': visible ? 'visible' : 'hidden' })[selector]
      if (caseId === issue1185) return ({ '#foo-values': '1/2', '#foo-increment': String(count), '#bar-values': '1/2',
        '#bar-increment': String(count), '#unused-value': '7' })[selector]
      if (caseId === issue1012) return count === 0 ? 'pending' : ({
        '#issue1012-map-result': '[7]', '#issue1012-results': '[8,9,10,11,12,13,99,99,99,99]',
      })[selector]
      return String(count)
    }
    const evidence = { id: payload.checkpoint, route, nodes: payload.selectors.map(value => {
      const query = typeof value === 'string' ? { selector: value } : value
      const hidden = !visible && ['#lowercase', '#explicit-pascal'].includes(query.selector)
      return { ...structuredClone(query), query: 'css', count: hidden ? 0 : 1, nodes: hidden ? [] : [{ text: text(query.selector) }] }
    }) }
    badCheckpoint?.(evidence)
    return evidence
  }
  return { calls, request }
}

test('1058 preserves its actual normalized event sequence and both assertions', async () => {
  const native = syntheticNative(issue1058), result = await replayCase({ caseId: issue1058, request: native.request })
  assert.equal(result.events.length, 10)
  assert.equal(result.assertions.length, 2)
  assert.deepEqual(result.events.map(value => value.op), ['route.active', 'dom.checkpoint', 'tap', 'dom.checkpoint',
    'route.active', 'dom.checkpoint', 'tap', 'dom.checkpoint', 'tap', 'dom.checkpoint'])
  assert.equal(result.events[7].payload.nodes[0].count, 0)
  assert.ok(native.calls.filter(value => value.op === 'checkpoint').every(value => value.payload.selectors.every(selector => typeof selector === 'string')))
  assert.ok(result.events.every((value, index) => value.seq === index && Object.keys(value).sort().join(',') === 'kind,op,payload,seq'))
})

test('1185 replays the actual component query chain and retains exact scope in native requests and events', async () => {
  const native = syntheticNative(issue1185), result = await replayCase({ caseId: issue1185, request: native.request })
  assert.equal(result.events.length, 10)
  assert.equal(result.assertions.length, 3)
  assert.deepEqual(native.calls.filter(value => value.op === 'query').map(value => value.payload), [
    { route: 'pages/component/index', selector: '#foo' },
    { route: 'pages/component/index', scope: ['#foo'], selector: '#foo-increment' },
    { route: 'pages/bar/bar', selector: '#bar-increment' },
  ])
  assert.deepEqual(result.events.find(value => value.op === 'tap').payload,
    { route: 'pages/component/index', scope: ['#foo'], selector: '#foo-increment' })
  assert.deepEqual(result.events[1].payload.nodes[0], { selector: '#foo-values', query: 'css', scope: ['#foo'], count: 1, nodes: [{ text: '1/2' }] })
  assert.ok(native.calls.filter(value => value.op === 'checkpoint').slice(0, 2)
    .every(value => value.payload.selectors.every(query => query.scope[0] === '#foo')))
})

test('1072 reads the actual native text before each coordinate tap and normalizes only the final poll read', async () => {
  const native = syntheticNative(issue1072, { pollRetry: true })
  const result = await replayCase({ caseId: issue1072, request: native.request })
  assert.equal(result.assertions.length, 1)
  assert.equal(native.calls.filter(value => value.op === 'query.text').length, 6)
  assert.deepEqual(result.events.map(value => value.op), Array.from({ length: 3 }, () => ['route.active', 'query.text', 'tap', 'dom.checkpoint']).flat())
  assert.deepEqual(result.events.filter(value => value.op === 'query.text').map(value => value.payload),
    ['pages/home/index', 'pages/external/index', 'pages/dynamic/index'].map(route => ({ route, selector: '#increment', text: '0' })))
  assert.ok(result.events.filter(value => value.op === 'dom.checkpoint').every(value => value.payload.nodes[0].nodes[0].text === '1'))
  assert.ok(result.events.every((value, index) => value.seq === index && ['lifecycle', 'render', 'event'].includes(value.kind)))
})

test('1012 replays the pinned route, both observed checkpoints and one coordinate tap without expected IPC values', async () => {
  const native = syntheticNative(issue1012), result = await replayCase({ caseId: issue1012, request: native.request })
  const route = 'pages/issue-1012/index', selectors = ['#issue1012-map-result', '#issue1012-results']
  assert.deepEqual(native.calls, [
    { op: 'reLaunch', payload: { route: '/' + route } },
    { op: 'checkpoint', payload: { route, checkpoint: 'initial', selectors } },
    { op: 'query', payload: { route, selector: '#issue1012-run' } },
    { op: 'tap', payload: { route, selector: '#issue1012-run' } },
    { op: 'checkpoint', payload: { route, checkpoint: 'executed', selectors } },
  ])
  assert.deepEqual(result.assertions, [{
    id: 'e2e app: github-issues / issue #1012 keeps JavaScript this ownership across compiled template expressions', passed: true,
  }])
  assert.deepEqual(result.events, [
    { seq: 0, kind: 'lifecycle', op: 'route.active', payload: { route } },
    { seq: 1, kind: 'render', op: 'dom.checkpoint', payload: { id: 'initial', route, nodes: selectors.map(selector =>
      ({ selector, query: 'css', count: 1, nodes: [{ text: 'pending' }] })) } },
    { seq: 2, kind: 'event', op: 'tap', payload: { route, selector: '#issue1012-run' } },
    { seq: 3, kind: 'render', op: 'dom.checkpoint', payload: { id: 'executed', route, nodes: [
      { selector: selectors[0], query: 'css', count: 1, nodes: [{ text: '[7]' }] },
      { selector: selectors[1], query: 'css', count: 1, nodes: [{ text: '[8,9,10,11,12,13,99,99,99,99]' }] },
    ] } },
  ])
})

test('1012 rejects either actual checkpoint mismatch at its observed action boundary', async () => {
  for (const checkpoint of ['initial', 'executed']) for (const index of [0, 1]) {
    const native = syntheticNative(issue1012, { badCheckpoint: evidence => {
      if (evidence.id === checkpoint) evidence.nodes[index].nodes[0].text = 'actual divergent this result'
    } })
    await assert.rejects(replayCase({ caseId: issue1012, request: native.request }), /Actual rendered text differs.*actual divergent this result/)
    assert.equal(native.calls.filter(value => value.op === 'tap').length, checkpoint === 'initial' ? 0 : 1)
    assert.equal(native.calls.at(-1).payload.checkpoint, checkpoint)
  }
})

test('1012 rejects absent actions, crossed actual addresses and incomplete native proofs while preserving IPC failures', async () => {
  const cases = [
    { op: 'query', mutate: value => ({ ...value, count: 0, nodes: [] }), error: /run button is absent/ },
    { op: 'query', mutate: value => ({ ...value, route: 'pages/other/index' }), error: /another actual route/ },
    { op: 'tap', mutate: value => ({ ...value, inputTransport: 'synthetic-tap' }), error: /host coordinate input transport/ },
    { op: 'tap', mutate: value => ({ ...value, selector: '#other-button' }), error: /another actual route, selector/ },
    { op: 'checkpoint', mutate: value => ({ ...value, id: 'other-checkpoint' }), error: /another actual route or checkpoint/ },
    { op: 'checkpoint', mutate: value => ({ ...value, route: 'pages/other/index' }), error: /another actual route or checkpoint/ },
  ]
  for (const scenario of cases) {
    const native = syntheticNative(issue1012)
    const request = async (op, payload) => {
      const value = await native.request(op, payload)
      return op === scenario.op ? scenario.mutate(value) : value
    }
    await assert.rejects(replayCase({ caseId: issue1012, request }), scenario.error)
    assert.equal(native.calls.some(value => value.op === 'checkpoint' && value.payload.checkpoint === 'executed'), false)
  }
  const failure = new Error('actual native issue1012 tap failed'), native = syntheticNative(issue1012)
  const request = async (op, payload) => {
    if (op === 'tap') throw failure
    return native.request(op, payload)
  }
  await assert.rejects(replayCase({ caseId: issue1012, request }), error => error === failure)
  assert.equal(native.calls.at(-1).op, 'query')
})

test('actual mismatched text, scope or count is rejected without replacing it with an expectation', async () => {
  for (const mutate of [
    evidence => { evidence.nodes[0].nodes[0].text = 'actual wrong text' },
    evidence => { delete evidence.nodes[0].scope },
    evidence => { evidence.nodes[0].count = 0; evidence.nodes[0].nodes = [] },
  ]) {
    const native = syntheticNative(issue1185, { badCheckpoint: mutate })
    await assert.rejects(replayCase({ caseId: issue1185, request: native.request }), /Actual rendered/)
    assert.equal(native.calls.some(value => value.op === 'tap'), false)
  }
  const native = syntheticNative(issue1072)
  const request = async (op, payload) => {
    const value = await native.request(op, payload)
    return op === 'query.text' ? { ...value, text: 'actual unexpected initial state' } : value
  }
  await assert.rejects(replayCase({ caseId: issue1072, request, pollTimeoutMs: 0 }), /Actual native polled text differs.*actual unexpected initial state/)
  assert.equal(native.calls.some(value => value.op === 'tap'), false)
})

test('native adapter resolves absent and recursive component queries and returns untouched actual tap proof', async () => {
  const calls = [], proof = { route: 'pages/actual/index', scope: ['#outer', '#inner'], selector: '#button',
    inputTransport: 'native-host-coordinate-event', x: 31, y: 42, frameId: 17 }
  const program = createNativeProgram(async (op, payload) => {
    calls.push({ op, payload })
    if (op === 'reLaunch') return { path: 'pages/actual/index' }
    if (op === 'tap') return proof
    if (op === 'query.text') return { ...payload, count: 1, text: 'actual raw text' }
    return { ...payload, count: payload.selector === '#missing' ? 0 : 1,
      nodes: payload.selector === '#missing' ? [] : [{ componentScopeId: `runtime-${payload.selector}` }] }
  })
  const page = await program.reLaunch('/pages/actual/index')
  assert.equal(await page.$('#missing'), undefined)
  const button = await (await (await page.$('#outer')).$('#inner')).$('#button')
  assert.equal(await button.text(), 'actual raw text')
  assert.equal(await button.tap(), proof)
  assert.deepEqual(calls.at(-1).payload, { route: 'pages/actual/index', scope: ['#outer', '#inner'], selector: '#button' })
})

test('native adapter fails on missing concrete component, crossed address, malformed query evidence and original IPC errors', async () => {
  for (const scenario of ['component', 'scope', 'route', 'selector', 'count']) {
    const program = createNativeProgram(async (op, payload) => {
      if (op === 'reLaunch') return { path: 'pages/actual/index' }
      const result = { ...payload, count: 1, nodes: [{ componentScopeId: 'runtime-outer' }] }
      if (scenario === 'component') result.nodes[0].componentScopeId = null
      if (scenario === 'scope') result.scope = ['#unexpected']
      if (scenario === 'route') result.route = 'pages/other/index'
      if (scenario === 'selector') result.selector = '#other'
      if (scenario === 'count') result.count = 2
      return result
    })
    const page = await program.reLaunch('/pages/actual/index')
    if (scenario === 'component') await assert.rejects((await page.$('#outer')).$('#button'), /actual runtime component/)
    else await assert.rejects(page.$('#outer'), /another actual|incomplete actual/)
  }
  const failure = new Error('actual native query failed')
  const program = createNativeProgram(async op => { if (op === 'reLaunch') return { path: 'pages/actual/index' }; throw failure })
  const page = await program.reLaunch('/pages/actual/index')
  await assert.rejects(page.$('#button'), error => error === failure)
})

test('scoped checkpoint assertion rejects flattening and case identities bind the exact reviewed collectors', async () => {
  const expected = [{ selector: '#button', scope: ['#outer', '#inner'], text: 'actual' }]
  const evidence = { nodes: [{ selector: '#button', scope: ['#outer', '#inner'], query: 'css', count: 1, nodes: [{ text: 'actual' }] }] }
  assertCheckpoint(evidence, expected)
  delete evidence.nodes[0].scope
  assert.throws(() => assertCheckpoint(evidence, expected), /scope differs/)
  for (const caseId of [issue1058, issue1185, issue1072, issue1012]) {
    const definition = caseDefinition(caseId)
    const bytes = await readFile(new URL(definition.collectorPath, import.meta.url))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), definition.collectorSha256)
  }
  const definition = caseDefinition(issue1012)
  assert.equal(definition.sourceSha256, createHash('sha256').update(await readFile(
    new URL('../../../vendor/weapp-vite/e2e/ide/github-issues.runtime.issue1012.test.ts', import.meta.url))).digest('hex'))
  assert.deepEqual(definition.collectorDependencies, [{
    path: '../../../conformance/recipes/issue1012-descriptor.mjs',
    sha256: 'f2d42a299ace11e3f6c208cbd32a3b3c6386bc2495cd1b61b63acfa280c9ba4e',
  }, {
    path: '../../../conformance/recipes/passive-collector-core.mjs',
    sha256: 'd4c7f7067347f99d873e51e6aff0d8339893626fa875938f6158f6e505b85041',
  }, {
    path: '../../../conformance/recipes/passive-query-context.mjs',
    sha256: 'b73284d8fcc450d145556e1437e8e47b6e342f487a68d9d4af4a3b04f4970b6f',
  }])
  const inputs = collectorInputs()
  const legacyPaths = new Set(closureFixture.legacyCollectors.map(value => value.path))
  assert.equal(closureFixture.legacyCollectors.length, 28)
  assert.deepEqual(closureFixture.reviewedRootUpdates.collectorInputs.map(value => value.path), ['../../../conformance/recipes/issue1034-collector.mjs'])
  const methodCollectorOverride = value => issue1011HostInputs.collectorUpdates.find(override => override.path === value.path) ?? issue826HostInputs.collectorUpdates.find(override => override.path === value.path) ?? issue941HostInputs.collectorUpdates.find(override => override.path === value.path) ?? issue1009HostInputs.collectorUpdates.find(override => override.path === value.path) ?? issue1008HostInputs.collectorUpdates.find(override => override.path === value.path) ?? recipeCompositionHostInputs.collectorUpdates.find(override => override.path === value.path) ?? importMetaHostInputs.collectorUpdates.find(override => override.path === value.path) ?? sourceMethodHostInputs.collectorUpdates.find(override => override.path === value.path) ?? value
  assert.deepEqual(sourceMethodHostInputs.collectorUpdates.map(value => value.path), ['../../../conformance/recipes/ordered-steps-collector-core.mjs'])
  assert.deepEqual(sourceMethodHostInputs.collectorAdditions.map(value => value.path), [
    '../../../conformance/recipes/source-method-values.mjs', '../../../conformance/recipes/issue297-302-collector.mjs',
    '../../../conformance/recipes/issue297-302-descriptor.mjs',
  ])
  const methodCollectorAdditions = new Set(sourceMethodHostInputs.collectorAdditions.map(value => value.path))
  const importMetaCollectorAdditions = new Set(importMetaHostInputs.collectorAdditions.map(value => value.path))
  assert.deepEqual(inputs.filter(value => importMetaCollectorAdditions.has(value.path)), importMetaHostInputs.collectorAdditions)
  const issue941CollectorAdditions = new Set(issue941HostInputs.collectorAdditions.map(value => value.path))
  assert.deepEqual(inputs.filter(value => issue941CollectorAdditions.has(value.path)), issue941HostInputs.collectorAdditions)
  const issue1009CollectorAdditions = new Set(issue1009HostInputs.collectorAdditions.map(value => value.path))
  assert.deepEqual(inputs.filter(value => issue1009CollectorAdditions.has(value.path)), issue1009HostInputs.collectorAdditions)
  const issue826CollectorAdditions = new Set(issue826HostInputs.collectorAdditions.map(value => value.path))
  assert.deepEqual(inputs.filter(value => issue826CollectorAdditions.has(value.path)), issue826HostInputs.collectorAdditions)
  const issue1008CollectorAdditions = new Set(issue1008HostInputs.collectorAdditions.map(value => value.path))
  assert.deepEqual(inputs.filter(value => issue1008CollectorAdditions.has(value.path)), issue1008HostInputs.collectorAdditions)
  const issue1011CollectorAdditions = new Set(issue1011HostInputs.collectorAdditions.map(value => value.path))
  assert.deepEqual(inputs.filter(value => issue1011CollectorAdditions.has(value.path)), issue1011HostInputs.collectorAdditions)
  const exceptionCollectorAdditions = new Set(sourceExceptionHostInputs.collectorAdditions.map(value => value.path))
  assert.deepEqual(sourceExceptionHostInputs.collectorAdditions.map(value => value.path), [
    '../../../conformance/recipes/issue1182-collector.mjs', '../../../conformance/recipes/issue1182-descriptor.mjs',
    '../../../conformance/recipes/source-exception-capture.mjs',
  ])
  assert.deepEqual(inputs.filter(value => exceptionCollectorAdditions.has(value.path)), sourceExceptionHostInputs.collectorAdditions)
  assert.deepEqual(inputs.filter(value => methodCollectorAdditions.has(value.path)), sourceMethodHostInputs.collectorAdditions)
  const legacyCollectors = closureFixture.legacyCollectors.map(value => methodCollectorOverride(closureFixture.reviewedRootUpdates.collectorInputs.find(override => override.path === value.path) ?? value))
  assert.deepEqual(inputs.filter(value => legacyPaths.has(value.path)), legacyCollectors)
  assert.equal(closureFixture.templateCollectors.length, 365)
  assert.equal(closureFixture.sfcCollectors.length, 4)
  assert.deepEqual(inputs.filter(value => !legacyPaths.has(value.path) && !methodCollectorAdditions.has(value.path) && !importMetaCollectorAdditions.has(value.path) && !exceptionCollectorAdditions.has(value.path) && !issue1008CollectorAdditions.has(value.path) && !issue1009CollectorAdditions.has(value.path) && !issue941CollectorAdditions.has(value.path) && !issue826CollectorAdditions.has(value.path) && !issue1011CollectorAdditions.has(value.path)),
    [...closureFixture.templateCollectors, ...closureFixture.sfcCollectors].map(methodCollectorOverride))
  assert.equal(new Set(inputs.map(value => value.path)).size, inputs.length)
  for (const reference of inputs) assert.equal(createHash('sha256').update(await readFile(
    new URL(reference.path, import.meta.url))).digest('hex'), reference.sha256)
  inputs.find(value => value.path.endsWith('issue1012-descriptor.mjs')).sha256 = 'unreviewed'
  assert.equal(collectorInputs().find(value => value.path.endsWith('issue1012-descriptor.mjs')).sha256,
    definition.collectorDependencies[0].sha256)
  assert.throws(() => caseDefinition('ide-unknown'), /no reviewed pinned case/)
})

test('collector input union keeps first-use order, copies identities and rejects conflicting shared paths', () => {
  const first = { path: './first.mjs', sha256: '1'.repeat(64) }
  const shared = { path: './shared.mjs', sha256: '2'.repeat(64) }
  const last = { path: './last.mjs', sha256: '3'.repeat(64) }
  const references = [first, shared, last, { ...shared }, { ...first }]
  const inputs = uniqueCollectorInputs(references)
  assert.deepEqual(inputs, [first, shared, last])
  assert.notEqual(inputs[0], first)
  assert.notEqual(inputs[1], shared)
  inputs[1].sha256 = 'mutated output'
  assert.equal(shared.sha256, '2'.repeat(64))
  assert.equal(uniqueCollectorInputs(references)[1].sha256, shared.sha256)
  assert.throws(() => uniqueCollectorInputs([...references, { ...shared, sha256: '4'.repeat(64) }]),
    /Native collector input identity conflicts for \.\/shared\.mjs/)
  assert.deepEqual(uniqueCollectorInputs([shared, { ...shared, bytes: 12 }, shared]), [{ ...shared, bytes: 12 }])
  assert.throws(() => uniqueCollectorInputs([{ ...shared, bytes: 12 }, { ...shared, bytes: 13 }]),
    /Native collector input identity conflicts for \.\/shared\.mjs/)
  assert.throws(() => uniqueCollectorInputs([{ ...shared, bytes: -1 }]), /Native collector input size is invalid/)
  assert.equal(references.length, 5)
  assert.deepEqual(uniqueCollectorInputs([]), [])
})

test('the declared driver registry retains the exact old closure and freezes every template helper and portable dependency', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url)), registry = await createDriverRegistry(root)
  assert.deepEqual(registry.drivers.map(value => [value.host, value.engine]), [['macos', 'quickjs'], ['macos', 'v8']])
  const driver = registry.drivers[0], closure = [driver.module, ...driver.inputs]
  assert.equal(closureFixture.legacyDriver.length, 47)
  const legacyPaths = new Set(closureFixture.legacyDriver.map(value => value.path))
  assert.deepEqual(desktopHostInputs.updates.map(value => value.path), [
    'examples/hosts/conformance-desktop/driver.mjs', 'examples/hosts/conformance-desktop/build.mjs',
  ])
  assert.deepEqual(desktopHostInputs.additions.map(value => value.path), ['examples/hosts/conformance-desktop/host-profile.mjs'])
  assert.deepEqual(sourceMethodHostInputs.updates.map(value => value.path), [
    'examples/hosts/conformance-desktop/driver.mjs', 'examples/hosts/conformance-desktop/replay.mjs',
    'examples/hosts/conformance-desktop/native-program.mjs', 'examples/hosts/conformance-desktop/source-plan-replay.mjs',
    'conformance/recipes/ordered-steps-collector-core.mjs',
  ])
  assert.deepEqual(sourceMethodHostInputs.additions.map(value => value.path), [
    'examples/hosts/conformance-desktop/issue297-302-replay.mjs', 'examples/hosts/conformance-desktop/issue297-302-static.mjs',
    'conformance/recipes/source-method-values.mjs', 'conformance/recipes/issue297-302-collector.mjs',
    'conformance/recipes/issue297-302-descriptor.mjs',
  ])
  const historicalPaths = new Set([...closureFixture.legacyDriver, ...closureFixture.templateDriver, ...closureFixture.sfcDriver].map(value => value.path))
  assert.ok(desktopHostInputs.updates.every(value => legacyPaths.has(value.path)), 'reviewed host updates must address existing legacy inputs')
  assert.ok(desktopHostInputs.additions.every(value => !historicalPaths.has(value.path)), 'reviewed host additions must be absent from every historical array')
  assert.ok(sourceMethodHostInputs.updates.every(value => historicalPaths.has(value.path)), 'reviewed method updates address existing inputs')
  assert.ok(sourceMethodHostInputs.additions.every(value => !historicalPaths.has(value.path)), 'reviewed method additions cannot replace historical inputs')
  const methodAdditionPaths = new Set(sourceMethodHostInputs.additions.map(value => value.path))
  const importMetaAdditionPaths = new Set(importMetaHostInputs.additions.map(value => value.path))
  assert.deepEqual(closure.filter(value => importMetaAdditionPaths.has(value.path)), importMetaHostInputs.additions)
  assert.deepEqual(sourceExceptionHostInputs.updates.map(value => value.path), [
    'examples/hosts/conformance-desktop/driver.mjs', 'examples/hosts/conformance-desktop/replay.mjs',
    'examples/hosts/conformance-desktop/source-plan-replay.mjs', 'examples/hosts/conformance-desktop/source-plan-static.mjs',
  ])
  assert.deepEqual(sourceExceptionHostInputs.additions.map(value => value.path), [
    'examples/hosts/conformance-desktop/issue1182-replay.mjs', 'examples/hosts/conformance-desktop/issue1182-static.mjs',
    'examples/hosts/conformance-desktop/native-exception-channel.mjs', 'conformance/recipes/issue1182-collector.mjs',
    'conformance/recipes/issue1182-descriptor.mjs', 'conformance/recipes/source-exception-capture.mjs',
  ])
  assert.deepEqual(nativeExceptionHostInputs.updates.map(value => value.path), ['examples/hosts/conformance-desktop/build.mjs', 'examples/hosts/conformance-desktop/host-profile.mjs', 'examples/hosts/conformance-desktop/replay.mjs', 'examples/hosts/conformance-desktop/native-exception-channel.mjs'])
  const nativeOverride = value => issue1011Override(opaqueNodeOverride(issue826Override(nativeExceptionHostInputs.updates.find(override => override.path === value.path) ?? value)))
  const exceptionOverride = value => sourceExceptionHostInputs.updates.find(override => override.path === value.path) ?? value
  const issue941AdditionPaths = new Set(issue941HostInputs.additions.map(value => value.path))
  assert.deepEqual(closure.filter(value => issue941AdditionPaths.has(value.path)), issue941HostInputs.additions)
  const issue1009AdditionPaths = new Set(issue1009HostInputs.additions.map(value => value.path))
  assert.deepEqual(closure.filter(value => issue1009AdditionPaths.has(value.path)), issue1009HostInputs.additions)
  const issue826AdditionPaths = new Set(issue826HostInputs.additions.map(value => value.path))
  assert.deepEqual(closure.filter(value => issue826AdditionPaths.has(value.path)), issue826HostInputs.additions)
  const issue1008AdditionPaths = new Set(issue1008HostInputs.additions.map(value => value.path))
  assert.deepEqual(closure.filter(value => issue1008AdditionPaths.has(value.path)), issue1008HostInputs.additions)
  const issue1011AdditionPaths = new Set(issue1011HostInputs.additions.map(value => value.path))
  assert.deepEqual(closure.filter(value => issue1011AdditionPaths.has(value.path)), issue1011HostInputs.additions)
  const exceptionAdditionPaths = new Set(sourceExceptionHostInputs.additions.map(value => value.path))
  assert.ok(sourceExceptionHostInputs.updates.every(value => historicalPaths.has(value.path) || methodAdditionPaths.has(value.path)))
  assert.ok(sourceExceptionHostInputs.additions.every(value => !historicalPaths.has(value.path) && !methodAdditionPaths.has(value.path)))
  assert.deepEqual(closure.filter(value => exceptionAdditionPaths.has(value.path)), sourceExceptionHostInputs.additions.map(nativeOverride))
  assert.deepEqual(closure.filter(value => methodAdditionPaths.has(value.path)), sourceMethodHostInputs.additions)
  const methodOverride = value => compositionOverride(importMetaHostInputs.updates.find(override => override.path === value.path) ?? sourceMethodHostInputs.updates.find(override => override.path === value.path) ?? value)
  const desktopHostPaths = new Set([...desktopHostInputs.updates, ...desktopHostInputs.additions].map(value => value.path))
  assert.equal(desktopHostPaths.size, 3)
  assert.deepEqual(closure.filter(value => desktopHostPaths.has(value.path)), [
    compositionOverride(exceptionOverride(methodOverride(desktopHostInputs.updates[0]))), ...desktopHostInputs.additions, desktopHostInputs.updates[1],
  ].map(nativeOverride))
  assert.deepEqual(closureFixture.reviewedRootUpdates.driverInputs.map(value => value.path), ['conformance/recipes/issue1034-collector.mjs'])
  const opaqueNodeAdditionPaths = new Set(opaqueNodeHostInputs.additions.map(value => value.path))
  assert.deepEqual(closure.filter(value => opaqueNodeAdditionPaths.has(value.path)), opaqueNodeHostInputs.additions)
  const legacy = closureFixture.legacyDriver.map(value => nativeOverride(compositionOverride(sourceExceptionHostInputs.updates.find(override => override.path === value.path) ?? importMetaHostInputs.updates.find(override => override.path === value.path) ?? sourceMethodHostInputs.updates.find(override => override.path === value.path)
    ?? desktopHostInputs.updates.find(override => override.path === value.path)
    ?? closureFixture.sfcDriverOverrides.find(override => override.path === value.path)
    ?? closureFixture.legacyDriverOverrides.find(override => override.path === value.path)
    ?? closureFixture.reviewedRootUpdates.driverInputs.find(override => override.path === value.path) ?? value)))
  assert.deepEqual(closure.filter(value => legacyPaths.has(value.path)), legacy)
  assert.equal(closureFixture.templateDriver.length, 368)
  assert.equal(closureFixture.sfcDriver.length, 8)
  assert.deepEqual(closure.filter(value => !legacyPaths.has(value.path) && !methodAdditionPaths.has(value.path) && !importMetaAdditionPaths.has(value.path) && !exceptionAdditionPaths.has(value.path) && !issue1008AdditionPaths.has(value.path) && !issue1009AdditionPaths.has(value.path) && !issue941AdditionPaths.has(value.path) && !issue826AdditionPaths.has(value.path) && !opaqueNodeAdditionPaths.has(value.path) && !issue1011AdditionPaths.has(value.path)), [...desktopHostInputs.additions, ...closureFixture.sfcDriver.slice(0, 4), ...closureFixture.templateDriver, ...closureFixture.sfcDriver.slice(4)].map(exceptionOverride).map(compositionOverride).map(nativeOverride))
  assert.equal(new Set(closure.map(value => value.path)).size, closure.length)
  const urls = new Set(closure.map(reference => new URL('../../../' + reference.path, import.meta.url).href))
  const moduleSources = new Map()
  for (const reference of closure) {
    const url = new URL('../../../' + reference.path, import.meta.url), bytes = await readFile(url)
    assert.equal(bytes.length, reference.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256)
    if (/\.(?:mjs|cjs|js)$/.test(reference.path)) moduleSources.set(url.href, bytes.toString('utf8'))
  }
  // Inspect the Node graph selected by the actual entries. Copied package alternatives
  // (for example nanoid's React Native entry) remain exact frozen bytes, but are not
  // dependencies of this formatter's Node entry.
  const moduleQueue = [...moduleSources.keys()].filter(url => !url.includes('/template-format-dependencies/'))
  const inspected = new Set()
  while (moduleQueue.length) {
    const url = new URL(moduleQueue.pop())
    if (inspected.has(url.href)) continue
    inspected.add(url.href)
    if (moduleSources.has(url.href)) {
      const tree = ts.createSourceFile(url.href, moduleSources.get(url.href), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      assert.equal(tree.parseDiagnostics.length, 0, `invalid driver JavaScript ${url.href}`)
      const inspect = node => {
        const moduleSpecifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
          : ts.isCallExpression(node)
            && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.arguments.length === 1 && ts.isIdentifier(node.expression) && node.expression.text === 'require')
            ? node.arguments[0] : undefined
        const specifier = moduleSpecifier && ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : undefined
        if (typeof specifier === 'string' && !isBuiltin(specifier)) {
          const target = specifier.startsWith('.') ? new URL(specifier, url).href : new URL('file://' + createRequire(url).resolve(specifier)).href
          // Node also resolves CJS extensionless relative requires.
          const resolved = urls.has(target) ? target : new URL('file://' + createRequire(url).resolve(specifier)).href
          assert.ok(urls.has(resolved), `missing driver input ${specifier} from ${url.href}`)
          moduleQueue.push(resolved)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(tree)
    }
  }
  assert.equal(closure.filter(value => /issue(?:1058|1185|1072|1012|1034|1014)-collector\.mjs$/.test(value.path)).length, 6)
  assert.equal(closure.filter(value => value.path.endsWith('/wxml-transform-collector.mjs')).length, 1)
  assert.equal(closure.filter(value => value.path.endsWith('/wxml-transform-descriptor.mjs')).length, 1)
  assert.equal(closure.filter(value => value.path.endsWith('/issue1012-descriptor.mjs')).length, 1)
  assert.equal(closure.filter(value => /issue(?:1012|1014|1034)-descriptor\.mjs$/.test(value.path)).length, 3)
  assert.equal(closure.filter(value => value.path.endsWith('/passive-collector-core.mjs')).length, 1)
  assert.equal(closure.filter(value => value.path.endsWith('/passive-query-context.mjs')).length, 1)
  assert.equal(closure.filter(value => /subpackage-(?:item|user)-collector\.mjs$/.test(value.path)).length, 2)
  assert.equal(closure.filter(value => /subpackage-(?:item|user)-descriptor\.mjs$/.test(value.path)).length, 2)
  assert.equal(closure.filter(value => value.path.endsWith('/ordered-plans-collector-core.mjs')).length, 1)
  for (const file of ['issue1013-collector.mjs', 'issue1013-descriptor.mjs', 'ordered-steps-collector-core.mjs']) {
    assert.equal(closure.filter(value => value.path.endsWith('/' + file)).length, 1)
  }
})
