import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { packContainer } from '../tools/container-manifest/src/index.mjs'
import { GLUE_REQUIRED_METHODS, PORTABLE_PACK_VALIDATOR_FILES, WASM_REQUIRED_EXPORTS, WEB_SAMPLE_FILES,
  inventoryGeneratedPackage, rendererRuntimeConfig } from './build-web-wasm.mjs'
import { loadPinnedGeneratedModuleParser, verifyGeneratedModuleClosure,
  verifyRetainedGeneratedModuleParser } from './generated-package-closure.mjs'
import { BROWSER_RUNTIME_FILES, openBrowserRuntimeBundle, retainBrowserRuntimeBundle, stageBrowserPackGeneration } from './browser-dev-artifacts.mjs'
import { runBrowserDevArtifactCli, runBrowserDevArtifactRequest } from './browser-dev-artifacts-cli.mjs'

// Synthetic static fixtures only: no producer Cargo/bindgen, AppService,
// browser, GPU or dev watcher is executed by these contracts.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const put = async (root, path, bytes) => { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), bytes) }
const descriptor = (path, bytes) => ({ path, sha256: hash(bytes), size: bytes.length })
const exists = async path => { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

function leb(value) {
  const bytes = []
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)) } while (value)
  return bytes
}
function exportedWasm() {
  const section = (id, value) => [id, ...leb(value.length), ...value]
  const exports = [...leb(WASM_REQUIRED_EXPORTS.length), ...WASM_REQUIRED_EXPORTS.flatMap(name => {
    const bytes = Buffer.from(name); return [...leb(bytes.length), ...bytes, 0, 0]
  })]
  return Buffer.from([0,97,115,109,1,0,0,0,
    ...section(1, [1,0x60,0,0]), ...section(3, [1,0]),
    ...section(7, exports), ...section(10, [1,2,0,0x0b])])
}

