import test from 'node:test'
import assert from 'node:assert/strict'
import { PresentedFrameObserver } from './frame-observer.mjs'
import { WebConformanceController, createWebQuickjsCandidate } from './web-controller.mjs'

// Entirely synthetic protocol boundary tests. These are not browser evidence,
// GPU observations, real Worker finals, official receipts or conformance pairs.
const owner = { workerEpoch: 'synthetic-worker', sessionId: 'synthetic-session', packSha256: 'a'.repeat(64), transportBackend: 'external-frame' }
const viewport = { x: 0, y: 0, width: 375, height: 667 }
const initialState = () => ({ schemaVersion: 1, sessionId: owner.sessionId, owner: structuredClone(owner),
  transportBackend: 'external-frame', surfaceGeneration: '1', inputLifetimeRevision: '2', templateRevision: '3',
  renderRevision: '4', viewRevision: '0', currentPage: { pageId: '1', path: 'pages/test/index' },
  lifecycle: 'Active', viewport: { ...viewport }, rendererProfile: 'skia', declaredRendererProfile: 'skia', requiresRestart: false })
const observed = (state, sequence = '2') => ({ version: '1.0', sequence, state: structuredClone(state) })
const consumed = state => ({ pageId: state.currentPage.pageId, routePath: state.currentPage.path,
  templateRevision: state.templateRevision, viewport: structuredClone(state.viewport) })
const cloneReply = state => ({ renderRevision: state.renderRevision,
  frame: { frame_id: 9, viewport: { ...viewport }, root: { text: 'synthetic-actual' } },
  scheduling: { version: '1.0', sessionId: owner.sessionId, renderRevision: state.renderRevision, consumedInput: consumed(state) },
  observation: observed(state) })
const ackReply = state => {
  const runtime = structuredClone(state)
  delete runtime.owner; delete runtime.inputLifetimeRevision; delete runtime.surfaceGeneration
  runtime.viewport = { width: viewport.width, height: viewport.height }
  return { version: '1.0', sessionId: owner.sessionId, renderRevision: state.renderRevision,
    acknowledged: true, inputEnabled: true, requiresRestart: false, batch: { messages: [] },
    observedState: runtime, observation: observed(state, '3') }
}
function fixture(options = {}) {
  const state = initialState(), calls = [], queue = [], observer = new PresentedFrameObserver({ enabled: true, ...options })
  const rpc = { actualFinalContract: '1.0', workerEpoch: owner.workerEpoch, sessionId: owner.sessionId,
    requestHost(...args) { assert.equal(this, rpc); calls.push(args); return queue.shift() } }
  const wrapped = observer.wrapRpc(rpc, owner), canvas = {}, input = consumed(state)
  const authority = { enabled: true, owner, canvas, surfaceGeneration: '1',
    consumedInput: input, publication: { kind: 'external-frame', renderRevision: state.renderRevision } }
  const adapterStatus = { lastAck: null, disposed: false, pendingOperations: 0, actualRemoteOperations: 0, ownedSurfaces: 1, ownedPresenters: 1 }
  const adapter = { owner, canvas, inputAuthority: authority, status: adapterStatus }
  const status = { phase: 'ready', owner, runtimeReady: true, visible: true, inputEnabled: true, requiresRestart: false,
    metricsPending: 0, fault: null, observation: observed(state, '3'), presentation: { phase: 'idle', inFlight: false, hasRaf: false, accepted: { inputEnabled: true,
      proof: { owner, surfaceGeneration: '1', consumedInput: input, publication: authority.publication } } } }
  const session = { owner, get status() { return status } }
  observer.attachAdapter(adapter)
  const send = async (op, result, payload = {}, requestOptions) => {
    const promise = Promise.resolve(result); queue.push(promise)
    assert.equal(wrapped.requestHost(op, payload, requestOptions), promise)
    await promise
    return result
  }
  const present = async () => {
    const frame = cloneReply(state), ack = ackReply(state)
    await send('frame', frame); await send('ack', ack, { renderRevision: state.renderRevision })
    adapterStatus.lastAck = ack
    return { frame, ack }
  }
  return { state, observer, rpc, wrapped, adapter, adapterStatus, status, session, queue, calls, send, present }
}

