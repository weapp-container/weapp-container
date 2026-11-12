/** Draft Node contracts only: fake presenter/RPC, no GPU/browser acceptance. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerCanvasKitAdapter } from '../examples/hosts/web-wasm/worker-canvaskit-adapter.mjs'
import { WorkerRpcClient } from '../examples/hosts/web-wasm/worker-session-client.mjs'
import { PresentationScheduler } from '../examples/hosts/web-wasm/presentation-scheduler.mjs'

const owner = Object.freeze({ workerEpoch: 'epoch-adapter', sessionId: 'session-adapter',
  packSha256: 'a'.repeat(64), transportBackend: 'external-frame' })
const contract = Object.freeze({ version: '1.0', consumedInput: '1.0', ackOutcome: '1.0', physicalTarget: '1.0' })
const rect = () => ({ x: 0, y: 0, width: 100, height: 50 })
const message = (op, payload = {}) => ({ protocolVersion: '1.0', sessionId: owner.sessionId,
  requestId: `test-${op}`, kind: 'event', op, payload })
const batch = op => ({ messages: op ? [message(op)] : [] })
const input = (template = '1') => ({ pageId: '1', routePath: 'pages/home/index', templateRevision: template, viewport: rect() })
function frameReply(revision = '1', template = '1', op = 'frame-effect', scale = 2) {
  return { frame: { frame_id: Number(revision), viewport: rect(), root: {} }, renderRevision: revision, viewRevision: revision,
    target: { version: '1.0', sessionId: owner.sessionId, renderRevision: revision, width: 100 * scale, height: 50 * scale },
    batch: batch(op), scheduling: { version: '1.0', sessionId: owner.sessionId, renderRevision: revision, consumedInput: input(template) } }
}
function ack(revision = '1', options = {}) {
  return { version: '1.0', sessionId: owner.sessionId, renderRevision: revision, acknowledged: true,
    inputEnabled: options.inputEnabled ?? true, requiresRestart: options.requiresRestart ?? false,
    batch: options.batch ?? batch('ready-effect'), observedState: { schemaVersion: 1, sessionId: owner.sessionId,
      templateRevision: options.templateRevision ?? '1', renderRevision: revision, viewRevision: revision,
      rendererProfile: 'skia', declaredRendererProfile: 'skia', lifecycle: 'Active',
      viewport: { width: 100, height: 50 }, requiresRestart: options.requiresRestart ?? false,
      currentPage: { pageId: '1', path: 'pages/home/index' } } }
}
const demand = (revision = '0', template = '1') => ({ owner, currentPage: { pageId: '1', path: 'pages/home/index' },
  templateRevision: template, renderRevision: revision, surfaceGeneration: '1', viewport: rect(), rendererProfile: 'skia', lifecycle: 'Active' })
function context(attemptId = '1') {
  const controller = new AbortController(), mutable = { current: true }
  return { owner, attemptId, surfaceGeneration: '1', signal: controller.signal,
    isCurrent: () => mutable.current, controller, mutable }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
function submitted(frame, canvas, generation = 1) {
  return { schemaVersion: 1, status: 'submitted', backend: 'canvaskit-webgl2', frameId: frame.frame_id, generation,
    viewport: { ...frame.viewport }, physicalSize: [canvas.width, canvas.height],
    context: { api: 'webgl2', version: 'WebGL 2.0 test', vendor: 'test vendor', renderer: 'test renderer',
      unmaskedVendor: null, unmaskedRenderer: null, surfaceIsGpu: true, contextLost: false, physicalHardware: 'unknown' },
    runtimeBoundary: { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 },
    presentation: { pictureSubmissions: 1, flushes: 1, gpuCompletion: 'not-waited', glError: 0 } }
}

class FakeCanvas {
  constructor(document) {
    this.ownerDocument = document; this.width = 1; this.height = 1; this.isConnected = false
    this.values = new Map(); this.listeners = new Map(); this.submitted = null; this.removes = 0
  }
  get attributes() { return [...this.values].map(([name, value]) => ({ name, value })) }
  setAttribute(name, value) { this.values.set(name, String(value)) }
  removeAttribute(name) { this.values.delete(name) }
  addEventListener(name, listener) {
    const entries = this.listeners.get(name) ?? new Set(); entries.add(listener); this.listeners.set(name, entries)
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener) }
  replaceWith(canvas) {
    assert.equal(this.ownerDocument.slot, this)
    this.ownerDocument.slot = canvas; this.isConnected = false; canvas.isConnected = true
  }
  focus() { this.ownerDocument.activeElement = this }
  remove() {
    this.removes++
    if (this.ownerDocument.slot === this) this.ownerDocument.slot = null
    this.isConnected = false
  }
  emit(name) { for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {} }) }
}
function fakeDocument() {
  const document = { hidden: false, activeElement: null, slot: null, hasFocus: () => true }
  document.createElement = () => new FakeCanvas(document)
  const initial = document.createElement(); document.slot = initial; initial.isConnected = true
  initial.setAttribute('id', 'preview'); initial.setAttribute('aria-label', 'Mini app'); initial.setAttribute('tabindex', '0')
  return { document, initial }
}
class FakeRpc {
  actualFinalContract = '1.0'
  workerEpoch = owner.workerEpoch
  sessionId = owner.sessionId
  calls = []
  closes = 0
  handlers = new Map()
  enqueue(op, value) {
    const values = this.handlers.get(op) ?? []; values.push(value); this.handlers.set(op, values)
  }
  requestHost(op, payload, options) {
    this.calls.push({ op, payload, options })
    const values = this.handlers.get(op)
    if (!values?.length) return Promise.reject(new Error(`unexpected RPC ${op}`))
    const value = values.shift()
    return new Promise((resolve, reject) => {
      let retired = false
      const abort = () => { retired = true; reject(Object.assign(new Error('cancelled'), { code: 'ERR_RPC_CANCELLED' })) }
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
      Promise.resolve(typeof value === 'function' ? value(payload) : value).then(result => {
        options.signal.removeEventListener('abort', abort)
        if (retired) options.onLateResponse({ payload: { status: 'ok', result } }); else resolve(result)
        options.onActualFinal?.({ version: '1.0', status: 'final', requestId: `test-${this.calls.length}` })
      }, error => {
        options.signal.removeEventListener('abort', abort)
        if (retired) options.onLateResponse({ payload: { status: 'error', error } }); else reject(error)
        options.onActualFinal?.({ version: '1.0', status: 'final', requestId: `test-${this.calls.length}` })
      })
    })
  }
  close() { this.closes++; throw new Error('adapter must not close borrowed RPC') }
}
function environment(overrides = {}) {
  const { document, initial } = fakeDocument(), rpc = new FakeRpc()
  const created = [], events = [], batches = [], finals = [], errors = []
  const state = { targetScale: 2, failSubmit: false, failDispose: false }
  const presenterFactory = async ({ canvas, signal }) => {
    const presenter = { canvas, signal, disposals: 0, submissions: 0,
      submit(frame) {
        this.submissions++
        if (state.failSubmit) { canvas.submitted = 'damaged-back-buffer'; throw new Error('driver failure') }
        canvas.submitted = frame.frame_id
        return submitted(frame, canvas, this.submissions)
      },
      dispose() { this.disposals++; if (state.failDispose) throw new Error('delete failed') },
    }
    created.push(presenter); return presenter
  }
  const options = { owner, rpc, externalPresentation: contract, canvas: initial, canvasOwned: true,
    resolveTarget: ({ target }) => target,
    presenterFactory, onBatch: value => batches.push(value), onAck: value => finals.push(value),
    onInput: value => events.push(value), onError: value => errors.push(value), ...overrides }
  const adapter = new WorkerCanvasKitAdapter(options)
  async function publish(revision, { kind = 'template', accepted = null, template = '1', final = ack(revision) } = {}) {
    const ctx = context(revision)
    rpc.enqueue(kind === 'template' ? 'frame' : 'frame.current', frameReply(revision, template, 'frame-effect', state.targetScale))
    rpc.enqueue('ack', final)
    adapter.freezeInput('presentation-start')
    const handle = kind === 'template' ? await adapter.prepareTemplate(demand('0', template), ctx)
      : await adapter.preparePaint(demand(revision, template), accepted, ctx)
    const result = await adapter.present(handle, { ...ctx, proof: handle.proof, timestamp: 1 })
    await adapter.release(handle, { owner, attemptId: ctx.attemptId, proof: handle.proof, committed: true, retired: false })
    return { result, handle, ctx, accepted: { proof: handle.proof, inputEnabled: result.inputEnabled } }
  }
  return { adapter, rpc, document, initial, created, events, batches, finals, errors, state, publish }
}

test('a native business layout above ordinary RPC nodes reaches presentation while bridge batches keep their own budget', async () => {
  const tree = () => ({ id: 'root', children: Array.from({ length: 400 }, (_, id) => ({ id: String(id), children: [],
    computed_style: Object.fromEntries(Array.from({ length: 40 }, (_, key) => [`property${key}`, 'accepted-style'])) })) })
  const f = environment(), reply = frameReply(); reply.frame.root = tree()
  try {
    const ctx = context(); f.rpc.enqueue('frame', reply); f.rpc.enqueue('ack', ack())
    const handle = await f.adapter.prepareTemplate(demand(), ctx)
    const presented = await f.adapter.present(handle, { ...ctx, proof: handle.proof, timestamp: 1 })
    assert.equal(presented.acknowledged, true); assert.equal(presented.inputEnabled, true)
    assert.equal(f.created[0].submissions, 1)
    await f.adapter.release(handle, { owner, attemptId: ctx.attemptId, proof: handle.proof, committed: true, retired: false })
  } finally { await f.adapter.dispose() }
  const other = environment(), oversized = frameReply(); oversized.frame.root = tree(); oversized.batch.messages = Array(20000).fill(null)
  try {
    other.rpc.enqueue('frame', oversized)
    await assert.rejects(other.adapter.prepareTemplate(demand(), context()), { code: 'ERR_RPC_PAYLOAD_TOO_LARGE' })
  } finally { await other.adapter.dispose() }
})

test('requires owner-matched borrowed RPC, explicit negotiated contract and owned canvas', () => {
  const { initial } = fakeDocument(), rpc = new FakeRpc()
  const options = { owner, rpc, canvas: initial, canvasOwned: true, externalPresentation: contract,
    resolveTarget() {}, onBatch() {}, presenterFactory() {} }
  assert.throws(() => new WorkerCanvasKitAdapter({ ...options, canvasOwned: false }), { code: 'ERR_INVALID_REQUEST' })
  assert.throws(() => new WorkerCanvasKitAdapter({ ...options, externalPresentation: undefined }), { code: 'ERR_PROTOCOL_VERSION' })
  assert.throws(() => new WorkerCanvasKitAdapter({ ...options, externalPresentation: { version: '1.0', consumedInput: '1.0', ackOutcome: '1.0' } }), { code: 'ERR_PROTOCOL_VERSION' })
  assert.throws(() => new WorkerCanvasKitAdapter({ ...options, rpc: { ...rpc, workerEpoch: 'other', requestHost() {} } }), { code: 'ERR_PROTOCOL_VERSION' })
})

test('optional diagnostic stages distinguish clone, submission, visible swap and real runtime ACK', async () => {
  const observed=[]
  const e=environment({onTiming:details=>observed.push({stage:details.stage,details})})
  try {
    const result=await e.publish('1')
    assert.deepEqual(observed.map(value=>value.stage),['clone','submitted','visible-swap','runtime-ack'])
    for(const value of observed)assert.deepEqual(value.details.proof,result.handle.proof)
    assert.deepEqual(observed[0].details.physicalSize,{width:200,height:100})
    assert.equal(observed.some(value=>/compositor|physical-display/.test(value.stage)),false)
    assert.equal(e.adapter.status.inputTimingObserverFailures,0)
  } finally {await e.adapter.dispose()}
})

test('throwing and asynchronous diagnostic observers neither alter publish nor hide driver errors', async () => {
  for(const onTiming of [()=>{throw Error('diagnostic only')},()=>Promise.reject(Error('diagnostic only'))]) {
    const e=environment({onTiming})
    try {
      await e.publish('1')
      assert.equal(e.adapter.status.inputTimingObserverFailures,4)
      e.state.failSubmit=true
      await assert.rejects(e.publish('2'),/driver failure/)
      assert.ok(e.adapter.status.inputTimingObserverFailures>4)
      assert.equal(e.rpc.calls.filter(value=>value.op==='ack').length,1)
      await tick()
    } finally {await e.adapter.dispose()}
  }
})

test('invalid async submit is rejected only after real last use; close cannot dispose it early', async () => {
  const lastUse = deferred(), used = [], ctx = context()
  const e = environment({ presenterFactory: async ({ canvas }) => ({
    submit() { used.push('submit'); return lastUse.promise }, dispose() { used.push('dispose') },
  }) })
  e.rpc.enqueue('frame', frameReply())
  const preparing = e.adapter.prepareTemplate(demand(), ctx)
  const failed = assert.rejects(preparing, { code: 'ERR_PROTOCOL_VERSION' })
  await tick()
  const closing = e.adapter.dispose(), closed = closing.then(() => true, () => true)
  await tick(); assert.deepEqual(used, ['submit'])
  lastUse.reject(new Error('late driver rejection'))
  await failed
  await closed
  assert.deepEqual(used, ['submit', 'dispose'])
  assert.equal(e.rpc.calls.some(call => call.op === 'ack'), false)
})

test('invalid async installer keeps both surfaces owned through a late visible commit', async () => {
  const lastUse = deferred(), ctx = context(); let install
  const e = environment({ installSurface(value) { install = value; return lastUse.promise } })
  e.rpc.enqueue('frame', frameReply())
  const handle = await e.adapter.prepareTemplate(demand(), ctx)
  const presenting = e.adapter.present(handle, { ...ctx, proof: handle.proof })
  const failed = assert.rejects(presenting, { code: 'ERR_PROTOCOL_VERSION' })
  await tick()
  assert.ok(install); assert.equal(e.created[0].disposals, 0)
  const closing = e.adapter.dispose(); const closed = closing.then(() => true, () => true)
  assert.equal(e.adapter.dispose(), closing)
  await tick(); assert.equal(e.created[0].disposals, 0)
  install.previousCanvas.replaceWith(install.canvas); install.commit()
  assert.equal(e.document.slot, install.canvas)
  lastUse.resolve()
  await failed; await closed
  assert.equal(e.created[0].disposals, 1); assert.equal(e.document.slot, null)
  assert.equal(e.rpc.calls.some(call => call.op === 'ack'), false)
})

test('a rejecting async installer is observed and its cause remains on the contract error', async () => {
  const lastUse = deferred(), cause = new Error('late installer rejection'), ctx = context()
  const e = environment({ installSurface() { return lastUse.promise } })
  e.rpc.enqueue('frame', frameReply())
  const handle = await e.adapter.prepareTemplate(demand(), ctx)
  const presenting = e.adapter.present(handle, { ...ctx, proof: handle.proof })
  const failed = assert.rejects(presenting, error => error.code === 'ERR_PROTOCOL_VERSION' && error.cause === cause)
  await tick(); lastUse.reject(cause); await failed
  await e.adapter.dispose().catch(error => assert.ok(error))
  assert.equal(e.rpc.calls.some(call => call.op === 'ack'), false)
})

test('template submits only the detached back buffer and cannot swap or ACK in preparation', async () => {
  const e = environment(), ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply())
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    assert.equal(e.document.slot, e.initial); assert.equal(e.created[0].submissions, 1)
    assert.equal(e.created[0].canvas.isConnected, false)
    assert.deepEqual(e.rpc.calls.map(call => call.op), ['frame'])
    assert.equal(e.adapter.inputAuthority, null); assert.equal(handle.proof.consumedInput.templateRevision, '1')
    assert.equal(Object.isFrozen(handle.proof.consumedInput.viewport), true)
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: true })
  } finally { await e.adapter.dispose() }
})

test('genuine ACK follows local submit/install; effects and local input are preserved', async () => {
  const e = environment()
  try {
    const result = await e.publish('1')
    assert.deepEqual(e.rpc.calls.map(call => call.op), ['frame', 'ack'])
    assert.deepEqual(e.batches.map(value => value.messages[0].op), ['frame-effect', 'ready-effect'])
    assert.equal(result.result.acknowledged, true); assert.equal(e.adapter.inputAuthority.enabled, true)
    assert.deepEqual(e.adapter.status.physicalSize, { width: 200, height: 100 })
    assert.equal(e.document.slot.submitted, 1); assert.equal(e.finals[0].late, false)
    assert.equal(e.adapter.inputAuthority.consumedInput.viewport.width, 100)
  } finally { await e.adapter.dispose() }
  assert.equal(e.rpc.closes, 0); assert.equal(e.document.slot, null)
})

test('surface exposes only immutable bounded local submission facts bound to the original proof', async () => {
  let raw, surface
  const e = environment({ presenterFactory: async ({ canvas }) => ({
    submit(frame) {
      raw = submitted(frame, canvas)
      Object.assign(raw, { owner: { sessionId: 'forged' }, attemptId: '999', surfaceGeneration: '999', renderRevision: '999',
        arbitraryStats: new Uint8Array(4096) })
      Object.defineProperty(raw, 'internal', { get() { throw new Error('internal receipt getter must stay private') } })
      Object.defineProperty(raw.context, 'nativeContext', { get() { throw new Error('context handle must stay private') } })
      return raw
    }, dispose() {},
  }), onSurface: value => { surface = value; assert.equal(e.adapter.inputAuthority, null); assert.equal(e.finals.length, 0) } })
  try {
    const result = await e.publish('1'), local = surface.submission
    assert.deepEqual(Object.keys(local).sort(), ['version', 'status', 'owner', 'attemptId', 'surfaceGeneration', 'renderRevision',
      'frameId', 'presenterGeneration', 'viewport', 'physicalSize', 'backend', 'context', 'runtimeBoundary', 'presentation'].sort())
    assert.equal(local.owner, e.adapter.owner); assert.deepEqual(local.owner, owner)
    assert.equal(local.status, 'submitted'); assert.equal(local.attemptId, result.handle.proof.attemptId)
    assert.equal(local.surfaceGeneration, result.handle.proof.surfaceGeneration); assert.equal(local.renderRevision, '1')
    assert.equal(local.frameId, 1); assert.equal(local.presenterGeneration, 1)
    assert.deepEqual(local.viewport, rect()); assert.deepEqual(local.physicalSize, { width: 200, height: 100 })
    assert.equal(local.context.physicalHardware, 'unknown'); assert.equal(local.context.nativeContext, undefined)
    assert.equal(local.presentation.gpuCompletion, 'not-waited'); assert.equal(local.accepted, undefined)
    for (const object of [surface, local, local.owner, local.viewport, local.physicalSize, local.context, local.runtimeBoundary, local.presentation]) {
      assert.equal(Object.isFrozen(object), true)
    }
    raw.context.vendor = 'mutated'; raw.viewport.width = 999; raw.physicalSize[0] = 999
    assert.equal(local.context.vendor, 'test vendor'); assert.equal(local.viewport.width, 100); assert.equal(local.physicalSize.width, 200)
    assert.throws(() => { local.context.vendor = 'forged' }, TypeError)
    assert.equal(e.adapter.inputAuthority.enabled, true)
  } finally { await e.adapter.dispose() }
})

test('invalid local receipts reject before swap/ACK and retain candidate cleanup ownership', async t => {
  const invalid = [
    ['schema', value => { value.schemaVersion = 2 }], ['backend', value => { value.backend = 'software' }],
    ['status', value => { value.status = 'accepted' }], ['frame', value => { value.frameId = 2 }],
    ['unsafe frame', value => { value.frameId = Number.MAX_SAFE_INTEGER + 1 }],
    ['generation zero', value => { value.generation = 0 }], ['generation gap', value => { value.generation = 2 }],
    ['unsafe generation', value => { value.generation = Number.MAX_SAFE_INTEGER + 1 }],
    ['viewport', value => { value.viewport.width = 99 }], ['physical size', value => { value.physicalSize[0] = 99 }],
    ['size suffix', value => { value.physicalSize.push(1) }], ['api', value => { value.context.api = 'webgl' }],
    ['software surface', value => { value.context.surfaceIsGpu = false }], ['lost context', value => { value.context.contextLost = true }],
    ['hardware inference', value => { value.context.physicalHardware = true }], ['gl error', value => { value.presentation.glError = 1282 }],
    ['readback wait', value => { value.presentation.gpuCompletion = 'waited' }],
    ['node calls', value => { value.runtimeBoundary.perNodeRuntimeCalls = 1 }],
    ['software upload', value => { value.runtimeBoundary.softwareRgbaUploads = 1 }],
    ['missing context', value => { delete value.context }], ['null vendor', value => { value.context.vendor = null }],
    ['missing optional context field', value => { delete value.context.unmaskedVendor }],
    ['UTF8 limit', value => { value.context.renderer = '界'.repeat(171) }],
  ]
  for (const [name, mutate] of invalid) await t.test(name, async () => {
    let disposals = 0, surfaces = 0
    const e = environment({ presenterFactory: async ({ canvas }) => ({
      submit(frame) { const receipt = submitted(frame, canvas); mutate(receipt); return receipt },
      dispose() { disposals++ },
    }), onSurface() { surfaces++ } }), ctx = context()
    try {
      e.rpc.enqueue('frame', frameReply())
      await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), { code: 'ERR_RENDER' })
      assert.equal(e.document.slot, e.initial); assert.equal(surfaces, 0); assert.equal(e.adapter.inputAuthority, null)
      assert.equal(e.rpc.calls.some(call => call.op === 'ack'), false)
      assert.equal(disposals, 1)
    } finally { await e.adapter.dispose() }
    assert.equal(disposals, 1); assert.equal(e.adapter.status.ownedSurfaces, 0)
  })
})

test('context bounds count UTF8 bytes and preserve nullable debug strings', async () => {
  let seen
  const e = environment({ presenterFactory: async ({ canvas }) => ({
    submit(frame) {
      const receipt = submitted(frame, canvas); receipt.context.vendor = 'é'.repeat(256)
      receipt.context.unmaskedVendor = '界'.repeat(170); return receipt
    }, dispose() {},
  }), onSurface: value => { seen = value.submission } })
  try {
    await e.publish('1'); assert.equal(new TextEncoder().encode(seen.context.vendor).byteLength, 512)
    assert.equal(seen.context.unmaskedRenderer, null)
  } finally { await e.adapter.dispose() }
})

test('receipt getters are sampled once before validation and never re-read for publication', async () => {
  let reads = 0, vendorReads = 0, seen
  const e = environment({ presenterFactory: async ({ canvas }) => ({
    submit(frame) {
      const receipt = submitted(frame, canvas)
      Object.defineProperty(receipt, 'frameId', { get() { return ++reads === 1 ? frame.frame_id : 999 } })
      Object.defineProperty(receipt.context, 'vendor', { get() { return ++vendorReads === 1 ? 'original vendor' : null } })
      return receipt
    }, dispose() {},
  }), onSurface: value => { seen = value.submission } })
  try {
    await e.publish('1'); assert.equal(reads, 1); assert.equal(vendorReads, 1)
    assert.equal(seen.frameId, 1); assert.equal(seen.context.vendor, 'original vendor')
  } finally { await e.adapter.dispose() }
})

test('retirement immediately after visible install suppresses surface evidence and preserves its close owner', async () => {
  let surfaces = 0
  const ctx = context(), e = environment({ installSurface({ previousCanvas, canvas, commit }) {
    previousCanvas.replaceWith(canvas); commit(); ctx.mutable.current = false
  }, onSurface() { surfaces++ } })
  try {
    e.rpc.enqueue('frame', frameReply())
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    await assert.rejects(e.adapter.present(handle, { ...ctx, proof: handle.proof }), { code: 'ERR_CANCELLED' })
    assert.equal(surfaces, 0); assert.equal(e.document.slot.submitted, 1); assert.equal(e.adapter.owner.sessionId, owner.sessionId)
    assert.equal(e.rpc.calls.some(call => call.op === 'ack'), false)
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: true })
    assert.equal(e.created[0].disposals, 0)
  } finally { await e.adapter.dispose() }
  assert.equal(e.created[0].disposals, 1); assert.equal(e.document.slot, null)
})

test('throwing surface observer keeps installed ownership without fabricating ACK or input', async () => {
  let seen
  const e = environment({ onSurface(value) { seen = value.submission; throw new Error('surface observer failed') } }), ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply())
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    await assert.rejects(e.adapter.present(handle, { ...ctx, proof: handle.proof }), /surface observer failed/)
    assert.equal(seen.status, 'submitted'); assert.equal(e.document.slot.submitted, 1)
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: false })
    assert.equal(e.created[0].disposals, 0); assert.equal(e.adapter.inputAuthority, null)
    assert.equal(e.rpc.calls.some(call => call.op === 'ack'), false)
  } finally { await e.adapter.dispose() }
  assert.equal(e.created[0].disposals, 1); assert.equal(e.document.slot, null)
})

test('owner or surface-generation relabeling cannot install or acknowledge a prepared surface', async t => {
  for (const field of ['owner', 'surfaceGeneration', 'proof']) await t.test(field, async () => {
    let surfaces = 0
    const e = environment({ onSurface() { surfaces++ } }), ctx = context()
    try {
      e.rpc.enqueue('frame', frameReply())
      const handle = await e.adapter.prepareTemplate(demand(), ctx), presentation = { ...ctx, proof: handle.proof }
      if (field === 'owner') presentation.owner = { ...owner, sessionId: 'other-owner' }
      else if (field === 'surfaceGeneration') presentation.surfaceGeneration = '2'
      else presentation.proof = { ...handle.proof, owner: { ...owner, workerEpoch: 'other-worker' } }
      await assert.rejects(e.adapter.present(handle, presentation), { code: 'ERR_PROTOCOL_VERSION' })
      assert.equal(e.created[0].submissions, 1); assert.equal(e.document.slot, e.initial); assert.equal(surfaces, 0)
      assert.equal(e.rpc.calls.some(call => call.op === 'ack'), false)
      await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: true })
    } finally { await e.adapter.dispose() }
    assert.equal(e.created[0].disposals, 1); assert.equal(e.adapter.owner.sessionId, owner.sessionId)
  })
})

test('retained paint uses frame.current and the exact accepted consumed input', async () => {
  const e = environment()
  try {
    const first = await e.publish('1')
    await e.publish('2', { kind: 'paint', accepted: first.accepted })
    assert.deepEqual(e.rpc.calls.map(call => call.op), ['frame', 'ack', 'frame.current', 'ack'])
    assert.equal(e.created.length, 2)
  } finally { await e.adapter.dispose() }
})

test('same-size frames alternate at most two owned presenters without touching the front buffer', async () => {
  const e = environment()
  try {
    await e.publish('1'); const a = e.document.slot
    await e.publish('2'); const b = e.document.slot
    assert.notEqual(a, b); assert.equal(a.submitted, 1)
    await e.publish('3'); assert.equal(e.document.slot, a)
    await e.publish('4'); assert.equal(e.document.slot, b)
    assert.equal(e.created.length, 2); assert.equal(e.adapter.status.ownedPresenters, 2)
    assert.deepEqual(e.created.map(presenter => presenter.submissions), [2, 2])
  } finally { await e.adapter.dispose() }
  assert.deepEqual(e.created.map(presenter => presenter.disposals), [1, 1])
})

test('density replacement keeps logical input and disposes both superseded-size surfaces', async () => {
  const e = environment()
  try {
    await e.publish('1'); await e.publish('2')
    const old = e.document.slot
    e.state.targetScale = 3
    await e.publish('3')
    assert.notEqual(e.document.slot, old); assert.equal(e.document.slot.width, 300)
    assert.equal(e.adapter.inputAuthority.consumedInput.viewport.width, 100)
    assert.equal(e.adapter.inputAuthority.surfaceGeneration, '1')
    assert.equal(e.adapter.status.ownedPresenters, 1)
    assert.deepEqual(e.created.slice(0, 2).map(presenter => presenter.disposals), [1, 1])
  } finally { await e.adapter.dispose() }
})

test('old density publication cannot replace an accepted newer physical target', async () => {
  const e = environment()
  try {
    const accepted = await e.publish('2'), front = e.document.slot, count = e.created.length
    e.rpc.enqueue('frame.current', frameReply('1', '1', 'late-old-density', 1))
    await assert.rejects(e.adapter.preparePaint(demand('2'), accepted.accepted, context('3')), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(e.document.slot, front); assert.equal(front.width, 200); assert.equal(front.height, 100)
    assert.equal(e.created.length, count)
    assert.equal(e.rpc.calls.filter(call => call.op === 'ack').length, 1)
    assert.notEqual(e.adapter.inputAuthority?.publication.renderRevision, '1')
  } finally { await e.adapter.dispose() }
})

test('submit failure damages only detached back buffer and sends no ACK', async () => {
  const e = environment()
  try {
    await e.publish('1'); const front = e.document.slot
    e.state.failSubmit = true
    const ctx = context('2'); e.rpc.enqueue('frame', frameReply('2'))
    await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), /driver failure/)
    assert.equal(e.document.slot, front); assert.equal(front.submitted, 1)
    assert.equal(e.rpc.calls.filter(call => call.op === 'ack').length, 1)
    assert.equal(e.created[1].disposals, 1); assert.equal(e.adapter.inputAuthority, null)
  } finally { await e.adapter.dispose() }
})

test('wrong exact-frame target and over-budget physical target fail before GPU creation', async () => {
  for (const target of [
    { version: '1.0', sessionId: 'other', renderRevision: '1', width: 200, height: 100 },
    { version: '1.0', sessionId: owner.sessionId, renderRevision: '1', width: 4096, height: 4096 },
  ]) {
    const e = environment({ resolveTarget: () => target }), ctx = context()
    try {
      e.rpc.enqueue('frame', frameReply())
      await assert.rejects(e.adapter.prepareTemplate(demand(), ctx))
      assert.equal(e.created.length, 0); assert.equal(e.document.slot, e.initial)
    } finally { await e.adapter.dispose() }
  }
})

test('a renderer frame cannot infer consumed input from request or current/ACK state', async () => {
  const e = environment(), ctx = context(), raw = frameReply()
  raw.scheduling.consumedInput = null
  try {
    e.rpc.enqueue('frame', raw)
    await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(e.created.length, 0)
  } finally { await e.adapter.dispose() }
})

test('paint cannot relabel a different consumed template revision', async () => {
  const e = environment()
  try {
    const first = await e.publish('1'), ctx = context('2')
    e.rpc.enqueue('frame.current', frameReply('2', '2'))
    await assert.rejects(e.adapter.preparePaint(demand('2', '2'), first.accepted, ctx), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(e.rpc.calls.filter(call => call.op === 'frame').length, 1)
  } finally { await e.adapter.dispose() }
})

test('ACK-issued revision is never acknowledged a second time', async () => {
  const e = environment()
  try {
    await e.publish('1'); const ctx = context('2')
    e.rpc.enqueue('frame', frameReply())
    await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(e.rpc.calls.filter(call => call.op === 'ack').length, 1)
  } finally { await e.adapter.dispose() }
})

test('ready failure is an acknowledged disabled outcome with all real error effects', async () => {
  const e = environment()
  try {
    const effects = { messages: [message('error', { code: 'ERR_ENGINE', message: 'ready failed' }), message('diagnostic', { detail: 'kept' })] }
    const final = ack('1', { inputEnabled: false, batch: effects })
    const value = await e.publish('1', { final })
    assert.equal(value.result.acknowledged, true); assert.equal(value.result.inputEnabled, false)
    assert.equal(e.adapter.inputAuthority, null); assert.deepEqual(e.batches.at(-1), effects)
  } finally { await e.adapter.dispose() }
})

test('focus and accessible attributes survive a swap while width/height use physical target', async () => {
  const e = environment()
  try {
    e.initial.focus(); e.initial.setAttribute('style', 'width:100px;height:50px')
    await e.publish('1')
    const canvas = e.document.slot
    assert.equal(e.document.activeElement, canvas)
    assert.equal(canvas.values.get('aria-label'), 'Mini app'); assert.equal(canvas.values.get('tabindex'), '0')
    assert.equal(canvas.values.get('style'), 'width:100px;height:50px')
    assert.equal(canvas.width, 200)
  } finally { await e.adapter.dispose() }
})

test('local installed state is retained when a genuine final arrives after hard retirement', async () => {
  const e = environment(), late = deferred(), ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply()); e.rpc.enqueue('ack', late.promise)
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    const pending = e.adapter.present(handle, { ...ctx, proof: handle.proof })
    await tick(); assert.equal(e.document.slot.submitted, 1)
    ctx.mutable.current = false; ctx.controller.abort('page changed')
    await assert.rejects(pending, { code: 'ERR_RPC_CANCELLED' })
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: true })
    assert.equal(e.document.slot.submitted, 1); assert.equal(e.created[0].disposals, 0)
    late.resolve(ack()); await tick()
    assert.equal(e.finals.at(-1).late, true); assert.equal(e.adapter.inputAuthority, null)
    assert.equal(e.batches.at(-1).messages[0].op, 'ready-effect')
  } finally { await e.adapter.dispose() }
})

test('late successful frame preserves effects and creates no local presenter or ACK', async () => {
  const e = environment(), reply = deferred(), ctx = context()
  try {
    e.rpc.enqueue('frame', reply.promise)
    const pending = e.adapter.prepareTemplate(demand(), ctx)
    await tick(); ctx.controller.abort('retired')
    await assert.rejects(pending, { code: 'ERR_RPC_CANCELLED' })
    reply.resolve(frameReply()); await tick()
    assert.equal(e.created.length, 0); assert.equal(e.rpc.calls.length, 1)
    assert.equal(e.batches.at(-1).messages[0].op, 'frame-effect')
  } finally { await e.adapter.dispose() }
})

test('late presenter initialization is disposed before the cancelled preparation settles', async () => {
  const made = deferred(), started = deferred(), resources = []
  const e = environment({ presenterFactory: async ({ canvas }) => {
    started.resolve(); await made.promise
    const resource = { disposeCalls: 0, submit() {}, dispose() { this.disposeCalls++ } }
    resources.push(resource); return resource
  } }), ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply())
    const pending = e.adapter.prepareTemplate(demand(), ctx)
    await started.promise; ctx.controller.abort('retired'); made.resolve()
    await assert.rejects(pending, { code: 'ERR_CANCELLED' })
    assert.equal(resources[0].disposeCalls, 1); assert.equal(e.document.slot, e.initial)
    assert.equal(e.adapter.status.ownedPresenters, 0)
  } finally { await e.adapter.dispose() }
})

test('callback reentrancy can retire after local swap without issuing an ACK or restoring input', async () => {
  let ctx
  const e = environment({ onSurface: () => { ctx.mutable.current = false; ctx.controller.abort('retired from rebind') } })
  ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply())
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    await assert.rejects(e.adapter.present(handle, { ...ctx, proof: handle.proof }), { code: 'ERR_CANCELLED' })
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: true })
    assert.equal(e.document.slot.submitted, 1); assert.equal(e.adapter.inputAuthority, null)
    assert.equal(e.rpc.calls.filter(call => call.op === 'ack').length, 0)
  } finally { await e.adapter.dispose() }
})

test('ACK transport failure carries real committed effects and cannot imply visual rollback', async () => {
  const e = environment(), ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply())
    e.rpc.enqueue('ack', () => Promise.reject(Object.assign(new Error('wire final invalid'), { details: { code: 'ERR_PROTOCOL_VERSION',
      details: { acknowledged: true, batch: batch('committed-effect') } } })))
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    await assert.rejects(e.adapter.present(handle, { ...ctx, proof: handle.proof }), /wire final invalid/)
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: false })
    assert.equal(e.batches.at(-1).messages[0].op, 'committed-effect')
    assert.equal(e.document.slot.submitted, 1); assert.equal(e.adapter.inputAuthority, null)
  } finally { await e.adapter.dispose() }
})

test('cancel/dispose barriers are stable, settle owned RPC waits and leave borrowed RPC open', async () => {
  const e = environment(), reply = deferred(), ctx = context()
  e.rpc.enqueue('frame', reply.promise)
  const pending = e.adapter.prepareTemplate(demand(), ctx)
  await tick()
  const cancellation = e.adapter.cancelOwnedWork('closing')
  assert.equal(e.adapter.cancelOwnedWork('again'), cancellation)
  await assert.rejects(pending, { code: 'ERR_RPC_CANCELLED' }); await cancellation
  const disposal = e.adapter.dispose(); assert.equal(e.adapter.dispose(), disposal)
  await disposal
  assert.equal(e.rpc.closes, 0); assert.equal(e.adapter.status.pendingOperations, 0)
  assert.equal(e.adapter.status.ownedSurfaces, 0)
  reply.resolve(frameReply()); await tick()
  assert.equal(e.created.length, 0)
})

test('cleanup failure is observable and is never rewritten as successful disposal', async () => {
  const e = environment()
  await e.publish('1'); e.state.failDispose = true
  await assert.rejects(e.adapter.dispose(), /delete failed/)
  assert.equal(e.rpc.closes, 0); assert.equal(e.created[0].disposals, 1)
})

test('a custom installer throwing after its swap preserves installed ownership for cleanup', async () => {
  const e = environment({ installSurface: ({ previousCanvas, canvas, commit }) => {
    previousCanvas.replaceWith(canvas); commit(); throw new Error('post-swap notification failed')
  } }), ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply())
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    await assert.rejects(e.adapter.present(handle, { ...ctx, proof: handle.proof }), /post-swap/)
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: false })
    assert.equal(e.document.slot.submitted, 1); assert.equal(e.created[0].disposals, 0)
    assert.equal(e.rpc.calls.filter(call => call.op === 'ack').length, 0)
  } finally { await e.adapter.dispose() }
})

test('a freeze inside the ACK observer cannot be undone by the same successful final', async () => {
  let adapter
  const e = environment({ onAck: () => adapter.freezeInput('owner-froze-during-ack') }), ctx = context()
  adapter = e.adapter
  try {
    e.rpc.enqueue('frame', frameReply()); e.rpc.enqueue('ack', ack())
    const handle = await adapter.prepareTemplate(demand(), ctx)
    await assert.rejects(adapter.present(handle, { ...ctx, proof: handle.proof }), { code: 'ERR_CANCELLED' })
    await adapter.release(handle, { owner, attemptId: '1', committed: false, retired: true })
    assert.equal(adapter.inputAuthority, null); assert.equal(e.document.slot.submitted, 1)
    assert.equal(e.rpc.calls.filter(call => call.op === 'ack').length, 1)
  } finally { await adapter.dispose() }
})

test('missing exact Worker target fails without guessing from logical viewport or display density', async () => {
  const e = environment(), ctx = context(), raw = frameReply()
  delete raw.target
  try {
    e.rpc.enqueue('frame', raw)
    await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(e.created.length, 0); assert.equal(e.document.slot, e.initial)
  } finally { await e.adapter.dispose() }
})

test('an optional target hook cannot relabel wire dimensions with latest density', async () => {
  const e = environment({ resolveTarget: ({ target }) => ({ ...target, width: 300, height: 150 }) }), ctx = context()
  try {
    e.rpc.enqueue('frame', frameReply())
    await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(e.created.length, 0)
  } finally { await e.adapter.dispose() }
})

test('genuine restart-required ACK remains acknowledged with input disabled', async () => {
  const e = environment()
  try {
    const value = await e.publish('1', { final: ack('1', { inputEnabled: false, requiresRestart: true }) })
    assert.equal(value.result.acknowledged, true); assert.equal(value.result.requiresRestart, true)
    assert.equal(value.result.inputEnabled, false); assert.equal(e.adapter.inputAuthority, null)
  } finally { await e.adapter.dispose() }
})

function afterCommittedFailure(result) {
  return Object.assign(new Error('ordered observation refresh failed after execute'), { code: 'ERR_ENGINE',
    details: { code: 'ERR_ENGINE', message: 'ordered observation refresh failed after execute',
      details: { committedResult: result, observationRefreshError: { code: 'ERR_ENGINE', message: 'counter exhausted' } } } })
}

test('finally failure after frame preserves committedResult.batch without preparing or ACKing it', async () => {
  const e = environment(), ctx = context(), failure = afterCommittedFailure(frameReply())
  try {
    e.rpc.enqueue('frame', () => Promise.reject(failure))
    await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), error => error === failure)
    assert.equal(e.batches.length, 1); assert.equal(e.batches[0].messages[0].op, 'frame-effect')
    assert.equal(e.created.length, 0); assert.equal(e.rpc.calls.filter(call => call.op === 'ack').length, 0)
    assert.equal(e.document.slot, e.initial)
  } finally { await e.adapter.dispose() }
})

test('finally failure after genuine ACK records irreversible final/effects and still rejects present', async () => {
  const e = environment(), ctx = context(), failure = afterCommittedFailure(ack())
  try {
    e.rpc.enqueue('frame', frameReply()); e.rpc.enqueue('ack', () => Promise.reject(failure))
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    await assert.rejects(e.adapter.present(handle, { ...ctx, proof: handle.proof }), error => error === failure)
    assert.equal(e.finals.length, 1); assert.equal(e.finals[0].failed, true)
    assert.equal(e.finals[0].outcome.acknowledged, true); assert.equal(e.finals[0].outcome.renderRevision, '1')
    assert.equal(e.adapter.status.lastAck.acknowledged, true)
    assert.equal(e.batches.filter(value => value.messages[0]?.op === 'ready-effect').length, 1)
    assert.equal(e.adapter.inputAuthority, null); assert.equal(e.document.slot.submitted, 1)
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: false })
    assert.equal(e.created[0].disposals, 0)
  } finally { await e.adapter.dispose() }
})

test('late finally-error ACK preserves committedResult outcome without enabling retired input', async () => {
  const e = environment(), ctx = context(), response = deferred()
  try {
    e.rpc.enqueue('frame', frameReply()); e.rpc.enqueue('ack', response.promise)
    const handle = await e.adapter.prepareTemplate(demand(), ctx)
    const pending = e.adapter.present(handle, { ...ctx, proof: handle.proof })
    await tick(); ctx.mutable.current = false; ctx.controller.abort('retired')
    await assert.rejects(pending, { code: 'ERR_RPC_CANCELLED' })
    await e.adapter.release(handle, { owner, attemptId: '1', committed: false, retired: true })
    response.reject(afterCommittedFailure(ack())); await tick()
    assert.equal(e.finals.length, 1); assert.equal(e.finals[0].late, true); assert.equal(e.finals[0].failed, true)
    assert.equal(e.adapter.status.lastAck.renderRevision, '1'); assert.equal(e.adapter.inputAuthority, null)
    assert.equal(e.batches.filter(value => value.messages[0]?.op === 'ready-effect').length, 1)
    assert.equal(e.document.slot.submitted, 1)
  } finally { await e.adapter.dispose() }
})

test('a real loss suspends input nonterminally and a fresh canvas requires a fresh genuine ACK', async () => {
  const losses = [], e = environment({ onSurfaceLost: value => losses.push(value) })
  const first = await e.publish('1'), lost = e.adapter.canvas
  assert.equal(e.adapter.inputAuthority.enabled, true)
  lost.emit('webglcontextlost')
  assert.equal(e.adapter.inputAuthority, null)
  assert.equal(e.adapter.status.surfaceSuspended, true)
  assert.equal(e.adapter.status.closing, false)
  assert.equal(e.errors.length, 0)
  assert.equal(losses.length, 1)
  assert.deepEqual(losses[0], { version: '1.0', owner, lossId: '1', reason: 'webglcontextlost' })
  lost.emit('webglcontextlost')
  assert.equal(losses.length, 1, 'the same loss cannot create multiple recovery transactions')
  const drain = e.adapter.suspendOwnedSurface()
  assert.equal(e.adapter.suspendOwnedSurface(), drain)
  await drain
  assert.equal(e.created[0].disposals, 0)
  e.adapter.resumeOwnedSurface()
  assert.equal(e.created[0].disposals, 1)
  assert.equal(e.document.slot, lost, 'retired canvas remains only the visible replacement anchor')
  assert.equal(e.adapter.inputAuthority, null)
  // An event from the retired anchor is not a fresh GPU loss observation.
  lost.emit('webglcontextlost'); assert.equal(losses.length, 1)
  const ctx = { ...context('2'), surfaceGeneration: '2' }, final = deferred()
  const retained = frameReply('2'); retained.frame.frame_id = first.handle.proof.publication.renderRevision === '1' ? 1 : -1
  e.rpc.enqueue('frame.current', retained); e.rpc.enqueue('ack', final.promise)
  const handle = await e.adapter.preparePaint({ ...demand('2'), surfaceGeneration: '2' }, first.accepted, ctx)
  const presenting = e.adapter.present(handle, { ...ctx, proof: handle.proof })
  await tick()
  assert.notEqual(e.adapter.canvas, lost)
  assert.equal(e.adapter.canvas.submitted, 1, 'retained pixels use the existing native frame')
  assert.equal(e.adapter.inputAuthority, null, 'submission is not input authority')
  final.resolve(ack('2')); await presenting
  await e.adapter.release(handle, { owner, attemptId: '2', retired: false })
  assert.equal(e.adapter.inputAuthority.surfaceGeneration, '2')
  assert.equal(e.rpc.closes, 0)
  assert.deepEqual(e.adapter.owner, owner)
  e.adapter.canvas.emit('webglcontextlost')
  assert.equal(losses[1].lossId, '2')
  await e.adapter.dispose()
  assert.equal(e.document.slot, null)
})

test('surface suspension waits the genuine late frame final after local cancellation', async () => {
  const frame = deferred(), e = environment(), ctx = context()
  e.rpc.enqueue('frame', frame.promise)
  const preparing = e.adapter.prepareTemplate(demand(), ctx)
  const cancelled = assert.rejects(preparing, { code: 'ERR_RPC_CANCELLED' })
  await tick()
  const drain = e.adapter.suspendOwnedSurface(); let drained = false
  void drain.then(() => { drained = true })
  await cancelled; await tick()
  assert.equal(drained, false)
  assert.equal(e.adapter.status.actualRemoteOperations, 1)
  assert.equal(e.created.length, 0)
  assert.throws(() => e.adapter.resumeOwnedSurface(), { code: 'ERR_RENDER' })
  frame.resolve(frameReply()); await drain
  assert.equal(e.batches.length, 1, 'real effects survive the retired frame request')
  assert.equal(e.adapter.status.actualRemoteOperations, 0)
  e.adapter.resumeOwnedSurface()
  assert.equal(e.errors.length, 0); await e.adapter.dispose()
})

test('loss during ACK waits its genuine late final and exact scheduler release before reuse', async () => {
  const final = deferred(), e = environment(), ctx = context()
  e.rpc.enqueue('frame', frameReply()); e.rpc.enqueue('ack', final.promise)
  const handle = await e.adapter.prepareTemplate(demand(), ctx)
  const presenting = e.adapter.present(handle, { ...ctx, proof: handle.proof })
  const cancelled = assert.rejects(presenting, { code: 'ERR_RPC_CANCELLED' })
  await tick(); e.adapter.canvas.emit('webglcontextlost')
  const drain = e.adapter.suspendOwnedSurface(); let drained = false
  void drain.then(() => { drained = true })
  await cancelled; await tick()
  assert.equal(drained, false)
  final.resolve(ack()); await drain
  assert.equal(e.adapter.status.lastAck.renderRevision, '1')
  assert.equal(e.finals[0].late, true)
  assert.equal(e.adapter.inputAuthority, null)
  assert.throws(() => e.adapter.resumeOwnedSurface(), { code: 'ERR_RENDER' }, 'a settled ACK does not release its scheduler candidate')
  await e.adapter.release(handle, { owner, attemptId: '1', retired: true })
  e.adapter.resumeOwnedSurface()
  assert.equal(e.created[0].disposals, 1)
  assert.equal(e.errors.length, 0); await e.adapter.dispose()
})

test('a loss during async factory initialization drains the actual resource and does not poison the owner', async () => {
  const factory = deferred(), disposed = [], losses = []; let creating
  const e = environment({ presenterFactory({ canvas }) { creating = canvas; return factory.promise }, onSurfaceLost: value => losses.push(value) })
  const ctx = context(); e.rpc.enqueue('frame', frameReply())
  const preparing = e.adapter.prepareTemplate(demand(), ctx), cancelled = assert.rejects(preparing, { code: 'ERR_CANCELLED' })
  await tick(); assert.ok(creating); creating.emit('webglcontextlost')
  let drained = false; const drain = e.adapter.suspendOwnedSurface().then(() => { drained = true })
  await tick(); assert.equal(drained, false); assert.equal(creating.removes, 0)
  factory.resolve({ submit() { throw new Error('never submit retired initialization') }, dispose() { disposed.push(creating) } })
  await cancelled; await drain
  assert.deepEqual(disposed, [creating]); assert.equal(creating.removes, 1)
  assert.equal(losses.length, 1); assert.equal(e.errors.length, 0)
  e.adapter.resumeOwnedSurface(); await e.adapter.dispose()
})

test('a synchronous loss during submit retires the attempt without a permanent render fault', async () => {
  let disposals = 0
  const e = environment({ presenterFactory: async ({ canvas }) => ({
    submit(frame) { canvas.emit('webglcontextlost'); return submitted(frame, canvas) }, dispose() { disposals++ },
  }) })
  const ctx = context(); e.rpc.enqueue('frame', frameReply())
  await assert.rejects(e.adapter.prepareTemplate(demand(), ctx), { code: 'ERR_CANCELLED' })
  await e.adapter.suspendOwnedSurface()
  assert.equal(e.rpc.calls.some(value => value.op === 'ack'), false)
  e.adapter.resumeOwnedSurface()
  assert.equal(disposals, 1); assert.equal(e.errors.length, 0)
  await e.adapter.dispose()
})

test('invalid async submit remains blocked through actual last use instead of becoming recoverable on loss', async () => {
  const lastUse = deferred(); let canvas, disposals = 0
  const e = environment({ presenterFactory: async value => {
    canvas = value.canvas
    return { submit() { return lastUse.promise }, dispose() { disposals++ } }
  } })
  const ctx = context(); e.rpc.enqueue('frame', frameReply())
  const preparing = e.adapter.prepareTemplate(demand(), ctx)
  const invalid = assert.rejects(preparing, { code: 'ERR_PROTOCOL_VERSION' })
  await tick(); canvas.emit('webglcontextlost')
  const drain = e.adapter.suspendOwnedSurface(); const blocked = assert.rejects(drain, { code: 'ERR_PROTOCOL_VERSION' })
  await tick(); assert.equal(disposals, 0)
  lastUse.resolve(); await invalid; await blocked
  assert.equal(disposals, 1)
  await e.adapter.dispose()
})

test('a lost spare is retired without suspending the currently displayed independent context', async () => {
  const losses = [], e = environment({ onSurfaceLost: value => losses.push(value) })
  await e.publish('1'); const spare = e.adapter.canvas
  await e.publish('2'); spare.emit('webglcontextlost')
  assert.equal(losses.length, 0)
  assert.equal(e.adapter.status.surfaceSuspended, false)
  assert.equal(e.adapter.inputAuthority.enabled, true)
  await e.publish('3')
  assert.equal(e.created[0].disposals, 1, 'the lost spare can never be reused')
  await e.adapter.dispose()
})

function realRpcFixture() {
  const listeners = new Map(), sent = [], timers = new Map(); let now = 0, timer = 0
  const worker = { terminations: 0,
    addEventListener(name, callback) { listeners.set(name, callback) }, removeEventListener(name) { listeners.delete(name) },
    postMessage(message) { sent.push(message) }, terminate() { this.terminations++ },
  }
  const rpc = new WorkerRpcClient({ workerUrl: 'https://example.test/worker.mjs', workerFactory: () => worker,
    workerEpoch: owner.workerEpoch, sessionId: owner.sessionId, requestPrefix: 'request-real', retiredLimit: 1, retiredTtlMs: 1,
    clock: () => now, setTimer: callback => { timers.set(++timer, callback); return timer }, clearTimer: id => timers.delete(id) })
  const reply = (request, result) => listeners.get('message')?.({ data: { ...request, kind: 'response', payload: { status: 'ok', result } } })
  return { rpc, worker, sent, reply, expire() { now += 1000; assert.equal(rpc.retiredCount, 0) } }
}

test('real WorkerRpcClient keeps a cancelled adapter frame pinned beyond diagnostic TTL until its actual final', async () => {
  const f = realRpcFixture(), e = environment({ rpc: f.rpc }), ctx = context()
  const pending = e.adapter.prepareTemplate(demand(), ctx), cancelled = assert.rejects(pending, { code: 'ERR_RPC_CANCELLED' })
  await tick(); const request = f.sent.find(value => value.op === 'frame')
  const drain = e.adapter.suspendOwnedSurface(); await cancelled
  let drained = false; void drain.then(() => { drained = true })
  f.expire(); await tick()
  assert.equal(drained, false); assert.equal(f.rpc.actualFinalCount, 1)
  f.reply(request, frameReply()); await drain
  assert.equal(e.batches.length, 1); assert.equal(f.rpc.actualFinalCount, 0)
  e.adapter.resumeOwnedSurface(); await e.adapter.dispose()
  const closed = f.rpc.close(); f.reply(f.sent.at(-1), { closed: true }); await closed
  await e.adapter.finalizeRemoteWork(); assert.equal(f.worker.terminations, 1)
})

test('real Worker termination unblocks missing remote final as failure and never fabricates a clean recovery', async () => {
  const f = realRpcFixture(), e = environment({ rpc: f.rpc }), ctx = context()
  const pending = e.adapter.prepareTemplate(demand(), ctx), cancelled = assert.rejects(pending, { code: 'ERR_RPC_CANCELLED' })
  await tick(); const drain = e.adapter.suspendOwnedSurface(), uncertain = assert.rejects(drain, { code: 'ERR_RPC_CLEANUP' })
  await cancelled; f.expire()
  // Local GPU work can close first; only the exact Worker shutdown can settle
  // the still-owned remote operation, and its missing final remains an error.
  await e.adapter.dispose()
  const closed = f.rpc.close(); f.reply(f.sent.at(-1), { closed: true }); await closed; await uncertain
  await assert.rejects(e.adapter.finalizeRemoteWork(), { code: 'ERR_RPC_CLEANUP' })
  assert.equal(e.adapter.status.actualRemoteOperations, 0); assert.equal(f.worker.terminations, 1)
})

test('a failed factory with completed cleanup supports an explicit nonterminal retry drain', async () => {
  const factory = deferred(); let canvas
  const e = environment({ presenterFactory(value) { canvas = value.canvas; return factory.promise } })
  const ctx = context(); e.rpc.enqueue('frame', frameReply())
  const pending = e.adapter.prepareTemplate(demand(), ctx), rejected = assert.rejects(pending, /driver creation failed/)
  await tick(); canvas.emit('webglcontextlost')
  const first = e.adapter.suspendOwnedSurface(), blocked = assert.rejects(first, /driver creation failed/)
  factory.reject(new Error('driver creation failed')); await rejected; await blocked
  assert.equal(e.adapter.status.closing, false)
  const retry = e.adapter.suspendOwnedSurface('explicit-retry', { retry: true })
  assert.notEqual(first, retry); await retry
  e.adapter.resumeOwnedSurface(); await e.adapter.dispose()
})

test('throwing presenter cleanup keeps its exact uncertain resource and never double-deletes on recovery or close', async () => {
  const e = environment(); await e.publish('1'); e.state.failDispose = true
  e.adapter.canvas.emit('webglcontextlost'); await e.adapter.suspendOwnedSurface()
  assert.throws(() => e.adapter.resumeOwnedSurface(), /delete failed/)
  assert.equal(e.adapter.status.ownedPresenters, 1)
  assert.equal(e.adapter.status.ownedSurfaces, 1)
  assert.throws(() => e.adapter.resumeOwnedSurface(), /delete failed/)
  await assert.rejects(e.adapter.dispose(), /delete failed/)
  assert.equal(e.created[0].disposals, 1, 'uncertain destruction must never be replayed')
  assert.equal(e.adapter.status.ownedPresenters, 1)
})


// Exercise the actual adapter and scheduler together. Native/Worker responses
// remain fixtures; no test manufactures a scheduler prepared handle or proof.
function scheduledAdapter(overrides = {}) {
  const rafs = new Map(), losses = []; let sequence = 0, recovery, scheduler
  const e = environment({ ...overrides, onSurfaceLost(value) {
    losses.push(value)
    recovery = Promise.all([scheduler.suspendOwnedSurface(), e.adapter.suspendOwnedSurface()])
    void recovery.catch(() => {})
  } })
  scheduler = new PresentationScheduler({ owner, adapter: e.adapter,
    requestFrame(fn) { rafs.set(++sequence, fn); return sequence }, cancelFrame(id) { rafs.delete(id) } })
  return { ...e, scheduler, losses, get recovery() { return recovery },
    async fire() {
      const entry = rafs.entries().next().value
      assert.ok(entry, `no owned RAF while scheduler is ${scheduler.status.phase}`)
      rafs.delete(entry[0]); entry[1](1); await tick(); await tick()
    },
    observe(sequence, revision, template = '1', generation = '1') {
      return scheduler.observe({ sequence, state: { ...demand(revision, template), surfaceGeneration: generation } })
    },
    resume(ticket, { previous = '1', revision = '2', template = '1', sequence = '2', generation = '2' } = {}) {
      this.observe(sequence, revision, template, generation)
      e.adapter.resumeOwnedSurface()
      return scheduler.resumeOwnedSurface(ticket, { version: '1.0', kind: 'retained', sessionId: owner.sessionId,
        previousRenderRevision: previous, renderRevision: revision,
        previousInputLifetimeRevision: '0', inputLifetimeRevision: '1' })
    } }
}

test('actual adapter factory cancellation retains its validated clone without another View turn', async () => {
  const factory = deferred(), final = deferred(), disposed = []; let creating, factories = 0
  const h = scheduledAdapter({ presenterFactory: async ({ canvas }) => {
    if (++factories === 1) { creating = canvas; await factory.promise }
    let submissions = 0
    return { submit(frame) { return submitted(frame, canvas, ++submissions) }, dispose() { disposed.push(canvas) } }
  } })
  try {
    const raw = frameReply('1')
    h.rpc.enqueue('frame', raw); h.observe('1', '0'); await h.fire()
    assert.ok(creating); assert.equal(h.scheduler.status.phase, 'preparing')
    creating.emit('webglcontextlost'); const drain = h.recovery
    creating.emit('webglcontextlost')
    assert.equal(h.losses.length, 1); assert.equal(h.recovery, drain)
    let drained = false; void drain.then(() => { drained = true })
    await tick(); assert.equal(drained, false); assert.equal(disposed.length, 0)
    factory.resolve(); const [ticket] = await drain
    assert.equal(ticket.base.proof.consumedInput.templateRevision, '1')
    raw.scheduling.consumedInput.templateRevision = '999'
    assert.equal(ticket.base.proof.consumedInput.templateRevision, '1', 'proof is copied from the actual clone, never re-read')
    assert.deepEqual(disposed, [creating]); assert.equal(h.adapter.inputAuthority, null)
    assert.deepEqual(h.resume(ticket), { resumed: true, retained: true })
    const retained = frameReply('2'); retained.frame.frame_id = 1
    h.rpc.enqueue('frame.current', retained); h.rpc.enqueue('ack', final.promise)
    await h.fire(); await h.fire()
    assert.deepEqual(h.rpc.calls.map(call => call.op), ['frame', 'frame.current', 'ack'])
    assert.equal(h.adapter.inputAuthority, null, 'recovery proof and local submit are not a final ACK')
    final.resolve(ack('2')); await tick(); await tick()
    assert.equal(h.scheduler.status.accepted.proof.publication.renderRevision, '2')
    assert.equal(h.adapter.inputAuthority.surfaceGeneration, '2')
  } finally { factory.resolve(); final.resolve(ack('2')); await h.scheduler.close(); await h.adapter.finalizeRemoteWork() }
  assert.equal(h.adapter.status.ownedSurfaces, 0); assert.equal(h.document.slot, null)
})

test('real late Worker frame final supplies exact recovery proof after cancellation and diagnostic TTL', async () => {
  let targetResolutions = 0
  const f = realRpcFixture(), h = scheduledAdapter({ rpc: f.rpc,
    resolveTarget: ({ target }) => { targetResolutions++; return target } })
  try {
    h.observe('1', '0'); await h.fire()
    f.reply(f.sent.at(-1), frameReply('1')); await tick(); await tick(); await h.fire()
    f.reply(f.sent.at(-1), ack('1')); await tick(); await tick()
    assert.equal(h.adapter.inputAuthority.enabled, true)
    assert.equal(targetResolutions, 1)
    h.observe('2', '1', '2'); await h.fire()
    const pending = f.sent.at(-1); assert.equal(pending.op, 'frame')
    const lost = h.adapter.canvas
    lost.emit('webglcontextlost'); const drain = h.recovery; lost.emit('webglcontextlost')
    let drained = false; void drain.then(() => { drained = true })
    await tick(); f.expire(); await tick()
    assert.equal(drained, false); assert.equal(f.rpc.actualFinalCount, 1)
    assert.equal(h.losses.length, 1); assert.equal(h.adapter.inputAuthority, null)
    // This is the original request's actual final, not a fabricated prepared
    // handle. The real RPC client delivers it after its public wait is gone.
    const raw = frameReply('2', '2')
    f.reply(pending, raw); await tick(); await tick()
    assert.equal(h.batches.length, 3, 'initial frame/ACK and one late frame batch')
    assert.equal(targetResolutions, 1, 'late proof retention never invokes the target resolver')
    assert.equal(h.adapter.inputAuthority, null, 'late proof is not input admission')
    f.reply(pending, raw); await tick()
    assert.equal(h.batches.length, 3, 'duplicate actual final cannot replay effects')
    h.observe('3', '2', '2')
    const [ticket] = await drain
    assert.equal(f.rpc.actualFinalCount, 0)
    assert.deepEqual(h.resume(ticket, { previous: '2', revision: '3', template: '2', sequence: '4' }),
      { resumed: true, retained: true })
    raw.scheduling.consumedInput.pageId = '999'
    await h.fire(); assert.equal(f.sent.at(-1).op, 'frame.current')
    const retained = frameReply('3', '2'); retained.frame.frame_id = 2
    f.reply(f.sent.at(-1), retained); await tick(); await tick(); await h.fire()
    assert.equal(targetResolutions, 2, 'only the new live presentation resolves a target')
    assert.equal(f.sent.at(-1).op, 'ack'); assert.equal(h.adapter.inputAuthority, null)
    f.reply(f.sent.at(-1), ack('3', { templateRevision: '2' })); await tick(); await tick()
    assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '1')
    assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '2')
    assert.equal(f.sent.filter(call => call.kind === 'request' && call.op === 'frame').length, 2,
      'one initial View and one dirty View, with no extra View for context recovery')
    assert.equal(h.adapter.inputAuthority.surfaceGeneration, '2')
  } finally {
    await h.scheduler.close()
    const closed = f.rpc.close(); f.reply(f.sent.at(-1), { closed: true }); await closed
    await h.adapter.finalizeRemoteWork()
  }
  assert.equal(h.adapter.status.ownedSurfaces, 0); assert.equal(f.worker.terminations, 1)
})

test('close retires the exact late-proof lane without reviving input or another presentation', async () => {
  const f = realRpcFixture(), h = scheduledAdapter({ rpc: f.rpc })
  h.observe('1', '0'); await h.fire()
  const pending = f.sent.at(-1)
  const drain = h.scheduler.suspendOwnedSurface(), adapterDrain = h.adapter.suspendOwnedSurface()
  void drain.catch(() => {}); void adapterDrain.catch(() => {})
  await tick()
  const closedScheduler = h.scheduler.close(); await closedScheduler
  f.reply(pending, frameReply('1')); await adapterDrain
  const ticket = await drain
  assert.equal(ticket.base, null)
  assert.equal(h.scheduler.status.phase, 'closed'); assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.adapter.inputAuthority, null); assert.equal(h.adapter.status.ownedSurfaces, 0)
  assert.equal(f.sent.some(call => call.op === 'ack'), false)
  const closed = f.rpc.close(); f.reply(f.sent.at(-1), { closed: true }); await closed
  await h.adapter.finalizeRemoteWork()
})


test('a malformed late clone never becomes recovery proof or input authority', async () => {
  const f = realRpcFixture(), h = scheduledAdapter({ rpc: f.rpc })
  h.observe('1', '0'); await h.fire()
  const pending = f.sent.at(-1)
  const schedulerDrain = h.scheduler.suspendOwnedSurface(), adapterDrain = h.adapter.suspendOwnedSurface()
  const raw = frameReply('1'); raw.scheduling.sessionId = 'foreign-session'
  f.reply(pending, raw)
  const [ticket] = await Promise.all([schedulerDrain, adapterDrain])
  assert.equal(ticket.base, null); assert.equal(h.adapter.inputAuthority, null)
  assert.equal(h.errors.at(-1).code, 'ERR_CANCELLED')
  assert.equal(h.batches.length, 1, 'real effects remain observable even when clone proof is rejected')
  assert.throws(() => h.adapter.resumeOwnedSurface(), { code: 'ERR_CANCELLED' })
  await assert.rejects(h.scheduler.close())
  const closed = f.rpc.close(); f.reply(f.sent.at(-1), { closed: true }); await closed
  await assert.rejects(h.adapter.finalizeRemoteWork())
  assert.equal(h.adapter.status.ownedSurfaces, 0)
})

test('a genuine late clone cannot revive proof after navigation invalidated its recovery transaction', async () => {
  const f = realRpcFixture(), h = scheduledAdapter({ rpc: f.rpc })
  try {
    h.observe('1', '0'); await h.fire()
    const pending = f.sent.at(-1)
    const schedulerDrain = h.scheduler.suspendOwnedSurface(), adapterDrain = h.adapter.suspendOwnedSurface()
    h.scheduler.observe({ sequence: '2', state: { ...demand('0', '2'),
      currentPage: { pageId: '2', path: 'pages/other/index' } } })
    f.reply(pending, frameReply('1'))
    const [ticket] = await Promise.all([schedulerDrain, adapterDrain])
    assert.equal(ticket.base, null); assert.equal(h.adapter.inputAuthority, null)
    assert.equal(h.scheduler.status.latest.currentPage.pageId, '2')
    assert.equal(h.errors.length, 0)
    assert.equal(f.sent.some(call => call.op === 'ack'), false)
  } finally {
    await h.scheduler.close()
    const closed = f.rpc.close(); f.reply(f.sent.at(-1), { closed: true }); await closed
    await h.adapter.finalizeRemoteWork()
  }
})