async function fixture(t, changes = {}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'browser-artifact-contract-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const site = resolve(root, 'producer'); await mkdir(site)
  const sourcePaths = [...new Set(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'scripts/build-web-wasm.mjs',
    'scripts/generated-package-closure.mjs', 'examples/hosts/web-wasm/renderer-dependency-pins.json',
    ...PORTABLE_PACK_VALIDATOR_FILES, ...WEB_SAMPLE_FILES.map(path => `examples/hosts/web-wasm/${path}`)])].sort()
  const sourceFiles = {}
  for (const path of sourcePaths) {
    let bytes = await readFile(resolve(ROOT, path))
    if (changes.source) bytes = changes.source(path, bytes, { root, site })
    await put(site, `source/${path}`, bytes); sourceFiles[path] = hash(bytes)
  }
  const browserFiles = []
  for (const path of WEB_SAMPLE_FILES) {
    const bytes = await readFile(resolve(site, 'source/examples/hosts/web-wasm', path))
    await put(site, path, bytes)
    browserFiles.push({ ...descriptor(path, bytes), sourcePath: `examples/hosts/web-wasm/${path}` })
  }
  const wasm = exportedWasm()
  const glue = Buffer.from("export const bytes = new URL('container_host_web_bg.wasm', import.meta.url);\nexport default function init(){}\nexport class WebWasmHost {}\n")
  await put(site, 'pkg/container_host_web_bg.wasm', wasm); await put(site, 'pkg/container_host_web.js', glue)
  const generated = await inventoryGeneratedPackage(site); generated.retainedStatus = 'passed'
  const parser = await loadPinnedGeneratedModuleParser({ root: ROOT, destination: resolve(site, 'validation/generated-module-parser') })
  const closure = await verifyGeneratedModuleClosure(site, generated, parser)
  await verifyRetainedGeneratedModuleParser(parser.provenance)
  const runtime = rendererRuntimeConfig('software'), runtimeBytes = json(runtime)
  await put(site, 'runtime-config.json', runtimeBytes)
  const report = { schemaVersion: 1, status: 'passed', buildStatus: 'passed', ready: true,
    plan: { execution: 'worker', renderer: 'software' },
    toolchain: { versions: Object.fromEntries(['cargo', 'rustc', 'rustdoc', 'clang', 'ar', 'wasmBindgen']
      .map(name => [name, `synthetic-${name}-receipt-not-a-build`])) },
    source: { status: 'passed', workingTreeDirty: false, sourceStable: true, sourceCommit: 'a'.repeat(40),
      sourceSha256: hash(JSON.stringify(sourceFiles)), sourceFiles, snapshotDirectory: resolve(site, 'source') },
    browserAssets: { status: 'passed', retainedStatus: 'passed', execution: 'worker', entry: 'index.html', entryModule: 'worker-app.mjs', files: browserFiles },
    generatedModuleParser: parser.provenance, generatedPackage: generated, generatedModuleClosure: closure,
    artifacts: { wasm: { path: 'pkg/container_host_web_bg.wasm', sha256: hash(wasm), bytes: wasm.length },
      glue: { path: 'pkg/container_host_web.js', sha256: hash(glue), bytes: glue.length,
        interface: { initializerType: 'function', hostType: 'function', methods: ['constructor', ...GLUE_REQUIRED_METHODS] } } },
    rendererDependencies: { status: 'passed', retainedStatus: 'passed', files: [], runtimeConfig: {
      path: 'runtime-config.json', sha256: hash(runtimeBytes), bytes: runtimeBytes.length, value: runtime } } }
  // Optional fixture variants are defined before their independent pin is
  // issued, not repaired/re-signed after a verifier rejects real evidence.
  changes.report?.(report)
  const reportBytes = json(report); await put(site, 'build-report.json', reportBytes)
  const expected = { reportSha256: hash(reportBytes), sourceCommit: report.source.sourceCommit,
    sourceSha256: report.source.sourceSha256, renderer: 'software' }
  const retain = (destination = resolve(root, 'runtime')) => retainBrowserRuntimeBundle({ builtSiteDirectory: site, destination, expected })
  return { root, site, expected, reportBytes, retain }
}

async function portable(t, root, name, { renderer = 'dom', stylesheet } = {}) {
  const input = resolve(root, `${name}-input`), pack = resolve(root, name)
  await cp(resolve(ROOT, 'fixtures/worker-product-browser'), input, { recursive: true })
  if (stylesheet) await writeFile(resolve(input, 'app.wxss'), stylesheet)
  await packContainer(input, pack, { compilerCommit: 'b'.repeat(40), project: input,
    configFile: renderer === 'dom' ? 'dom.container.config.json' : 'canvaskit.container.config.json' })
  const bytes = await readFile(resolve(pack, 'manifest.json')), manifest = JSON.parse(bytes)
  return { directory: pack, expected: { revision: name === 'pack-one' ? '1' : '2', manifestSha256: hash(bytes),
    integrityRoot: manifest.integrity.root, compilerCommit: manifest.compiler.commit, selectedRoute: manifest.routes[0].path } }
}
const token = { sourceRevision: '4', compilerReceiptSequence: '3' }

test('finite artifact job preserves independent pins and cannot return runtime readiness', async t => {
  const f = await fixture(t)
  const acquired = await runBrowserDevArtifactRequest({ schemaVersion: 1, requestId: 'acquire-runtime-1', op: 'retain-runtime',
    runtime: { builtSiteDirectory: f.site, destination: resolve(f.root, 'job-runtime'), expected: f.expected } })
  assert.equal(acquired.status, 'staged-static')
  assert.equal(acquired.runtimeReady, false); assert.equal(acquired.presentedReady, false)
  assert.ok(acquired.runtime.runtimeFiles.length > 0)
  assert.equal(acquired.runtime.provenance.appService, 'not-run')
  assert.deepEqual(acquired.runtime.producer, f.expected)
  await assert.rejects(runBrowserDevArtifactRequest({ schemaVersion: 1, requestId: 'bad-job', op: 'start-runtime', runtime: {} }), /Unknown artifact operation/)
})

