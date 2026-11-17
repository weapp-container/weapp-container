/** Static artifact composition only. This module never starts Cargo, an app,
 * a Worker, an HTTP server or a browser, and never grants publication authority. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve, sep } from 'node:path'
import { GLUE_REQUIRED_METHODS, PORTABLE_PACK_VALIDATOR_FILES, RENDERER_DEPENDENCY_PINS,
  WASM_REQUIRED_EXPORTS, WEB_SAMPLE_FILES, inventoryGeneratedPackage, loadFrozenPackValidator,
  inspectWorkerPackAdmission, parseWorkerStartupIntent, rendererRuntimeConfig, stagePackIndex, stageWorkerProductConfig,
  verifyWasmExports } from './build-web-wasm.mjs'
import { GENERATED_MODULE_PARSER_PIN, verifyGeneratedModuleClosure } from './generated-package-closure.mjs'
import { assertDistributionIdentity, verifyDistributionArtifact } from './lib/showcase-policy.mjs'

const SHA = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const U64 = /^(?:0|[1-9][0-9]{0,19})$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const metadata = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) } return value }
const within = (child, parent) => child === parent || child.startsWith(parent + sep)
const handles = new WeakMap()
export const BROWSER_ARTIFACT_LIMITS = Object.freeze({ fileBytes: 64 * 1024 * 1024,
  retainedBytes: 256 * 1024 * 1024, sourceFiles: 10_000, files: 16_384, directories: 2048, depth: 64,
  manifestBytes: 2 * 1024 * 1024, reportBytes: 16 * 1024 * 1024 })
const RUNTIME_FILES = Object.freeze(WEB_SAMPLE_FILES.filter(path =>
  !['index.html', 'legacy.html', 'app.mjs', 'worker-app.mjs'].includes(path)))

function safePath(path) {
  assert.ok(typeof path === 'string' && path.length && !path.startsWith('/')
    && !/[\\%?#\x00-\x20\x7f:]/.test(path) && posix.normalize(path) === path
    && path.split('/').every(part => part !== '.' && part !== '..' && part), `Invalid retained path: ${path}`)
  return path
}
function decimal(value, name) {
  assert.ok(typeof value === 'string' && U64.test(value) && BigInt(value) <= 18446744073709551615n,
    `${name} must be an exact decimal u64 string`)
  return value
}
function descriptor(path, bytes) { return { path, sha256: hash(bytes), size: bytes.length } }
function budget() { return { bytes: 0, files: 0 } }
async function discardOwned(target, failure) {
  try { await rm(target, { recursive: true, force: true }) }
  catch (cleanup) { throw new AggregateError([failure, cleanup], 'Artifact staging and owned cleanup both failed') }
  throw failure
}
// Bound reads themselves; a size prescan alone cannot constrain a file that
// grows before readFile() allocates its result. Capture one verified descriptor
// into private bytes, with a single-byte overflow probe and exact inode checks.
async function bytesAt(root, path, account, max = BROWSER_ARTIFACT_LIMITS.fileBytes) {
  safePath(path)
  const location = resolve(root, path), expected = await lstat(location)
  assert.ok(within(location, root) && expected.isFile() && !expected.isSymbolicLink()
    && await realpath(location) === location, `Retained file must be regular and nonsymlinked: ${path}`)
  const file = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    assert.ok(stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino,
      `Retained file changed before open: ${path}`)
    assert.ok(Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= max
      && stat.size <= BROWSER_ARTIFACT_LIMITS.retainedBytes - account.bytes,
    `Retained byte budget exceeded: ${path}`)
    assert.ok(++account.files <= BROWSER_ARTIFACT_LIMITS.files, 'Retained file count budget exceeded')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      assert.ok(bytesRead > 0, `Retained file shortened while reading: ${path}`)
      offset += bytesRead
    }
    const overflow = await file.read(Buffer.alloc(1), 0, 1, offset)
    const after = await file.stat()
    assert.ok(overflow.bytesRead === 0 && after.size === stat.size && after.mtimeMs === stat.mtimeMs
      && after.ctimeMs === stat.ctimeMs, `Retained file changed while reading: ${path}`)
    account.bytes += bytes.length
    return bytes
  } finally { await file.close() }
}

// Reserve only a canonical new output directory. Check the nearest existing
// ancestor before mkdir so a symlink cannot redirect writes into an input tree.
async function reserveDestination(destination, excludedRoots) {
  const target = resolve(destination)
  assert.ok(excludedRoots.every(root => !within(target, root) && !within(root, target)),
    'Artifact output and inputs must be separate directories')
  let ancestor = dirname(target)
  for (;;) {
    try {
      const stat = await lstat(ancestor)
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(ancestor) === ancestor,
        'Artifact output ancestors must be canonical nonsymlinked directories')
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      assert.notEqual(parent, ancestor, 'No canonical output ancestor')
      ancestor = parent
    }
  }
  await mkdir(dirname(target), { recursive: true })
  await normalRoot(dirname(target))
  await mkdir(target)
  try { await normalRoot(target); return target }
  catch (error) { return discardOwned(target, error) }
}

async function normalRoot(directory) {
  const root = resolve(directory)
  assert.equal(await realpath(root), root, 'Use a canonical nonsymlinked artifact root')
  assert.ok((await lstat(root)).isDirectory(), 'Artifact root must be a directory')
  return root
}
async function entries(root, prefix, limits = BROWSER_ARTIFACT_LIMITS) {
  const files = [], account = { directories: 0, bytes: 0 }
  async function walk(path, depth) {
    assert.ok(++account.directories <= limits.directories && depth <= limits.depth, 'Artifact directory budget exceeded')
    const directory = resolve(root, path)
    assert.equal(await realpath(directory), directory, 'Artifact directory cannot be a symlink')
    for await (const item of await opendir(directory)) {
      const child = path ? `${path}/${item.name}` : item.name
      safePath(child)
      assert.ok(item.isFile() || item.isDirectory(), `Nonregular artifact member: ${child}`)
      if (item.isDirectory()) await walk(child, depth + 1)
      else {
        assert.ok(files.length < limits.files, 'Artifact file count budget exceeded')
        const stat = await lstat(resolve(root, child))
        assert.ok(stat.isFile() && stat.size <= limits.fileBytes, `Artifact file exceeds budget: ${child}`)
        account.bytes += stat.size
        assert.ok(account.bytes <= limits.retainedBytes, 'Artifact bytes exceed budget')
        files.push(child)
      }
    }
  }
  await walk(prefix, 0)
  return files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
}
function verifyExpected(expected) {
  assert.ok(expected && SHA.test(expected.reportSha256) && COMMIT.test(expected.sourceCommit)
    && SHA.test(expected.sourceSha256) && ['software', 'canvaskit'].includes(expected.renderer),
  'Independent exact build-report/source/renderer pins are required')
  assert.ok(expected.execution === undefined || ['worker', 'legacy'].includes(expected.execution), 'Unknown exact producer execution mode')
}

/** Verify producer bytes afresh. The expected report/source pins are caller
 * trust roots; they must not be derived from the report inside this function. */
