import assert from 'node:assert/strict'
import test from 'node:test'
import { createCollector } from './issue1034-collector.mjs'
import { descriptor } from './issue1034-descriptor.mjs'

const { routes } = descriptor
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const checkpoint = index => ({ fixture: 'synthetic-unit', provider: 'synthetic-unit', evidence: {
  id: `package-${index}`, route: routes[index], source: 'synthetic-unit', capturedAt: 'not-normalized',
  nodes: ['#source', '#increment'].map(selector => ({ selector, query: 'css', count: 1,
    nodes: [{ text: `actual checkpoint ${index} ${selector}` }] })),
} })

function session(options = {}) {
  const events = [], operations = [], originals = [], tapResult = options.tapResult ?? { originalTapResult: true }
  const collector = options.collector ?? createCollector({ emit(event) {
    if (options.emitFailure && (options.failEmitWhen ?? (() => true))(event)) throw options.emitFailure
    events.push(event)
  } })
  const remember = (object, keys) => {
    for (const key of keys) originals.push({ object, key, value: object[key], own: Object.getOwnPropertyDescriptor(object, key) })
    return object
  }
  const makePage = path => {
    const page = Object.create({ async $(selector, ...args) {
      operations.push({ op: 'query', receiver: this, selector, scope: [], args })
      if (options.queryFailure) throw options.queryFailure
      return makeElement([], selector)
    } })
    page.path = path.replace(/^\//, '')
    const makeElement = (scope, selector) => selector === '#missing' ? undefined : remember(Object.create({
      async $(child, ...args) { operations.push({ op: 'query', receiver: this, selector: child, scope: [...scope, selector], args }); return makeElement([...scope, selector], child) },
      async text(...args) {
        operations.push({ op: 'text', receiver: this, selector, scope, args })
        if (options.textFailure) throw options.textFailure
        return options.textResult ?? `actual source read ${page.path} ${operations.filter(value => value.op === 'text').length}`
      },
      async tap(...args) {
        operations.push({ op: 'tap', receiver: this, selector, scope, args })
        if (options.tapFailure) throw options.tapFailure
        return tapResult
      },
    }), ['$', 'text', 'tap'])
    return remember(page, ['$'])
  }
  const launch = async function (path, ...args) {
    operations.push({ op: 'reLaunch', receiver: this, path, args })
    if (options.launchFailure) throw options.launchFailure
    return makePage(path)
  }
  const program = options.ownDescriptors ? {} : Object.create({ reLaunch: launch })
  if (options.ownDescriptors) Object.defineProperty(program, 'reLaunch', { configurable: true, enumerable: true, writable: false, value: launch })
  remember(program, ['reLaunch'])
  collector.attach(program)
  return { collector, program, events, operations, originals, tapResult }
}
async function prepare(s, index) {
  const page = await s.program.reLaunch('/' + routes[index])
  const actualText = await (await page.$('#source')).text()
  const button = await page.$('#increment')
  assert.equal(await button.tap(), await s.tapResult)
  return { page, actualText, button }
}
async function step(s, index) { const value = await prepare(s, index); s.collector.checkpoint(checkpoint(index), { session: s.program, page: value.page }); return value }
async function complete(s) { for (let index = 0; index < 3; index++) await step(s, index); s.collector.flush() }

test('normalizes only actual terminal source reads and separate increment actions without driving or filling values', async () => {
  const s = session(), option = { originalOption: true }, gesture = { originalGesture: true }
  assert.deepEqual(s.operations, [])
  const page = await s.program.reLaunch('/' + routes[0], option)
  const source = await page.$('#source', option)
  const first = await source.text(option), terminal = await source.text(option)
  assert.notEqual(first, terminal)
  assert.deepEqual(s.events.map(value => value.op), ['route.active'])
  const button = await page.$('#increment')
  assert.equal(await button.tap(gesture), s.tapResult)
  // DOM acceptance may read source again after the original action.
  await (await page.$('#source')).text()
  const evidence = checkpoint(0)
  s.collector.checkpoint(evidence, { session: s.program, page })
  evidence.evidence.nodes[0].nodes[0].text = 'later mutation'
  assert.equal(s.events[1].payload.text, terminal)
  assert.equal(s.events[3].payload.nodes[0].nodes[0].text, 'actual checkpoint 0 #source')
  const next = await step(s, 1), last = await step(s, 2)
  s.collector.flush()
  assert.deepEqual(s.events.map(value => value.op), Array.from({ length: 3 }, () => ['route.active', 'query.text', 'tap', 'dom.checkpoint']).flat())
  assert.deepEqual(s.events.filter(value => value.op === 'query.text').map(value => value.payload),
    [terminal, next.actualText, last.actualText].map((text, index) => ({ route: routes[index], selector: '#source', text })))
  assert.deepEqual(s.events.filter(value => value.op === 'tap').map(value => value.payload), routes.map(route => ({ route, selector: '#increment' })))
  assert.equal(s.operations[0].receiver, s.program); assert.equal(s.operations[0].args[0], option)
  assert.equal(s.operations[1].receiver, page); assert.equal(s.operations[1].args[0], option)
  assert.equal(s.operations[2].receiver, source); assert.equal(s.operations[2].args[0], option)
  assert.equal(s.operations[5].receiver, button); assert.equal(s.operations[5].args[0], gesture)
  assert.ok(s.events.every(value => !JSON.stringify(value).includes('synthetic-unit') && !JSON.stringify(value).includes('capturedAt')))
})

test('restores exact inherited and own descriptors, ownership, duplicate attachment and idempotent flush', async () => {
  for (const ownDescriptors of [false, true]) {
    const s = session({ ownDescriptors }), wrapper = s.program.reLaunch
    s.collector.attach(s.program); assert.equal(s.program.reLaunch, wrapper)
    await complete(s)
    for (const { object, key, value, own } of s.originals) { assert.equal(object[key], value); assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), own) }
    assert.deepEqual(Object.getOwnPropertySymbols(s.program), [])
    s.collector.flush()
  }
})

