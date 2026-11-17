import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerBridgeTransport } from '../examples/hosts/web-wasm/worker-bridge-transport.mjs'
import { WorkerRpcClient } from '../examples/hosts/web-wasm/worker-session-client.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
const response = (request, payload = { ok: true }) => ({ ...request, kind: 'response', payload })
const key = { sessionId: 'session-bridge', pageId: '1', documentRevision: '2',
  presentationRevision: '3', surfaceGeneration: '4', profile: 'webview' }
const runtimeDiagnostic = { protocolVersion: '1.0', sessionId: 'session-bridge', requestId: '',
  kind: 'response', op: 'error', payload: { ok: false, requiresRestart: true,
    error: { code: 'ERR_TIMEOUT', message: 'touch retirement interrupted', retryable: false } } }

function fixture(t, { rpc: rpcOptions = {}, transport: transportOptions = {} } = {}) {
  const listeners = new Map(), sent = [], timers = new Set(), diagnostics = []
  const worker = {
    terminated: 0,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
    postMessage(message, transfer = []) { sent.push(structuredClone(message, { transfer })) },
    terminate() { this.terminated++ },
  }
  const rpc = new WorkerRpcClient({ workerFactory: () => worker,
    workerEpoch: 'epoch-bridge', sessionId: 'session-bridge', requestPrefix: 'request-bridge',
    timeoutMs: 1000, closeTimeoutMs: 1000,
    setTimer(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback() }, delay)
      timers.add(timer)
      return timer
    },
    clearTimer(timer) { clearTimeout(timer); timers.delete(timer) },
    ...rpcOptions,
  })
  const transport = new WorkerBridgeTransport({ rpc, timeoutMs: 1000,
    onDiagnostic: diagnostic => diagnostics.push(diagnostic), ...transportOptions })
  const requests = () => sent.filter(message => message.kind === 'request')
  const last = () => requests().at(-1)
  const reply = (request, payload = { status: 'ok', result: {} }, changes = {}) => {
    const data = structuredClone({ ...request, kind: 'response', payload, ...changes })
    for (const callback of [...(listeners.get('message') ?? [])]) callback({ data })
  }
  const final = (request, batch) => reply(request, { status: 'ok', result: batch })
  const close = async () => {
    transport.dispose()
    if (rpc.state === 'open') {
      const closing = rpc.close()
      reply(last(), { status: 'ok', result: { closed: true } })
      await closing
    } else await rpc.closed.catch(() => {})
  }
  t.after(async () => {
    await close()
    assert.equal(timers.size, 0, 'owned Worker RPC timers leaked')
    assert.equal(worker.terminated, 1)
    assert.equal([...listeners.values()].reduce((sum, values) => sum + values.size, 0), 0)
  })
  return { rpc, transport, worker, sent, diagnostics, requests, last, reply, final, close }
}

test('uses real outer correlation and preserves the exact inner request and diagnostics', async t => {
  const f = fixture(t)
  let settled = false
  const pending = outcome(f.transport.request('view.prepare', { render: { frameId: 1 } }))
    .then(result => { settled = true; return result })
  await tick()
  const outer = f.last(), inner = outer.payload.envelope
  assert.equal(outer.op, 'bridge')
  assert.equal(inner.sessionId, f.rpc.sessionId)
  assert.equal(inner.op, 'view.prepare')
  assert.notEqual(outer.requestId, inner.requestId)
  f.reply(outer, { status: 'queued' })
  await tick()
  assert.equal(settled, false)
  assert.equal(f.transport.pendingCount, 1)
  const diagnostic = { protocolVersion: '1.0', sessionId: f.rpc.sessionId,
    requestId: '', kind: 'event', op: 'diagnostic', payload: { message: 'ready warning' } }
  f.final(outer, { messages: [response(inner, { ok: true, submission: { key } }), diagnostic] })
  const result = await pending
  assert.equal(result.value.ok, true)
  assert.deepEqual(result.value.submission.key, key)
  assert.deepEqual(result.value.diagnostics, [diagnostic])
  assert.deepEqual(f.diagnostics, [diagnostic])
  assert.equal(f.transport.pendingCount, 0)
  assert.equal(f.rpc.pendingCount, 0)
})

