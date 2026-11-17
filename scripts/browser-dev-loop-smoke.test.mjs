import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createContext, runInContext, runInNewContext } from 'node:vm'
import { assertDomQueryEvidence, assertGpuHotPath, assertGpuLifetimeAudit, assertSkiaSubmission, captureAndAssertDomQueryEvidence, createGpuSurfaceLifetimeTracker, installGpuAudit, installWorkerAudit, loseSkiaSmokeContext, parseArgs, pollSkiaSmokeCount, pollSmokeValue, readDomQuerySmokeState, readSkiaSmokeState, retainedCompileFailureCount, serverArguments, serverSummaryPath, smokeFixture, validatedSummaryPath } from './browser-dev-loop-smoke.mjs'
import { buildRendererProfiles } from '../tools/container-manifest/src/rendering.mjs'
import { createWorkerAdmissionLoader } from '../examples/hosts/web-wasm/worker-admission-loader.mjs'
import { canonical } from './worker-product-browser-smoke.mjs'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

const input = ['--server-bin', '/smoke/bin/server', '--producer-dir', '/smoke/producer', '--pins', '/smoke/pins.json',
  '--node-bin', '/smoke/bin/node', '--out-dir', '/smoke/evidence']
const option = (args, name) => { const position = args.indexOf(name); assert.ok(position >= 0, `Missing ${name}`); return args[position + 1] }

const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('shared asynchronous observation polling never treats an async readiness Promise as success', async () => {
  let calls = 0
  await assert.rejects(pollSmokeValue(async () => { calls++; return {} }, async () => false),
    /Polling readiness must be a synchronous boolean/)
  assert.equal(calls, 1)
})

test('DOM observation polling waits for a real non-null callback result', async () => {
  const pending = deferred(), entered = deferred(), expected = { state: { queryStatus: 'startup 1' }, accepted: {} }
  let calls = 0, completed = false
  const polling = pollSmokeValue(() => {
    calls++
    if (calls === 1) return Promise.resolve(null)
    assert.equal(calls, 2); entered.resolve(); return pending.promise
  }, value => value !== null, { intervalMs: 1 })
  void polling.then(() => { completed = true })
  await entered.promise; assert.equal(completed, false)
  pending.resolve(expected)
  assert.equal(await polling, expected); assert.equal(calls, 2)
})

test('asynchronous count polling awaits each actual read and returns the matching observation without rereading', async () => {
  const first = deferred(), last = deferred(), enteredLast = deferred()
  const match = { count: 11, fixture: 'actual', marker: 'unchanged' }
  let calls = 0, completed = false
  const polling = pollSkiaSmokeCount(() => {
    calls++
    if (calls === 1) return first.promise
    if (calls === 2) return Promise.resolve({ count: 10 })
    assert.equal(calls, 3); enteredLast.resolve(); return last.promise
  }, 11, { intervalMs: 1 })
  void polling.then(() => { completed = true })
  await nextTurn()
  assert.equal(calls, 1); assert.equal(completed, false, 'A pending Promise cannot count as a successful predicate')
  first.resolve(null)
  await enteredLast.promise
  assert.equal(completed, false, 'Neither null nor a different count can satisfy the wait')
  last.resolve(match)
  assert.equal(await polling, match)
  await nextTurn(); assert.equal(calls, 3, 'Return the matched read; do not issue a racing final query')
})

test('count polling propagates a read failure unchanged and stops querying', async () => {
  const failure = Object.assign(new Error('owner is stale'), { code: 'ERR_OWNER' })
  let calls = 0
  await assert.rejects(pollSkiaSmokeCount(async () => { calls++; throw failure }, 11), error => error === failure)
  await nextTurn(); assert.equal(calls, 1)
})

test('a stalled RPC times out the wait without claiming cancellation or polling after late completion', async () => {
  const pending = deferred(); let calls = 0
  const polling = pollSkiaSmokeCount(() => { calls++; return pending.promise }, 11, { timeoutMs: 25, intervalMs: 1 })
  await assert.rejects(polling, error => error.code === 'ERR_TIMEOUT' && /actual work may remain pending/.test(error.message))
  assert.equal(calls, 1)
  pending.resolve({ count: 11 })
  await nextTurn(); assert.equal(calls, 1)
})

test('count polling uses one total deadline even when repeated reads return a different count', async () => {
  let calls = 0
  await assert.rejects(pollSkiaSmokeCount(async () => { calls++; return { count: 10 } }, 11,
    { timeoutMs: 25, intervalMs: 1 }), { code: 'ERR_TIMEOUT' })
  assert.ok(calls > 0)
  const stopped = calls
  await nextTurn(); assert.equal(calls, stopped)
})

test('abort before polling or before the queued first read starts never issues a new RPC', async () => {
  for (const beforeStart of [true, false]) {
    const controller = new AbortController(), reason = new Error('stop owned smoke')
    let calls = 0
    if (beforeStart) controller.abort(reason)
    const polling = pollSkiaSmokeCount(async () => { calls++; return { count: 11 } }, 11, { signal: controller.signal })
    if (!beforeStart) controller.abort(reason)
    await assert.rejects(polling, error => error === reason)
    await nextTurn(); assert.equal(calls, 0)
  }
})

test('abort during a pending read rejects with the owner reason and ignores its late successful completion', async () => {
  const controller = new AbortController(), reason = new Error('owned cleanup'), pending = deferred()
  let calls = 0
  const polling = pollSkiaSmokeCount(() => { calls++; return pending.promise }, 11, { signal: controller.signal })
  await nextTurn(); assert.equal(calls, 1)
  controller.abort(reason)
  await assert.rejects(polling, error => error === reason)
  pending.resolve({ count: 11 })
  await nextTurn(); assert.equal(calls, 1)
})

test('abort during the interval stops the next read and preserves the original reason', async () => {
  const controller = new AbortController(), reason = new Error('stop interval'), first = deferred()
  let calls = 0
  const polling = pollSkiaSmokeCount(async () => { calls++; first.resolve(); return { count: 10 } }, 11,
    { signal: controller.signal, intervalMs: 1000 })
  await first.promise; await nextTurn()
  controller.abort(reason)
  await assert.rejects(polling, error => error === reason)
  await nextTurn(); assert.equal(calls, 1)
})

test('existing callers keep the example server and one reload by default', () => {
  const options = parseArgs(input)
  assert.equal(options.serverKind, 'example'); assert.equal(options.reloads, 1); assert.equal(options.renderer, 'webview')
  const args = serverArguments(options, '/smoke/project')
  assert.equal(option(args, '--project'), '/smoke/project')
  assert.equal(option(args, '--producer-dir'), options.producerDir)
  assert.equal(option(args, '--pins'), options.pins)
  assert.equal(option(args, '--duration-seconds'), '300')
  assert.equal(args.includes('dev'), false); assert.equal(args.includes('--browser-runtime-dir'), false)
})

test('CLI smoke uses the public dev command and real nondefault startup intent', () => {
  const options = parseArgs([...input, '--server-kind', 'cli', '--reloads', '12'])
  assert.equal(options.reloads, 12)
  const args = serverArguments(options, '/smoke/project'), fixture = smokeFixture('cli')
  assert.equal(args[0], 'dev')
  for (const [name, expected] of [['--web-runtime', 'browser'], ['--renderer', 'webview'], ['--surface', 'web'],
    ['--browser-runtime-dir', options.producerDir], ['--browser-runtime-pins', options.pins],
    ['--node-bin', options.nodeBin], ['--out-dir', resolve(options.outDir, 'server')], ['--port', '0']]) assert.equal(option(args, name), expected)
  assert.equal(option(args, '--route'), fixture.route)
  assert.deepEqual(JSON.parse(option(args, '--data-json')), fixture.data)
  assert.equal(option(args, '--viewport'), '414x736')
  for (const unsupported of ['--duration-seconds', '--producer-dir', '--pins']) assert.equal(args.includes(unsupported), false)
})

test('server kind and bounded reload arguments reject invalid, duplicate or missing values', () => {
  for (const value of ['CLI', 'web', '../cli', '']) assert.throws(() => parseArgs([...input, '--server-kind', value]))
  assert.throws(() => parseArgs([...input, '--server-kind', 'cli', '--server-kind', 'example']), /Duplicate/)
  assert.throws(() => parseArgs([...input, '--server-kind']), /Unknown option or missing value/)
  assert.throws(() => parseArgs([...input, '--unknown', 'cli']), /Unknown option/)
  for (const value of ['0', '17', '-1', '1.5', '01']) assert.throws(() => parseArgs([...input, '--reloads', value]), /1\.\.16/)
  assert.equal(parseArgs([...input, '--reloads', '16']).reloads, 16)
})

test('renderer selection is explicit and Skia only runs through the public CLI', () => {
  for (const renderer of ['canvas', 'canvaskit', 'auto', 'SKIA', '']) assert.throws(() => parseArgs([...input, '--renderer', renderer]))
  assert.throws(() => parseArgs([...input, '--renderer', 'skia']), /requires the CLI/)
  assert.throws(() => parseArgs([...input, '--renderer', 'webview', '--renderer', 'webview']), /Duplicate/)
  const options = parseArgs([...input, '--renderer', 'skia', '--server-kind', 'cli'])
  assert.equal(options.renderer, 'skia')
  assert.equal(option(serverArguments(options, '/smoke/project'), '--renderer'), 'skia')
  assert.throws(() => smokeFixture('example', 'skia'), /requires the CLI/)
})

test('context loss smoke is explicit, boolean and limited to the real Skia CLI', () => {
  assert.equal(parseArgs(input).contextRecovery, false)
  assert.throws(() => parseArgs([...input, '--context-recovery', 'true']), /requires Skia/)
  for (const value of ['1', 'yes', 'TRUE', '']) assert.throws(() => parseArgs([...input, '--context-recovery', value]))
  const options = parseArgs([...input, '--server-kind', 'cli', '--renderer', 'skia', '--context-recovery', 'true'])
  assert.equal(options.contextRecovery, true)
  assert.throws(() => smokeFixture('cli', 'webview', true), /requires Skia/)
  assert.doesNotMatch(smokeFixture('cli', 'skia').files['public/browser-dev-smoke-state.js'], /browserDevSmokeDirtyTimer/)
  assert.equal(smokeFixture('cli', 'skia').dirtyTimerQuery, undefined)
})

