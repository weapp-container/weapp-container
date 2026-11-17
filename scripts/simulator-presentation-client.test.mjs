import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { encodeFrame, presentationFixture } from './simulator-client-binary-fixture.mjs'

const html = readFileSync(new URL('../crates/container-simulator/src/web-ui.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const frame = value => ({ width: 2, height: 2, pixels: Array.from({ length: 4 }, () => [value, 0, 0, 255]).flat() })

async function client(initial = presentationFixture, { deferState = false, deferRendererReceipt = false, loadRasterModule, loadDomModule } = {}) {
  let now = 0, sequence = 0, authoritativePresentation = initial
  let focused = false, windowFocused = false, hidden = false, activeElement
  const body = { tagName: 'BODY' }, documentElement = { tagName: 'HTML' }, domFrames = new Set()
  activeElement = body
  const raf = new Map(), listeners = new Map(), frames = [], stateRequests = [], settings = [], drawings = [], rendererReceipts = [], rendererReplies = [], storage = new Map(), intervals = new Map(), mediaQueries = [], windowListeners = new Map()
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: '', style: {}, width: 375, height: 667, clientWidth: 600, clientHeight: 800,
    value: id === 'bridge' ? html.match(/<textarea id="bridge">([\s\S]*?)<\/textarea>/)[1] : id === 'zoom' ? 'fit' : '',
    getContext: () => ({ putImageData: image => drawings.push(image) }),
  }]))
  for (const node of nodes.values()) {
    let content = node.textContent
    node.textWrites = 0
    Object.defineProperty(node, 'textContent', {
      get: () => content,
      set(value) { content = value; node.textWrites++ },
    })
    node.focusCalls = []
    node.focus = options => {
      node.focusCalls.push({ ...options, hidden: Boolean(node.hidden) })
      if (!node.hidden) { activeElement = node; focused = windowFocused && !hidden }
    }
  }
  nodes.get('domScreen').contains = element => domFrames.has(element)
  const preview = nodes.get('preview')
  let previewReads = 0
  Object.defineProperty(preview, 'clientWidth', { get() { previewReads++; return 600 } })
  Object.defineProperty(preview, 'clientHeight', { get() { previewReads++; return 800 } })
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), hasFocus: () => focused, get hidden() { return hidden }, body, documentElement,
      get activeElement() { return activeElement } },
    window: { addEventListener: (type, callback) => windowListeners.set(type, callback) },
    devicePixelRatio: 1,
    matchMedia(query) {
      const callbacks = new Set()
      const media = { media: query, callbacks,
        addEventListener(type, callback) { assert.equal(type, 'change'); callbacks.add(callback) },
        removeEventListener(type, callback) { assert.equal(type, 'change'); callbacks.delete(callback) },
      }
      mediaQueries.push(media)
      return media
    },
    performance: { now: () => now }, TextEncoder, TextDecoder, MessageEvent,
    __loadRasterModule: loadRasterModule,
    __loadDomModule: loadDomModule,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame: callback => { raf.set(++sequence, callback); return sequence },
    setInterval: (callback, period) => { const id = intervals.size + 1; intervals.set(id, { callback, period }); return id },
    clearInterval: id => intervals.delete(id),
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }) } },
    EventSource: class { addEventListener(type, listener) { listeners.set(type, listener) } close() {} },
    fetch(url, options) {
      if (url === '/api/render-presented') {
        rendererReceipts.push(JSON.parse(options.body))
        if (deferRendererReceipt) return new Promise(resolve => rendererReplies.push(resolve))
        return Promise.resolve({ ok: true, status: 202 })
      }
      if (url === '/api/state') {
        if (deferState) return new Promise(resolve => stateRequests.push({ resolve }))
        return Promise.resolve({ ok: true, json: async () => ({ status: 'ready', sessionId: 'session-a', webRenderer: 'software', diagnostics: [] }) })
      }
      if (url === '/api/presentation' && options?.method !== 'POST') return Promise.resolve({ ok: true, json: async () => authoritativePresentation })
      if (url === '/api/presentation') {
        const request = JSON.parse(options.body)
        settings.push(request)
        return Promise.resolve({ ok: true, status: 202, json: async () => ({ queued: true, requestId: request.requestId }) })
      }
      assert.ok(['/api/frame', '/api/render-frame'].includes(url), url)
      return new Promise(resolve => frames.push({ resolve, url }))
    },
  })
  let script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  if (loadRasterModule) script = script.replace("import('/remote-canvaskit.mjs')", '__loadRasterModule()')
  if (loadDomModule) script = script.replace("import('/remote-dom.mjs')", '__loadDomModule()')
  vm.runInContext(script, context)
  await tick()
  return {
    nodes, frames, settings, drawings, storage, mediaQueries, rendererReceipts,
    async completeRendererReceipt(index = 0) {
      rendererReplies[index]({ ok: true, status: 202 })
      await tick()
    },
    setFocus: value => { focused = windowFocused = value },
    setHidden: value => { hidden = value },
    focusElement: id => { nodes.get(id).focus({ preventScroll: true }) },
    focusDomFrame() {
      const frame = { tagName: 'IFRAME', id: `dom-frame-${domFrames.size}` }
      domFrames.add(frame); activeElement = frame; focused = windowFocused = true
      return frame
    },
    focusOtherFrame() { activeElement = { tagName: 'IFRAME', id: 'other-preview' }; focused = windowFocused = true },
    removeDomFrame(frame) {
      domFrames.delete(frame)
      if (activeElement === frame) { activeElement = body; focused = false }
    },
    activeElement: () => activeElement,
    setDprSilently: value => { context.devicePixelRatio = value },
    async setDpr(value) {
      context.devicePixelRatio = value
      for (const query of [...mediaQueries]) for (const callback of [...query.callbacks]) callback({ matches: false, media: query.media })
      await tick()
    },
    windowEvent: type => windowListeners.get(type)?.(),
    previewReads: () => previewReads,
    intervals: period => [...intervals.values()].filter(timer => period === undefined || timer.period === period).forEach(timer => timer.callback()),
    timers: () => [...intervals.values()],
    setPresentation: value => { authoritativePresentation = value },
    evaluate: code => vm.runInContext(code, context),
    async resolveState(value, index = 0) {
      stateRequests[index].resolve({ ok: true, json: async () => value })
      await tick()
    },
    async complete(index, value, header = {}) {
      frames[index].resolve({ ok: true, status: 200, arrayBuffer: async () => encodeFrame(value, { sessionId: 'session-a', ...header }) })
      await tick()
    },
    event(type, payload) { listeners.get(type)({ type, data: JSON.stringify(payload) }) },
    raf(time) { now = time; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(callback => callback(time)) },
    metrics: () => context.__weappPresentationMetrics,
  }
}

