import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { attachSurfaceInput } from '../examples/hosts/web-wasm/surface-input.mjs'

const html = readFileSync(new URL('../examples/hosts/web/index.html', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))

// Execute the shipped embedding script rather than a reimplementation. The
// HTTP submission is deliberately deferred so both valid network orderings
// can be replayed without a browser, Rust process or developer-owned port.
function frame(presentation, sessionId = 'embedded-session', frameId = 1) {
  const width = Math.ceil(presentation.logicalWidth * (presentation.effectiveScale || 2))
  const height = Math.ceil(presentation.logicalHeight * (presentation.effectiveScale || 2))
  return {
    schemaVersion: 1, sessionId, frameId, configGeneration: presentation.generation,
    logicalWidth: presentation.logicalWidth, logicalHeight: presentation.logicalHeight,
    width, height, stride: width * 4, format: 'rgba8', byteLength: width * height * 4,
  }
}

function encodeFrame(header) {
  const encoded = new TextEncoder().encode(JSON.stringify(header))
  const buffer = new ArrayBuffer(4 + encoded.length + header.byteLength)
  new DataView(buffer).setUint32(0, encoded.length, true)
  new Uint8Array(buffer, 4, encoded.length).set(encoded)
  return buffer
}

async function client({ presentation } = {}) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: '', style: { display: id === 'overlay' ? 'none' : '' },
    listeners: new Map(), captures: new Set(),
    addEventListener(type, listener) { this.listeners.set(type, listener) },
    removeEventListener(type) { this.listeners.delete(type) },
    getContext() { return { putImageData: image => { this.image = image; this.draws = (this.draws || 0) + 1 } } },
    getBoundingClientRect() { return this.rect || { left: 10, top: 20, width: 187.5, height: 333.5 } },
    setPointerCapture(id) { this.captures.add(id) },
    hasPointerCapture(id) { return this.captures.has(id) },
    releasePointerCapture(id) { this.captures.delete(id) },
  }]))
  const events = new Map()
  const submissions = []
  const frameRequests = []
  let holdFrames = false
  let stream
  const initial = {
    status: 'ready', sessionId: 'embedded-session', route: 'pages/home/index',
    lifecycleState: 'Active', revision: 1, traceCount: 4, diagnostics: [],
    engine: 'quickjs', renderer: 'skia-raster',
    ...(presentation ? { presentation } : {}),
  }
  const context = vm.createContext({
    document: {
      getElementById(id) {
        assert.ok(nodes.has(id), `script references absent element #${id}`)
        return nodes.get(id)
      },
    },
    window: { addEventListener() {} }, attachSurfaceInput, TextDecoder,
    ImageData: class { constructor(pixels, width, height) { Object.assign(this, { pixels, width, height }) } }, MessageEvent,
    EventSource: class {
      constructor(url) { assert.equal(url, '/api/events'); stream = this }
      addEventListener(type, listener) { events.set(type, listener) }
    },
    fetch(url, options) {
      if (url === '/api/state') return Promise.resolve({ ok: true, json: async () => initial })
      if (url === '/api/snapshot') return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ width: 1, height: 1, stride: 4, pixels: [0, 0, 0, 255] }),
      })
      if (url === '/api/frame') return new Promise(resolve => {
        const request = {
          completed: false,
          complete(value = frame(initial.presentation)) {
            assert.equal(this.completed, false)
            this.completed = true
            resolve({ ok: true, status: 200, arrayBuffer: async () => encodeFrame(value) })
          },
        }
        frameRequests.push(request)
        if (!holdFrames) request.complete()
      })
      assert.equal(url, '/api/bridge')
      assert.equal(options.method, 'POST')
      return new Promise(resolve => submissions.push({
        request: JSON.parse(options.body),
        complete(body, status = 200) {
          resolve({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) })
        },
      }))
    },
  })
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context)
  const inputScript = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/import \{ attachSurfaceInput \} from '[^']+';/, '')
  vm.runInContext(inputScript, context)
  await tick()
  return {
    nodes, submissions, initial, frameRequests,
    holdFrames() { holdFrames = true },
    input(type, values = {}) {
      const event = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0,
        clientX: 85, clientY: 120, preventDefault() {}, ...values }
      nodes.get('screen').listeners.get(type)(event)
    },
    click() { return nodes.get('send').listeners.get('click')() },
    event(type, payload) {
      assert.ok(events.has(type), `client must subscribe to ${type}`)
      const event = new MessageEvent(type, { data: JSON.stringify(payload) })
      events.get(type)(event)
      // Match browser dispatch: custom errors reach both the subscription
      // listener and the IDL onerror handler with the same MessageEvent.
      stream[`on${type}`]?.(event)
    },
    disconnect() {
      const event = new Event('error')
      events.get('error')(event)
      stream.onerror?.(event)
    },
    content(id) { return nodes.get(id).textContent },
  }
}

const acknowledgement = { ok: true, queued: true }
const runtimeBatch = request => ({ messages: [{
  protocolVersion: '1.0', sessionId: request.sessionId, requestId: request.requestId,
  kind: 'response', op: request.op, payload: { ok: true, accepted: true },
}] })

