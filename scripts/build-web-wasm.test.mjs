import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isBuiltin, syncBuiltinESMExports } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { packContainer } from '../tools/container-manifest/src/index.ts'
import { canonicalize } from '../tools/container-manifest/src/json-integrity.mjs'
import { GENERATED_MODULE_PARSER_PIN, loadPinnedGeneratedModuleParser } from './generated-package-closure.mjs'
import { GLUE_REQUIRED_METHODS, PORTABLE_PACK_VALIDATOR_FILES, RENDERER_DEPENDENCY_PINS, WASM_REQUIRED_EXPORTS, WASM_TARGET, WEB_SAMPLE_FILES,
  copyPinnedRendererDependency, createBuildPlan, createOwnedCommandRunner, loadFrozenPackValidator, lockedWasmBindgenVersion, parseArgs,
  restrictedWasmBuildHardening, stripRestrictedWasmMetadata, verifyRestrictedWasmPaths,
  rendererDependencyInputs, rendererRuntimeConfig, runWebWasmBuild, selectWasmArtifact, stageBrowserAssets as rawStageBrowserAssets, stageRendererDependencies,
  stagePackIndex, stageWorkerProductConfig, parseWorkerStartupIntent, inspectWorkerPackAdmission, inventoryGeneratedPackage, verifyRetainedGeneratedPackage,
  snapshotBuildSource, verifyRetainedBrowserAssets, verifyRetainedRendererDependencies, verifyWasmExports } from './build-web-wasm.mjs'

let parseModule, parserEvidenceDirectory
test.before(async () => {
  parserEvidenceDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'web-wasm-test-parser-')))
  const parser = await loadPinnedGeneratedModuleParser({ root: fileURLToPath(new URL('..', import.meta.url)),
    destination: resolve(parserEvidenceDirectory, 'parser') })
  parseModule = parser.parse
})
test.after(async () => { if (parserEvidenceDirectory) await rm(parserEvidenceDirectory, { recursive: true, force: true }) })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('startup intent binds exact input bytes without depending on generated pack-index bytes', () => {
  const value = { schemaVersion: 1, execution: 'worker', engine: 'quickjs', viewport: { width: 375, height: 667 },
    rendererPolicy: { mode: 'force', profile: 'webview' }, data: { count: 3 } }
  const compact = JSON.stringify(value), formatted = JSON.stringify(value, null, 2) + '\n'
  assert.deepEqual(parseWorkerStartupIntent(compact).value, parseWorkerStartupIntent(formatted).value)
  assert.equal(parseWorkerStartupIntent(compact).sha256, sha256(compact))
  assert.notEqual(parseWorkerStartupIntent(compact).sha256, parseWorkerStartupIntent(formatted).sha256)
  for (const changed of [{ engine: 'v8' }, { index: { sha256: 'a'.repeat(64) } }, { viewport: { width: 0, height: 667 } },
    { rendererPolicy: { mode: 'force', profile: 'software' } }, { route: '../escape' }, { data: [] },
    { metrics: { windowWidth: 400, windowHeight: 667 } }]) {
    assert.throws(() => parseWorkerStartupIntent(JSON.stringify({ ...value, ...changed })))
  }
  assert.throws(() => parseWorkerStartupIntent(' '.repeat(64 * 1024 + 1)), /bounded JSON/)
  assert.throws(() => parseWorkerStartupIntent(JSON.stringify(value).replace('"count":3', '"count":1e400')), /finite JSON/)
  let nested = {}
  // The envelope is depth zero and data is depth one: 63 child edges
  // reaches the accepted depth 64, while one more crosses the boundary.
  for (let depth = 0; depth < 63; depth++) nested = { child: nested }
  assert.deepEqual(parseWorkerStartupIntent(JSON.stringify({ ...value, data: nested })).value.data, nested)
  nested = { child: nested }
  assert.throws(() => parseWorkerStartupIntent(JSON.stringify({ ...value, data: nested })), /JSON structure budget/)
})

test('product serializer distinguishes intent, actual JSON and executable module pins', async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'worker-config-pins-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const startupIntentJson = JSON.stringify({ schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    viewport: { width: 390, height: 844 }, rendererPolicy: { mode: 'force', profile: 'webview' },
    route: 'pages/home/index', data: { value: 7 }, query: { from: 'dev' } })
  const staged = []
  for (const [name, indexSha] of [['first', 'a'.repeat(64)], ['second', 'b'.repeat(64)]]) {
    const directory = resolve(root, name); await mkdir(directory)
    const result = await stageWorkerProductConfig(directory, { index: { path: 'pack-index.json', sha256: indexSha, size: 200 },
      rendererConfig: rendererRuntimeConfig('software'), startupIntentJson })
    const moduleBytes = await readFile(resolve(directory, result.path))
    const jsonBytes = await readFile(resolve(directory, result.startupJson.path))
    assert.equal(result.sha256, sha256(moduleBytes))
    assert.equal(result.startupJson.sha256, sha256(jsonBytes))
    assert.notEqual(result.sha256, result.startupJson.sha256)
    assert.equal(result.startupIntentSha256, sha256(startupIntentJson))
    assert.deepEqual(JSON.parse(jsonBytes), result.value)
    assert.equal(result.value.index.sha256, indexSha)
    assert.equal(result.value.rendererPolicy.profile, 'webview')
    assert.equal(result.value.data.value, 7)
    staged.push(result)
  }
  assert.equal(staged[0].startupIntentSha256, staged[1].startupIntentSha256)
  assert.notEqual(staged[0].startupJson.sha256, staged[1].startupJson.sha256)
})

test('Skia startup preserves physical density independently of viewport and simulated metrics', async t => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'worker-density-config-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const value = { schemaVersion: 1, execution: 'worker', engine: 'quickjs', viewport: { width: 375, height: 667 },
    rendererPolicy: { mode: 'force', profile: 'skia' }, renderScale: 2,
    metrics: { windowWidth: 375, windowHeight: 667, pixelRatio: 1, screenWidth: 375, screenHeight: 667,
      statusBarHeight: 0, screenTop: 0, deviceOrientation: 'portrait' } }
  assert.equal(parseWorkerStartupIntent(JSON.stringify({ ...value, renderScale: 'auto' })).value.renderScale, 'auto')
  const staged = await stageWorkerProductConfig(directory, { index: { path: 'pack-index.json', sha256: 'a'.repeat(64), size: 200 },
    rendererConfig: rendererRuntimeConfig('software'), startupIntentJson: JSON.stringify(value) })
  const config = JSON.parse(await readFile(resolve(directory, staged.startupJson.path), 'utf8'))
  assert.equal(config.renderScale, 2); assert.deepEqual(config.viewport, value.viewport); assert.deepEqual(config.metrics, value.metrics)
  for (const changed of [{ renderScale: 0 }, { renderScale: null }, { renderScale: '2' }, { renderScale: 2.5 },
    { renderScale: 4, viewport: { width: 400, height: 700 } }, { rendererPolicy: { mode: 'force', profile: 'webview' } }]) {
    assert.throws(() => parseWorkerStartupIntent(JSON.stringify({ ...value, ...changed })))
  }
})

test('generated startup module preserves JSON own prototype-named keys and string contents', async t => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'worker-config-json-semantics-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  // Parse original JSON: JS object literal syntax would already lose the key
  // before the serializer under test sees it.
  const special = JSON.parse('{"__proto__":{"value":7},"constructor":"plain-data","nested":{"__proto__":3},"text":"quote: \\"; backtick: `; substitution: ${value}; newline: \\n"}')
  const startupIntentJson = JSON.stringify({ schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    viewport: { width: 375, height: 667 }, rendererPolicy: { mode: 'manifest' },
    data: special, query: special, launchOptions: special })
  const staged = await stageWorkerProductConfig(directory, { index: { path: 'pack-index.json', sha256: 'a'.repeat(64), size: 200 },
    rendererConfig: rendererRuntimeConfig('software'), startupIntentJson })
  const moduleBytes = await readFile(resolve(directory, staged.path))
  // Execute only the generated data module, never app code or a runtime.
  const { WORKER_PRODUCT_CONFIG: actual } = await import(`data:text/javascript;base64,${moduleBytes.toString('base64')}`)
  assert.deepEqual(actual, JSON.parse(await readFile(resolve(directory, staged.startupJson.path), 'utf8')))
  for (const key of ['data', 'query', 'launchOptions']) {
    assert.equal(Object.hasOwn(actual[key], '__proto__'), true)
    assert.equal(Object.getPrototypeOf(actual[key]), Object.prototype)
    assert.equal(Object.hasOwn(actual[key].nested, '__proto__'), true)
    assert.equal(Object.getPrototypeOf(actual[key].nested), Object.prototype)
    assert.deepEqual(actual[key], special)
    assert.equal(Object.isFrozen(actual[key].__proto__), true)
  }
})

const EMPTY_WASM = Buffer.from('0061736d01000000', 'hex')
const u32 = value => { const result = []; do { let byte = value & 127; value >>>= 7; if (value) byte |= 128; result.push(byte) } while (value); return result }
const BINDGEN_SUFFIX = '_144b20889b08dae8'
const VALID_GLUE = `export class WebWasmHost {
  constructor() { throw new Error('interface verification must not construct a host') }
  ${GLUE_REQUIRED_METHODS.map(name => `${name}() {}`).join('\n  ')}
}
export default function init() { throw new Error('interface verification must not initialize WASM') }
`
function fakeHostModule(names = WASM_REQUIRED_EXPORTS, { marker = 'weapp-container-distribution:full:\0', customSections = [] } = {}) {
  const section = (id, bytes) => [id, ...u32(bytes.length), ...bytes]
  const exported = [...u32(names.length)]
  names.forEach((name, index) => exported.push(...u32(name.length), ...Buffer.from(name), 0, ...u32(index)))
  return Buffer.from([...EMPTY_WASM, ...section(1, [1, 96, 0, 0]),
    ...section(3, [...u32(names.length), ...names.map(() => 0)]),
    ...section(7, exported), ...section(10, [...u32(names.length), ...names.flatMap(() => [2, 0, 11])]),
    ...section(0, [1, 120, ...Buffer.from(marker)]),
    ...customSections.flatMap(({ name, bytes }) => section(0, [...u32(Buffer.byteLength(name)), ...Buffer.from(name), ...bytes]))])
}

