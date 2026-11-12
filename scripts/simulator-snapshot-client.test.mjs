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

function loadClient(html, initialState = { status: 'ready', webRenderer: 'software', diagnostics: [] }) {
  const nodes = new Map()
  const listeners = new Map()
  const snapshots = []
  const drawings = []
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, textContent: '', width: 375, height: 667,
      value: id === 'bridge' ? html.match(/<textarea id="bridge">([\s\S]*?)<\/textarea>/)?.[1] ?? '' : '',
      addEventListener() {},
      getContext: () => ({ putImageData: image => drawings.push(image) }),
    })
    return nodes.get(id)
  }
  const binary = html.includes("fetch('/api/frame'")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  vm.runInNewContext(script, {
    document: { getElementById: element }, TextEncoder, TextDecoder,
    ImageData: class {
      constructor(data, width, height) { Object.assign(this, { data, width, height }) }
    },
    EventSource: class {
      addEventListener(type, handler) { listeners.set(type, handler) }
    },
    fetch(url, options) {
      if (url === '/api/state') return Promise.resolve({
        ok: true, json: async () => initialState,
      })
      if (url === '/api/presentation') return Promise.resolve({ ok: true, json: async () => presentationFixture })
      assert.equal(url, binary ? '/api/frame' : '/api/snapshot')
      return new Promise(resolve => snapshots.push({ options, resolve }))
    },
  })
  return {
    snapshots, drawings, nodes,
    event(type, payload) {
      listeners.get(type)({ type, data: JSON.stringify(payload) })
    },
    notice(payload = { frameId: 2, url: '/api/snapshot' }) {
      listeners.get('snapshot')({ type: 'snapshot', data: JSON.stringify(payload) })
    },
    complete(index, payload, status = 200) {
      snapshots[index].resolve({ status, ok: status === 200, json: async () => payload, arrayBuffer: async () => encodeFrame({ ...payload, frameId: index + 1 }) })
    },
  }
}

const frame = value => ({ width: 1, height: 1, stride: 4, pixels: [value, 0, 0, 255] })

test('inspector diagnostic draft follows active sessions and preserves user edits', async () => {
  const client = loadClient(clients.inspector, { status: 'ready', sessionId: 'run-a', diagnostics: [] })
  await tick()
  const input = client.nodes.get('bridge')
  const initial = JSON.parse(input.value)
  assert.equal(initial.sessionId, 'run-a', 'the default diagnostic must target the actual run')
  initial.payload = { message: 'keep this edit' }
  input.value = JSON.stringify(initial)
  client.event('state', { status: 'ready', sessionId: 'run-b', diagnostics: [] })
  assert.equal(JSON.parse(input.value).sessionId, 'run-b', 'a restart must refresh the diagnostic session')
  assert.deepEqual(JSON.parse(input.value).payload, initial.payload)
  input.value = JSON.stringify({ ...initial, sessionId: 'deliberately-stale-session' })
  client.event('state', { status: 'ready', sessionId: 'run-c', diagnostics: [] })
  assert.equal(JSON.parse(input.value).sessionId, 'deliberately-stale-session', 'explicit session experiments remain editable')
  input.value = '{unfinished'
  client.event('state', { status: 'ready', sessionId: 'run-d', diagnostics: [] })
  assert.equal(input.value, '{unfinished')
})

for (const [name, html] of Object.entries(clients)) {
  test(`${name} coalesces notices during initial fetch and accepts legacy full frames`, async () => {
    const client = loadClient(html)
    await tick()
    assert.equal(client.snapshots.length, 1, 'initial frame must be fetched')
    for (let index = 0; index < 30; index += 1) client.notice()
    assert.equal(client.snapshots.length, 1, 'frame notices must not start concurrent fetches')
    client.complete(0, frame(1))
    await tick()
    assert.equal(client.snapshots.length, 2, 'one latest-frame fetch follows coalesced notices')
    assert.equal(client.snapshots[1].options.cache, 'no-store')
    client.complete(1, frame(2))
    await tick()
    assert.equal(client.snapshots.length, 2)
    assert.equal(client.drawings.at(-1).data[0], 2)
    client.notice(frame(3))
    assert.equal(client.snapshots.length, 2, 'legacy payloads draw directly')
    assert.equal(client.drawings.at(-1).data[0], 3)
  })

  test(`${name} retries after no frame and reports failed frame fetches`, async () => {
    const client = loadClient(html)
    await tick()
    client.complete(0, null, 404)
    await tick()
    assert.equal(client.drawings.length, 0)
    client.notice()
    client.complete(1, null, 500)
    await tick()
    assert.equal(client.nodes.get('overlay').style.display, 'block')
    assert.match(client.nodes.get('overlay').textContent, /(?:snapshot|frame) request failed: 500/)
    client.notice()
    client.complete(2, frame(4))
    await tick()
    assert.equal(client.drawings.at(-1).data[0], 4, 'a failed fetch must not wedge the request loop')
  })
}
