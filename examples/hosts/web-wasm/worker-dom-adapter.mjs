import { copyConsumedSample, sameConsumedSample } from './dom-animation-sample.mjs'
import { DomViewError, DomViewPresenter, validateDomPresentationKey } from './dom-presenter.mjs'
import { DomSessionClient } from './dom-session-client.mjs'
import { WorkerBridgeTransport } from './worker-bridge-transport.mjs'
import { WORKER_RPC_VERSION, measureWorkerPayload } from './worker-session-client.mjs'
import { copyWorkerPresenterObservation, copyWorkerPresenterAttachment } from './worker-runtime.mjs'
import { routeStyleIds } from './render-inputs.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 20 && BigInt(value) <= 18446744073709551615n
const positive = value => decimal(value) && value !== '0'
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const error = (code, message) => new DomViewError(code, message)
const invalid = message => error('ERR_PROTOCOL_VERSION', message)
const cancelled = message => Object.assign(error('ERR_CANCELLED', message), { localCancellation: true })
const ownerFields = ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend']
const keyFields = ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']
const sameOwner = (a, b) => record(a) && record(b) && ownerFields.every(field => a[field] === b[field]) && a.presenterGeneration === b.presenterGeneration
const sameKey = (a, b) => record(a) && record(b) && keyFields.every(field => a[field] === b[field])
const sameViewport = (a, b) => record(a) && record(b) && ['x', 'y', 'width', 'height'].every(field => a[field] === b[field])
const sameInput = (a, b) => record(a) && record(b) && a.pageId === b.pageId && a.routePath === b.routePath && a.templateRevision === b.templateRevision && sameViewport(a.viewport, b.viewport)
const sameProof = (a, b) => record(a) && record(b) && a.version === '1.0' && b.version === '1.0' && a.attemptId === b.attemptId
  && sameOwner(a.owner, b.owner) && a.surfaceGeneration === b.surfaceGeneration && a.publication?.kind === 'browser-view'
  && b.publication?.kind === 'browser-view' && sameKey(a.publication.key, b.publication.key) && sameInput(a.consumedInput, b.consumedInput)
  && (a.consumedSample === undefined && b.consumedSample === undefined || sameConsumedSample(a.consumedSample, b.consumedSample))
const hardKey = state => JSON.stringify([state.currentPage?.pageId ?? null, state.currentPage?.path ?? null,
  state.viewport.x, state.viewport.y, state.viewport.width, state.viewport.height,
  state.rendererProfile, state.lifecycle, state.surfaceGeneration, state.inputLifetimeRevision])
const freeze = (value, seen = new WeakSet()) => {
  if (value && typeof value === 'object' && !seen.has(value)) { seen.add(value); for (const child of Object.values(value)) freeze(child, seen); Object.freeze(value) }
  return value
}
const plain = value => { measureWorkerPayload(value); return freeze(structuredClone(value)) }
const aggregate = (message, failures) => Object.assign(error('ERR_RENDER', message), { cleanupErrors: [...new Set(failures)] })
const candidates = new WeakMap()
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** One phased DOM scheduler adapter over a borrowed, already loaded Worker.
 * Owns presenter/bridge/object URLs, never closes or terminates the borrowed RPC.
 * The owner forwards onEvent to receiveEvent promptly and observes .observation.
 */
export class WorkerDomAdapter {
  #acceptedProof = null

