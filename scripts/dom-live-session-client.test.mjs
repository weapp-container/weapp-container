import assert from 'node:assert/strict'
import test from 'node:test'
import { DomLiveSessionClient, waitForDomLiveReady } from '../examples/hosts/web-wasm/dom-live-session-client.mjs'

// These doubles exercise bridge authority and resource ownership. They neither
// emulate native composition nor provide browser/IME continuity evidence.
const clone = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const owner = { documentId: 'pages/home.wxml', eventOwner: null }
const viewport = { width: 375, height: 667 }
const documentFor = revision => ({ version: '1.0', sessionId: 'session', pageId: 1, revision, routePath: 'pages/home', profile: 'webview',
  nodes: [{ kind: 'element', occurrenceId: 'root', tag: 'view', attrs: {}, typedAttrs: {}, ownership: owner, events: [], children: [] }], styleRoots: [], styles: [], resources: [] })
const keyFor = revision => ({ sessionId: 'session', pageId: '1', documentRevision: String(revision), presentationRevision: String(revision), surfaceGeneration: '7', profile: 'webview' })
const liveContract = { version: '2.0', documentPermit: true, liveGeometryFinalization: true, nativeEditing: false, finalReplay: true,
  inputLifetimeRevision: '3', permitTtlMs: 5000, maxRetainedRequests: 32, maxRetainedBytes: 8388608, requiresOwnerReplacementWhenFull: true }
function harness(options = {}) {
  const version = options.liveVersion ?? '2.0', laneId = '0123456789abcdef0123456789abcdef'
  const h = { calls: [], deliveries: [], candidates: [], plans: [], inert: [], now: 100, currentOwner: true, revision: 0, runtimeCurrent: null,
    runtimePending: null, finals: new Map(), lost: new Set(options.lost ?? []), surfaceDisposals: 0, highestSequence: 0n, retiredThrough: 0n, consumptions: [] }
  const document = { defaultView: { CSS: { supports: () => true } }, querySelector() {}, close() { assert.fail('borrowed Document must not close') } }
  let inert = options.initialInert ?? false
  const mount = { ownerDocument: document, iframe: { preserved: true },
    get inert() { const value = inert; options.onInertRead?.(h, value); return value },
    set inert(value) { options.onInertWrite?.(h, value); inert = value; h.inert.push(value) } }
  document.body = mount; h.document = document; h.mount = mount
  h.prepare = async (source, size, setup) => {
    options.onPrepare?.(h, setup)
    const plan = { document: source, viewport: size, allElements: new Map(), urls: [], disposed: 0,
      dispose() { this.disposed++; return [] }, async disposeAsync() { this.disposed++; return [] } }
    h.plans.push(plan); return plan
  }
  h.createSurface = setup => {
    const surface = { current: null, pending: null, nodes: new Map(), document, root: { owned: true }, node: id => surface.nodes.get(id),
      prepare(plan, context) {
        assert.equal(Object.hasOwn(context, 'editing'), false, 'v2 client grants no local editing lease')
        assert.ok(context.runtimeIdentities instanceof Map); assert.deepEqual([...context.runtimeIdentities], [['root', String(h.revision)]])
        const candidate = { key: clone(context.presentationKey), baseKey: surface.current?.key ?? null, state: 'prepared', rollbacks: 0, acknowledgements: 0,
          lastUses: [], plan, receipt: null,
          apply(permit) {
            assert.equal(mount.inert, true, 'native input is frozen before any live write')
            assert.equal(setup.authorizePermit({ candidate, key: candidate.key, baseKey: candidate.baseKey, permit }), true)
            candidate.permit = permit; candidate.state = 'applied'; options.onApply?.(h, candidate)
            assert.equal(setup.authorizePermit({ candidate, key: candidate.key, baseKey: candidate.baseKey, permit }), true)
            return candidate.receipt = Object.freeze({ version: '2.0', key: candidate.key, phase: 'applied', continuity: 'not-requested' })
          },
          measure() {
            assert.equal(candidate.state, 'applied'); h.measured = (h.measured ?? 0) + 1
            return { key: candidate.key, viewport, nodes: [{ occurrenceId: 'root', borderBox: { x: 1.25, y: -2, width: 300, height: 50 },
              scrollOffset: { x: 0, y: 2 }, scrollExtent: { width: 300, height: 100 }, clientSize: { width: 300, height: 50 } }] }
          },
          acknowledge(ack) {
            assert.equal(setup.authorizeAck({ candidate, permit: candidate.permit, receipt: candidate.receipt, ack }), true)
            candidate.acknowledgements++; candidate.state = 'acknowledged'; surface.current = candidate; surface.pending = null
            options.onAck?.(h, candidate)
          },
          rollback() {
            assert.notEqual(candidate.state, 'acknowledged'); candidate.rollbacks++; candidate.state = 'rolled-back'; surface.pending = null
          },
          retainUntil(promise) { candidate.lastUses.push(promise); return promise },
          async disposeAsync() { await Promise.allSettled(candidate.lastUses); options.onDispose?.(h, candidate); return plan.disposeAsync() },
          async drainAsync() { await options.drain?.(h, candidate); return { status: 'settled', cleanupPending: false } },
        }
        surface.pending = candidate; h.candidates.push(candidate); return candidate
      },
      async disposeAsync() {
        assert.equal(surface.pending, null, 'shutdown cannot dispose an uncertain/applied journal')
        h.surfaceDisposals++; surface.current = null
        for (const plan of h.plans) if (!plan.disposed) await plan.disposeAsync()
        return { status: 'disposed', cleanupPending: false }
      },
    }
    h.surface = surface; h.authority = setup; return surface
  }
  h.response = (request, payload) => ({ messages: [{ protocolVersion: '1.0', sessionId: request.sessionId, requestId: request.requestId, kind: 'response', op: request.op, payload },
    ...(request.op === 'view.live.consume' ? [] : [{ protocolVersion: '1.0', sessionId: request.sessionId, requestId: request.requestId, kind: 'effect', op: 'test.effect', payload: { requestId: request.requestId } }])] })
  h.runtime = request => {
    if (request.op === 'view.live.consume') {
      const input = request.payload, through = BigInt(input.through)
      assert.equal(version, '2.1'); assert.equal(input.version, '2.1'); assert.equal(input.laneId, laneId); assert.equal(input.inputLifetimeRevision, '3')
      assert.equal(request.requestId, `live-consume:${laneId}:${through}`)
      if (through > h.retiredThrough) {
        assert.equal(input.receipts.length, Number(through - h.retiredThrough))
        for (let sequence = h.retiredThrough + 1n; sequence <= through; sequence++) {
          const record = input.receipts[Number(sequence - h.retiredThrough - 1n)], original = h.finals.get(`live:${laneId}:${sequence}`)
          assert.ok(original); assert.deepEqual(record, { sequence: String(sequence), token: original.messages[0].payload.consumptionReceipt })
        }
        for (let sequence = h.retiredThrough + 1n; sequence <= through; sequence++) h.finals.delete(`live:${laneId}:${sequence}`)
        h.retiredThrough = through
      }
      h.consumptions.push(request)
      return h.response(request, { ok: true, consumedThrough: String(through) })
    }
    if (h.finals.has(request.requestId)) return clone(h.finals.get(request.requestId))
    const input = request.payload
    if (version === '2.1' && request.op !== 'view.live.enable') {
      const sequence = ++h.highestSequence
      assert.deepEqual(input.transaction, { laneId, sequence: String(sequence) }); assert.equal(request.requestId, `live:${laneId}:${sequence}`)
      assert.equal(input.version, '2.1')
    }
    let payload
    switch (request.op) {
      case 'view.live.enable': assert.deepEqual(input, { version }); payload = { ok: true, contract: { ...liveContract, version,
        ...(version === '2.1' ? { requiresOwnerReplacementWhenFull: false, transactionRetention: { version: '1.0', laneId, firstSequence: '1', explicitConsumption: true } } : {}), ...options.contract } }; break
      case 'view.live.prepare': {
        assert.equal(mount.inert, true); assert.equal(input.inputLifetimeRevision, '3'); assert.equal(input.surfaceGeneration, '7')
        const revision = ++h.revision, key = keyFor(revision)
        h.runtimePending = { version, key, baseKey: h.runtimeCurrent, documentToken: `document:${revision}:7:3`, inputLifetimeRevision: '3',
          runtimeIdentities: { root: String(revision) }, viewport, document: documentFor(revision) }
        payload = { ok: true, submission: clone(h.runtimePending) }; break
      }
      case 'view.live.permit': {
        assert.deepEqual(Object.keys(input).sort(), ['baseKey', 'documentToken', 'inputLifetimeRevision', 'key', ...(version === '2.1' ? ['transaction'] : []), 'version'])
        assert.equal(input.documentToken, h.runtimePending.documentToken); assert.deepEqual(input.baseKey, h.runtimePending.baseKey)
        payload = { ok: true, permit: { version, key: input.key, baseKey: input.baseKey, documentToken: input.documentToken,
          inputLifetimeRevision: '3', permitId: `live:${h.revision}:7:3`, ttlMs: options.contract?.permitTtlMs ?? 5000 } }; break
      }
      case 'view.live.presented':
        assert.equal(mount.inert, true); assert.equal(input.geometry.version, '1.0'); assert.equal(typeof input.geometry.epoch, 'string')
        assert.deepEqual(input.geometry.key, h.runtimePending.key); h.runtimeCurrent = h.runtimePending.key; h.runtimePending = null
        payload = { ok: true, committed: true, key: h.runtimeCurrent, inputEnabled: true }; break
      case 'view.live.abort':
        assert.equal(input.documentToken, h.runtimePending.documentToken); h.runtimePending = null
        if (!options.restoreAbort) h.runtimeCurrent = null
        payload = { ok: true, key: input.key, inputEnabled: !!(options.restoreAbort && h.runtimeCurrent),
          ...(options.restoreAbort && h.runtimeCurrent ? { restoredKey: h.runtimeCurrent, inputLifetimeRevision: '3' } : {}) }; break
      default: assert.fail(`unexpected op ${request.op}`)
    }
    if (version === '2.1' && request.op !== 'view.live.enable') payload.consumptionReceipt = `receipt:${input.transaction.sequence}`
    const batch = h.response(request, payload); h.finals.set(request.requestId, clone(batch)); return batch
  }
  h.dispatch = async request => {
    assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.payload), true)
    h.calls.push(request)
    const batch = h.runtime(request)
    if (h.lost.delete(request.op)) throw new Error(`lost ${request.op}`)
    return options.dispatch ? options.dispatch(h, request, batch) : batch
  }
  h.client = new DomLiveSessionClient({ document, sessionId: 'session', dispatchEnvelope: h.dispatch, prepareDocument: h.prepare,
    createSurface: h.createSurface, waitForReady: options.ready ?? (() => {}), isCurrent: () => options.ownerFence ? options.ownerFence(h) : h.currentOwner,
    clock: () => h.now, requestIdPrefix: 'test', timeoutMs: options.timeoutMs ?? 1000, initialEpoch: options.initialEpoch ?? '0', liveVersion: version,
    onBatch(batch) { h.deliveries.push(batch); return options.onBatch?.(h, batch) } })
  h.present = () => h.client.prepareAndPresent({ render: { viewport }, surfaceGeneration: '7' })
  return h
}

