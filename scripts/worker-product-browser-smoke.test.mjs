import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { PARSER_FILES, WORKER_PRODUCT_FILES, canonical, classifyRequest, inspectImportGraph, inspectProductSite,
  installWindowWasmAudit, localPath, parseArgs, productConfigBytes, regularBytes, runProductBrowserSmoke,
  screenshotPixels, withPageDeadline } from './worker-product-browser-smoke.mjs'

// Direct contracts are synthetic. They never constitute the actual product,
// presenter, real Worker, GPU or performance gate.
const repo = process.cwd()
const { parse: parseModule } = createRequire(resolve(repo, 'tools/container-manifest/package.json'))('acorn')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const descriptor = (path, bytes) => ({ path, sha256: hash(bytes), size: bytes.length })
const put = async (root, path, bytes) => { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), bytes) }

async function fixture(t) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'worker-product-contract-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const drawing = { javascript: Buffer.from('var CanvasKitInit = function(){};\n'), wasm: Buffer.from('fake-drawing-wasm'),
    license: Buffer.from('fixture license'), package: json({ name: 'canvaskit-wasm', version: '0.42.0' }),
    font: Buffer.from('fake font'), fontLicense: Buffer.from('fixture font license') }
  const pins = Object.fromEntries(Object.entries(drawing).map(([id, bytes]) => [id,
    { url: `vendor/fixture/${id}${id === 'wasm' ? '.wasm' : id === 'javascript' ? '.js' : '.bin'}`, sha256: hash(bytes), size: bytes.length }]))
  const hostFiles = Object.fromEntries(WORKER_PRODUCT_FILES.map(path => [path, Buffer.from('export const retained = true\n')]))
  hostFiles['index.html'] = Buffer.from('<main data-worker-product-entry><div id="surface-root"></div></main><script type="module" src="./worker-app.mjs"></script>\n')
  hostFiles['legacy.html'] = Buffer.from('<script type="module" src="./app.mjs"></script>\n')
  hostFiles['worker-app.mjs'] = Buffer.from("import { WorkerWebSession } from './worker-web-session.mjs'; import './worker-product-config.mjs'; export { WorkerWebSession };\n")
  hostFiles['worker-web-session.mjs'] = Buffer.from("import './worker-admission-loader.mjs'; export class WorkerWebSession {}\n")
  hostFiles['worker-admission-loader.mjs'] = Buffer.from('export const loadDrawing = url => import(url)\n')
  hostFiles['runtime-worker.mjs'] = Buffer.from("import './worker-runtime.mjs'; if (typeof DedicatedWorkerGlobalScope !== 'function') throw new Error('Worker only'); const {default:init}=await import('./pkg/container_host_web.js');\n")
  const sourceFiles = Object.fromEntries(Object.entries(hostFiles).map(([path, bytes]) => [`examples/hosts/web-wasm/${path}`, hash(bytes)]))
  const pinBytes = json(pins), validatorBytes = Buffer.from('// synthetic source-binding fixture, not an executed validator\n')
  sourceFiles['examples/hosts/web-wasm/renderer-dependency-pins.json'] = hash(pinBytes)
  sourceFiles['scripts/generated-package-closure.mjs'] = hash(validatorBytes)
  const parserRoot = await realpath(resolve(repo, 'tools/container-manifest/node_modules/acorn'))
  const parserInputs = await Promise.all(PARSER_FILES.map(async file => ({ ...file, bytes: await readFile(resolve(parserRoot, file.path)) })))
  for (const file of parserInputs) { assert.equal(file.bytes.length, file.size); assert.equal(hash(file.bytes), file.sha256) }
  async function site(name, profile) {
    const directory = resolve(root, name); await mkdir(directory)
    for (const [path, bytes] of Object.entries(hostFiles)) { await put(directory, path, bytes); await put(directory, `source/examples/hosts/web-wasm/${path}`, bytes) }
    await put(directory, 'source/examples/hosts/web-wasm/renderer-dependency-pins.json', pinBytes)
    await put(directory, 'source/scripts/generated-package-closure.mjs', validatorBytes)
    for (const file of parserInputs) await put(directory, `validation/generated-module-parser/${file.path}`, file.bytes)
    const app = Buffer.from("exports.productSmokeState = function(){return {fixture:'worker-product-counter-v1',count:0}}\n")
    const appHash = hash(app), blobPath = `portable-pack/blobs/sha256/${appHash}`
    await put(directory, blobPath, app)
    const manifest = { schemaVersion: 3, app: { appJson: 'app.json', entryModule: 'app.js' },
      modules: [{ id: 'module:app.js', format: 'commonjs', scope: 'app', sha256: appHash }], routes: [{ path: 'pages/home/index' }],
      rendering: { version: '1.0', default: profile, pages: { 'pages/home/index': profile } }, assets: [], templates: [], styles: [],
      integrity: { algorithm: 'sha256', root: '' } }
    manifest.integrity.root = hash(canonical(manifest))
    const manifestBytes = json(manifest); await put(directory, 'portable-pack/manifest.json', manifestBytes)
    const index = { schemaVersion: 1, manifest: 'portable-pack/manifest.json', manifestSha256: hash(manifestBytes),
      integrityRoot: manifest.integrity.root, blobs: [{ sha256: appHash, url: blobPath, size: app.length }] }
    const indexBytes = json(index), indexDescriptor = descriptor('pack-index.json', indexBytes)
    await put(directory, 'pack-index.json', indexBytes)
    const runtime = { schemaVersion: 1, renderer: profile === 'webview' ? 'software' : 'canvaskit', fallback: 'error' }
    if (profile === 'skia') {
      const pin = id => ({ ...pins[id] })
      runtime.canvaskit = { version: '0.42.0', variant: 'full', javascript: pin('javascript'), wasm: pin('wasm'), license: pin('license'), package: pin('package') }
      runtime.font = { family: 'Noto Sans SC', versionCommit: 'a85815a42757630ce188fdad368c2dfc444d4773', binary: pin('font'), license: pin('fontLicense') }
      for (const [id, bytes] of Object.entries(drawing)) await put(directory, pins[id].url, bytes)
    }
    const runtimeBytes = json(runtime); await put(directory, 'runtime-config.json', runtimeBytes)
    const config = { schemaVersion: 1, execution: 'worker', engine: 'quickjs',
      index: { url: './pack-index.json', sha256: hash(indexBytes), size: indexBytes.length }, rendererPolicy: { mode: 'manifest' },
      viewport: { width: 375, height: 667 }, rendererAssets: profile === 'skia' ? runtime : null }
    const configBytes = productConfigBytes(config); await put(directory, 'worker-product-config.mjs', configBytes)
    const startupBytes = json(config); await put(directory, 'worker-product-config.json', startupBytes)
    const startupJson = descriptor('worker-product-config.json', startupBytes)
    const generatedConfig = { ...descriptor('worker-product-config.mjs', configBytes), provenance: { kind: 'generated', indexSha256: hash(indexBytes) } }
    const assetValue = { schemaVersion: 1, execution: 'worker', entry: 'index.html', entryModule: 'worker-app.mjs',
      files: WORKER_PRODUCT_FILES.map(path => ({ ...descriptor(path, hostFiles[path]), sourcePath: `examples/hosts/web-wasm/${path}` })), generatedFiles: [generatedConfig, startupJson] }
    const assetBytes = json(assetValue); await put(directory, 'browser-assets.json', assetBytes)
    const glue = Buffer.from('export class WebWasmHost {}\nexport default function init() {}\n'), wasm = Buffer.from('0061736d01000000', 'hex')
    await put(directory, 'pkg/container_host_web.js', glue); await put(directory, 'pkg/container_host_web_bg.wasm', wasm)
    const glueDescriptor = descriptor('pkg/container_host_web.js', glue), wasmDescriptor = descriptor('pkg/container_host_web_bg.wasm', wasm)
    const build = { schemaVersion: 1, status: 'passed', buildStatus: 'passed', ready: true,
      plan: { execution: 'worker', entry: 'index.html', entryModule: 'worker-app.mjs' },
      source: { status: 'passed', sourceStable: true, workingTreeDirty: false, sourceCommit: 'b'.repeat(40), sourceFiles, sourceSha256: hash(JSON.stringify(sourceFiles)) },
      pack: index, packIndex: indexDescriptor, workerProductConfig: { ...generatedConfig, value: config, startupJson },
      browserAssets: { ...assetValue, status: 'passed', retainedStatus: 'passed', inventory: descriptor('browser-assets.json', assetBytes) },
      generatedPackage: { status: 'passed', retainedStatus: 'passed', files: [glueDescriptor, wasmDescriptor] },
      generatedModuleParser: { name: 'acorn', version: '8.15.0', license: 'MIT', status: 'passed', retainedStatus: 'passed',
        npmIntegrity: 'sha512-NZyJarBfL7nWwIq+FDL6Zp/yHEhePMNnnJ0y3qfieCrmNvYct8uvtiV41UvlSe6apAfk0fY1FbWx+NwfmpvtTg==',
        archiveVerifiedAtBuild: false, files: PARSER_FILES, evidenceDirectory: resolve(directory, 'validation/generated-module-parser') },
      generatedModuleClosure: { schemaVersion: 1, status: 'passed', entry: 'pkg/container_host_web.js',
        parser: { name: 'acorn', version: '8.15.0', sha256: PARSER_FILES[1].sha256 },
        modules: [{ ...glueDescriptor, references: [] }], reachable: ['pkg/container_host_web.js'], totalJavaScriptBytes: glue.length },
      artifacts: { glue: glueDescriptor, wasm: wasmDescriptor }, rendererDependencies: { status: 'passed', retainedStatus: 'passed',
        files: profile === 'skia' ? Object.entries(pins).map(([id, pin]) => ({ id, ...pin, verified: true })) : [],
        runtimeConfig: { path: 'runtime-config.json', sha256: hash(runtimeBytes), bytes: runtimeBytes.length, value: runtime } } }
    const save = () => put(directory, 'build-report.json', json(build)); await save()
    return { directory, build, save, indexSha256: hash(indexBytes), profile }
  }
  const dom = await site('dom', 'webview'), canvas = await site('canvas', 'skia')
  return { root, dom, canvas, options: { domSiteDir: dom.directory, domIndexSha256: dom.indexSha256,
    canvasSiteDir: canvas.directory, canvasIndexSha256: canvas.indexSha256, outDir: resolve(root, 'evidence') } }
}

