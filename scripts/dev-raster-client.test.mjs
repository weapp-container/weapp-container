import assert from 'node:assert/strict'
import test from 'node:test'
import { DevRasterPresenterClient } from '../examples/hosts/web-wasm/dev-raster-client.mjs'
import { SseBridgeTransport } from '../examples/hosts/web-wasm/dom-session-client.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const committed = extra => ({ sessionId: 'session-a', pageId: '1', configGeneration: '1', clientId: 'owner', epoch: '1', connectionToken: 'opaque-committed-token', ...extra })
function frame({ frameId = '1', renderRevision = frameId, configGeneration = '1', sessionId = 'session-a', previewGeneration = '1', presentationEpoch = frameId } = {}) {
  const target = { sessionId, previewId: 'owner', previewGeneration, frameId, sourceFrameId: frameId, renderRevision, configGeneration, logicalWidth: 375, logicalHeight: 667, width: 1, height: 1 }
  const metadata = { schemaVersion: 2, protocolVersion: '2.0', sessionId, frameId, sourceFrameId: target.sourceFrameId, renderRevision, configGeneration, logicalWidth: 375, logicalHeight: 667, width: 1, height: 1, stride: 4, format: 'rgba8', byteLength: 4, renderMs: 0, url: '/api/frame', presentationTicket: { version: '1.0', presentationEpoch, target } }
  const bytes = new TextEncoder().encode(JSON.stringify(metadata)), buffer = new ArrayBuffer(4 + bytes.length + 4)
  new DataView(buffer).setUint32(0, bytes.length, true)
  new Uint8Array(buffer, 4, bytes.length).set(bytes)
  new Uint8Array(buffer, 4 + bytes.length).set([128, 64, 32, 128])
  return buffer
}
function fixture(t, options = {}) {
  const previous = globalThis.ImageData
  globalThis.ImageData = class { constructor(pixels, width, height) { Object.assign(this, { pixels, width, height }) } }
  const callbacks = new Map(), requests = [], drawings = [], states = [], diagnostics = []
  let sequence = 0, sendResponse = () => ({ queued: true })
  const canvas = { width: 1, height: 1, getContext: () => ({ putImageData: image => drawings.push(image) }) }
  const client = new DevRasterPresenterClient({ canvas, scheduleFrame: callback => { callbacks.set(++sequence, callback); return sequence }, cancelFrame: handle => callbacks.delete(handle),
    send(envelope, { signal }) { requests.push({ envelope, signal }); return sendResponse(envelope, { signal }) },
    onState: value => states.push(value), onDiagnostic: error => diagnostics.push(error), ...options })
  t.after(() => { client.dispose(); if (previous === undefined) delete globalThis.ImageData; else globalThis.ImageData = previous })
  function receive(index, payload, overrides = {}) {
    const envelope = requests[index].envelope
    return client.receive({ messages: [{ ...envelope, preview: undefined, kind: 'response', payload: { ok: true, ...payload }, ...overrides }] })
  }
  return { client, canvas, callbacks, requests, drawings, states, diagnostics, receive,
    setSendResponse(value) { sendResponse = value },
    offer(buffer) { return client.offer(buffer, client.captureFrameRequest()) },
    async raf() {
      const first = callbacks.entries().next().value; assert(first, 'expected one scheduled RAF')
      callbacks.delete(first[0]); first[1](0); await tick()
    },
    ack(index, inputEnabled = true) { return receive(index, { presentationTicket: requests[index].envelope.payload.presentationTicket, inputEnabled }) },
  }
}

test('RAF draw and HTTP queued receipt cannot open input; only the exact final response can', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame())
  await assert.rejects(f.client.events([]), { code: 'ERR_CANCELLED' })
  assert.equal(f.drawings.length, 0); assert.equal(f.client.inputEnabled, false)
  await f.raf()
  assert.equal(f.drawings.length, 1); assert.equal(f.client.inputEnabled, false)
  assert.equal(f.requests[0].envelope.op, 'dev.raster.presented')
  assert.deepEqual(f.requests[0].envelope.payload.draw, { endpoint: 'canvas2d-raf-draw-return' })
  assert.equal(f.receive(0, { queued: true }), 0)
  assert.equal(f.receive(0, { inputEnabled: true }, { requestId: 'another-request' }), 0)
  assert.equal(f.client.inputEnabled, false)
  assert.equal(f.ack(0), 1); await tick()
  assert.equal(f.client.inputEnabled, true)
  assert.equal(f.ack(0), 0, 'duplicate response has no second completion')
})

