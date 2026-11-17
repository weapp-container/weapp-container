import assert from 'node:assert/strict'
import test from 'node:test'
import { DevRasterPreview } from '../examples/hosts/web-wasm/dev-raster-preview.mjs'
import { DevRasterPresenterClient } from '../examples/hosts/web-wasm/dev-raster-client.mjs'
import { decodeDevRasterFrame } from '../examples/hosts/web-wasm/dev-raster-frame.mjs'

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function state({ sessionId = 'session-a', pageId = '1', configGeneration = '1', epoch = '1', ownerClientId = 'owner', expired = false } = {}) {
  return { sessionId, preview: { version: '1.0', epoch, ownerClientId, expired, leaseDurationMs: 15000 },
    devRaster: { profile: 'ticketed-raster-v1', protocolVersion: '1.0', binaryFrameVersion: 2, ackOp: 'dev.raster.presented', connectionInitEvent: 'preview-init', binding: { sessionId, pageId, configGeneration } } }
}
function frame({ sessionId = 'session-a', configGeneration = '1', previewId = 'owner', previewGeneration = '1', frameId = '1' } = {}) {
  const target = { sessionId, configGeneration, previewId, previewGeneration, frameId, sourceFrameId: frameId, renderRevision: frameId, logicalWidth: 375, logicalHeight: 667, width: 1, height: 1 }
  const header = { schemaVersion: 2, protocolVersion: '2.0', sessionId, configGeneration, frameId, sourceFrameId: frameId, renderRevision: frameId,
    logicalWidth: 375, logicalHeight: 667, width: 1, height: 1, stride: 4, format: 'rgba8', byteLength: 4, renderMs: 0,
    url: '/api/frame', presentationTicket: { version: '1.0', presentationEpoch: frameId, target } }
  const bytes = new TextEncoder().encode(JSON.stringify(header)), result = new ArrayBuffer(4 + bytes.length + 4)
  new DataView(result).setUint32(0, bytes.length, true); new Uint8Array(result, 4, bytes.length).set(bytes); new Uint8Array(result, 4 + bytes.length).set([128, 64, 32, 128]); return result
}
class Source {
  listeners = new Map(); closed = false
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback) }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback) }
  close() { this.closed = true }
  emit(name, value) { for (const callback of [...this.listeners.get(name) ?? []]) callback({ data: typeof value === 'string' ? value : JSON.stringify(value) }) }
}
function fixture(t, options = {}) {
  const previousImageData = globalThis.ImageData
  globalThis.ImageData = class { constructor(pixels, width, height) { Object.assign(this, { pixels, width, height }) } }
  const sources = [], requests = [], controls = [], states = [], diagnostics = [], timers = new Map(), rafs = new Map(), offers = [], received = [], drawings = [], eventCalls = [], presenterOptions = []
  let sequence = 0, clock = 0, currentState = state(), frameBody = () => frame(), stateBody = () => currentState
  let previewReceipt = body => ({ queued: true, requestId: body.requestId })
  const presenter = { binding: null, latest: null, inputEnabled: false, closed: false,
    setBinding(value) { if (JSON.stringify(value) !== JSON.stringify(this.binding)) { this.binding = Object.freeze({ ...value }); this.latest = null; this.inputEnabled = false } },
    disconnect() { this.binding = null; this.latest = null; this.inputEnabled = false },
    captureFrameRequest() { assert(this.binding); return Object.freeze({ client: this, binding: this.binding }) },
    offer(buffer, captured) { assert.equal(captured.binding, this.binding); this.latest = decodeDevRasterFrame(buffer); offers.push({ frame: this.latest, captured }); return true },
    receive(batch) { received.push(batch) }, events(events) { eventCalls.push({ events, ticket: this.latest.presentationTicket, binding: this.binding }); return Promise.resolve({ ok: true }) },
    retryPresentation() { return !!this.binding }, dispose() { this.closed = true; this.disconnect() },
  }
  const json = body => ({ ok: true, status: 200, json: async () => body })
  const api = new DevRasterPreview({ canvas: { width: 1, height: 1, getContext: () => ({ putImageData: image => drawings.push(image) }) }, clientId: 'owner',
    fetch: async (url, init) => {
      requests.push({ url, init })
      if (url === '/api/state') return json(await stateBody())
      if (url === '/api/preview') { const body = JSON.parse(init.body); controls.push(body); return json(await previewReceipt(body)) }
      if (url === '/api/frame') return { ok: true, status: 200, headers: { get: () => 'application/vnd.weapp.frame.v2' }, arrayBuffer: () => frameBody() }
      if (url === '/api/bridge') return json({ queued: true })
      throw new Error(`unexpected endpoint: ${url}`)
    },
    createEventSource: url => { const source = new Source(); source.url = url; sources.push(source); return source },
    createPresenter: options => { presenterOptions.push(options); return presenter },
    scheduleFrame: callback => { const id = ++sequence; rafs.set(id, callback); return id }, cancelFrame: id => rafs.delete(id),
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: clock + delay }); return id }, clearTimeout: id => timers.delete(id),
    clock: () => clock,
    controlTimeoutMs: 1000, heartbeatMs: 5000, onState: value => states.push(value), onDiagnostic: value => diagnostics.push(value), ...options })
  t.after(() => { api.dispose(); if (previousImageData === undefined) delete globalThis.ImageData; else globalThis.ImageData = previousImageData })
  const f = { api, presenter, sources, requests, controls, states, diagnostics, timers, rafs, offers, received, drawings, eventCalls, presenterOptions,
    setState: value => { currentState = value }, setStateBody: value => { stateBody = value }, setFrameBody: value => { frameBody = value }, setPreviewReceipt: value => { previewReceipt = value },
    jumpWithoutTimers(ms) { clock += ms }, setClock(value) { clock = value },
    init(source = sources.at(-1), token = 'private-token') { source.emit('preview-init', { version: '1.0', clientId: 'owner', connectionToken: token, committed: false }) },
    final(index = controls.length - 1, projection = currentState.preview, source = sources.at(-1)) {
      source.emit('preview', { ok: true, requestId: controls[index].requestId, clientId: 'owner', preview: projection })
    },
    async connect() { api.connect(); await flush(); f.init(); await flush(); return sources.at(-1) },
    async establish() { await f.connect(); f.final(); await flush() },
    async advance(ms) {
      const until = clock + ms
      for (;;) {
        const next = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        clock = Math.max(clock, next[1].at); timers.delete(next[0]); next[1].callback(); await flush()
      }
      clock = until; await flush()
    },
    async raf() { const first = rafs.entries().next().value; assert(first); rafs.delete(first[0]); first[1](0); await flush() },
  }
  return f
}

