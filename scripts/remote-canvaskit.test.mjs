import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { RemoteCanvasKitRenderer, RemoteRenderResources, validateRemoteFrame } from '../examples/hosts/web-wasm/remote-canvaskit.mjs'
import { CanvasKitFramePresenter } from '../examples/hosts/web-wasm/canvaskit-presenter.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = (entries = { 'encoded-asset-id': [240, 20, 10, 255] }, revision = 1, sessionId = 'test-session') => {
  const resources = Object.fromEntries(Object.entries(entries).map(([id, pixels]) => {
    const sha256 = hash(Uint8Array.from(pixels))
    return [id, { sha256, width: pixels.length / 4, height: 1, byteLength: pixels.length, format: 'rgba8',
      url: `/api/render-resources/${hash(sessionId)}/1/${revision}/${sha256}` }]
  }))
  return { schemaVersion: 1, protocolVersion: '1.0', format: 'render-frame-v1', sessionId,
    frameId: revision, sourceFrameId: revision, configGeneration: 1, renderRevision: revision,
    width: 128, height: 128, logicalWidth: 64, logicalHeight: 64,
    frame: { frame_id: revision, viewport: { x: 0, y: 0, width: 64, height: 64 }, root: {} }, resources }
}
const fetcher = (sources, calls = []) => async url => {
  calls.push(url)
  const pixels = sources.get(url.split('/').at(-1))
  return pixels ? new Response(Uint8Array.from(pixels)) : new Response('', { status: 404 })
}
const sources = entries => new Map(Object.values(entries).map(bytes => [hash(Uint8Array.from(bytes)), bytes]))

test('remote frame: typed image bytes verify raw RGBA hashes and deduplicate across accepted revisions', async () => {
  const entries = { 'encoded-asset-id': [240, 20, 10, 255] }, calls = []
  const resources = new RemoteRenderResources(fetcher(sources(entries), calls))
  const first = await resources.hydrate(fixture(entries))
  assert.ok(first.renderFrame.images['encoded-asset-id'].pixels instanceof Uint8Array)
  assert.deepEqual([...first.renderFrame.images['encoded-asset-id'].pixels], entries['encoded-asset-id'])
  const next = await resources.hydrate(fixture(entries, 2))
  assert.equal(calls.length, 1)
  assert.equal(next.renderFrame.images['encoded-asset-id'].pixels, first.renderFrame.images['encoded-asset-id'].pixels)
  assert.equal(resources.bytes, 4)
  resources.clear(); assert.equal(resources.bytes, 0)
})

test('remote frame: bad resource hash, size or late abort does not publish staged cache entries', async () => {
  for (const mode of ['hash', 'size', 'abort']) {
    const controller = new AbortController()
    const entries = { a: [1, 2, 3, 255], b: [4, 5, 6, 255] }, served = sources(entries)
    let calls = 0
    const resources = new RemoteRenderResources(async url => {
      calls++
      if (calls === 2 && mode === 'abort') controller.abort()
      const pixels = calls === 2 && mode === 'hash' ? [9, 9, 9, 255]
        : calls === 2 && mode === 'size' ? [4, 5, 6] : served.get(url.split('/').at(-1))
      return new Response(Uint8Array.from(pixels))
    })
    await assert.rejects(resources.hydrate(fixture(entries), controller.signal), /ERR_RENDER|ERR_CANCELLED/)
    assert.equal(resources.bytes, 0)
    assert.equal(resources.cache.size, 0)
  }
})

test('remote frame: resource URLs cannot authorize another session, revision or arbitrary path', async () => {
  for (const change of ['session', 'revision', 'path', 'hash']) {
    const value = fixture(), descriptor = value.resources['encoded-asset-id']
    if (change === 'session') descriptor.url = descriptor.url.replace(hash(value.sessionId), hash('another'))
    if (change === 'revision') descriptor.url = descriptor.url.replace('/1/1/', '/1/2/')
    if (change === 'path') descriptor.url = 'https://example.com/private'
    if (change === 'hash') descriptor.url = descriptor.url.slice(0, -64) + 'a'.repeat(64)
    let calls = 0
    const resources = new RemoteRenderResources(async () => { calls++; throw new Error('unexpected fetch') })
    await assert.rejects(resources.hydrate(value), /ERR_RENDER/)
    assert.equal(calls, 0)
  }
})

test('remote frame: decoded bytes cache is bounded and changes under a source ID fetch new content', async () => {
  const a = { source: [1, 2, 3, 255] }, b = { source: [4, 5, 6, 255] }, c = { source: [7, 8, 9, 255] }
  const calls = [], served = new Map([...sources(a), ...sources(b), ...sources(c)])
  const resources = new RemoteRenderResources(fetcher(served, calls), { budgetBytes: 8 })
  await resources.hydrate(fixture(a)); await resources.hydrate(fixture(b, 2)); await resources.hydrate(fixture(a, 3))
  assert.equal(calls.length, 2)
  await resources.hydrate(fixture(c, 4)); await resources.hydrate(fixture(b, 5))
  assert.equal(calls.length, 4)
  assert.equal(resources.bytes, 8)
  assert.equal(resources.cache.size, 2)
})

