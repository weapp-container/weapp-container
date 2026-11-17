import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapWorkerApp, workerProductOptions, createWorkerUiTrace, WORKER_UI_TRACE_LIMITS } from '../examples/hosts/web-wasm/worker-app.mjs'

// Authored direct contracts only. These doubles do not establish Worker,
// actual QuickJS, DOM/CanvasKit presentation, GPU or product browser evidence.
const config = () => ({ schemaVersion: 1, execution: 'worker', engine: 'quickjs',
  index: { url: './pack-index.json', sha256: 'a'.repeat(64), size: 1024 },
  rendererPolicy: { mode: 'manifest' }, viewport: { width: 375, height: 667 }, rendererAssets: null })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
function fixture({ loadBarrier, closeBarrier, loadError } = {}) {
  const elements = Object.fromEntries(['surface-root', 'status', 'summary', 'error', 'dispose'].map(id => [id,
    { textContent: '', hidden: true, disabled: true, listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener) },
      removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name) } }]))
  const document = { querySelector: selector => elements[selector.slice(1)] }
  const calls = [], owner = { workerEpoch: 'worker-1', sessionId: 'session-1', transportBackend: 'browser-view', packSha256: 'a'.repeat(64) }
  let hooks
  const session = {
    status: { phase: 'ready', owner, runtimeReady: true, presentation: { accepted: null }, inputEnabled: false },
    async load(options) { calls.push(['load', options]); if (loadError) throw loadError; if (loadBarrier) await loadBarrier.promise; return { runtimeReady: true, owner } },
    async close() { calls.push(['close']); if (closeBarrier) await closeBarrier.promise; return { closed: true } },
  }
  const app = bootstrapWorkerApp({ config: config(), document,
    createSession(value) { hooks = value; return session } })
  return { app, session, elements, calls, owner, hooks,
    emit(value) { session.status = { ...session.status, ...value }; hooks.onState(session.status) } }
}

test('pinned config maps explicitly to frozen owner load arguments without legacy overrides', () => {
  const input = config(), options = workerProductOptions(input, 'pages/home/index')
  assert.deepEqual(options, { engine: 'quickjs', indexUrl: './pack-index.json', indexSha256: 'a'.repeat(64), indexSize: 1024,
    rendererPolicy: { mode: 'manifest' }, viewport: { width: 375, height: 667 }, rendererAssets: null, route: 'pages/home/index' })
  assert.equal(Object.hasOwn(options, 'renderer'), false)
  assert.equal(Object.isFrozen(options), true)
  assert.equal(Object.isFrozen(options.viewport), true)
  input.viewport.width = 999
  assert.equal(options.viewport.width, 375)
  assert.throws(() => workerProductOptions({ ...config(), engine: 'v8' }), { code: 'ERR_ENGINE' })
  assert.throws(() => workerProductOptions({ ...config(), execution: 'legacy' }), { code: 'ERR_INVALID_MANIFEST' })
  assert.throws(() => workerProductOptions({ ...config(), rendererPolicy: { mode: 'force', profile: 'software' } }), { code: 'ERR_UNSUPPORTED_CAPABILITY' })
  assert.throws(() => workerProductOptions({ ...config(), index: { ...config().index, sha256: '' } }), { code: 'ERR_INVALID_MANIFEST' })
})

test('explicit pinned force policy and development startup payload use the real owner load path', () => {
  const input = { ...config(), rendererPolicy: { mode: 'force', profile: 'skia' }, route: 'pages/configured/index',
    data: { count: 4 }, query: { source: 'dev' }, launchOptions: { scene: 1001 } }
  const result = workerProductOptions(input)
  assert.equal(result.rendererPolicy.profile, 'skia')
  assert.equal(result.route, 'pages/configured/index')
  assert.deepEqual(result.data, { count: 4 })
  assert.deepEqual(result.query, { source: 'dev' })
  assert.equal(workerProductOptions(input, 'pages/explicit/index').route, 'pages/explicit/index')
  input.data.count = 99
  assert.equal(result.data.count, 4)
  assert.equal(Object.isFrozen(result.data), true)
})

