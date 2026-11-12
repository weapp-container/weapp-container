/** Synthetic IPC contract probes only. Engine labels are not actual engine execution. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fixture, plan, selectors, pollOptions } from './issue1009-test-fixture.mjs'
import { descriptor } from './issue1009-descriptor.mjs'
import { expectedResults, expectedDomCheckpoints } from './issue1009-source-assertions.mjs'
import { encodeMethodValue } from './source-method-values.mjs'
import { issue1009ActionTape, replayIssue1009 } from '../../examples/hosts/conformance-desktop/issue1009-replay.mjs'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = () => ({ caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, files: descriptor.compiledFiles.map(path => {
  const bytes = Buffer.from('synthetic existence member'); return { path, bytes, length: bytes.length, sha256: hash(bytes) }
}) })
const trace = async (samples = [expectedResults]) => {
  const f = fixture({ samples }); await f.start(); await f.taps()
  await f.collector.sourcePoll(pollOptions, async () => {
    for (const sample of samples) { try { const result = await f.page.callMethod('_runE2E'); if (JSON.stringify(result) === JSON.stringify(expectedResults)) break } catch {} }
  })
  f.checkpoint('completed'); f.collector.flush(); return f.trace()
}
const startup = engine => ({ engine, sessionId: 'synthetic-issue1009-only' })
function native(engine, { samples = [expectedResults], queryCount = 1, mutate } = {}) {
  let stamp = 1000, methodAt = 0, checkpointAt = 0, taps = 0, pump = 0, action = 0, required = 0, revision = 1, pageId = 1, route = 'pages/home/index'
  const calls = []
  const proof = () => ({ kind: 'owner-pump-native-presentation-v1', sessionId: startup(engine).sessionId, route, pageId: String(pageId),
    templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision + 10), renderRevision: String(revision),
    presentationAckRevision: String(revision), actionSeq: String(action), ownerPumpSeq: String(pump), requiredPumpSeq: String(required), presented: true })
  const act = () => { action++; required = pump + 1; pump++; revision++ }
  const request = async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) }); pump++; let result
    if (op === 'render.settle') result = proof()
    else if (op === 'reLaunch') { route = payload.route.startsWith('/') ? payload.route.slice(1) : payload.route; pageId++; act(); result = { path: route, completion: proof() } }
    else if (op === 'currentPage') result = { path: route, pageId: String(pageId), completion: proof() }
    else if (op === 'checkpoint') { const value = expectedDomCheckpoints[checkpointAt++]; result = { id: value.id, route, nodes: value.nodes.map(({ selector, ...fields }) => ({ selector, query: 'css', count: 1, nodes: [fields] })), completion: proof() } }
    else if (op === 'query') result = { route, selector: payload.selector, count: queryCount,
      nodes: Array.from({ length: queryCount }, (_, index) => ({ id: 'actual/' + payload.selector + '/' + index, componentScopeId: null })),
      frameId: Number(proof().frameId), renderRevision: Number(proof().renderRevision), completion: proof() }
    else if (op === 'tap') { assert.equal(payload.selector, selectors[taps++]); const inputCompletion = proof(); act(); result = { route, selector: payload.selector,
      inputTransport: 'native-host-coordinate-event', x: 5, y: 7, frameId: Number(inputCompletion.frameId), renderRevision: Number(inputCompletion.renderRevision), inputCompletion, completion: proof() } }
    else if (op === 'method.call') {
      const index = methodAt++, item = samples[Math.min(index, samples.length - 1)]; act()
      const observation = item && Object.hasOwn(item, 'throw') ? { kind: 'rejected', ticket: 'unit/' + index,
        reason: item.throw === undefined ? { kind: 'undefined' } : { kind: 'json', value: item.throw } } : { kind: 'fulfilled', ticket: 'unit/' + index, value: encodeMethodValue(item) }
      result = { kind: 'native-guest-method-result-v1', owner: { kind: 'source-labelled-native-method-owner-v1', engine, sessionId: startup(engine).sessionId,
        sourceInvocationId: payload.sourceInvocationId, sourceDeclaration: structuredClone(payload.source), sourceDeclarationTrust: 'caller-declared-not-official-oracle',
        route, pageId: String(pageId), originalDeadlineNs: payload.deadlineNs, deadlineClock: 'original-unix-deadline-plus-once-anchored-monotonic-budget',
        sessionBeginAttempts: 1, sessionPollAttempts: 2, requestSha256: 'a'.repeat(64), receiverTokenSha256: 'b'.repeat(64) }, observation, completion: proof() }
    } else throw new Error('Unplanned synthetic op: ' + op)
    return mutate?.(result, op, payload) ?? result
  }
  return { request, calls, readinessClock: () => stamp, readinessWait: async ms => { stamp += ms } }
}
const replay = (engine, wire, oracleTrace) => replayIssue1009({ ...wire, startup: startup(engine), oracleTrace, staticInputs: inputs() })
test('both synthetic engine transports preserve all six taps, full attempt/final trace and actual six fields', async () => {
  const oracle = await trace()
  for (const engine of ['quickjs', 'v8']) {
    const wire = native(engine), result = await replay(engine, wire, oracle)
    assert.deepEqual(result.events, oracle.events); assert.equal(result.methodFacts.length, 1)
    assert.equal(wire.calls.filter(call => call.op === 'tap').length, 6)
    assert.equal(wire.calls.filter(call => call.op === 'query').length, 6)
    assert.equal(result.staticCoverage.originalRuntimeFields, 6)
    for (const call of wire.calls.filter(call => call.op === 'method.call')) {
      assert.deepEqual(Object.keys(call.payload).sort(), ['args', 'deadlineNs', 'method', 'route', 'source', 'sourceInvocationId'])
      for (const expected of Object.values(expectedResults)) assert.ok(!JSON.stringify(call.payload).includes('"' + expected + '"'))
    }
  }
})
test('actual native rejection/incorrect result drive retries; oracle attempt count and values do not drive IPC', async () => {
  const samples = [{ throw: 'not-ready' }, { ...expectedResults, nested: 'pending' }, expectedResults], oracle = await trace(samples)
  const wire = native('quickjs', { samples }), result = await replay('quickjs', wire, oracle)
  assert.deepEqual(result.events, oracle.events); assert.equal(result.methodFacts.length, 3)
  const one = native('quickjs'), fast = await replay('quickjs', one, oracle)
  assert.deepEqual(fast.events, oracle.events); assert.equal(fast.sourcePollJournal.attempts.length, 1)
  assert.equal(result.sourcePollJournal.attempts.length, 3)
  assert.equal(one.calls.filter(call => call.op === 'method.call').length, 1)
})
test('legacy native selector adapter fails closed on ambiguous concrete targets without inventing source assertions', async () => {
  const oracle = await trace(), wire = native('quickjs', { queryCount: 2 })
  await assert.rejects(replay('quickjs', wire, oracle), /unique current actual acquisition/)
})
test('missing/duplicate/reordered/substituted final completion rejects before IPC', async () => {
  const original = await trace()
  for (const change of [events => events.splice(8, 1), events => events.splice(8, 0, structuredClone(events[8])),
    events => events[8].payload.actionOrdinal++, events => events[8].payload.method = 'different',
    events => events[8].payload.completion.value.value.event = 'forged', events => events[8].payload.attempts = 1,
    events => events[8].payload.sourceCallsite = 'other:94']) {
    const oracle = structuredClone(original); change(oracle.events); oracle.events.forEach((event, at) => { event.seq = at })
    const wire = native('quickjs'); await assert.rejects(replay('quickjs', wire, oracle), /Source-plan/); assert.equal(wire.calls.length, 0)
  }
})
test('bad native provenance, missing control, actual mismatch and deadline cannot become a passed replay', async () => {
  const oracle = await trace()
  const bad = native('quickjs', { mutate: (result, op) => { if (op === 'method.call') result.owner.sourceInvocationId = 'foreign'; return result } })
  await assert.rejects(replay('quickjs', bad, oracle), /same-source/)
  assert.equal(bad.calls.filter(call => call.op === 'method.call').length, 1)
  const missing = native('quickjs', { queryCount: 0 }); await assert.rejects(replay('quickjs', missing, oracle), /no actual rendered control/)
  const wrong = native('quickjs', { samples: [{ ...expectedResults, control: 'wrong' }] })
  await assert.rejects(replay('quickjs', wrong, oracle), /deadline elapsed/)
  assert.equal(wrong.calls.filter(call => call.op === 'tap').length, 6)
})
test('tape contains only original addresses/options and preserves Page.$ semantics explicitly', async () => {
  const tape = issue1009ActionTape(await trace())
  assert.deepEqual(tape.filter(step => step.op === 'tap').map(step => [step.queryMethod, step.queryOptions]), Array(6).fill(['$', { timeout: 2000 }]))
  assert.equal(tape.filter(step => step.op === 'method.poll').length, 1)
  assert.ok(!JSON.stringify(tape).includes('completion'))
})
