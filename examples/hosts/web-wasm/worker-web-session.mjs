/** Proposed async Worker owner. No generated application WASM or HTTP host. */
import { WorkerRpcClient, WORKER_RPC_VERSION, measureWorkerPayload } from './worker-session-client.mjs'
import { WorkerBridgeTransport } from './worker-bridge-transport.mjs'
import { copyOrderedObservation, copyRendererTransitionObservation, copyWorkerPresenterAttachment, WORKER_RENDERER_TRANSITION_CONTRACT, WORKER_RENDER_SCALE_CONTRACT } from './worker-runtime.mjs'
import { PresentationScheduler } from './presentation-scheduler.mjs'
import { WorkerDomAdapter } from './worker-dom-adapter.mjs'
import { WorkerCanvasKitAdapter } from './worker-canvaskit-adapter.mjs'
import { attachSurfaceInput } from './surface-input.mjs'
import { admitWorkerPack, loadPinnedCanvasKit } from './worker-admission-loader.mjs'
import { InputCausalLedger, INPUT_TIMING_CONTRACT, inputTimingRequestValid } from './input-causal-ledger.mjs'

// Both declarations are part of this pinned producer's public ABI. They do
// not claim execution evidence; managers reject older producers before handoff.
export { WORKER_RENDER_SCALE_CONTRACT }
export { INPUT_TIMING_CONTRACT }
export const WORKER_OWNER_RENDER_SCALE_CONTRACT = Object.freeze({ version: '1.0', fixed: 'presets-v1',
  auto: 'captured-preview-v2', worker: 'render-scale-1.0' })

export class WorkerWebSessionError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'WorkerWebSessionError'; this.code = code; Object.assign(this, details)
  }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => new WorkerWebSessionError('ERR_PROTOCOL_VERSION', message)
const stopped = message => new WorkerWebSessionError('ERR_CANCELLED', message)
const check = (condition, code, message) => { if (!condition) throw new WorkerWebSessionError(code, message) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const sameOwner = (a, b) => record(a) && record(b)
  && ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend', 'presenterGeneration'].every(key => a[key] === b[key])
const sameRect = (a, b) => record(a) && record(b) && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key])
const same = (a, b) => a === b || Boolean(a && b && typeof a === 'object' && typeof b === 'object'
  && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key])))
const u64 = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
  && value.length <= 20 && BigInt(value) <= 18446744073709551615n
const samePolicy = (a, b) => record(a) && record(b) && a.mode === b.mode
  && (a.mode === 'manifest' || a.mode === 'force' && a.profile === b.profile)
const freeze = (value, seen = new WeakSet()) => {
  if (record(value) || Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value); for (const child of Object.values(value)) freeze(child, seen); Object.freeze(value)
  }
  return value
}
const copy = value => { measureWorkerPayload(value); return freeze(structuredClone(value)) }
const combined = (errors, message) => {
  errors = [...new Set(errors)]
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message)
}
const fatalSurfaceFailure = (value, seen = new Set()) => {
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return ['ERR_PROTOCOL_VERSION', 'ERR_ENGINE', 'ERR_INVALID_MANIFEST', 'ERR_UNSUPPORTED_CAPABILITY'].includes(value.code)
    || [...(value.errors ?? []), value.cause].some(error => fatalSurfaceFailure(error, seen))
}
const BROWSER_QUERIES_CONTRACT = Object.freeze({ version: '1.0' })
const browserQueriesContract = value => record(value) && Object.keys(value).length === 1
  && Object.hasOwn(value, 'version') && value.version === '1.0'
const defaultDomAdapter = Object.assign(options => new WorkerDomAdapter(options), { browserQueries: BROWSER_QUERIES_CONTRACT })
const defaultFactories = Object.freeze({
  rpc: options => new WorkerRpcClient(options),
  bridge: options => new WorkerBridgeTransport(options),
  scheduler: options => new PresentationScheduler(options),
  domAdapter: defaultDomAdapter,
  canvasAdapter: options => new WorkerCanvasKitAdapter(options),
  input: attachSurfaceInput,
})
function logicalViewport(value) {
  check(record(value) && ['width', 'height'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= 4096),
    'ERR_RENDER', 'logical viewport needs width/height in 1..4096')
  return Object.freeze({ width: value.width, height: value.height })
}
function capturedAutoDensity(value) {
  return record(value) && Object.keys(value).length === 5 && value.version === '1.0'
    && value.mode === 'captured-auto' && value.requested === 'auto' && Number.isFinite(value.displayDensity)
    && value.displayDensity > 0 && Number.isFinite(value.effectiveScale) && value.effectiveScale > 0 && value.effectiveScale <= 4
    && value.effectiveScale === value.displayDensity
}
function windowMetrics(value) {
  const result = copy(value)
  check(record(result) && ['windowWidth', 'windowHeight', 'pixelRatio', 'screenWidth', 'screenHeight', 'statusBarHeight', 'screenTop']
    .every(key => Number.isFinite(result[key])) && result.pixelRatio > 0 && result.screenWidth > 0 && result.screenHeight > 0
    && result.statusBarHeight >= 0 && result.screenTop >= 0 && ['portrait', 'landscape'].includes(result.deviceOrientation),
  'ERR_RENDER', 'metrics requires the complete host metrics shape, including simulated pixelRatio')
  logicalViewport({ width: result.windowWidth, height: result.windowHeight })
  if (result.hostLayout !== undefined) {
    const layout = result.hostLayout, insets = layout?.safeInsets
    const exact = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
    check(exact(layout, ['version', 'safeInsets', 'verticalBarEdge', 'reservedRegions']) && layout.version === 1
      && exact(insets, ['top', 'right', 'bottom', 'left'])
      && Object.values(insets).every(value => Number.isFinite(value) && value >= 0)
      && insets.left + insets.right < result.windowWidth + .5 && insets.top + insets.bottom < result.windowHeight + .5
      && ['left', 'right', 'none'].includes(layout.verticalBarEdge)
      && Array.isArray(layout.reservedRegions) && layout.reservedRegions.length <= 64,
    'ERR_RENDER', 'invalid surface-local hostLayout')
    const ids = new Set()
    for (const region of layout.reservedRegions) {
      check(exact(region, ['id', 'kind', 'x', 'y', 'width', 'height'])
        && typeof region.id === 'string' && region.id.length > 0 && new TextEncoder().encode(region.id).length <= 256
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(region.id) && !ids.has(region.id)
        && ['occlusion', 'division'].includes(region.kind)
        && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key]))
        && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
        && region.x + region.width <= result.windowWidth + .5 && region.y + region.height <= result.windowHeight + .5,
      'ERR_RENDER', 'invalid surface-local reserved region')
      ids.add(region.id)
    }
  }
  return result
}
const initialMetrics = viewport => windowMetrics({ windowWidth: viewport.width, windowHeight: viewport.height,
  pixelRatio: 1, screenWidth: viewport.width, screenHeight: viewport.height, statusBarHeight: 0, screenTop: 0,
  deviceOrientation: viewport.width > viewport.height ? 'landscape' : 'portrait' })

/**
 * Own exactly one fresh Worker, one bridge and one phased presenter. An outer
 * application manager must await close before executing a replacement owner.
 * `load` success is runtime readiness, not a presentation/input/GPU receipt.
 * Factories/loaders are explicit test/embedding contracts, never fallbacks.
 */
export class WorkerWebSession {
  #root; #document; #window; #mount = null; #sinks; #factories; #admit; #assetsLoader; #raf; #caf
  #phase = 'new'; #owner = null; #admission = null; #loadResult = null; #latest = null; #eventSequence = 0n
  #rpc = null; #observedRpc = null; #bridge = null; #adapter = null; #scheduler = null; #assetLease = null
  #input = null; #inputAuthority = null; #inputProof = null; #reportedInputEnabled = false
  #visible = true; #metrics = null; #metricsPending = 0
  #visibilityRevision = 0n; #visibilityPending = 0
  #metricsRevision = 0n; #metricsFence = null
  #surfaceRecovery = null
  #loadAbort = null; #loadTask = null; #loadPromise = null; #closePromise = null; #cancelTask = null
  #publicWaits = new Set(); #controlTail = Promise.resolve(); #listeners = []; #diagnostics = []; #cleanupErrors = []
  #fatal = null; #emitting = false
  #browserQueries = null; #startupQueries = []; #startupQueryCount = 0; #startupQueryBytes = 0
  #runtimeOwner = null; #rendererTransitions = null; #presenter = null; #transition = null; #presenterOptions = null
  #retiredPresenters = []
  #inputTimingOptions = null; #inputLedger = null; #inputTimingClock; #inputTimingFailures = 0
  #identityRevocation = null