test('standalone product keeps pinned Skia density and rejects ignored DOM or invalid values', () => {
  const input = { ...config(), rendererPolicy: { mode: 'force', profile: 'skia' } }
  for (const renderScale of [1, 1.5, 2, 3, 4, 'auto']) {
    const options = workerProductOptions({ ...input, renderScale })
    assert.equal(options.renderScale, renderScale)
    assert.deepEqual(options.viewport, { width: 375, height: 667 })
  }
  assert.throws(() => workerProductOptions({ ...input, renderScale: '2' }), { code: 'ERR_RENDER' })
  assert.throws(() => workerProductOptions({ ...input, rendererPolicy: { mode: 'force', profile: 'webview' }, renderScale: 2 }),
    { code: 'ERR_UNSUPPORTED_CAPABILITY' })
})

test('runtime readiness cannot synthesize first presentation or enable input', async () => {
  const f = fixture(); let presented = false
  f.app.presented.then(() => { presented = true })
  await f.app.ready
  await Promise.resolve()
  assert.equal(presented, false)
  assert.match(f.elements.status.textContent, /等待有效画面/)
  assert.equal(f.elements.dispose.disabled, false)
  const accepted = { proof: { publication: { kind: 'browser-view', key: { sessionId: 'session-1' } } }, inputEnabled: true }
  f.emit({ presentation: { accepted }, inputEnabled: true })
  assert.deepEqual((await f.app.presented).accepted, accepted)
  assert.ok(f.app.trace.some(fact => fact.kind === 'first-presentation'))
  await f.app.close()
})

test('close before first load invalidates startup and removes its exact click listener', async () => {
  const f = fixture()
  const close = f.app.close()
  assert.equal(f.app.close(), close)
  await assert.rejects(f.app.ready, { code: 'ERR_CANCELLED' })
  await assert.rejects(f.app.presented, { code: 'ERR_CANCELLED' })
  await close
  assert.equal(f.calls.filter(([name]) => name === 'load').length, 0)
  assert.equal(f.calls.filter(([name]) => name === 'close').length, 1)
  assert.equal(f.elements.dispose.listeners.size, 0)
})

test('late load success after retirement never becomes ready or accepted', async () => {
  const barrier = deferred(), f = fixture({ loadBarrier: barrier })
  await Promise.resolve()
  const close = f.app.close()
  barrier.resolve()
  await assert.rejects(f.app.ready, { code: 'ERR_CANCELLED' })
  await assert.rejects(f.app.presented, { code: 'ERR_CANCELLED' })
  await close
  assert.equal(f.app.trace.some(fact => fact.kind === 'runtime-ready'), false)
})

test('startup errors remain structured and close the owner without fallback', async () => {
  const failure = Object.assign(new Error('pinned pack rejected'), { code: 'ERR_INVALID_MANIFEST' })
  const f = fixture({ loadError: failure })
  await assert.rejects(f.app.ready, error => error === failure)
  await assert.rejects(f.app.presented, error => error === failure)
  assert.equal(f.elements.error.hidden, false)
  assert.match(f.elements.error.textContent, /ERR_INVALID_MANIFEST/)
  assert.equal(f.calls.filter(([name]) => name === 'close').length, 1)
})

test('close waits the actual transferred owner barrier and retains cleanup errors', async () => {
  const barrier = deferred(), f = fixture({ closeBarrier: barrier })
  await f.app.ready
  const task = f.app.close(); let settled = false
  task.finally(() => { settled = true }).catch(() => {})
  await Promise.resolve(); await Promise.resolve()
  assert.equal(settled, false)
  const failure = Object.assign(new Error('owned close failed'), { code: 'ERR_ENGINE' })
  barrier.reject(failure)
  await assert.rejects(task, error => error === failure)
  assert.match(f.elements.error.textContent, /owned close failed/)
})

test('trace is bounded and a restart requirement cannot masquerade as presentation', async () => {
  const f = fixture(); await f.app.ready
  for (let i = 0; i < 200; i++) f.hooks.onBatch({ sequence: i })
  assert.equal(f.app.trace.length, 128)
  f.emit({ requiresRestart: true })
  await assert.rejects(f.app.presented, { code: 'ERR_UNSUPPORTED_CAPABILITY' })
  assert.match(f.elements.error.textContent, /ERR_UNSUPPORTED_CAPABILITY/)
  await f.app.close()
})

