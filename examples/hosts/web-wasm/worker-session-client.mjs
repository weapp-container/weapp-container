import { unpackHostApiWire } from './host-api-binary-wire.mjs'
import { unpackWorkerFrameWire, workerFrameResponseLimits, WORKER_FRAME_WIRE_LIMITS } from './worker-frame-wire.mjs'

/** Browser-only transport for one exclusively owned module Worker.
 *
 * Responses use payload {status:'queued'}, {status:'ok',result}, or
 * {status:'error',error:{code,message,...}}. A queued receipt never settles a
 * request. Cancellation is admission-only: it cannot preempt executing WASM.
 * The factory must create a fresh Worker; this client terminates that exact
 * instance. Transfer only caller-owned ArrayBuffers, never mutable WASM views.
 * Payloads contain finite JSON scalars/undefined, ordinary objects/arrays and
 * attached ArrayBuffers or typed views. Enumerable accessors, functions,
 * symbols, class instances, Date/Map/Set and cycles are rejected. Proxies are
 * outside this plain-data contract. Native structured clone runs only after
 * a bounded descriptor walk; validation never calls toJSON or value getters.
 * Byte accounting conservatively includes UTF-16 strings, object metadata and
 * entire backing buffers (deduplicated), including transfer-only buffers.
 * Native frame response metadata defaults to a separate 131072-node ceiling.
 * Explicit maxPayloadNodes also narrows frames unless maxFramePayloadNodes is
 * supplied. Requests, events and ordinary host API responses keep their budget.
 * Count and byte reservations last until a final reply, abort, timeout or close;
 * queued receipts retain both. Incoming bytes are checked separately after
 * delivery, when the browser has already allocated them; this cannot replace
 * the Worker's response budget and never consumes outgoing reservations.
 * Events have a separate bounded receipt ledger. Only successful completion of
 * onEvent (including its Promise) queues events.ack; reservations release on
 * that ACK's final result. Receipt ACKs never authorize presentation or input.
 * Event IDs are worker-event-N, with positive safe-integer N increasing across
 * the entire Worker lifetime. Gaps are allowed; acknowledged IDs never replay.
 */
// Responses already crossed structured clone and the bounded incoming walk.
// One consumer may take that owned result without a second whole-frame clone.
// Module-private provenance keeps injected RPC implementations on the copy path.
const ownedFrameResponses = new WeakMap()
export function takeWorkerFrameResponse(client, result) {
  if (result === null || typeof result !== 'object' || ownedFrameResponses.get(result) !== client) return false
  ownedFrameResponses.delete(result)
  return true
}

export const WORKER_RPC_VERSION = '1.0'
// packagedApiResources 1.0 reserves 64 KiB of the 16 MiB wire budget for
// metadata. This does not redefine existing component/media resource limits.
export const HOST_API_RESOURCE_MAX_BYTES = 16 * 1024 * 1024 - 64 * 1024
export const WORKER_EVENT_LIMITS = Object.freeze({ count: 64, bytes: 16 * 1024 * 1024, criticalBytes: 64 * 1024 })

const ENVELOPE_KEYS = ['version', 'workerEpoch', 'sessionId', 'requestId', 'kind', 'op', 'payload']
const CONTROL_OPS = new Set(['close', 'retire', 'abort', 'view.retire', 'view.abort', 'view.sample.abort', 'events.ack'])
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const canonical = (value, max = 128) => typeof value === 'string'
  && value.length > 0 && value.length <= max && IDENTIFIER.test(value)
const positive = value => Number.isFinite(value) && value > 0 && value <= 86_400_000
const KiB = 1024
const MiB = KiB * KiB
const boundedInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const typedBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get

export class WorkerRpcError extends Error {
  constructor(code, message, { cause, details, cleanupErrors } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WorkerRpcError'
    this.code = code
    if (details !== undefined) this.details = details
    if (cleanupErrors?.length) this.cleanupErrors = cleanupErrors
  }
}

const fault = (code, message, cause) => new WorkerRpcError(code, message, { cause })
const combine = (primary, errors) => errors.length
  ? new WorkerRpcError(primary?.code || 'ERR_RPC_CLEANUP', primary?.message || 'Worker cleanup failed', {
    cause: primary, cleanupErrors: errors,
  }) : primary

function newIdentifier(label) {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw fault('ERR_RPC_ARGUMENT', 'crypto.randomUUID or an explicit idFactory is required')
  }
  return `${label}-${globalThis.crypto.randomUUID()}`
}

function attachedBufferLength(buffer) {
  try {
    const length = bufferLength.call(buffer)
    // Construct a zero-copy view solely to distinguish detached from empty.
    new Uint8Array(buffer, 0, 0)
    return length
  } catch (cause) {
    throw fault('ERR_RPC_ARGUMENT', 'only attached, non-shared ArrayBuffers may cross the Worker boundary', cause)
  }
}

