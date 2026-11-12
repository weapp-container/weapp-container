import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCollector } from './issue1012-collector.mjs'
import { descriptor } from './issue1012-descriptor.mjs'

const route = 'pages/issue-1012/index', selector = '#issue1012-run'
const queries = ['#issue1012-map-result', '#issue1012-results']
const checkpoint = (id, texts = ['observed native value A', 'observed native value B']) => ({ evidence: {
  id, route, source: 'synthetic-unit-test-only', capturedAt: 'unit-test-only',
  nodes: queries.map((selector, index) => ({ selector, query: 'css', count: 1, nodes: [{ text: texts[index] }] })),
} })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function session({ launchFailure, currentFailure, queryFailure, tapFailure, tapResult = { originalTap: true },
  queryResult, emitFailure, failEmitWhen = () => true, ownDescriptors = false, aliasPage = false } = {}) {
  const events = [], operations = [], originals = []
  const collector = createCollector({ emit(event) { if (emitFailure && failEmitWhen(event)) throw emitFailure; events.push(event) } })
  const remember = (object, keys) => {
    for (const key of keys) originals.push({ object, key, descriptor: Object.getOwnPropertyDescriptor(object, key), value: object[key] })
    return object
  }
  const element = (scope, name) => {
    if (name === '#missing') return null
    return remember(Object.create({
      async $(child, ...args) {
        operations.push({ op: 'child.query', receiver: this, scope, selector: child, args })
        return element([...scope, name], child)
      },
      async tap(...args) {
        operations.push({ op: 'tap', receiver: this, scope, selector: name, args })
        if (tapFailure) throw tapFailure
        return tapResult
      },
    }), ['$', 'tap'])
  }
  let pageId = 41
  const makePage = (path = route) => remember(Object.assign(Object.create({
    async $(name, ...args) {
      operations.push({ op: 'query', receiver: this, selector: name, args })
      if (queryFailure) throw queryFailure
      return queryResult === undefined ? element([], name) : queryResult
    },
  }), { path, pageId }), ['$'])
  let page = makePage()
  const methods = {
    async currentPage(...args) {
      operations.push({ op: 'currentPage', receiver: this, args })
      if (currentFailure) throw currentFailure
      if (aliasPage) page = makePage(page.path)
      return page
    },
    async reLaunch(path, ...args) {
      operations.push({ op: 'reLaunch', receiver: this, path, args })
      if (launchFailure) throw launchFailure
      pageId++
      page = makePage(path.replace(/^\//, ''))
      return page
    },
  }
  const program = ownDescriptors ? {} : Object.create(methods)
  if (ownDescriptors) for (const [name, value] of Object.entries(methods)) Object.defineProperty(program, name, {
    configurable: true, enumerable: true, writable: false, value,
  })
  remember(program, ['currentPage', 'reLaunch'])
  const symbols = Object.getOwnPropertySymbols(program)
  collector.attach(program)
  return { collector, program, events, operations, originals, tapResult, symbols }
}
const check = (s, id, page, values) => s.collector.checkpoint(checkpoint(id, values), { session: s.program, page })
async function initial(s, acquisition = 'currentPage') {
  const page = await s.program[acquisition]('/' + route)
  check(s, 'initial', page)
  return page
}
async function complete(s, acquisition = 'currentPage') {
  const page = await initial(s, acquisition)
  const button = await page.$(selector)
  assert.equal(await button.tap(), await s.tapResult)
  check(s, 'executed', page, ['actual post-action A', 'actual post-action B'])
  s.collector.flush()
  return page
}

test('observes both unchanged-helper currentPage reuse and reLaunch without driving the provider or supplying expected text', async () => {
  for (const acquisition of ['currentPage', 'reLaunch']) {
    const s = session()
    assert.deepEqual(s.operations, [])
    await complete(s, acquisition)
    assert.deepEqual(s.operations.map(value => value.op), [acquisition, 'query', 'tap'])
    assert.deepEqual(s.events.map(value => value.op), ['route.active', 'dom.checkpoint', 'tap', 'dom.checkpoint'])
    assert.deepEqual(s.events[0].payload, { route })
    assert.deepEqual(s.events[2].payload, { route, selector })
    assert.deepEqual(s.events[1].payload.nodes.map(group => group.nodes[0].text), ['observed native value A', 'observed native value B'])
    assert.deepEqual(s.events[3].payload.nodes.map(group => group.nodes[0].text), ['actual post-action A', 'actual post-action B'])
    assert.ok(!JSON.stringify(s.events).includes('pending'))
    assert.ok(!JSON.stringify(s.events).includes('capturedAt'))
  }
})

test('preserves receivers, arguments and exact completed guest values, and snapshots evidence before later mutation', async () => {
  const s = session(), options = { originalOptions: true }, gesture = { originalGesture: true }
  const page = await s.program.currentPage(options), value = checkpoint('initial')
  s.collector.checkpoint(value, { session: s.program, page })
  value.evidence.nodes[0].nodes[0].text = 'mutation after observation'
  const button = await page.$(selector, options)
  assert.equal(await button.tap(gesture), s.tapResult)
  check(s, 'executed', page)
  s.collector.flush()
  assert.equal(s.events[1].payload.nodes[0].nodes[0].text, 'observed native value A')
  assert.equal(s.operations[0].receiver, s.program); assert.equal(s.operations[0].args[0], options)
  assert.equal(s.operations[1].receiver, page); assert.equal(s.operations[1].args[0], options)
  assert.equal(s.operations[2].receiver, button); assert.equal(s.operations[2].args[0], gesture)
})

test('accepts actual currentPage aliases with the same runtime pageId while requiring the observed session', async () => {
  const s = session({ aliasPage: true }), page = await initial(s), alias = await s.program.currentPage()
  assert.notEqual(alias, page)
  assert.equal(alias.pageId, page.pageId)
  await (await page.$(selector)).tap()
  check(s, 'executed', alias)
  s.collector.flush()
  const wrong = session(), wrongPage = await wrong.program.currentPage()
  assert.throws(() => wrong.collector.checkpoint(checkpoint('initial'), { session: {}, page: wrongPage }), /session/)
  assert.throws(() => wrong.collector.flush(), /session/)
})

test('binds the unchanged pinned recoverableSession Proxy to its real observed transport and removes private ownership on flush', async () => {
  const { createRecoverableSession } = await import('../../vendor/weapp-vite/e2e/utils/recoverableSession.ts')
  const s = session(), recovering = createRecoverableSession(s.program), proxy = recovering.session
  const page = await proxy.currentPage()
  s.collector.checkpoint(checkpoint('initial'), { session: proxy, page })
  assert.equal(await (await page.$(selector)).tap(), s.tapResult)
  s.collector.checkpoint(checkpoint('executed'), { session: proxy, page })
  s.collector.flush()
  assert.deepEqual(s.events.map(value => value.op), ['route.active', 'dom.checkpoint', 'tap', 'dom.checkpoint'])
  assert.deepEqual(Object.getOwnPropertySymbols(s.program), s.symbols)

  const invalid = session(), old = createRecoverableSession(invalid.program), previous = await old.session.currentPage()
  invalid.collector.checkpoint(checkpoint('initial'), { session: old.session, page: previous })
  old.replace({ async currentPage() { return previous } })
  assert.throws(() => invalid.collector.checkpoint(checkpoint('executed'), { session: old.session, page: previous }), /session/)
  assert.throws(() => invalid.collector.flush(), /session/)
  assert.deepEqual(Object.getOwnPropertySymbols(invalid.program), invalid.symbols)
})

test('supports the existing native reLaunch-only Page shape without a pageId or separate checkpoint context', async () => {
  const events = [], result = { originalNativeTap: true }, page = { path: route,
    async $() { return { async tap() { return result } } } }
  const program = { async reLaunch() { return page } }, collector = createCollector({ emit: event => events.push(event) })
  collector.attach(program)
  assert.equal(await program.reLaunch('/' + route), page)
  collector.checkpoint(checkpoint('initial'))
  assert.equal(await (await page.$(selector)).tap(), result)
  collector.checkpoint(checkpoint('executed'))
  collector.flush()
  assert.equal(events.length, 4)
  assert.equal(Object.getOwnPropertySymbols(program).length, 0)
})

test('restores inherited and non-writable own descriptors; attachment and successful flush are idempotent', async () => {
  for (const ownDescriptors of [false, true]) {
    const s = session({ ownDescriptors }), wrapped = s.program.currentPage
    s.collector.attach(s.program)
    assert.equal(s.program.currentPage, wrapped)
    await complete(s)
    s.collector.flush()
    for (const { object, key, descriptor, value } of s.originals) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
      assert.equal(object[key], value)
    }
    assert.deepEqual(Object.getOwnPropertySymbols(s.program), s.symbols)
    assert.throws(() => s.collector.attach(s.program), /open actual/)
  }
})

test('preserves original currentPage, reLaunch, query and tap rejection identities and invents no successful action', async () => {
  for (const operation of ['current', 'launch', 'query', 'tap']) {
    const error = new Error(`original ${operation} rejection`), s = session({ [`${operation}Failure`]: error })
    if (operation === 'current') await assert.rejects(s.program.currentPage(), caught => caught === error)
    else if (operation === 'launch') await assert.rejects(s.program.reLaunch('/' + route), caught => caught === error)
    else {
      const page = await initial(s)
      if (operation === 'query') await assert.rejects(page.$(selector), caught => caught === error)
      else await assert.rejects((await page.$(selector)).tap(), caught => caught === error)
    }
    assert.equal(s.events.filter(value => value.op === 'tap').length, 0)
    assert.throws(() => s.collector.flush(), /incomplete/)
  }
})

test('rejects missing, reordered, duplicated checkpoints and taps without changing completed guest results', async () => {
  const empty = session()
  assert.throws(() => empty.collector.flush(), /incomplete/)
  const noPage = session()
  assert.throws(() => noPage.collector.checkpoint(checkpoint('initial')), /actual Page/)
  for (const scenario of ['reordered', 'missing-tap', 'duplicate-initial', 'early-tap', 'duplicate-tap', 'wrong-selector', 'nested-scope']) {
    const s = session(), page = await s.program.currentPage()
    if (scenario === 'reordered') assert.throws(() => check(s, 'executed', page), /out of order/)
    else if (scenario === 'early-tap') assert.equal(await (await page.$(selector)).tap(), s.tapResult)
    else {
      check(s, 'initial', page)
      if (scenario === 'missing-tap') assert.throws(() => check(s, 'executed', page), /successful tap/)
      else if (scenario === 'duplicate-initial') assert.throws(() => check(s, 'initial', page), /duplicated/)
      else {
        const button = scenario === 'nested-scope' ? await (await page.$('#component')).$(selector)
          : await page.$(scenario === 'wrong-selector' ? '#another-action' : selector)
        assert.equal(await button.tap(), s.tapResult)
        if (scenario === 'duplicate-tap') assert.equal(await button.tap(), s.tapResult)
      }
    }
    assert.throws(() => s.collector.flush(), /checkpoint|scope|tap|order/)
  }
})

test('cannot retrospectively admit a tap started before the initial checkpoint', async () => {
  const pending = deferred(), s = session({ tapResult: pending.promise }), page = await s.program.currentPage()
  const tapping = (await page.$(selector)).tap()
  check(s, 'initial', page)
  const actual = { originalDelayedResult: true }; pending.resolve(actual)
  assert.equal(await tapping, actual)
  assert.equal(s.events.filter(value => value.op === 'tap').length, 0)
  assert.throws(() => s.collector.flush(), /interval/)
})

test('old Page, query and pending tap generations cannot complete after another reLaunch, including reused Page objects', async () => {
  for (const scenario of ['old-page', 'old-query', 'pending-tap', 'reused-page']) {
    const pending = deferred(), s = session(scenario === 'old-query' ? { queryResult: pending.promise }
      : scenario === 'pending-tap' ? { tapResult: pending.promise } : {})
    let page = await initial(s), action
    if (scenario === 'old-query') action = page.$(selector)
    else if (scenario === 'pending-tap') action = (await page.$(selector)).tap()
    if (scenario === 'reused-page') {
      const original = async () => page
      const program = { reLaunch: original }
      s.collector.attach(program)
      await program.reLaunch('/' + route)
    } else await s.program.reLaunch('/' + route)
    if (scenario === 'old-query') {
      const raw = { async tap() { return s.tapResult } }; pending.resolve(raw)
      assert.equal(await action, raw)
      assert.equal(await raw.tap(), s.tapResult)
    } else if (scenario === 'pending-tap') {
      const actual = { originalDelayedTap: true }; pending.resolve(actual); assert.equal(await action, actual)
    } else assert.equal(await (await page.$(selector)).tap(), s.tapResult)
    assert.equal(s.events.filter(value => value.op === 'tap').length, 0)
    assert.throws(() => s.collector.flush(), /generation|page/i)
  }
})

test('malformed routes, missing/reordered queries, sparse evidence and unexpected scopes fail before emitting a checkpoint', async () => {
  for (const mutate of [
    value => { value.evidence.route = 'pages/other/index' },
    value => { value.evidence.route = 'pages//issue-1012/index' },
    value => { value.evidence.route = route + '?query=1' },
    value => { value.evidence.nodes.reverse() },
    value => { value.evidence.nodes = [] },
    value => { delete value.evidence.nodes[0] },
    value => { value.evidence.nodes[0].count = -1 },
    value => { value.evidence.nodes[0].count = 2 },
    value => { value.evidence.nodes[0].query = 'xpath' },
    value => { value.evidence.nodes[0].has = '#descendant' },
    value => { value.evidence.nodes[0].scope = null },
    value => { value.evidence.nodes[0].scope = ['#component'] },
    value => { delete value.evidence.nodes[0].nodes[0] },
    value => { delete value.evidence.nodes[0].nodes[0].text },
    value => { value.evidence.nodes[0].nodes[0].text = 7 },
  ]) {
    const s = session(), page = await s.program.currentPage(), value = checkpoint('initial')
    mutate(value)
    assert.throws(() => s.collector.checkpoint(value, { session: s.program, page }), /actual|route|scope/i)
    assert.deepEqual(s.events, [])
    assert.throws(() => s.collector.flush())
  }
})

test('forwards actual node counts and observed text rather than filling original expected values', async () => {
  const s = session(), page = await s.program.currentPage(), value = checkpoint('initial')
  value.evidence.nodes[0] = { selector: queries[0], query: 'css', count: 0, nodes: [] }
  value.evidence.nodes[1].count = 2
  value.evidence.nodes[1].nodes.push({ text: 'another actual rendered node' })
  s.collector.checkpoint(value, { session: s.program, page })
  assert.deepEqual(s.events[1].payload.nodes.map(value => value.count), [0, 2])
  assert.deepEqual(s.events[1].payload.nodes[1].nodes.map(value => value.text), ['observed native value B', 'another actual rendered node'])
  assert.throws(() => s.collector.flush(), /incomplete/)
})

test('sink failures preserve completed tap results, remain sticky and still restore every owned wrapper', async () => {
  const error = new Error('sink rejected observed tap'), s = session({ emitFailure: error, failEmitWhen: value => value.op === 'tap' })
  const page = await initial(s)
  assert.equal(await (await page.$(selector)).tap(), s.tapResult)
  assert.throws(() => s.collector.flush(), caught => caught === error)
  assert.throws(() => s.collector.flush(), caught => caught === error)
  for (const { object, key, descriptor } of s.originals) assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
})

test('absent queries remain absent and failure cleanup preserves external replacements', async () => {
  const s = session({ ownDescriptors: true }), page = await initial(s)
  assert.equal(await page.$('#missing'), null)
  const button = await page.$(selector), replacement = async () => 'external replacement'
  button.tap = replacement
  assert.throws(() => s.collector.flush(), /incomplete/)
  assert.equal(button.tap, replacement)
  for (const { object, key, descriptor } of s.originals.filter(value => value.object !== button || value.key !== 'tap')) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
  }
})

