import assert from 'node:assert/strict'
import test from 'node:test'
import { DomViewPresenter } from '../examples/hosts/web-wasm/dom-presenter.mjs'
import { DomSessionClient, SseBridgeTransport } from '../examples/hosts/web-wasm/dom-session-client.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const reply = (request, payload = { ok: true }) => ({ ...request, kind: 'response', payload })
const identity = { sessionId: 'session', revision: '1', surfaceGeneration: '0' }

test('transport captures host request context before the asynchronous send callback', async t => {
  const observed = [], context = { requestRevision: '1', previewEpoch: '4' }
  const transport = new SseBridgeTransport({ sessionId: 'session', send: (envelope, options) => {
    observed.push(options.hostContext)
    return { messages: [reply(envelope)] }
  } })
  t.after(() => transport.dispose())
  const result = transport.request('view.prepare', {}, { hostContext: context })
  context.requestRevision = '2'; context.previewEpoch = '5'
  await result
  assert.deepEqual(observed, [{ requestRevision: '1', previewEpoch: '4' }])
  assert.equal(Object.isFrozen(observed[0]), true)
})

test('SSE transport ignores queued, event, wrong-session and wrong-operation receipts and correlates out of order', async t => {
  const sent = [], transport = new SseBridgeTransport({ sessionId: 'session', timeoutMs: 1000, send: envelope => { sent.push(envelope); return { queued: true } } })
  t.after(() => transport.dispose())
  let complete = false
  const first = transport.request('view.prepare', { render: 1 }).then(value => { complete = true; return value })
  const second = transport.request('view.geometry', { nodes: [] })
  await tick()
  assert.equal(sent.length, 2); assert.equal(transport.pending.size, 2); assert.equal(complete, false)
  for (const receipt of [{ queued: true }, { ...reply(sent[0]), payload: { ok: true, queued: true } }, { ...reply(sent[0]), kind: 'event' }, { ...reply(sent[0]), sessionId: 'stale' }, { ...reply(sent[0]), op: 'view.presented' }]) assert.equal(transport.receive(receipt), 0)
  assert.equal(complete, false)
  assert.equal(transport.receive({ messages: [reply(sent[1], { ok: true, applied: 2 })] }), 1)
  assert.equal((await second).applied, 2); assert.equal(complete, false)
  const diagnostic = { protocolVersion: '1.0', sessionId: 'session', requestId: '', kind: 'event', op: 'diagnostic', payload: { message: 'ready warning' } }
  assert.equal(transport.receive({ messages: [reply(sent[0], { ok: true, submission: { key: 'runtime-owned' } }), diagnostic] }), 1)
  assert.deepEqual((await first).diagnostics, [diagnostic]); assert.equal(transport.pending.size, 0)
  assert.equal(transport.receive(reply(sent[0])), 0)
})

test('HTTP full batches, structured runtime errors and HTTP failures release transport requests', async t => {
  const transport = new SseBridgeTransport({ sessionId: 'session', send: async envelope => ({ ok: true, json: async () => ({ messages: [reply(envelope, { ok: true, value: 7 })] }) }) })
  t.after(() => transport.dispose())
  assert.equal((await transport.request('view.prepare', {})).value, 7)
  transport.send = envelope => ({ messages: [reply(envelope, { ok: false, error: { code: 'ERR_CANCELLED', message: 'stale key' }, diagnostics: [{ code: 'first' }, { code: 'second' }] })] })
  await assert.rejects(transport.request('view.geometry', {}), failure => failure.code === 'ERR_CANCELLED' && failure.diagnostics.length === 2)
  transport.send = async () => ({ ok: false, json: async () => ({ error: { code: 'ERR_RENDER', message: 'queue full' } }) })
  await assert.rejects(transport.request('view.prepare', {}), /queue full/)
  assert.equal(transport.pending.size, 0)
})

test('transport timeout, abort, bounded queue, session replacement and reconnect reject late responses', async t => {
  const sent = [], transport = new SseBridgeTransport({ sessionId: 'session', timeoutMs: 20, maxPending: 1, send: envelope => { sent.push(envelope); return { queued: true } } })
  t.after(() => transport.dispose())
  const timeout = assert.rejects(transport.request('view.prepare', {}), failure => failure.code === 'ERR_TIMEOUT')
  await assert.rejects(transport.request('view.geometry', {}), /queue full/)
  await timeout; assert.equal(transport.pending.size, 0)
  const controller = new AbortController(), aborted = assert.rejects(transport.request('view.prepare', {}, { signal: controller.signal }), /cancelled/)
  controller.abort(); await aborted
  const replaced = assert.rejects(transport.request('view.prepare', {}), /session replaced/)
  transport.setSession('next'); await replaced
  assert.equal(transport.receive(reply(sent[0])), 0)
  const disconnected = assert.rejects(transport.request('view.prepare', {}), /lost stream/)
  transport.disconnect('lost stream'); await disconnected
  await assert.rejects(transport.request('view.prepare', {}), /disconnected/)
  transport.reconnect('next')
  transport.send = envelope => ({ messages: [reply(envelope)] })
  assert.equal((await transport.request('view.prepare', {})).ok, true)
  transport.dispose(); assert.equal(transport.pending.size, 0)
})