test('initial presentation settings cannot choose a frame transport before renderer authority arrives', async () => {
  const c = await client({ ...presentationFixture, generation: 1, revision: 1 }, { deferState: true })
  assert.equal(c.evaluate('presentation.generation'), 1, 'settings have already arrived')
  assert.equal(c.frames.length, 0, 'unknown renderer must not optimistically fetch CPU RGBA')
  c.event('snapshot', { format: 'render-frame-v1', sessionId: 'session-a', configGeneration: 1, frameId: 1 })
  await tick()
  assert.equal(c.frames.length, 0, 'early notices retain demand while awaiting authoritative state')
  await c.resolveState({ status: 'ready', sessionId: 'session-a', webRenderer: 'canvaskit', diagnostics: [] })
  assert.deepEqual(c.frames.map(value => value.url), ['/api/render-frame'])
})

test('an explicit CanvasKit state event authorizes remote frames while the initial HTTP state remains in flight', async () => {
  const c = await client({ ...presentationFixture, generation: 1, revision: 1 }, { deferState: true })
  c.event('state', { status: 'ready', sessionId: 'session-a', webRenderer: 'canvaskit', diagnostics: [] })
  c.event('snapshot', { format: 'render-frame-v1', sessionId: 'session-a', configGeneration: 1, frameId: 1 })
  await tick()
  assert.deepEqual(c.frames.map(value => value.url), ['/api/render-frame'])
  await c.resolveState({ status: 'starting', sessionId: 'old-session', diagnostics: [] })
  assert.equal(c.evaluate('state.webRenderer'), 'canvaskit', 'late initial state cannot change the selected transport')
  assert.deepEqual(c.frames.map(value => value.url), ['/api/render-frame'])
})

for (const acknowledgement of ['after', 'before']) test(`returning from native DOM reconciles density once the first raster frame is confirmed ${acknowledgement} its HTTP reply`, async () => {
  const c = await client(presentationFixture, {
    deferRendererReceipt: true,
    loadDomModule: async () => ({ RemoteDomSurface: class { updateState() {} async dispose() {} } }),
  })
  c.event('state', { webRenderer: 'webview' }); await tick()
  c.setDprSilently(2); c.setFocus(true)
  const before = c.settings.length
  c.event('state', { webRenderer: 'canvaskit' }); await tick()
  assert.equal(c.settings.length, before, 'automatic density waits for an accepted scene instead of failing on first entry')
  assert.equal(c.evaluate('autoPresentationWanted'), true, 'profile transition retains demand without another media or focus event')
  assert.equal(Boolean(c.evaluate('rendererInputReady()')), false)
  c.evaluate(`remoteRenderer={present:async()=>({backend:'canvaskit-webgl2',context:{surfaceIsGpu:true},presentation:{gpuCompletion:'not-waited'}})};
    queueFrame({sessionId:'session-a',configGeneration:0,frameId:1,renderRevision:4,width:2,height:2,renderFrame:{}})`)
  c.raf(100); await tick()
  assert.equal(c.rendererReceipts.length, 1)
  if (acknowledgement === 'after') await c.completeRendererReceipt()
  assert.equal(c.settings.length, before, 'HTTP 202 and local drawing alone do not establish runtime acceptance')
  for (const receipt of [
    { sessionId: 'old-session', configGeneration: 0, renderRevision: 4 },
    { sessionId: 'session-a', configGeneration: 1, renderRevision: 4 },
    { sessionId: 'session-a', configGeneration: 0, renderRevision: 3 },
  ]) {
    c.event('presented', receipt)
    assert.equal(c.settings.length, before, 'unmatched renderer receipts cannot drain the pending density change')
    assert.equal(c.evaluate('autoPresentationWanted'), true)
  }
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 4 })
  if (acknowledgement === 'before') {
    assert.equal(c.settings.length, before, 'an early ACK still waits for local frame completion')
    await c.completeRendererReceipt()
  }
  assert.equal(c.settings.length, before + 1)
  assert.equal(c.settings.at(-1).devicePixelRatio, 2)
  assert.equal(c.settings.at(-1).renderScale, 'auto')
  assert.equal(c.evaluate('autoPresentationWanted'), false)
  assert.equal(c.evaluate('rendererInputReady()'), false, 'the submitted density change fences the old frame input')
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 4 })
  assert.equal(c.settings.length, before + 1, 'duplicate ACKs do not submit a second configuration')
})

test('an explicit setting before the first raster scene is submitted and its rejection is not silently retried', async () => {
  const c = await client(presentationFixture, {
    loadDomModule: async () => ({ RemoteDomSurface: class { updateState() {} async dispose() {} } }),
  })
  c.event('state', { webRenderer: 'webview' }); await tick()
  c.setDprSilently(2); c.setFocus(true)
  c.event('state', { webRenderer: 'canvaskit' }); await tick()
  assert.equal(c.evaluate('autoPresentationWanted'), true)
  c.nodes.get('logicalWidth').value = '400'
  await c.nodes.get('logicalWidth').onchange()
  assert.equal(c.settings.length, 1, 'explicit requests retain runtime validation before the first scene')
  assert.equal(c.settings[0].logicalWidth, 400)
  assert.equal(c.evaluate('autoPresentationWanted'), false, 'explicit input supersedes old automatic demand')
  c.event('presentation', { requestId: c.settings[0].requestId, ok: false,
    error: { code: 'ERR_PRESENTATION_CONFIG', message: 'fixture explicit configuration rejected' } })
  assert.equal(c.nodes.get('logicalWidth').value, '375')
  c.evaluate(`remoteRenderer={present:async()=>({backend:'canvaskit-webgl2',context:{surfaceIsGpu:true},presentation:{gpuCompletion:'not-waited'}})};
    queueFrame({sessionId:'session-a',configGeneration:0,frameId:1,renderRevision:4,width:2,height:2,renderFrame:{}})`)
  c.raf(100); await tick()
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 4 })
  await tick()
  assert.equal(c.settings.length, 1, 'first-scene readiness cannot turn a rejected explicit setting into an automatic retry')
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.equal(c.nodes.get('overlay').textContent, 'fixture explicit configuration rejected')
  assert.equal(c.evaluate('rendererInputReady()'), true, 'accepted old geometry remains usable after a rejected change')
})

async function focusHandoffClient(onDispose) {
  let c, frame
  c = await client(presentationFixture, { loadDomModule: async () => ({ RemoteDomSurface: class {
    updateState() {}
    async dispose() { c.removeDomFrame(frame); onDispose?.(c) }
  } }) })
  c.event('state', { webRenderer: 'webview' }); await tick()
  frame = c.focusDomFrame()
  c.setDprSilently(2)
  return c
}

