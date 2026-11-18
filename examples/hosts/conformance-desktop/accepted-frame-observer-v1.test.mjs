// Explicitly synthetic wire fixtures. No native frame, window, official or
// source attestation is established by these client contract tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAcceptedFrameObserverV1, acceptedFrameFieldsV1 } from './accepted-frame-observer-v1.mjs'

const route = 'pages/index/index', sessionId = 'synthetic-observer-wire'
const instance = 'a'.repeat(64), token = value => value.repeat(64)
const capability = engine => ({ kind: 'accepted-frame-observation-capabilities-v1', version: 1,
  engine, sessionId, sessionInstance: instance, operations: ['accepted-frame.observe.v1'], fields: [...acceptedFrameFieldsV1] })
const startup = engine => ({ status: 'passed', engine, sessionId, acceptedFrameObservation: capability(engine) })
const completion = (pump, revision = 1) => ({ kind: 'owner-pump-native-presentation-v1', sessionId, route,
  pageId: '1', templateRevision: String(revision), consumedTemplateRevision: String(revision), frameId: String(revision),
  renderRevision: String(revision), presentationAckRevision: String(revision), actionSeq: '0',
  ownerPumpSeq: String(pump), requiredPumpSeq: '0', presented: true })
const owner = (engine, revision = 1) => ({ kind: 'accepted-frame-owner-v1', engine, sessionId, sessionInstance: instance,
  route, pageId: '1', templateRevision: String(revision), frameId: String(revision), renderRevision: String(revision) })
const handle = (engine, value = 'b', revision = 1) => ({ kind: 'accepted-frame-node-v1', owner: owner(engine, revision), token: token(value) })
const geometry = offset => ({ coordinateSpace: 'viewport-css-px', box: 'transformed-border-aabb', clipped: false,
  width: 10.25, height: 20.5, ...(offset ? { left: -3.75, top: 0.125 } : {}) })
const actualValue = field => ({ 'computed.display': 'block', 'computed.flex-direction': 'row',
  'computed.flex-wrap': 'nowrap', 'computed.opacity': .5, 'computed.visibility': 'hidden' })[field]
  ?? geometry(field.startsWith('offset.'))
function fixture(engine = 'quickjs', mutate = () => {}, options = {}) {
  const trace = []; let pump = 0
  const client = createAcceptedFrameObserverV1(async (op, payload) => {
    trace.push({ op, payload: structuredClone(payload) }); pump++
    let result
    if (op === 'accepted-frame.capabilities.v1') result = { ...capability(engine), completion: completion(pump) }
    else {
      const revision = options.revision ?? 1, current = owner(engine, revision)
      const values = Object.fromEntries(payload.fields.map(field => [field, actualValue(field)]))
      const node = value => ({ handle: { kind: 'accepted-frame-node-v1', owner: current, token: token(value) },
        parent: null, metadata: { publicId: 'duplicate-id', tag: 'view' }, values: structuredClone(values) })
      result = { kind: 'accepted-frame-observation-v1', version: 1, owner: current, target: structuredClone(payload.target),
        fields: [...payload.fields], count: 2, nodes: [node('b'), node('c')], completion: completion(pump, revision) }
    }
    mutate(result, op)
    return result
  }, { requestedEngine: engine, startup: startup(engine), enabled: true, ...options })
  return { client, trace }
}
const query = fields => ({ route, target: { query: { selector: '.item' } }, fields })
const rejects = promise => assert.rejects(promise, /Accepted-frame|Node handle|node handle|Actual |actual |Native |disabled|fields|Input /)