test('HTTP queue acknowledgement stays separate until an asynchronous runtime response arrives', async () => {
  const c = await client()
  const sending = c.click()
  const submission = c.submissions[0]
  assert.equal(submission.request.sessionId, c.initial.sessionId)
  assert.equal(submission.request.op, 'diagnostic')
  submission.complete(acknowledgement)
  await sending
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
  assert.equal(c.content('bridgeResult'), '', 'an HTTP queue acknowledgement cannot impersonate completion')
  assert.equal(c.content('log'), '', 'submission acknowledgement is not a diagnostic')

  const completed = runtimeBatch(submission.request)
  c.event('bridge', completed)
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed)
  c.event('state', { ...c.initial, traceCount: 5 })
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed, 'the next state update cannot erase the response')
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
})

test('runtime bridge followed by state and delayed HTTP acknowledgement preserves the completed result', async () => {
  const c = await client()
  const sending = c.click()
  const submission = c.submissions[0]
  const completed = runtimeBatch(submission.request)
  c.event('bridge', completed)
  c.event('state', { ...c.initial, traceCount: 5 })
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed)
  submission.complete(acknowledgement)
  await sending
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), completed, 'a late queue acknowledgement cannot overwrite completion')
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)
  assert.equal(c.content('log'), '')
})

test('diagnostics own the log and overlay while state and reload preserve bridge evidence', async () => {
  const c = await client()
  const sending = c.click()
  const submission = c.submissions[0]
  submission.complete(acknowledgement)
  await sending
  const failed = runtimeBatch(submission.request)
  failed.messages[0].payload = { ok: false, error: { code: 'ERR_ENGINE', message: 'runtime failed' } }
  c.event('bridge', failed)
  const diagnostic = { severity: 'error', code: 'ERR_ENGINE', message: 'runtime failed' }
  c.event('error', diagnostic)
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.equal(c.content('status'), 'error', 'application error events cannot impersonate a disconnected SSE transport')
  assert.match(c.content('overlay'), /runtime failed/)
  assert.match(c.content('log'), /ERR_ENGINE: runtime failed/)
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), failed)
  assert.deepEqual(JSON.parse(c.content('submission')), acknowledgement)

  c.event('state', { ...c.initial, status: 'error', diagnostics: [diagnostic], traceCount: 5 })
  assert.equal(c.nodes.get('overlay').style.display, 'block', 'ordinary state updates cannot hide a runtime failure')
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), failed)
  c.event('reload', { ...c.initial, revision: 2, traceCount: 6 })
  assert.equal(c.nodes.get('overlay').style.display, 'none', 'successful reload clears the error overlay')
  assert.equal(c.content('status'), 'ready')
  assert.equal(c.content('log'), '', 'recovered active diagnostics are cleared')
  assert.deepEqual(JSON.parse(c.content('bridgeResult')), failed, 'reload cannot erase the last runtime batch')
})

test('embedding reports true transport loss without replacing an active application error', async () => {
  const c = await client()
  const diagnostic = { severity: 'error', code: 'ERR_ENGINE', message: 'preserve runtime diagnostic' }
  c.event('error', diagnostic)
  assert.equal(c.content('status'), 'error')
  assert.equal(c.content('overlay'), diagnostic.message)
  c.disconnect()
  assert.equal(c.content('status'), 'disconnected')
  assert.equal(c.content('overlay'), diagnostic.message, 'transport events do not contain JSON or replace runtime diagnostics')
  c.event('reload', { ...c.initial, revision: 2 })
  assert.equal(c.content('status'), 'ready')
  assert.equal(c.nodes.get('overlay').style.display, 'none')
})

test('HTTP submission failure shows an error without manufacturing a runtime result', async () => {
  const c = await client()
  const sending = c.click()
  c.submissions[0].complete({ error: 'queue unavailable' }, 503)
  await sending
  assert.equal(c.nodes.get('overlay').style.display, 'block')
  assert.match(c.content('overlay'), /queue unavailable/)
  assert.deepEqual(JSON.parse(c.content('submission')), { error: 'queue unavailable' })
  assert.equal(c.content('bridgeResult'), '')
})

test('a new diagnostic clears stale completion and uses the active session after restart', async () => {
  const c = await client()
  const first = c.click()
  c.submissions[0].complete(acknowledgement)
  await first
  c.event('bridge', runtimeBatch(c.submissions[0].request))
  c.event('reload', { ...c.initial, sessionId: 'restarted-session', revision: 2 })
  const second = c.click()
  assert.equal(c.content('bridgeResult'), '', 'previous request success is not evidence for a new request')
  assert.equal(c.submissions[1].request.sessionId, 'restarted-session')
  assert.notEqual(c.submissions[1].request.requestId, c.submissions[0].request.requestId)
  c.submissions[1].complete(acknowledgement)
  await second
  assert.equal(c.content('bridgeResult'), '', 'the new request still waits for its own runtime batch')
})