test('a correlated success containing a different ticket fails closed', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  const wrong = structuredClone(f.requests[0].envelope.payload.presentationTicket); wrong.presentationEpoch = '2'
  f.receive(0, { presentationTicket: wrong, inputEnabled: true }); await tick()
  assert.equal(f.client.inputEnabled, false)
  assert.equal(f.diagnostics.at(-1).code, 'ERR_PROTOCOL_VERSION')
})

test('new pending pixels freeze old input and late ACK cannot unfreeze the newer transaction', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  f.offer(frame({ frameId: '2' })); f.ack(0); await tick()
  assert.equal(f.client.inputEnabled, false)
  assert.equal(f.callbacks.size, 1)
  await f.raf(); f.ack(1); await tick(); assert.equal(f.client.inputEnabled, true)
  f.offer(frame({ frameId: '3' })); assert.equal(f.client.inputEnabled, false)
  await assert.rejects(f.client.events([]), { code: 'ERR_CANCELLED' })
})

test('replacing a committed token invalidates even equal numeric identities and pending RAF', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame())
  assert.equal(f.callbacks.size, 1)
  f.client.setBinding(committed({ connectionToken: 'new-committed-token' }))
  assert.equal(f.callbacks.size, 0); assert.equal(f.client.inputEnabled, false)
  f.offer(frame()); await f.raf()
  assert.equal(f.requests[0].envelope.preview.connectionToken, 'new-committed-token')
  f.ack(0); await tick(); assert.equal(f.client.inputEnabled, true)
})

test('disconnect before send microtask suppresses the old request rather than adding a new token', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame())
  const [handle, callback] = f.callbacks.entries().next().value; f.callbacks.delete(handle); callback(0)
  f.client.disconnect(); f.client.setBinding(committed({ connectionToken: 'successor-token' }))
  await tick(); assert.equal(f.requests.length, 0); assert.equal(f.client.inputEnabled, false)
  f.offer(frame()); await f.raf(); assert.equal(f.requests[0].envelope.preview.connectionToken, 'successor-token')
})

test('binding page, session, configuration and owner epoch changes reject old work', async t => {
  const f = fixture(t)
  for (const extra of [{ pageId: '2' }, { sessionId: 'session-b' }, { configGeneration: '2' }, { epoch: '2' }]) {
    f.client.setBinding(committed()); f.offer(frame()); await f.raf()
    const old = f.requests.length - 1
    f.client.setBinding(committed(extra)); f.ack(old); await tick()
    assert.equal(f.client.inputEnabled, false)
  }
  assert.throws(() => f.offer(frame()), { code: 'ERR_CANCELLED' })
})

test('one pending frame coalesces updates and orders maximum u64 values without rounding', async t => {
  const f = fixture(t); f.client.setBinding(committed())
  f.offer(frame({ frameId: '9007199254740992' }))
  f.offer(frame({ frameId: '9007199254740993' }))
  assert.equal(f.offer(frame({ frameId: '9007199254740992' })), false)
  assert.equal(f.callbacks.size, 1); await f.raf()
  assert.equal(f.requests[0].envelope.payload.presentationTicket.target.frameId, '9007199254740993')
  f.ack(0); await tick()
  assert.equal(f.offer(frame({ frameId: '9007199254740993' })), false)
  assert.equal(f.callbacks.size, 0); assert.equal(f.client.inputEnabled, true)
  assert.throws(() => f.offer(frame({ frameId: '9007199254740993', presentationEpoch: '4' })), { code: 'ERR_PROTOCOL_VERSION' })
  assert.equal(f.client.inputEnabled, false, 'a malformed reused identity must not retain input permission')
})