test('CLI requires two distinct external index pins and three separate roots', () => {
  const args = ['--dom-site-dir', '/tmp/dom', '--dom-index-sha256', 'a'.repeat(64), '--canvas-site-dir', '/tmp/canvas', '--canvas-index-sha256', 'b'.repeat(64), '--out-dir', '/tmp/evidence']
  assert.equal(parseArgs(args).domIndexSha256, 'a'.repeat(64))
  assert.throws(() => parseArgs(args.slice(0, -2)), /Missing required/)
  assert.throws(() => parseArgs([...args, '--out-dir', '/tmp/repeated']), /Duplicate/)
  assert.throws(() => parseArgs(args.map(value => value === 'b'.repeat(64) ? 'a'.repeat(64) : value)), /different exact pins/)
  assert.throws(() => parseArgs(args.map(value => value === '/tmp/evidence' ? '/tmp/dom/evidence' : value)), /nonoverlapping/)
})

test('retained paths and reads reject traversal, encoded paths, symlinks and oversize files', async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'product-path-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['../x', '/x', 'pkg/../x', 'pkg/%78', 'pkg\\x', 'pkg/x?y']) assert.throws(() => localPath(root, path))
  await put(root, 'regular', 'test'); assert.equal((await regularBytes(root, 'regular')).toString(), 'test')
  await assert.rejects(regularBytes(root, 'regular', 3), /finite budget/)
  await symlink(resolve(root, 'regular'), resolve(root, 'link')); await assert.rejects(regularBytes(root, 'link'), /Nonregular/)
})

