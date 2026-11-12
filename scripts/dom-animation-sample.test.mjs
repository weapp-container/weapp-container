import assert from 'node:assert/strict'
import test from 'node:test'
import { DomViewPresenter } from '../examples/hosts/web-wasm/dom-presenter.mjs'
import { DomSessionClient, SseBridgeTransport } from '../examples/hosts/web-wasm/dom-session-client.mjs'
import { copyAnimationRequest, copyAnimationStyles, computedAnimationBaseline, stageAnimationStyles } from '../examples/hosts/web-wasm/dom-animation-sample.mjs'

// Deterministic JS contract tests. These do not claim browser/WASM acceptance.
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
const style = (occurrenceId = 'root', patch = {}) => ({ occurrenceId, opacity: .4, transform: null, origin: null, ...patch })
const descriptor = (patch = {}) => ({ occurrenceId: 'root', opacity: true, transform: true, ...patch })
const computed = { opacity: '.7', transform: 'matrix(1, 0, 0, 1, 5, 6)', transformOrigin: '25px 30px', fontSize: '16px' }
function element(document, values = {}) {
  const properties = new Map(Object.entries(values).map(([name, value]) => [name, Array.isArray(value) ? value : [value, '']]))
  const node = { nodeType: 1, ownerDocument: document, isConnected: true, writes: [],
    style: { getPropertyValue: name => properties.get(name)?.[0] ?? '', getPropertyPriority: name => properties.get(name)?.[1] ?? '',
      setProperty(name, value, priority) { node.writes.push([name, value, priority]); properties.set(name, [value, priority]); node.onSet?.(name, value, priority) },
      removeProperty(name) { const before = properties.get(name)?.[0] ?? ''; node.writes.push([name, null]); properties.delete(name); return before },
    } }
  return node
}
function journalFixture(styles, options = {}) {
  const document = {}, root = element(document, { opacity: ['.7', 'important'], transform: 'translateX(5px)' }), second = element(document)
  const nodes = new Map([['root', root], ['second', second]])
  const journal = stageAnimationStyles(styles, { elementFor: id => nodes.get(id), document, ...options })
  return { journal, root, second, nodes }
}

