/** Explicit opt-in stable-Document v2 host. Native editing is frozen while a
 * transaction is pending; this contract does not provide an editing lease or
 * IME continuity. The Document, mount and containing iframe remain borrowed.
 */
import { DOM_BASE_CSS, DomViewError, prepareDomDocument, validateDomPresentationKey, validateDomViewDocument } from './dom-presenter.mjs'
import { DOM_LIVE_PATCH_CONTRACT, DomLiveSurface } from './dom-live-patch.mjs'

const clients = new WeakMap()
const MAX_EXCHANGES = 8
const EXCHANGE_METADATA_BYTES = 256
const MAX_CONSUMPTION_BYTES = 256 * 1024
const MAX_CONSUMPTION_ENVELOPE_BYTES = 64 * 1024
const MAX_DIAGNOSTICS = 32
function cleanupDiagnostic(state, error) {
  // A diagnostic ring must not retain an Error's arbitrary cause, runtime
  // batch, DOM candidate or application-owned object graph.
  let message = 'live cleanup failed', code = 'ERR_RENDER'
  try { if (typeof error?.message === 'string') message = error.message.slice(0, 2048); if (typeof error?.code === 'string') code = error.code.slice(0, 128) } catch {}
  if (state.cleanupErrors.length === MAX_DIAGNOSTICS) state.cleanupErrors.shift()
  state.cleanupErrors.push(Object.freeze({ code, message }))
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const problem = (code, message) => new DomViewError(code, message)
const invalid = message => { throw problem('ERR_PROTOCOL_VERSION', message) }
const cancelled = message => problem('ERR_CANCELLED', message)
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n
const same = (left, right) => {
  if (left === right) return true
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((child, index) => same(child, right[index]))
  if (!object(left) || !object(right) || Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(name => Object.hasOwn(right, name) && same(left[name], right[name]))
}
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
function copy(value, depth = 0) {
  if (depth > 128) invalid('live bridge JSON nesting budget exceeded')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(child => copy(child, depth + 1))
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('live bridge needs finite JSON values')
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child, depth + 1)]))
}
function exact(value, names, label) {
  if (!object(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid(`invalid ${label} shape`)
}
function key(value, sessionId, document) {
  validateDomPresentationKey(value, document)
  if (value.sessionId !== sessionId) invalid('live presentation belongs to another session')
}
function syncFence(state) {
  if (state.invalidated || state.closing) return false
  const result = state.isCurrent()
  if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); invalid('live owner fence must be synchronous') }
  if (typeof result !== 'boolean') invalid('live owner fence must return a boolean')
  return result && !state.invalidated && !state.closing
}
function freezeNative(state) {
  state.inputEnabled = false
  if (!state.inertBorrow) state.inertBorrow = { original: state.mount.inert, written: true }
  state.mount.inert = true; state.inertBorrow.written = true
}
function releaseInert(state) {
  const borrow = state.inertBorrow
  if (!borrow) return
  // Do not overwrite a distinguishable change made by the embedding owner.
  if (state.mount.inert === borrow.written) state.mount.inert = borrow.original
  state.inertBorrow = null
}
function enableNativeInput(state, ownerCurrent = () => true) {
  const current = () => ownerCurrent() && syncFence(state) && ownerCurrent()
  try {
    if (!current()) return
    releaseInert(state)
    // Borrowed mount accessors and the owner fence can synchronously retire this
    // client. Neither an old boolean nor restoring inert grants a fresh lease.
    const enabled = state.mount.inert === false
    if (!current()) { freezeNative(state); return }
    state.inputEnabled = enabled
  } catch (error) { freezeNative(state); throw error }
}
function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? cancelled('live operation cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener('abort', abort); reject(signal.reason ?? cancelled('live operation cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(value => { signal?.removeEventListener('abort', abort); resolve(value) }, error => { signal?.removeEventListener('abort', abort); reject(error) })
  })
}

/** Real browser readiness. Decoder settlement remains a resource last-use even
 * when the local observer is cancelled. Only owned CSS preload sources clear.
 */
export async function waitForDomLiveReady({ document, surface, candidate, plan, signal }) {
  const window = document.defaultView, decoders = [], preloads = [], urls = new Set()
  const clear = () => { for (const image of preloads) image.removeAttribute('src') }
  const decode = image => {
    if (typeof image?.decode !== 'function') invalid('live image readiness requires native image.decode')
    const promise = Promise.resolve().then(() => image.decode()); promise.catch(() => {}); decoders.push(promise)
  }
  signal?.addEventListener('abort', clear, { once: true })
  try {
    if (signal?.aborted) throw signal.reason ?? cancelled('live readiness cancelled')
    for (const [id, planned] of plan.allElements) if (planned.tag === 'image' && planned.imageUrl) {
      const image = surface.node(id)
      if (image?.ownerDocument !== document || image.isConnected !== true) invalid('live image is not in the borrowed document')
      urls.add(planned.imageUrl); decode(image)
    }
    for (const url of plan.urls) if (!urls.has(url)) {
      const image = document.createElement('img'); preloads.push(image); image.src = url; urls.add(url); decode(image)
    }
    // Register before yielding or invoking any external completion callback.
    candidate.retainUntil(Promise.allSettled(decoders))
    await abortable(Promise.all(decoders), signal)
    if (!document.fonts?.ready || typeof window?.requestAnimationFrame !== 'function' || typeof window?.cancelAnimationFrame !== 'function') invalid('live readiness requires native fonts and animation frames')
    await abortable(document.fonts.ready, signal)
    const frame = new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? cancelled('live frame cancelled')); return }
      let handle
      const abort = () => { window.cancelAnimationFrame(handle); signal?.removeEventListener('abort', abort); reject(signal.reason ?? cancelled('live frame cancelled')) }
      handle = window.requestAnimationFrame(() => { signal?.removeEventListener('abort', abort); resolve() })
      signal?.addEventListener('abort', abort, { once: true })
    })
    candidate.retainUntil(frame.catch(() => {})); await frame
  } finally {
    // Earlier decode() setup can throw; any already-created decoder still owns
    // its actual last use, independently of this local readiness result.
    if (decoders.length) candidate.retainUntil(Promise.allSettled(decoders))
    signal?.removeEventListener('abort', clear); clear()
  }
}