function transferList(value, maxNodes) {
  if (!Array.isArray(value) || value.length > maxNodes) {
    throw fault('ERR_RPC_ARGUMENT', 'transfer must contain unique caller-owned ArrayBuffers')
  }
  const transfers = []
  const seen = new Set()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !own(descriptor, 'value') || seen.has(descriptor.value)) {
      throw fault('ERR_RPC_ARGUMENT', 'transfer must contain unique ArrayBuffers without getters or holes')
    }
    const buffer = descriptor.value
    attachedBufferLength(buffer)
    seen.add(buffer)
    transfers.push(buffer)
  }
  return transfers
}

function payloadBytes(payload, transfers, { maxBytes, maxNodes, maxDepth }) {
  let bytes = 0
  let nodes = 0
  const seen = new Set()
  const active = new Set()
  const buffers = new Set()
  const stack = []
  const add = amount => {
    if (amount > maxBytes - bytes) throw fault('ERR_RPC_PAYLOAD_TOO_LARGE', 'Worker payload exceeds its byte budget')
    bytes += amount
  }
  const enqueue = (value, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) {
      throw fault('ERR_RPC_PAYLOAD_TOO_LARGE', 'Worker payload exceeds its node or depth budget')
    }
    stack.push({ value, depth })
  }
  const addBuffer = buffer => {
    const size = attachedBufferLength(buffer)
    if (!buffers.has(buffer)) {
      add(32 + size)
      buffers.add(buffer)
    }
  }
  for (const buffer of transfers) addBuffer(buffer)
  enqueue(payload, 0)
  while (stack.length) {
    const entry = stack.pop()
    const { value, depth } = entry
    if (entry.exit) { active.delete(value); continue }
    if (value === null || value === undefined || typeof value === 'boolean') { add(8); continue }
    if (typeof value === 'string') { add(16 + value.length * 2); continue }
    if (typeof value === 'number' && Number.isFinite(value)) { add(8); continue }
    if (typeof value !== 'object') throw fault('ERR_RPC_ARGUMENT', 'Worker payload contains a non-data value')
    if (active.has(value)) throw fault('ERR_RPC_ARGUMENT', 'Worker payload contains a cycle')
    if (seen.has(value)) continue
    seen.add(value)
    if (value instanceof ArrayBuffer) { addBuffer(value); continue }
    if (ArrayBuffer.isView(value)) {
      let buffer
      try { buffer = typedBuffer.call(value) } catch { buffer = dataViewBuffer.call(value) }
      add(32)
      addBuffer(buffer)
      continue
    }
    const isArray = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw fault('ERR_RPC_ARGUMENT', 'Worker payload accepts plain data, not class or built-in object instances')
    }
    if (isArray) {
      const length = Object.getOwnPropertyDescriptor(value, 'length').value
      if (length > maxNodes) throw fault('ERR_RPC_PAYLOAD_TOO_LARGE', 'Worker array length exceeds its node budget')
      add(32 + length * 8)
    } else add(32)
    active.add(value)
    stack.push({ value, exit: true })
    // Enumerating keys does not read property values. Fetch one descriptor at a
    // time so an oversized object cannot create an unbounded descriptor array.
    let inspected = 0
    for (const key in value) {
      if (++inspected > maxNodes) throw fault('ERR_RPC_PAYLOAD_TOO_LARGE', 'Worker object exceeds its field budget')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      if (!own(descriptor, 'value')) throw fault('ERR_RPC_ARGUMENT', 'Worker payload may not contain enumerable getters or setters')
      add(16 + key.length * 2)
      enqueue(descriptor.value, depth + 1)
    }
  }
  return bytes
}

/** Pure, synchronous admission measurement shared with the Worker owner.
 * Returns conservative bytes without cloning or retaining the input. Throws a
 * WorkerRpcError (ARGUMENT or PAYLOAD_TOO_LARGE). Optional transfers are counted
 * even when absent from value, with each backing buffer charged only once.
 */
export function measureWorkerPayload(value, options = {}) {
  if (!record(options)) throw fault('ERR_RPC_ARGUMENT', 'payload measurement options must be an object')
  const { maxBytes = 16 * MiB, maxNodes = 16_384, maxDepth = 64, transfers = [] } = options
  if (!boundedInteger(maxBytes, 1, 256 * MiB) || !boundedInteger(maxNodes, 1, 131_072)
    || !boundedInteger(maxDepth, 1, 256)) {
    throw fault('ERR_RPC_ARGUMENT', 'invalid finite Worker payload measurement limits')
  }
  return payloadBytes(value, transferList(transfers, maxNodes), { maxBytes, maxNodes, maxDepth })
}

// Optional diagnostics share the original wire limits, but never the business
// admission/reservation. Per-message diagnostic storage is independently
// bounded; the existing finite request count bounds queued sideband storage.
export const WORKER_INPUT_TIMING_LIMITS = Object.freeze({ maxBytes: 256 * KiB, maxNodes: 8192, maxDepth: 16 })
const INPUT_TIMING_OPS = new Set(['bridge', 'frame', 'frame.current', 'surface.recover'])
export const isWorkerInputTimingRequest = (op, payload) => op === 'bridge'
  && Object.getOwnPropertyDescriptor(Object.getOwnPropertyDescriptor(payload, 'envelope')?.value ?? {}, 'op')?.value === 'event.batch'