test('file CLI stages one exact ticket and retains a bounded failure result without overwriting files', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const job = resolve(f.root, 'job'); await mkdir(job)
  const startupIntentJson = JSON.stringify({ schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    viewport: { width: 375, height: 667 }, rendererPolicy: { mode: 'manifest' } })
  const request = { schemaVersion: 1, requestId: 'stage-job-1', op: 'stage-pack',
    runtime: { directory: bundle.directory, expectedBundleSha256: bundle.descriptorSha256, expected: f.expected },
    stage: { packDirectory: pack.directory, destination: resolve(f.root, 'job-generation'),
      expected: { ...pack.expected, startupIntentSha256: hash(startupIntentJson) }, runId: 'run-job', siteId: '1',
      publicationToken: token, inputBindingSha256: '6'.repeat(64), startupIntentJson } }
  const input = resolve(job, 'request.json'), result = resolve(job, 'result.json')
  await writeFile(input, json(request))
  assert.deepEqual(await runBrowserDevArtifactCli(['--request', input, '--result', result]), { exitCode: 0 })
  const retained = await readFile(result), receipt = JSON.parse(retained)
  assert.equal(receipt.requestId, request.requestId)
  assert.equal(receipt.stage.descriptor.inputBindingSha256, request.stage.inputBindingSha256)
  assert.equal(receipt.runtimeReady, false); assert.equal(receipt.presentedReady, false)
  await assert.rejects(runBrowserDevArtifactCli(['--request', input, '--result', result]), /EEXIST/)
  assert.deepEqual(await readFile(result), retained)
  const failure = resolve(job, 'failed.json')
  await writeFile(input, json({ ...request, unexpected: true }))
  assert.deepEqual(await runBrowserDevArtifactCli(['--request', input, '--result', failure]), { exitCode: 1 })
  const rejected = JSON.parse(await readFile(failure))
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.runtimeReady, false)
  assert.equal(rejected.code, 'ERR_BROWSER_DEV_ARTIFACT')
  assert.equal(Buffer.byteLength(rejected.message) <= 2048, true)
})

test('an already-owned result is rejected before a second artifact destination is created', async t => {
  const f = await fixture(t), job = resolve(f.root, 'exclusive-result'); await mkdir(job)
  const input = resolve(job, 'request.json'), result = resolve(job, 'result.json'), destination = resolve(f.root, 'must-not-stage')
  await writeFile(input, json({ schemaVersion: 1, requestId: 'exclusive-result-1', op: 'retain-runtime',
    runtime: { builtSiteDirectory: f.site, destination, expected: f.expected } }))
  await writeFile(result, 'existing receipt')
  await assert.rejects(runBrowserDevArtifactCli(['--request', input, '--result', result]), /EEXIST/)
  assert.equal(await exists(destination), false)
  assert.equal(await readFile(result, 'utf8'), 'existing receipt')
})