export async function inspectBrowserRuntimeProducer(directory, expected) {
  expected = metadata(expected)
  verifyExpected(expected)
  const root = await normalRoot(directory), account = budget(), retained = new Map()
  const keep = async (path, expectedFile, limit) => {
    assert.ok(!retained.has(path), `Duplicate retained resource: ${path}`)
    const bytes = await bytesAt(root, path, account, limit)
    if (expectedFile) {
      assert.ok(SHA.test(expectedFile.sha256) && Number.isSafeInteger(expectedFile.size) && expectedFile.size >= 0,
        `Invalid retained descriptor: ${path}`)
      assert.equal(bytes.length, expectedFile.size, `Retained size mismatch: ${path}`)
      assert.equal(hash(bytes), expectedFile.sha256, `Retained SHA-256 mismatch: ${path}`)
    }
    retained.set(path, bytes); return bytes
  }
  const reportBytes = await keep('build-report.json', null, BROWSER_ARTIFACT_LIMITS.reportBytes)
  assert.equal(hash(reportBytes), expected.reportSha256, 'Independent producer report pin mismatch')
  const report = JSON.parse(reportBytes)
  const distribution = assertDistributionIdentity(report, expected)
  assertDistributionIdentity(report.plan, distribution)
  assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'passed')
  assert.equal(report.buildStatus, 'passed'); assert.equal(report.ready, true)
  const execution = expected.execution ?? 'worker'
  assert.equal(report.plan?.execution, execution); assert.equal(report.plan?.renderer, expected.renderer)
  for (const name of ['cargo', 'rustc', 'rustdoc', 'clang', 'ar', 'wasmBindgen'])
    assert.ok(typeof report.toolchain?.versions?.[name] === 'string' && report.toolchain.versions[name].length > 0,
      `Producer toolchain version receipt is missing: ${name}`)
  assert.equal(report.source?.status, 'passed'); assert.equal(report.source?.workingTreeDirty, false)
  assert.equal(report.source?.sourceStable, true); assert.equal(report.source?.sourceCommit, expected.sourceCommit)
  assert.equal(report.source?.sourceSha256, expected.sourceSha256)
  const sourceFiles = report.source.sourceFiles
  assert.ok(sourceFiles && typeof sourceFiles === 'object' && !Array.isArray(sourceFiles)
    && Object.keys(sourceFiles).length <= BROWSER_ARTIFACT_LIMITS.sourceFiles, 'Invalid bounded source inventory')
  assert.equal(hash(JSON.stringify(sourceFiles)), expected.sourceSha256, 'Producer source inventory hash mismatch')
  const required = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'scripts/build-web-wasm.mjs',
    'scripts/generated-package-closure.mjs', 'examples/hosts/web-wasm/renderer-dependency-pins.json',
    ...PORTABLE_PACK_VALIDATOR_FILES, ...WEB_SAMPLE_FILES.map(path => `examples/hosts/web-wasm/${path}`)]
  for (const path of required) assert.ok(SHA.test(sourceFiles[path]), `Missing required frozen source: ${path}`)
  for (const [path, sha256] of Object.entries(sourceFiles)) {
    assert.ok(SHA.test(sha256), `Invalid frozen source digest: ${path}`)
    const bytes = await keep(`source/${safePath(path)}`)
    assert.equal(hash(bytes), sha256, `Frozen source changed: ${path}`)
  }
  const assets = report.browserAssets
  assert.equal(assets?.status, 'passed'); assert.equal(assets?.retainedStatus, 'passed')
  assert.equal(assets.execution, execution); assert.equal(assets.entry, execution === 'worker' ? 'index.html' : 'legacy.html'); assert.equal(assets.entryModule, execution === 'worker' ? 'worker-app.mjs' : 'app.mjs')
  assert.deepEqual(assets.files.map(file => file.path), WEB_SAMPLE_FILES)
  for (const file of assets.files) {
    assert.equal(file.sourcePath, `examples/hosts/web-wasm/${file.path}`)
    assert.equal(file.sha256, sourceFiles[file.sourcePath])
    await keep(file.path, file)
  }
  const parser = report.generatedModuleParser
  for (const key of ['name', 'version', 'license', 'npmIntegrity', 'archiveVerifiedAtBuild', 'files'])
    assert.deepEqual(parser?.[key], GENERATED_MODULE_PARSER_PIN[key], `Generated parser pin mismatch: ${key}`)
  assert.equal(parser.status, 'passed'); assert.equal(parser.retainedStatus, 'passed')
  let parserBytes
  for (const file of GENERATED_MODULE_PARSER_PIN.files) {
    const bytes = await keep(`validation/generated-module-parser/${file.path}`, file, 256 * 1024)
    if (file.path === 'dist/acorn.mjs') parserBytes = bytes
  }
  // Only byte-pinned, self-contained Acorn is evaluated. Application glue and
  // AppService JS are never imported or instantiated here.
  const moduleParser = await import(`data:text/javascript;base64,${parserBytes.toString('base64')}`)
  assert.equal(moduleParser.version, GENERATED_MODULE_PARSER_PIN.version)
  assert.equal(typeof moduleParser.parse, 'function')
  const generated = report.generatedPackage
  assert.equal(generated?.status, 'passed'); assert.equal(generated?.retainedStatus, 'passed')
  assert.deepEqual((await inventoryGeneratedPackage(root)).files, generated.files, 'Generated package closure changed')
  for (const file of generated.files) await keep(file.path, file)
  const closure = await verifyGeneratedModuleClosure(root, generated, { parse: moduleParser.parse, provenance: parser })
  assert.deepEqual(closure, report.generatedModuleClosure, 'Generated module syntax closure differs from producer evidence')
  assert.equal(report.artifacts?.wasm?.path, 'pkg/container_host_web_bg.wasm')
  assert.equal(report.artifacts?.glue?.path, 'pkg/container_host_web.js')
  for (const artifact of Object.values(report.artifacts)) {
    assert.ok(retained.has(artifact.path), 'Producer artifact is outside verified pkg')
    assert.equal(hash(retained.get(artifact.path)), artifact.sha256, 'Producer artifact digest mismatch')
    assert.equal(retained.get(artifact.path).length, artifact.bytes, 'Producer artifact byte length mismatch')
  }
  const wasm = await WebAssembly.compile(retained.get('pkg/container_host_web_bg.wasm'))
  if (report.distributionProfile !== undefined) {
    verifyDistributionArtifact(retained.get('pkg/container_host_web_bg.wasm'), distribution)
    assert.equal(report.distributionIdentity?.markerVerified, true, 'Compiled distribution identity was not verified by producer')
    assertDistributionIdentity(report.distributionIdentity, distribution)
    if (distribution.distributionProfile === 'restricted-showcase') {
      assert.equal(report.distributionPolicy?.path, 'validation/showcase-policy.json')
      assert.equal(hash(await keep(report.distributionPolicy.path)), distribution.policySha256)
    }
  }
  verifyWasmExports(WebAssembly.Module.exports(wasm), WASM_REQUIRED_EXPORTS)
  const glueReceipt = report.artifacts.glue.interface
  assert.equal(glueReceipt?.initializerType, 'function'); assert.equal(glueReceipt?.hostType, 'function')
  assert.ok(Array.isArray(glueReceipt.methods) && glueReceipt.methods.includes('constructor')
    && GLUE_REQUIRED_METHODS.every(method => glueReceipt.methods.includes(method)),
    'Pinned producer glue interface receipt is incomplete')
  const renderer = report.rendererDependencies
  assert.equal(renderer?.status, 'passed'); assert.equal(renderer?.retainedStatus, 'passed')
  const runtime = renderer.runtimeConfig
  assert.equal(runtime?.path, 'runtime-config.json')
  const runtimeBytes = await keep(runtime.path, { sha256: runtime.sha256, size: runtime.bytes })
  const runtimeValue = JSON.parse(runtimeBytes)
  assert.deepEqual(runtimeValue, rendererRuntimeConfig(expected.renderer), 'Renderer config differs from committed pins')
  assert.deepEqual(runtimeValue, runtime.value)
  const fixedPins = JSON.parse(retained.get('source/examples/hosts/web-wasm/renderer-dependency-pins.json'))
  assert.deepEqual(fixedPins, RENDERER_DEPENDENCY_PINS, 'Producer renderer source pins differ from this consumer')
  const ids = expected.renderer === 'canvaskit' ? Object.keys(RENDERER_DEPENDENCY_PINS).sort() : []
  assert.deepEqual(renderer.files.map(file => file.id).sort(), ids)
  for (const file of renderer.files) {
    const pin = RENDERER_DEPENDENCY_PINS[file.id]
    assert.equal(file.verified, true); assert.equal(file.url, pin.url)
    assert.equal(file.sha256, pin.sha256); assert.equal(file.size, pin.size)
    await keep(file.url, file)
  }
  const runtimePaths = [...RUNTIME_FILES, ...generated.files.map(file => file.path), 'runtime-config.json',
    ...renderer.files.map(file => file.url)].sort()
  const fileMap = [...retained].map(([path, bytes]) => descriptor(path, bytes))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  return { root, retained, report, expected: metadata(expected), fileMap, runtimePaths, runtimeValue,
    source: { snapshotDirectory: resolve(root, 'source'), sourceFiles }, totalBytes: account.bytes }
}

