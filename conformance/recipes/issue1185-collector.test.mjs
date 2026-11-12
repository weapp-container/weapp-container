import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollector } from './issue1185-collector.mjs'

const component = 'pages/component/index', bar = 'pages/bar/bar', unused = 'pages/unused/unused'
const plans = {
  'component-0': [component, [['#foo'], '#foo-values'], [['#foo'], '#foo-increment']],
  'component-1': [component, [['#foo'], '#foo-values'], [['#foo'], '#foo-increment']],
  'page-0': [bar, [[], '#bar-values'], [[], '#bar-increment']],
  'page-1': [bar, [[], '#bar-values'], [[], '#bar-increment']],
  'unused-sibling': [unused, [[], '#unused-value']],
}
const checkpoint = id => {
  const [route, ...queries] = plans[id]
  return { fixture: 'synthetic-collector-unit-test', provider: 'unit-test', evidence: {
    id, route, source: 'synthetic-collector-unit-test', capturedAt: new Date().toISOString(),
    nodes: queries.map(([scope, selector]) => ({ selector, query: 'css', ...(scope.length ? { scope: [...scope] } : {}),
      count: 1, nodes: [{ text: `actual captured ${id} ${selector}` }] })),
  } }
}

function session({ tapFailure, queryFailure, launchFailure, emitFailure, failEmitWhen = () => true, ownDescriptors = false } = {}) {
  const events = [], operations = [], originals = [], tapResult = { originalTapResult: true }
  const collector = createCollector({ emit(event) { if (emitFailure && failEmitWhen(event)) throw emitFailure; events.push(event) } })
  const remember = (object, keys) => {
    for (const key of keys) originals.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key), value: object[key] })
    return object
  }
  const makePage = path => {
    const elements = new Map()
    const page = Object.create({ async $(selector, ...args) {
      operations.push({ op: 'query', receiver: this, scope: [], selector, args })
      if (queryFailure) throw queryFailure
      return makeElement([], selector)
    } })
    page.path = path.replace(/^\//, '')
    const makeElement = (scope, selector) => {
      if (selector === '#missing') return undefined
      const key = JSON.stringify([...scope, selector])
      if (!elements.has(key)) elements.set(key, remember(Object.create({
        async $(childSelector, ...args) {
          operations.push({ op: 'query', receiver: this, scope: [...scope, selector], selector: childSelector, args })
          if (queryFailure) throw queryFailure
          return makeElement([...scope, selector], childSelector)
        },
        async tap(...args) {
          operations.push({ op: 'tap', receiver: this, scope, selector, args })
          if (tapFailure) throw tapFailure
          return tapResult
        },
      }), ['$', 'tap']))
      return elements.get(key)
    }
    return remember(page, ['$'])
  }
  const launch = async function (path, ...args) {
    operations.push({ op: 'reLaunch', receiver: this, path, args })
    if (launchFailure) throw launchFailure
    return makePage(path)
  }
  const program = ownDescriptors ? {} : Object.create({ reLaunch: launch })
  if (ownDescriptors) Object.defineProperty(program, 'reLaunch', { configurable: true, enumerable: true, writable: false, value: launch })
  remember(program, ['reLaunch'])
  collector.attach(program)
  return { collector, program, events, operations, originals, tapResult }
}

async function complete(s) {
  const first = await s.program.reLaunch('/' + component)
  s.collector.checkpoint(checkpoint('component-0'))
  const foo = await first.$('#foo'), button = await foo.$('#foo-increment')
  assert.equal(await button.tap(), s.tapResult)
  s.collector.checkpoint(checkpoint('component-1'))
  const second = await s.program.reLaunch('/' + bar)
  s.collector.checkpoint(checkpoint('page-0'))
  assert.equal(await (await second.$('#bar-increment')).tap(), s.tapResult)
  s.collector.checkpoint(checkpoint('page-1'))
  await s.program.reLaunch('/' + unused)
  s.collector.checkpoint(checkpoint('unused-sibling'))
  s.collector.flush()
}

