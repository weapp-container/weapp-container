import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { CanvasKitFrameError, CanvasKitFramePresenter } from '../examples/hosts/web-wasm/canvaskit-presenter.mjs'

const background = { red: 243, green: 244, blue: 246, alpha: 255 }
const box = { x: 0, y: 0, width: 64, height: 64 }
const node = (id, extra = {}) => ({ id, bounds: { ...box }, opacity: 1, background: null, children: [], ...extra })
const frame = () => ({ frame_id: 1, viewport: { ...box }, root: node('page', { background,
  children: [node('label', { text: 'Weapp\n微信0', bounds: { x: 4, y: 4, width: 56, height: 44 } })] }) })
const coded = (code, match) => error => error instanceof CanvasKitFrameError && error.code === code && (!match || match.test(error.message))
const borderSide = (width, color = { red: 0, green: 0, blue: 0, alpha: 255 }, style = 'solid') => ({ width, color, style })
const borderSides = (width = 2, color, style) => Array.from({ length: 4 }, () => borderSide(width, color, style))
const computedBorders = (width = '0px', style = 'none', color = 'rgb(0, 0, 0)') => Object.fromEntries(
  ['top', 'right', 'bottom', 'left'].flatMap(edge => [
    [`border-${edge}-width`, width], [`border-${edge}-style`, style], [`border-${edge}-color`, color],
  ]))

// Explicit paint sequences are independent of the presenter's comparator.
// Bounds are already committed: order changes sibling paint order, not layout.
const flowOrderCases = [
  { name: 'negative, zero and positive orders', flow: { context: 'flex' },
    items: [{ id: 'positive', order: 3 }, { id: 'negative', order: -2 }, { id: 'zero', order: 0 }],
    expected: ['negative', 'zero', 'positive'] },
  { name: 'equal orders retain original sibling order', flow: { context: 'flex' },
    items: [{ id: 'first', order: 2 }, { id: 'second', order: 2 }, { id: 'third', order: 2 }],
    expected: ['first', 'second', 'third'] },
  { name: 'z-index precedes flex order', flow: { context: 'flex' },
    items: [{ id: 'high-z', order: -20, z: 2 }, { id: 'low-z', order: 20, z: -1 }, { id: 'zero-z', order: 0 }],
    expected: ['low-z', 'zero-z', 'high-z'] },
  { name: 'absolute child uses effective order zero', flow: { context: 'flex' },
    items: [{ id: 'absolute', order: -100, position: 'absolute' }, { id: 'negative', order: -1 }, { id: 'positive', order: 1 }],
    expected: ['negative', 'absolute', 'positive'] },
  { name: 'fixed child uses effective order zero', flow: { context: 'flex' },
    items: [{ id: 'fixed', order: 100, position: 'fixed' }, { id: 'positive', order: 1 }, { id: 'negative', order: -1 }],
    expected: ['negative', 'fixed', 'positive'] },
  { name: 'block parent ignores child order', flow: { context: 'block' },
    items: [{ id: 'first', order: 100 }, { id: 'second', order: -100 }, { id: 'third', order: 0 }],
    expected: ['first', 'second', 'third'] },
  { name: 'omitted context keeps block ordering', flow: {},
    items: [{ id: 'first', order: 100 }, { id: 'second', order: -100 }, { id: 'third', order: 0 }],
    expected: ['first', 'second', 'third'] },
  { name: 'legacy parent without flow ignores child order',
    items: [{ id: 'first', order: 100 }, { id: 'second', order: -100 }, { id: 'third', order: 0 }],
    expected: ['first', 'second', 'third'] },
  { name: 'omitted child order and legacy children default to zero', flow: { context: 'flex' },
    items: [{ id: 'omitted', flow: {} }, { id: 'legacy', legacy: true }, { id: 'explicit-zero', order: 0 }],
    expected: ['omitted', 'legacy', 'explicit-zero'] },
  { name: 'full i32 boundary orders', flow: { context: 'flex' },
    items: [{ id: 'maximum', order: 2147483647 }, { id: 'minimum', order: -2147483648 }, { id: 'zero', order: 0 }],
    expected: ['minimum', 'zero', 'maximum'] },
]
const flowOrderParent = spec => node('ordered-parent', {
  ...(spec.flow === undefined ? {} : { style: { flow: spec.flow } }),
  children: spec.items.map((item, index) => node(item.id, {
    bounds: { x: 4 + index * 4, y: 4 + index * 4, width: 40, height: 40 },
    background: [{ red: 220, green: 20, blue: 60, alpha: 160 },
      { red: 0, green: 160, blue: 70, alpha: 160 }, { red: 20, green: 80, blue: 220, alpha: 160 }][index],
    ...(item.z === undefined ? {} : { z_index: item.z }),
    ...(!item.legacy ? { style: { flow: item.flow ?? (item.order === undefined ? {} : { order: item.order }),
      ...(item.position === undefined ? {} : { position: item.position }) } } : {}),
  })),
})

// These test doubles establish ownership/atomicity contracts only. They never
// count as CanvasKit execution, a real WebGL context or a GPU acceptance result.
function fakeBackend(settings = {}) {
  const calls = [], listeners = new Map()
  const push = (name, ...args) => calls.push([name, ...args])
  const drawing = prefix => Object.fromEntries(['clear', 'save', 'saveLayer', 'restore', 'scale', 'drawPicture', 'concat',
    'drawRect', 'drawRRect', 'drawPath', 'clipRect', 'clipRRect', 'drawGlyphs', 'drawImageRectOptions'].map(name => [name, (...args) => {
    push(`${prefix}.${name}`, ...args)
    if (settings.recordingFailure && prefix === 'record' && name === 'drawGlyphs') throw new Error('recording failed')
    if (settings.borderRecordingFailure && prefix === 'record' && name === 'drawPath') throw new Error('border recording failed')
    if (settings.imageRecordingFailure && prefix === 'record' && name === 'drawImageRectOptions') throw new Error('image recording failed')
  }]))
  const target = drawing('record'), visible = drawing('visible')
  const resource = name => ({ delete() { push(`${name}.delete`); if (settings.cleanupFailure === name) throw new Error(`${name} delete failed`) } })
  const gl = { NO_ERROR: 0, VERSION: 1, VENDOR: 2, RENDERER: 3,
    isContextLost: () => false, getExtension: () => null, getParameter: key => `test-double-${key}`,
    finish: () => push('gl.finish'), getError: () => settings.glError ?? 0 }
  const canvas = { width: 64, height: 64,
    addEventListener(name, callback) { listeners.set(name, callback); push('listener.add', name) },
    removeEventListener(name, callback) { assert.equal(listeners.get(name), callback); listeners.delete(name); push('listener.remove', name) },
    getContext(name) { assert.equal(name, 'webgl2'); return gl } }
  const image = { ...resource('image'), readPixels: () => new Uint8Array(64 * 64 * 4).fill(255) }
  const surface = { ...resource('surface'), reportBackendTypeIsGPU: () => settings.gpu !== false,
    getCanvas: () => visible, flush: () => push('surface.flush'), makeImageSnapshot: () => image }
  const CK = {
    ColorSpace: { SRGB: 'srgb' }, ColorType: { RGBA_8888: 'rgba8' }, AlphaType: { Unpremul: 'unpremul' },
    FilterMode: { Nearest: 'nearest' }, MipmapMode: { None: 'none' },
    FontHinting: { None: 0 },
    ClipOp: { Intersect: 'intersect', Difference: 'difference' }, TRANSPARENT: [0, 0, 0, 0], Color: (...args) => args,
    MOVE_VERB: 0, LINE_VERB: 1, CLOSE_VERB: 5,
    Path: { MakeFromCmds(commands) { push('path.new', [...commands]); return settings.pathFailure ? null : { ...resource('path'), commands: [...commands] } } },
    GetWebGLContext(_canvas, options) { push('GetWebGLContext', options); return settings.contextHandle ?? 4 },
    MakeWebGLContext(handle) { push('MakeWebGLContext', handle); return resource('context') },
    MakeOnScreenGLSurface(_context, width, height) { push('MakeOnScreenGLSurface', width, height); return surface },
    MakeWebGLCanvasSurface() { throw new Error('forbidden CPU-fallback-capable entry point') },
    MakeSurface() { throw new Error('forbidden CPU surface') },
    MakeImage(info, pixels, rowBytes) {
      push('image.new', info, pixels, rowBytes)
      if (calls.filter(([name]) => name === 'image.new').length === settings.imageCreationFailureAt) return null
      return { ...resource('resourceImage'), width: () => info.width, height: () => info.height }
    },
    deleteContext: handle => push('deleteContext', handle),
    Typeface: { MakeTypefaceFromData: data => { settings.onTypefaceData?.(data); return settings.badFont ? null : resource('typeface') } },
    Font: class {
      constructor(_face, size) { Object.assign(this, resource('font')); this.size = size }
      setSubpixel() {}
      setLinearMetrics(value) { push('font.linear', value) }
      setHinting(value) { push('font.hinting', value) }
      setSize(size) { this.size = size; push('font.size', size) }
      getGlyphIDs(text) { return Uint16Array.from([...text], character => character === '\u{10ffff}' ? 0 : 1) }
      getGlyphWidths(glyphs) { push('font.measure', this.size); return Float32Array.from(glyphs, () => this.size * 0.5) }
    },
    Paint: class {
      constructor() { Object.assign(this, resource('paint')) }
      setAntiAlias(value) { push('paint.antialias', value) }
      setColor(value) { push('paint.color', value) }
      setAlphaf(value) { push('paint.alpha', value) }
    },
    PictureRecorder: class {
      constructor() { Object.assign(this, resource('recorder')); push('recorder.new') }
      beginRecording() { return target }
      finishRecordingAsPicture() { return resource('picture') }
    },
  }
  return { CK, canvas, surface, calls, listeners, gl, create: options => CanvasKitFramePresenter.create(CK, canvas, new ArrayBuffer(1), options) }
}

test('unit contract: explicit WebGL2/Ganesh/onscreen GPU only, one picture per full frame', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const receipt = presenter.submit(frame())
    assert.deepEqual(b.calls.find(([name]) => name === 'GetWebGLContext')[1], { majorVersion: 2, alpha: true, antialias: false, preserveDrawingBuffer: true })
    assert.equal(receipt.backend, 'canvaskit-webgl2')
    assert.equal(receipt.parityStatus, 'partial')
    assert.equal(receipt.context.physicalHardware, 'unknown')
    assert.deepEqual(receipt.runtimeBoundary, { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 })
    assert.equal(b.calls.filter(([name]) => name === 'visible.drawPicture').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'surface.flush').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'gl.finish').length, 0)
    assert.equal(receipt.presentation.gpuCompletion, 'not-waited')
    assert.equal(b.calls.filter(([name]) => name === 'picture.delete').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'recorder.delete').length, 1)
    const readback = presenter.snapshotEvidence()
    assert.equal(readback.rgba.length, 64 * 64 * 4)
    assert.equal(readback.source, 'CanvasKit GPU surface readback')
    assert.equal(readback.gpuCompletion, 'gl.finish')
    assert.equal(b.calls.filter(([name]) => name === 'gl.finish').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'image.delete').length, 1)
  } finally { presenter.dispose() }
  const names = b.calls.map(([name]) => name)
  assert.ok(names.indexOf('font.delete') < names.indexOf('typeface.delete'))
  assert.ok(names.indexOf('surface.delete') < names.indexOf('context.delete'))
  assert.ok(names.indexOf('context.delete') < names.indexOf('deleteContext'))
  assert.equal(b.listeners.size, 0)
  const count = b.calls.length
  presenter.dispose()
  assert.equal(b.calls.length, count, 'cleanup is idempotent')
})

test('unit contract: transformed ancestors reject typed fixed but preserve absolute replay', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const current = frame()
    current.root.text = null
    current.root.style = { transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }
    current.root.children = [node('fixed', { style: { position: 'fixed', flow: {} } })]
    assert.throws(() => presenter.submit(current), coded('ERR_UNSUPPORTED_CAPABILITY', /transformed containing block/))
    assert.equal(b.calls.filter(([name]) => name === 'visible.drawPicture').length, 0)
    current.root.children[0].style.position = 'absolute'
    presenter.submit(current)
    assert.equal(b.calls.filter(([name]) => name === 'visible.drawPicture').length, 1)
    current.root.style = {}
    current.root.children[0].style.flow = false
    assert.throws(() => presenter.validate(current), coded('ERR_RENDER', /flow metadata/))
  } finally { presenter.dispose() }
})

test('unit opacity contract: subtree layers surround descendants and primitives keep their own alpha', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const current = { frame_id: 60, viewport: { ...box }, root: node('group', {
      opacity: 0.5, background: { red: 255, green: 0, blue: 0, alpha: 192 },
      children: [node('nested', { opacity: 0.5, background: { red: 0, green: 0, blue: 255, alpha: 255 } })],
    }) }
    const receipt = presenter.submit(current)
    assert.equal(receipt.opacityGroups, 2)
    assert.equal(receipt.maxOpacityDepth, 2)
    assert.equal(receipt.opacityBackingBytes, 64 * 64 * 4 * 2)
    const ops = b.calls.filter(([name]) => name.startsWith('record.'))
    assert.equal(ops.filter(([name]) => name === 'record.saveLayer').length, 2)
    assert.equal(ops.filter(([name]) => name === 'record.save' || name === 'record.saveLayer').length,
      ops.filter(([name]) => name === 'record.restore').length)
    assert.equal(ops[0][0], 'record.saveLayer', 'outer group begins before node-local geometry/clipping')
    assert.equal(ops.at(-1)[0], 'record.restore', 'outer group closes after nested contents')
    const colours = b.calls.filter(([name]) => name === 'paint.color').map(([, value]) => value)
    assert.deepEqual(colours, [[255, 0, 0, 192 / 255], [0, 0, 255, 1]])
    assert.equal(b.calls.filter(([name, alpha]) => name === 'paint.alpha' && alpha === 128 / 255).length, 2)
    assert.equal(b.calls.filter(([name]) => name === 'paint.delete').length, 4)
  } finally { presenter.dispose() }
})

test('unit opacity contract: committed and legacy layers round serialized f32 half-steps identically', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    for (const [opacity, alpha] of [[0.01372549, 4], [0.025490196, 7]]) {
      for (const legacy of [false, true]) {
        const current = { frame_id: 62, viewport: { ...box }, root: node('group', { opacity, background }) }
        if (!legacy) current.paintPlan = { version: 1, commands: ['begin', 'background', 'content', 'end']
          .map(op => ({ op, path: [] })) }
        b.calls.length = 0
        presenter.submit(current)
        assert.deepEqual(b.calls.filter(([name]) => name === 'paint.alpha').map(([, value]) => value),
          [alpha / 255], `${legacy ? 'legacy' : 'committed'} opacity ${opacity}`)
      }
    }
  } finally { presenter.dispose() }
})

test('unit opacity contract: failed group recording unwinds layers and preserves accepted surface', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(frame())
    b.calls.length = 0
    // Test doubles throw only after the layer exists, exercising restore/delete.
    const original = b.CK.Paint.prototype.setColor
    b.CK.Paint.prototype.setColor = () => { throw new Error('opacity paint failure') }
    try {
      const bad = frame(); bad.root.opacity = 0.5
      assert.throws(() => presenter.submit(bad), coded('ERR_RENDER', /opacity paint failure/))
    } finally { b.CK.Paint.prototype.setColor = original }
    const ops = b.calls.filter(([name]) => name.startsWith('record.'))
    assert.equal(ops.filter(([name]) => name === 'record.save' || name === 'record.saveLayer').length,
      ops.filter(([name]) => name === 'record.restore').length)
    assert.equal(b.calls.filter(([name]) => name === 'paint.delete').length, 2)
    assert.equal(b.calls.some(([name]) => name === 'visible.clear' || name === 'visible.drawPicture'), false)
    assert.equal(presenter.lastReceipt, accepted)
  } finally { presenter.dispose() }
})

test('unit opacity contract: backing budget uses nesting and physical dimensions before recording', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(frame()), before = b.calls.length
    const chain = count => {
      let root = node('leaf')
      for (let index = 0; index < count; index++) root = node(`layer-${index}`, { opacity: 0.5, children: [root] })
      return { frame_id: 61, viewport: { ...box }, root }
    }
    assert.throws(() => presenter.submit(chain(33)), coded('ERR_RENDER', /compositing.*budget/))
    assert.equal(b.calls.length, before)
    assert.equal(presenter.lastReceipt, accepted)
    assert.equal(presenter.validate(chain(32)).maxOpacityDepth, 32)
    const siblings = chain(0)
    siblings.root.children = Array.from({ length: 40 }, (_, index) => node(String(index), { opacity: 0.5 }))
    assert.equal(presenter.validate(siblings).maxOpacityDepth, 1)
    const invisible = chain(33); invisible.root.opacity = 0
    assert.equal(presenter.validate(invisible).opacityGroups, 0)
    invisible.root.opacity = 0.5; invisible.root.style = { display: 'none' }
    assert.equal(presenter.validate(invisible).opacityGroups, 0)
    b.canvas.width = b.canvas.height = 4096; presenter.physicalSize = [4096, 4096]
    assert.equal(presenter.validate(chain(1)).opacityBackingBytes, 64 * 1024 * 1024)
    assert.throws(() => presenter.validate(chain(2)), coded('ERR_RENDER', /compositing.*budget/))
  } finally { presenter.dispose() }
})

for (const spec of flowOrderCases) test(`unit flow order contract: ${spec.name}`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const parent = flowOrderParent(spec)
    presenter.submit({ frame_id: 50, viewport: { ...box }, root: parent })
    const original = new Map(parent.children.map(child => [child.bounds.x, child.id]))
    assert.deepEqual(b.calls.filter(([name]) => name === 'record.drawRect')
      .map(([, bounds]) => original.get(bounds[0])), spec.expected)
    assert.deepEqual(parent.children.map(child => child.id), spec.items.map(item => item.id),
      'painting must not mutate DOM sibling order')
  } finally { presenter.dispose() }
})

const invalidFlowValues = [
  ['fractional order', 'order', 1.5], ['null order', 'order', null], ['undefined order', 'order', undefined],
  ['string order', 'order', '1'], ['boolean order', 'order', true], ['NaN order', 'order', NaN],
  ['infinite order', 'order', Infinity], ['order above i32', 'order', 2147483648],
  ['order below i32', 'order', -2147483649], ['unknown context', 'context', 'grid'],
  ['null context', 'context', null], ['undefined context', 'context', undefined], ['numeric context', 'context', 1],
]
for (const [label, field, value] of invalidFlowValues) test(`unit flow order contract: ${label} rejects atomically before recording`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(frame()), before = b.calls.length
    const invalid = frame()
    invalid.root.children[0].style = { flow: { [field]: value } }
    assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER', /typed flow/))
    assert.equal(b.calls.length, before, 'invalid flow cannot record or mutate the accepted surface')
    assert.equal(presenter.lastReceipt, accepted)
    assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

test('unit flow order contract: anonymous parent text rejects nonzero in-flow orders and keeps the accepted frame', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(frame()), before = b.calls.length
    for (const text of ['parent text', '']) {
      const invalid = { frame_id: 51, viewport: { ...box }, root: flowOrderParent(flowOrderCases[0]) }
      invalid.root.text = text
      assert.throws(() => presenter.submit(invalid), coded('ERR_UNSUPPORTED_CAPABILITY', /explicit text leaf/))
      assert.equal(b.calls.length, before)
      assert.equal(presenter.lastReceipt, accepted)
      assert.equal(presenter.generation, 1)
    }
    const valid = { frame_id: 52, viewport: { ...box }, root: node('parent-text', {
      text: 'parent text', style: { flow: { context: 'flex' } }, children: [
        node('absolute', { style: { position: 'absolute', flow: { order: -2 } } }),
        node('fixed', { style: { position: 'fixed', flow: { order: 2 } } }),
        node('ordinary', { style: { flow: { order: 0 } } }),
      ],
    }) }
    assert.doesNotThrow(() => presenter.validate(valid))
    valid.root.children[2].style.flow.order = 'invalid'
    assert.throws(() => presenter.validate(valid), coded('ERR_RENDER', /typed flow order/),
      'child metadata validation must precede the anonymous text capability check')
  } finally { presenter.dispose() }
})

