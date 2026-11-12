#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, relative, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import rendererPins from '../examples/hosts/web-wasm/renderer-dependency-pins.json' with { type: 'json' }
import { GENERATED_MODULE_LIMITS, loadPinnedGeneratedModuleParser, verifyGeneratedModuleClosure, verifyRetainedGeneratedModuleParser } from './generated-package-closure.mjs'
import { loadDistributionInput, verifyDistributionInput, verifyDistributionArtifact } from './lib/showcase-policy.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const WASM_TARGET = 'wasm32-unknown-unknown'
export const WASM_REQUIRED_EXPORTS = ['webwasmhost_new', 'webwasmhost_load_manifest_json_with_config',
  'webwasmhost_dispatch_json', 'webwasmhost_dispatch_batch_json', 'webwasmhost_render_frame_json', 'webwasmhost_render_frame_binary', 'webwasmhost_render_revision', 'webwasmhost_view_revision',
  'webwasmhost_acknowledge_presentation', 'webwasmhost_render_snapshot_rgba', 'webwasmhost_browser_view_resource',
  'webwasmhost_notify_window_metrics_json', 'webwasmhost_retire_browser_preview', 'webwasmhost_set_render_scale',
  'webwasmhost_runtime_state_json', 'webwasmhost_capabilities_json', 'webwasmhost_poll_timers',
  'webwasmhost_observation_contract_json', 'webwasmhost_observation_state_json',
  'webwasmhost_external_presentation_contract_json', 'webwasmhost_last_frame_input_json',
  'webwasmhost_render_target_json', 'webwasmhost_acknowledge_presentation_outcome_json', 'webwasmhost_unload',
  'webwasmhost_host_services_protocol_json', 'webwasmhost_configure_host_services_json', 'webwasmhost_take_host_requests_json',
  'webwasmhost_complete_host_api_call_json', 'webwasmhost_dispatch_host_api_event_json', 'webwasmhost_revoke_host_services_json',
  'webwasmhost_authorize_phone_button_json', 'webwasmhost_dispatch_host_component_event_json', 'webwasmhost_update_host_service_snapshots_json', 'webwasmhost_host_component_snapshots_json', 'webwasmhost_submit_host_component_frame', 'webwasmhost_host_component_resource']
export const GLUE_REQUIRED_METHODS = ['load_manifest_json_with_config', 'capabilities_json', 'poll_timers',
  'dispatch_json', 'dispatch_batch_json', 'render_frame_json', 'render_frame_binary', 'render_revision', 'view_revision', 'acknowledge_presentation', 'render_snapshot_rgba',
  'browser_view_resource', 'notify_window_metrics_json', 'retire_browser_preview', 'set_render_scale', 'runtime_state_json',
  'observation_contract_json', 'observation_state_json', 'external_presentation_contract_json',
  'last_frame_input_json', 'render_target_json', 'acknowledge_presentation_outcome_json', 'unload', 'free',
  'host_services_protocol_json', 'configure_host_services_json', 'take_host_requests_json', 'complete_host_api_call_json',
  'dispatch_host_api_event_json', 'revoke_host_services_json', 'authorize_phone_button_json', 'dispatch_host_component_event_json',
  'update_host_service_snapshots_json', 'host_component_snapshots_json', 'submit_host_component_frame', 'host_component_resource']
const CANVASKIT_ARCHIVE = Object.freeze({ version: '0.42.0', variant: 'full', license: 'BSD-3-Clause',
  url: 'https://registry.npmjs.org/canvaskit-wasm/-/canvaskit-wasm-0.42.0.tgz',
  sha256: 'ba667f46830ac2a70c6d76ab2c1ac790b0d15a2bf6ed2c842ce97231478b1f80',
  integrity: 'sha512-N3ikotmzYwDVAcpQKDMptBT2P5pIEWS9ywdmrQA2awwaMF9cxKEFuxZZHv9ay1Em9kDjxDsPtwUzDm1uNj136g==',
  archiveVerifiedAtBuild: false })
const FONT_ORIGIN = Object.freeze({ family: 'Container Sans SC', derivedFrom: 'Noto Sans SC',
  sourceSha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
  derivation: { tool: 'fonttools', version: '4.60.1', weight: 400, coverage: 'complete', script: 'scripts/prepare-renderer-font.py' }, versionCommit: 'a85815a42757630ce188fdad368c2dfc444d4773',
  license: 'SIL Open Font License 1.1', reservedFontName: 'Source',
  url: 'https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
  licenseUrl: 'https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/OFL.txt' })
export const RENDERER_DEPENDENCY_PINS = Object.freeze(Object.fromEntries(Object.entries(rendererPins).map(([key, value]) => [key, Object.freeze(value)])))
// One inventory drives the captured source scope, static staging and retained
// hash report. Selected-entry build plans remain distinct from browser execution.
export const WEB_SAMPLE_FILES = Object.freeze([
  'index.html', 'app.mjs', 'canvaskit-presenter.mjs', 'text-flow-plan.mjs', 'render-inputs.mjs', 'surface-input.mjs',
  'input-causal-ledger.mjs',
  'runtime-worker.mjs', 'worker-runtime.mjs', 'worker-session-client.mjs', 'worker-bridge-transport.mjs',
  'dom-presenter.mjs', 'dom-session-client.mjs', 'dom-animation-sample.mjs', 'legacy.html', 'worker-app.mjs',
  'worker-web-session.mjs', 'presentation-scheduler.mjs', 'worker-dom-adapter.mjs',
  'worker-canvaskit-adapter.mjs', 'worker-admission-loader.mjs', 'browser-dev-owner-manager.mjs',
  'browser-file-digest.mjs', 'browser-host-services.mjs', 'browser-host-account-manager.mjs', 'reference-identity-client.mjs', 'browser-bluetooth-owner.mjs',
  'browser-recorder-support.mjs', 'browser-wav-recorder.mjs', 'browser-wav-recorder-worklet.mjs',
  'host-api-binary-wire.mjs', 'worker-frame-wire.mjs',
  'worker-host-services.mjs', 'host-services-browser-probe.mjs', 'host-services-media-browser-probe.mjs', 'host-services-audio-browser-probe.mjs', 'host-services-recorder-browser-probe.mjs',
])
export const PORTABLE_PACK_VALIDATOR_FILES = Object.freeze([
  'scripts/portable-pack.mjs', 'scripts/modern-view-pack-resources.mjs',
  'tools/container-manifest/src/json-integrity.mjs',
])
const SOURCE_INPUTS = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo', 'crates',
  'scripts/build-web-wasm.mjs', 'scripts/prepare-renderer-font.py', 'scripts/generated-package-closure.mjs', 'scripts/lib/showcase-policy.mjs',
  'scripts/browser-dev-artifacts.mjs', 'scripts/browser-dev-artifacts-cli.mjs', ...PORTABLE_PACK_VALIDATOR_FILES,
  'examples/hosts/web-wasm/renderer-dependency-pins.json', 'tools/container-manifest/src',
  ...WEB_SAMPLE_FILES.map(file => `examples/hosts/web-wasm/${file}`)]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
const within = (path, directory) => path === directory || path.startsWith(directory + '/')
const influentialEnvironment = environment => Object.fromEntries(Object.entries(environment).filter(([key, value]) => value
  && (/^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTDOC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|RUSTUP_TOOLCHAIN|CARGO_INCREMENTAL|CC_SHELL_ESCAPED_FLAGS|CC_KNOWN_WRAPPER_CUSTOM|CRATE_CC_NO_DEFAULTS)$/.test(key)
    || /^(?:CC|CXX|AR|CFLAGS|CXXFLAGS|CPPFLAGS)(?:_|$)/.test(key)
    || /^(?:HOST_|TARGET_)(?:CC|CXX|AR|CFLAGS|CXXFLAGS|CPPFLAGS)$/.test(key) || /^BINDGEN_EXTRA_CLANG_ARGS(?:_|$)/.test(key)
    || /^CARGO_(?:BUILD_|PROFILE_|TARGET_WASM32_UNKNOWN_UNKNOWN_)/.test(key))))

