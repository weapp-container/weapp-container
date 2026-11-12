import assert from 'node:assert/strict'
import test from 'node:test'
import { compareRasterU64, decodeDevRasterFrame, sameDevRasterTicket, validateDevRasterTicket } from '../examples/hosts/web-wasm/dev-raster-frame.mjs'

function metadata() {
  const target = { sessionId: 'session-a', previewId: 'owner-1', previewGeneration: '1', frameId: '1', sourceFrameId: '0', renderRevision: '1', configGeneration: '1', logicalWidth: 375, logicalHeight: 667, width: 2, height: 1 }
  return { schemaVersion: 2, protocolVersion: '2.0', sessionId: target.sessionId, frameId: target.frameId, sourceFrameId: target.sourceFrameId, renderRevision: target.renderRevision, configGeneration: target.configGeneration, logicalWidth: target.logicalWidth, logicalHeight: target.logicalHeight, width: target.width, height: target.height, stride: 8, format: 'rgba8', byteLength: 8, renderMs: 0.5, url: '/api/frame', presentationTicket: { version: '1.0', presentationEpoch: '1', target } }
}
function encode(header, pixels = new Uint8Array([128, 64, 32, 128, 0, 0, 0, 0])) {
  const json = typeof header === 'string' ? header : JSON.stringify(header), bytes = new TextEncoder().encode(json)
  const buffer = new ArrayBuffer(4 + bytes.length + pixels.length)
  new DataView(buffer).setUint32(0, bytes.length, true)
  new Uint8Array(buffer, 4, bytes.length).set(bytes)
  new Uint8Array(buffer, 4 + bytes.length).set(pixels)
  return buffer
}
const rejects = action => assert.throws(action, { code: 'ERR_PROTOCOL_VERSION' })

test('v2 keeps exact large identities, straight alpha, and the original pixel buffer', () => {
  const header = metadata()
  for (const field of ['frameId', 'sourceFrameId', 'renderRevision', 'configGeneration']) header[field] = header.presentationTicket.target[field] = '18446744073709551615'
  header.presentationTicket.presentationEpoch = '18446744073709551615'
  header.presentationTicket.target.previewGeneration = '18446744073709551615'
  const buffer = encode(header), frame = decodeDevRasterFrame(buffer)
  assert.equal(frame.frameId, '18446744073709551615')
  assert.equal(frame.pixels.buffer, buffer)
  assert.deepEqual([...frame.pixels], [128, 64, 32, 128, 0, 0, 0, 0])
  assert(Object.isFrozen(frame) && Object.isFrozen(frame.presentationTicket) && Object.isFrozen(frame.presentationTicket.target))
  assert.throws(() => { frame.presentationTicket.target.frameId = '2' }, TypeError)
})

test('canonical identity comparisons preserve adjacent values beyond Number precision', () => {
  assert.equal(compareRasterU64('9007199254740992', '9007199254740993'), -1)
  assert.equal(compareRasterU64('18446744073709551615', '18446744073709551614'), 1)
  assert.equal(compareRasterU64('0', '0'), 0)
  for (const value of [1, 1n, null, '', '01', '-1', '+1', '1.0', '1e1', ' 1', '1\n', '18446744073709551616', '9'.repeat(10000)]) rejects(() => compareRasterU64(value, '0'))
})

test('unknown, missing, and incompatible versions fail at every metadata level', () => {
  for (const level of ['header', 'ticket', 'target']) {
    for (const change of ['extra', 'missing']) {
      const header = metadata(), object = level === 'header' ? header : level === 'ticket' ? header.presentationTicket : header.presentationTicket.target
      if (change === 'extra') object.extra = 1
      else delete object[Object.keys(object)[0]]
      rejects(() => decodeDevRasterFrame(encode(header)))
    }
  }
  for (const [field, value] of [['schemaVersion', 1], ['protocolVersion', '2.1'], ['format', 'premul-rgba8'], ['url', '/other'], ['renderMs', -1], ['renderMs', null]]) {
    const header = metadata(); header[field] = value; rejects(() => decodeDevRasterFrame(encode(header)))
  }
})