test('inner queued batches and unrelated event finals cannot authorize an operation', async t => {
  const f = fixture(t)
  let settled = false
  const pending = outcome(f.transport.request('view.presented', { permitId: 'permit-1' }))
    .then(result => { settled = true; return result })
  await tick()
  const outer = f.last(), inner = outer.payload.envelope
  f.final(outer, { messages: [response(inner, { ok: true, queued: true })] })
  await tick()
  assert.equal(settled, false)
  assert.equal(f.transport.receiveBatch({ messages: [response({ ...inner, op: 'view.geometry' })] }), 0)
  assert.equal(f.transport.receiveBatch({ messages: [response({ ...inner, requestId: 'unrelated' })] }), 0)
  assert.equal(f.transport.receiveBatch({ messages: [{ ...response(inner), kind: 'event' }] }), 0)
  assert.equal(settled, false)
  assert.equal(f.transport.receiveBatch({ messages: [response(inner, { ok: true, key, inputEnabled: false })] }), 1)
  assert.equal((await pending).value.inputEnabled, false)
  assert.equal(f.transport.receiveBatch({ messages: [response(inner)] }), 0)
})

test('out-of-order outer completions preserve independent inner request correlation', async t => {
  const f = fixture(t)
  const first = outcome(f.transport.request('view.geometry', { epoch: '1' }))
  const second = outcome(f.transport.request('view.events', { epoch: '2' }))
  await tick()
  const [a, b] = f.requests()
  f.final(b, { messages: [response(b.payload.envelope, { ok: true, order: 2 })] })
  assert.equal((await second).value.order, 2)
  assert.equal(f.transport.pendingCount, 1)
  f.final(a, { messages: [response(a.payload.envelope, { ok: true, order: 1 })] })
  assert.equal((await first).value.order, 1)
})

test('runtime errors retain their real code and diagnostics; outer errors do not invent a runtime success', async t => {
  const f = fixture(t)
  const failed = outcome(f.transport.request('view.prepare.commit', {}))
  await tick()
  const outer = f.last()
  f.final(outer, { messages: [response(outer.payload.envelope, { ok: false,
    error: { code: 'ERR_PERMISSION_DENIED', message: 'not permitted' }, diagnostics: [{ code: 'DETAIL' }] })] })
  const result = await failed
  assert.equal(result.error.code, 'ERR_PERMISSION_DENIED')
  assert.deepEqual(result.error.diagnostics, [{ code: 'DETAIL' }])
  const rejected = outcome(f.transport.request('view.geometry', {}))
  await tick()
  f.reply(f.last(), { status: 'error', error: { code: 'ERR_ENGINE', message: 'owner faulted' } })
  assert.equal((await rejected).error.code, 'ERR_ENGINE')
  assert.equal(f.transport.pendingCount, 0)
  assert.equal(f.rpc.state, 'open')
})

test('a returned bridge batch must match the exact inner final and contain no duplicate final', async t => {
  for (const variant of ['session', 'operation', 'request', 'duplicate', 'missing', 'invalid-ok', 'invalid-error']) {
    await t.test(variant, async t => {
      const f = fixture(t)
      const pending = outcome(f.transport.request('view.prepare', {}))
      await tick()
      const outer = f.last(), inner = outer.payload.envelope
      let messages = [response(inner)]
      if (variant === 'session') messages[0].sessionId = 'foreign-session'
      if (variant === 'operation') messages[0].op = 'view.presented'
      if (variant === 'request') messages[0].requestId = 'foreign-request'
      if (variant === 'duplicate') messages.push(response(inner))
      if (variant === 'missing') messages = []
      if (variant === 'invalid-ok') messages[0].payload = { ok: 'true' }
      if (variant === 'invalid-error') messages[0].payload = { ok: false, error: { code: 'ERR_ENGINE' } }
      f.final(outer, { messages })
      assert.equal((await pending).error.code, 'ERR_PROTOCOL_VERSION')
      assert.equal(f.transport.pendingCount, 0)
      assert.equal(f.rpc.state, 'open')
    })
  }
})

