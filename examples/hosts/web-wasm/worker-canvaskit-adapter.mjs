/** Proposed Worker-only external-frame adapter. No runtime, HTTP or WASM owner. */
import { CanvasKitFramePresenter } from './canvaskit-presenter.mjs'
import { copyExternalFrameScheduling, copyExternalPresentationOutcome, copyExternalFrameTarget } from './worker-runtime.mjs'
import { measureWorkerPayload, takeWorkerFrameResponse } from './worker-session-client.mjs'
import { workerFrameResponseLimits } from './worker-frame-wire.mjs'

export class WorkerCanvasKitAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'WorkerCanvasKitAdapterError'
    this.code = code
    Object.assign(this, details)
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message, details) => { throw new WorkerCanvasKitAdapterError(code, message, details) }
const cancelled = () => fail('ERR_CANCELLED', 'CanvasKit presentation attempt was retired')
const u64 = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
  && value.length <= 20 && BigInt(value) <= 18446744073709551615n
const sameRect = (a, b) => record(a) && record(b) && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key])
const sameOwner = (a, b) => record(a) && record(b)
  && ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend', 'presenterGeneration'].every(key => a[key] === b[key])
const sameInput = (a, b) => record(a) && record(b) && a.pageId === b.pageId && a.routePath === b.routePath
  && a.templateRevision === b.templateRevision && sameRect(a.viewport, b.viewport)
const sameProof = (a, b) => record(a) && record(b) && a.version === b.version && a.attemptId === b.attemptId
  && a.surfaceGeneration === b.surfaceGeneration && sameOwner(a.owner, b.owner) && sameInput(a.consumedInput, b.consumedInput)
  && a.publication?.kind === 'external-frame' && b.publication?.kind === 'external-frame'
  && a.publication.renderRevision === b.publication.renderRevision
const sameSize = (a, b) => a?.width === b?.width && a?.height === b?.height
const copyData = (value, op) => {
  measureWorkerPayload(value, workerFrameResponseLimits(op, { status: 'ok', result: value }, { maxBytes: 16 * 1024 * 1024 }))
  return structuredClone(value)
}
const aggregate = (errors, message) => errors.length === 1 ? errors[0] : new AggregateError(errors, message)
const callback = value => value === undefined || typeof value === 'function'

function copyOwner(value) {
  value = copyData(value)
  if (!record(value) || !['workerEpoch', 'sessionId'].every(key => typeof value[key] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value[key]))
    || typeof value.packSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.packSha256)
    || value.transportBackend !== 'external-frame' || value.presenterGeneration !== undefined && (!u64(value.presenterGeneration) || value.presenterGeneration === '0')) fail('ERR_PROTOCOL_VERSION', 'an immutable external-frame owner is required')
  return Object.freeze({ workerEpoch: value.workerEpoch, sessionId: value.sessionId,
    packSha256: value.packSha256, transportBackend: 'external-frame',
    ...(value.presenterGeneration === undefined ? {} : { presenterGeneration: value.presenterGeneration }) })
}

// A local queue receipt is evidence of submission, never of runtime acceptance
// or physical GPU hardware. Project only bounded data before the visible swap;
// presenter/context internals must remain owned by their adapter surface.
function copySubmission(receipt, candidate, owner) {
  // Read every allowed property once: an injected presenter cannot change a
  // getter between admission and publication, and extras are never traversed.
  const pick = (value, keys) => record(value) ? Object.fromEntries(keys.map(key => [key, value[key]])) : null
  receipt = pick(receipt, ['schemaVersion', 'status', 'backend', 'frameId', 'generation', 'viewport', 'physicalSize',
    'context', 'runtimeBoundary', 'presentation'])
  if (receipt) {
    receipt.viewport = pick(receipt.viewport, ['x', 'y', 'width', 'height'])
    const size = receipt.physicalSize
    receipt.physicalSize = Array.isArray(size) && size.length === 2 ? [size[0], size[1]] : null
    receipt.context = pick(receipt.context, ['api', 'version', 'vendor', 'renderer', 'unmaskedVendor', 'unmaskedRenderer',
      'surfaceIsGpu', 'contextLost', 'physicalHardware'])
    receipt.runtimeBoundary = pick(receipt.runtimeBoundary, ['frameBatches', 'perNodeRuntimeCalls', 'softwareRgbaUploads'])
    receipt.presentation = pick(receipt.presentation, ['pictureSubmissions', 'flushes', 'gpuCompletion', 'glError'])
  }
  const context = receipt?.context, boundary = receipt?.runtimeBoundary, presentation = receipt?.presentation
  const text = (value, nullable = false) => nullable && value === null || typeof value === 'string'
    && value.length > 0 && value.length <= 512 && new TextEncoder().encode(value).byteLength <= 512
  if (!record(receipt) || receipt.schemaVersion !== 1 || receipt.status !== 'submitted'
    || receipt.backend !== 'canvaskit-webgl2' || !Number.isSafeInteger(receipt.frameId) || receipt.frameId < 0
    || receipt.frameId !== candidate.frame.frame_id || !Number.isSafeInteger(receipt.generation)
    || receipt.generation !== candidate.surface.presenterGeneration + 1
    || !sameRect(receipt.viewport, candidate.frame.viewport) || !Array.isArray(receipt.physicalSize)
    || receipt.physicalSize.length !== 2 || receipt.physicalSize[0] !== candidate.target.width
    || receipt.physicalSize[1] !== candidate.target.height || !record(context) || context.api !== 'webgl2'
    || !['version', 'vendor', 'renderer'].every(key => text(context[key]))
    || !['unmaskedVendor', 'unmaskedRenderer'].every(key => text(context[key], true))
    || context.surfaceIsGpu !== true || context.contextLost !== false || context.physicalHardware !== 'unknown'
    || !record(boundary) || boundary.frameBatches !== 1 || boundary.perNodeRuntimeCalls !== 0 || boundary.softwareRgbaUploads !== 0
    || !record(presentation) || presentation.pictureSubmissions !== 1 || presentation.flushes !== 1
    || presentation.gpuCompletion !== 'not-waited' || presentation.glError !== 0) {
    fail('ERR_RENDER', 'presenter did not produce the exact bounded local submission receipt')
  }
  return Object.freeze({ version: '1.0', status: 'submitted', owner,
    attemptId: candidate.proof.attemptId, surfaceGeneration: candidate.proof.surfaceGeneration,
    renderRevision: candidate.proof.publication.renderRevision, frameId: receipt.frameId, presenterGeneration: receipt.generation,
    viewport: Object.freeze({ x: receipt.viewport.x, y: receipt.viewport.y, width: receipt.viewport.width, height: receipt.viewport.height }),
    physicalSize: Object.freeze({ width: receipt.physicalSize[0], height: receipt.physicalSize[1] }), backend: 'canvaskit-webgl2',
    context: Object.freeze({ api: 'webgl2', version: context.version, vendor: context.vendor, renderer: context.renderer,
      unmaskedVendor: context.unmaskedVendor, unmaskedRenderer: context.unmaskedRenderer,
      surfaceIsGpu: true, contextLost: false, physicalHardware: 'unknown' }),
    runtimeBoundary: Object.freeze({ frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 }),
    presentation: Object.freeze({ pictureSubmissions: 1, flushes: 1, gpuCompletion: 'not-waited', glError: 0 }) })
}

