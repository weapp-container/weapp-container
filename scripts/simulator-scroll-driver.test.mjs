import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { driveBrowserRafWheels } from './lib/simulator-scroll-driver.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Run the actual page-evaluate function in a separate JS realm. No browser,
// renderer or fake DOM events participate in these driver lifecycle tests.
function harness(send = () => Promise.resolve(), devicePixelRatio = 1, admissionReply = reply => reply) {
  let now = 0, sequence = 0, disposed = 0, cancelled = 0
  const callbacks = new Map(), calls = [], frame = {}, bindings = new Map()
  const realm = vm.createContext({ devicePixelRatio, performance: { now: () => now },
    requestAnimationFrame: callback => { const id = ++sequence; callbacks.set(id, callback); return id },
    cancelAnimationFrame: id => { callbacks.delete(id); cancelled++ } })
  const page = {
    mainFrame: () => frame,
    async exposeBinding(name, callback) {
      assert.equal(bindings.has(name), false)
      bindings.set(name, callback)
      realm[name] = request => admissionReply(callback({ page, frame }, structuredClone(request)))
      return { async dispose() { disposed++; bindings.delete(name); delete realm[name] } }
    },
    evaluate(fn, arg) {
      realm.__argument = structuredClone(arg)
      return vm.runInContext(`(${fn.toString()})(__argument)`, realm)
    },
  }
  const cdp = { send(method, payload) { calls.push({ method, payload }); return send(method, payload) } }
  return { page, cdp, calls, bindings, realm,
    get disposed() { return disposed }, get cancelled() { return cancelled }, get scheduled() { return callbacks.size },
    async ready() { for (let i = 0; i < 5 && !callbacks.size; i++) await flush(); assert.equal(callbacks.size, 1) },
    async tick(timestamp) {
      now = timestamp + .1
      const current = [...callbacks.values()]
      callbacks.clear()
      for (const callback of current) callback(timestamp)
      await flush()
    },
  }
}

test('241 native wheel calls are clocked only by real RAF opportunities, without timer catchup', async () => {
  const h = harness(), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 150, y: 500, evidence })
  await h.ready()
  await flush()
  assert.equal(h.calls.length, 0, 'Node time cannot produce input')
  for (let i = 0; i < 241; i++) {
    // A missing RAF leaves an actual gap; it cannot manufacture a catchup input.
    await h.tick((i + (i >= 100 ? 1 : 0)) * 1000 / 60)
    assert.equal(h.calls.length, i + 1)
  }
  await done
  assert.equal(evidence.browser.records.length, 241)
  assert.ok(evidence.browser.records[100].rafTimestamp - evidence.browser.records[99].rafTimestamp > 30)
  assert.ok(h.calls.every(call => call.method === 'Input.dispatchMouseEvent' &&
    call.payload.type === 'mouseWheel' && call.payload.deltaX === 0 && call.payload.deltaY === 3 &&
    call.payload.x === 150 && call.payload.y === 500))
  assert.equal(evidence.observedMaxInflight, 1)
  assert.equal(evidence.driverVersion, 2)
  assert.equal(evidence.browser.acknowledgement, 'native-command-admission')
  assert.equal(evidence.status, 'completed')
  assert.equal(evidence.cleanup.rafStopped, true)
  assert.equal(evidence.cleanup.bindingDisposed, true)
  assert.equal(h.disposed, 1)
  assert.equal(h.bindings.size, 0)
  assert.equal(h.scheduled, 0)
  assert.equal(h.realm.__weappRafWheelControl, undefined)
})

