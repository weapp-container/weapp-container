import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerRpcClient, WorkerRpcError, WORKER_RPC_VERSION, WORKER_EVENT_LIMITS,
  measureWorkerPayload, takeWorkerFrameResponse, splitWorkerInputTiming, fitWorkerInputTiming,
  WORKER_INPUT_TIMING_LIMITS } from '../examples/hosts/web-wasm/worker-session-client.mjs'

class ManualTimers {
  now = 0
  next = 0
  jobs = new Map()
  set = (callback, delay) => {
    const id = ++this.next
    this.jobs.set(id, { callback, at: this.now + delay })
    return id
  }
  clear = id => { this.jobs.delete(id) }
  advance(delta) {
    const target = this.now + delta
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next) break
      const [id, job] = next
      this.jobs.delete(id)
      this.now = job.at
      job.callback()
    }
    this.now = target
  }
}

class MockWorker {
  listeners = new Map()
  sent = []
  removed = []
  terminateCount = 0
  postError = null
  removeError = null
  terminateError = null
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) {
    this.removed.push(type)
    if (this.removeError) throw this.removeError
    this.listeners.get(type)?.delete(listener)
  }
  postMessage(message, transfer = []) {
    if (this.postError) throw this.postError
    this.sent.push({ message, transfer })
  }
  terminate() {
    this.terminateCount++
    if (this.terminateError) throw this.terminateError
  }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event)
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }
}

const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
const microtasks = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }
const hasCode = (result, code) => {
  assert.ok(result.error instanceof WorkerRpcError)
  assert.equal(result.error.code, code)
  return result.error
}

function fixture(options = {}) {
  const worker = new MockWorker()
  const timers = new ManualTimers()
  const created = []
  const client = new WorkerRpcClient({
    workerUrl: new URL('https://example.test/runtime-worker.mjs'),
    workerFactory: (url, workerOptions) => {
      created.push({ url, options: workerOptions })
      return worker
    },
    workerEpoch: 'epoch-test', sessionId: 'session-test', requestPrefix: 'request-test',
    clock: () => timers.now, setTimer: timers.set, clearTimer: timers.clear,
    timeoutMs: 100, closeTimeoutMs: 20, ...options,
  })
  const requests = () => worker.sent.filter(item => item.message.kind === 'request').map(item => item.message)
  const lastRequest = () => requests().at(-1)
  const reply = (request, payload = { status: 'ok', result: {} }, changes = {}) => {
    worker.emit('message', { data: { ...request, kind: 'response', payload, ...changes } })
  }
  const rawEvent = (requestId, op = 'dirty', payload = {}) => {
    const message = { version: WORKER_RPC_VERSION, workerEpoch: client.workerEpoch,
      sessionId: client.sessionId, requestId, kind: 'event', op, payload }
    worker.emit('message', { data: message })
    return message
  }
  // Successful fixtures name an explicit owner sequence. rawEvent is reserved
  // for protocol-invalid ID cases; labels are never silently renamed.
  const event = (sequence, op = 'dirty', payload = {}) => rawEvent(`worker-event-${sequence}`, op, payload)
  const acknowledge = (request = lastRequest(), { pendingCount = 0, pendingBytes = 0, acknowledged = request.payload.eventIds } = {}) => {
    assert.equal(request.op, 'events.ack')
    reply(request, { status: 'ok', result: { acknowledged, pendingCount, pendingBytes } })
  }
  const close = async () => {
    if (client.state === 'open') {
      const closed = outcome(client.close())
      reply(lastRequest(), { status: 'ok', result: { closed: true, diagnostics: [] } })
      const result = await closed
      assert.equal(result.error, undefined)
    } else await outcome(client.closed)
  }
  return { client, worker, timers, created, requests, lastRequest, reply, event, rawEvent, acknowledge, close }
}

test('creates and owns one fresh module Worker with immutable identity', async () => {
  const f = fixture()
  const unrelated = new MockWorker()
  assert.equal(WORKER_RPC_VERSION, '1.0')
  assert.equal(f.created.length, 1)
  assert.deepEqual(f.created[0].options, { type: 'module', name: 'container-epoch-test' })
  assert.equal(f.created[0].url.href, 'https://example.test/runtime-worker.mjs')
  assert.throws(() => { f.client.workerEpoch = 'other' }, TypeError)
  assert.throws(() => { f.client.sessionId = 'other' }, TypeError)
  await f.close()
  assert.equal(f.worker.terminateCount, 1)
  assert.equal(unrelated.terminateCount, 0)
  assert.equal(f.worker.listenerCount, 0)
  assert.equal(f.timers.jobs.size, 0)
})

test('generated namespaces use an injected factory and reject noncanonical or overlapping identities', async () => {
  const labels = []
  const f = fixture({ workerEpoch: undefined, sessionId: undefined, requestPrefix: undefined,
    idFactory: label => { labels.push(label); return `${label}-generated` } })
  assert.deepEqual(labels, ['epoch', 'session', 'request'])
  assert.equal(f.client.workerEpoch, 'epoch-generated')
  const pending = outcome(f.client.requestHost('state', {}))
  assert.equal(f.lastRequest().requestId, 'request-generated.1')
  f.reply(f.lastRequest(), { status: 'ok', result: 1 })
  assert.deepEqual(await pending, { value: 1 })
  await f.close()
  for (const identities of [
    { workerEpoch: 'bad identity' }, { sessionId: '' }, { requestPrefix: 'x'.repeat(129) },
    { workerEpoch: 'same', sessionId: 'same' }, { requestPrefix: 'epoch-test' },
  ]) {
    assert.throws(() => fixture(identities), error => error.code === 'ERR_RPC_ARGUMENT')
  }
})

test('queued receipts never settle and out-of-order finals correlate by ID and operation', async () => {
  const f = fixture()
  let firstSettled = false
  const first = outcome(f.client.requestHost('state', {})).then(value => { firstSettled = true; return value })
  const firstRequest = f.lastRequest()
  const second = outcome(f.client.requestHost('metrics', {}))
  const secondRequest = f.lastRequest()
  assert.notEqual(firstRequest.requestId, secondRequest.requestId)
  f.reply(firstRequest, { status: 'queued' })
  await Promise.resolve()
  assert.equal(firstSettled, false)
  assert.equal(f.client.pendingCount, 2)
  f.reply(secondRequest, { status: 'ok', result: { metric: 2 } })
  assert.deepEqual(await second, { value: { metric: 2 } })
  f.reply(firstRequest, { status: 'ok', result: { state: 1 } })
  assert.deepEqual(await first, { value: { state: 1 } })
  assert.equal(f.client.pendingCount, 0)
  assert.equal(f.timers.jobs.size, 0)
  await f.close()
})

test('remote final errors preserve details and leave the connection usable', async () => {
  const f = fixture()
  const pending = outcome(f.client.requestHost('bridge', { envelope: {} }))
  const remote = { code: 'ERR_PERMISSION_DENIED', message: 'no permission', permission: 'camera' }
  f.reply(f.lastRequest(), { status: 'error', error: remote })
  const error = hasCode(await pending, remote.code)
  assert.deepEqual(error.details, remote)
  assert.equal(f.client.state, 'open')
  const next = outcome(f.client.requestHost('state', {}))
  f.reply(f.lastRequest(), { status: 'ok', result: true })
  assert.deepEqual(await next, { value: true })
  await f.close()
})

test('events use the same session boundary and do not settle requests', async () => {
  const events = []
  const f = fixture({ onEvent: event => events.push(event) })
  const pending = outcome(f.client.requestHost('state', {}))
  const request = f.lastRequest()
  const event = { ...request, requestId: 'worker-event-1', kind: 'event', op: 'dirty',
    payload: { viewRevision: 2, renderRevision: 3 } }
  f.worker.emit('message', { data: event })
  assert.deepEqual(events, [event])
  assert.equal(f.client.pendingCount, 1)
  f.reply(request, { status: 'ok', result: {} })
  await pending
  await f.close()
})

test('shared event limits are immutable and receipt ACKs release only their exact final batch', async () => {
  assert.deepEqual(WORKER_EVENT_LIMITS, { count: 64, bytes: 16 * 1024 * 1024, criticalBytes: 64 * 1024 })
  assert.equal(Object.isFrozen(WORKER_EVENT_LIMITS), true)
  assert.throws(() => { WORKER_EVENT_LIMITS.count = Infinity }, TypeError)
  const seen = [], f = fixture({ onEvent: event => { seen.push(event.requestId) } })
  const first = f.event(1, 'batch', { messages: [] })
  const second = f.event(2)
  const bytes = measureWorkerPayload(first.payload) + measureWorkerPayload(second.payload)
  assert.deepEqual(seen, ['worker-event-1', 'worker-event-2'])
  assert.equal(f.client.pendingEventCount, 2)
  assert.equal(f.client.pendingEventBytes, bytes)
  assert.equal(f.requests().length, 0)
  await microtasks()
  const ack = f.lastRequest()
  assert.equal(ack.op, 'events.ack')
  assert.deepEqual(ack.payload, { eventIds: seen })
  f.reply(ack, { status: 'queued' })
  await microtasks()
  assert.equal(f.client.pendingEventCount, 2)
  assert.equal(f.client.pendingEventBytes, bytes)
  f.acknowledge(ack, { acknowledged: [...seen].reverse() })
  await microtasks()
  assert.equal(f.client.pendingEventCount, 0)
  assert.equal(f.client.pendingEventBytes, 0)
  // A repeated outer final cannot release new receipts or restart an ACK loop.
  f.acknowledge(ack)
  await microtasks()
  assert.equal(f.requests().length, 1)
  await f.close()
})

