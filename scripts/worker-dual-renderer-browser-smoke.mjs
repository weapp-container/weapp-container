#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PARSER_FILES, localPath, regularBytes, canonical, productConfigBytes,
  inspectImportGraph, classifyRequest, installWindowWasmAudit, screenshotPixels, withPageDeadline } from './worker-product-browser-smoke.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_ROOT = resolve(ROOT, 'scripts/fixtures/worker-dual-renderer')
const HEX = /^[0-9a-f]{64}$/
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(message) }
const LIMITS = Object.freeze({ file: 96 * 1024 * 1024, retained: 384 * 1024 * 1024, index: 2 * 1024 * 1024 })
// Independent expected product closure. Updating host inventory requires an
// explicit fixture review; neither build-report claims nor a live import choose it.
const FILES = ['index.html', 'app.mjs', 'canvaskit-presenter.mjs', 'text-flow-plan.mjs', 'render-inputs.mjs', 'surface-input.mjs',
  'input-causal-ledger.mjs', 'runtime-worker.mjs', 'worker-runtime.mjs', 'worker-session-client.mjs', 'worker-bridge-transport.mjs',
  'dom-presenter.mjs', 'dom-session-client.mjs', 'legacy.html', 'worker-app.mjs', 'worker-web-session.mjs',
  'presentation-scheduler.mjs', 'worker-dom-adapter.mjs', 'worker-canvaskit-adapter.mjs', 'worker-admission-loader.mjs', 'browser-dev-owner-manager.mjs']
const FIXTURE = Object.freeze({id: 'worker-dual-renderer-v1', routes: Object.freeze({
  'pages/dom/index': 'webview', 'pages/skia/index': 'skia', 'pages/return/index': 'webview'}),
  feedback: {x: 100, y: 310}, before: [31,75,153,255], after: [30,132,73,255],
  buttons: {increment: {x: 100, y: 102}, back: {x: 100, y: 167}, return: {x: 100, y: 232}}})

export function parseArgs(args) {
  const options = {}, names = new Map([['--site-dir', 'siteDir'], ['--index-sha256', 'indexSha256'],
    ['--expected-source-commit', 'expectedSourceCommit'], ['--out-dir', 'outDir']])
  for (let i = 0; i < args.length; i++) {
    const key = names.get(args[i])
    assert.ok(key && args[i + 1] && !args[i + 1].startsWith('--'), `Unknown argument or missing value: ${args[i]}`)
    assert.equal(options[key], undefined, `Duplicate argument: ${args[i]}`)
    options[key] = args[++i]
  }
  for (const key of ['siteDir', 'indexSha256', 'expectedSourceCommit', 'outDir']) assert.ok(options[key], `Missing required ${key}`)
  assert.match(options.indexSha256, HEX, 'An externally supplied exact original pack-index pin is required')
  if (options.expectedSourceCommit !== undefined) assert.match(options.expectedSourceCommit, /^[0-9a-f]{40}$/)
  for (const key of ['siteDir', 'outDir']) options[key] = resolve(options[key])
  assert.ok(options.siteDir !== options.outDir && !options.siteDir.startsWith(options.outDir + sep)
    && !options.outDir.startsWith(options.siteDir + sep), 'Site and evidence must be separate nonoverlapping directories')
  return options
}

export async function fixtureSourceInventory() {
  const result = [], root = await realpath(resolve(FIXTURE_ROOT, 'raw'))
  assert.equal(root, resolve(FIXTURE_ROOT, 'raw'))
  async function visit(path = '') {
    for (const item of await readdir(path ? localPath(root, path) : root, {withFileTypes: true})) {
      const name = path ? path + '/' + item.name : item.name
      assert.ok(item.isDirectory() || item.isFile(), `Nonregular fixture entry: ${name}`)
      if (item.isDirectory()) {
        const directory = localPath(root, name)
        assert.equal(await realpath(directory), directory); await visit(name)
      } else {
        const bytes = await regularBytes(root, name, 128 * 1024)
        result.push({path: name, size: bytes.length, sha256: digest(bytes)})
      }
    }
  }
  await visit(); return result.sort((a,b) => a.path.localeCompare(b.path))
}

