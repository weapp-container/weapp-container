import assert from 'node:assert/strict'
import test from 'node:test'
import { PresentationScheduler } from '../examples/hosts/web-wasm/presentation-scheduler.mjs'

// Drafted deterministic contract tests. No browser, runtime, timers or sleeps.
const OWNER = Object.freeze({ workerEpoch: 'worker-a', sessionId: 'session-a', packSha256: 'a'.repeat(64), transportBackend: 'external-frame' })
const initialState = owner => ({
  owner, currentPage: { pageId: '1', path: 'pages/index/index' },
  templateRevision: '1', renderRevision: '0', viewRevision: '1',
  surfaceGeneration: '1', viewport: { x: 0, y: 0, width: 375, height: 667 },
  rendererProfile: owner.transportBackend === 'browser-view' ? 'webview' : 'skia', lifecycle: 'Active',
})
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const microtasks = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve() }
const inputFor = (state, revision = state.templateRevision) => ({
  pageId: state.currentPage.pageId, routePath: state.currentPage.path,
  templateRevision: revision, viewport: { ...state.viewport },
})

function harness(t, hooks = {}, owner = OWNER) {
  let nextHandle = 0, observationSequence = 0n, renderSequence = 0n, state = initialState(owner)
  const queue = new Map(), calls = { templates: [], paints: [], presents: [], releases: [], freezes: [], lifecycle: [], errors: [], states: [], requested: [], cancelled: [] }
  const prepared = (captured, context, options = {}) => {
    const minimum = BigInt(captured.renderRevision)
    renderSequence = renderSequence + 1n > minimum ? renderSequence + 1n : minimum
    const renderRevision = options.renderRevision ?? String(renderSequence)
    const publication = owner.transportBackend === 'external-frame'
      ? { kind: 'external-frame', renderRevision }
      : { kind: 'browser-view', key: {
        sessionId: owner.sessionId, pageId: captured.currentPage.pageId,
        documentRevision: options.documentRevision ?? context.attemptId,
        presentationRevision: options.presentationRevision ?? context.attemptId,
        surfaceGeneration: captured.surfaceGeneration, profile: 'webview',
      } }
    return { proof: {
      version: '1.0', attemptId: context.attemptId, owner: { ...owner },
      surfaceGeneration: captured.surfaceGeneration, publication,
      consumedInput: options.input ?? inputFor(captured, options.templateRevision),
      ...(options.sample !== undefined || captured.sampleDemandRevision !== undefined ? {
        consumedSample: options.sample ?? { demandRevision: captured.sampleDemandRevision, sampleRevision: context.attemptId },
      } : {}),
    } }
  }
  const adapter = {
    prepareTemplate(captured, context) {
      calls.templates.push({ captured, context })
      return hooks.prepareTemplate?.(captured, context, prepared) ?? prepared(captured, context)
    },
    preparePaint(captured, accepted, context) {
      calls.paints.push({ captured, accepted, context })
      return hooks.preparePaint?.(captured, accepted, context, prepared) ?? prepared(captured, context, {
        input: structuredClone(accepted.proof.consumedInput),
        documentRevision: accepted.proof.publication.key?.documentRevision,
      })
    },
    present(candidate, context) {
      calls.presents.push({ candidate, context })
      return hooks.present?.(candidate, context) ?? { acknowledged: true, publication: context.proof.publication, inputEnabled: true }
    },
    release(candidate, context) {
      calls.releases.push({ candidate, context }); calls.lifecycle.push(`release:${context.attemptId}`)
      return hooks.release?.(candidate, context)
    },
    freezeInput(reason) { calls.freezes.push(reason); return hooks.freezeInput?.(reason) },
    cancelOwnedWork(reason) { calls.lifecycle.push('cancel-owned'); return hooks.cancelOwnedWork?.(reason) },
    dispose() { calls.lifecycle.push('dispose'); return hooks.dispose?.() },
  }
  const scheduler = new PresentationScheduler({
    owner, adapter,
    preparationScheduling: hooks.preparationScheduling,
    requestFrame(callback) {
      assert.equal(queue.size, 0, 'at most one RAF may be owned')
      const handle = ++nextHandle; queue.set(handle, callback); calls.requested.push(handle)
      hooks.requestFrame?.({ handle, callback, queue })
      return handle
    },
    cancelFrame(handle) { queue.delete(handle); calls.cancelled.push(handle); hooks.cancelFrame?.(handle) },
    onError(failure) { calls.errors.push(failure); hooks.onError?.(failure) },
    onState(status) { calls.states.push(status); hooks.onState?.(status) },
  })
  const result = {
    scheduler, calls, prepared, queue,
    observe(patch = {}) {
      state = { ...state, ...patch }
      return scheduler.observe({ sequence: String(++observationSequence), state })
    },
    step() {
      const entry = queue.entries().next().value
      if (!entry) return false
      queue.delete(entry[0]); entry[1](nextHandle * 16); return true
    },
    get state() { return state },
  }
  if (t) t.after(() => scheduler.close())
  return result
}

async function settle(h, limit = 80) {
  for (let turn = 0; turn < limit; turn++) {
    await microtasks()
    h.step()
    await microtasks()
    const status = h.scheduler.status
    if (!status.inFlight && !status.hasRaf) return
  }
  assert.fail('deterministic scheduler did not settle within its bounded microtask/RAF budget')
}

async function firstFrame(h) {
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.accepted?.inputEnabled, true)
}

function recoveredObservation(h, ticket, { kind = 'retained', patch = {} } = {}) {
  // This is an injected native contract fixture, not GPU/native evidence.
  const previousRenderRevision = String(BigInt(h.state.renderRevision) > BigInt(ticket.base?.proof.publication.renderRevision ?? '0')
    ? BigInt(h.state.renderRevision) : BigInt(ticket.base?.proof.publication.renderRevision ?? '0'))
  const renderRevision = kind === 'retained' ? String(BigInt(previousRenderRevision) + 1n) : previousRenderRevision
  const previousInputLifetimeRevision = String(BigInt(h.state.surfaceGeneration) - 1n)
  const inputLifetimeRevision = String(BigInt(previousInputLifetimeRevision) + 1n)
  h.observe({ ...patch, renderRevision, surfaceGeneration: String(BigInt(h.state.surfaceGeneration) + 1n) })
  return { version: '1.0', kind, sessionId: OWNER.sessionId, previousRenderRevision, renderRevision,
    previousInputLifetimeRevision, inputLifetimeRevision }
}

test('activity-only and identical observations never reevaluate a stateful View', async t => {
  const h = harness(t)
  await firstFrame(h)
  const freezes = h.calls.freezes.length
  for (let index = 2; index < 40; index++) h.observe({ viewRevision: String(index) })
  await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.calls.freezes.length, freezes)
})

test('native input lifetime survives demand projection and retires accepted DOM and Skia authority', async t => {
  // The real producer also advances surfaceGeneration. Holding it constant
  // here isolates receiver handling of the independently supplied native token.
  for (const transportBackend of ['browser-view', 'external-frame']) {
    const h = harness(t, {}, { ...OWNER, transportBackend })
    h.observe({ inputLifetimeRevision: '9007199254740993' }); await settle(h)
    assert.equal(h.calls.templates[0].captured.inputLifetimeRevision, '9007199254740993')
    const freezes = h.calls.freezes.length
    h.observe({ inputLifetimeRevision: '9007199254740993', viewRevision: '2' }); await settle(h)
    assert.equal(h.calls.templates.length, 1)
    assert.equal(h.calls.freezes.length, freezes)
    h.observe({ inputLifetimeRevision: '9007199254740994' })
    assert.equal(h.scheduler.status.accepted, null)
    assert.equal(h.calls.freezes.length, freezes + 1)
    await settle(h)
    assert.equal(h.calls.templates.length, 2)
    assert.equal(h.calls.templates[1].captured.inputLifetimeRevision, '9007199254740994')
    assert.equal(h.scheduler.status.accepted.inputEnabled, true)
  }
})

test('an established native lifetime cannot regress or disappear behind newer logical geometry', async t => {
  for (const inputLifetimeRevision of ['9007199254740992', undefined]) {
    const h = harness(t)
    h.observe({ inputLifetimeRevision: '9007199254740993' }); await settle(h)
    assert.throws(() => h.observe({ inputLifetimeRevision, surfaceGeneration: '2' }),
      failure => failure.code === 'ERR_PROTOCOL_VERSION' && /input lifetime/.test(failure.message))
    assert.equal(h.scheduler.status.accepted, null)
    assert.equal(h.scheduler.status.latest.inputLifetimeRevision, '9007199254740993')
    assert.equal(h.scheduler.status.latest.surfaceGeneration, '1')
    await settle(h)
    assert.equal(h.calls.templates.length, 1, 'invalid observation cannot schedule replacement work')
  }
})

test('direct scheduler exhaustion rejects only after synchronously retiring accepted native authority', async t => {
  const h = harness(t)
  h.observe({ inputLifetimeRevision: '18446744073709551615' }); await settle(h)
  const freezes = h.calls.freezes.length
  assert.throws(() => h.observe({ inputLifetimeRevision: null, requiresRestart: true, surfaceGeneration: '2' }),
    failure => failure.code === 'ERR_PROTOCOL_VERSION' && /exhausted native input lifetime/.test(failure.message))
  assert.equal(h.calls.freezes.length, freezes + 1)
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.scheduler.status.phase, 'faulted')
  assert.throws(() => h.observe({ inputLifetimeRevision: '18446744073709551615', surfaceGeneration: '3' }),
    failure => failure.code === 'ERR_RENDER')
  await settle(h)
  assert.equal(h.calls.templates.length, 1)
})

