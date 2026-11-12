import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after } from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sources = join(repository, 'examples/hosts/harmony/entry/src/main/ets/session')
const rawfiles = join(repository, 'examples/hosts/harmony/entry/src/main/resources/rawfile')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))

// Execute the production, platform-independent owner. Only its native/resource
// dependencies are instrumented; no session logic is copied into this harness.
// Native stripping needs no installed npm dependencies. Preserve production JS;
// the only module rewrite resolves its sibling import in our temporary folder.
const scratch = await mkdtemp(join(tmpdir(), 'weapp-harmony-owner-'))
let PortablePack, HarmonyLiveSession, unixEpochNanoseconds, HarmonyHostServices, HarmonyHostAccountManager
try {
  for (const name of ['PortablePack', 'LiveSession', 'HostServices', 'HostAccountManager']) {
    const filename = join(sources, `${name}.ts`)
    let compiled = stripTypeScriptTypes(readFileSync(filename, 'utf8'), { mode: 'strip' })
    if (name === 'LiveSession') {
      const sibling = "from './PortablePack'"
      assert.equal(compiled.split(sibling).length - 1, 1, 'production owner must retain its one known sibling import')
      compiled = compiled.replace(sibling, "from './PortablePack.mjs'")
    }
    await writeFile(join(scratch, `${name}.mjs`), compiled)
  }
  ;({ PortablePack } = await import(pathToFileURL(join(scratch, 'PortablePack.mjs')).href))
  ;({ HarmonyLiveSession, unixEpochNanoseconds } = await import(pathToFileURL(join(scratch, 'LiveSession.mjs')).href))
  ;({ HarmonyHostServices } = await import(pathToFileURL(join(scratch, 'HostServices.mjs')).href))
  ;({ HarmonyHostAccountManager } = await import(pathToFileURL(join(scratch, 'HostAccountManager.mjs')).href))
} catch (error) {
  await rm(scratch, { recursive: true, force: true })
  throw error
}
after(async () => { await rm(scratch, { recursive: true, force: true }) })

