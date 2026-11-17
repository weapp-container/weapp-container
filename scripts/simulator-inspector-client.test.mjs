import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { encodeFrame, presentationFixture } from './simulator-client-binary-fixture.mjs'

const html = readFileSync(new URL('../crates/container-simulator/src/web-ui.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))

// Run the actual shipped inspector handlers, with a deferred HTTP body so
// submission/SSE races are deterministic and never borrow a browser or port.
async function client({ bridgeStatus = 200 } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: '', style: { display: id === 'overlay' ? 'none' : '' },
    value: id === 'bridge' ? html.match(/<textarea id="bridge">([\s\S]*?)<\/textarea>/)[1] : '',
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener) },
    getContext() { return { putImageData() {} } },
  }]))
  const events = new Map()
  const submissions = []
  const prettyPrints = []
  let stream
  const initial = {
    status: 'ready', sessionId: 'inspector-session', route: 'pages/home/index',
    lifecycleState: 'Active', revision: 1, traceCount: 4, diagnostics: [],
    diagnosticHistory: { schemaVersion: 1, records: [], totalRecords: 0, droppedRecords: 0, complete: true },
    engine: 'quickjs', renderer: 'skia-raster', webRenderer: 'software',
  }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: {
      getElementById(id) {
        assert.ok(nodes.has(id), `script references absent element #${id}`)
        return nodes.get(id)
      },
    },
    JSON: {
      parse: JSON.parse,
      stringify(value, replacer, space) {
        if (space === 2) prettyPrints.push(value)
        return JSON.stringify(value, replacer, space)
      },
    },
    ImageData: class {}, TextEncoder, TextDecoder, MessageEvent,
    EventSource: class {
      constructor(url) { assert.equal(url, '/api/events'); stream = this }
      addEventListener(type, listener) { events.set(type, listener) }
      close() {}
    },
    fetch(url, options) {
      if (url === '/api/state') return Promise.resolve({ ok: true, json: async () => initial })
      if (url === '/api/presentation') return Promise.resolve({ ok: true, json: async () => presentationFixture })
      if (url === '/api/frame') return Promise.resolve({
        ok: true, status: 200,
        arrayBuffer: async () => encodeFrame({ width: 1, height: 1, pixels: [0, 0, 0, 255] }),
      })
      assert.equal(url, '/api/bridge')
      assert.equal(options.method, 'POST')
      assert.equal(options.headers['content-type'], 'application/json')
      let completeBody
      const body = new Promise(resolve => { completeBody = resolve })
      submissions.push({
        request: JSON.parse(options.body),
        complete(value) { completeBody(JSON.stringify(value)) },
      })
      // Headers can arrive immediately while the response body is delayed.
      // The runtime's separate SSE connection may complete in either order.
      return Promise.resolve({ ok: bridgeStatus >= 200 && bridgeStatus < 300, status: bridgeStatus, text: () => body })
    },
  })
  await tick()
  return {
    nodes, submissions, initial, prettyPrints,
    click() { return nodes.get('send').onclick() },
    event(type, payload) {
      assert.ok(events.has(type), `client must subscribe to ${type}`)
      const event = new MessageEvent(type, { data: JSON.stringify(payload) })
      events.get(type)(event)
      // Browser dispatch invokes both listeners and the corresponding IDL
      // handler. A custom `event: error` still carries a MessageEvent.
      stream[`on${type}`]?.(event)
    },
    disconnect() {
      const event = new Event('error')
      events.get('error')(event)
      stream.onerror?.(event)
    },
    content(id) { return nodes.get(id).textContent },
  }
}

const acknowledgement = { queued: true }
const runtimeBatch = request => ({ messages: [{
  protocolVersion: '1.0', sessionId: request.sessionId, requestId: request.requestId,
  kind: 'response', op: request.op, payload: { ok: true, accepted: true },
}] })