/** Release hardening is derived by the producer, never appended to ambient flags. */
export async function restrictedWasmBuildHardening(plan, environment = process.env) {
  if (!plan.policy) return null
  requireCondition(Object.keys(influentialEnvironment(environment)).length === 0,
    'Restricted Web builds require producer-owned compiler flags; custom build environment is forbidden')
  const home = resolve(environment.HOME || environment.USERPROFILE || homedir())
  const mappings = new Map()
  for (const [path, destination] of [
    [home, 'build-home'],
    [resolve(environment.TMPDIR || environment.TMP || environment.TEMP || tmpdir()), 'build-tmp'],
    [resolve(environment.CARGO_HOME || resolve(home, '.cargo')), 'cargo'],
    [plan.targetDir, 'weapp-container-build'], [plan.root, 'weapp-container'], [plan.sourceDir, 'weapp-container-source'],
  ]) {
    requireCondition(path.length > 1 && !/[\x00-\x1f\x7f=]/.test(path), 'Build path cannot be represented by the fixed source remapping')
    mappings.set(path, destination)
    try { mappings.set(await realpath(path), destination) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const sourcePathMappings = [...mappings].map(([source, destination]) => ({ source, destination }))
  const rustFlags = sourcePathMappings.map(({ source, destination }) => `--remap-path-prefix=${source}=${destination}`)
  const cFlags = sourcePathMappings.map(({ source, destination }) => `-ffile-prefix-map=${source}=${destination}`)
  return { schemaVersion: 1, debugInfo: false, strip: 'debuginfo', sourcePathMappings, rustFlags, cFlags,
    environment: { CARGO_PROFILE_RELEASE_DEBUG: '0', CARGO_PROFILE_RELEASE_STRIP: 'debuginfo',
      CARGO_ENCODED_RUSTFLAGS: rustFlags.join('\x1f'), CC_SHELL_ESCAPED_FLAGS: '1',
      CFLAGS: cFlags.map(flag => JSON.stringify(flag)).join(' '), CXXFLAGS: cFlags.map(flag => JSON.stringify(flag)).join(' ') } }
}

export function verifyRestrictedWasmPaths(bytes, hardening) {
  for (const { source } of hardening.sourcePathMappings) {
    for (const variant of new Set([source, source.replaceAll('\\', '/'), source.replaceAll('/', '\\')])) {
      requireCondition(!bytes.includes(Buffer.from(variant)), 'Restricted Web artifact retains a local producer path')
    }
  }
  return { localBuildPaths: false, sourcePrefixesChecked: hardening.sourcePathMappings.length }
}

/** Remove only non-executable debug metadata after wasm-bindgen, before hashing. */
export function stripRestrictedWasmMetadata(bytes) {
  requireCondition(bytes.subarray(0, 8).equals(Buffer.from('0061736d01000000', 'hex')), 'Invalid WASM header for release stripping')
  const integer = start => {
    let value = 0
    for (let shift = 0; shift <= 28; shift += 7) {
      requireCondition(start < bytes.length, 'Truncated WASM section length')
      const byte = bytes[start++]
      requireCondition(shift < 28 || byte <= 15, 'Invalid WASM section length')
      value += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return { value, next: start }
    }
    throw new Error('Invalid WASM section length')
  }
  const retained = [bytes.subarray(0, 8)], removedCustomSections = []
  for (let offset = 8; offset < bytes.length;) {
    const start = offset, id = bytes[offset++], section = integer(offset), end = section.next + section.value
    requireCondition(end <= bytes.length, 'Truncated WASM section')
    let remove = false
    if (id === 0) {
      const name = integer(section.next)
      requireCondition(name.next + name.value <= end, 'Invalid WASM custom section name')
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(name.next, name.next + name.value))
      remove = ['name', 'producers', 'sourceMappingURL', 'external_debug_info'].includes(value) || value.startsWith('.debug_')
      if (remove) removedCustomSections.push(value)
    }
    if (!remove) retained.push(bytes.subarray(start, end))
    offset = end
  }
  const output = Buffer.concat(retained)
  return { bytes: output, receipt: { inputSha256: digest(bytes), inputBytes: bytes.length,
    outputSha256: digest(output), outputBytes: output.length, removedCustomSections } }
}

export function parseArgs(args) {
  const options = {}
  const names = new Map([['--pack', 'pack'], ['--out-dir', 'outDir'], ['--profile', 'profile'], ['--jobs', 'jobs'],
    ['--wasm-bindgen', 'wasmBindgen'], ['--llvm-bin', 'llvmBin'], ['--target-dir', 'targetDir'],
    ['--renderer', 'renderer'], ['--canvaskit-dir', 'canvaskitDir'], ['--font-file', 'fontFile'],
    ['--font-license-file', 'fontLicenseFile'], ['--execution', 'execution'], ['--startup-intent', 'startupIntentFile'],
    ['--distribution-profile', 'distributionProfile'], ['--showcase-policy', 'showcasePolicy']])
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--offline') { requireCondition(!options.offline, 'Duplicate --offline'); options.offline = true; continue }
    if (args[index] === '--keep-cargo-cache') { requireCondition(!options.keepCargoCache, 'Duplicate --keep-cargo-cache'); options.keepCargoCache = true; continue }
    const name = names.get(args[index])
    requireCondition(name && args[index + 1] && !args[index + 1].startsWith('--'), `Unknown option or missing value: ${args[index]}`)
    requireCondition(options[name] === undefined, `Duplicate option: ${args[index]}`)
    options[name] = args[++index]
  }
  return options
}

export function createBuildPlan(raw, { root = ROOT, environment = process.env } = {}) {
  requireCondition(raw.pack && raw.outDir, '--pack and --out-dir are required')
  const outDir = resolve(raw.outDir)
  const pack = resolve(raw.pack)
  requireCondition(!within(outDir, pack) && !within(pack, outDir), 'Pack and output must be separate directories')
  const profile = raw.profile || 'release'
  requireCondition(['dev', 'release'].includes(profile), '--profile must be dev or release')
  const distribution = loadDistributionInput({ distributionProfile: raw.distributionProfile,
    showcasePolicy: raw.showcasePolicy, profile })
  if (distribution.policy) requireCondition(Object.keys(influentialEnvironment(environment)).length === 0,
    'Restricted Web builds require producer-owned compiler flags; custom build environment is forbidden')
  const features = ['wasm', 'quickjs-native', ...(distribution.distributionProfile === 'restricted-showcase' ? ['restricted-showcase'] : [])]
  const jobsText = String(raw.jobs ?? 4)
  requireCondition(/^[1-9]\d{0,2}$/.test(jobsText) && Number(jobsText) <= 256,
    '--jobs must be an integer from 1 to 256')
  const jobs = Number(jobsText)
  const execution = raw.execution || 'worker'
  requireCondition(['worker', 'legacy'].includes(execution), '--execution must be worker or legacy')
  requireCondition(raw.startupIntentFile === undefined || execution === 'worker', '--startup-intent requires Worker execution')
  const startupIntentFile = raw.startupIntentFile === undefined ? undefined : resolve(raw.startupIntentFile)
  requireCondition(startupIntentFile === undefined || !within(startupIntentFile, outDir), 'Startup intent must be outside build output')
  const renderer = raw.renderer || 'software'
  requireCondition(['software', 'canvaskit'].includes(renderer), '--renderer must be software or canvaskit')
  const dependencyInputs = ['canvaskitDir', 'fontFile', 'fontLicenseFile']
  requireCondition(renderer !== 'canvaskit' || dependencyInputs.every(key => raw[key]),
    '--renderer canvaskit requires explicit --canvaskit-dir, --font-file and --font-license-file')
  requireCondition(renderer === 'canvaskit' || dependencyInputs.every(key => raw[key] === undefined),
    'CanvasKit/font input options require --renderer canvaskit')
  const rendererPaths = Object.fromEntries(dependencyInputs.filter(key => raw[key]).map(key => [key, resolve(raw[key])]))
  requireCondition(Object.values(rendererPaths).every(path => !within(path, outDir)), 'Renderer dependency inputs must be outside the build output')
  const llvmBin = raw.llvmBin || environment.WEAPP_CONTAINER_LLVM_BIN || environment.LLVM_BIN
  requireCondition(llvmBin, '--llvm-bin or WEAPP_CONTAINER_LLVM_BIN is required (LLVM clang and llvm-ar)')
  const sourceDir = resolve(outDir, 'source')
  requireCondition(!['crates', '.cargo', 'tools/container-manifest/src', 'examples/hosts/web-wasm']
    .some(path => within(outDir, resolve(root, path))), 'Output cannot be inside captured source inputs')
  requireCondition(raw.keepCargoCache === undefined || typeof raw.keepCargoCache === 'boolean', '--keep-cargo-cache must be a boolean')
  const targetDirectorySource = raw.targetDir ? 'argument' : environment.CARGO_TARGET_DIR ? 'environment' : 'build'
  const targetDir = raw.targetDir ? resolve(raw.targetDir)
    : environment.CARGO_TARGET_DIR ? resolve(root, environment.CARGO_TARGET_DIR) : resolve(outDir, 'cargo-target')
  requireCondition(!within(targetDir, sourceDir) && !within(targetDir, pack), 'Cargo target directory must not be inside source snapshot or portable pack')
  return {
    root: resolve(root), pack, outDir, profile, jobs, sourceDir, targetDir, targetDirectorySource,
    keepCargoCache: raw.keepCargoCache === true, offline: raw.offline === true, renderer, execution,
    ...distribution,
    entry: execution === 'worker' ? 'index.html' : 'legacy.html',
    entryModule: execution === 'worker' ? 'worker-app.mjs' : 'app.mjs',
    plannedAppServiceThread: execution === 'worker' ? 'worker' : 'main', ...rendererPaths,
    ...(startupIntentFile === undefined ? {} : { startupIntentFile }),
    llvmBin: resolve(llvmBin), clang: resolve(llvmBin, 'clang'), ar: resolve(llvmBin, 'llvm-ar'),
    wasmBindgen: raw.wasmBindgen || environment.WEAPP_CONTAINER_WASM_BINDGEN || environment.WASM_BINDGEN_BIN || 'wasm-bindgen',
    target: WASM_TARGET, features,
    cargoArgs: ['build', '--manifest-path', resolve(sourceDir, 'Cargo.toml'), '-p', 'container-host-web',
      '--no-default-features', '--features', features.join(','), '--target', WASM_TARGET,
      '--target-dir', targetDir, '--locked', '--jobs', String(jobs), '--message-format=json-render-diagnostics',
      ...(profile === 'release' ? ['--release'] : []), ...(raw.offline ? ['--offline'] : [])],
  }
}

