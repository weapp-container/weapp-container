import assert from 'node:assert/strict'
import test from 'node:test'
import { validateIOSAppEvidence, validateIOSEmbeddingEvidence } from './validate-ios-app-evidence.mjs'

function fixture() {
  const root = 'a'.repeat(64)
  return {
    manifest: { integrity: { root }, routes: [{ path: 'pages/home' }], modules: [{ id: 'app.js' }], templates: [{ id: 'template:pages/home.wxml' }] },
    probe: { schemaVersion: 1, status: 'passed', source: 'ios-skia-metal-app', containerSurfaceAttached: true, gpuSurface: true,
      rendererBackend: 'skia-gpu-metal', detachStatus: 0, commandBufferStatus: 4,
      host: 'ios', engine: 'quickjs', sessionId: 'test-ios', manifestIntegrity: root, frameId: 1,
      snapshotSha256: 'e'.repeat(64),
      width: 1125, height: 2001,
      logicalViewport: { width: 375, height: 667 },
      drawableReadback: { width: 1125, height: 2001, format: 'bgra8-premultiplied', byteCount: 1125 * 2001 * 4, sha256: 'c'.repeat(64), pngSha256: 'd'.repeat(64) },
      runtimeSurface: { loaded: true, nativeSurface: true, gpuSurface: true, renderer: 'skia-gpu-metal' },
      startup: { input: 'portable-pack', integrityRoot: root, route: 'pages/home', diagnostics: [], engine: 'quickjs', sessionId: 'test-ios' },
      operations: Object.fromEntries(['app.init', 'app.lifecycle', 'page.push', 'render.commit', 'render.snapshot'].map(operation => [operation, { status: 0,
        sessionId: 'test-ios',
        request: { op: operation, kind: 'request', protocolVersion: '1.0', sessionId: 'test-ios', requestId: operation,
          payload: operation === 'render.commit' ? { templateId: 'template:pages/home.wxml', frameId: 1, viewport: { x: 0, y: 0, width: 375, height: 667 } }
            : operation === 'app.lifecycle' ? { event: 'launch' } : operation === 'page.push' ? { path: 'pages/home' } : {} },
        json: operation === 'render.snapshot' ? JSON.stringify({ frame_id: 1, format: 'rgba8-premultiplied', width: 375, height: 667, pixelCount: 1000500, sha256: 'e'.repeat(64) })
          : JSON.stringify({ messages: [{ kind: 'response', op: operation, protocolVersion: '1.0', requestId: operation, sessionId: 'test-ios', payload: { ok: true, engine: 'quickjs', manifest: { integrity: root }, engineProviderAvailable: true, loadedModules: 1, committed: true, source: 'manifest', templateId: 'template:pages/home.wxml', frameId: 1 } }] }),
      }])),
      gpuProbe: { status: 'passed' },
    },
  }
}

function embeddingFixture({ navigated = false } = {}) {
  const value = fixture()
  const { probe, manifest } = value
  probe.source = 'ios-skia-metal-embedding'
  probe.sessionOpen = true
  probe.route = 'pages/home'
  delete probe.detachStatus
  if (navigated) {
    const route = 'pages/details'
    manifest.routes.push({ path: route })
    manifest.templates.push({ id: `template:${route}.wxml` })
    probe.route = route
    probe.frameId = 17
    const render = probe.operations['render.commit']
    render.request.payload = { ...render.request.payload, templateId: `template:${route}.wxml`, frameId: 17 }
    const response = JSON.parse(render.json)
    Object.assign(response.messages[0].payload, { templateId: `template:${route}.wxml`, frameId: 17 })
    render.json = JSON.stringify(response)
    const snapshot = JSON.parse(probe.operations['render.snapshot'].json)
    snapshot.frame_id = 17
    probe.operations['render.snapshot'].json = JSON.stringify(snapshot)
  }
  return value
}