function contract(value, version) {
  exact(value, ['version', 'documentPermit', 'liveGeometryFinalization', 'nativeEditing', 'finalReplay', 'inputLifetimeRevision', 'permitTtlMs', 'maxRetainedRequests', 'maxRetainedBytes', 'requiresOwnerReplacementWhenFull', ...(version === '2.1' ? ['transactionRetention'] : [])], 'live contract')
  if (value.version !== version || value.documentPermit !== true || value.liveGeometryFinalization !== true || value.nativeEditing !== false
    || value.finalReplay !== true || !decimal(value.inputLifetimeRevision) || value.requiresOwnerReplacementWhenFull !== (version === '2.0')
    || !Number.isSafeInteger(value.permitTtlMs) || value.permitTtlMs < 1 || value.permitTtlMs > 60000
    || !Number.isSafeInteger(value.maxRetainedRequests) || value.maxRetainedRequests < 4 || value.maxRetainedRequests > 1024
    || !Number.isSafeInteger(value.maxRetainedBytes) || value.maxRetainedBytes < 1024 || value.maxRetainedBytes > 64 * 1024 * 1024) invalid('unsupported live document contract')
  if (version === '2.1') {
    const retention = value.transactionRetention
    exact(retention, ['version', 'laneId', 'firstSequence', 'explicitConsumption'], 'live transaction retention contract')
    if (retention.version !== '1.0' || typeof retention.laneId !== 'string' || !retention.laneId || retention.laneId.length > 256
      || retention.firstSequence !== '1' || retention.explicitConsumption !== true) invalid('unsupported live transaction retention contract')
  }
  return value
}
function submission(state, attempt, value) {
  exact(value, ['version', 'key', 'baseKey', 'documentToken', 'inputLifetimeRevision', 'runtimeIdentities', 'viewport', 'document'], 'live submission')
  key(value.key, state.sessionId, value.document)
  if (value.baseKey !== null) { key(value.baseKey, state.sessionId); if (!same(value.baseKey, state.accepted?.key)) invalid('runtime live base is not this owner\'s accepted presentation') }
  if (value.version !== state.liveVersion || value.key.surfaceGeneration !== attempt.surfaceGeneration
    || value.inputLifetimeRevision !== state.contract.inputLifetimeRevision || typeof value.documentToken !== 'string' || !value.documentToken || value.documentToken.length > 4096
    || !object(value.runtimeIdentities) || !object(value.viewport)
    || !['width', 'height'].every(name => Number.isFinite(value.viewport[name]) && value.viewport[name] > 0 && value.viewport[name] <= 4096)) invalid('invalid live submission identity or viewport')
  const tables = validateDomViewDocument(value.document)
  if (Object.keys(value.runtimeIdentities).length !== tables.nodes.size
    || [...tables.nodes.keys()].some(id => typeof value.runtimeIdentities[id] !== 'string' || !value.runtimeIdentities[id] || value.runtimeIdentities[id].length > 4096)) invalid('incomplete runtime live identities')
  return value
}
function permit(state, attempt, value) {
  exact(value, ['version', 'key', 'baseKey', 'documentToken', 'inputLifetimeRevision', 'permitId', 'ttlMs'], 'live document permit')
  const source = attempt.submission
  if (value.version !== state.liveVersion || !same(value.key, source.key) || !same(value.baseKey, source.baseKey)
    || value.documentToken !== source.documentToken || value.inputLifetimeRevision !== source.inputLifetimeRevision
    || value.ttlMs !== state.contract.permitTtlMs || typeof value.permitId !== 'string' || !value.permitId || value.permitId.length > 4096) invalid('live permit does not authorize this exact submission')
  return value
}
function geometry(state, attempt, value) {
  exact(value, ['key', 'viewport', 'nodes'], 'measured live geometry')
  if (!same(value.key, attempt.submission.key) || !same(value.viewport, attempt.submission.viewport) || !Array.isArray(value.nodes)) invalid('live geometry does not identify the exact candidate')
  const expected = validateDomViewDocument(attempt.submission.document).nodes, seen = new Set()
  for (const node of value.nodes) {
    exact(node, ['occurrenceId', 'borderBox', 'scrollOffset', 'scrollExtent', 'clientSize'], 'live geometry node')
    exact(node.borderBox, ['x', 'y', 'width', 'height'], 'live border box'); exact(node.scrollOffset, ['x', 'y'], 'live scroll offset')
    exact(node.scrollExtent, ['width', 'height'], 'live scroll extent'); exact(node.clientSize, ['width', 'height'], 'live client size')
    if (!expected.has(node.occurrenceId) || seen.has(node.occurrenceId)
      || [...Object.values(node.borderBox), ...Object.values(node.scrollOffset), ...Object.values(node.scrollExtent), ...Object.values(node.clientSize)].some(number => !Number.isFinite(number))
      || [node.borderBox.width, node.borderBox.height, ...Object.values(node.scrollExtent), ...Object.values(node.clientSize)].some(number => number < 0)) invalid('invalid or duplicate actual live geometry')
    seen.add(node.occurrenceId)
  }
  if (seen.size !== expected.size) invalid('live geometry omits document occurrences')
  if (state.epoch === 18446744073709551615n) invalid('live geometry epoch exhausted')
  attempt.epoch = String(++state.epoch)
  return { version: '1.0', key: value.key, epoch: attempt.epoch, viewport: value.viewport, nodes: value.nodes }
}
function pendingError(final) {
  return /already pending|outcome is indeterminate|native input lifetime retired/.test(final.error?.message ?? '')
}
function remoteError(final) {
  const error = problem(final.error?.code ?? 'ERR_RENDER', final.error?.message ?? 'live transaction rejected')
  error.runtimeFinal = final
  if (final.requiresRestart === true) error.requiresRestart = true
  return error
}

