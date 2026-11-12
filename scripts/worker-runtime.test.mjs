// Protocol/owner wiring tests use an injected finite fake host. These tests
// establish no QuickJS WASM, browser, renderer, or device acceptance evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkerRuntime, workerUnixNanos, WORKER_PACK_BUDGET, copyExternalFrameScheduling, copyExternalFrameTarget, copyExternalPresentationOutcome, copyOrderedObservation, copyRendererTransitionObservation, copyWorkerPresenterBinding, nextObservationU64, preflightSurfaceRecoveryRevisions } from '../examples/hosts/web-wasm/worker-runtime.mjs'
import { WorkerRpcClient, WORKER_EVENT_LIMITS, measureWorkerPayload, splitWorkerInputTiming } from '../examples/hosts/web-wasm/worker-session-client.mjs'

const BASE = 'https://worker.test/runtime-worker.mjs'
const HOME = 'pages/home/index'
const SECOND = 'pages/second/index'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))

async function until(predicate) {
  const end = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < end, 'owned test operation did not complete')
    await delay(2)
  }
}

function portablePack(assetCount = 0, manifestFields = {}, baseUrl = BASE) {
  const source = bytes('App({});')
  const hash = digest(source)
  const manifest = { schemaVersion: 1, protocolVersion: '1.0',
    compiler: { name: 'weapp-vite', commit: 'worker-owner-fixture', platform: 'weapp' },
    app: { appJson: 'app.json', entryModule: 'app.js' },
    routes: [HOME, SECOND].map(path => ({ id: `route:${path}`, path, kind: 'page', entryModule: `${path}.js` })),
    modules: [{ id: 'module:app.js', sha256: hash, format: 'commonjs', scope: 'app', dependencies: [] }],
    templates: [], styles: [], components: [],
    assets: Array.from({ length: assetCount }, (_, index) => ({ path: `assets/shared-${index}.bin`, sha256: hash, mime: 'application/octet-stream', size: source.length })),
    capabilities: {}, integrity: { algorithm: 'sha256', root: '' }, ...manifestFields }
  manifest.integrity.root = digest(bytes(canonical(manifest)))
  const manifestBytes = bytes(manifest)
  const index = { schemaVersion: 1, manifest: './manifest.json', manifestSha256: digest(manifestBytes), integrityRoot: manifest.integrity.root,
    blobs: [{ sha256: hash, size: source.length, url: `./blobs/${hash}` }] }
  const files = new Map([
    [new URL('./pack-index.json', baseUrl).href, bytes(index)],
    [new URL('./manifest.json', baseUrl).href, manifestBytes],
    [new URL(`./blobs/${hash}`, baseUrl).href, source],
  ])
  return { manifest, index, files, hash }
}

function distinctBlobs(pack, count, baseUrl = BASE) {
  for (let index = 1; index < count; index++) {
    const source = bytes(`distinct verified asset ${index}`), hash = digest(source)
    pack.manifest.assets.push({ path: `assets/${index}.bin`, sha256: hash, mime: 'application/octet-stream', size: source.length })
    pack.index.blobs.push({ sha256: hash, size: source.length, url: `./blobs/${hash}` })
    pack.files.set(new URL(`./blobs/${hash}`, baseUrl).href, source)
  }
  pack.manifest.integrity.root = ''
  pack.manifest.integrity.root = digest(bytes(canonical(pack.manifest)))
  const manifest = bytes(pack.manifest)
  Object.assign(pack.index, { manifestSha256: digest(manifest), integrityRoot: pack.manifest.integrity.root })
  pack.files.set(new URL('./manifest.json', baseUrl).href, manifest)
  pack.files.set(new URL('./pack-index.json', baseUrl).href, bytes(pack.index))
}

class OwnedTimers {
  jobs = new Set()
  stopped = false
  setTimeout = (callback, milliseconds) => {
    if (this.stopped) return -1
    const handle = setTimeout(() => { this.jobs.delete(handle); if (!this.stopped) callback() }, milliseconds)
    this.jobs.add(handle)
    return handle
  }
  clearTimeout = handle => { clearTimeout(handle); this.jobs.delete(handle) }
  terminate() { this.stopped = true; for (const handle of this.jobs) clearTimeout(handle); this.jobs.clear() }
}

class FakeHost {
  constructor(log, options = {}) {
    this.log = log; this.options = options; this.frame = null; this.config = null
    this.memory = new Uint8Array([0, 0, 9, 8, 7, 6, 0, 0])
    this.evaluations = 0; this.pollCount = 0; this.renderRevision = 0n; this.viewRevision = 0n; this.templateRevision = 0n
    this.declaredRendererProfile = 'skia'
    this.currentPage = null; this.lifecycle = 'Created'; this.fault = null
    this.frameInput = null; this.externalAckBlocked = null
    this.inputLifetimeRevision = 0n; this.pageStack = []; this.pageSequence = 0
  }
  load_manifest_json_with_config(manifest, config) {
    this.manifest = JSON.parse(manifest); this.config = JSON.parse(config)
    this.viewport = { width: this.config.host.windowWidth, height: this.config.host.windowHeight }
    this.log.push({ method: 'load', config: this.config })
    this.options.onLoad?.(this)
  }
  capabilities_json() { return JSON.stringify({ host: 'web', quickjs: true, v8: false, gpuSurface: false }) }
  runtime_state_json() {
    assert.ok(this.config, 'state read before host construction completed')
    const rendering = this.manifest.rendering
    const declared = rendering ? rendering.pages[this.currentPage?.path] ?? rendering.default : this.declaredRendererProfile
    const policy = this.config.renderer_policy
    const effective = policy ? policy.mode === 'force' ? policy.profile : declared
      : this.config.renderer_mode === 'browser-view' ? 'webview' : 'skia'
    return JSON.stringify({ schemaVersion: 1, sessionId: this.config.session_id, currentPage: this.currentPage,
      viewport: this.viewport,
      rendererProfile: effective, declaredRendererProfile: declared,
      transportBackend: this.config.renderer_mode, rendererPolicy: policy ?? null,
      viewRevision: String(this.viewRevision), templateRevision: String(this.templateRevision),
      renderRevision: String(this.renderRevision), lifecycle: this.lifecycle,
      executionFault: this.fault, requiresRestart: !!this.fault })
  }
  dispatch_json(json) {
    const request = JSON.parse(json)
    this.log.push({ method: 'dispatch', request, json })
    this.options.onDispatch?.(request, this)
    let result = { ok: true }
    if (this.fault && !['cancel', 'diagnostic', 'error'].includes(request.op)) {
      result = { ok: false, error: { code: 'ERR_ENGINE', message: 'requires a new session' }, requiresRestart: true }
    } else if (request.op === 'view.query.enable') {
      result = this.options.browserQueries ? (this.options.browserQueryEnable ?? {
        ok: true, version: '1.0', scope: 'session', enabled: true, key: null,
      }) : { ok: false, error: { code: 'ERR_UNSUPPORTED_CAPABILITY', message: 'fixture host has no browser query contract' } }
    } else if (request.op === 'app.init') result.engineProviderAvailable = this.options.providerAvailable !== false
    else if (request.op === 'app.lifecycle') {
      this.lifecycle = request.payload.event === 'unload' ? 'Destroyed' : request.payload.event === 'hide' ? 'Background' : 'Active'
      if (this.lifecycle !== 'Active') { this.frameInput = null; this.inputLifetimeRevision++ }
    } else if (request.op === 'page.push') {
      if (this.currentPage) { this.pageStack.push(this.currentPage); this.inputLifetimeRevision++ }
      this.currentPage = { pageId: String(++this.pageSequence), path: request.payload.path }
      this.viewRevision++; this.templateRevision++; this.frameInput = null
    } else if (request.op === 'page.pop') {
      this.inputLifetimeRevision++; this.currentPage = this.pageStack.pop() ?? null
      this.viewRevision++; this.templateRevision++; this.frameInput = null
    } else if (request.op === 'render.commit') {
      this.evaluations++; this.renderRevision++
      this.frame = { frame_id: request.payload.frameId, viewport: request.payload.viewport, template: request.payload.templateId }
      this.frameInput = { pageId: this.currentPage.pageId, routePath: this.currentPage.path,
        templateRevision: String(this.templateRevision), viewport: { ...request.payload.viewport } }
      this.options.onFramePrepared?.(this)
      result.committed = true
    } else if (request.op === 'module.call' && request.payload.export === 'fault') {
      this.fault = { code: 'ERR_TIMEOUT', message: 'fixture execution deadline' }
      result = { ok: false, error: this.fault, requiresRestart: true }
    }
    return JSON.stringify({ messages: [{ ...request, kind: 'response', payload: result }] })
  }
  dispatch_batch_json(json) {
    return JSON.stringify({ messages: JSON.parse(json).messages.flatMap(message => JSON.parse(this.dispatch_json(JSON.stringify(message))).messages) })
  }
  poll_timers(now) {
    this.log.push({ method: 'poll', now }); this.pollCount++
    this.options.onPoll?.(this)
    if (this.options.timerMutates && this.pollCount === 2) { this.viewRevision++; this.templateRevision++ }
    return JSON.stringify({ messages: [{ protocolVersion: '1.0', sessionId: this.config.session_id,
      requestId: '', kind: 'event', op: 'diagnostic', payload: { message: this.options.timerMessage ?? 'timer trace without a view mutation' } }] })
  }
  render_frame_json() { assert.ok(this.frame); this.log.push({ method: 'frame.current' }); return JSON.stringify(this.frame) }
  render_revision() { return this.renderRevision }
  view_revision() { return this.viewRevision }
  set_render_scale(scale) {
    this.options.onScale?.(scale, this)
    this.log.push({ method: 'scale', scale }); this.renderScale = scale; this.renderRevision++
  }
  acknowledge_presentation(revision) {
    assert.equal(revision, this.renderRevision)
    this.log.push({ method: 'ack', revision })
    if (this.presentedRevision === revision) return JSON.stringify({ messages: [] })
    this.presentedRevision = revision
    if (this.options.readyMutates) { this.viewRevision++; this.templateRevision++ }
    this.options.onAcknowledge?.(this)
    return JSON.stringify({ messages: this.options.ackMessages ?? [] })
  }
  observation_contract_json() {
    this.log.push({ method: 'observation.handshake' })
    return JSON.stringify(this.options.observationContract ?? { version: '1.0', inputLifetime: '1.0' })
  }
  observation_state_json() {
    this.log.push({ method: 'observation.state' })
    return JSON.stringify({ version: '1.0', inputLifetimeRevision: this.inputLifetimeRevision === null ? null : String(this.inputLifetimeRevision),
      state: JSON.parse(this.runtime_state_json()) })
  }
  external_presentation_contract_json() {
    this.log.push({ method: 'external.handshake' })
    return JSON.stringify(this.options.externalContract ?? { version: '1.0', consumedInput: '1.0', ackOutcome: '1.0', physicalTarget: '1.0' })
  }
  surface_recovery_contract_json() {
    this.log.push({ method: 'recovery.handshake' })
    return JSON.stringify(this.options.recoveryContract ?? { version: '1.0', retainedExternalFrame: '1.0' })
  }
  recover_external_frame_json(json) {
    const expected = JSON.parse(json), previousRenderRevision = String(this.renderRevision), previousInputLifetimeRevision = String(this.inputLifetimeRevision)
    this.log.push({ method: 'surface.recover', expected })
    this.options.onRecovery?.(this)
    assert.equal(expected.sessionId, this.config.session_id)
    assert.equal(expected.renderRevision, previousRenderRevision)
    assert.equal(expected.inputLifetimeRevision, previousInputLifetimeRevision)
    assert.equal(expected.templateRevision, String(this.templateRevision))
    assert.equal(expected.pageId, this.currentPage.pageId)
    assert.equal(expected.routePath, this.currentPage.path)
    const kind = this.frameInput?.templateRevision === expected.templateRevision ? 'retained' : 'render-required'
    if (kind === 'retained') this.renderRevision++
    else this.frameInput = null
    this.inputLifetimeRevision++; this.presentedRevision = null
    const result = { version: '1.0', kind, sessionId: this.config.session_id,
      previousRenderRevision, renderRevision: String(this.renderRevision), previousInputLifetimeRevision, inputLifetimeRevision: String(this.inputLifetimeRevision) }
    return JSON.stringify(this.options.recoveryOverride?.(result, this) ?? result)
  }
  last_frame_input_json(revision) {
    assert.equal(revision, this.renderRevision)
    this.log.push({ method: 'frame.input', revision })
    const value = { version: '1.0', sessionId: this.config.session_id, renderRevision: String(revision), consumedInput: this.frameInput }
    return JSON.stringify(this.options.frameProofOverride?.(value, this) ?? value)
  }
  render_target_json(revision) {
    assert.equal(revision, this.renderRevision)
    this.log.push({ method: 'frame.target', revision })
    const value = { version: '1.0', sessionId: this.config.session_id, renderRevision: String(revision),
      width: Math.ceil(this.frame.viewport.width * (this.renderScale ?? 1)), height: Math.ceil(this.frame.viewport.height * (this.renderScale ?? 1)) }
    return JSON.stringify(this.options.frameTargetOverride?.(value, this) ?? value)
  }
  acknowledge_presentation_outcome_json(revision) {
    const before = this.currentPage
    const batch = JSON.parse(this.acknowledge_presentation(revision))
    const eligible = this.lifecycle === 'Active' && this.currentPage !== null && this.frameInput !== null
      && before?.pageId === this.currentPage.pageId && before?.path === this.currentPage.path && !this.fault
    const errors = batch.messages.some(message => message.op === 'error' || message.payload?.ok === false || message.payload?.requiresRestart)
    const blocked = this.externalAckBlocked?.revision === revision && this.externalAckBlocked.blocked
    this.externalAckBlocked = { revision, blocked: !!blocked || !eligible || errors }
    const value = { version: '1.0', sessionId: this.config.session_id, renderRevision: String(revision),
      acknowledged: true, inputEnabled: !this.externalAckBlocked.blocked, requiresRestart: !!this.fault,
      batch, observedState: JSON.parse(this.runtime_state_json()) }
    return JSON.stringify(this.options.externalAckOverride?.(value, this) ?? value)
  }
  browser_view_resource(keyJson, sha256) {
    const key = JSON.parse(keyJson)
    assert.deepEqual(key, this.options.resourceKey)
    assert.equal(sha256, this.options.resourceHash)
    this.log.push({ method: 'resource', key, sha256 })
    if (this.options.oversizedResource) return new Uint8Array(16 * 1024 * 1024 + 1)
    return this.memory.subarray(2, 6)
  }
  notify_window_metrics_json(json) {
    const value = JSON.parse(json)
    this.log.push({ method: 'metrics', value })
    if (this.viewport.width !== value.windowWidth || this.viewport.height !== value.windowHeight) this.inputLifetimeRevision++
    this.viewport = { width: value.windowWidth, height: value.windowHeight }; this.frameInput = null
    this.options.onMetrics?.(this)
    if (this.options.metricsError) throw this.options.metricsError
    return JSON.stringify({ messages: [] })
  }
  retire_browser_preview(reason) { this.log.push({ method: 'retire', reason }); this.frameInput = null; this.inputLifetimeRevision++; return JSON.stringify({ messages: [] }) }
  render_snapshot_json() { throw new Error('normal Worker path must not request RGBA/JSON snapshots') }
  render_snapshot_rgba() { throw new Error('normal Worker path must not read back RGBA') }
  unload() { this.log.push({ method: 'unload' }) }
  free() { this.log.push({ method: 'free' }) }
}

function fixture(t, options = {}) {
  const pack = portablePack(options.assetCount, options.manifestFields, options.baseUrl), log = [], sent = [], events = [], fetched = [], failures = []
  const timers = new OwnedTimers()
  let host, initializeCount = 0, owner
  const listeners = new Map()
  const ports = options.messagePort ? new MessageChannel() : null
  ports?.port1.on('message', data => { for (const listener of listeners.get('message') ?? []) listener({ data }) })
  ports?.port2.on('message', data => owner.receive(data))
  const worker = {
    terminated: 0,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    postMessage(message, transfer = []) {
      if (ports) { ports.port1.postMessage(message, transfer); return }
      const data = structuredClone(message, { transfer }); queueMicrotask(() => owner.receive(data))
    },
    terminate() { this.terminated++; timers.terminate(); ports?.port1.close(); ports?.port2.close() },
  }
  owner = createWorkerRuntime({
    baseUrl: options.baseUrl ?? BASE, timer: timers, postTask: options.postTask, clock: options.clock ?? (() => 1720000000123),
    monotonicClock: options.monotonicClock ?? (() => 0),
    sha256: async value => digest(value),
    initializeWasm: () => { initializeCount++; return options.initializeWasm?.() ?? Promise.resolve() },
    createHost: () => {
      assert.equal(host, undefined, 'owner created a second host')
      host = new FakeHost(log, options.host)
      options.afterCreateHost?.(host)
      return host
    },
    fetch: async (url, init) => {
      fetched.push({ url, init })
      if (options.fetch) return options.fetch(url, init, pack)
      const body = pack.files.get(url)
      assert.ok(body, `unexpected fetch ${url}`)
      return new Response(body, { headers: { 'content-length': String(body.length) } })
    },
    send: (message, transfer) => {
      if (options.rejectSend?.(message)) throw new Error('fixture postMessage failed')
      sent.push(message)
      if (ports) { ports.port2.postMessage(message, transfer); return }
      const data = structuredClone(message, { transfer })
      queueMicrotask(() => { for (const listener of listeners.get('message') ?? []) listener({ data }) })
    },
  })
  const client = new WorkerRpcClient({ ...options.client, workerFactory: () => worker, workerEpoch: 'epoch-fixture', sessionId: 'session-fixture',
    requestPrefix: 'request-fixture', timeoutMs: 3000, closeTimeoutMs: 1000,
    onEvent: envelope => { events.push(envelope); return options.onEvent?.(envelope) }, onFailure: failure => failures.push(failure) })
  t.after(async () => {
    try {
      if (client.state === 'open' || client.state === 'closing') await client.close()
      assert.equal(timers.jobs.size, 0, 'owned Worker scheduling timers leaked')
    } finally { ports?.port1.close(); ports?.port2.close() }
  })
  const load = (payload = {}) => client.requestHost('load', { renderer: 'browser-view', ...payload })
  const bridge = (op, payload = {}) => client.requestHost('bridge', { envelope: {
    protocolVersion: '1.0', sessionId: client.sessionId, requestId: `inner-${op}`, kind: 'request', op, payload,
  } })
  return { client, owner, pack, log, sent, events, fetched, failures, timers, worker, load, bridge,
    get host() { return host }, get initializeCount() { return initializeCount } }
}

async function httpPackFixture(t, count = 20) {
  let f, automatic = false, withheld = null, maximum = 0
  const requests = [], hits = [], active = new Set()
  const respond = (request, body = request.body) => {
    if (request.response.destroyed || request.response.writableEnded) return
    request.response.writeHead(200, { 'content-length': body.length })
    request.response.end(body)
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, baseUrl).href, body = f.pack.files.get(url)
    hits.push(url)
    if (!body) { response.writeHead(404); response.end(); return }
    if (!new URL(url).pathname.includes('/blobs/')) {
      response.writeHead(200, { 'content-length': body.length }); response.end(body); return
    }
    const pending = { url, body, response }
    requests.push(pending); active.add(response); maximum = Math.max(maximum, active.size)
    response.once('close', () => active.delete(response))
    if (automatic && url !== withheld) respond(pending)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseUrl = `http://127.0.0.1:${server.address().port}/runtime-worker.mjs`
  f = fixture(t, { baseUrl, fetch: (url, init) => fetch(url, init) })
  distinctBlobs(f.pack, count, baseUrl)
  return { fixture: f, requests, hits, active, respond,
    get maximum() { return maximum },
    release(except = null) {
      automatic = true; withheld = except
      for (const request of requests) if (request.url !== withheld) respond(request)
    }, baseUrl }
}

function rawOwner(t, options = {}) {
  const pack = portablePack(0, options.manifestFields), sent = [], log = [], timers = new OwnedTimers()
  let initializeCount = 0, sequence = 0, resolveInitialization, host
  const initialization = new Promise(resolve => { resolveInitialization = resolve })
  const pumpTasks = new Map()
  const scheduler = options.suspendPump || options.manualPump ? {
    setTimeout: (callback, milliseconds) => {
      const pump = [8, 16].includes(milliseconds)
      const handle = timers.setTimeout(callback, pump ? 60_000 : milliseconds)
      if (pump && options.manualPump) pumpTasks.set(handle, callback)
      return handle
    },
    clearTimeout: handle => { pumpTasks.delete(handle); timers.clearTimeout(handle) },
  } : timers
  const owner = createWorkerRuntime({
    baseUrl: BASE, timer: scheduler, sha256: async value => digest(value), monotonicClock: () => 0,
    initializeWasm: () => { initializeCount++; return initialization },
    createHost: () => { host = new FakeHost(log, options.host); options.afterCreateHost?.(host); return host },
    fetch: async url => new Response(pack.files.get(url)),
    send: message => sent.push(message),
  })
  const request = (op, payload = {}, overrides = {}) => {
    const message = { version: '1.0', workerEpoch: 'raw-epoch', sessionId: 'raw-session',
      requestId: `raw-request-${++sequence}`, kind: 'request', op, payload, ...overrides }
    return { message, accepted: owner.receive(message) }
  }
  const final = request => sent.find(message => message.requestId === request.message.requestId
    && message.kind === 'response' && message.payload.status !== 'queued')
  t.after(async () => {
    if (!sent.some(message => message.op === 'close' && message.payload.status === 'ok')) {
      const closing = request('close')
      await until(() => final(closing))
    }
    resolveInitialization()
    timers.terminate()
    assert.equal(timers.jobs.size, 0)
  })
  return { owner, sent, log, request, final, resolveInitialization,
    pumpOnce() {
      assert.equal(pumpTasks.size, 1, 'exactly one owned timer pump must be scheduled')
      const [handle, callback] = pumpTasks.entries().next().value
      scheduler.clearTimeout(handle)
      callback()
    },
    get scheduledPumps() { return pumpTasks.size },
    get initializeCount() { return initializeCount }, get host() { return host } }
}

async function loadedRawOwner(t, options = {}) {
  const owner = rawOwner(t, { suspendPump: true, ...options })
  const loading = owner.request('load')
  owner.resolveInitialization()
  await until(() => owner.final(loading))
  assert.equal(owner.final(loading).payload.status, 'ok')
  return owner
}

const rendererManifest = (home, second, fallback = 'skia') => ({ schemaVersion: 3,
  rendering: { version: '1.0', default: fallback, pages: { [HOME]: home, [SECOND]: second } } })
const rawBridge = (f, op, payload = {}) => f.request('bridge', { envelope: {
  protocolVersion: '1.0', sessionId: 'raw-session', requestId: `inner-${op}`, kind: 'request', op, payload,
} })

test('explicit manifest policy chooses the verified requested route rather than the default or DOM container', { timeout: 5000 }, async t => {
  for (const [home, second, fallback, route, backend] of [
    ['skia', 'webview', 'skia', SECOND, 'browser-view'],
    ['webview', 'skia', 'webview', SECOND, 'external-frame'],
    ['webview', 'skyline-compat', 'webview', SECOND, 'external-frame'],
  ]) {
    const f = fixture(t, { manifestFields: rendererManifest(home, second, fallback) })
    const result = await f.load({ renderer: 'auto', rendererPolicy: { mode: 'manifest' }, route })
    assert.equal(result.transportBackend, backend)
    assert.equal(result.renderer, backend, 'legacy result alias stays available')
    assert.equal(result.declaredProfile, second)
    assert.equal(result.effectiveProfile, second)
    assert.deepEqual(result.rendererPolicy, { mode: 'manifest' })
    assert.equal(result.state.currentPage.path, route)
    assert.equal(result.state.requiresRestart, false)
    assert.equal(f.host.config.renderer_mode, backend)
    assert.deepEqual(f.host.config.renderer_policy, { mode: 'manifest' })
    assert.equal(f.host.evaluations, 0)
    await f.client.close()
  }
})

test('explicit force policy reports its difference while omitted legacy browser mode still forces WebView', { timeout: 5000 }, async t => {
  const fields = rendererManifest('webview', 'skia')
  for (const [profile, backend] of [['skia', 'external-frame'], ['skyline-compat', 'external-frame'], ['webview', 'browser-view']]) {
    const f = fixture(t, { manifestFields: fields })
    const result = await f.load({ renderer: 'auto', rendererPolicy: { mode: 'force', profile } })
    assert.equal(result.declaredProfile, 'webview')
    assert.equal(result.effectiveProfile, profile)
    assert.equal(result.transportBackend, backend)
    await f.bridge('page.push', { path: SECOND })
    const state = await f.client.requestHost('state', {})
    assert.equal(state.declaredRendererProfile, 'skia')
    assert.equal(state.rendererProfile, profile)
    assert.equal(state.requiresRestart, false)
    await f.client.close()
  }
  const legacy = fixture(t, { manifestFields: rendererManifest('skia', 'skyline-compat') })
  const result = await legacy.load()
  assert.equal(result.rendererPolicy, null)
  assert.equal(result.declaredProfile, 'skia')
  assert.equal(result.effectiveProfile, 'webview')
  assert.equal(legacy.host.config.renderer_policy, undefined)
})