const densityPresentation = {
  schemaVersion: 1, revision: 1, generation: 1,
  logicalWidth: 375, logicalHeight: 667, renderScale: 'auto', effectiveScale: 2, fps: 60,
}

test('embedding maps 2x backing pixels and display zoom to logical tap and scroll coordinates', async () => {
  const c = await client({ presentation: densityPresentation })
  const canvas = c.nodes.get('screen')
  assert.equal(canvas.width, 750)
  assert.equal(canvas.height, 1334)
  assert.equal(canvas.style.width, '375px')
  assert.ok(canvas.image.pixels.byteOffset > 0, 'binary ImageData keeps the packed frame view without a second RGBA copy')
  assert.equal(canvas.image.pixels.byteLength, 750 * 1334 * 4)
  assert.equal(c.frameRequests.every(request => request.completed), true)
  // The preview is displayed at 50%; backing density must not enter input math.
  c.input('pointerdown')
  c.input('pointerup')
  await tick()
  const tap = c.submissions[0]
  assert.deepEqual(tap.request.payload.logicalViewport, { width: 375, height: 667 })
  assert.deepEqual(tap.request.payload.events.map(event => [event.type, event.x, event.y]), [['tap', 150, 200]])
  tap.complete(acknowledgement)
  await tick()
  c.input('wheel', { deltaMode: 0, deltaX: 20, deltaY: 30 })
  await tick()
  const wheel = c.submissions[1]
  assert.deepEqual(wheel.request.payload.logicalViewport, { width: 375, height: 667 })
  assert.deepEqual(wheel.request.payload.events.map(event =>
    [event.type, event.x, event.y, event.deltaX, event.deltaY, event.deltaMode]),
  [['wheel', 150, 200, 40, 60, 0]])
  wheel.complete(acknowledgement)
  await tick()
})

test('logical resize cancels queued input and keeps old pixels inert until its matching binary frame', async () => {
  const c = await client({ presentation: densityPresentation })
  const canvas = c.nodes.get('screen')
  const originalDraws = canvas.draws
  c.holdFrames()
  // This contact is queued in the old coordinate epoch, before the microtask flush.
  c.input('pointerdown', { pointerType: 'touch' })
  const resized = { ...densityPresentation, revision: 2, generation: 2, logicalWidth: 667, logicalHeight: 375 }
  c.event('state', { ...c.initial, presentation: resized })
  c.event('snapshot', { url: '/api/frame', sessionId: c.initial.sessionId, configGeneration: resized.generation })
  await tick()
  assert.equal(c.submissions.length, 0, 'old queued input is discarded by the logical epoch reset')
  assert.equal(canvas.captures.size, 0)
  assert.equal(c.frameRequests.filter(request => !request.completed).length, 1, 'only one frame request is in flight')
  c.input('pointerdown')
  c.input('pointerup')
  c.input('wheel', { deltaMode: 0, deltaX: 0, deltaY: 10 })
  await tick()
  assert.equal(c.submissions.length, 0, 'the displayed old viewport cannot send new coordinates')
  c.frameRequests.find(request => !request.completed).complete(frame(densityPresentation))
  await tick()
  assert.equal(canvas.draws, originalDraws, 'a late old generation cannot replace the accepted pixels')
  assert.equal(c.frameRequests.filter(request => !request.completed).length, 1, 'frame notifications coalesce behind the in-flight fetch')
  c.input('pointerdown')
  c.input('pointerup')
  await tick()
  assert.equal(c.submissions.length, 0, 'an old frame cannot unlock input')
  c.frameRequests.find(request => !request.completed).complete(frame(resized))
  await tick()
  assert.equal(canvas.width, 1334)
  assert.equal(canvas.height, 750)
  assert.equal(canvas.draws, originalDraws + 1)
  canvas.rect = { left: 10, top: 20, width: 333.5, height: 187.5 }
  c.input('pointerdown')
  c.input('pointerup')
  await tick()
  const tap = c.submissions[0]
  assert.deepEqual(tap.request.payload.logicalViewport, { width: 667, height: 375 })
  assert.deepEqual(tap.request.payload.events.map(event => [event.type, event.x, event.y]), [['tap', 150, 200]])
  tap.complete(acknowledgement)
  await tick()
})

test('legacy embedding adapters keep full snapshot input without presentation metadata', async () => {
  const c = await client()
  c.event('snapshot', { width: 100, height: 200, stride: 400, pixels: Array(100 * 200 * 4).fill(0) })
  const canvas = c.nodes.get('screen')
  canvas.rect = { left: 10, top: 20, width: 50, height: 100 }
  c.input('pointerdown', { clientX: 35, clientY: 70 })
  c.input('pointerup', { clientX: 35, clientY: 70 })
  await tick()
  const tap = c.submissions[0]
  assert.equal('logicalViewport' in tap.request.payload, false, 'old adapters do not require the new presentation protocol')
  assert.deepEqual(tap.request.payload.events.map(event => [event.type, event.x, event.y]), [['tap', 50, 100]])
  assert.equal(c.frameRequests.length, 0)
  tap.complete(acknowledgement)
  await tick()
})