test('async consumption and reentrant event delivery retain independent bounded receipts', async () => {
  let finishFirst, f
  const seen = []
  f = fixture({ onEvent: event => {
    seen.push(event.requestId)
    if (event.requestId === 'worker-event-1') {
      f.event(2)
      return new Promise(resolve => { finishFirst = resolve })
    }
  } })
  f.event(1)
  assert.deepEqual(seen, ['worker-event-1', 'worker-event-2'])
  assert.equal(f.client.pendingEventCount, 2)
  await microtasks()
  const reentrantAck = f.lastRequest()
  assert.deepEqual(reentrantAck.payload.eventIds, ['worker-event-2'])
  finishFirst()
  await microtasks()
  assert.equal(f.requests().length, 1, 'a second receipt ACK ran concurrently')
  f.acknowledge(reentrantAck, { pendingCount: 1, pendingBytes: measureWorkerPayload({}) })
  await microtasks()
  const firstAck = f.lastRequest()
  assert.notEqual(firstAck.requestId, reentrantAck.requestId)
  assert.deepEqual(firstAck.payload.eventIds, ['worker-event-1'])
  assert.equal(f.client.pendingEventCount, 1)
  f.acknowledge(firstAck)
  await microtasks()
  assert.equal(f.client.pendingEventCount, 0)
  await f.close()
})

test('an absent handler consumes receipts, while unresolved handlers cannot grant an early ACK', async () => {
  const f = fixture()
  f.event(1)
  await microtasks()
  f.acknowledge()
  await microtasks()
  assert.equal(f.client.pendingEventCount, 0)
  await f.close()
  let finish
  const g = fixture({ onEvent: () => new Promise(resolve => { finish = resolve }) })
  g.event(1)
  await microtasks()
  assert.equal(g.requests().length, 0)
  assert.equal(g.client.pendingEventCount, 1)
  finish()
  await microtasks()
  assert.deepEqual(g.lastRequest().payload.eventIds, ['worker-event-1'])
  g.acknowledge()
  await microtasks()
  await g.close()
})

test('normal receipts saturate at 64 and the sole fault lane remains available until ACK finals', async () => {
  const f = fixture()
  for (let index = 0; index < WORKER_EVENT_LIMITS.count; index++) f.event(index + 1)
  assert.equal(f.client.pendingEventCount, 64)
  await microtasks()
  const firstAck = f.lastRequest()
  assert.equal(firstAck.payload.eventIds.length, 64)
  f.event(65, 'fault', { error: { code: 'ERR_TIMEOUT', message: 'turn interrupted' } })
  const criticalBytes = measureWorkerPayload({ error: { code: 'ERR_TIMEOUT', message: 'turn interrupted' } })
  assert.equal(f.client.pendingEventCount, 65)
  await microtasks()
  assert.equal(f.requests().length, 1)
  f.reply(firstAck, { status: 'queued' })
  await microtasks()
  assert.equal(f.client.pendingEventCount, 65)
  f.acknowledge(firstAck, { pendingCount: 1, pendingBytes: criticalBytes })
  await microtasks()
  assert.equal(f.client.pendingEventCount, 1)
  assert.equal(f.client.pendingEventBytes, criticalBytes)
  assert.deepEqual(f.lastRequest().payload.eventIds, ['worker-event-65'])
  f.acknowledge()
  await microtasks()
  assert.equal(f.client.pendingEventCount, 0)
  assert.equal(f.client.pendingEventBytes, 0)
  f.event(66, 'fault')
  hasCode(await outcome(f.client.closed), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(f.worker.terminateCount, 1)
  assert.equal(f.client.pendingEventCount, 0)
})

test('event count and aggregate bytes remain reserved after consumption but before final ACK', async t => {
  for (const mode of ['count', 'bytes']) await t.test(mode, async () => {
    const f = fixture()
    if (mode === 'count') {
      for (let index = 0; index < WORKER_EVENT_LIMITS.count; index++) f.event(index + 1)
    } else {
      const half = WORKER_EVENT_LIMITS.bytes / 2
      f.event(1, 'batch', new ArrayBuffer(half - 32))
      f.event(2, 'batch', new ArrayBuffer(half - 32))
      assert.equal(f.client.pendingEventBytes, WORKER_EVENT_LIMITS.bytes)
    }
    await microtasks()
    assert.equal(f.requests().length, 1)
    f.event(65)
    hasCode(await outcome(f.client.closed), 'ERR_RPC_PAYLOAD_TOO_LARGE')
    assert.equal(f.client.pendingEventCount, 0)
    assert.equal(f.client.pendingEventBytes, 0)
    assert.equal(f.client.pendingCount, 0)
    assert.equal(f.worker.terminateCount, 1)
    assert.equal(f.worker.listenerCount, 0)
    assert.equal(f.timers.jobs.size, 0)
    await microtasks()
    assert.equal(f.requests().length, 1, 'shutdown restarted an ACK')
  })
})

test('fault bytes have an independent 64 KiB ceiling even when normal capacity is exhausted', async t => {
  for (const oversized of [false, true]) await t.test(oversized ? 'oversized fault' : 'exact fault budget', async () => {
    const f = fixture({ onEvent: () => new Promise(() => {}) })
    const half = WORKER_EVENT_LIMITS.bytes / 2
    f.event(1, 'batch', new ArrayBuffer(half - 32))
    f.event(2, 'batch', new ArrayBuffer(half - 32))
    f.event(3, 'fault', new ArrayBuffer(WORKER_EVENT_LIMITS.criticalBytes - 32 + Number(oversized)))
    if (oversized) {
      hasCode(await outcome(f.client.closed), 'ERR_RPC_PAYLOAD_TOO_LARGE')
      assert.equal(f.client.pendingEventBytes, 0)
    } else {
      assert.equal(f.client.state, 'open')
      assert.equal(f.client.pendingEventCount, 3)
      assert.equal(f.client.pendingEventBytes, WORKER_EVENT_LIMITS.bytes + WORKER_EVENT_LIMITS.criticalBytes)
      assert.equal(f.requests().length, 0)
      await f.close()
    }
    assert.equal(f.worker.terminateCount, 1)
  })
})

test('a duplicate pending event ID fails closed before invoking the handler twice, including reentry', async t => {
  for (const reentrant of [false, true]) await t.test(reentrant ? 'reentrant' : 'pending ACK', async () => {
    let count = 0, f
    f = fixture({ onEvent: () => { count++; if (reentrant) f.event(1) } })
    f.event(1)
    if (!reentrant) { await microtasks(); f.event(1) }
    hasCode(await outcome(f.client.closed), 'ERR_RPC_PROTOCOL')
    assert.equal(count, 1)
    assert.equal(f.client.pendingEventCount, 0)
    assert.equal(f.worker.terminateCount, 1)
    await microtasks()
    assert.equal(f.requests().length, reentrant ? 0 : 1)
  })
})

test('acknowledged event IDs never replay, including beyond a bounded history window', async () => {
  let calls = 0
  const f = fixture({ onEvent: () => { calls++ } })
  // More than 128 successful receipts makes this a lifetime sequence test,
  // rather than a replay cache that silently forgets its oldest event IDs.
  for (let batch = 0; batch < 3; batch++) {
    for (let index = 1; index <= WORKER_EVENT_LIMITS.count; index++) f.event(batch * WORKER_EVENT_LIMITS.count + index)
    await microtasks()
    f.acknowledge()
    await microtasks()
    assert.equal(f.client.pendingEventCount, 0)
    assert.equal(f.client.pendingEventBytes, 0)
  }
  assert.equal(calls, 192)
  f.event(1)
  hasCode(await outcome(f.client.closed), 'ERR_RPC_PROTOCOL')
  assert.equal(calls, 192, 'an acknowledged replay reached the event consumer')
  await microtasks()
  assert.equal(f.requests().length, 3)
  assert.equal(f.worker.terminateCount, 1)
  assert.equal(f.client.pendingEventCount, 0)
})

test('out-of-order owner event sequences fail before a second callback, while forward gaps remain valid', async () => {
  const seen = []
  const f = fixture({ onEvent: event => { seen.push(event.requestId) } })
  f.event(9)
  f.event(8)
  hasCode(await outcome(f.client.closed), 'ERR_RPC_PROTOCOL')
  assert.deepEqual(seen, ['worker-event-9'])
  await microtasks()
  assert.equal(f.requests().length, 0)
  assert.equal(f.worker.terminateCount, 1)
  const valid = []
  const g = fixture({ onEvent: event => { valid.push(event.requestId) } })
  g.event(1)
  g.event(19)
  g.event(Number.MAX_SAFE_INTEGER)
  assert.deepEqual(valid, ['worker-event-1', 'worker-event-19', 'worker-event-9007199254740991'])
  await microtasks()
  assert.deepEqual(g.lastRequest().payload.eventIds, valid)
  g.acknowledge()
  await microtasks()
  assert.equal(g.client.state, 'open')
  await g.close()
  g.event(Number.MAX_SAFE_INTEGER)
  await microtasks()
  assert.deepEqual(valid, ['worker-event-1', 'worker-event-19', 'worker-event-9007199254740991'])
  assert.equal(g.requests().length, 2, 'closed delivery restarted the receipt ACK loop')
  assert.equal(g.worker.terminateCount, 1)
})

test('event IDs require the explicit owner protocol, canonical decimal syntax and a safe sequence', async t => {
  for (const id of ['event-1', 'arbitrary-id', 'worker-event-0', 'worker-event-01',
    'worker-event-+1', 'worker-event--1', 'worker-event-1.0', 'worker-event-1e2',
    'worker-event-1suffix', 'worker-event-9007199254740992', 'worker-event-999999999999999999999999']) {
    await t.test(id, async () => {
      let calls = 0
      const f = fixture({ onEvent: () => { calls++ } })
      f.rawEvent(id)
      hasCode(await outcome(f.client.closed), 'ERR_RPC_PROTOCOL')
      assert.equal(calls, 0)
      assert.equal(f.client.pendingEventCount, 0)
      assert.equal(f.client.pendingEventBytes, 0)
      await microtasks()
      assert.equal(f.requests().length, 0)
      assert.equal(f.worker.terminateCount, 1)
      assert.equal(f.worker.listenerCount, 0)
    })
  }
})

test('receipt ACK uses the control reserve and leaves the final slot exclusively for close', async () => {
  const f = fixture({ maxPending: 4, reservedControlSlots: 2 })
  const first = outcome(f.client.requestHost('state', {}))
  const second = outcome(f.client.requestHost('frame', {}))
  hasCode(await outcome(f.client.requestHost('state', {})), 'ERR_RPC_QUEUE_FULL')
  f.event(1)
  await microtasks()
  assert.equal(f.lastRequest().op, 'events.ack')
  assert.equal(f.client.pendingCount, 3)
  hasCode(await outcome(f.client.requestHost('view.abort', {})), 'ERR_RPC_QUEUE_FULL')
  const ack = f.lastRequest()
  const closing = f.client.close()
  assert.equal(f.lastRequest().op, 'close')
  assert.equal(f.client.pendingCount, 4)
  assert.equal(f.client.pendingEventCount, 0)
  f.acknowledge(ack)
  await microtasks()
  assert.equal(f.client.state, 'closing')
  assert.equal(f.requests().length, 4)
  f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } })
  await closing
  hasCode(await first, 'ERR_RPC_CLOSED')
  hasCode(await second, 'ERR_RPC_CLOSED')
  assert.equal(f.client.pendingCount, 0)
  assert.equal(f.timers.jobs.size, 0)
})