async function fixture(settings = {}) {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'weapp-web-wasm-build-')))
  const root = resolve(directory, 'project')
  const outDir = resolve(directory, 'output')
  const pack = resolve(directory, 'pack')
  const tools = resolve(directory, 'tools')
  const sourceFiles = {
    'Cargo.toml': '[workspace]\n', 'Cargo.lock': '[[package]]\nname = "wasm-bindgen"\nversion = "0.2.129"\n',
    'rust-toolchain.toml': '[toolchain]\nchannel="stable"\n',
    'crates/container-host-web/Cargo.toml': '[package]\nname="container-host-web"\n',
    'crates/container-host-web/src/lib.rs': 'pub fn original_snapshot_source() {}\n',
  }
  // Stage actual browser sources without importing or executing them.
  for (const file of WEB_SAMPLE_FILES) {
    const sourcePath = `examples/hosts/web-wasm/${file}`
    sourceFiles[sourcePath] = await readFile(new URL(`../${sourcePath}`, import.meta.url), 'utf8')
  }
  // Exercise the real frozen validator and its complete Node-only closure.
  // This temporary project deliberately has no index.mjs or node_modules.
  for (const file of PORTABLE_PACK_VALIDATOR_FILES) {
    sourceFiles[file] = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
  }
  sourceFiles['scripts/generated-package-closure.mjs'] = await readFile(new URL('./generated-package-closure.mjs', import.meta.url), 'utf8')
  for (const [path, bytes] of Object.entries(sourceFiles)) {
    await mkdir(dirname(resolve(root, path)), { recursive: true })
    await writeFile(resolve(root, path), bytes)
  }
  // Preserve the real parser's exact pinned dependency bytes, without giving
  // this fake build root access to the surrounding mutable node_modules tree.
  for (const file of GENERATED_MODULE_PARSER_PIN.files) {
    const path = resolve(root, 'tools/container-manifest/node_modules/acorn', file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, await readFile(new URL(`../tools/container-manifest/node_modules/acorn/${file.path}`, import.meta.url)))
  }
  await mkdir(tools)
  for (const tool of ['cargo', 'rustc', 'rustdoc', 'clang', 'llvm-ar', 'wasm-bindgen']) await writeFile(resolve(tools, tool), '')
  await packContainer(fileURLToPath(new URL('../fixtures/reference-app', import.meta.url)), pack, { compilerCommit: 'a'.repeat(40) })
  if (settings.webviewPack) {
    const path = resolve(pack, 'manifest.json'), manifest = JSON.parse(await readFile(path))
    manifest.schemaVersion = 3; manifest.rendering = { version: '1.0', default: 'webview', pages: {} }
    manifest.integrity.root = sha256(canonicalize({ ...manifest, integrity: { ...manifest.integrity, root: '' } }))
    await writeFile(path, canonicalize(manifest) + '\n')
  }
  const calls = []
  const environment = { PATH: process.env.PATH || '', SDKROOT: '/inherited-apple-sdk', SDKTARGETSYSROOT: '/inherited-other-sdk', ...settings.environment }
  const options = { pack, outDir, llvmBin: tools, wasmBindgen: resolve(tools, 'wasm-bindgen'),
    profile: settings.profile || 'release', offline: true, execution: settings.execution || 'legacy' }
  if (settings.restricted) {
    const manifest = JSON.parse(await readFile(resolve(pack, 'manifest.json')))
    const policy = resolve(directory, 'policy.json')
    await writeFile(policy, JSON.stringify({ schemaVersion: 1, allowedApis: ['wx.getWindowInfo'], allowedPackRoots: [manifest.integrity.root] }))
    Object.assign(options, { distributionProfile: 'restricted-showcase', showcasePolicy: policy })
  }
  if (settings.targetDirectorySource === 'argument') options.targetDir = resolve(directory, 'shared-cargo-target')
  if (settings.targetDirectorySource === 'environment') environment.CARGO_TARGET_DIR = resolve(directory, 'shared-cargo-target')
  if (settings.keepCargoCache) options.keepCargoCache = true
  if (settings.renderer === 'canvaskit') {
    Object.assign(options, { renderer: 'canvaskit', canvaskitDir: resolve(directory, 'renderer-inputs/canvaskit'),
      fontFile: resolve(directory, 'renderer-inputs/NotoSansSC.ttf'), fontLicenseFile: resolve(directory, 'renderer-inputs/OFL.txt') })
    for (const input of rendererDependencyInputs(options)) {
      await mkdir(dirname(input.sourcePath), { recursive: true })
      await writeFile(input.sourcePath, `same filename is not trusted: ${input.id}\n`)
    }
  }
  const plan = createBuildPlan(options, { root, environment })
  const marker = `weapp-container-distribution:${plan.distributionProfile}:${plan.policySha256 || ''}\0`
  const reflectionRunner = createOwnedCommandRunner(outDir)
  const success = stdout => ({ status: 'passed', stdout: stdout || '', stderr: '' })
  const cargoRecords = path => [
    { reason: 'compiler-artifact', manifest_path: resolve(plan.sourceDir, 'crates/container-host-web/Cargo.toml'),
      package_id: 'mock-container-host-web', target: { name: 'container_host_web', crate_types: ['cdylib', 'rlib'] },
      features: plan.features, filenames: [path], fresh: false },
    { reason: 'build-finished', success: true },
  ].map(value => JSON.stringify(value)).join('\n')
  const run = async (binary, args, commandOptions = {}) => {
    calls.push({ binary, args, options: commandOptions })
    if (binary === 'git') {
      if (args[0] === 'rev-parse') return success('b'.repeat(40))
      if (args[0] === 'status') return success(settings.dirty ? ' M crates/container-host-web/src/lib.rs\0' : '')
      if (args[0] === 'ls-files') return success(Object.keys(sourceFiles).filter(file => file !== settings.omitSourceFile).join('\0') + '\0')
    }
    assert.equal(commandOptions.env.SDKROOT, undefined)
    assert.equal(commandOptions.env.SDKTARGETSYSROOT, undefined)
    if (binary === process.execPath) return reflectionRunner(binary, args, commandOptions)
    if (binary === 'rustup') {
      if (args[0] === 'which') return success(resolve(tools, args[1]))
      if (args.join(' ') === 'target list --installed') return success(settings.missingTarget ? 'aarch64-apple-darwin\n' : WASM_TARGET + '\n')
    }
    if (args.includes('--version')) {
      if (binary.endsWith('wasm-bindgen')) return success(`wasm-bindgen ${settings.bindgenVersion || '0.2.129'}\n`)
      return success(binary.endsWith('clang') ? 'clang version 20.1.8\n' : binary.endsWith('llvm-ar') ? 'LLVM version 20.1.8\n' : 'rustc/cargo 1.92.0\n')
    }
    if (binary.endsWith('clang')) { await writeFile(args[args.indexOf('-o') + 1], settings.badCompiler ? 'native object bytes' : EMPTY_WASM); return success() }
    if (binary.endsWith('llvm-ar')) { await writeFile(args[1], '!<arch>\nmock wasm archive'); return success() }
    if (binary.endsWith('cargo')) {
      assert.deepEqual(args, plan.cargoArgs)
      assert.equal(commandOptions.cwd, plan.sourceDir)
      assert.equal(commandOptions.env.CC_wasm32_unknown_unknown, resolve(tools, 'clang'))
      assert.equal(commandOptions.env['CC_wasm32-unknown-unknown'], resolve(tools, 'clang'))
      const copied = await readFile(resolve(plan.sourceDir, 'crates/container-host-web/src/lib.rs'), 'utf8')
      assert.equal(copied, sourceFiles['crates/container-host-web/src/lib.rs'])
      if (settings.changeOriginalDuringBuild) await writeFile(resolve(root, 'crates/container-host-web/src/lib.rs'), 'mutated original after snapshot')
      if (settings.changeOriginalValidatorDuringBuild) await writeFile(resolve(root, 'scripts/modern-view-pack-resources.mjs'), "throw new Error('mutable original validator must not execute')\n")
      if (settings.mutateSnapshot) await writeFile(resolve(plan.sourceDir, 'crates/container-host-web/src/lib.rs'), 'mutated frozen build input')
      if (settings.mutateFrozenValidator) await writeFile(resolve(plan.sourceDir, 'scripts/modern-view-pack-resources.mjs'), 'mutated frozen pack validator')
      if (settings.changeOriginalBrowserAssetDuringBuild) await writeFile(resolve(root, 'examples/hosts/web-wasm/worker-bridge-transport.mjs'), 'mutated original browser asset')
      await mkdir(plan.targetDir, { recursive: true })
      await writeFile(resolve(plan.targetDir, 'partial.o'), 'rebuildable compilation output')
      if (settings.abortDuringCargo) {
        settings.abortDuringCargo.abort()
        await new Promise(resolveWait => setTimeout(resolveWait, 20))
        assert.equal(existsSync(plan.targetDir), true, 'cache must remain until the command promise settles')
        throw new Error('mock Cargo cancellation settled')
      }
      if (settings.unverifiedCommandCleanup) throw Object.assign(new Error('mock Cargo group not settled'), { commandCleanupStatus: 'unverified' })
      if (settings.cargoFails) throw new Error('mock Cargo link failed')
      const path = resolve(plan.targetDir, WASM_TARGET, plan.profile === 'release' ? 'release' : 'debug', 'container_host_web.wasm')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, settings.emptyArtifact ? EMPTY_WASM : fakeHostModule(WASM_REQUIRED_EXPORTS.map(name => name + BINDGEN_SUFFIX),
        { marker, customSections: settings.rawPathLeak ? [{ name: 'retained', bytes: Buffer.from(plan.sourceDir) }] : [] }))
      return success(cargoRecords(settings.staleArtifact ? resolve(root, 'target/old.wasm') : path))
    }
    if (binary.endsWith('wasm-bindgen')) {
      assert.equal(args[args.indexOf('--target') + 1], 'web')
      const destination = args[args.indexOf('--out-dir') + 1]
      await mkdir(destination, { recursive: true })
      await writeFile(resolve(destination, 'container_host_web_bg.wasm'), fakeHostModule(WASM_REQUIRED_EXPORTS.map(name => name + (settings.bindgenSuffixed ? BINDGEN_SUFFIX : '')),
        { marker, customSections: [...(settings.metadata || []), ...(settings.generatedPathLeak ? [{ name: 'retained', bytes: Buffer.from(plan.root) }] : [])] }))
      await writeFile(resolve(destination, 'container_host_web.js'), settings.glue ?? VALID_GLUE)
      await writeFile(resolve(destination, 'container_host_web.d.ts'), 'export declare class WebWasmHost {}\n')
      await writeFile(resolve(destination, 'container_host_web_bg.wasm.d.ts'), 'export const memory: WebAssembly.Memory;\n')
      if (settings.glueRelativeImport) {
        await writeFile(resolve(destination, 'glue-helper.mjs'), 'export const marker = true\n')
        await writeFile(resolve(destination, 'container_host_web.js'), `import { marker } from './glue-helper.mjs'; if (!marker) throw new Error('relative import failed');\n${VALID_GLUE}`)
      }
      if (settings.mutateRetainedPack) await writeFile(resolve(outDir, 'portable-pack/manifest.json'), 'corrupt retained manifest')
      if (settings.mutateRuntimeConfig) await writeFile(resolve(outDir, 'runtime-config.json'), '{"renderer":"canvaskit"}')
      if (settings.mutateBrowserAssetInventory) await writeFile(resolve(outDir, 'browser-assets.json'), '{}')
      if (settings.mutateRetainedBrowserAsset) await writeFile(resolve(outDir, 'runtime-worker.mjs'), 'corrupt retained Worker entry')
      if (settings.mutatePackIndex) await writeFile(resolve(outDir, 'pack-index.json'), '{}\n')
      if (settings.mutateProductConfig) await writeFile(resolve(outDir, 'worker-product-config.mjs'), 'export const WORKER_PRODUCT_CONFIG = {}\n')
      if (settings.mutateProductStartupJson) await writeFile(resolve(outDir, 'worker-product-config.json'), '{}\n')
      if (settings.replaceCacheWithSymlink) {
        const callerDirectory = resolve(directory, 'caller-owned')
        await mkdir(callerDirectory)
        await writeFile(resolve(callerDirectory, 'retained'), 'caller data')
        await rm(plan.targetDir, { recursive: true })
        await symlink(callerDirectory, plan.targetDir)
      }
      return success()
    }
    throw new Error(`Unexpected fake command ${binary} ${args.join(' ')}`)
  }
  return { directory, root, outDir, pack, options, plan, calls, environment, run, sourceFiles,
    build: () => runWebWasmBuild(options, { root, environment, run, signal: settings.abortDuringCargo?.signal }), cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('restricted producer derives Rust/C remaps and rejects ambient compiler overrides', async t => {
  const f = await fixture({ restricted: true }); t.after(f.cleanup)
  const plan = { ...f.plan, targetDir: resolve(f.directory, 'target cache with spaces') }
  const hardening = await restrictedWasmBuildHardening(plan, f.environment)
  assert.equal(hardening.environment.CARGO_PROFILE_RELEASE_DEBUG, '0')
  assert.equal(hardening.environment.CARGO_PROFILE_RELEASE_STRIP, 'debuginfo')
  assert.equal(hardening.environment.CC_SHELL_ESCAPED_FLAGS, '1')
  assert.ok(hardening.rustFlags.includes(`--remap-path-prefix=${plan.sourceDir}=weapp-container-source`))
  assert.ok(hardening.cFlags.includes(`-ffile-prefix-map=${plan.targetDir}=weapp-container-build`))
  assert.ok(hardening.environment.CFLAGS.includes(JSON.stringify(`-ffile-prefix-map=${plan.targetDir}=weapp-container-build`)))
  for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'CFLAGS_wasm32_unknown_unknown', 'CXXFLAGS_wasm32_unknown_unknown', 'CC_wasm32_unknown_unknown', 'CARGO_PROFILE_RELEASE_DEBUG']) {
    assert.throws(() => createBuildPlan(f.options, { root: f.root, environment: { ...f.environment, [key]: 'custom' } }), /producer-owned compiler flags/)
  }
  assert.equal(await restrictedWasmBuildHardening({ ...plan, policy: null }, { RUSTFLAGS: 'legacy-full-build' }), null)
})