test('paint dirtiness and density use retained input; template dirtiness executes View', async t => {
  const h = harness(t)
  await firstFrame(h)
  const accepted = h.scheduler.status.accepted
  h.observe({ renderRevision: String(BigInt(accepted.proof.publication.renderRevision) + 1n) })
  await settle(h)
  assert.equal(h.calls.templates.length, 1, 'physical density/native scroll cannot reevaluate View')
  assert.equal(h.calls.paints.length, 1)
  assert.deepEqual(h.scheduler.status.accepted.proof.consumedInput, accepted.proof.consumedInput)
  assert.deepEqual(h.scheduler.status.latest.viewport, accepted.proof.consumedInput.viewport)
  assert.equal(h.scheduler.status.latest.surfaceGeneration, '1')
  h.observe({ templateRevision: '2' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
})

test('actual clone input ahead of captured demand consumes the queued lower bound', async t => {
  const gate = deferred()
  const h = harness(t, { prepareTemplate: () => gate.promise })
  h.observe({ templateRevision: '4', renderRevision: '8' }); h.step(); await microtasks()
  h.observe({ templateRevision: '5', renderRevision: '10' })
  const first = h.calls.templates[0]
  gate.resolve(h.prepared(first.captured, first.context, { templateRevision: '5', renderRevision: '10' }))
  await settle(h)
  assert.equal(h.calls.templates.length, 1, 'captured demand4 must not overwrite actual clone5')
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '5')
})

test('hook and ACK dirtiness yield exactly one successor from the frozen clone proof', async t => {
  let h
  h = harness(t, {
    prepareTemplate(captured, context, make) {
      if (context.attemptId === '1') {
        h.observe({ templateRevision: '6' }) // component hook after root clone5
        return make(captured, context, { templateRevision: '5' })
      }
      return make(captured, context)
    },
    present(candidate, context) {
      if (context.attemptId === '1') h.observe({ templateRevision: '7' }) // onReady
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: true, consumedInput: inputFor(h.state, '7') }
    },
  })
  h.observe({ templateRevision: '4' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.presents[0].context.proof.consumedInput.templateRevision, '5')
  assert.equal(h.calls.templates[1].captured.templateRevision, '7')
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '7')
})

test('soft dirtiness coalesces while a flight is blocked without abort starvation', async t => {
  const gate = deferred()
  const h = harness(t, { prepareTemplate: (captured, context, make) => context.attemptId === '1' ? gate.promise : make(captured, context) })
  h.observe(); h.step(); await microtasks()
  const first = h.calls.templates[0]
  for (let revision = 2; revision <= 100; revision++) h.observe({ templateRevision: String(revision) })
  assert.equal(first.context.signal.aborted, false)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.queue.size, 0)
  gate.resolve(h.prepared(first.captured, first.context))
  await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.templates[1].captured.templateRevision, '100')
})