test('bound app staging echoes the exact ticket and separately pins actual startup JSON', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const startupIntentJson = JSON.stringify({ schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    viewport: { width: 390, height: 844 }, rendererPolicy: { mode: 'force', profile: 'webview' },
    route: 'pages/removed-request/index', data: { edited: true } })
  const inputBindingSha256 = '7'.repeat(64)
  const options = { runtimeBundle: bundle, packDirectory: pack.directory, destination: resolve(f.root, 'bound-generation'),
    expected: { ...pack.expected, startupIntentSha256: hash(startupIntentJson) }, runId: 'run-bound', siteId: '9',
    publicationToken: token, inputBindingSha256, startupIntentJson }
  await assert.rejects(stageBrowserPackGeneration({ ...options, expected: pack.expected }), /independent startup intent pin/)
  await assert.rejects(stageBrowserPackGeneration({ ...options,
    expected: { ...options.expected, startupIntentSha256: '0'.repeat(64) } }), /independent pin/)
  assert.equal(await exists(options.destination), false)
  const staged = await stageBrowserPackGeneration(options)
  assert.equal(staged.descriptor.inputBindingSha256, inputBindingSha256)
  assert.equal(staged.descriptor.startupIntentSha256, hash(startupIntentJson))
  const jsonDescriptor = staged.descriptor.startupJson, jsonBytes = await readFile(resolve(staged.directory, jsonDescriptor.path))
  assert.equal(hash(jsonBytes), jsonDescriptor.sha256)
  assert.notEqual(jsonDescriptor.sha256, staged.descriptor.productConfig.sha256)
  assert.equal(JSON.parse(jsonBytes).data.edited, true)
  assert.equal(JSON.parse(jsonBytes).viewport.width, 390)
  assert.equal(JSON.parse(jsonBytes).route, pack.expected.selectedRoute)
  assert.equal(staged.descriptor.requestedRoute, 'pages/removed-request/index')
  assert.equal(staged.descriptor.selectedRoute, pack.expected.selectedRoute)
  assert.equal(staged.descriptor.admission.requiresCanvasKit, false)
  assert.equal(staged.descriptor.publication, 'not-authorized')
})

test('private child failure messages fit the Rust UTF-8 diagnostic byte boundary', async t => {
  const f = await fixture(t), job = resolve(f.root, 'utf8-job'); await mkdir(job)
  const input = resolve(job, 'request.json'), result = resolve(job, 'result.json')
  await writeFile(input, json({ schemaVersion: 1, requestId: 'unicode-failure', op: 'retain-runtime',
    runtime: { builtSiteDirectory: resolve(f.root, '测'.repeat(4096)), destination: resolve(f.root, 'never-retained'), expected: f.expected } }))
  assert.deepEqual(await runBrowserDevArtifactCli(['--request', input, '--result', result]), { exitCode: 1 })
  const failure = JSON.parse(await readFile(result))
  assert.ok(failure.message.length > 0)
  assert.ok(Buffer.byteLength(failure.message) <= 2048)
  assert.equal(failure.runtimeReady, false)
})

test('forced renderer admission requires real pinned drawing assets before offering a site', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const startupIntentJson = JSON.stringify({ schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    viewport: { width: 375, height: 667 }, rendererPolicy: { mode: 'force', profile: 'skia' } })
  const target = resolve(f.root, 'forced-skia')
  await assert.rejects(stageBrowserPackGeneration({ runtimeBundle: bundle, packDirectory: pack.directory, destination: target,
    expected: pack.expected, runId: 'run-force', siteId: '1', publicationToken: token, startupIntentJson }), /requires CanvasKit/)
  assert.equal(await exists(target), false)
})

test('runtime retention requires independent exact producer pins', async t => {
  const f = await fixture(t)
  await assert.rejects(retainBrowserRuntimeBundle({ builtSiteDirectory: f.site, destination: resolve(f.root, 'missing') }), /Independent exact/)
  await assert.rejects(retainBrowserRuntimeBundle({ builtSiteDirectory: f.site, destination: resolve(f.root, 'wrong'),
    expected: { ...f.expected, reportSha256: '0'.repeat(64) } }), /report pin mismatch/)
  assert.equal(await exists(resolve(f.root, 'wrong')), false)
})

test('runtime handle preserves producer bytes and exposes only copied serve resources', async t => {
  const f = await fixture(t), bundle = await f.retain()
  assert.deepEqual(await readFile(resolve(bundle.directory, 'build-report.json')), f.reportBytes)
  assert.equal(bundle.provenance.appService, 'not-run'); assert.equal(bundle.provenance.presentation, 'not-run')
  for (const path of ['app.mjs', 'legacy.html', 'index.html', 'worker-app.mjs', 'build-report.json', 'source/Cargo.toml'])
    assert.throws(() => bundle.copyRuntimeFile(path), /serve allowlist/)
  assert.ok(BROWSER_RUNTIME_FILES.includes('runtime-worker.mjs'))
  const a = bundle.copyRuntimeFile('runtime-worker.mjs'), first = a[0]; a[0] ^= 1
  assert.equal(bundle.copyRuntimeFile('runtime-worker.mjs')[0], first)
})