function harness(t, { timeoutMs = 100, inputEnabled = true, expectDisposeFailure = false } = {}) {
  const calls = [], candidates = [], releases = [], diagnostics = [], states = [], hooks = new Map()
  let sequence = 0, currentSession = 'session'
  const image = { kind: 'element', occurrenceId: 'image', tag: 'image', attrs: { src: '../assets/pixel.png' }, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' }, events: [], children: [] }
  const submission = (render, surfaceGeneration, sessionId = currentSession) => {
    const revision = render.revision ?? ++sequence
    const document = { version: '1.0', sessionId, pageId: 1, revision, routePath: 'pages/home', profile: 'webview', nodes: [{ kind: 'element', occurrenceId: 'root', tag: 'view', attrs: {}, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' },
      events: [{ event: 'tap', handler: 'tap', phase: 'bubble', catch: false }, { event: 'input', handler: 'edit', phase: 'bubble', catch: false }], children: [image] }], styleRoots: [], styles: [], resources: [{ path: 'assets/pixel.png', sha256: 'a'.repeat(64), mime: 'image/png', size: 12 }] }
    const key = { sessionId, pageId: '1', documentRevision: String(revision), presentationRevision: String(++sequence), surfaceGeneration, profile: 'webview' }
    return { version: '1.0', key, viewport: { width: 375, height: 667 }, document }
  }
  const presenter = new DomViewPresenter({ ownerDocument: {}, append() {} }, { timeoutMs, resolveResource: async () => ({ url: `blob:owned-${candidates.length}`, release: () => releases.push(candidates.length) }) })
  presenter.createCandidate = async () => {
    const candidate = { connected: true, visible: false, interactive: false, activationHistory: [], disposed: false, disposeCount: 0, supports: () => true, validateSelector() {},
      async populate(plan) { candidate.plan = plan }, snapshot() { return new Map() }, restore() {},
      isConnected() { return candidate.connected && !candidate.disposed }, setVisible(value) { candidate.visible = value }, setInteractive(value) { candidate.interactive = value; candidate.activationHistory.push(value) },
      measure() { return [...candidate.plan.tables.nodes.keys()].map(occurrenceId => ({ occurrenceId, x: 0, y: 0, width: 100, height: 50, scrollTop: candidate.scrollTop ?? 0, scrollHeight: 300, clientHeight: 50 })) },
      measureViewportScroll() { return { x: 3, y: candidate.viewportScrollY ?? 0 } },
      measureViewportExtent() { return { width: 700, height: candidate.viewportScrollHeight ?? 900 } },
      activate(send) { candidate.send = send }, dispose() { if (candidate.disposed) return []; candidate.disposeCount++; candidate.disposed = true; candidate.interactive = false; return candidate.plan?.dispose() ?? [] } }
    candidates.push(candidate); return candidate
  }
  const transport = {
    setSession(value) { currentSession = value }, disconnect() {}, reconnect() {}, dispose() { transport.disposed = true },
    async request(op, payload, options = {}) {
      calls.push({ op, payload: structuredClone(payload), options })
      const respond = () => {
        if (op === 'view.prepare') return { ok: true, submission: submission(payload.render, payload.surfaceGeneration, options.sessionId) }
        if (op === 'view.prepare.commit') return { ok: true, permit: { version: '1.0', key: payload.key, epoch: payload.epoch, permitId: `runtime:${payload.key.presentationRevision}` } }
        if (op === 'view.presented') return { ok: true, key: payload.key, inputEnabled }
        return { ok: true }
      }
      return hooks.has(op) ? hooks.get(op)({ op, payload, options, respond }) : respond()
    },
  }
  const client = new DomSessionClient({ presenter, transport, timeoutMs, onDiagnostic: value => diagnostics.push(value), onState: value => states.push(value) })
  client.updateAuthority(identity)
  t.after(() => expectDisposeFailure ? assert.rejects(client.dispose(), failure => failure.code === 'ERR_RENDER') : client.dispose())
  return { client, presenter, transport, calls, candidates, releases, diagnostics, states, hooks, submission }
}

function consumedScheduling(submission) {
  return { version: '1.0', key: structuredClone(submission.key), consumedInput: {
    pageId: submission.key.pageId, routePath: submission.document.routePath,
    templateRevision: '18446744073709551615', viewport: { x: 12.5, y: -7.25, ...submission.viewport },
  } }
}

test('exact abort restoration rebinds retained DOM input after a failed style authority revision', async t => {
  const h = harness(t)
  h.client.queryScope = 'presentation'
  h.hooks.set('view.query.enable', ({ payload }) => ({ ok: true, ...payload, enabled: true }))
  h.hooks.set('view.presented', ({ respond }) => ({ ...respond(), inputLifetimeRevision: '3' }))
  await h.client.present({}); await h.presenter.currentEntry.geometryBarrier; await h.client.turn
  const previous = h.client.accepted, image = h.candidates[0]
  h.client.updateAuthority({ ...identity, revision: '2' })
  h.hooks.set('view.abort', ({ payload }) => ({ ok: true, version: '1.0', key: payload, aborted: true,
    restoredKey: previous.key, inputEnabled: true, inputLifetimeRevision: '3' }))
  h.presenter.resolveResource = async () => { throw new Error('candidate image failed') }
  await assert.rejects(h.client.prepareTemplate({}), /candidate image failed/)
  assert.equal(h.client.accepted, previous); assert.equal(previous.authority.revision, '2')
  assert.equal(previous.inputEnabled, true); assert.equal(image.interactive, true); assert.equal(image.disposed, false)
  assert.equal(h.client.queryEnabled, true)
  assert.equal(h.calls.filter(call => call.op === 'view.query.enable').length, 2)
  assert.deepEqual(h.calls.findLast(call => call.op === 'view.query.enable').payload.key, previous.key)
  const before = h.calls.filter(call => call.op === 'view.events').length
  image.send('root', 'tap', { x: 4 }, { timeStamp: 21 })
  await h.presenter.currentEntry.geometryBarrier; await h.client.turn; await tick(); await h.client.turn
  assert.equal(h.calls.filter(call => call.op === 'view.events').length, before + 1)
})

for (const failureAt of ['populate', 'committed']) test(`exact abort restores retained DOM after ${failureAt} failure`, async t => {
  const h = harness(t)
  h.hooks.set('view.presented', ({ respond }) => ({ ...respond(), inputLifetimeRevision: '3' }))
  await h.client.present({}); await h.presenter.currentEntry.geometryBarrier; await h.client.turn
  const previous = h.client.accepted
  h.hooks.set('view.abort', ({ payload }) => ({ ok: true, version: '1.0', key: payload, aborted: true,
    restoredKey: previous.key, inputEnabled: true, inputLifetimeRevision: '3' }))
  if (failureAt === 'populate') {
    const create = h.presenter.createCandidate
    h.presenter.createCandidate = async (...args) => { const candidate = await create(...args); candidate.populate = () => { throw new Error('adapter failed') }; return candidate }
    await assert.rejects(h.client.prepareTemplate({}), /adapter failed/)
  } else {
    h.hooks.set('view.presented', () => { throw new Error('publication rejected') })
    await assert.rejects(h.client.present({}, { releaseMode: 'strict' }), /publication rejected/)
  }
  assert.equal(h.client.accepted, previous); assert.equal(h.candidates[0].interactive, true)
  assert.equal(h.candidates[1].disposed, true); assert.equal(previous.inputEnabled, true)
})

for (const reason of ['old-host', 'missing-lifetime', 'wrong-key', 'wrong-lifetime', 'authority-retired', 'connection-retired', 'cleanup-failed', 'legacy-release', 'input-gate', 'disconnected-dom']) test(`abort restoration stays frozen for ${reason}`, async t => {
  const h = harness(t)
  if (reason !== 'missing-lifetime') h.hooks.set('view.presented', ({ respond }) => ({ ...respond(), inputLifetimeRevision: '3' }))
  await h.client.present({}); await h.presenter.currentEntry.geometryBarrier; await h.client.turn
  const previous = h.client.accepted
  h.client.updateAuthority({ ...identity, revision: '2' })
  h.hooks.set('view.abort', ({ payload }) => {
    if (reason === 'old-host') return { ok: true }
    if (reason === 'authority-retired') h.client.updateAuthority({ ...identity, revision: '3' })
    if (reason === 'connection-retired') { h.client.disconnect(); h.client.reconnect() }
    return { ok: true, version: '1.0', key: payload, aborted: true, inputEnabled: true,
      restoredKey: reason === 'wrong-key' ? { ...previous.key, presentationRevision: '999' } : previous.key,
      inputLifetimeRevision: reason === 'wrong-lifetime' ? '4' : '3' }
  })
  if (reason === 'cleanup-failed') {
    const release = h.presenter.releaseCandidate.bind(h.presenter)
    h.presenter.releaseCandidate = async (...args) => { await release(...args); throw new Error('candidate cleanup failed') }
  }
  if (reason === 'input-gate') h.client.inputGate = () => false
  if (reason === 'disconnected-dom') h.candidates[0].connected = false
  h.presenter.resolveResource = async () => { throw new Error('candidate image failed') }
  await assert.rejects(h.client.prepareTemplate({}, { releaseMode: reason === 'legacy-release' ? 'legacy' : 'strict' }), /candidate image failed/)
  assert.equal(h.client.accepted, previous); assert.equal(previous.inputEnabled, false)
  assert.equal(h.candidates[0].interactive, false); assert.equal(h.candidates[0].disposed, false)
})

test('a lost ACK settlement retains the new publication and ignores old-base restoration fields', async t => {
  const h = harness(t)
  h.hooks.set('view.presented', ({ respond }) => ({ ...respond(), inputLifetimeRevision: '3' }))
  await h.client.present({}); await h.presenter.currentEntry.geometryBarrier; await h.client.turn
  const previous = h.client.accepted
  h.hooks.set('view.presented', () => { throw new Error('lost candidate ACK') })
  h.hooks.set('view.abort', ({ payload }) => ({ ok: true, version: '1.0', key: payload, aborted: false, presented: true,
    permit: h.client.active.permit, inputEnabled: false, restoredKey: previous.key, inputLifetimeRevision: '3' }))
  await assert.rejects(h.client.present({}, { releaseMode: 'strict' }), /lost candidate ACK/)
  assert.notEqual(h.client.accepted, previous); assert.equal(h.client.accepted.inputEnabled, false)
  assert.deepEqual(h.presenter.currentEntry.key, h.client.accepted.key)
  assert.equal(h.candidates[0].disposed, true); assert.equal(h.candidates[1].disposed, false); assert.equal(h.candidates[1].interactive, false)
})

for (const reentry of ['input-gate', 'activation']) test(`restoration cannot reopen old native input when ${reentry} starts a successor`, async t => {
  const h = harness(t)
  h.hooks.set('view.presented', ({ respond }) => ({ ...respond(), inputLifetimeRevision: '3' }))
  await h.client.present({}); await h.presenter.currentEntry.geometryBarrier; await h.client.turn
  const previous = h.client.accepted, image = h.candidates[0], resolve = h.presenter.resolveResource, restored = []
  let successor
  const start = () => { if (!successor) { h.presenter.resolveResource = resolve; successor = h.client.prepareTemplate({}) } }
  h.hooks.set('view.abort', ({ payload }) => ({ ok: true, version: '1.0', key: payload, aborted: true,
    restoredKey: previous.key, inputEnabled: true, inputLifetimeRevision: '3' }))
  h.client.onState = value => { if (value.restored) restored.push(value) }
  if (reentry === 'input-gate') h.client.inputGate = () => { start(); return true }
  else {
    const activate = image.setInteractive.bind(image)
    image.setInteractive = value => { if (value) start(); activate(value) }
  }
  h.presenter.resolveResource = async () => { throw new Error('candidate image failed') }
  await assert.rejects(h.client.prepareTemplate({}), /candidate image failed/)
  assert.ok(successor, 'synchronous embedding hook must actually start the next owned transaction')
  const prepared = await successor
  assert.equal(h.client.accepted, previous); assert.equal(previous.inputEnabled, false)
  assert.equal(image.interactive, false); assert.equal(restored.length, 0)
  assert.equal(h.client.active.key, prepared.key)
  await h.client.releasePrepared(prepared)
})

function selectorQuery(key, sequence = 1, { afterEpoch = '0', occurrenceIds = ['root'], includeViewportExtent = false } = {}) {
  return { protocolVersion: '1.0', sessionId: key.sessionId, requestId: '', kind: 'event', op: 'view.query.request',
    payload: { version: '1.0', requestId: `dom-query:${sequence}`, key: structuredClone(key), afterEpoch,
      deadlineNs: '18446744073709551615', occurrenceIds, ...(includeViewportExtent ? { includeViewportExtent: true } : {}) } }
}

test('selector queries sample fresh complete browser geometry once and leave input geometry unchanged', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const entry = h.presenter.currentEntry, inputGeometry = entry.geometry, inputAdmitted = entry.geometryAdmitted
  const candidate = h.candidates[0], measure = candidate.measure.bind(candidate)
  let samples = 0
  candidate.measure = () => { samples++; return measure() }
  candidate.scrollTop = 37
  candidate.viewportScrollY = 119
  candidate.viewportScrollHeight = 1234
  const query = selectorQuery(h.client.accepted.key, 1, { afterEpoch: '9007199254740993', includeViewportExtent: true })
  assert.equal(h.client.receiveQueryBatch({ messages: [query, query] }), 1)
  await h.client.turn; await tick()
  assert.equal(samples, 1)
  const [result] = h.calls.filter(call => call.op === 'view.query.result')
  assert.deepEqual(Object.keys(result.payload).sort(), ['geometry', 'key', 'requestId', 'version', 'viewportExtent', 'viewportScroll'])
  assert.equal(result.payload.requestId, 'dom-query:1')
  assert.equal(result.payload.geometry.epoch, '9007199254740994')
  assert.deepEqual(result.payload.geometry.nodes.map(node => node.occurrenceId), ['root', 'image'])
  assert.equal(result.payload.geometry.nodes[0].scrollOffset.y, 37)
  assert.deepEqual(result.payload.viewportScroll, { x: 3, y: 119 })
  assert.deepEqual(result.payload.viewportExtent, { width: 700, height: 1234 })
  assert.equal(entry.geometry, inputGeometry); assert.equal(entry.geometryAdmitted, inputAdmitted)
  assert.equal(h.client.queryPending, 0); assert.equal(h.client.queryBytes, 0)
  assert.equal(h.client.receiveQueryBatch(query), 0)
  assert.equal(h.client.receiveQueryBatch(selectorQuery(h.client.accepted.key, 2)), 1)
  await h.client.turn
  assert.equal(samples, 2)
  assert.equal(h.calls.filter(call => call.op === 'view.query.result').length, 2)
})

