import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { extname } from 'node:path'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && extname(specifier) === '') {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { HarmonyLiveSession } = await import('../examples/hosts/harmony/entry/src/main/ets/session/LiveSession.ts')

test('installs observed host snapshots and display metrics before app modules initialize', () => {
  const order = []
  const snapshots = {}
  const integrity = 'a'.repeat(64)
  const observation = {
    windowWidth: 360,
    windowHeight: 720,
    displayMetrics: {
      pixelRatio: 2.75,
      screenWidth: 393,
      screenHeight: 852,
      statusBarHeight: 24,
      screenTop: 0,
      deviceOrientation: 'portrait',
    },
    syncSnapshots: {
      'wx.getDeviceInfo': { platform: 'harmony', model: 'test-device' },
      'wx.getSystemInfoSync': { platform: 'harmony', windowWidth: 360, windowHeight: 720 },
      'wx.getWindowInfo': { pixelRatio: 2.75, windowWidth: 360, windowHeight: 720, screenTop: 0 },
      'wx.getSystemSetting': { deviceOrientation: 'portrait', wifiEnabled: true },
      'wx.getAppBaseInfo': { SDKVersion: '3.17.3', language: 'zh_CN' },
    },
  }
  const pack = {
    integrityRoot: integrity,
    manifestJson: '{}',
    manifest: { modules: [{}] },
    blobs: {},
    firstRoute: () => 'pages/index/index',
    requireRoute: route => route,
    modules: () => [{ id: 'module:app.js', bytes: [] }],
    styleIds: () => [],
  }
  const hostServices = {
    setSyncSnapshot(name, value) {
      order.push(`snapshot:${name}`)
      snapshots[name] = value
    },
    configure(identity, acceptedIntegrity) {
      order.push('configure')
      assert.equal(identity.application.packRoot, acceptedIntegrity)
      assert.deepEqual(snapshots, observation.syncSnapshots)
    },
    setForeground() {},
    drain() { return [] },
  }
  let frameId = 0
  const runtime = {
    loadManifestWithConfig(manifestJson, configJson) {
      order.push('manifest.load')
      assert.equal(manifestJson, '{}')
      this.config = JSON.parse(configJson)
      return JSON.stringify({ ok: true })
    },
    dispatch(envelopeJson) {
      const envelope = JSON.parse(envelopeJson)
      order.push(envelope.op)
      let payload = { ok: true }
      if (envelope.op === 'app.init') {
        payload = { ...payload, engineProviderAvailable: true, engine: 'quickjs', loadedModules: 1, manifest: { integrity } }
      } else if (envelope.op === 'render.commit') {
        frameId = envelope.payload.frameId
        payload = { ...payload, committed: true, source: 'manifest', frameId, templateId: envelope.payload.templateId, revision: 1 }
      }
      return JSON.stringify({ messages: [{
        protocolVersion: '1.0', sessionId: 'session-1', requestId: envelope.requestId,
        kind: 'response', op: envelope.op, payload,
      }] })
    },
    inspectState() {
      return JSON.stringify({
        schemaVersion: 1, sessionId: 'session-1', page: { id: 1, route: 'pages/index/index', data: {} },
        frameId, renderRevision: frameId === 0 ? null : 1,
      })
    },
  }

  const session = new HarmonyLiveSession(pack, runtime, {
    sessionId: 'session-1', engine: 'quickjs', width: 360, height: 720,
    hostServices, hostIdentity: { application: { packRoot: integrity }, account: { epoch: '1' } }, hostObservation: observation,
  }, () => {})

  session.start()

  assert.deepEqual(runtime.config.host, {
    windowWidth: 360,
    windowHeight: 720,
    displayMetrics: observation.displayMetrics,
  })
  assert.deepEqual(snapshots, observation.syncSnapshots)
  assert.ok(order.indexOf('configure') < order.indexOf('app.init'))
  assert.ok(order.indexOf('snapshot:wx.getWindowInfo') < order.indexOf('configure'))

  const operations = session.executionOperations()
  assert.deepEqual(Object.keys(operations), ['app.init', 'app.lifecycle', 'page.push', 'render.commit'])
  assert.equal(typeof operations['app.init'].requestJson, 'string')
  const initRequest = JSON.parse(operations['app.init'].requestJson)
  const initResponse = JSON.parse(operations['app.init'].json)
  assert.equal(initRequest.kind, 'request')
  assert.equal(initRequest.sessionId, 'session-1')
  assert.deepEqual(initRequest.payload.manifest, pack.manifest)
  assert.equal(initResponse.messages[0].kind, 'response')
  assert.equal(initResponse.messages[0].requestId, initRequest.requestId)
})