test('bundle re-open checks every retained file and independently pinned descriptor', async t => {
  const f = await fixture(t), bundle = await f.retain()
  const reopen = () => openBrowserRuntimeBundle({ directory: bundle.directory, expectedBundleSha256: bundle.descriptorSha256, expected: f.expected })
  assert.equal((await reopen()).bundleId, bundle.bundleId)
  await put(bundle.directory, 'pkg/extra.mjs', 'export const extra = 1;\n')
  await assert.rejects(reopen(), /closure changed/)
})

test('old report flags or dirty/legacy producer variants are not reusable runtime evidence', async t => {
  for (const variant of [report => { report.plan.execution = 'legacy' }, report => { report.source.workingTreeDirty = true },
    report => { report.generatedPackage.retainedStatus = 'not-run' }, report => { report.generatedModuleParser.retainedStatus = 'not-run' }]) {
    const f = await fixture(t, { report: variant }); await assert.rejects(f.retain())
  }
})

test('mutated report, source, parser and generated glue are rejected with original pins intact', async t => {
  for (const path of ['build-report.json', 'source/Cargo.toml', 'validation/generated-module-parser/dist/acorn.mjs', 'pkg/container_host_web.js']) {
    const f = await fixture(t)
    await writeFile(resolve(f.site, path), Buffer.concat([await readFile(resolve(f.site, path)), Buffer.from('\ncorrupt')]))
    await assert.rejects(f.retain())
  }
})

test('runtime retention rejects extra pkg files, symlinks and overlapping output', async t => {
  const f = await fixture(t)
  await put(f.site, 'pkg/extra.mjs', 'export const extra = 1;\n')
  await assert.rejects(f.retain(), /closure changed/)
  await rm(resolve(f.site, 'pkg/extra.mjs'))
  await symlink(resolve(f.site, 'pkg/container_host_web.js'), resolve(f.site, 'pkg/linked.mjs'))
  await assert.rejects(f.retain(), /symlink|escaping/)
  await rm(resolve(f.site, 'pkg/linked.mjs'))
  await assert.rejects(f.retain(resolve(f.site, 'nested-bundle')), /separate directories/)
})

test('source and build report pins must both match the requested bundle source', async t => {
  const f = await fixture(t)
  await assert.rejects(retainBrowserRuntimeBundle({ builtSiteDirectory: f.site, destination: resolve(f.root, 'wrong-source'),
    expected: { ...f.expected, sourceSha256: '0'.repeat(64) } }))
  const bundle = await f.retain()
  await assert.rejects(openBrowserRuntimeBundle({ directory: bundle.directory, expectedBundleSha256: 'f'.repeat(64), expected: f.expected }), /descriptor pin/)
})

test('two app-only pack generations reuse one exact runtime without changing producer evidence', async t => {
  const f = await fixture(t), bundle = await f.retain(), first = await portable(t, f.root, 'pack-one')
  const second = await portable(t, f.root, 'pack-two', { stylesheet: 'page { background: #010203; }\n' })
  const stage = (pack, siteId) => stageBrowserPackGeneration({ runtimeBundle: bundle, packDirectory: pack.directory,
    destination: resolve(f.root, `generation-${siteId}`), expected: pack.expected, runId: 'run-contract', siteId, publicationToken: token })
  const one = await stage(first, '1'), two = await stage(second, '2')
  assert.equal(one.status, 'staged'); assert.equal(two.status, 'staged')
  assert.equal(one.descriptor.runtimeBundle.id, bundle.bundleId); assert.equal(two.descriptor.runtimeBundle.id, bundle.bundleId)
  assert.notEqual(one.descriptor.packIndex.sha256, two.descriptor.packIndex.sha256)
  assert.equal(two.descriptor.publication, 'not-authorized'); assert.equal(two.descriptor.runtime, 'not-run')
  assert.deepEqual(await readFile(resolve(bundle.directory, 'build-report.json')), f.reportBytes)
  assert.equal(await exists(resolve(two.directory, 'pkg')), false)
  assert.equal(await exists(resolve(two.directory, 'runtime-worker.mjs')), false)
})

