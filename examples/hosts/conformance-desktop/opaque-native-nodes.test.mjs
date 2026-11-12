import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpaqueNativeNodes } from './opaque-native-nodes.mjs'
import { createObservedNativeProgram, validateCompletion } from './native-program.mjs'
const OPS = ['accepted-frame.nodes.acquire.v1', 'accepted-frame.nodes.tap.v1']
const ROUTE = 'pages/index/index', NONCE = 'a'.repeat(64)
function fixture() {
  let pump = 0, action = 0, required = 0, pageId = '1', route = ROUTE, frameId = '1'
  const calls = [], accepted = []; let previous
  const capability = { kind: 'accepted-frame-node-capabilities-v1', version: 1, engine: 'quickjs', sessionId: 's', sessionInstance: NONCE,
    operations: OPS, selection: ['first', 'all'], inputTransport: 'native-host-coordinate-event' }
  const startup = { status: 'passed', engine: 'quickjs', sessionId: 's', acceptedFrameNodes: capability }
  const completion = () => ({ kind: 'owner-pump-native-presentation-v1', presented: true, sessionId: 's', route, pageId,
    templateRevision: '1', consumedTemplateRevision: '1', frameId, renderRevision: frameId, presentationAckRevision: frameId,
    actionSeq: String(action), ownerPumpSeq: String(++pump), requiredPumpSeq: String(required) })
  const owner = () => ({ kind: 'accepted-frame-owner-v1', sessionId: 's', sessionInstance: NONCE, engine: 'quickjs', route, pageId,
    templateRevision: '1', frameId, renderRevision: frameId })
  const handle = index => ({ kind: 'accepted-frame-node-v1', owner: owner(), token: String(index + 1).repeat(64) })
  const node = index => ({ handle: handle(index), parent: null, metadata: { id: 'duplicate', publicId: 'duplicate', tag: 'button',
    eventIdentity: `occurrence-${index}`, componentScopeId: null, eventOwnerScopeId: null } })
  const request = async (op, payload = {}) => {
    calls.push({ op, payload: structuredClone(payload) })
    if (op === 'render.settle') return completion()
    if (op === 'currentPage') return { path: route, pageId, completion: completion() }
    if (op === 'reLaunch') { pageId = String(Number(pageId) + 1); route = payload.route; frameId = String(Number(frameId) + 1); action++; required = pump + 1
      return { path: route, completion: completion() } }
    if (op.endsWith('capabilities.v1')) return { ...structuredClone(capability), completion: completion() }
    if (op === OPS[0]) {
      const nodes = payload.selection === 'first' ? [node(0)] : [node(0), node(1)]
      if (payload.target.query?.selector === '#missing') nodes.length = 0
      return { kind: 'accepted-frame-node-acquisition-v1', version: 1, owner: owner(), target: payload.target, selection: payload.selection,
        matchCount: nodes.length ? 2 : 0, count: nodes.length, nodes, completion: completion() }
    }
    if (op === OPS[1]) {
      const input = completion(); action++; required = pump + 1
      return { kind: 'accepted-frame-node-tap-v1', version: 1, route, node: payload.node, owner: owner(), x: 20, y: 20, frameId, renderRevision: frameId,
        inputTransport: 'native-host-coordinate-event', inputCompletion: input, completion: completion() }
    }
    if (op === 'query') return { route, selector: payload.selector, count: 1, nodes: [{ id: 'unique' }], frameId: Number(frameId), renderRevision: Number(frameId), completion: completion() }
    throw new Error(`unexpected ${op}`)
  }
  const accept = (value, options) => { previous = validateCompletion(value, previous, options); accepted.push(previous); return previous }
  const options = { enabled: true, requestedEngine: 'quickjs', startup, acceptCompletion: accept }
  return { request, options, calls, accepted, page: { route: ROUTE, pageId: '1' }, node, completion }
}
const rejected = error => error.code === 'NATIVE_OPAQUE_NODE_PROVENANCE_FAILED'
test('default off sends no capability or action request', async () => {
  const f = fixture(), nodes = createOpaqueNativeNodes(f.request)
  await assert.rejects(nodes.ready(), rejected); assert.equal(f.calls.length, 0)
  const program = createObservedNativeProgram(f.request, { nodeContext: { enabled: false } })
  const p = await program.currentPage(); assert.equal((await p.$('#unique')).id, 'unique')
  assert.deepEqual(f.calls.map(x => x.op), ['render.settle', 'currentPage', 'query'])
})
test('Page.$ selects first actual handle among duplicate IDs and tap transmits only handle', async () => {
  const f = fixture(), program = createObservedNativeProgram(f.request, { nodeContext: f.options })
  const p = await program.currentPage(), element = await p.$('.candidate')
  const acquired = f.calls.find(x => x.op === OPS[0]); assert.equal(acquired.payload.selection, 'first')
  assert.equal(element.id, 'duplicate'); await element.tap()
  const input = f.calls.find(x => x.op === OPS[1]); assert.deepEqual(Object.keys(input.payload).sort(), ['node', 'route', 'version'])
  assert.equal(input.payload.node.token, '1'.repeat(64)); assert.equal(program.completions().at(-1).actionSeq, '1')
  assert.equal(program.completions().at(-1).ownerPumpSeq, program.completions().at(-1).requiredPumpSeq)
})
test('all selection retains actual order and distinct handles despite duplicate public IDs', async () => {
  const f = fixture(), nodes = createOpaqueNativeNodes(f.request, f.options), result = await nodes.acquire(f.page, { query: { selector: '.candidate' } }, 'all')
  assert.equal(result.matchCount, 2); assert.deepEqual(result.nodes.map(x => x.metadata.id), ['duplicate', 'duplicate'])
  assert.deepEqual(result.nodes.map(x => x.handle.token), ['1'.repeat(64), '2'.repeat(64)])
})
test('zero first match returns null without a fabricated Element', async () => {
  const f = fixture(), program = createObservedNativeProgram(f.request, { nodeContext: f.options })
  const p = await program.currentPage(); assert.equal(await p.$('#missing'), null)
})
test('nested query carries acquired parent handle without reconstructed selector scope', async () => {
  const f = fixture(), program = createObservedNativeProgram(f.request, { nodeContext: f.options })
  const p = await program.currentPage(), parent = await p.$('.candidate'); await parent.$('.child')
  const target = f.calls.filter(x => x.op === OPS[0]).at(-1).payload.target
  assert.deepEqual(Object.keys(target).sort(), ['parent', 'selector']); assert.equal(target.parent.token, '1'.repeat(64))
})
test('retired Page Element is rejected before any request', async () => {
  const f = fixture(), program = createObservedNativeProgram(f.request, { nodeContext: f.options })
  const p = await program.currentPage(), element = await p.$('.candidate'); await program.reLaunch(ROUTE)
  const before = f.calls.length; await assert.rejects(element.tap(), /retired actual Page/); assert.equal(f.calls.length, before)
})
for (const changed of ['engine', 'sessionId', 'sessionInstance']) test(`runtime capability ${changed} mismatch fails before acquisition`, async () => {
  const f = fixture(), request = async (op, payload) => { const v = await f.request(op, payload); if (op.endsWith('capabilities.v1')) v[changed] = changed === 'engine' ? 'v8' : 'b'.repeat(64); return v }
  const nodes = createOpaqueNativeNodes(request, f.options); await assert.rejects(nodes.acquire(f.page, { query: { selector: '*' } }, 'first'), rejected)
  assert.equal(f.calls.filter(x => x.op === OPS[0]).length, 0); assert.equal(f.accepted.length, 0)
})
for (const defect of ['duplicate-token', 'owner-frame', 'wrong-page', 'first-count', 'expected-field']) test(`malformed acquisition ${defect} creates no accepted acquisition`, async () => {
  const f = fixture(), request = async (op, payload) => { const v = await f.request(op, payload)
    if (op === OPS[0]) {
      if (defect === 'duplicate-token') v.nodes[1].handle.token = v.nodes[0].handle.token
      if (defect === 'owner-frame') v.nodes[0].handle.owner.frameId = '99'
      if (defect === 'wrong-page') v.completion.pageId = '99'
      if (defect === 'first-count') v.count = 1
      if (defect === 'expected-field') v.expected = 'hidden oracle value'
    } return v }
  const nodes = createOpaqueNativeNodes(request, f.options); await nodes.ready(); const before = f.accepted.length
  await assert.rejects(nodes.acquire(f.page, { query: { selector: '*' } }, 'all'), rejected); assert.equal(f.accepted.length, before)
})
test('stale parent generation cannot be rebound to a fresh acquisition', async () => {
  const f = fixture(), nodes = createOpaqueNativeNodes(f.request, f.options); await nodes.ready()
  const parent = f.node(0).handle; parent.owner.frameId = '99'
  await assert.rejects(nodes.acquire(f.page, { parent, selector: '.child' }, 'first'), rejected)
})
for (const defect of ['owner', 'handle', 'coordinate', 'frame', 'selector']) test(`tap proof ${defect} fails before completion or normalized success`, async () => {
  const f = fixture(), request = async (op, payload) => { const v = await f.request(op, payload)
    if (op === OPS[1]) {
      if (defect === 'owner') v.owner.pageId = '99'
      if (defect === 'handle') v.node.token = '3'.repeat(64)
      if (defect === 'coordinate') v.x = NaN
      if (defect === 'frame') v.frameId = '99'
      if (defect === 'selector') v.selector = '#duplicate'
    } return v }
  const nodes = createOpaqueNativeNodes(request, f.options); await nodes.ready(); const before = f.accepted.length
  await assert.rejects(nodes.tap(f.page, f.node(0).handle), rejected); assert.equal(f.accepted.length, before)
})
test('provider rejection identity propagates without fake input/action completion', async () => {
  const f = fixture(), original = { provider: 'original dispatch error' }, nodes = createOpaqueNativeNodes(async (op, payload) => {
    if (op === OPS[1]) throw original; return f.request(op, payload)
  }, f.options)
  await nodes.ready(); const before = f.accepted.length
  await assert.rejects(nodes.tap(f.page, f.node(0).handle), error => error === original); assert.equal(f.accepted.length, before)
})
test('post-input completion must advance actual action and required owner pump', async () => {
  const f = fixture(), nodes = createOpaqueNativeNodes(async (op, payload) => { const v = await f.request(op, payload)
    if (op === OPS[1]) v.completion.actionSeq = '0'; return v
  }, f.options)
  await nodes.ready(); await assert.rejects(nodes.tap(f.page, f.node(0).handle), /action sequence/)
  assert.equal(f.accepted.at(-1).actionSeq, '0')
})
test('opaque reads fail closed and never fall back to selector reads', async () => {
  const f = fixture(), program = createObservedNativeProgram(f.request, { nodeContext: f.options })
  const p = await program.currentPage(), element = await p.$('*'), before = f.calls.length
  await assert.rejects(element.text(), /exact-node read contract/); await assert.rejects(element.attribute('id'), /exact-node read contract/)
  assert.equal(f.calls.length, before)
})

