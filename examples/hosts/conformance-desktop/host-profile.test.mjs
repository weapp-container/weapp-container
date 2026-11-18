import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertBinaryHeader, assertCleanup, assertFeatures, assertStartup, buildEnvironmentKey, engineFeatures, hostProfile, nativeArguments, profileForRuntime, profileForTarget } from './host-profile.mjs'
import { cargoArguments, fileReference, parseBuildOptions, selectExecutable, verifyBuild } from './build.mjs'
import { parseDiagnoseOptions } from './diagnose.mjs'
import { createDriverRegistry, parseRegistryOptions } from './driver-registry.mjs'
import { dispose as disposeLinux, run as runLinux, runDiagnostic as diagnoseLinux } from './linux-driver.mjs'
import { createDriver } from './driver.mjs'
import { descriptor as issue1013 } from '../../../conformance/recipes/issue1013-descriptor.mjs'

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../../..')
const linux = arch => hostProfile({ host: 'linux', presenter: 'software', arch })
const header = arch => {
  const bytes = Buffer.alloc(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52)
  return bytes
}

// Synthetic headers and records below are validator fixtures, not startup,
// build, presentation or matrix evidence. No Cargo/native child is launched.
test('unit host policy retains macOS default and requires explicit native Linux software', () => {
  assert.equal(hostProfile().target, 'aarch64-apple-darwin')
  assert.equal(profileForRuntime({ host: 'linux', presenter: 'software' }, { platform: 'linux', arch: 'x64' }).target, 'x86_64-unknown-linux-gnu')
  assert.equal(profileForRuntime({ host: 'linux', presenter: 'software' }, { platform: 'linux', arch: 'arm64' }).target, 'aarch64-unknown-linux-gnu')
  for (const options of [{ host: 'linux' }, { host: 'linux', presenter: 'metal' }, { host: 'windows' }, { host: 'linux', presenter: 'software', arch: 'ia32' }, { presenter: 'software' }]) assert.throws(() => hostProfile(options))
  assert.throws(() => profileForRuntime({ host: 'linux', presenter: 'software' }, { platform: 'darwin', arch: 'arm64' }), /real/)
  assert.throws(() => profileForTarget({ host: 'linux', presenter: 'software', target: 'x86_64-unknown-linux-musl' }), /target/)
})

test('unit exact engine and observation features cannot substitute another provider', () => {
  for (const engine of ['quickjs', 'v8']) {
    const features = engineFeatures(linux('x64'), engine)
    assert.deepEqual(features, [`${engine}-native`, 'conformance-observation'])
    assertFeatures(linux('x64'), engine, features)
    assert.throws(() => assertFeatures(linux('x64'), engine, [`${engine}-native`]), /features/)
    assert.throws(() => assertFeatures(linux('x64'), engine, [...features, 'default']), /features/)
    assert.throws(() => assertFeatures(linux('x64'), engine, [...features, `${engine === 'v8' ? 'quickjs' : 'v8'}-native`]), /features/)
    assert.deepEqual(engineFeatures(hostProfile(), engine), [`${engine}-native`])
  }
  assert.throws(() => engineFeatures(linux('x64'), 'wechat'), /engine/)
})

test('unit ELF headers bind architecture, class, byte order and executable type', () => {
  for (const arch of ['x64', 'arm64']) {
    const profile = linux(arch), bytes = header(arch)
    assertBinaryHeader(bytes, profile)
    const exec = Buffer.from(bytes); exec.writeUInt16LE(2, 16); assertBinaryHeader(exec, profile)
    for (const change of [b => b[0] = 0, b => b[4] = 1, b => b[5] = 2, b => b[6] = 0, b => b[7] = 9,
      b => b.writeUInt16LE(1, 16), b => b.writeUInt16LE(arch === 'x64' ? 183 : 62, 18), b => b.writeUInt32LE(0, 20), b => b.writeUInt16LE(0, 52)]) {
      const wrong = Buffer.from(bytes); change(wrong); assert.throws(() => assertBinaryHeader(wrong, profile), /Linux/)
    }
    assert.throws(() => assertBinaryHeader(bytes.subarray(0, 63), profile), /Linux/)
    assert.throws(() => assertBinaryHeader(bytes, hostProfile()), /Mach-O/)
  }
  assertBinaryHeader(Buffer.from('cffaedfe', 'hex'), hostProfile())
})

