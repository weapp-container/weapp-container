import { DomViewError } from './dom-presenter.mjs'
import { SseBridgeTransport } from './dom-session-client.mjs'
import { WORKER_RPC_VERSION } from './worker-session-client.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.length > 0
const protocolError = message => new DomViewError('ERR_PROTOCOL_VERSION', message)
const stopped = message => Object.assign(new DomViewError('ERR_CANCELLED', message), { localCancellation: true })
const structuredError = value => record(value) && nonempty(value.code) && typeof value.message === 'string'
// Runtime retirement/timer failures are response-shaped diagnostics with no
// request ID. They carry effects/errors, never request or input authority.
const runtimeDiagnostic = message => message.kind === 'response' && message.requestId === ''
  && message.op === 'error' && message.payload?.queued !== true && message.payload?.ok === false
  && structuredError(message.payload.error)

function normalizeFailure(error) {
  if (error?.code !== 'ERR_RPC_TIMEOUT' && error?.code !== 'ERR_RPC_CANCELLED') return error
  const failure = error.code === 'ERR_RPC_TIMEOUT'
    ? new DomViewError('ERR_TIMEOUT', error.message)
    : stopped(error.message)
  failure.cause = error
  return failure
}

/** One DOM bridge over an existing, exclusively owned Worker RPC session.
 *
 * The shared SseBridgeTransport still owns inner request correlation, finite
 * deadlines and retired view.prepare cleanup. This adapter never constructs a
 * runtime and never closes the borrowed RPC client. Its owner feeds unsolicited
 * Worker batch events to receiveBatch(), then disposes this adapter before
 * closing the Worker. Each outer request retains its own late-response closure;
 * a late final can only reach that exact inner request, never a new operation.
 */
export class WorkerBridgeTransport {
  constructor({ rpc, timeoutMs = 5000, maxPending = 64, onDiagnostic } = {}) {
    if (!rpc || typeof rpc.requestHost !== 'function'
      || !nonempty(rpc.sessionId) || !nonempty(rpc.workerEpoch)) {
      throw protocolError('Worker bridge requires a session-bound WorkerRpcClient')
    }
    if (!Number.isSafeInteger(maxPending) || maxPending < 2 || maxPending > 1024) {
      throw protocolError('Worker bridge needs 2..1024 inner slots, including an abort reserve')
    }
    this.rpc = rpc
    this.ordinaryLimit = maxPending - 1
    Object.defineProperties(this, {
      sessionId: { value: rpc.sessionId, enumerable: true },
      workerEpoch: { value: rpc.workerEpoch, enumerable: true },
    })
    this.inner = new SseBridgeTransport({ sessionId: this.sessionId, timeoutMs, maxPending, onDiagnostic,
      send: (envelope, options) => this._send(envelope, options) })
  }

  get closed() { return this.inner.closed }
  get connected() { return this.inner.connected }
  get pendingCount() { return this.inner.pending.size }
  get retiredCount() { this.inner.pruneRetired(); return this.inner.retired.size }
  currentSession() { return this.sessionId }

  setSession(sessionId) {
    if (sessionId !== this.sessionId) throw protocolError('create a new Worker bridge for a different session')
    this.inner.setSession(sessionId)
  }

  request(op, payload, options) {
    try {
      // The borrowed RPC has its own control reserve. Preserve one inner slot
      // too, or a saturated correlation table would block the owner alias
      // before it could reach that reserved RPC lane.
      if (!['view.abort', 'view.sample.abort'].includes(op) && !this.closed && this.connected && this.pendingCount >= this.ordinaryLimit) {
        return Promise.reject(new DomViewError('ERR_RENDER', 'Worker bridge ordinary request queue full'))
      }
      return this.inner.request(op, payload, options)
    }
    catch (error) { return Promise.reject(error) }
  }