function copyTimingContainer(target, maxNodes, { omit, result } = {}) {
  const base = Object.create(Object.getPrototypeOf(target))
  let fields = 0
  for (const key in target) {
    if (++fields > maxNodes) throw fault('ERR_RPC_PAYLOAD_TOO_LARGE', 'Worker object exceeds its field budget')
    if (key === omit) continue
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (descriptor) Object.defineProperty(base, key, key === 'result' && result !== undefined
      ? { ...descriptor, value: result } : descriptor)
  }
  return base
}

/** Remove only the reserved, own data field. Do not invoke optional getters or
 * copy an unbounded object before the ordinary payload validator can reject it.
 * The caller must restrict this helper to an explicitly negotiated operation.
 */
export function splitWorkerInputTiming(payload, { response = false, maxNodes = 16_384 } = {}) {
  if (!record(payload) || ![Object.prototype, null].includes(Object.getPrototypeOf(payload))) return { base: payload, present: false }
  const target = response ? Object.getOwnPropertyDescriptor(payload, 'result')?.value : payload
  if (!record(target) || ![Object.prototype, null].includes(Object.getPrototypeOf(target))) return { base: payload, present: false }
  const field = Object.getOwnPropertyDescriptor(target, 'inputTiming')
  if (!field?.enumerable) return { base: payload, present: false }
  const base = copyTimingContainer(target, maxNodes, { omit: 'inputTiming' })
  return { base: response ? copyTimingContainer(payload, maxNodes, { result: base }) : base, present: true,
    diagnostic: own(field, 'value') ? field.value : { version: '1.0', omitted: 'invalid-diagnostic' } }
}

/** A legal business payload always wins. Even the omission marker is optional
 * when no byte/node/depth headroom remains. Absence is recorded by the consumer
 * as not-delivered, without inventing an exact remote omission reason.
 */
export function fitWorkerInputTiming(base, diagnostic, { response = false, ...limits } = {}) {
  const baseBytes = measureWorkerPayload(base, limits)
  const attach = value => response ? { ...base, result: { ...base.result, inputTiming: value } } : { ...base, inputTiming: value }
  let reason = 'payload-budget', valid = true
  try {
    measureWorkerPayload(diagnostic, WORKER_INPUT_TIMING_LIMITS)
  } catch (failure) {
    valid = false
    reason = failure.code === 'ERR_RPC_PAYLOAD_TOO_LARGE' ? 'diagnostic-budget' : 'invalid-diagnostic'
  }
  if (valid) try {
    const payload = attach(diagnostic)
    measureWorkerPayload(payload, limits)
    return { payload, baseBytes }
  } catch { /* The marker below is optional too. Never retry business work. */ }
  const payload = attach({ version: '1.0', omitted: reason })
  try { measureWorkerPayload(payload, limits); return { payload, baseBytes } }
  catch { return { payload: base, baseBytes } }
}

