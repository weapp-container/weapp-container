import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { encodeFrame, presentationFixture } from './simulator-client-binary-fixture.mjs'

const surfaceHtml = readFileSync(new URL('../crates/container-simulator/src/web-ui.html', import.meta.url), 'utf8')
const clients = {
  inspector: surfaceHtml,
  embedding: readFileSync(new URL('../examples/hosts/web/index.html', import.meta.url), 'utf8'),
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const frame = value => ({ width: 1, height: 1, stride: 4, pixels: [value, 0, 0, 255] })
const diagnostic = {
  revision: 2, phase: 'build', severity: 'error', code: 'ERR_BUILD',
  message: 'fixture build failed', timestamp: '2026-10-20T00:00:00Z',
}
const initialState = {
  status: 'ready', sessionId: 'reconnect-session', revision: 1,
  route: 'pages/home/index', lifecycleState: 'Active', traceCount: 4,
  engine: 'quickjs', renderer: 'skia-raster', webRenderer: 'software', diagnostics: [],
  diagnosticHistory: { schemaVersion: 1, records: [], totalRecords: 0, droppedRecords: 0, complete: true },
}

// Replay network orderings against both actual shipped clients. State response
// bodies and snapshots can be held independently; no browser or local port is used.
async function client(html, initial = initialState) {
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: '', style: { display: id === 'overlay' ? 'none' : '' },
    value: id === 'bridge' ? html.match(/<textarea id="bridge">([\s\S]*?)<\/textarea>/)?.[1] ?? '' : '',
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener) },
    getContext() { return { putImageData: image => drawings.push(image) } },
  }]))
  const drawings = []
  const listeners = new Map()
  const stateRequests = []
  const snapshotRequests = []
  let authoritativeState = structuredClone(initial)
  let deferState = false
  let deferSnapshot = false
  const binary = html.includes("fetch('/api/frame'")
  let stream
  let streamCloseCount = 0
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById(id) {
      assert.ok(nodes.has(id), `script references absent element #${id}`)
      return nodes.get(id)
    } },
    TextEncoder, TextDecoder, MessageEvent,
    ImageData: class {
      constructor(data, width, height) { Object.assign(this, { data, width, height }) }
    },
    EventSource: class {
      constructor(url) {
        assert.equal(url, '/api/events')
        stream = this
      }
      addEventListener(type, listener) { listeners.set(type, listener) }
      close() { streamCloseCount += 1 }
    },
    fetch(url, options) {
      if (url === '/api/state') {
        const captured = structuredClone(authoritativeState)
        let resolveBody
        const body = deferState ? new Promise(resolve => { resolveBody = resolve }) : Promise.resolve(captured)
        deferState = false
        stateRequests.push({ options, complete(value = captured) { resolveBody(value) } })
        return Promise.resolve({ ok: true, status: 200, json: () => body })
      }
      if (url === '/api/presentation') return Promise.resolve({ ok: true, json: async () => presentationFixture })
      assert.equal(url, binary ? '/api/frame' : '/api/snapshot')
      let resolveResponse
      const value = { ...frame(snapshotRequests.length + 1), frameId: snapshotRequests.length + 1 }
      const response = payload => ({ ok: true, status: 200, json: async () => payload, arrayBuffer: async () => encodeFrame(payload) })
      const pending = deferSnapshot
        ? new Promise(resolve => { resolveResponse = resolve })
        : Promise.resolve(response(value))
      deferSnapshot = false
      snapshotRequests.push({ options, complete(payload = value) { resolveResponse(response(payload)) } })
      return pending
    },
  })
  await tick()
  return {
    nodes, drawings, stateRequests, snapshotRequests,
    streamCloseCount() { return streamCloseCount },
    setState(next) { authoritativeState = structuredClone(next) },
    deferNextState() { deferState = true },
    deferNextSnapshot() { deferSnapshot = true },
    open() {
      assert.equal(typeof stream.onopen, 'function', 'the client must refresh on each SSE connection')
      return stream.onopen()
    },
    disconnect() { stream.onerror() },
    event(type, payload) {
      assert.ok(listeners.has(type), `client must subscribe to ${type}`)
      listeners.get(type)({ type, data: JSON.stringify(payload) })
    },
    content(id) { return nodes.get(id).textContent },
    overlayVisible() { return nodes.get('overlay').style.display === 'block' },
  }
}

