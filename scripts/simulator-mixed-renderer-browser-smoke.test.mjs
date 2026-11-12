import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { buildManifest } from '../tools/container-manifest/src/index.mjs'
import { createMixedRendererFixture, installMixedSmokeObserver, parseOptions, readMixedInputState, runMixedRendererDevSmoke } from './simulator-mixed-renderer-browser-smoke.mjs'

test('mixed smoke observer preserves EventSource dispatch while bounding final-response evidence', () => {
  class Source {
    constructor(url) { this.url = url; this.listeners = new Map() }
    addEventListener(type, callback) { const callbacks = this.listeners.get(type) || []; callbacks.push(callback); this.listeners.set(type, callbacks) }
    emit(type, data) { for (const callback of this.listeners.get(type) || []) callback({ data }) }
  }
  const context = vm.createContext({ EventSource: Source, Date, devicePixelRatio: 2,
    document: { hasFocus: () => false, hidden: false, activeElement: { tagName: 'IFRAME', id: 'retiring-dom' } } })
  vm.runInContext(`(${installMixedSmokeObserver})()`, context)
  const source = vm.runInContext('new EventSource("/api/events")', context)
  let observed = 0
  source.addEventListener('bridge', () => observed++)
  for (let index = 0; index < 513; index++) source.emit('bridge', JSON.stringify({ messages: [{ requestId: String(index), kind: 'response', payload: { ok: true } }] }))
  assert.equal(source instanceof Source, true); assert.equal(source.url, '/api/events')
  assert.equal(observed, 513)
  assert.equal(context.__mixedSmokeEvents.events.length, 512)
  assert.equal(context.__mixedSmokeEvents.dropped, 1)
  assert.equal(context.__mixedSmokeEvents.events.at(-1).payload.messages[0].requestId, '512')
  const observation = context.__mixedSmokeEvents.events.at(-1)
  assert.equal(observation.hasFocus, false); assert.equal(observation.hidden, false); assert.equal(observation.dpr, 2)
  assert.equal(observation.activeElement.tagName, 'IFRAME'); assert.equal(observation.activeElement.id, 'retiring-dom')
  source.emit('error', undefined)
  assert.equal(context.__mixedSmokeEvents.counts.error, undefined, 'native transport errors have no fabricated JSON evidence')
  source.emit('bridge', 'x'.repeat(131073))
  assert.equal(context.__mixedSmokeEvents.events.at(-1).payload.truncated, true)
})

test('mixed UI diagnostics capture focus, deferred density and exact frame identity without modifying them', () => {
  const context = vm.createContext({ state: { webRenderer: 'canvaskit', sessionId: 'session', currentPageId: '2', route: 'pages/skia/index' },
    rendererInputReady: () => true, inputSuspended: false, pendingPresentation: null, rendererBlocked: false, surfaceInput: {},
    rasterBridgeTransport: { connected: true }, pointerSequence: 3, autoPresentationWanted: false, activePreview: () => false,
    document: { hasFocus: () => false, hidden: false, activeElement: { tagName: 'BODY', id: '' }, querySelector: () => ({ textContent: '' }) },
    observedDensity: 2, devicePixelRatio: 2, confirmedRendererIdentity: '["session",1,1]',
    lastFrame: { sessionId: 'session', frameId: 1, renderRevision: 1, configGeneration: 1 },
    presentation: { generation: 1, renderScale: 'auto', effectiveScale: 1 } })
  const value = vm.runInContext(`(${readMixedInputState})()`, context)
  assert.equal(value.ready, true); assert.equal(value.autoPresentationWanted, false)
  assert.equal(value.activePreview, false); assert.equal(value.hasFocus, false); assert.equal(value.hidden, false)
  assert.equal(value.activeElement.tagName, 'BODY'); assert.equal(value.observedDensity, 2); assert.equal(value.dpr, 2)
  assert.equal(value.frame.renderRevision, 1); assert.equal(value.confirmedRendererIdentity, '["session",1,1]')
  assert.equal(value.presentation.effectiveScale, 1); assert.equal(context.autoPresentationWanted, false)
  assert.notEqual(value.presentation, context.presentation, 'evidence is a snapshot, not a writable reference to accepted settings')
})