export class WorkerRpcClient {
  constructor({ workerUrl, workerFactory, workerEpoch, sessionId, requestPrefix,
    idFactory = newIdentifier, maxPending = 72, reservedControlSlots = 8,
    maxRequestBytes = 16 * MiB, maxInFlightBytes = 64 * MiB, maxResponseBytes = 16 * MiB,
    maxControlRequestBytes = 64 * KiB, reservedControlBytes = 256 * KiB,
    maxPayloadNodes, maxFramePayloadNodes = maxPayloadNodes === undefined ? WORKER_FRAME_WIRE_LIMITS.maxMetadataNodes : maxPayloadNodes,
    maxPayloadDepth = 64,
    timeoutMs = 5_000, closeTimeoutMs = 1_000, retiredLimit = 256, retiredTtlMs = 30_000,
    clock = () => globalThis.performance.now(),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = timer => globalThis.clearTimeout(timer), onEvent, onFailure } = {}) {
    if (maxPayloadNodes === undefined) maxPayloadNodes = 16_384
    if (!Number.isSafeInteger(maxPending) || maxPending < 2
      || !Number.isSafeInteger(reservedControlSlots) || reservedControlSlots < 1
      || reservedControlSlots >= maxPending || !positive(timeoutMs) || !positive(closeTimeoutMs)
      || !boundedInteger(maxRequestBytes, 64, 64 * MiB)
      || !boundedInteger(maxResponseBytes, 64, 64 * MiB)
      || !boundedInteger(maxInFlightBytes, 256, 256 * MiB)
      || !boundedInteger(maxControlRequestBytes, 64, MiB)
      || !boundedInteger(reservedControlBytes, 128, 4 * MiB)
      || maxRequestBytes > maxInFlightBytes || reservedControlBytes >= maxInFlightBytes
      || reservedControlBytes < maxControlRequestBytes * 2
      || !boundedInteger(maxPayloadNodes, 1, 131_072) || !boundedInteger(maxPayloadDepth, 1, 256)
      || !boundedInteger(maxFramePayloadNodes, 1, WORKER_FRAME_WIRE_LIMITS.maxMetadataNodes)
      || !Number.isSafeInteger(retiredLimit) || retiredLimit < 1 || !positive(retiredTtlMs)
      || typeof clock !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
      || typeof idFactory !== 'function' || (onEvent !== undefined && typeof onEvent !== 'function')
      || (onFailure !== undefined && typeof onFailure !== 'function')) {
      throw fault('ERR_RPC_ARGUMENT', 'invalid Worker transport limits or callbacks')
    }
    const epoch = workerEpoch ?? idFactory('epoch')
    const session = sessionId ?? idFactory('session')
    this._prefix = requestPrefix ?? idFactory('request')
    if (![epoch, session, this._prefix].every(value => canonical(value))
      || new Set([epoch, session, this._prefix]).size !== 3) {
      throw fault('ERR_RPC_ARGUMENT', 'epoch, session and request namespaces must be distinct canonical identifiers')
    }
    Object.defineProperties(this, {
      workerEpoch: { value: epoch, enumerable: true },
      sessionId: { value: session, enumerable: true },
      actualFinalContract: { value: '1.0', enumerable: true },
    })
    this._clock = clock
    if (!Number.isFinite(this._clock())) throw fault('ERR_RPC_ARGUMENT', 'clock must return finite milliseconds')
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._maxPending = maxPending
    this._ordinaryLimit = maxPending - reservedControlSlots
    this._maxRequestBytes = maxRequestBytes
    this._maxResponseBytes = maxResponseBytes
    this._maxInFlightBytes = maxInFlightBytes
    this._maxControlRequestBytes = maxControlRequestBytes
    this._ordinaryByteLimit = maxInFlightBytes - reservedControlBytes
    this._maxPayloadNodes = maxPayloadNodes
    this._maxFramePayloadNodes = maxFramePayloadNodes
    this._maxPayloadDepth = maxPayloadDepth
    this._inFlightBytes = 0
    this._inputTimingEnabled = false
    this._timeoutMs = timeoutMs
    this._closeTimeoutMs = closeTimeoutMs
    this._retiredLimit = retiredLimit
    this._retiredTtlMs = retiredTtlMs
    this._onEvent = onEvent
    this._onFailure = onFailure
    this._pending = new Map()
    this._retired = new Map()
    // Opt-in last-use ownership is separate from the expiring diagnostic
    // ledger. Aborted posted requests retain their callback and count/bytes
    // until a genuine final or this exact Worker's termination barrier.
    this._actualFinals = new Map()
    this._pinnedRetiredBytes = 0
    // Receipt reservations survive callback completion until the owner's final
    // ACK. Entries retain metadata only; callback consumers own event payloads.
    this._events = new Map()
    this._highestEventSequence = 0
    this._eventBytes = 0
    this._normalEventCount = 0
    this._normalEventBytes = 0
    this._faultEventSeen = false
    this._eventAckIds = []
    this._eventAck = null
    this._eventAckScheduled = false
    this._eventGeneration = 0
    this._sequence = 0
    this._state = 'open'
    this._failure = null
    this._closePromise = null
    this._listeners = []
    this._worker = null
    this.closed = new Promise((resolve, reject) => {
      this._resolveClosed = resolve
      this._rejectClosed = reject
    })
    // Keep event-originated failures observable through closed/failure without
    // creating an unhandled rejection before the caller can attach a handler.
    this.closed.catch(() => {})
    try {
      const create = workerFactory ?? ((url, options) => new globalThis.Worker(url, options))
      if (typeof create !== 'function' || (!workerFactory && workerUrl === undefined)) {
        throw fault('ERR_RPC_ARGUMENT', 'a module Worker URL or fresh-worker factory is required')
      }
      this._worker = create(workerUrl, { type: 'module', name: `container-${this.workerEpoch}` })
      if (!this._worker || !['postMessage', 'addEventListener', 'removeEventListener', 'terminate']
        .every(name => typeof this._worker[name] === 'function')) {
        throw fault('ERR_RPC_ARGUMENT', 'workerFactory must return a fresh Worker-compatible instance')
      }
      for (const [type, listener] of [
        ['message', event => this._receive(event.data)],
        ['error', event => this._shutdown(fault('ERR_RPC_WORKER', event.message || 'Worker failed'))],
        ['messageerror', () => this._shutdown(fault('ERR_RPC_WORKER', 'Worker message could not be deserialized'))],
      ]) {
        this._listeners.push([type, listener])
        this._worker.addEventListener(type, listener)
      }
    } catch (cause) {
      throw this._shutdown(cause instanceof WorkerRpcError ? cause
        : fault('ERR_RPC_WORKER', 'Could not create or attach the module Worker', cause))
    }
  }

  get state() { return this._state }
  get pendingCount() { return this._pending.size }
  get inFlightBytes() { return this._inFlightBytes }
  get retiredCount() { this._pruneRetired(); return this._retired.size }
  get failure() { return this._failure }
  get pendingEventCount() { return this._events.size }
  get pendingEventBytes() { return this._eventBytes }
  get actualFinalCount() { return this._actualFinals.size }

  requestHost(op, payload, options = {}) {
    if (op === 'close') return this.close({ ...options, payload })
    return this._request(op, payload, options)
  }

