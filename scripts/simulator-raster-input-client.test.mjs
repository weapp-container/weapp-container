import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { SseBridgeTransport } from '../examples/hosts/web-wasm/dom-session-client.mjs'
import { attachSurfaceInput } from '../examples/hosts/web-wasm/surface-input.mjs'
import { UncorrelatedInputLedger } from '../examples/hosts/web-wasm/input-causal-ledger.mjs'
import { presentationFixture } from './simulator-client-binary-fixture.mjs'

const html = readFileSync(new URL('../crates/container-simulator/src/web-ui.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))

async function client(t, { realInput = false } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: '', style: {}, value: id === 'zoom' ? 'fit' : '', clientWidth: 600, clientHeight: 800,
    listeners: new Map(), captures: new Set(),
    addEventListener(type, callback) { this.listeners.set(type, callback) }, removeEventListener(type) { this.listeners.delete(type) },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 375, height: 667 }),
    setPointerCapture(id) { this.captures.add(id) }, hasPointerCapture(id) { return this.captures.has(id) }, releasePointerCapture(id) { this.captures.delete(id) },
  }]))
  const bindings = [], requests = [], listeners = new Map(), domListeners = new Map()
  let stream
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), hasFocus: () => false,
      addEventListener: (type, callback) => domListeners.set(type, callback), dispatchEvent: event => domListeners.get(event.type)?.(event) },
    window: { addEventListener() {} }, performance: { now: () => 0 }, devicePixelRatio: 1,
    TextEncoder, TextDecoder, MessageEvent, Event, SseBridgeTransport, UncorrelatedInputLedger,
    requestAnimationFrame() {}, setInterval: () => 1, clearInterval() {},
    attachSurfaceInput(canvas, options) {
      const actual = realInput ? attachSurfaceInput(canvas, options) : null
      const binding = { options, disposed: false, resets: 0,
        reset() { this.resets++; actual?.reset() }, dispose() { this.disposed = true; actual?.dispose() },
      }
      bindings.push(binding); return binding
    },
    EventSource: class {
      constructor() { stream = this }
      addEventListener(type, callback) { listeners.set(type, callback) }
      close() {}
    },
    fetch(url, options) {
      if (url === '/api/state') return Promise.resolve({ ok: true, json: async () => ({ status: 'ready', webRenderer: 'software', sessionId: 'session', currentPageId: '1', diagnostics: [], presentation: presentationFixture }) })
      if (url === '/api/presentation' && options?.method !== 'POST') return Promise.resolve({ ok: true, json: async () => presentationFixture })
      if (url === '/api/presentation') return Promise.resolve({ ok: true, status: 202, json: async () => ({ queued: true }) })
      if (url === '/api/frame') return new Promise(() => {})
      assert.equal(url, '/api/bridge')
      return new Promise(resolve => requests.push({ envelope: JSON.parse(options.body),
        complete(body = { queued: true }, status = 202) { resolve({ ok: status >= 200 && status < 300, status, json: async () => body }) },
      }))
    },
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context)
  vm.runInContext(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, ''), context)
  await tick(); await stream.onopen(); await tick()
  const evaluate = source => vm.runInContext(source, context)
  t.after(() => evaluate('closeEventStream()'))
  return { context, requests, bindings, nodes, evaluate,
    event(type, value) { listeners.get(type)({ type, data: JSON.stringify(value) }) },
    pointer(type, overrides = {}) { nodes.get('screen').listeners.get(type)({ pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 30, clientY: 40, preventDefault() {}, ...overrides }) },
    async send() {
      const binding = bindings.at(-1)
      const result = binding.options.send([{ type: 'tap', x: 30, y: 40 }], 'session', binding.options.epoch())
      result.catch(() => {})
      await tick()
      return { result, request: requests.at(-1), binding }
    },
  }
}

const final = (envelope, payload = { ok: true }) => ({ messages: [{ ...envelope, kind: 'response', payload }] })

