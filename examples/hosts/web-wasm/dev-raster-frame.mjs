// The binary v2 wire format is independent from browser owner admission.
// Successful decoding never grants input or acknowledges presentation.
const maximumU64 = '18446744073709551615'
const maximumMetadataBytes = 4096
const maximumPixelBytes = 16 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const sessionDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const targetFields = ['sessionId', 'previewId', 'previewGeneration', 'frameId', 'sourceFrameId', 'renderRevision', 'configGeneration', 'logicalWidth', 'logicalHeight', 'width', 'height']
const headerFields = ['schemaVersion', 'protocolVersion', 'sessionId', 'frameId', 'sourceFrameId', 'renderRevision', 'configGeneration', 'logicalWidth', 'logicalHeight', 'width', 'height', 'stride', 'format', 'byteLength', 'renderMs', 'url', 'presentationTicket']
const sharedFields = ['sessionId', 'frameId', 'sourceFrameId', 'renderRevision', 'configGeneration', 'logicalWidth', 'logicalHeight', 'width', 'height']

const invalid = message => Object.assign(new Error(message), { code: 'ERR_PROTOCOL_VERSION' })
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
const integer = (value, maximum) => Number.isInteger(value) && value > 0 && value <= maximum
const validSession = value => typeof value === 'string' && value.length > 0
  && encoder.encode(value).byteLength <= 256 && sessionDecoder.decode(encoder.encode(value)) === value

/** Compare canonical u64 strings without converting identities to Number. */
export function compareRasterU64(left, right) {
  for (const value of [left, right]) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)
      || (value.length === 20 && value > maximumU64)) throw invalid('invalid canonical Raster u64')
  }
  return left.length === right.length ? (left === right ? 0 : left < right ? -1 : 1) : left.length < right.length ? -1 : 1
}

function u64(value, positive = false) {
  compareRasterU64(value, value)
  if (positive && value === '0') throw invalid('Raster identity must be positive')
}

/** Validate and copy a wire ticket into immutable metadata. This checks only
 * its shape: the runtime and actual SSE owner still decide its authority. */
export function validateDevRasterTicket(value) {
  if (!exact(value, ['version', 'presentationEpoch', 'target']) || value.version !== '1.0'
    || !exact(value.target, targetFields)) throw invalid('invalid Raster presentation ticket')
  const target = value.target
  u64(value.presentationEpoch, true)
  if (!validSession(target.sessionId) || typeof target.previewId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(target.previewId)) throw invalid('invalid Raster presentation identity')
  for (const field of ['previewGeneration', 'frameId', 'renderRevision', 'configGeneration']) u64(target[field], true)
  u64(target.sourceFrameId)
  for (const field of ['logicalWidth', 'logicalHeight']) {
    if (!integer(target[field], 0xffffffff)) throw invalid('invalid Raster logical dimensions')
  }
  for (const field of ['width', 'height']) {
    if (!integer(target[field], 4096)) throw invalid('invalid Raster physical dimensions')
  }
  if (target.width * target.height * 4 > maximumPixelBytes) throw invalid('Raster frame exceeds the pixel budget')
  return Object.freeze({ version: value.version, presentationEpoch: value.presentationEpoch, target: Object.freeze({ ...target }) })
}

export function sameDevRasterTicket(left, right) {
  const a = validateDevRasterTicket(left), b = validateDevRasterTicket(right)
  return a.version === b.version && a.presentationEpoch === b.presentationEpoch
    && targetFields.every(field => a.target[field] === b.target[field])
}

/** Decode one complete application/vnd.weapp.frame.v2 response body.
 * Pixels borrow the supplied buffer; no full-frame conversion or copy occurs.
 * Metadata is frozen, while the pixel view remains writable for Canvas APIs.
 */
export function decodeDevRasterFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4
    || buffer.byteLength > 4 + maximumMetadataBytes + maximumPixelBytes) throw invalid('invalid binary Raster frame length')
  const length = new DataView(buffer).getUint32(0, true)
  if (length === 0 || length > maximumMetadataBytes || length > buffer.byteLength - 4) throw invalid('invalid Raster metadata length')
  let header
  try { header = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, length))) }
  catch { throw invalid('invalid UTF-8 JSON Raster metadata') }
  if (!exact(header, headerFields) || header.schemaVersion !== 2 || header.protocolVersion !== '2.0'
    || header.format !== 'rgba8' || header.url !== '/api/frame'
    || !Number.isFinite(header.renderMs) || header.renderMs < 0) throw invalid('invalid Raster v2 metadata')
  const ticket = validateDevRasterTicket(header.presentationTicket)
  if (sharedFields.some(field => header[field] !== ticket.target[field])
    || header.stride !== header.width * 4 || header.byteLength !== header.width * header.height * 4
    || buffer.byteLength !== 4 + length + header.byteLength) throw invalid('Raster frame and presentation ticket differ')
  return Object.freeze({ ...header, presentationTicket: ticket, pixels: new Uint8ClampedArray(buffer, 4 + length, header.byteLength) })
}