// This consumer verifies retained bytes independently. It intentionally does
// not use the builder's executable source, rewrite reports or import app code.
export async function inspectMixedProductSite(siteDir, { expectedIndexSha256, expectedSourceCommit, parseModule }) {
  assert.match(expectedIndexSha256, HEX)
  const profile = 'skia' // Mixed products must retain all six drawing resources.
  const root = await realpath(siteDir)
  assert.equal(root, resolve(siteDir), 'Use a regular, non-symlinked retained site root')
  const reportBytes = await regularBytes(root, 'build-report.json'), build = JSON.parse(reportBytes)
  assert.equal(build.status, 'passed'); assert.equal(build.ready, true); assert.equal(build.buildStatus, 'passed')
  assert.equal(build.source?.status, 'passed'); assert.equal(build.source?.workingTreeDirty, false); assert.equal(build.source?.sourceStable, true)
  assert.match(build.source?.sourceCommit, /^[0-9a-f]{40}$/)
  if (expectedSourceCommit) assert.equal(build.source.sourceCommit, expectedSourceCommit, 'Unexpected frozen product commit')
  assert.equal(build.source.sourceSha256, digest(JSON.stringify(build.source.sourceFiles)), 'Invalid source inventory hash')
  assert.equal(build.plan?.execution, 'worker'); assert.equal(build.plan?.entry, 'index.html'); assert.equal(build.plan?.entryModule, 'worker-app.mjs')
  // The report remains historical static evidence. This runner never upgrades it.
  const files = new Map(), inventory = {}, sourceRoot = await realpath(resolve(root, 'source'))
  assert.equal(sourceRoot, resolve(root, 'source'))
  assert.ok(record(build.source.sourceFiles) && Object.keys(build.source.sourceFiles).length <= 10_000, 'Source inventory exceeds its finite file budget')
  let sourceBytes = 0
  for (const [path, hash] of Object.entries(build.source.sourceFiles)) {
    assert.match(hash, HEX)
    const bytes = await regularBytes(sourceRoot, path, Math.min(LIMITS.file, LIMITS.retained - sourceBytes))
    sourceBytes += bytes.length
    assert.equal(digest(bytes), hash, `Frozen source changed: ${path}`)
  }
  assert.match(build.source.sourceFiles['scripts/generated-package-closure.mjs'] ?? '', HEX, 'Fresh source-bound generated closure gate is required')
  const parser = build.generatedModuleParser
  assert.equal(parser?.status, 'passed'); assert.equal(parser?.retainedStatus, 'passed')
  assert.equal(parser.name, 'acorn'); assert.equal(parser.version, '8.15.0'); assert.equal(parser.license, 'MIT')
  assert.equal(parser.npmIntegrity, 'sha512-NZyJarBfL7nWwIq+FDL6Zp/yHEhePMNnnJ0y3qfieCrmNvYct8uvtiV41UvlSe6apAfk0fY1FbWx+NwfmpvtTg==')
  assert.equal(parser.archiveVerifiedAtBuild, false, 'Package-file verification must not claim archive verification')
  assert.deepEqual(parser.files, PARSER_FILES)
  assert.equal(parser.evidenceDirectory, resolve(root, 'validation/generated-module-parser'))
  let parserModuleBytes
  for (const file of PARSER_FILES) {
    const bytes = await regularBytes(root, `validation/generated-module-parser/${file.path}`, 256 * 1024)
    assert.equal(bytes.length, file.size); assert.equal(digest(bytes), file.sha256, `Retained parser changed: ${file.path}`)
    if (file.path === 'dist/acorn.mjs') parserModuleBytes = bytes
  }
  if (!parseModule) {
    const module = await import(`data:text/javascript;base64,${parserModuleBytes.toString('base64')}`)
    assert.equal(module.version, '8.15.0'); assert.equal(typeof module.parse, 'function'); parseModule = module.parse
  }
  let total = 0
  const retain = async (path, descriptor, purpose) => {
    assert.ok(!files.has(path), `Duplicate static inventory path: ${path}`)
    assert.ok(HEX.test(descriptor?.sha256) && Number.isSafeInteger(descriptor?.size) && descriptor.size >= 0, `Invalid descriptor: ${path}`)
    assert.ok(descriptor.size <= LIMITS.retained - total, 'Static retained bytes exceed the remaining run budget')
    const bytes = await regularBytes(root, path, Math.min(LIMITS.file, LIMITS.retained - total))
    assert.equal(bytes.length, descriptor.size, `Retained size mismatch: ${path}`)
    assert.equal(digest(bytes), descriptor.sha256, `Retained hash mismatch: ${path}`)
    total += bytes.length; assert.ok(total <= LIMITS.retained, 'Static retained bytes exceed the run budget')
    files.set(path, bytes); inventory[path] = { sha256: descriptor.sha256, size: bytes.length, purpose }
    return bytes
  }
  const assets = build.browserAssets
  assert.equal(assets?.status, 'passed'); assert.equal(assets?.retainedStatus, 'passed')
  assert.equal(assets.execution, 'worker'); assert.equal(assets.entry, 'index.html'); assert.equal(assets.entryModule, 'worker-app.mjs')
  assert.deepEqual(assets.files.map(file => file.path), FILES)
  for (const file of assets.files) {
    assert.equal(file.sourcePath, `examples/hosts/web-wasm/${file.path}`)
    assert.equal(file.sha256, build.source.sourceFiles[file.sourcePath])
    await retain(file.path, file, 'frozen-browser-source')
  }
  const stagedAssets = JSON.parse(await regularBytes(root, assets.inventory.path))
  assert.deepEqual(stagedAssets.files, assets.files); assert.deepEqual(stagedAssets.generatedFiles, assets.generatedFiles)
  await retain(assets.inventory.path, assets.inventory, 'browser-inventory')
  const indexDescriptor = build.packIndex
  assert.equal(indexDescriptor?.path, 'pack-index.json'); assert.equal(indexDescriptor.sha256, expectedIndexSha256)
  assert.ok(indexDescriptor.size <= LIMITS.index)
  const indexBytes = await retain('pack-index.json', indexDescriptor, 'independently-pinned-original-index')
  const index = JSON.parse(indexBytes)
  assert.deepEqual(index, build.pack); assert.equal(index.schemaVersion, 1)
  assert.equal(index.manifest, 'portable-pack/manifest.json')
  // The current builder omits manifestSize. Its index still pins exact SHA-256;
  // bound the regular input independently and retain that actual byte length.
  const manifestSize = (await regularBytes(root, index.manifest, LIMITS.index)).length
  if (index.manifestSize !== undefined) assert.equal(index.manifestSize, manifestSize)
  const manifestBytes = await retain(index.manifest, { sha256: index.manifestSha256, size: manifestSize }, 'original-portable-manifest')
  const manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.schemaVersion, 3, 'Renderer profiles require manifest schema 3')
  assert.equal(manifest.integrity?.algorithm, 'sha256'); assert.equal(manifest.integrity.root, index.integrityRoot)
  assert.equal(digest(canonical({ ...manifest, integrity: { ...manifest.integrity, root: '' } })), index.integrityRoot)
  assert.equal(manifest.rendering?.version, '1.0')
  assert.deepEqual(manifest.routes.map(route => route.path), Object.keys(FIXTURE.routes))
  assert.equal(manifest.compiler.commit, 'fixture-worker-dual-renderer-v1')
  for (const [route, family] of Object.entries(FIXTURE.routes)) assert.equal(manifest.rendering.pages[route] ?? manifest.rendering.default, family)
  const blobs = new Map()
  for (const blob of index.blobs) {
    assert.ok(HEX.test(blob.sha256) && !blobs.has(blob.sha256), 'Invalid or duplicate content-addressed blob')
    const path = blob.url.replace(/^\.\//, '')
    blobs.set(blob.sha256, await retain(path, blob, 'original-content-addressed-blob'))
  }
  for (const module of manifest.modules) assert.ok(blobs.has(module.sha256), `Missing module blob: ${module.id}`)
  // app.entryModule is an emitted path; module inventory ids use the module:
  // namespace. Resolve the same key used by the real AppService loader.
  const entryId = `module:${manifest.app.entryModule.replace(/^module:/, '')}`
  const entry = manifest.modules.find(module => module.id === entryId)
  assert.ok(entry && entry.format === 'commonjs', 'Fixture requires its real CommonJS App module')
  assert.ok(blobs.get(entry.sha256).includes(Buffer.from('dualRendererSmokeState')), 'The dedicated product smoke App export is absent')
  const fixtureInputs = await fixtureSourceInventory()
  for (const input of fixtureInputs.filter(file => file.path.endsWith('.js'))) {
    const module = manifest.modules.find(module => module.id === `module:${input.path}`)
    assert.ok(module && module.format === 'commonjs', `Missing real fixture module: ${input.path}`)
    assert.equal(module.sha256, input.sha256, `Actual pack differs from hand-authored fixture: ${input.path}`)
  }
  const generated = build.generatedPackage
  assert.equal(generated?.status, 'passed'); assert.equal(generated?.retainedStatus, 'passed')
  const actualPackagePaths = []
  const visit = async path => {
    const directory = localPath(root, path)
    assert.ok((await lstat(directory)).isDirectory() && await realpath(directory) === directory, `Nonregular pkg directory: ${path}`)
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.ok(item.isDirectory() || item.isFile(), `Nonregular pkg member: ${path}/${item.name}`)
      if (item.isDirectory()) await visit(`${path}/${item.name}`)
      else actualPackagePaths.push(`${path}/${item.name}`)
    }
  }
  await visit('pkg')
  assert.deepEqual(actualPackagePaths.sort(), generated.files.map(file => file.path).sort(), 'Generated pkg closure differs from its inventory')
  for (const file of generated.files) { assert.ok(file.path.startsWith('pkg/')); await retain(file.path, file, 'passed-generated-pkg') }
  const generatedClosure = build.generatedModuleClosure
  assert.equal(generatedClosure?.schemaVersion, 1); assert.equal(generatedClosure?.status, 'passed')
  assert.equal(generatedClosure.entry, 'pkg/container_host_web.js')
  assert.deepEqual(generatedClosure.parser, { name: 'acorn', version: '8.15.0', sha256: PARSER_FILES[1].sha256 })
  const allGeneratedJs = generated.files.filter(file => /\.(?:m?js)$/.test(file.path))
  assert.deepEqual(generatedClosure.modules.map(module => module.path).sort(), allGeneratedJs.map(file => file.path).sort())
  for (const module of generatedClosure.modules) {
    const descriptor = generated.files.find(file => file.path === module.path)
    assert.equal(module.sha256, descriptor.sha256); assert.equal(module.size, descriptor.size)
    const graph = inspectImportGraph(files, module.path, parseModule)
    const ordered = value => [...value].sort((a, b) => canonical(a).localeCompare(canonical(b)))
    assert.deepEqual(ordered(module.references), ordered(graph.references[module.path]), `Generated closure references differ from retained syntax: ${module.path}`)
  }
  assert.equal(generatedClosure.totalJavaScriptBytes, allGeneratedJs.reduce((total, file) => total + file.size, 0))
  for (const kind of ['glue', 'wasm']) {
    const artifact = build.artifacts?.[kind]
    assert.equal(inventory[artifact?.path]?.sha256, artifact?.sha256, `Unbound generated ${kind}`)
  }
  assert.equal(build.artifacts.glue.path, 'pkg/container_host_web.js'); assert.equal(build.artifacts.wasm.path, 'pkg/container_host_web_bg.wasm')
  const dependencies = build.rendererDependencies
  assert.equal(dependencies?.status, 'passed'); assert.equal(dependencies?.retainedStatus, 'passed')
  const runtime = dependencies.runtimeConfig
  assert.ok(runtime?.bytes > 0)
  const runtimeBytes = await retain(runtime.path, { sha256: runtime.sha256, size: runtime.bytes }, 'renderer-runtime-config')
  assert.deepEqual(JSON.parse(runtimeBytes), runtime.value); assert.equal(runtime.value.fallback, 'error')
  const pinsPath = 'examples/hosts/web-wasm/renderer-dependency-pins.json'
  const pinsBytes = await regularBytes(sourceRoot, pinsPath)
  assert.equal(digest(pinsBytes), build.source.sourceFiles[pinsPath])
  const pins = JSON.parse(pinsBytes)
  if (profile === 'skia') {
    assert.equal(runtime.value.renderer, 'canvaskit')
    assert.deepEqual(dependencies.files.map(file => file.id).sort(), ['font', 'fontLicense', 'javascript', 'license', 'package', 'wasm'])
    for (const file of dependencies.files) {
      assert.equal(file.verified, true); assert.equal(file.sha256, pins[file.id]?.sha256); assert.equal(file.size, pins[file.id]?.size)
      assert.equal(file.url, pins[file.id]?.url)
      await retain(file.url, file, 'committed-six-pinned-drawing-assets')
    }
    const configDescriptors = { javascript: runtime.value.canvaskit?.javascript, wasm: runtime.value.canvaskit?.wasm,
      license: runtime.value.canvaskit?.license, package: runtime.value.canvaskit?.package,
      font: runtime.value.font?.binary, fontLicense: runtime.value.font?.license }
    for (const [id, descriptor] of Object.entries(configDescriptors)) assert.deepEqual(descriptor,
      { url: pins[id].url, sha256: pins[id].sha256, size: pins[id].size }, `Unpinned drawing descriptor: ${id}`)
  } else {
    assert.equal(runtime.value.renderer, 'software'); assert.deepEqual(dependencies.files, [])
    // This packaging label does not enable a software presenter: manifest=webview.
  }
  const config = build.workerProductConfig
  const startup = config.startupJson
  assert.equal(startup?.path, 'worker-product-config.json')
  assert.ok(Number.isSafeInteger(startup.size) && startup.size > 0 && startup.size <= 64 * 1024)
  assert.deepEqual(assets.generatedFiles, [{ path: config.path, sha256: config.sha256, size: config.size,
    provenance: config.provenance }, startup])
  assert.equal(config.path, 'worker-product-config.mjs')
  assert.deepEqual(config.value, { schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    index: { url: './pack-index.json', sha256: expectedIndexSha256, size: indexBytes.length }, rendererPolicy: { mode: 'manifest' },
    viewport: { width: 375, height: 667 }, rendererAssets: runtime.value, rendererTransitions: { version: '1.0' } })
  assert.deepEqual(await retain(config.path, config, 'generated-exact-product-config'), productConfigBytes(config.value), 'Generated config contains unexpected code')
  const intent = build.workerStartupIntent
  assert.equal(intent?.path, 'worker-startup-intent.json')
  const intentBytes = await retain(intent.path, intent, 'original-explicit-renderer-transition-intent')
  assert.deepEqual(intentBytes, await regularBytes(FIXTURE_ROOT, 'startup-intent.json', 64 * 1024), 'Original startup bytes differ from the reviewed opt-in fixture')
  assert.deepEqual(JSON.parse(intentBytes), { schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    viewport: {width: 375, height: 667}, rendererPolicy: {mode: 'manifest'}, rendererTransitions: {version: '1.0'} })
  const startupBytes = await retain(startup.path, startup, 'generated-exact-startup-json')
  assert.deepEqual(startupBytes, Buffer.from(JSON.stringify(config.value, null, 2) + '\n'), 'Generated startup JSON differs from the product configuration')
  const html = files.get('index.html').toString('utf8'), scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  assert.equal(scripts.length, 1); assert.match(scripts[0][1], /\btype=["']module["']/); assert.match(scripts[0][1], /\bsrc=["']\.\/worker-app\.mjs["']/)
  assert.equal(scripts[0][2].trim(), ''); assert.match(html, /data-worker-product-entry/)
  const mainGraph = inspectImportGraph(files, 'worker-app.mjs', parseModule)
  const workerGraph = inspectImportGraph(files, 'runtime-worker.mjs', parseModule)
  assert.deepEqual(generatedClosure.reachable, inspectImportGraph(files, 'pkg/container_host_web.js', parseModule).files)
  assert.ok(!mainGraph.files.some(path => path === 'app.mjs' || path === 'runtime-worker.mjs' || path.startsWith('pkg/')), 'Application host is reachable from the Window graph')
  assert.ok(workerGraph.files.includes('pkg/container_host_web.js'), 'The real Worker graph must load the application glue')
  assert.ok(!workerGraph.files.includes('app.mjs'), 'Legacy application glue entered the Worker product graph')
  const runtimeEntry = files.get('runtime-worker.mjs').toString('utf8')
  assert.ok(runtimeEntry.indexOf('DedicatedWorkerGlobalScope') >= 0
    && runtimeEntry.indexOf('DedicatedWorkerGlobalScope') < runtimeEntry.indexOf("import('./pkg/container_host_web.js')"), 'Application WASM must remain behind the Dedicated Worker guard')
  const allowed = new Set([...mainGraph.files, ...workerGraph.files, ...mainGraph.resources, ...workerGraph.resources, 'index.html', 'pack-index.json', index.manifest, runtime.path,
    ...index.blobs.map(blob => blob.url.replace(/^\.\//, '')), ...dependencies.files.map(file => file.url)])
  allowed.delete('app.mjs'); allowed.delete('legacy.html')
  return { files, allowed, inventory, manifest, config: config.value, moduleId: entry.id, profile,
    fixtureInputs, provenance: { workerStartupIntent: intent, buildReportSha256: digest(reportBytes), source: build.source, indexSha256: expectedIndexSha256,
      indexSize: indexBytes.length, manifestSha256: index.manifestSha256, integrityRoot: index.integrityRoot,
      graphs: { main: mainGraph, worker: workerGraph }, generatedModuleClosure: generatedClosure,
      generatedModuleParser: parser, rendererDependencies: dependencies, totalRetainedBytes: total } }
}


export function assertAccepted(status, route, label, {allowPendingTemplate = false} = {}) {
  const state = status.observation?.state, accepted = status.presentation?.accepted, proof = accepted?.proof
  assert.equal(status.phase, 'ready', label); assert.equal(status.runtimeReady, true)
  assert.equal(status.inputEnabled, true, label); assert.equal(accepted?.inputEnabled, true, label)
  assert.equal(status.observation.version, '2.0'); assert.deepEqual(state.owner, status.runtimeOwner)
  assert.equal(state.transitionRequired, false); assert.equal(status.presenterTransition, null)
  assert.equal(state.currentPage.path, route); assert.equal(state.rendererProfile, FIXTURE.routes[route])
  assert.deepEqual(state.presenterBinding, status.presenterBinding)
  assert.equal(status.presenterBinding.sessionId, status.runtimeOwner.sessionId)
  assert.equal(status.owner.presenterGeneration, status.presenterBinding.generation)
  assert.equal(status.owner.transportBackend, status.presenterBinding.transportBackend)
  for (const key of ['workerEpoch', 'sessionId', 'packSha256']) assert.equal(status.owner[key], status.runtimeOwner[key])
  assert.equal(proof?.version, '1.0'); assert.deepEqual(proof.owner, status.owner)
  assert.equal(proof.consumedInput.pageId, state.currentPage.pageId); assert.equal(proof.consumedInput.routePath, route)
  // A sampled input authority may still describe the last accepted view while
  // ordinary setData has queued its successor. Page/binding/surface/viewport
  // remain exact below; a proof may never claim a future template revision.
  if (allowPendingTemplate) assert.ok(BigInt(proof.consumedInput.templateRevision) <= BigInt(state.templateRevision), 'input proof cannot consume an unobserved future template')
  else assert.equal(proof.consumedInput.templateRevision, state.templateRevision)
  assert.deepEqual(proof.consumedInput.viewport, state.viewport); assert.equal(proof.surfaceGeneration, state.surfaceGeneration)
  assert.equal(proof.publication.kind, status.owner.transportBackend)
  return proof
}
function assertSameRuntime(baseline, status, app) {
  assert.deepEqual(status.runtimeOwner, baseline.status.runtimeOwner, 'Presenter changes must keep the exact original runtime owner')
  assert.equal(app.fixture, FIXTURE.id); assert.equal(app.launches, 1); assert.equal(app.token, baseline.app.token)
  assert.equal(app.storedToken, app.token); assert.equal(app.timer, baseline.app.timer)
  assert.ok(app.ticks >= baseline.app.ticks, 'The original AppService interval must remain monotonic')
  assert.equal(app.trace.filter(item => item.kind === 'launch').length, 1)
}
function assertNextPresenter(previous, next) {
  assert.ok(BigInt(next.presenterBinding.generation) > BigInt(previous.presenterBinding.generation), 'A new family needs a later native presenter generation')
  assert.ok(BigInt(next.observation.state.inputLifetimeRevision) > BigInt(previous.observation.state.inputLifetimeRevision), 'A retired family needs a later input lifetime')
  assert.notEqual(next.owner.transportBackend, previous.owner.transportBackend)
}

// This function is self-contained because Playwright executes it in the page.
// module.call is a real application turn: it can overlap onReady/setData, drain
// queued effects and publish a newer observation before its response resolves.
// Retain its business result, then observe presentation passively. Never poll
// application code while waiting for the presenter to catch up.
export async function sampleSettledAppState({moduleId, route, count, resizeCount, timeoutMs = 30_000, pollMs = 40}, dependencies = {}) {
  const session = dependencies.session ?? globalThis.weapp
  const now = dependencies.now ?? Date.now
  const wait = dependencies.wait ?? (milliseconds => new Promise(done => setTimeout(done, milliseconds)))
  if (!session || typeof session.request !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid settled application sampler')
  const deadline = now() + timeoutMs
  const identity = status => {
    const state = status?.observation?.state, owner = status?.runtimeOwner, binding = status?.presenterBinding
    return JSON.stringify([owner?.workerEpoch, owner?.sessionId, owner?.packSha256,
      state?.currentPage?.pageId, state?.currentPage?.path, state?.rendererProfile, state?.surfaceGeneration,
      state?.viewport, binding?.sessionId, binding?.generation, binding?.transportBackend])
  }
  const progress = status => JSON.stringify([identity(status), status?.observation?.sequence,
    status?.observation?.state?.templateRevision])
  const settled = status => {
    const state = status?.observation?.state, accepted = status?.presentation?.accepted
    return status?.phase === 'ready' && status.runtimeReady === true && status.inputEnabled === true
      && accepted?.inputEnabled === true && !status.presenterTransition && state?.transitionRequired === false
      && state.currentPage?.path === route && accepted.proof?.consumedInput?.routePath === route
      && accepted.proof.consumedInput.templateRevision === state.templateRevision
  }
  let retained = null, awaitingProgress = null
  for (;;) {
    if (now() >= deadline) throw new Error(`ERR_TIMEOUT: exact accepted application snapshot for ${route} did not settle`)
    const status = session.status
    if (retained && identity(status) !== retained.identity) retained = null
    if (retained && settled(status)) return {status, app:retained.app}
    if (retained || !settled(status) || awaitingProgress === progress(status)) {
      await wait(Math.min(pollMs, Math.max(1, deadline - now())))
      continue
    }
    const beforeIdentity = identity(status), beforeProgress = progress(status)
    const value = await session.request('module.call', {moduleId, export:'dualRendererSmokeState', args:[]})
    if (value?.ok !== true || value.result?.length !== 1) throw new Error('Real fixture module.call failed')
    const app = value.result[0], current = app?.pages?.at(-1)
    // A response from a retired page cannot be paired with a new page's proof,
    // even when both instances use the same route. Wait for that owner to settle
    // before reading its business state once.
    if (identity(session.status) !== beforeIdentity) { awaitingProgress = null; continue }
    if (current?.route === route && current.ready === true
      && (count === undefined || current.count === count) && (resizeCount === undefined || current.resizeCount === resizeCount)) {
      retained = {identity:beforeIdentity, app}
      awaitingProgress = null
    } else awaitingProgress = beforeProgress
  }
}

/** One independently built static product, one page and one real Worker.
 * Source/unit contracts are not promoted to native stale-RPC browser evidence. */
export async function runDualRendererBrowserSmoke(input, { chromium, parseModule, signal = input.signal } = {}) {
  const options = parseArgs(['--site-dir', input.siteDir, '--index-sha256', input.indexSha256,
    ...(input.expectedSourceCommit ? ['--expected-source-commit', input.expectedSourceCommit] : []), '--out-dir', input.outDir])
  const out = options.outDir
  await mkdir(out, {recursive: false})
  const report = {schemaVersion: 1, status: 'running', scope: 'actual-one-Worker-DOM-Skia-DOM-static-product-smoke',
    headless: true, environment: {platform:process.platform, arch:process.arch, versions:process.versions}, startedAt: new Date().toISOString(), scenarios: [], requests: [], forbiddenRequests: [], workers: [], cleanup: {},
    acceptance: {sameWorkerRuntime: 'not-run', realInteractions: 'not-run', acceptedPresentations: 'not-run',
      staleDetachedInput: 'not-run', publicOwnerControls: 'not-run', nativeStaleRpc: 'blocked', gpuHardware: 'unknown', performance: 'not-run'},
    limitations: ['QuickJS and one installed headless Chromium; no official DevTools, other host or near-parity result.',
      'Visible screenshot and genuine ACK proof establish browser presentation, not physical GPU completion or performance.',
      'Public view.* requests are owner-only and rejected before transport. Their rejection is not a stale native ACK/input generation test.',
      'Detached-surface event checks prove disposal behavior only. Exact old-binding native RPC/ACK rejection remains a separate source/native contract gate.']}
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n')
  let browser, context, page, server, origin, site, cancelledPageClose, cleanupFailed = false
  const workerHandles = [], pageErrors = [], consoleMessages = [], sockets = new Set()
  let stage = 'preflight'
  const clean = async (name, action) => {
    try { report.cleanup[name] = await action() }
    catch (error) { cleanupFailed = true; report.cleanup[name + 'Error'] = error.stack || String(error)
      if (error.timeoutCleanup) (report.cleanup.timeoutPageAttempts ??= []).push(error.timeoutCleanup) }
  }
  const onAbort = () => {
    report.cancellation ??= {reason: String(signal.reason?.message ?? signal.reason ?? 'aborted'), receivedAt: new Date().toISOString()}
    if (page && !page.isClosed() && !cancelledPageClose) cancelledPageClose = Promise.resolve().then(() => page.close({runBeforeUnload: false}))
      .then(() => { report.cleanup.cancelledPageClosed = page.isClosed(); assert.ok(page.isClosed()) })
      .catch(error => { cleanupFailed = true; report.cleanup.cancelledPageCloseError = error.stack || String(error) })
  }
  const checkCancelled = () => { if (signal?.aborted) { onAbort(); fail(`ERR_CANCELLED: ${report.cancellation.reason}`) } }
  signal?.addEventListener('abort', onAbort)
  try {
    checkCancelled()
    site = await inspectMixedProductSite(options.siteDir, {expectedIndexSha256: options.indexSha256, expectedSourceCommit: options.expectedSourceCommit, parseModule})
    await save('site-provenance.json', site.provenance); await save('site-inventory.json', site.inventory)
    await save('fixture-source-inventory.json', site.fixtureInputs)
    const harnessFiles = ['scripts/worker-dual-renderer-browser-smoke.mjs', 'scripts/worker-product-browser-smoke.mjs',
      'scripts/fixtures/worker-dual-renderer/pack.mjs', 'scripts/fixtures/worker-dual-renderer/startup-intent.json']
    report.harness = []
    for (const path of harnessFiles) {
      const bytes = await regularBytes(ROOT, path, 256 * 1024)
      const retained = `harness/${path}`; await mkdir(dirname(resolve(out, retained)), {recursive: true}); await writeFile(resolve(out, retained), bytes)
      report.harness.push({path, retained, sha256: digest(bytes), size: bytes.length})
    }
    if (!chromium) {
      const modulePath = process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || resolve(ROOT, 'vendor/weapp-vite/node_modules/playwright/index.mjs')
      try { ({chromium} = await import(pathToFileURL(resolve(modulePath)).href)) }
      catch (error) { fail(`ERR_TEST_INFRASTRUCTURE: installed Playwright unavailable: ${error.message}`) }
    }
    checkCancelled()
    server = createServer((request, response) => {
      const decision = classifyRequest(new URL(request.url, origin).href, {origin, allowed: site.allowed, profile: 'skia', method: request.method})
      const fact = {stage, method: request.method, url: request.url, ...decision}; report.requests.push(fact)
      if (!decision.allowed || !decision.path) { report.forbiddenRequests.push({...fact, layer: 'server'}); response.writeHead(403).end(); return }
      if (decision.path === 'favicon.ico') { response.writeHead(204, {'Cache-Control': 'no-store'}).end(); return }
      const bytes = site.files.get(decision.path)
      const mime = {'.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.json':'application/json', '.wasm':'application/wasm', '.ttf':'font/ttf'}[extname(decision.path)] || 'application/octet-stream'
      response.writeHead(200, {'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': bytes.length}).end(bytes)
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`
    report.url = origin + '/'
    browser = await chromium.launch({headless: true, handleSIGINT: false, handleSIGTERM: false})
    checkCancelled(); report.browserVersion = browser.version()
    context = await browser.newContext({viewport: {width: 1100, height: 1000}, deviceScaleFactor: 1, serviceWorkers: 'block'})
    checkCancelled(); await context.addInitScript(installWindowWasmAudit)
    await context.route('**/*', async route => {
      const request = route.request(), decision = classifyRequest(request.url(), {origin, allowed: site.allowed, profile: 'skia', method: request.method()})
      if (!decision.allowed) { report.forbiddenRequests.push({stage, url: request.url(), method: request.method(), layer:'browser', ...decision}); await route.abort('blockedbyclient'); return }
      await route.continue()
    })
    assert.equal(typeof context.routeWebSocket, 'function', 'ERR_TEST_INFRASTRUCTURE: scoped WebSocket interception is required')
    await context.routeWebSocket('**/*', async socket => {
      report.forbiddenRequests.push({stage, url: socket.url(), layer:'websocket', reason:'static-product-prohibits-sockets'})
      await socket.close({code:1008, reason:'Static product permits no business sockets'})
    })
    page = await context.newPage(); page.setDefaultTimeout(30_000)
    page.on('popup', popup => { report.forbiddenRequests.push({stage, url:popup.url(), layer:'popup', reason:'one-owned-page-only'}) })
    page.on('pageerror', error => pageErrors.push({stage, error:error.stack || String(error)}))
    page.on('console', message => { consoleMessages.push({stage, type:message.type(), text:message.text()}); if (consoleMessages.length > 128) consoleMessages.shift() })
    page.on('worker', worker => {
      const fact = {url:worker.url(), createdAt:new Date().toISOString(), closed:false}
      report.workers.push(fact); workerHandles.push(worker)
      worker.on('close', () => { fact.closed = true; fact.closedAt = new Date().toISOString() })
    })
    const evaluate = (fn, arg) => withPageDeadline(page, () => page.evaluate(fn, arg), {label:`${stage} evaluation`})
    const readApp = () => evaluate(async moduleId => {
      const value = await window.weapp.request('module.call', {moduleId, export:'dualRendererSmokeState', args:[]})
      if (value?.ok !== true || value.result?.length !== 1) throw new Error('Real fixture module.call failed')
      return value.result[0]
    }, site.moduleId)
    const waitReady = async (route, {count, resizeCount} = {}) => {
      const {status, app} = await evaluate(sampleSettledAppState, {moduleId:site.moduleId, route, count, resizeCount})
      assertAccepted(status, route, stage)
      assert.equal(report.workers.length, 1, 'No replacement or extra Worker is allowed during a presenter transaction')
      assert.equal(report.workers[0].closed, false)
      return {status, app}
    }
    const surface = () => page.locator('#surface-root canvas, #surface-root iframe')
    const capture = async name => {
      assert.equal(await surface().count(), 1)
      const png = await surface().screenshot({path:resolve(out, name + '.png')}), pixels = screenshotPixels(png)
      return {pngSha256:digest(png), rgbaSha256:pixels.sha256, width:pixels.width, height:pixels.height, pixels}
    }
    const sample = (pixels, point, viewport) => {
      const x = Math.floor(point.x * pixels.width / viewport.width), y = Math.floor(point.y * pixels.height / viewport.height)
      return Array.from(pixels.rgba.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4))
    }
    const clickSkia = async name => {
      const canvas = page.locator('#surface-root [data-worker-web-session] canvas'), box = await canvas.boundingBox()
      const status = await evaluate(() => window.weapp.status), viewport = status.observation.state.viewport, point = FIXTURE.buttons[name]
      assert.ok(box?.width > 0 && box.height > 0)
      const browserPoint = {x:box.x + point.x * box.width / viewport.width, y:box.y + point.y * box.height / viewport.height}
      await page.mouse.click(browserPoint.x, browserPoint.y)
      return {logical:point, browser:browserPoint, box, viewport}
    }
    const domFrame = () => page.frameLocator('iframe[title="Weapp Container DOM surface"]')
    const remember = async kind => evaluate(kind => {
      const surface = kind === 'dom' ? document.querySelector('#surface-root iframe') : document.querySelector('#surface-root canvas')
      const node = kind === 'dom' ? surface?.contentDocument?.querySelector('#increment') : surface
      if (!node) throw new Error('Old real surface to retain is absent')
      window.__dualRendererSmokeDetached = {surface, node, kind}
      return {kind, connected:surface.isConnected}
    }, kind)
    const assertDetachedInput = async before => {
      const attempted = await evaluate(() => {
        const old = window.__dualRendererSmokeDetached
        if (!old || old.surface.isConnected) throw new Error('Old presenter surface was not removed')
        if (old.kind === 'dom') old.node.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:100, clientY:102}))
        else {
          old.node.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerId:73, pointerType:'mouse', clientX:100, clientY:102, button:0, buttons:1}))
          old.node.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, pointerId:73, pointerType:'mouse', clientX:100, clientY:102, button:0, buttons:0}))
        }
        return {kind:old.kind, surfaceConnected:old.surface.isConnected, nodeConnected:old.node.isConnected,
          scope:'detached local event-listener disposal; not native generation rejection'}
      })
      // Two real rendering turns let any improperly retained asynchronous input
      // reach the Worker before asserting counters. This is no timing gate.
      await evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      const after = await readApp()
      assert.equal(after.storedTaps, before.app.storedTaps, 'A detached old surface still dispatched business input')
      assert.deepEqual(after.pages, before.app.pages, 'Detached old input changed current page state')
      return {attempted, beforeStoredTaps:before.app.storedTaps, afterStoredTaps:after.storedTaps}
    }
    // Exactly one navigation of the containing document. All following route
    // changes originate in real fixture wx handlers inside the original Worker.
    stage = '1-initial-dom'
    await page.goto(origin + '/', {waitUntil:'load', timeout:30_000})
    await page.waitForFunction(() => window.weappReady && window.weappPresented)
    const ready = await evaluate(() => window.weappReady), first = await evaluate(() => window.weappPresented)
    assert.equal(ready.runtimeReady, true); assert.equal(ready.loadResult.capabilities.quickjs, true)
    let current = await waitReady('pages/dom/index', {count:0, resizeCount:0}), baseline = current
    assert.equal(current.status.runtimeOwner.packSha256, options.indexSha256)
    assertSameRuntime(baseline, current.status, current.app)
    assert.equal(current.app.launches, 1); assert.equal(current.app.instances.length, 1)
    assert.equal(current.app.pages[0].readyCount, 1)
    assert.equal(report.workers[0].url, origin + '/runtime-worker.mjs')
    const workerRealm = await withPageDeadline(page, () => workerHandles[0].evaluate(() => ({constructor:self.constructor.name,
      dedicated:typeof DedicatedWorkerGlobalScope === 'function' && self instanceof DedicatedWorkerGlobalScope,
      hasDocument:typeof document !== 'undefined', name:self.name})), {label:'original Worker realm'})
    assert.equal(workerRealm.dedicated, true); assert.equal(workerRealm.hasDocument, false)
    assert.equal(workerRealm.name, `container-${current.status.runtimeOwner.workerEpoch}`)
    await evaluate(() => {
      window.__dualRendererSmokeSamples = []; window.__dualRendererSmokeSampling = true
      const sample = () => {
        if (!window.__dualRendererSmokeSampling) return
        const status = window.weapp.status
        const rows = window.__dualRendererSmokeSamples
        if (rows.length >= 2048) { window.__dualRendererSmokeOverflow = true; return }
        rows.push({status, now:performance.now()}); requestAnimationFrame(sample)
      }; requestAnimationFrame(sample)
    })
    assert.equal(await domFrame().locator('#count').textContent(), 'Count: 0')
    const domBefore = await capture('01-dom-before')
    await domFrame().locator('#increment').click()
    current = await waitReady('pages/dom/index', {count:1})
    const domAfter = await capture('01-dom-after')
    assert.notEqual(domBefore.rgbaSha256, domAfter.rgbaSha256); assert.equal(current.app.storedTaps, 1)
    assert.equal(await domFrame().locator('#count').textContent(), 'Count: 1')
    const originalDomInstance = current.app.pages[0].instance, originalDomPageId = current.status.observation.state.currentPage.pageId
    report.scenarios.push({name:stage, status:'passed', ready, first, workerRealm, state:current,
      pixels:{before:domBefore.rgbaSha256, after:domAfter.rgbaSha256}})

    stage = '2-dom-to-skia'
    const previousDom = current
    await remember('dom'); await domFrame().locator('#to-skia').click()
    current = await waitReady('pages/skia/index', {count:0, resizeCount:0})
    assertSameRuntime(baseline, current.status, current.app); assertNextPresenter(previousDom.status, current.status)
    assert.equal(current.app.pages.length, 2); assert.equal(current.app.pages[0].instance, originalDomInstance)
    const detachedDom = await assertDetachedInput(current)
    const canvas = page.locator('#surface-root [data-worker-web-session] canvas')
    const webgl = await canvas.evaluate(canvas => {
      const gl = canvas.getContext('webgl2')
      if (!gl || gl.isContextLost()) throw new Error('Actual CanvasKit presenter has no live WebGL2 context')
      const extension = gl.getExtension('WEBGL_debug_renderer_info')
      return {webgl2:true, width:canvas.width, height:canvas.height, vendor:gl.getParameter(gl.VENDOR), renderer:gl.getParameter(gl.RENDERER),
        unmaskedVendor:extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer:extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
        physicalHardware:'unknown', gpuCompletion:'unknown'}
    })
    const skiaBefore = await capture('02-skia-before')
    assert.deepEqual(sample(skiaBefore.pixels, FIXTURE.feedback, current.status.observation.state.viewport), FIXTURE.before)
    const pointer = await clickSkia('increment')
    current = await waitReady('pages/skia/index', {count:1})
    const skiaAfter = await capture('02-skia-after')
    assert.deepEqual(sample(skiaAfter.pixels, FIXTURE.feedback, current.status.observation.state.viewport), FIXTURE.after)
    assert.notEqual(skiaBefore.rgbaSha256, skiaAfter.rgbaSha256); assert.equal(current.app.storedTaps, 2)
    report.scenarios.push({name:stage, status:'passed', previousStatus:previousDom.status, state:current, detachedDom, webgl, pointer,
      pixels:{before:skiaBefore.rgbaSha256, after:skiaAfter.rgbaSha256}})

    stage = '3-skia-back-to-preserved-dom'
    const previousSkia = current
    await remember('skia'); const backPointer = await clickSkia('back')
    current = await waitReady('pages/dom/index', {count:1})
    assertSameRuntime(baseline, current.status, current.app); assertNextPresenter(previousSkia.status, current.status)
    assert.equal(current.status.observation.state.currentPage.pageId, originalDomPageId)
    assert.equal(current.app.pages.length, 1); assert.equal(current.app.pages[0].instance, originalDomInstance)
    assert.equal(current.app.pages[0].readyCount, 1, 'Returning to a preserved page must not repeat onReady')
    const detachedSkia = await assertDetachedInput(current)
    await domFrame().locator('#increment').click(); current = await waitReady('pages/dom/index', {count:2})
    assert.equal(current.app.storedTaps, 3); assert.equal(current.app.instances.length, 2)
    await capture('03-preserved-dom')
    report.scenarios.push({name:stage, status:'passed', previousStatus:previousSkia.status, state:current, detachedSkia, backPointer})

    stage = '4-resize-and-redirect-to-new-dom'
    const previousDomAgain = current
    await domFrame().locator('#to-skia').click(); current = await waitReady('pages/skia/index', {count:0})
    assertNextPresenter(previousDomAgain.status, current.status)
    const beforeResize = current
    await evaluate(() => window.weapp.setLogicalViewport({width:400, height:700}))
    current = await waitReady('pages/skia/index', {count:0, resizeCount:1})
    assertSameRuntime(baseline, current.status, current.app)
    assert.deepEqual(current.status.presenterBinding, beforeResize.status.presenterBinding, 'Resize keeps the same presenter family generation')
    assert.ok(BigInt(current.status.observation.state.surfaceGeneration) > BigInt(beforeResize.status.observation.state.surfaceGeneration))
    assert.equal(current.app.pages.at(-1).width, 400); assert.equal(current.app.pages.at(-1).height, 700)
    const resized = current
    await evaluate(() => window.weapp.setRenderScale(2))
    await page.waitForFunction(attempt => {
      const status = window.weapp.status, canvas = document.querySelector('#surface-root canvas')
      return status.inputEnabled && status.presentation?.accepted?.proof.attemptId !== attempt && canvas?.width === 800 && canvas.height === 1400
    }, resized.status.presentation.accepted.proof.attemptId)
    current = await waitReady('pages/skia/index', {count:0, resizeCount:1})
    assert.equal(current.status.observation.state.templateRevision, resized.status.observation.state.templateRevision)
    const density = current.status, densityPointer = await clickSkia('increment')
    current = await waitReady('pages/skia/index', {count:1, resizeCount:1}); assert.equal(current.app.storedTaps, 4)
    await capture('04-resized-skia')
    // Ownership rejection is deliberately reported separately from native
    // old-binding admission. The public API never transports these operations.
    const ownerControls = await evaluate(async oldProof => {
      const results = []
      for (const op of ['view.events', 'view.presented']) {
        try { await window.weapp.request(op, {version:'1.0', key:oldProof.publication.key, staleProof:oldProof}); results.push({op, accepted:true}) }
        catch (error) { results.push({op, code:error.code, message:error.message, scope:'public-owner-only-rejection-before-transport'}) }
      }
      return results
    }, previousDom.status.presentation.accepted.proof)
    for (const result of ownerControls) { assert.equal(result.accepted, undefined); assert.equal(result.code, 'ERR_PROTOCOL_VERSION') }
    const beforeRedirect = current
    await remember('skia'); const redirectPointer = await clickSkia('return')
    current = await waitReady('pages/return/index', {count:0})
    assertSameRuntime(baseline, current.status, current.app); assertNextPresenter(beforeRedirect.status, current.status)
    assert.equal(current.app.pages.length, 2); assert.equal(current.app.pages[0].instance, originalDomInstance)
    assert.notEqual(current.app.pages.at(-1).instance, originalDomInstance); assert.equal(current.app.pages.at(-1).readyCount, 1)
    const detachedAfterResize = await assertDetachedInput(current)
    await domFrame().locator('#increment').click(); current = await waitReady('pages/return/index', {count:1})
    assert.equal(current.app.storedTaps, 5); assert.equal(current.app.instances.length, 4)
    assert.ok(current.app.ticks > baseline.app.ticks, 'The same AppService timer must advance across both family directions')
    assert.equal(current.app.trace.filter(item => item.kind === 'ready' && item.page === 'pages/dom/index').length, 1)
    assert.equal(current.app.trace.filter(item => item.kind === 'unload' && item.page === 'pages/skia/index').length, 2)
    await capture('04-new-return-dom')
    report.scenarios.push({name:stage, status:'passed', beforeResize, resized, density, densityPointer, ownerControls,
      beforeRedirectStatus:beforeRedirect.status, state:current, detachedAfterResize, redirectPointer,
      densityExpressionReplayIndependentlyMeasured:false, nativeStaleRpc:{status:'blocked', reason:'No public product old-binding RPC/ACK injector; low-level native/source contract remains independent'}})

    stage = '5-original-owner-close'
    const samples = await evaluate(() => { window.__dualRendererSmokeSampling = false; return {overflow:!!window.__dualRendererSmokeOverflow, rows:window.__dualRendererSmokeSamples} })
    assert.equal(samples.overflow, false, 'Presentation sample evidence exceeded its finite budget')
    for (const row of samples.rows) {
      assert.deepEqual(row.status.runtimeOwner, baseline.status.runtimeOwner)
      if (row.status.inputEnabled) assertAccepted(row.status, row.status.observation.state.currentPage.path, 'sampled input authority', {allowPendingTemplate:true})
    }
    await save('presentation-observations.json', samples)
    const wasmAudit = await evaluate(() => window.__workerProductWasmAudit)
    assert.equal(wasmAudit.installed, true); assert.deepEqual(wasmAudit.violations, [])
    assert.ok(wasmAudit.calls.some(call => call.exportCount > 0), 'Actual drawing WASM was not observed on Window')
    assert.equal(await page.locator('#error').isVisible(), false)
    const diagnosticTrace = await evaluate(() => ({trace:window.weappTrace, stats:window.weappTraceStats}))
    await save('lossy-ui-trace.json', diagnosticTrace)
    await page.screenshot({path:resolve(out,'final-page.png'), fullPage:true})
    const closed = await evaluate(async () => {
      delete window.__dualRendererSmokeDetached
      const first = window.weapp.close(), second = window.weapp.close(), stable = first === second
      const result = await first, entryFirst = window.weappClose(), entrySecond = window.weappClose(); await entryFirst
      return {stable, entryStable:entryFirst === entrySecond, result, status:window.weapp.status,
        ownedMounts:document.querySelectorAll('#surface-root [data-worker-web-session]').length,
        ownedSurfaces:document.querySelectorAll('#surface-root canvas, #surface-root iframe').length}
    })
    assert.equal(closed.stable, true); assert.equal(closed.entryStable, true)
    assert.equal(closed.result.closed, true); assert.equal(closed.result.workerClosed, true); assert.equal(closed.result.ownedMountRemoved, true)
    assert.equal(closed.status.phase, 'closed'); assert.equal(closed.status.inputEnabled, false)
    assert.equal(closed.ownedMounts, 0); assert.equal(closed.ownedSurfaces, 0)
    assert.equal(closed.status.presentation?.inFlight ?? false, false); assert.equal(closed.status.presentation?.hasRaf ?? false, false)
    const deadline = Date.now() + 5_000
    while (report.workers.some(worker => !worker.closed) && Date.now() < deadline) { checkCancelled(); await new Promise(done => setTimeout(done,20)) }
    assert.equal(report.workers.length,1); assert.ok(report.workers[0].closed, 'Actual original Worker close was not observed')
    report.scenarios.push({name:stage, status:'passed', closed, wasmAudit, observationSamples:samples.rows.length})
    assert.equal(context.pages().length, 1, 'The fixture must not open additional pages')
    assert.deepEqual(report.forbiddenRequests, []); assert.deepEqual(pageErrors, [])
    checkCancelled()
    for (const key of ['sameWorkerRuntime','realInteractions','acceptedPresentations','staleDetachedInput','publicOwnerControls']) report.acceptance[key] = 'passed'
    report.status = 'passed'
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : /ERR_TEST_INFRASTRUCTURE/.test(error.message) ? 'blocked' : 'failed'
    report.failedStage = stage; report.error = error.stack || String(error)
    if (error.timeoutCleanup) (report.cleanup.timeoutPageAttempts ??= []).push(error.timeoutCleanup)
    if (!signal?.aborted && page && !page.isClosed()) try {
      report.failureState = await withPageDeadline(page, () => page.evaluate(() => ({status:window.weapp?.status,
        error:document.querySelector('#error')?.textContent, trace:window.weappTrace, wasmAudit:window.__workerProductWasmAudit})), {timeoutMs:5_000,label:'failure state'})
      await page.screenshot({path:resolve(out,'failure.png'),fullPage:true,timeout:5_000})
    } catch (failure) { report.failureCaptureError = failure.stack || String(failure) }
  } finally {
    if (signal?.aborted) onAbort()
    if (cancelledPageClose) await cancelledPageClose
    if (page && !page.isClosed() && !signal?.aborted) await clean('runtime', async () => withPageDeadline(page,
      () => page.evaluate(async () => window.weappClose ? window.weappClose() : window.weapp?.close()), {timeoutMs:10_000,label:'owned runtime final cleanup'}))
    if (page && !page.isClosed()) await clean('pageClosed', async () => { await page.close({runBeforeUnload:false}); return page.isClosed() })
    if (context) await clean('contextClosed', async () => { await context.close(); return true })
    if (browser) await clean('browserClosed', async () => { await browser.close(); return !browser.isConnected() })
    await clean('workersClosed', async () => { assert.ok(report.workers.every(worker => worker.closed), 'An owned Worker close was not observed'); return {created:report.workers.length, closed:report.workers.filter(worker => worker.closed).length} })
    if (server?.listening) await clean('serverClosed', async () => {
      // Only this run's sockets are reachable here. Destroying a lingering
      // keepalive prevents close() from hanging and never targets another task.
      for (const socket of sockets) socket.destroy()
      await new Promise((done,reject) => server.close(error => error ? reject(error) : done())); return !server.listening
    })
    signal?.removeEventListener('abort', onAbort)
    if (report.cleanup.timeoutPageAttempts?.some(attempt => attempt.status !== 'closed')) cleanupFailed = true
    if (cleanupFailed) report.status = 'failed'; else if (signal?.aborted) report.status = 'cancelled'
    report.pageErrors = pageErrors; report.consoleMessages = consoleMessages; report.finishedAt = new Date().toISOString()
    await save('execution.json', report)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), interrupted = name => () => {
    if (!controller.signal.aborted) controller.abort(Object.assign(new Error(`Received ${name}`), {signalName:name}))
  }
  const onInterrupt = interrupted('SIGINT'), onTerminate = interrupted('SIGTERM')
  process.on('SIGINT',onInterrupt); process.on('SIGTERM',onTerminate)
  try {
    const report = await runDualRendererBrowserSmoke(parseArgs(process.argv.slice(2)), {signal:controller.signal})
    console.log(JSON.stringify({status:report.status, acceptance:report.acceptance, error:report.error, cleanup:report.cleanup}))
    if (report.status !== 'passed') process.exitCode = report.status === 'cancelled' ? controller.signal.reason?.signalName === 'SIGTERM' ? 143 : 130 : 1
  } catch (error) { console.error(error.stack || String(error)); process.exitCode = 1 }
  finally { process.removeListener('SIGINT',onInterrupt); process.removeListener('SIGTERM',onTerminate) }
}
