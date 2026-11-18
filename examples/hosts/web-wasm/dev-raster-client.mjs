import { SseBridgeTransport } from './dom-session-client.mjs'
import { compareRasterU64, decodeDevRasterFrame, sameDevRasterTicket } from './dev-raster-frame.mjs'

const failure = (code, message) => Object.assign(new Error(message), { code })
const cancelled = message => Object.assign(failure('ERR_CANCELLED', message), { localCancellation: true })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const queuedAdmission = Object.freeze({ queued: true })
const bindingFields = ['sessionId', 'pageId', 'configGeneration', 'clientId', 'epoch', 'connectionToken']
const sameBinding = (a, b) => a && b && bindingFields.every(field => a[field] === b[field])
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function rasterHttpAdmission(response, checkCurrent) {
  let body = response
  if (typeof response?.json === 'function') {
    try { body = await response.json() }
    catch { throw failure('ERR_PROTOCOL_VERSION', 'Raster HTTP admission response is not valid JSON') }
    checkCurrent()
    if (!response.ok) throw failure(typeof body?.error?.code === 'string' ? body.error.code : 'ERR_RENDER', typeof body?.error?.message === 'string' ? body.error.message : `Raster HTTP admission failed: ${response.status}`)
  }
  if (body?.ok === false) throw failure(typeof body.error?.code === 'string' ? body.error.code : 'ERR_RENDER', typeof body.error?.message === 'string' ? body.error.message : 'Raster HTTP admission failed')
  if (!record(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'queued') || body.queued !== true) throw failure('ERR_PROTOCOL_VERSION', 'Raster HTTP requires a queued admission receipt; final responses belong to SSE')
  // The shared transport also supports legacy HTTP finals. Never pass the
  // original HTTP object into that channel, even after validating its shape.
  return queuedAdmission
}

function binding(value) {
  if (value === null || typeof value !== 'object' || Object.keys(value).length !== bindingFields.length
    || !bindingFields.every(field => Object.hasOwn(value, field))
    || typeof value.sessionId !== 'string' || !value.sessionId || textEncoder.encode(value.sessionId).byteLength > 256
    || textDecoder.decode(textEncoder.encode(value.sessionId)) !== value.sessionId
    || typeof value.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.clientId)
    || typeof value.connectionToken !== 'string' || !value.connectionToken || value.connectionToken.length > 85
    || !/^[\x21-\x7e]+$/.test(value.connectionToken)) throw failure('ERR_PROTOCOL_VERSION', 'invalid committed Raster preview binding')
  for (const field of ['pageId', 'configGeneration', 'epoch']) {
    compareRasterU64(value[field], value[field])
    if (value[field] === '0') throw failure('ERR_PROTOCOL_VERSION', 'Raster preview binding must be active')
  }
  return Object.freeze({ ...value })
}

const matches = (ticket, value) => ticket.target.sessionId === value.sessionId
  && ticket.target.previewId === value.clientId && ticket.target.previewGeneration === value.epoch
  && ticket.target.configGeneration === value.configGeneration

/** Canvas2D drawing/ACK/input transaction for the explicit developer profile.
 * The host owns its real SSE connection, bounded frame fetcher and heartbeat
 * handshake. It must call setBinding ONLY after the matching final heartbeat
 * result commits that exact token/epoch; preview-init or HTTP 202 is insufficient.
 * This client does not establish socket ownership. The server independently
 * checks its actual connection and runtime-issued ticket on every operation.
 * Nothing in this module enables the ordinary simulator UI or CLI profile.
 */