test('same failed pre-request input does not retry on activity; explicit retry does', async t => {
  let attempts = 0
  const h = harness(t, { prepareTemplate(captured, context, make) {
    if (++attempts === 1) throw new Error('prepare failed before proof')
    return make(captured, context)
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.phase, 'blocked')
  for (let index = 2; index < 20; index++) h.observe({ viewRevision: String(index) })
  await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.scheduler.retry(), true)
  await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
})

test('a failed prepared clone5 suppresses latest5 even when capture was4', async t => {
  let h
  h = harness(t, {
    prepareTemplate(captured, context, make) {
      if (context.attemptId === '1') {
        h.observe({ templateRevision: '5' })
        return make(captured, context, { templateRevision: '5' })
      }
      return make(captured, context)
    },
    present(candidate, context) {
      if (context.attemptId === '1') throw new Error('decode/presentation failed after clone5')
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: true }
    },
  })
  h.observe({ templateRevision: '4' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.scheduler.status.failed.proof.consumedInput.templateRevision, '5')
  assert.equal(h.scheduler.status.accepted, null, 'failed proof is not accepted baseline')
  h.observe({ templateRevision: '5', viewRevision: '99' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  h.observe({ templateRevision: '6' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
})

test('hard resize freezes immediately, aborts, releases late result, then starts successor', async t => {
  const prepare = deferred(), release = deferred()
  const h = harness(t, {
    prepareTemplate: (captured, context, make) => context.attemptId === '1' ? prepare.promise : make(captured, context),
    release: (candidate, context) => context.attemptId === '1' ? release.promise : undefined,
  })
  h.observe(); h.step(); await microtasks()
  const first = h.calls.templates[0], freezes = h.calls.freezes.length
  h.observe({ viewport: { x: 0, y: 0, width: 667, height: 375 }, surfaceGeneration: '2' })
  assert.equal(first.context.signal.aborted, true)
  assert.ok(h.calls.freezes.length > freezes)
  prepare.resolve(h.prepared(first.captured, first.context)); await microtasks()
  assert.equal(h.calls.presents.length, 0)
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.calls.templates.length, 1, 'cleanup must finish before successor starts')
  assert.equal(h.queue.size, 0)
  release.resolve(); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.scheduler.status.accepted.proof.surfaceGeneration, '2')
})

test('hide/show fences the same page lifetime and never presents hidden work', async t => {
  const h = harness(t)
  await firstFrame(h)
  h.observe({ lifecycle: 'Background' }); await settle(h)
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.scheduler.status.phase, 'inactive')
  assert.equal(h.calls.templates.length, 1)
  h.observe({ lifecycle: 'Active' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
})

test('null or mismatched preparation proof fails explicitly and releases its candidate', async t => {
  const h = harness(t, { prepareTemplate(captured, context, make) {
    const candidate = make(captured, context)
    candidate.proof.consumedInput = null
    return candidate
  } })
  h.observe(); await settle(h)
  assert.equal(h.calls.presents.length, 0)
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_PROTOCOL_VERSION')
  h.observe({ viewRevision: '2' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
})

test('prepare proof is deeply copied before ACK mutations and decorations', async t => {
  const h = harness(t, { present(candidate, context) {
    candidate.proof.consumedInput.templateRevision = '999'
    candidate.proof.consumedInput.viewport.width = 1000
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: true, scheduling: { consumedInput: candidate.proof.consumedInput } }
  } })
  h.observe({ templateRevision: '4' }); await settle(h)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '4')
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.viewport.width, 375)
  assert.equal(Object.isFrozen(h.scheduler.status.accepted.proof.consumedInput.viewport), true)
})

test('committed input-disabled outcome retains its visual baseline without automatic ACK replay', async t => {
  const h = harness(t, { present(candidate, context) {
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: context.attemptId !== '1' }
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.equal(h.scheduler.status.failed.error.committed, true)
  const oldToken = h.scheduler.status.accepted.proof.publication
  h.observe({ viewRevision: '2' }); await settle(h)
  assert.equal(h.calls.presents.length, 1)
  h.scheduler.retry(); await settle(h)
  assert.equal(h.calls.presents.length, 2)
  assert.notDeepEqual(h.scheduler.status.accepted.proof.publication, oldToken)
})

test('late observation cannot restore an older page; ordered revision regression faults closed', async t => {
  const h = harness(t)
  await firstFrame(h)
  h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' }, templateRevision: '4' }); await settle(h)
  const before = h.calls.freezes.length
  const ignored = h.scheduler.observe({ sequence: '1', state: initialState(OWNER) })
  assert.equal(ignored.accepted, false)
  assert.equal(h.scheduler.status.latest.currentPage.pageId, '2')
  assert.equal(h.calls.freezes.length, before)
  assert.throws(() => h.observe({ templateRevision: '3' }), failure => failure.code === 'ERR_PROTOCOL_VERSION')
  assert.equal(h.scheduler.status.phase, 'faulted')
  assert.equal(h.scheduler.status.accepted, null)
})

test('renderer transport mismatch freezes and requires an explicit new owner', async t => {
  const h = harness(t)
  await firstFrame(h)
  assert.throws(() => h.observe({ rendererProfile: 'webview' }), failure => failure.requiresRestart === true)
  assert.equal(h.scheduler.status.phase, 'restart-required')
  assert.equal(h.scheduler.status.accepted, null)
  assert.throws(() => h.scheduler.retry(), failure => failure.code === 'ERR_UNSUPPORTED_CAPABILITY')
})

test('browser-view accepts exact DOM keys and ignores activity/paint without an outer numeric ACK', async t => {
  const h = harness(t, {}, { ...OWNER, transportBackend: 'browser-view' })
  await firstFrame(h)
  h.observe({ viewRevision: '2', renderRevision: '10' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.scheduler.status.accepted.proof.publication.kind, 'browser-view')
  assert.equal(h.scheduler.status.accepted.proof.publication.key.surfaceGeneration, '1')
})

test('close is stable and cancels pending work before drain and final disposal', async () => {
  const prepare = deferred()
  let h
  h = harness(null, {
    prepareTemplate: () => prepare.promise,
    cancelOwnedWork() {
      const first = h.calls.templates[0]
      prepare.resolve(h.prepared(first.captured, first.context))
    },
  })
  h.observe(); h.step(); await microtasks()
  const first = h.calls.templates[0]
  const closed = h.scheduler.close()
  assert.equal(closed, h.scheduler.close())
  assert.equal(first.context.signal.aborted, true)
  await closed
  assert.equal(h.calls.presents.length, 0)
  assert.deepEqual(h.calls.lifecycle, ['cancel-owned', 'release:1', 'dispose'])
  assert.equal(h.scheduler.status.phase, 'closed')
  assert.equal(h.queue.size, 0)
  assert.throws(() => h.observe(), failure => failure.code === 'ERR_CANCELLED')
})

test('reentrant close during synchronous freeze sees a stable flight promise', async () => {
  let h, closePromise
  h = harness(null, { freezeInput(reason) {
    if (reason === 'presentation-start') closePromise = h.scheduler.close()
  } })
  h.observe(); h.step(); await microtasks()
  await closePromise
  assert.equal(closePromise, h.scheduler.close())
  assert.equal(h.calls.templates.length, 0)
  assert.deepEqual(h.calls.lifecycle, ['cancel-owned', 'dispose'])
  assert.equal(h.scheduler.status.phase, 'closed')
})

test('irreversible late ACK is cleanup metadata only after a hard fence', async t => {
  const ack = deferred()
  const h = harness(t, { present: (candidate, context) => context.attemptId === '1' ? ack.promise : { acknowledged: true, publication: context.proof.publication, inputEnabled: true } })
  h.observe(); h.step(); await microtasks(); h.step(); await microtasks()
  const old = h.calls.presents[0]
  h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
  ack.resolve({ acknowledged: true, publication: old.context.proof.publication, inputEnabled: true })
  await settle(h)
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '2')
})

test('cleanup failures aggregate while later cleanup still runs', async () => {
  const prepare = deferred(), cancellationError = new Error('cancel diagnostic'), releaseError = new Error('release diagnostic'), disposeError = new Error('dispose diagnostic')
  let h
  h = harness(null, {
    prepareTemplate: () => prepare.promise,
    cancelOwnedWork() {
      const first = h.calls.templates[0]
      prepare.resolve(h.prepared(first.captured, first.context))
      throw cancellationError
    },
    release() { throw releaseError },
    dispose() { throw disposeError },
  })
  h.observe(); h.step(); await microtasks()
  const closed = h.scheduler.close()
  await assert.rejects(closed, failure => failure instanceof AggregateError && [cancellationError, releaseError, disposeError].every(item => failure.errors.includes(item)))
  assert.deepEqual(h.calls.lifecycle, ['cancel-owned', 'release:1', 'dispose'])
  assert.equal(h.scheduler.status.phase, 'closed')
})


test('u64 template identity remains exact beyond Number safe integers', async t => {
  const h = harness(t)
  h.observe({ templateRevision: '9007199254740993' }); await settle(h)
  h.observe({ templateRevision: '9007199254740994' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '9007199254740994')
  assert.throws(() => h.observe({ templateRevision: '09007199254740994' }), failure => failure.code === 'ERR_PROTOCOL_VERSION')
})

test('retained paint proof cannot claim newly observed template input', async t => {
  const h = harness(t, { preparePaint(captured, accepted, context, make) {
    return make(captured, context, { input: inputFor(captured, '2') })
  } })
  await firstFrame(h)
  const old = h.scheduler.status.accepted.proof.consumedInput
  h.observe({ renderRevision: '2' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 1)
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_PROTOCOL_VERSION')
  assert.deepEqual(h.scheduler.status.accepted.proof.consumedInput, old)
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
})

test('a queued receipt or wrong final publication never grants input authority', async t => {
  const h = harness(t, { present(candidate, context) {
    return { queued: true, publication: context.proof.publication, inputEnabled: true }
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(h.calls.releases[0].context.committed, false)
})


test('a release failure faults ownership and blocks successor execution', async () => {
  const cleanupError = new Error('candidate resource release failed')
  const h = harness(null, { release() { throw cleanupError } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.phase, 'faulted')
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '1')
  assert.throws(() => h.observe({ templateRevision: '2' }), failure => failure.code === 'ERR_RENDER')
  assert.throws(() => h.scheduler.retry(), failure => failure.code === 'ERR_RENDER')
  assert.equal(h.calls.templates.length, 1)
  await assert.rejects(h.scheduler.close(), failure => failure instanceof AggregateError && failure.errors.includes(cleanupError))
  assert.equal(h.calls.lifecycle.at(-1), 'dispose')
})

test('reentrant initial hard observation preserves the newest page and sequence', async t => {
  let h, entered = false
  h = harness(t, { freezeInput(reason) {
    if (reason === 'logical-input-lifetime-change' && !entered) {
      entered = true
      h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' }, templateRevision: '2' })
    }
  } })
  h.observe()
  assert.equal(h.scheduler.status.observationSequence, '2')
  assert.equal(h.scheduler.status.latest.currentPage.pageId, '2')
  await settle(h)
  assert.deepEqual(h.calls.templates.map(call => call.captured.currentPage.pageId), ['2'])
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '2')
})

test('hard retirement cancels its queued RAF before a reentrant newer page is admitted', async t => {
  let h, armed = false
  h = harness(t, { freezeInput(reason) {
    if (reason === 'logical-input-lifetime-change' && armed) {
      armed = false
      h.observe({ currentPage: { pageId: '3', path: 'pages/newest/index' } })
    }
  } })
  h.observe()
  armed = true
  h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
  assert.deepEqual(h.calls.cancelled, [1])
  assert.deepEqual([...h.queue.keys()], [2])
  assert.equal(h.scheduler.status.latest.currentPage.pageId, '3')
  await settle(h)
  assert.deepEqual(h.calls.templates.map(call => call.captured.currentPage.pageId), ['3'])
  assert.equal(h.calls.errors.length, 0)
})

test('a hard fence during presentation-start skips stale prepare and schedules its successor', async t => {
  let h, entered = false
  h = harness(t, { freezeInput(reason) {
    if (reason === 'presentation-start' && !entered) {
      entered = true
      h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
    }
  } })
  h.observe(); h.step()
  assert.equal(h.calls.templates.length, 0)
  await settle(h)
  assert.deepEqual(h.calls.templates.map(call => call.captured.currentPage.pageId), ['2'])
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '2')
})

test('reentrant close during RAF registration cancels the actual returned handle', async () => {
  let h, closed, entered = false
  h = harness(null, { requestFrame() {
    if (!entered) { entered = true; closed = h.scheduler.close() }
  } })
  h.observe()
  await closed
  assert.equal(closed, h.scheduler.close())
  assert.deepEqual(h.calls.requested, [1])
  assert.deepEqual(h.calls.cancelled, [1])
  assert.equal(h.queue.size, 0)
  assert.equal(h.calls.templates.length, 0)
  assert.deepEqual(h.calls.lifecycle, ['cancel-owned', 'dispose'])
})

test('a hard observation during RAF registration waits for exact old-handle cancellation', async t => {
  let h, entered = false
  h = harness(t, { requestFrame() {
    if (!entered) {
      entered = true
      h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
    }
  } })
  h.observe()
  assert.deepEqual(h.calls.cancelled, [1])
  assert.deepEqual([...h.queue.keys()], [2])
  await settle(h)
  assert.deepEqual(h.calls.templates.map(call => call.captured.currentPage.pageId), ['2'])
  assert.equal(h.calls.errors.length, 0)
})

test('cancelFrame reentrancy cannot cancel or replace the newest successor', async t => {
  let h, entered = false
  h = harness(t, { cancelFrame() {
    if (!entered) {
      entered = true
      h.observe({ currentPage: { pageId: '3', path: 'pages/newest/index' } })
    }
  } })
  h.observe()
  h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
  assert.deepEqual(h.calls.cancelled, [1])
  assert.deepEqual([...h.queue.keys()], [2])
  assert.equal(h.scheduler.status.observationSequence, '3')
  await settle(h)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '3')
})

test('restart-required final is authoritative before freeze and error notifications', async t => {
  let h
  const phases = [], blocked = []
  const inspect = () => {
    phases.push(h.scheduler.status.phase)
    try { h.scheduler.retry() } catch (failure) { blocked.push(failure.code) }
  }
  h = harness(t, {
    present(candidate, context) {
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: false, requiresRestart: true }
    },
    freezeInput(reason) { if (reason === 'renderer-restart-required') inspect() },
    onError: inspect,
  })
  h.observe(); await settle(h)
  assert.deepEqual(phases, ['restart-required', 'restart-required'])
  assert.deepEqual(blocked, ['ERR_UNSUPPORTED_CAPABILITY', 'ERR_UNSUPPORTED_CAPABILITY'])
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.queue.size, 0)
})

test('release failure is faulted before a notification attempts reentrant observe and retry', async () => {
  const failure = new Error('release cannot prove cleanup')
  const phases = [], blocked = []
  let h
  h = harness(null, {
    release() { throw failure },
    onError() {
      phases.push(h.scheduler.status.phase)
      for (const action of [() => h.observe({ templateRevision: '2' }), () => h.scheduler.retry()]) {
        try { action() } catch (error) { blocked.push(error.code) }
      }
    },
  })
  h.observe(); await settle(h)
  assert.deepEqual(phases, ['faulted'])
  assert.deepEqual(blocked, ['ERR_RENDER', 'ERR_RENDER'])
  assert.equal(h.calls.templates.length, 1)
  await assert.rejects(h.scheduler.close(), error => error instanceof AggregateError && error.errors.includes(failure))
  assert.equal(h.calls.lifecycle.filter(item => item === 'dispose').length, 1)
})

test('preparing state notification can close while preserving the exact flight release barrier', async () => {
  let h, closed
  h = harness(null, { onState(status) {
    if (status.phase === 'preparing' && !closed) closed = h.scheduler.close()
  } })
  h.observe(); h.step(); await microtasks()
  await closed
  assert.equal(h.scheduler.status.phase, 'closed')
  assert.equal(h.calls.presents.length, 0)
  assert.deepEqual(h.calls.lifecycle, ['cancel-owned', 'release:1', 'dispose'])
  assert.equal(h.calls.releases[0].context.retired, true)
})

test('presenting state notification hard fence releases old proof before newest prepare', async t => {
  let h, entered = false
  h = harness(t, { onState(status) {
    if (status.phase === 'presenting' && !entered) {
      entered = true
      h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
    }
  } })
  h.observe(); await settle(h)
  assert.deepEqual(h.calls.templates.map(call => call.captured.currentPage.pageId), ['1', '2'])
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '2')
})

test('surface recovery retains exact View input and grants input only after the new ACK', async t => {
  const ack = deferred()
  const h = harness(t, { present(candidate, context) {
    return context.attemptId === '2' ? ack.promise : { acknowledged: true, publication: context.proof.publication, inputEnabled: true }
  } })
  await firstFrame(h)
  const accepted = h.scheduler.status.accepted
  const draining = h.scheduler.suspendOwnedSurface('webglcontextlost')
  assert.equal(draining, h.scheduler.suspendOwnedSurface('duplicate loss'))
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.scheduler.status.retiredPicture.inputEnabled, false)
  assert.equal(h.scheduler.status.suspended, true)
  assert.equal(h.scheduler.status.latest.surfaceGeneration, '1', 'local loss cannot mint an observation')
  const ticket = await draining
  assert.equal(ticket.base.inputEnabled, false)
  assert.deepEqual(ticket.base.proof, accepted.proof)
  assert.equal(Object.isFrozen(ticket), true)
  const outcome = recoveredObservation(h, ticket)
  assert.deepEqual(h.scheduler.resumeOwnedSurface(ticket, outcome), { resumed: true, retained: true })
  h.step(); await microtasks(); h.step(); await microtasks()
  assert.equal(h.calls.templates.length, 1, 'context recreation must not reevaluate stateful View functions')
  assert.equal(h.calls.paints.length, 1)
  assert.equal(h.scheduler.status.accepted, null, 'preparation and submission are not an ACK')
  const paint = h.calls.presents[1]
  ack.resolve({ acknowledged: true, publication: paint.context.proof.publication, inputEnabled: true })
  await settle(h)
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
  assert.equal(h.scheduler.status.accepted.proof.surfaceGeneration, '2')
  assert.deepEqual(h.scheduler.status.accepted.proof.consumedInput, accepted.proof.consumedInput)
  assert.ok(BigInt(h.scheduler.status.accepted.proof.publication.renderRevision) > BigInt(accepted.proof.publication.renderRevision))
  assert.equal(h.scheduler.status.surfaceRecovery, null)
  assert.equal(h.calls.lifecycle.includes('cancel-owned'), false)
  assert.equal(h.calls.lifecycle.includes('dispose'), false)
})

test('surface recovery drain waits for a late irreversible ACK and exact candidate release', async t => {
  const ack = deferred(), release = deferred()
  const h = harness(t, {
    present(candidate, context) { return context.attemptId === '2' ? ack.promise : { acknowledged: true, publication: context.proof.publication, inputEnabled: true } },
    release(candidate, context) { if (context.attemptId === '2') return release.promise },
  })
  await firstFrame(h)
  h.observe({ renderRevision: '2' }); h.step(); await microtasks(); h.step(); await microtasks()
  const flight = h.calls.presents[1]
  let drained = false
  const drain = h.scheduler.suspendOwnedSurface().then(ticket => { drained = true; return ticket })
  assert.equal(flight.context.signal.aborted, true)
  ack.resolve({ acknowledged: true, publication: flight.context.proof.publication, inputEnabled: true })
  await microtasks()
  assert.equal(drained, false)
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.calls.releases[1].context.committed, true)
  assert.equal(h.calls.releases[1].context.retired, true)
  release.resolve()
  const ticket = await drain
  assert.notEqual(ticket.base, null, 'a retained native paint does not change the exact template input')
  assert.equal(h.queue.size, 0)
  const outcome = recoveredObservation(h, ticket)
  h.scheduler.resumeOwnedSurface(ticket, outcome); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 2)
  assert.equal(h.scheduler.status.accepted.proof.surfaceGeneration, '2')
})

test('a first unacknowledged frame can be retained without becoming accepted input', async t => {
  const ack = deferred()
  const h = harness(t, { present(candidate, context) {
    return context.attemptId === '1' ? ack.promise : { acknowledged: true, publication: context.proof.publication, inputEnabled: true }
  } })
  h.observe(); h.step(); await microtasks(); h.step(); await microtasks()
  const first = h.calls.presents[0]
  assert.equal(h.scheduler.status.accepted, null)
  const drain = h.scheduler.suspendOwnedSurface()
  ack.resolve({ acknowledged: true, publication: first.context.proof.publication, inputEnabled: true })
  const ticket = await drain
  assert.equal(ticket.base.inputEnabled, false)
  assert.deepEqual(ticket.base.proof, first.context.proof)
  assert.equal(h.scheduler.status.accepted, null)
  const outcome = recoveredObservation(h, ticket)
  assert.equal(h.scheduler.resumeOwnedSurface(ticket, outcome).retained, true)
  await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 1)
  assert.equal(h.scheduler.status.accepted.proof.surfaceGeneration, '2')
})