export function lockedWasmBindgenVersion(lock) {
  const versions = lock.split(/^\[\[package\]\]\s*$/m).filter(block => /^name = "wasm-bindgen"$/m.test(block))
    .map(block => block.match(/^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/m)?.[1])
  requireCondition(versions.length === 1 && versions[0], 'Cargo.lock must contain exactly one wasm-bindgen version')
  return versions[0]
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function rendererDependencyInputs(plan) {
  if (plan.renderer === 'software') return []
  requireCondition(plan.renderer === 'canvaskit' && plan.canvaskitDir && plan.fontFile && plan.fontLicenseFile,
    'CanvasKit renderer dependency inputs are incomplete')
  return Object.entries(RENDERER_DEPENDENCY_PINS).map(([id, asset]) => ({ id, ...asset,
    sourcePath: id === 'font' ? plan.fontFile : id === 'fontLicense' ? plan.fontLicenseFile : resolve(plan.canvaskitDir, asset.input),
    provenance: id === 'font' || id === 'fontLicense'
      ? { ...FONT_ORIGIN, url: id === 'font' ? FONT_ORIGIN.url : FONT_ORIGIN.licenseUrl }
      : { ...CANVASKIT_ARCHIVE, archivePath: `package/${asset.input}` } }))
}

export function rendererRuntimeConfig(renderer) {
  requireCondition(['software', 'canvaskit'].includes(renderer), 'Unknown runtime renderer')
  const config = { schemaVersion: 1, renderer, fallback: 'error' }
  if (renderer === 'canvaskit') {
    const asset = id => {
      const { url, sha256, size } = RENDERER_DEPENDENCY_PINS[id]
      return { url, sha256, size }
    }
    config.canvaskit = { version: CANVASKIT_ARCHIVE.version, variant: CANVASKIT_ARCHIVE.variant,
      javascript: asset('javascript'), wasm: asset('wasm'), license: asset('license'), package: asset('package') }
    config.font = { family: FONT_ORIGIN.family, versionCommit: FONT_ORIGIN.versionCommit,
      binary: asset('font'), license: asset('fontLicense') }
  }
  return config
}

/** Freeze exactly verified bytes; a matching filename or package version is insufficient. */
export async function copyPinnedRendererDependency(input, outDir) {
  const { sourcePath, url, sha256, size } = input
  const destination = resolve(outDir, url)
  requireCondition(within(destination, resolve(outDir)) && destination !== resolve(outDir), 'Renderer dependency output escapes the build directory')
  requireCondition((await lstat(sourcePath)).isFile(), `Renderer dependency must be a regular file: ${sourcePath}`)
  const bytes = await readFile(sourcePath)
  requireCondition(digest(bytes) === sha256 && bytes.length === size, `Pinned renderer dependency SHA-256 or size mismatch: ${sourcePath}`)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes, { flag: 'wx' })
  requireCondition(await hashFile(destination) === sha256, `Retained renderer dependency changed while copying: ${url}`)
  return { id: input.id, sourcePath, url, sha256, size, provenance: input.provenance, verified: true }
}

export async function stageRendererDependencies(plan) {
  const files = []
  for (const input of rendererDependencyInputs(plan)) files.push(await copyPinnedRendererDependency(input, plan.outDir))
  const value = rendererRuntimeConfig(plan.renderer)
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const path = 'runtime-config.json'
  await writeFile(resolve(plan.outDir, path), bytes, { flag: 'wx' })
  return { schemaVersion: 1, status: 'passed', retainedStatus: 'not-run', renderer: plan.renderer, files,
    runtimeConfig: { path, sha256: digest(bytes), bytes: bytes.length, value },
    limitations: ['Pinned dependency packaging does not establish browser, WebGL/GPU, screenshot or performance acceptance'] }
}

export async function verifyRetainedRendererDependencies(outDir, dependencies) {
  try {
    for (const file of dependencies.files) requireCondition(await hashFile(resolve(outDir, file.url)) === file.sha256,
      `Retained renderer dependency changed during build: ${file.url}`)
    requireCondition(await hashFile(resolve(outDir, dependencies.runtimeConfig.path)) === dependencies.runtimeConfig.sha256,
      'Retained runtime configuration changed during build')
    dependencies.retainedStatus = 'passed'
  } catch (error) { dependencies.retainedStatus = 'failed'; throw error }
}

/** Stage only the byte-verified browser closure from the frozen source. */
export async function stageBrowserAssets(source, outDir, { execution = 'worker', generatedFiles = [] } = {}) {
  requireCondition(['worker', 'legacy'].includes(execution), 'Unknown browser execution selection')
  requireCondition(source && typeof source.snapshotDirectory === 'string' && source.sourceFiles,
    'Browser asset packaging requires a frozen source inventory')
  const root = await realpath(source.snapshotDirectory)
  // Validate the complete input inventory before publishing any browser file.
  const inputs = []
  for (const path of WEB_SAMPLE_FILES) {
    const sourcePath = `examples/hosts/web-wasm/${path}`
    const expected = source.sourceFiles[sourcePath]
    requireCondition(typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected),
      `Browser asset source is missing from the inventory: ${sourcePath}`)
    const location = resolve(root, sourcePath)
    requireCondition((await lstat(location)).isFile() && await realpath(location) === location,
      `Browser asset must be a regular file inside the snapshot: ${sourcePath}`)
    const bytes = await readFile(location)
    requireCondition(digest(bytes) === expected, `Browser asset changed before staging: ${sourcePath}`)
    inputs.push({ path, sourcePath, sha256: expected, size: bytes.length, bytes })
  }
  for (const input of inputs) await writeFile(resolve(outDir, input.path), input.bytes, { flag: 'wx' })
  const value = { schemaVersion: 1, entry: execution === 'worker' ? 'index.html' : 'legacy.html',
    entryModule: execution === 'worker' ? 'worker-app.mjs' : 'app.mjs', execution,
    plannedAppServiceThread: execution === 'worker' ? 'worker' : 'main',
    appServiceThread: execution === 'legacy' ? 'main' : 'unknown', workerProductEnabled: false,
    productExecution: { status: 'not-run', subject: execution === 'worker' ? 'default-worker-entry' : 'explicit-legacy-entry' },
    legacyEntries: [{ entry: 'legacy.html', module: 'app.mjs', appServiceThread: 'main', workerProductEnabled: false }],
    files: inputs.map(({ bytes, ...file }) => file), generatedFiles }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const path = 'browser-assets.json'
  await writeFile(resolve(outDir, path), bytes, { flag: 'wx' })
  return { ...value, status: 'passed', retainedStatus: 'not-run',
    inventory: { path, sha256: digest(bytes), size: bytes.length },
    limitations: ['Selected entry and retained bytes describe a build plan; actual Worker product execution, accepted presentation, GPU and performance require separate browser evidence'] }
}

export async function verifyRetainedBrowserAssets(outDir, assets) {
  try {
    const outputRoot = await realpath(outDir)
    requireCondition(assets.files.length === WEB_SAMPLE_FILES.length
      && assets.files.every((file, index) => file.path === WEB_SAMPLE_FILES[index]),
      'Retained browser asset inventory differs from the packaged closure')
    const generatedPaths = ['worker-product-config.mjs', 'worker-product-config.json']
    requireCondition(Array.isArray(assets.generatedFiles) && assets.generatedFiles.length === generatedPaths.length
      && assets.generatedFiles.every((file, index) => file.path === generatedPaths[index]),
    'Generated browser configuration inventory is incomplete')
    for (const file of [...assets.files, ...assets.generatedFiles, assets.inventory]) {
      const path = resolve(outputRoot, file.path)
      requireCondition((await lstat(path)).isFile() && await realpath(path) === path,
        `Retained browser asset is not regular: ${file.path}`)
      const bytes = await readFile(path)
      requireCondition(bytes.length === file.size && digest(bytes) === file.sha256,
        `Retained browser asset changed during build: ${file.path}`)
    }
    assets.retainedStatus = 'passed'
  } catch (error) { assets.retainedStatus = 'failed'; throw error }
}

