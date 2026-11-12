import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollector } from './wxml-transform-collector.mjs'
import { descriptor } from './wxml-transform-descriptor.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const checkpoint = (route, id) => ({ evidence: { id, route,
  nodes: descriptor.checkpoints.find(value => value.id === id).selectors.map(selector => ({ selector, query: 'css', count: 1,
    nodes: [{ text: `actual checkpoint ${route} ${id} ${selector}` }] })) } })

function session({ cached = false, attrOnly = false, queryResult, readResult, tapResult = { actualTap: true }, emitFailure, alias = false } = {}) {
  const events = [], operations = [], originals = [], cachedElements = new Map(), allPages = []
  const collector = createCollector({ emit(event) { if (emitFailure?.(event)) throw emitFailure(event); events.push(structuredClone(event)) } })
  const remember = (object, keys) => { for (const key of keys) originals.push({ object, key, own: Object.getOwnPropertyDescriptor(object, key), original: object[key] }); return object }
  let currentPage
  const makeElement = (page, selector) => {
    const element = {
      async $(child, options) { operations.push({ op: 'child', selector, child }); return options?.result ?? makeElement(page, child) },
      async text(...args) { operations.push({ op: 'text', selector, args }); return readResult ? readResult('text', selector, undefined, page) : `actual untrimmed ${page.path} ${selector}\n` },
      async [attrOnly ? 'attr' : 'attribute'](name, ...args) { operations.push({ op: 'attribute', selector, name, args });
        return readResult ? readResult('attribute', selector, name, page) : `actual attribute ${page.path} ${selector} ${name}` },
      async tap(...args) { operations.push({ op: 'tap', selector, args }); return typeof tapResult === 'function' ? tapResult(page, selector) : tapResult },
    }
    return remember(element, Object.keys(element))
  }
  const makePage = () => {
    const elements = cachedElements
    const page = remember({ path: '', pageId: 417,
      async $(selector, ...args) {
        operations.push({ op: 'query', route: this.path, selector, args })
        if (queryResult) { const result = queryResult(selector, page, args); if (result !== session.DEFAULT) return result }
        if (selector === '[data-remove-subtree]') return null
        const key = alias ? 'one-object' : selector
        if (!cached || !elements.has(key)) elements.set(key, makeElement(page, selector))
        return elements.get(key)
      },
      async $$(selector) { operations.push({ op: 'queryAll', selector }); return [makeElement(page, selector)] },
    }, ['$', '$$'])
    allPages.push(page); return page
  }
  const page = cached ? makePage() : undefined
  const program = remember({
    async reLaunch(route, options) {
      operations.push({ op: 'reLaunch', route })
      currentPage = cached ? page : makePage()
      currentPage.path = route.replace(/^\//, '')
      return options?.result ?? currentPage
    },
    async currentPage(...args) { operations.push({ op: 'currentPage', args }); return currentPage },
  }, ['reLaunch', 'currentPage'])
  collector.attach(program)
  return { collector, program, events, operations, originals, allPages, cachedElements, tapResult }
}
session.DEFAULT = Symbol('default-provider-result')

async function direct(s, page, { start = 0, end = descriptor.direct.length } = {}) {
  const elements = new Map()
  for (const item of descriptor.direct.slice(start, end)) {
    if (item.op === 'query') elements.set(item.selector, await page.$(item.selector))
    else {
      const element = elements.get(item.selector) ?? s.cachedElements.get(item.selector)
      if (item.op === 'attribute') await (element.attribute ?? element.attr).call(element, item.name)
      else await element[item.op]()
    }
  }
  return elements
}
async function route(s, index) {
  const actual = descriptor.routes[index], page = await s.program.reLaunch('/' + actual)
  s.collector.checkpoint(checkpoint(actual, 'transformed'), { session: s.program, page })
  await direct(s, page)
  // The unchanged DOM helper performs currentPage and $$ reads before emit.
  assert.equal(await s.program.currentPage(), page)
  for (const selector of ['#result']) for (const element of await page.$$(selector)) await element.text()
  s.collector.checkpoint(checkpoint(actual, 'event'), { session: s.program, page })
  return page
}

test('both complete route bodies retain 16 actual direct values, strict null queries and separate actual navigation/state', async () => {
  const s = session()
  for (let index = 0; index < 2; index++) await route(s, index)
  s.collector.flush()
  assert.equal(s.events.length, 36)
  assert.equal(s.events.filter(value => value.op === 'query.attribute').length, 14)
  assert.equal(s.events.filter(value => value.op === 'query.text').length, 2)
  assert.equal(s.events.filter(value => value.op === 'query.result').length, 10)
  assert.deepEqual(s.events.filter(value => value.op === 'query.result' && value.payload.selector === '[data-remove-subtree]').map(value => value.payload.result), [{ type: 'null' }, { type: 'null' }])
  assert.equal(s.events.filter(value => value.op === 'query.text')[0].payload.value.value.endsWith('\n'), true)
  assert.deepEqual(s.events.filter(value => value.op === 'route.reLaunch').map(value => value.payload), descriptor.routes.map(route => ({ route, requested: '/' + route })))
  assert.deepEqual(s.events.filter(value => value.op === 'route.active').map(value => value.payload.route), descriptor.routes)
  for (const entry of s.originals) {
    assert.equal(entry.object[entry.key], entry.original)
    assert.deepEqual(Object.getOwnPropertyDescriptor(entry.object, entry.key), entry.own)
  }
})

test('all typed scalar values are actual, preserving undefined/null/empty/multibyte strings without missing fields', async () => {
  const values = [undefined, null, '', 'arbitrary 中文 & " \' \\ {{actual}}']
  for (const value of values) {
    const s = session({ readResult: () => value })
    for (let index = 0; index < 2; index++) await route(s, index)
    s.collector.flush()
    const actual = s.events.filter(event => ['query.attribute', 'query.text'].includes(event.op)).map(event => event.payload.value)
    assert.equal(actual.length, 16)
    const expected = value === undefined ? { type: 'undefined' } : value === null ? { type: 'null' } : { type: 'string', value }
    for (const item of actual) assert.deepEqual(item, expected)
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), actual)
  }
})