test('view.abort uses the reserved owner alias and translates only its real runtime response ID', async t => {
  const f = fixture(t, { rpc: { maxPending: 4, reservedControlSlots: 2 } })
  const first = outcome(f.transport.request('view.geometry', {}))
  const second = outcome(f.transport.request('view.events', {}))
  await tick()
  assert.equal(f.rpc.pendingCount, 2)
  const aborted = outcome(f.transport.request('view.abort', key))
  await tick()
  const outer = f.last()
  assert.equal(outer.op, 'view.abort')
  assert.deepEqual(outer.payload, { key })
  assert.equal(f.rpc.pendingCount, 3, 'abort did not use the reserved control slot')
  const actual = { protocolVersion: '1.0', sessionId: f.rpc.sessionId,
    requestId: 'worker-host-17', kind: 'response', op: 'view.abort', payload: { ok: true } }
  f.final(outer, { messages: [actual] })
  assert.deepEqual(await aborted, { value: { ok: true } })
  assert.equal(actual.requestId, 'worker-host-17', 'adapter mutated the owner result')
  f.transport.dispose()
  assert.equal((await first).error.code, 'ERR_CANCELLED')
  assert.equal((await second).error.code, 'ERR_CANCELLED')
  assert.equal(f.rpc.state, 'open', 'inner disposal closed the borrowed RPC client')
})

test('an ordinary saturated inner table still leaves a slot for the reserved abort alias', async t => {
  const f = fixture(t, { rpc: { maxPending: 4, reservedControlSlots: 2 }, transport: { maxPending: 3 } })
  const first = outcome(f.transport.request('view.geometry', {}))
  const second = outcome(f.transport.request('view.events', {}))
  await tick()
  await assert.rejects(f.transport.request('view.prepare', {}), error => error.code === 'ERR_RENDER')
  assert.equal(f.requests().length, 2)
  const aborted = outcome(f.transport.request('view.abort', key))
  await tick()
  assert.equal(f.transport.pendingCount, 3)
  assert.equal(f.rpc.pendingCount, 3)
  assert.equal(f.last().op, 'view.abort')
  f.final(f.last(), { messages: [{ protocolVersion: '1.0', sessionId: f.rpc.sessionId,
    requestId: 'worker-host-20', kind: 'response', op: 'view.abort', payload: { ok: true } }] })
  assert.equal((await aborted).value.ok, true)
  f.transport.dispose()
  await Promise.all([first, second])
})

test('real response-shaped runtime diagnostics survive normal and alias batches without becoming finals', async t => {
  const f = fixture(t)
  const pending = outcome(f.transport.request('view.prepare', {}))
  await tick()
  const outer = f.last()
  f.final(outer, { messages: [runtimeDiagnostic, response(outer.payload.envelope, { ok: true, submission: { key } })] })
  const prepared = await pending
  assert.equal(prepared.value.ok, true)
  assert.deepEqual(prepared.value.diagnostics, [runtimeDiagnostic])
  assert.equal(f.transport.receiveBatch({ messages: [runtimeDiagnostic] }), 0)
  const aborted = outcome(f.transport.request('view.abort', key))
  await tick()
  f.final(f.last(), { messages: [runtimeDiagnostic, { protocolVersion: '1.0', sessionId: f.rpc.sessionId,
    requestId: 'worker-host-21', kind: 'response', op: 'view.abort', payload: { ok: true } }] })
  const result = await aborted
  assert.equal(result.value.ok, true)
  assert.deepEqual(result.value.diagnostics, [runtimeDiagnostic])
  assert.equal(f.diagnostics.length, 3)
  assert.equal(f.transport.pendingCount, 0)
})