test('mixed renderer smoke requires explicit assets and engine and normalizes paths', () => {
  assert.throws(() => parseOptions([]), /renderer-assets/)
  assert.throws(() => parseOptions(['--renderer-assets', '/tmp/assets']), /out/)
  assert.throws(() => parseOptions(['--renderer-assets', '/tmp/assets', '--out', '/tmp/report', '--engine', 'fallback']), /quickjs or v8/)
  for (const value of ['-1', '1.5', 'NaN']) assert.throws(() => parseOptions(['--renderer-assets', '/tmp/assets', '--out', '/tmp/report', '--timeout', value]), /timeout/)
  assert.throws(() => parseOptions(['--renderer-assets', '/tmp/assets', '--out', '/tmp/report', '--bogus', '1']), /Expected/)
  assert.deepEqual(parseOptions(['--help']), { help: true })
  const options = parseOptions(['--binary', '/tmp/simulator', '--renderer-assets', '/tmp/assets', '--out', '/tmp/report', '--engine', 'v8', '--timeout', '240000'])
  assert.equal(options.binary, '/tmp/simulator'); assert.equal(options.engine, 'v8'); assert.equal(options.timeoutMs, 240000)
})

test('fixture packs two explicitly mapped pages and keeps their storage, data and navigation handlers observable', async t => {
  const project = await mkdtemp(join(tmpdir(), 'weapp-mixed-fixture-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const fixture = await createMixedRendererFixture(project)
  const result = await buildManifest(project, { project })
  assert.deepEqual(result.diagnostics.filter(value => value.severity === 'error'), [])
  assert.equal(result.manifest.schemaVersion, 3)
  assert.deepEqual(result.manifest.rendering, { version: '1.0', default: 'webview', pages: { 'pages/home/index': 'webview', 'pages/skia/index': 'skia' } })
  assert.deepEqual(JSON.parse(await readFile(join(project, 'app.json'))).pages, [fixture.routes.webview, fixture.routes.skia])
  const storage = new Map(), navigation = [], pages = []
  const context = vm.createContext({ Page: page => pages.push(page), wx: {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    navigateTo: options => navigation.push(['push', options.url]), navigateBack: options => navigation.push(['pop', options.delta]),
  } })
  for (const route of [fixture.routes.webview, fixture.routes.skia]) vm.runInContext(await readFile(join(project, `${route}.js`), 'utf8'), context)
  for (const page of pages) page.setData = patch => Object.assign(page.data, patch)
  pages[0].onLoad(); pages[0].onIncrement(); pages[0].onNavigate()
  pages[1].onLoad(); pages[1].onIncrement(); pages[1].onBack()
  assert.deepEqual(navigation, [['push', '/pages/skia/index'], ['pop', 1]])
  assert.equal(storage.get('mixed:domLoads'), 1); assert.equal(storage.get('mixed:domCount'), 1)
  assert.equal(storage.get('mixed:skiaCount'), 1); assert.equal(pages[0].data.count, 1)
  assert.ok(result.manifest.templates.some(value => value.id.includes('pages/skia/index.wxml')))
})

test('pre-cancelled mixed smoke saves nested failure evidence and never starts resources or overwrites reports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-mixed-cancel-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const signal = AbortSignal.abort(new Error('cancel mixed smoke')), out = join(directory, 'nested', 'report')
  let starts = 0, launches = 0
  const dependencies = { signal, startSimulator() { starts++; throw Error('unexpected simulator') }, chromium: { launch() { launches++; throw Error('unexpected browser') } } }
  const report = await runMixedRendererDevSmoke({ out, engine: 'quickjs' }, dependencies)
  assert.equal(report.status, 'failed'); assert.match(report.error.message, /cancel mixed smoke/)
  assert.equal(starts, 0); assert.equal(launches, 0)
  const saved = await readFile(join(out, 'report.json'), 'utf8')
  assert.equal(JSON.parse(saved).status, 'failed')
  await writeFile(join(out, 'sentinel'), 'keep')
  await assert.rejects(runMixedRendererDevSmoke({ out, engine: 'quickjs' }, dependencies), error => error.code === 'EEXIST')
  assert.equal(await readFile(join(out, 'report.json'), 'utf8'), saved)
  assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'keep')
})