test('records actual scoped and flat actions and completed evidence without autonomous calls', async () => {
  const s = session(), options = { originalOptions: true }, gesture = { originalGesture: true }
  assert.deepEqual(s.operations, [])
  const first = await s.program.reLaunch('/' + component, options)
  const observed = checkpoint('component-0')
  s.collector.checkpoint(observed)
  observed.evidence.nodes[0].nodes[0].text = 'later mutation'
  observed.evidence.nodes[0].scope[0] = '#later-mutation'
  assert.equal(s.events[1].payload.nodes[0].nodes[0].text, 'actual captured component-0 #foo-values')
  assert.deepEqual(s.events[1].payload.nodes[0].scope, ['#foo'])
  const foo = await first.$('#foo', options), button = await foo.$('#foo-increment', options)
  assert.equal(await button.tap(gesture), s.tapResult)
  assert.deepEqual(s.operations.map(value => value.op), ['reLaunch', 'query', 'query', 'tap'])
  assert.equal(s.operations[0].receiver, s.program)
  assert.equal(s.operations[0].args[0], options)
  assert.equal(s.operations[1].receiver, first)
  assert.equal(s.operations[1].args[0], options)
  assert.equal(s.operations[2].receiver, foo)
  assert.equal(s.operations[2].args[0], options)
  assert.equal(s.operations[3].receiver, button)
  assert.equal(s.operations[3].args[0], gesture)
  s.collector.checkpoint(checkpoint('component-1'))
  const second = await s.program.reLaunch('/' + bar)
  s.collector.checkpoint(checkpoint('page-0'))
  await (await second.$('#bar-increment')).tap()
  s.collector.checkpoint(checkpoint('page-1'))
  await s.program.reLaunch('/' + unused)
  s.collector.checkpoint(checkpoint('unused-sibling'))
  s.collector.flush()
  assert.equal(s.events.length, 10)
  assert.deepEqual(s.events.filter(event => event.op === 'route.active').map(event => event.payload.route), [component, bar, unused])
  assert.deepEqual(s.events.filter(event => event.op === 'tap').map(event => event.payload), [
    { route: component, scope: ['#foo'], selector: '#foo-increment' }, { route: bar, selector: '#bar-increment' },
  ])
  assert.deepEqual(s.operations.map(value => value.op), ['reLaunch', 'query', 'query', 'tap', 'reLaunch', 'query', 'tap', 'reLaunch'])
  assert.ok(s.events.every(event => !JSON.stringify(event).includes('capturedAt') && !JSON.stringify(event).includes('synthetic-collector-unit-test')))
})

test('restores inherited and own descriptors, and duplicate attachment and flush are idempotent', async () => {
  for (const ownDescriptors of [false, true]) {
    const s = session({ ownDescriptors }), wrapper = s.program.reLaunch
    s.collector.attach(s.program)
    assert.equal(s.program.reLaunch, wrapper)
    await complete(s)
    for (const { object, key, descriptor, value } of s.originals) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
      assert.equal(object[key], value)
    }
    const operationCount = s.operations.length, eventCount = s.events.length
    s.collector.flush()
    assert.equal(s.operations.length, operationCount)
    assert.equal(s.events.length, eventCount)
  }
})

test('preserves original launch, query and tap rejection identities and never emits rejected tap success', async () => {
  const launchFailure = new Error('actual launch failure'), launch = session({ launchFailure })
  await assert.rejects(launch.program.reLaunch('/' + component), error => error === launchFailure)
  assert.deepEqual(launch.events, [])
  assert.throws(() => launch.collector.flush(), /incomplete/)
  const queryFailure = new Error('actual query failure'), query = session({ queryFailure })
  const page = await query.program.reLaunch('/' + component)
  await assert.rejects(page.$('#foo'), error => error === queryFailure)
  assert.deepEqual(query.events, [])
  assert.throws(() => query.collector.flush(), /incomplete/)
  const tapFailure = new Error('actual tap failure'), tap = session({ tapFailure })
  const actualPage = await tap.program.reLaunch('/' + component)
  tap.collector.checkpoint(checkpoint('component-0'))
  const foo = await actualPage.$('#foo'), button = await foo.$('#foo-increment')
  await assert.rejects(button.tap(), error => error === tapFailure)
  assert.equal(tap.events.filter(event => event.op === 'tap').length, 0)
  assert.throws(() => tap.collector.checkpoint(checkpoint('component-1')), /successful observed tap/)
  assert.throws(() => tap.collector.flush(), /successful observed tap/)
})

test('unexpected action intervals, scopes, routes and selectors fail closed after preserving successful returns', async () => {
  for (const scenario of ['early', 'flat-scope', 'other-scope', 'other-route', 'other-selector', 'duplicate']) {
    const s = session(), page = await s.program.reLaunch('/' + component)
    if (scenario !== 'early') s.collector.checkpoint(checkpoint('component-0'))
    let button
    if (scenario === 'flat-scope') button = await page.$('#foo-increment')
    else button = await (await page.$(scenario === 'other-scope' ? '#other' : '#foo')).$(scenario === 'other-selector' ? '#unexpected' : '#foo-increment')
    if (scenario === 'other-route') page.path = bar
    assert.equal(await button.tap(), s.tapResult)
    if (scenario === 'duplicate') assert.equal(await button.tap(), s.tapResult)
    assert.equal(s.events.filter(event => event.op === 'tap').length, scenario === 'duplicate' ? 1 : 0)
    assert.throws(() => s.collector.flush(), /outside.*interval or scope/)
    const count = s.events.length
    assert.throws(() => s.collector.checkpoint(checkpoint('component-1')), /outside.*interval or scope/)
    assert.equal(s.events.length, count)
  }
})