test('query transport preserves older bounding recipients without synthesizing viewport extent', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  h.candidates[0].measureViewportExtent = () => { throw Error('older native request must not sample new extent') }
  const query = selectorQuery(h.client.accepted.key)
  assert.equal(h.client.receiveQueryBatch(query), 1)
  await h.client.turn
  const [result] = h.calls.filter(call => call.op === 'view.query.result')
  assert.equal(Object.hasOwn(result.payload, 'viewportExtent'), false)
  assert.deepEqual(result.payload.viewportScroll, { x: 3, y: 0 })
})

test('query lease gates reject stale, hidden and pending documents without sampling or freezing valid input', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const key = h.client.accepted.key, candidate = h.candidates[0], measure = candidate.measure.bind(candidate)
  let samples = 0
  candidate.measure = () => { samples++; return measure() }
  h.client.receiveQueryBatch(selectorQuery({ ...key, documentRevision: '999' }, 1))
  await h.client.turn
  h.presenter.container.ownerDocument.hidden = true
  h.client.receiveQueryBatch(selectorQuery(key, 2)); await h.client.turn
  h.presenter.container.ownerDocument.hidden = false
  const prepared = await h.client.prepareTemplate({})
  h.client.receiveQueryBatch(selectorQuery(key, 3)); await h.client.turn
  await h.client.releasePrepared(prepared)
  assert.equal(samples, 0)
  const failures = h.calls.filter(call => call.op === 'view.query.result').map(call => call.payload)
  assert.equal(failures.length, 3)
  for (const value of failures) {
    assert.deepEqual(Object.keys(value).sort(), ['error', 'key', 'requestId', 'version'])
    assert.equal(value.error.code, 'ERR_CANCELLED')
  }
})

test('query measurement rechecks the live lease and close drains bounded jobs without replaying samples', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const key = h.client.accepted.key, gate = deferred()
  h.client.enqueue(() => gate.promise)
  const requests = Array.from({ length: 40 }, (_, index) => selectorQuery(key, index + 1))
  assert.equal(h.client.receiveQueryBatch({ messages: requests }), 32)
  assert.equal(h.client.queryPending, 32); assert.ok(h.client.queryBytes <= 1024 * 1024)
  let samples = 0
  const candidate = h.candidates[0], measure = candidate.measure.bind(candidate)
  candidate.measure = () => { samples++; return measure() }
  const closing = h.client.dispose()
  gate.resolve(); await closing
  assert.equal(samples, 0); assert.equal(h.client.queryPending, 0); assert.equal(h.client.queryBytes, 0)
  assert.equal(h.client.receiveQueryBatch(selectorQuery(key, 41)), 0)
  assert.equal(h.calls.some(call => call.op === 'view.query.result'), false)
})

test('queue refusals return keyed errors on the transaction lane without another geometry sample', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const key = h.client.accepted.key, gate = deferred()
  let samples = 0
  const candidate = h.candidates[0], measure = candidate.measure.bind(candidate)
  candidate.measure = () => { samples++; return measure() }
  h.client.enqueue(() => gate.promise)
  assert.equal(h.client.receiveQueryBatch({ messages: Array.from({ length: 32 }, (_, index) => selectorQuery(key, index + 1)) }), 32)
  assert.equal(h.client.receiveQueryBatch(selectorQuery(key, 33)), 0)
  assert.equal(h.client.receiveQueryBatch(selectorQuery({ ...key, documentRevision: '999' }, 34)), 0)
  assert.equal(h.client.queryRejectedPending, 2)
  assert.equal(h.calls.some(call => call.op === 'view.query.result'), false)
  gate.resolve(); await h.client.turn; await tick()
  const results = h.calls.filter(call => call.op === 'view.query.result')
  assert.equal(results.length, 34); assert.equal(samples, 32)
  assert.deepEqual(results[32].payload, { version: '1.0', requestId: 'dom-query:33', key,
    error: { code: 'ERR_RENDER', message: 'ERR_RENDER: DOM query queue exceeds its finite count/byte budget' } })
  assert.equal(results[33].payload.error.code, 'ERR_CANCELLED')
  assert.equal(h.client.accepted.inputEnabled, true)
  assert.equal(h.client.queryPending, 0); assert.equal(h.client.queryBytes, 0); assert.equal(h.client.queryRejectedPending, 0)
})

test('refusal metadata stays bounded and retires with its exact connection before sending', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const key = h.client.accepted.key, gate = deferred()
  h.client.enqueue(() => gate.promise)
  assert.equal(h.client.receiveQueryBatch({ messages: Array.from({ length: 1000 }, (_, index) => selectorQuery(key, index + 1)) }), 32)
  assert.equal(h.client.queryPending, 32); assert.equal(h.client.queryRejectedPending, 32)
  assert.ok(h.client.queryBytes <= 1024 * 1024)
  h.client.updateAuthority({ ...identity, revision: '2' })
  gate.resolve(); await h.client.turn; await tick()
  assert.equal(h.calls.some(call => call.op === 'view.query.result'), false)
  assert.equal(h.client.queryPending, 0); assert.equal(h.client.queryBytes, 0); assert.equal(h.client.queryRejectedPending, 0)
})

test('a refusal diagnostic may synchronously dispose without queuing jobs after the close barrier', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const key = h.client.accepted.key, gate = deferred()
  let closing
  h.client.enqueue(() => gate.promise)
  h.client.onDiagnostic = failure => {
    h.diagnostics.push(failure)
    if (!closing) closing = h.client.dispose()
  }
  assert.equal(h.client.receiveQueryBatch({ messages: Array.from({ length: 40 }, (_, index) => selectorQuery(key, index + 1)) }), 32)
  assert.equal(h.client.closed, true); assert.equal(h.client.queryRejectedPending, 1)
  assert.equal(h.client.querySequence, 33n)
  gate.resolve(); await closing; await tick()
  assert.equal(h.client.queryPending, 0); assert.equal(h.client.queryRejectedPending, 0); assert.equal(h.client.queryBytes, 0)
  assert.equal(h.client.background.size, 0); assert.equal(h.transport.disposed, true)
  assert.equal(h.calls.some(call => call.op === 'view.query.result'), false)
})

test('malformed, oversized and repeated native query IDs never trigger browser measurement', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const key = h.client.accepted.key
  const invalid = [selectorQuery(key, '01'), selectorQuery(key, '18446744073709551616'),
    selectorQuery(key, 1, { occurrenceIds: ['root', 'root'] }), selectorQuery(key, 1, { afterEpoch: '01' }),
    selectorQuery(key, 1, { occurrenceIds: Array.from({ length: 300 }, (_, index) => `${index}-${'a'.repeat(1000)}`) })]
  for (const query of invalid) assert.equal(h.client.receiveQueryBatch(query), 0)
  assert.equal(h.calls.some(call => call.op === 'view.query.result'), false)
  assert.equal(h.client.queryPending, 0)
  assert.equal(h.client.receiveQueryBatch(selectorQuery(key, 5)), 1)
  await h.client.turn
  assert.equal(h.client.receiveQueryBatch(selectorQuery(key, 4)), 0)
  assert.equal(h.client.receiveQueryBatch(selectorQuery(key, 5)), 0)
})

test('a lease retired during real sampling cannot publish a late query result', async t => {
  const h = harness(t)
  await h.client.present({}); await tick(); await h.client.turn
  const candidate = h.candidates[0], measure = candidate.measure.bind(candidate), key = h.client.accepted.key
  let samples = 0
  candidate.measure = () => {
    samples++
    const value = measure()
    h.client.updateAuthority({ ...identity, revision: '2' })
    return value
  }
  h.client.receiveQueryBatch(selectorQuery(key))
  await h.client.turn; await tick()
  assert.equal(samples, 1)
  assert.equal(h.calls.some(call => call.op === 'view.query.result'), false)
  assert.equal(h.client.accepted.inputEnabled, false)
  assert.equal(h.client.queryPending, 0); assert.equal(h.client.queryBytes, 0)
})

test('presentation query negotiation happens after confirm and preserves accepted input on failure', async t => {
  const h = harness(t)
  h.client.queryScope = 'presentation'
  h.hooks.set('view.query.enable', ({ payload }) => {
    assert.equal(h.presenter.currentEntry.state, 'confirmed')
    assert.equal(h.client.accepted.inputEnabled, true)
    return { ok: true, version: '1.0', scope: 'presentation', enabled: true, key: payload.key }
  })
  await h.client.present({})
  assert.equal(h.client.queryEnabled, true)
  h.hooks.set('view.query.enable', () => { throw Object.assign(new Error('host denied query capability'), { code: 'ERR_RENDER' }) })
  const retained = await h.client.present({})
  assert.equal(retained.inputEnabled, true)
  assert.equal(h.client.accepted.inputEnabled, true)
  assert.equal(h.presenter.currentEntry.state, 'confirmed')
  assert.equal(h.client.queryEnabled, false)
  assert.ok(h.diagnostics.some(value => value.message === 'host denied query capability'))
})