test('receipt ACK retains a byte reserve when ordinary outgoing bytes are saturated', async () => {
  const f = fixture({ maxRequestBytes: 1600, maxInFlightBytes: 2048,
    maxControlRequestBytes: 256, reservedControlBytes: 512 })
  const pending = outcome(f.client.requestHost('load', new ArrayBuffer(1504)))
  assert.equal(f.client.inFlightBytes, 1536)
  hasCode(await outcome(f.client.requestHost('state', {})), 'ERR_RPC_QUEUE_FULL')
  f.event(1)
  await microtasks()
  const ack = f.lastRequest()
  assert.equal(ack.op, 'events.ack')
  assert.equal(f.client.inFlightBytes, 1536 + measureWorkerPayload(ack.payload))
  assert.equal(f.client.state, 'open')
  f.acknowledge(ack)
  await microtasks()
  assert.equal(f.client.inFlightBytes, 1536)
  assert.equal(f.client.pendingEventBytes, 0)
  await f.close()
  hasCode(await pending, 'ERR_RPC_CLOSED')
})

test('malformed receipt ACK finals reject the whole batch and terminate the exact Worker', async t => {
  for (const mode of ['missing', 'duplicate', 'foreign', 'extra', 'negative-count', 'excess-count', 'negative-bytes', 'excess-bytes', 'noninteger']) {
    await t.test(mode, async () => {
      const f = fixture()
      f.event(1); f.event(2)
      await microtasks()
      const ack = f.lastRequest()
      const result = { acknowledged: [...ack.payload.eventIds], pendingCount: 0, pendingBytes: 0 }
      if (mode === 'missing') result.acknowledged.pop()
      if (mode === 'duplicate') result.acknowledged = ['worker-event-1', 'worker-event-1']
      if (mode === 'foreign') result.acknowledged[1] = 'foreign'
      if (mode === 'extra') result.acknowledged.push('extra')
      if (mode === 'negative-count') result.pendingCount = -1
      if (mode === 'excess-count') result.pendingCount = 66
      if (mode === 'negative-bytes') result.pendingBytes = -1
      if (mode === 'excess-bytes') result.pendingBytes = WORKER_EVENT_LIMITS.bytes + WORKER_EVENT_LIMITS.criticalBytes + 1
      if (mode === 'noninteger') result.pendingCount = 0.5
      f.reply(ack, { status: 'ok', result })
      await microtasks()
      hasCode(await outcome(f.client.closed), 'ERR_RPC_PROTOCOL')
      assert.equal(f.client.pendingEventCount, 0)
      assert.equal(f.client.pendingEventBytes, 0)
      assert.equal(f.worker.terminateCount, 1)
      assert.equal(f.timers.jobs.size, 0)
      assert.equal(f.requests().length, 1)
    })
  }
})

test('receipt ACK errors, timeouts and posting failures cannot silently release or retry events', async t => {
  for (const mode of ['remote-error', 'timeout', 'post-error']) await t.test(mode, async () => {
    const f = fixture()
    f.event(1)
    if (mode === 'post-error') f.worker.postError = new Error('ACK could not be posted')
    await microtasks()
    if (mode === 'remote-error') f.reply(f.lastRequest(), { status: 'error', error: { code: 'ERR_ENGINE', message: 'unknown event' } })
    if (mode === 'timeout') f.timers.advance(100)
    await microtasks()
    hasCode(await outcome(f.client.closed), mode === 'remote-error' ? 'ERR_ENGINE' : mode === 'timeout' ? 'ERR_RPC_TIMEOUT' : 'ERR_RPC_WORKER')
    assert.equal(f.client.pendingEventCount, 0)
    assert.equal(f.client.pendingEventBytes, 0)
    assert.equal(f.client.pendingCount, 0)
    assert.equal(f.worker.terminateCount, 1)
    assert.equal(f.timers.jobs.size, 0)
    assert.equal(f.requests().length, mode === 'post-error' ? 0 : 1)
  })
})

test('close and shutdown discard queued and late consumption without restarting ACK or event callbacks', async t => {
  for (const mode of ['queued', 'async', 'failure', 'reentrant-close']) await t.test(mode, async () => {
    let finish, closing, count = 0, f
    f = fixture({ onEvent: () => {
      count++
      if (mode === 'reentrant-close') closing = f.client.close()
      if (mode === 'async' || mode === 'failure') return new Promise(resolve => { finish = resolve })
    } })
    f.event(1)
    if (mode === 'failure') f.worker.emit('error', { message: 'closed while consuming' })
    else {
      closing ??= f.client.close()
      f.event(2)
      f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } })
      await closing
    }
    finish?.()
    await microtasks()
    assert.equal(count, 1)
    assert.ok(f.requests().every(request => request.op === 'close'))
    assert.equal(f.client.pendingEventCount, 0)
    assert.equal(f.client.pendingEventBytes, 0)
    assert.equal(f.worker.terminateCount, 1)
    assert.equal(f.timers.jobs.size, 0)
    if (mode === 'failure') hasCode(await outcome(f.client.closed), 'ERR_RPC_WORKER')
  })
})

test('a rejected asynchronous event handler never sends its receipt ACK', async () => {
  let reject
  const cause = new Error('consumer could not finish')
  const f = fixture({ onEvent: () => new Promise((resolve, fail) => { reject = fail }) })
  f.event(1)
  await microtasks()
  assert.equal(f.requests().length, 0)
  reject(cause)
  await microtasks()
  const error = hasCode(await outcome(f.client.closed), 'ERR_RPC_CALLBACK')
  assert.equal(error.cause, cause)
  assert.equal(f.client.pendingEventCount, 0)
  assert.equal(f.requests().length, 0)
  assert.equal(f.worker.terminateCount, 1)
})

test('mismatched identities, malformed replies and unknown request IDs fail closed', async t => {
  const variants = [
    ['version', request => ({ ...request, version: '2.0' })],
    ['epoch', request => ({ ...request, workerEpoch: 'other-epoch' })],
    ['session', request => ({ ...request, sessionId: 'other-session' })],
    ['operation', request => ({ ...request, op: 'frame' })],
    ['future ID', request => ({ ...request, requestId: 'request-test.999' })],
    ['foreign ID', request => ({ ...request, requestId: 'foreign.1' })],
    ['noncanonical ID', request => ({ ...request, requestId: 'request-test.01' })],
    ['extra field', request => ({ ...request, extra: true })],
    ['missing field', request => { const value = { ...request }; delete value.payload; return value }],
    ['kind', request => ({ ...request, kind: 'request' })],
    ['final status', request => ({ ...request, payload: { status: 'success' } })],
    ['missing result', request => ({ ...request, payload: { status: 'ok' } })],
    ['bad error', request => ({ ...request, payload: { status: 'error', error: { code: 'bad code', message: '' } } })],
  ]
  for (const [name, mutate] of variants) await t.test(name, async () => {
    const f = fixture()
    const pending = outcome(f.client.requestHost('state', {}))
    const valid = { ...f.lastRequest(), kind: 'response', payload: { status: 'ok', result: {} } }
    f.worker.emit('message', { data: mutate(valid) })
    hasCode(await pending, 'ERR_RPC_PROTOCOL')
    hasCode(await outcome(f.client.closed), 'ERR_RPC_PROTOCOL')
    assert.equal(f.client.state, 'failed')
    assert.equal(f.worker.terminateCount, 1)
    assert.equal(f.worker.listenerCount, 0)
    assert.equal(f.timers.jobs.size, 0)
  })
})