  constructor({ rpc, loadResult, attachment, container, presenter, bridge, timeoutMs = 5000,
    onObservation, onBatch, onDiagnostic,
    crypto = globalThis.crypto,
    createObjectURL = value => URL.createObjectURL(value),
    revokeObjectURL = value => URL.revokeObjectURL(value),
    maxResourceBytes = 64 * 1024 * 1024, maxResourceCount = 1024 } = {}) {
    measureWorkerPayload(loadResult)
    const attached = attachment === undefined ? null : copyWorkerPresenterAttachment(attachment, loadResult)
    let sourceOwner
    if (attached) {
      sourceOwner = attached.owner
      if (!rpc || typeof rpc.requestHost !== 'function' || rpc.actualFinalContract !== '1.0'
        || sourceOwner.workerEpoch !== rpc.workerEpoch || sourceOwner.sessionId !== rpc.sessionId
        || sourceOwner.transportBackend !== 'browser-view' || loadResult.capabilities?.quickjs !== true) throw invalid('DOM attachment requires the original Worker and committed DOM binding')
    } else {
      const contract = loadResult?.observationContract
      if (!rpc || typeof rpc.requestHost !== 'function' || !record(contract)
        || Object.keys(contract).length !== 4 || contract.version !== '1.0' || contract.sequence !== 'u64'
        || contract.surfaceGeneration !== '1.0' || contract.inputLifetime !== '1.0'
        || loadResult.transportBackend !== 'browser-view' || loadResult.renderer !== 'browser-view'
        || loadResult.capabilities?.quickjs !== true) throw invalid('Worker DOM adapter requires a real negotiated browser-view/QuickJS load result')
      sourceOwner = loadResult.observation?.state?.owner
      if (!record(sourceOwner) || sourceOwner.workerEpoch !== rpc.workerEpoch || sourceOwner.sessionId !== rpc.sessionId
        || sourceOwner.transportBackend !== 'browser-view' || !sha(sourceOwner.packSha256)
        || loadResult.pack?.indexSha256 !== sourceOwner.packSha256) throw invalid('Worker load owner/verified pack does not match the borrowed RPC')
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000
      || !Number.isSafeInteger(maxResourceBytes) || maxResourceBytes < 1 || maxResourceBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(maxResourceCount) || maxResourceCount < 1 || maxResourceCount > 1024
      || [onObservation, onBatch, onDiagnostic].some(callback => callback !== undefined && typeof callback !== 'function')
      || typeof crypto?.subtle?.digest !== 'function' || typeof createObjectURL !== 'function' || typeof revokeObjectURL !== 'function') throw invalid('invalid finite DOM adapter resource/deadline configuration')
    const manifest = plain(loadResult.manifest)
    if (!record(manifest?.app) || !Array.isArray(manifest.routes) || !Array.isArray(manifest.styles)) throw invalid('Worker DOM adapter requires the verified portable route/style graph')
    Object.defineProperty(this, 'owner', { value: Object.freeze(Object.fromEntries([...ownerFields, ...(attached ? ['presenterGeneration'] : [])].map(field => [field, sourceOwner[field]]))), enumerable: true })
    this.rpc = rpc; this.manifest = manifest; this.timeoutMs = timeoutMs
    this.onObservation = onObservation; this.onBatch = onBatch; this.onDiagnostic = onDiagnostic
    this.crypto = crypto; this.createObjectURL = createObjectURL; this.revokeObjectURL = revokeObjectURL
    this.maxResourceBytes = maxResourceBytes; this.maxResourceCount = maxResourceCount
    this.resources = new Set(); this.resourceBytes = 0; this.resourceFailures = []
    this.active = null; this.latest = copyWorkerPresenterObservation(attached?.observation ?? loadResult.observation, this.owner)
    if (this.latest.state.rendererProfile !== 'webview' || this.latest.state.requiresRestart) throw invalid('loaded Worker is not a live DOM profile owner')
    this.stopping = false; this.closed = false; this.faulted = false; this.frameSequence = 0
    this.cancelPromise = null; this.closePromise = null; this.eventSequence = 0n
    this.authorityRevision = 0n; this.ownerFenceRevision = '0'; this.ownerFenceBlocked = false
    candidates.set(this, new WeakMap())
    if (bridge !== undefined && (bridge.rpc !== rpc || bridge.sessionId !== this.owner.sessionId
      || bridge.workerEpoch !== this.owner.workerEpoch || bridge.closed || !bridge.connected
      || !['request', 'setSession', 'receiveBatch', 'dispose'].every(method => typeof bridge[method] === 'function'))) throw invalid('borrowed bridge must be the open unique bridge over the supplied observed RPC owner')
    this.presenter = presenter ?? new DomViewPresenter(container, { timeoutMs, onError: failure => this.report(failure) })
    if (this.presenter.current || this.presenter.pending || this.presenter.transaction) throw invalid('Worker adapter requires exclusive ownership of an idle DOM presenter')
    // Strict release 1.0 predates durable input guards. A presenter may honor
    // that generic contract while ignoring confirmAsync's optional inputGuard.
    // Negotiate the Worker owner's stronger input fence before wiring callbacks
    // or creating an owned transport; never infer support from an argument.
    if (typeof this.presenter.inputGuardContract !== 'function') throw invalid('Worker DOM presenter must negotiate durable synchronous input guards')
    const inputContract = this.presenter.inputGuardContract(), inputFields = ['version', 'synchronous', 'durable']
    if (!record(inputContract) || Object.keys(inputContract).length !== inputFields.length
      || Object.keys(inputContract).some(field => !inputFields.includes(field)) || inputContract.version !== '1.0'
      || inputContract.synchronous !== true || inputContract.durable !== true) throw invalid('unsupported Worker DOM presenter input guard contract')
    const scopedRpc = { workerEpoch: this.owner.workerEpoch, sessionId: this.owner.sessionId,
      requestHost: (op, payload, options) => this.requestHost(op, payload, options) }
    this.ownsBridge = bridge === undefined
    this.transport = bridge ?? new WorkerBridgeTransport({ rpc: scopedRpc, timeoutMs, onDiagnostic: failure => this.report(failure) })
    // DomSessionClient owns its presenter, never the enclosing session's bridge.
    // Its close must not disconnect a borrowed correlation table before exact
    // candidate aborts and the owner's remaining effects have drained.
    const clientTransport = this.ownsBridge ? this.transport : {
      request: (...args) => this.transport.request(...args),
      setSession: sessionId => this.transport.setSession(sessionId),
    }
    this.client = new DomSessionClient({ presenter: this.presenter, transport: clientTransport, timeoutMs,
      resolveResource: (descriptor, context) => this.resolveResource(descriptor, context),
      inputGate: () => !this.ownerFenceBlocked && !this.stopping && !this.closed && !this.faulted
        && this.latest.state.lifecycle === 'Active' && !this.latest.state.requiresRestart,
      onDiagnostic: failure => this.report(failure) })
    this.client.strictPresenterContract()
    this.advanceAuthority()
  }