test('remote frame: physical scale is independent from the committed logical viewport', () => {
  const value = fixture()
  assert.equal(validateRemoteFrame(value), value)
  for (const mutate of [v => v.width = 4097, v => v.width = 0, v => v.frame.viewport.width = 128,
    v => v.frame.images = { hidden: { pixels: [0] } }, v => v.renderRevision = -1,
    v => v.sourceFrameId++, v => v.protocolVersion = '2.0']) {
    const invalid = fixture(); mutate(invalid)
    assert.throws(() => validateRemoteFrame(invalid), /ERR_RENDER/)
  }
})

function canvasFixture() {
  const events = [], replacements = [], focusCalls = []
  const ownerDocument = { focused: true, hidden: false, body: { tagName: 'BODY' },
    hasFocus() { return this.focused }, createElement: () => make() }
  ownerDocument.activeElement = ownerDocument.body
  function make() {
    const attributes = new Map()
    return { width: 64, height: 64, id: 'screen', className: '', style: { cssText: '' }, ownerDocument,
      get tabIndex() { return attributes.has('tabindex') ? Number(attributes.get('tabindex')) : -1 },
      set tabIndex(value) { attributes.set('tabindex', String(value)) },
      get attributes() { return [...attributes].map(([name, value]) => ({ name, value })) },
      setAttribute: (name, value) => attributes.set(name, String(value)),
      getAttribute: name => attributes.get(name) ?? null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent: event => events.push(event.type),
      focus(options) { ownerDocument.activeElement = this; focusCalls.push({ canvas: this, options }) },
      replaceWith(canvas) {
        replacements.push(canvas)
        // Removing the focused element blurs it. A test must not let a stale
        // activeElement reference disguise a missing replacement focus call.
        if (ownerDocument.activeElement === this) ownerDocument.activeElement = ownerDocument.body
      } }
  }
  return { canvas: make(), document: ownerDocument, settings: { tagName: 'INPUT' }, events, replacements, focusCalls }
}

test('remote presenter: failed replacement preserves the accepted surface, and stale asynchronous allocation is released', async t => {
  const ui = canvasFixture(), releases = [], renderer = new RemoteCanvasKitRenderer(ui.canvas)
  renderer.assets = Promise.resolve({ CanvasKit: {}, font: new Uint8Array(4) })
  let fail = false, current = true
  t.mock.method(CanvasKitFramePresenter, 'create', async () => ({
    submit() { if (fail) throw new Error('ERR_RENDER: allocation rejected'); return { backend: 'canvaskit-webgl2' } },
    dispose() { releases.push('candidate') },
  }))
  const prepared = { ...fixture(), renderFrame: {} }
  ui.document.activeElement = ui.canvas
  ui.canvas.tabIndex = 0
  fail = true
  await assert.rejects(renderer.present(prepared), /allocation rejected/)
  assert.equal(renderer.canvas, ui.canvas)
  assert.equal(ui.replacements.length, 0)
  assert.equal(releases.length, 1)
  assert.equal(ui.document.activeElement, ui.canvas)
  assert.equal(ui.focusCalls.length, 0)
  fail = false
  t.mock.method(CanvasKitFramePresenter, 'create', async () => {
    current = false
    return { dispose() { releases.push('stale') }, submit() { assert.fail('stale frame cannot submit') } }
  })
  assert.equal(await renderer.present(prepared, () => current), null)
  assert.deepEqual(releases, ['candidate', 'stale'])
  assert.equal(ui.document.activeElement, ui.canvas)
  assert.equal(ui.focusCalls.length, 0)
  renderer.dispose()
})

test('remote presenter: replacement retains canvas accessibility and transfers only its owned foreground focus', async t => {
  const ui = canvasFixture(), renderer = new RemoteCanvasKitRenderer(ui.canvas)
  t.after(() => renderer.dispose())
  renderer.assets = Promise.resolve({ CanvasKit: {}, font: new Uint8Array(4) })
  const canvas = ui.canvas
  canvas.tabIndex = 0
  for (const [name, value] of Object.entries({
    role: 'application', 'aria-label': 'Mini program preview', 'aria-describedby': 'preview-help',
    'aria-keyshortcuts': 'Enter', title: 'Interactive preview', accesskey: 'p', lang: 'zh-CN', dir: 'ltr',
    autofocus: '', onclick: 'unsafe()',
  })) canvas.setAttribute(name, value)
  ui.document.activeElement = canvas
  t.mock.method(CanvasKitFramePresenter, 'create', async () => ({
    submit: () => ({ backend: 'canvaskit-webgl2' }), dispose() {},
  }))
  await renderer.present({ ...fixture(), renderFrame: {} })
  assert.notEqual(renderer.canvas, canvas)
  assert.equal(renderer.canvas.tabIndex, 0)
  for (const { name, value } of canvas.attributes) {
    if (!['autofocus', 'onclick'].includes(name)) assert.equal(renderer.canvas.getAttribute(name), value, name)
  }
  assert.equal(renderer.canvas.getAttribute('autofocus'), null, 'autofocus cannot bypass explicit focus ownership')
  assert.equal(renderer.canvas.getAttribute('onclick'), null)
  assert.equal(ui.document.activeElement, renderer.canvas)
  assert.deepEqual(ui.focusCalls, [{ canvas: renderer.canvas, options: { preventScroll: true } }])
})

