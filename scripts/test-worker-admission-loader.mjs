/** Draft contracts only: finite fake streams/module; no AppService/WASM/GPU proof. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkerAdmissionLoader, WORKER_RENDERER_PINS, WORKER_ADMISSION_LIMITS } from '../examples/hosts/web-wasm/worker-admission-loader.mjs'

const BASE = 'https://static.test/sample/index.html'
const HOME = 'pages/home/index', SECOND = 'pages/second/index'
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
async function until(predicate) {
  const end = Date.now() + 2000
  while (!predicate()) { assert.ok(Date.now() < end, 'owned fake loader operation did not settle'); await delay(2) }
}
function pack(extra = {}) {
  const blob = bytes('App({});'), hash = sha256(blob)
  const manifest = { schemaVersion: 3, protocolVersion: '1.0',
    compiler: { name: 'weapp-vite', commit: 'loader-fixture', platform: 'weapp' },
    app: { appJson: 'app.json', entryModule: 'app.js' },
    routes: [HOME, SECOND].map(path => ({ id: `route:${path}`, path, kind: 'page', entryModule: `${path}.js` })),
    modules: [{ id: 'module:app.js', sha256: hash, format: 'commonjs', scope: 'app' }],
    templates: [], styles: [], assets: [], capabilities: {}, rendering: { version: '1.0', default: 'skia', pages: { [SECOND]: 'webview' } },
    integrity: { algorithm: 'sha256', root: '' }, ...extra }
  manifest.integrity.root = sha256(bytes(canonical(manifest)))
  const manifestBytes = bytes(manifest)
  const index = { schemaVersion: 1, manifest: './manifest.json', manifestSize: manifestBytes.length,
    manifestSha256: sha256(manifestBytes), integrityRoot: manifest.integrity.root,
    blobs: [{ sha256: hash, size: blob.length, url: `./blobs/${hash}` }] }
  const indexBytes = bytes(index), indexUrl = new URL('pack-index.json', BASE).href
  return { manifest, index, indexBytes, indexUrl, indexSha256: sha256(indexBytes),
    files: new Map([[indexUrl, indexBytes], [new URL('manifest.json', BASE).href, manifestBytes]]) }
}
function staticEnvironment(p = pack(), hooks = {}) {
  const fetched = [], activity = { imports: 0 }
  const loader = createWorkerAdmissionLoader({ baseUrl: BASE, sha256,
    fetch: async (url, init) => {
      fetched.push({ url, init })
      if (hooks.fetch) return hooks.fetch(url, init, p)
      const value = p.files.get(url); assert.ok(value, `unexpected resource read: ${url}`)
      return new Response(value, { headers: { 'content-length': String(value.length) } })
    }, importModule: async () => { activity.imports++; throw new Error('admission must not import drawing or AppService code') },
  })
  const admit = options => loader.admitWorkerPack({ indexUrl: p.indexUrl, indexSha256: p.indexSha256,
    rendererPolicy: { mode: 'manifest' }, ...options })
  return { p, loader, admit, fetched, activity }
}

test('pure admission reads only pinned index+manifest and resolves route/policy without executable imports', async () => {
  const e = staticEnvironment()
  const result = await e.admit({ route: SECOND })
  assert.equal(result.version, '1.0'); assert.equal(result.route, SECOND)
  assert.equal(result.declaredProfile, 'webview'); assert.equal(result.effectiveProfile, 'webview')
  assert.equal(result.transportBackend, 'browser-view'); assert.deepEqual(result.rendererPolicy, { mode: 'manifest' })
  assert.equal(result.provenance.indexSha256, e.p.indexSha256)
  assert.equal(result.provenance.manifestSha256, e.p.index.manifestSha256)
  assert.equal(result.provenance.integrityRoot, e.p.manifest.integrity.root)
  assert.equal(result.provenance.blobsDownloaded, 0); assert.equal(e.activity.imports, 0)
  assert.deepEqual(e.fetched.map(item => item.url), [e.p.indexUrl, new URL('manifest.json', BASE).href])
  assert.equal(Object.isFrozen(result.manifest.rendering.pages), true)
  for (const { init } of e.fetched) { assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'default') }
})

test('cache-eligible static admission independently rechecks every returned index and manifest byte', async () => {
  const p = pack(), cache = new Map([...p.files].map(([url, value]) => [url, new Response(value, { headers: {
    'content-length': String(value.length), 'cache-control': 'public, max-age=31536000, immutable',
  } })]));
  let reads = 0;
  const e = staticEnvironment(p, { fetch: async (url, init) => {
    assert.equal(new Request(url, init).cache, 'default'); reads++;
    return cache.get(url).clone();
  } });
  await e.admit(); await e.admit(); assert.equal(reads, 4, 'HTTP cache reuse must not bypass per-admission integrity verification');
  const corrupt = p.files.get(p.indexUrl).slice(); corrupt[0] ^= 1;
  cache.set(p.indexUrl, new Response(corrupt, { headers: { 'content-length': String(corrupt.length) } }));
  await assert.rejects(e.admit(), /index SHA-256 mismatch/);
  assert.equal(reads, 5, 'a corrupt cached index must stop before manifest fetch');
  cache.set(p.indexUrl, new Response(p.indexBytes));
  const manifestUrl = new URL('manifest.json', BASE).href, altered = p.files.get(manifestUrl).slice(); altered[0] ^= 1;
  cache.set(manifestUrl, new Response(altered));
  await assert.rejects(e.admit(), /manifest SHA-256 mismatch/);
})

test('forced renderer overrides preserve declared profile and unspecified route resolves the actual first route', async () => {
  for (const [profile, backend] of [['webview', 'browser-view'], ['skia', 'external-frame'], ['skyline-compat', 'external-frame']]) {
    const e = staticEnvironment()
    const result = await e.admit({ rendererPolicy: { mode: 'force', profile } })
    assert.equal(result.route, HOME); assert.equal(result.declaredProfile, 'skia')
    assert.equal(result.effectiveProfile, profile); assert.equal(result.transportBackend, backend)
  }
  await assert.rejects(staticEnvironment().admit({ route: 'pages/missing/index' }), { code: 'ERR_INVALID_MANIFEST' })
  await assert.rejects(staticEnvironment().admit({ rendererPolicy: undefined }), { code: 'ERR_INVALID_REQUEST' })
})

test('expected index hash is mandatory and a mismatch stops before manifest read', async () => {
  const e = staticEnvironment()
  await assert.rejects(e.admit({ indexSha256: undefined }), { code: 'ERR_INVALID_MANIFEST' })
  assert.equal(e.fetched.length, 0)
  await assert.rejects(e.admit({ indexSha256: 'f'.repeat(64) }), /index SHA-256 mismatch/)
  assert.equal(e.fetched.length, 1)
})

test('static admission rejects foreign origins, encoded API endpoints, redirects and incorrect size pins', async () => {
  for (const indexUrl of ['https://other.test/pack-index.json', '/api/pack-index', '/%2561pi/index', '/api%255cindex']) {
    const e = staticEnvironment()
    await assert.rejects(e.admit({ indexUrl }), { code: 'ERR_PERMISSION_DENIED' })
    assert.equal(e.fetched.length, 0)
  }
  const e = staticEnvironment()
  await assert.rejects(e.admit({ indexSize: e.p.indexBytes.length + 1 }), /Content-Length/)
  const redirected = staticEnvironment(pack(), { fetch: async () => ({ ok: true, redirected: true,
    body: new ReadableStream({ start(controller) { controller.close() } }), headers: new Headers() }) })
  await assert.rejects(redirected.admit(), { code: 'ERR_PERMISSION_DENIED' })
})

test('encoded wire Content-Length is bounded separately from the decoded pinned bytes', async () => {
  const p = pack()
  const e = staticEnvironment(p, { fetch: async (url, _init, fixture) => new Response(fixture.files.get(url), {
    headers: { 'content-encoding': 'gzip', 'content-length': '42' },
  }) })
  assert.equal((await e.admit({ indexSize: p.indexBytes.length })).provenance.indexSha256, p.indexSha256)
})

test('manifest root validation preserves UTF-8 key ordering and rejects a hash-valid inconsistent root', async () => {
  const e = staticEnvironment(pack({ metadata: { '\u{10000}': 'supplementary', '\ue000': 'bmp' } }))
  assert.equal((await e.admit()).provenance.integrityRoot, e.p.manifest.integrity.root)
  const p = pack(), manifest = { ...p.manifest, protocolVersion: '9.0' }, value = bytes(manifest)
  p.index.manifestSha256 = sha256(value); p.index.manifestSize = value.length
  p.indexBytes = bytes(p.index); p.indexSha256 = sha256(p.indexBytes)
  p.files.set(p.indexUrl, p.indexBytes); p.files.set(new URL('manifest.json', BASE).href, value)
  await assert.rejects(staticEnvironment(p).admit(), /integrity root SHA-256 mismatch/)
})

test('bounded streams stop on actual bytes and release their reader on abort and failures', async () => {
  let cancelled = 0, released = 0
  const controller = new AbortController()
  const e = staticEnvironment(pack(), { fetch: async () => ({ ok: true, headers: new Headers(), body: {
    getReader() { return { async read() { controller.abort('closed'); return { done: false, value: new Uint8Array([1]) } },
      async cancel() { cancelled++ }, releaseLock() { released++ } } },
  } }) })
  await assert.rejects(e.admit({ signal: controller.signal }), { code: 'ERR_CANCELLED' })
  assert.equal(cancelled, 1); assert.equal(released, 1)
  const oversize = staticEnvironment(pack(), { fetch: async () => ({ ok: true, headers: new Headers(), body: {
    getReader() { return { async read() { return { done: false, value: new Uint8Array(WORKER_ADMISSION_LIMITS.indexBytes + 1) } },
      async cancel() { cancelled++ }, releaseLock() { released++ } } },
  } }) })
  await assert.rejects(oversize.admit(), /byte budget/)
  assert.equal(cancelled, 2); assert.equal(released, 2)
})

const owner = Object.freeze({ workerEpoch: 'loader-epoch', sessionId: 'loader-session',
  packSha256: 'a'.repeat(64), transportBackend: 'external-frame' })
const loadResult = Object.freeze({ transportBackend: 'external-frame', pack: { indexSha256: owner.packSha256 },
  state: { sessionId: owner.sessionId, transportBackend: 'external-frame' },
  externalPresentation: { version: '1.0', consumedInput: '1.0', ackOutcome: '1.0', physicalTarget: '1.0' } })
function rendererConfig() {
  const resource = key => ({ ...WORKER_RENDERER_PINS[key], url: `/vendor/${key}` })
  return { schemaVersion: 1, renderer: 'canvaskit', fallback: 'error',
    canvaskit: { version: '0.42.0', variant: 'full', javascript: resource('javascript'), wasm: resource('wasm'),
      license: resource('license'), package: resource('package') }, font: { binary: resource('font'), license: resource('fontLicense') } }
}
// Exact lengths are realistic; the SHA provider below is explicitly fake.
// These zero-filled fixtures are never executed as real drawing code/WASM.
let fakeRendererBytes
function fakeResources() {
  if (!fakeRendererBytes) {
    fakeRendererBytes = new Map(Object.entries(WORKER_RENDERER_PINS).map(([key, pin]) => [key, new Uint8Array(pin.size)]))
    fakeRendererBytes.get('package').fill(32)
    fakeRendererBytes.get('package').set(bytes({ name: 'canvaskit-wasm', version: '0.42.0' }))
  }
  return fakeRendererBytes
}
function rendererEnvironment(hooks = {}) {
  const activity = { fetched: [], imports: 0, initializes: 0, created: [], revoked: [], module: { drawingModule: 'finite fake only', Typeface: { MakeTypefaceFromData: () => ({ delete() {} }) } } }
  const loader = createWorkerAdmissionLoader({ baseUrl: BASE,
    sha256: async value => hooks.sha256?.(value) ?? Object.values(WORKER_RENDERER_PINS).find(pin => pin.size === value.length)?.sha256 ?? sha256(value),
    fetch: async (url, init) => {
      activity.fetched.push({ url, init })
      const key = new URL(url).pathname.split('/').at(-1), value = fakeResources().get(key)
      assert.ok(value, `unexpected renderer resource: ${url}`)
      return hooks.fetch?.(url, init, key, value) ?? new Response(value, { headers: { 'content-length': String(value.length) } })
    },
    makeBlob: (parts, options) => ({ parts, type: options.type }),
    createObjectURL: value => { const url = `blob:loader-fake/${activity.created.length + 1}`; activity.created.push({ url, value }); return url },
    revokeObjectURL: url => { activity.revoked.push(url); hooks.revoke?.(url) },
    importModule: async url => {
      activity.imports++; assert.equal(activity.created[0].url, url)
      if (hooks.importModule) return hooks.importModule(url, activity)
      return { default: async options => {
        activity.initializes++
        assert.equal(options.locateFile('canvaskit.wasm'), activity.created[1].url)
        assert.throws(() => options.locateFile('unverified-extra.wasm'), { code: 'ERR_RENDER' })
        return activity.module
      } }
    },
  })
  const load = options => loader.loadPinnedCanvasKit({ owner, loadResult, rendererAssets: rendererConfig(), ...options })
  return { loader, load, activity }
}

test('renderer admission binds the loaded Worker and rejects pin/version changes before import or fetch', async () => {
  const e = rendererEnvironment()
  await assert.rejects(e.load({ owner: { ...owner, packSha256: 'b'.repeat(64) } }), { code: 'ERR_PROTOCOL_VERSION' })
  await assert.rejects(e.load({ loadResult: { ...loadResult, transportBackend: 'browser-view' } }), { code: 'ERR_PROTOCOL_VERSION' })
  await assert.rejects(e.load({ loadResult: { ...loadResult, state: { ...loadResult.state, sessionId: 'other-session' } } }), { code: 'ERR_PROTOCOL_VERSION' })
  for (const mutate of [config => { config.canvaskit.version = '0.43.0' }, config => { config.font.binary.sha256 = 'b'.repeat(64) },
    config => { config.canvaskit.wasm.size++ }, config => { config.font.license.url = '/api/fonts' }]) {
    const rendererAssets = rendererConfig(); mutate(rendererAssets)
    await assert.rejects(e.load({ rendererAssets }))
  }
  assert.equal(e.activity.fetched.length, 0); assert.equal(e.activity.imports, 0)
})

test('all six pinned resources verify before drawing import and reusable leases own independent font data', async () => {
  const e = rendererEnvironment()
  const first = await e.load(), second = await e.load()
  try {
    assert.equal(e.activity.fetched.length, 6); assert.equal(e.activity.imports, 1); assert.equal(e.activity.initializes, 1)
    assert.equal(first.CanvasKit, second.CanvasKit); assert.equal(first.CanvasKit, e.activity.module)
    assert.ok(first.fontData instanceof ArrayBuffer); assert.equal(first.fontData.byteLength, WORKER_RENDERER_PINS.font.size)
    assert.notEqual(first.fontData, second.fontData)
    new Uint8Array(first.fontData)[0] = 73
    assert.equal(new Uint8Array(second.fontData)[0], 0)
    assert.deepEqual(e.activity.revoked, e.activity.created.map(item => item.url))
    assert.equal(first.provenance.version, '0.42.0')
    assert.equal(first.provenance.fontCommit, 'a85815a42757630ce188fdad368c2dfc444d4773')
    const disposed = first.dispose(); assert.equal(first.dispose(), disposed); await disposed
    assert.throws(() => first.fontData, { code: 'ERR_CANCELLED' })
    assert.equal(second.CanvasKit, e.activity.module)
  } finally { await first.dispose(); await second.dispose() }
})

test('presenter reads only the verified shared font, rehashes cached bytes and never caches other renderer resources', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches'), entries = new Map(), writes = []
  const cache = { match: async key => entries.get(key)?.clone(), put: async (key, response) => { writes.push(key); entries.set(key, response.clone()) }, delete: async key => entries.delete(key) }
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: async name => { assert.equal(name, 'weapp-container-showcase-font-v1'); return cache } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'caches', previous); else delete globalThis.caches })
  const key = new URL('/vendor/font', BASE).href
  entries.set(key, new Response(fakeResources().get('font')))
  const first = rendererEnvironment(), lease = await first.load(); await lease.dispose()
  assert.equal(first.activity.fetched.length, 5)
  assert.equal(first.activity.fetched.some(entry => entry.url === key), false)
  assert.deepEqual(writes, [], 'other renderer resources do not enter the font cache')
  const poisoned = new Uint8Array(fakeResources().get('font')); poisoned[0] = 1; entries.set(key, new Response(poisoned))
  const bad = rendererEnvironment({ sha256: value => value.length === WORKER_RENDERER_PINS.font.size && value[0] === 1 ? '0'.repeat(64) : undefined })
  await assert.rejects(bad.load(), /renderer font SHA-256 mismatch/)
  assert.equal(bad.activity.imports, 0); assert.equal(entries.has(key), false)
  const next = rendererEnvironment(), fresh = await next.load(); await fresh.dispose()
  assert.deepEqual(writes, [key]); assert.equal(next.activity.fetched.length, 6)
})

test('renderer stream/hash failures do not execute code and release the source', async () => {
  let cancellation = 0, released = 0
  const e = rendererEnvironment({ fetch: (_url, _init, key, value) => key !== 'javascript' ? undefined : {
    ok: true, headers: new Headers(), body: { getReader() { return {
      async read() { return { done: false, value: new Uint8Array(value.length + 1) } },
      async cancel() { cancellation++ }, releaseLock() { released++ },
    } } },
  } })
  await assert.rejects(e.load(), /byte budget/)
  assert.equal(cancellation, 1); assert.equal(released, 1); assert.equal(e.activity.imports, 0)
  const corrupt = rendererEnvironment({ sha256: value => value.length === WORKER_RENDERER_PINS.wasm.size ? 'b'.repeat(64) : undefined })
  await assert.rejects(corrupt.load(), /SHA-256 mismatch/)
  assert.equal(corrupt.activity.imports, 0); assert.equal(corrupt.activity.created.length, 0)
})

test('abort during actual import waits for last use then revokes both URLs without initializing AppService or drawing', async () => {
  const imported = deferred(), started = deferred(), controller = new AbortController()
  const e = rendererEnvironment({ importModule: () => { started.resolve(); return imported.promise } })
  let settled = false
  const loading = outcome(e.load({ signal: controller.signal })).then(value => { settled = true; return value })
  await started.promise; controller.abort('owner closed'); await delay(5)
  assert.equal(settled, false); assert.equal(e.activity.revoked.length, 0)
  let initialized = 0
  imported.resolve({ default: async () => { initialized++; return e.activity.module } })
  assert.equal((await loading).error.code, 'ERR_CANCELLED')
  assert.equal(initialized, 0); assert.deepEqual(e.activity.revoked, e.activity.created.map(item => item.url))
})

test('one aborted renderer waiter cannot cancel another owner and both wait for real initialization', async () => {
  const started = deferred(), initialized = deferred(), controller = new AbortController()
  const e = rendererEnvironment({ importModule: async () => ({ default: () => { started.resolve(); return initialized.promise } }) })
  const cancelledLease = outcome(e.load({ signal: controller.signal })), liveLease = e.load()
  await started.promise; controller.abort('first owner closed'); await delay(5)
  assert.equal(e.activity.revoked.length, 0)
  initialized.resolve(e.activity.module)
  assert.equal((await cancelledLease).error.code, 'ERR_CANCELLED')
  const lease = await liveLease
  assert.equal(lease.CanvasKit, e.activity.module); assert.equal(e.activity.imports, 1)
  await lease.dispose()
})

test('failed drawing import cleans each URL exactly once and a cleanup failure remains observable', async () => {
  const e = rendererEnvironment({ importModule: async () => { throw Object.assign(new Error('drawing import failed'), { code: 'ERR_RENDER' }) },
    revoke: url => { if (url.endsWith('/1')) throw new Error('URL revoke failed') } })
  await assert.rejects(e.load(), error => error.code === 'ERR_RENDER' && error.message === 'drawing import failed'
    && error.details.cleanupErrors.some(value => value.includes('URL revoke failed')))
  assert.deepEqual(e.activity.revoked, e.activity.created.map(item => item.url))
})
