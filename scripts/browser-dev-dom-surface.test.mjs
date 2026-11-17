/** VM boundary tests, not real browser or renderer evidence. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { INTERACTIVE_DOM_SURFACE_SELECTOR, installDomSurfaceProbe } from './browser-dev-dom-surface.mjs'

function fixture() {
  const owner = { workerEpoch: 'epoch', sessionId: 'session', packSha256: 'a'.repeat(64), transportBackend: 'browser-view' }
  const key = { sessionId: owner.sessionId, pageId: '1', documentRevision: '2', presentationRevision: '3', surfaceGeneration: '0', profile: 'webview' }
  const frames = [], selectors = [], executing = { owner, inputEnabled: true }
  const consumedInput = { pageId: key.pageId, routePath: 'pages/home/index', templateRevision: '2', viewport: { x: 0, y: 0, width: 375, height: 667 } }
  const prepared = { requestId: 'prepare', messageIndex: 0, key, scheduling: { version: '1.0', key, consumedInput } }
  const final = { requestId: 'presented', messageIndex: 0, key, inputEnabled: true }
  const latest = { currentPage: { pageId: key.pageId, path: consumedInput.routePath }, lifecycle: 'Active', rendererProfile: 'webview',
    surfaceGeneration: key.surfaceGeneration, templateRevision: consumedInput.templateRevision, viewport: consumedInput.viewport }
  const history = [{ kind: 'accepted-proof', value: { proof: { owner, publication: { kind: 'browser-view', key: { ...key, documentRevision: '1', presentationRevision: '1' } } } } }]
  const traces = [{ direction: 'receive', workerEpoch: owner.workerEpoch, sessionId: owner.sessionId, domPreparations: [prepared] },
    { direction: 'receive', workerEpoch: owner.workerEpoch, sessionId: owner.sessionId, domPresentations: [final], runtimeState: latest }]
  const window = { weappContainerDev: { status: { manager: { executing, history } } }, __browserDevSmokeAudit: { read: () => ({ traces }) } }
  window.top = window
  const document = { querySelectorAll(selector) { selectors.push(selector); return selector === INTERACTIVE_DOM_SURFACE_SELECTOR ? frames.filter(frame => !frame.inert) : frames } }
  const frame = () => ({ ownerDocument: document, isConnected: true, inert: false, contentDocument: {}, contentWindow: {}, style: { pointerEvents: 'auto', visibility: 'visible' } })
  runInNewContext(`(${installDomSurfaceProbe.toString()})()`, { window, document })
  return { owner, key, prepared, consumedInput, final, latest, traces, history, executing, frames, selectors, document, window, frame, read: options => window.__browserDevDomSurface.current(options) }
}

test('semantic current surface ignores inert candidates and retiring predecessors while retaining inventory', () => {
  const h = fixture(), old = h.frame(), current = h.frame(), pending = h.frame()
  old.inert = true; pending.inert = true
  h.frames.push(old, current, pending)
  const result = h.read()
  assert.equal(result.frame, current); assert.equal(result.allFrameCount, 3)
  assert.equal(result.key, h.key); assert.equal(result.observation.kind, 'observed-dom-final'); assert.equal(result.observation.value.consumedInput, h.consumedInput)
  assert.equal(h.window.__browserDevDomSurface.selector, INTERACTIVE_DOM_SURFACE_SELECTOR)
  assert.ok(h.selectors.includes(INTERACTIVE_DOM_SURFACE_SELECTOR))
})

test('zero interactive surfaces is a pending observation but two interactive surfaces fail closed', () => {
  const h = fixture()
  assert.equal(h.read(), null)
  const old = h.frame(), pending = h.frame(); old.inert = true; pending.inert = true; h.frames.push(old, pending)
  assert.equal(h.read(), null)
  old.inert = false; pending.inert = false
  assert.throws(() => h.read(), /Multiple interactive DOM surfaces/)
  h.executing.inputEnabled = false
  assert.throws(() => h.read(), /Multiple interactive DOM surfaces/, 'An inactive status cannot conceal a duplicate interactive surface')
})

test('an interactive iframe needs the latest original prepare then enabled native final, not startup history', () => {
  const h = fixture(); h.frames.push(h.frame())
  assert.ok(h.read(), 'The actual newer final must not stay bound to the one-time startup history key')
  h.history.length = 0; assert.ok(h.read(), 'Current native evidence does not depend on startup history')
  const prep = h.traces[0].domPreparations; h.traces[0].domPreparations = []; assert.equal(h.read(), null)
  h.traces[0].domPreparations = prep; assert.ok(h.read())
  h.final.inputEnabled = false; assert.equal(h.read(), null); h.final.inputEnabled = true
  h.final.key = { ...h.key, presentationRevision: '4' }; assert.equal(h.read(), null, 'An unprepared new final cannot authorize a sample')
  h.final.key = h.key; h.prepared.scheduling.key = { ...h.key, surfaceGeneration: '1' }; assert.equal(h.read(), null)
})

test('late disabled finals, pending new template, generation mismatch and ACK before preparation never authorize sampling', () => {
  const mutations = [h => { h.traces.push({ direction: 'receive', workerEpoch: h.owner.workerEpoch, sessionId: h.owner.sessionId,
    domPresentations: [{ ...h.final, key: { ...h.key, presentationRevision: '4' }, inputEnabled: false }] }) },
    h => { h.latest.templateRevision = '3' }, h => { h.latest.surfaceGeneration = '1' },
    h => { h.latest.currentPage.pageId = '99' }, h => { h.latest.viewport = { ...h.latest.viewport, width: 400 } },
    h => { h.traces.reverse() }, h => { h.traces[0].domPreparations = []; h.traces[1].domPreparations = [{ ...h.prepared, messageIndex: 1 }] }]
  for (const mutate of mutations) { const h = fixture(); h.frames.push(h.frame()); mutate(h); assert.equal(h.read(), null) }
})

test('owner and exact key bind the sample; stale-owner and older finals cannot override it', () => {
  const h = fixture(); h.frames.push(h.frame())
  h.traces.push({ direction: 'receive', workerEpoch: 'retired', sessionId: h.owner.sessionId, domPresentations: [{ key: { ...h.key, presentationRevision: '999' }, inputEnabled: true }] })
  h.traces.push({ direction: 'receive', workerEpoch: h.owner.workerEpoch, sessionId: h.owner.sessionId, domPresentations: [{ key: { ...h.key, presentationRevision: '1' }, inputEnabled: false }] })
  assert.ok(h.read({ owner: h.owner, key: h.key }))
  for (const field of ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend'])
    assert.equal(h.read({ owner: { ...h.owner, [field]: 'other' } }), null)
  for (const field of ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'])
    assert.equal(h.read({ key: { ...h.key, [field]: 'other' } }), null)
  h.history.push({ kind: 'accepted-proof', value: { proof: { owner: { ...h.owner, workerEpoch: 'retired' } } } })
  assert.ok(h.read(), 'A stale owner proof cannot replace the current owner proof')
})

test('actual owning frame connection, visibility, input styles and Document identity all remain required', () => {
  for (const mutate of [h => { h.frames[0].isConnected = false }, h => { h.frames[0].ownerDocument = {} },
    h => { h.frames[0].style.visibility = 'hidden' }, h => { h.frames[0].style.pointerEvents = 'none' },
    h => { h.frames[0].contentDocument = null }, h => { h.frames[0].contentWindow = null },
    h => { h.executing.inputEnabled = false }, h => { h.owner.transportBackend = 'external-frame' }]) {
    const h = fixture(); h.frames.push(h.frame()); mutate(h); assert.equal(h.read(), null)
  }
})

test('malformed or unbounded native presentation keys do not create current input authority', () => {
  for (const value of ['-1', '01', '1.5', '18446744073709551616', '9'.repeat(100)]) {
    const h = fixture(); h.frames.push(h.frame()); h.final.key = { ...h.key, presentationRevision: value }; assert.equal(h.read(), null)
  }
})

test('incomplete observation cannot be upgraded into a current DOM sample', () => {
  const h = fixture(); h.frames.push(h.frame())
  const read = h.window.__browserDevSmokeAudit.read
  h.window.__browserDevSmokeAudit.read = () => ({ ...read(), droppedTraces: 1 })
  assert.throws(() => h.read(), /incomplete/)
})

test('same revision conflicts fail closed while an identical native replay stays observational', () => {
  const h = fixture(); h.frames.push(h.frame())
  const replay = { ...h.final }
  h.traces.push({ direction: 'receive', workerEpoch: h.owner.workerEpoch, sessionId: h.owner.sessionId, domPresentations: [replay] })
  assert.ok(h.read())
  replay.inputEnabled = false; assert.throws(() => h.read(), /Conflicting native DOM finals/)
  replay.inputEnabled = true; replay.key = { ...h.key, documentRevision: '99' }; assert.throws(() => h.read(), /Conflicting native DOM finals/)
})