function copyCanvasAttributes(previous, next) {
  const allowed = name => ['id', 'class', 'style', 'tabindex', 'role', 'title', 'accesskey', 'lang', 'dir', 'inert', 'hidden'].includes(name)
    || name.startsWith('aria-') || name.startsWith('data-')
  for (const attribute of Array.from(next.attributes)) if (allowed(attribute.name)) next.removeAttribute(attribute.name)
  for (const attribute of Array.from(previous.attributes)) if (allowed(attribute.name)) next.setAttribute(attribute.name, attribute.value)
}

/** Synchronous installation contract: commit immediately after the visible swap. */
function installOwnedSurface({ previousCanvas, canvas, commit }) {
  copyCanvasAttributes(previousCanvas, canvas)
  const document = previousCanvas.ownerDocument
  const restoreFocus = document.hasFocus() && !document.hidden && document.activeElement === previousCanvas
  previousCanvas.replaceWith(canvas)
  commit()
  if (restoreFocus) canvas.focus({ preventScroll: true })
}

/**
 * A scheduler adapter borrowing one WorkerRpcClient. CanvasKit and font bytes
 * must already have passed the owner's asset-admission gate. The explicit
 * physical target must come from the negotiated exact Worker frame metadata.
 * The dedicated initial canvas is transferred to this adapter, including remove.
 */
export class WorkerCanvasKitAdapter {
  #owner; #rpc; #responseOwner; #factory; #createCanvas; #installSurface; #resolveTarget; #sinks
  #current; #spare; #surfaces = new Set(); #candidates = new WeakMap(); #records = new Set()
  #work = new Set(); #active = null; #input = null; #inputEpoch = 0n; #ackWatermark = 0n; #lastAck = null
  #closing = false; #disposed = false; #cancelPromise = null; #disposePromise = null
  #cleanupErrors = []; #diagnostics = []; #fatal = null
  #surfaceSuspended = false; #surfaceDrain = null; #surfaceDrainState = null; #lossSerial = 0n; #remoteActual = new Set()
  #timingFailures = 0

