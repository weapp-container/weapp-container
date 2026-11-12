import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollector } from './issue1072-collector.mjs'

const routes = ['pages/home/index', 'pages/external/index', 'pages/dynamic/index']
const checkpoint = index => ({ fixture: 'synthetic-collector-unit-test', provider: 'unit-test', evidence: {
  id: `package-${index}`, route: routes[index], source: 'synthetic-collector-unit-test', capturedAt: new Date().toISOString(),
  nodes: [{ selector: '#increment', query: 'css', count: 1, nodes: [{ text: `actual checkpoint ${index}` }] }],
} })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function session({ launchFailure, queryFailure, textFailure, tapFailure, textResult, tapResult: suppliedTapResult,
  emitFailure, failEmitWhen = () => true, ownDescriptors = false } = {}) {
  const events = [], operations = [], originals = [], tapResult = suppliedTapResult ?? { originalTapResult: true }
  const collector = createCollector({ emit(event) { if (emitFailure && failEmitWhen(event)) throw emitFailure; events.push(event) } })
  const remember = (object, keys) => {
    for (const key of keys) originals.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key), value: object[key] })
    return object
  }
  const makePage = path => {
    const page = Object.create({ async $(selector, ...args) {
      operations.push({ op: 'query', receiver: this, selector, scope: [], args })
      if (queryFailure) throw queryFailure
      return makeElement([], selector)
    } })
    page.path = path.replace(/^\//, '')
    const makeElement = (scope, selector) => {
      if (selector === '#missing') return undefined
      return remember(Object.create({
        async $(child, ...args) {
          operations.push({ op: 'query', receiver: this, selector: child, scope: [...scope, selector], args })
          if (queryFailure) throw queryFailure
          return makeElement([...scope, selector], child)
        },
        async text(...args) {
          operations.push({ op: 'text', receiver: this, selector, scope, args })
          if (textFailure) throw textFailure
          return textResult === undefined ? `actual read ${page.path} ${operations.filter(value => value.op === 'text').length}` : textResult
        },
        async tap(...args) {
          operations.push({ op: 'tap', receiver: this, selector, scope, args })
          if (tapFailure) throw tapFailure
          return tapResult
        },
      }), ['$', 'text', 'tap'])
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

async function step(s, index) {
  const page = await s.program.reLaunch('/' + routes[index])
  const actualText = await (await page.$('#increment')).text()
  assert.equal(await (await page.$('#increment')).tap(), await s.tapResult)
  s.collector.checkpoint(checkpoint(index))
  return { page, actualText }
}
async function complete(s) {
  for (let index = 0; index < routes.length; index++) await step(s, index)
  s.collector.flush()
}

test('normalizes only the last successful original poll read before each tap, and never drives the session', async () => {
  const s = session(), options = { originalOptions: true }, gesture = { originalGesture: true }
  assert.deepEqual(s.operations, [])
  const page = await s.program.reLaunch('/' + routes[0], options)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  const firstRead = await (await page.$('#increment', options)).text(options)
  const pollElement = await page.$('#increment'), finalRead = await pollElement.text(options)
  assert.notEqual(firstRead, finalRead)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  const button = await page.$('#increment')
  assert.notEqual(button, pollElement)
  assert.equal(await button.tap(gesture), s.tapResult)
  const observed = checkpoint(0)
  s.collector.checkpoint(observed)
  observed.evidence.nodes[0].nodes[0].text = 'later mutation'
  assert.equal(s.events[3].payload.nodes[0].nodes[0].text, 'actual checkpoint 0')
  assert.equal(s.operations[0].receiver, s.program)
  assert.equal(s.operations[0].args[0], options)
  assert.equal(s.operations[1].receiver, page)
  assert.equal(s.operations[1].args[0], options)
  assert.equal(s.operations[2].args[0], options)
  assert.equal(s.operations[6].receiver, button)
  assert.equal(s.operations[6].args[0], gesture)
  const next = await step(s, 1), last = await step(s, 2)
  s.collector.flush()
  assert.deepEqual(s.events.map(value => value.op), Array.from({ length: 3 }, () => ['route.active', 'query.text', 'tap', 'dom.checkpoint']).flat())
  assert.deepEqual(s.events.filter(value => value.op === 'query.text').map(value => value.payload), [
    { route: routes[0], selector: '#increment', text: finalRead },
    { route: routes[1], selector: '#increment', text: next.actualText },
    { route: routes[2], selector: '#increment', text: last.actualText },
  ])
  assert.deepEqual(s.events.filter(value => value.op === 'tap').map(value => value.payload), routes.map(route => ({ route, selector: '#increment' })))
  assert.deepEqual(s.operations.map(value => value.op), [
    'reLaunch', 'query', 'text', 'query', 'text', 'query', 'tap',
    'reLaunch', 'query', 'text', 'query', 'tap', 'reLaunch', 'query', 'text', 'query', 'tap',
  ])
  assert.ok(s.events.every(value => !JSON.stringify(value).includes('capturedAt') && !JSON.stringify(value).includes('synthetic-collector-unit-test')))
})

test('restores inherited and own descriptors, preserving duplicate attachment and flush idempotence', async () => {
  for (const ownDescriptors of [false, true]) {
    const s = session({ ownDescriptors }), wrapper = s.program.reLaunch
    s.collector.attach(s.program)
    assert.equal(s.program.reLaunch, wrapper)
    await complete(s)
    for (const { object, key, descriptor, value } of s.originals) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
      assert.equal(object[key], value)
    }
    const count = s.operations.length
    s.collector.flush()
    assert.equal(s.operations.length, count)
  }
})

test('preserves original launch, query, text and tap rejection identities without inventing successful observations', async () => {
  for (const operation of ['launch', 'query', 'text', 'tap']) {
    const error = new Error(`original ${operation} failure`), s = session({ [`${operation}Failure`]: error })
    if (operation === 'launch') await assert.rejects(s.program.reLaunch('/' + routes[0]), failure => failure === error)
    else {
      const page = await s.program.reLaunch('/' + routes[0])
      if (operation === 'query') await assert.rejects(page.$('#increment'), failure => failure === error)
      else {
        const element = await page.$('#increment')
        if (operation === 'text') await assert.rejects(element.text(), failure => failure === error)
        else {
          await element.text()
          await assert.rejects(element.tap(), failure => failure === error)
        }
      }
    }
    assert.equal(s.events.filter(value => ['query.text', 'tap'].includes(value.op)).length, 0)
    assert.throws(() => s.collector.flush(), /incomplete/)
  }
})

test('successful taps without a preceding read from this launch fail closed while retaining the original result', async () => {
  const missing = session(), page = await missing.program.reLaunch('/' + routes[0])
  assert.equal(await (await page.$('#increment')).tap(), missing.tapResult)
  assert.equal(missing.events.length, 1)
  assert.throws(() => missing.collector.flush(), /no preceding actual text read/)
  const previous = session()
  await step(previous, 0)
  const second = await previous.program.reLaunch('/' + routes[1])
  assert.equal(await (await second.$('#increment')).tap(), previous.tapResult)
  assert.equal(previous.events.filter(value => value.op === 'query.text').length, 1)
  assert.throws(() => previous.collector.flush(), /no preceding actual text read/)
})

test('a read completed after the original tap started cannot fill preceding-read coverage', async () => {
  const read = deferred(), tap = deferred(), s = session({ textResult: read.promise, tapResult: tap.promise })
  const page = await s.program.reLaunch('/' + routes[0])
  const element = await page.$('#increment'), pendingRead = element.text(), pendingTap = element.tap()
  read.resolve('actual late read')
  assert.equal(await pendingRead, 'actual late read')
  const originalResult = { completedTap: true }
  tap.resolve(originalResult)
  assert.equal(await pendingTap, originalResult)
  assert.equal(s.events.filter(value => ['query.text', 'tap'].includes(value.op)).length, 0)
  assert.throws(() => s.collector.flush(), /no preceding actual text read|source read completed across an original action boundary/)
})

test('a delayed query retains its original launch token when the provider reuses a Page object', async () => {
  const delayed = deferred(), events = [], originalTapResult = { originalTapResult: true }
  const collector = createCollector({ emit: event => events.push(event) })
  const element = text => ({ async text() { return text }, async tap() { return originalTapResult } })
  const page = { path: '', async $(selector, options) {
    assert.equal(selector, '#increment')
    return options?.delayed ? delayed.promise : element(`actual read ${this.path}`)
  } }
  const program = { async reLaunch(path) { page.path = path.replace(/^\//, ''); return page } }
  collector.attach(program)
  assert.equal(await program.reLaunch('/' + routes[0]), page)
  const oldQuery = page.$('#increment', { delayed: true })
  const first = await page.$('#increment')
  await first.text()
  await first.tap()
  collector.checkpoint(checkpoint(0))
  assert.equal(await program.reLaunch('/' + routes[1]), page)
  delayed.resolve(element('actual stale home-page query'))
  const stale = await oldQuery
  assert.equal(await stale.text(), 'actual stale home-page query')
  assert.equal(await stale.tap(), originalTapResult)
  assert.equal(events.filter(value => value.op === 'query.text').length, 1)
  assert.equal(events.filter(value => value.op === 'tap').length, 1)
  assert.throws(() => collector.flush(), /current launch/)
})

test('unexpected launch routes and intervals preserve the original Page but cannot activate a normalized route', async () => {
  for (const route of [routes[1], '../' + routes[0], 'pages//home/index', routes[0] + '?query=1']) {
    const s = session(), page = await s.program.reLaunch('/' + route)
    assert.equal(page.path, route)
    assert.deepEqual(s.events, [])
    assert.throws(() => s.collector.flush(), /route|canonical/)
  }
  const repeated = session()
  await repeated.program.reLaunch('/' + routes[0])
  const second = await repeated.program.reLaunch('/' + routes[0])
  assert.equal(second.path, routes[0])
  assert.equal(repeated.events.length, 1)
  assert.throws(() => repeated.collector.flush(), /outside.*interval/)
})

test('unexpected tap scopes, selectors, duplicate actions and stale pages cannot fill coverage', async () => {
  for (const scenario of ['scope', 'selector', 'duplicate', 'stale-page']) {
    const s = session(), page = await s.program.reLaunch('/' + routes[0])
    const element = scenario === 'scope' ? await (await page.$('#scope')).$('#increment')
      : await page.$(scenario === 'selector' ? '#other' : '#increment')
    await element.text()
    if (scenario === 'stale-page') {
      await (await page.$('#increment')).tap()
      s.collector.checkpoint(checkpoint(0))
      await s.program.reLaunch('/' + routes[1])
    }
    assert.equal(await element.tap(), s.tapResult)
    if (scenario === 'duplicate') assert.equal(await element.tap(), s.tapResult)
    assert.equal(s.events.filter(value => value.op === 'tap').length, ['duplicate', 'stale-page'].includes(scenario) ? 1 : 0)
    assert.throws(() => s.collector.flush(), /outside.*interval or scope/)
  }
})

test('missing, reordered and duplicate checkpoints or missing successful taps fail instead of emitting checkpoints', async () => {
  const empty = session()
  assert.throws(() => empty.collector.flush(), /incomplete/)
  assert.deepEqual(empty.events, [])
  const skipped = session()
  assert.throws(() => skipped.collector.checkpoint(checkpoint(1)), /missing.*out of order/)
  assert.deepEqual(skipped.events, [])
  const missingTap = session()
  await missingTap.program.reLaunch('/' + routes[0])
  assert.throws(() => missingTap.collector.checkpoint(checkpoint(0)), /missing.*successful observed tap/)
  assert.equal(missingTap.events.filter(value => value.op === 'dom.checkpoint').length, 0)
  const duplicate = session()
  await step(duplicate, 0)
  assert.throws(() => duplicate.collector.checkpoint(checkpoint(0)), /duplicated/)
})

test('incomplete, differently scoped or malformed actual checkpoint evidence cannot emit a render', async () => {
  for (const mutate of [
    value => { value.evidence.route = routes[1] },
    value => { value.evidence.route = '/pages//home/index' },
    value => { value.evidence.nodes = [] },
    value => { delete value.evidence.nodes[0] },
    value => { value.evidence.nodes[0].scope = ['#component'] },
    value => { value.evidence.nodes[0].scope = null },
    value => { value.evidence.nodes[0].has = '#descendant' },
    value => { value.evidence.nodes[0].selector = '#other' },
    value => { value.evidence.nodes[0].query = 'xpath' },
    value => { value.evidence.nodes[0].count = 2 },
    value => { value.evidence.nodes[0].count = -1 },
    value => { delete value.evidence.nodes[0].nodes[0].text },
    value => { delete value.evidence.nodes[0].nodes[0] },
  ]) {
    const s = session(), page = await s.program.reLaunch('/' + routes[0]), value = checkpoint(0)
    const element = await page.$('#increment')
    await element.text()
    await element.tap()
    mutate(value)
    assert.throws(() => s.collector.checkpoint(value), /actual|route|query|scope/)
    assert.equal(s.events.filter(event => event.op === 'dom.checkpoint').length, 0)
    assert.throws(() => s.collector.flush())
  }
})

test('non-string reads and emission failures retain original successful operation values and fail flush', async () => {
  const actual = { originalReadObject: true }, invalid = session({ textResult: actual })
  const page = await invalid.program.reLaunch('/' + routes[0]), element = await page.$('#increment')
  assert.equal(await element.text(), actual)
  assert.equal(await element.tap(), invalid.tapResult)
  assert.equal(invalid.events.filter(value => ['query.text', 'tap'].includes(value.op)).length, 0)
  assert.throws(() => invalid.collector.flush(), /actual string/)
  for (const op of ['query.text', 'tap']) {
    const error = new Error(`original ${op} sink failure`), s = session({ emitFailure: error, failEmitWhen: event => event.op === op })
    const actualPage = await s.program.reLaunch('/' + routes[0]), button = await actualPage.$('#increment')
    await button.text()
    assert.equal(await button.tap(), s.tapResult)
    assert.equal(s.events.filter(value => value.op === 'tap').length, 0)
    assert.throws(() => s.collector.flush(), failure => failure === error)
    assert.throws(() => s.collector.flush(), failure => failure === error)
  }
})

test('absent queries remain absent, and incomplete flush restores wrappers while preserving external replacements', async () => {
  const s = session({ ownDescriptors: true }), page = await s.program.reLaunch('/' + routes[0])
  assert.equal(await page.$('#missing'), undefined)
  const element = await page.$('#increment'), replacement = async () => 'external replacement'
  element.text = replacement
  assert.throws(() => s.collector.flush(), /incomplete/)
  assert.equal(element.text, replacement)
  for (const { object, key, descriptor } of s.originals.filter(value => value.object !== element || value.key !== 'text')) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
  }
  assert.throws(() => s.collector.attach(s.program), /incomplete/)
})


// The pinned Automator caches Page instances by pageId and Element instances
// by elementId. This fixture models the observable object reuse, while all
// strings and operation results still come from this synthetic provider.
function cachedSession({ aliasQueries = false } = {}) {
  const events = [], operations = [], cachedElements = new Map(), originals = []
  const collector = createCollector({ emit: event => events.push(event) })
  const remember = (object, keys) => {
    for (const key of keys) originals.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key), value: object[key] })
    return object
  }
  const query = async (scope, selector, options) => {
    operations.push({ op: 'query', route: page.path, scope, selector })
    const key = aliasQueries ? 'shared' : JSON.stringify([...scope, selector])
    if (!cachedElements.has(key)) cachedElements.set(key, remember({
      async $(child, options) { return query([...scope, selector], child, options) },
      async text(options) {
        operations.push({ op: 'text', route: page.path, scope, selector })
        return options?.result ?? `actual cached read ${page.path}`
      },
      async tap(options) {
        operations.push({ op: 'tap', route: page.path, scope, selector })
        return options?.result ?? tapResult
      },
    }, ['$', 'text', 'tap']))
    return options?.result ?? cachedElements.get(key)
  }
  const tapResult = { originalCachedTap: true }
  const page = remember({ path: '', async $(selector, options) { return query([], selector, options) } }, ['$'])
  const program = remember({ async reLaunch(path, options) {
    operations.push({ op: 'reLaunch', path })
    page.path = path.replace(/^\//, '')
    return options?.result ?? page
  } }, ['reLaunch'])
  collector.attach(program)
  return { collector, program, page, events, operations, originals, cachedElements, tapResult }
}

test('cached Page and Element wrappers are reacquired across all three actual launches without changing trace semantics', async () => {
  const s = cachedSession()
  let originalPage, originalElement
  for (let index = 0; index < routes.length; index++) {
    const page = await s.program.reLaunch('/' + routes[index]), element = await page.$('#increment')
    if (index === 0) { originalPage = page; originalElement = element }
    else { assert.equal(page, originalPage); assert.equal(element, originalElement) }
    const text = await element.text()
    assert.equal(await (await page.$('#increment')).tap(), s.tapResult)
    // The unchanged original DOM checkpoint can perform its own post-tap read.
    assert.equal(await (await page.$('#increment')).text(), `actual cached read ${routes[index]}`)
    s.collector.checkpoint(checkpoint(index))
    assert.equal(s.events[index * 4 + 1].payload.text, text)
  }
  s.collector.flush()
  assert.deepEqual(s.events.map(value => value.op), Array.from({ length: 3 }, () => ['route.active', 'query.text', 'tap', 'dom.checkpoint']).flat())
  assert.deepEqual(s.operations.map(value => value.op), Array.from({ length: 3 }, () => ['reLaunch', 'query', 'text', 'query', 'tap', 'query', 'text']).flat())
  for (const { object, key, descriptor, value } of s.originals) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
    assert.equal(object[key], value)
  }
})

test('legal cached-node aliases retain the actual canonical action acquisition without relabeling it', async () => {
  for (const scenario of ['selector', 'scope']) {
    const s = cachedSession({ aliasQueries: true }), page = await s.program.reLaunch('/' + routes[0])
    const element = await page.$('#increment')
    await element.text()
    assert.equal(await (scenario === 'selector' ? page.$('#other') : element.$('#increment')), element)
    assert.equal(await element.tap(), s.tapResult)
    assert.equal(s.events.filter(value => value.op === 'tap').length, 1)
    assert.deepEqual(s.events[2].payload, {route:routes[0],selector:'#increment'})
    s.collector.checkpoint(checkpoint(0))
    for (const index of [1,2]) await step(s,index)
    s.collector.flush()
  }
})

test('an old cached Element reference cannot supply observations after navigation until an actual query reacquires it', async () => {
  const s = cachedSession()
  await step(s, 0)
  const element = s.cachedElements.get(JSON.stringify(['#increment']))
  await s.program.reLaunch('/' + routes[1])
  assert.equal(await element.text(), `actual cached read ${routes[1]}`)
  assert.equal(await element.tap(), s.tapResult)
  assert.equal(s.events.filter(value => value.op === 'tap').length, 1)
  assert.throws(() => s.collector.flush(), /current launch/)
})

test('a pending read keeps its old binding after the same cached Element is reacquired in a later launch', async () => {
  const delayed = deferred(), s = cachedSession(), page = await s.program.reLaunch('/' + routes[0])
  const first = await page.$('#increment')
  await first.text()
  const pending = first.text({ result: delayed.promise })
  await first.tap()
  s.collector.checkpoint(checkpoint(0))
  await s.program.reLaunch('/' + routes[1])
  assert.equal(await page.$('#increment'), first)
  delayed.resolve('actual stale cached read')
  assert.equal(await pending, 'actual stale cached read')
  assert.deepEqual(s.events.map(value => value.op), ['route.active', 'query.text', 'tap', 'dom.checkpoint', 'route.active'])
  assert.throws(() => s.collector.flush(), /current launch/)
})

test('same-launch reacquisition cannot relabel a pending read from the previous query acquisition', async () => {
  const delayed = deferred(), s = cachedSession(), page = await s.program.reLaunch('/' + routes[0])
  const element = await page.$('#increment'), pending = element.text({ result: delayed.promise })
  assert.equal(await page.$('#increment'), element)
  delayed.resolve('actual earlier query read')
  assert.equal(await pending, 'actual earlier query read')
  assert.equal(await element.tap(), s.tapResult)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  assert.throws(() => s.collector.flush(), /current launch/)
})

test('an older query returning a cached Element after a newer query cannot roll its acquisition binding back', async () => {
  const delayed = deferred(), s = cachedSession(), page = await s.program.reLaunch('/' + routes[0])
  const pending = page.$('#increment', { result: delayed.promise }), current = await page.$('#increment')
  delayed.resolve(current)
  assert.equal(await pending, current)
  assert.equal(await current.text(), `actual cached read ${routes[0]}`)
  assert.equal(await current.tap(), s.tapResult)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  assert.throws(() => s.collector.flush(), /query completed after a later actual Element acquisition/)
})

test('a pending child query cannot adopt the parent Element reacquisition', async () => {
  const delayed = deferred(), s = cachedSession(), page = await s.program.reLaunch('/' + routes[0])
  const parent = await page.$('#component'), pending = parent.$('#increment', { result: delayed.promise })
  assert.equal(await page.$('#component'), parent)
  const originalChild = { async text() { return 'actual stale child' } }
  delayed.resolve(originalChild)
  assert.equal(await pending, originalChild)
  assert.equal(await originalChild.text(), 'actual stale child')
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  assert.throws(() => s.collector.flush(), /child query.*current launch/)
})

test('a pending tap cannot adopt a later acquisition of the same cached Element', async () => {
  const delayed = deferred(), result = { actualPendingTap: true }, s = cachedSession(), page = await s.program.reLaunch('/' + routes[0])
  const element = await page.$('#increment')
  await element.text()
  const pending = element.tap({ result: delayed.promise })
  assert.equal(await page.$('#increment'), element)
  delayed.resolve(result)
  assert.equal(await pending, result)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  assert.throws(() => s.collector.flush(), /successful tap is outside/)
})

test('overlapping successful taps retain both original results and cannot fill a single observation interval', async () => {
  const one = deferred(), two = deferred(), s = cachedSession(), page = await s.program.reLaunch('/' + routes[0])
  const element = await page.$('#increment')
  await element.text()
  const first = element.tap({ result: one.promise }), second = element.tap({ result: two.promise })
  one.resolve({ firstOriginal: true }); two.resolve({ secondOriginal: true })
  assert.deepEqual(await first, { firstOriginal: true }); assert.deepEqual(await second, { secondOriginal: true })
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  assert.throws(() => s.collector.flush(), /successful tap is outside/)
})

test('overlapping launches preserve original Pages but an earlier completion cannot publish a second generation', async () => {
  const delayed = deferred(), s = cachedSession()
  const earlier = s.program.reLaunch('/' + routes[0], { result: delayed.promise })
  assert.equal(await s.program.reLaunch('/' + routes[0]), s.page)
  delayed.resolve(s.page)
  assert.equal(await earlier, s.page)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  assert.throws(() => s.collector.flush(), /successful reLaunch is outside/)
})

test('original pending rejection identity remains intact after cached Element reacquisition', async () => {
  const delayed = deferred(), originalFailure = new Error('original cached transport rejection'), s = cachedSession()
  const page = await s.program.reLaunch('/' + routes[0]), element = await page.$('#increment')
  const pending = element.text({ result: delayed.promise })
  assert.equal(await page.$('#increment'), element)
  delayed.reject(originalFailure)
  await assert.rejects(pending, error => error === originalFailure)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  assert.throws(() => s.collector.flush(), /incomplete/)
})

test('a provider route metadata mutation without an observed launch cannot fill a checkpoint', async () => {
  const s = cachedSession()
  await step(s, 0)
  const page = await s.program.reLaunch('/' + routes[1]), element = await page.$('#increment')
  await element.text(); await element.tap()
  page.path = routes[2]
  assert.throws(() => s.collector.checkpoint(checkpoint(1)), /checkpoint is missing its actual route launch/)
  assert.equal(s.events.filter(value => value.op === 'dom.checkpoint').length, 1)
  assert.throws(() => s.collector.flush())
})

test('an Element acquired on one transport cannot be rebound to an action query on another transport',async()=>{
 const s=cachedSession();await step(s,0)
 const element=s.cachedElements.get(JSON.stringify(['#increment']))
 const page={path:routes[1],async $(){return element}},other={async reLaunch(){return page}}
 s.collector.attach(other);assert.equal(await other.reLaunch('/'+routes[1]),page)
 assert.equal(await page.$('#increment'),element);assert.equal(await element.tap(),s.tapResult)
 assert.equal(s.events.filter(e=>e.op==='tap').length,1)
 assert.throws(()=>s.collector.flush(),/different transports/)
})

test('provider helper original thrown object and own method descriptor survive observation cleanup',async()=>{
 const failure={originalHelperFailure:true},page={path:routes[0],async $(){return null}}
 const original=async function(){throw failure}
 Object.defineProperty(page,'waitForRendered',{configurable:true,writable:false,enumerable:true,value:original})
 const before=Object.getOwnPropertyDescriptor(page,'waitForRendered'),events=[]
 const collector=createCollector({emit:e=>events.push(e)}),program={async reLaunch(){return page}}
 collector.attach(program);await program.reLaunch('/'+routes[0])
 await assert.rejects(page.waitForRendered(),e=>e===failure)
 assert.throws(()=>collector.flush(),/incomplete/)
 assert.deepEqual(Object.getOwnPropertyDescriptor(page,'waitForRendered'),before)
 assert.equal(collector.diagnostics().events.at(-1).phase,'throw')
})
