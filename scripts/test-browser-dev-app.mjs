/** Application orchestration contracts. The HTTP client is production code;
 * fetch, manager, DOM and time progression are controlled dependencies. No Rust
 * server, real Worker, generated WASM, presenter, browser or GPU runs here. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { BrowserDevApplication, browserDevWait } from '../examples/hosts/web-wasm/browser-dev-app.mjs'
import { BrowserDevHttpControl } from '../crates/container-simulator/src/browser-dev-http-control.mjs'

const baseUrl = 'http://127.0.0.1:58730/', runId = 'app-test', clientId = 'app-client'
const preview = { version: '1.0', runId, previewId: 'preview-test', leaseRevision: '2' }
const bootstrap = () => ({ version: '1.0', baseUrl, runId, clientId, preview: structuredClone(preview) })
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const err = code => Object.assign(new Error(code), { code })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {}); return { promise, resolve, reject } }
const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
const until = async predicate => { for (let i = 0; i < 2000 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate(), 'expected controlled boundary') }
const root = () => ({ append() {}, ownerDocument: { createElement() {} } })
const site = (id = '1') => ({ version: '1.0', runId, siteId: id, tokenId: id.repeat(64),
  portable: { packGeneration: id, sourceRevision: id, compilerReceiptSequence: id,
    manifestSha256: 'a'.repeat(64), integrityRoot: 'b'.repeat(64), selectedRoute: 'pages/home/index' },
  runtime: { bundleSha256: 'c'.repeat(64), producerReportSha256: 'd'.repeat(64), sourceInventorySha256: 'e'.repeat(64), sourceCommit: 'f'.repeat(40) },
  startup: { revision: '1', sha256: 'a'.repeat(64), metricsRevision: '1' },
  index: { sha256: 'b'.repeat(64), size: '100' }, transportBackend: 'external-frame' })
const snapshot = (extra = {}) => ({ version: '1.0', runId, controlRevision: '3', terminalCleanupRevision: '0', preview: structuredClone(preview),
  stopped: false, portableCurrent: true, offeredSite: site(), ...extra })
const response = (url, value, options = {}) => ({ url, status: 200, redirected: false, type: 'basic', headers: new Headers({ 'content-type': 'application/json' }),
  body: new ReadableStream({ start(controller) { controller.enqueue(bytes(value)); controller.close() } }), ...options })

function fixture(options = {}) {
  let observation = snapshot(), current = null
  const calls = [], offers = [], events = [], diagnostics = [], requests = [], recoveryRetries = [], managerStatus = { finalAcknowledgements: { pending: 0 } }
  const managerClose = deferred(), transportDrain = deferred(), managerDrain = deferred()
  if (!options.holdClose) managerClose.resolve({ closed: true, workerClosed: true, coordinatorStopped: true })
  if (!options.holdDrain) transportDrain.resolve({ drained: true })
  if (!options.holdManagerDrain) managerDrain.resolve()
  const manager = {
    get status() { return managerStatus },
    offer(value) {
      events.push(`offer:${value.site.siteId}`)
      const ready = deferred(), presented = deferred()
      current = { identity: { siteId: value.site.siteId }, ready: ready.promise, presented: presented.promise, controls: { ready, presented } }
      offers.push({ value, handle: current }); return current
    },
    close() { events.push('manager:close'); return managerClose.promise },
    request(value, params) { requests.push({ value, params }); return Promise.resolve('result') },
    retrySurfaceRecovery(value) { recoveryRetries.push(value); return options.retrySurfaceRecovery?.(value) ?? Promise.resolve({ recovered: true }) },
    retryFinalAcknowledgements(value) { events.push('manager:ack-retry'); return options.retryAcknowledgements?.(value, managerStatus)
      ?? { inspected: 0, started: 0, reachedEnd: true } },
    retryControlRetirements(value) { events.push('manager:retire-retry'); return options.retryRetirements?.(value, managerStatus)
      ?? { inspected: 0, started: 0 } },
    async drainControlWork() { options.onManagerDrain?.(); await managerDrain.promise; return managerStatus },
  }
  const control = options.control ?? new BrowserDevHttpControl({ baseUrl, runId, clientId, secret: 'not-in-app-status',
    ...(options.retirement ? { retirementVersion: '1.0' } : {}),
    fetch: async (url, init) => { calls.push({ url, init }); return options.observe ? options.observe(url, init) : response(url, observation) } })
  const originalClose = control.close.bind(control), originalDrain = control.drain.bind(control)
  control.close = () => { events.push('transport:close'); return originalClose() }
  control.drain = async () => { events.push('transport:drain'); await transportDrain.promise; return originalDrain() }
  const surfaceRoot = options.root ?? root(), config = options.bootstrap ?? { ...bootstrap(), ...(options.retirement ? { retirementVersion: '1.0' } : {}) }
  const app = new BrowserDevApplication({ bootstrap: config, surfaceRoot, control, intervalMs: 60_000,
    createManager: options.createManager ?? (value => { calls.push({ managerOptions: value }); return manager }),
    fetch: options.fetch ?? (async (url, init) => { calls.push({ url, init }); return response(url, '{"schemaVersion":1}') }),
    onDiagnostic: value => diagnostics.push(value), ...options.app })
  return { app, control, manager, managerClose, managerStatus, managerDrain, transportDrain, calls, offers, events, diagnostics, requests, recoveryRetries, surfaceRoot,
    set observation(value) { observation = value }, get current() { return current } }
}

test('application coalesces only the same bound surface retry and cancels queued retry on close', async () => {
  const held=deferred(),h=fixture({retrySurfaceRecovery:()=>held.promise})
  const intent={ownerKey:{ownerId:'original'},lossId:'1'}
  try {
    const pending=h.app.retrySurfaceRecovery(intent)
    assert.equal(h.app.retrySurfaceRecovery(structuredClone(intent)),pending)
    await assert.rejects(h.app.retrySurfaceRecovery({...intent,lossId:'2'}),{code:'ERR_CANCELLED'})
    intent.lossId='99';await tick()
    assert.equal(h.app.status.surfaceRetryPending,true);assert.equal(h.recoveryRetries.length,1)
    assert.equal(h.recoveryRetries[0].lossId,'1')
    held.resolve({recovered:true});await pending;assert.equal(h.app.status.surfaceRetryPending,false)
    const queued=h.app.retrySurfaceRecovery({ownerKey:{ownerId:'original'},lossId:'2'})
    const closing=h.app.close();await assert.rejects(queued,{code:'ERR_CANCELLED'});await closing
    assert.equal(h.recoveryRetries.length,1)
  } finally {held.resolve();await h.app.close()}
})

test('surface retry failure keeps diagnostics and permits an explicit subsequent retry', async () => {
  let fail=true;const h=fixture({retrySurfaceRecovery:async()=>{if(fail)throw err('ERR_RENDER');return {recovered:true}}})
  const intent={ownerKey:{ownerId:'original'},lossId:'1'}
  try {
    await assert.rejects(h.app.retrySurfaceRecovery(intent),{code:'ERR_RENDER'})
    assert.equal(h.app.status.surfaceRetryPending,false)
    assert.equal(h.app.status.lastError.phase,'surface-recovery');assert.equal(h.diagnostics.length,1)
    fail=false;await h.app.retrySurfaceRecovery(intent);assert.equal(h.recoveryRetries.length,2)
  } finally {await h.app.close()}
})

test('development entry exposes a retry only for a blocked surface and passes its exact owner and loss', async () => {
  const source=await readFile(new URL('../examples/hosts/web-wasm/browser-dev-entry.mjs',import.meta.url),'utf8')
  const elements=new Map(),requests=[],window={addEventListener(){}}
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',listeners:new Map(),remove(){},addEventListener(kind,callback){this.listeners.set(kind,callback)}})
    return elements.get(id)
  }
  element('weapp-dev-bootstrap').textContent=JSON.stringify({bootstrap:{},secret:'test-only-secret'})
  let hooks
  class Application {
    constructor(options){hooks=options;this.status={phase:'watching'}}
    start(){return Promise.resolve()}
    retrySurfaceRecovery(value){requests.push(value);return Promise.resolve()}
  }
  vm.runInNewContext(source.replace(/^import .*\n/gm,''),{BrowserDevApplication:Application,BrowserDevHttpControl:class{},document:{getElementById:element},window})
  const executing={ownerKey:{ownerId:'original'},surfaceRecovery:{version:'1.0',lossId:'2',phase:'blocked'}}
  hooks.onState({phase:'watching',manager:{executing}})
  const button=element('dev-retry-surface')
  assert.equal(button.hidden,false);assert.equal(button.disabled,false)
  assert.ok(element('dev-status').textContent.includes('画面恢复     blocked'))
  button.listeners.get('click')();await tick()
  assert.equal(requests.length,1);assert.equal(requests[0].ownerKey,executing.ownerKey);assert.equal(requests[0].lossId,'2')
  assert.equal(typeof window.weappContainerDev.retrySurfaceRecovery,'function')
  hooks.onState({phase:'watching',surfaceRetryPending:true,manager:{executing}});assert.equal(button.disabled,true)
  executing.surfaceRecovery={...executing.surfaceRecovery,phase:'recovering'}
  hooks.onState({phase:'watching',manager:{executing}});assert.equal(button.hidden,true)
  button.listeners.get('click')();assert.equal(requests.length,1)
  executing.surfaceRecovery={...executing.surfaceRecovery,phase:'blocked'}
  hooks.onState({phase:'closing',manager:{executing}});assert.equal(button.hidden,true)
  button.listeners.get('click')();assert.equal(requests.length,1)
})

test('authenticated observe hands original immutable startup to one manager without ledger commands', async () => {
  const h = fixture()
  try {
    const result = await h.app.refresh()
    assert.equal(result.offered, true); assert.equal(h.offers.length, 1)
    const observationCall = h.calls.find(value => value.url?.endsWith('/observe'))
    assert.equal(observationCall.init.method, 'POST'); assert.deepEqual(JSON.parse(new TextDecoder().decode(observationCall.init.body)), { version: '1.0' })
    assert.equal(observationCall.init.headers['X-Weapp-Dev-Secret'], 'not-in-app-status')
    const startupCall = h.calls.find(value => value.url?.endsWith('worker-product-config.json'))
    assert.equal(startupCall.url, `${baseUrl}__weapp/pack/${runId}/1/worker-product-config.json`)
    assert.equal(startupCall.init.redirect, 'error'); assert.equal(startupCall.init.credentials, 'same-origin')
    assert.deepEqual(h.offers[0].value, { site: site(), startupJson: '{"schemaVersion":1}' })
    assert.equal(h.control.status.requests, 0); assert.equal(h.control.status.retainedBytes, 0)
    assert.ok(!JSON.stringify(h.app.status).includes('not-in-app-status'))
    for (let i = 0; i < 80; i++) await h.app.refresh()
    assert.equal(h.offers.length, 1); assert.equal(h.control.status.requests, 0); assert.equal(h.control.status.retainedBytes, 0)
  } finally { await h.app.close() }
})

test('retirement is negotiated by trusted bootstrap and the original transport, never inferred', async () => {
  const disabled = fixture()
  try {
    await disabled.app.refresh(); await disabled.app.refresh()
    assert.equal(disabled.events.includes('manager:retire-retry'), false)
  } finally { await disabled.app.close() }
  for (const options of [
    { bootstrap: { ...bootstrap(), retirementVersion: '1.0' } },
    { retirement: true, bootstrap: bootstrap() },
    { bootstrap: { ...bootstrap(), retirementVersion: '2.0' } },
  ]) assert.throws(() => fixture(options), { code: 'ERR_PROTOCOL_VERSION' })
  assert.throws(() => fixture({ retirement: true, createManager: () => ({ offer() {}, close() {}, request() {}, retryFinalAcknowledgements() {} }) }),
    /manager retirement barrier/)
})

test('negotiated bounded maintenance precedes every observation including unchanged and failed-build revisions', async () => {
  let acknowledgements = 0, retirements = 0
  const h = fixture({ retirement: true,
    retryAcknowledgements(options) { assert.deepEqual(options, { maxOperations: 64 }); acknowledgements++; return { inspected: 0, started: 0, reachedEnd: true } },
    retryRetirements(options) { assert.deepEqual(options, { maxOperations: 64 }); retirements++ },
  })
  try {
    await h.app.refresh(); await h.app.refresh()
    h.observation = snapshot({ controlRevision: '4', portableCurrent: false, offeredSite: null,
      sourceDiagnostic: { code: 'BUILD_ERROR', message: 'bad build' } })
    await h.app.refresh(); await h.app.refresh()
    assert.equal(acknowledgements, 4); assert.equal(retirements, 4)
    assert.equal(h.offers.length, 1)
    assert.deepEqual(h.events.filter(value => value !== 'offer:1'),
      Array.from({ length: 4 }, () => ['manager:ack-retry', 'manager:retire-retry']).flat())
  } finally { await h.app.close() }
  assert.equal(retirements, 4, 'Stop starts no new retirement work')
})

test('Stop drains admitted retirement work without retrying it or making retirement success mandatory', async () => {
  const h = fixture({ retirement: true, holdDrain: true })
  await h.app.refresh()
  h.managerStatus.controlRetirements = { enabled: true, inFlight: 1, failed: 1 }
  const retiringCalls = h.events.filter(value => value === 'manager:retire-retry').length
  let done = false
  const closing = h.app.close(); void closing.then(() => { done = true })
  await until(() => h.events.includes('transport:drain'))
  assert.equal(done, false); assert.equal(h.events.includes('transport:close'), false)
  assert.equal(h.events.filter(value => value === 'manager:retire-retry').length, retiringCalls)
  h.managerStatus.controlRetirements.inFlight = 0
  h.transportDrain.resolve(); await closing
  assert.equal(h.app.status.phase, 'closed'); assert.equal(h.managerStatus.controlRetirements.failed, 1)
  assert.equal(h.events.filter(value => value === 'manager:retire-retry').length, retiringCalls)
})

test('Stop waits manager ACK settlement before draining HTTP and checking pending work', async () => {
  let entered = false
  const h = fixture({ retirement: true, holdManagerDrain: true, onManagerDrain() { entered = true } })
  h.managerStatus.finalAcknowledgements.pending = 1
  const closing = h.app.close()
  let done = false; void closing.then(() => { done = true })
  await until(() => entered)
  assert.equal(h.control.status.pendingActual, 0, 'manager-reserved work need not have started an HTTP job')
  assert.equal(h.events.includes('transport:drain'), false, 'transport drain follows actual manager settlement')
  await tick()
  assert.equal(done, false); assert.equal(h.app.status.phase, 'closing')
  assert.equal(h.events.includes('transport:close'), false)
  h.managerStatus.finalAcknowledgements.pending = 0
  h.managerDrain.resolve(); await closing
  assert.equal(h.app.status.phase, 'closed')
  assert.equal(h.events.filter(value => value === 'manager:ack-retry').length, 1)
})

for (const mode of ['same-turn', 'ACK-reentry', 'retirement-reentry']) test(`Stop ${mode} fences deferred maintenance and observations`, async () => {
  let closing, h
  const stop = () => { closing ??= h.app.close() }
  h = fixture({ retirement: true,
    retryAcknowledgements() {
      if (mode === 'ACK-reentry') stop()
      return { inspected: 0, started: 0, reachedEnd: true }
    },
    retryRetirements() { if (mode === 'retirement-reentry') stop() },
  })
  const refreshing = h.app.refresh()
  if (mode === 'same-turn') stop()
  await assert.rejects(refreshing, { code: 'ERR_CANCELLED' }); await closing
  assert.equal(h.calls.some(value => value.url?.endsWith('/observe')), false)
  assert.equal(h.events.filter(value => value === 'manager:retire-retry').length, mode === 'retirement-reentry' ? 1 : 0)
  const stopAt = h.events.indexOf('manager:close')
  assert.equal(h.events.slice(stopAt).includes('manager:retire-retry'), false)
  assert.equal(h.app.status.phase, 'closed')
})

for (const mode of ['injected', 'default']) test(`${mode} startup fetch keeps its normal function receiver`, async context => {
  const calls = []
  function fetcher(url, init) {
    assert.equal(this, mode === 'default' ? globalThis : undefined, 'startup GET must not borrow the application or transport as its receiver')
    calls.push({ url, init }); return response(url, '{"schemaVersion":1}')
  }
  if (mode === 'default') context.mock.method(globalThis, 'fetch', fetcher)
  const h = fixture(mode === 'default' ? { app: { fetch: undefined } } : { fetch: fetcher })
  try {
    assert.equal((await h.app.refresh()).offered, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `${baseUrl}__weapp/pack/${runId}/1/worker-product-config.json`)
    assert.equal(calls[0].init.method, 'GET')
    assert.deepEqual(h.offers[0].value, { site: site(), startupJson: '{"schemaVersion":1}' })
  } finally { await h.app.close() }
})

test('informational owner diagnostics pass through the application without changing its error state', async () => {
  const h = fixture()
  try {
    await h.app.refresh()
    const hooks = h.calls.find(value => value.managerOptions).managerOptions
    const diagnostic = Object.freeze({ level: 'info', message: 'View renderer ready', stale: false })
    hooks.onDiagnostic(diagnostic)
    assert.deepEqual(h.diagnostics, [diagnostic]); assert.equal(h.app.status.lastError, null)
  } finally { await h.app.close() }
})

test('the actual entry displays informational severity, optional codes and original error messages', async () => {
  const source = await readFile(new URL('../examples/hosts/web-wasm/browser-dev-entry.mjs', import.meta.url), 'utf8')
  const elements = new Map(), element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', remove() {}, addEventListener() {} })
    return elements.get(id)
  }
  element('weapp-dev-bootstrap').textContent = JSON.stringify({ bootstrap: {}, secret: 'test-only-secret' })
  let hooks
  class Application {
    constructor(options) { hooks = options; this.status = { phase: 'watching' } }
    start() { return Promise.resolve() }
  }
  vm.runInNewContext(source.replace(/^import .*\n/gm, ''), {
    BrowserDevApplication: Application, BrowserDevHttpControl: class {}, TextEncoder,
    document: { getElementById: element }, window: { addEventListener() {} },
  })
  hooks.onDiagnostic({ level: 'info', message: 'View renderer ready' })
  hooks.onDiagnostic({ level: 'warn', message: 'Optional font unavailable' })
  hooks.onDiagnostic({ level: 'info', code: 'VIEW_READY', message: 'Ready with a real code' })
  hooks.onDiagnostic(Object.assign(new Error('Original timeout'), { code: 'ERR_TIMEOUT' }))
  const runtimeStack='ReferenceError: missing export\n    at pages/home/index.js:12:7\n<script>doNotRun()</script>'
  hooks.onDiagnostic({level:'error',source:'quickjs',name:'ReferenceError',message:'missing export',stack:runtimeStack})
  hooks.onDiagnostic({level:'error',source:'v8',name:'TypeError',message:'stack was bounded',stack:'🧪'.repeat(2048),stackTruncated:true})
  const text = element('dev-diagnostics').textContent
  for (const expected of ['INFO\nView renderer ready', 'WARN\nOptional font unavailable',
    'INFO VIEW_READY\nReady with a real code', 'ERROR ERR_TIMEOUT\nOriginal timeout']) assert.ok(text.includes(expected), expected)
  assert.equal(text.includes('ERR_ENGINE'), false); assert.equal(text.includes('Browser dev operation failed'), false)
  assert.ok(text.includes(`ERROR [quickjs] ReferenceError\nmissing export\n${runtimeStack}`),'Runtime stack must reach the actual entry textContent sink')
  assert.ok(text.includes('ERROR [v8] TypeError\nstack was bounded'));assert.ok(text.includes('[stack truncated]'))
  hooks.onDiagnostic({level:'error',code:'码'.repeat(128),name:'名'.repeat(128),message:'🧪'.repeat(2048),
    stack:'🧪'.repeat(4095)+'x'+'🧪'.repeat(4095)})
  const [header,boundedMessage,boundedStack,omission]=element('dev-diagnostics').textContent.split('\n\n').at(-1).split('\n')
  assert.ok(header.endsWith(`ERROR ${'码'.repeat(42)} ${'名'.repeat(42)}`))
  assert.equal(boundedMessage,'🧪'.repeat(512));assert.equal(Buffer.byteLength(boundedMessage),2048)
  assert.equal(boundedStack,'🧪'.repeat(2048));assert.equal(Buffer.byteLength(boundedStack),8192)
  assert.equal(omission,'[stack truncated]','The direct entry catch path must report its own byte-bound truncation too')
  let getterCalls=0
  const unsafe=Object.defineProperties({},Object.fromEntries(['error','level','code','name','source','message','stack','stackTruncated'].map(key=>[key,{get(){getterCalls++;throw Error('display getter must not run')}}])))
  hooks.onDiagnostic(unsafe);assert.equal(getterCalls,0)
  for(let index=0;index<40;index++)hooks.onDiagnostic({level:'error',message:`bounded log ${index}`,stack:'at app.js:1:1'})
  const retained=element('dev-diagnostics').textContent
  assert.equal(retained.includes('missing export'),false);assert.equal(retained.includes('bounded log 7\n'),false)
  assert.ok(retained.includes('bounded log 8\n'));assert.ok(retained.includes('bounded log 39\n'))
  assert.equal(retained.split('at app.js:1:1').length-1,32,'Stack display must obey the existing 32-record retention bound')
  const executing={owner:{transportBackend:'external-frame'},runtimeReady:true,hasPresented:true,inputEnabled:true,
    submission:{phase:'submitted',value:{physicalSize:{width:828,height:1472},context:{renderer:'contract renderer',unmaskedRenderer:null,physicalHardware:'unknown'},
      presentation:{gpuCompletion:'not-waited'}}}}
  hooks.onState({phase:'watching',manager:{executing}})
  let panel=element('dev-status').textContent
  for(const expected of ['browser Worker / QuickJS WASM','Skia / CanvasKit','WebGL2 GPU surface / submitted','828 × 1472','contract renderer','unknown / not-waited'])
    assert.ok(panel.includes(expected),expected)
  executing.submission.phase='accepted';hooks.onState({phase:'watching',manager:{executing}})
  assert.ok(element('dev-status').textContent.includes('WebGL2 GPU surface / accepted'))
  hooks.onState({phase:'watching',manager:{executing:{owner:{transportBackend:'browser-view'}}}})
  panel=element('dev-status').textContent;assert.ok(panel.includes('WebView / DOM'));assert.ok(panel.includes('browser DOM/CSS'))
  assert.equal(panel.includes('WebGL2 GPU surface'),false)

})

test('one actual observation is shared by concurrent refresh/start; close clears its scheduled pump', async () => {
  const held = deferred(), h = fixture({ observe: async (url, init) => { await held.promise; return response(url, snapshot()) } })
  const first = h.app.refresh(), again = h.app.start()
  assert.equal(first, again)
  await until(() => h.calls.filter(value => value.url?.endsWith('/observe')).length === 1)
  assert.equal(h.control.status.lanes.observation.inFlight, 1)
  held.resolve(); await first
  assert.equal(h.offers.length, 1); await h.app.close(); assert.equal(h.app.status.phase, 'closed')
  await assert.rejects(h.app.start(), { code: 'ERR_CANCELLED' })
})

test('bootstrap and coordinator identities compare structurally across JSON serializer key order', async () => {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
  const h = fixture({ bootstrap: sorted(bootstrap()) })
  try {
    assert.equal((await h.app.refresh()).offered, true)
    h.managerStatus.snapshot = sorted(snapshot())
    assert.deepEqual(await h.app.refresh(), { offered: false, unchanged: true })
    assert.equal(h.offers.length, 1)
    h.observation = sorted(snapshot({ offeredSite: site('2') }))
    await assert.rejects(h.app.refresh(), /conflicting observations/)
    assert.equal(h.offers.length, 1, 'different content at the same revision pair still fails closed')
  } finally { await h.app.close() }
})

test('building/error observations preserve the last offer and a later new site is offered exactly once', async () => {
  const h = fixture()
  try {
    await h.app.refresh(); const retained = h.current
    h.observation = snapshot({ controlRevision: '4', portableCurrent: false, offeredSite: null, sourceDiagnostic: { code: 'BUILD_ERROR', message: 'syntax failed' } })
    await h.app.refresh(); await h.app.refresh()
    assert.equal(h.offers.length, 1); assert.equal(h.current, retained); assert.equal(h.diagnostics.length, 1)
    h.observation = snapshot({ controlRevision: '5', offeredSite: site('2') })
    await h.app.refresh(); assert.equal(h.offers.length, 2); assert.equal(h.app.status.lastError, null)
    assert.equal(h.events.filter(value => value === 'manager:close').length, 0, 'replacement remains on the same manager')
  } finally { await h.app.close() }
})

test('failed startup retains current owner, releases its reader, and permits explicit refresh retry', async () => {
  let fail = false, cancelled = 0
  const h = fixture({ fetch: async url => fail ? response(url, null, { body: new ReadableStream({
    start(controller) { controller.enqueue(bytes('x'.repeat(65537))) }, cancel() { cancelled++ },
  }) }) : response(url, '{}') })
  try {
    await h.app.refresh(); const retained = h.current
    h.observation = snapshot({ controlRevision: '4', offeredSite: site('2') }); fail = true
    await assert.rejects(h.app.refresh(), { code: 'ERR_PROTOCOL_VERSION' })
    assert.equal(cancelled, 1); assert.equal(h.current, retained); assert.equal(h.offers.length, 1)
    fail = false; await h.app.refresh(); assert.equal(h.offers.length, 2)
  } finally { await h.app.close() }
})

test('late observations are ignored and equal revision equivocation cannot replace an owner', async () => {
  const h = fixture()
  try {
    await h.app.refresh()
    h.observation = snapshot({ controlRevision: '2', offeredSite: site('2') })
    assert.deepEqual(await h.app.refresh(), { ignored: 'late-observation' }); assert.equal(h.offers.length, 1)
    h.observation = snapshot({ offeredSite: site('2') })
    await assert.rejects(h.app.refresh(), /conflicting observations/); assert.equal(h.offers.length, 1)
    h.observation = snapshot({ terminalCleanupRevision: '1', portableCurrent: false, offeredSite: null })
    await h.app.refresh(); assert.equal(h.app.status.observation.terminalCleanupRevision, '1')
  } finally { await h.app.close() }
})

test('manager control finals fence older or conflicting poll responses before fetching startup', async () => {
  const h = fixture()
  try {
    h.managerStatus.snapshot = snapshot({ controlRevision: '8', offeredSite: site('2') })
    assert.deepEqual(await h.app.refresh(), { ignored: 'late-observation' })
    assert.equal(h.offers.length, 0)
    assert.equal(h.calls.some(value => value.url?.endsWith('worker-product-config.json')), false)
    h.observation = snapshot({ controlRevision: '8', offeredSite: site('3') })
    await assert.rejects(h.app.refresh(), /conflicting observations/)
    assert.equal(h.offers.length, 0)
  } finally { await h.app.close() }
})

test('manager authority advanced during startup GET prevents the late offer from superseding a live owner', async () => {
  const held = deferred(); let secondStarted = false
  const h = fixture({ fetch: async url => {
    if (url.includes('/2/')) { secondStarted = true; await held.promise }
    return response(url, '{}')
  } })
  try {
    await h.app.refresh(); const retained = h.current
    h.observation = snapshot({ controlRevision: '4', offeredSite: site('2') })
    const refreshing = h.app.refresh(); await until(() => secondStarted)
    h.managerStatus.snapshot = snapshot({ controlRevision: '5', offeredSite: site('3') })
    held.resolve()
    assert.deepEqual(await refreshing, { ignored: 'late-observation' })
    assert.equal(h.offers.length, 1); assert.equal(h.current, retained)
  } finally { held.resolve(); await h.app.close() }
})

test('foreign run or preview cannot offer; stopped empty preview is a valid observation', async () => {
  const h = fixture()
  try {
    h.observation = snapshot({ preview: { ...preview, leaseRevision: '3' } })
    await assert.rejects(h.app.refresh(), /bootstrap run\/preview/); assert.equal(h.offers.length, 0)
    h.observation = snapshot({ runId: 'another' })
    await assert.rejects(h.app.refresh(), { code: 'ERR_PROTOCOL_VERSION' }); assert.equal(h.offers.length, 0)
    h.observation = snapshot({ stopped: true, preview: null, offeredSite: null })
    await h.app.refresh(); assert.equal(h.offers.length, 0)
  } finally { await h.app.close() }
})

test('server stop immediately gates input and closes the same manager without waiting on its own refresh', async () => {
  const h = fixture({ holdClose: true })
  await h.app.refresh()
  h.observation = snapshot({ controlRevision: '4', stopped: true, preview: null, offeredSite: null })
  assert.deepEqual(await h.app.refresh(), { offered: false, stopped: true })
  assert.equal(h.app.status.phase, 'closing')
  assert.equal(h.events.filter(value => value === 'manager:close').length, 1)
  await assert.rejects(h.app.request({ op: 'state' }), { code: 'ERR_CANCELLED' })
  assert.equal(h.events.includes('transport:close'), false)
  h.managerClose.resolve({ closed: true, workerClosed: true, coordinatorStopped: true })
  await h.app.close()
  assert.equal(h.app.status.phase, 'closed')
  assert.deepEqual(h.events, ['offer:1', 'manager:close', 'manager:ack-retry', 'transport:drain', 'transport:close'])
})

test('ready/presented rejections are observed; stale callbacks cannot overwrite new owner diagnostics', async () => {
  const h = fixture()
  try {
    await h.app.refresh(); const first = h.current
    first.controls.ready.reject(err('LOAD_FAILED')); await tick(); assert.equal(h.app.status.lastError.phase, 'runtime')
    h.observation = snapshot({ controlRevision: '4', offeredSite: site('2') }); await h.app.refresh()
    first.controls.presented.reject(err('OLD_PRESENT_FAILED')); await tick(); assert.equal(h.app.status.lastError, null)
    h.current.controls.presented.reject(err('PRESENT_FAILED')); await tick(); assert.equal(h.app.status.lastError.code, 'PRESENT_FAILED')
  } finally { await h.app.close() }
})

for (const phase of ['ready', 'presented']) test(`failed ${phase} intent is not automatically retried under fresh site identities`, async () => {
  const h = fixture()
  try {
    await h.app.refresh()
    h.current.controls[phase].reject(err('STARTUP_FAILED')); await tick()
    const retained = h.app.status.lastError
    assert.equal(h.app.status.startupRetryRequired, true)
    for (let index = 2; index <= 6; index++) {
      h.observation = snapshot({ controlRevision: String(index + 2), offeredSite: {
        ...site(), siteId: String(index), tokenId: String(index).repeat(64), descriptorSha256: String(index).repeat(64) } })
      const result = await h.app.refresh()
      assert.equal(result.offered, false)
      assert.equal(result.retryRequired, true)
      assert.equal(h.app.status.lastError, retained)
    }
    assert.equal(h.offers.length, 1)
    assert.equal(h.calls.filter(value => value.url?.endsWith('worker-product-config.json')).length, 1)
    const retried = await h.app.retryStartup()
    assert.equal(retried.offered, true); assert.equal(h.offers.length, 2)
    assert.equal(h.offers[1].value.site.siteId, '6', 'explicit retry uses the latest actual coordinator site')
    assert.equal(h.app.status.lastError, null)
    assert.equal(h.app.status.startupRetryRequired, false)
  } finally { await h.app.close() }
})

test('startup failure during a restaged immutable GET fences admission after that GET settles', async () => {
  const held = deferred(); let reads = 0
  const h = fixture({ fetch: async url => { if (++reads === 2) await held.promise; return response(url, '{"schemaVersion":1}') } })
  try {
    await h.app.refresh(); const first = h.current
    h.observation = snapshot({ controlRevision: '4', offeredSite: { ...site(), siteId: '2', tokenId: '2'.repeat(64) } })
    const refreshing = h.app.refresh(); await until(() => reads === 2)
    first.controls.ready.reject(err('STARTUP_FAILED')); await tick()
    held.resolve()
    assert.equal((await refreshing).retryRequired, true)
    assert.equal(h.offers.length, 1)
    assert.equal(h.app.status.lastError.code, 'STARTUP_FAILED')
  } finally { held.resolve(); await h.app.close() }
})

test('new semantic source can start after failure and stale rejection cannot latch it', async () => {
  const h = fixture()
  try {
    await h.app.refresh(); const failed = h.current
    failed.controls.ready.reject(err('STARTUP_FAILED')); await tick()
    h.observation = snapshot({ controlRevision: '4', offeredSite: site('2') })
    assert.equal((await h.app.refresh()).offered, true)
    failed.controls.presented.reject(err('LATE_FAILURE')); await tick()
    assert.equal(h.app.status.lastError, null)
    h.observation = snapshot({ controlRevision: '5', offeredSite: { ...site('2'), siteId: '3', tokenId: '3'.repeat(64) } })
    assert.equal((await h.app.refresh()).offered, true)
    assert.equal(h.offers.length, 3)
  } finally { await h.app.close() }
  await assert.rejects(h.app.retryStartup(), { code: 'ERR_CANCELLED' })
})

test('all producer, startup and backend pins participate in failed-intent identity', async t => {
  const changes = [
    ['pack generation', value => { value.portable.packGeneration = '2' }],
    ['source revision', value => { value.portable.sourceRevision = '2' }],
    ['compiler receipt', value => { value.portable.compilerReceiptSequence = '2' }],
    ['manifest', value => { value.portable.manifestSha256 = '2'.repeat(64) }],
    ['integrity', value => { value.portable.integrityRoot = '2'.repeat(64) }],
    ['route', value => { value.portable.selectedRoute = 'pages/second/index' }],
    ['runtime', value => { value.runtime.bundleSha256 = '2'.repeat(64) }],
    ['runtime producer', value => { value.runtime.producerReportSha256 = '2'.repeat(64) }],
    ['runtime source', value => { value.runtime.sourceInventorySha256 = '2'.repeat(64) }],
    ['runtime commit', value => { value.runtime.sourceCommit = '2'.repeat(40) }],
    ['startup revision', value => { value.startup.revision = '2' }],
    ['startup bytes', value => { value.startup.sha256 = '2'.repeat(64) }],
    ['metrics revision', value => { value.startup.metricsRevision = '2' }],
    ['index bytes', value => { value.index.sha256 = '2'.repeat(64) }],
    ['index size', value => { value.index.size = '200' }],
    ['backend', value => { value.transportBackend = 'browser-view' }],
  ]
  for (const [name, change] of changes) await t.test(name, async () => {
    const h = fixture()
    try {
      await h.app.refresh(); h.current.controls.ready.reject(err('STARTUP_FAILED')); await tick()
      const next = { ...site(), siteId: '2', tokenId: '2'.repeat(64) }; change(next)
      h.observation = snapshot({ controlRevision: '4', offeredSite: next })
      assert.equal((await h.app.refresh()).offered, true)
      assert.equal(h.offers.length, 2)
    } finally { await h.app.close() }
  })
})

test('close immediately gates manager while an uncooperative observation retains the actual barrier', async () => {
  const held = deferred(), h = fixture({ holdClose: true, holdDrain: true, observe: async url => { await held.promise; return response(url, snapshot()) } })
  const refreshing = h.app.start(); await until(() => h.calls.some(value => value.url?.endsWith('/observe')))
  const closing = h.app.close(); assert.equal(closing, h.app.close()); assert.deepEqual(h.events, ['manager:close'])
  let done = false; void closing.then(() => { done = true }); await tick(); assert.equal(done, false)
  h.managerClose.resolve({ closed: true, workerClosed: true, coordinatorStopped: true }); await tick()
  assert.equal(h.events.includes('transport:close'), false)
  held.resolve(); await assert.rejects(refreshing, { code: 'ERR_CANCELLED' }); await until(() => h.events.includes('transport:drain'))
  assert.equal(done, false); h.transportDrain.resolve(); await closing
  assert.deepEqual(h.events, ['manager:close', 'manager:ack-retry', 'transport:drain', 'transport:close'])
  assert.equal(h.offers.length, 0)
})

test('uncertain actual manager close retains its root and live transport instead of claiming shutdown', async () => {
  const h = fixture({ holdClose: true }), closing = h.app.close()
  h.managerClose.reject(err('ERR_RENDER')); await assert.rejects(closing, { code: 'ERR_RENDER' })
  assert.equal(h.app.status.phase, 'cleanup-failed'); assert.equal(h.app.status.cleanupRetryable, false)
  assert.equal(h.control.status.phase, 'open'); assert.equal(h.events.includes('transport:close'), false)
  await assert.rejects(h.app.retryCleanup(), /actual manager close remains unresolved/)
  assert.equal(h.events.filter(value => value === 'manager:close').length, 1)
  assert.throws(() => fixture({ root: h.surfaceRoot }), /retained application owner/)
  // Test owns this idle production transport and releases it explicitly. This
  // does not turn the retained application's failed manager close into success.
  await h.control.close()
})

test('pending final acknowledgements retain the original transport; successful close releases only its borrowed root', async () => {
  const h = fixture(); h.managerStatus.finalAcknowledgements.pending = 1
  await assert.rejects(h.app.close(), /acknowledgements remain/)
  assert.equal(h.control.status.phase, 'open'); await h.control.close()
  const first = fixture(), shared = first.surfaceRoot
  assert.throws(() => fixture({ root: shared }), /retained application owner/)
  await first.app.close()
  const next = fixture({ root: shared }); await next.app.close()
})

test('cleanup scans beyond the first 64 commands and drains each actual acknowledgement batch', async () => {
  let batches = 0
  const h = fixture({ retryAcknowledgements(options, status) {
    assert.equal(options.maxOperations, 64); batches++
    if (batches === 1) return { inspected: 64, started: 0, reachedEnd: false }
    status.finalAcknowledgements.pending = 0
    return { inspected: 17, started: 1, reachedEnd: true }
  } })
  h.managerStatus.finalAcknowledgements.pending = 1
  await h.app.close()
  assert.equal(batches, 2)
  assert.deepEqual(h.events, ['manager:close', 'manager:ack-retry', 'transport:drain', 'manager:ack-retry', 'transport:drain', 'transport:close'])
})

test('two unsuccessful ACK sweeps can explicitly retry cleanup on the same successful owner close', async () => {
  let succeed = false, batches = 0
  const h = fixture({ retryAcknowledgements(options, status) {
    batches++
    if (succeed) status.finalAcknowledgements.pending = 0
    return { inspected: 1, started: 1, reachedEnd: true }
  } })
  h.managerStatus.finalAcknowledgements.pending = 1
  await assert.rejects(h.app.close(), /acknowledgements remain unresolved/)
  assert.equal(batches, 2); assert.equal(h.control.status.phase, 'open')
  assert.equal(h.app.status.phase, 'cleanup-failed'); assert.equal(h.app.status.cleanupRetryable, true)
  assert.throws(() => fixture({ root: h.surfaceRoot }), /retained application owner/)
  succeed = true
  const retrying = h.app.retryCleanup()
  assert.equal(h.app.status.phase, 'closing'); assert.equal(h.app.status.cleanupRetryable, false)
  assert.equal(retrying, h.app.retryCleanup())
  await retrying
  assert.equal(h.app.status.phase, 'closed'); assert.equal(h.app.status.cleanupRetryable, false)
  assert.equal(h.events.filter(value => value === 'manager:close').length, 1)
  assert.equal(h.events.filter(value => value === 'transport:close').length, 1)
  const next = fixture({ root: h.surfaceRoot }); await next.app.close()
})

test('cleanup enforces a finite total scan budget and retains the original transport on exhaustion', async () => {
  let inspected = 0
  const h = fixture({ retryAcknowledgements(options) {
    inspected += options.maxOperations
    return { inspected: options.maxOperations, started: 0, reachedEnd: false }
  } })
  h.managerStatus.finalAcknowledgements.pending = 1
  await assert.rejects(h.app.close(), /acknowledgements remain unresolved/)
  assert.equal(inspected, 32768); assert.equal(h.control.status.phase, 'open')
  await h.control.close()
})

test('debug bridge retains exact owner identity and refuses new calls after close begins', async () => {
  const h = fixture(), request = { ownerKey: { ownerSerial: '1' }, op: 'state', payload: {} }, params = { timeoutMs: 500 }
  assert.equal(await h.app.request(request, params), 'result'); assert.deepEqual(h.requests, [{ value: request, params }])
  const close = h.app.close(); await assert.rejects(h.app.request(request), { code: 'ERR_CANCELLED' }); await close
})

test('bootstrap and surface ownership are explicit; secrets are not retained by the application', async () => {
  for (const change of [{ runId: '' }, { baseUrl: `${baseUrl}elsewhere` }, { secret: 'must-stay-in-transport' },
    { preview: { ...preview, runId: 'foreign' } }, { preview: { ...preview, leaseRevision: '0' } }]) {
    assert.throws(() => fixture({ bootstrap: { ...bootstrap(), ...change } }))
  }
  const h = fixture({ app: { onState() { throw new Error('UI observer error') } } })
  await h.app.refresh(); await h.app.close()
})

test('bounded wait timeout/abort never claim underlying job settled', async () => {
  const actual = deferred(), abort = new AbortController()
  const waiting = browserDevWait(actual.promise, { timeoutMs: 1000, signal: abort.signal })
  abort.abort(); await assert.rejects(waiting, { code: 'ERR_CANCELLED' })
  let settled = false; void actual.promise.then(() => { settled = true }); await tick(); assert.equal(settled, false)
  actual.resolve('late'); await tick(); assert.equal(settled, true)
  await assert.rejects(browserDevWait(new Promise(() => {}), { timeoutMs: 1 }), { code: 'ERR_TIMEOUT' })
})
