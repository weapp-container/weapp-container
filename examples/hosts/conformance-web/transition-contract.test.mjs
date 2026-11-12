import test from 'node:test'
import assert from 'node:assert/strict'
import { PresentedFrameObserver } from './frame-observer.mjs'
import { copyExternalPresentationOutcome } from '../../../examples/hosts/web-wasm/worker-runtime.mjs'

// Synthetic boundary data only. No Worker/host/WASM/browser executes here.
// Shape follows the real ready-navigation ACK tested in WebHost::
// ready_navigation_preserves_effects_and_observes_the_new_page_without_input.
const owner = { workerEpoch: 'review-worker', sessionId: 'review-session', packSha256: 'b'.repeat(64), transportBackend: 'external-frame' }
const viewport = { x: 0, y: 0, width: 375, height: 667 }
const state = (revision = '4', pageId = '1', path = 'pages/home/index') => ({
  schemaVersion: 1, sessionId: owner.sessionId, owner: structuredClone(owner),
  transportBackend: 'external-frame', surfaceGeneration: pageId === '1' ? '1' : '2', inputLifetimeRevision: pageId === '1' ? '2' : '3',
  templateRevision: revision, renderRevision: revision, viewRevision: '0', currentPage: { pageId, path },
  lifecycle: 'Active', viewport: { ...viewport }, rendererProfile: 'skia', declaredRendererProfile: 'skia', requiresRestart: false,
})
const observation = (value, sequence) => ({ version: '1.0', sequence, state: structuredClone(value) })
const consumed = value => ({ pageId: value.currentPage.pageId, routePath: value.currentPage.path,
  templateRevision: value.templateRevision, viewport: { ...value.viewport } })
const frame = (value, sequence = '2') => ({ renderRevision: value.renderRevision,
  frame: { frame_id: Number(value.renderRevision), viewport: { ...viewport }, root: { text: `synthetic-${value.currentPage.path}` } },
  scheduling: { version: '1.0', sessionId: owner.sessionId, renderRevision: value.renderRevision, consumedInput: consumed(value) },
  observation: observation(value, sequence),
})
const ack = (value, { inputEnabled = true, sequence = '3', messages = [] } = {}) => {
  const runtime = structuredClone(value)
  delete runtime.owner; delete runtime.inputLifetimeRevision; delete runtime.surfaceGeneration
  runtime.viewport = { width: viewport.width, height: viewport.height }
  return { version: '1.0', sessionId: owner.sessionId, renderRevision: value.renderRevision,
    acknowledged: true, inputEnabled, requiresRestart: false, batch: { messages },
    observedState: runtime, observation: observation(value, sequence) }
}
function fixture(Observer = PresentedFrameObserver) {
  const observer = new Observer({ enabled: true }), queue = [], canvas = {}
  const rpc = Object.freeze({ actualFinalContract: '1.0', workerEpoch: owner.workerEpoch, sessionId: owner.sessionId,
    requestHost: () => queue.shift() })
  const wrapped = observer.wrapRpc(rpc, owner)
  const adapterStatus = { lastAck: null }, adapter = { owner, canvas, inputAuthority: null, status: adapterStatus }
  const status = { phase: 'ready', runtimeReady: true, visible: true, inputEnabled: false, requiresRestart: false,
    fault: null, metricsPending: 0, observation: null,
    presentation: { phase: 'idle', inFlight: false, hasRaf: false, accepted: null } }
  const session = { owner, status }
  observer.attachAdapter(adapter)
  const send = async (op, reply) => {
    const promise = Promise.resolve(reply); queue.push(promise)
    const returned = wrapped.requestHost(op, op === 'ack' ? { renderRevision: reply.renderRevision } : {}, {})
    assert.equal(returned, promise)
    assert.equal(await returned, reply)
  }
  const accept = (value, final) => {
    const input = consumed(value), publication = { kind: 'external-frame', renderRevision: value.renderRevision }
    adapter.inputAuthority = { enabled: true, owner, canvas, surfaceGeneration: value.surfaceGeneration, consumedInput: input, publication }
    adapterStatus.lastAck = final
    Object.assign(status, { inputEnabled: true, observation: final.observation })
    status.presentation.accepted = { inputEnabled: true,
      proof: { owner, surfaceGeneration: value.surfaceGeneration, consumedInput: input, publication } }
  }
  return { observer, session, adapterStatus, send, accept }
}

test('a valid onReady navigation ACK preserves the real result and allows the new page publication', async () => {
  const f = fixture(), first = state(), nextPage = state('4', '2', 'pages/second/index')
  await f.send('frame', frame(first))
  const effect = { protocolVersion: '1.0', sessionId: owner.sessionId, requestId: 'runtime-ready',
    kind: 'event', op: 'page.load', payload: { pageId: '2', path: 'pages/second/index' } }
  const blocked = ack(nextPage, { inputEnabled: false, messages: [effect] })
  await f.send('ack', blocked)
  assert.equal(f.observer.diagnostics.fault, null)
  assert.deepEqual(blocked.batch.messages, [effect])
  assert.throws(() => f.observer.snapshot(f.session), { code: 'ERR_CONFORMANCE_OBSERVATION' })
  const next = state('5', '2', 'pages/second/index'), accepted = ack(next, { sequence: '5' })
  await f.send('frame', frame(next, '4')); await f.send('ack', accepted); f.accept(next, accepted)
  const snapshot = f.observer.snapshot(f.session)
  assert.equal(snapshot.observation.state.currentPage.path, 'pages/second/index')
  assert.equal(snapshot.renderRevision, '5')
  assert.equal(snapshot.acknowledgement.inputEnabled, true)
  assert.equal(f.observer.diagnostics.fault, null)
})

test('a blocked ACK never becomes a readable snapshot even when other authority fields claim acceptance', async () => {
  const f = fixture(), current = state(), blocked = ack(current, { inputEnabled: false })
  await f.send('frame', frame(current)); await f.send('ack', blocked); f.accept(current, blocked)
  assert.equal(f.observer.diagnostics.fault, null)
  assert.throws(() => f.observer.snapshot(f.session), /subsequent actual ACK/)
})

test('negative ACKs keep protocol and ordered-state mismatch rejection strict', async t => {
  for (const [name, mutate] of [
    ['foreign session', value => { value.sessionId = 'other' }],
    ['ACK relabels consumed input', value => { value.consumedInput = consumed(state()) }],
    ['ordered page differs', value => { value.observedState.currentPage.path = 'pages/other/index' }],
  ]) await t.test(name, async () => {
    const f = fixture(), blocked = ack(state(), { inputEnabled: false }); mutate(blocked)
    await f.send('ack', blocked)
    assert.ok(f.observer.diagnostics.fault)
  })
})
