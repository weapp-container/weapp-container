import assert from 'node:assert/strict'
import test from 'node:test'
import { attachSurfaceInput } from '../examples/hosts/web-wasm/surface-input.mjs'

function fixture(t, send, inputTiming) {
  let current = 'first', currentPage = '1', enabled = true, sequence = 0, logical = null
  const raf = new Map(), listeners = new Map(), captures = new Set(), batches = [], errors = []
  const timingBatches = []
  const previousMicrotask = globalThis.queueMicrotask
  globalThis.queueMicrotask = callback => { raf.set(++sequence, callback) }
  t.after(() => { globalThis.queueMicrotask = previousMicrotask })
  const canvas = {
    width: 200, height: 400, style: { touchAction: 'manipulation' },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 200 }),
    addEventListener: (name, listener, options) => listeners.set(name, { listener, options }),
    removeEventListener: name => listeners.delete(name),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
  }
  const controller = attachSurfaceInput(canvas, {
    session: () => current, active: () => enabled,
    logicalSize: () => logical || ({ width: canvas.width, height: canvas.height }),
    epoch: () => JSON.stringify([current, currentPage, logical?.width || canvas.width, logical?.height || canvas.height]),
    send(events, session, epoch, timing) { batches.push({ events, session }); timingBatches.push(timing); return send?.(events, session, epoch, timing) },
    ...(inputTiming ? { inputTiming } : {}),
    onError: error => errors.push(error.message),
  })
  t.after(() => controller.dispose())
  return {
    canvas, batches, errors, controller, captures, listeners, raf, timingBatches,
    session: value => { current = value }, active: value => { enabled = value },
    page: value => { currentPage = value },
    logicalSize: value => { logical = value },
    emit(name, values = {}) {
      const event = { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 35, clientY: 60,
        preventDefault() { this.prevented = true }, ...values }
      listeners.get(name)?.listener(event)
      return event
    },
    async frame() { const callbacks = [...raf.values()]; raf.clear(); await Promise.all(callbacks.map(callback => callback())) },
  }
}

test('wheel uses logical pixels, normalizes all DOM modes, and preserves ordered deltas in one batch', async t => {
  const c = fixture(t)
  assert.equal(c.listeners.get('wheel').options.passive, false)
  const first = c.emit('wheel', { deltaX: 2, deltaY: 3, deltaMode: 0 })
  c.emit('wheel', { deltaX: 1, deltaY: 2, deltaMode: 1 })
  assert.equal(first.prevented, true)
  await c.frame()
  assert.deepEqual(c.batches, [{ session: 'first', events: [{
    type: 'wheel', x: 50, y: 80, deltaX: 4, deltaY: 6, deltaMode: 0, bubbles: true,
  }, {
    type: 'wheel', x: 50, y: 80, deltaX: 32, deltaY: 64, deltaMode: 0, bubbles: true,
  }] }])
  c.emit('wheel', { deltaX: 1, deltaY: 1, deltaMode: 2 })
  await c.frame()
  assert.equal(c.batches[1].events[0].deltaX, 200)
  assert.equal(c.batches[1].events[0].deltaY, 400)
  assert.equal(c.emit('wheel', { ctrlKey: true, deltaY: 9, deltaMode: 0 }).prevented, undefined)
  assert.equal(c.emit('wheel', { deltaY: NaN, deltaMode: 0 }).prevented, undefined)
  assert.equal(c.raf.size, 0)
})

test('diagnostic native-event ids preserve batching and touchend/tap share one captured input', async t => {
  let sequence = 0
  const captured = [], queued = [], dropped = []
  const c = fixture(t, undefined, { capture: value => { captured.push(value); return String(++sequence) },
    queued: ids => queued.push(ids), drop: (ids, reason) => { if (ids.length) dropped.push({ ids, reason }) } })
  c.emit('pointerdown', { pointerType: 'touch', timeStamp: 4, isTrusted: true })
  await c.frame()
  c.emit('pointerup', { pointerType: 'touch', timeStamp: 8, isTrusted: true })
  await c.frame()
  assert.equal(captured.length, 2)
  assert.deepEqual(c.batches[1].events.map(event => event.type), ['touchend', 'tap'])
  assert.deepEqual(c.timingBatches, [{ version: '1.0', sampleIds: ['1'] }, { version: '1.0', sampleIds: ['2'] }])
  assert.deepEqual(queued, [['1'], ['2']]); assert.deepEqual(dropped, [])
  assert.equal(captured[1].nativeTimeStamp, 8); assert.equal(captured[1].isTrusted, true)
  assert.equal(Object.hasOwn(c.batches[1].events[0], 'sampleId'), false, 'diagnostics stay outside the business payload')
})