test('DOM to CanvasKit transfers owned iframe focus before reconciling density and the first confirmed frame', async () => {
  assert.match(html, /<canvas\b[^>]*\btabindex="0"[^>]*\baria-label="Mini program preview"/)
  const c = await focusHandoffClient()
  assert.equal(c.evaluate('activePreview()'), true)
  c.event('state', { webRenderer: 'canvaskit' }); await tick()
  assert.equal(c.activeElement(), c.nodes.get('screen'), 'the unhidden raster canvas inherits this preview’s focus')
  assert.deepEqual(c.nodes.get('screen').focusCalls, [{ preventScroll: true, hidden: false }])
  assert.equal(c.evaluate('activePreview()'), true, 'iframe removal must not leave an active preview with hasFocus false')
  assert.equal(c.evaluate('autoPresentationWanted'), true)
  assert.equal(c.settings.length, 0, 'focus ownership does not bypass first-scene acceptance')
  c.evaluate(`remoteRenderer={present:async()=>({backend:'canvaskit-webgl2',context:{surfaceIsGpu:true},presentation:{gpuCompletion:'not-waited'}})};
    queueFrame({sessionId:'session-a',configGeneration:0,frameId:1,renderRevision:4,width:2,height:2,renderFrame:{}})`)
  c.raf(100); await tick()
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 4 })
  assert.equal(c.settings.length, 1)
  assert.equal(c.settings[0].devicePixelRatio, 2)
  assert.equal(c.settings[0].renderScale, 'auto')
  c.event('state', { webRenderer: 'canvaskit', traceCount: 12 })
  assert.equal(c.nodes.get('screen').focusCalls.length, 1, 'repeated state notifications never reassert focus')
})

for (const profile of ['software', 'canvaskit']) for (const owner of ['settings', 'bridge', 'other iframe', 'background', 'hidden']) {
  test(`DOM to ${profile} preserves ${owner} focus instead of claiming the raster canvas`, async () => {
    const c = await focusHandoffClient()
    if (owner === 'settings') c.focusElement('logicalWidth')
    else if (owner === 'bridge') c.focusElement('bridge')
    else if (owner === 'other iframe') c.focusOtherFrame()
    else if (owner === 'background') c.setFocus(false)
    else c.setHidden(true)
    const previous = c.activeElement()
    c.event('state', { webRenderer: profile }); await tick()
    assert.equal(c.nodes.get('screen').focusCalls.length, 0)
    if (['settings', 'bridge', 'other iframe'].includes(owner)) assert.equal(c.activeElement(), previous)
  })
}

test('a control focused during DOM retirement supersedes the captured preview handoff', async () => {
  const c = await focusHandoffClient(value => value.focusElement('logicalWidth'))
  c.event('state', { webRenderer: 'canvaskit' }); await tick()
  assert.equal(c.activeElement(), c.nodes.get('logicalWidth'))
  assert.equal(c.nodes.get('screen').focusCalls.length, 0, 'disposal cannot steal an intervening control’s focus')
})

test('paused automatic density demand survives focus loss but a rejected submitted request is not retried', async () => {
  const c = await client()
  await c.setDpr(2)
  assert.equal(c.settings.length, 0)
  assert.equal(c.evaluate('autoPresentationWanted'), true, 'inactive ownership pauses pending demand')
  c.setFocus(true); await c.windowEvent('focus'); await tick()
  assert.equal(c.settings.length, 1)
  assert.equal(c.evaluate('autoPresentationWanted'), false, 'submission consumes the demand before any asynchronous receipt')
  c.event('presentation', { requestId: c.settings[0].requestId, ok: false,
    error: { code: 'ERR_PRESENTATION_CONFIG', message: 'fixture density rejected' } })
  for (let index = 0; index < 3; index++) {
    c.intervals(250)
    c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 1 })
    c.raf(100 + index * 20)
  }
  await tick()
  assert.equal(c.settings.length, 1, 'idle polling, duplicate ACKs and RAF never retry a failed configuration')
  assert.equal(c.nodes.get('overlay').textContent, 'fixture density rejected')
})

test('software transport is selected only after explicit authoritative HTTP state', async () => {
  const c = await client({ ...presentationFixture, generation: 1, revision: 1 }, { deferState: true })
  assert.equal(c.frames.length, 0)
  await c.resolveState({ status: 'ready', sessionId: 'session-a', webRenderer: 'software', diagnostics: [] })
  assert.deepEqual(c.frames.map(value => value.url), ['/api/frame'])
})

test('a pending renderer invalidates in-flight pixels and waits for the next explicit profile', async () => {
  const c = await client()
  assert.equal(c.frames.length, 1)
  c.event('state', { webRenderer: 'pending' })
  c.event('snapshot', { frameId: 2 })
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  assert.equal(c.frames.length, 1, 'a stale fetch cannot start another guessed raster request')
  assert.equal(c.drawings.length, 0)
  c.event('state', { status: 'ready' })
  assert.equal(c.frames.length, 1, 'a partial state is not renderer authority')
  c.event('state', { webRenderer: 'software' })
  c.event('snapshot', { frameId: 3 })
  await tick()
  assert.equal(c.frames.length, 2)
  await c.complete(1, frame(3), { frameId: 3 })
  c.raf(120)
  assert.equal(c.drawings.at(-1).data[0], 3)
})

function rasterModuleHarness() {
  const imports = [], renderers = []
  class RemoteCanvasKitRenderer {
    constructor(canvas, options) { this.canvas = canvas; this.options = options; this.disposed = 0; renderers.push(this) }
    async prepare(envelope) { return { ...envelope, renderFrame: {} } }
    async present() { return { backend: 'canvaskit-webgl2', context: { surfaceIsGpu: true }, presentation: { gpuCompletion: 'not-waited' } } }
    dispose() { this.disposed++ }
  }
  const loadRasterModule = () => new Promise((resolve, reject) => imports.push({ resolve: () => resolve({ RemoteCanvasKitRenderer }), reject }))
  const loadDomModule = async () => ({ RemoteDomSurface: class { updateState() {} async dispose() {} } })
  const complete = async (c, index, frameId) => {
    const frame = { sessionId: 'session-a', frameId, configGeneration: 0, renderRevision: frameId, width: 2, height: 2, logicalWidth: 375, logicalHeight: 667 }
    const bytes = new TextEncoder().encode(JSON.stringify(frame))
    c.frames[index].resolve({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }); await tick()
  }
  return { imports, renderers, loadRasterModule, loadDomModule, complete }
}