for (const [name, settings, expected] of [
  ['missing WebGL', { contextHandle: 0 }, /WebGL2 context/],
  ['CPU surface', { gpu: false }, /GPU-backed/],
  ['font decode', { badFont: true }, /font did not decode/],
]) test(`unit contract: ${name} fails explicitly and releases partially created resources`, async () => {
  const b = fakeBackend(settings)
  await assert.rejects(b.create(), coded('ERR_RENDER', expected))
  assert.equal(b.listeners.size, 0)
  assert.equal(b.calls.some(([name]) => name === 'visible.clear'), false)
  if (settings.contextHandle !== 0) assert.equal(b.calls.filter(([name]) => name === 'deleteContext').length, 1)
})

for (const [name, mutate, code] of [
  ['untyped image src', f => { f.root.children.push(node('bad', { tag: 'image', attributes: { src: 'asset.png' } })) }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['negative scroll', f => { f.root.scrollOffset = { scrollTop: -2 } }, 'ERR_RENDER'],
  ['null scroll coordinate', f => { f.root.scrollOffset = { scrollTop: null } }, 'ERR_RENDER'],
  ['non-finite scroll', f => { f.root.scrollOffset = { scrollLeft: NaN } }, 'ERR_RENDER'],
  ['unrepresentable scroll', f => { f.root.scrollOffset = { scrollTop: 1e100 } }, 'ERR_RENDER'],
  ['invalid scroll flag', f => { f.root.scrollContainer = 'true' }, 'ERR_RENDER'],
  ['invalid overflow', f => { f.root.computed_style = { overflow: 'hidden visible auto' } }, 'ERR_RENDER'],
  ['unknown overflow', f => { f.root.computed_style = { overflow: 'unknown' } }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['border shorthand', f => { f.root.computed_style = { border: '1px solid red' } }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['background gradient', f => { f.root.computed_style = { background: 'linear-gradient(red,blue)' } }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['font coverage', f => { f.root.children[0].text = '\u{10ffff}' }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['invalid deep colour', f => { f.root.children[0].foreground = { ...background, red: 256 } }, 'ERR_RENDER'],
  ['non-finite opacity', f => { f.root.children[0].opacity = NaN }, 'ERR_RENDER'],
  ['invalid bounds', f => { f.root.children[0].bounds.width = -1 }, 'ERR_RENDER'],
  ['invalid children', f => { f.root.children[0].children = null }, 'ERR_RENDER'],
  ['invalid style type', f => { f.root.children[0].computed_style = { overflow: 3 } }, 'ERR_RENDER'],
  ['invalid origin', f => { f.root.style = { transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, transform_origin: { x: { value: NaN, unit: 'px' } } } }, 'ERR_RENDER'],
  ['null origin value', f => { f.root.style = { transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, transform_origin: { x: { value: null, unit: 'px' } } } }, 'ERR_RENDER'],
  ['nonzero viewport origin', f => { f.viewport.x = 1 }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['unsafe frame ID', f => { f.frame_id = Number.MAX_SAFE_INTEGER + 1 }, 'ERR_RENDER'],
]) test(`unit contract: ${name} is rejected before recording or surface mutation and preserves prior receipt`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const first = presenter.submit(frame()), before = b.calls.length
    const invalid = frame(); mutate(invalid)
    assert.throws(() => presenter.submit(invalid), coded(code))
    assert.equal(b.calls.length, before)
    assert.equal(presenter.lastReceipt, first)
    assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

test('unit scroll contract: explicit containers clip before translating descendants; metadata does not translate', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const scroller = node('scroll', { bounds: { x: 8, y: 8, width: 24, height: 24 }, background,
      scrollContainer: true, scrollOffset: { scrollLeft: 4, scrollTop: 12 },
      children: [node('content', { bounds: { x: 12, y: 28, width: 8, height: 20 }, background })] })
    presenter.submit({ frame_id: 2, viewport: { ...box }, root: node('root', { children: [scroller,
      node('sibling', { bounds: { x: 48, y: 48, width: 8, height: 8 }, background }),
    ] }) })
    const clip = b.calls.findIndex(([name]) => name === 'record.clipRect')
    const translation = b.calls.findIndex(([name, matrix]) => name === 'record.concat' && matrix[2] === -4 && matrix[5] === -12)
    assert.ok(clip > 0 && translation > clip, 'Fixed clip is established before content translation')
    assert.deepEqual(b.calls[clip][1], [8, 8, 32, 32])
    assert.equal(b.calls.filter(([name]) => name === 'record.drawRect').length, 3)
    assert.equal(b.calls.filter(([name]) => name === 'record.save' || name === 'record.saveLayer').length, b.calls.filter(([name]) => name === 'record.restore').length)
    b.calls.length = 0
    scroller.scrollContainer = false
    presenter.submit({ frame_id: 3, viewport: { ...box }, root: scroller })
    assert.equal(b.calls.some(([name, matrix]) => name === 'record.concat' && (matrix[2] !== 0 || matrix[5] !== 0)), false)
    assert.equal(b.calls.some(([name]) => name === 'record.clipRect'), false, 'Raw metadata does not imply a scrolling viewport')
  } finally { presenter.dispose() }
})

test('unit scroll contract: nested translation participates in inverse transformed one-axis clipping', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit({ frame_id: 2, viewport: { ...box }, root: node('scroll', {
      bounds: { x: 8, y: 8, width: 48, height: 48 }, scrollContainer: true,
      scrollOffset: { scrollLeft: 4, scrollTop: 12 },
      style: { transform: { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 },
        transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } },
      children: [node('strip', { bounds: { x: 12, y: 24, width: 20, height: 20 },
        computed_style: { overflow: 'visible clip' }, children: [node('paint', { background })] })],
    }) })
    const clips = b.calls.filter(([name]) => name === 'record.clipRect').map(([, bounds]) => bounds)
    assert.deepEqual(clips[0], [8, 8, 56, 56])
    // Accumulated parent x=2*x-16, y=y-12; viewport inverse is [8,12,40,76].
    assert.ok(clips.some(bounds => JSON.stringify(bounds) === JSON.stringify([7, 24, 41, 44])),
      'The descendant receives the inverse-transformed strip as well as the repeated ancestor viewport clip')
  } finally { presenter.dispose() }
})

for (const [declaration, axes] of [
  [{ overflow: 'visible' }, [false, false]],
  [{ overflow: 'hidden' }, [true, true]],
  [{ overflow: 'SCROLL' }, [true, true]],
  [{ overflow: 'clip visible' }, [true, false]],
  [{ overflow: 'visible clip' }, [false, true]],
  [{ overflow: 'visible hidden' }, [true, true]],
  [{ overflow: 'auto visible' }, [true, true]],
  [{ overflow: 'hidden', 'overflow-x': ' visible ', 'overflow-y': ' clip ' }, [false, true]],
]) test(`unit contract: ${JSON.stringify(declaration)} clips only computed overflow axes`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const actual = { frame_id: 2, viewport: { ...box }, root: node('root', {
      bounds: { x: 12, y: 16, width: 24, height: 20 }, computed_style: declaration,
      background, children: [node('outside', { background })],
    }) }
    const receipt = presenter.submit(actual)
    const clips = b.calls.filter(([name]) => name === 'record.clipRect')
    assert.equal(clips.length, axes.some(Boolean) ? 1 : 0)
    if (clips.length) {
      const bounds = clips[0][1]
      assert.equal(bounds[0], axes[0] ? 12 : -1)
      assert.equal(bounds[1], axes[1] ? 16 : -1)
      assert.equal(bounds[2], axes[0] ? 36 : 65)
      assert.equal(bounds[3], axes[1] ? 36 : 65)
    }
    assert.equal(receipt.runtimeBoundary.perNodeRuntimeCalls, 0)
    assert.ok(!receipt.limits.some(limit => limit.includes('overflow paint clips')))
    const names = b.calls.map(([name]) => name)
    if (clips.length) assert.ok(names.indexOf('record.drawRect') < names.indexOf('record.clipRect'), 'Own background precedes descendant clipping')
    assert.equal(names.filter(name => name === 'record.save').length, names.filter(name => name === 'record.restore').length)
  } finally { presenter.dispose() }
})

test('unit contract: two-axis rounded clips normalize radii, one-axis clips remain strips, hidden and singular subtrees do not draw', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const rounded = node('rounded', { bounds: { x: 4, y: 4, width: 20, height: 10 },
      computed_style: { overflow: 'hidden' }, style: { border_radius: Array.from({ length: 4 }, () => ({ x: 20, y: 20 })) },
      children: [node('rounded-child', { background })] })
    const oneAxis = structuredClone(rounded); oneAxis.id = 'strip'; oneAxis.computed_style.overflow = 'clip visible'
    presenter.submit({ frame_id: 3, viewport: { ...box }, root: node('root', { children: [rounded, oneAxis,
      node('hidden', { style: { display: 'none' }, children: [node('hidden-child', { background })] }),
      node('singular', { style: { transform: { a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 } }, children: [node('singular-child', { background })] }),
      node('small-invertible', { style: { transform: { a: 1e-5, b: 0, c: 0, d: 1e-5, e: 0, f: 0 } }, children: [node('small-invertible-child', { background })] }),
    ] }) })
    assert.deepEqual(b.calls.find(([name]) => name === 'record.clipRRect').slice(1), [[4, 4, 24, 14, 5, 5, 5, 5, 5, 5, 5, 5], 'intersect', false])
    assert.equal(b.calls.filter(([name]) => name === 'record.clipRect').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawRect').length, 3)
  } finally { presenter.dispose() }
})

test('unit transform contract: small nonzero determinants draw and one-axis clips use the accepted inverse', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit({ frame_id: 4, viewport: { ...box }, root: node('root', {
      children: [node('small-scale', { bounds: { x: 0, y: 0, width: 320000, height: 320000 },
        style: { transform: { a: .0001, b: 0, c: 0, d: .0001, e: 0, f: 0 },
          transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } },
        computed_style: { overflow: 'clip visible' }, children: [node('paint', {
          bounds: { x: -80000, y: -80000, width: 480000, height: 480000 }, background,
        })] })],
    }) })
    assert.equal(b.calls.filter(([name]) => name === 'record.drawRect').length, 1)
    const clip = b.calls.find(([name]) => name === 'record.clipRect')[1]
    assert.deepEqual(clip, [0, -1, 320000, 640001])
    assert.ok(b.calls.some(([name, matrix]) => name === 'record.concat' && matrix[0] === Math.fround(.0001) && matrix[4] === Math.fround(.0001)))
  } finally { presenter.dispose() }
})

test('unit transform contract: fractional ancestors and large mixed-unit origins use the same rounded matrices as Rust', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit({ frame_id: 4, viewport: { ...box }, root: node('fractional-parent', {
      style: { transform: { a: .7, b: -.1, c: .15, d: 1.2, e: .3, f: -.4 },
        transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } },
      children: [node('large-origin-child', {
        bounds: { x: 1000001.25, y: -300000.75, width: 123.5, height: 987.25 }, background,
        style: { transform: { a: 1.1, b: .2, c: -.3, d: .9, e: .1, f: -.2 },
          transform_origin: { x: { value: 33.33333206176758, unit: 'percent' }, y: { value: -1.1, unit: 'px' } } },
      })],
    }) })
    // Fixed IEEE-754 binary32 results. In particular, the child's local e is
    // -190004.703125; collapsing the origin sandwich gives -190004.71875.
    // Retaining double world coefficients would also change the second matrix.
    assert.deepEqual(b.calls.filter(([name]) => name === 'record.concat').map(([, matrix]) => matrix), [
      [0.699999988079071, 0.15000000596046448, 0.30000001192092896,
        -0.10000000149011612, 1.2000000476837158, -0.4000000059604645, 0, 0, 1],
      [0.800000011920929, -0.07500000298023224, -167504.328125,
        0.1300000101327896, 1.1100000143051147, -257010.59375, 0, 0, 1],
    ])
  } finally { presenter.dispose() }
})

test('unit transform contract: origin percentage division and default center round at Rust f32 boundaries', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit({ frame_id: 4, viewport: { ...box }, root: node('percentage-origin', {
      bounds: { x: 0, y: 0, width: 100000.125, height: 16 }, background,
      style: { transform: { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 },
        transform_origin: { x: { value: 66.66666412353516, unit: 'percent' }, y: { value: 0, unit: 'px' } } },
    }) })
    assert.deepEqual(b.calls.find(([name]) => name === 'record.concat')[1], [2, 0, -66666.7421875, 0, 1, 0, 0, 0, 1])
    const before = b.calls.length
    presenter.submit({ frame_id: 5, viewport: { ...box }, root: node('default-origin', {
      bounds: { x: .1, y: .2, width: .2, height: .4 }, background,
      style: { transform: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 } },
    }) })
    assert.deepEqual(b.calls.slice(before).find(([name]) => name === 'record.concat')[1],
      [2, 0, -0.20000000298023224, 0, 2, -0.4000000059604645, 0, 0, 1])
    presenter.submit({ frame_id: 6, viewport: { ...box }, root: node('no-transform', {
      background, style: { transform_origin: { x: { value: 20, unit: 'px' }, y: { value: 80, unit: 'percent' } } },
    }) })
    assert.deepEqual(b.calls.filter(([name]) => name === 'record.concat').at(-1)[1], [1, 0, 0, 0, 1, 0, 0, 0, 1])
  } finally { presenter.dispose() }
})

test('unit transform contract: f64 determinant range is independent of finite f32 inverse coefficients', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    for (const scale of [1e-30, 1e30]) {
      const current = { frame_id: 4, viewport: { ...box }, root: node('root', { background,
        style: { transform: { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 },
          transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } },
      }) }
      presenter.submit(current)
    }
    assert.equal(b.calls.filter(([name]) => name === 'record.drawRect').length, 2)
    assert.equal(presenter.generation, 2)
  } finally { presenter.dispose() }
})

test('unit transform contract: nonzero unrepresentable inverse rejects before recording without an overflow clip', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const retained = presenter.submit(frame()), before = b.calls.length
    for (const transform of [
      { a: 1e-40, b: 0, c: 0, d: 1, e: 0, f: 0 },
      { a: 1e-20, b: 0, c: 0, d: 1, e: 1e20, f: 0 },
    ]) {
      const current = { frame_id: 5, viewport: { ...box }, root: node('root', { background,
        style: { transform, transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } },
      }) }
      assert.throws(() => presenter.submit(current), coded('ERR_RENDER', /transform inverse exceeds finite Skia coordinates/))
      assert.equal(b.calls.length, before)
      assert.equal(presenter.lastReceipt, retained)
      assert.equal(presenter.generation, 1)
    }
  } finally { presenter.dispose() }
})

test('unit transform contract: cumulative nonzero underflow fails before recording and cannot become a zero-scale success', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const retained = presenter.submit(frame()), before = b.calls.length
    const style = { transform: { a: 1e-30, b: 0, c: 0, d: 1e-30, e: 0, f: 0 },
      transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } }
    const current = { frame_id: 5, viewport: { ...box }, root: node('root', {
      style, children: [node('underflow', { style, background })],
    }) }
    assert.throws(() => presenter.submit(current), coded('ERR_RENDER', /accumulated transform exceeds finite Skia coordinates/))
    assert.equal(b.calls.length, before)
    assert.equal(presenter.lastReceipt, retained)
    assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

test('unit contract: one-axis clips use inverse accumulated transform, including transformed ancestor and origin', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    // parent translate(20, 8), then child scale(2, 1) about its center (20, 20):
    // accumulated matrix is scale(2, 1) plus translation (0, 8).
    presenter.submit({ frame_id: 4, viewport: { ...box }, root: node('parent', {
      style: { transform: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 8 } }, children: [
        node('strip', { bounds: { x: 10, y: 10, width: 20, height: 20 }, computed_style: { overflow: 'visible clip' },
          style: { transform: { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 } }, children: [node('paint', { background })] }),
      ],
    }) })
    assert.deepEqual(b.calls.find(([name]) => name === 'record.clipRect')[1], [-1, 10, 33, 30])
  } finally { presenter.dispose() }
})

test('unit contract: non-finite accumulated transform and unrepresentable strips fail before recording', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const actual = { frame_id: 5, viewport: { ...box }, root: node('root', {
      style: { transform: { a: 1e200, b: 0, c: 0, d: 1, e: 0, f: 0 } }, children: [node('child', {
        style: { transform: { a: 1e200, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      })],
    }) }
    const before = b.calls.length
    assert.throws(() => presenter.submit(actual), coded('ERR_RENDER', /accumulated transform/))
    assert.equal(b.calls.length, before)
    // Matrix and inverse coefficients fit f32, but projecting the complete
    // viewport through the inverse would require an unrepresentable strip.
    actual.root.style.transform = { a: 1e-38, b: 0, c: 0, d: 1e-38, e: 0, f: 0 }
    actual.root.style.transform_origin = { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } }
    actual.root.children = []
    actual.root.computed_style = { overflow: 'visible clip' }
    assert.throws(() => presenter.submit(actual), coded('ERR_RENDER', /finite Skia coordinates/))
    assert.equal(b.calls.length, before)
  } finally { presenter.dispose() }
})

