import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createDomResourceResolver, RemoteDomSurface } from '../examples/hosts/web-wasm/remote-dom.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const lease = (epoch = '1', ownerClientId = 'tab-one') => ({ version: '1.0', epoch, ownerClientId, leaseDurationMs: 15000 })
const authority = (epoch = '1', revision = '1', sessionId = 'session') => ({ sessionId, revision, surfaceGeneration: epoch, previewEpoch: epoch })
const node = { kind: 'element', occurrenceId: 'root', tag: 'view', attrs: {}, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' }, events: [], children: [] }
const submission = (revision = '1', epoch = '1', sessionId = 'session') => ({ version: '1.0', key: { sessionId, pageId: '1', documentRevision: revision, presentationRevision: revision, surfaceGeneration: epoch, profile: 'webview' }, viewport: { width: 375, height: 667 }, document: { version: '1.0', sessionId, pageId: 1, revision: Number(revision), routePath: 'pages/home', profile: 'webview', nodes: [node], styleRoots: [], styles: [], resources: [] } })
const state = (revision = '1', epoch = '1', owner = 'tab-one') => ({ webRenderer: 'webview', sessionId: 'session', preview: lease(epoch, owner), viewAuthority: authority(epoch), viewRequest: { version: '1.0', revision, render: { templateId: 'template:pages/home.wxml', useSessionResources: true, token: revision, viewport: { x: 0, y: 0, width: 375, height: 667 } } } })

function harness(t) {
  const bridge = [], controls = [], diagnostics = [], metrics = [], surfaces = [], timers = new Map(), held = new Map(), failures = new Map()
  let remote, epoch = 0, now = 0
  const respond = envelope => {
    let payload = { ok: true }
    if (envelope.op === 'view.prepare') payload.submission = submission(envelope.payload.render.token, envelope.payload.surfaceGeneration, envelope.sessionId)
    if (envelope.op === 'view.prepare.commit') payload.permit = { version: '1.0', key: envelope.payload.key, epoch: envelope.payload.epoch, permitId: 'runtime-permit' }
    if (envelope.op === 'view.presented') { payload.key = envelope.payload.key; payload.inputEnabled = true }
    if (envelope.op === 'view.query.enable') payload = { ok: true, version: '1.0', scope: 'presentation', enabled: true, key: envelope.payload.key }
    if (failures.has(envelope.op)) payload = { ok: false, error: failures.get(envelope.op) }
    remote.receiveBridge({ messages: [{ ...envelope, kind: 'response', payload }] })
  }
  const fetch = async (url, options) => {
    const value = JSON.parse(options.body)
    if (url === '/api/preview') {
      controls.push({ ...value, keepalive: options.keepalive })
      return { ok: true, status: 202, json: async () => ({ queued: true, requestId: value.requestId }) }
    }
    assert.equal(url, '/api/bridge'); bridge.push(value)
    if (held.has(value.op)) held.get(value.op).push(() => respond(value))
    else queueMicrotask(() => respond(value))
    return { ok: true, status: 202, json: async () => ({ queued: true }) }
  }
  const createPresenter = () => {
    const presenter = { current: null, pending: null, disposed: false, preparations: [], confirmations: [],
      async prepare(document, options) {
        const candidate = { state: 'prepared', document, releaseMode: options.releaseMode, key: options.presentationKey, preparation: { version: '1.0', key: options.presentationKey, epoch: String(++epoch), viewport: options.viewport, nodes: [] }, signal: options.signal }
        presenter.pending = candidate; presenter.preparations.push(candidate); return candidate
      },
      commit(candidate, permit) { assert.equal(candidate.signal.aborted, false); candidate.state = 'committed'; candidate.receipt = { ...candidate.preparation, phase: 'committed', commitId: 'local-commit', permitId: permit.permitId }; presenter.current = candidate; return candidate.receipt },
      holdAcknowledgement(receipt) { assert.equal(receipt, presenter.current.receipt); assert.equal(presenter.current.state, 'committed'); presenter.current.awaitingAcknowledgement = true },
      acknowledge(receipt) { assert.equal(receipt, presenter.current.receipt); assert.ok(['committed', 'confirmed'].includes(presenter.current.state)); presenter.current.state = 'confirmed'; presenter.pending = null; return receipt },
      confirm(receipt, options) { presenter.acknowledge(receipt); presenter.current.inputEnabled = options.inputEnabled; presenter.confirmations.push({ receipt, options }); return receipt },
      abort(candidate) { if (candidate.state !== 'confirmed') candidate.state = 'aborted'; presenter.pending = null },
      suspendInput() { if (presenter.current) presenter.current.inputEnabled = false },
      dispose() { presenter.disposed = true },
      candidateReleaseContract() { return { version: '1.0', exactHandle: true, pendingAcquisitions: true, asynchronousDisposal: true, asynchronousConfirmation: true, asynchronousShutdown: true } },
      async releaseCandidate(candidate) { const retained = candidate.state === 'confirmed'; if (!retained) presenter.abort(candidate); return { version: '1.0', handle: candidate, key: candidate.key, status: retained ? 'retained' : 'released', cleanupPending: false } },
      async drainCandidate() {},
      async confirmAsync(receipt, options) { presenter.confirm(receipt, options); return { version: '1.0', handle: presenter.current, key: presenter.current.key, receipt, inputEnabled: options.inputEnabled && options.inputGuard(), cleanupPending: false } },
      async disposeAsync() { presenter.dispose(); return { version: '1.0', presenter, status: 'disposed', cleanupPending: false } },
      async drainDisposal() {},
    }
    surfaces.push(presenter); return presenter
  }
  remote = new RemoteDomSurface({}, { fetch, clientId: 'tab-one', createPresenter, onDiagnostic: value => diagnostics.push(value), onMetrics: value => metrics.push(value), clock: () => ++now, setInterval: callback => { timers.set(1, callback); return 1 }, clearInterval: id => timers.delete(id) })
  t.after(() => remote.dispose())
  const connect = async (value = state()) => {
    remote.updateState(value)
    await remote.connect()
    const pending = controls.findLast(value => value.op === 'connect')
    remote.receivePreview({ ok: true, clientId: 'tab-one', requestId: pending.requestId, preview: value.preview })
    await tick(); await tick()
  }
  return { remote, bridge, controls, diagnostics, metrics, surfaces, timers, held, failures, connect, respond }
}

test('overlapping remote DOM inputs retain distinct protocol facts without a next-frame latency claim',async t=>{
  const h=harness(t);await h.connect()
  h.held.set('view.events',[])
  const presenter=h.surfaces[0],key=h.remote.client.accepted.key
  const send=type=>presenter.onEventBatch({version:'1.0',key,events:[{type,occurrenceId:'root',detail:{},timeStamp:123}]})
  const first=send('tap'),second=send('touchmove');await tick()
  const before=h.remote.inputTiming
  assert.equal(before.records.length,2);assert.equal(before.records.every(value=>value.outcome==='pending'),true)
  h.held.get('view.events')[0]();await tick()
  assert.equal(h.remote.inputTiming.records[0].outcome,'protocol-completed')
  assert.equal(h.remote.inputTiming.records[1].outcome,'pending')
  h.held.get('view.events')[1]()
  await Promise.all([first,second]);await tick()
  const report=h.remote.inputTiming
  assert.deepEqual(report.records.map(value=>value.sampleId),['1','2'])
  assert.equal(report.records.every(value=>value.outcome==='protocol-completed'),true)
  assert.equal(report.association,'unavailable');assert.equal(report.gate.status,'blocked');assert.equal(report.gate.inputToPresentP95Ms,null)
  assert.equal(Object.hasOwn(report,'candidates'),false)
  assert.ok(h.metrics.length>0)
  for(const value of h.metrics) {
    assert.equal(value.endpoint,'dom-protocol-completed');assert.equal(value.performanceGate,'blocked')
    assert.equal(value.compositorPresentedAt,null);assert.equal(Object.hasOwn(value,'presentedAt'),false)
    assert.equal(Object.hasOwn(value,'inputToPresentMs'),false);assert.equal(typeof value.transactionCompletedAt,'number')
  }
})

test('remote diagnostic failures preserve the exact input promise and mandatory disposal',async t=>{
  const h=harness(t);await h.connect()
  h.remote.inputLedger.capture=()=>{throw Error('diagnostic capture')}
  h.remote.inputLedger.complete=()=>{throw Error('diagnostic completion')}
  h.remote.inputLedger.retire=()=>{throw Error('diagnostic retirement')}
  const actual=h.surfaces[0].onEventBatch({version:'1.0',key:h.remote.client.accepted.key,events:[]})
  await actual;await tick()
  assert.equal(h.remote.inputTimingObserverFailures,2)
  await h.remote.dispose()
  assert.equal(h.remote.inputTimingObserverFailures,3);assert.equal(h.surfaces[0].disposed,true)
})

test('default browser timer functions retain their native receiver during construction and disposal', async () => {
  const original = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }, calls = []
  let remote
  try {
    globalThis.setInterval = function (callback, delay) { assert.equal(this, globalThis); calls.push(['start', delay]); return 7 }
    globalThis.clearInterval = function (id) { assert.equal(this, globalThis); calls.push(['stop', id]) }
    remote = new RemoteDomSurface({}, { createPresenter: () => ({ prepare() {}, commit() {}, confirm() {}, abort() {}, suspendInput() {}, dispose() {} }) })
  } finally { Object.assign(globalThis, original) }
  await remote.dispose()
  assert.deepEqual(calls, [['start', 5000], ['stop', 7]])
})

