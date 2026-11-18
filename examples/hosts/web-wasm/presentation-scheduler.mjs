/** Pure demand scheduling. No RPC, runtime, DOM, HTTP or engine fallback. */
export class PresentationScheduleError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PresentationScheduleError'
    this.code = code
    Object.assign(this, details)
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new PresentationScheduleError('ERR_PROTOCOL_VERSION', message) }
const u64 = (value, name) => {
  if (typeof value !== 'string' || value.length > 20 || !/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) fail(`${name} needs a canonical u64 string`)
  return value
}
const text = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > 4096) fail(`invalid ${name}`)
  return value
}
const later = (left, right) => BigInt(left) > BigInt(right)
const equalViewport = (a, b) => ['x', 'y', 'width', 'height'].every(field => a[field] === b[field])
const ownerFields = ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend']
const sameOwner = (a, b) => ownerFields.every(field => a[field] === b[field]) && a.presenterGeneration === b.presenterGeneration
const sameInput = (a, b) => a.pageId === b.pageId && a.routePath === b.routePath && a.templateRevision === b.templateRevision && equalViewport(a.viewport, b.viewport)
const sameSample = (a, b) => a === undefined && b === undefined || object(a) && object(b)
  && a.demandRevision === b.demandRevision && a.sampleRevision === b.sampleRevision
const keyFields = ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']
const samePublication = (a, b) => object(a) && object(b) && a.kind === b.kind && (a.kind === 'external-frame'
  ? a.renderRevision === b.renderRevision
  : a.kind === 'browser-view' && object(a.key) && object(b.key) && keyFields.every(field => a.key[field] === b.key[field]))

// Only authoritative demand newer than the clone-time proof can require a
// successor. ACK-time decorations and activity/viewRevision are not input.
const newerPresentationKind = (current, proof) => {
  if (later(current.templateRevision, proof.consumedInput.templateRevision)) return 'template'
  if (current.owner.transportBackend === 'browser-view' && current.sampleDemandRevision !== undefined) {
    // A legacy accepted document cannot invent a sample baseline when the
    // native lane is first discovered. Obtain its real clone proof first.
    if (proof.consumedSample === undefined) return 'template'
    if (later(current.sampleDemandRevision, proof.consumedSample.demandRevision)) return 'paint'
  }
  return current.owner.transportBackend === 'external-frame' && proof.publication.kind === 'external-frame'
    && later(current.renderRevision, proof.publication.renderRevision) ? 'paint' : null
}

function owner(value) {
  if (!object(value)) fail('missing immutable scheduler owner')
  const result = {
    workerEpoch: text(value.workerEpoch, 'workerEpoch'),
    sessionId: text(value.sessionId, 'sessionId'),
    packSha256: value.packSha256,
    transportBackend: value.transportBackend,
  }
  if (typeof result.packSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.packSha256)) fail('invalid packSha256')
  if (!['browser-view', 'external-frame'].includes(result.transportBackend)) fail('invalid transportBackend')
  if (value.presenterGeneration !== undefined) {
    result.presenterGeneration = u64(value.presenterGeneration, 'presenterGeneration')
    if (result.presenterGeneration === '0') fail('presenterGeneration cannot be zero')
  }
  return Object.freeze(result)
}

function viewport(value) {
  if (!object(value) || !['x', 'y', 'width', 'height'].every(field => Number.isFinite(value[field])) || value.width <= 0 || value.height <= 0 || value.width > 4096 || value.height > 4096) fail('invalid logical viewport')
  return Object.freeze({ x: value.x, y: value.y, width: value.width, height: value.height })
}

function demand(value, expectedOwner) {
  if (!object(value)) fail('missing runtime demand')
  const binding = value.presenterBinding
  const sourceOwner = owner(expectedOwner.presenterGeneration === undefined ? value.owner : { ...value.owner,
    transportBackend: binding?.transportBackend, presenterGeneration: binding?.generation })
  if (expectedOwner.presenterGeneration !== undefined && (!object(binding) || binding.version !== '1.0'
    || binding.sessionId !== expectedOwner.sessionId || value.transitionRequired || value.requiresRestart)) fail('scheduler requires a committed presenter binding')
  if (!sameOwner(sourceOwner, expectedOwner)) fail('runtime demand belongs to another immutable owner')
  let currentPage = null
  if (value.currentPage !== null) {
    if (!object(value.currentPage)) fail('invalid current page')
    currentPage = Object.freeze({ pageId: u64(value.currentPage.pageId, 'pageId'), path: text(value.currentPage.path, 'route path') })
    if (currentPage.pageId === '0') fail('pageId cannot be zero')
  }
  if (!['Created', 'Active', 'Background', 'Destroyed'].includes(value.lifecycle)) fail('invalid lifecycle')
  if (!['webview', 'skia', 'skyline-compat'].includes(value.rendererProfile)) fail('invalid rendererProfile')
  if (value.viewRevision !== undefined) u64(value.viewRevision, 'viewRevision')
  return Object.freeze({
    owner: sourceOwner, currentPage,
    templateRevision: u64(value.templateRevision, 'templateRevision'),
    renderRevision: u64(value.renderRevision, 'renderRevision'),
    surfaceGeneration: u64(value.surfaceGeneration, 'surfaceGeneration'),
    // Generic legacy scheduler callers may omit this native contract. Once
    // supplied, preserve it through the complete adapter demand and hard key.
    ...(value.inputLifetimeRevision === undefined ? {} : { inputLifetimeRevision: u64(value.inputLifetimeRevision, 'inputLifetimeRevision') }),
    ...(value.sampleDemandRevision === undefined ? {} : { sampleDemandRevision: u64(value.sampleDemandRevision, 'sampleDemandRevision') }),
    viewport: viewport(value.viewport), rendererProfile: value.rendererProfile,
    lifecycle: value.lifecycle,
  })
}