test('renderer policy rejects ambiguous inputs and an old host that silently ignores manifest selection', { timeout: 5000 }, async t => {
  for (const payload of [
    { rendererPolicy: null }, { rendererPolicy: { mode: 'auto' } },
    { rendererPolicy: { mode: 'manifest', profile: 'webview' } },
    { rendererPolicy: { mode: 'force', profile: 'skyline' } },
    { renderer: 'browser-view', rendererPolicy: { mode: 'manifest' } },
  ]) {
    const f = fixture(t)
    await assert.rejects(f.load({ renderer: 'auto', ...payload }), error => error.code === 'ERR_INVALID_REQUEST')
    assert.equal(f.host, undefined)
    await f.client.close()
  }
  const f = fixture(t, { manifestFields: rendererManifest('skia', 'webview'), host: { onLoad(host) {
    const state = host.runtime_state_json.bind(host)
    host.runtime_state_json = () => JSON.stringify({ ...JSON.parse(state()), rendererProfile: 'webview' })
  } } })
  await assert.rejects(f.load({ renderer: 'auto', rendererPolicy: { mode: 'manifest' } }), error => error.code === 'ERR_ENGINE')
  assert.equal(f.log.some(entry => entry.method === 'dispatch' && entry.request.op === 'app.init'), false,
    'a dishonest policy must fail during the pure host handshake, before AppService executes')
  assert.equal(f.host.evaluations, 0)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  const old = fixture(t, { host: { onLoad(host) {
    const state = host.runtime_state_json.bind(host)
    host.runtime_state_json = () => {
      const value = JSON.parse(state())
      delete value.rendererPolicy
      delete value.transportBackend
      return JSON.stringify(value)
    }
  } } })
  await assert.rejects(old.load({ renderer: 'auto', rendererPolicy: { mode: 'manifest' } }), error => error.code === 'ERR_ENGINE')
  assert.equal(old.log.some(entry => entry.method === 'dispatch'), false, 'old V3-only WASM must execute no startup bridge calls')
  assert.equal(old.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(old.log.filter(entry => entry.method === 'free').length, 1)
})

test('same-family Skia to Skyline navigation retains the actual session and remains runnable', { timeout: 5000 }, async t => {
  const f = fixture(t, { manifestFields: rendererManifest('skia', 'skyline-compat') })
  const initial = await f.load({ renderer: 'auto', rendererPolicy: { mode: 'manifest' } })
  await f.bridge('page.push', { path: SECOND })
  const state = await f.client.requestHost('state', {})
  assert.equal(state.sessionId, initial.state.sessionId)
  assert.equal(state.currentPage.path, SECOND)
  assert.equal(state.rendererProfile, 'skyline-compat')
  assert.equal(state.requiresRestart, false)
  assert.equal(f.initializeCount, 1)
  const frame = await f.client.requestHost('frame', {})
  assert.equal(frame.frame.template, `template:${SECOND}.wxml`)
  assert.equal(f.host.evaluations, 1)
  assert.equal(f.events.some(event => event.op === 'fault'), false)
})

test('cross-family navigation preserves committed results then freezes queued ordinary work with a structured restart reason', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { suspendPump: true, manifestFields: rendererManifest('skia', 'webview') })
  const load = f.request('load', { rendererPolicy: { mode: 'manifest' } })
  f.resolveInitialization()
  await until(() => f.final(load))
  assert.equal(f.final(load).payload.status, 'ok')
  const navigation = rawBridge(f, 'page.push', { path: SECOND })
  const queuedFrame = f.request('frame')
  await until(() => f.final(navigation) && f.final(queuedFrame))
  assert.equal(f.final(navigation).payload.result.messages[0].payload.ok, true, 'committed navigation is not rolled back')
  const failure = f.final(queuedFrame).payload
  assert.equal(failure.error.code, 'ERR_UNSUPPORTED_CAPABILITY')
  assert.equal(failure.error.details.reason, 'renderer-profile-change')
  assert.equal(failure.error.details.requiredTransportBackend, 'browser-view')
  const faults = f.sent.filter(event => event.kind === 'event' && event.op === 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].payload.origin, 'policy')
  assert.equal(faults[0].payload.requiresRestart, true)
  assert.ok(f.sent.indexOf(faults[0]) < f.sent.indexOf(f.final(navigation)), 'consumer is frozen before the navigation final receipt')
  const state = f.request('state')
  const diagnostic = rawBridge(f, 'diagnostic', { message: 'inspect frozen owner' })
  await until(() => f.final(state) && f.final(diagnostic))
  const current = f.final(state).payload.result
  assert.equal(current.currentPage.path, SECOND)
  assert.equal(current.sessionId, 'raw-session')
  assert.equal(current.rendererProfile, 'webview')
  assert.equal(current.requiresRestart, true)
  assert.equal(current.reason, 'renderer-profile-change')
  assert.equal(current.executionFault, null, 'policy mismatch is not fabricated engine execution failure')
  assert.equal(f.final(diagnostic).payload.status, 'ok')
  assert.equal(f.host.evaluations, 0)
  assert.equal(f.host.pollCount, 0)
  assert.equal(f.initializeCount, 1, 'no implicit replacement Worker or session')
  const close = f.request('close')
  await until(() => f.final(close))
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.log.some(entry => entry.method === 'retire'), false)
  assert.equal(f.log.some(entry => entry.method === 'dispatch' && entry.request.op === 'app.lifecycle'
    && entry.request.payload.event === 'unload'), false, 'frozen close must not enter another app callback')
})

test('the actual timer and ready callback route, without a navigation operation hint, requires a restart', { timeout: 5000 }, async t => {
  for (const trigger of ['timer', 'ready']) {
    const changeRoute = host => { host.currentPage = { pageId: '2', path: SECOND }; host.viewRevision++; host.templateRevision++ }
    const f = rawOwner(t, { manualPump: true, manifestFields: rendererManifest('skia', 'webview'),
      host: trigger === 'timer' ? { onPoll: changeRoute } : { onAcknowledge: changeRoute } })
    const load = f.request('load', { rendererPolicy: { mode: 'manifest' } })
    f.resolveInitialization()
    await until(() => f.final(load))
    assert.equal(f.final(load).payload.status, 'ok')
    assert.equal(f.scheduledPumps, 1)
    if (trigger === 'timer') f.pumpOnce()
    else {
      const frame = f.request('frame')
      await until(() => f.final(frame))
      const ack = f.request('ack', { renderRevision: f.final(frame).payload.result.renderRevision })
      await until(() => f.final(ack))
      assert.equal(f.final(ack).payload.status, 'ok', 'the existing ACK stays genuine even when ready changes route')
    }
    await until(() => f.sent.some(event => event.kind === 'event' && event.op === 'fault'))
    assert.equal(f.sent.find(event => event.kind === 'event' && event.op === 'fault').payload.reason, 'renderer-profile-change')
    assert.equal(f.scheduledPumps, 0, 'future business timer pumping is stopped')
    const state = f.request('state')
    await until(() => f.final(state))
    assert.equal(f.final(state).payload.result.currentPage.path, SECOND)
    assert.equal(f.final(state).payload.result.requiresRestart, true)
    assert.equal(f.host.pollCount, trigger === 'timer' ? 1 : 0)
    assert.equal(f.scheduledPumps, 0)
  }
})

test('WebView to Skia family changes are checked after the genuine whole bridge batch, without splitting or replay', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { suspendPump: true, manifestFields: rendererManifest('webview', 'skia') })
  const load = f.request('load', { rendererPolicy: { mode: 'manifest' } })
  f.resolveInitialization()
  await until(() => f.final(load))
  assert.equal(f.final(load).payload.result.transportBackend, 'browser-view')
  const message = (requestId, op, payload) => ({ protocolVersion: '1.0', sessionId: 'raw-session', requestId,
    kind: 'request', op, payload })
  const batch = f.request('bridge', { batch: { messages: [
    message('batch-route', 'page.push', { path: SECOND }),
    message('batch-data', 'data.patch.batch', { patches: [] }),
  ] } })
  await until(() => f.final(batch))
  assert.deepEqual(f.final(batch).payload.result.messages.map(item => [item.requestId, item.payload.ok]),
    [['batch-route', true], ['batch-data', true]], 'already-entered batch results remain real, including later envelopes in that turn')
  assert.equal(f.log.filter(entry => entry.method === 'dispatch' && entry.request.requestId.startsWith('batch-')).length, 2)
  const fault = f.sent.find(event => event.kind === 'event' && event.op === 'fault')
  assert.equal(fault.payload.restartRequired.requiredTransportBackend, 'external-frame')
  const metrics = f.request('metrics', { windowWidth: 667, windowHeight: 375 })
  await until(() => f.final(metrics))
  assert.equal(f.final(metrics).payload.error.code, 'ERR_UNSUPPORTED_CAPABILITY')
  assert.equal(f.log.some(entry => entry.method === 'metrics'), false, 'the next host turn must never begin')
  assert.equal(f.host.evaluations, 0)
})

test('a thrown metrics turn exposes a committed family change before any later state request or timer', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { suspendPump: true, manifestFields: rendererManifest('skia', 'webview'), host: {
    onMetrics(host) { host.currentPage = { pageId: '2', path: SECOND }; host.templateRevision++ },
    metricsError: Object.assign(new Error('resize callback failed after navigation committed'), { code: 'ERR_ENGINE' }),
  } })
  const load = f.request('load', { rendererPolicy: { mode: 'manifest' } })
  f.resolveInitialization()
  await until(() => f.final(load))
  assert.equal(f.final(load).payload.status, 'ok')
  const metrics = f.request('metrics', { windowWidth: 667, windowHeight: 375 })
  await until(() => f.final(metrics))
  assert.equal(f.final(metrics).payload.error.code, 'ERR_ENGINE')
  assert.equal(f.final(metrics).payload.error.message, 'resize callback failed after navigation committed')
  const faults = f.sent.filter(event => event.kind === 'event' && event.op === 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].payload.origin, 'policy')
  assert.equal(faults[0].payload.restartRequired.routePath, SECOND)
  assert.equal(f.host.pollCount, 0)
  assert.equal(f.host.evaluations, 0)
  const frame = f.request('frame')
  await until(() => f.final(frame))
  assert.equal(f.final(frame).payload.error.code, 'ERR_UNSUPPORTED_CAPABILITY')
})

test('renderer transition notification uses the reserved slot when all ordinary event credit is held', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { suspendPump: true, manifestFields: rendererManifest('skia', 'webview') })
  const load = f.request('load', { rendererPolicy: { mode: 'manifest' } })
  f.resolveInitialization()
  await until(() => f.final(load))
  const normal = () => f.sent.filter(event => event.kind === 'event' && event.op !== 'fault').length
  while (normal() < WORKER_EVENT_LIMITS.count) {
    f.host.templateRevision++
    const state = f.request('state')
    await until(() => f.final(state))
    assert.equal(f.final(state).payload.status, 'ok')
  }
  const navigate = rawBridge(f, 'page.push', { path: SECOND })
  await until(() => f.final(navigate))
  assert.equal(normal(), WORKER_EVENT_LIMITS.count)
  const faults = f.sent.filter(event => event.kind === 'event' && event.op === 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].payload.origin, 'policy')
  assert.equal(faults[0].payload.error.code, 'ERR_UNSUPPORTED_CAPABILITY')
  const state = f.request('state')
  await until(() => f.final(state))
  assert.equal(f.final(state).payload.result.requiresRestart, true)
  assert.equal(f.host.evaluations, 0)
})

test('real client accepts owner load receipts, first batch and dirty notifications', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const result = await f.load()
  await until(() => f.events.some(event => event.op === 'dirty'))
  assert.equal(result.state.currentPage.path, HOME)
  assert.equal(result.state.sessionId, f.client.sessionId)
  assert.equal(f.initializeCount, 1)
  assert.equal(f.client.failure, null)
  assert.equal(f.failures.length, 0)
  assert.equal(f.events.filter(event => event.op === 'batch').length, 3)
  assert.ok(f.events.every(event => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(event.requestId)))
  assert.equal(new Set(f.events.map(event => event.requestId)).size, f.events.length)
  const responses = f.sent.filter(message => message.kind === 'response' && message.op === 'load')
  assert.deepEqual(responses.map(message => message.payload.status), ['queued', 'ok'])
  assert.equal(responses[0].requestId, responses[1].requestId)
  assert.equal(f.host.config.engine, 'quickjs')
  assert.deepEqual(f.host.config.engine_execution, { bootstrap_timeout_ms: 5000, turn_timeout_ms: 250 })
  assert.deepEqual(f.host.config.view_execution, { batch_timeout_ms: 50 })
  assert.equal(f.host.config.renderer_mode, 'browser-view')
  assert.deepEqual(f.host.config.host, { kind: 'web', windowWidth: 375, windowHeight: 667 })
  assert.ok(f.fetched.every(({ url, init }) => url.startsWith('https://worker.test/') && init.redirect === 'error'))
  const closed = await f.client.close()
  assert.equal(closed.closed, true)
  assert.ok(Array.isArray(closed.diagnostics))
  assert.deepEqual(f.log.slice(-4).map(entry => entry.method), ['retire', 'dispatch', 'unload', 'free'])
  assert.equal(f.log.at(-3).request.payload.event, 'unload')
  assert.equal(f.worker.terminated, 1)
})

test('trusted View batch budget reaches native configuration independently of the shorter host turn', async t => {
  const f = fixture(t)
  await f.load({ viewExecution: { batchTimeoutMs: 500 }, engineExecution: { turnTimeoutMs: 250 } })
  assert.deepEqual(f.host.config.view_execution, { batch_timeout_ms: 500 })
  assert.equal(f.host.config.engine_execution.turn_timeout_ms, 250)
  await f.client.close()
})

test('invalid View budgets fail before fetching or constructing an execution owner', async t => {
  for (const viewExecution of [null, [], 50, { typo: 250 }, ...[null, 0, -1, 0.5, 5001, Number.MAX_SAFE_INTEGER, '250'].map(batchTimeoutMs => ({ batchTimeoutMs }))]) {
    await t.test(JSON.stringify(viewExecution), async child => {
      const f = fixture(child)
      await assert.rejects(f.load({ viewExecution }), error => error.code === 'ERR_INVALID_REQUEST')
      assert.equal(f.fetched.length, 0)
      assert.equal(f.host, undefined)
    })
  }
})

test('initial host display observation reaches native construction before host services and guest modules', async t => {
  const metrics = { windowWidth: 375, windowHeight: 667, pixelRatio: 2.75,
    screenWidth: 393, screenHeight: 873, statusBarHeight: 24, screenTop: -3.5,
    deviceOrientation: 'portrait', safeArea: { left: 0, right: 393, top: 24, bottom: 849, width: 393, height: 825 } }
  const { windowWidth: _width, windowHeight: _height, ...display } = metrics
  const f = fixture(t, {
    host: { onDispatch(request, host) {
      if (request.op === 'app.init') {
        assert.deepEqual(host.config.host.displayMetrics, display)
        assert.equal(host.servicesConfigured, true, 'guest module execution preceded host configuration')
      }
    } },
    afterCreateHost(host) {
      host.host_services_protocol_json = () => JSON.stringify({ version: '1.0', trustedContext: true, ownerThreadCompletion: true })
      host.take_host_requests_json = () => '[]'
      host.complete_host_api_call_json = () => '{"messages":[]}'
      host.dispatch_host_api_event_json = () => '{"messages":[]}'
      host.revoke_host_services_json = () => '{"messages":[]}'
      host.configure_host_services_json = () => {
        assert.deepEqual(host.config.host.displayMetrics, display, 'initial host snapshot was unavailable in preflight')
        host.servicesConfigured = true
      }
    },
  })
  await f.load({ metrics, hostServices: { application: { packRoot: f.pack.manifest.integrity.root } } })
  assert.deepEqual(f.host.config.host.displayMetrics, display)
  assert.equal(f.log.filter(item => item.method === 'metrics').length, 0, 'initial observation must not wait for a post-init resize')
  await f.client.close()
})

test('initial host observation viewport mismatch rejects before native owner construction', async t => {
  const f = fixture(t)
  await assert.rejects(f.load({ metrics: { windowWidth: 376, windowHeight: 667 } }), { code: 'ERR_RENDER' })
  assert.equal(f.host, undefined)
  assert.equal(f.log.some(item => item.method === 'dispatch'), false)
  await f.client.close()
})

test('a failed initial native observation closes its owner and a replacement uses its own observation', async t => {
  const first = fixture(t, { host: { onLoad() { throw new Error('native rejected initial observation') } } })
  await assert.rejects(first.load({ metrics: { windowWidth: 375, windowHeight: 667, pixelRatio: 0 } }), /native rejected initial observation/)
  assert.equal(first.log.some(item => item.method === 'dispatch' && item.request.op === 'app.init'), false)
  assert.deepEqual(first.log.filter(item => ['unload', 'free'].includes(item.method)).map(item => item.method), ['unload', 'free'])
  await first.client.close()
  const next = fixture(t), metrics = { windowWidth: 375, windowHeight: 667, pixelRatio: 1.5,
    screenWidth: 1440, screenHeight: 900, statusBarHeight: 0, screenTop: 0, deviceOrientation: 'landscape' }
  await next.load({ metrics })
  assert.equal(next.host.config.host.displayMetrics.pixelRatio, 1.5)
  assert.equal(next.host.config.host.displayMetrics.screenWidth, 1440)
  await next.client.close()
})

test('an oversized load response disposes its actual host before enabling runtime timers', { timeout: 5000 }, async t => {
  const f = fixture(t, { assetCount: 4000 })
  assert.ok(f.pack.files.get(new URL('./manifest.json', BASE).href).length < 8 * 1024 * 1024)
  await assert.rejects(f.load(), { code: 'ERR_RPC_PAYLOAD_TOO_LARGE' })
  assert.deepEqual(f.log.filter(entry => ['unload', 'free'].includes(entry.method)).map(entry => entry.method), ['unload', 'free'])
  assert.equal(f.host.pollCount, 0)
  await assert.rejects(f.client.requestHost('state', {}), { code: 'ERR_ENGINE' })
  await assert.rejects(f.client.requestHost('frame', {}), { code: 'ERR_ENGINE' })
  await delay(40)
  assert.equal(f.host.pollCount, 0, 'failed load must never schedule business timers')
  assert.equal((await f.client.close()).closed, true)
  assert.deepEqual(f.log.filter(entry => ['unload', 'free'].includes(entry.method)).map(entry => entry.method), ['unload', 'free'])
  assert.equal(f.worker.terminated, 1)
})

test('external frames use the current route and scale/current-frame never reexecute View', { timeout: 5000 }, async t => {
  const f = fixture(t, { host: { readyMutates: true } })
  await f.load({ renderer: 'external-frame' })
  await f.bridge('page.push', { path: SECOND })
  const first = await f.client.requestHost('frame', {})
  assert.equal(first.frame.template, `template:${SECOND}.wxml`)
  assert.deepEqual(first.frame.viewport, { x: 0, y: 0, width: 375, height: 667 })
  assert.equal(f.host.evaluations, 1)
  await f.client.requestHost('scale', { scale: 2 })
  const second = await f.client.requestHost('frame.current', {})
  assert.deepEqual(second.frame, first.frame)
  assert.notEqual(second.renderRevision, first.renderRevision)
  assert.equal(second.viewRevision, first.viewRevision)
  assert.equal(f.host.evaluations, 1)
  const before = f.events.filter(event => event.op === 'dirty').length
  await f.client.requestHost('ack', { renderRevision: second.renderRevision })
  await until(() => f.events.filter(event => event.op === 'dirty').length > before)
  assert.equal(f.host.evaluations, 1, 'ready writes request a later frame; the Worker does not render automatically')
  await f.client.requestHost('metrics', { windowWidth: 667, windowHeight: 375, pixelRatio: 2 })
  const resized = await f.client.requestHost('frame', {})
  assert.deepEqual(resized.frame.viewport, { x: 0, y: 0, width: 667, height: 375 })
  assert.deepEqual(f.log.find(entry => entry.method === 'metrics').value, { windowWidth: 667, windowHeight: 375, pixelRatio: 2 })
})

test('dirty preserves activity, template and native paint revisions as separate observations', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  const dirty = () => f.sent.filter(message => message.kind === 'event' && message.op === 'dirty')
  const before = dirty().at(-1).payload
  f.host.viewRevision++ // accepted input with no setData
  const activity = f.request('state')
  await until(() => f.final(activity))
  const afterActivity = dirty().at(-1).payload
  assert.notEqual(afterActivity.viewRevision, before.viewRevision)
  assert.equal(afterActivity.templateRevision, before.templateRevision)
  assert.equal(afterActivity.renderRevision, before.renderRevision)
  const activityCount = dirty().length
  const repeated = f.request('state')
  await until(() => f.final(repeated))
  assert.equal(dirty().length, activityCount, 'identical observation must not publish another dirty event')
  f.host.renderRevision++ // a native scroll/repaint, no template input mutation
  const paint = f.request('state')
  await until(() => f.final(paint))
  const afterPaint = dirty().at(-1).payload
  assert.equal(afterPaint.templateRevision, afterActivity.templateRevision)
  assert.notEqual(afterPaint.renderRevision, afterActivity.renderRevision)
  f.host.templateRevision = 9007199254740993n
  const template = f.request('state')
  await until(() => f.final(template))
  const afterTemplate = dirty().at(-1).payload
  assert.equal(afterTemplate.templateRevision, '9007199254740993')
  assert.equal(f.final(template).payload.result.templateRevision, '9007199254740993')
  assert.equal(f.host.evaluations, 0, 'dirty observation must never evaluate View')
})

test('dirty observes logical metrics, lifecycle and declared profile without requiring activity changes', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  const dirty = () => f.sent.filter(message => message.kind === 'event' && message.op === 'dirty')
  const before = dirty().at(-1).payload
  assert.equal(before.rendererProfile, 'webview')
  assert.equal(before.declaredRendererProfile, 'skia', 'explicit force mode must not mask manifest policy')
  const resize = f.request('metrics', { windowWidth: 667, windowHeight: 375 })
  await until(() => f.final(resize))
  let observed = dirty().at(-1).payload
  assert.deepEqual(observed.viewport, { width: 667, height: 375 })
  assert.equal(observed.templateRevision, before.templateRevision)
  assert.equal(observed.viewRevision, before.viewRevision)
  const hide = f.request('bridge', { envelope: { protocolVersion: '1.0', sessionId: 'raw-session',
    requestId: 'inner-hide', kind: 'request', op: 'app.lifecycle', payload: { event: 'hide' } } })
  await until(() => f.final(hide))
  observed = dirty().at(-1).payload
  assert.equal(observed.lifecycle, 'Background')
  assert.equal(observed.viewRevision, before.viewRevision)
  f.host.declaredRendererProfile = 'skyline-compat'
  const profile = f.request('state')
  await until(() => f.final(profile))
  observed = dirty().at(-1).payload
  assert.equal(observed.declaredRendererProfile, 'skyline-compat')
  assert.equal(observed.rendererProfile, 'webview')
  assert.equal(f.host.evaluations, 0)
})

test('owner rejects malformed scheduling revisions, profiles and lifecycle from its host contract', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  const original = f.host.runtime_state_json.bind(f.host)
  for (const invalid of [
    { templateRevision: undefined }, { templateRevision: 1 }, { templateRevision: '01' },
    { templateRevision: '-1' }, { templateRevision: '18446744073709551616' },
    { declaredRendererProfile: undefined }, { declaredRendererProfile: 'native' },
    { rendererProfile: 'native' }, { lifecycle: 'Hidden' },
  ]) {
    f.host.runtime_state_json = () => JSON.stringify({ ...JSON.parse(original()), ...invalid })
    const request = f.request('state')
    await until(() => f.final(request))
    assert.equal(f.final(request).payload.status, 'error', JSON.stringify(invalid))
    assert.equal(f.final(request).payload.error.code, 'ERR_ENGINE')
  }
  f.host.runtime_state_json = original
  const request = f.request('state')
  await until(() => f.final(request))
  assert.equal(f.final(request).payload.status, 'ok')
  assert.equal(f.host.evaluations, 0)
})

test('DOM resource transfer preserves WASM memory and control aliases call the real owner paths', { timeout: 5000 }, async t => {
  const key = { sessionId: 'session-fixture', pageId: '1', documentRevision: '1', presentationRevision: '2', surfaceGeneration: '3', profile: 'webview' }
  const hash = 'b'.repeat(64)
  const f = fixture(t, { host: { resourceKey: key, resourceHash: hash } })
  await f.load()
  const resource = await f.client.requestHost('resource', { key, sha256: hash })
  assert.deepEqual(resource.key, key)
  assert.equal(resource.sha256, hash)
  assert.ok(resource.bytes instanceof ArrayBuffer)
  assert.deepEqual([...new Uint8Array(resource.bytes)], [9, 8, 7, 6])
  assert.equal(f.host.memory.byteLength, 8, 'resource transfer detached the fake WASM backing buffer')
  assert.deepEqual([...f.host.memory], [0, 0, 9, 8, 7, 6, 0, 0])
  await f.client.requestHost('view.abort', { key })
  await f.client.requestHost('view.retire', { reason: 'alias-retirement' })
  assert.ok(f.log.some(entry => entry.method === 'dispatch' && entry.request.op === 'view.abort'
    && JSON.stringify(entry.request.payload) === JSON.stringify(key)))
  assert.ok(f.log.some(entry => entry.method === 'retire' && entry.reason === 'alias-retirement'))
  f.host.options.oversizedResource = true
  await assert.rejects(f.client.requestHost('resource', { key, sha256: hash }), error => /16 MiB/.test(error.message))
})

test('close aborts a noncooperative async initializer before any host is created', { timeout: 5000 }, async t => {
  let resolveInitialize
  const initialization = new Promise(resolve => { resolveInitialize = resolve })
  const f = fixture(t, { initializeWasm: () => initialization })
  const loading = outcome(f.load())
  await until(() => f.initializeCount === 1)
  const result = await f.client.close()
  assert.equal(result.closed, true)
  assert.equal((await loading).error.code, 'ERR_CANCELLED')
  assert.equal(f.host, undefined)
  resolveInitialize()
  await delay(5)
  assert.equal(f.host, undefined, 'late initializer created a host after close')
  assert.equal(f.worker.terminated, 1)
})

test('Worker timer pump uses Unix nanoseconds and trace-only batches never mark View dirty', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.load()
  await until(() => f.host.pollCount >= 2)
  assert.equal(f.log.find(entry => entry.method === 'poll').now, 1720000000123000000n)
  assert.equal(f.events.filter(event => event.op === 'dirty').length, 1)
  assert.equal(f.host.evaluations, 0)
  assert.equal(workerUnixNanos(1720000000123), 1720000000123000000n)
  assert.throws(() => workerUnixNanos(1.5), /invalid Unix/)
})

test('fault retains the host for controls but stops timers, input and new frames', { timeout: 5000 }, async t => {
  const f = fixture(t)
  await f.load()
  const batch = await f.bridge('module.call', { export: 'fault' })
  assert.equal(batch.messages[0].payload.error.code, 'ERR_TIMEOUT')
  assert.equal(batch.messages[0].payload.requiresRestart, true)
  const polled = f.host.pollCount
  await delay(40)
  assert.equal(f.host.pollCount, polled)
  const state = await f.client.requestHost('state', {})
  assert.equal(state.requiresRestart, true)
  const diagnostic = await f.bridge('diagnostic', { message: 'inspect fault' })
  assert.equal(diagnostic.messages[0].payload.ok, true)
  await assert.rejects(f.bridge('view.events', {}), error => error.code === 'ERR_ENGINE')
  await assert.rejects(f.client.requestHost('frame', {}), error => error.code === 'ERR_ENGINE')
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 0)
  await f.client.close()
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'dispatch' && entry.request.payload.event === 'unload').length, 0,
    'fault shutdown attempted another application lifecycle callback')
})

