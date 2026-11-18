import { animationU64, copyConsumedSample, copySampleSubmission, copySamplePermit, sameConsumedSample } from './dom-animation-sample.mjs'
import { DomViewError, validateDomPresentationKey, validateDomViewDocument } from './dom-presenter.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n
const keyFields = ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']
const sameKey = (a, b) => a && b && keyFields.every(field => a[field] === b[field])
const sameConsumedInput = (a, b) => record(a) && record(b) && ['pageId', 'routePath', 'templateRevision'].every(field => a[field] === b[field])
  && record(a.viewport) && record(b.viewport) && ['x', 'y', 'width', 'height'].every(field => a.viewport[field] === b.viewport[field])
const copy = value => JSON.parse(JSON.stringify(value))
const error = (code, message) => new DomViewError(code, message)
const cancelled = message => Object.assign(error('ERR_CANCELLED', message ?? 'DOM session work is no longer current'), { localCancellation: true })
const requestKey = value => typeof value?.sessionId === 'string' && typeof value.requestId === 'string' && typeof value.op === 'string'
  ? JSON.stringify([value.sessionId, value.requestId, value.op]) : null
const diagnostics = result => Array.isArray(result?.diagnostics) ? result.diagnostics : []
const runtimeError = payload => {
  const value = payload?.error
  const failure = error(typeof value?.code === 'string' ? value.code : 'ERR_RENDER', typeof value?.message === 'string' ? value.message : String(value ?? 'runtime rejected DOM operation'))
  failure.diagnostics = diagnostics(payload)
  return failure
}
// Optional scheduling facts identify what this exact preparation consumed.
// They never grant presentation/input authority or substitute for the permit.
function scheduling(value, submission, routePath = submission.document?.routePath) {
  if (value === undefined) return undefined
  const exact = (object, fields) => record(object) && Object.keys(object).length === fields.length
    && Object.keys(object).every(field => fields.includes(field))
  const invalid = () => error('ERR_PROTOCOL_VERSION', 'invalid key-bound DOM scheduling metadata')
  if (!exact(value, ['version', 'key', 'consumedInput', ...(Object.hasOwn(value ?? {}, 'consumedSample') ? ['consumedSample'] : [])]) || value.version !== '1.0') throw invalid()
  try { validateDomPresentationKey(value.key) } catch { throw invalid() }
  if (!sameKey(value.key, submission.key)) throw invalid()
  let consumedInput = null
  if (value.consumedInput !== null) {
    const input = value.consumedInput, viewport = input?.viewport
    if (!exact(input, ['pageId', 'routePath', 'templateRevision', 'viewport'])
      || !decimal(input.pageId) || input.pageId !== submission.key.pageId
      || typeof input.routePath !== 'string' || !input.routePath || input.routePath !== routePath
      || !decimal(input.templateRevision) || !exact(viewport, ['x', 'y', 'width', 'height'])
      || !['x', 'y', 'width', 'height'].every(field => Number.isFinite(viewport[field]))
      || viewport.width !== submission.viewport.width || viewport.height !== submission.viewport.height) throw invalid()
    consumedInput = Object.freeze({ pageId: input.pageId, routePath: input.routePath,
      templateRevision: input.templateRevision, viewport: Object.freeze({ ...viewport }) })
  }
  return Object.freeze({ version: value.version, key: Object.freeze(copy(value.key)), consumedInput,
    ...(Object.hasOwn(value, 'consumedSample') ? { consumedSample: copyConsumedSample(value.consumedSample) } : {}) })
}

