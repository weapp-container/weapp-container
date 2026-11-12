import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deflateSync, gunzipSync } from 'node:zlib'
import { decodeAndroidScreenshotPng, inspectAndroidReferenceVisual, referenceScreenTransform } from './android-reference-visual.mjs'

// These generated rasters are unit inputs, never runtime screenshots or an official baseline.
function crc(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
function chunk(type, bytes) {
  const name = Buffer.from(type), result = Buffer.alloc(bytes.length + 12)
  result.writeUInt32BE(bytes.length); name.copy(result, 4); bytes.copy(result, 8)
  result.writeUInt32BE(crc(Buffer.concat([name, bytes])), result.length - 4)
  return result
}
function png(width, height, pixels, { channels = 4, filters = [0], depth = 8, interlace = 0, extra, trailing = Buffer.alloc(0) } = {}) {
  const header = Buffer.alloc(13), stride = width * channels, rows = Buffer.alloc((stride + 1) * height)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = channels === 4 ? 6 : 2; header[12] = interlace
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y % filters.length]; rows[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x += 1) {
      const i = y * stride + x, a = x >= channels ? pixels[i - channels] : 0
      const b = y ? pixels[i - stride] : 0, c = y && x >= channels ? pixels[i - stride - channels] : 0
      const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      const nearest = [a, b, c][distances.indexOf(Math.min(...distances))]
      const predictor = [0, a, b, Math.floor((a + b) / 2), nearest][filter] ?? 0
      rows[y * (stride + 1) + x + 1] = (pixels[i] - predictor) & 255
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...(extra ? [extra] : []),
    chunk('IDAT', Buffer.concat([deflateSync(rows), trailing])), chunk('IEND', Buffer.alloc(0))])
}

const PAGE = [243, 244, 246, 255], CARD = [255, 255, 255, 255], PANEL = [237, 246, 240, 255]
const background = rgba => ({ red: rgba[0], green: rgba[1], blue: rgba[2], alpha: rgba[3] })
const node = (id, bounds, rgba, children = []) => ({ id, bounds, opacity: 1, background: rgba ? background(rgba) : null, children })

function fixture({ offsetY = 0, offsetX = 0, clipY = Infinity, roundingNoise = false, transparent = false, text = false } = {}) {
  const width = 900, height = 1600, rgba = Buffer.alloc(width * height * 4)
  function paint(x, y, w, h, color) {
    for (let row = Math.max(0, y); row < Math.min(y + h, height, clipY); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(x + w, width); column += 1) {
        const i = (row * width + column) * 4
        rgba.set(color, i)
      }
    }
  }
  paint(0, 0, width, height, [18, 18, 18, 255])
  paint(offsetX, 66 + offsetY, 900, 1401, PAGE)
  paint(60 + offsetX, 126 + offsetY, 780, 780, CARD)
  paint(120 + offsetX, 606 + offsetY, 660, 240, PANEL)
  const textNode = { id: 'text', text: 'Unit text', bounds: { x: 50, y: 190, width: 180, height: 12 }, children: [] }
  if (text) {
    // Real glyph-shaped gaps are immaterial to the solid-background contract.
    for (let x = 150; x < 690; x += 11) paint(x + offsetX, 636 + offsetY, 5, 36, [25, 25, 25, 255])
  }
  if (roundingNoise) {
    // Tiny channel differences and a small number of contaminated pixels model capture/AA tolerance.
    for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c += 1) rgba[i + c] = Math.min(255, rgba[i + c] + 1)
    paint(65, 130, 2, 2, [0, 0, 0, 255])
  }
  if (transparent) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 0
  const panel = node('panel', { x: 40, y: 180, width: 220, height: 80 }, PANEL, text ? [textNode] : [])
  panel.classes = ['component-panel']
  const card = node('card', { x: 20, y: 20, width: 260, height: 260 }, CARD, [panel]); card.classes = ['card']
  const root = node('page', { x: 0, y: 0, width: 300, height: 467 }, PAGE, [card]); root.tag = 'page'
  const receipt = { schemaVersion: 1, status: 'ready', sessionId: 'unit-owned', revision: 2,
    page: { route: 'pages/home/index' }, frame: { frame_id: 3, viewport: { x: 0, y: 0, width: 300, height: 467 }, root },
    surface: { width: 900, height: 1401, screenX: 0, screenY: 66, backend: 'skia-gpu-gles', presentedFrameId: 3, presentationSequence: 3 },
    windowObservation: { displayWidth: width, displayHeight: height, surfaceWidth: 900, surfaceHeight: 1401, surfaceOrigin: { x: 0, y: 66 } } }
  return { png: png(width, height, rgba), receipt }
}

