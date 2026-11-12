/** Coordinator-aligned local owner manager. No bootstrap, timer pump
 * or HTTP implementation. The real WorkerWebSession owns the one AppService. */
import { measureWorkerPayload } from './worker-session-client.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (code, message) => Object.assign(new Error(message), { code })
const need = (condition, message) => { if (!condition) throw fail('ERR_PROTOCOL_VERSION', message) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
const u64 = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
const positive = value => u64(value) && value !== '0'
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const copy = value => { measureWorkerPayload(value, { maxBytes: 256 * 1024 }); return freeze(structuredClone(value)) }
const same = (a, b) => a === b || Boolean(a && b && typeof a === 'object' && typeof b === 'object'
  && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key])))
// Independently understood ABI declarations, not capability inference from a
// method or a byte pin. Old pinned producers remain usable without density.
const OWNER_SCALE_V1 = Object.freeze({ version: '1.0', fixed: 'presets-v1',
  auto: 'captured-preview-v2', worker: 'render-scale-1.0' })
const WORKER_SCALE_V1 = Object.freeze({ version: '1.0', density: 'finite-positive-up-to-4',
  startup: 'before-first-export', target: 'native-exact-revision-v1', update: 'retained-layout', metrics: 'unchanged' })
const INPUT_TIMING_V1 = Object.freeze({ version: '1.0', scope: 'skia-worker', applied: 'native-dispatch-final',
  clone: 'original-consumed-input', endpoints: 'submission-swap-runtime-ack', compositor: 'missing', physicalDisplay: 'missing' })
const sameWorker = (a, b) => record(a) && record(b) && ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend'].every(key => a[key] === b[key])
const rpcIdentityValid = value => record(value) && Object.keys(value).length === 2 && id(value.workerEpoch) && id(value.sessionId)
const workerOwnerValid = value => record(value) && Object.keys(value).length === 4
  && id(value.workerEpoch) && id(value.sessionId) && sha(value.packSha256) && ['browser-view', 'external-frame'].includes(value.transportBackend)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {}); return { promise, resolve, reject } }
const cancelled = () => fail('ERR_CANCELLED', 'browser dev intent was cancelled or superseded')
const uncertain = () => fail('ERR_RENDER', 'control or owner cleanup is uncertain; replacement is blocked')
const boundedUtf8 = (value, limit) => { let result = '', used = 0; for (const point of value) { const size = new TextEncoder().encode(point).byteLength; if (used + size > limit) break; result += point; used += size } return result }
const fact = error => Object.freeze({ code: boundedUtf8(typeof error?.code === 'string' && error.code.length ? error.code : 'ERR_ENGINE', 128),
  message: boundedUtf8(typeof error?.message === 'string' && error.message.length ? error.message : 'Browser dev operation failed', 2048) })
// DOM diagnostics can be whole bridge envelopes; Worker notifications can
// already be their payload. Read only own data fields: accessors/coercions and
// arbitrary diagnostic data must never run as a side effect of reporting.
// Proxies remain outside the transport's validated plain-data contract.
const diagnosticValue = (value, key) => {
  if (value === null || typeof value !== 'object') return undefined
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined }
  catch { return undefined }
}
const diagnosticFact = (value, { forceError = false, source } = {}) => {
  const reportedLevel = diagnosticValue(value, 'level')
  const level = !forceError && !(value instanceof Error) && ['trace', 'debug', 'info', 'warn', 'error'].includes(reportedLevel) ? reportedLevel : 'error'
  const result = { level }
  for (const key of ['code', 'name']) {
    const text = diagnosticValue(value, key)
    if (typeof text === 'string' && text.length) result[key] = boundedUtf8(text, 128)
  }
  const message = diagnosticValue(value, 'message'), stack = diagnosticValue(value, 'stack')
  result.message = boundedUtf8(typeof message === 'string' && message.length ? message : 'Runtime diagnostic has no message', 2048)
  if (['quickjs', 'v8'].includes(source)) result.source = source
  if (typeof stack === 'string' && stack.length) {
    result.stack = boundedUtf8(stack, 8192)
    if (result.stack !== stack) result.stackTruncated = true
  }
  return Object.freeze(result)
}
const diagnosticFacts = value => {
  const op = diagnosticValue(value, 'op'), payload = diagnosticValue(value, 'payload')
  const responseError = diagnosticValue(value, 'kind') === 'response' && diagnosticValue(payload, 'ok') === false
  const body = op === 'diagnostic' || op === 'error' || responseError ? payload : value
  const single = diagnosticValue(body, 'error'), errors = diagnosticValue(body, 'errors'), source = diagnosticValue(body, 'source')
  const length = Array.isArray(errors) ? diagnosticValue(errors, 'length') : 0
  const count = (single === undefined ? 0 : 1) + length
  const forceError = op === 'error' || responseError || count > 0
  if (!count) return [diagnosticFact(body, { forceError, source })]
  // Bound expansion independently of the transport byte budget. Reserve the
  // final slot for an explicit omission notice instead of silently dropping.
  const limit = count > 32 ? 31 : count, result = []
  for (let index = 0; index < limit; index++) {
    const item = single !== undefined && index === 0 ? single : diagnosticValue(errors, String(index - (single === undefined ? 0 : 1)))
    result.push(diagnosticFact(item, { forceError: true, source }))
  }
  if (count > 32) result.push(Object.freeze({ level: 'warn', code: 'DIAGNOSTIC_TRUNCATED',
    message: `${count - limit} additional runtime errors were omitted (32 record limit)` }))
  return result
}
const combined = (message, errors) => Object.assign(new AggregateError([...new Set(errors)], message), { code: 'ERR_RENDER' })
const digest = async bytes => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
const leaseValid = value => record(value) && value.version === '1.0' && id(value.runId) && id(value.previewId) && positive(value.leaseRevision)
const keyValid = value => record(value) && positive(value.activationId) && positive(value.ownerSerial) && id(value.clientOwnerId)
function clientOwnerIdentity(clientId) {
  const crypto = globalThis.crypto
  need(typeof crypto?.randomUUID === 'function', 'a cryptographic random UUID is required for each inert owner intent')
  const nonce = crypto.randomUUID()
  need(typeof nonce === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce),
    'inert owner UUID must be a canonical bounded random UUID')
  const result = `${clientId}:owner-${nonce}`
  need(id(result), 'inert owner identity exceeds its protocol bound')
  return result
}
const exactUrl = (value, base, path) => {
  need(typeof value === 'string' && value.length <= 4096 && !/[\\%?#\x00-\x20\x7f]/.test(value)
    && !/(?:^|\/)\.\.?(?:\/|$)/.test(value), 'invalid immutable URL spelling')
  const url = new URL(value, base)
  need(url.origin === base.origin && !url.username && !url.password && url.pathname === path, 'resource left its immutable same-origin namespace')
  return url.href
}
function offered(value, base) {
  const result = copy(value), site = result.site
  need(record(site) && site.version === '1.0' && id(site.runId) && positive(site.siteId) && sha(site.tokenId)
    && record(site.portable) && positive(site.portable.packGeneration) && u64(site.portable.sourceRevision)
    && u64(site.portable.compilerReceiptSequence) && sha(site.portable.manifestSha256) && sha(site.portable.integrityRoot)
    && typeof site.portable.selectedRoute === 'string' && record(site.runtime) && sha(site.runtime.bundleSha256)
    && record(site.startup) && positive(site.startup.revision) && sha(site.startup.sha256) && u64(site.startup.metricsRevision)
    && record(site.index) && sha(site.index.sha256) && positive(site.index.size) && BigInt(site.index.size) <= 2n * 1024n * 1024n
    && sha(site.descriptorSha256) && ['browser-view', 'external-frame'].includes(site.transportBackend)
    && typeof result.startupJson === 'string' && new TextEncoder().encode(result.startupJson).byteLength <= 64 * 1024, 'invalid coordinator site/startup projection')
  need(Object.keys(site.runtime).length === 4
    && ['bundleSha256', 'producerReportSha256', 'sourceInventorySha256'].every(key => sha(site.runtime[key]))
    && typeof site.runtime.sourceCommit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(site.runtime.sourceCommit), 'runtime provenance pins are incomplete or contain unsupported receipts')
  const runtimeBaseUrl = exactUrl(site.runtimeBaseUrl, base, `/__weapp/runtime/${site.runtime.bundleSha256}/`)
  const indexUrl = exactUrl(site.indexUrl, base, `/__weapp/pack/${site.runId}/${site.siteId}/pack-index.json`)
  const descriptorUrl = exactUrl(site.descriptorUrl, base, `/__weapp/site/${site.runId}/${site.siteId}/site.json`)
  return copy({ ...result, site: { ...site, runtimeBaseUrl, indexUrl, descriptorUrl } })
}
function startupOptions(json, site, displayDensity) {
  const config = copy(JSON.parse(json))
  need(config.schemaVersion === 1 && config.execution === 'worker' && config.engine === 'quickjs', 'startup requires the pinned QuickJS Worker product config')
  need(record(config.index) && config.index.url === './pack-index.json' && config.index.sha256 === site.index.sha256
    && config.index.size === Number(site.index.size) && record(config.viewport)
    && ['width', 'height'].every(key => Number.isSafeInteger(config.viewport[key]) && config.viewport[key] > 0 && config.viewport[key] <= 4096)
    && record(config.rendererPolicy) && (config.rendererPolicy.mode === 'manifest' && Object.keys(config.rendererPolicy).length === 1
      || config.rendererPolicy.mode === 'force' && Object.keys(config.rendererPolicy).length === 2 && ['skia', 'skyline-compat', 'webview'].includes(config.rendererPolicy.profile)), 'startup index/viewport/renderer does not match its site')
  need(config.route === undefined || config.route === site.portable.selectedRoute, 'startup route differs from authoritative selected route')
  need(config.renderScale === undefined || (site.transportBackend === 'external-frame'
    && (config.renderScale === 'auto' || [1, 1.5, 2, 3, 4].includes(config.renderScale))),
  'startup renderScale requires external-frame and auto, 1, 1.5, 2, 3 or 4')
  const result = { engine: 'quickjs', renderer: 'auto', viewport: config.viewport, rendererPolicy: config.rendererPolicy,
    route: site.portable.selectedRoute, indexUrl: site.indexUrl, indexSha256: site.index.sha256, indexSize: Number(site.index.size) }
  if (config.renderScale !== undefined) {
    // Resolve from this original preview before any old owner retirement, so
    // an over-budget automatic target leaves that exact owner runnable. The
    // candidate receives an explicit captured-auto profile, never a second
    // density sample or a fractional number disguised as a public preset.
    need(config.renderScale !== 'auto' || Number.isFinite(displayDensity) && displayDensity > 0 && displayDensity <= 4, 'invalid preview display density')
    const scale = config.renderScale === 'auto' ? displayDensity : config.renderScale
    const width = Math.ceil(config.viewport.width * scale), height = Math.ceil(config.viewport.height * scale)
    need(width <= 4096 && height <= 4096 && width * height * 4 <= 16 * 1024 * 1024,
      'startup renderScale exceeds the physical target budget')
    result.renderScale = config.renderScale === 'auto'
      ? { version: '1.0', mode: 'captured-auto', requested: 'auto', displayDensity, effectiveScale: scale } : scale
  }
  for (const key of ['metrics', 'data', 'query', 'launchOptions', 'rendererAssets']) if (config[key] !== undefined) result[key] = config[key]
  return copy(result)
}
function bindingMatches(binding, site, lease) {
  return record(binding) && binding.version === '1.0' && binding.runId === site.runId && binding.siteId === site.siteId
    && binding.tokenId === site.tokenId && positive(binding.activationId) && same(binding.preview, lease)
    && binding.startupRevision === site.startup.revision && binding.runtimeBundleSha256 === site.runtime.bundleSha256 && binding.indexSha256 === site.index.sha256
}
function stateValue(value) {
  need(record(value), 'owner callback requires status')
  const recovery = value.surfaceRecovery
  if (recovery != null) need(record(recovery) && recovery.version === '1.0' && positive(recovery.lossId)
    && ['draining', 'recovering', 'blocked', 'awaiting-presentation'].includes(recovery.phase)
    && (recovery.surfaceGeneration === null || positive(recovery.surfaceGeneration)), 'invalid local surface-recovery status')
  return copy({ owner: value.owner ?? null, runtimeReady: value.runtimeReady === true, inputEnabled: value.inputEnabled === true,
    requiresRestart: value.requiresRestart === true, metricsFence: value.metricsFence ?? null,
    surfaceRecovery: recovery == null ? null : { version: '1.0', lossId: recovery.lossId, phase: recovery.phase, surfaceGeneration: recovery.surfaceGeneration },
    observation: value.observation ?? null, presentation: value.presentation ? { accepted: value.presentation.accepted ?? null, phase: value.presentation.phase } : null })
}
// Diagnostic metadata never grants presentation or input authority. Only the
// scheduler's matching accepted proof can promote a submitted picture below.
function surfaceSubmission(value) {
  const v = value?.submission, c = v?.context, b = v?.runtimeBoundary, p = v?.presentation
  need(record(v) && v.version === '1.0' && v.status === 'submitted' && workerOwnerValid(v.owner)
    && v.owner.transportBackend === 'external-frame' && positive(v.attemptId) && positive(v.surfaceGeneration)
    && positive(v.renderRevision) && Number.isSafeInteger(v.frameId) && v.frameId >= 0
    && Number.isSafeInteger(v.presenterGeneration) && v.presenterGeneration > 0
    && v.backend === 'canvaskit-webgl2', 'invalid CanvasKit submission identity')
  need(record(v.viewport) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(v.viewport[key]))
    && v.viewport.width > 0 && v.viewport.height > 0 && record(v.physicalSize)
    && ['width', 'height'].every(key => Number.isSafeInteger(v.physicalSize[key]) && v.physicalSize[key] > 0 && v.physicalSize[key] <= 4096),
  'invalid CanvasKit submission dimensions')
  need(record(c) && c.api === 'webgl2' && c.surfaceIsGpu === true && c.contextLost === false && c.physicalHardware === 'unknown'
    && ['version', 'vendor', 'renderer'].every(key => typeof c[key] === 'string' && new TextEncoder().encode(c[key]).byteLength <= 512)
    && ['unmaskedVendor', 'unmaskedRenderer'].every(key => c[key] === null || typeof c[key] === 'string' && new TextEncoder().encode(c[key]).byteLength <= 512),
  'invalid CanvasKit context diagnostic')
  need(b?.frameBatches === 1 && b.perNodeRuntimeCalls === 0 && b.softwareRgbaUploads === 0
    && p?.pictureSubmissions === 1 && p.flushes === 1 && p.gpuCompletion === 'not-waited' && p.glError === 0,
  'invalid CanvasKit submission boundary')
  return copy({ version: '1.0', status: 'submitted', owner: v.owner, attemptId: v.attemptId,
    surfaceGeneration: v.surfaceGeneration, renderRevision: v.renderRevision, frameId: v.frameId,
    presenterGeneration: v.presenterGeneration, viewport: { x: v.viewport.x, y: v.viewport.y, width: v.viewport.width, height: v.viewport.height },
    physicalSize: { width: v.physicalSize.width, height: v.physicalSize.height }, backend: v.backend,
    context: { api: c.api, version: c.version, vendor: c.vendor, renderer: c.renderer,
      unmaskedVendor: c.unmaskedVendor, unmaskedRenderer: c.unmaskedRenderer, surfaceIsGpu: true, contextLost: false, physicalHardware: 'unknown' },
    runtimeBoundary: { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 },
    presentation: { pictureSubmissions: 1, flushes: 1, gpuCompletion: 'not-waited', glError: 0 } })
}
async function importRealRuntime({ baseUrl }) {
  const [owner, admission] = await Promise.all([import(new URL('worker-web-session.mjs', baseUrl).href), import(new URL('worker-admission-loader.mjs', baseUrl).href)])
  need(typeof owner.WorkerWebSession === 'function' && typeof admission.createWorkerAdmissionLoader === 'function', 'runtime is missing the real owner/admission exports')
  return { createSession: options => new owner.WorkerWebSession(options), createLoader: admission.createWorkerAdmissionLoader,
    ownerRenderScaleContract: owner.WORKER_OWNER_RENDER_SCALE_CONTRACT, renderScaleContract: owner.WORKER_RENDER_SCALE_CONTRACT,
    inputTimingContract: owner.INPUT_TIMING_CONTRACT }
}