test('baseline reads requested properties only and preserves computed affine/origin/font facts', () => {
  assert.deepEqual(computedAnimationBaseline(descriptor(), computed), { occurrenceId: 'root', opacity: .7,
    transform: { ...matrix, tx: 5, ty: 6 }, origin: { x: 25, y: 30 }, fontSize: 16 })
  const opacityOnly = computedAnimationBaseline(descriptor({ transform: false }), { ...computed,
    transform: 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)', transformOrigin: 'unsupported', fontSize: '0px' })
  assert.deepEqual(opacityOnly, { occurrenceId: 'root', opacity: .7, transform: null, origin: null, fontSize: 0 })
  assert.deepEqual(computedAnimationBaseline(descriptor({ opacity: false }), { ...computed, opacity: 'unrelated', transform: 'none' }).transform, matrix)
})

test('baseline rejects unsupported requested 3D/nonfinite/unresolved values', () => {
  for (const patch of [{ transform: 'matrix3d(1)' }, { transform: 'matrix(1,,0,1,0,0)' }, { transform: 'matrix(1,0,0,1,Infinity,0)' },
    { transformOrigin: '50% 50%' }, { transformOrigin: '0px 0px 1px' }, { opacity: 'NaN' }, { opacity: '1.1' }, { fontSize: '-1px' }]) {
    assert.throws(() => computedAnimationBaseline(descriptor(), { ...computed, ...patch }))
  }
})

test('baseline request and response require exact unique coverage and property-safe provisional layers', () => {
  const request = { version: '1.0', requestId: 'baseline1', baselines: [descriptor()], styles: [style('second')] }
  assert.equal(Object.isFrozen(copyAnimationRequest(request).baselines[0]), true)
  assert.deepEqual(computedAnimationBaseline(descriptor({ opacity: false, transform: false }), { fontSize: '12px' }),
    { occurrenceId: 'root', opacity: null, transform: null, origin: null, fontSize: 12 })
  for (const patch of [{ baselines: ['root'] }, { baselines: [descriptor(), descriptor()] }, { styles: [style()] }, { unexpected: true }]) assert.throws(() => copyAnimationRequest({ ...request, ...patch }))
  const contextOnly = { ...request, baselines: [descriptor({ opacity: false, transform: false })], styles: [style()] }
  assert.deepEqual(copyAnimationRequest(contextOnly).styles, [style()])
  assert.deepEqual(copyAnimationRequest({ ...request, baselines: [descriptor({ transform: false })],
    styles: [style('root', { opacity: null, transform: matrix, origin: '0px 0px' })] }).styles[0].transform, matrix)
  assert.throws(() => copyAnimationRequest({ ...request, baselines: [descriptor({ opacity: false })],
    styles: [style('root', { opacity: null, origin: '0px 0px' })] }), /overwrite an unbound baseline/)
  assert.throws(() => copyAnimationStyles([], ['root']))
  assert.throws(() => copyAnimationStyles([style(), style('second')], ['root']))
  assert.throws(() => copyAnimationStyles([style(), style()], ['root']))
  assert.throws(() => copyAnimationStyles([style('root', { transform: { ...matrix, tx: Infinity } })]))
})

test('complete style staging preflights every target before a single DOM write', () => {
  const document = {}, root = element(document), nodes = new Map([['root', root]])
  assert.throws(() => stageAnimationStyles([style(), style('missing')], { document, elementFor: id => nodes.get(id) }))
  assert.deepEqual(root.writes, [])
  assert.throws(() => stageAnimationStyles([style('root', { origin: '20px 30px' })], { document, elementFor: () => root, supports: name => name !== 'transform-origin' }))
  assert.deepEqual(root.writes, [])
})

test('partial mutation including a mutating throwing setter restores exact inline values and priorities', () => {
  const h = journalFixture([style('root', { transform: { ...matrix, tx: 22 } }), style('second')])
  h.second.onSet = () => { h.second.onSet = null; throw new Error('setter changed then threw') }
  assert.throws(() => h.journal.apply(), /setter changed then threw/)
  assert.equal(h.root.style.getPropertyValue('opacity'), '.7')
  assert.equal(h.root.style.getPropertyPriority('opacity'), 'important')
  assert.equal(h.root.style.getPropertyValue('transform'), 'translateX(5px)')
  assert.equal(h.root.style.getPropertyPriority('transform'), '')
  assert.equal(h.second.style.getPropertyValue('opacity'), '')
  assert.equal(h.journal.state, 'rolled-back')
})

test('target replacement, disconnection, stale owner or inline drift rejects before mutation', () => {
  for (const invalidate of [h => h.nodes.set('root', h.second), h => { h.root.isConnected = false }, h => h.root.style.setProperty('opacity', '.8', '')]) {
    const h = journalFixture([style()]); invalidate(h); const writes = h.root.writes.length
    assert.throws(() => h.journal.apply()); assert.equal(h.root.writes.length, writes)
  }
  let current = true; const h = journalFixture([style()], { isCurrent: () => current }); current = false
  assert.throws(() => h.journal.apply()); assert.deepEqual(h.root.writes, [])
})

test('a target replaced during an earlier setter cannot receive any sampled style', () => {
  const h = journalFixture([style(), style('second')])
  h.root.onSet = () => { h.root.onSet = null; h.nodes.delete('second') }
  assert.throws(() => h.journal.apply(), /identity changed during mutation/)
  assert.equal(h.second.writes.length, 0)
  assert.equal(h.root.style.getPropertyValue('opacity'), '.7')
  assert.equal(h.root.style.getPropertyPriority('opacity'), 'important')
})

test('rollback failures remain observable and acknowledged styles cannot retract', () => {
  const h = journalFixture([style()]); h.journal.apply()
  h.root.onSet = () => { throw new Error('rollback failed') }
  assert.throws(() => h.journal.rollback(), failure => failure.cleanupErrors?.[0]?.message === 'rollback failed')
  assert.throws(() => h.journal.rollback(), /rollback failed/)
  const accepted = journalFixture([style()]); accepted.journal.apply(); accepted.journal.acknowledge()
  assert.throws(() => accepted.journal.rollback(), /cannot roll back/)
  assert.equal(accepted.root.style.getPropertyValue('opacity'), '0.4')
})

function harness(t, { animation, documentNode = {}, baselineReply, sampleReply, ackReply, expectDisposeFailure = false } = {}) {
  const calls = [], candidates = [], hooks = new Map(); let revision = 0
  const presenter = new DomViewPresenter({ ownerDocument: {}, append() {} }, { timeoutMs: 1000 })
  presenter.createCandidate = async () => {
    const document = {}, root = element(document, { opacity: ['.7', 'important'] })
    const candidate = { root, connected: true, disposed: 0, interactive: false, supports: () => true, validateSelector() {},
      async populate(plan) { candidate.plan = plan }, snapshot() { return new Map() }, restore() { candidate.restored = true },
      isConnected() { return candidate.connected }, setVisible(value) { candidate.visible = value }, setInteractive(value) { candidate.interactive = value; candidate.activateHook?.(value) },
      animationBaselines(descriptors) { assert.equal(candidate.restored, true); assert.notEqual(candidate.visible, true); return descriptors.map(d => computedAnimationBaseline(d, computed)) },
      stageAnimation(styles, isCurrent) { return stageAnimationStyles(styles, { document, elementFor: id => id === 'root' ? root : undefined, isCurrent }) },
      measure() { if (candidate.measureFailure) throw new Error('measure failed'); return [{ occurrenceId: 'root', x: Number(root.style.getPropertyValue('opacity')), y: 0, width: 100, height: 50, scrollTop: 0, scrollHeight: 50, clientHeight: 50 }] },
      activate(send) { candidate.send = send }, dispose() { candidate.disposed++; candidate.connected = false; return candidate.plan?.dispose() ?? [] } }
    candidates.push(candidate); return candidate
  }
  const transport = { setSession() {}, dispose() {}, async request(op, payload, options) {
    calls.push({ op, payload: structuredClone(payload), options })
    const respond = () => {
      if (op === 'view.prepare') {
        const document = { version: '1.0', sessionId: 'session', pageId: 1, revision: ++revision, routePath: 'pages/home', profile: 'webview',
          nodes: [{ kind: 'element', occurrenceId: 'root', tag: 'view', attrs: {}, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' }, events: [], children: [], ...structuredClone(documentNode) }], styleRoots: [], styles: [], resources: [] }
        const key = { sessionId: 'session', pageId: '1', documentRevision: String(revision), presentationRevision: String(revision), surfaceGeneration: '1', profile: 'webview' }
        return { ok: true, submission: { version: '1.0', key, document, viewport: { width: 375, height: 667 }, ...(animation ? { animation } : {}) },
          scheduling: { version: '1.0', key, consumedInput: { pageId: '1', routePath: 'pages/home', templateRevision: '1', viewport: { x: 0, y: 0, width: 375, height: 667 } }, consumedSample: { demandRevision: '0', sampleRevision: '1' } } }
      }
      if (op === 'view.animation.baseline') return baselineReply ? baselineReply(payload) : { ok: true, version: '1.0', requestId: payload.requestId, key: payload.key, styles: payload.values.map(value => style(value.occurrenceId, { opacity: value.opacity })) }
      if (op === 'view.prepare.commit') return { ok: true, permit: { version: '1.0', key: payload.key, epoch: payload.epoch, permitId: 'template-permit' } }
      if (op === 'view.presented') return { ok: true, key: payload.key, inputEnabled: true }
      if (op === 'view.sample.prepare') {
        const key = { ...payload.baseKey, presentationRevision: String(++revision) }, consumedSample = { demandRevision: payload.sampleDemandRevision, sampleRevision: String(revision) }
        const submission = { version: '1.0', key, baseKey: payload.baseKey, baseGeometryEpoch: payload.baseGeometryEpoch, consumedSample, viewport: { width: 375, height: 667 }, styles: [style()] }
        const result = { ok: true, submission, scheduling: { version: '1.0', key, consumedInput: structuredClone(client.accepted.consumedInput), consumedSample },
          permit: { version: '1.0', key, baseKey: payload.baseKey, baseGeometryEpoch: payload.baseGeometryEpoch, consumedSample, permitId: 'sample-permit' } }
        return sampleReply ? sampleReply(result) : result
      }
      if (op === 'view.sample.presented') return ackReply ? ackReply(payload) : { ok: true, version: '1.0', key: payload.permit.key, consumedSample: payload.permit.consumedSample, inputEnabled: true }
      if (op === 'view.sample.abort') return { ok: true, version: '1.0', key: payload.key, aborted: true }
      return { ok: true }
    }
    return hooks.has(op) ? hooks.get(op)({ payload, respond }) : respond()
  } }
  const client = new DomSessionClient({ presenter, transport, timeoutMs: 1000 })
  client.updateAuthority({ sessionId: 'session', revision: '1', surfaceGeneration: '1' })
  t.after(async () => { if (expectDisposeFailure) await assert.rejects(client.dispose()); else await client.dispose() })
  const accept = async () => { const handle = await client.prepareTemplate({}); await client.presentPrepared(handle); await client.releasePrepared(handle); await tick(); await client.turn; return handle }
  return { client, presenter, calls, candidates, hooks, accept }
}

test('hidden template consumes evaluated animation data and binds numeric styles before ordinary geometry permit', async t => {
  const payload = { actions: [{ animates: [{ type: 'opacity', args: [.2] }], option: { duration: 100, delay: 0, timingFunction: 'linear', transformOrigin: '0px 0px' } }] }
  const h = harness(t, { documentNode: { attrs: { animation: JSON.stringify(payload), 'wx:if': '{{visible}}' }, typedAttrs: { animation: payload } },
    animation: { version: '1.0', requestId: 'baseline1', baselines: [descriptor({ transform: false })], styles: [] } })
  await h.accept()
  const candidate = h.candidates[0]
  assert.deepEqual(candidate.plan.document.nodes[0].typedAttrs.animation, payload)
  assert.equal(Object.hasOwn(candidate.plan.nodes[0].attrs, 'animation'), false)
  assert.equal(Object.hasOwn(candidate.plan.nodes[0].typedAttrs, 'animation'), false)
  assert.equal(Object.hasOwn(candidate.plan.nodes[0].attrs, 'wx:if'), false)
  assert.deepEqual(candidate.plan.nodes[0].domAttributes, {})
  assert.equal(candidate.root.writes.every(([name]) => name === 'opacity'), true)
  assert.deepEqual(h.calls.filter(c => ['view.animation.baseline', 'view.prepare.commit'].includes(c.op)).map(c => c.op), ['view.animation.baseline', 'view.prepare.commit'])
  const baseline = h.calls.find(c => c.op === 'view.animation.baseline').payload, admission = h.calls.find(c => c.op === 'view.prepare.commit').payload
  assert.deepEqual(baseline.values, [{ occurrenceId: 'root', opacity: .7, transform: null, origin: null, fontSize: 16 }])
  assert.equal(baseline.key.presentationRevision, admission.key.presentationRevision)
  assert.equal(BigInt(admission.epoch) > BigInt(baseline.epoch), true)
  assert.equal(admission.nodes[0].borderBox.x, .7)
})

test('an evaluated animation without matching baseline metadata fails before binding or geometry admission', async t => {
  const payload = { actions: [] }
  for (const mode of ['missing', 'other-occurrence', 'styles-only']) await t.test(mode, async t => {
    const animation = mode === 'missing' ? undefined : { version: '1.0', requestId: 'baseline1',
      baselines: mode === 'styles-only' ? [] : [descriptor({ occurrenceId: 'other', opacity: false, transform: false })],
      styles: mode === 'styles-only' ? [style('root', { opacity: null })] : [] }
    const h = harness(t, { animation, documentNode: { attrs: { animation: JSON.stringify(payload) }, typedAttrs: { animation: payload },
      children: [{ kind: 'element', occurrenceId: 'other', tag: 'view', attrs: {}, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' }, events: [], children: [] }] } })
    await assert.rejects(h.client.prepareTemplate({}), /no matching consumed animation metadata/)
    assert.equal(h.calls.some(c => ['view.animation.baseline', 'view.prepare.commit'].includes(c.op)), false)
    assert.equal(h.candidates[0].disposed, 1)
    assert.deepEqual(h.candidates[0].root.writes, [])
  })
})

test('missing, extra, stale or wrong-version baseline response never reaches template commit', async t => {
  for (const mode of ['missing', 'extra', 'stale', 'version']) await t.test(mode, async t => {
    const h = harness(t, { animation: { version: '1.0', requestId: 'baseline1', baselines: [descriptor({ transform: false })], styles: [] },
      baselineReply: payload => ({ ok: true, version: mode === 'version' ? '2.0' : '1.0', requestId: payload.requestId,
        key: mode === 'stale' ? { ...payload.key, presentationRevision: '99' } : payload.key,
        styles: mode === 'missing' ? [] : mode === 'extra' ? [style(), style('extra')] : [style()] }) })
    await assert.rejects(h.client.prepareTemplate({}))
    assert.equal(h.calls.some(c => c.op === 'view.prepare.commit'), false)
    assert.equal(h.candidates[0].disposed, 1)
    assert.equal(h.calls.filter(c => c.op === 'view.abort').length, 1)
  })
})

test('retained sample obtains permit before mutation and reuses accepted iframe/topology/resources', async t => {
  const h = harness(t); const original = await h.accept(), candidate = h.candidates[0], plan = candidate.plan
  const before = candidate.root.writes.length, prepared = await h.client.prepareSample('1')
  assert.equal(candidate.root.writes.length, before)
  assert.equal(candidate.interactive, false)
  assert.equal(prepared.key.documentRevision, original.key.documentRevision)
  assert.deepEqual(prepared.scheduling.consumedSample, { demandRevision: '1', sampleRevision: '2' })
  const result = await h.client.presentPrepared(prepared)
  assert.equal(result.inputEnabled, true); assert.equal(candidate.interactive, true)
  assert.equal(h.candidates.length, 1); assert.equal(h.presenter.current, candidate); assert.equal(candidate.plan, plan); assert.equal(candidate.disposed, 0)
  assert.equal(candidate.root.style.getPropertyValue('opacity'), '0.4')
  const published = h.calls.find(c => c.op === 'view.sample.presented').payload
  assert.equal(published.geometry.nodes[0].borderBox.x, .4)
  assert.deepEqual(published.permit.consumedSample, prepared.scheduling.consumedSample)
  assert.equal(h.presenter.currentEntry.key.presentationRevision, '2')
  assert.equal((await h.client.releasePrepared(prepared)).acknowledged, true)
  assert.equal(candidate.disposed, 0)
  assert.equal(h.calls.filter(c => c.op === 'view.prepare').length, 1)
})

test('sample measure failure and native ACK rejection roll back exact old styles and abort sample only', async t => {
  for (const mode of ['measure', 'ack']) await t.test(mode, async t => {
    const h = harness(t); const original = await h.accept(), candidate = h.candidates[0]
    const prepared = await h.client.prepareSample('1')
    if (mode === 'measure') candidate.measureFailure = true
    else h.hooks.set('view.sample.presented', () => ({ ok: false, error: { code: 'ERR_CANCELLED', message: 'native ACK rejected' } }))
    await assert.rejects(h.client.presentPrepared(prepared), mode === 'measure' ? /measure failed/ : /native ACK rejected/)
    candidate.measureFailure = false
    assert.equal(candidate.root.style.getPropertyValue('opacity'), '.7')
    assert.equal(candidate.root.style.getPropertyPriority('opacity'), 'important')
    assert.equal(candidate.disposed, 0); assert.equal(candidate.interactive, false)
    assert.deepEqual(h.presenter.currentEntry.key, original.key)
    const abort = h.calls.find(c => c.op === 'view.sample.abort')
    assert.deepEqual(abort.payload, { version: '1.0', key: prepared.key })
    assert.equal(h.calls.filter(c => c.op === 'view.abort').length, 0)
  })
})

test('sample preparation rejects wrong base, stale demand and permit/sample mismatch before mutation', async t => {
  for (const mode of ['base', 'demand', 'permit', 'topology', 'viewport', 'input', 'extra-key']) await t.test(mode, async t => {
    const h = harness(t, { sampleReply: result => {
      if (mode === 'base') result.submission.baseGeometryEpoch = '999'
      if (mode === 'demand') result.submission.consumedSample.demandRevision = '0'
      if (mode === 'permit') result.permit = { ...result.permit, consumedSample: { demandRevision: '1', sampleRevision: '999' } }
      if (mode === 'topology') result.submission.key = { ...result.submission.key, documentRevision: '999' }
      if (mode === 'viewport') result.submission.viewport.width = 500
      if (mode === 'input') result.scheduling.consumedInput.templateRevision = '999'
      if (mode === 'extra-key') result.permit.baseKey = { ...result.permit.baseKey, unknown: true }
      return result
    } }); await h.accept(); const before = h.candidates[0].root.writes.length
    await assert.rejects(h.client.prepareSample('1'))
    assert.equal(h.candidates[0].root.writes.length, before)
    assert.equal(h.calls.filter(c => c.op === 'view.sample.abort').length, 1)
  })
})

test('sample ACK cannot relabel consumed sample and post-ACK activation failure retains genuine publication', async t => {
  await t.test('relabel', async t => {
    const h = harness(t, { ackReply: payload => ({ ok: true, version: '1.0', key: payload.permit.key,
      consumedSample: { demandRevision: '99', sampleRevision: '99' }, inputEnabled: true }) }); await h.accept()
    const prepared = await h.client.prepareSample('1'); await assert.rejects(h.client.presentPrepared(prepared), /cloned publication/)
    assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '.7')
  })
  await t.test('local failure after native ACK', async t => {
    const h = harness(t); await h.accept(); const candidate = h.candidates[0]
    const prepared = await h.client.prepareSample('1')
    candidate.activateHook = enabled => { if (enabled) throw new Error('activation failed after ACK') }
    await assert.rejects(h.client.presentPrepared(prepared), /activation failed after ACK/)
    assert.equal(candidate.root.style.getPropertyValue('opacity'), '0.4')
    assert.equal(h.presenter.currentEntry.key.presentationRevision, prepared.key.presentationRevision)
    assert.equal(h.client.accepted.inputEnabled, false)
    assert.equal(h.calls.some(c => c.op === 'view.sample.abort'), false)
  })
})

test('cancelled or timed-out sample ACK settles native acceptance before releasing the retained journal', async t => {
  for (const mode of ['cancel', 'timeout']) await t.test(mode, async t => {
    const h = harness(t); await h.accept()
    const controller = new AbortController(), delayed = deferred()
    const prepared = await h.client.prepareSample('1', { signal: controller.signal })
    let nativeFinal
    h.hooks.set('view.sample.presented', ({ respond }) => {
      nativeFinal = respond()
      if (mode === 'cancel') controller.abort()
      return mode === 'cancel' ? nativeFinal : delayed.promise
    })
    h.hooks.set('view.sample.abort', ({ payload }) => {
      assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '0.4', 'settle precedes any local rollback')
      return { ...nativeFinal, key: payload.key, aborted: false, presented: true, inputEnabled: false }
    })
    if (mode === 'timeout') h.client.timeoutMs = 20
    await assert.rejects(h.client.presentPrepared(prepared), mode === 'cancel' ? /cancelled/ : /timed out/)
    delayed.resolve(nativeFinal); await tick()
    assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '0.4')
    assert.equal(h.presenter.currentEntry.key.presentationRevision, prepared.key.presentationRevision)
    assert.equal(h.client.accepted.key.presentationRevision, prepared.key.presentationRevision)
    assert.equal(h.client.accepted.inputEnabled, false)
    assert.equal((await h.client.releasePrepared(prepared)).acknowledged, true)
  })
})

test('an exact aborted settlement permits rollback, while failed or malformed settlement retains styles and blocks disposal', async t => {
  for (const mode of ['aborted', 'transport', 'wrong-key', 'wrong-sample']) await t.test(mode, async t => {
    const unknown = mode !== 'aborted', h = harness(t, { expectDisposeFailure: unknown }); await h.accept()
    const prepared = await h.client.prepareSample('1')
    h.hooks.set('view.sample.presented', () => { throw new Error('ACK delivery uncertain') })
    h.hooks.set('view.sample.abort', ({ payload }) => {
      assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '0.4')
      if (mode === 'transport') throw new Error('settlement delivery failed')
      if (mode === 'aborted') return { ok: true, version: '1.0', key: payload.key, aborted: true }
      return { ok: true, version: '1.0', key: mode === 'wrong-key' ? { ...payload.key, presentationRevision: '999' } : payload.key,
        aborted: false, presented: true, inputEnabled: false, consumedSample: { demandRevision: '999', sampleRevision: '999' } }
    })
    await assert.rejects(h.client.presentPrepared(prepared), /ACK delivery uncertain/)
    assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), unknown ? '0.4' : '.7')
    if (unknown) {
      const unresolved = h.client.active
      assert.notEqual(unresolved, null)
      await assert.rejects(h.client.prepareTemplate({}), /release the current/)
      await assert.rejects(h.client.present({}), /release the current presentation/)
      assert.equal(h.client.active, unresolved, 'legacy replacement cannot discard the unresolved journal owner')
      await assert.rejects(h.client.releasePrepared(prepared), /transaction release failed/)
      await assert.rejects(h.client.dispose(), /cleanup failed/)
      assert.equal(h.candidates[0].disposed, 0, 'unknown remote acceptance retains the actual DOM/resource owner')
      assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '0.4')
    } else {
      assert.equal(h.client.active, null)
      assert.equal((await h.client.releasePrepared(prepared)).acknowledged, false)
    }
  })
})

test('a genuine native presenter retirement can settle a previously unknown sample before disposal', async t => {
  const h = harness(t); await h.accept()
  const prepared = await h.client.prepareSample('1')
  h.hooks.set('view.sample.presented', () => { throw new Error('ACK delivery uncertain') })
  h.hooks.set('view.sample.abort', () => { throw new Error('settlement delivery failed') })
  await assert.rejects(h.client.presentPrepared(prepared))
  assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '0.4')
  const retired = h.client.retireRemotePresenter(Promise.resolve({ version: '1.0', retired: true,
    previousPresenterBinding: { sessionId: 'session' } }))
  const released = await retired
  assert.equal(released.remoteAbort, 'retired')
  assert.equal(released.acknowledged, false)
  assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '.7')
  await h.client.dispose(); assert.equal(h.candidates[0].disposed, 1)
})

