/** Synthetic source adapter contracts only. No official/native execution. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { descriptor } from './issue297-302-descriptor.mjs'
import { createCollector } from './issue297-302-collector.mjs'
import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { encodeMethodValue, decodeMethodValue } from './source-method-values.mjs'
import { issue297302ActionTape, replayIssue297302 } from '../../examples/hosts/conformance-desktop/issue297-302-replay.mjs'
import { assertIssue297302StaticOutputs, loadIssue297302Inputs } from '../../examples/hosts/conformance-desktop/issue297-302-static.mjs'
import { createObservedNativeProgram } from '../../examples/hosts/conformance-desktop/native-program.mjs'
import { replaySourcePlan } from '../../examples/hosts/conformance-desktop/source-plan-replay.mjs'
import { descriptor as oldDescriptor } from './issue1013-descriptor.mjs'
import { assertIssue1013StaticOutputs } from '../../examples/hosts/conformance-desktop/issue1013-static.mjs'
import { githubProducerInvocation } from '../../scripts/conformance-github-producer.mjs'
import { reviewedCompilerProducer, assertReviewedFixtureProducer, assertReviewedSnapshotProducer } from '../../scripts/conformance-producer-revisions.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const root = new URL('../../', import.meta.url)
const source = await readFile(new URL('vendor/weapp-vite/' + descriptor.caseSourcePath, root), 'utf8')
const startup = engine => ({ engine, sessionId: 'synthetic-unit-only' })
const checkpoints = plan => plan.steps.filter(step => step.kind === 'checkpoint')
const groups = (plan, step) => step.queries.map(({ fields, ...address }, at) => ({ ...structuredClone(address), count: 1,
  nodes: [{ ...(fields.text ? { text: `unit ${plan.ordinal}/${step.ordinal}/${at}` } : {}),
    ...(fields.attributes.length ? { attributes: Object.fromEntries(fields.attributes.map(name => [name, 'actual unit attribute'])) } : {}) }] }))
function originalTrace(methodValue = undefined, value = descriptor) {
  const events = []
  const emit = event => events.push({ ...event, seq: events.length, atNs: String(events.length) })
  for (const plan of value.plans) {
    emit({ kind: 'lifecycle', op: 'route.active', payload: { planOrdinal: plan.ordinal, route: plan.route } })
    for (const step of plan.steps) {
      const identity = { planOrdinal: plan.ordinal, route: plan.route }
      if (step.kind === 'checkpoint') emit({ kind: 'render', op: 'dom.checkpoint', payload: { ...identity,
        checkpointOrdinal: step.ordinal, id: step.id, nodes: groups(plan, step) } })
      if (step.kind === 'tap') emit({ kind: 'event', op: 'tap', payload: { ...identity, actionOrdinal: step.ordinal, ...step.address } })
      if (step.kind === 'reLaunch') emit({ kind: 'event', op: 'reLaunch', payload: { ...identity, actionOrdinal: step.ordinal, sourceCallsite: step.sourceCallsite } })
      if (step.kind === 'method.call') emit({ kind: 'event', op: 'method.call', payload: { ...identity, actionOrdinal: step.ordinal,
        method: step.method, args: structuredClone(step.args), sourceCallsite: step.sourceCallsite, helperSha256: step.helperSha256,
        completion: { kind: 'fulfilled', value: encodeMethodValue(methodValue) } } })
    }
  }
  return { caseId: value.caseId, oracle: 'wechat-devtools', run: { status: 'passed' }, events,
    assertions: value.plans.map(plan => ({ id: plan.fullName, passed: true })) }
}
function wire(engine, { mutate, methodValue, fail, value = descriptor } = {}) {
  const calls = []; let pump = 0, action = 0, required = 0, revision = 1, pageId = 1, method = 0, route = 'pages/home/index'
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: startup(engine).sessionId, route,
    pageId: String(pageId), templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision + 10),
    renderRevision: String(revision), presentationAckRevision: String(revision), actionSeq: String(action),
    ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  const act = () => { action++; required = pump + 1; pump++; revision++ }
  const request = async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) })
    if (op === fail?.op) throw fail.error
    pump++
    let result
    if (op === 'render.settle') result = proof()
    else if (op === 'reLaunch') { route = payload.route.replace(/^\//, ''); pageId++; act(); result = { path: route, completion: proof() } }
    else if (op === 'currentPage') result = { path: route, pageId: String(pageId), completion: proof() }
    else if (op === 'checkpoint') {
      const plan = value.plans.find(plan => plan.route === route)
      const step = plan.steps.find(step => step.kind === 'checkpoint' && step.id === payload.checkpoint)
      result = { id: step.id, route, nodes: groups(plan, step), completion: proof() }
    } else if (op === 'method.call') {
      act(); method++
      result = { kind: 'native-guest-method-result-v1', owner: { kind: 'source-labelled-native-method-owner-v1',
        engine, sessionId: startup(engine).sessionId, sourceInvocationId: payload.sourceInvocationId,
        sourceDeclaration: structuredClone(payload.source), sourceDeclarationTrust: 'caller-declared-not-official-oracle',
        route, pageId: String(pageId), originalDeadlineNs: payload.deadlineNs,
        deadlineClock: 'original-unix-deadline-plus-once-anchored-monotonic-budget', sessionBeginAttempts: 1,
        sessionPollAttempts: 2, receiverTokenSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64) },
      observation: { kind: 'fulfilled', ticket: `unit-ticket-${method}`, value: encodeMethodValue(methodValue) }, completion: proof() }
    } else {
      assert.equal(payload.route, route)
      const address = { route, selector: payload.selector, frameId: revision + 10, renderRevision: revision, completion: proof() }
      if (op === 'query') result = { ...address, count: 1, nodes: [{ id: `actual/${payload.selector}`, componentScopeId: null }] }
      else if (op === 'tap') { const inputCompletion = proof(); act(); result = { ...address, x: 10, y: 20,
        inputTransport: 'native-host-coordinate-event', inputCompletion, completion: proof() } }
      else throw new Error('Unplanned synthetic operation ' + op)
    }
    return mutate?.(result, op, payload, calls) ?? result
  }
  return { calls, request }
}
function originalStaticAssertions() {
  const tests = source.split(/\n  it\(/).slice(1)
  assert.equal(tests.length, 3)
  return tests.map((text, planOrdinal) => {
    const list = []
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^expect\((issuePageWxml|issuePageJs)\)\.(not\.)?(toContain|toMatch)\((.*)\)$/)
      if (match) {
        // Evaluate only the pinned literal/RegExp expression, never test code.
        const value = runInNewContext('(' + match[4] + ')', Object.create(null), { timeout: 50 })
        list.push({ path: descriptor.plans[planOrdinal].route + (match[1] === 'issuePageWxml' ? '.wxml' : '.js'),
          kind: match[3], negated: Boolean(match[2]), value })
      }
    }
    return list
  }).flat()
}
const originalChecks = originalStaticAssertions()
function staticInputs() {
  const byPath = new Map(descriptor.compiledFiles.map(path => [path, []]))
  for (const check of originalChecks) if (check.kind === 'toContain' && !check.negated) byPath.get(check.path).push(check.value)
  byPath.get('pages/issue-297/index.wxml').push('wx:if="{{__wv_bind_0}}" wx:for="{{__wv_bind_1}}" data-title="{{__wv_bind_2}}" data-hello="{{__wv_bind_3[index]}}" {{__wv_bind_4[index]}}')
  byPath.get('pages/issue-297-setup-method-calls/index.wxml').push('wx:if="{{__wv_bind_0}}" wx:for="{{__wv_bind_1}}"',
    ...['inline', 'multi', 'member', 'template', 'ternary', 'wrap', 'optional'].map(name => `data-${name}="{{__wv_bind_2}}"`),
    ...['label', 'loop'].map(name => `data-${name}="{{__wv_bind_3[index]}}"`))
  byPath.get('pages/issue-302/index.wxml').push('class="{{__wv_cls_0[index]}}"')
  return { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, manifestIntegrity: 'c'.repeat(64),
    files: descriptor.compiledFiles.map(path => { const bytes = Buffer.from(byPath.get(path).join('\n')); return { path, bytes, length: bytes.length, sha256: hash(bytes) } }) }
}
const replay = (engine, transport, trace = originalTrace()) => replayIssue297302({ request: transport.request, startup: startup(engine), oracleTrace: trace, staticInputs: staticInputs() })

test('all three original tests and source helper identities are pinned; descriptors contain no expected DOM strings', async () => {
  for (const ref of descriptor.sourceGuards) {
    const bytes = await readFile(new URL('vendor/weapp-vite/' + ref.path, root)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes)
  }
  assert.equal(hash(Buffer.from(source)), descriptor.sourceSha256)
  const names = [...source.matchAll(/\n  it\('([^']+)'/g)].map(match => 'e2e app: github-issues / issue-297-302 ' + match[1])
  assert.deepEqual(descriptor.plans.map(plan => plan.fullName), names)
  assert.equal(descriptor.plans.flatMap(checkpoints).length, 15)
  assert.equal(descriptor.plans.flatMap(plan => plan.steps).filter(step => step.kind === 'method.call').length, 9)
  assert.equal(descriptor.plans.flatMap(plan => plan.steps).filter(step => step.kind === 'tap').length, 3)
  assert.ok(!JSON.stringify(descriptor).includes('Hello-1-Alpha-dasd'))
})
test('each engine replays all15 checkpoints,9 method calls and3 unique taps in source order, with explicit void results', async () => {
  for (const engine of ['quickjs', 'v8']) {
    const transport = wire(engine), result = await replay(engine, transport)
    assert.deepEqual(result.events, originalTrace().events.map(({ atNs, ...event }) => event))
    assert.equal(result.assertions.length, 3); assert.equal(result.staticCoverage.originalStaticExpectations, 55)
    assert.equal(transport.calls.filter(call => call.op === 'reLaunch').length, 3)
    assert.equal(transport.calls.filter(call => call.op === 'checkpoint').length, 15)
    assert.equal(transport.calls.filter(call => call.op === 'method.call').length, 9)
    assert.equal(transport.calls.filter(call => call.op === 'tap').length, 3)
    assert.equal(result.methodFacts.length, 9)
    assert.ok(result.events.filter(event => event.op === 'method.call').every(event => event.payload.completion.value.kind === 'undefined'))
    assert.deepEqual(transport.calls.filter(call => call.op === 'method.call').map(call => call.payload.method),
      ['cycleActive', 'appendRow', 'toggleListCase', 'toggleListCase', 'resetRows', 'cycleActive', 'toggleOptionalInvoker', 'toggleShowCase', 'toggleShowLoop'])
    const payloads = JSON.stringify(transport.calls.map(call => call.payload))
    assert.equal(payloads.includes('unit 0/'), false); assert.equal(payloads.includes('fulfilled'), false); assert.equal(payloads.includes('undefined'), false)
  }
})
test('only atNs is ignored; oracle return/DOM values cannot drive IPC and differ only at final comparison', async () => {
  for (const engine of ['quickjs', 'v8']) {
    const original = originalTrace(), altered = structuredClone(original)
    altered.events[2].payload.completion.value = { kind: 'json', value: { unexpected: 'oracle only' } }
    altered.events[1].payload.nodes[0].nodes[0].text = 'untrusted oracle text'
    assert.deepEqual(issue297302ActionTape(altered), issue297302ActionTape(original))
    const transport = wire(engine); await assert.rejects(replay(engine, transport, altered), /complete actual seq\/kind\/op\/payload trace differs/)
    assert.equal(transport.calls.filter(call => call.op === 'checkpoint').length, 15)
    assert.equal(JSON.stringify(transport.calls).includes('untrusted oracle text'), false)
    const timed = originalTrace(); timed.events.forEach(event => { event.atNs = '99999' }); assert.equal((await replay(engine, wire(engine), timed)).assertions.length, 3)
  }
})
test('missing, extra, reordered, changed method/args/source labels and invalid void never drive native requests', async () => {
  for (const mutate of [trace => trace.events.splice(2, 1), trace => trace.events.push(trace.events.at(-1)),
    trace => { [trace.events[2], trace.events[4]] = [trace.events[4], trace.events[2]] },
    trace => { trace.events[2].payload.method = 'other' }, trace => { trace.events[2].payload.args.push(1) },
    trace => { trace.events[2].payload.sourceCallsite += ' other' }, trace => { trace.events[2].payload.helperSha256 = '0'.repeat(64) },
    trace => { trace.events[2].payload.completion.value.value = null }, trace => { trace.assertions.pop() },
    trace => { trace.events[2].payload.completion.kind = 'rejected' }]) {
    const trace = originalTrace(); mutate(trace); const transport = wire('quickjs')
    await assert.rejects(replay('quickjs', transport, trace)); assert.equal(transport.calls.length, 0)
  }
})
test('both engine directions, session, Page, source, invocation, deadline and duplicate ticket substitutions reject', async () => {
  const patches = [owner => { owner.engine = owner.engine === 'quickjs' ? 'v8' : 'quickjs' }, owner => { owner.sessionId = 'foreign' },
    owner => { owner.pageId = '987' }, owner => { owner.route = 'pages/foreign/index' }, owner => { owner.sourceDeclaration.sha256 = '0'.repeat(64) },
    owner => { owner.sourceDeclaration.callsite += 'other' }, owner => { owner.sourceInvocationId += 'other' },
    owner => { owner.originalDeadlineNs = '1' }, owner => { owner.sessionBeginAttempts = 2 }, owner => { owner.sessionPollAttempts = 0 }]
  for (const engine of ['quickjs', 'v8']) for (const patch of patches) {
    const transport = wire(engine, { mutate(value, op) { if (op === 'method.call') patch(value.owner) } })
    await assert.rejects(replay(engine, transport), /same-source\/Page\/engine original-deadline owner/)
    assert.equal(transport.calls.filter(call => call.op === 'method.call').length, 1)
  }
  const duplicate = wire('quickjs', { mutate(value, op) { if (op === 'method.call') value.observation.ticket = 'duplicate' } })
  await assert.rejects(replay('quickjs', duplicate), /ticket is absent or duplicated/)
  assert.equal(duplicate.calls.filter(call => call.op === 'method.call').length, 2)
})
test('actual method rejection and transport timeout never turn into void and never retry source effects', async () => {
  for (const engine of ['quickjs', 'v8']) for (const kind of ['threw', 'rejected', 'cancelled']) {
    const transport = wire(engine, { mutate(value, op) { if (op === 'method.call') value.observation = { kind, ticket: 'terminal', reason: { kind: 'json', value: 'actual failure' } } } })
    await assert.rejects(replay(engine, transport), error => error.name === 'NativeSourceMethodError' && error.observation.kind === kind)
    assert.equal(transport.calls.filter(call => call.op === 'method.call').length, 1)
    assert.equal(transport.calls.filter(call => call.op === 'checkpoint').length, 1)
  }
  const error = new Error('actual transport deadline'), transport = wire('quickjs', { fail: { op: 'method.call', error } })
  await assert.rejects(replay('quickjs', transport), actual => actual === error)
  assert.equal(transport.calls.filter(call => call.op === 'method.call').length, 1)
})
test('method codec preserves undefined separately from JSON null and rejects coercions/holes/accessors without invoking them', () => {
  assert.deepEqual(encodeMethodValue(undefined), { kind: 'undefined' }); assert.deepEqual(encodeMethodValue(null), { kind: 'json', value: null })
  assert.equal(decodeMethodValue({ kind: 'undefined' }), undefined)
  let read = false; const accessor = { get secret() { read = true; return 1 } }
  const cyclic = {}; cyclic.self = cyclic
  for (const value of [NaN, Infinity, [undefined], Array(1), accessor, cyclic, new Error('not JSON'), () => {}]) assert.throws(() => encodeMethodValue(value))
  assert.equal(read, false)
  for (const value of [{ kind: 'undefined', value: null }, { kind: 'json' }, { kind: 'other' }]) assert.throws(() => decodeMethodValue(value))
})
test('method caller context is copied, rejects unsupported engines, and stale Page cannot send a same-route action', async () => {
  for (const engine of ['quickjs', 'v8']) {
    const spec = descriptor.plans[0].steps[1], context = { sourceSha256: descriptor.sourceSha256, startup: startup(engine),
      methods: [{ route: descriptor.plans[0].route, method: spec.method, args: [], sourceCallsite: spec.sourceCallsite }] }
    const transport = wire(engine), program = createObservedNativeProgram(transport.request, { methodContext: context })
    context.startup.engine = 'altered'; context.methods[0].method = 'altered'
    const stale = await program.reLaunch('/' + descriptor.plans[0].route), current = await program.reLaunch('/' + descriptor.plans[0].route)
    await assert.rejects(stale.callMethod(spec.method), /current Page/)
    assert.equal(transport.calls.filter(call => call.op === 'method.call').length, 0)
    assert.equal(await current.callMethod(spec.method), undefined)
    await assert.rejects(current.callMethod(spec.method), /next original action/)
    assert.equal(transport.calls.filter(call => call.op === 'method.call').length, 1)
  }
  assert.throws(() => createObservedNativeProgram(() => {}, { methodContext: { sourceSha256: descriptor.sourceSha256, startup: startup('other'), methods: [{}] } }), /startup/)
})
function provider({ invoke = async () => undefined } = {}) {
  const events = [], calls = [], pages = [], program = { async reLaunch(route) {
    const page = { path: route.replace(/^\//, ''), pageId: pages.length + 1,
      async callMethod(...args) { calls.push({ op: 'callMethod', receiver: this, args }); return invoke(...args) },
      async $$(selector) { return [{ async tap() { calls.push({ op: 'tap', selector }); return 'actual tap' } }] } }
    pages.push(page); return page
  }, async currentPage() { return pages.at(-1) } }
  const collector = createCollector({ emit: event => events.push(structuredClone(event)) }); collector.attach(program)
  const check = (plan, step, page) => collector.checkpoint({ evidence: { id: step.id, route: plan.route, nodes: groups(plan, step) } }, { session: program, page })
  return { events, calls, pages, program, collector, check }
}
test('passive collector preserves actual receiver/return identity and does not perform extra source actions', async () => {
  const result = { actual: true }, fixture = provider({ invoke: async () => result })
  for (const plan of descriptor.plans) {
    const page = await fixture.program.reLaunch('/' + plan.route)
    for (const step of plan.steps) {
      if (step.kind === 'checkpoint') fixture.check(plan, step, page)
      else if (step.kind === 'method.call') assert.equal(await page.callMethod(step.method, ...step.args), result)
      else await (await page.$$(step.address.selector))[0].tap()
    }
  }
  fixture.collector.flush(); assert.equal(fixture.calls.length, 12)
  assert.ok(fixture.calls.filter(call => call.op === 'callMethod').every(call => fixture.pages.includes(call.receiver)))
  assert.equal(fixture.events.filter(event => event.op === 'method.call').length, 9)
})
test('passive rejection, wrong method/args, stale Page and pending checkpoint cannot consume a method action', async () => {
  const plan = descriptor.plans[0], first = plan.steps[0], method = plan.steps[1]
  const error = new Error('actual provider rejection'), rejected = provider({ invoke: async () => { throw error } })
  const page = await rejected.program.reLaunch('/' + plan.route); rejected.check(plan, first, page)
  await assert.rejects(page.callMethod(method.method), actual => actual === error)
  assert.equal(rejected.events.filter(event => event.op === 'method.call').length, 0)
  assert.equal(rejected.collector.diagnostics().methodOutcomes.at(-1).kind, 'rejected'); assert.throws(() => rejected.collector.flush(), /incomplete/)
  for (const args of [['other'], [method.method, 1]]) {
    const f = provider(), p = await f.program.reLaunch('/' + plan.route); f.check(plan, first, p)
    assert.equal(await p.callMethod(...args), undefined); assert.equal(f.events.filter(event => event.op === 'method.call').length, 0)
    assert.throws(() => f.collector.flush(), /actual source address/)
  }
  let done; const gate = new Promise(resolve => { done = resolve }), f = provider({ invoke: () => gate }), p = await f.program.reLaunch('/' + plan.route)
  f.check(plan, first, p); const pending = p.callMethod(method.method)
  assert.throws(() => f.check(plan, plan.steps[2], p), /pending operation/); done('actual completion'); assert.equal(await pending, 'actual completion')
  assert.throws(() => f.collector.flush())
})
test('all55 original static expectations execute over exact six bytes and remain final assertions after all source actions', async () => {
  const input = staticInputs(); assert.equal(originalChecks.length + 1, 55)
  for (const check of originalChecks) {
    const text = input.files.find(file => file.path === check.path).bytes.toString('utf8')
    assert.equal(check.kind === 'toContain' ? text.includes(check.value) : new RegExp(check.value.source, check.value.flags).test(text), !check.negated)
  }
  assert.equal(assertIssue297302StaticOutputs(input).originalStaticExpectations, 55)
  for (const engine of ['quickjs', 'v8']) {
    const invalid = staticInputs(), file = invalid.files[0]; file.bytes = Buffer.from('missing generated assertions'); file.length = file.bytes.length; file.sha256 = hash(file.bytes)
    const transport = wire(engine)
    await assert.rejects(replayIssue297302({ request: transport.request, startup: startup(engine), oracleTrace: originalTrace(), staticInputs: invalid }), /original static assertion/)
    assert.equal(transport.calls.filter(call => call.op === 'method.call').length, 9); assert.equal(transport.calls.filter(call => call.op === 'tap').length, 3)
  }
})
test('current recipe closure pins all changed dependencies; exact source selects GitHub producer and variants reject', async () => {
  const recipe = JSON.parse(await readFile(new URL('./issue826-core-overlay-v1.json', import.meta.url))).recipes.find(value => value.caseId === descriptor.caseId)
  for (const ref of [recipe.collector, ...recipe.collectorInputs]) { const bytes = await readFile(new URL(ref.path, root)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes) }
  const sourceRoot = '/exact/checkout/.tmp/e2e-projects/github-issues/ide-github-issues.runtime.issue297-302.test.ts'
  const value = { caseId: descriptor.caseId, caseSourcePath: descriptor.caseSourcePath, sourceSha256: descriptor.sourceSha256,
    args: ['/cli', 'build', sourceRoot, '--platform', 'weapp'], cliPath: '/cli', cwd: sourceRoot, checkout: '/exact/checkout' }
  assert.equal(githubProducerInvocation(value)?.profile, 'github-static-snapshot-v1')
  for (const patch of [{ sourceSha256: '0'.repeat(64) }, { caseSourcePath: descriptor.caseSourcePath + 'changed' },
    { args: [...value.args, '--skipNpm'] }, { cwd: '/other' }]) assert.equal(githubProducerInvocation({ ...value, ...patch }), null)
})
test('same-plan typed reLaunch binds a real new Page and retains one original test identity', async () => {
  const plan = descriptor.plans[0], value = { ...descriptor, plans: [{ ...plan, steps: [plan.steps[0],
    { kind: 'reLaunch', ordinal: 0, route: plan.route, sourceCallsite: 'test-only-source-reopen', sourceAcquisition: 'MiniProgram.reLaunch then actual new Page' },
    { ...plan.steps[2], id: 'reopened' }] }] }
  const f = provider(), events = [], collector = createOrderedStepsCollector({ descriptor: value, emit: event => events.push(event) })
  collector.attach(f.program); const page = await f.program.reLaunch('/' + plan.route)
  const check = (step, current) => collector.checkpoint({ evidence: { id: step.id, route: plan.route, nodes: groups(plan, step) } }, { session: f.program, page: current })
  check(value.plans[0].steps[0], page); const reopened = await f.program.reLaunch('/' + plan.route)
  assert.notEqual(reopened.pageId, page.pageId); check(value.plans[0].steps[2], reopened); collector.flush()
  assert.deepEqual(events.map(event => event.op), ['route.active', 'dom.checkpoint', 'reLaunch', 'dom.checkpoint'])
})
test('same-plan reLaunch refuses a reused Page incarnation and stale prior Page checkpoints', async () => {
  const plan = descriptor.plans[0], value = { ...descriptor, plans: [{ ...plan, steps: [plan.steps[0],
    { kind: 'reLaunch', ordinal: 0, route: plan.route, sourceCallsite: 'test-only-source-reopen', sourceAcquisition: 'MiniProgram.reLaunch then actual new Page' },
    { ...plan.steps[2], id: 'reopened' }] }] }
  for (const reuseIncarnation of [true, false]) {
    let page, count = 0
    const program = { async reLaunch(route) { page = { path: route.replace(/^\//, ''), pageId: reuseIncarnation ? 1 : ++count }; return page },
      async currentPage() { return page } }
    const events = [], collector = createOrderedStepsCollector({ descriptor: value, emit: event => events.push(event) })
    collector.attach(program); const prior = await program.reLaunch('/' + plan.route)
    collector.checkpoint({ evidence: { id: value.plans[0].steps[0].id, route: plan.route, nodes: groups(plan, plan.steps[0]) } }, { session: program, page: prior })
    await program.reLaunch('/' + plan.route)
    if (reuseIncarnation) assert.throws(() => collector.flush(), /new Page incarnation/)
    else assert.throws(() => collector.checkpoint({ evidence: { id: 'reopened', route: plan.route, nodes: groups(plan, plan.steps[2]) } },
      { session: program, page: prior }), /Page|incarnation|current/)
    assert.equal(events.filter(event => event.op === 'dom.checkpoint').length, 1)
  }
})
test('the exact15-source prior producer tuple remains inert and case-scoped through the strict reader', async () => {
  const directory = new URL('scripts/fixtures/reviewed-producers/cjs-v5-r8-before297-302-v1/', root)
  const metadata = JSON.parse(await readFile(new URL('revision.json', directory)))
  const objects = new Map(), put = bytes => { const ref = { path: 'synthetic/' + hash(bytes), sha256: hash(bytes), bytes: bytes.length }; objects.set(ref.sha256, bytes); return ref }
  const sources = Object.fromEntries(await Promise.all(Object.entries(metadata.sources).map(async ([key, ref]) => [key, put(await readFile(new URL(ref.path, directory)))])))
  const load = ref => objects.get(ref.sha256)
  assert.equal(Object.keys(sources).length, 15)
  assert.equal(metadata.caseScopes.length, 12)
  assert.equal(metadata.caseScopes.some(scope => scope.caseId === descriptor.caseId), false)
  for (const scope of metadata.caseScopes) {
    const staticProfileInputs = metadata.staticProfileModules.map(item => ({ path: item.path, artifact: sources[item.key] }))
    const consumer = { ...scope, producer: sources.compilerUseProducer, preload: sources.compilerUsePreload, staticProfileInputs,
      macroObservation: { profile: metadata.profile, producer: sources.macroProducer, manifest: sources.macroManifest,
        observer: sources.macroObserver, validator: sources.macroValidator, profileInputs: staticProfileInputs } }
    const built = { caseId: scope.caseId, sourceSha256: scope.sourceSha256, producer: sources.fixtureBuildProducer,
      packer: { preload: sources.fixturePackerPreload }, staticProfileInputs,
      ...(scope.snapshotProfile ? { producerProfile: scope.snapshotProfile,
        producerInputs: metadata.snapshotModules.map(item => ({ path: item.path, artifact: sources[item.key] })) } : {}) }
    const selected = reviewedCompilerProducer(consumer, load), token = assertReviewedFixtureProducer(built, selected, load)
    if (scope.snapshotProfile) assert.equal(token.id, metadata.id)
    if (scope.snapshotProfile === 'github-static-snapshot-v1') assert.doesNotThrow(() => assertReviewedSnapshotProducer({ reference: sources.githubProducer,
      profile: scope.snapshotProfile, identity: scope }, token, load))
    const changed = { ...built, sourceSha256: '0'.repeat(64) }
    assert.throws(() => assertReviewedFixtureProducer(changed, selected, load), /unknown or mixed/)
  }
})
test('the preexisting tap-only source adapter keeps the exact complete normalized events with both engine transports', async () => {
  const files = oldDescriptor.compiledFiles.map(path => {
    const bytes = Buffer.from(path.endsWith('.wxml') && path.startsWith('pages/')
      ? '<view data-title="{{staticTitle}}" bindtap="__weapp_vite_inline" data-wd-ready="1" bindready="__weapp_vite_inline" />' : '')
    return { path, bytes, length: bytes.length, sha256: hash(bytes) }
  })
  for (const engine of ['quickjs', 'v8']) {
    const transport = wire(engine, { value: oldDescriptor }), trace = originalTrace(undefined, oldDescriptor)
    const result = await replaySourcePlan({ descriptor: oldDescriptor, assertStatic: assertIssue1013StaticOutputs,
      request: transport.request, oracleTrace: trace, staticInputs: { caseId: oldDescriptor.caseId, sourceSha256: oldDescriptor.sourceSha256, files } })
    assert.deepEqual(result.events, trace.events.map(({ atNs, ...event }) => event))
    assert.equal(result.staticCoverage.originalStaticExpectations, 12)
    assert.equal(Object.hasOwn(result, 'methodFacts'), false)
    assert.equal(transport.calls.some(call => call.op === 'method.call'), false)
  }
})
function staticClosure(mutate = () => {}) {
  const store = new Map(), records = {}
  const put = (name, value) => {
    mutate(name, value)
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
    const reference = { path: 'synthetic/' + name, sha256: hash(bytes), bytes: bytes.length }
    records[name] = { reference, value }; store.set(reference.path, bytes); return reference
  }
  const fixture = { manifest: { compiler: { commit: '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e' }, integrity: { root: 'c'.repeat(64) } } }
  const generated = staticInputs().files.map((file, at) => ({ kind: 'file', path: file.path, artifact: put('generated-' + at, file.bytes) }))
  mutate('generated', generated)
  const runtime = structuredClone(generated); mutate('runtime', runtime)
  const transaction = put('transaction', { schemaVersion: 1, kind: 'weapp-container.github-producer-transaction', profile: 'github-static-snapshot-v1',
    runtimeRoot: '/synthetic/runtime', runtimeProjectPath: '/synthetic/runtime', snapshotFiles: [...runtime,
      { kind: 'file', path: 'project.config.json', artifact: put('project-config', {}) }] })
  const checkpoint = put('checkpoint', { schemaVersion: 1, kind: 'weapp-container.static-generated-checkpoint', status: 'captured',
    caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, producerTransaction: transaction, runtimeGenerated: runtime,
    runtimeObservation: put('runtime-observation', { projectPath: '/synthetic/runtime' }),
    build: { generated, producerProfile: { profile: 'github-static-snapshot-v1', caseId: descriptor.caseId,
      sourceSha256: descriptor.sourceSha256, caseSourcePath: descriptor.caseSourcePath } } })
  const fixtureBuild = put('fixture-build', { schemaVersion: 1, kind: 'weapp-container.fixture-build', status: 'built',
    caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, checkpoint, fixture: put('fixture', fixture),
    before: put('before', structuredClone(runtime)), after: put('after', structuredClone(runtime)) })
  const suiteReport = put('suite', { success: true, testResults: [{ name: '/synthetic/' + descriptor.caseSourcePath, status: 'passed',
    assertionResults: descriptor.plans.map(plan => ({ fullName: plan.fullName, status: 'passed' })) }] })
  const original = originalTrace(); Object.assign(original, { schemaVersion: 1 }); Object.assign(original.run, { host: 'devtools', engine: 'wechat',
    environment: { baselineId: 'wechat-devtools-2.02.2609250-sdk-3.17.3', compilerCommit: fixture.manifest.compiler.commit,
      caseSourceSha256: descriptor.sourceSha256, manifestIntegrity: fixture.manifest.integrity.root } })
  const trace = put('trace', original)
  const execution = put('execution', { schemaVersion: 1, kind: 'wechat-devtools-case-execution', status: 'passed',
    caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, sourceUnchanged: true,
    compilerCommit: fixture.manifest.compiler.commit, baseline: { id: 'wechat-devtools-2.02.2609250-sdk-3.17.3' }, traceSha256: trace.sha256,
    manifestIntegrity: fixture.manifest.integrity.root, observedDevtoolsVersion: '2.02.2609250', observedBaseLibraryVersion: '3.17.3', fixtureBuild, suiteReport })
  return { recipe: { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, fixtureValue: fixture, oracle: { trace, execution } },
    loadArtifact: async reference => store.get(reference.path), store, records }
}
test('all three original non-skipped assertions and every static generated byte are bound to actual source/version/trace/pack references', async () => {
  const loaded = await loadIssue297302Inputs(staticClosure())
  assert.equal(loaded.trace.assertions.length, 3); assert.equal(loaded.staticInputs.files.length, 6)
  assert.equal(assertIssue297302StaticOutputs(loaded.staticInputs).originalStaticExpectations, 55)
  for (const [key, mutate] of [['suite', value => { value.testResults[0].assertionResults.pop() }],
    ['suite', value => { value.testResults[0].assertionResults[1].status = 'skipped' }],
    ['execution', value => { value.observedBaseLibraryVersion = '3.17.2' }],
    ['execution', value => { value.sourceUnchanged = false }], ['execution', value => { value.traceSha256 = '0'.repeat(64) }],
    ['transaction', value => { value.runtimeRoot = '/another/runtime' }],
    ['checkpoint', value => { value.build.producerProfile.sourceSha256 = '0'.repeat(64) }],
    ['generated', value => { value.pop() }], ['after', value => { value.pop() }],
    ['runtime', value => { value[0].artifact.sha256 = '0'.repeat(64) }]]) {
    await assert.rejects(loadIssue297302Inputs(staticClosure((name, value) => { if (name === key) mutate(value) })))
  }
})