test('abort alias cannot succeed from an outer receipt, mismatched response or duplicate final', async t => {
  for (const variant of ['outer-only', 'queued', 'session', 'operation', 'duplicate', 'invalid-ok', 'invalid-error', 'error']) {
    await t.test(variant, async t => {
      const f = fixture(t)
      const pending = outcome(f.transport.request('view.abort', key))
      await tick()
      const outer = f.last()
      const actual = { protocolVersion: '1.0', sessionId: f.rpc.sessionId,
        requestId: 'worker-host-18', kind: 'response', op: 'view.abort', payload: { ok: true } }
      let batch = { messages: [actual] }
      if (variant === 'outer-only') batch = { ok: true }
      if (variant === 'queued') actual.payload.queued = true
      if (variant === 'session') actual.sessionId = 'foreign-session'
      if (variant === 'operation') actual.op = 'view.presented'
      if (variant === 'duplicate') batch.messages.push({ ...actual })
      if (variant === 'invalid-ok') actual.payload = { ok: 1 }
      if (variant === 'invalid-error') actual.payload = { ok: false, error: 'fake error' }
      if (variant === 'error') actual.payload = { ok: false, error: { code: 'ERR_CANCELLED', message: 'stale key' } }
      f.final(outer, batch)
      assert.equal((await pending).error.code, variant === 'error' ? 'ERR_CANCELLED' : 'ERR_PROTOCOL_VERSION')
      assert.equal(f.transport.pendingCount, 0)
    })
  }
})

test('aborted prepare forwards its exact late outer final once for retired key cleanup', async t => {
  const f = fixture(t)
  const controller = new AbortController(), cleaned = [], cleanup = []
  const pending = outcome(f.transport.request('view.prepare', {}, { signal: controller.signal,
    onLateResponse: result => {
      cleaned.push(result.submission.key)
      const stopped = f.transport.request('view.abort', result.submission.key)
      cleanup.push(stopped)
      return stopped
    } }))
  await tick()
  const outer = f.last(), inner = outer.payload.envelope
  controller.abort()
  assert.equal((await pending).error.code, 'ERR_CANCELLED')
  assert.equal(f.transport.retiredCount, 1)
  assert.equal(f.sent.at(-1).kind, 'cancel')
  const late = { messages: [response(inner, { ok: true, submission: { key } })] }
  f.final(outer, late)
  f.final(outer, late)
  await tick()
  assert.deepEqual(cleaned, [key])
  assert.equal(f.transport.retiredCount, 0)
  const abort = f.last()
  assert.equal(abort.op, 'view.abort')
  assert.deepEqual(abort.payload, { key })
  f.final(abort, { messages: [{ protocolVersion: '1.0', sessionId: f.rpc.sessionId,
    requestId: 'worker-host-19', kind: 'response', op: 'view.abort', payload: { ok: true } }] })
  await Promise.all(cleanup)
  assert.equal(f.rpc.state, 'open')
})

test('both inner and earlier outer timeouts retain exact late prepare cleanup', { timeout: 3000 }, async t => {
  for (const outerFirst of [false, true]) await t.test(outerFirst ? 'outer timeout' : 'inner timeout', async t => {
    const f = fixture(t, { rpc: { timeoutMs: outerFirst ? 10 : 1000 },
      transport: { timeoutMs: outerFirst ? 1000 : 10 } })
    const cleaned = []
    const pending = outcome(f.transport.request('view.prepare', {}, { onLateResponse: value => cleaned.push(value) }))
    await tick()
    const outer = f.last(), inner = outer.payload.envelope
    assert.equal((await pending).error.code, 'ERR_TIMEOUT')
    assert.equal(f.transport.retiredCount, 1)
    f.final(outer, { messages: [response(inner, { ok: true, submission: { key } })] })
    await tick()
    assert.equal(cleaned.length, 1)
    assert.deepEqual(cleaned[0].submission.key, key)
  })
})