test('null and undefined Page query results remain distinct and are never inferred from a missing field', async () => {
  for (const value of [null, undefined]) {
    const s = session({ queryResult: selector => selector === '[data-remove-subtree]' ? value : session.DEFAULT })
    for (let index = 0; index < 2; index++) await route(s, index)
    s.collector.flush()
    assert.deepEqual(s.events.filter(event => event.payload.selector === '[data-remove-subtree]').map(event => event.payload.result),
      [{ type: value === null ? 'null' : 'undefined' }, { type: value === null ? 'null' : 'undefined' }])
  }
})

test('actual attr fallback and cached Page/Element reuse retain the same normalized observation surface', async () => {
  const s = session({ cached: true, attrOnly: true })
  const first = await route(s, 0), element = s.cachedElements.get('view#renamed')
  assert.equal(await route(s, 1), first)
  assert.equal(s.cachedElements.get('view#renamed'), element)
  s.collector.flush()
  assert.equal(s.events.length, 36)
  assert.equal(s.events.filter(event => event.op === 'query.attribute').length, 14)
})

test('helper warmup navigation is retained as an actual command and is never reconstructed from route.active', async () => {
  const s = session({ cached: true })
  await s.program.reLaunch('/' + descriptor.routes[0])
  await s.program.currentPage()
  await route(s, 0); await route(s, 1)
  s.collector.flush()
  assert.equal(s.events.filter(event => event.op === 'route.reLaunch').length, 3)
  assert.equal(s.events.filter(event => event.op === 'route.active').length, 2)
})

test('checkpoints alone cannot replace omitted direct attributes, nested text, query absence or tap', async () => {
  for (let omit = 0; omit < descriptor.direct.length; omit++) {
    const s = session(), page = await s.program.reLaunch('/' + descriptor.routes[0])
    s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
    if (omit > 0) await direct(s, page, { end: omit })
    assert.throws(() => s.collector.checkpoint(checkpoint(descriptor.routes[0], 'event')), /incomplete/)
    assert.throws(() => s.collector.flush(), /incomplete/)
  }
})

test('renamed field reads from another selector, field name, argument shape or nested scope cannot satisfy coverage', async () => {
  for (const scenario of ['selector', 'field', 'args', 'scope']) {
    const s = session(), page = await s.program.reLaunch('/' + descriptor.routes[0])
    s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
    const element = await page.$(scenario === 'selector' ? '#retained' : 'view#renamed')
    if (scenario === 'scope') await element.$('view#renamed')
    else await element.attribute(scenario === 'field' ? 'data-number' : 'data-literal', ...(scenario === 'args' ? ['extra'] : []))
    assert.throws(() => s.collector.flush(), /interval|scope|argument/)
  }
})