test('query negotiation requires an explicit enabled true without retracting a confirmed presentation', async t => {
  for (const [label, enabled] of [['disabled', false], ['missing', undefined], ['nonboolean', 'true']]) await t.test(label, async t => {
    const h = harness(t)
    h.client.queryScope = 'presentation'
    h.hooks.set('view.query.enable', ({ payload }) => ({ ok: true, version: '1.0', scope: 'presentation', enabled: true, key: payload.key }))
    await h.client.present({})
    assert.equal(h.client.queryEnabled, true)
    h.hooks.set('view.query.enable', ({ payload }) => ({ ok: true, version: '1.0', scope: 'presentation',
      ...(enabled === undefined ? {} : { enabled }), key: payload.key }))
    const retained = await h.client.present({})
    assert.equal(retained.inputEnabled, true)
    assert.equal(h.client.accepted.inputEnabled, true)
    assert.equal(h.presenter.currentEntry.state, 'confirmed')
    assert.deepEqual(h.presenter.currentEntry.key, retained.key)
    assert.equal(h.client.queryEnabled, false)
    assert.ok(h.diagnostics.some(value => value.code === 'ERR_PROTOCOL_VERSION'))
  })
})

test('a query emitted by the genuine ACK waits for local confirmation on the same lane', async t => {
  const h = harness(t)
  h.hooks.set('view.presented', ({ payload, respond }) => {
    assert.equal(h.client.accepted, null)
    assert.equal(h.client.receiveQueryBatch(selectorQuery(payload.key)), 1)
    return respond()
  })
  await h.client.present({})
  await h.client.turn; await tick()
  const result = h.calls.find(call => call.op === 'view.query.result')
  assert.ok(result.payload.geometry)
  assert.equal(Object.hasOwn(result.payload, 'error'), false)
  assert.equal(h.presenter.currentEntry.state, 'confirmed')
})

test('client returns immutable prepare-time scheduling facts and ignores metadata sampled at ACK', async t => {
  const h = harness(t)
  let prepared
  h.hooks.set('view.prepare', ({ respond }) => {
    prepared = respond(); prepared.scheduling = consumedScheduling(prepared.submission)
    return prepared
  })
  h.hooks.set('view.presented', ({ respond }) => {
    prepared.scheduling.key.presentationRevision = '999'
    prepared.scheduling.consumedInput.templateRevision = '7'
    prepared.scheduling.consumedInput.viewport.x = 0
    // ACK-time state or transport decorations cannot refresh consumed input.
    return { ...respond(), scheduling: prepared.scheduling }
  })
  const result = await h.client.present({ revision: 901 })
  assert.deepEqual(result.scheduling.key, result.key)
  assert.equal(result.scheduling.consumedInput.templateRevision, '18446744073709551615')
  assert.notEqual(result.scheduling.consumedInput.templateRevision, result.key.documentRevision)
  assert.equal(result.scheduling.consumedInput.routePath, 'pages/home')
  assert.deepEqual(result.scheduling.consumedInput.viewport, { x: 12.5, y: -7.25, width: 375, height: 667 })
  for (const value of [result.scheduling, result.scheduling.key, result.scheduling.consumedInput, result.scheduling.consumedInput.viewport]) assert.equal(Object.isFrozen(value), true)
  const permit = h.calls.find(call => call.op === 'view.presented').payload
  assert.equal(permit.scheduling, undefined)
  assert.equal(result.inputEnabled, true)
})

test('explicit-data preparations retain null consumed proof even when a later ACK offers current page state', async t => {
  const h = harness(t)
  let submitted
  h.hooks.set('view.prepare', ({ respond }) => {
    const result = respond(); submitted = result.submission
    result.scheduling = { version: '1.0', key: structuredClone(submitted.key), consumedInput: null }
    return result
  })
  h.hooks.set('view.presented', ({ respond }) => ({ ...respond(), scheduling: consumedScheduling(submitted) }))
  const result = await h.client.present({ revision: 1, data: { count: 1 } })
  assert.equal(result.scheduling.consumedInput, null)
  assert.deepEqual(result.scheduling.key, result.key)
  assert.equal(result.inputEnabled, true, 'Scheduling proof is separate from the existing permit/ACK authority')
})

test('invalid scheduling never prepares a presenter or receives input authority', async t => {
  const invalid = [
    ['unknown version', value => { value.version = '2.0' }],
    ['missing consumedInput', value => { delete value.consumedInput }],
    ['unknown metadata field', value => { value.permitId = 'forged' }],
    ['noncanonical template revision', value => { value.consumedInput.templateRevision = '01' }],
    ['numeric template revision', value => { value.consumedInput.templateRevision = 1 }],
    ['overflow template revision', value => { value.consumedInput.templateRevision = '18446744073709551616' }],
    ['mismatched page', value => { value.consumedInput.pageId = '2' }],
    ['numeric page', value => { value.consumedInput.pageId = 1 }],
    ['mismatched route', value => { value.consumedInput.routePath = 'pages/other' }],
    ['mismatched width', value => { value.consumedInput.viewport.width += 1 }],
    ['mismatched height', value => { value.consumedInput.viewport.height += 1 }],
    ['missing origin', value => { delete value.consumedInput.viewport.x }],
    ['nonfinite origin', value => { value.consumedInput.viewport.y = Infinity }],
    ['unknown proof field', value => { value.consumedInput.currentState = true }],
  ]
  for (const field of ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']) {
    invalid.push([`mismatched ${field} key`, value => { value.key[field] = field === 'sessionId' ? 'other-session' : field === 'profile' ? 'skia' : '999' }])
  }
  for (const [name, mutate] of invalid) await t.test(name, async child => {
    const h = harness(child)
    let key
    h.hooks.set('view.prepare', ({ respond }) => {
      const result = respond(); key = structuredClone(result.submission.key)
      result.scheduling = consumedScheduling(result.submission); mutate(result.scheduling)
      return result
    })
    await assert.rejects(h.client.present({ revision: 1 }), failure => failure.code === 'ERR_PROTOCOL_VERSION' && /scheduling/.test(failure.message))
    assert.equal(h.candidates.length, 0)
    assert.equal(h.client.accepted, null)
    assert.equal(h.calls.some(call => ['view.prepare.commit', 'view.presented'].includes(call.op)), false)
    assert.ok(h.calls.some(call => call.op === 'view.abort' && JSON.stringify(call.payload) === JSON.stringify(key)))
  })
})

test('client executes the runtime permit transaction, sends only the permit as final ACK and exposes diagnostics', async t => {
  const h = harness(t)
  const notes = [{ code: 'FIRST', message: 'ready diagnostic' }, { code: 'SECOND', message: 'another diagnostic' }]
  h.hooks.set('view.presented', ({ respond }) => ({ ...respond(), diagnostics: notes }))
  const result = await h.client.present({ revision: 1 })
  await tick()
  assert.deepEqual(h.calls.map(call => call.op), ['view.prepare', 'view.prepare.commit', 'view.presented', 'view.geometry'])
  assert.deepEqual(h.calls[0].payload, { version: '1.0', surfaceGeneration: '0', render: { revision: 1 } })
  const ack = h.calls.find(call => call.op === 'view.presented').payload
  assert.deepEqual(Object.keys(ack).sort(), ['epoch', 'key', 'permitId', 'version'])
  assert.equal(ack.commitId, undefined); assert.equal(ack.phase, undefined)
  assert.equal(h.candidates[0].interactive, true); assert.equal(result.inputEnabled, true)
  assert.deepEqual(result.diagnostics, notes); assert.ok(notes.every(note => h.diagnostics.includes(note)))
  assert.equal(result.scheduling, undefined, 'Legacy final responses remain compatible without claiming consumed proof')
  assert.ok(h.states.some(state => state.phase === 'ready'))
  await h.client.dispose(); assert.equal(h.releases.length, 1); assert.equal(h.candidates[0].disposeCount, 1)
})

test('geometry admission and application events await serialized authoritative runtime results', { timeout: 2000 }, async t => {
  const h = harness(t)
  await h.client.present({ revision: 1 })
  await h.presenter.currentEntry.geometryBarrier
  await h.client.turn
  const geometry = deferred(), event = deferred(), geometryStarted = deferred(), firstEventStarted = deferred(), secondEventStarted = deferred()
  h.calls.length = 0
  h.hooks.set('view.geometry', request => { geometryStarted.resolve(request); return geometry.promise })
  let eventRequests = 0
  h.hooks.set('view.events', request => {
    if (++eventRequests === 1) { firstEventStarted.resolve(request); return event.promise }
    secondEventStarted.resolve(request); return request.respond()
  })
  h.candidates[0].scrollTop = 40
  h.candidates[0].send('root', 'input', { value: 'typed' }, { timeStamp: 11 })
  await geometryStarted.promise
  assert.deepEqual(h.calls.map(call => call.op), ['view.geometry'])
  geometry.resolve({ ok: true })
  const first = await firstEventStarted.promise
  assert.deepEqual(h.calls.map(call => call.op), ['view.geometry', 'view.events'])
  h.candidates[0].send('root', 'tap', { x: 3 }, { timeStamp: 12 })
  // queueEvent flushes in a microtask. Keep the deferred reply in that same
  // turn instead of letting an unrelated setImmediate cross the harness's
  // 100 ms request deadline under concurrent test load.
  await Promise.resolve()
  assert.equal(h.calls.filter(call => call.op === 'view.events').length, 1)
  event.resolve({ ok: true })
  const second = await secondEventStarted.promise
  await h.presenter.currentEntry.geometryBarrier
  assert.equal(h.calls.filter(call => call.op === 'view.events').length, 2)
  assert.equal(first.payload.events[0].timeStamp, 11)
  assert.equal(second.payload.events[0].timeStamp, 12)
  assert.deepEqual(h.diagnostics, [])
})

test('locally retired geometry from a prior confirm stops its input without an error overlay', async t => {
  const h = harness(t), delayed = deferred()
  let firstGeometry
  const geometry = h.presenter.onGeometry
  h.presenter.onGeometry = batch => {
    if (!firstGeometry) { firstGeometry = batch; return delayed.promise.then(() => geometry(batch)) }
    return geometry(batch)
  }
  const first = await h.client.present({ revision: 1 })
  while (!firstGeometry) await tick()
  h.candidates[0].send('root', 'tap', { x: 1 }, { timeStamp: 20 }); await tick()
  const second = await h.client.present({ revision: 2 })
  delayed.resolve(); await tick(); await tick()
  assert.notDeepEqual(first.key, second.key)
  assert.equal(h.calls.filter(call => call.op === 'view.geometry' && call.payload.key.presentationRevision === first.key.presentationRevision).length, 0)
  assert.equal(h.calls.filter(call => call.op === 'view.events').length, 0)
  assert.equal(h.candidates[1].interactive, true)
  assert.deepEqual(h.diagnostics, []); assert.deepEqual(h.presenter.errors, [])
  const dropped = await h.client.geometry(firstGeometry)
  assert.equal(dropped.discarded, true); assert.equal(dropped.source, 'local-retirement')
})