test('disposal releases local resources before a bounded fetch or JSON timeout and ignores late release', async t => {
  for (const stalled of ['fetch', 'json']) await t.test(stalled, async child => {
    // The release deadline must advance only after local cleanup is observed;
    // a busy parallel test runner can otherwise consume 40 ms before tick().
    child.mock.timers.enable({ apis: ['setTimeout'] })
    const gate = deferred(), diagnostics = [], states = [], signals = []
    let disposed = 0, stopped = 0, settled = false
    const remote = new RemoteDomSurface({}, {
      clientId: 'stalled-release', previewTimeoutMs: 40,
      fetch: async (_url, options) => {
        signals.push(options.signal)
        assert.equal(JSON.parse(options.body).op, 'release')
        assert.equal(options.keepalive, true)
        return stalled === 'fetch' ? gate.promise : { ok: true, json: () => gate.promise }
      },
      setInterval: () => 1, clearInterval: () => { stopped++ },
      createPresenter: () => ({ prepare() {}, commit() {}, confirm() {}, abort() {}, suspendInput() {}, dispose() { disposed++ } }),
      onDiagnostic: value => diagnostics.push(value), onState: value => states.push(value),
    })
    remote.updatePreview(lease('1', 'stalled-release'))
    const first = remote.dispose()
    assert.equal(remote.dispose(), first, 'repeat disposal must await the same local cleanup barrier')
    first.then(() => { settled = true })
    await tick()
    assert.equal(disposed, 1, 'local resources cannot wait for network release')
    assert.equal(stopped, 1)
    assert.equal(settled, false, 'the bounded release is still pending')
    child.mock.timers.tick(39); await tick()
    assert.equal(settled, false, 'release cannot time out before its exact deadline')
    child.mock.timers.tick(1)
    await first
    assert.equal(signals.length, 1); assert.equal(signals[0].aborted, true)
    assert.equal(diagnostics.filter(value => value.code === 'ERR_TIMEOUT').length, 1)
    assert.equal(remote.pendingPreview.size, 0)
    const before = states.length
    const receipt = { ok: true, requestId: 'late', clientId: 'stalled-release', preview: lease('999', 'replacement') }
    gate.resolve(stalled === 'fetch' ? { ok: true, json: async () => receipt } : receipt)
    await tick(); await tick()
    assert.equal(remote.preview.epoch, '1'); assert.equal(states.length, before)
    assert.equal(disposed, 1); assert.equal(remote.dispose(), first)
    await remote.previewRequest('release')
    assert.equal(signals.length, 1, 'a retired surface cannot start another release')
  })
})