test('preserves all upstream rejection identities and never invents successful actions', async () => {
  for (const operation of ['launch', 'query', 'text', 'tap']) {
    const failure = new Error(`original ${operation} rejection`), s = session({ [`${operation}Failure`]: failure })
    if (operation === 'launch') await assert.rejects(s.program.reLaunch('/' + routes[0]), value => value === failure)
    else {
      const page = await s.program.reLaunch('/' + routes[0])
      if (operation === 'query') await assert.rejects(page.$('#source'), value => value === failure)
      else if (operation === 'text') await assert.rejects((await page.$('#source')).text(), value => value === failure)
      else { await (await page.$('#source')).text(); await assert.rejects((await page.$('#increment')).tap(), value => value === failure) }
    }
    assert.equal(s.events.filter(value => ['query.text', 'tap'].includes(value.op)).length, 0)
    assert.throws(() => s.collector.flush(), /incomplete/)
  }
})

test('a source read is required in each launch; increment reads or scoped source cannot substitute', async () => {
  for (const selector of ['missing-read', '#increment', 'scoped-source']) {
    const s = session(), page = await s.program.reLaunch('/' + routes[0])
    if (selector === 'scoped-source') await (await (await page.$('#component')).$('#source')).text()
    else if (selector !== 'missing-read') await (await page.$(selector)).text()
    assert.equal(await (await page.$('#increment')).tap(), s.tapResult)
    assert.equal(s.events.length, 1)
    assert.throws(() => s.collector.flush(), /no preceding actual source read/)
  }
  const s = session(); await step(s, 0)
  const page = await s.program.reLaunch('/' + routes[1]); await (await page.$('#increment')).tap()
  assert.throws(() => s.collector.flush(), /no preceding actual source read/)
})

test('late source reads and concurrent actions fail closed while upstream values remain unchanged', async () => {
  const read = deferred(), tap = deferred(), s = session({ textResult: read.promise, tapResult: tap.promise })
  const page = await s.program.reLaunch('/' + routes[0]), source = await page.$('#source'), button = await page.$('#increment')
  const pendingRead = source.text(), pendingTap = button.tap()
  read.resolve('actual late read'); assert.equal(await pendingRead, 'actual late read')
  const result = { actualTapResult: true }; tap.resolve(result); assert.equal(await pendingTap, result)
  assert.equal(s.events.length, 1); assert.throws(() => s.collector.flush(), /action boundary/)
  const taps = deferred(), concurrent = session({ tapResult: taps.promise }), secondPage = await concurrent.program.reLaunch('/' + routes[0])
  await (await secondPage.$('#source')).text()
  const element = await secondPage.$('#increment'), one = element.tap(), two = element.tap()
  taps.resolve(result); assert.equal(await one, result); assert.equal(await two, result)
  assert.equal(concurrent.events.length, 1); assert.throws(() => concurrent.collector.flush(), /interval or scope/)
})