test('runtime geometry rejection remains an error even when a new presentation is queued', async t => {
  const h = harness(t), delayed = deferred()
  await h.client.present({ revision: 1 }); await tick()
  h.hooks.set('view.geometry', () => delayed.promise)
  const firstGeometry = h.calls.find(call => call.op === 'view.geometry').payload
  const rejected = assert.rejects(h.client.geometry(firstGeometry), /runtime refused old epoch/)
  await tick()
  const next = h.client.present({ revision: 2 })
  delayed.resolve({ ok: false, error: { code: 'ERR_CANCELLED', message: 'runtime refused old epoch' } })
  await rejected
  h.hooks.delete('view.geometry')
  await next; await tick()
  assert.ok(h.diagnostics.some(value => value.code === 'ERR_CANCELLED' && /runtime refused/.test(value.message)))
})

test('real HTTP/SSE transport cleans late retired prepare responses without admitting their surfaces', async t => {
  for (const channel of ['sse', 'http']) await t.test(channel, async t => {
    const h = harness(t, { timeoutMs: 25 }), sent = [], lateHttp = deferred()
    let first
    const wire = new SseBridgeTransport({ sessionId: 'session', timeoutMs: 25, send: async envelope => {
      sent.push(envelope)
      if (!first && envelope.op === 'view.prepare') { first = envelope; return channel === 'sse' ? { queued: true } : lateHttp.promise }
      return { messages: [reply(envelope, await h.transport.request(envelope.op, envelope.payload, { sessionId: envelope.sessionId }))] }
    } })
    h.client.transport = wire
    if (channel === 'sse') await assert.rejects(h.client.present({ revision: 1 }), /ERR_TIMEOUT/)
    else {
      const controller = new AbortController(), stopped = assert.rejects(h.client.present({ revision: 1 }, { signal: controller.signal }), /ERR_CANCELLED/)
      while (!first) await tick()
      controller.abort(); await stopped
    }
    assert.equal(wire.retired.size, 1); assert.equal(h.client.accepted, null)
    const prepared = { ok: true, submission: h.submission({ revision: 1 }, '0') }, lateReply = { messages: [reply(first, prepared)] }
    if (channel === 'sse') wire.receive(lateReply)
    else lateHttp.resolve({ ok: true, json: async () => lateReply })
    await tick(); await tick()
    const aborted = sent.filter(value => value.op === 'view.abort')
    assert.equal(aborted.length, 1); assert.deepEqual(aborted[0].payload, prepared.submission.key)
    assert.equal(h.candidates.length, 0); assert.equal(h.client.accepted, null); assert.equal(wire.retired.size, 0)
    const current = await h.client.present({ revision: 2 }); await tick()
    wire.receive(lateReply); await tick()
    assert.equal(sent.filter(value => value.op === 'view.abort').length, 1)
    assert.deepEqual(h.client.accepted.key, current.key); assert.equal(h.candidates[0].interactive, true)
  })
})

test('late cleanup tombstones are bounded, exact-correlated, expire, and never resolve requests', async t => {
  const sent = [], cleaned = [], transport = new SseBridgeTransport({ sessionId: 'session', timeoutMs: 1000, maxPending: 2, send: request => { sent.push(request); return { queued: true } } })
  t.after(() => transport.dispose())
  for (let index = 0; index < 3; index++) {
    const controller = new AbortController()
    const stopped = assert.rejects(transport.request('view.prepare', { index }, { signal: controller.signal, onLateResponse: value => cleaned.push(value) }), /cancelled/)
    await tick(); controller.abort(); await stopped
  }
  assert.equal(transport.pending.size, 0); assert.equal(transport.retired.size, 2)
  transport.receive(reply(sent[0], { ok: true, retired: 0 }))
  transport.receive({ ...reply(sent[1], { ok: true, retired: 1 }), op: 'view.presented' })
  transport.receive(reply(sent[1], { ok: true, queued: true }))
  await tick(); assert.equal(cleaned.length, 0); assert.equal(transport.retired.size, 2)
  transport.receive(reply(sent[1], { ok: true, retired: 1 })); await tick()
  assert.deepEqual(cleaned, [{ ok: true, retired: 1 }]); assert.equal(transport.pending.size, 0)
  transport.receive(reply(sent[1], { ok: true, retired: 1 })); await tick(); assert.equal(cleaned.length, 1)
  for (const item of transport.retired.values()) item.expires = 0
  transport.receive(reply(sent[2], { ok: true, retired: 2 })); await tick()
  assert.equal(cleaned.length, 1); assert.equal(transport.retired.size, 0)
})

test('queued responses cannot substitute for permit or final ACK and rejected preparation releases candidates', async t => {
  const h = harness(t)
  await h.client.present({ revision: 1 }); await tick()
  const accepted = h.candidates[0]
  const historyStart = accepted.activationHistory.length
  h.hooks.set('view.prepare.commit', () => ({ queued: true }))
  await assert.rejects(h.client.present({ revision: 2 }), /final runtime response/)
  assert.equal(h.presenter.current, accepted); assert.equal(accepted.disposed, false); assert.equal(accepted.interactive, false)
  assert.ok(accepted.activationHistory.slice(historyStart).every(value => value === false), 'rollback never reopens native input or restores focus')
  assert.equal(h.candidates[1].disposeCount, 1); assert.equal(h.releases.length, 1)
  assert.equal(h.calls.at(-1).op, 'view.abort')
  h.hooks.delete('view.prepare.commit')
  h.hooks.set('view.presented', () => ({ queued: true }))
  await assert.rejects(h.client.present({ revision: 3 }), /final runtime response/)
  assert.equal(h.presenter.current, accepted); assert.equal(accepted.interactive, false)
  accepted.send('root', 'tap', { x: 1 }, { timeStamp: 20 })
  await tick()
  assert.equal(h.calls.filter(call => call.op === 'view.events').length, 0)
  assert.equal(h.candidates[2].disposeCount, 1)
  h.hooks.delete('view.presented')
  await h.client.present({ revision: 4 }); await tick()
  assert.equal(accepted.disposeCount, 1); assert.equal(h.candidates[3].interactive, true)
})

test('ACK inputEnabled false retains the new image and releases old leases without opening input', async t => {
  const h = harness(t, { timeoutMs: 30 })
  await h.client.present({ revision: 1 }); await tick()
  h.hooks.set('view.presented', ({ payload }) => ({ ok: true, key: payload.key, inputEnabled: false, diagnostics: [{ code: 'READY_FAILED' }] }))
  const result = await h.client.present({ revision: 2 }), image = h.candidates[1]
  assert.equal(result.inputEnabled, false); assert.equal(image.visible, true); assert.equal(image.interactive, false)
  assert.equal(h.candidates[0].disposeCount, 1); assert.equal(h.releases.length, 1)
  image.send('root', 'tap', {}, { timeStamp: 10 })
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(h.presenter.current, image); assert.equal(image.disposed, false)
  assert.ok(h.states.some(state => state.phase === 'blocked'))
  assert.equal(h.calls.filter(call => call.op === 'view.events').length, 0)
})

test('post-ACK cleanup failure revokes client input authority while retaining the irreversible image', async t => {
  const h = harness(t, { timeoutMs: 30 })
  await h.client.present({ revision: 1 }); await tick()
  const dispose = h.candidates[0].dispose
  h.candidates[0].dispose = () => { dispose(); throw new Error('old resource release failed') }
  await assert.rejects(h.client.present({ revision: 2 }), /previous surface cleanup failed/)
  assert.equal(h.client.accepted.inputEnabled, false); assert.equal(h.presenter.transaction, null)
  const image = h.candidates[1], count = h.calls.length
  const ignored = await h.client.geometry(h.presenter.currentEntry.geometry)
  assert.equal(ignored.discarded, true); assert.equal(h.calls.length, count)
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(h.presenter.current, image); assert.equal(image.disposed, false); assert.equal(image.interactive, false)
})

test('late source revision and session responses cannot overwrite a newer committed surface', async t => {
  const h = harness(t), late = deferred()
  let oldSubmission
  h.hooks.set('view.prepare', ({ respond }) => { oldSubmission = respond(); return late.promise })
  const old = assert.rejects(h.client.present({ revision: 1 }), /ERR_CANCELLED/)
  await tick()
  h.client.updateAuthority({ ...identity, revision: '9007199254740993' })
  h.hooks.delete('view.prepare')
  const accepted = await h.client.present({ revision: 2 }); await old
  late.resolve(oldSubmission); await tick()
  assert.equal(h.presenter.current, h.candidates[0]); assert.equal(h.client.accepted.key.presentationRevision, accepted.key.presentationRevision)
  assert.ok(h.calls.some(call => call.op === 'view.abort' && call.payload.presentationRevision === oldSubmission.submission.key.presentationRevision))
  assert.throws(() => h.client.updateAuthority({ ...identity, revision: '9007199254740992' }), /regressed/)
  const lateSession = deferred()
  h.hooks.set('view.prepare', () => lateSession.promise)
  const outdated = assert.rejects(h.client.present({ revision: 3 }), /ERR_CANCELLED/)
  await tick()
  h.client.updateAuthority({ sessionId: 'next-session', revision: '1', surfaceGeneration: '0' })
  h.hooks.delete('view.prepare')
  const next = await h.client.present({ revision: 1 }); await outdated
  lateSession.resolve(oldSubmission); await tick()
  assert.equal(h.client.accepted.key.sessionId, 'next-session'); assert.deepEqual(h.client.accepted.key, next.key)
})