function deadline(value, name) {
  if (!Number.isFinite(value) || value <= 0 || value > 60000) throw error('ERR_PROTOCOL_VERSION', `invalid ${name}`)
  return value
}
function limited(promise, signal, timeoutMs) {
  let timer, listener
  const stopped = new Promise((_, reject) => {
    listener = () => reject(cancelled('DOM request cancelled'))
    if (signal?.aborted) listener()
    else signal?.addEventListener('abort', listener, { once: true })
    timer = setTimeout(() => reject(error('ERR_TIMEOUT', 'DOM runtime response timed out')), timeoutMs)
  })
  return Promise.race([promise, stopped]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', listener) })
}

/** Exact response correlation for the simulator's existing HTTP + SSE bridge.
 * `send` may return a Fetch Response, parsed HTTP receipt, or complete batch.
 * Queued receipts never finish a request. Call receive(batch) for SSE bridge
 * events; request() resolves only a matching runtime response payload.
 */
export class SseBridgeTransport {
  constructor({ sessionId, session, send, timeoutMs = 5000, maxPending = 64, onDiagnostic, onBatch } = {}) {
    this.sessionId = sessionId; this.session = session
    this.send = send ?? ((envelope, { signal }) => fetch('/api/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal }))
    this.timeoutMs = deadline(timeoutMs, 'bridge timeout')
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1024) throw error('ERR_PROTOCOL_VERSION', 'invalid pending request budget')
    this.maxPending = maxPending; this.onDiagnostic = onDiagnostic; this.onBatch = onBatch; this.pending = new Map(); this.retired = new Map(); this.connected = true; this.closed = false; this.sequence = 0n
    this.prefix = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
  currentSession() { return this.sessionId ?? this.session?.() }
  report(value) { try { this.onDiagnostic?.(value) } catch { /* Diagnostic consumers cannot grant request authority. */ } }
  pruneRetired() {
    for (const [key, entry] of this.retired) if (entry.expires <= Date.now() || entry.envelope.sessionId !== this.currentSession()) this.retired.delete(key)
    while (this.retired.size > this.maxPending) this.retired.delete(this.retired.keys().next().value)
  }
  finish(entry, failure, result) {
    if (this.pending.get(entry.key) !== entry) return
    this.pending.delete(entry.key); clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort)
    if (failure) {
      if (['view.prepare', 'view.sample.prepare'].includes(entry.envelope.op) && typeof entry.onLateResponse === 'function' && (failure.localCancellation || failure.code === 'ERR_TIMEOUT')) {
        this.retired.set(entry.key, { envelope: entry.envelope, onLateResponse: entry.onLateResponse, expires: Date.now() + Math.min(60000, Math.max(1000, entry.timeoutMs * 2)) }); this.pruneRetired()
      }
      entry.controller.abort(); entry.reject(failure)
    } else entry.resolve(result)
  }
  setSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw error('ERR_PROTOCOL_VERSION', 'missing authoritative session')
    this.sessionId = sessionId
    for (const entry of this.pending.values()) if (entry.envelope.sessionId !== sessionId) this.finish(entry, cancelled('bridge session replaced'))
    this.pruneRetired()
  }
  request(op, payload, { signal, sessionId = this.currentSession(), timeoutMs = this.timeoutMs, onLateResponse, hostContext } = {}) {
    if (this.closed || !this.connected) return Promise.reject(cancelled('bridge is disconnected'))
    if (signal?.aborted) return Promise.reject(cancelled())
    if (typeof sessionId !== 'string' || !sessionId || typeof op !== 'string' || !op) return Promise.reject(error('ERR_PROTOCOL_VERSION', 'bridge request needs session and operation'))
    if (sessionId !== this.currentSession()) return Promise.reject(cancelled('request belongs to another authoritative session'))
    if (this.pending.size >= this.maxPending) return Promise.reject(error('ERR_RENDER', 'bridge request queue full'))
    deadline(timeoutMs, 'request timeout')
    const envelope = { protocolVersion: '1.0', sessionId, requestId: `dom-${this.prefix}-${++this.sequence}`, kind: 'request', op, payload }
    this.pruneRetired()
    const controller = new AbortController(), entry = { envelope, controller, signal, key: requestKey(envelope), timeoutMs, onLateResponse }
    const result = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
    entry.abort = () => this.finish(entry, cancelled('bridge request cancelled'))
    entry.timer = setTimeout(() => this.finish(entry, error('ERR_TIMEOUT', 'bridge runtime response timed out')), timeoutMs)
    this.pending.set(entry.key, entry); signal?.addEventListener('abort', entry.abort, { once: true })
    const context = hostContext ? Object.freeze({ ...hostContext }) : undefined
    Promise.resolve().then(() => this.send(envelope, { signal: controller.signal, hostContext: context })).then(async response => {
      if (this.pending.get(entry.key) !== entry && !this.retired.has(entry.key)) return
      let body = response
      if (typeof response?.json === 'function') {
        body = await response.json()
        if (!response.ok) throw runtimeError(body)
      }
      this.receive(body)
    }).catch(failure => this.finish(entry, failure))
    return result
  }
  receive(batch) {
    if (this.closed || !this.connected) return 0
    try { this.onBatch?.(batch) } catch (failure) { this.report(failure) }
    this.pruneRetired()
    const messages = Array.isArray(batch?.messages) ? batch.messages : [batch]
    const observed = messages.filter(message => record(message) && ['diagnostic', 'error'].includes(message.op))
    for (const message of observed) this.report(message)
    let consumed = 0
    for (const message of messages) {
      if (message?.protocolVersion !== '1.0' || message.kind !== 'response' || !record(message.payload)) continue
      const entry = this.pending.get(requestKey(message))
      if (message.sessionId !== this.currentSession()) continue
      if (!entry) {
        const retired = this.retired.get(requestKey(message))
        if (!retired || message.payload.queued === true) continue
        this.retired.delete(requestKey(message))
        // This callback can only clean an exact retired request. It never
        // resolves a promise, publishes a surface or grants input authority.
        if (message.payload.ok === true) Promise.resolve().then(() => retired.onLateResponse(message.payload)).catch(failure => this.report(failure))
        continue
      }
      if (message.payload.queued === true) continue
      const payload = observed.length ? { ...message.payload, diagnostics: [...diagnostics(message.payload), ...observed] } : message.payload
      if (payload.ok === false) this.finish(entry, runtimeError(payload))
      else if (payload.ok === true) this.finish(entry, null, payload)
      else continue
      consumed++
    }
    return consumed
  }
  disconnect(reason = 'bridge disconnected') {
    this.connected = false
    for (const entry of this.pending.values()) this.finish(entry, cancelled(reason))
  }
  reconnect(sessionId = this.currentSession()) {
    if (this.closed) throw cancelled('bridge disposed')
    this.setSession(sessionId); this.connected = true
  }
  dispose() { if (!this.closed) { this.disconnect('bridge disposed'); this.closed = true; this.retired.clear() } }
}

function authority(value) {
  if (!record(value) || typeof value.sessionId !== 'string' || !value.sessionId || !decimal(value.revision) || !decimal(value.surfaceGeneration)) throw error('ERR_PROTOCOL_VERSION', 'authority needs sessionId and canonical revision/surfaceGeneration strings')
  return Object.freeze({ sessionId: value.sessionId, revision: value.revision, surfaceGeneration: value.surfaceGeneration })
}
const sameAuthority = (a, b) => a && b && a.sessionId === b.sessionId && a.revision === b.revision && a.surfaceGeneration === b.surfaceGeneration
const preparedTransactions = new WeakMap()
const queryLimits = Object.freeze({ pending: 32, requestBytes: 256 * 1024, retainedBytes: 1024 * 1024, rejections: 32 })
const queryEncoder = new TextEncoder()
function queryRequest(message) {
  if (message?.op !== 'view.query.request' || message.kind !== 'event' || message.protocolVersion !== '1.0') return null
  const value = message.payload, fields = ['version', 'requestId', 'key', 'afterEpoch', 'deadlineNs', 'occurrenceIds']
  const extentRequested = record(value) && Object.hasOwn(value, 'includeViewportExtent')
  if (!record(value) || Object.keys(value).length !== fields.length + (extentRequested ? 1 : 0)
    || !fields.every(field => Object.hasOwn(value, field)) || (extentRequested && value.includeViewportExtent !== true)
    || value.version !== '1.0' || typeof value.requestId !== 'string' || value.requestId.length > 32
    || !/^dom-query:[1-9][0-9]*$/.test(value.requestId) || !decimal(value.requestId.slice(10))
    || ![value.afterEpoch, value.deadlineNs].every(item => typeof item === 'string' && item.length <= 20 && decimal(item))
    || !Array.isArray(value.occurrenceIds) || value.occurrenceIds.length > 100000
    || value.occurrenceIds.some(id => typeof id !== 'string' || !id || id.length > 1024)
    || new Set(value.occurrenceIds).size !== value.occurrenceIds.length) throw error('ERR_PROTOCOL_VERSION', 'invalid DOM query request')
  if (!record(value.key) || keyFields.some(field => typeof value.key[field] !== 'string'
    || value.key[field].length > (['sessionId', 'profile'].includes(field) ? 256 : 20))) throw error('ERR_PROTOCOL_VERSION', 'query key exceeds its field bounds')
  validateDomPresentationKey(value.key)
  if (message.sessionId !== value.key.sessionId || typeof value.key.sessionId !== 'string' || value.key.sessionId.length > 256) throw error('ERR_PROTOCOL_VERSION', 'query envelope and presentation session differ')
  let lowerBound = 0
  for (const id of value.occurrenceIds) {
    lowerBound += id.length + 3
    if (lowerBound > queryLimits.requestBytes) throw error('ERR_RENDER', 'DOM query request exceeds its byte budget')
  }
  const bytes = queryEncoder.encode(JSON.stringify(value)).byteLength
  if (bytes > queryLimits.requestBytes) throw error('ERR_RENDER', 'DOM query request exceeds its byte budget')
  return { value: Object.freeze({ ...value, key: Object.freeze(copy(value.key)), occurrenceIds: Object.freeze([...value.occurrenceIds]) }),
    sequence: BigInt(value.requestId.slice(10)), bytes }
}

/** Transaction driver for an owned DomViewPresenter. Host revision is an
 * authoritative invalidation token, separate from runtime documentRevision.
 * The host calls updateAuthority() on state/reload and disconnect()/reconnect()
 * on its event stream. No HTTP receipt, handler plan or local permit grants
 * input authority. The client owns the presenter's callbacks and disposal.
 */
export class DomSessionClient {
  constructor({ presenter, transport, resolveResource, inputGate = () => true, queryScope, onDiagnostic, onState, timeoutMs = 5000 } = {}) {
    if (!presenter || !['prepare', 'commit', 'confirm', 'abort', 'suspendInput', 'dispose'].every(method => typeof presenter[method] === 'function') || typeof transport?.request !== 'function' || typeof inputGate !== 'function') throw error('ERR_PROTOCOL_VERSION', 'DOM client needs a transactional presenter and runtime transport')
    this.presenter = presenter; this.transport = transport; this.inputGate = inputGate; this.onDiagnostic = onDiagnostic; this.onState = onState; this.timeoutMs = deadline(timeoutMs, 'DOM client timeout')
    this.authority = null; this.online = true; this.closed = false; this.sequence = 0; this.active = null; this.accepted = null; this.turn = Promise.resolve(); this.background = new Set(); this.connection = new AbortController(); this.disposePromise = null; this.strictPresenterUsed = false; preparedTransactions.set(this, new WeakMap())
    this.querySequence = 0n; this.queryPending = 0; this.queryBytes = 0; this.queryRejectedPending = 0
    if (queryScope !== undefined && queryScope !== 'presentation') throw error('ERR_PROTOCOL_VERSION', 'DOM client query scope must be explicitly presentation-scoped')
    this.queryScope = queryScope; this.queryEnabled = false
    if (resolveResource) presenter.resolveResource = resolveResource
    presenter.onGeometry = batch => this.geometry(batch)
    presenter.onEventBatch = batch => this.events(batch)
  }
  report(value) { try { this.onDiagnostic?.(value) } catch { /* Preserve transaction cleanup if a diagnostic view fails. */ } }
  state(phase, data = {}) { try { this.onState?.({ phase, ...data }) } catch (failure) { this.report(failure) } }
  current(value) { return !this.closed && this.online && sameAuthority(this.authority, value) }
  inputAllowed(authority, key) {
    if (!this.current(authority)) return false
    const result = this.inputGate(Object.freeze({ authority, key }))
    if (typeof result !== 'boolean') throw error('ERR_PROTOCOL_VERSION', 'DOM input gate must return a synchronous boolean')
    return result
  }
  enqueue(work) { const next = this.turn.then(work); this.turn = next.catch(() => {}); return next }
  freeze() {
    this.queryEnabled = false
    if (this.accepted) this.accepted.inputEnabled = false
    try { this.presenter.suspendInput() } catch (failure) { this.report(failure) }
  }
  updateAuthority(value) {
    const next = authority(value), previous = this.authority
    if (previous?.sessionId === next.sessionId && (BigInt(next.revision) < BigInt(previous.revision) || BigInt(next.surfaceGeneration) < BigInt(previous.surfaceGeneration))) throw cancelled('authoritative revision regressed')
    if (sameAuthority(previous, next)) return false
    this.authority = next; this.cancelActive(); this.connection.abort(); this.connection = new AbortController(); this.freeze()
    if (previous?.sessionId !== next.sessionId) this.querySequence = 0n
    this.transport.setSession?.(next.sessionId)
    this.state('invalidated', { authority: next })
    return true
  }
  check(attempt) { if (!this.current(attempt.authority) || this.active !== attempt || attempt.controller.signal.aborted) throw cancelled() }
  async request(op, payload, { signal, sessionId, observed } = {}) {
    const result = await limited(Promise.resolve().then(() => this.transport.request(op, payload, { signal, sessionId, timeoutMs: this.timeoutMs })), signal, this.timeoutMs)
    for (const item of diagnostics(result)) { observed?.push(item); this.report(item) }
    if (result?.ok !== true || result.queued === true) throw result?.ok === false ? runtimeError(result) : error('ERR_PROTOCOL_VERSION', 'DOM operation requires a final runtime response, not a queued receipt')
    return result
  }
  track(promise) { this.background.add(promise); promise.finally(() => this.background.delete(promise)).catch(() => {}); return promise }
  /** A renderer owner may replace exact-key aborts only with an already-owned
   * native whole-presenter retirement. Failure remains a cleanup failure. */
  retireRemotePresenter(retirement) {
    if (!retirement || typeof retirement.then !== 'function' || this.remotePresenterRetirement && this.remotePresenterRetirement !== retirement) throw error('ERR_PROTOCOL_VERSION', 'invalid immutable remote retirement barrier')
    this.remotePresenterRetirement = retirement
    const attempt = this.active
    if ((attempt?.kind === 'sample' || attempt?.presentedRequested) && !attempt.remoteSettled && attempt.cleanupPromise) return this.retrySettlement(attempt)
  }
  retrySettlement(attempt) {
    if (attempt.settlementRetryRunning) return attempt.settlementRetry
    // Reconnect or a genuine native retirement permits another exact query.
    // The previous failed barrier keeps its original rejection.
    const previous = attempt.cleanupPromise
    attempt.settlementRetryRunning = true
    const retry = this.enqueue(async () => {
      try { await previous } catch { /* Its failure remains with its caller. */ }
      attempt.cleanupPromise = null
      const result = await this.cleanupAttempt(attempt)
      const shutdown = this.disposePromise
      if (this.closed && shutdown) {
        const renew = () => { if (this.disposePromise === shutdown) this.disposePromise = null }
        shutdown.then(() => {}, renew)
      }
      return result
    })
    attempt.settlementRetry = this.track(retry.then(value => { attempt.settlementRetryRunning = false; return value }, failure => { attempt.settlementRetryRunning = false; throw failure }))
    attempt.releasePromise = attempt.settlementRetry
    return attempt.settlementRetry
  }
  async remoteAbort(key, force = false, { strict = false, kind = 'template' } = {}) {
    if (!key || this.closed && !force) return false
    try {
      if (this.remotePresenterRetirement) {
        const receipt = await this.remotePresenterRetirement
        if (receipt?.version !== '1.0' || receipt.retired !== true || receipt.previousPresenterBinding?.sessionId !== key.sessionId) throw error('ERR_PROTOCOL_VERSION', 'remote retirement did not return its actual native final')
        return Object.freeze({ retired: true })
      } else {
        if (!this.online || key.sessionId !== this.authority?.sessionId) return false
        const result = await this.request(kind === 'sample' ? 'view.sample.abort' : 'view.abort', kind === 'sample' ? { version: '1.0', key } : key, { sessionId: key.sessionId })
        // Legacy view.abort only returned ok after removing its exact pending
        // candidate; an accepted candidate was an error. Preserve that final.
        if (kind !== 'sample' && result.version === undefined && result.key === undefined
          && result.aborted === undefined && result.presented === undefined) return Object.freeze({ aborted: true })
        if (result.version !== '1.0' || !sameKey(result.key, key)) throw error('ERR_PROTOCOL_VERSION', 'presentation settlement did not identify the exact key')
        if (result.aborted === true && result.presented !== true) {
          if (result.restoredKey !== undefined || result.inputEnabled === true) {
            if (kind === 'sample' || result.inputEnabled !== true || !decimal(result.inputLifetimeRevision)) throw error('ERR_PROTOCOL_VERSION', 'abort restoration has no exact lifetime proof')
            validateDomPresentationKey(result.restoredKey)
            return Object.freeze({ aborted: true, restoredKey: Object.freeze(copy(result.restoredKey)), inputLifetimeRevision: result.inputLifetimeRevision })
          }
          return Object.freeze({ aborted: true })
        }
        if (result.aborted === false && result.presented === true && result.inputEnabled === false) {
          return kind === 'sample'
            ? Object.freeze({ presented: true, consumedSample: copyConsumedSample(result.consumedSample) })
            : Object.freeze({ presented: true, permit: result.permit })
        }
        throw error('ERR_PROTOCOL_VERSION', 'presentation settlement has no exact terminal outcome')
      }
      return true
    }
    catch (failure) { this.report(failure); if (strict) throw failure; return false }
  }
  strictPresenterContract() {
    const fields = ['version', 'exactHandle', 'pendingAcquisitions', 'asynchronousDisposal', 'asynchronousConfirmation', 'asynchronousShutdown']
    const methods = ['candidateReleaseContract', 'releaseCandidate', 'drainCandidate', 'holdAcknowledgement', 'acknowledge', 'confirmAsync', 'disposeAsync', 'drainDisposal']
    if (!methods.every(method => typeof this.presenter[method] === 'function')) throw error('ERR_PROTOCOL_VERSION', 'strict DOM preparation requires the versioned presenter release/confirm/drain contract')
    const contract = this.presenter.candidateReleaseContract()
    if (!record(contract) || Object.keys(contract).length !== fields.length || Object.keys(contract).some(field => !fields.includes(field))
      || contract.version !== '1.0' || fields.slice(1).some(field => contract[field] !== true)) throw error('ERR_PROTOCOL_VERSION', 'unsupported DOM presenter release contract')
    return Object.freeze({ ...contract })
  }
  releaseOutcome(value, attempt) {
    const fields = ['version', 'handle', 'key', 'status', 'cleanupPending']
    if (!record(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(field => !fields.includes(field))
      || value.version !== '1.0' || value.handle !== attempt.candidate || !sameKey(value.key, attempt.key)
      || value.status !== (attempt.acknowledged ? 'retained' : 'released') || value.cleanupPending !== false) throw error('ERR_PROTOCOL_VERSION', 'presenter release did not settle the exact DOM candidate')
    validateDomPresentationKey(value.key)
    return value
  }
  finishAttempt(attempt) {
    if (attempt.finished) return
    attempt.finished = true
    if (!attempt.acknowledged) attempt.controller.abort()
    attempt.signal?.removeEventListener('abort', attempt.abort)
    if (this.active === attempt) this.active = null
  }
  retainAcknowledgement(attempt) {
    if (attempt.acknowledged && attempt.remoteSettled) return attempt.accepted
    // Seal the journal/key before input guards, activation, diagnostics or any
    // other fallible callback. Strict release must never retract a real ACK.
    attempt.acknowledged = true
    if (attempt.kind === 'sample') this.presenter.acknowledgeSample(attempt.candidate)
    else this.presenter.acknowledge(attempt.receipt)
    attempt.remoteSettled = true
    const accepted = { key: attempt.key, authority: attempt.authority, geometryEpoch: attempt.candidate.preparation.epoch,
      consumedInput: attempt.scheduling?.consumedInput, inputLifetimeRevision: attempt.inputLifetimeRevision, inputEnabled: false }
    attempt.accepted = accepted; this.accepted = accepted
    return accepted
  }
  async restoreAborted(attempt, settled) {
    const previous = attempt.previousAccepted
    if (!settled?.restoredKey || attempt.kind === 'sample' || attempt.acknowledged || attempt.releaseMode !== 'strict'
      || !previous || this.accepted !== previous || this.active || this.sequence !== attempt.serial
      || this.connection !== attempt.connection || !this.current(attempt.authority)
      || previous.key.sessionId !== attempt.authority.sessionId || previous.key.surfaceGeneration !== attempt.authority.surfaceGeneration
      || !sameKey(previous.key, settled.restoredKey) || !decimal(previous.inputLifetimeRevision)
      || previous.inputLifetimeRevision !== settled.inputLifetimeRevision) return false
    const current = () => this.accepted === previous && !this.active && this.sequence === attempt.serial
      && this.connection === attempt.connection && this.current(attempt.authority)
      && previous.inputLifetimeRevision === settled.inputLifetimeRevision && sameKey(previous.key, settled.restoredKey)
    // The embedding input gate is synchronous, but may reenter another owned
    // transaction. Recheck every fence after that callback and DOM activation.
    const allowed = () => current() && this.inputAllowed(attempt.authority, previous.key) && current()
    if (this.presenter.restoreConfirmed?.(previous.key, { isCurrent: current, inputGuard: allowed }) !== true) return false
    if (!current()) { this.freeze(); return false }
    previous.authority = attempt.authority; previous.inputEnabled = true
    this.state('ready', { key: previous.key, inputEnabled: true, restored: true })
    await this.enableAcceptedQueries({ ...attempt, key: previous.key }, previous, true)
    return true
  }
  async cleanupPublishedAttempt(attempt) {
    const failures = []
    let remoteAbort = attempt.acknowledged ? 'not-required' : 'unknown', locallyReleased = !attempt.candidate, settlement
    if (!attempt.key) {
      // No local style application or presented request was possible. A late
      // prepare still owns its separate exact-key abort callback.
      attempt.remoteSettled = true; remoteAbort = 'not-prepared'
    } else if (!attempt.acknowledged) {
      attempt.controller.abort()
      try {
        const settled = await this.remoteAbort(attempt.key, this.closed, { strict: true, kind: attempt.kind })
        if (!settled) throw error('ERR_RENDER', 'presentation remote outcome is unknown; its DOM must remain retained')
        if (settled.presented) {
          if (!attempt.candidate || (attempt.kind === 'sample'
            ? !attempt.consumedSample || !sameConsumedSample(settled.consumedSample, attempt.consumedSample)
            : !record(settled.permit) || settled.permit.version !== '1.0' || !sameKey(settled.permit.key, attempt.key)
              || settled.permit.epoch !== attempt.permit?.epoch || settled.permit.permitId !== attempt.permit?.permitId)) throw error('ERR_PROTOCOL_VERSION', 'settlement cannot identify the exact locally committed publication')
          this.retainAcknowledgement(attempt)
          remoteAbort = 'presented'
        } else if (settled.aborted || settled.retired) {
          settlement = settled
          attempt.remoteSettled = true
          remoteAbort = settled.retired ? 'retired' : 'confirmed'
        } else throw error('ERR_PROTOCOL_VERSION', 'sample settlement has no safe cleanup outcome')
      } catch (failure) { failures.push(failure) }
    } else try { this.retainAcknowledgement(attempt) } catch (failure) { failures.push(failure) }
    // An uncertain runtime final owns the applied journal and its resources.
    // Do not roll it back, dispose its DOM, or allow a successor to start.
    if (attempt.remoteSettled && attempt.acknowledged && attempt.kind !== 'sample' && !attempt.confirmationAttempted) try {
      attempt.confirmationAttempted = true
      if (attempt.releaseMode === 'strict') await this.presenter.confirmAsync(attempt.receipt, { inputEnabled: false, inputGuard: () => false, timeoutMs: this.timeoutMs })
      else this.presenter.confirm(attempt.receipt, { inputEnabled: false })
    } catch (failure) { attempt.localConfirmationFailure = failure }
    if (attempt.remoteSettled && attempt.candidate) try {
      if (attempt.releaseMode === 'strict') this.releaseOutcome(await this.presenter.releaseCandidate(attempt.candidate, { resumePrevious: false, timeoutMs: this.timeoutMs }), attempt)
      else if (!attempt.acknowledged) this.presenter.abort(attempt.candidate, { resumePrevious: false })
      locallyReleased = true
    } catch (failure) { failures.push(failure) }
    if (attempt.localConfirmationFailure || attempt.localPreparationCleanupFailure) failures.push(attempt.localConfirmationFailure ?? attempt.localPreparationCleanupFailure)
    if (attempt.remoteSettled && locallyReleased) this.finishAttempt(attempt)
    if (failures.length) {
      const failure = error('ERR_RENDER', 'DOM transaction release failed')
      failure.cleanupErrors = failures
      throw failure
    }
    await this.restoreAborted(attempt, settlement)
    return Object.freeze({ released: true, acknowledged: Boolean(attempt.acknowledged), remoteAbort, resourceBarrier: attempt.releaseMode })
  }
  // Cleanup runs on the same turn lane as preparation, commit, geometry and
  // events. A successor can never use resources before this exact barrier.
  cleanupAttempt(attempt) {
    if (attempt.cleanupPromise) return attempt.cleanupPromise
    if (attempt.kind === 'sample' || attempt.presentedRequested) {
      attempt.cleanupPromise = Promise.resolve().then(() => this.cleanupPublishedAttempt(attempt))
      return attempt.cleanupPromise
    }
    attempt.cleanupPromise = Promise.resolve().then(async () => {
      const failures = []
      let remoteAbort = attempt.acknowledged ? 'not-required' : 'not-prepared', settlement
      if (!attempt.acknowledged) {
        attempt.controller.abort()
        if (attempt.candidate) try {
          if (attempt.releaseMode === 'strict') this.releaseOutcome(await this.presenter.releaseCandidate(attempt.candidate, { resumePrevious: false, timeoutMs: this.timeoutMs }), attempt)
          else this.presenter.abort(attempt.candidate, { resumePrevious: false })
        } catch (failure) { failures.push(failure) }
        if (attempt.key) try {
          settlement = await this.remoteAbort(attempt.key, this.closed, { strict: true, kind: attempt.kind })
          remoteAbort = settlement ? 'confirmed' : 'unavailable'
        } catch (failure) { failures.push(failure); remoteAbort = 'failed' }
      } else if (attempt.releaseMode === 'strict' && attempt.candidate) try {
        this.releaseOutcome(await this.presenter.releaseCandidate(attempt.candidate, { timeoutMs: this.timeoutMs }), attempt)
      } catch (failure) { failures.push(failure) }
      if (attempt.localConfirmationFailure || attempt.localPreparationCleanupFailure) failures.push(attempt.localConfirmationFailure ?? attempt.localPreparationCleanupFailure)
      this.finishAttempt(attempt)
      if (failures.length) {
        const failure = error('ERR_RENDER', 'DOM transaction release failed')
        failure.cleanupErrors = failures
        throw failure
      }
      await this.restoreAborted(attempt, settlement)
      return Object.freeze({ released: true, acknowledged: Boolean(attempt.acknowledged), remoteAbort, resourceBarrier: attempt.releaseMode })
    })
    return attempt.cleanupPromise
  }
  queueRelease(attempt) {
    if (!attempt.releasePromise) attempt.releasePromise = this.enqueue(() => this.cleanupAttempt(attempt))
    return attempt.releasePromise
  }
  cancelActive() {
    const attempt = this.active
    if (!attempt || attempt.finished) return
    attempt.controller.abort()
    // Authority/connection/abort events cannot await. Keep cleanup on the
    // serial lane and surface failures through the existing diagnostic sink.
    this.track(this.queueRelease(attempt)).catch(failure => this.report(failure))
  }
  beginAttempt({ signal, hostContext } = {}, replace = false, releaseMode = 'legacy') {
    if (!['legacy', 'strict'].includes(releaseMode)) throw error('ERR_PROTOCOL_VERSION', 'invalid DOM preparation release mode')
    if (!['holdAcknowledgement', 'acknowledge'].every(method => typeof this.presenter[method] === 'function')) throw error('ERR_PROTOCOL_VERSION', 'DOM preparation requires irreversible runtime acknowledgement support')
    const releaseContract = releaseMode === 'strict' ? this.strictPresenterContract() : null
    if (!this.authority || !this.current(this.authority)) throw cancelled('no connected authoritative session')
    if (this.active && !this.active.finished) {
      if ((this.active.kind === 'sample' || this.active.presentedRequested) && !this.active.remoteSettled) throw error('ERR_RENDER', 'release the current presentation to an exact terminal outcome before preparing another')
      if (!replace) throw error('ERR_RENDER', 'release the current DOM preparation before preparing another')
      this.cancelActive()
    }
    const attempt = { serial: ++this.sequence, authority: this.authority, connection: this.connection, previousAccepted: this.accepted, hostContext: Object.freeze({ requestRevision: this.authority.revision, ...hostContext }), controller: new AbortController(), signal, observed: [], finished: false, phase: 'preparing', releaseMode, releaseContract }
    attempt.abort = () => {
      attempt.controller.abort()
      this.track(this.queueRelease(attempt)).catch(failure => this.report(failure))
    }
    if (releaseMode === 'strict') this.strictPresenterUsed = true
    this.active = attempt; this.freeze()
    if (signal?.aborted) attempt.abort(); else signal?.addEventListener('abort', attempt.abort, { once: true })
    this.check(attempt)
    return attempt
  }
  async failAttempt(attempt, failure) {
    this.freeze()
    try { await this.cleanupAttempt(attempt) } catch (cleanup) {
      failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup]
      this.report(cleanup)
    }
    for (const item of diagnostics(failure)) if (!attempt.observed.includes(item)) { attempt.observed.push(item); this.report(item) }
    this.report(failure); this.state('error', { key: attempt.key, error: failure })
  }
  async prepareAttempt(attempt, render) {
    this.check(attempt); this.state('preparing', { authority: attempt.authority }); this.check(attempt)
    const latePrepared = result => {
      if (attempt.acknowledged || result?.ok !== true || !result.submission?.key) return
      validateDomPresentationKey(result.submission.key)
      if (result.submission.key.sessionId !== attempt.authority.sessionId || result.submission.key.surfaceGeneration !== attempt.authority.surfaceGeneration) throw error('ERR_PROTOCOL_VERSION', 'late preparation belongs to another requested surface')
      return this.track(this.remoteAbort(result.submission.key))
    }
    const preparing = Promise.resolve().then(() => this.transport.request('view.prepare', { version: '1.0', surfaceGeneration: attempt.authority.surfaceGeneration, render }, { signal: attempt.controller.signal, sessionId: attempt.authority.sessionId, timeoutMs: this.timeoutMs, onLateResponse: latePrepared, hostContext: attempt.hostContext }))
    preparing.then(result => {
      if ((attempt.finished || !this.current(attempt.authority) || attempt.controller.signal.aborted) && result?.ok === true && result.submission?.key) {
        try { Promise.resolve(latePrepared(result)).catch(failure => this.report(failure)) } catch (failure) { this.report(failure) }
      }
    }, () => {})
    const prepared = await limited(preparing, attempt.controller.signal, this.timeoutMs)
    for (const item of diagnostics(prepared)) { attempt.observed.push(item); this.report(item) }
    if (prepared?.ok !== true || prepared.queued === true) throw prepared?.ok === false ? runtimeError(prepared) : error('ERR_PROTOCOL_VERSION', 'view.prepare requires a final runtime submission')
    this.check(attempt)
    const submission = prepared.submission
    if (submission?.version !== '1.0' || !record(submission.viewport) || !['width', 'height'].every(field => Number.isFinite(submission.viewport[field]) && submission.viewport[field] > 0 && submission.viewport[field] <= 4096)) throw error('ERR_PROTOCOL_VERSION', 'invalid runtime View submission')
    validateDomPresentationKey(submission.key)
    if (submission.key.sessionId !== attempt.authority.sessionId || submission.key.surfaceGeneration !== attempt.authority.surfaceGeneration) throw cancelled('runtime submission belongs to another surface or session')
    attempt.key = Object.freeze(copy(submission.key))
    validateDomViewDocument(submission.document); validateDomPresentationKey(submission.key, submission.document)
    attempt.scheduling = scheduling(prepared.scheduling, submission)
    try {
      attempt.candidate = await this.presenter.prepare(submission.document, { viewport: submission.viewport, presentationKey: attempt.key, signal: attempt.controller.signal, isCurrent: () => this.current(attempt.authority), resumePreviousOnAbort: false, releaseMode: attempt.releaseMode, animation: submission.animation, bindAnimation: async baseline => {
        this.check(attempt)
        const result = await this.request('view.animation.baseline', baseline, { signal: attempt.controller.signal, sessionId: attempt.key.sessionId, observed: attempt.observed })
        this.check(attempt)
        return { version: result.version, requestId: result.requestId, key: result.key, styles: result.styles }
      } })
    } catch (failure) {
      if (attempt.releaseMode === 'strict' && (failure?.cleanupDrain || failure?.cleanupErrors?.length)) attempt.localPreparationCleanupFailure = failure
      throw failure
    }
    this.check(attempt)
    attempt.phase = 'prepared'
    // The handle contains immutable preparation facts only. The local
    // candidate, resources, permit and mutable transaction are never exposed.
    attempt.handle = Object.freeze({ key: attempt.key, releaseMode: attempt.releaseMode, ...(attempt.scheduling ? { scheduling: attempt.scheduling } : {}) })
    preparedTransactions.get(this).set(attempt.handle, attempt)
    this.state('prepared', { key: attempt.key }); this.check(attempt)
    return attempt.handle
  }
  async presentAttempt(attempt) {
    if (attempt.kind === 'sample') return this.presentSampleAttempt(attempt)
    this.check(attempt)
    if (attempt.phase !== 'prepared' || attempt.cleanupPromise) throw cancelled('DOM preparation is no longer publishable')
    attempt.phase = 'presenting'
    const preparedCommit = await this.request('view.prepare.commit', attempt.candidate.preparation, { signal: attempt.controller.signal, sessionId: attempt.key.sessionId, observed: attempt.observed })
    this.check(attempt)
    const permit = preparedCommit.permit
    if (!record(permit) || Object.keys(permit).some(field => !['version', 'key', 'epoch', 'permitId'].includes(field)) || permit.version !== '1.0' || !sameKey(permit.key, attempt.key) || permit.epoch !== attempt.candidate.preparation.epoch || !decimal(permit.epoch) || typeof permit.permitId !== 'string' || !permit.permitId) throw error('ERR_PROTOCOL_VERSION', 'runtime permit does not identify prepared geometry')
    validateDomPresentationKey(permit.key)
    attempt.permit = Object.freeze({ version: permit.version, key: attempt.key, epoch: permit.epoch, permitId: permit.permitId })
    attempt.receipt = this.presenter.commit(attempt.candidate, attempt.permit)
    this.state('committed', { key: attempt.key }); this.check(attempt)
    attempt.presentedRequested = true
    this.presenter.holdAcknowledgement(attempt.receipt)
    const acknowledged = await this.request('view.presented', attempt.permit, { signal: attempt.controller.signal, sessionId: attempt.key.sessionId, observed: attempt.observed })
    if (!sameKey(acknowledged.key, attempt.key) || typeof acknowledged.inputEnabled !== 'boolean') throw error('ERR_PROTOCOL_VERSION', 'runtime ACK does not identify the committed presentation')
    if (decimal(acknowledged.inputLifetimeRevision)) attempt.inputLifetimeRevision = acknowledged.inputLifetimeRevision
    const accepted = this.retainAcknowledgement(attempt)
    if (acknowledged.inputLifetimeRevision !== undefined && !decimal(acknowledged.inputLifetimeRevision)) throw error('ERR_PROTOCOL_VERSION', 'runtime ACK has an invalid input lifetime')
    let inputEnabled = acknowledged.inputEnabled && this.inputAllowed(attempt.authority, attempt.key) && !attempt.controller.signal.aborted
    if (attempt.releaseMode !== 'strict') accepted.inputEnabled = inputEnabled
    attempt.confirmationAttempted = true
    if (attempt.releaseMode === 'strict') {
      try {
        const confirmed = await this.presenter.confirmAsync(attempt.receipt, { inputEnabled, timeoutMs: this.timeoutMs,
          inputGuard: () => this.inputAllowed(attempt.authority, attempt.key) && !attempt.controller.signal.aborted })
        const fields = ['version', 'handle', 'key', 'receipt', 'inputEnabled', 'cleanupPending']
        if (!record(confirmed) || Object.keys(confirmed).length !== fields.length || Object.keys(confirmed).some(field => !fields.includes(field))
          || confirmed.version !== '1.0' || confirmed.handle !== attempt.candidate || !sameKey(confirmed.key, attempt.key)
          || confirmed.receipt !== attempt.receipt || typeof confirmed.inputEnabled !== 'boolean' || (confirmed.inputEnabled && !inputEnabled)
          || confirmed.cleanupPending !== false) throw error('ERR_PROTOCOL_VERSION', 'presenter confirmation did not settle the exact DOM candidate')
        validateDomPresentationKey(confirmed.key)
        inputEnabled = confirmed.inputEnabled && this.inputAllowed(attempt.authority, attempt.key) && !attempt.controller.signal.aborted
        accepted.inputEnabled = inputEnabled
      } catch (failure) { attempt.localConfirmationFailure = failure; throw failure }
    } else this.presenter.confirm(attempt.receipt, { inputEnabled })
    if (attempt.releaseMode !== 'strict') this.check(attempt)
    this.state(inputEnabled ? 'ready' : 'blocked', { key: attempt.key, inputEnabled, diagnostics: attempt.observed })
    // Strict confirmation has already retained the real ACK. Retirement is a
    // disabled final, not a cleanup failure or permission to retract that ACK.
    if (attempt.releaseMode === 'strict') {
      inputEnabled = inputEnabled && this.active === attempt && this.inputAllowed(attempt.authority, attempt.key) && !attempt.controller.signal.aborted
      accepted.inputEnabled = inputEnabled
      if (!inputEnabled) this.freeze()
    } else this.check(attempt)
    this.finishAttempt(attempt)
    await this.enableAcceptedQueries(attempt, accepted, inputEnabled)
    return { key: attempt.key, permit: attempt.permit, receipt: attempt.receipt, inputEnabled, diagnostics: attempt.observed, ...(attempt.scheduling ? { scheduling: attempt.scheduling } : {}) }
  }
  async enableAcceptedQueries(attempt, accepted, inputEnabled) {
    if (this.queryScope !== 'presentation' || !inputEnabled || this.accepted !== accepted || !this.inputAllowed(attempt.authority, attempt.key)) return
    try {
      const enabled = await this.request('view.query.enable', { version: '1.0', scope: 'presentation', key: attempt.key },
        { sessionId: attempt.key.sessionId, signal: this.connection.signal })
      if (enabled.version !== '1.0' || enabled.scope !== 'presentation' || enabled.enabled !== true || !sameKey(enabled.key, attempt.key)) throw error('ERR_PROTOCOL_VERSION', 'query host enable did not enable the exact accepted presentation key')
      this.queryEnabled = this.accepted === accepted && accepted.inputEnabled && this.inputAllowed(attempt.authority, attempt.key)
    } catch (failure) { this.queryEnabled = false; this.report(failure) }
  }
  prepareSample(sampleDemandRevision, options = {}) {
    let attempt
    try {
      animationU64(sampleDemandRevision)
      if (options.releaseMode !== undefined && options.releaseMode !== 'strict'
        || typeof this.presenter.acknowledgeSample !== 'function') throw error('ERR_PROTOCOL_VERSION', 'retained samples require the strict irreversible acknowledgement contract')
      attempt = this.beginAttempt(options, false, options.releaseMode ?? 'strict'); attempt.kind = 'sample'
    } catch (failure) { return Promise.reject(failure) }
    return this.enqueue(async () => {
      try {
        this.check(attempt)
        const base = this.accepted
        if (!base || !sameAuthority(base.authority, attempt.authority) || !decimal(base.geometryEpoch)) throw cancelled('retained sample has no exact accepted geometry')
        const payload = { version: '1.0', baseKey: base.key, baseGeometryEpoch: base.geometryEpoch, sampleDemandRevision }
        const latePrepared = result => {
          if (attempt.acknowledged || result?.ok !== true || !result.submission?.key) return
          validateDomPresentationKey(result.submission.key)
          if (result.submission.key.sessionId !== attempt.authority.sessionId || result.submission.key.surfaceGeneration !== attempt.authority.surfaceGeneration) throw error('ERR_PROTOCOL_VERSION', 'late sample belongs to another surface')
          return this.track(this.remoteAbort(result.submission.key, false, { kind: 'sample' }))
        }
        const preparing = Promise.resolve().then(() => this.transport.request('view.sample.prepare', payload, { signal: attempt.controller.signal,
          sessionId: attempt.authority.sessionId, timeoutMs: this.timeoutMs, onLateResponse: latePrepared, hostContext: attempt.hostContext }))
        preparing.then(result => {
          if (attempt.finished || !this.current(attempt.authority) || attempt.controller.signal.aborted) {
            try { Promise.resolve(latePrepared(result)).catch(failure => this.report(failure)) } catch (failure) { this.report(failure) }
          }
        }, () => {})
        const prepared = await limited(preparing, attempt.controller.signal, this.timeoutMs)
        if (prepared?.ok !== true || prepared.queued === true) throw prepared?.ok === false ? runtimeError(prepared) : error('ERR_PROTOCOL_VERSION', 'sample prepare requires a final native submission')
        this.check(attempt)
        // Retain a validated key for exact remote cleanup even if later metadata is malformed.
        validateDomPresentationKey(prepared.submission?.key)
        if (prepared.submission.key.sessionId !== base.key.sessionId || prepared.submission.key.surfaceGeneration !== base.key.surfaceGeneration) throw cancelled('sample belongs to another owner')
        attempt.key = Object.freeze(copy(prepared.submission.key))
        const submission = copySampleSubmission(prepared.submission, base.key, base.geometryEpoch, sampleDemandRevision)
        attempt.scheduling = scheduling(prepared.scheduling, submission, base.consumedInput?.routePath)
        if (!attempt.scheduling || !sameConsumedInput(attempt.scheduling.consumedInput, base.consumedInput)
          || !sameConsumedSample(attempt.scheduling.consumedSample, submission.consumedSample)) throw error('ERR_PROTOCOL_VERSION', 'sample scheduling differs from the cloned sample')
        attempt.consumedSample = submission.consumedSample
        attempt.permit = copySamplePermit(prepared.permit, submission)
        attempt.candidate = this.presenter.prepareSample(submission, attempt.permit, { isCurrent: () => this.current(attempt.authority) && this.active === attempt && !attempt.controller.signal.aborted })
        this.check(attempt); attempt.phase = 'prepared'
        attempt.handle = Object.freeze({ key: attempt.key, releaseMode: attempt.releaseMode, scheduling: attempt.scheduling })
        preparedTransactions.get(this).set(attempt.handle, attempt)
        return attempt.handle
      } catch (failure) { await this.failAttempt(attempt, failure); throw failure }
    })
  }
  async presentSampleAttempt(attempt) {
    this.check(attempt)
    if (attempt.phase !== 'prepared' || attempt.cleanupPromise) throw cancelled('sample is no longer publishable')
    attempt.phase = 'presenting'
    const geometry = this.presenter.commitSample(attempt.candidate)
    this.check(attempt)
    const acknowledged = await this.request('view.sample.presented', { version: '1.0', permit: attempt.permit, geometry },
      { signal: attempt.controller.signal, sessionId: attempt.key.sessionId, observed: attempt.observed })
    if (acknowledged.version !== '1.0' || !sameKey(acknowledged.key, attempt.key) || !sameConsumedSample(acknowledged.consumedSample, attempt.consumedSample)
      || typeof acknowledged.inputEnabled !== 'boolean') throw error('ERR_PROTOCOL_VERSION', 'sample ACK does not identify its cloned publication/sample')
    const accepted = this.retainAcknowledgement(attempt)
    let inputEnabled = acknowledged.inputEnabled && this.active === attempt && this.inputAllowed(attempt.authority, attempt.key) && !attempt.controller.signal.aborted
    try {
      const confirmed = this.presenter.confirmSample(attempt.candidate, { inputEnabled,
        inputGuard: () => this.inputAllowed(attempt.authority, attempt.key) && !attempt.controller.signal.aborted })
      if (confirmed.handle !== attempt.candidate || !sameKey(confirmed.key, attempt.key) || typeof confirmed.inputEnabled !== 'boolean' || confirmed.cleanupPending !== false) throw error('ERR_PROTOCOL_VERSION', 'sample confirmation did not settle its exact candidate')
      inputEnabled = confirmed.inputEnabled && this.active === attempt && this.inputAllowed(attempt.authority, attempt.key) && !attempt.controller.signal.aborted
      accepted.inputEnabled = inputEnabled
    } catch (failure) { attempt.localConfirmationFailure = failure; throw failure }
    if (!inputEnabled) this.freeze()
    this.finishAttempt(attempt)
    await this.enableAcceptedQueries(attempt, accepted, inputEnabled)
    return { key: attempt.key, inputEnabled, scheduling: attempt.scheduling, diagnostics: attempt.observed }
  }
  /** Prepare resources and measure, without a permit, local swap or ACK.
   * Exactly one split transaction is allowed until present/release settles.
   * `key`/`scheduling` are copied preparation facts, never input authority. */
  prepareTemplate(render, options = {}) {
    let attempt
    try { attempt = this.beginAttempt(options, false, options.releaseMode ?? 'strict') } catch (failure) { return Promise.reject(failure) }
    return this.enqueue(async () => {
      try { return await this.prepareAttempt(attempt, render) }
      catch (failure) { await this.failAttempt(attempt, failure); throw failure }
    })
  }
  /** Admit geometry, swap once, obtain the exact runtime ACK, then confirm. */
  presentPrepared(handle) {
    const attempt = preparedTransactions.get(this).get(handle)
    try {
      if (!attempt || attempt.handle !== handle || attempt.presentRequested) throw cancelled('unknown or already consumed DOM preparation')
      this.check(attempt)
      if (attempt.phase !== 'prepared') throw cancelled('DOM preparation is not ready')
      attempt.presentRequested = true
    } catch (failure) { return Promise.reject(failure) }
    return this.enqueue(async () => {
      try { return await this.presentAttempt(attempt) }
      catch (failure) { await this.failAttempt(attempt, failure); throw failure }
    })
  }
  /** Idempotent exact release barrier. Confirmed pixels/resources remain
   * presenter-owned until superseded or disposed; release never retracts ACK. */
  releasePrepared(handle) {
    const attempt = preparedTransactions.get(this).get(handle)
    if (!attempt || attempt.handle !== handle) return Promise.reject(cancelled('unknown DOM preparation'))
    if (!attempt.acknowledged) attempt.controller.abort()
    return this.queueRelease(attempt)
  }
  // Legacy convenience retains immediate replacement/cancellation and the
  // complete transaction on one serial turn. It shares the actual phases.
  present(render, options = {}) {
    let attempt
    try { attempt = this.beginAttempt(options, true, options.releaseMode ?? 'legacy') } catch (failure) { return Promise.reject(failure) }
    return this.enqueue(async () => {
      try { await this.prepareAttempt(attempt, render); return await this.presentAttempt(attempt) }
      catch (failure) { await this.failAttempt(attempt, failure); throw failure }
    })
  }
  sendInput(op, batch) {
    validateDomPresentationKey(batch?.key)
    const owner = this.accepted
    const discarded = () => ({ discarded: true, source: 'local-retirement', key: batch.key })
    const retired = () => !owner || !owner.inputEnabled || this.active || !this.inputAllowed(owner.authority, owner.key) || this.accepted !== owner || !sameKey(batch.key, owner.key)
    return this.enqueue(async () => {
      if (retired()) return discarded()
      try {
        const result = await this.request(op, batch, { sessionId: owner.key.sessionId, signal: this.connection.signal })
        // A genuine in-flight native geometry final remains the admitted base even
        // when beginAttempt has already frozen local event/query authority.
        if (op === 'view.geometry' && this.accepted === owner && sameKey(batch.key, owner.key) && decimal(batch.epoch)) owner.geometryEpoch = batch.epoch
        if (retired()) return discarded()
        this.state('updated', { op, key: owner.key, diagnostics: diagnostics(result) })
        return result
      } catch (failure) {
        if (failure.localCancellation && retired()) return discarded()
        owner.inputEnabled = false; this.freeze(); this.report(failure); throw failure
      }
    })
  }
  geometry(batch) { return this.sendInput('view.geometry', batch) }
  events(batch) { return this.sendInput('view.events', batch) }
  /** Runtime-issued selector jobs share the transaction lane and close barrier.
   * The native session's monotonic query sequence prevents duplicate samples
   * without retaining an unbounded request/result cache. */
  receiveQueryBatch(batch) {
    if (this.closed || !this.online) return 0
    const messages = Array.isArray(batch?.messages) ? batch.messages : [batch]
    let admitted = 0
    for (const message of messages) {
      if (this.closed || !this.online) break
      let request
      try { request = queryRequest(message) } catch (failure) { this.report(failure); continue }
      if (!request || request.value.key.sessionId !== this.authority?.sessionId || request.sequence <= this.querySequence) continue
      this.querySequence = request.sequence
      const overflow = this.queryPending >= queryLimits.pending || request.bytes > queryLimits.retainedBytes - this.queryBytes
      const rejection = overflow ? error('ERR_RENDER', 'DOM query queue exceeds its finite count/byte budget') : null
      if (rejection) {
        // Native admits at most 32 requests. Retain only bounded identity for
        // refusals, never another copy of an overflowing occurrence-id list.
        if (this.queryRejectedPending >= queryLimits.rejections) { this.report(rejection); continue }
        this.queryRejectedPending++
      } else { this.queryPending++; this.queryBytes += request.bytes; admitted++ }
      const value = rejection ? { version: '1.0', requestId: request.value.requestId, key: request.value.key } : request.value
      const retainedBytes = rejection ? 0 : request.bytes
      const connection = this.connection.signal
      const task = this.enqueue(async () => {
        const owner = this.accepted
        const current = () => !connection.aborted && owner && owner.inputEnabled && !this.active
          && this.accepted === owner && sameKey(value.key, owner.key) && this.inputAllowed(owner.authority, owner.key)
        let outcome
        try {
          if (!current()) throw cancelled('query has no current confirmed presentation lease')
          if (rejection) throw rejection
          if (typeof this.presenter.sampleQueryGeometry !== 'function') throw error('ERR_UNSUPPORTED_CAPABILITY', 'DOM presenter cannot sample selector queries')
          const sample = this.presenter.sampleQueryGeometry(value.key, value.afterEpoch, value.occurrenceIds, value.includeViewportExtent === true)
          if (!current()) throw cancelled('query presentation lease changed during browser measurement')
          outcome = { geometry: sample.geometry, viewportScroll: sample.viewportScroll,
            ...(value.includeViewportExtent === true && sample.viewportExtent !== undefined ? { viewportExtent: sample.viewportExtent } : {}) }
        } catch (failure) {
          outcome = { error: { code: ['ERR_RENDER', 'ERR_CANCELLED', 'ERR_TIMEOUT', 'ERR_INVALID_REQUEST'].includes(failure?.code) ? failure.code : 'ERR_RENDER',
            message: typeof failure?.message === 'string' ? failure.message.slice(0, 2048) : 'Browser geometry sampling failed' } }
        }
        // Native alone authorizes deadlineNs; a browser wall-clock estimate
        // cannot replace its atomic key/lease/epoch/deadline validation.
        if (connection.aborted || this.closed || !this.online || value.key.sessionId !== this.authority?.sessionId) return
        return this.request('view.query.result', { version: '1.0', requestId: value.requestId, key: value.key, ...outcome },
          { sessionId: value.key.sessionId, signal: connection })
      })
      this.track(task.catch(failure => this.report(failure)).finally(() => {
        if (rejection) this.queryRejectedPending--
        else { this.queryPending--; this.queryBytes -= retainedBytes }
      }))
      // Diagnostic callbacks may synchronously dispose the client. Its close
      // barrier must include this exact refusal, so publish only after track.
      if (rejection) this.report(rejection)
    }
    return admitted
  }
  disconnect(reason = 'DOM event stream disconnected') {
    this.online = false; this.cancelActive(); this.connection.abort(); this.freeze(); this.transport.disconnect?.(reason); this.state('disconnected')
  }
  reconnect(value = this.authority) {
    if (this.closed) throw cancelled('DOM client disposed')
    if (value) this.updateAuthority(value)
    this.transport.reconnect?.(this.authority?.sessionId); this.connection = new AbortController(); this.online = true; this.freeze(); this.state('connected')
    const attempt = this.active
    if ((attempt?.kind === 'sample' || attempt?.presentedRequested) && !attempt.remoteSettled && attempt.cleanupPromise) this.retrySettlement(attempt).catch(failure => this.report(failure))
  }
  dispose() {
    if (this.disposePromise) return this.disposePromise
    // Claim the barrier before synchronous suspension/diagnostic callbacks.
    let resolve, reject
    this.disposePromise = new Promise((yes, no) => { resolve = yes; reject = no })
    const attempt = this.active
    this.closed = true; this.cancelActive(); this.connection.abort(); this.freeze()
    const drain = this.turn
    Promise.resolve().then(async () => {
      const failures = []
      await drain
      if (attempt) try { await this.cleanupAttempt(attempt) } catch (failure) { failures.push(failure) }
      const background = await Promise.allSettled([...this.background])
      failures.push(...background.filter(value => value.status === 'rejected').map(value => value.reason))
      const uncertainPresentation = (attempt?.kind === 'sample' || attempt?.presentedRequested) && !attempt.remoteSettled
      if (uncertainPresentation) failures.push(error('ERR_RENDER', 'presentation runtime outcome remains unknown; DOM and resource leases are retained'))
      else if (this.strictPresenterUsed) try {
        const disposed = await this.presenter.disposeAsync({ timeoutMs: this.timeoutMs })
        const fields = ['version', 'presenter', 'status', 'cleanupPending']
        if (!record(disposed) || Object.keys(disposed).length !== fields.length || Object.keys(disposed).some(field => !fields.includes(field))
          || disposed.version !== '1.0' || disposed.presenter !== this.presenter || disposed.status !== 'disposed' || disposed.cleanupPending !== false) throw error('ERR_PROTOCOL_VERSION', 'presenter shutdown did not settle owned DOM resources')
      } catch (failure) { failures.push(failure) }
      else try { this.presenter.dispose() } catch (failure) { failures.push(failure) }
      this.online = false
      if (!uncertainPresentation) try { this.transport.dispose?.() } catch (failure) { failures.push(failure) }
      if (!uncertainPresentation) this.accepted = null
      this.state(uncertainPresentation ? 'cleanup-blocked' : 'disposed')
      if (failures.length) {
        const unique = [...new Set(failures)]
        // Preserve the legacy caller's exact single failure identity. Strict
        // shutdown and multiple failures retain the versioned aggregate.
        if (!this.strictPresenterUsed && unique.length === 1) throw unique[0]
        const failure = error('ERR_RENDER', 'DOM client cleanup failed')
        failure.cleanupErrors = unique
        throw failure
      }
    }).then(resolve, reject)
    return this.disposePromise
  }
}
