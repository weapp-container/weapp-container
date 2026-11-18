import { DomViewError, DomViewPresenter, validateDomPresentationKey } from './dom-presenter.mjs'
import { DomSessionClient, SseBridgeTransport } from './dom-session-client.mjs'
import { UncorrelatedInputLedger } from './input-causal-ledger.mjs'

const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = value => JSON.parse(JSON.stringify(value))
const failure = (code, message) => new DomViewError(code, message)
const retired = message => Object.assign(failure('ERR_CANCELLED', message), { localCancellation: true })
const identity = key => JSON.stringify(['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'].map(field => key?.[field]))
const defaultClock = () => globalThis.performance.now()

/** Encoded manifest assets remain separate from CanvasKit's decoded RGBA
 * resources. A resolver lease owns exactly one object URL and no runtime state.
 */
export function createDomResourceResolver({ fetch: fetchResource = globalThis.fetch.bind(globalThis), createObjectURL = value => URL.createObjectURL(value), revokeObjectURL = value => URL.revokeObjectURL(value) } = {}) {
  return async (descriptor, context) => {
    validateDomPresentationKey(context.presentationKey)
    if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || descriptor.size > 16 * 1024 * 1024) throw failure('ERR_RENDER', 'invalid DOM resource descriptor')
    const response = await fetchResource(`/api/view-resources/${descriptor.sha256}?key=${encodeURIComponent(JSON.stringify(context.presentationKey))}`, { cache: 'no-store', signal: context.signal })
    if (!response.ok) throw failure('ERR_RENDER', `DOM resource request failed: ${response.status}`)
    const bytes = await response.arrayBuffer()
    if (context.signal?.aborted) throw retired('DOM resource preparation retired')
    if (bytes.byteLength !== descriptor.size) throw failure('ERR_RENDER', 'DOM resource size mismatch')
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mime !== descriptor.mime) throw failure('ERR_RENDER', 'DOM resource MIME mismatch')
    const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
    if (digest !== descriptor.sha256) throw failure('ERR_RENDER', 'DOM resource SHA-256 mismatch')
    if (context.signal?.aborted) throw retired('DOM resource preparation retired')
    const url = createObjectURL(new Blob([bytes], { type: descriptor.mime }))
    let released = false
    return { url, release() { if (!released) { released = true; revokeObjectURL(url) } } }
  }
}

/** One browser preview. The server owns the lease and runtime; this adapter
 * only drives a fenced owner transaction or displays an accepted read-only
 * document. One operation is in flight and one latest job may wait behind it.
 */