test('slow CDP acknowledgements do not serialize the RAF clock and remain bounded', async () => {
  const pending = [], h = harness(() => { const next = deferred(); pending.push(next); return next.promise }), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 6, evidence })
  await h.ready()
  for (let i = 0; i < 4; i++) await h.tick(i * 1000 / 60)
  assert.equal(h.calls.length, 4, 'four opportunities can dispatch before the first reply')
  assert.equal(evidence.observedMaxInflight, 4)
  assert.ok(evidence.dispatches.every(record => record.ok === undefined), 'native commands remain outstanding')
  for (const request of pending) request.resolve()
  await flush()
  for (let i = 4; i < 6; i++) {
    await h.tick(i * 1000 / 60)
    pending.at(-1).resolve()
    await flush()
  }
  await done
  assert.equal(h.calls.length, 6)
  assert.ok(evidence.browser.records.every(record => record.inflightBefore === 0), 'native completions do not retain browser admission credits')
  assert.ok(evidence.browser.records.every(record => Number.isFinite(record.admissionAcknowledgedAt)))
  assert.equal(evidence.status, 'completed')
})

test('all admissions acknowledged does not finish before every native command completes', async () => {
  const pending = deferred(), h = harness(() => pending.promise), evidence = {}
  let settled = false
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 1, evidence }).finally(() => { settled = true })
  await h.ready()
  await h.tick(0)
  assert.equal(evidence.browser.status, 'completed', 'the browser has completed admission only')
  assert.equal(evidence.browser.pending, 0)
  assert.equal(evidence.browser.records[0].ok, true)
  assert.equal(evidence.dispatches[0].ok, undefined)
  assert.equal(settled, false)
  assert.equal(h.disposed, 0, 'owned resources remain active during the completion drain')
  pending.resolve()
  await done
  assert.equal(evidence.dispatches[0].ok, true)
  assert.equal(evidence.cleanup.nativePendingAtCleanup, 0)
  assert.equal(h.disposed, 1)
})

test('native failure after the final admission still fails the run', async () => {
  const pending = deferred(), h = harness(() => pending.promise), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 1, evidence })
  const rejected = assert.rejects(done, /native dispatch 0: late CDP failure/)
  await h.ready()
  await h.tick(0)
  assert.equal(evidence.browser.status, 'completed')
  pending.reject(new Error('late CDP failure'))
  await rejected
  assert.equal(evidence.dispatches[0].ok, false)
  assert.equal(evidence.errors[0].code, 'ERR_DRIVER_NATIVE_DISPATCH')
  assert.equal(evidence.status, 'failed')
  assert.equal(h.disposed, 1)
})

for (const devicePixelRatio of [1, 1.5, 2]) test(`DPR ${devicePixelRatio} converts three logical CSS pixels into native CDP device pixels`, async () => {
  const h = harness(undefined, devicePixelRatio), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 150, y: 500, count: 1, evidence })
  await h.ready()
  await h.tick(0)
  await done
  assert.equal(evidence.devicePixelRatio, devicePixelRatio)
  assert.deepEqual(evidence.requestedLogicalDelta, { x: 0, y: 3, unit: 'css-px' })
  assert.deepEqual(evidence.cdpPhysicalDelta, { x: 0, y: 3 * devicePixelRatio, unit: 'device-px' })
  assert.equal(h.calls[0].payload.deltaY, 3 * devicePixelRatio)
  assert.equal(h.calls[0].payload.deltaY / devicePixelRatio, evidence.requestedLogicalDelta.y)
  assert.equal(h.calls[0].payload.x, 150, 'pointer coordinates remain in the browser viewport coordinate system')
  assert.equal(h.calls[0].payload.y, 500)
})

test('invalid browser DPR fails explicitly instead of silently changing wheel distance', async () => {
  for (const devicePixelRatio of [0, -1, NaN, Infinity]) {
    const h = harness(undefined, devicePixelRatio), evidence = {}
    await assert.rejects(driveBrowserRafWheels({ ...h, x: 1, y: 2, evidence }), /devicePixelRatio must be positive and finite/)
    assert.equal(h.calls.length, 0)
    assert.equal(h.bindings.size, 0)
    assert.equal(h.scheduled, 0)
    assert.equal(evidence.status, 'failed')
  }
})