for (const liveVersion of ['2.0', '2.1']) test(`${liveVersion} exact abort restores the retained physical base after failed readiness and original-final replay`, async () => {
  const h = harness({ liveVersion, restoreAbort: true, ready({ candidate }) { if (candidate.key.documentRevision === '2') throw new Error('candidate font failed') } })
  await h.client.negotiate(); await h.present()
  const previous = h.client.accepted, surface = h.surface.current
  h.lost.add('view.live.abort')
  await assert.rejects(h.present(), error => error.code === 'ERR_UNCERTAIN')
  assert.equal(h.client.inputEnabled, false); assert.equal(h.mount.inert, true); assert.equal(h.candidates[1].rollbacks, 0)
  const original = h.client.pendingRequest
  await assert.rejects(h.client.recoverOriginalFinal(), /candidate font failed/)
  assert.equal(h.calls.at(-1), original); assert.equal(h.client.accepted, previous); assert.equal(h.surface.current, surface)
  assert.equal(h.candidates[1].rollbacks, 1); assert.equal(h.plans[1].disposed, 1)
  assert.equal(h.client.inputEnabled, true); assert.equal(h.mount.inert, false)
  if (liveVersion === '2.1') { await h.client.consumeCompleted(); assert.equal(h.client.retention.requests, 0) }
  await h.client.disposeAsync()
})

for (const reason of ['old-host', 'wrong-key', 'wrong-lifetime', 'retired', 'callback-failed', 'cleanup-failed', 'changed-surface']) test(`live abort restoration stays frozen for ${reason}`, async () => {
  const h = harness({ restoreAbort: reason !== 'old-host', ready({ candidate }) { if (candidate.key.documentRevision === '2') throw new Error('candidate image failed') },
    dispatch(h, request, batch) {
      if (request.op === 'view.live.abort') {
        const final = batch.messages[0].payload
        if (reason === 'wrong-key') final.restoredKey = keyFor(999)
        if (reason === 'wrong-lifetime') final.inputLifetimeRevision = '4'
        if (reason === 'retired') h.client.invalidate()
        if (reason === 'changed-surface') h.surface.current = { key: keyFor(999) }
      }
      return batch
    }, onBatch(h, batch) { if (reason === 'callback-failed' && batch.messages[0].op === 'view.live.abort') throw new Error('abort callback failed') },
    onDispose(h, candidate) { if (reason === 'cleanup-failed' && candidate.key.documentRevision === '2') throw new Error('candidate cleanup failed') } })
  await h.client.negotiate(); await h.present()
  const previous = h.client.accepted
  await assert.rejects(h.present(), /candidate image failed/)
  assert.equal(h.client.accepted, previous); assert.equal(h.client.inputEnabled, false); assert.equal(h.mount.inert, true)
  await h.client.disposeAsync()
})