test('runtime Worker entry rejects Node/Window before attempting application glue import', async () => {
  await assert.rejects(import('../examples/hosts/web-wasm/runtime-worker.mjs?not-a-dedicated-worker'), error =>
    error.code === 'ERR_ENGINE' && /Dedicated Worker/.test(error.message))
})

test('real Worker entry accepts its first message without eagerly importing application glue', async t => {
  // A scoped realm double exercises the actual entry module. No generated pkg
  // exists here: eager glue loading would fail before registering receive.
  const keys = ['DedicatedWorkerGlobalScope', 'self']
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  t.after(() => keys.forEach((key, i) => saved[i]
    ? Object.defineProperty(globalThis, key, saved[i]) : delete globalThis[key]))
  let receive, resolveReceipt
  const receipt = new Promise(resolve => { resolveReceipt = resolve })
  globalThis.DedicatedWorkerGlobalScope = class {
    static [Symbol.hasInstance](value) { return value === globalThis }
  }
  globalThis.self = { location: { href: 'https://entry.test/runtime-worker.mjs' },
    addEventListener(kind, listener) { assert.equal(kind, 'message'); receive = listener },
    postMessage(value) {
      if (value.kind === 'response' && value.payload?.status !== 'queued') resolveReceipt(value)
    } }
  await import('../examples/hosts/web-wasm/runtime-worker.mjs?first-message-registration')
  assert.equal(typeof receive, 'function')
  receive({ data: { version: '1.0', workerEpoch: 'first-message-worker', sessionId: 'first-message-session',
    requestId: 'first-message-close', kind: 'request', op: 'close', payload: {} } })
  let deadline
  try {
    const result = await Promise.race([receipt, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('first Worker message was lost')), 1000)
    })])
    assert.equal(result.requestId, 'first-message-close')
    assert.equal(result.kind, 'response')
    assert.equal(result.payload.status, 'ok')
    assert.equal(result.payload.result.closed, true)
  } finally { clearTimeout(deadline) }
})

// Trace v2 contracts below are authored but not executed by the patch author.
// These check UI projection, not Worker execution, real RSS or performance.
test('UI projection preserves the real startup batch envelope shape and boolean receipt metadata', () => {
  const trace = createWorkerUiTrace(), sessionId = 'session-product-startup'
  // Shape emitted by the real Worker startup producer. Authored data only:
  // this contract does not substitute for observing an actual browser receipt.
  const batch = { phase: 'startup', messages: ['app.init', 'app.lifecycle', 'page.push', 'render.commit'].map((op, index) => ({
    protocolVersion: '1.0', sessionId, requestId: `startup-${index}`, kind: 'response', op,
    payload: { ok: true, ...(op === 'app.init' ? { engineProviderAvailable: true } : {}),
      unrelatedBusinessPayload: 'x'.repeat(1_000_000) },
  })) }
  const fact = trace.add('batch', batch), messages = fact.value.messages
  assert.equal(fact.kind, 'batch'); assert.equal(fact.profile, 'ui-metadata-v1')
  assert.equal(fact.value.phase, 'startup'); assert.equal(messages.length, 4)
  for (let index = 0; index < batch.messages.length; index++) {
    assert.equal(messages[index].op, batch.messages[index].op)
    assert.equal(messages[index].kind, 'response'); assert.equal(messages[index].sessionId, sessionId)
    assert.equal(messages[index].payload.ok, true)
    assert.equal(Object.hasOwn(messages[index].payload, 'unrelatedBusinessPayload'), false)
  }
  assert.equal(messages[0].payload.engineProviderAvailable, true)
  assert.ok(Buffer.byteLength(JSON.stringify(fact)) <= fact.byteUpperBound)
  const malformed = trace.add('batch', { messages: [{ op: 'app.init', payload: {
    ok: { data: 'not a boolean' }, engineProviderAvailable: 'true',
  } }] })
  assert.equal(malformed.value.messages[0].payload.ok, '[invalid boolean]')
  assert.equal(malformed.value.messages[0].payload.engineProviderAvailable, '[invalid boolean]')
  assert.equal(malformed.truncated, true)
  assert.equal(batch.messages[0].payload.engineProviderAvailable, true)
})