for (const [name, mutate] of [
  ['null border', style => { style.border = null }],
  ['three border sides', style => { style.border.pop() }],
  ['null border side', style => { style.border[2] = null }],
  ['negative border width', style => { style.border[0].width = -1 }],
  ['non-finite border width', style => { style.border[0].width = Infinity }],
  ['unrepresentable border width', style => { style.border[0].width = 1e39 }],
  ['opposing f32 width overflow', style => { style.border = borderSides(3e38) }],
  ['invalid border colour', style => { style.border[0].color.alpha = 256 }],
  ['invalid border style', style => { style.border[0].style = 'wavy' }],
  ['null box sizing', style => { style.box_sizing = null }],
  ['invalid box sizing', style => { style.box_sizing = 'padding-box' }],
  ['null padding', style => { style.padding = null }],
  ['null padding inset', style => { style.padding = { left: null } }],
  ['negative padding inset', style => { style.padding = { left: -1 } }],
  ['non-finite padding inset', style => { style.padding = { left: Infinity } }],
  ['unrepresentable content origin', style => { style.padding = { left: 1e39 } }],
]) test(`unit border contract: ${name} fails in preflight and preserves the accepted picture`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(frame()), before = b.calls.length
    const invalid = frame(); invalid.root.style = { border: borderSides() }; mutate(invalid.root.style)
    assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER'))
    assert.equal(b.calls.length, before, 'Preflight failure cannot allocate a recorder or mutate the visible canvas')
    assert.equal(presenter.lastReceipt, accepted)
    assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

for (const [width, style] of [['0px', 'none'], ['0px', 'solid'], ['12px', 'none'], ['medium', 'hidden']]) {
  test(`unit border serialization contract: omitted default sides admit inert ${width}/${style} computed borders including color longhands`, async () => {
    const b = fakeBackend(), presenter = await b.create()
    try {
      presenter.submit(frame())
      // This is Rust's serialized shape after skip_serializing_if removes
      // four default BorderSide records. It is not a fabricated zero array.
      const serialized = JSON.parse(JSON.stringify({ frame_id: 24, viewport: { ...box }, root: node('zero', {
        bounds: { x: 8, y: 8, width: 20, height: 10 }, style: {}, computed_style: computedBorders(width, style),
      }) }))
      assert.equal(Object.hasOwn(serialized.root.style, 'border'), false)
      const before = b.calls.length, receipt = presenter.submit(serialized)
      assert.equal(receipt.generation, 2)
      assert.equal(b.calls.slice(before).filter(([name]) => name === 'path.new').length, 0)
      assert.equal(b.calls.slice(before).filter(([name]) => name === 'visible.drawPicture').length, 1)
    } finally { presenter.dispose() }
  })
}

for (const [name, mutate, code] of [
  ['nonzero solid', computed => { computed['border-right-width'] = '1px'; computed['border-right-style'] = 'solid' }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['nonzero solid with zero-width siblings', computed => { computed['border-bottom-width'] = '3px'; computed['border-bottom-style'] = 'solid' }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['zero-width dashed', computed => { computed['border-top-style'] = 'dashed' }, 'ERR_UNSUPPORTED_CAPABILITY'],
  ['invalid style', computed => { computed['border-top-style'] = 'wavy' }, 'ERR_RENDER'],
  ['invalid width', computed => { computed['border-top-width'] = 'banana' }, 'ERR_RENDER'],
  ['negative width', computed => { computed['border-top-width'] = '-1px' }, 'ERR_RENDER'],
  ['border image', computed => { computed['border-image'] = 'url(border.png) 20 round' }, 'ERR_UNSUPPORTED_CAPABILITY'],
]) test(`unit border serialization contract: ${name} retains the accepted zero-border frame`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const acceptedFrame = frame(); acceptedFrame.root.style = {}; acceptedFrame.root.computed_style = computedBorders()
    const accepted = presenter.submit(acceptedFrame), before = b.calls.length
    const invalid = structuredClone(acceptedFrame); mutate(invalid.root.computed_style)
    assert.throws(() => presenter.submit(invalid), coded(code))
    assert.equal(b.calls.length, before)
    assert.equal(presenter.lastReceipt, accepted)
    assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

test('unit border serialization contract: none/hidden widths do not participate in opposing f32 overflow', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const actual = frame(); actual.root.style = { border: borderSides(3e38, undefined, 'none') }
    assert.equal(presenter.submit(actual).status, 'submitted')
    actual.root.style.border[1].style = 'hidden'
    assert.equal(presenter.submit(actual).generation, 2)
    assert.equal(b.calls.filter(([name]) => name === 'path.new').length, 0)
  } finally { presenter.dispose() }
})

for (const style of ['dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset']) {
  test(`unit border contract: ${style} remains explicitly unsupported even at zero width`, async () => {
    const b = fakeBackend(), presenter = await b.create()
    try {
      const accepted = presenter.submit(frame()), before = b.calls.length
      const invalid = frame(); invalid.root.style = { border: borderSides(0, undefined, style) }
      assert.throws(() => presenter.submit(invalid), coded('ERR_UNSUPPORTED_CAPABILITY', new RegExp(`border-style:${style}`)))
      assert.equal(b.calls.length, before)
      assert.equal(presenter.lastReceipt, accepted)
    } finally { presenter.dispose() }
  })
}

test('unit border contract: solid sides use a clipped ring, preserve content origin, and release every path/paint', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const colors = [
      { red: 255, green: 0, blue: 0, alpha: 255 }, { red: 0, green: 255, blue: 0, alpha: 255 },
      { red: 0, green: 0, blue: 255, alpha: 128 }, { red: 255, green: 255, blue: 0, alpha: 255 },
    ]
    const actual = { frame_id: 20, viewport: { ...box }, root: node('border', {
      bounds: { x: 8, y: 10, width: 40, height: 40 }, text: 'A', opacity: 0.5,
      style: { border: [2, 4, 6, 8].map((width, index) => borderSide(width, colors[index])),
        padding: { top: 3, right: 5, bottom: 7, left: 9 }, box_sizing: 'content-box' },
      computed_style: { border: '2px solid red', 'border-left-width': '8px', overflow: 'hidden' },
      // Descendant clips are applied when a child is painted; a leaf needs
      // no empty clip operation after its own border and text are complete.
      children: [node('descendant')],
    }) }
    const receipt = presenter.submit(actual)
    const paths = b.calls.filter(([name]) => name === 'path.new').map(call => call[1])
    assert.equal(paths.length, 4)
    for (const [side, commands] of paths.entries()) {
      assert.equal(commands[0], 0); assert.equal(commands.at(-1), 5)
      for (let offset = 0; offset < commands.length - 1; offset += 3) {
        const x = commands[offset + 1], y = commands[offset + 2]
        assert.ok(x >= 8 && x <= 48 && y >= 10 && y <= 50)
        const ratios = [(y - 10) / 2, (48 - x) / 4, (50 - y) / 6, (x - 8) / 8]
        assert.ok(ratios.every(ratio => ratios[side] <= ratio + 1e-12), 'Side region belongs to its minimum weighted edge distance')
      }
    }
    assert.deepEqual(b.calls.filter(([name]) => name === 'record.clipRect').map(call => call.slice(1)), [
      [[8, 10, 48, 50], 'intersect', false], [[16, 12, 44, 44], 'difference', false],
      [[25, 15, 39, 37], 'intersect', false], [[16, 12, 44, 44], 'intersect', false],
    ])
    assert.deepEqual(b.calls.filter(([name]) => name === 'paint.color').slice(0, 4).map(call => call[1]),
      colors.map(({ red, green, blue, alpha }) => [red, green, blue, alpha / 255]))
    assert.deepEqual(b.calls.find(([name]) => name === 'record.drawGlyphs').slice(3, 5), [25, 31])
    assert.equal(b.calls.filter(([name]) => name === 'path.delete').length, 4)
    assert.equal(b.calls.filter(([name]) => name === 'paint.delete').length, 6)
    assert.equal(b.calls.filter(([name]) => name === 'paint.antialias').filter(call => call[1] === false).length, 4)
    assert.equal(b.calls.filter(([name]) => name === 'record.save' || name === 'record.saveLayer').length, b.calls.filter(([name]) => name === 'record.restore').length)
    assert.equal(receipt.drawCommands, 5)
    assert.equal(receipt.runtimeBoundary.perNodeRuntimeCalls, 0)
  } finally { presenter.dispose() }
})

test('unit border contract: rounded padding clip subtracts the used asymmetric side widths from normalized outer radii', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit({ frame_id: 21, viewport: { ...box }, root: node('border', {
      bounds: { x: 8, y: 10, width: 40, height: 30 }, computed_style: { overflow: 'hidden' },
      style: { border: [2, 4, 6, 8].map(width => borderSide(width)), border_radius: Array.from({ length: 4 }, () => ({ x: 20, y: 20 })) },
      children: [node('descendant')],
    }) })
    const clips = b.calls.filter(([name]) => name === 'record.clipRRect').map(call => call.slice(1))
    assert.deepEqual(clips, [
      [[8, 10, 48, 40, 15, 15, 15, 15, 15, 15, 15, 15], 'intersect', false],
      [[16, 12, 44, 34, 7, 13, 11, 13, 11, 9, 7, 9], 'difference', false],
      [[16, 12, 44, 34, 7, 13, 11, 13, 11, 9, 7, 9], 'intersect', false],
    ])
  } finally { presenter.dispose() }
})

test('unit border contract: none/hidden use zero insets and an empty inner box does not erase the entire ring', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit({ frame_id: 22, viewport: { ...box }, root: node('border', {
      bounds: { x: 8, y: 10, width: 40, height: 30 }, text: 'A', computed_style: { overflow: 'hidden' },
      style: { border: ['none', 'hidden', 'none', 'hidden'].map(style => borderSide(999, undefined, style)) },
    }) })
    assert.equal(b.calls.filter(([name]) => name === 'path.new').length, 0)
    assert.deepEqual(b.calls.find(([name]) => name === 'record.drawGlyphs').slice(3, 5), [8, 26])
    const before = b.calls.length
    presenter.submit({ frame_id: 23, viewport: { ...box }, root: node('overwide', {
      bounds: { x: 8, y: 10, width: 20, height: 10 }, style: { border: borderSides(100) },
    }) })
    const calls = b.calls.slice(before)
    assert.equal(calls.filter(([name]) => name === 'record.clipRect').length, 1)
    assert.deepEqual(calls.find(([name]) => name === 'record.clipRect').slice(1), [[8, 10, 28, 20], 'intersect', false])
    const firstPath = calls.find(([name]) => name === 'path.new')[1]
    assert.ok(firstPath.some((value, index) => value === 18 && firstPath[index + 1] === 15), 'Overwide sides meet at the proportionally collapsed inner box')
  } finally { presenter.dispose() }
})

for (const [name, failure] of [['path allocation', { pathFailure: true }], ['path draw', { borderRecordingFailure: true }],
  ['path deletion', { cleanupFailure: 'path' }], ['paint deletion', { cleanupFailure: 'paint' }]]) {
  test(`unit border contract: ${name} failure retains the accepted visible picture and receipt`, async () => {
    const settings = {}, b = fakeBackend(settings), presenter = await b.create()
    try {
      const accepted = presenter.submit(frame()), before = b.calls.length
      Object.assign(settings, failure)
      const invalid = frame(); invalid.root.background = null; invalid.root.style = { border: borderSides() }
      assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER', /border|cleanup/))
      const calls = b.calls.slice(before)
      assert.equal(calls.some(([name]) => name.startsWith('visible.')), false)
      assert.equal(presenter.lastReceipt, accepted)
      assert.equal(presenter.generation, 1)
      assert.equal(calls.filter(([name]) => name === 'record.save').length, calls.filter(([name]) => name === 'record.restore').length)
      assert.equal(calls.filter(([name]) => name === 'recorder.delete').length, 1)
      assert.equal(calls.filter(([name]) => name === 'path.delete').length, settings.pathFailure ? 0 : 1)
      assert.equal(calls.filter(([name]) => name === 'paint.delete').length, settings.pathFailure ? 0 : 1)
    } finally { presenter.dispose() }
  })
}

test('unit contract: native-v1 records declared typography gaps; strict CSS rejects the same frame', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const requested = frame()
    requested.root.children[0].computed_style = { 'font-size': '40rpx', 'font-weight': '700' }
    const receipt = presenter.submit(requested)
    assert.equal(receipt.semanticGaps.length, 2)
    assert.equal(receipt.parityStatus, 'partial')
    presenter.options.typography = 'strict-css'
    const before = b.calls.length
    assert.throws(() => presenter.submit(requested), coded('ERR_UNSUPPORTED_CAPABILITY', /native-v1/))
    assert.equal(b.calls.length, before)
  } finally { presenter.dispose() }
})

const glyphPositions = calls => calls.filter(([name]) => name === 'record.drawGlyphs').flatMap(([,ids,positions,x,y]) => Array.from(ids, (_,i) => [x+positions[i*2],y+positions[i*2+1]]))
const textStyle = (font_size = 16, line_height = 'normal') => ({ font_size, line_height })
const textLayout = (glyphs, extra = {}) => ({
  measurement: 'native', metrics: { width: 30, height: 40, line_count: 2 },
  glyphs: glyphs.map(([character, x, baseline_y]) => ({ character, x, baseline_y })), ...extra,
})

test('unit text contract: committed native positions and size replay without measurement or reflow', async () => {
  const b = fakeBackend(), presenter = await b.create({ typography: 'strict-css' })
  try {
    const actual = { frame_id: 30, viewport: { ...box }, root: node('text', {
      text: 'A中\nB', bounds: { x: 4, y: 4, width: 10, height: 2 },
      text_style: textStyle(24, { px: 30 }), computed_style: { 'font-size': '24px', 'line-height': '30px' },
      text_layout: textLayout([['A', 0, 12], ['中', 22, 12], ['B', 0, 38]]),
    }) }
    const receipt = presenter.submit(actual)
    assert.deepEqual(b.calls.filter(([name]) => name === 'font.size').map(call => call[1]), [24])
    assert.equal(b.calls.some(([name]) => name === 'font.measure'), false, 'Accepted Rust positions must never be remeasured')
    assert.deepEqual(glyphPositions(b.calls), [[4, 16], [26, 16], [4, 42]])
    assert.equal(b.calls.some(([name]) => name === 'record.clipRect'), false, 'Line box cannot clip typed text ink')
    assert.deepEqual(receipt.textPlans, { native: 1, fallback: 0, local: 0, legacy: 0 })
    assert.equal(receipt.committedGlyphs, 3)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawGlyphs').length, 1, 'one accepted text plan uses one positioned glyph run')
    assert.deepEqual(receipt.semanticGaps, [])
  } finally { presenter.dispose() }
})

// A committed source-mapped plan carries the original text, including spaces
// which do not paint. Replay is positional and cannot normalize the source.
function sourceMappedTextFrame() {
  const source = ' A  B ', style = { white_space: 'normal', word_break: 'normal', text_align: 'start' }
  return { frame_id: 34, viewport: { ...box }, root: node('flow-text', {
    text: source, text_style: { font_size: 16, line_height: { px: 20 }, flow: style },
    computed_style: { 'white-space': 'normal', 'word-break': 'normal', 'text-align': 'start' },
    text_layout: {
      measurement: 'native', metrics: { width: 24, height: 20, line_count: 1 },
      glyphs: ['A', ' ', 'B'].map((character, index) => ({ character, x: index * 8, baseline_y: 14 })),
      flow: { version: 1, source_sha256: createHash('sha256').update(source).digest('hex'), style: { ...style },
        font_size: 16, line_height: { px: 20 }, available_width: 64, offset_x: 0, offset_y: 0,
        glyph_sources: [{ start: 1, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 5 }],
        lines: [{ glyph_start: 0, glyph_end: 3, source_start: 0, source_end: 6, x: 0, y: 0, width: 24, advance_width: 24,
          height: 20, baseline_y: 14, break_kind: 'end' }] },
    },
  }) }
}

test('unit text flow contract: source-mapped normalization replays accepted glyphs without reflow', async () => {
  const b = fakeBackend(), presenter = await b.create({ typography: 'strict-css' })
  try {
    const actual = sourceMappedTextFrame(), original = structuredClone(actual)
    const receipt = presenter.submit(actual)
    assert.equal(receipt.committedGlyphs, 3)
    assert.deepEqual(receipt.semanticGaps, [])
    assert.equal(b.calls.some(([name]) => name === 'font.measure'), false)
    assert.deepEqual(glyphPositions(b.calls), [[0, 14], [8, 14], [16, 14]])
    assert.deepEqual(actual, original, 'preflight and replay preserve raw source and accepted plan')
  } finally { presenter.dispose() }
})

for (const [label, mutate] of [
  ['source digest', n => { n.text_layout.flow.source_sha256 = '0'.repeat(64) }],
  ['source rewrite', n => { n.text = 'A B' }],
  ['collapsed source span', n => { n.text_layout.flow.glyph_sources[1].end = 3 }],
  ['source partition', n => { n.text_layout.flow.lines[0].source_start = 1 }],
  ['style binding', n => { n.text_style.flow.white_space = 'pre' }],
  ['line alignment', n => { n.text_layout.flow.lines[0].x = 1 }],
  ['content width', n => { n.text_layout.flow.available_width = 63 }],
  ['leaf offset', n => { n.text_layout.flow.offset_x = 1 }],
  ['glyph omission', n => { n.text_layout.glyphs.splice(1, 1) }],
  ['hard break source', n => { n.text_layout.flow.lines[0].break_kind = 'hard' }],
]) test(`unit text flow contract: invalid ${label} preserves accepted surface atomically`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(sourceMappedTextFrame()), before = b.calls.length
    const invalid = sourceMappedTextFrame(); mutate(invalid.root)
    assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER'))
    assert.equal(b.calls.length, before)
    assert.equal(presenter.lastReceipt, accepted)
    assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

test('unit text flow contract: computed flow without a typed plan fails explicitly', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const invalid = frame(); invalid.root.children[0].computed_style = { 'white-space': 'normal' }
    assert.throws(() => presenter.submit(invalid), coded('ERR_UNSUPPORTED_CAPABILITY', /text-flow/))
    assert.equal(presenter.lastReceipt, null)
  } finally { presenter.dispose() }
})

test('unit text contract: explicit local fallback uses resolved size, width and line height', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const actual = { frame_id: 31, viewport: { ...box }, root: node('text', {
      text: 'ABCD', bounds: { x: 4, y: 4, width: 10, height: 60 }, text_style: textStyle(10, { px: 20 }),
    }) }
    const receipt = presenter.submit(actual)
    assert.deepEqual(glyphPositions(b.calls), [[4, 14], [9, 14], [4, 34], [9, 34]])
    assert.deepEqual(receipt.textPlans, { native: 0, fallback: 0, local: 1, legacy: 0 })
    assert.ok(b.calls.filter(([name]) => name === 'font.measure').every(call => call[1] === 10))
  } finally { presenter.dispose() }
})

test('unit text contract: zero line-height retains ink; zero font-size draws no glyphs', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const actual = { frame_id: 32, viewport: { ...box }, root: node('text', {
      text: 'A\nB', bounds: { x: 4, y: 4, width: 40, height: 0 }, text_style: textStyle(20, { px: 0 }),
      text_layout: textLayout([['A', 0, -2], ['B', 0, -2]], { metrics: { width: 12, height: 0, line_count: 2 } }),
    }) }
    presenter.submit(actual)
    assert.deepEqual(glyphPositions(b.calls), [[4, 2], [4, 2]])
    assert.equal(b.calls.some(([name]) => name === 'record.clipRect'), false)
    const before = b.calls.length
    actual.root.text_style = textStyle(0, { number: 2 })
    presenter.submit(actual)
    assert.equal(b.calls.slice(before).some(([name]) => name === 'record.drawGlyphs'), false)
  } finally { presenter.dispose() }
})