test('delayed queries cannot adopt a reused Page generation', async () => {
  const delayed = deferred(), events = [], collector = createCollector({ emit: event => events.push(event) })
  const element = text => ({ async text() { return text }, async tap() { return 'original tap' } })
  const page = { path: '', async $(selector, options) { return options?.delayed ? delayed.promise : element(`actual ${this.path} ${selector}`) } }
  const program = { async reLaunch(route) { page.path = route.slice(1); return page } }
  collector.attach(program); await program.reLaunch('/' + routes[0])
  const oldQuery = page.$('#source', { delayed: true })
  await (await page.$('#source')).text(); await (await page.$('#increment')).tap(); collector.checkpoint(checkpoint(0), { session: program, page })
  await program.reLaunch('/' + routes[1]); delayed.resolve(element('actual stale source'))
  assert.equal(await (await oldQuery).text(), 'actual stale source')
  assert.equal(events.filter(value => value.op === 'query.text').length, 1)
  assert.throws(() => collector.flush(), /current observed Page/)
})

test('route order, malformed routes, repeated launches, wrong selectors and scopes are rejected', async () => {
  for (const route of [routes[1], '../' + routes[0], 'pages//home/index', routes[0] + '?q=1', routes[0] + '#x', ' '+routes[0]]) {
    const s = session(), page = await s.program.reLaunch('/' + route)
    assert.equal(page.path, route); assert.equal(s.events.length, 0); assert.throws(() => s.collector.flush(), /route|canonical|interval/)
  }
  const repeated = session(); await repeated.program.reLaunch('/' + routes[0]); await repeated.program.reLaunch('/' + routes[0])
  assert.equal(repeated.events.length, 1); assert.throws(() => repeated.collector.flush(), /interval/)
  for (const scenario of ['scope', 'selector', 'duplicate', 'stale']) {
    const s = session(), { page, button } = await prepare(s, 0)
    if (scenario === 'stale') { s.collector.checkpoint(checkpoint(0)); await s.program.reLaunch('/' + routes[1]) }
    const actual = scenario === 'scope' ? await (await page.$('#component')).$('#increment')
      : scenario === 'selector' ? await page.$('#other') : button
    assert.equal(await actual.tap(), s.tapResult)
    assert.equal(s.events.filter(value => value.op === 'tap').length, 1)
    assert.throws(() => s.collector.flush(), /interval or scope|another actual Page generation/)
  }
})

test('checkpoint sequence and actual Page/session ownership cannot be forged or crossed', async () => {
  const empty = session(); assert.throws(() => empty.collector.flush(), /incomplete/)
  const missing = session(); await missing.program.reLaunch('/' + routes[0]); assert.throws(() => missing.collector.checkpoint(checkpoint(0)), /completed tap/)
  const reordered = session(); assert.throws(() => reordered.collector.checkpoint(checkpoint(1)), /out of order/)
  const duplicate = session(); await step(duplicate, 0); assert.throws(() => duplicate.collector.checkpoint(checkpoint(0)), /duplicated/)
  for (const kind of ['session', 'page', 'reconnect']) {
    const s = session(), { page } = await prepare(s, 0)
    const another = kind === 'reconnect' ? session({ collector: s.collector }).program : {}
    const context = { session: kind === 'page' ? s.program : another, page: kind === 'page' ? {} : page }
    assert.throws(() => s.collector.checkpoint(checkpoint(0), context), /actual Page, session/)
    assert.equal(s.events.filter(value => value.op === 'dom.checkpoint').length, 0); assert.throws(() => s.collector.flush())
  }
})

test('missing, sparse, reordered, invalid count/scope and absent text evidence are never filled', async () => {
  for (const mutate of [
    value => { value.evidence.route = routes[1] }, value => { value.evidence.route = 'pages//home/index' },
    value => { value.evidence.nodes = [] }, value => { delete value.evidence.nodes[0] }, value => { value.evidence.nodes.reverse() },
    value => { value.evidence.nodes[0].scope = ['#component'] }, value => { value.evidence.nodes[0].scope = null },
    value => { value.evidence.nodes[0].has = '#child' }, value => { value.evidence.nodes[0].query = 'xpath' },
    value => { value.evidence.nodes[0].count = 2 }, value => { value.evidence.nodes[0].count = -1 }, value => { value.evidence.nodes[0].count = 0.5 },
    value => { delete value.evidence.nodes[0].nodes[0].text }, value => { delete value.evidence.nodes[0].nodes[0] },
  ]) {
    const s = session(); await prepare(s, 0); const value = checkpoint(0); mutate(value)
    assert.throws(() => s.collector.checkpoint(value), /actual|canonical/)
    assert.equal(s.events.filter(value => value.op === 'dom.checkpoint').length, 0); assert.throws(() => s.collector.flush())
  }
})