test('every duplicated frame identity and dimension must equal the nested ticket', () => {
  for (const field of ['sessionId', 'frameId', 'sourceFrameId', 'renderRevision', 'configGeneration', 'logicalWidth', 'logicalHeight', 'width', 'height']) {
    const header = metadata(); header[field] = typeof header[field] === 'string' ? `${header[field]}x` : header[field] + 1
    rejects(() => decodeDevRasterFrame(encode(header)))
  }
  for (const field of ['previewGeneration', 'frameId', 'renderRevision', 'configGeneration']) {
    const header = metadata(); header.presentationTicket.target[field] = '0'; rejects(() => decodeDevRasterFrame(encode(header)))
  }
  assert.equal(decodeDevRasterFrame(encode(metadata())).sourceFrameId, '0', 'source identity zero is not forbidden by the runtime contract')
})

test('session bounds use UTF-8 bytes without trimming or normalizing valid identities', () => {
  for (const value of ['\0'.repeat(256), 'é'.repeat(128), '会'.repeat(85), 'e\u0301', '\uFEFFsession']) {
    const header = metadata(); header.sessionId = header.presentationTicket.target.sessionId = value
    assert.equal(decodeDevRasterFrame(encode(header)).sessionId, value)
  }
  for (const value of ['', 'é'.repeat(129), '会'.repeat(86), '\ud800']) {
    const header = metadata(); header.sessionId = header.presentationTicket.target.sessionId = value
    rejects(() => decodeDevRasterFrame(encode(header)))
  }
  for (const previewId of ['', 'unsafe.id', 'owner:1', 'x'.repeat(129), '会']) {
    const header = metadata(); header.presentationTicket.target.previewId = previewId; rejects(() => decodeDevRasterFrame(encode(header)))
  }
})

test('framing rejects malformed UTF-8, truncation, excess bytes, and bounded-header overflow', () => {
  for (const length of [0, 1, 3]) rejects(() => decodeDevRasterFrame(new ArrayBuffer(length)))
  rejects(() => decodeDevRasterFrame(encode(' '.repeat(4097))))
  const badUtf8 = encode(metadata()); new Uint8Array(badUtf8)[4] = 0xff; rejects(() => decodeDevRasterFrame(badUtf8))
  const emptyHeader = new ArrayBuffer(4); rejects(() => decodeDevRasterFrame(emptyHeader))
  const headerPastEnd = new ArrayBuffer(4); new DataView(headerPastEnd).setUint32(0, 100, true); rejects(() => decodeDevRasterFrame(headerPastEnd))
  const valid = encode(metadata())
  rejects(() => decodeDevRasterFrame(valid.slice(0, -1)))
  const extra = new Uint8Array(valid.byteLength + 1); extra.set(new Uint8Array(valid)); rejects(() => decodeDevRasterFrame(extra.buffer))
  rejects(() => decodeDevRasterFrame(new Uint8Array(valid)))
})

test('physical allocation and byte layout are bounded independently from logical dimensions', () => {
  for (const [field, value] of [['width', 4097], ['height', 0], ['logicalWidth', 0], ['logicalHeight', 0x100000000], ['width', 0.5]]) {
    const header = metadata(); header[field] = header.presentationTicket.target[field] = value; rejects(() => decodeDevRasterFrame(encode(header)))
  }
  const over = metadata(); over.presentationTicket.target.width = over.width = 4096; over.presentationTicket.target.height = over.height = 1025
  rejects(() => validateDevRasterTicket(over.presentationTicket))
  for (const [field, value] of [['stride', 4], ['byteLength', 4]]) {
    const header = metadata(); header[field] = value; rejects(() => decodeDevRasterFrame(encode(header)))
  }
  const maximumLogical = metadata(); maximumLogical.logicalWidth = maximumLogical.presentationTicket.target.logicalWidth = 0xffffffff
  assert.equal(decodeDevRasterFrame(encode(maximumLogical)).logicalWidth, 0xffffffff)
})

test('ticket equality compares every field and frozen copies do not alias caller metadata', () => {
  const original = metadata().presentationTicket, immutable = validateDevRasterTicket(original)
  assert(sameDevRasterTicket(original, immutable))
  original.target.sessionId = 'another'; assert.equal(immutable.target.sessionId, 'session-a')
  assert(!sameDevRasterTicket(original, immutable))
  for (const field of ['presentationEpoch', ...Object.keys(immutable.target)]) {
    const changed = structuredClone(immutable), object = field === 'presentationEpoch' ? changed : changed.target
    object[field] = typeof object[field] === 'number' ? object[field] + 1 : field === 'sessionId' || field === 'previewId' ? 'changed' : '2'
    assert(!sameDevRasterTicket(immutable, changed), field)
  }
})
