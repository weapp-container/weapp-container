import { stageAnimationStyles, computedAnimationBaseline } from '../examples/hosts/web-wasm/dom-animation-sample.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, webcrypto } from 'node:crypto'
import { WorkerDomAdapter } from '../examples/hosts/web-wasm/worker-dom-adapter.mjs'
import { DomViewPresenter } from '../examples/hosts/web-wasm/dom-presenter.mjs'
import { WorkerRpcClient } from '../examples/hosts/web-wasm/worker-session-client.mjs'
import { WorkerBridgeTransport } from '../examples/hosts/web-wasm/worker-bridge-transport.mjs'

// Contract drafts only. The fake Worker supplies explicit native responses;
// the adapter under test uses the real RPC, bridge, client and strict presenter.
// These are not WASM, browser, native-host or GPU acceptance evidence.
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
const copy = value => structuredClone(value)
const accepted = candidate => ({ proof: copy(candidate.proof), inputEnabled: false })
const innerReply = (request, payload) => ({ ...request, kind: 'response', payload })
const OWNER = Object.freeze({ workerEpoch: 'epoch-dom', sessionId: 'session-dom', packSha256: 'a'.repeat(64), transportBackend: 'browser-view' })
const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])
const digest = createHash('sha256').update(bytes).digest('hex')
const manifest = { app: { appJson: 'app.json' }, routes: [{ path: 'pages/home', config: 'pages/home.json' }],
  styles: [{ id: 'style:app.wxss', scope: 'app' }, { id: 'style:pages/home.wxss', scope: 'page' }], components: [] }
const initial = () => ({ owner: OWNER, sessionId: OWNER.sessionId, transportBackend: OWNER.transportBackend,
  currentPage: { pageId: '1', path: 'pages/home' }, templateRevision: '1', renderRevision: '0', viewRevision: '0',
  surfaceGeneration: '1', inputLifetimeRevision: '0', viewport: { x: 0, y: 0, width: 375, height: 667 },
  rendererProfile: 'webview', declaredRendererProfile: 'webview', lifecycle: 'Active', requiresRestart: false })