function bundleHandle(state, bundleDescriptor, descriptorSha256) {
  const handle = Object.freeze({ version: '1.0', bundleId: bundleDescriptor.bundleId,
    descriptorSha256, directory: state.root, producer: frozen(metadata(state.expected)),
    runtimeFiles: frozen(bundleDescriptor.runtimeFiles.map(file => metadata(file))),
    provenance: frozen({ status: 'retained-static-verified', appService: 'not-run', presentation: 'not-run',
      gpu: 'unknown', producerGlueInterfaceReexecuted: false }),
    copyRuntimeFile(path) {
      assert.ok(state.runtimePaths.includes(path), 'Resource is not in the runtime serve allowlist')
      return Buffer.from(state.retained.get(path))
    } })
  handles.set(handle, state)
  return handle
}

/** Retain a reusable runtime from one independently pinned, clean Worker build.
 * Original report bytes are preserved; pack-specific old index/config are not
 * relabelled as a new build or copied into the runtime serve namespace. */
export async function retainBrowserRuntimeBundle({ builtSiteDirectory, destination, expected }) {
  expected = metadata(expected)
  verifyExpected(expected)
  assert.ok(expected.execution === undefined || expected.execution === 'worker', 'Reusable development bundles require a Worker producer')
  const state = await inspectBrowserRuntimeProducer(builtSiteDirectory, expected)
  const target = resolve(destination)
  assert.ok(!within(target, state.root) && !within(state.root, target), 'Bundle and producer must be separate directories')
  await reserveDestination(target, [state.root])
  try {
    for (const [path, bytes] of state.retained) {
      await mkdir(dirname(resolve(target, path)), { recursive: true })
      await writeFile(resolve(target, path), bytes, { flag: 'wx' })
    }
    const value = { schemaVersion: 1, scope: 'browser-runtime-bundle', producer: state.expected,
      files: state.fileMap, runtimeFiles: state.fileMap.filter(file => state.runtimePaths.includes(file.path)),
      appService: 'not-run', presentation: 'not-run', gpu: 'unknown' }
    const bundleDescriptor = { ...value, bundleId: hash(json(value)) }
    const bytes = json(bundleDescriptor)
    await writeFile(resolve(target, 'runtime-bundle.json'), bytes, { flag: 'wx' })
    // Read the retained copy, not the producer, before handing out its lease.
    return await openBrowserRuntimeBundle({ directory: target, expectedBundleSha256: hash(bytes), expected })
  } catch (error) { return discardOwned(target, error) }
}

