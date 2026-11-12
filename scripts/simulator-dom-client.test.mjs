import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { presentationFixture } from './simulator-client-binary-fixture.mjs'
import { RemoteDomSurface } from '../examples/hosts/web-wasm/remote-dom.mjs'

const html = readFileSync(new URL('../crates/container-simulator/src/web-ui.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))

async function browser(t, { realSurface = false, initialProfile = 'webview' } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    style: {}, textContent: '', value: id === 'zoom' ? 'fit' : '', clientWidth: 600, clientHeight: 800,
  }]))
  const listeners = new Map(), surfaces = [], requests = [], windowListeners = new Map()
  let delayLoad, initialState = { status: 'ready', webRenderer: initialProfile, sessionId: 'session', engine: 'quickjs', renderer: 'external-frame-export', diagnostics: [], presentation: presentationFixture, ...(realSurface ? { preview: { version: '1.0', epoch: '1', ownerClientId: 'owned-tab', leaseDurationMs: 15000 } } : {}) }
  class Surface {
    constructor(element, options) {
      this.element = element; this.options = options; this.isOwner = false; this.online = false; this.connects = 0; this.bridges = []; this.states = []; this.disposals = 0; surfaces.push(this)
    }
    updateState(value) { this.states.push(value) }
    async connect() { this.online = true; this.connects++ }
    receivePreview(value) { this.isOwner = value.preview.ownerClientId === 'owned-tab'; this.preview = value.preview; this.options.onState({ phase: 'owner' }) }
    receiveBridge(value) { this.bridges.push(value) }
    fence(value) { if (!this.isOwner) throw Error('read only'); return { ...value, preview: { clientId: 'owned-tab', epoch: '2' } } }
    disconnect() { this.online = false }
    async dispose() { this.disposals++ }
    async claim() { this.claimed = true }
  }
  class RealSurface extends RemoteDomSurface {
    constructor(element, options) {
      super(element, { ...options, clientId: 'owned-tab', fetch: (...args) => context.fetch(...args), setInterval: context.setInterval, clearInterval: context.clearInterval,
        createPresenter: () => ({ async prepare() {}, commit() {}, confirm() {}, abort() {}, suspendInput() {}, dispose() {} }),
      })
      surfaces.push(this)
    }
  }
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), hasFocus: () => false },
    window: { addEventListener: (type, callback) => windowListeners.set(type, callback) },
    performance: { now: () => 0 }, devicePixelRatio: 2, TextEncoder, TextDecoder, MessageEvent,
    requestAnimationFrame() {}, setInterval: () => 1, clearInterval() {},
    __loadDomSurface: () => delayLoad ?? Promise.resolve({ RemoteDomSurface: realSurface ? RealSurface : Surface }),
    EventSource: class {
      constructor() { context.stream = this }
      addEventListener(type, callback) { listeners.set(type, callback) }
      close() { this.closed = true }
    },
    async fetch(url, options) {
      requests.push({ url, ...(options?.body ? { body: JSON.parse(options.body) } : {}), ...(options?.keepalive ? { keepalive: true } : {}) })
      if (url === '/api/state') return { ok: true, json: async () => initialState }
      if (url === '/api/presentation' && options?.method !== 'POST') return { ok: true, json: async () => presentationFixture }
      if (url === '/api/presentation') return { ok: true, status: 202, json: async () => ({ queued: true }) }
      if (url === '/api/frame') return { ok: false, status: 404 }
      if (url === '/api/bridge') return { ok: true, text: async () => '{"queued":true}' }
      if (url === '/api/preview') return { ok: true, status: 202, json: async () => ({ queued: true }) }
      throw Error(`unexpected request ${url}`)
    },
  })
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace("import('/remote-dom.mjs')", '__loadDomSurface()')
  vm.runInContext(code, context)
  await tick()
  await context.stream.onopen(); await tick()
  const evaluate = value => vm.runInContext(value, context)
  t.after(async () => { windowListeners.get('pagehide')?.(); await context.__weappCleanupPromise })
  return {
    nodes, surfaces, requests, context, evaluate,
    event(type, payload) { listeners.get(type)({ type, data: JSON.stringify(payload) }) },
    async delayedProfileSwitch() {
      let resolve
      delayLoad = new Promise(yes => { resolve = yes })
      evaluate("renderState({webRenderer:'software'});renderState({webRenderer:'webview'})")
      await tick()
      evaluate("renderState({webRenderer:'software'})")
      resolve({ RemoteDomSurface: Surface }); await tick()
    },
  }
}