test('native backpressure fails at the unchanged four-command limit instead of queueing or bursting', async () => {
  const pending = [], h = harness(() => { const next = deferred(); pending.push(next); return next.promise }), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 10, evidence })
  const rejected = assert.rejects(done, /ERR_DRIVER_NATIVE_BACKPRESSURE/)
  await h.ready()
  for (let i = 0; i < 5; i++) await h.tick(i * 1000 / 60)
  await rejected
  assert.equal(h.calls.length, 4)
  assert.equal(evidence.observedMaxInflight, 4)
  assert.equal(evidence.errors[0].code, 'ERR_DRIVER_NATIVE_BACKPRESSURE')
  assert.equal(evidence.errors[0].pending, 4)
  assert.ok(evidence.browser.records.every(record => record.inflightBefore === 0), 'admissions did not wait on native responses')
  assert.equal(evidence.status, 'failed')
  assert.equal(h.disposed, 1)
  assert.equal(h.scheduled, 0)
  for (const request of pending) request.resolve()
  await flush()
  await h.tick(200)
  assert.equal(h.calls.length, 4, 'late replies cannot restart dispatch')
})

test('browser admission backpressure remains explicit when binding replies cannot be delivered', async () => {
  const replies = [], h = harness(undefined, 1, reply => { const next = deferred(); replies.push({ ...next, reply }); return next.promise }), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 10, evidence })
  const rejected = assert.rejects(done, /RAF wheel driver failed: failed/)
  await h.ready()
  for (let i = 0; i < 5; i++) await h.tick(i * 1000 / 60)
  await rejected
  assert.equal(h.calls.length, 4)
  assert.equal(evidence.observedMaxInflight, 1, 'native capacity was available')
  assert.equal(evidence.browser.errors[0].code, 'ERR_DRIVER_BACKPRESSURE')
  assert.equal(evidence.browser.errors[0].pending, 4)
  assert.equal(h.disposed, 1)
  assert.equal(h.scheduled, 0)
  for (const reply of replies) reply.resolve(reply.reply)
  await flush()
  assert.equal(h.calls.length, 4)
})

test('native input failure cancels the scheduled callback and removes the binding', async () => {
  const h = harness(() => Promise.reject(new Error('CDP target closed'))), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 3, evidence })
  const rejected = assert.rejects(done, /RAF wheel driver failed/)
  await h.ready()
  await h.tick(0)
  await rejected
  assert.equal(evidence.dispatches[0].ok, false)
  assert.equal(evidence.dispatches[0].error, 'CDP target closed')
  assert.equal(evidence.errors[0].code, 'ERR_DRIVER_NATIVE_DISPATCH')
  assert.equal(h.disposed, 1)
  assert.equal(h.scheduled, 0)
  assert.ok(h.cancelled > 0)
})

test('abort removes pending RAF and binding without waiting for a stuck CDP response', async () => {
  const pending = deferred(), h = harness(() => pending.promise), evidence = {}, controller = new AbortController()
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, evidence, signal: controller.signal })
  const rejected = assert.rejects(done, /owned smoke interrupted/)
  await h.ready()
  await h.tick(0)
  controller.abort(new Error('owned smoke interrupted'))
  await rejected
  assert.equal(evidence.status, 'failed')
  assert.equal(evidence.cleanup.abortListenerRemoved, true)
  assert.equal(h.disposed, 1)
  assert.equal(h.scheduled, 0)
  pending.resolve()
  await flush()
})

test('timeout is bounded even when the browser never produces its first RAF', async () => {
  const h = harness(), evidence = {}
  await assert.rejects(driveBrowserRafWheels({ ...h, x: 1, y: 2, evidence, timeoutMs: 20 }), /exceeded 20 ms/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.disposed, 1)
  assert.equal(h.scheduled, 0)
  assert.equal(evidence.status, 'failed')
})