test('pack generation validates exact decimal tokens without Number precision loss', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const options = { runtimeBundle: bundle, packDirectory: pack.directory, destination: resolve(f.root, 'generation'),
    expected: { ...pack.expected, revision: '18446744073709551615' }, runId: 'run-contract', siteId: '9007199254740993',
    publicationToken: { sourceRevision: '18446744073709551615', compilerReceiptSequence: '9007199254740993' } }
  const staged = await stageBrowserPackGeneration(options)
  assert.equal(staged.descriptor.siteId, options.siteId)
  assert.deepEqual(staged.descriptor.publicationToken, options.publicationToken)
  for (const bad of [1, '01', '-1', '18446744073709551616']) await assert.rejects(stageBrowserPackGeneration({ ...options,
    destination: resolve(f.root, `invalid-${String(bad)}`), publicationToken: { ...token, sourceRevision: bad } }), /exact decimal/)
})

test('wrong manifest or integrity root cannot leave a candidate generation', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  for (const field of ['manifestSha256', 'integrityRoot']) {
    const target = resolve(f.root, field)
    await assert.rejects(stageBrowserPackGeneration({ runtimeBundle: bundle, packDirectory: pack.directory, destination: target,
      expected: { ...pack.expected, [field]: '0'.repeat(64) }, runId: 'run', siteId: '1', publicationToken: token }))
    assert.equal(await exists(target), false)
  }
})

test('corrupt portable blob fails while prior staged generation stays byte-identical', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const options = { runtimeBundle: bundle, packDirectory: pack.directory, expected: pack.expected,
    runId: 'run', siteId: '1', publicationToken: token }
  const prior = await stageBrowserPackGeneration({ ...options, destination: resolve(f.root, 'prior') })
  const priorBytes = await readFile(resolve(prior.directory, 'site.json'))
  const manifest = JSON.parse(await readFile(resolve(pack.directory, 'manifest.json')))
  await writeFile(resolve(pack.directory, 'blobs/sha256', manifest.modules[0].sha256), 'corrupt')
  const target = resolve(f.root, 'rejected')
  await assert.rejects(stageBrowserPackGeneration({ ...options, destination: target, siteId: '2' }), /SHA-256 mismatch/)
  assert.equal(await exists(target), false)
  assert.deepEqual(await readFile(resolve(prior.directory, 'site.json')), priorBytes)
})

test('a DOM-only runtime explicitly rejects a pack requiring CanvasKit', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-two', { renderer: 'canvas' })
  const target = resolve(f.root, 'unsupported')
  await assert.rejects(stageBrowserPackGeneration({ runtimeBundle: bundle, packDirectory: pack.directory, destination: target,
    expected: pack.expected, runId: 'run', siteId: '1', publicationToken: token }), /requires CanvasKit/)
  assert.equal(await exists(target), false)
})

test('generation rejects symlink inputs, overlap, unverified handles and invalid viewport', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const options = { runtimeBundle: bundle, packDirectory: pack.directory, destination: resolve(f.root, 'candidate'),
    expected: pack.expected, runId: 'run', siteId: '1', publicationToken: token }
  await assert.rejects(stageBrowserPackGeneration({ ...options, runtimeBundle: { ...bundle } }), /live verified runtime/)
  await assert.rejects(stageBrowserPackGeneration({ ...options, destination: resolve(pack.directory, 'inside') }), /separate/)
  await assert.rejects(stageBrowserPackGeneration({ ...options, viewport: { width: 0, height: 667 } }), /viewport/)
  await symlink(resolve(pack.directory, 'manifest.json'), resolve(pack.directory, 'linked.json'))
  await assert.rejects(stageBrowserPackGeneration(options), /Nonregular/)
  assert.equal(await exists(options.destination), false)
})