test('private init, public owner and HTTP queued receipts never substitute for the exact final bound heartbeat', async t => {
  const f = fixture(t); await f.connect()
  assert.equal(f.api.owner, false); assert.equal(f.presenter.binding, null); assert.equal(f.offers.length, 0)
  assert.match(f.sources[0].url, /^\/api\/events\?clientId=owner&since=0$/)
  assert.equal(f.controls[0].op, 'heartbeat'); assert.equal(f.controls[0].connectionToken, 'private-token')
  f.sources[0].emit('preview', { ok: true, requestId: 'not-this-heartbeat', clientId: 'owner', preview: state().preview }); await flush()
  assert.equal(f.api.owner, false)
  f.final(0); await flush()
  assert.equal(f.api.owner, true); assert.equal(f.presenter.binding.connectionToken, 'private-token'); assert(f.offers.length >= 1)
  assert.equal(f.api.inputEnabled, false, 'the connection proof is not a draw ACK')
  assert(f.states.every(value => !Object.hasOwn(value, 'connectionToken')))
})

test('SSE bridge batches reach the presenter and input captures synchronously with no manager await', async t => {
  const f = fixture(t); await f.establish()
  const batch = { messages: [{ op: 'dev.raster.presented', kind: 'response', payload: { ok: true } }] }
  f.sources[0].emit('bridge', batch); assert.deepEqual(f.received, [batch])
  await assert.rejects(f.api.events([]), { code: 'ERR_CANCELLED' })
  f.presenter.inputEnabled = true
  const events = [{ type: 'tap', x: 1, y: 2 }], pending = f.api.events(events)
  assert.equal(f.eventCalls.length, 1); assert.equal(f.eventCalls[0].events, events)
  f.api.disconnect(); await pending
})

test('same-client reconnect has a new actual source and old final/init/EOF cannot authorize or retire it', async t => {
  const f = fixture(t); const old = await f.connect(), oldInit = [...old.listeners.get('preview-init')][0], oldPreview = [...old.listeners.get('preview')][0], oldError = [...old.listeners.get('error')][0]
  f.api.connect(); await flush(); f.init(f.sources[1], 'successor-token'); await flush()
  assert.equal(old.closed, true); assert.equal(f.api.owner, false)
  oldInit({ data: JSON.stringify({ version: '1.0', clientId: 'owner', connectionToken: 'private-token', committed: false }) })
  oldPreview({ data: JSON.stringify({ ok: true, requestId: f.controls[0].requestId, clientId: 'owner', preview: state().preview }) }); oldError({})
  assert.equal(f.api.connection.source, f.sources[1]); assert.equal(f.api.owner, false)
  f.final(1); await flush(); assert.equal(f.presenter.binding.connectionToken, 'successor-token'); assert.equal(f.api.owner, true)
})