for (const [name, mutate] of [
  ['negative font size', node => { node.text_style.font_size = -1 }],
  ['infinite font size', node => { node.text_style.font_size = Infinity }],
  ['invalid line-height kind', node => { node.text_style.line_height = 'auto' }],
  ['negative unitless line height', node => { node.text_style = textStyle(0, { number: -1 }) }],
  ['non-number line height', node => { node.text_style.line_height = { number: '2' } }],
  ['overflowing used line height', node => { node.text_style = textStyle(3e38, { number: 3 }) }],
  ['missing resolved style', node => { delete node.text_style }],
  ['unknown measurement', node => { node.text_layout.measurement = 'invented' }],
  ['mismatched text', node => { node.text = 'B' }],
  ['negative width', node => { node.text_layout.metrics.width = -1 }],
  ['invalid line count', node => { node.text_layout.metrics.line_count = 0 }],
  ['non-finite glyph', node => { node.text_layout.glyphs[0].baseline_y = Infinity }],
  ['negative glyph x', node => { node.text_layout.glyphs[0].x = -1 }],
  ['overflowing absolute glyph coordinate', node => { node.bounds.x = 3e38; node.text_layout.glyphs[0].x = 3e38 }],
  ['surrogate scalar', node => { node.text = '\uD800'; node.text_layout.glyphs[0].character = '\uD800' }],
]) test(`unit text contract: ${name} fails before recording and retains accepted receipt`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(frame()), before = b.calls.length
    const invalid = { frame_id: 33, viewport: { ...box }, root: node('text', {
      text: 'A', text_style: textStyle(16, { number: 1.5 }), text_layout: textLayout([['A', 0, 12]]),
    }) }
    mutate(invalid.root)
    assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER'))
    assert.equal(b.calls.length, before)
    assert.equal(presenter.lastReceipt, accepted)
    assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

test('unit contract: picture recording failure leaves the visible surface untouched and frees temporary objects', async () => {
  const b = fakeBackend({ recordingFailure: true }), presenter = await b.create()
  try {
    assert.throws(() => presenter.submit(frame()), coded('ERR_RENDER', /recording failed/))
    assert.equal(b.calls.some(([name]) => name.startsWith('visible.')), false)
    assert.ok(b.calls.some(([name]) => name === 'recorder.delete'))
    assert.equal(presenter.lastReceipt, null)
  } finally { presenter.dispose() }
})

test('unit contract: context loss, changed physical size and disposal stop future submission', async () => {
  const b = fakeBackend(), presenter = await b.create()
  presenter.canvas.width = 65
  assert.throws(() => presenter.submit(frame()), coded('ERR_RENDER', /resized/))
  presenter.canvas.width = 64
  let prevented = false
  b.listeners.get('webglcontextlost')({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.throws(() => presenter.submit(frame()), coded('ERR_RENDER', /context lost/))
  presenter.dispose()
  assert.throws(() => presenter.snapshotEvidence(), coded('ERR_RENDER', /unavailable/))
})

test('unit contract: cleanup continues after one destructor fails and reports the failure', async () => {
  const b = fakeBackend({ cleanupFailure: 'font' }), presenter = await b.create()
  assert.throws(() => presenter.dispose(), coded('ERR_RENDER', /font delete failed/))
  for (const name of ['font.delete', 'typeface.delete', 'surface.delete', 'context.delete', 'deleteContext']) assert.ok(b.calls.some(([actual]) => actual === name), name)
  assert.equal(b.listeners.size, 0)
})

test('unit contract: temporary picture cleanup still releases the recorder after a destructor failure', async () => {
  const b = fakeBackend({ cleanupFailure: 'picture' }), presenter = await b.create()
  try {
    assert.throws(() => presenter.submit(frame()), coded('ERR_RENDER', /picture delete failed/))
    assert.ok(b.calls.some(([name]) => name === 'recorder.delete'))
  } finally { presenter.dispose() }
})

test('unit contract: WebGL errors do not publish a successful receipt', async () => {
  const b = fakeBackend({ glError: 1282 }), presenter = await b.create()
  try {
    assert.throws(() => presenter.submit(frame()), coded('ERR_RENDER', /0x502/))
    assert.equal(presenter.lastReceipt, null)
    assert.equal(presenter.generation, 0)
  } finally { presenter.dispose() }
})

const imageResourceId = `sha256:${'1'.repeat(64)}`
const rgbaResource = (width = 4, height = 2) => ({ width, height,
  pixels: Array.from({ length: width * height }, (_, index) => [index * 19 % 256, index * 31 % 256, index * 47 % 256, 255]).flat() })
const imageFrame = (mode = 'scaleToFill', extra = {}) => ({ frame_id: 40, viewport: { ...box },
  images: { [imageResourceId]: rgbaResource() }, root: node('root', { children: [node('image', {
    tag: 'image', attributes: { src: 'local.png' }, bounds: { x: 8, y: 10, width: 2, height: 4 },
    image: { resource: imageResourceId, mode }, ...extra,
  })] }) })

for (const [mode, source, destination] of [
  ['scaleToFill', [0, 0, 4, 2], [8, 10, 10, 14]],
  ['widthFix', [0, 0, 4, 2], [8, 10, 10, 14]],
  ['heightFix', [0, 0, 4, 2], [8, 10, 10, 14]],
  ['aspectFit', [0, 0, 4, 2], [8, 11.5, 10, 12.5]],
  ['aspectFill', [1.5, 0, 2.5, 2], [8, 10, 10, 14]],
  ['top', [1, 0, 3, 2], [8, 10, 10, 12]],
  ['bottom', [1, 0, 3, 2], [8, 12, 10, 14]],
  ['center', [1, 0, 3, 2], [8, 11, 10, 13]],
  ['left', [0, 0, 2, 2], [8, 11, 10, 13]],
  ['right', [2, 0, 4, 2], [8, 11, 10, 13]],
  ['top left', [0, 0, 2, 2], [8, 10, 10, 12]],
  ['top right', [2, 0, 4, 2], [8, 10, 10, 12]],
  ['bottom left', [0, 0, 2, 2], [8, 12, 10, 14]],
  ['bottom right', [2, 0, 4, 2], [8, 12, 10, 14]],
]) test(`unit image contract: ${mode} uses committed source/destination and nearest sampling`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const receipt = presenter.submit(imageFrame(mode)), draw = b.calls.find(([name]) => name === 'record.drawImageRectOptions')
    assert.deepEqual(draw.slice(2, 6), [source, destination, 'nearest', 'none'])
    assert.deepEqual(b.calls.find(([name]) => name === 'image.new').slice(1), [
      { width: 4, height: 2, colorType: 'rgba8', alphaType: 'unpremul', colorSpace: 'srgb' },
      Uint8Array.from(rgbaResource().pixels), 16,
    ])
    assert.equal(receipt.imageResources, 1); assert.equal(receipt.imageNodes, 1); assert.equal(receipt.imageBytes, 32)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 0, 'accepted image remains cached')
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
  assert.ok(b.calls.findIndex(([name]) => name === 'picture.delete') < b.calls.findIndex(([name]) => name === 'resourceImage.delete'))
})

test('unit image contract: one image per resource table entry, content-box clipping, own radius and inherited transform/opacity', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const current = imageFrame('bottom right', { bounds: { x: 8, y: 10, width: 20, height: 20 }, opacity: 0.5,
      style: { border: borderSides(2), padding: { top: 2, right: 2, bottom: 2, left: 2 },
        border_radius: Array.from({ length: 4 }, () => ({ x: 8, y: 8 })) } })
    current.images[imageResourceId] = rgbaResource(2, 1)
    current.root.opacity = 0.5
    current.root.style = { transform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 6 } }
    current.root.children.push(node('shared-image', { image: { resource: imageResourceId, mode: 'scaleToFill' } }))
    presenter.submit(current)
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawImageRectOptions').length, 2)
    const first = b.calls.find(([name]) => name === 'record.drawImageRectOptions')
    assert.deepEqual(first.slice(2, 4), [[0, 0, 2, 1], [22, 25, 24, 26]])
    assert.equal(b.calls.filter(([name, value]) => name === 'paint.alpha' && value === 128 / 255).length, 2)
    assert.ok(b.calls.some(([name, value]) => name === 'paint.alpha' && value === 1), 'image alpha belongs to its opaque group contents')
    assert.ok(b.calls.some(([name, value]) => name === 'record.clipRect' && JSON.stringify(value) === '[12,14,24,26]'))
    assert.ok(b.calls.some(([name, value]) => name === 'record.clipRRect' && JSON.stringify(value.slice(0, 4)) === '[8,10,28,30]'))
    assert.ok(b.calls.some(([name, value]) => name === 'record.concat' && value[2] === 4 && value[5] === 6))
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 0)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
})

test('unit image contract: empty image src and zero content box paint no image pixels', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const current = imageFrame('scaleToFill', { bounds: { x: 8, y: 8, width: 4, height: 4 },
      style: { padding: { top: 2, right: 2, bottom: 2, left: 2 } } })
    current.root.children.push(node('empty-image', { tag: 'image', attributes: { src: '' } }))
    presenter.submit(current)
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 1)
    assert.equal(b.calls.some(([name]) => name === 'record.drawImageRectOptions'), false)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 0)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
})

const invalidImageFrames = [
  ['table', value => { value.images = [] }],
  ['missing resource', value => { value.images = {} }],
  ['missing mode', value => { delete value.root.children[0].image.mode }],
  ['mode', value => { value.root.children[0].image.mode = 'unknown' }],
  ['reference type', value => { value.root.children[0].image.resource = null }],
  ['resource ID', value => { value.images['invalid id'] = rgbaResource() }],
  ['resource ID length', value => { value.images['x'.repeat(257)] = rgbaResource() }],
  ['resource ID newline', value => { value.images['valid\n'] = rgbaResource() }],
  ['resource ID unicode', value => { value.images['图像'] = rgbaResource() }],
  ['resource shape', value => { value.images[imageResourceId] = null }],
  ['zero dimension', value => { value.images[imageResourceId].width = 0 }],
  ['fractional dimension', value => { value.images[imageResourceId].width = 1.5 }],
  ['dimension limit', value => { value.images[imageResourceId].width = 8193 }],
  ['pixel limit', value => { value.images[imageResourceId] = { width: 8192, height: 8192, pixels: [] } }],
  ['byte length', value => { value.images[imageResourceId].pixels.pop() }],
  ['byte range', value => { value.images[imageResourceId].pixels[0] = 256 }],
  ['byte type', value => { value.images[imageResourceId].pixels[0] = '0' }],
  ['sparse bytes', value => { delete value.images[imageResourceId].pixels[0] }],
  ['resource count', value => { value.images = Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [String(i), rgbaResource(1, 1)])) }],
  ['frame bytes', value => { const big = { width: 4096, height: 4096, pixels: Array(64 * 1024 * 1024) };
    value.images = { a: big, b: big, c: rgbaResource(1, 1) } }],
]
for (const [name, mutate] of invalidImageFrames) test(`unit image contract: ${name} is rejected before recording and keeps accepted frame`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const accepted = presenter.submit(imageFrame()), before = b.calls.length
    const invalid = imageFrame(); mutate(invalid)
    assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER'))
    assert.equal(b.calls.length, before); assert.equal(presenter.lastReceipt, accepted); assert.equal(presenter.generation, 1)
  } finally { presenter.dispose() }
})

for (const [name, settings, deleted] of [
  ['resource creation', { imageCreationFailureAt: 2 }, 1],
  ['picture recording', { imageRecordingFailure: true }, 2],
]) test(`unit image contract: ${name} failure releases all images and retains accepted surface`, async () => {
  const b = fakeBackend(settings), presenter = await b.create()
  try {
    const accepted = presenter.submit(frame()), before = b.calls.length, current = imageFrame()
    current.images.second = rgbaResource(1, 1)
    assert.throws(() => presenter.submit(current), coded('ERR_RENDER'))
    const calls = b.calls.slice(before)
    assert.equal(calls.filter(([name]) => name === 'resourceImage.delete').length, deleted)
    assert.equal(calls.some(([name]) => name === 'visible.clear' || name === 'visible.drawPicture'), false)
    assert.equal(presenter.lastReceipt, accepted); assert.equal(presenter.generation, 1)
    assert.equal(calls.filter(([name]) => name === 'record.save').length, calls.filter(([name]) => name === 'record.restore').length)
  } finally { presenter.dispose() }
})

test('unit image contract: submission and destructor failures release all prepared resources', async () => {
  for (const settings of [{ glError: 0x0502 }, { cleanupFailure: 'resourceImage' }]) {
    const b = fakeBackend(settings), presenter = await b.create({ imageCacheBytes: 0 })
    try {
      const current = imageFrame(); current.images.second = rgbaResource(1, 1)
      assert.throws(() => presenter.submit(current), coded('ERR_RENDER', /0x502|cleanup/))
      assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 2)
      assert.equal(b.calls.filter(([name]) => name === 'picture.delete').length, 1)
      assert.equal(b.calls.filter(([name]) => name === 'recorder.delete').length, 1)
    } finally { presenter.dispose() }
  }
})

test('unit image cache: independently decoded equal frames reuse one SkImage without GPU waits', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const first = presenter.submit(imageFrame())
    const acceptedImage = b.calls.find(([name]) => name === 'record.drawImageRectOptions')[1]
    const next = imageFrame(); next.frame_id++
    const second = presenter.submit(next)
    assert.equal(first.imageCache.misses, 1)
    assert.equal(second.imageCache.hits, 1)
    assert.equal(second.imageCache.misses, 0)
    assert.equal(second.imageCache.entries, 1)
    assert.equal(second.imageCache.accountedBytes, 64)
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 0)
    assert.equal(b.calls.filter(([name]) => name === 'gl.finish').length, 0)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawImageRectOptions').at(-1)[1], acceptedImage)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
  assert.ok(b.calls.findIndex(([name]) => name === 'resourceImage.delete') < b.calls.findIndex(([name]) => name === 'context.delete'))
})

test('unit image cache: resource ID cannot conceal changed bytes, caller mutation or dimensions', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const current = imageFrame()
    presenter.submit(current)
    current.images[imageResourceId].pixels[0] = 255
    const changed = presenter.submit(current)
    assert.equal(changed.imageCache.hits, 0)
    assert.equal(changed.imageCache.misses, 1)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
    const dimensions = imageFrame()
    dimensions.images[imageResourceId] = { width: 2, height: 4, pixels: [...current.images[imageResourceId].pixels] }
    const resized = presenter.submit(dimensions)
    assert.equal(resized.imageCache.hits, 0)
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 3)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 2)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 3)
})

test('unit image cache: remote Uint8Array pixels share the same validation and independently owned cache contract', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const current = imageFrame()
    current.images[imageResourceId].pixels = Uint8Array.from(current.images[imageResourceId].pixels)
    assert.equal(presenter.submit(current).imageCache.misses, 1)
    assert.equal(presenter.submit(imageFrame()).imageCache.hits, 1, 'array and typed bytes have equal pixel identity')
    current.images[imageResourceId].pixels[0] ^= 255
    assert.equal(presenter.submit(current).imageCache.misses, 1, 'retained validation bytes cannot alias the transport buffer')
  } finally { presenter.dispose() }
})

test('unit image cache: failed replacement releases staged images and preserves accepted ownership', async () => {
  const settings = {}, b = fakeBackend(settings), presenter = await b.create()
  try {
    const original = imageFrame(), accepted = presenter.submit(original)
    const originalImage = b.calls.find(([name]) => name === 'record.drawImageRectOptions')[1]
    const changed = imageFrame(); changed.images[imageResourceId].pixels[0] = 255
    settings.imageRecordingFailure = true
    const before = b.calls.length
    assert.throws(() => presenter.submit(changed), coded('ERR_RENDER', /image recording/))
    const failedCalls = b.calls.slice(before)
    assert.equal(failedCalls.filter(([name]) => name === 'resourceImage.delete').length, 1)
    assert.equal(failedCalls.some(([name]) => name.startsWith('visible.')), false)
    assert.equal(presenter.lastReceipt, accepted)
    settings.imageRecordingFailure = false
    const recovered = presenter.submit(original)
    assert.equal(recovered.imageCache.hits, 1)
    assert.equal(recovered.imageCache.misses, 0)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawImageRectOptions').at(-1)[1], originalImage)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 2)
})

test('unit image cache: cache hits survive a later staged allocation failure', async () => {
  const settings = {}, b = fakeBackend(settings), presenter = await b.create()
  try {
    const accepted = presenter.submit(imageFrame()), current = imageFrame()
    current.images.second = rgbaResource(1, 1)
    current.images.third = rgbaResource(1, 2)
    settings.imageCreationFailureAt = 3
    assert.throws(() => presenter.submit(current), coded('ERR_RENDER', /image resource creation/))
    assert.equal(presenter.lastReceipt, accepted)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
    assert.equal(presenter.submit(imageFrame()).imageCache.hits, 1)
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 3)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 2)
})

test('unit image cache: bounded LRU counts CPU copies and images and keeps oversized resources temporary', async () => {
  const b = fakeBackend(), presenter = await b.create({ imageCacheBytes: 16 })
  const small = id => ({ frame_id: 1, viewport: { ...box }, images: { [id]: rgbaResource(1, 1) },
    root: node(id, { image: { resource: id, mode: 'scaleToFill' } }) })
  try {
    presenter.submit(small('a')); presenter.submit(small('b'))
    assert.equal(presenter.submit(small('a')).imageCache.hits, 1, 'accepted access refreshes LRU order')
    const third = presenter.submit(small('c'))
    assert.equal(third.imageCache.entries, 2)
    assert.equal(third.imageCache.accountedBytes, 16)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
    assert.equal(presenter.submit(small('a')).imageCache.hits, 1)
    assert.equal(presenter.submit(small('b')).imageCache.misses, 1, 'least recently used b was evicted')
    const before = b.calls.filter(([name]) => name === 'resourceImage.delete').length
    const oversized = presenter.submit(imageFrame())
    assert.equal(oversized.status, 'submitted', 'cache budget does not reduce quality or reject an otherwise valid frame')
    assert.equal(oversized.imageCache.entries, 2)
    assert.equal(oversized.imageCache.accountedBytes, 16)
    assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, before + 1)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, b.calls.filter(([name]) => name === 'image.new').length)
})

test('unit image cache: context loss drops owned images and disposal does not release them twice', async () => {
  const b = fakeBackend(), presenter = await b.create()
  presenter.submit(imageFrame())
  b.listeners.get('webglcontextlost')({ preventDefault() {} })
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
  assert.throws(() => presenter.submit(imageFrame()), coded('ERR_RENDER', /context lost/))
  presenter.dispose()
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
  assert.equal(b.listeners.size, 0)
})

test('unit image cache: destructor failures release remaining owners and stay observable after context loss', async () => {
  const settings = {}, b = fakeBackend(settings), presenter = await b.create()
  const current = imageFrame(); current.images.second = rgbaResource(1, 1)
  presenter.submit(current)
  settings.cleanupFailure = 'resourceImage'
  b.listeners.get('webglcontextlost')({ preventDefault() {} })
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 2)
  assert.throws(() => presenter.dispose(), coded('ERR_RENDER', /resourceImage delete failed/))
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 2)
  for (const name of ['surface.delete', 'context.delete', 'deleteContext']) assert.ok(b.calls.some(([actual]) => actual === name))
  assert.equal(b.listeners.size, 0)
  presenter.dispose()
})

test('unit image cache: invalid budgets fail before browser or GPU resource allocation', async () => {
  for (const imageCacheBytes of [-1, 1.5, NaN, 64 * 1024 * 1024 + 1]) {
    const b = fakeBackend()
    await assert.rejects(b.create({ imageCacheBytes }), coded('ERR_RENDER', /cache byte budget/))
    assert.equal(b.calls.length, 0)
  }
})

const dependencyDir = process.env.WEAPP_CONTAINER_TEST_CANVASKIT_DIR
const fontPath = process.env.WEAPP_CONTAINER_TEST_CANVASKIT_FONT

