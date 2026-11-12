import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { finishIOSBuild, collectIOSExecution, iosCargoTargetDirectory,
  selectIOSCargoArchive, prepareIOSLinkArchive, verifyIOSLinkArchive } from './ios-app-execution-evidence.mjs'

const source = () => ({ sourceCommit: 'a'.repeat(40), sourceSha256: 'b'.repeat(64), workingTreeDirty: false, workingTreeScope: ['crates', 'examples/hosts/ios'] })
const archive = engine => ({ status: 'passed', engine, sha256: 'c'.repeat(64), linkedPath: '/owned-run/native-input/libcontainer_host_ios.a' })
const target = { host: 'ios', kind: 'official-simulator', id: 'explicit-owned-simulator' }

function executionFixture(appMode = 'smoke') {
  const root = 'd'.repeat(64), sessionId = 'collector-session'
  const startupRoute = 'pages/home', route = appMode === 'embedding' ? 'pages/details' : startupRoute
  const frameId = appMode === 'embedding' ? 8 : 1
  const manifest = { integrity: { root }, routes: [{ path: startupRoute }, { path: 'pages/details' }],
    modules: [{ id: 'app.js' }], templates: [startupRoute, 'pages/details'].map(path => ({ id: `template:${path}.wxml` })) }
  const operations = {}
  for (const op of ['app.init', 'app.lifecycle', 'page.push', 'render.commit']) {
    const payload = op === 'app.lifecycle' ? { event: 'launch' } : op === 'page.push' ? { path: startupRoute }
      : op === 'render.commit' ? { templateId: `template:${route}.wxml`, frameId, viewport: { x: 0, y: 0, width: 10, height: 20 } } : {}
    const request = { op, protocolVersion: '1.0', kind: 'request', requestId: op, sessionId, payload }
    const response = { ok: true, engineProviderAvailable: true, engine: 'quickjs', loadedModules: 1,
      manifest: { integrity: root }, committed: true, source: 'manifest', templateId: `template:${route}.wxml`, frameId }
    operations[op] = { status: 0, request, json: JSON.stringify({ messages: [{ ...request, kind: 'response', payload: response }] }) }
  }
  operations['render.snapshot'] = { status: 0, sessionId, json: JSON.stringify({ frame_id: frameId,
    format: 'rgba8-premultiplied', width: 10, height: 20, pixelCount: 800, sha256: 'e'.repeat(64) }) }
  const probe = { schemaVersion: 1, status: 'passed', source: appMode === 'embedding' ? 'ios-skia-metal-embedding' : 'ios-skia-metal-app',
    containerSurfaceAttached: true, gpuSurface: true, rendererBackend: 'skia-gpu-metal', commandBufferStatus: 4,
    host: 'ios', engine: 'quickjs', sessionId, manifestIntegrity: root, frameId, route, width: 20, height: 40,
    logicalViewport: { width: 10, height: 20 },
    snapshotSha256: 'e'.repeat(64),
    drawableReadback: { width: 20, height: 40, byteCount: 3200, format: 'bgra8-premultiplied', sha256: 'f'.repeat(64), pngSha256: 'a'.repeat(64) },
    runtimeSurface: { loaded: true, nativeSurface: true, gpuSurface: true, renderer: 'skia-gpu-metal' },
    startup: { input: 'portable-pack', integrityRoot: root, route: startupRoute, diagnostics: [], engine: 'quickjs', sessionId }, operations }
  if (appMode === 'embedding') probe.sessionOpen = true
  else probe.detachStatus = 0
  const build = finishIOSBuild(source(), source(), Buffer.from('actual signed executable'), 'quickjs', archive('quickjs'), appMode)
  return { probe, manifest, build }
}
test('build provenance binds actual executable bytes and rejects source changes during compilation', () => {
  const before = source()
  const build = finishIOSBuild(before, source(), Buffer.from('actual signed executable'), 'quickjs', archive('quickjs'))
  assert.equal(build.status, 'passed')
  assert.equal(build.host, 'ios')
  assert.equal(build.appMode, 'smoke')
  assert.deepEqual(build.nativeArchive, archive('quickjs'))
  assert.notEqual(build.artifactSha256, finishIOSBuild(before, source(), Buffer.from('other executable'), 'quickjs', archive('quickjs')).artifactSha256)
  for (const field of ['sourceCommit', 'sourceSha256']) {
    assert.throws(() => finishIOSBuild(before, { ...source(), [field]: 'changed' }, Buffer.from('bytes'), 'quickjs', archive('quickjs')), /changed during/)
  }
  assert.throws(() => finishIOSBuild(before, source(), Buffer.from('bytes'), 'quickjs'), /exact.*linker input/)
  assert.throws(() => finishIOSBuild(before, source(), Buffer.from('bytes'), 'quickjs', archive('v8')), /exact.*linker input/)
})
test('embedding build mode preserves signed artifact, exact archive and source binding', () => {
  const executable = Buffer.from('signed embedding Mach-O bytes')
  const build = finishIOSBuild(source(), source(), executable, 'quickjs', archive('quickjs'), 'embedding')
  assert.equal(build.appMode, 'embedding')
  assert.equal(build.status, 'passed')
  assert.equal(build.artifactKind, 'signed-mach-o-executable')
  assert.equal(build.artifactSha256, createHash('sha256').update(executable).digest('hex'))
  assert.equal(build.sourceCommit, source().sourceCommit)
  assert.equal(build.sourceSha256, source().sourceSha256)
  assert.deepEqual(build.nativeArchive, archive('quickjs'))
  assert.equal(build.artifactSha256,
    finishIOSBuild(source(), source(), executable, 'quickjs', archive('quickjs'), 'smoke').artifactSha256)
  for (const field of ['sourceCommit', 'sourceSha256']) {
    assert.throws(() => finishIOSBuild(source(), { ...source(), [field]: 'changed' }, executable, 'quickjs', archive('quickjs'), 'embedding'), /changed during/)
  }
  assert.throws(() => finishIOSBuild(source(), source(), executable, 'quickjs', archive('v8'), 'embedding'), /exact.*linker input/)
  assert.throws(() => finishIOSBuild(source(), source(), executable, 'quickjs', archive('quickjs'), 'automatic'), /invalid.*mode/)
  const dirty = finishIOSBuild({ ...source(), workingTreeDirty: true }, source(), executable, 'quickjs', archive('quickjs'), 'embedding')
  assert.equal(dirty.status, 'unknown')
  assert.equal(dirty.workingTreeDirty, true)
})
test('an uncommitted build remains unknown and cannot claim clean commit provenance', () => {
  for (const dirtyBefore of [true, false]) {
    const build = finishIOSBuild({ ...source(), workingTreeDirty: dirtyBefore },
      { ...source(), workingTreeDirty: !dirtyBefore }, Buffer.from('bytes'), 'v8', archive('v8'))
    assert.equal(build.status, 'unknown')
    assert.equal(build.workingTreeDirty, true)
  }
  assert.throws(() => finishIOSBuild(source(), source(), Buffer.from('bytes'), 'automatic-fallback'), /invalid.*engine/)
})