test('DOM UI keeps mirrors read-only, fences active settings and routes bridge SSE before inspector handling', async t => {
  const b = await browser(t), surface = b.surfaces[0]
  assert.equal(surface.connects, 1)
  assert.equal(b.requests.filter(value => ['/api/frame', '/api/render-frame'].includes(value.url)).length, 0)
  assert.equal(b.nodes.get('renderScale').disabled, true)
  assert.match(b.nodes.get('meta').textContent, /QuickJS on simulator.*WebView DOM\/CSS.*GPU unverified/)
  assert.doesNotMatch(b.nodes.get('meta').textContent, /external-frame-export/)
  assert.equal(b.nodes.get('logicalWidth').disabled, true)
  await b.nodes.get('logicalWidth').onchange()
  assert.equal(b.requests.filter(value => value.body?.logicalWidth).length, 0)
  b.event('preview', { preview: { ownerClientId: 'owned-tab', epoch: '2' } })
  assert.equal(b.nodes.get('logicalWidth').disabled, false)
  b.nodes.get('logicalWidth').value = '420'
  await b.nodes.get('logicalWidth').onchange()
  assert.deepEqual(b.requests.find(value => value.body?.logicalWidth)?.body.preview, { clientId: 'owned-tab', epoch: '2' })
  b.event('bridge', { messages: [{ op: 'view.presented', payload: { ok: true } }] })
  assert.equal(surface.bridges.length, 1)
  b.nodes.get('bridge').value = JSON.stringify({ sessionId: 'session', requestId: 'manual', op: 'view.prepare', payload: {} })
  const original = b.nodes.get('bridge').value
  await b.nodes.get('send').onclick()
  assert.deepEqual(b.requests.find(value => value.url === '/api/bridge').body.preview, { clientId: 'owned-tab', epoch: '2' })
  assert.equal(b.nodes.get('bridge').value, original)
})

test('pending startup never guesses a pixel transport or submits density before the WebView profile is known', async t => {
  const b = await browser(t, { initialProfile: 'pending' })
  b.evaluate('requestSnapshot();submitPresentation(true)')
  b.event('snapshot', { format: 'render-frame-v1', sessionId: 'session', configGeneration: 0, frameId: 1 })
  await tick()
  assert.equal(b.surfaces.length, 0)
  assert.equal(b.requests.some(value => ['/api/frame', '/api/render-frame'].includes(value.url)), false)
  assert.equal(b.requests.some(value => value.url === '/api/presentation' && value.body), false)
  b.event('state', { webRenderer: 'webview' }); await tick()
  b.event('state', { status: 'ready' }); await tick()
  assert.equal(b.surfaces.length, 1)
  assert.equal(b.context.__weappDomSurface, b.surfaces[0])
  assert.equal(b.requests.some(value => ['/api/frame', '/api/render-frame'].includes(value.url)), false)
})

test('DOM profile replacement disposes owned resources and a late module import cannot resurrect the old profile', async t => {
  const b = await browser(t), surface = b.surfaces[0]
  await b.delayedProfileSwitch()
  assert.equal(surface.disposals, 1)
  assert.equal(b.surfaces.length, 1)
  assert.equal(b.context.__weappDomSurface, null)
  assert.equal(b.context.__weappRemoteDom, null)
  assert.equal(b.nodes.get('domScreen').hidden, true)
  assert.equal(b.nodes.get('screen').hidden, false)
  assert.equal(b.nodes.get('renderScale').disabled, false)
})

test('closing the real UI surface sends exactly one keepalive release and freezes before cleanup finishes', async t => {
  const b = await browser(t, { realSurface: true }), surface = b.surfaces[0]
  b.evaluate('closeEventStream()')
  assert.equal(surface.online, false, 'dispose freezes synchronously')
  assert.equal(surface.closed, true)
  b.evaluate('closeEventStream()')
  await b.context.__weappCleanupPromise
  const releases = b.requests.filter(value => value.url === '/api/preview' && value.body.op === 'release')
  assert.equal(releases.length, 1)
  assert.equal(releases[0].keepalive, true)
  assert.equal(releases[0].body.epoch, '1')
})

test('switching away from the real DOM profile releases its lease even after an earlier disconnect', async t => {
  const b = await browser(t, { realSurface: true }), surface = b.surfaces[0]
  surface.disconnect('transport lost')
  b.evaluate("renderState({webRenderer:'software'})")
  await tick()
  assert.equal(surface.closed, true)
  assert.equal(b.requests.filter(value => value.url === '/api/preview' && value.body.op === 'release').length, 1)
})

test('final UI cleanup awaits an earlier profile retirement rather than only its current surface', async t => {
  const b = await browser(t), surface = b.surfaces[0]
  let finish
  surface.dispose = () => new Promise(resolve => { finish = resolve })
  b.evaluate("renderState({webRenderer:'software'})")
  assert.equal(typeof finish, 'function')
  b.evaluate('closeEventStream()')
  let completed = false
  b.context.__weappCleanupPromise.then(() => { completed = true })
  await tick()
  assert.equal(completed, false, 'removing the surface reference does not establish disposal')
  finish(); await b.context.__weappCleanupPromise
  assert.equal(completed, true)
})