test('release stripping preserves executable exports and unknown policy metadata', async () => {
  const original = fakeHostModule(WASM_REQUIRED_EXPORTS, { customSections: [
    { name: 'name', bytes: Buffer.from([0, 1, 0]) }, { name: 'producers', bytes: Buffer.from([0]) },
    { name: '.debug_info', bytes: Buffer.from('private debug metadata') },
    { name: 'sourceMappingURL', bytes: Buffer.from('private.map') },
    { name: 'retained-identity', bytes: Buffer.from('public-policy-marker') },
  ] })
  const stripped = stripRestrictedWasmMetadata(original)
  assert.deepEqual(stripped.receipt.removedCustomSections, ['name', 'producers', '.debug_info', 'sourceMappingURL'])
  assert.ok(stripped.bytes.includes(Buffer.from('public-policy-marker')))
  assert.deepEqual(WebAssembly.Module.exports(await WebAssembly.compile(stripped.bytes)), WebAssembly.Module.exports(await WebAssembly.compile(original)))
  assert.equal(stripped.receipt.outputSha256, sha256(stripped.bytes))
  assert.deepEqual(stripRestrictedWasmMetadata(stripped.bytes).bytes, stripped.bytes)
  for (const bytes of [Buffer.from('bad'), Buffer.concat([EMPTY_WASM, Buffer.from([0, 255])]), Buffer.concat([EMPTY_WASM, Buffer.from([0, 1, 255])])]) {
    assert.throws(() => stripRestrictedWasmMetadata(bytes), /WASM/)
  }
})

test('restricted pipeline hashes only stripped generated bytes with fixed producer flags', async t => {
  const f = await fixture({ restricted: true, metadata: [{ name: '.debug_info', bytes: Buffer.from('private-debug') }] }); t.after(f.cleanup)
  const report = await f.build()
  assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
  const cargo = f.calls.find(call => call.binary.endsWith('cargo') && call.args[0] === 'build')
  assert.equal(cargo.options.env.CARGO_ENCODED_RUSTFLAGS, report.buildHardening.environment.CARGO_ENCODED_RUSTFLAGS)
  assert.equal(cargo.options.env.CFLAGS, report.buildHardening.environment.CFLAGS)
  assert.equal(cargo.options.env.CXXFLAGS, report.buildHardening.environment.CXXFLAGS)
  assert.deepEqual(report.generatedWasmHardening.removedCustomSections, ['.debug_info'])
  assert.equal(report.generatedWasmHardening.outputSha256, report.artifacts.wasm.sha256)
  assert.equal(report.rawWasmPathHygiene.localBuildPaths, false)
  assert.equal(report.generatedPackage.pathHygiene.length, report.generatedPackage.files.length)
  for (const mapping of report.buildHardening.sourcePathMappings) {
    assert.throws(() => verifyRestrictedWasmPaths(Buffer.from(mapping.source), report.buildHardening), /local producer path/)
  }
})

test('raw or generated local paths fail before a restricted package can become ready', async t => {
  for (const kind of ['rawPathLeak', 'generatedPathLeak']) {
    const f = await fixture({ restricted: true, [kind]: true }); t.after(f.cleanup)
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.equal(report.ready, false)
    assert.match(report.diagnostics.at(-1).message, /local producer path/)
  }
})

function moduleReferences(source, file) {
  const references = []
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      references.push(node.source.value)
    } else if (node.type === 'ImportExpression') {
      if (node.source?.type === 'Literal') references.push(node.source.value)
      else {
        const member = node.source, url = member?.object, target = url?.arguments?.[0], base = url?.arguments?.[1]
        const managerRuntimeImport = file === 'browser-dev-owner-manager.mjs' && node.options == null
          && member?.type === 'MemberExpression' && !member.computed && !member.optional
          && member.property?.type === 'Identifier' && member.property.name === 'href'
          && url?.type === 'NewExpression' && url.callee?.type === 'Identifier' && url.callee.name === 'URL'
          && url.arguments.length === 2 && target?.type === 'Literal'
          && ['worker-web-session.mjs', 'worker-admission-loader.mjs'].includes(target.value)
          && base?.type === 'Identifier' && base.name === 'baseUrl'
        if (managerRuntimeImport) references.push(`./${target.value}`)
        else assert.ok(['app.mjs', 'worker-admission-loader.mjs', 'host-services-media-browser-probe.mjs'].includes(file)
          && member?.type === 'Identifier' && member.name === 'url',
          `unclassified dynamic module dependency in ${file}`)
      }
      // Only the manager's two exact new URL(literal, baseUrl).href ASTs map to
      // captured runtime modules. This does not authorize a variable URL import
      // in any other module or execute the development manager in product graphs.
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(parseModule(source, { sourceType: 'module', ecmaVersion: 'latest' }))
  return references
}

async function browserModuleGraph(entries) {
  const root = new URL('../examples/hosts/web-wasm/', import.meta.url)
  const pending = [...entries], visited = new Set(), generated = new Set()
  while (pending.length) {
    const file = pending.pop().replace(/^\.\//, '')
    if (visited.has(file)) continue
    assert.ok(WEB_SAMPLE_FILES.includes(file), `missing local browser dependency: ${file}`)
    visited.add(file)
    for (const reference of moduleReferences(await readFile(new URL(file, root), 'utf8'), file)) {
      assert.ok(reference.startsWith('./') || reference.startsWith('../'), `unexpected external module in ${file}: ${reference}`)
      const target = new URL(reference, new URL(file, root))
      assert.ok(target.href.startsWith(root.href), `browser module escaped the staged root: ${reference}`)
      const path = target.href.slice(root.href.length)
      if (['pkg/container_host_web.js', 'worker-product-config.mjs'].includes(path)) generated.add(path)
      else pending.push(path)
    }
  }
  return { visited, generated }
}

const hostServicesAuxiliaryFiles = new Set(['browser-file-digest.mjs', 'browser-host-account-manager.mjs', 'browser-host-services.mjs', 'reference-identity-client.mjs', 'browser-bluetooth-owner.mjs',
  'browser-recorder-support.mjs', 'browser-wav-recorder.mjs', 'browser-wav-recorder-worklet.mjs', 'worker-host-services.mjs',
  'host-services-browser-probe.mjs', 'host-services-media-browser-probe.mjs', 'host-services-audio-browser-probe.mjs', 'host-services-recorder-browser-probe.mjs'])
test('default main, Worker and explicit legacy graphs have separate complete inventories', async () => {
  assert.equal(Object.isFrozen(WEB_SAMPLE_FILES), true)
  assert.equal(new Set(WEB_SAMPLE_FILES).size, WEB_SAMPLE_FILES.length)
  const root = new URL('../examples/hosts/web-wasm/', import.meta.url)
  const html = await readFile(new URL('index.html', root), 'utf8')
  const pageEntries = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1])
  assert.deepEqual(pageEntries, ['./worker-app.mjs'])
  const legacy = await readFile(new URL('legacy.html', root), 'utf8')
  assert.deepEqual([...legacy.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]), ['./app.mjs'])
  const main = await browserModuleGraph(pageEntries), worker = await browserModuleGraph(['./runtime-worker.mjs']), old = await browserModuleGraph(['./app.mjs'])
  assert.equal(main.visited.has('app.mjs'), false)
  assert.equal(main.visited.has('runtime-worker.mjs'), false)
  assert.equal(main.visited.has('browser-dev-owner-manager.mjs'), false)
  assert.equal(worker.visited.has('browser-dev-owner-manager.mjs'), false)
  assert.equal(old.visited.has('browser-dev-owner-manager.mjs'), false)
  assert.deepEqual([...main.generated], ['worker-product-config.mjs'])
  assert.deepEqual([...worker.generated], ['pkg/container_host_web.js'])
  assert.deepEqual([...old.generated], ['pkg/container_host_web.js'])
  assert.deepEqual([...new Set([...main.visited, ...worker.visited, ...old.visited])].sort(),
    WEB_SAMPLE_FILES.filter(file => !file.endsWith('.html') && file !== 'browser-dev-owner-manager.mjs' && !hostServicesAuxiliaryFiles.has(file)).sort())
  const app = parseModule(await readFile(new URL('app.mjs', root), 'utf8'), { sourceType: 'module', ecmaVersion: 'latest' })
  assert.ok(app.body.some(node => node.type === 'ImportDeclaration' && node.source.value === './pkg/container_host_web.js'),
    'The explicit legacy import preserves its old synchronous application host')
})

test('development manager graph is a distinct captured root without entering product or Worker execution graphs', async () => {
  const dev = await browserModuleGraph(['./browser-dev-owner-manager.mjs'])
  for (const file of ['browser-dev-owner-manager.mjs', 'worker-session-client.mjs', 'worker-web-session.mjs', 'worker-admission-loader.mjs'])
    assert.ok(dev.visited.has(file), `missing manager runtime dependency: ${file}`)
  assert.equal(dev.visited.has('app.mjs'), false)
  assert.equal(dev.visited.has('runtime-worker.mjs'), false)
  assert.deepEqual([...dev.generated], [], 'manager closure must not initialize application WASM on the main thread')
  const main = await browserModuleGraph(['./worker-app.mjs']), worker = await browserModuleGraph(['./runtime-worker.mjs']), legacy = await browserModuleGraph(['./app.mjs'])
  const product = new Set([...main.visited, ...worker.visited, ...legacy.visited])
  assert.equal(product.has('browser-dev-owner-manager.mjs'), false)
  assert.deepEqual([...new Set([...product, ...dev.visited])].sort(), WEB_SAMPLE_FILES.filter(file => !file.endsWith('.html') && !hostServicesAuxiliaryFiles.has(file)).sort())
})