function bundledFiles() {
  const manifestBytes = readFileSync(join(rawfiles, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const files = new Map([['manifest.json', manifestBytes]])
  const put = pointer => {
    const digest = pointer.replace(/^sha256:/, '')
    const path = `blobs/sha256/${digest}`
    files.set(path, readFileSync(join(rawfiles, path)))
  }
  for (const module of manifest.modules) put(module.sha256)
  for (const template of manifest.templates) put(template.wxmlAst)
  for (const style of manifest.styles) put(style.wxssIr)
  for (const asset of manifest.assets ?? []) put(asset.sha256)
  return files
}

function loadPack(files = bundledFiles(), reads = []) {
  return PortablePack.load(path => {
    reads.push(path)
    const bytes = files.get(path)
    if (bytes === undefined) throw new Error(`unreadable rawfile: ${path}`)
    return new Uint8Array(bytes)
  }, bytes => Buffer.from(bytes).toString('utf8'), sha256)
}

function failure(message = 'injected native failure') {
  return JSON.stringify({ ok: false, error: { code: 'ERR_ENGINE', message } })
}

function assertVerifiedResourceClosure(manifest, blobs) {
  assert.ok(blobs && !Array.isArray(blobs) && typeof blobs === 'object',
    'manifest render requires a blobs object with content-addressed bytes')
  const pointers = [...manifest.modules.map(value => value.sha256), ...manifest.templates.map(value => value.wxmlAst),
    ...manifest.styles.map(value => value.wxssIr), ...(manifest.assets ?? []).map(value => value.sha256),
    ...(manifest.viewScripts ?? []).map(value => value.sha256),
    ...(manifest.viewCompilation?.modules ?? []).flatMap(value => [value.sourceSha256, value.executableSha256]),
    ...(manifest.viewCompilation?.documents ?? []).flatMap(value => [value.wxmlAst, ...value.expressions.map(item => item.executableSha256)])]
  for (const pointer of pointers) assert.ok(Object.hasOwn(blobs, `sha256:${pointer.replace(/^sha256:/, '')}`), `missing manifest resource ${pointer}`)
  for (const [pointer, bytes] of Object.entries(blobs)) {
    assert.match(pointer, /^sha256:[a-f0-9]{64}$/)
    assert.ok(Array.isArray(bytes) && bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
    assert.equal(sha256(Uint8Array.from(bytes)), pointer.substring(7), 'every render resource must retain its verified bytes')
  }
}

function nativeBoundary(sessionId = 'harmony-contract-session') {
  const calls = []
  const state = {
    schemaVersion: 1,
    sessionId,
    viewport: { x: 0, y: 0, width: 375, height: 667 },
    page: null,
    frameId: null,
    viewRevision: null,
    renderRevision: 0,
  }
  let initialized = false
  let launched = false
  let timerMessages = false
  let injected = null
  let config = null
  let manifest = null
  let verifiedResources = null
  let afterCommit = null
  let afterPresentation = null
  let surfaceIdentity = null
  let nextSurfaceIdentity = 0
  let lostSurface = null
  let failDetachAfterRetirement = false
  const retiredSurfaces = []
  const observed = (op, payload) => {
    calls.push({ op, payload: payload === undefined ? null : clone(payload) })
    if (injected?.op === op) return injected.value
    return undefined
  }
  const batch = messages => JSON.stringify({ messages })
  const runtime = {
    loadManifestWithConfig(manifestJson, configJson) {
      manifest = JSON.parse(manifestJson)
      config = JSON.parse(configJson)
      const rejected = observed('manifest.load', { manifest, config })
      if (rejected !== undefined) return rejected
      return JSON.stringify({ ok: true, sessionId })
    },
    dispatch(serialized) {
      const envelope = JSON.parse(serialized)
      const rejected = observed(envelope.op, envelope)
      if (rejected !== undefined) return rejected
      assert.equal(envelope.sessionId, sessionId)
      assert.equal(envelope.protocolVersion, '1.0')
      assert.equal(envelope.kind, 'request')
      assert.equal(typeof envelope.requestId, 'string')
      let payload = { ok: true }
      switch (envelope.op) {
        case 'app.init':
          assert.equal(initialized, false)
          assert.ok(Array.isArray(envelope.payload.modules))
          assert.ok(envelope.payload.modules.length > 0)
          assertVerifiedResourceClosure(manifest, envelope.payload.blobs)
          verifiedResources = clone(envelope.payload.blobs)
          initialized = true
          payload = { ok: true, engineProviderAvailable: true, engine: config.engine,
            loadedModules: manifest.modules.length, manifest: { integrity: manifest.integrity.root } }
          break
        case 'app.lifecycle':
          assert.equal(initialized, true)
          if (envelope.payload.event === 'launch') {
            assert.equal(launched, false)
            launched = true
          }
          break
        case 'page.push':
          assert.equal(launched, true)
          state.page = { id: 7, route: envelope.payload.path, data: { message: 'AppService state', count: 0, timer: 0 }, dataRevision: 1 }
          state.viewRevision = 1
          payload = { ok: true, pageId: 7, path: envelope.payload.path }
          break
        case 'render.commit':
          assert.ok(state.page, 'render must follow page.push')
          assert.equal(Object.hasOwn(envelope.payload, 'data'), false, 'host must not override AppService page data')
          assertVerifiedResourceClosure(manifest, envelope.payload.blobs)
          assert.deepEqual(envelope.payload.blobs, verifiedResources, 'each render must carry the current pack resource closure')
          state.viewport = clone(envelope.payload.viewport)
          state.frameId = envelope.payload.frameId
          state.renderRevision += 1
          payload = { ok: true, committed: true, source: 'manifest', frameId: envelope.payload.frameId,
            templateId: envelope.payload.templateId, revision: state.viewRevision }
          if (afterCommit !== null) {
            const apply = afterCommit
            afterCommit = null
            apply(state)
          }
          break
        case 'event.batch':
          assert.ok(state.frameId, 'input must follow a committed hit tree')
          for (const event of envelope.payload.events) if (event.type === 'tap') {
            state.page.data.count += 1
            state.page.dataRevision += 1
            state.viewRevision += 1
          }
          break
        default:
          assert.fail(`unexpected native operation ${envelope.op}`)
      }
      return batch([{ ...envelope, kind: 'response', payload }])
    },
    inspectState() {
      const rejected = observed('host.inspect')
      return rejected === undefined ? JSON.stringify(state) : rejected
    },
    acknowledgePresentation(revision) {
      const rejected = observed('host.presentation', { revision, gpuCompletion: 'not-waited' })
      if (rejected !== undefined) return rejected
      assert.equal(revision, String(state.renderRevision))
      if (afterPresentation !== null) {
        const apply = afterPresentation
        afterPresentation = null
        apply(state)
      }
      return batch([])
    },
    pollTimers(nowNs) {
      const rejected = observed('host.pollTimers', { nowNs })
      if (rejected !== undefined) return rejected
      if (!timerMessages) return batch([])
      timerMessages = false
      state.page.data.timer += 1
      state.page.dataRevision += 1
      state.viewRevision += 1
      return batch([{ protocolVersion: '1.0', sessionId, requestId: 'timer-native', kind: 'event', op: 'data.patch.batch', payload: {} }])
    },
    resizeViewport(width, height) {
      const rejected = observed('host.resize', { width, height })
      if (rejected !== undefined) return rejected
      state.viewport = { x: 0, y: 0, width, height }
      return batch([])
    },
    attachSurface(surfaceId, width, height) {
      const rejected = observed('surface.attach', { surfaceId, width, height })
      if (rejected !== undefined) return rejected
      assert.equal(surfaceIdentity, null, 'an attached native identity must be retired before replacement')
      surfaceIdentity = ++nextSurfaceIdentity
      return JSON.stringify({ ok: true, renderer: 'skia-gpu-gles' })
    },
    renderSurface(width, height) {
      const rejected = observed('surface.render', { width, height })
      if (lostSurface?.identity === surfaceIdentity) return JSON.stringify({ ok: false, error: 'ERR_RENDER', operation: lostSurface.operation, eglError: lostSurface.code })
      return rejected === undefined ? JSON.stringify({ ok: true, renderer: 'skia-gpu-gles', gpuSurface: true, frameId: state.frameId }) : rejected
    },
    detachSurface() {
      const rejected = observed('surface.detach')
      if (rejected !== undefined) return rejected
      if (surfaceIdentity !== null) retiredSurfaces.push(surfaceIdentity)
      surfaceIdentity = null
      if (failDetachAfterRetirement) {
        failDetachAfterRetirement = false
        return JSON.stringify({ ok: false, error: 'ERR_RENDER', operation: 'eglTerminate' })
      }
      return JSON.stringify({ ok: true })
    },
    destroy() { observed('host.destroy') },
  }
  return { runtime, calls, state, fireTimer() { timerMessages = true },
    get surfaceIdentity() { return surfaceIdentity }, retiredSurfaces,
    loseSurface(operation, code) { lostSurface = { identity: surfaceIdentity, operation, code } },
    failNextDetachAfterRetirement() { failDetachAfterRetirement = true },
    afterNextCommit(operation) { afterCommit = operation },
    afterNextPresentation(operation) { afterPresentation = operation },
    inject(op, value = failure()) { injected = { op, value } }, clearFailure() { injected = null } }
}

function session(options = {}, pack = loadPack()) {
  const native = nativeBoundary(options.sessionId || 'harmony-contract-session')
  const receipts = []
  const owner = new HarmonyLiveSession(pack, native.runtime,
    { sessionId: native.state.sessionId, engine: 'quickjs', route: 'pages/index/index', width: 375, height: 667, ...options },
    receipt => receipts.push(clone(receipt)))
  return { owner, receipts, native }
}

const operations = native => native.calls.map(call => call.op)
const requests = (native, op) => native.calls.filter(call => call.op === op).map(call => call.payload)
const latest = receipts => receipts.at(-1)

function startAttached(fixture = session()) {
  fixture.owner.start()
  fixture.owner.attachSurface('contract-xcomponent', 750, 1334)
  assert.equal(fixture.owner.isRunnable(), true)
  return fixture
}

test('Harmony production pack eagerly reads and hashes the full bundled resource closure once', () => {
  const reads = []
  const files = bundledFiles()
  const pack = loadPack(files, reads)
  assert.equal(pack.firstRoute(), 'pages/index/index')
  assert.equal(pack.integrityRoot, JSON.parse(files.get('manifest.json')).integrity.root)
  assert.deepEqual([...reads].sort(), [...files.keys()].sort())
  assert.equal(new Set(reads).size, reads.length)
  for (const module of pack.modules()) {
    const declaration = pack.manifest.modules.find(value => value.id === module.id)
    assert.equal(sha256(Uint8Array.from(module.bytes)), declaration.sha256.replace(/^sha256:/, ''))
  }
})

test('Harmony production pack verifies optional View source and executable closure and asset sizes', () => {
  const files = bundledFiles()
  const manifest = JSON.parse(files.get('manifest.json'))
  const append = bytes => {
    const digest = sha256(bytes)
    files.set(`blobs/sha256/${digest}`, Buffer.from(bytes))
    return digest
  }
  const source = append('module.exports = { value: 1 };')
  const executable = append('instrumented compiled WXS')
  const expression = append('instrumented compiled expression')
  const image = append('image bytes')
  manifest.viewScripts = [{ id: 'wxs:helper.wxs', sha256: source }]
  manifest.viewCompilation = { modules: [{ sourceSha256: source, executableSha256: executable }],
    documents: [{ wxmlAst: manifest.templates[0].wxmlAst, expressions: [{ executableSha256: expression }] }] }
  manifest.assets = [{ path: 'fixture.png', sha256: image, size: Buffer.byteLength('image bytes') }]
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const reads = []
  const pack = loadPack(files, reads)
  assert.deepEqual([...reads].sort(), [...files.keys()].sort())
  assert.equal(reads.filter(path => path.endsWith(source)).length, 1)
  assert.equal(pack.blobs[`sha256:${expression}`].length, Buffer.byteLength('instrumented compiled expression'))
  manifest.assets[0].size += 1
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  assert.throws(() => loadPack(files), /asset size mismatch/)
})

test('Harmony loads schema v3 renderer profiles and eagerly verifies the optional modern closure', () => {
  const files = bundledFiles()
  const manifest = JSON.parse(files.get('manifest.json'))
  manifest.schemaVersion = 3
  manifest.rendering = { version: '1.0', default: 'skia', pages: {} }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  assert.equal(loadPack(files).manifest.rendering.default, 'skia')
  const put = text => {
    const bytes = Buffer.from(text), digest = sha256(bytes)
    files.set(`blobs/sha256/${digest}`, bytes)
    return digest
  }
  const executable = put('compiled modern program'), map = put('modern source map'), source = put('export const value: number = 1')
  manifest.modernView = { compiler: 'weapp-container-modern-view', version: '1.0.0', abi: '1.0', target: 'es2022',
    units: [{ id: `modern:${'a'.repeat(64)}`, executableSha256: executable, sourceMapSha256: map,
      sources: [{ path: 'entry.view.ts', sha256: source }] }] }
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const pack = loadPack(files)
  for (const hash of [executable, map, source]) {
    assert.ok(pack.blobs[`sha256:${hash}`])
    const missing = new Map(files); missing.delete(`blobs/sha256/${hash}`)
    assert.throws(() => loadPack(missing), /unreadable rawfile/)
    const corrupt = new Map(files); corrupt.set(`blobs/sha256/${hash}`, Buffer.from('corrupt'))
    assert.throws(() => loadPack(corrupt), /SHA-256 mismatch/)
  }
  for (const rendering of [null, { version: '1.0', default: 'native', pages: {} },
    { version: '1.0', default: 'skia', pages: { missing: 'webview' } },
    { version: '1.0', default: 'skia', pages: {}, unknown: true }]) {
    manifest.rendering = rendering
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
    assert.throws(() => loadPack(files), /ERR_INVALID_MANIFEST/)
  }
})

for (const corruption of ['missing', 'mismatched bytes', 'invalid pointer']) {
  test(`Harmony rejects ${corruption} before any native handle can be replaced`, () => {
    const files = bundledFiles()
    const manifest = JSON.parse(files.get('manifest.json'))
    const path = `blobs/sha256/${manifest.modules[0].sha256.replace(/^sha256:/, '')}`
    if (corruption === 'missing') files.delete(path)
    else if (corruption === 'mismatched bytes') files.set(path, Buffer.from('corrupt bytes'))
    else {
      manifest.modules[0].sha256 = 'sha256:../not-a-digest'
      files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
    }
    const native = nativeBoundary()
    assert.throws(() => new HarmonyLiveSession(loadPack(files), native.runtime,
      { sessionId: native.state.sessionId, engine: 'quickjs', width: 375, height: 667 }, () => {}),
    /unreadable rawfile|SHA-256 mismatch|invalid SHA-256 reference/)
    assert.deepEqual(native.calls, [])
  })
}

test('Harmony route style selection excludes unrelated pages and preserves component cascade order', () => {
  const files = bundledFiles()
  const manifest = JSON.parse(files.get('manifest.json'))
  const pointer = manifest.styles[0].wxssIr
  manifest.styles.splice(1, 0, { id: 'style:components/child.wxss', scope: 'component', wxssIr: pointer },
    { id: 'style:pages/other/index.wxss', scope: 'page', wxssIr: pointer })
  manifest.components = [{ owner: 'pages/index/index.json', usingComponents: { child: 'components/child' } },
    { owner: 'components/child.json', usingComponents: { cycle: 'components/child' } }]
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  assert.deepEqual(loadPack(files).styleIds('pages/index/index'),
    ['style:app.wxss', 'style:components/child.wxss', 'style:pages/index/index.wxss'])
  assert.throws(() => loadPack(files).requireRoute('pages/missing/index'), /undeclared route/)
  manifest.components[0].usingComponents.child = '../escape'
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  assert.throws(() => loadPack(files).styleIds('pages/index/index'), /normalized relative targets/)
})

for (const engine of ['quickjs', 'v8']) {
  test(`Harmony owner negotiates explicit ${engine} and starts in lifecycle order using native-inspected data`, () => {
    const { owner, receipts, native } = session({ engine })
    owner.start()
    assert.deepEqual(operations(native).filter(op => op !== 'host.inspect').slice(0, 5),
      ['manifest.load', 'app.init', 'app.lifecycle', 'page.push', 'render.commit'])
    const config = requests(native, 'manifest.load')[0].config
    assert.equal(config.engine, engine)
    assert.equal(config.page_render_mode, 'native-gpu')
    assert.equal(config.session_id, native.state.sessionId)
    assert.equal(config.require_integrity, true)
    assert.deepEqual(config.host, { windowWidth: 375, windowHeight: 667 })
    assert.equal(requests(native, 'app.lifecycle')[0].payload.event, 'launch')
    assert.equal(requests(native, 'render.commit')[0].payload.templateId, 'template:pages/index/index.wxml')
    assert.equal(Object.hasOwn(requests(native, 'render.commit')[0].payload, 'data'), false)
    assert.deepEqual(latest(receipts).inspection.page.data, native.state.page.data)
    assert.equal(latest(receipts).inspection.page.data.message, 'AppService state')
    assert.equal(latest(receipts).status, 'waiting-surface')
    assert.equal(owner.isRunnable(), false)
    assert.throws(() => owner.start(), /start only once/)
    owner.close()
    assert.equal(latest(receipts).status, 'closed')
    assert.equal(operations(native).at(-1), 'host.destroy')
  })
}

test('Harmony invalid replacement pack leaves the previous active owner and native page usable', () => {
  const { owner, receipts, native } = startAttached()
  const callsBeforeReplacement = native.calls.length
  const files = bundledFiles()
  files.set('manifest.json', Buffer.from('{invalid JSON'))
  assert.throws(() => new HarmonyLiveSession(loadPack(files), native.runtime,
    { sessionId: 'replacement', engine: 'quickjs', width: 375, height: 667 }, () => {}), SyntaxError)
  assert.equal(native.calls.length, callsBeforeReplacement)
  assert.equal(owner.isRunnable(), true)
  owner.pointer('down', 1, 10, 20, 1000)
  owner.pointer('up', 1, 10, 20, 1100)
  assert.equal(latest(receipts).inspection.page.data.count, 1)
  assert.equal(latest(receipts).sessionId, native.state.sessionId)
  assert.equal(requests(native, 'manifest.load').length, 1)
  owner.close()
})

test('Harmony input is one batch per OS sample with touchend and tap together, updating the same native page', () => {
  const { owner, receipts, native } = startAttached()
  const sessionId = latest(receipts).sessionId
  owner.pointer('down', 42, 12.5, 30, 1000)
  owner.pointer('up', 42, 13, 31, 1100)
  const batches = requests(native, 'event.batch')
  assert.deepEqual(batches.map(batch => batch.payload.events.map(event => event.type)), [['touchstart'], ['touchend', 'tap']])
  assert.deepEqual(batches[0].payload.events[0].touches,
    [{ identifier: 42, clientX: 12.5, clientY: 30, pageX: 12.5, pageY: 30 }])
  assert.deepEqual(batches[1].payload.events[0].touches, [])
  assert.deepEqual(batches[1].payload.events[1].detail, { x: 13, y: 31 })
  assert.equal(latest(receipts).inspection.page.data.count, 1)
  assert.equal(latest(receipts).sessionId, sessionId)
  assert.equal(latest(receipts).frameId, latest(receipts).inspection.frameId)
  assert.equal(latest(receipts).presentedFrameId, latest(receipts).frameId)
  assert.equal(requests(native, 'manifest.load').length, 1)
  assert.equal(requests(native, 'app.init').length, 1)
  assert.ok(requests(native, 'render.commit').slice(1).every(request =>
    Object.hasOwn(request.payload, 'blobs') && !Object.hasOwn(request.payload, 'reuseCommittedResources') && !Object.hasOwn(request.payload, 'data')))
  owner.close()
})

test('Harmony valid pack replacement keeps its verified resource closure on input, timers, lifecycle and resize renders', () => {
  const originalPack = loadPack()
  const previous = startAttached(session({ sessionId: 'before-pack-replacement' }, originalPack))
  previous.owner.close()

  const files = bundledFiles()
  const manifest = JSON.parse(files.get('manifest.json'))
  const oldPointer = manifest.styles[0].wxssIr
  const newStyle = Buffer.concat([files.get(`blobs/sha256/${oldPointer.substring(7)}`), Buffer.from('\n')])
  const newDigest = sha256(newStyle)
  files.set(`blobs/sha256/${newDigest}`, newStyle)
  manifest.styles[0].wxssIr = `sha256:${newDigest}`
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value)
  manifest.integrity.root = ''
  manifest.integrity.root = sha256(canonical(manifest))
  files.set('manifest.json', Buffer.from(canonical(manifest)))
  const pack = loadPack(files)
  assert.notEqual(pack.integrityRoot, originalPack.integrityRoot)
  assert.notDeepEqual(pack.blobs, originalPack.blobs)
  assert.equal(Object.hasOwn(pack.blobs, oldPointer), false, 'replacement must not retain undeclared old presentation resources')

  const f = startAttached(session({ sessionId: 'after-pack-replacement' }, pack))
  const verifyLatest = () => {
    assert.equal(f.owner.isRunnable(), true, JSON.stringify(latest(f.receipts).diagnostics))
    assert.deepEqual(latest(f.receipts).diagnostics, [])
    assert.deepEqual(requests(f.native, 'render.commit').at(-1).payload.blobs, pack.blobs)
    assert.equal(latest(f.receipts).sessionId, 'after-pack-replacement')
    assert.equal(latest(f.receipts).manifestIntegrity, pack.integrityRoot)
  }
  try {
    verifyLatest()
    let renderCount = requests(f.native, 'render.commit').length
    f.owner.pointer('down', 3, 10, 20, 1000); verifyLatest()
    f.owner.pointer('up', 3, 10, 20, 1100); verifyLatest()
    assert.equal(requests(f.native, 'render.commit').length, renderCount + 2)
    assert.equal(latest(f.receipts).inspection.page.data.count, 1)
    renderCount += 2
    f.native.fireTimer(); f.owner.pollTimers(1792567890123); verifyLatest()
    assert.equal(requests(f.native, 'render.commit').length, renderCount + 1)
    assert.equal(latest(f.receipts).inspection.page.data.timer, 1)
    renderCount += 1
    f.owner.setForeground(false)
    assert.equal(requests(f.native, 'render.commit').length, renderCount, 'background does not render')
    f.owner.setForeground(true); verifyLatest()
    assert.equal(requests(f.native, 'render.commit').length, renderCount + 1)
    renderCount += 1
    f.owner.resize(667, 375, 1334, 750); verifyLatest()
    assert.equal(requests(f.native, 'render.commit').length, renderCount + 1)
    assert.deepEqual(requests(f.native, 'app.lifecycle').map(value => value.payload.event), ['launch', 'hide', 'show'])
    assert.equal(requests(f.native, 'manifest.load').length, 1)
    assert.equal(requests(previous.native, 'host.destroy').length, 1)
  } finally { f.owner.close() }
})

test('Harmony subsequent renders follow the active route from native inspection and its page styles', () => {
  const files = bundledFiles()
  const manifest = JSON.parse(files.get('manifest.json'))
  manifest.routes.push({ path: 'pages/next/index', config: 'pages/next/index.json' })
  manifest.templates.push({ ...manifest.templates[0], id: 'template:pages/next/index.wxml' })
  manifest.styles.push({ ...manifest.styles[1], id: 'style:pages/next/index.wxss' })
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const { owner, receipts, native } = startAttached(session({}, loadPack(files)))
  native.state.page.route = 'pages/next/index'
  native.state.page.data = { message: 'next page from AppService', count: 0, timer: 0 }
  owner.pointer('down', 1, 10, 20, 1000)
  const render = requests(native, 'render.commit').at(-1).payload
  assert.equal(render.templateId, 'template:pages/next/index.wxml')
  assert.deepEqual(render.styleIds, ['style:app.wxss', 'style:pages/next/index.wxss'])
  assert.equal(latest(receipts).route, 'pages/next/index')
  assert.equal(latest(receipts).inspection.page.data.message, 'next page from AppService')
  owner.close()
})

for (const gesture of ['moved', 'long', 'backwards time', 'second pointer', 'cancel']) {
  test(`Harmony ${gesture} gesture cannot create a synthetic tap`, () => {
    const { owner, native } = startAttached()
    owner.pointer('down', 1, 10, 10, 1000)
    if (gesture === 'moved') owner.pointer('move', 1, 40, 40, 1050)
    if (gesture === 'second pointer') owner.pointer('down', 2, 20, 20, 1050)
    if (gesture === 'cancel') owner.pointer('cancel', 1, 10, 10, 1050)
    owner.pointer('up', 1, 10, 10, gesture === 'long' ? 1501 : gesture === 'backwards time' ? 999 : 1100)
    const types = requests(native, 'event.batch').flatMap(batch => batch.payload.events.map(event => event.type))
    assert.equal(types.includes('tap'), false)
    if (gesture === 'second pointer' || gesture === 'cancel') assert.equal(types.includes('touchcancel'), true)
    assert.equal(native.state.page.data.count, 0)
    owner.close()
  })
}

test('Harmony epoch nanoseconds preserve integer precision and reject unsafe, negative or overflowing clocks', () => {
  assert.equal(unixEpochNanoseconds(0), '0')
  assert.equal(unixEpochNanoseconds(1792567890123), '1792567890123000000')
  assert.equal(unixEpochNanoseconds(18446744073709), '18446744073709000000')
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 18446744073710]) {
    assert.throws(() => unixEpochNanoseconds(value), /Unix epoch/)
  }
})