// surfaceGeneration identifies logical input/coordinate lifetime. Physical
// density and CSS display zoom MUST NOT increment it or reset template input.
const hardKey = value => JSON.stringify([
  value.currentPage?.pageId ?? null, value.currentPage?.path ?? null,
  value.viewport.x, value.viewport.y, value.viewport.width, value.viewport.height,
  value.rendererProfile, value.lifecycle, value.surfaceGeneration, value.inputLifetimeRevision,
])
const runnable = value => value?.lifecycle === 'Active' && value.currentPage !== null
const familyMatches = value => value.owner.transportBackend === 'browser-view'
  ? value.rendererProfile === 'webview' : ['skia', 'skyline-compat'].includes(value.rendererProfile)
const recoverySourceMatches = (source, current) => source && current && runnable(source) && runnable(current)
  && source.owner.transportBackend === 'external-frame' && sameOwner(source.owner, current.owner)
  && source.rendererProfile === current.rendererProfile
  && source.currentPage.pageId === current.currentPage.pageId && source.currentPage.path === current.currentPage.path
  && equalViewport(source.viewport, current.viewport)
  && source.templateRevision === current.templateRevision
const recoveryInputMatches = (base, source, current) => base && recoverySourceMatches(source, current)
  && base.proof.consumedInput.templateRevision === current.templateRevision
  && sameInput(base.proof.consumedInput, {
    pageId: current.currentPage.pageId, routePath: current.currentPage.path,
    templateRevision: current.templateRevision, viewport: current.viewport,
  })

function consumedInput(value, captured) {
  if (!object(value)) fail('generated presentation requires clone-time consumedInput')
  const result = Object.freeze({
    pageId: u64(value.pageId, 'consumed pageId'),
    routePath: text(value.routePath, 'consumed routePath'),
    templateRevision: u64(value.templateRevision, 'consumed templateRevision'),
    viewport: viewport(value.viewport),
  })
  if (result.pageId !== captured.currentPage.pageId || result.routePath !== captured.currentPage.path || !equalViewport(result.viewport, captured.viewport)) fail('consumedInput does not match captured page/viewport')
  return result
}

function consumedSample(value, captured) {
  if (value === undefined && captured.sampleDemandRevision === undefined) return undefined
  if (!object(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'demandRevision') || !Object.hasOwn(value, 'sampleRevision')) fail('generated presentation requires exact clone-time consumedSample')
  const result = Object.freeze({
    demandRevision: u64(value.demandRevision, 'consumed sample demandRevision'),
    sampleRevision: u64(value.sampleRevision, 'consumed sample sampleRevision'),
  })
  if (captured.sampleDemandRevision !== undefined && later(captured.sampleDemandRevision, result.demandRevision)) fail('consumedSample predates captured sample demand')
  return result
}

function publication(value, captured) {
  if (!object(value) || value.kind !== captured.owner.transportBackend) fail('publication backend does not match captured owner')
  if (value.kind === 'external-frame') {
    const renderRevision = u64(value.renderRevision, 'publication renderRevision')
    if (renderRevision === '0' || later(captured.renderRevision, renderRevision)) fail('publication render revision predates captured demand')
    return Object.freeze({ kind: value.kind, renderRevision })
  }
  const raw = value.key
  if (!object(raw)) fail('missing DOM presentation key')
  const key = Object.freeze({
    sessionId: text(raw.sessionId, 'key sessionId'), pageId: u64(raw.pageId, 'key pageId'),
    documentRevision: u64(raw.documentRevision, 'documentRevision'),
    presentationRevision: u64(raw.presentationRevision, 'presentationRevision'),
    surfaceGeneration: u64(raw.surfaceGeneration, 'key surfaceGeneration'), profile: raw.profile,
  })
  if (key.sessionId !== captured.owner.sessionId || key.pageId !== captured.currentPage.pageId || key.surfaceGeneration !== captured.surfaceGeneration || key.profile !== 'webview' || key.documentRevision === '0' || key.presentationRevision === '0') fail('DOM key does not match captured owner/page/surface')
  return Object.freeze({ kind: value.kind, key })
}