test('reset and a retired surface report queued diagnostic input discard explicitly', async t => {
  let sequence = 0
  const dropped = [], c = fixture(t, undefined, { capture: () => String(++sequence), drop: (ids, reason) => { if (ids.length) dropped.push({ ids, reason }) } })
  c.emit('wheel', { deltaY: 1, deltaX: 0, deltaMode: 0 }); c.controller.reset(); await c.frame()
  c.emit('wheel', { deltaY: 1, deltaX: 0, deltaMode: 0 }); c.page('2'); await c.frame()
  assert.deepEqual(dropped, [{ ids: ['1'], reason: 'input-reset' }, { ids: ['2'], reason: 'queued-surface-retired' }])
  assert.deepEqual(c.batches, [])
})

test('throwing or async diagnostic hooks cannot replace input success or failure', async t => {
  const failure = new Error('business failure')
  const c = fixture(t, () => { throw failure }, { capture: () => Promise.reject(new Error('diagnostic failure')), drop() { throw Error('diagnostic drop') } })
  c.emit('wheel', { deltaY: 1, deltaX: 0, deltaMode: 0 }); await c.frame()
  assert.deepEqual(c.errors, ['business failure']); assert.equal(c.batches.length, 1)
  assert.ok(c.controller.inputTimingFailures >= 1)
  assert.equal(c.timingBatches[0], undefined)
})

test('wheel reversals retain clamp and residual semantics instead of cancelling before runtime dispatch', async t => {
  let offset = 0
  const c = fixture(t, events => {
    for (const event of events) offset = Math.max(0, Math.min(100, offset + event.deltaY))
  })
  c.emit('wheel', { deltaX: 0, deltaY: -5, deltaMode: 0 })
  c.emit('wheel', { deltaX: 0, deltaY: 5, deltaMode: 0 })
  await c.frame()
  assert.equal(c.batches.length, 1)
  assert.equal(offset, 10)
  offset = 100
  c.emit('wheel', { deltaX: 0, deltaY: 5, deltaMode: 0 })
  c.emit('wheel', { deltaX: 0, deltaY: -5, deltaMode: 0 })
  await c.frame()
  assert.equal(offset, 90)
})

test('touch capture preserves event order and contact ID; a drag never becomes tap', async t => {
  const c = fixture(t)
  const touch = { pointerType: 'touch', pointerId: 7 }
  c.emit('pointerdown', touch)
  c.emit('pointermove', { ...touch, clientY: 80 })
  c.emit('pointerup', { ...touch, clientY: 90 })
  await c.frame()
  const events = c.batches[0].events
  assert.deepEqual(events.map(event => event.type), ['touchstart', 'touchmove', 'touchend'])
  assert.ok(events.every(event => event.changedTouches[0].identifier === 7))
  assert.deepEqual(events.map(event => event.y), [80, 120, 140])
  assert.deepEqual(events.at(-1).touches, [])
  assert.equal(c.captures.size, 0)
  c.emit('pointerdown', touch)
  c.emit('pointerup', touch)
  await c.frame()
  assert.deepEqual(c.batches[1].events.map(event => event.type), ['touchstart', 'touchend', 'tap'])
  assert.equal(c.batches[1].events.at(-1).changedTouches[0].identifier, 7,
    'touch tap consumes the same captured runtime contact, rather than rerouting by pixels')
})

test('cancellation and mouse drag suppress taps; mouse click stays a single tap', async t => {
  const c = fixture(t)
  c.emit('pointerdown', { pointerType: 'pen' })
  c.emit('pointercancel', { pointerType: 'pen' })
  c.emit('pointerdown')
  c.emit('pointerup', { clientY: 100 })
  c.emit('pointerdown')
  c.emit('pointerup')
  await c.frame()
  assert.deepEqual(c.batches[0].events.map(event => event.type), ['touchstart', 'touchcancel', 'tap'])
})

test('a slow bridge keeps one batch in flight and never sends queued old-session input to a new app', async t => {
  let finish
  const c = fixture(t, () => new Promise(resolve => { finish = resolve }))
  const wheel = { deltaX: 0, deltaY: 2, deltaMode: 0 }
  c.emit('wheel', wheel)
  const sending = c.frame()
  c.emit('wheel', wheel)
  assert.equal(c.batches.length, 1)
  assert.equal(c.raf.size, 0)
  c.session('replacement')
  finish()
  await sending
  await c.frame()
  assert.equal(c.batches.length, 1, 'discard input whose session has already been replaced')
  c.emit('wheel', wheel)
  const next = c.frame()
  assert.equal(c.batches[1].session, 'replacement')
  finish()
  await next
})

test('disposed or suspended surfaces release only their listeners, captures and pending work', async t => {
  const c = fixture(t)
  c.emit('pointerdown', { pointerType: 'touch' })
  assert.equal(c.captures.size, 1)
  c.controller.dispose()
  c.controller.dispose()
  assert.equal(c.captures.size, 0)
  assert.equal(c.listeners.size, 0)
  await c.frame()
  assert.equal(c.raf.size, 0)
  assert.equal(c.canvas.style.touchAction, 'manipulation')
  await c.frame()
  assert.deepEqual(c.batches, [])
})