test('Harmony foreground timers use the same owner, empty polls are silent and background work pauses', () => {
  const { owner, receipts, native } = startAttached()
  const before = receipts.length
  owner.pollTimers(1792567890123)
  assert.equal(receipts.length, before)
  assert.equal(requests(native, 'host.pollTimers')[0].nowNs, '1792567890123000000')
  native.fireTimer()
  owner.pollTimers(1792567890124)
  assert.equal(latest(receipts).inspection.page.data.timer, 1)
  owner.pointer('down', 1, 1, 1, 1000)
  owner.setForeground(false)
  const hiddenCalls = native.calls.length
  owner.setForeground(false)
  owner.pollTimers(1792567890125)
  owner.pointer('up', 1, 1, 1, 1100)
  assert.equal(native.calls.length, hiddenCalls)
  assert.equal(owner.isRunnable(), false)
  assert.equal(latest(receipts).status, 'suspended')
  owner.setForeground(true)
  assert.equal(owner.isRunnable(), true)
  assert.deepEqual(requests(native, 'app.lifecycle').map(request => request.payload.event), ['launch', 'hide', 'show'])
  assert.equal(requests(native, 'app.init').length, 1)
  assert.equal(requests(native, 'page.push').length, 1)
  assert.equal(latest(receipts).inspection.page.data.timer, 1)
  assert.equal(latest(receipts).inspection.page.data.count, 0)
  owner.close()
})