export async function openBrowserRuntimeBundle({ directory, expectedBundleSha256, expected }) {
  expected = metadata(expected)
  assert.ok(SHA.test(expectedBundleSha256), 'An independent exact bundle descriptor pin is required')
  const root = await normalRoot(directory), bytes = await bytesAt(root, 'runtime-bundle.json', budget(), BROWSER_ARTIFACT_LIMITS.reportBytes)
  assert.equal(hash(bytes), expectedBundleSha256, 'Runtime bundle descriptor pin mismatch')
  const bundle = JSON.parse(bytes), { bundleId, ...unsigned } = bundle
  assert.equal(bundle.schemaVersion, 1); assert.equal(bundle.scope, 'browser-runtime-bundle')
  assert.equal(bundleId, hash(json(unsigned)), 'Runtime bundle identity mismatch')
  assert.deepEqual(bundle.producer, expected, 'Runtime bundle producer pins differ from requested source')
  const state = await inspectBrowserRuntimeProducer(root, expected)
  assert.deepEqual(bundle.files, state.fileMap, 'Runtime bundle retained inventory mismatch')
  assert.deepEqual(bundle.runtimeFiles, state.fileMap.filter(file => state.runtimePaths.includes(file.path)), 'Runtime serve allowlist differs')
  assert.deepEqual(await entries(root, ''), [...state.fileMap.map(file => file.path), 'runtime-bundle.json'].sort(),
    'Runtime bundle has missing or extra retained files')
  return bundleHandle(state, bundle, hash(bytes))
}