test('raster input waits for its exact runtime SSE result and exposes structured rejection', async t => {
  const c = await client(t), { result, request, binding } = await c.send()
  assert.equal(request.envelope.op, 'event.batch')
  request.complete(); await tick()
  assert.equal(c.context.__weappRasterInput.phase, 'pending', 'HTTP queue admission is not application success')
  c.event('bridge', final({ ...request.envelope, requestId: 'unrelated' })); await tick()
  assert.equal(c.context.__weappRasterInput.phase, 'pending')
  c.event('bridge', final(request.envelope, { ok: false, error: { code: 'ERR_CANCELLED', message: 'render generation changed' } }))
  await assert.rejects(result, error => error.code === 'ERR_CANCELLED')
  assert.equal(c.context.__weappRasterInput.phase, 'error')
  assert.equal(c.context.__weappRasterInput.error.code, 'ERR_CANCELLED')
  binding.options.onError({ code: 'ERR_CANCELLED', message: 'render generation changed' })
  assert.match(c.nodes.get('overlay').textContent, /EVENT_FAILED: ERR_CANCELLED: render generation changed/)
})

test('raster input accepts SSE before HTTP and records only final application success', async t => {
  const c = await client(t), { result, request } = await c.send()
  c.event('bridge', final(request.envelope))
  assert.equal(await result, undefined, 'the surface callback exposes evidence through its receipt')
  assert.equal(c.context.__weappRasterInput.phase, 'applied')
  assert.equal(c.context.__weappRasterInput.result.ok, true)
  request.complete(); await tick()
  assert.equal(c.context.__weappRasterInput.phase, 'applied')
})

test('raster native inputs retain separate completion records without correlating a later frame',async t=>{
  const c=await client(t,{realInput:true})
  c.pointer('pointerdown',{timeStamp:100});c.pointer('pointerup',{timeStamp:102});await tick()
  c.pointer('pointerdown',{timeStamp:103});c.pointer('pointerup',{timeStamp:105});await tick()
  const pending=c.context.__weappInputTimingReport().remoteRaster
  assert.equal(pending.records.length,2)
  assert.equal(pending.records.every(value=>value.outcome==='pending'),true)
  // Native batching owns one request at a time; queued input stays distinct.
  const first=c.requests[0]
  first.complete();c.event('bridge',final(first.envelope));await tick()
  let report=c.context.__weappInputTimingReport().remoteRaster
  assert.equal(report.records[0].outcome,'protocol-completed');assert.equal(report.records[1].outcome,'pending')
  const second=c.requests[1]
  second.complete();c.event('bridge',final(second.envelope));await tick()
  report=c.context.__weappInputTimingReport().remoteRaster
  assert.equal(report.records.every(value=>value.outcome==='protocol-completed'),true)
  assert.equal(report.association,'unavailable');assert.equal(report.gate.status,'blocked')
  assert.equal(report.gate.inputToPresentP95Ms,null)
  assert.equal(Object.hasOwn(report,'candidates'),false)
  const metrics=c.context.__weappPresentationMetrics
  assert.equal(metrics.performanceGate,'blocked');assert.equal(metrics.compositorPresentedAt,null)
  assert.equal(Object.hasOwn(metrics,'inputToPresentMs'),false)
})

test('raster diagnostic completion failure cannot turn a genuine input success into a business rejection',async t=>{
  const c=await client(t)
  c.evaluate("rasterInputLedger.complete=()=>{throw new Error('diagnostic only')}")
  const {result,request}=await c.send()
  request.complete();c.event('bridge',final(request.envelope));await result
  assert.equal(c.context.__weappRasterInput.phase,'applied')
  assert.equal(c.context.__weappInputTimingReport().observerFailures,1)
})

test('pending density settings suspend old-frame input until the new generation is confirmed', async t => {
  const c = await client(t), binding = c.bindings.at(-1)
  c.evaluate("state.webRenderer='canvaskit';rendererBlocked=false;lastFrame={sessionId:'session',configGeneration:0,renderRevision:1};confirmedRendererIdentity=rendererIdentity(lastFrame)")
  assert.equal(Boolean(binding.options.active()), true)
  c.nodes.get('renderScale').value = '2'
  await c.evaluate('submitPresentation()')
  assert.equal(Boolean(binding.options.active()), false, 'the local queued configuration closes input before server admission')
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1, generation: 1, effectiveScale: 2 } })
  assert.equal(Boolean(binding.options.active()), false, 'old confirmed pixels do not authorize a new generation')
  c.evaluate("lastFrame={sessionId:'session',configGeneration:1,renderRevision:2};rendererBlocked=false;receivePresented(lastFrame)")
  assert.equal(Boolean(binding.options.active()), true)
})