test('inspector HTTP acknowledgement and queued SSE never impersonate a runtime response', async () => {
  const c = await client()
  const sending = c.click()
  const submission = c.submissions[0]
  assert.equal(submission.request.sessionId, c.initial.sessionId)
  assert.equal(submission.request.op, 'diagnostic')
  c.event('bridge', acknowledgement)
  submission.complete(acknowledgement)
  await sending
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
  assert.equal(c.content('bridgeResult'), '')
  assert.equal(c.content('log'), '')
  const completed = runtimeBatch(submission.request)
  c.event('bridge', completed)
  c.event('state', { ...c.initial, traceCount: 5 })
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed)
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
})

test('inspector SSE runtime completion survives a later HTTP response body and queued notification', async () => {
  const c = await client()
  const sending = c.click()
  const submission = c.submissions[0]
  await tick()
  const completed = runtimeBatch(submission.request)
  c.event('bridge', completed)
  c.event('state', { ...c.initial, traceCount: 5 })
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed)
  submission.complete(acknowledgement)
  await sending
  c.event('bridge', acknowledgement)
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed,
    'submission receipts cannot overwrite an already completed runtime batch')
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
})

test('inspector runtime errors, recovery and diagnostic history retain bridge evidence', async () => {
  const c = await client()
  const sending = c.click()
  const submission = c.submissions[0]
  const failed = runtimeBatch(submission.request)
  failed.messages[0].payload = { ok: false, error: { code: 'ERR_ENGINE', message: 'runtime failed' } }
  c.event('bridge', failed)
  const diagnostic = {
    schemaVersion: 1, revision: 1, phase: 'runtime', severity: 'error',
    code: 'ERR_ENGINE', file: null, message: 'runtime failed', stack: null, timestamp: '1',
  }
  c.event('diagnostic', diagnostic)
  c.event('error', diagnostic)
  submission.complete(acknowledgement)
  await sending
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.equal(c.content('status'), 'error', 'application error events cannot impersonate a disconnected SSE transport')
  assert.match(c.content('overlay'), /runtime failed/)
  assert.match(c.content('log'), /ERR_ENGINE: runtime failed/)
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), failed)
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
  // The supervisor clears active diagnostics in state before announcing the
  // successful generation. The retained history remains server-owned evidence.
  c.event('state', {
    ...c.initial, revision: 2, traceCount: 6, diagnostics: [],
    diagnosticHistory: {
      schemaVersion: 1, records: [diagnostic], totalRecords: 1, droppedRecords: 0, complete: true,
    },
  })
  c.event('reload', { revision: 2, kind: 'InPlace', report: { traceCount: 6 } })
  assert.equal(c.nodes.get('overlay').style.display, 'none')
  assert.equal(c.content('status'), 'ready')
  assert.match(c.content('log'), /ERR_ENGINE: runtime failed/, 'recovery must preserve diagnostic history')
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), failed)
})

test('inspector distinguishes an application error from a real disconnect without hiding its diagnostic', async () => {
  const c = await client()
  c.event('error', { message: 'standalone runtime error' })
  assert.equal(c.content('status'), 'error')
  assert.equal(c.content('overlay'), 'standalone runtime error')

  const diagnostic = {
    revision: 1, phase: 'runtime', severity: 'error', code: 'ERR_ENGINE',
    message: 'retain this runtime diagnostic', timestamp: '1',
  }
  c.event('diagnostic', diagnostic)
  c.disconnect()
  assert.equal(c.content('status'), 'disconnected', 'a true transport error must still show loss of connection')
  assert.equal(c.content('overlay'), diagnostic.message, 'an event without message data cannot replace an active runtime diagnostic')
  c.event('state', { ...c.initial, revision: 2, diagnostics: [] })
  c.event('reload', { revision: 2 })
  assert.equal(c.content('status'), 'ready')
  assert.equal(c.nodes.get('overlay').style.display, 'none')
})

test('inspector terminal shutdown cannot be cleared by a delayed successful HTTP submission', async () => {
  const c = await client()
  const sending = c.click()
  const submission = c.submissions[0]
  const completed = runtimeBatch(submission.request)
  c.event('bridge', completed)
  c.event('shutdown', { reason: 'watch process exited' })
  submission.complete(acknowledgement)
  await sending
  assert.equal(c.content('status'), 'stopped')
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.match(c.content('overlay'), /watch process exited/)
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed)
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
})

