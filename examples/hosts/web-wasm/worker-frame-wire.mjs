// Native RenderFrame ImageResource.pixels is tightly packed, straight RGBA8.
// Only frame exports use this typed lane. Ordinary JSON arrays and host API
// binary markers retain their existing independent budgets and semantics.
export const WORKER_FRAME_WIRE_LIMITS = Object.freeze({ maxImages: 1024, maxDimension: 8192,
  maxImageBytes: 64 * 1024 * 1024, maxFrameBytes: 128 * 1024 * 1024,
  maxTransferBytes: 16 * 1024 * 1024, maxMetadataNodes: 131072 })
const FRAME_OPS = new Set(['frame', 'frame.current', 'surface.recover'])
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const invalid = message => fail('ERR_RPC_PROTOCOL', message)
const limited = message => fail('ERR_RPC_PAYLOAD_TOO_LARGE', message)
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag).get
const typedBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get
const typedLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get
const typedOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset').get
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function data(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return undefined
  if (!descriptor.enumerable || !own(descriptor, 'value')) invalid('frame wire requires enumerable data fields')
  return descriptor.value
}
function replace(value, key, next) {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  descriptors[key] = { ...descriptors[key], value: next }
  const result = Object.defineProperties(Object.create(Object.getPrototypeOf(value)), descriptors)
  return Object.isFrozen(value) ? Object.freeze(result) : result
}
function pixels(value, size, packing) {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertyDescriptor(value, 'length').value !== size
      || Reflect.ownKeys(value).length !== size + 1) invalid('frame RGBA requires dense exact byte arrays')
    // Validate before allocating a transferable backing; never invoke getters.
    for (let index = 0; index < size; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index)), byte = descriptor?.value
      if (!descriptor?.enumerable || !own(descriptor, 'value') || !Number.isInteger(byte) || byte < 0 || byte > 255)
        invalid('frame RGBA requires integer bytes without holes or accessors')
    }
    return packing ? Uint8Array.from(value) : value
  }
  let buffer, length, offset, backingLength
  try {
    if (typedTag.call(value) !== 'Uint8Array') invalid('frame RGBA requires Uint8Array bytes')
    buffer = typedBuffer.call(value); length = typedLength.call(value); offset = typedOffset.call(value)
    backingLength = bufferLength.call(buffer)
    new Uint8Array(buffer, 0, 0)
  } catch { invalid('frame RGBA requires attached non-shared Uint8Array bytes') }
  if (length !== size || (!packing && (offset !== 0 || backingLength !== size))
    ) invalid('frame RGBA bytes must own their complete exact backing')
  // Indexed Uint8Array bytes are intrinsically dense u8 values. Enumerating
  // their millions of index properties creates an avoidable per-frame object
  // storm. Non-index expandos are not part of this binary lane and never read.
  // Always copy: postMessage may detach only this wire's backing, including
  // when caller pixels are a subview of a larger backing or a frame is retried.
  return packing ? new Uint8Array(value) : value
}
function convert(op, payload, packing) {
  const transfer = []
  if (!FRAME_OPS.has(op) || !plain(payload) || data(payload, 'status') !== 'ok') return { value: payload, transfer }
  const result = data(payload, 'result')
  if (!plain(result)) return { value: payload, transfer }
  const frame = data(result, 'frame')
  if (frame === undefined) return { value: payload, transfer }
  // The generic RPC client also carries legacy/test frame receipts. Only an
  // actual image table enters this lane; ordinary payload validation remains
  // responsible for everything else and adapters validate their RenderFrame.
  if (!plain(frame)) return { value: payload, transfer }
  const images = data(frame, 'images')
  if (images === undefined) return { value: payload, transfer }
  if (!plain(images)) invalid('frame wire requires an image resource table')
  const keys = Reflect.ownKeys(images), limits = WORKER_FRAME_WIRE_LIMITS
  if (keys.length > limits.maxImages) limited('frame image resource limit exceeded')
  let total = 0
  const descriptors = packing && keys.length ? Object.getOwnPropertyDescriptors(images) : null
  for (const id of keys) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256 || /[^A-Za-z0-9._:/-]/.test(id))
      invalid('frame wire image resource id is invalid')
    const image = data(images, id)
    if (!plain(image) || Reflect.ownKeys(image).length !== 3
      || !['width', 'height', 'pixels'].every(key => own(image, key))) invalid('frame wire requires native image resources')
    const width = data(image, 'width'), height = data(image, 'height'), source = data(image, 'pixels')
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= limits.maxDimension))
      invalid('frame wire image dimensions are invalid')
    const size = width * height * 4
    if (size > limits.maxImageBytes) limited('frame image pixel limit exceeded')
    total += size
    if (total > limits.maxFrameBytes || total > limits.maxTransferBytes)
      limited('frame image bytes exceed the bounded Worker channel')
    const bytes = pixels(source, size, packing)
    if (packing) {
      descriptors[id] = { ...descriptors[id], value: replace(image, 'pixels', bytes) }
      transfer.push(bytes.buffer)
    }
  }
  if (!descriptors) return { value: payload, transfer }
  const converted = Object.defineProperties(Object.create(Object.getPrototypeOf(images)), descriptors)
  if (Object.isFrozen(images)) Object.freeze(converted)
  return { value: replace(payload, 'result', replace(result, 'frame', replace(frame, 'images', converted))), transfer }
}
export function packWorkerFrameWire(op, payload) { return convert(op, payload, true) }
export function unpackWorkerFrameWire(op, payload) { return convert(op, payload, false).value }

