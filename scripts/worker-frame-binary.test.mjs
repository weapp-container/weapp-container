import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeNativeFrameBinary, packWorkerFrameWire, unpackWorkerFrameWire } from '../examples/hosts/web-wasm/worker-frame-wire.mjs'

function encode(images, pixels) {
  const metadata = new TextEncoder().encode(JSON.stringify({ frame_id: 7, viewport: { width: 10, height: 20 },
    root: { id: 'root', children: [] }, images }))
  const bytes = new Uint8Array(8 + metadata.length + pixels.length)
  bytes.set([87, 67, 70, 49]); new DataView(bytes.buffer).setUint32(4, metadata.length, true)
  bytes.set(metadata, 8); bytes.set(pixels, 8 + metadata.length)
  return bytes
}

test('binary native frames preserve exact pixels through transfer without detaching native storage', () => {
  const original = encode({ a: { width: 1, height: 1, offset: 4, length: 4 },
    b: { width: 1, height: 1, offset: 0, length: 4 } }, [1, 2, 3, 255, 5, 6, 7, 128])
  const frame = decodeNativeFrameBinary(original)
  const packed = packWorkerFrameWire('frame', { status: 'ok', result: { frame, renderRevision: '11' } })
  const received = unpackWorkerFrameWire('frame', structuredClone(packed.value, { transfer: packed.transfer }))
  assert.deepEqual([...received.result.frame.images.a.pixels], [5, 6, 7, 128])
  assert.deepEqual([...received.result.frame.images.b.pixels], [1, 2, 3, 255])
  assert.equal(received.result.renderRevision, '11')
  assert.equal(original.byteLength > 8, true)
  assert.equal(packed.transfer.every(buffer => buffer.byteLength === 0), true)
})

for (const [name, images, pixels] of [
  ['overlap', { a: { width: 1, height: 1, offset: 0, length: 4 }, b: { width: 1, height: 1, offset: 0, length: 4 } }, Array(8).fill(0)],
  ['truncated', { a: { width: 1, height: 1, offset: 0, length: 4 } }, [0, 1]],
  ['unclaimed', {}, [0]],
  ['dimension mismatch', { a: { width: 2, height: 1, offset: 0, length: 4 } }, Array(4).fill(0)],
]) test(`binary frame rejects ${name} before presentation`, () => {
  assert.throws(() => decodeNativeFrameBinary(encode(images, pixels)), { code: 'ERR_RPC_PROTOCOL' })
})

test('typed byte lane never reads expando getters and always copies exact bytes', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  Object.defineProperty(bytes, 'extra', { enumerable: true, get() { throw new Error('not pixel data') } })
  const packed = packWorkerFrameWire('frame', { status: 'ok', result: { frame: {
    images: { a: { width: 1, height: 1, pixels: bytes } } } } })
  assert.deepEqual([...packed.value.result.frame.images.a.pixels], [1, 2, 3, 4])
  assert.notEqual(packed.value.result.frame.images.a.pixels.buffer, bytes.buffer)
})