test('default-off legacy Element text, attribute and selector tap retain their existing wire contract', async () => {
  const f = fixture(), requested = [], request = async (op, payload = {}) => {
    requested.push({ op, payload: structuredClone(payload) })
    if (op === 'query.text' || op === 'query.attribute') {
      const completion = await f.request('render.settle')
      return { route: ROUTE, selector: payload.selector, frameId: 1, renderRevision: 1, count: 1, completion,
        ...(op === 'query.text' ? { text: 'actual rendered text' } : { name: payload.name, present: true, value: { type: 'string', value: 'actual field' } }) }
    }
    if (op === 'tap') {
      const value = await f.request(OPS[1], { node: f.node(0).handle })
      return { ...value, selector: payload.selector, frameId: 1, renderRevision: 1 }
    }
    return f.request(op, payload)
  }
  const program = createObservedNativeProgram(request), p = await program.currentPage(), element = await p.$('#unique')
  assert.equal(await element.text(), 'actual rendered text'); assert.equal(await element.attribute('title'), 'actual field'); await element.tap()
  assert.deepEqual(requested.map(x => x.op), ['render.settle', 'currentPage', 'query', 'query.text', 'query.attribute', 'tap'])
  assert.deepEqual(requested.at(-1).payload, { route: ROUTE, selector: '#unique' })
  assert.equal(program.completions().at(-1).actionSeq, '1')
})
