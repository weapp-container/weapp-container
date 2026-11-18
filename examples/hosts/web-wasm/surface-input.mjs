/** Translate surface input once, at the host boundary. The runtime owns hit
 * testing, scrolling, event capture and page state. No DOM node mirrors. */
export function attachSurfaceInput(canvas, { session, active = () => true, epoch = () => session(), logicalSize = () => ({ width: canvas.width, height: canvas.height }), send, onError = () => {}, inputTiming }) {
  let disposed = false, scheduled = null, sending = false, pending = [], pointer = null, scheduleVersion = 0, inputTimingFailures = 0
  const previousTouchAction = canvas.style.touchAction
  canvas.style.touchAction = 'none'
  const listeners = []
  const observedInputs = new WeakMap()
  // Diagnostics cannot throw into input, await, copy business data or choose
  // the batching/scheduling policy. One native event can translate to two
  // events (touchend/tap); it still owns one diagnostic sample.
  const trace = (method, ...args) => { try {
    const result = inputTiming?.[method]?.(...args)
    if (result && typeof result.then === 'function') { inputTimingFailures++; void Promise.resolve(result).catch(() => {}); return undefined }
    return result
  } catch { inputTimingFailures++; return undefined } }
  const tokens = items => [...new Set(items.map(item => item.sampleId).filter(value => typeof value === 'string'))]
  const ready = () => !disposed && active() && session()
  const point = event => {
    const rect = canvas.getBoundingClientRect()
    const size = logicalSize()
    if (!(rect.width > 0 && rect.height > 0 && size?.width > 0 && size?.height > 0)) return null
    const x = (event.clientX - rect.left) * size.width / rect.width
    const y = (event.clientY - rect.top) * size.height / rect.height
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y, rect, size } : null
  }
  async function flush() {
    scheduled = null
    if (sending || disposed) return
    const current = ready()
    const owner = epoch()
    const accepted = [], discarded = []
    for (const item of pending) (item.session === current && item.epoch === owner ? accepted : discarded).push(item)
    if (inputTiming) trace('drop', tokens(discarded), 'queued-surface-retired')
    const events = accepted.map(item => item.event), sampleIds = tokens(accepted)
    pending = []
    if (!events.length) return
    sending = true
    trace('drop', sampleIds.slice(64), 'diagnostic-batch-budget')
    const retainedIds = sampleIds.slice(0, 64)
    trace('queued', retainedIds)
    try { await (retainedIds.length ? send(events, current, owner, { version: '1.0', sampleIds: retainedIds }) : send(events, current, owner)) } catch (error) {
      trace('drop', retainedIds, 'input-request-error')
      // A failed render may suspend this same input owner. Navigation or a
      // changed coordinate space retires an older request's error as well.
      if (!disposed && session() === current && epoch() === owner) onError(error)
    }
    finally { sending = false; if (pending.length && !disposed) schedule() }
  }
  function schedule() {
    if (scheduled !== null || sending) return
    const token = ++scheduleVersion
    scheduled = token
    // Batch events produced by one DOM turn (touchend + tap) without adding
    // a display refresh interval before the runtime can process the input.
    queueMicrotask(() => { if (scheduled === token) return flush() })
  }
  function enqueue(event, nativeEvent) {
    const current = ready()
    if (!current) return
    // Keep event order within one bridge batch: clamping, ancestor residuals
    // and hit targets can change after each wheel, even at the same point.
    let sampleId
    if (inputTiming && nativeEvent && typeof nativeEvent === 'object') {
      sampleId = observedInputs.get(nativeEvent)
      if (sampleId === undefined) {
        sampleId = trace('capture', { type: nativeEvent.type ?? event.type, nativeTimeStamp: nativeEvent.timeStamp, isTrusted: nativeEvent.isTrusted })
        observedInputs.set(nativeEvent, sampleId ?? null)
      }
    }
    pending.push({ session: current, epoch: epoch(), event, sampleId })
    schedule()
  }
  const touch = (type, event, p) => {
    const value = { identifier: event.pointerId, x: p.x, y: p.y,
      clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y, force: event.pressure || 0 }
    enqueue({ type, x: p.x, y: p.y, detail: { x: p.x, y: p.y }, bubbles: true, changedTouches: [value],
      touches: ['touchend', 'touchcancel', 'tap'].includes(type) ? [] : [value] }, event)
  }
  const release = id => {
    if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id)
  }
  const listen = (name, handler, options) => {
    canvas.addEventListener(name, handler, options)
    listeners.push([name, handler, options])
  }
  listen('wheel', event => {
    if (!ready() || event.ctrlKey) return // Preserve browser zoom gestures.
    const p = point(event)
    if (!p || ![0, 1, 2].includes(event.deltaMode)) return
    const dx = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? p.rect.width : 1) * p.size.width / p.rect.width
    const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? p.rect.height : 1) * p.size.height / p.rect.height
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
    event.preventDefault()
    enqueue({ type: 'wheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy, deltaMode: 0, bubbles: true }, event)
  }, { passive: false })
  listen('pointerdown', event => {
    if (!ready() || event.isPrimary === false || event.button !== 0) return
    if (pointer && (pointer.session !== session() || pointer.epoch !== epoch())) { const id = pointer.id; pointer = null; release(id) }
    if (pointer) return
    const p = point(event)
    if (!p) return
    pointer = { id: event.pointerId, session: session(), epoch: epoch(), start: p, last: p, moved: false,
      touch: event.pointerType === 'touch' || event.pointerType === 'pen' }
    canvas.setPointerCapture?.(event.pointerId)
    if (pointer.touch) { event.preventDefault(); touch('touchstart', event, p) }
  })
  listen('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return
    if (!ready() || (pointer.session !== session() || pointer.epoch !== epoch())) { const id = pointer.id; pointer = null; release(id); return }
    const p = point(event)
    if (!p) return
    pointer.last = p
    pointer.moved ||= Math.hypot(p.x - pointer.start.x, p.y - pointer.start.y) > 6
    if (pointer.touch) { event.preventDefault(); touch('touchmove', event, p) }
  })
  const finish = (event, cancelled) => {
    if (!pointer || pointer.id !== event.pointerId) return
    const previous = pointer
    pointer = null
    const p = point(event) || previous.last
    if (ready() && previous.session === session() && previous.epoch === epoch()) {
      const moved = previous.moved || Math.hypot(p.x - previous.start.x, p.y - previous.start.y) > 6
      if (previous.touch) { event.preventDefault(); touch(cancelled ? 'touchcancel' : 'touchend', event, p) }
      if (!cancelled && !moved) {
        if (previous.touch) touch('tap', event, p)
        else enqueue({ type: 'tap', x: p.x, y: p.y, detail: { x: p.x, y: p.y }, bubbles: true }, event)
      }
    }
    release(previous.id)
  }
  listen('pointerup', event => finish(event, false))
  listen('pointercancel', event => finish(event, true))
  listen('lostpointercapture', event => finish(event, true))
  const reset = () => {
    scheduled = null
    trace('drop', tokens(pending), 'input-reset')
    pending = []
    const id = pointer?.id
    pointer = null
    if (id !== undefined) release(id)
  }
  return {
    get inputTimingFailures() { return inputTimingFailures },
    // A logical resize invalidates queued coordinates and local capture. The
    // runtime owns cancellation of contacts already dispatched to its tree.
    reset,
    dispose() {
      if (disposed) return
      disposed = true
      reset()
      for (const [name, handler, options] of listeners) canvas.removeEventListener(name, handler, options)
      canvas.style.touchAction = previousTouchAction
    },
  }
}
