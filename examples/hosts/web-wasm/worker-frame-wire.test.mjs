import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageChannel } from 'node:worker_threads'
import { once } from 'node:events'
import { packWorkerFrameWire, unpackWorkerFrameWire, workerFrameResponseLimits, WORKER_FRAME_WIRE_LIMITS as limits } from './worker-frame-wire.mjs'
import { packHostApiWire, unpackHostApiWire } from './host-api-binary-wire.mjs'
import { measureWorkerPayload } from './worker-session-client.mjs'
const image = (width = 320, height = 320) => ({ width, height,
  pixels: Array.from({ length: width * height * 4 }, (_, index) => index % 256) })
const payload = resource => ({ status: 'ok', result: { frame: { frame_id: 7,
  viewport: { x: 0, y: 0, width: 375, height: 667 }, images: { 'weapp-owned-canvas:1': resource } },
  renderRevision: '9007199254740993', viewRevision: '4',
  scheduling: Object.freeze({ consumedInput: Object.freeze({ templateRevision: '4' }) }),
  observation: Object.freeze({ version: '1.0', sequence: '9' }) } })
const resource = value => value.result.frame.images['weapp-owned-canvas:1']

test('native frame metadata uses its finite response budget while generic host API budgets stay independent', () => {
  const source = payload(image(1, 1))
  source.result.frame.root = { id: 'root', children: Array.from({ length: 400 }, (_, id) => ({ id: String(id), children: [],
    computed_style: Object.fromEntries(Array.from({ length: 40 }, (_, key) => [`property${key}`, 'accepted-style'])) })) }
  const packed = packWorkerFrameWire('frame', source)
  assert.throws(() => packHostApiWire(packed.value), /node or depth budget/)
  const responseLimits = workerFrameResponseLimits('frame', packed.value)
  assert.equal(responseLimits.maxNodes, 131072)
  const wire = packHostApiWire(packed.value, responseLimits)
  assert.ok(measureWorkerPayload(wire.value, { ...responseLimits, transfers: packed.transfer }) < 16 * 1024 * 1024)
  assert.deepEqual(unpackHostApiWire(wire.value, responseLimits), packed.value)
  for (const op of ['native.complete', 'bridge', 'state']) {
    assert.deepEqual(workerFrameResponseLimits(op, packed.value), {})
    assert.throws(() => packHostApiWire(packed.value, workerFrameResponseLimits(op, packed.value)), /node or depth budget/)
  }
  assert.throws(() => packHostApiWire(packed.value, workerFrameResponseLimits('frame', packed.value, { maxFrameNodes: 1000 })), /node or depth budget/)
  source.result.frame.root.children = Array.from({ length: 3000 }, (_, id) => ({ id: String(id), children: [], fields: Array(50).fill(0) }))
  assert.throws(() => packHostApiWire(source, workerFrameResponseLimits('frame', source)), /node or depth budget/)
})

test('native RGBA crosses real MessagePorts with exact bytes and ordinary metadata limits intact', async () => {
  const source = payload(image()), snapshot = JSON.stringify(source)
  assert.throws(() => measureWorkerPayload(source), /node budget/)
  const packed = packWorkerFrameWire('frame.current', source), hostApi = packHostApiWire(packed.value)
  assert.equal(hostApi.value, packed.value)
  assert.equal(packed.transfer.length, 1)
  assert.ok(measureWorkerPayload(hostApi.value, { transfers: packed.transfer }) < 420000)
  assert.equal(packed.value.result.scheduling, source.result.scheduling)
  assert.equal(packed.value.result.observation, source.result.observation)
  assert.equal(Object.isFrozen(packed.value.result.scheduling), true)
  const { port1, port2 } = new MessageChannel()
  try {
    const arrived = once(port2, 'message')
    port1.postMessage(hostApi.value, packed.transfer)
    assert.equal(packed.transfer[0].byteLength, 0)
    const [wire] = await arrived
    const result = unpackWorkerFrameWire('frame.current', unpackHostApiWire(wire))
    assert.ok(resource(result).pixels instanceof Uint8Array)
    assert.deepEqual(Array.from(resource(result).pixels), resource(source).pixels)
    assert.equal(result.result.renderRevision, source.result.renderRevision)
    assert.deepEqual(result.result.scheduling, source.result.scheduling)
    assert.deepEqual(result.result.observation, source.result.observation)
    assert.equal(JSON.stringify(source), snapshot)
  } finally { port1.close(); port2.close() }
})

test('failed real post can retry without detaching or changing caller frame buffers', async () => {
  const original = image(64, 64), backing = new Uint8Array(original.pixels.length + 8).fill(99)
  backing.set(original.pixels, 4); original.pixels = backing.subarray(4, backing.length - 4)
  const source = payload(original), expected = original.pixels.slice(), first = packWorkerFrameWire('frame', source)
  const { port1, port2 } = new MessageChannel()
  try {
    assert.throws(() => port1.postMessage(first.value, [...first.transfer, ...first.transfer]), /duplicate|already listed/)
    assert.equal(original.pixels.buffer.byteLength, expected.byteLength + 8)
    assert.equal(backing[0], 99); assert.equal(backing.at(-1), 99)
    assert.deepEqual(original.pixels, expected)
    const retry = packWorkerFrameWire('frame', source), arrived = once(port2, 'message')
    assert.notEqual(retry.transfer[0], first.transfer[0])
    port1.postMessage(retry.value, retry.transfer)
    const [wire] = await arrived
    assert.deepEqual(resource(unpackWorkerFrameWire('frame', wire)).pixels, expected)
    assert.equal(first.transfer[0].byteLength, expected.byteLength)
    assert.deepEqual(original.pixels, expected)
  } finally { port1.close(); port2.close() }
})