/** One serialization is the source of both retained index and independent pin. */
export async function stagePackIndex(outDir, index) {
  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
  const path = 'pack-index.json'
  await writeFile(resolve(outDir, path), bytes, { flag: 'wx' })
  return { path, sha256: digest(bytes), size: bytes.length }
}

/** Reuse the exact frozen pure loader; do not duplicate renderer-profile rules. */
export async function inspectWorkerPackAdmission(source, outDir, indexDescriptor, { rendererPolicy = { mode: 'manifest' } } = {}) {
  requireCondition(indexDescriptor?.path === 'pack-index.json' && /^[0-9a-f]{64}$/.test(indexDescriptor.sha256)
    && Number.isSafeInteger(indexDescriptor.size) && indexDescriptor.size > 0, 'Exact retained index descriptor is required')
  const relativePath = 'examples/hosts/web-wasm/worker-admission-loader.mjs'
  const path = resolve(await realpath(source.snapshotDirectory), relativePath)
  requireCondition((await lstat(path)).isFile() && await realpath(path) === path
    && await hashFile(path) === source.sourceFiles[relativePath], 'Frozen Worker admission loader changed before import')
  const { createWorkerAdmissionLoader } = await import(pathToFileURL(path).href)
  requireCondition(typeof createWorkerAdmissionLoader === 'function', 'Frozen Worker admission factory is missing')
  const indexBytes = await readFile(resolve(outDir, indexDescriptor.path))
  requireCondition(indexBytes.length === indexDescriptor.size && digest(indexBytes) === indexDescriptor.sha256,
    'Retained pack index changed before Worker admission')
  const index = JSON.parse(indexBytes)
  requireCondition(index.manifest === 'portable-pack/manifest.json', 'Worker product manifest must remain in the owned portable pack')
  const manifestBytes = await readFile(resolve(outDir, index.manifest))
  const manifest = JSON.parse(manifestBytes)
  requireCondition(Array.isArray(manifest.routes) && manifest.routes.length > 0, 'Worker product requires manifest routes')
  const resources = new Map([['/pack-index.json', indexBytes], ['/portable-pack/manifest.json', manifestBytes]])
  const loader = createWorkerAdmissionLoader({ baseUrl: 'https://retained.invalid/index.html',
    sha256: async bytes => digest(bytes), fetch: async input => {
      const url = new URL(input)
      requireCondition(url.origin === 'https://retained.invalid' && resources.has(url.pathname)
        && !url.search && !url.hash, 'Pure build admission attempted an undeclared resource')
      return new Response(resources.get(url.pathname), { status: 200, headers: { 'content-type': 'application/json' } })
    } })
  const routes = []
  for (const route of manifest.routes) {
    const admitted = await loader.admitWorkerPack({ indexUrl: './pack-index.json', indexSha256: indexDescriptor.sha256,
      indexSize: indexDescriptor.size, route: route.path, rendererPolicy })
    routes.push({ path: admitted.route, declaredProfile: admitted.declaredProfile, transportBackend: admitted.transportBackend })
  }
  return { status: 'passed', loaderSourcePath: relativePath, loaderSha256: source.sourceFiles[relativePath], routes,
    requiresCanvasKit: routes.some(route => route.transportBackend === 'external-frame'),
    limitations: ['Pure retained index/manifest admission does not load application blobs, execute AppService or present a surface'] }
}

const workerStartupRoute = value => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !value.startsWith('/') && !/[\\?#%\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..')

/** Read the caller's exact, index-independent startup intent. The raw UTF-8
 * bytes, rather than a second serialization, bind the stage input. */
export function parseWorkerStartupIntent(text) {
  requireCondition(typeof text === 'string' && Buffer.byteLength(text) <= 64 * 1024,
    'Worker startup intent must be bounded JSON text')
  const value = JSON.parse(text), record = item => item !== null && typeof item === 'object' && !Array.isArray(item)
  // Bound the generated module's recursive freeze and reject numbers that
  // JSON.parse accepts but JSON.stringify would silently replace with null.
  const pending = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const item = pending.pop()
    requireCondition(++nodes <= 32 * 1024 && item.depth <= 64, 'Worker startup intent exceeds its JSON structure budget')
    requireCondition(typeof item.value !== 'number' || Number.isFinite(item.value), 'Worker startup intent requires finite JSON numbers')
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 })
    }
  }
  requireCondition(record(value) && value.schemaVersion === 1 && value.execution === 'worker' && value.engine === 'quickjs',
    'Worker startup intent requires schema 1 and QuickJS Worker execution')
  const allowed = new Set(['schemaVersion', 'execution', 'engine', 'viewport', 'rendererPolicy', 'rendererTransitions', 'renderScale', 'route', 'data', 'query', 'launchOptions', 'metrics'])
  requireCondition(Object.keys(value).every(key => allowed.has(key)), 'Unknown Worker startup intent field')
  requireCondition(record(value.viewport) && Object.keys(value.viewport).length === 2
    && ['width', 'height'].every(key => Number.isSafeInteger(value.viewport[key]) && value.viewport[key] > 0 && value.viewport[key] <= 4096),
  'Worker startup intent has invalid logical viewport')
  const policy = value.rendererPolicy
  requireCondition(record(policy) && (policy.mode === 'manifest' && Object.keys(policy).length === 1
    || policy.mode === 'force' && Object.keys(policy).length === 2 && ['skia', 'skyline-compat', 'webview'].includes(policy.profile)),
  'Worker startup intent has invalid renderer policy')
  requireCondition(value.rendererTransitions === undefined || record(value.rendererTransitions)
    && Object.keys(value.rendererTransitions).length === 1 && value.rendererTransitions.version === '1.0' && policy.mode === 'manifest',
    'Worker rendererTransitions requires explicit version 1.0 and manifest policy')
  requireCondition(value.renderScale === undefined || value.renderScale === 'auto'
    || [1, 1.5, 2, 3, 4].includes(value.renderScale), 'Worker renderScale must be auto, 1, 1.5, 2, 3 or 4')
  requireCondition(value.renderScale === undefined || policy.mode !== 'force' || policy.profile !== 'webview',
    'DOM density belongs to the browser; renderScale requires an external-frame renderer')
  if (typeof value.renderScale === 'number') {
    const width = Math.ceil(value.viewport.width * value.renderScale), height = Math.ceil(value.viewport.height * value.renderScale)
    requireCondition(width <= 4096 && height <= 4096 && width * height * 4 <= 16 * 1024 * 1024,
      'Worker renderScale exceeds the physical target budget')
  }
  requireCondition(value.route === undefined || workerStartupRoute(value.route), 'Invalid Worker startup route')
  for (const key of ['data', 'query', 'launchOptions']) requireCondition(value[key] === undefined || record(value[key]), `Worker ${key} must be an object`)
  if (value.metrics !== undefined) {
    const metrics = value.metrics
    requireCondition(record(metrics) && ['windowWidth', 'windowHeight', 'pixelRatio', 'screenWidth', 'screenHeight', 'statusBarHeight', 'screenTop']
      .every(key => Number.isFinite(metrics[key])) && metrics.windowWidth === value.viewport.width && metrics.windowHeight === value.viewport.height
      && metrics.pixelRatio > 0 && metrics.screenWidth > 0 && metrics.screenHeight > 0 && metrics.statusBarHeight >= 0 && metrics.screenTop >= 0
      && ['portrait', 'landscape'].includes(metrics.deviceOrientation), 'Worker metrics must match the logical viewport')
  }
  return { value, sha256: digest(Buffer.from(text)), size: Buffer.byteLength(text) }
}