test('observation is off by default and V8 is rejected before resource work', async () => {
  const observer = new PresentedFrameObserver(), rpc = {}
  assert.equal(observer.wrapRpc(rpc, null), rpc)
  assert.throws(() => observer.snapshot({}), { code: 'ERR_CONFORMANCE_DISABLED' })
  assert.throws(() => new PresentedFrameObserver({ enabled: true, engine: 'v8' }), { code: 'ERR_ENGINE' })
  await assert.rejects(createWebQuickjsCandidate(), { code: 'ERR_CONFORMANCE_DISABLED' })
  await assert.rejects(createWebQuickjsCandidate({ enabled: true, engine: 'v8' }), { code: 'ERR_ENGINE' })
  await assert.rejects(createWebQuickjsCandidate({ enabled: true, loadOptions: {} }), /explicit workerUrl/)
})

test('observer preserves original RPC receiver, arguments, callbacks, promise, result and rejection identity', async () => {
  const f = fixture(), options = { onActualFinal() {}, onLateResponse() {} }, payload = {}, value = cloneReply(f.state)
  const promise = Promise.resolve(value); f.queue.push(promise)
  const returned = f.wrapped.requestHost('frame', payload, options)
  assert.equal(returned, promise); assert.equal(await returned, value)
  assert.deepEqual(f.calls[0], ['frame', payload, options]); assert.equal(f.calls[0][1], payload); assert.equal(f.calls[0][2], options)
  const failure = new Error('synthetic actual failure'), rejected = Promise.reject(failure)
  f.queue.push(rejected)
  await assert.rejects(f.wrapped.requestHost('frame.current', payload, options), error => error === failure)
  assert.equal(f.observer.diagnostics.fault, null)
})

test('only a captured frame with its later ACK and current real authority is readable; clones stay isolated', async () => {
  const f = fixture(), { frame, ack } = await f.present()
  frame.frame.root.text = 'caller-mutated'; ack.observedState.currentPage.path = 'caller-mutated'
  const first = f.observer.snapshot(f.session)
  assert.equal(first.frame.root.text, 'synthetic-actual')
  assert.equal(first.acknowledgement.observedState.currentPage.path, 'pages/test/index')
  first.frame.root.text = 'consumer-mutated'
  assert.equal(f.observer.snapshot(f.session).frame.root.text, 'synthetic-actual')
})

test('a frame or ACK alone cannot grant observation/input authority', async () => {
  const f = fixture()
  await f.send('frame', cloneReply(f.state))
  assert.throws(() => f.observer.snapshot(f.session), /subsequent actual ACK/)
  const other = fixture(), ack = ackReply(other.state)
  await other.send('ack', ack, { renderRevision: '4' }); other.adapterStatus.lastAck = ack
  assert.throws(() => other.observer.snapshot(other.session), /subsequent actual ACK/)
})

test('foreign, malformed and ACK-before-clone replies never become authority or alter business results', async t => {
  for (const [name, modify] of [
    ['foreign session', reply => { reply.sessionId = 'other' }],
    ['invented consumed input', reply => { reply.consumedInput = consumed(initialState()) }],
    ['faulted runtime', reply => { reply.observedState.executionFault = { code: 'ERR_ENGINE' } }],
    ['mismatched actual page', reply => { reply.observedState.currentPage.path = 'pages/other/index' }],
  ]) await t.test(name, async () => {
    const f = fixture(), value = ackReply(f.state); modify(value)
    const returned = await f.send('ack', value, { renderRevision: '4' })
    assert.equal(returned, value); assert.ok(f.observer.diagnostics.fault)
    assert.throws(() => f.observer.snapshot(f.session), error => error === f.observer.diagnostics.fault)
  })
  const f = fixture(), ack = ackReply(f.state)
  await f.send('ack', ack, { renderRevision: '4' }); await f.send('frame', cloneReply(f.state)); f.adapterStatus.lastAck = ack
  assert.throws(() => f.observer.snapshot(f.session), /subsequent actual ACK/)
})

test('page, route, template, input lifetime, surface, revision and adapter input must all remain current', async t => {
  const changes = [
    ['page', f => { f.status.observation.state.currentPage.pageId = '2' }],
    ['route', f => { f.status.observation.state.currentPage.path = 'pages/other/index' }],
    ['template', f => { f.status.observation.state.templateRevision = '99' }],
    ['lifetime', f => { f.status.observation.state.inputLifetimeRevision = '99' }],
    ['surface', f => { f.status.observation.state.surfaceGeneration = '99' }],
    ['render', f => { f.status.observation.state.renderRevision = '99' }],
    ['view', f => { f.status.observation.state.viewRevision = '99' }],
    ['pending presentation', f => { f.status.presentation.inFlight = true }],
    ['viewport', f => { f.status.observation.state.viewport.width = 400 }],
    ['adapter input', f => { f.adapter.inputAuthority = null }],
    ['owner input', f => { f.status.inputEnabled = false }],
    ['scheduler proof', f => { f.status.presentation.accepted.proof = { owner } }],
    ['canvas', f => { f.adapter.canvas = {} }],
  ]
  for (const [name, change] of changes) await t.test(name, async () => {
    const f = fixture(); await f.present(); change(f)
    assert.throws(() => f.observer.snapshot(f.session), { code: 'ERR_CONFORMANCE_OBSERVATION' })
  })
})