test('ordinary and control admission preserve a dedicated final close slot', async () => {
  const f = fixture({ maxPending: 5, reservedControlSlots: 3 })
  const pending = [outcome(f.client.requestHost('state', {})), outcome(f.client.requestHost('frame', {}))]
  hasCode(await outcome(f.client.requestHost('metrics', {})), 'ERR_RPC_QUEUE_FULL')
  pending.push(outcome(f.client.requestHost('view.retire', {})), outcome(f.client.requestHost('abort', {})))
  hasCode(await outcome(f.client.requestHost('retire', {})), 'ERR_RPC_QUEUE_FULL')
  assert.equal(f.client.pendingCount, 4)
  const close = outcome(f.client.close())
  assert.equal(f.client.pendingCount, 5)
  f.reply(f.lastRequest(), { status: 'queued' })
  assert.equal(f.worker.terminateCount, 0)
  f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } })
  assert.deepEqual(await close, { value: { closed: true } })
  for (const item of pending) hasCode(await item, 'ERR_RPC_CLOSED')
  assert.equal(f.worker.terminateCount, 1)
  assert.equal(f.timers.jobs.size, 0)
})

test('timeout sends admission cancellation and calls the retained late-final handler at most once', async () => {
  const late = []
  const f = fixture()
  const pending = outcome(f.client.requestHost('view.prepare', { revision: 1 }, { onLateResponse: response => late.push(response) }))
  const request = f.lastRequest()
  f.timers.advance(100)
  hasCode(await pending, 'ERR_RPC_TIMEOUT')
  assert.deepEqual(f.worker.sent.at(-1).message, { ...request, kind: 'cancel', payload: { reason: 'timeout' } })
  assert.equal(f.client.pendingCount, 0)
  assert.equal(f.client.retiredCount, 1)
  f.reply(request, { status: 'queued' })
  assert.equal(late.length, 0)
  f.reply(request, { status: 'ok', result: { candidate: 4 } })
  f.reply(request, { status: 'ok', result: { candidate: 4 } })
  assert.equal(late.length, 1)
  assert.equal(late[0].requestId, request.requestId)
  assert.deepEqual(late[0].payload.result, { candidate: 4 })
  assert.equal(f.client.retiredCount, 0)
  assert.equal(f.client.state, 'open')
  await f.close()
})

test('AbortSignal removes its listener and late error replies remain observable', async () => {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener: (type, listener) => { assert.equal(type, 'abort'); listeners.add(listener) },
    removeEventListener: (type, listener) => { assert.equal(type, 'abort'); listeners.delete(listener) },
  }
  const late = []
  const f = fixture()
  const pending = outcome(f.client.requestHost('view.prepare', {}, { signal, onLateResponse: value => late.push(value) }))
  const request = f.lastRequest()
  assert.equal(listeners.size, 1)
  signal.aborted = true
  for (const listener of [...listeners]) listener()
  hasCode(await pending, 'ERR_RPC_CANCELLED')
  assert.equal(listeners.size, 0)
  assert.equal(f.timers.jobs.size, 0)
  assert.deepEqual(f.worker.sent.at(-1).message, { ...request, kind: 'cancel', payload: { reason: 'aborted' } })
  f.reply(request, { status: 'error', error: { code: 'ERR_CANCELLED', message: 'not admitted' } })
  assert.equal(late.length, 1)
  assert.equal(late[0].payload.status, 'error')
  await f.close()
})

test('pre-aborted requests are rejected without posting or allocating a pending slot', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  hasCode(await outcome(f.client.requestHost('state', {}, { signal: controller.signal })), 'ERR_RPC_CANCELLED')
  assert.equal(f.worker.sent.length, 0)
  assert.equal(f.client.pendingCount, 0)
  assert.equal(f.timers.jobs.size, 0)
  await f.close()
})

test('retired IDs expire and evict within bounds without resurrecting requests', async () => {
  const late = []
  const f = fixture({ retiredLimit: 1, retiredTtlMs: 10 })
  const first = outcome(f.client.requestHost('view.prepare', {}, { timeoutMs: 1, onLateResponse: value => late.push(value) }))
  const firstRequest = f.lastRequest()
  f.timers.advance(1)
  hasCode(await first, 'ERR_RPC_TIMEOUT')
  const second = outcome(f.client.requestHost('view.prepare', {}, { timeoutMs: 1, onLateResponse: value => late.push(value) }))
  const secondRequest = f.lastRequest()
  f.timers.advance(1)
  hasCode(await second, 'ERR_RPC_TIMEOUT')
  assert.equal(f.client.retiredCount, 1)
  f.reply(firstRequest)
  assert.equal(late.length, 0)
  f.timers.advance(10)
  assert.equal(f.client.retiredCount, 0)
  f.reply(secondRequest)
  assert.equal(late.length, 0)
  assert.equal(f.client.state, 'open')
  await f.close()
})

test('retained late replies must still match the original operation', async () => {
  const f = fixture()
  const pending = outcome(f.client.requestHost('view.prepare', {}, { timeoutMs: 1 }))
  const request = f.lastRequest()
  f.timers.advance(1)
  await pending
  f.reply(request, { status: 'ok', result: {} }, { op: 'view.retire' })
  hasCode(await outcome(f.client.closed), 'ERR_RPC_PROTOCOL')
  assert.equal(f.worker.terminateCount, 1)
})

test('close waits for final ACK, rejects pending and releases the exact worker once', async () => {
  const f = fixture()
  const pending = outcome(f.client.requestHost('frame', {}))
  const closing = f.client.close()
  assert.equal(f.client.close(), closing)
  assert.equal(f.client.state, 'closing')
  hasCode(await outcome(f.client.requestHost('state', {})), 'ERR_RPC_CLOSED')
  const request = f.lastRequest()
  f.reply(request, { status: 'queued' })
  await Promise.resolve()
  assert.equal(f.worker.terminateCount, 0)
  f.reply(request, { status: 'ok', result: { closed: true, diagnostics: [] } })
  assert.deepEqual(await closing, { closed: true, diagnostics: [] })
  hasCode(await pending, 'ERR_RPC_CLOSED')
  assert.deepEqual(await f.client.closed, { closed: true })
  assert.equal(f.client.state, 'closed')
  assert.equal(f.worker.terminateCount, 1)
  assert.equal(f.worker.listenerCount, 0)
  assert.equal(f.timers.jobs.size, 0)
  await f.client.close()
  assert.equal(f.worker.terminateCount, 1)
})

test('close timeout still terminates and exposes the failed final ACK', async () => {
  const f = fixture()
  const closing = outcome(f.client.close())
  f.timers.advance(20)
  hasCode(await closing, 'ERR_RPC_TIMEOUT')
  hasCode(await outcome(f.client.closed), 'ERR_RPC_TIMEOUT')
  assert.equal(f.worker.terminateCount, 1)
  assert.equal(f.worker.listenerCount, 0)
  assert.equal(f.timers.jobs.size, 0)
})

test('error and messageerror both reject pending, close and clean up', async t => {
  for (const type of ['error', 'messageerror']) await t.test(type, async () => {
    const failures = []
    const f = fixture({ onFailure: error => failures.push(error) })
    const pending = outcome(f.client.requestHost('state', {}))
    f.worker.emit(type, { message: 'worker crashed' })
    hasCode(await pending, 'ERR_RPC_WORKER')
    hasCode(await outcome(f.client.closed), 'ERR_RPC_WORKER')
    assert.equal(failures.length, 1)
    assert.equal(f.worker.terminateCount, 1)
    assert.equal(f.worker.listenerCount, 0)
    assert.equal(f.timers.jobs.size, 0)
  })
})

test('postMessage failures fail closed and preserve their cause', async () => {
  const f = fixture()
  const cause = new Error('clone failed')
  f.worker.postError = cause
  const error = hasCode(await outcome(f.client.requestHost('state', {})), 'ERR_RPC_WORKER')
  assert.equal(error.cause, cause)
  assert.equal(f.client.failure, error)
  assert.equal(f.worker.terminateCount, 1)
  assert.equal(f.timers.jobs.size, 0)
})

test('cleanup failures remain visible even when the close ACK succeeds', async () => {
  const f = fixture()
  f.worker.removeError = new Error('remove failed')
  f.worker.terminateError = new Error('terminate failed')
  const closing = outcome(f.client.close())
  f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } })
  const error = hasCode(await closing, 'ERR_RPC_CLEANUP')
  assert.equal(error.cleanupErrors.length, 4)
  assert.equal(error.cleanupErrors[3], f.worker.terminateError)
  assert.equal(f.worker.terminateCount, 1)
  assert.deepEqual(f.worker.removed, ['message', 'error', 'messageerror'])
  assert.equal(f.client.failure, error)
  hasCode(await outcome(f.client.closed), 'ERR_RPC_CLEANUP')
})