function preparedProof(raw, flight) {
  if (!object(raw) || raw.version !== '1.0' || raw.attemptId !== flight.id) fail('missing versioned exact-attempt preparation proof')
  const sourceOwner = owner(raw.owner)
  if (!sameOwner(sourceOwner, flight.demand.owner) || raw.surfaceGeneration !== flight.demand.surfaceGeneration) fail('preparation proof owner or surface mismatch')
  const input = consumedInput(raw.consumedInput, flight.demand)
  if (flight.kind === 'template' && later(flight.demand.templateRevision, input.templateRevision)) fail('template preparation consumed an older input')
  if (flight.kind === 'paint' && !sameInput(input, flight.accepted.proof.consumedInput)) fail('retained paint cannot relabel the accepted template input')
  const token = publication(raw.publication, flight.demand)
  if (flight.kind === 'paint' && token.kind === 'browser-view') {
    const base = flight.accepted.proof.publication.key
    if (token.key.documentRevision !== base.documentRevision
      || !later(token.key.presentationRevision, base.presentationRevision)) fail('retained DOM paint must keep its document and advance presentation revision')
  }
  if (flight.accepted && (samePublication(token, flight.accepted.proof.publication) || token.kind === 'external-frame' && !later(token.renderRevision, flight.accepted.proof.publication.renderRevision))) fail('preparation must not acknowledge an already accepted publication')
  const sample = consumedSample(raw.consumedSample, flight.demand)
  return Object.freeze({
    version: '1.0', attemptId: flight.id, owner: sourceOwner,
    surfaceGeneration: flight.demand.surfaceGeneration,
    publication: token, consumedInput: input,
    ...(sample === undefined ? {} : { consumedSample: sample }),
  })
}

function finalOutcome(value, proof) {
  if (!object(value) || value.acknowledged !== true || typeof value.inputEnabled !== 'boolean' || !samePublication(value.publication, proof.publication)) fail('presentation needs an exact final acknowledgement and input outcome')
  if (value.requiresRestart !== undefined && typeof value.requiresRestart !== 'boolean') fail('invalid requiresRestart outcome')
  if (value.requiresRestart === true && value.inputEnabled) fail('restart-required outcome cannot enable input')
  // Deliberately ignore ACK-time consumedInput/consumedSample/state decorations.
  return Object.freeze({ inputEnabled: value.inputEnabled, requiresRestart: value.requiresRestart === true })
}

/**
 * One active flight, one newest demand, one RAF. Adapter is injected; see
 * docs/worker-presentation-scheduler.md for proof and cleanup obligations.
 */
export class PresentationScheduler {
  #owner
  #adapter
  #requestFrame
  #cancelFrame
  #preparationScheduling
  #onError
  #onState
  #latest
  #accepted
  #retiredPicture
  #failed
  #sequence
  #epoch
  #attemptSequence
  #flight
  #raf
  #rafRegistration
  #retiring
  #retryKind
  #closing
  #suspended
  #closed
  #restartRequired
  #faulted
  #closePromise
  #cleanupErrors
  #diagnostics
  #surfaceRecovery
  #recoverySequence

