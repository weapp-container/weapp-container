import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollector } from './template-multi-platform-collector.mjs'
import { descriptor } from './template-multi-platform-descriptor.mjs'

const initialId = '/pages/index/index:initial', updatedId = 'index:increment'
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const observation = (id, label = 'arbitrary actual text') => ({ evidence: { id, route: '/pages/index/index',
  source: 'synthetic-unit-only', capturedAt: 'synthetic-unit-only', nodes: descriptor.checkpoints[0].queries.map((query, index) => ({
    ...structuredClone(query), query: 'css', count: 1, nodes: [{ text: `${label} ${index}` }],
  })) } })

function session({ tapFailure, queryFailure, tapResult = { original: true }, own = false, emitFailure } = {}) {
  const events = [], operations = [], originals = [], outputs = []
  const collector = createCollector({ emit: event => { if (emitFailure && event.op === 'tap') throw emitFailure; events.push(event) } })
  const remember = (object, keys) => {
    for (const key of keys) originals.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key), value: object[key] })
    return object
  }
  const element = (selector, scope) => remember({
    async $$(child, ...args) { operations.push({ op: 'child.query', receiver: this, selector: child, args }); const result = [element(child, [...scope, selector])]; outputs.push(result); return result },
    async tap(...args) { operations.push({ op: 'tap', receiver: this, selector, scope, args }); if (tapFailure) throw tapFailure; return tapResult },
  }, ['$$', 'tap'])
  let pageId = 1
  const page = () => remember({ path: descriptor.route, pageId,
    async $$(selector, ...args) {
      operations.push({ op: 'query', receiver: this, selector, args }); if (queryFailure) throw queryFailure
      const result = selector === '#absent' ? [] : [element(selector, [])]; outputs.push(result); return result
    },
  }, ['$$'])
  let current = page()
  const methods = {
    async currentPage(...args) { operations.push({ op: 'currentPage', receiver: this, args }); return current },
    async reLaunch(route, ...args) { operations.push({ op: 'reLaunch', receiver: this, route, args }); pageId++; current = page(); current.path = route.replace(/^\//, ''); return current },
  }
  const program = own ? {} : Object.create(methods)
  if (own) for (const [key, value] of Object.entries(methods)) Object.defineProperty(program, key, { configurable: true, writable: false, enumerable: true, value })
  remember(program, ['currentPage', 'reLaunch'])
  collector.attach(program)
  const check = (id, page, value = observation(id)) => collector.checkpoint(value, { session: program, page })
  return { collector, program, events, operations, originals, outputs, tapResult, check }
}
async function complete(s, acquisition = 'currentPage') {
  const page = await s.program[acquisition]('/' + descriptor.route)
  s.check(initialId, page)
  const result = await page.$$('#increment-button', { fallback: false, timeout: 5000 })
  assert.equal(result, s.outputs.at(-1))
  assert.equal(await result[0].tap({ originalGesture: true }), await s.tapResult)
  s.check(updatedId, page, observation(updatedId, 'different actual text'))
  s.collector.flush()
  return page
}

test('observes current warmup reuse or reLaunch and original $$ array/tap results without driving the provider', async () => {
  for (const acquisition of ['currentPage', 'reLaunch']) {
    const s = session(); assert.deepEqual(s.operations, []); await complete(s, acquisition)
    assert.deepEqual(s.operations.map(item => item.op), [acquisition, 'query', 'tap'])
    assert.deepEqual(s.events.map(event => event.op), ['route.active', 'dom.checkpoint', 'tap', 'dom.checkpoint'])
    assert.deepEqual(s.events[1].payload.nodes[3].scope, ['#platform-card-host'])
    assert.equal(s.events[1].payload.nodes[0].nodes[0].text, 'arbitrary actual text 0')
    assert.equal(s.events[3].payload.nodes[4].nodes[0].text, 'different actual text 4')
    assert.ok(!JSON.stringify(s.events).includes('MP_PLATFORM=weapp'))
  }
})

test('retains actual count zero and multiple nodes, clones strings/scopes and restores exact provider descriptors', async () => {
  const s = session({ own: true }), page = await s.program.currentPage(), value = observation(initialId)
  value.evidence.nodes[0] = { selector: '.page-heading__title', query: 'css', count: 0, nodes: [] }
  value.evidence.nodes[3].count = 2; value.evidence.nodes[3].nodes.push({ text: 'second real scoped node' })
  s.check(initialId, page, value)
  value.evidence.nodes[3].scope[0] = '#changed'; value.evidence.nodes[3].nodes[0].text = 'changed'
  await (await page.$$('#increment-button'))[0].tap()
  s.check(updatedId, page); s.collector.flush(); s.collector.flush()
  assert.deepEqual(s.events[1].payload.nodes.map(node => node.count), [0, 1, 1, 2, 1])
  assert.deepEqual(s.events[1].payload.nodes[3].scope, ['#platform-card-host'])
  assert.equal(s.events[1].payload.nodes[3].nodes[0].text, 'arbitrary actual text 3')
  for (const { object, key, descriptor, value } of s.originals) { assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor); assert.equal(object[key], value) }
  assert.equal(Object.getOwnPropertySymbols(s.program).length, 0)
})