test('inspector HTTP submission failure shows transport evidence without manufacturing a runtime result', async () => {
  const c = await client({ bridgeStatus: 503 })
  const sending = c.click()
  c.submissions[0].complete({ error: 'queue unavailable' })
  await sending
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.match(c.content('overlay'), /BRIDGE_FAILED:.*queue unavailable/)
  assert.deepEqual(JSON.parse(c.content('submission')), { error: 'queue unavailable' })
  assert.equal(c.content('bridgeResult'), '')
  assert.equal(c.content('log'), '', 'a transport acknowledgement does not alter retained runtime diagnostics')
})

test('inspector new submissions clear stale completion while preserving the editable active-session draft', async () => {
  const c = await client()
  const first = c.click()
  c.submissions[0].complete(acknowledgement)
  await first
  c.event('bridge', runtimeBatch(c.submissions[0].request))
  const draft = JSON.parse(c.nodes.get('bridge').value)
  draft.payload = { message: 'keep this payload' }
  draft.requestId = 'custom-request'
  c.nodes.get('bridge').value = JSON.stringify(draft)
  c.event('state', { ...c.initial, sessionId: 'inspector-session-reloaded', revision: 2 })
  const second = c.click()
  assert.equal(c.content('bridgeResult'), '')
  assert.equal(c.content('submission'), 'Submitting…')
  assert.equal(c.submissions[1].request.sessionId, 'inspector-session-reloaded')
  assert.equal(c.submissions[1].request.requestId, 'custom-request')
  assert.deepEqual(c.submissions[1].request.payload, draft.payload)
  c.submissions[1].complete(acknowledgement)
  await second
  assert.equal(c.content('bridgeResult'), '', 'each submission waits for its own runtime batch')
})


test('inspector ignores automatic input and unidentified receipts without pretty-printing their payloads', async () => {
  const c = await client()
  const automaticRequest = {
    protocolVersion: '1.0', sessionId: c.initial.sessionId,
    requestId: 'web-input-1', kind: 'request', op: 'event.batch', payload: {},
  }
  const automatic = runtimeBatch(automaticRequest)
  automatic.messages[0].payload = { events: Array.from({ length: 1000 }, (_, index) => ({ index })) }
  const beforeAnySend = c.prettyPrints.length
  c.event('bridge', automatic)
  c.event('bridge', { queued: true, ...automaticRequest })
  assert.equal(c.content('submission'), '')
  assert.equal(c.content('bridgeResult'), '')
  assert.equal(c.prettyPrints.length, beforeAnySend, 'observing automatic input must not format it for the inspector')

  const sending = c.click()
  const submission = c.submissions[0]
  submission.complete({ queued: true, source: 'manual HTTP receipt' })
  await sending
  const completed = runtimeBatch(submission.request)
  c.event('bridge', completed)
  const expectedResult = c.content('bridgeResult')
  const expectedSubmission = c.content('submission')
  const beforeAutomatic = c.prettyPrints.length
  c.event('bridge', automatic)
  c.event('bridge', { queued: true, ...automaticRequest })
  c.event('bridge', { queued: true })
  assert.equal(c.content('bridgeResult'), expectedResult, 'automatic input cannot replace the manual runtime evidence')
  assert.equal(c.content('submission'), expectedSubmission, 'unrelated or unidentified receipts cannot replace the owned HTTP receipt')
  assert.equal(c.prettyPrints.length, beforeAutomatic, 'ignored SSE payloads must not incur pretty-print DOM work')
})