test('failure observer errors are included before pending and closed promises reject', async () => {
  const observerError = new Error('observer failed')
  const f = fixture({ onFailure: () => { throw observerError } })
  const pending = outcome(f.client.requestHost('state', {}))
  f.worker.emit('error', { message: 'broken' })
  const error = hasCode(await pending, 'ERR_RPC_WORKER')
  assert.ok(error.cleanupErrors.includes(observerError))
  assert.equal((await outcome(f.client.closed)).error, error)
  assert.equal(f.client.failure, error)
})

test('event or late-final callback errors fail closed, including async callback failures', async t => {
  for (const asyncFailure of [false, true]) await t.test(asyncFailure ? 'async late callback' : 'event callback', async () => {
    const callbackError = new Error('callback failed')
    const callback = asyncFailure ? () => Promise.reject(callbackError) : () => { throw callbackError }
    const f = fixture(asyncFailure ? {} : { onEvent: callback })
    const pending = outcome(f.client.requestHost('view.prepare', {}, {
      timeoutMs: 1, onLateResponse: asyncFailure ? callback : undefined,
    }))
    const request = f.lastRequest()
    if (asyncFailure) {
      f.timers.advance(1)
      await pending
      f.reply(request, { status: 'ok', result: {} })
      await Promise.resolve()
    } else {
      f.worker.emit('message', { data: { ...request, kind: 'event', requestId: 'worker-event-1', op: 'dirty', payload: {} } })
      hasCode(await pending, 'ERR_RPC_CALLBACK')
    }
    const error = hasCode(await outcome(f.client.closed), 'ERR_RPC_CALLBACK')
    assert.equal(error.cause, callbackError)
    assert.equal(f.worker.terminateCount, 1)
  })
})

