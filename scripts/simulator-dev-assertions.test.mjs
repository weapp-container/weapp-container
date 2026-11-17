import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDiagnosticResponse } from './simulator-dev-assertions.mjs'

const request = {
  protocolVersion: '1.0', sessionId: 'retained-session', requestId: 'smoke-live-1',
  kind: 'request', op: 'diagnostic', payload: { message: 'still usable' },
}
const response = overrides => ({
  ...request, kind: 'response', payload: { ok: true, accepted: true }, ...overrides,
})
const batch = (...messages) => ({ messages })

test('accepts the unique exact acknowledgement and returns its envelope', () => {
  const accepted = response()
  assert.equal(assertDiagnosticResponse(batch(accepted), request), accepted)
})

test('rejects the actual runtime response-shaped structured ERR envelope', () => {
  // Session::error_envelope keeps request.op and uses kind=response.
  const failure = response({ payload: {
    ok: false, error: { code: 'ERR_CANCELLED', message: 'cancelled', requestId: request.requestId },
  } })
  assert.throws(() => assertDiagnosticResponse(batch(failure), request), /returned an error.*ERR_CANCELLED/)
  assert.throws(() => assertDiagnosticResponse(batch(response(), failure), request), /returned an error/)
})

test('rejects missing and duplicate responses', () => {
  assert.throws(() => assertDiagnosticResponse(batch(), request), /exactly one response; received 0/)
  assert.throws(() => assertDiagnosticResponse(batch(response(), response()), request), /exactly one response; received 2/)
})

test('other session, request id, operation and kind cannot impersonate the acknowledgement', () => {
  for (const overrides of [
    { sessionId: 'old-session' },
    { requestId: 'other-request' },
    { op: 'api.call' },
    { kind: 'event' },
    { kind: 'request' },
  ]) {
    assert.throws(() => assertDiagnosticResponse(batch(response(overrides)), request),
      /exactly one response|op mismatch/, JSON.stringify(overrides))
  }
})

test('one matching response plus a conflicting response cannot pass', () => {
  assert.throws(() => assertDiagnosticResponse(batch(response(), response({ op: 'api.call' })), request),
    /exactly one response; received 2/)
})

test('acknowledgement flags must be boolean true, not truthy or absent', () => {
  for (const payload of [
    null, {}, { ok: true }, { accepted: true },
    { ok: 1, accepted: true }, { ok: 'true', accepted: true },
    { ok: true, accepted: false }, { ok: true, accepted: 1 }, { ok: true, accepted: 'true' },
  ]) {
    assert.throws(() => assertDiagnosticResponse(batch(response({ payload })), request), /not acknowledged/,
      JSON.stringify(payload))
  }
  assert.throws(() => assertDiagnosticResponse(batch(response({ payload: { ok: false, accepted: true } })), request),
    /returned an error/)
})

test('correlated error events and error payloads invalidate a success response', () => {
  for (const failure of [
    response({ kind: 'event', op: 'error', payload: { code: 'ERR_ENGINE' } }),
    response({ kind: 'error', payload: { code: 'ERR_ENGINE' } }),
    response({ kind: 'event', payload: { ok: false } }),
    response({ kind: 'event', payload: { error: { code: 'ERR_ENGINE' } } }),
    response({ kind: 'event', payload: { errors: [{ message: 'handler failed' }] } }),
    response({ kind: 'event', payload: { level: 'error', message: 'handler failed' } }),
    response({ kind: 'event', payload: { severity: 'error', message: 'handler failed' } }),
  ]) {
    assert.throws(() => assertDiagnosticResponse(batch(response(), failure), request), /returned an error/,
      JSON.stringify(failure))
  }
})

test('unrelated errors and runtime trace events neither reject nor qualify as the acknowledgement', () => {
  const unrelated = [
    response({ sessionId: 'old-session', payload: { ok: false, error: { code: 'ERR_ENGINE' } } }),
    response({ requestId: 'other-request', payload: { ok: false } }),
    response({ kind: 'event', requestId: '', payload: { level: 'debug', message: 'render committed' } }),
    { kind: 'event', op: 'trace', payload: { response: batch(response()) } },
  ]
  const accepted = response()
  assert.equal(assertDiagnosticResponse(batch(...unrelated, accepted), request), accepted)
  assert.throws(() => assertDiagnosticResponse(batch(...unrelated), request), /exactly one response; received 0/)
})

test('historical or nested trace responses cannot substitute for a wire acknowledgement', () => {
  const trace = [{ request, response: batch(response()) }]
  assert.throws(() => assertDiagnosticResponse({ messages: [], trace, traceCount: 1 }, request),
    /exactly one response; received 0/)
  assert.throws(() => assertDiagnosticResponse({ trace, traceCount: 1 }, request), /messages array/)
})

test('rejects malformed identity and batch inputs without accidental matches', () => {
  for (const value of [null, {}, { messages: null }, { messages: {} }]) {
    assert.throws(() => assertDiagnosticResponse(value, request), /messages array/)
  }
  for (const field of ['sessionId', 'requestId', 'op']) {
    for (const value of [undefined, '', ' ', 1]) {
      assert.throws(() => assertDiagnosticResponse(batch(response()), { ...request, [field]: value }),
        new RegExp(`nonempty ${field}`))
    }
  }
  assert.throws(() => assertDiagnosticResponse(batch(null, 1, 'response'), request),
    /exactly one response; received 0/)
})