  constructor({ owner, rpc, frameResponseOwner = rpc, externalPresentation, canvas, canvasOwned, CanvasKit, fontData, presenterOptions,
    presenterFactory, createCanvas, installSurface, resolveTarget, onBatch, onAck, onSurface, onSurfaceLost, onInput, onError, onTiming } = {}) {
    this.#owner = copyOwner(owner)
    if (!rpc || typeof rpc.requestHost !== 'function' || rpc.actualFinalContract !== '1.0' || rpc.workerEpoch !== this.#owner.workerEpoch
      || rpc.sessionId !== this.#owner.sessionId) fail('ERR_PROTOCOL_VERSION', 'RPC identity does not match the immutable owner')
    if (!record(externalPresentation) || Object.keys(externalPresentation).length !== 4
      || !['version', 'consumedInput', 'ackOutcome', 'physicalTarget'].every(key => externalPresentation[key] === '1.0')) {
      fail('ERR_PROTOCOL_VERSION', 'the owner must negotiate consumedInput, genuine ACK outcome and physical target 1.0 before attachment')
    }
    if (canvasOwned !== true || !canvas || typeof canvas.addEventListener !== 'function'
      || typeof canvas.removeEventListener !== 'function' || typeof canvas.remove !== 'function') {
      fail('ERR_INVALID_REQUEST', 'a dedicated owned canvas is required')
    }
    if (typeof onBatch !== 'function'
      || ![resolveTarget, presenterFactory, createCanvas, installSurface, onAck, onSurface, onSurfaceLost, onInput, onError, onTiming].every(callback)) {
      fail('ERR_INVALID_REQUEST', 'a synchronous batch sink and valid target/surface hooks are required')
    }
    if (!presenterFactory && (!CanvasKit || !(fontData instanceof ArrayBuffer))) {
      fail('ERR_RENDER', 'admitted CanvasKit/font resources or an injected presenter factory are required')
    }
    this.#rpc = rpc; this.#responseOwner = frameResponseOwner; this.#resolveTarget = resolveTarget ?? (({ target }) => target)
    this.#factory = presenterFactory ?? (({ canvas: target }) => CanvasKitFramePresenter.create(CanvasKit, target, fontData, presenterOptions))
    this.#createCanvas = createCanvas ?? (({ previousCanvas }) => previousCanvas.ownerDocument.createElement('canvas'))
    this.#installSurface = installSurface ?? installOwnedSurface
    this.#sinks = { onBatch, onAck, onSurface, onSurfaceLost, onInput, onError, onTiming }
    this.#current = this.#ownSurface(canvas, null)
    this.#current.installed = true
  }

  get owner() { return this.#owner }
  get canvas() { return this.#current?.canvas ?? null }
  get inputAuthority() { return this.#input }
  get status() {
    return Object.freeze({ closing: this.#closing, disposed: this.#disposed, inputEnabled: this.#input !== null,
      pendingOperations: this.#work.size, ownedSurfaces: this.#surfaces.size,
      ownedPresenters: [...this.#surfaces].filter(surface => surface.presenter || surface.creating).length,
      physicalSize: this.#current?.size ?? null, lastAck: this.#lastAck,
      surfaceSuspended: this.#surfaceSuspended, surfaceDrainState: this.#surfaceDrainState, actualRemoteOperations: this.#remoteActual.size,
      inputTimingObserverFailures: this.#timingFailures,
      diagnostics: Object.freeze([...this.#diagnostics]) })
  }

  #timing(stage, candidate, details = {}) {
    if (!this.#sinks.onTiming || !candidate?.proof) return
    // An optional diagnostic observer cannot veto a surface operation or
    // replace its real error. No observer promise joins the business barrier.
    try { const returned = this.#sinks.onTiming(Object.freeze({ stage, proof: candidate.proof, ...details }));
      if (returned && typeof returned.then === 'function') { this.#timingFailures++; void Promise.resolve(returned).catch(() => {}) }
    } catch { this.#timingFailures++ }
  }

  #call(name, value) {
    const result = this.#sinks[name]?.(value)
    if (result && typeof result.then === 'function') {
      // The synchronous contract violation below is already reported by its
      // caller. Retain a later rejection without recursively calling a bad sink.
      void Promise.resolve(result).catch(error => { this.#cleanupErrors.push(error); this.#fatal ??= error })
      fail('ERR_PROTOCOL_VERSION', `${name} must be synchronous and cannot hold a presentation/event lane`)
    }
  }
  #remember(error) {
    this.#diagnostics.push(error)
    if (this.#diagnostics.length > 32) this.#diagnostics.shift()
    this.#cleanupErrors.push(error); this.#fatal ??= error
    try { this.freezeInput('adapter-fault') } catch (failure) { this.#cleanupErrors.push(failure) }
    try { this.#call('onError', error) } catch (failure) { this.#cleanupErrors.push(failure) }
  }
  freezeInput(reason) {
    this.#input = null; this.#inputEpoch++
    this.#call('onInput', Object.freeze({ enabled: false, reason, owner: this.#owner, canvas: this.canvas }))
  }
  #check(context, controller) {
    if (!sameOwner(context?.owner, this.#owner) || !u64(context?.attemptId) || !u64(context?.surfaceGeneration)
      || typeof context?.isCurrent !== 'function') fail('ERR_PROTOCOL_VERSION', 'invalid exact scheduler attempt context')
    if (this.#closing || this.#disposed || this.#surfaceSuspended || context.signal?.aborted || controller?.signal.aborted || !context.isCurrent()) cancelled()
    if (this.#fatal) throw this.#fatal
  }
  #checkCandidate(candidate, context, controller) {
    this.#check(context, controller)
    if (candidate.released || this.#active !== candidate || candidate.inputEpoch !== this.#inputEpoch) cancelled()
  }

  async #rejectAsyncSurfaceHook(value, message) {
    const violation = new WorkerCanvasKitAdapterError('ERR_PROTOCOL_VERSION', message)
    // A violating hook can still own GPU/DOM work. Keep this exact operation
    // in #work until its real last-use Promise settles, even after abort. This
    // observes rejection and prevents dispose/reuse racing the invalid hook.
    // Settlement never upgrades the hook to an accepted submit/install/ACK.
    try { await value } catch (error) { violation.cause = error }
    throw violation
  }

  #run(context, action) {
    let resolve, reject
    const promise = new Promise((done, failed) => { resolve = done; reject = failed })
    const operation = { controller: new AbortController(), promise }
    this.#work.add(operation)
    const abort = () => operation.controller.abort(context?.signal?.reason)
    // Publish the owned promise before any signal/injected callback can close.
    void Promise.resolve().then(async () => {
      let result, failure
      try {
        context?.signal?.addEventListener('abort', abort, { once: true })
        if (context?.signal?.aborted) abort()
        this.#check(context, operation.controller)
        result = await action(operation.controller)
      } catch (error) { failure = error }
      try { context?.signal?.removeEventListener('abort', abort) } catch (error) {
        failure = failure ? aggregate([failure, error], 'operation and abort-listener cleanup failed') : error
      }
      this.#work.delete(operation)
      if (failure) reject(failure); else resolve(result)
    })
    return promise
  }

  #deliverBatch(raw) {
    if (raw === undefined) return
    const batch = copyData(raw)
    if (!record(batch) || !Array.isArray(batch.messages) || !batch.messages.every(message => record(message)
      && message.sessionId === this.#owner.sessionId && message.protocolVersion === '1.0'
      && typeof message.requestId === 'string' && ['request', 'response', 'event', 'batch'].includes(message.kind)
      && typeof message.op === 'string' && message.op.length > 0 && Object.hasOwn(message, 'payload'))) {
      fail('ERR_PROTOCOL_VERSION', 'frame/ACK effects must preserve a complete session-bound bridge batch')
    }
    this.#call('onBatch', batch)
  }
  #preserveFailure(error, { op, payload, context, candidate, late }) {
    // The ordered-lane finally can fail AFTER execute returned a genuine frame
    // or ACK. Its wire error then retains committedResult, while prior error
    // details live under originalDetails. Preserve effects without converting
    // that outer failure back to a successful present or enabling input.
    const visited = new Set(), delivered = new Set(), acknowledged = new Set(), stack = [{ value: error, depth: 0 }]
    while (stack.length) {
      const { value, depth } = stack.pop()
      if (!record(value) || visited.has(value) || depth > 8) continue
      visited.add(value)
      if (Object.hasOwn(value, 'batch') && !delivered.has(value.batch)) {
        delivered.add(value.batch); this.#deliverBatch(value.batch)
      }
      if (Object.hasOwn(value, 'committedResult')) {
        const committed = copyData(value.committedResult, op)
        if (Object.hasOwn(committed ?? {}, 'batch') && !delivered.has(value.committedResult.batch)) {
          delivered.add(value.committedResult.batch); this.#deliverBatch(committed.batch)
        }
        if (op === 'ack' && !acknowledged.has(value.committedResult)) {
          acknowledged.add(value.committedResult)
          const final = copyExternalPresentationOutcome(committed,
            { sessionId: this.#owner.sessionId, renderRevision: payload.renderRevision })
          candidate.ackOutcome = final; this.#recordAck(final)
          candidate.phase = 'acknowledged-with-error'
          this.#timing('runtime-ack', candidate, { late, failed: true })
          this.#call('onAck', Object.freeze({ outcome: final, late, failed: true, attemptId: context.attemptId }))
        }
      }
      for (const field of ['details', 'originalDetails']) if (record(value[field])) stack.push({ value: value[field], depth: depth + 1 })
    }
  }
  async #request(op, payload, context, controller, candidate) {
    let actualDone, actualFailed
    const actual = { promise: new Promise((resolve, reject) => { actualDone = resolve; actualFailed = reject }) }
    void actual.promise.catch(() => {})
    this.#remoteActual.add(actual)
    const finishActual = receipt => {
      if (!this.#remoteActual.has(actual)) return
      this.#remoteActual.delete(actual)
      if (receipt?.version === '1.0' && ['final', 'not-posted'].includes(receipt.status)) actualDone()
      else {
        const error = new WorkerCanvasKitAdapterError('ERR_RPC_CLEANUP', 'Worker ended without this owned request\'s genuine final', { receipt })
        this.#cleanupErrors.push(error); actualFailed(error)
      }
    }
    const late = message => {
      try {
        if (message?.payload?.status === 'ok') {
          const raw = copyData(message.payload.result, op)
          this.#deliverBatch(raw?.batch)
          if (op === 'frame' || op === 'frame.current') this.#retainFrameProof(raw, context, candidate)
          if (op === 'ack') {
            const final = copyExternalPresentationOutcome(raw, { sessionId: this.#owner.sessionId, renderRevision: payload.renderRevision })
            candidate.ackOutcome = final; this.#recordAck(final)
            this.#timing('runtime-ack', candidate, { late: true, inputEnabled: final.inputEnabled })
            this.#call('onAck', Object.freeze({ outcome: final, late: true, attemptId: context.attemptId }))
          }
        } else if (message?.payload?.status === 'error') {
          this.#preserveFailure(message.payload.error, { op, payload, context, candidate, late: true })
        }
      } catch (error) { this.#remember(error) }
      // Late effects are diagnostics/cleanup metadata, never input authority.
    }
    let result
    try { result = await this.#rpc.requestHost(op, payload, { signal: controller.signal, onLateResponse: late, onActualFinal: finishActual }) }
    catch (error) {
      // Caller abort/timeout does not prove the ordered Worker turn ended.
      // A recovery waits its genuine late final; close retains its own barrier.
      try { this.#preserveFailure(error, { op, payload, context, candidate, late: !context.isCurrent() }) }
      catch (effectsError) { throw aggregate([error, effectsError], 'Worker failure and retained effects delivery failed') }
      throw error
    }
    if (!takeWorkerFrameResponse(this.#responseOwner, result)) result = copyData(result, op)
    this.#deliverBatch(result?.batch)
    if (op === 'frame' || op === 'frame.current') this.#retainFrameProof(result, context, candidate)
    return result
  }
  #retainFrameProof(reply, context, candidate) {
    // Retain only the actual validated clone response, independently of local
    // cancellation and presenter last-use. This exact-flight evidence cannot
    // create a candidate, acknowledge a frame, or authorize application input.
    const { demand, accepted, kind } = candidate
    if (!record(reply) || !u64(reply.renderRevision) || reply.renderRevision === '0' || !record(reply.frame)) {
      fail('ERR_PROTOCOL_VERSION', 'Worker did not return an exact positive render frame')
    }
    const scheduling = copyExternalFrameScheduling(reply.scheduling,
      { sessionId: this.#owner.sessionId, renderRevision: reply.renderRevision, frame: reply.frame })
    const input = scheduling.consumedInput
    if (!input || !sameOwner(demand?.owner, this.#owner) || demand.currentPage?.pageId !== input.pageId
      || demand.currentPage?.path !== input.routePath || !sameRect(demand.viewport, input.viewport)
      || demand.surfaceGeneration !== context.surfaceGeneration || !u64(demand.templateRevision) || !u64(demand.renderRevision)
      || BigInt(reply.renderRevision) < BigInt(demand.renderRevision)
      || kind === 'template' && BigInt(input.templateRevision) < BigInt(demand.templateRevision)
      || kind === 'paint' && (!sameInput(input, accepted?.proof?.consumedInput)
        || !sameOwner(accepted?.proof?.owner, this.#owner)
        || accepted?.proof?.publication?.kind !== 'external-frame'
        || !u64(accepted.proof.publication.renderRevision)
        || BigInt(reply.renderRevision) <= BigInt(accepted.proof.publication.renderRevision))) {
      fail('ERR_PROTOCOL_VERSION', 'clone-time frame input does not satisfy this exact template/retained-paint demand')
    }
    if (BigInt(reply.renderRevision) <= this.#ackWatermark) {
      fail('ERR_PROTOCOL_VERSION', 'an ACK-issued render revision cannot be submitted or acknowledged again')
    }
    const wireTarget = copyExternalFrameTarget(reply.target, { sessionId: this.#owner.sessionId, renderRevision: reply.renderRevision })
    const proof = Object.freeze({ version: '1.0', attemptId: context.attemptId, owner: this.#owner,
      surfaceGeneration: context.surfaceGeneration, consumedInput: input,
      publication: Object.freeze({ kind: 'external-frame', renderRevision: reply.renderRevision }) })
    if (candidate.proof && !sameProof(candidate.proof, proof)) fail('ERR_PROTOCOL_VERSION', 'one candidate cannot replace its clone proof')
    candidate.proof ??= proof
    candidate.scheduling = scheduling; candidate.wireTarget = wireTarget
    this.#timing('clone', candidate, { inputTiming: reply.inputTiming, physicalSize: { width: wireTarget.width, height: wireTarget.height }, late: !context.isCurrent() })
    if (typeof context.retainFrameProof === 'function') {
      const retained = context.retainFrameProof(candidate.proof)
      if (retained && typeof retained.then === 'function') {
        void Promise.resolve(retained).catch(error => this.#remember(error))
        fail('ERR_PROTOCOL_VERSION', 'clone proof retention must be synchronous')
      }
    }
  }
  #recordAck(final) {
    if (!this.#lastAck || BigInt(final.renderRevision) > BigInt(this.#lastAck.renderRevision)) this.#lastAck = final
  }

  /** Owner calls after its real Worker close/termination barrier. */
  async finalizeRemoteWork() {
    await Promise.allSettled([...this.#remoteActual].map(operation => operation.promise))
    if (this.#cleanupErrors.length) throw aggregate([...new Set(this.#cleanupErrors)], 'owned remote finals or local cleanup failed')
    return Object.freeze({ version: '1.0', actualRemoteOperations: 0 })
  }

  #ownSurface(canvas, size) {
    const surface = { canvas, size, presenter: null, presenterGeneration: 0, creating: false, installed: false, invalid: false, disposed: false, uncertain: false }
    surface.onLost = event => {
      event?.preventDefault?.()
      const notified = surface.lossNotified
      surface.invalid = true
      surface.lossNotified = true
      if (!notified && !this.#closing && !this.#disposed
        && (surface.presenter || surface.creating)
        && (this.#current === surface || this.#active?.surface === surface || surface.creating)) {
        try {
          if (this.#lossSerial === 18446744073709551615n) fail('ERR_RENDER', 'local surface-loss observation space exhausted')
          this.suspendOwnedSurface('webgl-context-lost')
          this.#call('onSurfaceLost', Object.freeze({ version: '1.0', owner: this.#owner,
            lossId: String(++this.#lossSerial), reason: 'webglcontextlost' }))
        } catch (error) { this.#remember(error) }
      }
    }
    try { canvas.addEventListener('webglcontextlost', surface.onLost) }
    catch (error) {
      try { canvas.remove() } catch (cleanup) { throw aggregate([error, cleanup], 'surface listener initialization and cleanup failed') }
      throw error
    }
    this.#surfaces.add(surface)
    return surface
  }
  #disposeSurface(surface, keepCanvas = false) {
    if (!surface || surface.disposed) return
    if (surface.cleanupFailure) throw surface.cleanupFailure
    surface.disposed = true
    if (this.#spare === surface) this.#spare = null
    const errors = []
    const clean = action => { try { action() } catch (error) { errors.push(error) } }
    clean(() => surface.canvas.removeEventListener('webglcontextlost', surface.onLost))
    const presenter = surface.presenter
    if (presenter) clean(() => {
      const result = presenter.dispose()
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(error => this.#remember(error))
        fail('ERR_PROTOCOL_VERSION', 'presenter.dispose must release owned local resources synchronously')
      }
      surface.presenter = null
    })
    if (!keepCanvas) clean(() => surface.canvas.remove())
    if (errors.length) {
      const error = aggregate(errors, 'owned CanvasKit surface cleanup failed')
      // Retain the exact uncertain resource. A throwing/async destructor may
      // have partly freed it, so neither a retry nor close may double-delete
      // it or claim that this local surface was successfully released.
      surface.disposed = false; surface.uncertain = true; surface.cleanupFailure = error
      this.#cleanupErrors.push(error); this.#fatal ??= error
      throw error
    }
    this.#surfaces.delete(surface)
  }

  /** Nonterminal suspension; genuine remote finals and local last-use settle. */
  suspendOwnedSurface(reason = 'surface-lost', { retry = false } = {}) {
    if (retry && this.#fatal) return Promise.reject(this.#fatal)
    if (retry && this.#surfaceDrainState === 'failed' && !this.#fatal && !this.#work.size && !this.#remoteActual.size) {
      this.#surfaceDrain = null; this.#surfaceDrainState = null
    }
    if (this.#surfaceDrain) return this.#surfaceDrain
    let resolve, reject
    this.#surfaceDrain = new Promise((done, failed) => { resolve = done; reject = failed })
    void this.#surfaceDrain.catch(() => {})
    this.#surfaceSuspended = true; this.#surfaceDrainState = 'pending'
    const operations = [...this.#work], failures = []
    try { this.freezeInput(reason) } catch (error) { failures.push(error) }
    for (const operation of operations) operation.controller.abort(reason)
    void (async () => {
      const results = await Promise.allSettled(operations.map(operation => operation.promise))
      for (const result of results) if (result.status === 'rejected'
        && !['ERR_CANCELLED', 'ERR_RPC_CANCELLED'].includes(result.reason?.code)) failures.push(result.reason)
      await Promise.all([...this.#remoteActual].map(operation => operation.promise))
      if (failures.length) throw aggregate(failures, 'surface suspension could not establish actual last use')
      return Object.freeze({ version: '1.0', owner: this.#owner, suspended: true })
    })().then(value => { this.#surfaceDrainState = 'succeeded'; resolve(value) }, error => { this.#surfaceDrainState = 'failed'; reject(error) })
    return this.#surfaceDrain
  }

  /** Called only after scheduler release and native generation invalidation. */
  resumeOwnedSurface() {
    if (this.#closing || this.#disposed) cancelled()
    if (!this.#surfaceSuspended || this.#work.size || this.#records.size || this.#remoteActual.size) {
      fail('ERR_RENDER', 'surface recovery requires actual adapter/remote/release drain')
    }
    if (this.#fatal) throw this.#fatal
    const canvas = this.#current.canvas
    for (const surface of [...this.#surfaces]) this.#disposeSurface(surface, surface === this.#current)
    this.#current = this.#ownSurface(canvas, null); this.#current.installed = true
    this.#spare = null; this.#active = null; this.#surfaceDrain = null; this.#surfaceDrainState = null; this.#surfaceSuspended = false
    return Object.freeze({ version: '1.0', owner: this.#owner, readyForFreshSurface: true })
  }
  async #acquireSurface(target, context, controller) {
    if (this.#spare) {
      const spare = this.#spare; this.#spare = null
      if (!spare.disposed && !spare.invalid && sameSize(spare.size, target)) return spare
      this.#disposeSurface(spare)
    }
    this.#check(context, controller)
    if ([...this.#surfaces].filter(surface => surface.presenter || surface.creating).length >= 2) {
      fail('ERR_RENDER', 'two owned presenter slots are already occupied')
    }
    const canvas = this.#createCanvas({ previousCanvas: this.canvas, target, signal: controller.signal })
    if (!canvas || typeof canvas.then === 'function' || [...this.#surfaces].some(surface => surface.canvas === canvas)
      || typeof canvas.addEventListener !== 'function' || typeof canvas.removeEventListener !== 'function'
      || typeof canvas.remove !== 'function' || canvas.isConnected) fail('ERR_RENDER', 'surface factory must return a fresh detached owned canvas synchronously')
    canvas.width = target.width; canvas.height = target.height
    const size = Object.freeze({ width: target.width, height: target.height })
    const surface = this.#ownSurface(canvas, size)
    surface.creating = true
    try {
      // Already admitted assets only. An injected async factory must settle on
      // abort; close waits for its actual returned resource and exact cleanup.
      const presenter = await this.#factory({ canvas, target, signal: controller.signal })
      surface.creating = false; surface.presenter = presenter
      if (!presenter || typeof presenter.submit !== 'function' || typeof presenter.dispose !== 'function') {
        fail('ERR_RENDER', 'presenter factory returned no owned submit/dispose implementation')
      }
      this.#check(context, controller)
      if (surface.invalid || canvas.width !== target.width || canvas.height !== target.height) {
        fail('ERR_RENDER', 'candidate surface became unavailable or was resized during initialization')
      }
      return surface
    } catch (error) {
      surface.creating = false
      try { this.#disposeSurface(surface) } catch (cleanup) { throw aggregate([error, cleanup], 'presenter initialization/cancellation and cleanup failed') }
      throw error
    }
  }

  prepareTemplate(demand, context) { return this.#prepare('template', demand, null, context) }
  preparePaint(demand, accepted, context) { return this.#prepare('paint', demand, accepted, context) }
  #prepare(kind, demand, accepted, context) {
    return this.#run(context, async controller => {
      if (this.#active) fail('ERR_RENDER', 'another exact candidate still owns the presentation flight')
      if (this.#input !== null) this.freezeInput('adapter-prepare-start')
      const candidate = { kind, attemptId: context.attemptId, proof: null, surface: null, phase: 'preparing', installed: false,
        installationAttempted: false, ackStarted: false, ackOutcome: null, released: false, releasePromise: null,
        inputEpoch: this.#inputEpoch, demand, accepted }
      this.#active = candidate; this.#records.add(candidate)
      try {
        const reply = await this.#request(kind === 'template' ? 'frame' : 'frame.current', {}, context, controller, candidate)
        this.#check(context, controller)
        const { scheduling, wireTarget } = candidate
        const frameIdentity = Object.freeze({ frame_id: reply.frame.frame_id, viewport: Object.freeze({ ...reply.frame.viewport }) })
        const rawTarget = this.#resolveTarget(Object.freeze({ frame: frameIdentity, scheduling, target: wireTarget, owner: this.#owner,
          signal: controller.signal }))
        if (rawTarget && typeof rawTarget.then === 'function') {
          void Promise.resolve(rawTarget).catch(error => this.#remember(error))
          fail('ERR_PROTOCOL_VERSION', 'exact target resolution must be synchronous; asynchronous admission belongs to the owner')
        }
        const target = copyExternalFrameTarget(rawTarget, { sessionId: this.#owner.sessionId, renderRevision: reply.renderRevision })
        if (!sameSize(wireTarget, target)) fail('ERR_PROTOCOL_VERSION', 'target resolver cannot relabel the exact Worker physical dimensions')
        this.#check(context, controller)
        candidate.frame = reply.frame; candidate.target = target
        candidate.surface = await this.#acquireSurface(target, context, controller)
        this.#check(context, controller)
        // Rasterize/queue only the detached back buffer during preparation.
        // RAF is reserved for the visible swap, not validation, picture
        // recording and GPU submission. A retired preparation never installs
        // or acknowledges this buffer.
        const surface = candidate.surface
        candidate.receipt = surface.presenter.submit(candidate.frame)
        if (candidate.receipt && typeof candidate.receipt.then === 'function') {
          await this.#rejectAsyncSurfaceHook(candidate.receipt, 'presenter.submit must be a synchronous local queue submission')
        }
        candidate.submission = copySubmission(candidate.receipt, candidate, this.#owner)
        this.#timing('submitted', candidate, { late: !context.isCurrent() })
        surface.presenterGeneration = candidate.submission.presenterGeneration
        if (surface.invalid || surface.canvas.width !== target.width || surface.canvas.height !== target.height) {
          fail('ERR_RENDER', 'presenter did not produce the exact local submission receipt')
        }
        this.#checkCandidate(candidate, context, controller)
        candidate.phase = 'prepared'
        const handle = Object.freeze({ proof: candidate.proof })
        this.#candidates.set(handle, candidate)
        return handle
      } catch (error) {
        this.#timing('failed', candidate, { late: !context.isCurrent(), code: error?.code })
        if (this.#surfaceSuspended && candidate.surface?.lossNotified && !this.#fatal && error?.code === 'ERR_RENDER') {
          error = new WorkerCanvasKitAdapterError('ERR_CANCELLED', 'lost local surface retired this submission', { localCancellation: true, cause: error })
        }
        const failures = [error]
        try { if (candidate.surface && candidate.surface !== this.#current) this.#disposeSurface(candidate.surface) }
        catch (cleanup) { failures.push(cleanup); this.#remember(cleanup) }
        this.#records.delete(candidate)
        if (this.#active === candidate) this.#active = null
        throw aggregate(failures, 'frame preparation and local cleanup failed')
      }
    })
  }

  present(handle, context) {
    return this.#run(context, async controller => {
      const candidate = this.#candidates.get(handle)
      if (!candidate || this.#active !== candidate || candidate.released || candidate.phase !== 'prepared'
        || candidate.attemptId !== context.attemptId || candidate.proof.surfaceGeneration !== context.surfaceGeneration
        || !sameProof(candidate.proof, context.proof)) {
        fail('ERR_PROTOCOL_VERSION', 'presentation needs its exact prepared candidate and scheduler-frozen proof')
      }
      const surface = candidate.surface
      try {
        this.#checkCandidate(candidate, context, controller)
        // The detached submission is complete; only install it on this RAF.
        if (surface.invalid || surface.canvas.width !== candidate.target.width || surface.canvas.height !== candidate.target.height) {
          fail('ERR_RENDER', 'presenter did not produce the exact local submission receipt')
        }
        this.#checkCandidate(candidate, context, controller)
        const previous = this.#current
        candidate.installationAttempted = true
        let commits = 0
        const commit = () => {
          if (++commits !== 1) fail('ERR_PROTOCOL_VERSION', 'surface installation may commit only once')
          // Record the irreversible swap before install/focus/user callbacks.
          candidate.installed = true; candidate.phase = 'installed'; surface.installed = true
          this.#current = surface
          this.#timing('visible-swap', candidate, { late: !context.isCurrent() })
          if (previous.presenter && !previous.invalid && sameSize(previous.size, surface.size)) this.#spare = previous
          else this.#disposeSurface(previous)
        }
        try {
          const installation = this.#installSurface({ previousCanvas: previous.canvas, canvas: surface.canvas, commit,
            proof: context.proof, target: candidate.target })
          if (installation && typeof installation.then === 'function') {
            await this.#rejectAsyncSurfaceHook(installation, 'surface installation must be synchronous')
          }
          if (commits !== 1) fail('ERR_PROTOCOL_VERSION', 'surface installer did not report its exact visible commit')
        } catch (error) {
          // A custom installer throwing before commit has unknown external
          // state. Keep both local owners for final disposal, never fake rollback.
          if (!candidate.installed) {
            surface.uncertain = true; previous.uncertain = true
            this.#remember(error)
          }
          throw error
        }
        this.#checkCandidate(candidate, context, controller)
        this.#call('onSurface', Object.freeze({ canvas: surface.canvas, previousCanvas: previous.canvas,
          target: candidate.target, proof: candidate.proof, submission: candidate.submission, inputEnabled: false }))
        this.#checkCandidate(candidate, context, controller)
        candidate.ackStarted = true
        this.#ackWatermark = BigInt(candidate.proof.publication.renderRevision)
        candidate.phase = 'acknowledging'
        const raw = await this.#request('ack', { renderRevision: candidate.proof.publication.renderRevision }, context, controller, candidate)
        const final = copyExternalPresentationOutcome(raw,
          { sessionId: this.#owner.sessionId, renderRevision: candidate.proof.publication.renderRevision })
        // The runtime may have accepted/entered ready effects even if this
        // attempt is now retired. Release is governed by local installed state.
        candidate.ackOutcome = final; this.#recordAck(final); candidate.phase = 'acknowledged'
        this.#timing('runtime-ack', candidate, { late: !context.isCurrent(), inputEnabled: final.inputEnabled })
        this.#call('onAck', Object.freeze({ outcome: final, late: !context.isCurrent(), attemptId: context.attemptId }))
        this.#checkCandidate(candidate, context, controller)
        if (final.inputEnabled) {
          const epoch = this.#inputEpoch
          this.#input = Object.freeze({ enabled: true, owner: this.#owner, canvas: surface.canvas,
            surfaceGeneration: context.surfaceGeneration, publication: candidate.proof.publication,
            consumedInput: candidate.proof.consumedInput })
          this.#call('onInput', this.#input)
          this.#checkCandidate(candidate, context, controller)
          if (epoch !== this.#inputEpoch) cancelled()
        }
        return Object.freeze({ acknowledged: true, publication: candidate.proof.publication,
          inputEnabled: final.inputEnabled, requiresRestart: final.requiresRestart })
      } catch (error) {
        this.#timing('failed', candidate, { late: !context.isCurrent(), code: error?.code })
        surface.invalid ||= !candidate.installed
        if (this.#surfaceSuspended && surface.lossNotified && !this.#fatal && error?.code === 'ERR_RENDER') {
          error = new WorkerCanvasKitAdapterError('ERR_CANCELLED', 'lost local surface retired this submission', { localCancellation: true, cause: error })
        }
        try { this.freezeInput('presentation-failed') } catch (cleanup) {
          throw aggregate([error, cleanup], 'presentation and input-freeze failed')
        }
        throw error
      }
    })
  }

  release(handle, context) {
    const candidate = this.#candidates.get(handle)
    if (!candidate || candidate.attemptId !== context?.attemptId || !sameOwner(context?.owner, this.#owner)) {
      return Promise.reject(new WorkerCanvasKitAdapterError('ERR_PROTOCOL_VERSION', 'release belongs to another candidate/owner'))
    }
    if (candidate.releasePromise) return candidate.releasePromise
    let resolve, reject
    candidate.releasePromise = new Promise((done, failed) => { resolve = done; reject = failed })
    void Promise.resolve().then(() => {
      const failures = []
      candidate.released = true
      // committed:false is NOT rollback evidence. An installed canvas, issued
      // ACK or late genuine final must never be treated as an unshown candidate.
      if (context.retired && candidate.installed) {
        try { this.freezeInput('installed-attempt-retired') } catch (error) { failures.push(error) }
      }
      const surface = candidate.surface
      if (surface && surface !== this.#current && !surface.uncertain) {
        try {
          if (!this.#closing && !surface.invalid && !this.#spare) this.#spare = surface
          else this.#disposeSurface(surface)
        } catch (error) { failures.push(error) }
      }
      candidate.frame = null
      this.#records.delete(candidate)
      if (this.#active === candidate) this.#active = null
      if (failures.length) reject(aggregate(failures, 'candidate release failed')); else resolve()
    })
    return candidate.releasePromise
  }

  beginPresenterRetirement() { return this.cancelOwnedWork('presenter-generation-retired') }

  /** Abort only adapter waits; the borrowed RPC is still needed by its owner. */
  cancelOwnedWork(reason) {
    if (this.#cancelPromise) return this.#cancelPromise
    let resolve, reject
    this.#cancelPromise = new Promise((done, failed) => { resolve = done; reject = failed })
    this.#closing = true
    const operations = [...this.#work], failures = []
    try { this.freezeInput(reason) } catch (error) { failures.push(error) }
    for (const operation of operations) {
      try { operation.controller.abort(reason) } catch (error) { failures.push(error) }
    }
    void Promise.allSettled(operations.map(operation => operation.promise)).then(results => {
      for (const result of results) if (result.status === 'rejected' && !['ERR_CANCELLED', 'ERR_RPC_CANCELLED'].includes(result.reason?.code)) failures.push(result.reason)
      if (failures.length) reject(aggregate(failures, 'owned operation cancellation failed')); else resolve()
    })
    return this.#cancelPromise
  }

  /** Stable barrier; never closes/terminates the RPC or a second runtime. */
  dispose() {
    if (this.#disposePromise) return this.#disposePromise
    let resolve, reject
    this.#disposePromise = new Promise((done, failed) => { resolve = done; reject = failed })
    void (async () => {
      const failures = []
      try { await this.cancelOwnedWork('adapter disposal') } catch (error) { failures.push(error) }
      for (const candidate of this.#records) {
        candidate.released = true; candidate.frame = null
      }
      this.#records.clear(); this.#active = null; this.#disposed = true
      for (const surface of [...this.#surfaces]) {
        try { this.#disposeSurface(surface) } catch (error) { failures.push(error) }
      }
      this.#current = null; this.#spare = null
      failures.push(...this.#cleanupErrors)
      if (failures.length) throw aggregate([...new Set(failures)], 'CanvasKit adapter disposal failed')
      return Object.freeze({ disposed: true })
    })().then(resolve, reject)
    return this.#disposePromise
  }
}