test('accepts complete correlated pack surface evidence', () => {
  const { probe, manifest } = fixture()
  assert.equal(validateIOSAppEvidence(probe, manifest).integrityRoot, manifest.integrity.root)
})
for (const mode of ['smoke', 'embedding']) {
  const make = () => mode === 'embedding' ? embeddingFixture() : fixture()
  const validate = mode === 'embedding' ? validateIOSEmbeddingEvidence : validateIOSAppEvidence
  test(`${mode} evidence requires exactly the supported numeric schema version`, () => {
    for (const schemaVersion of [undefined, 99, 0, '1', true, null]) {
      const { probe, manifest } = make()
      probe.schemaVersion = schemaVersion
      assert.throws(() => validate(probe, manifest), /schema version/)
    }
  })
  test(`${mode} render request must identify the same complete logical viewport as its snapshot`, () => {
    for (const mutate of [
      probe => { delete probe.operations['render.commit'].request.payload.viewport },
      probe => { probe.operations['render.commit'].request.payload.viewport = null },
      probe => { probe.operations['render.commit'].request.payload.viewport.width += 1 },
      probe => { delete probe.operations['render.commit'].request.payload.viewport.height },
      probe => { probe.operations['render.commit'].request.payload.viewport.x = 1 },
      probe => { probe.operations['render.commit'].request.payload.viewport.width = '375' },
      probe => { delete probe.logicalViewport },
      probe => { probe.logicalViewport.width = 0 },
      probe => { probe.logicalViewport.height = 667.5 },
      probe => {
        const snapshot = JSON.parse(probe.operations['render.snapshot'].json)
        snapshot.width += 1
        snapshot.pixelCount = snapshot.width * snapshot.height * 4
        probe.operations['render.snapshot'].json = JSON.stringify(snapshot)
      },
    ]) {
      const { probe, manifest } = make()
      mutate(probe)
      assert.throws(() => validate(probe, manifest), /viewport/)
    }
  })
  test(`${mode} correct acknowledgement cannot conceal an unrelated failed payload in any operation batch`, () => {
    for (const operation of ['app.init', 'app.lifecycle', 'page.push', 'render.commit']) {
      const { probe, manifest } = make()
      const batch = JSON.parse(probe.operations[operation].json)
      batch.messages.push({ kind: 'response', op: 'api.call', protocolVersion: '1.0', sessionId: probe.sessionId,
        requestId: 'sibling-api', payload: { ok: false, error: { code: 'ERR_ENGINE', message: 'provider failed' } } })
      probe.operations[operation].json = JSON.stringify(batch)
      assert.throws(() => validate(probe, manifest), /failed payload/)
    }
    const { probe, manifest } = make()
    probe.startup.diagnostics.push({ op: 'diagnostic', payload: { ok: false, error: { code: 'ERR_ENGINE' } } })
    assert.throws(() => validate(probe, manifest), /runtime errors/)
  })
}
test('nested passed values cannot hide a failed top-level probe', () => {
  const { probe, manifest } = fixture(); probe.status = 'failed'
  assert.throws(() => validateIOSAppEvidence(probe, manifest), /top-level/)
})
test('completion callback with failed command buffer cannot pass', () => {
  const { probe, manifest } = fixture(); probe.commandBufferStatus = 5
  assert.throws(() => validateIOSAppEvidence(probe, manifest), /command buffer/)
})
test('evidence from another manifest, route or inline frame cannot pass', () => {
  for (const [field, value] of [['integrityRoot', 'b'.repeat(64)], ['route', 'pages/missing'], ['input', 'inline-fixture']]) {
    const { probe, manifest } = fixture(); probe.startup[field] = value
    assert.throws(() => validateIOSAppEvidence(probe, manifest))
  }
})
test('missing operations and retained post-publication errors cannot pass', () => {
  const { probe, manifest } = fixture(); delete probe.operations['page.push']
  assert.throws(() => validateIOSAppEvidence(probe, manifest), /page.push/)
  const next = fixture(); next.probe.startup.diagnostics = [{ op: 'error', payload: { code: 'ERR_ENGINE' } }]
  assert.throws(() => validateIOSAppEvidence(next.probe, next.manifest), /runtime errors/)
})
test('CPU snapshot or failed teardown cannot pass the GPU gate', () => {
  for (const [field, value] of [['gpuSurface', false], ['rendererBackend', 'software-fallback'], ['detachStatus', -1]]) {
    const { probe, manifest } = fixture(); probe[field] = value
    assert.throws(() => validateIOSAppEvidence(probe, manifest))
  }
})