function artifactMessages(root, targetDir, changes = {}) {
  const target = 'aarch64-apple-ios-sim'
  const artifact = {
    reason: 'compiler-artifact', package_id: `path+file://${root}/crates/container-host-ios#0.1.0`,
    manifest_path: resolve(root, 'crates/container-host-ios/Cargo.toml'),
    target: { name: 'container_host_ios', src_path: resolve(root, 'crates/container-host-ios/src/lib.rs'), crate_types: ['rlib', 'staticlib'] },
    features: ['ios', 'metal', 'quickjs-native-ios', 'skia-gpu-metal'],
    filenames: [resolve(targetDir, target, 'debug/libcontainer_host_ios.a')], fresh: false,
    ...changes,
  }
  return [artifact, { reason: 'build-finished', success: true }].map(value => JSON.stringify(value)).join('\n')
}

test('Cargo target directory resolves the caller override once and always overrides config', () => {
  assert.equal(iosCargoTargetDirectory('/project', {}), '/project/target')
  assert.equal(iosCargoTargetDirectory('/project', { CARGO_TARGET_DIR: '/isolated/target' }), '/isolated/target')
  assert.equal(iosCargoTargetDirectory('/project', { CARGO_TARGET_DIR: '../external target' }), '/external target')
})

test('Cargo artifact selection rejects stale/default paths, other engines, foreign sources and failed builds', () => {
  const options = { root: '/project', targetDir: '/external/target', target: 'aarch64-apple-ios-sim', engine: 'quickjs' }
  const messages = artifactMessages(options.root, options.targetDir)
  assert.equal(selectIOSCargoArchive(messages, options).path, '/external/target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a')
  for (const changes of [
    { filenames: ['/project/target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a'] },
    { filenames: ['/external/target/x86_64-apple-ios/debug/libcontainer_host_ios.a'] },
    { features: ['ios', 'metal', 'v8-native'] },
    { features: ['ios', 'metal', 'v8-native', 'quickjs-native-ios'] },
    { manifest_path: '/other/crates/container-host-ios/Cargo.toml' },
    { target: { name: 'container_host_ios', src_path: '/other/src/lib.rs', crate_types: ['staticlib'] } },
  ]) assert.throws(() => selectIOSCargoArchive(artifactMessages(options.root, options.targetDir, changes), options), /differs/)
  assert.throws(() => selectIOSCargoArchive(messages.replace('"success":true', '"success":false'), options), /successful/)
  assert.throws(() => selectIOSCargoArchive(messages + '\n' + messages, options), /one successful/)
  assert.throws(() => selectIOSCargoArchive('{broken', options))
})