async function harness(t, options = {}) {
  const listeners = new Map(), requests = [], calls = [], nodes = [], observations = [], batches = [], diagnostics = [], revocations = [], created = []
  const hooks = new Map(), timers = new Set()
  let adapter, sharedBridge, rpc, sequence = 1n, eventSequence = 0, frameRevision = 0, attempt = 0
  let state = { ...initial(), ...(options.animation ? { sampleDemandRevision: '0' } : {}) }, currentObservation = { version: '1.0', sequence: '1', state: copy(state) }
  const observe = patch => {
    state = { ...state, ...patch }
    currentObservation = { version: '1.0', sequence: String(++sequence), state: copy(state) }
    return copy(currentObservation)
  }
  const loadResult = () => ({ renderer: 'browser-view', transportBackend: 'browser-view', capabilities: { quickjs: true },
    pack: { indexSha256: OWNER.packSha256 }, manifest, observation: copy(currentObservation),
    observationContract: { version: '1.0', sequence: 'u64', surfaceGeneration: '1.0', inputLifetime: '1.0' } })
  const documentFor = revision => ({ version: '1.0', sessionId: OWNER.sessionId, pageId: Number(state.currentPage.pageId), revision,
    routePath: state.currentPage.path, profile: 'webview', nodes: [{ kind: 'element', occurrenceId: 'root', tag: 'view', attrs: {}, typedAttrs: {},
      ownership: { documentId: `${state.currentPage.path}.wxml` }, events: [{ event: 'tap', handler: 'tap', phase: 'bubble', catch: false }],
      children: options.image ? [{ kind: 'element', occurrenceId: 'image', tag: 'image', attrs: { src: options.bufferURL ? '/__container_buffer_urls/'+'a'.repeat(48) : '../assets/pixel.png' }, typedAttrs: {},
        ownership: { documentId: `${state.currentPage.path}.wxml` }, events: [], children: [] }] : [] }], styleRoots: [], styles: [],
    resources: options.image ? [{ path: options.bufferURL ? '__container_buffer_urls/'+'a'.repeat(48) : 'assets/pixel.png', sha256: digest, mime: 'image/png', size: bytes.byteLength }] : [] })
  const native = (op, payload) => {
    if (op === 'load') return loadResult()
    if (op === 'state') return { state: copy(state) }
    if (op === 'resource') return { key: copy(payload.key), sha256: payload.sha256, ...(payload.path ? { path: payload.path } : {}), bytes: bytes.slice().buffer }
    if (op === 'view.retire') return { messages: [] }
    if (op === 'view.sample.abort') return { messages: [{ protocolVersion: '1.0', sessionId: OWNER.sessionId, requestId: `native-sample-abort-${calls.length}`,
      kind: 'response', op, payload: { ok: true, version: '1.0', key: payload.key, aborted: true } }] }
    if (op === 'view.abort') return { messages: [{ protocolVersion: '1.0', sessionId: OWNER.sessionId, requestId: `native-abort-${calls.length}`,
      kind: 'response', op: 'view.abort', payload: { ok: true } }] }
    if (op === 'close') return { closed: true }
    if (op === 'events.ack') return { acknowledged: copy(payload.eventIds), pendingCount: 0, pendingBytes: 0 }
    assert.equal(op, 'bridge')
    const envelope = payload.envelope
    calls.push(copy(envelope))
    let result
    if (envelope.op === 'view.prepare') {
      const revision = ++frameRevision
      const key = { sessionId: OWNER.sessionId, pageId: state.currentPage.pageId, documentRevision: String(revision),
        presentationRevision: String(revision), surfaceGeneration: envelope.payload.surfaceGeneration, profile: 'webview' }
      result = { ok: true, submission: { version: '1.0', key, viewport: { width: state.viewport.width, height: state.viewport.height }, document: documentFor(revision),
          ...(options.animation ? { animation: { version: '1.0', requestId: `animation-${revision}`, baselines: [{ occurrenceId: 'root', opacity: true, transform: false }], styles: [] } } : {}) },
        scheduling: { version: '1.0', key: copy(key), consumedInput: { pageId: state.currentPage.pageId, routePath: state.currentPage.path,
          templateRevision: state.templateRevision, viewport: copy(state.viewport) },
          ...(options.animation ? { consumedSample: { demandRevision: state.sampleDemandRevision, sampleRevision: String(revision) } } : {}) } }
    } else if (envelope.op === 'view.animation.baseline') result = { ok: true, version: '1.0', requestId: envelope.payload.requestId, key: envelope.payload.key,
      styles: envelope.payload.values.map(value => ({ occurrenceId: value.occurrenceId, opacity: value.opacity, transform: null, origin: null })) }
    else if (envelope.op === 'view.sample.prepare') {
      const request = envelope.payload, key = { ...request.baseKey, presentationRevision: String(++frameRevision) }
      const consumedSample = { demandRevision: request.sampleDemandRevision, sampleRevision: String(frameRevision) }
      result = { ok: true, submission: { version: '1.0', key, baseKey: request.baseKey, baseGeometryEpoch: request.baseGeometryEpoch, consumedSample, viewport: { width: 375, height: 667 },
        styles: [{ occurrenceId: 'root', opacity: .4, transform: null, origin: null }] }, scheduling: { version: '1.0', key, consumedSample,
          consumedInput: { pageId: state.currentPage.pageId, routePath: state.currentPage.path, templateRevision: state.templateRevision, viewport: copy(state.viewport) } },
        permit: { version: '1.0', key, baseKey: request.baseKey, baseGeometryEpoch: request.baseGeometryEpoch, consumedSample, permitId: `native-sample-${frameRevision}` } }
    } else if (envelope.op === 'view.sample.presented') result = { ok: true, version: '1.0', key: envelope.payload.permit.key, consumedSample: envelope.payload.permit.consumedSample, inputEnabled: options.inputEnabled ?? true }
    else if (envelope.op === 'view.prepare.commit') result = { ok: true, permit: { version: '1.0', key: envelope.payload.key,
      epoch: envelope.payload.epoch, permitId: `native-permit-${frameRevision}` } }
    else if (envelope.op === 'view.presented') result = { ok: true, key: envelope.payload.key, inputEnabled: options.inputEnabled ?? true }
    else result = { ok: true }
    const hook = hooks.get(envelope.op)
    return hook ? hook({ envelope, result, native }) : { messages: [innerReply(envelope, result)] }
  }
  const worker = {
    terminated: 0,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback) },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
    postMessage(message) {
      requests.push(copy(message))
      if (message.kind !== 'request') return
      queueMicrotask(async () => {
        try {
          const hook = hooks.get(`outer:${message.op}`)
          const result = await (hook ? hook({ message, native }) : native(message.op, message.payload))
          respond(message, { status: 'ok', result: { ...result, observation: result.observation ?? copy(currentObservation) } })
        } catch (failure) { respond(message, { status: 'error', error: { code: failure.code ?? 'ERR_ENGINE', message: failure.message ?? String(failure),
          ...(failure.details === undefined ? {} : { details: copy(failure.details) }), observation: copy(currentObservation) } }) }
      })
    },
    terminate() { this.terminated++ },
  }
  const emit = data => { for (const listener of [...(listeners.get('message') ?? [])]) listener({ data: copy(data) }) }
  const respond = (message, payload) => emit({ ...message, kind: 'response', payload })
  rpc = new WorkerRpcClient({ workerFactory: () => worker, workerEpoch: OWNER.workerEpoch, sessionId: OWNER.sessionId,
    requestPrefix: 'dom-request', timeoutMs: 500, closeTimeoutMs: 500,
    onEvent(message) {
      if (options.borrowBridge) {
        if (message.payload?.observation) adapter?.receiveObservation(message.payload.observation)
        if (message.op === 'batch') sharedBridge.receiveBatch(message.payload)
      } else adapter?.receiveEvent(message)
    },
    setTimer(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); callback() }, delay); timers.add(timer); return timer },
    clearTimer(timer) { clearTimeout(timer); timers.delete(timer) },
  })
  const loaded = await rpc.requestHost('load', { observation: { version: '1.0' } })
  const observedRpc = options.borrowBridge ? { workerEpoch: rpc.workerEpoch, sessionId: rpc.sessionId,
    async requestHost(op, payload, requestOptions) {
      const result = await rpc.requestHost(op, payload, requestOptions)
      if (result.observation) adapter?.receiveObservation(result.observation)
      return result
    } } : rpc
  if (options.borrowBridge) sharedBridge = new WorkerBridgeTransport({ rpc: observedRpc, timeoutMs: 500 })
  const presenter = new DomViewPresenter({ ownerDocument: {}, append() {} }, { timeoutMs: 500 })
  presenter.createCandidate = async () => {
    const document = {}, properties = new Map()
    const root = { nodeType: 1, ownerDocument: document, isConnected: true, style: { getPropertyValue: name => properties.get(name)?.[0] ?? '',
      getPropertyPriority: name => properties.get(name)?.[1] ?? '', setProperty: (name, value, priority) => properties.set(name, [value, priority]), removeProperty: name => properties.delete(name) } }
    const candidate = { root, connected: true, interactive: false, activation: [], disposed: 0,
      supports: () => true, validateSelector() {},
      animationBaselines(descriptors) { return descriptors.map(d => computedAnimationBaseline(d, { opacity: '.8', transform: 'none', transformOrigin: '50px 25px', fontSize: '16px' })) },
      stageAnimation(styles, isCurrent) { return stageAnimationStyles(styles, { document, elementFor: id => id === 'root' ? root : undefined, isCurrent }) },
      async populate(plan) { candidate.plan = plan; if (options.populate) await options.populate(candidate) },
      snapshot() { return new Map() }, restore() {}, isConnected() { return candidate.connected && !candidate.disposed },
      setVisible(value) { candidate.visible = value }, setInteractive(value) { candidate.interactive = value; candidate.activation.push(value) },
      measure() { return [...candidate.plan.tables.nodes.keys()].map(occurrenceId => ({ occurrenceId, x: 0, y: 0, width: 100, height: 50, scrollTop: 0, scrollHeight: 50, clientHeight: 50 })) },
      measureViewportScroll() { return { x: 0, y: 17 } },
      activate(send) { candidate.send = send },
      dispose() { candidate.disposed++; candidate.interactive = false; return options.disposeCandidate ? options.disposeCandidate(candidate) : candidate.plan?.dispose() ?? [] },
    }
    nodes.push(candidate); return candidate
  }
  adapter = new WorkerDomAdapter({ rpc: observedRpc, bridge: sharedBridge, loadResult: loaded, presenter, crypto: webcrypto,
    timeoutMs: 500, maxResourceBytes: options.maxResourceBytes ?? 64 * 1024 * 1024,
    maxResourceCount: options.maxResourceCount ?? 1024,
    onObservation(value) { observations.push(value); return options.onObservation?.(value) }, onBatch(value) { batches.push(value); return options.onBatch?.(value) },
    onDiagnostic(value) { diagnostics.push(value); options.onDiagnostic?.(value) },
    createObjectURL(blob) { created.push(blob); options.onCreateURL?.(); return `blob:owned-${created.length}` },
    revokeObjectURL(url) { revocations.push(url); return options.revoke?.(url) },
  })
  const context = () => ({ owner: OWNER, attemptId: String(++attempt), surfaceGeneration: adapter.observation.state.surfaceGeneration,
    signal: new AbortController().signal, isCurrent: () => true })
  const prepare = async () => { const ctx = context(); return { candidate: await adapter.prepareTemplate(adapter.observation.state, ctx), context: ctx } }
  const present = entry => adapter.present(entry.candidate, { ...entry.context, proof: copy(entry.candidate.proof), timestamp: 16 })
  const release = (entry, patch = {}) => adapter.release(entry.candidate, { owner: OWNER, attemptId: entry.context.attemptId,
    proof: copy(entry.candidate.proof), committed: false, retired: false, ...patch })
  const event = (op, payload) => emit({ version: '1.0', workerEpoch: OWNER.workerEpoch, sessionId: OWNER.sessionId,
    requestId: `worker-event-${++eventSequence}`, kind: 'event', op, payload })
  t.after(async () => {
    const closing = await outcome(adapter.close())
    if (!options.expectCloseFailure) assert.equal(closing.error, undefined)
    sharedBridge?.dispose()
    await rpc.close()
    assert.equal(worker.terminated, 1)
    assert.equal(timers.size, 0, 'owned RPC timers leaked')
    assert.equal([...listeners.values()].reduce((count, values) => count + values.size, 0), 0)
  })
  return { adapter, rpc, observedRpc, sharedBridge, presenter, worker, hooks, calls, requests, nodes, observations, batches, diagnostics, revocations, created,
    loaded, observe, event, context, prepare, present, release, native, respond, get currentObservation() { return copy(currentObservation) } }
}