test('status zero cannot hide a structured startup or render failure', () => {
  for (const operation of ['app.init', 'page.push', 'render.commit']) {
    const { probe, manifest } = fixture()
    probe.operations[operation].json = JSON.stringify({ messages: [{ kind: 'response', op: operation, payload: { ok: false, error: { code: 'ERR_ENGINE' } } }] })
    assert.throws(() => validateIOSAppEvidence(probe, manifest), /acknowledgement/)
  }
  const { probe, manifest } = fixture()
  const batch = JSON.parse(probe.operations['app.init'].json)
  batch.messages[0].payload.engineProviderAvailable = false
  probe.operations['app.init'].json = JSON.stringify(batch)
  assert.throws(() => validateIOSAppEvidence(probe, manifest), /protocol-only/)
})

test('unrelated response, session, engine and surface frame cannot satisfy the gate', () => {
  for (const field of ['requestId', 'sessionId']) {
    const { probe, manifest } = fixture()
    const batch = JSON.parse(probe.operations['app.init'].json)
    batch.messages[0][field] = 'another'
    probe.operations['app.init'].json = JSON.stringify(batch)
    assert.throws(() => validateIOSAppEvidence(probe, manifest), /another request or session/)
  }
  for (const [field, value] of [['engine', 'v8'], ['frameId', 2]]) {
    const { probe, manifest } = fixture(); probe[field] = value
    assert.throws(() => validateIOSAppEvidence(probe, manifest))
  }
  const { probe, manifest } = fixture()
  probe.operations['render.commit'].request.payload = { root: {}, templateId: 'template:pages/home.wxml' }
  assert.throws(() => validateIOSAppEvidence(probe, manifest), /manifest template/)
})

test('device-only surface and unrelated lifecycle/route cannot masquerade as pack execution', () => {
  for (const [field, value] of [['gpuSurface', false], ['renderer', 'skia-raster']]) {
    const { probe, manifest } = fixture(); probe.runtimeSurface[field] = value
    assert.throws(() => validateIOSAppEvidence(probe, manifest), /own GPU surface/)
  }
  for (const [operation, payload] of [['app.lifecycle', { event: 'hide' }], ['page.push', { path: 'unrelated' }]]) {
    const { probe, manifest } = fixture(); probe.operations[operation].request.payload = payload
    assert.throws(() => validateIOSAppEvidence(probe, manifest))
  }
})

test('live embedding presents a correlated frame without claiming completed teardown', () => {
  const { probe, manifest } = embeddingFixture()
  const result = validateIOSEmbeddingEvidence(probe, manifest)
  assert.equal(result.mode, 'embedding')
  assert.equal(result.source, 'ios-skia-metal-embedding')
  assert.equal(result.route, 'pages/home')
  assert.equal(result.teardownVerified, false)
  assert.equal(probe.detachStatus, undefined)
  // A supplied detach field must not upgrade a live-session receipt.
  probe.detachStatus = 0
  assert.equal(validateIOSEmbeddingEvidence(probe, manifest).teardownVerified, false)
})

test('embedding navigation validates the actual current route and frame independently of initial startup', () => {
  const { probe, manifest } = embeddingFixture({ navigated: true })
  const result = validateIOSEmbeddingEvidence(probe, manifest)
  assert.equal(result.route, 'pages/details')
  assert.equal(probe.startup.route, 'pages/home')
  assert.equal(probe.operations['page.push'].request.payload.path, 'pages/home')
  assert.equal(probe.frameId, 17)
  for (const route of [undefined, 'pages/missing', 'pages/home']) {
    const next = embeddingFixture({ navigated: true })
    next.probe.route = route
    assert.throws(() => validateIOSEmbeddingEvidence(next.probe, next.manifest), /current surface route|manifest template/)
  }
})