test('load rejects hash corruption, hostile URL origins and unsupported execution profiles', { timeout: 5000 }, async t => {
  for (const scenario of ['blob-hash', 'root-hash', 'origin', 'runtime-api', 'v8', 'zero-budget', 'missing-provider', 'oversized-declaration', 'stream-exceeds-size']) {
    await t.test(scenario, async child => {
      const f = fixture(child, { host: { providerAvailable: scenario !== 'missing-provider' },
        fetch: scenario === 'stream-exceeds-size' ? async (url, _init, pack) => new Response(pack.files.get(url)) : undefined })
      const options = {}
      if (scenario === 'blob-hash') {
        const location = new URL(`./blobs/${f.pack.hash}`, BASE).href
        const corrupted = f.pack.files.get(location).slice()
        corrupted[0] ^= 1
        f.pack.files.set(location, corrupted)
      }
      if (scenario === 'root-hash') {
        const changed = { ...f.pack.manifest, app: { ...f.pack.manifest.app, appJson: 'changed.json' } }
        const changedBytes = bytes(changed)
        f.pack.files.set(new URL('./manifest.json', BASE).href, changedBytes)
        f.pack.files.set(new URL('./pack-index.json', BASE).href, bytes({ ...f.pack.index, manifestSha256: digest(changedBytes) }))
      }
      if (scenario === 'origin') options.indexUrl = 'https://unrelated.test/pack.json'
      if (scenario === 'runtime-api') options.indexUrl = '/%61pi/pack.json'
      if (scenario === 'v8') options.engine = 'v8'
      if (scenario === 'zero-budget') options.engineExecution = { turnTimeoutMs: 0 }
      if (scenario === 'oversized-declaration' || scenario === 'stream-exceeds-size') {
        const size = scenario === 'oversized-declaration' ? WORKER_PACK_BUDGET + 1 : 1
        f.pack.files.set(new URL('./pack-index.json', BASE).href,
          bytes({ ...f.pack.index, blobs: f.pack.index.blobs.map(blob => ({ ...blob, size })) }))
      }
      await assert.rejects(f.load(options), error => {
        if (scenario === 'blob-hash') return /blob integrity mismatch/.test(error.message)
        if (scenario === 'stream-exceeds-size') return /bytes exceed their declared size/.test(error.message)
        return true
      })
      if (scenario !== 'missing-provider') assert.equal(f.host, undefined)
      else assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
      assert.equal(f.host?.evaluations ?? 0, 0)
      if (scenario === 'oversized-declaration') assert.equal(f.fetched.length, 1, 'oversized declaration fetched manifest or blob bytes')
    })
  }
})

test('verified pack uses six real HTTP downloads and constructs no host until the final blob verifies', { timeout: 5000 }, async t => {
  const h = await httpPackFixture(t), f = h.fixture, loading = outcome(f.load())
  await until(() => h.requests.length === 6)
  assert.equal(h.maximum, 6)
  assert.equal(f.host, undefined); assert.equal(f.initializeCount, 0)
  const last = new URL(f.pack.index.blobs.at(-1).url, h.baseUrl).href
  h.release(last)
  await until(() => h.requests.length === 20)
  assert.equal(h.maximum, 6, 'download workers exceeded the fixed network bound')
  assert.equal(f.host, undefined); assert.equal(f.initializeCount, 0)
  h.respond(h.requests.find(request => request.url === last))
  assert.ok((await loading).value)
  const init = f.log.find(entry => entry.method === 'dispatch' && entry.request.op === 'app.init')
  assert.equal(Object.keys(init.request.payload.blobs).length, 20)
  for (const descriptor of f.pack.index.blobs) {
    assert.equal(digest(Uint8Array.from(init.request.payload.blobs[`sha256:${descriptor.sha256}`])), descriptor.sha256)
  }
})

test('first corrupt HTTP blob aborts its download siblings without starting queued blobs or a late host', { timeout: 5000 }, async t => {
  const h = await httpPackFixture(t), f = h.fixture, loading = outcome(f.load())
  await until(() => h.requests.length === 6)
  const corrupted = h.requests[0].body.slice(); corrupted[0] ^= 1
  h.respond(h.requests[0], corrupted)
  assert.match((await loading).error.message, /blob integrity mismatch/)
  await until(() => h.active.size === 0)
  h.release(); await delay(10)
  assert.equal(h.requests.length, 6)
  assert.equal(f.host, undefined); assert.equal(f.initializeCount, 0)
})

test('a real HTTP redirect is denied before any redirected request and aborts the blob group', { timeout: 5000 }, async t => {
  const h = await httpPackFixture(t), f = h.fixture, loading = outcome(f.load())
  await until(() => h.requests.length === 6)
  h.requests[0].response.writeHead(302, { location: '/redirected-blob', 'content-length': 0 })
  h.requests[0].response.end()
  assert.ok((await loading).error)
  await until(() => h.active.size === 0)
  assert.equal(h.hits.some(url => url.endsWith('/redirected-blob')), false)
  assert.equal(h.requests.length, 6)
  assert.equal(f.host, undefined); assert.equal(f.initializeCount, 0)
})

test('close aborts six real HTTP downloads and leaves no queued download or late host', { timeout: 5000 }, async t => {
  const h = await httpPackFixture(t), f = h.fixture, loading = outcome(f.load())
  await until(() => h.requests.length === 6)
  assert.equal((await f.client.close()).closed, true)
  assert.equal((await loading).error.code, 'ERR_CANCELLED')
  await until(() => h.active.size === 0)
  h.release(); await delay(10)
  assert.equal(h.requests.length, 6)
  assert.equal(f.host, undefined); assert.equal(f.initializeCount, 0)
})

test('first stream error aborts immediately and awaits actual sibling cancellation terminals', { timeout: 5000 }, async t => {
  let releaseCancellation, cancellations = 0, settled = false
  const terminal = new Promise(resolve => { releaseCancellation = resolve }), streams = []
  t.after(() => releaseCancellation())
  const f = fixture(t, { fetch(url, init, pack) {
    const body = pack.files.get(url)
    if (!new URL(url).pathname.includes('/blobs/')) return new Response(body)
    return new Response(new ReadableStream({
      start(controller) { streams.push({ controller, body, signal: init.signal }) },
      cancel() { cancellations++; return terminal },
    }))
  } })
  distinctBlobs(f.pack, 20)
  const loading = outcome(f.load()).then(result => { settled = true; return result })
  await until(() => streams.length === 6)
  // Exceed one declared size while its own cancel is deliberately pending.
  // Sibling abort must happen now, rather than after this cleanup completes.
  streams[0].controller.enqueue(new Uint8Array(streams[0].body.length + 1))
  await until(() => cancellations === 6)
  assert.ok(streams.every(stream => stream.signal.aborted))
  assert.equal(settled, false, 'load detached its owned stream cancellation')
  assert.equal(streams.length, 6); assert.equal(f.host, undefined)
  releaseCancellation()
  assert.match((await loading).error.message, /bytes exceed their declared size/)
  assert.equal(f.initializeCount, 0)
})

test('cancelled noncooperative fetches must settle before close and cannot construct a late host', { timeout: 5000 }, async t => {
  const requests = []
  const f = fixture(t, { fetch(url, init, pack) {
    const body = pack.files.get(url)
    if (!new URL(url).pathname.includes('/blobs/')) return new Response(body)
    return new Promise(resolve => requests.push({ resolve, body, signal: init.signal }))
  } })
  distinctBlobs(f.pack, 20)
  t.after(() => { for (const request of requests) request.resolve(new Response(request.body)) })
  const loading = outcome(f.load())
  await until(() => requests.length === 6)
  let settled = false
  const closing = f.client.close().then(result => { settled = true; return result })
  await until(() => requests.every(request => request.signal.aborted))
  assert.equal(settled, false); assert.equal(f.host, undefined)
  for (const request of requests) request.resolve(new Response(request.body))
  assert.equal((await closing).closed, true)
  assert.equal((await loading).error.code, 'ERR_CANCELLED')
  assert.equal(requests.length, 6)
  assert.equal(f.host, undefined); assert.equal(f.initializeCount, 0)
})

test('JSON expansion budget is checked after verified metadata and before concurrent blob downloads', { timeout: 5000 }, async t => {
  const f = fixture(t)
  f.pack.index.blobs[0].size = 8 * 1024 * 1024
  f.pack.files.set(new URL('./pack-index.json', BASE).href, bytes(f.pack.index))
  await assert.rejects(f.load(), /JSON expansion exceeds/)
  assert.equal(f.fetched.length, 2)
  assert.equal(f.host, undefined); assert.equal(f.initializeCount, 0)
})

test('owner reserves seven control slots and an exclusive close slot while load is blocked', { timeout: 5000 }, async t => {
  const f = rawOwner(t)
  const load = f.request('load')
  await until(() => f.initializeCount === 1)
  const queued = Array.from({ length: 63 }, () => f.request('state'))
  assert.ok(queued.every(request => request.accepted))
  const overflow = f.request('state')
  assert.equal(overflow.accepted, false)
  assert.match(f.final(overflow).payload.error.message, /queue is full/)
  const controls = Array.from({ length: 7 }, () => f.request('retire'))
  assert.ok(controls.every(request => request.accepted))
  const controlOverflow = f.request('retire')
  assert.equal(controlOverflow.accepted, false)
  const closing = f.request('close')
  assert.equal(closing.accepted, true)
  await until(() => f.final(closing))
  assert.equal(f.final(closing).payload.result.closed, true)
  for (const request of [load, ...queued, ...controls]) assert.equal(f.final(request).payload.error.code, 'ERR_CANCELLED')
  assert.equal(f.log.length, 0, 'close constructed a host while its initializer was blocked')
})

test('owner independently limits queued bytes and immediately releases cancelled queue entries', { timeout: 5000 }, async t => {
  const f = rawOwner(t)
  f.request('load')
  await until(() => f.initializeCount === 1)
  const payload = { bytes: new ArrayBuffer(13 * 1024 * 1024) }
  const requests = Array.from({ length: 4 }, () => f.request('state', payload))
  assert.ok(requests.every(request => request.accepted))
  const overflow = f.request('state', payload)
  assert.equal(overflow.accepted, false)
  assert.equal(f.final(overflow).payload.error.code, 'ERR_RPC_QUEUE_FULL')
  const cancelled = requests[0]
  assert.equal(f.owner.receive({ ...cancelled.message, kind: 'cancel', payload: { reason: 'timeout' } }), true)
  assert.equal(f.final(cancelled).payload.error.code, 'ERR_CANCELLED')
  const replacement = f.request('state', payload)
  assert.equal(replacement.accepted, true, 'owner retained a cancelled queued payload reservation')
  const oversized = f.request('state', { bytes: new ArrayBuffer(16 * 1024 * 1024) })
  assert.equal(oversized.accepted, false)
  assert.equal(f.final(oversized).payload.error.code, 'ERR_RPC_PAYLOAD_TOO_LARGE')
  const closing = f.request('close')
  assert.equal(closing.accepted, true, 'ordinary bytes consumed the close reserve')
  await until(() => f.final(closing))
  assert.equal(f.final(closing).payload.result.closed, true)
})

test('owner rejects stale identities and pending duplicate IDs without executing queued work', { timeout: 5000 }, async t => {
  const f = rawOwner(t)
  f.request('load')
  await until(() => f.initializeCount === 1)
  for (const overrides of [{ workerEpoch: 'stale-epoch' }, { sessionId: 'stale-session' }]) {
    const stale = f.request('state', {}, overrides)
    assert.equal(stale.accepted, false)
    assert.equal(f.final(stale).payload.error.code, 'ERR_CANCELLED')
  }
  const queued = f.request('state')
  const duplicate = f.request('state', {}, { requestId: queued.message.requestId })
  assert.equal(duplicate.accepted, false)
  assert.match(f.final(duplicate).payload.error.message, /duplicate pending/)
  assert.equal(f.log.length, 0)
})

test('owner rejects an oversized response before posting it and keeps the session usable', { timeout: 5000 }, async t => {
  const key = { sessionId: 'session-fixture', pageId: '1', documentRevision: '1', presentationRevision: '2', surfaceGeneration: '3', profile: 'webview' }
  const hash = 'c'.repeat(64)
  const f = fixture(t, { host: { resourceKey: key, resourceHash: hash } })
  await f.load()
  f.host.browser_view_resource = () => new Uint8Array(16 * 1024 * 1024)
  await assert.rejects(f.client.requestHost('resource', { key, sha256: hash }), error => error.code === 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(f.client.failure, null, 'oversized response reached and poisoned the real client')
  const state = await f.client.requestHost('state', {})
  assert.equal(state.currentPage.path, HOME)
})

test('a broken response channel still unloads the exact owned host', { timeout: 5000 }, async t => {
  let rejectSend = false
  const f = fixture(t, { rejectSend: () => rejectSend })
  await f.load()
  rejectSend = true
  await assert.rejects(f.client.requestHost('state', {}, { timeoutMs: 50 }), error => error.code === 'ERR_RPC_TIMEOUT')
  await until(() => f.log.some(entry => entry.method === 'free'))
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  await assert.rejects(f.client.close({ timeoutMs: 50 }), error => error.code === 'ERR_RPC_TIMEOUT')
  assert.equal(f.worker.terminated, 1)
})

test('a frame after rejected metrics uses the actual committed dimensions without an explicit state request or timer', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { suspendPump: true })
  const loading = f.request('load', { renderer: 'external-frame' })
  f.resolveInitialization()
  await until(() => f.final(loading))
  assert.equal(f.final(loading).payload.status, 'ok')
  const dirtyBefore = f.sent.filter(event => event.kind === 'event' && event.op === 'dirty').length
  f.host.options.metricsError = Object.assign(new Error('terminal callback failed after metrics committed'), { code: 'ERR_ENGINE' })
  const metrics = f.request('metrics', { windowWidth: 667, windowHeight: 375, pixelRatio: 2 })
  await until(() => f.final(metrics))
  assert.equal(f.final(metrics).payload.status, 'error')
  assert.equal(f.final(metrics).payload.error.code, 'ERR_ENGINE')
  // This asserts the public frame result only. frame() refreshes state itself;
  // it does not isolate or prove an internal viewport refresh in the catch path.
  assert.equal(f.host.pollCount, 0, 'timer polling must not alter this frame-result regression')
  assert.equal(f.sent.filter(event => event.kind === 'event' && event.op === 'dirty').length, dirtyBefore,
    'a rejected healthy metrics request does not immediately publish dirty')
  const frame = f.request('frame')
  await until(() => f.final(frame))
  assert.equal(f.final(frame).payload.status, 'ok')
  assert.deepEqual(f.final(frame).payload.result.frame.viewport, { x: 0, y: 0, width: 667, height: 375 })
  assert.equal(f.host.pollCount, 0)
  assert.equal(f.host.evaluations, 1)
})

test('a thrown metrics operation exposes a recorded execution fault before any later state request or timer', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  const before = f.sent.length
  const observeMetrics = f.host.notify_window_metrics_json.bind(f.host)
  f.host.notify_window_metrics_json = json => {
    observeMetrics(json) // host dimensions commit before the terminal callback
    f.host.fault = { code: 'ERR_TIMEOUT', message: 'resize callback exhausted the engine turn' }
    throw Object.assign(new Error('metrics transport saw a terminal callback error'), { code: 'ERR_ENGINE' })
  }
  const metrics = f.request('metrics', { windowWidth: 667, windowHeight: 375 })
  await until(() => f.final(metrics))
  const result = f.final(metrics).payload
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'ERR_ENGINE', 'error-path health observation must preserve the original operation error')
  assert.equal(result.error.message, 'metrics transport saw a terminal callback error')
  const faults = f.sent.slice(before).filter(message => message.kind === 'event' && message.op === 'fault')
  assert.equal(faults.length, 1, 'a recorded Rust execution fault must become visible without a later observation turn')
  assert.equal(faults[0].payload.origin, 'runtime')
  assert.equal(faults[0].payload.error.code, 'ERR_TIMEOUT')
  assert.equal(faults[0].payload.requiresRestart, true)
  assert.equal(f.host.pollCount, 0, 'a timer must not discover the fault for this assertion')
  assert.equal(f.sent.slice(before).some(message => message.kind === 'event' && message.op === 'dirty'), false)
  const frame = f.request('frame')
  await until(() => f.final(frame))
  assert.equal(f.final(frame).payload.status, 'error')
  assert.equal(f.final(frame).payload.error.code, 'ERR_ENGINE')
  assert.equal(f.host.evaluations, 0, 'faulted business admission must not evaluate a View')
  const closing = f.request('close')
  await until(() => f.final(closing))
  assert.equal(f.final(closing).payload.result.closed, true)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.log.some(entry => entry.method === 'dispatch' && entry.request.op === 'app.lifecycle'
    && entry.request.payload.event === 'unload'), false, 'faulted close must not execute another application lifecycle callback')
})

test('an explicit state refresh publishes dirty for dimensions that committed before metrics rejected', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  const dirty = () => f.sent.filter(event => event.kind === 'event' && event.op === 'dirty')
  const before = dirty().length
  f.host.options.metricsError = Object.assign(new Error('resize hook failed after commit'), { code: 'ERR_ENGINE' })
  const metrics = f.request('metrics', { windowWidth: 667, windowHeight: 375, pixelRatio: 2 })
  await until(() => f.final(metrics))
  assert.equal(f.final(metrics).payload.status, 'error')
  assert.equal(dirty().length, before, 'error catch itself does not publish a dirty event')
  const state = f.request('state')
  await until(() => f.final(state))
  const actual = f.final(state).payload.result
  assert.equal(f.final(state).payload.status, 'ok')
  assert.deepEqual(actual.viewport, { width: 667, height: 375 })
  assert.equal(actual.requiresRestart, false)
  assert.equal(dirty().length, before + 1)
  assert.deepEqual(dirty().at(-1).payload.viewport, actual.viewport)
  assert.equal(dirty().at(-1).payload.templateRevision, actual.templateRevision)
  assert.equal(f.host.pollCount, 0)
  assert.equal(f.host.evaluations, 0, 'refreshing observations does not evaluate a View')
})

// An old WASM export may expose runtime_state_json without the new fields.
// Reject it during load and release the host, before admitting business timers.
test('startup rejects an old host without scheduling fields and disposes it exactly once', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { suspendPump: true, host: { onLoad(host) {
    const readState = host.runtime_state_json.bind(host)
    host.runtime_state_json = () => {
      const state = JSON.parse(readState())
      delete state.templateRevision
      delete state.declaredRendererProfile
      return JSON.stringify(state)
    }
  } } })
  const loading = f.request('load')
  f.resolveInitialization()
  await until(() => f.final(loading))
  const response = f.final(loading)
  assert.equal(response.payload.status, 'error')
  assert.equal(response.payload.error.code, 'ERR_ENGINE')
  assert.deepEqual(f.sent.filter(message => message.kind === 'response' && message.requestId === loading.message.requestId)
    .map(message => message.payload.status), ['queued', 'error'])
  assert.equal(f.sent.some(message => message.kind === 'event' && message.op === 'dirty'), false,
    'failed startup must never announce a runnable owner')
  assert.equal(f.host.pollCount, 0)
  assert.equal(f.host.evaluations, 0)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  const frame = f.request('frame')
  await until(() => f.final(frame))
  assert.equal(f.final(frame).payload.status, 'error')
  assert.equal(f.final(frame).payload.error.code, 'ERR_ENGINE')
  const closing = f.request('close')
  await until(() => f.final(closing))
  assert.deepEqual(f.final(closing).payload.result, { closed: true, diagnostics: [] })
  assert.equal(f.host.pollCount, 0)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
})

test('runtime state rejects absent, fractional and out-of-budget authoritative dimensions', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  for (const value of [undefined, { width: 0, height: 667 }, { width: 375.5, height: 667 }, { width: 375, height: 4097 }]) {
    f.host.viewport = value
    const state = f.request('state')
    await until(() => f.final(state))
    assert.equal(f.final(state).payload.error.code, 'ERR_ENGINE')
  }
  f.host.viewport = { width: 320, height: 640 }
  const restored = f.request('state')
  await until(() => f.final(restored))
  assert.deepEqual(f.final(restored).payload.result.viewport, f.host.viewport)
})

test('absolute monotonic load deadline rejects a late constructor and releases its actual host', { timeout: 5000 }, async t => {
  let elapsed = 0
  const f = fixture(t, { monotonicClock: () => elapsed, afterCreateHost: () => { elapsed = 31 } })
  await assert.rejects(f.load({ loadTimeoutMs: 30 }), error => error.code === 'ERR_TIMEOUT')
  assert.equal(f.log.filter(entry => entry.method === 'load').length, 0)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.events.some(event => event.op === 'dirty'), false)
})

test('startup narrows Rust budgets and emits exact u64 per-phase deadlines without renewing the total', { timeout: 5000 }, async t => {
  let elapsed = 0, wall = 1720000000123
  const f = fixture(t, { monotonicClock: () => elapsed, clock: () => wall,
    host: {
      onLoad: () => { elapsed += 10 },
      onDispatch: request => {
        if (request.op === 'app.init') { elapsed += 10; wall += 10 }
        if (request.op === 'app.lifecycle' && request.payload.event === 'launch') { elapsed += 10; wall += 10 }
      },
    } })
  await f.load({ loadTimeoutMs: 100 })
  assert.deepEqual(f.host.config.engine_execution, { bootstrap_timeout_ms: 100, turn_timeout_ms: 100 })
  const startup = f.log.filter(entry => entry.method === 'dispatch' && ['app.init', 'app.lifecycle', 'page.push'].includes(entry.request.op))
  assert.equal(startup.length, 3)
  const deadlines = startup.map(entry => {
    const token = entry.json.match(/,"deadlineNs":([0-9]+)}$/)
    assert.ok(token, 'startup deadline must be a numeric JSON token, never a string or rounded Number')
    return BigInt(token[1])
  })
  assert.deepEqual(deadlines, Array(3).fill(1720000000213000000n))
  assert.ok(deadlines[0] > BigInt(Number.MAX_SAFE_INTEGER))
})

test('startup cannot report ready after synchronous app effects exceed the load deadline', { timeout: 5000 }, async t => {
  let elapsed = 0
  const f = fixture(t, { monotonicClock: () => elapsed, host: {
    onDispatch: request => { if (request.op === 'page.push') elapsed = 51 },
  } })
  await assert.rejects(f.load({ loadTimeoutMs: 50 }), error => error.code === 'ERR_TIMEOUT')
  assert.ok(f.log.some(entry => entry.method === 'dispatch' && entry.request.op === 'page.push'), 'do not claim already-run effects were rolled back')
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.events.some(event => event.op === 'dirty'), false)
})

test('a sticky Rust execution fault during startup retains only diagnostics until finite exact-owner close', { timeout: 5000 }, async t => {
  const f = fixture(t, { host: {
    onDispatch: (request, host) => {
      if (request.op === 'app.init') host.fault = { code: 'ERR_TIMEOUT', message: 'fixture startup execution deadline' }
    },
  } })
  await assert.rejects(f.load(), error => error.code === 'ERR_ENGINE')
  const state = await f.client.requestHost('state', {})
  assert.equal(state.requiresRestart, true)
  assert.equal(state.executionFault.code, 'ERR_TIMEOUT')
  assert.equal(state.workerFault, undefined)
  assert.equal(f.events.filter(event => event.op === 'fault' && event.payload.origin === 'runtime').length, 1)
  await delay(40)
  assert.equal(f.host.pollCount, 0)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 0)
  await assert.rejects(f.load(), error => error.code === 'ERR_INVALID_REQUEST')
  await assert.rejects(f.client.requestHost('frame', {}), error => error.code === 'ERR_ENGINE')
  assert.equal((await f.client.close({ timeoutMs: 500 })).closed, true)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.log.some(entry => entry.method === 'dispatch' && entry.request.op === 'app.lifecycle'), false)
  assert.equal(f.worker.terminated, 1)
})

test('events.ack validates the entire batch and releases only exact sent event credits', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  const events = f.sent.filter(message => message.kind === 'event')
  const ids = events.map(message => message.requestId)
  assert.equal(ids.length, 4)
  const invalid = f.request('events.ack', { eventIds: [ids[0], 'worker-event-99999'] })
  await until(() => f.final(invalid))
  assert.equal(f.final(invalid).payload.error.code, 'ERR_INVALID_REQUEST')
  const one = f.request('events.ack', { eventIds: [ids[0]] })
  await until(() => f.final(one))
  const result = f.final(one).payload.result
  assert.deepEqual(result.acknowledged, [ids[0]])
  assert.equal(result.pendingCount, events.length - 1)
  assert.equal(result.pendingBytes, events.slice(1).reduce((sum, event) => sum + measureWorkerPayload(event), 0))
  const retry = f.request('events.ack', { eventIds: [ids[0]] })
  await until(() => f.final(retry))
  assert.deepEqual(f.final(retry).payload.result, result, 'an already-acknowledged ID cannot expand credit')
  const duplicate = f.request('events.ack', { eventIds: [ids[1], ids[1]] })
  await until(() => f.final(duplicate))
  assert.equal(f.final(duplicate).payload.error.code, 'ERR_INVALID_REQUEST')
  const rest = f.request('events.ack', { eventIds: ids.slice(1) })
  await until(() => f.final(rest))
  assert.equal(f.final(rest).payload.result.pendingCount, 0)
  assert.equal(f.final(rest).payload.result.pendingBytes, 0)
})

test('normal event count saturation has one owner-fault reserve, exact acks and an independent close', { timeout: 5000 }, async t => {
  const f = await loadedRawOwner(t)
  const initial = f.sent.filter(message => message.kind === 'event').map(message => message.requestId)
  const cleared = f.request('events.ack', { eventIds: initial })
  await until(() => f.final(cleared))
  for (let index = 0; index <= WORKER_EVENT_LIMITS.count; index++) {
    f.host.viewRevision++
    const state = f.request('state')
    await until(() => f.final(state))
  }
  const pending = f.sent.filter(message => message.kind === 'event' && !initial.includes(message.requestId))
  assert.equal(pending.filter(message => message.op === 'dirty').length, WORKER_EVENT_LIMITS.count)
  const faults = pending.filter(message => message.op === 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].payload.origin, 'owner')
  assert.equal(faults[0].payload.error.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(faults[0].payload.undelivered.op, 'dirty')
  assert.ok(measureWorkerPayload(faults[0]) <= WORKER_EVENT_LIMITS.criticalBytes)
  const state = f.request('state')
  await until(() => f.final(state))
  assert.equal(f.final(state).payload.result.requiresRestart, true)
  assert.equal(f.final(state).payload.result.executionFault, null, 'owner backpressure is not a fabricated Rust execution fault')
  assert.equal(f.final(state).payload.result.workerFault.code, 'ERR_RPC_BACKPRESSURE')
  const frame = f.request('frame')
  await until(() => f.final(frame))
  assert.equal(f.final(frame).payload.error.code, 'ERR_ENGINE')
  for (const op of ['retire', 'abort']) {
    const control = f.request(op, op === 'retire' ? { reason: 'owner-fault' } : { key: {} })
    await until(() => f.final(control))
    assert.equal(f.final(control).payload.error.code, 'ERR_ENGINE')
  }
  const normals = f.request('events.ack', { eventIds: pending.filter(message => message.op !== 'fault').map(message => message.requestId) })
  await until(() => f.final(normals))
  assert.equal(f.final(normals).payload.result.pendingCount, 1)
  assert.equal(f.final(normals).payload.result.pendingBytes, measureWorkerPayload(faults[0]))
  const critical = f.request('events.ack', { eventIds: [faults[0].requestId] })
  await until(() => f.final(critical))
  assert.equal(f.final(critical).payload.result.pendingCount, 0)
  const closing = f.request('close')
  await until(() => f.final(closing))
  assert.equal(f.final(closing).payload.result.closed, true)
  assert.equal(f.sent.filter(message => message.kind === 'event' && message.op === 'fault').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.log.some(entry => entry.method === 'retire'), false, 'owner-fault close must not invoke terminal contact JS')
  assert.equal(f.log.some(entry => entry.method === 'dispatch' && entry.request.op === 'app.lifecycle'
    && entry.request.payload.event === 'unload'), false)
  assert.equal(f.host.fault, null, 'transport backpressure must never fabricate a Rust execution fault')
})

