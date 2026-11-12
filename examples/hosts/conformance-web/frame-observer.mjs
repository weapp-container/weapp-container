/** Default-off conformance observer. It never changes an RPC result, ACK or input gate. */
import { copyExternalFrameScheduling, copyExternalPresentationOutcome, copyOrderedObservation } from '../../../examples/hosts/web-wasm/worker-runtime.mjs'
import { measureWorkerPayload } from '../../../examples/hosts/web-wasm/worker-session-client.mjs'

export class WebConformanceError extends Error {
  constructor(code, message) { super(message); this.name = 'WebConformanceError'; this.code = code }
}
const fail = (code, message) => { throw new WebConformanceError(code, message) }
const check = (condition, message) => { if (!condition) fail('ERR_CONFORMANCE_OBSERVATION', message) }
const same = (left, right) => left === right || Boolean(left && right && typeof left === 'object' && typeof right === 'object'
  && Array.isArray(left) === Array.isArray(right) && Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key])))
const sameOwner = (left, right) => left && right
  && ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend', 'presenterGeneration'].every(key => left[key] === right[key])
const sameRect = (left, right) => left && right && ['x', 'y', 'width', 'height'].every(key => left[key] === right[key])
const copy = value => { measureWorkerPayload(value, { maxBytes: 16 * 1024 * 1024 }); return structuredClone(value) }
const binding = state => ({ currentPage: state.currentPage, viewport: state.viewport, templateRevision: state.templateRevision,
  renderRevision: state.renderRevision, inputLifetimeRevision: state.inputLifetimeRevision, surfaceGeneration: state.surfaceGeneration,
  rendererProfile: state.rendererProfile, transportBackend: state.transportBackend, viewRevision: state.viewRevision,
  sampleDemandRevision: state.sampleDemandRevision })
const runtimeBinding = state => ({ currentPage: state.currentPage, viewport: { width: state.viewport.width, height: state.viewport.height },
  templateRevision: state.templateRevision, renderRevision: state.renderRevision,
  rendererProfile: state.rendererProfile, transportBackend: state.transportBackend, viewRevision: state.viewRevision,
  sampleDemandRevision: state.sampleDemandRevision })
const healthy = state => state.lifecycle === 'Active' && state.currentPage && state.requiresRestart === false
  && !state.executionFault && state.transportBackend === 'external-frame' && state.inputLifetimeRevision !== null