test('recipe binds the pinned source and snapshots its explicit descriptor import closure through the production loader', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const { readConformanceRecipes, prepareConformanceRecipe, createRuntimeTraceCollector } = await import('../../scripts/conformance-recipes.mjs')
  const index = JSON.parse(await readFile(resolve(root, 'docs/conformance/case-index-v1.json'), 'utf8'))
  const bytes = await readFile(resolve(root, 'vendor/weapp-vite/e2e/ide/github-issues.runtime.issue1012.test.ts'))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sourceSha256)
  const loaded = await readConformanceRecipes({ root, index, file: resolve(root, 'conformance/recipes/issue1012-v1.json') })
  const recipe = loaded.get(descriptor.caseId)
  assert.equal(recipe.fixtureProfile, 'captured-static-v1')
  assert.deepEqual(recipe.collectorInputs.map(value => value.path), ['conformance/recipes/issue1012-descriptor.mjs', 'conformance/recipes/passive-collector-core.mjs', 'conformance/recipes/passive-query-context.mjs'])
  await mkdir(resolve(root, 'artifacts'), { recursive: true })
  const directory = await mkdtemp(resolve(root, 'artifacts/issue1012-collector-unit-'))
  try {
    const prepared = await prepareConformanceRecipe({ root, recipe, directory })
    const outputFile = resolve(directory, 'synthetic-unit-events.json')
    const captured = await createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile })
    captured.bindFixtureCheckpoint({ path: 'synthetic-unit-fixture/objects/sha256/' + 'a'.repeat(64), sha256: 'a'.repeat(64), bytes: 1 })
    const s = session()
    // Restore the local collector before attaching the snapshotted one.
    assert.throws(() => s.collector.flush(), /incomplete/)
    await captured.attach(s.program)
    const page = await s.program.currentPage()
    await captured.checkpoint(checkpoint('initial'), { session: s.program, page })
    await (await page.$(selector)).tap()
    await captured.checkpoint(checkpoint('executed'), { session: s.program, page })
    await captured.flush()
    const result = JSON.parse(await readFile(outputFile, 'utf8'))
    assert.equal(result.status, 'passed')
    assert.deepEqual(result.events.map(value => value.seq), [0, 1, 2, 3])
    assert.equal(result.events[1].payload.nodes[0].nodes[0].text, 'observed native value A')
    const diagnostics=JSON.parse(await readFile(resolve(directory,'collector-query-diagnostics.json'),'utf8'))
    assert.equal(diagnostics.kind,'passive-provider-operation-diagnostics')
    assert.ok(diagnostics.events.some(e=>e.phase==='begin'&&e.operation==='Page.$'&&e.selector===selector&&!e.internal))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})