test('a late CanvasKit import cannot construct after WebView takes ownership and switching back gets a fresh renderer', async () => {
  const h = rasterModuleHarness(), c = await client(presentationFixture, { deferState: true, ...h })
  await c.resolveState({ status: 'ready', sessionId: 'session-a', webRenderer: 'canvaskit' })
  await h.complete(c, 0, 1)
  assert.equal(h.imports.length, 1)
  c.event('state', { webRenderer: 'webview' }); await tick()
  h.imports[0].resolve(); await tick()
  assert.equal(h.renderers.length, 0, 'retired imports never acquire a canvas or GPU context')
  assert.equal(c.evaluate('remoteRenderer'), null)
  assert.doesNotMatch(c.nodes.get('overlay').textContent, /ERR_CANCELLED/)
  c.event('state', { webRenderer: 'canvaskit' })
  c.event('snapshot', { sessionId: 'session-a', configGeneration: 0, frameId: 2, format: 'render-frame-v1' }); await tick()
  await h.complete(c, 1, 2)
  assert.equal(h.imports.length, 2)
  h.imports[1].resolve(); await tick()
  assert.equal(h.renderers.length, 1)
  assert.equal(c.evaluate('remoteRenderer'), h.renderers[0])
  c.event('state', { webRenderer: 'webview' }); await tick()
  assert.equal(h.renderers[0].disposed, 1)
  h.renderers[0].options.onRestore()
  assert.equal(c.frames.length, 2, 'retired WebGL callbacks cannot request frames in the DOM profile')
  c.windowEvent('pagehide')
  assert.equal(h.renderers[0].disposed, 1)
})

test('a rejected CanvasKit module load is recoverable and pagehide retires the replacement exactly once', async () => {
  const h = rasterModuleHarness(), c = await client(presentationFixture, { deferState: true, ...h })
  await c.resolveState({ status: 'ready', sessionId: 'session-a', webRenderer: 'canvaskit' })
  await h.complete(c, 0, 1)
  h.imports[0].reject(new Error('fixture module unavailable')); await tick()
  assert.match(c.nodes.get('overlay').textContent, /fixture module unavailable/)
  assert.equal(c.evaluate('remoteRendererLoad'), null)
  c.event('snapshot', { sessionId: 'session-a', configGeneration: 0, frameId: 2, format: 'render-frame-v1' }); await tick()
  await h.complete(c, 1, 2)
  h.imports[1].resolve(); await tick()
  assert.equal(h.renderers.length, 1)
  c.raf(100); await tick()
  assert.equal(c.rendererReceipts.length, 1, 'replacement reaches the real presentation receipt path')
  c.windowEvent('pagehide')
  c.windowEvent('pagehide')
  assert.equal(h.renderers[0].disposed, 1)
})

test('pagehide retires an in-flight CanvasKit import without constructing or fetching again', async () => {
  const h = rasterModuleHarness(), c = await client(presentationFixture, { deferState: true, ...h })
  await c.resolveState({ status: 'ready', sessionId: 'session-a', webRenderer: 'canvaskit' })
  await h.complete(c, 0, 1)
  assert.equal(h.imports.length, 1)
  c.windowEvent('pagehide')
  h.imports[0].resolve(); await tick()
  assert.equal(h.renderers.length, 0)
  assert.equal(c.frames.length, 1)
  assert.equal(c.evaluate('remoteRendererLoad'), null)
})

test('remote CanvasKit input waits for runtime confirmation, including confirmation before the HTTP reply continuation', async () => {
  const c = await client()
  c.event('state', { sessionId: 'session-a', webRenderer: 'canvaskit' })
  c.evaluate(`remoteRenderer={present:async()=>({backend:'canvaskit-webgl2',context:{surfaceIsGpu:true},presentation:{gpuCompletion:'not-waited'}})};
    queueFrame({sessionId:'session-a',configGeneration:0,frameId:1,renderRevision:4,width:2,height:2,renderFrame:{}})`)
  c.raf(100)
  await tick()
  assert.equal(c.rendererReceipts.length, 1)
  assert.equal(c.evaluate('rendererInputReady()'), false, 'HTTP 202 only queues the receipt')
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 3 })
  assert.equal(c.evaluate('rendererInputReady()'), false)
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 4 })
  assert.equal(c.evaluate('rendererInputReady()'), true)
  c.evaluate(`queueFrame({sessionId:'session-a',configGeneration:0,frameId:2,renderRevision:5,width:2,height:2,renderFrame:{}})`)
  c.raf(120)
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 5 })
  await tick()
  assert.equal(c.evaluate('rendererInputReady()'), true, 'SSE can arrive before the HTTP continuation')
  c.event('state', { sessionId: 'session-b', webRenderer: 'canvaskit' })
  assert.equal(Boolean(c.evaluate('rendererInputReady()')), false)
  c.event('presented', { sessionId: 'session-a', configGeneration: 0, renderRevision: 5 })
  assert.equal(Boolean(c.evaluate('rendererInputReady()')), false, 'old-session confirmation cannot restore input')
})

test('remote renderer recovery clears its own overlay and cannot clear an active runtime diagnostic', async () => {
  const c = await client()
  c.event('state', { sessionId: 'session-a', webRenderer: 'canvaskit' })
  c.evaluate(`rendererBlocked=true;showRendererError('WebGL context lost');
    remoteRenderer={present:async()=>({backend:'canvaskit-webgl2',context:{surfaceIsGpu:true},presentation:{gpuCompletion:'not-waited'}})};
    queueFrame({sessionId:'session-a',configGeneration:0,frameId:1,renderRevision:4,width:2,height:2,renderFrame:{}})`)
  c.raf(100); await tick()
  assert.equal(c.nodes.get('overlay').style.display, 'none')
  c.evaluate("showRendererError('draw failed')")
  c.event('diagnostic', { revision: 1, severity: 'error', code: 'ERR_BUILD', message: 'build remains broken' })
  c.evaluate(`queueFrame({sessionId:'session-a',configGeneration:0,frameId:2,renderRevision:5,width:2,height:2,renderFrame:{}})`)
  c.raf(120); await tick()
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.equal(c.nodes.get('overlay').textContent, 'build remains broken')
})

test('binary frames wait for RAF, keep one latest frame, and respect target FPS', async () => {
  const c = await client({ ...presentationFixture, fps: 30 })
  await c.complete(0, frame(1), { frameId: 1 })
  assert.equal(c.drawings.length, 0)
  c.raf(100)
  assert.equal(c.drawings.at(-1).data[0], 1)
  c.event('snapshot', {})
  await c.complete(1, frame(2), { frameId: 2 })
  c.event('snapshot', {})
  await c.complete(2, frame(3), { frameId: 3 })
  c.raf(116.67)
  assert.equal(c.drawings.length, 1, '30 FPS limits presentation independently of fetch/input')
  c.raf(133.34)
  assert.equal(c.drawings.length, 2)
  assert.equal(c.drawings.at(-1).data[0], 3, 'intermediate frame is discarded before presentation')
  assert.equal(c.metrics().targetFps, 30)
  assert.equal(c.metrics().frames.length, 2)
  assert.equal(c.metrics().frameBytes, 16)
})