test('input carries the accepted exact ticket and final queued input does not reopen superseded pixels', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame()); await f.raf(); f.ack(0); await tick()
  const input = f.client.events([{ type: 'tap', x: 1, y: 2 }]); await tick()
  const envelope = f.requests[1].envelope
  assert.equal(envelope.op, 'event.batch')
  assert.deepEqual(envelope.preview, { clientId: 'owner', epoch: '1', connectionToken: 'opaque-committed-token' })
  assert.deepEqual(envelope.payload.logicalViewport, { width: 375, height: 667 })
  assert.deepEqual(envelope.payload.presentationTicket, f.requests[0].envelope.payload.presentationTicket)
  f.offer(frame({ frameId: '2' })); f.receive(1, {}); await input
  assert.equal(f.client.inputEnabled, false)
})

test('timeout keeps input disabled and explicit bounded retry uses the same issued ticket', async t => {
  const f = fixture(t, { timeoutMs: 15 }); f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.client.inputEnabled, false); assert.equal(f.diagnostics.at(-1).code, 'ERR_TIMEOUT')
  assert.equal(f.client.retryPresentation(), true); await f.raf()
  assert.deepEqual(f.requests[1].envelope.payload.presentationTicket, f.requests[0].envelope.payload.presentationTicket)
  assert.notEqual(f.requests[1].envelope.requestId, f.requests[0].envelope.requestId)
  f.receive(1, { presentationTicket: f.requests[1].envelope.payload.presentationTicket, inputEnabled: false }); await tick()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.client.retryPresentation(), false)
})

test('drawing failure and malformed frames retain existing pixels but never authorize input', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame()); await f.raf(); f.ack(0); await tick()
  assert.throws(() => f.offer(new ArrayBuffer(0)), { code: 'ERR_PROTOCOL_VERSION' })
  assert.equal(f.drawings.length, 1); assert.equal(f.client.inputEnabled, false)
  f.canvas.getContext = () => null
  f.offer(frame({ frameId: '2' })); await f.raf()
  assert.equal(f.requests.length, 1); assert.equal(f.client.inputEnabled, false)
  assert.equal(f.diagnostics.at(-1).code, 'ERR_RENDER')
})

test('disposal and throwing RAF cleanup still retire input and owned pending requests', async t => {
  const f = fixture(t, { cancelFrame() { throw new Error('injected RAF cleanup failure') } })
  f.client.setBinding(committed()); f.offer(frame()); f.client.dispose()
  assert.equal(f.client.inputEnabled, false)
  assert.equal(f.diagnostics.at(-1).message, 'injected RAF cleanup failure')
  const callback = f.callbacks.values().next().value; callback(0); await tick()
  assert.equal(f.drawings.length, 0); assert.equal(f.requests.length, 0)
  assert.throws(() => f.client.setBinding(committed()), { code: 'ERR_CANCELLED' })
})

test('late frame fetches retain their original page and connection binding even when wire identities collide', async t => {
  const f = fixture(t); f.client.setBinding(committed())
  for (const extra of [{ pageId: '2' }, { connectionToken: 'replacement-token' }]) {
    const captured = f.client.captureFrameRequest()
    f.client.setBinding(committed(extra))
    assert.throws(() => f.client.offer(frame(), captured), { code: 'ERR_CANCELLED' })
    assert.equal(f.callbacks.size, 0); assert.equal(f.drawings.length, 0)
  }
  assert.throws(() => f.client.offer(frame()), { code: 'ERR_CANCELLED' }, 'omitting the original fetch capture must not use a newer binding')
  f.offer(frame()); await f.raf(); f.ack(0); await tick(); assert.equal(f.client.inputEnabled, true)
})

test('malformed frames revoke an in-flight ACK so its late success cannot reopen input', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  assert.throws(() => f.offer(new ArrayBuffer(0)), { code: 'ERR_PROTOCOL_VERSION' })
  f.ack(0); await tick()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.callbacks.size, 0)
  assert.equal(f.client.retryPresentation(), true); await f.raf(); f.ack(1); await tick()
  assert.equal(f.client.inputEnabled, true, 'recovery requires another explicit final acknowledgment')
})

