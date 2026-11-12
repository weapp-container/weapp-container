/** Reference-fixture frame placement, independent of official image equivalence. */
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const MAX_PIXELS = 16_777_216
const MAX_PNG_BYTES = 64 * 1024 * 1024
const finite = Number.isFinite
const positive = value => finite(value) && value > 0
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function requireInput(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'ERR_REFERENCE_VISUAL_INPUT' })
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function paeth(a, b, c) {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c)
  return da <= db && da <= dc ? a : db <= dc ? b : c
}

/** Strict, bounded decoder for the noninterlaced 8-bit RGB/RGBA adb screencap contract. */
export function decodeAndroidScreenshotPng(input) {
  requireInput(input instanceof Uint8Array, 'Screenshot must be PNG bytes')
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  requireInput(bytes.length >= 57 && bytes.length <= MAX_PNG_BYTES && bytes.subarray(0, 8).equals(SIGNATURE), 'Invalid or oversized PNG screenshot')
  let offset = 8, header, ended = false, idatEnded = false, paletteSeen = false
  const data = []
  while (offset < bytes.length) {
    requireInput(offset + 12 <= bytes.length, 'Truncated PNG chunk')
    const size = bytes.readUInt32BE(offset), start = offset + 8, end = start + size
    requireInput(end + 4 <= bytes.length, 'Truncated PNG chunk payload')
    const typeBytes = bytes.subarray(offset + 4, start)
    requireInput(typeBytes.every(byte => byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122)
      && typeBytes[2] >= 65 && typeBytes[2] <= 90, 'Invalid PNG chunk type or reserved bit')
    const type = typeBytes.toString('ascii')
    requireInput(crc32(bytes.subarray(offset + 4, end)) === bytes.readUInt32BE(end), `PNG ${type} CRC mismatch`)
    requireInput(header || type === 'IHDR', 'PNG must begin with IHDR')
    if (type === 'IHDR') {
      requireInput(!header && size === 13, 'Invalid or repeated PNG IHDR')
      const width = bytes.readUInt32BE(start), height = bytes.readUInt32BE(start + 4)
      const depth = bytes[start + 8], colorType = bytes[start + 9]
      requireInput(width > 0 && height > 0 && width * height <= MAX_PIXELS, 'PNG dimensions exceed screenshot pixel budget')
      requireInput(depth === 8 && [2, 6].includes(colorType) && bytes[start + 10] === 0
        && bytes[start + 11] === 0 && bytes[start + 12] === 0, 'Unsupported PNG format: require noninterlaced 8-bit RGB/RGBA')
      header = { width, height, colorType, channels: colorType === 6 ? 4 : 3 }
    } else if (type === 'PLTE') {
      requireInput(!paletteSeen && !data.length && size > 0 && size <= 768 && size % 3 === 0, 'Invalid, repeated or late PNG PLTE')
      paletteSeen = true
    } else if (type === 'IDAT') {
      requireInput(!idatEnded, 'PNG IDAT chunks must be consecutive')
      data.push(bytes.subarray(start, end))
    } else if (type === 'IEND') {
      requireInput(size === 0 && data.length > 0, 'Invalid PNG IEND or missing IDAT')
      ended = true
      offset = end + 4
      break
    } else {
      if (data.length) idatEnded = true
      requireInput(!['tRNS', 'acTL', 'fcTL', 'fdAT'].includes(type), `Unsupported PNG ${type} screenshot semantics`)
      requireInput(type[0] === type[0].toLowerCase(), `Unsupported critical PNG ${type} chunk`)
    }
    offset = end + 4
  }
  requireInput(ended && offset === bytes.length, 'PNG is incomplete or has trailing bytes')
  const { width, height, channels } = header, stride = width * channels
  const expected = (stride + 1) * height
  let filtered
  try {
    const compressed = Buffer.concat(data)
    const decoded = inflateSync(compressed, { maxOutputLength: expected, info: true })
    requireInput(decoded.engine.bytesWritten === compressed.length, 'PNG has trailing compressed bytes')
    filtered = decoded.buffer
  } catch (error) {
    throw Object.assign(new Error(`Cannot decode PNG screenshot: ${error.message}`), { code: 'ERR_REFERENCE_VISUAL_INPUT' })
  }
  requireInput(filtered.length === expected, 'PNG decoded byte count differs from IHDR')
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)]
    requireInput(filter <= 4, `Unsupported PNG row filter ${filter}`)
    for (let x = 0; x < stride; x += 1) {
      const index = y * stride + x
      const left = x >= channels ? raw[index - channels] : 0
      const above = y ? raw[index - stride] : 0
      const corner = y && x >= channels ? raw[index - stride - channels] : 0
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, corner)
      raw[index] = (filtered[y * (stride + 1) + x + 1] + predictor) & 255
    }
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    raw.copy(rgba, pixel * 4, pixel * channels, pixel * channels + 3)
    rgba[pixel * 4 + 3] = channels === 4 ? raw[pixel * 4 + 3] : 255
  }
  return { width, height, colorType: header.colorType, rgba }
}