test('late final for another inner request fails closed and cannot invoke retired cleanup', async t => {
  const f = fixture(t)
  const controller = new AbortController(), cleaned = []
  const pending = outcome(f.transport.request('view.prepare', {}, { signal: controller.signal,
    onLateResponse: value => cleaned.push(value) }))
  await tick()
  const outer = f.last(), inner = outer.payload.envelope
  controller.abort()
  await pending
  f.final(outer, { messages: [response({ ...inner, requestId: 'foreign-request' }, { ok: true, submission: { key } })] })
  await tick()
  assert.deepEqual(cleaned, [])
  assert.equal(f.rpc.state, 'failed')
  assert.equal(f.rpc.failure.code, 'ERR_RPC_CALLBACK')
  assert.equal(f.rpc.failure.cause.code, 'ERR_PROTOCOL_VERSION')
})

test('late outer errors stay diagnostic and do not authorize or resurrect a retired prepare', async t => {
  const f = fixture(t)
  const controller = new AbortController(), cleaned = []
  const pending = outcome(f.transport.request('view.prepare', {}, { signal: controller.signal,
    onLateResponse: value => cleaned.push(value) }))
  await tick()
  const outer = f.last()
  controller.abort()
  await pending
  f.reply(outer, { status: 'error', error: { code: 'ERR_CANCELLED', message: 'not admitted' } })
  await tick()
  assert.deepEqual(cleaned, [])
  assert.equal(f.diagnostics.at(-1).code, 'ERR_CANCELLED')
  assert.equal(f.rpc.state, 'open')
})

test('disconnect, reconnect and session validation never replace the borrowed Worker session', async t => {
  const f = fixture(t)
  assert.equal(f.transport.currentSession(), f.rpc.sessionId)
  assert.throws(() => f.transport.setSession('other-session'), error => error.code === 'ERR_PROTOCOL_VERSION')
  assert.throws(() => f.transport.reconnect('other-session'), error => error.code === 'ERR_PROTOCOL_VERSION')
  f.transport.setSession(f.rpc.sessionId)
  const pending = outcome(f.transport.request('view.geometry', {}))
  await tick()
  f.transport.disconnect('lost preview')
  assert.equal((await pending).error.code, 'ERR_CANCELLED')
  await assert.rejects(f.transport.request('view.events', {}), error => error.code === 'ERR_CANCELLED')
  f.transport.reconnect()
  const next = outcome(f.transport.request('view.geometry', {}))
  await tick()
  f.final(f.last(), { messages: [response(f.last().payload.envelope)] })
  assert.equal((await next).value.ok, true)
  assert.equal(f.rpc.state, 'open')
})

test('disposal cancels only owned inner work, ignores late batches and leaves shared RPC usable', async t => {
  const f = fixture(t), cleaned = []
  const pending = outcome(f.transport.request('view.prepare', {}, { onLateResponse: value => cleaned.push(value) }))
  await tick()
  const outer = f.last(), inner = outer.payload.envelope
  f.transport.dispose()
  f.transport.dispose()
  assert.equal((await pending).error.code, 'ERR_CANCELLED')
  assert.equal(f.transport.closed, true)
  assert.equal(f.transport.pendingCount, 0)
  assert.equal(f.transport.retiredCount, 0)
  assert.equal(f.transport.receiveBatch({ messages: [response(inner)] }), 0)
  f.final(outer, { messages: [response(inner, { ok: true, submission: { key } })] })
  await tick()
  assert.deepEqual(cleaned, [])
  assert.equal(f.worker.terminated, 0)
  assert.ok(!f.requests().some(request => request.op === 'close'))
  const shared = f.rpc.requestHost('state', {})
  f.reply(f.last(), { status: 'ok', result: { available: true } })
  assert.deepEqual(await shared, { available: true })
  await assert.rejects(f.transport.request('view.geometry', {}), error => error.code === 'ERR_CANCELLED')
})

test('disposal before the deferred send creates no Worker request', async t => {
  const f = fixture(t)
  const pending = outcome(f.transport.request('view.prepare', {}))
  f.transport.dispose()
  assert.equal((await pending).error.code, 'ERR_CANCELLED')
  await tick()
  assert.equal(f.requests().length, 0)
  assert.equal(f.rpc.pendingCount, 0)
})