test('profile retirement and session replacement cancel pending raster responses and native coordinates', async t => {
  const c = await client(t), first = await c.send()
  c.evaluate("state.webRenderer='webview';attachInput()")
  await assert.rejects(first.result, error => error.code === 'ERR_CANCELLED' && error.localCancellation)
  assert.equal(first.binding.disposed, true)
  c.event('bridge', final(first.request.envelope)); first.request.complete(); await tick()
  assert.equal(c.context.__weappRasterInput.phase, 'error', 'late runtime success cannot revive a retired surface')
  c.evaluate("state.webRenderer='software';attachInput()")
  const second = await c.send(), resets = second.binding.resets
  c.evaluate("state.sessionId='new-session';syncBridgeSession('session','new-session')")
  await assert.rejects(second.result, error => error.code === 'ERR_CANCELLED' && error.localCancellation)
  assert.equal(second.binding.resets, resets + 1)
  second.request.complete(); await tick()
})

test('native pointerdown cannot become a tap after a pending density change and a newly confirmed frame', async t => {
  const c = await client(t, { realInput: true })
  c.evaluate("state.webRenderer='canvaskit';rendererBlocked=false;lastFrame={sessionId:'session',configGeneration:0,renderRevision:1};confirmedRendererIdentity=rendererIdentity(lastFrame)")
  c.pointer('pointerdown')
  assert.equal(c.nodes.get('screen').captures.size, 1)
  c.nodes.get('renderScale').value = '2'
  await c.evaluate('submitPresentation()')
  assert.equal(c.nodes.get('screen').captures.size, 0, 'configuration submission retires the native contact immediately')
  assert.equal(c.evaluate('rendererInputReady()'), false)
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1, generation: 1, effectiveScale: 2 } })
  c.evaluate("lastFrame={sessionId:'session',configGeneration:1,renderRevision:2};rendererBlocked=false;receivePresented(lastFrame)")
  assert.equal(c.evaluate('rendererInputReady()'), true)
  c.pointer('pointerup'); await tick()
  assert.equal(c.requests.length, 0, 'a recovered frame cannot revive the previous pointerdown')
  assert.equal(c.context.__weappRasterInput, undefined, 'discarded contacts never claim application success')
  c.pointer('pointerdown'); c.pointer('pointerup'); await tick()
  assert.equal(c.requests.length, 1)
  const request = c.requests[0]
  assert.deepEqual(request.envelope.payload.events.map(event => [event.type, event.x, event.y]), [['tap', 30, 40]])
  assert.equal(request.envelope.payload.configGeneration, 1)
  request.complete(); c.event('bridge', final(request.envelope)); await tick()
  assert.equal(c.context.__weappRasterInput.phase, 'applied')
})

for (const pointerType of ['mouse', 'touch', 'pen']) test(`${pointerType} contact cannot become a tap on another instance of the same CanvasKit route`, async t => {
  const c = await client(t, { realInput: true })
  c.event('state', { sessionId: 'session', currentPageId: '9007199254740993', webRenderer: 'canvaskit', route: 'pages/shared/index' })
  c.evaluate("rendererBlocked=false;lastFrame={sessionId:'session',configGeneration:0,renderRevision:1};confirmedRendererIdentity=rendererIdentity(lastFrame)")
  c.pointer('pointerdown', { pointerType }); await tick()
  const before = c.requests.length
  for (const request of c.requests) { request.complete(); c.event('bridge', final(request.envelope)) }
  await tick()
  assert.equal(c.nodes.get('screen').captures.size, 1)
  c.event('state', { sessionId: 'session', currentPageId: '9007199254740994', webRenderer: 'canvaskit', route: 'pages/shared/index' })
  assert.equal(c.nodes.get('screen').captures.size, 0, 'navigation retires the old native contact before the next scene arrives')
  assert.equal(c.evaluate('state.currentPageId'), '9007199254740994', 'page identity stays an exact decimal string')
  c.evaluate("rendererBlocked=false;lastFrame={sessionId:'session',configGeneration:0,renderRevision:2};receivePresented(lastFrame)")
  c.pointer('pointerup', { pointerType }); await tick()
  assert.equal(c.requests.length, before, 'a newly confirmed page cannot revive the predecessor pointerdown')
  c.pointer('pointerdown', { pointerType }); c.pointer('pointerup', { pointerType }); await tick()
  assert.equal(c.requests.length, before + 1)
  const request = c.requests.at(-1)
  assert.deepEqual(request.envelope.payload.events.map(event => event.type), pointerType === 'mouse' ? ['tap'] : ['touchstart', 'touchend', 'tap'])
  assert.equal(request.envelope.payload.renderRevision, 2)
  assert.deepEqual(request.envelope.payload.logicalViewport, { width: 375, height: 667 })
  request.complete(); c.event('bridge', final(request.envelope)); await tick()
  assert.equal(c.context.__weappRasterInput.phase, 'applied')
})