export class RemoteDomSurface {
  constructor(container, { fetch: fetchRemote = globalThis.fetch.bind(globalThis), clientId = globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`, createPresenter = (element, options) => new DomViewPresenter(element, options), onDiagnostic, onState, onMetrics, clock = defaultClock, setInterval: startInterval = globalThis.setInterval.bind(globalThis), clearInterval: stopInterval = globalThis.clearInterval.bind(globalThis), resolveResource, previewTimeoutMs = 10000 } = {}) {
    if (!Number.isFinite(previewTimeoutMs) || previewTimeoutMs <= 0 || previewTimeoutMs > 60000) throw failure('ERR_PROTOCOL_VERSION', 'invalid preview control timeout')
    this.previewTimeoutMs = previewTimeoutMs; this.disposePromise = null
    this.container = container; this.fetch = fetchRemote; this.clientId = clientId; this.onDiagnostic = onDiagnostic; this.onState = onState; this.onMetrics = onMetrics; this.clock = clock; this.stopInterval = stopInterval
    this.preview = null; this.authority = null; this.source = null; this.online = false; this.awaitingConnect = false; this.connectEpoch = null; this.closed = false; this.sequence = 0; this.pendingPreview = new Map(); this.pendingJob = null; this.runningJob = null; this.completedToken = null; this.drainPromise = null; this.workController = null; this.samples = []; this.timings = null
    this.inputLedger = new UncorrelatedInputLedger({ scope: 'remote-dom', clock }); this.inputTimingObserverFailures = 0
    this.presenter = createPresenter(container, { resolveResource: resolveResource ?? createDomResourceResolver({ fetch: fetchRemote }), onError: value => this.report(value) })
    const prepare = this.presenter.prepare.bind(this.presenter)
    this.presenter.prepare = async (...args) => { const start = clock(); try { return await prepare(...args) } finally { if (this.timings) this.timings.prepareMs += clock() - start } }
    this.transport = new SseBridgeTransport({ session: () => this.authority?.sessionId, send: (envelope, { signal, hostContext }) => {
      if (!this.isOwner || !this.online) throw retired('preview no longer owns the DOM surface')
      return this.fetch('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.fence(envelope, hostContext)), signal })
    }, onDiagnostic: value => this.report(value), onBatch: batch => this.receiveQueryBatch(batch) })
    const request = this.transport.request.bind(this.transport)
    this.transport.request = async (...args) => { const start = clock(); try { return await request(...args) } finally { if (this.timings) this.timings.bridgeMs += clock() - start } }
    this.client = new DomSessionClient({ presenter: this.presenter, transport: this.transport, queryScope: 'presentation',
      inputGate: () => this.isOwner,
      onDiagnostic: value => this.report(value), onState: value => this.emit({ ...value, owner: this.isOwner }) })
    this.presenter.onEventBatch = batch => {
      let sample
      try { sample = this.inputLedger.capture({ binding: { ...batch?.key, previewEpoch: this.preview?.epoch },
        eventCount: batch?.events?.length ?? 1, nativeTimeStamp: batch?.events?.[0]?.timeStamp }) } catch { this.inputTimingObserverFailures++ }
      const actual = this.client.events(batch)
      void Promise.resolve(actual).then(result => this.inputLedger.complete([sample], { outcome: result?.discarded ? 'local-discarded' : 'protocol-completed' }),
        () => this.inputLedger.complete([sample], { outcome: 'protocol-error' })).catch(() => { this.inputTimingObserverFailures++ })
      return actual
    }
    this.heartbeat = startInterval(() => { if (this.online && !this.closed) this.previewRequest('heartbeat').catch(value => this.report(value)) }, 5000)
  }
  get isOwner() { return this.online && !this.awaitingConnect && this.preview?.ownerClientId === this.clientId }
  get inputTiming() { return Object.freeze({ ...this.inputLedger.snapshot(), observerFailures: this.inputTimingObserverFailures }) }
  report(value) { if (!value?.localCancellation) try { this.onDiagnostic?.(value) } catch { /* Diagnostics never grant preview ownership. */ } }
  emit(value) { try { this.onState?.({ clientId: this.clientId, preview: this.preview, ...value }) } catch (error) { this.report(error) } }
  fence(value, hostContext) {
    if (!this.isOwner || !decimal(this.preview?.epoch)) throw retired('claim the active preview before dispatching')
    if (hostContext?.previewEpoch !== undefined && hostContext.previewEpoch !== this.preview.epoch) throw retired('preview request belongs to a retired lease')
    const preview = { clientId: this.clientId, epoch: this.preview.epoch }
    const messages = Array.isArray(value?.messages) ? value.messages : [value]
    if (messages.some(message => message?.op === 'view.prepare')) {
      const revision = hostContext?.requestRevision ?? this.source?.viewRequest?.revision
      if (!decimal(revision)) throw failure('ERR_PROTOCOL_VERSION', 'view.prepare needs a canonical request revision')
      preview.requestRevision = revision
    }
    return { ...value, preview }
  }
  async previewRequest(op, { keepalive = false } = {}) {
    if (this.closed) return
    for (const [id, pending] of this.pendingPreview) if (pending.expires <= Date.now()) { pending.controller?.abort(retired('preview control expired')); this.pendingPreview.delete(id) }
    if ([...this.pendingPreview.values()].some(value => value.op === op)) return
    if (this.pendingPreview.size >= 8) throw failure('ERR_RENDER', 'preview control queue full')
    const requestId = `preview-${this.clientId}-${++this.sequence}`
    const body = { version: '1.0', requestId, clientId: this.clientId, op, ...(decimal(this.preview?.epoch) ? { epoch: this.preview.epoch } : {}) }
    const controller = new AbortController()
    const timeoutMs = op === 'release' ? Math.min(this.previewTimeoutMs, 1000) : this.previewTimeoutMs
    this.pendingPreview.set(requestId, { op, expires: Date.now() + timeoutMs, controller })
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason ?? retired('preview control aborted'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timer = globalThis.setTimeout(() => controller.abort(failure('ERR_TIMEOUT', `preview ${op} exceeded its time budget`)), timeoutMs)
    const operation = async () => {
      const response = await this.fetch('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive, signal: controller.signal })
      if (controller.signal.aborted) throw controller.signal.reason
      const receipt = await response.json()
      if (controller.signal.aborted) throw controller.signal.reason
      if (!response.ok) throw failure(receipt.error?.code ?? 'ERR_RENDER', receipt.error?.message ?? `preview request failed: ${response.status}`)
      if (receipt.preview && receipt.queued !== true) this.receivePreview(receipt)
      return receipt
    }
    try {
      // Race independently of fetch: a custom transport or stalled body reader
      // may ignore AbortSignal. A late response must not update a retired lease.
      return await Promise.race([operation(), aborted])
    } catch (error) { this.pendingPreview.delete(requestId); throw error }
    finally { globalThis.clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort) }
  }
  async connect() {
    if (this.closed) return
    this.workController?.abort(); this.online = true; this.awaitingConnect = true; this.connectEpoch = this.preview?.epoch ?? null; this.completedToken = null
    this.client.disconnect('waiting for a fresh preview connection')
    await this.previewRequest('connect')
    this.schedule()
  }
  claim() { return this.previewRequest('claim') }
  receivePreview(value) {
    if (this.closed || !record(value)) return
    const pending = value.clientId === this.clientId ? this.pendingPreview.get(value.requestId) : null
    if (pending) this.pendingPreview.delete(value.requestId)
    if (value.ok === false) {
      if (value.clientId === this.clientId) this.report(failure(value.error?.code ?? 'ERR_RENDER', value.error?.message ?? 'preview control rejected'))
      return
    }
    if (value.preview) {
      if (pending?.op === 'connect') this.awaitingConnect = false
      this.updatePreview(value.preview); this.schedule()
    }
  }
  updatePreview(value) {
    if (!record(value) || value.version !== '1.0' || !decimal(value.epoch) || !(value.ownerClientId === null || typeof value.ownerClientId === 'string')) throw failure('ERR_PROTOCOL_VERSION', 'invalid preview lease state')
    if (this.preview && BigInt(value.epoch) < BigInt(this.preview.epoch)) return
    if (this.preview?.epoch === value.epoch && this.preview.ownerClientId !== value.ownerClientId) throw failure('ERR_PROTOCOL_VERSION', 'preview owner changed without an epoch')
    const wasOwner = this.isOwner, changed = !this.preview || this.preview.epoch !== value.epoch || this.preview.ownerClientId !== value.ownerClientId
    if (this.awaitingConnect && this.connectEpoch !== null && value.ownerClientId === this.clientId && BigInt(value.epoch) > BigInt(this.connectEpoch)) this.awaitingConnect = false
    this.preview = Object.freeze(copy(value))
    if (!changed) return
    this.workController?.abort(); this.completedToken = null; this.pendingJob = null
    if (wasOwner || !this.isOwner) this.client.disconnect('preview lease changed')
    if (this.isOwner && this.authority) this.client.reconnect(this.authority)
    this.emit({ phase: this.isOwner ? 'owner' : 'readonly', owner: this.isOwner })
    this.schedule()
  }
  updateState(state) {
    if (this.closed || state.webRenderer !== 'webview') return
    if (state.preview) this.updatePreview(state.preview)
    if (state.viewAuthority) {
      const value = state.viewAuthority
      if (value.sessionId !== state.sessionId || !decimal(value.revision) || !decimal(value.surfaceGeneration) || !decimal(value.previewEpoch)) throw failure('ERR_PROTOCOL_VERSION', 'invalid DOM state authority')
      if (this.authority?.sessionId === value.sessionId && (BigInt(value.revision) < BigInt(this.authority.revision) || BigInt(value.surfaceGeneration) < BigInt(this.authority.surfaceGeneration))) return
      this.authority = Object.freeze(copy(value)); this.client.updateAuthority(this.authority)
    }
    if (this.source?.sessionId === state.sessionId && decimal(this.source.viewRequest?.revision) && decimal(state.viewRequest?.revision) && BigInt(state.viewRequest.revision) < BigInt(this.source.viewRequest.revision)) return
    this.source = state
    this.schedule()
  }
  receiveBridge(batch) { return this.transport.receive(batch) }
  receiveQueryBatch(batch) { return this.client?.receiveQueryBatch(batch) ?? 0 }
  schedule() {
    if (this.closed || !this.online || this.awaitingConnect || !this.source || !this.authority) return
    let job
    if (this.isOwner) {
      if (this.authority.previewEpoch !== this.preview.epoch) return
      const request = this.source.viewRequest
      if (!request || request.version !== '1.0' || !decimal(request.revision) || !record(request.render)) return
      job = { mode: 'owner', token: `owner:${this.preview.epoch}:${this.authority.sessionId}:${this.authority.revision}:${request.revision}`, render: request.render, requestRevision: request.revision, authority: this.authority, epoch: this.preview.epoch }
    } else {
      const submission = this.source.viewPresented
      if (!submission) return
      validateDomPresentationKey(submission.key, submission.document)
      if (submission.key.sessionId !== this.authority.sessionId || submission.key.surfaceGeneration !== this.authority.surfaceGeneration) return
      job = { mode: 'readonly', token: `mirror:${identity(submission.key)}`, submission, authority: this.authority, epoch: this.preview?.epoch }
    }
    if (job.token === this.completedToken || job.token === this.runningJob?.token || job.token === this.pendingJob?.token) return
    this.pendingJob = job
    if (this.runningJob) this.workController?.abort()
    if (!this.drainPromise) this.drainPromise = this.drain().finally(() => { this.drainPromise = null; if (this.pendingJob && !this.closed) this.scheduleDrain() })
  }
  scheduleDrain() {
    if (!this.drainPromise) this.drainPromise = this.drain().finally(() => { this.drainPromise = null })
  }
  current(job) { return !this.closed && this.online && !this.workController?.signal.aborted && this.runningJob === job && this.authority?.sessionId === job.authority.sessionId && this.authority?.revision === job.authority.revision && this.authority?.surfaceGeneration === job.authority.surfaceGeneration && this.preview?.epoch === job.epoch && (job.mode === 'owner') === this.isOwner }
  async drain() {
    while (this.pendingJob && !this.closed && this.online) {
      const job = this.pendingJob; this.pendingJob = null; this.runningJob = job; this.workController = new AbortController()
      const started = this.clock(); this.timings = { prepareMs: 0, bridgeMs: 0 }
      try {
        if (!this.current(job)) continue
        let result
        if (job.mode === 'owner') {
          this.client.reconnect(job.authority)
          result = await this.client.present(job.render, { releaseMode: 'strict', signal: this.workController.signal, hostContext: { requestRevision: job.requestRevision, previewEpoch: job.epoch } })
        } else {
          const value = job.submission
          const candidate = await this.presenter.prepare(value.document, { viewport: value.viewport, presentationKey: value.key, signal: this.workController.signal, isCurrent: () => this.current(job), resumePreviousOnAbort: false })
          if (!this.current(job)) { this.presenter.abort(candidate, { resumePrevious: false }); continue }
          const receipt = this.presenter.commit(candidate, { version: '1.0', key: value.key, epoch: candidate.preparation.epoch, permitId: `readonly:${identity(value.key)}` })
          this.presenter.confirm(receipt, { inputEnabled: false })
          result = { key: value.key, inputEnabled: false }
        }
        if (!this.current(job)) continue
        this.completedToken = job.token
        const now = this.clock(); this.samples.push(now); while (this.samples.length > 1 && this.samples[0] < now - 1000) this.samples.shift()
        const actualFps = this.samples.length > 1 ? (this.samples.length - 1) * 1000 / Math.max(1, now - this.samples[0]) : 0
        this.onMetrics?.({ renderer: 'webview', key: result.key, owner: job.mode === 'owner', actualFps, transactionCompletedAt: now,
          endpoint: 'dom-protocol-completed', inputAssociation: 'unavailable', compositorPresentedAt: null,
          performanceGate: 'blocked', totalMs: now - started, ...this.timings })
        this.emit({ phase: 'presented', owner: job.mode === 'owner', key: result.key, inputEnabled: result.inputEnabled })
      } catch (error) {
        // Heartbeats and identical state snapshots are not new View inputs.
        // A failed current job stays retired until its authority/input changes.
        if (this.current(job)) this.completedToken = job.token
        if (!this.workController.signal.aborted) this.report(error)
      }
      finally { this.runningJob = null; this.workController = null; this.timings = null }
    }
  }
  disconnect(reason = 'DOM preview stream disconnected') {
    this.online = false; this.workController?.abort(); this.pendingJob = null; this.completedToken = null; this.client.disconnect(reason); this.emit({ phase: 'disconnected', owner: false })
  }
  dispose() {
    if (this.disposePromise) return this.disposePromise
    let resolve, reject
    this.disposePromise = new Promise((yes, no) => { resolve = yes; reject = no })
    const release = this.preview ? this.previewRequest('release', { keepalive: true }).catch(value => this.report(value)) : Promise.resolve()
    this.closed = true
    try { this.inputLedger.retire() } catch { this.inputTimingObserverFailures++ }
    this.disconnect('DOM surface disposed'); this.stopInterval(this.heartbeat)
    for (const pending of this.pendingPreview.values()) if (pending.op !== 'release') pending.controller?.abort(retired('DOM surface disposed'))
    this.pendingPreview.clear()
    // Local iframe/object-URL cleanup starts immediately, independently of a
    // best-effort release receipt. All callers await the same cleanup barrier.
    const local = this.client.dispose()
    Promise.allSettled([local, release, this.drainPromise]).then(results => {
      if (results[0].status === 'rejected') reject(results[0].reason)
      else resolve()
    }, reject)
    return this.disposePromise
  }
}