test('late preparation is validated and drained before it becomes a nonaccepted recovery base', async t => {
  const prepare = deferred(), release = deferred()
  const h = harness(t, {
    prepareTemplate(captured, context, make) { return context.attemptId === '1' ? prepare.promise : make(captured, context) },
    release(candidate, context) { if (context.attemptId === '1') return release.promise },
  })
  h.observe(); h.step(); await microtasks()
  const first = h.calls.templates[0]
  let drained = false
  const drain = h.scheduler.suspendOwnedSurface().then(ticket => { drained = true; return ticket })
  const candidate = h.prepared(first.captured, first.context)
  prepare.resolve(candidate); await microtasks()
  assert.equal(drained, false)
  assert.equal(h.calls.presents.length, 0)
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.calls.releases[0].context.proof.consumedInput.templateRevision, '1')
  release.resolve()
  const ticket = await drain
  candidate.proof.consumedInput.templateRevision = '999'
  assert.equal(ticket.base.proof.consumedInput.templateRevision, '1', 'late raw results cannot mutate copied proof')
  const outcome = recoveredObservation(h, ticket)
  assert.equal(h.scheduler.resumeOwnedSurface(ticket, outcome).retained, true)
  await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 1)
})

test('input changes after loss permanently reject a late prepared recovery base', async t => {
  const prepare = deferred()
  const h = harness(t, { prepareTemplate(captured, context, make) { return context.attemptId === '1' ? prepare.promise : make(captured, context) } })
  h.observe(); h.step(); await microtasks()
  const first = h.calls.templates[0]
  const drain = h.scheduler.suspendOwnedSurface()
  h.observe({ templateRevision: '2' })
  prepare.resolve(h.prepared(first.captured, first.context))
  const ticket = await drain
  assert.equal(ticket.base, null)
  const outcome = recoveredObservation(h, ticket, { kind: 'render-required' })
  assert.equal(h.scheduler.resumeOwnedSurface(ticket, outcome).retained, false)
  await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '2')
})

test('a malformed late result is released and never becomes retained proof', async t => {
  const prepare = deferred()
  const h = harness(t, { prepareTemplate(captured, context, make) { return context.attemptId === '1' ? prepare.promise : make(captured, context) } })
  h.observe(); h.step(); await microtasks()
  const first = h.calls.templates[0]
  const drain = h.scheduler.suspendOwnedSurface()
  const malformed = h.prepared(first.captured, first.context)
  malformed.proof.owner.sessionId = 'another-session'
  prepare.resolve(malformed)
  const ticket = await drain
  assert.equal(ticket.base, null)
  assert.equal(h.calls.releases[0].context.proof, null)
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.scheduler.status.accepted, null)
  const outcome = recoveredObservation(h, ticket, { kind: 'render-required' })
  h.scheduler.resumeOwnedSurface(ticket, outcome); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
})

test('surface recovery cannot use a copied ticket, an old generation, or ordinary resume', async t => {
  const h = harness(t)
  await firstFrame(h)
  const ticket = await h.scheduler.suspendOwnedSurface()
  const outcome = { version: '1.0', kind: 'retained', sessionId: OWNER.sessionId, previousRenderRevision: '1', renderRevision: '2', previousInputLifetimeRevision: '0', inputLifetimeRevision: '1' }
  assert.throws(() => h.scheduler.resumeOwnedSurface({ ...ticket }, outcome), error => error.code === 'ERR_CANCELLED')
  assert.throws(() => h.scheduler.resumeOwnedSurface(ticket, outcome), error => error.code === 'ERR_CANCELLED')
  assert.throws(() => h.scheduler.resume(), error => error.code === 'ERR_CANCELLED')
  assert.equal(h.scheduler.status.suspended, true)
  assert.equal(h.queue.size, 0)
  recoveredObservation(h, ticket)
  h.scheduler.resumeOwnedSurface(ticket, outcome); await settle(h)
  assert.throws(() => h.scheduler.resumeOwnedSurface(ticket, outcome), error => error.code === 'ERR_CANCELLED')
  assert.equal(h.calls.templates.length, 1)
})