test('native retirement after rejected uncertain shutdown permits a fresh actual DOM/resource drain', async t => {
  const h = harness(t); await h.accept()
  const prepared = await h.client.prepareSample('1')
  h.hooks.set('view.sample.presented', () => { throw new Error('ACK delivery uncertain') })
  h.hooks.set('view.sample.abort', () => { throw new Error('settlement delivery failed') })
  await assert.rejects(h.client.presentPrepared(prepared))
  const originalShutdown = h.client.dispose()
  await assert.rejects(originalShutdown, /cleanup failed/)
  assert.equal(h.candidates[0].disposed, 0)
  await h.client.retireRemotePresenter(Promise.resolve({ version: '1.0', retired: true,
    previousPresenterBinding: { sessionId: 'session' } }))
  await tick()
  const renewedShutdown = h.client.dispose()
  assert.notEqual(renewedShutdown, originalShutdown)
  await renewedShutdown
  await assert.rejects(originalShutdown, /cleanup failed/, 'the original failed cleanup is never rewritten as success')
  assert.equal(h.candidates[0].disposed, 1)
  assert.equal(h.presenter.currentEntry, null)
})

test('native retirement racing a successful shutdown preserves its original stable disposal barrier', async t => {
  const h = harness(t); await h.accept()
  const prepared = await h.client.prepareSample('1'), settling = deferred()
  h.hooks.set('view.sample.abort', () => settling.promise)
  let transportDisposals = 0
  h.client.transport.dispose = () => { transportDisposals++ }
  const release = h.client.releasePrepared(prepared)
  await tick()
  const shutdown = h.client.dispose()
  const retirement = h.client.retireRemotePresenter(Promise.resolve({ version: '1.0', retired: true,
    previousPresenterBinding: { sessionId: 'session' } }))
  settling.resolve({ ok: true, version: '1.0', key: prepared.key, aborted: true })
  await release; await retirement; await shutdown; await tick()
  assert.equal(h.client.dispose(), shutdown)
  assert.equal(transportDisposals, 1)
  assert.equal(h.candidates[0].disposed, 1)
})