for (const state of ['settings', 'background', 'hidden', 'unfocused-document']) {
  test(`remote presenter: replacement never steals ${state} focus`, async t => {
    const ui = canvasFixture(), renderer = new RemoteCanvasKitRenderer(ui.canvas)
    t.after(() => renderer.dispose())
    renderer.assets = Promise.resolve({ CanvasKit: {}, font: new Uint8Array(4) })
    ui.canvas.tabIndex = 0
    ui.document.activeElement = state === 'settings' ? ui.settings : ui.canvas
    if (state === 'background' || state === 'unfocused-document') ui.document.focused = false
    if (state === 'background') ui.document.activeElement = ui.settings
    if (state === 'hidden') ui.document.hidden = true
    t.mock.method(CanvasKitFramePresenter, 'create', async () => ({
      submit: () => ({ backend: 'canvaskit-webgl2' }), dispose() {},
    }))
    await renderer.present({ ...fixture(), renderFrame: {} })
    assert.equal(ui.replacements.length, 1)
    assert.equal(ui.focusCalls.length, 0)
    assert.equal(ui.document.activeElement, ['settings', 'background'].includes(state) ? ui.settings : ui.document.body)
  })
}

test('remote presenter: asynchronous allocation samples focus and accessibility only at replacement', async t => {
  const ui = canvasFixture(), renderer = new RemoteCanvasKitRenderer(ui.canvas)
  t.after(() => renderer.dispose())
  renderer.assets = Promise.resolve({ CanvasKit: {}, font: new Uint8Array(4) })
  let begin, finish
  const creating = new Promise(resolve => { begin = resolve })
  const allocated = new Promise(resolve => { finish = resolve })
  ui.document.activeElement = ui.canvas
  ui.canvas.tabIndex = 0
  ui.canvas.setAttribute('aria-label', 'Preparing preview')
  t.mock.method(CanvasKitFramePresenter, 'create', () => { begin(); return allocated })
  const presenting = renderer.present({ ...fixture(), renderFrame: {} })
  await creating
  ui.document.activeElement = ui.settings
  ui.canvas.tabIndex = 3
  ui.canvas.setAttribute('aria-label', 'Updated preview')
  finish({ submit: () => ({ backend: 'canvaskit-webgl2' }), dispose() {} })
  await presenting
  assert.equal(ui.document.activeElement, ui.settings)
  assert.equal(ui.focusCalls.length, 0)
  assert.equal(renderer.canvas.tabIndex, 3)
  assert.equal(renderer.canvas.getAttribute('aria-label'), 'Updated preview')
})

test('remote presenter: a same-size frame preserves the canvas and its existing focus without refocusing', async t => {
  const ui = canvasFixture(), renderer = new RemoteCanvasKitRenderer(ui.canvas)
  t.after(() => renderer.dispose())
  renderer.assets = Promise.resolve({ CanvasKit: {}, font: new Uint8Array(4) })
  ui.document.activeElement = ui.canvas
  renderer.presenter = { submit: () => ({ backend: 'canvaskit-webgl2' }), dispose() {} }
  t.mock.method(CanvasKitFramePresenter, 'create', () => assert.fail('same-size accepted surface must be reused'))
  await renderer.present({ ...fixture(), width: 64, height: 64, renderFrame: {} })
  assert.equal(renderer.canvas, ui.canvas)
  assert.equal(ui.replacements.length, 0)
  assert.equal(ui.document.activeElement, ui.canvas)
  assert.equal(ui.focusCalls.length, 0)
})

test('remote presenter: an old surface cleanup failure cannot prevent input rebinding and remains observable', async t => {
  const ui = canvasFixture(), renderer = new RemoteCanvasKitRenderer(ui.canvas)
  renderer.assets = Promise.resolve({ CanvasKit: {}, font: new Uint8Array(4) })
  let releases = 0
  renderer.presenter = { dispose() { throw new Error('old-context cleanup failed') } }
  t.mock.method(CanvasKitFramePresenter, 'create', async () => ({
    submit: () => ({ backend: 'canvaskit-webgl2' }), dispose() { releases++ },
  }))
  const receipt = await renderer.present({ ...fixture(), renderFrame: {} })
  assert.deepEqual(ui.events, ['weapp-surface-replaced'])
  assert.equal(ui.replacements[0], renderer.canvas)
  assert.deepEqual(receipt.cleanupErrors, ['old-context cleanup failed'])
  assert.throws(() => renderer.dispose(), /old-context cleanup failed/)
  assert.equal(releases, 1)
  renderer.dispose()
  assert.equal(releases, 1)
})