test('invalid event batches cannot cross the inner session boundary', async t => {
  const f = fixture(t)
  for (const batch of [null, {}, { messages: [null] }, { messages: [{ protocolVersion: '1.0',
    sessionId: 'foreign', requestId: '', kind: 'event', op: 'diagnostic', payload: {} }] }]) {
    assert.throws(() => f.transport.receiveBatch(batch), error => error.code === 'ERR_PROTOCOL_VERSION')
  }
  assert.equal(f.rpc.state, 'open')
})

test('only the exact uncorrelated runtime error shape is admitted as a diagnostic', async t => {
  const f = fixture(t)
  for (const changes of [
    { op: 'view.abort' }, { sessionId: 'foreign' },
    { payload: { ok: true } }, { payload: { ok: false, error: {} } },
    { payload: { ok: false, queued: true, error: runtimeDiagnostic.payload.error } },
  ]) {
    assert.throws(() => f.transport.receiveBatch({ messages: [{ ...runtimeDiagnostic, ...changes }] }),
      error => error.code === 'ERR_PROTOCOL_VERSION')
  }
  const pending = outcome(f.transport.request('view.prepare', {}))
  await tick()
  f.final(f.last(), { messages: [runtimeDiagnostic] })
  assert.equal((await pending).error.code, 'ERR_PROTOCOL_VERSION', 'diagnostic-only batch fabricated a request final')
})

test('constructor rejects missing Worker identity and a missing inner abort reserve', () => {
  for (const rpc of [null, {}, { requestHost() {}, sessionId: 'session' },
    { requestHost() {}, workerEpoch: 'epoch', sessionId: '' }]) {
    assert.throws(() => new WorkerBridgeTransport({ rpc }), error => error.code === 'ERR_PROTOCOL_VERSION')
  }
  for (const maxPending of [1, 0, 1025]) {
    assert.throws(() => new WorkerBridgeTransport({ rpc: { requestHost() {}, sessionId: 'session', workerEpoch: 'epoch' }, maxPending }),
      error => error.code === 'ERR_PROTOCOL_VERSION')
  }
})


test('presenter bridge preserves the captured generation context on ordinary and abort aliases', async t => {
  const f = fixture(t)
  const presentationContext = { presenterBinding: { version: '1.0', sessionId: f.rpc.sessionId, generation: '7', transportBackend: 'browser-view' },
    pageId: '1', inputLifetimeRevision: '8', surfaceGeneration: '4' }
  const pending = f.transport.request('view.prepare', { render: { frameId: 1 } }, { hostContext: { presentationContext } })
  await tick(); const outer = f.last()
  assert.deepEqual(outer.payload.presentationContext, presentationContext)
  f.final(outer, { messages: [response(outer.payload.envelope)] }); await pending
  const aborting = f.transport.request('view.abort', key, { hostContext: { presentationContext } })
  await tick(); const alias = f.last()
  assert.equal(alias.op, 'view.abort'); assert.deepEqual(alias.payload.presentationContext, presentationContext)
  f.final(alias, { messages: [{ protocolVersion: '1.0', sessionId: f.rpc.sessionId, requestId: 'native-generation-abort', kind: 'response', op: 'view.abort', payload: { ok: true } }] })
  await aborting
})


test('sample abort uses the reserved control alias with its versioned exact payload', async t => {
  const f = fixture(t, { transport: { maxPending: 2 } })
  const ordinary = outcome(f.transport.request('view.sample.prepare', {})); await tick()
  await assert.rejects(f.transport.request('view.animation.baseline', {}), /queue full/)
  const payload = { version: '1.0', key }, aborted = f.transport.request('view.sample.abort', payload)
  await tick()
  const outer = f.last()
  assert.equal(outer.op, 'view.sample.abort'); assert.deepEqual(outer.payload, payload)
  f.final(outer, { messages: [{ protocolVersion: '1.0', sessionId: key.sessionId, requestId: 'native-sample-abort',
    kind: 'response', op: 'view.sample.abort', payload: { ok: true, version: '1.0', key, aborted: true } }] })
  assert.equal((await aborted).aborted, true)
  f.transport.dispose(); await ordinary
})