test('disconnect during ambiguous final ACK retains the DOM until reconnect settles its exact native outcome', async t => {
  const h = harness(t), ack = deferred()
  await h.client.present({ revision: 1 }); await tick()
  let oldAck
  h.hooks.set('view.presented', ({ respond }) => { oldAck = respond(); return ack.promise })
  const stopped = assert.rejects(h.client.present({ revision: 2 }), /ERR_CANCELLED/)
  while (!oldAck) await tick()
  h.client.disconnect('stream lost'); await stopped
  assert.equal(h.candidates[0].interactive, false); assert.equal(h.candidates[1].disposeCount, 0)
  assert.equal(h.presenter.current, h.candidates[1])
  await assert.rejects(h.client.present({ revision: 3 }), /connected authoritative/)
  const permit = h.calls.filter(call => call.op === 'view.presented').at(-1).payload
  h.hooks.set('view.abort', ({ payload }) => ({ ok: true, version: '1.0', key: payload,
    aborted: false, presented: true, permit, inputEnabled: false }))
  h.client.reconnect()
  await h.client.turn
  assert.deepEqual(h.client.accepted.key, oldAck.key)
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.candidates[1].disposeCount, 0)
  assert.equal(h.candidates[0].interactive, false)
  h.hooks.delete('view.abort')
  h.hooks.delete('view.presented')
  const next = await h.client.present({ revision: 3 })
  ack.resolve(oldAck); await tick()
  assert.deepEqual(h.client.accepted.key, next.key); assert.equal(h.candidates[2].interactive, true)
})

test('template ACK cancellation and timeout settle the exact accepted permit before any DOM rollback', async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const h = harness(t, { timeoutMs: 100 }), controller = new AbortController(), held = deferred()
    const prepared = await h.client.prepareTemplate({ revision: 1 }, { signal: controller.signal })
    let nativeFinal, permit
    h.hooks.set('view.presented', ({ payload, respond }) => {
      permit = payload; nativeFinal = respond()
      if (mode === 'cancel') controller.abort()
      return mode === 'cancel' ? nativeFinal : held.promise
    })
    h.hooks.set('view.abort', ({ payload }) => {
      assert.equal(h.candidates[0].disposeCount, 0)
      assert.equal(h.presenter.current, h.candidates[0])
      return { ok: true, version: '1.0', key: payload, aborted: false, presented: true, permit, inputEnabled: false }
    })
    if (mode === 'timeout') h.client.timeoutMs = 20
    await assert.rejects(h.client.presentPrepared(prepared), mode === 'cancel' ? /cancelled/ : /timed out/)
    held.resolve(nativeFinal); await tick()
    assert.equal(h.presenter.current, h.candidates[0])
    assert.equal(h.candidates[0].disposeCount, 0)
    assert.deepEqual(h.client.accepted.key, prepared.key)
    assert.equal(h.client.accepted.inputEnabled, false)
    assert.equal((await h.client.releasePrepared(prepared)).acknowledged, true)
  })
})

test('legacy presentation rejects a presenter without ACK retention before sending work or swapping DOM', async t => {
  for (const missing of ['holdAcknowledgement', 'acknowledge']) await t.test(missing, async t => {
    const h = harness(t)
    h.presenter[missing] = undefined
    await assert.rejects(h.client.present({ revision: 1 }), /irreversible runtime acknowledgement support/)
    assert.equal(h.calls.length, 0)
    assert.equal(h.candidates.length, 0)
  })
})

test('unknown template settlement retains the committed DOM past its old timeout and blocks legacy replacement/disposal', async t => {
  for (const mode of ['transport', 'wrong-permit']) await t.test(mode, async t => {
    const h = harness(t, { timeoutMs: 100, expectDisposeFailure: true })
    h.presenter.timeoutMs = 10
    const prepared = await h.client.prepareTemplate({ revision: 1 })
    h.client.timeoutMs = 25
    h.hooks.set('view.presented', () => new Promise(() => {}))
    h.hooks.set('view.abort', ({ payload }) => {
      if (mode === 'transport') throw new Error('settlement transport failed')
      return { ok: true, version: '1.0', key: payload, aborted: false, presented: true, inputEnabled: false,
        permit: { version: '1.0', key: payload, epoch: '999', permitId: 'foreign' } }
    })
    await assert.rejects(h.client.presentPrepared(prepared), /timed out/)
    const unresolved = h.client.active
    assert.equal(h.presenter.current, h.candidates[0])
    assert.equal(h.candidates[0].disposeCount, 0, 'the old presenter timer cannot retract a pending native final')
    await assert.rejects(h.client.present({ revision: 2 }), /exact terminal outcome/)
    assert.equal(h.client.active, unresolved)
    await assert.rejects(h.client.dispose(), /cleanup failed/)
    assert.equal(h.candidates[0].disposeCount, 0)
    assert.equal(h.releases.length, 0)
  })
})

test('template input gate failure after actual ACK retains the publication and drains predecessor resources', async t => {
  const h = harness(t)
  await h.client.present({ revision: 1 })
  const prepared = await h.client.prepareTemplate({ revision: 2 }); let nativeAccepted = false
  h.hooks.set('view.presented', ({ respond }) => { nativeAccepted = true; return respond() })
  h.client.inputGate = () => { if (nativeAccepted) throw new Error('input gate failed after template ACK'); return true }
  await assert.rejects(h.client.presentPrepared(prepared), /input gate failed after template ACK/)
  assert.equal(h.presenter.current, h.candidates[1])
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.candidates[1].disposeCount, 0)
  assert.deepEqual(h.client.accepted.key, prepared.key)
  assert.equal(h.client.accepted.inputEnabled, false)
  assert.equal(h.calls.some(call => call.op === 'view.abort'), false)
  assert.equal((await h.client.releasePrepared(prepared)).acknowledged, true)
})

test('native retirement after unknown template shutdown permits a fresh exact DOM/resource drain', async t => {
  const h = harness(t)
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  h.hooks.set('view.presented', () => { throw new Error('ACK delivery uncertain') })
  h.hooks.set('view.abort', () => { throw new Error('settlement delivery failed') })
  await assert.rejects(h.client.presentPrepared(prepared))
  const originalShutdown = h.client.dispose()
  await assert.rejects(originalShutdown)
  assert.equal(h.candidates[0].disposeCount, 0)
  await h.client.retireRemotePresenter(Promise.resolve({ version: '1.0', retired: true,
    previousPresenterBinding: { sessionId: 'session' } }))
  await tick()
  const renewedShutdown = h.client.dispose()
  assert.notEqual(renewedShutdown, originalShutdown)
  await renewedShutdown
  await assert.rejects(originalShutdown)
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.releases.length, 1)
})

test('timeouts, malformed submissions and explicit cancellation retain old pixels and clean known runtime candidates', async t => {
  const h = harness(t, { timeoutMs: 30 })
  await h.client.present({ revision: 1 }); await tick()
  h.hooks.set('view.prepare.commit', () => new Promise(() => {}))
  await assert.rejects(h.client.present({ revision: 2 }), /ERR_TIMEOUT|ERR_CANCELLED/)
  assert.equal(h.candidates[1].disposeCount, 1); assert.equal(h.presenter.current, h.candidates[0]); assert.equal(h.calls.at(-1).op, 'view.abort')
  h.hooks.delete('view.prepare.commit')
  h.hooks.set('view.prepare', ({ respond }) => { const result = respond(); result.submission.document.revision = 9007199254740992; return result })
  await assert.rejects(h.client.present({ revision: 3 }), /invalid ViewDocument/)
  assert.equal(h.calls.at(-1).op, 'view.abort')
  h.hooks.delete('view.prepare')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(h.client.present({ revision: 4 }, { signal: controller.signal }), /ERR_CANCELLED/)
  assert.equal(h.candidates[0].interactive, false)
})

test('disposal cancels resource preparation and releases a resolver lease that arrives late', async t => {
  const h = harness(t), resource = deferred()
  await h.client.present({ revision: 1 }); await tick()
  let resolving = false, released = 0
  h.presenter.resolveResource = () => { resolving = true; return resource.promise }
  const cancelled = assert.rejects(h.client.present({ revision: 2 }), /ERR_CANCELLED/)
  while (!resolving) await tick()
  await h.client.dispose(); await cancelled
  resource.resolve({ url: 'blob:late-resource', release: () => released++ })
  await tick()
  assert.equal(released, 1); assert.equal(h.releases.length, 1)
  assert.ok(h.candidates.every(candidate => candidate.disposeCount === 1)); assert.equal(h.transport.disposed, true)
  assert.ok(h.calls.some(call => call.op === 'view.abort'))
})


test('split preparation exposes frozen clone-time facts before permit, swap or ACK', async t => {
  const h = harness(t, { timeoutMs: 500 })
  h.hooks.set('view.prepare', ({ respond }) => {
    const result = respond(); result.scheduling = consumedScheduling(result.submission); return result
  })
  const prepared = await h.client.prepareTemplate({ revision: 31 }, { hostContext: { previewEpoch: '4' } })
  assert.deepEqual(h.calls.map(call => call.op), ['view.prepare'])
  assert.equal(h.presenter.current, null)
  assert.equal(h.client.accepted, null)
  assert.equal(h.candidates[0].visible, false)
  assert.equal(h.candidates[0].interactive, false)
  assert.deepEqual(Object.keys(prepared).sort(), ['key', 'releaseMode', 'scheduling'])
  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(Object.isFrozen(prepared.key), true)
  assert.equal(Object.isFrozen(prepared.scheduling.consumedInput.viewport), true)
  assert.equal(prepared.candidate, undefined)
  assert.equal(prepared.permit, undefined)
  assert.equal(prepared.scheduling.consumedInput.templateRevision, '18446744073709551615')
  assert.equal(h.calls[0].options.hostContext.previewEpoch, '4')
  const outcome = await h.client.presentPrepared(prepared)
  await h.client.turn
  assert.deepEqual(outcome.key, prepared.key)
  assert.equal(outcome.scheduling, prepared.scheduling)
  assert.equal(outcome.inputEnabled, true)
  assert.equal(h.candidates[0].interactive, true)
  assert.equal(h.calls.filter(call => call.op === 'view.prepare').length, 1)
  assert.equal(h.calls.filter(call => call.op === 'view.prepare.commit').length, 1)
  assert.equal(h.calls.filter(call => call.op === 'view.presented').length, 1)
})

