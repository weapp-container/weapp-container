/** Source/serialization contracts only; no browser, compiler, Worker or server. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { armButtonFocusProbe, assertHeldButtonSpaceAudit, assertReleasedButtonSpaceAudit, assertRetiredButtonSurface, buttonDomCheckpoint, buttonSmokeFiles, buttonSmokeWxml, buttonStyleObservation, installButtonNativeAudit, readButtonSmokeState } from './browser-dev-button-fixture.mjs'
import { installDomSurfaceProbe, INTERACTIVE_DOM_SURFACE_SELECTOR } from './browser-dev-dom-surface.mjs'
import { installWorkerAudit, parseArgs, serverArguments, smokeFixture } from './browser-dev-loop-smoke.mjs'
const input = ['--server-bin', '/smoke/bin/server', '--producer-dir', '/smoke/producer', '--pins', '/smoke/pins.json',
  '--node-bin', '/smoke/bin/node', '--out-dir', '/smoke/evidence']
const plain = value => JSON.parse(JSON.stringify(value))

test('button browser fixture is explicit, CLI/WebView-only and keeps old default project bytes', () => {
  assert.equal(parseArgs(input).fixture, 'reference')
  for (const args of [['--fixture', 'button'], ['--server-kind', 'cli', '--renderer', 'skia', '--fixture', 'button'],
    ['--server-kind', 'cli', '--fixture', 'unknown'], ['--server-kind', 'cli', '--fixture', 'button', '--fixture', 'button']])
    assert.throws(() => parseArgs([...input, ...args]))
  const options = parseArgs([...input, '--server-kind', 'cli', '--fixture', 'button'])
  assert.equal(options.fixture, 'button'); assert.equal(options.renderer, 'webview')
  const args = serverArguments(options, '/smoke/project')
  assert.equal(args[0], 'dev'); assert.equal(args[args.indexOf('--renderer') + 1], 'webview')
  assert.deepEqual(smokeFixture('cli').files, smokeFixture('cli', 'webview', false, false, 'reference').files)
  assert.match(smokeFixture('cli').files['pages/home/index.wxml'], /<view id="increment"/)
  assert.equal(smokeFixture('cli').buttonStateQuery, undefined)
})

test('button fixture preserves real CLI route/data overrides and declares all observed controls', () => {
  const fixture = smokeFixture('cli', 'webview', false, false, 'button'), source = fixture.files['pages/home/index.wxml']
  assert.deepEqual(fixture.data, { count: 7, marker: 'cli-startup-data-observed' })
  assert.notEqual(JSON.parse(fixture.files['app.json']).pages[0], fixture.route)
  assert.match(source, /<button id="increment"[^>]*catchtap="increment"><text id="increment-child" data-value="\{\{17\}\}"/)
  for (const id of ['disabled-child', 'loading', 'disable-touch-child', 'arm-space', 'space-button', 'source-omitted']) assert.ok(source.includes(`id="${id}"`))
  assert.deepEqual(fixture.buttonStateQuery, { moduleId: 'module:browser-dev-button-state.js', export: 'browserDevButtonState', args: [] })
  assert.ok('public/browser-dev-button-state.js' in fixture.files)
  assert.equal(buttonSmokeWxml('B').replace('Build B', 'Build A'), buttonSmokeWxml('A'))
  for (const build of ['<script>', '../B', 'B17']) assert.throws(() => buttonSmokeWxml(build))
})

test('declared fixture handlers own mutations, bounded logs and rebuild timer; getter remains read-only', () => {
  const files = buttonSmokeFiles(), timers = [], exports = {}; let page
  runInNewContext(files['pages/home/index.js'], { Page: value => { page = value }, setTimeout: (callback, delay) => timers.push({ callback, delay }) })
  page.route = 'pages/home/index'; page.setData = patch => Object.assign(page.data, patch)
  const event = { type: 'tap', target: { id: 'increment-child', dataset: { value: 17 } }, currentTarget: { id: 'increment' } }
  page.increment(event); assert.equal(page.data.count, 1)
  page.disableOnTouch({ ...event, type: 'touchstart' }); assert.equal(page.data.touchDisabled, true)
  page.armSpaceRebuild(event); assert.equal(page.data.spaceRevision, 0); assert.equal(timers.length, 1); assert.equal(timers[0].delay, 1500)
  timers[0].callback(); assert.equal(page.data.spaceRevision, 1)
  runInNewContext(files['public/browser-dev-button-state.js'], { exports, getCurrentPages: () => [page] })
  const before = JSON.stringify(page), state = exports.browserDevButtonState()
  assert.equal(state.fixture, 'browser-dev-button-v1'); assert.equal(state.count, 1); assert.equal(JSON.stringify(page), before)
  page.__buttonEvents = Array(256).fill({}); assert.throws(() => page.captureTap(event), /budget/)
})

test('serialized button reads await original owner bridge and never mistake an unresolved mismatch for state', async () => {
  const calls = [], state = { fixture: 'browser-dev-button-v1', count: 3, events: [] }
  const query = { moduleId: 'module:browser-dev-button-state.js', export: 'browserDevButtonState', args: [] }
  const window = { weappContainerDev: { status: { manager: { executing: { ownerKey: 'actual-owner' } } }, request: async value => {
    calls.push(value); await Promise.resolve(); return { result: { ok: true, result: [state] } }
  } } }
  const execute = value => runInNewContext(`(${readButtonSmokeState.toString()})(value)`, { window, value })
  assert.equal(await execute({ query, expected: { count: 4 } }), null)
  assert.deepEqual(plain(await execute({ query, expected: { count: 3 } })), state)
  assert.equal(calls.length, 2); for (const call of calls) assert.deepEqual(plain(call), { ownerKey: 'actual-owner', op: 'module.call', payload: query })
})

test('serialized button state query rejects stale/malformed finals and oversized event observations', async () => {
  for (const response of [{ stale: true }, { result: { ok: false } }, { result: { ok: true, result: [] } },
    { result: { ok: true, result: [{ fixture: 'fake', events: [] }] } },
    { result: { ok: true, result: [{ fixture: 'browser-dev-button-v1', events: Array(257).fill({}) }] } }]) {
    const window = { weappContainerDev: { status: { manager: { executing: { ownerKey: 'owner' } } }, request: async () => response } }
    await assert.rejects(runInNewContext(`(${readButtonSmokeState.toString()})({query:{}})`, { window }), /failed|invalid/)
  }
})

test('native audit installs parent load-capture listeners without enabling sandbox scripts or synthesizing input', () => {
  const callbacks = new Map(), nativeCallbacks = new Map(), child = {}, window = {}; window.top = window
  const document = { contains: () => false, addEventListener: (type, callback, capture) => { assert.equal(capture, true); callbacks.set(type, callback) } }
  runInNewContext(`(${installButtonNativeAudit.toString()})()`, { window, document, performance: { timeOrigin: 10, now: () => 2 } })
  assert.deepEqual([...callbacks.keys()], ['load'])
  callbacks.get('load')({ target: { tagName: 'IFRAME', title: 'Weapp Container DOM surface', contentWindow: child,
    contentDocument: { addEventListener: (type, callback) => nativeCallbacks.set(type, callback) } } })
  assert.equal(child.__buttonNativeAuditInstalled, true)
  window.__buttonNativeAudit.probe = { name: 'probe', frame: { isConnected: false }, element: { isConnected: false } }
  nativeCallbacks.get('focusin')({ target: { id: 'space-button' }, isTrusted: true })
  assert.deepEqual(plain(window.__buttonNativeAudit.events[0]), { sequence: 1, type: 'focusin', targetId: 'space-button', key: null,
    trusted: true, at: 12, frameAudit: true, probe: 'probe', repeat: false, sourceFrameIsProbeFrame: false, sourceDocumentIsProbeDocument: false, targetIsProbeElement: false, ownerMatchesProbe: false, primaryInputAtEvent: false, oldFrameConnected: false, oldElementConnected: false, oldFrameOwnerIsTopDocument: false, oldFrameContainedByTopDocument: false, oldFrameInert: null, oldFramePointerEvents: null, oldElementOwnerIsProbeDocument: false, oldElementRootIsProbeDocument: false, oldDocumentHasFocus: null })
  for (let i = 0; i < 512; i++) nativeCallbacks.get('click')({ target: { id: 'x' }, isTrusted: true })
  assert.equal(window.__buttonNativeAudit.events.length, 512); assert.equal(window.__buttonNativeAudit.dropped, 1)
})

const key = { sessionId: 'session', pageId: '1', documentRevision: '3', presentationRevision: '4', surfaceGeneration: '0', profile: 'webview' }
function domHarness() {
  const owner = { workerEpoch: 'epoch', sessionId: 'session', packSha256: 'pack', transportBackend: 'browser-view' }
  const current = { owner, inputEnabled: true }, frame = { inert: false, isConnected: true, style: { pointerEvents: 'auto', visibility: 'visible' }, contentDocument: {}, contentWindow: {} }
  const frames = [frame], final = { key, inputEnabled: true, messageIndex: 0, requestId: 'present-final' }
  const consumedInput = { pageId: key.pageId, routePath: 'pages/home/index', templateRevision: '2', viewport: { x: 0, y: 0, width: 375, height: 667 } }
  const traces = [{ direction: 'receive', workerEpoch: owner.workerEpoch, sessionId: owner.sessionId,
    domPreparations: [{ requestId: 'prepare-final', messageIndex: 0, key, scheduling: { version: '1.0', key, consumedInput } }] },
    { direction: 'receive', workerEpoch: owner.workerEpoch, sessionId: owner.sessionId, domPresentations: [final],
      runtimeState: { currentPage: { pageId: key.pageId, path: consumedInput.routePath }, lifecycle: 'Active', rendererProfile: 'webview',
        surfaceGeneration: key.surfaceGeneration, templateRevision: consumedInput.templateRevision, viewport: consumedInput.viewport } }]
  const history = [{ kind: 'accepted-proof', value: { proof: { owner, publication: { kind: 'browser-view', key } } } }]
  const window = { weappContainerDev: { status: { manager: { executing: current, history } } }, __browserDevSmokeAudit: { read: () => ({ traces }) } }
  window.top = window
  const document = { querySelectorAll: selector => selector === INTERACTIVE_DOM_SURFACE_SELECTOR ? frames.filter(value => !value.inert) : frames }
  frame.ownerDocument = document
  runInNewContext(`(${installDomSurfaceProbe.toString()})()`, { window, document })
  return { owner, current, frame, frames, final, traces, history, window, document }
}

test('DOM checkpoint delegates to the exact current observed native-final surface boundary', () => {
  const h = domHarness(), execute = () => plain(runInNewContext(`(${buttonDomCheckpoint.toString()})()`, h))
  assert.deepEqual(execute(), { owner: h.owner, inputEnabled: true, key })
  h.frames.push({ inert: true }); assert.equal(execute().inputEnabled, true, 'An inert candidate cannot replace the accepted input surface')
  h.frames.push({ inert: false }); assert.throws(execute, /Multiple interactive/); h.frames.pop()
  h.frame.inert = true; assert.equal(execute().inputEnabled, false); h.frame.inert = false
  h.traces.push({ direction: 'receive', workerEpoch: 'epoch', sessionId: 'session', domPresentations: [{ key: { ...key, presentationRevision: '2' }, inputEnabled: false }] })
  assert.equal(execute().inputEnabled, true, 'Late older final cannot mask the genuinely newer original final')
  h.final.key = { ...key, sessionId: 'wrong' }; assert.equal(execute().inputEnabled, false)
})

test('Worker audit retains DOM final metadata only, never Page or arbitrary bridge payloads', () => {
  const callbacks = new Map()
  class Worker { addEventListener(type, callback) { callbacks.set(type, callback) } postMessage() {} terminate() {} }
  const context = { Worker, performance: { now: () => 1 }, structuredClone }; context.top = context; context.globalThis = context
  runInNewContext(`(${installWorkerAudit.toString()})()`, context)
  const worker = new context.Worker('/runtime-worker.mjs', { name: 'owned' })
  worker.postMessage({ kind: 'request', op: 'bridge', payload: { envelope: { op: 'module.call', payload: { privateData: 'not-retained' } } } })
  callbacks.get('message')({ data: { kind: 'response', op: 'bridge', workerEpoch: 'epoch', sessionId: 'session', payload: { result: { messages: [
    { kind: 'response', op: 'view.presented', requestId: 'inner', payload: { ok: true, key, inputEnabled: true, privateData: 'not-retained' } },
    { kind: 'response', op: 'module.call', payload: { ok: true, result: ['not-retained'] } }
  ] } } } })
  const audit = context.__browserDevSmokeAudit.read()
  assert.deepEqual(plain(audit.traces[1].domPresentations), [{ requestId: 'inner', messageIndex: 0, inputEnabled: true, key }])
  assert.equal(JSON.stringify(audit).includes('not-retained'), false)
})

test('serialized style observation reads native computed styles, source omission and loading state', () => {
  const button = { tagName: 'BUTTON', type: 'button' }, omitted = { hasAttribute: () => false }, loading = { disabled: false, getAttribute: () => 'true' }
  const styles = new Map([[button, { color: 'author', backgroundColor: 'background', fontSize: '19px', borderTopWidth: '7px' }], [omitted, { borderTopWidth: '2px' }]])
  const doc = { querySelector: selector => ({ '#increment': button, '#source-omitted': omitted, '#loading': loading })[selector] }
  const document = { querySelector: () => ({ contentDocument: doc, contentWindow: { getComputedStyle: element => styles.get(element) } }) }
  assert.deepEqual(plain(runInNewContext(`(${buttonStyleObservation.toString()})()`, { window: { __browserDevDomSurface: { current: () => ({ frame: document.querySelector() }) } }, document })), { tag: 'BUTTON', nativeType: 'button',
    color: 'author', background: 'background', fontSize: '19px', sourceBorder: '7px', omittedSource: false, omittedBorder: '2px', loadingDisabled: false, loadingBusy: 'true' })
})


test('held Space probe arms only the exact currently interactive owner/final and focused native element', () => {
  const h = domHarness(), element = { id: 'space-button' }, doc = h.frame.contentDocument
  doc.querySelector = () => element; doc.activeElement = element; h.frame.contentWindow.__buttonNativeAuditInstalled = true
  const checkpoint = { owner: h.owner, inputEnabled: true, key }, audit = { sequence: 12, events: [] }
  h.window.__buttonNativeAudit = audit
  const value = { name: 'held', selector: '#space-button', checkpoint }
  const execute = () => runInNewContext(`(${armButtonFocusProbe.toString()})(value)`, { ...h, value })
  assert.deepEqual(plain(execute()), { name: 'held', targetId: 'space-button', owner: h.owner, key, startSequence: 12 })
  assert.equal(audit.probe.frame, h.frame); assert.equal(audit.probe.document, doc); assert.equal(audit.probe.element, element)
  h.current.inputEnabled = false; assert.throws(execute, /interactive/); h.current.inputEnabled = true
  checkpoint.inputEnabled = false; assert.throws(execute, /interactive/); checkpoint.inputEnabled = true
  h.frame.inert = true; assert.throws(execute, /interactive/); h.frame.inert = false
  h.final.key = { ...key, presentationRevision: '9' }; assert.throws(execute, /interactive/); h.final.key = key
  h.frames.push({ inert: false }); assert.throws(execute, /Multiple interactive/); h.frames.pop()
  doc.activeElement = {}; assert.throws(execute, /unfocused/)
})

const retired = { oldFrameConnected: false, oldFrameOwnerIsTopDocument: true, oldFrameContainedByTopDocument: false,
  oldFrameInert: true, oldFramePointerEvents: 'none', oldElementConnected: true, oldElementOwnerIsProbeDocument: true,
  oldElementRootIsProbeDocument: true, oldDocumentHasFocus: false }

test('held Space proof requires this probe exact old-frame keydown before unique new-frame focus', () => {
  const probe = { name: 'held', targetId: 'space-button', startSequence: 10 }
  const down = { sequence: 11, type: 'keydown', key: ' ', targetId: 'space-button', probe: 'held', trusted: true, repeat: false,
    sourceFrameIsProbeFrame: true, sourceDocumentIsProbeDocument: true, targetIsProbeElement: true, oldFrameConnected: true,
    oldElementConnected: true, ownerMatchesProbe: true, primaryInputAtEvent: true, oldFrameOwnerIsTopDocument: true,
    oldFrameContainedByTopDocument: true, oldFrameInert: false, oldFramePointerEvents: 'auto', oldElementOwnerIsProbeDocument: true,
    oldElementRootIsProbeDocument: true, oldDocumentHasFocus: true }
  const focus = { sequence: 12, type: 'focusin', targetId: 'space-button', probe: 'held', trusted: true, ownerMatchesProbe: true,
    sourceFrameIsProbeFrame: false, sourceDocumentIsProbeDocument: false, targetIsProbeElement: false, ...retired }
  const earlier = { ...down, probe: 'earlier-ordinary-space', sequence: 1 }
  const audit = () => ({ dropped: 0, events: [{ ...earlier }, { ...down }, { ...focus }] })
  assert.deepEqual(assertHeldButtonSpaceAudit(audit(), probe), { keydown: down, restoredFocus: focus })
  const invalid = []
  let value = audit(); value.events.splice(1, 1); invalid.push(value)
  value = audit(); value.events[1].probe = 'other'; invalid.push(value)
  value = audit(); value.events[1].sequence = 10; invalid.push(value)
  value = audit(); value.events[1].targetId = 'other'; invalid.push(value)
  value = audit(); value.events[1].repeat = true; invalid.push(value)
  for (const field of ['trusted', 'sourceFrameIsProbeFrame', 'sourceDocumentIsProbeDocument', 'targetIsProbeElement', 'oldFrameConnected', 'oldElementConnected', 'ownerMatchesProbe', 'primaryInputAtEvent']) {
    value = audit(); value.events[1][field] = false; invalid.push(value)
  }
  for (const field of ['sourceFrameIsProbeFrame', 'sourceDocumentIsProbeDocument', 'targetIsProbeElement', 'oldFrameConnected', 'oldFrameContainedByTopDocument', 'oldDocumentHasFocus']) {
    value = audit(); value.events[2][field] = true; invalid.push(value)
  }
  value = audit(); value.events[2].sequence = 10; invalid.push(value)
  value = audit(); value.events.push({ ...focus, sequence: 13 }); invalid.push(value)
  value = audit(); value.events[2].ownerMatchesProbe = false; invalid.push(value)
  value = audit(); value.dropped = 1; invalid.push(value)
  for (const observation of invalid) assert.throws(() => assertHeldButtonSpaceAudit(observation, probe))
})

test('retired owning-frame proof preserves raw retained-Document connectivity without treating it as active input', () => {
  assert.doesNotThrow(() => assertRetiredButtonSurface(retired))
  assert.doesNotThrow(() => assertRetiredButtonSurface({ ...retired, oldElementConnected: false, oldElementRootIsProbeDocument: false }))
  for (const field of ['oldFrameConnected', 'oldFrameContainedByTopDocument', 'oldDocumentHasFocus'])
    assert.throws(() => assertRetiredButtonSurface({ ...retired, [field]: true }))
  for (const field of ['oldFrameOwnerIsTopDocument', 'oldFrameInert', 'oldElementOwnerIsProbeDocument'])
    assert.throws(() => assertRetiredButtonSurface({ ...retired, [field]: false }))
  assert.throws(() => assertRetiredButtonSurface({ ...retired, oldFramePointerEvents: 'auto' }))
  assert.throws(() => assertRetiredButtonSurface({ ...retired, oldElementConnected: false }))
})

test('held Space terminal requires genuine new-frame keyup after retirement and rejects replay or missing provenance', () => {
  const probe = { name: 'held', targetId: 'space-button', startSequence: 10 }
  const down = { sequence: 11, type: 'keydown', key: ' ', targetId: probe.targetId, probe: probe.name, trusted: true, repeat: false,
    sourceFrameIsProbeFrame: true, sourceDocumentIsProbeDocument: true, targetIsProbeElement: true, ownerMatchesProbe: true, primaryInputAtEvent: true,
    ...retired, oldFrameConnected: true, oldElementConnected: true, oldFrameContainedByTopDocument: true,
    oldFrameInert: false, oldFramePointerEvents: 'auto', oldDocumentHasFocus: true }
  const focus = { sequence: 12, type: 'focusin', targetId: probe.targetId, probe: probe.name, trusted: true, ownerMatchesProbe: true,
    sourceFrameIsProbeFrame: false, sourceDocumentIsProbeDocument: false, targetIsProbeElement: false, ...retired }
  const up = { ...focus, sequence: 13, type: 'keyup', key: ' ', primaryInputAtEvent: true }
  const audit = () => ({ dropped: 0, events: [{ ...down }, { ...focus }, { ...up }] })
  assert.deepEqual(assertReleasedButtonSpaceAudit(audit(), probe).keyup, up)
  for (const field of ['trusted', 'ownerMatchesProbe', 'primaryInputAtEvent', 'oldElementOwnerIsProbeDocument']) {
    const value = audit(); value.events[2][field] = false; assert.throws(() => assertReleasedButtonSpaceAudit(value, probe))
  }
  for (const field of ['sourceFrameIsProbeFrame', 'sourceDocumentIsProbeDocument', 'targetIsProbeElement', 'oldFrameConnected', 'oldDocumentHasFocus']) {
    const value = audit(); value.events[2][field] = true; assert.throws(() => assertReleasedButtonSpaceAudit(value, probe))
  }
  let value = audit(); value.events.pop(); assert.throws(() => assertReleasedButtonSpaceAudit(value, probe))
  value = audit(); value.events[2].sequence = 12; assert.throws(() => assertReleasedButtonSpaceAudit(value, probe))
  value = audit(); value.events.push({ ...up, sequence: 14 }); assert.throws(() => assertReleasedButtonSpaceAudit(value, probe))
  value = audit(); value.events.push({ ...up, sequence: 14, type: 'click' }); assert.throws(() => assertReleasedButtonSpaceAudit(value, probe))
})
