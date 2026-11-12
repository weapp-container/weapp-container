import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { routeStyleIds } from '../examples/hosts/web-wasm/render-inputs.mjs'

const sourceRoot = new URL(process.env.PRESENTER_SOURCE_ROOT || '../', import.meta.url)
const source = await readFile(new URL('examples/hosts/web-wasm/app.mjs', sourceRoot), 'utf8')
const wrapperSource = source.replace(/^import .+$/gm, '').replace(/^export /gm, '')
const inputSource = (await readFile(new URL('examples/hosts/web-wasm/surface-input.mjs', sourceRoot), 'utf8')).replace(/^export /gm, '')
const epoch = 1_792_563_456_789

// Execute the checked-in timer JavaScript from both engine adapters, rather
// than copying its scheduling rules into the test. This is Node/JS evidence;
// it is not execution of QuickJS/V8 native providers, WASM or a browser.
async function engineTimers(engine, clock) {
  const adapter = await readFile(new URL(`crates/container-engine-${engine}/src/lib.rs`, sourceRoot), 'utf8')
  assert.ok(adapter.includes('timer-tasks.js'), `${engine} uses the shared scheduling source`)
  const text = await readFile(new URL('crates/container-core/src/timer-tasks.js', sourceRoot), 'utf8')
  const DateClock = class extends Date { static now() { return clock.now } }
  const context = vm.createContext({ Date: DateClock })
  return vm.runInContext(`
    const __container_events = [];
    function __container_report_error(error) { throw error; }
    ${text}
    // This synchronous stand-in verifies only the Web clock/wrapper. Native
    // engine tests separately prove checkpoints between callback tasks.
    ({ schedule: __container_schedule, cancel: __container_cancel_timer, drain(now) {
      __container_timer_begin(now);
      while (__container_timer_task()) {}
      return __container_timer_end();
    } })
  `, context)
}

async function fixture(engine = 'quickjs') {
  const clock = { now: epoch }
  const timers = await engineTimers(engine, clock)
  const calls = { polls: [], callbacks: [], requests: [], renders: 0, unloaded: 0, freed: 0, order: [], acknowledgements: [],
    renderRevision: 1000n, viewRevision: 0n, frameId: 0, ackEffect: null, ackBatch: null }
  const manifest = { app: { appJson: 'app.json' }, modules: [], components: [], styles: [],
    routes: [{ path: 'pages/home' }], integrity: { root: 'a'.repeat(64) } }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const index = { manifest: 'manifest.json', manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    integrityRoot: manifest.integrity.root, blobs: [] }
  const documents = new Map([
    ['https://example.test/pack-index.json', Buffer.from(JSON.stringify(index))],
    ['https://example.test/manifest.json', manifestBytes],
  ])
  class Host {
    load_manifest_json_with_config() {}
    capabilities_json() { return '{}' }
    dispatch_json(json) {
      const request = JSON.parse(json)
      calls.requests.push(request)
      if (request.op === 'app.init') timers.schedule(() => calls.callbacks.push('startup'), 25, false)
      if (request.op === 'render.commit') { calls.frameId = request.payload.frameId; calls.renderRevision += 1n; calls.nativeViewport = { ...request.payload.viewport } }
      return JSON.stringify({ messages: [{ ...request, kind: 'response', payload: { ok: true, engineProviderAvailable: true } }] })
    }
    poll_timers(nowNs) {
      assert.equal(typeof nowNs, 'bigint', 'wasm_bindgen u64 input must be BigInt')
      calls.polls.push(nowNs)
      const fired = timers.drain(Number(nowNs / 1_000_000n))
      return JSON.stringify({ messages: fired.length ? [{ kind: 'event', op: 'event.batch', payload: { timers: fired } }] : [] })
    }
    render_snapshot_rgba() { return new Uint8Array(4) }
    render_revision() { return calls.renderRevision }
    view_revision() { return calls.viewRevision }
    render_frame_json() { return JSON.stringify({ frame_id: calls.frameId, viewport: calls.nativeViewport, root: {} }) }
    acknowledge_presentation(revision) {
      calls.order.push('ack')
      assert.equal(typeof revision, 'bigint')
      assert.equal(revision, calls.renderRevision)
      assert.notEqual(revision, BigInt(calls.frameId), 'frameId is not the renderer revision')
      calls.acknowledgements.push(revision)
      calls.ackEffect?.()
      return JSON.stringify(calls.ackBatch || { messages: [] })
    }
    unload() { calls.unloaded += 1 }
    free() { calls.freed += 1 }
  }
  const raf = new Map(), batches = []
  let nextFrame = 0
  const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {},
    getContext: () => ({ putImageData() { calls.renders += 1 } }) }
  const context = vm.createContext({
    init: async () => {}, WebWasmHost: Host, routeStyleIds, crypto: webcrypto,
    Date: class extends Date { static now() { return clock.now } },
    performance: { now: () => 500 }, AbortController, URL, TextDecoder, TextEncoder,
    ImageData: class { constructor(pixels, width, height) { Object.assign(this, { pixels, width, height }) } },
    location: { href: 'https://example.test/' },
    document: { querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    fetch: async url => {
      const bytes = documents.get(String(url))
      assert.ok(bytes, `unexpected resource ${url}`)
      return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer }
    },
    requestAnimationFrame(callback) { const id = ++nextFrame; raf.set(id, callback); return id },
    cancelAnimationFrame(id) { raf.delete(id) },
  })
  const { WeappWebSession, unixTimerNanos } = vm.runInContext(`${inputSource}\n${wrapperSource}\n;({ WeappWebSession, unixTimerNanos });`, context)
  const session = new WeappWebSession(canvas, batch => batches.push(batch))
  await session.load()
  return { clock, calls, batches, session, timers, raf, unixTimerNanos,
    frame(relativeTime) {
      assert.equal(raf.size, 1, 'exactly one owned RAF should be pending')
      const [id, callback] = raf.entries().next().value
      raf.delete(id)
      callback(relativeTime)
    } }
}