test('late async callback failures remain visible after an otherwise successful close', async () => {
  let rejectCallback
  const observed = []
  const f = fixture({ onEvent: () => new Promise((resolve, reject) => { rejectCallback = reject }),
    onFailure: error => observed.push(error) })
  f.worker.emit('message', { data: { version: '1.0', workerEpoch: f.client.workerEpoch,
    sessionId: f.client.sessionId, requestId: 'worker-event-1', kind: 'event', op: 'dirty', payload: {} } })
  await f.close()
  rejectCallback(new Error('late observer failed'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(f.client.state, 'failed')
  assert.equal(f.client.failure.code, 'ERR_RPC_CALLBACK')
  assert.equal(observed.length, 1)
  assert.equal(f.worker.terminateCount, 1)
})

test('only unique attached ArrayBuffers can be transferred', async () => {
  const f = fixture()
  const bytes = new ArrayBuffer(8)
  const pending = outcome(f.client.requestHost('resource', { bytes }, { transfer: [bytes] }))
  assert.equal(f.worker.sent.at(-1).transfer[0], bytes)
  f.reply(f.lastRequest(), { status: 'ok', result: {} })
  await pending
  const invalid = [[new Uint8Array(4)], [bytes, bytes], null]
  if (typeof SharedArrayBuffer === 'function') invalid.push([new SharedArrayBuffer(4)])
  const detached = new ArrayBuffer(4)
  structuredClone(detached, { transfer: [detached] })
  invalid.push([detached])
  for (const transfer of invalid) {
    hasCode(await outcome(f.client.requestHost('resource', {}, { transfer })), 'ERR_RPC_ARGUMENT')
  }
  assert.equal(f.requests().length, 1)
  assert.equal(f.client.state, 'open')
  await f.close()
})

test('invalid options reject without admission and timeout infrastructure failure cannot strand a request', async () => {
  const f = fixture()
  for (const options of [null, { timeoutMs: Infinity }, { timeoutMs: 0 }, { signal: {} }, { onLateResponse: true }]) {
    hasCode(await outcome(f.client.requestHost('state', {}, options)), 'ERR_RPC_ARGUMENT')
  }
  assert.equal(f.requests().length, 0)
  await f.close()
  let clockFails = false
  const g = fixture({ clock: () => { if (clockFails) throw new Error('clock failed'); return 0 } })
  const pending = outcome(g.client.requestHost('state', {}, { timeoutMs: 1 }))
  clockFails = true
  g.timers.advance(1)
  const error = hasCode(await pending, 'ERR_RPC_TIMEOUT')
  assert.equal(error.cleanupErrors[0].message, 'clock failed')
  assert.equal(g.client.state, 'failed')
  assert.equal(g.worker.terminateCount, 1)
  assert.equal(g.timers.jobs.size, 0)
})

test('oversized payload and transfer buffers are rejected before postMessage', async () => {
  const f = fixture({ maxRequestBytes: 1024 })
  const large = new ArrayBuffer(1024)
  hasCode(await outcome(f.client.requestHost('load', large)), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  hasCode(await outcome(f.client.requestHost('load', {}, { transfer: [large] })), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(f.worker.sent.length, 0)
  assert.equal(large.byteLength, 1024)
  assert.equal(f.client.inFlightBytes, 0)
  assert.equal(f.client.pendingCount, 0)
  assert.equal(f.timers.jobs.size, 0)
  await f.close()
})

test('the default single-request budget is 16 MiB and has a finite configurable ceiling', async () => {
  const f = fixture()
  const tooLarge = new ArrayBuffer(16 * 1024 * 1024 + 1)
  hasCode(await outcome(f.client.requestHost('load', tooLarge)), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(f.worker.sent.length, 0)
  await f.close()
  for (const options of [
    { maxRequestBytes: Infinity }, { maxRequestBytes: 64 * 1024 * 1024 + 1 },
    { maxInFlightBytes: Infinity }, { maxInFlightBytes: 256 * 1024 * 1024 + 1 },
    { maxResponseBytes: Infinity }, { maxResponseBytes: 64 * 1024 * 1024 + 1 },
    { maxControlRequestBytes: 0 }, { reservedControlBytes: 64 * 1024 },
    { maxPayloadNodes: 131_073 }, { maxPayloadDepth: 257 },
  ]) assert.throws(() => fixture(options), error => error.code === 'ERR_RPC_ARGUMENT')
})

test('backing buffers are charged once including transfers, and a small typed view cannot conceal a large backing store', async () => {
  const f = fixture({ maxRequestBytes: 1024 })
  const buffer = new ArrayBuffer(128)
  const pending = outcome(f.client.requestHost('resource', buffer, { transfer: [buffer] }))
  assert.equal(f.client.inFlightBytes, 160)
  f.reply(f.lastRequest(), { status: 'queued' })
  assert.equal(f.client.inFlightBytes, 160)
  f.reply(f.lastRequest(), { status: 'ok', result: {} })
  await pending
  assert.equal(f.client.inFlightBytes, 0)
  const hidden = new Uint8Array(new ArrayBuffer(2048), 0, 1)
  hasCode(await outcome(f.client.requestHost('load', hidden)), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  const dataView = new DataView(new ArrayBuffer(2048), 0, 1)
  hasCode(await outcome(f.client.requestHost('load', dataView)), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(f.client.inFlightBytes, 0)
  await f.close()
})

test('aggregate byte admission blocks before the count limit and recovers when a request settles', async () => {
  const f = fixture({ maxRequestBytes: 2048, maxInFlightBytes: 4096,
    maxControlRequestBytes: 128, reservedControlBytes: 512 })
  const pending = []
  const requests = []
  for (let index = 0; index < 3; index++) {
    pending.push(outcome(f.client.requestHost('load', new ArrayBuffer(1000))))
    requests.push(f.lastRequest())
  }
  assert.equal(f.client.inFlightBytes, 3096)
  assert.equal(f.client.pendingCount, 3)
  hasCode(await outcome(f.client.requestHost('load', new ArrayBuffer(1000))), 'ERR_RPC_QUEUE_FULL')
  assert.equal(f.requests().length, 3)
  f.reply(requests[0], { status: 'ok', result: true })
  await pending[0]
  assert.equal(f.client.inFlightBytes, 2064)
  pending.push(outcome(f.client.requestHost('load', new ArrayBuffer(1000))))
  assert.equal(f.client.inFlightBytes, 3096)
  await f.close()
  for (const item of pending.slice(1)) hasCode(await item, 'ERR_RPC_CLOSED')
  assert.equal(f.client.inFlightBytes, 0)
})

test('retire and abort have a small byte reserve and cannot consume the dedicated close reserve', async () => {
  const f = fixture({ maxRequestBytes: 1600, maxInFlightBytes: 2048,
    maxControlRequestBytes: 128, reservedControlBytes: 512 })
  const pending = [outcome(f.client.requestHost('load', new ArrayBuffer(1504)))]
  assert.equal(f.client.inFlightBytes, 1536)
  hasCode(await outcome(f.client.requestHost('state', {})), 'ERR_RPC_QUEUE_FULL')
  for (const op of ['view.retire', 'view.abort', 'retire']) {
    pending.push(outcome(f.client.requestHost(op, new ArrayBuffer(96))))
  }
  assert.equal(f.client.inFlightBytes, 1920)
  hasCode(await outcome(f.client.requestHost('abort', new ArrayBuffer(96))), 'ERR_RPC_QUEUE_FULL')
  hasCode(await outcome(f.client.requestHost('view.retire', new ArrayBuffer(97))), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  const closing = outcome(f.client.close({ payload: new ArrayBuffer(96) }))
  assert.equal(f.client.inFlightBytes, 2048)
  f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } })
  assert.deepEqual(await closing, { value: { closed: true } })
  for (const item of pending) hasCode(await item, 'ERR_RPC_CLOSED')
  assert.equal(f.client.inFlightBytes, 0)
})

test('payload validation does not call value getters, transfer getters, toJSON or class conversion hooks', async () => {
  const f = fixture()
  let calls = 0
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; return 'value' } })
  const transfer = Object.defineProperty([], '0', { enumerable: true, get() { calls++; return new ArrayBuffer(4) } })
  hasCode(await outcome(f.client.requestHost('load', { nested: accessor })), 'ERR_RPC_ARGUMENT')
  hasCode(await outcome(f.client.requestHost('load', {}, { transfer })), 'ERR_RPC_ARGUMENT')
  hasCode(await outcome(f.client.requestHost('load', { toJSON() { calls++; return {} } })), 'ERR_RPC_ARGUMENT')
  class ClassPayload { toJSON() { calls++; return {} } }
  for (const payload of [new ClassPayload(), new Date(), new Map(), new Set(),
    { value: () => {} }, { value: Symbol('x') }, { value: 1n }, NaN, Infinity]) {
    hasCode(await outcome(f.client.requestHost('load', payload)), 'ERR_RPC_ARGUMENT')
  }
  assert.equal(calls, 0)
  assert.equal(f.worker.sent.length, 0)
  assert.equal(f.client.inFlightBytes, 0)
  await f.close()
})

test('iterative payload validation bounds nodes, sparse arrays and depth, and rejects cycles', async () => {
  const f = fixture({ maxPayloadNodes: 8, maxPayloadDepth: 2 })
  hasCode(await outcome(f.client.requestHost('load', Array(8).fill(null))), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  hasCode(await outcome(f.client.requestHost('load', new Array(1_000_000))), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  hasCode(await outcome(f.client.requestHost('load', { a: { b: { c: 1 } } })), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  const cycle = {}
  cycle.self = cycle
  hasCode(await outcome(f.client.requestHost('load', cycle)), 'ERR_RPC_ARGUMENT')
  const shared = { value: 1 }
  const valid = outcome(f.client.requestHost('load', { a: shared, b: shared }))
  f.reply(f.lastRequest(), { status: 'ok', result: {} })
  assert.deepEqual(await valid, { value: {} })
  assert.equal(f.client.inFlightBytes, 0)
  await f.close()
})

test('byte reservations release on final error, abort, timeout and transport failure', async t => {
  for (const mode of ['remote-error', 'abort', 'timeout', 'worker-error', 'post-error', 'timer-error']) {
    await t.test(mode, async () => {
      const f = fixture(mode === 'timer-error' ? { setTimer: () => { throw new Error('timer failed') } } : {})
      const controller = new AbortController()
      if (mode === 'post-error') f.worker.postError = new Error('post failed')
      const pending = outcome(f.client.requestHost('load', new ArrayBuffer(128), { signal: controller.signal }))
      if (!['post-error', 'timer-error'].includes(mode)) assert.equal(f.client.inFlightBytes, 160)
      if (mode === 'remote-error') f.reply(f.lastRequest(), { status: 'error', error: { code: 'ERR_ENGINE', message: 'failed' } })
      if (mode === 'abort') controller.abort()
      if (mode === 'timeout') f.timers.advance(100)
      if (mode === 'worker-error') f.worker.emit('error', { message: 'failed' })
      assert.ok((await pending).error)
      assert.equal(f.client.inFlightBytes, 0)
      assert.equal(f.client.pendingCount, 0)
      await f.close()
    })
  }
})

test('incoming final buffers and events have a separate post-delivery size limit', async t => {
  for (const kind of ['response', 'event', 'queued']) await t.test(kind, async () => {
    const f = fixture({ maxResponseBytes: 1024 })
    const pending = outcome(f.client.requestHost('resource', new ArrayBuffer(32)))
    assert.equal(f.client.inFlightBytes, 64)
    const request = f.lastRequest()
    if (kind === 'response') {
      f.reply(request, { status: 'ok', result: { bytes: new ArrayBuffer(1024) } })
    } else if (kind === 'queued') {
      f.reply(request, { status: 'queued', extra: new ArrayBuffer(1024) })
    } else {
      f.worker.emit('message', { data: { ...request, kind: 'event', requestId: 'worker-event-1',
        op: 'batch', payload: { bytes: new ArrayBuffer(1024) } } })
    }
    hasCode(await pending, 'ERR_RPC_PAYLOAD_TOO_LARGE')
    hasCode(await outcome(f.client.closed), 'ERR_RPC_PAYLOAD_TOO_LARGE')
    assert.equal(f.client.inFlightBytes, 0)
    assert.equal(f.worker.terminateCount, 1)
  })
})

test('small incoming binary resources do not count against outgoing in-flight bytes', async () => {
  const f = fixture()
  const first = outcome(f.client.requestHost('resource', {}))
  const request = f.lastRequest()
  const second = outcome(f.client.requestHost('state', new ArrayBuffer(128)))
  assert.equal(f.client.inFlightBytes, 192)
  f.reply(request, { status: 'ok', result: { bytes: new ArrayBuffer(2048) } })
  const result = await first
  assert.equal(result.value.bytes.byteLength, 2048)
  assert.equal(f.client.inFlightBytes, 160)
  f.reply(f.lastRequest(), { status: 'ok', result: {} })
  await second
  assert.equal(f.client.inFlightBytes, 0)
  await f.close()
})

test('binary wire decoding preserves configured response budgets and legal generic RPC graphs', async () => {
  const events=[]
  const f=fixture({maxResponseBytes:32*1024*1024,maxPayloadNodes:24000,maxPayloadDepth:128,onEvent:message=>events.push(message)})
  try {
    const large=new ArrayBuffer(17*1024*1024),items=Array.from({length:18000},(_,index)=>index)
    let deep={value:true};for(let index=0;index<80;index++)deep={child:deep}
    const shared=Object.freeze(Array.from({length:1000},(_,index)=>index)),aliases=Array.from({length:32},()=>shared)
    const sparse=[];sparse.length=3;sparse[2]='kept'
    let ignoredReads=0
    const metadata={sparse,aliases}
    Object.defineProperty(metadata,'ignored',{get(){ignoredReads++;throw new Error('non-enumerable getter must be ignored')}})
    for(const result of [{large},{items},{deep},{metadata}]) {
      const pending=outcome(f.client.requestHost('state',{}));f.reply(f.lastRequest(),{status:'ok',result})
      const final=await pending;assert.equal(final.error,undefined);assert.equal(final.value,result)
    }
    f.event(1,'batch',{items,metadata});await microtasks()
    assert.equal(events.length,1);assert.equal(events[0].payload.metadata,metadata)
    assert.equal(events[0].payload.metadata.aliases[0],shared)
    assert.equal(Object.hasOwn(events[0].payload.metadata.sparse,0),false)
    assert.equal(ignoredReads,0);assert.equal(f.client.failure,null)
    f.acknowledge()
  } finally { await f.close() }
})

test('native frame response metadata has a finite independent default and honors explicit smaller client budgets', async () => {
  const frame = { root: { id: 'root', children: Array.from({ length: 400 }, (_, id) => ({ id: String(id), children: [],
    computed_style: Object.fromEntries(Array.from({ length: 40 }, (_, key) => [`property${key}`, 'accepted-style'])) })) } }
  for (const [limits, accepted] of [[{}, true], [{ maxPayloadNodes: 10000 }, false], [{ maxFramePayloadNodes: 1000 }, false],
    [{ maxPayloadNodes: 10000, maxFramePayloadNodes: 131072 }, true]]) {
    const f = fixture(limits)
    try {
      const pending = outcome(f.client.requestHost('frame.current', {}))
      f.reply(f.lastRequest(), { status: 'ok', result: { frame } })
      const result = await pending
      if (accepted) assert.equal(result.value.frame, frame)
      else hasCode(result, 'ERR_RPC_PAYLOAD_TOO_LARGE')
    } finally { await f.close() }
  }
})

test('shared admission measurement is pure, bounded and includes transfer-only backing buffers', () => {
  const buffer = new ArrayBuffer(128)
  assert.equal(measureWorkerPayload(buffer), 160)
  assert.equal(measureWorkerPayload(buffer, { transfers: [buffer] }), 160)
  assert.equal(measureWorkerPayload(null, { transfers: [buffer] }), 168)
  const first = new Uint8Array(buffer, 0, 1)
  const second = new DataView(buffer, 1, 1)
  // Object 32, two one-character keys 36, views 64, backing store 160.
  assert.equal(measureWorkerPayload({ a: first, b: second }), 292)
  assert.equal(buffer.byteLength, 128)
  assert.equal(first.byteLength, 1)
  for (const options of [null, { maxBytes: Infinity }, { maxBytes: 256 * 1024 * 1024 + 1 },
    { maxNodes: Infinity }, { maxDepth: Infinity }]) {
    assert.throws(() => measureWorkerPayload({}, options), error => error.code === 'ERR_RPC_ARGUMENT')
  }
  assert.throws(() => measureWorkerPayload(buffer, { maxBytes: 159 }),
    error => error.code === 'ERR_RPC_PAYLOAD_TOO_LARGE')
})

test('timer cleanup errors release byte reservations before failing closed', async () => {
  const f = fixture({ clearTimer: () => { throw new Error('clear failed') } })
  const pending = outcome(f.client.requestHost('load', new ArrayBuffer(128)))
  assert.equal(f.client.inFlightBytes, 160)
  f.reply(f.lastRequest(), { status: 'ok', result: {} })
  hasCode(await pending, 'ERR_RPC_CLEANUP')
  hasCode(await outcome(f.client.closed), 'ERR_RPC_CLEANUP')
  assert.equal(f.client.inFlightBytes, 0)
  assert.equal(f.client.pendingCount, 0)
  assert.equal(f.worker.terminateCount, 1)
})

test('owned actual-final admission distinguishes pre-aborted and post-setup unposted requests', async () => {
  const f = fixture(), receipts = [], controller = new AbortController(); controller.abort()
  hasCode(await outcome(f.client.requestHost('frame', {}, { signal: controller.signal, onActualFinal: value => receipts.push(value) })), 'ERR_RPC_CANCELLED')
  assert.deepEqual(receipts, [{ version: '1.0', status: 'not-posted', requestId: null }])
  assert.equal(f.client.actualFinalContract, '1.0'); assert.equal(f.client.actualFinalCount, 0)
  assert.equal(f.requests().length, 0)
  const signal = { aborted: false, addEventListener(_, callback) { this.aborted = true; callback() }, removeEventListener() {} }
  hasCode(await outcome(f.client.requestHost('frame', {}, { signal, onActualFinal: value => receipts.push(value) })), 'ERR_RPC_CANCELLED')
  assert.equal(receipts[1].status, 'not-posted'); assert.ok(receipts[1].requestId)
  assert.equal(f.client.actualFinalCount, 0); assert.equal(f.requests().length, 0)
  const close = f.client.close(); f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } }); await close
})

test('posted actual finals survive retired TTL and count eviction, retain order, and settle exactly once', async () => {
  const f = fixture({ retiredLimit: 1, retiredTtlMs: 10 }), controller = new AbortController(), events = []
  const first = outcome(f.client.requestHost('frame', {}, { signal: controller.signal,
    onLateResponse: value => events.push(['late', value.payload.result.frame]), onActualFinal: value => events.push(['actual', value.status]) }))
  const request = f.lastRequest(); controller.abort(); hasCode(await first, 'ERR_RPC_CANCELLED')
  f.timers.advance(20); assert.equal(f.client.retiredCount, 0)
  const other = outcome(f.client.requestHost('state', {})); f.timers.advance(100); await other
  assert.equal(f.client.actualFinalCount, 1)
  f.reply(request, { status: 'queued' }); assert.deepEqual(events, [])
  f.reply(request, { status: 'ok', result: { frame: 42 } })
  assert.deepEqual(events, [['late', 42], ['actual', 'final']])
  assert.equal(f.client.actualFinalCount, 0)
  f.reply(request, { status: 'ok', result: { frame: 42 } }); assert.equal(events.length, 2)
  const close = f.client.close(); f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } }); await close
})

