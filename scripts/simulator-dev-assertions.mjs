/** Assertions for development smoke evidence; no runtime behavior lives here. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Require one successful acknowledgement of this exact diagnostic request.
 * HTTP success, trace growth and a response-shaped ERR envelope are not proof
 * that the retained runtime accepted the request. Only top-level wire messages
 * may satisfy this assertion; historical/nested trace entries cannot do so.
 *
 * @returns {object} the uniquely correlated response envelope
 */
export function assertDiagnosticResponse(batch, request) {
  for (const field of ['sessionId', 'requestId', 'op']) {
    if (!record(request) || typeof request[field] !== 'string' || !request[field].trim()) {
      throw new Error(`diagnostic request requires a nonempty ${field}`)
    }
  }
  if (!record(batch) || !Array.isArray(batch.messages)) {
    throw new Error('diagnostic batch requires a messages array')
  }
  const identity = `${request.sessionId}/${request.requestId}/${request.op}`
  const related = batch.messages.filter(message => record(message) &&
    message.sessionId === request.sessionId && message.requestId === request.requestId)

  // Runtime failures use kind=response with payload.ok=false. Also reject
  // correlated error events even when a success response appears beside them.
  for (const message of related) {
    const payload = record(message.payload) ? message.payload : {}
    const errors = payload.errors != null &&
      (!Array.isArray(payload.errors) || payload.errors.length > 0)
    if (message.kind === 'error' || message.op === 'error' || payload.ok === false ||
        payload.error != null || errors || payload.level === 'error' || payload.severity === 'error') {
      throw new Error(`diagnostic request ${identity} returned an error: ${JSON.stringify(message.payload)}`)
    }
  }

  const responses = related.filter(message => message.kind === 'response')
  if (responses.length !== 1) {
    throw new Error(`diagnostic request ${identity} requires exactly one response; received ${responses.length}`)
  }
  const response = responses[0]
  if (response.op !== request.op) {
    throw new Error(`diagnostic response op mismatch for ${identity}: ${response.op}`)
  }
  if (!record(response.payload) || response.payload.ok !== true || response.payload.accepted !== true) {
    throw new Error(`diagnostic request ${identity} was not acknowledged with ok=true and accepted=true`)
  }
  return response
}