test('disposal aborts outstanding preview connection without waiting for its fetch', async () => {
  const controls = [], diagnostics = []
  let disposed = false
  const remote = new RemoteDomSurface({}, {
    clientId: 'pending-connect', previewTimeoutMs: 1000,
    fetch: async (_url, options) => {
      const op = JSON.parse(options.body).op
      controls.push({ op, signal: options.signal })
      if (op === 'connect') return new Promise(() => {})
      return { ok: true, json: async () => ({ queued: true }) }
    },
    setInterval: () => 1, clearInterval() {},
    createPresenter: () => ({ prepare() {}, commit() {}, confirm() {}, abort() {}, suspendInput() {}, dispose() { disposed = true } }),
    onDiagnostic: value => diagnostics.push(value),
  })
  remote.updatePreview(lease('1', 'pending-connect'))
  const connecting = remote.connect()
  const rejected = assert.rejects(connecting, value => value.code === 'ERR_CANCELLED' && value.localCancellation)
  await remote.dispose(); await rejected
  assert.equal(disposed, true); assert.equal(controls.find(value => value.op === 'connect').signal.aborted, true)
  assert.equal(remote.pendingPreview.size, 0); assert.deepEqual(diagnostics, [])
})

test('disposal preserves local cleanup failures for every caller', async () => {
  const cleanup = new Error('fixture local cleanup failed')
  const remote = new RemoteDomSurface({}, {
    setInterval: () => 1, clearInterval() {},
    createPresenter: () => ({ prepare() {}, commit() {}, confirm() {}, abort() {}, suspendInput() {}, dispose() { throw cleanup } }),
  })
  const disposing = remote.dispose()
  assert.equal(remote.dispose(), disposing)
  await assert.rejects(disposing, value => value === cleanup)
  await assert.rejects(remote.dispose(), value => value === cleanup)
})