test('host services adapters and explicit WASM probe form separate complete optional roots', async () => {
  // addModule loads the trusted processor in its own AudioWorkletGlobalScope;
  // it is an explicit execution root, not a main-thread static import.
  const probes=['./host-services-browser-probe.mjs','./host-services-media-browser-probe.mjs','./host-services-audio-browser-probe.mjs','./host-services-recorder-browser-probe.mjs']
  const graph=await browserModuleGraph([...probes,'./browser-wav-recorder-worklet.mjs','./browser-host-account-manager.mjs','./reference-identity-client.mjs'])
  for(const file of hostServicesAuxiliaryFiles) assert.ok(graph.visited.has(file),`missing host services source dependency: ${file}`)
  assert.deepEqual([...graph.generated],['pkg/container_host_web.js'])
  const product=await browserModuleGraph(['./worker-app.mjs','./runtime-worker.mjs','./app.mjs','./browser-dev-owner-manager.mjs'])
  for(const file of [...probes.map(value=>value.slice(2)),'browser-wav-recorder-worklet.mjs']) assert.equal(product.visited.has(file),false,'optional execution root must never enter normal app execution')
  assert.deepEqual([...new Set([...product.visited,...graph.visited])].sort(),WEB_SAMPLE_FILES.filter(file=>!file.endsWith('.html')).sort())
})

test('only two exact manager runtime dynamic-import AST forms enter its captured dependency graph', () => {
  for (const target of ['worker-web-session.mjs', 'worker-admission-loader.mjs']) {
    const source = `async function load(baseUrl) { return import(new URL('${target}', baseUrl).href) }`
    assert.deepEqual(moduleReferences(source, 'browser-dev-owner-manager.mjs'), [`./${target}`])
    assert.throws(() => moduleReferences(source, 'other.mjs'), /unclassified dynamic/)
  }
  for (const expression of [
    "new URL('worker-session-client.mjs', baseUrl).href",
    "new URL('./worker-web-session.mjs', baseUrl).href",
    "new URL('worker-web-session.mjs', otherBase).href",
    "new URL('worker-web-session.mjs', baseUrl)['href']",
    "new URL('worker-web-session.mjs', baseUrl).pathname",
    "new URL('worker-web-session.mjs', baseUrl, extra).href",
    "URL('worker-web-session.mjs', baseUrl).href",
    "new globalThis.URL('worker-web-session.mjs', baseUrl).href",
    "new URL(target, baseUrl).href",
    "new URL(`worker-web-session.mjs`, baseUrl).href",
    "new URL('worker-web-session.mjs', baseUrl)?.href",
    "url",
  ]) assert.throws(() => moduleReferences(`async function load(baseUrl) { return import(${expression}) }`, 'browser-dev-owner-manager.mjs'), /unclassified dynamic/)
  assert.throws(() => moduleReferences("async function load(baseUrl) { return import(new URL('worker-web-session.mjs', baseUrl).href, {with:{type:'json'}}) }", 'browser-dev-owner-manager.mjs'), /unclassified dynamic/)
  assert.deepEqual(moduleReferences('const load = url => import(url)', 'worker-admission-loader.mjs'), [])
  assert.throws(() => moduleReferences('const load = url => import(url)', 'other.mjs'), /unclassified dynamic/)
})

test('finite embedded Node tool static graph exactly matches its include members and captured source roots', async () => {
  // Reuse the source-bound pinned parser installed in this file's existing
  // test.before. Read/parse tool sources; never import them to discover edges.
  const root = new URL('../', import.meta.url)
  const expected = new Set(['scripts/browser-dev-artifacts-cli.mjs', 'scripts/browser-dev-artifacts.mjs',
    'scripts/build-web-wasm.mjs', 'scripts/generated-package-closure.mjs', 'scripts/lib/showcase-policy.mjs', 'examples/hosts/web-wasm/renderer-dependency-pins.json'])
  const pending = ['scripts/browser-dev-artifacts-cli.mjs'], visited = new Set(), edges = {}
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    assert.ok(expected.has(file), `unembedded finite-tool static dependency: ${file}`)
    visited.add(file); edges[file] = []
    const source = await readFile(new URL(file, root), 'utf8')
    if (file.endsWith('.json')) { JSON.parse(source); continue }
    assert.ok(file.endsWith('.mjs'), `unclassified static tool input type: ${file}`)
    const ast = parseModule(source, { sourceType: 'module', ecmaVersion: 'latest' })
    for (const node of ast.body) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue
      const reference = node.source.value
      assert.equal(typeof reference, 'string')
      if (reference.startsWith('node:')) { assert.ok(isBuiltin(reference), `unknown Node builtin: ${reference}`); continue }
      assert.ok(/^\.\.?\//.test(reference) && !/[\\%?#\x00-\x20\x7f:]/.test(reference), `nonlocal static tool import: ${reference}`)
      const target = new URL(reference, new URL(file, root))
      assert.ok(target.href.startsWith(root.href), `finite-tool import escaped root: ${reference}`)
      const path = target.href.slice(root.href.length)
      assert.ok(expected.has(path), `missing embedded static tool member: ${file} -> ${path}`)
      edges[file].push(path); pending.push(path)
    }
  }
  assert.deepEqual([...visited].sort(), [...expected].sort())
  assert.deepEqual(edges['scripts/browser-dev-artifacts-cli.mjs'], ['scripts/browser-dev-artifacts.mjs'])
  assert.deepEqual(edges['scripts/browser-dev-artifacts.mjs'].sort(), ['scripts/build-web-wasm.mjs', 'scripts/generated-package-closure.mjs', 'scripts/lib/showcase-policy.mjs'])
  assert.deepEqual(edges['scripts/build-web-wasm.mjs'].sort(), ['examples/hosts/web-wasm/renderer-dependency-pins.json', 'scripts/generated-package-closure.mjs', 'scripts/lib/showcase-policy.mjs'])
  assert.deepEqual(edges['scripts/generated-package-closure.mjs'], [])
  const rust = await readFile(new URL('crates/container-simulator/src/browser_dev_artifact_job.rs', root), 'utf8')
  const section = rust.match(/^const EMBEDDED_TOOL_FILES:[\s\S]*?=\s*&\[([\s\S]*?)^\];/m)
  assert.ok(section, 'missing embedded tool declaration')
  const member = /\(\s*"([^"]+)",\s*include_bytes!\(\s*"([^"]+)"\s*\),?\s*\),/g
  const includes = [...section[1].matchAll(member)]
  assert.equal(section[1].replace(member, '').trim(), '', 'unclassified embedded member expression')
  assert.equal(includes.length, expected.size)
  assert.deepEqual(includes.map(value => value[1]).sort(), [...expected].sort())
  for (const value of includes) assert.equal(value[2], `../../../${value[1]}`)
  const builder = parseModule(await readFile(new URL('scripts/build-web-wasm.mjs', root), 'utf8'), { sourceType: 'module', ecmaVersion: 'latest' })
  const inputs = builder.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .find(node => node.id?.type === 'Identifier' && node.id.name === 'SOURCE_INPUTS')?.init
  assert.equal(inputs?.type, 'ArrayExpression')
  const literals = new Set(inputs.elements.filter(node => node?.type === 'Literal').map(node => node.value))
  for (const file of expected) assert.ok(literals.has(file), `embedded include member missing from source capture: ${file}`)
  // These execute only through their independently verified runtime-input
  // boundary, not as static imports in this finite tool graph.
  assert.deepEqual(PORTABLE_PACK_VALIDATOR_FILES, ['scripts/portable-pack.mjs', 'scripts/modern-view-pack-resources.mjs', 'tools/container-manifest/src/json-integrity.mjs'])
  for (const runtimeInput of [...PORTABLE_PACK_VALIDATOR_FILES, 'examples/hosts/web-wasm/worker-admission-loader.mjs'])
    assert.equal(visited.has(runtimeInput), false, `runtime input was incorrectly mixed into static tool closure: ${runtimeInput}`)
})

async function stageBrowserAssets(source, outDir) {
  const path = 'worker-product-config.mjs'
  if (!existsSync(resolve(outDir, path))) {
    const index = await stagePackIndex(outDir, { schemaVersion: 1, test: 'direct staging fixture' })
    await stageWorkerProductConfig(outDir, { index, rendererConfig: rendererRuntimeConfig('software') })
  }
  const generatedFiles = []
  for (const path of ['worker-product-config.mjs', 'worker-product-config.json']) {
    const bytes = await readFile(resolve(outDir, path))
    generatedFiles.push({ path, sha256: sha256(bytes), size: bytes.length })
  }
  return rawStageBrowserAssets(source, outDir, { execution: 'legacy', generatedFiles })
}

test('staging uses frozen browser bytes and records hashes for every Worker and DOM resource', async () => {
  const f = await fixture()
  try {
    const source = await snapshotBuildSource(f.root, f.plan.sourceDir, f.run)
    for (const file of WEB_SAMPLE_FILES) await writeFile(resolve(f.root, 'examples/hosts/web-wasm', file), 'mutated original after freezing')
    const assets = await stageBrowserAssets(source, f.outDir)
    assert.deepEqual(assets.files.map(file => file.path), WEB_SAMPLE_FILES)
    for (const file of assets.files) {
      const bytes = await readFile(resolve(f.outDir, file.path))
      assert.equal(bytes.toString(), f.sourceFiles[file.sourcePath])
      assert.equal(sha256(bytes), source.sourceFiles[file.sourcePath])
      assert.equal(file.sha256, source.sourceFiles[file.sourcePath])
      assert.equal(file.size, bytes.length)
    }
    await verifyRetainedBrowserAssets(f.outDir, assets)
    assert.equal(assets.retainedStatus, 'passed')
    await assert.rejects(stageBrowserAssets(source, f.outDir), { code: 'EEXIST' })
  } finally { await f.cleanup() }
})

test('each missing Worker or DOM source fails before staging any browser asset or running a build tool', async t => {
  for (const file of ['runtime-worker.mjs', 'worker-runtime.mjs', 'worker-session-client.mjs',
    'worker-bridge-transport.mjs', 'dom-presenter.mjs', 'dom-session-client.mjs', 'dom-animation-sample.mjs', 'worker-app.mjs', 'legacy.html',
    'worker-web-session.mjs', 'presentation-scheduler.mjs', 'worker-dom-adapter.mjs',
    'worker-canvaskit-adapter.mjs', 'worker-admission-loader.mjs', 'browser-dev-owner-manager.mjs', 'input-causal-ledger.mjs']) await t.test(file, async () => {
    const f = await fixture({ omitSourceFile: `examples/hosts/web-wasm/${file}` })
    try {
      const report = await f.build()
      assert.equal(report.status, 'failed')
      assert.equal(report.ready, false)
      assert.match(report.diagnostics.at(-1).message, /Browser asset source is missing from the inventory/)
      assert.ok(f.calls.every(call => call.binary === 'git'))
      assert.equal(existsSync(resolve(f.outDir, 'index.html')), false)
      assert.equal(existsSync(resolve(f.outDir, 'browser-assets.json')), false)
    } finally { await f.cleanup() }
  })
})