test('a throwing input gate after genuine sample ACK cannot roll back its publication', async t => {
  const h = harness(t); await h.accept()
  const prepared = await h.client.prepareSample('1'); let nativeAccepted = false
  h.hooks.set('view.sample.presented', ({ respond }) => { nativeAccepted = true; return respond() })
  h.client.inputGate = () => { if (nativeAccepted) throw new Error('input gate failed after ACK'); return true }
  await assert.rejects(h.client.presentPrepared(prepared), /input gate failed after ACK/)
  assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '0.4')
  assert.equal(h.presenter.currentEntry.key.presentationRevision, prepared.key.presentationRevision)
  assert.equal(h.client.accepted.key.presentationRevision, prepared.key.presentationRevision)
  assert.equal(h.client.accepted.inputEnabled, false)
  assert.equal(h.calls.some(call => call.op === 'view.sample.abort'), false)
  assert.equal((await h.client.releasePrepared(prepared)).acknowledged, true)
})

test('in-flight geometry final becomes the exact sample base even after local input retirement', async t => {
  const h = harness(t); await h.accept(); const held = deferred()
  h.hooks.set('view.geometry', () => held.promise)
  const batch = { ...h.presenter.currentEntry.geometry, epoch: '97' }
  const geometry = h.client.geometry(batch); await tick()
  const preparedPromise = h.client.prepareSample('1')
  held.resolve({ ok: true }); assert.equal((await geometry).discarded, true)
  const prepared = await preparedPromise
  assert.equal(h.calls.find(c => c.op === 'view.sample.prepare').payload.baseGeometryEpoch, '97')
  await h.client.releasePrepared(prepared)
})