test('a failed input is not reevaluated by heartbeat or identical state, but a new revision can recover', async t => {
  const h = harness(t)
  await h.connect()
  h.failures.set('view.prepare', { code: 'ERR_RENDER', message: 'unsupported fixture style' })
  h.remote.updateState(state('2')); await tick(); await tick()
  const failedRequests = h.bridge.filter(value => value.op === 'view.prepare').length
  for (let index = 0; index < 5; index++) {
    h.timers.get(1)(); await tick()
    const heartbeat = h.controls.at(-1)
    h.remote.receivePreview({ ok: true, clientId: 'tab-one', requestId: heartbeat.requestId, preview: lease() })
    h.remote.updateState(state('2')); await tick()
  }
  assert.equal(h.bridge.filter(value => value.op === 'view.prepare').length, failedRequests)
  h.failures.delete('view.prepare')
  h.remote.updateState(state('3')); await tick(); await tick()
  assert.equal(h.bridge.filter(value => value.op === 'view.prepare').length, failedRequests + 1)
  assert.equal(h.remote.client.accepted.key.documentRevision, '3')
  assert.equal(h.remote.client.accepted.inputEnabled, true)
})

test('remote SSE and HTTP-final query events use the actual preview-fenced bridge and deduplicate measurement', async t => {
  const h = harness(t)
  await h.connect()
  assert.equal(h.remote.client.queryEnabled, true)
  const key = h.remote.client.accepted.key, presenter = h.surfaces[0]
  let samples = 0
  presenter.sampleQueryGeometry = (observedKey, afterEpoch, occurrenceIds) => {
    assert.deepEqual(observedKey, key); assert.deepEqual(occurrenceIds, ['root'])
    samples++
    return { geometry: { version: '1.0', key: observedKey, epoch: String(BigInt(afterEpoch) + BigInt(samples)),
      viewport: { width: 375, height: 667 }, nodes: [] }, viewportScroll: { x: 2, y: 64 } }
  }
  const query = sequence => ({ protocolVersion: '1.0', sessionId: key.sessionId, requestId: '', kind: 'event',
    op: 'view.query.request', payload: { version: '1.0', requestId: `dom-query:${sequence}`, key,
      afterEpoch: '10', deadlineNs: '18446744073709551615', occurrenceIds: ['root'] } })
  h.remote.receiveBridge({ messages: [query(1)] })
  await tick(); await h.remote.client.turn
  const first = h.bridge.find(value => value.op === 'view.query.result')
  assert.deepEqual(first.preview, { clientId: 'tab-one', epoch: '1' })
  assert.deepEqual(first.payload.viewportScroll, { x: 2, y: 64 })
  assert.equal(samples, 1)
  const fetch = h.remote.fetch
  h.remote.fetch = async (url, options) => {
    const envelope = JSON.parse(options.body)
    if (url === '/api/bridge' && envelope.op === 'api.call') return { ok: true, json: async () => ({ messages: [
      { ...envelope, kind: 'response', payload: { ok: true } }, query(2),
    ] }) }
    return fetch(url, options)
  }
  await h.remote.transport.request('api.call', { name: 'fixture' })
  await tick(); await h.remote.client.turn
  assert.equal(samples, 2)
  h.remote.receiveBridge({ messages: [query(1), query(2)] }); await tick()
  assert.equal(samples, 2)
  const results = h.bridge.filter(value => value.op === 'view.query.result')
  assert.equal(results.length, 2)
  assert.ok(results.every(value => value.preview.epoch === '1' && value.payload.key.presentationRevision === key.presentationRevision))
})