test('same-page state and setData frame updates retain native contacts without repeated resets', async t => {
  const c = await client(t, { realInput: true })
  c.event('state', { sessionId: 'session', currentPageId: '1', webRenderer: 'canvaskit', route: 'pages/shared/index' })
  c.evaluate("rendererBlocked=false;lastFrame={sessionId:'session',configGeneration:0,renderRevision:1};confirmedRendererIdentity=rendererIdentity(lastFrame)")
  const binding = c.bindings.at(-1), resets = binding.resets
  c.pointer('pointerdown', { pointerType: 'touch' }); await tick()
  const start = c.requests[0]
  start.complete(); c.event('bridge', final(start.envelope)); await tick()
  c.event('state', { sessionId: 'session', currentPageId: '1', webRenderer: 'canvaskit', route: 'pages/shared/index', traceCount: 12 })
  c.event('state', { sessionId: 'session', currentPageId: '1', webRenderer: 'canvaskit', route: 'pages/shared/index', traceCount: 13 })
  c.evaluate("rendererBlocked=false;lastFrame={sessionId:'session',configGeneration:0,renderRevision:2};receivePresented(lastFrame)")
  assert.equal(binding.resets, resets, 'same instance state notifications never cancel a valid contact')
  assert.equal(c.nodes.get('screen').captures.size, 1)
  c.pointer('pointermove', { pointerType: 'touch', clientX: 31 })
  c.pointer('pointerup', { pointerType: 'touch', clientX: 31 }); await tick()
  assert.equal(c.requests.length, 2)
  const request = c.requests[1]
  assert.deepEqual(request.envelope.payload.events.map(event => event.type), ['touchmove', 'touchend', 'tap'])
  assert.ok(request.envelope.payload.events.every(event => event.changedTouches[0].identifier === 1))
  assert.equal(request.envelope.payload.renderRevision, 2)
  request.complete(); c.event('bridge', final(request.envelope)); await tick()
})

test('page replacement drops input queued before its microtask and an absent page cannot capture input', async t => {
  const c = await client(t, { realInput: true })
  c.event('state', { sessionId: 'session', currentPageId: '1', webRenderer: 'canvaskit' })
  c.evaluate("rendererBlocked=false;lastFrame={sessionId:'session',configGeneration:0,renderRevision:1};confirmedRendererIdentity=rendererIdentity(lastFrame)")
  c.pointer('pointerdown'); c.pointer('pointerup')
  c.event('state', { sessionId: 'session', currentPageId: '2', webRenderer: 'canvaskit' })
  await tick()
  assert.equal(c.requests.length, 0, 'queued old-page coordinates cannot borrow a replacement page identity')
  c.pointer('pointerdown')
  assert.equal(c.nodes.get('screen').captures.size, 1)
  c.event('state', { sessionId: 'session', currentPageId: null, webRenderer: 'canvaskit' })
  assert.equal(c.nodes.get('screen').captures.size, 0)
  c.pointer('pointerdown'); c.pointer('pointerup'); await tick()
  assert.equal(c.requests.length, 0)
})