function commits(f) { return f.calls.requests.filter(r => r.op === 'render.commit').length }
function external(f) {
  const submitted = []
  f.session.presenter = { submit(frame) { submitted.push(frame); return { backend: 'canvaskit-webgl2', frameId: frame.frame_id } }, dispose() {} }
  f.session.render()
  return submitted
}

test('empty timer batch presents a native Canvas repaint once without reevaluating View', async () => {
  const f = await fixture()
  try {
    const submitted = external(f), count = commits(f), frameId = f.calls.frameId, view = f.calls.viewRevision
    const nativeRevision = ++f.calls.renderRevision
    f.session.host.render_frame_json = () => JSON.stringify({ frame_id: frameId, viewport: { x: 0, y: 0, width: 1, height: 1 }, root: { canvas: 'new retained image' } })
    f.frame(16)
    assert.equal(submitted.length, 2, 'render-only publication reaches presenter despite no bridge messages')
    assert.equal(submitted[1].root.canvas, 'new retained image')
    assert.equal(commits(f), count, 'retained paint keeps the accepted layout transaction')
    assert.equal(f.calls.frameId, frameId)
    assert.equal(f.calls.viewRevision, view)
    assert.equal(f.calls.acknowledgements.at(-1), nativeRevision)
    assert.equal(f.session.presentation.renderRevision, nativeRevision.toString())
    f.frame(32)
    assert.equal(submitted.length, 2, 'same accepted publication is not submitted again')
  } finally { f.session.close() }
  assert.equal(f.raf.size, 0)
})

test('message-bearing native repaint still retains its publication and exact ACK', async () => {
  const f = await fixture()
  try {
    const submitted = external(f), count = commits(f), nativeRevision = ++f.calls.renderRevision
    f.session.host.poll_timers = () => JSON.stringify({ messages: [{ kind: 'event', op: 'canvas.callback', payload: {} }] })
    f.frame(16)
    assert.equal(submitted.length, 2)
    assert.equal(commits(f), count)
    assert.equal(f.calls.acknowledgements.at(-1), nativeRevision)
  } finally { f.session.close() }
})

test('a repaint published by ACK effects is submitted on the following owned RAF', async () => {
  const f = await fixture()
  try {
    f.calls.ackEffect = () => { f.calls.ackEffect = null; f.calls.renderRevision += 1n }
    const submitted = external(f), count = commits(f), nativeRevision = f.calls.renderRevision
    f.frame(16)
    assert.equal(submitted.length, 2)
    assert.equal(commits(f), count)
    assert.equal(f.calls.acknowledgements.at(-1), nativeRevision)
    f.frame(32)
    assert.equal(submitted.length, 2)
  } finally { f.session.close() }
})