test('dispose closes the barrier before reentrant state or diagnostic callbacks can rebuild a preview', async t => {
  let f, stateReentry = 0, diagnosticReentry = 0
  f = fixture(t, {
    onState(value) {
      if (value.phase !== 'disconnected') return
      stateReentry++
      assert.throws(() => f.client.setBinding(committed({ connectionToken: 'reentrant-state' })), { code: 'ERR_CANCELLED' })
    },
    onDiagnostic() {
      diagnosticReentry++
      assert.throws(() => f.client.setBinding(committed({ connectionToken: 'reentrant-diagnostic' })), { code: 'ERR_CANCELLED' })
    },
    cancelFrame() { throw new Error('injected cleanup diagnostic') },
  })
  f.client.setBinding(committed()); f.offer(frame()); f.client.dispose()
  assert.equal(stateReentry, 1); assert.equal(diagnosticReentry, 1)
  assert.equal(f.client.binding, null); assert.equal(f.client.pending, null); assert.equal(f.client.latest, null)
  assert.equal(f.client.scheduled, null); assert.equal(f.client.inputEnabled, false)
  assert.equal(f.client.transport.closed, true)
})

test('Raster HTTP final-shaped ACK batches cannot open input or revive a refused request through late SSE', async t => {
  const f = fixture(t)
  f.setSendResponse(envelope => ({ ok: true, status: 200, json: async () => ({ messages: [{ ...envelope, kind: 'response', payload: { ok: true, presentationTicket: envelope.payload.presentationTicket, inputEnabled: true } }] }) }))
  f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.client.accepted, null)
  assert.equal(f.diagnostics.at(-1).code, 'ERR_PROTOCOL_VERSION'); assert.equal(f.client.transport.pending.size, 0)
  assert.equal(f.ack(0), 0); await tick(); assert.equal(f.client.inputEnabled, false, 'a late final cannot reopen the rejected HTTP attempt')
  f.setSendResponse(() => ({ queued: true })); assert.equal(f.client.retryPresentation(), true); await f.raf()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.ack(1), 1); await tick(); assert.equal(f.client.inputEnabled, true)
})

test('Raster parsed HTTP finals and mixed queued-final bodies never enter the final response channel', async t => {
  const f = fixture(t)
  const final = envelope => ({ ...envelope, kind: 'response', payload: { ok: true, presentationTicket: envelope.payload.presentationTicket, inputEnabled: true } })
  f.setSendResponse(envelope => final(envelope))
  f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.diagnostics.at(-1).code, 'ERR_PROTOCOL_VERSION')
  f.setSendResponse(envelope => ({ queued: true, messages: [final(envelope)] }))
  assert.equal(f.client.retryPresentation(), true); await f.raf()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.diagnostics.at(-1).code, 'ERR_PROTOCOL_VERSION')
  assert.equal(f.ack(0), 0); assert.equal(f.ack(1), 0); await tick(); assert.equal(f.client.inputEnabled, false)
})

test('Raster Fetch-shaped queued receipts wait for a later exact SSE ACK and discard the mutable HTTP object', async t => {
  const f = fixture(t), receipt = {}; let sent
  Object.defineProperty(receipt, 'queued', { enumerable: true, configurable: true, get() {
    queueMicrotask(() => {
      delete receipt.queued
      Object.assign(receipt, { ...sent, kind: 'response', payload: { ok: true, presentationTicket: sent.payload.presentationTicket, inputEnabled: true } })
    })
    return true
  } })
  f.setSendResponse(envelope => { sent = envelope; return { ok: true, status: 202, json: async () => receipt } })
  f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.client.transport.pending.size, 1)
  assert.equal(f.diagnostics.length, 0)
  assert.equal(receipt.kind, 'response', 'the caller changed its own object before the shared receiver ran')
  await tick(); assert.equal(f.client.inputEnabled, false)
  assert.equal(f.ack(0), 1); await tick(); assert.equal(f.client.inputEnabled, true)
})