// These authored commands are fixtures for the consumer wire contract, not a
// second CSS stacking compiler. Native layout owns construction of each plan.
const paintCommand = (op, ...path) => ({ op, path })
const paintBox = (...path) => [paintCommand('background', ...path), paintCommand('content', ...path)]
const paintContext = (path, children = []) => [paintCommand('begin', ...path),
  paintCommand('background', ...path), paintCommand('content', ...path), ...children, paintCommand('end', ...path)]
const plannedFrame = (root, commands) => ({ frame_id: 60, viewport: { ...box }, root,
  paintPlan: { version: 1, commands: commands ?? paintContext([], root.children.flatMap((_, index) => paintBox(index))) } })
const stackingFixture = (sealed = false) => plannedFrame(node('root', {
  background: { red: 255, green: 255, blue: 255, alpha: 255 }, style: { flow: { context: 'block' } }, children: [
    node('ordinary', { style: { position: 'relative', ...(sealed ? { z_index: 0 } : {}) }, children: [
      node('hoisted', { background: { red: 255, green: 0, blue: 0, alpha: 255 }, style: { position: 'relative', z_index: 2 } }),
    ] }),
    node('sibling', { background: { red: 0, green: 0, blue: 255, alpha: 255 }, style: { position: 'relative', z_index: 1 } }),
  ],
}), sealed ? paintContext([], [...paintContext([0], paintContext([0, 0])), ...paintContext([1])])
  : paintContext([], [...paintBox(0), ...paintContext([1]), ...paintContext([0, 0])]))

test('unit paintPlan contract: committed order replaces recursive legacy z order and records the boundary', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    for (const [sealed, expected] of [[false, [[255, 255, 255], [0, 0, 255], [255, 0, 0]]],
      [true, [[255, 255, 255], [255, 0, 0], [0, 0, 255]]]]) {
      const start = b.calls.length, current = stackingFixture(sealed), original = structuredClone(current)
      const receipt = presenter.submit(current)
      assert.deepEqual(b.calls.slice(start).filter(([name]) => name === 'paint.color').map(([, rgba]) => rgba.slice(0, 3)), expected)
      assert.deepEqual(receipt.paintOrder, { contract: 'committed-paint-plan-v1', commands: current.paintPlan.commands.length })
      assert.equal(b.calls.slice(start).filter(([name]) => name === 'record.saveLayer').length, 0, 'ordinary stacking contexts own no opacity backing')
      assert.deepEqual(current, original, 'consumer preserves original DOM order and the committed command stream')
    }
    assert.deepEqual(presenter.submit(frame()).paintOrder, { contract: 'legacy-recursive-v1', cssStackingOracle: false })
  } finally { presenter.dispose() }
})

test('visibility wire keeps hidden contexts and visible descendants without accepting hidden ink or omitted visible ink', async () => {
  const b=fakeBackend(),presenter=await b.create()
  const current=plannedFrame(node('root',{background:{red:255,green:255,blue:255,alpha:255},style:{flow:{context:'block'}},children:[
    node('hidden',{visibility:'hidden',computed_style:{visibility:'hidden'},text:'H',opacity:.5,background:{red:255,green:0,blue:0,alpha:255},children:[
      node('visible',{visibility:'visible',computed_style:{visibility:'visible'},text:'V',background:{red:0,green:0,blue:255,alpha:255}}),
    ]}),
  ]}),paintContext([],[paintCommand('begin',0),...paintBox(0,0),paintCommand('end',0)]))
  try {
    const start=b.calls.length;presenter.submit(current)
    assert.deepEqual(b.calls.slice(start).filter(([name])=>name==='paint.color').map(([,rgba])=>rgba.slice(0,3)),[[255,255,255],[0,0,255],[0,0,0]])
    assert.equal(b.calls.slice(start).filter(([name])=>name==='record.saveLayer').length,1)
    assert.equal(b.calls.slice(start).filter(([name])=>name==='record.drawGlyphs').length,1)
    const hiddenInk=structuredClone(current);hiddenInk.paintPlan.commands.splice(4,0,...paintBox(0));assert.throws(()=>presenter.submit(hiddenInk),coded('ERR_RENDER',/outside/))
    const missing=structuredClone(current);missing.paintPlan.commands=missing.paintPlan.commands.filter(c=>!(c.op==='content'&&c.path.length===2));assert.throws(()=>presenter.submit(missing),coded('ERR_RENDER',/omits/))
    for(const visibility of ['collapse','inherit',false,null,undefined]){const invalid=structuredClone(current);invalid.root.children[0].visibility=visibility;assert.throws(()=>presenter.submit(invalid),coded('ERR_UNSUPPORTED_CAPABILITY',/visibility/))}
    const conflict=structuredClone(current);conflict.root.children[0].computed_style.visibility='visible';assert.throws(()=>presenter.submit(conflict),coded('ERR_UNSUPPORTED_CAPABILITY',/visibility/))
    const legacy=structuredClone(current);delete legacy.paintPlan;delete legacy.root.style;const before=b.calls.length;presenter.submit(legacy)
    assert.deepEqual(b.calls.slice(before).filter(([name])=>name==='paint.color').map(([,rgba])=>rgba.slice(0,3)),[[255,255,255],[0,0,255],[0,0,0]])
    assert.equal(b.calls.slice(before).filter(([name])=>name==='record.drawGlyphs').length,1)
  }finally{presenter.dispose()}
})

const malformedPaintPlans = [
  ['null plan', value => { value.paintPlan = null }],
  ['unknown version', value => { value.paintPlan.version = 2 }],
  ['arbitrary plan metadata', value => { value.paintPlan.opacity = .5 }],
  ['non-array commands', value => { value.paintPlan.commands = {} }],
  ['sparse commands', value => { delete value.paintPlan.commands[2] }],
  ['unknown op', value => { value.paintPlan.commands[1].op = 'layer' }],
  ['arbitrary layer alpha', value => { value.paintPlan.commands[0].alpha = .25 }],
  ['missing path', value => { delete value.paintPlan.commands[1].path }],
  ['negative path', value => { value.paintPlan.commands[1].path = [-1] }],
  ['fractional path', value => { value.paintPlan.commands[1].path = [.5] }],
  ['sparse path', value => { value.paintPlan.commands[1].path = Array(1) }],
  ['absent path', value => { value.paintPlan.commands[1].path = [3] }],
  ['deep path', value => { value.paintPlan.commands[1].path = Array(257).fill(0) }],
  ['duplicate background', value => { value.paintPlan.commands.splice(2, 0, paintCommand('background')) }],
  ['missing content', value => { value.paintPlan.commands.splice(2, 1) }],
  ['content before background', value => { [value.paintPlan.commands[1], value.paintPlan.commands[2]] = [value.paintPlan.commands[2], value.paintPlan.commands[1]] }],
  ['missing root begin', value => { value.paintPlan.commands.shift() }],
  ['missing root end', value => { value.paintPlan.commands.pop() }],
  ['mismatched context end', value => { value.paintPlan.commands.at(-2).path = [] }],
  ['hidden subtree paint', value => { value.root.children[1].style.display = 'none' }],
  ['missing true context', value => { value.root.children[0].style.z_index = 0 }],
  ['invented ordinary context', value => { value.paintPlan.commands = paintContext([], [...paintContext([0], paintContext([0, 0])), ...paintContext([1])]) }],
  ['escaped true context', value => { value.root.children[0].opacity = .5 }],
  ['context child painted outside begin/end', value => { value.paintPlan.commands.splice(8, 0, paintCommand('background', 0, 0)) }],
]
for (const [label, mutate] of malformedPaintPlans) test(`unit paintPlan contract: ${label} rejects before recording or surface mutation`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const receipt = presenter.submit(stackingFixture()), before = b.calls.length, invalid = stackingFixture()
    mutate(invalid)
    assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER'))
    assert.equal(b.calls.length, before, 'complete plan preflight precedes resource creation and picture recording')
    assert.equal(presenter.lastReceipt, receipt)
  } finally { presenter.dispose() }
})

for (const [name, value] of [['fractional z', { z_index: .5 }], ['null z', { z_index: null }],
  ['out-of-range z', { z_index: 2147483648 }], ['string isolation', { isolation: 'isolate' }]]) {
  test(`unit paintPlan contract: ${name} fails typed metadata preflight`, async () => {
    const b = fakeBackend(), presenter = await b.create()
    try {
      const invalid = stackingFixture(); Object.assign(invalid.root.children[0].style, value)
      const before = b.calls.length
      assert.throws(() => presenter.submit(invalid), coded('ERR_RENDER', /typed stacking/))
      assert.equal(b.calls.length, before)
    } finally { presenter.dispose() }
  })
}

test('unit paintPlan contract: typed stacking metadata requires a plan, including explicit zero and false', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    for (const style of [{ z_index: 0 }, { isolation: false }, { isolation: true }]) {
      const invalid = frame(); invalid.root.style = style
      const before = b.calls.length
      assert.throws(() => presenter.submit(invalid), coded('ERR_UNSUPPORTED_CAPABILITY', /paintPlan/))
      assert.equal(b.calls.length, before)
    }
  } finally { presenter.dispose() }
})

test('unit paintPlan contract: genuine context triggers are validated independently of the incoming commands', async () => {
  const b = fakeBackend(), presenter = await b.create()
  const triggers = [
    [{ position: 'fixed' }, {}], [{ position: 'relative', z_index: 0 }, {}],
    [{ position: 'absolute', z_index: -1 }, {}], [{ isolation: true }, {}],
    [{ transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }, {}],
    [{ z_index: 0 }, { flow: { context: 'flex' } }],
  ]
  try {
    for (const [style, parentStyle] of triggers) {
      const root = node('root', { style: parentStyle, children: [node('context', { style })] })
      assert.doesNotThrow(() => presenter.validate(plannedFrame(root, paintContext([], paintContext([0])))))
      assert.throws(() => presenter.validate(plannedFrame(root)), coded('ERR_RENDER', /context/))
    }
    for (const opacity of [0, .5]) {
      const root = node('root', { children: [node('context', { opacity })] })
      assert.doesNotThrow(() => presenter.validate(plannedFrame(root, paintContext([], paintContext([0])))))
      assert.throws(() => presenter.validate(plannedFrame(root)), coded('ERR_RENDER', /context/))
    }
    for (const style of [{ z_index: 3 }, { position: 'relative' }, { position: 'absolute' }, { isolation: false }]) {
      const root = node('root', { children: [node('ordinary', { style })] })
      assert.doesNotThrow(() => presenter.validate(plannedFrame(root)))
      assert.throws(() => presenter.validate(plannedFrame(root, paintContext([], paintContext([0])))), coded('ERR_RENDER', /context/))
    }
    const unsupported = plannedFrame(node('transformed-root', {
      style: { transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      children: [node('fixed', { style: { position: 'fixed', flow: {} } })],
    }), paintContext([], paintContext([0])))
    assert.throws(() => presenter.preflightPaintPlan(unsupported), coded('ERR_UNSUPPORTED_CAPABILITY', /transformed containing block/))
  } finally { presenter.dispose() }
})

test('unit paintPlan contract: opacity groups unwind recording errors and zero opacity keeps commands without painting', async () => {
  const b = fakeBackend({ recordingFailure: true }), presenter = await b.create()
  const root = node('root', { children: [node('opacity', { opacity: .5, text: 'A' })] })
  const current = plannedFrame(root, paintContext([], paintContext([0])))
  try {
    assert.throws(() => presenter.submit(current), coded('ERR_RENDER', /recording failed/))
    assert.equal(b.calls.filter(([name]) => name === 'record.saveLayer').length, 1)
    assert.equal(b.calls.filter(([name]) => name === 'visible.clear').length, 0)
    assert.equal(b.calls.filter(([name]) => name === 'paint.delete').length, 2, 'failed content and group paint released')
    current.root.children[0].opacity = 0
    const start = b.calls.length
    presenter.submit(current)
    assert.equal(b.calls.slice(start).filter(([name]) => name === 'record.saveLayer' || name === 'record.drawGlyphs').length, 0)
  } finally { presenter.dispose() }
})

test('unit paintPlan contract: DOM path budget counts each node once and includes hidden descendants', async () => {
  const b = fakeBackend(), presenter = await b.create()
  const make = (branches, hidden) => {
    const children = [], commands = [paintCommand('begin'), ...paintBox()]
    for (let branch = 0; branch < branches; branch++) {
      const first = node(`branch-${branch}`, { style: hidden ? { display: 'none' } : {} })
      children.push(first)
      let current = first, path = [branch]
      for (let depth = 1; depth <= 128; depth++) {
        if (!hidden) commands.push(...paintBox(...path))
        if (depth !== 128) {
          const child = node(`${branch}-${depth}`); current.children.push(child); current = child; path = [...path, 0]
        }
      }
    }
    commands.push(paintCommand('end'))
    return plannedFrame(node('root', { children }), commands)
  }
  try {
    // 121 * sum(1..128) = 998,976. Counting both paint commands as new
    // DOM paths would incorrectly reject this accepted Rust-sized corpus.
    assert.doesNotThrow(() => presenter.preflightPaintPlan(make(121, false)))
    const before = b.calls.length
    assert.throws(() => presenter.preflightPaintPlan(make(122, true)), coded('ERR_RENDER', /path entry budget/))
    assert.equal(b.calls.length, before, 'aggregate admission allocates no CanvasKit resources')
  } finally { presenter.dispose() }
})

test('real CanvasKit 0.42.0 CPU paintPlan: hoisting, context closure, split phases and DOM clips (not WebGL/GPU)', {
  skip: !dependencyDir ? 'blocked: provide WEAPP_CONTAINER_TEST_CANVASKIT_DIR; no dependency download or substitute backend' : false,
}, async () => {
  const sdk = [
    ['bin/full/canvaskit.js', '894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5'],
    ['bin/full/canvaskit.wasm', 'aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959'],
  ]
  for (const [name, expected] of sdk) assert.equal(createHash('sha256').update(await readFile(resolve(dependencyDir, name))).digest('hex'), expected)
  assert.equal(JSON.parse(await readFile(resolve(dependencyDir, 'package.json'))).version, '0.42.0')
  const init = createRequire(import.meta.url)(resolve(dependencyDir, sdk[0][0]))
  const CK = await init({ locateFile: name => resolve(dependencyDir, 'bin/full', name) })
  const font = new CK.Font(null, 16), surface = CK.MakeSurface(64, 64)
  assert.ok(surface); assert.equal(surface.reportBackendTypeIsGPU(), false)
  const presenter = Object.create(CanvasKitFramePresenter.prototype)
  Object.assign(presenter, { CK, font, surface, canvas: { width: 64, height: 64 }, physicalSize: [64, 64],
    options: { typography: 'native-v1' }, gl: { isContextLost: () => false } })
  const red = { red: 255, green: 0, blue: 0, alpha: 255 }, green = { red: 0, green: 128, blue: 0, alpha: 255 }
  const blue = { red: 0, green: 0, blue: 255, alpha: 255 }, white = { red: 255, green: 255, blue: 255, alpha: 255 }
  const root = children => node('root', { background: white, style: { flow: { context: 'block' } }, children })
  const rgba = value => [value.red, value.green, value.blue, value.alpha]
  let frames = 0, freedRecorders = 0, freedPictures = 0, freedSnapshots = 0
  const render = (current, label, samples) => {
    const before = structuredClone(current), stats = presenter.validate(current)
    let recorder, picture, image, images
    try {
      images = presenter.createImages(current)
      recorder = new CK.PictureRecorder()
      presenter.drawFrame(recorder.beginRecording([0, 0, 64, 64]), current, stats, images)
      picture = recorder.finishRecordingAsPicture(); assert.ok(picture)
      const canvas = surface.getCanvas(); canvas.clear(CK.TRANSPARENT); canvas.drawPicture(picture); surface.flush()
      image = surface.makeImageSnapshot(); assert.ok(image)
      const actual = image.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888,
        alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB })
      assert.equal(actual.length, 64 * 64 * 4)
      for (const [x, y, expected] of samples) {
        const offset = (y * 64 + x) * 4
        assert.deepEqual([...actual.subarray(offset, offset + 4)], expected, `${label}: (${x},${y})`)
      }
      assert.deepEqual(current, before, `${label}: original DOM and command stream are immutable`)
      frames++
      return Buffer.from(actual)
    } finally {
      if (image) { image.delete(); freedSnapshots++ }
      if (picture) { picture.delete(); freedPictures++ }
      if (recorder) { recorder.delete(); freedRecorders++ }
      for (const resource of images?.values() ?? []) resource.delete()
    }
  }
  try {
    render(stackingFixture(), 'positive grandchild escapes relative auto', [[20, 20, rgba(red)]])
    render(stackingFixture(true), 'explicit zero seals grandchild', [[20, 20, rgba(blue)]])
    for (const [label, style, opacity] of [
      ['identity transform', { transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }, 1],
      ['isolation', { isolation: true }, 1],
      ['opacity', {}, .5],
    ]) {
      const current = stackingFixture(true)
      current.root.children[0].style = style; current.root.children[0].opacity = opacity
      render(current, `${label} seals positive grandchild`, [[20, 20, rgba(blue)]])
    }
    const negative = sealed => plannedFrame(root([node('ordinary', { background: green,
      style: { position: 'relative', ...(sealed ? { z_index: 0 } : {}) }, children: [
        node('negative', { background: red, style: { position: 'relative', z_index: -1 } }),
      ] })]), sealed ? paintContext([], [paintCommand('begin', 0), paintCommand('background', 0),
        ...paintContext([0, 0]), paintCommand('content', 0), paintCommand('end', 0)])
      : [paintCommand('begin'), paintCommand('background'), ...paintContext([0, 0]), paintCommand('background', 0),
        paintCommand('content'), paintCommand('content', 0), paintCommand('end')])
    render(negative(false), 'negative grandchild is below ordinary ancestor background', [[20, 20, rgba(green)]])
    render(negative(true), 'context background precedes its negative child', [[20, 20, rgba(red)]])

    const grouped = plannedFrame(root([node('group', { opacity: .5, background: red,
      children: [node('overlap', { background: blue })] })]), paintContext([], [paintCommand('begin', 0),
      paintCommand('background', 0), paintCommand('content', 0), ...paintBox(0, 0), paintCommand('end', 0)]))
    render(grouped, 'overlapping contents composite alpha once', [[20, 20, [127, 127, 255, 255]]])
    grouped.root.children[0].opacity = 0
    render(grouped, 'zero opacity is paintless while its context commands remain', [[20, 20, rgba(white)]])

    // These shortest f32 decimals fall just below an f64 half-step after
    // multiplication. Rust's f32 product is exactly 3.5 / 6.5, so the committed
    // group alpha must be 4 / 7, not the f64 result 3 / 6. Fixed expected pixels
    // cover both consumers without deriving expectations from the presenter.
    for (const [opacity, expected] of [[0.01372549, [251, 251, 255, 255]],
      [0.025490196, [248, 248, 255, 255]]]) {
      for (const legacy of [false, true]) {
        const current = plannedFrame(root([node('group', { opacity, background: blue })]),
          paintContext([], paintContext([0])))
        if (legacy) { delete current.paintPlan; delete current.root.style }
        render(current, `${legacy ? 'legacy' : 'committed'} f32 opacity ${opacity} rounds once at the group boundary`,
          [[20, 20, expected]])
      }
    }

    const scroller = plannedFrame(root([node('scroller', { bounds: { x: 8, y: 8, width: 16, height: 16 },
      scrollContainer: true, scrollOffset: { scrollTop: 8 }, children: [
        node('hoisted', { bounds: { x: 8, y: 16, width: 16, height: 16 }, background: red, style: { position: 'relative', z_index: 2 } }),
      ] }), node('sibling', { bounds: { x: 8, y: 8, width: 32, height: 16 }, background: blue,
        style: { position: 'relative', z_index: 1 } })]), paintContext([], [...paintBox(0), ...paintContext([1]), ...paintContext([0, 0])]))
    render(scroller, 'hoisted context retains DOM scroll and clip', [[12, 12, rgba(red)], [28, 12, rgba(blue)], [12, 28, rgba(white)]])

    const fixed = plannedFrame(root([node('group', { opacity: .5, bounds: { x: 8, y: 8, width: 16, height: 16 },
      background: red, scrollContainer: true, scrollOffset: { scrollTop: 8 }, children: [
        node('wrapper', { children: [node('fixed', { bounds: { x: 32, y: 8, width: 16, height: 16 }, background: blue,
          style: { flow: {}, position: 'fixed' } })] }),
      ] })]), paintContext([], [paintCommand('begin', 0), paintCommand('background', 0), paintCommand('content', 0),
      ...paintBox(0, 0), ...paintContext([0, 0, 0]), paintCommand('end', 0)]))
    render(fixed, 'fixed resets clips and scroll while retaining opacity ownership', [[36, 12, [127, 127, 255, 255]], [12, 12, [255, 127, 127, 255]]])

    const absolute = containing => plannedFrame(root([node('clip', { bounds: { x: 8, y: 8, width: 16, height: 16 },
      computed_style: { overflow: 'hidden' }, style: containing ? { position: 'relative' } : {}, children: [
        node('absolute', { bounds: { x: 32, y: 8, width: 16, height: 16 }, background: red, style: { position: 'absolute', z_index: 1 } }),
      ] })]), paintContext([], [...paintBox(0), ...paintContext([0, 0])]))
    render(absolute(false), 'absolute discards clips between itself and root containing block', [[36, 12, rgba(red)]])
    render(absolute(true), 'absolute retains its actual containing block descendant clip', [[36, 12, rgba(white)]])
    const absoluteScroll = containing => plannedFrame(root([node('scroller', {
      bounds: { x: 8, y: 8, width: 48, height: 48 }, scrollContainer: true, scrollOffset: { scrollTop: 8 },
      style: containing ? { position: 'relative' } : {}, children: [
        node('absolute', { bounds: { x: 16, y: 24, width: 16, height: 16 }, background: red,
          style: { position: 'absolute', z_index: 1 } }),
      ],
    })]), paintContext([], [...paintBox(0), ...paintContext([0, 0])]))
    render(absoluteScroll(false), 'intermediate scroller does not move absolute descendant of root containing block',
      [[20, 20, rgba(white)], [20, 36, rgba(red)]])
    render(absoluteScroll(true), 'relative scroll containing block moves its absolute descendant',
      [[20, 20, rgba(red)], [20, 36, rgba(white)]])
    const preservedAncestor = plannedFrame(root([node('outer-clip', { bounds: { x: 8, y: 8, width: 16, height: 16 },
      computed_style: { overflow: 'hidden' }, children: [node('relative-cb', { style: { position: 'relative' }, children: [
        node('absolute', { bounds: { x: 32, y: 8, width: 16, height: 16 }, background: red, style: { position: 'absolute', z_index: 1 } }),
      ] })] })]), paintContext([], [...paintBox(0), ...paintBox(0, 0), ...paintContext([0, 0, 0])]))
    render(preservedAncestor, 'relative containing block retains complete ancestor clip chain', [[36, 12, rgba(white)]])

    const splitContent = plannedFrame(root([node('negative', { background: red, style: { position: 'relative', z_index: -1 } })]),
      [paintCommand('begin'), paintCommand('background'), ...paintContext([0]), paintCommand('content'), paintCommand('end')])
    splitContent.root.image = { resource: 'green', mode: 'scaleToFill' }
    splitContent.images = { green: { width: 1, height: 1, pixels: rgba(green) } }
    render(splitContent, 'replaced content paints after negative context independently of own background', [[20, 20, rgba(green)]])

    for (const legacy of [false, true]) {
      const hidden = plannedFrame(root([node('hidden', {
        bounds: { x: 8, y: 8, width: 18, height: 40 }, visibility: 'hidden', opacity: .5,
        background: red, image: { resource: 'cyan', mode: 'scaleToFill' },
        computed_style: { visibility: 'hidden', overflow: 'hidden' },
        style: { transform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 3 } }, children: [
          node('inherited-hidden', { bounds: { x: 16, y: 16, width: 8, height: 8 }, visibility: 'hidden',
            computed_style: { visibility: 'hidden' }, background: blue, image: { resource: 'cyan', mode: 'scaleToFill' } }),
          node('visible-child', { bounds: { x: 24, y: 24, width: 8, height: 8 }, visibility: 'visible',
            computed_style: { visibility: 'visible' }, image: { resource: 'cyan', mode: 'scaleToFill' } }),
        ],
      })]), paintContext([], [paintCommand('begin', 0), ...paintBox(0, 1), paintCommand('end', 0)]))
      hidden.images = { cyan: { width: 1, height: 1, pixels: [0, 255, 255, 255] } }
      if (legacy) { delete hidden.paintPlan; delete hidden.root.style }
      render(hidden, `${legacy ? 'legacy' : 'committed'} hidden ink preserves transformed clipped visible image and group opacity`,
        [[14, 12, rgba(white)], [22, 22, rgba(white)], [29, 29, [127, 255, 255, 255]], [32, 29, rgba(white)]])
    }

    const accepted = render(stackingFixture(), 'accepted before invalid plan', [[20, 20, rgba(red)]])
    for (const [label, mutate] of malformedPaintPlans) {
      const invalid = stackingFixture(); mutate(invalid)
      assert.throws(() => presenter.drawFrame(surface.getCanvas(), invalid, {}), coded('ERR_RENDER'), label)
    }
    let finalSnapshot
    try {
      finalSnapshot = surface.makeImageSnapshot()
      assert.deepEqual(Buffer.from(finalSnapshot.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888,
        alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB })), accepted, 'all failed plan preflights preserve every accepted CPU pixel')
    } finally { finalSnapshot?.delete() }
    assert.equal(freedRecorders, frames); assert.equal(freedPictures, frames); assert.equal(freedSnapshots, frames)
    assert.ok(frames >= 16)
  } finally { surface.delete(); font.delete() }
})