test('standalone Worker batch events and actual bridge finals share one selector-query ingress', async t => {
  const h = await harness(t), prepared = await h.prepare()
  await h.present(prepared); await h.release(prepared, { committed: true }); await tick(); await h.adapter.client.turn
  const key = h.adapter.client.accepted.key, candidate = h.nodes[0], measure = candidate.measure.bind(candidate)
  let samples = 0
  candidate.measure = () => { samples++; return measure() }
  const query = sequence => ({ protocolVersion: '1.0', sessionId: OWNER.sessionId, requestId: '', kind: 'event',
    op: 'view.query.request', payload: { version: '1.0', requestId: `dom-query:${sequence}`, key: copy(key),
      afterEpoch: '0', deadlineNs: '18446744073709551615', occurrenceIds: ['root'] } })
  h.event('batch', { messages: [query(1)] })
  await tick(); await h.adapter.client.turn
  assert.equal(samples, 1)
  const first = h.calls.find(value => value.op === 'view.query.result')
  assert.equal(first.payload.requestId, 'dom-query:1')
  assert.deepEqual(first.payload.viewportScroll, { x: 0, y: 17 })
  h.hooks.set('api.call', ({ envelope, result }) => ({ messages: [innerReply(envelope, result), query(2)] }))
  await h.adapter.transport.request('api.call', { name: 'fixture' })
  await tick(); await h.adapter.client.turn
  assert.equal(samples, 2)
  assert.equal(h.calls.filter(value => value.op === 'view.query.result').length, 2)
  h.event('batch', { messages: [query(1), query(2)] }); await tick(); await h.adapter.client.turn
  assert.equal(samples, 2)
})

test('Worker DOM construction requires an explicit versioned durable synchronous input capability', async t => {
  for (const fault of ['missing method', 'empty result', 'wrong version', 'asynchronous', 'not durable', 'unknown field', 'promise result']) await t.test(fault, async child => {
    const h = await harness(child)
    const presenter = new DomViewPresenter({ ownerDocument: {}, append() {} }, { timeoutMs: 500 })
    const capability = presenter.inputGuardContract()
    if (fault === 'missing method') presenter.inputGuardContract = undefined
    else presenter.inputGuardContract = () => fault === 'empty result' ? null
      : fault === 'promise result' ? Promise.resolve(capability)
        : { ...capability, ...(fault === 'wrong version' ? { version: '2.0' }
          : fault === 'asynchronous' ? { synchronous: false }
            : fault === 'not durable' ? { durable: false } : { extra: true }) }
    const requests = h.requests.length, calls = h.calls.length
    assert.throws(() => new WorkerDomAdapter({ rpc: h.rpc, loadResult: h.loaded, presenter, crypto: webcrypto }), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(h.requests.length, requests, 'negotiation failure must not issue native work')
    assert.equal(h.calls.length, calls)
    assert.equal(h.nodes.length, 0)
    assert.equal(presenter.current, null)
    assert.equal(presenter.onGeometry, undefined, 'failed construction must not wire client callbacks')
  })
})

test('exact generated prepare proof precedes the genuine permit/swap/final ACK', async t => {
  const h = await harness(t)
  assert.deepEqual(h.presenter.inputGuardContract(), { version: '1.0', synchronous: true, durable: true })
  assert.equal(Object.isFrozen(h.presenter.inputGuardContract()), true)
  const entry = await h.prepare()
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].op, 'view.prepare')
  assert.equal(h.calls[0].payload.render.useSessionResources, true)
  assert.equal(h.calls[0].payload.render.templateId, 'template:pages/home.wxml')
  assert.deepEqual(h.calls[0].payload.render.styleIds, ['style:app.wxss', 'style:pages/home.wxss'])
  assert.equal(entry.candidate.proof.consumedInput.templateRevision, '1')
  assert.equal(h.presenter.current, null)
  assert.equal(h.nodes[0].interactive, false)
  const shown = await h.present(entry)
  assert.equal(shown.acknowledged, true)
  assert.equal(shown.inputEnabled, true)
  assert.deepEqual(h.calls.map(call => call.op), ['view.prepare', 'view.prepare.commit', 'view.presented'])
  assert.equal(h.nodes[0].interactive, true)
  assert.deepEqual(await h.release(entry), { released: true, acknowledged: true, resourceBarrier: 'strict' })
  assert.equal(h.nodes[0].disposed, 0, 'ACKed pixels remain presenter-owned after scheduler release')
})

test('soft observations preserve one flight and original sequences are never renumbered', async t => {
  const h = await harness(t), entered = deferred(), gate = deferred()
  h.hooks.set('view.prepare', async ({ envelope, result }) => { entered.resolve(); await gate.promise; return { messages: [innerReply(envelope, result)] } })
  const ctx = h.context(), preparing = h.adapter.prepareTemplate(h.adapter.observation.state, ctx)
  await entered.promise
  const active = h.adapter.active, authority = h.adapter.client.authority
  const newer = h.observe({ templateRevision: '2', renderRevision: '3' })
  assert.equal(h.adapter.receiveObservation(newer), true)
  assert.equal(h.adapter.receiveObservation(h.loaded.observation), false)
  assert.equal(h.adapter.receiveObservation(newer), false)
  assert.equal(h.adapter.active, active)
  assert.equal(active.controller.signal.aborted, false)
  assert.equal(h.adapter.client.authority, authority)
  gate.resolve()
  const candidate = await preparing
  assert.equal(candidate.proof.consumedInput.templateRevision, '1', 'later observation cannot replace prepare-time consumption')
  assert.equal(h.adapter.observation.sequence, newer.sequence)
  assert.equal(h.observations.length, 1)
  await h.release({ candidate, context: ctx })
})

// Receiver protocol hardening: captureObservation currently advances the
// surface generation with the native lifetime. These synthetic observations
// isolate the lifetime fence; they do not reproduce a native hide/show defect.
test('same-generation native input lifetime advancement cancels an entered prepare', async t => {
  const h = await harness(t), entered = deferred(), gate = deferred()
  h.hooks.set('view.prepare', async ({ envelope, result }) => { entered.resolve(); await gate.promise; return { messages: [innerReply(envelope, result)] } })
  const preparing = outcome(h.prepare())
  await entered.promise
  const active = h.adapter.active, authority = h.adapter.client.authority, previous = h.adapter.observation
  const next = h.observe({ inputLifetimeRevision: '1' })
  assert.deepEqual({ ...next.state, inputLifetimeRevision: previous.state.inputLifetimeRevision }, previous.state,
    'the receiver must fence the native lifetime even when all other observation fields match')
  assert.equal(h.adapter.receiveObservation(next), true)
  assert.equal(active.controller.signal.aborted, true)
  assert.notEqual(h.adapter.client.authority, authority)
  assert.equal(h.adapter.client.authority.surfaceGeneration, authority.surfaceGeneration)
  const stopped = await preparing
  assert.equal(stopped.error?.code, 'ERR_CANCELLED')
  assert.equal(h.adapter.active, null)
  gate.resolve()
  await tick(); await h.adapter.client.turn
  assert.equal(h.calls.some(call => ['view.prepare.commit', 'view.presented'].includes(call.op)), false)
  assert.equal(h.presenter.current, null)
  assert.equal(h.nodes.length, 0)
  assert.equal(h.requests.some(request => request.op === 'view.abort'), true)
  assert.equal(h.adapter.faulted, false)
})

