// Browser-side assertions shared by the installed-release acceptance runner.
// Every runtime/adapter import below comes from the verified installation map.
const check = (value, message) => { if (!value) throw new Error(message) }
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',')}}`
  : JSON.stringify(value)
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
const bytes = async url => {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' })
  check(response.ok, `HTTP ${response.status}: ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}
const json = value => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value))
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
let sequence = 0
const envelope = (sessionId, op, payload) => ({ protocolVersion: '1.0', sessionId, requestId: `acceptance-${++sequence}`, kind: 'request', op, payload })
const ok = batch => {
  const response = batch.messages.find(message => message.kind === 'response')
  check(response?.payload?.ok === true, JSON.stringify(batch))
  return response.payload
}

export async function readPack(indexUrl) {
  const indexBytes = await bytes(indexUrl), index = json(indexBytes)
  const manifestBytes = await bytes(new URL(index.manifest, indexUrl)), manifest = json(manifestBytes)
  check(await hash(manifestBytes) === index.manifestSha256, 'manifest hash mismatch')
  check(manifest.integrity.root === index.integrityRoot, 'index root mismatch')
  check(await hash(new TextEncoder().encode(canonical({ ...manifest, integrity: { ...manifest.integrity, root: '' } }))) === index.integrityRoot, 'manifest root mismatch')
  const blobs = {}
  for (const blob of index.blobs) {
    const content = await bytes(new URL(blob.url, indexUrl))
    check(content.length === blob.size && await hash(content) === blob.sha256, 'blob hash mismatch')
    blobs[`sha256:${blob.sha256}`] = [...content]
  }
  const entry = manifest.modules.find(module => module.id.replace(/^module:/, '') === manifest.app.entryModule.replace(/^module:/, ''))
  return { indexUrl, indexBytes, index, manifest, entry, blobs, modules: manifest.modules.map(module => ({ id: module.id, bytes: blobs[`sha256:${module.sha256}`] })) }
}

// This owner deliberately makes no presentation/controller-switch claim.
// Its completion evidence is the actual public native transport and guest JS.
export async function openGuest({ mode, pack, application, account, metrics, identity, configureServices }) {
  const prefix = `/${mode}/`
  const module = mode === 'direct' ? await import(`${prefix}pkg/container_host_web.js`) : null
  if (module) await module.default()
  const { BrowserHostServices } = await import(`${prefix}browser-host-services.mjs`)
  let host, client, services, sessionId, retired = false, closing = null
  const cleanup = []
  const close = () => {
    if (closing) return closing
    retired = true
    return closing = (async () => {
    const failures = []
    for (const [kind, active, release] of [
      ['host-services', services, () => services.close()],
      ['worker-runtime-owner', client, async () => { const result = await client.close(); check(result.closed === true, 'Worker close omitted its terminal receipt') }],
      ['direct-runtime-owner', host, () => { try { host.unload() } finally { host.free() } }],
    ]) {
      if (!active) continue
      try { await release(); cleanup.push({ kind, id: `${sessionId}-${kind}`, ownership: 'created', terminal: 'closed' }) }
      catch (error) { cleanup.push({ kind, id: `${sessionId}-${kind}`, ownership: 'created', terminal: 'failed', error: String(error) }); failures.push(error) }
    }
    host = client = services = null
    if (failures.length) throw new AggregateError(failures, 'Guest owner cleanup failed')
      return cleanup
    })()
  }
  try {
    const catalog = json(await bytes('/catalog.json'))
    check(catalog.baseline.baseLibrary === '3.17.3', 'locked catalog required')
    const { windowWidth, windowHeight, ...displayMetrics } = metrics
    const nativeHost = { kind: 'web', windowWidth, windowHeight, displayMetrics }
    let transport
    if (mode === 'direct') {
      sessionId = `acceptance-direct-${++sequence}`
      host = new module.WebWasmHost()
      host.load_manifest_json_with_config(canonical(pack.manifest), JSON.stringify({ session_id: sessionId, engine: 'quickjs', require_integrity: true, renderer_mode: 'external-frame', host: nativeHost }))
      transport = host
    } else {
      const { WorkerRpcClient } = await import('/worker/worker-session-client.mjs')
      const { WorkerHostServicesTransport } = await import('/worker/worker-host-services.mjs')
      client = new WorkerRpcClient({ workerUrl: `${prefix}runtime-worker.mjs`, timeoutMs: 30000, closeTimeoutMs: 5000 })
      transport = new WorkerHostServicesTransport({ nativeHostServices: (op, payload = {}) => client.requestHost(op, payload), revokeHostIdentity: () => client.requestHost('native.revoke', {}) })
      sessionId = client.sessionId
    }
    services = new BrowserHostServices({ runtime: transport, catalog, allowedOrigins: [location.origin], ...(identity ? { identity } : {}) })
    await configureServices?.(services)
    await services.configure({ application, account })
    if (host) {
      const initialized = ok(JSON.parse(host.dispatch_json(JSON.stringify(envelope(sessionId, 'app.init', { blobs: pack.blobs, modules: pack.modules, launchOptions: {} })))))
      check(initialized.engineProviderAvailable === true, 'direct QuickJS unavailable')
    } else {
      const loaded = await client.requestHost('load', { indexUrl: pack.indexUrl.href, indexSha256: await hash(pack.indexBytes), indexSize: pack.indexBytes.length, renderer: 'external-frame', engine: 'quickjs', viewport: { width: metrics.windowWidth, height: metrics.windowHeight }, metrics, hostServices: transport.configuration, loadTimeoutMs: 30000 })
      transport.activate(loaded)
      sessionId = client.sessionId
    }
    const call = async (name, args = []) => {
      check(!retired, 'Execution owner is retired; guest commands are blocked')
      const payload = { moduleId: pack.entry.id, export: name, args }
      const batch = host ? JSON.parse(host.dispatch_json(JSON.stringify(envelope(sessionId, 'module.call', payload)))) : await client.requestHost('bridge', { envelope: envelope(sessionId, 'module.call', payload) })
      return ok(batch).result[0]
    }
    return { call, services, sessionId, close, cleanup,
      wait: async (name, predicate, args = []) => {
        const deadline = performance.now() + 15000
        for (;;) {
          await services.drain(); await tick()
          const result = await call(name, args)
          if (predicate(result)) return result
          check(performance.now() < deadline, `Guest completion timed out: ${name} ${JSON.stringify(result)}`)
        }
      },
    }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      const failure = new AggregateError([error, cleanupError], 'Guest startup and cleanup failed')
      failure.ownerCleanup = cleanup; throw failure
    }
    error.ownerCleanup = cleanup
    throw error
  }
}

