/** 仅验证源码计划和纯断言合同；不运行官方用例、编译器或宿主。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { descriptor } from './issue1009-descriptor.mjs'
import { expectedResults, expectedDomCheckpoints, assertIssue1009MethodResult, assertIssue1009DomEvidence } from './issue1009-source-assertions.mjs'
import { assertIssue1009PureReadSource, pureReadAudit } from './issue1009-pure-read.mjs'
import { methodPollPolicies } from './issue1009-source-policy.mjs'
import { createCollector, requiredSourceCollectorFeatures } from './issue1009-collector.mjs'
import { assertIssue1009Outputs, loadIssue1009Inputs } from '../../examples/hosts/conformance-desktop/issue1009-static.mjs'
const root = new URL('../../', import.meta.url), plan = descriptor.plans[0]
const sha = value => createHash('sha256').update(value).digest('hex')
const original = () => readFile(new URL('vendor/weapp-vite/' + descriptor.caseSourcePath, root), 'utf8')
const poll = plan.steps.find(step => step.kind === 'method.poll')
const methodResult = value => [{ route: plan.route, method: '_runE2E', sourceCallsite: poll.sourceCallsite, value }]
const generated = () => ({ caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, files: descriptor.compiledFiles.map(path => {
  const bytes = Buffer.from('synthetic generated member; not a compiler result')
  return { path, bytes, length: bytes.length, sha256: sha(bytes) }
}) })
const domEvidence = () => expectedDomCheckpoints.map(checkpoint => ({ id: checkpoint.id, route: plan.route,
  nodes: checkpoint.nodes.map(({ selector, ...fields }) => ({ selector, query: 'css', count: 1, nodes: [structuredClone(fields)] })) }))

test('complete source/helper/page/config guards match immutable original bytes', async () => {
  for (const ref of descriptor.sourceGuards) {
    const bytes = await readFile(new URL('vendor/weapp-vite/' + ref.path, root))
    assert.equal(sha(bytes), ref.sha256, ref.path); assert.equal(bytes.length, ref.bytes, ref.path)
  }
  assert.equal(descriptor.sourceSha256, '7aab6c9ec6c09f610bd8c13ae834dd63d96f906d40b2a5f86448a1f114bf56e9')
  assert.equal(descriptor.caseId, 'ide-github-issues-runtime-issue1009')
  const source = await original()
  assert.ok(source.includes("it('keeps compiler-owned handler parameters isolated from user bindings'"))
  assert.equal(plan.fullName, 'e2e app: github-issues / issue #1009 keeps compiler-owned handler parameters isolated from user bindings')
})
test('descriptor preserves all seven initial fields and six completed text queries without expected values', () => {
  assert.equal(plan.steps.length, 9)
  assert.deepEqual(plan.steps.map(step => step.kind), ['checkpoint', ...Array(6).fill('tap'), 'method.poll', 'checkpoint'])
  assert.equal(plan.steps[0].queries.length, 7); assert.equal(plan.steps.at(-1).queries.length, 6)
  assert.deepEqual(plan.steps[0].queries[0], { selector: '#issue-1009-page', query: 'css', fields: { text: false, attributes: ['data-e2e-issue'] } })
  assert.ok(plan.steps[0].queries.slice(1).every(query => query.fields.text && query.fields.attributes.length === 0))
  assert.deepEqual(plan.steps.at(-1).queries, plan.steps[0].queries.slice(1))
  const serialized = JSON.stringify(descriptor)
  for (const value of ['ctx: pending', 'bindings: CS', 'event: PA-tap', 'scope: IA', 'nested: PAA']) assert.ok(!serialized.includes(value))
  assert.ok(Object.isFrozen(descriptor) && Object.isFrozen(plan.steps[1].queryOptions))
})
test('six original single Page.$ acquisitions and tap callsites preserve exact source loop order/options', async () => {
  const source = await original(), lines = source.split('\n'), taps = plan.steps.filter(step => step.kind === 'tap')
  const selectors = ['#issue1009-ctx-callback', '#issue1009-scope-callback', '#issue1009-component-bindings', '#issue1009-nested-callbacks', '#issue1009-event-boundary', '#issue1009-control']
  assert.deepEqual(taps.map(step => step.address.selector), selectors)
  assert.equal(new Set(taps.map(step => step.address.selector)).size, 6)
  assert.ok(lines[87].includes('await page.$(selector, { timeout: 2_000 })'))
  assert.ok(lines[89].includes('await control.tap()'))
  for (const [at, step] of taps.entries()) {
    assert.equal(step.ordinal, at); assert.equal(step.sourceIteration, at)
    assert.equal(step.sourceAcquisition, 'Page.$ then actual Element.tap'); assert.equal(step.queryMethod, '$')
    assert.deepEqual(step.queryOptions, { timeout: 2000 })
    assert.equal(step.sourceCallsite, descriptor.caseSourcePath + ':88'); assert.equal(step.tapCallsite, descriptor.caseSourcePath + ':90')
  }
  assert.ok(!source.includes('page.$$'))
})
test('poll descriptor preserves the original 10s scope and full six-field source condition', async () => {
  const lines = (await original()).split('\n'), policy = methodPollPolicies[poll.sourceCallsite]
  assert.ok(lines[92].includes('expect.poll(')); assert.ok(lines[93].includes("page.callMethod('_runE2E')"))
  assert.ok(lines[94].includes('timeout: 10_000')); assert.ok(lines[95].includes('toEqual(EXPECTED_RESULTS)'))
  assert.equal(poll.ordinal, 6); assert.deepEqual(poll.args, []); assert.equal(poll.timeoutMs, 10000); assert.equal(poll.intervalMs, 50)
  assert.equal(policy.timeoutMs, 10000); assert.equal(policy.intervalMs, 50)
  assert.equal(policy.satisfied(structuredClone(expectedResults)), true)
  for (const key of Object.keys(expectedResults)) assert.equal(policy.satisfied({ ...expectedResults, [key]: 'actual different value' }), false)
  assert.equal(policy.satisfied({ ctxCallback: 'PA' }), false)
})
test('compiled-file projection retains exactly the three source pathExists assertions', async () => {
  const source = await original(), block = source.slice(source.indexOf('for (const relativePath of ['), source.indexOf(']) {', source.indexOf('for (const relativePath of [')))
  assert.deepEqual([...block.matchAll(/'(pages\/issue-1009\/[^']+)'/g)].map(match => match[1]), descriptor.compiledFiles)
  const coverage = assertIssue1009Outputs(generated(), { methodResults: methodResult(structuredClone(expectedResults)) })
  assert.equal(coverage.originalStaticExpectations, 3); assert.equal(coverage.originalRuntimeExpectations, 1); assert.equal(coverage.originalRuntimeFields, 6)
  assert.equal(coverage.assertionCoverage.length, 4)
})
test('file existence adds no invented JS/WXML content or nonempty requirement', () => {
  const input = generated()
  input.files = input.files.map(file => ({ ...file, bytes: Buffer.alloc(0), length: 0, sha256: sha(Buffer.alloc(0)) }))
  assert.doesNotThrow(() => assertIssue1009Outputs(input, { methodResults: methodResult(structuredClone(expectedResults)) }))
})
test('static projection rejects missing/duplicate/reordered/substituted/tampered generated members and source', () => {
  for (const mutation of [input => input.files.pop(), input => input.files.reverse(), input => input.files[1] = input.files[0],
    input => input.files[0].path = 'other.js', input => input.files[0].sha256 = '0'.repeat(64), input => input.files[0].length++,
    input => input.caseId = 'other-case', input => input.sourceSha256 = '0'.repeat(64)]) {
    const input = generated(); mutation(input)
    assert.throws(() => assertIssue1009Outputs(input, { methodResults: methodResult(structuredClone(expectedResults)) }), /Issue1009/)
  }
})
test('runtime assertion checks all actual six fields, without accepting DOM-derived or partial substitutes', () => {
  assert.equal(assertIssue1009MethodResult(methodResult(structuredClone(expectedResults))).fields.length, 6)
  for (const key of Object.keys(expectedResults)) {
    assert.throws(() => assertIssue1009MethodResult(methodResult({ ...expectedResults, [key]: 'actual different value' })), /six-field/)
    const partial = { ...expectedResults }; delete partial[key]
    assert.throws(() => assertIssue1009MethodResult(methodResult(partial)), /six-field/)
  }
  for (const value of [null, undefined, 'ctx: PA', { ...expectedResults, extra: true }, domEvidence()]) {
    assert.throws(() => assertIssue1009MethodResult(methodResult(value)), /six-field/)
  }
})
test('method result cannot be absent, duplicated, readiness-labeled or cross-route', () => {
  const actual = methodResult(structuredClone(expectedResults))
  for (const values of [[], [...actual, ...actual], [{ ...actual[0], route: 'other' }], [{ ...actual[0], method: 'other' }],
    [{ ...actual[0], sourceCallsite: descriptor.caseSourcePath + ':73' }]]) assert.throws(() => assertIssue1009MethodResult(values), /Issue1009/)
})
test('all thirteen original DOM assertions bind exact selector/count/field/value and checkpoint order', async () => {
  const source = await original()
  assert.equal(assertIssue1009DomEvidence(domEvidence()).nodeAssertions, 13)
  for (const checkpoint of expectedDomCheckpoints) for (const node of checkpoint.nodes) {
    assert.ok(source.includes(`selector: '${node.selector}'`))
    if (node.text) assert.ok(source.includes(`text: '${node.text}'`))
  }
  for (const [checkpointAt, checkpoint] of domEvidence().entries()) for (const [nodeAt] of checkpoint.nodes.entries()) {
    const actual = domEvidence(); actual[checkpointAt].nodes[nodeAt].nodes[0] = { text: 'actual incorrect DOM' }
    assert.throws(() => assertIssue1009DomEvidence(actual), /rendered assertion/)
  }
})
test('DOM omissions/duplicates/count changes cannot hide a missing original assertion', () => {
  for (const mutation of [values => values.reverse(), values => values.pop(), values => values[0].nodes.pop(),
    values => values[1].nodes.push(values[1].nodes[0]), values => values[1].nodes[0].count = 0,
    values => values[1].route = 'other', values => values[0].nodes[0].nodes[0].attributes['data-e2e-issue'] = 'other']) {
    const actual = domEvidence(); mutation(actual); assert.throws(() => assertIssue1009DomEvidence(actual), /Issue1009/)
  }
})
test('source collector construction emits no fallback query or invented trace before real execution', () => {
  const events = []
  assert.deepEqual(requiredSourceCollectorFeatures, ['source-single-element-acquisition', 'source-expect-poll-scope'])
  const collector = createCollector({ emit: event => events.push(event) })
  assert.throws(() => collector.flush(), /coverage is incomplete/)
  assert.deepEqual(events, [])
})
test('static reader retains the existing complete official oracle/fixture admission gate', async () => {
  let reads = 0
  await assert.rejects(loadIssue1009Inputs({ recipe: { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256 },
    loadArtifact: async () => { reads++; return Buffer.from('{}') } }), /actual pinned fixture and official oracle/)
  assert.equal(reads, 0)
})

test('terminal normalization is restricted to exact side-effect-free guest read source, never a generic poll collapse', async () => {
  const bytes = await readFile(new URL('vendor/weapp-vite/' + pureReadAudit.sourcePath, root))
  assert.deepEqual(assertIssue1009PureReadSource(bytes), poll.normalization)
  assert.equal(pureReadAudit.methodStartLine, 28); assert.equal(pureReadAudit.methodEndLine, 30)
  assert.equal(pureReadAudit.rawAttempts, 'complete-private-journal')
  for (const changed of [Buffer.from(bytes.toString().replace('return { ...results.value }', 'results.value.control = "mutated"; return { ...results.value }')),
    Buffer.from(bytes.toString().replace("control: 'pending'", "get control() { return 'pending' }"))]) {
    assert.throws(() => assertIssue1009PureReadSource(changed), /exact audited pure-read/)
  }
})