test('independent import closure separates Worker resource URLs from Window imports', () => {
  const files = new Map([
    ['entry.mjs', Buffer.from("import './owner.mjs'; new URL('./runtime-worker.mjs', import.meta.url)")],
    ['owner.mjs', Buffer.from("export { value } from './data.mjs'")], ['data.mjs', Buffer.from('export const value=1')],
    ['runtime-worker.mjs', Buffer.from("import './pkg/host.js'")], ['pkg/host.js', Buffer.from("export const bytes = new URL('host.wasm', import.meta.url)")],
    ['pkg/host.wasm', Buffer.from('wasm')],
  ])
  const main = inspectImportGraph(files, 'entry.mjs', parseModule)
  assert.deepEqual(main.files, ['data.mjs', 'entry.mjs', 'owner.mjs'])
  assert.deepEqual(main.resources, ['runtime-worker.mjs'])
  assert.deepEqual(inspectImportGraph(files, 'runtime-worker.mjs', parseModule).resources, ['pkg/host.wasm'])
  files.set('data.mjs', Buffer.from("import 'https://example.com/code.js'")); assert.throws(() => inspectImportGraph(files, 'entry.mjs', parseModule), /reference/)
  files.set('data.mjs', Buffer.from('export const load = name => import(name)')); assert.throws(() => inspectImportGraph(files, 'entry.mjs', parseModule), /nonliteral/)
  files.set('data.mjs', Buffer.from("new URL(resource, import.meta.url)")); assert.throws(() => inspectImportGraph(files, 'entry.mjs', parseModule), /import.meta.url/)
})