test('timeout also bounds the native completion drain after all admissions', async () => {
  const pending = deferred(), h = harness(() => pending.promise), evidence = {}
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 1, evidence, timeoutMs: 50 })
  const rejected = assert.rejects(done, /exceeded 50 ms/)
  await h.ready()
  await h.tick(0)
  assert.equal(evidence.browser.status, 'completed')
  await rejected
  assert.equal(evidence.cleanup.nativePendingAtCleanup, 1)
  assert.equal(evidence.status, 'failed')
  assert.equal(h.disposed, 1)
  pending.resolve()
  await flush()
  assert.equal(evidence.dispatches[0].ok, true)
  assert.equal(evidence.status, 'failed', 'a late native success cannot change the timed-out run')
})

test('startup deadline bounds a hung DPR read and its late reply cannot install resources', { timeout: 1_000 }, async () => {
  const read = deferred(), h = harness(), evidence = {}
  h.page.evaluate = () => read.promise
  await assert.rejects(driveBrowserRafWheels({ ...h, x: 1, y: 2, evidence, timeoutMs: 20, cleanupTimeoutMs: 20 }), /exceeded 20 ms/)
  assert.equal(evidence.timeoutPhase, 'browser-dpr')
  assert.equal(evidence.cleanup.rafNotStarted, true)
  assert.equal(evidence.status, 'failed')
  read.resolve(2)
  await flush()
  assert.equal(h.bindings.size, 0)
  assert.equal(h.scheduled, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(evidence.status, 'failed')
})

test('abort during a hung startup read is preserved and a late read cannot resume it', { timeout: 1_000 }, async () => {
  const read = deferred(), h = harness(), evidence = {}, controller = new AbortController()
  h.page.evaluate = () => read.promise
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, evidence, signal: controller.signal, cleanupTimeoutMs: 20 })
  const rejected = assert.rejects(done, /cancelled during DPR read/)
  await flush()
  controller.abort(new Error('cancelled during DPR read'))
  await rejected
  read.resolve(2)
  await flush()
  assert.equal(evidence.status, 'failed')
  assert.equal(evidence.cleanup.abortListenerRemoved, true)
  assert.equal(h.bindings.size, 0)
  assert.equal(h.scheduled, 0)
})

test('hung binding acquisition is bounded and a late binding is disposed exactly once', { timeout: 1_000 }, async () => {
  const acquisition = deferred(), h = harness(), original = h.page.exposeBinding, evidence = {}
  h.page.exposeBinding = async (...args) => { await acquisition.promise; return original(...args) }
  await assert.rejects(driveBrowserRafWheels({ ...h, x: 1, y: 2, evidence, timeoutMs: 20, cleanupTimeoutMs: 20 }), /exceeded 20 ms/)
  assert.equal(evidence.timeoutPhase, 'binding-acquisition')
  assert.equal(evidence.cleanup.bindingAcquisitionPendingAtCleanup, true)
  assert.equal(evidence.cleanup.bindingIncompleteAtReturn, true)
  assert.match(evidence.cleanup.bindingError, /binding cleanup exceeded 20 ms/)
  assert.equal(h.bindings.size, 0)
  acquisition.resolve()
  await flush()
  assert.equal(evidence.cleanup.bindingAcquiredAfterStop, true)
  assert.equal(evidence.cleanup.bindingDisposed, true)
  assert.equal(h.disposed, 1)
  assert.equal(h.bindings.size, 0)
  assert.equal(h.scheduled, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(evidence.status, 'failed', 'late acquisition cannot turn the timed-out run into success')
})

test('hung RAF cleanup returns failure so the caller can detach and late cleanup cannot claim success', { timeout: 1_000 }, async () => {
  const stop = deferred(), h = harness(), original = h.page.evaluate, evidence = {}
  h.page.evaluate = async (fn, arg) => {
    if (fn.name === 'stopBrowserRafWheels') await stop.promise
    return original(fn, arg)
  }
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 1, evidence, cleanupTimeoutMs: 20 })
  const rejected = assert.rejects(done, /raf cleanup exceeded 20 ms/)
  await h.ready()
  await h.tick(0)
  await rejected
  assert.equal(evidence.cleanup.rafIncompleteAtReturn, true)
  assert.equal(evidence.cleanup.rafStopped, undefined)
  assert.equal(evidence.cleanup.bindingDisposed, true)
  assert.equal(evidence.status, 'failed')
  stop.resolve()
  await flush()
  assert.equal(evidence.cleanup.rafStopped, true)
  assert.equal(h.realm.__weappRafWheelControl, undefined)
  assert.equal(evidence.status, 'failed')
})