test('late sample prepare is exact-correlated only for abort cleanup', async t => {
  let sent, cleaned = 0
  const transport = new SseBridgeTransport({ sessionId: 'session', timeoutMs: 1000, send: envelope => { sent = envelope; return { queued: true } } })
  t.after(() => transport.dispose())
  const controller = new AbortController()
  const rejected = assert.rejects(transport.request('view.sample.prepare', {}, { signal: controller.signal, onLateResponse: () => { cleaned++ } }))
  await tick(); controller.abort(); await rejected
  const response = { ...sent, kind: 'response', payload: { ok: true, submission: { key: {} } } }
  assert.equal(transport.receive({ ...response, op: 'view.prepare' }), 0); await tick(); assert.equal(cleaned, 0)
  transport.receive(response); transport.receive(response); await tick(); assert.equal(cleaned, 1)
})


test('sample release before RAF applies no styles and stale retained identity rejects before ACK', async t => {
  await t.test('release', async t => {
    const h = harness(t); await h.accept(); const candidate = h.candidates[0], writes = candidate.root.writes.length
    const prepared = await h.client.prepareSample('1'), first = h.client.releasePrepared(prepared)
    assert.equal(h.client.releasePrepared(prepared), first); await first
    assert.equal(candidate.root.writes.length, writes)
    assert.equal(h.calls.some(c => c.op === 'view.sample.presented'), false)
  })
  await t.test('retired before mutation', async t => {
    const h = harness(t); await h.accept(); const prepared = await h.client.prepareSample('1')
    h.candidates[0].root.isConnected = false
    await assert.rejects(h.client.presentPrepared(prepared))
    assert.equal(h.calls.some(c => c.op === 'view.sample.presented'), false)
    assert.equal(h.candidates[0].root.style.getPropertyValue('opacity'), '.7')
  })
})