test('only source-bound drawing loader has a nonliteral Blob import contract', () => {
  const source = Buffer.from('export const load = url => import(url)')
  assert.equal(inspectImportGraph(new Map([['worker-admission-loader.mjs', source]]), 'worker-admission-loader.mjs', parseModule).blobImports.length, 1)
  assert.throws(() => inspectImportGraph(new Map([['unexpected.mjs', source]]), 'unexpected.mjs', parseModule), /nonliteral/)
})

test('egress allows finite local files and drawing Blobs, blocks business/legacy/external requests', () => {
  const input = { origin: 'http://127.0.0.1:1234', allowed: new Set(['index.html', 'pack-index.json']), profile: 'skia' }
  assert.equal(classifyRequest(input.origin + '/', input).path, 'index.html')
  for (const path of ['/api', '/api/state', '/%61pi/bridge', '/legacy.html', '/app.mjs', '/missing', '/?renderer=software']) assert.equal(classifyRequest(input.origin + path, input).allowed, false)
  assert.equal(classifyRequest('https://example.com/pkg.wasm', input).allowed, false)
  assert.equal(classifyRequest(input.origin + '/pack-index.json', { ...input, method: 'POST' }).allowed, false)
  assert.equal(classifyRequest('blob:' + input.origin + '/drawing', input).allowed, true)
  assert.equal(classifyRequest('blob:' + input.origin + '/drawing', { ...input, profile: 'webview' }).allowed, false)
  assert.equal(classifyRequest('blob:not-a-valid-origin', input).allowed, false)
  assert.equal(classifyRequest(input.origin + '/favicon.ico', input).reason, 'browser-generated-favicon-no-content')
})

function wasmTarget() {
  class OriginalInstance { constructor(exports) { this.exports = exports } }
  const target = { document: {}, WebAssembly: { Instance: OriginalInstance,
    instantiate: async exports => ({ instance: new OriginalInstance(exports), module: {} }),
    instantiateStreaming: async exports => ({ instance: new OriginalInstance(exports), module: {} }) } }
  target.top = target
  installWindowWasmAudit(target)
  return target
}
test('Window guard allows drawing exports and rejects raw/bindgen-suffixed application hosts on all three APIs', async () => {
  const target = wasmTarget(), wasm = target.WebAssembly
  new wasm.Instance({ _malloc() {}, CanvasKitInit() {} })
  await wasm.instantiate({ _draw() {} }); await wasm.instantiateStreaming({ _draw() {} })
  assert.equal(target.__workerProductWasmAudit.calls.length, 3); assert.deepEqual(target.__workerProductWasmAudit.violations, [])
  assert.throws(() => new wasm.Instance({ webwasmhost_new_144b20889b08dae8() {} }), { code: 'ERR_ENGINE' })
  await assert.rejects(wasm.instantiate({ webwasmhost_new() {} }), { code: 'ERR_ENGINE' })
  await assert.rejects(wasm.instantiateStreaming({ webwasmhost_dispatch_json_abcdef() {} }), { code: 'ERR_ENGINE' })
  assert.equal(target.__workerProductWasmAudit.violations.length, 3)
})