test('native input lifetime retires the accepted durable guard after scheduler release', async t => {
  const h = await harness(t), entry = await h.prepare()
  await h.present(entry); await h.release(entry)
  await tick(); await h.adapter.client.turn
  const accepted = h.presenter.currentEntry, guard = accepted.inputGuard
  assert.equal(guard(), true)
  assert.equal(h.adapter.active, null)
  h.adapter.receiveObservation(h.observe({ inputLifetimeRevision: '1' }))
  assert.equal(guard(), false)
  assert.equal(h.nodes[0].interactive, false)
  assert.equal(h.adapter.client.accepted.inputEnabled, false)
  assert.equal(h.adapter.acceptsOwnerInput(entry.candidate.proof.publication.key, '0'), false)
  const eventsBefore = h.calls.filter(call => call.op === 'view.events').length
  // A stale local activation cannot outlive the synchronous authority guard.
  h.presenter.surface(accepted, true, true)
  h.nodes[0].send('root', 'tap', {}, { timeStamp: 23 })
  await tick(); await h.adapter.client.turn
  assert.equal(h.presenter.interactive(accepted), false)
  assert.equal(h.calls.filter(call => call.op === 'view.events').length, eventsBefore)
  h.presenter.suspendInput()
})

test('native input lifetime advancement during strict confirmation cannot reopen the genuine ACK', async t => {
  const disposalEntered = deferred(), disposal = deferred()
  let h
  h = await harness(t, { disposeCandidate(candidate) {
    if (candidate === h.nodes[0]) { disposalEntered.resolve(); return disposal.promise }
    return candidate.plan?.dispose() ?? []
  } })
  const first = await h.prepare(); await h.present(first); await h.release(first)
  const second = await h.prepare(), presenting = outcome(h.present(second))
  await disposalEntered.promise
  const accepted = h.presenter.currentEntry
  assert.equal(accepted.state, 'confirmed')
  assert.equal(h.adapter.client.active.acknowledged, true)
  h.adapter.receiveObservation(h.observe({ inputLifetimeRevision: '1' }))
  assert.equal(accepted.inputGuard(), false)
  assert.equal(h.nodes[1].interactive, false)
  disposal.resolve([])
  const final = await presenting
  assert.equal(final.error, undefined)
  assert.equal(final.value.acknowledged, true)
  assert.equal(final.value.inputEnabled, false)
  assert.equal(h.nodes[1].activation.includes(true), false)
  assert.equal(h.adapter.client.accepted.inputEnabled, false)
  assert.equal((await h.release(second)).acknowledged, true)
})

test('newer observations cannot regress the native input lifetime before publication or notification', async t => {
  for (const terminal of [false, true]) await t.test(terminal ? 'exhausted lifetime cannot recover' : 'numeric lifetime regression', async t => {
    const h = await harness(t)
    h.adapter.receiveObservation(h.observe({ inputLifetimeRevision: terminal ? null : '9007199254740993', requiresRestart: terminal }))
    const previous = h.adapter.observation, notifications = h.observations.length
    const regressed = h.observe({ inputLifetimeRevision: terminal ? '18446744073709551615' : '9007199254740992', requiresRestart: false })
    assert.throws(() => h.adapter.receiveObservation(regressed), failure => failure.code === 'ERR_PROTOCOL_VERSION' && /input lifetime regressed/.test(failure.message))
    assert.equal(h.adapter.observation, previous)
    assert.equal(h.observations.length, notifications)
    assert.equal(h.adapter.faulted, true)
    assert.equal(h.rpc.state, 'open')
    // Cleanup receives the last genuine accepted observation, never the rejected one.
    h.observe({ inputLifetimeRevision: previous.state.inputLifetimeRevision, requiresRestart: terminal })
  })
})

test('missing or null generated consumedInput is rejected and exact native candidate is aborted', async t => {
  for (const variant of ['missing', 'null', 'wrong-page', 'older']) await t.test(variant, async t => {
    const h = await harness(t)
    h.adapter.receiveObservation(h.observe({ templateRevision: '5' }))
    h.hooks.set('view.prepare', ({ envelope, result }) => {
      if (variant === 'missing') delete result.scheduling
      if (variant === 'null') result.scheduling.consumedInput = null
      if (variant === 'wrong-page') result.scheduling.consumedInput.pageId = '9'
      if (variant === 'older') result.scheduling.consumedInput.templateRevision = '4'
      return { messages: [innerReply(envelope, result)] }
    })
    await assert.rejects(h.prepare(), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(h.calls.some(call => call.op === 'view.presented'), false)
    assert.equal(h.requests.some(request => request.op === 'view.abort'), true)
    assert.equal(h.presenter.current, null)
  })
})

test('queued outer/inner receipts and forged event finals cannot grant input', async t => {
  const h = await harness(t), entered = deferred(), final = deferred()
  const entry = await h.prepare()
  h.hooks.set('view.presented', async ({ envelope, result }) => { entered.resolve({ envelope, result }); return final.promise })
  let settled = false
  const presenting = outcome(h.present(entry)).then(value => { settled = true; return value })
  const pending = await entered.promise
  const outer = h.requests.at(-1)
  h.respond(outer, { status: 'queued' })
  h.event('batch', { messages: [innerReply({ ...pending.envelope, requestId: 'foreign' }, pending.result)] })
  h.event('batch', { messages: [{ ...innerReply(pending.envelope, pending.result), kind: 'event' }] })
  await tick()
  assert.equal(settled, false)
  assert.equal(h.nodes[0].interactive, false)
  final.resolve({ messages: [innerReply(pending.envelope, pending.result)] })
  assert.equal((await presenting).value.inputEnabled, true)
  await h.release(entry)
})

test('real ACK with input disabled remains disabled through strict confirmation', async t => {
  const h = await harness(t, { inputEnabled: false }), entry = await h.prepare()
  assert.equal((await h.present(entry)).inputEnabled, false)
  assert.equal(h.nodes[0].activation.includes(true), false)
  assert.equal((await h.release(entry)).acknowledged, true)
})

test('new hard lifetime invalidates a prepared candidate without reviving old input', async t => {
  const h = await harness(t), entry = await h.prepare()
  h.adapter.receiveObservation(h.observe({ surfaceGeneration: '2', viewport: { x: 0, y: 0, width: 667, height: 375 } }))
  await assert.rejects(h.present(entry), failure => failure.code === 'ERR_CANCELLED')
  await h.release(entry)
  assert.equal(h.nodes[0].activation.includes(true), false)
  assert.equal(h.requests.some(request => request.op === 'view.abort'), true)
})

test('exact opaque candidate ownership and stable release survive malformed release context', async t => {
  const h = await harness(t), entry = await h.prepare()
  await assert.rejects(h.adapter.present(copy(entry.candidate), { ...entry.context, proof: entry.candidate.proof }), failure => failure.code === 'ERR_PROTOCOL_VERSION')
  const first = h.release(entry, { owner: { ...OWNER, workerEpoch: 'foreign' } })
  const rejected = outcome(first)
  assert.equal(h.release(entry), first)
  assert.equal((await rejected).error.code, 'ERR_RENDER')
  assert.equal(h.nodes[0].disposed, 1, 'bad caller context cannot skip cleanup of known owned candidate')
})

test('retained-paint absence is explicit and never reexecutes View or issues RPC', async t => {
  const h = await harness(t), before = h.requests.length
  await assert.rejects(h.adapter.preparePaint(), failure => failure.code === 'ERR_UNSUPPORTED_CAPABILITY')
  assert.equal(h.requests.length, before)
  assert.equal(h.nodes.length, 0)
})

test('resource RPC verifies exact publication/hash/bytes and retains URL until actual disposal', async t => {
  const h = await harness(t, { image: true }), entry = await h.prepare()
  const request = h.requests.find(request => request.op === 'resource')
  assert.deepEqual(request.payload.key, entry.candidate.proof.publication.key)
  assert.equal(request.payload.sha256, digest)
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0].type, 'image/png')
  assert.equal(h.adapter.pendingResourceBytes, bytes.byteLength)
  await h.present(entry); await h.release(entry)
  assert.deepEqual(h.revocations, [])
  const closing = h.adapter.close()
  assert.equal(h.adapter.close(), closing)
  await closing
  assert.deepEqual(h.revocations, ['blob:owned-1'])
  assert.equal(h.adapter.pendingResourceCount, 0)
  assert.equal(h.rpc.state, 'open')
  assert.equal(h.worker.terminated, 0, 'adapter must not close borrowed Worker')
})