for (const phase of ['accepted', 'restored']) for (const reentry of ['owner-fence', 'inert-write', 'inert-read', 'close-inert-write']) test(`${phase} native activation stays frozen after synchronous retirement in ${reentry}`, async () => {
  let retired = false, shutdown
  const operation = phase === 'accepted' ? 'view.live.presented' : 'view.live.abort'
  const retire = h => {
    if (!retired && h.calls.at(-1)?.op === operation && h.surface.current?.state === 'acknowledged') {
      retired = true
      if (reentry === 'close-inert-write') shutdown = h.client.disposeAsync()
      else h.client.invalidate('synchronous owner retirement')
    }
  }
  const h = harness({ restoreAbort: true,
    ready({ candidate }) { if (phase === 'restored' && candidate.key.documentRevision === '2') throw new Error('candidate image failed') },
    ownerFence(h) { if (reentry === 'owner-fence') retire(h); return true },
    onInertWrite(h, value) { if (['inert-write', 'close-inert-write'].includes(reentry) && value === false) retire(h) },
    onInertRead(h, value) { if (reentry === 'inert-read' && value === false) retire(h) },
  })
  await h.client.negotiate()
  if (phase === 'restored') { await h.present(); await assert.rejects(h.present(), /candidate image failed/) }
  else assert.equal((await h.present()).committed, true)
  assert.equal(retired, true, 'test must retire the real client during its activation callback')
  if (h.surfaceDisposals === 0) assert.equal(h.mount.inert, true, 'native DOM must already be frozen before any inputEnabled getter can repair it')
  else assert.equal(h.surface.current, null, 'completed shutdown may release borrowed inert only after removing the old native surface')
  assert.equal(h.client.inputEnabled, false)
  assert.equal(h.candidates[0].state, 'acknowledged', 'native retirement cannot undo the genuine first ACK')
  await (shutdown ?? h.client.disposeAsync())
})

test('a borrowed mount read failure after releasing inert refreezes native DOM and retains the genuine ACK', async () => {
  let failed = false
  const h = harness({ onInertRead(h, value) {
    if (!failed && value === false && h.calls.at(-1)?.op === 'view.live.presented') { failed = true; throw new Error('mount read failed') }
  } })
  await h.client.negotiate()
  await assert.rejects(h.present(), error => error.committed === true && /mount read failed/.test(error.message))
  assert.equal(failed, true); assert.equal(h.mount.inert, true)
  assert.equal(h.client.inputEnabled, false); assert.equal(h.client.accepted.key.documentRevision, '1')
  assert.equal(h.candidates[0].state, 'acknowledged'); assert.equal(h.candidates[0].rollbacks, 0)
  await h.client.disposeAsync()
})

test('explicit negotiation, native freeze, pure plan, permit, readiness, actual geometry, irreversible ACK and drain', async () => {
  const order = [], h = harness({ initialEpoch: '9007199254740992', onPrepare(h, setup) {
    order.push('plan'); assert.equal(h.mount.inert, true); assert.equal(setup.presentationKey.surfaceGeneration, '7')
  }, ready: context => { order.push('ready'); assert.equal(context.candidate.state, 'applied'); assert.equal(context.document, h.document) },
  onAck() { order.push('ack') }, drain() { order.push('drain') } })
  assert.equal(h.client.state, 'new'); assert.equal(h.calls.length, 0); assert.equal(h.mount.inert, false)
  await assert.rejects(h.present(), /explicit negotiation/); assert.equal(h.calls.length, 0)
  assert.equal((await h.client.negotiate()).nativeEditing, false)
  const result = await h.present()
  assert.deepEqual(h.calls.map(value => value.op), ['view.live.enable', 'view.live.prepare', 'view.live.permit', 'view.live.presented'])
  assert.deepEqual(order, ['plan', 'ready', 'ack', 'drain']); assert.equal(result.epoch, '9007199254740993')
  assert.equal(result.nativeEditing, false); assert.equal(result.committed, true); assert.equal(h.client.inputEnabled, true); assert.equal(h.mount.inert, false)
  assert.equal(h.candidates[0].acknowledgements, 1); assert.equal(h.candidates[0].rollbacks, 0)
  assert.equal(h.deliveries.length, 4); assert.equal(h.client.accepted.documentToken, 'document:1:7:3')
  assert.equal(h.client.requests.length, new Set(h.calls.map(value => value.requestId)).size)
  assert.ok(h.calls.every(value => value.protocolVersion === '1.0' && value.kind === 'request'))
  await h.client.disposeAsync(); assert.equal(h.document.body, h.mount); assert.equal(h.mount.iframe.preserved, true)
})

test('one in-flight operation is claimed before external dispatch and callbacks, with frozen exact requests', async () => {
  let callbackAttempt, dispatchAttempt
  const h = harness({ dispatch(h, request, batch) {
    if (request.op === 'view.live.prepare') dispatchAttempt = h.client.negotiate().catch(error => error)
    return batch
  }, onBatch(h, batch) { if (batch.messages[0].op === 'view.live.permit') callbackAttempt = h.present().catch(error => error) } })
  await h.client.negotiate(); await h.present()
  assert.match((await callbackAttempt).message, /one live session operation/); assert.match((await dispatchAttempt).message, /one live session operation/)
  assert.throws(() => { h.calls[1].payload.render.viewport.width = 2 }, TypeError)
  assert.equal(h.calls[1].payload.render.viewport.width, 375); await h.client.disposeAsync()
})

for (const operation of ['enable', 'prepare', 'permit', 'presented']) test(`lost ${operation} final keeps the original envelope and only exact replay resumes`, async () => {
  const h = harness({ lost: [`view.live.${operation}`] })
  if (operation !== 'enable') await h.client.negotiate()
  await assert.rejects(operation === 'enable' ? h.client.negotiate() : h.present(), error => error.code === 'ERR_UNCERTAIN')
  const original = h.calls.at(-1), count = h.client.requests.length
  assert.equal(h.client.pendingRequest, original); assert.equal(h.client.state, 'uncertain'); assert.equal(h.client.inputEnabled, false)
  assert.equal(h.candidates.some(candidate => candidate.rollbacks), false)
  await assert.rejects(h.present(), /explicit negotiation/)
  const outcome = await h.client.recoverOriginalFinal()
  assert.equal(h.calls.findLast(value => value.op === original.op), original, 'same object, full envelope and ID')
  assert.equal(h.client.requests.length - count, operation === 'enable' || operation === 'presented' ? 0 : operation === 'prepare' ? 2 : 1)
  assert.equal(h.deliveries.filter(batch => batch.messages[0].requestId === original.requestId).length, 1)
  assert.equal(h.client.state, 'ready'); assert.equal(operation === 'enable' ? outcome.version : outcome.committed, operation === 'enable' ? '2.0' : true)
  await h.client.disposeAsync()
})

