import { DevRasterPresenterClient } from './dev-raster-client.mjs'
import { compareRasterU64, decodeDevRasterFrame, sameDevRasterTicket } from './dev-raster-frame.mjs'

const failure = (code, message) => Object.assign(new Error(message), { code })
const cancelled = message => Object.assign(failure('ERR_CANCELLED', message), { localCancellation: true })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const sameAuthority = (a, b) => a && b && ['sessionId', 'pageId', 'configGeneration'].every(key => a[key] === b[key])
const positive = value => { compareRasterU64(value, value); if (value === '0') throw failure('ERR_PROTOCOL_VERSION', 'inactive Raster identity'); return value }
const remoteError = (body, status) => failure(typeof body?.error?.code === 'string' ? body.error.code : 'ERR_RENDER', typeof body?.error?.message === 'string' ? body.error.message : `Raster HTTP request failed: ${status}`)

function preview(value) {
  if (!record(value) || value.version !== '1.0' || !(value.ownerClientId === null || validId(value.ownerClientId))
    || typeof value.expired !== 'boolean' || !Number.isFinite(value.leaseDurationMs) || value.leaseDurationMs <= 0) throw failure('ERR_PROTOCOL_VERSION', 'invalid Raster preview projection')
  compareRasterU64(value.epoch, value.epoch)
  return Object.freeze({ epoch: value.epoch, ownerClientId: value.ownerClientId, expired: value.expired, leaseDurationMs: value.leaseDurationMs })
}
function authority(state) {
  const profile = state?.devRaster, value = profile?.binding
  if (profile?.profile !== 'ticketed-raster-v1' || profile.protocolVersion !== '1.0' || profile.binaryFrameVersion !== 2
    || profile.ackOp !== 'dev.raster.presented' || profile.connectionInitEvent !== 'preview-init'
    || !record(value) || typeof value.sessionId !== 'string' || !value.sessionId
    || encoder.encode(value.sessionId).length > 256 || decoder.decode(encoder.encode(value.sessionId)) !== value.sessionId
    || state.sessionId !== value.sessionId) throw failure('ERR_PROTOCOL_VERSION', 'server did not advertise the ticketed Raster profile')
  positive(value.configGeneration)
  if (value.pageId !== null) positive(value.pageId)
  return Object.freeze({ sessionId: value.sessionId, pageId: value.pageId, configGeneration: value.configGeneration })
}

/** Explicit developer-profile connection owner. Each actual EventSource has
 * its own private init token and bounded final-heartbeat handshake. Replayed
 * state/preview notifications only request a fresh, serial GET /api/state.
 * Nothing here enables legacy HTML/CLI or treats RAF return as screen present.
 */
