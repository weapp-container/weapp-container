/** Synthetic provider operations only; no compiler/SDK/UI or admission. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { descriptor as item } from './subpackage-item-descriptor.mjs'
import { descriptor as user } from './subpackage-user-descriptor.mjs'
import { createCollector as itemCollector } from './subpackage-item-collector.mjs'
import { createCollector as userCollector } from './subpackage-user-collector.mjs'

const cases = [[item, itemCollector], [user, userCollector]]
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const evidence = (descriptor, ordinal, groups) => ({ evidence: { id: 'initial', route: descriptor.plans[ordinal].route,
  source: 'synthetic-test-only', capturedAt: 'ignored-test-clock', nodes: groups ?? descriptor.plans[ordinal].checkpoints[0].queries.map((query, index) => ({
    selector: query.selector, query: 'css', count: 2, nodes: [{ text: `actual ${ordinal}/${index}/A`, ignored: 'unused field' }, { text: `actual ${ordinal}/${index}/B` }],
  })) } })
function session(descriptor, createCollector, { launchFailure, queryFailure, tapFailure, emitFailure, ownDescriptors = false } = {}) {
  const operations = [], events = [], originals = [], collector = createCollector({ emit(event) { if (emitFailure) throw emitFailure; events.push(event) },
    context: { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256 } })
  const remember = (target, keys) => {
    for (const key of keys) originals.push({ target, key, own: Object.getOwnPropertyDescriptor(target, key), value: target[key] })
    return target
  }
  let nextId = 40
  const element = () => remember(Object.create({
    async $() { operations.push({ op: 'child.$', receiver: this }); return element() },
    async $$() { operations.push({ op: 'child.$$', receiver: this }); return [element()] },
    async tap(...args) { operations.push({ op: 'tap', receiver: this, args }); if (tapFailure) throw tapFailure; return { actual: 'tap-result' } },
    async text() { operations.push({ op: 'text', receiver: this }); return 'actual provider text' },
  }), ['$', '$$', 'tap'])
  const makePage = (route = descriptor.plans[0].route, pageId = ++nextId) => remember(Object.assign(Object.create({
    async $(selector, ...args) { operations.push({ op: '$', receiver: this, selector, args }); if (queryFailure) throw queryFailure; return element() },
    async $$(selector, ...args) { operations.push({ op: '$$', receiver: this, selector, args }); if (queryFailure) throw queryFailure; return [element(), element()] },
  }), { path: route, pageId }), ['$', '$$'])
  let page = makePage()
  const methods = {
    async currentPage(...args) { operations.push({ op: 'currentPage', receiver: this, args }); return page },
    async reLaunch(requested, ...args) { operations.push({ op: 'reLaunch', receiver: this, requested, args }); if (launchFailure) throw launchFailure; page = makePage(requested.replace(/^\//, '')); return page },
  }
  const program = ownDescriptors ? {} : Object.create(methods)
  if (ownDescriptors) for (const [key, value] of Object.entries(methods)) Object.defineProperty(program, key, { configurable: true, enumerable: true, writable: false, value })
  remember(program, ['currentPage', 'reLaunch']); const symbols = Object.getOwnPropertySymbols(program)
  collector.attach(program)
  return { descriptor, collector, program, operations, events, originals, symbols, makePage,
    select(next) { page = next }, page: () => page }
}
const check = (s, ordinal, page, value = evidence(s.descriptor, ordinal), program = s.program) => s.collector.checkpoint(value, { session: program, page })
async function complete(s, acquisition = 'reLaunch') {
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    if (acquisition === 'currentPage') s.select(s.makePage(s.descriptor.plans[ordinal].route))
    const page = await s.program[acquisition](...(acquisition === 'reLaunch' ? ['/' + s.descriptor.plans[ordinal].route] : [{ appFunctionFallback: false }]))
    check(s, ordinal, page)
  }
  s.collector.flush()
}

test('exact pinned sources retain two original it bodies, two routes, duplicate initial ids and three complete text queries', async () => {
  for (const [descriptor] of cases) {
    const bytes = await readFile(new URL('../../vendor/weapp-vite/' + descriptor.caseSourcePath, import.meta.url))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sourceSha256)
    const source = ts.createSourceFile('original.ts', bytes.toString(), ts.ScriptTarget.Latest, true), tests = [], plans = []
    const walk = node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'it') tests.push(node.arguments[0].text)
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'createDomAcceptance') {
        const object = node.arguments[2].elements[0], read = name => object.properties.find(p => p.name.getText(source) === name).initializer
        const queries = read('nodes').elements.map(node => node.properties.find(p => p.name.getText(source) === 'selector').initializer.text)
        plans.push({ id: read('id').text, route: read('route').text.replace(/^\//, ''), queries })
      }
      ts.forEachChild(node, walk)
    }; walk(source)
    assert.deepEqual(tests, descriptor.plans.map(p => p.test))
    assert.deepEqual(plans, descriptor.plans.map(p => ({ id: p.checkpoints[0].id, route: p.route, queries: p.checkpoints[0].queries.map(q => q.selector) })))
    assert.equal(plans.length, 2); assert.equal(plans.flatMap(p => p.queries).length, 3)
    assert.deepEqual(descriptor.plans.map(p => p.actions), [[], []])
    const encoded = JSON.stringify(descriptor)
    for (const expected of ['ITEM:ready:instance', 'USER:ready:instance', 'issue317ItemNpmReady', 'Issue317 user npm ready', 'item-login-required:issue-340:shared', 'user-register-form:issue-340:shared']) assert.equal(encoded.includes(expected), false)
  }
})

for (const [descriptor, createCollector] of cases) {
  const name = descriptor.caseId
  test(name + ': zero actions complete via actual reLaunch or currentPage without driving provider calls', async () => {
    for (const acquisition of ['reLaunch', 'currentPage']) {
      const s = session(descriptor, createCollector); assert.deepEqual(s.operations, []); await complete(s, acquisition)
      assert.deepEqual(s.operations.map(o => o.op), [acquisition, acquisition])
      assert.deepEqual(s.events.map(e => e.op), ['route.active', 'dom.checkpoint', 'route.active', 'dom.checkpoint'])
      const renders = s.events.filter(e => e.kind === 'render')
      assert.deepEqual(renders.map(e => [e.payload.planOrdinal, e.payload.checkpointOrdinal, e.payload.id, e.payload.route]),
        descriptor.plans.map((p, ordinal) => [ordinal, ordinal, 'initial', p.route]))
      assert.deepEqual(renders[0].payload.nodes[0].nodes, [{ text: 'actual 0/0/A' }, { text: 'actual 0/0/B' }])
      assert.equal(JSON.stringify(s.events).includes('ignored-test-clock'), false)
      assert.equal(JSON.stringify(s.events).includes('unused field'), false)
      assert.equal(JSON.stringify(s.events).includes('taskId'), false)
    }
  })
  test(name + ': preserves context, args, guest values and snapshots complete actual node arrays', async () => {
    const s = session(descriptor, createCollector), options = { appFunctionFallback: false }, page = await s.program.currentPage(options)
    const queryOptions = { fallback: false, timeout: 7 }, result = await page.$$('.issue317-message', queryOptions)
    assert.equal(result.length, 2)
    const value = evidence(descriptor, 0); check(s, 0, page, value); value.evidence.nodes[0].nodes[0].text = 'mutated later'
    assert.equal(s.events[1].payload.nodes[0].nodes[0].text, 'actual 0/0/A')
    assert.equal(s.operations[0].receiver, s.program); assert.equal(s.operations[0].args[0], options)
    assert.equal(s.operations[1].receiver, page); assert.equal(s.operations[1].args[0], queryOptions)
    const second = await s.program.reLaunch('/' + descriptor.plans[1].route); check(s, 1, second); s.collector.flush()
  })
  test(name + ': forwarding session proxy and same pageId aliases retain actual owner', async () => {
    const s = session(descriptor, createCollector), page = await s.program.currentPage(), proxy = new Proxy(s.program, { get: Reflect.get })
    const alias = s.makePage(page.path, page.pageId); s.select(alias); await proxy.currentPage({ appFunctionFallback: false })
    check(s, 0, page, undefined, proxy)
    const second = await proxy.reLaunch('/' + descriptor.plans[1].route); check(s, 1, second, undefined, proxy); s.collector.flush()
    assert.deepEqual(Object.getOwnPropertySymbols(s.program), s.symbols)
  })
  test(name + ': rejects checkpoint route/id/order, cross-owner/context and unobserved Page identities', async () => {
    for (const variant of ['route', 'id', 'order', 'session', 'page', 'unobserved']) {
      const s = session(descriptor, createCollector), page = await s.program.currentPage(), value = evidence(descriptor, 0)
      if (variant === 'route') value.evidence.route = descriptor.plans[1].route
      if (variant === 'id') value.evidence.id = 'different'
      if (variant === 'order') value.evidence.nodes = evidence(descriptor, 1).evidence.nodes
      const context = variant === 'session' ? {} : s.program
      assert.throws(() => check(s, 0, variant === 'page' || variant === 'unobserved' ? s.makePage(page.path, page.pageId) : page, value, context), /checkpoint|selector|query/)
      assert.throws(() => s.collector.flush())
    }
  })
  test(name + ': missing, duplicated or reversed plans cannot satisfy duplicate initial ids', async () => {
    const empty = session(descriptor, createCollector); assert.throws(() => empty.collector.flush(), /incomplete/)
    const s = session(descriptor, createCollector), page = await s.program.currentPage(); check(s, 0, page)
    assert.throws(() => check(s, 0, page), /Page|route/); assert.throws(() => s.collector.flush())
    const reversed = session(descriptor, createCollector), wrong = await reversed.program.reLaunch('/' + descriptor.plans[1].route)
    assert.throws(() => check(reversed, 1, wrong), /Page|route/); assert.throws(() => reversed.collector.flush())
  })
  test(name + ': complete query shape rejects missing/duplicate/changed selectors, scopes, counts and text', async () => {
    for (const mutate of [v => v.nodes.pop(), v => v.nodes.push(v.nodes[0]), v => { v.nodes[0].selector = '.other' },
      v => { v.nodes[0].query = 'xpath' }, v => { v.nodes[0].scope = ['component'] }, v => { v.nodes[0].has = 'text' },
      v => { v.nodes[0].count++ }, v => { delete v.nodes[0].nodes[0].text }, v => { v.nodes[0].nodes[0].text = 7 }]) {
      const s = session(descriptor, createCollector), page = await s.program.currentPage(), value = evidence(descriptor, 0); mutate(value.evidence)
      assert.throws(() => check(s, 0, page, value), /selector|query|text/); assert.throws(() => s.collector.flush())
    }
  })
  test(name + ': unexpected successful business tap poisons empty-action coverage without replacing guest completion', async () => {
    for (const query of ['$', '$$']) {
      const s = session(descriptor, createCollector), page = await s.program.currentPage(), value = await page[query]('.any')
      const node = query === '$$' ? value[0] : value
      assert.deepEqual(await node.tap({ original: 'gesture' }), { actual: 'tap-result' })
      assert.throws(() => check(s, 0, page), /empty source action/); assert.throws(() => s.collector.flush(), /empty source action/)
      assert.equal(s.events.length, 0)
    }
  })
  test(name + ': original rejected launch/query/tap preserves exact error object and publishes no synthetic success', async () => {
    for (const op of ['launch', 'query', 'tap']) {
      const error = new Error('original ' + op), s = session(descriptor, createCollector, { [op + 'Failure']: error })
      if (op === 'launch') await assert.rejects(s.program.reLaunch('/' + descriptor.plans[0].route), e => e === error)
      else {
        const page = await s.program.currentPage()
        if (op === 'query') await assert.rejects(page.$('.any'), e => e === error)
        else await assert.rejects((await page.$('.any')).tap(), e => e === error)
      }
      assert.deepEqual(s.events, []); assert.throws(() => s.collector.flush(), /incomplete/)
    }
  })
  test(name + ': restores inherited/nonwritable methods and owner markers on complete, failed and repeated flush', async () => {
    for (const ownDescriptors of [false, true]) for (const finished of [false, true]) {
      const s = session(descriptor, createCollector, { ownDescriptors }), wrapped = s.program.currentPage
      s.collector.attach(s.program); assert.equal(s.program.currentPage, wrapped)
      if (finished) { await complete(s); s.collector.flush() } else assert.throws(() => s.collector.flush(), /incomplete/)
      for (const original of s.originals) { assert.deepEqual(Object.getOwnPropertyDescriptor(original.target, original.key), original.own); assert.equal(original.target[original.key], original.value) }
      assert.deepEqual(Object.getOwnPropertySymbols(s.program), s.symbols)
      assert.throws(() => s.collector.attach(s.program), /open actual|incomplete/)
    }
  })
  test(name + ': emit failure is sticky and cannot publish a second plan', async () => {
    const error = new Error('emit failed'), s = session(descriptor, createCollector, { emitFailure: error }), page = await s.program.currentPage()
    assert.throws(() => check(s, 0, page), e => e === error); assert.throws(() => s.collector.flush(), e => e === error)
    assert.deepEqual(s.events, [])
  })
}

test('pending external query cannot become a later Page generation or survive flush as complete coverage', async () => {
  const waiting = deferred(), result = [], page = { path: item.plans[0].route, pageId: 3, async $$() { return await waiting.promise } }
  const program = { async currentPage() { return page }, async reLaunch(route) { return { path: route.replace(/^\//, ''), pageId: 4, async $$() { return [] } } } }
  const events = [], collector = itemCollector({ emit: e => events.push(e) }); collector.attach(program); await program.currentPage()
  const originalQuery = page.$$, operation = page.$$('.issue317-message')
  await program.reLaunch('/' + item.plans[1].route); waiting.resolve(result)
  assert.equal(await operation, result)
  assert.throws(() => collector.flush(), /another actual Page generation/)
  assert.notEqual(page.$$, originalQuery); assert.deepEqual(events, [])
})

test('an observed Page route cannot mutate across plans without reLaunch or a new actual Page acquisition', async () => {
  const s = session(item, itemCollector), page = await s.program.currentPage(); check(s, 0, page)
  page.path = item.plans[1].route; assert.equal(await s.program.currentPage(), page)
  assert.throws(() => check(s, 1, page), /identity changed/); assert.throws(() => s.collector.flush(), /identity changed/)
})

test('collector exact source tuple rejects a different case or hash', () => {
  assert.throws(() => itemCollector({ emit() {}, context: { caseId: user.caseId, sourceSha256: user.sourceSha256 } }), /exact source case/)
})

test('malformed observed routes stay rejected after a later otherwise valid checkpoint', async () => {
  for (const route of [' /bad', '../bad', '/subpackages/item/index?x=1', 'subpackages\\item\\index']) {
    const s = session(item, itemCollector), page = await s.program.currentPage(), value = evidence(item, 0)
    value.evidence.route = route
    assert.throws(() => check(s, 0, page, value), /route/)
    assert.throws(() => check(s, 0, page), /route/)
    assert.throws(() => s.collector.flush(), /route/)
  }
})

test('a pending acquisition or query cannot be counted after flush and original completion stays intact', async () => {
  for (const operation of ['acquisition', 'query']) {
    const wait = deferred(), events = [], result = { path: item.plans[0].route, pageId: 1, async $$() { return await wait.promise } }
    const program = { async currentPage() { return operation === 'acquisition' ? await wait.promise : result } }
    const collector = itemCollector({ emit: e => events.push(e) }), originalCurrent = program.currentPage, originalQuery = result.$$
    collector.attach(program)
    const pending = operation === 'acquisition' ? program.currentPage() : (await program.currentPage()).$$('.issue317-message')
    assert.throws(() => collector.flush(), /incomplete/)
    const expected = operation === 'acquisition' ? result : []
    wait.resolve(expected); assert.equal(await pending, expected)
    assert.equal(program.currentPage, originalCurrent); assert.equal(result.$$, originalQuery)
    assert.deepEqual(Object.getOwnPropertySymbols(program), [])
    assert.throws(() => collector.flush(), /incomplete/)
    assert.deepEqual(events, [])
  }
})

test('retired transports and delayed acquisitions cannot be rebound as another actual owner', async () => {
  const s = session(item, itemCollector), firstPage = await s.program.currentPage()
  const other = { async currentPage() { return { path: item.plans[0].route, pageId: firstPage.pageId, async $$() { return [] } } } }
  s.collector.attach(other); const observed = await other.currentPage()
  assert.throws(() => check(s, 0, firstPage), /Page|session|generation/)
  assert.throws(() => s.collector.flush())
  assert.equal(other.currentPage.name, 'currentPage')
  assert.ok(observed)

  const wait = deferred(), page = { path: item.plans[0].route, pageId: 2 }, collector = itemCollector({ emit() {} })
  const program = { async currentPage() { return await wait.promise } }
  collector.attach(program); const pending = program.currentPage()
  assert.throws(() => collector.attach({ async currentPage() { return page } }), /pending operation/)
  wait.resolve(page); assert.equal(await pending, page); assert.throws(() => collector.flush(), /pending operation/)
})

test('nested actual element tap is rejected while cached selector aliases alone are allowed', async () => {
  const s = session(item, itemCollector), page = await s.program.currentPage(), root = await page.$('.any'), child = await root.$('.child')
  assert.deepEqual(await child.tap(), { actual: 'tap-result' })
  assert.throws(() => s.collector.flush(), /empty source action/)
  const cached = { async tap() { return 'same actual object' } }, actualPage = { path: item.plans[0].route, pageId: 3, async $() { return cached } }
  const program = { async currentPage() { return actualPage }, async reLaunch(route) { actualPage.path = route.replace(/^\//, ''); return actualPage } }
  const events = [], collector = itemCollector({ emit: e => events.push(e) }); collector.attach(program); await program.currentPage()
  assert.equal(await actualPage.$('.first-alias'), cached); assert.equal(await actualPage.$('.second-alias'), cached)
  collector.checkpoint(evidence(item, 0), { session: program, page: actualPage })
  await program.reLaunch('/' + item.plans[1].route); collector.checkpoint(evidence(item, 1), { session: program, page: actualPage }); collector.flush()
  assert.equal(events.length, 4)
})