test('resource key/hash/size/digest mismatch never creates a URL and aborts preparation', async t => {
  for (const variant of ['key', 'hash', 'size', 'digest']) await t.test(variant, async t => {
    const h = await harness(t, { image: true })
    h.hooks.set('outer:resource', ({ message, native }) => {
      const result = native(message.op, message.payload)
      if (variant === 'key') result.key.pageId = '9'
      if (variant === 'hash') result.sha256 = 'b'.repeat(64)
      if (variant === 'size') result.bytes = new ArrayBuffer(1)
      if (variant === 'digest') result.bytes = new Uint8Array(bytes.byteLength).buffer
      return result
    })
    await assert.rejects(h.prepare(), failure => ['ERR_RENDER', 'ERR_PROTOCOL_VERSION'].includes(failure.code))
    assert.equal(h.created.length, 0)
    assert.equal(h.adapter.pendingResourceCount, 0)
    assert.equal(h.adapter.pendingResourceBytes, 0)
    assert.equal(h.calls.some(call => call.op === 'view.prepare.commit'), false)
  })
})

test('resource byte budgets reject before a transfer and do not fake lower quality', async t => {
  const h = await harness(t, { image: true, maxResourceBytes: bytes.byteLength - 1 })
  await assert.rejects(h.prepare(), failure => failure.code === 'ERR_RENDER')
  assert.equal(h.requests.some(request => request.op === 'resource'), false)
  assert.equal(h.created.length, 0)
  assert.equal(h.adapter.pendingResourceCount, 0)
})

test('reentrant retirement during URL installation revokes exactly once before failure', async t => {
  let h
  h = await harness(t, { image: true, onCreateURL() { h.adapter.freezeInput(); h.adapter.receiveObservation(h.observe({ surfaceGeneration: '2' })) } })
  await assert.rejects(h.prepare(), failure => failure.code === 'ERR_CANCELLED')
  assert.deepEqual(h.revocations, ['blob:owned-1'])
  assert.equal(h.adapter.pendingResourceBytes, 0)
  assert.equal(h.presenter.current, null)
})

test('last-use disposal and resource release remain pending through asynchronous disposer', async t => {
  const gate = deferred(), entered = deferred()
  const h = await harness(t, { image: true, disposeCandidate(candidate) { entered.resolve(); return gate.promise.then(() => candidate.plan.dispose()) } })
  const entry = await h.prepare()
  const releasing = h.release(entry)
  await entered.promise
  assert.equal(h.revocations.length, 0)
  assert.equal(h.adapter.pendingResourceCount, 1)
  gate.resolve()
  await releasing
  assert.deepEqual(h.revocations, ['blob:owned-1'])
  assert.equal(h.adapter.pendingResourceCount, 0)
})

test('failed URL revocation retains ownership and stable cleanup failure', async t => {
  const failure = new Error('URL revoke failed')
  const h = await harness(t, { image: true, expectCloseFailure: true, revoke() { throw failure } })
  const entry = await h.prepare()
  await h.present(entry); await h.release(entry)
  const closing = h.adapter.close(), result = await outcome(closing)
  assert.equal(h.adapter.close(), closing)
  assert.equal(result.error.code, 'ERR_RENDER')
  assert.equal(h.adapter.pendingResourceCount, 1)
  assert.equal(h.adapter.pendingResourceBytes, bytes.byteLength)
  assert.equal(h.revocations.length, 1, 'failed revocation is not retried or falsely freed')
  assert.equal(h.rpc.state, 'open')
})

test('real control-lane retirement leaves RPC available for exact abort and owner close', async t => {
  const h = await harness(t), entry = await h.prepare()
  const cancellation = h.adapter.cancelOwnedWork('test-retire')
  assert.equal(h.adapter.cancelOwnedWork('another'), cancellation)
  assert.deepEqual(await cancellation, { cancelled: true, workerRetired: true })
  await h.release(entry)
  const retired = h.requests.find(request => request.op === 'view.retire')
  assert.deepEqual(retired.payload, { reason: 'test-retire' })
  assert.equal(h.requests.some(request => request.op === 'view.abort'), true)
  assert.equal(h.rpc.state, 'open')
  assert.equal(h.worker.terminated, 0)
  await h.adapter.close()
  const response = await h.rpc.requestHost('state', {})
  assert.equal(response.state.currentPage.path, 'pages/home')
})

test('borrowed unique bridge survives adapter cleanup and carries exact ordered responses', async t => {
  const h = await harness(t, { borrowBridge: true })
  const entry = await h.prepare()
  h.adapter.receiveObservation(h.observe({ templateRevision: '2' }))
  await h.present(entry); await h.release(entry)
  const closing = await h.adapter.close()
  assert.equal(closing.workerClosed, false)
  assert.equal(closing.bridgeClosed, false)
  assert.equal(h.sharedBridge.closed, false)
  assert.equal(h.rpc.state, 'open')
  const result = await h.sharedBridge.request('view.geometry', { key: entry.candidate.proof.publication.key, epoch: '1', nodes: [] })
  assert.equal(result.ok, true)
})

test('malformed external event freezes input without closing its borrowed RPC', async t => {
  const h = await harness(t), entry = await h.prepare()
  await h.present(entry); await h.release(entry)
  assert.equal(h.nodes[0].interactive, true)
  assert.equal(h.adapter.receiveEvent({ version: '1.0', kind: 'event', workerEpoch: 'foreign', sessionId: OWNER.sessionId }), false)
  assert.equal(h.nodes[0].interactive, false)
  assert.equal(h.adapter.client.accepted.inputEnabled, false)
  assert.equal(h.rpc.state, 'open')
})

test('owner close Promise is claimed before a reentrant synchronous suspension callback', async t => {
  const h = await harness(t)
  const suspend = h.presenter.suspendInput.bind(h.presenter)
  let reentrant
  h.presenter.suspendInput = () => { reentrant = h.adapter.close(); suspend() }
  const closing = h.adapter.close()
  assert.equal(reentrant, closing)
  await closing
  assert.equal(h.worker.terminated, 0)
  assert.equal(h.rpc.state, 'open')
})