test('cancelled pinned requests retain a finite admission budget and the independent close reserve', async () => {
  const f = fixture({ maxPending: 4, reservedControlSlots: 2 }), receipts = []
  for (let index = 0; index < 2; index++) {
    const controller = new AbortController()
    const pending = outcome(f.client.requestHost('frame', {}, { signal: controller.signal, onActualFinal: value => receipts.push(value) }))
    controller.abort(); hasCode(await pending, 'ERR_RPC_CANCELLED')
  }
  hasCode(await outcome(f.client.requestHost('frame', {}, { onActualFinal: value => receipts.push(value) })), 'ERR_RPC_QUEUE_FULL')
  assert.equal(receipts[0].status, 'not-posted'); assert.equal(f.client.actualFinalCount, 2)
  const close = f.client.close(); f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } }); await close
  assert.deepEqual(receipts.map(value => value.status), ['not-posted', 'terminated', 'terminated'])
  assert.equal(f.worker.terminateCount, 1); assert.equal(f.client.actualFinalCount, 0)
})

test('cancelled actual requests retain byte reservations until final rather than oversubscribing Worker work', async () => {
  const f = fixture({ maxRequestBytes: 1024, maxInFlightBytes: 1024, maxControlRequestBytes: 64, reservedControlBytes: 128 })
  const payload = { text: 'x'.repeat(220) }, controller = new AbortController()
  const pending = outcome(f.client.requestHost('frame', payload, { signal: controller.signal, onActualFinal() {} }))
  const request = f.lastRequest(); controller.abort(); await pending
  hasCode(await outcome(f.client.requestHost('frame', payload)), 'ERR_RPC_QUEUE_FULL')
  f.reply(request, { status: 'ok', result: {} })
  const accepted = f.client.requestHost('frame', payload); f.reply(f.lastRequest(), { status: 'ok', result: {} }); await accepted
  const close = f.client.close(); f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } }); await close
})

test('termination uncertainty never becomes an owned genuine final', async () => {
  const f = fixture(), controller = new AbortController(), receipts = []
  const pending = outcome(f.client.requestHost('frame', {}, { signal: controller.signal, onActualFinal: value => receipts.push(value) }))
  controller.abort(); await pending
  f.worker.terminateError = new Error('termination uncertain')
  const close = outcome(f.client.close()); f.reply(f.lastRequest(), { status: 'ok', result: { closed: true } })
  assert.ok((await close).error)
  assert.equal(receipts[0].status, 'uncertain'); assert.equal(f.client.actualFinalCount, 0)
})

test('owned-final callbacks remain synchronous and callback failures cannot settle a request successfully', async () => {
  for (const callback of [() => { throw new Error('observer failed') }, () => Promise.resolve()]) {
    const f = fixture(), pending = outcome(f.client.requestHost('frame', {}, { onActualFinal: callback }))
    f.reply(f.lastRequest(), { status: 'ok', result: {} })
    assert.ok((await pending).error); assert.equal(f.client.state, 'failed')
    assert.equal(f.client.actualFinalCount, 0); assert.equal(f.worker.terminateCount, 1)
  }
})

test('cancellation publishes exact final ownership before reentrant timer cleanup can deliver it', async () => {
  let reenter = null
  const f = fixture({ clearTimer() { const callback = reenter; reenter = null; callback?.() } }), receipts = [], late = []
  const controller = new AbortController(), pending = outcome(f.client.requestHost('frame', {}, { signal: controller.signal,
    onLateResponse: value => late.push(value.payload.result), onActualFinal: value => receipts.push(value) }))
  const request = f.lastRequest(); reenter = () => f.reply(request, { status: 'ok', result: 7 })
  controller.abort(); hasCode(await pending, 'ERR_RPC_CANCELLED')
  assert.deepEqual(late, [7]); assert.equal(receipts[0].status, 'final')
  assert.equal(f.client.actualFinalCount, 0); assert.equal(f.client._pinnedRetiredBytes, 0)
  assert.equal(f.client.retiredCount, 0)
  f.reply(request, { status: 'ok', result: 7 }); assert.deepEqual(late, [7]); assert.equal(receipts.length, 1)
  await f.close()
})

test('reentrant shutdown during signal cleanup does not resurrect actual-final bytes or late handlers', async () => {
  const f = fixture(), receipts = []; let reenter
  const signal = { aborted: false, addEventListener(_, callback) { this.abort = callback }, removeEventListener() { reenter?.(); reenter = null } }
  const pending = outcome(f.client.requestHost('frame', {}, { signal, onActualFinal: value => receipts.push(value) }))
  reenter = () => f.worker.emit('error', { message: 'transport ended during abort cleanup' })
  signal.aborted = true; signal.abort(); await pending
  assert.equal(receipts[0].status, 'terminated'); assert.equal(receipts.length, 1)
  assert.equal(f.client.actualFinalCount, 0); assert.equal(f.client._pinnedRetiredBytes, 0)
  assert.equal(f.client.retiredCount, 0); await outcome(f.client.closed)
})

test('synchronous timeout setup releases the actual returned handle without posting or pinning a request', async () => {
  const handles = [], f = fixture({ setTimer(callback) { callback(); return 42 }, clearTimer(handle) { handles.push(handle) } }), receipts = []
  hasCode(await outcome(f.client.requestHost('frame', {}, { onActualFinal: value => receipts.push(value) })), 'ERR_RPC_TIMEOUT')
  assert.deepEqual(handles, [42]); assert.equal(receipts[0].status, 'not-posted')
  assert.equal(f.requests().length, 0); assert.equal(f.client.actualFinalCount, 0); assert.equal(f.client.inFlightBytes, 0)
  await outcome(f.client.close()); assert.equal(f.worker.terminateCount, 1)
})

test('a late consumer reentering with its duplicate final cannot repeat effects or release ownership early', async () => {
  const f = fixture(), controller = new AbortController(), events = []; let request
  const pending = outcome(f.client.requestHost('frame', {}, { signal: controller.signal,
    onLateResponse(value) {
      events.push(['effect', value.payload.result]); f.reply(request, { status: 'ok', result: 9 })
      assert.equal(f.client.actualFinalCount, 1, 'actual final notification follows the complete synchronous effect consumer')
    }, onActualFinal(value) { events.push(['actual', value.status]) } }))
  request = f.lastRequest(); controller.abort(); await pending
  f.reply(request, { status: 'ok', result: 9 })
  assert.deepEqual(events, [['effect', 9], ['actual', 'final']])
  assert.equal(f.client.actualFinalCount, 0); await f.close()
})


