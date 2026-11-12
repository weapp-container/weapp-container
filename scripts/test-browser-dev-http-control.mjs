/** Transport contract tests ONLY. Controlled fetch/streams stand in for HTTP.
 * These tests do not run Rust, a server, a Worker, a browser, a renderer or GPU.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { BrowserDevHttpControl } from '../crates/container-simulator/src/browser-dev-http-control.mjs'

const baseUrl = 'http://127.0.0.1:58730/', runId = 'run-test', clientId = 'client-test'
const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const decode = value => new TextDecoder().decode(value)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {}); return { promise, resolve, reject } }
const drain = async () => { for (let index = 0; index < 80; index++) await Promise.resolve() }
const until = async condition => { for (let index = 0; index < 1000 && !condition(); index++) await Promise.resolve(); assert.ok(condition(), 'controlled boundary was not reached') }
const protocol = failure => failure?.code === 'ERR_PROTOCOL_VERSION'
const request = (serial = 1, command = 'snapshot', payload = {}) => ({ version: '1.0', requestId: `${clientId}:${command === 'stop' ? 'cleanup' : 'control'}-${serial}`, command, payload })
const final = (req, extra = {}) => ({ version: '1.0', requestId: req.requestId, command: req.command, status: 'ok', snapshot: { runId }, result: {}, ...extra })
const ack = (req, raw, outcome = 'compacted') => ({ version: '1.0', requestId: req.requestId, finalSha256: sha256(encode(raw)), outcome })
function response(url, value, { status = 200, headers = {}, chunks, body, ...fields } = {}) {
  const raw = value instanceof Uint8Array ? value : encode(value)
  return { url, status, redirected: false, type: 'basic', headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    body: body ?? new ReadableStream({ start(controller) { for (const chunk of chunks ?? [raw]) controller.enqueue(chunk); controller.close() } }), ...fields }
}
function fixture(handler, options = {}) {
  const calls = []
  const control = new BrowserDevHttpControl({ baseUrl, runId, clientId, secret: 'explicit-test-secret', sha256,
    fetch: async (url, init) => { const call = { url, init, text: decode(init.body) }; calls.push(call); return handler(call, calls.length) }, ...options })
  return { control, calls }
}
async function closed(control) { assert.deepEqual(await control.close(), { closed: true, pendingActual: 0, cleanupFailures: 0 }); assert.equal(control.status.phase, 'closed') }

test('explicit authenticated root transport preserves original bytes and hashes raw final bytes', async () => {
  const req = request(), text = JSON.stringify(req)
  const raw = ` \n${JSON.stringify(final(req), null, 2)}\n`
  const h = fixture(call => response(call.url, call.url.endsWith('/acknowledge') ? ack(req, raw) : raw))
  const value = await h.control.invoke(req)
  assert.equal(h.calls.length, 1, 'receiving a final must not ACK automatically')
  const first = h.calls[0]
  assert.equal(first.url, `${baseUrl}__weapp/control/invoke`); assert.equal(first.text, text)
  assert.equal(first.init.method, 'POST'); assert.equal(first.init.redirect, 'error'); assert.equal(first.init.mode, 'same-origin')
  assert.equal(first.init.credentials, 'same-origin'); assert.equal(first.init.cache, 'no-store'); assert.equal(first.init.referrerPolicy, 'same-origin')
  assert.deepEqual(first.init.headers, { 'Content-Type': 'application/json', 'X-Weapp-Run-Id': runId, 'X-Weapp-Client-Id': clientId, 'X-Weapp-Dev-Secret': 'explicit-test-secret' })
  assert.notEqual(sha256(encode(raw)), sha256(encode(value)), 'raw bytes deliberately differ from JSON reencoding')
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.snapshot))
  assert.throws(() => { value.snapshot.runId = 'other' }, TypeError)
  await h.control.acknowledge(req, value)
  assert.deepEqual(JSON.parse(h.calls[1].text), { version: '1.0', originalRequest: text, finalSha256: sha256(encode(raw)) })
  assert.equal(h.calls[1].url, `${baseUrl}__weapp/control/acknowledge`)
  await closed(h.control)
})

test('root URL, credentials, authentication and finite limits are explicit', () => {
  const options = { baseUrl, runId, clientId, secret: 's', fetch() {}, sha256 }
  for (const change of [{ baseUrl: 'https://example.com/path' }, { baseUrl: 'file:///tmp/' }, { baseUrl: 'http://a:b@localhost/' },
    { baseUrl: `${baseUrl}?a=1` }, { baseUrl: `${baseUrl}#a` }, { secret: '' }, { secret: 'a\nb' }, { runId: '' }, { clientId: 'a/b' },
    { maxRequests: 0 }, { maxRetainedBytes: Infinity }, { maxInFlight: 0 }]) {
    assert.throws(() => new BrowserDevHttpControl({ ...options, ...change }), protocol)
  }
})

const observation = (extra = {}) => ({ version: '1.0', runId, controlRevision: '1', terminalCleanupRevision: '0',
  stopped: false, portableCurrent: false, preview: null, offeredSite: null, ...extra })

for (const mode of ['injected', 'default']) test(`${mode} fetch preserves its receiver contract across control HTTP operations`, async context => {
  const req = request(), raw = final(req), operations = []
  function fetcher(url, init) {
    assert.equal(this, mode === 'default' ? globalThis : undefined, 'a native global and a plain injected adapter have distinct receivers')
    const operation = url.slice(url.lastIndexOf('/') + 1); operations.push(operation)
    assert.equal(init.method, 'POST')
    return response(url, operation === 'observe' ? observation() : operation === 'acknowledge' ? ack(req, raw) : raw)
  }
  if (mode === 'default') context.mock.method(globalThis, 'fetch', fetcher)
  const control = new BrowserDevHttpControl({ baseUrl, runId, clientId, secret: 'receiver-test', sha256,
    ...(mode === 'injected' ? { fetch: fetcher } : {}) })
  try {
    assert.deepEqual(await control.observe(), observation())
    const value = await control.invoke(req)
    assert.equal(value.requestId, req.requestId)
    assert.equal((await control.replay(req)).requestId, req.requestId)
    await control.acknowledge(req, value)
    assert.deepEqual(operations, ['observe', 'invoke', 'replay', 'acknowledge'])
  } finally { await closed(control) }
})

test('read-only observations own a separate bounded lane and retain no command/ACK records', async () => {
  const hold = deferred(), req = request()
  const h = fixture(async call => {
    if (call.url.endsWith('/observe')) { await hold.promise; return response(call.url, observation()) }
    return response(call.url, final(req))
  }, { maxInFlight: 1, maxRecoveryInFlight: 1, maxObservationsInFlight: 1 })
  const observing = h.control.observe(); await until(() => h.calls.length === 1)
  await assert.rejects(h.control.observe(), { code: 'ERR_CAPACITY' })
  assert.equal(h.control.status.requests, 0); assert.equal(h.control.status.retainedBytes, 0)
  assert.equal(h.control.status.lanes.observation.inFlight, 1)
  await h.control.invoke(req); await h.control.replay(req)
  hold.resolve(); const result = await observing
  assert.ok(Object.isFrozen(result)); assert.deepEqual(result, observation())
  assert.equal(h.calls[0].text, '{"version":"1.0"}')
  assert.equal(h.control.status.requests, 1, 'only invoke retained an entry')
  assert.equal(h.control.status.lanes.observation.reservedBytes, 0)
  await closed(h.control)
})

for (const [name, value] of [
  ['foreign run', { runId: 'other-run' }], ['wrong version', { version: '2.0' }], ['numeric revision', { controlRevision: 1 }],
  ['out of range cleanup revision', { terminalCleanupRevision: '18446744073709551616' }],
  ['missing offeredSite', { offeredSite: undefined }], ['missing preview', { preview: undefined }],
  ['missing stopped', { stopped: undefined }], ['missing source status', { portableCurrent: undefined }],
]) test(`observation ${name} is rejected without admitting a command`, async () => {
  const h = fixture(call => response(call.url, observation(value)))
  await assert.rejects(h.control.observe(), protocol)
  assert.equal(h.control.status.requests, 0); assert.equal(h.control.status.reservedBytes, 0)
  await closed(h.control)
})

test('observation drain waits actual readers and close can cancel only its own admitted observation', async () => {
  const hold = deferred(), h = fixture(async call => { await hold.promise; return response(call.url, observation()) })
  const observing = h.control.observe(); await until(() => h.calls.length === 1)
  let drained = false; const draining = h.control.drain().then(value => { drained = true; return value })
  await drain(); assert.equal(drained, false)
  const closing = h.control.close(); assert.equal(h.calls[0].init.signal.aborted, true)
  await drain(); assert.equal(drained, false)
  hold.resolve(); await observing; await draining; await closing
  assert.equal(h.control.status.phase, 'closed'); assert.equal(h.control.status.pendingActual, 0)
})

test('invoke is consumed once after uncertainty; replay performs lookup with original bytes', async () => {
  const req = request(), expected = JSON.stringify(req)
  const h = fixture((call, count) => { if (count === 1) throw new Error('lost invoke response'); return response(call.url, final(req)) })
  await assert.rejects(h.control.invoke(req), /lost invoke/)
  assert.throws(() => h.control.invoke(req), protocol)
  assert.throws(() => h.control.replay(request(2)), protocol)
  const value = await h.control.replay(req)
  assert.equal(value.requestId, req.requestId); assert.equal(h.calls[1].text, expected)
  assert.equal(h.calls[1].url, `${baseUrl}__weapp/control/replay`); assert.equal(h.calls.length, 2)
  await closed(h.control)
})

test('mutated bytes, wrong client/lane, oversized and non-data envelopes are refused', async () => {
  const req = request(), h = fixture(call => response(call.url, final(req)))
  await h.control.invoke(req); req.payload.changed = true
  assert.throws(() => h.control.replay(req), protocol)
  for (const bad of [{ ...request(2), requestId: 'other:control-2' }, { ...request(2), requestId: `${clientId}:cleanup-2` },
    { ...request(2), requestId: `${clientId}:control-18446744073709551616` }, { ...request(2), extra: true },
    { ...request(2), toJSON() { return request(3) } }, request(2, 'snapshot', { text: 'x'.repeat(64 * 1024) }),
    { ...request(2), payload: undefined }]) assert.throws(() => h.control.invoke(bad), protocol)
  const getter = request(2); Object.defineProperty(getter, 'payload', { enumerable: true, get() { throw new Error('must not execute getter') } })
  assert.throws(() => h.control.invoke(getter), protocol)
  assert.equal(h.calls.length, 1); await closed(h.control)
})

test('fetch cannot mutate the retained original request buffer', async () => {
  const req = request(), original = JSON.stringify(req)
  const h = fixture(call => { call.init.body.fill(0); return response(call.url, final(req)) })
  await h.control.invoke(req); await h.control.replay(req)
  assert.equal(h.calls[0].text, original); assert.equal(h.calls[1].text, original)
  await closed(h.control)
})

for (const [name, change] of [
  ['foreign URL', { url: 'http://foreign.invalid/' }], ['redirect', { redirected: true }], ['opaque', { type: 'opaque' }],
  ['nonJSON', { headers: { 'Content-Type': 'text/plain' } }], ['HTTP failure', { status: 409 }],
]) test(`${name} response is rejected without accepting a final`, async () => {
  const req = request(), h = fixture(call => response(call.url, final(req), change))
  await assert.rejects(h.control.invoke(req)); assert.equal(h.control.status.inFlight, 0)
  assert.equal(h.control.status.reservedBytes, 0); await closed(h.control)
})

for (const [name, value] of [
  ['queued', req => final(req, { status: 'queued' })], ['request mismatch', req => final(req, { requestId: 'other:control-1' })],
  ['command mismatch', req => final(req, { command: 'stop' })], ['run mismatch', req => final(req, { snapshot: { runId: 'another' } })],
  ['version mismatch', req => final(req, { version: '2.0' })],
]) test(`${name} is never treated as a final`, async () => {
  const req = request(), h = fixture(call => response(call.url, value(req)))
  await assert.rejects(h.control.invoke(req), protocol); await closed(h.control)
})

for (const [name, options, raw] of [
  ['oversized Content-Length', { headers: { 'Content-Length': String(256 * 1024 + 1) } }, '{}'],
  ['noncanonical Content-Length', { headers: { 'Content-Length': '01' } }, '{}'],
  ['truncation', { headers: { 'Content-Length': '3' } }, '{}'],
  ['streaming overflow', {}, new Uint8Array(256 * 1024 + 1)], ['invalid UTF8', {}, new Uint8Array([0xc3, 0x28])],
]) test(`${name} releases all operation accounting`, async () => {
  const h = fixture(call => response(call.url, raw, options))
  await assert.rejects(h.control.invoke(request()))
  assert.equal(h.control.status.pendingActual, 0); assert.equal(h.control.status.reservedBytes, 0)
  await closed(h.control)
})

test('stream fragments are combined before hashing and parsing', async () => {
  const req = request(), raw = encode(final(req)), h = fixture(call => response(call.url, raw, {
    headers: { 'Content-Length': String(raw.length) }, chunks: [raw.slice(0, 4), raw.slice(4, 15), raw.slice(15)],
  }))
  assert.equal((await h.control.invoke(req)).requestId, req.requestId); await closed(h.control)
})

test('retained record and actual-operation limits refuse admission without hidden queues', async () => {
  const gate = deferred(), req = request(), h = fixture(async call => { await gate.promise; return response(call.url, final(JSON.parse(call.text))) }, { maxRequests: 2, maxInFlight: 1 })
  const first = h.control.invoke(req); await until(() => h.calls.length === 1)
  await assert.rejects(h.control.invoke(request(2)), { code: 'ERR_CAPACITY' })
  assert.throws(() => h.control.invoke(request(3)), { code: 'ERR_CAPACITY' })
  assert.equal(h.calls.length, 1); assert.equal(h.control.status.requests, 2, 'invoke uncertainty consumes the admitted record')
  gate.resolve(); await first; await h.control.replay(request(2))
  assert.equal(h.calls.length, 2); await closed(h.control)
})

test('retained plus reserved bytes enforce a bounded lifetime without silent eviction', async () => {
  const req = request(), raw = JSON.stringify(final(req, { result: { text: 'x'.repeat(245 * 1024) } }))
  const h = fixture(call => response(call.url, call.text.includes('control-1') ? raw : final(JSON.parse(call.text))), { maxRetainedBytes: 1024 * 1024 })
  await h.control.invoke(req)
  // Large admitted request records plus response reservations exhaust the cap.
  let refused = false
  for (let serial = 2; serial < 10; serial++) {
    try { await h.control.invoke(request(serial, 'snapshot', { text: 'x'.repeat(60 * 1024) })) }
    catch (error) { assert.equal(error.code, 'ERR_CAPACITY'); refused = true; break }
  }
  assert.ok(refused); assert.ok(h.control.status.retainedBytes <= 1024 * 1024)
  assert.equal(h.control.status.reservedBytes, 0); await closed(h.control)
})

test('ACK requires the exact parsed final and coalesces one actual in-flight ACK', async () => {
  const req = request(), raw = JSON.stringify(final(req)), gate = deferred()
  const h = fixture(async call => { if (call.url.endsWith('/acknowledge')) { await gate.promise; return response(call.url, ack(req, raw)) } return response(call.url, raw) })
  const value = await h.control.invoke(req)
  assert.throws(() => h.control.acknowledge(req, structuredClone(value)), protocol)
  assert.throws(() => h.control.acknowledge(request(2), value), protocol)
  const first = h.control.acknowledge(req, value), second = h.control.acknowledge(req, value)
  assert.strictEqual(first, second); await until(() => h.calls.length === 2)
  gate.resolve(); assert.equal((await first).outcome, 'compacted')
  assert.equal((await h.control.acknowledge(req, value)).outcome, 'compacted'); assert.equal(h.calls.length, 2)
  await closed(h.control)
})

test('lost ACK is retried explicitly with identical original request bytes and raw hash', async () => {
  const req = request(), raw = `\n${JSON.stringify(final(req))}`
  const h = fixture((call, count) => { if (count === 2) throw new Error('ACK reply lost'); return response(call.url, count === 1 ? raw : ack(req, raw, 'already-compacted')) })
  const value = await h.control.invoke(req)
  await assert.rejects(h.control.acknowledge(req, value), /ACK reply lost/)
  assert.equal(h.calls.length, 2, 'there is no automatic ACK retry')
  assert.equal((await h.control.acknowledge(req, value)).outcome, 'already-compacted')
  assert.equal(h.calls[1].text, h.calls[2].text); await closed(h.control)
})

for (const [name, alter] of [
  ['wrong hash', value => ({ ...value, finalSha256: '0'.repeat(64) })], ['wrong request', value => ({ ...value, requestId: 'other' })],
  ['wrong version', value => ({ ...value, version: '2.0' })], ['wrong outcome', value => ({ ...value, outcome: 'retired' })],
  ['extra field', value => ({ ...value, retired: true })],
]) test(`ACK ${name} does not compact client state`, async () => {
  const req = request(), raw = JSON.stringify(final(req))
  const h = fixture(call => response(call.url, call.url.endsWith('/acknowledge') ? alter(ack(req, raw)) : raw))
  const value = await h.control.invoke(req)
  await assert.rejects(h.control.acknowledge(req, value), protocol)
  await assert.rejects(h.control.acknowledge(req, value), protocol)
  assert.equal(h.calls.length, 3, 'failed ACK may be explicitly retried without another invoke')
  await closed(h.control)
})

test('replay raw-byte equivocation cannot replace the original ACK association', async () => {
  const req = request(), raw = JSON.stringify(final(req))
  const h = fixture((call, count) => response(call.url, call.url.endsWith('/acknowledge') ? ack(req, raw) : count === 1 ? raw : ` ${raw}`))
  const value = await h.control.invoke(req)
  await assert.rejects(h.control.replay(req), protocol)
  assert.equal((await h.control.acknowledge(req, value)).outcome, 'compacted')
  assert.equal(JSON.parse(h.calls[2].text).finalSha256, sha256(encode(raw))); await closed(h.control)
})

test('parent abort is relayed and removed only after actual fetch settles', async () => {
  const controller = new AbortController(), signal = controller.signal
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal)
  let added = 0, removed = 0
  signal.addEventListener = (...args) => { added++; return add(...args) }
  signal.removeEventListener = (...args) => { removed++; return remove(...args) }
  const h = fixture(call => new Promise((resolve, reject) => call.init.signal.addEventListener('abort', () => reject(call.init.signal.reason), { once: true })))
  const pending = h.control.invoke(request(), { signal }); await until(() => h.calls.length === 1)
  const reason = Object.assign(new Error('parent stopped'), { name: 'AbortError' }); controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  assert.equal(added, 1); assert.equal(removed, 1); assert.equal(h.control.status.pendingActual, 0)
  await closed(h.control)
})

for (const operation of ['invoke', 'replay', 'acknowledge']) test(`close owns and aborts actual ${operation}, waiting when fetch ignores abort`, async () => {
  const req = request(), raw = JSON.stringify(final(req)), gate = deferred(); let gateEnabled = operation === 'invoke'
  const h = fixture(async call => { if (gateEnabled) await gate.promise; return response(call.url, call.url.endsWith('/acknowledge') ? ack(req, raw) : raw) })
  let value
  if (operation !== 'invoke') value = await h.control.invoke(req)
  gateEnabled = true
  const pending = operation === 'acknowledge' ? h.control.acknowledge(req, value) : h.control[operation](req)
  await until(() => h.control.status.pendingActual === 1 && h.calls.length === (operation === 'invoke' ? 1 : 2))
  const first = h.control.close(), second = h.control.dispose(); assert.strictEqual(first, second)
  let done = false; void first.then(() => { done = true }); await drain()
  assert.equal(done, false); assert.equal(h.control.status.phase, 'closing'); assert.equal(h.control.status.pendingActual, 1)
  assert.equal(h.calls.at(-1).init.signal.aborted, true)
  assert.throws(() => h.control.replay(req), { code: 'ERR_CANCELLED' })
  gate.resolve(); await pending; await first
  assert.equal(h.control.status.pendingActual, 0); assert.equal(h.control.status.phase, 'closed')
  assert.equal(h.calls.length, operation === 'invoke' ? 1 : 2, 'close does not retry network work')
})

test('normal aborted response reader cleanup is not misreported as a cleanup failure', async () => {
  const reached = deferred()
  const h = fixture(call => response(call.url, '', { body: new ReadableStream({
    start(controller) { call.init.signal.addEventListener('abort', () => controller.error(call.init.signal.reason), { once: true }) },
    pull() { reached.resolve() },
  }) }))
  const pending = h.control.invoke(request()); await reached.promise
  const close = h.control.close(); await assert.rejects(pending, { code: 'ERR_CANCELLED' })
  assert.deepEqual(await close, { closed: true, pendingActual: 0, cleanupFailures: 0 })
})

test('genuine reader cancellation failure remains explicit and cleanup-failed', async () => {
  let cancelled = 0, released = 0
  const body = { locked: false, getReader() { this.locked = true; return {
    async read() { return { done: false, value: new Uint8Array(256 * 1024 + 1) } },
    async cancel() { cancelled++; throw new Error('actual cancellation failure') },
    releaseLock() { released++; body.locked = false },
  } }, async cancel() { cancelled++; throw new Error('body cancellation failure') } }
  const h = fixture(call => response(call.url, '', { body }))
  await assert.rejects(h.control.invoke(request()), { code: 'ERR_CLEANUP' })
  assert.ok(cancelled >= 1); assert.equal(released, 1); assert.equal(h.control.status.pendingActual, 0)
  const result = await h.control.close(); assert.equal(result.closed, false); assert.equal(result.cleanupFailures, 1)
  assert.equal(h.control.status.phase, 'cleanup-failed')
})

test('synchronous fetch reentry sees the registered close barrier and actual operation', async () => {
  const req = request(), gate = deferred(); let close
  const h = fixture(async call => { close = h.control.close(); await gate.promise; return response(call.url, final(req)) })
  const pending = h.control.invoke(req); await until(() => Boolean(close))
  let done = false; void close.then(() => { done = true }); await drain()
  assert.equal(done, false); assert.equal(h.control.status.pendingActual, 1); assert.equal(h.calls[0].init.signal.aborted, true)
  gate.resolve(); await pending; await close; assert.equal(h.control.status.phase, 'closed')
})

test('throwing parent relay setup cannot leak operation accounting', async () => {
  const signal = { aborted: false, addEventListener() { throw new Error('relay setup failed') }, removeEventListener() {} }
  const h = fixture(() => { throw new Error('must not fetch') })
  await assert.rejects(h.control.invoke(request(), { signal }), /relay setup failed/)
  assert.equal(h.control.status.pendingActual, 0); assert.equal(h.control.status.inFlight, 0); assert.equal(h.control.status.reservedBytes, 0)
  assert.equal(h.calls.length, 0); await closed(h.control)
})

test('close also waits for the actual response-reader cancellation to settle', async () => {
  const cancelling = deferred(), gate = deferred()
  const body = { locked: false, getReader() { this.locked = true; return {
    async read() { return { done: false, value: new Uint8Array(256 * 1024 + 1) } },
    async cancel() { cancelling.resolve(); await gate.promise },
    releaseLock() { body.locked = false },
  } }, async cancel() {} }
  const h = fixture(call => response(call.url, '', { body }))
  const pending = h.control.invoke(request()); void pending.catch(() => {}); await cancelling.promise
  const close = h.control.close(); let done = false; void close.then(() => { done = true }); await drain()
  assert.equal(done, false); assert.equal(h.control.status.pendingActual, 1)
  gate.resolve(); await assert.rejects(pending, protocol); await close
  assert.equal(h.control.status.phase, 'closed'); assert.equal(h.control.status.pendingActual, 0)
})

test('synchronous parent-relay reentry cannot publish a false closed receipt', async () => {
  const gate = deferred(), req = request(); let close
  const h = fixture(async call => { await gate.promise; return response(call.url, final(req)) })
  const signal = { aborted: false, addEventListener() { close = h.control.close() }, removeEventListener() {} }
  const pending = h.control.invoke(req, { signal }); await until(() => Boolean(close))
  let done = false; void close.then(() => { done = true }); await drain()
  assert.equal(done, false); assert.equal(h.control.status.pendingActual, 1)
  gate.resolve(); await pending; await close; assert.equal(h.control.status.phase, 'closed')
})

for (const property of ['addEventListener', 'removeEventListener']) {
  test(`parent ${property} getter cannot close before actual ownership is registered`, async () => {
    const req = request(), gate = deferred(); let close
    const h = fixture(async call => { await gate.promise; return response(call.url, final(req)) })
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} }
    Object.defineProperty(signal, property, { get() { close = h.control.close(); return () => {} } })
    const pending = h.control.invoke(req, { signal }); await until(() => Boolean(close) && h.calls.length === 1)
    let done = false; void close.then(() => { done = true }); await drain()
    assert.equal(done, false); assert.equal(h.control.status.phase, 'closing')
    assert.equal(h.control.status.pendingActual, 1); assert.equal(h.calls[0].init.signal.aborted, true)
    gate.resolve(); await pending; await closed(h.control)
    assert.equal(h.control.status.retainedBytes, 0); assert.equal(h.control.status.reservedBytes, 0)
  })

  test(`parent ${property} getter reentry shares the already published ACK promise`, async () => {
    const req = request(), raw = JSON.stringify(final(req)), gate = deferred(); let nested
    const h = fixture(async call => {
      if (call.url.endsWith('/acknowledge')) { await gate.promise; return response(call.url, ack(req, raw)) }
      return response(call.url, raw)
    })
    const value = await h.control.invoke(req)
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} }
    Object.defineProperty(signal, property, { get() { nested = h.control.acknowledge(req, value); return () => {} } })
    const first = h.control.acknowledge(req, value, { signal }); await until(() => Boolean(nested))
    assert.strictEqual(first, nested); assert.equal(h.control.status.pendingActual, 1)
    gate.resolve(); await first
    assert.equal(h.calls.filter(call => call.url.endsWith('/acknowledge')).length, 1)
    await closed(h.control)
  })
}

for (const boundary of ['payload.toJSON', 'envelope.getPrototypeOf']) {
  test(`${boundary} cannot admit a record after reentrant close`, async () => {
    let close
    const h = fixture(() => { throw new Error('must not fetch after close') })
    const req = boundary === 'payload.toJSON'
      ? request(1, 'snapshot', { toJSON() { close = h.control.close(); return {} } })
      : new Proxy(request(), { getPrototypeOf(target) { close = h.control.close(); return Reflect.getPrototypeOf(target) } })
    assert.throws(() => h.control.invoke(req), { code: 'ERR_CANCELLED' })
    await close; await closed(h.control)
    assert.equal(h.calls.length, 0); assert.equal(h.control.status.requests, 0)
    assert.equal(h.control.status.retainedBytes, 0); assert.equal(h.control.status.reservedBytes, 0)
  })
}

test('invalid parent relay methods reject inside owned work without false cleanup failure', async () => {
  const h = fixture(() => { throw new Error('must not fetch with invalid signal') })
  for (const signal of [{}, { addEventListener() {}, removeEventListener: true }]) {
    await assert.rejects(h.control.invoke(request(h.control.status.requests + 1), { signal }), protocol)
    assert.equal(h.control.status.pendingActual, 0); assert.equal(h.control.status.reservedBytes, 0)
    assert.equal(h.control.status.cleanupFailures, 0)
  }
  await closed(h.control)
})

test('normal lifetime capacity cannot consume cleanup entries or byte reservations', async () => {
  const h = fixture(call => response(call.url, final(JSON.parse(call.text))), { maxRequests: 1, maxCleanupRequests: 1 })
  await h.control.invoke(request())
  assert.throws(() => h.control.invoke(request(2)), { code: 'ERR_CAPACITY' })
  await h.control.invoke(request(1, 'stop'))
  assert.throws(() => h.control.invoke(request(2, 'stop')), { code: 'ERR_CAPACITY' })
  assert.equal(h.control.status.lanes.normal.requests, 1); assert.equal(h.control.status.lanes.cleanup.requests, 1)
  assert.equal(h.control.status.requests, 2); assert.equal(h.calls.length, 2)
  await closed(h.control)
})

test('full normal actual slot leaves exact recovery and cleanup slots available', async () => {
  const gate = deferred(), req = request()
  const h = fixture(async call => {
    if (call.url.endsWith('/invoke') && JSON.parse(call.text).command === 'snapshot') await gate.promise
    return response(call.url, final(JSON.parse(call.text)))
  }, { maxInFlight: 1, maxRequests: 1, maxRecoveryInFlight: 1 })
  const pending = h.control.invoke(req); await until(() => h.calls.length === 1)
  const replayed = await h.control.replay(req)
  assert.equal(replayed.requestId, req.requestId)
  assert.equal(h.control.status.lanes.normal.inFlight, 1)
  assert.equal(h.control.status.lanes.recovery.retainedBytes, 0, 'normal final uses its original admission reservation')
  await h.control.invoke(request(1, 'stop'))
  assert.equal(h.control.status.lanes.normal.inFlight, 1, 'normal adapter still ignores cancellation')
  gate.resolve(); await pending; await closed(h.control)
})

test('normal bytes exhausted after uncertain admission still allow recovery and cleanup', async () => {
  const h = fixture(call => response(call.url, final(JSON.parse(call.text))), { maxRetainedBytes: 1024 * 1024 })
  await h.control.invoke(request())
  const req = request(2, 'snapshot', { text: 'x'.repeat(60 * 1024) })
  await assert.rejects(h.control.invoke(req), { code: 'ERR_CAPACITY' })
  assert.equal(h.calls.length, 1, 'invoke was consumed before actual-work capacity failure')
  const charged = h.control.status.lanes.normal.retainedBytes
  await h.control.replay(req)
  assert.equal(h.control.status.lanes.normal.retainedBytes, charged, 'final bytes were pre-reserved on admission')
  assert.equal(h.control.status.lanes.recovery.retainedBytes, 0)
  await h.control.invoke(request(1, 'stop')); await closed(h.control)
})

test('normal and cleanup ACKs share only the ACK pool and cannot block cleanup or exact replay', async () => {
  const gate = deferred(), req = request(), stopped = request(1, 'stop')
  const h = fixture(async call => {
    if (call.url.endsWith('/acknowledge')) {
      const body = JSON.parse(call.text), original = JSON.parse(body.originalRequest)
      await gate.promise; return response(call.url, ack(original, JSON.stringify(final(original))))
    }
    return response(call.url, final(JSON.parse(call.text)))
  }, { maxAcknowledgementsInFlight: 1 })
  const value = await h.control.invoke(req), first = h.control.acknowledge(req, value)
  await until(() => h.control.status.lanes.acknowledgement.inFlight === 1)
  const stopValue = await h.control.invoke(stopped)
  await assert.rejects(h.control.acknowledge(stopped, stopValue), { code: 'ERR_CAPACITY' })
  await h.control.replay(stopped); await h.control.invoke(request(2, 'stop'))
  assert.equal(h.control.status.lanes.cleanup.inFlight, 0)
  assert.equal(h.control.status.lanes.acknowledgement.inFlight, 1)
  gate.resolve(); await first
  await h.control.acknowledge(stopped, stopValue); await closed(h.control)
})

test('cleanup and recovery actual-work limits remain finite and independent', async () => {
  const gate = deferred(), stopped = request(1, 'stop')
  const h = fixture(async call => { await gate.promise; return response(call.url, final(JSON.parse(call.text))) }, { maxCleanupInFlight: 1, maxRecoveryInFlight: 1 })
  const first = h.control.invoke(stopped); await until(() => h.calls.length === 1)
  await assert.rejects(h.control.invoke(request(2, 'stop')), { code: 'ERR_CAPACITY' })
  const replay = h.control.replay(stopped); await until(() => h.calls.length === 2)
  await assert.rejects(h.control.replay(stopped), { code: 'ERR_CAPACITY' })
  assert.equal(h.control.status.inFlight, 2); assert.equal(h.control.status.lanes.cleanup.inFlight, 1)
  assert.equal(h.control.status.lanes.recovery.inFlight, 1)
  gate.resolve(); await first; await replay; await closed(h.control)
  for (const usage of Object.values(h.control.status.lanes)) {
    assert.equal(usage.requests, 0); assert.equal(usage.retainedBytes, 0)
    assert.equal(usage.reservedBytes, 0); assert.equal(usage.inFlight, 0)
  }
})

test('cleanup/recovery/ACK budgets must be finite and cannot silently disable the reserve', () => {
  for (const field of ['maxCleanupRequests', 'maxCleanupRetainedBytes', 'maxCleanupInFlight', 'maxRecoveryInFlight', 'maxAcknowledgementsInFlight']) {
    for (const value of [0, -1, Infinity, 1.5]) {
      assert.throws(() => fixture(() => {}, { [field]: value }), protocol)
    }
  }
})

// Controlled retirement peer only: real ledger/HTTP/Worker behavior is verified
// separately. This peer retains exact finals and deliberately exposes failures.
function retirementFixture(onRetire, options = {}) {
  const finals = new Map(), retirements = []
  const h = fixture(async call => {
    if (call.url.endsWith('/retire')) {
      const value = JSON.parse(call.text); retirements.push(value)
      const result = { version: '1.0', runId, clientId, lane: value.lane, previousThrough: value.previousThrough,
        throughSerial: value.throughSerial, prefixSha256: value.prefixSha256, retiredCount: 1, outcome: 'retired' }
      return onRetire ? onRetire(call, result, retirements.length) : response(call.url, result)
    }
    if (call.url.endsWith('/acknowledge')) {
      const value = JSON.parse(call.text), req = JSON.parse(value.originalRequest)
      return response(call.url, ack(req, finals.get(req.requestId)))
    }
    const req = JSON.parse(call.text), raw = final(req)
    finals.set(req.requestId, raw); return response(call.url, raw)
  }, { retirementVersion: '1.0', ...options })
  return { ...h, retirements, finals, async accept(req) {
    const value = await h.control.invoke(req); await h.control.acknowledge(req, value); return value
  } }
}

test('retirement is explicit and rejects unnegotiated or unknown capability versions', async () => {
  const h = fixture(call => response(call.url, final(request())))
  assert.deepEqual(h.control.capabilities, {}); assert.ok(Object.isFrozen(h.control.capabilities))
  assert.throws(() => h.control.retire([request()]), { code: 'ERR_UNSUPPORTED_CAPABILITY' })
  assert.equal(h.calls.length, 0)
  assert.throws(() => fixture(() => {}, { retirementVersion: '2.0' }), protocol)
  await closed(h.control)
})

test('acknowledged retirement binds the exact transcript and frees original lane reservations', async () => {
  const req = request(), h = retirementFixture()
  const value = await h.accept(req), retained = h.control.status.lanes.normal.retainedBytes
  assert.ok(retained > 256 * 1024); assert.deepEqual(h.control.capabilities, { retirementVersion: '1.0' })
  const receipt = await h.control.retire([req])
  const transcript = `weapp-control-retirement-v1\n${runId}\n${clientId}\nnormal\n0\n1\n${req.requestId}:${sha256(encode(h.finals.get(req.requestId)))}\n`
  assert.equal(h.retirements[0].prefixSha256, sha256(encode(transcript)))
  assert.deepEqual(h.retirements[0], { version: '1.0', lane: 'normal', previousThrough: '0', throughSerial: '1', prefixSha256: sha256(encode(transcript)) })
  assert.ok(Object.isFrozen(receipt)); assert.equal(receipt.retiredCount, 1)
  assert.equal(h.control.status.requests, 0); assert.equal(h.control.status.lanes.normal.retainedBytes, 0)
  assert.equal(h.control.status.retirements.normal.throughSerial, '1'); assert.equal(h.control.status.retirements.normal.pending, false)
  assert.strictEqual(h.control.status.retirements.normal.lastReceipt, receipt)
  for (const old of [() => h.control.invoke(req), () => h.control.replay(req), () => h.control.acknowledge(req, value), () => h.control.retire([req])])
    assert.throws(old, { code: 'ERR_CANCELLED' })
  await closed(h.control); assert.deepEqual(h.control.status.highWater, { normal: '1', cleanup: '0' })
})

test('more than the old lifetime capacity runs with bounded retained commands and permanent high-water', async () => {
  const h = retirementFixture(undefined, { maxRequests: 2, maxRetainedBytes: 1024 * 1024 })
  let maxRetained = 0
  for (let serial = 1; serial <= 160; serial++) {
    const req = request(serial); await h.accept(req); await h.control.retire([req])
    maxRetained = Math.max(maxRetained, h.control.status.retainedBytes)
    assert.equal(h.control.status.lanes.normal.requests, 0); assert.equal(h.control.status.lanes.normal.retainedBytes, 0)
    assert.equal(h.control.status.requests, 0); assert.equal(h.control.status.pendingActual, 0)
  }
  assert.equal(h.retirements.length, 160); assert.ok(maxRetained < 4096, 'only the fixed latest receipt remains')
  assert.equal(h.retirements[159].previousThrough, '159'); assert.equal(h.retirements[159].throughSerial, '160')
  assert.equal(h.control.status.highWater.normal, '160')
  assert.throws(() => h.control.invoke(request(1)), { code: 'ERR_CANCELLED' })
  await closed(h.control)
})

test('retirement requires an ordered earliest acknowledged prefix, while unused serial holes never revive', async () => {
  const first = request(1), third = request(3), h = retirementFixture((call, result) => response(call.url, { ...result, retiredCount: 2 }))
  await h.accept(first); const value = await h.control.invoke(third)
  for (const selected of [[third], [first, third], [first, first], [], [first, request(1, 'stop')]]) assert.throws(() => h.control.retire(selected))
  assert.equal(h.retirements.length, 0)
  await h.control.acknowledge(third, value)
  const receipt = await h.control.retire([first, third]); assert.equal(receipt.throughSerial, '3'); assert.equal(receipt.retiredCount, 2)
  assert.throws(() => h.control.invoke(request(2)), { code: 'ERR_CANCELLED' })
  await closed(h.control)
})

test('retirement accepts a full 64-record prefix and rejects 65 without changing the retained set', async () => {
  const h = retirementFixture((call, result) => response(call.url, { ...result, retiredCount: Number(BigInt(result.throughSerial) - BigInt(result.previousThrough)) }),
    { maxRetainedBytes: 32 * 1024 * 1024 })
  const requests = Array.from({ length: 65 }, (_, index) => request(index + 1))
  for (const req of requests) await h.accept(req)
  const before = h.control.status.lanes.normal.retainedBytes
  assert.throws(() => h.control.retire(requests), protocol)
  assert.equal(h.retirements.length, 0); assert.equal(h.control.status.requests, 65)
  assert.equal(h.control.status.lanes.normal.retainedBytes, before)
  const receipt = await h.control.retire(requests.slice(0, 64))
  assert.equal(receipt.retiredCount, 64); assert.equal(receipt.throughSerial, '64')
  assert.equal(h.control.status.requests, 1); assert.equal(h.control.status.highWater.normal, '65')
  await h.control.retire(requests.slice(64)); assert.equal(h.control.status.requests, 0)
  await closed(h.control)
})

test('u64 maximum retirement cursors stay exact and admission cannot wrap or reopen earlier holes', async () => {
  const max = '18446744073709551615', h = retirementFixture(), req = request(max)
  await h.accept(req); assert.equal(h.control.status.highWater.normal, max)
  assert.throws(() => h.control.invoke(request('18446744073709551616')), protocol)
  assert.throws(() => h.control.invoke(request('01')), protocol)
  await h.control.retire([req]); assert.equal(h.control.status.retirements.normal.throughSerial, max)
  assert.throws(() => h.control.invoke(request('18446744073709551614')), { code: 'ERR_CANCELLED' })
  assert.throws(() => h.control.invoke(request(1)), { code: 'ERR_CANCELLED' })
  const cleanup = request(1, 'stop'); await h.accept(cleanup); await h.control.retire([cleanup])
  assert.deepEqual(h.control.status.highWater, { normal: max, cleanup: '1' })
  await closed(h.control)
})

test('normal and cleanup retirement have separate cursors and original actual jobs', async () => {
  const gate = deferred(), h = retirementFixture(async (call, result) => { await gate.promise; return response(call.url, result) })
  const a = request(), b = request(1, 'stop'); await h.accept(a); await h.accept(b)
  const normal = h.control.retire([a]), cleanup = h.control.retire([b])
  await until(() => h.retirements.length === 2)
  assert.strictEqual(h.control.retire([a]), normal); assert.strictEqual(h.control.retire([b]), cleanup)
  assert.equal(h.control.status.lanes.retirement.inFlight, 2)
  assert.equal(h.control.status.lanes.normal.inFlight, 0); assert.equal(h.control.status.lanes.cleanup.inFlight, 0)
  gate.resolve(); await Promise.all([normal, cleanup])
  assert.equal(h.control.status.retirements.normal.throughSerial, '1'); assert.equal(h.control.status.retirements.cleanup.throughSerial, '1')
  assert.equal(h.control.status.requests, 0); await closed(h.control)
})

test('a lost retirement reply retains exact locked candidates and retries identical bytes without rehashing', async () => {
  let retirementHashes = 0
  const h = retirementFixture((call, result, attempt) => {
    if (attempt === 1) throw new Error('retirement reply lost after server commit')
    return response(call.url, result)
  }, { sha256(bytes) { if (decode(bytes).startsWith('weapp-control-retirement-v1\n')) retirementHashes++; return sha256(bytes) } })
  const first = request(), second = request(2); await h.accept(first)
  await assert.rejects(h.control.retire([first]), /retirement reply lost/)
  assert.equal(h.control.status.requests, 1); assert.equal(h.control.status.retirements.normal.pending, true)
  assert.throws(() => h.control.replay(first), { code: 'ERR_CANCELLED' })
  await h.accept(second)
  assert.throws(() => h.control.retire([first, second]), protocol)
  await h.control.retire([first])
  assert.deepEqual(h.retirements[0], h.retirements[1]); assert.equal(retirementHashes, 1)
  assert.equal(h.control.status.requests, 1); assert.equal(h.control.status.highWater.normal, '2')
  await h.control.retire([second]); assert.equal(h.control.status.requests, 0)
  await closed(h.control)
})

for (const [name, change] of [
  ['foreign run', { runId: 'other' }], ['foreign client', { clientId: 'other' }], ['wrong lane', { lane: 'cleanup' }],
  ['wrong previous cursor', { previousThrough: '1' }], ['wrong through cursor', { throughSerial: '2' }],
  ['wrong digest', { prefixSha256: '0'.repeat(64) }], ['wrong count', { retiredCount: 2 }],
  ['wrong version', { version: '2.0' }], ['wrong outcome', { outcome: 'already-retired' }], ['extra field', { extra: true }],
]) test(`retirement ${name} receipt never frees retained commands`, async () => {
  const h = retirementFixture((call, result) => response(call.url, { ...result, ...change })), req = request()
  await h.accept(req); const before = h.control.status.lanes.normal.retainedBytes
  await assert.rejects(h.control.retire([req]), protocol)
  assert.equal(h.control.status.requests, 1); assert.equal(h.control.status.lanes.normal.retainedBytes, before)
  assert.equal(h.control.status.retirements.normal.throughSerial, '0'); assert.equal(h.control.status.retirements.normal.pending, true)
  await closed(h.control)
})

test('an acknowledged command with a held replay/hash cannot retire before actual settlement', async () => {
  const held = deferred(); let holdHash = false, entered = false
  const h = retirementFixture(undefined, { sha256(bytes) {
    if (holdHash) { entered = true; return held.promise }
    return sha256(bytes)
  } }), req = request()
  await h.accept(req); holdHash = true
  const replay = h.control.replay(req); await until(() => entered)
  assert.throws(() => h.control.retire([req]), protocol); assert.equal(h.retirements.length, 0)
  holdHash = false; held.resolve(sha256(encode(h.finals.get(req.requestId)))); await replay
  await h.control.retire([req]); await closed(h.control)
})

test('ACK relay cleanup failure cannot create an acknowledged retirement candidate', async () => {
  const h = retirementFixture(), req = request(), value = await h.control.invoke(req)
  const signal = { aborted: false, addEventListener() {}, removeEventListener() { throw new Error('ACK relay did not release') } }
  await assert.rejects(h.control.acknowledge(req, value, { signal }), { code: 'ERR_CLEANUP' })
  assert.throws(() => h.control.retire([req]), protocol); assert.equal(h.retirements.length, 0)
  await h.control.acknowledge(req, value); await h.control.retire([req])
  const result = await h.control.close(); assert.equal(result.closed, false); assert.equal(result.cleanupFailures, 1)
})

test('close and drain wait the actual retirement hash, and a late hash never authorizes deletion', async () => {
  const held = deferred(); let entered = false
  const h = retirementFixture(undefined, { sha256(bytes) {
    if (decode(bytes).startsWith('weapp-control-retirement-v1\n')) { entered = true; return held.promise }
    return sha256(bytes)
  } }), req = request()
  await h.accept(req); const retiring = h.control.retire([req]); await until(() => entered)
  assert.equal(h.control.status.pendingActual, 1); assert.equal(h.control.status.requests, 1)
  let drained = false, stopped = false
  const draining = h.control.drain().then(value => { drained = true; return value })
  const closing = h.control.close().then(value => { stopped = true; return value })
  await drain(); assert.equal(drained, false); assert.equal(stopped, false)
  held.resolve('a'.repeat(64)); await assert.rejects(retiring, { code: 'ERR_CANCELLED' })
  await draining; await closing
  assert.equal(h.retirements.length, 0); assert.equal(h.control.status.retirements.normal.throughSerial, '0')
  assert.equal(h.control.status.highWater.normal, '1'); assert.equal(h.control.status.phase, 'closed')
})

test('retirement options getter reentry sees the already-published original actual barrier', async () => {
  const h = retirementFixture(), req = request(); await h.accept(req)
  let closing, observedPending
  const options = { get signal() { observedPending = h.control.status.pendingActual; closing = h.control.close(); return undefined } }
  const retiring = h.control.retire([req], options)
  await assert.rejects(retiring, { code: 'ERR_CANCELLED' }); await closing
  assert.equal(observedPending, 1); assert.equal(h.retirements.length, 0)
  assert.equal(h.control.status.retirements.normal.throughSerial, '0')
})

test('synchronous hash reentry shares the exact pending retirement promise', async () => {
  let control, req, nested, observedJobs
  const h = retirementFixture(undefined, { sha256(bytes) {
    if (decode(bytes).startsWith('weapp-control-retirement-v1\n')) {
      observedJobs = control.status.pendingActual; nested = control.retire([req])
    }
    return sha256(bytes)
  } }); control = h.control; req = request(); await h.accept(req)
  const actual = control.retire([req]); await actual
  assert.strictEqual(nested, actual); assert.equal(observedJobs, 1); assert.equal(h.retirements.length, 1)
  await closed(control)
})

test('retirement relay cleanup failure retains bytes, locks and the exact retryable transaction', async () => {
  const h = retirementFixture(), req = request(); await h.accept(req)
  const before = h.control.status.lanes.normal.retainedBytes
  const signal = { aborted: false, addEventListener() {}, removeEventListener() { throw new Error('retirement relay did not release') } }
  await assert.rejects(h.control.retire([req], { signal }), { code: 'ERR_CLEANUP' })
  assert.equal(h.control.status.lanes.normal.retainedBytes, before); assert.equal(h.control.status.retirements.normal.throughSerial, '0')
  assert.equal(h.control.status.retirements.normal.pending, true); assert.equal(h.control.status.pendingActual, 0)
  await h.control.retire([req]); assert.deepEqual(h.retirements[0], h.retirements[1])
  assert.equal(h.control.status.requests, 0)
  assert.equal((await h.control.close()).cleanupFailures, 1)
})

test('retirement close waits a fetch that ignores abort and does not publish its late success', async () => {
  const held = deferred(), h = retirementFixture(async (call, result) => { await held.promise; return response(call.url, result) }), req = request()
  await h.accept(req); const retiring = h.control.retire([req]); await until(() => h.retirements.length === 1)
  let stopped = false; const closing = h.control.close().then(value => { stopped = true; return value })
  await drain(); assert.equal(stopped, false); assert.equal(h.calls.at(-1).init.signal.aborted, true)
  held.resolve(); await assert.rejects(retiring, { code: 'ERR_CANCELLED' }); await closing
  assert.equal(h.control.status.retirements.normal.throughSerial, '0'); assert.equal(h.control.status.phase, 'closed')
})