test('UI trace bounds both retained bytes and entries without retaining or freezing native batches', () => {
  const trace = createWorkerUiTrace(), body = 'x'.repeat(16 * 1024 * 1024)
  const originals = [], projected = []
  for (let index = 0; index < 300; index++) {
    const batch = { sequence: index, messages: [
      { requestId: `request-${index}`, op: 'api.result', payload: { data: body, message: body } },
      { requestId: `other-${index}`, op: 'diagnostic', payload: { data: body, message: body } },
      { requestId: `third-${index}`, op: 'api.result', payload: { data: body, message: body } },
    ] }
    originals.push(batch); projected.push(trace.add('batch', batch))
    const stats = trace.stats()
    assert.ok(stats.entries <= WORKER_UI_TRACE_LIMITS.entries)
    assert.ok(stats.retainedByteUpperBound <= WORKER_UI_TRACE_LIMITS.bytes)
    assert.ok(projected.at(-1).byteUpperBound <= WORKER_UI_TRACE_LIMITS.entryBytes)
  }
  assert.ok(trace.stats().evicted > 0)
  assert.ok(trace.stats().entries < WORKER_UI_TRACE_LIMITS.entries, 'byte budget must evict before the count budget')
  assert.ok(trace.snapshot().length <= WORKER_UI_TRACE_LIMITS.entries)
  for (const fact of trace.snapshot()) {
    assert.ok(Buffer.byteLength(JSON.stringify(fact)) <= fact.byteUpperBound)
    assert.equal(fact.truncated, true)
    assert.equal(Object.isFrozen(fact), true)
    assert.equal(Object.isFrozen(fact.value), true)
  }
  assert.notEqual(projected[0].value, originals[0])
  assert.equal(originals[0].messages[0].payload.data, body)
  assert.equal(Object.isFrozen(originals[0]), false)
  originals[0].sequence = 999
  assert.equal(projected[0].value.sequence, 0)
})

test('UI trace does not enumerate, invoke accessors or coerce unsupported business values', () => {
  const trace = createWorkerUiTrace()
  let getters = 0, ownKeys = 0, descriptors = 0, coercions = 0
  const root = { sequence: 7, payload: { data: 1n << 65536n }, messages: [] }
  root.messages.push(root)
  Object.defineProperty(root, 'message', { enumerable: true, get() { getters++; throw new Error('getter must not run') } })
  Object.defineProperty(root, 'toJSON', { value() { coercions++; throw new Error('toJSON must not run') } })
  root[Symbol.toPrimitive] = () => { coercions++; throw new Error('coercion must not run') }
  root[Symbol.iterator] = () => { coercions++; throw new Error('iteration must not run') }
  const proxy = new Proxy(root, {
    ownKeys() { ownKeys++; throw new Error('full enumeration is forbidden') },
    getOwnPropertyDescriptor(target, key) { descriptors++; return Reflect.getOwnPropertyDescriptor(target, key) },
  })
  const fact = trace.add('batch', proxy), encoded = JSON.stringify(fact)
  assert.equal(getters, 0); assert.equal(coercions, 0); assert.equal(ownKeys, 0)
  assert.ok(descriptors < 4000)
  assert.match(encoded, /accessor/)
  assert.match(encoded, /bigint/)
  assert.match(encoded, /shared or circular/)
  assert.equal(fact.truncated, true)
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  assert.match(JSON.stringify(trace.add('batch', revoked.proxy)), /unreadable/)
})

test('UI projection has bounded work for huge arrays, sparse arrays and unreadable descriptors', () => {
  const trace = createWorkerUiTrace(), sparse = []
  sparse.length = 1_000_000_000
  sparse[0] = { op: 'first', payload: { message: 'visible metadata' } }
  const unreadable = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('descriptor unavailable') } })
  const fact = trace.add('batch', { messages: sparse, details: unreadable })
  assert.ok(fact.value.messages.length <= WORKER_UI_TRACE_LIMITS.items)
  assert.equal(fact.value.messages[0].op, 'first')
  assert.match(JSON.stringify(fact), /unreadable/)
  assert.ok(Buffer.byteLength(JSON.stringify(fact)) <= fact.byteUpperBound)
  assert.equal(fact.truncated, true)
})