test('dirty native input uses its real render-required fence and the ordinary template path', async t => {
  const h = harness(t)
  await firstFrame(h)
  const ticket = await h.scheduler.suspendOwnedSurface()
  h.observe({ templateRevision: '2' })
  const outcome = recoveredObservation(h, ticket, { kind: 'render-required' })
  assert.deepEqual(h.scheduler.resumeOwnedSurface(ticket, outcome), { resumed: true, retained: false })
  assert.equal(h.scheduler.status.accepted, null)
  await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.calls.templates[1].captured.surfaceGeneration, '2')
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '2')
})

test('a render-required outcome never promotes a compatible historical base into retained paint', async t => {
  const h = harness(t)
  await firstFrame(h)
  const ticket = await h.scheduler.suspendOwnedSurface()
  const outcome = recoveredObservation(h, ticket, { kind: 'render-required' })
  assert.deepEqual(h.scheduler.resumeOwnedSurface(ticket, outcome), { resumed: true, retained: false })
  await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
})

test('navigation, viewport, profile and lifecycle changes permanently invalidate a recovery base', async t => {
  const patches = [
    { currentPage: { pageId: '2', path: 'pages/detail/index' } },
    { viewport: { x: 0, y: 0, width: 667, height: 375 } },
    { rendererProfile: 'skyline-compat' },
    { lifecycle: 'Background' },
  ]
  for (const patch of patches) {
    const h = harness(t)
    await firstFrame(h)
    const ticket = await h.scheduler.suspendOwnedSurface()
    const previous = Object.fromEntries(Object.keys(patch).map(key => [key, h.state[key]]))
    h.observe(patch); h.observe(previous)
    const outcome = recoveredObservation(h, ticket)
    assert.equal(h.scheduler.resumeOwnedSurface(ticket, outcome).retained, false, JSON.stringify(patch))
    await settle(h)
    assert.equal(h.calls.templates.length, 2)
    assert.equal(h.calls.paints.length, 0)
  }
})

test('a second context loss during recovery preserves input proof but retires the old ACK', async t => {
  const oldAck = deferred()
  const h = harness(t, { present(candidate, context) {
    return context.attemptId === '2' ? oldAck.promise : { acknowledged: true, publication: context.proof.publication, inputEnabled: true }
  } })
  await firstFrame(h)
  const first = await h.scheduler.suspendOwnedSurface()
  const firstOutcome = recoveredObservation(h, first)
  h.scheduler.resumeOwnedSurface(first, firstOutcome)
  h.step(); await microtasks(); h.step(); await microtasks()
  const old = h.calls.presents[1]
  const draining = h.scheduler.suspendOwnedSurface('second loss')
  assert.equal(h.scheduler.status.accepted, null)
  assert.throws(() => h.scheduler.resumeOwnedSurface(first, firstOutcome), error => error.code === 'ERR_CANCELLED')
  oldAck.resolve({ acknowledged: true, publication: old.context.proof.publication, inputEnabled: true })
  const second = await draining
  assert.notEqual(second.recoveryId, first.recoveryId)
  assert.notEqual(second.base, null)
  assert.equal(h.calls.releases[1].context.committed, true)
  assert.equal(h.calls.releases[1].context.retired, true)
  const secondOutcome = recoveredObservation(h, second)
  assert.equal(h.scheduler.resumeOwnedSurface(second, secondOutcome).retained, true)
  await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 2)
  assert.equal(h.scheduler.status.accepted.proof.surfaceGeneration, '3')
})

test('normal suspension retires a surface ticket without closing its Worker', async t => {
  const h = harness(t)
  await firstFrame(h)
  const ticket = await h.scheduler.suspendOwnedSurface()
  h.scheduler.suspend('metrics')
  assert.throws(() => h.scheduler.resumeOwnedSurface(ticket, {}), error => error.code === 'ERR_CANCELLED')
  h.observe({ surfaceGeneration: '2', viewport: { x: 0, y: 0, width: 414, height: 736 } })
  h.scheduler.resume(); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.lifecycle.includes('cancel-owned'), false)
})

test('a false recovery receipt or reused publication never enables input', async t => {
  const h = harness(t, { preparePaint(captured, accepted, context, make) {
    return make(captured, context, { input: accepted.proof.consumedInput, renderRevision: accepted.proof.publication.renderRevision })
  } })
  await firstFrame(h)
  const ticket = await h.scheduler.suspendOwnedSurface()
  const outcome = recoveredObservation(h, ticket)
  assert.throws(() => h.scheduler.resumeOwnedSurface(ticket, { ...outcome, inputLifetimeRevision: outcome.previousInputLifetimeRevision }), error => error.code === 'ERR_PROTOCOL_VERSION')
  h.scheduler.resumeOwnedSurface(ticket, outcome); await settle(h)
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(h.calls.presents.length, 1)
})

test('surface recovery does not bypass an uncertain release or closing ownership barrier', async () => {
  const ack = deferred(), cleanupError = new Error('GPU candidate release failed')
  const h = harness(null, {
    present(candidate, context) { return context.attemptId === '2' ? ack.promise : { acknowledged: true, publication: context.proof.publication, inputEnabled: true } },
    release(candidate, context) { if (context.attemptId === '2') throw cleanupError },
  })
  await firstFrame(h)
  h.observe({ renderRevision: '2' }); h.step(); await microtasks(); h.step(); await microtasks()
  const drain = h.scheduler.suspendOwnedSurface()
  const flight = h.calls.presents[1]
  ack.resolve({ acknowledged: true, publication: flight.context.proof.publication, inputEnabled: true })
  await assert.rejects(drain, error => error.code === 'ERR_RENDER')
  assert.equal(h.scheduler.status.phase, 'faulted')
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.queue.size, 0)
  await assert.rejects(h.scheduler.close(), error => error instanceof AggregateError && error.errors.includes(cleanupError))
})

test('reentrant close during surface-loss freeze cancels the stable recovery transaction', async () => {
  let h, closed
  h = harness(null, { freezeInput(reason) { if (reason === 'webglcontextlost') closed = h.scheduler.close() } })
  await firstFrame(h)
  const drain = h.scheduler.suspendOwnedSurface('webglcontextlost')
  await assert.rejects(drain, error => error.code === 'ERR_CANCELLED')
  await closed
  assert.equal(h.scheduler.status.phase, 'closed')
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.lifecycle.filter(item => item === 'dispose').length, 1)
})

test('close drains late recovery preparation and release before disposing its owner', async () => {
  const prepare = deferred(), release = deferred()
  let h
  h = harness(null, {
    prepareTemplate() { return prepare.promise },
    release() { return release.promise },
    cancelOwnedWork() {
      const first = h.calls.templates[0]
      prepare.resolve(h.prepared(first.captured, first.context))
    },
  })
  h.observe(); h.step(); await microtasks()
  const drain = h.scheduler.suspendOwnedSurface()
  const rejected = assert.rejects(drain, error => error.code === 'ERR_CANCELLED')
  let closed = false
  const closing = h.scheduler.close().then(() => { closed = true })
  await microtasks()
  assert.equal(closed, false)
  assert.equal(h.calls.lifecycle.includes('dispose'), false)
  assert.equal(h.calls.presents.length, 0)
  release.resolve()
  await Promise.all([rejected, closing])
  assert.deepEqual(h.calls.lifecycle, ['cancel-owned', 'release:1', 'dispose'])
  assert.equal(h.scheduler.status.phase, 'closed')
  assert.equal(h.scheduler.status.accepted, null)
})

test('abort listener reentrancy keeps the newest page behind old candidate release', async t => {
  const gate = deferred()
  let h
  h = harness(t, { prepareTemplate(captured, context, make) {
    if (context.attemptId !== '1') return make(captured, context)
    context.signal.addEventListener('abort', () => {
      h.observe({ currentPage: { pageId: '3', path: 'pages/newest/index' } })
    }, { once: true })
    return gate.promise
  } })
  h.observe(); h.step(); await microtasks()
  h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.queue.size, 0)
  const first = h.calls.templates[0]
  gate.resolve(h.prepared(first.captured, first.context))
  await settle(h)
  assert.deepEqual(h.calls.templates.map(call => call.captured.currentPage.pageId), ['1', '3'])
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '3')
})

test('cancelFrame failure faults ownership before another RAF can be admitted', async () => {
  const failure = new Error('RAF cancellation failed')
  let h
  const phases = []
  h = harness(null, {
    cancelFrame() { throw failure },
    onError() { phases.push(h.scheduler.status.phase) },
  })
  h.observe()
  h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' } })
  assert.equal(h.scheduler.status.phase, 'faulted')
  assert.deepEqual(phases, ['faulted'])
  assert.deepEqual(h.calls.requested, [1])
  assert.equal(h.calls.templates.length, 0)
  assert.throws(() => h.observe(), error => error.code === 'ERR_RENDER')
  await assert.rejects(h.scheduler.close(), error => error instanceof AggregateError && error.errors.includes(failure))
})