test('default-entry preflight verifies both immutable sites and does not execute app/renderer code', async t => {
  const f = await fixture(t)
  for (const site of [f.dom, f.canvas]) {
    const value = await inspectProductSite(site.directory, { expectedIndexSha256: site.indexSha256, profile: site.profile, parseModule })
    assert.equal(value.provenance.indexSha256, site.indexSha256)
    assert.equal(value.allowed.has('app.mjs'), false); assert.equal(value.allowed.has('legacy.html'), false)
    const retained = Buffer.from(value.files.get('index.html'))
    await put(site.directory, 'index.html', 'mutated site after preflight')
    assert.deepEqual(value.files.get('index.html'), retained, 'Serving must use the retained bytes rather than mutable disk reads')
  }
})

test('preflight rejects wrong caller pin, source/config/blob corruption and source symlinks before browser allocation', async t => {
  const mutations = [
    async site => { await put(site.directory, 'worker-product-config.mjs', 'export const WORKER_PRODUCT_CONFIG = {}') },
    async site => { await put(site.directory, 'source/examples/hosts/web-wasm/worker-web-session.mjs', 'mutated source') },
    async site => { await put(site.directory, site.build.pack.blobs[0].url, 'corrupted blob') },
    async site => { const path = resolve(site.directory, 'runtime-worker.mjs'); await rm(path); await symlink(resolve(site.directory, 'worker-runtime.mjs'), path) },
  ]
  for (const mutate of mutations) {
    const f = await fixture(t)
    await mutate(f.dom)
    await assert.rejects(inspectProductSite(f.dom.directory, { expectedIndexSha256: f.dom.indexSha256, profile: 'webview', parseModule }))
  }
  const f = await fixture(t)
  await assert.rejects(inspectProductSite(f.dom.directory, { expectedIndexSha256: 'f'.repeat(64), profile: 'webview', parseModule }))
})

test('preflight requires fresh generated parser/closure gates and rejects changed parser or extra pkg files', async t => {
  for (const mutate of [
    async site => { delete site.build.generatedModuleClosure; await site.save() },
    async site => { site.build.generatedModuleParser.retainedStatus = 'not-run'; await site.save() },
    async site => { await put(site.directory, 'validation/generated-module-parser/dist/acorn.mjs', 'throw new Error("must not execute")') },
    async site => { await put(site.directory, 'pkg/unreported.js', 'export const injected = true') },
  ]) {
    const f = await fixture(t); await mutate(f.dom)
    await assert.rejects(inspectProductSite(f.dom.directory, { expectedIndexSha256: f.dom.indexSha256, profile: 'webview', parseModule }))
  }
})

test('preflight rejects forged generated references even when pkg hashes were updated', async t => {
  const f = await fixture(t), site = f.dom
  const changed = Buffer.from('export const load = name => import(name)\n'), next = descriptor('pkg/container_host_web.js', changed)
  await put(site.directory, next.path, changed)
  site.build.generatedPackage.files[0] = next; site.build.artifacts.glue = next
  site.build.generatedModuleClosure.modules[0] = { ...next, references: [] }; site.build.generatedModuleClosure.totalJavaScriptBytes = changed.length
  await site.save()
  await assert.rejects(inspectProductSite(site.directory, { expectedIndexSha256: site.indexSha256, profile: 'webview', parseModule }), /nonliteral/)
})

test('preflight rejects changed drawing bytes before any CanvasKit initializer can execute', async t => {
  const f = await fixture(t)
  await put(f.canvas.directory, f.canvas.build.rendererDependencies.files.find(file => file.id === 'javascript').url,
    'throw new Error("unverified renderer must never execute")')
  await assert.rejects(inspectProductSite(f.canvas.directory, { expectedIndexSha256: f.canvas.indexSha256, profile: 'skia', parseModule }), /mismatch/)
})

test('preflight rejects missing, mutated and unreported startup JSON', async t => {
  for (const mutate of [
    async site => { delete site.build.workerProductConfig.startupJson; await site.save() },
    async site => { await rm(resolve(site.directory, 'worker-product-config.json')) },
    async site => { await put(site.directory, 'worker-product-config.json', '{}\n') },
    async site => { site.build.browserAssets.generatedFiles.pop(); await site.save() },
  ]) {
    const f = await fixture(t); await mutate(f.dom)
    await assert.rejects(inspectProductSite(f.dom.directory, { expectedIndexSha256: f.dom.indexSha256, profile: 'webview', parseModule }))
  }
})