test('bad ordered metadata and asynchronous effect callbacks freeze rather than fabricate state', async t => {
  for (const variant of ['owner', 'regression', 'async']) await t.test(variant, async t => {
    const h = await harness(t, variant === 'async' ? { onObservation: () => Promise.resolve() } : {})
    const newer = h.observe({ templateRevision: '2' })
    if (variant === 'owner') newer.state.owner.packSha256 = 'b'.repeat(64)
    if (variant === 'regression') newer.state.surfaceGeneration = '0'
    assert.throws(() => h.adapter.receiveObservation(newer), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(h.adapter.faulted, true)
    assert.equal(h.rpc.state, 'open')
  })
})

test('standalone retained success is noticed after observation while the real public input promise rejects', async t => {
  let h
  const noticed = []
  h = await harness(t, { onBatch(batch) {
    if (batch.messages.some(message => message.op === 'retained.effect')) noticed.push({ sequence: h.adapter.observation.sequence,
      faulted: h.adapter.faulted, inputEnabled: h.adapter.client.accepted?.inputEnabled, batch: copy(batch) })
  } })
  const entry = await h.prepare(); await h.present(entry); await h.release(entry)
  assert.equal(h.adapter.client.accepted.inputEnabled, true)
  let retained, observation
  h.hooks.set('view.events', ({ envelope, result }) => {
    retained = { messages: [innerReply(envelope, result), { protocolVersion: '1.0', sessionId: OWNER.sessionId,
      requestId: '', kind: 'event', op: 'retained.effect', payload: { committed: true } }] }
    observation = h.observe({ templateRevision: '2' })
    // The same native object can occur through several finite diagnostic paths.
    throw Object.assign(new Error('ordered observation refresh failed after native input'), { code: 'ERR_RPC_BACKPRESSURE',
      details: { committedResult: retained, originalDetails: { batch: retained, details: { batch: retained } } } })
  })
  let correlationReceives = 0
  const receiveBatch = h.adapter.transport.receiveBatch.bind(h.adapter.transport)
  h.adapter.transport.receiveBatch = batch => { correlationReceives++; return receiveBatch(batch) }
  const result = await outcome(h.adapter.client.events({ version: '1.0', key: entry.candidate.proof.publication.key, events: [] }))
  assert.equal(result.value, undefined, 'retained native ok cannot convert the public outer error to success')
  assert.equal(result.error.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(result.error.message, 'ordered observation refresh failed after native input')
  assert.equal(noticed.length, 1, 'aliased retained batch is one notice, not several deliveries')
  assert.equal(noticed[0].sequence, observation.sequence)
  assert.equal(noticed[0].faulted, true)
  assert.equal(noticed[0].inputEnabled, false)
  assert.deepEqual(noticed[0].batch, retained)
  assert.equal(correlationReceives, 0, 'error notices must not settle active inner correlation')
  assert.equal(h.adapter.transport.pendingCount, 0)
  assert.equal(h.nodes[0].interactive, false)
  assert.equal(h.rpc.state, 'open')
})

test('late standalone error preserves committed effects without reviving a retired real client promise', async t => {
  let h
  const entered = deferred(), gate = deferred(), noticed = []
  h = await harness(t, { onBatch(batch) {
    if (batch.messages.some(message => message.op === 'retained.late')) noticed.push({ sequence: h.adapter.observation.sequence,
      inputEnabled: h.adapter.client.accepted?.inputEnabled, batch: copy(batch) })
  } })
  const entry = await h.prepare(); await h.present(entry); await h.release(entry)
  h.hooks.set('view.events', async ({ envelope, result }) => { entered.resolve({ envelope, result }); return gate.promise })
  let settled = 0
  const requesting = outcome(h.adapter.client.events({ version: '1.0', key: entry.candidate.proof.publication.key, events: [] }))
    .then(result => { settled++; return result })
  const pending = await entered.promise
  h.adapter.client.connection.abort()
  const result = await requesting
  assert.equal(result.value, undefined)
  assert.equal(result.error.localCancellation, true)
  const observation = h.observe({ templateRevision: '2' })
  const retained = { messages: [innerReply(pending.envelope, pending.result), { protocolVersion: '1.0', sessionId: OWNER.sessionId,
    requestId: '', kind: 'event', op: 'retained.late', payload: { committed: true } }] }
  gate.reject(Object.assign(new Error('late refresh failure'), { code: 'ERR_RPC_BACKPRESSURE', details: { committedResult: retained } }))
  await tick(); await tick()
  assert.equal(settled, 1)
  assert.equal(noticed.length, 1)
  assert.equal(noticed[0].sequence, observation.sequence)
  assert.equal(noticed[0].inputEnabled, false)
  assert.deepEqual(noticed[0].batch, retained)
  assert.equal(h.adapter.transport.pendingCount, 0)
  assert.equal(h.adapter.faulted, true)
  assert.equal(h.nodes[0].interactive, false)
  assert.equal(h.rpc.state, 'open')
})

test('borrowed owner retains sole error notice ownership and genuine nested fault diagnostics survive', async t => {
  await t.test('borrowed notice cannot resolve the real public client promise', async t => {
    const h = await harness(t, { borrowBridge: true }), notices = []
    const entry = await h.prepare(); await h.present(entry); await h.release(entry)
    const before = h.batches.length, original = h.observedRpc.requestHost.bind(h.observedRpc)
    let correlationReceives = 0
    const receiveBatch = h.sharedBridge.receiveBatch.bind(h.sharedBridge)
    h.sharedBridge.receiveBatch = batch => { correlationReceives++; return receiveBatch(batch) }
    // Explicit fake owner matches the product's outer-observation-first,
    // notice-only error contract over the actual RPC/bridge/client stack.
    h.observedRpc.requestHost = async (...args) => {
      try { return await original(...args) }
      catch (failure) {
        if (failure.details?.observation) h.adapter.receiveObservation(failure.details.observation)
        const retained = failure.details?.details?.committedResult
        if (retained) notices.push(copy(retained))
        throw failure
      }
    }
    let retained
    h.hooks.set('view.events', ({ envelope, result }) => {
      retained = { messages: [innerReply(envelope, result)] }
      h.observe({ requiresRestart: true })
      throw Object.assign(new Error('borrowed refresh failure'), { code: 'ERR_RPC_BACKPRESSURE', details: { committedResult: retained } })
    })
    const result = await outcome(h.adapter.client.events({ version: '1.0', key: entry.candidate.proof.publication.key, events: [] }))
    assert.equal(result.value, undefined)
    assert.equal(result.error.code, 'ERR_RPC_BACKPRESSURE')
    assert.deepEqual(notices, [retained])
    assert.equal(h.batches.length, before, 'borrowed adapter must not add a second error notice')
    assert.equal(correlationReceives, 0)
    assert.equal(h.sharedBridge.pendingCount, 0)
    assert.equal(h.adapter.client.accepted.inputEnabled, false)
    assert.equal(h.nodes[0].interactive, false)
  })
  await t.test('fault reads payload.error rather than misleading top-level fields', async t => {
    const h = await harness(t), entry = await h.prepare()
    await h.present(entry); await h.release(entry)
    const fault = { error: { code: 'ERR_RPC_BACKPRESSURE', message: 'native event credit exhausted' },
      code: 'ERR_ENGINE', message: 'must not replace the actual nested error', origin: 'owner', requiresRestart: true,
      observation: h.observe({ requiresRestart: true }) }
    h.event('fault', fault)
    await tick()
    const reported = h.diagnostics.find(value => value.code === fault.error.code && value.message === fault.error.message)
    assert.ok(reported)
    assert.deepEqual(reported.details.error, fault.error)
    assert.equal(h.adapter.client.accepted.inputEnabled, false)
    assert.equal(h.nodes[0].interactive, false)
    assert.equal(h.rpc.state, 'open')
  })
})

test('genuine fault text survives a failing observation callback while input remains permanently frozen', async t => {
  const observerFailure = new Error('observation consumer failed')
  const h = await harness(t, { onObservation(value) { if (value.state.requiresRestart) throw observerFailure } })
  const entry = await h.prepare(); await h.present(entry); await h.release(entry)
  const before = h.batches.length, enabledBefore = h.nodes[0].activation.filter(Boolean).length
  let correlationReceives = 0
  const receiveBatch = h.adapter.transport.receiveBatch.bind(h.adapter.transport)
  h.adapter.transport.receiveBatch = batch => { correlationReceives++; return receiveBatch(batch) }
  const fault = { error: { code: 'ERR_RPC_BACKPRESSURE', message: 'ERR_RPC_BACKPRESSURE: preserve the exact upstream text' },
    origin: 'owner', requiresRestart: true, observation: h.observe({ requiresRestart: true }) }
  h.event('fault', fault)
  await tick()
  const reported = h.diagnostics.find(value => value.code === fault.error.code && value.message === fault.error.message)
  assert.ok(reported, 'an observation callback failure must not erase the genuine Worker diagnostic')
  assert.deepEqual(reported.details.error, fault.error)
  assert.ok(reported.cleanupErrors.includes(observerFailure))
  assert.equal(h.adapter.observation.sequence, fault.observation.sequence)
  assert.equal(h.adapter.faulted, true)
  assert.equal(h.adapter.client.accepted.inputEnabled, false)
  assert.equal(h.nodes[0].interactive, false)
  assert.equal(correlationReceives, 0)
  assert.equal(h.batches.length, before)
  h.adapter.receiveObservation(h.observe({ requiresRestart: false }))
  assert.equal(h.adapter.faulted, true, 'a later healthy observation is not replacement authority')
  assert.equal(h.adapter.client.accepted.inputEnabled, false)
  assert.equal(h.nodes[0].activation.filter(Boolean).length, enabledBefore, 'fault handling cannot enable the old presentation again')
  assert.equal(h.rpc.state, 'open')
})


test('generation-scoped DOM attachment waits actual owner retirement without old-binding abort or second load', async () => {
  const runtimeOwner = Object.fromEntries(['workerEpoch', 'sessionId', 'packSha256'].map(key => [key, OWNER[key]]))
  const presenterBinding = { version: '1.0', sessionId: OWNER.sessionId, generation: '2', transportBackend: 'browser-view' }
  const observation = { version: '2.0', sequence: '4', state: { ...initial(), owner: runtimeOwner, presenterBinding, transitionRequired: false } }
  const loaded = { renderer: 'external-frame', transportBackend: 'external-frame', capabilities: { quickjs: true }, manifest,
    runtimeOwner, pack: { indexSha256: OWNER.packSha256 }, rendererTransitions: { version: '1.0', runtimeOwner: '1.0', presenterBinding: '1.0', inputLifetime: '1.0', transitionFinal: '1.0', observation: '2.0' } }
  const attachment = { version: '1.0', runtimeOwner, presenterBinding, observation }
  const requests = [], rpc = { workerEpoch: OWNER.workerEpoch, sessionId: OWNER.sessionId, actualFinalContract: '1.0',
    requestHost(op) { requests.push(op); return Promise.reject(new Error('retirement must not send an old presenter operation')) } }
  const presenter = new DomViewPresenter({ ownerDocument: {}, append() {} }, { timeoutMs: 500 })
  const adapter = new WorkerDomAdapter({ rpc, loadResult: loaded, attachment, presenter, crypto: webcrypto })
  assert.equal(adapter.owner.presenterGeneration, '2'); assert.equal(adapter.observation.version, '2.0')
  const native = deferred(); let settled = false
  const retirement = adapter.beginPresenterRetirement(native.promise)
  const closing = adapter.dispose().then(value => { settled = true; return value })
  await tick(); assert.equal(settled, false); assert.deepEqual(requests, [])
  native.resolve({ version: '1.0', retired: true, previousPresenterBinding: presenterBinding,
    presenterBinding: { ...presenterBinding, generation: '3', transportBackend: 'external-frame' }, source: 'native-renderer-transition-final' })
  await retirement; await closing
  assert.equal(settled, true); assert.deepEqual(requests, [])
})

test('BufferURL DOM descriptor path reaches the actual resource RPC before blob creation', async t => {
  const h=await harness(t,{image:true,bufferURL:true}),entry=await h.prepare()
  const request=h.requests.find(request=>request.op==='resource')
  assert.equal(request.payload.path,'__container_buffer_urls/'+'a'.repeat(48));assert.equal(h.created.length,1)
  await h.present(entry);await h.release(entry);await h.adapter.close();assert.deepEqual(h.revocations,['blob:owned-1'])
})
test('BufferURL descriptor substitution is rejected before a DOM blob URL can be installed', async t => {
  for(const path of [undefined,'__container_buffer_urls/'+'b'.repeat(48)])await t.test(String(path),async t=>{
    const h=await harness(t,{image:true,bufferURL:true});h.hooks.set('outer:resource',({message,native})=>({...native(message.op,message.payload),path}))
    await assert.rejects(h.prepare(),failure=>failure.code==='ERR_PROTOCOL_VERSION');assert.equal(h.created.length,0);assert.equal(h.adapter.pendingResourceCount,0)
  })
})


test('Worker retained sample uses native permit and cloned proof without View/resource reconstruction', async t => {
  const h = await harness(t, { animation: true, image: true }), initial = await h.prepare()
  await h.present(initial); await h.release(initial, { committed: true }); await tick(); await h.adapter.client.turn
  const candidate = h.nodes[0], plan = candidate.plan, templateKey = initial.candidate.proof.publication.key
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '1' }))
  const context = h.context(), sample = await h.adapter.preparePaint(h.adapter.observation.state, accepted(initial.candidate), context)
  assert.deepEqual(sample.proof.consumedSample, { demandRevision: '1', sampleRevision: '2' })
  assert.equal(sample.proof.publication.key.documentRevision, templateKey.documentRevision)
  assert.equal(candidate.root.style.getPropertyValue('opacity'), '0.8')
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '2' }))
  const result = await h.adapter.present(sample, { ...context, proof: copy(sample.proof), timestamp: 999999 })
  assert.equal(result.acknowledged, true); assert.equal(result.inputEnabled, true)
  assert.deepEqual(sample.proof.consumedSample, { demandRevision: '1', sampleRevision: '2' })
  assert.equal(candidate.root.style.getPropertyValue('opacity'), '0.4')
  await h.adapter.release(sample, { ...context, proof: copy(sample.proof), committed: true, retired: false })
  assert.equal(h.nodes.length, 1); assert.equal(candidate.plan, plan); assert.equal(candidate.disposed, 0)
  assert.equal(h.created.length, 1); assert.equal(h.revocations.length, 0)
  assert.equal(h.calls.filter(c => c.op === 'view.prepare').length, 1)
  assert.equal(h.requests.filter(c => c.op === 'resource').length, 1)
})