test('v2 runtime owner is preserved while scheduler resources require the exact presenter generation', async t => {
  const owner = { ...OWNER, presenterGeneration: '7' }, h = harness(t, {}, owner)
  const runtimeOwner = Object.fromEntries(['workerEpoch', 'sessionId', 'packSha256'].map(key => [key, OWNER[key]]))
  const presenterBinding = { version: '1.0', sessionId: OWNER.sessionId, generation: '7', transportBackend: OWNER.transportBackend }
  h.observe({ owner: runtimeOwner, presenterBinding, transitionRequired: false, requiresRestart: false })
  await settle(h)
  assert.deepEqual(h.scheduler.owner, owner)
  assert.equal(h.scheduler.status.accepted.proof.owner.presenterGeneration, '7')
  assert.throws(() => h.observe({ presenterBinding: { ...presenterBinding, generation: '8' } }), /another immutable owner/)
})

test('same-family generation replacement is rejected before old scheduler reuses a prepared proof', async t => {
  const owner = { ...OWNER, presenterGeneration: '3' }, h = harness(t, {}, owner)
  const runtimeOwner = Object.fromEntries(['workerEpoch', 'sessionId', 'packSha256'].map(key => [key, OWNER[key]]))
  const state = { ...initialState(owner), owner: runtimeOwner, presenterBinding: { version: '1.0', sessionId: OWNER.sessionId, generation: '3', transportBackend: 'external-frame' },
    transitionRequired: false, requiresRestart: false }
  h.scheduler.observe({ version: '2.0', sequence: '1', state }); await settle(h)
  assert.throws(() => h.scheduler.observe({ version: '2.0', sequence: '2', state: { ...state, presenterBinding: { ...state.presenterBinding, generation: '4' } } }), /another immutable owner/)
  assert.equal(h.calls.templates.length, 1)
})


// ACK-side effects can supersede a genuine visual commit before input is
// re-enabled. These are deterministic scheduling contracts, not browser proof.
async function untilScheduler(h, predicate, limit = 80) {
  for (let turn = 0; turn < limit; turn++) {
    await microtasks()
    if (predicate()) return
    h.step()
  }
  assert.fail('scheduler did not reach the bounded test checkpoint')
}

test('ACK-side paint invalidation retains a disabled exact baseline until successor ACK and release barrier', async t => {
  const release = deferred(), ack = deferred()
  let h
  h = harness(t, {
    present(candidate, context) {
      if (context.attemptId !== '1') return ack.promise
      h.observe({ renderRevision: '2', viewRevision: '1' })
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
    },
    release(candidate, context) { if (context.attemptId === '1') return release.promise },
  })
  try {
  h.observe({ inputLifetimeRevision: '7' })
  await untilScheduler(h, () => h.calls.releases.length === 1)
  const first = h.scheduler.status.accepted
  assert.equal(first.inputEnabled, false)
  assert.equal(first.proof.publication.renderRevision, '1')
  assert.equal(first.proof.consumedInput.templateRevision, '1')
  assert.equal(h.scheduler.status.latest.renderRevision, '2')
  assert.equal(h.scheduler.status.latest.inputLifetimeRevision, '7')
  assert.equal(h.scheduler.status.failed, null)
  assert.deepEqual(h.calls.errors, [])
  assert.ok(h.calls.freezes.includes('presentation-superseded'))
  assert.equal(h.scheduler.retry(), false, 'supersession is demand, not a retryable failure')
  h.observe({ renderRevision: '4' })
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.queue.size, 0, 'successor cannot overlap exact old release')
  release.resolve()
  await untilScheduler(h, () => h.calls.presents.length === 2)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 1)
  assert.equal(h.calls.paints[0].captured.renderRevision, '4', 'pending observations coalesce')
  assert.equal(h.calls.paints[0].accepted.proof, first.proof)
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  const successor = h.calls.presents[1]
  ack.resolve({ acknowledged: true, publication: successor.context.proof.publication, inputEnabled: true })
  await settle(h)
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
  assert.equal(h.scheduler.status.accepted.proof.publication.renderRevision, '4')
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.calls.releases.length, 2)
  assert.deepEqual(h.calls.errors, [])
  } finally {
    // Keep the same-input failing control finite even if an assertion throws
    // while the injected release/ACK is deliberately held.
    release.resolve()
    const proof = h.calls.presents.at(-1)?.context.proof
    if (proof) ack.resolve({ acknowledged: true, publication: proof.publication, inputEnabled: true })
  }
})

for (const backend of ['external-frame', 'browser-view']) test(`ACK-side newer template uses its own successor proof for ${backend}`, async t => {
  const identity = { ...OWNER, transportBackend: backend }
  let h
  h = harness(t, { present(candidate, context) {
    if (context.attemptId === '1') {
      h.observe({ templateRevision: '2', ...(backend === 'external-frame' ? { renderRevision: context.proof.publication.renderRevision } : {}) })
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
    }
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: true }
  } }, identity)
  h.observe(); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '2')
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
  assert.equal(h.scheduler.status.failed, null)
  assert.deepEqual(h.calls.errors, [])
})

test('ACK observation equal to exact publication with only newer activity remains a committed failure', async t => {
  let h
  h = harness(t, { present(candidate, context) {
    // Newer than captured render=0, but equal to the actual clone publication.
    h.observe({ renderRevision: context.proof.publication.renderRevision, viewRevision: '99' })
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_RENDER')
  assert.equal(h.calls.errors.length, 1)
  h.observe({ viewRevision: '100' }); await settle(h)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.queue.size, 0)
})

test('stale observation and ACK-time state decorations cannot manufacture a successor', async t => {
  let h
  h = harness(t, { present(candidate, context) {
    const result = h.scheduler.observe({ sequence: '1', state: { ...h.state, templateRevision: '99', renderRevision: '99' } })
    assert.equal(result.accepted, false)
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: false,
      observedState: { templateRevision: '99', renderRevision: '99' }, scheduling: { templateRevision: '99' } }
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.latest.renderRevision, '0')
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_RENDER')
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.calls.errors.length, 1)
})

for (const kind of ['template', 'render']) test(`revision ahead of captured demand but behind clone-time ${kind} proof cannot justify disabled ACK`, async t => {
  let h
  h = harness(t, {
    prepareTemplate(captured, context, prepared) { return prepared(captured, context, kind === 'template' ? { templateRevision: '3' } : { renderRevision: '5' }) },
    present(candidate, context) {
      h.observe(kind === 'template' ? { templateRevision: '2', renderRevision: context.proof.publication.renderRevision } : { renderRevision: '4' })
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
    },
  })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_RENDER')
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.calls.errors.length, 1)
})

for (const [name, patch] of [
  ['page', { currentPage: { pageId: '2', path: 'pages/detail/index' } }],
  ['route', { currentPage: { pageId: '1', path: 'pages/other/index' } }],
  ['viewport', { viewport: { x: 0, y: 0, width: 414, height: 736 } }],
  ['profile', { rendererProfile: 'skyline-compat' }],
  ['lifecycle', { lifecycle: 'Background' }],
  ['surface', { surfaceGeneration: '2' }],
  ['native input lifetime', { inputLifetimeRevision: '2' }],
]) test(`disabled irreversible ACK after ${name} hard fence never accepts old proof`, async t => {
  let h
  h = harness(t, { present(candidate, context) {
    if (context.attemptId === '1') {
      h.observe({ renderRevision: '2', ...patch })
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
    }
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: true }
  } })
  h.observe({ inputLifetimeRevision: '1' }); await settle(h)
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.deepEqual(h.calls.errors, [])
  if (name === 'lifecycle') { assert.equal(h.scheduler.status.accepted, null); assert.equal(h.calls.presents.length, 1) }
  else { assert.equal(h.scheduler.status.accepted.inputEnabled, true); assert.equal(h.scheduler.status.accepted.proof.attemptId, '2'); assert.equal(h.calls.paints.length, 0) }
})

test('a newer pending publication cannot excuse restart-required disabled final', async t => {
  let h
  h = harness(t, { present(candidate, context) {
    h.observe({ renderRevision: '2' })
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: false, requiresRestart: true }
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.phase, 'restart-required')
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_RENDER')
  assert.equal(h.calls.errors.length, 1)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.queue.size, 0)
  assert.throws(() => h.scheduler.retry(), failure => failure.requiresRestart === true)
})

test('renderer family transition remains restart-required during disabled ACK', async t => {
  let h
  h = harness(t, { present(candidate, context) {
    assert.throws(() => h.observe({ renderRevision: '2', rendererProfile: 'webview' }), failure => failure.requiresRestart === true)
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.phase, 'restart-required')
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.calls.errors.length, 1)
  assert.equal(h.calls.errors[0].code, 'ERR_UNSUPPORTED_CAPABILITY')
})

test('local presenter transition retires disabled ACK before pending work can accept it', async t => {
  const ack = deferred()
  const h = harness(t, { present(candidate, context) { return context.attemptId === '1' ? ack.promise : { acknowledged: true, publication: context.proof.publication, inputEnabled: true } } })
  h.observe(); await untilScheduler(h, () => h.calls.presents.length === 1)
  const old = h.calls.presents[0]
  h.observe({ renderRevision: '2' }); h.scheduler.suspend('renderer-transition')
  ack.resolve({ acknowledged: true, publication: old.context.proof.publication, inputEnabled: false })
  await untilScheduler(h, () => !h.scheduler.status.inFlight)
  assert.equal(h.scheduler.status.phase, 'suspended')
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.queue.size, 0)
  h.scheduler.resume(); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
  assert.deepEqual(h.calls.errors, [])
})