test('split transaction requires explicit release and returns one exact release barrier', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  await assert.rejects(h.client.prepareTemplate({ revision: 2 }), /release the current/)
  assert.equal(h.calls.filter(call => call.op === 'view.prepare').length, 1)
  const released = h.client.releasePrepared(prepared)
  assert.equal(h.client.releasePrepared(prepared), released)
  assert.deepEqual(await released, { released: true, acknowledged: false, remoteAbort: 'confirmed', resourceBarrier: 'strict' })
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.releases.length, 1)
  assert.deepEqual(h.calls.filter(call => call.op === 'view.abort').map(call => call.payload), [prepared.key])
  await assert.rejects(h.client.presentPrepared(prepared), failure => failure.code === 'ERR_CANCELLED')
  const next = await h.client.prepareTemplate({ revision: 2 })
  assert.notDeepEqual(next.key, prepared.key)
  assert.equal((await h.client.presentPrepared(next)).inputEnabled, true)
})

test('releasing an acknowledged split handle retains its pixels and resource leases', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  await h.client.presentPrepared(prepared)
  const released = await h.client.releasePrepared(prepared)
  assert.deepEqual(released, { released: true, acknowledged: true, remoteAbort: 'not-required', resourceBarrier: 'strict' })
  assert.equal(h.candidates[0].disposeCount, 0)
  assert.equal(h.candidates[0].interactive, true)
  assert.equal(h.releases.length, 0)
  assert.equal(h.calls.filter(call => call.op === 'view.abort').length, 0)
  await h.client.present({ revision: 2 })
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.releases.length, 1)
})

test('split publication accepts an exact handle once and rejects forged or foreign handles', async t => {
  const h = harness(t, { timeoutMs: 500 }), other = harness(t, { timeoutMs: 500 })
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  await assert.rejects(h.client.presentPrepared({ ...prepared }), failure => failure.code === 'ERR_CANCELLED')
  await assert.rejects(other.client.presentPrepared(prepared), failure => failure.code === 'ERR_CANCELLED')
  await assert.rejects(other.client.releasePrepared(prepared), failure => failure.code === 'ERR_CANCELLED')
  const publishing = h.client.presentPrepared(prepared)
  await assert.rejects(h.client.presentPrepared(prepared), failure => failure.code === 'ERR_CANCELLED')
  await publishing
  assert.equal(h.calls.filter(call => call.op === 'view.presented').length, 1)
})

test('idle split preparation is cleaned on signal abort before a successor may start', async t => {
  const h = harness(t, { timeoutMs: 500 }), controller = new AbortController(), aborting = deferred()
  const prepared = await h.client.prepareTemplate({ revision: 1 }, { signal: controller.signal })
  h.hooks.set('view.abort', () => aborting.promise)
  controller.abort()
  await tick()
  assert.equal(h.candidates[0].disposeCount, 1)
  await assert.rejects(h.client.prepareTemplate({ revision: 2 }), /release the current/)
  aborting.resolve({ ok: true })
  await h.client.releasePrepared(prepared)
  assert.equal(h.client.active, null)
  const next = await h.client.prepareTemplate({ revision: 2 })
  await h.client.releasePrepared(next)
})

test('legacy replacement waits for the exact split candidate release before sending a new prepare', async t => {
  const h = harness(t, { timeoutMs: 500 }), aborting = deferred()
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  h.hooks.set('view.abort', () => aborting.promise)
  const next = h.client.present({ revision: 2 })
  await tick()
  assert.deepEqual(h.calls.map(call => call.op), ['view.prepare', 'view.abort'])
  assert.deepEqual(h.calls[1].payload, prepared.key)
  assert.equal(h.candidates[0].disposeCount, 1)
  aborting.resolve({ ok: true })
  const outcome = await next
  assert.equal(outcome.inputEnabled, true)
  assert.equal(h.calls.filter(call => call.op === 'view.prepare').length, 2)
})

test('authority invalidation retires an idle split candidate without publishing it', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  h.client.updateAuthority({ ...identity, revision: '2', surfaceGeneration: '1' })
  await h.client.releasePrepared(prepared)
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.client.accepted, null)
  assert.equal(h.calls.some(call => ['view.prepare.commit', 'view.presented'].includes(call.op)), false)
  await assert.rejects(h.client.presentPrepared(prepared), failure => failure.code === 'ERR_CANCELLED')
  const next = await h.client.prepareTemplate({ revision: 2 })
  assert.equal(next.key.surfaceGeneration, '1')
  await h.client.releasePrepared(next)
})

test('disconnect release reports unavailable remote cleanup and never admits stale input', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  h.client.disconnect('offline')
  assert.deepEqual(await h.client.releasePrepared(prepared), { released: true, acknowledged: false, remoteAbort: 'unavailable', resourceBarrier: 'strict' })
  assert.equal(h.calls.filter(call => call.op === 'view.abort').length, 0)
  assert.equal(h.candidates[0].disposeCount, 1)
  h.client.reconnect()
  await assert.rejects(h.client.presentPrepared(prepared), failure => failure.code === 'ERR_CANCELLED')
  const next = await h.client.prepareTemplate({ revision: 2 })
  await h.client.presentPrepared(next)
  assert.equal(h.candidates[1].interactive, true)
})

test('split release failures are observable and do not send a final presentation ACK', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  h.hooks.set('view.abort', () => ({ ok: false, error: { code: 'ERR_RENDER', message: 'remote release failed' } }))
  const releasing = h.client.releasePrepared(prepared)
  assert.equal(h.client.releasePrepared(prepared), releasing)
  await assert.rejects(releasing, failure => failure.code === 'ERR_RENDER' && failure.cleanupErrors.some(item => /remote release failed/.test(item.message)))
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.client.active, null)
  assert.equal(h.calls.some(call => ['view.prepare.commit', 'view.presented'].includes(call.op)), false)
  assert.ok(h.diagnostics.some(value => /remote release failed/.test(value.message)))
})

test('prepare-time state callback invalidation cannot return an already-retired split handle', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const state = h.client.onState
  h.client.onState = value => {
    state(value)
    if (value.phase === 'prepared') h.client.updateAuthority({ ...identity, revision: '2', surfaceGeneration: '1' })
  }
  await assert.rejects(h.client.prepareTemplate({ revision: 1 }), failure => failure.code === 'ERR_CANCELLED')
  await h.client.turn
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.calls.some(call => ['view.prepare.commit', 'view.presented'].includes(call.op)), false)
})

test('committed callback invalidation before ACK rejects and releases the actual candidate resources', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const state = h.client.onState
  h.client.onState = value => {
    state(value)
    if (value.phase === 'committed') h.client.updateAuthority({ ...identity, revision: '2', surfaceGeneration: '1' })
  }
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  await assert.rejects(h.client.presentPrepared(prepared), failure => failure.code === 'ERR_CANCELLED')
  const released = await h.client.releasePrepared(prepared)
  assert.deepEqual(released, { released: true, acknowledged: false, remoteAbort: 'confirmed', resourceBarrier: 'strict' })
  assert.equal(h.calls.filter(call => call.op === 'view.prepare.commit').length, 1)
  assert.equal(h.calls.filter(call => call.op === 'view.presented').length, 0)
  assert.deepEqual(h.calls.filter(call => call.op === 'view.abort').map(call => call.payload), [prepared.key])
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.candidates[0].interactive, false)
  assert.equal(h.releases.length, 1, 'unacknowledged resource lease was actually released')
  assert.equal(h.client.accepted, null)
})

test('ready callback invalidation returns the real acknowledged final with input disabled', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const state = h.client.onState
  h.client.onState = value => {
    state(value)
    if (value.phase === 'ready') h.client.updateAuthority({ ...identity, revision: '2', surfaceGeneration: '1' })
  }
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  const final = await h.client.presentPrepared(prepared)
  assert.deepEqual(final.key, prepared.key)
  assert.equal(final.receipt, h.presenter.currentEntry.receipt)
  assert.equal(final.inputEnabled, false)
  assert.equal(h.calls.filter(call => call.op === 'view.presented').length, 1)
  assert.equal(h.calls.filter(call => call.op === 'view.abort').length, 0)
  assert.equal(h.releases.length, 0, 'real ACK keeps the accepted resource lease')
  assert.equal(h.candidates[0].disposeCount, 0)
  assert.equal(h.candidates[0].interactive, false)
  assert.equal(h.client.accepted.inputEnabled, false)
  assert.equal((await h.client.releasePrepared(prepared)).acknowledged, true)
})

test('dispose is a stable barrier through idle split cleanup and reentrant callbacks', async t => {
  const h = harness(t, { timeoutMs: 500 }), aborting = deferred()
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  h.hooks.set('view.abort', () => aborting.promise)
  let reentrant
  const suspend = h.presenter.suspendInput.bind(h.presenter)
  h.presenter.suspendInput = () => { suspend(); reentrant = h.client.dispose() }
  const closing = h.client.dispose()
  assert.equal(reentrant, closing)
  assert.equal(h.client.dispose(), closing)
  await tick()
  assert.equal(h.transport.disposed, undefined)
  assert.equal(h.candidates[0].disposeCount, 1)
  aborting.resolve({ ok: true })
  await closing
  assert.equal(h.transport.disposed, true)
  assert.equal(h.candidates[0].disposeCount, 1)
  assert.deepEqual(await h.client.releasePrepared(prepared), { released: true, acknowledged: false, remoteAbort: 'confirmed', resourceBarrier: 'strict' })
})