test('non-string actual reads and sink failures retain upstream successes and surface the exact failure at flush', async () => {
  const actual = { originalTextObject: true }, invalid = session({ textResult: actual }), page = await invalid.program.reLaunch('/' + routes[0])
  assert.equal(await (await page.$('#source')).text(), actual); assert.equal(await (await page.$('#increment')).tap(), invalid.tapResult)
  assert.throws(() => invalid.collector.flush(), /not a string/)
  for (const op of ['route.active', 'query.text', 'tap', 'dom.checkpoint']) {
    const failure = new Error(`sink ${op}`), s = session({ emitFailure: failure, failEmitWhen: event => event.op === op })
    const actualPage = await s.program.reLaunch('/' + routes[0])
    if (op !== 'route.active') { await (await actualPage.$('#source')).text(); assert.equal(await (await actualPage.$('#increment')).tap(), s.tapResult) }
    if (op === 'dom.checkpoint') assert.throws(() => s.collector.checkpoint(checkpoint(0)), value => value === failure)
    assert.throws(() => s.collector.flush(), value => value === failure); assert.throws(() => s.collector.flush(), value => value === failure)
  }
})

test('failed flush restores wrappers, preserves absent queries and external replacements', async () => {
  const s = session({ ownDescriptors: true }), page = await s.program.reLaunch('/' + routes[0])
  assert.equal(await page.$('#missing'), undefined)
  const source = await page.$('#source'), replacement = async () => 'external replacement'; source.text = replacement
  assert.throws(() => s.collector.flush(), /incomplete/); assert.equal(source.text, replacement)
  for (const { object, key, own } of s.originals.filter(value => value.object !== source || value.key !== 'text')) assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), own)
  assert.throws(() => s.collector.attach(s.program), /incomplete/)
})

test('a replacement transport can continue only at the next real launch boundary', async () => {
  const first = session(); await step(first, 0)
  const next = session({ collector: first.collector })
  await step(next, 1); await step(next, 2); first.collector.flush()
  assert.equal(first.events.filter(value => value.op === 'dom.checkpoint').length, 3)
  assert.equal(Object.getOwnPropertySymbols(first.program).length, 0)
  assert.equal(Object.getOwnPropertySymbols(next.program).length, 0)
})

test('fresh successful queries rebind overlapping selectors without changing the cached object or original methods', async () => {
  const events = [], collector = createCollector({ emit: event => events.push(event) })
  const element = { async text() { return 'actual aliased text' }, async tap() { return 'actual tap' } }
  const original = { text: element.text, tap: element.tap }
  const page = { path: '', async $() { return element } }, program = { async reLaunch(route) { page.path = route.slice(1); return page } }
  collector.attach(program)
  for (let index = 0; index < routes.length; index++) {
    await program.reLaunch('/' + routes[index])
    assert.equal(await page.$('view'), element)
    assert.equal(await page.$('#source'), element); assert.equal(await element.text(), 'actual aliased text')
    assert.equal(await page.$('#increment'), element); assert.equal(await element.tap(), 'actual tap')
    collector.checkpoint(checkpoint(index), { session: program, page })
  }
  collector.flush()
  assert.equal(events.length, 12)
  assert.deepEqual(events.filter(value => value.op === 'query.text').map(value => value.payload.text), Array(3).fill('actual aliased text'))
  assert.deepEqual(collector.diagnostics().acquisitions.slice(0, 3).map(value => [value.selector, value.prior?.selector ?? null, value.accepted]),
    [['view', null, true], ['#source', 'view', true], ['#increment', '#source', true]])
  assert.equal(element.text, original.text); assert.equal(element.tap, original.tap)
})