  _request(op, payload, options = {}) {
    try {
      if (!record(options)) throw fault('ERR_RPC_ARGUMENT', 'request options must be an object')
      const { signal, timeoutMs = this._timeoutMs, onLateResponse, onActualFinal, transfer = [] } = options
      if (!canonical(op) || !positive(timeoutMs)
        || (onLateResponse !== undefined && typeof onLateResponse !== 'function')
        || (onActualFinal !== undefined && typeof onActualFinal !== 'function')
        || (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function'
          || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean'))) {
        throw fault('ERR_RPC_ARGUMENT', 'invalid operation, timeout, signal or late-response callback')
      }
      const control = CONTROL_OPS.has(op)
      if (this._state !== 'open' && !(this._state === 'closing' && control)) {
        throw this._failure || fault('ERR_RPC_CLOSED', 'Worker session is closed')
      }
      // The last slot belongs exclusively to close. Retire/abort cannot fill it.
      const limit = op === 'close' ? this._maxPending
        : control ? this._maxPending - 1 : this._ordinaryLimit
      if (this._pending.size >= limit) throw fault('ERR_RPC_QUEUE_FULL', 'Worker request budget is full')
      if (onActualFinal && this._actualFinals.size >= this._ordinaryLimit) throw fault('ERR_RPC_QUEUE_FULL', 'Worker actual-final ownership budget is full')
      if (signal?.aborted) throw fault('ERR_RPC_CANCELLED', 'Worker request was aborted before admission')
      const transfers = transferList(transfer, this._maxPayloadNodes)
      const limits = {
        maxBytes: control ? this._maxControlRequestBytes : this._maxRequestBytes,
        maxNodes: this._maxPayloadNodes, maxDepth: this._maxPayloadDepth, transfers,
      }
      let reservedBytes
      if (this._inputTimingEnabled && record(payload) && isWorkerInputTimingRequest(op, payload)) {
        const sideband = splitWorkerInputTiming(payload, limits)
        if (sideband.present) {
          const fitted = fitWorkerInputTiming(sideband.base, sideband.diagnostic, limits)
          payload = fitted.payload; reservedBytes = fitted.baseBytes
        }
      }
      reservedBytes ??= measureWorkerPayload(payload, limits)
      const byteLimit = op === 'close' ? this._maxInFlightBytes
        : control ? this._maxInFlightBytes - this._maxControlRequestBytes : this._ordinaryByteLimit
      if (reservedBytes > byteLimit - this._inFlightBytes - this._pinnedRetiredBytes) {
        throw fault('ERR_RPC_QUEUE_FULL', 'Worker in-flight byte budget is full')
      }
      if (this._sequence >= Number.MAX_SAFE_INTEGER) throw fault('ERR_RPC_PROTOCOL', 'request ID space exhausted')
      this._pruneRetired()
      const requestId = `${this._prefix}.${++this._sequence}`
      return new Promise((resolve, reject) => {
        const entry = { requestId, op, resolve, reject, signal, onLateResponse,
          reservedBytes, timer: null, abort: null, posted: false,
          inputTimingLoad: op === 'load' && payload?.inputTiming?.version === '1.0' }
        if (onActualFinal) {
          entry.actual = { requestId, op, onLateResponse, onActualFinal, reservedBytes, retiredBytes: false }
          this._actualFinals.set(requestId, entry.actual)
        }
        this._pending.set(requestId, entry)
        this._inFlightBytes += reservedBytes
        try {
          const timer = this._setTimer(() => this._cancel(entry, 'timeout'), timeoutMs)
          if (this._pending.get(requestId) !== entry) {
            // Injected timer setup may synchronously cancel/close. Its actual
            // returned handle still belongs to this request and must release.
            this._clearTimer(timer)
            return
          }
          entry.timer = timer
          if (signal) {
            entry.abort = () => this._cancel(entry, 'aborted')
            signal.addEventListener('abort', entry.abort, { once: true })
            if (signal.aborted) entry.abort?.()
          }
          if (!this._pending.has(requestId)) return
          entry.posted = true
          if (entry.actual) entry.actual.posted = true
          this._worker.postMessage(this._envelope('request', requestId, op, payload), transfers)
        } catch (cause) {
          this._shutdown(fault('ERR_RPC_WORKER', 'Worker request could not be posted', cause))
        }
      })
    } catch (error) {
      if (typeof options?.onActualFinal === 'function') {
        const callbackFailure = this._notifyActual(options.onActualFinal,
          Object.freeze({ version: '1.0', status: 'not-posted', requestId: null }))
        if (callbackFailure) return Promise.reject(this._shutdown(combine(error, [callbackFailure])))
      }
      return Promise.reject(error)
    }
  }

  _envelope(kind, requestId, op, payload) {
    return { version: WORKER_RPC_VERSION, workerEpoch: this.workerEpoch,
      sessionId: this.sessionId, requestId, kind, op, payload }
  }

  _cleanEntry(entry) {
    const errors = []
    this._inFlightBytes -= entry.reservedBytes
    entry.reservedBytes = 0
    if (entry.timer !== null) {
      const timer = entry.timer
      entry.timer = null
      try { this._clearTimer(timer) } catch (error) { errors.push(error) }
    }
    if (entry.abort) {
      const abort = entry.abort
      entry.abort = null
      try { entry.signal.removeEventListener('abort', abort) } catch (error) { errors.push(error) }
    }
    return errors
  }

  _cancel(entry, reason) {
    if (this._pending.get(entry.requestId) !== entry) return
    const errors = []
    let now = 0
    try { now = this._pruneRetired() } catch (error) { errors.push(error) }
    if (this._pending.get(entry.requestId) !== entry) return
    this._pending.delete(entry.requestId)
    // Publish cancellation's late-final ownership BEFORE timer/signal cleanup
    // can synchronously reenter with the genuine final or a shutdown.
    let retired
    if (entry.posted) {
      retired = { op: entry.op, onLateResponse: entry.onLateResponse, expiresAt: now + this._retiredTtlMs, completed: false }
      this._retired.set(entry.requestId, retired)
      while (this._retired.size > this._retiredLimit) this._retired.delete(this._retired.keys().next().value)
      if (entry.actual && this._actualFinals.get(entry.requestId) === entry.actual) {
        entry.actual.retiredBytes = true
        this._pinnedRetiredBytes += entry.actual.reservedBytes
      }
    }
    errors.push(...this._cleanEntry(entry))
    if (!entry.posted) { const failure = this._completeActual(entry.actual, 'not-posted'); if (failure) errors.push(failure) }
    const error = fault(reason === 'timeout' ? 'ERR_RPC_TIMEOUT' : 'ERR_RPC_CANCELLED',
      reason === 'timeout' ? 'Worker request exceeded its finite timeout' : 'Worker request was aborted')
    if (entry.posted && !retired?.completed && this._worker) {
      try { this._worker.postMessage(this._envelope('cancel', entry.requestId, entry.op, { reason })) }
      catch (cause) { errors.push(cause) }
    }
    const failure = combine(error, errors)
    entry.reject(failure)
    if (errors.length) this._shutdown(failure)
  }

  _pruneRetired() {
    const now = this._clock()
    if (!Number.isFinite(now)) throw fault('ERR_RPC_WORKER', 'clock must return finite milliseconds')
    for (const [id, entry] of this._retired) if (entry.expiresAt <= now) this._retired.delete(id)
    return now
  }

  _completeActual(actual, status) {
    if (!actual || this._actualFinals.get(actual.requestId) !== actual) return
    this._actualFinals.delete(actual.requestId)
    if (actual.retiredBytes) this._pinnedRetiredBytes -= actual.reservedBytes
    return this._notifyActual(actual.onActualFinal, Object.freeze({ version: '1.0', status, requestId: actual.requestId }))
  }

  _notifyActual(callback, receipt) {
    try {
      const result = callback(receipt)
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(error => this._shutdown(fault('ERR_RPC_CALLBACK', 'Actual-final callback rejected', error)))
        return fault('ERR_RPC_CALLBACK', 'Actual-final lifetime callback must be synchronous')
      }
    } catch (cause) { return fault('ERR_RPC_CALLBACK', 'Actual-final lifetime callback failed', cause) }
  }