test('synchronous suspension callback disposal cannot enqueue a later application prepare', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const suspend = h.presenter.suspendInput.bind(h.presenter)
  let closing
  h.presenter.suspendInput = () => { suspend(); closing = h.client.dispose() }
  await assert.rejects(h.client.prepareTemplate({ revision: 1 }), failure => failure.code === 'ERR_CANCELLED')
  await closing
  assert.equal(h.calls.length, 0)
  assert.equal(h.candidates.length, 0)
  assert.equal(h.transport.disposed, true)
})


test('strict split validates the versioned presenter contract before any runtime preparation or replacement', async t => {
  for (const fault of ['missing method', 'wrong version', 'false acquisition claim', 'unknown field']) await t.test(fault, async child => {
    const h = harness(child)
    const contract = h.presenter.candidateReleaseContract.bind(h.presenter)
    if (fault === 'missing method') h.presenter.drainCandidate = undefined
    else h.presenter.candidateReleaseContract = () => ({ ...contract(), ...(fault === 'wrong version' ? { version: '2.0' } : fault === 'false acquisition claim' ? { pendingAcquisitions: false } : { fake: true }) })
    await assert.rejects(h.client.prepareTemplate({ revision: 1 }), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(h.calls.length, 0); assert.equal(h.candidates.length, 0); assert.equal(h.client.active, null)
  })
})

test('generic strict release 1.0 remains usable without the Worker durable input capability', async t => {
  const h = harness(t, { timeoutMs: 500 })
  const confirm = h.presenter.confirmAsync.bind(h.presenter)
  h.presenter.inputGuardContract = undefined
  // Model an existing strict presenter that accepts only the original options.
  h.presenter.confirmAsync = (receipt, { inputEnabled, timeoutMs } = {}) => confirm(receipt, { inputEnabled, timeoutMs })
  assert.equal(h.client.strictPresenterContract().version, '1.0')
  const prepared = await h.client.prepareTemplate({ revision: 1 })
  assert.equal((await h.client.presentPrepared(prepared)).inputEnabled, true)
  assert.deepEqual(await h.client.releasePrepared(prepared), { released: true, acknowledged: true, remoteAbort: 'not-required', resourceBarrier: 'strict' })
  assert.equal(h.calls.filter(call => call.op === 'view.presented').length, 1)
  assert.equal(h.calls.some(call => call.op === 'view.abort'), false)
})

test('legacy full present and explicit legacy split support old presenters without claiming a resource barrier', async t => {
  const h = harness(t)
  for (const method of ['candidateReleaseContract', 'releaseCandidate', 'drainCandidate', 'confirmAsync', 'disposeAsync', 'drainDisposal']) h.presenter[method] = undefined
  assert.equal((await h.client.present({ revision: 1 })).inputEnabled, true)
  const prepared = await h.client.prepareTemplate({ revision: 2 }, { releaseMode: 'legacy' })
  assert.equal(prepared.releaseMode, 'legacy')
  assert.deepEqual(await h.client.releasePrepared(prepared), { released: true, acknowledged: false, remoteAbort: 'confirmed', resourceBarrier: 'legacy' })
  assert.equal(h.candidates[1].disposeCount, 1)
  await assert.rejects(h.client.prepareTemplate({ revision: 3 }), failure => failure.code === 'ERR_PROTOCOL_VERSION')
  assert.equal(h.calls.filter(value => value.op === 'view.prepare').length, 2)
})

test('a claimed presenter contract cannot turn false or mismatched release outcomes into success', async t => {
  for (const fault of ['false', 'foreign handle', 'wrong key', 'pending', 'retained', 'extra field']) await t.test(fault, async child => {
    const h = harness(child), real = h.presenter.releaseCandidate.bind(h.presenter)
    const prepared = await h.client.prepareTemplate({ revision: 1 })
    h.presenter.releaseCandidate = async (...args) => {
      const result = await real(...args)
      return fault === 'false' ? false : { ...result, ...(fault === 'foreign handle' ? { handle: {} } : fault === 'wrong key' ? { key: { ...result.key, presentationRevision: '999' } } : fault === 'pending' ? { cleanupPending: true } : fault === 'retained' ? { status: 'retained' } : { injected: true }) }
    }
    const failed = h.client.releasePrepared(prepared)
    assert.equal(h.client.releasePrepared(prepared), failed)
    await assert.rejects(failed, failure => failure.cleanupErrors.some(value => value.code === 'ERR_PROTOCOL_VERSION'))
    assert.equal(h.calls.some(value => value.op === 'view.abort'), true)
    assert.equal(h.calls.some(value => value.op === 'view.presented'), false)
    assert.equal(h.candidates[0].disposeCount, 1)
  })
})

test('strict client release observes actual asynchronous lease failure and remains a stable rejected barrier', async t => {
  const h = harness(t, { timeoutMs: 500, expectDisposeFailure: true }), revoking = deferred()
  let releases = 0
  h.presenter.resolveResource = () => ({ url: 'blob:async', release() { releases++; return revoking.promise } })
  const prepared = await h.client.prepareTemplate({ revision: 1 }), releasing = h.client.releasePrepared(prepared)
  const rejected = assert.rejects(releasing, failure => failure.code === 'ERR_RENDER' && failure.cleanupErrors.some(value => /cleanup failed/.test(value.message)))
  let settled = false; releasing.catch(() => { settled = true })
  await tick(); assert.equal(settled, false); assert.equal(releases, 1)
  revoking.reject(new Error('real lease failure')); await rejected
  assert.equal(h.client.releasePrepared(prepared), releasing)
  assert.equal(h.client.active, null); assert.equal(h.candidates[0].disposeCount, 1)
  assert.equal(h.calls.filter(value => value.op === 'view.abort').length, 1)
  await assert.rejects(h.client.dispose(), /client cleanup failed/)
  assert.equal(h.transport.disposed, true)
})

test('strict confirmation checks exact returned identity after the irreversible runtime ACK', async t => {
  for (const fault of ['handle', 'key', 'receipt', 'pending', 'version']) await t.test(fault, async child => {
    const h = harness(child), confirm = h.presenter.confirmAsync.bind(h.presenter)
    h.presenter.confirmAsync = async (...args) => {
      const result = await confirm(...args)
      return { ...result, ...(fault === 'handle' ? { handle: {} } : fault === 'key' ? { key: { ...result.key, pageId: '999' } } : fault === 'receipt' ? { receipt: { ...result.receipt } } : fault === 'pending' ? { cleanupPending: true } : { version: '2.0' }) }
    }
    const prepared = await h.client.prepareTemplate({ revision: 1 })
    await assert.rejects(h.client.presentPrepared(prepared), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(h.calls.filter(value => value.op === 'view.presented').length, 1)
    assert.equal(h.calls.some(value => value.op === 'view.abort'), false)
    assert.equal(h.presenter.current, h.candidates[0]); assert.equal(h.candidates[0].interactive, false)
    await assert.rejects(h.client.releasePrepared(prepared), /transaction release failed/)
  })
})

test('strict client keeps accepted input frozen until predecessor asynchronous release actually settles', async t => {
  const h = harness(t, { timeoutMs: 500 }), revoking = deferred()
  let revision = 0
  h.presenter.resolveResource = () => ({ url: `blob:${++revision}`, release: () => revision === 2 ? revoking.promise : undefined })
  const first = await h.client.prepareTemplate({ revision: 1 }); await h.client.presentPrepared(first)
  const second = await h.client.prepareTemplate({ revision: 2 }), publishing = h.client.presentPrepared(second)
  await tick()
  assert.equal(h.client.accepted.inputEnabled, false); assert.equal(h.candidates[1].interactive, false)
  assert.equal(h.calls.filter(value => value.op === 'view.presented').length, 2)
  revoking.resolve(); assert.equal((await publishing).inputEnabled, true)
  assert.equal(h.client.accepted.inputEnabled, true); assert.equal(h.candidates[1].interactive, true)
})

test('late resource acquisition failure is retained through strict prepare cancellation and final cleanup', async t => {
  const h = harness(t, { timeoutMs: 500, expectDisposeFailure: true }), acquiring = deferred(), started = deferred(), controller = new AbortController()
  h.presenter.resolveResource = () => { started.resolve(); return acquiring.promise }
  const preparing = h.client.prepareTemplate({ revision: 1 }, { signal: controller.signal })
  const failed = assert.rejects(preparing, failure => failure.code === 'ERR_CANCELLED' && failure.cleanupErrors?.length > 0)
  await started.promise; controller.abort()
  acquiring.resolve({ url: 'blob:late', release: () => Promise.reject(new Error('late acquired release failed')) })
  await failed
  await assert.rejects(h.client.dispose(), /client cleanup failed/)
  assert.equal(h.transport.disposed, true); assert.equal(h.calls.some(value => value.op === 'view.presented'), false)
})

test('strict final disposal validates exact versioned shutdown outcome and still closes transport', async t => {
  const h = harness(t, { expectDisposeFailure: true }), dispose = h.presenter.disposeAsync.bind(h.presenter)
  const prepared = await h.client.prepareTemplate({ revision: 1 }); await h.client.releasePrepared(prepared)
  h.presenter.disposeAsync = async (...args) => ({ ...(await dispose(...args)), presenter: {} })
  const closing = h.client.dispose(); assert.equal(h.client.dispose(), closing)
  await assert.rejects(closing, failure => failure.cleanupErrors.some(value => value.code === 'ERR_PROTOCOL_VERSION'))
  assert.equal(h.transport.disposed, true)
})