test('owner uses fenced queued HTTP and final SSE transactions, heartbeat, and explicit release', async t => {
  const h = harness(t)
  h.remote.updateState(state()); await h.remote.connect(); await tick()
  assert.equal(h.bridge.length, 0, 'old state cannot bypass the final connect result')
  const control = h.controls[0]
  h.remote.receivePreview({ ok: true, clientId: 'tab-one', requestId: control.requestId, preview: lease() }); await tick(); await tick()
  assert.deepEqual(h.bridge.map(value => value.op), ['view.prepare', 'view.prepare.commit', 'view.presented', 'view.query.enable'])
  assert.ok(h.bridge.every(value => value.preview.clientId === 'tab-one' && value.preview.epoch === '1'))
  assert.equal(h.bridge[0].preview.requestRevision, '1')
  assert.ok(h.bridge.slice(1).every(value => value.preview.requestRevision === undefined))
  assert.equal(h.remote.client.accepted.inputEnabled, true); assert.equal(h.surfaces[0].current.inputEnabled, true)
  assert.equal(h.surfaces[0].current.releaseMode, 'strict', 'owner publication must await the asynchronous resource barrier')
  assert.deepEqual(h.diagnostics, []); assert.equal(h.metrics.length, 1)
  h.timers.get(1)(); await tick(); assert.equal(h.controls.at(-1).op, 'heartbeat')
  await h.remote.dispose()
  assert.equal(h.controls.at(-1).op, 'release'); assert.equal(h.controls.at(-1).keepalive, true)
  assert.equal(h.surfaces[0].disposed, true); assert.equal(h.timers.size, 0)
})

test('claim waits for authority from the matching preview epoch and final runtime ACK', async t => {
  const h = harness(t), value = { ...state('1', '1', 'other-tab'), viewPresented: submission() }
  await h.connect(value)
  assert.equal(h.bridge.length, 0); assert.equal(h.surfaces[0].current.inputEnabled, false)
  await h.remote.claim(); const claim = h.controls.at(-1)
  h.remote.receivePreview({ ok: true, clientId: 'tab-one', requestId: claim.requestId, preview: lease('2') })
  await tick(); assert.equal(h.bridge.length, 0, 'claim cannot use the preceding authority')
  h.held.set('view.presented', [])
  h.remote.updateState(state('2', '2')); await tick()
  assert.equal(h.surfaces[0].current.state, 'committed'); assert.equal(h.surfaces[0].current.inputEnabled, undefined)
  h.held.get('view.presented').shift()(); await tick()
  assert.equal(h.remote.client.accepted.inputEnabled, true); assert.equal(h.surfaces[0].current.inputEnabled, true)
})

test('readonly accepted documents never issue view operations or acquire native input', async t => {
  const h = harness(t)
  await h.connect({ ...state('1', '1', 'other-tab'), viewPresented: submission() })
  assert.equal(h.bridge.length, 0); assert.equal(h.remote.isOwner, false)
  assert.equal(h.surfaces[0].confirmations.length, 1); assert.equal(h.surfaces[0].current.inputEnabled, false)
  assert.throws(() => h.remote.fence({}), /claim the active preview/)
  h.remote.updateState({ ...state('2', '1', 'other-tab'), viewPresented: submission('2') }); await tick()
  assert.equal(h.bridge.length, 0); assert.equal(h.surfaces[0].confirmations.length, 2)
})

test('latest render requests coalesce, ignore regressions and density-only updates do not evaluate View again', async t => {
  const h = harness(t)
  await h.connect()
  h.held.set('view.prepare', [])
  h.remote.updateState(state('2')); await tick()
  assert.equal(h.held.get('view.prepare').length, 1)
  for (let revision = 3; revision <= 100; revision++) h.remote.updateState(state(String(revision)))
  assert.equal(h.remote.pendingJob.render.token, '100')
  assert.equal(h.bridge.filter(value => value.op === 'view.prepare').length, 2)
  const late = h.held.get('view.prepare').shift(); h.held.delete('view.prepare'); late()
  await tick(); await tick(); await tick()
  assert.equal(h.bridge.filter(value => value.op === 'view.prepare').length, 3)
  assert.equal(h.bridge.filter(value => value.op === 'view.prepare').at(-1).payload.render.token, '100')
  assert.equal(h.bridge.filter(value => value.op === 'view.prepare').at(-1).preview.requestRevision, '100')
  const count = h.bridge.length
  h.remote.updateState({ ...state('100'), presentation: { renderScale: 4, effectiveScale: 4, fps: 60 } })
  h.remote.updateState(state('99')); await tick()
  assert.equal(h.bridge.length, count); assert.equal(h.remote.source.viewRequest.revision, '100')
  assert.deepEqual(h.diagnostics, [])
})