export async function stageWorkerProductConfig(outDir, { index, rendererConfig, viewport = { width: 375, height: 667 }, startupIntentJson, selectedRoute }) {
  requireCondition(index?.path === 'pack-index.json' && /^[0-9a-f]{64}$/.test(index.sha256)
    && Number.isSafeInteger(index.size) && index.size > 0, 'Exact retained index descriptor is required')
  const intent = parseWorkerStartupIntent(startupIntentJson ?? JSON.stringify({ schemaVersion: 1, execution: 'worker',
    engine: 'quickjs', viewport, rendererPolicy: { mode: 'manifest' } }))
  requireCondition(selectedRoute === undefined || workerStartupRoute(selectedRoute), 'Invalid selected Worker startup route')
  const value = { schemaVersion: 1, execution: 'worker', engine: 'quickjs',
    index: { url: './pack-index.json', sha256: index.sha256, size: index.size }, rendererPolicy: intent.value.rendererPolicy,
    viewport: intent.value.viewport, rendererAssets: rendererConfig.renderer === 'canvaskit' ? rendererConfig : null }
  for (const key of ['rendererTransitions', 'renderScale', 'route', 'data', 'query', 'launchOptions', 'metrics']) if (intent.value[key] !== undefined) value[key] = intent.value[key]
  // The supervisor may have explicitly diagnosed a missing requested route and
  // selected a valid fallback in this pack. Bind that resolved route into the
  // actual config without changing the hash of the original startup intent.
  if (selectedRoute !== undefined) value.route = selectedRoute
  // No report/inventory hashes enter this module: that would create a hash cycle.
  // JSON.parse preserves own "__proto__" keys. Interpolating JSON directly as
  // a JS object literal would change their meaning into a prototype setter.
  const bytes = Buffer.from(`const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }\nexport const WORKER_PRODUCT_CONFIG = freeze(JSON.parse(${JSON.stringify(JSON.stringify(value))}))\n`)
  const path = 'worker-product-config.mjs'
  await writeFile(resolve(outDir, path), bytes, { flag: 'wx' })
  // Keep the module hash and actual startup JSON hash distinct. A browser dev
  // offer transmits these exact JSON bytes, without evaluating a config module.
  const jsonPath = 'worker-product-config.json', jsonBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  requireCondition(jsonBytes.length <= 64 * 1024, 'Generated Worker startup JSON exceeds byte budget')
  await writeFile(resolve(outDir, jsonPath), jsonBytes, { flag: 'wx' })
  return { path, sha256: digest(bytes), size: bytes.length, provenance: { kind: 'generated', indexSha256: index.sha256 }, value,
    startupIntentSha256: intent.sha256, startupJson: { path: jsonPath, sha256: digest(jsonBytes), size: jsonBytes.length } }
}

/** Hash every regular generated pkg file, including wasm-bindgen snippets. */
export async function inventoryGeneratedPackage(outDir) {
  const outputRoot = await realpath(outDir), root = resolve(outputRoot, 'pkg'), files = []
  requireCondition((await lstat(root)).isDirectory() && await realpath(root) === root, 'Generated pkg root must be an owned regular directory')
  let packageBytes = 0, directories = 0, javaScriptBytes = 0
  const visit = async (directory, depth = 0) => {
    requireCondition(++directories <= GENERATED_MODULE_LIMITS.directories && depth <= GENERATED_MODULE_LIMITS.depth,
      'Generated pkg directory budget exceeded')
    for await (const entry of await opendir(directory)) {
      const path = resolve(directory, entry.name)
      requireCondition(within(path, root) && await realpath(path) === path, 'Generated pkg contains an escaping path or symlink')
      if (entry.isDirectory()) await visit(path, depth + 1)
      else {
        requireCondition(entry.isFile(), 'Generated pkg contains a nonregular file')
        const stat = await lstat(path), javascript = /\.(?:m?js)$/.test(entry.name)
        const limit = javascript ? GENERATED_MODULE_LIMITS.fileBytes : GENERATED_MODULE_LIMITS.packageFileBytes
        requireCondition(stat.isFile() && stat.size <= limit, `Generated pkg file exceeds byte budget: ${entry.name}`)
        requireCondition(files.length < GENERATED_MODULE_LIMITS.files, 'Generated pkg file count budget exceeded')
        packageBytes += stat.size
        if (javascript) javaScriptBytes += stat.size
        requireCondition(packageBytes <= GENERATED_MODULE_LIMITS.packageBytes && javaScriptBytes <= GENERATED_MODULE_LIMITS.totalBytes,
          'Generated pkg total byte budget exceeded')
        const bytes = await readFile(path)
        requireCondition(bytes.length === stat.size, `Generated pkg file changed while reading: ${entry.name}`)
        files.push({ path: relative(outputRoot, path).split('\\').join('/'), sha256: digest(bytes), size: bytes.length })
      }
    }
  }
  await visit(root)
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  requireCondition(files.some(file => file.path === 'pkg/container_host_web.js')
    && files.some(file => file.path === 'pkg/container_host_web_bg.wasm'), 'Generated pkg is missing glue or WASM')
  return { schemaVersion: 1, status: 'passed', retainedStatus: 'not-run', files,
    limitations: ['Regular-file inventory is distinct from the separately parsed module closure; actual runtime behavior requires browser evidence'] }
}

export async function verifyRetainedGeneratedPackage(outDir, inventory) {
  try {
    const actual = await inventoryGeneratedPackage(outDir)
    requireCondition(JSON.stringify(actual.files) === JSON.stringify(inventory.files), 'Generated pkg bytes or file closure changed during build')
    inventory.retainedStatus = 'passed'
  } catch (error) { inventory.retainedStatus = 'failed'; throw error }
}

/** Every command owns one new POSIX process group; no global tool shutdown. */
export function createOwnedCommandRunner(outDir, { signal, timeoutMs = 20 * 60_000, killGraceMs = 1500 } = {}) {
  let sequence = 0
  return async (command, args, options = {}) => {
    requireCondition(process.platform !== 'win32', 'Owned process-group cancellation currently requires a POSIX build host')
    requireCondition(!signal?.aborted, 'ERR_CANCELLED: build was cancelled')
    const id = String(++sequence).padStart(3, '0')
    const directory = resolve(outDir, 'commands')
    await mkdir(directory, { recursive: true })
    const stdoutPath = resolve(directory, `${id}.stdout.log`)
    const stderrPath = resolve(directory, `${id}.stderr.log`)
    const stdout = createWriteStream(stdoutPath, { flags: 'wx' })
    const stderr = createWriteStream(stderrPath, { flags: 'wx' })
    const record = { id, command: [command, ...args], cwd: options.cwd,
      startedAt: new Date().toISOString(), status: 'running', pid: null, processGroup: null,
      timeoutMs: options.timeoutMs || timeoutMs, stdoutFile: relative(outDir, stdoutPath), stderrFile: relative(outDir, stderrPath), cleanup: [] }
    let child
    let closed
    let timer
    let escalation
    let terminal = false
    let cancelled = false
    let timedOut = false
    let spawnError = null
    let streamError
    let rejectStream
    const streamFailed = new Promise((_, reject) => { rejectStream = reject })
    // File opening can fail before the child exists or before its close race
    // starts. Retain that error without allowing an unhandled rejection.
    streamFailed.catch(() => {})
    const onStreamError = error => { streamError ||= error; rejectStream(error) }
    stdout.on('error', onStreamError)
    stderr.on('error', onStreamError)
    const groupExists = () => {
      if (!child?.pid) return false
      try { process.kill(-child.pid, 0); return true }
      catch (error) {
        if (error.code === 'ESRCH') return false
        record.cleanup.push({ action: 'inspect-owned-group', processGroup: child.pid, error: error.message })
        return null
      }
    }
    const killGroup = (signalName, reason) => {
      if (!child?.pid) return
      try { process.kill(-child.pid, signalName); record.cleanup.push({ signal: signalName, processGroup: child.pid, reason }) }
      catch (error) { if (error.code !== 'ESRCH') record.cleanup.push({ signal: signalName, processGroup: child.pid, error: error.message }) }
    }
    const settleGroup = async interrupt => {
      if (interrupt && !terminal) killGroup('SIGKILL', 'command-error')
      if (closed && !terminal) {
        let closeTimer
        try {
          await Promise.race([closed, new Promise(resolveWait => { closeTimer = setTimeout(resolveWait, Math.max(1000, killGraceMs)) })])
        } finally { clearTimeout(closeTimer) }
      }
      // A helper that closed its inherited stdio can outlive the leader.
      // The detached group remains owned by this command until it is empty.
      if (groupExists() === true) {
        killGroup('SIGKILL', 'remaining-owned-group')
        await new Promise(resolveWait => setTimeout(resolveWait, 50))
      }
      record.cleanupStatus = (!child?.pid || terminal) && groupExists() === false ? 'passed' : 'unverified'
    }
    const stop = reason => {
      if (terminal || !child?.pid) return
      if (reason === 'cancel') cancelled = true
      else timedOut = true
      killGroup('SIGTERM', reason)
      escalation = setTimeout(() => {
        if (!terminal) killGroup('SIGKILL', reason)
      }, killGraceMs)
    }
    const abort = () => stop('cancel')
    try {
      await save(resolve(directory, `${id}.json`), record)
      if (streamError) throw streamError
      child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env,
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      record.pid = child.pid || null
      record.processGroup = child.pid || null
      // Install close/error listeners before any fallible metadata write so
      // every exception after spawn can still wait for the owned child.
      closed = new Promise(resolveResult => {
        child.once('error', error => { spawnError = error.message })
        child.once('close', (exitCode, exitSignal) => { terminal = true; resolveResult({ exitCode, exitSignal }) })
      })
      child.stdout.pipe(stdout)
      child.stderr.pipe(stderr)
      // Persist ownership while the process is live, not only after Cargo
      // exits; an interrupted supervisor leaves an attributable PID/group.
      writeFileSync(resolve(directory, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      timer = setTimeout(() => stop('timeout'), record.timeoutMs)
      const result = await Promise.race([closed, streamFailed])
      await Promise.race([
        Promise.all([new Promise(resolveEnd => stdout.end(resolveEnd)), new Promise(resolveEnd => stderr.end(resolveEnd))]),
        streamFailed,
      ])
      await settleGroup(false)
      record.status = cancelled ? 'cancelled' : timedOut ? 'timed-out' : spawnError || result.exitCode !== 0 ? 'failed' : 'passed'
      if (record.cleanupStatus !== 'passed' && record.status === 'passed') record.status = 'failed'
      Object.assign(record, result, { error: spawnError, finishedAt: new Date().toISOString(),
        stdoutSha256: await hashFile(stdoutPath), stderrSha256: await hashFile(stderrPath) })
      await save(resolve(directory, `${id}.json`), record)
      requireCondition(record.status === 'passed', `${cancelled ? 'ERR_CANCELLED' : timedOut ? 'ERR_TIMEOUT' : 'ERR_BUILD'}: ${command} ${record.status}; see commands/${id}.stderr.log`)
      return { ...record, stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8'), stdoutPath, stderrPath }
    } catch (error) {
      // Includes metadata/log I/O failures after spawn, not just nonzero exits.
      // Never let a rejected command promise imply an unobserved live child.
      if (record.cleanupStatus !== 'passed') await settleGroup(true)
      error.commandCleanupStatus = record.cleanupStatus
      error.commandId = id
      error.commandProcessGroup = record.processGroup
      throw error
    } finally {
      clearTimeout(timer)
      clearTimeout(escalation)
      signal?.removeEventListener('abort', abort)
      stdout.destroy()
      stderr.destroy()
    }
  }
}

async function observeSource(root, run) {
  const git = async args => (await run('git', args, { cwd: root, timeoutMs: 30_000 })).stdout
  const commit = (await git(['rev-parse', 'HEAD'])).trim()
  requireCondition(/^[0-9a-f]{40}$/.test(commit), 'Cannot establish source commit')
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...SOURCE_INPUTS])
  const listed = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_INPUTS])
  const files = [...new Set(listed.split('\0').filter(Boolean))].sort()
  requireCondition(files.includes('Cargo.toml') && files.includes('Cargo.lock'), 'Source snapshot is missing Cargo inputs')
  const hashes = {}
  for (const path of files) {
    requireCondition(!path.startsWith('../') && !path.startsWith('/') && !path.split('/').includes('..'), 'Invalid source inventory path')
    const location = resolve(root, path)
    requireCondition((await lstat(location)).isFile(), `Snapshot source is not a regular file: ${path}`)
    hashes[path] = await hashFile(location)
  }
  return { sourceCommit: commit, workingTreeDirty: status.length > 0, workingTreeScope: SOURCE_INPUTS,
    sourceFiles: hashes, sourceSha256: digest(JSON.stringify(hashes)) }
}