test('lost abort final also stays uncertain; rollback follows definitive exact abort recovery', async () => {
  const h = harness({ lost: ['view.live.abort'], ready() { throw new Error('image failed') } })
  await h.client.negotiate(); await assert.rejects(h.present(), error => error.code === 'ERR_UNCERTAIN')
  const original = h.calls.at(-1); assert.equal(original.op, 'view.live.abort'); assert.equal(h.candidates[0].rollbacks, 0)
  await assert.rejects(h.client.recoverOriginalFinal(), /image failed/)
  assert.equal(h.calls.at(-1), original); assert.equal(h.candidates[0].rollbacks, 1); assert.equal(h.plans[0].disposed, 1)
  assert.equal(h.client.state, 'ready'); assert.equal(h.mount.inert, true); await h.client.disposeAsync(); assert.equal(h.mount.inert, false)
})

for (const malformed of ['queued', 'foreign', 'duplicate', 'wrong-protocol']) test(`a ${malformed} batch cannot grant a permit or ACK`, async () => {
  let changed = false
  const h = harness({ dispatch(h, request, batch) {
    if (request.op !== 'view.live.presented' || changed) return batch
    changed = true
    if (malformed === 'queued') batch.messages[0].kind = 'event'
    if (malformed === 'foreign') batch.messages[0].sessionId = 'another-session'
    if (malformed === 'duplicate') batch.messages.push(clone(batch.messages[0]))
    if (malformed === 'wrong-protocol') batch.messages[0].protocolVersion = '0.9'
    return batch
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), error => error.code === 'ERR_UNCERTAIN')
  assert.equal(h.candidates[0].acknowledgements, 0); assert.equal(h.candidates[0].rollbacks, 0)
  assert.equal((await h.client.recoverOriginalFinal()).committed, true); await h.client.disposeAsync()
})

test('indeterminate, pending and retired lifetime replies cannot prove a lost original uncommitted', async () => {
  let override
  const h = harness({ lost: ['view.live.presented'], dispatch(h, request, batch) {
    return request.op === 'view.live.presented' && override ? h.response(request, { ok: false, error: { code: 'ERR_STALE', message: override } }) : batch
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  const original = h.client.pendingRequest
  for (const message of ['live document transaction is already pending; no code was executed', 'browser transaction outcome is indeterminate; request cannot execute again', 'live-document native input lifetime retired']) {
    override = message; await assert.rejects(h.client.recoverOriginalFinal(), { code: 'ERR_UNCERTAIN' })
    assert.equal(h.client.pendingRequest, original); assert.equal(h.candidates[0].rollbacks, 0)
  }
  override = null; assert.equal((await h.client.recoverOriginalFinal()).committed, true); await h.client.disposeAsync()
})

for (const operation of ['prepare', 'permit', 'abort']) test(`transient replay observations never replace the retained ${operation} final`, async () => {
  let override
  const h = harness({ lost: [`view.live.${operation}`], ready() { if (operation === 'abort') throw new Error('readiness failed') },
    dispatch(h, request, batch) { return request.op === `view.live.${operation}` && override
      ? h.response(request, { ok: false, error: { code: 'ERR_STALE', message: override } }) : batch } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  const original = h.client.pendingRequest
  for (const message of ['live document transaction is already pending; no code was executed', 'browser transaction outcome is indeterminate; request cannot execute again', 'live-document native input lifetime retired']) {
    override = message; await assert.rejects(h.client.recoverOriginalFinal(), { code: 'ERR_UNCERTAIN' })
    assert.equal(h.client.pendingRequest, original); assert.equal(h.candidates.some(candidate => candidate.rollbacks), false)
  }
  override = null
  if (operation === 'abort') await assert.rejects(h.client.recoverOriginalFinal(), /readiness failed/)
  else assert.equal((await h.client.recoverOriginalFinal()).committed, true)
  assert.equal(h.calls.filter(request => request.op === original.op).every(request => request === original), true)
  await h.client.disposeAsync()
})

test('permit deadline starts at its original send; replay never renews the lease', async () => {
  const h = harness({ lost: ['view.live.permit'] })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  h.now = 5101
  await assert.rejects(h.client.recoverOriginalFinal(), /permit expired/)
  assert.equal(h.candidates[0].state, 'rolled-back'); assert.equal(h.candidates[0].receipt, null)
  assert.equal(h.calls.at(-1).op, 'view.live.abort'); assert.equal(h.measured, undefined); await h.client.disposeAsync()
})

test('late final after owner invalidation still claims irreversible ACK and leaves input frozen', async () => {
  const final = deferred(), sent = deferred()
  const h = harness({ dispatch(h, request, batch) {
    if (request.op === 'view.live.presented') { sent.resolve(); return final.promise.then(() => batch) }
    return batch
  } })
  await h.client.negotiate(); const presenting = h.present(); await sent.promise
  h.currentOwner = false; h.client.invalidate(); final.resolve()
  const result = await presenting
  assert.equal(result.committed, true); assert.equal(h.candidates[0].acknowledgements, 1); assert.equal(h.candidates[0].rollbacks, 0)
  assert.equal(result.inputEnabled, false); assert.equal(h.mount.inert, true); await h.client.disposeAsync()
})

test('timed-out final observer retains late committed ACK; recovery reuses its original even after lifetime retires', async () => {
  const final = deferred(), sent = deferred(); let replay = false
  const h = harness({ timeoutMs: 20, dispatch(h, request, batch) {
    if (request.op !== 'view.live.presented') return batch
    if (replay) return h.response(request, { ok: false, error: { code: 'ERR_STALE', message: 'live-document native input lifetime retired' } })
    sent.resolve(); return final.promise.then(() => batch)
  } })
  await h.client.negotiate(); const presenting = h.present(); await sent.promise
  await assert.rejects(presenting, { code: 'ERR_UNCERTAIN' }); const original = h.client.pendingRequest
  final.resolve(); await tick(); assert.equal(h.candidates[0].acknowledgements, 1)
  assert.equal(h.client.accepted.epoch, '1'); assert.equal(h.mount.inert, true)
  replay = true; const result = await h.client.recoverOriginalFinal()
  assert.equal(h.calls.at(-1), original); assert.equal(result.committed, true); assert.equal(h.candidates[0].acknowledgements, 1)
  await h.client.disposeAsync()
})

for (const failure of ['retention', 'turn-timeout', 'delivery', 'cleanup']) test(`post-commit ${failure} failure retains accepted DOM and prevents rollback`, async () => {
  let drains = 0
  const h = harness({ dispatch(h, request, batch) {
    if (failure === 'retention' && request.op === 'view.live.presented') {
      const originalResult = batch.messages[0].payload
      batch.messages[0].payload = { ok: false, error: { code: 'ERR_RENDER', message: 'could not retain final' }, committed: true, key: originalResult.key, originalResult }
    }
    if (failure === 'turn-timeout' && request.op === 'view.live.presented') batch.messages[0].payload = {
      ok: false, committed: true, key: batch.messages[0].payload.key, inputEnabled: false,
      error: { code: 'ERR_TIMEOUT', message: 'appservice turn budget exceeded' }, requiresRestart: true,
    }
    return batch
  }, onBatch(h, batch) { if (failure === 'delivery' && batch.messages[0].op === 'view.live.presented') throw new Error('delivery failed') },
  drain() { drains++; if (failure === 'cleanup') throw new Error('cleanup failed') } })
  await h.client.negotiate()
  await assert.rejects(h.present(), error => error.committed === true && error.outcome.committed === true && error.outcome.status === 'accepted-with-error')
  assert.equal(h.candidates[0].acknowledgements, 1); assert.equal(h.candidates[0].rollbacks, 0)
  assert.equal(h.client.accepted.epoch, '1'); assert.equal(h.client.inputEnabled, false); assert.equal(h.mount.inert, true); assert.equal(h.client.state, 'faulted')
  assert.equal(drains, 1, 'an accepted cleanup result is observed exactly once')
  assert.equal(h.calls.some(value => value.op === 'view.live.abort'), false); await h.client.disposeAsync()
})

test('known rejection with no abort retention capacity faults the owner without replaying the previous operation as abort', async () => {
  const h = harness({ contract: { maxRetainedBytes: 5000 }, dispatch(h, request, batch) {
    if (request.op !== 'view.live.permit') return batch
    const rejected = h.response(request, { ok: false, error: { code: 'ERR_RENDER', message: 'permit rejected' } })
    const remaining = h.client.contract.maxRetainedBytes - h.client.retention.bytes - 16
    rejected.messages[0].payload.error.message += 'x'.repeat(remaining - new TextEncoder().encode(JSON.stringify(rejected)).byteLength)
    return rejected
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), error => error.requiresOwnerReplacement === true)
  assert.equal(h.client.state, 'faulted'); assert.equal(h.client.pendingRequest, null); assert.equal(h.candidates[0].rollbacks, 1)
  assert.equal(h.calls.at(-1).op, 'view.live.permit'); assert.equal(h.calls.some(request => request.op === 'view.live.abort'), false)
  await assert.rejects(h.client.recoverOriginalFinal(), /no uncertain/); await h.client.disposeAsync()
})

test('close waits for uncertain final recovery, then removes only surface-owned resources and restores borrowed inert', async () => {
  const h = harness({ lost: ['view.live.presented'] })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  let settled = false; const closing = h.client.disposeAsync().then(value => { settled = true; return value })
  assert.equal(h.client.disposeAsync(), h.client.disposeAsync()); await tick()
  assert.equal(settled, false); assert.equal(h.surfaceDisposals, 0); assert.equal(h.candidates[0].rollbacks, 0); assert.equal(h.mount.inert, true)
  const outcome = await h.client.recoverOriginalFinal(); assert.equal(outcome.committed, true); assert.equal(outcome.inputEnabled, false)
  await closing; assert.equal(h.surfaceDisposals, 1); assert.equal(h.client.state, 'disposed'); assert.equal(h.mount.inert, false)
  assert.equal(h.mount.iframe.preserved, true); assert.equal(h.document.body, h.mount)
})

test('runtime null base after an abort stays distinct from retained local physical base', async () => {
  let readyFailure = false
  const h = harness({ ready() { if (readyFailure) throw new Error('cannot decode') } })
  await h.client.negotiate(); await h.present(); const retained = h.surface.current
  readyFailure = true; await assert.rejects(h.present(), /cannot decode/)
  assert.equal(h.surface.current, retained); assert.equal(h.runtimeCurrent, null)
  readyFailure = false; const outcome = await h.present()
  assert.equal(outcome.committed, true); assert.deepEqual(h.candidates[2].baseKey, retained.key)
  assert.equal(h.calls.filter(value => value.op === 'view.live.permit').at(-1).payload.baseKey, null)
  await h.client.disposeAsync()
})

test('finite retained request budget stops a new attempt before dispatch and reserves an abort slot', async () => {
  const h = harness({ contract: { maxRetainedRequests: 4 } })
  await h.client.negotiate(); await h.present(); const count = h.calls.length
  await assert.rejects(h.present(), /retention budget exhausted/)
  assert.equal(h.calls.length, count); assert.equal(h.client.retention.requests, 3); assert.equal(h.client.inputEnabled, true)
  await h.client.disposeAsync()
})

test('wire object property order carries no presentation identity or geometry authority', async () => {
  const reverse = value => Object.fromEntries(Object.entries(value).reverse())
  const h = harness({ dispatch(h, request, batch) {
    const final = batch.messages[0].payload
    if (request.op === 'view.live.prepare') final.submission.viewport = reverse(final.submission.viewport)
    if (request.op === 'view.live.permit') final.permit.key = reverse(final.permit.key)
    if (request.op === 'view.live.presented') final.key = reverse(final.key)
    return batch
  } })
  await h.client.negotiate(); assert.equal((await h.present()).committed, true); await h.client.disposeAsync()
})

test('retirement after completed shutdown cannot reacquire inert ownership on the borrowed mount', async () => {
  const h = harness(); await h.client.negotiate(); await h.present(); await h.client.disposeAsync()
  assert.equal(h.mount.inert, false); const writes = h.inert.length
  h.client.invalidate(); await h.client.disposeAsync()
  assert.equal(h.inert.length, writes); assert.equal(h.mount.inert, false)
})

test('readiness abort preserves actual live image decoder drains and only clears owned CSS preloads', async () => {
  const liveDecode = deferred(), cssDecode = deferred(), abort = new AbortController(), retained = [], owned = []
  const document = { createElement(tag) { assert.equal(tag, 'img'); const image = { src: '', decode: () => cssDecode.promise,
    removeAttribute(name) { assert.equal(name, 'src'); this.src = '' } }; owned.push(image); return image } }
  const image = { ownerDocument: document, isConnected: true, src: 'blob:live', decode: () => liveDecode.promise }
  const candidate = { retainUntil(promise) { retained.push(promise); return promise } }
  const waiting = waitForDomLiveReady({ document, surface: { node: () => image }, candidate, signal: abort.signal,
    plan: { allElements: new Map([['image', { tag: 'image', imageUrl: 'blob:live' }]]), urls: ['blob:live', 'blob:css'] } })
  await tick(); abort.abort(new Error('retired'))
  await assert.rejects(waiting, /retired/); assert.equal(image.src, 'blob:live'); assert.equal(owned[0].src, '')
  let settled = false; const drain = Promise.allSettled(retained).then(() => { settled = true })
  await tick(); assert.equal(settled, false); liveDecode.resolve(); cssDecode.reject(new Error('cancelled decoder'))
  await drain; assert.equal(settled, true)
})

test('readiness waits fonts then one owned RAF and cancels/settles the RAF on retirement', async () => {
  const fonts = deferred(), abort = new AbortController(), retained = [], callbacks = new Map(); let next = 0, cancelled = 0
  const document = { fonts: { ready: fonts.promise }, defaultView: {
    requestAnimationFrame(callback) { callbacks.set(++next, callback); return next }, cancelAnimationFrame(handle) { assert.ok(callbacks.delete(handle)); cancelled++ },
  } }
  const waiting = waitForDomLiveReady({ document, surface: {}, candidate: { retainUntil(promise) { retained.push(promise) } }, signal: abort.signal,
    plan: { allElements: new Map(), urls: [] } })
  await tick(); assert.equal(callbacks.size, 0); fonts.resolve(); await tick(); assert.equal(callbacks.size, 1)
  abort.abort(new Error('retired')); await assert.rejects(waiting, /retired/)
  await Promise.allSettled(retained); assert.equal(callbacks.size, 0); assert.equal(cancelled, 1)
})

test('2.1 negotiates explicitly, uses its runtime lane and consumes metadata outside business delivery', async () => {
  const h = harness({ liveVersion: '2.1' }); await h.client.negotiate(); await h.present()
  assert.equal(h.client.contract.version, '2.1'); assert.equal(h.client.contract.requiresOwnerReplacementWhenFull, false)
  assert.equal(h.calls[0].requestId, 'live:test:1'); assert.deepEqual(h.calls[0].payload, { version: '2.1' })
  const lane = h.client.contract.transactionRetention.laneId
  assert.deepEqual(h.calls.slice(1).map(request => request.requestId), [1, 2, 3].map(sequence => `live:${lane}:${sequence}`))
  assert.ok(h.calls.slice(1).every(request => request.payload.version === '2.1'))
  assert.equal(h.candidates[0].receipt.version, '2.0', 'surface patch contract remains independent')
  assert.deepEqual(await h.client.consumeCompleted(), { ok: true, consumedThrough: '3' })
  assert.equal(h.calls.at(-1).op, 'view.live.consume'); assert.equal(h.deliveries.length, 4)
  assert.equal(h.client.retention.requests, 0); assert.equal(h.client.retention.inFlightExchanges, 0)
  assert.equal(h.client.requests.length, 1, 'only bounded negotiation remains retained')
  assert.equal(h.client.pendingConsumption, null)
  await h.present(); assert.equal(h.calls.findLast(request => request.op === 'view.live.prepare').payload.transaction.sequence, '4')
  await h.client.consumeCompleted(); await h.client.disposeAsync()
})

test('2.0 retains its owner replacement contract and does not silently enable consumption', async () => {
  const h = harness(); await h.client.negotiate(); await h.present()
  await assert.rejects(h.client.consumeCompleted(), /requires negotiated live 2.1/)
  assert.equal(h.calls.some(request => request.op === 'view.live.consume'), false)
  assert.equal(h.client.retention.requests, 3); await h.client.disposeAsync()
})

test('1000 complete 2.1 presentations keep retained records and byte charges bounded without restarting the session', async () => {
  let deliveries = 0
  const h = harness({ liveVersion: '2.1', contract: { maxRetainedRequests: 4 }, onBatch() { deliveries++ } })
  await h.client.negotiate(); const negotiationBytes = h.client.retention.bytes
  let largest = 0
  for (let index = 0; index < 1000; index++) {
    await h.present(); largest = Math.max(largest, h.client.retention.bytes)
    assert.equal(h.client.retention.requests, 3); await h.client.consumeCompleted()
    assert.equal(h.client.retention.requests, 0); assert.equal(h.client.retention.bytes, negotiationBytes)
    assert.equal(h.client.requests.length, 1); assert.equal(h.finals.size, 1)
  }
  assert.equal(h.revision, 1000); assert.equal(h.client.retention.consumedThrough, '3000'); assert.equal(deliveries, 3001)
  assert.equal(h.calls.filter(request => request.op === 'view.live.enable').length, 1)
  assert.equal(h.client.accepted.key.documentRevision, '1000'); assert.ok(largest < 64 * 1024)
  await h.client.disposeAsync()
})

for (const operation of ['prepare', 'permit', 'presented', 'abort']) test(`2.1 lost ${operation} final prevents consumption until exact original recovery`, async () => {
  const h = harness({ liveVersion: '2.1', lost: [`view.live.${operation}`], ready() { if (operation === 'abort') throw new Error('decoder rejected') } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  const original = h.client.pendingRequest
  await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' }); assert.equal(h.consumptions.length, 0)
  if (operation === 'abort') await assert.rejects(h.client.recoverOriginalFinal(), /decoder rejected/)
  else assert.equal((await h.client.recoverOriginalFinal()).committed, true)
  assert.ok(h.calls.filter(request => request.requestId === original.requestId).every(request => request === original))
  await h.client.consumeCompleted(); assert.equal(h.client.retention.requests, 0)
  assert.equal(h.deliveries.filter(batch => batch.messages[0].requestId === original.requestId).length, 1)
  await h.client.disposeAsync()
})

test('2.1 recovery success cannot compact a still-live original transport or redeliver its late final', async () => {
  const release = deferred(), sent = deferred(); let first = true
  const h = harness({ liveVersion: '2.1', timeoutMs: 10, dispatch(h, request, batch) {
    if (request.op === 'view.live.presented' && first) { first = false; sent.resolve(); return release.promise.then(() => batch) }
    return batch
  } })
  await h.client.negotiate(); const presenting = h.present(); await sent.promise
  await assert.rejects(presenting, { code: 'ERR_UNCERTAIN' }); await h.client.recoverOriginalFinal()
  assert.equal(h.client.retention.inFlightExchanges, 1)
  await assert.rejects(h.client.consumeCompleted(), /actual transport remains unsettled/)
  assert.equal(h.consumptions.length, 0); assert.equal(h.client.retention.requests, 3)
  const bytes = h.client.retention.bytes, deliveries = h.deliveries.length, accepted = h.client.accepted
  release.resolve(); await tick(); assert.equal(h.deliveries.length, deliveries); assert.equal(h.client.accepted, accepted)
  assert.ok(h.client.retention.bytes < bytes, 'the actual exchange releases its own byte charge')
  await h.client.consumeCompleted(); assert.equal(h.client.retention.requests, 0); await h.client.disposeAsync()
})

test('2.1 a late historical committed original cannot rewind a newer accepted presentation before joint prefix consumption', async () => {
  const release = deferred(); let first = true
  const h = harness({ liveVersion: '2.1', timeoutMs: 5, dispatch(h, request, batch) {
    if (request.op === 'view.live.presented' && first) { first = false; return release.promise.then(() => batch) }
    return batch
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' }); await h.client.recoverOriginalFinal()
  await h.present(); const accepted = h.client.accepted, deliveries = h.deliveries.length
  assert.equal(accepted.key.documentRevision, '2'); await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  release.resolve(); await tick(); assert.equal(h.client.accepted, accepted); assert.equal(h.deliveries.length, deliveries)
  assert.deepEqual(await h.client.consumeCompleted(), { ok: true, consumedThrough: '6' })
  assert.equal(h.client.retention.requests, 0); assert.equal(h.surface.current.key.documentRevision, '2')
  await h.client.disposeAsync()
})

test('2.1 lost consumption retains the same envelope and records, blocks new business and recovers once without onBatch', async () => {
  const h = harness({ liveVersion: '2.1', lost: ['view.live.consume'] })
  await h.client.negotiate(); await h.present(); const before = h.client.retention.bytes, deliveries = h.deliveries.length
  await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  const original = h.client.pendingConsumption
  assert.equal(h.client.state, 'consumption-uncertain'); assert.equal(h.client.retention.requests, 3); assert.ok(h.client.retention.bytes > before)
  assert.equal(h.finals.size, 1, 'runtime consumed even though the response was lost')
  await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' }); await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  assert.deepEqual(await h.client.recoverConsumption(), { ok: true, consumedThrough: '3' })
  assert.equal(h.calls.at(-1), original); assert.equal(h.deliveries.length, deliveries); assert.equal(h.client.retention.requests, 0)
  assert.equal(h.client.pendingConsumption, null); assert.equal(h.client.state, 'ready')
  await h.present(); await h.client.consumeCompleted(); await h.client.disposeAsync()
})

test('2.1 consume recovery cannot compact while its timed-out original metadata transport is alive', async () => {
  const release = deferred(); let first = true
  const h = harness({ liveVersion: '2.1', timeoutMs: 10, dispatch(h, request, batch) {
    if (request.op === 'view.live.consume' && first) { first = false; return release.promise.then(() => batch) }
    return batch
  } })
  await h.client.negotiate(); await h.present(); await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  const original = h.client.pendingConsumption
  assert.deepEqual(await h.client.recoverConsumption(), { ok: true, consumedThrough: '3' })
  assert.equal(h.client.pendingConsumption, original); assert.equal(h.client.retention.requests, 3)
  await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  release.resolve(); await tick(); assert.equal(h.client.pendingConsumption, null); assert.equal(h.client.retention.requests, 0)
  await h.client.disposeAsync()
})

test('2.1 a missing receipt preserves committed DOM but remains uncertain and cannot consume until the sealed exact final is recovered', async () => {
  let strip = true
  const h = harness({ liveVersion: '2.1', dispatch(h, request, batch) {
    if (request.op === 'view.live.presented' && strip) delete batch.messages[0].payload.consumptionReceipt
    return batch
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  assert.equal(h.client.state, 'uncertain'); assert.equal(h.candidates[0].acknowledgements, 1); assert.equal(h.candidates[0].rollbacks, 0)
  assert.equal(h.client.inputEnabled, false); await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  strip = false; assert.equal((await h.client.recoverOriginalFinal()).committed, true)
  assert.equal(h.candidates[0].acknowledgements, 1); await h.client.consumeCompleted(); assert.equal(h.client.retention.requests, 0)
  await h.client.disposeAsync()
})

test('2.1 committed indeterminate observation cannot bypass receipt verification or close the original recovery state', async () => {
  let indeterminate = true
  const h = harness({ liveVersion: '2.1', dispatch(h, request, batch) {
    if (request.op === 'view.live.presented' && indeterminate) {
      batch.messages[0].payload = { ok: false, committed: true, key: batch.messages[0].payload.key, inputEnabled: false,
        error: { code: 'ERR_RENDER', message: 'browser transaction outcome is indeterminate; request cannot execute again' } }
    }
    return batch
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  const original = h.client.pendingRequest
  assert.equal(original.op, 'view.live.presented'); assert.equal(h.client.state, 'uncertain')
  assert.equal(h.candidates[0].acknowledgements, 1); assert.equal(h.candidates[0].rollbacks, 0); assert.equal(h.client.inputEnabled, false)
  await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  indeterminate = false; assert.equal((await h.client.recoverOriginalFinal()).committed, true)
  assert.equal(h.client.state, 'ready'); assert.equal(h.candidates[0].acknowledgements, 1)
  assert.equal(h.calls.at(-1), original); await h.client.consumeCompleted(); assert.equal(h.client.retention.requests, 0)
  await h.client.disposeAsync()
})

test('2.1 callback exceptions are once-only and terminal accepted records can still be consumed', async () => {
  const h = harness({ liveVersion: '2.1', onBatch(h, batch) { if (batch.messages[0].op === 'view.live.presented') throw new Error('embedding callback failed') } })
  await h.client.negotiate(); await assert.rejects(h.present(), /embedding callback failed/)
  assert.equal(h.client.state, 'faulted'); assert.equal(h.candidates[0].acknowledgements, 1)
  const count = h.deliveries.length; await h.client.consumeCompleted()
  assert.equal(h.client.retention.requests, 0); assert.equal(h.client.state, 'faulted'); assert.equal(h.deliveries.length, count)
  assert.deepEqual(h.client.cleanupErrors, [{ code: 'ERR_RENDER', message: 'embedding callback failed' }])
  await h.client.disposeAsync()
})

test('2.1 cleanup failures retain records and do not masquerade as an actual drain for consumption', async () => {
  const h = harness({ liveVersion: '2.1', drain() { throw new Error('decoder last use failed') } })
  await h.client.negotiate(); await assert.rejects(h.present(), /decoder last use failed/)
  await assert.rejects(h.client.consumeCompleted(), /cleanup or actual transport remains unsettled/)
  assert.equal(h.consumptions.length, 0); assert.equal(h.client.retention.requests, 3); await h.client.disposeAsync()
})

test('2.1 close waits for actual original and consume settlements instead of treating local timeouts as resource release', async () => {
  const original = deferred(); let first = true
  const h = harness({ liveVersion: '2.1', timeoutMs: 10, dispatch(h, request, batch) {
    if (request.op === 'view.live.consume' && first) { first = false; return original.promise.then(() => batch) }
    return batch
  } })
  await h.client.negotiate(); await h.present(); await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  let closed = false; const closing = h.client.disposeAsync().then(() => { closed = true })
  await h.client.recoverConsumption(); await tick(); assert.equal(closed, false); assert.equal(h.surfaceDisposals, 0)
  original.resolve(); await closing; assert.equal(h.surfaceDisposals, 1); assert.equal(h.client.retention.inFlightExchanges, 0)
})

test('2.1 uncertain recovery jobs have a finite actual settlement budget and cannot allocate unbounded observers', async () => {
  const release = deferred()
  const h = harness({ liveVersion: '2.1', timeoutMs: 5, dispatch(h, request, batch) {
    return request.op === 'view.live.presented' ? release.promise.then(() => batch) : batch
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' })
  for (let index = 0; index < 7; index++) await assert.rejects(h.client.recoverOriginalFinal(), { code: 'ERR_UNCERTAIN' })
  assert.equal(h.client.retention.inFlightExchanges, 8)
  const calls = h.calls.length, bytes = h.client.retention.bytes
  await assert.rejects(h.client.recoverOriginalFinal(), /actual transport settlement budget exhausted/)
  assert.equal(h.calls.length, calls); assert.equal(h.client.retention.bytes, bytes)
  release.resolve(); await tick(); assert.equal(h.client.retention.inFlightExchanges, 0)
  await h.client.recoverOriginalFinal(); assert.equal(h.candidates[0].acknowledgements, 1)
  assert.equal(h.deliveries.filter(batch => batch.messages[0].op === 'view.live.presented').length, 1)
  await h.client.consumeCompleted(); await h.client.disposeAsync()
})

test('2.1 metadata recovery jobs are bounded independently of retained business capacity', async () => {
  const release = deferred()
  const h = harness({ liveVersion: '2.1', timeoutMs: 5, contract: { maxRetainedRequests: 4 }, dispatch(h, request, batch) {
    return request.op === 'view.live.consume' ? release.promise.then(() => batch) : batch
  } })
  await h.client.negotiate(); await h.present(); await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' })
  for (let index = 0; index < 7; index++) await assert.rejects(h.client.recoverConsumption(), { code: 'ERR_UNCERTAIN' })
  assert.equal(h.client.retention.inFlightExchanges, 8); assert.equal(h.client.retention.requests, 3)
  const calls = h.calls.length, bytes = h.client.retention.bytes
  await assert.rejects(h.client.recoverConsumption(), /settlement budget exhausted/)
  assert.equal(h.calls.length, calls); assert.equal(h.client.retention.bytes, bytes)
  release.resolve(); await tick(); assert.equal(h.client.retention.inFlightExchanges, 0)
  assert.equal(h.client.retention.requests, 0); assert.equal(h.client.state, 'ready')
  await h.client.disposeAsync()
})

test('2.1 request byte refusal does not advance the wire sequence or send a new business request', async () => {
  const h = harness({ liveVersion: '2.1', contract: { maxRetainedBytes: 16000 } })
  await h.client.negotiate(); const calls = h.calls.length
  await assert.rejects(h.client.prepareAndPresent({ render: { viewport, oversized: 'x'.repeat(17000) }, surfaceGeneration: '7' }), /retention budget exhausted/)
  assert.equal(h.calls.length, calls); assert.equal(h.client.retention.requests, 0)
  await h.present(); assert.equal(h.calls[1].payload.transaction.sequence, '1')
  await h.client.consumeCompleted(); await h.client.disposeAsync()
})

for (const malformed of ['foreign', 'wrong-prefix', 'effect', 'extra-field', 'queued']) test(`2.1 ${malformed} consumption response cannot release retained records`, async () => {
  let corrupt = true
  const h = harness({ liveVersion: '2.1', dispatch(h, request, batch) {
    if (request.op !== 'view.live.consume' || !corrupt) return batch
    if (malformed === 'foreign') batch.messages[0].requestId = 'another-consume'
    if (malformed === 'wrong-prefix') batch.messages[0].payload.consumedThrough = '99'
    if (malformed === 'effect') batch.messages.push({ ...batch.messages[0], kind: 'effect' })
    if (malformed === 'extra-field') batch.messages[0].payload.currentWatermark = '99'
    if (malformed === 'queued') batch.messages[0].kind = 'event'
    return batch
  } })
  await h.client.negotiate(); await h.present(); const deliveries = h.deliveries.length
  await assert.rejects(h.client.consumeCompleted(), { code: 'ERR_UNCERTAIN' }); assert.equal(h.client.retention.requests, 3)
  assert.equal(h.deliveries.length, deliveries); corrupt = false
  await h.client.recoverConsumption(); assert.equal(h.client.retention.requests, 0); await h.client.disposeAsync()
})

test('2.1 diagnostic history stores only a bounded safe snapshot instead of retaining callback object graphs', async () => {
  const held = { batch: { large: 'private' }, attempt: {} }
  const h = harness({ liveVersion: '2.1', onBatch(h, batch) {
    if (['view.live.prepare', 'view.live.abort'].includes(batch.messages[0].op)) {
      const error = new Error('x'.repeat(10000)); error.cause = held; error.originalEnvelope = held; error.outcome = held; throw error
    }
  } })
  await h.client.negotiate()
  for (let index = 0; index < 40; index++) { await assert.rejects(h.present(), /xxx/); await h.client.consumeCompleted() }
  assert.equal(h.client.cleanupErrors.length, 32)
  for (const error of h.client.cleanupErrors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message']); assert.equal(error.message.length, 2048); assert.equal(error.code, 'ERR_RENDER')
  }
  assert.equal(h.client.retention.requests, 0); await h.client.disposeAsync()
})

test('2.1 passive observations appended by a transport neither replace nor redeliver a retained business final', async () => {
  const release = deferred(); let first = true, observation = 0
  const h = harness({ liveVersion: '2.1', timeoutMs: 5, dispatch(h, request, batch) {
    batch.messages.push({ protocolVersion: '1.0', sessionId: request.sessionId, requestId: '', op: 'passive-observation', kind: 'event', payload: { observation: ++observation } })
    if (request.op === 'view.live.presented' && first) { first = false; return release.promise.then(() => batch) }
    return batch
  } })
  await h.client.negotiate(); await assert.rejects(h.present(), { code: 'ERR_UNCERTAIN' }); await h.client.recoverOriginalFinal()
  const deliveries = h.deliveries.length, accepted = h.client.accepted
  release.resolve(); await tick(); assert.equal(h.deliveries.length, deliveries); assert.equal(h.client.accepted, accepted)
  // Metadata has a strict response-only contract, unlike passive business observations.
  h.client.invalidate(); await h.client.disposeAsync()
})