test('real CanvasKit 0.42.0 CPU API preflight: picture, CJK glyphs, border rings, transformed padding clips and readback (not WebGL/GPU)', {
  skip: !dependencyDir || !fontPath ? 'blocked: provide WEAPP_CONTAINER_TEST_CANVASKIT_DIR and WEAPP_CONTAINER_TEST_CANVASKIT_FONT; no dependency download or substitute backend' : false,
}, async () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const files = [
    [resolve(dependencyDir, 'bin/full/canvaskit.js'), '894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5'],
    [resolve(dependencyDir, 'bin/full/canvaskit.wasm'), 'aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959'],
    [resolve(fontPath), '916bd5146cd1099aff18931fd0c85f4f3fd1ff7b2c966cb3cc22a4e5a6216983'],
  ]
  for (const [path, expected] of files) assert.equal(hash(await readFile(path)), expected, path)
  assert.equal(JSON.parse(await readFile(resolve(dependencyDir, 'package.json'))).version, '0.42.0')
  const init = createRequire(import.meta.url)(files[0][0])
  const CK = await init({ locateFile: name => resolve(dependencyDir, 'bin/full', name) })
  const bytes = await readFile(fontPath)
  const face = CK.Typeface.MakeTypefaceFromData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  assert.ok(face)
  const font = new CK.Font(face, 16), surface = CK.MakeSurface(64, 64), recorder = new CK.PictureRecorder()
  let picture = null, image = null
  try {
    assert.ok(surface)
    assert.equal(surface.reportBackendTypeIsGPU(), false, 'This preflight deliberately proves CPU APIs only')
    // Bypass GPU initialization only in this CPU API test; never call submit or
    // emit a GPU receipt for the CPU surface.
    const presenter = Object.create(CanvasKitFramePresenter.prototype)
    Object.assign(presenter, { CK, font, surface, canvas: { width: 64, height: 64 }, physicalSize: [64, 64],
      options: { typography: 'native-v1' }, gl: { isContextLost: () => false } })
    const actual = frame()
    actual.root.children.unshift(node('rounded', { bounds: { x: 0, y: 48, width: 20, height: 16 },
      background: { red: 20, green: 80, blue: 120, alpha: 255 }, style: { border_radius: Array.from({ length: 4 }, () => ({ x: 8, y: 8 })) } }))
    const translated = (id, colour, z_index) => node(id, { bounds: { x: 0, y: 48, width: 8, height: 8 },
      background: colour, z_index, style: { transform: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 0 } } })
    actual.root.children.unshift(node('transformed-parent', { opacity: 0.5,
      style: { transform: { a: 1, b: 0, c: 0, d: 1, e: 24, f: 0 } }, children: [
        translated('upper', { red: 255, green: 0, blue: 0, alpha: 255 }, 2),
        translated('lower', { red: 0, green: 255, blue: 0, alpha: 255 }, 1),
      ] }))
    const stats = presenter.validate(actual)
    assert.equal(stats.textNodes, 1)
    assert.equal(stats.glyphs, [...'Weapp微信0'].length)
    const invalid = structuredClone(actual); invalid.root.children.at(-1).text = '\u{10ffff}'
    assert.throws(() => presenter.validate(invalid), coded('ERR_UNSUPPORTED_CAPABILITY', /font/))
    const target = recorder.beginRecording([0, 0, 64, 64])
    presenter.drawNode(target, actual.root, { red: 0, green: 0, blue: 0, alpha: 255 }, stats)
    picture = recorder.finishRecordingAsPicture()
    surface.getCanvas().drawPicture(picture); surface.flush()
    image = surface.makeImageSnapshot()
    const pixels = image.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888,
      alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB })
    const pixel = (x, y) => Array.from(pixels.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4))
    assert.deepEqual(pixel(63, 63), [243, 244, 246, 255])
    assert.deepEqual(pixel(0, 48), [243, 244, 246, 255], 'Rounded corner leaves page background')
    assert.deepEqual(pixel(10, 56), [20, 80, 120, 255], 'Rounded rectangle is actually painted')
    const orderedBlend = pixel(35, 52)
    assert.deepEqual(orderedBlend, [249, 122, 123, 255],
      'Opaque upper red hides lower green inside the group before the group is composited')
    {
      const white = { red: 255, green: 255, blue: 255, alpha: 255 }
      const red = { red: 255, green: 0, blue: 0, alpha: 255 }
      const green = { red: 0, green: 255, blue: 0, alpha: 255 }
      const blue = { red: 0, green: 0, blue: 255, alpha: 255 }
      const inside = (x, y, left, top, right, bottom) => x >= left && x < right && y >= top && y < bottom
      const groupFrame = (group, background = white) => ({ frame_id: 62, viewport: { ...box },
        root: node('page', { background, children: [group] }) })
      const overlappingGroup = extra => node('half-group', {
        bounds: { x: 8, y: 8, width: 32, height: 32 }, background: red, opacity: 0.5,
        children: [node('green', { bounds: { x: 16, y: 16, width: 20, height: 20 }, background: green }),
          node('blue', { bounds: { x: 24, y: 24, width: 24, height: 24 }, background: blue })], ...extra,
      })
      const groupCases = [
        { name: 'own background, overlapping opaque children and overflow', frame: groupFrame(overlappingGroup()),
          expected: (x, y) => inside(x, y, 24, 24, 48, 48) ? [127, 127, 255, 255]
            : inside(x, y, 16, 16, 36, 36) ? [127, 255, 127, 255]
              : inside(x, y, 8, 8, 40, 40) ? [255, 127, 127, 255] : [255, 255, 255, 255] },
        { name: 'transparent target keeps unpremultiplied readback alpha', frame: groupFrame(overlappingGroup(), null),
          expected: (x, y) => inside(x, y, 24, 24, 48, 48) ? [0, 0, 255, 128]
            : inside(x, y, 16, 16, 36, 36) ? [0, 255, 0, 128]
              : inside(x, y, 8, 8, 40, 40) ? [255, 0, 0, 128] : [0, 0, 0, 0] },
        { name: 'overflow clip applies inside the group', frame: groupFrame(overlappingGroup({ computed_style: { overflow: 'hidden' } })),
          expected: (x, y) => !inside(x, y, 8, 8, 40, 40) ? [255, 255, 255, 255]
            : inside(x, y, 24, 24, 48, 48) ? [127, 127, 255, 255]
              : inside(x, y, 16, 16, 36, 36) ? [127, 255, 127, 255] : [255, 127, 127, 255] },
        { name: 'nested group independently composites against parent contents',
          frame: groupFrame(node('outer', { bounds: { x: 8, y: 8, width: 40, height: 40 }, background: red, opacity: 0.5,
            children: [node('inner', { bounds: { x: 16, y: 16, width: 24, height: 24 }, background: green, opacity: 0.5,
              children: [node('inner-blue', { bounds: { x: 24, y: 24, width: 20, height: 20 }, background: blue })] })] })),
          expected: (x, y) => inside(x, y, 24, 24, 44, 44) ? [191, 127, 191, 255]
            : inside(x, y, 16, 16, 40, 40) ? [191, 191, 127, 255]
              : inside(x, y, 8, 8, 48, 48) ? [255, 127, 127, 255] : [255, 255, 255, 255] },
        { name: 'transparent group skips paint only', frame: groupFrame(overlappingGroup({ opacity: 0 })),
          expected: () => [255, 255, 255, 255] },
      ]
      // Fixed descendants escape overflow but retain the enclosing opacity group.
      const fixedGroup = overlappingGroup({ computed_style: { overflow: 'hidden' }, scrollContainer: true,
        scrollOffset: { scrollTop: 8, scrollLeft: 0 } })
      fixedGroup.children = [node('fixed-blue', { bounds: { x: 44, y: 44, width: 12, height: 12 },
        background: blue, style: { position: 'fixed', flow: {} } })]
      groupCases.push({ name: 'fixed overflow remains in the group', frame: groupFrame(fixedGroup),
        expected: (x, y) => inside(x, y, 44, 44, 56, 56) ? [127, 127, 255, 255]
          : inside(x, y, 8, 8, 40, 40) ? [255, 127, 127, 255] : [255, 255, 255, 255] })
      for (const specification of groupCases) {
        const stats = presenter.validate(specification.frame), canvas = surface.getCanvas()
        canvas.clear(CK.TRANSPARENT)
        presenter.drawNode(canvas, specification.frame.root, { red: 0, green: 0, blue: 0, alpha: 255 }, stats)
        surface.flush()
        const output = surface.makeImageSnapshot()
        try {
          const pixels = output.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888,
            alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB })
          for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
            const expected = specification.expected(x, y)
            for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(pixels[(y * 64 + x) * 4 + channel] - expected[channel]) <= 1,
              `${specification.name} (${x},${y}) channel ${channel}: ${pixels[(y * 64 + x) * 4 + channel]} vs ${expected[channel]}`)
          }
        } finally { output.delete() }
      }
    }
    const textInk = (top, bottom) => {
      let count = 0
      for (let y = top; y < bottom; y++) for (let x = 4; x < 60; x++) if (pixel(x, y)[0] < 240) count++
      return count
    }
    // The original variable font defaults to a thin face. Test real ink in
    // both separate lines rather than imposing a fabricated bold/dark weight.
    assert.ok(textInk(4, 22) > 5, 'Actual Latin glyph pixels exist on the first line')
    assert.ok(textInk(24, 44) > 5, 'Actual CJK/digit glyph pixels exist on the second line')

    // A committed text plan is also a paint contract. Compare every pixel
    // with independent CanvasKit font draws at the plan's exact baselines.
    // The zero-height line box deliberately excludes all glyph ink: clipping
    // the text to that box or reflowing its narrow width would erase/change it.
    const typedFrame = { frame_id: 40, viewport: { ...box }, root: node('typed-page', {
      background: { red: 255, green: 255, blue: 255, alpha: 255 }, children: [node('typed-label', {
        text: 'A中\nW', bounds: { x: 4, y: 14, width: 8, height: 0 },
        text_style: textStyle(12, { px: 0 }), computed_style: { 'font-size': '12px', 'line-height': '0px' },
        text_layout: textLayout([['A', 0, -2], ['中', 20, -2], ['W', 0, 18]], {
          metrics: { width: 32, height: 0, line_count: 2 },
        }),
      })],
    }) }
    const flowFrame = sourceMappedTextFrame()
    flowFrame.root.background = { red: 255, green: 255, blue: 255, alpha: 255 }
    const fractionalFrame = { frame_id: 41, viewport: { ...box }, root: node('fractional-page', {
      background: { red: 255, green: 255, blue: 255, alpha: 255 }, children: [node('fractional-text', {
        text: 'A中B', bounds: { x: 4.125, y: 4.375, width: 50, height: 50 }, text_style: textStyle(12),
        text_layout: textLayout([['A', .25, 12.125], ['中', 20.75, 12.125], ['B', .25, 12.125]], {
          metrics: { width: 32, height: 40, line_count: 1 },
        }),
      })],
    }) }
    for (const specification of [
      { frame: typedFrame, size: 12, glyphs: [['A', 4, 12], ['中', 24, 12], ['W', 4, 32]],
        label: 'legacy committed size and overflowing zero-height baselines' },
      { frame: flowFrame, size: 16, glyphs: [['A', 0, 14], [' ', 8, 14], ['B', 16, 14]],
        label: 'source-mapped CSS whitespace plan without source rewriting or reflow' },
      { frame: fractionalFrame, size: 12, glyphs: [['A', 4.375, 16.5], ['中', 24.875, 16.5], ['B', 4.375, 16.5]],
        label: 'batched fractional coordinates and overlapping glyph paint order' },
    ]) {
      const typedRecorder = new CK.PictureRecorder(), expectedSurface = CK.MakeSurface(64, 64), expectedFont = new CK.Font(face, specification.size)
      let typedPicture = null, typedImage = null, expectedImage = null
      try {
        const stats = presenter.validate(specification.frame), target = typedRecorder.beginRecording([0, 0, 64, 64])
        presenter.drawNode(target, specification.frame.root, { red: 0, green: 0, blue: 0, alpha: 255 }, stats)
        typedPicture = typedRecorder.finishRecordingAsPicture()
        surface.getCanvas().clear(CK.TRANSPARENT)
        surface.getCanvas().drawPicture(typedPicture); surface.flush()
        typedImage = surface.makeImageSnapshot()
        const expectedCanvas = expectedSurface.getCanvas(), paint = new CK.Paint()
        try {
          expectedCanvas.clear(CK.Color(255, 255, 255, 1)); paint.setColor(CK.Color(0, 0, 0, 1)); paint.setAntiAlias(true)
          for (const [character, x, baseline] of specification.glyphs) {
            expectedCanvas.drawGlyphs(expectedFont.getGlyphIDs(character), [0, 0], x, baseline, expectedFont, paint)
          }
        } finally { paint.delete() }
        expectedSurface.flush(); expectedImage = expectedSurface.makeImageSnapshot()
        const info = { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }
        const actualPixels = typedImage.readPixels(0, 0, info), expectedPixels = expectedImage.readPixels(0, 0, info)
        assert.deepEqual(actualPixels, expectedPixels, `${specification.label} reaches actual CanvasKit pixels`)
        assert.ok(actualPixels.some((value, index) => index % 4 !== 3 && value < 240), `${specification.label} retains glyph ink`)
        assert.equal(stats.textPlans.native, 1)
      } finally { expectedImage?.delete(); typedImage?.delete(); typedPicture?.delete(); typedRecorder.delete(); expectedSurface?.delete(); expectedFont.delete() }
    }

    const white = { red: 255, green: 255, blue: 255, alpha: 255 }, red = { red: 255, green: 0, blue: 0, alpha: 255 }
    const blue = { red: 0, green: 0, blue: 255, alpha: 255 }
    const rgba = colour => [colour.red, colour.green, colour.blue, colour.alpha]
    const renderOverflow = (name, children, samples, resources = {}) => {
      const current = { frame_id: 10, viewport: { ...box }, images: resources, root: node('page', { background: white, children }) }
      const recorder = new CK.PictureRecorder()
      let picture = null, snapshot = null, images = new Map()
      try {
        const stats = presenter.validate(current), target = recorder.beginRecording([0, 0, 64, 64])
        images = presenter.createImages(current)
        presenter.drawNode(target, current.root, { red: 0, green: 0, blue: 0, alpha: 255 }, stats,
          { viewport: current.viewport, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], images })
        picture = recorder.finishRecordingAsPicture()
        surface.getCanvas().clear(CK.TRANSPARENT)
        surface.getCanvas().drawPicture(picture); surface.flush()
        snapshot = surface.makeImageSnapshot()
        const pixels = snapshot.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888,
          alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB })
        for (const [x, y, expected] of samples) assert.deepEqual(Array.from(pixels.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)),
          Array.isArray(expected) ? expected : rgba(expected), `${name} pixel (${x}, ${y})`)
        return new Uint8Array(pixels)
      } finally { snapshot?.delete(); picture?.delete(); recorder.delete(); for (const image of images.values()) image.delete() }
    }
    for (const spec of flowOrderCases) {
      const parent = flowOrderParent(spec)
      const pixels = renderOverflow(`typed flow order ${spec.name}`, [parent], [])
      const expectedSurface = CK.MakeSurface(64, 64), paint = new CK.Paint()
      let expectedImage = null
      try {
        assert.ok(expectedSurface)
        const canvas = expectedSurface.getCanvas()
        canvas.clear(CK.Color(255, 255, 255, 1)); paint.setAntiAlias(true)
        // The expected image uses explicit case data and direct CanvasKit
        // draws, without the presenter's sorting or recursive paint path.
        for (const id of spec.expected) {
          const child = parent.children.find(child => child.id === id), c = child.background, r = child.bounds
          paint.setColor(CK.Color(c.red, c.green, c.blue, c.alpha / 255))
          canvas.drawRect([r.x, r.y, r.x + r.width, r.y + r.height], paint)
        }
        expectedSurface.flush(); expectedImage = expectedSurface.makeImageSnapshot()
        assert.deepEqual(pixels, expectedImage.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888,
          alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }), `actual CPU flow order: ${spec.name}`)
      } finally { expectedImage?.delete(); paint.delete(); expectedSurface?.delete() }
    }
    const acceptedOrderPixels = renderOverflow('accepted typed flow order', [flowOrderParent(flowOrderCases[0])], [])
    for (const [label, field, value] of invalidFlowValues) {
      const invalid = { frame_id: 53, viewport: { ...box }, root: node('invalid-flow', { style: { flow: { [field]: value } } }) }
      assert.throws(() => presenter.validate(invalid), coded('ERR_RENDER', /typed flow/), label)
    }
    for (const text of ['parent text', '']) {
      const invalid = { frame_id: 54, viewport: { ...box }, root: flowOrderParent(flowOrderCases[0]) }
      invalid.root.text = text
      assert.throws(() => presenter.validate(invalid), coded('ERR_UNSUPPORTED_CAPABILITY', /explicit text leaf/))
    }
    let retainedOrderImage = null
    try {
      retainedOrderImage = surface.makeImageSnapshot()
      assert.deepEqual(acceptedOrderPixels, retainedOrderImage.readPixels(0, 0, { width: 64, height: 64,
        colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }),
      'failed order/context/anonymous-text CPU preflight retains accepted actual pixels without emitting a GPU receipt')
    } finally { retainedOrderImage?.delete() }
    const cyan = [0, 255, 255, 255], magenta = [255, 0, 255, 255], orange = [255, 128, 0, 255]
    const imagePixels = [...rgba(red), ...rgba({ red: 0, green: 255, blue: 0, alpha: 255 }), ...rgba(blue), ...[255, 255, 0, 255],
      ...cyan, ...magenta, ...orange, ...[0, 0, 0, 255]]
    const imageResources = { [imageResourceId]: { width: 4, height: 2, pixels: imagePixels } }
    const imageNode = (mode, extra = {}) => node('local-image', { tag: 'image', bounds: { x: 8, y: 8, width: 8, height: 8 },
      attributes: { src: 'local.png' }, image: { resource: imageResourceId, mode }, ...extra })
    for (const mode of ['scaleToFill', 'widthFix', 'heightFix']) {
      renderOverflow(`RGBA nearest ${mode}`, [imageNode(mode)], [[9, 9, red], [13, 9, blue], [9, 13, cyan], [15, 15, [0, 0, 0, 255]], [7, 9, white]], imageResources)
    }
    renderOverflow('RGBA contain preserves letterbox', [imageNode('aspectFit')],
      [[9, 9, white], [9, 10, red], [13, 12, orange], [9, 14, white]], imageResources)
    renderOverflow('RGBA cover crops central source', [imageNode('aspectFill')],
      [[9, 9, [0, 255, 0, 255]], [13, 9, blue], [9, 13, magenta], [13, 13, orange]], imageResources)
    for (const [mode, x, y] of [['top', 10, 8], ['bottom', 10, 14], ['center', 10, 11], ['left', 8, 11], ['right', 12, 11],
      ['top left', 8, 8], ['top right', 12, 8], ['bottom left', 8, 14], ['bottom right', 12, 14]]) {
      renderOverflow(`RGBA intrinsic ${mode}`, [imageNode(mode)],
        [[x, y, red], [x + 1, y, [0, 255, 0, 255]], [x + 3, y + 1, [0, 0, 0, 255]], [8, y === 8 ? 15 : 8, white]], imageResources)
    }
    // Non-square, nonuniform source colours reveal vertical and horizontal
    // source cropping independently of the larger-box placement checks.
    const cropPixels = Array.from({ length: 16 }, (_, i) => [i % 4 * 64, Math.floor(i / 4) * 64, 16, 255]).flat()
    for (const [mode, x, y] of [['top', 1, 0], ['bottom', 1, 2], ['center', 1, 1], ['left', 0, 1], ['right', 2, 1],
      ['top left', 0, 0], ['top right', 2, 0], ['bottom left', 0, 2], ['bottom right', 2, 2]]) {
      renderOverflow(`RGBA source crop ${mode}`, [imageNode(mode, { bounds: { x: 8, y: 8, width: 2, height: 2 } })],
        [[8, 8, [x * 64, y * 64, 16, 255]], [9, 9, [(x + 1) * 64, (y + 1) * 64, 16, 255]], [10, 8, white]],
        { [imageResourceId]: { width: 4, height: 4, pixels: cropPixels } })
    }
    renderOverflow('RGBA content box excludes border and padding and clips its rounded outer corners', [imageNode('scaleToFill', {
      bounds: { x: 8, y: 8, width: 32, height: 32 }, style: { border: borderSides(2, blue),
        padding: { top: 2, right: 2, bottom: 2, left: 2 }, border_radius: Array.from({ length: 4 }, () => ({ x: 16, y: 16 })) },
    })], [[9, 9, white], [9, 24, blue], [11, 24, white], [13, 14, red], [25, 14, blue], [13, 34, cyan], [38, 24, blue]], imageResources)
    renderOverflow('RGBA image inherits opacity, transform and resolved scroll clipping', [node('image-scroll', {
      bounds: { x: 8, y: 8, width: 16, height: 16 }, opacity: 0.5, scrollContainer: true, scrollOffset: { scrollTop: 8 },
      style: { transform: { a: 1, b: 0, c: 0, d: 1, e: 4, f: 0 } }, children: [imageNode('scaleToFill', {
        bounds: { x: 8, y: 16, width: 16, height: 16 }, opacity: 0.5,
      })],
    })], [[13, 9, [255, 191, 191, 255]], [21, 9, [191, 191, 255, 255]], [9, 9, white], [13, 25, white]], imageResources)
    const retainedImage = surface.makeImageSnapshot()
    try {
      const info = { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }
      const before = retainedImage.readPixels(0, 0, info)
      for (const [name, mutate] of invalidImageFrames) {
        const invalid = imageFrame(); mutate(invalid)
        assert.throws(() => presenter.validate(invalid), coded('ERR_RENDER'), name)
      }
      const untyped = imageFrame(); delete untyped.root.children[0].image
      assert.throws(() => presenter.validate(untyped), coded('ERR_UNSUPPORTED_CAPABILITY', /typed image resource/))
      const after = surface.makeImageSnapshot()
      try { assert.deepEqual(after.readPixels(0, 0, info), before, 'Invalid image frames preserve actual accepted CanvasKit pixels') }
      finally { after.delete() }
    } finally { retainedImage.delete() }
    const clipped = (style, extra = {}) => node('clip', { bounds: { x: 12, y: 12, width: 20, height: 20 },
      computed_style: style, children: [node('oversized', { bounds: { x: 4, y: 4, width: 40, height: 40 }, background: red })], ...extra })
    for (const mode of ['hidden', 'scroll', 'auto', 'clip', 'HIDDEN']) renderOverflow(`overflow ${mode}`, [clipped({ overflow: mode })],
      [[20, 20, red], [8, 20, white], [20, 8, white], [36, 20, white], [20, 36, white]])
    renderOverflow('visible remains unbounded', [clipped({ overflow: 'visible' })], [[8, 20, red], [20, 8, red], [36, 20, red]])
    renderOverflow('independent horizontal clip', [clipped({ overflow: 'clip visible' })], [[8, 20, white], [20, 8, red], [20, 36, red]])
    renderOverflow('independent vertical clip', [clipped({ overflow: 'visible clip' })], [[8, 20, red], [20, 8, white], [36, 20, red]])
    renderOverflow('visible computes to auto beside hidden', [clipped({ overflow: 'visible hidden' })], [[8, 20, white], [20, 8, white], [20, 20, red]])
    renderOverflow('axis overrides shorthand', [clipped({ overflow: 'hidden', 'overflow-x': ' visible ', 'overflow-y': ' clip ' })],
      [[8, 20, red], [20, 8, white], [36, 20, red]])
    renderOverflow('rounded two-axis clip', [clipped({ overflow: 'hidden' }, {
      bounds: { x: 12, y: 12, width: 32, height: 32 }, style: { border_radius: Array.from({ length: 4 }, () => ({ x: 16, y: 16 })) },
    })], [[13, 13, white], [28, 14, red], [28, 28, red]])
    renderOverflow('single-axis ignores rounded corner shape', [clipped({ overflow: 'clip visible' }, {
      bounds: { x: 12, y: 12, width: 32, height: 32 }, style: { border_radius: Array.from({ length: 4 }, () => ({ x: 16, y: 16 })) },
    })], [[13, 13, red], [13, 6, red], [8, 20, white]])
    const rotatedClip = mode => clipped({ overflow: mode }, {
      bounds: { x: 12, y: 12, width: 32, height: 32 }, style: {
        transform: { a: Math.SQRT1_2, b: Math.SQRT1_2, c: -Math.SQRT1_2, d: Math.SQRT1_2, e: 20, f: 0 },
        transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } },
      }, children: [node('child', { bounds: { x: 28, y: 28, width: 32, height: 32 }, background: red })],
    })
    renderOverflow('transformed clip uses actual local shape', [rotatedClip('hidden')], [[32, 46, red], [44, 52, white]])
    renderOverflow('rotated independent horizontal strip', [rotatedClip('clip visible')], [[32, 46, red], [44, 52, white], [20, 52, red]])
    renderOverflow('rotated independent vertical strip', [rotatedClip('visible clip')], [[32, 46, red], [44, 52, red], [20, 52, white]])
    const nested = clipped({ overflow: 'hidden' }, { bounds: { x: 8, y: 8, width: 40, height: 40 }, children: [
      clipped({ overflow: 'hidden' }, { bounds: { x: 24, y: 0, width: 40, height: 40 },
        children: [node('nested-paint', { background: red })] }),
    ] })
    renderOverflow('nested intersections and restored sibling state', [nested,
      node('sibling', { bounds: { x: 0, y: 52, width: 64, height: 12 }, background: blue }),
    ], [[26, 10, red], [20, 10, white], [26, 4, white], [50, 10, white], [2, 56, blue]])
    renderOverflow('inherited opacity applies inside clip only', [clipped({ overflow: 'hidden' }, { opacity: 0.5 })],
      [[20, 20, [255, 127, 127, 255]], [8, 20, white]])
    renderOverflow('hidden subtree cannot paint through clip', [clipped({ overflow: 'hidden' }, { style: { display: 'none' } })], [[20, 20, white]])
    renderOverflow('zero-area clip removes descendants', [clipped({ overflow: 'hidden' }, { bounds: { x: 12, y: 12, width: 0, height: 20 } })],
      [[12, 20, white], [20, 20, white]])
    renderOverflow('singular transformed subtree has no pixel area', [clipped({ overflow: 'clip visible' }, {
      style: { transform: { a: 1, b: 0, c: 0, d: 0, e: 0, f: 0 } },
    })], [[20, 20, white]])

    const smallScaleStyle = (reflected = false) => ({
      transform: { a: reflected ? -.0001 : .0001, b: 0, c: 0, d: .0001, e: reflected ? 32 : 0, f: 0 },
      transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } },
    })
    renderOverflow('small nonzero determinant paints a real two-pixel box', [node('small-two-pixel', {
      bounds: { x: 0, y: 0, width: 20000, height: 20000 }, background: red, style: smallScaleStyle(),
    })], [[0, 0, red], [1, 1, red], [2, 1, white], [1, 2, white]])
    let acceptedSmallPixels
    for (const reflected of [false, true]) {
      acceptedSmallPixels = renderOverflow(`small ${reflected ? 'negative' : 'positive'} determinant keeps one-axis clipping and overflowing descendants`, [node('small-strip', {
        bounds: { x: 0, y: 0, width: 320000, height: 320000 }, style: smallScaleStyle(reflected),
        computed_style: { overflow: 'clip visible' }, children: [node('small-overflowing-paint', {
          bounds: { x: -80000, y: -80000, width: 480000, height: 480000 }, background: red,
        })],
      })], [[16, 16, red], [31, 16, red], [32, 16, white], [16, 36, red], [16, 40, white]])
    }
    const tinyStyle = { transform: { a: 1e-30, b: 0, c: 0, d: 1e-30, e: 0, f: 0 },
      transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } }
    for (const [name, candidate] of [
      ['nonzero inverse outside f32', node('invalid-inverse', { style: { ...tinyStyle,
        transform: { a: 1e-40, b: 0, c: 0, d: 1, e: 0, f: 0 } } })],
      ['cumulative nonzero underflow', node('underflow-parent', { style: tinyStyle,
        children: [node('underflow-child', { style: tinyStyle, background: red })] })],
    ]) {
      assert.throws(() => presenter.validate({ frame_id: 55, viewport: { ...box }, root: candidate }), coded('ERR_RENDER'), name)
    }
    const retainedSmall = surface.makeImageSnapshot()
    try {
      assert.deepEqual(acceptedSmallPixels, retainedSmall.readPixels(0, 0, { width: 64, height: 64,
        colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB }),
      'failed inverse/underflow CPU preflight preserves accepted small-scale pixels without a GPU receipt')
    } finally { retainedSmall.delete() }

    const scrolling = (extra = {}) => node('scroll', { bounds: { x: 8, y: 8, width: 24, height: 24 },
      scrollContainer: true, scrollOffset: { scrollLeft: 4, scrollTop: 12 }, background: blue,
      children: [node('content', { bounds: { x: 16, y: 24, width: 16, height: 24 }, background: red })], ...extra })
    renderOverflow('resolved scroll translates contents while keeping background and forced viewport fixed', [scrolling(),
      node('after-scroll', { bounds: { x: 48, y: 48, width: 8, height: 8 }, background: red }),
    ], [[14, 14, red], [9, 14, blue], [14, 30, red], [14, 34, white], [50, 50, red]])
    renderOverflow('raw scroll metadata preserves legacy unshifted visible overflow', [scrolling({ scrollContainer: false })],
      [[14, 14, blue], [18, 26, red], [18, 40, red]])
    renderOverflow('scrolling keeps rounded viewport corners fixed', [scrolling({ style: {
      border_radius: Array.from({ length: 4 }, () => ({ x: 12, y: 12 })),
    }, children: [node('fill', { bounds: { x: 0, y: 0, width: 64, height: 64 }, background: red })] })],
      [[9, 9, white], [20, 10, red], [20, 20, red]])
    const nestedScroll = scrolling({ bounds: { x: 8, y: 8, width: 40, height: 40 }, scrollOffset: { scrollTop: 8 }, children: [
      scrolling({ bounds: { x: 16, y: 24, width: 16, height: 16 }, scrollOffset: { scrollLeft: 8, scrollTop: 8 },
        children: [node('nested-content', { bounds: { x: 24, y: 32, width: 32, height: 32 }, background: red })] }),
    ] })
    renderOverflow('nested scroll clips compose and restore for the following sibling', [nestedScroll,
      node('after', { bounds: { x: 48, y: 48, width: 8, height: 8 }, background: red }),
    ], [[18, 18, red], [34, 18, blue], [18, 34, blue], [50, 50, red]])
    renderOverflow('transformed scroll translates in its local space', [scrolling({
      style: { transform: { a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 },
        transform_origin: { x: { value: 0, unit: 'px' }, y: { value: 0, unit: 'px' } } },
    })], [[18, 14, red], [10, 14, blue], [58, 14, white]])

    const fixed = (extra = {}) => node('viewport-fixed', {
      bounds: { x: 40, y: 4, width: 8, height: 8 }, background: red,
      style: { flow: {}, position: 'fixed' }, ...extra,
    })
    renderOverflow('typed fixed escapes scroll translation and ancestor overflow while retaining opacity and sibling order', [
      scrolling({ opacity: 0.5, children: [node('static-wrapper', { children: [fixed()] })] }),
      node('after-fixed', { bounds: { x: 44, y: 4, width: 4, height: 8 }, background: blue }),
    ], [[42, 6, [255, 127, 127, 255]], [46, 6, blue], [38, 6, white]])
    renderOverflow('fixed descendant escapes an empty ancestor clip', [scrolling({
      bounds: { x: 8, y: 8, width: 0, height: 0 }, background: null, children: [fixed()],
    })], [[42, 6, red], [38, 6, white]])
    renderOverflow('fixed own overflow continues to clip its ordinary children', [scrolling({ children: [fixed({
      background: null, computed_style: { overflow: 'hidden' }, children: [node('fixed-child', {
        bounds: { x: 32, y: 0, width: 24, height: 24 }, background: red,
      })],
    })] })], [[42, 6, red], [38, 6, white], [50, 6, white]])
    renderOverflow('legacy fixed without typed flow preserves original translated clip contract', [scrolling({ children: [fixed({
      bounds: { x: 16, y: 24, width: 8, height: 8 }, style: { position: 'fixed' },
    })] })], [[14, 14, red], [42, 6, white]])

    const green = { red: 0, green: 255, blue: 0, alpha: 255 }, yellow = { red: 255, green: 255, blue: 0, alpha: 255 }
    const edges = [red, green, blue, yellow]
    const bordered = (extra = {}) => node('border', { bounds: { x: 8, y: 8, width: 40, height: 40 },
      style: { border: [4, 6, 8, 10].map((width, index) => borderSide(width, edges[index])) }, ...extra })
    renderOverflow('asymmetric four-color border ring preserves the transparent inner hole', [bordered()], [
      [28, 9, red], [46, 26, green], [28, 45, blue], [9, 26, yellow], [28, 26, white], [2, 2, white],
    ])
    renderOverflow('border hole preserves preceding content rather than erasing it', [node('underlay', { background: blue }),
      bordered({ style: { border: borderSides(6, { ...red, alpha: 128 }) } }),
    ], [[24, 9, [128, 0, 127, 255]], [24, 24, blue]])
    renderOverflow('non-antialiased alpha joins paint each corner pixel once', [bordered({ style: { border: borderSides(8, { ...red, alpha: 128 }) } })],
      [[10, 10, [255, 127, 127, 255]], [11, 10, [255, 127, 127, 255]], [10, 11, [255, 127, 127, 255]], [24, 24, white]])
    renderOverflow('rounded border is the outer shape minus the normalized inner shape', [bordered({ style: {
      border: borderSides(4, red), border_radius: Array.from({ length: 4 }, () => ({ x: 16, y: 16 })),
    } })], [[9, 9, white], [14, 14, red], [20, 20, white], [28, 9, red]])
    const topRightRadius = [{ x: 0, y: 0 }, { x: 12, y: 12 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
    renderOverflow('one rounded corner preserves the other square corners and its inner ring', [bordered({ style: {
      border: borderSides(4, red), border_radius: topRightRadius,
    } })], [[46, 9, white], [43, 13, red], [39, 17, white], [9, 9, red]])
    renderOverflow('background covers the outer box beneath transparent borders', [node('underlay', { background: blue }),
      bordered({ background: green, style: { border: borderSides(6, { ...red, alpha: 0 }) } }),
    ], [[24, 9, green], [24, 24, green], [2, 2, blue]])
    renderOverflow('overwide opposing borders collapse the inner hole proportionally', [bordered({
      bounds: { x: 8, y: 8, width: 20, height: 10 }, style: { border: edges.map(color => borderSide(100, color)) },
    })], [[18, 9, red], [27, 13, green], [18, 17, blue], [8, 13, yellow]])
    renderOverflow('none and hidden borders have no paint or used width', [bordered({ style: {
      border: edges.map((color, index) => borderSide(100, color, index % 2 ? 'none' : 'hidden')),
    } })], [[24, 9, white], [9, 24, white], [24, 24, white]])
    const omittedBorder = JSON.parse(JSON.stringify(node('omitted-border', {
      bounds: { x: 8, y: 8, width: 20, height: 10 }, background: white, style: {}, computed_style: computedBorders(),
    })))
    assert.equal(Object.hasOwn(omittedBorder.style, 'border'), false)
    renderOverflow('Rust-omitted zero/none/black sides remain paintable with twelve computed longhands', [
      node('underlay', { background: blue }), omittedBorder,
    ], [[8, 10, white], [20, 10, white], [30, 10, blue]])
    const invalidLegacy = { frame_id: 11, viewport: { ...box }, root: structuredClone(omittedBorder) }
    invalidLegacy.root.computed_style['border-left-width'] = '4px'
    invalidLegacy.root.computed_style['border-left-style'] = 'solid'
    assert.throws(() => presenter.validate(invalidLegacy), coded('ERR_UNSUPPORTED_CAPABILITY', /typed border frame contract/))
    // CPU API evidence has no GPU receipt: prove rejected preflight leaves the
    // previously recorded real CanvasKit pixels intact without calling submit.
    const retained = surface.makeImageSnapshot()
    try {
      const pixels = retained.readPixels(0, 0, { width: 64, height: 64, colorType: CK.ColorType.RGBA_8888,
        alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB })
      for (const [x, y, expected] of [[8, 10, rgba(white)], [30, 10, rgba(blue)]]) {
        assert.deepEqual(Array.from(pixels.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)), expected)
      }
    } finally { retained.delete() }
    renderOverflow('descendants clip to the padding edge while a later sibling restores full canvas state', [bordered({
      computed_style: { overflow: 'hidden' }, style: { border: borderSides(4, blue), padding: { top: 6, right: 6, bottom: 6, left: 6 } },
      children: [node('fill', { background: red })],
    }), node('sibling', { bounds: { x: 0, y: 52, width: 8, height: 8 }, background: yellow })],
    [[10, 25, blue], [13, 25, red], [46, 25, blue], [25, 25, red], [2, 56, yellow], [2, 25, white]])
    renderOverflow('rounded descendants use inner border radii at the padding edge', [bordered({
      computed_style: { overflow: 'hidden' }, style: { border: borderSides(4, blue), border_radius: Array.from({ length: 4 }, () => ({ x: 16, y: 16 })) },
      children: [node('fill', { background: red })],
    })], [[9, 9, white], [14, 14, blue], [20, 20, red], [28, 9, blue]])
    renderOverflow('one rounded corner clips descendants without broadening the other inner corners', [bordered({
      computed_style: { overflow: 'hidden' }, style: { border: borderSides(4, blue), border_radius: topRightRadius },
      children: [node('fill', { background: red })],
    })], [[46, 9, white], [43, 13, blue], [39, 17, red], [9, 9, blue], [13, 13, red]])
    renderOverflow('independent overflow axis clips at the used padding edge', [bordered({
      computed_style: { overflow: 'clip visible' }, style: { border: borderSides(4, blue) },
      children: [node('fill', { background: red })],
    })], [[10, 4, white], [20, 4, red], [10, 25, blue], [13, 25, red]])
    renderOverflow('border paths inherit affine transforms and opacity', [node('parent', { opacity: 0.5,
      style: { transform: { a: 1, b: 0, c: 0, d: 1, e: 8, f: 4 } }, children: [bordered({
        bounds: { x: 8, y: 8, width: 20, height: 20 }, style: { border: borderSides(4, red) },
      })],
    })], [[26, 13, [255, 127, 127, 255]], [17, 22, [255, 127, 127, 255]], [26, 22, white], [10, 13, white]])
    renderOverflow('ancestor clip constrains the complete descendant border ring', [node('ancestor', {
      bounds: { x: 8, y: 8, width: 32, height: 32 }, computed_style: { overflow: 'hidden' },
      children: [bordered({ bounds: { x: 4, y: 12, width: 40, height: 24 }, style: { border: borderSides(4, red) } })],
    })], [[20, 13, red], [42, 13, white], [6, 13, white], [20, 20, white]])
  } finally { image?.delete(); picture?.delete(); recorder.delete(); surface?.delete(); font.delete(); face.delete() }
})