test('logical resize waits for matching committed generation and discards an old in-flight frame', async () => {
  const c = await client()
  c.nodes.get('logicalWidth').value = '400'
  await c.nodes.get('logicalWidth').onchange()
  assert.equal(c.settings[0].logicalWidth, 400)
  assert.equal(c.evaluate('inputSuspended'), true)
  assert.match(c.nodes.get('presentationStatus').textContent, /waiting for runtime/)
  assert.equal(c.evaluate('presentation.logicalWidth'), 375, 'HTTP queue receipt cannot commit settings')
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true, presentation: { ...presentationFixture, logicalWidth: 400, revision: 1, generation: 1 } })
  await c.complete(0, frame(1), { configGeneration: 0 })
  c.raf(100)
  assert.equal(c.drawings.length, 0, 'late old-config response cannot draw during resize')
  assert.equal(c.frames.length, 2)
  await c.complete(1, frame(2), { configGeneration: 1, logicalWidth: 400 })
  c.raf(120)
  assert.equal(c.drawings.length, 1)
  assert.equal(c.evaluate('inputSuspended'), false)
  assert.match(c.nodes.get('geometry').textContent, /400×667 logical/)
})

test('rejected settings retain accepted geometry, controls and current frame', async () => {
  const c = await client()
  await c.complete(0, frame(7))
  c.raf(100)
  c.nodes.get('logicalWidth').value = '4096'
  await c.nodes.get('logicalWidth').onchange()
  c.event('presentation', { requestId: c.settings[0].requestId, ok: false, error: { code: 'ERR_RENDER', message: 'frame exceeds 16 MiB' } })
  assert.equal(c.nodes.get('logicalWidth').value, '375')
  assert.equal(c.evaluate('inputSuspended'), false)
  assert.equal(c.drawings.at(-1).data[0], 7)
  assert.match(c.nodes.get('presentationStatus').textContent, /16 MiB/)
})

test('browser zoom is local and density changes do not suspend logical input', async () => {
  const c = await client()
  c.nodes.get('zoom').value = '1.5'
  c.nodes.get('zoom').onchange()
  assert.equal(c.nodes.get('screen').style.width, '562.5px')
  assert.equal(c.storage.get('weapp-container:display-zoom'), '1.5')
  assert.equal(c.settings.length, 0, 'display zoom never calls the runtime')
  c.nodes.get('renderScale').value = '2'
  await c.nodes.get('renderScale').onchange()
  assert.equal(c.settings[0].renderScale, 2)
  assert.equal(c.evaluate('inputSuspended'), false)
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true, presentation: { ...presentationFixture, renderScale: 2, effectiveScale: 2, revision: 1, generation: 1 } })
  assert.equal(c.evaluate('inputSuspended'), false)
})

test('frame validation rejects stale sessions and malformed binary dimensions', async () => {
  const c = await client()
  await c.complete(0, frame(1), { sessionId: 'old-session' })
  c.raf(100)
  assert.equal(c.drawings.length, 0)
  c.event('snapshot', {})
  await c.complete(1, frame(2), { width: 5000 })
  assert.match(c.nodes.get('overlay').textContent, /invalid RGBA frame/)
  assert.equal(c.drawings.length, 0)
})

test('FPS-only commits do not fetch or redraw unchanged pixels', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.nodes.get('fps').value = '120'
  await c.nodes.get('fps').onchange()
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true, presentation: { ...presentationFixture, revision: 1, fps: 120 } })
  assert.equal(c.frames.length, 1)
  assert.equal(c.drawings.length, 1)
  assert.equal(c.metrics().targetFps, 120)
  c.event('snapshot', {})
  await c.complete(1, frame(1), { frameId: 1 })
  c.raf(120)
  assert.equal(c.drawings.length, 1, 'identical frame IDs in one generation are not presented again')
})

test('corrected presentation clears only its own overlay and preserves unrelated diagnostics', async () => {
  const c = await client()
  c.nodes.get('logicalWidth').value = '4096'
  await c.nodes.get('logicalWidth').onchange()
  c.event('presentation', { requestId: c.settings[0].requestId, ok: false, error: { message: 'frame exceeds budget' } })
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1 } })
  assert.equal(c.nodes.get('overlay').style.display, 'none')
  c.event('diagnostic', { revision: 1, severity: 'error', code: 'ERR_BUILD', message: 'build remains broken' })
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 2 } })
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.equal(c.nodes.get('overlay').textContent, 'build remains broken')
})

test('future-generation binary responses wait for accepted settings and cannot strand resize input', async () => {
  const c = await client()
  // HTTP and SSE use independent connections: the newer frame can win this race.
  await c.complete(0, frame(1), { frameId: 1, configGeneration: 1, logicalWidth: 400 })
  c.raf(100)
  assert.equal(c.drawings.length, 0, 'unknown future geometry cannot be displayed with old input coordinates')
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1, generation: 1, logicalWidth: 400 } })
  assert.equal(c.evaluate('inputSuspended'), true)
  await c.complete(1, frame(1), { frameId: 1, configGeneration: 1, logicalWidth: 400 })
  c.raf(120)
  assert.equal(c.drawings.length, 1)
  assert.equal(c.evaluate('inputSuspended'), false, 'the same transport frame can now settle the accepted geometry')
})

test('authoritative reconnect settings recover a lost successful settings completion', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.nodes.get('logicalWidth').value = '400'
  await c.nodes.get('logicalWidth').onchange()
  assert.ok(c.evaluate('pendingPresentation'))
  // The final SSE event was lost; the runtime's GET remains authoritative.
  c.setPresentation({ ...presentationFixture, revision: 1, generation: 1, logicalWidth: 400 })
  await c.evaluate('refreshPresentation(true)')
  assert.equal(c.evaluate('pendingPresentation'), null)
  assert.equal(c.evaluate('inputSuspended'), true, 'new geometry still waits for its own frame')
  await c.complete(1, frame(2), { frameId: 2, configGeneration: 1, logicalWidth: 400 })
  c.raf(120)
  assert.equal(c.evaluate('inputSuspended'), false)
  assert.match(c.nodes.get('presentationStatus').textContent, /Recovered runtime revision 1/)
  c.nodes.get('fps').value = '30'
  await c.nodes.get('fps').onchange()
  assert.equal(c.settings.length, 2, 'recovered controls must accept another request')
})