test('unit Cargo plan and emitted executable bind exact Linux target and features', () => {
  for (const arch of ['x64', 'arm64']) for (const engine of ['quickjs', 'v8']) {
    const profile = linux(arch), targetDir = resolve(root, 'target-unit-only')
    const args = cargoArguments({ root, targetDir, profile, engine })
    assert(args.includes('--locked') && args.includes('--no-default-features'))
    assert.equal(args[args.indexOf('--target') + 1], profile.target)
    assert.equal(args[args.indexOf('--features') + 1], `${engine}-native,conformance-observation`)
    const artifact = { reason: 'compiler-artifact', manifest_path: resolve(root, 'examples/hosts/conformance-desktop/Cargo.toml'),
      target: { name: 'weapp-conformance-desktop', kind: ['bin'], src_path: resolve(root, 'examples/hosts/conformance-desktop/src/main.rs') },
      features: engineFeatures(profile, engine), executable: resolve(targetDir, profile.target, 'debug/weapp-conformance-desktop') }
    const messages = item => [item, { reason: 'build-finished', success: true }].map(x => JSON.stringify(x)).join('\n')
    const options = { root, targetDir, target: profile.target, engine, host: 'linux', presenter: 'software' }
    assert.equal(selectExecutable(messages(artifact), options).path, artifact.executable)
    for (const mutate of [x => x.features.pop(), x => x.features.push(`${engine === 'v8' ? 'quickjs' : 'v8'}-native`),
      x => x.executable = resolve(targetDir, 'debug/weapp-conformance-desktop'), x => x.target.src_path = resolve(root, 'other.rs')]) {
      const wrong = structuredClone(artifact); mutate(wrong); assert.throws(() => selectExecutable(messages(wrong), options))
    }
    assert.throws(() => selectExecutable(messages(artifact) + '\n' + JSON.stringify(artifact), options), /exactly one/)
  }
})

