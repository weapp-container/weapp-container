import { BrowserDevOwnerManager } from './browser-dev-owner-manager.mjs'

// Trusted local bootstrap supplies these identities. This module never elects
// a preview, invents an offer, or treats an HTTP receipt as a presented frame.
const roots = new WeakMap(), encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
const fault = (code, message) => Object.assign(new Error(message), { code })
const need = (value, message) => { if (!value) throw fault('ERR_PROTOCOL_VERSION', message) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value, limit) => typeof value === 'string' && value.length <= limit && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const u64 = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
const same = (a, b) => a === b || Boolean(a && b && typeof a === 'object' && typeof b === 'object'
  && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key])))
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
const copy = value => freeze(structuredClone(value))
// A server may restage identical bytes under fresh site/token/descriptor URLs
// after closing a failed owner. Those identities grant authority, not a new
// source intent. Keep every semantic producer/startup pin in the retry fence.
const startupIntent = site => copy({ version: site.version, runId: site.runId, portable: site.portable,
  runtime: site.runtime, startup: site.startup, index: site.index, transportBackend: site.transportBackend })
const info = error => Object.freeze({ code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'ERR_ENGINE',
  message: typeof error?.message === 'string' ? error.message.slice(0, 2048) : 'Browser development operation failed' })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {}); return { promise, resolve, reject } }

/** Timeout bounds a wait, never fabricates completion of its underlying job. */
export function browserDevWait(actual, { timeoutMs, signal } = {}) {
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'finite development wait deadline is required')
  const gate = deferred(), abort = () => gate.reject(fault('ERR_CANCELLED', 'development wait cancelled'))
  const timer = setTimeout(() => gate.reject(fault('ERR_TIMEOUT', 'development wait deadline exceeded')), timeoutMs)
  try { if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }) }
  catch (error) { clearTimeout(timer); throw error }
  return Promise.race([actual, gate.promise]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort) })
}

function bootstrapValue(value) {
  const result = copy(value)
  need(record(result) && ['baseUrl,clientId,preview,runId,version', 'baseUrl,clientId,preview,retirementVersion,runId,version'].includes(Object.keys(result).sort().join(','))
    && (result.retirementVersion === undefined || result.retirementVersion === '1.0')
    && result.version === '1.0' && id(result.runId, 128) && id(result.clientId, 64), 'explicit trusted development bootstrap is required')
  const base = new URL(result.baseUrl)
  need(['http:', 'https:'].includes(base.protocol) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash
    && (!globalThis.location || globalThis.location.origin === base.origin), 'development bootstrap must use the current root origin')
  const lease = result.preview
  need(record(lease) && Object.keys(lease).sort().join(',') === 'leaseRevision,previewId,runId,version'
    && lease.version === '1.0' && lease.runId === result.runId && id(lease.previewId, 128)
    && u64(lease.leaseRevision) && lease.leaseRevision !== '0', 'bootstrap must retain the original elected preview lease')
  return copy({ ...result, baseUrl: base.href })
}

async function startupText(fetcher, url, signal) {
  const response = await fetcher(url, { method: 'GET', signal, redirect: 'error', mode: 'same-origin', credentials: 'same-origin',
    cache: 'no-store', referrerPolicy: 'no-referrer' })
  let reader, complete = false
  try {
    need(response?.url === url && response.redirected === false && response.status === 200
      && !['opaque', 'opaqueredirect'].includes(response.type)
      && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''), 'immutable startup response was unavailable or redirected')
    const length = response.headers.get('content-length')
    need(length === null || /^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= 64 * 1024, 'startup response length exceeds its bound')
    need(typeof response.body?.getReader === 'function', 'startup response requires a bounded stream')
    reader = response.body.getReader()
    const bytes = new Uint8Array(64 * 1024); let used = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      need(part.value instanceof Uint8Array && part.value.length <= bytes.length - used, 'startup bytes exceed their bound')
      bytes.set(part.value, used); used += part.value.length
    }
    need(length === null || Number(length) === used, 'startup Content-Length differs from original bytes')
    const text = decoder.decode(bytes.subarray(0, used))
    // A BOM would be stripped by TextDecoder and change the pinned startup.
    need(encoder.encode(text).length === used, 'startup is not exact normalized UTF-8')
    complete = true; return text
  } finally {
    if (reader) { try { if (!complete) await reader.cancel() } finally { reader.releaseLock() } }
    else if (response?.body && !response.body.locked) await response.body.cancel()
  }
}