// A normal native layout tree contains computed style, accepted glyph plans
// and paint commands. Its metadata has an independent finite node ceiling;
// host APIs, events, request payloads and unrelated frame-like objects retain
// the ordinary RPC budget. Bytes, depth and binary caps remain unchanged.
export function workerFrameResponseLimits(op, payload, { maxFrameNodes = WORKER_FRAME_WIRE_LIMITS.maxMetadataNodes, ...limits } = {}) {
  if (!FRAME_OPS.has(op) || !plain(payload) || data(payload, 'status') !== 'ok') return limits
  const result = data(payload, 'result'), frame = plain(result) && data(result, 'frame')
  const root = plain(frame) && data(frame, 'root')
  if (!plain(root) || typeof data(root, 'id') !== 'string' || !Array.isArray(data(root, 'children'))) return limits
  return { ...limits, maxNodes: maxFrameNodes }
}

// WCF1 is produced from the exact accepted Rust frame. Metadata remains JSON;
// pixels stay bytes from WASM through the bounded transferable Worker channel.
export function decodeNativeFrameBinary(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8
    || bytes[0] !== 87 || bytes[1] !== 67 || bytes[2] !== 70 || bytes[3] !== 49)
    invalid('invalid native binary frame header')
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true)
  if (length > 16 * 1024 * 1024 || length > bytes.byteLength - 8)
    limited('native binary frame metadata exceeds its budget')
  let frame
  try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + length))) }
  catch { invalid('invalid native binary frame metadata') }
  if (!plain(frame)) invalid('invalid native binary frame')
  const images = frame.images ?? {}
  if (!plain(images) || Object.keys(images).length > WORKER_FRAME_WIRE_LIMITS.maxImages)
    limited('native binary frame image table exceeds its budget')
  const start = 8 + length, available = bytes.byteLength - start
  if (available > WORKER_FRAME_WIRE_LIMITS.maxTransferBytes)
    limited('native binary frame pixels exceed the bounded Worker channel')
  let consumed = 0
  const ranges = []
  for (const [id, image] of Object.entries(images)) {
    if (!plain(image) || ![image.width, image.height].every(n => Number.isInteger(n) && n > 0 && n <= WORKER_FRAME_WIRE_LIMITS.maxDimension)
      || !Number.isSafeInteger(image.offset) || image.offset < 0
      || image.length !== image.width * image.height * 4 || image.length > WORKER_FRAME_WIRE_LIMITS.maxImageBytes
      || image.offset > available - image.length)
      invalid('invalid native binary image range')
    ranges.push([image.offset, image.offset + image.length])
    consumed += image.length
    images[id] = { width: image.width, height: image.height,
      pixels: bytes.subarray(start + image.offset, start + image.offset + image.length) }
  }
  ranges.sort((a, b) => a[0] - b[0])
  let end = 0
  for (const [offset, next] of ranges) {
    if (offset !== end) invalid('native binary image ranges overlap or contain gaps')
    end = next
  }
  if (consumed !== available || end !== available) invalid('native binary frame has unclaimed pixels')
  return frame
}