test('aborted and late finals are never captured by the diagnostic branch', async () => {
  const f = fixture(), abort = new AbortController(), frame = cloneReply(f.state)
  let resolve
  const pending = new Promise(done => { resolve = done }); f.queue.push(pending)
  const options = { signal: abort.signal, onLateResponse() {} }
  const original = f.wrapped.requestHost('frame', {}, options)
  abort.abort(); resolve(frame); assert.equal(await original, frame)
  assert.equal(f.observer.diagnostics.retainedFrames, 0)
  options.onLateResponse({ payload: { status: 'ok', result: frame } })
  assert.equal(f.observer.diagnostics.retainedFrames, 0)
})

test('retained data is bounded; an evicted frame cannot be replaced from caller state', async () => {
  const f = fixture({ maxFrames: 2 })
  await f.present()
  for (const revision of ['5', '6']) { const state = { ...f.state, renderRevision: revision }; await f.send('frame.current', cloneReply(state)) }
  assert.equal(f.observer.diagnostics.retainedFrames, 2)
  assert.throws(() => f.observer.snapshot(f.session), /subsequent actual ACK/)
  f.observer.close()
  assert.equal(f.observer.diagnostics.retainedFrames, 0); assert.equal(f.observer.diagnostics.retainedAcks, 0)
  await f.send('frame', cloneReply(f.state))
  assert.equal(f.observer.diagnostics.retainedFrames, 0)
})

test('controller uses Rust-projected coordinate input; expected-value fields are rejected', async () => {
  const f = fixture(); await f.present()
  const projections = [], requests = []
  const projectFrameJson = (frame, request) => {
    projections.push({ frame: JSON.parse(frame), request: JSON.parse(request) })
    const address = JSON.parse(request)
    return JSON.stringify({ status: 'ok', result: { route: address.route, selector: address.selector, point: { x: 10, y: 20 } } })
  }
  const before = f.observer.snapshot(f.session)
  const after = { ...before, renderRevision: '5' }
  let completed = false
  const observer = { diagnostics: { fault: null }, snapshot: () => completed ? after : before }
  const session = { ...f.session, status: f.status, async request(op, payload) { requests.push({ op, payload }); completed = true } }
  const controller = new WebConformanceController({ session, observer, projectFrameJson, timeoutMs: 100 })
  await assert.rejects(controller.request('query', { route: 'pages/test/index', selector: '#x', text: 'forbidden expected' }), /unsupported field/)
  const tap = await controller.request('tap', { route: 'pages/test/index', selector: '#x' })
  assert.equal(tap.inputTransport, 'web-host-coordinate-event')
  assert.deepEqual(projections[0].request, { op: 'tap', route: 'pages/test/index', selector: '#x' })
  assert.deepEqual(requests, [{ op: 'event.batch', payload: { events: [{ type: 'tap', x: 10, y: 20,
    detail: { x: 10, y: 20 }, button: 0, buttons: 0, bubbles: true }] } }])
})

test('close preserves the owning terminal barrier, rejects new work, and verifies real local cleanup', async () => {
  const f = fixture(); await f.present()
  let resolve
  const receipt = { closed: true, workerClosed: true, ownedMountRemoved: true }, barrier = new Promise(done => { resolve = done })
  f.session.close = async () => { await barrier; f.status.phase = 'closed'; f.adapter.inputAuthority = null
    Object.assign(f.adapterStatus, { disposed: true, ownedSurfaces: 0, ownedPresenters: 0 }); return receipt }
  const controller = new WebConformanceController({ session: f.session, observer: f.observer, projectFrameJson() {} })
  const close = controller.close(); assert.equal(controller.close(), close)
  assert.equal(f.observer.diagnostics.closed, false)
  assert.throws(() => controller.request('query', {}), /closing/)
  resolve(); assert.equal(await close, receipt); assert.equal(f.observer.diagnostics.closed, true)
  const bad = fixture(); await bad.present(); bad.status.phase = 'closed'
  assert.throws(() => bad.observer.verifyClosed(bad.session, receipt), /still owns/)
})