test('selector-query negotiation follows final sample confirmation on the new presentation key', async t => {
  const h = harness(t); h.client.queryScope = 'presentation'
  h.hooks.set('view.query.enable', ({ payload }) => ({ ok: true, version: '1.0', scope: 'presentation', key: payload.key, enabled: true }))
  await h.accept(); assert.equal(h.client.queryEnabled, true)
  const prepared = await h.client.prepareSample('1'); assert.equal(h.client.queryEnabled, false)
  await h.client.presentPrepared(prepared)
  assert.equal(h.client.queryEnabled, true)
  const enables = h.calls.filter(c => c.op === 'view.query.enable')
  assert.equal(enables.length, 2); assert.deepEqual(enables[1].payload.key, prepared.key)
  await h.client.releasePrepared(prepared)
})


test('hidden new child inherits a retained sampled parent before its first numeric baseline is read', async t => {
  const presenter = new DomViewPresenter({ ownerDocument: {}, append() {} })
  t.after(() => presenter.dispose())
  const document = {}, parent = element(document, { opacity: '1' }), child = element(document, { opacity: 'inherit' })
  const nodes = new Map([['parent', parent], ['child', child]])
  const phases = []
  const candidate = {
    connected: true, supports: () => true, validateSelector() {},
    async populate(plan) { candidate.plan = plan }, snapshot() { return new Map() }, restore() { phases.push('restore') },
    isConnected() { return candidate.connected }, setVisible(value) { candidate.visible = value }, setInteractive() {},
    animationBaselines(descriptors) {
      assert.notEqual(candidate.visible, true)
      assert.equal(parent.style.getPropertyValue('opacity'), '0.5')
      assert.equal(child.style.getPropertyValue('opacity'), 'inherit')
      phases.push('baseline')
      return descriptors.map(descriptor => computedAnimationBaseline(descriptor, {
        fontSize: '16px', opacity: parent.style.getPropertyValue('opacity')
      }))
    },
    stageAnimation(styles, isCurrent) {
      phases.push('stage:' + styles.map(item => item.occurrenceId + ':' + item.opacity).join(','))
      return stageAnimationStyles(styles, { document, elementFor: id => nodes.get(id), isCurrent })
    },
    measure() { phases.push('measure'); return [...nodes].map(([id, node]) => ({ occurrenceId: id,
      x: Number(node.style.getPropertyValue('opacity')), y: 0, width: 20, height: 20,
      scrollTop: 0, scrollHeight: 20, clientHeight: 20 })) },
    dispose() { candidate.connected = false; return candidate.plan?.dispose() ?? [] },
  }
  presenter.createCandidate = async () => candidate
  const view = { version: '1.0', sessionId: 'session', pageId: 1, revision: 1, routePath: 'pages/home', profile: 'webview',
    nodes: [{ kind: 'element', occurrenceId: 'parent', tag: 'view', attrs: {}, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' }, events: [],
      children: [{ kind: 'element', occurrenceId: 'child', tag: 'view', attrs: {}, typedAttrs: {}, ownership: { documentId: 'pages/home.wxml' }, events: [], children: [] }] }],
    styleRoots: [], styles: [], resources: [] }
  const key = { sessionId: 'session', pageId: '1', documentRevision: '1', presentationRevision: '1', surfaceGeneration: '1', profile: 'webview' }
  const prepared = await presenter.prepare(view, { viewport: { width: 100, height: 50 }, presentationKey: key,
    animation: { version: '1.0', requestId: 'inherit-baseline',
      baselines: [{ occurrenceId: 'parent', opacity: false, transform: false }, { occurrenceId: 'child', opacity: true, transform: false }],
      styles: [style('parent', { opacity: .5 }), style('child', { opacity: null })] },
    bindAnimation: baseline => {
      assert.equal(baseline.values[1].opacity, .5)
      return { version: '1.0', requestId: baseline.requestId, key, styles: [style('parent', { opacity: .5 }), style('child', { opacity: .5 })] }
    } })
  assert.deepEqual(phases, ['restore', 'stage:parent:0.5,child:null', 'baseline', 'stage:parent:0.5,child:0.5', 'measure'])
  assert.equal(prepared.preparation.nodes.find(item => item.occurrenceId === 'child').borderBox.x, .5)
  assert.equal(parent.style.getPropertyValue('opacity'), '0.5')
  assert.equal(child.style.getPropertyValue('opacity'), '0.5')
  await presenter.abort(prepared)
})