// Optional diagnostics are not business admission credit. No compiler/browser
// is exercised by these finite fake-Worker and descriptor-budget tests.
async function enableInputTiming(f) {
  const loading = f.client.requestHost('load', { inputTiming: { version: '1.0' } })
  f.reply(f.lastRequest(), { status: 'ok', result: { inputTiming: { version: '1.0' } } })
  await loading
}
const timingBridge = () => ({ envelope: { op: 'event.batch', payload: {} },
  inputTiming: { version: '1.0', sampleIds: ['1'] } })

test('optional timing fitting preserves exact legal byte, node and depth boundaries even without marker room', () => {
  for (const [base, limits] of [
    [{ business: 'x'.repeat(100) }, { maxBytes: measureWorkerPayload({ business: 'x'.repeat(100) }) }],
    [{ business: [1, 2, 3] }, { maxNodes: 5 }],
    [{ status: 'ok', result: { business: 'yes' } }, { maxDepth: 2, response: true }],
  ]) {
    measureWorkerPayload(base, limits)
    const original = structuredClone(base)
    // A marker is deeper than the legal response's deepest scalar in case 3.
    const diagnostic = { version: '1.0', sampleIds: ['1'], deep: { extra: { value: 'yes' } } }
    const fitted = fitWorkerInputTiming(base, diagnostic, limits)
    assert.deepEqual(fitted.payload, base)
    assert.deepEqual(base, original)
    assert.equal(fitted.baseBytes, measureWorkerPayload(base, limits))
    assert.equal(Object.hasOwn(limits.response ? fitted.payload.result : fitted.payload, 'inputTiming'), false)
  }
})

test('diagnostic-only byte/node/depth and invalid-data budgets omit diagnostics without invoking code', () => {
  let getterCalls = 0
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalls++; throw new Error('never') } })
  let deep = {}; for (let i = 0; i < 20; i++) deep = { nested: deep }
  for (const [diagnostic, reason] of [
    [{ text: 'x'.repeat(WORKER_INPUT_TIMING_LIMITS.maxBytes) }, 'diagnostic-budget'],
    [Array(WORKER_INPUT_TIMING_LIMITS.maxNodes + 1).fill(null), 'diagnostic-budget'],
    [deep, 'diagnostic-budget'], [getter, 'invalid-diagnostic'],
  ]) {
    const base = { business: 'success' }
    const result = fitWorkerInputTiming(base, diagnostic)
    assert.deepEqual(result.payload, { ...base, inputTiming: { version: '1.0', omitted: reason } })
    assert.equal(result.baseBytes, measureWorkerPayload(base))
  }
  const accessor = Object.defineProperty({ business: true }, 'inputTiming', { enumerable: true, get() { getterCalls++; throw new Error('never') } })
  const split = splitWorkerInputTiming(accessor)
  assert.deepEqual(fitWorkerInputTiming(split.base, split.diagnostic).payload,
    { business: true, inputTiming: { version: '1.0', omitted: 'invalid-diagnostic' } })
  assert.equal(getterCalls, 0)
  assert.throws(() => fitWorkerInputTiming(getter, {}), { code: 'ERR_RPC_ARGUMENT' }, 'invalid business data still fails normally')
  assert.equal(getterCalls, 0)
})

test('optional diagnostic bytes do not consume ordinary or actual-final pinned business credits', async () => {
  const payload = timingBridge(), base = splitWorkerInputTiming(payload).base
  const businessBytes = measureWorkerPayload(base)
  const f = fixture({ maxRequestBytes: businessBytes + 256, maxInFlightBytes: businessBytes * 2 + 256,
    maxControlRequestBytes: 64, reservedControlBytes: 256 })
  await enableInputTiming(f)
  const first = outcome(f.client.requestHost('bridge', payload, { onActualFinal() {} }))
  assert.equal(f.client.inFlightBytes, businessBytes)
  f.timers.advance(101)
  hasCode(await first, 'ERR_RPC_TIMEOUT')
  assert.equal(f.client.inFlightBytes, 0)
  const second = outcome(f.client.requestHost('bridge', payload, { onActualFinal() {} }))
  assert.equal(f.requests().filter(value => value.op === 'bridge').length, 2, 'both business requests fit despite their optional sidebands')
  const third = outcome(f.client.requestHost('bridge', base))
  hasCode(await third, 'ERR_RPC_QUEUE_FULL')
  const requests = f.requests().filter(value => value.op === 'bridge')
  f.reply(requests[0]); f.reply(requests[1])
  assert.equal((await second).error, undefined)
  assert.equal(f.client.actualFinalCount, 0)
  await f.close()
})

test('negotiated client trims optional requests and original/retained/recovery finals at its own limits', async () => {
  const payload = timingBridge(), base = splitWorkerInputTiming(payload).base
  const maxRequestBytes = measureWorkerPayload(base)
  const result = { frame: 'x'.repeat(1000) }, baseFinal = { status: 'ok', result }
  const f = fixture({ maxRequestBytes, maxResponseBytes: measureWorkerPayload(baseFinal),
    maxControlRequestBytes: 64, reservedControlBytes: 128 })
  await enableInputTiming(f)
  const pending = f.client.requestHost('bridge', payload)
  assert.deepEqual(f.lastRequest().payload, base, 'zero headroom means no optional marker is sent')
  f.reply(f.lastRequest(), { status: 'ok', result: {} }); await pending
  for (const op of ['bridge', 'frame', 'frame.current', 'surface.recover']) {
    const response = f.client.requestHost(op, {})
    f.reply(f.lastRequest(), { status: 'ok', result: { ...result, inputTiming: { version: '1.0', applied: Array(20).fill('ignored') } } })
    assert.deepEqual(await response, result, `${op} must preserve a legal business final without marker room`)
    assert.equal(f.client.state, 'open')
  }
  await f.close()
})

test('default callers retain strict business accounting and original over-budget failures', async () => {
  const payload = timingBridge(), base = splitWorkerInputTiming(payload).base
  const f = fixture({ maxRequestBytes: measureWorkerPayload(base) })
  hasCode(await outcome(f.client.requestHost('bridge', payload)), 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(f.requests().length, 0)
  await f.close()
})


test('client-specific node and depth limits retain business finals and only omit optional receipts', async () => {
  for (const [limits, result] of [[{ maxPayloadNodes: 5 }, { business: [null] }],
    [{ maxPayloadDepth: 3 }, { business: { nested: 'yes' } }]]) {
    const f = fixture(limits); await enableInputTiming(f)
    const pending = f.client.requestHost('frame', {})
    f.reply(f.lastRequest(), { status: 'ok', result: { ...result, inputTiming: { version: '1.0', applied: [{ before: { nested: 'yes' } }] } } })
    const received = await pending
    assert.deepEqual(received.business, result.business)
    if (limits.maxPayloadNodes) assert.equal(Object.hasOwn(received, 'inputTiming'), false)
    else assert.deepEqual(received.inputTiming, { version: '1.0', omitted: 'payload-budget' })
    await f.close()
  }
})

test('late bounded diagnostic omission preserves genuine actual-final and consumer callback ownership', async () => {
  const result = { frame: 'x'.repeat(1000) }, f = fixture({ maxResponseBytes: measureWorkerPayload({ status: 'ok', result }) })
  await enableInputTiming(f)
  const events = [], controller = new AbortController()
  const pending = outcome(f.client.requestHost('frame', {}, { signal: controller.signal,
    onLateResponse: value => events.push(['late', value.payload.result]), onActualFinal: value => events.push(['actual', value.status]) }))
  const request = f.lastRequest(); controller.abort()
  hasCode(await pending, 'ERR_RPC_CANCELLED')
  assert.equal(f.client.actualFinalCount, 1)
  f.reply(request, { status: 'ok', result: { ...result, inputTiming: { version: '1.0', applied: Array(20).fill('diagnostic') } } })
  assert.deepEqual(events, [['late', result], ['actual', 'final']])
  assert.equal(f.client.actualFinalCount, 0)
  assert.equal(f.client.inFlightBytes, 0)
  await f.close()
})


test('frame ownership belongs to the receiving client and can be consumed only once', async () => {
  const f = fixture(), other = fixture()
  const pending = f.client.requestHost('frame.current', {})
  const result = { renderRevision: '4', frame: { images: {} } }
  f.reply(f.lastRequest(), { status: 'ok', result })
  const received = await pending
  assert.equal(takeWorkerFrameResponse(other.client, received), false)
  assert.equal(takeWorkerFrameResponse(f.client, structuredClone(received)), false)
  assert.equal(takeWorkerFrameResponse(f.client, received), true)
  assert.equal(takeWorkerFrameResponse(f.client, received), false)
  assert.equal(takeWorkerFrameResponse(f.client, {}), false)
  const ordinary = f.client.requestHost('bridge', {})
  f.reply(f.lastRequest(), { status: 'ok', result: {} })
  assert.equal(takeWorkerFrameResponse(f.client, await ordinary), false)
  await f.close(); await other.close()
})