test('a consistently re-inventoried startup JSON must still match the generated module value', async t => {
  const f = await fixture(t), site = f.dom
  const bytes = json({ ...site.build.workerProductConfig.value, viewport: { width: 400, height: 700 } })
  const changed = descriptor('worker-product-config.json', bytes)
  await put(site.directory, changed.path, bytes)
  site.build.workerProductConfig.startupJson = changed
  site.build.browserAssets.generatedFiles[1] = changed
  const inventory = JSON.parse(await readFile(resolve(site.directory, 'browser-assets.json'), 'utf8'))
  inventory.generatedFiles[1] = changed
  const inventoryBytes = json(inventory); await put(site.directory, 'browser-assets.json', inventoryBytes)
  site.build.browserAssets.inventory = descriptor('browser-assets.json', inventoryBytes)
  await site.save()
  await assert.rejects(inspectProductSite(site.directory, { expectedIndexSha256: site.indexSha256, profile: 'webview', parseModule }), /startup JSON differs/)
})

function pngPixel(rgba) {
  const chunk = (kind, bytes) => { const value = Buffer.alloc(12 + bytes.length); value.writeUInt32BE(bytes.length); value.write(kind, 4, 'ascii'); bytes.copy(value, 8); return value }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND', Buffer.alloc(0))])
}
test('trusted screenshot decoder measures actual RGBA and rejects unsupported/corrupt profiles', () => {
  const result = screenshotPixels(pngPixel([31, 75, 153, 255]))
  assert.equal(result.width, 1); assert.equal(result.height, 1); assert.deepEqual([...result.rgba], [31, 75, 153, 255])
  assert.throws(() => screenshotPixels(Buffer.from('not an image')))
  assert.throws(() => screenshotPixels(pngPixel([0, 0, 0, 0]).subarray(0, 40)))
})

test('page deadline closes only its owned page and observes a later rejected action', async () => {
  let closes = 0
  const page = { close: async () => { closes++ } }
  assert.equal(await withPageDeadline(page, async () => 42, { timeoutMs: 50 }), 42)
  assert.equal(closes, 0)
  let reject
  const pending = new Promise((_done, failed) => { reject = failed })
  await assert.rejects(withPageDeadline(page, () => pending, { timeoutMs: 5 }), /ERR_TIMEOUT/)
  reject(new Error('late page rejection'))
  await Promise.resolve(); assert.equal(closes, 1)
})

test('failed browser launch releases the exact local server and never reports runtime success', async t => {
  const f = await fixture(t)
  let launches = 0
  const report = await runProductBrowserSmoke(f.options, { parseModule, chromium: { launch: async options => {
    launches++; assert.equal(options.headless, true); throw new Error('ERR_TEST_INFRASTRUCTURE: mocked unavailable browser')
  } } })
  assert.equal(launches, 1); assert.equal(report.status, 'blocked'); assert.equal(report.cleanup.serverClosed, true)
  assert.equal(report.acceptance.applicationExecution, 'not-run'); assert.equal(report.acceptance.presentation, 'not-run')
  assert.equal(report.acceptance.gpu, 'unknown'); assert.equal(report.acceptance.performance, 'not-run')
})

test('cancelled launch waits for its own returned browser handle before cleanup', async t => {
  const f = await fixture(t), controller = new AbortController()
  let launchFinished = false, closed = false
  const report = await runProductBrowserSmoke(f.options, { parseModule, signal: controller.signal, chromium: {
    launch: async () => {
      controller.abort(new Error('scoped fixture cancellation'))
      await Promise.resolve(); launchFinished = true
      return { close: async () => { assert.equal(launchFinished, true); closed = true }, isConnected: () => !closed }
    },
  } })
  assert.equal(report.status, 'cancelled'); assert.equal(closed, true); assert.equal(report.cleanup.browserClosed, true)
  assert.equal(report.cleanup.serverClosed, true); assert.equal(report.acceptance.defaultEntry, 'not-run')
})