const flatten = node => node ? [node, ...(node.children || []).flatMap(flatten)] : []
const color = node => [node.background?.red, node.background?.green, node.background?.blue, node.background?.alpha]
const validColor = value => value.every(component => Number.isInteger(component) && component >= 0 && component <= 255)
const sameColor = (a, b) => a.every((value, index) => value === b[index])
const contains = (box, x, y, margin = 0) => x >= box.x - margin && y >= box.y - margin
  && x < box.x + box.width + margin && y < box.y + box.height + margin

/** Geometry uses actual Surface extent, never density as a substitute for its rounding. */
export function referenceScreenTransform(receipt, image) {
  const viewport = receipt.frame?.viewport, surface = receipt.surface, observed = receipt.windowObservation
  requireInput(viewport && surface && observed, 'Missing viewport, Surface or host window observation')
  requireInput([viewport.x, viewport.y, surface.screenX, surface.screenY].every(finite)
    && [viewport.width, viewport.height, surface.width, surface.height].every(positive), 'Invalid frame/Surface geometry')
  requireInput(image.width === observed.displayWidth && image.height === observed.displayHeight, 'Screenshot dimensions differ from the observed display')
  requireInput(surface.width === observed.surfaceWidth && surface.height === observed.surfaceHeight
    && surface.screenX === observed.surfaceOrigin?.x && surface.screenY === observed.surfaceOrigin?.y, 'Surface observation geometry is inconsistent')
  requireInput(surface.screenX >= 0 && surface.screenY >= 0 && surface.screenX + surface.width <= image.width
    && surface.screenY + surface.height <= image.height, 'Reference Surface is not fully visible in the OS screenshot')
  return { x: surface.screenX, y: surface.screenY, scaleX: surface.width / viewport.width,
    scaleY: surface.height / viewport.height, viewportX: viewport.x, viewportY: viewport.y,
    width: surface.width, height: surface.height }
}

function project(bounds, transform) {
  requireInput(bounds && [bounds.x, bounds.y].every(finite) && [bounds.width, bounds.height].every(positive), 'Invalid reference anchor bounds')
  return { x: transform.x + (bounds.x - transform.viewportX) * transform.scaleX,
    y: transform.y + (bounds.y - transform.viewportY) * transform.scaleY,
    width: bounds.width * transform.scaleX, height: bounds.height * transform.scaleY }
}

function matches(image, x, y, expected) {
  const index = (y * image.width + x) * 4
  return image.rgba[index + 3] >= 252 && Math.abs(expected[0] - image.rgba[index]) <= 3
    && Math.abs(expected[1] - image.rgba[index + 1]) <= 3 && Math.abs(expected[2] - image.rgba[index + 2]) <= 3
}

function scanColorBounds(image, area, expected) {
  let left = image.width, top = image.height, right = -1, bottom = -1, pixels = 0
  for (let y = Math.ceil(area.y); y < Math.floor(area.y + area.height); y += 1) {
    for (let x = Math.ceil(area.x); x < Math.floor(area.x + area.width); x += 1) {
      if (!matches(image, x, y, expected)) continue
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); pixels += 1
    }
  }
  return pixels ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1, pixels } : null
}

/**
 * Consume untouched adb PNG bytes plus its correlated committed receipt.
 * A pass is only this reference fixture's background placement contract.
 * Text is excluded from samples; no image baseline is synthesized or compared.
 */