test('hung binding disposal is bounded and remains a failed run after late disposal', { timeout: 1_000 }, async () => {
  const disposal = deferred(), h = harness(), original = h.page.exposeBinding, evidence = {}
  h.page.exposeBinding = async (...args) => {
    const binding = await original(...args)
    return { async dispose() { await disposal.promise; await binding.dispose() } }
  }
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 1, evidence, cleanupTimeoutMs: 20 })
  const rejected = assert.rejects(done, /binding cleanup exceeded 20 ms/)
  await h.ready()
  await h.tick(0)
  await rejected
  assert.equal(evidence.cleanup.rafStopped, true)
  assert.equal(evidence.cleanup.bindingIncompleteAtReturn, true)
  assert.equal(evidence.cleanup.bindingDisposed, undefined)
  assert.equal(h.bindings.size, 1)
  assert.equal(evidence.status, 'failed')
  disposal.resolve()
  await flush()
  assert.equal(evidence.cleanup.bindingDisposed, true)
  assert.equal(h.disposed, 1)
  assert.equal(h.bindings.size, 0)
  assert.equal(evidence.status, 'failed')
})

test('cancellation during cleanup remains a failure while owned resources finish disposal', { timeout: 1_000 }, async () => {
  const disposal = deferred(), entered = deferred(), h = harness(), original = h.page.exposeBinding, evidence = {}, controller = new AbortController()
  h.page.exposeBinding = async (...args) => {
    const binding = await original(...args)
    return { async dispose() { entered.resolve(); await disposal.promise; await binding.dispose() } }
  }
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 1, evidence, signal: controller.signal, cleanupTimeoutMs: 100 })
  const rejected = assert.rejects(done, /cancelled during binding cleanup/)
  await h.ready()
  await h.tick(0)
  await entered.promise
  controller.abort(new Error('cancelled during binding cleanup'))
  disposal.resolve()
  await rejected
  assert.equal(evidence.cleanup.bindingDisposed, true)
  assert.equal(evidence.cleanup.abortListenerRemoved, true)
  assert.equal(h.bindings.size, 0)
  assert.equal(evidence.status, 'failed')
})

test('binding cleanup failure remains an explicit driver failure', async () => {
  const h = harness(), original = h.page.exposeBinding, evidence = {}
  h.page.exposeBinding = async (...args) => {
    const binding = await original(...args)
    return { async dispose() { await binding.dispose(); throw new Error('binding cleanup failed') } }
  }
  const done = driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 1, evidence })
  const rejected = assert.rejects(done, /binding cleanup failed/)
  await h.ready()
  await h.tick(0)
  await rejected
  assert.equal(evidence.cleanup.bindingError, 'binding cleanup failed')
  assert.equal(evidence.status, 'failed')
  assert.equal(h.scheduled, 0)
})

test('invalid options and an already aborted run never install browser resources', async () => {
  const h = harness()
  await assert.rejects(driveBrowserRafWheels({ ...h, x: 1, y: 2, count: 0 }), /invalid RAF wheel driver options/)
  await assert.rejects(driveBrowserRafWheels({ ...h, x: 1, y: 2, cleanupTimeoutMs: 0 }), /invalid RAF wheel driver options/)
  const controller = new AbortController()
  controller.abort(new Error('cancelled before startup'))
  await assert.rejects(driveBrowserRafWheels({ ...h, x: 1, y: 2, signal: controller.signal }), /cancelled before startup/)
  assert.equal(h.bindings.size, 0)
  assert.equal(h.scheduled, 0)
})