test('replayed state and preview bodies trigger fresh state GETs instead of reverting the current page', async t => {
  const f = fixture(t); f.setState(state({ sessionId: 'new-session', pageId: '3', configGeneration: '9' })); f.setFrameBody(() => frame({ sessionId: 'new-session', configGeneration: '9' })); await f.establish()
  f.sources[0].emit('state', state()); f.sources[0].emit('preview', { preview: state({ epoch: '0', ownerClientId: null }).preview }); await flush()
  assert.equal(f.api.connection.authority.sessionId, 'new-session'); assert.equal(f.presenter.binding.pageId, '3'); assert.equal(f.presenter.binding.configGeneration, '9')
})

test('late frame bodies keep their captured page and token and fetches coalesce without overlap', async t => {
  const f = fixture(t), first = deferred(); let count = 0, active = 0, maximum = 0
  f.setFrameBody(() => { active++; maximum = Math.max(maximum, active); return (count++ === 0 ? first.promise : Promise.resolve(frame({ frameId: '2' }))).finally(() => { active-- }) })
  await f.establish(); assert.equal(count, 1)
  for (let i = 0; i < 4; i++) f.sources[0].emit('snapshot', {})
  await flush(); assert.equal(count, 1)
  f.setState(state({ pageId: '2' })); f.sources[0].emit('state', {}); await flush()
  first.resolve(frame()); await flush()
  assert(f.offers.every(offer => offer.captured.binding.pageId === '2'))
  // The deliberately abort-ignoring body is released here. It never gets offered.
  assert.equal(f.offers.some(offer => offer.frame.frameId === '1'), false)
  assert.equal(maximum <= 2, true, 'only a cancelled, abort-ignoring injected body can outlive the one logical fetch slot')
})

test('a mirror draws through decoder/RAF only and claims only after an explicit call plus another heartbeat', async t => {
  const f = fixture(t); f.setState(state({ ownerClientId: 'other' })); f.setFrameBody(() => frame({ previewId: 'other' })); await f.establish()
  assert.equal(f.api.owner, false); assert.equal(f.presenter.binding, null); assert.equal(f.offers.length, 0)
  assert(f.controls.every(control => control.op === 'heartbeat')); assert.equal(f.drawings.length, 0)
  await f.raf(); assert.equal(f.drawings.length, 1); assert.equal(f.received.length, 0)
  assert.equal(f.states.at(-1).presentationTicket.target.logicalWidth, 375)
  assert.equal(f.states.at(-1).inputEnabled, false, 'readonly geometry metadata is not owner authority')
  await assert.rejects(f.api.events([]), { code: 'ERR_CANCELLED' })
  const claimed = f.api.claim(); await flush(); assert.equal(f.controls.at(-1).op, 'claim')
  f.setState(state({ epoch: '2' })); f.setFrameBody(() => frame({ previewGeneration: '2' })); f.final(); await claimed; await flush()
  assert.equal(f.api.owner, false, 'a claim response does not replace final heartbeat proof')
  assert.equal(f.controls.at(-1).op, 'heartbeat'); f.final(); await flush(); assert.equal(f.api.owner, true)
})

test('normal heartbeat renewal preserves the same accepted binding and exact proof references', async t => {
  const f = fixture(t); await f.establish(); f.presenter.inputEnabled = true
  const binding = f.presenter.binding, proof = f.api.connection.proof
  await f.advance(5000); assert.equal(f.controls.at(-1).op, 'heartbeat'); assert.equal(f.api.inputEnabled, true)
  f.final(); await flush()
  assert.equal(f.api.connection.proof, proof); assert.equal(f.presenter.binding, binding); assert.equal(f.api.inputEnabled, true)
})

test('a frame fetch failure recovers through a bounded retry and explicitly restores the same confirmed binding', async t => {
  const f = fixture(t); let attempts = 0
  f.setFrameBody(() => { if (++attempts === 1) throw new Error('temporary frame transport failure'); return frame() })
  await f.establish(); await f.advance(250)
  assert(attempts >= 2); assert(f.offers.length >= 1)
  assert.equal(f.presenter.binding.connectionToken, 'private-token'); assert.equal(f.api.owner, true)
  assert.equal(f.api.inputEnabled, false, 'recovery still requires the separate exact final presentation ACK')
})

