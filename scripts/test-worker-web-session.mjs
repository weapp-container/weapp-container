/** Authored/unexecuted owner contracts. Fake RPC/adapters; no product/GPU claim. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { WorkerWebSession, WORKER_RENDER_SCALE_CONTRACT } from '../examples/hosts/web-wasm/worker-web-session.mjs'
import { WorkerBridgeTransport } from '../examples/hosts/web-wasm/worker-bridge-transport.mjs'
import { PresentationScheduler } from '../examples/hosts/web-wasm/presentation-scheduler.mjs'
import { AppliedInputTrace, INPUT_TIMING_CONTRACT } from '../examples/hosts/web-wasm/input-causal-ledger.mjs'
import { BrowserHostServices } from '../examples/hosts/web-wasm/browser-host-services.mjs'
import { WorkerHostServicesTransport } from '../examples/hosts/web-wasm/worker-host-services.mjs'
import { BrowserHostAccountManager } from '../examples/hosts/web-wasm/browser-host-account-manager.mjs'

const pin = 'a'.repeat(64), manifestPin = 'b'.repeat(64), rootPin = 'c'.repeat(64)
const route = 'pages/home/index'
const rect = (width = 100, height = 50) => ({ x: 0, y: 0, width, height })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = async () => { for (let index = 0; index < 24; index++) await Promise.resolve() }
const hasCode = (error, code, seen = new Set()) => {
  if (!error || typeof error !== 'object' || seen.has(error)) return false
  seen.add(error)
  return error.code === code || [...(error.errors ?? []), error.cause].some(value => hasCode(value, code, seen))
}
class Element {
  constructor(document, tag = 'div') { this.ownerDocument = document; this.tag = tag; this.children = []; this.attributes = new Map(); this.isConnected = false; this.events = new Map(); this.style = {} }
  append(child) { child.parent = this; child.isConnected = true; this.children.push(child) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(value => value !== this); this.isConnected = false }
  setAttribute(name, value) { this.attributes.set(name, value) }
  addEventListener(name, listener) { const entries = this.events.get(name) ?? new Set(); entries.add(listener); this.events.set(name, entries) }
  removeEventListener(name, listener) { this.events.get(name)?.delete(listener) }
}
function documentFixture() {
  const document = { hidden: false }
  document.createElement = tag => new Element(document, tag)
  const eventTarget = new Element(document)
  document.addEventListener = eventTarget.addEventListener.bind(eventTarget)
  document.removeEventListener = eventTarget.removeEventListener.bind(eventTarget)
  document.defaultView = new Element(document)
  return { document, root: document.createElement('section') }
}
function observation(owner, sequence = '1', changes = {}) {
  return { version: '1.0', sequence, state: { owner, sessionId: owner.sessionId, transportBackend: owner.transportBackend,
    surfaceGeneration: '1', inputLifetimeRevision: '1', templateRevision: '1', renderRevision: '0', viewRevision: '1',
    viewport: rect(), lifecycle: 'Active', rendererProfile: owner.transportBackend === 'browser-view' ? 'webview' : 'skia',
    declaredRendererProfile: owner.transportBackend === 'browser-view' ? 'webview' : 'skia', requiresRestart: false,
    currentPage: { pageId: '1', path: route }, ...changes } }
}
function environment(overrides = {}) {
  const { document, root } = documentFixture(), unrelated = document.createElement('p'); root.append(unrelated)
  const log = [], notices = [], adapterCalls = [], inputs = [], handlers = new Map(), calls = []
  const backend = overrides.backend ?? 'browser-view'
  const owner = Object.freeze({ workerEpoch: 'owner-epoch', sessionId: 'owner-session', packSha256: pin, transportBackend: backend })
  const admission = { version: '1.0', route, transportBackend: backend, rendererPolicy: { mode: 'manifest' },
    declaredProfile: backend === 'browser-view' ? 'webview' : 'skia', effectiveProfile: backend === 'browser-view' ? 'webview' : 'skia',
    provenance: { indexSha256: pin, manifestSha256: manifestPin, integrityRoot: rootPin } }
  let raw, adapterOptions, factoryCount = 0, scheduler
  let latest = observation(owner), eventSequence = 0
  const manifest = { app: {}, routes: [{ path: route }], styles: [], integrity: { root: rootPin } }
  const loadResult = () => ({ state: { ...latest.state }, capabilities: { quickjs: true }, manifest,
    renderer: backend, transportBackend: backend, viewport: rect(), pack: { ...admission.provenance, downloadedBytes: 1 },
    declaredProfile: admission.declaredProfile, effectiveProfile: admission.effectiveProfile, rendererPolicy: admission.rendererPolicy,
    observationContract: { version: '1.0', sequence: 'u64', surfaceGeneration: '1.0', inputLifetime: '1.0' },
    observation: latest, ...(backend === 'external-frame' ? { externalPresentation: { version: '1.0', consumedInput: '1.0', ackOutcome: '1.0', physicalTarget: '1.0' }, surfaceRecovery: { version: '1.0', retainedExternalFrame: '1.0' } } : {}) })
  const effect = (op, payload = {}) => ({ protocolVersion: '1.0', sessionId: owner.sessionId, requestId: '', kind: 'event', op, payload })
  const batch = (op, sequence = latest.sequence) => ({ messages: [effect(op)], observation: observation(owner, sequence) })
  const next = changes => { latest = observation(owner, (BigInt(latest.sequence) + 1n).toString(), { ...latest.state, ...changes }); return latest }
  const adapter = { canvas: null,
    setOwnerInputFence({ revision, blocked }) { return { version: '1.0', revision, blocked } },
    acceptsOwnerInput() { return false },
    receiveObservation(value) { log.push(`adapter.observe:${value.sequence}`) },
    prepareTemplate() { throw new Error('fake scheduler must not run a presentation') },
    preparePaint() { throw new Error('fake scheduler must not run a presentation') },
    present() { throw new Error('fake scheduler must not run a presentation') }, release() {},
    freezeInput(reason) { log.push(`adapter.freeze:${reason}`) },
    suspendOwnedSurface() { log.push('adapter.surface-suspend'); return Promise.resolve({ version: '1.0', owner, suspended: true }) },
    resumeOwnedSurface() { log.push('adapter.surface-resume'); return { version: '1.0', owner, readyForFreshSurface: true } },
    cancelOwnedWork() { log.push('adapter.cancel'); return Promise.resolve() },
    dispose() { log.push('adapter.dispose'); return Promise.resolve({ closed: true }) },
  }
  const options = { surfaceRoot: root, onBatch: value => { notices.push(value); log.push(`batch:${value.messages[0]?.op ?? 'empty'}`) },
    admitPack: async () => admission,
    loadRendererAssets: async () => ({ version: '1.0', owner, CanvasKit: {}, fontData: new ArrayBuffer(4), dispose() { log.push('assets.dispose'); return Promise.resolve() } }),
    requestFrame: () => { throw new Error('fake scheduler owns no RAF') }, cancelFrame() {},
    factories: {
      rpc(config) {
        factoryCount++
        raw = { config, workerEpoch: owner.workerEpoch, sessionId: owner.sessionId, actualFinalContract: '1.0', closes: 0,
          async requestHost(op, payload, requestOptions) {
            calls.push({ op, payload, options: requestOptions }); log.push(`rpc:${op}`)
            if (handlers.has(op)) return handlers.get(op)(payload, requestOptions)
            if (op === 'load') return { ...loadResult(), ...(payload.renderScale === undefined ? {}
              : { renderScaleContract: overrides.scaleReply === undefined ? WORKER_RENDER_SCALE_CONTRACT : overrides.scaleReply }),
              ...(payload.inputTiming === undefined ? {} : { inputTiming: overrides.inputTimingReply ?? INPUT_TIMING_CONTRACT }) }
            if (op === 'bridge') {
              const envelope = payload.envelope
              if (envelope.op === 'app.lifecycle') next({ lifecycle: envelope.payload.event === 'hide' ? 'Background' : 'Active',
                surfaceGeneration: (BigInt(latest.state.surfaceGeneration) + 1n).toString() })
              return { messages: [{ ...envelope, kind: 'response', payload: { ok: true, value: 'genuine-final' } }], observation: latest }
            }
            if (op === 'metrics') {
              next({ viewport: rect(payload.windowWidth, payload.windowHeight), surfaceGeneration: (BigInt(latest.state.surfaceGeneration) + 1n).toString() })
              return { messages: [effect('metrics.effect')], observation: latest }
            }
            if (op === 'scale') return { scale: payload.scale, state: next({ renderRevision: '1' }).state, observation: latest }
            if (op === 'surface.recover') {
              const previous = latest.state, renderRevision = String(BigInt(previous.renderRevision) + 1n)
              const inputLifetimeRevision = String(BigInt(previous.inputLifetimeRevision) + 1n)
              const recovery = { version: '1.0', kind: 'retained', sessionId: owner.sessionId,
                previousRenderRevision: previous.renderRevision, renderRevision,
                previousInputLifetimeRevision: previous.inputLifetimeRevision, inputLifetimeRevision }
              next({ renderRevision, inputLifetimeRevision, surfaceGeneration: String(BigInt(previous.surfaceGeneration) + 1n) })
              return { recovery, observation: latest }
            }
            throw new Error(`unexpected outer operation ${op}`)
          },
          close() { this.closes++; log.push('rpc.close'); return Promise.resolve({ closed: true }) },
        }
        return raw
      },
      bridge(config) {
        const bridge = new WorkerBridgeTransport(config), dispose = bridge.dispose.bind(bridge)
        bridge.dispose = () => { log.push('bridge.dispose'); return dispose() }; return bridge
      },
      domAdapter(config) { adapterOptions = config; adapterCalls.push('dom'); return adapter },
      canvasAdapter(config) { adapterOptions = config; adapter.canvas = config.canvas; adapterCalls.push('canvas'); return adapter },
      scheduler(config) {
        scheduler = { config, status: { phase: 'idle', accepted: null },
          observe(value) { log.push(`scheduler.observe:${value.sequence}`); this.latest = value },
          suspend() { log.push('scheduler.suspend'); this.status = { ...this.status, suspended: true, accepted: null } },
          resume() { log.push('scheduler.resume'); this.status = { ...this.status, suspended: false } },
          suspendOwnedSurface() { log.push('scheduler.surface-suspend'); this.status = { ...this.status, suspended: true, accepted: null }; return Promise.resolve({ version: '1.0', recoveryId: '1' }) },
          resumeOwnedSurface(ticket, recovery) { log.push('scheduler.surface-resume'); this.recoveryResume = { ticket, recovery }; this.status = { ...this.status, suspended: false }; return { resumed: true } },
          retry() { log.push('scheduler.retry') },
          async close() { log.push('scheduler.close'); await config.adapter.cancelOwnedWork('close'); await config.adapter.dispose(); return { closed: true } },
        }; return scheduler
      },
      input(canvas, config) {
        const input = { canvas, config, reset() { log.push('input.reset') }, dispose() { log.push('input.dispose') } }
        inputs.push(input); return input
      },
    },
    ...overrides.options,
  }
  options.factories = { ...options.factories, ...overrides.factories }
  if (overrides.defaultDomAdapter) delete options.factories.domAdapter
  const session = new WorkerWebSession(options)
  const load = extra => session.load({ workerUrl: './runtime-worker.mjs', indexUrl: './pack-index.json', indexSha256: pin,
    viewport: { width: 100, height: 50 }, ...extra })
  return { session, load, owner, admission, document, root, unrelated, adapter, adapterCalls, inputs, notices, log, calls, handlers, batch, effect,
    next, loadResult, get raw() { return raw }, get adapterOptions() { return adapterOptions }, get scheduler() { return scheduler },
    get factoryCount() { return factoryCount },
    emit(op, payload) { return raw.config.onEvent({ version: '1.0', workerEpoch: owner.workerEpoch, sessionId: owner.sessionId,
      kind: 'event', requestId: `worker-event-${++eventSequence}`, op, payload }) },
  }
}
const closeFaulted = async session => { await session.close().catch(error => assert.ok(error)) }

const nativeServices = { version: '1.0', trustedContext: true, ownerThreadCompletion: true }
function identityEnvironment() {
  const e = environment()
  e.handlers.set('load', () => ({ ...e.loadResult(), hostServices: nativeServices }))
  e.handlers.set('native.revoke', () => ({ revoked: true, cancellations: [], observation: e.next({ hostIdentityRevoked: true }) }))
  return e
}

test('normal identity revocation blocks old business finals and events but closes without a fatal failure', async () => {
  const e = identityEnvironment(), final = deferred(), revoke = deferred()
  await e.load()
  let envelope
  e.handlers.set('bridge', payload => { envelope = payload.envelope; return final.promise })
  const pending = e.session.request('api.call', { name: 'old-account' })
  const rejected = assert.rejects(pending, { code: 'ERR_CANCELLED' }); await tick()
  e.handlers.set('native.revoke', () => revoke.promise)
  const revoked = e.session.revokeHostIdentity()
  assert.equal(e.session.revokeHostIdentity(), revoked, 'concurrent retirement must share the native barrier')
  assert.equal(e.session.status.hostIdentityRevoked, true)
  assert.equal(e.session.status.runtimeReady, false)
  assert.equal(e.session.status.inputEnabled, false)
  assert.equal(e.session.status.fault, null)
  await assert.rejects(e.session.request('api.call', {}), { code: 'ERR_CANCELLED' })
  const notices = e.notices.length
  e.emit('batch', { messages: [e.effect('old-account-result')], phase: 'live', observation: e.next() })
  assert.equal(e.notices.length, notices, 'retired application effects reached a host business callback')
  final.resolve({ messages: [{ ...envelope, kind: 'response', payload: { ok: true, result: 'late-old-account' } }], observation: e.next() })
  await rejected
  revoke.resolve({ revoked: true, cancellations: [], observation: e.next({ hostIdentityRevoked: true }) })
  await revoked
  assert.equal(e.session.status.identityRevocation.phase, 'revoked')
  const closing = e.session.close(); assert.equal(e.session.close(), closing)
  assert.equal((await closing).workerClosed, true)
  assert.equal(e.raw.closes, 1)
})

test('close shares its barrier and waits the pending actual native identity retirement final', async () => {
  const e = identityEnvironment(), native = deferred()
  await e.load(); e.handlers.set('native.revoke', () => native.promise)
  const revoking = e.session.revokeHostIdentity(), closing = e.session.close()
  assert.equal(e.session.close(), closing)
  await tick(); assert.equal(e.raw.closes, 0, 'Worker close overtook the pending identity retirement')
  native.resolve({ revoked: true, cancellations: [], observation: e.next() })
  await revoking
  assert.equal((await closing).workerClosed, true)
  assert.equal(e.raw.closes, 1)
})

test('native identity revocation failure remains blocked and can retry its actual control operation', async () => {
  const e = identityEnvironment(), failure = new Error('native revocation temporarily failed')
  await e.load(); let attempts = 0
  e.handlers.set('native.revoke', () => { if (++attempts === 1) throw failure; return { revoked: true, cancellations: [], observation: e.next() } })
  await assert.rejects(e.session.revokeHostIdentity(), error => error === failure)
  assert.equal(e.session.status.identityRevocation.phase, 'failed')
  assert.equal(e.session.status.hostIdentityRevoked, true)
  await assert.rejects(e.session.request('api.call', {}), { code: 'ERR_CANCELLED' })
  await e.session.revokeHostIdentity()
  assert.equal(attempts, 2)
  assert.equal(e.session.status.identityRevocation.attempts, 2)
  assert.equal((await e.session.close()).workerClosed, true)
})

test('unresolved native revocation error and a pre-existing runtime fatal are retained by close', async () => {
  for (const fatalFirst of [false, true]) {
    const e = identityEnvironment(), failure = new Error('native revoke rejected'), fatal = new Error('actual runtime failure')
    await e.load()
    if (fatalFirst) e.raw.config.onFailure(fatal)
    e.handlers.set('native.revoke', () => { throw failure })
    await assert.rejects(e.session.revokeHostIdentity(), error => error === failure)
    await assert.rejects(e.session.close(), error => {
      const failures = error.errors ?? [error]
      assert.ok(failures.includes(failure))
      if (fatalFirst) assert.ok(failures.includes(fatal))
      return true
    })
    assert.equal(e.raw.closes, 1, 'real failure must not skip actual Worker teardown')
  }
})

test('normal revocation preserves an existing fatal even after the native revoke succeeds', async () => {
  const e = identityEnvironment(), fatal = new Error('real execution fault')
  await e.load(); e.raw.config.onFailure(fatal)
  await e.session.revokeHostIdentity()
  assert.equal(e.session.status.fault, fatal)
  await assert.rejects(e.session.close(), error => error === fatal || error.errors?.includes(fatal))
  assert.equal(e.raw.closes, 1)
})

const identityCatalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const identityApplication = { hostAppId: 'host', tenantId: 'tenant', publisherId: 'publisher', appId: 'app', environment: 'trial', version: '1', packRoot: rootPin }
function accountWorkerOwners({ nativeFailure = () => false, fileFailure = () => false } = {}) {
  const owners = []
  const createOwner = async ({ account, application }) => {
    const e = identityEnvironment(), transport = new WorkerHostServicesTransport(e.session)
    const services = new BrowserHostServices({ runtime: transport, catalog: identityCatalog,
      environment: { navigator: { onLine: true }, window: new EventTarget(), location: { origin: 'https://worker.test', href: 'https://worker.test/' },
        fetch, FormData, Blob, File, setTimeout, clearTimeout } })
    let revoke = null, nativeAttempts = 0, fileAttempts = 0
    e.handlers.set('native.revoke', () => { nativeAttempts++; if (nativeFailure(account)) throw new Error('native account retirement rejected'); return { revoked: true, cancellations: [], observation: e.next() } })
    const owner = { e, services,
      get nativeAttempts() { return nativeAttempts }, get fileAttempts() { return fileAttempts },
      revoke() { revoke ??= e.session.revokeHostIdentity(); void revoke.catch(() => {}) },
      async detachSurface() {},
      async close() { await services.close(); await e.session.close() },
      async start() {
        await services.configure({ application, account })
        await e.load({ hostServices: transport.configuration }); transport.activate({ hostServices: nativeServices })
        const closeFiles = services.files.close.bind(services.files)
        services.files.close = () => { fileAttempts++; if (fileFailure(account)) throw new Error('exact private file lease retained'); return closeFiles() }
      },
      async waitForPresentation() {},
      invoke(method, payload) { return e.session.request(method, payload) },
    }
    owners.push(owner); return owner
  }
  return { owners, createOwner }
}

test('public account manager can retire real Worker session/services composition and create the new account owner', async () => {
  const manager = new BrowserHostAccountManager({ principalId: 'alice', epoch: '1' }), f = accountWorkerOwners()
  const controller = manager.attach({ application: identityApplication, createOwner: f.createOwner })
  try {
    await controller.ready
    assert.equal((await manager.switchAccount({ principalId: 'bob', epoch: '2' })).status, 'complete')
    assert.equal(f.owners.length, 2)
    assert.equal(f.owners[0].e.raw.closes, 1)
    assert.equal(f.owners[0].e.session.status.hostIdentityRevoked, true)
    assert.equal(f.owners[0].e.session.status.fault, null)
    assert.equal(controller.state.inputEnabled, true)
  } finally { await controller.close() }
})

test('account replacement retries exact failed native revocation and resource release before creating another Worker', async () => {
  for (const kind of ['native', 'file']) {
    let failing = true
    const manager = new BrowserHostAccountManager({ principalId: 'alice', epoch: '1' }), f = accountWorkerOwners({
      nativeFailure: account => kind === 'native' && account.epoch === '1' && failing,
      fileFailure: account => kind === 'file' && account.epoch === '1' && failing,
    })
    const controller = manager.attach({ application: identityApplication, createOwner: f.createOwner })
    try {
      await controller.ready
      assert.equal((await manager.switchAccount({ principalId: 'bob', epoch: '2' })).status, 'failed', kind)
      assert.equal(f.owners.length, 1, 'a failed native/file retirement cannot authorize a new owner')
      assert.equal(f.owners[0].e.raw.closes, 0, 'retained service cleanup must precede Worker final release')
      assert.equal(controller.state.inputEnabled, false)
      failing = false
      assert.equal((await controller.retry()).phase, 'complete')
      assert.equal(f.owners.length, 2)
      assert.equal(f.owners[0].e.raw.closes, 1)
      if (kind === 'native') assert.ok(f.owners[0].nativeAttempts >= 2)
      else { assert.equal(f.owners[0].fileAttempts, 2); assert.equal(f.owners[0].nativeAttempts, 1) }
    } finally { failing = false; await controller.close() }
  }
})

test('read-only package API bytes preserve the admitted session without minting a new observation',async()=>{
  const e=environment();await e.load();const previous=e.session.observation
  e.handlers.set('native.api-resource',()=>({bytes:new Uint8Array([0,128,255]).buffer}))
  const result=await e.session.nativeHostServices('native.api-resource',{context:{sessionId:e.owner.sessionId,callId:'source'}})
  assert.deepEqual([...new Uint8Array(result.bytes)],[0,128,255]);assert.equal(e.session.status.fault,null);assert.equal(e.session.observation,previous)
  await e.session.close()
})
function surfaceEvent(e, canvas = e.adapter.canvas) {
  const state = e.session.observation.state
  const proof = { version: '1.0', owner: e.owner, attemptId: '1', surfaceGeneration: state.surfaceGeneration,
    consumedInput: { pageId: state.currentPage.pageId, routePath: state.currentPage.path,
      templateRevision: state.templateRevision, viewport: { ...state.viewport } },
    publication: { kind: 'external-frame', renderRevision: '1' } }
  return { canvas, target: { width: canvas.width, height: canvas.height }, proof,
    submission: { version: '1.0', status: 'submitted', owner: e.owner, attemptId: proof.attemptId,
      surfaceGeneration: proof.surfaceGeneration, renderRevision: proof.publication.renderRevision,
      viewport: { ...proof.consumedInput.viewport }, physicalSize: { width: canvas.width, height: canvas.height } } }
}
const rpcIdentity = owner => ({ workerEpoch: owner.workerEpoch, sessionId: owner.sessionId })
function assertCloseReceipt(receipt, owner, identity) {
  assert.equal(receipt.version, '1.0'); assert.equal(receipt.closed, true)
  assert.equal(receipt.workerClosed, true); assert.equal(receipt.ownedMountRemoved, true)
  assert.equal(receipt.owner, owner); assert.deepEqual(receipt.rpcIdentity, identity)
  assert.equal(Object.isFrozen(receipt), true)
  assert.throws(() => { receipt.owner = {} }, TypeError)
  if (owner !== null) {
    assert.equal(Object.isFrozen(receipt.owner), true)
    assert.throws(() => { receipt.owner.sessionId = 'rewritten-session' }, TypeError)
  }
  if (identity !== null) {
    assert.equal(Object.isFrozen(receipt.rpcIdentity), true)
    assert.throws(() => { receipt.rpcIdentity.workerEpoch = 'rewritten-worker' }, TypeError)
    assert.deepEqual(receipt.rpcIdentity, identity)
  } else {
    assert.equal(receipt.workerFinal, null)
    const transported = JSON.parse(JSON.stringify(receipt))
    assert.equal(Object.hasOwn(transported, 'workerFinal'), true)
    assert.equal(transported.workerFinal, null)
  }
}

test('one real bridge borrows observed RPC; DOM admission never opts into external presentation', async () => {
  const e = environment(); await e.load()
  assert.equal(e.factoryCount, 1); assert.equal(e.calls[0].op, 'load')
  assert.equal(e.calls[0].payload.externalPresentation, undefined)
  assert.equal(e.adapterOptions.bridge.rpc, e.adapterOptions.rpc)
  assert.equal(e.adapterOptions.onBatch, undefined)
  assert.equal(e.session.status.runtimeReady, true); assert.equal(e.session.status.inputEnabled, false)
  await e.session.close(); assert.deepEqual(e.root.children, [e.unrelated])
})

test('trusted execution allowances are copied into the same admitted owner load', async () => {
  const e = environment()
  const viewExecution = { batchTimeoutMs: 250 }, engineExecution = { turnTimeoutMs: 500, bootstrapTimeoutMs: 5000 }
  await e.load({ viewExecution, engineExecution })
  const load = e.calls.find(call => call.op === 'load').payload
  assert.deepEqual(load.viewExecution, viewExecution)
  assert.deepEqual(load.engineExecution, engineExecution)
  assert.notEqual(load.viewExecution, viewExecution)
  assert.notEqual(load.engineExecution, engineExecution)
  await e.session.close()
})

test('successful native final observes the outer original sequence before inner response/effect consumers', async () => {
  const e = environment(); await e.load(); e.log.length = 0
  e.next({ templateRevision: '2' })
  const result = await e.session.request('api.call', { name: 'test' })
  assert.equal(result.ok, true); assert.equal(result.value, 'genuine-final')
  assert.ok(e.log.indexOf('scheduler.observe:2') < e.log.indexOf('batch:api.call'))
  assert.equal(e.notices.filter(batch => batch.messages[0].op === 'api.call').length, 1)
  await e.session.close()
})

test('live events sharing a genuine unchanged observation still deliver separate batches exactly once', async () => {
  const e = environment(); await e.load(); e.log.length = 0
  const original = e.session.observation
  assert.equal(e.emit('batch', { ...e.batch('timer.one'), phase: 'live', observation: original }), undefined)
  e.emit('batch', { ...e.batch('timer.two'), phase: 'live', observation: original })
  assert.deepEqual(e.notices.map(value => value.messages[0].op), ['timer.one', 'timer.two'])
  assert.equal(e.session.observation.sequence, '1'); assert.equal(e.log.includes('scheduler.observe:1'), false)
  await e.session.close()
})

test('late stale response cannot overwrite newer Worker observation but keeps its genuine final', async () => {
  const e = environment(); await e.load()
  e.emit('dirty', { observation: e.next({ templateRevision: '3' }) })
  e.handlers.set('bridge', payload => ({ messages: [{ ...payload.envelope, kind: 'response', payload: { ok: true, original: true } }],
    observation: observation(e.owner, '1') }))
  const final = await e.session.request('api.call', {})
  assert.equal(final.original, true); assert.equal(e.session.observation.sequence, '2')
  await e.session.close()
})

test('startup events require phase startup before the initial negotiated observation', async () => {
  const gate = deferred(), e2 = environment({ options: { admitPack: () => gate.promise } })
  const waiting = e2.load(); await tick()
  e2.handlers.set('load', () => {
    e2.emit('batch', { messages: [e2.effect('app.init')], phase: 'startup' })
    return e2.loadResult()
  })
  gate.resolve(e2.admission); await waiting
  assert.equal(e2.notices[0].messages[0].op, 'app.init'); assert.equal(e2.session.status.phase, 'ready')
  e2.emit('batch', { messages: [e2.effect('late.startup')], phase: 'startup' })
  assert.equal(e2.session.status.phase, 'faulted'); await closeFaulted(e2.session)
})

test('missing live observation freezes before preserving genuine timer effects', async () => {
  const e = environment(); await e.load(); e.log.length = 0
  e.emit('batch', { messages: [e.effect('timer.committed')], phase: 'live' })
  assert.equal(e.session.status.phase, 'faulted')
  assert.ok(e.log.indexOf('adapter.freeze:owner-fault') < e.log.indexOf('batch:timer.committed'))
  assert.equal(e.notices.at(-1).messages[0].op, 'timer.committed')
  await closeFaulted(e.session)
})

test('malformed live observation still preserves its batch after faulting, never mints a sequence', async () => {
  const e = environment(); await e.load()
  e.emit('batch', { messages: [e.effect('timer.effect')], phase: 'live', observation: { version: '99' } })
  assert.equal(e.session.status.phase, 'faulted'); assert.equal(e.session.observation.sequence, '1')
  assert.equal(e.notices.at(-1).messages[0].op, 'timer.effect'); await closeFaulted(e.session)
})

test('nested real Worker fault preserves its original code, message, origin and details', async () => {
  const e = environment(); await e.load()
  const payload = { error: { code: 'ERR_TIMEOUT', message: 'entered timer exceeded turn budget' }, origin: 'timer', requiresRestart: true }
  e.emit('fault', payload)
  assert.equal(e.session.status.fault.code, 'ERR_TIMEOUT')
  assert.equal(e.session.status.fault.message, payload.error.message)
  assert.equal(e.session.status.fault.details.origin, 'timer')
  await closeFaulted(e.session)
})

test('late response observation is consumed before its original retired consumer', async () => {
  const e = environment(); await e.load()
  e.handlers.set('state', () => Promise.reject(Object.assign(new Error('request timed out'), { code: 'ERR_RPC_TIMEOUT' })))
  const seen = []
  await assert.rejects(e.adapterOptions.rpc.requestHost('state', {}, { onLateResponse: () => seen.push(e.session.observation.sequence) }), { code: 'ERR_RPC_TIMEOUT' })
  const retired = e.calls.at(-1)
  retired.options.onLateResponse({ version: '1.0', workerEpoch: e.owner.workerEpoch, sessionId: e.owner.sessionId,
    kind: 'response', requestId: 'original-retired-state-id', op: 'state', payload: { status: 'ok', result: { observation: e.next({ templateRevision: '2' }) } } })
  assert.deepEqual(seen, ['2'])
  await e.session.close()
})

test('actual cross-family navigation final remains successful while owner requires replacement', async () => {
  const e = environment(); await e.load()
  e.next({ rendererProfile: 'skia', declaredRendererProfile: 'skia', requiresRestart: true, inputLifetimeRevision: null })
  const final = await e.session.request('page.push', { path: 'pages/skia/index' })
  assert.equal(final.ok, true); assert.equal(e.session.status.requiresRestart, true)
  assert.equal(e.session.status.inputEnabled, false)
  assert.equal(e.calls.filter(call => call.op === 'load').length, 1)
  await closeFaulted(e.session)
})

test('finally-refresh failure preserves committed bridge evidence without resolving the failed inner request', async () => {
  const e = environment(); await e.load()
  e.handlers.set('bridge', payload => {
    const committedResult = { messages: [{ ...payload.envelope, kind: 'response', payload: { ok: true, committed: true } }] }
    throw Object.assign(new Error('observation refresh failed'), { code: 'ERR_ENGINE', details: {
      code: 'ERR_ENGINE', message: 'observation refresh failed', details: { committedResult,
        observationRefreshError: { code: 'ERR_ENGINE', message: 'refresh failed' } } } })
  })
  await assert.rejects(e.session.request('page.push', { path: route }), /observation refresh failed/)
  assert.equal(e.notices.at(-1).messages[0].payload.committed, true)
  assert.equal(e.session.status.phase, 'faulted')
  assert.equal(e.calls.filter(call => call.op === 'bridge').length, 1)
  await closeFaulted(e.session)
})

test('preflight/actual backend or provenance mismatch closes exact Worker, with no retry or adapter', async () => {
  const gate = deferred(), e = environment({ options: { admitPack: () => gate.promise } })
  const loading = e.load(); const failed = assert.rejects(loading, error => hasCode(error, 'ERR_PROTOCOL_VERSION'))
  await tick()
  e.handlers.set('load', () => ({ ...e.loadResult(), pack: { ...e.admission.provenance, indexSha256: 'd'.repeat(64) } }))
  gate.resolve(e.admission); await failed
  assert.equal(e.adapterOptions, undefined); assert.equal(e.raw.closes, 1)
  assert.equal(e.calls.filter(call => call.op === 'load').length, 1)
})

test('V8 and software requests fail explicitly before any Worker/application is created', async () => {
  const v8 = environment(); await assert.rejects(v8.load({ engine: 'v8' }), error => hasCode(error, 'ERR_ENGINE'))
  assert.equal(v8.factoryCount, 0)
  const software = environment(); await assert.rejects(software.load({ renderer: 'software' }), error => hasCode(error, 'ERR_UNSUPPORTED_CAPABILITY'))
  assert.equal(software.factoryCount, 0)
})

test('physical scale uses the exact Worker scale path, preserves simulated metrics and never sends template render', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  assert.deepEqual(e.calls[0].payload.externalPresentation, { version: '1.0' })
  await e.session.setRenderScale(2)
  await e.session.setLogicalViewport({ width: 110, height: 60 })
  const metrics = e.calls.find(call => call.op === 'metrics').payload
  assert.equal(metrics.pixelRatio, 1); assert.equal(metrics.windowWidth, 110)
  assert.equal(e.calls.some(call => ['frame', 'render.commit'].includes(call.op)), false)
  await e.session.close()
})

test('DOM density is not mislabeled as external-frame scale', async () => {
  const e = environment(); await e.load()
  await assert.rejects(e.session.setRenderScale(2), { code: 'ERR_UNSUPPORTED_CAPABILITY' })
  assert.equal(e.calls.some(call => call.op === 'scale'), false)
  await e.session.close()
})

test('initial fixed and auto density reach Worker without rewriting logical viewport or pixelRatio', async () => {
  for (const [requested, dpr, expected] of [[2, 1, 2], ['auto', 3, 3], ['auto', 1.5, 1.5], ['auto', 0.8, 0.8]]) {
    const e = environment({ backend: 'external-frame' })
    e.document.defaultView.devicePixelRatio = dpr
    await e.load({ renderScale: requested, metrics: { windowWidth: 100, windowHeight: 50, pixelRatio: 1.25,
      screenWidth: 100, screenHeight: 50, statusBarHeight: 0, screenTop: 0, deviceOrientation: 'landscape' } })
    const load = e.calls.find(call => call.op === 'load').payload
    assert.equal(load.renderScale, expected)
    assert.deepEqual(load.viewport, { width: 100, height: 50 })
    assert.equal(load.metrics.pixelRatio, 1.25, 'accepted host density must reach the pre-init native load')
    assert.equal(e.calls.find(call => call.op === 'metrics').payload.pixelRatio, 1.25)
    assert.equal(e.calls.some(call => call.op === 'scale'), false, 'initial scale belongs to atomic Worker frame export')
    await e.session.close()
  }
})

test('initial observed metrics are copied into preflight and never replaced by layout defaults', async () => {
  const observed = { windowWidth: 100, windowHeight: 50, pixelRatio: 2.75,
    screenWidth: 393, screenHeight: 873, statusBarHeight: 24, screenTop: 0, deviceOrientation: 'portrait' }
  const admission = deferred(), e = environment({ options: { admitPack: () => admission.promise } }), original = structuredClone(observed)
  try {
    const loading = e.load({ metrics: observed }); await tick(); observed.pixelRatio = 9
    admission.resolve(e.admission)
    await loading
    assert.deepEqual(e.calls.find(call => call.op === 'load').payload.metrics, original)
    assert.equal(e.calls[0].op, 'load')
  } finally { await closeFaulted(e.session) }
  const noObservation = environment()
  try {
    await noObservation.load()
    assert.equal(Object.hasOwn(noObservation.calls.find(call => call.op === 'load').payload, 'metrics'), false,
      'a local layout fallback must not impersonate a real display observation')
  } finally { await closeFaulted(noObservation.session) }
})

test('fresh owners after preflight failure use fresh host metrics without inheriting the failed observation', async () => {
  const observed = pixelRatio => ({ windowWidth: 100, windowHeight: 50, pixelRatio,
    screenWidth: 1440, screenHeight: 900, statusBarHeight: 0, screenTop: 0, deviceOrientation: 'landscape' })
  const failed = environment()
  failed.handlers.set('load', () => { throw new Error('preflight failed') })
  await assert.rejects(failed.load({ metrics: observed(1.25) }), /preflight failed/)
  await closeFaulted(failed.session)
  assert.equal(failed.raw.closes, 1)
  const replacement = environment()
  try {
    await replacement.load({ metrics: observed(2.75) })
    assert.equal(replacement.calls.find(call => call.op === 'load').payload.metrics.pixelRatio, 2.75)
    assert.equal(failed.calls.find(call => call.op === 'load').payload.metrics.pixelRatio, 1.25)
  } finally { await closeFaulted(replacement.session) }
})

test('invalid initial density is rejected without Worker creation and DOM never ignores density', async () => {
  for (const renderScale of [null, 0, 5, '2', 1.25, 1.75, 2.5]) {
    const e = environment({ backend: 'external-frame' })
    await assert.rejects(e.load({ renderScale }), error => hasCode(error, 'ERR_RENDER'))
    assert.equal(e.factoryCount, 0)
  }
  const e = environment()
  await assert.rejects(e.load({ renderScale: 2 }), error => hasCode(error, 'ERR_UNSUPPORTED_CAPABILITY'))
  assert.equal(e.calls.some(call => call.op === 'load'), false)
})

test('captured auto preserves fractional density without sampling the replacement preview', async () => {
  for (const [displayDensity, effectiveScale] of [[1.25, 1.25], [1.75, 1.75], [3, 3], [0.8, 0.8]]) {
    const e = environment({ backend: 'external-frame' })
    Object.defineProperty(e.document.defaultView, 'devicePixelRatio', { get() { throw Error('captured density must not be sampled again') } })
    await e.load({ renderScale: { version: '1.0', mode: 'captured-auto', requested: 'auto', displayDensity, effectiveScale } })
    const load = e.calls.find(call => call.op === 'load').payload
    assert.equal(load.renderScale, effectiveScale)
    assert.deepEqual(load.renderScaleContract, { version: '1.0' })
    assert.equal(e.calls.some(call => call.op === 'scale'), false)
    await e.session.close()
  }
})

test('captured auto rejects unknown shape, invalid density and inconsistent density before creating a Worker', async () => {
  const valid = { version: '1.0', mode: 'captured-auto', requested: 'auto', displayDensity: 1.25, effectiveScale: 1.25 }
  for (const renderScale of [{ ...valid, version: '2.0' }, { ...valid, mode: 'auto' }, { ...valid, extra: true },
    { ...valid, displayDensity: 0 }, { ...valid, displayDensity: Infinity }, { ...valid, effectiveScale: 1.5 },
    { ...valid, displayDensity: 3, effectiveScale: 2 }, { ...valid, requested: 1.25 },
    { ...valid, displayDensity: NaN }, { ...valid, effectiveScale: NaN }]) {
    const e = environment({ backend: 'external-frame' })
    const code = Number.isFinite(renderScale.displayDensity) && Number.isFinite(renderScale.effectiveScale) ? 'ERR_RENDER' : 'ERR_RPC_ARGUMENT'
    await assert.rejects(e.load({ renderScale }), error => hasCode(error, code))
    assert.equal(e.factoryCount, 0)
  }
})

test('old or differently negotiated Worker scale semantics fail before creating a presenter', async () => {
  for (const scaleReply of [null, { version: '0.9' }, { ...WORKER_RENDER_SCALE_CONTRACT, startup: 'after-export' },
    { ...WORKER_RENDER_SCALE_CONTRACT, extra: true }]) {
    const e = environment({ backend: 'external-frame', scaleReply })
    await assert.rejects(e.load({ renderScale: 2 }), error => hasCode(error, 'ERR_PROTOCOL_VERSION'))
    assert.deepEqual(e.adapterCalls, [])
    assert.equal(e.raw.closes, 1)
  }
})

test('metrics input fence begins immediately and retained error observation never rolls coordinates back', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  const pending = deferred()
  e.handlers.set('metrics', () => pending.promise)
  const resizing = e.session.setLogicalViewport({ width: 200, height: 80 })
  const failed = assert.rejects(resizing, /resize callback failed/)
  assert.equal(e.session.status.metricsPending, 1); assert.equal(e.session.status.inputEnabled, false)
  await tick()
  pending.reject(Object.assign(new Error('resize callback failed'), { code: 'ERR_ENGINE', details: {
    code: 'ERR_ENGINE', message: 'resize callback failed', observation: e.next({ viewport: rect(200, 80), surfaceGeneration: '2' }) } }))
  await failed
  assert.equal(e.session.observation.state.viewport.width, 200); assert.equal(e.session.status.phase, 'faulted')
  assert.equal(e.session.status.metricsPending, 0); await closeFaulted(e.session)
})

test('surface input explicitly maps logical coordinates and rebind disposes only its previous helper', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  const first = e.adapterOptions.canvas
  e.adapterOptions.onSurface(surfaceEvent(e, first))
  assert.deepEqual(e.inputs[0].config.logicalSize(), { width: 100, height: 50 })
  const second = e.document.createElement('canvas'); second.width = 400; second.height = 200; e.adapter.canvas = second
  e.adapterOptions.onSurface(surfaceEvent(e, second))
  assert.deepEqual(second.style, { width: '100px', height: '50px', maxWidth: 'none', maxHeight: 'none' })
  assert.equal(second.width, 400); assert.equal(second.height, 200)
  assert.equal(e.inputs.length, 2)
  assert.equal(e.log.filter(entry => entry === 'input.dispose').length, 1)
  assert.deepEqual(e.inputs[1].config.logicalSize(), { width: 100, height: 50 })
  assert.equal(e.inputs[1].config.active(), false)
  await e.session.close()
})

test('optional causal input ledger follows the real owner bridge sideband and separate frame stages', async () => {
  let now = 10
  const e = environment({ backend: 'external-frame', options: { inputTiming: { version: '1.0' }, inputTimingClock: () => now } })
  await e.load(); const surface = surfaceEvent(e); e.adapterOptions.onSurface(surface)
  e.scheduler.status = { phase: 'presented', accepted: { proof: surface.proof, inputEnabled: true } }
  e.adapterOptions.onInput({ enabled: true, owner: e.owner, canvas: e.adapter.canvas, surfaceGeneration: '1',
    publication: surface.proof.publication, consumedInput: surface.proof.consumedInput })
  const helper = e.inputs[0].config
  const sampleId = helper.inputTiming.capture({ type: 'pointerup', nativeTimeStamp: 9, isTrusted: true })
  helper.inputTiming.queued([sampleId])
  const workerTrace = new AppliedInputTrace({ sessionId: e.owner.sessionId, clock: () => 1000000 })
  e.handlers.set('bridge', payload => {
    assert.deepEqual(payload.inputTiming, { version: '1.0', sampleIds: [sampleId] })
    assert.deepEqual(payload.envelope.payload, { events: [{ type: 'tap', x: 1, y: 2 }] })
    const before = e.session.observation.state, observation = e.next({ templateRevision: '2', viewRevision: '2' }), after = observation.state
    const inputTiming = workerTrace.applied({ sampleIds: [sampleId], requestId: 'actual-outer-7', innerRequestId: payload.envelope.requestId,
      before, after, ok: true })
    return { messages: [{ ...payload.envelope, kind: 'response', payload: { ok: true } }], observation, inputTiming }
  })
  now = 15; await helper.send([{ type: 'tap', x: 1, y: 2 }], e.owner.sessionId, '1', { version: '1.0', sampleIds: [sampleId] })
  const p = { ...surface.proof, attemptId: '2', publication: { kind: 'external-frame', renderRevision: '2' },
    consumedInput: { ...surface.proof.consumedInput, templateRevision: '2' } }
  const fact = { proof: p, inputTiming: workerTrace.clone(p.consumedInput), physicalSize: { width: 200, height: 100 } }
  now = 20; e.adapterOptions.onTiming({ stage: 'clone', ...fact })
  now = 21; e.adapterOptions.onTiming({ stage: 'submitted', ...fact })
  now = 22; e.adapterOptions.onTiming({ stage: 'visible-swap', ...fact })
  now = 24; e.adapterOptions.onTiming({ stage: 'runtime-ack', ...fact })
  const report = e.session.inputTiming
  assert.equal(report.samples[0].applied.requestId, 'actual-outer-7')
  assert.equal(report.frames[0].runtimeAckReceivedAt, 24)
  assert.equal(report.candidates[0].durationsMs['runtime-ack-received'], 14)
  assert.equal(report.gate.status, 'blocked'); assert.equal(report.gate.inputToPresentP95Ms, null)
  await e.session.close(); assert.equal(e.session.inputTiming.retired, true)
})

test('causal diagnostics are opt-in and reject unsupported profiles and unknown negotiation', async () => {
  const legacy = environment({ backend: 'external-frame' }); await legacy.load()
  assert.equal(legacy.session.inputTiming, null)
  assert.equal(Object.hasOwn(legacy.calls.find(call => call.op === 'load').payload, 'inputTiming'), false)
  await legacy.session.close()
  const dom = environment({ options: { inputTiming: { version: '1.0' } } })
  await assert.rejects(dom.load(), error => hasCode(error, 'ERR_UNSUPPORTED_CAPABILITY'))
  const old = environment({ backend: 'external-frame', options: { inputTiming: { version: '1.0' } }, inputTimingReply: { version: '0.9' } })
  await assert.rejects(old.load(), error => hasCode(error, 'ERR_PROTOCOL_VERSION'))
})

test('external input stays pending until the scheduler accepts the exact installed proof', async t => {
  for (const mismatch of ['pending', 'owner', 'attempt', 'publication', 'generation', 'consumed-input', 'disabled']) await t.test(mismatch, async () => {
    const notices = [], states = []
    const e = environment({ backend: 'external-frame', options: { onInput: value => notices.push(value), onState: value => states.push(value) } })
    await e.load()
    const surface = surfaceEvent(e), proof = structuredClone(surface.proof)
    e.adapterOptions.onSurface(surface)
    const authority = { enabled: true, owner: e.owner, canvas: e.adapter.canvas,
      surfaceGeneration: proof.surfaceGeneration, publication: proof.publication, consumedInput: proof.consumedInput }
    if (mismatch !== 'pending') {
      const accepted = { proof: structuredClone(proof), inputEnabled: true }
      if (mismatch === 'owner') accepted.proof.owner.workerEpoch = 'another-epoch'
      if (mismatch === 'attempt') accepted.proof.attemptId = '2'
      if (mismatch === 'publication') accepted.proof.publication.renderRevision = '2'
      if (mismatch === 'generation') accepted.proof.surfaceGeneration = '2'
      if (mismatch === 'consumed-input') accepted.proof.consumedInput.templateRevision = '2'
      if (mismatch === 'disabled') accepted.inputEnabled = false
      e.scheduler.status = { phase: 'idle', accepted }
    }
    e.adapterOptions.onInput(authority)
    assert.equal(e.session.status.inputEnabled, false, 'adapter/native ACK alone cannot authorize public input')
    assert.equal(e.inputs[0].config.active(), false)
    assert.equal(notices.at(-1).enabled, false)
    assert.equal(states.some(value => value.inputEnabled), false)
    e.scheduler.status = { phase: 'idle', accepted: { proof: structuredClone(proof), inputEnabled: true } }
    e.scheduler.config.onState(e.scheduler.status)
    assert.equal(e.session.status.inputEnabled, true)
    assert.equal(e.inputs[0].config.active(), true)
    assert.equal(notices.at(-1).enabled, true, 'scheduler acceptance promotes the retained genuine authority')
    assert.deepEqual(states.at(-1).presentation.accepted.proof, surface.proof)
    e.scheduler.config.onState(e.scheduler.status)
    assert.equal(notices.filter(value => value.enabled).length, 1, 'unchanged status does not duplicate authority promotion')
    e.scheduler.status = { phase: 'preparing', accepted: null }
    e.scheduler.config.onState(e.scheduler.status)
    assert.equal(e.session.status.inputEnabled, false)
    assert.equal(notices.at(-1).enabled, false)
    await e.session.close()
  })
})

test('external adapter authority must match the installed publication and consumed input', async t => {
  for (const mismatch of ['publication', 'template', 'page', 'viewport', 'canvas']) await t.test(mismatch, async () => {
    const e = environment({ backend: 'external-frame' }); await e.load()
    const surface = surfaceEvent(e)
    e.adapterOptions.onSurface(surface)
    e.scheduler.status = { phase: 'idle', accepted: { proof: structuredClone(surface.proof), inputEnabled: true } }
    const authority = { enabled: true, owner: e.owner, canvas: e.adapter.canvas,
      surfaceGeneration: surface.proof.surfaceGeneration, publication: structuredClone(surface.proof.publication),
      consumedInput: structuredClone(surface.proof.consumedInput) }
    if (mismatch === 'publication') authority.publication.renderRevision = '2'
    if (mismatch === 'template') authority.consumedInput.templateRevision = '2'
    if (mismatch === 'page') authority.consumedInput.pageId = '2'
    if (mismatch === 'viewport') authority.consumedInput.viewport.width = 101
    if (mismatch === 'canvas') authority.canvas = e.document.createElement('canvas')
    e.adapterOptions.onInput(authority)
    assert.equal(e.session.status.inputEnabled, false)
    await e.session.close()
  })
})

test('real scheduler accepts the adapter ACK before publishing an input-enabled owner state', async () => {
  const final = deferred(), notices = [], states = [], frames = []
  let scheduler, inPresent = false
  const e = environment({ backend: 'external-frame', options: {
    onInput: value => notices.push(value), onState: value => states.push(value),
    requestFrame(callback) { frames.push(callback); return frames.length },
  }, factories: { scheduler: config => { scheduler = new PresentationScheduler(config); return scheduler } } })
  e.adapter.prepareTemplate = (_demand, context) => ({ ...surfaceEvent(e),
    proof: { ...surfaceEvent(e).proof, attemptId: context.attemptId } })
  e.adapter.present = async candidate => {
    inPresent = true
    e.adapterOptions.onSurface(candidate)
    e.adapterOptions.onInput({ enabled: true, owner: e.owner, canvas: candidate.canvas,
      surfaceGeneration: candidate.proof.surfaceGeneration, publication: candidate.proof.publication,
      consumedInput: candidate.proof.consumedInput })
    await final.promise
    return { acknowledged: true, publication: candidate.proof.publication, inputEnabled: true }
  }
  try {
    await e.load(); await tick()
    // Worker preparation starts before RAF; the sole RAF installs its result.
    assert.equal(frames.length, 1); frames.shift()(20); await tick()
    assert.equal(inPresent, true)
    assert.equal(scheduler.status.accepted, null)
    assert.equal(e.session.status.inputEnabled, false)
    assert.equal(notices.at(-1).enabled, false)
    final.resolve(); await tick()
    assert.equal(e.session.status.inputEnabled, true)
    assert.equal(notices.at(-1).enabled, true)
    assert.ok(states.some(value => value.inputEnabled))
    for (const state of states.filter(value => value.inputEnabled)) {
      assert.equal(state.presentation.accepted.inputEnabled, true)
      assert.deepEqual(state.presentation.accepted.proof, scheduler.status.accepted.proof)
    }
  } finally { final.resolve(); await e.session.close() }
})

test('submission is observational and remains bound to its exact original owner and proof', async t => {
  for (const field of ['owner', 'attemptId', 'surfaceGeneration', 'renderRevision', 'viewport', 'physicalSize']) await t.test(field, async () => {
    const seen = [], e = environment({ backend: 'external-frame', options: { onSurface: value => seen.push(value) } }); await e.load()
    try {
      const value = surfaceEvent(e)
      if (field === 'owner') value.submission.owner = { ...e.owner, sessionId: 'other-session' }
      else if (field === 'viewport') value.submission.viewport = rect(99, 50)
      else if (field === 'physicalSize') value.submission.physicalSize.width++
      else value.submission[field] = '99'
      assert.throws(() => e.adapterOptions.onSurface(value), { code: 'ERR_PROTOCOL_VERSION' })
      assert.equal(seen.length, 0); assert.equal(e.inputs.length, 0); assert.equal(e.session.status.inputEnabled, false)
      assert.deepEqual(e.session.owner, e.owner)
    } finally { await e.session.close() }
    assert.equal(e.raw.closes, 1); assert.deepEqual(e.root.children, [e.unrelated])
  })
})

test('retired page, viewport and generation never propagate submission or replace the current helper', async t => {
  const changes = [
    ['page', { currentPage: { pageId: '2', path: 'pages/next/index' } }],
    ['viewport', { viewport: rect(200, 100) }], ['surface generation', { surfaceGeneration: '2' }],
  ]
  for (const [name, change] of changes) await t.test(name, async () => {
    const seen = [], e = environment({ backend: 'external-frame', options: { onSurface: value => seen.push(value) } }); await e.load()
    const original = surfaceEvent(e)
    e.adapterOptions.onSurface(original)
    e.emit('dirty', { observation: e.next(change) })
    const before = e.log.filter(value => value === 'input.dispose').length
    e.adapterOptions.onSurface(original)
    assert.equal(seen.length, 1); assert.equal(e.inputs.length, 1)
    assert.equal(e.log.filter(value => value === 'input.dispose').length, before)
    assert.equal(e.session.status.inputEnabled, false)
    await e.session.close(); assert.equal(e.raw.closes, 1); assert.deepEqual(e.session.owner, e.owner)
  })
})

test('soft dirty revisions preserve genuine in-flight submission without granting input authority', async () => {
  const seen = [], e = environment({ backend: 'external-frame', options: { onSurface: value => seen.push(value) } }); await e.load()
  const original = surfaceEvent(e)
  e.emit('dirty', { observation: e.next({ templateRevision: '2', renderRevision: '2' }) })
  e.adapterOptions.onSurface(original)
  assert.equal(seen[0], original); assert.equal(e.inputs.length, 1); assert.equal(e.session.status.inputEnabled, false)
  await e.session.close()
})

test('late surface after close remains adapter-owned and cannot recreate a helper or observer call', async () => {
  const seen = [], e = environment({ backend: 'external-frame', options: { onSurface: value => seen.push(value) } }); await e.load()
  const original = surfaceEvent(e), owner = e.session.owner
  await e.session.close()
  assert.doesNotThrow(() => e.adapterOptions.onSurface(original))
  assert.equal(seen.length, 0); assert.equal(e.inputs.length, 0); assert.equal(e.session.owner, owner)
  assert.equal(e.raw.closes, 1); assert.deepEqual(e.root.children, [e.unrelated])
})

test('surface observer reentrant close retains its original owner and input-helper cleanup', async () => {
  let closing, seen
  const e = environment({ backend: 'external-frame', options: { onSurface(value) { seen = value.submission; closing = e.session.close() } } })
  await e.load(); const original = surfaceEvent(e), owner = e.session.owner
  e.adapterOptions.onSurface(original); await closing
  assert.equal(seen, original.submission); assert.equal(e.session.owner, owner)
  assert.equal(e.log.filter(value => value === 'input.dispose').length, 1); assert.equal(e.raw.closes, 1)
  assert.equal(e.session.status.inputEnabled, false); assert.deepEqual(e.root.children, [e.unrelated])
})

test('throwing surface observer retains helper ownership until explicit close', async () => {
  const e = environment({ backend: 'external-frame', options: { onSurface() { throw new Error('surface observer broke') } } }); await e.load()
  assert.throws(() => e.adapterOptions.onSurface(surfaceEvent(e)), /surface observer broke/)
  assert.equal(e.inputs.length, 1); assert.equal(e.session.status.inputEnabled, false)
  await e.session.close()
  assert.equal(e.log.filter(value => value === 'input.dispose').length, 1); assert.equal(e.raw.closes, 1)
})

test('hide revokes local input synchronously and show uses genuine lifecycle, not fabricated ACK', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  const hidden = e.session.setVisible(false)
  assert.equal(e.session.status.visible, false); assert.equal(e.session.status.inputEnabled, false)
  await hidden; assert.equal(e.session.observation.state.lifecycle, 'Background')
  await e.session.setVisible(true); assert.equal(e.session.observation.state.lifecycle, 'Active')
  assert.equal(e.session.status.inputEnabled, false)
  await e.session.close()
})

test('early close while pure admission is pending cannot execute application load afterward', async () => {
  const gate = deferred(), e = environment({ options: { admitPack: () => gate.promise } })
  const loading = e.load(), failed = assert.rejects(loading, error => hasCode(error, 'ERR_CANCELLED'))
  await tick(); const closing = e.session.close(); assert.equal(e.session.close(), closing)
  assert.equal(e.session.owner, null); assert.equal(e.factoryCount, 1)
  let settled = false; void closing.then(() => { settled = true })
  await tick(); assert.equal(settled, false); assert.equal(e.raw.closes, 0)
  // The receipt names the captured observed RPC, not mutable raw factory state.
  e.raw.workerEpoch = 'mutated-raw-worker'; e.raw.sessionId = 'mutated-raw-session'
  gate.resolve(e.admission); const receipt = await closing; await failed
  assertCloseReceipt(receipt, null, rpcIdentity(e.owner))
  assert.equal(e.session.close(), closing); assert.equal(await e.session.close(), receipt)
  assert.equal(e.calls.length, 0); assert.equal(e.raw.closes, 1)
  assert.deepEqual(e.root.children, [e.unrelated])
})

test('new owner closed without load has no pack owner or RPC identity and keeps one final barrier', async () => {
  const e = environment(), closing = e.session.close()
  assert.equal(e.session.close(), closing)
  const receipt = await closing
  assertCloseReceipt(receipt, null, null)
  assert.equal(e.session.close(), closing); assert.equal(await e.session.close(), receipt)
  assert.equal(e.factoryCount, 0); assert.equal(e.raw, undefined); assert.equal(e.calls.length, 0)
  assert.deepEqual(e.root.children, [e.unrelated])
  await assert.rejects(e.load(), error => hasCode(error, 'ERR_CANCELLED'))
  assert.equal(e.factoryCount, 0)
})

test('close before scheduled load initialization starts creates neither RPC nor application owner', async () => {
  const e = environment(), loading = e.load()
  const failed = assert.rejects(loading, error => hasCode(error, 'ERR_CANCELLED'))
  const closing = e.session.close(); assert.equal(e.session.close(), closing)
  const receipt = await closing; await failed
  assertCloseReceipt(receipt, null, null)
  assert.equal(e.session.close(), closing); assert.equal(await e.session.close(), receipt)
  assert.equal(e.factoryCount, 0); assert.equal(e.raw, undefined); assert.equal(e.calls.length, 0)
  assert.deepEqual(e.root.children, [e.unrelated])
})

test('post-admission close waits pending actual load and preserves the exact pack owner and observed RPC', async () => {
  const gate = deferred(), e = environment()
  e.handlers.set('load', () => gate.promise)
  const loading = e.load(), failed = assert.rejects(loading, error => hasCode(error, 'ERR_CANCELLED'))
  await tick()
  const owner = e.session.owner
  assert.deepEqual(owner, e.owner); assert.equal(e.calls.filter(call => call.op === 'load').length, 1)
  const closing = e.session.close(); assert.equal(e.session.close(), closing)
  let settled = false; void closing.then(() => { settled = true })
  await tick(); assert.equal(settled, false); assert.equal(e.raw.closes, 0)
  gate.resolve(e.loadResult())
  const receipt = await closing; await failed
  assertCloseReceipt(receipt, owner, rpcIdentity(e.owner))
  assert.equal(e.session.close(), closing); assert.equal(await e.session.close(), receipt)
  assert.equal(e.raw.closes, 1); assert.equal(e.adapterOptions, undefined)
  assert.deepEqual(e.root.children, [e.unrelated])
})

test('early close owns a late renderer asset lease before exactly-once disposal and termination', async () => {
  const gate = deferred(), disposed = [], e = environment({ backend: 'external-frame', options: { loadRendererAssets: () => gate.promise } })
  const loading = e.load(), failed = assert.rejects(loading, error => hasCode(error, 'ERR_CANCELLED'))
  await tick(); const owner = e.session.owner; assert.deepEqual(owner, e.owner)
  const closing = e.session.close(); assert.equal(e.session.close(), closing)
  let settled = false; void closing.then(() => { settled = true })
  await tick(); assert.equal(e.raw.closes, 0); assert.equal(settled, false)
  gate.resolve({ version: '1.0', owner: e.owner, CanvasKit: {}, fontData: new ArrayBuffer(1), dispose() { disposed.push('lease'); return Promise.resolve() } })
  const receipt = await closing; await failed
  assertCloseReceipt(receipt, owner, rpcIdentity(e.owner))
  assert.equal(e.session.close(), closing); assert.equal(await e.session.close(), receipt)
  assert.deepEqual(disposed, ['lease']); assert.equal(e.raw.closes, 1); assert.equal(e.adapterOptions, undefined)
})

test('late adapter transfer is cancelled/disposed before assets, bridge and RPC teardown', async () => {
  const gate = deferred(), e = environment({ backend: 'external-frame', factories: { canvasAdapter: () => gate.promise } })
  const loading = e.load(), failed = assert.rejects(loading, error => hasCode(error, 'ERR_CANCELLED'))
  await tick(); const closing = e.session.close(); gate.resolve(e.adapter)
  await closing; await failed
  const order = ['adapter.cancel', 'adapter.dispose', 'assets.dispose', 'bridge.dispose', 'rpc.close']
  assert.deepEqual(e.log.filter(entry => order.includes(entry)), order)
})

test('normal close retains scheduler→adapter→assets→bridge→RPC ordering and one stable barrier', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load(); e.log.length = 0
  const owner = e.session.owner
  const closing = e.session.close(); assert.equal(e.session.close(), closing)
  const final = await closing
  assertCloseReceipt(final, owner, rpcIdentity(e.owner)); assert.deepEqual(final.owner, e.owner)
  assert.equal(e.session.close(), closing); assert.equal(await e.session.close(), final)
  const order = ['scheduler.close', 'adapter.cancel', 'adapter.dispose', 'assets.dispose', 'bridge.dispose', 'rpc.close']
  assert.deepEqual(e.log.filter(entry => order.includes(entry)), order)
  assert.deepEqual(e.root.children, [e.unrelated])
})

test('an existing RPC with a missing close final never becomes a no-RPC null receipt', async () => {
  const e = environment(); await e.load()
  const owner = e.session.owner
  e.raw.close = function () { this.closes++; e.log.push('rpc.close'); return Promise.resolve(undefined) }
  const closing = e.session.close(), receipt = await closing
  assert.equal(receipt.version, '1.0'); assert.equal(receipt.owner, owner)
  assert.deepEqual(receipt.rpcIdentity, rpcIdentity(e.owner))
  assert.equal(Object.isFrozen(receipt.rpcIdentity), true)
  assert.equal(receipt.workerFinal, undefined); assert.equal(receipt.workerClosed, false)
  // A manager must reject this missing final, rather than accepting the
  // explicit null reserved for a wrapper that never allocated an RPC.
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(receipt)), 'workerFinal'), false)
  assert.equal(e.session.close(), closing); assert.equal(await e.session.close(), receipt)
  assert.equal(e.raw.closes, 1); assert.deepEqual(e.root.children, [e.unrelated])
})

test('adapter cleanup rejection does not skip bridge disposal or exact Worker close', async () => {
  const e = environment(); await e.load()
  const failure = new Error('adapter cleanup failed'); e.adapter.dispose = () => { e.log.push('adapter.dispose'); throw failure }
  await assert.rejects(e.session.close(), error => error === failure || error.errors?.includes(failure))
  assert.equal(e.raw.closes, 1); assert.equal(e.log.includes('bridge.dispose'), true)
})


test('requiresRestart observation keeps the sticky first fault and exposes the later real Worker error', async () => {
  const seen = [], errors = [], e = environment({ options: { onDiagnostic: value => { seen.push(value) }, onError: value => { errors.push(value) } } })
  await e.load()
  const payload = { origin: 'timer', error: { code: 'ERR_TIMEOUT', message: 'actual entered timer exceeded its budget',
    details: { turnId: 'timer-7', elapsedNs: 9000 } }, observation: e.next({ requiresRestart: true }) }
  e.emit('fault', payload)
  const sticky = e.session.status.fault
  assert.equal(sticky.code, 'ERR_UNSUPPORTED_CAPABILITY')
  const actual = e.session.status.diagnostics.find(value => value.code === 'ERR_TIMEOUT' && value.message === payload.error.message)
  assert.ok(actual)
  assert.deepEqual(actual.details, payload)
  assert.equal(seen.includes(actual), true)
  assert.deepEqual(errors, [sticky], 'first-fault callback remains sticky, distinct from diagnostic delivery')
  assert.equal(e.session.status.inputEnabled, false)
  await closeFaulted(e.session)
})

test('malformed fault observation cannot hide the real payload error or mint an original sequence', async () => {
  const seen = [], e = environment({ options: { onDiagnostic: value => { seen.push(value) } } })
  await e.load()
  const payload = { origin: 'timer', error: { code: 'ERR_ENGINE', message: 'original timer failure with broken capture' }, observation: { version: '99' } }
  e.emit('fault', payload)
  assert.equal(e.session.status.fault.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(e.session.observation.sequence, '1')
  const actual = seen.find(value => value.message === payload.error.message)
  assert.equal(actual?.code, 'ERR_ENGINE')
  assert.deepEqual(actual.details, payload)
  assert.equal(e.session.status.diagnostics.includes(actual), true)
  await closeFaulted(e.session)
})

test('a later distinct Worker failure remains diagnostic without replacing the first sticky fault', async () => {
  const errors = [], e = environment({ options: { onError: value => { errors.push(value) } } })
  await e.load()
  e.emit('fault', { error: { code: 'ERR_ENGINE', message: 'first genuine engine failure' }, origin: 'request' })
  const sticky = e.session.status.fault
  e.emit('fault', { error: { code: 'ERR_TIMEOUT', message: 'later genuine timer failure' }, origin: 'timer' })
  assert.equal(e.session.status.fault, sticky)
  assert.equal(e.session.status.diagnostics.some(value => value.code === 'ERR_TIMEOUT' && value.details.origin === 'timer'), true)
  assert.deepEqual(errors, [sticky])
  await tick()
  assert.equal(e.log.filter(value => value === 'adapter.cancel').length, 1)
  await closeFaulted(e.session)
})

test('retained fault diagnostics cannot correlate a nested success into a pending real bridge request', async () => {
  const e = environment(); await e.load()
  const pending = deferred(); e.handlers.set('bridge', () => pending.promise)
  let settled = false
  const request = e.session.request('api.call', {}).then(value => { settled = true; return value })
  await tick()
  const envelope = e.calls.at(-1).payload.envelope
  const nested = { messages: [{ ...envelope, kind: 'response', payload: { ok: true, source: 'diagnostic-retention' } }] }
  const payload = { origin: 'timer', error: { code: 'ERR_TIMEOUT', message: 'real fault with bounded retained diagnostic',
    details: { committedResult: nested } }, observation: e.next({ requiresRestart: true }),
    timerTurn: { version: '1.0', effectDelivery: 'unconfirmed', publicationCompleted: false, committedResult: 'retained' } }
  const noticeCount = e.notices.length
  e.emit('fault', payload); await tick()
  assert.equal(settled, false)
  assert.equal(e.notices.length, noticeCount, 'diagnostics never enter genuine batch ingress')
  const actual = e.session.status.diagnostics.find(value => value.message === payload.error.message)
  assert.deepEqual(actual?.details.error.details.committedResult, nested)
  pending.resolve({ messages: [{ ...envelope, kind: 'response', payload: { ok: true, source: 'actual-native-final' } }], observation: e.session.observation })
  assert.equal((await request).source, 'actual-native-final')
  await closeFaulted(e.session)
})

const loseSurface = (e, lossId = '1') => e.adapterOptions.onSurfaceLost({ version: '1.0', owner: e.owner, lossId, reason: 'webglcontextlost' })
async function acknowledgeRecovery(e) {
  const state = e.session.observation.state, canvas = e.adapter.canvas
  const target = { width: state.viewport.width * 2, height: state.viewport.height * 2 }
  canvas.width = target.width; canvas.height = target.height
  const candidate = { canvas, target, proof: { version: '1.0', owner: e.owner, attemptId: '10',
    surfaceGeneration: state.surfaceGeneration, consumedInput: { pageId: state.currentPage.pageId, routePath: state.currentPage.path,
      templateRevision: state.templateRevision, viewport: state.viewport }, publication: { kind: 'external-frame', renderRevision: state.renderRevision } } }
  candidate.submission = { version: '1.0', status: 'submitted', owner: e.owner, attemptId: candidate.proof.attemptId,
    surfaceGeneration: candidate.proof.surfaceGeneration, renderRevision: candidate.proof.publication.renderRevision,
    viewport: state.viewport, physicalSize: target }
  e.adapter.prepareTemplate = async () => candidate
  e.adapter.present = async () => {
    e.adapterOptions.onSurface(candidate)
    e.adapterOptions.onInput({ enabled: true, owner: e.owner, canvas: e.adapter.canvas, surfaceGeneration: state.surfaceGeneration,
      publication: candidate.proof.publication, consumedInput: candidate.proof.consumedInput })
    assert.equal(e.session.status.inputEnabled, false, 'adapter ACK cannot replace scheduler acceptance')
    return { acknowledged: true, publication: candidate.proof.publication, inputEnabled: true }
  }
  const context = { isCurrent: () => true }, handle = await e.scheduler.config.adapter.prepareTemplate({}, context)
  await e.scheduler.config.adapter.present(handle, context)
  assert.equal(e.session.status.inputEnabled, false, 'completed local recovery still waits for exact accepted proof')
  e.scheduler.status = { phase: 'idle', accepted: { proof: structuredClone(candidate.proof), inputEnabled: true } }
  await e.scheduler.config.adapter.release(handle, context)
  e.scheduler.config.onState(e.scheduler.status)
}

test('external owner explicitly negotiates native recovery and rejects an old or malformed recovery contract', async t => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  const load = e.calls.find(value => value.op === 'load').payload
  assert.deepEqual(load.surfaceRecovery, { version: '1.0' }); assert.deepEqual(load.externalPresentation, { version: '1.0' })
  await e.session.close()
  for (const contract of [undefined, { version: '1.0' }, { version: '1.0', retainedExternalFrame: '0.9' }]) await t.test(String(contract), async () => {
    const old = environment({ backend: 'external-frame' })
    old.handlers.set('load', () => ({ ...old.loadResult(), surfaceRecovery: contract }))
    await assert.rejects(old.load(), { code: 'ERR_PROTOCOL_VERSION' }); assert.equal(old.raw.closes, 1)
  })
})

test('loss immediately freezes the same owner, drains both real lanes, then uses the latest genuine dirty observation', async () => {
  const scheduler = deferred(), adapter = deferred(), e = environment({ backend: 'external-frame' }); await e.load()
  e.scheduler.suspendOwnedSurface = () => scheduler.promise
  e.adapter.suspendOwnedSurface = () => adapter.promise
  loseSurface(e)
  assert.equal(e.session.status.inputEnabled, false); assert.equal(e.session.status.phase, 'ready')
  assert.equal(e.session.status.surfaceRecovery.phase, 'draining')
  e.emit('dirty', { observation: e.next({ templateRevision: '2', renderRevision: '4' }) })
  scheduler.resolve({ version: '1.0', recoveryId: 'exact-ticket' }); await tick()
  assert.equal(e.calls.some(value => value.op === 'surface.recover'), false)
  adapter.resolve({ version: '1.0', suspended: true }); await tick()
  const recover = e.calls.find(value => value.op === 'surface.recover')
  assert.equal(recover.payload.expected.templateRevision, '2'); assert.equal(recover.payload.expected.renderRevision, '4')
  assert.equal(e.session.status.surfaceRecovery.phase, 'awaiting-presentation')
  assert.equal(e.scheduler.recoveryResume.ticket.recoveryId, 'exact-ticket')
  assert.equal(e.session.status.inputEnabled, false)
  assert.equal(e.log.includes('adapter.cancel'), false); assert.equal(e.raw.closes, 0); assert.equal(e.factoryCount, 1)
  await e.session.retryPresentation()
  assert.equal(e.calls.filter(value => value.op === 'surface.recover').length, 1, 'retrying the pending presentation cannot repeat native fencing')
  await acknowledgeRecovery(e)
  assert.equal(e.session.status.surfaceRecovery, null); assert.equal(e.session.status.inputEnabled, true)
  assert.deepEqual(e.session.owner, e.owner); assert.equal(e.factoryCount, 1)
  await e.session.close()
})

test('dirty native recovery leaves normal template evaluation to the scheduler and does not dispatch application JS itself', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  e.handlers.set('surface.recover', ({ expected }) => {
    const inputLifetimeRevision = String(BigInt(expected.inputLifetimeRevision) + 1n)
    const observation = e.next({ inputLifetimeRevision, surfaceGeneration: String(BigInt(expected.surfaceGeneration) + 1n) })
    return { recovery: { version: '1.0', kind: 'render-required', sessionId: e.owner.sessionId,
      previousRenderRevision: expected.renderRevision, renderRevision: expected.renderRevision,
      previousInputLifetimeRevision: expected.inputLifetimeRevision, inputLifetimeRevision }, observation }
  })
  loseSurface(e); await tick()
  assert.equal(e.scheduler.recoveryResume.recovery.kind, 'render-required')
  assert.equal(e.session.observation.state.renderRevision, '0')
  assert.deepEqual(e.calls.map(value => value.op), ['load', 'surface.recover'])
  assert.equal(e.session.status.surfaceRecovery.phase, 'awaiting-presentation')
  assert.equal(e.session.status.inputEnabled, false); await e.session.close()
})

test('three genuine exact-observation races remain blocked and explicit retry reuses the owner with a fresh ticket', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  let races = 0
  e.handlers.set('surface.recover', () => {
    const observation = e.next({ templateRevision: String(++races + 1) })
    throw Object.assign(new Error('actual ordered input changed'), { code: 'ERR_CANCELLED', details: { observation } })
  })
  loseSurface(e); await tick()
  assert.equal(races, 3); assert.equal(e.session.status.surfaceRecovery.phase, 'blocked')
  assert.equal(e.session.status.fault, null); assert.equal(e.raw.closes, 0)
  assert.equal(e.calls.filter(value => value.op === 'surface.recover').at(-1).payload.expected.templateRevision, '3')
  e.handlers.delete('surface.recover'); await e.session.retrySurfaceRecovery()
  assert.equal(e.session.status.surfaceRecovery.phase, 'awaiting-presentation'); assert.equal(e.factoryCount, 1)
  await e.session.close()
})

test('hide retires the old transaction and show fences a fresh recovery after its genuine lifecycle final', async () => {
  const drain = deferred(), e = environment({ backend: 'external-frame' }); await e.load()
  e.adapter.suspendOwnedSurface = () => drain.promise
  loseSurface(e); const hiding = e.session.setVisible(false)
  assert.equal(e.session.status.surfaceRecovery.phase, 'blocked')
  drain.resolve({ version: '1.0', suspended: true }); await hiding; await tick()
  assert.equal(e.session.observation.state.lifecycle, 'Background')
  assert.equal(e.calls.some(value => value.op === 'surface.recover'), false)
  await e.session.setVisible(true); await tick()
  const recovery = e.calls.find(value => value.op === 'surface.recover')
  assert.equal(recovery.payload.expected.surfaceGeneration, '3', 'hide and show actual observations precede recovery')
  assert.equal(e.session.status.surfaceRecovery.phase, 'awaiting-presentation')
  assert.equal(e.session.status.inputEnabled, false); assert.equal(e.raw.closes, 0)
  await e.session.close()
})

test('logical resize replaces a suspended recovery ticket and fences only the genuine resized viewport', async () => {
  const drain = deferred(), e = environment({ backend: 'external-frame' }); await e.load()
  e.adapter.suspendOwnedSurface = () => drain.promise
  loseSurface(e); const resize = e.session.setLogicalViewport({ width: 160, height: 90 })
  drain.resolve({ version: '1.0', suspended: true }); await resize; await tick()
  const recovery = e.calls.filter(value => value.op === 'surface.recover')
  assert.equal(recovery.length, 1); assert.deepEqual(recovery[0].payload.expected.viewport, rect(160, 90))
  assert.equal(e.log.filter(value => value === 'scheduler.surface-suspend').length, 2)
  assert.equal(e.session.status.surfaceRecovery.phase, 'awaiting-presentation')
  assert.equal(e.session.status.metricsFence.phase, 'awaiting-presentation')
  assert.equal(e.session.status.inputEnabled, false); await e.session.close()
})

test('second loss rejects a late first native outcome and recovers through the same control lane', async () => {
  const final = deferred(), e = environment({ backend: 'external-frame' }); await e.load()
  e.handlers.set('surface.recover', () => final.promise)
  loseSurface(e); await tick(); loseSurface(e, '2')
  e.handlers.delete('surface.recover')
  final.resolve({ recovery: { version: '1.0', kind: 'retained', sessionId: e.owner.sessionId,
    previousRenderRevision: '0', renderRevision: '1', previousInputLifetimeRevision: '1', inputLifetimeRevision: '2' },
    observation: e.next({ renderRevision: '1', inputLifetimeRevision: '2', surfaceGeneration: '2' }) })
  await tick()
  assert.equal(e.calls.filter(value => value.op === 'surface.recover').length, 2)
  assert.equal(e.log.filter(value => value === 'adapter.surface-resume').length, 1)
  assert.equal(e.session.status.surfaceRecovery.lossId, '2'); assert.equal(e.session.status.surfaceRecovery.surfaceGeneration, '3')
  assert.equal(e.factoryCount, 1); assert.equal(e.raw.closes, 0); await e.session.close()
})

test('local surface failure remains blocked with timers/effects live and permits an explicit clean retry', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  const failure = new Error('GPU initialization failed after exact last use')
  e.adapter.suspendOwnedSurface = () => Promise.reject(failure)
  loseSurface(e); await tick()
  assert.equal(e.session.status.surfaceRecovery.phase, 'blocked'); assert.equal(e.session.status.phase, 'ready')
  assert.equal(e.session.status.fault, null); assert.equal(e.log.includes('adapter.cancel'), false)
  e.emit('batch', { phase: 'live', messages: [e.effect('timer.remains-live')], observation: e.next({ templateRevision: '2' }) })
  assert.equal(e.notices.at(-1).messages[0].op, 'timer.remains-live')
  let retry
  e.adapter.suspendOwnedSurface = (_, options) => { retry = options.retry; return Promise.resolve({ version: '1.0', suspended: true }) }
  await e.session.retrySurfaceRecovery()
  assert.equal(retry, true); assert.equal(e.session.status.surfaceRecovery.phase, 'awaiting-presentation')
  assert.equal(e.raw.closes, 0); assert.equal(e.factoryCount, 1); await e.session.close()
})

test('protocol identity failures during recovery remain fatal instead of becoming retryable GPU failures', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load()
  e.adapter.suspendOwnedSurface = () => Promise.reject(Object.assign(new Error('different owner'), { code: 'ERR_PROTOCOL_VERSION' }))
  loseSurface(e); await tick()
  assert.equal(e.session.status.phase, 'faulted'); assert.equal(e.session.status.fault.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(e.log.includes('adapter.cancel'), true); await closeFaulted(e.session)
})

test('a clean fresh-presenter failure is blocked and retries the existing native fence without another View evaluation', async () => {
  const e = environment({ backend: 'external-frame' }); await e.load(); loseSurface(e); await tick()
  const native = e.scheduler.recoveryResume.recovery
  e.scheduler.status = { phase: 'blocked', accepted: null }
  e.scheduler.config.onState(e.scheduler.status)
  assert.equal(e.session.status.surfaceRecovery.phase, 'blocked'); assert.equal(e.session.status.fault, null)
  await e.session.retrySurfaceRecovery()
  assert.equal(e.session.status.surfaceRecovery.phase, 'awaiting-presentation')
  assert.equal(e.scheduler.recoveryResume.recovery, native)
  assert.equal(e.calls.filter(value => value.op === 'surface.recover').length, 1)
  assert.equal(e.log.filter(value => value === 'scheduler.retry').length, 1)
  assert.equal(e.log.includes('adapter.cancel'), false)
  await acknowledgeRecovery(e); assert.equal(e.session.status.inputEnabled, true)
  await e.session.close()
})

test('close during actual local drain waits it, never resumes presentation, and closes only the owned Worker', async () => {
  const drain = deferred(), e = environment({ backend: 'external-frame' }); await e.load()
  e.adapter.suspendOwnedSurface = () => drain.promise
  loseSurface(e); let closed = false
  const close = e.session.close().then(value => { closed = true; return value })
  await tick(); assert.equal(closed, false)
  drain.resolve({ version: '1.0', suspended: true }); const final = await close
  assert.equal(final.closed, true); assert.equal(e.raw.closes, 1)
  assert.equal(e.calls.some(value => value.op === 'surface.recover'), false)
  assert.equal(e.log.includes('adapter.surface-resume'), false)
})


function queryEnvironment({ contract = { version: '1.0' }, receive = true, construct } = {}) {
  let e
  const received = []
  const factory = Object.assign(config => {
    e.queryAdapterOptions = config
    e.log.push('query-adapter.construct')
    return construct ? construct(e.adapter) : e.adapter
  }, { browserQueries: contract })
  e = environment({ factories: { domAdapter: factory } })
  if (receive) e.adapter.receiveQueryBatch = batch => {
    received.push(batch); e.log.push(`query-ingress:${batch.messages[0]?.op ?? 'empty'}`); return 0
  }
  e.handlers.set('load', () => ({ ...e.loadResult(), browserQueries: { version: '1.0' } }))
  return Object.assign(e, { queryReceived: received })
}
const queryEffect = (e, id = 'query-1') => e.effect('view.query.request', { version: '1.0', requestId: id,
  key: { sessionId: e.owner.sessionId, pageId: '1', documentRevision: '1', presentationRevision: '1', surfaceGeneration: '1', profile: 'webview' },
  afterEpoch: '0', occurrenceIds: ['root'], deadlineNs: '1000' })

test('default real DOM factory requests browserQueries before app initialization', async () => {
  const e = environment({ defaultDomAdapter: true })
  const failure = Object.assign(new Error('test stops before constructing a browser presenter'), { code: 'ERR_ENGINE' })
  e.handlers.set('load', payload => {
    assert.deepEqual(payload.browserQueries, { version: '1.0' }); throw failure
  })
  await assert.rejects(e.load(), error => error === failure)
  assert.equal(e.calls.filter(call => call.op === 'load').length, 1)
  await closeFaulted(e.session)
})

test('injected fake stays on its original gate unless its factory explicitly opts into browser queries', async () => {
  const e = environment(), received = []
  e.adapter.receiveQueryBatch = batch => received.push(batch)
  try {
    await e.load()
    assert.equal(e.calls[0].payload.browserQueries, undefined, 'method presence alone cannot advertise native capability')
    e.emit('batch', { phase: 'live', observation: e.session.observation, messages: [queryEffect(e)] })
    assert.equal(received.length, 0)
  } finally { await e.session.close() }
  const opted = queryEnvironment()
  try {
    await opted.load()
    assert.deepEqual(opted.calls[0].payload.browserQueries, { version: '1.0' })
    assert.deepEqual(opted.session.status.owner, opted.owner)
  } finally { await opted.session.close() }
})

test('factory, native echo and actual query ingress must all satisfy explicit version 1.0', async () => {
  const malformed = queryEnvironment({ contract: { version: '2.0' } })
  await assert.rejects(malformed.load(), error => hasCode(error, 'ERR_PROTOCOL_VERSION'))
  assert.equal(malformed.calls.length, 0)
  const missing = queryEnvironment()
  missing.handlers.set('load', () => missing.loadResult())
  await assert.rejects(missing.load(), error => hasCode(error, 'ERR_PROTOCOL_VERSION'))
  assert.equal(missing.log.includes('query-adapter.construct'), false)
  const incomplete = queryEnvironment({ receive: false })
  await assert.rejects(incomplete.load(), error => hasCode(error, 'ERR_PROTOCOL_VERSION'))
  const unsolicited = environment()
  unsolicited.handlers.set('load', () => ({ ...unsolicited.loadResult(), browserQueries: { version: '1.0' } }))
  await assert.rejects(unsolicited.load(), error => hasCode(error, 'ERR_PROTOCOL_VERSION'))
  for (const e of [malformed, missing, incomplete, unsolicited]) await closeFaulted(e.session)
})

test('genuine bridge finals and live batches reach query ingress synchronously before user notices', async () => {
  const e = queryEnvironment()
  try {
    await e.load(); e.log.length = 0; e.queryReceived.length = 0
    e.handlers.set('bridge', ({ envelope }) => ({ observation: e.session.observation,
      messages: [{ ...envelope, kind: 'response', payload: { ok: true } }, queryEffect(e, 'query-final')] }))
    await e.session.request('api.call', { name: 'query-final-fixture' })
    assert.equal(e.queryReceived.length, 1)
    assert.equal(e.queryReceived[0].messages[1].payload.requestId, 'query-final')
    assert.ok(e.log.indexOf('query-ingress:api.call') < e.log.indexOf('batch:api.call'))
    e.emit('batch', { phase: 'live', observation: e.session.observation, messages: [queryEffect(e, 'query-live')] })
    assert.equal(e.queryReceived.length, 2)
    assert.equal(e.queryReceived[1].messages[0].payload.requestId, 'query-live')
    assert.ok(e.log.indexOf('query-ingress:view.query.request') < e.log.indexOf('batch:view.query.request'))
  } finally { await e.session.close() }
})

test('live query ingress can complete native sampling while the originating bridge request is still pending', { timeout: 5000 }, async () => {
  const e = queryEnvironment(), queryFinished = deferred()
  let apiFinished = false, ingressWhilePending = false
  try {
    await e.load()
    e.adapter.receiveQueryBatch = batch => {
      const request = batch.messages.find(message => message.op === 'view.query.request')
      if (!request) return 0
      ingressWhilePending = !apiFinished
      void e.queryAdapterOptions.bridge.request('view.query.result', { version: '1.0', requestId: request.payload.requestId,
        key: request.payload.key, geometry: [], viewportScroll: { x: 0, y: 0 } })
        .then(queryFinished.resolve, queryFinished.reject)
      return 1
    }
    e.handlers.set('bridge', async ({ envelope }) => {
      if (envelope.op === 'api.call') {
        e.emit('batch', { phase: 'live', observation: e.session.observation, messages: [queryEffect(e, 'query-pending')] })
        await queryFinished.promise; apiFinished = true
      } else assert.equal(envelope.op, 'view.query.result')
      return { observation: e.session.observation, messages: [{ ...envelope, kind: 'response', payload: { ok: true } }] }
    })
    await e.session.request('api.call', { name: 'async-selector' })
    assert.equal(ingressWhilePending, true)
    assert.equal(apiFinished, true)
    assert.equal(e.calls.filter(call => call.payload?.envelope?.op === 'view.query.result').length, 1)
  } finally { queryFinished.resolve(); await e.session.close() }
})

test('startup query requests retain bounded immutable copies and replay after adapter creation', async () => {
  const created = deferred(), release = deferred()
  const e = queryEnvironment({ construct: async adapter => { created.resolve(); await release.promise; return adapter } })
  const first = queryEffect(e, 'query-startup')
  e.handlers.set('load', () => {
    e.emit('batch', { phase: 'startup', messages: [first] })
    first.payload.requestId = 'mutated-after-event'
    return { ...e.loadResult(), browserQueries: { version: '1.0' } }
  })
  try {
    const loading = e.load()
    await created.promise
    assert.equal(e.queryReceived.length, 0, 'no query is measured before the adapter exists')
    release.resolve(); await loading
    assert.equal(e.queryReceived.length, 1)
    assert.equal(e.queryReceived[0].messages[0].payload.requestId, 'query-startup')
    assert.equal(Object.isFrozen(e.queryReceived[0]), true)
  } finally { release.resolve(); await closeFaulted(e.session) }
})

test('startup query retention fails closed at its count budget and keeps the genuine batch notice', async () => {
  const e = queryEnvironment()
  e.handlers.set('load', () => {
    e.emit('batch', { phase: 'startup', messages: Array.from({ length: 33 }, (_, index) => queryEffect(e, `query-${index}`)) })
    return { ...e.loadResult(), browserQueries: { version: '1.0' } }
  })
  await assert.rejects(e.load(), error => hasCode(error, 'ERR_RENDER'))
  assert.equal(e.notices[0].messages.length, 33)
  assert.equal(e.queryReceived.length, 0)
  await closeFaulted(e.session)
})


test('session negotiates one pinned native/layout/painter font identity and rejects stale native receipt', async () => {
  const font = { url: 'https://worker.test/face.ttf', sha256: pin, size: 4 }
  for (const valid of [true, false]) {
    const e = environment({ backend: 'external-frame' })
    e.document.baseURI = 'https://worker.test/index.html'
    const identity = { sha256: valid ? pin : '0'.repeat(64), face_index: 0, profile: 'sfnt-unhinted-v1' }
    e.handlers.set('load', () => ({ ...e.loadResult(), textFont: identity }))
    try {
      if (valid) {
        await e.load({ rendererAssets: { font: { binary: font } } })
        assert.deepEqual(e.calls.find(call => call.op === 'load').payload.textFont, { ...font, version: '1.0', profile: 'sfnt-unhinted-v1' })
        assert.deepEqual(e.adapterOptions.presenterOptions.fontIdentity, identity)
      } else {
        await assert.rejects(e.load({ rendererAssets: { font: { binary: font } } }), { code: 'ERR_PROTOCOL_VERSION' })
        assert.equal(e.adapterCalls.length, 0, 'mismatched identity reached painter creation')
      }
    } finally { await closeFaulted(e.session) }
    assert.equal(e.raw.closes, 1)
  }
})