test('Harmony an empty timer batch still redraws post-commit onReady data using the acknowledged render revision', () => {
  const f = session()
  f.native.afterNextCommit(state => {
    state.page.data.message = 'onReady setData after frame capture'
    state.viewRevision += 1
  })
  startAttached(f)
  assert.equal(requests(f.native, 'render.commit').length, 1)
  assert.equal(latest(f.receipts).inspection.page.data.message, 'onReady setData after frame capture')
  f.owner.pollTimers(1792567890123)
  assert.equal(requests(f.native, 'render.commit').length, 2,
    'inspection revision after commit cannot be accepted as the already rendered baseline')
  assert.equal(latest(f.receipts).presentedFrameId, 2)
  const receiptCount = f.receipts.length
  f.owner.pollTimers(1792567890124)
  assert.equal(requests(f.native, 'render.commit').length, 2)
  assert.equal(f.receipts.length, receiptCount)
  f.owner.close()
})

test('Harmony empty timer batches observe component-only view changes and active page replacement', () => {
  const { owner, receipts, native } = startAttached()
  native.state.viewRevision += 1 // A component observer changed View without a page data patch message.
  owner.pollTimers(1792567890123)
  assert.equal(requests(native, 'render.commit').length, 2)
  assert.equal(latest(receipts).presentedFrameId, 2)
  native.state.page.id = 11 // Replacing a page may preserve its route and current numeric revision.
  owner.pollTimers(1792567890124)
  assert.equal(requests(native, 'render.commit').length, 3)
  assert.equal(latest(receipts).inspection.page.id, 11)
  assert.equal(requests(native, 'app.init').length, 1)
  owner.close()
})