test('reconnect to unchanged settings releases an unknown request without inventing success or failure', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.nodes.get('logicalWidth').value = '4096'
  await c.nodes.get('logicalWidth').onchange()
  const originalRequest=c.settings[0].requestId
  await c.evaluate('refreshPresentation(true)')
  assert.equal(c.evaluate('pendingPresentation'), null)
  assert.equal(c.evaluate('inputSuspended'), false)
  assert.equal(c.nodes.get('logicalWidth').value, '375')
  assert.match(c.nodes.get('presentationStatus').textContent, /outcome unknown/)
  // A delayed success may still arrive after this GET; it remains authoritative.
  c.event('presentation', { requestId: originalRequest, ok: true, presentation: { ...presentationFixture, revision: 1, generation: 1, logicalWidth: 400 } })
  await c.complete(1, frame(2), { frameId: 2, configGeneration: 1, logicalWidth: 400 })
  c.raf(120)
  assert.equal(c.evaluate('inputSuspended'), false)
  assert.equal(c.nodes.get('logicalWidth').value, '400')
})

test('different previews use unique settings request IDs and do not complete each other pending requests', async () => {
  const a = await client(),b = await client()
  a.nodes.get('fps').value = '30';b.nodes.get('fps').value = '120'
  await a.nodes.get('fps').onchange();await b.nodes.get('fps').onchange()
  assert.notEqual(a.settings[0].requestId,b.settings[0].requestId)
  b.event('presentation', { requestId: a.settings[0].requestId, ok: true, presentation: { ...presentationFixture, revision: 1, fps: 30 } })
  assert.equal(b.evaluate('pendingPresentation'),b.settings[0].requestId, 'other previews share configuration but not request ownership')
  b.event('presentation', { requestId: b.settings[0].requestId, ok: false, error: { message: 'stale revision' } })
  assert.equal(b.evaluate('pendingPresentation'),null)
})

test('a delayed reconnect read cannot settle a request created after that read began', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 });c.raf(100)
  c.nodes.get('fps').value = '30';await c.nodes.get('fps').onchange()
  let completeRead
  c.setPresentation(new Promise(resolve => { completeRead = resolve }))
  const refreshing=c.evaluate('refreshPresentation(true)')
  await tick()
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true, presentation: { ...presentationFixture, revision: 1, fps: 30 } })
  c.nodes.get('fps').value = '120';await c.nodes.get('fps').onchange()
  completeRead(presentationFixture)
  await refreshing
  assert.equal(c.evaluate('pendingPresentation'),c.settings[1].requestId)
  assert.equal(c.evaluate('presentation.revision'),1,'an old GET cannot roll accepted settings backward')
})


const notice = (frameId, overrides = {}) => ({
  schemaVersion: 1, sessionId: 'session-a', configGeneration: 0, frameId, ...overrides,
})

test('snapshot metadata covered by an in-flight newer response does not fetch the same pixels again', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.event('snapshot', notice(2))
  assert.equal(c.frames.length, 2)
  c.event('snapshot', notice(3))
  c.event('snapshot', notice(2))
  await c.complete(1, frame(3), { frameId: 3 })
  assert.equal(c.frames.length, 2, 'a response satisfying every known notice ends the fetch loop')
  c.event('snapshot', notice(3))
  c.event('snapshot', notice(1))
  assert.equal(c.frames.length, 2, 'decoded pixels satisfy duplicate notices before the next RAF')
  c.raf(120)
  assert.equal(c.drawings.at(-1).data[0], 3)
  c.event('snapshot', notice(4))
  assert.equal(c.frames.length, 3, 'a genuinely newer notice still fetches')
  await c.complete(2, frame(4), { frameId: 4 })
  c.raf(140)
  assert.equal(c.drawings.at(-1).data[0], 4)
})

test('a notification newer than the returned frame continues the single fetch loop', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.event('snapshot', notice(2))
  c.event('snapshot', notice(3))
  await c.complete(1, frame(2), { frameId: 2 })
  assert.equal(c.frames.length, 3, 'the pending frame-3 notice is not satisfied by frame 2')
  await c.complete(2, frame(3), { frameId: 3 })
  assert.equal(c.frames.length, 3)
  c.raf(120)
  assert.equal(c.drawings.at(-1).data[0], 3)
})

test('an older in-flight binary frame cannot replace newer pending pixels from a full snapshot', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.event('snapshot', notice(2))
  c.event('snapshot', { ...frame(4), ...notice(4), format: 'rgba8' })
  await c.complete(1, frame(3), { frameId: 3 })
  assert.equal(c.frames.length, 2)
  c.event('snapshot', notice(4))
  assert.equal(c.frames.length, 2)
  c.raf(120)
  assert.equal(c.drawings.at(-1).data[0], 4, 'the decoded high-water mark must correspond to the pixels that remain queued')
})

test('legacy notices and reconnect demand are not suppressed by a decoded metadata cursor', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.event('snapshot', {})
  c.event('snapshot', {})
  await c.complete(1, frame(2), { frameId: 2 })
  assert.equal(c.frames.length, 3, 'an unversioned notice during a request still demands one follow-up')
  await c.complete(2, frame(3), { frameId: 3 })
  c.raf(120)
  const reconnect = c.evaluate('refreshSurface()')
  await tick()
  assert.equal(c.frames.length, 4, 'reconnect remains an authoritative refresh even without a new notice')
  await c.complete(3, frame(3), { frameId: 3 })
  await reconnect
})

test('session and generation replacements cannot inherit a previous frame cursor', async () => {
  const c = await client()
  await c.complete(0, frame(9), { frameId: 90 })
  c.raf(100)
  c.event('state', { status: 'ready', sessionId: 'session-b', diagnostics: [] })
  c.event('snapshot', notice(1, { sessionId: 'session-b' }))
  assert.equal(c.frames.length, 2)
  await c.complete(1, frame(1), { frameId: 1, sessionId: 'session-b' })
  c.raf(120)
  assert.equal(c.drawings.at(-1).data[0], 1)
  c.event('snapshot', notice(2, { sessionId: 'session-b', configGeneration: 1 }))
  await c.complete(2, frame(2), { frameId: 2, sessionId: 'session-b', configGeneration: 1 })
  assert.equal(c.frames.length, 3, 'a future frame waits for authoritative settings instead of spinning')
  c.raf(140)
  assert.equal(c.drawings.at(-1).data[0], 1)
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1, generation: 1, logicalWidth: 400 } })
  assert.equal(c.frames.length, 4, 'accepted future settings refetch pixels for the new logical geometry')
  await c.complete(3, frame(2), { frameId: 2, sessionId: 'session-b', configGeneration: 1, logicalWidth: 400 })
  c.raf(160)
  assert.equal(c.drawings.at(-1).data[0], 2)
  assert.equal(c.evaluate('inputSuspended'), false)
})