export class PresentedFrameObserver {
  #enabled; #owner = null; #adapter = null; #frames = new Map(); #acks = new Map(); #fault = null; #closed = false; #serial = 0; #maxFrames
  constructor({ enabled = false, engine = 'quickjs', maxFrames = 4 } = {}) {
    if (engine !== 'quickjs') fail('ERR_ENGINE', 'this candidate requires the real QuickJS guest provider')
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 16) fail('ERR_INVALID_REQUEST', 'maxFrames must be in 1..16')
    this.#enabled = enabled === true; this.#maxFrames = maxFrames
  }
  get diagnostics() { return Object.freeze({ enabled: this.#enabled, closed: this.#closed, fault: this.#fault,
    retainedFrames: this.#frames.size, retainedAcks: this.#acks.size }) }
  #observe(action) {
    if (this.#closed || this.#fault) return
    try { action() } catch (error) { this.#fault = error; this.#frames.clear(); this.#acks.clear() }
  }
  wrapRpc(rpc, owner) {
    if (!this.#enabled) return rpc
    check(!this.#closed && this.#owner === null, 'one observer owns exactly one presenter attachment')
    check(owner?.transportBackend === 'external-frame' && owner.presenterGeneration === undefined,
      'candidate v1 supports the fixed external-frame presenter, without renderer transitions')
    check(rpc?.actualFinalContract === '1.0' && typeof rpc.requestHost === 'function'
      && rpc.workerEpoch === owner.workerEpoch && rpc.sessionId === owner.sessionId, 'the actual owner RPC contract is required')
    this.#owner = copy(owner)
    const wrapper = Object.create(rpc)
    Object.defineProperty(wrapper, 'requestHost', { value: (op, payload, options) => {
      // The original receiver, arguments, callbacks and promise are preserved.
      // Observing an original rejected/late/cancelled request never captures a frame.
      const promise = Reflect.apply(rpc.requestHost, rpc, [op, payload, options])
      if (['frame', 'frame.current', 'ack'].includes(op)) {
        const serial = ++this.#serial
        let request
        this.#observe(() => { request = copy(payload) })
        Promise.resolve(promise).then(result => {
          this.#observe(() => {
            if (options?.signal?.aborted) return
            const observation = copyOrderedObservation(result?.observation, this.#owner)
            const state = observation.state
            check(healthy(state), 'captured reply is outside a healthy active external-frame lifetime')
            if (op === 'ack') {
              const outcome = copyExternalPresentationOutcome(result, { sessionId: this.#owner.sessionId, renderRevision: request.renderRevision })
              // Ready effects can retire this publication with input disabled.
              // Its valid final is retained; only snapshot may require a grant.
              check(same(runtimeBinding(outcome.observedState), runtimeBinding(state)),
                'actual ACK and its original ordered observation disagree')
              this.#acks.set(outcome.renderRevision, { outcome, observation, serial })
            } else {
              const scheduling = copyExternalFrameScheduling(result.scheduling, {
                sessionId: this.#owner.sessionId, renderRevision: result.renderRevision, frame: result.frame })
              const consumed = scheduling.consumedInput
              check(consumed && consumed.pageId === state.currentPage.pageId && consumed.routePath === state.currentPage.path
                && consumed.templateRevision === state.templateRevision && sameRect(consumed.viewport, state.viewport)
                && result.renderRevision === state.renderRevision, 'clone reply is not from its actual observed template/page')
              check(!this.#frames.has(result.renderRevision), 'one render revision cannot replace its captured frame')
              this.#frames.set(result.renderRevision, { frame: copy(result.frame), scheduling, observation, serial })
            }
            // Discard oldest completed generations. No discarded entry can be
            // supplied from expected text, another provider, or a caller frame.
            for (const entries of [this.#frames, this.#acks]) while (entries.size > this.#maxFrames) entries.delete(entries.keys().next().value)
          })
        }, () => {}).catch(error => this.#observe(() => { throw error }))
      }
      return promise
    } })
    return Object.freeze(wrapper)
  }
  attachAdapter(adapter) {
    if (!this.#enabled) return
    check(this.#adapter === null && sameOwner(adapter?.owner, this.#owner), 'actual adapter owner must match the observed RPC')
    this.#adapter = adapter
  }
  snapshot(session) {
    if (!this.#enabled) fail('ERR_CONFORMANCE_DISABLED', 'conformance frame observation is disabled by default')
    if (this.#fault) throw this.#fault
    check(!this.#closed && this.#adapter && sameOwner(session?.owner, this.#owner), 'observer/session attachment is unavailable')
    const status = session.status
    check(status.phase === 'ready' && status.runtimeReady && status.visible && status.inputEnabled && !status.requiresRestart
      && !status.fault && !status.metricsPending && status.presentation?.phase === 'idle'
      && status.presentation.inFlight === false && status.presentation.hasRaf === false, 'session has no settled current effective input authority')
    const observation = copyOrderedObservation(status.observation, this.#owner), state = observation.state
    const authority = this.#adapter.inputAuthority, accepted = status.presentation?.accepted
    check(healthy(state) && sameOwner(authority?.owner, this.#owner) && authority.enabled === true
      && authority.canvas === this.#adapter.canvas && accepted?.inputEnabled === true, 'actual presenter input is unavailable')
    const revision = authority.publication?.renderRevision, captured = this.#frames.get(revision), ack = this.#acks.get(revision)
    check(captured && ack && ack.outcome.inputEnabled === true && !ack.outcome.requiresRestart
      && ack.serial > captured.serial && this.#adapter.status.lastAck?.renderRevision === revision,
      'frame needs its subsequent actual ACK on the same adapter')
    const proof = accepted.proof, input = captured.scheduling.consumedInput
    check(sameOwner(proof?.owner, this.#owner) && proof.surfaceGeneration === state.surfaceGeneration
      && authority.surfaceGeneration === state.surfaceGeneration && authority.publication.kind === 'external-frame'
      && same(proof.publication, authority.publication) && same(proof.consumedInput, input) && same(authority.consumedInput, input),
    'accepted scheduler proof, actual adapter and clone input disagree')
    check(same(binding(captured.observation.state), binding(state)) && same(binding(ack.observation.state), binding(state))
      && BigInt(captured.observation.sequence) <= BigInt(ack.observation.sequence)
      && BigInt(ack.observation.sequence) <= BigInt(observation.sequence), 'presented frame is stale for the current page/lifetime/template/surface')
    return copy({ frame: captured.frame, owner: this.#owner, observation, renderRevision: revision,
      consumedInput: input, acknowledgement: ack.outcome })
  }
  verifyClosed(session, receipt) {
    check(receipt?.closed === true && receipt.workerClosed === true && receipt.ownedMountRemoved === true
      && session.status.phase === 'closed', 'the owning session did not reach its actual terminal cleanup barrier')
    if (this.#adapter) {
      const status = this.#adapter.status
      check(status.disposed === true && status.pendingOperations === 0 && status.actualRemoteOperations === 0
        && status.ownedSurfaces === 0 && status.ownedPresenters === 0 && this.#adapter.inputAuthority === null,
      'the actual presenter still owns operations, surfaces, presenters or input authority')
    }
  }
  close() { this.#closed = true; this.#frames.clear(); this.#acks.clear(); this.#adapter = null }
}