test('smoke and embedding sources cannot substitute for each other or bypass smoke teardown', () => {
  const smoke = fixture()
  assert.equal(validateIOSAppEvidence(smoke.probe, smoke.manifest).teardownVerified, true)
  assert.throws(() => validateIOSEmbeddingEvidence(smoke.probe, smoke.manifest), /wrong evidence source/)
  const embedding = embeddingFixture()
  assert.throws(() => validateIOSAppEvidence(embedding.probe, embedding.manifest), /wrong evidence source/)
  smoke.probe.sessionOpen = true
  delete smoke.probe.detachStatus
  assert.throws(() => validateIOSAppEvidence(smoke.probe, smoke.manifest), /teardown/)
})

for (const flag of [false, undefined, null, 1, 'true']) {
  test(`embedding live-session flag ${String(flag)} cannot pass`, () => {
    const { probe, manifest } = embeddingFixture()
    probe.sessionOpen = flag
    assert.throws(() => validateIOSEmbeddingEvidence(probe, manifest), /live session/)
  })
}

test('embedding command-buffer callback failure or retained runtime error cannot pass', () => {
  const value = embeddingFixture()
  value.probe.commandBufferStatus = 5
  assert.throws(() => validateIOSEmbeddingEvidence(value.probe, value.manifest), /command buffer/)
  const next = embeddingFixture()
  const batch = JSON.parse(next.probe.operations['render.commit'].json)
  batch.messages.push({ op: 'error', kind: 'event', payload: { code: 'ERR_RENDER' } })
  next.probe.operations['render.commit'].json = JSON.stringify(batch)
  assert.throws(() => validateIOSEmbeddingEvidence(next.probe, next.manifest), /emitted an error/)
})

for (const mode of ['smoke', 'embedding']) {
  test(`${mode} render request, acknowledgement, surface and snapshot must name the same exact frame`, () => {
    const make = () => mode === 'embedding' ? embeddingFixture({ navigated: true }) : fixture()
    const validate = mode === 'embedding' ? validateIOSEmbeddingEvidence : validateIOSAppEvidence
    for (const mutate of [
      probe => { delete probe.operations['render.commit'].request.payload.frameId },
      probe => { probe.operations['render.commit'].request.payload.frameId += 1 },
      probe => { probe.operations['render.commit'].request.payload.frameId = String(probe.frameId) },
      probe => { probe.frameId += 1 },
      probe => {
        const batch = JSON.parse(probe.operations['render.commit'].json)
        batch.messages[0].payload.frameId += 1
        probe.operations['render.commit'].json = JSON.stringify(batch)
      },
      probe => {
        const snapshot = JSON.parse(probe.operations['render.snapshot'].json)
        snapshot.frame_id += 1
        probe.operations['render.snapshot'].json = JSON.stringify(snapshot)
      },
    ]) {
      const { probe, manifest } = make()
      mutate(probe)
      assert.throws(() => validate(probe, manifest), /another frame|another session or frame/)
    }
  })
}

test('embedding render request, response and snapshot cannot borrow another live session', () => {
  for (const mutate of [
    probe => { probe.operations['render.commit'].request.sessionId = 'foreign' },
    probe => { probe.operations['render.commit'].request.requestId = 'foreign' },
    probe => {
      const batch = JSON.parse(probe.operations['render.commit'].json)
      batch.messages[0].sessionId = 'foreign'
      probe.operations['render.commit'].json = JSON.stringify(batch)
    },
    probe => { probe.operations['render.snapshot'].sessionId = 'foreign' },
  ]) {
    const { probe, manifest } = embeddingFixture({ navigated: true })
    mutate(probe)
    assert.throws(() => validateIOSEmbeddingEvidence(probe, manifest), /request identity|another request or session|another session or frame/)
  }
})