/** Stage one app-only generation without invoking or replacing the runtime.
 * This never switches a server pointer. Rust must recheck its exact portable
 * source observation token immediately before offering or activating it. */
export async function stageBrowserPackGeneration({ runtimeBundle, packDirectory, destination, expected,
  runId, siteId, publicationToken, viewport = { width: 375, height: 667 }, inputBindingSha256, startupIntentJson }) {
  expected = metadata(expected)
  viewport = metadata(viewport)
  const bundle = handles.get(runtimeBundle)
  assert.ok(bundle, 'A live verified runtime bundle handle is required')
  assert.ok(expected && SHA.test(expected.manifestSha256) && SHA.test(expected.integrityRoot), 'Independent portable manifest/root pins are required')
  assert.ok(typeof expected.compilerCommit === 'string' && (expected.compilerCommit === 'unknown'
    || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expected.compilerCommit)), 'Exact portable compiler identity is required')
  assert.ok(/^[A-Za-z0-9_-]{1,128}$/.test(runId), 'Invalid unique run id')
  decimal(siteId, 'siteId'); decimal(expected.revision, 'pack revision')
  const token = { sourceRevision: decimal(publicationToken?.sourceRevision, 'source revision'),
    compilerReceiptSequence: decimal(publicationToken?.compilerReceiptSequence, 'compiler receipt sequence') }
  assert.ok(inputBindingSha256 === undefined || SHA.test(inputBindingSha256), 'Invalid stage input binding')
  const intentText = startupIntentJson ?? JSON.stringify({ schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    viewport, rendererPolicy: { mode: 'manifest' } })
  const intent = parseWorkerStartupIntent(intentText)
  if (inputBindingSha256 !== undefined) assert.ok(SHA.test(expected.startupIntentSha256), 'Bound staging requires an independent startup intent pin')
  if (inputBindingSha256 !== undefined) assert.ok(typeof expected.selectedRoute === 'string', 'Bound staging requires the independently selected portable route')
  if (expected.startupIntentSha256 !== undefined) assert.equal(intent.sha256, expected.startupIntentSha256, 'Startup intent differs from its independent pin')
  assert.ok(['width', 'height'].every(key => Number.isSafeInteger(viewport[key]) && viewport[key] > 0 && viewport[key] <= 4096), 'Invalid logical viewport')
  const packRoot = await normalRoot(packDirectory), target = resolve(destination)
  assert.ok(!within(target, packRoot) && !within(packRoot, target)
    && !within(target, bundle.root) && !within(bundle.root, target), 'Generation, runtime and portable input must be separate')
  // Bound the input tree before the existing frozen validator reads any blob.
  await entries(packRoot, '')
  const inputManifest = await bytesAt(packRoot, 'manifest.json', budget(), BROWSER_ARTIFACT_LIMITS.manifestBytes)
  assert.equal(hash(inputManifest), expected.manifestSha256, 'Independent portable manifest pin mismatch')
  await reserveDestination(target, [packRoot, bundle.root])
  try {
    // Freeze the bounded read results before calling the existing validator.
    // It sees a new private, write-once input rather than reopening live app
    // files after a budget prescan. The runtime bundle is retained separately.
    const capture = resolve(target, '.input-snapshot'), inputAccount = budget()
    await mkdir(capture)
    for (const path of await entries(packRoot, '')) {
      const bytes = await bytesAt(packRoot, path, inputAccount,
        path === 'manifest.json' ? BROWSER_ARTIFACT_LIMITS.manifestBytes : BROWSER_ARTIFACT_LIMITS.fileBytes)
      await mkdir(dirname(resolve(capture, path)), { recursive: true })
      await writeFile(resolve(capture, path), bytes, { flag: 'wx' })
    }
    const validator = await loadFrozenPackValidator(bundle.source)
    const pack = await validator.syncPortablePack({ source: capture, destination: resolve(target, 'portable-pack') })
    await rm(capture, { recursive: true })
    assert.equal(pack.integrityRoot, expected.integrityRoot, 'Portable integrity root differs from expected source')
    const manifestBytes = await bytesAt(target, 'portable-pack/manifest.json', budget(), BROWSER_ARTIFACT_LIMITS.manifestBytes)
    assert.equal(hash(manifestBytes), expected.manifestSha256, 'Portable manifest changed during retention')
    const manifest = JSON.parse(manifestBytes)
    assert.equal(manifest.compiler?.commit, expected.compilerCommit, 'Portable compiler identity differs from expected source')
    const selectedRoute = expected.selectedRoute ?? intent.value.route ?? manifest.routes?.[0]?.path
    assert.ok(manifest.routes?.some(route => route.path === selectedRoute), 'Selected portable route is absent from this pack')
    const blobs = []
    for (const file of pack.files.filter(path => path.startsWith('blobs/sha256/'))) {
      const bytes = await bytesAt(target, `portable-pack/${file}`, budget())
      const sha256 = file.split('/').at(-1)
      assert.equal(hash(bytes), sha256, 'Retained blob differs from its content address')
      blobs.push({ sha256, url: `portable-pack/${file}`, size: bytes.length })
    }
    const index = { schemaVersion: 1, manifest: 'portable-pack/manifest.json', manifestSha256: expected.manifestSha256,
      integrityRoot: expected.integrityRoot, blobs }
    const indexDescriptor = await stagePackIndex(target, index)
    const admission = await inspectWorkerPackAdmission(bundle.source, target, indexDescriptor, { rendererPolicy: intent.value.rendererPolicy })
    assert.ok(!admission.requiresCanvasKit || bundle.runtimeValue.renderer === 'canvaskit',
      'Pack requires CanvasKit; the verified runtime has no pinned drawing assets')
    const config = await stageWorkerProductConfig(target, { index: indexDescriptor, rendererConfig: bundle.runtimeValue,
      startupIntentJson: intentText, selectedRoute })
    const site = { schemaVersion: 1, scope: 'browser-pack-generation', runId, siteId, packRevision: expected.revision,
      inputBindingSha256: inputBindingSha256 ?? null, startupIntentSha256: intent.sha256,
      requestedRoute: intent.value.route ?? null, selectedRoute,
      publicationToken: token, runtimeBundle: { id: runtimeBundle.bundleId, descriptorSha256: runtimeBundle.descriptorSha256 },
      packIndex: indexDescriptor, manifestSha256: expected.manifestSha256, integrityRoot: expected.integrityRoot,
      compilerCommit: expected.compilerCommit,
      productConfig: { path: config.path, sha256: config.sha256, size: config.size }, startupJson: config.startupJson, admission,
      publication: 'not-authorized', runtime: 'not-run', presentation: 'not-run', gpu: 'unknown' }
    const siteBytes = json(site)
    await writeFile(resolve(target, 'site.json'), siteBytes, { flag: 'wx' })
    const account = budget(), files = []
    for (const path of await entries(target, '')) files.push(descriptor(path, await bytesAt(target, path, account)))
    return frozen({ status: 'staged', directory: target, descriptor: site, descriptorSha256: hash(siteBytes), files,
      limitations: ['No source publication authority, runtime build, Worker execution or accepted presentation is granted by assembly'] })
  } catch (error) { return discardOwned(target, error) }
}

export const BROWSER_RUNTIME_FILES = RUNTIME_FILES