test('HUD throttles DOM work while per-frame metrics, first frame, settings and idle remain current', async () => {
  const c = await client()
  const initialMetricWrites = c.nodes.get('metrics').textWrites
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  assert.equal(c.nodes.get('metrics').textWrites, initialMetricWrites + 1, 'the first frame updates the visible HUD immediately')
  const geometryWrites = c.nodes.get('geometry').textWrites
  const previewReads = c.previewReads()
  const metricWrites = c.nodes.get('metrics').textWrites
  for (const [frameId, time] of [[2, 120], [3, 140]]) {
    c.event('snapshot', notice(frameId))
    await c.complete(frameId - 1, frame(frameId), { frameId })
    c.raf(time)
  }
  assert.equal(c.metrics().frames.length, 3, 'all presented frames still retain complete instrumentation')
  assert.equal(c.metrics().presented, 3)
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites, 'sub-250ms frames do not rebuild the HUD')
  assert.equal(c.nodes.get('geometry').textWrites, geometryWrites)
  assert.equal(c.previewReads(), previewReads, 'unchanged geometry does not force layout reads')
  c.event('state', { status: 'ready', sessionId: 'session-a', diagnostics: [], presentation: presentationFixture })
  assert.equal(c.previewReads(), previewReads, 'repeated state presentation does not reset unchanged controls or zoom')
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites)

  c.event('snapshot', notice(4))
  await c.complete(3, frame(4), { frameId: 4 })
  c.raf(400)
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites + 1, 'the HUD catches up after the display interval')
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1, fps: 120 } })
  assert.match(c.nodes.get('metrics').textContent, /target 120 FPS/)
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites + 2, 'settings update HUD synchronously')
  assert.equal(c.metrics().frames.length, 4, 'HUD work never creates another render')
  c.raf(1500)
  c.intervals()
  assert.equal(c.metrics().actualFps, 0)
  assert.match(c.nodes.get('metrics').textContent, /Protocol updates 0.0 FPS/)
})

test('a new density frame refreshes geometry and byte metrics together within the HUD throttle interval', async () => {
  const c = await client()
  const raster = (width, height) => ({ width, height, pixels: new Uint8Array(width * height * 4) })
  await c.complete(0, raster(375, 667), { frameId: 1 })
  c.raf(100)
  assert.match(c.nodes.get('geometry').textContent, /375×667 pixels/)
  assert.match(c.nodes.get('metrics').textContent, /Frame 0\.95 MiB/)

  c.event('presentation', { ok: true, presentation: { ...presentationFixture,
    revision: 1, generation: 1, renderScale: 2, effectiveScale: 2 } })
  const metricWrites = c.nodes.get('metrics').textWrites
  assert.match(c.nodes.get('metrics').textContent, /Frame 0\.95 MiB/, 'settings alone cannot claim that new pixels were presented')
  await c.complete(1, raster(750, 1334), { frameId: 2, configGeneration: 1 })
  c.raf(120)
  assert.equal(c.drawings.at(-1).width, 750)
  assert.equal(c.drawings.at(-1).height, 1334)
  assert.match(c.nodes.get('geometry').textContent, /750×1334 pixels · 2\.00× density/)
  assert.match(c.nodes.get('metrics').textContent, /Frame 3\.82 MiB/)
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites + 1, 'the actual new frame bypasses the settings refresh from just 20ms earlier')

  c.event('snapshot', notice(3, { configGeneration: 1 }))
  await c.complete(2, raster(750, 1334), { frameId: 3, configGeneration: 1 })
  c.raf(140)
  assert.equal(c.metrics().frameId, 3)
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites + 1, 'ordinary frames in the accepted geometry keep the 250ms throttle')
})

test('geometry changes within a frame stream refresh byte metrics without waiting for the HUD interval', async () => {
  const c = await client()
  await c.complete(0, { width: 512, height: 512, pixels: new Uint8Array(512 * 512 * 4) }, { frameId: 1 })
  c.raf(100)
  const metricWrites = c.nodes.get('metrics').textWrites
  c.event('snapshot', notice(2))
  await c.complete(1, { width: 1024, height: 512, pixels: new Uint8Array(1024 * 512 * 4) }, { frameId: 2 })
  c.raf(120)
  assert.match(c.nodes.get('geometry').textContent, /1024×512 pixels/)
  assert.match(c.nodes.get('metrics').textContent, /Frame 2\.00 MiB/)
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites + 1)
})

for (const replacement of ['session', 'generation']) test(`a new ${replacement} frame refreshes metrics immediately even when geometry is unchanged`, async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1, renderMs: 1 })
  c.raf(100)
  const geometryWrites = c.nodes.get('geometry').textWrites
  const header = replacement === 'session' ? { sessionId: 'session-b' } : { configGeneration: 1 }
  if (replacement === 'session') {
    c.event('state', { status: 'ready', sessionId: 'session-b', diagnostics: [] })
    c.event('snapshot', notice(1, header))
  } else {
    c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1, generation: 1 } })
  }
  const metricWrites = c.nodes.get('metrics').textWrites
  await c.complete(1, frame(2), { frameId: 1, renderMs: 7, ...header })
  c.raf(120)
  assert.match(c.nodes.get('metrics').textContent, /Draw 7\.00 ms/)
  assert.equal(c.nodes.get('metrics').textWrites, metricWrites + 1)
  assert.equal(c.nodes.get('geometry').textWrites, geometryWrites, 'stream identity changes do not repeat unchanged geometry/layout work')
})

test('an obsolete generation notice does not refetch the current geometry', async () => {
  const c = await client({ ...presentationFixture, revision: 2, generation: 2 })
  // Initial settings and authoritative state may share this one outstanding request.
  await c.complete(0, frame(1), { frameId: 1, configGeneration: 2 })
  if (c.frames.length > 1) await c.complete(1, frame(1), { frameId: 1, configGeneration: 2 })
  c.raf(100)
  const requests = c.frames.length
  c.event('snapshot', notice(100, { configGeneration: 1 }))
  assert.equal(c.frames.length, requests)
  assert.equal(c.drawings.at(-1).data[0], 1)
})


test('unavailable or stale responses wait for another notice instead of polling the frame endpoint', async () => {
  const c = await client()
  await c.complete(0, frame(1), { frameId: 1 })
  c.raf(100)
  c.event('snapshot', notice(2))
  c.frames[1].resolve({ ok: false, status: 404 })
  await tick()
  assert.equal(c.frames.length, 2, 'no-frame does not busy-poll an outstanding notice')
  c.event('snapshot', notice(2))
  await c.complete(2, frame(1), { frameId: 1 })
  assert.equal(c.frames.length, 3, 'a response older than the already-known target waits for a fresh signal')
  c.event('snapshot', notice(2))
  await c.complete(3, frame(2), { frameId: 2 })
  c.raf(120)
  assert.equal(c.drawings.at(-1).data[0], 2)
})