test('unconfirmed final heartbeats have bounded deadlines and attempts and close their owned actual source', async t => {
  const f = fixture(t, { maxHandshakeAttempts: 2 }); await f.connect()
  await f.advance(1000); assert.equal(f.api.owner, false)
  await f.advance(250); assert.equal(f.controls.length, 2)
  await f.advance(1250)
  assert.equal(f.sources[0].closed, true); assert.equal(f.api.connection, null); assert.equal(f.timers.size, 0)
  assert(f.diagnostics.some(value => value.code === 'ERR_TIMEOUT'))
})

test('missing private init and unavailable state have finite cleanup instead of leaving a frozen live source', async t => {
  const f = fixture(t); f.api.connect(); await flush(); await f.advance(1000)
  assert.equal(f.sources[0].closed, true); assert.equal(f.api.connection, null)
  f.setStateBody(() => { throw new Error('state offline') }); f.api.connect(); f.init(f.sources[1]); await flush(); await f.advance(500)
  assert.equal(f.sources[1].closed, true); assert.equal(f.api.connection, null); assert.equal(f.timers.size, 0)
})

test('EOF cancels the original final heartbeat and late callbacks cannot claim a successor', async t => {
  const f = fixture(t); const source = await f.connect(), listener = [...source.listeners.get('preview')][0]
  source.emit('error', {}); await flush()
  assert.equal(f.api.connection, null); assert.equal(source.closed, true); assert.equal(f.timers.size, 0)
  listener({ data: JSON.stringify({ ok: true, requestId: f.controls[0].requestId, clientId: 'owner', preview: state().preview }) })
  assert.equal(f.api.owner, false); assert.equal(f.presenter.binding, null)
})

test('dispose is terminal before state callbacks, cancels mirror RAF, closes only owned sources and aborts requests', async t => {
  let f, reentries = 0
  f = fixture(t, { onState(value) { if (value.phase === 'disposed') { reentries++; assert.throws(() => f.api.connect(), { code: 'ERR_CANCELLED' }) } } })
  f.setState(state({ ownerClientId: 'other' })); f.setFrameBody(() => frame({ previewId: 'other' })); await f.establish(); assert.equal(f.rafs.size, 1)
  f.api.dispose(); assert.equal(f.sources[0].closed, true); assert.equal(f.rafs.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.presenter.closed, true)
  assert.equal(reentries, 1); await assert.rejects(f.api.claim(), { code: 'ERR_CANCELLED' }); f.api.dispose(); assert.equal(reentries, 1)
  assert([...f.sources[0].listeners.values()].every(callbacks => callbacks.size === 0))
})

test('an HTTP body shaped like correlated final success cannot impersonate the actual SSE heartbeat', async t => {
  const f = fixture(t)
  f.setPreviewReceipt(body => ({ ok: true, requestId: body.requestId, clientId: 'owner', preview: state().preview }))
  await f.connect()
  assert.equal(f.api.owner, false); assert.equal(f.presenter.binding, null); assert.equal(f.offers.length, 0)
  assert(f.diagnostics.some(value => value.code === 'ERR_PROTOCOL_VERSION'))
  f.final(0); await flush(); assert.equal(f.api.owner, false, 'the refused HTTP attempt cannot be revived')
  f.setPreviewReceipt(body => ({ queued: true, requestId: body.requestId }))
  await f.advance(250); assert.equal(f.controls.length, 2); assert.equal(f.api.owner, false)
  f.final(1); await flush(); assert.equal(f.api.owner, true, 'only a new actual SSE final confirms the retry')
})

test('elapsed local lease blocks owner and input before suspended timer callbacks or stale state can run', async t => {
  const f = fixture(t); await f.establish(); f.presenter.inputEnabled = true
  const proof = f.api.connection.proof, binding = f.presenter.binding, controls = f.controls.length
  assert.equal(f.api.inputEnabled, true)
  f.jumpWithoutTimers(15000)
  assert.equal(f.api.owner, false); assert.equal(f.api.inputEnabled, false); assert.equal(f.api.retryPresentation(), false)
  assert.equal(f.controls.length, controls, 'the elapsed gate did not depend on a timeout task running')
  assert.equal(f.api.connection.proof, proof); assert.equal(f.presenter.binding, binding)
  await assert.rejects(f.api.events([{ type: 'tap', x: 1, y: 1 }]), { code: 'ERR_CANCELLED' }); assert.equal(f.eventCalls.length, 0)
  f.sources[0].emit('state', state()); await flush()
  assert.equal(f.api.owner, false); assert.equal(f.api.inputEnabled, false, 'unchanged expired:false state is not a new lease receipt')
  assert.equal(f.controls.at(-1).op, 'heartbeat')
  f.final(); await flush(); assert.equal(f.api.owner, true, 'a fresh actual final may renew the conservative local lease')
})