test('a delayed transport callback keeps its captured request revision and never borrows a new lease', async t => {
  const h = harness(t)
  await h.connect()
  const send = h.remote.transport.send, gate = deferred()
  let delayed
  h.remote.transport.send = async (envelope, options) => {
    if (envelope.op === 'view.prepare' && envelope.payload.render.token === '2') {
      delayed = { envelope, options }
      await gate.promise
    }
    return send(envelope, options)
  }
  h.remote.updateState(state('2')); await tick()
  assert.equal(delayed.options.hostContext.requestRevision, '2')
  h.remote.updateState(state('3'))
  gate.resolve(); await tick(); await tick(); await tick()
  const requests = h.bridge.filter(value => value.op === 'view.prepare')
  assert.equal(requests.find(value => value.payload.render.token === '2').preview.requestRevision, '2')
  assert.equal(requests.find(value => value.payload.render.token === '3').preview.requestRevision, '3')
  assert.throws(() => h.remote.fence(delayed.envelope, { ...delayed.options.hostContext, previewEpoch: '0' }), /retired lease/)
  const manual = h.remote.fence({ messages: [{ op: 'view.prepare' }] })
  assert.equal(manual.preview.requestRevision, '3')
  assert.deepEqual(h.remote.fence({ logicalWidth: 420 }).preview, { clientId: 'tab-one', epoch: '1' })
})

test('lease loss freezes input; reconnect waits for a new epoch and fresh presentation', async t => {
  const h = harness(t)
  await h.connect()
  const count = h.bridge.length
  h.remote.disconnect(); assert.equal(h.surfaces[0].current.inputEnabled, false)
  await h.remote.connect(); await tick(); assert.equal(h.bridge.length, count)
  const control = h.controls.findLast(value => value.op === 'connect')
  h.remote.receivePreview({ ok: true, clientId: 'tab-one', requestId: control.requestId, preview: lease('2') }); await tick()
  assert.equal(h.bridge.length, count)
  h.remote.updateState(state('2', '2')); await tick(); await tick()
  assert.equal(h.bridge.filter(value => value.op === 'view.prepare').length, 2)
  assert.equal(h.remote.client.accepted.key.surfaceGeneration, '2')
  h.remote.updateState({ ...state('2', '3', 'other-tab'), viewPresented: submission('2', '3') }); await tick()
  assert.equal(h.remote.isOwner, false); assert.equal(h.surfaces[0].current.inputEnabled, false)
  assert.deepEqual(h.diagnostics, [])
})

test('encoded resource leases verify complete identity, hash, MIME and bytes and release once', async () => {
  const bytes = new Uint8Array([1, 2, 3]), sha256 = createHash('sha256').update(bytes).digest('hex'), calls = [], released = []
  let mime = 'image/png', contents = bytes
  const resolver = createDomResourceResolver({ fetch: async url => { calls.push(url); return { ok: true, headers: new Headers({ 'content-type': mime }), arrayBuffer: async () => contents.buffer } }, createObjectURL: () => 'blob:owned', revokeObjectURL: url => released.push(url) })
  const context = { presentationKey: submission().key }, descriptor = { sha256, size: 3, mime: 'image/png' }
  const resource = await resolver(descriptor, context)
  assert.deepEqual(JSON.parse(new URL(calls[0], 'http://localhost').searchParams.get('key')), context.presentationKey)
  resource.release(); resource.release(); assert.deepEqual(released, ['blob:owned'])
  mime = 'image/jpeg'; await assert.rejects(resolver(descriptor, context), /MIME mismatch/)
  mime = 'image/png'; contents = new Uint8Array([3, 2, 1]); await assert.rejects(resolver(descriptor, context), /SHA-256 mismatch/)
  contents = new Uint8Array([1, 2]); await assert.rejects(resolver(descriptor, context), /size mismatch/)
  assert.equal(released.length, 1)
})