test('session replacement releases stale pointer ownership; stale failures cannot overlay the replacement', async t => {
  let fail
  const c = fixture(t, () => new Promise((_, reject) => { fail = reject }))
  c.emit('pointerdown')
  c.session('replacement')
  c.emit('pointerdown', { pointerId: 2 })
  c.emit('pointerup', { pointerId: 2 })
  const sending = c.frame()
  assert.equal(c.batches[0].session, 'replacement')
  assert.equal(c.captures.size, 0)
  c.session('third')
  fail(new Error('old session transport failed'))
  await sending
  assert.deepEqual(c.errors, [])
  c.active(false)
  assert.equal(c.emit('wheel', { deltaX: 0, deltaY: 2, deltaMode: 0 }).prevented, undefined)
  assert.equal(c.raf.size, 0)
})

test('a render failure that suspends the current session still reaches its error overlay', async t => {
  const c = fixture(t, () => {
    c.active(false)
    throw new Error('ERR_RENDER: current frame presentation failed')
  })
  c.emit('wheel', { deltaX: 0, deltaY: 2, deltaMode: 0 })
  await c.frame()
  assert.deepEqual(c.errors, ['ERR_RENDER: current frame presentation failed'])
  assert.equal(c.emit('wheel', { deltaX: 0, deltaY: 2, deltaMode: 0 }).prevented, undefined)
})

test('same-session navigation retires a delayed old-page error while current-page failures remain visible', async t => {
  let fail
  const c = fixture(t, () => new Promise((_, reject) => { fail = reject }))
  const wheel = { deltaX: 0, deltaY: 2, deltaMode: 0 }
  c.emit('wheel', wheel)
  const oldPage = c.frame()
  c.page('9007199254740993')
  fail(new Error('old page transport failed'))
  await oldPage
  assert.deepEqual(c.errors, [], 'a retired page cannot overlay its replacement in the same session')
  c.emit('wheel', wheel)
  const currentPage = c.frame()
  c.active(false)
  fail(new Error('ERR_RENDER: current page presentation failed'))
  await currentPage
  assert.deepEqual(c.errors, ['ERR_RENDER: current page presentation failed'])
})

for (const scale of [1, 1.5, 2, 3, 4]) {
  test(`render density ${scale}x preserves logical pointer, wheel and six-pixel tap threshold`, async t => {
    const c = fixture(t)
    c.logicalSize({ width: 200, height: 400 })
    c.canvas.width = 200 * scale
    c.canvas.height = 400 * scale
    c.emit('wheel', { deltaX: 2, deltaY: 3, deltaMode: 0 })
    c.emit('pointerdown', { pointerType: 'touch' })
    c.emit('pointerup', { pointerType: 'touch', clientX: 37.5 })
    await c.frame()
    const events = c.batches[0].events
    assert.deepEqual(events.map(event => event.type), ['wheel', 'touchstart', 'touchend', 'tap'])
    assert.equal(events[0].x, 50)
    assert.equal(events[0].y, 80)
    assert.equal(events[0].deltaX, 4)
    assert.equal(events[0].deltaY, 6)
    assert.equal(events.at(-1).x, 55, 'five logical pixels remain a tap at every render density')
    c.emit('pointerdown')
    c.emit('pointerup', { clientX: 38.5 })
    await c.frame()
    assert.equal(c.batches.length, 1, 'seven logical pixels suppress a tap at every density')
  })
}

test('logical geometry epochs discard queued coordinates and stale captures; reset retains listeners', async t => {
  const c = fixture(t)
  c.logicalSize({ width: 200, height: 400 })
  c.emit('wheel', { deltaX: 0, deltaY: 1, deltaMode: 0 })
  c.emit('pointerdown', { pointerType: 'touch' })
  c.logicalSize({ width: 400, height: 200 })
  c.emit('pointerup', { pointerType: 'touch' })
  await c.frame()
  assert.deepEqual(c.batches, [], 'coordinates from the old logical viewport cannot enter a new layout')
  assert.equal(c.captures.size, 0)
  c.emit('pointerdown', { pointerType: 'touch' })
  c.controller.reset()
  assert.equal(c.captures.size, 0)
  await c.frame()
  assert.equal(c.raf.size, 0)
  assert.equal(c.listeners.size, 6, 'reset releases only input work, not installed listeners')
  c.emit('pointerup', { pointerType: 'touch' })
  await c.frame()
  assert.deepEqual(c.batches, [])
  c.emit('pointerdown')
  c.emit('pointerup')
  await c.frame()
  assert.equal(c.batches[0].events[0].type, 'tap', 'fresh input remains usable after reset')
})