  _issued(id) {
    if (!id.startsWith(`${this._prefix}.`)) return false
    const suffix = id.slice(this._prefix.length + 1)
    return /^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(Number(suffix)) && Number(suffix) <= this._sequence
  }

  _receive(message) {
    if (this._state === 'closed' || this._state === 'failed') return
    try {
      if (!record(message) || Object.keys(message).length !== ENVELOPE_KEYS.length
        || !ENVELOPE_KEYS.every(key => own(message, key)) || message.version !== WORKER_RPC_VERSION
        || message.workerEpoch !== this.workerEpoch || message.sessionId !== this.sessionId
        || !canonical(message.requestId, 192) || !canonical(message.op)
        || !['response', 'event'].includes(message.kind)) {
        throw fault('ERR_RPC_PROTOCOL', 'Worker envelope identity, version or shape does not match this session')
      }
      if (message.kind === 'event') {
        this._receiveEvent(message)
        return
      }
      let payload = message.payload
      if (!record(payload) || !['queued', 'ok', 'error'].includes(payload.status)
        || (payload.status === 'ok' && !own(payload, 'result'))
        || (payload.status === 'error' && (!record(payload.error)
          || !canonical(payload.error.code) || typeof payload.error.message !== 'string'))) {
        throw fault('ERR_RPC_PROTOCOL', 'Worker response has no valid queued or final status')
      }
      const limits = workerFrameResponseLimits(message.op, payload, { maxBytes: this._maxResponseBytes,
        maxNodes: this._maxPayloadNodes, maxFrameNodes: this._maxFramePayloadNodes, maxDepth: this._maxPayloadDepth })
      if (this._inputTimingEnabled && INPUT_TIMING_OPS.has(message.op) && payload.status === 'ok') {
        const sideband = splitWorkerInputTiming(payload, { response: true, ...limits })
        if (sideband.present) {
          payload = fitWorkerInputTiming(sideband.base, sideband.diagnostic, { response: true, ...limits }).payload
          message = { ...message, payload }
        }
      }
      this._checkIncoming(payload, limits)
      payload = unpackHostApiWire(payload, limits)
      payload = unpackWorkerFrameWire(message.op, payload)
      message = { ...message, payload }
      this._pruneRetired()
      const entry = this._pending.get(message.requestId)
      const actual = this._actualFinals.get(message.requestId)
      const retired = this._retired.get(message.requestId) ?? actual
      if (entry && !entry.posted || actual && !actual.posted) throw fault('ERR_RPC_PROTOCOL', 'Worker replied before this request was posted')
      if ((entry || retired) && (entry || retired).op !== message.op) {
        throw fault('ERR_RPC_PROTOCOL', 'Worker response operation does not match its request')
      }
      if (!entry) {
        if (!this._issued(message.requestId)) throw fault('ERR_RPC_PROTOCOL', 'Worker response uses an unissued request ID')
        if (actual?.completed) return
        if (retired && payload.status !== 'queued') {
          retired.completed = true
          if (actual) actual.completed = true
          this._retired.delete(message.requestId)
          this._callback(retired.onLateResponse, message)
          const failure = this._completeActual(actual, 'final')
          if (failure) this._shutdown(failure)
        }
        // Completed, evicted or expired requests can never become successful.
        return
      }
      if (payload.status === 'queued') return
      this._pending.delete(message.requestId)
      const ownershipFailure = this._completeActual(entry.actual, 'final')
      const cleanup = this._cleanEntry(entry)
      if (ownershipFailure) cleanup.push(ownershipFailure)
      if (cleanup.length) {
        const error = combine(fault('ERR_RPC_CLEANUP', 'Request listener/timer cleanup failed'), cleanup)
        entry.reject(error)
        this._shutdown(error)
      } else if (payload.status === 'ok') {
        if (entry.inputTimingLoad && payload.result?.inputTiming?.version === '1.0') this._inputTimingEnabled = true
        if (['frame', 'frame.current'].includes(message.op) && record(payload.result)) {
          ownedFrameResponses.set(payload.result, this)
        }
        entry.resolve(payload.result)
      }
      else entry.reject(new WorkerRpcError(payload.error.code, payload.error.message, { details: payload.error }))
    } catch (cause) {
      this._shutdown(cause instanceof WorkerRpcError ? cause
        : fault('ERR_RPC_PROTOCOL', 'Worker response processing failed', cause))
    }
  }