test('a slow event consumer reaches the byte ceiling without a normal-error recursion or extra timer turns', { timeout: 5000 }, async t => {
  const f = fixture(t, { onEvent: () => new Promise(() => {}), host: { timerMessage: 'x'.repeat(2 * 1024 * 1024) } })
  await f.load()
  await until(() => f.events.some(message => message.op === 'fault'))
  const normal = f.events.filter(message => message.op !== 'fault')
  const faults = f.events.filter(message => message.op === 'fault')
  assert.ok(normal.length < WORKER_EVENT_LIMITS.count, 'fixture must saturate bytes before count')
  assert.ok(normal.reduce((sum, message) => sum + measureWorkerPayload(message), 0) <= WORKER_EVENT_LIMITS.bytes)
  assert.equal(faults.length, 1)
  assert.equal(faults[0].payload.error.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(faults[0].payload.undelivered.op, 'batch')
  assert.ok(faults[0].payload.undelivered.bytes > 0)
  const count = f.host.pollCount
  await delay(40)
  assert.equal(f.host.pollCount, count)
  const state = await f.client.requestHost('state', {})
  assert.equal(state.workerFault.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(state.executionFault, null)
  assert.equal(state.requiresRestart, true)
  assert.equal((await f.bridge('diagnostic', { message: 'fault diagnostics remain usable' })).messages[0].payload.ok, true)
  assert.equal((await f.client.close()).closed, true)
})

test('an oversized first timer event uses the small fault slot rather than posting its pixels or batch', { timeout: 5000 }, async t => {
  const f = fixture(t, { host: { timerMessage: 'x'.repeat(9 * 1024 * 1024) } })
  await f.load()
  await until(() => f.events.some(message => message.op === 'fault'))
  const faults = f.events.filter(message => message.op === 'fault')
  assert.equal(faults.length, 1)
  assert.ok(faults[0].payload.undelivered.bytes > WORKER_EVENT_LIMITS.bytes)
  assert.ok(measureWorkerPayload(faults[0]) <= WORKER_EVENT_LIMITS.criticalBytes)
  assert.equal(f.events.some(message => message.op === 'batch' && message.payload.messages.some(inner => inner.payload?.message?.length > 1024)), false)
  assert.equal((await f.client.close()).closed, true)
})

test('a broken reserved fault-event post disposes the owner without a detached task rejection', { timeout: 5000 }, async t => {
  const unhandled = []
  const track = error => unhandled.push(error)
  process.on('unhandledRejection', track)
  t.after(() => process.removeListener('unhandledRejection', track))
  const f = fixture(t, { host: { timerMessage: 'x'.repeat(9 * 1024 * 1024) },
    rejectSend: message => message.kind === 'event' && message.op === 'fault' })
  await f.load()
  await until(() => f.log.some(entry => entry.method === 'free'))
  await delay(20)
  assert.equal(unhandled.length, 0)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  await assert.rejects(f.client.close({ timeoutMs: 50 }), error => error.code === 'ERR_RPC_TIMEOUT')
  assert.equal(f.worker.terminated, 1)
})


// Optional external contract tests. The fake host is not native/WASM evidence.
const EXTERNAL_V1 = { renderer: 'external-frame', externalPresentation: { version: '1.0' } }
const SCALE_V1 = { ...EXTERNAL_V1, renderScaleContract: { version: '1.0' } }
const INPUT_TIMING_V1 = { ...EXTERNAL_V1, observation: { version: '1.0' }, inputTiming: { version: '1.0' } }
const ackMessage = (op = 'diagnostic', payload = { message: 'preserved ACK effect' }) => ({
  protocolVersion: '1.0', sessionId: 'session-fixture', requestId: '', kind: 'event', op, payload,
})

test('initial density requires explicit versioned Worker scale negotiation before native host construction', async t => {
  for (const renderScaleContract of [undefined, null, { version: '0.9' }, { version: '2.0' }, { version: '1.0', extra: true }]) {
    const f = fixture(t)
    await assert.rejects(f.load({ ...EXTERNAL_V1, renderScale: 2,
      ...(renderScaleContract === undefined ? {} : { renderScaleContract }) }), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(f.host, undefined)
    assert.equal(f.log.some(entry => entry.method === 'dispatch'), false)
  }
  const f = fixture(t)
  await assert.rejects(f.load({ renderScaleContract: { version: '1.0' } }), { code: 'ERR_PROTOCOL_VERSION' })
  assert.equal(f.host, undefined)
})

test('causal input diagnostics negotiate explicitly without changing legacy or unsupported startup', async t => {
  const legacy = fixture(t); const result = await legacy.load(EXTERNAL_V1)
  assert.equal(Object.hasOwn(result, 'inputTiming'), false)
  const frame = await legacy.client.requestHost('frame', {}); assert.equal(Object.hasOwn(frame, 'inputTiming'), false)
  for (const options of [{ ...INPUT_TIMING_V1, inputTiming: { version: '2.0' } },
    { ...INPUT_TIMING_V1, inputTiming: { version: '1.0', extra: true } },
    { ...EXTERNAL_V1, inputTiming: { version: '1.0' } }, { inputTiming: { version: '1.0' } }]) {
    const f = fixture(t); await assert.rejects(f.load(options), { code: 'ERR_PROTOCOL_VERSION' }); assert.equal(f.host, undefined)
  }
})

test('actual Worker outer request ids and changed data revision bind original clones; retained frames cannot absorb later inputs', async t => {
  const f = fixture(t, { host: { onDispatch(request, host) {
    if (request.op === 'event.batch') { host.templateRevision++; host.viewRevision++ }
  } } })
  const loaded = await f.load(INPUT_TIMING_V1)
  assert.equal(loaded.inputTiming.compositor, 'missing'); assert.equal(loaded.inputTiming.physicalDisplay, 'missing')
  const input = async sampleId => f.client.requestHost('bridge', { envelope: { protocolVersion: '1.0', sessionId: f.client.sessionId,
    requestId: `inner-${sampleId}`, kind: 'request', op: 'event.batch', payload: { events: [{ type: 'tap', x: 1, y: 1 }] } },
  inputTiming: { version: '1.0', sampleIds: [sampleId] } })
  const applied = await input('1')
  const actual = f.sent.findLast(message => message.op === 'bridge' && message.kind === 'response' && message.payload.status === 'ok')
  assert.equal(applied.inputTiming.requestId, actual.requestId)
  assert.equal(applied.inputTiming.innerRequestId, 'inner-1')
  assert.equal(applied.inputTiming.before.templateRevision, '1'); assert.equal(applied.inputTiming.after.templateRevision, '2')
  const first = await f.client.requestHost('frame', {})
  assert.equal(first.inputTiming.capturedThrough, '1'); assert.equal(first.inputTiming.applied[0].association, 'exact-data-revision')
  await input('2')
  const retained = await f.client.requestHost('frame.current', {})
  assert.deepEqual(retained.inputTiming, first.inputTiming, 'latest applied input must not be pasted onto an old native clone')
  assert.equal(f.host.evaluations, 1)
  const second = await f.client.requestHost('frame', {})
  assert.equal(second.inputTiming.capturedThrough, '2')
  assert.equal(second.inputTiming.applied[0].association, 'ordered-only')
  assert.equal(second.inputTiming.applied[1].association, 'exact-data-revision')
  await f.client.requestHost('scale', { scale: 2 })
  const scaled = await f.client.requestHost('frame.current', {})
  assert.deepEqual(scaled.inputTiming, second.inputTiming); assert.equal(f.host.evaluations, 2)
  f.host.templateRevision++ // Explicit unrelated timer/state change before another original render.
  const timerFrame = await f.client.requestHost('frame', {})
  assert.ok(timerFrame.inputTiming.applied.every(receipt => receipt.association === 'ordered-only'))
})

test('diagnostic native lifetime transitions stay unknown until the ordinary observation path commits generation',async t=>{
  const f=fixture(t,{host:{onDispatch(request,host){if(request.op==='event.batch'){host.templateRevision++;host.inputLifetimeRevision++}}}})
  await f.load(INPUT_TIMING_V1)
  const result=await f.client.requestHost('bridge',{envelope:{protocolVersion:'1.0',sessionId:f.client.sessionId,
    requestId:'inner-transition',kind:'request',op:'event.batch',payload:{events:[{type:'tap',x:1,y:1}]}},
  inputTiming:{version:'1.0',sampleIds:['1']}})
  assert.equal(result.inputTiming.before.surfaceGeneration,'1')
  assert.equal(result.inputTiming.after.surfaceGeneration,null)
  assert.notEqual(result.inputTiming.before.inputLifetimeRevision,result.inputTiming.after.inputLifetimeRevision)
  const frame=await f.client.requestHost('frame',{})
  assert.equal(frame.inputTiming.applied[0].association,'ordered-only')
  assert.equal(frame.scheduling.consumedInput.templateRevision,result.inputTiming.after.templateRevision)
})

test('external contract is opt-in and a missing export fails before load or app.init', async t => {
  for (const missing of ['external_presentation_contract_json', 'last_frame_input_json', 'render_target_json', 'acknowledge_presentation_outcome_json']) {
    const f = fixture(t, { afterCreateHost: host => { host[missing] = undefined } })
    const result = await outcome(f.load(EXTERNAL_V1))
    assert.equal(result.error.code, 'ERR_PROTOCOL_VERSION')
    assert.equal(f.log.some(entry => entry.method === 'load' || entry.method === 'dispatch'), false)
  }
})

test('unsupported external request/handshake versions and DOM selection reject explicitly', async t => {
  const invalidRequest = fixture(t)
  assert.equal((await outcome(invalidRequest.load({ renderer: 'external-frame', externalPresentation: { version: '2.0' } }))).error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(invalidRequest.host, undefined)
  const oldContract = fixture(t, { host: { externalContract: { version: '1.0', consumedInput: '0.9', ackOutcome: '1.0' } } })
  assert.equal((await outcome(oldContract.load(EXTERNAL_V1))).error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(oldContract.log.some(entry => entry.method === 'dispatch'), false)
  const dom = fixture(t)
  assert.equal((await outcome(dom.load({ externalPresentation: { version: '1.0' } }))).error.code, 'ERR_UNSUPPORTED_CAPABILITY')
  assert.equal(dom.host, undefined)
})

test('legacy load/frame/ACK shapes work without any new contract exports', async t => {
  const f = fixture(t, { afterCreateHost(host) {
    host.external_presentation_contract_json = undefined
    host.last_frame_input_json = undefined
    host.render_target_json = undefined
    host.acknowledge_presentation_outcome_json = undefined
  } })
  const loaded = await f.load({ renderer: 'external-frame' })
  assert.equal(Object.hasOwn(loaded, 'externalPresentation'), false)
  const frame = await f.client.requestHost('frame', {})
  assert.deepEqual(Object.keys(frame).sort(), ['batch', 'frame', 'renderRevision', 'viewRevision'])
  const final = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.deepEqual(final, { messages: [] })
  assert.equal(f.log.some(entry => entry.method === 'external.handshake' || entry.method === 'frame.input'), false)
})

test('frame returns frozen exact clone proof before hooks/ACK; ACK never updates it', async t => {
  const f = fixture(t, { host: {
    onFramePrepared(host) { host.templateRevision++; host.viewRevision++ },
    readyMutates: true,
  } })
  const loaded = await f.load(EXTERNAL_V1)
  assert.deepEqual(loaded.externalPresentation, { version: '1.0', consumedInput: '1.0', ackOutcome: '1.0', physicalTarget: '1.0' })
  const result = await f.client.requestHost('frame', {})
  const scheduling = copyExternalFrameScheduling(result.scheduling, { sessionId: f.client.sessionId, renderRevision: result.renderRevision, frame: result.frame })
  const consumed = scheduling.consumedInput.templateRevision
  assert.ok(BigInt(consumed) < f.host.templateRevision)
  assert.equal(f.log.some(entry => entry.method === 'ack'), false)
  const sent = f.sent.findLast(message => message.op === 'frame' && message.payload.status === 'ok')
  assert.equal(Object.isFrozen(sent.payload.result.scheduling.consumedInput.viewport), true)
  const final = await f.client.requestHost('ack', { renderRevision: result.renderRevision })
  assert.equal(final.acknowledged, true)
  assert.equal(final.inputEnabled, true)
  assert.ok(BigInt(final.observedState.templateRevision) > BigInt(consumed))
  assert.equal(Object.hasOwn(final, 'consumedInput'), false)
  assert.equal(Object.hasOwn(final, 'scheduling'), false)
  assert.equal(scheduling.consumedInput.templateRevision, consumed)
})

test('frame.current after retained scale carries old clone input without another evaluation', async t => {
  const f = fixture(t)
  await f.load(EXTERNAL_V1)
  const first = await f.client.requestHost('frame', {})
  await f.client.requestHost('ack', { renderRevision: first.renderRevision })
  f.host.templateRevision++; f.host.viewRevision++
  await f.client.requestHost('scale', { scale: 2 })
  const current = await f.client.requestHost('frame.current', {})
  assert.notEqual(current.renderRevision, first.renderRevision)
  assert.deepEqual(current.scheduling.consumedInput, first.scheduling.consumedInput)
  assert.equal(f.host.evaluations, 1)
  assert.equal(f.log.filter(entry => entry.method === 'frame.input').length, 2)
  assert.equal(first.target.width, first.frame.viewport.width)
  assert.equal(current.target.width, first.target.width * 2)
  assert.equal(current.target.height, first.target.height * 2)
  assert.equal(current.target.renderRevision, current.renderRevision)
  const copied = copyExternalFrameTarget(current.target, { sessionId: f.client.sessionId, renderRevision: current.renderRevision })
  assert.ok(Object.isFrozen(copied))
  current.target.width = 1
  assert.notEqual(copied.width, 1)
})

test('first exported 375x667 frame has validated 750x1334 target without a second View evaluation', async t => {
  const f = fixture(t)
  const loaded = await f.load({ ...SCALE_V1, renderScale: 2 })
  assert.deepEqual(loaded.renderScaleContract, { version: '1.0', density: 'finite-positive-up-to-4',
    startup: 'before-first-export', target: 'native-exact-revision-v1', update: 'retained-layout', metrics: 'unchanged' })
  assert.equal(f.host.evaluations, 0)
  assert.equal(f.log.some(entry => entry.method === 'scale'), false, 'scale needs the first accepted native layout')
  const first = await f.client.requestHost('frame', {})
  assert.deepEqual(first.frame.viewport, { x: 0, y: 0, width: 375, height: 667 })
  assert.deepEqual(first.target, { version: '1.0', sessionId: loaded.state.sessionId,
    renderRevision: first.renderRevision, width: 750, height: 1334 })
  assert.equal(f.host.evaluations, 1)
  assert.equal(f.log.filter(entry => entry.method === 'scale').length, 1)
  assert.equal(f.log.some(entry => entry.method === 'metrics'), false)
  const current = await f.client.requestHost('frame.current', {})
  assert.deepEqual(current.target, first.target)
})

test('density configured before the first frame publishes only its latest validated target', async t => {
  const f = fixture(t)
  await f.load({ ...SCALE_V1, renderScale: 2 })
  await f.client.requestHost('scale', { scale: 3 })
  assert.equal(f.log.some(entry => entry.method === 'scale'), false)
  const first = await f.client.requestHost('frame', {})
  assert.equal(first.target.width, 1125); assert.equal(first.target.height, 2001)
  assert.equal(f.host.evaluations, 1)
  assert.deepEqual(f.log.filter(entry => entry.method === 'scale').map(entry => entry.scale), [3])
})

test('fractional captured density exports the exact ceiled native target after one View evaluation', async t => {
  for (const scale of [1.25, 1.75]) {
    const f = fixture(t)
    const loaded = await f.load({ ...SCALE_V1, renderScale: scale })
    const frame = await f.client.requestHost('frame', {})
    assert.deepEqual(frame.target, { version: '1.0', sessionId: loaded.state.sessionId, renderRevision: frame.renderRevision,
      width: Math.ceil(375 * scale), height: Math.ceil(667 * scale) })
    assert.equal(f.host.evaluations, 1)
    assert.deepEqual(f.log.filter(entry => entry.method === 'scale').map(entry => entry.scale), [scale])
  }
})

test('initial density rejects unsupported or over-budget targets before host construction', async t => {
  for (const options of [{ ...SCALE_V1, renderScale: 3, viewport: { width: 1000, height: 1000 } },
    { renderer: 'external-frame', renderScale: 2 },
    { renderer: 'browser-view', externalPresentation: { version: '1.0' }, renderScale: 2 }]) {
    const f = fixture(t)
    await assert.rejects(f.load(options))
    assert.equal(f.host, undefined)
    assert.equal(f.log.some(entry => entry.method === 'dispatch'), false)
  }
})

test('a native host cannot silently keep a 1x target after accepting initial 2x density', async t => {
  const f = fixture(t, { host: { frameTargetOverride: value => ({ ...value, width: 375, height: 667 }) } })
  await f.load({ ...SCALE_V1, renderScale: 2 })
  await assert.rejects(f.client.requestHost('frame', {}), { code: 'ERR_RENDER' })
  assert.equal(f.host.evaluations, 1)
  assert.equal(f.log.some(entry => entry.method === 'ack'), false)
})

test('over-budget density and native rejection preserve retained target, session and clone input', async t => {
  const f = fixture(t, { host: { onScale(scale) { if (scale === 1.5) throw Object.assign(new Error('fixture target allocation rejected'), { code: 'ERR_RENDER' }) } } })
  await f.load({ ...SCALE_V1, viewport: { width: 1000, height: 1000 }, renderScale: 2 })
  const first = await f.client.requestHost('frame', {})
  for (const scale of [3, 1.5]) {
    await assert.rejects(f.client.requestHost('scale', { scale }), { code: 'ERR_RENDER' })
    const current = await f.client.requestHost('frame.current', {})
    assert.deepEqual(current.target, first.target)
    assert.deepEqual(current.scheduling, first.scheduling)
    assert.equal(f.host.evaluations, 1)
  }
  assert.deepEqual(f.log.filter(entry => entry.method === 'scale').map(entry => entry.scale), [2])
})

test('physical target requires exact identity, bounded allocation and plain data before ACK', async t => {
  for (const frameTargetOverride of [
    value => ({ ...value, sessionId: 'other-session' }),
    value => ({ ...value, renderRevision: '0' }),
    value => ({ ...value, width: 0 }),
    value => ({ ...value, width: 1.5 }),
    value => ({ ...value, width: 4097 }),
    value => ({ ...value, width: 4096, height: 4096 }),
  ]) {
    const f = fixture(t, { host: { frameTargetOverride } })
    await f.load(EXTERNAL_V1)
    const failed = await outcome(f.client.requestHost('frame', {}))
    assert.ok(failed.error, 'malformed physical target must fail before ACK')
    assert.equal(f.log.some(entry => entry.method === 'ack'), false)
  }
  let read = false
  const target = { version: '1.0', sessionId: 'session-fixture', renderRevision: '1', height: 1,
    get width() { read = true; return 1 } }
  assert.throws(() => copyExternalFrameTarget(target, { sessionId: 'session-fixture', renderRevision: '1' }))
  assert.equal(read, false)
})

test('missing clone proof stays null instead of claiming latest state', async t => {
  const f = fixture(t, { host: { frameProofOverride: value => ({ ...value, consumedInput: null }) } })
  await f.load(EXTERNAL_V1)
  const result = await f.client.requestHost('frame', {})
  assert.equal(result.scheduling.consumedInput, null)
})

test('wrong frame identity/revision/geometry or numeric template token fails before ACK', async t => {
  const changes = [
    value => ({ ...value, sessionId: 'other-session' }),
    value => ({ ...value, renderRevision: '0' }),
    value => ({ ...value, consumedInput: { ...value.consumedInput, templateRevision: 1 } }),
    value => ({ ...value, consumedInput: { ...value.consumedInput, viewport: { ...value.consumedInput.viewport, width: 1 } } }),
  ]
  for (const frameProofOverride of changes) {
    const f = fixture(t, { host: { frameProofOverride } })
    await f.load(EXTERNAL_V1)
    const result = await outcome(f.client.requestHost('frame', {}))
    assert.ok(['ERR_CANCELLED', 'ERR_PROTOCOL_VERSION'].includes(result.error.code))
    assert.equal(f.log.some(entry => entry.method === 'ack'), false)
  }
})

test('structured ACK preserves complete effects and ordinary ready setData input stays true', async t => {
  const messages = [ackMessage(), ackMessage('api.result', { ok: true, value: { nested: [1, 'two'] } })]
  const f = fixture(t, { host: { readyMutates: true, ackMessages: messages } })
  await f.load(EXTERNAL_V1)
  const frame = await f.client.requestHost('frame', {})
  const final = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.deepEqual(final.batch, { messages })
  assert.equal(final.inputEnabled, true)
  assert.equal(final.observedState.renderRevision, frame.renderRevision)
  assert.ok(BigInt(final.observedState.templateRevision) > BigInt(frame.scheduling.consumedInput.templateRevision))
  const duplicate = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.deepEqual(duplicate.batch, { messages: [] })
  assert.equal(duplicate.inputEnabled, true)
})

test('ordinary ready error is sticky across empty duplicate ACK without replaying errors', async t => {
  const messages = [ackMessage('error', { ok: false, committed: true, error: { code: 'ERR_ENGINE', message: 'ordinary ready error' } })]
  const f = fixture(t, { host: { ackMessages: messages } })
  await f.load(EXTERNAL_V1)
  const frame = await f.client.requestHost('frame', {})
  const final = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.equal(final.acknowledged, true)
  assert.equal(final.inputEnabled, false)
  assert.equal(final.requiresRestart, false)
  assert.deepEqual(final.batch.messages, messages)
  const duplicate = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.equal(duplicate.inputEnabled, false)
  assert.deepEqual(duplicate.batch.messages, [])
})

test('ACK navigation across renderer family preserves batch and reports policy restart', async t => {
  const messages = [ackMessage('page.push', { path: SECOND })]
  const f = fixture(t, {
    manifestFields: { rendering: { version: '1.0', default: 'skia', pages: { [SECOND]: 'webview' } } },
    host: { ackMessages: messages, onAcknowledge(host) {
      host.currentPage = { pageId: '2', path: SECOND }; host.frameInput = null
      host.viewRevision++; host.templateRevision++
    } },
  })
  await f.load({ renderer: 'auto', rendererPolicy: { mode: 'manifest' }, externalPresentation: { version: '1.0' } })
  const frame = await f.client.requestHost('frame', {})
  const final = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.equal(final.acknowledged, true)
  assert.equal(final.inputEnabled, false)
  assert.equal(final.requiresRestart, true)
  assert.equal(final.observedState.reason, 'renderer-profile-change')
  assert.equal(final.observedState.currentPage.path, SECOND)
  assert.equal(final.observedState.executionFault, null)
  assert.deepEqual(final.batch.messages, messages)
})

test('hide/show, resize and retire do not reactivate old acknowledged pixels', async t => {
  for (const boundary of ['hide-show', 'resize', 'retire']) {
    const f = fixture(t)
    await f.load(EXTERNAL_V1)
    const frame = await f.client.requestHost('frame', {})
    await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
    if (boundary === 'hide-show') {
      await f.bridge('app.lifecycle', { event: 'hide' }); await f.bridge('app.lifecycle', { event: 'show' })
    } else if (boundary === 'resize') await f.client.requestHost('metrics', { windowWidth: 640, windowHeight: 360 })
    else await f.client.requestHost('retire', { reason: 'new-contract-test' })
    const duplicate = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
    assert.equal(duplicate.acknowledged, true)
    assert.equal(duplicate.inputEnabled, false, boundary)
    assert.deepEqual(duplicate.batch.messages, [])
  }
})

test('bounded ACK fault returns irreversible batch and runtime fault observation', async t => {
  const fault = { code: 'ERR_TIMEOUT', message: 'committed turn exceeded budget' }
  const messages = [ackMessage('error', { ok: false, requiresRestart: true, error: fault })]
  const f = fixture(t, { host: { ackMessages: messages, onAcknowledge(host) { host.fault = fault; host.frameInput = null } } })
  await f.load(EXTERNAL_V1)
  const frame = await f.client.requestHost('frame', {})
  const final = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.equal(final.acknowledged, true)
  assert.equal(final.inputEnabled, false)
  assert.equal(final.requiresRestart, true)
  assert.deepEqual(final.batch.messages, messages)
  assert.deepEqual(final.observedState.executionFault, fault)
})

test('malformed ACK final cannot relabel consumed input and preserves real diagnostics', async t => {
  const messages = [ackMessage()]
  for (const override of [
    value => ({ ...value, renderRevision: '999' }),
    value => ({ ...value, consumedInput: { templateRevision: '999' } }),
    value => ({ ...value, acknowledged: false, queued: true }),
  ]) {
    const f = fixture(t, { host: { ackMessages: messages, externalAckOverride: override } })
    await f.load(EXTERNAL_V1)
    const frame = await f.client.requestHost('frame', {})
    const final = await outcome(f.client.requestHost('ack', { renderRevision: frame.renderRevision }))
    assert.ok(['ERR_PROTOCOL_VERSION', 'ERR_CANCELLED'].includes(final.error.code))
    // WorkerRpcError.details is the complete wire error; its details field
    // retains the native irreversible outcome diagnostics.
    assert.deepEqual(final.error.details.details.batch.messages, messages)
    assert.equal(final.error.details.details.observedState.sessionId, f.client.sessionId)
  }
})

test('receiver helper copies/freezes fractional geometry and exact u64 tokens', () => {
  const frame = { viewport: { x: 12.5, y: -7.25, width: 100.1, height: 50.2 } }
  const value = { version: '1.0', sessionId: 'session-fixture', renderRevision: '9007199254740993',
    consumedInput: { pageId: '9007199254740995', routePath: HOME, templateRevision: '9007199254740997', viewport: { ...frame.viewport } } }
  const copy = copyExternalFrameScheduling(value, { sessionId: 'session-fixture', renderRevision: value.renderRevision, frame })
  value.consumedInput.templateRevision = '0'; value.consumedInput.viewport.width = 1
  assert.equal(copy.consumedInput.templateRevision, '9007199254740997')
  assert.deepEqual(copy.consumedInput.viewport, frame.viewport)
  assert.equal(Object.isFrozen(copy.consumedInput.viewport), true)
})

test('receiver ACK helper preserves all nested batch/state values in an independent frozen copy', () => {
  const state = { schemaVersion: 1, sessionId: 'session-fixture', currentPage: { pageId: '1', path: HOME },
    templateRevision: '9007199254740997', viewRevision: '20', renderRevision: '8', lifecycle: 'Active',
    viewport: { width: 375, height: 667 }, rendererProfile: 'skia', declaredRendererProfile: 'skia',
    executionFault: null, requiresRestart: false, additional: { preserved: [1, -0] } }
  const value = { version: '1.0', sessionId: 'session-fixture', renderRevision: '8', acknowledged: true,
    inputEnabled: false, requiresRestart: false, batch: { messages: [ackMessage('error', { error: { code: 'ERR_ENGINE' } })], extra: { keep: true } }, observedState: state }
  const copy = copyExternalPresentationOutcome(value, { sessionId: 'session-fixture', renderRevision: '8' })
  assert.deepEqual(copy, value)
  value.batch.extra.keep = false; state.additional.preserved[0] = 99
  assert.equal(copy.batch.extra.keep, true)
  assert.deepEqual(copy.observedState.additional.preserved, [1, -0])
  assert.equal(Object.isFrozen(copy.batch.messages[0].payload.error), true)
  assert.throws(() => copyExternalPresentationOutcome({ ...value, inputEnabled: true }, { sessionId: 'session-fixture', renderRevision: '8' }), error => error.code === 'ERR_PROTOCOL_VERSION')
})


test('receiver helpers reject accessors before invoking externally supplied getters', () => {
  let reads = 0
  const value = { get version() { reads++; return '1.0' } }
  assert.throws(() => copyExternalFrameScheduling(value, { sessionId: 'session-fixture', renderRevision: '1',
    frame: { viewport: { x: 0, y: 0, width: 100, height: 50 } } }), error => error.code === 'ERR_RPC_ARGUMENT')
  assert.throws(() => copyExternalPresentationOutcome(value, { sessionId: 'session-fixture', renderRevision: '1' }),
    error => error.code === 'ERR_RPC_ARGUMENT')
  assert.equal(reads, 0)
})


// Ordered lane tests exercise Worker contracts with a fake host; native
// hard-lifetime semantics have separate real-engine/source unit tests.
const OBSERVE_V1 = { observation: { version: '1.0' } }
const RECOVERY_V1 = { ...EXTERNAL_V1, ...OBSERVE_V1, surfaceRecovery: { version: '1.0' } }
function recoveryExpected(observation) {
  const state = observation.state
  return { sessionId: state.owner.sessionId, pageId: state.currentPage.pageId, routePath: state.currentPage.path,
    viewport: { ...state.viewport }, rendererProfile: state.rendererProfile, templateRevision: state.templateRevision,
    renderRevision: state.renderRevision, inputLifetimeRevision: state.inputLifetimeRevision, surfaceGeneration: state.surfaceGeneration }
}

test('surface recovery opt-in requires both existing contracts and rejects old WASM before startup', async t => {
  const absent = fixture(t)
  assert.equal((await outcome(absent.load({ renderer: 'external-frame', surfaceRecovery: { version: '1.0' } }))).error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(absent.host, undefined)
  for (const missing of ['surface_recovery_contract_json', 'recover_external_frame_json']) {
    const f = fixture(t, { afterCreateHost: host => { host[missing] = undefined } })
    assert.equal((await outcome(f.load(RECOVERY_V1))).error.code, 'ERR_PROTOCOL_VERSION')
    assert.equal(f.log.some(entry => entry.method === 'load' || entry.method === 'dispatch'), false)
  }
  const wrong = fixture(t, { host: { recoveryContract: { version: '1.0', retainedExternalFrame: '0.9' } } })
  assert.equal((await outcome(wrong.load(RECOVERY_V1))).error.code, 'ERR_PROTOCOL_VERSION')
  const legacy = fixture(t)
  await legacy.load({ ...EXTERNAL_V1, ...OBSERVE_V1 })
  const frame = await legacy.client.requestHost('frame', {})
  assert.equal((await outcome(legacy.client.requestHost('surface.recover', { version: '1.0', expected: recoveryExpected(frame.observation) }))).error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(legacy.log.some(entry => entry.method === 'surface.recover' || entry.method === 'recovery.handshake'), false)
})

test('surface recovery republishes retained input with genuine new lifetime and observation; only later ACK enables input', async t => {
  const f = fixture(t)
  const loaded = await f.load(RECOVERY_V1)
  assert.deepEqual(loaded.surfaceRecovery, { version: '1.0', retainedExternalFrame: '1.0' })
  const first = await f.client.requestHost('frame', {})
  const expected = recoveryExpected(first.observation), before = f.host.evaluations
  const recovered = await f.client.requestHost('surface.recover', { version: '1.0', expected })
  assert.equal(recovered.recovery.kind, 'retained')
  assert.equal(recovered.frame.frame_id, first.frame.frame_id)
  assert.equal(recovered.renderRevision, String(BigInt(first.renderRevision) + 1n))
  assert.equal(recovered.observation.state.surfaceGeneration, String(BigInt(expected.surfaceGeneration) + 1n))
  assert.equal(recovered.observation.state.inputLifetimeRevision, String(BigInt(expected.inputLifetimeRevision) + 1n))
  assert.deepEqual(recovered.scheduling.consumedInput, first.scheduling.consumedInput)
  assert.equal(f.host.evaluations, before)
  assert.equal(f.host.presentedRevision, null)
  const stale = await outcome(f.client.requestHost('surface.recover', { version: '1.0', expected }))
  assert.equal(stale.error.code, 'ERR_CANCELLED')
  assert.equal(f.log.filter(entry => entry.method === 'surface.recover').length, 1)
  const final = await f.client.requestHost('ack', { renderRevision: recovered.renderRevision })
  assert.equal(final.inputEnabled, true)
})

test('surface recovery with dirty retained input fences the native lifetime and requires a normal new frame', async t => {
  const f = fixture(t)
  await f.load(RECOVERY_V1)
  const first = await f.client.requestHost('frame', {})
  f.host.templateRevision++; f.host.viewRevision++
  const state = await f.client.requestHost('state', {})
  const expected = recoveryExpected(state.observation), before = f.host.evaluations
  const recovered = await f.client.requestHost('surface.recover', { version: '1.0', expected })
  assert.equal(recovered.recovery.kind, 'render-required')
  assert.equal(recovered.recovery.renderRevision, first.renderRevision)
  assert.equal(Object.hasOwn(recovered, 'frame'), false)
  assert.equal(Object.hasOwn(recovered, 'scheduling'), false)
  assert.equal(f.host.evaluations, before)
  assert.equal(f.host.frameInput, null)
  assert.equal(recovered.observation.state.surfaceGeneration, String(BigInt(expected.surfaceGeneration) + 1n))
  const next = await f.client.requestHost('frame', {})
  assert.equal(f.host.evaluations, before + 1)
  assert.equal(next.observation.state.surfaceGeneration, recovered.observation.state.surfaceGeneration)
  assert.notEqual(next.renderRevision, first.renderRevision)
})

test('surface recovery rejects every stale expected field and malformed revisions without a native mutation', async t => {
  const f = fixture(t)
  await f.load(RECOVERY_V1)
  const first = await f.client.requestHost('frame', {}), expected = recoveryExpected(first.observation)
  const changes = { sessionId: 'another-session', pageId: '99', routePath: SECOND, viewport: { ...expected.viewport, width: 400 },
    rendererProfile: 'skyline-compat', templateRevision: '99', renderRevision: '99', inputLifetimeRevision: '99', surfaceGeneration: '99' }
  for (const [key, value] of Object.entries(changes)) {
    assert.equal((await outcome(f.client.requestHost('surface.recover', { version: '1.0', expected: { ...expected, [key]: value } }))).error.code, 'ERR_CANCELLED', key)
  }
  for (const value of ['01', 1, '-1', '18446744073709551616']) {
    assert.equal((await outcome(f.client.requestHost('surface.recover', { version: '1.0', expected: { ...expected, renderRevision: value } }))).error.code, 'ERR_PROTOCOL_VERSION')
  }
  assert.equal(f.log.some(entry => entry.method === 'surface.recover'), false)
})

test('surface recovery checks lifetime/publication/generation/sequence exhaustion before native mutation', async t => {
  const maximum = '18446744073709551615'
  const ordinary = { renderRevision: '7', inputLifetimeRevision: '2', surfaceGeneration: '3' }
  assert.deepEqual(preflightSurfaceRecoveryRevisions(ordinary, '4'), {
    renderRevision: '8', inputLifetimeRevision: '3', surfaceGeneration: '4', observationSequence: '5',
  })
  for (const key of Object.keys(ordinary)) assert.throws(() => preflightSurfaceRecoveryRevisions({ ...ordinary, [key]: maximum }, '4'), error => error.code === 'ERR_ENGINE')
  assert.throws(() => preflightSurfaceRecoveryRevisions(ordinary, maximum), error => error.code === 'ERR_ENGINE')
  for (const key of ['renderRevision', 'inputLifetimeRevision']) {
    const f = fixture(t)
    await f.load(RECOVERY_V1)
    await f.client.requestHost('frame', {})
    f.host[key] = BigInt(maximum)
    const current = await f.client.requestHost('state', {})
    const expected = recoveryExpected(current.observation)
    const result = await outcome(f.client.requestHost('surface.recover', { version: '1.0', expected }))
    assert.equal(result.error.code, 'ERR_ENGINE')
    assert.equal(f.log.some(entry => entry.method === 'surface.recover'), false)
  }
})
const bridgeEnvelope = (client, op, payload) => ({ protocolVersion: '1.0', sessionId: client.sessionId,
  requestId: `ordered-${op}`, kind: 'request', op, payload })
const finalWire = (fixture, op) => fixture.sent.findLast(message => message.kind === 'response' && message.op === op && message.payload.status !== 'queued')

test('observation contract is explicit and legacy shapes never probe its host exports', async t => {
  const f = fixture(t, { afterCreateHost(host) { host.observation_contract_json = undefined; host.observation_state_json = undefined } })
  const loaded = await f.load({ renderer: 'external-frame' })
  assert.equal(Object.hasOwn(loaded, 'observationContract'), false)
  assert.equal(Object.hasOwn(loaded, 'observation'), false)
  const frame = await f.client.requestHost('frame', {})
  assert.equal(Object.hasOwn(frame, 'observation'), false)
  assert.equal(f.log.some(entry => entry.method.startsWith('observation.')), false)
})

test('missing/old observation exports and unsupported option fail before application JS', async t => {
  const invalid = fixture(t)
  assert.equal((await outcome(invalid.load({ observation: { version: '2.0' } }))).error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(invalid.host, undefined)
  for (const missing of ['observation_contract_json', 'observation_state_json']) {
    const f = fixture(t, { afterCreateHost(host) { host[missing] = undefined } })
    assert.equal((await outcome(f.load(OBSERVE_V1))).error.code, 'ERR_PROTOCOL_VERSION')
    assert.equal(f.log.some(entry => entry.method === 'load' || entry.method === 'dispatch'), false)
  }
  const old = fixture(t, { host: { observationContract: { version: '1.0', inputLifetime: '0.9' } } })
  assert.equal((await outcome(old.load(OBSERVE_V1))).error.code, 'ERR_PROTOCOL_VERSION')
  assert.equal(old.log.some(entry => entry.method === 'dispatch'), false)
})

test('successful startup creates one initial lane snapshot and no Created/partial generations', async t => {
  const f = fixture(t)
  const loaded = await f.load(OBSERVE_V1)
  assert.deepEqual(loaded.observationContract, { version: '1.0', sequence: 'u64', surfaceGeneration: '1.0', inputLifetime: '1.0' })
  assert.equal(loaded.observation.sequence, '1')
  assert.equal(loaded.observation.state.surfaceGeneration, '1')
  assert.equal(loaded.observation.state.lifecycle, 'Active')
  assert.equal(loaded.observation.state.currentPage.path, HOME)
  assert.equal(loaded.observation.state.owner.packSha256, digest(bytes(f.pack.index)))
  const noop = await f.client.requestHost('state', {})
  assert.deepEqual(noop.observation, loaded.observation)
  assert.equal(f.events.filter(event => event.op === 'dirty').some(event => event.payload.observation?.state.lifecycle === 'Created'), false)
})

test('load/state/dirty/metrics/frame/scale/ACK share original Worker sequences', async t => {
  const f = fixture(t, { host: { readyMutates: true } })
  const loaded = await f.load({ ...EXTERNAL_V1, ...OBSERVE_V1 })
  const frame = await f.client.requestHost('frame', {})
  assert.ok(BigInt(frame.observation.sequence) > BigInt(loaded.observation.sequence))
  const final = await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  assert.ok(BigInt(final.observation.sequence) > BigInt(frame.observation.sequence))
  assert.equal(final.observation.state.surfaceGeneration, '1')
  assert.ok(BigInt(final.observation.state.templateRevision) > BigInt(frame.scheduling.consumedInput.templateRevision))
  const changed = await f.client.requestHost('metrics', { windowWidth: 640, windowHeight: 360 })
  assert.equal(changed.observation.state.surfaceGeneration, '2')
  const scaled = await f.client.requestHost('scale', { scale: 2 })
  assert.equal(scaled.observation.state.surfaceGeneration, '2')
  const state = await f.client.requestHost('state', {})
  assert.deepEqual(state.observation, scaled.observation)
  const event = f.events.findLast(event => event.op === 'dirty')
  assert.deepEqual(event.payload.observation, scaled.observation)
  assert.equal(f.log.filter(entry => entry.method === 'ack').length, 1)
})

test('same-turn hide/show advances generation even with identical final page/lifecycle', async t => {
  const f = fixture(t)
  const loaded = await f.load(OBSERVE_V1)
  const page = loaded.observation.state.currentPage
  const result = await f.client.requestHost('bridge', { batch: { messages: [
    bridgeEnvelope(f.client, 'app.lifecycle', { event: 'hide' }), bridgeEnvelope(f.client, 'app.lifecycle', { event: 'show' }),
  ] } })
  assert.equal(result.messages.length, 2)
  assert.equal(result.observation.state.lifecycle, 'Active')
  assert.deepEqual(result.observation.state.currentPage, page)
  assert.equal(result.observation.state.surfaceGeneration, '2')
  assert.ok(BigInt(result.observation.state.inputLifetimeRevision) > BigInt(loaded.observation.state.inputLifetimeRevision))
})

test('same-turn push/pop returning to cached page cannot reuse old logical generation', async t => {
  const f = fixture(t)
  const loaded = await f.load(OBSERVE_V1)
  const result = await f.client.requestHost('bridge', { batch: { messages: [
    bridgeEnvelope(f.client, 'page.push', { path: SECOND }), bridgeEnvelope(f.client, 'page.pop', {}),
  ] } })
  assert.deepEqual(result.observation.state.currentPage, loaded.observation.state.currentPage)
  assert.equal(result.observation.state.surfaceGeneration, '2')
  assert.equal(f.log.filter(entry => entry.method === 'dispatch' && entry.request.op === 'page.pop').length, 1)
})

test('ordinary template data and retained density repaint change sequence without logical generation', async t => {
  const f = fixture(t)
  await f.load({ ...EXTERNAL_V1, ...OBSERVE_V1 })
  const frame = await f.client.requestHost('frame', {})
  await f.client.requestHost('ack', { renderRevision: frame.renderRevision })
  f.host.viewRevision++; f.host.templateRevision++
  const data = await f.client.requestHost('state', {})
  assert.equal(data.observation.state.surfaceGeneration, frame.observation.state.surfaceGeneration)
  await f.client.requestHost('scale', { scale: 2 })
  const retained = await f.client.requestHost('frame.current', {})
  assert.equal(retained.observation.state.surfaceGeneration, frame.observation.state.surfaceGeneration)
  assert.deepEqual(retained.scheduling.consumedInput, frame.scheduling.consumedInput)
  assert.equal(f.host.evaluations, 1)
})

test('failed metrics exposes committed viewport/token on finally without replacing original error', async t => {
  const original = new Error('resize callback failed after native commit')
  const f = fixture(t, { host: { metricsError: original } })
  await f.load(OBSERVE_V1)
  const failed = await outcome(f.client.requestHost('metrics', { windowWidth: 640, windowHeight: 360 }))
  assert.equal(failed.error.message, original.message)
  const wire = finalWire(f, 'metrics').payload.error
  assert.equal(wire.observation.state.viewport.width, 640)
  assert.equal(wire.observation.state.surfaceGeneration, '2')
  assert.deepEqual(f.events.findLast(event => event.op === 'dirty').payload.observation, wire.observation)
  assert.equal(f.log.filter(entry => entry.method === 'metrics').length, 1)
})

test('timer error publishes the refreshed committed token on the one reserved fault lane', async t => {
  const f = fixture(t, { host: { onPoll(host) { host.viewport = { width: 640, height: 360 }; host.inputLifetimeRevision++; throw new Error('timer committed then failed') } } })
  await f.load(OBSERVE_V1)
  await until(() => f.events.some(event => event.op === 'fault'))
  const faults = f.events.filter(event => event.op === 'fault')
  assert.equal(faults.length, 1)
  assert.match(faults[0].payload.error.message, /timer committed then failed/)
  assert.equal(faults[0].payload.observation.state.viewport.width, 640)
  assert.equal(faults[0].payload.observation.state.surfaceGeneration, '2')
  assert.equal(faults[0].payload.observation.state.requiresRestart, true)
})

test('ordinary DOM prepare repeats do not invent a generation or self-rebuild demand', async t => {
  const f = fixture(t)
  const loaded = await f.load(OBSERVE_V1)
  const generation = loaded.observation.state.surfaceGeneration
  for (let i = 0; i < 4; i++) {
    const result = await f.bridge('view.prepare', { version: '1.0', surfaceGeneration: generation, render: {} })
    assert.equal(result.messages[0].payload.ok, true)
    assert.equal(result.observation.sequence, loaded.observation.sequence)
    assert.equal(result.observation.state.surfaceGeneration, generation)
  }
})

test('DOM prepare and presented reject old generation before host entry; exact abort remains cleanup', async t => {
  const f = fixture(t)
  const loaded = await f.load(OBSERVE_V1)
  const old = loaded.observation.state.surfaceGeneration
  await f.bridge('app.lifecycle', { event: 'hide' }); await f.bridge('app.lifecycle', { event: 'show' })
  const before = f.log.filter(entry => entry.method === 'dispatch').length
  assert.equal((await outcome(f.bridge('view.prepare', { version: '1.0', surfaceGeneration: old, render: {} }))).error.code, 'ERR_CANCELLED')
  const key = { sessionId: f.client.sessionId, pageId: '1', surfaceGeneration: old, profile: 'webview' }
  assert.equal((await outcome(f.client.requestHost('ack', { permit: { key } }))).error.code, 'ERR_CANCELLED')
  assert.equal(f.log.filter(entry => entry.method === 'dispatch').length, before)
  await f.client.requestHost('abort', { key })
  assert.equal(f.log.filter(entry => entry.method === 'dispatch').length, before + 1)
})

test('mixed keyed DOM atomic batch fails admission without executing or splitting native work', async t => {
  const f = fixture(t)
  const loaded = await f.load(OBSERVE_V1)
  const before = f.log.filter(entry => entry.method === 'dispatch').length
  const failure = await outcome(f.client.requestHost('bridge', { batch: { messages: [
    bridgeEnvelope(f.client, 'app.lifecycle', { event: 'hide' }),
    bridgeEnvelope(f.client, 'view.prepare', { version: '1.0', surfaceGeneration: loaded.observation.state.surfaceGeneration, render: {} }),
  ] } }))
  assert.equal(failure.error.code, 'ERR_INVALID_REQUEST')
  assert.equal(f.log.filter(entry => entry.method === 'dispatch').length, before)
  assert.equal((await f.client.requestHost('state', {})).lifecycle, 'Active')
})

test('native lifetime exhaustion freezes ordinary work and never wraps generation or revives input', async t => {
  const f = fixture(t)
  await f.load({ ...EXTERNAL_V1, ...OBSERVE_V1 })
  f.host.inputLifetimeRevision = null
  const state = await f.client.requestHost('state', {})
  assert.equal(state.observation.state.inputLifetimeRevision, null)
  assert.equal(state.observation.state.requiresRestart, true)
  const fault = f.events.find(event => event.op === 'fault')
  assert.deepEqual(fault.payload.observation, state.observation)
  const rejected = await outcome(f.client.requestHost('frame', {}))
  assert.equal(rejected.error.code, 'ERR_ENGINE')
  assert.equal(f.host.evaluations, 0)
})

test('receiver preserves exact source sequence and delayed observations never get relabeled', async t => {
  const f = fixture(t)
  const initial = (await f.load(OBSERVE_V1)).observation
  const next = (await f.client.requestHost('metrics', { windowWidth: 640, windowHeight: 360 })).observation
  const owner = initial.state.owner
  const late = copyOrderedObservation(initial, owner)
  assert.ok(BigInt(late.sequence) < BigInt(next.sequence))
  assert.equal(late.sequence, initial.sequence)
  assert.equal(Object.isFrozen(late.state.owner), true)
  assert.throws(() => copyOrderedObservation(initial, { ...owner, sessionId: 'another-session' }), error => error.code === 'ERR_PROTOCOL_VERSION')
})

test('ordered counters preserve high u64 precision and exhaustion fails explicitly', () => {
  assert.equal(nextObservationU64('9007199254740993'), '9007199254740994')
  assert.equal(nextObservationU64('18446744073709551614'), '18446744073709551615')
  assert.throws(() => nextObservationU64('18446744073709551615'), error => error.code === 'ERR_ENGINE')
  assert.throws(() => nextObservationU64('01'), error => error.code === 'ERR_ENGINE')
})

test('shared data DAG freezes once per object within bounded receiver validation', () => {
  let dag = { value: 1 }
  for (let i = 0; i < 30; i++) dag = { a: dag, b: dag }
  const state = { schemaVersion: 1, sessionId: 'session-fixture', currentPage: { pageId: '1', path: HOME },
    templateRevision: '1', viewRevision: '1', renderRevision: '1', lifecycle: 'Active', viewport: { width: 375, height: 667 },
    rendererProfile: 'skia', declaredRendererProfile: 'skia', executionFault: null, requiresRestart: false, dag }
  const value = { version: '1.0', sessionId: 'session-fixture', renderRevision: '1', acknowledged: true,
    inputEnabled: false, requiresRestart: false, batch: { messages: [] }, observedState: state }
  const final = copyExternalPresentationOutcome(value, { sessionId: 'session-fixture', renderRevision: '1' })
  assert.equal(final.observedState.dag.a, final.observedState.dag.b)
  assert.equal(Object.isFrozen(final.observedState.dag.a), true)
})


test('failed application startup publishes no tentative generation and never starts queued frames', async t => {
  const f = fixture(t, { host: { providerAvailable: false } })
  const loading = outcome(f.load({ renderer: 'external-frame', ...OBSERVE_V1 }))
  const queued = outcome(f.client.requestHost('frame', {}))
  const loaded = await loading
  assert.equal(loaded.error.code, 'ERR_ENGINE')
  assert.equal((await queued).error.code, 'ERR_ENGINE')
  assert.equal(Object.hasOwn(finalWire(f, 'load').payload.error, 'observation'), false)
  assert.equal(f.events.some(event => event.op === 'dirty' && event.payload.observation), false)
  assert.equal(f.host.evaluations, 0)
  assert.equal(f.log.some(entry => entry.method === 'poll'), false)
})


// Fault-refresh regressions use a held fake-host pump; these are not browser,
// WASM, renderer or native lifetime-overflow acceptance evidence.
async function orderedRawOwnerAtNormalEventLimit(t, options = {}) {
  const f = rawOwner(t, { suspendPump: true, ...options })
  const loading = f.request('load', OBSERVE_V1)
  f.resolveInitialization()
  await until(() => f.final(loading))
  assert.equal(f.final(loading).payload.status, 'ok')
  const initialEvents = f.sent.filter(message => message.kind === 'event').map(message => message.requestId)
  const cleared = f.request('events.ack', { eventIds: initialEvents })
  await until(() => f.final(cleared))
  assert.equal(f.final(cleared).payload.result.pendingCount, 0)
  let observation = f.final(loading).payload.result.observation
  for (let index = 0; index < WORKER_EVENT_LIMITS.count; index++) {
    f.host.viewRevision++
    const state = f.request('state')
    await until(() => f.final(state))
    assert.equal(f.final(state).payload.status, 'ok')
    observation = f.final(state).payload.result.observation
  }
  assert.equal(observation.state.requiresRestart, false)
  assert.equal(f.sent.filter(message => message.kind === 'event' && message.op === 'fault').length, 0)
  return { f, observation }
}

test('finally dirty-credit failure publishes faulted observation and preserves the committed bridge batch', { timeout: 5000 }, async t => {
  const { f, observation: before } = await orderedRawOwnerAtNormalEventLimit(t, { host: {
    onDispatch(request, host) {
      if (request.op === 'module.call' && request.payload.export === 'committed') {
        host.viewRevision++; host.templateRevision++
      }
    },
  } })
  const call = rawBridge(f, 'module.call', { export: 'committed', args: [{ preserved: ['nested', 7] }] })
  await until(() => f.final(call))
  const wire = f.final(call).payload
  assert.equal(wire.status, 'error')
  assert.equal(wire.error.code, 'ERR_RPC_BACKPRESSURE')
  const committed = wire.error.details.committedResult
  assert.deepEqual(committed.messages, [{ ...call.message.payload.envelope, kind: 'response', payload: { ok: true } }])
  assert.equal(wire.error.details.observationRefreshError.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(wire.error.observation.state.requiresRestart, true)
  assert.equal(wire.error.observation.state.workerFault.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(wire.error.observation.state.executionFault, null)
  assert.equal(wire.error.observation.state.templateRevision, String(f.host.templateRevision))
  assert.equal(wire.error.observation.state.surfaceGeneration, before.state.surfaceGeneration)
  assert.ok(BigInt(wire.error.observation.sequence) > BigInt(before.sequence))
  const faults = f.sent.filter(message => message.kind === 'event' && message.op === 'fault')
  assert.equal(faults.length, 1)
  assert.deepEqual(faults[0].payload.observation, wire.error.observation)
  assert.equal(faults[0].payload.undelivered.op, 'dirty')
  assert.ok(f.sent.indexOf(faults[0]) < f.sent.indexOf(f.final(call)), 'freeze the owner before its final error')
  assert.equal(f.sent.filter(message => message.kind === 'event' && message.op === 'dirty').length, WORKER_EVENT_LIMITS.count)
  assert.equal(f.log.filter(entry => entry.method === 'dispatch' && entry.request.op === 'module.call').length, 1)
  assert.equal(f.host.pollCount, 0)
})

test('finally dirty-credit failure preserves an original committed metrics error and refreshes fault state', { timeout: 5000 }, async t => {
  const original = Object.assign(new Error('resize callback failed after commit'), {
    code: 'ERR_RENDER', details: { operation: 'resize', preserved: { committed: true } },
  })
  const { f, observation: before } = await orderedRawOwnerAtNormalEventLimit(t, { host: { metricsError: original } })
  const resize = f.request('metrics', { windowWidth: 640, windowHeight: 360 })
  await until(() => f.final(resize))
  const wire = f.final(resize).payload.error
  assert.equal(wire.code, original.code)
  assert.equal(wire.message, original.message)
  assert.deepEqual(wire.details.originalDetails, original.details)
  assert.equal(Object.hasOwn(wire.details, 'committedResult'), false)
  assert.equal(wire.details.observationRefreshError.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(wire.observation.state.requiresRestart, true)
  assert.equal(wire.observation.state.workerFault.code, 'ERR_RPC_BACKPRESSURE')
  assert.deepEqual(wire.observation.state.viewport, { x: 0, y: 0, width: 640, height: 360 })
  assert.equal(wire.observation.state.inputLifetimeRevision, String(f.host.inputLifetimeRevision))
  assert.notEqual(wire.observation.state.surfaceGeneration, before.state.surfaceGeneration)
  const faults = f.sent.filter(message => message.kind === 'event' && message.op === 'fault')
  assert.equal(faults.length, 1)
  assert.deepEqual(faults[0].payload.observation, wire.observation)
  assert.equal(f.log.filter(entry => entry.method === 'metrics').length, 1)
  assert.equal(f.host.pollCount, 0)
})

test('unreadable native observation keeps the last genuine sequence instead of fabricating fault state', { timeout: 5000 }, async t => {
  const original = Object.assign(new Error('native resize committed then rejected'), {
    code: 'ERR_RENDER', details: { committed: 'viewport' },
  })
  let unreadableCalls = 0
  const refreshError = Object.assign(new Error('native observation unavailable'), { code: 'ERR_ENGINE' })
  const { f, observation: before } = await orderedRawOwnerAtNormalEventLimit(t, { host: {
    metricsError: original,
    onMetrics(host) { host.observation_state_json = () => { unreadableCalls++; throw refreshError } },
  } })
  const resize = f.request('metrics', { windowWidth: 640, windowHeight: 360 })
  await until(() => f.final(resize))
  const wire = f.final(resize).payload.error
  assert.equal(wire.code, original.code)
  assert.equal(wire.message, original.message)
  assert.deepEqual(wire.details.originalDetails, original.details)
  assert.equal(wire.details.observationRefreshError.message, refreshError.message)
  assert.deepEqual(wire.observation, before, 'unreadable state cannot mint a replacement snapshot')
  assert.equal(unreadableCalls, 2, 'one failed refresh and one bounded silent retry')
  const faults = f.sent.filter(message => message.kind === 'event' && message.op === 'fault')
  assert.equal(faults.length, 1)
  assert.equal(faults[0].payload.requiresRestart, true)
  assert.deepEqual(faults[0].payload.observation, before)
  assert.equal(f.log.filter(entry => entry.method === 'metrics').length, 1)
  assert.equal(f.host.pollCount, 0)
})


// Timer/live-batch observation ordering drafts. Injected fake host only; no
// browser, WASM, GPU or native-device evidence is established by these tests.
async function observedManualTimerOwner(t, options = {}) {
  const f = rawOwner(t, { manualPump: true, ...options })
  const loading = f.request('load', OBSERVE_V1)
  f.resolveInitialization()
  await until(() => f.final(loading))
  assert.equal(f.final(loading).payload.status, 'ok')
  return { f, loaded: f.final(loading).payload.result, loading }
}
const workerBatches = f => f.sent.filter(message => message.kind === 'event' && message.op === 'batch')
const workerFaults = f => f.sent.filter(message => message.kind === 'event' && message.op === 'fault')
const assertTimerStoppedAndClosed = async f => {
  assert.equal(f.scheduledPumps, 0)
  const count = f.host.pollCount, closing = f.request('close')
  await until(() => f.final(closing))
  assert.equal(f.final(closing).payload.status, 'ok')
  assert.equal(f.host.pollCount, count)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.log.some(entry => entry.method === 'retire'), false, 'faulted owner cleanup must not replay contact/application callbacks')
}

test('opt-in startup batch events identify the pre-admission phase without a tentative observation', async t => {
  const { f, loaded, loading } = await observedManualTimerOwner(t)
  const startup = workerBatches(f)
  assert.equal(startup.length, 3)
  assert.deepEqual(startup.map(event => event.payload.phase), ['startup', 'startup', 'startup'])
  for (const batch of startup) {
    assert.equal(Object.hasOwn(batch.payload, 'observation'), false)
    assert.ok(f.sent.indexOf(batch) < f.sent.indexOf(f.final(loading)))
  }
  assert.equal(loaded.observation.sequence, '1')
  assert.equal(loaded.observation.state.surfaceGeneration, '1')
  assert.equal(loaded.observation.state.lifecycle, 'Active')
  assert.equal(f.sent.some(event => event.kind === 'event' && event.payload?.observation?.state.lifecycle === 'Created'), false)
  assert.equal(f.host.pollCount, 0)
})

test('legacy startup and timer batch payloads retain their exact non-opt-in shape', async t => {
  const f = rawOwner(t, { manualPump: true })
  const loading = f.request('load')
  f.resolveInitialization()
  await until(() => f.final(loading))
  assert.equal(f.final(loading).payload.status, 'ok')
  const startup = workerBatches(f)
  assert.equal(startup.length, 3)
  f.pumpOnce()
  await until(() => f.host.pollCount === 1 && workerBatches(f).length === 4)
  for (const event of workerBatches(f)) {
    assert.deepEqual(Object.keys(event.payload), ['messages'])
    assert.equal(Object.hasOwn(event.payload, 'phase'), false)
    assert.equal(Object.hasOwn(event.payload, 'observation'), false)
  }
  assert.equal(f.log.some(entry => entry.method.startsWith('observation.')), false)
})

test('live timer batch carries its same-turn page/viewport/lifetime before any effects', async t => {
  const { f, loaded } = await observedManualTimerOwner(t, { host: { onPoll(host) {
    host.currentPage = { pageId: '2', path: SECOND }
    host.viewport = { width: 640, height: 360 }; host.inputLifetimeRevision++
    host.templateRevision++; host.viewRevision++
  } } })
  f.pumpOnce()
  await until(() => workerBatches(f).some(event => event.payload.phase === 'live'))
  const live = workerBatches(f).find(event => event.payload.phase === 'live')
  assert.equal(live.payload.messages[0].payload.message, 'timer trace without a view mutation')
  const observed = live.payload.observation
  assert.equal(observed.state.currentPage.path, SECOND)
  assert.equal(observed.state.currentPage.pageId, '2')
  assert.deepEqual(observed.state.viewport, { x: 0, y: 0, width: 640, height: 360 })
  assert.equal(observed.state.surfaceGeneration, '2')
  assert.ok(BigInt(observed.sequence) > BigInt(loaded.observation.sequence))
  const dirty = f.sent.find(event => event.kind === 'event' && event.op === 'dirty')
  assert.deepEqual(dirty.payload.observation, observed)
  assert.ok(f.sent.indexOf(dirty) < f.sent.indexOf(live), 'the original authority must precede effect publication')
  const state = f.request('state')
  await until(() => f.final(state))
  assert.deepEqual(f.final(state).payload.result.observation, observed, 'finally/state must reuse the original sequence')
  assert.equal(f.host.pollCount, 1)
  assert.equal(f.host.evaluations, 0, 'observation refresh never reevaluates View')
})

test('trace-only live batch reuses the original observation and causes no phantom View demand', async t => {
  const { f, loaded } = await observedManualTimerOwner(t)
  f.pumpOnce()
  await until(() => workerBatches(f).length === 4)
  const live = workerBatches(f).at(-1)
  assert.equal(live.payload.phase, 'live')
  assert.deepEqual(live.payload.observation, loaded.observation)
  assert.equal(f.sent.some(event => event.kind === 'event' && event.op === 'dirty'), false)
  assert.equal(f.host.pollCount, 1)
  assert.equal(f.host.evaluations, 0)
})

test('unreadable same-turn capture freezes before live effects and preserves the original timer result', async t => {
  const refresh = Object.assign(new Error('timer observation unavailable'), { code: 'ERR_ENGINE', details: { phase: 'pure-state' } })
  let unreadableCalls = 0
  const { f, loaded } = await observedManualTimerOwner(t, { host: { onPoll(host) {
    host.viewport = { width: 640, height: 360 }; host.inputLifetimeRevision++
    host.observation_state_json = () => { unreadableCalls++; throw refresh }
  } } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const fault = workerFaults(f)[0].payload
  assert.equal(workerBatches(f).length, 3, 'a failed capture cannot publish a live batch with old metadata')
  assert.deepEqual(fault.observation, loaded.observation, 'unreadable native state cannot manufacture a new sequence')
  assert.equal(fault.requiresRestart, true)
  assert.equal(fault.error.code, refresh.code)
  assert.equal(fault.error.message, refresh.message)
  assert.deepEqual(fault.error.details.timerError, { code: refresh.code, message: refresh.message, details: refresh.details })
  assert.deepEqual(fault.error.details.observationRefreshError, fault.error.details.timerError)
  assert.equal(fault.error.details.committedResult.messages[0].payload.message, 'timer trace without a view mutation')
  assert.deepEqual(fault.timerTurn, { version: '1.0', effectDelivery: 'unconfirmed', publicationCompleted: false, committedResult: 'retained' })
  assert.equal(unreadableCalls, 2, 'one failed pre-publication capture plus one bounded finally refresh')
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('live batch credit failure retains the true result and faulted original observation', { timeout: 5000 }, async t => {
  const { f, observation: before } = await orderedRawOwnerAtNormalEventLimit(t, { manualPump: true })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const fault = workerFaults(f)[0].payload
  assert.equal(fault.undelivered.op, 'batch')
  assert.equal(fault.error.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(fault.error.details.timerError.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(Object.hasOwn(fault.error.details, 'observationRefreshError'), false)
  assert.equal(fault.error.details.committedResult.messages[0].payload.message, 'timer trace without a view mutation')
  assert.equal(fault.timerTurn.effectDelivery, 'unconfirmed')
  assert.equal(fault.timerTurn.committedResult, 'retained')
  assert.equal(fault.timerTurn.publicationCompleted, false)
  assert.equal(fault.observation.state.requiresRestart, true)
  assert.ok(BigInt(fault.observation.sequence) > BigInt(before.sequence))
  assert.equal(fault.observation.state.surfaceGeneration, before.state.surfaceGeneration)
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('dirty credit failure during timer capture cannot leak effects or discard the returned native batch', { timeout: 5000 }, async t => {
  const { f, observation: before } = await orderedRawOwnerAtNormalEventLimit(t, { manualPump: true, host: { onPoll(host) {
    host.viewRevision++; host.templateRevision++
  } } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const fault = workerFaults(f)[0].payload
  assert.equal(fault.undelivered.op, 'dirty')
  assert.equal(fault.error.details.observationRefreshError.code, 'ERR_RPC_BACKPRESSURE')
  assert.equal(fault.error.details.committedResult.messages.length, 1)
  assert.equal(workerBatches(f).some(event => event.payload.phase === 'live'), false)
  assert.equal(fault.observation.state.requiresRestart, true)
  assert.equal(fault.observation.state.templateRevision, String(f.host.templateRevision))
  assert.ok(BigInt(fault.observation.sequence) > BigInt(before.sequence))
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('original thrown timer error preserves code/message/details after committed native changes', async t => {
  const original = Object.assign(new Error('timer committed then rejected'), { code: 'ERR_RENDER', details: { committed: 'viewport', nested: [7] } })
  const { f, loaded } = await observedManualTimerOwner(t, { host: { onPoll(host) {
    host.viewport = { width: 640, height: 360 }; host.inputLifetimeRevision++; throw original
  } } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const fault = workerFaults(f)[0].payload
  assert.equal(fault.error.code, original.code)
  assert.equal(fault.error.message, original.message)
  assert.deepEqual(fault.error.details.originalDetails, original.details)
  assert.deepEqual(fault.error.details.timerError, { code: original.code, message: original.message, details: original.details })
  assert.equal(Object.hasOwn(fault.error.details, 'committedResult'), false, 'a thrown call returned no batch; it cannot prove rollback or completion')
  assert.equal(fault.timerTurn.committedResult, 'unavailable')
  assert.equal(fault.timerTurn.effectDelivery, 'unconfirmed')
  assert.equal(fault.observation.state.viewport.width, 640)
  assert.equal(fault.observation.state.surfaceGeneration, '2')
  assert.ok(BigInt(fault.observation.sequence) > BigInt(loaded.observation.sequence))
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('timer error and independent refresh error keep original identity without relabeling old state', async t => {
  const original = Object.assign(new Error('timer callback original failure'), { code: 'ERR_RENDER', details: { callback: 'original' } })
  const refresh = Object.assign(new Error('native observation independent failure'), { code: 'ERR_ENGINE', details: { refresh: 'unreadable' } })
  let unreadableCalls = 0
  const { f, loaded } = await observedManualTimerOwner(t, { host: { onPoll(host) {
    host.viewport = { width: 640, height: 360 }; host.inputLifetimeRevision++
    host.observation_state_json = () => { unreadableCalls++; throw refresh }
    throw original
  } } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const fault = workerFaults(f)[0].payload
  assert.equal(fault.error.code, original.code)
  assert.equal(fault.error.message, original.message)
  assert.deepEqual(fault.error.details.originalDetails, original.details)
  assert.equal(fault.error.details.timerError.message, original.message)
  assert.equal(fault.error.details.observationRefreshError.message, refresh.message)
  assert.deepEqual(fault.observation, loaded.observation)
  assert.equal(fault.timerTurn.committedResult, 'unavailable')
  assert.equal(unreadableCalls, 1, 'poll failed before pre-publication capture; finally performs one real refresh')
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('large committed timer effects explicitly degrade within the existing reserved fault budget', async t => {
  const { f, loaded } = await observedManualTimerOwner(t, { host: { timerMessage: 'x'.repeat(40 * 1024), onPoll(host) {
    host.observation_state_json = () => { throw Object.assign(new Error('unreadable after large committed effect'), { code: 'ERR_ENGINE' }) }
  } } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const event = workerFaults(f)[0], fault = event.payload
  assert.ok(measureWorkerPayload(event) <= WORKER_EVENT_LIMITS.criticalBytes)
  assert.equal(workerBatches(f).some(event => event.payload.phase === 'live'), false)
  assert.equal(fault.timerTurn.effectDelivery, 'unconfirmed')
  assert.equal(fault.timerTurn.publicationCompleted, false)
  assert.equal(fault.timerTurn.committedResult, 'omitted')
  assert.equal(fault.timerTurn.errorDetails, 'omitted')
  assert.equal(fault.timerTurn.omissionCode, 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(Object.hasOwn(fault.error, 'details'), false)
  assert.equal(fault.requiresRestart, true)
  assert.deepEqual(fault.observation, loaded.observation)
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('an oversized genuine observation cannot consume the only timer freeze notification', async t => {
  const { f, loaded } = await observedManualTimerOwner(t, { host: {
    onLoad(host) {
      const state = host.runtime_state_json.bind(host)
      host.runtime_state_json = () => JSON.stringify({ ...JSON.parse(state()), proof: 'x'.repeat(40 * 1024) })
    },
    onPoll(host) { host.observation_state_json = () => { throw Object.assign(new Error('native state inaccessible'), { code: 'ERR_ENGINE' }) } },
  } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const event = workerFaults(f)[0], fault = event.payload
  assert.ok(measureWorkerPayload(event) <= WORKER_EVENT_LIMITS.criticalBytes)
  assert.equal(fault.requiresRestart, true)
  assert.equal(Object.hasOwn(fault, 'observation'), false)
  assert.equal(fault.timerTurn.observation, 'omitted')
  assert.equal(fault.timerTurn.lastObservationSequence, loaded.observation.sequence)
  assert.equal(fault.timerTurn.observationOmissionCode, 'ERR_RPC_PAYLOAD_TOO_LARGE')
  assert.equal(fault.timerTurn.committedResult, 'retained', 'the small original result survives omission of an oversized observation')
  assert.equal(fault.error.details.committedResult.messages.length, 1)
  assert.equal(fault.timerTurn.effectDelivery, 'unconfirmed')
  assert.equal(workerBatches(f).some(event => event.payload.phase === 'live'), false)
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('runtime fault batch carries the same-turn fault observation before exposing native errors', async t => {
  const { f } = await observedManualTimerOwner(t)
  const poll = f.host.poll_timers.bind(f.host)
  f.host.poll_timers = now => {
    poll(now)
    f.host.fault = { code: 'ERR_TIMEOUT', message: 'native timer budget exhausted' }; f.host.inputLifetimeRevision++
    return JSON.stringify({ messages: [{ protocolVersion: '1.0', sessionId: 'raw-session', requestId: '', kind: 'response', op: 'error',
      payload: { ok: false, requiresRestart: true, error: f.host.fault } }] })
  }
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const live = workerBatches(f).find(event => event.payload.phase === 'live')
  assert.ok(live)
  assert.equal(live.payload.observation.state.requiresRestart, true)
  assert.equal(live.payload.observation.state.executionFault.code, 'ERR_TIMEOUT')
  assert.equal(live.payload.observation.state.surfaceGeneration, '2')
  assert.equal(live.payload.messages[0].payload.error.message, 'native timer budget exhausted')
  assert.deepEqual(live.payload.observation, workerFaults(f)[0].payload.observation)
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})

test('failed timer fault-event post still drains its exact owner without an unhandled task rejection', { timeout: 5000 }, async t => {
  const unhandled = [], track = error => unhandled.push(error)
  process.on('unhandledRejection', track)
  t.after(() => process.removeListener('unhandledRejection', track))
  const f = fixture(t, { rejectSend: message => message.kind === 'event' && message.op === 'fault', host: { onPoll(host) {
    host.observation_state_json = () => { throw new Error('pure timer observation failed') }
  } } })
  await f.load(OBSERVE_V1)
  await until(() => f.log.some(entry => entry.method === 'free'))
  await delay(20)
  assert.equal(unhandled.length, 0)
  assert.equal(f.host.pollCount, 1)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  assert.equal(f.events.some(event => event.op === 'batch' && event.payload.phase === 'live'), false)
  await assert.rejects(f.client.close({ timeoutMs: 50 }), failure => failure.code === 'ERR_RPC_TIMEOUT')
  assert.equal(f.worker.terminated, 1)
})


test('a finally refresh failure retains the already posted batch without claiming replay or rollback', async t => {
  const refresh = Object.assign(new Error('pure state failed only after live publication'), { code: 'ERR_ENGINE' })
  let captures = 0
  const { f } = await observedManualTimerOwner(t, { host: { onPoll(host) {
    host.viewRevision++; host.templateRevision++
    const original = host.observation_state_json.bind(host)
    host.observation_state_json = () => { if (++captures === 1) return original(); throw refresh }
  } } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const live = workerBatches(f).find(event => event.payload.phase === 'live'), fault = workerFaults(f)[0].payload
  assert.ok(live)
  assert.deepEqual(fault.error.details.committedResult.messages, live.payload.messages)
  assert.equal(fault.error.details.observationRefreshError.message, refresh.message)
  assert.equal(Object.hasOwn(fault.error.details, 'timerError'), false)
  assert.equal(fault.timerTurn.publicationCompleted, true, 'this is only local post completion, not receipt/application authority')
  assert.equal(fault.timerTurn.effectDelivery, 'unconfirmed')
  assert.equal(fault.timerTurn.committedResult, 'retained')
  assert.deepEqual(fault.observation, live.payload.observation)
  assert.equal(fault.requiresRestart, true)
  assert.equal(captures, 2)
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})


test('both oversized optional timer evidence bodies still leave one bounded freeze event', async t => {
  const { f, loaded } = await observedManualTimerOwner(t, { host: {
    timerMessage: 'x'.repeat(40 * 1024),
    onLoad(host) {
      const state = host.runtime_state_json.bind(host)
      host.runtime_state_json = () => JSON.stringify({ ...JSON.parse(state()), proof: 'x'.repeat(40 * 1024) })
    },
    onPoll(host) { host.observation_state_json = () => { throw Object.assign(new Error('native state inaccessible after large result'), { code: 'ERR_ENGINE' }) } },
  } })
  f.pumpOnce()
  await until(() => workerFaults(f).length === 1)
  const event = workerFaults(f)[0], fault = event.payload
  assert.ok(measureWorkerPayload(event) <= WORKER_EVENT_LIMITS.criticalBytes)
  assert.equal(fault.requiresRestart, true)
  assert.equal(fault.error.code, 'ERR_ENGINE')
  assert.equal(fault.error.message, 'native state inaccessible after large result')
  assert.equal(Object.hasOwn(fault.error, 'details'), false)
  assert.equal(Object.hasOwn(fault, 'observation'), false)
  assert.equal(fault.timerTurn.committedResult, 'omitted')
  assert.equal(fault.timerTurn.errorDetails, 'omitted')
  assert.equal(fault.timerTurn.observation, 'omitted')
  assert.equal(fault.timerTurn.lastObservationSequence, loaded.observation.sequence)
  assert.equal(fault.timerTurn.effectDelivery, 'unconfirmed')
  assert.equal(workerBatches(f).some(event => event.payload.phase === 'live'), false)
  assert.equal(f.host.pollCount, 1)
  await assertTimerStoppedAndClosed(f)
})


// Browser SelectorQuery scheduling contracts. The injected native host remains
// a finite fake: these checks establish wiring, not DOM/QuickJS acceptance.
test('browser query session contract is opt-in and precedes application startup', async t => {
  const old = fixture(t)
  const legacy = await old.load()
  assert.equal(Object.hasOwn(legacy, 'browserQueries'), false)
  assert.equal(old.log.some(entry => entry.request?.op === 'view.query.enable'), false)
  const f = fixture(t, { host: { browserQueries: true } })
  const loaded = await f.load({ browserQueries: { version: '1.0' }, ...OBSERVE_V1 })
  assert.deepEqual(loaded.browserQueries, { version: '1.0' })
  const effects = f.log.filter(entry => entry.method === 'dispatch').map(entry => entry.request)
  assert.deepEqual(effects.slice(0, 2).map(value => value.op), ['view.query.enable', 'app.init'])
  assert.deepEqual(effects[0].payload, { version: '1.0', scope: 'session' })
  assert.ok(effects[0].deadlineNs > 0, 'enable executes inside the same bounded startup lane')
  assert.ok(f.log.findIndex(entry => entry.method === 'load') < f.log.findIndex(entry => entry.request?.op === 'view.query.enable'))
  assert.equal(loaded.observation.sequence, '1')
})

test('browser query malformed negotiation and non-DOM renderer fail explicitly before application JS', async t => {
  for (const browserQueries of [null, true, [], {}, { version: '2.0' }, { version: '1.0', extra: true }]) {
    const f = fixture(t)
    assert.equal((await outcome(f.load({ browserQueries }))).error.code, 'ERR_PROTOCOL_VERSION')
    assert.equal(f.host, undefined)
  }
  const skia = fixture(t, { host: { browserQueries: true } })
  assert.equal((await outcome(skia.load({ renderer: 'external-frame', browserQueries: { version: '1.0' } }))).error.code, 'ERR_UNSUPPORTED_CAPABILITY')
  assert.equal(skia.host, undefined)
})

test('browser query old or malformed native enable acknowledgement never executes app.init', async t => {
  const offered = { browserQueries: { version: '1.0' } }
  const old = fixture(t)
  assert.equal((await outcome(old.load(offered))).error.code, 'ERR_UNSUPPORTED_CAPABILITY')
  for (const patch of [{ version: '2.0' }, { scope: 'presentation' }, { enabled: false }, { key: {} }]) {
    const f = fixture(t, { host: { browserQueries: true,
      browserQueryEnable: { ok: true, version: '1.0', scope: 'session', enabled: true, key: null, ...patch } } })
    assert.equal((await outcome(f.load(offered))).error.code, 'ERR_PROTOCOL_VERSION')
    assert.equal(f.log.some(entry => entry.request?.op === 'app.init'), false)
    assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
    assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
  }
  assert.equal(old.log.some(entry => entry.request?.op === 'app.init'), false)
})

test('browser query results join keyed generation admission and cannot hide inside mixed atomic batches', async t => {
  const f = fixture(t, { host: { browserQueries: true } })
  const loaded = await f.load({ ...OBSERVE_V1, browserQueries: { version: '1.0' } })
  const key = { sessionId: f.client.sessionId, pageId: loaded.observation.state.currentPage.pageId,
    documentRevision: '1', presentationRevision: '1', surfaceGeneration: loaded.observation.state.surfaceGeneration, profile: 'webview' }
  const payload = { version: '1.0', requestId: 'query-1', key, geometry: {}, viewportScroll: { x: 0, y: 0 } }
  await f.bridge('view.query.result', payload)
  const count = () => f.log.filter(entry => entry.method === 'dispatch' && entry.request.op === 'view.query.result').length
  assert.equal(count(), 1)
  await f.client.requestHost('metrics', { windowWidth: 640, windowHeight: 360 })
  assert.equal((await outcome(f.bridge('view.query.result', payload))).error.code, 'ERR_CANCELLED')
  const state = (await f.client.requestHost('state', {})).observation.state
  for (const patch of [{ sessionId: 'another-session' }, { pageId: '99' }, { profile: 'skia' }]) {
    assert.equal((await outcome(f.bridge('view.query.result', { ...payload, key: { ...key, surfaceGeneration: state.surfaceGeneration, ...patch } }))).error.code, 'ERR_CANCELLED')
  }
  assert.equal(count(), 1, 'stale result never enters the native host')
  const envelopes = [
    { protocolVersion: '1.0', sessionId: f.client.sessionId, requestId: 'query-result-mixed', kind: 'request', op: 'view.query.result',
      payload: { ...payload, key: { ...key, surfaceGeneration: state.surfaceGeneration } } },
    { protocolVersion: '1.0', sessionId: f.client.sessionId, requestId: 'other-mixed', kind: 'request', op: 'diagnostic', payload: {} },
  ]
  assert.equal((await outcome(f.client.requestHost('bridge', { batch: { messages: envelopes } }))).error.code, 'ERR_INVALID_REQUEST')
  assert.equal(count(), 1, 'mixed keyed call is rejected without splitting or native dispatch')
})


const timingEnvelope = sessionId => ({ protocolVersion: '1.0', sessionId, requestId: 'inner-budget',
  kind: 'request', op: 'event.batch', payload: { events: [{ type: 'tap', x: 1, y: 1 }] } })
const timingIds = () => ({ version: '1.0', sampleIds: Array.from({ length: 64 }, (_, i) => String(i + 1)) })

test('completed business finals survive optional input diagnostics at exact byte and node boundaries', { timeout: 15_000 }, async t => {
  for (const boundary of ['bytes-with-marker', 'bytes-no-marker', 'nodes-no-marker']) {
    const f = fixture(t); await f.load(INPUT_TIMING_V1)
    let business = boundary === 'nodes-no-marker' ? [] : ''
    const original = f.host.dispatch_json.bind(f.host)
    f.host.dispatch_json = value => {
      const request = JSON.parse(value), batch = JSON.parse(original(value))
      if (request.op === 'event.batch') batch.messages[0].payload.business = business
      return JSON.stringify(batch)
    }
    const request = traced => f.client.requestHost('bridge', { envelope: timingEnvelope(f.client.sessionId),
      ...(traced ? { inputTiming: timingIds() } : {}) })
    await request(false)
    const small = f.sent.findLast(value => value.op === 'bridge' && value.payload.status === 'ok').payload
    if (boundary.startsWith('bytes')) business = 'x'.repeat(Math.floor((16 * 1024 * 1024 - measureWorkerPayload(small)
      - (boundary === 'bytes-with-marker' ? 4096 : 0)) / 2))
    else {
      // Find the original business node boundary, without admitting diagnostics
      // as business nodes or assuming a compact marker necessarily fits.
      let low = 0, high = 16_384
      while (low < high) {
        const count = Math.ceil((low + high) / 2)
        small.result.messages[0].payload.business = Array(count).fill(null)
        try { measureWorkerPayload(small); low = count } catch { high = count - 1 }
      }
      business = Array(low).fill(null)
    }
    const baseline = await request(false), before = f.log.filter(value => value.method === 'dispatch' && value.request.op === 'event.batch').length
    const traced = await request(true)
    assert.deepEqual(traced.messages, baseline.messages, `${boundary}: preserve the exact successful business final`)
    assert.equal(f.log.filter(value => value.method === 'dispatch' && value.request.op === 'event.batch').length, before + 1, 'never retry executed business')
    if (boundary.endsWith('no-marker')) assert.equal(Object.hasOwn(traced, 'inputTiming'), false)
    else assert.deepEqual(traced.inputTiming, { version: '1.0', omitted: 'payload-budget' })
    assert.equal(f.client.state, 'open')
    await f.client.close()
  }
})

test('Worker independently admits legal request bytes without charging optional diagnostics to in-flight business credits', { timeout: 15_000 }, async t => {
  const f = rawOwner(t, { suspendPump: true })
  const loading = f.request('load', INPUT_TIMING_V1); f.resolveInitialization(); await until(() => f.final(loading))
  assert.equal(f.final(loading).payload.status, 'ok')
  const base = { envelope: timingEnvelope('raw-session') }
  const perRequest = (64 * 1024 * 1024 - 256 * 1024) / 4
  base.envelope.payload.business = 'x'.repeat((perRequest - measureWorkerPayload({ envelope: {
    ...base.envelope, payload: { ...base.envelope.payload, business: '' },
  } })) / 2)
  assert.equal(measureWorkerPayload(base), perRequest)
  const requests = Array.from({ length: 4 }, () => f.request('bridge', { ...base, inputTiming: timingIds() }))
  assert.ok(requests.every(value => value.accepted), 'all four original business reservations exactly fit')
  await until(() => requests.every(value => f.final(value)))
  assert.ok(requests.every(value => f.final(value).payload.status === 'ok'))
  assert.equal(f.log.filter(value => value.method === 'dispatch' && value.request.op === 'event.batch').length, 4)
  const invalidDiagnostic = { version: '1.0', sampleIds: ['1'], extra: {} }
  let cursor = invalidDiagnostic.extra; for (let index = 0; index < 30; index++) cursor = cursor.nested = {}
  const deep = f.request('bridge', { envelope: timingEnvelope('raw-session'), inputTiming: invalidDiagnostic })
  assert.equal(deep.accepted, true); await until(() => f.final(deep))
  assert.equal(f.final(deep).payload.status, 'ok')
  assert.deepEqual(f.final(deep).payload.result.inputTiming, { version: '1.0', omitted: 'request-diagnostic-omitted' })
})

test('original, retained and recovered clones omit diagnostics without changing frames or reexecuting retained View', { timeout: 15_000 }, async t => {
  const f = fixture(t, { host: { onDispatch(request, host) { if (request.op === 'event.batch') { host.templateRevision++; host.viewRevision++ } } } })
  await f.load({ ...INPUT_TIMING_V1, surfaceRecovery: { version: '1.0' } })
  await f.client.requestHost('bridge', { envelope: timingEnvelope(f.client.sessionId), inputTiming: timingIds() })
  let filler = ''
  const original = f.host.render_frame_json.bind(f.host)
  f.host.render_frame_json = () => JSON.stringify({ ...JSON.parse(original()), business: filler })
  await f.client.requestHost('frame', {})
  const small = f.sent.findLast(value => value.op === 'frame' && value.payload.status === 'ok').payload
  const base = splitWorkerInputTiming(small, { response: true }).base
  const diagnosticBytes = measureWorkerPayload(small) - measureWorkerPayload(base)
  filler = 'x'.repeat(Math.floor((16 * 1024 * 1024 - measureWorkerPayload(base) - diagnosticBytes / 2) / 2))
  const frame = await f.client.requestHost('frame', {})
  assert.equal(frame.frame.business, filler)
  assert.deepEqual(frame.inputTiming, { version: '1.0', omitted: 'payload-budget' })
  const evaluations = f.host.evaluations
  const current = await f.client.requestHost('frame.current', {})
  assert.deepEqual(current.frame, frame.frame)
  assert.deepEqual(current.inputTiming, { version: '1.0', omitted: 'payload-budget' })
  const recovered = await f.client.requestHost('surface.recover', { version: '1.0', expected: recoveryExpected(current.observation) })
  assert.equal(recovered.recovery.kind, 'retained')
  assert.deepEqual(recovered.frame, frame.frame)
  assert.deepEqual(recovered.inputTiming, { version: '1.0', omitted: 'payload-budget' })
  assert.equal(f.host.evaluations, evaluations)
  // The retained original receipt survives omission. A later small export can
  // still expose its original capture, never the most recent input's receipt.
  filler = ''
  const later = await f.client.requestHost('frame.current', {})
  assert.deepEqual(later.inputTiming, small.result.inputTiming)
})


test('Worker strips optional diagnostics before exact request-node admission and bounds hostile sidebands separately', async t => {
  const f = rawOwner(t, { suspendPump: true })
  const loading = f.request('load', INPUT_TIMING_V1); f.resolveInitialization(); await until(() => f.final(loading))
  const base = { envelope: timingEnvelope('raw-session') }
  let low = 0, high = 16_384
  while (low < high) {
    const count = Math.ceil((low + high) / 2)
    base.envelope.payload.business = Array(count).fill(null)
    try { measureWorkerPayload(base); low = count } catch { high = count - 1 }
  }
  base.envelope.payload.business = Array(low).fill(null)
  const exact = f.request('bridge', { ...base, inputTiming: timingIds() })
  assert.equal(exact.accepted, true); await until(() => f.final(exact))
  assert.equal(f.final(exact).payload.status, 'ok')
  assert.equal(Object.hasOwn(f.final(exact).payload.result, 'inputTiming'), false, 'no marker headroom on the request')
  for (const inputTiming of [{ text: 'x'.repeat(256 * 1024) }, Array(8193).fill(null)]) {
    const request = f.request('bridge', { envelope: timingEnvelope('raw-session'), inputTiming })
    assert.equal(request.accepted, true); await until(() => f.final(request))
    assert.equal(f.final(request).payload.status, 'ok')
    assert.deepEqual(f.final(request).payload.result.inputTiming, { version: '1.0', omitted: 'request-diagnostic-omitted' })
  }
})


// Optional protocol-only renderer-transition fixtures. Ordinary FakeHost and
// all historical fixed-family tests retain their original behavior.
function installRendererTransitions(host, options = {}) {
  host.renderer_transition_contract_json = () => {
    host.log.push({ method: 'renderer.transition.handshake' })
    return JSON.stringify(options.contract ?? { version: '1.0', runtimeOwner: '1.0',
      presenterBinding: '1.0', inputLifetime: '1.0', transitionFinal: '1.0' })
  }
  const binding = () => ({ version: '1.0', sessionId: host.config.session_id,
    generation: String(host.presenterGeneration), transportBackend: host.config.renderer_mode })
  host.renderer_transition_state_json = () => JSON.stringify({ version: '1.0', presenterBinding: binding(),
    inputLifetimeRevision: String(host.inputLifetimeRevision), state: JSON.parse(host.runtime_state_json()) })
  host.enable_renderer_transitions_json = json => {
    assert.deepEqual(JSON.parse(json), { version: '1.0' })
    assert.equal(host.lifecycle, 'Created')
    assert.equal(host.log.some(item => item.method === 'dispatch' && item.request.op === 'app.init'), false)
    host.presenterGeneration = 1n
    host.log.push({ method: 'renderer.transition.enable' })
    return host.renderer_transition_state_json()
  }
  host.retire_page_presenter = reason => {
    host.log.push({ method: 'retire.page', reason })
    host.inputLifetimeRevision++; host.frameInput = null; host.presentedRevision = null
    options.onRetire?.(host, reason)
    return JSON.stringify(options.retirementBatch?.(host) ?? { messages: [] })
  }
  host.transition_renderer_json = json => {
    const request = JSON.parse(json), expected = request.expected, previousPresenterBinding = binding()
    const before = JSON.parse(host.runtime_state_json())
    host.log.push({ method: 'renderer.transition', request })
    assert.equal(expected.sessionId, host.config.session_id)
    assert.equal(expected.pageId, host.currentPage.pageId)
    assert.equal(expected.routePath, host.currentPage.path)
    assert.equal(expected.rendererProfile, before.rendererProfile)
    assert.equal(expected.presenterGeneration, previousPresenterBinding.generation)
    assert.equal(expected.inputLifetimeRevision, String(host.inputLifetimeRevision))
    const batch = JSON.parse(host.retire_page_presenter('renderer-family-changed'))
    const after = JSON.parse(host.runtime_state_json())
    const ok = after.currentPage?.pageId === expected.pageId && after.currentPage.path === expected.routePath
      && after.rendererProfile === expected.rendererProfile && after.lifecycle === 'Active' && !after.requiresRestart
    if (ok) {
      host.presenterGeneration++
      host.config.renderer_mode = expected.rendererProfile === 'webview' ? 'browser-view' : 'external-frame'
    }
    const result = { version: '1.0', ok, previousPresenterBinding, presenterBinding: binding(),
      inputLifetimeRevision: String(host.inputLifetimeRevision), batch, observedState: JSON.parse(host.runtime_state_json()),
      ...(ok ? {} : { error: { code: 'ERR_CANCELLED', message: 'fixture retirement navigated' } }) }
    return JSON.stringify(options.transitionOverride?.(result, host) ?? result)
  }
}

const rendererTransitionLoad = extra => ({ renderer: 'auto', rendererPolicy: { mode: 'manifest' },
  observation: { version: '1.0' }, externalPresentation: { version: '1.0' },
  rendererTransitions: { version: '1.0' }, ...extra })
const presenterContext = state => ({ presenterBinding: state.presenterBinding,
  pageId: state.currentPage.pageId, inputLifetimeRevision: state.inputLifetimeRevision,
  surfaceGeneration: state.surfaceGeneration })
const transitionInput = state => ({ version: '1.0', expected: {
  sessionId: state.sessionId, pageId: state.currentPage.pageId, routePath: state.currentPage.path,
  rendererProfile: state.rendererProfile, inputLifetimeRevision: state.inputLifetimeRevision,
  presenterGeneration: state.presenterBinding.generation, transportBackend: state.transportBackend,
  surfaceGeneration: state.surfaceGeneration,
} })

async function transitionFixture(t, options = {}) {
  const f = fixture(t, { manifestFields: rendererManifest('skia', 'webview'), ...options,
    afterCreateHost(host) { installRendererTransitions(host, options.transition); options.afterCreateHost?.(host) } })
  const loaded = await f.load(rendererTransitionLoad(options.load))
  return { ...f, loaded, get host() { return f.host } }
}

test('renderer transition opt-in validates its own version and native pre-init contract', { timeout: 5000 }, async t => {
  for (const extra of [
    { rendererTransitions: { version: '2.0' } },
    { rendererTransitions: { version: '1.0', implicit: true } },
    { observation: undefined }, { externalPresentation: undefined },
    { inputTiming: { version: '1.0' } }, { rendererPolicy: { mode: 'force', profile: 'skia' } },
  ]) {
    const f = fixture(t, { manifestFields: rendererManifest('skia', 'webview') })
    await assert.rejects(f.load(rendererTransitionLoad(extra)), error => error.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(f.initializeCount, 0)
    assert.equal(f.host, undefined)
    await f.client.close()
  }
  for (const contract of [null, { version: '1.0', runtimeOwner: '1.0', presenterBinding: '0.9', inputLifetime: '1.0', transitionFinal: '1.0' }]) {
    const f = fixture(t, { manifestFields: rendererManifest('skia', 'webview'),
      afterCreateHost(host) { if (contract) installRendererTransitions(host, { contract }) } })
    await assert.rejects(f.load(rendererTransitionLoad()), error => error.code === 'ERR_PROTOCOL_VERSION')
    assert.equal(f.log.some(item => item.method === 'dispatch' && item.request.op === 'app.init'), false)
    await f.client.close()
    assert.equal(f.log.filter(item => item.method === 'free').length, 1)
  }
})

test('negotiated renderer transitions retain one Worker host session and round-trip presenter bindings', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t)
  const original = f.host, owner = f.loaded.runtimeOwner, initial = f.loaded.observation.state
  original.retainedBusinessState = { storage: 'kept', timer: 'same-owned-timer', app: 'same-instance' }
  assert.equal(f.loaded.observation.version, '2.0')
  assert.deepEqual(Object.keys(owner).sort(), ['packSha256', 'sessionId', 'workerEpoch'])
  assert.equal(initial.presenterBinding.generation, '1')
  const firstFrame = await f.client.requestHost('frame', { presentationContext: presenterContext(initial) })
  await f.bridge('page.push', { path: SECOND })
  const pending = await f.client.requestHost('state', {})
  assert.equal(pending.transitionRequired, true)
  assert.equal(pending.requiresRestart, false)
  assert.equal(pending.transportBackend, 'external-frame')
  const final = await f.client.requestHost('renderer.transition', transitionInput(pending.observation.state))
  assert.equal(final.ok, true)
  assert.equal(final.inputEnabled, false, 'transition final grants no input or presentation ACK')
  assert.equal(final.presenterBinding.generation, '2')
  assert.equal(final.presenterBinding.transportBackend, 'browser-view')
  assert.deepEqual(final.runtimeOwner, owner)
  assert.equal(final.observation.state.transitionRequired, false)
  assert.equal(final.observation.state.presenterBinding.generation, '2')
  assert.equal(f.host, original)
  assert.equal(original.retainedBusinessState.storage, 'kept')
  assert.equal(original.presentedRevision, null)
  await f.bridge('page.pop', {})
  const returning = await f.client.requestHost('state', {})
  const returned = await f.client.requestHost('renderer.transition', transitionInput(returning.observation.state))
  assert.equal(returned.presenterBinding.generation, '3')
  assert.equal(returned.presenterBinding.transportBackend, 'external-frame')
  assert.equal(returned.observation.state.currentPage.pageId, initial.currentPage.pageId)
  assert.deepEqual(returned.runtimeOwner, owner)
  const returnedContext = presenterContext(returned.observation.state)
  await assert.rejects(f.client.requestHost('frame.current', { presentationContext: returnedContext }), error => error.code === 'ERR_CANCELLED')
  await assert.rejects(f.client.requestHost('ack', { renderRevision: firstFrame.renderRevision,
    presentationContext: returnedContext }), error => error.code === 'ERR_CANCELLED')
  const scaled = await f.client.requestHost('scale', { scale: 2, presentationContext: returnedContext })
  assert.equal(f.log.some(item => item.method === 'scale'), false, 'density waits for this binding\'s new accepted layout')
  assert.equal(f.log.filter(item => item.method === 'dispatch' && item.request.op === 'app.init').length, 1)
  assert.equal(f.initializeCount, 1)
  assert.equal(original.evaluations, 1, 'transition and retained-frame rejection never reevaluate View')
  const fresh = await f.client.requestHost('frame', { presentationContext: presenterContext(scaled.observation.state) })
  assert.equal(original.evaluations, 2)
  assert.ok(BigInt(fresh.renderRevision) > BigInt(firstFrame.renderRevision))
  assert.equal(fresh.target.width, 750)
  const ack = await f.client.requestHost('ack', { renderRevision: fresh.renderRevision,
    presentationContext: presenterContext(fresh.observation.state) })
  assert.equal(ack.inputEnabled, true, 'only a new current binding frame may grant input')
  assert.equal(f.events.some(item => item.op === 'fault'), false)
  await f.client.close()
  assert.equal(f.log.filter(item => item.method === 'free').length, 1)
  assert.equal(f.log.filter(item => item.method === 'unload').length, 1)
  assert.equal(f.log.filter(item => item.method === 'retire.page').length, 3)
  assert.equal(f.log.some(item => item.method === 'retire'), false, 'negotiated close retires both input families')
})

test('old page binding input ACK resource and bridge messages cannot enter native presentation after transition', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t), oldContext = presenterContext(f.loaded.observation.state)
  await f.bridge('page.push', { path: SECOND })
  const pending = await f.client.requestHost('state', {})
  const stale = transitionInput(pending.observation.state)
  stale.expected.inputLifetimeRevision = '999'
  await assert.rejects(f.client.requestHost('renderer.transition', stale), error => error.code === 'ERR_CANCELLED')
  assert.equal(f.log.some(item => item.method === 'renderer.transition'), false)
  await assert.rejects(f.client.requestHost('frame', { presentationContext: oldContext }), error => error.code === 'ERR_CANCELLED')
  const final = await f.client.requestHost('renderer.transition', transitionInput(pending.observation.state))
  const oldAttempts = [
    ['ack', { renderRevision: '1' }], ['resource', { key: {}, sha256: 'a'.repeat(64) }],
    ['frame.current', {}], ['scale', { scale: 2 }], ['retire', { reason: 'late-owner' }], ['abort', { key: {} }],
  ]
  const before = f.log.length
  for (const [op, payload] of oldAttempts) await assert.rejects(f.client.requestHost(op,
    { ...payload, presentationContext: oldContext }), error => error.code === 'ERR_CANCELLED')
  await assert.rejects(f.client.requestHost('bridge', { presentationContext: oldContext, envelope: {
    protocolVersion: '1.0', sessionId: f.client.sessionId, requestId: 'stale-events', kind: 'request', op: 'event.batch', payload: { events: [] },
  } }), error => error.code === 'ERR_CANCELLED')
  assert.equal(f.log.slice(before).some(item => ['dispatch', 'ack', 'resource', 'scale', 'retire.page'].includes(item.method)), false)
  await assert.rejects(f.client.requestHost('ack', { renderRevision: '1' }), error => error.code === 'ERR_PROTOCOL_VERSION')
  assert.equal(final.inputEnabled, false)
  assert.equal(f.host.evaluations, 0)
})

test('pending renderer family transitions keep the same business timer pump alive', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { manualPump: true, manifestFields: rendererManifest('skia', 'webview'),
    afterCreateHost: installRendererTransitions,
    host: { onPoll(host) { if (host.pollCount === 1) {
      host.currentPage = { pageId: '2', path: SECOND }; host.inputLifetimeRevision++; host.templateRevision++
    } } } })
  const load = f.request('load', rendererTransitionLoad())
  f.resolveInitialization()
  await until(() => f.final(load))
  assert.equal(f.final(load).payload.status, 'ok')
  assert.equal(f.scheduledPumps, 1)
  f.pumpOnce()
  await until(() => f.host.pollCount === 1 && f.scheduledPumps === 1)
  const stateRequest = f.request('state')
  await until(() => f.final(stateRequest))
  const pending = f.final(stateRequest).payload.result
  assert.equal(pending.transitionRequired, true)
  assert.equal(pending.requiresRestart, false)
  f.pumpOnce()
  await until(() => f.host.pollCount === 2 && f.scheduledPumps === 1)
  const transition = f.request('renderer.transition', transitionInput(pending.observation.state))
  await until(() => f.final(transition))
  assert.equal(f.final(transition).payload.status, 'ok')
  assert.equal(f.final(transition).payload.result.presenterBinding.generation, '2')
  assert.equal(f.scheduledPumps, 1)
  assert.equal(f.sent.some(item => item.op === 'fault'), false)
})

test('ready and resize callback navigation expose pending renderer transitions without implicit restart', { timeout: 5000 }, async t => {
  for (const trigger of ['ready', 'metrics']) {
    const navigate = host => { host.currentPage = { pageId: '2', path: SECOND }; host.inputLifetimeRevision++; host.templateRevision++ }
    const f = await transitionFixture(t, { host: trigger === 'ready' ? { onAcknowledge: navigate } : { onMetrics: navigate } })
    if (trigger === 'ready') {
      const context = presenterContext(f.loaded.observation.state)
      const frame = await f.client.requestHost('frame', { presentationContext: context })
      const ack = await f.client.requestHost('ack', { renderRevision: frame.renderRevision,
        presentationContext: presenterContext(frame.observation.state) })
      assert.equal(ack.acknowledged, true, 'native ACK and its committed callbacks remain genuine')
      assert.equal(ack.inputEnabled, false)
    } else await f.client.requestHost('metrics', { windowWidth: 667, windowHeight: 375 })
    const pending = await f.client.requestHost('state', {})
    assert.equal(pending.currentPage.path, SECOND)
    assert.equal(pending.transitionRequired, true)
    assert.equal(pending.requiresRestart, false)
    assert.equal(f.events.some(item => item.op === 'fault'), false)
    const transitioned = await f.client.requestHost('renderer.transition', transitionInput(pending.observation.state))
    assert.equal(transitioned.presenterBinding.transportBackend, 'browser-view')
    await f.client.close()
  }
})

test('retirement navigation returns its real cancellation batch and retains the original presenter binding', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t, { transition: {
    onRetire(host, reason) { if (reason === 'renderer-family-changed') {
      host.currentPage = { pageId: '3', path: HOME }; host.inputLifetimeRevision++; host.templateRevision++
    } },
    retirementBatch: host => ({ messages: [{ protocolVersion: '1.0', sessionId: host.config.session_id,
      requestId: '', kind: 'event', op: 'diagnostic', payload: { message: 'real-cancellation-effect' } }] }),
  } })
  await f.bridge('page.push', { path: SECOND })
  const pending = await f.client.requestHost('state', {})
  const final = await f.client.requestHost('renderer.transition', transitionInput(pending.observation.state))
  assert.equal(final.ok, false)
  assert.equal(final.error.code, 'ERR_CANCELLED')
  assert.equal(final.presenterBinding.generation, '1')
  assert.equal(final.presenterBinding.transportBackend, 'external-frame')
  assert.equal(final.inputEnabled, false)
  assert.equal(final.observation.state.currentPage.pageId, '3')
  assert.equal(final.batch.messages[0].payload.message, 'real-cancellation-effect')
  assert.equal(f.events.some(item => item.op === 'fault'), false)
})

test('a malformed native transition final faults the owner and preserves irreversible effects', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t, { transition: {
    retirementBatch: host => ({ messages: [{ protocolVersion: '1.0', sessionId: host.config.session_id,
      requestId: '', kind: 'event', op: 'diagnostic', payload: { message: 'preserved-before-malformed-final' } }] }),
    transitionOverride(result) { return { ...result, presenterBinding: { ...result.presenterBinding, generation: '99' } } },
  } })
  await f.bridge('page.push', { path: SECOND })
  const pending = await f.client.requestHost('state', {})
  await assert.rejects(f.client.requestHost('renderer.transition', transitionInput(pending.observation.state)), error => {
    assert.equal(error.code, 'ERR_PROTOCOL_VERSION')
    assert.match(JSON.stringify(error.details), /preserved-before-malformed-final/)
    return true
  })
  await until(() => f.events.some(item => item.op === 'fault'))
  assert.equal(f.host.config.renderer_mode, 'browser-view', 'committed native state is never rolled back or replayed')
  const before = f.log.length
  await assert.rejects(f.client.requestHost('frame', { presentationContext: presenterContext(pending.observation.state) }))
  assert.equal(f.log.slice(before).some(item => item.method === 'dispatch'), false)
  await f.client.close()
  await f.client.close()
  assert.equal(f.log.filter(item => item.method === 'free').length, 1)
})

test('renderer-transition observation copies preserve a stable exact owner and reject implicit v1 relabeling', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t), observation = f.loaded.observation, owner = f.loaded.runtimeOwner
  const copy = copyRendererTransitionObservation(observation, owner)
  assert.equal(copy.version, '2.0')
  assert.ok(Object.isFrozen(copy.state.presenterBinding))
  assert.deepEqual(copyWorkerPresenterBinding(copy.state.presenterBinding, f.client.sessionId), copy.state.presenterBinding)
  assert.throws(() => copyOrderedObservation(copy, owner), error => error.code === 'ERR_PROTOCOL_VERSION')
  const wrongOwner = { ...owner, transportBackend: 'external-frame' }
  assert.throws(() => copyRendererTransitionObservation(copy, wrongOwner), error => error.code === 'ERR_PROTOCOL_VERSION')
  for (const mutate of [
    value => { value.version = '1.0' },
    value => { value.state.owner.transportBackend = 'external-frame' },
    value => { value.state.presenterBinding.generation = '01' },
    value => { value.state.presenterBinding.version = '2.0' },
    value => { value.state.presenterBinding.ignored = true },
    value => { value.state.transitionRequired = true },
  ]) {
    const value = structuredClone(copy); mutate(value)
    assert.throws(() => copyRendererTransitionObservation(value, owner), error => error.code === 'ERR_PROTOCOL_VERSION')
  }
})


test('a DOM-first negotiated owner preflights both presentation families without exporting Skia pixels', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t, { manifestFields: rendererManifest('webview', 'skia'),
    host: { browserQueries: true }, load: { browserQueries: { version: '1.0' } } })
  assert.equal(f.loaded.presenterBinding.transportBackend, 'browser-view')
  assert.equal(f.loaded.externalPresentation.version, '1.0')
  assert.equal(f.loaded.browserQueries.version, '1.0')
  assert.equal(f.host.evaluations, 0)
  await f.bridge('page.push', { path: SECOND })
  const pending = await f.client.requestHost('state', {})
  const final = await f.client.requestHost('renderer.transition', transitionInput(pending.observation.state))
  assert.equal(final.presenterBinding.transportBackend, 'external-frame')
  assert.equal(final.presenterBinding.generation, '2')
  assert.equal(final.inputEnabled, false)
  const fresh = await f.client.requestHost('frame', { presentationContext: presenterContext(final.observation.state) })
  assert.equal(fresh.scheduling.consumedInput.routePath, SECOND)
  assert.equal(f.host.evaluations, 1)
})


test('transition callers preserve explicit object DTO admission for state and renderer operations', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t)
  const before = f.log.filter(item => item.method === 'renderer.transition').length
  for (const [op, payload] of [['state', undefined], ['renderer.transition', undefined], ['renderer.unknown', {}]]) {
    await assert.rejects(f.client.requestHost(op, payload), error => error.code === 'ERR_INVALID_REQUEST')
  }
  const current = await f.client.requestHost('state', {})
  assert.equal(current.transitionRequired, false)
  assert.equal(current.presenterBinding.generation, '1')
  assert.equal(f.log.filter(item => item.method === 'renderer.transition').length, before)
  assert.equal(f.events.some(item => item.op === 'fault'), false)
})


test('uncertain native binding keeps genuine receipt ACK state diagnostics and exact owner close available', { timeout: 5000 }, async t => {
  const f = rawOwner(t, { manualPump: true, manifestFields: rendererManifest('skia', 'webview'),
    afterCreateHost(host) { installRendererTransitions(host, {
      retirementBatch: current => ({ messages: [{ protocolVersion: '1.0', sessionId: current.config.session_id,
        requestId: '', kind: 'event', op: 'diagnostic', payload: { message: 'committed-uncertain-binding-effect' } }] }),
      transitionOverride(result) { return { ...result, presenterBinding: { ...result.presenterBinding, generation: '99' } } },
    }) } })
  const load = f.request('load', rendererTransitionLoad())
  f.resolveInitialization()
  await until(() => f.final(load))
  assert.equal(f.final(load).payload.status, 'ok')
  const navigate = rawBridge(f, 'page.push', { path: SECOND })
  await until(() => f.final(navigate))
  const pendingRequest = f.request('state', {})
  await until(() => f.final(pendingRequest))
  const pending = f.final(pendingRequest).payload.result.observation
  const transition = f.request('renderer.transition', transitionInput(pending.state))
  await until(() => f.final(transition) && f.sent.some(message => message.op === 'fault'))
  const original = f.final(transition).payload.error
  assert.equal(original.code, 'ERR_PROTOCOL_VERSION')
  assert.match(JSON.stringify(original.details), /committed-uncertain-binding-effect/)
  assert.equal(f.host.config.renderer_mode, 'browser-view', 'native commit is not rolled back')
  assert.equal(f.scheduledPumps, 0)
  const fault = f.sent.find(message => message.op === 'fault')
  const nativeReads = f.log.filter(item => item.method === 'observation.state').length
  const receipt = f.request('events.ack', { eventIds: [fault.requestId] })
  await until(() => f.final(receipt))
  assert.equal(f.final(receipt).payload.status, 'ok', 'receipt credit cleanup is independent of failed binding admission')
  assert.deepEqual(f.final(receipt).payload.result.acknowledged, [fault.requestId])
  assert.deepEqual(f.final(receipt).payload.result.observation, pending, 'receipt ACK cannot mint a binding observation')
  assert.equal(f.log.filter(item => item.method === 'observation.state').length, nativeReads)
  const diagnostic = f.request('state', {})
  await until(() => f.final(diagnostic))
  const state = f.final(diagnostic).payload.result
  assert.equal(f.final(diagnostic).payload.status, 'ok')
  assert.equal(state.presenterBindingStatus, 'uncertain')
  assert.equal(state.acceptedPresenterBinding.generation, '1')
  assert.equal(state.acceptedPresenterBinding.transportBackend, 'external-frame')
  assert.equal(state.nativeObservedState.transportBackend, 'browser-view')
  assert.equal(state.transportBackend, 'browser-view', 'diagnostics report actual native transport, never accepted-binding inference')
  assert.equal(state.requiresRestart, true)
  assert.equal(state.inputEnabled, false)
  assert.equal(state.bindingFault.error.code, 'ERR_PROTOCOL_VERSION')
  assert.deepEqual(state.observation, pending)
  const nativeOperations = f.log.filter(item => ['dispatch', 'ack', 'resource', 'metrics', 'scale'].includes(item.method)).length
  const attempts = [
    f.request('frame', { presentationContext: presenterContext(pending.state) }),
    f.request('resource', { key: {}, sha256: 'a'.repeat(64), presentationContext: presenterContext(pending.state) }),
    f.request('metrics', { windowWidth: 667, windowHeight: 375 }),
    rawBridge(f, 'module.call', { moduleId: 'module:app.js', export: 'inspect' }),
  ]
  await until(() => attempts.every(request => f.final(request)))
  assert.ok(attempts.every(request => f.final(request).payload.status === 'error'))
  assert.equal(f.log.filter(item => ['dispatch', 'ack', 'resource', 'metrics', 'scale'].includes(item.method)).length, nativeOperations)
  const close = f.request('close', {})
  await until(() => f.final(close))
  assert.equal(f.final(close).payload.status, 'ok')
  assert.match(JSON.stringify(f.final(close).payload.result.diagnostics), /committed-uncertain-binding-effect/)
  const duplicateClose = f.request('close', {})
  await until(() => f.final(duplicateClose))
  assert.equal(f.final(duplicateClose).payload.status, 'error', 'a second raw wire close remains rejected; the owning RPC close is idempotent')
  assert.equal(f.final(duplicateClose).payload.error.code, 'ERR_CANCELLED')
  assert.equal(f.log.filter(item => item.method === 'unload').length, 1)
  assert.equal(f.log.filter(item => item.method === 'free').length, 1)
  assert.equal(f.log.filter(item => item.method === 'renderer.transition').length, 1)
  assert.equal(f.log.some(item => item.method === 'dispatch' && item.request.op === 'app.lifecycle'
    && item.request.payload.event === 'unload'), false, 'faulted cleanup cannot execute another business callback')
})


test('rejected post-assignment native state retains only the last admitted presenter binding', { timeout: 5000 }, async t => {
  const f = await transitionFixture(t, { transition: {
    retirementBatch: host => ({ messages: [{ protocolVersion: '1.0', sessionId: host.config.session_id,
      requestId: '', kind: 'event', op: 'diagnostic', payload: { message: 'post-assignment-native-effect' } }] }),
    transitionOverride(result) { return { ...result, observedState: { ...result.observedState, schemaVersion: 99 } } },
  } })
  await f.bridge('page.push', { path: SECOND })
  const pending = await f.client.requestHost('state', {})
  await assert.rejects(f.client.requestHost('renderer.transition', transitionInput(pending.observation.state)), error => {
    assert.equal(error.code, 'ERR_ENGINE')
    assert.equal(error.details.details.transitionFinalReceived, true)
    assert.match(JSON.stringify(error.details), /post-assignment-native-effect/)
    return true
  })
  const diagnostic = await f.client.requestHost('state', {})
  assert.equal(diagnostic.presenterBindingStatus, 'uncertain')
  assert.deepEqual(diagnostic.acceptedPresenterBinding, pending.presenterBinding)
  assert.equal(diagnostic.acceptedPresenterBinding.generation, '1')
  assert.equal(diagnostic.acceptedPresenterBinding.transportBackend, 'external-frame')
  assert.equal(diagnostic.nativeObservedState.schemaVersion, 1, 'pure diagnostics read actual native state, not rejected return metadata')
  assert.equal(diagnostic.nativeObservedState.transportBackend, 'browser-view')
  assert.equal(diagnostic.inputEnabled, false)
  assert.equal(diagnostic.requiresRestart, true)
  assert.deepEqual(diagnostic.observation, pending.observation)
  assert.equal(f.host.presenterGeneration, 2n)
  assert.equal(f.host.evaluations, 0)
  assert.equal(f.log.filter(item => item.method === 'renderer.transition').length, 1)
  await f.client.close()
  await f.client.close()
  assert.equal(f.log.filter(item => item.method === 'free').length, 1)
})


test('presenter attachment keeps original startup receipt separate from committed native generation', { timeout: 5000 }, async t => {
  const { copyWorkerPresenterAttachment, copyWorkerPresenterObservation } = await import('../examples/hosts/web-wasm/worker-runtime.mjs')
  const f = await transitionFixture(t)
  const original = structuredClone(f.loaded)
  const attachment = { version: '1.0', runtimeOwner: f.loaded.runtimeOwner, presenterBinding: f.loaded.presenterBinding, observation: f.loaded.observation }
  const current = copyWorkerPresenterAttachment(attachment, f.loaded)
  assert.equal(current.owner.presenterGeneration, '1'); assert.equal(current.owner.transportBackend, 'external-frame')
  assert.equal(copyWorkerPresenterObservation(f.loaded.observation, current.owner).version, '2.0')
  assert.deepEqual(f.loaded, original)
  await f.bridge('page.push', { path: SECOND })
  const pending = await f.client.requestHost('state', {})
  const final = await f.client.requestHost('renderer.transition', transitionInput(pending.observation.state))
  const next = { version: '1.0', runtimeOwner: final.runtimeOwner, presenterBinding: final.presenterBinding, observation: final.observation }
  const attached = copyWorkerPresenterAttachment(next, f.loaded)
  assert.equal(attached.owner.presenterGeneration, '2'); assert.equal(attached.owner.transportBackend, 'browser-view')
  assert.deepEqual(f.loaded, original, 'new attachment must never manufacture a second load receipt')
  assert.throws(() => copyWorkerPresenterObservation(final.observation, current.owner), error => error.code === 'ERR_PROTOCOL_VERSION')
  assert.throws(() => copyWorkerPresenterAttachment(next, f.loaded, current.owner), error => error.code === 'ERR_PROTOCOL_VERSION')
  for (const mutate of [value => { value.presenterBinding.generation = '99' }, value => { value.runtimeOwner.sessionId = 'other-session' },
    value => { value.observation.version = '1.0' }, value => { value.ignored = true }]) {
    const invalid = structuredClone(next); mutate(invalid)
    assert.throws(() => copyWorkerPresenterAttachment(invalid, f.loaded), error => error.code === 'ERR_PROTOCOL_VERSION')
  }
})


const fontIngressBytes = new Uint8Array([0, 1, 2, 3])
const fontIngressIdentity = { sha256: digest(fontIngressBytes), face_index: 0, profile: 'sfnt-unhinted-v1' }
const fontIngressDescriptor = { version: '1.0', profile: 'sfnt-unhinted-v1', url: './face.ttf', sha256: fontIngressIdentity.sha256, size: 4 }
function fontIngressFixture(t, options = {}) {
  return fixture(t, {
    afterCreateHost(host) {
      if (options.legacy) return
      host.configure_text_font = (bytes, sha256) => {
        host.log.push({ method: 'font.configure', bytes: [...bytes], sha256 })
        return JSON.stringify(options.receipt ?? fontIngressIdentity)
      }
    },
    fetch(url, init, pack) {
      options.onFetch?.(url)
      const body = url.endsWith('/face.ttf') ? options.body ?? fontIngressBytes : pack.files.get(url)
      assert.ok(body, `unexpected font ingress fetch ${url}`)
      return new Response(body, { headers: { 'content-length': String(body.length) } })
    },
  })
}
test('verified fonts cross Worker owners through shared storage and poisoned cache never enters native code', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches'), entries = new Map(), writes = []
  const cache = { match: async key => entries.get(key)?.clone(), put: async (key, response) => { entries.set(key, response.clone()); writes.push(key) }, delete: async key => entries.delete(key) }
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: async name => { assert.equal(name, 'weapp-container-showcase-font-v1'); return cache } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'caches', previous); else delete globalThis.caches })
  let fontFetches = 0
  const options = { onFetch: url => { if (url.endsWith('/face.ttf')) fontFetches++ } }
  const first = fontIngressFixture(t, options); await first.load({ textFont: fontIngressDescriptor }); await first.client.close()
  assert.equal(fontFetches, 1); assert.equal(writes.length, 1)
  const second = fontIngressFixture(t, options); await second.load({ textFont: fontIngressDescriptor }); await second.client.close()
  assert.equal(fontFetches, 1, 'fresh execution owner must reuse the exact verified font bytes')
  const key = writes[0]; entries.set(key, new Response(new Uint8Array([0, 1, 2, 4])))
  const poisoned = fontIngressFixture(t, options)
  await assert.rejects(poisoned.load({ textFont: fontIngressDescriptor }), { code: 'ERR_INVALID_MANIFEST' })
  assert.equal(poisoned.log.some(entry => entry.method === 'font.configure' || entry.request?.op === 'app.init'), false)
  assert.equal(entries.has(key), false, 'poisoned cached bytes are discarded after rejection')
  const invalid = fontIngressFixture(t, { body: new Uint8Array([0, 1, 2, 4]) })
  await assert.rejects(invalid.load({ textFont: fontIngressDescriptor }), { code: 'ERR_INVALID_MANIFEST' })
  assert.equal(writes.length, 1, 'unverified network bytes cannot populate shared storage')
})
test('verified Worker font ingress precedes native load/JS and echoes exact face identity', async t => {
  const f = fontIngressFixture(t), result = await f.load({ textFont: fontIngressDescriptor })
  assert.deepEqual(result.textFont, fontIngressIdentity)
  const configured = f.log.findIndex(entry => entry.method === 'font.configure')
  assert.deepEqual(f.log[configured].bytes, [...fontIngressBytes])
  assert.ok(configured >= 0 && configured < f.log.findIndex(entry => entry.method === 'load'))
  assert.ok(configured < f.log.findIndex(entry => entry.request?.op === 'app.init'))
})
for (const [name, options, descriptor, code] of [
  ['old runtime', { legacy: true }, fontIngressDescriptor, 'ERR_PROTOCOL_VERSION'],
  ['digest mismatch', { body: new Uint8Array([0, 1, 2, 4]) }, fontIngressDescriptor, 'ERR_INVALID_MANIFEST'],
  ['oversize descriptor', {}, { ...fontIngressDescriptor, size: 32 * 1024 * 1024 + 1 }, 'ERR_PROTOCOL_VERSION'],
  ['cross-origin font', {}, { ...fontIngressDescriptor, url: 'https://other.test/face.ttf' }, 'ERR_PERMISSION_DENIED'],
  ['different native face', { receipt: { ...fontIngressIdentity, sha256: '0'.repeat(64) } }, fontIngressDescriptor, 'ERR_PROTOCOL_VERSION'],
]) test(`Worker font ingress rejects ${name} before JS and closes native ownership`, async t => {
  const f = fontIngressFixture(t, options)
  await assert.rejects(f.load({ textFont: descriptor }), { code })
  assert.equal(f.log.some(entry => entry.method === 'load' || entry.request?.op === 'app.init'), false)
  assert.equal(f.log.filter(entry => entry.method === 'unload').length, 1)
  assert.equal(f.log.filter(entry => entry.method === 'free').length, 1)
})


// Actual MessagePorts exercise the production runtime/client encode/decode.
// Host injection remains finite protocol wiring evidence, not native/WASM proof.
test('typed frame images reach the ordinary client through actual MessagePorts without relayout on retained paint', { timeout: 5000 }, async t => {
  const pixels = Array.from({ length: 320 * 320 * 4 }, (_, index) => index % 256)
  const f = fixture(t, { messagePort: true, host: { onFramePrepared(host) {
    host.frame.images = { 'weapp-owned-canvas:1': { width: 320, height: 320, pixels } }
  } } })
  await f.load({ ...EXTERNAL_V1, ...OBSERVE_V1 })
  const first = await f.client.requestHost('frame', {})
  assert.ok(first.frame.images['weapp-owned-canvas:1'].pixels instanceof Uint8Array)
  assert.deepEqual(Array.from(first.frame.images['weapp-owned-canvas:1'].pixels), pixels)
  assert.equal(first.renderRevision, '1')
  assert.equal(first.observation.state.renderRevision, '1')
  assert.equal(f.host.evaluations, 1)
  const originalInput = first.scheduling.consumedInput
  f.host.frame.images['weapp-owned-canvas:1'].pixels = pixels.map(byte => 255 - byte)
  f.host.renderRevision++
  const retained = await f.client.requestHost('frame.current', {})
  assert.equal(retained.renderRevision, '2')
  assert.equal(retained.observation.state.renderRevision, '2')
  assert.equal(retained.viewRevision, first.viewRevision)
  assert.deepEqual(retained.scheduling.consumedInput, originalInput)
  assert.deepEqual(Array.from(retained.frame.images['weapp-owned-canvas:1'].pixels), pixels.map(byte => 255 - byte))
  assert.equal(f.host.evaluations, 1, 'retained frame export cannot invoke render.commit')
  assert.equal(pixels.length, 320 * 320 * 4)
  assert.equal(pixels[1], 1, 'caller bytes remain owned after successful transfer')
  assert.deepEqual(f.failures, [])
})

test('native layout metadata above ordinary host API limits crosses every frame response boundary', { timeout: 5000 }, async t => {
  const f = fixture(t, { messagePort: true, host: { onFramePrepared(host) {
    host.frame.root = { id: 'root', children: Array.from({ length: 400 }, (_, id) => ({ id: String(id), children: [],
      computed_style: Object.fromEntries(Array.from({ length: 40 }, (_, key) => [`property${key}`, 'accepted-style'])) })) }
    host.frame.images = { 'weapp-owned-canvas:1': { width: 1, height: 1, pixels: [0, 0, 0, 255] } }
  } } })
  await f.load(RECOVERY_V1)
  const first = await f.client.requestHost('frame', {})
  const retained = await f.client.requestHost('frame.current', {})
  const recovered = await f.client.requestHost('surface.recover', { version: '1.0', expected: recoveryExpected(retained.observation) })
  for (const frame of [first, retained, recovered]) {
    assert.equal(frame.frame.root.children.length, 400)
    assert.equal(frame.frame.root.children[399].computed_style.property39, 'accepted-style')
    assert.deepEqual(Array.from(frame.frame.images['weapp-owned-canvas:1'].pixels), [0, 0, 0, 255])
    assert.equal(frame.observation.state.requiresRestart, false)
  }
  await assert.rejects(f.client.requestHost('native.snapshots', { values: first.frame }), { code: 'ERR_RPC_PAYLOAD_TOO_LARGE' })
  assert.equal(f.client.state, 'open'); assert.deepEqual(f.failures, [])
})

test('frame byte-limit failure retains the genuine final ordered observation and the healthy client', { timeout: 5000 }, async t => {
  const f = fixture(t, { messagePort: true, host: { onFramePrepared(host) {
    host.frame.images = { 'weapp-owned-canvas:1': { width: 8192, height: 513, pixels: [] } }
  } } })
  const loaded = await f.load({ ...EXTERNAL_V1, ...OBSERVE_V1 })
  let wire
  await assert.rejects(f.client.requestHost('frame', {}), error => {
    wire = error.details
    assert.equal(error.code, 'ERR_RPC_PAYLOAD_TOO_LARGE')
    return true
  })
  assert.equal(wire.observation.state.renderRevision, '1')
  assert.notEqual(wire.observation.sequence, loaded.observation.sequence)
  assert.equal(wire.observation.state.requiresRestart, false)
  const current = await f.client.requestHost('state', {})
  assert.deepEqual(current.observation, wire.observation, 'response reuses the genuine sequence')
  assert.equal(f.client.state, 'open')
  assert.deepEqual(f.failures, [])
})

test('ordinary metadata encode failure retains final observation without granting frame bytes an array exemption', { timeout: 5000 }, async t => {
  const f = fixture(t, { messagePort: true, host: { onFramePrepared(host) {
    host.frame.images = { 'weapp-owned-canvas:1': { width: 1, height: 1, pixels: [0, 0, 0, 255] } }
    host.frame.unrelated = Array(20000).fill(0)
  } } })
  await f.load({ ...EXTERNAL_V1, ...OBSERVE_V1 })
  let wire
  await assert.rejects(f.client.requestHost('frame', {}), error => {
    wire = error.details
    assert.equal(error.code, 'ERR_RPC_PAYLOAD_TOO_LARGE')
    assert.match(error.message, /ordinary.*node budget/)
    return true
  })
  assert.equal(wire.observation.state.renderRevision, '1')
  assert.equal(f.client.state, 'open')
  assert.deepEqual(f.failures, [])
})

test('BufferURL resource transfer requires exact lease path and never falls back to hash-only reads', { timeout: 5000 }, async t => {
  const key = { sessionId: 'session-fixture', pageId: '1', documentRevision: '1', presentationRevision: '2', surfaceGeneration: '3', profile: 'webview' }
  const hash = 'b'.repeat(64), path = '__container_buffer_urls/' + 'a'.repeat(48)
  const f = fixture(t, { host: { resourceKey: key, resourceHash: hash } }); await f.load()
  let live=true, reads=0
  f.host.browser_view_resource_at_path = (keyJson,sha256,actualPath) => { assert.deepEqual(JSON.parse(keyJson),key); assert.equal(sha256,hash); assert.equal(actualPath,path); reads++; if(!live)throw Error('BufferURL revoked'); return f.host.memory.subarray(2,6) }
  f.host.browser_view_resource = () => { throw Error('digest-only read must not authorize BufferURL') }
  const resource=await f.client.requestHost('resource',{key,sha256:hash,path});assert.equal(resource.path,path);assert.deepEqual([...new Uint8Array(resource.bytes)],[9,8,7,6]);assert.equal(reads,1)
  live=false;await assert.rejects(f.client.requestHost('resource',{key,sha256:hash,path}),/BufferURL revoked/);assert.equal(reads,2)
  for(const invalid of ['../'+path,path+'?x',path.slice(0,-1),'wxbuffer://'+'a'.repeat(48)])await assert.rejects(f.client.requestHost('resource',{key,sha256:hash,path:invalid}),error=>error.code==='ERR_RENDER')
  assert.equal(reads,2);delete f.host.browser_view_resource_at_path
  await assert.rejects(f.client.requestHost('resource',{key,sha256:hash,path}),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY')
})


test('animation baseline/sample gates use their exact nested keys before native entry while abort stays available', async t => {
  const f = fixture(t), loaded = await f.load(OBSERVE_V1)
  const key = { sessionId: f.client.sessionId, pageId: '1', documentRevision: '1', presentationRevision: '1',
    surfaceGeneration: loaded.observation.state.surfaceGeneration, profile: 'webview' }
  await f.bridge('app.lifecycle', { event: 'hide' }); await f.bridge('app.lifecycle', { event: 'show' })
  const before = f.log.filter(entry => entry.method === 'dispatch').length
  for (const [op, payload] of [
    ['view.animation.baseline', { version: '1.0', requestId: 'baseline', key, epoch: '1', values: [] }],
    ['view.sample.prepare', { version: '1.0', baseKey: key, baseGeometryEpoch: '1', sampleDemandRevision: '1' }],
    ['view.sample.presented', { version: '1.0', permit: { key }, geometry: { key } }],
  ]) assert.equal((await outcome(f.bridge(op, payload))).error.code, 'ERR_CANCELLED')
  assert.equal(f.log.filter(entry => entry.method === 'dispatch').length, before)
  const abort = { version: '1.0', key }
  await f.client.requestHost('view.sample.abort', abort)
  assert.deepEqual(f.log.filter(entry => entry.method === 'dispatch').at(-1).request.payload, abort)
  assert.equal(f.log.filter(entry => entry.method === 'dispatch').at(-1).request.op, 'view.sample.abort')
})

test('animation operations preserve indivisible host admission and canonical optional demand observations', async t => {
  const f = fixture(t), loaded = await f.load(OBSERVE_V1), key = { sessionId: f.client.sessionId, pageId: '1',
    surfaceGeneration: loaded.observation.state.surfaceGeneration, profile: 'webview' }
  for (const op of ['view.animation.baseline', 'view.sample.prepare', 'view.sample.presented']) {
    const before = f.log.filter(entry => entry.method === 'dispatch').length
    const rejected = await outcome(f.client.requestHost('bridge', { batch: { messages: [
      bridgeEnvelope(f.client, 'app.lifecycle', { event: 'hide' }), bridgeEnvelope(f.client, op, { key, baseKey: key, permit: { key } }),
    ] } }))
    assert.equal(rejected.error.code, 'ERR_INVALID_REQUEST')
    assert.equal(f.log.filter(entry => entry.method === 'dispatch').length, before)
  }
  const extended = structuredClone(loaded.observation); extended.state.sampleDemandRevision = '18446744073709551615'
  const copied = copyOrderedObservation(extended, extended.state.owner)
  assert.equal(copied.state.sampleDemandRevision, '18446744073709551615')
  assert.equal(Object.isFrozen(copied.state), true)
  for (const token of [1, null, '01', '-1', '18446744073709551616']) {
    extended.state.sampleDemandRevision = token
    assert.throws(() => copyOrderedObservation(extended, extended.state.owner), error => error.code === 'ERR_PROTOCOL_VERSION')
  }
})


for (const mode of ['tasks', 'throw', 'reject']) test(`ordered Worker task scheduling retains close and frame ownership: ${mode}`, async t => {
  let submissions = 0
  const f = fixture(t, { postTask: callback => {
    submissions++
    if (mode === 'throw') throw Error('task submission unavailable')
    if (mode === 'reject') return Promise.reject(Error('task submission unavailable'))
    return new Promise(resolve => setImmediate(() => { callback(); resolve() }))
  } })
  const loading = f.load({ renderer: 'external-frame' })
  assert.equal(f.host, undefined, 'receive must never enter WASM synchronously')
  await loading
  await f.bridge('module.call', { module: 'pages/home/index.js', export: 'update', args: [] })
  const frame = await f.client.requestHost('frame', {})
  assert.ok(frame.renderRevision)
  const closed = await f.client.close()
  assert.equal(closed.closed, true)
  assert.equal(f.worker.terminated, 1)
  assert.ok(submissions >= 4)
})