test('unit receipt verifier checks actual fixture bytes and never admits dirty diagnostic as formal', async () => {
  const temp = await mkdtemp(resolve(root, '.unit-binary-'))
  try {
    await writeFile(resolve(temp, 'fixture.elf'), header('x64'))
    await writeFile(resolve(temp, 'cargo.jsonl'), 'unit fixture only\n')
    await writeFile(resolve(temp, 'cargo.stderr'), '')
    const artifact = await fileReference(temp, resolve(temp, 'fixture.elf'))
    const receipt = { schemaVersion: 1, kind: 'weapp-conformance-native-build', status: 'passed', workingTreeDirty: false,
      host: 'linux', presenterProfile: 'software', engine: 'quickjs', target: linux('x64').target,
      sourceCommit: '1'.repeat(40), sourceSha256: '2'.repeat(64), features: ['quickjs-native', 'conformance-observation'],
      artifact, artifactSha256: artifact.sha256, artifactKind: 'elf-executable',
      cargoMessages: await fileReference(temp, resolve(temp, 'cargo.jsonl')), cargoDiagnostics: await fileReference(temp, resolve(temp, 'cargo.stderr')) }
    const options = { source: false, host: 'linux', presenter: 'software' }
    assert.equal(await verifyBuild(temp, receipt, 'quickjs', options), resolve(temp, 'fixture.elf'))
    for (const mutate of [x => x.host = 'macos', x => x.presenterProfile = 'metal', x => x.engine = 'v8',
      x => x.workingTreeDirty = true, x => x.status = 'diagnostic', x => x.features.pop(),
      x => x.artifactKind = 'mach-o-executable', x => x.target = 'aarch64-unknown-linux-gnu',
      x => x.artifactSha256 = '0'.repeat(64)]) {
      const wrong = structuredClone(receipt); mutate(wrong); await assert.rejects(verifyBuild(temp, wrong, 'quickjs', options))
    }
    await assert.rejects(verifyBuild(temp, receipt, 'quickjs', { ...options, target: 'aarch64-unknown-linux-gnu' }), /execution host/)
    const diagnostic = { ...receipt, status: 'diagnostic', workingTreeDirty: true }
    assert.equal(await verifyBuild(temp, diagnostic, 'quickjs', { ...options, diagnostic: true }), resolve(temp, 'fixture.elf'))
    await writeFile(resolve(temp, 'fixture.elf'), header('arm64'))
    await assert.rejects(verifyBuild(temp, receipt, 'quickjs', options), /bytes differ/)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

const expected = { host: 'linux', engine: 'v8', sessionId: 'unit-session', manifestIntegrity: 'a'.repeat(64), pid: 42 }
const startupFixture = () => ({ status: 'passed', ...expected, presenterProfile: 'software', target: { kind: 'native-window', host: 'linux', id: 'unit-window', pid: 42 },
  operations: { 'render.snapshot': { json: JSON.stringify({ frame_id: 7, sha256: 'b'.repeat(64) }) } },
  surfaceProbe: { schemaVersion: 1, status: 'passed', host: 'linux', engine: 'v8', sessionId: expected.sessionId,
    manifestIntegrity: expected.manifestIntegrity, frameId: 7, snapshotSha256: 'b'.repeat(64), hostSurfaceAttached: true,
    containerSurfaceAttached: false, gpuSurface: false, rendererBackend: 'software-fallback', presenterBackend: 'softbuffer-raster',
    evidenceBoundary: 'runtime-software-native-window', presentationCompletion: 'buffer-submitted' } })

test('unit Linux startup rejects pair/window/session substitution and fabricated GPU claims', () => {
  assertStartup(linux('x64'), startupFixture(), expected)
  for (const mutate of [x => x.host = 'macos', x => x.engine = 'quickjs', x => x.sessionId = 'other',
    x => x.target.pid = 999, x => x.target.id = '', x => x.target.host = 'macos', x => x.target.kind = 'headless', x => x.presenterProfile = 'metal',
    x => x.surfaceProbe.gpuSurface = true, x => x.surfaceProbe.containerSurfaceAttached = true, x => x.surfaceProbe.hostSurfaceAttached = false,
    x => x.surfaceProbe.rendererBackend = 'skia-gpu-gles', x => x.surfaceProbe.presenterBackend = 'gl',
    x => x.surfaceProbe.evidenceBoundary = 'runtime-snapshot-upload', x => x.surfaceProbe.gpuCompletion = 'command-submitted',
    x => x.surfaceProbe.presentationCompletion = 'queued', x => x.surfaceProbe.frameId = 8, x => x.surfaceProbe.snapshotSha256 = 'c'.repeat(64),
    x => x.surfaceProbe.sessionId = 'other', x => x.surfaceProbe.engine = 'quickjs']) {
    const wrong = startupFixture(); mutate(wrong); assert.throws(() => assertStartup(linux('x64'), wrong, expected))
  }
})

test('unit child arguments, build lookup and cleanup retain exact Linux ownership', async () => {
  const profile = linux('x64')
  const args = nativeArguments(profile, { pack: '/unit/pack', engine: 'v8', sessionId: 'unit-only' })
  assert.deepEqual(args.slice(-2), ['--presenter', 'software'])
  assert.equal(buildEnvironmentKey(profile, 'v8'), 'WEAPP_CONFORMANCE_LINUX_V8_BUILD')
  assert(!nativeArguments(hostProfile(), { pack: '/unit/pack', engine: 'v8', sessionId: 'unit-only' }).includes('--presenter'))
  const cleanup = { ownedResourcesReleased: true, borrowedResourcesPreserved: true, presenterProfile: 'software',
    softwarePresenterRetired: true, sessionUnloaded: true, eventLoopReturned: true, windowOwnerDropped: true }
  assertCleanup(profile, cleanup, { outcome: { exitCode: 0 } })
  for (const key of ['ownedResourcesReleased', 'borrowedResourcesPreserved', 'softwarePresenterRetired', 'sessionUnloaded', 'eventLoopReturned', 'windowOwnerDropped']) {
    assert.throws(() => assertCleanup(profile, { ...cleanup, [key]: false }, { outcome: { exitCode: 0 } }))
  }
  assert.throws(() => assertCleanup(profile, { ...cleanup, metalContextDetached: true }, { outcome: { exitCode: 0 } }))
  assert.throws(() => assertCleanup(profile, cleanup, { outcome: { exitCode: 1 } }))
  assert.throws(() => assertCleanup(profile, cleanup, { outcome: { exitCode: 0 }, protocolError: new Error('fixture') }))
  assert.deepEqual(await disposeLinux({ outputDirectory: '/unit-no-owned-child' }), { ownedResourcesReleased: true, borrowedResourcesPreserved: true })
})

test('unit CLI parser preserves macOS defaults and rejects ambiguous Linux invocations', () => {
  assert.equal(parseBuildOptions(['--engine', 'v8', '--out', 'unit-out'], root).host, 'macos')
  assert.equal(parseDiagnoseOptions(['--engine', 'quickjs', '--build', 'unit-build', '--out', 'unit-out'], root).host, 'macos')
  for (const parse of [parseBuildOptions, parseDiagnoseOptions]) {
    const args = ['--engine', 'v8', '--out', 'unit-out', ...(parse === parseDiagnoseOptions ? ['--build', 'unit-build'] : [])]
    assert.equal(parse([...args, '--host', 'linux', '--presenter', 'software'], root).host, 'linux')
    for (const tail of [['--host', 'linux'], ['--host', 'linux', '--presenter', 'metal'], ['--engine', 'quickjs'], ['--unknown'], ['--host'], ['--host', 'windows']]) assert.throws(() => parse([...args, ...tail], root))
    assert.throws(() => parse(args.filter(x => x !== 'v8'), root), /Missing/)
  }
  assert.deepEqual(parseRegistryOptions(['--out', 'unit.json']).hosts, ['macos'])
  assert.deepEqual(parseRegistryOptions(['--out', 'unit.json', '--host', 'linux', '--host', 'macos']).hosts, ['linux', 'macos'])
  for (const args of [['--out', 'unit.json', '--host', 'linux', '--host', 'linux'], ['--out', 'unit.json', '--host', 'android'], ['--out'], ['--out', 'x', '--oops']]) assert.throws(() => parseRegistryOptions(args))
})

test('unit executable CLI rejects unknown/missing flags before any build or UI', () => {
  for (const module of ['build.mjs', 'diagnose.mjs', 'driver-registry.mjs']) {
    const result = spawnSync(process.execPath, [resolve(here, module), '--unknown-unit-flag'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Unknown native option/)
    assert.equal(result.stdout, '')
  }
})

test('unit registry binds each requested pair to a complete exact import closure', async () => {
  assert.deepEqual((await createDriverRegistry(root)).drivers.map(x => `${x.host}/${x.engine}`), ['macos/quickjs', 'macos/v8'])
  const registry = await createDriverRegistry(root, { hosts: ['macos', 'linux'] })
  assert.deepEqual(registry.drivers.map(x => `${x.host}/${x.engine}`), ['macos/quickjs', 'macos/v8', 'linux/quickjs', 'linux/v8'])
  for (const driver of registry.drivers) {
    assert(driver.module.path.endsWith(driver.host === 'linux' ? '/linux-driver.mjs' : '/driver.mjs'))
    const references = [driver.module, ...driver.inputs], byPath = new Map(references.map(x => [resolve(root, x.path), x]))
    assert.equal(byPath.size, references.length)
    for (const reference of references) {
      assert.deepEqual(await fileReference(root, resolve(root, reference.path)), reference)
      // TypeScript source/declaration imports may intentionally name emitted .js
      // files that do not live beside the uncompiled source. Validate executable
      // JavaScript imports; every dependency pack reference is still hash checked.
      if (!/\.(?:mjs|js|cjs)$/.test(reference.path)) continue
      const text = await readFile(resolve(root, reference.path), 'utf8')
      for (const match of text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
        const dependency = resolve(dirname(resolve(root, reference.path)), match[1])
        assert(byPath.has(dependency), `missing exact registry input ${dependency}`)
      }
    }
  }
  for (const hosts of [[], ['linux', 'linux'], ['android']]) await assert.rejects(createDriverRegistry(root, { hosts }), /hosts/)
})

test('unit Linux driver keeps common admitted-oracle checks ahead of host, collector and build work', async () => {
  assert.throws(() => createDriver({ host: 'linux' }), /explicit/)
  for (const kind of ['missing', 'trace', 'execution', 'case', 'source']) {
    const oracle = { trace: { path: 'unit/trace.json', sha256: 'a'.repeat(64), bytes: 1 }, execution: { path: 'unit/execution.json', sha256: 'b'.repeat(64), bytes: 2 } }
    const context = { root: '/unit-unavailable', outputDirectory: '/unit-unavailable/output',
      job: { caseId: issue1013.caseId, sourceSha256: issue1013.sourceSha256, host: 'linux', engine: 'quickjs' },
      recipe: { caseId: issue1013.caseId, sourceSha256: issue1013.sourceSha256, oracle, get collector() { throw new Error('unit collector unexpectedly touched') } } }
    if (kind !== 'missing') {
      context.admittedOracle = { caseId: issue1013.caseId, sourceSha256: issue1013.sourceSha256, oracle: structuredClone(oracle) }
      if (kind === 'trace' || kind === 'execution') context.admittedOracle.oracle[kind].sha256 = 'c'.repeat(64)
      if (kind === 'case') context.admittedOracle.caseId = 'unit-foreign'
      if (kind === 'source') context.admittedOracle.sourceSha256 = 'd'.repeat(64)
    }
    await assert.rejects(runLinux(context), /differs from its admitted source\/trace\/execution identity/)
    if (kind !== 'missing') await assert.rejects(diagnoseLinux(context), /differs from its admitted source\/trace\/execution identity/)
  }
})