  // DomSessionClient.revision is an internal cancellation token. Native
  // surfaceGeneration stays untouched and is never synthesized from this token.
  advanceAuthority() {
    if (this.authorityRevision >= 18446744073709551615n) throw invalid('DOM local authority revision exhausted')
    this.client.updateAuthority({ sessionId: this.owner.sessionId, revision: String(++this.authorityRevision),
      surfaceGeneration: this.latest.state.surfaceGeneration })
  }
  setOwnerInputFence({ revision, blocked } = {}) {
    if (!decimal(revision) || typeof blocked !== 'boolean' || BigInt(revision) < BigInt(this.ownerFenceRevision)
      || revision === this.ownerFenceRevision && blocked && !this.ownerFenceBlocked) throw invalid('DOM owner fence regressed or reused a released revision')
    if (this.closed || this.stopping || this.faulted) throw cancelled('DOM owner cannot change a retired input fence')
    const changed = revision !== this.ownerFenceRevision
    this.ownerFenceRevision = revision; this.ownerFenceBlocked = blocked
    // Publish the local fence before cancellation, presenter or user hooks.
    if (changed) this.advanceAuthority()
    if (blocked) this.freezeInput('owner-metrics')
    return Object.freeze({ version: '1.0', revision, blocked })
  }
  acceptsOwnerInput(key, revision) {
    const accepted = this.client.accepted
    return revision === this.ownerFenceRevision && !this.ownerFenceBlocked && !this.closed && !this.stopping && !this.faulted
      && accepted?.inputEnabled === true && this.client.inputAllowed(accepted.authority, accepted.key) && sameKey(key, accepted.key)
  }
  get observation() { return this.latest }
  get pendingResourceCount() { return this.resources.size }
  get pendingResourceBytes() { return this.resourceBytes }
  report(failure) { try { this.onDiagnostic?.(failure) } catch { /* Diagnostics cannot authorize input or release. */ } }
  notify(callback, value) {
    if (!callback) return
    const result = callback(value)
    if (result && typeof result.then === 'function') { result.catch?.(failure => this.report(failure)); throw invalid('Worker adapter observation/effect notifications must be synchronous') }
  }
  fail(failure) {
    if (!failure || typeof failure !== 'object') failure = Object.assign(error('ERR_RENDER', String(failure)), { cause: failure })
    this.faulted = true
    this.active?.controller.abort(failure)
    try { this.freezeInput('adapter-fault') } catch (cleanup) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup] }
    this.report(failure); return failure
  }
  receiveObservation(value) {
    if (this.closed) return false
    let next
    try { next = copyWorkerPresenterObservation(value, this.owner) } catch (failure) { throw this.fail(failure) }
    if (BigInt(next.sequence) <= BigInt(this.latest.sequence)) return false
    if (BigInt(next.state.surfaceGeneration) < BigInt(this.latest.state.surfaceGeneration)) throw this.fail(invalid('ordered Worker logical generation regressed'))
    const previousLifetime = this.latest.state.inputLifetimeRevision, nextLifetime = next.state.inputLifetimeRevision
    if (previousLifetime === null ? nextLifetime !== null : nextLifetime !== null && BigInt(nextLifetime) < BigInt(previousLifetime)) throw this.fail(invalid('ordered Worker input lifetime regressed'))
    const hardChanged = hardKey(next.state) !== hardKey(this.latest.state)
    this.latest = next
    if (hardChanged) {
      this.active?.controller.abort('Worker DOM hard lifetime changed')
      try { this.freezeInput('hard-observation') } catch (failure) { throw this.fail(failure) }
    }
    // Authority is a hard lifetime token, NOT observation arrival/sequence.
    // Ordinary setData/ready effects must not cancel this scheduler flight.
    if (hardChanged) this.advanceAuthority()
    if (next.state.transitionRequired) this.freezeInput('presenter-transition-pending')
    if (next.state.requiresRestart || next.state.rendererProfile !== 'webview' && !next.state.transitionRequired) this.fail(error('ERR_UNSUPPORTED_CAPABILITY', 'Worker DOM owner requires replacement'))
    if (!this.stopping) try { this.notify(this.onObservation, next) } catch (failure) { throw this.fail(failure) }
    return true
  }
  acceptResult(result) {
    if (!record(result) || result.observation === undefined) throw invalid('negotiated Worker result omitted its original ordered observation')
    this.receiveObservation(result.observation)
    if (Array.isArray(result.messages)) this.deliverBatch(result)
    return result
  }
  deliverBatch(batch) {
    measureWorkerPayload(batch)
    if (!record(batch) || !Array.isArray(batch.messages) || batch.messages.some(message => !record(message)
      || message.protocolVersion !== '1.0' || message.sessionId !== this.owner.sessionId
      || !['response', 'event'].includes(message.kind) || typeof message.requestId !== 'string' || typeof message.op !== 'string')) throw invalid('invalid genuine Worker bridge batch')
    this.receiveQueryBatch(batch)
    this.notify(this.onBatch, batch)
  }
  receiveQueryBatch(batch) { return this.client.receiveQueryBatch(batch) }
  acceptFailure(wire, failure) {
    if (this.closed || !record(wire)) return
    // Preserve the original observation before exposing any irreversible
    // effects. A bad observation still cannot erase a real native batch.
    if (wire.observation !== undefined) try { this.receiveObservation(wire.observation) }
    catch (metadata) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), metadata]; this.fail(metadata) }
    // The enclosing observed RPC owns borrowed-bridge effects. In standalone
    // mode retain evidence only: feeding these finals into active correlation
    // would resolve an inner success before the genuine outer error rejects.
    if (!this.ownsBridge) return
    try {
      measureWorkerPayload(wire)
      const visited = new Set(), batches = new Set(), stack = [{ value: wire, depth: 0 }]
      while (stack.length) {
        const { value, depth } = stack.pop()
        if (!record(value) || visited.has(value) || depth > 8) continue
        visited.add(value)
        if (Array.isArray(value.batch?.messages)) batches.add(value.batch)
        if (Array.isArray(value.committedResult?.messages)) batches.add(value.committedResult)
        for (const field of ['details', 'originalDetails']) if (record(value[field])) stack.push({ value: value[field], depth: depth + 1 })
      }
      if (batches.size) {
        this.fail(failure)
        for (const batch of batches) try { this.deliverBatch(batch) }
        catch (delivery) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), delivery]; this.fail(delivery) }
      }
    } catch (metadata) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), metadata]; this.fail(metadata) }
  }
  async requestHost(op, payload, options = {}) {
    const priorLate = options.onLateResponse
    const onLateResponse = message => {
      if (!this.closed) {
        try {
          if (message?.payload?.status === 'ok') this.acceptResult(message.payload.result)
          else if (message?.payload?.status === 'error') {
            const wire = message.payload.error
            this.acceptFailure(wire, Object.assign(error(wire?.code ?? 'ERR_ENGINE', wire?.message ?? 'late Worker failure'), { details: wire }))
          }
        } catch (failure) { this.fail(failure) }
      }
      return priorLate?.(message)
    }
    let result
    try { result = await this.rpc.requestHost(op, payload, { ...options, timeoutMs: options.timeoutMs ?? this.timeoutMs, onLateResponse }) }
    catch (failure) {
      this.acceptFailure(failure.details, failure)
      throw failure
    }
    try { return this.acceptResult(result) }
    catch (failure) { failure.committedResult = result; throw this.fail(failure) }
  }
  /** Standalone owned-bridge ingress. An enclosing shared-bridge owner instead
   * calls receiveObservation then its one bridge.receiveBatch exactly once.
   * Neither this method nor an observation grants event credit/input authority. */
  receiveEvent(message) {
    if (this.closed) return false
    try { return this.receiveEventChecked(message) } catch (failure) { this.fail(failure); return false }
  }
  receiveEventChecked(message) {
    if (!record(message) || message.version !== WORKER_RPC_VERSION || message.kind !== 'event'
      || message.workerEpoch !== this.owner.workerEpoch || message.sessionId !== this.owner.sessionId) throw this.fail(invalid('Worker event belongs to another adapter owner'))
    const match = /^worker-event-([1-9][0-9]*)$/.exec(message.requestId ?? ''), sequence = match ? BigInt(match[1]) : 0n
    if (sequence <= this.eventSequence || sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw this.fail(invalid('Worker event was duplicated or is outside its genuine receipt sequence'))
    this.eventSequence = sequence
    if (message.op === 'fault') {
      let observationFailure
      try { if (message.payload?.observation !== undefined) this.receiveObservation(message.payload.observation) }
      catch (failure) { observationFailure = failure }
      const wire = message.payload?.error
      const failure = Object.assign(error(wire?.code ?? 'ERR_ENGINE', wire?.message ?? 'Worker fault'), { details: message.payload })
      // DomViewError prefixes local messages with the code. A genuine Worker
      // diagnostic already owns its text; preserve it byte-for-byte, including
      // an existing prefix, after observation processing has frozen the owner.
      if (typeof wire?.message === 'string') failure.message = wire.message
      if (observationFailure) failure.cleanupErrors = [observationFailure]
      this.fail(failure)
      return observationFailure === undefined
    }
    if (message.payload?.observation !== undefined) this.receiveObservation(message.payload.observation)
    if (message.op === 'batch') { this.deliverBatch(message.payload); this.transport.receiveBatch(message.payload) }
    else if (!['dirty', 'diagnostic'].includes(message.op)) throw this.fail(invalid('unknown Worker DOM event'))
    else if (message.op === 'dirty' && message.payload?.observation === undefined) throw this.fail(invalid('dirty notification omitted ordered observation'))
    else if (message.op === 'diagnostic') this.report(message.payload)
    return true
  }
  current(entry) {
    return !this.closed && !this.stopping && !this.faulted && this.active === entry && !entry.controller.signal.aborted
      && !this.ownerFenceBlocked && entry.ownerFenceRevision === this.ownerFenceRevision
      && entry.context.isCurrent() && hardKey(this.latest.state) === entry.hardKey
  }
  check(entry) { if (!this.current(entry)) throw cancelled('Worker DOM attempt is retired') }
  validateContext(demand, context) {
    measureWorkerPayload(demand)
    if (!sameOwner(demand?.owner, this.owner) || !sameOwner(context?.owner, this.owner)
      || !positive(context?.attemptId) || context.surfaceGeneration !== demand.surfaceGeneration
      || !positive(demand.surfaceGeneration) || !positive(demand.currentPage?.pageId)
      || typeof context.isCurrent !== 'function' || !context.signal || typeof context.signal.addEventListener !== 'function'
      || typeof context.signal.removeEventListener !== 'function' || typeof context.signal.aborted !== 'boolean'
      || demand.rendererProfile !== 'webview' || demand.lifecycle !== 'Active'
      || !decimal(demand.templateRevision) || !sameViewport(demand.viewport, this.latest.state.viewport)
      || hardKey(demand) !== hardKey(this.latest.state)) throw invalid('DOM scheduler context does not identify the current ordered owner/page/viewport')
    if (this.closed || this.stopping || this.faulted || this.ownerFenceBlocked || context.signal.aborted || !context.isCurrent()) throw cancelled('Worker DOM owner is unavailable')
    if (this.active) throw error('ERR_RENDER', 'release the current Worker DOM adapter attempt first')
  }
  async prepareTemplate(demand, context) {
    this.validateContext(demand, context)
    demand = plain(demand)
    context = Object.freeze({ owner: this.owner, attemptId: context.attemptId, surfaceGeneration: context.surfaceGeneration, signal: context.signal, isCurrent: context.isCurrent })
    const entry = { context, ownerFenceRevision: this.ownerFenceRevision, hardKey: hardKey(demand), controller: new AbortController(), phase: 'preparing', handle: null, localKey: null, acknowledged: false }
    entry.abort = () => entry.controller.abort(context.signal.reason)
    context.signal.addEventListener('abort', entry.abort, { once: true }); this.active = entry
    try {
      this.check(entry)
      const route = this.manifest.routes.find(route => route.path === demand.currentPage.path)
      if (!route || this.frameSequence >= Number.MAX_SAFE_INTEGER) throw error('ERR_INVALID_MANIFEST', 'active portable route is missing or local frame ID is exhausted')
      const render = { frameId: ++this.frameSequence, templateId: `template:${route.path}.wxml`, useSessionResources: true,
        viewport: { ...demand.viewport }, styleIds: routeStyleIds(this.manifest, route) }
      entry.handle = await this.client.prepareTemplate(render, { signal: entry.controller.signal, releaseMode: 'strict' })
      this.check(entry)
      const prepared = entry.handle, scheduling = prepared.scheduling, input = scheduling?.consumedInput
      if (demand.sampleDemandRevision !== undefined && (!scheduling?.consumedSample || BigInt(copyConsumedSample(scheduling.consumedSample).demandRevision) < BigInt(demand.sampleDemandRevision))) throw invalid('DOM template lacks its cloned animation demand proof')
      validateDomPresentationKey(prepared.key)
      if (prepared.releaseMode !== 'strict' || scheduling?.version !== '1.0' || !sameKey(scheduling.key, prepared.key)
        || !record(input) || input.pageId !== demand.currentPage.pageId || input.routePath !== demand.currentPage.path
        || !sameViewport(input.viewport, demand.viewport) || !decimal(input.templateRevision)
        || BigInt(input.templateRevision) < BigInt(demand.templateRevision)
        || prepared.key.sessionId !== this.owner.sessionId || prepared.key.pageId !== demand.currentPage.pageId
        || prepared.key.surfaceGeneration !== context.surfaceGeneration || prepared.key.profile !== 'webview'
        || entry.localKey && !sameKey(entry.localKey, prepared.key)) throw invalid('DOM preparation lacks the exact generated-page consumed-input proof')
      const proof = freeze({ version: '1.0', attemptId: context.attemptId, owner: this.owner,
        surfaceGeneration: context.surfaceGeneration, consumedInput: plain(input),
        ...(scheduling.consumedSample === undefined ? {} : { consumedSample: copyConsumedSample(scheduling.consumedSample) }), publication: { kind: 'browser-view', key: prepared.key } })
      const candidate = Object.freeze({ proof }); entry.candidate = candidate; entry.phase = 'prepared'
      candidates.get(this).set(candidate, entry)
      return candidate
    } catch (failure) {
      if (entry.handle) try { await this.client.releasePrepared(entry.handle) } catch (cleanup) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup]; this.fail(cleanup) }
      this.finish(entry); throw failure
    }
  }
  async preparePaint(demand, accepted, context) {
    if (!decimal(demand?.sampleDemandRevision)) throw error('ERR_UNSUPPORTED_CAPABILITY', 'DOM retained-paint publication is not negotiated; View reevaluation is forbidden as a paint fallback')
    this.validateContext(demand, context)
    demand = plain(demand)
    context = Object.freeze({ owner: this.owner, attemptId: context.attemptId, surfaceGeneration: context.surfaceGeneration, signal: context.signal, isCurrent: context.isCurrent })
    // A scheduler proof identifies an already retained native ACK. A plausible
    // key alone cannot authorize sampling another adapter's or an older base.
    const baseProof = plain(accepted?.proof), base = this.client.accepted
    validateDomPresentationKey(baseProof?.publication?.key)
    copyConsumedSample(baseProof.consumedSample)
    if (!sameProof(baseProof, this.#acceptedProof) || !positive(baseProof.attemptId)
      || BigInt(context.attemptId) <= BigInt(baseProof.attemptId)
      || !sameOwner(baseProof.owner, this.owner) || baseProof.surfaceGeneration !== context.surfaceGeneration
      || baseProof.consumedInput.pageId !== demand.currentPage.pageId || baseProof.consumedInput.routePath !== demand.currentPage.path
      || !sameViewport(baseProof.consumedInput.viewport, demand.viewport) || BigInt(baseProof.consumedInput.templateRevision) < BigInt(demand.templateRevision)
      || !base || !sameKey(baseProof.publication.key, base.key) || !sameInput(baseProof.consumedInput, base.consumedInput)
      || !decimal(base.geometryEpoch) || !this.client.current(base.authority)) throw invalid('DOM sample requires the exact retained acknowledged proof')
    this.validateContext(demand, context)
    const entry = { context, ownerFenceRevision: this.ownerFenceRevision, hardKey: hardKey(demand), controller: new AbortController(), phase: 'preparing', handle: null, acknowledged: false }
    entry.abort = () => entry.controller.abort(context.signal.reason)
    context.signal.addEventListener('abort', entry.abort, { once: true }); this.active = entry
    try {
      this.check(entry)
      entry.handle = await this.client.prepareSample(demand.sampleDemandRevision, { signal: entry.controller.signal, releaseMode: 'strict' })
      this.check(entry)
      const prepared = entry.handle, scheduling = prepared.scheduling, input = scheduling?.consumedInput
      validateDomPresentationKey(prepared.key)
      const consumedSample = copyConsumedSample(scheduling?.consumedSample)
      if (prepared.releaseMode !== 'strict' || scheduling?.version !== '1.0' || !sameKey(scheduling.key, prepared.key)
        || !sameInput(input, baseProof.consumedInput) || input.pageId !== demand.currentPage.pageId || input.routePath !== demand.currentPage.path
        || !sameViewport(input.viewport, demand.viewport)
        || BigInt(consumedSample.demandRevision) < BigInt(demand.sampleDemandRevision)
        || prepared.key.sessionId !== this.owner.sessionId || prepared.key.pageId !== demand.currentPage.pageId
        || prepared.key.surfaceGeneration !== context.surfaceGeneration || prepared.key.profile !== 'webview') throw invalid('DOM sample lacks exact retained input and sample proof')
      const proof = freeze({ version: '1.0', attemptId: context.attemptId, owner: this.owner, surfaceGeneration: context.surfaceGeneration,
        consumedInput: plain(input), consumedSample, publication: { kind: 'browser-view', key: prepared.key } })
      const candidate = Object.freeze({ proof }); entry.candidate = candidate; entry.phase = 'prepared'
      candidates.get(this).set(candidate, entry); return candidate
    } catch (failure) {
      if (entry.handle) try { await this.client.releasePrepared(entry.handle) } catch (cleanup) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup]; this.fail(cleanup) }
      this.finish(entry); throw failure
    }
  }
  exactCandidate(candidate) {
    const entry = candidates.get(this).get(candidate)
    if (!entry || entry.candidate !== candidate) throw invalid('Worker DOM adapter requires its exact owned candidate')
    return entry
  }
  #retainAcknowledgement(entry) {
    const proof = entry.candidate.proof, accepted = this.client.accepted
    if (!entry.acknowledged || !accepted || !sameKey(accepted.key, proof.publication.key)
      || !sameInput(accepted.consumedInput, proof.consumedInput)) throw invalid('DOM retained ACK differs from its owned prepared proof')
    this.#acceptedProof = proof
  }
  async present(candidate, context) {
    const entry = this.exactCandidate(candidate), proof = candidate.proof
    if (entry.phase !== 'prepared' || !sameOwner(context?.owner, this.owner) || context.attemptId !== proof.attemptId
      || context.surfaceGeneration !== proof.surfaceGeneration || !sameProof(context.proof, proof)) throw invalid('presentation does not identify the exact prepared DOM proof')
    this.check(entry); entry.phase = 'presenting'
    const result = await this.client.presentPrepared(entry.handle)
    // Only the real permit -> swap -> runtime final ACK -> strict confirm path
    // reaches this line. The scheduler committed flag is never input authority.
    entry.acknowledged = true
    if (!sameKey(result.key, proof.publication.key) || typeof result.inputEnabled !== 'boolean'
      || proof.consumedSample !== undefined && !sameConsumedSample(result.scheduling?.consumedSample, proof.consumedSample)) throw this.fail(invalid('DOM final did not identify its genuine prepared publication'))
    this.#retainAcknowledgement(entry)
    // A local fence can retire a real ACK while strict confirmation drains
    // predecessor resources. Preserve that final; it cannot grant old input.
    const inputEnabled = result.inputEnabled && this.current(entry)
    entry.phase = 'presented'
    if (!inputEnabled) this.freezeInput('retired-ack')
    return Object.freeze({ acknowledged: true, publication: proof.publication, inputEnabled,
      requiresRestart: this.latest.state.requiresRestart })
  }
  finish(entry) {
    entry.context.signal.removeEventListener('abort', entry.abort)
    if (this.active === entry) this.active = null
  }
  release(candidate, context) {
    let entry
    try { entry = this.exactCandidate(candidate) } catch (failure) { return Promise.reject(failure) }
    if (entry.releasePromise) return entry.releasePromise
    let resolve, reject
    entry.releasePromise = new Promise((yes, no) => { resolve = yes; reject = no })
    Promise.resolve().then(async () => {
      const failures = []
      if (!sameOwner(context?.owner, this.owner) || context.attemptId !== entry.context.attemptId
        || !sameProof(context.proof, entry.candidate.proof) || typeof context.committed !== 'boolean' || typeof context.retired !== 'boolean') failures.push(invalid('release context does not identify its owned attempt/proof'))
      try {
        const result = await this.client.releasePrepared(entry.handle)
        if (result.released !== true || result.resourceBarrier !== 'strict' || typeof result.acknowledged !== 'boolean'
          || entry.acknowledged && !result.acknowledged || !result.acknowledged && !['confirmed', 'not-prepared', 'retired'].includes(result.remoteAbort)) throw invalid('strict DOM client did not prove exact local/remote release')
        entry.acknowledged ||= result.acknowledged
        if (entry.acknowledged) this.#retainAcknowledgement(entry)
      } catch (failure) { failures.push(failure) }
      this.finish(entry)
      if (failures.length) throw this.fail(aggregate('Worker DOM candidate release failed', failures))
      return Object.freeze({ released: true, acknowledged: entry.acknowledged, resourceBarrier: 'strict' })
    }).then(resolve, reject)
    return entry.releasePromise
  }
  freezeInput() {
    if (this.client.accepted) this.client.accepted.inputEnabled = false
    try { this.presenter.suspendInput() } catch (failure) { this.faulted = true; throw failure }
  }
  async resolveResource(descriptor, context) {
    const entry = this.active
    if (!entry || entry.phase !== 'preparing') throw cancelled('resource has no owned preparing DOM attempt')
    this.check(entry); measureWorkerPayload(descriptor); validateDomPresentationKey(context.presentationKey)
    const key = plain(context.presentationKey)
    if (key.sessionId !== this.owner.sessionId || key.pageId !== this.latest.state.currentPage.pageId
      || key.surfaceGeneration !== entry.context.surfaceGeneration || key.profile !== 'webview'
      || entry.localKey && !sameKey(entry.localKey, key)
      || !sha(descriptor.sha256) || !imageMimes.has(descriptor.mime) || !Number.isSafeInteger(descriptor.size)
      || descriptor.size < 0 || descriptor.size > 16 * 1024 * 1024) throw invalid('resource descriptor/key is outside the owned prepared DOM boundary')
    entry.localKey ??= key
    if (this.resources.size >= this.maxResourceCount || descriptor.size > this.maxResourceBytes - this.resourceBytes) throw error('ERR_RENDER', 'Worker DOM resource lease budget exceeded')
    const lease = { key, sha256: descriptor.sha256, size: descriptor.size, url: null, releasePromise: null }
    this.resources.add(lease); this.resourceBytes += lease.size
    try {
      const dynamic = descriptor.path?.startsWith('__container_buffer_urls/') === true
      const response = await this.requestHost('resource', { key, sha256: descriptor.sha256, ...(dynamic ? { path: descriptor.path } : {}) }, { signal: context.signal })
      this.check(entry)
      if (context.signal.aborted || !sameKey(response.key, key) || response.sha256 !== descriptor.sha256
        || dynamic && response.path !== descriptor.path
        || !(response.bytes instanceof ArrayBuffer) || response.bytes.byteLength !== descriptor.size) throw invalid('Worker resource did not match exact key/hash/size')
      const digest = [...new Uint8Array(await this.crypto.subtle.digest('SHA-256', response.bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
      this.check(entry)
      if (context.signal.aborted) throw cancelled('resource retired before URL installation')
      if (digest !== descriptor.sha256) throw error('ERR_RENDER', 'Worker resource SHA-256 mismatch')
      lease.url = this.createObjectURL(new Blob([response.bytes], { type: descriptor.mime }))
      if (typeof lease.url !== 'string' || !lease.url.startsWith('blob:')) throw invalid('owned DOM resource factory must return a blob URL')
      this.check(entry)
      return Object.freeze({ url: lease.url, release: () => this.releaseResource(lease) })
    } catch (failure) {
      if (lease.url) try { await this.releaseResource(lease) } catch (cleanup) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup] }
      else { this.resources.delete(lease); this.resourceBytes -= lease.size }
      throw failure
    }
  }
  releaseResource(lease) {
    if (lease.releasePromise) return lease.releasePromise
    let resolve, reject
    lease.releasePromise = new Promise((yes, no) => { resolve = yes; reject = no })
    lease.releasePromise.catch(() => {})
    Promise.resolve().then(() => this.revokeObjectURL(lease.url)).then(() => {
      this.resources.delete(lease); this.resourceBytes -= lease.size; resolve()
    }, failure => { this.resourceFailures.push(failure); reject(failure) })
    return lease.releasePromise
  }
  /** Owner supplies the genuine native transition final. Cleanup never sends an
   * old-generation abort into the successor binding or fabricates that ACK. */
  beginPresenterRetirement(retirement) {
    if (this.owner.presenterGeneration === undefined || !retirement || typeof retirement.then !== 'function') throw invalid('transition retirement requires a negotiated binding and actual native barrier')
    if (this.sourceRetirement && this.sourceRetirement !== retirement) throw invalid('presenter retirement barrier cannot be replaced')
    if (!this.presenterRetirement) {
      this.sourceRetirement = retirement
      this.presenterRetirement = Promise.resolve(retirement).then(receipt => {
        const previous = receipt?.previousPresenterBinding
        if (receipt?.version !== '1.0' || receipt.retired !== true || !record(previous) || Object.keys(previous).length !== 4
          || previous.version !== '1.0' || previous.sessionId !== this.owner.sessionId || previous.transportBackend !== this.owner.transportBackend
          || previous.generation !== this.owner.presenterGeneration || !['native-renderer-transition-final', 'native-worker-close-final'].includes(receipt.source)) throw invalid('native retirement final belongs to another presenter generation')
        return receipt
      })
      void this.presenterRetirement.catch(() => {})
      this.client.retireRemotePresenter(this.presenterRetirement)
    }
    return this.cancelOwnedWork('presenter-generation-retired')
  }
  cancelOwnedWork(reason = 'Worker DOM adapter stopping') {
    if (this.cancelPromise) return this.cancelPromise
    let resolve, reject
    this.cancelPromise = new Promise((yes, no) => { resolve = yes; reject = no })
    this.stopping = true
    const failures = []
    try { this.freezeInput(reason) } catch (failure) { failures.push(failure) }
    this.active?.controller.abort(reason)
    // A real control-lane retire runs after entered WASM work. It preserves the
    // borrowed RPC for exact-key cleanup and does not unload/stop its timers.
    Promise.resolve().then(async () => {
      try {
        if (this.presenterRetirement) await this.presenterRetirement
        else {
        const batch = await this.requestHost('view.retire', { reason: typeof reason === 'string' ? reason.slice(0, 4096) : 'Worker DOM adapter retired' })
        this.deliverBatchShapeOnly(batch)
        }
      } catch (failure) { failures.push(failure) }
      if (failures.length) throw aggregate('Worker DOM cancellation/retirement failed', failures)
      return Object.freeze({ cancelled: true, workerRetired: true })
    }).then(resolve, reject)
    return this.cancelPromise
  }
  deliverBatchShapeOnly(batch) {
    if (!record(batch) || !Array.isArray(batch.messages)) throw invalid('Worker retirement did not return its genuine native batch')
    if (batch.messages.some(message => message.payload?.ok === false || message.op === 'error')) throw aggregate('Worker retirement reported native errors', batch.messages.filter(message => message.payload?.ok === false || message.op === 'error'))
  }
  dispose() {
    if (this.closePromise) return this.closePromise
    let resolve, reject
    this.closePromise = new Promise((yes, no) => { resolve = yes; reject = no })
    const cancellation = this.cancelOwnedWork('Worker DOM adapter disposed')
    Promise.resolve().then(async () => {
      const failures = []
      try { await cancellation } catch (failure) { failures.push(failure) }
      try { await this.client.dispose() } catch (failure) { failures.push(failure) }
      this.closed = true
      failures.push(...this.resourceFailures)
      if (this.resources.size) failures.push(error('ERR_RENDER', `${this.resources.size} DOM resource leases remain owned; cleanup is not proven`))
      if (failures.length) throw aggregate('Worker DOM adapter cleanup failed', failures)
      return Object.freeze({ closed: true, workerClosed: false, bridgeClosed: this.ownsBridge })
    }).then(resolve, reject)
    return this.closePromise
  }
  close() { return this.dispose() }
}