test('staging rejects modified frozen inputs before publishing any browser assets', async () => {
  const f = await fixture()
  try {
    const source = await snapshotBuildSource(f.root, f.plan.sourceDir, f.run)
    await writeFile(resolve(source.snapshotDirectory, 'examples/hosts/web-wasm/dom-presenter.mjs'), 'mutated frozen presenter')
    await assert.rejects(stageBrowserAssets(source, f.outDir), /Browser asset changed before staging.*dom-presenter/)
    assert.equal(existsSync(resolve(f.outDir, 'index.html')), false)
    const location = resolve(source.snapshotDirectory, 'examples/hosts/web-wasm/dom-presenter.mjs')
    await rm(location)
    await symlink(resolve(f.root, 'examples/hosts/web-wasm/dom-presenter.mjs'), location)
    await assert.rejects(stageBrowserAssets(source, f.outDir), /Browser asset must be a regular file inside the snapshot/)
    assert.equal(existsSync(resolve(f.outDir, 'index.html')), false)
  } finally { await f.cleanup() }
})

test('retained browser assets reject mutations, deleted closure files and symlink substitutions', async t => {
  for (const kind of ['bytes', 'missing', 'symlink', 'inventory']) await t.test(kind, async () => {
    const f = await fixture()
    try {
      const source = await snapshotBuildSource(f.root, f.plan.sourceDir, f.run)
      const assets = await stageBrowserAssets(source, f.outDir)
      const file = resolve(f.outDir, 'worker-bridge-transport.mjs')
      if (kind === 'bytes') await writeFile(file, 'mutated retained bridge')
      else if (kind === 'inventory') await writeFile(resolve(f.outDir, 'browser-assets.json'), '{}')
      else {
        await rm(file)
        if (kind === 'symlink') await symlink(resolve(source.snapshotDirectory, 'examples/hosts/web-wasm/worker-bridge-transport.mjs'), file)
      }
      await assert.rejects(verifyRetainedBrowserAssets(f.outDir, assets))
      assert.equal(assets.retainedStatus, 'failed')
    } finally { await f.cleanup() }
  })
})

test('CLI requires separate pack/output and explicit LLVM, with release and locked defaults', () => {
  assert.throws(() => parseArgs(['--pack']), /missing value/)
  assert.throws(() => parseArgs(['--unknown', 'x']), /Unknown/)
  assert.throws(() => createBuildPlan({ pack: '/pack', outDir: '/pack/output', llvmBin: '/llvm' }), /separate/)
  assert.throws(() => createBuildPlan({ pack: '/pack', outDir: '/output' }, { environment: {} }), /llvm-bin/)
  const plan = createBuildPlan(parseArgs(['--pack', '/pack', '--out-dir', '/output', '--offline']), { root: '/project', environment: { WEAPP_CONTAINER_LLVM_BIN: '/llvm', WEAPP_CONTAINER_WASM_BINDGEN: '/bin/bindgen' } })
  assert.equal(plan.profile, 'release')
  assert.equal(plan.wasmBindgen, '/bin/bindgen')
  assert.equal(plan.renderer, 'software')
  assert.equal(plan.execution, 'worker')
  assert.equal(plan.entry, 'index.html')
  assert.equal(plan.entryModule, 'worker-app.mjs')
  assert.equal(plan.plannedAppServiceThread, 'worker')
  const legacy = createBuildPlan({ pack: '/pack', outDir: '/output', llvmBin: '/llvm', execution: 'legacy' })
  assert.equal(legacy.entry, 'legacy.html')
  assert.equal(legacy.plannedAppServiceThread, 'main')
  assert.throws(() => createBuildPlan({ pack: '/pack', outDir: '/output', llvmBin: '/llvm', execution: 'fallback' }), /execution/)
  assert.equal(plan.jobs, 4)
  assert.equal(plan.cargoArgs[plan.cargoArgs.indexOf('--jobs') + 1], '4')
  assert.ok(plan.cargoArgs.includes('--locked') && plan.cargoArgs.includes('--release') && plan.cargoArgs.includes('--offline'))
  assert.equal(plan.cargoArgs[plan.cargoArgs.indexOf('--features') + 1], 'wasm,quickjs-native')
})

test('Cargo cache ownership distinguishes explicit paths from one-build disposable output', () => {
  const base = { pack: '/pack', outDir: '/output', llvmBin: '/llvm' }
  const automatic = createBuildPlan(base, { environment: {} })
  assert.equal(automatic.targetDir, '/output/cargo-target')
  assert.equal(automatic.targetDirectorySource, 'build')
  assert.equal(automatic.keepCargoCache, false)
  const inherited = createBuildPlan(base, { environment: { CARGO_TARGET_DIR: '/shared' } })
  assert.equal(inherited.targetDir, '/shared')
  assert.equal(inherited.targetDirectorySource, 'environment')
  const explicit = createBuildPlan({ ...base, targetDir: '/explicit' }, { environment: { CARGO_TARGET_DIR: '/shared' } })
  assert.equal(explicit.targetDir, '/explicit')
  assert.equal(explicit.targetDirectorySource, 'argument')
  const relativeEnvironment = createBuildPlan(base, { root: '/source-root', environment: { CARGO_TARGET_DIR: 'target/shared' } })
  assert.equal(relativeEnvironment.targetDir, '/source-root/target/shared')
  const relativeArgument = createBuildPlan({ ...base, targetDir: 'target/explicit' }, { root: '/source-root', environment: { CARGO_TARGET_DIR: 'target/shared' } })
  assert.equal(relativeArgument.targetDir, resolve('target/explicit'))
  assert.equal(createBuildPlan({ ...base, ...parseArgs(['--keep-cargo-cache']) }, { environment: {} }).keepCargoCache, true)
  assert.throws(() => parseArgs(['--keep-cargo-cache', '--keep-cargo-cache']), /Duplicate/)
  assert.throws(() => createBuildPlan({ ...base, keepCargoCache: 'false' }, { environment: {} }), /must be a boolean/)
})

test('explicit bounded Cargo jobs are recorded without a custom build environment', () => {
  const base = { pack: '/pack', outDir: '/output', llvmBin: '/llvm' }
  const parsed = parseArgs(['--jobs', '2'])
  const plan = createBuildPlan({ ...base, ...parsed }, { environment: {} })
  assert.equal(plan.jobs, 2)
  assert.equal(plan.cargoArgs[plan.cargoArgs.indexOf('--jobs') + 1], '2')
  assert.throws(() => parseArgs(['--jobs', '2', '--jobs', '4']), /Duplicate/)
  for (const jobs of [0, -1, 1.5, 257, '', '01', '1e2', '4 ', Infinity]) {
    assert.throws(() => createBuildPlan({ ...base, jobs }), /--jobs must be an integer/)
  }
})

test('CanvasKit selection requires all explicit local inputs and never silently changes renderer', () => {
  const base = { pack: '/pack', outDir: '/output', llvmBin: '/llvm' }
  assert.throws(() => createBuildPlan({ ...base, renderer: 'gpu-auto' }), /must be software or canvaskit/)
  for (const missing of ['canvaskitDir', 'fontFile', 'fontLicenseFile']) {
    const options = { ...base, renderer: 'canvaskit', canvaskitDir: '/canvaskit', fontFile: '/font.ttf', fontLicenseFile: '/OFL.txt' }
    delete options[missing]
    assert.throws(() => createBuildPlan(options), /requires explicit/)
  }
  assert.throws(() => createBuildPlan({ ...base, canvaskitDir: '/canvaskit' }), /require --renderer canvaskit/)
  const options = parseArgs(['--pack', '/pack', '--out-dir', '/output', '--llvm-bin', '/llvm',
    '--renderer', 'canvaskit', '--canvaskit-dir', '/canvaskit', '--font-file', '/font.ttf', '--font-license-file', '/OFL.txt'])
  const plan = createBuildPlan(options)
  assert.equal(plan.renderer, 'canvaskit')
  assert.equal(plan.fontLicenseFile, '/OFL.txt')
  assert.throws(() => createBuildPlan({ ...options, fontFile: '/output/input.ttf' }), /outside the build output/)
})

test('renderer runtime contract binds the full CanvasKit variant, font and both licenses to fixed bytes', () => {
  assert.deepEqual(rendererRuntimeConfig('software'), { schemaVersion: 1, renderer: 'software', fallback: 'error' })
  const config = rendererRuntimeConfig('canvaskit')
  assert.equal(config.fallback, 'error')
  assert.equal(config.canvaskit.version, '0.42.0')
  assert.equal(config.canvaskit.variant, 'full')
  assert.equal(config.canvaskit.javascript.sha256, '894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5')
  assert.equal(config.canvaskit.wasm.sha256, 'aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959')
  assert.equal(config.canvaskit.license.sha256, 'd27678cba0d529e77201e2d2a053628143e986aad8f1e77f7039ad4366c8f978')
  assert.equal(config.font.binary.sha256, '916bd5146cd1099aff18931fd0c85f4f3fd1ff7b2c966cb3cc22a4e5a6216983')
  assert.equal(config.font.license.sha256, '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9')
  const inputs = rendererDependencyInputs({ renderer: 'canvaskit', canvaskitDir: '/inputs/canvaskit', fontFile: '/inputs/font.ttf', fontLicenseFile: '/inputs/OFL.txt' })
  assert.deepEqual(inputs.map(input => input.sourcePath), ['/inputs/canvaskit/bin/full/canvaskit.js', '/inputs/canvaskit/bin/full/canvaskit.wasm',
    '/inputs/canvaskit/LICENSE', '/inputs/canvaskit/package.json', '/inputs/font.ttf', '/inputs/OFL.txt'])
  assert.ok(inputs.every(input => Object.isFrozen(RENDERER_DEPENDENCY_PINS[input.id])))
  assert.equal(inputs[0].provenance.archiveVerifiedAtBuild, false)
  assert.equal(inputs[0].provenance.url, 'https://registry.npmjs.org/canvaskit-wasm/-/canvaskit-wasm-0.42.0.tgz')
  assert.match(inputs.at(-1).provenance.url, /a85815a42757630ce188fdad368c2dfc444d4773\/ofl\/notosanssc\/OFL.txt$/)
})