test('context loss fixture separates real AppService changes, timer effects and stateful WXS evaluation', () => {
  const fixture = smokeFixture('cli', 'skia', true), exports = {}, tasks = []
  assert.deepEqual(fixture.dirtyTimerQuery, { moduleId: fixture.appStateQuery.moduleId,
    export: 'browserDevSmokeDirtyTimer', args: [] }, 'Loss-time mutation must use the same catalog module identity as state reads')
  const page = { data: { count: 8, marker: fixture.data.marker }, setData(patch) { Object.assign(this.data, patch) } }
  assert.doesNotMatch(fixture.files['app.js'], /exports|browserDevSmoke/, 'Recovery probes must not rely on bundled entry exports')
  runInNewContext(fixture.files['public/browser-dev-smoke-state.js'], { exports, getCurrentPages: () => [page], setTimeout: callback => { tasks.push(callback) } })
  assert.equal(exports.browserDevSmokeDirtyTimer(), 'timer-armed')
  assert.equal(page.data.count, 9); assert.equal(tasks.length, 1)
  assert.equal(exports.browserDevSmokeState().count, 9)
  tasks[0]()
  assert.equal(exports.browserDevSmokeState().count, 10)
  const source = fixture.files[`${fixture.route}.wxml`].match(/<wxs module="recoveryProbe">([\s\S]*?)<\/wxs>/)?.[1]
  assert.ok(source, 'The observable probe must be a real WXS module')
  const module = { exports: {} }
  runInNewContext(source, { module })
  assert.equal(module.exports.next(), 'View calls: 1')
  assert.equal(module.exports.next(), 'View calls: 2')
  assert.match(fixture.files[`${fixture.route}.wxml`], /\{\{recoveryProbe.next\(\)\}\}/)
})

// A controlled event target verifies browser serialization and bridge
// addressing only. It is not evidence of an actual browser context loss.
function contextLossHarness(input, request) {
  const owner = { workerEpoch: 'epoch', sessionId: 'session' }, captures = new Set(), targets = []
  let contextLost = false
  const executing = { owner, inputEnabled: true, surfaceRecovery: null }
  const window = { weappContainerDev: { status: { manager: { executing } }, request },
    __browserDevGpuAudit: { read(value) { assert.equal(value, gl); return { contextLostAtCapture: contextLost } } },
    addEventListener(name, listener, capture) { assert.equal(name, 'webglcontextlost'); assert.equal(capture, true); captures.add(listener) },
    removeEventListener(name, listener, capture) { assert.equal(name, 'webglcontextlost'); assert.equal(capture, true); captures.delete(listener) } }
  const canvas = { addEventListener(name, listener, options) {
    assert.equal(name, 'webglcontextlost'); assert.equal(options.once, true); targets.push(listener)
  }, getContext(name) { assert.equal(name, 'webgl2'); return gl } }
  const gl = { isContextLost: () => contextLost, getExtension(name) {
    assert.equal(name, 'WEBGL_lose_context')
    return { loseContext() {
      contextLost = true
      const event = { target: canvas }
      for (const listener of captures) listener(event)
      executing.inputEnabled = false; executing.surfaceRecovery = { version: '1.0' }
      for (const listener of targets) listener(event)
    } }
  } }
  const document = { querySelector(selector) { assert.equal(selector, '#dev-surface [data-worker-web-session] canvas'); return canvas } }
  runInNewContext(`(${loseSkiaSmokeContext.toString()})(input)`, { window, document, input })
  return { window, owner, executing, captures }
}