test('RGB and RGBA screenshots decode all five PNG row filters and split IDAT data', () => {
  assert.equal(crc(Buffer.from('IEND')), 0xae426082)
  for (const channels of [3, 4]) {
    const raw = Buffer.from(Array.from({ length: 7 * 5 * channels }, (_, i) => (i * 71 + Math.floor(i / 7)) % 256))
    const encoded = png(7, 5, raw, { channels, filters: [0, 1, 2, 3, 4] })
    const firstSize = encoded.readUInt32BE(33), compressed = encoded.subarray(41, 41 + firstSize), middle = Math.floor(compressed.length / 2)
    const split = Buffer.concat([encoded.subarray(0, 33), chunk('IDAT', compressed.subarray(0, middle)), chunk('IDAT', compressed.subarray(middle)), chunk('IEND', Buffer.alloc(0))])
    const result = decodeAndroidScreenshotPng(split)
    assert.equal(result.width, 7); assert.equal(result.height, 5)
    for (let i = 0; i < 35; i += 1) {
      assert.deepEqual([...result.rgba.subarray(i * 4, i * 4 + 3)], [...raw.subarray(i * channels, i * channels + 3)])
      assert.equal(result.rgba[i * 4 + 3], channels === 4 ? raw[i * channels + 3] : 255)
    }
  }
})

test('PNG corruption, unsupported encodings and decompression ambiguity fail explicitly', () => {
  const valid = png(2, 2, Buffer.alloc(16, 255))
  const corrupt = Buffer.from(valid); corrupt[corrupt.length - 1] ^= 1
  for (const bytes of [corrupt, valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]),
    png(2, 2, Buffer.alloc(16), { depth: 16 }), png(2, 2, Buffer.alloc(16), { interlace: 1 }),
    png(2, 2, Buffer.alloc(16), { extra: chunk('acTL', Buffer.alloc(8)) }),
    png(2, 2, Buffer.alloc(16), { extra: chunk(Buffer.from([0xe1, 66, 67, 68]), Buffer.alloc(0)) }),
    png(2, 2, Buffer.alloc(16), { extra: chunk('abcd', Buffer.alloc(0)) }),
    png(2, 2, Buffer.alloc(16), { extra: chunk('PLTE', Buffer.alloc(2)) }),
    png(2, 2, Buffer.alloc(16), { extra: chunk('PLTE', Buffer.alloc(0)) }),
    png(2, 2, Buffer.alloc(16), { extra: Buffer.concat([chunk('PLTE', Buffer.alloc(3)), chunk('PLTE', Buffer.alloc(3))]) }),
    png(2, 2, Buffer.alloc(16), { trailing: Buffer.from('extra-zlib-data') }), png(2, 2, Buffer.alloc(16), { filters: [5] })]) {
    assert.throws(() => decodeAndroidScreenshotPng(bytes), error => error.code === 'ERR_REFERENCE_VISUAL_INPUT')
  }
  const huge = Buffer.from(valid); huge.writeUInt32BE(16_777_216, 16)
  chunk('IHDR', huge.subarray(16, 29)).copy(huge, 8)
  assert.throws(() => decodeAndroidScreenshotPng(huge), /pixel budget/)
  const latePalette = Buffer.concat([valid.subarray(0, valid.length - 12), chunk('PLTE', Buffer.alloc(3)), valid.subarray(-12)])
  assert.throws(() => decodeAndroidScreenshotPng(latePalette), /late PNG PLTE/)
  assert.equal(decodeAndroidScreenshotPng(png(2, 2, Buffer.alloc(16), { extra: chunk('PLTE', Buffer.alloc(3)) })).width, 2)
})

test('untouched projected page/card/component geometry passes with a distinct local contract', () => {
  const result = inspectAndroidReferenceVisual({ ...fixture(), label: 'resize' })
  assert.equal(result.status, 'passed'); assert.equal(result.officialVisualStatus, 'unknown')
  assert.equal(result.contract, 'android-reference-frame-placement-v1')
  assert.equal(result.transform.scaleY, 3)
  assert.deepEqual(result.anchors.find(a => a.name === 'component-panel').expected, { x: 120, y: 606, width: 660, height: 240 })
  assert.ok(result.anchors.every(a => a.matchedRatio === 1))
})