test('Harmony readiness follows surface submission and its data effects are rendered by the next pump', () => {
  const { owner, receipts, native } = session()
  owner.start()
  assert.equal(requests(native, 'host.presentation').length, 0)
  native.afterNextPresentation(state => { state.viewRevision += 1; state.page.data.ready = true })
  owner.attachSurface('contract-xcomponent', 750, 1334)
  assert.deepEqual(operations(native).filter(op => op !== 'host.inspect').slice(-3),
    ['surface.attach', 'surface.render', 'host.presentation'])
  const renders = requests(native, 'render.commit').length
  owner.pollTimers(1000)
  assert.equal(requests(native, 'render.commit').length, renders + 1)
  assert.equal(latest(receipts).inspection.page.data.ready, true)
  owner.pollTimers(1001)
  assert.equal(requests(native, 'render.commit').length, renders + 1)
  native.inject('host.presentation')
  owner.resize(667, 375, 1334, 750)
  assert.equal(latest(receipts).status, 'suspended')
  assert.ok(latest(receipts).diagnostics.length > 0)
  owner.close()
})

test('Harmony resize cancels the old gesture, updates native logical viewport before render and presents physical pixels', () => {
  const { owner, receipts, native } = startAttached()
  owner.pointer('down', 1, 10, 20, 1000)
  const prior = native.calls.length
  owner.resize(667, 375, 1334, 750)
  assert.deepEqual(operations(native).slice(prior).filter(op => op !== 'host.inspect'),
    ['event.batch', 'host.resize', 'render.commit', 'surface.render', 'host.presentation'])
  assert.deepEqual(requests(native, 'host.resize').at(-1), { width: 667, height: 375 })
  assert.deepEqual(requests(native, 'surface.render').at(-1), { width: 1334, height: 750 })
  assert.deepEqual(latest(receipts).viewport, { x: 0, y: 0, width: 667, height: 375 })
  assert.equal(latest(receipts).surfaceWidth, 1334)
  assert.equal(latest(receipts).sessionId, native.state.sessionId)
  const unchanged = native.calls.length
  owner.resize(667, 375, 1334, 750)
  assert.equal(native.calls.length, unchanged)
  owner.resize(667, 375, 2001, 1125)
  assert.equal(requests(native, 'host.resize').length, 1)
  assert.deepEqual(requests(native, 'surface.render').at(-1), { width: 2001, height: 1125 })
  owner.close()
})

test('Harmony surface loss pauses input while business timers and the same JS session remain active', () => {
  const { owner, receipts, native } = startAttached()
  owner.detachSurface()
  assert.equal(owner.isRunnable(), false)
  assert.equal(latest(receipts).presentedFrameId, 0)
  const prior = native.calls.length
  owner.pointer('down', 1, 2, 3, 1000)
  assert.equal(native.calls.length, prior)
  native.fireTimer()
  owner.pollTimers(1792567890123)
  assert.equal(requests(native, 'host.pollTimers').length, 1)
  assert.equal(native.state.page.data.timer, 1)
  assert.equal(latest(receipts).presentedFrameId, 0)
  owner.attachSurface('replacement-xcomponent', 750, 1334)
  assert.equal(owner.isRunnable(), true)
  assert.equal(requests(native, 'app.init').length, 1)
  assert.equal(latest(receipts).inspection.page.data.message, 'AppService state')
  owner.close()
  owner.close()
  assert.equal(requests(native, 'host.destroy').length, 1)
  assert.equal(requests(native, 'surface.detach').length, 2)
  const closed = native.calls.length
  owner.pollTimers(1792567890124)
  owner.pointer('down', 1, 2, 3, 2000)
  owner.attachSurface('late-surface', 750, 1334)
  assert.equal(native.calls.length, closed)
})

for (const transient of ['surface.attach', 'surface.render']) {
  test(`Harmony retries explicit ${transient} geometry-not-ready while timers advance and input stays paused`, () => {
    const { owner, receipts, native } = session()
    owner.start()
    native.inject(transient, JSON.stringify({ ok: false, operation: 'surface-size-not-ready' }))
    owner.attachSurface('pending-xcomponent', 750, 1334)
    assert.equal(owner.canPump(), true)
    assert.equal(owner.isRunnable(), false)
    assert.equal(latest(receipts).status, 'waiting-surface')
    assert.equal(latest(receipts).presentedFrameId, 0)
    const events = requests(native, 'event.batch').length
    owner.pointer('down', 1, 10, 20, 1000)
    native.fireTimer()
    owner.pollTimers(1792567890123)
    assert.equal(requests(native, 'event.batch').length, events)
    assert.equal(requests(native, 'host.pollTimers').length, 1)
    assert.deepEqual(latest(receipts).diagnostics, [])
    native.clearFailure()
    native.fireTimer()
    owner.pollTimers(1792567890124)
    assert.equal(owner.isRunnable(), true)
    assert.equal(latest(receipts).status, 'ready')
    assert.equal(requests(native, 'host.pollTimers').length, 2)
    assert.equal(requests(native, 'app.init').length, 1)
    assert.equal(latest(receipts).sessionId, native.state.sessionId)
    assert.equal(latest(receipts).inspection.page.data.count, 0)
    assert.equal(latest(receipts).inspection.page.data.timer, 2, 'continuous timer mutations cannot starve surface recovery')
    owner.close()
  })
}