test('a final heartbeat delayed beyond its request-start lease cannot rearm a paused connection', async t => {
  const f = fixture(t); await f.connect(); f.jumpWithoutTimers(15000)
  f.final(0); await flush()
  assert.equal(f.api.owner, false); assert.equal(f.presenter.binding, null); assert.equal(f.offers.length, 0)
  f.final(0); await flush(); assert.equal(f.api.owner, false, 'replaying the delayed receipt cannot extend its deadline')
  await f.advance(250); assert.equal(f.controls.length, 2)
  f.final(1); await flush(); assert.equal(f.api.owner, true)
})

test('the manager bridge sender checks elapsed lease synchronously before a stale ACK or input fetch', async t => {
  const f = fixture(t); await f.establish(); f.presenter.inputEnabled = true
  const binding = f.presenter.binding, send = f.presenterOptions[0].send
  const envelope = { sessionId: binding.sessionId, preview: { clientId: binding.clientId, epoch: binding.epoch, connectionToken: binding.connectionToken } }
  f.jumpWithoutTimers(15000)
  assert.throws(() => send(envelope, { signal: new AbortController().signal }), { code: 'ERR_CANCELLED' })
  assert.equal(f.requests.filter(request => request.url === '/api/bridge').length, 0)
})

test('a mirror RAF queued before timer suspension cannot draw after its conservative proof expires', async t => {
  const f = fixture(t); f.setState(state({ ownerClientId: 'other' })); f.setFrameBody(() => frame({ previewId: 'other' })); await f.establish()
  assert.equal(f.rafs.size, 1); f.jumpWithoutTimers(15000); await f.raf()
  assert.equal(f.drawings.length, 0); assert.equal(f.api.inputEnabled, false)
})

test('a regressed or invalid local clock keeps the old lease rejected until a fresh actual final', async t => {
  const f = fixture(t); await f.establish(); f.presenter.inputEnabled = true
  f.setClock(100); assert.equal(f.api.inputEnabled, true)
  f.setClock(99); assert.equal(f.api.inputEnabled, false)
  f.setClock(101); assert.equal(f.api.inputEnabled, false, 'clock recovery alone cannot revive an old proof')
  f.sources[0].emit('state', {}); await flush(); f.final(); await flush(); assert.equal(f.api.owner, true)
  f.setClock(Number.NaN); assert.equal(f.api.owner, false)
  f.setClock(102); assert.equal(f.api.owner, false, 'a finite sample alone cannot replace the rejected final lease')
})

test('the real Raster presenter opens input only from a matching bridge final on the current actual EventSource', async t => {
  const f = fixture(t, { createPresenter: options => new DevRasterPresenterClient(options) })
  const first = await f.connect(); f.final(); await flush(); await f.raf()
  const old = JSON.parse(f.requests.find(request => request.url === '/api/bridge').init.body)
  const oldListener = [...first.listeners.get('bridge')][0]
  assert.equal(f.api.owner, true); assert.equal(f.api.inputEnabled, false, 'actual HTTP admission is not a presentation ACK')
  f.api.connect(); await flush(); f.init(f.sources[1], 'current-source-token'); await flush(); f.final(); await flush(); await f.raf()
  const current = JSON.parse(f.requests.filter(request => request.url === '/api/bridge').at(-1).init.body)
  const response = envelope => ({ messages: [{ ...envelope, kind: 'response', payload: { ok: true, presentationTicket: envelope.payload.presentationTicket, inputEnabled: true } }] })
  oldListener({ data: JSON.stringify(response(old)) }); await flush(); assert.equal(f.api.inputEnabled, false)
  f.sources[1].emit('bridge', response({ ...current, requestId: 'unrelated-ACK' })); await flush(); assert.equal(f.api.inputEnabled, false)
  f.sources[1].emit('bridge', response(current)); await flush(); assert.equal(f.api.inputEnabled, true)
  assert.equal(f.api.presenter.binding.connectionToken, 'current-source-token')
  f.sources[1].emit('error', {}); assert.equal(f.api.inputEnabled, false)
  f.sources[1].emit('bridge', response(current)); await flush(); assert.equal(f.api.inputEnabled, false)
})