  get owner() { return this.#owner }
  constructor({ owner: sourceOwner, adapter, requestFrame, cancelFrame, preparationScheduling = 'frame', onError, onState } = {}) {
    this.#owner = owner(sourceOwner)
    if (!object(adapter) || !['prepareTemplate', 'preparePaint', 'present', 'release', 'freezeInput', 'cancelOwnedWork', 'dispose'].every(name => typeof adapter[name] === 'function')) fail('scheduler needs a phased presentation adapter')
    if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') fail('scheduler needs owned RAF request/cancel functions')
    if (!['frame', 'microtask'].includes(preparationScheduling)) fail('invalid preparation scheduling')
    this.#adapter = adapter; this.#requestFrame = requestFrame; this.#cancelFrame = cancelFrame
    this.#preparationScheduling = preparationScheduling
    this.#onError = onError; this.#onState = onState
    this.#latest = null; this.#accepted = null; this.#retiredPicture = null; this.#failed = null
    this.#sequence = null; this.#epoch = 0n; this.#attemptSequence = 0n
    this.#flight = null; this.#raf = null; this.#rafRegistration = null; this.#retiring = 0; this.#retryKind = null
    this.#closing = false; this.#suspended = false; this.#closed = false; this.#restartRequired = false; this.#faulted = false
    this.#closePromise = null; this.#cleanupErrors = []; this.#diagnostics = []
    this.#surfaceRecovery = null; this.#recoverySequence = 0n
  }

  get status() {
    const phase = this.#closed ? 'closed' : this.#closing ? 'closing' : this.#restartRequired ? 'restart-required' : this.#faulted ? 'faulted' : this.#suspended ? 'suspended' : this.#flight ? this.#flight.phase : this.#raf ? 'scheduled' : !runnable(this.#latest) ? 'inactive' : this.#failed ? 'blocked' : 'idle'
    const recovery = this.#surfaceRecovery
    return Object.freeze({ phase, latest: this.#latest, accepted: this.#accepted, retiredPicture: this.#retiredPicture, failed: this.#failed, observationSequence: this.#sequence, suspended: this.#suspended, inFlight: this.#flight !== null, hasRaf: this.#raf !== null,
      surfaceRecovery: recovery ? Object.freeze({ recoveryId: recovery.id, drained: recovery.drained, resumed: recovery.resumed, retained: this.#recoveryBase() !== null }) : null })
  }

  #report(failure) {
    this.#diagnostics.push(failure)
    if (this.#diagnostics.length > 32) this.#diagnostics.shift()
    try { this.#onError?.(failure) } catch { /* Diagnostics cannot acquire scheduler authority. */ }
  }
  #emit() { try { this.#onState?.(this.status) } catch (failure) { this.#report(failure) } }
  #freeze(reason) {
    if (this.#accepted?.inputEnabled) this.#accepted = Object.freeze({ ...this.#accepted, inputEnabled: false })
    try { this.#adapter.freezeInput(reason) } catch (failure) {
      this.#faulted = true; this.#cleanupErrors.push(failure); this.#report(failure)
    }
  }
  #checkOpen() {
    if (this.#closing || this.#closed) throw new PresentationScheduleError('ERR_CANCELLED', 'presentation scheduler is closing')
    if (this.#restartRequired) throw new PresentationScheduleError('ERR_UNSUPPORTED_CAPABILITY', 'renderer family requires a new owner', { requiresRestart: true })
    if (this.#faulted) throw new PresentationScheduleError('ERR_RENDER', 'presentation scheduler is faulted')
  }

  /** observation.sequence must come from one ordered authoritative state lane. */
  observe(observation) {
    this.#checkOpen()
    if (!object(observation)) fail('missing ordered observation')
    const sequence = u64(observation.sequence, 'observation sequence')
    if (this.#sequence !== null && !later(sequence, this.#sequence)) return Object.freeze({ accepted: false, reason: 'stale-observation' })
    // The product owner handles terminal native exhaustion before scheduling.
    // Direct users must also lose authority before rejecting that terminal token.
    if (observation.state?.inputLifetimeRevision === null) {
      const failure = new PresentationScheduleError('ERR_PROTOCOL_VERSION', 'exhausted native input lifetime requires a new owner')
      this.#faulted = true; this.#retire('native-input-lifetime-exhausted'); this.#report(failure); this.#emit(); throw failure
    }
    const next = demand(observation.state, this.#owner)
    if (this.#latest?.inputLifetimeRevision !== undefined
      && (next.inputLifetimeRevision === undefined || later(this.#latest.inputLifetimeRevision, next.inputLifetimeRevision))) {
      const failure = new PresentationScheduleError('ERR_PROTOCOL_VERSION', 'ordered native input lifetime regressed or disappeared')
      this.#faulted = true; this.#retire('native-input-lifetime-regression'); this.#report(failure); this.#emit(); throw failure
    }
    if (this.#latest?.sampleDemandRevision !== undefined
      && (next.sampleDemandRevision === undefined || later(this.#latest.sampleDemandRevision, next.sampleDemandRevision))) {
      const failure = new PresentationScheduleError('ERR_PROTOCOL_VERSION', 'ordered native sample demand regressed or disappeared')
      this.#faulted = true; this.#retire('native-sample-demand-regression'); this.#report(failure); this.#emit(); throw failure
    }
    if (!familyMatches(next)) {
      this.#sequence = sequence; this.#restartRequired = true
      this.#retire('renderer-profile-change')
      const failure = new PresentationScheduleError('ERR_UNSUPPORTED_CAPABILITY', 'renderer profile changed transport family', { requiresRestart: true })
      this.#report(failure); this.#emit(); throw failure
    }
    const changed = this.#latest === null || hardKey(this.#latest) !== hardKey(next)
    if (!changed && (later(this.#latest.templateRevision, next.templateRevision) || later(this.#latest.renderRevision, next.renderRevision))) {
      const failure = new PresentationScheduleError('ERR_PROTOCOL_VERSION', 'ordered runtime revisions regressed')
      this.#faulted = true; this.#retire('runtime-revision-regression'); this.#report(failure); this.#emit(); throw failure
    }
    this.#sequence = sequence
    // Commit the new authoritative observation before freeze/cancel/abort can
    // synchronously reenter observe(). No outer assignment may overwrite a
    // newer observation installed by an injected callback.
    this.#latest = next
    const recovery = this.#surfaceRecovery
    if (recovery && !recoverySourceMatches(recovery.source, next)) {
      recovery.base = null; recovery.invalidated = true
    }
    if (changed) this.#retire('logical-input-lifetime-change')
    this.#schedule(); this.#emit()
    return Object.freeze({ accepted: true, hardBoundary: changed })
  }

  #retire(reason) {
    const pending = this.#raf, flight = this.#flight
    this.#retiring++
    this.#epoch++
    this.#raf = null
    if (this.#accepted) this.#retiredPicture = Object.freeze({ ...this.#accepted, inputEnabled: false })
    this.#accepted = null; this.#failed = null; this.#retryKind = null
    // Capture old resources and finish the internal transition before any
    // callback. Nested observations may replace demand, but admission waits
    // for this exact retirement's cancellation/abort barrier to finish.
    try {
      this.#freeze(reason)
      this.#cancelPendingRaf(pending, reason)
      flight?.controller.abort(reason)
    } finally {
      this.#retiring--
    }
  }

  #plan() {
    if (this.#closing || this.#closed || this.#suspended || this.#restartRequired || this.#faulted || !runnable(this.#latest)) return null
    const current = this.#latest
    const accepted = this.#accepted ?? this.#recoveryBase()
    let kind = !accepted || (accepted === this.#accepted && accepted.hardKey !== hardKey(current))
      ? 'template' : newerPresentationKind(current, accepted.proof) ?? this.#retryKind
    if (!kind) return null
    if (kind === 'paint' && (!accepted || current.owner.transportBackend === 'browser-view'
      && (current.sampleDemandRevision === undefined || accepted.proof.consumedSample === undefined))) kind = 'template'
    const failed = this.#failed
    if (!this.#retryKind && failed?.hardKey === hardKey(current)) {
      const templateWatermark = failed.proof?.consumedInput.templateRevision ?? failed.demand.templateRevision
      const renderWatermark = failed.proof?.publication.kind === 'external-frame' ? failed.proof.publication.renderRevision : failed.demand.renderRevision
      const sampleWatermark = failed.proof?.consumedSample?.demandRevision ?? failed.demand.sampleDemandRevision
      const newerSample = current.owner.transportBackend === 'browser-view' && current.sampleDemandRevision !== undefined
        && (sampleWatermark === undefined || later(current.sampleDemandRevision, sampleWatermark))
      if (!later(current.templateRevision, templateWatermark) && !newerSample
        && (current.owner.transportBackend === 'browser-view' || !later(current.renderRevision, renderWatermark))) return null
    }
    return kind
  }

  #recoveryBase() {
    const recovery = this.#surfaceRecovery, current = this.#latest
    if (!recovery?.resumed || recovery.kind !== 'retained' || !recoveryInputMatches(recovery.base, recovery.source, current)
      || !later(current.surfaceGeneration, recovery.source.surfaceGeneration)
      || !later(current.renderRevision, recovery.base.proof.publication.renderRevision)) return null
    return recovery.base
  }

  #retainRecoveryProof(flight) {
    const recovery = this.#surfaceRecovery
    if (!flight.proof || !recovery || recovery.flight !== flight || recovery.resumed || recovery.invalidated
      || flight.proof.surfaceGeneration !== recovery.source?.surfaceGeneration) return
    const base = Object.freeze({ hardKey: hardKey(flight.demand), proof: flight.proof, inputEnabled: false })
    if (recoveryInputMatches(base, recovery.source, this.#latest)) recovery.base = base
  }

  #schedule() {
    if (this.#flight || this.#raf || this.#rafRegistration || this.#retiring || !this.#plan()) return
    // Worker preparation has no visible effect. Coalesce observations in this
    // turn, then start the asynchronous clone without spending a refresh period.
    // Retire/close clear this exact token just like a pending start RAF; only
    // the later visible presentation owns a browser RAF handle.
    if (this.#preparationScheduling === 'microtask') {
      const pending = { kind: 'start', handle: null }
      this.#raf = pending
      queueMicrotask(() => {
        if (this.#raf !== pending) return
        this.#raf = null; pending.completed = true
        this.#start()
      })
      return
    }
    const pending = { kind: 'start', handle: null }
    try {
      this.#registerRaf(pending, () => this.#start())
    } catch (failure) {
      if (this.#raf === pending) this.#raf = null
      this.#faulted = true; this.#freeze('raf-request-failed'); this.#report(failure)
    } finally {
      // A hard fence can arrive while requestFrame is still returning its
      // handle. Start its successor only after that exact handle is cancelled.
      if (this.#raf !== pending) this.#schedule()
    }
  }

  #start() {
    const kind = this.#plan()
    if (!kind || this.#flight) return
    if (this.#attemptSequence === 18446744073709551615n) {
      this.#faulted = true; this.#freeze('attempt-id-exhausted')
      this.#report(new PresentationScheduleError('ERR_RENDER', 'presentation attempt ID exhausted')); this.#emit(); return
    }
    const flight = {
      id: String(++this.#attemptSequence), epoch: this.#epoch, demand: this.#latest,
      accepted: this.#accepted ?? this.#recoveryBase(), kind, controller: new AbortController(),
      prepared: undefined, hasPrepared: false, proof: null, committed: false, phase: 'preparing', promise: null,
    }
    let resolve, reject
    flight.promise = new Promise((done, failed) => { resolve = done; reject = failed })
    this.#flight = flight; this.#retryKind = null
    this.#freeze('presentation-start')
    // Publish the stable flight promise before calling any injected code. Even
    // synchronous freeze/prepare callbacks may call close() reentrantly.
    if (!this.#current(flight)) {
      if (this.#flight === flight) this.#flight = null
      resolve(); this.#schedule(); this.#emit(); return
    }
    void this.#run(flight).then(resolve, reject)
    this.#emit()
  }

  #current(flight) {
    return !this.#closing && !this.#closed && !this.#suspended && !this.#restartRequired && !this.#faulted && this.#flight === flight && this.#epoch === flight.epoch && !flight.controller.signal.aborted
  }
  #context(flight) {
    return Object.freeze({ owner: this.#owner, attemptId: flight.id, surfaceGeneration: flight.demand.surfaceGeneration,
      signal: flight.controller.signal, isCurrent: () => this.#current(flight),
      // A clone may outlive public cancellation or local presenter creation.
      // This exact-flight lane retains only validated immutable scheduling
      // evidence. It creates no candidate, ACK, acceptance or input authority.
      retainFrameProof: raw => this.#captureFrameProof(flight, raw) })
  }
  #captureFrameProof(flight, raw) {
    const recovery = this.#surfaceRecovery
    if (this.#closing || this.#closed || this.#faulted || this.#restartRequired
      || (this.#flight !== flight && (!recovery || recovery.flight !== flight || recovery.resumed || recovery.invalidated))) return false
    const proof = preparedProof(raw, flight)
    if (flight.proof && (!samePublication(flight.proof.publication, proof.publication)
      || !sameInput(flight.proof.consumedInput, proof.consumedInput)
      || !sameSample(flight.proof.consumedSample, proof.consumedSample))) fail('one preparation attempt cannot replace its clone proof')
    flight.proof ??= proof
    this.#retainRecoveryProof(flight)
    return true
  }
  #ensureCurrent(flight) {
    if (!this.#current(flight)) throw new PresentationScheduleError('ERR_CANCELLED', 'presentation attempt was retired', { localCancellation: true })
  }

  #nextFrame(flight) {
    this.#ensureCurrent(flight)
    return new Promise((resolve, reject) => {
      const pending = { kind: 'present', handle: null, reject, cleanup: null }
      const abort = () => {
        if (this.#raf !== pending) return
        this.#raf = null
        this.#cancelPendingRaf(pending, 'presentation retired')
      }
      pending.cleanup = () => flight.controller.signal.removeEventListener('abort', abort)
      flight.controller.signal.addEventListener('abort', abort, { once: true })
      try {
        this.#registerRaf(pending, resolve)
      } catch (failure) {
        if (this.#raf === pending) this.#raf = null
        pending.cleanup(); reject(failure)
      }
    })
  }
  #registerRaf(pending, callback) {
    this.#raf = pending; this.#rafRegistration = pending
    try {
      const handle = this.#requestFrame(timestamp => {
        if (this.#raf !== pending) return
        this.#raf = null; pending.completed = true; pending.cleanup?.()
        callback(timestamp)
      })
      pending.handle = handle; pending.registered = true
      // close()/observe() may have retired this RAF synchronously before its
      // real handle was returned. Never cancel null or a successor's handle.
      if (pending.cancelled && !pending.completed) this.#cancelRafHandle(pending)
    } finally {
      if (this.#rafRegistration === pending) this.#rafRegistration = null
    }
  }
  #cancelRafHandle(pending) {
    if (pending.cancelIssued) return
    pending.cancelIssued = true
    try { this.#cancelFrame(pending.handle) } catch (failure) {
      this.#cleanupErrors.push(failure); this.#faulted = true
      this.#freeze('raf-cancellation-failed'); this.#report(failure)
    }
  }
  #cancelPendingRaf(pending, reason) {
    if (!pending || pending.cancelled) return
    pending.cancelled = true
    // Settle/remove local waiters before calling an injected cancelFrame.
    pending.cleanup?.()
    pending.reject?.(new PresentationScheduleError('ERR_CANCELLED', reason, { localCancellation: true }))
    if (pending.registered && !pending.completed) this.#cancelRafHandle(pending)
  }

  #failureRecord(flight, failure) {
    return Object.freeze({ hardKey: hardKey(flight.demand), kind: flight.kind, demand: flight.demand, proof: flight.proof, error: failure })
  }
  #recordFailure(flight, failure) {
    this.#failed = this.#failureRecord(flight, failure)
    this.#freeze('presentation-failed'); this.#report(failure)
  }

  async #run(flight) {
    const context = this.#context(flight)
    try {
      flight.prepared = await (flight.kind === 'template'
        ? this.#adapter.prepareTemplate(flight.demand, context)
        : this.#adapter.preparePaint(flight.demand, flight.accepted, context))
      flight.hasPrepared = true
      // Copy/validate BEFORE RAF, presentation and ACK can run any callbacks.
      // A retired clone may still be the Worker's exact retained frame. Keep
      // its verified proof for recovery only; it never grants input authority.
      this.#captureFrameProof(flight, flight.prepared?.proof)
      this.#ensureCurrent(flight)
      flight.phase = 'presenting'; this.#emit()
      const timestamp = await this.#nextFrame(flight)
      this.#ensureCurrent(flight)
      const outcome = await this.#adapter.present(flight.prepared, Object.freeze({ ...context, proof: flight.proof, timestamp }))
      const final = finalOutcome(outcome, flight.proof)
      // A final ACK can have become irreversible before a concurrent hard fence.
      // Cleanup must know this even though retired work cannot become accepted.
      flight.committed = true
      this.#ensureCurrent(flight)
      this.#accepted = Object.freeze({ hardKey: hardKey(flight.demand), proof: flight.proof, inputEnabled: final.inputEnabled })
      this.#surfaceRecovery = null
      // Ready/ACK effects may invalidate this exact publication without a
      // hard input fence. Its visual commit remains genuine, while the ordered
      // newer demand already requires a successor. Keep input frozen until that
      // successor's own ACK; do not misreport ordinary supersession as failure.
      const superseded = !final.inputEnabled && !final.requiresRestart
        && hardKey(this.#latest) === hardKey(flight.demand)
        && sameOwner(this.#latest.owner, flight.proof.owner)
        && newerPresentationKind(this.#latest, flight.proof) !== null
      const failure = final.inputEnabled || superseded ? null : new PresentationScheduleError('ERR_RENDER', 'presentation committed with input disabled', { committed: true })
      this.#failed = failure ? this.#failureRecord(flight, failure) : null
      if (final.requiresRestart) this.#restartRequired = true
      // Install the full final outcome before notification callbacks can close
      // or advance authority. No old final state is written afterward.
      if (failure || final.requiresRestart || superseded) this.#freeze(final.requiresRestart ? 'renderer-restart-required' : superseded ? 'presentation-superseded' : 'presentation-failed')
      if (failure) this.#report(failure)
    } catch (failure) {
      if (this.#current(flight)) this.#recordFailure(flight, failure)
    } finally {
      if (flight.hasPrepared) {
        try {
          await this.#adapter.release(flight.prepared, Object.freeze({ owner: this.#owner, attemptId: flight.id, proof: flight.proof, committed: flight.committed, retired: !this.#current(flight) }))
        } catch (failure) {
          this.#cleanupErrors.push(failure)
          if (this.#current(flight)) this.#failed = this.#failureRecord(flight, failure)
          // A rejected release does not prove old execution/resources ended.
          // Do not admit a successor or retry on top of that uncertain cleanup.
          this.#faulted = true; this.#freeze('candidate-cleanup-failed')
          this.#report(failure)
        }
      }
      if (this.#flight === flight) this.#flight = null
      this.#schedule(); this.#emit()
    }
  }

  /** Local presentation fence. Does not manufacture a native observation or
   * generation. An irreversible ACK is still released with its actual outcome.
   * Resuming keeps accepted empty and must obtain another real publication. */
  suspend(reason = 'owner-transition') {
    this.#checkOpen()
    this.#surfaceRecovery = null
    this.#suspended = true
    this.#retire(reason)
    this.#emit()
    return true
  }

  /** A recoverable GPU loss fences input immediately without closing the
   * Worker. The returned ticket settles only after the exact retired flight's
   * release barrier; callers separately drain their presenter's owned work.
   * Its base is historical proof, never accepted input authority. */
  suspendOwnedSurface(reason = 'surface-loss') {
    this.#checkOpen()
    if (this.#owner.transportBackend !== 'external-frame') throw new PresentationScheduleError('ERR_UNSUPPORTED_CAPABILITY', 'surface recovery requires an external-frame owner')
    if (this.#surfaceRecovery && !this.#surfaceRecovery.resumed) return this.#surfaceRecovery.promise
    if (this.#recoverySequence === 18446744073709551615n) throw new PresentationScheduleError('ERR_RENDER', 'surface recovery ID exhausted')
    const active = this.#flight
    const preparing = active?.proof ? Object.freeze({ hardKey: hardKey(active.demand), proof: active.proof, inputEnabled: false }) : null
    const source = this.#latest, accepted = preparing ?? this.#accepted ?? this.#surfaceRecovery?.base
    const base = recoveryInputMatches(accepted, source, source)
      ? Object.freeze({ ...accepted, inputEnabled: false }) : null
    const flight = active?.promise
    let resolve, reject
    const recovery = { id: String(++this.#recoverySequence), source, base, flight: active, invalidated: false, kind: null, drained: false, resumed: false, ticket: null,
      promise: new Promise((done, failed) => { resolve = done; reject = failed }) }
    // Publish the stable transaction before freeze/abort invokes user code.
    this.#surfaceRecovery = recovery; this.#suspended = true
    this.#retire(reason); this.#emit()
    const drain = async () => {
      await flight
      this.#checkOpen()
      if (this.#surfaceRecovery !== recovery) throw new PresentationScheduleError('ERR_CANCELLED', 'surface recovery transaction was retired')
      // Dirtiness or a hard boundary while draining invalidates this token.
      // It cannot be relabelled with a newer frame returned by the Worker.
      const retained = recoveryInputMatches(recovery.base, source, this.#latest)
        && hardKey(source) === hardKey(this.#latest) ? recovery.base : null
      recovery.base = retained; recovery.drained = true
      recovery.ticket = Object.freeze({ version: '1.0', recoveryId: recovery.id, source, base: retained })
      this.#emit()
      return recovery.ticket
    }
    void drain().then(resolve, reject)
    return recovery.promise
  }

  /** A real native observation must advance input lifetime before a new
   * surface can be admitted. A restored event or an HTTP receipt is not proof.
   * Incompatible input takes the ordinary template path after this fence. */
  resumeOwnedSurface(ticket, outcome) {
    this.#checkOpen()
    const recovery = this.#surfaceRecovery
    if (!recovery || !recovery.drained || recovery.ticket !== ticket || recovery.resumed) throw new PresentationScheduleError('ERR_CANCELLED', 'surface recovery ticket is stale')
    if (!object(outcome) || outcome.version !== '1.0' || !['retained', 'render-required'].includes(outcome.kind) || outcome.sessionId !== this.#owner.sessionId) fail('surface recovery requires a versioned native outcome')
    const previousRender = u64(outcome.previousRenderRevision, 'previous recovery render revision')
    const nextRender = u64(outcome.renderRevision, 'recovery render revision')
    const previousLifetime = u64(outcome.previousInputLifetimeRevision, 'previous recovery input lifetime')
    const nextLifetime = u64(outcome.inputLifetimeRevision, 'recovery input lifetime')
    if (!later(nextLifetime, previousLifetime) || (outcome.kind === 'retained' ? !later(nextRender, previousRender) : nextRender !== previousRender)) fail('native recovery outcome did not advance the required revision')
    if (!this.#latest || !recovery.source || !later(this.#latest.surfaceGeneration, recovery.source.surfaceGeneration)) throw new PresentationScheduleError('ERR_CANCELLED', 'surface recovery requires a new native input lifetime')
    if (later(nextRender, this.#latest.renderRevision)) throw new PresentationScheduleError('ERR_CANCELLED', 'native recovery observation has not arrived')
    recovery.kind = outcome.kind; recovery.resumed = true; this.#suspended = false
    const retained = this.#recoveryBase() !== null
    this.#schedule(); this.#emit()
    return Object.freeze({ resumed: true, retained })
  }
  resume() {
    this.#checkOpen()
    if (this.#surfaceRecovery) throw new PresentationScheduleError('ERR_CANCELLED', 'surface recovery requires its native-fenced ticket')
    if (!this.#suspended) return false
    this.#suspended = false
    this.#schedule(); this.#emit()
    return true
  }

  retry() {
    this.#checkOpen()
    if (!this.#failed || !runnable(this.#latest)) return false
    this.#retryKind = this.#failed.kind
    this.#failed = null
    this.#schedule(); this.#emit()
    return true
  }

  /** Same Promise on every call. Cancellation precedes flight/resource drain. */
  close() {
    if (this.#closePromise) return this.#closePromise
    let resolve, reject
    this.#closePromise = new Promise((done, failed) => { resolve = done; reject = failed })
    const pending = this.#raf, active = this.#flight, flight = active?.promise
    this.#closing = true; this.#epoch++
    this.#raf = null
    this.#freeze('scheduler closing'); this.#emit()
    this.#cancelPendingRaf(pending, 'scheduler closing')
    active?.controller.abort('scheduler closing')
    const finish = async () => {
      const failures = []
      // This must settle owned pending work without destroying the transport
      // needed by release(). It cannot await this scheduler's flight itself.
      try { await this.#adapter.cancelOwnedWork('scheduler closing') } catch (failure) { failures.push(failure); this.#report(failure) }
      try { await flight } catch (failure) { failures.push(failure); this.#report(failure) }
      try { await this.#adapter.dispose() } catch (failure) { failures.push(failure); this.#report(failure) }
      failures.push(...this.#cleanupErrors)
      this.#closing = false; this.#closed = true; this.#emit()
      if (failures.length) throw new AggregateError([...new Set(failures)], 'presentation scheduler cleanup failed')
      return Object.freeze({ closed: true })
    }
    void finish().then(resolve, reject)
    return this.#closePromise
  }
}
