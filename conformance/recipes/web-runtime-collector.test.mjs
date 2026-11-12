/** Source/hash and synthetic provider contracts only; no indexed case runs. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { descriptor } from './web-runtime-descriptor.mjs'
import { createCollector } from './web-runtime-collector.mjs'
import { projectOrderedDomNodes } from './ordered-dom-projection.mjs'

const groups = plan => plan.checkpoints[0].queries.map((query, index) => ({ selector: query.selector, query: 'css',
  ...(query.scope ? { scope: [...query.scope] } : {}), count: 2,
  nodes: [{ text: ` raw ${plan.ordinal}/${index}/A\n`, duration: 7 }, { text: ` raw ${plan.ordinal}/${index}/B `, random: 'incidental' }] }))
function provider() {
  const events = [], calls = []; let page
  const element = { async tap() { return 'original completed tap' } }
  const program = { async reLaunch(route) { calls.push(route); page = { path: route.slice(1), pageId: calls.length, async $() { return element } }; return page },
    async currentPage() { return page } }
  const original = program.reLaunch, collector = createCollector({ emit: event => events.push(event),
    context: { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256 } })
  collector.attach(program)
  return { collector, program, calls, events, original }
}
const check = (s, plan, page, nodes = groups(plan)) => s.collector.checkpoint({ evidence: { id: 'initial', route: plan.route,
  source: 'synthetic-only', capturedAt: 'incidental-clock', nodes } }, { session: s.program, page })

test('the exact pinned four it titles, routes and all 29 source addresses/fields are retained without expected values', async () => {
  const bytes = await readFile(new URL('../../vendor/weapp-vite/' + descriptor.caseSourcePath, import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sourceSha256)
  const source = ts.createSourceFile('original.ts', bytes.toString(), ts.ScriptTarget.Latest, true), titles = [], routes = [], planKeys = []
  const walk = node => {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source)
      if (name === 'it') titles.push(node.arguments[0].text)
      if (name === 'relaunchPage') routes.push(node.arguments[1].text.replace(/^\//, ''))
      if (name === 'createDomAcceptance') planKeys.push(node.arguments[2].name.text)
    }
    ts.forEachChild(node, walk)
  }; walk(source)
  const plansBytes = await readFile(new URL('../../vendor/weapp-vite/e2e/ide/githubIssuesDom/webApis.ts', import.meta.url))
  assert.equal(createHash('sha256').update(plansBytes).digest('hex'), '4f0934f72c132bff58e846ff9fa67133f1498ef0589f39358b1658ffafdc5b74')
  const plans = ts.createSourceFile('plans.ts', plansBytes.toString(), ts.ScriptTarget.Latest, true)
  let object
  for (const statement of plans.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
    if (declaration.name.getText(plans) === 'WEB_API_PLANS') object = declaration.initializer.expression
  const property = (value, key) => value.properties.find(item => item.name.getText(plans) === key).initializer
  const addresses = planKeys.map(key => {
    const value = property(object, key).elements[0], nodes = property(value, 'nodes').elements, queries = []
    for (const node of nodes) {
      if (ts.isCallExpression(node)) queries.push({ selector: node.arguments[0].text, text: true })
      else if (ts.isSpreadElement(node)) {
        const map = node.expression, entries = map.expression.expression, object = entries.arguments[0]
        const template = map.arguments[0].body.arguments[0]
        assert.equal(entries.expression.getText(plans), 'Object.entries')
        assert.equal(template.templateSpans.length, 1); assert.equal(template.templateSpans[0].expression.getText(plans), 'key')
        for (const item of object.properties) queries.push({ selector: template.head.text + item.name.text + template.templateSpans[0].literal.text, text: true })
      } else {
        const scope = node.properties.find(item => item.name.getText(plans) === 'scope')
        queries.push({ selector: property(node, 'selector').text, ...(scope ? { scope: scope.initializer.elements.map(part => part.text) } : {}) })
      }
    }
    return { id: property(value, 'id').text, route: property(value, 'route').text.slice(1), queries }
  })
  assert.deepEqual(titles, descriptor.plans.map(plan => plan.test)); assert.deepEqual(routes, descriptor.plans.map(plan => plan.route))
  assert.deepEqual(addresses, descriptor.plans.map(plan => ({ route: plan.route, ...plan.checkpoints[0] })))
  assert.equal(addresses.flatMap(plan => plan.queries).length, 29)
  assert.equal(addresses.flatMap(plan => plan.queries).filter(query => !query.text).length, 3)
  assert.deepEqual(descriptor.plans.map(plan => plan.actions), [[], [], [], []])
  for (const plan of descriptor.plans) {
    const name = plan.route.split('/')[1], compact = name.replace(/[^a-z0-9]/gi, '')
    assert.deepEqual(plan.renderedRoots, [`#${compact}-page`, `#${name}-page`, `.${compact}-page`, `.${name}-page`])
  }
  for (const expected of ['QUI=', 'a=1&a=0&b=2', 'headers,ok,redirected,status,statusText,type,url', '?q=%2B&literal=%2520%25&q=a+b'])
    assert.equal(JSON.stringify(descriptor).includes(expected), false)
})

test('all four actual initial checkpoints preserve raw selected text and discard count-only incidental values', async () => {
  const s = provider(); assert.deepEqual(s.calls, [])
  for (const plan of descriptor.plans) {
    const page = await s.program.reLaunch('/' + plan.route), actual = groups(plan)
    check(s, plan, page, actual)
    assert.deepEqual(s.events.at(-1).payload.nodes, projectOrderedDomNodes(actual, plan.checkpoints[0].queries))
    actual[0].nodes[0].text = 'caller later mutation'
  }
  s.collector.flush(); s.collector.flush()
  assert.deepEqual(s.calls, descriptor.plans.map(plan => '/' + plan.route))
  assert.deepEqual(s.events.filter(event => event.kind === 'render').map(event => [event.payload.planOrdinal, event.payload.checkpointOrdinal, event.payload.id]),
    [[0, 0, 'initial'], [1, 1, 'initial'], [2, 2, 'initial'], [3, 3, 'initial']])
  assert.equal(s.events.length, 8); assert.equal(s.program.reLaunch, s.original)
  assert.equal(JSON.stringify(s.events).includes('incidental'), false)
  assert.equal(JSON.stringify(s.events).includes('caller later mutation'), false)
  for (const event of s.events.filter(event => event.kind === 'render')) for (const group of event.payload.nodes)
    if (!descriptor.plans[event.payload.planOrdinal].checkpoints[0].queries.find(query => query.selector === group.selector).text)
      assert.deepEqual(group.nodes, [{}, {}])
})

test('four duplicate initial ids cannot substitute missing, repeated, reordered or scoped source plans', async () => {
  for (const variant of ['missing', 'repeat', 'reorder', 'scope', 'count', 'cross-owner']) {
    const s = provider(), first = await s.program.reLaunch('/' + descriptor.plans[0].route)
    if (variant === 'missing') { check(s, descriptor.plans[0], first); assert.throws(() => s.collector.flush(), /incomplete/); continue }
    if (variant === 'repeat') { check(s, descriptor.plans[0], first); assert.throws(() => check(s, descriptor.plans[0], first)); continue }
    if (variant === 'reorder') { const page = await s.program.reLaunch('/' + descriptor.plans[1].route); assert.throws(() => check(s, descriptor.plans[1], page)); continue }
    const nodes = groups(descriptor.plans[0])
    if (variant === 'scope') nodes[0].scope = ['#foreign']
    if (variant === 'count') nodes[0].count++
    assert.throws(() => check(s, descriptor.plans[0], variant === 'cross-owner' ? { ...first } : first, nodes))
    assert.throws(() => s.collector.flush())
  }
})

test('unexpected successful taps retain guest completion while poisoning the empty action plan', async () => {
  const s = provider(), page = await s.program.reLaunch('/' + descriptor.plans[0].route)
  assert.equal(await (await page.$('.actual-business-button')).tap(), 'original completed tap')
  assert.throws(() => check(s, descriptor.plans[0], page), /empty source action/)
  assert.throws(() => s.collector.flush(), /empty source action/)
  assert.deepEqual(s.events, [])
})