test('wrong order, unknown route, duplicate checkpoint and a forged context are rejected without rendered events', async () => {
  for (const scenario of ['route', 'id', 'context', 'missing-launch']) {
    const s = session(), page = await s.program.reLaunch('/' + (scenario === 'route' ? 'pages/unknown/index' : descriptor.routes[0]))
    if (scenario === 'missing-launch') page.path = descriptor.routes[1]
    assert.throws(() => s.collector.checkpoint(checkpoint(descriptor.routes[0], scenario === 'id' ? 'event' : 'transformed'),
      scenario === 'context' ? { session: {}, page } : undefined), /route|checkpoint|session/)
    assert.equal(s.events.filter(event => event.op === 'dom.checkpoint').length, 0)
    assert.throws(() => s.collector.flush())
  }
  const s = session(), page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  assert.throws(() => s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed')), /reordered|duplicated/)
  assert.throws(() => s.collector.flush())
})

test('query modes, component scopes, missing text, sparse nodes and invalid counts cannot replace actual checkpoint structure', async () => {
  for (const mutate of [
    value => { value.evidence.nodes[0].query = 'xpath' },
    value => { value.evidence.nodes[0].scope = ['#component'] },
    value => { value.evidence.nodes[0].has = '#child' },
    value => { value.evidence.nodes[0].count = -1 },
    value => { value.evidence.nodes[0].count = 2 },
    value => { delete value.evidence.nodes[0].nodes[0].text },
    value => { delete value.evidence.nodes[0].nodes[0] },
    value => { delete value.evidence.nodes[0] },
  ]) {
    const s = session(); await s.program.reLaunch('/' + descriptor.routes[0]); const value = checkpoint(descriptor.routes[0], 'transformed'); mutate(value)
    assert.throws(() => s.collector.checkpoint(value), /query|scope|text|missing/)
    assert.equal(s.events.filter(event => event.op === 'dom.checkpoint').length, 0)
    assert.throws(() => s.collector.flush())
  }
})

test('a successful duplicate tap retains its provider result but cannot disappear after the source interval closes', async () => {
  const s = session({ cached: true }), page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  await direct(s, page)
  assert.equal(await s.cachedElements.get('#tap').tap(), s.tapResult)
  assert.equal(s.events.filter(event => event.op === 'tap').length, 1)
  assert.throws(() => s.collector.flush(), /interval/)
})

test('an old cached Element cannot supply next-generation direct observations until queried again', async () => {
  const s = session({ cached: true }); await route(s, 0)
  const old = s.cachedElements.get('view#renamed')
  await s.program.reLaunch('/' + descriptor.routes[1])
  s.collector.checkpoint(checkpoint(descriptor.routes[1], 'transformed'))
  await old.attribute('data-literal')
  assert.equal(s.events.filter(event => event.op === 'query.attribute').length, 7)
  assert.throws(() => s.collector.flush(), /interval|stale/)
})

test('same-generation aliasing across selectors is rejected while original query and read results are preserved', async () => {
  const s = session({ cached: true, alias: true }), page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  await direct(s, page, { end: 5 })
  const original = s.cachedElements.get('one-object')
  assert.equal(await page.$('#retained'), original)
  assert.equal(typeof await original.attribute('data-testid'), 'string')
  assert.throws(() => s.collector.flush(), /aliased/)
})

test('read completion cannot borrow a later cached Element acquisition or navigation generation', async () => {
  const wait = deferred(), s = session({ cached: true, readResult: () => wait.promise }), page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  const element = await page.$('view#renamed'), pending = element.attribute('data-literal')
  assert.equal(await page.$('view#renamed'), element)
  wait.resolve('actual delayed read')
  assert.equal(await pending, 'actual delayed read')
  assert.equal(s.events.filter(event => event.op === 'query.attribute').length, 0)
  assert.throws(() => s.collector.flush(), /interval|stale/)
})

test('an older query completion cannot overwrite a newer acquisition of the same cached actual Element', async () => {
  const wait = deferred()
  const s = session({ cached: true, queryResult: (selector, page, args) => args[0]?.delayed ? wait.promise : session.DEFAULT })
  const page = await s.program.reLaunch('/' + descriptor.routes[0])
  const older = page.$('view#renamed', { delayed: true }), current = await page.$('view#renamed')
  wait.resolve(current)
  assert.equal(await older, current)
  assert.throws(() => s.collector.flush(), /older query/)
})

test('pending direct work cannot supply evidence after the underlying provider changes its route', async () => {
  const wait = deferred(), s = session({ cached: true, readResult: () => wait.promise })
  const page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  const element = await page.$('view#renamed'), read = element.attribute('data-literal')
  assert.equal(await s.program.reLaunch('/' + descriptor.routes[1]), page)
  wait.resolve('actual original completed read')
  assert.equal(await read, 'actual original completed read')
  assert.equal(s.events.filter(event => event.op === 'route.reLaunch').length, 1)
  assert.equal(s.events.filter(event => event.op === 'query.attribute').length, 0)
  assert.throws(() => s.collector.flush(), /interval/)
})

test('unsupported actual non-string read values retain their identity and cannot become normalized evidence', async () => {
  const actual = { originalProviderObject: true }, s = session({ readResult: () => actual })
  const page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  const element = await page.$('view#renamed')
  assert.equal(await element.attribute('data-literal'), actual)
  assert.equal(s.events.filter(event => event.op === 'query.attribute').length, 0)
  assert.throws(() => s.collector.flush(), /profile/)
})

test('original query/read/tap rejection objects propagate unchanged and cannot produce successful normalized operations', async () => {
  const expected = new Error('actual original rejection')
  const s = session({ readResult: () => Promise.reject(expected) }), page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  const element = await page.$('view#renamed')
  await assert.rejects(element.attribute('data-literal'), error => error === expected)
  assert.equal(s.events.filter(event => event.op === 'query.attribute').length, 0)
  assert.throws(() => s.collector.flush(), /incomplete/)
  const q = session({ queryResult: () => Promise.reject(expected) }), qp = await q.program.reLaunch('/' + descriptor.routes[0])
  q.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  await assert.rejects(qp.$('view#renamed'), error => error === expected)
  assert.equal(q.events.filter(event => event.op === 'query.result').length, 0)
  assert.throws(() => q.collector.flush(), /incomplete/)
  const t = session({ tapResult: () => Promise.reject(expected) }), tp = await t.program.reLaunch('/' + descriptor.routes[0])
  t.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  await direct(t, tp, { end: 13 })
  await assert.rejects(t.cachedElements.get('#tap').tap(), error => error === expected)
  assert.equal(t.events.filter(event => event.op === 'tap').length, 0)
  assert.throws(() => t.collector.flush(), /incomplete/)
})

test('observer failure is sticky while original successful read and tap values remain authoritative', async () => {
  const original = new Error('actual sink failure')
  const s = session({ emitFailure: event => event.op === 'query.attribute' ? original : undefined }), page = await s.program.reLaunch('/' + descriptor.routes[0])
  s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'))
  const element = await page.$('view#renamed'), actual = await element.attribute('data-literal')
  assert.equal(typeof actual, 'string')
  assert.throws(() => s.collector.flush(), error => error === original)
  assert.throws(() => s.collector.flush(), error => error === original)
})

test('source coverage descriptor contains field names and structure only, and test values never enter it', () => {
  const fields = new Set(['op', 'selector', 'name'])
  assert.equal(descriptor.direct.length, 14)
  for (const step of descriptor.direct) assert.ok(Object.keys(step).every(key => fields.has(key)))
  assert.equal(JSON.stringify(descriptor).includes('actual attribute'), false)
  assert.equal(JSON.stringify(descriptor).includes('1:track'), false)
})

test('incomplete flush restores owned descriptors, retains external replacements, and forbids foreign transports', async () => {
  const s = session(), page = await s.program.reLaunch('/' + descriptor.routes[0]), element = await page.$('view#renamed')
  const replacement = async () => 'external replacement'
  element.attribute = replacement
  assert.throws(() => s.collector.flush(), /incomplete/)
  assert.equal(element.attribute, replacement)
  for (const entry of s.originals.filter(value => value.object !== element || value.key !== 'attribute')) {
    assert.equal(entry.object[entry.key], entry.original)
    assert.deepEqual(Object.getOwnPropertyDescriptor(entry.object, entry.key), entry.own)
  }
  const other = session()
  assert.throws(() => other.collector.attach({ async reLaunch() {}, async currentPage() {} }), /different.*transports/)
  assert.throws(() => other.collector.flush(), /different.*transports/)
})


test('malformed actual checkpoint route is sticky through later valid coverage attempts and flush', async () => {
  const s = session(); await s.program.reLaunch('/' + descriptor.routes[0])
  const malformed = checkpoint(descriptor.routes[0], 'transformed'); malformed.evidence.route += '?invalid=1'
  let original
  try { s.collector.checkpoint(malformed) } catch (error) { original = error }
  assert.match(original?.message, /malformed/)
  assert.throws(() => s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed')), error => error === original)
  assert.equal(s.events.filter(event => event.op === 'dom.checkpoint').length, 0)
  assert.throws(() => s.collector.flush(), error => error === original)
  assert.throws(() => s.collector.flush(), error => error === original)
})

test('throwing actual checkpoint context getter is sticky and preserves its original thrown identity', async () => {
  const s = session(), page = await s.program.reLaunch('/' + descriptor.routes[0]), original = new Error('actual original context getter failure')
  const context = { page, session: new Proxy({}, { get() { throw original } }) }
  assert.throws(() => s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed'), context), error => error === original)
  assert.throws(() => s.collector.checkpoint(checkpoint(descriptor.routes[0], 'transformed')), error => error === original)
  assert.equal(s.events.filter(event => event.op === 'dom.checkpoint').length, 0)
  assert.throws(() => s.collector.flush(), error => error === original)
  assert.throws(() => s.collector.flush(), error => error === original)
})