test('Harmony drawable resize race blocks old-geometry input until the newly committed frame is presented', () => {
  const { owner, receipts, native } = startAttached()
  native.inject('surface.render', JSON.stringify({ ok: false, operation: 'surface-size-not-ready' }))
  owner.resize(667, 375, 1334, 750)
  const committed = latest(receipts).frameId
  assert.equal(latest(receipts).status, 'waiting-surface')
  assert.equal(latest(receipts).presentedFrameId, 0)
  const events = requests(native, 'event.batch').length
  owner.pointer('down', 1, 100, 100, 1000)
  owner.pollTimers(1792567890123)
  assert.equal(requests(native, 'event.batch').length, events)
  assert.equal(requests(native, 'host.pollTimers').length, 1)
  native.clearFailure()
  owner.pollTimers(1792567890124)
  assert.equal(owner.isRunnable(), true)
  assert.equal(latest(receipts).presentedFrameId, committed)
  assert.deepEqual(requests(native, 'surface.render').at(-1), { width: 1334, height: 750 })
  assert.equal(requests(native, 'render.commit').length, 2)
  assert.equal(requests(native, 'app.init').length, 1)
  owner.close()
})

for (const operation of ['surface.attach', 'surface.render', 'host.presentation']) {
  test(`Harmony ${operation} failure keeps timers/lifecycle alive and requires an explicit presentation retry`, () => {
    const { owner, native, receipts } = session()
    owner.start()
    native.inject(operation)
    owner.attachSurface('faulted-xcomponent', 750, 1334)
    assert.equal(owner.canPump(), true)
    assert.equal(owner.isRunnable(), false)
    assert.equal(latest(receipts).presentationSuspended, true)
    assert.equal(latest(receipts).runtimeFailed, false)
    const renderCount = requests(native, 'render.commit').length
    const surfaceCount = requests(native, 'surface.render').length
    const attachCount = requests(native, 'surface.attach').length
    for (let turn = 0; turn < 2; turn += 1) {
      native.fireTimer()
      owner.pollTimers(1792567890123 + turn)
    }
    assert.equal(native.state.page.data.timer, 2)
    assert.equal(requests(native, 'host.pollTimers').length, 2)
    assert.equal(requests(native, 'render.commit').length, renderCount)
    assert.equal(requests(native, 'surface.render').length, surfaceCount)
    assert.equal(requests(native, 'surface.attach').length, attachCount)
    owner.pointer('down', 1, 2, 3, 1000)
    assert.equal(requests(native, 'event.batch').length, 0)
    owner.setForeground(false)
    owner.pollTimers(1792567890125)
    owner.setForeground(true)
    assert.equal(requests(native, 'host.pollTimers').length, 2)
    assert.deepEqual(requests(native, 'app.lifecycle').map(request => request.payload.event), ['launch', 'hide', 'show'])
    native.clearFailure()
    owner.pollTimers(1792567890126)
    assert.equal(owner.isRunnable(), false, 'clearing the underlying fault must not implicitly retry')
    assert.equal(requests(native, 'render.commit').length, renderCount)
    owner.retryPresentation()
    assert.equal(owner.isRunnable(), true)
    assert.equal(latest(receipts).presentationSuspended, false)
    assert.equal(latest(receipts).inspection.page.data.timer, 2)
    assert.equal(requests(native, 'app.init').length, 1)
    assert.equal(requests(native, 'render.commit').length, renderCount + 1)
    owner.close()
    const before = native.calls.length
    owner.retryPresentation()
    owner.pollTimers(1792567890127)
    assert.equal(native.calls.length, before)
  })
}

for (const [operation, code] of [['eglMakeCurrent', 0x300E], ['eglSwapBuffers', 0x300D]]) {
  test(`Harmony explicit retry retires the native identity after ${operation} failure and keeps the timer clock`, () => {
    const { owner, native, receipts } = startAttached()
    const initialIdentity = native.surfaceIdentity
    native.loseSurface(operation, code)
    owner.resize(667, 375, 1334, 750)
    assert.equal(latest(receipts).presentationSuspended, true)
    const attempts = requests(native, 'surface.render').length
    native.fireTimer()
    owner.pollTimers(1792567890123)
    owner.pollTimers(1792567890124)
    assert.equal(native.state.page.data.timer, 1)
    assert.equal(native.surfaceIdentity, initialIdentity)
    assert.equal(requests(native, 'surface.render').length, attempts, 'timer polling cannot retry a lost context')
    assert.equal(requests(native, 'surface.detach').length, 0)
    const beforeRetry = native.calls.length
    owner.retryPresentation()
    assert.deepEqual(operations(native).slice(beforeRetry).filter(op => op !== 'host.inspect'),
      ['surface.detach', 'surface.attach', 'render.commit', 'surface.render', 'host.presentation'])
    assert.notEqual(native.surfaceIdentity, initialIdentity)
    assert.deepEqual(native.retiredSurfaces, [initialIdentity])
    assert.deepEqual(requests(native, 'surface.attach').at(-1), { surfaceId: 'contract-xcomponent', width: 1334, height: 750 })
    assert.equal(owner.isRunnable(), true)
    assert.equal(latest(receipts).inspection.page.data.timer, 1)
    assert.equal(requests(native, 'app.init').length, 1)
    owner.close()
    assert.equal(new Set(native.retiredSurfaces).size, 2)
  })
}

for (const partiallyRetired of [false, true]) {
  test(`Harmony explicit retry stops on ${partiallyRetired ? 'partial' : 'rejected'} native retirement and never destroys an identity twice`, () => {
    const { owner, native, receipts } = startAttached()
    const initialIdentity = native.surfaceIdentity
    native.loseSurface('eglSwapBuffers', 0x300E)
    owner.resize(667, 375, 1334, 750)
    if (partiallyRetired) native.failNextDetachAfterRetirement()
    else native.inject('surface.detach', JSON.stringify({ ok: false, error: 'ERR_ENGINE', operation: 'rust-context-abandon' }))
    const attachments = requests(native, 'surface.attach').length
    owner.retryPresentation()
    assert.equal(latest(receipts).presentationSuspended, true)
    assert.equal(owner.canPump(), true)
    assert.equal(owner.isRunnable(), false)
    assert.equal(requests(native, 'surface.attach').length, attachments)
    assert.equal(native.surfaceIdentity, partiallyRetired ? null : initialIdentity)
    native.fireTimer()
    owner.pollTimers(1792567890123)
    assert.equal(native.state.page.data.timer, 1)
    assert.equal(requests(native, 'surface.detach').length, 1, 'timer polling cannot retry failed retirement')
    native.clearFailure()
    owner.retryPresentation()
    assert.equal(owner.isRunnable(), true)
    assert.notEqual(native.surfaceIdentity, initialIdentity)
    assert.deepEqual(native.retiredSurfaces, [initialIdentity], 'partial success must not double-retire the old native identity')
    assert.equal(requests(native, 'app.init').length, 1)
    owner.close()
  })
}

for (const op of ['manifest.load', 'app.init', 'render.commit']) {
  test(`Harmony ${op} failure never presents a successful startup and owned resources can be released`, () => {
    const { owner, receipts, native } = session()
    native.inject(op)
    assert.throws(() => owner.start(), /ERR_ENGINE/)
    assert.equal(latest(receipts).status, 'suspended')
    assert.equal(latest(receipts).presentedFrameId, 0)
    assert.equal(requests(native, 'surface.render').length, 0)
    assert.throws(() => owner.start(), /start only once/)
    native.clearFailure()
    owner.close()
    assert.equal(requests(native, 'host.destroy').length, 1)
    assert.equal(latest(receipts).status, 'closed')
  })
}