test('missing/reordered/duplicate checkpoints, missing/extra taps and scoped actions fail closed without replacing results', async () => {
  for (const kind of ['missing', 'reordered', 'duplicate', 'no-tap', 'extra-tap', 'early-tap', 'scoped-tap']) {
    const s = session(), page = await s.program.currentPage()
    if (kind === 'missing') { assert.throws(() => s.collector.flush(), /incomplete/); continue }
    if (kind === 'reordered') assert.throws(() => s.check(updatedId, page), /order/)
    else if (kind === 'early-tap') assert.equal(await (await page.$$('#increment-button'))[0].tap(), s.tapResult)
    else {
      s.check(initialId, page)
      if (kind === 'duplicate') assert.throws(() => s.check(initialId, page), /duplicated/)
      else if (kind === 'no-tap') assert.throws(() => s.check(updatedId, page), /successful tap/)
      else {
        const button = kind === 'scoped-tap' ? (await (await page.$$('#platform-card-host'))[0].$$('#increment-button'))[0] : (await page.$$('#increment-button'))[0]
        assert.equal(await button.tap(), s.tapResult)
        if (kind === 'extra-tap') assert.equal(await button.tap(), s.tapResult)
      }
    }
    assert.throws(() => s.collector.flush(), /checkpoint|scope|tap|order/)
  }
})

test('actual query route, selector, scope and required text fields cannot be supplied by the descriptor', async () => {
  for (const mutate of [
    value => { value.evidence.route = 'pages/other/index' },
    value => { value.evidence.nodes.reverse() },
    value => { value.evidence.nodes[3].scope = [] },
    value => { value.evidence.nodes[0].scope = null },
    value => { value.evidence.nodes[3].scope = [{ has: '.platform-card__value' }] },
    value => { value.evidence.nodes[0].query = 'xpath' },
    value => { delete value.evidence.nodes[0].nodes[0].text },
    value => { value.evidence.nodes[0].count = 2 },
    value => { delete value.evidence.nodes[0] },
  ]) {
    const s = session(), page = await s.program.currentPage(), value = observation(initialId)
    mutate(value); assert.throws(() => s.check(initialId, page, value)); assert.deepEqual(s.events, []); assert.throws(() => s.collector.flush())
  }
})

test('old pages and a pending tap cannot cross a new generation or retroactively use an initial checkpoint', async () => {
  for (const scenario of ['old-page', 'pending-tap', 'early-pending']) {
    const pending = deferred(), s = session({ tapResult: scenario === 'old-page' ? { original: true } : pending.promise })
    const page = await s.program.currentPage()
    if (scenario !== 'early-pending') s.check(initialId, page)
    if (scenario === 'old-page') await s.program.reLaunch('/' + descriptor.route)
    const tap = (await page.$$('#increment-button'))[0].tap()
    if (scenario === 'early-pending') s.check(initialId, page)
    else if (scenario === 'pending-tap') await s.program.reLaunch('/' + descriptor.route)
    if (scenario !== 'old-page') pending.resolve({ originalDelayed: true })
    assert.equal(await tap, await s.tapResult)
    assert.equal(s.events.filter(event => event.op === 'tap').length, 0)
    assert.throws(() => s.collector.flush(), /generation|page|interval/)
  }
})

test('reconnection before first checkpoint binds its current transport; a stale transport cannot complete a later checkpoint', async () => {
  const events = [], collector = createCollector({ emit: event => events.push(event) })
  const makeProgram = () => { const page = { path: descriptor.route, async $$() { return [{ async tap() { return true } }] } }; return { async currentPage() { return page } } }
  const first = makeProgram(), second = makeProgram(); collector.attach(first); await first.currentPage(); collector.attach(second)
  const page = await second.currentPage(); collector.checkpoint(observation(initialId), { session: second, page })
  await (await page.$$('#increment-button'))[0].tap()
  assert.throws(() => collector.checkpoint(observation(updatedId), { session: first, page }), /session/)
  assert.throws(() => collector.flush(), /session/)
  assert.equal(Object.getOwnPropertySymbols(first).length, 0); assert.equal(Object.getOwnPropertySymbols(second).length, 0)
})

test('original query/tap errors keep their exact identity and failure cleanup preserves external replacement', async () => {
  for (const op of ['query', 'tap']) {
    const error = new Error('original-' + op), s = session({ [op + 'Failure']: error }), page = await s.program.currentPage()
    s.check(initialId, page)
    if (op === 'query') await assert.rejects(page.$$('#increment-button'), caught => caught === error)
    else await assert.rejects((await page.$$('#increment-button'))[0].tap(), caught => caught === error)
    assert.equal(s.events.filter(event => event.op === 'tap').length, 0); assert.throws(() => s.collector.flush(), /incomplete/)
  }
  const s = session(), page = await s.program.currentPage(), result = await page.$$('#increment-button'), replacement = async () => 'external'
  result[0].tap = replacement; assert.throws(() => s.collector.flush(), /incomplete/); assert.equal(result[0].tap, replacement)
})

test('a failing action sink preserves the completed original tap result, stays sticky and restores wrappers', async () => {
  const error = new Error('synthetic sink failure'), s = session({ emitFailure: error }), page = await s.program.currentPage()
  s.check(initialId, page)
  assert.equal(await (await page.$$('#increment-button'))[0].tap(), s.tapResult)
  assert.throws(() => s.collector.flush(), caught => caught === error)
  assert.throws(() => s.collector.flush(), caught => caught === error)
  for (const { object, key, descriptor } of s.originals) assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
})