/** Product glue over the existing owner manager and authenticated transport.
 * Only observe polls automatically. Mutations, replay and final ACK remain
 * owned by the same manager. No Worker is constructed until its exact start
 * final has been adopted. The borrowed root is retained after uncertain close.
 */
export class BrowserDevApplication {
  #bootstrap; #root; #control; #manager; #fetch; #sinks; #interval; #timer = null; #running = false
  #refresh = null; #abort = null; #closing = null; #closed = false; #offered = null; #observation = null; #lastError = null
  #ownerClose = null; #ownerClosed = null; #refreshAtClose = null; #cleanupActive = null
  #cleanupFailed = false
  #failedIntent = null
  #surfaceRetry = null
  constructor({ bootstrap, surfaceRoot, control, fetch: fetcher = globalThis.fetch?.bind(globalThis), intervalMs = 1000,
    runBounded = browserDevWait, createManager = options => new BrowserDevOwnerManager(options), onState, onDiagnostic, onBatch, onInput, onSurface, inputTiming } = {}) {
    this.#bootstrap = bootstrapValue(bootstrap)
    need(surfaceRoot && typeof surfaceRoot === 'object' && typeof surfaceRoot.append === 'function'
      && typeof surfaceRoot.ownerDocument?.createElement === 'function', 'borrow one development surface root')
    need(!roots.has(surfaceRoot), 'development surface already has a retained application owner')
    need(control && ['observe', 'invoke', 'replay', 'acknowledge', 'drain', 'close'].every(key => typeof control[key] === 'function'), 'the original authenticated HTTP control transport is required')
    need(control.capabilities?.retirementVersion === this.#bootstrap.retirementVersion, 'control retirement must match the trusted bootstrap capability')
    need([fetcher, runBounded, createManager].every(value => typeof value === 'function') && Number.isSafeInteger(intervalMs)
      && intervalMs >= 100 && intervalMs <= 60_000, 'finite development polling interval and adapters are required')
    need([onState, onDiagnostic, onBatch, onInput, onSurface].every(value => value === undefined || typeof value === 'function'), 'development observers must be functions')
    this.#root = surfaceRoot; this.#control = control; this.#fetch = fetcher; this.#interval = intervalMs
    this.#sinks = { onState, onDiagnostic, onBatch, onInput, onSurface }
    roots.set(surfaceRoot, this)
    try {
      this.#manager = createManager({ surfaceRoot, baseUrl: this.#bootstrap.baseUrl, preview: this.#bootstrap.preview,
        ...(inputTiming === undefined ? {} : { inputTiming }),
        clientId: this.#bootstrap.clientId, control, runBounded, onState: () => this.#emit(),
        onError: value => {
          if (this.#offered && ['runId', 'siteId', 'tokenId'].every(key => value?.identity?.[key] === this.#offered.identity[key])) {
            this.#failedIntent = this.#offered.intent
          }
          this.#problem('owner', value?.error ?? value)
        },
        onDiagnostic: value => this.#notify('onDiagnostic', value), onBatch: value => this.#notify('onBatch', value),
        onInput: value => this.#notify('onInput', value), onSurface: value => this.#notify('onSurface', value) })
      need(this.#manager && ['offer', 'close', 'request', 'retryFinalAcknowledgements'].every(key => typeof this.#manager[key] === 'function'), 'the original browser owner manager is required')
      need(!this.#bootstrap.retirementVersion || ['retryControlRetirements', 'drainControlWork'].every(key => typeof this.#manager[key] === 'function'), 'negotiated retirement requires the original manager retirement barrier')
    } catch (error) { roots.delete(surfaceRoot); throw error }
  }
  get status() {
    return Object.freeze({ phase: this.#closed ? 'closed' : this.#cleanupFailed ? 'cleanup-failed' : this.#closing ? 'closing' : this.#running ? 'watching' : 'idle',
      runId: this.#bootstrap.runId, clientId: this.#bootstrap.clientId, preview: this.#bootstrap.preview,
      observing: this.#refresh !== null, observation: this.#observation, offered: this.#offered?.identity ?? null,
      startupRetryRequired: this.#failedIntent !== null,
      cleanupRetryable: this.#cleanupFailed && this.#ownerClosed !== null,
      surfaceRetryPending: this.#surfaceRetry !== null,
      lastError: this.#lastError, manager: this.#manager?.status ?? null, transport: this.#control.status })
  }
  #notify(name, value) {
    try { const result = this.#sinks[name]?.(value); if (result?.then) void Promise.resolve(result).catch(() => {}) } catch { /* UI observers cannot authorize or strand an owner. */ }
  }
  #emit() { this.#notify('onState', this.status) }
  #maintainControl() {
    if (this.#closing || !this.#bootstrap.retirementVersion) return
    // Bounded admission only. The original manager and HTTP transport retain
    // actual work and failed transactions; observation never invents an ACK.
    this.#manager.retryFinalAcknowledgements({ maxOperations: 64 })
    if (!this.#closing) this.#manager.retryControlRetirements({ maxOperations: 64 })
  }
  #problem(phase, error) { this.#lastError = Object.freeze({ phase, ...info(error) }); this.#notify('onDiagnostic', this.#lastError); this.#emit() }
  #acceptObservation(observation) {
    // The manager can learn newer authority while an observation or immutable
    // startup GET is in flight. Its genuine control finals are a high-water
    // mark too; polling history alone cannot fence a late older offer.
    for (const known of [this.#observation, this.#manager.status?.snapshot]) {
      if (!known) continue
      need(known.version === '1.0' && known.runId === this.#bootstrap.runId
        && u64(known.controlRevision) && u64(known.terminalCleanupRevision), 'manager retained invalid coordinator authority')
      const order = BigInt(observation.controlRevision) - BigInt(known.controlRevision)
        || BigInt(observation.terminalCleanupRevision) - BigInt(known.terminalCleanupRevision)
      if (order < 0n) return false
      if (order === 0n) need(same(known, observation), 'same coordinator revision pair has conflicting observations')
    }
    return true
  }
  #schedule() {
    if (!this.#running || this.#closing || this.#timer !== null) return
    this.#timer = setTimeout(() => { this.#timer = null; void this.refresh().catch(() => {}).finally(() => this.#schedule()) }, this.#interval)
  }
  start() {
    if (this.#closing) return Promise.reject(fault('ERR_CANCELLED', 'development application is closing'))
    this.#running = true
    const actual = this.refresh(); void actual.finally(() => this.#schedule()).catch(() => {}); return actual
  }
  refresh() {
    if (this.#closing) return Promise.reject(fault('ERR_CANCELLED', 'development application is closing'))
    if (this.#refresh) return this.#refresh
    const gate = deferred(); this.#refresh = gate.promise; this.#abort = new AbortController()
    const signal = this.#abort.signal
    const actual = Promise.resolve().then(async () => {
      if (this.#closing) throw fault('ERR_CANCELLED', 'development application is closing')
      this.#maintainControl()
      if (this.#closing) throw fault('ERR_CANCELLED', 'development application is closing')
      const observation = await this.#control.observe({ signal })
      if (this.#closing) throw fault('ERR_CANCELLED', 'development application is closing')
      need(observation?.version === '1.0' && observation.runId === this.#bootstrap.runId && u64(observation.controlRevision)
        && u64(observation.terminalCleanupRevision) && typeof observation.stopped === 'boolean'
        && typeof observation.portableCurrent === 'boolean'
        && (same(observation.preview, this.#bootstrap.preview) || observation.stopped && observation.preview === null), 'observation differs from the elected bootstrap run/preview')
      const previous = this.#observation
      if (!this.#acceptObservation(observation)) return Object.freeze({ ignored: 'late-observation' })
      this.#observation = copy(observation)
      for (const key of ['sourceDiagnostic', 'siteDiagnostic', 'ownerDiagnostic']) {
        if (observation[key] && !same(previous?.[key], observation[key])) this.#problem(key, observation[key])
      }
      const site = observation.offeredSite
      if (observation.stopped) {
        // Close gates input synchronously. Do not await it from this refresh:
        // the same cleanup barrier must wait for this actual refresh to settle.
        void this.close().catch(() => {})
        return Object.freeze({ offered: false, stopped: true })
      }
      if (!observation.portableCurrent || !site) { this.#emit(); return Object.freeze({ offered: false }) }
      need(site.runId === this.#bootstrap.runId && u64(site.siteId) && site.siteId !== '0'
        && typeof site.tokenId === 'string' && /^[a-f0-9]{64}$/.test(site.tokenId), 'observation has no exact immutable site identity')
      const identity = copy({ runId: site.runId, siteId: site.siteId, tokenId: site.tokenId })
      const intent = startupIntent(site)
      if (same(this.#failedIntent, intent)) {
        this.#emit(); return Object.freeze({ offered: false, unchanged: true, retryRequired: true })
      }
      if (same(this.#offered?.identity, identity)) { this.#emit(); return Object.freeze({ offered: false, unchanged: true }) }
      const startupUrl = new URL(`/__weapp/pack/${site.runId}/${site.siteId}/worker-product-config.json`, this.#bootstrap.baseUrl).href
      const startupJson = await startupText(this.#fetch, startupUrl, signal)
      if (this.#closing) throw fault('ERR_CANCELLED', 'development application is closing')
      if (!this.#acceptObservation(observation)) return Object.freeze({ ignored: 'late-observation' })
      // The current owner can fail while this immutable GET is in flight.
      // Recheck the semantic fence before giving a restaged site to manager.
      if (same(this.#failedIntent, intent)) {
        this.#emit(); return Object.freeze({ offered: false, unchanged: true, retryRequired: true })
      }
      // The manager re-hashes exact startup bytes, re-admits the real pack and
      // fetches a new authoritative snapshot before any activation mutation.
      const handle = this.#manager.offer({ site, startupJson })
      const offered = { identity, intent, handle }
      this.#offered = offered; this.#failedIntent = null; this.#lastError = null
      for (const [phase, promise] of [['runtime', handle.ready], ['presentation', handle.presented]]) {
        void Promise.resolve(promise).then(() => { if (this.#offered?.handle === handle && !this.#closing) this.#emit() }, error => {
          if (this.#offered === offered && !this.#closing) {
            this.#failedIntent = intent; this.#problem(phase, error)
          }
        })
      }
      this.#emit(); return Object.freeze({ offered: true, identity })
    })
    void actual.then(value => { this.#refresh = null; this.#abort = null; gate.resolve(value) }, error => {
      this.#refresh = null; this.#abort = null
      if (!this.#closing) this.#problem('observe', error)
      gate.reject(error)
    })
    return gate.promise
  }
  async retryStartup() {
    if (this.#closing) throw fault('ERR_CANCELLED', 'development application is closing')
    // An explicit retry still observes the latest real site and follows the
    // original manager's close/admission path. It creates no synthetic offer.
    if (this.#refresh) await this.#refresh.catch(() => {})
    if (this.#closing) throw fault('ERR_CANCELLED', 'development application is closing')
    if (!this.#failedIntent) return Object.freeze({ offered: false, unchanged: true })
    if (same(this.#offered?.intent, this.#failedIntent)) this.#offered = null
    this.#failedIntent = null
    return this.refresh()
  }
  inputTimingReport(value) {
    need(!this.#closing && typeof this.#manager.inputTimingReport === 'function', 'input timing report is unavailable')
    return this.#manager.inputTimingReport(value)
  }
  request(value, options) {
    if (this.#closing) return Promise.reject(fault('ERR_CANCELLED', 'development application is closing'))
    return this.#manager.request(value, options)
  }
  retrySurfaceRecovery(value) {
    if (this.#closing) return Promise.reject(fault('ERR_CANCELLED', 'development application is closing'))
    if (this.#surfaceRetry) return same(this.#surfaceRetry.value, value) ? this.#surfaceRetry.promise
      : Promise.reject(fault('ERR_CANCELLED', 'another surface recovery retry is pending'))
    if (typeof this.#manager.retrySurfaceRecovery !== 'function') return Promise.reject(fault('ERR_UNSUPPORTED_CAPABILITY', 'owner does not expose surface recovery'))
    const intent = copy(value)
    const task = Promise.resolve().then(() => {
      if (this.#closing) throw fault('ERR_CANCELLED', 'development application is closing')
      return this.#manager.retrySurfaceRecovery(intent)
    })
    const pending = { value: intent, promise: task }; this.#surfaceRetry = pending; this.#emit()
    void task.then(() => {
      if (this.#surfaceRetry === pending) this.#surfaceRetry = null
      if (!this.#closing) this.#emit()
    }, error => {
      if (this.#surfaceRetry === pending) this.#surfaceRetry = null
      if (!this.#closing) this.#problem('surface-recovery', error)
    })
    return task
  }
  async #drainAcknowledgements() {
    // A cursor may start halfway through the original command map. At most
    // two complete sweeps cover that suffix and one full retry, with a hard
    // inspection bound even if a faulty adapter never reports end-of-map.
    let inspected = 0, sweeps = 0, idle = 0
    do {
      const budget = Math.min(64, 32768 - inspected)
      const batch = this.#manager.retryFinalAcknowledgements({ maxOperations: budget })
      need(record(batch) && Number.isSafeInteger(batch.inspected) && batch.inspected >= 0 && batch.inspected <= budget
        && Number.isSafeInteger(batch.started) && batch.started >= 0 && batch.started <= batch.inspected
        && typeof batch.reachedEnd === 'boolean', 'manager returned an invalid bounded acknowledgement sweep')
      inspected += batch.inspected; if (batch.reachedEnd) sweeps++
      // A manager-reserved ACK may not have started HTTP work yet. Its own
      // barrier includes delivery and adoption; then drain transport resources.
      // Legacy injected managers retain their previous non-retirement contract.
      await this.#manager.drainControlWork?.()
      await this.#control.drain()
      const acknowledgements = this.#manager.status.finalAcknowledgements
      need(Number.isSafeInteger(acknowledgements?.pending) && acknowledgements.pending >= 0, 'manager omitted actual acknowledgement status')
      if (acknowledgements.pending === 0) return
      idle = batch.inspected === 0 && !batch.reachedEnd ? idle + 1 : 0
      if (idle >= 2) break
    } while (sweeps < 2 && inspected < 32768)
    throw fault('ERR_RENDER', 'final acknowledgements remain unresolved; retain the original control transport and retry cleanup')
  }
  #cleanup() {
    if (this.#cleanupActive) return this.#cleanupActive
    const gate = deferred(); this.#cleanupActive = gate.promise
    const actual = Promise.resolve().then(async () => {
      const owner = await this.#ownerClose
      need(owner?.closed === true && owner.workerClosed === true && owner.coordinatorStopped === true, 'manager did not finish the original Worker/coordinator close')
      this.#ownerClosed = owner
      await Promise.allSettled(this.#refreshAtClose ? [this.#refreshAtClose] : [])
      await this.#drainAcknowledgements()
      // drain() also waits for already admitted retirement/hash/reader work.
      // Do not start new retirement after Stop: ACK completion may legitimately
      // let the original server finish. Closing is not a retirement receipt.
      const transport = await this.#control.close()
      need(transport?.closed === true && transport.pendingActual === 0, 'original control transport cleanup remains unresolved')
      this.#closed = true; this.#cleanupFailed = false; roots.delete(this.#root); this.#emit()
      return Object.freeze({ closed: true, workerClosed: true, coordinatorStopped: true, transportClosed: true })
    })
    void actual.then(value => { this.#cleanupActive = null; gate.resolve(value) }, error => {
      this.#cleanupActive = null; this.#cleanupFailed = true; this.#problem('cleanup', error); gate.reject(error)
    })
    return gate.promise
  }
  retryCleanup() {
    if (!this.#closing) return Promise.reject(fault('ERR_CANCELLED', 'development application has not begun closing'))
    if (this.#cleanupActive) return this.#cleanupActive
    if (this.#closed) return this.#closing
    // Recovery reuses the same manager close final and transport. A rejected
    // actual Worker close cannot be promoted into success by retrying ACKs.
    if (!this.#ownerClosed) return Promise.reject(fault('ERR_RENDER', 'actual manager close remains unresolved; cleanup cannot be authorized'))
    this.#cleanupFailed = false
    this.#closing = this.#cleanup()
    this.#emit()
    return this.#closing
  }
  close() {
    if (this.#closing) return this.#closing
    const gate = deferred(); this.#closing = gate.promise; this.#running = false
    if (this.#timer !== null) { clearTimeout(this.#timer); this.#timer = null }
    // Gate/close the actual Worker immediately, even if an observe or startup
    // response ignores cancellation. Keep HTTP cleanup alive until its exact
    // owner close and final acknowledgements have settled.
    try { this.#ownerClose = Promise.resolve(this.#manager.close()) } catch (error) { this.#ownerClose = Promise.reject(error) }
    void this.#ownerClose.catch(() => {})
    this.#abort?.abort(fault('ERR_CANCELLED', 'development application closed'))
    this.#refreshAtClose = this.#refresh
    this.#emit()
    void this.#cleanup().then(gate.resolve, gate.reject)
    return gate.promise
  }
}