export class DevRasterPresenterClient {
  constructor({ canvas, send, scheduleFrame = callback => requestAnimationFrame(callback), cancelFrame = handle => cancelAnimationFrame(handle), onState, onDiagnostic, timeoutMs = 5000, maxPresentationAttempts = 2 } = {}) {
    if (typeof canvas?.getContext !== 'function' || typeof scheduleFrame !== 'function' || typeof cancelFrame !== 'function'
      || !Number.isInteger(maxPresentationAttempts) || maxPresentationAttempts < 1 || maxPresentationAttempts > 3) throw failure('ERR_PROTOCOL_VERSION', 'invalid Raster presenter configuration')
    this.canvas = canvas; this.scheduleFrame = scheduleFrame; this.cancelFrame = cancelFrame
    this.onState = onState; this.onDiagnostic = onDiagnostic; this.maxPresentationAttempts = maxPresentationAttempts
    this.binding = null; this.closed = false; this.latest = null; this.pending = null; this.accepted = null
    this.scheduled = null; this.presenting = false; this.attempts = 0; this.ackController = null
    const sendWire = send ?? ((envelope, { signal }) => fetch('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal }))
    this.transport = new SseBridgeTransport({ session: () => this.binding?.sessionId, timeoutMs,
      send: async (envelope, { signal, hostContext }) => {
        const captured = hostContext?.binding, ticket = hostContext?.ticket
        if (signal.aborted || this.closed || this.binding !== captured
          || (ticket && (!this.latest || !sameDevRasterTicket(this.latest.presentationTicket, ticket)))
          || (hostContext?.input && (!this.inputEnabled || !sameDevRasterTicket(this.accepted, ticket)))) throw cancelled('Raster request was superseded before sending')
        const response = await sendWire({ ...envelope, preview: { clientId: captured.clientId, epoch: captured.epoch, connectionToken: captured.connectionToken } }, { signal })
        const checkCurrent = () => {
          if (signal.aborted || this.closed || this.binding !== captured) throw cancelled('Raster HTTP admission belongs to a retired binding')
        }
        checkCurrent()
        return rasterHttpAdmission(response, checkCurrent)
      }, onDiagnostic: value => this.report(value) })
    this.transport.disconnect('Raster preview has no committed connection')
  }

  get inputEnabled() { return !this.closed && this.binding !== null && this.accepted !== null && this.latest !== null && sameDevRasterTicket(this.accepted, this.latest.presentationTicket) }
  report(error) { try { this.onDiagnostic?.(error) } catch { /* Diagnostics never authorize input. */ } }
  state(phase) {
    try { this.onState?.({ phase, inputEnabled: this.inputEnabled, presentationTicket: this.latest?.presentationTicket ?? null }) }
    catch (error) { this.report(error) }
  }
  clear(reason) {
    const scheduled = this.scheduled
    this.binding = null
    this.scheduled = null; this.pending = null; this.latest = null; this.accepted = null; this.attempts = 0
    this.ackController?.abort(); this.ackController = null
    this.transport.disconnect(reason)
    if (scheduled !== null) { try { this.cancelFrame(scheduled) } catch (error) { this.report(error) } }
  }

  setBinding(value) {
    if (this.closed) throw cancelled('Raster presenter is disposed')
    const next = binding(value)
    if (sameBinding(this.binding, next)) return false
    this.clear('Raster preview binding replaced')
    this.binding = next
    this.transport.reconnect(next.sessionId)
    this.state('waiting-frame')
    return true
  }
  disconnect(reason = 'Raster SSE connection disconnected') {
    this.clear(reason); this.binding = null; this.state('disconnected')
  }
  dispose() {
    if (this.closed) return
    this.closed = true
    this.disconnect('Raster presenter disposed'); this.transport.dispose()
  }
  receive(batch) { return this.transport.receive(batch) }

  /** Capture before starting a frame fetch. The original local references must
   * accompany its response; a page/token change cannot relabel a late fetch. */
  captureFrameRequest() {
    if (this.closed || !this.binding) throw cancelled('Raster preview has no committed connection')
    return Object.freeze({ client: this, binding: this.binding })
  }
  blockCurrentFrame() {
    const scheduled = this.scheduled
    this.scheduled = null; this.pending = null; this.accepted = null
    this.ackController?.abort()
    if (scheduled !== null) { try { this.cancelFrame(scheduled) } catch (error) { this.report(error) } }
    this.state('invalid-frame')
  }
  offer(buffer, capturedRequest) {
    if (this.closed || !this.binding || capturedRequest?.client !== this || capturedRequest.binding !== this.binding) throw cancelled('Raster frame fetch belongs to a retired local binding')
    let frame
    try { frame = decodeDevRasterFrame(buffer) }
    catch (error) { this.blockCurrentFrame(); throw error }
    if (!matches(frame.presentationTicket, this.binding)) throw cancelled('Raster frame belongs to another preview binding')
    if (this.latest) {
      const order = compareRasterU64(frame.frameId, this.latest.frameId)
      if (order < 0) return false
      if (order === 0) {
        if (!sameDevRasterTicket(frame.presentationTicket, this.latest.presentationTicket)) {
          this.blockCurrentFrame()
          throw failure('ERR_PROTOCOL_VERSION', 'Raster transport frame identity was reused')
        }
        return false
      }
    }
    this.ackController?.abort()
    this.accepted = null; this.latest = frame; this.pending = frame; this.attempts = 0
    this.state('waiting-draw'); this.schedule()
    return true
  }
  schedule() {
    if (this.closed || !this.binding || this.presenting || !this.pending || this.scheduled !== null) return
    this.scheduled = this.scheduleFrame(() => { this.scheduled = null; void this.present() })
  }
  current(frame, captured) { return !this.closed && this.binding === captured && this.latest === frame }

  async present() {
    if (this.presenting || !this.pending || !this.binding || this.closed) return
    const frame = this.pending, captured = this.binding
    this.pending = null; this.presenting = true; this.attempts++
    const controller = new AbortController(); this.ackController = controller
    try {
      if (!this.current(frame, captured)) return
      const context = this.canvas.getContext('2d')
      if (!context) throw failure('ERR_RENDER', 'Canvas2D context is unavailable')
      if (this.canvas.width !== frame.width) this.canvas.width = frame.width
      if (this.canvas.height !== frame.height) this.canvas.height = frame.height
      context.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0)
      if (!this.current(frame, captured)) return
      this.state('waiting-ack')
      const ticket = frame.presentationTicket
      const result = await this.transport.request('dev.raster.presented', {
        presentationTicket: ticket, draw: { endpoint: 'canvas2d-raf-draw-return' },
      }, { signal: controller.signal, sessionId: captured.sessionId, hostContext: { binding: captured, ticket } })
      if (!this.current(frame, captured) || controller.signal.aborted) return
      if (!sameDevRasterTicket(result.presentationTicket, ticket) || typeof result.inputEnabled !== 'boolean') throw failure('ERR_PROTOCOL_VERSION', 'Raster ACK did not return the exact presentation ticket')
      this.accepted = result.inputEnabled ? ticket : null
      // Drawing returned inside RAF and the owner accepted its exact receipt.
      // Browser compositor/GPU completion has not been measured here.
      this.state(result.inputEnabled ? 'accepted' : 'superseded')
    } catch (error) {
      if (this.current(frame, captured)) {
        this.accepted = null
        this.state(error.localCancellation ? 'cancelled' : 'presentation-error')
        this.report(error)
      }
    } finally {
      if (this.ackController === controller) this.ackController = null
      this.presenting = false; this.schedule()
    }
  }

  /** Explicit bounded retry after timeout/error, reusing the original issued
   * ticket. No new authority is inferred and no automatic retry loop runs. */
  retryPresentation() {
    if (this.closed || !this.binding || !this.latest || this.inputEnabled || this.presenting || this.pending
      || this.attempts >= this.maxPresentationAttempts) return false
    this.pending = this.latest; this.state('waiting-draw'); this.schedule(); return true
  }

  events(events) {
    if (!this.inputEnabled) return Promise.reject(cancelled('Raster input waits for the exact final ACK'))
    const captured = this.binding, ticket = this.accepted
    return this.transport.request('event.batch', { events, logicalViewport: { width: ticket.target.logicalWidth, height: ticket.target.logicalHeight }, presentationTicket: ticket }, {
      sessionId: captured.sessionId, hostContext: { binding: captured, ticket, input: true },
    })
  }
}