test('default off performs no transport request', async () => {
  let calls = 0
  const client = createAcceptedFrameObserverV1(async () => { calls++ }, { requestedEngine: 'quickjs', startup: startup('quickjs') })
  await rejects(client.ready()); assert.equal(calls, 0)
})
test('actual selected local values, finite geometry and duplicate public ids survive unchanged', async () => {
  const { client } = fixture()
  const result = await client.observe(query(['computed.display', 'computed.opacity', 'computed.visibility', 'offset.viewport-border-aabb.v1']))
  assert.equal(result.nodes[0].values['computed.opacity'], .5)
  assert.equal(result.nodes[0].values['computed.visibility'], 'hidden')
  assert.deepEqual(result.nodes[0].values['offset.viewport-border-aabb.v1'], geometry(true))
  assert.equal(result.count, 2); assert.equal(result.nodes[0].metadata.publicId, result.nodes[1].metadata.publicId)
  assert.notEqual(result.nodes[0].handle.token, result.nodes[1].handle.token)
})
for (const engine of ['quickjs', 'v8']) {
  const other = engine === 'quickjs' ? 'v8' : 'quickjs'
  test(`${engine}: requested engine cannot adopt the other supported startup engine`, async () => {
    const { client, trace } = fixture(engine, undefined, { startup: startup(other) })
    await rejects(client.ready()); assert.deepEqual(trace, [])
  })
  test(`${engine}: startup capability cannot substitute another supported engine`, async () => {
    const value = startup(engine); value.acceptedFrameObservation.engine = other
    const { client, trace } = fixture(engine, undefined, { startup: value })
    await rejects(client.ready()); assert.deepEqual(trace, [])
  })
  test(`${engine}: runtime capability cannot substitute another supported engine`, async () => {
    const { client } = fixture(engine, (value, op) => { if (op.endsWith('capabilities.v1')) value.engine = other })
    await rejects(client.ready())
  })
  test(`${engine}: observation owner cannot substitute another supported engine`, async () => {
    const { client } = fixture(engine, (value, op) => { if (op.endsWith('observe.v1')) value.owner.engine = other })
    await rejects(client.observe(query(['computed.display'])))
  })
  test(`${engine}: parent handle cannot substitute another supported engine`, async () => {
    const { client, trace } = fixture(engine)
    await rejects(client.observe({ route, target: { parent: handle(other), selector: '.item' }, fields: ['computed.display'] }))
    assert.equal(trace.length, 1)
  })
}
test('startup data is copied before asynchronous capability negotiation', async () => {
  const value = startup('quickjs'), { client } = fixture('quickjs', undefined, { startup: value })
  value.engine = 'v8'; value.acceptedFrameObservation.engine = 'v8'
  await client.ready()
})
test('parent query retains full actual handle instead of reconstructing a public-id selector', async () => {
  const { client, trace } = fixture(), parent = handle('quickjs')
  await client.observe({ route, target: { parent, selector: '.item', has: '.leaf' }, fields: ['computed.display'] })
  assert.deepEqual(trace[1].payload.target, { parent, selector: '.item', has: '.leaf' })
  assert.equal(JSON.stringify(trace).includes('#duplicate-id'), false)
})
test('a handle from another accepted revision cannot be reused for a current read', async () => {
  const { client } = fixture('quickjs', undefined, { revision: 2 })
  await rejects(client.observe({ route, target: { node: handle('quickjs') }, fields: ['computed.display'] }))
})
for (const selected of [[], ['computed.unknown'], ['computed.display', 'computed.display'], [{ name: 'computed.visibility', expected: 'visible' }]])
  test(`unknown, duplicate, empty or value-bearing selectors reject: ${JSON.stringify(selected)}`, async () => {
    const { client, trace } = fixture()
    await rejects(client.observe(query(selected))); assert.equal(trace.length, 1)
  })
test('versioned query does not silently admit legacy or value-bearing fields', async () => {
  const { client, trace } = fixture()
  await rejects(client.observe({ route, target: { query: { selector: '.item', fields: { text: true, attributes: [] } } }, fields: ['computed.display'] }))
  assert.equal(trace.length, 1)
})
for (const change of [
  value => { delete value.nodes[0].values['computed.visibility'] },
  value => { value.nodes[0].values['computed.visibility'] = null },
  value => { value.nodes[0].values['computed.visibility'] = 'inherit' },
  value => { value.nodes[0].handle.owner.sessionInstance = token('d') },
  value => { value.completion.presentationAckRevision = '0' },
  value => { value.nodes[1].handle.token = value.nodes[0].handle.token },
]) test('missing values, unresolved defaults, owner mismatch and stale ACK reject', async () => {
  const { client } = fixture('quickjs', (value, op) => { if (op.endsWith('observe.v1')) change(value) })
  await rejects(client.observe(query(['computed.visibility'])))
})
test('changed oracle values do not alter address/field requests', async () => {
  const first = fixture(), second = fixture('quickjs', (value, op) => {
    if (op.endsWith('observe.v1')) for (const node of value.nodes) node.values['computed.opacity'] = .75
  })
  const left = await first.client.observe(query(['computed.opacity'])), right = await second.client.observe(query(['computed.opacity']))
  assert.deepEqual(first.trace, second.trace)
  assert.notDeepEqual(left.nodes[0].values, right.nodes[0].values)
})

test('exact node address returns the one unchanged requested handle', async () => {
  for (const engine of ['quickjs', 'v8']) {
    const { client, trace } = fixture(engine, (value, op) => {
      if (op.endsWith('observe.v1')) { value.nodes = [value.nodes[0]]; value.count = 1 }
    })
    const incoming = handle(engine)
    const value = await client.observe({ route, target: { node: incoming }, fields: ['computed.display'] })
    assert.equal(value.count, 1)
    assert.deepEqual(value.nodes[0].handle, incoming)
    assert.deepEqual(trace[1].payload.target, { node: incoming })
  }
})
for (const [name, change] of [
  ['a different node token from the same owner', value => { value.nodes = [value.nodes[1]]; value.count = 1 }],
  ['no addressed node', value => { value.nodes = []; value.count = 0 }],
  ['the addressed node plus another node', () => {}],
]) test(`exact node address rejects ${name}`, async () => {
  for (const engine of ['quickjs', 'v8']) {
    const { client } = fixture(engine, (value, op) => { if (op.endsWith('observe.v1')) change(value) })
    await assert.rejects(client.observe({ route, target: { node: handle(engine) }, fields: ['computed.display'] }),
      /Accepted-frame exact node address must return one matching handle/)
  }
})