test('Worker sample release uses reserved exact abort and keeps accepted resource leases', async t => {
  const h = await harness(t, { animation: true, image: true }), initial = await h.prepare()
  await h.present(initial); await h.release(initial, { committed: true }); await tick(); await h.adapter.client.turn
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '1' }))
  const context = h.context(), sample = await h.adapter.preparePaint(h.adapter.observation.state, accepted(initial.candidate), context)
  const release = await h.adapter.release(sample, { ...context, proof: copy(sample.proof), committed: false, retired: true })
  assert.equal(release.acknowledged, false)
  const abort = h.requests.find(c => c.op === 'view.sample.abort')
  assert.deepEqual(abort.payload, { version: '1.0', key: sample.proof.publication.key })
  assert.equal(h.nodes[0].root.style.getPropertyValue('opacity'), '0.8')
  assert.equal(h.nodes[0].disposed, 0); assert.equal(h.revocations.length, 0)
})

test('Worker sampling rejects unacknowledged, altered and superseded accepted proofs before native or DOM work', async t => {
  const h = await harness(t, { animation: true }), initial = await h.prepare()
  const unacknowledged = accepted(initial.candidate)
  await h.release(initial, { retired: true })
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '1' }))
  await assert.rejects(h.adapter.preparePaint(h.adapter.observation.state, unacknowledged, h.context()), failure => failure.code === 'ERR_PROTOCOL_VERSION')
  assert.equal(h.calls.filter(call => call.op === 'view.sample.prepare').length, 0)
  const retained = await h.prepare()
  await h.present(retained); await h.release(retained, { committed: true })
  const base = accepted(retained.candidate), node = h.nodes.at(-1), style = node.root.style.getPropertyValue('opacity')
  const mutations = [
    proof => { proof.version = '2.0' },
    proof => { proof.attemptId = '999' },
    proof => { proof.owner.workerEpoch = 'foreign-worker' },
    proof => { proof.owner.presenterGeneration = '1' },
    proof => { proof.surfaceGeneration = '2' },
    proof => { proof.publication.key.presentationRevision = '999' },
    proof => { proof.consumedInput.templateRevision = '2' },
    proof => { proof.consumedSample.sampleRevision = '999' },
    proof => { proof.consumedSample.demandRevision = '01' },
  ]
  for (const mutate of mutations) {
    const forged = copy(base); mutate(forged.proof)
    await assert.rejects(h.adapter.preparePaint(h.adapter.observation.state, forged, h.context()), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(h.adapter.active, null); assert.equal(h.adapter.client.active, null)
    assert.equal(node.root.style.getPropertyValue('opacity'), style)
    assert.equal(h.calls.filter(call => call.op === 'view.sample.prepare').length, 0)
  }
  h.adapter.freezeInput()
  const context = h.context(), sample = await h.adapter.preparePaint(h.adapter.observation.state, copy(base), context)
  await h.adapter.present(sample, { ...context, proof: copy(sample.proof) })
  await h.adapter.release(sample, { ...context, proof: copy(sample.proof), committed: true, retired: false })
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '2' }))
  await assert.rejects(h.adapter.preparePaint(h.adapter.observation.state, base, h.context()), failure => failure.code === 'ERR_PROTOCOL_VERSION')
  assert.equal(h.calls.filter(call => call.op === 'view.sample.prepare').length, 1, 'old genuine ACK cannot replace the latest retained sample')
  const nextContext = h.context(), next = await h.adapter.preparePaint(h.adapter.observation.state, accepted(sample), nextContext)
  await h.adapter.release(next, { ...nextContext, proof: copy(next.proof), committed: false, retired: true })
})