test('inspector correlates only the latest manual session, request and operation across delayed responses', async () => {
  const c = await client()
  const first = c.click()
  const firstSubmission = c.submissions[0]
  const draft = { ...firstSubmission.request, requestId: 'manual-new', op: 'api.call' }
  c.nodes.get('bridge').value = JSON.stringify(draft)
  const second = c.click()
  const secondSubmission = c.submissions[1]
  const beforeIgnored = c.prettyPrints.length
  c.event('bridge', runtimeBatch(firstSubmission.request))
  c.event('bridge', { queued: true, ...firstSubmission.request })
  firstSubmission.complete({ queued: true, marker: 'old HTTP body' })
  await first
  assert.equal(c.content('submission'), 'Submitting…')
  assert.equal(c.content('bridgeResult'), '')
  for (const changed of [
    { sessionId: 'unrelated-session' },
    { requestId: 'unrelated-request' },
    { op: 'unrelated.operation' },
    { kind: 'request' },
  ]) {
    const batch = runtimeBatch(secondSubmission.request)
    Object.assign(batch.messages[0], changed)
    c.event('bridge', batch)
  }
  assert.equal(c.content('bridgeResult'), '')
  assert.equal(c.prettyPrints.length, beforeIgnored)

  const receipt = { queued: true, ...secondSubmission.request }
  c.event('bridge', receipt)
  assert.deepEqual(JSON.parse(c.content('submission')), receipt)
  const completed = runtimeBatch(secondSubmission.request)
  c.event('bridge', completed)
  secondSubmission.complete(acknowledgement)
  await second
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed)
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
})

test('inspector restart invalidates pending correlation even when a new session reuses requestId and op', async () => {
  const c = await client()
  const first = c.click()
  const firstSubmission = c.submissions[0]
  c.event('state', { ...c.initial, revision: 2, sessionId: 'inspector-restarted' })
  const beforeIgnored = c.prettyPrints.length
  firstSubmission.complete({ queued: true, marker: 'before restart' })
  await first
  c.event('bridge', runtimeBatch(firstSubmission.request))
  assert.equal(c.content('bridgeResult'), '')
  assert.equal(c.content('submission'), 'Submitting…', 'restart cannot turn an obsolete HTTP response into current evidence')
  assert.equal(c.prettyPrints.length, beforeIgnored)

  const second = c.click()
  const secondSubmission = c.submissions[1]
  assert.equal(secondSubmission.request.requestId, firstSubmission.request.requestId)
  assert.equal(secondSubmission.request.op, firstSubmission.request.op)
  assert.equal(secondSubmission.request.sessionId, 'inspector-restarted')
  c.event('bridge', runtimeBatch(firstSubmission.request))
  assert.equal(c.content('bridgeResult'), '')
  const completed = runtimeBatch(secondSubmission.request)
  c.event('bridge', completed)
  secondSubmission.complete(acknowledgement)
  await second
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed)
})

test('inspector manual batch tracks every requestId and keeps its editable sessions current', async () => {
  const c = await client()
  const firstRequest = JSON.parse(c.nodes.get('bridge').value)
  const secondRequest = { ...firstRequest, requestId: 'manual-two', op: 'api.call' }
  c.nodes.get('bridge').value = JSON.stringify({ messages: [firstRequest, secondRequest] })
  c.event('state', { ...c.initial, revision: 2, sessionId: 'batch-restarted' })
  const sending = c.click()
  const submission = c.submissions[0]
  assert.deepEqual(submission.request.messages.map(message => message.sessionId), ['batch-restarted', 'batch-restarted'])
  assert.deepEqual(submission.request.messages.map(message => message.requestId), [firstRequest.requestId, 'manual-two'])
  for (const request of submission.request.messages) {
    const completed = runtimeBatch(request)
    c.event('bridge', completed)
    assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed, 'each request in a valid manual batch owns its completion')
  }
  const completedBatch = { messages: submission.request.messages.flatMap(request => runtimeBatch(request).messages) }
  c.event('bridge', completedBatch)
  submission.complete(acknowledgement)
  await sending
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completedBatch)
  const beforeAutomatic = c.prettyPrints.length
  c.event('bridge', runtimeBatch({ ...submission.request.messages[0], requestId: 'web-input-99', op: 'event.batch' }))
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completedBatch)
  assert.equal(c.prettyPrints.length, beforeAutomatic)
})