test('foreign immutable owner cannot become pending supersession authority', async t => {
  let h
  h = harness(t, { present(candidate, context) {
    assert.throws(() => h.scheduler.observe({ sequence: '2', state: { ...h.state, owner: { ...OWNER, sessionId: 'foreign' }, renderRevision: '2' } }), failure => failure.code === 'ERR_PROTOCOL_VERSION')
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
  } })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.observationSequence, '1')
  assert.equal(h.scheduler.status.failed.error.code, 'ERR_RENDER')
  assert.equal(h.calls.presents.length, 1)
})

test('uncertain release after superseded ACK faults and exposes its real cleanup error', async () => {
  const failure = new Error('superseded candidate cleanup uncertain')
  let h
  h = harness(null, {
    present(candidate, context) { h.observe({ renderRevision: '2' }); return { acknowledged: true, publication: context.proof.publication, inputEnabled: false } },
    release() { throw failure },
  })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.phase, 'faulted')
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.deepEqual(h.calls.errors, [failure])
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.queue.size, 0)
  await assert.rejects(h.scheduler.close(), error => error instanceof AggregateError && error.errors.includes(failure))
  assert.deepEqual(h.calls.lifecycle, ['release:1', 'cancel-owned', 'dispose'])
})

test('close drains exact superseded candidate without admitting a successor', async () => {
  const release = deferred()
  let h
  h = harness(null, {
    present(candidate, context) { h.observe({ renderRevision: '2' }); return { acknowledged: true, publication: context.proof.publication, inputEnabled: false } },
    release() { return release.promise },
    cancelOwnedWork() { release.resolve() },
  })
  h.observe(); await untilScheduler(h, () => h.calls.releases.length === 1)
  const closed = h.scheduler.close(); assert.equal(closed, h.scheduler.close())
  assert.deepEqual(await closed, { closed: true })
  assert.equal(h.scheduler.status.phase, 'closed')
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.queue.size, 0)
  assert.deepEqual(h.calls.errors, [])
  assert.deepEqual(h.calls.lifecycle, ['release:1', 'cancel-owned', 'dispose'])
})


test('reentrant hard fence from superseded freeze cannot restore the old accepted baseline', async t => {
  let h
  h = harness(t, {
    present(candidate, context) {
      if (context.attemptId === '1') h.observe({ renderRevision: '2' })
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: context.attemptId !== '1' }
    },
    freezeInput(reason) { if (reason === 'presentation-superseded') h.observe({ currentPage: { pageId: '2', path: 'pages/detail/index' }, renderRevision: '3' }) },
  })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.pageId, '2')
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.calls.paints.length, 0)
  assert.deepEqual(h.calls.errors, [])
})

test('superseded input-freeze failure remains a visible fault with uncertain cleanup', async () => {
  const failure = new Error('superseded input freeze uncertain')
  let h
  h = harness(null, {
    present(candidate, context) { h.observe({ renderRevision: '2' }); return { acknowledged: true, publication: context.proof.publication, inputEnabled: false } },
    freezeInput(reason) { if (reason === 'presentation-superseded') throw failure },
  })
  h.observe(); await settle(h)
  assert.equal(h.scheduler.status.phase, 'faulted')
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
  assert.deepEqual(h.calls.errors, [failure])
  assert.equal(h.calls.releases[0].context.committed, true)
  assert.equal(h.queue.size, 0)
  await assert.rejects(h.scheduler.close(), error => error instanceof AggregateError && error.errors.includes(failure))
  assert.deepEqual(h.calls.lifecycle, ['release:1', 'cancel-owned', 'dispose'])
})

const BROWSER_OWNER = Object.freeze({ ...OWNER, transportBackend: 'browser-view' })

test('initial template can discover sample proof before the native state field appears', async t => {
  let h
  h = harness(t, {
    prepareTemplate(captured, context, make) {
      assert.equal(captured.sampleDemandRevision, undefined)
      return make(captured, context, { sample: { demandRevision: '0', sampleRevision: '1' } })
    },
    present(candidate, context) {
      if (context.attemptId === '1') h.observe({ sampleDemandRevision: '0' })
      return { acknowledged: true, publication: context.proof.publication, inputEnabled: true,
        consumedSample: { demandRevision: '999', sampleRevision: '999' } }
    },
  }, BROWSER_OWNER)
  await firstFrame(h)
  const initial = h.scheduler.status.accepted.proof
  assert.deepEqual(initial.consumedSample, { demandRevision: '0', sampleRevision: '1' })
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  const painted = h.scheduler.status.accepted.proof
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 1)
  assert.deepEqual(painted.consumedInput, initial.consumedInput)
  assert.equal(painted.publication.key.documentRevision, initial.publication.key.documentRevision)
  assert.ok(BigInt(painted.publication.key.presentationRevision) > BigInt(initial.publication.key.presentationRevision))
  assert.equal(painted.consumedSample.demandRevision, '1')
  assert.deepEqual(h.calls.errors, [])
})

test('discovering native sample demand after a legacy document obtains its template baseline', async t => {
  const h = harness(t, {}, BROWSER_OWNER)
  await firstFrame(h)
  assert.equal(h.scheduler.status.accepted.proof.consumedSample, undefined)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.scheduler.status.accepted.proof.consumedSample.demandRevision, '0')
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 1)
})

test('established native sample demand cannot regress or disappear across a hard boundary', async t => {
  for (const sampleDemandRevision of ['9007199254740992', undefined]) {
    const h = harness(t, {}, BROWSER_OWNER)
    h.observe({ sampleDemandRevision: '9007199254740993' }); await settle(h)
    assert.throws(() => h.observe({ sampleDemandRevision, surfaceGeneration: '2' }),
      failure => failure.code === 'ERR_PROTOCOL_VERSION' && /sample demand/.test(failure.message))
    assert.equal(h.scheduler.status.accepted, null)
    assert.equal(h.scheduler.status.phase, 'faulted')
    assert.equal(h.scheduler.status.latest.sampleDemandRevision, '9007199254740993')
    await settle(h)
    assert.equal(h.calls.templates.length, 1)
  }
})

for (const [name, mutate] of [
  ['missing', proof => { delete proof.consumedSample }],
  ['null', proof => { proof.consumedSample = null }],
  ['extra key', proof => { proof.consumedSample.extra = true }],
  ['noncanonical demand', proof => { proof.consumedSample.demandRevision = '01' }],
  ['overflowing demand', proof => { proof.consumedSample.demandRevision = '18446744073709551616' }],
  ['numeric sample', proof => { proof.consumedSample.sampleRevision = 1 }],
  ['noncanonical sample', proof => { proof.consumedSample.sampleRevision = '-1' }],
  ['old demand', proof => { proof.consumedSample.demandRevision = '0' }],
]) test(`sample-enabled preparation rejects ${name} consumedSample and releases its candidate`, async t => {
  const h = harness(t, { prepareTemplate(captured, context, make) {
    const candidate = make(captured, context); mutate(candidate.proof); return candidate
  } }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.calls.presents.length, 0)
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.scheduler.status.accepted, null)
  assert.equal(h.calls.errors.length, 1)
  assert.equal(h.calls.errors[0].code, 'ERR_PROTOCOL_VERSION')
})