test('Raster HTTP admission failures and invalid JSON fail closed and cannot be revived by late finals', async t => {
  const f = fixture(t)
  f.setSendResponse(() => ({ ok: false, status: 403, json: async () => ({ ok: false, error: { code: 'ERR_PERMISSION_DENIED', message: 'owned admission denied' } }) }))
  f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.diagnostics.at(-1).code, 'ERR_PERMISSION_DENIED')
  assert.equal(f.diagnostics.at(-1).message, 'owned admission denied'); assert.equal(f.ack(0), 0)
  f.setSendResponse(() => ({ ok: true, status: 202, json: async () => { throw new SyntaxError('bad JSON') } }))
  assert.equal(f.client.retryPresentation(), true); await f.raf()
  assert.equal(f.client.inputEnabled, false); assert.equal(f.diagnostics.at(-1).code, 'ERR_PROTOCOL_VERSION')
  assert.equal(f.ack(1), 0); await tick(); assert.equal(f.client.inputEnabled, false)
})

test('Raster disconnect retires a pending HTTP body and its late final cannot authorize a successor binding', async t => {
  const f = fixture(t); let finishBody
  f.setSendResponse(() => ({ ok: true, status: 202, json: () => new Promise(resolve => { finishBody = resolve }) }))
  f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  assert.equal(typeof finishBody, 'function'); const old = f.requests[0].envelope
  f.client.disconnect(); assert.equal(f.requests[0].signal.aborted, true)
  f.client.setBinding(committed({ connectionToken: 'after-disconnect' }))
  f.setSendResponse(() => ({ queued: true })); f.offer(frame())
  finishBody({ messages: [{ ...old, kind: 'response', payload: { ok: true, presentationTicket: old.payload.presentationTicket, inputEnabled: true } }] })
  await tick(); assert.equal(f.ack(0), 0); assert.equal(f.client.inputEnabled, false)
  await f.raf(); assert.equal(f.requests[1].envelope.preview.connectionToken, 'after-disconnect')
  assert.equal(f.ack(1), 1); await tick(); assert.equal(f.client.inputEnabled, true)
})

test('Raster genuine SSE ACK may settle before a delayed HTTP pseudo-final without giving HTTP authority', async t => {
  const f = fixture(t); let finishHttp
  f.setSendResponse(() => new Promise(resolve => { finishHttp = resolve }))
  f.client.setBinding(committed()); f.offer(frame()); await f.raf()
  const sent = f.requests[0].envelope
  assert.equal(f.client.inputEnabled, false); assert.equal(f.ack(0), 1); await tick(); assert.equal(f.client.inputEnabled, true)
  finishHttp({ messages: [{ ...sent, kind: 'response', payload: { ok: true, presentationTicket: sent.payload.presentationTicket, inputEnabled: true } }] })
  await tick(); assert.equal(f.client.inputEnabled, true); assert.equal(f.diagnostics.length, 0)
  assert.equal(f.ack(0), 0)
})

test('Raster event requests also refuse HTTP pseudo-finals while retaining their already accepted frame', async t => {
  const f = fixture(t); f.client.setBinding(committed()); f.offer(frame()); await f.raf(); f.ack(0); await tick()
  f.setSendResponse(envelope => ({ messages: [{ ...envelope, kind: 'response', payload: { ok: true } }] }))
  await assert.rejects(f.client.events([{ type: 'tap', x: 1, y: 2 }]), { code: 'ERR_PROTOCOL_VERSION' })
  assert.equal(f.client.inputEnabled, true, 'an admission protocol failure does not replace the accepted picture')
  assert.equal(f.receive(1, {}), 0, 'a late input result cannot revive the refused request')
})

test('legacy shared bridge transport still accepts complete correlated HTTP response batches by default', async t => {
  const transport = new SseBridgeTransport({ sessionId: 'legacy-session', send: envelope => ({ messages: [{ ...envelope, kind: 'response', payload: { ok: true, value: 'legacy HTTP final' } }] }) })
  t.after(() => transport.dispose())
  assert.deepEqual(await transport.request('legacy.op', {}), { ok: true, value: 'legacy HTTP final' })
  assert.equal(transport.pending.size, 0)
})