export class BrowserDevOwnerManager {
  #root; #base; #lease; #clientId; #control; #boundedAdapter; #import; #hash; #sinks; #limits
  #runtime = new Map(); #rendererReleases = new Set(); #offers = new Set(); #jobs = new Map(); #commands = new Map(); #snapshot = null; #desired = null; #entry = null
  #serial = 0n; #requestSerial = 0n; #cleanupSerial = 0n; #normalCommands = 0; #cleanupCommands = 0; #tail = Promise.resolve(); #controlTail = Promise.resolve(); #phase = 'idle'; #history = []
  #acknowledge; #ackPending = 0; #ackInFlight = 0; #ackFailed = 0; #ackBlocked = 0; #ackCursor = null
  #controlWork = new Set()
  #inputTiming = null
  #retire; #retirementJobs = new Set(); #retirements = { normal: null, cleanup: null }; #retirementTurn = 'normal'; #retiredCommands = 0n; #locallyDiscardedCommands = 0n
  #commandLanes = { normal: { head: null, tail: null, through: '0' }, cleanup: { head: null, tail: null, through: '0' } }
  #uncertain = null; #cleanupFailure = null; #controlConflict = null; #closed = false; #closePromise = null; #recoverPromise = null; #emitting = false
  constructor({ surfaceRoot, baseUrl, preview, clientId = globalThis.crypto?.randomUUID?.(), control, runBounded, importRuntime = importRealRuntime, sha256 = digest,
    onState, onError, onDiagnostic, onBatch, onInput, onSurface, timeoutMs = 30_000, closeTimeoutMs = 35_000,
    maxRuntimeBundles = 2, maxPendingOffers = 16, maxControlCommands = 4096, maxPermitRetries = 2, maxFinalAcknowledgementsInFlight = 8, inputTiming } = {}) {
    this.#base = new URL(baseUrl)
    need(['http:', 'https:'].includes(this.#base.protocol) && !this.#base.username && !this.#base.password, 'HTTP(S) base is required')
    need(surfaceRoot && typeof surfaceRoot.append === 'function' && typeof surfaceRoot.ownerDocument?.createElement === 'function', 'borrow a real surface root')
    need(id(clientId) && clientId.length <= 64, 'unique bounded client instance identity is required')
    need(leaseValid(preview) && control && typeof control.invoke === 'function' && typeof control.replay === 'function'
      && [runBounded, importRuntime, sha256].every(value => typeof value === 'function'), 'exact preview/control replay/deadline adapters are required')
    need(control.acknowledge === undefined || typeof control.acknowledge === 'function', 'optional final acknowledgement must be a function')
    need([onState, onError, onDiagnostic, onBatch, onInput, onSurface].every(value => value === undefined || typeof value === 'function'), 'observers must be functions')
    need([timeoutMs, closeTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 120_000)
      && Number.isSafeInteger(maxRuntimeBundles) && maxRuntimeBundles > 0 && maxRuntimeBundles <= 4
      && Number.isSafeInteger(maxPendingOffers) && maxPendingOffers > 0 && maxPendingOffers <= 64
      && Number.isSafeInteger(maxControlCommands) && maxControlCommands > 0 && maxControlCommands <= 16384
      && Number.isSafeInteger(maxPermitRetries) && maxPermitRetries >= 0 && maxPermitRetries <= 4
      && Number.isSafeInteger(maxFinalAcknowledgementsInFlight) && maxFinalAcknowledgementsInFlight > 0 && maxFinalAcknowledgementsInFlight <= 64, 'finite lifetime budgets are required')
    this.#acknowledge = control.acknowledge?.bind(control)
    if (control.capabilities?.retirementVersion !== undefined) {
      need(control.capabilities.retirementVersion === '1.0' && this.#acknowledge && typeof control.retire === 'function', 'negotiated retirement requires the original ACK/retire transport')
      this.#retire = control.retire.bind(control)
    }
    this.#root = surfaceRoot; this.#lease = copy(preview); this.#clientId = clientId; this.#control = control; this.#boundedAdapter = runBounded; this.#import = importRuntime; this.#hash = sha256
    this.#sinks = { onState, onError, onDiagnostic, onBatch, onInput, onSurface }
    this.#limits = { timeoutMs, closeTimeoutMs, maxRuntimeBundles, maxPendingOffers, maxControlCommands, maxPermitRetries, maxFinalAcknowledgementsInFlight }
    need(inputTiming === undefined || record(inputTiming) && Object.keys(inputTiming).length === 1 && inputTiming.version === '1.0', 'unsupported input timing contract')
    this.#inputTiming = inputTiming === undefined ? null : copy(inputTiming)
  }
  get status() {
    const entry = this.#entry
    return Object.freeze({ phase: this.#phase, clientId: this.#clientId, preview: this.#lease, snapshot: this.#snapshot, desired: this.#desired?.identity ?? null,
      executing: entry ? Object.freeze({ identity: entry.identity, ownerKey: entry.key, owner: entry.owner, registered: entry.key !== null,
        constructed: entry.session !== null, retired: entry.retired, runtimeReady: entry.runtimeReady && !entry.retired && !entry.fatal,
        hasPresented: entry.presented, submission: this.#submissionStatus(entry), surfaceRecovery: entry.state?.surfaceRecovery ?? null,
        inputEnabled: !this.#closed && !this.#controlConflict && !entry.retired && !entry.fatal && entry.runtimeReady && !entry.state?.surfaceRecovery && entry.state?.inputEnabled === true }) : null,
      uncertain: this.#uncertain ? Object.freeze({ identity: this.#uncertain.tx.identity, requestId: this.#uncertain.op?.request.requestId ?? null,
        command: this.#uncertain.op?.request.command ?? null, error: fact(this.#uncertain.error) }) : null,
      cleanupFailure: this.#cleanupFailure ? fact(this.#cleanupFailure) : null, terminalControlFailure: this.#controlConflict ? fact(this.#controlConflict) : null,
      finalAcknowledgements: this.#ackStatus(), controlRetirements: this.#retirementStatus(), transportDrained: this.#transportDrained(),
      pendingOperations: Object.freeze([...this.#jobs.values()]), history: Object.freeze([...this.#history]) })
  }
  #remember(kind, identity, value) { this.#history.push(Object.freeze({ kind, identity, value })); if (this.#history.length > 96) this.#history.shift() }
  #notify(name, value) {
    try {
      const returned = this.#sinks[name]?.(value)
      if (returned && typeof returned.then === 'function') { void Promise.resolve(returned).catch(error => this.#remember('observer-error', null, fact(error))); throw fail('ERR_PROTOCOL_VERSION', 'observers must be synchronous') }
    } catch (error) { this.#remember('observer-error', null, fact(error)) }
  }
  #emit() { if (!this.#emitting) { this.#emitting = true; try { this.#notify('onState', this.status) } finally { this.#emitting = false } } }
  #release(tx) { if (tx?.done && tx.jobs.size === 0) this.#offers.delete(tx) }
  #track(promise, tx, phase) {
    const task = Promise.resolve(promise); this.#jobs.set(task, Object.freeze({ identity: tx?.identity ?? null, phase })); tx?.jobs.add(task); if (tx) this.#offers.add(tx)
    const settle = () => { this.#jobs.delete(task); tx?.jobs.delete(task); this.#release(tx) }
    task.then(settle, error => { settle(); this.#remember('actual-rejected', tx?.identity ?? null, Object.freeze({ phase, error: fact(error) })) })
    return task
  }
  #commandJob(op, run) {
    need(!op.retiring && !op.retired && !op.locallyDiscarded, 'released command cannot start another transport operation')
    op.actual++
    // The reservation precedes adapter/property access and synchronous reentry.
    return Promise.resolve().then(run).finally(() => { op.actual-- })
  }
  #trackControlWork(settlement) {
    this.#controlWork.add(settlement)
    const release = () => this.#controlWork.delete(settlement)
    void settlement.then(release, release)
  }
  /** Snapshot barrier for already-reserved ACK/retirement work, including
   * manager adoption/failure bookkeeping and synchronous state observers.
   * Does not admit/retry anything or wait for invoke/replay, owner cleanup or
   * work registered after this call. Failed/queued work remains in status. */
  async drainControlWork() {
    await Promise.allSettled([...this.#controlWork])
    return this.status
  }
  #transportDrained() { return this.#jobs.size === 0 && this.#ackPending === 0 && this.#retirementJobs.size === 0
    && Object.values(this.#retirements).every(value => value === null) }
  #wait(promise, tx, phase, signal, cleanup = false) {
    let settled = false
    const actual = this.#track(Promise.resolve(promise).finally(() => { settled = true }), tx, phase)
    return Promise.resolve().then(() => this.#boundedAdapter(actual, Object.freeze({ phase, identity: tx?.identity ?? null, signal,
      timeoutMs: cleanup ? this.#limits.closeTimeoutMs : this.#limits.timeoutMs }))).then(() => {
      need(settled, 'deadline adapter fabricated completion before actual settlement'); return actual
    }).catch(error => { this.#remember('wait-failed', tx?.identity ?? null, Object.freeze({ phase, pending: !settled, error: fact(error) })); throw error })
  }
  #current(tx) { return !this.#closed && this.#desired === tx && !tx.abort.signal.aborted }
  #check(tx) { if (!this.#current(tx)) throw cancelled(); if (this.#uncertain || this.#cleanupFailure || this.#controlConflict) throw uncertain() }
  #failure(tx, phase, error) {
    const value = Object.freeze({ identity: tx.identity, phase, error: fact(error), previousOwnerPreserved: Boolean(this.#entry && this.#entry.tx !== tx && !this.#entry.retired) })
    this.#remember('failure', tx.identity, value); tx.ready?.reject(error); tx.presented?.reject(error)
    if (this.#current(tx)) { this.#phase = 'failed'; this.#notify('onError', value); this.#emit() }
  }
  #markUncertain(tx, op, error) { this.#uncertain ??= { tx, op, error }; this.#phase = 'uncertain'; this.#remember('uncertain', tx.identity, fact(error)); this.#emit() }
  #snapshotValue(value) {
    const snapshot = copy(value)
    need(snapshot.version === '1.0' && snapshot.runId === this.#lease.runId && u64(snapshot.controlRevision) && u64(snapshot.terminalCleanupRevision)
      && typeof snapshot.stopped === 'boolean' && (snapshot.preview === null || same(snapshot.preview, this.#lease))
      && (snapshot.ownerKey === null || keyValid(snapshot.ownerKey)), 'invalid coordinator snapshot/lease')
    const comparison = !this.#snapshot ? 1 : BigInt(snapshot.controlRevision) > BigInt(this.#snapshot.controlRevision) ? 1
      : BigInt(snapshot.controlRevision) < BigInt(this.#snapshot.controlRevision) ? -1
        : BigInt(snapshot.terminalCleanupRevision) > BigInt(this.#snapshot.terminalCleanupRevision) ? 1
          : BigInt(snapshot.terminalCleanupRevision) < BigInt(this.#snapshot.terminalCleanupRevision) ? -1 : 0
    if (comparison > 0) this.#snapshot = snapshot
    else if (comparison === 0) need(same(snapshot, this.#snapshot), 'same control/cleanup revision pair has conflicting snapshots')
    return snapshot
  }
  #adopt(op, raw) {
    const value = copy(raw)
    need(value.version === '1.0' && value.requestId === op.request.requestId && value.command === op.request.command
      && ['ok', 'error'].includes(value.status), 'queued/mismatched transport receipt is not a final')
    if (op.finalValue) { need(same(op.finalValue, value), 'exact request replay changed its final'); return value }
    this.#snapshotValue(value.snapshot)
    if (value.status === 'error') need(record(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string', 'invalid final error')
    else {
      if (op.request.command === 'issueActivation') need(value.result?.controlRevision === value.snapshot.controlRevision, 'permit revision does not match its actual issue final')
      this.#applyControl(op.tx, op.request.command, op.request.payload, value.result)
    }
    op.finalValue = value; op.final.resolve(value)
    return value
  }
  #acceptFinal(op, raw) {
    let value
    try { value = this.#adopt(op, raw) } catch (error) {
      if (op.finalValue) {
        // Equivocation after an adopted genuine final is terminal protocol
        // failure, whether it arrives on invoke or an already-timed-out replay.
        if (op.ack && op.ack.state !== 'acknowledged' && !op.ack.blocked) { op.ack.blocked = true; this.#ackBlocked++ }
        op.finalConflict = error; const firstConflict = this.#controlConflict === null; this.#controlConflict ??= error
        if (firstConflict && this.#entry) void this.#closeLocal(this.#entry).catch(() => {})
        this.#markUncertain(op.tx, op, error)
      }
      throw error
    }
    // ACK is downstream of complete adoption and the client's retained final.
    // Keep its errors OUTSIDE the protocol-conflict catch above. This is the
    // transport's original parsed object, never the copied op.finalValue.
    if (this.#acknowledge && !op.ack) {
      op.ack = { raw, state: 'pending', actual: null, error: null, blocked: false }; this.#ackPending++
      this.#startFinalAcknowledgement(op)
    }
    return value
  }
  #ackStatus() {
    return Object.freeze({ enabled: Boolean(this.#acknowledge), pending: this.#ackPending, inFlight: this.#ackInFlight,
      failed: this.#ackFailed, blocked: this.#ackBlocked, queued: this.#ackPending - this.#ackInFlight - this.#ackFailed,
      maxInFlight: this.#limits.maxFinalAcknowledgementsInFlight })
  }
  #startFinalAcknowledgement(op) {
    const ack = op.ack
    if (!ack || ack.state === 'acknowledged' || ack.actual || op.finalConflict) return false
    // This exact object is a WeakMap key owned by the transport. Freezing JSON
    // does not replace it or prevent external WeakMap metadata. Check/freeze
    // before asynchronous delivery so queued retries cannot ACK mutated data.
    try { need(same(ack.raw, op.finalValue), 'original parsed final changed after adoption'); freeze(ack.raw) }
    catch (error) {
      if (ack.state !== 'failed') this.#ackFailed++
      ack.state = 'failed'; ack.error = fact(error)
      this.#remember('final-ack-failed', op.tx.identity, { requestId: op.request.requestId, error: ack.error }); this.#emit(); return false
    }
    if (this.#ackInFlight >= this.#limits.maxFinalAcknowledgementsInFlight) return false
    if (ack.state === 'failed') this.#ackFailed--
    ack.state = 'in-flight'; ack.error = null; this.#ackInFlight++
    const actual = this.#commandJob(op, () => this.#acknowledge(op.request, ack.raw))
    ack.actual = actual
    // Separate actual ACK resource, attached to the SAME immutable command.
    // It does not join owner #jobs, consume a command serial, retry invoke, or
    // block mandatory old-owner close. Status/close report it explicitly.
    this.#trackControlWork(actual.then(() => {
      ack.actual = null; ack.state = 'acknowledged'; ack.raw = null; this.#ackInFlight--; this.#ackPending--
      if (ack.blocked) { ack.blocked = false; this.#ackBlocked-- }
      this.#remember('final-acknowledged', op.tx.identity, { requestId: op.request.requestId }); this.#emit()
    }, error => {
      ack.actual = null; ack.state = 'failed'; ack.error = fact(error); this.#ackInFlight--; this.#ackFailed++
      this.#remember('final-ack-failed', op.tx.identity, { requestId: op.request.requestId, error: ack.error }); this.#emit()
    }))
    return true
  }
  /** Start a bounded retry batch; do not await transport or schedule a timer.
   * In-flight ACKs keep their original promise. Conflicting operations cannot
   * retry. Caller retains its control transport until pending ACKs settle or
   * are explicitly cancelled/closed by that transport. */
  retryFinalAcknowledgements({ maxOperations = 16 } = {}) {
    need(Number.isSafeInteger(maxOperations) && maxOperations > 0 && maxOperations <= 64, 'finite final acknowledgement retry budget is required')
    let inspected = 0, started = 0, reachedEnd = false
    this.#ackCursor ??= this.#commands.values()
    while (inspected < maxOperations && this.#ackInFlight < this.#limits.maxFinalAcknowledgementsInFlight) {
      inspected++; const next = this.#ackCursor.next()
      if (next.done) { this.#ackCursor = this.#commands.values(); reachedEnd = true; break }
      if (this.#startFinalAcknowledgement(next.value)) started++
    }
    return Object.freeze({ inspected, started, reachedEnd, finalAcknowledgements: this.#ackStatus(),
      controlRetirements: this.#retirementStatus(), transportDrained: this.#transportDrained() })
  }
  #retirementStatus() {
    const pending = Object.values(this.#retirements).filter(Boolean)
    return Object.freeze({ enabled: Boolean(this.#retire), pending: pending.length, inFlight: this.#retirementJobs.size,
      failed: pending.filter(value => value.error !== null).length, retiredCommands: String(this.#retiredCommands),
      locallyDiscardedCommands: String(this.#locallyDiscardedCommands),
      retainedCommands: this.#commands.size, normalRetained: this.#normalCommands, cleanupRetained: this.#cleanupCommands,
      normalThrough: this.#commandLanes.normal.through, cleanupThrough: this.#commandLanes.cleanup.through })
  }
  #canRetire(op) {
    return op.invoked && !op.neverInvoked && !op.retired && op.actual === 0 && op.finalValue !== null
      && !op.finalConflict && op.ack?.state === 'acknowledged' && !op.ack.actual && !op.ack.blocked
      && this.#uncertain?.op !== op && this.#uncertain?.tx !== op.tx && !this.#controlConflict
      && op.tx.done && op.tx.jobs.size === 0
  }
  #canDiscardLocally(op) {
    return op.neverInvoked && !op.invoked && !op.retired && !op.retiring && !op.locallyDiscarded
      && op.actual === 0 && op.finalValue === null && !op.ack && !op.replayRaw && !op.finalConflict
      && this.#uncertain?.op !== op && this.#uncertain?.tx !== op.tx && !this.#controlConflict
      && op.tx.done && op.tx.jobs.size === 0
  }
  #discardLocalHead(laneName, op) {
    const lane = this.#commandLanes[laneName]
    need(lane.head === op && this.#commands.get(op.request.requestId) === op && this.#canDiscardLocally(op), 'local discard requires a settled never-transmitted prefix')
    lane.head = op.next; if (lane.head === null) lane.tail = null
    this.#commands.delete(op.request.requestId); op.locallyDiscarded = true; op.next = null
    if (op.tx.op === op) op.tx.op = null
    if (laneName === 'cleanup') this.#cleanupCommands--; else this.#normalCommands--
    this.#locallyDiscardedCommands++; this.#ackCursor = null
    // A locally reserved serial was never admitted by the transport. Preserve
    // both serial high-waters and the server retirement cursor unchanged.
    this.#remember('control-discarded-locally', null, { lane: laneName, requestId: op.request.requestId })
  }
  #startRetirement(batch) {
    if (batch.actual) return false
    // Preserve this exact batch across failed/lost replies; no replacement
    // prefix can bypass a possibly committed server transaction.
    const actual = Promise.resolve().then(() => this.#retire(batch.requests)).then(raw => {
      const value = copy(raw), lane = this.#commandLanes[batch.laneName]
      need(record(value) && Object.keys(value).sort().join(',') === 'clientId,lane,outcome,prefixSha256,previousThrough,retiredCount,runId,throughSerial,version'
        && value.version === '1.0' && value.runId === this.#lease.runId && value.clientId === this.#clientId
        && value.lane === batch.laneName && value.previousThrough === batch.previousThrough
        && value.throughSerial === batch.throughSerial && sha(value.prefixSha256)
        && value.retiredCount === batch.ops.length && value.outcome === 'retired', 'mismatched authenticated control retirement receipt')
      need(lane.through === batch.previousThrough && lane.head === batch.ops[0], 'retirement no longer names the original retained prefix')
      // The transport promise includes its original hash/fetch/reader/relay
      // cleanup. Only now release the manager's original command records.
      // Validate the complete prefix before deleting any retained record.
      let cursor = lane.head
      for (const op of batch.ops) {
        need(cursor === op && op.retiring && this.#commands.get(op.request.requestId) === op, 'retirement prefix changed')
        cursor = op.next
      }
      for (const op of batch.ops) {
        lane.head = op.next; this.#commands.delete(op.request.requestId); op.retired = true; op.retiring = false
        op.next = null
        if (op.tx.op === op) op.tx.op = null
        if (batch.laneName === 'cleanup') this.#cleanupCommands--; else this.#normalCommands--
      }
      if (lane.head === null) lane.tail = null
      lane.through = batch.throughSerial; this.#retiredCommands += BigInt(batch.ops.length); this.#ackCursor = null
      this.#remember('control-retired', null, { lane: batch.laneName, throughSerial: batch.throughSerial, retiredCount: batch.ops.length })
      return value
    })
    batch.actual = actual; batch.error = null; this.#retirementJobs.add(actual)
    // Publish ownership before the adapter can synchronously reenter. A failed
    // retirement has its own retry state; it never makes an owner uncertain.
    this.#trackControlWork(actual.then(() => {
      batch.actual = null; this.#retirementJobs.delete(actual); this.#retirements[batch.laneName] = null; this.#emit()
    }, error => {
      batch.actual = null; this.#retirementJobs.delete(actual); batch.error = fact(error)
      this.#remember('control-retirement-failed', null, { lane: batch.laneName, throughSerial: batch.throughSerial, error: batch.error }); this.#emit()
    }))
    return true
  }
  /** Bounded explicit pump. No timer, mutation retry or unseen command is
   * created. Settled never-transmitted heads are discarded locally; every
   * other blocked earliest record prevents skipping to a later prefix. */
  retryControlRetirements({ maxOperations = 16 } = {}) {
    need(Number.isSafeInteger(maxOperations) && maxOperations > 0 && maxOperations <= 64, 'finite control retirement scan budget is required')
    let inspected = 0, started = 0, locallyDiscarded = 0
    if (this.#retire) {
      const first = this.#retirementTurn, second = first === 'normal' ? 'cleanup' : 'normal'
      this.#retirementTurn = second
      for (const laneName of [first, second]) {
        if (inspected >= maxOperations) break
        const pending = this.#retirements[laneName]
        if (pending) {
          if (!pending.actual && pending.ops.length <= maxOperations - inspected) {
            inspected += pending.ops.length
            if (pending.ops.every(op => this.#canRetire(op))) started += Number(this.#startRetirement(pending))
          }
          continue
        }
        const lane = this.#commandLanes[laneName], ops = []
        let op = lane.head
        while (op && inspected < maxOperations && ops.length < 64) {
          inspected++
          if (ops.length === 0 && this.#canDiscardLocally(op)) {
            this.#discardLocalHead(laneName, op); locallyDiscarded++; op = lane.head; continue
          }
          if (op.retiring || !this.#canRetire(op)) break
          ops.push(op); op = op.next
        }
        if (ops.length) {
          const throughSerial = ops.at(-1).request.requestId.split('-').at(-1)
          const batch = { laneName, previousThrough: lane.through, throughSerial, ops,
            requests: Object.freeze(ops.map(op => op.request)), actual: null, error: null }
          for (const value of ops) value.retiring = true
          this.#retirements[laneName] = batch; started += Number(this.#startRetirement(batch))
        }
      }
    }
    if (locallyDiscarded > 0) this.#emit()
    return Object.freeze({ inspected, started, locallyDiscarded, controlRetirements: this.#retirementStatus(), transportDrained: this.#transportDrained() })
  }
  #applyControl(tx, command, payload, result) {
    const site = tx.offer?.site
    if (command === 'issueActivation') {
      need(record(result) && bindingMatches(result.binding, site, this.#lease) && u64(result.controlRevision), 'invalid final activation permit')
      tx.permit = copy(result)
    } else if (command === 'beginActivation') {
      need(record(result) && ['close', 'start'].includes(result.kind), 'invalid begin activation instruction')
      const value = result.instruction
      if (result.kind === 'start') { this.#startTicket(value, tx); tx.start = copy(value) }
      else { this.#closeTicket(value); need(value.replacesWithActivation === tx.permit.binding.activationId, 'close names a different replacement'); tx.closeTicket = copy(value) }
      tx.consumed = true
    } else if (command === 'finishClose') {
      need(result === null || record(result), 'invalid finish-close final')
      if (result !== null) { this.#startTicket(result, tx); need(payload.ticket.replacesWithActivation === result.binding.activationId, 'cleanup close cannot grant unrelated start'); tx.start = copy(result) }
      tx.closeTicket = null; tx.closeFinished = true
      if (payload.closeFinal.success === true) {
        const entry = tx.closingEntry
        need(entry && entry.closeReceipt && same(entry.key, payload.ticket.owner), 'close final lacks a verified exact local barrier')
        entry.serverClosed = true; entry.tx.registered = false
        if (this.#entry === entry) this.#entry = null
      }
    } else if (command === 'startOwner') {
      need(record(result) && same(result.binding, payload.ticket.binding) && keyValid(result.owner)
        && result.owner.clientOwnerId === payload.clientOwnerId && result.owner.activationId === result.binding.activationId, 'invalid final owner registration')
      need(tx.intent && !tx.intent.key, 'owner registration has no unique inert intent')
      need(this.#entry === null || this.#entry.serverClosed === true, 'server registration overlapped a retained local owner')
      tx.intent.key = copy(result.owner); tx.intent.binding = copy(result.binding); tx.registered = true; tx.start = null
      this.#entry = tx.intent
    } else if (command === 'failOwner') {
      this.#closeTicket(result); need(same(result.owner, payload.ownerKey) && result.replacesWithActivation === null, 'failure close names another owner'); tx.closeTicket = copy(result)
    } else if (command === 'stop') {
      need(result === null || record(result), 'invalid stop final'); if (result) { this.#closeTicket(result); tx.closeTicket = copy(result) }
    } else if (command === 'cancelActivation') { need(result === null, 'cancel must return unit'); tx.permit = null }
    else if (command === 'abandonStart') { need(result === null, 'abandon must return unit'); tx.start = null; tx.permit = null }
    else if (['runtimeReady', 'presentedReady'].includes(command)) need(result === null, 'receipt recording must return unit')
    else if (command === 'snapshot') need(same(result, this.#snapshot), 'snapshot final differs from its projection')
    else throw fail('ERR_PROTOCOL_VERSION', 'unsupported control operation')
  }
  #closeTicket(ticket) { need(record(ticket) && ticket.version === '1.0' && positive(ticket.closeRevision) && u64(ticket.terminalCleanupRevision) && same(ticket.preview, this.#lease)
    && keyValid(ticket.owner) && (ticket.replacesWithActivation === null || positive(ticket.replacesWithActivation)), 'invalid exact close ticket') }
  #startTicket(ticket, tx) { need(record(ticket) && positive(ticket.startRevision) && bindingMatches(ticket.binding, tx.offer.site, this.#lease)
    && (!tx.permit || same(ticket.binding, tx.permit.binding)), 'invalid exact start ticket') }
  async #call(tx, command, payload, { signal, cleanup = false } = {}) {
    const cleanupCommand = ['cancelActivation', 'finishClose', 'abandonStart', 'failOwner', 'retryClose', 'stop'].includes(command)
    need(cleanup === cleanupCommand, 'control command must use its fixed request namespace')
    need((cleanup ? this.#cleanupSerial : this.#requestSerial) < 18446744073709551615n && (cleanup
      ? this.#cleanupCommands < this.#limits.maxControlCommands * 4 + 32 : this.#normalCommands < this.#limits.maxControlCommands),
    'control retained request budget exhausted')
    if (cleanup) this.#cleanupCommands++; else this.#normalCommands++
    const serial = cleanup ? ++this.#cleanupSerial : ++this.#requestSerial
    const request = copy({ version: '1.0', requestId: `${this.#clientId}:${cleanup ? 'cleanup' : 'control'}-${serial}`, command, payload })
    const laneName = cleanup ? 'cleanup' : 'normal', lane = this.#commandLanes[laneName]
    const op = { tx, request, laneName, next: null, actual: 0, retiring: false, retired: false, locallyDiscarded: false, final: deferred(), transportFailure: deferred(), finalValue: null, transportError: null, invoked: false, neverInvoked: false }
    if (lane.tail) lane.tail.next = op; else lane.head = op
    lane.tail = op
    tx.op = op; this.#commands.set(request.requestId, op)
    const predecessor = this.#controlTail
    const raw = this.#commandJob(op, () => predecessor.then(() => {
      // A timed-out queued reservation never becomes a late mutation. This is
      // local non-invocation evidence, not an invented server final. Cleanup
      // still waits the predecessor's genuine final reconciliation.
      if (op.neverInvoked || signal?.aborted || !cleanup && (tx.done || this.#closed || this.#controlConflict
        || tx.snapshotRefresh && (this.#uncertain || this.#cleanupFailure)
        || tx.offer && !this.#current(tx) || tx.presentationEntry && !this.#active(tx.presentationEntry))) {
        op.neverInvoked = true; const error = cancelled(); op.final.reject(error); throw error
      }
      op.invoked = true; return this.#control.invoke(request, { signal })
    }).then(value => { this.#acceptFinal(op, value); return value }))
    this.#controlTail = predecessor.then(() => op.final.promise).then(() => {}, () => {})
    void this.#track(raw, tx, `control-raw:${command}`).catch(error => { op.transportError = error; op.transportFailure.reject(error) })
    let final
    try { final = await this.#wait(Promise.race([op.final.promise, op.transportFailure.promise]), tx, `control:${command}`, signal, cleanup) }
    catch (error) {
      if (!op.invoked) { op.neverInvoked = true; op.final.reject(error) }
      throw error
    }
    if (final.status === 'error') throw Object.assign(fail(final.error.code, final.error.message), { controlFinal: true, command, snapshot: final.snapshot })
    return final.result
  }
  async #recoverOperation(op) {
    if (this.#controlConflict) throw this.#controlConflict
    if (op?.finalConflict) throw op.finalConflict
    if (!op || op.finalValue || op.neverInvoked) return
    // Same immutable request, never a second command/new clientOwnerId. Replay
    // must retrieve a real final, not infer one from a partial snapshot.
    // Repeated bounded recoveries share one actual unsettled replay. Do not
    // add another tracked wait promise on each timeout; the immutable request
    // and its sole raw replay remain charged until actual settlement.
    if (!op.replayRaw || op.replaySettled) {
      op.replaySettled = false
      op.replayRaw = this.#track(this.#commandJob(op, () => Promise.resolve().then(() => this.#control.replay(op.request))
        .then(value => this.#acceptFinal(op, value))).finally(() => { op.replaySettled = true }), op.tx, `control-replay:${op.request.command}`)
    }
    const actual = op.replayRaw
    await Promise.resolve().then(() => this.#boundedAdapter(actual, Object.freeze({ phase: 'control-replay', identity: op.tx.identity,
      timeoutMs: this.#limits.closeTimeoutMs, signal: undefined })))
    need(op.replaySettled, 'deadline adapter fabricated replay completion before actual settlement')
    await actual
  }
  #newContext(identity) { return { identity, jobs: new Set(), done: false, op: null, permit: null, consumed: false, start: null, intent: null, registered: false, closeTicket: null, closeFinished: false, rendererPreparation: null, rendererPreparationClosed: false } }
  refreshSnapshot() {
    if (this.#closed) return Promise.reject(cancelled())
    if (this.#uncertain || this.#cleanupFailure || this.#controlConflict) return Promise.reject(uncertain())
    try { need(this.#offers.size < this.#limits.maxPendingOffers, 'snapshot refresh pending budget exhausted') }
    catch (error) { return Promise.reject(error) }
    const tx = { ...this.#newContext(copy({ runId: this.#lease.runId, snapshotRefresh: true })), snapshotRefresh: true }
    // Use the same owner/control lanes and request serials as activation and
    // cleanup. A poll neither selects a new desired offer nor retires an owner.
    const task = this.#tail.then(async () => {
      if (this.#closed) throw cancelled()
      if (this.#uncertain || this.#cleanupFailure || this.#controlConflict) throw uncertain()
      try { return await this.#call(tx, 'snapshot', {}) }
      catch (error) {
        // A queued command proven never invoked needs no reconciliation. Any
        // actual failure retains its exact op for the existing recover path.
        if (tx.op && !tx.op.neverInvoked) this.#markUncertain(tx, tx.op, error)
        throw error
      }
    }).finally(() => { tx.done = true; this.#release(tx) })
    this.#tail = task.catch(() => {})
    return this.#track(task, tx, 'snapshot-refresh')
  }
  offer(value) {
    if (this.#closed) throw cancelled()
    if (this.#uncertain || this.#cleanupFailure || this.#controlConflict) throw uncertain()
    need(this.#offers.size < this.#limits.maxPendingOffers && this.#serial < 18446744073709551615n, 'offer lifetime/pending budget exhausted')
    const offer = offered(value, this.#base); need(offer.site.runId === this.#lease.runId, 'offer belongs to another run')
    const tx = { ...this.#newContext(copy({ runId: offer.site.runId, siteId: offer.site.siteId, tokenId: offer.site.tokenId, serial: String(++this.#serial) })),
      offer, abort: new AbortController(), ready: deferred(), presented: deferred(), runtime: null, options: null, cancelPromise: null }
    const previous = this.#desired; this.#desired = tx; this.#phase = 'preflight'
    if (previous) { void this.#releaseRenderer(previous).catch(() => {}); previous.abort.abort('newer offer'); previous.ready.reject(cancelled()); previous.presented.reject(cancelled());
      if (this.#entry?.tx === previous && !this.#entry.runtimeReady) void this.#closeLocal(this.#entry).catch(() => {}) }
    const task = Promise.resolve().then(async () => {
      this.#check(tx)
      const hash = await this.#wait(Promise.resolve().then(() => this.#hash(new TextEncoder().encode(offer.startupJson))), tx, 'startup-hash', tx.abort.signal)
      this.#check(tx); need(hash === offer.site.startup.sha256, 'actual startup bytes differ from coordinator pin')
      tx.options = startupOptions(offer.startupJson, offer.site, this.#root.ownerDocument.defaultView?.devicePixelRatio ?? 1)
      const key = offer.site.runtime.bundleSha256
      if (!this.#runtime.has(key)) {
        need(this.#runtime.size < this.#limits.maxRuntimeBundles, 'immutable runtime import budget exhausted; reopen preview')
        const raw = this.#track(Promise.resolve().then(() => this.#import({ baseUrl: offer.site.runtimeBaseUrl, runtimeId: key })).then(module => {
          need(typeof module?.createSession === 'function' && typeof module?.createLoader === 'function', 'missing real owner/loader exports')
          const loader = module.createLoader({ baseUrl: offer.site.runtimeBaseUrl })
          need(typeof loader?.admitWorkerPack === 'function' && typeof loader?.loadPinnedCanvasKit === 'function'
            && typeof loader?.preparePinnedRendererAssets === 'function', 'invalid two-phase admission loader interface')
          return { createSession: module.createSession, loader,
            ownerRenderScaleContract: module.ownerRenderScaleContract === undefined ? null : copy(module.ownerRenderScaleContract),
            renderScaleContract: module.renderScaleContract === undefined ? null : copy(module.renderScaleContract),
            inputTimingContract: module.inputTimingContract === undefined ? null : copy(module.inputTimingContract) }
        }), null, 'runtime-import')
        this.#runtime.set(key, raw)
      }
      tx.runtime = await this.#wait(this.#runtime.get(key), tx, 'runtime-cache', tx.abort.signal); this.#check(tx)
      if (tx.options.renderScale !== undefined) {
        need(same(tx.runtime.ownerRenderScaleContract, OWNER_SCALE_V1), 'pinned owner does not declare render scale contract 1.0')
        need(same(tx.runtime.renderScaleContract, WORKER_SCALE_V1), 'pinned Worker does not declare render scale contract 1.0')
      }
      if (this.#inputTiming) need(offer.site.transportBackend === 'external-frame' && same(tx.runtime.inputTimingContract, INPUT_TIMING_V1),
        'pinned producer does not declare Worker Skia causal input timing 1.0')
      const admission = await this.#wait(Promise.resolve().then(() => tx.runtime.loader.admitWorkerPack({ indexUrl: offer.site.indexUrl,
        indexSha256: offer.site.index.sha256, indexSize: Number(offer.site.index.size), route: tx.options.route,
        rendererPolicy: tx.options.rendererPolicy, signal: tx.abort.signal })), tx, 'preflight', tx.abort.signal)
      this.#check(tx)
      need(admission?.provenance?.indexSha256 === offer.site.index.sha256 && admission.provenance.manifestSha256 === offer.site.portable.manifestSha256
        && admission.provenance.integrityRoot === offer.site.portable.integrityRoot && admission.transportBackend === offer.site.transportBackend
        && same(admission.rendererPolicy, tx.options.rendererPolicy), 'real admission does not match coordinator pins')
      if (admission.transportBackend === 'external-frame') await this.#prepareRenderer(tx)
      this.#check(tx)
      const execution = this.#tail.then(() => this.#activate(tx)); this.#tail = execution.catch(() => {}); await execution
    }).catch(async error => {
      try { await this.#wait(this.#releaseRenderer(tx), tx, 'renderer-release-final', undefined, true) }
      catch (cleanup) { error = combined('offer and renderer cleanup failed', [error, cleanup]) }
      this.#failure(tx, 'offer', error)
    }).finally(() => { tx.done = true; this.#release(tx) })
    this.#track(task, tx, 'offer'); this.#emit()
    return Object.freeze({ identity: tx.identity, ready: tx.ready.promise, presented: tx.presented.promise,
      cancel: () => {
        if (!tx.cancelPromise) {
          const cancelledBarrier = deferred(); tx.cancelPromise = cancelledBarrier.promise
          void this.#releaseRenderer(tx).catch(() => {}); tx.abort.abort('explicit cancellation'); tx.ready.reject(cancelled()); tx.presented.reject(cancelled())
          if (this.#entry?.tx === tx) void this.#closeLocal(this.#entry).catch(() => {})
          const cancellation = this.#tail.then(() => this.#cleanup(tx)); this.#tail = cancellation.catch(() => {})
          const drained = cancellation.then(async () => { const outcomes = await this.#wait(Promise.allSettled([...tx.jobs]), tx, 'cancel-drain', undefined, true);
            const errors = outcomes.filter(value => value.status === 'rejected' && !['ERR_CANCELLED', 'ERR_RPC_CANCELLED'].includes(value.reason?.code)).map(value => value.reason);
            if (errors.length) throw combined('cancelled intent actual work failed', errors); return Object.freeze({ cancelled: true, identity: tx.identity }) })
          void drained.then(cancelledBarrier.resolve, cancelledBarrier.reject)
        }
        return tx.cancelPromise
      } })
  }
  async #prepareRenderer(tx) {
    this.#check(tx)
    need(tx.rendererPreparation === null && !tx.rendererPreparationClosed, 'renderer preparation is single-use per intent and cannot begin after release')
    const state = { actual: null, lease: null, release: null, releaseRequested: false }
    tx.rendererPreparation = state
    // Track the real provider lifecycle before any deadline/observer can leave.
    // Even a late value is adopted locally before current-intent validation.
    state.actual = this.#track(Promise.resolve().then(() => {
      this.#check(tx)
      return tx.runtime.loader.preparePinnedRendererAssets({ rendererAssets: tx.options.rendererAssets, signal: tx.abort.signal })
    }).then(lease => {
      state.lease = lease
      need(record(lease) && lease.version === '1.0' && lease.kind === 'static-renderer-assets'
        && lease.scope === 'drawing-resources-only' && typeof lease.disposed === 'boolean' && typeof lease.dispose === 'function'
        && lease.provenance?.staticFontDecoded === true && lease.provenance.gpuSurfaceValidated === false,
      'renderer preparation did not return an opaque initialized static-resource lease')
      return lease
    }), tx, 'renderer-prepare')
    await this.#wait(state.actual, tx, 'renderer-preflight', tx.abort.signal)
    this.#check(tx)
    need(!state.releaseRequested && state.lease && !state.lease.disposed, 'renderer preflight was released before activation')
    this.#remember('renderer-prepared', tx.identity, { scope: 'drawing-resources-only', gpuSurfaceValidated: false })
  }
  #releaseRenderer(tx) {
    if (tx) tx.rendererPreparationClosed = true
    const state = tx?.rendererPreparation
    if (!state) return Promise.resolve(Object.freeze({ released: true, prepared: false }))
    if (state.release) return state.release
    const barrier = deferred(); state.release = barrier.promise; state.releaseRequested = true
    // Publish the exact barrier before signal/dispose callbacks can reenter.
    this.#rendererReleases.add(state.release)
    const actual = this.#track(Promise.resolve().then(async () => {
      try { await state.actual } catch (error) {
        // No published lease after an ordinary verified preflight failure is
        // not failed cleanup. Explicit provider cleanup uncertainty is retained.
        if (error?.details?.cleanupErrors?.length) throw error
        if (!state.lease) return Object.freeze({ released: true, prepared: false })
      }
      need(state.lease && typeof state.lease.dispose === 'function', 'unreleasable renderer preparation cannot prove cleanup')
      await state.lease.dispose()
      return Object.freeze({ released: true, prepared: true })
    }), tx, 'renderer-release')
    void actual.then(value => { this.#rendererReleases.delete(state.release); barrier.resolve(value) }, error => {
      this.#cleanupFailure ??= error; this.#rendererReleases.delete(state.release)
      this.#remember('renderer-cleanup-failed', tx.identity, fact(error)); barrier.reject(error); this.#emit()
    })
    return state.release
  }
  async #borrowRenderer(tx, options) {
    this.#check(tx)
    const state = tx.rendererPreparation
    need(state && !state.releaseRequested && state.lease && !state.lease.disposed,
      'actual external owner needs its own live prepared renderer lease')
    // Forward actual owner/loadResult/signal unmodified; only add the opaque
    // same-loader preparation. No owner/load-result proof is manufactured.
    const borrowed = await this.#track(Promise.resolve().then(() => tx.runtime.loader.loadPinnedCanvasKit({
      ...options, preparedRendererAssets: state.lease })), tx, 'renderer-borrow')
    try { await this.#releaseRenderer(tx) }
    catch (error) {
      // The real owner has not received this value yet. Do not orphan a live
      // independent owner lease if static cleanup fails before transfer.
      try { need(borrowed && typeof borrowed.dispose === 'function', 'borrowed renderer cannot prove cleanup'); await borrowed.dispose() }
      catch (cleanup) { this.#cleanupFailure ??= cleanup; throw combined('static and untransferred owner cleanup failed', [error, cleanup]) }
      throw error
    }
    return borrowed
  }
  async #activate(tx) {
    try {
      // An older canceled resource job keeps its actual last-use barrier. DOM
      // activation also waits it; changing backend cannot bypass cleanup.
      await this.#wait(Promise.all([...this.#rendererReleases]), tx, 'renderer-prior-cleanup', tx.abort.signal, true)
      this.#check(tx)
      for (let attempt = 0; ; attempt++) {
        this.#check(tx); this.#phase = 'activating'; this.#emit(); this.#check(tx)
        await this.#call(tx, 'snapshot', {}, { signal: tx.abort.signal }); this.#check(tx)
        need(this.#snapshot.portableCurrent && !this.#snapshot.stopped && this.#snapshot.offeredSite
          && same(this.#snapshot.preview, this.#lease), 'offered source/site/lease is no longer current')
        const authoritativeSite = offered({ site: this.#snapshot.offeredSite, startupJson: tx.offer.startupJson }, this.#base).site
        need(same(authoritativeSite, tx.offer.site), 'startup/runtime/portable pins are not the full authoritative offered site')
        await this.#call(tx, 'issueActivation', { preview: this.#lease, siteId: tx.offer.site.siteId, expectedControlRevision: this.#snapshot.controlRevision }, { signal: tx.abort.signal }); this.#check(tx)
        try { await this.#call(tx, 'beginActivation', { permit: tx.permit }, { signal: tx.abort.signal }); break }
        catch (error) {
          if (!error.controlFinal || attempt >= this.#limits.maxPermitRetries || !this.#current(tx)) throw error
          const state = error.snapshot
          if (state.activationPhase !== 'granted' || state.activationId !== tx.permit.binding.activationId) throw error
          await this.#call(tx, 'cancelActivation', { preview: this.#lease, permit: tx.permit }, { cleanup: true })
        }
      }
      this.#check(tx)
      if (tx.closeTicket) await this.#finishExactClose(tx, tx.closeTicket)
      this.#check(tx); if (!tx.start) throw fail('ERR_CANCELLED', 'source advanced after old close; server returned no start ticket')
      const entry = { tx, serverClosed: false, identity: copy({ ...tx.identity, binding: tx.start.binding, preview: this.#lease }), binding: tx.start.binding,
        clientOwnerId: clientOwnerIdentity(this.#clientId),
        key: null, session: null, constructed: deferred(), constructAttempted: false, closeWait: null, closeReceipt: null,
        owner: null, state: null, submission: null, metricsCandidate: null, metricsBinding: null, runtimeReady: false, runtimeRecorded: false, presented: false, retired: false, fatal: null, presentationTask: null }
      tx.intent = entry
      // Inert intent exists before the mutating registration request. A lost
      // final can mean server registration succeeded; never allocate a new id.
      await this.#call(tx, 'startOwner', { ticket: tx.start, clientOwnerId: entry.clientOwnerId }, { signal: tx.abort.signal })
      need(entry.key !== null, 'server did not register the inert wrapper'); this.#entry = entry
      this.#check(tx); this.#phase = 'loading'; this.#emit(); this.#check(tx)
      entry.constructAttempted = true
      try {
        entry.session = tx.runtime.createSession({ surfaceRoot: this.#root, admitPack: tx.runtime.loader.admitWorkerPack,
          ...(this.#inputTiming ? { inputTiming: this.#inputTiming } : {}),
          loadRendererAssets: options => this.#borrowRenderer(tx, options),
          onState: value => this.#ownerState(entry, value), onError: error => this.#ownerFault(entry, error),
          onBatch: batch => this.#notify('onBatch', Object.freeze({ identity: entry.identity, ownerKey: entry.key, stale: !this.#active(entry), batch })),
          onDiagnostic: value => {
            for (const diagnostic of diagnosticFacts(value)) this.#notify('onDiagnostic', Object.freeze({
              identity: entry.identity, ownerKey: entry.key, stale: !this.#active(entry), ...diagnostic }))
          },
          onInput: value => { if (this.#active(entry) && !entry.fatal) this.#notify('onInput', Object.freeze({ identity: entry.identity, ownerKey: entry.key, value })) },
          onSurface: value => this.#ownerSurface(entry, value) })
        need(entry.session && typeof entry.session.load === 'function' && typeof entry.session.close === 'function', 'factory must transfer one synchronous real owner')
      } finally { entry.constructed.resolve(entry.session) }
      this.#check(tx); if (entry.retired || entry.fatal) throw entry.fatal ?? cancelled()
      const result = await this.#wait(Promise.resolve().then(() => { this.#check(tx); return entry.session.load({ ...tx.options,
        workerUrl: new URL('runtime-worker.mjs', tx.offer.site.runtimeBaseUrl).href, timeoutMs: this.#limits.timeoutMs, loadTimeoutMs: this.#limits.timeoutMs }) }), tx, 'owner-load', tx.abort.signal)
      this.#check(tx); if (entry.fatal) throw entry.fatal
      need(result?.runtimeReady === true && result.loadResult?.capabilities?.quickjs === true && result.owner?.packSha256 === tx.offer.site.index.sha256
        && result.owner.transportBackend === tx.offer.site.transportBackend && result.loadResult.manifest?.integrity?.root === tx.offer.site.portable.integrityRoot, 'load is not the actual matching QuickJS owner')
      entry.owner = copy(result.owner); this.#ownerState(entry, entry.session.status)
      this.#check(tx); if (entry.fatal) throw entry.fatal; need(entry.state.runtimeReady && sameWorker(entry.state.owner, entry.owner), 'actual owner status is not ready')
      need(['open', 'awaiting-presentation'].includes(entry.state.metricsFence?.phase) && u64(entry.state.metricsFence.revision)
        && same(entry.state.observation?.state.viewport, { x: 0, y: 0, width: tx.options.viewport.width, height: tx.options.viewport.height }),
      'load did not commit the exact pinned initial viewport/metrics transaction')
      // Explicit initial metrics can still await an accepted presentation after
      // load resolves. Retain a candidate mapping; only a later matching open
      // fence plus accepted proof promotes it. Runtime-ready is independent.
      entry.metricsCandidate = copy({ startupSha256: tx.offer.site.startup.sha256,
        startupMetricsRevision: tx.offer.site.startup.metricsRevision, ownerFenceRevision: entry.state.metricsFence.revision,
        viewport: entry.state.observation.state.viewport })
      entry.runtimeReady = true
      this.#remember('metrics-candidate', entry.identity, entry.metricsCandidate)
      const receipt = copy({ version: '1.0', evidenceOrigin: 'browser-reported', binding: entry.binding, ownerKey: entry.key, owner: entry.owner, engineProvider: 'quickjs-wasm' })
      await this.#call(tx, 'runtimeReady', receipt, { signal: tx.abort.signal }); this.#check(tx)
      if (entry.fatal || entry.retired) throw entry.fatal ?? cancelled()
      entry.runtimeRecorded = true; this.#phase = 'runtime-ready'; this.#maybePresent(entry); this.#emit()
      // A caller may immediately submit a replacement after awaiting ready.
      // Publish only after the exact control final and synchronous observers:
      // aborting a later intent must not cancel this owner's unfinished record.
      this.#check(tx)
      if (entry.fatal || entry.retired) throw entry.fatal ?? cancelled()
      this.#remember('runtime-ready', entry.identity, receipt)
      tx.ready.resolve(copy({ identity: entry.identity, ownerKey: entry.key, owner: entry.owner, runtimeReady: true }))
    } catch (error) {
      try { await this.#cleanup(tx) } catch (cleanup) { throw combined('activation and cleanup failed', [error, cleanup]) }
      throw error
    }
  }
  #active(entry) { return !this.#closed && !this.#controlConflict && this.#entry === entry && !entry.retired }
  #ownerFault(entry, error) {
    if (!this.#active(entry)) { this.#remember('late-error', entry.identity, fact(error)); return }
    entry.fatal ??= error; this.#failure(entry.tx, 'runtime', error)
    void this.#closeLocal(entry).catch(() => {})
    if (entry.tx.done && !entry.faultCleanup) {
      const cleanup = this.#tail.then(() => this.#cleanup(entry.tx)); this.#tail = cleanup.catch(() => {})
      entry.faultCleanup = cleanup; void cleanup.catch(error => this.#failure(entry.tx, 'fault-cleanup', error))
    }
  }
  #ownerState(entry, value) {
    if (!this.#active(entry)) { this.#remember('late-state', entry.identity, null); return }
    try {
      if (value?.fault) { this.#ownerFault(entry, value.fault); return }
      const state = stateValue(value)
      if (entry.owner) need(sameWorker(state.owner, entry.owner), 'owner status changed immutable Worker tuple')
      entry.state = state
      if (state.requiresRestart) { this.#ownerFault(entry, fail('ERR_UNSUPPORTED_CAPABILITY', 'runtime requires owner replacement')); return }
      this.#maybePresent(entry); this.#emit()
    } catch (error) { this.#ownerFault(entry, error) }
  }
  #ownerSurface(entry, value) {
    if (!this.#active(entry) || entry.fatal) return
    try {
      // DOM callbacks have no GPU submission and remain valid surface events.
      if (value?.submission !== undefined && value.submission !== null) {
        const next = surfaceSubmission(value), owner = entry.owner ?? entry.state?.owner
        if (next.owner.packSha256 !== entry.tx.offer.site.index.sha256
          || entry.tx.offer.site.transportBackend !== 'external-frame' || owner && !sameWorker(next.owner, owner)) return
        const observed = entry.state?.observation?.state, previous = entry.submission
        if (observed && (next.surfaceGeneration !== observed.surfaceGeneration || !same(next.viewport, observed.viewport))) return
        if (previous && (BigInt(next.surfaceGeneration) < BigInt(previous.surfaceGeneration)
          || next.surfaceGeneration === previous.surfaceGeneration && BigInt(next.attemptId) < BigInt(previous.attemptId))) return
        if (previous && next.surfaceGeneration === previous.surfaceGeneration && next.attemptId === previous.attemptId)
          need(same(next, previous), 'one CanvasKit attempt produced conflicting submission metadata')
        entry.submission = next
      }
      this.#notify('onSurface', Object.freeze({ identity: entry.identity, ownerKey: entry.key, value })); this.#emit()
    } catch (error) { this.#ownerFault(entry, error) }
  }
  #submissionStatus(entry) {
    const value = entry.submission
    if (!value || !this.#active(entry) || entry.fatal) return null
    const state = entry.state, proof = state?.presentation?.accepted?.proof, observed = state?.observation?.state
    const accepted = entry.runtimeReady && state?.runtimeReady && !state.surfaceRecovery && state.inputEnabled && state.presentation?.accepted?.inputEnabled
      && proof?.version === '1.0' && sameWorker(value.owner, entry.owner) && sameWorker(proof.owner, value.owner)
      && proof.attemptId === value.attemptId && proof.surfaceGeneration === value.surfaceGeneration
      && proof.publication?.kind === 'external-frame' && proof.publication.renderRevision === value.renderRevision
      && observed?.lifecycle === 'Active' && observed.surfaceGeneration === value.surfaceGeneration && proof.consumedInput?.pageId === observed.currentPage?.pageId
      && proof.consumedInput?.routePath === observed.currentPage?.path
      && proof.consumedInput?.templateRevision === observed.templateRevision && same(proof.consumedInput?.viewport, value.viewport)
      && same(observed.viewport, value.viewport) && state.metricsFence?.phase === 'open'
    return Object.freeze({ phase: accepted ? 'accepted' : 'submitted', value,
      proof: accepted ? copy({ version: proof.version, owner: proof.owner, attemptId: proof.attemptId,
        surfaceGeneration: proof.surfaceGeneration, consumedInput: { pageId: proof.consumedInput.pageId,
          routePath: proof.consumedInput.routePath, templateRevision: proof.consumedInput.templateRevision, viewport: value.viewport },
        publication: { kind: 'external-frame', renderRevision: proof.publication.renderRevision } }) : null })
  }
  #maybePresent(entry) {
    if (!this.#active(entry) || entry.fatal || !entry.runtimeRecorded || entry.presented || entry.presentationTask || !entry.state?.inputEnabled) return
    try {
      const proof = entry.state.presentation?.accepted?.proof, accepted = entry.state.presentation?.accepted, observed = entry.state.observation?.state
      need(accepted?.inputEnabled && proof?.version === '1.0' && sameWorker(proof.owner, entry.owner) && positive(proof.attemptId)
        && proof.surfaceGeneration === observed?.surfaceGeneration && proof.consumedInput?.pageId === observed.currentPage?.pageId
        && proof.consumedInput.routePath === observed.currentPage.path
        && same(proof.consumedInput.viewport, observed.viewport), 'presentation omitted the exact accepted current owner proof')
      need(u64(proof.consumedInput.templateRevision) && u64(observed.templateRevision), 'invalid template revision')
      // A real scheduler may retain an input-enabled old picture while a soft
      // template update is pending. Wait for the new accepted proof; this is
      // neither a runtime fault nor a fresh presentation receipt.
      if (BigInt(proof.consumedInput.templateRevision) < BigInt(observed.templateRevision)) return
      need(proof.consumedInput.templateRevision === observed.templateRevision, 'accepted proof is ahead of ordered runtime state')
      const metrics = entry.metricsBinding ?? entry.metricsCandidate
      if (!metrics || entry.state.metricsFence?.phase !== 'open' || entry.state.metricsFence.revision !== metrics.ownerFenceRevision
        || !same(observed.viewport, metrics.viewport)) return
      if (!entry.metricsBinding) { entry.metricsBinding = metrics; this.#remember('metrics-binding', entry.identity, metrics) }
      const pub = proof.publication
      let publication
      if (entry.owner.transportBackend === 'browser-view') {
        need(pub?.kind === 'browser-view' && pub.key?.sessionId === entry.owner.sessionId && pub.key.pageId === proof.consumedInput.pageId
          && pub.key.surfaceGeneration === proof.surfaceGeneration && positive(pub.key.presentationRevision) && positive(pub.key.documentRevision), 'invalid actual DOM publication')
        publication = { kind: 'browser-view', pageId: pub.key.pageId, revision: pub.key.presentationRevision }
      } else { need(pub?.kind === 'external-frame' && positive(pub.renderRevision), 'invalid actual external frame publication'); publication = { kind: 'external-frame', renderRevision: pub.renderRevision } }
      const receipt = copy({ version: '1.0', evidenceOrigin: 'browser-reported', binding: entry.binding, ownerKey: entry.key, owner: entry.owner,
        presentationRevision: proof.attemptId, surfaceGeneration: proof.surfaceGeneration, metricsRevision: metrics.startupMetricsRevision,
        pageId: proof.consumedInput.pageId, routePath: proof.consumedInput.routePath, templateRevision: proof.consumedInput.templateRevision,
        publication, inputEnabled: true, acceptedCurrent: true })
      this.#remember('accepted-proof', entry.identity, copy({ receipt, proof, metricsBinding: metrics, ownerMetricsFence: entry.state.metricsFence }))
      const reportTx = this.#newContext(entry.identity); reportTx.presentationEntry = entry
      entry.presentationTask = this.#call(reportTx, 'presentedReady', receipt).then(() => {
        if (!this.#active(entry) || entry.fatal) { this.#remember('late-presented-final', entry.identity, receipt); return }
        entry.presented = true; entry.tx.presented.resolve(copy({ identity: entry.identity, ownerKey: entry.key, receipt })); if (this.#current(entry.tx)) this.#phase = 'presented'; this.#emit()
      }).catch(error => { this.#markUncertain(reportTx, reportTx.op, error); entry.tx.presented.reject(error) }).finally(() => { reportTx.done = true; this.#release(reportTx) })
      void entry.presentationTask.catch(() => {})
    } catch (error) { this.#ownerFault(entry, error) }
  }
  #closeLocal(entry) {
    if (entry.closeWait) return entry.closeWait
    const barrier = deferred(); entry.closeWait = barrier.promise; entry.retired = true
    // If registration was cancelled before construction, prove no constructor
    // was attempted. During a factory callback, wait its exact transfer barrier.
    if (!entry.constructAttempted) entry.constructed.resolve(null)
    // Gate the actual live owner's direct DOM/input path before any manager
    // observer runs. Its real close() publishes phase=closing synchronously.
    let startedClose = null
    if (entry.session) {
      try { startedClose = Promise.resolve(entry.session.close()) } catch (error) { startedClose = Promise.reject(error) }
      void startedClose.catch(() => {})
    }
    const raw = Promise.resolve().then(async () => {
      const session = await entry.constructed.promise
      if (!session) { need(!entry.constructAttempted, 'constructor threw without transferring an owner; cleanup cannot be proven'); return copy({ outcome: 'never-constructed', workerClosed: true, ownedMountRemoved: true }) }
      const result = copy(await (startedClose ?? session.close()))
      need(record(result) && Object.keys(result).length === 7 && result.version === '1.0'
        && result.closed === true && result.workerClosed === true && result.ownedMountRemoved === true
        && Object.hasOwn(result, 'owner') && Object.hasOwn(result, 'rpcIdentity') && Object.hasOwn(result, 'workerFinal'),
      'actual close omitted versioned Worker/mount cleanup receipt')
      need(result.rpcIdentity === null ? result.owner === null && result.workerFinal === null
        : rpcIdentityValid(result.rpcIdentity) && record(result.workerFinal) && result.workerFinal.closed === true,
      'actual close omitted its exact RPC teardown identity/final')
      if (result.owner !== null) {
        need(workerOwnerValid(result.owner) && result.owner.workerEpoch === result.rpcIdentity?.workerEpoch
          && result.owner.sessionId === result.rpcIdentity?.sessionId
          && result.owner.packSha256 === entry.tx.offer.site.index.sha256
          && result.owner.transportBackend === entry.tx.offer.site.transportBackend,
        'actual close Worker tuple differs from RPC or admitted site')
      }
      // A cancelled load may have admitted the pack before its public ready
      // result. Correlate every locally known tuple without inventing a ready
      // receipt or treating a null tuple as absence of a constructed session.
      for (const owner of [entry.owner, entry.state?.owner, session.owner]) {
        if (owner !== null && owner !== undefined) need(sameWorker(result.owner, owner), 'actual close changed or omitted the known Worker tuple')
      }
      return copy({ outcome: 'closed', receipt: result })
    })
    void this.#wait(raw, entry.tx, 'owner-close', undefined, true).then(value => { entry.closeReceipt = value; barrier.resolve(value) }, error => {
      this.#cleanupFailure ??= error; this.#remember('cleanup-failed', entry.identity, fact(error)); this.#emit(); barrier.reject(error)
    })
    this.#remember('owner-closing', entry.identity, { ownerKey: entry.key }); this.#emit(); return entry.closeWait
  }
  async #finishExactClose(tx, ticket) {
    this.#closeTicket(ticket)
    const entry = tx.intent && same(tx.intent.key, ticket.owner) ? tx.intent : this.#entry
    need(entry && same(entry.key, ticket.owner) && same(entry.binding.preview, ticket.preview), 'exact server owner has no matching local wrapper')
    tx.closingEntry = entry
    let closeFinal
    try { closeFinal = await this.#closeLocal(entry) }
    catch (error) {
      await this.#call(tx, 'finishClose', { ticket, closeFinal: { evidenceOrigin: 'browser-reported', success: false,
        pendingActual: [...this.#jobs.values()].some(value => value.phase === 'owner-close'), error: fact(error) } }, { cleanup: true })
      throw error
    }
    await this.#call(tx, 'finishClose', { ticket, closeFinal: { evidenceOrigin: 'browser-reported', success: true, pendingActual: false,
      ownerKey: entry.key, ...closeFinal } }, { cleanup: true })
    if (this.#entry === entry) this.#entry = null
    if (entry.tx !== tx) entry.tx.registered = false
    if (tx.intent === entry) tx.registered = false
    this.#remember('owner-closed', entry.identity, closeFinal); this.#emit()
  }
  async #cleanup(tx) {
    const rendererRelease = this.#releaseRenderer(tx)
    try {
      if (tx.op && !tx.op.finalValue) await this.#recoverOperation(tx.op)
      if (tx.registered && tx.intent?.key) {
        if (!tx.closeTicket) await this.#call(tx, 'failOwner', { ownerKey: tx.intent.key, message: 'cancelled or failed browser startup/owner' }, { cleanup: true })
        await this.#finishExactClose(tx, tx.closeTicket)
      } else if (tx.closeTicket) await this.#finishExactClose(tx, tx.closeTicket)
      // Source/config invalidation may already have revoked unused authority.
      // A final snapshot with another/no activation is evidence of revocation,
      // not permission to cancel a different newer activation.
      const activationId = tx.start?.binding.activationId ?? tx.permit?.binding.activationId
      if (activationId && this.#snapshot?.activationId !== activationId) { tx.start = null; tx.permit = null }
      if (tx.start) await this.#call(tx, 'abandonStart', { ticket: tx.start }, { cleanup: true })
      else if (tx.permit && !tx.consumed) await this.#call(tx, 'cancelActivation', { preview: this.#lease, permit: tx.permit }, { cleanup: true })
      await this.#wait(rendererRelease, tx, 'renderer-release-cleanup', undefined, true)
      if (this.#controlConflict) throw this.#controlConflict
      if (this.#uncertain?.tx === tx) this.#uncertain = null
    } catch (error) { this.#markUncertain(tx, tx.op, error); throw error }
  }
  recover() {
    if (this.#recoverPromise) return this.#recoverPromise
    if (!this.#uncertain) return Promise.resolve(Object.freeze({ controlReconciled: true, cleanupVerified: !this.#cleanupFailure, pendingOperations: this.#jobs.size, finalAcknowledgements: this.#ackStatus(), controlRetirements: this.#retirementStatus(), transportDrained: this.#transportDrained() }))
    const pending = this.#uncertain
    const task = this.#tail.then(async () => { await this.#recoverOperation(pending.op); await this.#cleanup(pending.tx);
      return Object.freeze({ controlReconciled: !this.#uncertain, cleanupVerified: !this.#cleanupFailure, pendingOperations: this.#jobs.size, finalAcknowledgements: this.#ackStatus(), controlRetirements: this.#retirementStatus(), transportDrained: this.#transportDrained() }) })
    this.#tail = task.catch(() => {}); this.#recoverPromise = task.finally(() => { this.#recoverPromise = null }); void this.#recoverPromise.catch(() => {})
    return this.#recoverPromise
  }
  inputTimingReport({ ownerKey } = {}) {
    const entry = this.#entry
    if (!entry || !same(entry.key, ownerKey)) throw cancelled()
    const report = { version: '1.0', identity: entry.identity, ownerKey: entry.key, stale: !this.#active(entry),
      report: entry.session?.inputTiming ?? null }
    measureWorkerPayload(report, { maxBytes: 8 * 1024 * 1024 })
    return freeze(structuredClone(report))
  }
  request({ ownerKey, op, payload }, options = {}) {
    const entry = this.#entry
    if (!entry || !this.#active(entry) || entry.fatal || !entry.runtimeReady || !same(entry.key, ownerKey)) return Promise.reject(cancelled())
    return entry.session.request(op, payload, options).then(result => Object.freeze({ identity: entry.identity, ownerKey: entry.key, stale: !this.#active(entry), result }))
  }
  retrySurfaceRecovery({ ownerKey, lossId } = {}) {
    const entry = this.#entry
    const current = () => entry && this.#active(entry) && !entry.fatal && entry.runtimeReady
      && same(entry.key, ownerKey) && entry.state?.surfaceRecovery?.lossId === lossId
    if (!positive(lossId) || !current()) return Promise.reject(cancelled())
    if (entry.surfaceRetry?.lossId === lossId) return entry.surfaceRetry.promise
    if (entry.state.surfaceRecovery.phase !== 'blocked') return Promise.reject(cancelled())
    const task = this.#track(Promise.resolve().then(() => {
      if (!current() || entry.state.surfaceRecovery.phase !== 'blocked') throw cancelled()
      need(typeof entry.session.retrySurfaceRecovery === 'function', 'owner does not expose surface recovery')
      return entry.session.retrySurfaceRecovery()
    }), entry.tx, 'surface-recovery-retry').then(result => Object.freeze({ identity: entry.identity,
      ownerKey: entry.key, lossId, stale: !this.#active(entry), result }))
    const pending = { lossId, promise: task }; entry.surfaceRetry = pending
    void task.finally(() => { if (entry.surfaceRetry === pending) entry.surfaceRetry = null }).catch(() => {})
    return task
  }
  close() {
    if (this.#closePromise) return this.#closePromise
    const barrier = deferred(); this.#closePromise = barrier.promise; this.#closed = true; this.#phase = 'closing'
    for (const tx of this.#offers) void this.#releaseRenderer(tx).catch(() => {})
    this.#desired?.abort.abort('manager disposed'); this.#desired?.ready.reject(cancelled()); this.#desired?.presented.reject(cancelled())
    if (this.#entry) void this.#closeLocal(this.#entry).catch(() => {})
    const task = this.#tail.then(async () => {
      if (this.#uncertain) { const pending = this.#uncertain; await this.#recoverOperation(pending.op); await this.#cleanup(pending.tx) }
      const tx = this.#newContext(copy({ runId: this.#lease.runId, disposal: true }))
      try {
        await this.#call(tx, 'stop', {}, { cleanup: true })
        if (tx.closeTicket) await this.#finishExactClose(tx, tx.closeTicket)
        const outcomes = await this.#wait(Promise.allSettled([...this.#jobs.keys()]), null, 'manager-drain', undefined, true)
        const errors = outcomes.filter(value => value.status === 'rejected' && !['ERR_CANCELLED', 'ERR_RPC_CANCELLED'].includes(value.reason?.code)).map(value => value.reason)
        if (this.#cleanupFailure) errors.push(this.#cleanupFailure)
        if (errors.length) throw combined('actual outstanding cleanup failed', errors)
        need(this.#entry === null && this.#snapshot?.stopped === true && this.#snapshot.ownerKey === null, 'stop did not prove empty local/server slots')
        this.#phase = 'closed'; this.#emit(); return Object.freeze({ closed: true, workerClosed: true, coordinatorStopped: true,
          finalAcknowledgements: this.#ackStatus(), controlRetirements: this.#retirementStatus(), transportDrained: this.#transportDrained() })
      } catch (error) { this.#markUncertain(tx, tx.op, error); throw error }
      finally { tx.done = true; this.#release(tx) }
    })
    this.#tail = task.catch(() => {}); void task.then(barrier.resolve, error => { this.#phase = 'cleanup-failed'; this.#emit(); barrier.reject(error) })
    return this.#closePromise
  }
}
