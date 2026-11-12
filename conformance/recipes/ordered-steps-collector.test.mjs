/** Synthetic provider contracts; no official, compiler, native, or UI evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollector } from './issue1013-collector.mjs'
import { descriptor } from './issue1013-descriptor.mjs'
import { createOrderedStepsCollector, projectCheckpoint, sourceAddress } from './ordered-steps-collector-core.mjs'

const plan = descriptor.plans[0], checkpoints = plan.steps.filter(step => step.kind === 'checkpoint')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const evidence = (index, count = 1) => ({ id: checkpoints[index].id, route: plan.route, nodes: checkpoints[index].queries.map(query => {
  const { fields, ...address } = structuredClone(query)
  return { ...address, count, nodes: Array.from({ length: count }, () => ({ ...(fields.text ? { text: 'actual rendered observation' } : {}),
    ...(fields.attributes.length ? { attributes: Object.fromEntries(fields.attributes.map(name => [name, 'actual attribute observation'])) } : {}) })) }
}) })
function fixture({ nativeTap, nativeQuery, reentrant = false } = {}) {
  const events = [], calls = [], cache = new Map(), result = { actualReturn: true }
  const element = selector => {
    if (!cache.has(selector)) cache.set(selector, { id: selector, tagName: 'view',
      async tap(...args) { calls.push({ op: 'tap', selector, args, receiver: this }); return nativeTap ? nativeTap(selector, this) : result },
      async $$(child) { return [element(child)] }, async $(child) { return element(child) } })
    return cache.get(selector)
  }
  const page = { path: plan.route, pageId: 7,
    async $(selector, ...args) { calls.push({ op: '$', selector, args, receiver: this }); return element(selector) },
    async $$(selector, ...args) {
      calls.push({ op: '$$', selector, args, receiver: this })
      if (nativeQuery) return nativeQuery(selector, element(selector))
      return reentrant ? [await this.$(selector)] : [element(selector)]
    },
    async waitForRendered() { return this.$$(plan.steps[1].address.selector) },
  }
  const program = { async currentPage() { return page }, async reLaunch() { return page } }
  const collector = createCollector({ emit: event => events.push(structuredClone(event)) })
  collector.attach(program)
  const setup = async () => { await program.reLaunch('/' + plan.route); await program.currentPage(); return page }
  const check = index => collector.checkpoint({ evidence: evidence(index) }, { session: program, page })
  const tap = async ordinal => { const nodes = await page.$$(plan.steps[ordinal === 0 ? 1 : 3].address.selector, { fallback: false, timeout: 5000 }); return nodes[0].tap() }
  return { program, page, collector, events, calls, cache, element, setup, check, tap, result }
}
async function finish(f) { await f.tap(0); f.check(1); await f.tap(1); f.check(2); f.collector.flush() }

test('1013 captures all ten groups, typed scope, two attributes and both actual taps in complete source order', async () => {
  const f = fixture(); await f.setup(); f.check(0); await finish(f)
  assert.deepEqual(f.events.map(event => event.op), ['route.active', 'dom.checkpoint', 'tap', 'dom.checkpoint', 'tap', 'dom.checkpoint'])
  assert.deepEqual(f.events.filter(event => event.op === 'tap').map(event => event.payload), [0, 1].map(actionOrdinal => ({
    planOrdinal: 0, actionOrdinal, route: plan.route, selector: plan.steps[actionOrdinal === 0 ? 1 : 3].address.selector, query: 'css' })))
  assert.deepEqual(f.events[1].payload.nodes[4].scope, [{ has: '#issue-1013-child' }])
  assert.equal(f.events.filter(event => event.op === 'dom.checkpoint').reduce((sum, event) => sum + event.payload.nodes.length, 0), 10)
  assert.equal(f.events.filter(event => event.op === 'dom.checkpoint').flatMap(event => event.payload.nodes).filter(group => group.nodes[0].attributes).length, 2)
  assert.equal(f.calls.filter(call => call.op === 'tap').length, 2)
  f.collector.flush()
})
test('the step machine covers zero, one and two actions without a per-case counter branch', async () => {
  for (const length of [1, 3, 5]) {
    const value = structuredClone(descriptor); value.plans[0].steps = value.plans[0].steps.slice(0, length)
    const page = { path: plan.route, pageId: 1, async $$(selector) { return [{ selector, async tap() { return selector } }] } }
    const program = { async currentPage() { return page } }, events = []
    const collector = createOrderedStepsCollector({ descriptor: value, emit: event => events.push(event) }); collector.attach(program); await program.currentPage()
    for (const step of value.plans[0].steps) {
      if (step.kind === 'tap') assert.equal(await (await page.$$(step.address.selector))[0].tap(), step.address.selector)
      else collector.checkpoint({ evidence: evidence(step.ordinal) }, { session: program, page })
    }
    collector.flush(); assert.equal(events.filter(event => event.op === 'tap').length, (length - 1) / 2)
  }
})
test('queries retain actual return/receiver/arguments and successful taps retain original return identity', async () => {
  const f = fixture(); await f.setup(); f.check(0)
  const options = { fallback: false, timeout: 5000 }, actual = f.element(plan.steps[1].address.selector)
  const nodes = await f.page.$$(plan.steps[1].address.selector, options)
  assert.equal(nodes[0], actual); assert.equal(f.calls.at(-1).receiver, f.page); assert.equal(f.calls.at(-1).args[0], options)
  assert.equal(await actual.tap(), f.result); f.check(1); assert.equal(await f.tap(1), f.result); f.check(2); f.collector.flush()
})
test('a rejected planned tap preserves its exact error and does not consume the action', async () => {
  const rejection = new Error('actual provider rejection'); let rejected = false
  const f = fixture({ nativeTap: () => { if (!rejected) { rejected = true; throw rejection }; return 'actual completion' } })
  await f.setup(); f.check(0)
  await assert.rejects(f.tap(0), error => error === rejection)
  assert.equal(f.events.filter(event => event.op === 'tap').length, 0)
  assert.equal(await f.tap(0), 'actual completion'); f.check(1); await f.tap(1); f.check(2); f.collector.flush()
})
test('missing, duplicated and reordered checkpoints and incomplete flush fail closed', async () => {
  for (const index of [1, 2]) { const f = fixture(); await f.setup(); assert.throws(() => f.check(index), /missing, duplicated or reordered/); assert.throws(() => f.collector.flush()) }
  const duplicate = fixture(); await duplicate.setup(); duplicate.check(0); assert.throws(() => duplicate.check(0), /missing, duplicated or reordered/)
  const missing = fixture(); await missing.setup(); missing.check(0); assert.throws(() => missing.collector.flush(), /coverage is incomplete/)
})
test('wrong selector, Page.$ acquisition, duplicate taps and cached pre-checkpoint handles cannot consume a scheduled action', async () => {
  for (const shape of ['wrong-selector', 'single-query', 'cached-before-checkpoint', 'duplicate-tap']) {
    const f = fixture(); await f.setup()
    const cached = shape === 'cached-before-checkpoint' ? (await f.page.$$(plan.steps[1].address.selector))[0] : undefined
    f.check(0)
    if (shape === 'wrong-selector') await (await f.page.$$('#wrong'))[0].tap()
    if (shape === 'single-query') await (await f.page.$(plan.steps[1].address.selector)).tap()
    if (shape === 'cached-before-checkpoint') await cached.tap()
    if (shape === 'duplicate-tap') { const node = (await f.page.$$(plan.steps[1].address.selector))[0]; await node.tap(); assert.equal(await node.tap(), f.result) }
    assert.throws(() => f.check(1), /successful tap lacks/); assert.throws(() => f.collector.flush())
  }
})
test('provider reentrant and readiness queries do not acquire an action or rename its canonical handle', async () => {
  const f = fixture({ reentrant: true }); await f.setup(); f.check(0)
  await f.tap(0); f.check(1); await f.tap(1); f.check(2); f.collector.flush()
  const readiness = fixture(); await readiness.setup(); readiness.check(0)
  const nodes = await readiness.page.waitForRendered()
  // No new wrapper is installed for an internal readiness-only acquisition.
  // Its successful unobserved tap cannot satisfy the source step.
  await nodes[0].tap(); assert.throws(() => readiness.check(1), /missing, duplicated or reordered/)
})
test('checkpoint aliases cannot rename a canonical acquisition in the same action interval', async () => {
  const f = fixture(); await f.setup(); f.check(0)
  const node = (await f.page.$$(plan.steps[1].address.selector))[0]
  // A trusted provider can return the same stable Element for an alias selector.
  f.cache.set('#alias', node)
  assert.equal((await f.page.$$('#alias'))[0], node)
  await f.page.waitForRendered()
  assert.equal(await node.tap(), f.result); f.check(1); await f.tap(1); f.check(2); f.collector.flush()
})
test('concurrent taps preserve both completions but cannot advance or publish an action', async () => {
  const wait = deferred(), f = fixture({ nativeTap: () => wait.promise }); await f.setup(); f.check(0)
  const node = (await f.page.$$(plan.steps[1].address.selector))[0], first = node.tap(), second = node.tap()
  wait.resolve(f.result); assert.deepEqual(await Promise.all([first, second]), [f.result, f.result])
  assert.equal(f.events.filter(event => event.op === 'tap').length, 0)
  assert.throws(() => f.check(1), /concurrent actual action/); assert.throws(() => f.collector.flush())
})
test('checkpoint/transport transitions during a public query reject, while its original result survives', async () => {
  for (const transition of ['checkpoint', 'launch', 'flush']) {
    const wait = deferred(), f = fixture({ nativeQuery: () => wait.promise }); await f.setup()
    const queried = f.page.$$('#pending'), actual = [f.element('#pending')]
    if (transition === 'checkpoint') assert.throws(() => f.check(0), /pending operation/)
    if (transition === 'launch') assert.equal(await f.program.reLaunch('/' + plan.route), f.page)
    if (transition === 'flush') assert.throws(() => f.collector.flush(), /coverage is incomplete/)
    wait.resolve(actual); assert.equal(await queried, actual)
    assert.throws(() => f.collector.flush())
  }
})
test('a pending tap cannot be adopted by a later checkpoint, page generation or transport', async () => {
  for (const transition of ['checkpoint', 'launch', 'transport']) {
    const wait = deferred(), f = fixture({ nativeTap: () => wait.promise }); await f.setup(); f.check(0)
    const tapped = f.tap(0); await Promise.resolve(); await Promise.resolve()
    if (transition === 'checkpoint') assert.throws(() => f.check(1), /pending operation/)
    if (transition === 'launch') await f.program.reLaunch('/' + plan.route)
    if (transition === 'transport') assert.throws(() => f.collector.attach({ async currentPage() { return f.page } }), /pending operation or source plan/)
    wait.resolve(f.result); assert.equal(await tapped, f.result); assert.equal(f.events.filter(event => event.op === 'tap').length, 0)
    assert.throws(() => f.collector.flush())
  }
})
test('transport Proxy aliases recover the actual owner and foreign Page/session aliases reject', async () => {
  const f = fixture(), proxy = new Proxy(f.program, {}); f.collector.attach(proxy); await proxy.currentPage()
  f.collector.checkpoint({ evidence: evidence(0) }, { session: proxy, page: f.page }); await finish(f)
  const other = fixture(); await other.setup()
  assert.throws(() => other.collector.checkpoint({ evidence: evidence(0) }, { session: {}, page: other.page }), /actual Page\/session/)
  const page = fixture(); await page.setup()
  assert.throws(() => page.collector.checkpoint({ evidence: evidence(0) }, { session: page.program, page: { ...page.page } }), /actual Page\/session/)
})
test('raw zero/multiple counts and divergent attribute types remain observations for the final diff', () => {
  for (const count of [0, 2]) {
    const raw = evidence(0, count).nodes, actual = projectCheckpoint(raw, checkpoints[0].queries)
    assert.deepEqual(actual, raw)
  }
  const raw = evidence(0).nodes; raw[3].nodes[0].attributes['data-title'] = null
  assert.equal(projectCheckpoint(raw, checkpoints[0].queries)[3].nodes[0].attributes['data-title'], null)
})
test('count-only queries retain every raw count and empty node projection without an expected count', async () => {
  for (const count of [0, 1, 3]) {
    const value = structuredClone(descriptor); value.plans[0].steps = [value.plans[0].steps[0]]
    value.plans[0].steps[0].queries = [{ selector: '#count-only', query: 'css', scope: [{ has: '#scope-descendant' }], fields: { text: false, attributes: [] } }]
    const page = { path: plan.route, pageId: 1 }, program = { async currentPage() { return page } }, events = []
    const collector = createOrderedStepsCollector({ descriptor: value, emit: event => events.push(event) }); collector.attach(program); await program.currentPage()
    const raw = { selector: '#count-only', query: 'css', scope: [{ has: '#scope-descendant' }], count, nodes: Array.from({ length: count }, () => ({})) }
    collector.checkpoint({ evidence: { id: 'initial', route: plan.route, nodes: [raw] } }, { session: program, page }); collector.flush()
    assert.deepEqual(events[1].payload.nodes, [raw])
  }
})
test('malformed actual route metadata cannot replace a successful tap return or its original error', async () => {
  for (const rejects of [false, true]) {
    const original = new Error('actual malformed-page rejection'), f = fixture({ nativeTap: () => { if (rejects) throw original; return 'actual success' } })
    await f.setup(); f.check(0); const node = (await f.page.$$(plan.steps[1].address.selector))[0]
    f.page.path = '../invalid'
    if (rejects) await assert.rejects(node.tap(), error => error === original)
    else assert.equal(await node.tap(), 'actual success')
    assert.throws(() => f.collector.flush(), /route is not canonical/)
  }
})
test('late provider callbacks lose the internal lineage after the originating operation settles', async () => {
  let complete, invokeLate
  const done = new Promise(resolve => { complete = resolve })
  const f = fixture({ nativeQuery(selector, element) {
    if (selector === '#origin') setTimeout(async () => { await invokeLate(); complete() }, 0)
    return [element]
  } })
  await f.setup(); invokeLate = () => f.page.$$('#late')
  await f.page.$$('#origin'); await done
  const late = f.collector.diagnostics().events.filter(event => event.phase === 'begin' && event.selector === '#late')
  assert.equal(late.length, 1); assert.equal(late[0].internal, false); assert.equal(late[0].parent, null)
  f.check(0); await finish(f)
})
test('typed addresses preserve ordered raw scopes/has and reject unsupported or expected fields', () => {
  const value = { selector: '#target', query: 'css', scope: ['#outer', { has: '#child' }], has: '#descendant' }
  assert.deepEqual(sourceAddress(value), value)
  for (const patch of [{ expected: 1 }, { count: 1 }, { scope: [{ has: '#child', expected: true }] }, { query: 'xpath' }, { scope: [null] }]) {
    assert.throws(() => sourceAddress({ ...value, ...patch }), /unsupported/)
  }
})