test('active auto density follows media-query changes without resize/focus and rearms for the new DPR', async () => {
  const c = await client()
  c.setFocus(true)
  const first = c.mediaQueries.at(-1)
  assert.equal(first.media, '(resolution: 1dppx)')
  await c.setDpr(1.5)
  assert.equal(c.settings.length, 1)
  assert.equal(c.settings[0].devicePixelRatio, 1.5)
  assert.equal(c.settings[0].renderScale, 'auto')
  assert.equal(first.callbacks.size, 0, 'old resolution subscription is released')
  assert.equal(c.mediaQueries.at(-1).media, '(resolution: 1.5dppx)')
  assert.equal(c.mediaQueries.at(-1).callbacks.size, 1)
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true,
    presentation: { ...presentationFixture, revision: 1, generation: 1, effectiveScale: 1.5 } })
  await c.setDpr(2)
  assert.equal(c.settings.length, 2)
  assert.equal(c.settings[1].devicePixelRatio, 2)
  assert.equal(c.mediaQueries.at(-1).media, '(resolution: 2dppx)')
})

test('inactive, hidden and explicit-density previews rearm observation without reclaiming auto configuration', async () => {
  const c = await client()
  await c.setDpr(1.5)
  assert.equal(c.settings.length, 0, 'inactive page cannot submit its density')
  c.setFocus(true); c.setHidden(true)
  await c.setDpr(1.75)
  assert.equal(c.settings.length, 0, 'hidden page cannot submit its density')
  c.setHidden(false)
  c.event('presentation', { ok: true, presentation: { ...presentationFixture, revision: 1, renderScale: 2, effectiveScale: 2 } })
  await c.setDpr(1.25)
  assert.equal(c.settings.length, 0, 'explicit scale does not follow the browser DPR')
  assert.equal(c.mediaQueries.at(-1).media, '(resolution: 1.25dppx)', 'observation follows the screen even while submission is disabled')
})

test('a DPR change during an in-flight settings request is reconciled after its completion', async () => {
  const c = await client()
  c.setFocus(true)
  await c.setDpr(2)
  assert.equal(c.settings.length, 1)
  await c.setDpr(1.5)
  assert.equal(c.settings.length, 1, 'only one settings request is in flight')
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true,
    presentation: { ...presentationFixture, revision: 1, generation: 1, effectiveScale: 2 } })
  await tick()
  assert.equal(c.settings.length, 2, 'completion checks the current screen rather than losing the change')
  assert.equal(c.settings[1].devicePixelRatio, 1.5)
  assert.equal(c.settings[1].revision, 1)
})

test('shutdown and pagehide release density listeners and ignore already queued media callbacks', async () => {
  for (const reason of ['shutdown', 'pagehide']) {
    const c = await client()
    c.setFocus(true)
    const media = c.mediaQueries.at(-1), queued = [...media.callbacks][0]
    if (reason === 'shutdown') c.event('shutdown', { reason: 'test cleanup' })
    else c.windowEvent('pagehide')
    assert.equal(media.callbacks.size, 0)
    const subscriptions = c.mediaQueries.length
    await c.setDpr(1.5)
    queued() // A browser may already have queued one callback before removal.
    await tick()
    assert.equal(c.settings.length, 0)
    assert.equal(c.mediaQueries.length, subscriptions, 'a stale callback cannot recreate a released subscription')
  }
})

test('250ms fallback detects a real DPR value change without any media, resize or focus event', async () => {
  const c = await client()
  c.setFocus(true)
  assert.equal(c.timers().filter(timer => timer.period === 250).length, 1)
  const subscriptions = c.mediaQueries.length, frames = c.frames.length
  c.setDprSilently(1.5)
  c.intervals(250)
  await tick()
  assert.equal(c.settings.length, 1)
  assert.equal(c.settings[0].devicePixelRatio, 1.5)
  assert.equal(c.mediaQueries.length, subscriptions + 1, 'fallback rearms once for the newly observed page DPR')
  assert.equal(c.mediaQueries.at(-1).media, '(resolution: 1.5dppx)')
  assert.equal(c.frames.length, frames, 'polling cannot produce a new runtime render before the configuration commits')
  for (let i = 0; i < 10; i++) c.intervals(250)
  assert.equal(c.settings.length, 1)
  assert.equal(c.mediaQueries.length, subscriptions + 1, 'unchanged DPR never rebuilds the subscription')
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true,
    presentation: { ...presentationFixture, revision: 1, generation: 1, effectiveScale: 1.5 } })
  c.event('state', { status: 'ready', sessionId: 'session-a',
    presentation: { ...presentationFixture, revision: 2, generation: 2, effectiveScale: 1 } })
  c.intervals(250)
  assert.equal(c.settings.length, 1, 'a global configuration change cannot make an unchanged page DPR reclaim the density every tick')
})

test('DPR fallback remains inactive for hidden, unfocused or fixed-scale previews', async () => {
  const c = await client()
  c.setDprSilently(1.5)
  const subscriptions = c.mediaQueries.length
  c.intervals(250)
  c.setFocus(true); c.setHidden(true); c.intervals(250)
  c.setHidden(false)
  c.event('state', { presentation: { ...presentationFixture, revision: 1, renderScale: 2, effectiveScale: 2 } })
  c.intervals(250)
  assert.equal(c.settings.length, 0)
  assert.equal(c.mediaQueries.length, subscriptions, 'disabled polling performs no query/rebind work')
  c.event('state', { presentation: { ...presentationFixture, revision: 2, renderScale: 'auto', effectiveScale: 2 } })
  c.intervals(250)
  assert.equal(c.settings.length, 1, 'active auto mode can observe the screen change after becoming eligible')
  assert.equal(c.settings[0].devicePixelRatio, 1.5)
})

test('silent DPR changes during a pending request reconcile without creating concurrent settings requests', async () => {
  const c = await client()
  c.setFocus(true)
  c.setDprSilently(2); c.intervals(250)
  assert.equal(c.settings.length, 1)
  c.setDprSilently(1.5); c.intervals(250)
  assert.equal(c.settings.length, 1)
  c.event('presentation', { requestId: c.settings[0].requestId, ok: true,
    presentation: { ...presentationFixture, revision: 1, generation: 1, effectiveScale: 2 } })
  assert.equal(c.settings.length, 2)
  assert.equal(c.settings[1].devicePixelRatio, 1.5)
  assert.equal(c.settings[1].revision, 1)
})

test('shutdown/pagehide clear DPR polling and an already queued timer callback stays inert', async () => {
  for (const reason of ['shutdown', 'pagehide']) {
    const c = await client()
    c.setFocus(true)
    const queued = c.timers().find(timer => timer.period === 250).callback
    const subscriptions = c.mediaQueries.length
    if (reason === 'shutdown') c.event('shutdown', { reason: 'test cleanup' })
    else c.windowEvent('pagehide')
    assert.equal(c.timers().length, 0, 'both HUD and density intervals are released')
    c.setDprSilently(1.5); queued(); await tick()
    assert.equal(c.settings.length, 0)
    assert.equal(c.mediaQueries.length, subscriptions)
  }
})