test('newer template input takes precedence over simultaneous sample demand', async t => {
  const h = harness(t, {}, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  h.observe({ templateRevision: '2', sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.calls.templates.length, 2)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '2')
  assert.equal(h.scheduler.status.accepted.proof.consumedSample.demandRevision, '1')
})

for (const phase of ['prepare', 'present']) test(`new sample demand during blocked ${phase} waits for exact release then coalesces`, async t => {
  const blocked = deferred(), released = deferred()
  const h = harness(t, {
    preparePaint(captured, accepted, context) {
      if (phase === 'prepare' && context.attemptId === '2') return blocked.promise
    },
    present(candidate, context) {
      if (phase === 'present' && context.attemptId === '2') return blocked.promise
    },
    release(candidate, context) { if (context.attemptId === '2') return released.promise },
  }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  h.observe({ sampleDemandRevision: '1' }); h.step(); await microtasks()
  if (phase === 'present') { h.step(); await microtasks() }
  const flight = h.calls.paints[0]
  for (let revision = 2; revision <= 30; revision++) h.observe({ sampleDemandRevision: String(revision) })
  assert.equal(flight.context.signal.aborted, false)
  assert.equal(h.calls.paints.length, 1)
  if (phase === 'prepare') {
    blocked.resolve(h.prepared(flight.captured, flight.context, {
      input: flight.accepted.proof.consumedInput,
      documentRevision: flight.accepted.proof.publication.key.documentRevision,
    }))
    await microtasks(); h.step(); await microtasks()
  } else {
    const proof = h.calls.presents.at(-1).context.proof
    blocked.resolve({ acknowledged: true, publication: proof.publication, inputEnabled: false,
      consumedSample: { demandRevision: '30', sampleRevision: '999' } })
    await microtasks()
  }
  assert.equal(h.calls.releases.length, 2)
  assert.equal(h.calls.releases[1].context.proof.consumedSample.demandRevision, '1')
  assert.equal(h.calls.releases[1].context.committed, true)
  assert.equal(h.calls.paints.length, 1, 'pending release owns the successor barrier')
  assert.equal(h.scheduler.status.accepted.proof.consumedSample.demandRevision, '1')
  released.resolve(); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 2)
  assert.equal(h.calls.paints[1].captured.sampleDemandRevision, '30')
  assert.equal(h.scheduler.status.accepted.proof.consumedSample.demandRevision, '30')
  assert.deepEqual(h.calls.errors, [])
})

test('sample proof is frozen before raw mutations and ACK decorations', async t => {
  const h = harness(t, { present(candidate, context) {
    candidate.proof.consumedSample.demandRevision = '999'
    candidate.proof.consumedSample.sampleRevision = '999'
    return { acknowledged: true, publication: context.proof.publication, inputEnabled: true,
      scheduling: { consumedSample: { demandRevision: '1000', sampleRevision: '1000' } } }
  } }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  assert.deepEqual(h.scheduler.status.accepted.proof.consumedSample, { demandRevision: '0', sampleRevision: '1' })
  assert.equal(Object.isFrozen(h.scheduler.status.accepted.proof.consumedSample), true)
  h.observe({ viewRevision: '50' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 0)
})

test('one attempt cannot replace sample proof retained before its result returns', async t => {
  const h = harness(t, { prepareTemplate(captured, context, make) {
    const candidate = make(captured, context)
    assert.equal(context.retainFrameProof(candidate.proof), true)
    candidate.proof.consumedSample.sampleRevision = '2'
    return candidate
  } }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  assert.equal(h.calls.presents.length, 0)
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.calls.releases[0].context.proof.consumedSample.sampleRevision, '1')
  assert.match(h.calls.errors[0].message, /cannot replace its clone proof/)
})

test('actual sample clone ahead of captured demand consumes that lower bound without invented sample ordering', async t => {
  const h = harness(t, {
    prepareTemplate(captured, context, make) {
      return make(captured, context, { sample: { demandRevision: '5', sampleRevision: '100' } })
    },
    preparePaint(captured, accepted, context, make) {
      return make(captured, context, { input: accepted.proof.consumedInput,
        documentRevision: accepted.proof.publication.key.documentRevision,
        sample: { demandRevision: captured.sampleDemandRevision, sampleRevision: '0' } })
    },
  }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '3' }); await settle(h)
  h.observe({ sampleDemandRevision: '4' }); await settle(h)
  assert.equal(h.calls.paints.length, 0)
  h.observe({ sampleDemandRevision: '6' }); await settle(h)
  assert.equal(h.calls.paints.length, 1)
  assert.deepEqual(h.scheduler.status.accepted.proof.consumedSample, { demandRevision: '6', sampleRevision: '0' })
})

test('failed sample demand stays suppressed until genuinely newer sample demand arrives', async t => {
  const h = harness(t, { preparePaint(captured, accepted, context) {
    if (context.attemptId === '2') throw new Error('sample prepare failed before proof')
  } }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.scheduler.status.phase, 'blocked')
  h.observe({ viewRevision: '99', renderRevision: '99' }); await settle(h)
  assert.equal(h.calls.paints.length, 1)
  h.observe({ sampleDemandRevision: '2' }); await settle(h)
  assert.equal(h.calls.paints.length, 2)
  assert.equal(h.scheduler.status.accepted.proof.consumedSample.demandRevision, '2')
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
})

test('failed prepared sample5 suppresses latest5 even when its captured demand was1', async t => {
  let h
  h = harness(t, {
    preparePaint(captured, accepted, context, make) {
      if (context.attemptId === '2') return make(captured, context, {
        input: accepted.proof.consumedInput, documentRevision: accepted.proof.publication.key.documentRevision,
        sample: { demandRevision: '5', sampleRevision: '2' },
      })
    },
    present(candidate, context) {
      if (context.attemptId === '2') {
        h.observe({ sampleDemandRevision: '5' })
        throw new Error('prepared sample5 failed')
      }
    },
  }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.calls.paints.length, 1)
  assert.equal(h.scheduler.status.failed.proof.consumedSample.demandRevision, '5')
  h.observe({ viewRevision: '99' }); await settle(h)
  assert.equal(h.calls.paints.length, 1)
  h.observe({ sampleDemandRevision: '6' }); await settle(h)
  assert.equal(h.calls.paints.length, 2)
  assert.equal(h.scheduler.status.accepted.proof.consumedSample.demandRevision, '6')
})

test('sample demand behind the cloned proof cannot excuse an input-disabled final ACK', async t => {
  let h
  h = harness(t, {
    prepareTemplate(captured, context, make) {
      return make(captured, context, { sample: { demandRevision: '5', sampleRevision: '1' } })
    },
    present(candidate, context) {
      if (context.attemptId === '1') {
        h.observe({ sampleDemandRevision: '4' })
        return { acknowledged: true, publication: context.proof.publication, inputEnabled: false }
      }
    },
  }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '3' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 0)
  assert.equal(h.scheduler.status.phase, 'blocked')
  assert.equal(h.scheduler.status.failed.proof.consumedSample.demandRevision, '5')
  assert.equal(h.calls.releases[0].context.committed, true)
  h.observe({ sampleDemandRevision: '6' }); await settle(h)
  assert.equal(h.calls.paints.length, 1)
  assert.equal(h.scheduler.status.accepted.inputEnabled, true)
})

test('browser sample paint cannot relabel the accepted template input', async t => {
  const h = harness(t, { preparePaint(captured, accepted, context, make) {
    return make(captured, context, { input: inputFor(captured, '2'),
      documentRevision: accepted.proof.publication.key.documentRevision })
  } }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  const input = h.scheduler.status.accepted.proof.consumedInput
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.calls.releases.length, 2)
  assert.deepEqual(h.scheduler.status.accepted.proof.consumedInput, input)
  assert.match(h.calls.errors[0].message, /cannot relabel/)
})

test('external frames still require actual render demand alongside optional sample proof', async t => {
  const h = harness(t)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.paints.length, 0)
  h.observe({ renderRevision: '2' }); await settle(h)
  assert.equal(h.calls.paints.length, 1)
  assert.equal(h.scheduler.status.accepted.proof.consumedSample.demandRevision, '1')
})

for (const [name, keyPatch] of [
  ['changed document', { documentRevision: '2' }],
  ['equal presentation', { presentationRevision: '1' }],
  ['regressed presentation', { presentationRevision: '0' }],
]) test(`retained browser sample rejects ${name} key`, async t => {
  const h = harness(t, { preparePaint(captured, accepted, context, make) {
    return make(captured, context, { input: accepted.proof.consumedInput,
      documentRevision: accepted.proof.publication.key.documentRevision, ...keyPatch })
  } }, BROWSER_OWNER)
  h.observe({ sampleDemandRevision: '0' }); await settle(h)
  const initial = h.scheduler.status.accepted.proof
  h.observe({ sampleDemandRevision: '1' }); await settle(h)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.calls.releases.length, 2)
  assert.equal(h.calls.errors.length, 1)
  assert.equal(h.scheduler.status.accepted.proof, initial)
  assert.equal(h.scheduler.status.accepted.inputEnabled, false)
})


test('Worker preparation coalesces current demand before RAF and only presents on RAF', async t => {
  const h = harness(t, { preparationScheduling: 'microtask' })
  h.observe(); h.observe({ templateRevision: '2' }); h.observe({ templateRevision: '3' })
  assert.equal(h.calls.templates.length, 0)
  assert.equal(h.calls.requested.length, 0)
  await microtasks()
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.templates[0].captured.templateRevision, '3')
  assert.equal(h.calls.presents.length, 0)
  assert.equal(h.calls.requested.length, 1)
  h.step(); await microtasks()
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.templateRevision, '3')
})

test('closing a queued Worker preparation never starts work or cancels a fake RAF handle', async () => {
  const h = harness(null, { preparationScheduling: 'microtask' })
  h.observe(); const closing = h.scheduler.close()
  await microtasks(); await closing
  assert.equal(h.calls.templates.length, 0)
  assert.deepEqual(h.calls.requested, [])
  assert.deepEqual(h.calls.cancelled, [])
  assert.equal(h.scheduler.status.phase, 'closed')
})

test('navigation retires queued Worker preparation before its microtask and keeps only newest coordinates', async t => {
  const h = harness(t, { preparationScheduling: 'microtask' })
  h.observe()
  h.observe({ currentPage: { pageId: '2', path: 'pages/next/index' }, surfaceGeneration: '2',
    viewport: { x: 0, y: 0, width: 500, height: 600 } })
  await settle(h)
  assert.equal(h.calls.templates.length, 1)
  assert.equal(h.calls.templates[0].captured.currentPage.pageId, '2')
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.viewport.width, 500)
  assert.deepEqual(h.calls.cancelled, [])
})

test('retired asynchronous Worker preparation releases before its successor and never presents stale proof', async t => {
  const first = deferred()
  const h = harness(t, { preparationScheduling: 'microtask', prepareTemplate(captured, context, prepared) {
    return context.attemptId === '1' ? first.promise.then(() => prepared(captured, context)) : prepared(captured, context)
  } })
  h.observe(); await microtasks()
  h.observe({ viewport: { x: 0, y: 0, width: 500, height: 600 }, surfaceGeneration: '2' })
  await microtasks()
  assert.equal(h.calls.templates.length, 1)
  first.resolve(); await settle(h)
  assert.equal(h.calls.releases.length, 2)
  assert.equal(h.calls.releases[0].context.retired, true)
  assert.equal(h.calls.presents.length, 1)
  assert.equal(h.calls.presents[0].context.attemptId, '2')
  assert.equal(h.scheduler.status.accepted.proof.consumedInput.viewport.width, 500)
})