test('replacement attachment invalidates old Page/session even if the old raw transport remains callable', async () => {
  for (const at of ['before-initial', 'after-initial', 'after-tap']) {
    const s = session(), page = await s.program.currentPage()
    if (at !== 'before-initial') check(s, 'initial', page)
    if (at === 'after-tap') assert.equal(await (await page.$(selector)).tap(), s.tapResult)
    const replacement = { async currentPage() { return page } }
    s.collector.attach(replacement)
    assert.throws(() => check(s, at === 'before-initial' ? 'initial' : 'executed', page), /Page|session|generation/)
    assert.throws(() => s.collector.flush())
    for (const { object, key, descriptor } of s.originals) assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)
    assert.equal(Object.getOwnPropertySymbols(replacement).length, 0)
  }
})

test('old transport Page acquisitions after replacement preserve upstream result but poison observation', async () => {
  const s = session(), page = await initial(s)
  const replacement = { async currentPage() { return page } }
  s.collector.attach(replacement)
  assert.equal(await s.program.currentPage(), page)
  assert.throws(() => s.collector.flush(), /another transport/)
})

test('late original Page and tap completions cannot adopt a replacement transport', async () => {
  const acquiring = deferred(), old = { async reLaunch() { return acquiring.promise } }, next = { async currentPage() { return null } }
  const events = [], collector = createCollector({ emit: event => events.push(event) })
  collector.attach(old)
  const pending = old.reLaunch('/' + route)
  collector.attach(next)
  const page = { path: route, pageId: 77, async $() { return null } }
  acquiring.resolve(page); assert.equal(await pending, page)
  assert.deepEqual(events, [])
  assert.throws(() => collector.flush(), /another transport/)

  const tapped = deferred(), s = session({ tapResult: tapped.promise }), actualPage = await initial(s)
  const tapping = (await actualPage.$(selector)).tap()
  s.collector.attach({ async currentPage() { return actualPage } })
  const actual = { upstreamTap: true }; tapped.resolve(actual); assert.equal(await tapping, actual)
  assert.equal(s.events.some(event => event.op === 'tap'), false)
  assert.throws(() => s.collector.flush(), /another actual page|generation/)
})