test('serialized loss-time mutation receives its catalog query and owner without module lexical capture', async () => {
  const fixture = smokeFixture('cli', 'skia', true), exports = {}, tasks = [], calls = []
  const page = { route: fixture.route, data: structuredClone(fixture.data), setData(patch) { Object.assign(this.data, patch) } }
  runInNewContext(fixture.files['public/browser-dev-smoke-state.js'], { exports, getCurrentPages: () => [page], setTimeout: callback => { tasks.push(callback) } })
  const ownerKey = { activationId: '1', ownerSerial: '2', clientOwnerId: 'loss-owner' }
  const harness = contextLossHarness({ dirtyQuery: fixture.dirtyTimerQuery, ownerKey }, async value => {
    calls.push(value)
    assert.equal(value.payload.moduleId, 'module:browser-dev-smoke-state.js'); assert.equal(value.payload.export, 'browserDevSmokeDirtyTimer')
    return { stale: false, result: { ok: true, result: [exports[value.payload.export](...value.payload.args)] } }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1); assert.equal(calls[0].ownerKey, ownerKey)
  assert.equal(calls[0].op, 'module.call'); assert.equal(calls[0].payload, fixture.dirtyTimerQuery)
  const probe = harness.window.__contextRecoverySmoke
  assert.equal(probe.lost, true); assert.equal(probe.inputBlocked, true); assert.equal(probe.owner, harness.owner)
  assert.equal(probe.recovery, harness.executing.surfaceRecovery); assert.equal(probe.dirty, 'acknowledged'); assert.equal(probe.error, null)
  assert.equal(probe.contextLost, true); assert.equal(probe.gpuAtLoss.contextLostAtCapture, true)
  assert.equal(harness.captures.size, 0); assert.equal(page.data.count, 8); assert.equal(tasks.length, 1)
  tasks[0](); assert.equal(exports.browserDevSmokeState().count, 9)
  let cleanCalls = 0
  const clean = contextLossHarness({ dirtyQuery: null, ownerKey }, () => { cleanCalls++; throw new Error('Clean recovery must not mutate AppService') })
  assert.equal(cleanCalls, 0); assert.equal(clean.window.__contextRecoverySmoke.dirty, null)
})

test('loss-time mutation reports stale or invalid bridge outcomes instead of marking the request acknowledged', async () => {
  const fixture = smokeFixture('cli', 'skia', true)
  for (const response of [null, { stale: true, result: { ok: true, result: ['timer-armed'] } },
    { result: { ok: false, result: ['timer-armed'] } }, { result: { ok: true, result: [] } },
    { result: { ok: true, result: ['timer-armed', 'extra'] } }, { result: { ok: true, result: 'timer-armed' } }]) {
    const { window } = contextLossHarness({ dirtyQuery: fixture.dirtyTimerQuery, ownerKey: {} }, async () => response)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(window.__contextRecoverySmoke.dirty, 'pending')
    assert.match(window.__contextRecoverySmoke.error.message, /Actual loss-time AppService mutation failed/)
  }
  const { window } = contextLossHarness({ dirtyQuery: { ...fixture.dirtyTimerQuery, moduleId: 'app.js' }, ownerKey: {} }, async value => {
    throw Object.assign(new Error(`module ${value.payload.moduleId} is not loaded`), { code: 'ERR_MODULE_LOAD' })
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(window.__contextRecoverySmoke.error.code, 'ERR_MODULE_LOAD')
  assert.equal(window.__contextRecoverySmoke.dirty, 'pending')
})

test('evidence cannot contain or sit inside original inputs', () => {
  assert.throws(() => parseArgs([...input.filter((_, index) => index < input.length - 2), '--out-dir', '/smoke']), /contain an input/)
  assert.throws(() => parseArgs([...input.filter((_, index) => index < input.length - 2), '--out-dir', '/smoke/producer/evidence']), /outside the original producer/)
})

test('CLI fixture selected route is second and injected data differs from declared defaults', () => {
  const fixture = smokeFixture('cli'), app = JSON.parse(fixture.files['app.json'])
  assert.equal(app.pages.indexOf(fixture.route), 1)
  assert.notEqual(app.pages[0], fixture.route)
  for (const path of app.pages) for (const extension of ['js', 'json', 'wxml', 'wxss']) assert.ok(`${path}.${extension}` in fixture.files)
  let page
  runInNewContext(fixture.files[`${fixture.route}.js`], { Page: value => { page = value } })
  assert.equal(page.data.count, 0); assert.equal(fixture.data.count, 7)
  assert.notEqual(page.data.marker, fixture.data.marker)
  assert.match(fixture.files[`${fixture.route}.wxml`], /id="startup-marker">\{\{marker\}\}/)
  assert.match(fixture.files[`${fixture.route}.wxml`], /id="count">Count: \{\{count\}\}/)
  assert.match(fixture.files[`${app.pages[0]}.wxml`], /Wrong default route/)
  assert.deepEqual(fixture.viewport, { width: 414, height: 736 })
})

test('example fixture preserves its single route, count and viewport', () => {
  const fixture = smokeFixture(), app = JSON.parse(fixture.files['app.json'])
  assert.deepEqual(app.pages, [fixture.route]); assert.deepEqual(fixture.data, { count: 0 })
  assert.deepEqual(fixture.viewport, { width: 375, height: 667 })
  assert.doesNotMatch(fixture.files[`${fixture.route}.wxml`], /startup-marker/)
})

test('Skia fixture exposes real page state and fixed logical pointer/visual targets', () => {
  const fixture = smokeFixture('cli', 'skia'), app = JSON.parse(fixture.files['app.json'])
  assert.deepEqual(fixture.appStateQuery, { moduleId: 'module:browser-dev-smoke-state.js', export: 'browserDevSmokeState', args: [] },
    'Public module.call uses the catalog module ID, not app.entryModule file spelling')
  assert.equal(app.renderer, 'webview'); assert.equal(app.pages.indexOf(fixture.route), 1)
  assert.doesNotMatch(fixture.files['app.js'], /exports|browserDevSmokeState/, 'Bundled entry exports cannot serve as diagnostic API')
  const exports = {}, page = { route: fixture.route, data: { count: 7, marker: fixture.data.marker } }
  runInNewContext(fixture.files['public/browser-dev-smoke-state.js'], { exports, getCurrentPages: () => [page] })
  const state = exports.browserDevSmokeState()
  assert.equal(state.count, 7); assert.equal(state.marker, fixture.data.marker); assert.equal(state.route, fixture.route)
  page.data.count++
  assert.equal(exports.browserDevSmokeState().count, 8, 'The fixture must read live Page state, not retain initial data')
  assert.ok(fixture.canvas.button.x > 24 && fixture.canvas.button.x < 264 && fixture.canvas.button.y > 144 && fixture.canvas.button.y < 200)
  assert.ok(fixture.canvas.feedback.x > 24 && fixture.canvas.feedback.x < 264 && fixture.canvas.feedback.y > 224 && fixture.canvas.feedback.y < 296)
  assert.match(fixture.files[`${fixture.route}.wxml`], /count === 7/)
  assert.deepEqual(fixture.canvas.before, [31, 75, 153, 255]); assert.deepEqual(fixture.canvas.after, [30, 132, 73, 255])
})

test('serialized Skia polling and final reads call the same catalog export through the current owner bridge', async () => {
  const fixture = smokeFixture('cli', 'skia'), calls = [], exports = {}, page = { route: fixture.route, data: structuredClone(fixture.data) }
  runInNewContext(fixture.files['public/browser-dev-smoke-state.js'], { exports, getCurrentPages: () => [page] })
  const modules = new Map([['module:browser-dev-smoke-state.js', exports]]), ownerKey = { activationId: '1', ownerSerial: '2', clientOwnerId: 'actual-test-owner' }
  const window = { weappContainerDev: { status: { manager: { executing: { ownerKey } } }, async request(value) {
    calls.push(value)
    const loaded = modules.get(value.payload.moduleId)
    if (!loaded) throw Object.assign(new Error(`module ${value.payload.moduleId} is not loaded`), { code: 'ERR_MODULE_LOAD' })
    return { stale: false, result: { ok: true, result: [loaded[value.payload.export](...value.payload.args)] } }
  } } }
  const read = input => runInNewContext(`(${readSkiaSmokeState.toString()})(input)`, { window, input })
  assert.equal((await read({ query: fixture.appStateQuery, expectedCount: 7 })).count, 7)
  assert.equal(await read({ query: fixture.appStateQuery, expectedCount: 8 }), null, 'Polling cannot fabricate the requested count')
  page.data.count = 8
  const final = await read({ query: fixture.appStateQuery })
  assert.equal(final.count, 8); assert.equal(final.marker, fixture.data.marker); assert.equal(final.route, fixture.route)
  assert.equal(calls.length, 3)
  for (const value of calls) {
    assert.equal(value.ownerKey, ownerKey); assert.equal(value.op, 'module.call'); assert.equal(value.payload, fixture.appStateQuery)
  }
  await assert.rejects(read({ query: { ...fixture.appStateQuery, moduleId: 'app.js' } }), { code: 'ERR_MODULE_LOAD' },
    'The resource path must remain an invalid catalog module ID')
})

test('serialized Skia state query rejects stale owners and missing actual results', async () => {
  for (const response of [{ stale: true, result: { ok: true, result: [{ count: 7 }] } },
    { stale: false, result: { ok: false, result: [{ count: 7 }] } }, { result: { ok: true, result: [] } },
    { result: { ok: true, result: [{ count: 7 }, { count: 7 }] } }, { result: { ok: true, result: '7' } }, null]) {
    const input = { query: smokeFixture('cli', 'skia').appStateQuery, expectedCount: 7 }
    const window = { weappContainerDev: { status: { manager: { executing: { ownerKey: {} } } }, request: async () => response } }
    await assert.rejects(runInNewContext(`(${readSkiaSmokeState.toString()})(input)`, { window, input }), /Actual AppService smoke state query failed/)
  }
})

test('production source parsing rejects skia while CLI force overrides a legal WebView declaration at admission', async () => {
  const fixture = smokeFixture('cli', 'skia'), app = JSON.parse(fixture.files['app.json'])
  const routes = app.pages.map(path => ({ id: `route:${path}`, path, kind: 'page', entryModule: `${path}.js` }))
  const rendering = buildRendererProfiles(routes, app, new Map(), undefined)
  assert.equal(rendering.default, 'webview'); assert.equal(rendering.pages[fixture.route], 'webview')
  assert.throws(() => buildRendererProfiles(routes, { ...app, renderer: 'skia' }, new Map(), undefined),
    { code: 'ERR_RENDERER_CONFIG', path: 'app.json' })
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
  const json = value => new TextEncoder().encode(JSON.stringify(value))
  const manifest = { schemaVersion: 3, protocolVersion: '1.0', app: { appJson: 'app.json', entryModule: 'app.js' },
    routes, modules: [], rendering, integrity: { algorithm: 'sha256', root: '' } }
  manifest.integrity.root = sha256(new TextEncoder().encode(canonical(manifest)))
  const manifestBytes = json(manifest), index = { schemaVersion: 1, manifest: './manifest.json', manifestSize: manifestBytes.length,
    manifestSha256: sha256(manifestBytes), integrityRoot: manifest.integrity.root, blobs: [] }
  const indexBytes = json(index), baseUrl = 'https://fixture.test/index.html'
  const files = new Map([['https://fixture.test/pack-index.json', indexBytes], ['https://fixture.test/manifest.json', manifestBytes]])
  let executableImports = 0
  const loader = createWorkerAdmissionLoader({ baseUrl, sha256, fetch: async url => {
    const bytes = files.get(url); assert.ok(bytes, 'Admission unexpectedly read outside the pinned in-memory index/manifest')
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  }, importModule: async () => { executableImports++; throw new Error('Pure admission must not execute any module') } })
  const admission = { indexUrl: './pack-index.json', indexSha256: sha256(indexBytes), indexSize: indexBytes.length, route: fixture.route }
  const declared = await loader.admitWorkerPack({ ...admission, rendererPolicy: { mode: 'manifest' } })
  assert.equal(declared.effectiveProfile, 'webview'); assert.equal(declared.transportBackend, 'browser-view')
  const cli = parseArgs([...input, '--renderer', 'skia', '--server-kind', 'cli'])
  const forced = await loader.admitWorkerPack({ ...admission,
    rendererPolicy: { mode: 'force', profile: option(serverArguments(cli, '/smoke/project'), '--renderer') } })
  assert.equal(forced.declaredProfile, 'webview'); assert.equal(forced.effectiveProfile, 'skia')
  assert.equal(forced.transportBackend, 'external-frame'); assert.equal(forced.route, fixture.route)
  assert.equal(executableImports, 0)
})

const gpuAuditFixture = ({ serialized = false } = {}) => {
  class GL {
    constructor() { this.canvas = { width: 414, height: 736 }; this.RGBA = 6408; this.calls = [] }
    finish(...args) { this.calls.push(['finish', ...args]); return 'finish-result' }
    readPixels(...args) { this.calls.push(['readPixels', ...args]); return 'pixels-result' }
    texImage2D(...args) { this.calls.push(['texImage2D', ...args]); return 'image-result' }
    texSubImage2D(...args) { this.calls.push(['texSubImage2D', ...args]); return 'sub-result' }
  }
  const target = { document: {}, WebGL2RenderingContext: GL }; target.top = target
  if (serialized) runInNewContext(`(${installGpuAudit.toString()})(target)`, { target, structuredClone })
  else installGpuAudit(target)
  return { GL, target, audit: target.__browserDevGpuAudit }
}

test('GPU audit delegates actual methods and distinguishes frame uploads from allocations and atlases', () => {
  const { GL, audit } = gpuAuditFixture(), gl = new GL(), pixels = new Uint8Array(4)
  assert.equal(gl.texImage2D(0, 0, 6408, 414, 736, 0, 6408, 5121, null), 'image-result')
  gl.texImage2D(0, 0, 6408, 256, 256, 0, 6408, 5121, pixels)
  assert.equal(audit.read().fullFrameRgbaUploads, 0)
  gl.texImage2D(0, 0, 6408, 414, 736, 0, 6408, 5121, pixels)
  assert.equal(gl.texSubImage2D(0, 0, 0, 0, 414, 736, 6408, 5121, 0), 'sub-result')
  assert.equal(gl.finish(), 'finish-result'); assert.equal(gl.readPixels(0, 0), 'pixels-result')
  const value = audit.read(gl)
  assert.equal(value.installed, true); assert.equal(value.finishCalls, 1); assert.equal(value.readPixelsCalls, 1)
  assert.equal(value.fullFrameRgbaUploads, 2); assert.equal(value.uploads.length, 2); assert.equal(gl.calls.length, 6)
  assert.deepEqual(value.contexts, [{ contextId: 1, finishCalls: 1, readPixelsCalls: 1, fullFrameRgbaUploads: 2 }])
  assert.deepEqual(value.activeContext, value.contexts[0])
  for (const fact of [...value.uploads, ...value.synchronizationCalls]) assert.equal(fact.contextId, 1)
  assert.deepEqual(gl.calls.at(-1), ['readPixels', 0, 0], 'Instrumentation must preserve the receiver and actual arguments')
  value.uploads.length = 0; value.contexts[0].finishCalls = 0; value.activeContext.readPixelsCalls = 0
  const reread = audit.read(gl)
  assert.equal(reread.uploads.length, 2, 'Reading observations must not mutate the retained audit')
  assert.equal(reread.activeContext.finishCalls, 1); assert.equal(reread.activeContext.readPixelsCalls, 1)
})

test('serialized GPU audit retains global retirement synchronization while enforcing active lifetime counters', () => {
  const { GL, audit } = gpuAuditFixture({ serialized: true }), old = new GL(), active = new GL()
  old.texImage2D(0, 0, 6408, 414, 736, 0, 6408, 5121, null)
  const oldId = audit.read(old).activeContext.contextId
  assertGpuHotPath(audit.read(old))
  active.texImage2D(0, 0, 6408, 256, 256, 0, 6408, 5121, new Uint8Array(4))
  const activeId = audit.read(active).activeContext.contextId
  assert.notEqual(activeId, oldId)
  assertGpuHotPath(audit.read(active), { liveContextIds: [oldId] })
  assert.equal(old.finish('native-destruction'), 'finish-result')
  assert.deepEqual(old.calls.at(-1), ['finish', 'native-destruction'])
  const value = audit.read(active)
  assert.equal(value.finishCalls, 1, 'Retired contexts must remain in the global total')
  assert.equal(value.activeContext.finishCalls, 0)
  assert.deepEqual(value.nonActiveContextSynchronization, { finishCalls: 1, readPixelsCalls: 0 })
  assert.equal(value.synchronizationCalls[0].contextId, oldId)
  assert.match(value.synchronizationCalls[0].stack, /Observed WebGL synchronization/)
  assertGpuHotPath(value)
  assert.throws(() => assertGpuHotPath(value, { liveContextIds: [oldId] }), /Live WebGL context .* used finishCalls/,
    'A formerly front context is not retired while its owner still owns both buffers')
  active.finish()
  assert.throws(() => assertGpuHotPath(audit.read(active)), /Live WebGL context .* used finishCalls/)
  assert.throws(() => assertGpuHotPath(audit.read(active)), /finishCalls/,
    'Reading or accepting another frame must never reset the active context lifetime counters')
  assert.equal(audit.read(active).finishCalls, 2)
})

test('GPU audit cannot attribute another live buffer synchronization to an unrelated active context', () => {
  const { GL, audit } = gpuAuditFixture(), front = new GL(), spare = new GL()
  const frontId = audit.read(front).activeContext.contextId, spareId = audit.read(spare).activeContext.contextId
  spare.finish()
  assertGpuHotPath(audit.read(front))
  assert.throws(() => assertGpuHotPath(audit.read(front), { liveContextIds: [frontId, spareId] }), /finishCalls/)
  assert.throws(() => assertGpuHotPath(audit.read()), /Current real canvas/)
  assert.throws(() => assertGpuHotPath(audit.read({})), /Current real canvas/)
})

test('GPU lifetime gate rejects readback and full-frame RGBA upload from any context, including retired ones', () => {
  for (const operation of ['readPixels', 'texImage2D', 'texSubImage2D']) {
    const { GL, audit } = gpuAuditFixture(), old = new GL(), active = new GL()
    audit.read(active)
    if (operation === 'readPixels') old.readPixels(0, 0, 1, 1, 6408, 5121, new Uint8Array(4))
    else if (operation === 'texImage2D') old.texImage2D(0, 0, 6408, 414, 736, 0, 6408, 5121, new Uint8Array(4))
    else old.texSubImage2D(0, 0, 0, 0, 414, 736, 6408, 5121, new Uint8Array(4))
    assert.throws(() => assertGpuHotPath(audit.read(active)), /WebGL lifetime audit used/)
    assert.throws(() => assertGpuLifetimeAudit(audit.read()), /WebGL lifetime audit used/,
      'Stopping the final owner must still enforce the complete-run transport/readback boundary')
    assert.equal(old.calls.length, 1, 'Rejected evidence must still reflect an actual delegated native call')
  }
})

test('GPU audit bounds context and call evidence and fails instead of silently omitting observations', () => {
  {
    const { GL, audit } = gpuAuditFixture()
    let active
    for (let index = 0; index < 65; index++) { active = new GL(); audit.read(active) }
    const value = audit.read(active)
    assert.equal(value.contexts.length, 64); assert.equal(value.droppedContexts, 1)
    assert.equal(value.activeContext.contextId, null)
    assert.equal(audit.read(active).droppedContexts, 1, 'One overflow context must only count once')
    assert.throws(() => assertGpuHotPath(value), /droppedContexts/)
  }
  {
    const { GL, audit } = gpuAuditFixture(), old = new GL(), active = new GL()
    for (let index = 0; index < 65; index++) old.finish()
    const value = audit.read(active)
    assert.equal(value.finishCalls, 65); assert.equal(value.synchronizationCalls.length, 64)
    assert.equal(value.droppedSynchronizationCalls, 1); assert.equal(old.calls.length, 65)
    assert.ok(value.synchronizationCalls.every(call => call.stack.length <= 8192))
    assert.throws(() => assertGpuHotPath(value), /droppedSynchronizationCalls/)
  }
})

const submissionFixture = () => {
  const owner = { workerEpoch: 'epoch', sessionId: 'session', packSha256: 'a'.repeat(64), transportBackend: 'external-frame' }
  const viewport = { width: 414, height: 736 }, route = 'pages/home/index'
  const proof = { version: '1.0', owner, attemptId: '2', surfaceGeneration: '1',
    consumedInput: { pageId: '1', routePath: route, templateRevision: '3', viewport: { x: 0, y: 0, ...viewport } },
    publication: { kind: 'external-frame', renderRevision: '5' } }
  const receipt = { version: '1.0', status: 'submitted', owner, attemptId: '2', surfaceGeneration: '1', renderRevision: '5',
    frameId: 5, presenterGeneration: 1, viewport: { x: 0, y: 0, ...viewport }, physicalSize: viewport, backend: 'canvaskit-webgl2',
    context: { api: 'webgl2', surfaceIsGpu: true, contextLost: false, physicalHardware: 'unknown' },
    runtimeBoundary: { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 },
    presentation: { pictureSubmissions: 1, flushes: 1, gpuCompletion: 'not-waited', glError: 0 } }
  return { submission: { phase: 'accepted', value: receipt, proof }, expected: { owner, viewport, route } }
}

const acceptedGpuObservation = (gpu, generation = '1') => {
  const { submission, expected } = submissionFixture()
  submission.value.surfaceGeneration = generation; submission.proof.surfaceGeneration = generation
  const acknowledgement = { direction: 'receive', op: 'ack', workerEpoch: expected.owner.workerEpoch, sessionId: expected.owner.sessionId,
    acknowledgement: { version: '1.0', sessionId: expected.owner.sessionId, renderRevision: submission.value.renderRevision,
      acknowledged: true, inputEnabled: true, requiresRestart: false },
    runtimeState: { renderRevision: submission.value.renderRevision, surfaceGeneration: generation } }
  return { observed: { owner: expected.owner, submission, acknowledgement, gpu }, expected }
}

const gpuLossObservation = (gpu, lossId = '1') => ({ owner: submissionFixture().expected.owner, lost: true,
  inputBlocked: true, contextLost: true, recovery: { version: '1.0', lossId }, gpuAtLoss: gpu })

test('same-owner accepted recovery retires the old surface without resetting any GL lifetime evidence', () => {
  const { GL, audit } = gpuAuditFixture(), first = new GL(), spare = new GL(), recovered = new GL()
  const tracker = createGpuSurfaceLifetimeTracker()
  const observe = (gl, generation) => {
    const { observed, expected } = acceptedGpuObservation(audit.read(gl), generation)
    return tracker.observe(observed, expected)
  }
  const front = observe(first, '1'), buffers = observe(spare, '1')
  assert.deepEqual(buffers.liveContextIds, [front.liveContextIds[0], audit.read(spare).activeContext.contextId])
  const loss = tracker.recordLoss(gpuLossObservation(audit.read(first)))
  assert.deepEqual(loss.liveContextIds, buffers.liveContextIds)
  first.finish(); spare.finish()
  assert.throws(() => observe(recovered, '1'), /Lost surface cannot resume under its old generation/)
  const replacement = observe(recovered, '2')
  assert.equal(replacement.surfaceGeneration, '2'); assert.equal(replacement.retiredSurfaceGeneration, '1')
  assert.equal(replacement.retirementLossId, '1')
  assert.deepEqual(replacement.retiredContextIds, buffers.liveContextIds)
  assert.deepEqual(replacement.liveContextIds, [audit.read(recovered).activeContext.contextId])
  assert.equal(audit.read(recovered).finishCalls, 2)
  assert.equal(audit.read(recovered).synchronizationCalls.length, 2)
  assertGpuLifetimeAudit(audit.read())
  tracker.recordLoss(gpuLossObservation(audit.read(recovered), '2'))
  assert.throws(() => observe(first, '3'), /finishCalls/, 'A reused real context keeps its lifetime counter across accepted generations')
  assert.throws(() => observe(recovered, '1'), /Stale accepted surface generation/)
  recovered.finish('actual-hot-path-call')
  assert.throws(() => observe(recovered, '3'), /finishCalls/)
})

test('new generation cannot hide a finish between the last checkpoint and the actual context-loss boundary', () => {
  const { GL, audit } = gpuAuditFixture(), old = new GL(), next = new GL(), tracker = createGpuSurfaceLifetimeTracker()
  const initial = acceptedGpuObservation(audit.read(old)); tracker.observe(initial.observed, initial.expected)
  const newer = () => {
    const value = acceptedGpuObservation(audit.read(next), '2')
    return tracker.observe(value.observed, value.expected)
  }
  assert.throws(newer, /requires an actual checked context loss/)
  old.finish('bad-hot-path-finish-before-real-loss')
  assert.throws(() => tracker.recordLoss(gpuLossObservation(audit.read(old))), /finishCalls/)
  assert.throws(newer, /requires an actual checked context loss/,
    'A failed final live-surface checkpoint must never grant retirement authority')
  assert.equal(audit.read().finishCalls, 1)
})

test('surface generation retirement requires matching accepted native ACK and preserves global readback gates', () => {
  for (const corrupt of [value => { value.submission.phase = 'submitted' }, value => { value.acknowledgement = null },
    value => { value.acknowledgement.acknowledgement.acknowledged = false },
    value => { value.acknowledgement.workerEpoch = 'old-owner' },
    value => { value.acknowledgement.runtimeState.surfaceGeneration = '1' },
    value => { value.acknowledgement.runtimeState.renderRevision = '4' }]) {
    const { GL, audit } = gpuAuditFixture(), gl = new GL(), tracker = createGpuSurfaceLifetimeTracker()
    const { observed, expected } = acceptedGpuObservation(audit.read(gl), '2')
    corrupt(observed); assert.throws(() => tracker.observe(observed, expected))
  }
  const { GL, audit } = gpuAuditFixture(), old = new GL(), recovered = new GL(), tracker = createGpuSurfaceLifetimeTracker()
  const initial = acceptedGpuObservation(audit.read(old)); tracker.observe(initial.observed, initial.expected)
  tracker.recordLoss(gpuLossObservation(audit.read(old)))
  old.readPixels(0, 0, 1, 1, 6408, 5121, new Uint8Array(4))
  const next = acceptedGpuObservation(audit.read(recovered), '2')
  assert.throws(() => tracker.observe(next.observed, next.expected), /WebGL lifetime audit used readPixelsCalls/,
    'Retiring a surface must not hide a readback from any real context')
})

test('Skia receipt must match the actual accepted owner, publication, geometry and asynchronous GPU boundary', () => {
  const { submission, expected } = submissionFixture()
  assert.equal(assertSkiaSubmission(submission, expected), submission)
  for (const change of [value => { value.phase = 'submitted' }, value => { value.proof = null },
    value => { value.value.owner = { ...value.value.owner, sessionId: 'stale' } }, value => { value.value.renderRevision = '4' },
    value => { value.proof.consumedInput.routePath = 'pages/decoy/index' }, value => { value.value.physicalSize.width = 375 },
    value => { value.value.context.surfaceIsGpu = false }, value => { value.value.context.physicalHardware = true },
    value => { value.value.runtimeBoundary.softwareRgbaUploads = 1 }, value => { value.value.presentation.gpuCompletion = 'gl.finish' }]) {
    const fixture = submissionFixture(), copy = structuredClone(fixture.submission)
    change(copy)
    assert.throws(() => assertSkiaSubmission(copy, fixture.expected))
  }
})

test('Skia consumer rejects the old submission receipt field instead of accepting a parallel schema', () => {
  const { submission, expected } = submissionFixture()
  const { value, ...rest } = submission
  assert.throws(() => assertSkiaSubmission({ ...rest, receipt: value }, expected), /Legacy submission receipt shape/)
  assert.throws(() => assertSkiaSubmission({ ...submission, receipt: value }, expected), /Legacy submission receipt shape/)
})

test('shutdown summary is selected by the original run id only for CLI mode', () => {
  const cli = parseArgs([...input, '--server-kind', 'cli']), example = parseArgs(input)
  assert.equal(serverSummaryPath(cli, 'run-7'), '/smoke/evidence/server/runs/run-7/browser-dev-summary.json')
  assert.equal(serverSummaryPath(example, 'run-7'), '/smoke/evidence/server/serve-browser-dev-summary.json')
  const listening = { runId: 'run-7', summaryPath: serverSummaryPath(cli, 'run-7') }
  assert.equal(validatedSummaryPath(cli, listening), listening.summaryPath)
  assert.throws(() => validatedSummaryPath(cli, { ...listening, runId: 'run-8' }), /unauthorized summary path/)
  assert.throws(() => validatedSummaryPath(example, listening), /unauthorized summary path/)
})

test('summary authority rejects traversal, oversized identities and normalized aliases', () => {
  const options = parseArgs([...input, '--server-kind', 'cli'])
  for (const runId of ['', '.', '..', '../run', 'run/name', 'run\\name', 'run%2fname', 'run?x', 'run\n7', 'a'.repeat(257), null, 7])
    assert.throws(() => serverSummaryPath(options, runId), /Invalid original server run id/)
  const expected = serverSummaryPath(options, 'run-7')
  for (const path of ['/other/browser-dev-summary.json', expected.replace('run-7/', 'run-7/../run-7/'),
    expected.replace('/smoke/', 'smoke/'), expected + '?x', null])
    assert.throws(() => validatedSummaryPath(options, { runId: 'run-7', summaryPath: path }), /unauthorized summary path/)
})


test('DOM query smoke defaults off and accepts only an explicit boolean on CLI WebView', () => {
  assert.equal(parseArgs(input).domQueries, false)
  assert.equal(parseArgs([...input, '--dom-queries', 'false']).domQueries, false)
  const enabled = parseArgs([...input, '--server-kind', 'cli', '--dom-queries', 'true'])
  assert.equal(enabled.domQueries, true); assert.equal(enabled.renderer, 'webview')
  assert.throws(() => parseArgs([...input, '--dom-queries', 'true']), /CLI \+ WebView/)
  assert.throws(() => parseArgs([...input, '--server-kind', 'cli', '--renderer', 'skia', '--dom-queries', 'true']), /CLI \+ WebView/)
  for (const value of ['yes', '1', 'TRUE', '']) assert.throws(() => parseArgs([...input, '--server-kind', 'cli', '--dom-queries', value]))
  assert.throws(() => parseArgs([...input, '--dom-queries']), /missing value/)
  assert.throws(() => parseArgs([...input, '--dom-queries', 'false', '--dom-queries', 'true']), /Duplicate/)
  assert.deepEqual(smokeFixture('cli'), smokeFixture('cli', 'webview', false, false))
  assert.doesNotMatch(smokeFixture('cli').files['pages/home/index.js'], /createSelectorQuery|__domQueries/)
  assert.equal(smokeFixture('cli').queryStateQuery, undefined)
  assert.deepEqual(smokeFixture('cli', 'webview', false, true).queryStateQuery,
    { moduleId: 'module:browser-dev-smoke-state.js', export: 'browserDevSmokeQueryState', args: [] }, 'DOM state reads must use the public helper catalog module ID')
  assert.throws(() => parseArgs([...input, '--server-kind', 'cli', '--renderer', 'skia', '--context-recovery', 'true', '--dom-queries', 'true']), /CLI \+ WebView/)
  assert.throws(() => parseArgs([...input, '--server-kind', 'cli', '--context-recovery', 'true', '--dom-queries', 'true']), /requires Skia/)
  assert.throws(() => smokeFixture('example', 'webview', false, true), /CLI \+ WebView/)
  assert.throws(() => smokeFixture('cli', 'skia', false, true), /CLI \+ WebView/)
  assert.throws(() => smokeFixture('cli', 'webview', false, 'true'))
})

test('serialized DOM polling and final evidence reads execute the supplied catalog query against current AppService state', async () => {
  const fixture = smokeFixture('cli', 'webview', false, true), calls = [], exports = {}
  const page = { route: fixture.route, data: { ...fixture.data, queryStatus: 'pending' }, __domQueries: { timerFired: false, results: [], errors: [] } }
  assert.doesNotMatch(fixture.files['app.js'], /exports|browserDevSmoke/, 'Query probes must not rely on bundled entry exports')
  runInNewContext(fixture.files['public/browser-dev-smoke-state.js'], { exports, getCurrentPages: () => [page] })
  const owner = { workerEpoch: 'query-epoch', sessionId: 'query-session' }, ownerKey = { activationId: '1', ownerSerial: '2', clientOwnerId: 'query-owner' }
  const accepted = { kind: 'observed-dom-final', value: { owner } }, audit = { version: '1.0', wire: [] }
  const manager = { executing: { owner, ownerKey }, history: [accepted,
    { kind: 'accepted-proof', value: { proof: { owner: { ...owner, sessionId: 'stale-session' } } } }] }
  const window = { __browserDevDomSurface: { current: () => ({ observation: accepted }) }, __browserDevSmokeAudit: { read: () => ({ domQueries: audit }) }, weappContainerDev: { status: { manager }, async request(value) {
    calls.push(value)
    if (value.payload.moduleId !== 'module:browser-dev-smoke-state.js') throw Object.assign(new Error(`module ${value.payload.moduleId} is not loaded`), { code: 'ERR_MODULE_LOAD' })
    return { stale: false, result: { ok: true, result: [exports[value.payload.export](...value.payload.args)] } }
  } } }
  const read = input => runInNewContext(`(${readDomQuerySmokeState.toString()})(input)`, { window, input })
  assert.equal(await read({ query: fixture.queryStateQuery, label: 'startup', cycle: 1 }), null, 'Polling cannot fabricate callbacks or timer completion')
  page.__domQueries.timerFired = true; page.__domQueries.results.push({ label: 'startup' }); page.data.queryStatus = 'startup 1'
  const polled = await read({ query: fixture.queryStateQuery, label: 'startup', cycle: 1 })
  assert.equal(polled.state.queryStatus, 'startup 1'); assert.equal(polled.state.query.results.length, 1)
  page.data.count = 8
  const final = await read({ query: fixture.queryStateQuery })
  assert.equal(final.state.count, 8); assert.equal(final.state.marker, fixture.data.marker); assert.equal(final.state.route, fixture.route)
  assert.equal(final.audit, audit); assert.equal(final.accepted, accepted, 'Final evidence must use the matching actual owner')
  assert.equal(calls.length, 3)
  for (const value of calls) {
    assert.equal(value.ownerKey, ownerKey); assert.equal(value.op, 'module.call'); assert.equal(value.payload, fixture.queryStateQuery)
  }
  await assert.rejects(read({ query: { ...fixture.queryStateQuery, moduleId: 'app.js' } }), { code: 'ERR_MODULE_LOAD' })
})

test('serialized DOM state reads reject stale bridge results and actual query errors', async () => {
  const fixture = smokeFixture('cli', 'webview', false, true), responses = [null,
    { stale: true, result: { ok: true, result: [{}] } }, { result: { ok: false, result: [{}] } },
    { result: { ok: true, result: [] } }, { result: { ok: true, result: [{}, {}] } }, { result: { ok: true, result: 'state' } }]
  for (const response of responses) {
    const window = { weappContainerDev: { status: { manager: { executing: { owner: {}, ownerKey: {} } } }, request: async () => response } }
    await assert.rejects(runInNewContext(`(${readDomQuerySmokeState.toString()})(input)`, { window, input: { query: fixture.queryStateQuery } }), /Actual query fixture state read failed/)
  }
  const window = { weappContainerDev: { status: { manager: { executing: { owner: {}, ownerKey: {} } } },
    request: async () => ({ result: { ok: true, result: [{ query: { errors: [{ code: 'ERR_CANCELLED' }] } }] } }) } }
  await assert.rejects(runInNewContext(`(${readDomQuerySmokeState.toString()})(input)`, { window, input: { query: fixture.queryStateQuery } }), /Actual wx query failed.*ERR_CANCELLED/)
})

// Run the emitted fixture against each real production facade in a Node realm.
// Native result completion is explicit; no stub query calls the callback early.
function queryFixtureRealm(engine) {
  const { run } = createAppServiceTestRealm(engine)
  const fixture = smokeFixture('cli', 'webview', false, true)
  run(`__container_set_dom_query_contract({version:'1.0',enabled:true});`)
  run(fixture.files[`${fixture.route}.js`])
  run(`__container_set_current_pages([0], [{ index: 0, instanceId: 41, route: ${JSON.stringify(fixture.route)} }]);
    globalThis.fixturePage = __container_page_instances['41'];
    Object.assign(fixturePage.data, ${JSON.stringify(fixture.data)});
    globalThis.exports = {};
  `)
  run(fixture.files['app.js'])
  run(fixture.files['public/browser-dev-smoke-state.js'])
  const json = source => JSON.parse(run(`JSON.stringify(${source})`))
  const checkpoint = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
  const requests = () => json(`__container_events.filter(value => value.type === 'api.call' && value.name === 'wx.createSelectorQuery')`)
  return { fixture, run, json, requests, checkpoint }
}

for (const engine of ['quickjs', 'v8']) test(`${engine}: DOM fixture startup stays asynchronous, timer runs while pending and nested query inherits callback owner`, async () => {
  const { fixture, run, json, requests, checkpoint } = queryFixtureRealm(engine)
  assert.match(fixture.files[`${fixture.route}.wxml`], /id="tap".*margin-left:\{\{count === 7 \? 0 : 37\}\}px/)
  assert.match(fixture.files[`${fixture.route}.wxml`], /bindtap="measureTap"/)
  assert.match(fixture.files[`${fixture.route}.wxml`], /id="query-status"/)
  run(`__container_invoke_page_instance(41, 0, 'onLoad', [])`)
  assert.deepEqual(json('fixturePage.__domQueries.log'), ['onLoad-enter', 'onLoad-return'])
  assert.deepEqual(json('fixturePage.__domQueries.results'), [])
  assert.equal(run('fixturePage.data.queryStatus'), 'pending')
  const first = requests()[0]
  assert.deepEqual(first.owner, { pageId: '41', scopeId: null })
  assert.deepEqual(first.options.queries.map(value => [value.selector, value.target, value.operation]), [
    ['#tap', 'node', 'boundingClientRect'], [null, 'viewport', 'scrollOffset'],
  ])
  run('__container_timer_begin(Date.now(), 10); __container_timer_task(); __container_timer_end();')
  assert.equal(run('fixturePage.__domQueries.timerFired'), true)
  assert.deepEqual(json('fixturePage.__domQueries.results'), [], 'a timer turn cannot fabricate a query completion')
  const measured = [{ id: 'tap', left: 24, top: 240, width: 240, height: 56 }, { scrollLeft: 0, scrollTop: 0 }]
  run(`__container_resolve_api(${first.id}, ${JSON.stringify(measured)}, null)`)
  await checkpoint()
  assert.deepEqual(json('fixturePage.__domQueries.log'), ['onLoad-enter', 'onLoad-return', 'timer', 'startup:first'])
  assert.equal(requests().length, 2)
  const nested = requests()[1]
  assert.deepEqual(nested.owner, first.owner, 'nested builder has no explicit .in and must inherit the real callback owner')
  assert.deepEqual(nested.options, first.options)
  assert.deepEqual(json('fixturePage.__domQueries.results'), [], 'first callback cannot report success without the second real completion')
  assert.equal(run('fixturePage.data.queryStatus'), 'pending')
  run(`__container_resolve_api(${nested.id}, ${JSON.stringify(measured)}, null)`)
  await checkpoint()
  const state = json('exports.browserDevSmokeQueryState()')
  assert.equal(state.fixture, 'browser-dev-loop-dom-queries-v1')
  assert.equal(state.route, fixture.route); assert.equal(state.count, 7)
  assert.equal(state.queryStatus, 'startup 1')
  assert.deepEqual(state.query.errors, [])
  assert.equal(state.query.results.length, 1)
  assert.equal(state.query.results[0].callbackPageCurrent, true)
  assert.equal(state.query.results[0].completionPageCurrent, true)
  assert.deepEqual(state.query.results[0].first, measured)
  assert.deepEqual(state.query.results[0].nested, measured)
  assert.equal(run('__container_capture_api_owner()'), null)
  run(`__container_invoke_page_instance(41, 0, 'increment', []); __container_invoke_page_instance(41, 0, 'measureTap', []);`)
  assert.equal(run('fixturePage.data.count'), 8)
  assert.equal(requests().length, 3)
  assert.deepEqual(requests()[2].owner, first.owner)
})

function workerAuditRealm(domQueries = false) {
  const context = createContext({ structuredClone, TextEncoder, performance: { now: () => 0 } })
  const run = source => runInContext(source, context)
  run(`globalThis.top = globalThis;
    globalThis.Worker = class Worker {
      constructor(url, options) { this.url = url; this.options = options; this.listeners = []; this.sent = []; this.terminated = false; }
      addEventListener(name, callback) { if (name === 'message') this.listeners.push(callback); }
      postMessage(message) { this.sent.push(structuredClone(message)); return 'native-send'; }
      terminate() { this.terminated = true; return 'native-terminate'; }
      emit(message) { for (const callback of this.listeners) callback({ data: message }); }
    };
    (${installWorkerAudit.toString()})({domQueries:${domQueries}});
    globalThis.worker = new Worker('https://fixed.test/runtime-worker.mjs', {name:'test-native-worker'});
  `)
  const read = () => run('globalThis.__browserDevSmokeAudit.read()')
  return { run, read }
}
const queryKey = () => ({ sessionId: 'query-session', pageId: '41', documentRevision: '1', presentationRevision: '1', surfaceGeneration: '1', profile: 'webview' })
const queryMessage = (op, payload, requestId = 'inner-query', kind = 'request') => ({ protocolVersion: '1.0', sessionId: 'query-session', requestId, kind, op, payload })
const workerWire = (op, payload, requestId = 'outer-query', kind = 'request') => ({ version: '1.0', workerEpoch: 'query-epoch', sessionId: 'query-session', requestId, kind, op, payload })

test('Worker query audit captures actual envelope, event batch and native final without changing delegation', () => {
  const { run, read } = workerAuditRealm(true), key = queryKey()
  const original = { version: '1.0', requestId: 'dom-query:1', key, afterEpoch: '4', deadlineNs: '99', occurrenceIds: ['tap-occurrence'] }
  const request = workerWire('batch', { messages: [queryMessage('view.query.request', original, '', 'event')] }, 'worker-event-1', 'event')
  run(`worker.emit(${JSON.stringify(request)})`)
  const observation = queryMessage('view.query.result', { version: '1.0', requestId: 'dom-query:1', key,
    geometry: { version: '1.0', key, epoch: '5', viewport: { width: 414, height: 736 }, nodes: [] }, viewportScroll: { x: 0, y: 0 } })
  assert.equal(run(`worker.postMessage(${JSON.stringify(workerWire('bridge', { envelope: observation }))})`), 'native-send')
  const final = queryMessage('view.query.result', { ok: true, requestId: 'dom-query:1' }, observation.requestId, 'response')
  run(`worker.emit(${JSON.stringify(workerWire('bridge', { status: 'ok', result: { messages: [final] } }, 'outer-query', 'response'))})`)
  const audit = read()
  assert.deepEqual(Array.from(audit.domQueries.wire, value => [value.direction, value.message.op, value.message.kind]), [
    ['receive', 'view.query.request', 'event'], ['send', 'view.query.result', 'request'], ['receive', 'view.query.result', 'response'],
  ])
  assert.deepEqual(audit.domQueries.wire[0].message.payload, original)
  assert.equal(audit.domQueries.wire[2].outerStatus, 'ok')
  assert.ok(audit.domQueries.wire.every(value => value.id === 'worker-1' && value.workerEpoch === 'query-epoch' && value.sessionId === 'query-session'))
  assert.equal(audit.domQueries.dropped, 0)
  audit.domQueries.wire[0].message.payload.afterEpoch = 'mutated-copy'
  assert.equal(read().domQueries.wire[0].message.payload.afterEpoch, '4')
  assert.equal(run('worker.sent.length'), 1)
  assert.equal(run('worker.terminate()'), 'native-terminate')
  assert.equal(run('worker.terminated'), true)
  assert.equal(read().events.filter(value => value.kind === 'terminate').length, 1)
})

test('query audit keeps raw finite prepare geometry while non-query events cannot leak arbitrary application detail', () => {
  const { run, read } = workerAuditRealm(true), key = queryKey(), nodes = [{ occurrenceId: 'tap-occurrence', borderBox: { x: 24, y: 240, width: 240, height: 56 } }]
  const geometry = queryMessage('view.prepare.commit', { version: '1.0', key, epoch: '4', viewport: { width: 414, height: 736 }, nodes })
  run(`worker.postMessage(${JSON.stringify(workerWire('bridge', { batch: { messages: [geometry] } }))})`)
  const events = queryMessage('view.events', { version: '1.0', key, epoch: '4', events: [{ detail: { privateField: 'must-not-retain' } }] })
  run(`worker.postMessage(${JSON.stringify(workerWire('bridge', { envelope: events }))})`)
  const retained = read().domQueries
  assert.deepEqual(retained.wire[0].message.payload.nodes, nodes)
  assert.equal(JSON.stringify(retained).includes('must-not-retain'), false)
  const disabled = workerAuditRealm()
  disabled.run(`worker.postMessage(${JSON.stringify(workerWire('bridge', { envelope: geometry }))})`)
  assert.equal(disabled.read().domQueries, undefined)
})

test('query audit retains exact bounded native permit metadata and original batch indices without leaking private payloads', () => {
  const h = workerAuditRealm(true), key = queryKey()
  const permit = { version: '1.0', key, epoch: '1', permitId: 'native-permit' }
  const privatePermit = { ...permit, privateToken: 'must-not-retain', key: { ...key, privateToken: 'must-not-retain' } }
  const native = workerWire('bridge', { status: 'ok', result: { messages: [
    queryMessage('diagnostic', { privateToken: 'must-not-retain' }, 'ignored', 'event'),
    queryMessage('view.prepare.commit', { ok: true, permit: privatePermit, privateToken: 'must-not-retain' }, 'prepare-commit', 'response'),
    queryMessage('view.presented', { ok: true, key, inputEnabled: true }, 'presented', 'response'),
  ] } }, 'original-native-turn', 'response')
  h.run(`worker.emit(${JSON.stringify(native)})`)
  const sent = workerWire('bridge', { envelope: queryMessage('view.presented', privatePermit, 'presented') }, 'original-present-turn')
  assert.equal(h.run(`worker.postMessage(${JSON.stringify(sent)})`), 'native-send')
  const wire = h.read().domQueries.wire
  assert.deepEqual(wire[0].message.payload, { ok: true, permit })
  assert.deepEqual(wire[2].message.payload, permit)
  assert.deepEqual(Array.from(wire, fact => fact.messageIndex), [1, 2, 0])
  assert.equal(wire[0].message.requestId, 'prepare-commit'); assert.equal(wire[0].outerRequestId, 'original-native-turn')
  assert.equal(h.run('worker.sent.length'), 1)
  assert.equal(JSON.stringify(wire).includes('must-not-retain'), false)
})

test('query audit independently bounds message, retained byte and total message counts and records loss', () => {
  const single = workerAuditRealm(true)
  const oversized = queryMessage('view.query.request', { diagnostic: 'x'.repeat(256 * 1024) })
  single.run(`worker.emit(${JSON.stringify(workerWire('batch', { messages: [oversized] }, 'worker-event-1', 'event'))})`)
  assert.equal(single.read().domQueries.wire.length, 0)
  assert.equal(single.read().domQueries.dropped, 1)
  const count = workerAuditRealm(true), message = queryMessage('view.query.enable', { ok: true, version: '1.0', scope: 'session', enabled: true, key: null }, 'enable', 'response')
  count.run(`for (let i = 0; i < 513; i++) worker.emit(${JSON.stringify(workerWire('batch', { messages: [message] }, 'worker-event-2', 'event'))})`)
  assert.equal(count.read().domQueries.wire.length, 512)
  assert.equal(count.read().domQueries.dropped, 1)
  const bytes = workerAuditRealm(true), large = queryMessage('view.query.request', { diagnostic: 'x'.repeat(180 * 1024) })
  bytes.run(`for (let i = 0; i < 12; i++) worker.emit(${JSON.stringify(workerWire('batch', { messages: [large] }, 'worker-event-3', 'event'))})`)
  const audit = bytes.read().domQueries
  assert.ok(audit.retainedBytes <= 2 * 1024 * 1024)
  assert.ok(audit.wire.length < 12); assert.ok(audit.dropped > 0)
})

function domQueryEvidenceFixture({ tap = false, perturb = false, inputEpoch = 4 } = {}) {
  const owner = { workerEpoch: 'query-epoch', sessionId: 'query-session', packSha256: 'a'.repeat(64), transportBackend: 'browser-view' }
  const route = 'pages/home/index', viewport = { width: 414, height: 736 }, label = tap ? 'tap' : 'startup', cycle = tap ? 2 : 1, expectedCount = tap ? 8 : 7
  const key = queryKey(), rect = { left: 24 + (tap ? 37 : 0) + (perturb ? 13 : 0), top: 240, width: 240, height: 56 }
  const scroll = { x: 0, y: 0 }, extent = { width: 800, height: 1200 }, callback = [{ id: 'tap', ...rect },
    { id: '', dataset: {}, scrollLeft: 0, scrollTop: 0, scrollWidth: extent.width, scrollHeight: extent.height }]
  let sequence = 0
  const wire = []
  const add = (direction, message) => {
    const fact = { sequence: ++sequence, messageIndex: 0, id: 'worker-1', direction, at: sequence, workerEpoch: owner.workerEpoch, sessionId: owner.sessionId,
      outerRequestId: `outer-${sequence}`, outerOp: direction === 'send' ? 'bridge' : 'batch', outerStatus: direction === 'send' ? null : 'ok', message }
    if (direction === 'receive' && message.kind === 'response') {
      const request = wire.findLast(value => value.direction === 'send' && value.message.requestId === message.requestId && value.message.op === message.op)
      if (request) { fact.outerRequestId = request.outerRequestId; fact.outerOp = 'bridge' }
    }
    wire.push(fact); return fact
  }
  add('receive', queryMessage('view.query.enable', { ok: true, version: '1.0', scope: 'session', enabled: true, key: null }, 'enable', 'response'))
  const inputGeometry = { version: '1.0', key: structuredClone(key), epoch: String(inputEpoch), viewport: { ...viewport },
    nodes: [{ occurrenceId: 'tap-occurrence', borderBox: { x: rect.left - (perturb ? 13 : 0), y: rect.top, width: rect.width, height: rect.height } }] }
  const permit = { version: '1.0', key: structuredClone(key), epoch: String(inputEpoch), permitId: 'native-input-permit' }
  add('send', queryMessage('view.prepare.commit', structuredClone(inputGeometry), 'prepare-input'))
  add('receive', queryMessage('view.prepare.commit', { ok: true, permit: structuredClone(permit) }, 'prepare-input', 'response'))
  add('send', queryMessage('view.presented', structuredClone(permit), 'presented'))
  add('receive', queryMessage('view.presented', { ok: true, inputEnabled: true, key }, 'presented', 'response'))
  let previousFinal
  for (let i = 0; i < cycle * 2; i++) {
    const requestId = `dom-query:${i + 1}`, innerId = `query-result-${i + 1}`
    const request = add('receive', queryMessage('view.query.request', { version: '1.0', requestId, key, afterEpoch: String(inputEpoch + i), deadlineNs: '99', occurrenceIds: ['tap-occurrence'], includeViewportExtent: true }, '', 'event'))
    if (previousFinal) { request.outerRequestId = previousFinal.outerRequestId; request.outerOp = previousFinal.outerOp; request.messageIndex = 1 }
    add('send', queryMessage('view.query.result', { version: '1.0', requestId, key, geometry: { version: '1.0', key, epoch: String(inputEpoch + i + 1),
      viewport: { ...viewport }, nodes: [{ occurrenceId: 'tap-occurrence', borderBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } }] }, viewportScroll: scroll, viewportExtent: extent }, innerId))
    previousFinal = add('receive', queryMessage('view.query.result', { ok: true, requestId }, innerId, 'response'))
  }
  const result = { label, count: expectedCount, first: structuredClone(callback), nested: structuredClone(callback), callbackPageCurrent: true, completionPageCurrent: true }
  const state = { fixture: 'browser-dev-loop-dom-queries-v1', route, count: expectedCount, queryStatus: `${label} ${cycle}`, query: {
    errors: [], timerFired: true, results: tap ? [{ ...structuredClone(result), label: 'startup', count: 7 }, result] : [result],
    log: ['onLoad-enter', 'onLoad-return', 'timer', 'startup:first', 'startup:nested', ...(tap ? ['tap:first', 'tap:nested'] : [])],
  } }
  const callbackKey = { ...key, documentRevision: '2', presentationRevision: '2' }
  const consumedInput = { routePath: route, pageId: key.pageId, templateRevision: '2', viewport: { x: 0, y: 0, ...viewport } }
  const nativePreparation = { requestId: 'callback-prepare', key: structuredClone(callbackKey), scheduling: { version: '1.0', key: structuredClone(callbackKey), consumedInput: structuredClone(consumedInput) } }
  const nativeFinal = { requestId: 'callback-presented', key: structuredClone(callbackKey), inputEnabled: true }
  add('receive', queryMessage('view.prepare', { ok: true, ...structuredClone(nativePreparation) }, nativePreparation.requestId, 'response'))
  add('receive', queryMessage('view.presented', { ok: true, ...structuredClone(nativeFinal) }, nativeFinal.requestId, 'response'))
  const accepted = { kind: 'observed-dom-final', value: { owner, key: structuredClone(callbackKey), consumedInput, nativePreparation, nativeFinal } }
  const oracle = { rect, scroll, extent, ...(perturb ? { perturbation: { translateX: 13, before: { ...rect, left: rect.left - 13 }, key } } : {}) }
  const value = { audit: { version: '1.0', dropped: 0, retainedBytes: 4096, wire }, state, oracle, accepted }
  return { value, expected: { owner, route, viewport, label, cycle, expectedCount } }
}
const firstQuerySample = value => value.audit.wire.find(fact => fact.direction === 'send' && fact.message.op === 'view.query.result').message.payload

test('DOM evidence binds real queries to ACK, two native completions, browser geometry and later accepted callback frame', () => {
  for (const flags of [{}, { tap: true }, { tap: true, perturb: true }]) {
    const { value, expected } = domQueryEvidenceFixture(flags)
    const observed = assertDomQueryEvidence(value, expected)
    assert.equal(observed.exchanges.length, 2); assert.equal(observed.inputGeometryWireStable, true)
    assert.equal(observed.inputEpochUnchanged, undefined)
    assert.equal(observed.callbackAccepted, value.accepted)
  }
  const reordered = domQueryEvidenceFixture()
  const observation = reordered.value.audit.wire.find(value => value.direction === 'send' && value.message.op === 'view.query.result').message.payload
  observation.key = Object.fromEntries(Object.entries(observation.key).reverse())
  observation.geometry.key = Object.fromEntries(Object.entries(observation.geometry.key).reverse())
  assert.doesNotThrow(() => assertDomQueryEvidence(reordered.value, reordered.expected), 'key field insertion order is not semantic identity')
})

test('DOM evidence accepts startup ACK after its query request and duplicate unchanged input geometry', () => {
  const { value, expected } = domQueryEvidenceFixture(), wire = value.audit.wire
  const [ack] = wire.splice(wire.findIndex(value => value.direction === 'receive' && value.message.op === 'view.presented'), 1)
  const firstRequestIndex = wire.findIndex(value => value.message.op === 'view.query.request')
  wire[firstRequestIndex].outerRequestId = ack.outerRequestId
  wire[firstRequestIndex].outerOp = ack.outerOp
  ack.messageIndex = 1
  const admitted = wire.find(fact => fact.message.op === 'view.prepare.commit').message.payload
  const duplicate = { ...wire[0], direction: 'send', outerRequestId: 'duplicate-input-turn', outerOp: 'bridge', outerStatus: null,
    message: queryMessage('view.geometry', structuredClone(admitted), 'duplicate-geometry') }
  const completed = { ...duplicate, direction: 'receive', outerStatus: 'ok',
    message: queryMessage('view.geometry', { ok: true }, 'duplicate-geometry', 'response') }
  wire.splice(firstRequestIndex + 1, 0, ack, duplicate, completed)
  wire.forEach((fact, index) => { fact.sequence = index + 1 })
  assert.doesNotThrow(() => assertDomQueryEvidence(value, expected),
    'a same-batch startup ACK and same-key/same-epoch geometry do not advance admitted input')
})

function insertQueryInputReplay(value, { afterNestedRequest = false } = {}) {
  const wire = value.audit.wire, requests = wire.filter(fact => fact.message.op === 'view.query.request')
  const index = wire.indexOf(requests[afterNestedRequest ? 1 : 0]) + 1
  const admitted = wire.find(fact => fact.message.op === 'view.prepare.commit').message.payload
  const source = wire[0], request = { ...source, direction: 'send', outerRequestId: 'input-replay-turn', outerOp: 'bridge', outerStatus: null,
    messageIndex: 0, message: queryMessage('view.geometry', structuredClone(admitted), 'input-replay') }
  const final = { ...request, direction: 'receive', outerStatus: 'ok', message: queryMessage('view.geometry', { ok: true }, 'input-replay', 'response') }
  wire.splice(index, 0, request, final); wire.forEach((fact, position) => { fact.sequence = position + 1 })
  return { request, final }
}

test('native G1 stays wire-stable while successful M2 schedules a nested afterEpoch2 and an independent G1 replay', () => {
  const { value, expected } = domQueryEvidenceFixture({ inputEpoch: 1 })
  insertQueryInputReplay(value, { afterNestedRequest: true })
  const proof = assertDomQueryEvidence(value, expected)
  assert.equal(proof.inputGeometryWireStable, true); assert.equal(proof.inputEpochUnchanged, undefined)
  assert.deepEqual(proof.measurementWatermarks.map(({ inputEpoch, previousMeasurementEpoch, afterEpoch, measuredEpoch }) =>
    ({ inputEpoch, previousMeasurementEpoch, afterEpoch, measuredEpoch })), [
    { inputEpoch: '1', previousMeasurementEpoch: '0', afterEpoch: '1', measuredEpoch: '2' },
    { inputEpoch: '1', previousMeasurementEpoch: '2', afterEpoch: '2', measuredEpoch: '3' },
  ])
  assert.equal(proof.idempotentInputReplays.length, 1)
})

test('nested request may be observed before the first native final only within that exact original atomic Worker turn', () => {
  const { value, expected } = domQueryEvidenceFixture(), wire = value.audit.wire
  const finalIndex = wire.findIndex(fact => fact.direction === 'receive' && fact.message.op === 'view.query.result')
  const final = wire[finalIndex], request = wire[finalIndex + 1]
  assert.equal(request.message.op, 'view.query.request')
  wire.splice(finalIndex, 2, request, final); request.messageIndex = 0; final.messageIndex = 1
  wire.forEach((fact, position) => { fact.sequence = position + 1 })
  assert.doesNotThrow(() => assertDomQueryEvidence(value, expected))
  request.outerRequestId = 'unrelated-later-turn'
  assert.throws(() => assertDomQueryEvidence(value, expected))
})

test('a genuine pre-query input update sets G independently of M and still uses an exact max watermark', () => {
  const { value, expected } = domQueryEvidenceFixture(), wire = value.audit.wire
  const input = structuredClone(wire.find(fact => fact.message.op === 'view.prepare.commit').message.payload)
  input.epoch = '10'
  const index = wire.findIndex(fact => fact.message.op === 'view.query.request'), source = wire[0]
  const update = { ...source, direction: 'send', outerRequestId: 'before-query-input', outerOp: 'bridge', outerStatus: null,
    message: queryMessage('view.geometry', input, 'before-query-input') }
  wire.splice(index, 0, update, { ...update, direction: 'receive', outerStatus: 'ok', message: queryMessage('view.geometry', { ok: true }, 'before-query-input', 'response') })
  wire.filter(fact => fact.message.op === 'view.query.request').forEach((fact, i) => { fact.message.payload.afterEpoch = String(10 + i) })
  wire.filter(fact => fact.direction === 'send' && fact.message.op === 'view.query.result').forEach((fact, i) => { fact.message.payload.geometry.epoch = String(11 + i) })
  wire.forEach((fact, position) => { fact.sequence = position + 1 })
  const proof = assertDomQueryEvidence(value, expected)
  assert.deepEqual(proof.measurementWatermarks.map(value => value.inputEpoch), ['10', '10'])
  assert.deepEqual(proof.measurementWatermarks.map(value => value.afterEpoch), ['10', '11'])
})

test('G/M proof rejects unconfirmed authority, changed input replays, wrong native turns and ambiguous batch order', async t => {
  const cases = [
    ['missing prepare geometry', value => { value.audit.wire = value.audit.wire.filter(fact => fact.message.op !== 'view.prepare.commit') }],
    ['missing native permit', value => { delete value.audit.wire.find(fact => fact.direction === 'receive' && fact.message.op === 'view.prepare.commit').message.payload.permit }],
    ['unmatched permit identity', value => { value.audit.wire.find(fact => fact.direction === 'receive' && fact.message.op === 'view.prepare.commit').message.payload.permit.permitId = 'another' }],
    ['unmatched permit epoch', value => { value.audit.wire.find(fact => fact.direction === 'receive' && fact.message.op === 'view.prepare.commit').message.payload.permit.epoch = '9' }],
    ['unmatched presented request', value => { value.audit.wire.find(fact => fact.direction === 'send' && fact.message.op === 'view.presented').message.requestId = 'another' }],
    ['unrelated late ACK cannot authorize an earlier query', value => {
      const wire = value.audit.wire, [ack] = wire.splice(wire.findIndex(fact => fact.direction === 'receive' && fact.message.op === 'view.presented'), 1)
      wire.splice(wire.findIndex(fact => fact.message.op === 'view.query.request') + 1, 0, ack)
      wire.forEach((fact, index) => { fact.sequence = index + 1 })
    }],
    ['queued native prepare final', value => { value.audit.wire.find(fact => fact.direction === 'receive' && fact.message.op === 'view.prepare.commit').message.payload.queued = true }],
    ['prior native final from another Worker', value => { value.audit.wire.find(fact => fact.direction === 'receive' && fact.message.op === 'view.query.result').id = 'worker-2' }],
    ['prior native final from unrelated outer turn', value => { value.audit.wire.find(fact => fact.direction === 'receive' && fact.message.op === 'view.query.result').outerRequestId = 'unrelated-turn' }],
    ['prior native final outer failure', value => { value.audit.wire.find(fact => fact.direction === 'receive' && fact.message.op === 'view.query.result').outerStatus = 'error' }],
    ['missing original message index', value => { delete value.audit.wire[0].messageIndex }],
    ['conflicting native batch index', value => { value.audit.wire.filter(fact => fact.message.op === 'view.query.request')[1].messageIndex = 0 }],
    ['input replay has no native final', value => { const { final } = insertQueryInputReplay(value); value.audit.wire.splice(value.audit.wire.indexOf(final), 1) }],
    ['input replay rejected', value => { insertQueryInputReplay(value).final.message.payload.ok = false }],
    ['input epoch changed even with unchanged boxes', value => { insertQueryInputReplay(value, { afterNestedRequest: true }).request.message.payload.epoch = '5' }],
    ['same input epoch changed boxes', value => { insertQueryInputReplay(value).request.message.payload.nodes[0].borderBox.x += 1 }],
    ['input replay changed owner key', value => { insertQueryInputReplay(value).request.message.payload.key.pageId = '99' }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const { value, expected } = domQueryEvidenceFixture(); mutate(value)
    assert.throws(() => assertDomQueryEvidence(value, expected), name)
  })
})

test('original failed query observation is persisted before assertions and a failed write cannot become a proof', async () => {
  const { value, expected } = domQueryEvidenceFixture(), captured = []
  value.audit.dropped = 1
  await assert.rejects(captureAndAssertDomQueryEvidence(value, expected, async raw => { captured.push(structuredClone(raw)) }),
    /Expected values to be strictly equal/)
  assert.equal(captured.length, 1); assert.equal(captured[0].kind, 'unverified-dom-query-observation')
  assert.deepEqual(captured[0].observed, value); assert.deepEqual(captured[0].expected, expected)
  assert.equal(captured[0].observed.audit.dropped, 1)
  const writeFailure = new Error('Original evidence write failed')
  await assert.rejects(captureAndAssertDomQueryEvidence(null, null, async () => { throw writeFailure }), error => error === writeFailure)
  const valid = domQueryEvidenceFixture()
  assert.equal((await captureAndAssertDomQueryEvidence(valid.value, valid.expected, async raw => {
    assert.equal(raw.observed, valid.value)
  })).inputGeometryWireStable, true)
})

test('DOM evidence rejects incomplete, stale or ambiguous success claims', async t => {
  const cases = [
    ['missing explicit viewport extent request', value => { delete value.audit.wire.find(fact => fact.message.op === 'view.query.request').message.payload.includeViewportExtent }],
    ['missing viewport extent', value => { delete firstQuerySample(value).viewportExtent }],
    ['forged viewport extent', value => { firstQuerySample(value).viewportExtent.height += 1 }],
    ['wrong independent viewport extent oracle', value => { value.oracle.extent.width += 1 }],
    ['missing enable', value => { value.audit.wire = value.audit.wire.filter(value => value.message.op !== 'view.query.enable') }],
    ['missing ACK', value => { value.audit.wire = value.audit.wire.filter(value => value.message.op !== 'view.presented') }],
    ['ACK input disabled', value => { value.audit.wire.find(value => value.message.op === 'view.presented').message.payload.inputEnabled = false }],
    ['missing native result', value => { value.audit.wire = value.audit.wire.filter(value => !(value.direction === 'receive' && value.message.op === 'view.query.result')) }],
    ['native wrong correlation', value => { value.audit.wire.find(value => value.direction === 'receive' && value.message.op === 'view.query.result').message.requestId = 'another-request' }],
    ['native rejects', value => { value.audit.wire.find(value => value.direction === 'receive' && value.message.op === 'view.query.result').message.payload.ok = false }],
    ['wrong result key', value => { const payload = firstQuerySample(value); payload.key = { ...payload.key, pageId: '99' } }],
    ['wrong worker owner', value => { value.audit.wire.forEach(value => { value.workerEpoch = 'another-worker' }) }],
    ['expired measurement epoch', value => { firstQuerySample(value).geometry.epoch = '4' }],
    ['query ignores prior successful measurement', value => { value.audit.wire.filter(value => value.message.op === 'view.query.request')[1].message.payload.afterEpoch = '4' }],
    ['query invents future measurement watermark', value => { value.audit.wire.filter(value => value.message.op === 'view.query.request')[1].message.payload.afterEpoch = '6' }],
    ['nested callback before first browser result delivery', value => { value.audit.wire.filter(value => value.message.op === 'view.query.request')[1].sequence = 3 }],
    ['ambiguous geometry update', value => { value.audit.wire.push({ ...value.audit.wire[0], direction: 'send', outerOp: 'bridge', outerStatus: null,
      sequence: 4.5, message: queryMessage('view.geometry', { key: queryKey(), epoch: '7' }) }) }],
    ['wrong browser oracle', value => { value.oracle.rect.left += 20 }],
    ['missing matched occurrence', value => { firstQuerySample(value).geometry.nodes = [] }],
    ...['width', 'height'].map(name => [`wrong query viewport ${name}`, value => {
      firstQuerySample(value).geometry.viewport[name] += 1
    }]),
    ...['x', 'y'].map(name => [`unexpected query viewport ${name}`, value => {
      firstQuerySample(value).geometry.viewport[name] = 0
    }]),
    ...['x', 'y', 'width', 'height'].map(name => [`wrong node border box ${name}`, value => {
      firstQuerySample(value).geometry.nodes[0].borderBox[name] += 2
    }]),
    ['callback missing nested value', value => { delete value.state.query.results[0].nested }],
    ['callback owner changed', value => { value.state.query.results[0].callbackPageCurrent = false }],
    ['callback repeats', value => { value.state.query.log.push('startup:nested') }],
    ['sync fake query success', value => { value.state.query.log = ['onLoad-enter', 'startup:first', 'onLoad-return', 'startup:nested', 'timer'] }],
    ['timer never runs', value => { value.state.query.timerFired = false }],
    ['no accepted callback frame', value => { value.accepted = null }],
    ['callback only startup proof', value => { value.accepted.kind = 'accepted-proof' }],
    ['callback missing native preparation', value => { value.audit.wire = value.audit.wire.filter(fact => fact.message.op !== 'view.prepare') }],
    ['callback missing native ACK', value => { value.audit.wire = value.audit.wire.filter(fact => fact.message.requestId !== 'callback-presented') }],
    ['callback ACK before preparation', value => { value.audit.wire.find(fact => fact.message.requestId === 'callback-presented').sequence = 0 }],
    ['callback preparation wrong consumed input', value => { value.audit.wire.find(fact => fact.message.op === 'view.prepare').message.payload.scheduling.consumedInput.pageId = '99' }],
    ['callback frame never advances', value => { value.accepted.value.key.documentRevision = '1' }],
    ['accepted frame wrong owner', value => { value.accepted.value.owner = { ...value.accepted.value.owner, sessionId: 'another-session' } }],
    ...['sessionId', 'pageId', 'profile', 'surfaceGeneration'].map(name => [`accepted key wrong ${name}`, value => { value.accepted.value.key[name] = 'another' }]),
    ['accepted input wrong page', value => { value.accepted.value.consumedInput.pageId = '99' }],
    ...['x', 'y', 'width', 'height'].map(name => [`accepted input wrong viewport ${name}`, value => {
      value.accepted.value.consumedInput.viewport[name] += 1
    }]),
    ['audit discarded evidence', value => { value.audit.dropped = 1 }],
    ['audit exceeded byte budget', value => { value.audit.retainedBytes = 2 * 1024 * 1024 + 1 }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const { value, expected } = domQueryEvidenceFixture()
    mutate(value)
    assert.throws(() => assertDomQueryEvidence(value, expected), name)
  })
})

test('same-key freshness proof rejects missing cache, unchanged query coordinates or crossed presentation key', () => {
  for (const mutate of [
    value => { value.audit.wire = value.audit.wire.filter(value => value.message.op !== 'view.prepare.commit') },
    value => { value.oracle.perturbation.key = { ...value.oracle.perturbation.key, documentRevision: '99' } },
    value => { value.oracle.perturbation.translateX = 12 },
    value => { value.audit.wire.find(value => value.message.op === 'view.prepare.commit').message.payload.nodes[0].borderBox.x += 13 },
  ]) {
    const { value, expected } = domQueryEvidenceFixture({ tap: true, perturb: true })
    mutate(value); assert.throws(() => assertDomQueryEvidence(value, expected))
  }
})

test('compiler failure evidence labels observed AppService count separately from independently audited Worker lifetimes', () => {
  const observed = { fixture: 'browser-dev-loop-skia-v1', count: 8 }
  assert.deepEqual(retainedCompileFailureCount(observed, 8), { retainedAppCount: 8 })
  assert.throws(() => retainedCompileFailureCount({ ...observed, fixture: 'wrong' }, 8))
  assert.throws(() => retainedCompileFailureCount({ ...observed, count: 13 }, 8))
  assert.throws(() => retainedCompileFailureCount({ ...observed, count: NaN }, 8))
})

test('native prepare audit preserves only bounded key/input metadata and original response identity, never ViewDocument data', () => {
  const h = workerAuditRealm(true), key = queryKey(), consumedInput = { pageId: key.pageId, routePath: 'pages/home/index', templateRevision: '2', viewport: { x: 0, y: 0, width: 414, height: 736 } }
  const message = queryMessage('view.prepare', { ok: true, submission: { key, document: { privateTemplate: 'must-not-be-retained' } },
    scheduling: { version: '1.0', key, consumedInput, privateField: 'must-not-be-retained' } }, 'actual-prepare', 'response')
  h.run(`worker.emit(${JSON.stringify(workerWire('bridge', { status: 'ok', result: { messages: [message] } }, 'actual-outer', 'response'))})`)
  const audit = h.read(), trace = audit.traces[0]
  assert.equal(trace.direction, 'receive'); assert.equal(trace.op, 'bridge'); assert.equal(trace.kind, 'response'); assert.equal(trace.status, 'ok')
  assert.equal(trace.requestId, 'actual-outer')
  const expected = { requestId: 'actual-prepare', messageIndex: 0, key, scheduling: { version: '1.0', key, consumedInput } }
  assert.deepEqual(trace.domPreparations, [expected])
  const wire = audit.domQueries.wire[0]
  assert.equal(wire.message.op, 'view.prepare'); assert.equal(wire.message.kind, 'response'); assert.equal(wire.message.requestId, 'actual-prepare')
  assert.deepEqual(wire.message.payload, { ok: true, ...expected })
  assert.equal(JSON.stringify(audit).includes('must-not-be-retained'), false)
})