test('740 physical pixel translation and resulting clipping fail despite an unchanged presented receipt', () => {
  const result = inspectAndroidReferenceVisual(fixture({ offsetY: 740 }))
  assert.equal(result.status, 'failed')
  const card = result.anchors.find(a => a.name === 'card')
  assert.equal(card.edgeDelta.top, 740)
  assert.ok(result.findings.some(f => f.anchor === 'component-panel' && f.code === 'ERR_REFERENCE_VISUAL_BOUNDS'))
})

test('horizontal displacement, clipping and transparent/blank output cannot pass background geometry', () => {
  for (const options of [{ offsetX: 18 }, { clipY: 700 }, { transparent: true }]) {
    assert.equal(inspectAndroidReferenceVisual(fixture(options)).status, 'failed')
  }
})

test('solid-color tolerance excludes text bounds and does not demand glyph-identical images', () => {
  assert.equal(inspectAndroidReferenceVisual(fixture({ text: true, roundingNoise: true })).status, 'passed')
})

test('physical transform uses independent X/Y Surface ratios and nonzero logical viewport origin', () => {
  const { receipt } = fixture()
  receipt.frame.viewport = { x: 11, y: 19, width: 327, height: 510 }
  const transform = referenceScreenTransform(receipt, { width: 900, height: 1600 })
  assert.equal(transform.viewportX, 11); assert.equal(transform.viewportY, 19)
  assert.equal(transform.scaleX, 900 / 327); assert.equal(transform.scaleY, 1401 / 510)
  assert.notEqual(transform.scaleX, transform.scaleY)
})

test('stale/mismatched Surface, display, frame and unsupported fixtures fail instead of guessing', () => {
  for (const change of [
    r => { r.surface.presentedFrameId += 1 },
    r => { r.windowObservation.displayHeight += 1 },
    r => { r.surface.screenY += 1 },
    r => { r.frame.root.children[0].children = [] },
    r => { r.frame.root.children[0].background.alpha = 128 },
    r => { r.frame.root.children[0].bounds.height = 800 },
  ]) {
    const value = fixture(); change(value.receipt)
    assert.throws(() => inspectAndroidReferenceVisual(value), error => error.code === 'ERR_REFERENCE_VISUAL_INPUT')
  }
})

test('unaltered historical OS screenshots expose resize offset, density dimming and restoration displacement', () => {
  const directory = new URL('../docs/evidence/2026-10-21-android-window-metrics/production-runtime/', import.meta.url)
  const expected = { 'page-tap': 'passed', 'component-tap': 'passed', 'slot-tap': 'passed', resize: 'failed',
    density: 'failed', resume: 'passed', 'resume-density-restored': 'failed' }
  for (const [label, status] of Object.entries(expected)) {
    const imageUrl = new URL(`interaction-${label}.png`, directory), screenshot = readFileSync(imageUrl)
    let bytes
    try { bytes = readFileSync(new URL(`interaction-${label}.json`, directory)) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      bytes = gunzipSync(readFileSync(new URL(`interaction-${label}.json.gz`, directory)))
    }
    const result = inspectAndroidReferenceVisual({ png: screenshot, receipt: JSON.parse(bytes), label })
    assert.equal(result.status, status, label)
    assert.equal(result.officialVisualStatus, 'unknown', label)
    if (label === 'resize') {
      assert.equal(result.screenshot.sha256, 'b4ced84a5813adb6e5d738fa707f39ea18b67e1d0b742c2d41f282da26d4f642')
      for (const name of ['card', 'component-panel']) {
        assert.ok(Math.abs(result.anchors.find(anchor => anchor.name === name).edgeDelta.top - 740) < 1)
      }
    }
    if (label === 'density') assert.ok(result.anchors.every(anchor => anchor.observed === null))
    if (label === 'resume-density-restored') {
      assert.ok(Math.abs(result.anchors.find(anchor => anchor.name === 'card').edgeDelta.top + 18) < 1)
    }
    assert.equal(createHash('sha256').update(readFileSync(imageUrl)).digest('hex'), result.screenshot.sha256)
  }
})