test('Harmony runtime failure retains last presentation receipt and failed surface retirement blocks destruction until retry', () => {
  const { owner, receipts, native } = startAttached()
  const previous = latest(receipts)
  native.inject('event.batch')
  owner.pointer('down', 1, 20, 30, 1000)
  assert.equal(owner.isRunnable(), false)
  assert.equal(latest(receipts).status, 'suspended')
  assert.equal(latest(receipts).presentedFrameId, previous.presentedFrameId)
  assert.ok(latest(receipts).diagnostics.length > 0)
  const failed = native.calls.length
  owner.pollTimers(1792567890123)
  owner.pointer('up', 1, 20, 30, 1100)
  assert.equal(native.calls.length, failed)
  native.inject('surface.detach')
  owner.close()
  assert.equal(operations(native).at(-1), 'surface.detach')
  assert.equal(latest(receipts).status, 'closing');assert.equal(latest(receipts).cleanupComplete,false)
  assert.equal(requests(native,'host.destroy').length,0)
  assert.ok(latest(receipts).diagnostics.some(message => message.includes('surface.detach')))
  native.clearFailure();owner.close();assert.equal(requests(native,'host.destroy').length,1);assert.equal(latest(receipts).cleanupComplete,true)
})

test('Harmony hide transition is consumed and still reaches AppService when gesture cancellation fails', () => {
  const { owner, receipts, native } = startAttached()
  owner.pointer('down', 1, 10, 20, 1000)
  native.inject('event.batch')
  owner.setForeground(false)
  assert.equal(latest(receipts).foreground, false)
  assert.equal(latest(receipts).status, 'suspended')
  assert.equal(requests(native, 'app.lifecycle').at(-1).payload.event, 'hide')
  const hidden = native.calls.length
  owner.setForeground(false)
  owner.pollTimers(1792567890123)
  assert.equal(native.calls.length, hidden)
  owner.close()
})

test('Harmony surface detach runs when touchcancel fails and later close still destroys the native owner', () => {
  const { owner, receipts, native } = startAttached()
  owner.pointer('down', 1, 10, 20, 1000)
  native.inject('event.batch')
  owner.detachSurface()
  assert.equal(requests(native, 'surface.detach').length, 1)
  assert.equal(latest(receipts).presentedFrameId, 0)
  assert.equal(owner.canPump(), false)
  owner.close()
  assert.equal(requests(native, 'surface.detach').length, 1)
  assert.equal(requests(native, 'host.destroy').length, 1)
})

test('Harmony wrong-session inspection cannot be published as current frame evidence', () => {
  const { owner, receipts, native } = session()
  native.inject('host.inspect', JSON.stringify({ schemaVersion: 1, sessionId: 'foreign', frameId: 1, page: null }))
  assert.throws(() => owner.start(), /different session/)
  assert.equal(latest(receipts).status, 'suspended')
  assert.equal(latest(receipts).inspection, undefined)
  assert.equal(latest(receipts).presentedFrameId, 0)
  owner.close()
})

test('Harmony stale frame inspection suspends startup before any presentation', () => {
  const { owner, receipts, native } = session()
  native.inject('host.inspect', JSON.stringify({ schemaVersion: 1, sessionId: native.state.sessionId,
    frameId: 0, page: { id: 7, route: 'pages/index/index', data: {} } }))
  assert.throws(() => owner.start(), /inspection does not match the committed frame/)
  assert.equal(latest(receipts).status, 'suspended')
  assert.equal(latest(receipts).presentedFrameId, 0)
  owner.close()
})

test('Harmony shutdown consumes unload once and retains a throwing detach for actual cleanup retry', () => {
  const { owner, receipts, native } = startAttached()
  native.inject('app.lifecycle')
  const detach = native.runtime.detachSurface
  native.runtime.detachSurface = () => { detach(); throw new Error('native detach exception') }
  const prior = native.calls.length
  owner.close()
  assert.deepEqual(operations(native).slice(prior), ['app.lifecycle', 'surface.detach'])
  assert.equal(latest(receipts).status, 'closing')
  assert.equal(latest(receipts).presentedFrameId, 0)
  assert.ok(latest(receipts).diagnostics.some(message => message.includes('native detach exception')))
  native.runtime.detachSurface=detach;owner.close()
  assert.equal(requests(native, 'host.destroy').length, 1)
  assert.equal(requests(native,'app.lifecycle').filter(value=>value.payload.event==='unload').length,1)
})

test('Harmony receipt observer exceptions remain bounded and cannot suspend AppService or skip shutdown cleanup', () => {
  const native = nativeBoundary()
  const delivered = []
  let callbackCount = 0
  const owner = new HarmonyLiveSession(loadPack(), native.runtime,
    { sessionId: native.state.sessionId, engine: 'quickjs', width: 375, height: 667 }, receipt => {
      callbackCount += 1
      delivered.push(clone(receipt))
      if (receipt.status === 'closed') assert.equal(requests(native, 'host.destroy').length, 1)
      throw new Error(`observer failure ${callbackCount}`)
    })
  assert.doesNotThrow(() => owner.start())
  assert.equal(callbackCount, 1, 'a thrown observer must not recurse into another publish')
  assert.equal(latest(delivered).status, 'waiting-surface')
  assert.doesNotThrow(() => owner.attachSurface('observer-xcomponent', 750, 1334))
  assert.equal(callbackCount, 2)
  assert.equal(owner.isRunnable(), true)
  assert.ok(latest(delivered).diagnostics.includes('observer failure 1'))
  native.fireTimer()
  assert.doesNotThrow(() => owner.pollTimers(1792567890123))
  assert.equal(callbackCount, 3)
  assert.equal(owner.isRunnable(), true)
  assert.equal(latest(delivered).inspection.page.data.timer, 1)
  assert.ok(latest(delivered).diagnostics.includes('observer failure 2'))
  assert.doesNotThrow(() => owner.close())
  assert.equal(callbackCount, 4)
  assert.equal(latest(delivered).status, 'closed')
  assert.equal(requests(native, 'surface.detach').length, 1)
  assert.equal(requests(native, 'host.destroy').length, 1)
  assert.doesNotThrow(() => owner.close())
  assert.equal(callbackCount, 4)
})

test('Harmony malformed acknowledgements cannot pass startup through an engine fallback', () => {
  for (const mutate of [
    ack => { ack.payload.engine = 'v8' },
    ack => { ack.payload.engineProviderAvailable = false },
    ack => { ack.payload.loadedModules = 0 },
    ack => { ack.payload.manifest.integrity = 'bad-root' },
    ack => { ack.requestId = 'other-request' },
    ack => { ack.sessionId = 'foreign-session' },
  ]) {
    const { owner, receipts, native } = session()
    const init = { protocolVersion: '1.0', sessionId: native.state.sessionId, requestId: 'harmony-session-1',
      kind: 'response', op: 'app.init', payload: { ok: true, engineProviderAvailable: true, engine: 'quickjs',
        loadedModules: loadPack().manifest.modules.length, manifest: { integrity: loadPack().integrityRoot } } }
    mutate(init)
    native.inject('app.init', JSON.stringify({ messages: [init] }))
    assert.throws(() => owner.start(), /ERR_ENGINE/)
    assert.equal(latest(receipts).status, 'suspended')
    assert.equal(requests(native, 'page.push').length, 0)
    owner.close()
    assert.equal(requests(native, 'host.destroy').length, 1)
  }
})