export async function snapshotBuildSource(root, destination, run) {
  const before = await observeSource(root, run)
  for (const [path, hash] of Object.entries(before.sourceFiles)) {
    const bytes = await readFile(resolve(root, path))
    requireCondition(digest(bytes) === hash, `Source changed while snapshotting: ${path}`)
    await mkdir(dirname(resolve(destination, path)), { recursive: true })
    await writeFile(resolve(destination, path), bytes, { flag: 'wx' })
  }
  const after = await observeSource(root, run)
  requireCondition(before.sourceCommit === after.sourceCommit && before.sourceSha256 === after.sourceSha256, 'Source changed while snapshotting; no clean-source claim is possible')
  return { ...before, snapshotDirectory: destination, sourceStable: true,
    workingTreeDirty: before.workingTreeDirty || after.workingTreeDirty }
}

/** Import the pack validator only from the byte-verified, dependency-free snapshot. */
export async function loadFrozenPackValidator(source) {
  requireCondition(source && typeof source.snapshotDirectory === 'string' && source.sourceFiles,
    'Portable pack validation requires a frozen source inventory')
  const root = await realpath(source.snapshotDirectory)
  const files = {}
  for (const file of PORTABLE_PACK_VALIDATOR_FILES) {
    const expected = source.sourceFiles[file]
    requireCondition(typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected),
      `Frozen pack validator source is missing from the inventory: ${file}`)
    const location = resolve(root, file)
    requireCondition((await lstat(location)).isFile() && await realpath(location) === location,
      `Frozen pack validator must be a regular file inside the snapshot: ${file}`)
    requireCondition(await hashFile(location) === expected, `Frozen pack validator changed before import: ${file}`)
    files[file] = expected
  }
  const entry = PORTABLE_PACK_VALIDATOR_FILES[0]
  const module = await import(pathToFileURL(resolve(root, entry)).href)
  requireCondition(typeof module.syncPortablePack === 'function', 'Frozen pack validator is missing syncPortablePack')
  return { syncPortablePack: module.syncPortablePack,
    provenance: { entry, sourceFiles: files, sourceSha256: digest(JSON.stringify(files)) } }
}

export function selectWasmArtifact(stdout, plan) {
  const records = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const finished = records.filter(record => record.reason === 'build-finished')
  requireCondition(finished.length === 1 && finished[0].success === true, 'Cargo did not report a successful completed build')
  const artifacts = records.filter(record => record.reason === 'compiler-artifact'
    && record.target?.name === 'container_host_web' && record.target.crate_types?.includes('cdylib'))
  requireCondition(artifacts.length === 1, 'Cargo did not emit exactly one Web cdylib artifact')
  const artifact = artifacts[0]
  requireCondition(resolve(artifact.manifest_path || '') === resolve(plan.sourceDir, 'crates/container-host-web/Cargo.toml')
    && plan.features.every(feature => artifact.features?.includes(feature)) && !artifact.features?.includes('v8-native'), 'Cargo artifact source or engine/features differs from requested WASM build')
  const expected = resolve(plan.targetDir, WASM_TARGET, plan.profile === 'release' ? 'release' : 'debug', 'container_host_web.wasm')
  const paths = (artifact.filenames || []).filter(path => path.endsWith('.wasm')).map(path => resolve(path))
  requireCondition(paths.length === 1 && paths[0] === expected, 'Cargo emitted WASM into an unexpected target directory/target/profile')
  return { path: expected, packageId: artifact.package_id, fresh: artifact.fresh === true, features: artifact.features }
}

export function verifyWasmExports(exports, requiredExports = WASM_REQUIRED_EXPORTS) {
  const matched = Object.fromEntries(requiredExports.map(name => [name, exports.filter(item => item.kind === 'function'
    && (item.name === name || (item.name.startsWith(`${name}_`) && /^[0-9a-f]{16}$/.test(item.name.slice(name.length + 1)))))
    .map(item => item.name)]))
  const missing = requiredExports.filter(name => matched[name].length === 0)
  requireCondition(missing.length === 0, `Linked WASM is missing the WebWasmHost interface: ${missing.join(', ')}`)
  const ambiguous = requiredExports.filter(name => matched[name].length > 1)
  requireCondition(ambiguous.length === 0, `Linked WASM has ambiguous or duplicate WebWasmHost exports: ${ambiguous.join(', ')}`)
  return matched
}

async function verifyWasm(path, requiredExports = []) {
  const bytes = await readFile(path)
  requireCondition(bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('0061736d01000000', 'hex')), `Not a linked WebAssembly module: ${path}`)
  const module = await WebAssembly.compile(bytes)
  const exports = WebAssembly.Module.exports(module)
  return { sha256: digest(bytes), bytes: bytes.length, imports: WebAssembly.Module.imports(module), exports: exports.map(item => item.name),
    interfaceExports: verifyWasmExports(exports, requiredExports) }
}

export async function verifyWasmGlue(path, run, options = {}) {
  const bytes = await readFile(path)
  requireCondition(bytes.length > 0, 'wasm-bindgen did not produce JavaScript glue')
  // A sibling .mjs preserves relative snippet imports while avoiding ambient
  // package.json module rules. Import only reflects the class; it never calls
  // the WASM initializer or constructs a host. The owned child has a deadline.
  const temporary = resolve(dirname(path), `.web-wasm-interface-${randomUUID()}.mjs`)
  await writeFile(temporary, bytes, { flag: 'wx' })
  try {
    const inspect = `import { pathToFileURL } from 'node:url';
const module = await import(pathToFileURL(process.argv[1]).href);
const host = module.WebWasmHost;
const prototype = typeof host === 'function' ? host.prototype : null;
const methods = prototype ? Object.getOwnPropertyNames(prototype).filter(name =>
  typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === 'function') : [];
process.stdout.write(JSON.stringify({ nodeVersion: process.version, exports: Object.keys(module),
  initializerType: typeof module.default, hostType: typeof host, methods }));`
    const result = await run(process.execPath, ['--input-type=module', '-e', inspect, temporary], { ...options, timeoutMs: 30_000 })
    const observed = JSON.parse(result.stdout)
    requireCondition(observed.initializerType === 'function' && observed.hostType === 'function'
      && Array.isArray(observed.methods) && observed.methods.includes('constructor')
      && GLUE_REQUIRED_METHODS.every(name => observed.methods.includes(name)),
    'Generated JavaScript glue is missing the WebWasmHost methods or default WASM initializer')
    requireCondition(await hashFile(path) === digest(bytes), 'Generated JavaScript glue changed during interface verification')
    return { sha256: digest(bytes), bytes: bytes.length, interface: observed }
  } finally { await rm(temporary) }
}