export class DevRasterPreview {
  constructor({ canvas, clientId = globalThis.crypto?.randomUUID?.() ?? `raster-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fetch: fetchRemote = (...args) => globalThis.fetch(...args), createEventSource = url => new EventSource(url),
    scheduleFrame = callback => requestAnimationFrame(callback), cancelFrame = handle => cancelAnimationFrame(handle),
    setTimeout: startTimer = globalThis.setTimeout.bind(globalThis), clearTimeout: stopTimer = globalThis.clearTimeout.bind(globalThis),
    clock = () => Date.now(),
    onState, onDiagnostic, heartbeatMs = 5000, controlTimeoutMs = 3000, maxHandshakeAttempts = 3,
    createPresenter = options => new DevRasterPresenterClient(options) } = {}) {
    if (!validId(clientId) || typeof fetchRemote !== 'function' || typeof createEventSource !== 'function'
      || typeof startTimer !== 'function' || typeof stopTimer !== 'function' || typeof scheduleFrame !== 'function' || typeof cancelFrame !== 'function' || typeof clock !== 'function'
      || ![heartbeatMs, controlTimeoutMs].every(value => Number.isFinite(value) && value > 0 && value <= 10000)
      || !Number.isInteger(maxHandshakeAttempts) || maxHandshakeAttempts < 1 || maxHandshakeAttempts > 5) throw failure('ERR_PROTOCOL_VERSION', 'invalid Raster preview configuration')
    this.clientId = clientId; this.canvas = canvas; this.fetch = fetchRemote; this.createEventSource = createEventSource
    this.scheduleFrame = scheduleFrame; this.cancelFrame = cancelFrame; this.startTimer = startTimer; this.stopTimer = stopTimer
    this.clock = clock; this.time()
    this.onState = onState; this.onDiagnostic = onDiagnostic; this.heartbeatMs = heartbeatMs; this.controlTimeoutMs = controlTimeoutMs; this.maxHandshakeAttempts = maxHandshakeAttempts
    this.connection = null; this.closed = false; this.sequence = 0n; this.mirrorPending = null; this.mirrorScheduled = null; this.mirrorLatest = null; this.mirrorPresented = null
    this.prefix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.presenter = createPresenter({ canvas, scheduleFrame, cancelFrame, send: (envelope, options) => {
      const c = this.connection, fence = envelope?.preview
      // A paused timer queue cannot keep an old local lease alive until this
      // send microtask. The original runtime still verifies real expiry.
      if (!this.owner || envelope.sessionId !== c.authority?.sessionId || fence?.clientId !== this.clientId
        || fence.epoch !== c.proof.epoch || fence.connectionToken !== c.proof.token) throw cancelled('Raster local connection lease expired before bridge send')
      return this.fetch('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: options.signal })
    },
      onState: value => this.emit(value.phase), onDiagnostic: value => this.report(value), timeoutMs: controlTimeoutMs })
  }
  current(connection) { return !this.closed && this.connection === connection && !connection.retired }
  time() {
    const value = this.clock()
    if (!Number.isFinite(value) || value < 0) throw failure('ERR_PROTOCOL_VERSION', 'Raster clock must return finite nonnegative elapsed milliseconds')
    return value
  }
  liveProof(c) {
    if (!c || !this.current(c) || !c.proof || c.leaseRejected || c.leaseDeadline === null) return false
    let now
    try { now = this.time() } catch { c.leaseRejected = true; return false }
    if (now < c.leaseObservedAt || now >= c.leaseDeadline) { c.leaseRejected = true; return false }
    c.leaseObservedAt = now
    return true
  }
  forgetProof(c) {
    c.proof = null; c.leaseDeadline = null; c.leaseObservedAt = null; c.leaseRejected = true
    this.clearTimer(c, c.leaseTimer); c.leaseTimer = null
  }
  scheduleLease(c) {
    this.clearTimer(c, c.leaseTimer)
    c.leaseTimer = this.timer(c, () => {
      c.leaseTimer = null
      if (this.liveProof(c)) { this.scheduleLease(c); return }
      this.freeze(c, 'Raster conservative local lease expired')
      if (!this.current(c)) return
      this.emit('lease-expired'); this.refreshState(c); this.confirm(c, true)
    }, Math.max(0, c.leaseDeadline - c.leaseObservedAt))
  }
  get owner() { const c = this.connection; return !!(c && !c.retired && !this.closed && c.preview && !c.preview.expired && this.liveProof(c) && c.proof.token === c.token && c.proof.epoch === c.preview.epoch && c.preview.ownerClientId === this.clientId) }
  get inputEnabled() { return this.owner && this.presenter.inputEnabled }
  report(value) { if (!value?.localCancellation) try { this.onDiagnostic?.(value) } catch { /* Diagnostics grant no authority. */ } }
  emit(phase) {
    const c = this.connection
    const value = { phase, clientId: this.clientId, connected: !!(c && !c.retired), owner: this.owner, inputEnabled: this.inputEnabled,
      sessionId: c?.authority?.sessionId ?? null, pageId: c?.authority?.pageId ?? null, configGeneration: c?.authority?.configGeneration ?? null,
      previewEpoch: c?.preview?.epoch ?? null, presentationTicket: this.owner ? this.presenter.latest?.presentationTicket ?? null : this.mirrorPresented }
    try { this.onState?.(Object.freeze(value)) } catch (error) { this.report(error) }
  }
  timer(c, callback, delay) {
    if (!this.current(c)) return null
    const handle = this.startTimer(() => { c.timers.delete(handle); if (this.current(c)) callback() }, delay)
    c.timers.add(handle); return handle
  }
  clearTimer(c, handle) { if (handle !== null && handle !== undefined) { this.stopTimer(handle); c.timers.delete(handle) } }
  clearMirror() {
    const scheduled = this.mirrorScheduled
    this.mirrorScheduled = null; this.mirrorPending = null; this.mirrorLatest = null; this.mirrorPresented = null
    if (scheduled) try { this.cancelFrame(scheduled.handle) } catch (error) { this.report(error) }
  }
  freeze(c, reason) {
    c.frameController?.abort(cancelled(reason)); this.clearTimer(c, c.frameRetry); c.frameRetry = null
    this.clearMirror(); this.presenter.disconnect(reason)
  }
  retire(c, reason) {
    if (!c || c.retired) return
    c.retired = true
    if (this.connection === c) this.connection = null
    this.forgetProof(c); c.confirmation = null; c.frameWanted = false; c.stateWanted = false
    this.freeze(c, reason)
    this.cancelControl(c, cancelled(reason))
    for (const controller of c.controllers) controller.abort(cancelled(reason))
    for (const handle of c.timers) try { this.stopTimer(handle) } catch (error) { this.report(error) }
    c.timers.clear()
    for (const [name, listener] of c.listeners) try { c.source?.removeEventListener?.(name, listener) } catch (error) { this.report(error) }
    try { c.source?.close() } catch (error) { this.report(error) }
  }
  connect() {
    if (this.closed) throw cancelled('Raster preview is disposed')
    this.retire(this.connection, 'Raster EventSource replaced')
    if (this.closed) throw cancelled('Raster preview was disposed during replacement')
    if (this.connection) return this // A synchronous state callback already connected a successor.
    const c = { source: null, listeners: new Map(), retired: false, timers: new Set(), controllers: new Set(), token: null, preview: null, authority: null, proof: null,
      control: null, confirmation: null, handshakeAttempts: 0, heartbeatTimer: null, retryTimer: null, stateAttempts: 0, stateRetry: null,
      stateWanted: false, stateWork: null, frameWanted: false, frameWork: null, frameController: null, frameRetry: null, frameAttempts: 0 }
    Object.assign(c, { leaseDeadline: null, leaseObservedAt: null, leaseRejected: true, leaseTimer: null })
    this.connection = c
    try {
      c.source = this.createEventSource(`/api/events?clientId=${encodeURIComponent(this.clientId)}&since=0`)
      for (const name of ['open', 'error', 'preview-init', 'preview', 'state', 'ready', 'reload', 'snapshot', 'bridge', 'shutdown']) {
        const listener = event => {
          if (!this.current(c)) return
          try { this.event(c, name, event) } catch (error) { this.report(error); this.retire(c, 'Raster stream protocol failure'); this.emit('error') }
        }
        c.listeners.set(name, listener); c.source.addEventListener(name, listener)
      }
      c.initTimer = this.timer(c, () => { this.report(failure('ERR_TIMEOUT', 'Raster stream did not provide private init')); this.retire(c, 'Raster init timeout'); this.emit('error') }, this.controlTimeoutMs)
      this.emit('connecting'); this.refreshState(c)
      return this
    } catch (error) { this.retire(c, 'Raster EventSource construction failed'); throw error }
  }
  event(c, name, event) {
    if (name === 'open') { this.emit('waiting-init'); return }
    if (name === 'error' || name === 'shutdown') { this.retire(c, 'Raster event stream disconnected'); this.emit('disconnected'); return }
    if (['state', 'ready', 'reload', 'snapshot'].includes(name)) { this.refreshState(c); if (name === 'snapshot') this.wantFrame(c); return }
    if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) throw failure('ERR_PROTOCOL_VERSION', 'invalid Raster SSE data')
    let value
    try { value = JSON.parse(event.data) } catch { throw failure('ERR_PROTOCOL_VERSION', 'invalid Raster SSE JSON') }
    if (name === 'bridge') { this.presenter.receive(value); return }
    if (name === 'preview') { this.receivePreview(c, value); this.refreshState(c); return }
    if (!record(value) || Object.keys(value).length !== 4 || value.version !== '1.0' || value.clientId !== this.clientId || value.committed !== false
      || typeof value.connectionToken !== 'string' || !/^[\x21-\x7e]{1,85}$/.test(value.connectionToken)) throw failure('ERR_PROTOCOL_VERSION', 'invalid private Raster init')
    if (c.token !== null && c.token !== value.connectionToken) throw failure('ERR_PROTOCOL_VERSION', 'one EventSource changed its private token')
    c.token = value.connectionToken; this.clearTimer(c, c.initTimer); c.initTimer = null
    this.confirm(c)
  }
  async request(c, url, { controller = new AbortController(), ...options } = {}, read = response => response.json()) {
    if (!this.current(c)) throw cancelled('Raster connection retired')
    c.controllers.add(controller)
    let listener
    const stopped = new Promise((_, reject) => {
      listener = () => reject(controller.signal.reason ?? cancelled('Raster request aborted'))
      if (controller.signal.aborted) listener()
      else controller.signal.addEventListener('abort', listener, { once: true })
    })
    const timer = this.timer(c, () => controller.abort(failure('ERR_TIMEOUT', `Raster request timed out: ${url}`)), this.controlTimeoutMs)
    const work = Promise.resolve().then(async () => {
      if (!this.current(c) || controller.signal.aborted) throw cancelled('Raster request retired before sending')
      const response = await this.fetch(url, { ...options, cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted || !this.current(c)) throw cancelled('Raster response is retired')
      return read(response)
    })
    try { return await Promise.race([work, stopped]) }
    finally { this.clearTimer(c, timer); c.controllers.delete(controller); controller.signal.removeEventListener('abort', listener) }
  }
  refreshState(c = this.connection) {
    if (!c || !this.current(c)) return
    c.stateWanted = true
    if (c.stateWork) return
    c.stateWork = (async () => {
      while (this.current(c) && c.stateWanted) {
        c.stateWanted = false
        try {
          const state = await this.request(c, '/api/state', {}, async response => { const body = await response.json(); if (!response.ok) throw remoteError(body, response.status); return body })
          if (this.current(c)) { this.applyState(c, state); c.stateAttempts = 0 }
        } catch (error) { if (this.current(c)) {
          this.forgetProof(c); this.freeze(c, 'Raster state unavailable'); this.report(error); this.emit('error')
          if (++c.stateAttempts >= this.maxHandshakeAttempts || error.code === 'ERR_PROTOCOL_VERSION') this.retire(c, 'Raster state retry budget exhausted')
          else if (c.stateRetry === null) c.stateRetry = this.timer(c, () => { c.stateRetry = null; this.refreshState(c) }, Math.min(250, this.controlTimeoutMs))
        } }
      }
    })().finally(() => {
      c.stateWork = null
      // A notification may arrive after the loop exits but before this
      // completion microtask releases its slot. Preserve that last wakeup.
      if (this.current(c) && c.stateWanted) this.refreshState(c)
    })
  }
  applyState(c, state) {
    const next = authority(state), nextPreview = preview(state.preview)
    if (this.heartbeatMs + 2 * this.controlTimeoutMs >= nextPreview.leaseDurationMs) throw failure('ERR_PROTOCOL_VERSION', 'Raster heartbeat deadlines exceed the advertised lease')
    if (c.preview && compareRasterU64(nextPreview.epoch, c.preview.epoch) < 0) throw cancelled('Raster state preview regressed')
    if (c.preview?.epoch === nextPreview.epoch && c.preview.ownerClientId !== nextPreview.ownerClientId) throw failure('ERR_PROTOCOL_VERSION', 'preview owner changed without an epoch')
    const changedAuthority = !sameAuthority(c.authority, next)
    const changedPreview = !c.preview || c.preview.epoch !== nextPreview.epoch || c.preview.ownerClientId !== nextPreview.ownerClientId || c.preview.expired !== nextPreview.expired
    if (changedAuthority || changedPreview) {
      this.freeze(c, 'Raster authoritative state changed')
      if (!this.current(c)) return
      if (changedPreview) { this.forgetProof(c); c.confirmation = null; c.handshakeAttempts = 0; this.cancelControl(c, cancelled('Raster preview state changed')) }
    }
    if (changedAuthority) c.authority = next
    c.preview = nextPreview
    this.bind(c); this.confirm(c)
  }
  bind(c) {
    if (!this.current(c) || !this.liveProof(c) || !c.authority || c.proof.token !== c.token || c.proof.epoch !== c.preview?.epoch) return
    if (this.owner && c.authority.pageId !== null) {
      this.presenter.setBinding({ ...c.authority, clientId: this.clientId, epoch: c.proof.epoch, connectionToken: c.proof.token })
      this.emit('owner')
    } else { this.presenter.disconnect('Raster mirror is read only'); this.emit('readonly') }
    this.wantFrame(c)
  }
  confirm(c, renewal = false) {
    if (!this.current(c) || !c.token || !c.preview || !c.authority || c.control || c.retryTimer !== null) return
    if (this.liveProof(c) && !renewal) return
    if (++c.handshakeAttempts > this.maxHandshakeAttempts) {
      this.report(failure('ERR_TIMEOUT', 'Raster bound heartbeat attempts exhausted')); this.retire(c, 'Raster handshake exhausted'); this.emit('error'); return
    }
    const attempt = Object.freeze({ token: c.token, epoch: c.preview.epoch }); c.confirmation = attempt
    this.emit('confirming')
    this.control(c, 'heartbeat').then(result => {
      if (!this.current(c) || c.confirmation !== attempt || result.token !== c.token || result.preview.epoch !== c.preview?.epoch) return
      c.confirmation = null
      c.preview = result.preview
      if (c.proof?.token !== result.token || c.proof?.epoch !== result.preview.epoch) c.proof = Object.freeze({ token: result.token, epoch: result.preview.epoch })
      c.leaseDeadline = result.leaseDeadline; c.leaseObservedAt = result.observedAt; c.leaseRejected = false
      c.handshakeAttempts = 0
      this.bind(c); this.scheduleHeartbeat(c); this.scheduleLease(c)
    }, error => {
      if (!this.current(c) || c.confirmation !== attempt) return
      c.confirmation = null
      this.forgetProof(c); this.freeze(c, 'Raster heartbeat unconfirmed'); this.report(error); this.refreshState(c)
      c.retryTimer = this.timer(c, () => { c.retryTimer = null; this.confirm(c) }, Math.min(250, this.controlTimeoutMs))
    })
  }
  scheduleHeartbeat(c) {
    this.clearTimer(c, c.heartbeatTimer)
    c.heartbeatTimer = this.timer(c, () => { c.heartbeatTimer = null; this.confirm(c, true) }, this.heartbeatMs)
  }
  control(c, op) {
    if (!this.current(c) || !c.token || !c.preview || c.control) return Promise.reject(cancelled('Raster control has no current connection'))
    let sentAt
    try { sentAt = this.time() } catch (error) { return Promise.reject(error) }
    const requestId = `raster-${this.prefix}-${++this.sequence}`
    const pending = { requestId, token: c.token, epoch: c.preview.epoch, op, sentAt, controller: new AbortController(), timer: null }
    const result = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject })
    c.control = pending
    pending.timer = this.timer(c, () => this.finishControl(c, pending, failure('ERR_TIMEOUT', 'Raster final preview response timed out')), this.controlTimeoutMs)
    const body = { version: '1.0', requestId, clientId: this.clientId, op, epoch: pending.epoch, connectionToken: pending.token }
    this.request(c, '/api/preview', { controller: pending.controller, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, async response => {
      const value = await response.json(); if (!response.ok) throw remoteError(value, response.status); return value
    }).then(value => {
      if (!this.current(c) || c.control !== pending) return
      // HTTP proves admission only. Even a correlated success-shaped body
      // must not impersonate the final event from this actual EventSource.
      if (!record(value) || value.queued !== true || value.requestId !== pending.requestId) {
        this.finishControl(c, pending, failure('ERR_PROTOCOL_VERSION', 'Raster preview HTTP requires a correlated queued receipt'))
      }
    }, error => this.finishControl(c, pending, error))
    return result
  }
  finishControl(c, pending, error, result) {
    if (c.control !== pending) return
    c.control = null; this.clearTimer(c, pending.timer); pending.controller.abort(cancelled('Raster control settled'))
    if (error) pending.reject(error); else pending.resolve(result)
  }
  cancelControl(c, error) { if (c.control) this.finishControl(c, c.control, error) }
  receivePreview(c, value) {
    const pending = c.control
    if (!pending || !this.current(c) || pending.token !== c.token || value?.requestId !== pending.requestId || value.clientId !== this.clientId || value.queued === true) return
    if (value.ok === false) { this.finishControl(c, pending, remoteError(value, 409)); return }
    if (value.ok !== true) return
    let projection, leaseDeadline, observedAt
    try {
      projection = preview(value.preview)
      if (pending.op === 'heartbeat' && (projection.epoch !== pending.epoch || c.preview?.epoch !== pending.epoch)) throw cancelled('Raster heartbeat returned a different owner epoch')
      if (projection.epoch === c.preview?.epoch && projection.ownerClientId !== c.preview.ownerClientId) throw failure('ERR_PROTOCOL_VERSION', 'Raster final preview changed owner without epoch')
      leaseDeadline = pending.sentAt + projection.leaseDurationMs; observedAt = this.time()
      if (!Number.isFinite(leaseDeadline)) throw failure('ERR_PROTOCOL_VERSION', 'Raster local lease deadline overflow')
      if (observedAt < pending.sentAt || observedAt >= leaseDeadline) throw cancelled('Raster final preview arrived outside its conservative local lease')
    } catch (error) { this.finishControl(c, pending, error); return }
    this.finishControl(c, pending, null, { preview: projection, token: pending.token, leaseDeadline, observedAt })
  }
  claim() {
    const c = this.connection
    if (!c || !this.current(c) || !c.proof) return Promise.reject(cancelled('Confirm the actual Raster connection before claiming'))
    this.forgetProof(c); this.freeze(c, 'Raster explicit claim'); this.clearTimer(c, c.heartbeatTimer); c.heartbeatTimer = null
    return this.control(c, 'claim').then(result => {
      if (!this.current(c)) throw cancelled('Raster claim belongs to a retired socket')
      c.preview = result.preview; c.handshakeAttempts = 0; this.refreshState(c); this.confirm(c)
      return Object.freeze({ ownerClientId: result.preview.ownerClientId, epoch: result.preview.epoch })
    }, error => { if (this.current(c)) { this.report(error); this.refreshState(c); this.confirm(c) } throw error })
  }
  wantFrame(c = this.connection, retry = false) {
    if (!c || !this.current(c)) return
    if (!retry) { c.frameAttempts = 0; this.clearTimer(c, c.frameRetry); c.frameRetry = null }
    c.frameWanted = true
    if (c.frameWork || !this.liveProof(c) || !c.authority || c.authority.pageId === null || c.preview?.expired || c.preview?.ownerClientId === null) return
    c.frameWork = (async () => {
      while (this.current(c) && c.frameWanted && this.liveProof(c) && c.authority?.pageId !== null) {
        c.frameWanted = false
        const captured = { authority: c.authority, proof: c.proof, owner: this.owner, request: null }
        const controller = new AbortController(); c.frameController = controller
        try {
          if (captured.owner) {
            this.presenter.setBinding({ ...captured.authority, clientId: this.clientId, epoch: captured.proof.epoch, connectionToken: captured.proof.token })
            if (!this.current(c) || c.authority !== captured.authority || c.proof !== captured.proof || !this.owner) continue
            captured.request = this.presenter.captureFrameRequest()
          }
          const buffer = await this.request(c, '/api/frame', { controller }, async response => {
            if (response.status === 404) return null
            if (!response.ok) throw remoteError(await response.json(), response.status)
            if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/vnd.weapp.frame.v2') throw failure('ERR_PROTOCOL_VERSION', 'Raster server returned another binary frame version')
            return response.arrayBuffer()
          })
          if (!this.current(c) || !this.liveProof(c) || c.authority !== captured.authority || c.proof !== captured.proof || this.owner !== captured.owner || buffer === null) continue
          c.frameAttempts = 0; this.clearTimer(c, c.frameRetry); c.frameRetry = null
          if (captured.owner) this.presenter.offer(buffer, captured.request)
          else this.offerMirror(c, buffer, captured)
        } catch (error) { if (this.current(c) && c.authority === captured.authority && c.proof === captured.proof) {
          this.presenter.disconnect('Raster frame fetch failed'); this.clearMirror(); this.report(error); this.emit('error')
          if (!error.localCancellation && error.code !== 'ERR_PROTOCOL_VERSION' && ++c.frameAttempts < this.maxHandshakeAttempts && c.frameRetry === null) {
            c.frameRetry = this.timer(c, () => { c.frameRetry = null; this.wantFrame(c, true) }, Math.min(250, this.controlTimeoutMs))
          }
        } }
        finally { if (c.frameController === controller) c.frameController = null }
      }
    })().catch(error => { if (this.current(c)) this.report(error) }).finally(() => {
      c.frameWork = null
      if (this.current(c) && c.frameWanted) this.wantFrame(c, true)
    })
  }
  offerMirror(c, buffer, captured) {
    const frame = decodeDevRasterFrame(buffer), target = frame.presentationTicket.target
    if (target.sessionId !== captured.authority.sessionId || target.configGeneration !== captured.authority.configGeneration
      || target.previewGeneration !== captured.proof.epoch || target.previewId !== c.preview.ownerClientId) throw cancelled('Raster mirror bytes belong to another accepted owner')
    if (this.mirrorLatest) {
      const order = compareRasterU64(frame.frameId, this.mirrorLatest.target.frameId)
      if (order < 0) return
      if (order === 0) {
        if (!sameDevRasterTicket(frame.presentationTicket, this.mirrorLatest)) throw failure('ERR_PROTOCOL_VERSION', 'Raster mirror frame identity was reused')
        return
      }
    }
    this.mirrorLatest = frame.presentationTicket; this.mirrorPending = { c, captured, frame }
    if (this.mirrorScheduled) return
    const scheduled = { handle: null }; this.mirrorScheduled = scheduled
    scheduled.handle = this.scheduleFrame(() => {
      if (this.mirrorScheduled !== scheduled) return
      this.mirrorScheduled = null
      const pending = this.mirrorPending; this.mirrorPending = null
      if (!pending || !this.current(c) || !this.liveProof(c) || c.authority !== pending.captured.authority || c.proof !== pending.captured.proof || this.owner) return
      try {
        const context = this.canvas.getContext('2d'); if (!context) throw failure('ERR_RENDER', 'Canvas2D mirror context unavailable')
        if (this.canvas.width !== pending.frame.width) this.canvas.width = pending.frame.width
        if (this.canvas.height !== pending.frame.height) this.canvas.height = pending.frame.height
        context.putImageData(new ImageData(pending.frame.pixels, pending.frame.width, pending.frame.height), 0, 0)
        this.mirrorPresented = pending.frame.presentationTicket
        // Read-only RAF draw return: no owner binding, runtime ACK or input.
        this.emit('readonly')
      } catch (error) { this.report(error); this.emit('error') }
    })
  }
  events(events) { return this.inputEnabled ? this.presenter.events(events) : Promise.reject(cancelled('Raster preview does not own acknowledged input')) }
  retryPresentation() { return this.owner && this.presenter.retryPresentation() }
  disconnect(reason = 'Raster preview disconnected') { this.retire(this.connection, reason); this.emit('disconnected') }
  dispose() { if (!this.closed) { this.closed = true; this.retire(this.connection, 'Raster preview disposed'); this.presenter.dispose(); this.emit('disposed') } }
}