test('Harmony close blocks input and releases its native storage owner only after real asynchronous cleanup',async()=>{
  const native=nativeBoundary(),pack=loadPack();let release,revoked=false
  const gate=new Promise(resolve=>release=resolve)
  const services={configure(){},revoke(){revoked=true},waitForDrain(){return gate},drain(){return []},setForeground(){}}
  const owner=new HarmonyLiveSession(pack,native.runtime,{sessionId:native.state.sessionId,engine:'quickjs',width:375,height:667,hostServices:services,hostIdentity:{application:{packRoot:pack.integrityRoot}}},()=>{})
  owner.start();owner.attachSurface('drain-surface',750,1334)
  const closing=owner.closeAndDrain();assert.equal(owner.closeAndDrain(),closing);assert.equal(revoked,true);assert.equal(owner.isRunnable(),false);assert.equal(requests(native,'surface.detach').length,1);assert.equal(requests(native,'host.destroy').length,0)
  release();await closing;assert.equal(requests(native,'host.destroy').length,1)
})
test('Harmony a failed native cleanup leaves the retired owner quarantined with its storage lease',async()=>{
  const native=nativeBoundary(),pack=loadPack()
  const services={configure(){},revoke(){},async waitForDrain(){throw new Error('native socket release failed')},drain(){return []},setForeground(){}}
  const owner=new HarmonyLiveSession(pack,native.runtime,{sessionId:native.state.sessionId,engine:'quickjs',width:375,height:667,hostServices:services,hostIdentity:{application:{packRoot:pack.integrityRoot}}},()=>{})
  owner.start();owner.attachSurface('failed-drain-surface',750,1334)
  await assert.rejects(owner.closeAndDrain(),/socket release failed/);assert.equal(owner.isRunnable(),false);assert.equal(requests(native,'host.destroy').length,0)
})

test('Harmony real host-service failures retry native releases before destroying the retained session owner',async()=>{
  const native=nativeBoundary(),pack=loadPack();let failed=true,attempts=0
  native.runtime.hostServices=json=>{const command=JSON.parse(json);if(command.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(command.operation==='configure')return JSON.stringify({ok:true,sessionId:native.state.sessionId});return '{"ok":true}'}
  const services=new HarmonyHostServices(native.runtime);services.onClose(async()=>{attempts++;if(failed)throw new Error('actual adapter failed release')})
  const identity={application:{hostAppId:'host',tenantId:'tenant',publisherId:'pub',appId:'app',environment:'release',version:'1',packRoot:pack.integrityRoot},account:{principalId:'alice',epoch:'1'}}
  const receipts=[],owner=new HarmonyLiveSession(pack,native.runtime,{sessionId:native.state.sessionId,engine:'quickjs',width:375,height:667,hostServices:services,hostIdentity:identity},receipt=>receipts.push(receipt));owner.start();owner.attachSurface('retry',750,1334)
  await assert.rejects(owner.closeAndDrain(),/failed to stop/);assert.equal(attempts,1);assert.equal(requests(native,'host.destroy').length,0);assert.equal(latest(receipts).cleanupComplete,false)
  failed=false;await owner.closeAndDrain();assert.equal(attempts,2);assert.equal(requests(native,'host.destroy').length,1);assert.equal(latest(receipts).cleanupComplete,true);await owner.closeAndDrain();assert.equal(attempts,2)
})

test('Harmony async close retains rejected GPU detach and destroy calls for retry without replaying unload',async()=>{
  const f=startAttached();f.native.inject('surface.detach');await assert.rejects(f.owner.closeAndDrain(),/surface.detach/);assert.equal(requests(f.native,'host.destroy').length,0)
  f.native.clearFailure();let throws=true,attempts=0;const destroy=f.native.runtime.destroy;f.native.runtime.destroy=()=>{attempts++;if(throws)throw new Error('native destroy failed');destroy()}
  await assert.rejects(f.owner.closeAndDrain(),/destroy failed/);assert.equal(attempts,1);throws=false;await f.owner.closeAndDrain();assert.equal(attempts,2);assert.equal(latest(f.receipts).cleanupComplete,true);assert.equal(requests(f.native,'app.lifecycle').filter(value=>value.payload.event==='unload').length,1)
})

test('Harmony revoked identity cannot regain JS execution through foreground, timers, input or startup',async()=>{
  const f=startAttached();f.owner.revokeIdentity();const count=f.native.calls.length
  f.owner.setForeground(true);f.owner.pollTimers(Date.now());f.owner.pointer('down',1,2,3,1000);assert.equal(f.native.calls.length,count);assert.throws(()=>f.owner.start(),/cannot start after identity revocation/);await f.owner.closeAndDrain();assert.equal(requests(f.native,'app.lifecycle').filter(value=>value.payload.event==='unload').length,0)
})

test('Harmony stable account controller waits real LiveSession storage drain and acknowledged fresh presentation',async()=>{
  const pack=loadPack(),app={hostAppId:'host',tenantId:'tenant',publisherId:'pub',appId:'app',environment:'release',version:'1',packRoot:pack.integrityRoot},created=[];let release
  const gate=new Promise(resolve=>release=resolve),manager=new HarmonyHostAccountManager({principalId:'alice',epoch:'1'})
  const controller=manager.attach({application:app,createOwner:async context=>{
    const native=nativeBoundary(context.sessionId),services=new HarmonyHostServices({hostServices(json){const command=JSON.parse(json);if(command.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(command.operation==='configure')return JSON.stringify({ok:true,sessionId:context.sessionId});return '{"ok":true}'}})
    if(context.account.epoch==='1')services.onClose(()=>gate)
    const owner=new HarmonyLiveSession(pack,native.runtime,{sessionId:context.sessionId,engine:'quickjs',width:375,height:667,hostServices:services,hostIdentity:{application:context.application,account:context.account}},()=>{});created.push({owner,native})
    return {session:owner,async waitForPresentation(){owner.attachSurface(`surface-${context.sessionId}`,750,1334)},async invoke(){return JSON.parse(native.runtime.inspectState())}}
  }})
  await controller.ready;assert.equal(created[0].owner.isRunnable(),true);const switching=manager.switchAccount({principalId:'bob',epoch:'2'});assert.equal(created[0].owner.isRunnable(),false);assert.equal(controller.state.inputEnabled,false)
  await new Promise(resolve=>setImmediate(resolve));assert.equal(created.length,1);assert.equal(requests(created[0].native,'host.destroy').length,0)
  release();assert.equal((await switching).status,'complete');assert.equal(created.length,2);assert.equal(requests(created[0].native,'host.destroy').length,1);assert.equal(created[1].owner.isRunnable(),true);assert.equal(controller.state.inputEnabled,true);await controller.close()
})

test('Harmony immutable launch query and host identity are freshly supplied to AppService and page startup',async()=>{
  const pack=loadPack(),native=nativeBoundary(),identity={application:{packRoot:pack.integrityRoot},account:{principalId:'alice',epoch:'1'}},launch={query:{fromHost:'fresh'},scene:1044},services={configure(value){assert.equal(value.account.principalId,'alice')},revoke(){},async waitForDrain(){},setForeground(){}}
  const owner=new HarmonyLiveSession(pack,native.runtime,{sessionId:native.state.sessionId,engine:'quickjs',width:375,height:667,hostServices:services,hostIdentity:identity,launchOptions:launch},()=>{})
  identity.account.principalId='bob';launch.query.fromHost='mutated';owner.start();assert.equal(requests(native,'app.init')[0].payload.launchOptions.query.fromHost,'fresh');assert.equal(requests(native,'page.push')[0].payload.query.fromHost,'fresh');assert.equal(owner.executionIdentity().hostIdentity.account.principalId,'alice');await owner.closeAndDrain()
})