test('trace readers get immutable current snapshots and stats expose no payloads', async () => {
  const f = fixture(); await f.app.ready
  const before = f.app.trace, count = before.length
  f.hooks.onBatch({ messages: [{ op: 'api.result', payload: { message: 'next' } }] })
  const after = f.app.trace
  assert.notEqual(before, after)
  assert.equal(before.length, count)
  assert.equal(after.length, count + 1)
  assert.equal(Array.isArray(after), true)
  assert.equal(Object.isFrozen(after), true)
  assert.throws(() => after.push({ value: 'cannot inject a raw payload' }), TypeError)
  assert.deepEqual(Object.keys(f.app.traceStats).sort(), ['entries', 'evicted', 'maxBytes', 'maxEntries', 'maxEntryBytes',
    'retainedByteUpperBound', 'schemaVersion'].sort())
  await f.app.close()
})

test('prototype changes do not invoke toJSON or inherited getters in trace and summary rendering', async () => {
  const f = fixture(); await f.app.ready
  const keys = [[Object.prototype, 'toJSON'], [Array.prototype, 'toJSON'], [Object.prototype, 'message'],
    [Object.prototype, 'get'], [Object.prototype, 'nodes'], [Object.prototype, 'depth'],
    [Object.prototype, 'items'], [Object.prototype, 'stringUnits'], [Object.prototype, 'truncated']]
  const saved = keys.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key))
  let invoked = 0, snapshot, stats, summary, failure
  try {
    const define = (object, key, value, accessor = false) => {
      const descriptor = Object.create(null); descriptor.configurable = true
      descriptor[accessor ? 'get' : 'value'] = value
      Object.defineProperty(object, key, descriptor)
    }
    define(Object.prototype, 'toJSON', () => { invoked++; throw new Error('polluted toJSON') })
    define(Array.prototype, 'toJSON', () => { invoked++; throw new Error('polluted array toJSON') })
    define(Object.prototype, 'message', () => { invoked++; throw new Error('inherited message getter') }, true)
    define(Object.prototype, 'get', () => { invoked++; throw new Error('inherited descriptor getter') })
    define(Object.prototype, 'nodes', Infinity); define(Object.prototype, 'depth', Infinity)
    define(Object.prototype, 'items', Infinity); define(Object.prototype, 'stringUnits', Infinity)
    define(Object.prototype, 'truncated', () => { invoked++; throw new Error('inherited flag getter') }, true)
    f.hooks.onBatch({ messages: [{ op: 'api.result', payload: { data: 'x'.repeat(1_000_000) } }] })
    f.emit({ observation: { sequence: '12', state: { data: 'y'.repeat(1_000_000) } } })
    snapshot = JSON.stringify(f.app.trace); stats = f.app.traceStats; summary = f.elements.summary.textContent
  } catch (error) { failure = error }
  finally {
    for (const [object, key] of keys) delete object[key]
    for (let index = 0; index < keys.length; index++) {
      const [object, key] = keys[index]
      if (saved[index]) Object.defineProperty(object, key, saved[index])
    }
  }
  assert.equal(failure, undefined)
  assert.equal(invoked, 0)
  assert.ok(snapshot.length < WORKER_UI_TRACE_LIMITS.bytes)
  assert.ok(summary.length < WORKER_UI_TRACE_LIMITS.entryBytes * 2)
  assert.ok(stats.retainedByteUpperBound <= stats.maxBytes)
  await f.app.close()
})

test('error UI is bounded and never changes the original rejected fault identity', async () => {
  let getters = 0, coercions = 0
  const error = Object.create(null)
  Object.defineProperty(error, 'code', { value: 'ERR_ENGINE' })
  Object.defineProperty(error, 'message', { get() { getters++; throw new Error('error getter must not run') } })
  Object.defineProperty(error, 'toJSON', { value() { coercions++; throw new Error('error toJSON must not run') } })
  error.details = { data: 'private'.repeat(1_000_000) }; error.details.error = error
  const f = fixture({ loadError: error })
  await assert.rejects(f.app.ready, received => received === error)
  await assert.rejects(f.app.presented, received => received === error)
  assert.equal(getters, 0); assert.equal(coercions, 0)
  assert.ok(f.elements.error.textContent.length < 4096)
  assert.match(f.elements.error.textContent, /ERR_ENGINE/)
  assert.equal(f.elements.error.textContent.includes('private'), false)
  assert.equal(error.details.error, error)
  assert.equal(Object.isFrozen(error), false)
  assert.ok(f.app.traceStats.retainedByteUpperBound <= WORKER_UI_TRACE_LIMITS.bytes)
})