test('Worker sampling requires a current third-argument context and a matching live client base', async t => {
  const h = await harness(t, { animation: true, inputEnabled: false }), initial = await h.prepare()
  assert.equal((await h.present(initial)).inputEnabled, false)
  await h.release(initial, { committed: true })
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '1' }))
  const base = accepted(initial.candidate), aborted = new AbortController(); aborted.abort()
  for (const [patch, code] of [
    [{ owner: { ...OWNER, workerEpoch: 'stale-worker' } }, 'ERR_PROTOCOL_VERSION'],
    [{ attemptId: initial.context.attemptId }, 'ERR_PROTOCOL_VERSION'],
    [{ surfaceGeneration: '2' }, 'ERR_PROTOCOL_VERSION'],
    [{ signal: aborted.signal }, 'ERR_CANCELLED'],
    [{ isCurrent: () => false }, 'ERR_CANCELLED'],
  ]) {
    await assert.rejects(h.adapter.preparePaint(h.adapter.observation.state, base, { ...h.context(), ...patch }), failure => failure.code === code)
    assert.equal(h.adapter.active, null); assert.equal(h.adapter.client.active, null)
  }
  const retained = h.adapter.client.accepted
  for (const patch of [
    { key: { ...retained.key, presentationRevision: '999' } },
    { consumedInput: { ...retained.consumedInput, templateRevision: '2' } },
    { authority: { ...retained.authority, revision: '999' } },
    { geometryEpoch: '01' },
  ]) {
    h.adapter.client.accepted = { ...retained, ...patch }
    await assert.rejects(h.adapter.preparePaint(h.adapter.observation.state, base, h.context()), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    h.adapter.client.accepted = retained
  }
  assert.equal(h.calls.filter(call => call.op === 'view.sample.prepare').length, 0)
  assert.equal(h.nodes[0].root.style.getPropertyValue('opacity'), '0.8')
  const context = h.context(), sample = await h.adapter.preparePaint(h.adapter.observation.state, base, context)
  assert.equal(h.adapter.client.accepted.inputEnabled, false, 'a real input-disabled ACK remains a usable visual base')
  await h.adapter.release(sample, { ...context, proof: copy(sample.proof), committed: false, retired: true })
})

test('Worker sample release retains the real ACK discovered after cancelled delivery as the next exact base', async t => {
  const h = await harness(t, { animation: true }), initial = await h.prepare()
  await h.present(initial); await h.release(initial, { committed: true })
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '1' }))
  const context = h.context(), sample = await h.adapter.preparePaint(h.adapter.observation.state, accepted(initial.candidate), context)
  h.hooks.set('view.sample.presented', () => { throw Object.assign(new Error('native ACK delivery cancelled'), { code: 'ERR_CANCELLED' }) })
  h.hooks.set('outer:view.sample.abort', ({ message }) => ({ messages: [{ protocolVersion: '1.0', sessionId: OWNER.sessionId,
    kind: 'response', requestId: 'settled-sample', op: 'view.sample.abort', payload: { ok: true, version: '1.0', key: message.payload.key,
      aborted: false, presented: true, inputEnabled: false, consumedSample: copy(sample.proof.consumedSample) } }] }))
  await assert.rejects(h.adapter.present(sample, { ...context, proof: copy(sample.proof) }), failure => failure.code === 'ERR_CANCELLED')
  const released = await h.adapter.release(sample, { ...context, proof: copy(sample.proof), committed: false, retired: true })
  assert.equal(released.acknowledged, true); assert.equal(h.adapter.client.accepted.inputEnabled, false)
  assert.deepEqual(h.adapter.client.accepted.key, sample.proof.publication.key)
  assert.equal(h.nodes[0].root.style.getPropertyValue('opacity'), '0.4', 'genuine accepted style journal is irreversible')
  h.hooks.delete('view.sample.presented'); h.hooks.delete('outer:view.sample.abort')
  h.adapter.receiveObservation(h.observe({ sampleDemandRevision: '2' }))
  await assert.rejects(h.adapter.preparePaint(h.adapter.observation.state, accepted(initial.candidate), h.context()), failure => failure.code === 'ERR_PROTOCOL_VERSION')
  const nextContext = h.context(), next = await h.adapter.preparePaint(h.adapter.observation.state, accepted(sample), nextContext)
  assert.deepEqual(h.calls.filter(call => call.op === 'view.sample.prepare').at(-1).payload.baseKey, sample.proof.publication.key)
  await h.adapter.release(next, { ...nextContext, proof: copy(next.proof), committed: false, retired: true })
})