export function inspectAndroidReferenceVisual({ png, receipt, label = 'reference' }) {
  requireInput(receipt?.schemaVersion === 1 && receipt.status === 'ready' && receipt.page?.route === 'pages/home/index', 'Require a ready reference-fixture receipt')
  requireInput(typeof receipt.sessionId === 'string' && receipt.sessionId.length > 0 && receipt.surface?.backend === 'skia-gpu-gles'
    && Number.isSafeInteger(receipt.frame?.frame_id) && receipt.frame.frame_id > 0
    && receipt.surface.presentedFrameId === receipt.frame.frame_id, 'Reference receipt does not identify the presented frame')
  const image = decodeAndroidScreenshotPng(png), transform = referenceScreenTransform(receipt, image)
  const root = receipt.frame.root, all = flatten(root), findings = [], anchors = []
  requireInput(root?.tag === 'page', 'Missing reference page render root')
  const choose = name => {
    const candidates = all.filter(node => node.classes?.includes(name))
    requireInput(candidates.length === 1, `Require exactly one reference .${name} anchor`)
    return candidates[0]
  }
  const selected = [['page', root], ['card', choose('card')], ['component-panel', choose('component-panel')]]
  const colors = selected.map(([, node]) => color(node))
  requireInput(colors.every(validColor) && colors.every(value => value[3] === 255)
    && selected.every(([, node]) => node.opacity === 1), 'Reference anchors require opaque rendered colors')
  requireInput(colors.every((value, index) => colors.every((other, second) => index === second
    || Math.max(...value.slice(0, 3).map((channel, i) => Math.abs(channel - other[i]))) > 3)), 'Reference colors are not distinct enough for geometry anchors')
  for (const [name, node] of selected) {
    const expectedColor = color(node), expected = project(node.bounds, transform)
    requireInput(expected.x >= transform.x && expected.y >= transform.y
      && expected.x + expected.width <= transform.x + transform.width + 0.01
      && expected.y + expected.height <= transform.y + transform.height + 0.01, `Reference ${name} anchor is clipped in the committed frame`)
    const blockers = all.filter(other => other !== node && (typeof other.text === 'string' && other.text.length > 0
      || validColor(color(other)) && color(other)[3] > 0 && !sameColor(color(other), expectedColor)))
      // Ancestor backgrounds paint before this anchor and cannot occlude it.
      .filter(other => !flatten(other).includes(node)).map(other => project(other.bounds, transform))
    const inset = Math.max(4, Math.min(expected.width, expected.height) * 0.1)
    let samples = 0, matched = 0
    for (let row = 0; row < 19; row += 1) {
      for (let column = 0; column < 19; column += 1) {
        const x = Math.floor(expected.x + inset + (expected.width - 2 * inset) * (column + 0.5) / 19)
        const y = Math.floor(expected.y + inset + (expected.height - 2 * inset) * (row + 0.5) / 19)
        if (blockers.some(box => contains(box, x, y, 4))) continue
        samples += 1
        if (matches(image, x, y, expectedColor)) matched += 1
      }
    }
    requireInput(samples >= 12, `Insufficient unobscured ${name} background samples`)
    const observed = scanColorBounds(image, transform, expectedColor)
    const edgeDelta = observed ? { left: observed.x - expected.x, top: observed.y - expected.y,
      right: observed.x + observed.width - expected.x - expected.width,
      bottom: observed.y + observed.height - expected.y - expected.height } : null
    const boundsPassed = edgeDelta && Object.values(edgeDelta).every(value => Math.abs(value) <= 4)
    const samplesPassed = matched / samples >= 0.94
    if (!boundsPassed) findings.push({ code: 'ERR_REFERENCE_VISUAL_BOUNDS', anchor: name, message: 'OS color bounds differ from the projected committed frame', edgeDelta })
    if (!samplesPassed) findings.push({ code: 'ERR_REFERENCE_VISUAL_SAMPLES', anchor: name, message: 'Projected unobscured background is missing, shifted or occluded', matched, samples })
    anchors.push({ name, rgba: expectedColor, expected, observed, edgeDelta, matchedSamples: matched,
      samples, matchedRatio: matched / samples, status: boundsPassed && samplesPassed ? 'passed' : 'failed' })
  }
  return { schemaVersion: 1, contract: 'android-reference-frame-placement-v1', status: findings.length ? 'failed' : 'passed', label,
    sessionId: receipt.sessionId, revision: receipt.revision, frameId: receipt.frame.frame_id,
    presentationSequence: receipt.surface.presentationSequence, screenshot: { width: image.width, height: image.height, sha256: digest(png) },
    transform, anchors, findings, officialVisualStatus: 'unknown',
    tolerances: { rgbChannel: 3, edgePhysicalPixels: 4, minimumBackgroundRatio: 0.94, excludedTextMarginPhysicalPixels: 4 },
    limitations: ['Reference-fixture opaque background placement only; text/antialias pixels are excluded',
      'Caller must correlate the unchanged presented frame, session, foreground and PID around OS capture',
      'A pass establishes no official screenshot equivalence, typography, complete layout semantics, GPU hardware or performance acceptance'] }
}