  _batch(batch) {
    if (!record(batch) || !Array.isArray(batch.messages)) throw protocolError('Worker result must contain a BridgeBatch')
    for (const message of batch.messages) {
      if (!record(message) || message.protocolVersion !== '1.0' || message.sessionId !== this.sessionId
        || !['response', 'event'].includes(message.kind) || !nonempty(message.op)
        || typeof message.requestId !== 'string'
        || (message.kind === 'response' && (!record(message.payload)
          || (!nonempty(message.requestId) && !runtimeDiagnostic(message))))) {
        throw protocolError('Worker BridgeBatch contains an invalid session, protocol or envelope')
      }
      if (message.kind === 'response' && message.payload.queued !== true
        && (typeof message.payload.ok !== 'boolean' || (message.payload.ok === false
          && !structuredError(message.payload.error)))) {
        throw protocolError('Worker runtime final has no valid success or structured error')
      }
    }
    return batch
  }

  _result(batch, envelope, alias) {
    this._batch(batch)
    const responses = batch.messages.filter(message => message.kind === 'response' && !runtimeDiagnostic(message))
    if (alias) {
      // The owner alias generates its own inner requestId. It must return a
      // genuine, unique runtime final for view.abort before this one explicit
      // identifier translation. An outer ok/queued receipt grants no success.
      if (responses.length !== 1 || responses[0].op !== envelope.op
        || responses[0].payload.queued === true || typeof responses[0].payload.ok !== 'boolean') {
        throw protocolError('Worker abort alias must return one final runtime response for its operation')
      }
      return { ...batch, messages: batch.messages.map(message => message === responses[0]
        ? { ...message, requestId: envelope.requestId } : message) }
    }
    if (!responses.length || responses.some(message => message.requestId !== envelope.requestId || message.op !== envelope.op)
      || responses.filter(message => message.payload.queued !== true).length > 1
      || responses.some(message => message.payload.queued !== true && typeof message.payload.ok !== 'boolean')) {
      throw protocolError('Worker bridge final does not identify its exact inner request')
    }
    return batch
  }

  _late(message, envelope, outerOp, alias) {
    if (this.closed) return 0
    // WorkerRpcClient invokes this closure only for this exact retired outer
    // requestId. Check the remaining outer boundary again before forwarding
    // the independently correlated runtime batch to the inner transport.
    if (!record(message) || message.version !== WORKER_RPC_VERSION || message.kind !== 'response'
      || message.workerEpoch !== this.workerEpoch || message.sessionId !== this.sessionId
      || !nonempty(message.requestId) || message.op !== outerOp || !record(message.payload)) {
      throw protocolError('late Worker final belongs to another session or operation')
    }
    if (message.payload.status === 'queued') return 0
    if (message.payload.status === 'error') {
      if (!record(message.payload.error) || !nonempty(message.payload.error.code)
        || typeof message.payload.error.message !== 'string') throw protocolError('invalid late Worker error')
      this.inner.report(message.payload.error)
      return 0
    }
    if (message.payload.status !== 'ok') throw protocolError('late Worker response is not a final result')
    return this.inner.receive(this._result(message.payload.result, envelope, alias))
  }

  async _send(envelope, { signal, hostContext } = {}) {
    if (this.closed || !this.connected) throw stopped('Worker bridge is disconnected or disposed')
    const alias = ['view.abort', 'view.sample.abort'].includes(envelope.op)
    const outerOp = alias ? envelope.op : 'bridge'
    try {
      const context = hostContext?.presentationContext
      const batch = await this.rpc.requestHost(outerOp, { ...(alias ? envelope.op === 'view.abort' ? { key: envelope.payload } : envelope.payload : { envelope,
        ...(envelope.op === 'event.batch' && hostContext?.inputTiming ? { inputTiming: hostContext.inputTiming } : {}) }),
        ...(context === undefined ? {} : { presentationContext: context }) }, {
        signal, onLateResponse: message => this._late(message, envelope, outerOp, alias),
      })
      return this._result(batch, envelope, alias)
    } catch (error) { throw normalizeFailure(error) }
  }

  /** Feed only the BridgeBatch payload of a session-bound Worker batch event.
   * Events and queued responses cannot settle requests or grant input authority.
   */
  receiveBatch(batch) {
    if (this.closed || !this.connected) return 0
    return this.inner.receive(this._batch(batch))
  }

  disconnect(reason = 'Worker bridge disconnected') { this.inner.disconnect(reason) }
  reconnect(sessionId = this.sessionId) {
    if (sessionId !== this.sessionId) throw protocolError('cannot reconnect a Worker bridge to a different session')
    this.inner.reconnect(sessionId)
  }
  dispose() { this.inner.dispose() }
}
