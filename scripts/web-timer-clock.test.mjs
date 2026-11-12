import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { routeStyleIds } from '../examples/hosts/web-wasm/render-inputs.mjs'

const source = await readFile(new URL('../examples/hosts/web-wasm/app.mjs', import.meta.url), 'utf8')
const wrapperSource = source.replace(/^import .+$/gm, '').replace(/^export /gm, '')
const inputSource = (await readFile(new URL('../examples/hosts/web-wasm/surface-input.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '')
const epoch = 1_792_563_456_789

// Execute the checked-in timer JavaScript from both engine adapters, rather
// than copying its scheduling rules into the test. This is Node/JS evidence;
// it is not execution of QuickJS/V8 native providers, WASM or a browser.
async function engineTimers(engine, clock) {
  const adapter = await readFile(new URL(`../crates/container-engine-${engine}/src/lib.rs`, import.meta.url), 'utf8')
  assert.ok(adapter.includes('timer-tasks.js'), `${engine} uses the shared scheduling source`)
  const text = await readFile(new URL('../crates/container-core/src/timer-tasks.js', import.meta.url), 'utf8')
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
      if (request.op === 'render.commit') { calls.frameId = request.payload.frameId; calls.renderRevision += 1n }
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
    render_frame_json() { return JSON.stringify({ frame_id: calls.frameId, viewport: { width: 1, height: 1 }, root: {} }) }
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

test('Web Unix timer conversion preserves every millisecond and rejects unsafe/u64-overflow observations', async () => {
  const f = await fixture()
  try {
    assert.equal(f.unixTimerNanos(), 1_792_563_456_789_000_000n)
    assert.equal(f.unixTimerNanos(epoch + 1) - f.unixTimerNanos(epoch), 1_000_000n)
    assert.equal(f.unixTimerNanos(0), 0n)
    const largestMillis = Number(0xffff_ffff_ffff_ffffn / 1_000_000n)
    assert.equal(f.unixTimerNanos(largestMillis), BigInt(largestMillis) * 1_000_000n)
    for (const invalid of [-1, NaN, Infinity, 0.5, '123', 1n, Number.MAX_SAFE_INTEGER + 1, largestMillis + 1]) {
      assert.throws(() => f.unixTimerNanos(invalid), /ERR_ENGINE/)
    }
  } finally { f.session.close() }
  assert.equal(f.raf.size, 0)
})

for (const engine of ['quickjs', 'v8']) {
  test(`${engine} timer JS: RAF pump fires epoch deadline once, redraws only callbacks, and frees its owner`, async () => {
    const f = await fixture(engine)
    try {
      assert.equal(f.calls.renders, 1)
      f.frame(516)
      f.clock.now += 24
      f.frame(100_000_000)
      assert.deepEqual(f.calls.callbacks, [])
      assert.equal(f.calls.renders, 1)
      f.clock.now += 1
      f.frame(0)
      assert.deepEqual(f.calls.callbacks, ['startup'])
      assert.equal(f.calls.renders, 2)
      assert.equal(f.calls.polls.at(-1), BigInt(epoch + 25) * 1_000_000n)
      f.frame(999)
      assert.deepEqual(f.calls.callbacks, ['startup'])
      assert.equal(f.calls.renders, 2)
    } finally { f.session.close() }
    assert.equal(f.raf.size, 0)
    assert.equal(f.calls.unloaded, 1)
    assert.equal(f.calls.freed, 1)
  })

  test(`${engine} timer JS: rollback, delayed delivery, interval and cancellation use current wall time`, async () => {
    const f = await fixture(engine)
    try {
      const repeated = f.timers.schedule(() => f.calls.callbacks.push('interval'), 10, true)
      const cancelled = f.timers.schedule(() => f.calls.callbacks.push('cancelled'), 5, false)
      assert.equal(f.timers.cancel(cancelled), true)
      f.clock.now -= 1000
      f.frame(1_000_000)
      assert.deepEqual(f.calls.callbacks, [])
      f.clock.now = epoch + 1000 // Frame arrived late after a paused/background browser.
      f.frame(1)
      assert.deepEqual(f.calls.callbacks, ['interval', 'startup'])
      f.clock.now += 9
      f.frame(2)
      assert.deepEqual(f.calls.callbacks, ['interval', 'startup'])
      f.clock.now += 1
      f.frame(3)
      assert.deepEqual(f.calls.callbacks, ['interval', 'startup', 'interval'])
      assert.equal(f.timers.cancel(repeated), true)
      f.clock.now += 1000
      f.frame(4)
      assert.deepEqual(f.calls.callbacks, ['interval', 'startup', 'interval'])
    } finally { f.session.close() }
    assert.equal(f.raf.size, 0)
  })
}

test('invalid Web clock closes the session before WASM polling and records ERR_ENGINE', async () => {
  const f = await fixture()
  try {
    f.clock.now = -1
    f.frame(516)
    assert.equal(f.calls.polls.length, 0)
    assert.equal(f.session.closed, true)
    assert.equal(f.raf.size, 0)
    assert.equal(f.batches.find(batch => batch.error)?.error.code, 'ERR_ENGINE')
  } finally { f.session.close() }
  assert.equal(f.calls.unloaded, 1)
  assert.equal(f.calls.freed, 1)
})

test('CanvasKit submission acknowledges the exact renderer token and next RAF renders ready effects even with an empty timer batch', async () => {
  const f = await fixture()
  try {
    const presented = []
    f.session.presenter = { submit(frame) {
      f.calls.order.push('flush')
      presented.push(frame.frame_id)
      return { backend: 'canvaskit-webgl2', frameId: frame.frame_id, gpuSurface: true }
    }, dispose() {} }
    f.calls.ackEffect = () => {
      f.calls.ackEffect = null
      f.calls.viewRevision += 1n
      f.calls.ackBatch = { messages: [{ op: 'data.patch.batch', kind: 'event', payload: { data: { ready: true } } }] }
    }
    f.session.render()
    assert.deepEqual(f.calls.order, ['flush', 'ack'])
    assert.equal(f.session.presentation.renderRevision, f.calls.renderRevision.toString())
    assert.equal(f.session.presentation.gpuCompletion, 'not-waited')
    assert.ok(f.batches.some(batch => batch.messages?.some(message => message.op === 'data.patch.batch')))
    f.calls.ackBatch = null
    f.frame(16)
    assert.equal(presented.length, 2, 'onReady data is drawn even without a later timer event')
    f.frame(32)
    assert.equal(presented.length, 2, 'stable frames do not repeatedly execute View expressions')
    assert.equal(f.calls.renders, 1, 'external presentation never requests a software snapshot')
  } finally { f.session.close() }
  assert.equal(f.raf.size, 0)
})

test('CanvasKit submit failure retains the receipt and advances business timers without automatic retries', async () => {
  const f = await fixture()
  try {
    const before = f.session.presentation
    let attempts = 0
    f.session.presenter = { submit() { attempts += 1; throw new Error('ERR_RENDER: flush failed') }, dispose() {} }
    assert.throws(() => f.session.render(), /flush failed/)
    assert.equal(f.calls.acknowledgements.length, 0)
    assert.equal(f.session.presentation, before)
    assert.equal(f.session.suspended, true)
    assert.equal(f.raf.size, 1)
    f.clock.now += 25
    f.frame(16)
    assert.deepEqual(f.calls.callbacks, ['startup'])
    assert.equal(f.calls.polls.length, 1)
    assert.equal(attempts, 1, 'business timer events must not retry a failed presenter')
    assert.equal(f.session.closed, false)
    assert.equal(f.session.presentation, before)
    f.calls.viewRevision += 1n
    f.frame(32)
    assert.equal(attempts, 1, 'dirty state must not trigger a retry while suspended')
    assert.throws(() => f.session.request('event.batch', { events: [] }), /presentation failed/)
    f.session.visibility()
    assert.equal(f.calls.requests.at(-1).op, 'app.lifecycle', 'lifecycle continues while input is suspended')
    f.session.request('api.call', { api: 'getSystemInfoSync' })
    assert.equal(f.calls.requests.at(-1).op, 'api.call', 'non-input bridge work remains available')

    f.session.presenter.submit = frame => { attempts += 1; return { backend: 'canvaskit-webgl2', frameId: frame.frame_id } }
    f.session.render()
    assert.equal(attempts, 2, 'explicit render retries the presenter')
    assert.equal(f.session.suspended, false)
    assert.equal(f.calls.acknowledgements.length, 1)
    f.session.request('event.batch', { events: [] })
    assert.equal(f.raf.size, 1, 'recovery retains a single timer pump')
  } finally { f.session.close() }
  assert.equal(f.raf.size, 0)
})

for (const engine of ['quickjs', 'v8']) {
  test(`${engine} timer JS: automatic redraw failure keeps the timer clock running until explicit recovery`, async () => {
    const f = await fixture(engine)
    try {
      let attempts = 0
      f.session.presenter = { submit() { attempts += 1; throw new Error('ERR_RENDER: lost context') }, dispose() {} }
      const interval = f.timers.schedule(() => f.calls.callbacks.push('interval'), 10, true)
      f.clock.now += 10
      f.frame(16)
      assert.equal(attempts, 1)
      assert.equal(f.session.suspended, true)
      assert.equal(f.session.closed, false)
      assert.equal(f.batches.find(batch => batch.error)?.error.code, 'ERR_RENDER')
      f.clock.now += 10
      f.frame(32)
      f.clock.now += 10
      f.frame(48)
      assert.deepEqual(f.calls.callbacks, ['interval', 'interval', 'startup', 'interval'])
      assert.equal(attempts, 1)
      assert.equal(f.calls.acknowledgements.length, 0)
      assert.equal(f.timers.cancel(interval), true)
      f.clock.now = -1
      f.frame(64)
      assert.equal(f.session.closed, true, 'a runtime clock failure still closes the faulty session')
      assert.equal(f.raf.size, 0)
    } finally { f.session.close() }
  })
}

test('errors produced by presentation callbacks remain visible and suspend subsequent input', async () => {
  const f = await fixture()
  try {
    f.session.presenter = { submit(frame) { return { backend: 'canvaskit-webgl2', frameId: frame.frame_id } }, dispose() {} }
    f.calls.ackBatch = { messages: [{ kind: 'event', op: 'error',
      payload: { committed: true, error: { code: 'ERR_ENGINE', message: 'onReady failed' } } }] }
    assert.throws(() => f.session.render(), error => error.code === 'ERR_ENGINE' && error.message === 'onReady failed')
    assert.equal(f.calls.acknowledgements.length, 1)
    assert.ok(f.batches.some(batch => batch.messages?.some(message => message.op === 'error')))
    assert.equal(f.session.suspended, true)
    assert.throws(() => f.session.request('event.batch', { events: [] }), /presentation failed/)
  } finally { f.session.close() }
})