test('new View input takes the normal render.commit path even when paint also advanced', async () => {
  const f = await fixture()
  try {
    const submitted = external(f), count = commits(f), frameId = f.calls.frameId
    f.calls.renderRevision += 1n; f.calls.viewRevision += 1n
    f.frame(16)
    assert.equal(submitted.length, 2)
    assert.equal(commits(f), count + 1)
    assert.equal(f.calls.frameId, frameId + 1)
    assert.equal(f.calls.acknowledgements.at(-1), f.calls.renderRevision)
    f.frame(32)
    assert.equal(submitted.length, 2)
  } finally { f.session.close() }
})

test('retained flush failure sends no ACK and keeps automatic presentation suspended', async () => {
  const f = await fixture()
  try {
    external(f)
    const before = f.session.presentation, count = commits(f), acks = f.calls.acknowledgements.length
    let attempts = 0
    f.session.presenter.submit = () => { attempts++; throw new Error('ERR_RENDER: retained flush failed') }
    f.calls.renderRevision += 1n
    f.frame(16)
    assert.equal(attempts, 1)
    assert.equal(commits(f), count)
    assert.equal(f.calls.acknowledgements.length, acks)
    assert.equal(f.session.presentation, before)
    assert.equal(f.session.suspended, true)
    assert.ok(f.batches.some(batch => batch.error?.message === 'ERR_RENDER: retained flush failed'))
    f.frame(32)
    assert.equal(attempts, 1)
    assert.equal(f.session.closed, false)
  } finally { f.session.close() }
})

test('reentrant publication during retained submit cannot ACK a newer token', async () => {
  const f = await fixture()
  try {
    external(f)
    const count = commits(f), acks = f.calls.acknowledgements.length
    f.calls.renderRevision += 1n
    f.session.presenter.submit = frame => { f.calls.renderRevision += 1n; return { backend: 'canvaskit-webgl2', frameId: frame.frame_id } }
    assert.throws(() => f.session.render())
    assert.equal(commits(f), count)
    assert.equal(f.calls.acknowledgements.length, acks)
    assert.equal(f.session.suspended, true)
  } finally { f.session.close() }
})


test('canvas target resize plus native paint commits a new viewport before submit', async () => {
  const f = await fixture()
  try {
    const submitted = external(f), count = commits(f), oldFrame = f.calls.frameId
    f.session.canvas.width = 2; f.session.canvas.height = 3
    f.calls.renderRevision += 1n
    f.frame(16)
    assert.equal(commits(f), count + 1, 'resized target cannot reuse a prior submitted viewport')
    assert.equal(submitted.length, 2)
    assert.equal(submitted[1].viewport.width, 2)
    assert.equal(submitted[1].viewport.height, 3)
    assert.equal(f.calls.frameId, oldFrame + 1)
    assert.equal(f.calls.acknowledgements.at(-1), f.calls.renderRevision)
    f.frame(32)
    assert.equal(submitted.length, 2)
  } finally { f.session.close() }
})

test('latest native frame viewport mismatch cannot reuse saved submitted viewport identity', async () => {
  const f = await fixture()
  try {
    const submitted = external(f), count = commits(f)
    f.calls.nativeViewport = { x: 0, y: 0, width: 5, height: 7 }
    f.calls.renderRevision += 1n
    f.frame(16)
    assert.equal(commits(f), count + 1, 'current native frame must also match the actual target')
    assert.equal(submitted.length, 2)
    assert.equal(submitted[1].viewport.width, 1)
    assert.equal(submitted[1].viewport.height, 1)
    assert.equal(f.calls.acknowledgements.at(-1), f.calls.renderRevision)
  } finally { f.session.close() }
})

test('canvas target resize alone is observed by the existing external-presenter RAF', async () => {
  const f = await fixture()
  try {
    const submitted = external(f), count = commits(f)
    f.session.canvas.width = 4
    f.frame(16)
    assert.equal(commits(f), count + 1)
    assert.equal(submitted.length, 2)
    assert.equal(submitted[1].viewport.width, 4)
    f.frame(32)
    assert.equal(submitted.length, 2)
  } finally { f.session.close() }
})