test('unit native media: pending slots paint normally and accepted RGBA uses the same image paint slot',async()=>{
  const b=fakeBackend(),presenter=await b.create(),actual=imageFrame('aspectFill',{tag:'camera',attributes:{id:'camera'}})
  try{
    delete actual.root.children[0].image;actual.images={};presenter.submit(actual)
    const resource='weapp-native-component-frame:camera';actual.images={[resource]:rgbaResource()};actual.root.children[0].image={resource,mode:'aspectFill'}
    const before=b.calls.length;presenter.submit(actual)
    assert.equal(b.calls.slice(before).filter(([name])=>name==='record.drawImageRectOptions').length,1)
    actual.root.children[0].image.resource=imageResourceId;actual.images={[imageResourceId]:rgbaResource()}
    assert.throws(()=>presenter.submit(actual),/owner-validated RGBA frame resource/)
  }finally{presenter.dispose()}
})


const exactTestFont = new ArrayBuffer(1)
const exactTestIdentity = { sha256: createHash('sha256').update(new Uint8Array(exactTestFont)).digest('hex'), face_index: 0, profile: 'sfnt-unhinted-v1' }
function exactTextFrame() {
  return { frame_id: 93, viewport: { ...box }, root: node('exact-face', {
    text: 'A\u200bB', text_style: textStyle(),
    text_layout: textLayout([['A', 0, 18], ['\u200b', 8, 18], ['B', 8, 18]], {
      measurement: { font: { ...exactTestIdentity } }, metrics: { width: 16, height: 24, line_count: 1 },
    }),
  }) }
}
test('font-bound plans replay only their accepted face and ignore invisible scalar ink without reflow', async () => {
  const b = fakeBackend(), presenter = await b.create({ fontIdentity: exactTestIdentity })
  try {
    const actual = exactTextFrame(), source = structuredClone(actual)
    const receipt = presenter.submit(actual)
    assert.deepEqual(actual, source, 'painter must preserve committed positions/source')
    assert.deepEqual(b.calls.filter(([name]) => name === 'font.linear'), [['font.linear', true]])
    assert.deepEqual(b.calls.filter(([name]) => name === 'font.hinting'), [['font.hinting', 0]])
    assert.equal(b.calls.filter(([name]) => name === 'record.drawGlyphs').length, 1)
    assert.deepEqual(glyphPositions(b.calls), [[0,18],[8,18]])
    assert.equal(b.calls.some(([name]) => name === 'font.measure'), false)
    assert.equal(receipt.textPlans.font, 1)
    for (const change of [
      frame => { frame.root.text_layout.measurement = 'fallback' },
      frame => { frame.root.text_layout.measurement.font.sha256 = '0'.repeat(64) },
      frame => { frame.root.text_layout.measurement.font.profile = 'another-profile' },
      frame => { delete frame.root.text_layout },
    ]) {
      const invalid = exactTextFrame(); change(invalid); const before = b.calls.length
      assert.throws(() => presenter.submit(invalid), error => ['ERR_RENDER', 'ERR_UNSUPPORTED_CAPABILITY'].includes(error.code))
      assert.equal(b.calls.length, before, 'rejected binding must not allocate a recording or mutate the accepted surface')
      assert.equal(presenter.lastReceipt, receipt)
    }
  } finally { presenter.dispose() }
  assert.equal(b.listeners.size, 0)
})
test('painter rejects wrong font digest before GPU allocation and releases its listener', async () => {
  const b = fakeBackend()
  await assert.rejects(b.create({ fontIdentity: { ...exactTestIdentity, sha256: '0'.repeat(64) } }), coded('ERR_RENDER', /differs/))
  assert.equal(b.calls.some(([name]) => name === 'GetWebGLContext'), false)
  assert.equal(b.listeners.size, 0)
})