test('packing frozen callers changes only frame image ancestors and preserves frozen proof identities', () => {
  const source = payload(image(1, 1))
  for (const value of [resource(source).pixels, resource(source), source.result.frame.images,
    source.result.frame, source.result, source]) Object.freeze(value)
  const packed = packWorkerFrameWire('surface.recover', source)
  assert.notEqual(packed.value, source)
  assert.equal(Object.isFrozen(packed.value), true)
  assert.equal(Object.isFrozen(packed.value.result.frame.images), true)
  assert.equal(packed.value.result.scheduling, source.result.scheduling)
  assert.equal(packed.value.result.frame.viewport, source.result.frame.viewport)
  assert.deepEqual(resource(source).pixels, [0, 1, 2, 3])
})

test('only frame export operations convert their native image field; unrelated large arrays still fail', () => {
  for (const op of ['bridge', 'native.take', 'state', 'load']) {
    const source = payload(image()), packed = packWorkerFrameWire(op, source)
    assert.equal(packed.value, source); assert.deepEqual(packed.transfer, [])
    assert.throws(() => packHostApiWire(packed.value), /ordinary.*node budget/)
  }
  const source = payload(image(1, 1)); source.result.frame.unrelated = Array(20000).fill(0)
  assert.throws(() => packHostApiWire(packWorkerFrameWire('frame', source).value), /ordinary.*node budget/)
  const ordinary = { status: 'error', error: { code: 'ERR_RENDER', message: 'failed', frame: image() } }
  assert.equal(packWorkerFrameWire('frame', ordinary).value, ordinary)
})

test('malformed dimensions, resources, byte values, holes and getters reject without executing accessors', () => {
  let called = 0
  const getter = [0, 1, 2, 3]; Object.defineProperty(getter, '1', { get() { called++; return 1 }, enumerable: true })
  const hidden = [0, 1, 2, 3]; Object.defineProperty(hidden, 'hidden', { value: 1 })
  const bad = [
    { width: 0, height: 1, pixels: [] }, { width: 1.5, height: 1, pixels: [] },
    { width: 8193, height: 1, pixels: [] }, { width: 1, height: 1, pixels: [0, 1, 2] },
    { width: 1, height: 1, pixels: [0, 1, 2, 256] }, { width: 1, height: 1, pixels: new Array(4) },
    { width: 1, height: 1, pixels: getter }, { width: 1, height: 1, pixels: hidden },
    { width: 1, height: 1, pixels: new Uint16Array(4) },
    { width: 1, height: 1, pixels: [0, 1, 2, 3], extra: 1 },
  ]
  for (const value of bad) for (const transform of [packWorkerFrameWire, unpackWorkerFrameWire])
    assert.throws(() => transform('frame', payload(value)), error => error.code === 'ERR_RPC_PROTOCOL')
  const value = image(1, 1); Object.defineProperty(value, 'width', { enumerable: true, get() { called++; return 1 } })
  assert.throws(() => packWorkerFrameWire('frame', payload(value)), /data fields/)
  assert.equal(called, 0)
  assert.throws(() => unpackWorkerFrameWire('frame', payload({ width: 1, height: 1,
    pixels: new Uint8Array(8).subarray(2, 6) })), /complete exact backing/)
})

test('image count, dimensions, total bytes and attached non-shared full backings stay finite', () => {
  assert.equal(Object.isFrozen(limits), true)
  const oversized = payload({ width: 8192, height: 2049, pixels: [] })
  assert.throws(() => packWorkerFrameWire('frame', oversized), /pixel limit/)
  const channelOverflow = payload({ width: 8192, height: 513, pixels: [] })
  assert.throws(() => packWorkerFrameWire('frame', channelOverflow), /bounded Worker channel/)
  const many = payload(image(1, 1)); many.result.frame.images = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`image:${i}`, image(1, 1)]))
  assert.throws(() => packWorkerFrameWire('frame', many), /resource limit/)
  const detached = new Uint8Array(4); structuredClone(detached, { transfer: [detached.buffer] })
  for (const bytes of [detached, new Uint8Array(new SharedArrayBuffer(4))])
    assert.throws(() => unpackWorkerFrameWire('frame', payload({ width: 1, height: 1, pixels: bytes })), /attached non-shared/)
})

test('blank frames and non-frame successful/failure payloads retain exact identities', () => {
  for (const source of [{ status: 'ok', result: {} }, { status: 'ok', result: { frame: { images: {} } } },
    { status: 'error', error: { code: 'ERR_RENDER', message: 'x' } }]) {
    assert.equal(packWorkerFrameWire('frame', source).value, source)
    assert.equal(unpackWorkerFrameWire('frame.current', source), source)
  }
})