test('overlapping scoped acquisitions retain scope until a fresh root query succeeds', async () => {
  for (const reacquireRoot of [false, true]) {
    const events = [], collector = createCollector({ emit: event => events.push(event) })
    const source = { async text() { return 'actual shared source node' } }, button = { async tap() { return 'actual tap' } }
    const parent = { async $() { return source } }
    const page = { path: routes[0], async $(selector) { return selector === '#component' ? parent : selector === '#increment' ? button : source } }
    const program = { async reLaunch() { return page } }; collector.attach(program); await program.reLaunch('/' + routes[0])
    assert.equal(await page.$('view'), source)
    assert.equal(await (await page.$('#component')).$('#source'), source)
    await source.text()
    if (reacquireRoot) { assert.equal(await page.$('#source'), source); await source.text() }
    await (await page.$('#increment')).tap()
    assert.equal(events.filter(value => value.op === 'tap').length, reacquireRoot ? 1 : 0)
    assert.throws(() => collector.flush(), reacquireRoot ? /incomplete/ : /no preceding actual source read/)
    const scoped = collector.diagnostics().acquisitions.find(value => value.scope.length)
    assert.deepEqual(scoped.scope, ['#component']); assert.equal(scoped.accepted, true)
  }
})

test('same-generation acquisitions cannot replace a cached Element during an original read or child query', async () => {
  for (const operation of ['text', '$']) {
    const waiting = deferred(), events = [], collector = createCollector({ emit: event => events.push(event) })
    const source = { async text() { return operation === 'text' ? waiting.promise : 'actual text' }, async $() { return waiting.promise } }
    const page = { path: routes[0], async $() { return source } }, program = { async reLaunch() { return page } }
    collector.attach(program); await program.reLaunch('/' + routes[0]); await page.$('#source')
    const pending = source[operation]('#child')
    assert.equal(await page.$('view'), source)
    const result = operation === 'text' ? 'actual pending text' : { actualChildResult: true }
    waiting.resolve(result); assert.equal(await pending, result)
    assert.throws(() => collector.flush(), /pending operation/)
    assert.equal(events.length, 1)
    assert.equal(collector.diagnostics().acquisitions.at(-1).accepted, false)
  }
})

test('a failed overlapping query preserves both rejection and the last successful acquisition', async () => {
  const failure = new Error('actual query rejection'), events = [], collector = createCollector({ emit: event => events.push(event) })
  const source = { async text() { return 'actual original read' } }, button = { async tap() { return 'actual tap' } }
  const page = { path: routes[0], async $(selector) { if (selector === 'view') throw failure; return selector === '#increment' ? button : source } }
  const program = { async reLaunch() { return page } }; collector.attach(program); await program.reLaunch('/' + routes[0])
  await page.$('#source'); await assert.rejects(page.$('view'), value => value === failure)
  await source.text(); await (await page.$('#increment')).tap()
  assert.equal(events.filter(value => value.op === 'tap').length, 1)
  assert.deepEqual(collector.diagnostics().acquisitions.map(value => value.selector), ['#source', '#increment'])
  assert.throws(() => collector.flush(), /incomplete/)
})

test('observed zero counts remain zero; the collector never synthesizes matching nodes', async () => {
  const s = session(); await prepare(s, 0)
  const value = checkpoint(0); value.evidence.nodes[1].count = 0; value.evidence.nodes[1].nodes = []
  s.collector.checkpoint(value)
  assert.deepEqual(s.events.at(-1).payload.nodes[1], { selector: '#increment', query: 'css', count: 0, nodes: [] })
  await step(s, 1); await step(s, 2); s.collector.flush()
})

// The pinned SDK Page.create keeps a Page for a reused protocol id, updates
// its route, and leaves its elementMap intact. Element.create returns cached
// objects by elementId. A fresh successful query is the acquisition boundary.
function cachedTransport(options = {}) {
  const events = [], collector = options.collector ?? createCollector({ emit: value => events.push(value) })
  const elements = new Map(), originals = []
  const page = { path: '', async $(selector, opts) {
    if (opts?.wait) return opts.wait
    if (!elements.has(selector)) {
      const element = {
        async text() { return options.read?.(page.path, selector) ?? `actual cached ${page.path} ${selector}` },
        async tap() { return options.tapResult ?? 'actual cached tap' },
      }
      originals.push({ element, text: element.text, tap: element.tap }); elements.set(selector, element)
    }
    return elements.get(selector)
  } }
  const program = { async reLaunch(route) { await options.launch?.(route); page.path = route.slice(1); return page } }
  collector.attach(program)
  const completeStep = async index => {
    const actual = await program.reLaunch('/' + routes[index])
    const source = await actual.$('#source'), text = await source.text()
    const button = await actual.$('#increment'); await button.tap()
    collector.checkpoint(checkpoint(index), { session: program, page: actual })
    return { page: actual, source, button, text }
  }
  return { collector, events, program, page, elements, originals, completeStep }
}