  constructor({ surfaceRoot, onBatch, onState, onDiagnostic, onError, onInput, onSurface,
    admitPack = admitWorkerPack, loadRendererAssets = loadPinnedCanvasKit,
    requestFrame = callback => globalThis.requestAnimationFrame(callback),
    cancelFrame = handle => globalThis.cancelAnimationFrame(handle), factories = {}, inputTiming,
    inputTimingClock = () => globalThis.performance.now() } = {}) {
    check(surfaceRoot && typeof surfaceRoot.append === 'function' && typeof surfaceRoot.ownerDocument?.createElement === 'function',
      'ERR_RENDER', 'a borrowed surfaceRoot with an ownerDocument is required')
    check([onBatch, onState, onDiagnostic, onError, onInput, onSurface].every(value => value === undefined || typeof value === 'function')
      && [admitPack, loadRendererAssets, requestFrame, cancelFrame].every(value => typeof value === 'function')
      && record(factories) && Object.entries(factories).every(([key, value]) => Object.hasOwn(defaultFactories, key) && typeof value === 'function'),
    'ERR_INVALID_REQUEST', 'owner hooks, admission, assets and factories must be explicit functions')
    this.#root = surfaceRoot; this.#document = surfaceRoot.ownerDocument; this.#window = this.#document.defaultView
    this.#sinks = { onBatch, onState, onDiagnostic, onError, onInput, onSurface }
    this.#admit = admitPack; this.#assetsLoader = loadRendererAssets; this.#raf = requestFrame; this.#caf = cancelFrame
    this.#factories = Object.freeze({ ...defaultFactories, ...factories })
    check(inputTiming === undefined || inputTimingRequestValid(inputTiming), 'ERR_PROTOCOL_VERSION', 'unsupported input timing request')
    check(typeof inputTimingClock === 'function', 'ERR_INVALID_REQUEST', 'input timing clock must be explicit monotonic milliseconds')
    this.#inputTimingOptions = inputTiming === undefined ? null : copy(inputTiming); this.#inputTimingClock = inputTimingClock
  }
  get owner() { return this.#owner }
  get nativeComponentRoot() { return this.#mount || this.#root }
  get runtimeOwner() { return this.#runtimeOwner }
  get observation() { return this.#latest }
  get inputTiming() {
    try { return this.#inputLedger ? Object.freeze({ ...this.#inputLedger.snapshot(), observerFailures: this.#inputTimingFailures }) : null }
    catch { return Object.freeze({ version: '1.0', gate: Object.freeze({ status: 'blocked', missing: ['input-ledger-failed', 'compositor-presentation-feedback'] }), observerFailures: ++this.#inputTimingFailures }) }
  }
  #timing(action) { try { return action(this.#inputLedger) } catch { this.#inputTimingFailures++; return undefined } }
  get status() {
    return Object.freeze({ phase: this.#phase, owner: this.#owner, observation: this.#latest,
      ...(this.#rendererTransitions ? { runtimeOwner: this.#runtimeOwner, presenterBinding: this.#presenter?.binding ?? this.#latest?.state.presenterBinding,
        presenterTransition: this.#transition ? Object.freeze({ version: '1.0', phase: this.#transition.phase,
          cleanupUncertain: this.#transition.cleanupUncertain === true, error: this.#transition.error ?? null }) : null } : {}),
      runtimeReady: this.#loadResult !== null && this.#phase === 'ready' && this.#identityRevocation === null,
      presentation: this.#scheduler?.status ?? null, visible: this.#visible, metricsPending: this.#metricsPending,
      metricsFence: Object.freeze({ revision: String(this.#metricsRevision), phase: this.#metricsFence?.phase ?? 'open' }),
      windowMetrics: this.#metrics,
      surfaceRecovery: this.#surfaceRecovery ? Object.freeze({ version: '1.0', lossId: this.#surfaceRecovery.lossId,
        phase: this.#surfaceRecovery.phase, surfaceGeneration: this.#surfaceRecovery.generation ?? null }) : null,
      inputEnabled: this.#effectiveInput(), requiresRestart: this.#latest?.state.requiresRestart === true || this.#fatal !== null || this.#identityRevocation !== null,
      hostIdentityRevoked: this.#identityRevocation !== null,
      identityRevocation: this.#identityRevocation ? Object.freeze({ phase: this.#identityRevocation.phase,
        attempts: this.#identityRevocation.attempts, error: this.#identityRevocation.error }) : null,
      fault: this.#fatal, diagnostics: Object.freeze([...this.#diagnostics]) })
  }
  #live() { return ['loading', 'ready'].includes(this.#phase) && !this.#fatal && !this.#identityRevocation && !this.#loadAbort?.signal.aborted }
  #ready() { check(this.#phase === 'ready' && this.#live(), 'ERR_CANCELLED', 'Worker owner is not ready; create a replacement after a fault/close') }
  #current() { if (!this.#live()) throw stopped('Worker owner was retired during initialization') }
  #invoke(name, value) {
    const returned = this.#sinks[name]?.(value)
    if (returned && typeof returned.then === 'function') {
      // Observational callbacks own no surface/Worker lease. Observe an invalid
      // async callback's rejection without holding the Worker event-credit lane.
      void Promise.resolve(returned).catch(error => { this.#retain(error); this.#cleanupErrors.push(error) })
      throw invalid(`${name} must return synchronously`)
    }
  }
  #retain(error) {
    this.#diagnostics.push(error); if (this.#diagnostics.length > 32) this.#diagnostics.shift()
  }
  #record(error) {
    this.#retain(error)
    try { this.#invoke('onDiagnostic', error) } catch (failure) { this.#cleanupErrors.push(failure) }
  }
  #emit() {
    if (this.#emitting) return
    this.#emitting = true
    try { this.#invoke('onState', this.status) } catch (error) { this.#fault(error) }
    finally { this.#emitting = false }
  }
  #fault(error) {
    if (!error || typeof error !== 'object') error = new WorkerWebSessionError('ERR_ENGINE', String(error))
    if (this.#phase === 'closed') { this.#cleanupErrors.push(error); return }
    const first = this.#fatal === null
    this.#fatal ??= error
    if (this.#phase !== 'closing') this.#phase = 'faulted'
    this.#inputAuthority = null
    try { this.#input?.reset() } catch (failure) { this.#cleanupErrors.push(failure) }
    try { this.#adapter?.freezeInput('owner-fault') } catch (failure) { this.#cleanupErrors.push(failure) }
    if (!this.#cancelTask && this.#adapter) {
      // Defer the call after publishing the barrier to tolerate reentrant hooks.
      this.#cancelTask = Promise.resolve().then(() => this.#adapter.cancelOwnedWork('owner-fault'))
      void this.#cancelTask.catch(failure => { this.#cleanupErrors.push(failure) })
    }
    // The first failure owns session state, not all later diagnostics. An
    // original observation can fault first; retain the real event error too.
    // Reentrant handling of the same Error object needs no duplicate notice.
    if (!this.#diagnostics.includes(error)) this.#record(error)
    if (first) {
      try { this.#invoke('onError', error) } catch (failure) { this.#cleanupErrors.push(failure) }
    }
    this.#emit()
  }
  #blockSurfaceRecovery(error) {
    const recovery = this.#surfaceRecovery
    if (!recovery || fatalSurfaceFailure(error)) { this.#fault(error); return }
    recovery.phase = 'blocked'; this.#inputAuthority = null
    // The application realm and timer pump stay alive. A local GPU failure
    // owns no authority to terminate or replace the immutable Worker owner.
    if (!this.#diagnostics.includes(error)) this.#record(error)
    this.#emit()
  }

  load(options = {}) {
    if (this.#loadPromise) return this.#loadPromise
    if (this.#phase !== 'new') return Promise.reject(stopped('this owner cannot load another application'))
    this.#phase = 'loading'; this.#loadAbort = new AbortController()
    // Publish both barriers before any constructor/injected callback executes.
    // close waits loadTask, not loadPromise (which may itself await close).
    this.#loadTask = Promise.resolve().then(() => this.#initialize(options))
    this.#loadPromise = this.#loadTask.catch(async error => {
      if (this.#phase !== 'closing' && this.#phase !== 'closed') this.#fault(error)
      try { await this.close() } catch (cleanup) {
        if (cleanup === error) throw error
        throw combined([error, cleanup], 'Worker load and owned cleanup failed')
      }
      throw error
    })
    void this.#loadPromise.catch(() => {})
    return this.#loadPromise
  }
  async #initialize(options) {
    this.#current()
    check(record(options) && (options.engine ?? 'quickjs') === 'quickjs', 'ERR_ENGINE', 'the Worker product currently requires real bounded QuickJS; V8 is unavailable')
    check((options.renderer ?? 'auto') === 'auto', 'ERR_UNSUPPORTED_CAPABILITY', 'select rendererPolicy; no software/main-thread/HTTP fallback is admitted')
    check(sha(options.indexSha256), 'ERR_INVALID_MANIFEST', 'a pinned pack-index SHA-256 is required')
    if (options.rendererTransitions !== undefined) {
      check(record(options.rendererTransitions) && Object.keys(options.rendererTransitions).length === 1
        && options.rendererTransitions.version === '1.0', 'ERR_PROTOCOL_VERSION', 'rendererTransitions requires explicit version 1.0')
      check(!this.#inputTimingOptions, 'ERR_UNSUPPORTED_CAPABILITY', 'mixed presenter input timing is not negotiated')
      this.#rendererTransitions = WORKER_RENDERER_TRANSITION_CONTRACT
    }
    this.#presenterOptions = { timeoutMs: options.timeoutMs ?? 5000, rendererAssets: options.rendererAssets }
    const viewport = logicalViewport(options.viewport ?? { width: 375, height: 667 })
    const requestedScale = options.renderScale === undefined ? undefined : copy(options.renderScale)
    check(requestedScale === undefined || requestedScale === 'auto' || capturedAutoDensity(requestedScale)
      || [1, 1.5, 2, 3, 4].includes(requestedScale), 'ERR_RENDER', 'initial renderScale requires auto, a fixed preset or captured-auto profile 1.0')
    const policy = copy(options.rendererPolicy ?? { mode: 'manifest' })
    check(record(policy) && (policy.mode === 'manifest' && Object.keys(policy).length === 1
      || policy.mode === 'force' && Object.keys(policy).length === 2 && ['webview', 'skia', 'skyline-compat'].includes(policy.profile)),
    'ERR_PROTOCOL_VERSION', 'an explicit manifest or force renderer policy is required')
    check(!this.#rendererTransitions || policy.mode === 'manifest', 'ERR_PROTOCOL_VERSION', 'renderer transitions require manifest renderer policy')
    this.#metrics = options.metrics === undefined ? initialMetrics(viewport) : windowMetrics(options.metrics)
    check(this.#metrics.windowWidth === viewport.width && this.#metrics.windowHeight === viewport.height, 'ERR_RENDER', 'initial metrics and logical viewport disagree')
    this.#mount = this.#document.createElement('div'); this.#mount.setAttribute('data-worker-web-session', '')
    this.#root.append(this.#mount)
    this.#rpc = this.#factories.rpc({ ...(options.rpcOptions ?? {}),
      workerUrl: options.workerUrl ?? new URL('./runtime-worker.mjs', import.meta.url), workerFactory: options.workerFactory,
      onEvent: message => this.#receiveEvent(message), onFailure: error => this.#fault(error) })
    check(this.#rpc && typeof this.#rpc.requestHost === 'function' && typeof this.#rpc.close === 'function'
      && typeof this.#rpc.workerEpoch === 'string' && typeof this.#rpc.sessionId === 'string',
    'ERR_PROTOCOL_VERSION', 'RPC factory must transfer exactly one owned Worker client')
    this.#observedRpc = Object.freeze({ workerEpoch: this.#rpc.workerEpoch, sessionId: this.#rpc.sessionId, actualFinalContract: this.#rpc.actualFinalContract,
      requestHost: (op, payload, requestOptions) => this.#requestHost(op, payload, requestOptions) })
    this.#bridge = this.#factories.bridge({ rpc: this.#observedRpc, timeoutMs: options.timeoutMs ?? 5000,
      onDiagnostic: error => this.#record(error) })
    check(this.#bridge?.rpc === this.#observedRpc && typeof this.#bridge.receiveBatch === 'function'
      && typeof this.#bridge.request === 'function' && typeof this.#bridge.dispose === 'function',
    'ERR_PROTOCOL_VERSION', 'one bridge borrowing this exact observed RPC is required')
    this.#current()
    const signal = this.#loadAbort.signal
    this.#admission = await this.#admit({ indexUrl: options.indexUrl ?? './pack-index.json', indexSha256: options.indexSha256,
      ...(options.indexSize === undefined ? {} : { indexSize: options.indexSize }), route: options.route, rendererPolicy: policy, signal })
    this.#current()
    const admission = copy(this.#admission)
    check(admission.version === '1.0' && admission.provenance?.indexSha256 === options.indexSha256
      && sha(admission.provenance.manifestSha256) && sha(admission.provenance.integrityRoot)
      && typeof admission.route === 'string' && admission.route.length > 0 && samePolicy(admission.rendererPolicy, policy)
      && ['browser-view', 'external-frame'].includes(admission.transportBackend),
    'ERR_INVALID_MANIFEST', 'pure admission did not return verified route/policy/provenance')
    this.#admission = admission
    check(options.renderScale === undefined || admission.transportBackend === 'external-frame',
      'ERR_UNSUPPORTED_CAPABILITY', 'physical render scale applies only to external-frame; DOM uses browser density')
    check(!this.#inputTimingOptions || admission.transportBackend === 'external-frame',
      'ERR_UNSUPPORTED_CAPABILITY', 'causal input timing 1.0 supports Worker Skia only')
    // Display density is separate from simulated device metrics. Resolve auto
    // once for this preview; neither logical viewport nor pixelRatio changes.
    const density = requestedScale === 'auto' ? this.#document.defaultView?.devicePixelRatio ?? 1 : requestedScale
    if (requestedScale === 'auto') check(Number.isFinite(density) && density > 0, 'ERR_RENDER', 'auto renderScale requires a positive display density')
    const renderScale = requestedScale === 'auto' ? density
      : capturedAutoDensity(requestedScale) ? requestedScale.effectiveScale : density
    this.#owner = Object.freeze({ workerEpoch: this.#rpc.workerEpoch, sessionId: this.#rpc.sessionId,
      packSha256: options.indexSha256, transportBackend: admission.transportBackend })
    if (this.#rendererTransitions) check(this.#rpc.actualFinalContract === '1.0', 'ERR_PROTOCOL_VERSION', 'presenter transitions require genuine actual-final ownership')
    if (this.#rendererTransitions) this.#runtimeOwner = Object.freeze({ workerEpoch: this.#rpc.workerEpoch, sessionId: this.#rpc.sessionId, packSha256: options.indexSha256 })
    if (this.#inputTimingOptions) this.#inputLedger = new InputCausalLedger({ owner: this.#owner, clock: this.#inputTimingClock })
    // Factories must advertise sampling before native app.init, while the real
    // adapter is created only after verified load. Unmarked injected fakes keep
    // the older unsupported gate; merely accepting an option cannot opt in.
    if (admission.transportBackend === 'browser-view' || this.#rendererTransitions) {
      const offered = this.#factories.domAdapter.browserQueries
      if (offered !== undefined) {
        check(browserQueriesContract(offered), 'ERR_PROTOCOL_VERSION', 'DOM adapter factory advertises an unsupported browser query contract')
        this.#browserQueries = BROWSER_QUERIES_CONTRACT
      }
    }
    if (this.#rendererTransitions) check(this.#browserQueries !== null, 'ERR_PROTOCOL_VERSION', 'mixed presenter owner requires explicit DOM query support before app.init')
    const load = { indexUrl: options.indexUrl ?? './pack-index.json', indexSha256: options.indexSha256,
      ...(options.indexSize === undefined ? {} : { indexSize: options.indexSize }), engine: 'quickjs', renderer: 'auto',
      rendererPolicy: policy, observation: { version: '1.0' }, viewport, route: admission.route,
      ...(renderScale === undefined ? {} : { renderScale, renderScaleContract: { version: '1.0' } }),
      ...(this.#inputTimingOptions ? { inputTiming: this.#inputTimingOptions } : {}),
      ...(this.#browserQueries ? { browserQueries: this.#browserQueries } : {}),
      ...(this.#rendererTransitions ? { rendererTransitions: { version: '1.0' } } : {}),
      // Only an explicit host observation may seed native synchronous APIs.
      // initialMetrics() is a layout fallback and must stay local to this owner.
      ...(options.metrics === undefined ? {} : { metrics: this.#metrics }),
      ...(admission.transportBackend === 'external-frame' || this.#rendererTransitions ? { externalPresentation: { version: '1.0' }, surfaceRecovery: { version: '1.0' } } : {}) }
    let textFont = null
    if (admission.transportBackend === 'external-frame' || this.#rendererTransitions) {
      const font = options.rendererAssets?.font?.binary
      if (font || this.#assetsLoader === loadPinnedCanvasKit) {
        check(font && sha(font.sha256) && Number.isSafeInteger(font.size) && font.size > 0 && font.size <= 32 * 1024 * 1024,
          'ERR_RENDER', 'external text layout requires the exact bounded renderer font pin')
        const url = new URL(font.url, this.#document.baseURI ?? globalThis.location.href)
        textFont = { version: '1.0', profile: 'sfnt-unhinted-v1', url: url.href, sha256: font.sha256, size: font.size }
        load.textFont = textFont
      }
    }
    for (const key of ['data', 'query', 'launchOptions', 'engineExecution', 'viewExecution', 'loadTimeoutMs', 'hostServices', 'developmentSandbox']) if (options[key] !== undefined) load[key] = options[key]
    const result = await this.#observedRpc.requestHost('load', copy(load), { signal, timeoutMs: options.loadTimeoutMs ?? 30000 })
    this.#current()
    if (textFont) check(record(result.textFont) && Object.keys(result.textFont).length === 3 && result.textFont.sha256 === textFont.sha256 && result.textFont.face_index === 0 && result.textFont.profile === textFont.profile,
      'ERR_PROTOCOL_VERSION', 'Worker did not bind layout to the admitted renderer font')
    if (renderScale !== undefined) check(same(result.renderScaleContract, WORKER_RENDER_SCALE_CONTRACT),
      'ERR_PROTOCOL_VERSION', 'Worker did not negotiate the exact render scale contract')
    if (this.#inputTimingOptions) check(same(result.inputTiming, INPUT_TIMING_CONTRACT),
      'ERR_PROTOCOL_VERSION', 'Worker did not negotiate causal input timing 1.0')
    if (options.hostServices !== undefined) check(result.hostServices?.version === '1.0'
      && result.hostServices.trustedContext === true && result.hostServices.ownerThreadCompletion === true,
    'ERR_PROTOCOL_VERSION', 'Worker did not negotiate host native services 1.0')
    this.#validateLoad(result)
    this.#loadResult = copy(result)
    if (this.#rendererTransitions) {
      const attached = copyWorkerPresenterAttachment(this.#attachment(), this.#loadResult)
      this.#owner = attached.owner
    }
    await this.#createPresenter(signal)
    this.#phase = 'ready'
    if (this.#latest) {
      if (this.#rendererTransitions && this.#latest.state.transitionRequired) {
        // AppService timers already run while renderer assets are admitted.
        // Their real navigation demand belongs to the same Worker; never feed
        // a pending family into the initially admitted fixed presenter.
        void this.#queueRendererTransition().catch(() => {})
      } else {
        this.#adapter.receiveObservation?.(this.#latest)
        if (this.#live()) this.#scheduler.observe(this.#latest)
      }
    }
    this.#current()
    this.#installListeners()
    if (options.metrics !== undefined) await this.setWindowMetrics(this.#metrics)
    if (this.#document.hidden) await this.setVisible(false)
    this.#current(); this.#emit()
    return Object.freeze({ owner: this.#owner, loadResult: this.#loadResult, runtimeReady: true,
      presentation: this.#scheduler.status })
  }
  #presenterContext(slot) {
    const state = this.#latest?.state
    check(slot === this.#presenter && slot?.active && state && !state.transitionRequired && !state.requiresRestart
      && state.lifecycle === 'Active' && state.currentPage && same(slot.binding, state.presenterBinding),
    'ERR_CANCELLED', 'presenter request belongs to a retired binding/page or pending transition')
    return copy({ presenterBinding: slot.binding, pageId: state.currentPage.pageId,
      inputLifetimeRevision: state.inputLifetimeRevision, surfaceGeneration: state.surfaceGeneration })
  }
  #presenterRpc(slot) {
    return Object.freeze({ workerEpoch: slot.owner.workerEpoch, sessionId: slot.owner.sessionId, actualFinalContract: '1.0',
      requestHost: (op, payload, options) => {
        if (op === 'metrics' || op === 'renderer.transition' || op === 'load' || op === 'close') return this.#rejectUnpostedPresenter(invalid('owner controls cannot be issued by a presenter'), options)
        let context
        try { context = this.#presenterContext(slot) } catch (error) { return this.#rejectUnpostedPresenter(Object.assign(error, { localCancellation: true }), options) }
        return this.#requestHost(op, { ...payload, presentationContext: context }, options)
      } })
  }
  #presenterBridge(slot, rpc) {
    const bridge = this.#bridge
    return Object.freeze({ rpc, sessionId: slot.owner.sessionId, workerEpoch: slot.owner.workerEpoch,
      get closed() { return bridge.closed }, get connected() { return bridge.connected },
      setSession: sessionId => bridge.setSession(sessionId), receiveBatch: batch => bridge.receiveBatch(batch), dispose() {},
      request: (op, payload, options = {}) => {
        let context
        try { context = this.#presenterContext(slot) } catch (error) { return Promise.reject(Object.assign(error, { localCancellation: true })) }
        return bridge.request(op, payload, { ...options, hostContext: { ...options.hostContext, presentationContext: context } })
      } })
  }
  #freezePresenter(reason) {
    this.#inputAuthority = null; this.#inputProof = null
    this.#input?.reset()
    if (this.#presenter?.active === false) return
    this.#adapter?.freezeInput(reason); this.#scheduler?.suspend(reason)
  }
  async #drainPresenterActual(slot) {
    // No request can enter this slot after active=false. Snapshot until empty
    // for finals that synchronously enqueue their own exact-generation cleanup.
    while (slot.actual.size) await Promise.all([...slot.actual].map(entry => entry.promise))
  }
  #actualTransition(payload) {
    let resolve, reject
    const final = new Promise((yes, no) => { resolve = yes; reject = no })
    const request = this.#requestHost('renderer.transition', payload, {
      onLateResponse: message => {
        if (message.payload?.status === 'ok') resolve(message.payload.result)
        else if (message.payload?.status === 'error') reject(Object.assign(new WorkerWebSessionError(message.payload.error.code, message.payload.error.message), { details: message.payload.error }))
      },
      onActualFinal: receipt => {
        if (receipt?.version !== '1.0' || !['final', 'not-posted'].includes(receipt.status)) reject(new WorkerWebSessionError('ERR_RPC_CLEANUP', 'renderer transition has no genuine actual final', { receipt }))
        else if (receipt.status === 'not-posted') reject(new WorkerWebSessionError('ERR_CANCELLED', 'renderer transition was not posted; no native final can arrive', { receipt }))
      } })
    void request.then(resolve, error => {
      // A public timeout is not a native transition outcome. Retain the same
      // operation until its genuine late final, or the exact close barrier.
      if (!['ERR_RPC_TIMEOUT', 'ERR_RPC_CANCELLED'].includes(error?.code)) reject(error)
    })
    return final
  }
  #beginPresenterRetirement(transition) {
    if (transition.retirement) return
    const slot = transition.old
    let resolve, reject
    transition.retirement = new Promise((yes, no) => { resolve = yes; reject = no })
    void transition.retirement.catch(() => {})
    transition.resolveRetirement = resolve; transition.rejectRetirement = reject
    transition.phase = 'draining'
    this.#inputAuthority = null; this.#inputProof = null; this.#input?.reset()
    slot.active = false
    check(typeof slot.adapter?.beginPresenterRetirement === 'function', 'ERR_PROTOCOL_VERSION', 'negotiated presenter must own an explicit native retirement barrier')
    // Install the DOM remote-retirement barrier before aborting candidates or
    // suspending the scheduler. A prior owner control may hold controlTail;
    // strict candidate cleanup must already know which actual final to await.
    transition.localCancellation = slot.adapter.beginPresenterRetirement(transition.retirement)
    void Promise.resolve(transition.localCancellation).catch(() => {})
    slot.scheduler.suspend('presenter-generation-retired')
  }
  #queueRendererTransition() {
    if (this.#transition?.task) return this.#transition.task
    const transition = this.#transition ?? { phase: 'draining', task: null, old: this.#presenter, error: null }
    this.#transition = transition
    const task = this.#controlTail.then(() => {
      if (transition.setupFailure) throw transition.setupFailure
      return this.#performRendererTransition(transition)
    })
    transition.task = task
    this.#controlTail = task.catch(() => {})
    try { this.#beginPresenterRetirement(transition) } catch (error) { transition.setupFailure = error }
    void task.catch(error => {
      if (this.#transition !== transition || ['closing', 'closed'].includes(this.#phase)) return
      transition.phase = 'blocked'; transition.error = error
      this.#record(error); this.#emit()
    }).finally(() => { if (transition.task === task) transition.task = null })
    return task
  }
  async #performRendererTransition(transition) {
    this.#ready()
    const slot = transition.old
    this.#beginPresenterRetirement(transition)
    if (!transition.nativeFinal) {
      await this.#drainPresenterActual(slot)
      this.#ready()
      const state = this.#latest.state
      if (!state.transitionRequired) {
        throw stopped('the route returned to its old family during drain; native presenter retirement is still required')
      } else {
        transition.phase = 'native'; this.#emit()
        const expected = copy({ sessionId: this.#runtimeOwner.sessionId, pageId: state.currentPage.pageId,
          routePath: state.currentPage.path, rendererProfile: state.rendererProfile,
          inputLifetimeRevision: state.inputLifetimeRevision, presenterGeneration: slot.binding.generation,
          transportBackend: slot.binding.transportBackend, surfaceGeneration: state.surfaceGeneration })
        const result = await this.#actualTransition({ version: '1.0', expected })
        check(result?.version === '1.0' && result.ok === true && result.inputEnabled === false
          && same(result.previousPresenterBinding, slot.binding) && same(result.runtimeOwner, this.#runtimeOwner)
          && same(result.presenterBinding, result.observation?.state.presenterBinding) && result.observation?.state.transitionRequired === false,
        'ERR_CANCELLED', 'native presenter transition did not commit the captured route/binding')
        transition.nativeFinal = copy(result)
        transition.resolveRetirement(copy({ version: '1.0', retired: true, previousPresenterBinding: result.previousPresenterBinding,
          presenterBinding: result.presenterBinding, source: 'native-renderer-transition-final' }))
      }
    }
    transition.phase = 'releasing'; this.#emit()
    if (!slot.drained) {
      await slot.scheduler.close()
      await slot.adapter.finalizeRemoteWork?.()
      await this.#input?.dispose(); this.#input = null
      await slot.assetLease?.dispose?.()
      slot.drained = true
    }
    this.#ready()
    this.#adapter = null; this.#scheduler = null; this.#assetLease = null
    this.#surfaceRecovery = null; this.#inputAuthority = null; this.#inputProof = null
    for (let races = 0; this.#latest.state.transitionRequired; races++) {
      if (races >= 3) throw stopped('navigation changed family during three native transitions; retry explicitly')
      const state = this.#latest.state, binding = state.presenterBinding
      transition.phase = 'native'; this.#emit()
      const result = await this.#actualTransition({ version: '1.0', expected: copy({ sessionId: this.#runtimeOwner.sessionId,
        pageId: state.currentPage.pageId, routePath: state.currentPage.path, rendererProfile: state.rendererProfile,
        inputLifetimeRevision: state.inputLifetimeRevision, presenterGeneration: binding.generation,
        transportBackend: binding.transportBackend, surfaceGeneration: state.surfaceGeneration }) })
      check(result?.ok === true && same(result.previousPresenterBinding, binding)
        && same(result.runtimeOwner, this.#runtimeOwner) && same(result.presenterBinding, result.observation?.state.presenterBinding),
      'ERR_CANCELLED', 'navigation changed during the serial native transition')
      transition.nativeFinal = copy(result)
    }
    const attached = copyWorkerPresenterAttachment(this.#attachment(), this.#loadResult)
    this.#owner = attached.owner
    transition.phase = 'attaching' ; this.#emit()
    try {
      await this.#createPresenter(this.#loadAbort.signal)
      this.#ready()
      if (this.#latest.state.transitionRequired) {
        // Navigation during asset admission is a new native demand, never a
        // reason to replay startup or present the wrong family. Drain this
        // newly attached generation through the next real transaction.
        this.#transition = null
        void this.#queueRendererTransition().catch(error => this.#record(error))
        return Object.freeze({ version: '1.0', transitioned: false, pending: true })
      }
      transition.phase = 'awaiting-presentation'
      if (this.#metricsFence?.phase === 'pending' || this.#visibilityPending || !this.#visible) this.#scheduler.suspend('owner-control-pending')
      this.#adapter.receiveObservation?.(this.#latest)
      this.#scheduler.observe(this.#latest)
      this.#emit()
      return Object.freeze({ version: '1.0', transitioned: true, runtimeOwner: this.#runtimeOwner,
        presenterBinding: this.#latest.state.presenterBinding, inputEnabled: false })
    } catch (error) {
      // The original Worker and its timers remain alive. A partial local
      // allocation belongs to this transaction and must drain before retry.
      const partial = this.#presenter
      if (partial && partial !== slot) {
        const cleanupFailures = []
        try { await partial.scheduler?.close() } catch (cleanup) { cleanupFailures.push(cleanup) }
        if (!partial.scheduler) {
          try { await partial.adapter?.cancelOwnedWork?.('attachment-failed') } catch (cleanup) { cleanupFailures.push(cleanup) }
          try { await partial.adapter?.dispose?.() } catch (cleanup) { cleanupFailures.push(cleanup) }
        }
        try { await this.#drainPresenterActual(partial) } catch (cleanup) { cleanupFailures.push(cleanup) }
        try { await partial.adapter?.finalizeRemoteWork?.() } catch (cleanup) { cleanupFailures.push(cleanup) }
        partial.active = false
        try { this.#disposeUntransferredCanvas(partial) } catch (cleanup) { cleanupFailures.push(cleanup) }
        // A transferred adapter may retain CanvasKit/fontData in its factory
        // closure even after a failing destructor. Do not return that byte
        // budget or permit replacement allocations until last use is proven.
        if (!cleanupFailures.length) {
          try { await partial.assetLease?.dispose?.() } catch (cleanup) { cleanupFailures.push(cleanup) }
        }
        if (cleanupFailures.length) {
          transition.cleanupUncertain = true
          partial.cleanupFailure = combined(cleanupFailures, 'partial presenter last use is uncertain; renderer lease remains charged')
          this.#cleanupErrors.push(partial.cleanupFailure)
          this.#retiredPresenters.push(partial)
          error = combined([error, partial.cleanupFailure], 'presenter attachment failed and owned cleanup is uncertain')
        } else {
          // Clean failures can retry without retaining disposed adapters or
          // their closed-over font buffers in an ever-growing history list.
          partial.drained = true; partial.adapter = null; partial.scheduler = null; partial.assetLease = null; partial.canvas = null
        }
      }
      this.#adapter = null; this.#scheduler = null; this.#assetLease = null
      throw error
    }
  }
  retryRendererTransition() {
    try {
      this.#ready()
      check(this.#rendererTransitions && this.#transition?.phase === 'blocked', 'ERR_INVALID_REQUEST', 'no blocked presenter transition to retry')
      check(!this.#transition.cleanupUncertain, 'ERR_RENDER', 'presenter cleanup is uncertain; its resources remain charged and retry cannot allocate a successor')
      this.#transition.error = null
      return this.#queueRendererTransition()
    } catch (error) { return Promise.reject(error) }
  }
  #disposeUntransferredCanvas(slot) {
    if (!slot?.canvas || slot.canvasTransferred) return
    if (slot.canvasCleanupFailure) throw slot.canvasCleanupFailure
    try { slot.canvas.remove(); slot.canvas = null }
    catch (error) { slot.canvasCleanupFailure = error; throw error }
  }
  #attachment() {
    if (!this.#rendererTransitions) return null
    return copy({ version: '1.0', runtimeOwner: this.#runtimeOwner,
      presenterBinding: this.#latest.state.presenterBinding, observation: this.#latest })
  }
  async #createPresenter(signal) {
    const attachment = this.#attachment()
    const slot = { owner: this.#owner, binding: attachment?.presenterBinding ?? null, active: true,
      adapter: null, scheduler: null, assetLease: null, canvas: null, canvasTransferred: false, actual: new Set(), drained: false }
    this.#presenter = slot
    const scopedRpc = this.#rendererTransitions ? this.#presenterRpc(slot) : this.#observedRpc
    const scopedBridge = this.#rendererTransitions ? this.#presenterBridge(slot, scopedRpc) : this.#bridge
    if (this.#owner.transportBackend === 'browser-view') {
      // Borrow the owner's one correlation table. No adapter onBatch/receiveEvent
      // ingress: this owner processes outer observation, then one genuine batch.
      this.#adapter = await this.#factories.domAdapter({ rpc: scopedRpc, bridge: scopedBridge,
        loadResult: this.#loadResult, ...(attachment ? { attachment } : {}), container: this.#mount, timeoutMs: this.#presenterOptions.timeoutMs,
        onDiagnostic: error => this.#record(error) })
    } else {
      const lease = await this.#assetsLoader({ owner: this.#owner, loadResult: this.#loadResult, ...(attachment ? { attachment } : {}),
        rendererAssets: this.#presenterOptions.rendererAssets, signal })
      // Own a late lease before checking retirement. close waits loadTask and
      // disposes it after any adapter's actual final use, including partial init.
      this.#assetLease = lease; slot.assetLease = lease
      this.#current()
      check(lease?.version === '1.0' && sameOwner(lease.owner, this.#owner) && lease.CanvasKit
        && lease.fontData instanceof ArrayBuffer && typeof lease.dispose === 'function',
        'ERR_RENDER', 'asset admission must transfer a verified CanvasKit/font lease')
      const canvas = this.#document.createElement('canvas'); slot.canvas = canvas
      canvas.setAttribute('tabindex', '0'); this.#mount.append(canvas)
      this.#adapter = await this.#factories.canvasAdapter({ owner: this.#owner, rpc: scopedRpc, frameResponseOwner: this.#rpc,
        externalPresentation: this.#loadResult.externalPresentation, canvas, canvasOwned: true, CanvasKit: lease.CanvasKit,
        fontData: lease.fontData, presenterOptions: { ...lease.presenterOptions, ...(this.#loadResult.textFont ? { fontIdentity: this.#loadResult.textFont } : {}) },
        onBatch: batch => this.#deliverBatch(batch), onSurface: value => { if (this.#presenter === slot && slot.active) this.#installInput(value) },
        onSurfaceLost: value => { if (this.#presenter === slot && slot.active) this.#lostSurface(value) }, onInput: value => { if (this.#presenter === slot && slot.active) this.#acceptInput(value) },
        ...(this.#inputLedger ? { onTiming: value => this.#timing(ledger => ledger.frame(value.stage, value)) } : {}),
        onError: error => { if (this.#presenter === slot && slot.active) this.#surfaceRecovery ? this.#blockSurfaceRecovery(error) : this.#rendererTransitions ? this.#record(error) : this.#fault(error) } })
    }
    slot.adapter = this.#adapter
    check(this.#adapter && ['prepareTemplate', 'preparePaint', 'present', 'release', 'freezeInput', 'cancelOwnedWork', 'dispose']
      .every(name => typeof this.#adapter[name] === 'function'), 'ERR_PROTOCOL_VERSION', 'adapter factory must transfer a complete phased adapter')
    if (slot.canvas) slot.canvasTransferred = true
    this.#current()
    if (this.#rendererTransitions) check(typeof this.#adapter.beginPresenterRetirement === 'function', 'ERR_PROTOCOL_VERSION', 'mixed presenter adapter must negotiate native-retirement ownership')
    if (this.#owner.transportBackend === 'browser-view') check(['setOwnerInputFence', 'acceptsOwnerInput']
      .every(name => typeof this.#adapter[name] === 'function'), 'ERR_PROTOCOL_VERSION', 'DOM adapter must support the owner revision input fence')
    if (this.#owner.transportBackend === 'browser-view' && this.#metricsRevision > 0n) this.#setDomFence(String(this.#metricsRevision), this.#metricsFence?.phase === 'pending')
    if (this.#browserQueries && this.#owner.transportBackend === 'browser-view') {
      check(typeof this.#adapter.receiveQueryBatch === 'function', 'ERR_PROTOCOL_VERSION', 'negotiated DOM adapter cannot receive browser query batches')
      const retained = this.#startupQueries.splice(0)
      this.#startupQueryCount = 0; this.#startupQueryBytes = 0
      for (const batch of retained) this.#queryBatch(batch)
    }
    if (this.#owner.transportBackend === 'external-frame') check(record(this.#loadResult.surfaceRecovery) && Object.keys(this.#loadResult.surfaceRecovery).length === 2
      && this.#loadResult.surfaceRecovery.version === '1.0' && this.#loadResult.surfaceRecovery.retainedExternalFrame === '1.0'
      && ['suspendOwnedSurface', 'resumeOwnedSurface']
      .every(name => typeof this.#adapter[name] === 'function'), 'ERR_PROTOCOL_VERSION', 'CanvasKit requires the native surface-recovery contract and nonterminal adapter drain')
    this.#scheduler = this.#factories.scheduler({ owner: this.#owner, adapter: this.#adapterFacade(slot),
      preparationScheduling: this.#owner.transportBackend === 'external-frame' ? 'microtask' : 'frame',
      requestFrame: this.#raf, cancelFrame: this.#caf, onError: error => {
        if (this.#surfaceRecovery && fatalSurfaceFailure(error)) this.#fault(error)
        else this.#record(error)
      },
      onState: status => {
        if (this.#presenter !== slot || !slot.active) return
        if (status.phase === 'faulted' && this.#surfaceRecovery) this.#blockSurfaceRecovery(new WorkerWebSessionError('ERR_RENDER', 'local presentation cleanup is uncertain'))
        else if (status.phase === 'blocked' && this.#surfaceRecovery?.resumed) this.#blockSurfaceRecovery(new WorkerWebSessionError('ERR_RENDER', 'local surface presentation failed; retry explicitly'))
        else if (['faulted', 'restart-required'].includes(status.phase)) this.#fault(invalid(`presentation scheduler is ${status.phase}`))
        // The adapter's native ACK precedes scheduler acceptance. Promote its
        // retained authority only after the scheduler installs that exact proof.
        try { this.#syncInput() } catch (error) { this.#fault(error) }
        this.#emit()
      } })
    slot.scheduler = this.#scheduler
    this.#current()
    check(['suspend', 'resume'].every(name => typeof this.#scheduler[name] === 'function'), 'ERR_PROTOCOL_VERSION', 'scheduler must support local presentation suspension')
    if (this.#owner.transportBackend === 'external-frame') check(['suspendOwnedSurface', 'resumeOwnedSurface']
      .every(name => typeof this.#scheduler[name] === 'function'), 'ERR_PROTOCOL_VERSION', 'CanvasKit scheduler must support exact nonterminal recovery tickets')
  }

  #validateLoad(result) {
    const contract = result?.observationContract, admission = this.#admission, pack = result?.pack
    check(record(result) && result.capabilities?.quickjs === true && result.transportBackend === admission.transportBackend
      && result.renderer === admission.transportBackend && samePolicy(result.rendererPolicy, admission.rendererPolicy)
      && result.declaredProfile === admission.declaredProfile && result.effectiveProfile === admission.effectiveProfile
      && pack?.indexSha256 === admission.provenance.indexSha256 && pack.manifestSha256 === admission.provenance.manifestSha256
      && pack.integrityRoot === admission.provenance.integrityRoot && result.manifest?.integrity?.root === pack.integrityRoot
      && record(contract) && Object.keys(contract).length === (this.#rendererTransitions ? 6 : 4)
      && contract.version === (this.#rendererTransitions ? '2.0' : '1.0')
      && (!this.#rendererTransitions || contract.runtimeOwner === '1.0' && contract.presenterBinding === '1.0')
      && contract.sequence === 'u64' && contract.surfaceGeneration === '1.0' && contract.inputLifetime === '1.0',
    'ERR_PROTOCOL_VERSION', 'actual Worker load disagrees with verified pins, policy, engine or observation negotiation')
    check(this.#browserQueries ? browserQueriesContract(result.browserQueries) : result.browserQueries === undefined,
      'ERR_PROTOCOL_VERSION', 'actual Worker did not honor explicit browser query negotiation')
    if (this.#rendererTransitions) check(same(result.rendererTransitions, this.#rendererTransitions)
      && same(result.runtimeOwner, this.#runtimeOwner), 'ERR_PROTOCOL_VERSION', 'Worker did not honor exact renderer transition negotiation')
    const observed = this.#copyObservation(result.observation)
    check(observed.state.currentPage?.path === admission.route && observed.state.rendererProfile === admission.effectiveProfile
      && observed.state.declaredRendererProfile === admission.declaredProfile && !observed.state.requiresRestart,
    'ERR_PROTOCOL_VERSION', 'loaded native page/profile does not match pure admission')
    if (admission.transportBackend === 'external-frame' || this.#rendererTransitions) {
      check(record(result.externalPresentation) && Object.keys(result.externalPresentation).length === 4
        && ['version', 'consumedInput', 'ackOutcome', 'physicalTarget'].every(key => result.externalPresentation[key] === '1.0'),
      'ERR_PROTOCOL_VERSION', 'actual Worker did not negotiate external input/ACK/target 1.0')
    } else check(result.externalPresentation === undefined, 'ERR_PROTOCOL_VERSION', 'DOM load cannot negotiate an external-frame presenter')
  }

  #copyObservation(raw) {
    return this.#rendererTransitions ? copyRendererTransitionObservation(raw, this.#runtimeOwner) : copyOrderedObservation(raw, this.#owner)
  }
  #observe(raw) {
    if (!this.#owner || this.#phase === 'closed') return false
    const next = this.#copyObservation(raw)
    if (this.#latest && BigInt(next.sequence) <= BigInt(this.#latest.sequence)) return false
    if (this.#latest && BigInt(next.state.surfaceGeneration) < BigInt(this.#latest.state.surfaceGeneration)) throw invalid('Worker logical input generation regressed')
    this.#latest = next
    if (!this.#live()) return true
    if (this.#rendererTransitions && (next.state.transitionRequired || this.#transition && this.#transition.phase !== 'awaiting-presentation')) {
      if (next.state.requiresRestart) this.#fault(new WorkerWebSessionError('ERR_ENGINE', 'native runtime requires restart', { observation: next }))
      else if (this.#phase === 'ready' && (!this.#transition || this.#transition.phase === 'awaiting-presentation')) {
        this.#transition = null
        void this.#queueRendererTransition().catch(() => {})
      } else this.#freezePresenter('renderer-transition-pending')
      this.#emit(); return true
    }
    this.#adapter?.receiveObservation?.(next)
    if (this.#latest !== next) return true
    if (next.state.requiresRestart) {
      this.#fault(new WorkerWebSessionError('ERR_UNSUPPORTED_CAPABILITY', 'committed route requires a replacement renderer owner',
        { requiresRestart: true, observation: next }))
    } else if (this.#live()) this.#scheduler?.observe(next)
    this.#emit(); return true
  }
  #observeResult(op, result) {
    try {
      if(op!=='native.api-resource') {
        if (!record(result) || result.observation === undefined) throw invalid(`${op} omitted the negotiated original Worker observation`)
        this.#observe(result.observation)
      }
    } catch (error) { this.#fault(error) }
    // Preserve actual successful native effects/finals even when observation
    // processing faults this owner. The adapter's guarded isCurrent prevents ACK
    // metadata or a later continuation from restoring input after that fault.
    if (op === 'renderer.transition' && Array.isArray(result?.batch?.messages)) this.#deliverBatch(result.batch)
    if (['native.complete','native.event','native.phone','native.component'].includes(op) && Array.isArray(result?.batch?.messages)) this.#deliverBatch(result.batch)
    if ((['bridge', 'view.abort', 'view.sample.abort'].includes(op)) && Array.isArray(result?.messages)) this.#batchNotice(result)
    else if (op === 'view.retire' && Array.isArray(result?.messages)) this.#deliverBatch(result)
    return result
  }
  #observeError(op, error) {
    const wire = error?.details
    if (record(wire) && wire.observation !== undefined) {
      try { this.#observe(wire.observation) } catch (failure) { this.#fault(failure) }
    } else if (this.#loadResult && record(wire) && typeof wire.code === 'string') this.#fault(invalid(`${op} error omitted its final ordered observation`))
    // finish() can fail refreshing state after a real bridge turn committed.
    // Frame/ACK batches belong to the CanvasKit consumer (which preserves them
    // independently); only raw bridge/metrics finals are owner ingress here.
    if (!['bridge', 'metrics', 'view.abort', 'view.sample.abort', 'view.retire', 'renderer.transition'].includes(op)) return
    const visited = new Set(), delivered = new Set(), stack = [{ value: wire, depth: 0 }]
    while (stack.length) {
      const { value, depth } = stack.pop()
      if (!record(value) || visited.has(value) || depth > 8) continue
      visited.add(value)
      if (op === 'renderer.transition' && Array.isArray(value.batch?.messages) && !delivered.has(value.batch)) {
        delivered.add(value.batch)
        try { this.#deliverBatch(value.batch) } catch (failure) { this.#fault(failure) }
      }
      if (Array.isArray(value.committedResult?.messages) && !delivered.has(value.committedResult)) {
        delivered.add(value.committedResult)
        try {
          // A retained success is evidence, not a replacement for the failed
          // outer turn. Correlating it here would resolve the still-pending
          // inner request before the original RPC rejection can reject it.
          if (['bridge', 'view.abort', 'view.sample.abort'].includes(op)) this.#batchNotice(value.committedResult)
          else this.#deliverBatch(value.committedResult)
        } catch (failure) { this.#fault(failure) }
      }
      for (const key of ['details', 'originalDetails']) if (record(value[key])) stack.push({ value: value[key], depth: depth + 1 })
    }
  }
  #rejectUnpostedPresenter(error, options = {}) {
    const callbackFailure = (message, cause) => {
      const failure = new WorkerWebSessionError('ERR_RPC_CALLBACK', message, { ...(cause === undefined ? {} : { cause }) })
      this.#cleanupErrors.push(failure); this.#record(failure); return failure
    }
    try {
      const returned = options?.onActualFinal?.(Object.freeze({ version: '1.0', status: 'not-posted', requestId: null }))
      if (returned && typeof returned.then === 'function') {
        void Promise.resolve(returned).catch(cause => { callbackFailure('local actual-final callback rejected', cause) })
        throw callbackFailure('local actual-final lifetime callback must be synchronous')
      }
    } catch (cause) {
      const failure = cause?.code === 'ERR_RPC_CALLBACK' ? cause : callbackFailure('local actual-final lifetime callback failed', cause)
      error = combined([error, failure], 'presenter local admission and actual-final callback failed')
    }
    return Promise.reject(error)
  }
  #requestHost(op, payload, options = {}) {
    // Keep the established fixed-family promise/control path unchanged. Only
    // negotiated mixed presenters need the extra local-admission final scope.
    if (!this.#rendererTransitions) return this.#requestHostEntered(op, payload, options, () => {})
    return this.#requestHostWithAdmissionFinal(op, payload, options)
  }
  async #requestHostWithAdmissionFinal(op, payload, options) {
    let entered = false
    try { return await this.#requestHostEntered(op, payload, options, () => { entered = true }) }
    catch (error) {
      // The scoped RPC advertises actual-final 1.0. Rejecting before the sole
      // raw RPC must settle that ownership too; an entered timeout must not.
      if (!entered) return this.#rejectUnpostedPresenter(error, options)
      throw error
    }
  }
  async #requestHostEntered(op, payload, options, enter) {
    if (op === 'close') throw invalid('only the owning close barrier can close the Worker')
    if (op === 'bridge') {
      const envelope = payload?.envelope
      const blocked = envelope?.op === 'event.batch' && !this.#effectiveInput()
        || ['view.events', 'view.geometry'].includes(envelope?.op) && !this.#domInputGate(envelope.payload?.key)
      if (blocked) throw Object.assign(stopped('input is frozen during owner/visibility/metrics transition'), { localCancellation: true })
    }
    const presenterOperation = this.#rendererTransitions && (['frame', 'frame.current', 'surface.recover', 'ack', 'resource', 'scale', 'retire', 'abort', 'view.retire', 'view.abort', 'view.sample.abort'].includes(op)
      || op === 'bridge' && ['render.commit', 'event.batch', 'view.prepare', 'view.prepare.commit', 'view.presented', 'view.geometry', 'view.events', 'view.query.result', 'view.abort', 'view.animation.baseline', 'view.sample.prepare', 'view.sample.presented', 'view.sample.abort'].includes(payload?.envelope?.op))
    let ownedActual = null, actualOptions = options
    if (presenterOperation) {
      const slot = this.#presenter
      const context = payload?.presentationContext ?? this.#presenterContext(slot)
      check(slot?.active && same(context.presenterBinding, slot.binding), 'ERR_CANCELLED', 'late presenter request cannot adopt a new binding')
      payload = { ...payload, presentationContext: context }
      let resolve, reject
      ownedActual = { promise: new Promise((yes, no) => { resolve = yes; reject = no }) }
      void ownedActual.promise.catch(() => {}); slot.actual.add(ownedActual)
      const priorActual = options.onActualFinal
      actualOptions = { ...options, onActualFinal: receipt => {
        if (slot.actual.delete(ownedActual)) {
          if (receipt?.version === '1.0' && ['final', 'not-posted'].includes(receipt.status)) resolve()
          else { const error = new WorkerWebSessionError('ERR_RPC_CLEANUP', 'presenter request ended without its genuine actual final', { receipt }); this.#cleanupErrors.push(error); reject(error) }
        }
        return priorActual?.(receipt)
      } }
    }

    const late = options.onLateResponse
    const onLateResponse = message => {
      if (!record(message) || message.version !== WORKER_RPC_VERSION || message.kind !== 'response' || message.op !== op
        || message.workerEpoch !== this.#owner?.workerEpoch || message.sessionId !== this.#owner?.sessionId) {
        this.#fault(invalid('late final belongs to another immutable Worker owner/operation')); return
      }
      if (message?.payload?.status === 'ok') {
        if (payload?.inputTiming) this.#timing(ledger => ledger?.applied(message.payload.result?.inputTiming, { late: true }))
        this.#observeResult(op, message.payload.result)
      }
      else if (message?.payload?.status === 'error') this.#observeError(op, { details: message.payload.error })
      // Observation/fault processing occurs BEFORE the consumer sees real ACKs,
      // retained prepares or their late errors. No duplicated response receive.
      return late?.(message)
    }
    let result
    try { enter(); result = await this.#rpc.requestHost(op, payload, { ...actualOptions, onLateResponse }) }
    catch (error) { this.#observeError(op, error); throw error }
    if (payload?.inputTiming) this.#timing(ledger => ledger?.applied(result?.inputTiming, { late: !this.#live() }))
    return this.#observeResult(op, result)
  }
  #receiveEvent(message) {
    try {
      if (!record(message) || message.version !== WORKER_RPC_VERSION || message.kind !== 'event'
        || message.workerEpoch !== this.#rpc?.workerEpoch || message.sessionId !== this.#rpc?.sessionId) throw invalid('Worker event belongs to another owner')
      const match = /^worker-event-([1-9][0-9]*)$/.exec(message.requestId ?? '')
      if (!match || BigInt(match[1]) <= this.#eventSequence) throw invalid('Worker event receipt sequence was duplicated or regressed')
      this.#eventSequence = BigInt(match[1])
      const payload = message.payload
      if (payload?.observation !== undefined) {
        try { this.#observe(payload.observation) } catch (error) { this.#fault(error) }
      }
      if (message.op === 'batch') {
        if (payload?.phase === 'startup') {
          if (this.#latest !== null || this.#loadResult !== null || this.#phase !== 'loading' || payload.observation !== undefined) {
            this.#fault(invalid('startup batch appeared outside the initial load boundary'))
          }
        } else if (payload?.phase !== 'live' || payload?.observation === undefined) {
          this.#fault(invalid('live batch must carry the same-turn original observation before effects'))
        }
        // Always preserve genuine effects after freezing a missing/bad producer
        // contract. Never synthesize an observation or re-enter application JS.
        this.#deliverBatch(payload)
      } else if (message.op === 'dirty') {
        if (payload?.observation === undefined) throw invalid('dirty event omitted original Worker observation')
      } else if (message.op === 'diagnostic') this.#record(payload)
      else if (message.op === 'fault') this.#fault(new WorkerWebSessionError(payload?.error?.code ?? payload?.code ?? 'ERR_ENGINE',
        payload?.error?.message ?? payload?.message ?? 'Worker fault', { details: payload }))
      else throw invalid('unknown Worker owner event')
    } catch (error) { this.#fault(error) }
    // Deliberately no Promise/RAF/resource await: promptly release event credit.
  }
  #queryBatch(batch) {
    if (!this.#browserQueries) return
    if (this.#transition && this.#transition.phase !== 'awaiting-presentation' || this.#owner?.transportBackend !== 'browser-view') return
    if (this.#adapter) {
      const returned = this.#adapter.receiveQueryBatch(batch)
      if (returned && typeof returned.then === 'function') {
        void Promise.resolve(returned).catch(error => this.#record(error))
        throw invalid('browser query batch ingress must return synchronously')
      }
      return
    }
    if (this.#phase !== 'loading') return
    const messages = Array.isArray(batch?.messages) ? batch.messages.filter(message => message?.op === 'view.query.request') : []
    if (!messages.length) return
    // Startup callbacks normally have no presented lease and emit no request.
    // Retain genuine early requests finitely until adapter construction; never
    // hold Worker event credit, original RPC completion or browser measurement.
    const retained = { messages }, bytes = measureWorkerPayload(retained, { maxBytes: 1024 * 1024 })
    check(messages.length <= 32 - this.#startupQueryCount && bytes <= 1024 * 1024 - this.#startupQueryBytes,
      'ERR_RENDER', 'startup DOM query queue exceeds its count/byte budget')
    this.#startupQueries.push(copy(retained)); this.#startupQueryCount += messages.length; this.#startupQueryBytes += bytes
  }
  #batchNotice(batch) {
    // A genuine late final can still settle an internal cleanup lease. Retired
    // account effects must never reach queries or the host's business sink.
    if (this.#identityRevocation) return
    try { this.#queryBatch(batch) } catch (error) { this.#fault(error) }
    try { this.#invoke('onBatch', batch) } catch (error) { this.#fault(error) }
  }
  #deliverBatch(batch) {
    this.#bridge?.receiveBatch(batch)
    this.#batchNotice(batch)
  }

  #presentationCurrent(revision, slot = this.#presenter) {
    return this.#live() && this.#visible && this.#visibilityPending === 0 && slot === this.#presenter && slot?.active !== false
      && (!this.#transition || this.#transition.phase === 'awaiting-presentation') && revision === String(this.#metricsRevision)
      && this.#metricsFence?.phase !== 'pending'
      && (!this.#surfaceRecovery || this.#surfaceRecovery.phase === 'awaiting-presentation')
  }
  #adapterFacade(slot = this.#presenter) {
    const adapter = this.#adapter, attempts = new Map()
    const guarded = (context, revision) => Object.freeze({ ...context,
      isCurrent: () => this.#presentationCurrent(revision, slot) && context.isCurrent() })
    const prepare = async (kind, demand, accepted, context) => {
      const revision = String(this.#metricsRevision), scoped = guarded(context, revision)
      // The same captured fence belongs to prepare AND present, even if a newer
      // local request arrives before native metrics is posted or observed.
      const candidate = await (kind === 'template' ? adapter.prepareTemplate(demand, scoped)
        : adapter.preparePaint(demand, accepted, scoped))
      attempts.set(candidate, revision)
      return candidate
    }
    return Object.freeze({
      prepareTemplate: (demand, context) => prepare('template', demand, null, context),
      preparePaint: (demand, accepted, context) => prepare('paint', demand, accepted, context),
      present: async (candidate, context) => {
        const revision = attempts.get(candidate)
        if (revision === undefined) throw invalid('presentation has no captured owner fence')
        const scoped = guarded(context, revision)
        const outcome = await adapter.present(candidate, scoped)
        // Preserve every real ACK, including a retired one. Only the newest
        // actual enabled final can finish the matching metrics transaction.
        if (outcome?.acknowledged === true && outcome.inputEnabled === true && scoped.isCurrent()
          && this.#metricsFence?.revision === revision && this.#metricsFence.phase === 'awaiting-presentation') {
          this.#metricsFence = null; this.#emit()
        }
        if (this.#transition?.phase === 'awaiting-presentation' && outcome?.acknowledged === true
          && outcome.inputEnabled === true && scoped.isCurrent() && slot === this.#presenter) {
          this.#transition = null; this.#emit()
        }
        const recovery = this.#surfaceRecovery
        if (recovery?.phase === 'awaiting-presentation' && outcome?.acknowledged === true && outcome.inputEnabled === true
          && scoped.isCurrent() && candidate.proof?.surfaceGeneration === this.#latest?.state.surfaceGeneration
          && BigInt(candidate.proof.surfaceGeneration) >= BigInt(recovery.generation)
          && BigInt(candidate.proof.surfaceGeneration) > BigInt(recovery.source.state.surfaceGeneration)) {
          this.#surfaceRecovery = null; this.#emit()
        }
        return outcome
      },
      release: async (candidate, context) => {
        try { return await adapter.release(candidate, context) } finally { attempts.delete(candidate) }
      },
      freezeInput: reason => adapter.freezeInput(reason),
      cancelOwnedWork: reason => adapter.cancelOwnedWork(reason), dispose: () => adapter.dispose(),
    })
  }
  #baseInputGate() {
    return this.#phase === 'ready' && this.#live() && this.#visible && this.#visibilityPending === 0 && this.#metricsPending === 0
      && (!this.#transition || this.#transition.phase === 'awaiting-presentation') && !this.#latest?.state.transitionRequired
      && this.#surfaceRecovery === null && this.#latest?.state.lifecycle === 'Active' && !this.#latest.state.requiresRestart
  }
  #inputGate() { return this.#baseInputGate() && this.#metricsFence === null }
  #domInputGate(key) {
    // A freshly confirmed DOM may enqueue its initial geometry before the
    // outer scheduler consumes that final. Its exact actual accepted authority
    // is admissible; an old key or mere receipt never is.
    return this.#baseInputGate() && this.#owner?.transportBackend === 'browser-view'
      && this.#metricsFence?.phase !== 'pending'
      && this.#adapter?.acceptsOwnerInput(key, String(this.#metricsRevision)) === true
  }
  #effectiveInput() {
    if (!this.#inputGate()) return false
    if (this.#owner.transportBackend === 'browser-view') return this.#scheduler?.status.accepted?.inputEnabled === true
    const authority = this.#inputAuthority, state = this.#latest.state, input = authority?.consumedInput
    const accepted = this.#scheduler?.status.accepted, proof = this.#inputProof
    return accepted?.inputEnabled === true && proof !== null && same(accepted.proof, proof)
      && authority?.enabled === true && sameOwner(authority.owner, this.#owner) && authority.canvas === this.#adapter?.canvas
      && authority.surfaceGeneration === proof.surfaceGeneration && same(authority.publication, proof.publication)
      && same(input, proof.consumedInput)
      && authority.surfaceGeneration === state.surfaceGeneration && input?.pageId === state.currentPage?.pageId
      && input?.routePath === state.currentPage?.path && sameRect(input?.viewport, state.viewport)
  }
  #publishInput(value) {
    this.#reportedInputEnabled = this.#effectiveInput()
    this.#invoke('onInput', Object.freeze({ ...value, enabled: this.#reportedInputEnabled }))
  }
  #syncInput() {
    if (this.#inputAuthority && this.#effectiveInput() !== this.#reportedInputEnabled) this.#publishInput(this.#inputAuthority)
  }
  #acceptInput(value) {
    this.#inputAuthority = value?.enabled === true ? value : null
    if (!this.#live() || this.#transition && this.#transition.phase !== 'awaiting-presentation' || !this.#visible) this.#inputAuthority = null
    if (value?.enabled === false) this.#input?.reset()
    this.#publishInput(value)
    this.#emit()
  }
  #lostSurface(value) {
    if (!this.#live()) return
    try {
      check(value?.version === '1.0' && sameOwner(value.owner, this.#owner) && u64(value.lossId)
        && this.#owner.transportBackend === 'external-frame', 'ERR_PROTOCOL_VERSION', 'surface loss needs its immutable actual owner')
      const prior = this.#surfaceRecovery
      if (prior && BigInt(value.lossId) <= BigInt(prior.lossId)) return
      // Publish the input fence and serial control slot before invoking any
      // scheduler/adapter hook. Recovery never closes or replaces this Worker.
      const recovery = { lossId: value.lossId, phase: 'draining', source: this.#latest,
        task: null, drain: null, ticket: null, native: null, generation: null, resumed: false }
      this.#surfaceRecovery = recovery; this.#inputAuthority = null
      this.#queueSurfaceRecovery(recovery)
      this.#input?.reset(); this.#emit()
    } catch (error) { this.#fault(error) }
  }
  #resumeRecoveredSurface() {
    const recovery = this.#surfaceRecovery
    if (!recovery || recovery.phase !== 'awaiting-presentation' || recovery.resumed || !this.#live()
      || !this.#visible || this.#visibilityPending || this.#metricsPending || this.#metricsFence?.phase === 'pending') return
    recovery.resumed = true
    this.#scheduler.resumeOwnedSurface(recovery.ticket, recovery.native)
  }
  #resumePresentation() {
    if (!this.#presentationCurrent(String(this.#metricsRevision))) return
    if (this.#surfaceRecovery) this.#resumeRecoveredSurface()
    else this.#scheduler?.resume()
  }
  #replaceSurfaceRecovery({ deferred = false, retry = false } = {}) {
    const previous = this.#surfaceRecovery
    if (!previous) return
    const recovery = { lossId: previous.lossId, phase: deferred ? 'blocked' : 'draining', source: this.#latest,
      task: null, drain: null, ticket: null, native: null, generation: null, resumed: false, retry }
    this.#surfaceRecovery = recovery
    if (!deferred) this.#queueSurfaceRecovery(recovery)
  }
  #queueSurfaceRecovery(recovery) {
    if (recovery.task) return recovery.task
    let setupFailure
    const current = () => this.#live() && this.#surfaceRecovery === recovery
    const task = this.#controlTail.then(async () => {
      if (setupFailure) throw setupFailure
      recovery.failureOrigin = 'drain'
      const [ticket] = await recovery.drain
      if (!current()) throw stopped('surface recovery belongs to a retired owner/loss')
      recovery.ticket = ticket; recovery.phase = 'recovering'; this.#emit()
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!current()) throw stopped('surface recovery was retired')
        const state = this.#latest.state
        if (state.lifecycle !== 'Active') {
          recovery.phase = 'blocked'; this.#emit(); return Object.freeze({ recovered: false, reason: 'background' })
        }
        const expected = copy({ sessionId: this.#owner.sessionId, pageId: state.currentPage?.pageId,
          routePath: state.currentPage?.path, viewport: state.viewport, rendererProfile: state.rendererProfile,
          templateRevision: state.templateRevision, renderRevision: state.renderRevision,
          inputLifetimeRevision: state.inputLifetimeRevision, surfaceGeneration: state.surfaceGeneration })
        let result
        recovery.failureOrigin = 'native'
        try {
          result = await this.#publicWait({}, options => this.#observedRpc.requestHost('surface.recover', { version: '1.0', expected }, options))
        } catch (error) {
          if (error?.code === 'ERR_CANCELLED' && current()) continue
          throw error
        }
        if (!current()) throw stopped('late native recovery cannot resume a retired surface')
        const native = result?.recovery, observed = result?.observation?.state
        check(native?.version === '1.0' && ['retained', 'render-required'].includes(native.kind)
          && native.sessionId === this.#owner.sessionId && native.previousRenderRevision === expected.renderRevision
          && native.previousInputLifetimeRevision === expected.inputLifetimeRevision && u64(native.inputLifetimeRevision)
          && u64(native.renderRevision)
          && BigInt(native.inputLifetimeRevision) === BigInt(expected.inputLifetimeRevision) + 1n
          && native.inputLifetimeRevision === observed?.inputLifetimeRevision && native.renderRevision === observed?.renderRevision
          && u64(observed?.surfaceGeneration) && BigInt(observed.surfaceGeneration) > BigInt(expected.surfaceGeneration)
          && (native.kind === 'retained' ? BigInt(native.renderRevision) > BigInt(expected.renderRevision)
            : native.renderRevision === expected.renderRevision),
        'ERR_PROTOCOL_VERSION', 'surface recovery requires the actual new native lifetime/generation and retained/render-required result')
        recovery.native = copy(native); recovery.generation = observed.surfaceGeneration
        recovery.failureOrigin = 'surface'
        this.#adapter.resumeOwnedSurface()
        recovery.phase = 'awaiting-presentation'
        this.#resumeRecoveredSurface(); this.#emit()
        return Object.freeze({ recovered: true, recovery: recovery.native })
      }
      recovery.phase = 'blocked'
      this.#record(stopped('surface recovery lost three exact observation races; retry explicitly'))
      this.#emit(); return Object.freeze({ recovered: false, reason: 'observation-race' })
    })
    recovery.task = task; this.#controlTail = task.catch(() => {})
    // Each drain owns actual last use, not the public cancellation receipt.
    try {
      recovery.drain ??= Promise.all([this.#scheduler.suspendOwnedSurface('webgl-context-lost'),
        this.#adapter.suspendOwnedSurface('webgl-context-lost', { retry: recovery.retry === true })])
      void recovery.drain.catch(() => {})
    } catch (error) { setupFailure = error }
    void task.catch(error => {
      if (!current()) return
      if (recovery.failureOrigin !== 'native' || ['ERR_CANCELLED', 'ERR_RPC_CANCELLED', 'ERR_RPC_TIMEOUT', 'ERR_TIMEOUT'].includes(error?.code)) this.#blockSurfaceRecovery(error)
      else this.#fault(error)
    }).finally(() => { if (recovery.task === task) recovery.task = null })
    return task
  }
  retrySurfaceRecovery() {
    try {
      this.#ready()
      check(this.#surfaceRecovery !== null, 'ERR_INVALID_REQUEST', 'there is no lost surface to recover')
      if (this.#surfaceRecovery.phase === 'awaiting-presentation') {
        this.#resumeRecoveredSurface()
        this.#scheduler.retry()
        return Promise.resolve(Object.freeze({ recovered: true, recovery: this.#surfaceRecovery.native }))
      }
      if (this.#surfaceRecovery.phase === 'blocked') {
        const recovery = this.#surfaceRecovery
        if (recovery.native && recovery.resumed) {
          // A clean presenter failure retries the existing native fence and
          // exact retained proof. An uncertain release remains rejected by
          // the scheduler and cannot mint another native generation.
          try {
            recovery.phase = 'awaiting-presentation'; this.#scheduler.retry(); this.#emit()
            return Promise.resolve(Object.freeze({ recovered: true, recovery: recovery.native }))
          } catch (error) { recovery.phase = 'blocked'; this.#emit(); throw error }
        }
        this.#scheduler.suspend('surface-retry')
        this.#replaceSurfaceRecovery({ retry: true })
        return this.#surfaceRecovery.task
      }
      return this.#queueSurfaceRecovery(this.#surfaceRecovery)
    } catch (error) { return Promise.reject(error) }
  }
  #installInput(value) {
    // Adapter owns the installed surface through close, including a callback
    // arriving after retirement. Such a callback must not replace a newer
    // helper or escape as fresh presentation evidence.
    if (!this.#live()) return
    const proof = value?.proof, submission = value?.submission, state = this.#latest?.state, consumed = proof?.consumedInput
    check(this.#owner?.transportBackend === 'external-frame' && proof?.version === '1.0'
      && sameOwner(proof.owner, this.#owner) && u64(proof.attemptId) && u64(proof.surfaceGeneration)
      && proof.publication?.kind === 'external-frame' && u64(proof.publication.renderRevision)
      && submission?.version === '1.0' && submission.status === 'submitted' && sameOwner(submission.owner, this.#owner)
      && submission.attemptId === proof.attemptId && submission.surfaceGeneration === proof.surfaceGeneration
      && submission.renderRevision === proof.publication.renderRevision && sameRect(submission.viewport, consumed?.viewport)
      && submission.physicalSize?.width === value.target?.width && submission.physicalSize?.height === value.target?.height,
    'ERR_PROTOCOL_VERSION', 'surface submission must retain its exact original owner and preparation proof')
    if (proof.surfaceGeneration !== state?.surfaceGeneration || consumed?.pageId !== state?.currentPage?.pageId
      || consumed?.routePath !== state?.currentPage?.path || !sameRect(consumed?.viewport, state?.viewport)) return
    check(value.canvas === this.#adapter?.canvas, 'ERR_PROTOCOL_VERSION', 'surface callback does not own the current adapter canvas')
    this.#inputAuthority = null
    this.#inputProof = copy(proof)
    const previous = this.#input; this.#input = null
    previous?.reset(); previous?.dispose()
    this.#current()
    // This canvas belongs to the session. Its backing store is physical; its
    // display box follows the exact frame's logical viewport, independent of
    // render density. Embedders may scale the borrowed outer surface root.
    const viewport = logicalViewport(value.proof?.consumedInput?.viewport)
    value.canvas.style.width = `${viewport.width}px`
    value.canvas.style.height = `${viewport.height}px`
    value.canvas.style.maxWidth = 'none'
    value.canvas.style.maxHeight = 'none'
    const helper = this.#factories.input(value.canvas, { session: () => this.#owner.sessionId,
      active: () => this.#effectiveInput(), epoch: () => this.#latest?.state.surfaceGeneration ?? null,
      logicalSize: () => ({ width: this.#latest.state.viewport.width, height: this.#latest.state.viewport.height }),
      ...(this.#inputLedger ? { inputTiming: {
        capture: value => this.#timing(ledger => ledger.capture({ ...value, state: this.#latest?.state })),
        queued: ids => this.#timing(ledger => ledger.queued(ids)), drop: (ids, reason) => this.#timing(ledger => ledger.drop(ids, reason)),
      } } : {}),
      send: (events, sessionId, generation, inputTiming) => {
        if (sessionId !== this.#owner.sessionId || generation !== this.#latest?.state.surfaceGeneration || !this.#effectiveInput()) {
          return Promise.reject(stopped('queued input belongs to a retired logical surface'))
        }
        return this.request('event.batch', { events }, inputTiming && this.#inputLedger ? { hostContext: { inputTiming } } : {})
      }, onError: error => this.#record(error) })
    // The helper is owned even if an injected callback closed us during attach.
    this.#input = helper
    this.#current(); this.#invoke('onSurface', value)
  }
  #installListeners() {
    const add = (target, name, listener) => {
      if (!target?.addEventListener) return
      target.addEventListener(name, listener); this.#listeners.push(() => target.removeEventListener(name, listener))
    }
    add(this.#document, 'visibilitychange', () => {
      if (this.#phase === 'ready') void this.setVisible(!this.#document.hidden).catch(error => this.#record(error))
    })
    add(this.#window, 'pagehide', () => { void this.close().catch(error => this.#record(error)) })
  }
  #publicWait(options, action) {
    const controller = new AbortController(), parent = options?.signal
    const abort = () => controller.abort(parent?.reason)
    this.#publicWaits.add(controller)
    if (parent) { parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort() }
    return Promise.resolve().then(() => { this.#ready(); return action({ ...options, signal: controller.signal }) })
      .finally(() => {
        parent?.removeEventListener('abort', abort); this.#publicWaits.delete(controller)
        if (this.#identityRevocation) throw stopped('old host identity result was revoked')
      })
  }
  request(op, payload, options = {}) {
    if (typeof op !== 'string' || !op || ['app.init', 'app.lifecycle', 'render.commit'].includes(op) || op.startsWith('view.')) {
      return Promise.reject(invalid('startup, lifecycle and presentation operations belong to the owner'))
    }
    return this.#publicWait(options, requestOptions => {
      if (op === 'event.batch' && !this.#effectiveInput()) throw stopped('no accepted current input authority')
      return this.#bridge.request(op, payload, requestOptions)
    })
  }
  /** Host-only capability transport. Guest bridge requests cannot register or
   * mint trusted context. The Worker serializes these on its ordinary owner lane.
   */
  nativeHostServices(op, payload = {}, options = {}) {
    if (!['native.take','native.complete','native.event','native.revoke','native.phone','native.component','native.snapshots','native.components','native.frame','native.media-resource','native.api-resource'].includes(op)) return Promise.reject(invalid('unknown native host services operation'))
    return this.#publicWait(options, requestOptions => this.#observedRpc.requestHost(op, payload, requestOptions))
  }
  revokeHostIdentity() {
    if (!this.#loadResult?.hostServices) return Promise.reject(invalid('native host services were not negotiated'))
    if (this.#identityRevocation && this.#identityRevocation.phase !== 'failed') return this.#identityRevocation.promise
    if (['closing', 'closed'].includes(this.#phase)) return Promise.reject(stopped('identity cleanup belongs to the closing Worker'))
    let resolve, reject
    const promise = new Promise((done, failed) => { resolve = done; reject = failed })
    void promise.catch(() => {})
    // Normal retirement is an irreversible execution fence, not an execution
    // fault. Publish it before callbacks/native posting so reentry shares the
    // same operation and no old input/result can regain authority.
    const retirement = { phase: 'pending', attempts: (this.#identityRevocation?.attempts ?? 0) + 1, error: null, promise }
    this.#identityRevocation = retirement; this.#inputAuthority = null
    for (const action of [() => this.#input?.reset(), () => this.#scheduler?.suspend('host-identity-revoked'),
      ...[...this.#publicWaits].map(controller => () => controller.abort(stopped('host identity revoked')))]) {
      try { action() } catch (error) { this.#fault(error) }
    }
    this.#startupQueries.length = 0; this.#startupQueryCount = 0; this.#startupQueryBytes = 0
    const failed = error => {
      retirement.phase = 'failed'; retirement.error = error
      this.#record(error); this.#emit(); reject(error)
    }
    try {
      Promise.resolve(this.#observedRpc.requestHost('native.revoke', {})).then(result => {
        try {
          check(result?.revoked === true && Array.isArray(result.cancellations), 'ERR_PROTOCOL_VERSION', 'native identity revoke omitted its actual retirement final')
          retirement.phase = 'revoked'; this.#emit(); resolve(result)
        } catch (error) { failed(error) }
      }, failed)
    } catch (error) { failed(error) }
    this.#emit(); return promise
  }
  setRenderScale(scale, options = {}) {
    if (!Number.isFinite(scale) || scale <= 0 || scale > 4) return Promise.reject(new WorkerWebSessionError('ERR_RENDER', 'render scale needs 0 < scale <= 4'))
    return this.#publicWait(options, requestOptions => {
      check(this.#owner.transportBackend === 'external-frame', 'ERR_UNSUPPORTED_CAPABILITY', 'physical render scale applies only to external-frame; DOM uses browser density')
      return this.#observedRpc.requestHost('scale', { scale }, requestOptions)
    })
  }
  setLogicalViewport(value, options = {}) {
    try {
      const size = logicalViewport(value)
      this.#ready()
      const { hostLayout, ...display } = this.#metrics
      return this.setWindowMetrics({ ...display, windowWidth: size.width, windowHeight: size.height,
        ...(this.#metrics.windowWidth === size.width && this.#metrics.windowHeight === size.height && hostLayout !== undefined ? { hostLayout } : {}),
        deviceOrientation: size.width > size.height ? 'landscape' : 'portrait' }, options)
    } catch (error) { return Promise.reject(error) }
  }
  setWindowMetrics(value, options = {}) {
    let metrics
    try {
      this.#ready(); metrics = windowMetrics(value)
      check(this.#metricsRevision < 18446744073709551615n, 'ERR_RENDER', 'owner metrics revision exhausted')
    } catch (error) { return Promise.reject(error) }
    const revision = String(++this.#metricsRevision)
    this.#metricsFence = Object.freeze({ revision, phase: 'pending' })
    this.#metricsPending++
    let setupFailure = null
    // Publish the serial slot before suspension/diagnostic hooks can submit a
    // nested metrics command. Call order and the newest local fence both survive.
    const executing = this.#controlTail.then(() => {
      if (setupFailure) throw setupFailure
      return this.#publicWait(options, async requestOptions => {
        try {
          const result = await this.#observedRpc.requestHost('metrics', metrics, requestOptions)
          this.#deliverBatch(result); this.#metrics = metrics
          return result
        } catch (error) {
          // Cancellation/timeout can occur after native commit. Preserve its
          // original late observation and require replacement; never unfreeze.
          if (!(['closing', 'closed'].includes(this.#phase) && ['ERR_CANCELLED', 'ERR_RPC_CANCELLED'].includes(error?.code))) this.#fault(error)
          throw error
        }
      })
    })
    const task = executing.then(result => {
      this.#metricsPending--
      if (this.#live() && revision === String(this.#metricsRevision) && this.#metricsPending === 0) {
        this.#metricsFence = Object.freeze({ revision, phase: 'awaiting-presentation' })
        if (this.#rendererTransitions && this.#transition && this.#transition.phase !== 'awaiting-presentation') {
          // A queued owner control can finish after the pending observation
          // has synchronously retired its presenter. Persist the new metrics;
          // only the successor may install/release its local input fence.
          this.#emit(); return result
        }
        try {
          if (this.#owner.transportBackend === 'browser-view') this.#setDomFence(revision, false)
          if (this.#live() && revision === String(this.#metricsRevision)) {
            this.#resumePresentation()
          }
        } catch (error) { this.#fault(error); throw error }
      }
      this.#emit(); return result
    }, error => {
      this.#metricsPending--
      // Clearing a queue count grants no permission. The durable fence remains
      // pending/faulted until an explicit replacement or a genuine new final.
      this.#emit(); throw error
    })
    this.#controlTail = task.catch(() => {})
    try {
      if (this.#owner.transportBackend === 'browser-view') this.#setDomFence(revision, true)
      this.#inputAuthority = null; this.#input?.reset()
      if (this.#live() && revision === String(this.#metricsRevision) && this.#presenter?.active !== false) this.#scheduler?.suspend('owner-metrics')
      if (this.#surfaceRecovery) this.#replaceSurfaceRecovery()
    } catch (error) { setupFailure = error; this.#fault(error) }
    this.#emit()
    return task
  }
  #setDomFence(revision, blocked) {
    if (this.#rendererTransitions && this.#transition && (!this.#adapter || this.#presenter?.active === false)) return
    const result = this.#adapter.setOwnerInputFence({ revision, blocked })
    check(record(result) && result.version === '1.0' && result.revision === revision && result.blocked === blocked,
      'ERR_PROTOCOL_VERSION', 'DOM adapter did not synchronously install the exact owner input fence')
  }
  setVisible(visible, options = {}) {
    if (typeof visible !== 'boolean') return Promise.reject(invalid('visible must be a boolean'))
    try {
      this.#ready()
      check(this.#visibilityRevision < 18446744073709551615n, 'ERR_RENDER', 'owner visibility revision exhausted')
    } catch (error) { return Promise.reject(error) }
    const revision = ++this.#visibilityRevision
    this.#visibilityPending++
    let setupFailure = null
    // Publish the serial slot before suspension can reenter through a state
    // callback. Native observations may arrive before the lifecycle final;
    // they remain scheduling inputs while this local visibility fence is held.
    const executing = this.#controlTail.then(() => {
      if (setupFailure) throw setupFailure
      return this.#publicWait(options, requestOptions => this.#bridge.request('app.lifecycle', { event: visible ? 'show' : 'hide' }, requestOptions))
    })
    const failed = error => {
      if (!(['closing', 'closed'].includes(this.#phase) && ['ERR_CANCELLED', 'ERR_RPC_CANCELLED'].includes(error?.code))) this.#fault(error)
      this.#emit(); throw error
    }
    const task = executing.then(result => {
      this.#visibilityPending--
      try {
        if (this.#live() && revision === this.#visibilityRevision) {
          this.#visible = visible
          if (visible && this.#surfaceRecovery?.phase === 'blocked') {
            this.#scheduler.suspend('owner-shown')
            this.#replaceSurfaceRecovery()
          } else if (visible) this.#resumePresentation()
        }
        this.#emit(); return result
      } catch (error) { return failed(error) }
    }, error => {
      this.#visibilityPending--
      return failed(error)
    })
    this.#controlTail = task.catch(() => {})
    if (!visible) this.#visible = false
    this.#inputAuthority = null
    try {
      this.#input?.reset(); this.#adapter?.freezeInput('owner-visibility')
      this.#scheduler?.suspend(visible ? 'owner-show-pending' : 'owner-hidden')
      // Ordinary suspension retires a GPU ticket too. Every visibility
      // control replaces that native-fence transaction; show obtains a fresh
      // ticket only after its genuine lifecycle final, never reuses the old one.
      if (this.#surfaceRecovery) this.#replaceSurfaceRecovery({ deferred: true })
    } catch (error) { setupFailure = error; this.#fault(error) }
    this.#emit()
    return task
  }
  retryPresentation() { this.#ready(); if (this.#transition?.phase === 'blocked') return this.retryRendererTransition(); if (this.#surfaceRecovery) return this.retrySurfaceRecovery(); this.#scheduler.retry(); this.#emit() }

  close() {
    if (this.#closePromise) return this.#closePromise
    let resolve, reject
    this.#closePromise = new Promise((done, failed) => { resolve = done; reject = failed })
    void this.#closePromise.catch(() => {})
    this.#phase = 'closing'; this.#inputAuthority = null; this.#visible = false
    this.#timing(ledger => ledger?.retire())
    this.#startupQueries.length = 0; this.#startupQueryCount = 0; this.#startupQueryBytes = 0
    const failures = []
    try { this.#loadAbort?.abort(stopped('Worker owner is closing')) } catch (error) { failures.push(error) }
    try { this.#input?.reset() } catch (error) { failures.push(error) }
    try { this.#adapter?.freezeInput('owner-closing') } catch (error) { failures.push(error) }
    for (const controller of this.#publicWaits) try { controller.abort(stopped('Worker owner is closing')) } catch (error) { failures.push(error) }
    for (const remove of this.#listeners.splice(0)) try { remove() } catch (error) { failures.push(error) }
    void Promise.resolve().then(async () => {
      // Wait underlying load work/late transferred resources, avoiding the
      // public loadPromise -> close -> loadPromise cleanup deadlock.
      if (this.#loadTask) await this.#loadTask.catch(() => {})
      // A concurrent identity close must retain the native outcome. Normal
      // retirement adds no failure; a genuinely failed control still does.
      if (this.#identityRevocation) try { await this.#identityRevocation.promise } catch (error) { failures.push(error) }
      let workerFinal = null, workerClosedEarly = false
      if (this.#transition && this.#transition.phase !== 'awaiting-presentation') {
        const transition = this.#transition
        const closingSlot = this.#presenter
        let resolveCurrentRetirement, rejectCurrentRetirement
        if (closingSlot?.active && closingSlot.adapter) {
          const retirement = new Promise((yes, no) => { resolveCurrentRetirement = yes; rejectCurrentRetirement = no })
          void retirement.catch(() => {})
          try {
            const drain = closingSlot.adapter.beginPresenterRetirement(retirement)
            void Promise.resolve(drain).catch(() => {})
            closingSlot.active = false
          } catch (error) { failures.push(error); rejectCurrentRetirement(error) }
        }
        // Transition cleanup may await its native retirement. Closing the sole
        // runtime supplies a broader genuine barrier; do this before waiting
        // local scheduler cleanup, never resolve retirement from cancellation.
        try {
          if (this.#rpc !== null) workerFinal = await this.#rpc.close()
          workerClosedEarly = true
          if (workerFinal?.closed !== true) throw invalid('Worker close omitted its actual shutdown final')
          transition.resolveRetirement?.(copy({ version: '1.0', retired: true,
            previousPresenterBinding: transition.old.binding, source: 'native-worker-close-final' }))
          resolveCurrentRetirement?.(copy({ version: '1.0', retired: true,
            previousPresenterBinding: closingSlot.binding, source: 'native-worker-close-final' }))
        } catch (error) { failures.push(error); transition.rejectRetirement?.(error); rejectCurrentRetirement?.(error) }
        if (transition.task) await transition.task.catch(() => {})
      }

      if (this.#cancelTask) try { await this.#cancelTask } catch (error) { failures.push(error) }
      if (this.#scheduler) {
        try { await this.#scheduler.close() } catch (error) { failures.push(error) }
      } else if (this.#adapter) {
        try { await this.#adapter.cancelOwnedWork?.('owner-closing') } catch (error) { failures.push(error) }
        try { await this.#adapter.dispose?.() } catch (error) { failures.push(error) }
      }
      try { this.#disposeUntransferredCanvas(this.#presenter) } catch (error) { failures.push(error) }
      // Scheduler close includes exact adapter last-use/remote retire. Release
      // listeners and admitted renderer leases only after that actual barrier.
      try { await this.#input?.dispose() } catch (error) { failures.push(error) }
      this.#input = null
      try { await this.#assetLease?.dispose?.() } catch (error) { failures.push(error) }
      try { await this.#bridge?.dispose() } catch (error) { failures.push(error) }
      try { if (!workerClosedEarly && this.#rpc !== null) workerFinal = await this.#rpc.close() } catch (error) { failures.push(error) }
      // A posted RPC can outlive public cancellation and diagnostic TTL. Only
      // this exact Worker's final/termination barrier ends its pinned lifetime;
      // termination without its genuine final remains a cleanup failure.
      for (const adapter of new Set([this.#adapter, ...this.#retiredPresenters.map(slot => slot.adapter)])) {
        try { await adapter?.finalizeRemoteWork?.() } catch (error) { failures.push(error) }
      }
      // Queued owner controls cannot start application work after the ready
      // fence. Settle their cancellation/finally paths before final diagnostics.
      await this.#controlTail
      try { this.#mount?.remove() } catch (error) { failures.push(error) }
      this.#phase = 'closed'; this.#emit()
      if (this.#fatal) failures.unshift(this.#fatal)
      failures.push(...this.#cleanupErrors)
      if (failures.length) throw combined(failures, 'Worker owner and cleanup failed')
      // A constructed wrapper may own an actual RPC before pure admission has
      // established a pack/backend owner tuple. Preserve both facts; owner:null
      // is not evidence that this wrapper/Worker was never constructed.
      const rpcIdentity = this.#observedRpc === null ? null : Object.freeze({
        workerEpoch: this.#observedRpc.workerEpoch, sessionId: this.#observedRpc.sessionId })
      return Object.freeze({ version: '1.0', owner: this.#owner, rpcIdentity,
        closed: true, workerClosed: workerFinal?.closed === true || this.#rpc === null,
        workerFinal, ownedMountRemoved: this.#mount?.isConnected !== true })
    }).then(resolve, reject)
    return this.#closePromise
  }
}