async function verifySnapshot(source) {
  for (const [path, hash] of Object.entries(source.sourceFiles)) {
    requireCondition(await hashFile(resolve(source.snapshotDirectory, path)) === hash, `Frozen source changed during build: ${path}`)
  }
}

async function releaseCargoCache(plan, report, identity) {
  if (plan.targetDirectorySource !== 'build' || plan.keepCargoCache || !identity) return
  try {
    requireCondition(report.commands.every(command => command.cleanupStatus === undefined || command.cleanupStatus === 'passed'),
      'Owned command process-group cleanup is unverified; Cargo cache must be retained')
    const stat = await lstat(plan.targetDir)
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino
      && await realpath(plan.targetDir) === identity.realPath, 'Owned Cargo cache directory identity changed; refusing removal')
    await rm(plan.targetDir, { recursive: true })
    report.cargoCache.status = 'removed'
  } catch (error) {
    report.cargoCache.status = 'cleanup-failed'
    report.cargoCache.error = error.message
    report.status = 'failed'
    report.ready = false
    report.diagnostics.push({ code: 'ERR_CARGO_CACHE_CLEANUP', message: `${plan.targetDir}: ${error.message}` })
  }
}

export async function runWebWasmBuild(raw, dependencies = {}) {
  const environment = dependencies.environment || process.env
  const plan = createBuildPlan(raw, { root: dependencies.root || ROOT, environment })
  await mkdir(dirname(plan.outDir), { recursive: true })
  await mkdir(plan.outDir) // Exclusive: even an existing empty directory is refused.
  const report = { schemaVersion: 1, status: 'running', scope: 'quickjs-browser-wasm-build',
    distributionProfile: plan.distributionProfile, policySha256: plan.policySha256,
    startedAt: new Date().toISOString(), plan, buildStatus: 'not-run', ready: false, commands: [],
    browserStatus: 'not-run', gpuStatus: 'unknown', diagnostics: [],
    cargoCache: { path: plan.targetDir, ownership: plan.targetDirectorySource === 'build' ? 'build' : 'caller',
      retention: plan.targetDirectorySource !== 'build' || plan.keepCargoCache ? 'keep' : 'remove-on-exit',
      status: plan.targetDirectorySource === 'build' ? 'not-created' : 'retained' },
    limitations: ['A built WASM module is not browser execution, CanvasKit/GPU, visual or near-parity conformance evidence'] }
  const command = dependencies.run || createOwnedCommandRunner(plan.outDir, { signal: dependencies.signal })
  const run = async (binary, args, options) => {
    const attempt = { command: [binary, ...args], id: null, status: 'running' }
    report.commands.push(attempt)
    try {
      const result = await command(binary, args, options)
      Object.assign(attempt, { id: result.id || null, status: result.status || 'passed',
        ...(result.cleanupStatus === undefined ? {} : { cleanupStatus: result.cleanupStatus }) })
      return result
    } catch (error) {
      attempt.status = 'failed'; attempt.error = error.message
      if (error.commandCleanupStatus !== undefined) attempt.cleanupStatus = error.commandCleanupStatus
      if (error.commandId !== undefined) attempt.id = error.commandId
      if (error.commandProcessGroup !== undefined) attempt.processGroup = error.commandProcessGroup
      throw error
    }
  }
  const aborted = () => requireCondition(!dependencies.signal?.aborted, 'ERR_CANCELLED: build was cancelled')
  let cargoCacheIdentity
  try {
    await save(resolve(plan.outDir, 'build-report.json'), report)
    aborted()
    if (plan.targetDirectorySource === 'build') {
      // The output directory was exclusively created above. Create its cache
      // exclusively too, before any tool runs, so cleanup never adopts an old
      // directory or follows a caller-provided cache/symlink.
      await mkdir(plan.targetDir)
      const stat = await lstat(plan.targetDir)
      cargoCacheIdentity = { dev: stat.dev, ino: stat.ino, realPath: await realpath(plan.targetDir) }
      report.cargoCache.status = 'retained'
    }
    let startupIntentJson, startupIntent
    if (plan.startupIntentFile !== undefined) {
      const source = await realpath(plan.startupIntentFile), stat = await lstat(source)
      requireCondition(stat.isFile() && stat.size <= 64 * 1024, 'Startup intent must be a bounded regular JSON file')
      const bytes = await readFile(source)
      startupIntentJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      startupIntent = parseWorkerStartupIntent(startupIntentJson)
      requireCondition(!startupIntent.value.rendererTransitions || plan.renderer === 'canvaskit', 'Mixed Worker presenters require pinned CanvasKit/font assets')
      const path = 'worker-startup-intent.json'
      await writeFile(resolve(plan.outDir, path), bytes, { flag: 'wx' })
      report.workerStartupIntent = { path, sha256: digest(bytes), size: bytes.length, source }
    }
    report.source = await snapshotBuildSource(plan.root, plan.sourceDir, run)
    await save(resolve(plan.outDir, 'source-snapshot.json'), report.source)
    const packValidator = await loadFrozenPackValidator(report.source)
    report.packValidator = packValidator.provenance
    requireCondition(/^[0-9a-f]{64}$/.test(report.source.sourceFiles['scripts/generated-package-closure.mjs'] || ''),
      'Generated module closure validator is missing from frozen source inventory')
    const moduleParser = await loadPinnedGeneratedModuleParser({ root: plan.root,
      destination: resolve(plan.outDir, 'validation/generated-module-parser') })
    report.generatedModuleParser = moduleParser.provenance
    aborted()
    report.rendererDependencies = await stageRendererDependencies(plan)
    const pack = await packValidator.syncPortablePack({ source: plan.pack, destination: resolve(plan.outDir, 'portable-pack') })
    if (plan.policy) requireCondition(plan.policy.allowedPackRoots.includes(pack.integrityRoot),
      'Portable pack is not permitted by the selected showcase policy')
    const manifestBytes = await readFile(resolve(plan.outDir, 'portable-pack/manifest.json'))
    const blobs = await Promise.all(pack.files.filter(file => file.startsWith('blobs/sha256/')).map(async file => {
      const bytes = await readFile(resolve(plan.outDir, 'portable-pack', file))
      return { sha256: file.split('/').at(-1), url: `portable-pack/${file}`, size: bytes.length }
    }))
    const index = { schemaVersion: 1, manifest: 'portable-pack/manifest.json', manifestSha256: digest(manifestBytes), integrityRoot: pack.integrityRoot, blobs }
    report.packIndex = await stagePackIndex(plan.outDir, index)
    report.pack = index
    if (plan.execution === 'worker') {
      report.workerPackAdmission = await inspectWorkerPackAdmission(report.source, plan.outDir, report.packIndex,
        startupIntent ? { rendererPolicy: startupIntent.value.rendererPolicy } : {})
      requireCondition(!report.workerPackAdmission.requiresCanvasKit || plan.renderer === 'canvaskit',
        'Worker pack contains external-frame routes; provide all explicit pinned CanvasKit/font assets')
    } else report.workerPackAdmission = { status: 'not-run', reason: 'selected explicit legacy entry' }
    report.workerProductConfig = await stageWorkerProductConfig(plan.outDir, { index: report.packIndex,
      rendererConfig: report.rendererDependencies.runtimeConfig.value, ...(startupIntentJson === undefined ? {} : { startupIntentJson }) })
    const { path, sha256, size, provenance, startupJson } = report.workerProductConfig
    report.browserAssets = await stageBrowserAssets(report.source, plan.outDir,
      { execution: plan.execution, generatedFiles: [{ path, sha256, size, provenance }, startupJson] })
    const childEnv = { ...environment }
    delete childEnv.WEAPP_SHOWCASE_POLICY
    if (plan.policy) {
      verifyDistributionInput(plan)
      const retainedPolicy = resolve(plan.outDir, 'validation/showcase-policy.json')
      await writeFile(retainedPolicy, plan.canonical, { flag: 'wx' })
      childEnv.WEAPP_SHOWCASE_POLICY = retainedPolicy
      report.distributionPolicy = { path: 'validation/showcase-policy.json', sha256: plan.policySha256,
        input: plan.policyInput }
    }
    delete childEnv.SDKROOT
    delete childEnv.SDKTARGETSYSROOT
    report.ignoredSdkEnvironment = ['SDKROOT', 'SDKTARGETSYSROOT'].filter(key => environment[key] !== undefined)
    report.customBuildEnvironment = influentialEnvironment(environment)
    const hardening = await restrictedWasmBuildHardening(plan, environment)
    if (hardening) { report.buildHardening = hardening; Object.assign(childEnv, hardening.environment) }
    const which = async tool => {
      const path = (await run('rustup', ['which', tool], { cwd: plan.sourceDir, env: childEnv, timeoutMs: 30_000 })).stdout.trim()
      requireCondition(path && (await lstat(path)).isFile(), `rustup did not select an installed ${tool}`)
      return path
    }
    const cargo = await which('cargo')
    const rustc = await which('rustc')
    const rustdoc = await which('rustdoc')
    Object.assign(childEnv, { RUSTC: rustc, RUSTDOC: rustdoc, PATH: `${dirname(cargo)}${delimiter}${plan.llvmBin}${delimiter}${environment.PATH || ''}`,
      CC_wasm32_unknown_unknown: plan.clang, AR_wasm32_unknown_unknown: plan.ar,
      'CC_wasm32-unknown-unknown': plan.clang, 'AR_wasm32-unknown-unknown': plan.ar })
    report.toolchain = { cargo, rustc, rustdoc, clang: plan.clang, ar: plan.ar, wasmBindgen: plan.wasmBindgen, versions: {} }
    for (const [name, binary, args] of [['cargo', cargo, ['--version', '--verbose']], ['rustc', rustc, ['--version', '--verbose']],
      ['rustdoc', rustdoc, ['--version']], ['clang', plan.clang, ['--version']], ['ar', plan.ar, ['--version']],
      ['wasmBindgen', plan.wasmBindgen, ['--version']]]) {
      const version = await run(binary, args, { cwd: plan.sourceDir, env: childEnv, timeoutMs: 30_000 })
      report.toolchain.versions[name] = `${version.stdout}${version.stderr}`.trim()
    }
    const bindgenVersion = lockedWasmBindgenVersion(await readFile(resolve(plan.sourceDir, 'Cargo.lock'), 'utf8'))
    requireCondition(report.toolchain.versions.wasmBindgen.match(/^wasm-bindgen\s+(\S+)/)?.[1] === bindgenVersion,
      `wasm-bindgen CLI must match Cargo.lock ${bindgenVersion}`)
    const targets = await run('rustup', ['target', 'list', '--installed'], { cwd: plan.sourceDir, env: childEnv, timeoutMs: 30_000 })
    requireCondition(targets.stdout.split(/\r?\n/).map(line => line.trim()).includes(WASM_TARGET), `rustup target ${WASM_TARGET} is not installed`)
    const probe = resolve(plan.outDir, 'toolchain-probe')
    await mkdir(probe)
    await writeFile(resolve(probe, 'probe.c'), 'int weapp_container_wasm_toolchain_probe(void) { return 1; }\n')
    await run(plan.clang, ['--target=wasm32-unknown-unknown', '-nostdlib', '-c', resolve(probe, 'probe.c'), '-o', resolve(probe, 'probe.o')], { cwd: plan.sourceDir, env: childEnv, timeoutMs: 30_000 })
    await verifyWasm(resolve(probe, 'probe.o'))
    await run(plan.ar, ['crs', resolve(probe, 'probe.a'), resolve(probe, 'probe.o')], { cwd: plan.sourceDir, env: childEnv, timeoutMs: 30_000 })
    requireCondition((await readFile(resolve(probe, 'probe.a'))).subarray(0, 8).toString() === '!<arch>\n', 'LLVM ar did not create an archive')
    aborted()
    const built = await run(cargo, plan.cargoArgs, { cwd: plan.sourceDir, env: childEnv })
    await writeFile(resolve(plan.outDir, 'cargo-build.jsonl'), built.stdout)
    const selected = selectWasmArtifact(built.stdout, plan)
    const original = await verifyWasm(selected.path, WASM_REQUIRED_EXPORTS)
    if (hardening) report.rawWasmPathHygiene = verifyRestrictedWasmPaths(await readFile(selected.path), hardening)
    report.distributionIdentity = verifyDistributionArtifact(await readFile(selected.path), plan)
    await mkdir(resolve(plan.outDir, 'raw'))
    const rawWasm = resolve(plan.outDir, 'raw/container_host_web.wasm')
    await copyFile(selected.path, rawWasm)
    const frozen = await verifyWasm(rawWasm, WASM_REQUIRED_EXPORTS)
    requireCondition(frozen.sha256 === original.sha256 && (await verifyWasm(selected.path)).sha256 === original.sha256, 'Cargo WASM changed while copying the exact linker output')
    report.rawWasm = { ...selected, ...frozen, copiedPath: rawWasm }
    await run(plan.wasmBindgen, [rawWasm, '--target', 'web', '--out-name', 'container_host_web', '--out-dir', resolve(plan.outDir, 'pkg')], { cwd: plan.sourceDir, env: childEnv })
    if (hardening) {
      const generated = resolve(plan.outDir, 'pkg/container_host_web_bg.wasm')
      const stripped = stripRestrictedWasmMetadata(await readFile(generated))
      report.generatedWasmHardening = { ...stripped.receipt, ...verifyRestrictedWasmPaths(stripped.bytes, hardening) }
      await writeFile(generated, stripped.bytes)
    }
    report.generatedPackage = await inventoryGeneratedPackage(plan.outDir)
    if (hardening) report.generatedPackage.pathHygiene = await Promise.all(report.generatedPackage.files.map(async file =>
      ({ path: file.path, ...verifyRestrictedWasmPaths(await readFile(resolve(plan.outDir, file.path)), hardening) })))
    const linked = await verifyWasm(resolve(plan.outDir, 'pkg/container_host_web_bg.wasm'), WASM_REQUIRED_EXPORTS)
    verifyDistributionArtifact(await readFile(resolve(plan.outDir, 'pkg/container_host_web_bg.wasm')), plan)
    // Reject external/escaping/missing/computed module references before the
    // interface probe can evaluate any generated JavaScript.
    report.generatedModuleClosure = await verifyGeneratedModuleClosure(plan.outDir, report.generatedPackage, moduleParser)
    const glue = await verifyWasmGlue(resolve(plan.outDir, 'pkg/container_host_web.js'), run, { cwd: plan.sourceDir, env: childEnv })
    report.artifacts = { wasm: { path: 'pkg/container_host_web_bg.wasm', ...linked }, glue: { path: 'pkg/container_host_web.js', ...glue } }
    await verifySnapshot(report.source)
    await verifyRetainedBrowserAssets(plan.outDir, report.browserAssets)
    await verifyRetainedRendererDependencies(plan.outDir, report.rendererDependencies)
    await verifyRetainedGeneratedPackage(plan.outDir, report.generatedPackage)
    await verifyRetainedGeneratedModuleParser(report.generatedModuleParser)
    verifyDistributionInput(plan)
    if (plan.policy) requireCondition(await hashFile(resolve(plan.outDir, report.distributionPolicy.path)) === plan.policySha256,
      'Retained showcase policy changed during compilation')
    const retainedIndex = await readFile(resolve(plan.outDir, report.packIndex.path))
    requireCondition(retainedIndex.length === report.packIndex.size && digest(retainedIndex) === report.packIndex.sha256,
      'Retained pinned pack index changed during build')
    // Revalidate retained bytes against the verified index without depending
    // on the mutable source pack or creating a second served pack.
    requireCondition(await hashFile(resolve(plan.outDir, index.manifest)) === index.manifestSha256, 'Retained manifest changed during build')
    for (const blob of index.blobs) requireCondition(await hashFile(resolve(plan.outDir, blob.url)) === blob.sha256, 'Retained portable blob changed during build')
    report.buildStatus = 'passed'
    report.ready = true
    report.source.status = report.source.workingTreeDirty || Object.keys(report.customBuildEnvironment).length ? 'unknown' : 'passed'
    report.status = report.source.status === 'passed' ? 'passed' : 'partial'
  } catch (error) {
    report.status = dependencies.signal?.aborted ? 'cancelled' : 'failed'
    report.diagnostics.push({ code: report.status === 'cancelled' ? 'ERR_CANCELLED' : 'ERR_BUILD', message: error.message })
  } finally {
    // Commands are awaited sequentially; their owned process groups settle
    // before returning or throwing. Keep exact raw WASM, pkg, source and logs;
    // only the cache created by this build is eligible for removal.
    await releaseCargoCache(plan, report, cargoCacheIdentity)
    report.finishedAt = new Date().toISOString()
    if (report.source) await save(resolve(plan.outDir, 'source-snapshot.json'), report.source)
    await save(resolve(plan.outDir, 'build-report.json'), report)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const report = await runWebWasmBuild(parseArgs(process.argv.slice(2)), { signal: controller.signal })
    process.stdout.write(`${JSON.stringify({ status: report.status, ready: report.ready, outDir: report.plan.outDir, diagnostics: report.diagnostics }, null, 2)}\n`)
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt) }
}
