/** Deterministic composition tests. Native/DOM nodes are fakes.
 * Owner, RPC, bridge, scheduler, DOM adapter/client/presenter are real.
 * No WASM/browser/GPU/performance acceptance follows from these contracts. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { WorkerWebSession } from '../examples/hosts/web-wasm/worker-web-session.mjs'
import { WorkerDomAdapter } from '../examples/hosts/web-wasm/worker-dom-adapter.mjs'
import { DomViewPresenter } from '../examples/hosts/web-wasm/dom-presenter.mjs'
import { WorkerRpcClient } from '../examples/hosts/web-wasm/worker-session-client.mjs'
import { WorkerBridgeTransport } from '../examples/hosts/web-wasm/worker-bridge-transport.mjs'
import { stageAnimationStyles, computedAnimationBaseline } from '../examples/hosts/web-wasm/dom-animation-sample.mjs'

const copy = value => structuredClone(value)
const tick = () => new Promise(resolve => setImmediate(resolve))
const outcome = value => value.then(result => ({ result }), error => ({ error }))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const pin = 'a'.repeat(64), manifestPin = 'b'.repeat(64), integrity = 'c'.repeat(64), route = 'pages/home'
const rect = (width = 375, height = 667) => ({ x: 0, y: 0, width, height })
const metrics = (width = 375, height = 667) => ({ windowWidth: width, windowHeight: height, pixelRatio: 1,
  screenWidth: 375, screenHeight: 667, statusBarHeight: 0, screenTop: 0,
  deviceOrientation: width > height ? 'landscape' : 'portrait' })
const reply = (envelope, payload) => ({ ...envelope, kind: 'response', payload })
class Element {
  constructor(document) { this.ownerDocument = document; this.children = []; this.events = new Map(); this.isConnected = false }
  append(child) { child.parent = this; child.isConnected = true; this.children.push(child) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.isConnected = false }
  setAttribute() {}
  addEventListener(name, listener) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(listener) }
  removeEventListener(name, listener) { this.events.get(name)?.delete(listener) }
}
async function harness(t, options = {}) {
  const document = { hidden: false }, target = new Element(document)
  document.createElement = () => new Element(document)
  document.addEventListener = target.addEventListener.bind(target); document.removeEventListener = target.removeEventListener.bind(target)
  document.defaultView = new Element(document)
  const root = document.createElement('section'), listeners = new Map(), timers = new Set(), rafs = new Map(), hooks = new Map()
  const calls = [], nodes = [], batches = [], diagnostics = [], disposalGates = new Map(), gates = new Set(), stateHooks = new Set()
  let owner, rpc, bridge, adapter, presenter, rafSequence = 0, frameRevision = 0, observationSequence = 1n, eventSequence = 0
  const identity = Object.freeze({ workerEpoch: 'metrics-epoch', sessionId: 'metrics-session', packSha256: pin, transportBackend: 'browser-view' })
  let state = { owner: identity, sessionId: identity.sessionId, transportBackend: 'browser-view', currentPage: { pageId: '1', path: route },
    templateRevision: '1', renderRevision: '0', viewRevision: '1', surfaceGeneration: '1', inputLifetimeRevision: '1',
    viewport: rect(), lifecycle: 'Active', rendererProfile: 'webview', declaredRendererProfile: 'webview', requiresRestart: false,
    ...(options.animation ? { sampleDemandRevision: '0' } : {}) }
  let observation = { version: '1.0', sequence: '1', state: copy(state) }
  const update = patch => {
    state = { ...state, ...patch }; observation = { version: '1.0', sequence: String(++observationSequence), state: copy(state) }
    return copy(observation)
  }
  const manifest = { app: { appJson: 'app.json' }, routes: [{ path: route, config: `${route}.json` }], styles: [], components: [], integrity: { root: integrity } }
  const admission = { version: '1.0', route, rendererPolicy: { mode: 'manifest' }, declaredProfile: 'webview', effectiveProfile: 'webview',
    transportBackend: 'browser-view', provenance: { indexSha256: pin, manifestSha256: manifestPin, integrityRoot: integrity } }
  const loadResult = () => ({ state: copy(state), manifest: copy(manifest), capabilities: { quickjs: true }, renderer: 'browser-view', transportBackend: 'browser-view',
    declaredProfile: 'webview', effectiveProfile: 'webview', rendererPolicy: { mode: 'manifest' }, pack: { ...admission.provenance },
    observationContract: { version: '1.0', sequence: 'u64', surfaceGeneration: '1.0', inputLifetime: '1.0' }, observation: copy(observation) })
  const documentFor = revision => ({ version: '1.0', sessionId: identity.sessionId, pageId: 1, revision,
    routePath: route, profile: 'webview', nodes: [{ kind: 'element', occurrenceId: 'root', tag: 'view', attrs: {}, typedAttrs: {},
      ownership: { documentId: `${route}.wxml` }, events: [{ event: 'tap', handler: 'tap', phase: 'bubble', catch: false }], children: [] }],
    styleRoots: [], styles: [], resources: [] })
  const native = (op, payload) => {
    if (op === 'load') return loadResult()
    if (op === 'close') return { closed: true }
    if (op === 'events.ack') return { acknowledged: payload.eventIds, pendingCount: 0, pendingBytes: 0 }
    if (op === 'view.retire') return { messages: [] }
    if (op === 'view.sample.abort') return { messages: [{ protocolVersion: '1.0', sessionId: identity.sessionId,
      kind: 'response', requestId: `native-sample-abort-${calls.length}`, op, payload: { ok: true, version: '1.0', key: payload.key, aborted: true } }] }
    if (op === 'view.abort') return { messages: [{ protocolVersion: '1.0', sessionId: identity.sessionId,
      kind: 'response', requestId: `native-abort-${calls.length}`, op: 'view.abort', payload: { ok: true } }] }
    if (op === 'metrics') {
      if (state.viewport.width !== payload.windowWidth || state.viewport.height !== payload.windowHeight) update({
        viewport: rect(payload.windowWidth, payload.windowHeight), surfaceGeneration: String(BigInt(state.surfaceGeneration) + 1n) })
      return { messages: [] }
    }
    assert.equal(op, 'bridge')
    const envelope = payload.envelope
    let value = { ok: true }
    if (envelope.op === 'app.lifecycle') {
      update({ lifecycle: envelope.payload.event === 'show' ? 'Active' : 'Background',
        surfaceGeneration: String(BigInt(state.surfaceGeneration) + 1n),
        inputLifetimeRevision: String(BigInt(state.inputLifetimeRevision) + 1n) })
    } else if (envelope.op === 'view.prepare') {
      const revision = ++frameRevision, key = { sessionId: identity.sessionId, pageId: '1', documentRevision: String(revision),
        presentationRevision: String(revision), surfaceGeneration: state.surfaceGeneration, profile: 'webview' }
      value = { ok: true, submission: { version: '1.0', key, viewport: { width: state.viewport.width, height: state.viewport.height }, document: documentFor(revision),
        ...(options.animation ? { animation: { version: '1.0', requestId: `animation-${revision}`,
          baselines: [{ occurrenceId: 'root', opacity: true, transform: false }], styles: [] } } : {}) },
        scheduling: { version: '1.0', key: copy(key), consumedInput: { pageId: '1', routePath: route, templateRevision: options.consumedTemplateRevision ?? state.templateRevision, viewport: copy(state.viewport) },
          ...(options.animation ? { consumedSample: { demandRevision: state.sampleDemandRevision, sampleRevision: String(revision) } } : {}) } }
    } else if (envelope.op === 'view.animation.baseline') value = { ok: true, version: '1.0', requestId: envelope.payload.requestId, key: envelope.payload.key,
      styles: envelope.payload.values.map(value => ({ occurrenceId: value.occurrenceId, opacity: value.opacity, transform: null, origin: null })) }
    else if (envelope.op === 'view.sample.prepare') {
      const request = envelope.payload, key = { ...request.baseKey, presentationRevision: String(++frameRevision) }
      const consumedSample = { demandRevision: request.sampleDemandRevision, sampleRevision: String(frameRevision) }
      value = { ok: true, submission: { version: '1.0', key, baseKey: request.baseKey, baseGeometryEpoch: request.baseGeometryEpoch, consumedSample,
        viewport: { width: state.viewport.width, height: state.viewport.height }, styles: [{ occurrenceId: 'root', opacity: Number(request.sampleDemandRevision) / 10, transform: null, origin: null }] },
        scheduling: { version: '1.0', key, consumedSample, consumedInput: { pageId: '1', routePath: route, templateRevision: options.consumedTemplateRevision ?? state.templateRevision, viewport: copy(state.viewport) } },
        permit: { version: '1.0', key, baseKey: request.baseKey, baseGeometryEpoch: request.baseGeometryEpoch, consumedSample, permitId: `sample-permit-${frameRevision}` } }
    } else if (envelope.op === 'view.sample.presented') value = { ok: true, version: '1.0', key: envelope.payload.permit.key,
      consumedSample: envelope.payload.permit.consumedSample, inputEnabled: true }
    else if (envelope.op === 'view.prepare.commit') value = { ok: true, permit: { version: '1.0', key: envelope.payload.key,
      epoch: envelope.payload.epoch, permitId: `permit-${frameRevision}` } }
    else if (envelope.op === 'view.presented') value = { ok: true, key: envelope.payload.key, inputEnabled: true }
    return { messages: [reply(envelope, value)] }
  }
  const worker = {
    terminated: 0,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) },
    postMessage(message) {
      if (message.kind !== 'request') return
      calls.push(copy(message))
      queueMicrotask(async () => {
        try {
          const hook = hooks.get(message.op === 'bridge' ? message.payload.envelope.op : message.op)
          const result = await (hook ? hook({ message, native }) : native(message.op, message.payload))
          emit({ ...message, kind: 'response', payload: { status: 'ok', result: { ...result, observation: result.observation ?? copy(observation) } } })
        } catch (failure) {
          emit({ ...message, kind: 'response', payload: { status: 'error', error: { code: failure.code ?? 'ERR_ENGINE',
            message: failure.message, observation: copy(observation) } } })
        }
      })
    }, terminate() { this.terminated++ },
  }
  const emit = message => { for (const listener of [...(listeners.get('message') ?? [])]) listener({ data: copy(message) }) }
  owner = new WorkerWebSession({ surfaceRoot: root, admitPack: async () => copy(admission),
    requestFrame(callback) { const id = ++rafSequence; rafs.set(id, callback); return id }, cancelFrame(id) { rafs.delete(id) },
    onBatch(batch) { batches.push(batch) }, onDiagnostic(failure) { diagnostics.push(failure) },
    onState(value) { for (const callback of stateHooks) callback(value) },
    factories: {
      rpc(options) {
        rpc = new WorkerRpcClient({ ...options, workerEpoch: identity.workerEpoch, sessionId: identity.sessionId,
          workerFactory: () => worker, timeoutMs: 1500, closeTimeoutMs: 1500,
          setTimer(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); callback() }, delay); timers.add(timer); return timer },
          clearTimer(timer) { clearTimeout(timer); timers.delete(timer) } })
        return rpc
      },
      bridge(options) { bridge = new WorkerBridgeTransport(options); return bridge },
      domAdapter(options) {
        presenter = new DomViewPresenter(options.container, { timeoutMs: 1500 })
        presenter.createCandidate = async () => {
          const document = {}, properties = new Map()
          const root = { nodeType: 1, ownerDocument: document, isConnected: true, style: {
            getPropertyValue: name => properties.get(name)?.[0] ?? '', getPropertyPriority: name => properties.get(name)?.[1] ?? '',
            setProperty: (name, value, priority) => properties.set(name, [value, priority]), removeProperty: name => properties.delete(name) } }
          const node = { root, index: nodes.length, interactive: false, activation: [], disposed: 0, supports: () => true, validateSelector() {},
            animationBaselines(descriptors) { return descriptors.map(value => computedAnimationBaseline(value,
              { opacity: '.8', transform: 'none', transformOrigin: '50px 25px', fontSize: '16px' })) },
            stageAnimation(styles, isCurrent) { return stageAnimationStyles(styles, { document, elementFor: id => id === 'root' ? root : undefined, isCurrent }) },
            async populate(plan) { node.plan = plan }, snapshot() { return new Map() }, restore() {}, isConnected() { return !node.disposed },
            setVisible(value) { node.visible = value }, setInteractive(value) { node.interactive = value; node.activation.push(value) },
            measure() { return [...node.plan.tables.nodes.keys()].map(occurrenceId => ({ occurrenceId, x: 0, y: 0, width: state.viewport.width,
              height: 50, scrollTop: 0, scrollHeight: 50, clientHeight: 50 })) }, activate(send) { node.send = send },
            dispose() {
              node.disposed++; node.interactive = false
              const gate = disposalGates.get(node.index)
              return gate ? gate.promise.then(() => node.plan.dispose()) : node.plan.dispose()
            },
          }
          nodes.push(node); return node
        }
        adapter = new WorkerDomAdapter({ ...options, presenter, crypto: webcrypto, timeoutMs: 1500 }); return adapter
      },
    } })
  await owner.load({ indexSha256: pin, viewport: { width: 375, height: 667 }, timeoutMs: 1500 })
  const pump = async () => {
    await tick()
    const frame = rafs.entries().next().value
    if (frame) { rafs.delete(frame[0]); frame[1](16 * frame[0]) }
    await tick()
  }
  const until = async predicate => {
    for (let turn = 0; turn < 100; turn++) { if (predicate()) return; await pump() }
    assert.fail(`bounded composition wait exhausted: ${owner.status.phase}/${owner.status.presentation?.phase}`)
  }
  const gate = () => { const value = deferred(); gates.add(value); return value }
  const h = { owner, rpc, bridge, adapter, presenter, worker, calls, nodes, batches, diagnostics, hooks, stateHooks, disposalGates, gate, pump, until,
    native, update, get observation() { return copy(observation) }, get state() { return copy(state) },
    dirty(patch) { const next = update(patch); emit({ version: '1.0', workerEpoch: identity.workerEpoch, sessionId: identity.sessionId,
      kind: 'event', requestId: `worker-event-${++eventSequence}`, op: 'dirty', payload: { observation: next } }) },
    count(op) { return calls.filter(call => (call.op === 'bridge' ? call.payload.envelope.op : call.op) === op).length },
  }
  t.after(async () => {
    for (const value of gates) value.resolve()
    await outcome(owner.close())
    assert.equal(worker.terminated, 1, 'exact owned Worker termination')
    assert.equal(timers.size, 0, 'owned RPC timers released')
    assert.equal(rafs.size, 0, 'owned scheduler RAFs released')
    assert.equal([...listeners.values()].reduce((count, values) => count + values.size, 0), 0)
    assert.equal(root.children.length, 0, 'only owned mount removed')
  })
  await until(() => owner.status.inputEnabled)
  return h
}

test('production WorkerWebSession facade and real DOM adapter sample successive retained ACKs without rebuilding View', async t => {
  const h = await harness(t, { animation: true, consumedTemplateRevision: '2' }), node = h.nodes[0], plan = node.plan
  const template = copy(h.owner.status.presentation.accepted.proof)
  assert.equal(h.state.templateRevision, '1'); assert.equal(template.consumedInput.templateRevision, '2', 'actual clone input may lead captured demand')
  assert.deepEqual(template.consumedSample, { demandRevision: '0', sampleRevision: '1' })
  assert.equal(node.root.style.getPropertyValue('opacity'), '0.8')
  for (const revision of ['1', '2']) {
    const previousKey = copy(h.adapter.client.accepted.key)
    h.dirty({ sampleDemandRevision: revision })
    await h.until(() => h.owner.status.presentation.accepted?.proof.consumedSample?.demandRevision === revision
      && !h.owner.status.presentation.inFlight && h.owner.status.inputEnabled)
    const proof = h.owner.status.presentation.accepted.proof
    assert.deepEqual(proof.consumedInput, template.consumedInput)
    assert.equal(proof.publication.key.documentRevision, template.publication.key.documentRevision)
    assert.ok(BigInt(proof.publication.key.presentationRevision) > BigInt(previousKey.presentationRevision))
    assert.equal(node.root.style.getPropertyValue('opacity'), String(Number(revision) / 10))
    assert.equal(h.count('view.sample.prepare'), Number(revision)); assert.equal(h.count('view.sample.presented'), Number(revision))
    const prepare = h.calls.filter(call => call.op === 'bridge' && call.payload.envelope.op === 'view.sample.prepare').at(-1)
    assert.deepEqual(prepare.payload.envelope.payload.baseKey, previousKey, 'next sample consumes the last actual ACK')
  }
  assert.equal(h.count('view.prepare'), 1); assert.equal(h.count('view.prepare.commit'), 1)
  assert.equal(h.count('resource'), 0); assert.equal(h.nodes.length, 1)
  assert.equal(node.plan, plan); assert.equal(node.disposed, 0)
  assert.equal(h.adapter.active, null); assert.equal(h.adapter.client.active, null)
  assert.deepEqual(h.diagnostics, [])
})

test('visibility show keeps early native Active observations suspended until the genuine lifecycle final', async t => {
  const h = await harness(t), gate = h.gate(), entered = h.gate()
  await h.owner.setVisible(false)
  const prepared = h.count('view.prepare')
  h.hooks.set('app.lifecycle', async ({ message, native }) => {
    const result = native(message.op, message.payload)
    h.dirty({}); entered.resolve(); await gate.promise; return result
  })
  const showing = h.owner.setVisible(true)
  await entered.promise
  assert.equal(h.owner.observation.state.lifecycle, 'Active'); assert.equal(h.owner.status.visible, false)
  await h.pump(); await h.pump()
  assert.equal(h.owner.status.presentation.failed, null, 'local show fence must not become a failed template watermark')
  assert.equal(h.owner.status.presentation.suspended, true); assert.equal(h.owner.status.presentation.inFlight, false)
  assert.equal(h.count('view.prepare'), prepared); assert.equal(h.owner.status.inputEnabled, false)
  gate.resolve(); await showing
  assert.equal(h.owner.status.visible, true); assert.equal(h.owner.status.inputEnabled, false, 'show final still requires a new presentation ACK')
  await h.until(() => h.owner.status.inputEnabled)
  assert.equal(h.count('view.prepare'), prepared + 1); assert.equal(h.owner.status.presentation.failed, null)
  assert.deepEqual(h.diagnostics, [])
})

test('queued hide owns visibility after an older show final and the later show alone resumes presentation', async t => {
  const h = await harness(t), showGate = h.gate(), showEntered = h.gate(), hideGate = h.gate(), hideEntered = h.gate()
  await h.owner.setVisible(false)
  h.hooks.set('app.lifecycle', async ({ message, native }) => {
    const showing = message.payload.envelope.payload.event === 'show', result = native(message.op, message.payload)
    h.dirty({}); (showing ? showEntered : hideEntered).resolve(); await (showing ? showGate : hideGate).promise; return result
  })
  const showing = h.owner.setVisible(true); await showEntered.promise
  const hiding = h.owner.setVisible(false), prepared = h.count('view.prepare')
  showGate.resolve(); await showing; await hideEntered.promise
  assert.equal(h.owner.status.visible, false, 'an older show cannot overwrite the newer local hide fence')
  await h.pump(); assert.equal(h.count('view.prepare'), prepared); assert.equal(h.owner.status.inputEnabled, false)
  hideGate.resolve(); await hiding
  assert.equal(h.owner.observation.state.lifecycle, 'Background'); assert.equal(h.owner.status.presentation.suspended, true)
  h.hooks.delete('app.lifecycle'); await h.owner.setVisible(true); await h.until(() => h.owner.status.inputEnabled)
  assert.deepEqual(h.calls.filter(call => call.op === 'bridge' && call.payload.envelope.op === 'app.lifecycle')
    .map(call => call.payload.envelope.payload.event), ['hide', 'show', 'hide', 'show'])
  assert.equal(h.count('view.prepare'), prepared + 1); assert.deepEqual(h.diagnostics, [])
})

test('visibility suspension publishes its serial slot before a state callback requests show', async t => {
  const h = await harness(t), hideGate = h.gate(), hideEntered = h.gate()
  let showing = null
  h.hooks.set('app.lifecycle', async ({ message, native }) => {
    if (message.payload.envelope.payload.event === 'hide') { hideEntered.resolve(); await hideGate.promise }
    return native(message.op, message.payload)
  })
  h.stateHooks.add(state => {
    if (!showing && state.presentation?.suspended) showing = h.owner.setVisible(true)
  })
  const hiding = h.owner.setVisible(false)
  assert.ok(showing, 'synchronous suspension can reenter the owner')
  await hideEntered.promise
  assert.equal(h.calls.filter(call => call.op === 'bridge' && call.payload.envelope.op === 'app.lifecycle').length, 1)
  hideGate.resolve(); await hiding; await showing; await h.until(() => h.owner.status.inputEnabled)
  assert.deepEqual(h.calls.filter(call => call.op === 'bridge' && call.payload.envelope.op === 'app.lifecycle')
    .map(call => call.payload.envelope.payload.event), ['hide', 'show'])
  assert.equal(h.owner.status.visible, true); assert.deepEqual(h.diagnostics, [])
})

test('show and metrics finals each preserve the other owner suspension until both controls settle', async t => {
  for (const first of ['show', 'metrics']) await t.test(first, async t => {
    const h = await harness(t), firstGate = h.gate(), firstEntered = h.gate(), secondGate = h.gate(), secondEntered = h.gate()
    await h.owner.setVisible(false)
    let calls = 0
    const hook = async ({ message, native }) => {
      const index = ++calls, result = native(message.op, message.payload)
      h.dirty({}); (index === 1 ? firstEntered : secondEntered).resolve()
      await (index === 1 ? firstGate : secondGate).promise; return result
    }
    h.hooks.set('app.lifecycle', hook); h.hooks.set('metrics', hook)
    const runShow = () => h.owner.setVisible(true), runMetrics = () => h.owner.setWindowMetrics(metrics(667, 375))
    const one = first === 'show' ? runShow() : runMetrics(); await firstEntered.promise
    const two = first === 'show' ? runMetrics() : runShow(), prepared = h.count('view.prepare')
    firstGate.resolve(); await one; await secondEntered.promise
    await h.pump(); await h.pump()
    assert.equal(h.owner.status.presentation.suspended, true); assert.equal(h.owner.status.presentation.failed, null)
    assert.equal(h.count('view.prepare'), prepared); assert.equal(h.owner.status.inputEnabled, false)
    secondGate.resolve(); await two; await h.until(() => h.owner.status.inputEnabled)
    assert.equal(h.owner.status.metricsFence.phase, 'open'); assert.equal(h.owner.status.visible, true)
    assert.equal(h.adapter.client.accepted.key.surfaceGeneration, h.state.surfaceGeneration)
    assert.equal(h.count('view.prepare'), prepared + 1); assert.deepEqual(h.diagnostics, [])
  })
})

test('logical metrics immediately fence real DOM input, geometry and the shared send boundary', async t => {
  const h = await harness(t), gate = h.gate(), entered = h.gate(), oldKey = copy(h.adapter.client.accepted.key)
  h.hooks.set('metrics', async ({ message, native }) => { entered.resolve(); await gate.promise; return native(message.op, message.payload) })
  const beforeEvents = h.count('view.events'), beforeGeometry = h.count('view.geometry')
  const updating = h.owner.setWindowMetrics(metrics(667, 375))
  assert.equal(h.nodes[0].interactive, false)
  assert.equal(h.owner.status.inputEnabled, false)
  assert.equal(h.owner.status.presentation.suspended, true)
  assert.equal(h.adapter.client.accepted.inputEnabled, false)
  await entered.promise
  const eventBatch = { version: '1.0', key: oldKey, epoch: '1', events: [] }
  assert.equal((await h.adapter.client.events(eventBatch)).discarded, true)
  assert.equal((await h.adapter.client.geometry({ version: '1.0', key: oldKey, epoch: '1', viewport: { width: 375, height: 667 }, nodes: [] })).discarded, true)
  await assert.rejects(h.bridge.request('view.events', eventBatch), failure => failure.code === 'ERR_CANCELLED')
  await assert.rejects(h.bridge.request('view.geometry', { ...eventBatch, nodes: [] }), failure => failure.code === 'ERR_CANCELLED')
  assert.equal(h.count('view.events'), beforeEvents)
  assert.equal(h.count('view.geometry'), beforeGeometry)
  gate.resolve(); await updating
  assert.equal(h.owner.status.metricsFence.phase, 'awaiting-presentation')
  assert.equal(h.owner.status.inputEnabled, false, 'metrics final is not a presentation ACK')
  await h.until(() => h.owner.status.inputEnabled)
  assert.equal(h.owner.status.metricsFence.phase, 'open')
  assert.equal(h.adapter.client.accepted.key.surfaceGeneration, h.state.surfaceGeneration)
  assert.equal(h.owner.status.observation.state.viewport.width, 667)
})

test('same-value metrics use unchanged native observation and resume only through another true presentation', async t => {
  const h = await harness(t), original = h.observation, oldKey = copy(h.adapter.client.accepted.key), prepared = h.count('view.prepare')
  await h.owner.setWindowMetrics(metrics())
  assert.equal(h.observation.sequence, original.sequence, 'owner did not synthesize an observation')
  assert.equal(h.observation.state.surfaceGeneration, original.state.surfaceGeneration, 'no fabricated hard generation')
  assert.equal(h.owner.status.presentation.accepted, null)
  assert.equal(h.owner.status.inputEnabled, false)
  await h.until(() => h.owner.status.inputEnabled)
  assert.equal(h.count('view.prepare'), prepared + 1)
  assert.notEqual(h.adapter.client.accepted.key.presentationRevision, oldKey.presentationRevision)
  assert.equal(h.adapter.acceptsOwnerInput(oldKey, h.owner.status.metricsFence.revision), false)
})

test('success of an older queued metrics request cannot resume or clear the newer fence', async t => {
  const h = await harness(t), firstGate = h.gate(), secondGate = h.gate(), firstEntered = h.gate(), secondEntered = h.gate()
  let count = 0
  h.hooks.set('metrics', async ({ message, native }) => {
    const index = ++count; (index === 1 ? firstEntered : secondEntered).resolve()
    await (index === 1 ? firstGate : secondGate).promise
    return native(message.op, message.payload)
  })
  const first = h.owner.setWindowMetrics(metrics(667, 375)), second = h.owner.setWindowMetrics(metrics(390, 844))
  const prepared = h.count('view.prepare')
  await firstEntered.promise; firstGate.resolve(); await first; await secondEntered.promise
  assert.equal(h.owner.status.metricsFence.revision, '2')
  assert.equal(h.owner.status.metricsFence.phase, 'pending')
  assert.equal(h.owner.status.metricsPending, 1)
  await h.pump(); assert.equal(h.count('view.prepare'), prepared)
  assert.equal(h.owner.status.presentation.suspended, true)
  secondGate.resolve(); await second
  assert.equal(h.owner.status.inputEnabled, false)
  await h.until(() => h.owner.status.inputEnabled)
  assert.equal(h.owner.status.observation.state.viewport.width, 390)
  assert.equal(h.owner.status.metricsFence.revision, '2')
  assert.equal(h.count('view.prepare'), prepared + 1, 'only newest successful metrics launches a replacement View')
})

test('metrics reentered synchronously by the state callback keeps native call order and the newest durable fence', async t => {
  const h = await harness(t), firstGate = h.gate(), secondGate = h.gate(), firstEntered = h.gate(), secondEntered = h.gate()
  const prepared = h.count('view.prepare'), widths = []
  let nested = null
  h.hooks.set('metrics', async ({ message, native }) => {
    widths.push(message.payload.windowWidth)
    const first = widths.length === 1
    const entered = first ? firstEntered : secondEntered
    entered.resolve()
    await (first ? firstGate : secondGate).promise
    return native(message.op, message.payload)
  })
  const reenter = state => {
    if (!nested && state.metricsFence.revision === '1' && state.metricsFence.phase === 'pending') {
      // Deliberately run inside #emit, before the outer setWindowMetrics
      // returns; the observer returns synchronously and owns no async lease.
      nested = outcome(h.owner.setWindowMetrics(metrics(390, 844)))
    }
  }
  h.stateHooks.add(reenter)
  const first = h.owner.setWindowMetrics(metrics(667, 375))
  assert.ok(nested, 'nested command was submitted from the same synchronous state callback')
  assert.equal(h.owner.status.metricsPending, 2)
  assert.equal(h.owner.status.metricsFence.revision, '2')
  assert.equal(h.owner.status.inputEnabled, false)
  assert.equal(h.nodes[0].interactive, false)
  await firstEntered.promise
  assert.deepEqual(widths, [667], 'outer serial slot was published before callback reentry')
  firstGate.resolve(); await first; await secondEntered.promise
  assert.deepEqual(widths, [667, 390])
  assert.equal(h.owner.status.metricsPending, 1)
  assert.equal(h.owner.status.metricsFence.phase, 'pending')
  await h.pump()
  assert.equal(h.count('view.prepare'), prepared, 'older success cannot trigger an intermediate presentation')
  secondGate.resolve()
  assert.equal((await nested).error, undefined)
  h.stateHooks.delete(reenter)
  assert.equal(h.owner.status.inputEnabled, false, 'latest metrics response is not a presentation ACK')
  await h.until(() => h.owner.status.inputEnabled)
  assert.equal(h.owner.status.metricsFence.revision, '2')
  assert.equal(h.owner.status.metricsFence.phase, 'open')
  assert.equal(h.owner.status.observation.state.viewport.width, 390)
  assert.equal(h.count('view.prepare'), prepared + 1)
})

test('native metrics failure after commit preserves its real coordinates and a durable disabled fence', async t => {
  const h = await harness(t)
  h.hooks.set('metrics', ({ message, native }) => {
    native(message.op, message.payload)
    throw Object.assign(new Error('native resize callback failed after commit'), { code: 'ERR_ENGINE' })
  })
  await assert.rejects(h.owner.setWindowMetrics(metrics(667, 375)), /resize callback failed/)
  assert.equal(h.owner.status.observation.state.viewport.width, 667)
  assert.equal(h.owner.status.metricsPending, 0)
  assert.equal(h.owner.status.metricsFence.phase, 'pending')
  assert.equal(h.owner.status.inputEnabled, false)
  assert.equal(h.nodes.every(node => !node.interactive), true)
  assert.equal(h.owner.status.requiresRestart, true)
})

test('an old real ACK waiting in strict confirmation remains retained and cannot reopen input', async t => {
  const h = await harness(t), release = h.gate()
  h.disposalGates.set(0, release)
  h.dirty({ templateRevision: '2' })
  await h.until(() => h.nodes.length === 2 && h.presenter.currentEntry?.state === 'confirmed' && h.nodes[0].disposed === 1)
  const retired = h.nodes[1], oldKey = copy(h.presenter.currentEntry.key), ackCount = h.count('view.presented')
  assert.equal(retired.interactive, false)
  await h.owner.setWindowMetrics(metrics(667, 375))
  assert.equal(h.owner.status.inputEnabled, false)
  release.resolve()
  await h.until(() => h.owner.status.inputEnabled)
  assert.equal(h.owner.status.phase, 'ready', 'expected metrics retirement did not become a cleanup fault')
  assert.equal(retired.activation.includes(true), false)
  assert.ok(h.batches.some(batch => batch.messages.some(message => message.op === 'view.presented' && message.payload?.ok === true && message.payload.key?.presentationRevision === oldKey.presentationRevision)), 'genuine old ACK was preserved')
  assert.ok(h.count('view.presented') > ackCount, 'only a later real ACK can reopen input')
  assert.equal(h.adapter.pendingResourceCount, 0)
})

test('close while metrics and strict confirm are pending never resumes presentation after the closing fence', async t => {
  const h = await harness(t), release = h.gate(), entered = h.gate(), metricsGate = h.gate()
  h.disposalGates.set(0, release); h.dirty({ templateRevision: '2' })
  await h.until(() => h.nodes.length === 2 && h.presenter.currentEntry?.state === 'confirmed' && h.nodes[0].disposed === 1)
  h.hooks.set('metrics', async ({ message, native }) => { entered.resolve(); await metricsGate.promise; return native(message.op, message.payload) })
  const changing = outcome(h.owner.setWindowMetrics(metrics(667, 375)))
  await entered.promise
  const closing = outcome(h.owner.close())
  assert.equal(h.owner.status.inputEnabled, false)
  release.resolve(); metricsGate.resolve()
  await changing
  const closed = await closing
  assert.equal(closed.error, undefined)
  assert.equal(h.owner.status.phase, 'closed')
  assert.equal(h.worker.terminated, 1)
  assert.equal(h.nodes.every(node => !node.interactive), true)
})

test('an already-aborted metrics command does not restore the preceding accepted input on rejection', async t => {
  const h = await harness(t), controller = new AbortController(); controller.abort()
  await assert.rejects(h.owner.setWindowMetrics(metrics(667, 375), { signal: controller.signal }))
  assert.equal(h.owner.status.metricsPending, 0)
  assert.equal(h.owner.status.metricsFence.phase, 'pending')
  assert.equal(h.owner.status.inputEnabled, false)
  assert.equal(h.nodes.every(node => !node.interactive), true)
})


test('same-size hostLayout updates require a matching new presentation and immutable committed metrics', async t => {
  const h = await harness(t), original = h.owner.status.presentation.accepted.proof, gate = h.gate(), entered = h.gate()
  const value = { ...metrics(), hostLayout: {version:1,safeInsets:{top:0,right:40,bottom:20,left:0},verticalBarEdge:'right',
    reservedRegions:[{id:'camera',kind:'occlusion',x:335,y:0,width:40,height:40}]} }
  h.hooks.set('metrics', async ({message,native}) => {entered.resolve();await gate.promise;return native(message.op,message.payload)})
  const update = h.owner.setWindowMetrics(value)
  assert.equal(h.owner.status.metricsFence.phase,'pending')
  assert.equal(h.owner.status.inputEnabled,false)
  assert.equal(h.owner.status.windowMetrics.hostLayout,undefined,'uncommitted candidate is not published')
  value.hostLayout.safeInsets.right=99
  await entered.promise;gate.resolve();await update
  assert.equal(h.owner.status.windowMetrics.hostLayout.safeInsets.right,40,'metrics owns a deep clone')
  assert.throws(()=>{h.owner.status.windowMetrics.hostLayout.safeInsets.right=1},TypeError)
  assert.equal(h.owner.status.metricsFence.phase,'awaiting-presentation')
  assert.equal(h.owner.status.inputEnabled,false)
  await h.until(()=>h.owner.status.inputEnabled)
  assert.equal(h.owner.status.metricsFence.phase,'open')
  assert.notDeepEqual(h.owner.status.presentation.accepted.proof,original,'a same-size old receipt cannot release the fence')
  await h.owner.setWindowMetrics(metrics());await h.until(()=>h.owner.status.inputEnabled)
  assert.equal(h.owner.status.windowMetrics.hostLayout,undefined,'omission clears old layout')
})

test('invalid hostLayout candidates fail before posting and cannot fence a healthy owner', async t => {
  const h=await harness(t), calls=h.count('metrics')
  const valid={version:1,safeInsets:{top:0,right:40,bottom:20,left:0},verticalBarEdge:'right',reservedRegions:[]}
  for(const change of [v=>v.version=2,v=>v.verticalBarEdge='leading',v=>v.safeInsets.left=-1,
    v=>v.safeInsets.right=376,v=>v.safeInsets.extra=0,v=>v.extra=true,v=>v.reservedRegions=[{id:'camera',kind:'occlusion',x:374,y:0,width:40,height:40}],
    v=>v.reservedRegions=Array.from({length:65},(_,i)=>({id:String(i),kind:'division',x:0,y:0,width:1,height:1}))]) {
    const layout=copy(valid);change(layout)
    await assert.rejects(h.owner.setWindowMetrics({...metrics(),hostLayout:layout}),failure=>failure.code==='ERR_RENDER')
    assert.equal(h.owner.status.inputEnabled,true)
  }
  assert.equal(h.count('metrics'),calls)
})