test('output symlink ancestors are rejected before writing into any input or unrelated tree', async t => {
  const f = await fixture(t)
  await symlink(f.site, resolve(f.root, 'producer-alias'))
  await assert.rejects(f.retain(resolve(f.root, 'producer-alias', 'missing', 'runtime')), /canonical nonsymlinked/)
  assert.equal(await exists(resolve(f.site, 'missing')), false)
  const bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  for (const [name, input] of [['pack', pack.directory], ['bundle', bundle.directory]]) {
    const alias = resolve(f.root, `${name}-alias`); await symlink(input, alias)
    await assert.rejects(stageBrowserPackGeneration({ runtimeBundle: bundle, packDirectory: pack.directory,
      destination: resolve(alias, 'missing', 'generation'), expected: pack.expected,
      runId: 'run', siteId: '1', publicationToken: token }), /canonical nonsymlinked/)
    assert.equal(await exists(resolve(input, 'missing')), false)
  }
})

test('exclusive output reservation preserves an existing destination', async t => {
  const f = await fixture(t), target = resolve(f.root, 'already-owned')
  await mkdir(target); await put(target, 'owner.txt', 'preserve other owner')
  await assert.rejects(f.retain(target), { code: 'EEXIST' })
  assert.equal((await readFile(resolve(target, 'owner.txt'))).toString(), 'preserve other owner')
})

test('a live portable input mutation during validation cannot change the captured generation', async t => {
  const f = await fixture(t, { source(path, bytes, { root }) {
    if (path !== 'scripts/portable-pack.mjs') return bytes
    // Independently pinned synthetic validator modifies the original live input
    // at its invocation boundary. The actual validator still reads the captured
    // input, proving this race is isolated rather than trusting a prescan.
    return Buffer.from(bytes.toString().replace('export async function syncPortablePack(', 'async function capturedPackValidator(')
      + `\nexport async function syncPortablePack(options) {\n  await writeFile(${JSON.stringify(resolve(root, 'pack-one/manifest.json'))}, '{"corrupt":true}');\n  return capturedPackValidator(options);\n}\n`)
  } })
  const bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const staged = await stageBrowserPackGeneration({ runtimeBundle: bundle, packDirectory: pack.directory,
    destination: resolve(f.root, 'captured'), expected: pack.expected,
    runId: 'run', siteId: '1', publicationToken: token })
  assert.equal(staged.status, 'staged')
  assert.equal(hash(await readFile(resolve(staged.directory, 'portable-pack/manifest.json'))), pack.expected.manifestSha256)
  assert.deepEqual(JSON.parse(await readFile(resolve(pack.directory, 'manifest.json'))), { corrupt: true })
  assert.equal(await exists(resolve(staged.directory, '.input-snapshot')), false)
})

test('oversized portable files are rejected without allocating or publishing the candidate', async t => {
  const f = await fixture(t), bundle = await f.retain(), pack = await portable(t, f.root, 'pack-one')
  const large = await open(resolve(pack.directory, 'oversized.bin'), 'wx')
  try { await large.truncate(64 * 1024 * 1024 + 1) } finally { await large.close() }
  const target = resolve(f.root, 'oversized-candidate')
  await assert.rejects(stageBrowserPackGeneration({ runtimeBundle: bundle, packDirectory: pack.directory,
    destination: target, expected: pack.expected, runId: 'run', siteId: '1', publicationToken: token }), /exceeds budget/)
  assert.equal(await exists(target), false)
})