const device = { brand: 'Web', model: 'Chrome 156', system: 'macOS 27.2', platform: 'mac', version: '27.2', SDKVersion: '0.1.0' }
export async function runBrowserScope({ scope, metrics }) {
  const report = { modes: {}, cleanup: [] }
  globalThis.__webAcceptanceScope = report
  for (const mode of ['direct', 'worker']) {
    const pack = await readPack(new URL(`/fixtures/${scope}/${mode}/pack-index.json`, location.href))
    const application = { hostAppId: `${scope}-${mode}`, tenantId: 'probe', publisherId: 'explicit-fixture', appId: `${scope}-${mode}-app`, environment: 'trial', version: `${scope}-scope`, packRoot: pack.index.integrityRoot }
    let owner
    try {
      owner = await openGuest({ mode, pack, application, account: { principalId: `${scope}-principal`, epoch: '9007199254740993' }, metrics,
        configureServices: scope === 'device-info' ? services => services.setSyncSnapshot('wx.getDeviceInfo', device) : undefined })
      if (scope === 'get-clipboard') await navigator.clipboard.writeText('weapp-get-clipboard-scope')
      const started = await owner.call('__acceptanceProbe')
      const asynchronous = ['network', 'clipboard', 'get-clipboard', 'get-setting'].includes(scope)
      let observed = asynchronous ? await owner.wait('__acceptanceRead', result => result.error !== null || result.value !== null) : started
      if (asynchronous) {
        check(observed.error === null, `${scope}/${mode} callback error: ${JSON.stringify(observed.error)}`)
        observed = observed.value
      }
      switch (scope) {
        case 'window-info': {
          const keys = ['windowWidth', 'windowHeight', 'pixelRatio', 'screenWidth', 'screenHeight', 'statusBarHeight', 'screenTop']
          check(Object.keys(observed).sort().join(',') === keys.sort().join(','), 'unexpected getWindowInfo shape')
          for (const key of keys) check(observed[key] === metrics[key], `getWindowInfo ${key} mismatch`)
          break
        }
        case 'system-setting': check(canonical(observed) === canonical({ deviceOrientation: metrics.deviceOrientation }), 'getSystemSetting shape/value mismatch'); break
        case 'app-base-info': check(canonical(observed) === canonical({ SDKVersion: '0.1.0', host: { appId: `app-base-info-${mode}` }, version: '', enableDebug: false }), 'getAppBaseInfo mismatch'); break
        case 'device-info': check(canonical(observed) === canonical(device), 'getDeviceInfo shape/value mismatch'); break
        case 'app-authorize-setting': {
          const expected = {}
          for (const [name, key] of [['camera', 'cameraAuthorized'], ['microphone', 'microphoneAuthorized'], ['geolocation', 'locationAuthorized']]) {
            try { const permission = await navigator.permissions.query({ name }); expected[key] = permission.state === 'granted' ? 'authorized' : permission.state === 'denied' ? 'denied' : 'not determined' } catch { /* Browser does not expose this permission. */ }
          }
          check(canonical(observed) === canonical(expected), 'getAppAuthorizeSetting shape/value mismatch')
          break
        }
        case 'network': {
          const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection
          const type = connection?.type, effective = connection?.effectiveType
          const networkType = navigator.onLine === false ? 'none' : type === 'wifi' || type === 'none' ? type : effective === '2g' || effective === 'slow-2g' ? '2g' : effective === '3g' ? '3g' : effective === '4g' ? '4g' : 'unknown'
          check(canonical(observed) === canonical({ errMsg: 'getNetworkType:ok', networkType }), 'getNetworkType mapping mismatch')
          break
        }
        case 'clipboard': check(observed?.errMsg === 'setClipboardData:ok' && await navigator.clipboard.readText() === 'weapp-clipboard-scope', 'clipboard write/oracle mismatch'); break
        case 'get-clipboard': check(observed?.data === 'weapp-get-clipboard-scope' && await navigator.clipboard.readText() === 'weapp-get-clipboard-scope', 'clipboard read/oracle mismatch'); break
        case 'get-setting': check(canonical(observed) === canonical({ errMsg: 'getSetting:ok', authSetting: { 'scope.camera': true, 'scope.record': true, 'scope.userLocation': true, 'scope.clipboard': false } }), 'getSetting exact permission vector mismatch'); break
        default: throw new Error(`Unknown browser scope: ${scope}`)
      }
      report.modes[mode] = { observed, sessionId: owner.sessionId, transport: mode === 'direct' ? 'WebWasmHost' : 'WorkerRpcClient->runtime-worker.mjs' }
    } catch (error) { if (!owner && error.ownerCleanup) report.cleanup.push(...error.ownerCleanup); throw error }
    finally { if (owner) { try { await owner.close() } finally { report.cleanup.push(...owner.cleanup) } } }
  }
  return report
}