test('frozen linker input is independent of Cargo cache replacement and is rehashed before provenance passes', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ios-link-archive-'))
  try {
    const targetDir = resolve(root, 'external target')
    const options = { root, targetDir, outDir: resolve(root, 'owned-run'), target: 'aarch64-apple-ios-sim', engine: 'quickjs', cargoMessagesPath: resolve(root, 'cargo.jsonl') }
    const originalPath = resolve(targetDir, options.target, 'debug/libcontainer_host_ios.a')
    mkdirSync(dirname(originalPath), { recursive: true })
    writeFileSync(originalPath, '!<arch>\ncurrent selected staticlib')
    writeFileSync(options.cargoMessagesPath, artifactMessages(root, targetDir))
    const prepared = await prepareIOSLinkArchive(options)
    assert.equal(prepared.path, originalPath)
    assert.notEqual(prepared.linkedPath, prepared.path)
    assert.equal(prepared.sha256, createHash('sha256').update(readFileSync(originalPath)).digest('hex'))
    writeFileSync(originalPath, 'later concurrent Cargo archive')
    assert.equal(readFileSync(prepared.linkedPath, 'utf8'), '!<arch>\ncurrent selected staticlib')
    assert.equal((await verifyIOSLinkArchive(prepared, 'quickjs')).status, 'passed')
    await assert.rejects(verifyIOSLinkArchive(prepared, 'v8'), /exact.*linker input/)
    writeFileSync(prepared.linkedPath, 'tampered linker input')
    await assert.rejects(verifyIOSLinkArchive(prepared, 'quickjs'), /changed during Swift/)
    await assert.rejects(prepareIOSLinkArchive(options), /EEXIST/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const buildOnly of [false, true]) test(`${buildOnly ? 'build-only' : 'smoke'} links the emitted archive with external CARGO_TARGET_DIR while a stale default archive exists`, { skip: process.platform === 'win32' }, () => {
  const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), 'ios-smoke-build-wiring-')))
  try {
    const root = resolve(sandbox, 'project')
    const bin = resolve(sandbox, 'mock-bin')
    const out = resolve(sandbox, 'runs')
    const externalTarget = resolve(sandbox, 'external target')
    const callsPath = resolve(sandbox, 'calls.jsonl')
    const scripts = resolve(root, 'scripts')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(bin)
    const currentScripts = dirname(fileURLToPath(import.meta.url))
    for (const name of ['ios-app-smoke', 'ios-app-execution-evidence.mjs', 'validate-ios-app-evidence.mjs']) {
      copyFileSync(resolve(currentScripts, name), resolve(scripts, name))
    }
    writeFileSync(resolve(scripts, 'sync-ios-portable-pack.mjs'), `import {mkdirSync} from 'node:fs'; mkdirSync(process.argv[process.argv.indexOf('--destination') + 1], {recursive:true});\n`)
    const stalePath = resolve(root, 'target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a')
    mkdirSync(dirname(stalePath), { recursive: true })
    writeFileSync(stalePath, 'stale default archive')
    const executable = (name, body) => writeFileSync(resolve(bin, name), `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
    executable('rustup', `console.log(process.env.MOCK_BIN + '/' + process.argv[3]);`)
    executable('git', `if(process.argv[2] === 'rev-parse') console.log('a'.repeat(40));`)
    executable('cargo', `const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2); fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({tool:'cargo',args:a})+'\\n'); const dir=a[a.indexOf('--target-dir')+1],target=a[a.indexOf('--target')+1]; if(dir!==process.env.MOCK_TARGET){console.error(JSON.stringify({dir,expected:process.env.MOCK_TARGET,args:a}));process.exit(9);} const path=p.resolve(dir,target,'debug/libcontainer_host_ios.a'); fs.mkdirSync(p.dirname(path),{recursive:true}); fs.writeFileSync(path,'!<arch>\\ncurrent external staticlib'); console.log(JSON.stringify({reason:'compiler-artifact',package_id:'mock-host',manifest_path:p.resolve(process.env.MOCK_ROOT,'crates/container-host-ios/Cargo.toml'),target:{name:'container_host_ios',src_path:p.resolve(process.env.MOCK_ROOT,'crates/container-host-ios/src/lib.rs'),crate_types:['rlib','staticlib']},features:['ios','metal','quickjs-native-ios'],filenames:[path],fresh:false})); console.log(JSON.stringify({reason:'build-finished',success:true}));`)
    executable('xcrun', `const fs=require('node:fs'),a=process.argv.slice(2); fs.appendFileSync(process.env.MOCK_CALLS,JSON.stringify({tool:'xcrun',args:a})+'\\n'); if(a.includes('--show-sdk-path'))console.log('/mock-sdk'); else if(a.includes('swiftc'))fs.writeFileSync(a[a.indexOf('-o')+1],'mock signed Mach-O'); else if(a.join(' ')==='simctl list devices booted --json')console.log(JSON.stringify({devices:{}})); else process.exit(8);`)
    executable('codesign', '')
    const result = spawnSync('bash', [resolve(scripts, 'ios-app-smoke')], {
      cwd: sandbox, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CARGO_TARGET_DIR: externalTarget,
        WEAPP_CONTAINER_IOS_APP_OUT_DIR: out, WEAPP_CONTAINER_IOS_ENGINE: 'quickjs',
        WEAPP_CONTAINER_IOS_BUILD_ONLY: buildOnly ? '1' : '0',
        WEAPP_CONTAINER_IOS_UI_OBSERVATION: buildOnly ? '1' : '0',
        WEAPP_CONTAINER_IOS_SIMULATOR_UDID: '', MOCK_BIN: bin, MOCK_ROOT: root,
        MOCK_TARGET: externalTarget, MOCK_CALLS: callsPath },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, buildOnly ? 0 : 2, `mock stops before any simulator is selected: ${result.stderr}`)
    if (!buildOnly) assert.match(result.stderr, /select exactly one booted simulator/)
    const run = resolve(out, readdirSync(out)[0])
    const build = JSON.parse(readFileSync(resolve(run, 'build.json')))
    assert.equal(build.status, 'passed')
    assert.equal(build.appMode, 'smoke')
    assert.equal(build.nativeArchive.targetDir, externalTarget)
    const product = JSON.parse(readFileSync(resolve(run, 'build-product.json')))
    assert.equal(product.artifactSha256, build.artifactSha256)
    assert.equal(product.buildReceiptPath, resolve(run, 'build.json'))
    assert.equal(product.appPath, resolve(run, 'WeappContainerApp.app'))
    assert.equal(product.engine, 'quickjs')
    assert.equal(product.runDirectory, run)
    assert.equal(readFileSync(build.nativeArchive.linkedPath, 'utf8'), '!<arch>\ncurrent external staticlib')
    assert.equal(readFileSync(stalePath, 'utf8'), 'stale default archive')
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const cargo = calls.find(call => call.tool === 'cargo')
    assert.equal(cargo.args[cargo.args.indexOf('--target-dir') + 1], externalTarget)
    const swift = calls.find(call => call.tool === 'xcrun' && call.args.includes('swiftc'))
    assert.equal(swift.args.includes(build.nativeArchive.linkedPath), true)
    assert.equal(swift.args.includes('-lcontainer_host_ios'), false)
    assert.equal(swift.args.includes(stalePath), false)
    assert.equal(calls.some(call => call.args.includes('install') || call.args.includes('launch')), false)
    if (buildOnly) assert.equal(calls.some(call => call.args.includes('simctl')), false, 'build-only must never contact a simulator')
  } finally { rmSync(sandbox, { recursive: true, force: true }) }
})
test('collector cannot turn failed app or standalone device context into execution evidence', () => {
  assert.throws(() => collectIOSExecution({ status: 'failed' }, {}, {}, {}, 'fixture'), /top-level/)
  assert.throws(() => collectIOSExecution({ status: 'passed', source: 'device-context-only' }, {}, {}, {}, 'fixture'), /wrong evidence/)
})

test('collector accepts live navigated embedding only under embedding build mode and retains source/artifact identity', () => {
  const { probe, manifest, build } = executionFixture('embedding')
  const result = collectIOSExecution(probe, manifest, build, target, 'current-route-fixture')
  assert.equal(result.fixture.sourceCommit, build.sourceCommit)
  assert.deepEqual(result.fixture.manifest, manifest)
  const receipt = result.receipts[0]
  assert.equal(receipt.route, 'pages/details')
  assert.equal(probe.startup.route, 'pages/home')
  assert.equal(receipt.sessionId, probe.sessionId)
  assert.equal(receipt.sourceCommit, build.sourceCommit)
  assert.equal(receipt.artifactSha256, build.artifactSha256)
  assert.deepEqual(receipt.build, build)
  assert.equal(receipt.surfaceProbe.source, 'ios-skia-metal-embedding')
  assert.equal(receipt.surfaceProbe.sessionOpen, true)
  assert.equal(receipt.surfaceProbe.frameId, 8)
  assert.equal(receipt.surfaceProbe.detachStatus, undefined)
  assert.equal(receipt.operations, probe.operations)
  assert.equal(receipt.fixtureId, 'current-route-fixture')
  assert.deepEqual(receipt.target, target)
})

test('collector rejects cross-mode and unknown build modes; legacy mode omission remains smoke', () => {
  for (const appMode of ['smoke', 'embedding']) {
    const { probe, manifest, build } = executionFixture(appMode)
    const otherMode = appMode === 'embedding' ? 'smoke' : 'embedding'
    assert.throws(() => collectIOSExecution(probe, manifest, { ...build, appMode: otherMode }, target, 'fixture'), /wrong evidence source/)
    assert.throws(() => collectIOSExecution(probe, manifest, { ...build, appMode: 'automatic' }, target, 'fixture'), /invalid.*mode/)
    const legacyBuild = { ...build }
    delete legacyBuild.appMode
    if (appMode === 'smoke') {
      assert.equal(collectIOSExecution(probe, manifest, legacyBuild, target, 'fixture').receipts[0].surfaceProbe.source, 'ios-skia-metal-app')
    } else assert.throws(() => collectIOSExecution(probe, manifest, legacyBuild, target, 'fixture'), /wrong evidence source/)
  }
})

test('collector cannot use a live-session flag to omit smoke teardown', () => {
  const { probe, manifest, build } = executionFixture()
  probe.sessionOpen = true
  delete probe.detachStatus
  assert.throws(() => collectIOSExecution(probe, manifest, build, target, 'fixture'), /teardown/)
})

test('embedding collector still requires matched executable engine, explicit target and fixture', () => {
  const { probe, manifest, build } = executionFixture('embedding')
  for (const changedBuild of [{ ...build, engine: 'v8' }, { ...build, artifactSha256: 'missing' }, { ...build, host: 'android' }]) {
    assert.throws(() => collectIOSExecution(probe, manifest, changedBuild, target, 'fixture'), /build identity|engine mismatch/)
  }
  assert.throws(() => collectIOSExecution(probe, manifest, build, { ...target, id: '' }, 'fixture'), /explicit fixture/)
  assert.throws(() => collectIOSExecution(probe, manifest, build, target, ''), /explicit fixture/)
})