test('pinned asset copier freezes verified bytes and retained verification detects later tampering', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weapp-renderer-assets-'))
  try {
    const outDir = resolve(directory, 'output')
    await mkdir(outDir)
    const bytes = Buffer.from('a fixed unit-test dependency\n')
    const sourcePath = resolve(directory, 'input.bin')
    await writeFile(sourcePath, bytes)
    const input = { id: 'fixture', sourcePath, url: 'vendor/fixture.bin', sha256: sha256(bytes), size: bytes.length,
      provenance: { url: 'https://example.invalid/test-fixture-only' } }
    const copied = await copyPinnedRendererDependency(input, outDir)
    assert.equal(copied.verified, true)
    assert.equal(copied.sourcePath, sourcePath)
    assert.deepEqual(await readFile(resolve(outDir, input.url)), bytes)
    const staged = await stageRendererDependencies({ renderer: 'software', outDir })
    staged.files.push(copied)
    await writeFile(sourcePath, 'mutated source after the verified snapshot')
    await verifyRetainedRendererDependencies(outDir, staged)
    await assert.rejects(copyPinnedRendererDependency(input, outDir), /SHA-256 or size mismatch/)
    await writeFile(resolve(outDir, input.url), 'tampered retained copy')
    await assert.rejects(verifyRetainedRendererDependencies(outDir, staged), /Retained renderer dependency changed/)
    assert.equal(staged.retainedStatus, 'failed')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('renderer asset trust rejects wrong bytes, wrong sizes, symlinks and escaped output paths', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weapp-renderer-invalid-'))
  try {
    const sourcePath = resolve(directory, 'canvaskit.js')
    const bytes = Buffer.from('filename and package version are not identity\n')
    await writeFile(sourcePath, bytes)
    const outDir = resolve(directory, 'output')
    await mkdir(outDir)
    for (const pin of Object.values(RENDERER_DEPENDENCY_PINS)) {
      await assert.rejects(copyPinnedRendererDependency({ ...pin, sourcePath }, outDir), /SHA-256 or size mismatch/)
    }
    const fixturePin = { sourcePath, url: 'vendor/fixture.bin', sha256: sha256(bytes), size: bytes.length }
    await assert.rejects(copyPinnedRendererDependency({ ...fixturePin, size: bytes.length + 1 }, outDir), /SHA-256 or size mismatch/)
    await symlink(sourcePath, resolve(directory, 'linked-input'))
    await assert.rejects(copyPinnedRendererDependency({ ...fixturePin, sourcePath: resolve(directory, 'linked-input') }, outDir), /regular file/)
    await assert.rejects(copyPinnedRendererDependency({ ...fixturePin, url: '../escaped.bin' }, outDir), /escapes/)
    assert.deepEqual(await readdir(outDir), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('untrusted same-name CanvasKit inputs fail after source freezing before any build tool and never fall back to software', async () => {
  const f = await fixture({ renderer: 'canvaskit' })
  try {
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.equal(report.ready, false)
    assert.equal(report.plan.renderer, 'canvaskit')
    assert.match(report.diagnostics[0].message, /Pinned renderer dependency SHA-256 or size mismatch/)
    assert.ok(f.calls.length > 0)
    assert.ok(f.calls.every(call => call.binary === 'git'))
    assert.equal(existsSync(resolve(f.outDir, 'runtime-config.json')), false)
  } finally { await f.cleanup() }
})

test('bindgen pin parser rejects ambiguous or missing versions', () => {
  const lock = '[[package]]\nname = "wasm-bindgen"\nversion = "0.2.129"\n'
  assert.equal(lockedWasmBindgenVersion(lock), '0.2.129')
  assert.throws(() => lockedWasmBindgenVersion(lock + lock), /exactly one/)
  assert.throws(() => lockedWasmBindgenVersion('[[package]]\nname="another"'), /exactly one/)
})

test('WASM interface accepts exact function exports and the observed wasm-bindgen 16-hex suffix', () => {
  for (const suffix of ['', BINDGEN_SUFFIX]) {
    const exports = WASM_REQUIRED_EXPORTS.map(name => ({ name: name + suffix, kind: 'function' }))
    const matched = verifyWasmExports(exports)
    for (const name of WASM_REQUIRED_EXPORTS) assert.deepEqual(matched[name], [name + suffix])
  }
})

test('an older WASM host cannot pass the browser owner interface gate', () => {
  for (const name of ['dispatch_batch_json', 'browser_view_resource', 'notify_window_metrics_json', 'retire_browser_preview', 'set_render_scale']) {
    assert.ok(GLUE_REQUIRED_METHODS.includes(name), `${name} must exist in generated glue`)
    const exported = `webwasmhost_${name}`
    assert.ok(WASM_REQUIRED_EXPORTS.includes(exported))
    const old = WASM_REQUIRED_EXPORTS.filter(value => value !== exported).map(name => ({ name, kind: 'function' }))
    assert.throws(() => verifyWasmExports(old), /missing the WebWasmHost/)
  }
})

for (const impostor of [
  name => `__wbindgen_describe_${name}${BINDGEN_SUFFIX}`,
  name => `${name}_144b20889b08dae`,
  name => `${name}_144b20889b08dae80`,
  name => `${name}_144b20889b08daeg`,
  name => `${name}${BINDGEN_SUFFIX}_extra`,
  name => `${name}_extra`,
  name => `prefix_${name}`,
]) test(`WASM interface rejects a descriptor or prefix impostor: ${impostor('webwasmhost_new')}`, () => {
  assert.throws(() => verifyWasmExports(WASM_REQUIRED_EXPORTS.map(name => ({ name: impostor(name), kind: 'function' }))), /missing the WebWasmHost/)
})

test('WASM interface requires callable exports rather than same-named memories or globals', () => {
  for (const kind of ['memory', 'global', 'table']) {
    assert.throws(() => verifyWasmExports(WASM_REQUIRED_EXPORTS.map(name => ({ name, kind }))), /missing the WebWasmHost/)
  }
})

for (const [name, alternatives] of [
  ['bare and suffixed methods', ['webwasmhost_new', `webwasmhost_new${BINDGEN_SUFFIX}`]],
  ['two valid method suffixes', [`webwasmhost_new${BINDGEN_SUFFIX}`, 'webwasmhost_new_0123456789abcdef']],
  ['duplicate method names', ['webwasmhost_new', 'webwasmhost_new']],
]) test(`WASM interface rejects ambiguous or duplicate exports: ${name}`, () => {
  const exports = WASM_REQUIRED_EXPORTS.filter(name => name !== 'webwasmhost_new')
    .concat(alternatives).map(name => ({ name, kind: 'function' }))
  assert.throws(() => verifyWasmExports(exports), /ambiguous or duplicate.*webwasmhost_new/)
})

test('build uses frozen sources, real cdylib output, locked tools and exact pack/WASM hashes', async () => {
  const f = await fixture({ changeOriginalDuringBuild: true, changeOriginalValidatorDuringBuild: true, changeOriginalBrowserAssetDuringBuild: true })
  try {
    const report = await f.build()
    assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
    assert.equal(report.ready, true)
    assert.equal(report.browserStatus, 'not-run')
    assert.equal(report.gpuStatus, 'unknown')
    assert.equal(report.rendererDependencies.renderer, 'software')
    assert.equal(report.rendererDependencies.retainedStatus, 'passed')
    assert.equal(report.packValidator.entry, 'scripts/portable-pack.mjs')
    assert.deepEqual(Object.keys(report.packValidator.sourceFiles), PORTABLE_PACK_VALIDATOR_FILES)
    for (const file of PORTABLE_PACK_VALIDATOR_FILES) {
      assert.equal(report.source.sourceFiles[file], sha256(f.sourceFiles[file]))
      assert.equal(report.packValidator.sourceFiles[file], report.source.sourceFiles[file])
    }
    assert.equal(report.packValidator.sourceSha256, sha256(JSON.stringify(report.packValidator.sourceFiles)))
    assert.deepEqual(JSON.parse(await readFile(resolve(f.outDir, 'runtime-config.json'))), { schemaVersion: 1, renderer: 'software', fallback: 'error' })
    const index = JSON.parse(await readFile(resolve(f.outDir, 'pack-index.json')))
    assert.equal(index.manifestSha256, sha256(await readFile(resolve(f.outDir, index.manifest))))
    for (const blob of index.blobs) {
      const bytes = await readFile(resolve(f.outDir, blob.url))
      assert.equal(blob.sha256, sha256(bytes))
      assert.equal(blob.size, bytes.length)
    }
    assert.equal(report.artifacts.wasm.sha256, sha256(await readFile(resolve(f.outDir, report.artifacts.wasm.path))))
    assert.deepEqual(report.rawWasm.interfaceExports.webwasmhost_new, [`webwasmhost_new${BINDGEN_SUFFIX}`])
    assert.deepEqual(report.artifacts.wasm.interfaceExports.webwasmhost_new, ['webwasmhost_new'])
    assert.ok(GLUE_REQUIRED_METHODS.every(name => report.artifacts.glue.interface.methods.includes(name)))
    assert.ok(f.calls.some(call => call.binary === process.execPath), 'Generated glue is imported and reflected in an owned process')
    assert.equal((await readdir(resolve(f.outDir, 'pkg'))).some(name => name.startsWith('.web-wasm-interface-')), false)
    assert.equal(f.environment.SDKROOT, '/inherited-apple-sdk')
    assert.equal(f.environment.SDKTARGETSYSROOT, '/inherited-other-sdk')
    assert.equal(report.browserAssets.retainedStatus, 'passed')
    assert.equal(report.browserAssets.appServiceThread, 'main')
    assert.equal(report.browserAssets.entry, 'legacy.html')
    assert.equal(report.browserAssets.productExecution.status, 'not-run')
    assert.equal(report.browserAssets.workerProductEnabled, false)
    assert.deepEqual(report.browserAssets.files.map(file => file.path), WEB_SAMPLE_FILES)
    const browserInventory = await readFile(resolve(f.outDir, report.browserAssets.inventory.path))
    assert.equal(sha256(browserInventory), report.browserAssets.inventory.sha256)
    assert.equal(browserInventory.length, report.browserAssets.inventory.size)
    assert.deepEqual(JSON.parse(browserInventory).files, report.browserAssets.files)
    for (const file of report.browserAssets.files) {
      const bytes = await readFile(resolve(f.outDir, file.path))
      assert.deepEqual(bytes, await readFile(resolve(f.plan.sourceDir, file.sourcePath)))
      assert.equal(sha256(bytes), file.sha256)
      assert.equal(bytes.length, file.size)
      assert.equal(report.source.sourceFiles[file.sourcePath], file.sha256)
    }
    assert.ok(f.calls.every(call => !call.args.includes('check')), 'The gate actually links, rather than running cargo check')
    assert.equal(JSON.parse(await readFile(resolve(f.outDir, 'build-report.json'))).status, 'passed')
  } finally { await f.cleanup() }
})

test('successful builds remove only their compilation cache while retaining exact raw WASM and browser evidence', async () => {
  const f = await fixture()
  try {
    const report = await f.build()
    assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
    assert.equal(report.cargoCache.ownership, 'build')
    assert.equal(report.cargoCache.status, 'removed')
    assert.equal(existsSync(f.plan.targetDir), false)
    assert.equal(sha256(await readFile(report.rawWasm.copiedPath)), report.rawWasm.sha256)
    assert.equal(sha256(await readFile(resolve(f.outDir, report.artifacts.wasm.path))), report.artifacts.wasm.sha256)
    assert.ok(existsSync(resolve(f.outDir, 'source-snapshot.json')))
    assert.ok(existsSync(resolve(f.outDir, 'cargo-build.jsonl')))
    assert.equal(JSON.parse(await readFile(resolve(f.outDir, 'build-report.json'))).cargoCache.status, 'removed')
  } finally { await f.cleanup() }
})

for (const kind of ['failure', 'cancellation']) test(`${kind} removes the partial Cargo cache after the command settles`, async () => {
  const controller = kind === 'cancellation' ? new AbortController() : undefined
  const f = await fixture(kind === 'failure' ? { cargoFails: true } : { abortDuringCargo: controller })
  try {
    const report = await f.build()
    assert.equal(report.status, kind === 'failure' ? 'failed' : 'cancelled')
    assert.equal(report.ready, false)
    assert.equal(report.cargoCache.status, 'removed')
    assert.equal(existsSync(f.plan.targetDir), false)
    assert.ok(existsSync(resolve(f.outDir, 'source-snapshot.json')))
    assert.match(report.diagnostics[0].message, kind === 'failure' ? /mock Cargo link failed/ : /mock Cargo cancellation settled/)
  } finally { await f.cleanup() }
})

for (const kind of ['argument', 'environment', 'keep']) test(`${kind} Cargo cache retention preserves existing caller files`, async () => {
  const f = await fixture(kind === 'keep' ? { keepCargoCache: true } : { targetDirectorySource: kind })
  try {
    if (kind !== 'keep') {
      await mkdir(f.plan.targetDir)
      await writeFile(resolve(f.plan.targetDir, 'caller-file'), 'preserve this existing cache')
    }
    const report = await f.build()
    assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
    assert.equal(report.cargoCache.status, 'retained')
    assert.equal(report.cargoCache.retention, 'keep')
    assert.equal(report.cargoCache.ownership, kind === 'keep' ? 'build' : 'caller')
    assert.ok(existsSync(resolve(f.plan.targetDir, 'partial.o')))
    if (kind !== 'keep') assert.equal(await readFile(resolve(f.plan.targetDir, 'caller-file'), 'utf8'), 'preserve this existing cache')
  } finally { await f.cleanup() }
})

for (const kind of ['argument', 'environment']) test(`failed builds leave the ${kind} caller-owned Cargo cache intact`, async () => {
  const f = await fixture({ targetDirectorySource: kind, cargoFails: true })
  try {
    await mkdir(f.plan.targetDir)
    await writeFile(resolve(f.plan.targetDir, 'caller-file'), 'retained after failure')
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.equal(report.cargoCache.status, 'retained')
    assert.equal(await readFile(resolve(f.plan.targetDir, 'caller-file'), 'utf8'), 'retained after failure')
    assert.ok(existsSync(resolve(f.plan.targetDir, 'partial.o')))
  } finally { await f.cleanup() }
})

test('cache replacement with a symlink fails visibly and preserves its outside target', async () => {
  const f = await fixture({ replaceCacheWithSymlink: true })
  try {
    const report = await f.build()
    assert.equal(report.buildStatus, 'passed')
    assert.equal(report.status, 'failed')
    assert.equal(report.ready, false)
    assert.equal(report.cargoCache.status, 'cleanup-failed')
    assert.equal(report.diagnostics.at(-1).code, 'ERR_CARGO_CACHE_CLEANUP')
    assert.match(report.diagnostics.at(-1).message, /identity changed/)
    assert.equal(await readFile(resolve(f.directory, 'caller-owned/retained'), 'utf8'), 'caller data')
    assert.equal(JSON.parse(await readFile(resolve(f.outDir, 'build-report.json'))).cargoCache.status, 'cleanup-failed')
  } finally { await f.cleanup() }
})

test('unverified command descendants prevent cache removal and remain visible in the report', async () => {
  const f = await fixture({ unverifiedCommandCleanup: true })
  try {
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.equal(report.cargoCache.status, 'cleanup-failed')
    assert.ok(existsSync(resolve(f.plan.targetDir, 'partial.o')))
    assert.equal(report.diagnostics.at(-1).code, 'ERR_CARGO_CACHE_CLEANUP')
    assert.match(report.diagnostics.at(-1).message, /process-group cleanup is unverified/)
  } finally { await f.cleanup() }
})

test('the real frozen validator needs no npm dependencies and ignores later original helper changes', async () => {
  const f = await fixture()
  try {
    const source = await snapshotBuildSource(f.root, f.plan.sourceDir, f.run)
    assert.equal(existsSync(resolve(f.plan.sourceDir, 'node_modules')), false)
    assert.equal(existsSync(resolve(f.plan.sourceDir, 'tools/container-manifest/src/index.ts')), false)
    // Poison the original entry and helper before the frozen module is first
    // imported. Resolving either one from the original project must fail.
    for (const file of PORTABLE_PACK_VALIDATOR_FILES) {
      await writeFile(resolve(f.root, file), "throw new Error('mutable original validator must not execute')\n")
    }
    const validator = await loadFrozenPackValidator(source)
    const destination = resolve(f.directory, 'verified-pack')
    const result = await validator.syncPortablePack({ source: f.pack, destination })
    assert.ok(result.blobCount > 0)
    assert.equal((await validator.syncPortablePack({ source: f.pack, destination, check: true })).mode, 'check')
    assert.deepEqual(await readFile(resolve(destination, 'manifest.json')), await readFile(resolve(f.pack, 'manifest.json')))
    for (const file of PORTABLE_PACK_VALIDATOR_FILES) {
      assert.equal(validator.provenance.sourceFiles[file], sha256(await readFile(resolve(source.snapshotDirectory, file))))
    }
  } finally { await f.cleanup() }
})

test('an incomplete frozen validator inventory fails before any build tool runs', async t => {
  for (const file of PORTABLE_PACK_VALIDATOR_FILES) await t.test(file, async () => {
    const f = await fixture({ omitSourceFile: file })
    try {
      const report = await f.build()
      assert.equal(report.status, 'failed')
      assert.equal(report.ready, false)
      assert.match(report.diagnostics.at(-1).message, /Frozen pack validator source is missing from the inventory/)
      assert.ok(f.calls.length > 0)
      assert.ok(f.calls.every(call => call.binary === 'git'))
      assert.equal(existsSync(resolve(f.outDir, 'portable-pack')), false)
    } finally { await f.cleanup() }
  })
})

test('a frozen validator changed before its first import is rejected', async () => {
  const f = await fixture()
  try {
    const source = await snapshotBuildSource(f.root, f.plan.sourceDir, f.run)
    await writeFile(resolve(source.snapshotDirectory, 'scripts/modern-view-pack-resources.mjs'), "throw new Error('must fail hash verification before import')\n")
    await assert.rejects(loadFrozenPackValidator(source), /Frozen pack validator changed before import/)
    assert.ok(f.calls.every(call => call.binary === 'git'))
  } finally { await f.cleanup() }
})

test('post-bindgen suffixed exports and relative JavaScript snippet imports remain valid', async () => {
  const f = await fixture({ bindgenSuffixed: true, glueRelativeImport: true })
  try {
    const report = await f.build()
    assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
    assert.deepEqual(report.artifacts.wasm.interfaceExports.webwasmhost_new, [`webwasmhost_new${BINDGEN_SUFFIX}`])
    assert.equal(report.generatedPackage.retainedStatus, 'passed')
    const pkgFiles = new Set(report.generatedPackage.files.map(file => file.path))
    assert.ok(pkgFiles.has('pkg/glue-helper.mjs'))
    for (const file of report.generatedPackage.files.filter(file => /\.(?:js|mjs)$/.test(file.path))) {
      for (const reference of moduleReferences(await readFile(resolve(f.outDir, file.path), 'utf8'), file.path)) {
        assert.ok(reference.startsWith('./') || reference.startsWith('../'), 'generated imports must remain local')
        const target = new URL(reference, new URL(file.path, 'https://pkg.invalid/')).pathname.slice(1)
        assert.ok(target.startsWith('pkg/') && pkgFiles.has(target), `unretained generated import: ${reference}`)
      }
    }
  } finally { await f.cleanup() }
})

test('worker build plans actual default entry but never certify product execution', async () => {
  const f = await fixture({ execution: 'worker', webviewPack: true })
  try {
    const report = await f.build()
    assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
    assert.equal(report.ready, true)
    assert.equal(report.plan.entry, 'index.html')
    assert.equal(report.browserAssets.entryModule, 'worker-app.mjs')
    assert.equal(report.browserAssets.plannedAppServiceThread, 'worker')
    assert.equal(report.browserAssets.appServiceThread, 'unknown')
    assert.equal(report.browserAssets.workerProductEnabled, false)
    assert.equal(report.browserAssets.productExecution.status, 'not-run')
    assert.equal(report.workerPackAdmission.requiresCanvasKit, false)
    assert.ok(report.workerPackAdmission.routes.every(route => route.transportBackend === 'browser-view'))
    const bytes = await readFile(resolve(f.outDir, 'pack-index.json'))
    assert.equal(report.packIndex.sha256, sha256(bytes))
    assert.equal(report.packIndex.size, bytes.length)
    assert.deepEqual(report.workerProductConfig.value.index, { url: './pack-index.json', sha256: sha256(bytes), size: bytes.length })
    const descriptor = report.browserAssets.generatedFiles[0]
    assert.equal(descriptor.path, 'worker-product-config.mjs')
    assert.equal(Object.hasOwn(report.source.sourceFiles, 'examples/hosts/web-wasm/worker-product-config.mjs'), false)
    assert.equal(descriptor.sha256, sha256(await readFile(resolve(f.outDir, descriptor.path))))
    const startup = report.browserAssets.generatedFiles[1]
    assert.deepEqual(startup, report.workerProductConfig.startupJson)
    assert.equal(startup.sha256, sha256(await readFile(resolve(f.outDir, startup.path))))
    assert.deepEqual(JSON.parse(await readFile(resolve(f.outDir, startup.path))), report.workerProductConfig.value)
  } finally { await f.cleanup() }
})

test('worker external-frame routes explicitly reject absent CanvasKit assets without legacy fallback', async () => {
  const f = await fixture({ execution: 'worker' })
  try {
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.equal(report.ready, false)
    assert.match(report.diagnostics.at(-1).message, /external-frame routes/)
    assert.ok(f.calls.every(call => call.binary === 'git'))
  } finally { await f.cleanup() }
})

test('exact emitted index bytes including newline bind the generated configuration', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'worker-product-pin-'))
  try {
    const value = { schemaVersion: 1, marker: '中文' }
    const index = await stagePackIndex(directory, value)
    const bytes = await readFile(resolve(directory, 'pack-index.json'))
    assert.deepEqual(bytes, Buffer.from(JSON.stringify(value, null, 2) + '\n'))
    const generated = await stageWorkerProductConfig(directory, { index, rendererConfig: rendererRuntimeConfig('software') })
    assert.equal(generated.value.index.sha256, sha256(bytes))
    assert.notEqual(generated.value.index.sha256, sha256(JSON.stringify(value)))
    assert.equal(generated.value.rendererAssets, null)
    assert.equal(generated.size, (await readFile(resolve(directory, generated.path))).length)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('frozen pure Worker admission rejects a changed loader before importing it', async () => {
  const f = await fixture({ execution: 'worker', webviewPack: true })
  try {
    const source = await snapshotBuildSource(f.root, f.plan.sourceDir, f.run)
    const path = resolve(source.snapshotDirectory, 'examples/hosts/web-wasm/worker-admission-loader.mjs')
    await writeFile(path, "throw new Error('unverified module must not execute')\n")
    await assert.rejects(inspectWorkerPackAdmission(source, f.outDir, { path: 'pack-index.json', sha256: 'a'.repeat(64), size: 1 }), /Frozen Worker admission loader changed/)
  } finally { await f.cleanup() }
})

test('generated pkg inventory rejects changed snippets, additions, removals and symlinks', async t => {
  for (const kind of ['changed', 'added', 'removed', 'symlink']) await t.test(kind, async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'worker-product-pkg-'))
    try {
      await mkdir(resolve(directory, 'pkg/snippets'), { recursive: true })
      await writeFile(resolve(directory, 'pkg/container_host_web.js'), 'export {}\n')
      await writeFile(resolve(directory, 'pkg/container_host_web_bg.wasm'), EMPTY_WASM)
      const snippet = resolve(directory, 'pkg/snippets/helper.js')
      await writeFile(snippet, 'export const helper = true\n')
      const inventory = await inventoryGeneratedPackage(directory)
      if (kind === 'changed') await writeFile(snippet, 'export const helper = false\n')
      if (kind === 'added') await writeFile(resolve(directory, 'pkg/extra.mjs'), 'export {}\n')
      if (kind === 'removed' || kind === 'symlink') await rm(snippet)
      if (kind === 'symlink') await symlink(resolve(directory, 'pkg/container_host_web.js'), snippet)
      await assert.rejects(verifyRetainedGeneratedPackage(directory, inventory))
      assert.equal(inventory.retainedStatus, 'failed')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

for (const [name, settings, expected] of [
  ['index', { mutatePackIndex: true }, /Retained pinned pack index changed/],
  ['config', { mutateProductConfig: true }, /Retained browser asset changed.*worker-product-config/],
  ['startup JSON', { mutateProductStartupJson: true }, /Retained browser asset changed.*worker-product-config\.json/],
]) test(`retained product ${name} tampering keeps the build unready`, async () => {
  const f = await fixture(settings)
  try {
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.equal(report.ready, false)
    assert.match(report.diagnostics.at(-1).message, expected)
  } finally { await f.cleanup() }
})

for (const [name, settings, expected] of [
  ['bindgen mismatch', { bindgenVersion: '0.2.128' }, /must match Cargo.lock/],
  ['missing Rust target', { missingTarget: true }, /is not installed/],
  ['native C compiler', { badCompiler: true }, /Not a linked WebAssembly/],
  ['stale cargo artifact', { staleArtifact: true }, /unexpected target directory/],
  ['missing runtime exports', { emptyArtifact: true }, /missing the WebWasmHost/],
  ['empty generated glue', { glue: '' }, /did not produce JavaScript glue/],
  ['missing glue methods', { glue: 'export class WebWasmHost {}\nexport default function init() {}\n' }, /missing the WebWasmHost methods/],
  ['comment-only glue interface', { glue: `// ${VALID_GLUE.replaceAll('\n', '\n// ')}\nexport default function init() {}\n` }, /missing the WebWasmHost methods/],
  ['missing glue initializer', { glue: VALID_GLUE.slice(0, VALID_GLUE.indexOf('export default')) }, /missing the WebWasmHost methods/],
  ['getter pretending to be glue method', { glue: VALID_GLUE.replace('dispatch_json() {}', "get dispatch_json() { throw new Error('must not invoke getter') }") }, /missing the WebWasmHost methods/],
  ['external glue import', { glue: `import 'https://example.invalid/escape.mjs';\n${VALID_GLUE}` }, /ordinary relative path in pkg/],
  ['escaping glue import', { glue: `import '../app.mjs';\n${VALID_GLUE}` }, /escapes pkg/],
  ['computed glue import', { glue: `export const late = name => import(name);\n${VALID_GLUE}` }, /reference must be static/],
  ['missing glue snippet', { glue: `import './missing.mjs';\n${VALID_GLUE}` }, /unretained file/],
  ['Cargo link failure', { cargoFails: true }, /mock Cargo link failed/],
  ['mutated frozen sources', { mutateSnapshot: true }, /Frozen source changed/],
  ['mutated frozen pack validator', { mutateFrozenValidator: true }, /Frozen source changed.*modern-view-pack-resources/],
  ['corrupt retained pack', { mutateRetainedPack: true }, /Retained manifest changed/],
  ['corrupt runtime renderer config', { mutateRuntimeConfig: true }, /Retained runtime configuration changed/],
  ['corrupt browser asset inventory', { mutateBrowserAssetInventory: true }, /Retained browser asset changed.*browser-assets/],
  ['corrupt retained Worker entry', { mutateRetainedBrowserAsset: true }, /Retained browser asset changed.*runtime-worker/],
]) test(`${name} remains failed and never ready`, async () => {
  const f = await fixture(settings)
  try {
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.equal(report.ready, false)
    assert.match(report.diagnostics.at(-1).message, expected)
    assert.equal(JSON.parse(await readFile(resolve(f.outDir, 'build-report.json'))).status, 'failed')
    if (['external glue import', 'escaping glue import', 'computed glue import', 'missing glue snippet'].includes(name)) {
      assert.equal(f.calls.some(call => call.binary === process.execPath), false,
        'closure rejection must precede any generated glue interface evaluation')
    }
  } finally { await f.cleanup() }
})

test('corrupt input pack fails after source freezing and before any build tool command', async () => {
  const f = await fixture()
  try {
    const manifest = JSON.parse(await readFile(resolve(f.pack, 'manifest.json')))
    await writeFile(resolve(f.pack, 'blobs/sha256', manifest.modules[0].sha256), 'corrupted module')
    const report = await f.build()
    assert.equal(report.status, 'failed')
    assert.match(report.diagnostics[0].message, /SHA-256 mismatch/)
    assert.ok(f.calls.length > 0)
    assert.ok(f.calls.every(call => call.binary === 'git'))
    assert.equal(existsSync(resolve(f.outDir, 'portable-pack')), false)
  } finally { await f.cleanup() }
})

test('an existing output is never overwritten', async () => {
  const f = await fixture()
  try {
    await mkdir(f.outDir)
    await writeFile(resolve(f.outDir, 'retained-evidence'), 'do not replace')
    await assert.rejects(f.build(), { code: 'EEXIST' })
    assert.deepEqual(await readdir(f.outDir), ['retained-evidence'])
    assert.deepEqual(f.calls, [])
  } finally { await f.cleanup() }
})

for (const settings of [{ dirty: true }, { environment: { RUSTFLAGS: '-C opt-level=2' } }]) {
  test(`stable ${settings.dirty ? 'dirty sources' : 'custom flags'} cannot become clean-source success`, async () => {
    const f = await fixture(settings)
    try {
      const report = await f.build()
      assert.equal(report.status, 'partial')
      assert.equal(report.buildStatus, 'passed')
      assert.equal(report.ready, true)
      assert.equal(report.source.status, 'unknown')
    } finally { await f.cleanup() }
  })
}

test('dev artifact selection rejects release/default-cache output paths', async () => {
  const f = await fixture({ profile: 'dev' })
  try {
    assert.equal(f.plan.cargoArgs.includes('--release'), false)
    const report = await f.build()
    assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
    const messages = await readFile(resolve(f.outDir, 'cargo-build.jsonl'), 'utf8')
    assert.match(selectWasmArtifact(messages, f.plan).path, /debug\/container_host_web.wasm$/)
    assert.throws(() => selectWasmArtifact(messages.replace('/debug/', '/release/'), f.plan), /unexpected/)
  } finally { await f.cleanup() }
})

test('owned command runner retains byte logs and cancels its own process group', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'wasm-owned-command-'))
  try {
    const controller = new AbortController()
    const run = createOwnedCommandRunner(directory, { signal: controller.signal, killGraceMs: 100 })
    const normal = await run(process.execPath, ['-e', 'process.stdout.write("owned stdout"); process.stderr.write("owned stderr")'], { cwd: directory })
    assert.equal(normal.stdout, 'owned stdout')
    assert.equal(normal.stderr, 'owned stderr')
    const pending = run(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], { cwd: directory })
    const timeout = setTimeout(() => controller.abort(), 150)
    try { await assert.rejects(pending, /ERR_CANCELLED/) } finally { clearTimeout(timeout) }
    const metadata = JSON.parse(await readFile(resolve(directory, 'commands/002.json')))
    assert.equal(metadata.status, 'cancelled')
    assert.ok(metadata.pid > 0)
    assert.equal(metadata.pid, metadata.processGroup)
    assert.ok(metadata.cleanup.some(entry => entry.processGroup === metadata.pid))
    assert.throws(() => process.kill(metadata.pid, 0), { code: 'ESRCH' })
    assert.equal(metadata.stdoutSha256, sha256(await readFile(resolve(directory, metadata.stdoutFile))))
    const absent = createOwnedCommandRunner(resolve(directory, 'missing-tool'))
    await assert.rejects(absent(resolve(directory, 'nonexistent'), [], { cwd: directory }), /ERR_BUILD/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a live ownership metadata write failure settles the already-spawned child before rejecting', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'wasm-owned-metadata-failure-'))
  let spawnedPid
  const originalWriteFile = fs.writeFileSync
  const writer = t.mock.method(fs, 'writeFileSync', (path, bytes, ...options) => {
    if (path === resolve(directory, 'commands/001.json')) {
      spawnedPid = JSON.parse(bytes).pid
      assert.ok(spawnedPid > 0, 'the failure must occur after a child has been spawned')
      // The initial asynchronous running record has already been written.
      // Replace it only at the synchronous live-ownership update so the OS
      // produces a real EISDIR error after spawn, rather than before launch.
      fs.rmSync(path)
      fs.mkdirSync(path)
    }
    return originalWriteFile(path, bytes, ...options)
  })
  syncBuiltinESMExports()
  try {
    const run = createOwnedCommandRunner(directory, { killGraceMs: 80 })
    await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: directory }), error => {
      assert.equal(error.code, 'EISDIR')
      assert.equal(error.commandCleanupStatus, 'passed')
      assert.equal(error.commandProcessGroup, spawnedPid)
      assert.equal(error.commandId, '001')
      return true
    })
    assert.throws(() => process.kill(spawnedPid, 0), { code: 'ESRCH' })
  } finally {
    writer.mock.restore()
    syncBuiltinESMExports()
    if (spawnedPid) {
      try { process.kill(-spawnedPid, 'SIGKILL') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('timeout terminates an owned helper and its child, preserving live ownership metadata', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'wasm-owned-descendants-'))
  try {
    const run = createOwnedCommandRunner(directory, { timeoutMs: 300, killGraceMs: 80 })
    const pending = run(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000)`], { cwd: directory })
    await new Promise(resolveWait => setTimeout(resolveWait, 120))
    const live = JSON.parse(await readFile(resolve(directory, 'commands/001.json')))
    assert.equal(live.status, 'running')
    assert.ok(live.pid > 0)
    assert.equal(live.pid, live.processGroup)
    await assert.rejects(pending, /ERR_TIMEOUT/)
    const childPid = Number(await readFile(resolve(directory, 'commands/001.stdout.log'), 'utf8'))
    assert.ok(childPid > 0)
    const report = JSON.parse(await readFile(resolve(directory, 'commands/001.json')))
    assert.equal(report.status, 'timed-out')
    assert.equal(report.cleanupStatus, 'passed')
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
    assert.throws(() => process.kill(live.pid, 0), { code: 'ESRCH' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})


test('mixed renderer startup is opt-in, manifest-only and preserved in pinned static product config', async t => {
  const intent = { schemaVersion: 1, execution: 'worker', engine: 'quickjs', viewport: { width: 375, height: 667 },
    rendererPolicy: { mode: 'manifest' }, rendererTransitions: { version: '1.0' } }
  assert.deepEqual(parseWorkerStartupIntent(JSON.stringify(intent)).value.rendererTransitions, { version: '1.0' })
  for (const invalid of ['1.0', { version: '2.0' }, { version: '1.0', implicit: true }]) assert.throws(() => parseWorkerStartupIntent(JSON.stringify({ ...intent, rendererTransitions: invalid })))
  assert.throws(() => parseWorkerStartupIntent(JSON.stringify({ ...intent, rendererPolicy: { mode: 'force', profile: 'skia' } })))
  const directory = await mkdtemp(resolve(tmpdir(), 'worker-transition-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await stageWorkerProductConfig(directory, { index: { path: 'pack-index.json', sha256: 'a'.repeat(64), size: 10 },
    rendererConfig: { renderer: 'canvaskit' }, startupIntentJson: JSON.stringify(intent) })
  const config = JSON.parse(await readFile(resolve(directory, 'worker-product-config.json'), 'utf8'))
  assert.deepEqual(config.rendererTransitions, { version: '1.0' })
  const { workerProductOptions } = await import('../examples/hosts/web-wasm/worker-app.mjs')
  assert.deepEqual(workerProductOptions(config).rendererTransitions, { version: '1.0' })
  assert.equal(workerProductOptions({ ...config, rendererTransitions: undefined }).rendererTransitions, undefined)
})
