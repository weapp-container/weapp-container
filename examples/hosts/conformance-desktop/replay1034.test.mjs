import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { caseDefinition, collectorInputs, replayCase } from './replay.mjs'

const caseId = 'ide-issue-1034-auto-routes-runtime'
const routes = ['pages/home/index', 'subpackages/account/pages/detail/index', 'subpackages/isolated/pages/detail/index']
// Synthetic protocol provider only; these values do not certify real native rendering.
function synthetic({ retry = false, mutate, failureAt, failure = new Error('original IPC failure') } = {}) {
  const calls = [], reads = new Map()
  let route, count
  const request = async (op, payload) => {
    calls.push({ op, payload: structuredClone(payload) })
    assert.equal(JSON.stringify(payload).includes('"text"'), false, 'Expected strings must never enter IPC')
    if (op === failureAt) throw failure
    let result
    if (op === 'reLaunch') { route = payload.route.slice(1); count = 0; result = { path: route } }
    else {
      assert.equal(payload.route, route)
      const address = { route, selector: payload.selector }
      if (op === 'query') result = { ...address, count: 1, nodes: [{ id: `synthetic-${payload.selector}` }] }
      else if (op === 'query.text') {
        assert.equal(payload.selector, '#source')
        const at = reads.get(route) ?? 0; reads.set(route, at + 1)
        result = { ...address, count: 1, text: retry && at === 0 ? 'actual pending render' : `vue-business-${routes.indexOf(route)}` }
      } else if (op === 'tap') {
        assert.equal(payload.selector, '#increment'); count++
        result = { ...address, inputTransport: 'native-host-coordinate-event', x: 21, y: 34, frameId: 17, renderRevision: 23 }
      } else {
        assert.equal(op, 'checkpoint')
        result = { id: payload.checkpoint, route, nodes: payload.selectors.map(selector => ({ selector, query: 'css', count: 1,
          nodes: [{ text: selector === '#source' ? `vue-business-${routes.indexOf(route)}` : String(count) }] })) }
      }
    }
    return mutate ? mutate(op, result, payload) : result
  }
  return { calls, request, failure }
}

test('1034 mirrors every unchanged route-loop assertion with actual source polling, coordinate tap and both checkpoint selectors', async () => {
  const provider = synthetic({ retry: true }), result = await replayCase({ caseId, request: provider.request })
  assert.deepEqual(result.assertions, [{ id: 'issue #1034: selected sources across package boundaries navigates to each selected Vue page with its explicit sibling import and working events', passed: true }])
  assert.deepEqual(result.events.map(event => event.op), Array.from({ length: 3 }, () => ['route.active', 'query.text', 'tap', 'dom.checkpoint']).flat())
  assert.deepEqual(result.events.filter(event => event.op === 'query.text').map(event => event.payload),
    routes.map((route, index) => ({ route, selector: '#source', text: `vue-business-${index}` })))
  assert.deepEqual(result.events.filter(event => event.op === 'tap').map(event => event.payload), routes.map(route => ({ route, selector: '#increment' })))
  assert.deepEqual(provider.calls.filter(call => call.op === 'reLaunch').map(call => call.payload.route), routes.map(route => '/' + route))
  assert.equal(provider.calls.filter(call => call.op === 'query.text').length, 6)
  assert.deepEqual(provider.calls.filter(call => call.op === 'checkpoint').map(call => call.payload),
    routes.map((route, index) => ({ route, checkpoint: `package-${index}`, selectors: ['#source', '#increment'] })))
  assert.ok(result.events.every((event, index) => event.seq === index && Object.keys(event).sort().join(',') === 'kind,op,payload,seq'))
})

test('1034 rejects either rendered checkpoint text mismatch at each package and never advances after failure', async () => {
  for (const index of [0, 1, 2]) for (const node of [0, 1]) {
    const provider = synthetic({ mutate(op, value) {
      if (op === 'checkpoint' && value.id === `package-${index}`) value.nodes[node].nodes[0].text = 'actual divergent rendered value'
      return value
    } })
    await assert.rejects(replayCase({ caseId, request: provider.request }), /Actual rendered text differs.*actual divergent rendered value/)
    assert.equal(provider.calls.filter(call => call.op === 'tap').length, index + 1)
    assert.equal(provider.calls.at(-1).payload.checkpoint, `package-${index}`)
  }
})

test('1034 mismatched source polls, absent nodes and wrong actual routes stop before coordinate input', async () => {
  for (const scenario of ['poll', 'query', 'route']) {
    const provider = synthetic({ mutate(op, value) {
      if (scenario === 'poll' && op === 'query.text') value.text = 'actual divergent source'
      if (scenario === 'query' && op === 'query') { value.count = 0; value.nodes = [] }
      if (scenario === 'route' && op === 'reLaunch') value.path = routes[1]
      return value
    } })
    await assert.rejects(replayCase({ caseId, request: provider.request, pollTimeoutMs: 0 }), /Actual native polled text differs|another actual Page route/)
    assert.equal(provider.calls.some(call => call.op === 'tap'), false)
  }
  const missing = synthetic({ mutate(op, value, payload) {
    if (op === 'query' && payload.selector === '#increment') { value.count = 0; value.nodes = [] }
    return value
  } })
  await assert.rejects(replayCase({ caseId, request: missing.request }), /increment button is absent/)
  assert.equal(missing.calls.some(call => call.op === 'tap'), false)
})

test('1034 rejects incomplete/crossed native proofs and preserves exact transport errors and abort reason', async () => {
  for (const scenario of [
    { op: 'query', mutate: value => ({ ...value, selector: '#other' }), error: /another actual route, selector/ },
    { op: 'query.text', mutate: value => ({ ...value, count: 0 }), error: /no actual rendered string/ },
    { op: 'tap', mutate: value => ({ ...value, inputTransport: 'synthetic-tap' }), error: /host coordinate input/ },
    { op: 'checkpoint', mutate: value => ({ ...value, id: 'other' }), error: /another actual route or checkpoint/ },
  ]) {
    const provider = synthetic({ mutate: (op, value) => op === scenario.op ? scenario.mutate(value) : value })
    await assert.rejects(replayCase({ caseId, request: provider.request, pollTimeoutMs: 0 }), scenario.error)
  }
  for (const op of ['reLaunch', 'query', 'query.text', 'tap', 'checkpoint']) {
    const provider = synthetic({ failureAt: op })
    await assert.rejects(replayCase({ caseId, request: provider.request, pollTimeoutMs: 0 }), value => value === provider.failure)
  }
  const controller = new AbortController(), reason = new Error('actual caller abort'), provider = synthetic()
  controller.abort(reason)
  await assert.rejects(replayCase({ caseId, request: provider.request, signal: controller.signal }), value => value === reason)
  assert.equal(provider.calls.some(call => call.op === 'tap'), false)
})

test('1034 binds collector and coverage-only descriptor hashes in the declared native dependency closure', async () => {
  const definition = caseDefinition(caseId), refs = [
    { path: definition.collectorPath, sha256: definition.collectorSha256 }, ...definition.collectorDependencies,
  ]
  assert.equal(definition.sourceSha256, '7af17235a588c76b5cf8cf5f8659b35a7b806ba421ba67e59e5146b2b41f1a4c')
  assert.equal(refs.length, 2)
  for (const ref of refs) {
    const bytes = await readFile(new URL(ref.path, import.meta.url))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256)
    assert.deepEqual(collectorInputs().find(value => value.path === ref.path), ref)
    assert.equal(bytes.toString().includes('vue-business-'), false, 'Evidence producers contain no expected rendered values')
  }
})