for (const [name, html] of Object.entries(clients)) {
  test(`${name} recovers an idle offline connection from current state and snapshot without a new SSE event`, async () => {
    const c = await client(html)
    assert.equal(c.stateRequests.length, 1)
    assert.equal(c.streamCloseCount(), 0, 'live streams remain open for reconnect')
    assert.equal(c.snapshotRequests.length, 1)
    c.disconnect()
    assert.equal(c.content('status'), 'disconnected')
    assert.match(c.content('overlay'), /event stream disconnected/)
    c.setState({ ...initialState, revision: 2, route: 'pages/recovered/index' })
    await c.open()
    assert.equal(c.content('status'), 'ready')
    assert.match(c.content('route'), /pages\/recovered\/index/)
    assert.equal(c.overlayVisible(), false)
    assert.equal(c.stateRequests.length, 2)
    assert.equal(c.stateRequests[1].options.cache, 'no-store')
    assert.equal(c.snapshotRequests.length, 2)
    assert.equal(c.drawings.at(-1).data[0], 2)
  })

  test(`${name} preserves active diagnostics across reconnect and clears them only when server state recovers`, async () => {
    const history = { ...initialState.diagnosticHistory, records: [diagnostic], totalRecords: 1 }
    const failed = { ...initialState, status: 'error', diagnostics: [diagnostic], diagnosticHistory: history }
    const c = await client(html, failed)
    assert.equal(c.overlayVisible(), true, 'initial HTTP state must display an active failure')
    assert.equal(c.content('overlay'), diagnostic.message)
    c.disconnect()
    assert.equal(c.content('overlay'), diagnostic.message, 'transport errors cannot hide the build failure')
    await c.open()
    assert.equal(c.content('status'), 'error')
    assert.equal(c.content('overlay'), diagnostic.message)
    assert.equal(c.overlayVisible(), true)

    c.setState({ ...initialState, revision: 3, diagnosticHistory: history })
    c.disconnect()
    await c.open()
    assert.equal(c.content('status'), 'ready')
    assert.equal(c.overlayVisible(), false)
    if (name === 'inspector') assert.match(c.content('log'), /ERR_BUILD: fixture build failed/, 'recovery keeps diagnostic history')
  })

  test(`${name} rejects a stale reconnect state after a newer SSE diagnostic`, async () => {
    const c = await client(html)
    c.disconnect()
    c.deferNextState()
    const refreshing = c.open()
    c.event('diagnostic', diagnostic)
    c.stateRequests.at(-1).complete()
    await refreshing
    assert.equal(c.content('status'), 'error')
    assert.equal(c.content('overlay'), diagnostic.message)
    assert.equal(c.overlayVisible(), true)
    assert.match(c.content('log'), /ERR_BUILD/)
    assert.equal(c.snapshotRequests.length, 1, 'a rejected state cannot request a stale frame')
  })

  test(`${name} uses the latest overlapping reconnect refresh`, async () => {
    const c = await client(html)
    c.disconnect()
    c.deferNextState()
    const stale = c.open()
    const pending = c.stateRequests.at(-1)
    c.setState({ ...initialState, revision: 4, route: 'pages/latest/index' })
    await c.open()
    pending.complete()
    await stale
    assert.equal(c.content('status'), 'ready')
    assert.match(c.content('route'), /pages\/latest\/index/)
    assert.equal(c.snapshotRequests.length, 2, 'superseded state responses cannot redraw')
  })

  test(`${name} keeps a disconnect newer than an in-flight refresh until the next successful connection`, async () => {
    const c = await client(html)
    c.deferNextState()
    const refreshing = c.open()
    c.disconnect()
    c.stateRequests.at(-1).complete()
    await refreshing
    assert.equal(c.content('status'), 'disconnected')
    assert.equal(c.overlayVisible(), true)
    await c.open()
    assert.equal(c.content('status'), 'ready')
    assert.equal(c.overlayVisible(), false)
  })

  test(`${name} shutdown is terminal despite pending refreshes, late frames and more SSE callbacks`, async () => {
    const c = await client(html)
    c.deferNextSnapshot()
    c.event('snapshot', { frameId: 2, url: '/api/snapshot' })
    c.deferNextState()
    const refreshing = c.open()
    const pendingState = c.stateRequests.at(-1)
    const pendingFrame = c.snapshotRequests.at(-1)
    const drawingCount = c.drawings.length
    c.event('shutdown', { reason: 'fixture shutdown' })
    assert.equal(c.streamCloseCount(), 1, 'shutdown must close the owned stream')
    const shutdownOverlay = c.content('overlay')
    assert.match(shutdownOverlay, /fixture shutdown/)
    assert.equal(c.content('status'), 'stopped')
    pendingState.complete()
    pendingFrame.complete()
    await refreshing
    await tick()
    for (const type of ['state', 'ready', 'reload']) c.event(type, initialState)
    c.event('error', { message: 'late failure' })
    c.event('diagnostic', diagnostic)
    c.event('snapshot', frame(99))
    c.disconnect()
    const stateCount = c.stateRequests.length
    const snapshotCount = c.snapshotRequests.length
    await c.open()
    assert.equal(c.content('status'), 'stopped')
    assert.equal(c.content('overlay'), shutdownOverlay)
    assert.equal(c.overlayVisible(), true)
    assert.equal(c.stateRequests.length, stateCount, 'terminal state cannot fetch or reconnect')
    assert.equal(c.snapshotRequests.length, snapshotCount)
    assert.equal(c.drawings.length, drawingCount, 'late snapshots cannot redraw a stopped session')
    assert.equal(c.streamCloseCount(), 1, 'late callbacks cannot close the stream twice')
  })

  test(`${name} an authoritative stopped state is terminal even when shutdown SSE was missed`, async () => {
    const c = await client(html)
    c.disconnect()
    c.setState({ ...initialState, status: 'stopped' })
    await c.open()
    assert.equal(c.content('status'), 'stopped')
    assert.match(c.content('overlay'), /simulator stopped/)
    assert.equal(c.streamCloseCount(), 1, 'authoritative stopped state must close the owned stream')
    assert.equal(c.snapshotRequests.length, 1, 'stopped sessions do not fetch a new frame')
    const requestCount = c.stateRequests.length
    c.event('reload', initialState)
    c.disconnect()
    await c.open()
    assert.equal(c.content('status'), 'stopped')
    assert.equal(c.overlayVisible(), true)
    assert.equal(c.stateRequests.length, requestCount)
    assert.equal(c.streamCloseCount(), 1)
  })

  test(`${name} an initial stopped HTTP state closes its stream exactly once`, async () => {
    const c = await client(html, { ...initialState, status: 'stopped' })
    assert.equal(c.content('status'), 'stopped')
    assert.equal(c.streamCloseCount(), 1)
    assert.equal(c.snapshotRequests.length, 0)
    c.event('shutdown', { reason: 'duplicate shutdown' })
    c.disconnect()
    await c.open()
    assert.equal(c.streamCloseCount(), 1)
    assert.equal(c.stateRequests.length, 1)
  })

  test(`${name} a stopped SSE state closes its stream even without a shutdown event`, async () => {
    const c = await client(html)
    c.event('state', { ...initialState, status: 'stopped' })
    assert.equal(c.content('status'), 'stopped')
    assert.equal(c.streamCloseCount(), 1)
    c.event('state', initialState)
    c.disconnect()
    await c.open()
    assert.equal(c.streamCloseCount(), 1)
    assert.equal(c.stateRequests.length, 1)
  })

  test(`${name} a partial ready notification cannot hide an active server diagnostic`, async () => {
    const c = await client(html, { ...initialState, status: 'error', diagnostics: [diagnostic] })
    c.event('ready', { revision: 2 })
    assert.equal(c.overlayVisible(), true)
    assert.equal(c.content('overlay'), diagnostic.message)
    c.event('reload', { revision: 2 })
    assert.equal(c.overlayVisible(), true)
    assert.equal(c.content('overlay'), diagnostic.message)
  })
}
