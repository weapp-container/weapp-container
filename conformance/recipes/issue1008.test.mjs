/** Synthetic source-bound contracts only; no SDK/native/official execution. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { descriptor } from './issue1008-descriptor.mjs'
import { readinessPolicies } from './issue1008-source-policy.mjs'
import { createCollector } from './issue1008-collector.mjs'
import { encodeMethodValue } from './source-method-values.mjs'
import { issue1008ActionTape, replayIssue1008 } from '../../examples/hosts/conformance-desktop/issue1008-replay.mjs'
import { assertIssue1008Outputs } from '../../examples/hosts/conformance-desktop/issue1008-static.mjs'
import { instrumentGithubSharedRuntime, githubProducerCase } from '../../scripts/conformance-github-producer.mjs'
const root = new URL('../../', import.meta.url), hash = value => createHash('sha256').update(value).digest('hex')
const plan = descriptor.plans[0], readiness = plan.steps[0], policy = readinessPolicies[readiness.sourceCallsite]
const source = await readFile(new URL('vendor/weapp-vite/' + descriptor.caseSourcePath, root), 'utf8')
const originalHelper = await readFile(new URL('vendor/weapp-vite/e2e/ide/github-issues.runtime.shared.ts', root), 'utf8')
const sourceTree = ts.createSourceFile('case.ts', source, ts.ScriptTarget.Latest, true)
const binding = sourceTree.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations)
  .find(node => node.name.getText(sourceTree) === 'ISSUE_1008_STEPS')
const steps = runInNewContext('(' + binding.initializer.getText(sourceTree) + ')')
const snapshots = () => JSON.parse(JSON.stringify(steps.map(step => step.snapshot)))
const groups = index => plan.steps.find(step => step.kind === 'checkpoint' && step.ordinal === index).queries
  .map(({ fields: _fields, ...address }, at) => ({ ...address, count: 1, nodes: [{ text: steps[index].texts[at] }] }))
const staticInputs = () => ({ caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256,
  files: descriptor.compiledFiles.map(path => { const bytes = Buffer.from('synthetic existence input/' + path)
    return { path, bytes, sha256: hash(bytes), length: bytes.length } }) })
const identity = { caseId: descriptor.caseId, caseSourcePath: descriptor.caseSourcePath, sourceSha256: descriptor.sourceSha256 }
function helperRuntime(program, collector, { mode = 'withOptions', onOptions, invokeHook, retry = false } = {}) {
  const transformed = instrumentGithubSharedRuntime(originalHelper, identity)
  const tree = ts.createSourceFile('helper.ts', transformed, ts.ScriptTarget.Latest, true)
  const names = ['callRoutePageMethodWithOptions', 'callRoutePageMethod', 'waitForPageReadiness']
  const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(tree).replace(/^export\s+/, '')).join('\n')
  const javascript = ts.transpileModule(functions + '\nglobalThis.routeMethod=callRoutePageMethod; globalThis.waitReady=waitForPageReadiness',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const context = { Date: { now: () => program.clock() }, CURRENT_PAGE_PROTOCOL_TIMEOUT: 1234,
    ROUTE_PAGE_METHOD_PROTOCOL_TIMEOUT: 4321, ROUTE_PAGE_METHOD_RECOVERY_ATTEMPTS: 2, ROUTE_PAGE_METHOD_RETRIES: 3,
    waitForCurrentPagePath: async (session, route, timeout) => { assert.equal(route, '/' + plan.route); assert.equal(timeout, 1234); return await session.currentPage() },
    runAutomatorOp: async (label, invoke, options) => { onOptions?.(label, options); try { return await invoke() } catch (error) { if (!retry) throw error; return await invoke() } },
    runWithTimeout: invoke => invoke(), delay: async ms => program.wait(ms), shouldRecoverRoutePageMethodError: () => false,
    recordConformanceRoutePageMethod: (metadata, invoke) => (invokeHook ?? collector.routePageMethod)(metadata, invoke),
    recordConformanceReadinessStart: metadata => collector.readinessStart(metadata),
    recordConformanceReadinessEnd: token => collector.readinessEnd(token),
    getCurrentPages: () => [{ route: plan.route, _runE2E: () => program.sample() }],
  }
  runInNewContext(javascript, context, { timeout: 1000 })
  if (mode !== 'withOptions') {
    program.page.callMethodWithOptions = undefined
    program[mode === 'evaluateOptions' ? 'evaluateWithOptions' : 'evaluate'] = async (invoke, ...args) => {
      if (mode === 'evaluateOptions') { onOptions?.('evaluateWithOptions', args.shift()); }
      return await invoke(...args)
    }
  }
  return context
}
function passive({ readinessSamples = [{ count: 1 }], finals = snapshots(), mode, options, retry } = {}) {
  let stamp = 1000, readAt = 0, tapAt = 0, checkpointAt = 0
  const samples = [...readinessSamples, ...finals], calls = [], events = []
  const sample = () => { const value = samples[readAt++]; calls.push({ op: 'method', value });
    if (value && Object.hasOwn(value, 'throw')) throw value.throw; return value }
  const page = { path: plan.route, pageId: 42, async callMethodWithOptions(name, metadata, ...args) {
    assert.equal(name, '_runE2E'); assert.equal(metadata.routeOnly, true); assert.equal(metadata.timeout, 4321); assert.deepEqual(args, []); return sample() },
    async $$(selector, options) { calls.push({ op: '$$', selector, options });
      return [{ async tap() { assert.equal(selector, steps[++tapAt].button); calls.push({ op: 'tap', selector }) } }] },
    async waitFor(ms) { stamp += ms },
  }
  const program = { page, sample, clock: () => stamp, wait: ms => { stamp += ms },
    async reLaunch() { return page }, async currentPage() { return this.currentOverride ?? page } }
  const collector = createCollector({ clock: program.clock, emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  collector.attach(program)
  const helper = helperRuntime(program, collector, { mode, onOptions: options, retry })
  const run = async () => {
    await program.reLaunch('/' + plan.route)
    const ready = await helper.waitReady(program, page, '/' + plan.route, undefined, 12000,
      async () => (await helper.routeMethod(program, '/' + plan.route, '_runE2E')).count === 1)
    assert.equal(ready.ready, true)
    for (const step of steps) {
      if (step.button) { const controls = await page.$$(step.button, { fallback: false, timeout: 5000 }); assert.equal(controls.length, 1); await controls[0].tap() }
      collector.checkpoint({ evidence: { id: step.id, route: plan.route, nodes: groups(checkpointAt++) } }, { session: program, page })
      assert.deepEqual(JSON.parse(JSON.stringify(await helper.routeMethod(program, '/' + plan.route, '_runE2E'))), JSON.parse(JSON.stringify(step.snapshot)))
    }
    collector.flush()
    return { caseId: descriptor.caseId, oracle: 'wechat-devtools', run: { status: 'passed' }, events,
      assertions: [{ id: plan.fullName, passed: true }] }
  }
  return { run, calls, program, collector, helper, events, sample, setClock: value => { stamp = value } }
}
const startup = engine => ({ engine, sessionId: 'synthetic-issue1008-only' })
function native(engine, { readinessSamples = [{ count: 1 }], finals = snapshots(), mutate, queryCount = 1, rejectMethodAt } = {}) {
  const samples = [...readinessSamples, ...finals], calls = []; let stamp = 1000, methodAt = 0, checkpointAt = 0, taps = 0
  let pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = 'pages/home/index'
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: startup(engine).sessionId, route, pageId: String(pageId),
    templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision + 10), renderRevision: String(revision),
    presentationAckRevision: String(revision), actionSeq: String(action), ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  const act = () => { action++; required = pump + 1; pump++; revision++ }
  const request = async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) }); pump++; let result
    if (op === 'render.settle') result = proof()
    else if (op === 'reLaunch') { route = payload.route.replace(/^\//, ''); pageId++; act(); result = { path: route, completion: proof() } }
    else if (op === 'currentPage') result = { path: route, pageId: String(pageId), completion: proof() }
    else if (op === 'checkpoint') result = { id: steps[checkpointAt].id, route, nodes: groups(checkpointAt++), completion: proof() }
    else if (op === 'query') result = { route, selector: payload.selector, count: queryCount,
      nodes: Array.from({ length: queryCount }, (_, index) => ({ id: 'actual/' + payload.selector + '/' + index, componentScopeId: null })),
      frameId: Number(proof().frameId), renderRevision: Number(proof().renderRevision), completion: proof() }
    else if (op === 'tap') {
      assert.equal(payload.selector, steps[++taps].button); const inputCompletion = proof(); act(); const completion = proof()
      result = { route, selector: payload.selector, inputTransport: 'native-host-coordinate-event', x: 5, y: 7,
        frameId: Number(inputCompletion.frameId), renderRevision: Number(inputCompletion.renderRevision), inputCompletion, completion }
    } else if (op === 'method.call') {
      const index = methodAt++, item = samples[index]; if (index === rejectMethodAt) throw rejectMethodAt.error
      act(); const observation = item && Object.hasOwn(item, 'throw')
        ? { kind: 'rejected', ticket: 'unit/' + index, reason: item.throw === undefined ? { kind: 'undefined' } : { kind: 'json', value: item.throw } }
        : { kind: 'fulfilled', ticket: 'unit/' + index, value: encodeMethodValue(item) }
      result = { kind: 'native-guest-method-result-v1', owner: { kind: 'source-labelled-native-method-owner-v1', engine, sessionId: startup(engine).sessionId,
        sourceInvocationId: payload.sourceInvocationId, sourceDeclaration: structuredClone(payload.source), sourceDeclarationTrust: 'caller-declared-not-official-oracle',
        route, pageId: String(pageId), originalDeadlineNs: payload.deadlineNs, deadlineClock: 'original-unix-deadline-plus-once-anchored-monotonic-budget',
        sessionBeginAttempts: 1, sessionPollAttempts: 2, requestSha256: 'a'.repeat(64), receiverTokenSha256: 'b'.repeat(64) }, observation, completion: proof() }
    } else throw new Error('Unplanned synthetic op: ' + op)
    return mutate?.(result, op, payload) ?? result
  }
  return { request, calls, readinessClock: () => stamp, readinessWait: async ms => { stamp += ms } }
}
const replay = (engine, wire, trace, input = staticInputs()) => replayIssue1008({ ...wire, startup: startup(engine), oracleTrace: trace, staticInputs: input })

test('pinned source/guards retain 5 checkpoints, 4 unique taps, all 5 interleaved method results and exact source identities', async () => {
  assert.equal(hash(source), descriptor.sourceSha256)
  for (const ref of descriptor.sourceGuards) { const bytes = await readFile(new URL('vendor/weapp-vite/' + ref.path, root)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes) }
  assert.deepEqual(plan.steps.map(step => step.kind), ['method.readiness', 'checkpoint', 'method.call', 'tap', 'checkpoint', 'method.call', 'tap', 'checkpoint', 'method.call', 'tap', 'checkpoint', 'method.call', 'tap', 'checkpoint', 'method.call'])
  assert.deepEqual(plan.steps.filter(step => step.kind === 'checkpoint').map(step => step.id), Array.from(steps, step => step.id))
  assert.deepEqual(plan.steps.filter(step => step.kind === 'tap').map(step => step.address.selector), Array.from(steps).slice(1).map(step => step.button))
  assert.equal(JSON.stringify(descriptor).includes('parameterResult'), false)
  assert.equal(policy.timeoutMs, 12000); assert.equal(policy.pollMs, 220)
  for (const value of [undefined, null, {}, { count: 0 }, { count: '1' }]) assert.equal(policy.ready(value), false)
  assert.equal(policy.ready({ count: 1, other: 'independent source readiness' }), true)
})
test('unchanged original helper uses options/evaluate alternatives and every observed original method terminal result', async () => {
  for (const mode of ['withOptions', 'evaluateOptions', 'evaluate']) {
    const options = [], p = passive({ mode, options: (label, value) => options.push({ label, value }) }), trace = await p.run()
    assert.equal(trace.events.filter(event => event.op === 'method.call').length, 5)
    assert.equal(trace.events.filter(event => event.op === 'method.readiness').length, 1)
    assert.equal(trace.events.filter(event => event.op === 'dom.checkpoint').length, 5)
    assert.equal(trace.events.filter(event => event.op === 'tap').length, 4)
    const routeCalls = options.filter(value => value.label.startsWith('call route page method'))
    assert.equal(routeCalls.length, 6)
    for (const option of routeCalls) assert.deepEqual(JSON.parse(JSON.stringify(option.value)), { timeoutMs: 5321, retries: 3, retryDelayMs: 500 })
    if (mode === 'evaluateOptions') for (const value of options.filter(value => value.label === 'evaluateWithOptions')) assert.equal(value.value.timeout, 4321)
  }
})
test('both synthetic engines preserve source order, accepted presentation, independent returns, and exactly four taps', async () => {
  const trace = await passive().run()
  for (const engine of ['quickjs', 'v8']) {
    const wire = native(engine), value = await replay(engine, wire, trace)
    assert.deepEqual(value.events, trace.events); assert.equal(value.methodFacts.length, 6)
    assert.equal(value.staticCoverage.originalMethodResultExpectations, 5); assert.equal(value.staticCoverage.originalExistenceExpectations, 3)
    assert.deepEqual(wire.calls.filter(call => call.op === 'tap').map(call => call.payload.selector), Array.from(steps).slice(1).map(step => step.button))
    assert.equal(wire.calls.filter(call => call.op === 'checkpoint').length, 5)
    assert.equal(wire.calls.filter(call => call.op === 'currentPage').length, 7)
    assert.equal(new Set(value.methodFacts.map(fact => fact.owner.sourceInvocationId)).size, 6)
  }
})
test('readiness false, null/property throw, and actual rejected primitive repeat only reads and preserve final five returns', async () => {
  const readinessSamples = [undefined, { count: 0 }, { throw: 'actual rejection' }, { count: 1 }]
  const trace = await passive({ readinessSamples }).run()
  for (const engine of ['quickjs', 'v8']) {
    const wire = native(engine, { readinessSamples }), result = await replay(engine, wire, trace)
    assert.deepEqual(result.events, trace.events); assert.equal(result.methodFacts.length, 9)
    assert.equal(wire.calls.filter(call => call.op === 'tap').length, 4)
    assert.deepEqual(result.events.filter(event => event.op === 'method.readiness').map(event => event.payload.ready), [false, false, false, true])
  }
})
test('helper transport retry remains internal to one actual source-method result without duplicate events', async () => {
  const p = passive({ readinessSamples: [{ throw: 'protocol transient' }, { count: 1 }], retry: true }), trace = await p.run()
  assert.equal(p.calls.filter(call => call.op === 'method').length, 7)
  assert.equal(trace.events.filter(event => event.op.startsWith('method.')).length, 6)
})
test('oracle counts and values never select IPC payloads or number of retries', async () => {
  const a = await passive().run(), b = await passive({ readinessSamples: [{ count: 0 }, { count: 1 }] }).run()
  assert.deepEqual(issue1008ActionTape(a), issue1008ActionTape(b))
  const wire = native('quickjs'); await assert.rejects(replay('quickjs', wire, b), /complete actual.*trace differs/)
  assert.equal(wire.calls.filter(call => call.op === 'method.call').length, 6)
  assert.equal(wire.calls.filter(call => call.op === 'tap').length, 4)
  const serialized = JSON.stringify(wire.calls)
  for (const word of ['blockResult', 'closureResult', 'parameterResult', 'snapshot/', '[7,8]']) assert.equal(serialized.includes(word), false)
})
test('missing, duplicated, reordered and substituted method/checkpoint observations fail before IPC', async () => {
  const original = await passive().run()
  for (const mutate of [trace => trace.events.splice(2, 1), trace => trace.events.push(trace.events.at(-1)),
    trace => { [trace.events[2], trace.events[3]] = [trace.events[3], trace.events[2]] },
    trace => { trace.events[2].payload.sourceCallsite += '/foreign' }, trace => { trace.events[2].payload.actionOrdinal++ },
    trace => { trace.events[2].payload.completion = { kind: 'rejected', thrown: { kind: 'json', value: 'actual' } } }]) {
    const trace = structuredClone(original); mutate(trace); const wire = native('quickjs')
    await assert.rejects(replay('quickjs', wire, trace)); assert.equal(wire.calls.length, 0)
  }
})
test('all four fields of every post-checkpoint return execute exact original assertions independently of DOM', async () => {
  const values = snapshots(), methods = plan.steps.filter(step => step.kind === 'method.call')
  const results = () => values.map((value, at) => ({ route: plan.route, method: '_runE2E', sourceCallsite: methods[at].sourceCallsite, value: structuredClone(value) }))
  assert.equal(assertIssue1008Outputs(staticInputs(), { methodResults: results() }).assertionCoverage.length, 8)
  for (let at = 0; at < 5; at++) for (const field of ['blockResult', 'closureResult', 'count', 'parameterResult']) {
    const input = results(); input[at].value[field] = field === 'count' ? 999 : [999]
    assert.throws(() => assertIssue1008Outputs(staticInputs(), { methodResults: input }), /toEqual snapshot failed/)
  }
  for (let at = 0; at < 3; at++) { const input = staticInputs(); input.files.splice(at, 1); assert.throws(() => assertIssue1008Outputs(input, { methodResults: results() }), /coverage/) }
  for (const change of [input => input.pop(), input => input.reverse(), input => { input[1].sourceCallsite = readiness.sourceCallsite }, input => { input[4].value.extra = 1 }]) {
    const input = results(); change(input); assert.throws(() => assertIssue1008Outputs(staticInputs(), { methodResults: input }))
  }
})
test('wrong source/helper tuple, foreign internal Page and missing actual Page lookup cannot certify a result', async () => {
  for (const mutation of [program => { program.currentOverride = { ...program.page, path: plan.route, pageId: 999 } },
    program => { program.currentOverride = { ...program.page, path: 'pages/foreign/index', pageId: 42 } }]) {
    const p = passive(); await p.program.reLaunch('/' + plan.route); mutation(p.program)
    const token = p.collector.readinessStart({ session: p.program, page: p.program.page, route: plan.route, timeoutMs: 12000, startedAt: 1000, helperSha256: readiness.readinessHelperSha256 })
    await p.helper.routeMethod(p.program, '/' + plan.route, '_runE2E')
    assert.throws(() => p.collector.readinessEnd(token)); assert.throws(() => p.collector.flush())
  }
  const p = passive(); await p.program.reLaunch('/' + plan.route)
  const token = p.collector.readinessStart({ session: p.program, page: p.program.page, route: plan.route, timeoutMs: 12000, startedAt: 1000, helperSha256: readiness.readinessHelperSha256 })
  await p.collector.routePageMethod({ session: p.program, route: plan.route, method: '_runE2E', args: [], helperSha256: readiness.routeHelperSha256 }, async () => ({ count: 1 }))
  assert.throws(() => p.collector.readinessEnd(token), /Page acquisition/)
  const actual = instrumentGithubSharedRuntime(originalHelper, identity)
  for (const foreign of [{ ...identity, sourceSha256: '0'.repeat(64) }, { ...identity, caseSourcePath: identity.caseSourcePath + '.other' }, { ...identity, caseId: 'unknown' }]) {
    assert.equal(githubProducerCase(foreign), null); assert.equal(instrumentGithubSharedRuntime(originalHelper, foreign).includes('recordConformanceRoutePageMethod'), false)
  }
  assert.equal(actual.includes('recordConformanceRoutePageMethod'), true)
})
test('source deadline bounds readiness and prevents taps or checkpoints after failure', async () => {
  const trace = await passive().run(), wire = native('quickjs', { readinessSamples: Array.from({ length: 100 }, () => ({ count: 0 })) })
  let stamp = 1000; wire.readinessClock = () => stamp; wire.readinessWait = async () => { stamp += 4000 }
  await assert.rejects(replay('quickjs', wire, trace), /deadline|timed out/)
  assert.equal(wire.calls.filter(call => call.op === 'method.call').length, 4)
  assert.equal(wire.calls.some(call => ['tap', 'checkpoint'].includes(call.op)), false)
})
test('a final source helper rejection preserves the original thrown identity and cannot consume a successful result', async () => {
  for (const error of [new Error('source final rejection'), 'actual primitive', undefined]) {
    const p = passive({ finals: [{ throw: error }, ...snapshots().slice(1)] })
    await p.program.reLaunch('/' + plan.route)
    const token = p.collector.readinessStart({ session: p.program, page: p.program.page, route: plan.route,
      timeoutMs: 12000, startedAt: 1000, helperSha256: readiness.readinessHelperSha256 })
    await p.helper.routeMethod(p.program, '/' + plan.route, '_runE2E'); p.collector.readinessEnd(token)
    p.collector.checkpoint({ evidence: { id: 'initial', route: plan.route, nodes: groups(0) } }, { session: p.program, page: p.program.page })
    await assert.rejects(p.helper.routeMethod(p.program, '/' + plan.route, '_runE2E'), actual => actual === error)
    assert.equal(p.events.some(event => event.op === 'method.call'), false)
    assert.throws(() => p.collector.flush(), /incomplete/)
    assert.equal(p.calls.filter(call => call.op === 'method').length, 2)
  }
})
test('original route helper protocol branches, recovery, timeout, retry and source predicates retain exact function bytes', () => {
  const changed = instrumentGithubSharedRuntime(originalHelper, identity)
  const functions = text => {
    const tree = ts.createSourceFile('helper.ts', text, ts.ScriptTarget.Latest, true)
    return new Map(tree.statements.filter(ts.isFunctionDeclaration).map(node => [node.name?.text, node.getText(tree)]))
  }
  const original = functions(originalHelper), actual = functions(changed)
  for (const name of ['callRoutePageMethodWithOptions', 'relaunchPage', 'waitForCurrentPagePath', 'restartSharedMiniProgram']) {
    assert.ok(original.has(name), name); assert.equal(actual.get(name), original.get(name), name)
  }
  assert.equal(changed.split('return await recordConformanceRoutePageMethod(').length, 2)
  assert.equal(source.includes('return snapshot.count === 1'), true)
})
test('tap ambiguity or native result-owner substitution stops without replaying an action', async () => {
  const trace = await passive().run()
  for (const queryCount of [0, 2]) { const wire = native('quickjs', { queryCount }); await assert.rejects(replay('quickjs', wire, trace), /one actual rendered control/); assert.equal(wire.calls.filter(call => call.op === 'tap').length, 0) }
  for (const alter of [owner => { owner.engine = 'foreign' }, owner => { owner.pageId = '999' }, owner => { owner.sourceDeclaration.callsite += '/foreign' }]) {
    const wire = native('v8', { mutate(value, op) { if (op === 'method.call') alter(value.owner) } })
    await assert.rejects(replay('v8', wire, trace), /same-source/); assert.equal(wire.calls.filter(call => call.op === 'method.call').length, 1)
  }
})