test('font-bound hidden text requires no plan/coverage while transparent text retains metric validation', async () => {
  const b = fakeBackend(), presenter = await b.create({ fontIdentity: exactTestIdentity })
  try {
    const hidden = node('hidden', { text: '\u{10ffff}', style: { display: 'none' },
      children: [node('also-hidden', { text: '\u{10ffff}' })] })
    presenter.submit({ frame_id: 94, viewport: { ...box }, root: hidden })
    assert.equal(b.calls.some(([name]) => name === 'record.drawGlyphs'), false)
    const transparent = exactTextFrame(); transparent.root.opacity = 0; delete transparent.root.text_layout
    assert.throws(() => presenter.submit(transparent), coded('ERR_UNSUPPORTED_CAPABILITY', /font-bound/))
  } finally { presenter.dispose() }
})


test('bound painter owns an immutable copy across asynchronous font digest verification', async () => {
  let decoded
  const b = fakeBackend({ onTypefaceData: data => { decoded = new Uint8Array(data).slice() } })
  const borrowed = new ArrayBuffer(1)
  const creating = CanvasKitFramePresenter.create(b.CK, b.canvas, borrowed, { fontIdentity: exactTestIdentity })
  new Uint8Array(borrowed)[0] = 255
  const presenter = await creating
  try { assert.deepEqual([...decoded], [0]) }
  finally { presenter.dispose() }
})


// Finite Node contracts with fake CanvasKit/WebGL only. The blank->image
// transition proves presenter admission and image reuse; it does not execute
// runtime onReady, WASM owner bindings, a real browser or GPU.
// The image fixture represents the accepted Rust frame AFTER owned_canvas::
// attach has stripped forged reserved resources and inserted exact bindings.
// Arbitrary direct callers can fabricate JSON; namespace spelling alone is
// not authentication and this presenter is not the guest authority boundary.
const ownedCanvasId = 'weapp-owned-canvas:1'
const ownedCanvasFrame = (painted = true) => ({ frame_id: 240, viewport: { ...box },
  images: painted ? { [ownedCanvasId]: rgbaResource() } : {}, root: node('page', {
    children: [node('owned-canvas', { tag: 'canvas', event_identity: 'page:1/canvas:0',
      attributes: { 'canvas-id': 'drawing' }, bounds: { x: 8, y: 10, width: 2, height: 4 },
      ...(painted ? { image: { resource: ownedCanvasId, mode: 'scaleToFill' } } : {}),
    })],
  }) })

test('unit owned canvas: declared blank can present before an owned repaint and clear', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const blank = presenter.submit(ownedCanvasFrame(false))
    assert.equal(blank.status, 'submitted'); assert.equal(blank.imageNodes, 0)
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 0)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawImageRectOptions').length, 0)
    assert.equal(b.calls.filter(([name]) => name === 'surface.flush').length, 1)
    // A successful initial submission can be acknowledged by the host. Real
    // acknowledge_presentation -> onReady -> draw requires the root probe.
    const painted = ownedCanvasFrame(); painted.frame_id++
    const repaint = presenter.submit(painted)
    assert.equal(repaint.generation, 2); assert.equal(repaint.imageNodes, 1)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawImageRectOptions').length, 1)
    const beforeClear = b.calls.length, clear = ownedCanvasFrame(false); clear.frame_id += 2
    const cleared = presenter.submit(clear)
    assert.equal(cleared.generation, 3); assert.equal(cleared.imageNodes, 0)
    assert.equal(b.calls.slice(beforeClear).filter(([name]) => name === 'record.drawImageRectOptions').length, 0)
    assert.equal(b.calls.filter(([name]) => name === 'surface.flush').length, 3)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
})

test('unit owned canvas: trusted typed image follows existing image paint and cache', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const receipt = presenter.submit(ownedCanvasFrame())
    const draw = b.calls.find(([name]) => name === 'record.drawImageRectOptions')
    assert.deepEqual(draw.slice(2, 6), [[0, 0, 4, 2], [8, 10, 10, 14], 'nearest', 'none'])
    assert.deepEqual(b.calls.find(([name]) => name === 'image.new').slice(1), [
      { width: 4, height: 2, colorType: 'rgba8', alphaType: 'unpremul', colorSpace: 'srgb' },
      Uint8Array.from(rgbaResource().pixels), 16,
    ])
    assert.equal(receipt.imageNodes, 1); assert.equal(receipt.imageResources, 1)
    presenter.submit(ownedCanvasFrame())
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 1)
  } finally { presenter.dispose() }
  assert.equal(b.calls.filter(([name]) => name === 'resourceImage.delete').length, 1)
})

test('unit owned canvas: guest canvasId and owner flags grant only a blank slot', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const value = ownedCanvasFrame(false)
    value.root.children[0].attributes = { 'canvas-id': 'weapp-owned-canvas:1', owned: 'true', image: 'weapp-owned-canvas:1' }
    value.root.children[0].owned = true
    const receipt = presenter.submit(value)
    assert.equal(receipt.imageNodes, 0); assert.equal(receipt.imageResources, 0)
    assert.equal(b.calls.filter(([name]) => name === 'image.new').length, 0)
    assert.equal(b.calls.filter(([name]) => name === 'record.drawImageRectOptions').length, 0)
  } finally { presenter.dispose() }
})

for (const [label, mutate] of [
  ['ordinary typed image reference', value => { value.images = { [imageResourceId]: rgbaResource() }; value.root.children[0].image.resource = imageResourceId }],
  ['guest namespace suffix', value => { const resource = 'weapp-owned-canvas:guest'; value.images = { [resource]: rgbaResource() }; value.root.children[0].image.resource = resource }],
  ['zero ordinal', value => { const resource = 'weapp-owned-canvas:0'; value.images = { [resource]: rgbaResource() }; value.root.children[0].image.resource = resource }],
  ['prefix without resource', value => { value.images = {} }],
  ['wrong image mode', value => { value.root.children[0].image.mode = 'aspectFill' }],
  ['map reusing owned image', value => { value.root.children[0].tag = 'map' }],
  ['web-view reusing owned image', value => { value.root.children[0].tag = 'web-view' }],
  ['non-object image', value => { value.root.children[0].image = false }],
]) test(`unit owned canvas: ${label} is unsupported and preserves the accepted blank frame`, async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit(ownedCanvasFrame(false))
    const value = ownedCanvasFrame(); mutate(value)
    const before = b.calls.length, receipt = presenter.lastReceipt, generation = presenter.generation
    assert.throws(() => presenter.submit(value), coded('ERR_UNSUPPORTED_CAPABILITY'))
    assert.equal(b.calls.length, before, 'negative admission performs no image allocation, recording or visible submission')
    assert.equal(presenter.lastReceipt, receipt); assert.equal(presenter.generation, generation)
  } finally { presenter.dispose() }
})

test('unit owned canvas: malformed reserved image bytes reject before publication', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    presenter.submit(ownedCanvasFrame(false))
    const value = ownedCanvasFrame(); value.images[ownedCanvasId].pixels.pop()
    const before = b.calls.length, receipt = presenter.lastReceipt
    assert.throws(() => presenter.submit(value), coded('ERR_RENDER', /RGBA byte length/))
    assert.equal(b.calls.length, before); assert.equal(presenter.lastReceipt, receipt)
  } finally { presenter.dispose() }
})


test('unit image cache: aligned word comparison checks every byte and unaligned views stay exact', async () => {
  const b = fakeBackend(), presenter = await b.create()
  try {
    const current = imageFrame(), resource = current.images[imageResourceId]
    resource.pixels = Uint8Array.from(resource.pixels)
    assert.equal(presenter.submit(current).imageCache.misses, 1)
    assert.equal(presenter.submit(current).imageCache.hits, 1)
    for (let byte = 0; byte < resource.pixels.length; byte++) {
      resource.pixels[byte] ^= 1
      assert.equal(presenter.submit(current).imageCache.misses, 1, `changed byte ${byte}`)
      assert.equal(presenter.submit(current).imageCache.hits, 1)
    }
    const unaligned = new Uint8Array(resource.pixels.length + 1).subarray(1)
    unaligned.set(resource.pixels); resource.pixels = unaligned
    assert.equal(presenter.submit(current).imageCache.hits, 1)
    unaligned[unaligned.length - 1] ^= 1
    assert.equal(presenter.submit(current).imageCache.misses, 1)
  } finally { presenter.dispose() }
})