export class DomLiveSessionClient {
  constructor({ document, mount = document?.body, sessionId, dispatchEnvelope, resolveResource,
    prepareDocument = prepareDomDocument, createSurface = options => new DomLiveSurface(options), waitForReady = waitForDomLiveReady,
    isCurrent = () => true, onBatch = () => {}, clock = () => performance.now(), timeoutMs = 5000,
    initialEpoch = '0', requestIdPrefix = globalThis.crypto?.randomUUID?.(), surfaceOptions = {}, liveVersion = '2.0' } = {}) {
    if (!document || mount?.ownerDocument !== document || typeof mount.inert !== 'boolean'
      || typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096
      || [dispatchEnvelope, prepareDocument, createSurface, waitForReady, isCurrent, onBatch, clock].some(value => typeof value !== 'function')
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !decimal(initialEpoch)
      || typeof requestIdPrefix !== 'string' || !requestIdPrefix || requestIdPrefix.length > 256
      || !['2.0', '2.1'].includes(liveVersion)) invalid('invalid live session client configuration (native inert is required)')
    const state = { document, mount, sessionId, dispatchEnvelope, resolveResource, prepareDocument, waitForReady, isCurrent, onBatch, clock, timeoutMs,
      prefix: requestIdPrefix, sequence: 0n, epoch: BigInt(initialEpoch), status: 'new', contract: null, surface: null, active: null, accepted: null,
      inputEnabled: false, inertBorrow: null, invalidated: false, closing: false, busy: null, records: [], retainedBytes: 0, cleanupErrors: [], shutdown: null,
      liveVersion, businessSequence: 0n, retiredThrough: 0n, exchanges: new Set(), exchangeBytes: 0, consumption: null }
    clients.set(this, state)
    state.surface = createSurface({ baseCss: DOM_BASE_CSS, ...surfaceOptions, document, mount, contract: DOM_LIVE_PATCH_CONTRACT,
      authorizePermit: context => this.#authorizePermit(context), authorizeAck: context => this.#authorizeAck(context) })
  }
  get state() { return clients.get(this).status }
  get contract() { return clients.get(this).contract }
  get surface() { return clients.get(this).surface }
  get accepted() { return clients.get(this).accepted }
  get inputEnabled() {
    const state = clients.get(this)
    if (state.inputEnabled) {
      try { if (!syncFence(state)) freezeNative(state) }
      catch (error) { freezeNative(state); throw error }
    }
    return state.inputEnabled
  }
  get pendingRequest() { const state = clients.get(this); return state.status === 'uncertain' ? state.active?.request?.envelope ?? null : null }
  get pendingConsumption() { return clients.get(this).consumption?.envelope ?? null }
  get requests() { return Object.freeze(clients.get(this).records.map(record => record.envelope)) }
  get cleanupErrors() { return [...clients.get(this).cleanupErrors] }
  get retention() {
    const state = clients.get(this)
    return Object.freeze({ requests: state.records.filter(record => record.op !== 'view.live.enable').length,
      bytes: state.retainedBytes + (state.liveVersion === '2.1' ? state.exchangeBytes + (state.consumption?.bytes ?? 0) + (state.consumption?.exchangeBytes ?? 0) : 0),
      inFlightExchanges: state.exchanges.size, consumedThrough: String(state.retiredThrough) })
  }
  #exclusive(operation) {
    const state = clients.get(this)
    if (state.busy) return Promise.reject(problem('ERR_PROTOCOL_VERSION', 'one live session operation may be in flight'))
    const work = Promise.resolve().then(operation); state.busy = work
    work.then(() => { state.busy = null; this.#maybeClose() }, () => { state.busy = null; this.#maybeClose() })
    return work
  }
  #record(op, payload, attempt) {
    const state = clients.get(this), retained = state.liveVersion === '2.1' && op !== 'view.live.enable'
    if (state.consumption) throw problem('ERR_UNCERTAIN', 'live transaction consumption must settle before new business requests')
    const sequence = retained ? state.businessSequence + 1n : state.sequence + 1n
    if (sequence > 18446744073709551615n) throw problem('ERR_RENDER', 'live transaction sequence exhausted; replace this owner')
    const laneId = state.contract?.transactionRetention?.laneId
    const envelope = freeze(copy({ protocolVersion: '1.0', sessionId: state.sessionId,
      requestId: `live:${retained ? laneId : state.prefix}:${sequence}`, kind: 'request', op,
      payload: retained ? { ...payload, transaction: { laneId, sequence: String(sequence) } } : payload }))
    const bytes = size(envelope)
    const maximum = state.contract?.maxRetainedBytes ?? 8 * 1024 * 1024
    if (state.records.length >= (state.contract?.maxRetainedRequests ?? 32) + 1 || this.retention.requests >= (state.contract?.maxRetainedRequests ?? 32)
      || bytes > maximum - state.retainedBytes - (state.liveVersion === '2.1' ? state.exchangeBytes : 0)) throw problem('ERR_RENDER', 'live transaction retention budget exhausted; replace this presentation owner')
    if (retained) state.businessSequence = sequence; else state.sequence = sequence
    const record = { op, envelope, attempt, sequence: retained ? sequence : null, firstSent: null, final: null, batch: null, delivered: false,
      uncertain: false, callbackFailure: null, failure: null, bytes, inFlight: 0, receipt: null, compacted: false }
    state.records.push(record); state.retainedBytes += bytes; attempt.request = record
    return record
  }
  #authorizePermit({ candidate, key: target, baseKey, permit: authority }) {
    const state = clients.get(this), attempt = state.active, source = attempt?.submission
    return !!(source && attempt.candidate === candidate && attempt.permit === authority && same(target, source.key)
      && same(baseKey, attempt.localBaseKey) && same(candidate.baseKey, attempt.localBaseKey)
      && same(authority.key, source.key) && same(authority.baseKey, source.baseKey) && authority.documentToken === source.documentToken
      && authority.inputLifetimeRevision === state.contract.inputLifetimeRevision && state.clock() < attempt.deadline && syncFence(state))
  }
  #authorizeAck({ candidate, permit: authority, receipt, ack }) {
    const state = clients.get(this), attempt = state.active, request = attempt?.presented
    // A final proves publication even when its owner/deadline has since retired.
    // The current fence controls input below; it cannot revoke that proof.
    return !!(attempt?.committed && attempt.ack === ack && candidate === attempt.candidate && authority === attempt.permit
      && receipt === attempt.receipt && request === attempt.request && (request.publicationFinal ?? request.final) === ack && request.sentWithFence === true
      && request.envelope.payload.geometry.epoch === attempt.epoch && decimal(attempt.epoch)
      && same(request.envelope.payload.permit, authority) && same(candidate.key, attempt.submission.key)
      && same(candidate.baseKey, attempt.localBaseKey) && same(ack.key, candidate.key)
      && request.envelope.payload.inputLifetimeRevision === state.contract.inputLifetimeRevision)
  }
  #accept(record, final) {
    const state = clients.get(this), attempt = record.attempt
    const result = final.ok === true ? final : final.originalResult ?? final
    if (final.committed !== true && result?.committed !== true) return false
    if (record !== attempt.presented || !attempt.candidate || !attempt.permit || !attempt.receipt || !record.sentWithFence
      || final.committed !== true || !same(final.key, attempt.submission.key) || result.committed !== true
      || (final.ok === true || final.originalResult !== undefined) && result.ok !== true
      || !same(result.key, attempt.submission.key) || typeof result.inputEnabled !== 'boolean') invalid('live committed final does not identify the original presented attempt')
    if (attempt.committed) return true
    attempt.committed = true; attempt.ack = final; record.publicationFinal = final
    freezeNative(state)
    state.accepted = freeze({ key: copy(attempt.submission.key), epoch: attempt.epoch, documentToken: attempt.submission.documentToken,
      inputLifetimeRevision: attempt.submission.inputLifetimeRevision, nativeEditing: false })
    // Mark accepted before surface cleanup or embedding callbacks can execute.
    try { attempt.candidate.acknowledge(final) } catch (error) { attempt.acceptanceFailure = error; cleanupDiagnostic(state, error) }
    // In 2.1 a pre-seal observation can prove irreversible publication while
    // its error is not yet the original retained final. Only a verified sealed
    // final below may make that remote error terminal.
    if (final.ok !== true && record.sequence === null) attempt.acceptanceFailure ??= remoteError(final)
    attempt.runtimeInputEnabled = result.inputEnabled
    return true
  }
  #capture(record, incoming) {
    const state = clients.get(this)
    if (record.compacted) invalid('a compacted live transaction cannot receive another observer')
    if (!object(incoming) || !Array.isArray(incoming.messages)) invalid('live dispatch must return a complete BridgeBatch')
    const batch = freeze(copy(incoming)), finals = batch.messages.filter(message => object(message) && message.kind === 'response'
      && message.sessionId === record.envelope.sessionId && message.requestId === record.envelope.requestId && message.op === record.op)
    if (finals.length !== 1 || finals[0].protocolVersion !== '1.0' || !object(finals[0].payload)
      || typeof finals[0].payload.ok !== 'boolean' || batch.messages.some(message => !object(message) || message.protocolVersion !== '1.0'
        || message.sessionId !== state.sessionId || typeof message.requestId !== 'string' || typeof message.op !== 'string'
        || !['response', 'event', 'effect', 'diagnostic'].includes(message.kind)
        || message.kind === 'response' && message !== finals[0])) invalid('live batch has no unique correlated final')
    const final = finals[0].payload
    if (final.ok === false && (!object(final.error) || typeof final.error.message !== 'string' || typeof final.error.code !== 'string')) invalid('live error final is malformed')
    // Accept publication before any budget failure, callback, close or fence.
    if (record.op === 'view.live.presented') this.#accept(record, final)
    // These observations can precede cache lookup/sealing. They are not the
    // retained original final and must not poison later exact recovery.
    if (final.ok === false && pendingError(final)) {
      if (record.final) return record.final
      const error = problem('ERR_UNCERTAIN', 'live original final remains indeterminate')
      error.unsealed = record.sequence !== null; throw error
    }
    if (record.sequence !== null && (typeof final.consumptionReceipt !== 'string' || !final.consumptionReceipt
      || size(final.consumptionReceipt) > 4096)) {
      if (record.final) return record.final
      const error = problem('ERR_UNCERTAIN', 'live original final has no sealed consumption receipt')
      error.unsealed = true; throw error
    }
    if (record.final && !same(record.final, final)) {
      if (record.attempt.committed) return record.final
      invalid('replay did not return the original live final')
    }
    // A transport may append passive owner observations after the sealed turn.
    // Retain and deliver the first validated complete batch only; the opaque
    // receipt and exact correlated final remain the consumption authority.
    if (!record.batch) {
      const bytes = size(batch)
      if (bytes > (state.contract?.maxRetainedBytes ?? 8 * 1024 * 1024) - state.retainedBytes - (state.liveVersion === '2.1' ? state.exchangeBytes : 0)) {
        const error = problem('ERR_RENDER', 'live final retention budget exhausted; replace this presentation owner')
        if (record.attempt.committed) {
          record.attempt.acceptanceFailure ??= error
          if (record.sequence === null) { record.final = final; return final }
          error.unsealed = true
        }
        throw error
      }
      record.batch = batch; record.final = final; record.receipt = final.consumptionReceipt ?? null
      record.bytes += bytes; state.retainedBytes += bytes
      if (record.attempt.committed) {
        record.attempt.runtimeInputEnabled = (final.originalResult ?? final).inputEnabled
        if (final.ok !== true) record.attempt.acceptanceFailure ??= remoteError(final)
      }
    }
    return record.final
  }
  #beginExchange(record, metadata = false) {
    const state = clients.get(this), bytes = size(record.envelope) + EXCHANGE_METADATA_BYTES
    const current = state.liveVersion === '2.1'
    if (state.exchanges.size >= MAX_EXCHANGES) throw problem('ERR_UNCERTAIN', 'live actual transport settlement budget exhausted')
    if (current && (metadata ? bytes > MAX_CONSUMPTION_BYTES - record.bytes - record.exchangeBytes
      : bytes > (state.contract?.maxRetainedBytes ?? 8 * 1024 * 1024) - state.retainedBytes - state.exchangeBytes)) {
      throw problem('ERR_UNCERTAIN', 'live actual transport byte budget exhausted')
    }
    const job = { bytes, record, metadata }
    state.exchanges.add(job); record.inFlight++
    if (metadata) record.exchangeBytes += bytes; else state.exchangeBytes += bytes
    return job
  }
  #endExchange(job) {
    const state = clients.get(this)
    if (!state.exchanges.delete(job)) return
    job.record.inFlight--
    if (job.metadata) job.record.exchangeBytes -= job.bytes; else state.exchangeBytes -= job.bytes
    this.#compactConsumption(); this.#maybeClose()
  }
  async #exchange(record) {
    const state = clients.get(this)
    let timer
    // The original settlement observer remains live after a local timeout. A
    // late committed final still claims ACK; it never triggers a rollback.
    let job
    try { job = this.#beginExchange(record) } catch (error) {
      record.uncertain = true; state.status = 'uncertain'; freezeNative(state); throw error
    }
    if (record.firstSent === null) record.firstSent = state.clock()
    const original = Promise.resolve().then(() => state.dispatchEnvelope(record.envelope)).then(batch => this.#capture(record, batch)).finally(() => this.#endExchange(job))
    original.catch(() => {})
    try {
      const final = await Promise.race([original, new Promise((_, reject) => { timer = setTimeout(() => reject(problem('ERR_UNCERTAIN', 'live final was not observed before the local deadline')), state.timeoutMs) })])
      if (final.ok === false && pendingError(final) && !record.attempt.committed) throw problem('ERR_UNCERTAIN', 'live original final remains indeterminate')
      return final
    } catch (error) {
      if (record.attempt.committed && !error.unsealed) return record.final ?? record.publicationFinal
      record.uncertain = true; state.status = 'uncertain'; freezeNative(state)
      const uncertain = problem('ERR_UNCERTAIN', `live final is uncertain: ${error.message}`)
      uncertain.cause = error; uncertain.originalEnvelope = record.envelope; throw uncertain
    } finally { clearTimeout(timer) }
  }
  #deliver(record) {
    if (record.delivered || !record.batch) return
    record.delivered = true
    try {
      const result = clients.get(this).onBatch(record.batch)
      if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); invalid('live batch delivery must be synchronous') }
    } catch (error) { record.callbackFailure = error; cleanupDiagnostic(clients.get(this), error); throw error }
  }
  negotiate() {
    return this.#exclusive(async () => {
      const state = clients.get(this)
      if (state.closing || state.invalidated || state.status !== 'new') throw cancelled('live negotiation requires a fresh owner')
      state.status = 'negotiating'; const attempt = { phase: 'enable', request: null }; state.active = attempt
      this.#record('view.live.enable', { version: state.liveVersion }, attempt)
      return this.#resume(attempt)
    })
  }
  prepareAndPresent({ render, surfaceGeneration } = {}) {
    return this.#exclusive(async () => {
      const state = clients.get(this)
      if (state.consumption) throw problem('ERR_UNCERTAIN', 'live transaction consumption must settle before a new presentation')
      if (!state.contract || state.status !== 'ready' || !syncFence(state)) throw cancelled('live presentation requires explicit negotiation and a current ready owner')
      if (!decimal(surfaceGeneration)) invalid('live surface generation must be a canonical u64 string')
      if (this.retention.requests + 4 > state.contract.maxRetainedRequests) throw problem('ERR_RENDER', 'live transaction retention budget exhausted; replace this presentation owner')
      freezeNative(state); state.status = 'preparing'
      const attempt = { phase: 'prepare', surfaceGeneration, request: null, controller: new AbortController(), candidate: null, plan: null,
        submission: null, permit: null, committed: false, failure: null, localBaseKey: state.surface.current?.key ?? null,
        previousAccepted: state.accepted, previousSurface: state.surface.current }
      state.active = attempt
      try { this.#record('view.live.prepare', { version: state.liveVersion, inputLifetimeRevision: state.contract.inputLifetimeRevision, surfaceGeneration, render }, attempt) }
      catch (error) { state.active = null; state.status = 'ready'; throw error }
      return this.#resume(attempt)
    })
  }
  recoverOriginalFinal() {
    return this.#exclusive(async () => {
      const state = clients.get(this), attempt = state.active
      if (state.status !== 'uncertain' || !attempt?.request) throw cancelled('no uncertain live original final to recover')
      // Never manufacture a replacement request ID, envelope or permit lease.
      state.status = 'recovering'; return this.#resume(attempt)
    })
  }
  /** Reclaim only complete terminal attempts after their actual DOM and
   * transport drains. Consumption is separate idempotent owner metadata; its
   * final is never delivered to the application's onBatch callback.
   */
  consumeCompleted() {
    return this.#exclusive(async () => {
      const state = clients.get(this)
      if (state.liveVersion !== '2.1' || !state.contract) throw problem('ERR_PROTOCOL_VERSION', 'explicit consumption requires negotiated live 2.1')
      if (state.status === 'disposed' || state.shutdown?.started) throw cancelled('disposed live owner cannot consume transactions')
      if (state.consumption) throw problem('ERR_UNCERTAIN', 'recover the original live consumption before another consumption')
      if (state.active || state.unfinalizedCommit) throw problem('ERR_UNCERTAIN', 'live attempt must reach its actual terminal cleanup before consumption')
      const records = state.records.filter(record => record.sequence !== null)
      if (!records.length) return freeze({ ok: true, consumedThrough: String(state.retiredThrough) })
      const selected = []
      let through = state.retiredThrough, envelope
      const laneId = state.contract.transactionRetention.laneId
      for (let index = 0; index < records.length;) {
        const attempt = records[index].attempt, group = []
        while (index < records.length && records[index].attempt === attempt) group.push(records[index++])
        if (!attempt.finished || !attempt.cleanupSettled || group.some(record => record.inFlight || !record.final || !record.batch || !record.delivered || !record.receipt)) break
        if (group[0].sequence !== through + 1n || group.some((record, position) => record.sequence !== through + 1n + BigInt(position))) invalid('live consumption prefix is not contiguous')
        const combined = [...selected, ...group], last = group.at(-1).sequence
        const candidate = freeze(copy({ protocolVersion: '1.0', sessionId: state.sessionId, requestId: `live-consume:${laneId}:${last}`,
          kind: 'request', op: 'view.live.consume', payload: { version: '2.1', inputLifetimeRevision: state.contract.inputLifetimeRevision,
            laneId, through: String(last), receipts: combined.map(record => ({ sequence: String(record.sequence), token: record.receipt })) } }))
        if (size(candidate) > MAX_CONSUMPTION_ENVELOPE_BYTES) break
        selected.push(...group); through = last; envelope = candidate
      }
      if (!selected.length) throw problem('ERR_UNCERTAIN', 'live original final, callback delivery, cleanup or actual transport remains unsettled')
      const consumption = { envelope, records: selected, through, bytes: size(envelope) + 4096, exchangeBytes: 0,
        inFlight: 0, final: null, previousStatus: state.status }
      state.consumption = consumption; state.status = 'consuming'
      return this.#exchangeConsumption(consumption)
    })
  }
  recoverConsumption() {
    return this.#exclusive(async () => {
      const state = clients.get(this), consumption = state.consumption
      if (!consumption) throw cancelled('no uncertain live consumption to recover')
      state.status = 'consuming'; return this.#exchangeConsumption(consumption)
    })
  }
  #captureConsumption(consumption, incoming) {
    const state = clients.get(this), request = consumption.envelope
    if (!object(incoming) || !Array.isArray(incoming.messages) || incoming.messages.length !== 1 || size(incoming) > 4096) invalid('live consumption requires one bounded correlated metadata final')
    const batch = freeze(copy(incoming)), message = batch.messages[0], final = message?.payload
    if (!object(message) || message.protocolVersion !== '1.0' || message.kind !== 'response' || message.sessionId !== state.sessionId
      || message.requestId !== request.requestId || message.op !== request.op) invalid('live consumption final does not identify its exact metadata request')
    exact(final, ['ok', 'consumedThrough'], 'live consumption final')
    if (final.ok !== true || final.consumedThrough !== String(consumption.through)) invalid('live consumption did not acknowledge its exact prefix')
    if (consumption.final && !same(consumption.final, final)) invalid('live consumption replay changed its final')
    consumption.final ??= final
    return consumption.final
  }
  async #exchangeConsumption(consumption) {
    const state = clients.get(this)
    let timer, job
    try {
      job = this.#beginExchange(consumption, true)
      const original = Promise.resolve().then(() => state.dispatchEnvelope(consumption.envelope))
        .then(batch => this.#captureConsumption(consumption, batch)).finally(() => this.#endExchange(job))
      original.catch(() => {})
      return await Promise.race([original, new Promise((_, reject) => {
        timer = setTimeout(() => reject(problem('ERR_UNCERTAIN', 'live consumption final was not observed before the local deadline')), state.timeoutMs)
      })])
    } catch (cause) {
      if (consumption.final) return consumption.final
      state.status = 'consumption-uncertain'
      const error = problem('ERR_UNCERTAIN', `live consumption is uncertain: ${cause.message}`)
      error.originalEnvelope = consumption.envelope; error.cause = cause; throw error
    } finally { clearTimeout(timer) }
  }
  #compactConsumption() {
    const state = clients.get(this), consumption = state.consumption
    if (!consumption?.final || consumption.inFlight || consumption.records.some(record => record.inFlight)) return
    const consumed = new Set(consumption.records)
    for (const record of consumption.records) {
      record.compacted = true; state.retainedBytes -= record.bytes
    }
    state.records = state.records.filter(record => !consumed.has(record))
    state.retiredThrough = consumption.through; state.consumption = null
    state.status = consumption.previousStatus
  }
  async #resume(attempt) {
    const state = clients.get(this)
    try {
      if (attempt.phase === 'enable') {
        const final = await this.#exchange(attempt.request)
        if (final.ok !== true) { this.#deliver(attempt.request); state.status = 'new'; state.active = null; throw remoteError(final) }
        try { state.contract = contract(final.contract, state.liveVersion) } catch (error) { return this.#unknown(attempt, error) }
        this.#deliver(attempt.request); attempt.finished = true; attempt.cleanupSettled = true
        state.status = 'ready'; state.active = null; return state.contract
      }
      while (true) {
        if (attempt.phase === 'prepare') {
          const final = await this.#exchange(attempt.request)
          if (final.ok !== true) { this.#deliver(attempt.request); throw remoteError(final) }
          try { attempt.submission = submission(state, attempt, final.submission) } catch (error) { return this.#unknown(attempt, error) }
          attempt.phase = 'plan'; this.#deliver(attempt.request)
        }
        if (attempt.phase === 'plan') {
          if (!syncFence(state)) throw cancelled('live owner retired before DOM preparation')
          const window = state.document.defaultView
          attempt.plan = await state.prepareDocument(attempt.submission.document, attempt.submission.viewport, {
            resolveResource: state.resolveResource, signal: attempt.controller.signal, presentationKey: attempt.submission.key,
            supports: (property, value) => window?.CSS?.supports(property, value) === true,
            validateSelector: selector => { if (typeof state.document.querySelector !== 'function') invalid('native selector validation is required'); state.document.querySelector(selector) } })
          if (!syncFence(state)) throw cancelled('live owner retired during DOM preparation')
          attempt.candidate = state.surface.prepare(attempt.plan, { presentationKey: attempt.submission.key,
            runtimeIdentities: new Map(Object.entries(attempt.submission.runtimeIdentities)) })
          if (!same(attempt.candidate.key, attempt.submission.key) || !same(attempt.candidate.baseKey, attempt.localBaseKey)) invalid('live surface prepared a different candidate or physical base')
          attempt.phase = 'permit'
          this.#record('view.live.permit', { version: state.liveVersion, inputLifetimeRevision: state.contract.inputLifetimeRevision,
            key: attempt.submission.key, baseKey: attempt.submission.baseKey, documentToken: attempt.submission.documentToken }, attempt)
        }
        if (attempt.phase === 'permit') {
          const final = await this.#exchange(attempt.request)
          if (final.ok !== true) { this.#deliver(attempt.request); throw remoteError(final) }
          try { attempt.permit = permit(state, attempt, final.permit) } catch (error) { return this.#unknown(attempt, error) }
          attempt.deadline = attempt.request.firstSent + attempt.permit.ttlMs; attempt.phase = 'apply'; this.#deliver(attempt.request)
        }
        if (attempt.phase === 'apply') {
          if (!this.#authorizePermit({ candidate: attempt.candidate, key: attempt.candidate.key, baseKey: attempt.candidate.baseKey, permit: attempt.permit })) throw cancelled('live permit expired or owner retired before apply')
          attempt.receipt = attempt.candidate.apply(attempt.permit)
          const remaining = Math.max(0, attempt.deadline - state.clock())
          const timer = setTimeout(() => attempt.controller.abort(cancelled('live permit expired during readiness')), remaining)
          try {
            const ready = Promise.resolve().then(() => state.waitForReady({ document: state.document, surface: state.surface,
              candidate: attempt.candidate, plan: attempt.plan, signal: attempt.controller.signal }))
            attempt.candidate.retainUntil(ready.then(() => {}, () => {}))
            await abortable(ready, attempt.controller.signal)
          } finally { clearTimeout(timer) }
          if (!this.#authorizePermit({ candidate: attempt.candidate, key: attempt.candidate.key, baseKey: attempt.candidate.baseKey, permit: attempt.permit })) throw cancelled('live permit expired or owner retired before presentation')
          const measured = geometry(state, attempt, attempt.candidate.measure())
          attempt.phase = 'presented'
          attempt.presented = this.#record('view.live.presented', { version: state.liveVersion, inputLifetimeRevision: state.contract.inputLifetimeRevision,
            permit: attempt.permit, geometry: measured }, attempt)
          attempt.presented.sentWithFence = true
        }
        if (attempt.phase === 'presented') {
          const final = await this.#exchange(attempt.request)
          if (!attempt.committed) {
            if (final.ok === true) return this.#unknown(attempt, problem('ERR_PROTOCOL_VERSION', 'live presented success is missing its committed ACK'))
            this.#deliver(attempt.request); throw remoteError(final)
          }
          return await this.#finishAccepted(attempt)
        }
        if (attempt.phase === 'abort') {
          const final = await this.#exchange(attempt.request)
          if (final.ok === true && (!same(final.key, attempt.submission.key) || typeof final.inputEnabled !== 'boolean')) return this.#unknown(attempt, problem('ERR_PROTOCOL_VERSION', 'live abort final does not identify its original attempt'))
          if (final.ok === true && final.inputEnabled === true && decimal(final.inputLifetimeRevision)
            && same(final.restoredKey, attempt.previousAccepted?.key)
            && final.inputLifetimeRevision === attempt.previousAccepted?.inputLifetimeRevision) attempt.restoration = final
          try { this.#deliver(attempt.request) } catch (error) { attempt.failure.cleanupErrors = [...(attempt.failure.cleanupErrors ?? []), error] }
          return await this.#finishRejected(attempt)
        }
      }
    } catch (error) {
      if (state.status === 'uncertain') throw error
      if (attempt.committed) {
        if (attempt.finished) throw error
        return this.#finishAccepted(attempt, error)
      }
      if (attempt.phase === 'enable') { attempt.finished = true; attempt.cleanupSettled = true; state.active = null; state.status = state.contract ? 'faulted' : 'new'; throw error }
      if (attempt.phase === 'abort') throw error
      attempt.failure = error; freezeNative(state); attempt.controller.abort(error)
      if (attempt.submission) {
        try {
          this.#record('view.live.abort', { version: state.liveVersion, inputLifetimeRevision: state.contract.inputLifetimeRevision,
            key: attempt.submission.key, documentToken: attempt.submission.documentToken }, attempt)
          attempt.phase = 'abort'
        } catch (failure) {
          // Nothing was dispatched. Every preceding final is known and this
          // attempt never published; local rollback is safe, but the stranded
          // runtime candidate requires a replacement owner. It is not a lost
          // abort final and must not replay a different operation as abort.
          attempt.ownerReplacementRequired = true; attempt.failure.requiresOwnerReplacement = true
          attempt.failure.cleanupErrors = [...(attempt.failure.cleanupErrors ?? []), failure]
          return this.#finishRejected(attempt)
        }
        return this.#resume(attempt)
      }
      return this.#finishRejected(attempt)
    }
  }
  #unknown(attempt, cause) {
    const state = clients.get(this); state.status = 'uncertain'; attempt.request.uncertain = true; freezeNative(state)
    const error = problem('ERR_UNCERTAIN', `live original final cannot be verified: ${cause.message}`)
    error.cause = cause; error.originalEnvelope = attempt.request.envelope; throw error
  }
  async #finishAccepted(attempt, extra) {
    const state = clients.get(this); freezeNative(state)
    let failure = attempt.acceptanceFailure ?? extra
    try { this.#deliver(attempt.presented) } catch (error) { failure ??= error }
    // A cleanup failure, owner change or closing request cannot undo this ACK.
    try { await attempt.candidate.drainAsync(); attempt.cleanupSettled = true } catch (error) { cleanupDiagnostic(state, error); failure ??= error }
    // If an injected/broken surface failed to claim its own irreversible ACK,
    // shutdown must not call its rollback-producing disposal path.
    state.unfinalizedCommit = attempt.candidate.state === 'acknowledged' ? null : attempt
    state.active = null; attempt.finished = true
    if (!failure && attempt.runtimeInputEnabled) {
      try { enableNativeInput(state) }
      catch (error) { failure = error }
    }
    state.status = failure ? 'faulted' : 'ready'
    const outcome = freeze({ status: failure ? 'accepted-with-error' : 'presented', committed: true, key: copy(attempt.submission.key),
      epoch: attempt.epoch, inputEnabled: state.inputEnabled, nativeEditing: false, cleanupPending: !!state.unfinalizedCommit })
    if (failure) { failure.committed = true; failure.outcome = outcome; throw failure }
    return outcome
  }
  async #finishRejected(attempt) {
    const state = clients.get(this), error = attempt.failure ?? cancelled('live transaction rejected'), errors = []
    if (attempt.candidate) {
      try { attempt.candidate.rollback() } catch (failure) { errors.push(failure) }
      try { await attempt.candidate.disposeAsync() } catch (failure) { errors.push(failure) }
    } else if (attempt.plan) {
      try { const result = await (attempt.plan.disposeAsync?.() ?? attempt.plan.dispose()); if (Array.isArray(result)) errors.push(...result) } catch (failure) { errors.push(failure) }
    }
    if (error.cleanupDrain) {
      try { const result = await error.cleanupDrain; if (Array.isArray(result)) errors.push(...result) } catch (failure) { errors.push(failure) }
    }
    for (const failure of errors) cleanupDiagnostic(state, failure)
    attempt.finished = true; attempt.cleanupSettled = errors.length === 0
    state.active = null; state.status = errors.length || attempt.ownerReplacementRequired ? 'faulted' : 'ready'
    // Only the native exact abort can renew the retained base. Local journal
    // rollback and a successful resource drain do not grant input authority.
    const previous = attempt.previousAccepted
    const restoredOwnerCurrent = () => attempt.restoration && !errors.length && !error.cleanupErrors?.length && !attempt.ownerReplacementRequired
      && previous && state.accepted === previous && state.surface.current === attempt.previousSurface
      && !state.surface.pending && same(state.surface.current?.key, previous.key)
      && state.surface.current?.state === 'acknowledged' && state.surface.root?.isConnected !== false
      && previous.key.surfaceGeneration === attempt.surfaceGeneration
      && previous.inputLifetimeRevision === state.contract.inputLifetimeRevision
    if (restoredOwnerCurrent()) {
      try { enableNativeInput(state, restoredOwnerCurrent) }
      catch (failure) { freezeNative(state); errors.push(failure); cleanupDiagnostic(state, failure) }
    }
    if (errors.length) { attempt.cleanupSettled = false; state.status = 'faulted' }
    error.cleanupErrors = [...(error.cleanupErrors ?? []), ...errors]; throw error
  }
  /** Embedding owner calls this on lifetime/fence retirement. This immediately
   * freezes native and business input, but never resolves an unknown final.
   */
  invalidate(reason = 'live owner retired') {
    const state = clients.get(this)
    if (state.status === 'disposed') return
    state.invalidated = true; freezeNative(state)
    state.active?.controller?.abort(cancelled(reason))
  }
  disposeAsync() {
    const state = clients.get(this)
    if (state.shutdown) return state.shutdown.promise
    state.closing = true; freezeNative(state); state.active?.controller?.abort(cancelled('live session is closing'))
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    state.shutdown = { promise, resolve, reject, started: false }; promise.catch(() => {}); this.#maybeClose(); return promise
  }
  #maybeClose() {
    const state = clients.get(this), shutdown = state.shutdown
    // Disposing an uncertain surface would roll back potentially published DOM.
    // Keep the real shutdown drain pending until exact final recovery resolves.
    if (!shutdown || shutdown.started || state.busy || state.active || state.unfinalizedCommit || state.exchanges.size || state.consumption) return
    shutdown.started = true
    Promise.resolve().then(() => state.surface.disposeAsync()).then(result => {
      releaseInert(state); state.status = 'disposed'; shutdown.resolve(result)
    }, error => {
      cleanupDiagnostic(state, error)
      if (state.surface.root?.isConnected === false) releaseInert(state)
      state.status = 'disposed'; shutdown.reject(error)
    })
  }
}
