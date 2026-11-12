/** Synthetic negative contracts for passive source observation. No actual provider/receipt claims. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, selectors, pollOptions } from './issue1009-test-fixture.mjs'
import { expectedResults, assertIssue1009DomEvidence, assertIssue1009MethodResult } from './issue1009-source-assertions.mjs'
import { decodeMethodValue } from './source-method-values.mjs'
const beforePoll = async options => { const f = fixture(options); await f.start(); await f.taps(); return f }
const successful = async f => f.collector.sourcePoll(pollOptions, async () => { await f.page.callMethod('_runE2E') })
const finish = f => { f.checkpoint('completed'); f.collector.flush() }
test('six exact single-element acquisitions, actual taps and final six-field method are observed', async () => {
  const f = await beforePoll(); await successful(f); finish(f)
  assert.deepEqual(f.calls.filter(call => call.op === '$').map(call => call.selector), selectors)
  assert.equal(f.calls.filter(call => call.op === '$$').length, 0)
  assert.equal(f.calls.filter(call => call.op === 'tap').length, 6)
  assert.deepEqual(f.events.map(event => event.op), ['route.active', 'dom.checkpoint', ...Array(6).fill('tap'), 'method.poll', 'dom.checkpoint'])
  const result = f.events.find(event => event.op === 'method.poll')
  assertIssue1009MethodResult([{ route: result.payload.route, method: result.payload.method, sourceCallsite: result.payload.sourceCallsite, value: decodeMethodValue(result.payload.completion.value) }])
  assertIssue1009DomEvidence(f.events.filter(event => event.op === 'dom.checkpoint').map(event => event.payload))
})
test('Page.$ internal fallback remains owned by provider and cannot add a duplicate observed query or tap', async () => {
  const f = await beforePoll({ fallback: true }); await successful(f); finish(f)
  assert.equal(f.calls.filter(call => call.op === '$$').length, 6)
  assert.equal(f.events.filter(event => event.op === 'tap').length, 6)
})
test('rejected and incorrect actual attempts remain ordered; only original successful matcher scope advances', async () => {
  const thrown = { private: 'error identity' }, f = await beforePoll({ samples: [{ throw: thrown }, { ...expectedResults, event: 'not yet' }, expectedResults] })
  const original = 'original matcher return'
  const result = await f.collector.sourcePoll(pollOptions, async () => {
    await assert.rejects(f.page.callMethod('_runE2E'), error => error === thrown)
    assert.equal((await f.page.callMethod('_runE2E')).event, 'not yet')
    assert.deepEqual(await f.page.callMethod('_runE2E'), expectedResults)
    return original
  })
  assert.equal(result, original); finish(f)
  const attempts = f.collector.diagnostics().pollAttempts
  assert.deepEqual(attempts.map(event => event.attemptOrdinal), [0, 1, 2])
  assert.deepEqual(attempts.map(event => event.completion.kind), ['rejected', 'fulfilled', 'fulfilled'])
  assert.equal(f.events.filter(event => event.op === 'method.poll').length, 1)
  assert.equal(Object.hasOwn(f.events.find(event => event.op === 'method.poll').payload, 'attempts'), false)
})
test('provider rejection identity, null and receiver behavior survive invalid acquisition observation', async () => {
  const rejection = new Error('original query error'), f = fixture({ onQuery: async () => { throw rejection } }); await f.start()
  await assert.rejects(f.page.$(selectors[0], { timeout: 2000 }), error => error === rejection)
  assert.throws(() => f.collector.flush(), /coverage is incomplete/)
  const absent = fixture({ queryNull: true }); await absent.start(); assert.equal(await absent.page.$(selectors[0], { timeout: 2000 }), null)
  assert.throws(() => absent.collector.flush(), /coverage is incomplete/)
})
test('single query rejects changed options, duplicated acquisition and $$ substitute without changing provider return', async () => {
  for (const mode of ['options', 'duplicate', 'array']) {
    const f = fixture(); await f.start()
    let control
    if (mode === 'array') control = (await f.page.$$(selectors[0], { timeout: 2000 }))[0]
    else { control = await f.page.$(selectors[0], { timeout: mode === 'options' ? 3000 : 2000 }); if (mode === 'duplicate') assert.equal(await f.page.$(selectors[0], { timeout: 2000 }), control) }
    assert.equal(control, f.element(selectors[0])); await control.tap()
    assert.equal(f.calls.filter(call => call.op === 'tap').length, 1)
    assert.throws(() => f.collector.flush(), /source query options|acquisition|unique actual/)
  }
})
test('poll defaults override is rejected after preserving actual callback/result', async () => {
  for (const patch of [{ intervalMs: 1 }, { timeoutMs: 9000 }, { matcher: 'toBe' }]) {
    const f = await beforePoll(); const value = await f.collector.sourcePoll({ ...pollOptions, ...patch }, async () => { await f.page.callMethod('_runE2E'); return 'original' })
    assert.equal(value, 'original'); assert.throws(() => f.collector.flush(), /defaults|overridden/)
  }
})
test('no calls, wrong result and original assertion rejection cannot publish final poll evidence', async () => {
  for (const mode of ['no-calls', 'wrong-result', 'reject']) {
    const f = await beforePoll({ samples: [{ ...expectedResults, nested: 'wrong' }] }), error = new Error('actual matcher error')
    const invoke = async () => { if (mode !== 'no-calls') await f.page.callMethod('_runE2E'); if (mode === 'reject') throw error }
    if (mode === 'reject') await assert.rejects(f.collector.sourcePoll(pollOptions, invoke), value => value === error)
    else await f.collector.sourcePoll(pollOptions, invoke)
    assert.equal(f.events.some(event => event.op === 'method.poll'), false)
    assert.throws(() => f.collector.flush(), /original expect.poll/)
  }
})
test('out-of-scope method, changed route/method and deadline completion fail closed', async () => {
  for (const mode of ['no-scope', 'route', 'method', 'deadline']) {
    const f = await beforePoll()
    const invoke = async () => {
      if (mode === 'route') f.page.path = 'pages/other/index'
      const value = await f.page.callMethod(mode === 'method' ? 'different' : '_runE2E')
      if (mode === 'deadline') f.setClock(11001)
      return value
    }
    if (mode === 'no-scope') await invoke(); else await f.collector.sourcePoll(pollOptions, invoke)
    assert.throws(() => f.collector.flush(), /poll method|original expect.poll/)
    assert.equal(f.events.some(event => event.op === 'method.poll'), false)
  }
})
test('concurrent methods, nested scopes and pending completion cannot consume one poll step', async () => {
  for (const mode of ['concurrent', 'nested', 'pending']) {
    let resolve; const gate = new Promise(done => { resolve = done })
    const f = await beforePoll({ onMethod: async () => { await gate; return expectedResults } })
    await f.collector.sourcePoll(pollOptions, async () => {
      if (mode === 'nested') { await f.collector.sourcePoll(pollOptions, async () => {}); return }
      const first = f.page.callMethod('_runE2E')
      if (mode === 'concurrent') { const second = f.page.callMethod('_runE2E'); resolve(); await Promise.all([first, second]) }
      else { resolve(); if (mode !== 'pending') await first }
    })
    resolve(); await gate; await Promise.resolve(); assert.throws(() => f.collector.flush(), /poll|concurrent/)
  }
})
