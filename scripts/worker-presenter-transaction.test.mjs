/** Contract fixtures only: no generated WASM, browser, CanvasKit or GPU claim. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerWebSession } from '../examples/hosts/web-wasm/worker-web-session.mjs'
import { WorkerBridgeTransport } from '../examples/hosts/web-wasm/worker-bridge-transport.mjs'
import { WORKER_RENDERER_TRANSITION_CONTRACT } from '../examples/hosts/web-wasm/worker-runtime.mjs'

const pin = 'a'.repeat(64), manifestPin = 'b'.repeat(64), rootPin = 'c'.repeat(64)
const runtimeOwner = Object.freeze({ workerEpoch: 'transaction-worker', sessionId: 'transaction-session', packSha256: pin })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve() }
const failure = (code, message) => Object.assign(new Error(message), { code })
const binding = (generation = '1', transportBackend = 'browser-view') => ({ version: '1.0', sessionId: runtimeOwner.sessionId, generation, transportBackend })
const rect = { x: 0, y: 0, width: 100, height: 50 }
class Element {
  constructor(document, tag) { this.ownerDocument = document; this.tag = tag; this.children = []; this.events = new Map(); this.style = {}; this.attributes = new Map(); this.isConnected = false }
  append(child) { child.parent = this; child.isConnected = true; this.children.push(child) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(value => value !== this); this.isConnected = false }
  setAttribute(key, value) { this.attributes.set(key, value) }
  addEventListener(key, listener) { const listeners = this.events.get(key) ?? new Set(); listeners.add(listener); this.events.set(key, listeners) }
  removeEventListener(key, listener) { this.events.get(key)?.delete(listener) }
}
function fixture({ assetsFail = 0, canvasFactoryFail = 0, schedulerFactoryFail = 0, adapterDisposeFail = 0, beforeDomAttach, beforeCanvasAttach } = {}) {
  const document = { hidden: false }; document.createElement = tag => new Element(document, tag)
  const events = new Element(document); document.addEventListener = events.addEventListener.bind(events); document.removeEventListener = events.removeEventListener.bind(events)
  document.defaultView = new Element(document); const root = new Element(document), unrelated = new Element(document); root.append(unrelated)
  const log = [], calls = [], adapters = [], schedulers = [], leases = [], batches = [], handlers = new Map()
  let rpc, sequence = 1n, eventSequence = 0, state = { owner: runtimeOwner, sessionId: runtimeOwner.sessionId,
    presenterBinding: binding(), transportBackend: 'browser-view', transitionRequired: false, surfaceGeneration: '1',
    inputLifetimeRevision: '1', templateRevision: '1', renderRevision: '0', viewRevision: '1', viewport: rect,
    lifecycle: 'Active', rendererProfile: 'webview', declaredRendererProfile: 'webview', requiresRestart: false,
    currentPage: { pageId: '1', path: 'pages/dom/index' } }
  const observation = () => structuredClone({ version: '2.0', sequence: String(sequence), state })
  const update = changes => { state = { ...state, ...changes }; sequence++; return observation() }
  const effect = op => ({ protocolVersion: '1.0', sessionId: runtimeOwner.sessionId, requestId: '', kind: 'event', op, payload: {} })
  const batch = op => ({ messages: [effect(op)], observation: observation() })
  const transitionFinal = () => {
    const previousPresenterBinding = state.presenterBinding
    const next = binding(String(BigInt(previousPresenterBinding.generation) + 1n), state.rendererProfile === 'webview' ? 'browser-view' : 'external-frame')
    update({ presenterBinding: next, transportBackend: next.transportBackend, transitionRequired: false,
      inputLifetimeRevision: String(BigInt(state.inputLifetimeRevision) + 1n), surfaceGeneration: String(BigInt(state.surfaceGeneration) + 1n) })
    return { version: '1.0', ok: true, previousPresenterBinding, presenterBinding: next, inputLifetimeRevision: state.inputLifetimeRevision,
      runtimeOwner, inputEnabled: false, batch: batch('native.retirement'), observedState: structuredClone(state), observation: observation() }
  }
  const domAdapter = Object.assign(async config => {
    const adapter = makeAdapter(config, 'browser-view')
    if (beforeDomAttach && adapters.length === 1) await beforeDomAttach({ session, navigate: profile => navigate(profile) })
    return adapter
  }, { browserQueries: { version: '1.0' } })
  function makeAdapter(config, backend) {
    const owner = config.owner ?? { ...runtimeOwner, transportBackend: backend, presenterGeneration: config.attachment.presenterBinding.generation }
    const adapter = { config, owner, backend, canvas: config.canvas ?? null, cancels: 0, disposals: 0, freezes: [],
      latest: config.attachment?.observation ?? observation(),
      receiveObservation(value) { this.latest = value }, receiveQueryBatch(value) { log.push(`query:${owner.presenterGeneration}`); this.query = value },
      setOwnerInputFence({ revision, blocked }) { return { version: '1.0', revision, blocked } }, acceptsOwnerInput() { return false },
      freezeInput(reason) { this.freezes.push(reason) },
      beginPresenterRetirement(retirement) { log.push(`begin:${owner.presenterGeneration}`); this.retirement = retirement; return this.cancelOwnedWork() },
      cancelOwnedWork() { if (!this.cancel) { this.cancels++; this.cancel = Promise.resolve(this.retirement) } return this.cancel },
      dispose() { if (!this.disposal) { this.disposals++; this.disposal = Promise.resolve(this.cancelOwnedWork()).then(() => {
        log.push(`dispose:${owner.presenterGeneration}`)
        if (backend === 'external-frame' && adapterDisposeFail-- > 0) throw failure('ERR_RENDER', 'fixture destructor cannot prove last use of captured fontData')
        this.canvas?.remove()
      }) } return this.disposal },
      prepareTemplate(demand, context) {
        const proof = { version: '1.0', owner, attemptId: context.attemptId, surfaceGeneration: demand.surfaceGeneration,
          consumedInput: { pageId: demand.currentPage.pageId, routePath: demand.currentPage.path, viewport: demand.viewport, templateRevision: demand.templateRevision },
          publication: backend === 'external-frame' ? { kind: backend, renderRevision: '1' } : { kind: backend, key: { sessionId: owner.sessionId, pageId: demand.currentPage.pageId,
            documentRevision: '1', presentationRevision: '1', surfaceGeneration: demand.surfaceGeneration, profile: 'webview' } } }
        return { proof }
      },
      preparePaint() { throw new Error('fixture never invokes retained paint') },
      present(candidate, context) { return { acknowledged: true, inputEnabled: context.isCurrent(), proof: candidate.proof } }, release() {},
      suspendOwnedSurface() {}, resumeOwnedSurface() {}, finalizeRemoteWork() { log.push(`actual-drained:${owner.presenterGeneration}`) },
    }
    adapters.push(adapter); return adapter
  }
  const session = new WorkerWebSession({ surfaceRoot: root, onBatch: value => batches.push(value),
    admitPack: async () => ({ version: '1.0', route: 'pages/dom/index', transportBackend: 'browser-view', rendererPolicy: { mode: 'manifest' },
      declaredProfile: 'webview', effectiveProfile: 'webview', provenance: { indexSha256: pin, manifestSha256: manifestPin, integrityRoot: rootPin } }),
    loadRendererAssets: async config => {
      log.push(`assets:${config.owner.presenterGeneration}`)
      if (assetsFail-- > 0) throw failure('ERR_RENDER', 'fixture asset failure')
      const lease = { version: '1.0', owner: config.owner, CanvasKit: {}, fontData: new ArrayBuffer(4), disposals: 0,
        dispose() { if (!this.disposal) { this.disposals++; log.push(`lease.dispose:${config.owner.presenterGeneration}`); this.disposal = Promise.resolve() } return this.disposal } }
      leases.push(lease); return lease
    }, requestFrame() { throw new Error('fixture scheduler has no RAF') }, cancelFrame() {},
    factories: {
      rpc(config) {
        rpc = { workerEpoch: runtimeOwner.workerEpoch, sessionId: runtimeOwner.sessionId, actualFinalContract: '1.0', config, closes: 0,
          requestHost(op, payload, options = {}) {
            calls.push({ op, payload, options }); log.push(`rpc:${op}`)
            if (handlers.has(op)) return handlers.get(op)(payload, options)
            let result
            if (op === 'load') result = { state: structuredClone(state), capabilities: { quickjs: true }, renderer: 'browser-view', transportBackend: 'browser-view',
              rendererPolicy: { mode: 'manifest' }, declaredProfile: 'webview', effectiveProfile: 'webview', runtimeOwner, presenterBinding: state.presenterBinding,
              manifest: { app: {}, routes: [{ path: 'pages/dom/index' }, { path: 'pages/skia/index' }], styles: [], integrity: { root: rootPin } },
              pack: { indexSha256: pin, manifestSha256: manifestPin, integrityRoot: rootPin }, rendererTransitions: WORKER_RENDERER_TRANSITION_CONTRACT,
              observationContract: { version: '2.0', sequence: 'u64', surfaceGeneration: '1.0', inputLifetime: '1.0', runtimeOwner: '1.0', presenterBinding: '1.0' },
              observation: observation(), browserQueries: { version: '1.0' }, externalPresentation: { version: '1.0', consumedInput: '1.0', ackOutcome: '1.0', physicalTarget: '1.0' },
              surfaceRecovery: { version: '1.0', retainedExternalFrame: '1.0' } }
            else if (op === 'renderer.transition') result = transitionFinal()
            else if (op === 'resource') result = { resource: 'fixture', observation: observation() }
            else if (op === 'bridge') result = { messages: [{ ...payload.envelope, kind: 'response', payload: { ok: true, value: 'same-runtime' } }], observation: observation() }
            else throw new Error(`unexpected fixture operation ${op}`)
            options.onActualFinal?.({ version: '1.0', status: 'final', requestId: `fixture-${calls.length}` })
            return Promise.resolve(result)
          },
          close() { this.closes++; log.push('rpc.close'); return Promise.resolve({ closed: true, diagnostics: [] }) },
        }; return rpc
      }, bridge: config => new WorkerBridgeTransport(config), domAdapter, canvasAdapter: async config => {
        if (canvasFactoryFail-- > 0) throw failure('ERR_RENDER', 'fixture canvas factory rejected before ownership transfer')
        await beforeCanvasAttach?.(config)
        return makeAdapter(config, 'external-frame')
      },
      scheduler(config) {
        if (config.owner.transportBackend === 'external-frame' && schedulerFactoryFail-- > 0) throw failure('ERR_RENDER', 'fixture scheduler factory rejected after adapter transfer')
        const scheduler = { config, latest: null, closed: false, status: { phase: 'idle', accepted: null },
          observe(value) { this.latest = value }, suspend() { this.recovery = null; this.status = { ...this.status, suspended: true, accepted: null } },
          resume() { assert.equal(this.recovery, null, 'GPU recovery requires its exact ticket'); this.status = { ...this.status, suspended: false } }, retry() {},
          suspendOwnedSurface() {
            this.suspend()
            const ticket = Object.freeze({ owner: config.owner, index: calls.length })
            this.recovery = { ticket, resumed: false }; return Promise.resolve(ticket)
          },
          resumeOwnedSurface(ticket) {
            assert.equal(ticket, this.recovery?.ticket, 'native recovery cannot resume a retired ticket')
            this.recovery.resumed = true; this.status = { ...this.status, suspended: false }
          },
          async acknowledge() {
            const raw = this.latest.state, demand = { ...raw, owner: config.owner }
            const context = { owner: config.owner, attemptId: '1', surfaceGeneration: raw.surfaceGeneration, signal: new AbortController().signal, isCurrent: () => !this.closed }
            const candidate = await config.adapter.prepareTemplate(demand, context)
            const outcome = await config.adapter.present(candidate, { ...context, proof: candidate.proof })
            this.status = { ...this.status, accepted: { proof: candidate.proof, inputEnabled: outcome.inputEnabled } }
            config.onState(this.status); return outcome
          },
          close() { if (!this.closePromise) this.closePromise = (async () => { this.closed = true; await config.adapter.cancelOwnedWork('close'); await config.adapter.dispose(); return { closed: true } })(); return this.closePromise },
        }; schedulers.push(scheduler); return scheduler
      }, input() { return { reset() {}, dispose() {} } },
    } })
  function navigate(profile) {
      update({ rendererProfile: profile, declaredRendererProfile: profile, currentPage: { pageId: String(BigInt(state.currentPage.pageId) + 1n), path: profile === 'webview' ? 'pages/dom/index' : 'pages/skia/index' },
        transitionRequired: (profile === 'webview' ? 'browser-view' : 'external-frame') !== state.presenterBinding.transportBackend,
        inputLifetimeRevision: String(BigInt(state.inputLifetimeRevision) + 1n), surfaceGeneration: String(BigInt(state.surfaceGeneration) + 1n) })
      rpc.config.onEvent({ version: '1.0', workerEpoch: runtimeOwner.workerEpoch, sessionId: runtimeOwner.sessionId, kind: 'event', op: 'dirty',
        requestId: `worker-event-${++eventSequence}`, payload: { observation: observation() } })
  }
  return { session, root, unrelated, adapters, schedulers, leases, log, calls, handlers, batches, observation, update, transitionFinal,
    load: () => session.load({ indexSha256: pin, viewport: { width: 100, height: 50 }, rendererTransitions: { version: '1.0' } }),
    get rpc() { return rpc },
    navigate }
}
const cleanup = async value => { await value.session.close().catch(() => {}) }

test('visibility success callback failure faults the owner and keeps input disabled', async () => {
  const f = fixture(); try {
    await f.load(); await f.session.setVisible(false)
    const expected = failure('ERR_RENDER', 'resume callback failed')
    f.schedulers[0].resume = () => { throw expected }
    await assert.rejects(f.session.setVisible(true), error => error === expected)
    assert.equal(f.session.status.phase, 'faulted'); assert.equal(f.session.status.fault, expected)
    assert.equal(f.session.status.inputEnabled, false)
  } finally { await cleanup(f) }
})

test('show during successor attachment waits for the local visibility final even without a scheduler yet', async () => {
  const attached = deferred(), attachGate = deferred(), showFinal = deferred(), showEntered = deferred()
  const f = fixture({ beforeCanvasAttach: async () => { attached.resolve(); await attachGate.promise } })
  try {
    await f.load(); f.navigate('skia'); await attached.promise
    f.handlers.set('bridge', (payload, options) => {
      showEntered.resolve()
      return showFinal.promise.then(() => {
        options.onActualFinal?.({ version: '1.0', status: 'final', requestId: 'show-final' })
        return { observation: f.observation(), messages: [{ ...payload.envelope, kind: 'response', payload: { ok: true } }] }
      })
    })
    const showing = f.session.setVisible(true)
    assert.equal(f.session.status.phase, 'ready', 'a visibility call during attachment is a valid queued owner control')
    attachGate.resolve(); await showEntered.promise
    const successor = f.schedulers.at(-1)
    assert.equal(successor.status.suspended, true, 'a newly attached scheduler inherits the pending visibility fence')
    showFinal.resolve(); await showing
    assert.equal(successor.status.suspended, false); assert.equal(f.session.status.visible, true)
    await successor.acknowledge(); assert.equal(f.session.status.presenterTransition, null)
  } finally { attachGate.resolve(); showFinal.resolve(); await cleanup(f) }
})

test('show replaces both unresumed and resumed GPU recovery tickets with a fresh native fence', async t => {
  for (const hidden of [false, true]) await t.test(hidden ? 'awaiting while hidden' : 'resumed before presentation ACK', async () => {
    const f = fixture(); try {
      await f.load(); f.navigate('skia'); await tick(); await f.schedulers.at(-1).acknowledge()
      if (hidden) await f.session.setVisible(false)
      let recoveries = 0
      f.handlers.set('surface.recover', (payload, options) => {
        recoveries++
        const expected = payload.expected, renderRevision = String(BigInt(expected.renderRevision) + 1n), inputLifetimeRevision = String(BigInt(expected.inputLifetimeRevision) + 1n)
        const observation = f.update({ renderRevision, inputLifetimeRevision, surfaceGeneration: String(BigInt(expected.surfaceGeneration) + 1n) })
        options.onActualFinal?.({ version: '1.0', status: 'final', requestId: `recovery-${recoveries}` })
        return Promise.resolve({ observation, recovery: { version: '1.0', kind: 'retained', sessionId: runtimeOwner.sessionId,
          previousRenderRevision: expected.renderRevision, previousInputLifetimeRevision: expected.inputLifetimeRevision, renderRevision, inputLifetimeRevision } })
      })
      const adapter = f.adapters.at(-1), scheduler = f.schedulers.at(-1)
      adapter.config.onSurfaceLost({ version: '1.0', owner: adapter.owner, lossId: '1' }); await tick()
      assert.equal(f.session.status.surfaceRecovery.phase, 'awaiting-presentation')
      const oldTicket = scheduler.recovery.ticket
      assert.equal(scheduler.recovery.resumed, !hidden)
      await f.session.setVisible(true); await tick()
      assert.equal(recoveries, 2, 'visibility final starts a replacement native recovery')
      assert.notEqual(scheduler.recovery.ticket, oldTicket); assert.equal(scheduler.recovery.resumed, true)
      assert.equal(f.session.status.phase, 'ready'); assert.equal(f.session.status.surfaceRecovery.phase, 'awaiting-presentation')
    } finally { await cleanup(f) }
  })
})

test('explicit presenter transaction changes both families within one Worker/bridge/startup', async () => {
  const f = fixture(); try {
    await f.load(); const firstOwner = f.session.runtimeOwner, firstAdapter = f.adapters[0]
    assert.equal(f.calls[0].payload.rendererTransitions.version, '1.0'); assert.equal(f.calls[0].payload.externalPresentation.version, '1.0')
    f.navigate('skia'); assert.equal(f.session.status.inputEnabled, false); await tick()
    assert.equal(f.session.status.phase, 'ready'); assert.equal(f.session.owner.presenterGeneration, '2')
    assert.equal(f.session.owner.transportBackend, 'external-frame'); assert.equal(f.session.runtimeOwner, firstOwner)
    assert.equal(firstAdapter.disposals, 1); assert.equal(f.session.status.presenterTransition.phase, 'awaiting-presentation')
    const answer = await f.session.request('api.call', { name: 'business.timer.and.storage' }); assert.equal(answer.value, 'same-runtime')
    f.navigate('webview'); await tick()
    assert.equal(f.session.owner.presenterGeneration, '3'); assert.equal(f.session.owner.transportBackend, 'browser-view')
    await f.schedulers.at(-1).acknowledge(); assert.equal(f.session.status.presenterTransition, null)
    assert.equal(f.calls.filter(value => value.op === 'load').length, 1); assert.equal(f.rpc.closes, 0)
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 2)
    assert.equal(f.leases[0].disposals, 1)
  } finally { await cleanup(f) }
  assert.equal(f.rpc.closes, 1); assert.deepEqual(f.root.children, [f.unrelated])
})

test('retirement waits actual final after public timeout; old scopes cannot adopt new binding or send owner metrics', async () => {
  const f = fixture(); try {
    await f.load(); const old = f.adapters[0], entered = deferred(); let finish
    f.handlers.set('resource', (_payload, options) => { finish = () => options.onActualFinal({ version: '1.0', status: 'final', requestId: 'slow-resource' }); entered.resolve(); return Promise.reject(failure('ERR_RPC_TIMEOUT', 'public timeout')) })
    await assert.rejects(old.config.rpc.requestHost('resource', { sha256: pin }), { code: 'ERR_RPC_TIMEOUT' }); await entered.promise
    f.navigate('skia'); await tick(); assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 0)
    assert.equal(old.disposals, 0); finish(); await tick()
    assert.equal(f.session.owner.presenterGeneration, '2'); assert.equal(old.disposals, 1)
    const before = f.calls.length
    await assert.rejects(old.config.rpc.requestHost('resource', { sha256: pin }), { code: 'ERR_CANCELLED' })
    await assert.rejects(old.config.rpc.requestHost('metrics', { windowWidth: 1 }), { code: 'ERR_PROTOCOL_VERSION' })
    await assert.rejects(old.config.bridge.request('view.prepare', {}), { code: 'ERR_CANCELLED' })
    assert.equal(f.calls.length, before)
  } finally { await cleanup(f) }
})

test('local asset failure leaves business realm running; retry does not replay native transition or startup', async () => {
  const f = fixture({ assetsFail: 1 }); try {
    await f.load(); f.navigate('skia'); await tick()
    assert.equal(f.session.status.phase, 'ready'); assert.equal(f.session.status.presenterTransition.phase, 'blocked')
    assert.equal(f.session.status.inputEnabled, false)
    assert.equal((await f.session.request('api.call', { name: 'timer-still-runs' })).value, 'same-runtime')
    await f.session.retryRendererTransition(); assert.equal(f.session.owner.presenterGeneration, '2')
    assert.equal(f.calls.filter(value => value.op === 'load').length, 1)
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 1)
    assert.equal(f.adapters[0].disposals, 1)
  } finally { await cleanup(f) }
})

test('returned-to-old-family race blocks without inventing retirement and closes on actual sole Worker shutdown', async () => {
  const f = fixture(); await f.load()
  let finish
  f.handlers.set('resource', (_payload, options) => { finish = () => options.onActualFinal({ version: '1.0', status: 'final', requestId: 'race-resource' }); return Promise.reject(failure('ERR_RPC_TIMEOUT', 'public timeout')) })
  await assert.rejects(f.adapters[0].config.rpc.requestHost('resource', {}), { code: 'ERR_RPC_TIMEOUT' })
  f.navigate('skia'); await tick(); f.navigate('webview'); finish(); await tick()
  assert.equal(f.session.status.presenterTransition.phase, 'blocked'); assert.equal(f.adapters[0].disposals, 0)
  assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 0)
  await f.session.close(); assert.equal(f.rpc.closes, 1); assert.equal(f.adapters[0].disposals, 1)
})

test('native transition public timeout retains one operation until original late final', async () => {
  const f = fixture(); try {
    await f.load(); let complete
    f.handlers.set('renderer.transition', (_payload, options) => {
      complete = () => { const result = f.transitionFinal(); options.onLateResponse({ version: '1.0', workerEpoch: runtimeOwner.workerEpoch, sessionId: runtimeOwner.sessionId,
        requestId: 'late-native-transition', kind: 'response', op: 'renderer.transition', payload: { status: 'ok', result } }); options.onActualFinal({ version: '1.0', status: 'final', requestId: 'late-native-transition' }) }
      return Promise.reject(failure('ERR_RPC_TIMEOUT', 'public native timeout'))
    })
    f.navigate('skia'); await tick(); assert.equal(f.session.status.presenterTransition.phase, 'native')
    assert.equal(f.adapters[0].disposals, 0); complete(); await tick()
    assert.equal(f.session.owner.presenterGeneration, '2'); assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 1)
    assert.equal(f.batches.filter(value => value.messages.some(message => message.op === 'native.retirement')).length, 1)
  } finally { await cleanup(f) }
})


test('business navigation during initial presenter admission queues the same owner transaction before first scheduler observation', async () => {
  const entered = deferred(), release = deferred()
  const f = fixture({ beforeDomAttach: async owner => { entered.resolve(owner); await release.promise } })
  try {
    const loading = f.load(), owner = await entered.promise
    owner.navigate('skia')
    assert.equal(f.session.status.phase, 'loading'); assert.equal(f.session.observation.state.transitionRequired, true)
    release.resolve(); await loading; await tick()
    assert.equal(f.session.status.phase, 'ready'); assert.equal(f.session.status.requiresRestart, false)
    assert.equal(f.session.owner.presenterGeneration, '2'); assert.equal(f.session.owner.transportBackend, 'external-frame')
    assert.equal(f.schedulers[0].latest, null, 'old initial scheduler must never consume the pending family')
    assert.equal(f.calls.filter(value => value.op === 'load').length, 1)
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 1)
  } finally { release.resolve(); await cleanup(f) }
})

test('scoped actual-final contract emits exactly one not-posted receipt on local old-binding and owner-control rejection', async () => {
  const f = fixture(); try {
    await f.load(); const old = f.adapters[0], receipts = []
    await assert.rejects(old.config.rpc.requestHost('metrics', {}, { onActualFinal: receipt => receipts.push(receipt) }), { code: 'ERR_PROTOCOL_VERSION' })
    assert.deepEqual(receipts, [{ version: '1.0', status: 'not-posted', requestId: null }])
    f.navigate('skia'); await tick()
    await assert.rejects(old.config.rpc.requestHost('resource', {}, { onActualFinal: receipt => receipts.push(receipt) }), { code: 'ERR_CANCELLED' })
    assert.equal(receipts.length, 2); assert.equal(receipts[1].status, 'not-posted')
    const current = f.adapters.at(-1), before = f.calls.length
    f.handlers.set('resource', (_payload, options) => { options.onActualFinal({ version: '1.0', status: 'final', requestId: 'entered-final' }); return Promise.resolve({ observation: f.observation() }) })
    await current.config.rpc.requestHost('resource', {}, { onActualFinal: receipt => receipts.push(receipt) })
    assert.equal(f.calls.length, before + 1); assert.equal(receipts.length, 3); assert.equal(receipts[2].status, 'final')
  } finally { await cleanup(f) }
})


test('pending observation installs remote retirement before scheduler cancellation even while a prior owner control holds the serial lane', async () => {
  const f = fixture(); const metricsEntered = deferred(), releaseMetrics = deferred()
  try {
    await f.load(); const old = f.adapters[0], scheduler = f.schedulers[0], initialSuspend = scheduler.suspend.bind(scheduler)
    scheduler.suspend = reason => {
      if (reason === 'presenter-generation-retired') assert.ok(old.retirement && typeof old.retirement.then === 'function', 'DOM must own its real native retirement barrier before candidate cancellation')
      return initialSuspend(reason)
    }
    f.handlers.set('metrics', async (_payload, options) => { metricsEntered.resolve(); await releaseMetrics.promise; options.onActualFinal?.({ version: '1.0', status: 'final', requestId: 'held-metrics' }); return { messages: [], observation: f.observation() } })
    const resizing = f.session.setWindowMetrics({ windowWidth: 100, windowHeight: 50, pixelRatio: 1, screenWidth: 100, screenHeight: 50,
      statusBarHeight: 0, screenTop: 0, deviceOrientation: 'landscape' })
    await metricsEntered.promise
    f.navigate('skia')
    assert.ok(old.retirement, 'retirement must be installed synchronously, before held control is released')
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 0)
    releaseMetrics.resolve(); await resizing; await tick()
    assert.equal(f.session.status.requiresRestart, false); assert.equal(f.session.owner.presenterGeneration, '2')
  } finally { releaseMetrics.resolve(); await cleanup(f) }
})

test('unposted cancelled native transition terminates its transaction without waiting for an impossible late final', async () => {
  const f = fixture(); try {
    await f.load()
    f.handlers.set('renderer.transition', (_payload, options) => {
      options.onActualFinal({ version: '1.0', status: 'not-posted', requestId: null })
      return Promise.reject(failure('ERR_RPC_CANCELLED', 'admission cancelled before posting'))
    })
    f.navigate('skia'); await tick()
    assert.equal(f.session.status.presenterTransition.phase, 'blocked')
    assert.equal(f.session.status.presenterTransition.error.code, 'ERR_CANCELLED')
    assert.equal(f.session.status.requiresRestart, false); assert.equal(f.adapters[0].disposals, 0)
  } finally { await cleanup(f) }
  assert.equal(f.rpc.closes, 1)
})


test('failed canvas adapter factory releases its untransferred canvas and renderer lease before retry', async () => {
  const f = fixture({ canvasFactoryFail: 1 }); try {
    await f.load(); const mount = f.root.children.find(value => value !== f.unrelated)
    assert.equal(mount.children.filter(value => value.tag === 'canvas').length, 0)
    f.navigate('skia'); await tick()
    assert.equal(f.session.status.presenterTransition.phase, 'blocked')
    assert.equal(mount.children.filter(value => value.tag === 'canvas').length, 0, 'failed factory must not retain an empty owner-created canvas')
    assert.equal(f.leases[0].disposals, 1)
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 1)
    await f.session.retryRendererTransition()
    assert.equal(mount.children.filter(value => value.tag === 'canvas').length, 1)
    assert.equal(f.leases.length, 2); assert.equal(f.leases[1].disposals, 0)
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 1, 'local factory retry cannot replay a native transition')
    assert.equal(f.calls.filter(value => value.op === 'load').length, 1)
  } finally { await cleanup(f) }
  assert.equal(f.leases[1].disposals, 1); assert.deepEqual(f.root.children, [f.unrelated])
})

test('local not-posted actual-final callbacks must be synchronous and their async rejection remains observed', async () => {
  const f = fixture(); try {
    await f.load(); const old = f.adapters[0], rejected = new Error('invalid local async final callback')
    await assert.rejects(old.config.rpc.requestHost('metrics', {}, { onActualFinal: async () => { throw rejected } }), error => {
      assert.ok(error.errors.some(value => value.code === 'ERR_RPC_CALLBACK'))
      return true
    })
    await tick()
    const failures = f.session.status.diagnostics.filter(value => value.code === 'ERR_RPC_CALLBACK')
    assert.ok(failures.some(value => /must be synchronous/.test(value.message)))
    assert.ok(failures.some(value => value.cause === rejected))
  } finally { await cleanup(f) }
})


test('uncertain transferred-adapter cleanup retains its renderer byte charge and forbids replacement allocation', async () => {
  const f = fixture({ schedulerFactoryFail: 1, adapterDisposeFail: 1 }); try {
    await f.load(); f.navigate('skia'); await tick()
    assert.equal(f.session.status.phase, 'ready'); assert.equal(f.session.status.presenterTransition.phase, 'blocked')
    assert.equal(f.session.status.presenterTransition.cleanupUncertain, true)
    assert.equal(f.leases.length, 1); assert.equal(f.leases[0].disposals, 0, 'uncertain last use must not return the charged renderer/font lease')
    const assetsBefore = f.log.filter(value => value.startsWith('assets:')).length, adaptersBefore = f.adapters.length
    await assert.rejects(f.session.retryRendererTransition(), { code: 'ERR_RENDER' })
    assert.equal(f.leases[0].disposals, 0); assert.equal(f.adapters.length, adaptersBefore)
    assert.equal(f.log.filter(value => value.startsWith('assets:')).length, assetsBefore, 'retry cannot borrow another owner byte budget')
    assert.equal((await f.session.request('api.call', { name: 'business-still-runs' })).value, 'same-runtime')
    await assert.rejects(f.session.close(), /fixture destructor|cleanup is uncertain/)
    assert.equal(f.leases[0].disposals, 0, 'shutdown must retain an uncertain local resource charge rather than claim successful destruction')
    assert.equal(f.rpc.closes, 1)
  } finally { await cleanup(f) }
})


test('animation bridge operations inherit exact presenter context and actual-final retirement ownership', async () => {
  const f = fixture(); try {
    await f.load(); const adapter = f.adapters[0]
    const envelope = op => ({ protocolVersion: '1.0', sessionId: runtimeOwner.sessionId, requestId: `animation:${op}`, kind: 'request', op, payload: {} })
    for (const op of ['view.animation.baseline', 'view.sample.prepare', 'view.sample.presented']) {
      await adapter.config.rpc.requestHost('bridge', { envelope: envelope(op) })
      const request = f.calls.at(-1)
      assert.deepEqual(request.payload.presentationContext, { presenterBinding: binding(), pageId: '1', inputLifetimeRevision: '1', surfaceGeneration: '1' })
      assert.equal(typeof request.options.onActualFinal, 'function')
    }
    let actualFinal
    f.handlers.set('bridge', (_payload, options) => { actualFinal = options.onActualFinal; return Promise.reject(failure('ERR_RPC_TIMEOUT', 'sample prepare public timeout')) })
    await assert.rejects(adapter.config.rpc.requestHost('bridge', { envelope: envelope('view.sample.prepare') }), { code: 'ERR_RPC_TIMEOUT' })
    f.navigate('skia'); await tick()
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 0)
    actualFinal({ version: '1.0', status: 'final', requestId: 'native-sample-prepare' }); await tick()
    assert.equal(f.session.owner.presenterGeneration, '2')
    assert.equal(f.calls.filter(value => value.op === 'renderer.transition').length, 1)
  } finally { await cleanup(f) }
})

test('sample abort alias carries presenter context and completes its exact native actual-final scope', async () => {
  const f = fixture(); try {
    await f.load(); const adapter = f.adapters[0], key = { sessionId: runtimeOwner.sessionId, pageId: '1', documentRevision: '1',
      presentationRevision: '2', surfaceGeneration: '1', profile: 'webview' }
    f.handlers.set('view.sample.abort', (payload, options) => {
      options.onActualFinal({ version: '1.0', status: 'final', requestId: 'native-sample-abort' })
      return Promise.resolve({ messages: [{ protocolVersion: '1.0', sessionId: runtimeOwner.sessionId, requestId: 'native-sample-abort',
        kind: 'response', op: 'view.sample.abort', payload: { ok: true, version: '1.0', key: payload.key, aborted: true } }], observation: f.observation() })
    })
    const final = await adapter.config.bridge.request('view.sample.abort', { version: '1.0', key })
    assert.equal(final.aborted, true)
    const request = f.calls.find(value => value.op === 'view.sample.abort')
    assert.deepEqual(request.payload.presentationContext.presenterBinding, binding())
    f.navigate('skia'); await tick(); assert.equal(f.session.owner.presenterGeneration, '2')
  } finally { await cleanup(f) }
})