  _callback(callback, value) {
    if (!callback) return
    try {
      const result = callback(value)
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(cause => this._shutdown(fault('ERR_RPC_CALLBACK', 'Worker callback failed', cause)))
      }
    } catch (cause) { this._shutdown(fault('ERR_RPC_CALLBACK', 'Worker callback failed', cause)) }
  }

  _checkIncoming(payload, limits) {
    if (limits) return payloadBytes(payload, [], limits)
    return payloadBytes(payload, [], { maxBytes: this._maxResponseBytes,
      maxNodes: this._maxPayloadNodes, maxDepth: this._maxPayloadDepth })
  }

  _receiveEvent(message) {
    // Closing already revoked every receipt waiter. Events queued before the
    // close request must not restart callbacks or an acknowledgement loop.
    if (this._state !== 'open') return
    const sequence = /^worker-event-([1-9][0-9]*)$/.exec(message.requestId)?.[1]
    const eventSequence = sequence === undefined ? NaN : Number(sequence)
    if (!Number.isSafeInteger(eventSequence) || eventSequence <= this._highestEventSequence) {
      throw fault('ERR_RPC_PROTOCOL', 'Worker event ID must have a strictly increasing safe-integer sequence')
    }
    const bytes = this._checkIncoming(message.payload)
    message = { ...message, payload: unpackHostApiWire(message.payload, { maxBytes: this._maxResponseBytes,
      maxNodes: this._maxPayloadNodes, maxDepth: this._maxPayloadDepth }) }
    const critical = message.op === 'fault'
    if (critical) {
      if (this._faultEventSeen || bytes > WORKER_EVENT_LIMITS.criticalBytes) {
        throw fault('ERR_RPC_PAYLOAD_TOO_LARGE', 'Worker exceeded the one reserved fault event')
      }
      this._faultEventSeen = true
    } else if (this._normalEventCount >= WORKER_EVENT_LIMITS.count
      || bytes > WORKER_EVENT_LIMITS.bytes - this._normalEventBytes) {
      throw fault('ERR_RPC_PAYLOAD_TOO_LARGE', 'Worker unacknowledged event budget is full')
    }
    const entry = { id: message.requestId, bytes, critical, consumed: false }
    // Commit before invoking the handler: nested delivery cannot reuse this ID.
    // ACK and ledger cleanup deliberately never reset this lifetime watermark.
    this._highestEventSequence = eventSequence
    this._events.set(entry.id, entry)
    this._eventBytes += bytes
    if (!critical) { this._normalEventCount++; this._normalEventBytes += bytes }
    const generation = this._eventGeneration
    const consumed = () => {
      if (generation !== this._eventGeneration || this._state !== 'open'
        || this._events.get(entry.id) !== entry || entry.consumed) return
      entry.consumed = true
      this._eventAckIds.push(entry.id)
      this._scheduleEventAck()
    }
    try {
      const result = this._onEvent?.(message)
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).then(consumed, cause => this._shutdown(fault('ERR_RPC_CALLBACK', 'Worker event callback failed', cause)))
      } else consumed()
    } catch (cause) { this._shutdown(fault('ERR_RPC_CALLBACK', 'Worker event callback failed', cause)) }
  }

  _scheduleEventAck() {
    if (this._state !== 'open' || this._eventAck || this._eventAckScheduled || !this._eventAckIds.length) return
    const generation = this._eventGeneration
    this._eventAckScheduled = true
    queueMicrotask(() => {
      if (generation !== this._eventGeneration) return
      this._eventAckScheduled = false
      if (this._state !== 'open' || this._eventAck || !this._eventAckIds.length) return
      const ids = this._eventAckIds.splice(0, WORKER_EVENT_LIMITS.count)
      const ack = { ids, generation }
      this._eventAck = ack
      // This control request acknowledges receipt/handler consumption only.
      // It never confirms a View, geometry, render frame or input permission.
      this._request('events.ack', { eventIds: ids }).then(result => {
        if (generation !== this._eventGeneration || this._state !== 'open' || this._eventAck !== ack) return
        const accepted = result?.acknowledged
        const unique = Array.isArray(accepted) ? new Set(accepted) : null
        if (!record(result) || !unique || accepted.length !== ids.length || unique.size !== ids.length
          || ids.some(id => !unique.has(id))
          || !boundedInteger(result.pendingCount, 0, WORKER_EVENT_LIMITS.count + 1)
          || !boundedInteger(result.pendingBytes, 0, WORKER_EVENT_LIMITS.bytes + WORKER_EVENT_LIMITS.criticalBytes)) {
          throw fault('ERR_RPC_PROTOCOL', 'Worker event ACK does not identify its exact receipt batch')
        }
        // Validate the entire ACK before releasing any local reservation.
        if (ids.some(id => this._events.get(id)?.consumed !== true)) {
          throw fault('ERR_RPC_PROTOCOL', 'Worker event ACK refers to an unavailable receipt')
        }
        for (const id of ids) {
          const entry = this._events.get(id)
          this._events.delete(id)
          this._eventBytes -= entry.bytes
          if (!entry.critical) { this._normalEventCount--; this._normalEventBytes -= entry.bytes }
        }
        this._eventAck = null
        this._scheduleEventAck()
      }).catch(cause => {
        if (generation === this._eventGeneration && this._state === 'open') this._shutdown(cause)
      })
    })
  }

  _clearEvents() {
    this._eventGeneration++
    this._events.clear()
    this._eventBytes = 0
    this._normalEventCount = 0
    this._normalEventBytes = 0
    this._faultEventSeen = false
    this._eventAckIds.length = 0
    this._eventAck = null
    this._eventAckScheduled = false
  }

  close({ timeoutMs = this._closeTimeoutMs, signal, payload = {} } = {}) {
    if (this._closePromise) return this._closePromise
    if (this._state === 'closed' || this._state === 'failed') return this.closed
    this._state = 'closing'
    this._clearEvents()
    this._closePromise = this._request('close', payload, { timeoutMs, signal }).then(result => {
      const failure = this._shutdown()
      if (failure) throw failure
      return result
    }, error => { throw this._shutdown(error) })
    return this._closePromise
  }

  _shutdown(primary) {
    if (!this._worker && (this._state === 'closed' || this._state === 'failed')) {
      if (primary && primary !== this._failure) {
        this._failure = combine(primary, this._failure ? [this._failure] : [])
        this._state = 'failed'
        this._notifyFailure()
      }
      return this._failure
    }
    const errors = []
    const entries = [...this._pending.values()]
    this._pending.clear()
    this._clearEvents()
    for (const entry of entries) errors.push(...this._cleanEntry(entry))
    const worker = this._worker
    this._worker = null
    let terminated = !worker
    if (worker) {
      for (const [type, listener] of this._listeners) {
        try { worker.removeEventListener(type, listener) } catch (error) { errors.push(error) }
      }
      try { worker.terminate(); terminated = true } catch (error) { errors.push(error) }
    }
    this._listeners = []
    this._retired.clear()
    for (const actual of [...this._actualFinals.values()]) {
      const failure = this._completeActual(actual, terminated ? 'terminated' : 'uncertain')
      if (failure) errors.push(failure)
    }
    this._failure = combine(primary, errors)
    this._state = this._failure ? 'failed' : 'closed'
    if (this._failure) this._notifyFailure()
    for (const entry of entries) entry.reject(this._failure || fault('ERR_RPC_CLOSED', 'Worker session closed before this response'))
    if (this._failure) {
      this._rejectClosed(this._failure)
    } else this._resolveClosed({ closed: true })
    return this._failure
  }

  _notifyFailure() {
    if (!this._onFailure) return
    try {
      const result = this._onFailure(this._failure)
      if (result && typeof result.then === 'function') {
        // Already-settled promises cannot change. Late observer failures stay
        // observable on failure, without recursively calling a broken observer.
        Promise.resolve(result).catch(error => { this._failure = combine(this._failure, [error]) })
      }
    } catch (error) { this._failure = combine(this._failure, [error]) }
  }
}