test('fresh query acquisitions follow exact cached Page and Element objects through all completed launches', async () => {
  const s = cachedTransport(), records = []
  for (let at = 0; at < 3; at++) records.push(await s.completeStep(at))
  s.collector.flush()
  assert.equal(records[0].page, records[1].page)
  assert.equal(records[0].source, records[1].source)
  assert.equal(records[0].button, records[2].button)
  assert.deepEqual(s.events.filter(value => value.op === 'query.text').map(value => value.payload.text), records.map(value => value.text))
  assert.equal(s.events.length, 12)
  const diagnostics = s.collector.diagnostics()
  assert.equal(diagnostics.kind, 'issue1034-actual-query-acquisitions-v1')
  assert.deepEqual(diagnostics.acquisitions.map(value => [value.epoch, value.prior?.epoch ?? null, value.accepted]),
    [[1, null, true], [1, null, true], [2, 1, true], [2, 1, true], [3, 2, true], [3, 2, true]])
  diagnostics.acquisitions[0].route = 'external mutation'
  assert.equal(s.collector.diagnostics().acquisitions[0].route, routes[0])
  for (const { element, text, tap } of s.originals) { assert.equal(element.text, text); assert.equal(element.tap, tap) }
})

test('cached objects without a new actual query retain their obsolete acquisition', async () => {
  for (const method of ['text', 'tap']) {
    const s = cachedTransport(), first = await s.completeStep(0)
    await s.program.reLaunch('/' + routes[1])
    if (method === 'text') assert.equal(await first.source.text(), `actual cached ${routes[1]} #source`)
    else assert.equal(await first.button.tap(), 'actual cached tap')
    assert.equal(s.events.filter(value => value.op === 'tap').length, 1)
    assert.throws(() => s.collector.flush(), /another Page generation|another actual Page generation/)
  }
})

test('a pending read cannot be rebound to a later cached Page generation', async () => {
  const read = deferred(); let hold = false
  const s = cachedTransport({ read: (route, selector) => hold && selector === '#source' ? read.promise : `actual ${route} ${selector}` })
  const first = await s.completeStep(0)
  hold = true; const pending = first.source.text()
  await s.program.reLaunch('/' + routes[1])
  assert.equal(await s.page.$('#source'), first.source)
  read.resolve('unchanged pending read'); assert.equal(await pending, 'unchanged pending read')
  assert.equal(s.events.length, 5)
  assert.throws(() => s.collector.flush(), /pending operation/)
})

test('a delayed old query cannot overwrite a new successful cached acquisition', async () => {
  const s = cachedTransport(), first = await s.completeStep(0), wait = deferred()
  const delayed = s.page.$('#source', { wait: wait.promise })
  await s.program.reLaunch('/' + routes[1])
  assert.equal(await s.page.$('#source'), first.source)
  wait.resolve(first.source); assert.equal(await delayed, first.source)
  assert.throws(() => s.collector.flush(), /current observed Page acquisition/)
  assert.equal(s.events.length, 5)
})

test('a cached Element cannot move to another actual program owner after a completed checkpoint', async () => {
  const s = cachedTransport(), first = await s.completeStep(0)
  const page = { path: routes[1], async $(selector) { return selector === '#source' ? first.source : first.button } }
  const program = { async reLaunch() { return page } }; s.collector.attach(program)
  await program.reLaunch('/' + routes[1])
  assert.equal(await page.$('#source'), first.source)
  assert.throws(() => s.collector.flush(), /acquisition crosses an owner/)
  assert.equal(s.events.length, 5)
})

test('complete coverage cannot flush while a detached original read or launch is still pending', async () => {
  for (const operation of ['text', 'reLaunch']) {
    const deferredCall = deferred(); let hold = false
    const s = cachedTransport({
      read: () => hold && operation === 'text' ? deferredCall.promise : 'actual settled read',
      launch: () => hold && operation === 'reLaunch' ? deferredCall.promise : undefined,
    })
    for (let at = 0; at < 3; at++) await s.completeStep(at)
    hold = true
    const pending = operation === 'text' ? s.elements.get('#source').text() : s.program.reLaunch('/' + routes[2])
    assert.throws(() => s.collector.flush(), /incomplete/)
    const result = { originalDetachedResult: true }; deferredCall.resolve(result)
    assert.equal(await pending, operation === 'text' ? result : s.page)
    assert.equal(s.events.length, 12)
    assert.throws(() => s.collector.flush(), /incomplete/)
  }
})