test('missing, reordered and duplicate checkpoints and missing tap coverage cannot create observations', () => {
  const empty = session()
  assert.throws(() => empty.collector.flush(), /incomplete/)
  assert.deepEqual(empty.events, [])
  const skipped = session()
  assert.throws(() => skipped.collector.checkpoint(checkpoint('component-1')), /missing.*out of order/)
  assert.deepEqual(skipped.events, [])
  assert.throws(() => skipped.collector.flush(), /missing.*out of order/)
  const duplicate = session()
  duplicate.collector.checkpoint(checkpoint('component-0'))
  assert.throws(() => duplicate.collector.checkpoint(checkpoint('component-0')), /duplicated/)
  const missingTap = session()
  missingTap.collector.checkpoint(checkpoint('component-0'))
  assert.throws(() => missingTap.collector.checkpoint(checkpoint('component-1')), /successful observed tap/)
})

test('incomplete, ambiguous or differently scoped actual evidence emits nothing', () => {
  for (const mutation of [
    value => { value.evidence.route = bar },
    value => { value.evidence.route = '../' + component },
    value => { value.evidence.nodes.pop() },
    value => { delete value.evidence.nodes[0] },
    value => { value.evidence.nodes.reverse() },
    value => { delete value.evidence.nodes[0].scope },
    value => { value.evidence.nodes[0].scope = ['#other'] },
    value => { value.evidence.nodes[0].scope = [{ has: '#foo' }] },
    value => { value.evidence.nodes[0].scope = Array(1) },
    value => { value.evidence.nodes[0].has = '#extra' },
    value => { value.evidence.nodes[0].query = 'xpath' },
    value => { value.evidence.nodes[0].count = 2 },
    value => { value.evidence.nodes[0].count = -1 },
    value => { value.evidence.nodes[0].nodes[0].text = undefined },
    value => { delete value.evidence.nodes[0].nodes[0] },
  ]) {
    const s = session(), value = checkpoint('component-0')
    mutation(value)
    assert.throws(() => s.collector.checkpoint(value), /actual|route|query|scope/)
    assert.deepEqual(s.events, [])
    assert.throws(() => s.collector.flush())
  }
})

test('query absence remains absent and collector emission failure preserves guest operation returns', async () => {
  const s = session(), page = await s.program.reLaunch('/' + component)
  assert.equal(await page.$('#missing'), undefined)
  assert.deepEqual(s.events, [])
  assert.throws(() => s.collector.flush(), /incomplete/)
  const emitFailure = new Error('actual sink failure')
  const real = session({ emitFailure, failEmitWhen: event => event.op === 'tap' })
  const actualPage = await real.program.reLaunch('/' + component)
  real.collector.checkpoint(checkpoint('component-0'))
  const button = await (await actualPage.$('#foo')).$('#foo-increment')
  assert.equal(await button.tap(), real.tapResult)
  assert.throws(() => real.collector.flush(), error => error === emitFailure)
  assert.throws(() => real.collector.flush(), error => error === emitFailure)
  assert.equal(real.events.filter(event => event.op === 'tap').length, 0)
})

test('incomplete flush still restores wrappers and preserves external replacements', async () => {
  const s = session({ ownDescriptors: true }), page = await s.program.reLaunch('/' + component)
  const foo = await page.$('#foo'), replacement = async () => 'external replacement'
  foo.$ = replacement
  assert.throws(() => s.collector.flush(), /incomplete/)
  assert.equal(foo.$, replacement)
  for (const { object, key, descriptor } of s.originals.filter(value => value.object !== foo || value.key !== '$')) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
  }
  assert.throws(() => s.collector.attach(s.program), /incomplete/)
})

test('a failing observation-only route getter cannot replace the original successful tap', async () => {
  const s = session(), page = await s.program.reLaunch('/' + component)
  s.collector.checkpoint(checkpoint('component-0'))
  const button = await (await page.$('#foo')).$('#foo-increment')
  const failure = new Error('actual page route is unreadable')
  Object.defineProperty(page, 'path', { configurable: true, get() { throw failure } })
  assert.equal(await button.tap(), s.tapResult)
  assert.equal(s.operations.filter(value => value.op === 'tap').length, 1)
  assert.equal(s.events.filter(value => value.op === 'tap').length, 0)
  assert.throws(() => s.collector.flush(), error => error === failure)
})
