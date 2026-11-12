/** Synthetic local files and extracted pinned helpers only. No real CLI/SDK/UI. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { WXML_PRODUCER_CASE, WXML_PRODUCER_GUARDS, wxmlProducerInvocation, verifyWxmlProducerTransaction,
  verifyWxmlProducerGuards, verifyWxmlSnapshotFinal, verifyWxmlSourceCleanup } from './conformance-wxml-producer.mjs'
import { instrumentSnapshotAutomator, createObservedOwnedRm, verifySnapshotCandidateLedger } from './conformance-snapshot-transport.mjs'
import { captureOwnedSnapshot, captureOwnedSnapshotCleanup, captureOfficialFixtureCheckpoint,
  flushStaticFixtureBuildRecorder, installWxmlSourceCleanupObserver, installOwnedSnapshotCleanupObserver } from './conformance-fixture-build.mjs'
import { reviewedR5bFixture, rebindSyntheticSnapshotProducer } from './fixtures/conformance-reviewed-producers.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const vendor = path.join(repository, 'vendor/weapp-vite')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const source = name => fs.readFileSync(path.join(vendor, name), 'utf8')
function functions(text, names) {
  const tree = ts.createSourceFile('pinned.ts', text, ts.ScriptTarget.Latest, true)
  const selected = tree.statements.filter(item => ts.isFunctionDeclaration(item) && names.includes(item.name?.text))
  assert.equal(selected.length, names.length, 'pinned oracle function boundary changed')
  return selected.map(item => item.getText(tree).replace(/^export\s+/, '')).join('\n')
}
function compile(text) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText.replace(/export \{\};?\s*$/, '')
}
function upstreamSnapshot(project, dist, checkout) {
  const names = ['readJsonObject', 'writeJsonObject', 'normalizeProjectRelativeRoot', 'createBridgeWrapperProjectConfig',
    'resolveBridgeWrapperProjectConfig', 'shouldPreserveBridgeWrapperPath', 'removeStaleBridgeWrapperDistEntries',
    'copyBridgeWrapperDistSnapshot', 'copyProjectRootForBridgeWrapper', 'prepareAutomatorBridgeWrapperProject']
  const copyNames = ['safeStat', 'safeReadDirectory', 'publishBridgeWrapperFile', 'copyDistEntryForBridgeWrapper']
  const body = functions(source('e2e/utils/automator.ts'), names) + '\n' + functions(source('e2e/utils/automatorBridgeFiles.ts'), copyNames)
  const run = vm.runInNewContext(compile('let bridgeWrapperLaunchSequence=0,bridgeSyncTempSequence=0;\n' + body)
    + '\nprepareAutomatorBridgeWrapperProject', {
    fs, path, crypto, process, AUTOMATOR_BRIDGE_WRAPPER_ROOT: path.join(checkout, '.tmp/e2e-ide-bridge-projects'),
    resolveAutomatorBridgeProjectMode: () => 'snapshot', startBridgeWrapperDistSync: () => () => {}, createRetryableCleanup: cleanup => cleanup,
  })
  return run(project, { appConfigPath: path.join(dist, 'app.json') }, 'snapshot')
}

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'wxml-producer-unit-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const checkout = path.join(root, 'checkout'), identity = WXML_PRODUCER_CASE
  const seed = path.join(checkout, 'e2e-apps/github-issues/fixtures/wxml-transform')
  const write = (base, name, bytes) => { fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true }); fs.writeFileSync(path.join(base, name), bytes) }
  for (const relative of ['packages/weapp-vite', 'packages-runtime/wevu']) write(checkout, relative + '/entry.js', 'synthetic dependency\n')
  write(seed, 'project.config.json', json({ compileType: 'miniprogram', miniprogramRoot: 'dist/', srcMiniprogramRoot: 'dist/',
    libVersion: '3.17.3', setting: { packNpmManually: true, packNpmRelationList: [{}] } }))
  write(seed, 'project.private.config.json', json({ projectname: 'synthetic-wxml', setting: { urlCheck: false },
    condition: { miniprogram: { list: [{ pathName: 'pages/native/index' }, { pathName: 'pages/vue/index' }] } } }))
  write(seed, 'src/app.ts', 'actual synthetic source must remain\n')
  write(seed, 'weapp-vite.config.ts', 'export default {}\n')
  let invocation
  const helper = vm.runInNewContext(compile(functions(source('e2e/utils/wxmlTransformProject.ts'), ['createWxmlTransformProject', 'buildWxmlTransformProject']))
    + '\n({createWxmlTransformProject,buildWxmlTransformProject})', { ...fs.promises, path, process, ROOT: checkout,
    sanitizeBuildCommandEnv: () => ({ SYNTHETIC: '1' }), execa: (command, args, options) => { invocation = { command, args, options }; return Promise.resolve() } })
  const project = await helper.createWxmlTransformProject(), dist = path.join(project, 'dist')
  await helper.buildWxmlTransformProject(project)
  const { args, options: { cwd } } = invocation, cliPath = args[0]
  const profile = wxmlProducerInvocation({ ...identity, args, cliPath, cwd, checkout })
  const put = bytes => {
    bytes = Buffer.from(bytes)
    const sha256 = hash(bytes), relative = `objects/${sha256}`, file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
    return { path: relative, sha256, bytes: bytes.length }
  }
  const load = ref => { const bytes = fs.readFileSync(path.join(root, ref.path)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes); return bytes }
  const members = [], guards = WXML_PRODUCER_GUARDS.map(({ path: name }) => {
    const original = source(name), observed = name.endsWith('/automator.ts') ? instrumentSnapshotAutomator(original) : original, artifact = put(observed)
    members.push({ path: name, kind: 'file', origin: name.endsWith('/automator.ts') ? 'patch' : 'source', sha256: artifact.sha256, bytes: artifact.bytes })
    return { path: name, original: put(original), observed: artifact }
  })
  const guard = put(JSON.stringify({ members }))
  const read = base => {
    const files = [], walk = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix ? prefix + '/' + entry.name : entry.name, file = path.join(directory, entry.name)
        if (name === 'dist') continue
        if (entry.isDirectory()) walk(file, name)
        else if (entry.isFile()) files.push({ path: name, kind: 'file', artifact: put(fs.readFileSync(file)) })
        else files.push({ path: name, kind: 'consumer-link', target: path.relative(checkout, fs.realpathSync(file)).split(path.sep).join('/'), consumerGuard: guard })
      }
    }; walk(base); return files
  }
  const before = read(project)
  const raw = { 'app.json': json({ pages: ['pages/native/index', 'pages/vue/index'] }), 'app.js': 'App({});\n',
    'pages/native/index.js': 'Page({});\n', 'pages/native/index.json': '{}', 'pages/native/index.wxml': '<view>actual synthetic native</view>',
    'pages/vue/index.js': 'Page({});\n', 'pages/vue/index.json': '{}', 'pages/vue/index.wxml': '<view>actual synthetic vue</view>' }
  for (const [name, bytes] of Object.entries(raw)) write(dist, name, bytes)
  const build = { action: 'static-build', status: 'built', projectPath: project, outputRoot: dist, outputRelative: 'dist', producerProfile: profile,
    command: [process.execPath, ...args], cwd, pid: process.pid, observer: { pid: process.pid, threadId: 0 },
    startedAt: new Date(Date.now() - 10).toISOString(), endedAt: new Date().toISOString(), exitCode: 0, signal: null,
    outputCaptured: true, outputAbsent: true, sourceBefore: before, sourceAfter: before, generatedSupport: [], generated: read(dist) }
  const directoryStat = fs.lstatSync(project, { bigint: true })
  build.sourceRootIdentity = { device: directoryStat.dev.toString(), inode: directoryStat.ino.toString(), birthtimeNs: directoryStat.birthtimeNs.toString() }
  build.projectConfig = before.find(item => item.path === 'project.config.json').artifact
  const wrapper = upstreamSnapshot(project, dist, checkout)
  const recorder = { root, directory: path.join(root, 'recorder'), put, ...identity, observer: build.observer, ownerId: 'synthetic-owner',
    staticProfileInputs: ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs'].map(name => ({ path: 'scripts/' + name, artifact: put(fs.readFileSync(new URL('./' + name, import.meta.url))) })),
    config: { checkout, runId: 'synthetic-run', membersReference: guard }, compilerBuild: put('{}'),
    builds: [build], pending: [], snapshots: [], snapshotFailures: [], producerGuards: guards }
  fs.mkdirSync(recorder.directory)
  const observation = { sourceProjectPath: project, generatedRoot: dist, projectPath: wrapper.path, runtimeRoot: wrapper.runtimeRoot, cliPath: '/synthetic/selected/cli' }
  const capture = () => captureOwnedSnapshot({ recorder, observation })
  const verify = transaction => verifyWxmlProducerTransaction({ transaction, build, checkout, members, load, identity })
  const checkpoint = () => captureOfficialFixtureCheckpoint({ recorder, runtimeObservation: { projectPath: wrapper.path,
    recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64) } })
  const cleanupSnapshot = async () => {
    const restore = installOwnedSnapshotCleanupObserver({ recorder })
    try { await wrapper.cleanup(); await Promise.all(recorder.pending); return recorder.snapshots[0].cleanup }
    finally { await Promise.all(recorder.pending); restore() }
  }
  return { root, checkout, project, dist, identity, profile, args, cwd, cliPath, put, load, write, build, members, guards, recorder,
    wrapper, observation, capture, verify, checkpoint, cleanupSnapshot, invocation }
}

test('exact pinned standalone helper and Automator copy retain actual post-CLI bytes without GitHub normalization', async t => {
  const f = await fixture(t), captured = await f.capture(), checked = f.verify(captured.attestation)
  assert.equal(f.invocation.command, process.execPath)
  assert.equal(f.invocation.options.extendEnv, false)
  assert.equal(f.cwd, f.checkout)
  assert.deepEqual(captured.attestation.postHelperSource, f.build.sourceAfter)
  assert.deepEqual(captured.attestation.postHelperGenerated, f.build.generated)
  assert.equal(captured.attestation.postHelperSource.filter(item => item.kind === 'consumer-link').length, 2)
  assert.ok(captured.attestation.postHelperSource.some(item => item.path === 'src/app.ts'))
  const app = JSON.parse(f.load(checked.runtimeGenerated.find(item => item.path === 'app.json').artifact))
  assert.equal(Object.hasOwn(app, 'subPackages'), false)
  assert.equal(Object.hasOwn(app, 'subpackages'), false)
  const config = JSON.parse(f.load(captured.attestation.snapshotFiles.find(item => item.path === 'project.config.json').artifact))
  assert.equal(config.miniprogramRoot, './')
  assert.equal(config.setting.packNpmManually, false)
  assert.deepEqual(config.setting.packNpmRelationList, [])
})

test('runtime snapshot byte-identical clone before SDK checkpoint cannot replace its physical directory', async t => {
  const f = await fixture(t), captured = await f.capture()
  const moved = f.wrapper.path + '-original'
  fs.renameSync(f.wrapper.path, moved)
  fs.cpSync(moved, f.wrapper.path, { recursive: true })
  assert.notEqual(fs.lstatSync(f.wrapper.path).ino, fs.lstatSync(moved).ino)
  await assert.rejects(f.checkpoint(), /runtime snapshot physical directory identity differs/)
  assert.equal(fs.existsSync(moved), true)
  assert.equal(captured.attestation.runtimeRootIdentity.inode, String(fs.lstatSync(moved).ino))
})

test('runtime snapshot symlink substitution after SDK checkpoint cannot supply original cleanup proof', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const moved = f.wrapper.path + '-original'
  fs.renameSync(f.wrapper.path, moved)
  fs.symlinkSync(moved, f.wrapper.path, 'dir')
  const originalResult = await f.cleanupSnapshot()
  assert.equal(originalResult, undefined)
  assert.equal(fs.existsSync(moved), true)
  assert.equal(fs.existsSync(f.wrapper.path), false)
  assert.equal(f.recorder.snapshots[0].cleanup, undefined)
  assert.match(f.recorder.snapshotFailures.join('\n'), /runtime snapshot.*directory identity|awaited removal/)
  const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
  assert.equal(summary.attestation.status, 'blocked')
})

test('snapshot original rm dispatch stays in the identity-check turn and preserves its result with idempotent restore', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const original = fs.promises.rm, events = [], result = { original: 'return-value' }
  let release
  fs.promises.rm = function (target, options) {
    events.push('original-dispatch')
    assert.equal(fs.lstatSync(target).ino.toString(), f.recorder.snapshots[0].value.runtimeRootIdentity.inode)
    assert.deepEqual(options, { recursive: true, force: true })
    return new Promise(resolve => { release = () => { fs.rmSync(target, options); resolve(result) } })
  }
  const restore = installOwnedSnapshotCleanupObserver({ recorder: f.recorder })
  try {
    queueMicrotask(() => events.push('queued-microtask'))
    const pending = fs.promises.rm(f.wrapper.path, { recursive: true, force: true })
    assert.deepEqual(events, ['original-dispatch'])
    assert.throws(restore, /active or lost/)
    release()
    assert.equal(await pending, result)
    await Promise.all(f.recorder.pending)
    assert.deepEqual(events, ['original-dispatch', 'queued-microtask'])
    const cleanup = JSON.parse(f.load(f.recorder.snapshots[0].cleanup))
    assert.equal(cleanup.originalRemoval.status, 'fulfilled')
    assert.equal(cleanup.originalRemoval.pathAbsent, true)
    assert.equal(cleanup.originalRemoval.boundary, 'identity-at-dispatch-original-remove-settlement-path-absence')
    assert.equal(Object.hasOwn(cleanup, 'directoryUnlinked'), false)
    restore(); restore()
  } finally {
    await Promise.all(f.recorder.pending); restore(); fs.promises.rm = original; syncBuiltinESMExports()
  }
})

test('snapshot original rm error is preserved and repeated flush/restore cannot manufacture cleanup', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const original = fs.promises.rm, error = { original: 'rm-error' }
  fs.promises.rm = function () { return Promise.reject(error) }
  const restore = installOwnedSnapshotCleanupObserver({ recorder: f.recorder })
  try {
    await assert.rejects(fs.promises.rm(f.wrapper.path, { recursive: true, force: true }), value => value === error)
    await Promise.all(f.recorder.pending)
    assert.equal(fs.existsSync(f.wrapper.path), true)
    assert.equal(f.recorder.snapshots[0].cleanup, undefined)
    assert.equal(f.recorder.snapshots[0].originalRemoval, undefined)
    assert.equal(f.recorder.snapshotFailures.length > 0, true)
    restore(); restore()
    for (let i = 0; i < 2; i++) {
      const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
      assert.equal(summary.attestation.status, 'blocked')
      assert.equal(summary.attestation.producerFinal, undefined)
    }
  } finally {
    await Promise.all(f.recorder.pending); restore(); fs.promises.rm = original; syncBuiltinESMExports()
  }
})

test('snapshot final reader requires capture, before-cleanup and original-dispatch identities and settlement facts', async t => {
  const f = await completed(t)
  const input = { final: f.summary.attestation.producerFinal, transactionReference: f.captured.reference, build: f.build,
    checkpointAt: f.checkpoint.attestation.capturedAt, recordingEndedAt: f.summary.attestation.recordingEndedAt,
    checkout: f.checkout, members: f.members, load: f.load, identity: f.identity }
  const cleanup = JSON.parse(f.load(input.final[0].cleanup))
  for (const patch of [{ runtimeRootIdentity: undefined }, { originalRemoval: undefined },
    { originalRemoval: { ...cleanup.originalRemoval, status: 'rejected' } },
    { originalRemoval: { ...cleanup.originalRemoval, pathAbsent: false } },
    { originalRemoval: { ...cleanup.originalRemoval, identityAtDispatch: { ...cleanup.runtimeRootIdentity, inode: '1' } } }]) {
    assert.throws(() => verifyWxmlSnapshotFinal({ ...input, final: [{ ...input.final[0], cleanup: f.put(JSON.stringify({ ...cleanup, ...patch })) }] }), /directory identity|removal boundary/)
  }
})

test('closed invocation rejects other cases, external-rule roots, aliases, cwd, flags and malformed temporary roots', async t => {
  const f = await fixture(t), base = { ...f.identity, args: f.args, cliPath: f.cliPath, cwd: f.cwd, checkout: f.checkout }
  const bad = [
    { caseId: 'ide-wxml-transform-watch-runtime' }, { caseSourcePath: 'e2e/ide/other.test.ts' }, { sourceSha256: '0'.repeat(64) },
    { cwd: f.project }, { args: [...f.args, '--platform', 'weapp'] }, { args: [...f.args, '--skipNpm'] },
    { args: [f.cliPath, 'dev', f.project] }, { args: [f.cliPath, 'build', path.join(f.project, 'project')] },
    { args: [f.cliPath, 'build', f.project + '/.'] }, { args: [f.cliPath, 'build', path.relative(f.checkout, f.project)] },
    { args: [f.cliPath, 'build', path.join(f.checkout, '.tmp/e2e-projects/wxml-transform-x')] },
    { args: [f.cliPath, 'build', path.join(f.checkout, '.tmp/e2e-projects/other-123456')] },
  ]
  for (const patch of bad) assert.equal(wxmlProducerInvocation({ ...base, ...patch }), null, JSON.stringify(patch))
})

test('guard requires original case/helper/Automator/copy/buildLog bytes and exact sealed patch origin', async t => {
  const f = await fixture(t)
  verifyWxmlProducerGuards({ guards: f.guards, members: f.members, load: f.load })
  for (let at = 0; at < f.guards.length; at++) {
    for (const key of ['original', 'observed']) {
      const guards = structuredClone(f.guards); guards[at][key] = f.put('foreign helper')
      assert.throws(() => verifyWxmlProducerGuards({ guards, members: f.members, load: f.load }), /source guard differs|exact reviewed transform/)
    }
  }
  const members = structuredClone(f.members); members[0].origin = 'patch'
  assert.throws(() => verifyWxmlProducerGuards({ guards: f.guards, members, load: f.load }), /exact reviewed transform/)
})

test('identity transition rejects source pruning, config rewrite, generated normalization and dependency link substitution', async t => {
  const f = await fixture(t), captured = await f.capture()
  for (const mutate of [
    value => { value.postHelperSource = value.postHelperSource.filter(item => item.path !== 'src/app.ts') },
    value => { value.postHelperSource.find(item => item.path === 'project.private.config.json').artifact = f.put('{}') },
    value => { value.postHelperGenerated.find(item => item.path === 'app.json').artifact = f.put(json({ pages: [], subpackages: [] })) },
    value => { value.postHelperSource.find(item => item.kind === 'consumer-link').target = 'packages/foreign' },
  ]) {
    const value = structuredClone(captured.attestation); mutate(value)
    assert.throws(() => f.verify(value), /not identity/)
  }
  const original = f.build.sourceAfter
  f.build.sourceAfter = original.map(item => item.kind === 'consumer-link' ? { ...item, target: 'packages/foreign' } : item)
  const value = structuredClone(captured.attestation); value.postHelperSource = f.build.sourceAfter
  assert.throws(() => f.verify(value), /dependency links differ/)
})

test('actual snapshot rejects changed, extra, missing and duplicate files including wrapper configurations', async t => {
  const f = await fixture(t), captured = await f.capture()
  for (const mutate of [
    value => { value.snapshotFiles.find(item => item.path.endsWith('.wxml')).artifact = f.put('<view>foreign</view>') },
    value => { value.snapshotFiles.find(item => item.path === 'project.config.json').artifact = f.put('{}') },
    value => value.snapshotFiles.pop(),
    value => value.snapshotFiles.push({ path: 'foreign', kind: 'file', artifact: f.put('foreign') }),
    value => value.snapshotFiles.push(value.snapshotFiles[0]),
  ]) {
    const value = structuredClone(captured.attestation); mutate(value)
    assert.throws(() => f.verify(value), /snapshot|duplicate/)
  }
})

test('transport binds outer case, build owner, physical snapshot root, capture time and implementation closure', async t => {
  const f = await fixture(t), captured = await f.capture()
  for (const patch of [{ buildPid: 1 }, { sourceRoot: '/foreign' }, { runtimeProjectPath: path.join(f.checkout, '.tmp/e2e-ide-bridge-projects/foreign') },
    { runtimeRoot: '/foreign' }, { observer: { pid: 1, threadId: 0 } }, { capturedAt: new Date(Date.parse(f.build.endedAt) - 1).toISOString() },
    { producer: f.put('foreign') }, { transport: f.put('foreign') }]) {
    assert.throws(() => f.verify({ ...structuredClone(captured.attestation), ...patch }), /WXML/)
  }
  assert.throws(() => verifyWxmlProducerTransaction({ transaction: captured.attestation, build: f.build, checkout: f.checkout,
    members: f.members, load: f.load, identity: { ...f.identity, caseId: 'other' } }), /another consumer case/)
})

test('SDK checkpoint requires actual unchanged source/generated/snapshot and selected installation interval', async t => {
  const f = await fixture(t); await f.capture()
  f.write(f.project, 'src/app.ts', 'changed before actual checkpoint')
  await assert.rejects(f.checkpoint(), /changed before actual SDK checkpoint/)
})

test('failed WXML semantic validation retains a complete raw candidate with actual bytes and a rejected outcome', async t => {
  const f = await fixture(t)
  f.write(f.dist, 'app.js', 'actual invalid WXML generation')
  let failure
  await assert.rejects(f.capture(), error => { failure = error; return /not identity/.test(error.message) })
  const candidate = JSON.parse(f.load(failure.snapshotCandidate)), validation = JSON.parse(f.load(failure.snapshotValidation))
  assert.equal(candidate.complete, true)
  assert.equal(candidate.ownerId, f.recorder.ownerId)
  assert.equal(candidate.observation.sourceProjectPath, f.project)
  const transaction = JSON.parse(f.load(candidate.transaction))
  assert.equal(f.load(transaction.postHelperGenerated.find(item => item.path === 'app.js').artifact).toString(), 'actual invalid WXML generation')
  assert.ok(transaction.snapshotFiles.length)
  assert.equal(validation.status, 'rejected')
  assert.deepEqual(validation.candidate, failure.snapshotCandidate)
  assert.deepEqual(f.recorder.snapshots, [])
  const index = JSON.parse(fs.readFileSync(path.join(f.recorder.directory, 'snapshot-producer-candidates.json')))
  assert.deepEqual(index.candidates, [{ candidate: failure.snapshotCandidate, validation: failure.snapshotValidation }])
})

async function completed(t) {
  const f = await fixture(t), captured = await f.capture(), checkpoint = await f.checkpoint()
  const restore = installWxmlSourceCleanupObserver({ recorder: f.recorder })
  try { assert.equal(await rm(f.project, { recursive: true, force: true }), undefined) }
  finally { await Promise.all(f.recorder.pending); restore() }
  await f.cleanupSnapshot()
  const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
  assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  const sourceInput = { final: summary.attestation.producerSourceCleanup, transaction: captured.attestation,
    transactionReference: captured.reference, ownerId: f.recorder.ownerId, checkpointAt: checkpoint.attestation.capturedAt,
    recordingEndedAt: summary.attestation.recordingEndedAt, load: f.load }
  return { ...f, captured, checkpoint, summary, sourceInput }
}

test('original awaited source rm and snapshot rm produce separately bound final cleanup proofs', async t => {
  const f = await completed(t)
  verifyWxmlSourceCleanup(f.sourceInput)
  verifyWxmlSnapshotFinal({ final: f.summary.attestation.producerFinal, transactionReference: f.captured.reference, build: f.build,
    checkpointAt: f.checkpoint.attestation.capturedAt, recordingEndedAt: f.summary.attestation.recordingEndedAt,
    checkout: f.checkout, members: f.members, load: f.load, identity: f.identity })
  assert.equal(f.summary.attestation.finalGuard, 'owned-project-cleaned-after-captured-generation')
  assert.equal(f.summary.attestation.producerSourceFinal, undefined)
  assert.equal(fs.existsSync(f.project), false)
  assert.equal(fs.existsSync(f.wrapper.path), false)
})

test('source cleanup reader rejects cross-owner, reference, interval, absence and before-read substitutions', async t => {
  const f = await completed(t), original = JSON.parse(f.load(f.sourceInput.final))
  for (const patch of [{ ownerId: 'other' }, { sourceRoot: '/foreign' }, { generatedRoot: '/foreign' }, { projectAbsent: false },
    { observer: { pid: 1, threadId: 0 } }, { transaction: f.put('{}') },
    { removedAt: new Date(Date.parse(f.summary.attestation.recordingEndedAt) + 1).toISOString() }]) {
    assert.throws(() => verifyWxmlSourceCleanup({ ...f.sourceInput, final: f.put(JSON.stringify({ ...original, ...patch })) }), /WXML/)
  }
  const before = JSON.parse(f.load(original.beforeCleanup))
  for (const patch of [{ sourceFiles: [] }, { generatedFiles: [] }, { ownerId: 'other' },
    { capturedAt: new Date(Date.parse(f.checkpoint.attestation.capturedAt) - 1).toISOString() }]) {
    const cleanup = { ...original, beforeCleanup: f.put(JSON.stringify({ ...before, ...patch })) }
    assert.throws(() => verifyWxmlSourceCleanup({ ...f.sourceInput, final: f.put(JSON.stringify(cleanup)) }), /WXML/)
  }
  assert.throws(() => verifyWxmlSourceCleanup({ ...f.sourceInput, final: undefined }), /proof is missing/)
})

test('final candidate ledger accepts validated owned bytes and rejects failed, cross-owned and late validation', async t => {
  const f = await completed(t), checkpoint = f.checkpoint.attestation
  const input = { entries: f.summary.attestation.producerCandidates, final: f.summary.attestation.producerFinal, identity: checkpoint,
    ownerId: checkpoint.ownerId, runId: checkpoint.runId, observer: checkpoint.observer, build: checkpoint.build,
    transactionReference: checkpoint.producerTransaction, checkpointAt: checkpoint.capturedAt,
    recordingEndedAt: f.summary.attestation.recordingEndedAt, load: f.load }
  verifySnapshotCandidateLedger(input)
  const entry = input.entries[0], validation = JSON.parse(f.load(entry.validation)), candidate = JSON.parse(f.load(entry.candidate))
  for (const patch of [{ status: 'rejected' }, { transaction: f.put('{}') },
    { completedAt: new Date(Date.parse(checkpoint.capturedAt) + 1).toISOString() }]) {
    assert.throws(() => verifySnapshotCandidateLedger({ ...input, entries: [{ ...entry, validation: f.put(JSON.stringify({ ...validation, ...patch })) }] }), /candidate is rejected/)
  }
  const foreign = f.put(JSON.stringify({ ...candidate, ownerId: 'foreign' }))
  assert.throws(() => verifySnapshotCandidateLedger({ ...input, entries: [{ candidate: foreign,
    validation: f.put(JSON.stringify({ ...validation, candidate: foreign })) }] }), /candidate is rejected/)
  assert.throws(() => verifySnapshotCandidateLedger({ ...input, entries: [] }), /ledger is incomplete/)
})

test('absence without observed source removal cannot replace the actual final read', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint(); await f.cleanupSnapshot()
  fs.rmSync(f.project, { recursive: true, force: true })
  const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
  assert.equal(summary.attestation.status, 'blocked')
  assert.match(summary.attestation.failure, /actual source cleanup is missing/)
})

test('changed source before cleanup stays blocked while original rm still succeeds', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const restore = installWxmlSourceCleanupObserver({ recorder: f.recorder })
  f.write(f.dist, 'pages/native/index.wxml', 'changed after checkpoint')
  try { assert.equal(await rm(f.project, { recursive: true, force: true }), undefined) }
  finally { await Promise.all(f.recorder.pending); restore() }
  assert.equal(fs.existsSync(f.project), false)
  assert.match(f.recorder.snapshotFailures.join('\n'), /changed before owned source cleanup/)
  assert.equal(f.recorder.sourceCleanup, undefined)
})

test('source observer leaves unrelated removal untouched and refuses disposal during its owned await', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const restore = installWxmlSourceCleanupObserver({ recorder: f.recorder })
  const unrelated = path.join(f.root, 'unrelated'); fs.mkdirSync(unrelated)
  try {
    await rm(unrelated, { recursive: true, force: true })
    assert.equal(f.recorder.pending.length, 0)
    const removing = rm(f.project, { recursive: true, force: true })
    assert.throws(restore, /still recording/)
    await removing; await Promise.all(f.recorder.pending)
  } finally { await Promise.all(f.recorder.pending); restore() }
  assert.equal(f.recorder.snapshotFailures.length, 0)
})

test('passive observer failures preserve the original asynchronous result, thrown object and invocation context', async () => {
  const context = {}, failures = [], pending = [], thrown = new Error('original removal failure'), order = []
  const options = { claim: args => { order.push('claim'); return { target: args[0] } }, before: () => { order.push('before'); throw new Error('before observer failed') },
    after: () => { order.push('after'); throw new Error('after observer failed') }, failure: error => failures.push(error), pending }
  const result = { exact: 'original result' }
  const success = createObservedOwnedRm({ ...options, original: async function (...args) { assert.equal(this, context); assert.deepEqual(args, ['owned']); order.push('rm'); return result } })
  assert.equal(await success.call(context, 'owned'), result)
  assert.deepEqual(order, ['claim', 'before', 'rm', 'after'])
  const failed = createObservedOwnedRm({ ...options, original: async () => { throw thrown } })
  await assert.rejects(failed('owned'), error => error === thrown)
  await Promise.all(pending)
  assert.equal(failures.includes(thrown), true)
  assert.equal(failures.filter(error => /after observer/.test(error.message)).length, 1)
})

test('synchronous before capture dispatches original removal before an already queued mutation microtask', async () => {
  const pending = [], failures = [], order = []
  let current = 'captured', dispatched = false
  queueMicrotask(() => { current = 'queued-mutation'; order.push('queued-mutation') })
  const observed = createObservedOwnedRm({ pending, failure: error => failures.push(error), claim: () => ({ target: 'owned' }),
    before: () => { order.push('before:' + current); return current },
    original: () => { dispatched = true; order.push('original:' + current); assert.equal(current, 'captured'); return Promise.resolve('original-result') },
    after: (_owner, captured) => { order.push('after:' + captured) },
  })
  const operation = observed('owned')
  assert.equal(dispatched, true, 'original rm must dispatch during the same synchronous call')
  assert.deepEqual(order, ['before:captured', 'original:captured'])
  assert.equal(await operation, 'original-result')
  await Promise.all(pending)
  assert.deepEqual(order, ['before:captured', 'original:captured', 'queued-mutation', 'after:captured'])
  assert.deepEqual(failures, [])
})

test('duplicate cleanup never admits a second source owner', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const restore = installWxmlSourceCleanupObserver({ recorder: f.recorder })
  try {
    await rm(f.project, { recursive: true, force: true })
    const first = f.recorder.sourceCleanup
    await rm(f.project, { recursive: true, force: true })
    assert.deepEqual(f.recorder.sourceCleanup, first)
    assert.match(f.recorder.snapshotFailures.join('\n'), /owner is duplicated/)
  } finally { await Promise.all(f.recorder.pending); restore() }
})

test('symlink replacement of the source root cannot supply actual owned source cleanup', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const restore = installWxmlSourceCleanupObserver({ recorder: f.recorder })
  const moved = f.project + '-moved'
  fs.renameSync(f.project, moved)
  fs.symlinkSync(moved, f.project, 'junction')
  try { await rm(f.project, { recursive: true, force: true }) }
  finally { await Promise.all(f.recorder.pending); restore() }
  assert.equal(fs.existsSync(moved), true)
  assert.equal(f.recorder.sourceCleanup, undefined)
  assert.match(f.recorder.snapshotFailures.join('\n'), /physical owned root|stable actual directory identity/)
})

test('a byte-identical replacement at the same source path cannot launder directory ownership', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const restore = installWxmlSourceCleanupObserver({ recorder: f.recorder })
  const moved = f.project + '-moved'
  fs.renameSync(f.project, moved)
  fs.cpSync(moved, f.project, { recursive: true, dereference: false, verbatimSymlinks: true })
  try { assert.equal(await rm(f.project, { recursive: true, force: true }), undefined) }
  finally { await Promise.all(f.recorder.pending); restore() }
  assert.equal(f.recorder.sourceCleanup, undefined)
  assert.match(f.recorder.snapshotFailures.join('\n'), /physical directory identity differs/)
  assert.equal(fs.existsSync(moved), true)
})


// Execute the candidate's actual dispose callback with the real installed rm
// observers. Compiler preflight and child processes are deliberately absent;
// spawn, signal, child-cleanup and worker-owner state are synthetic closures.
function actualComposedDispose(record, restoreSourceCleanup, restoreSnapshotCleanup) {
  const file = fs.readFileSync(new URL('./conformance-fixture-build.mjs', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('fixture-build.mjs', file, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const callbacks = []
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && node.left.getText(tree) === 'record.dispose') callbacks.push(node.right.getText(tree))
    ts.forEachChild(node, visit)
  }
  visit(tree); assert.equal(callbacks.length, 1, 'actual scoped recorder dispose boundary changed')
  const original = () => {}, originalKill = () => {}, observedSpawn = () => {}, observedKill = () => {}
  const childProcess = { spawn: observedSpawn }, process = { kill: observedKill }, ownerId = record.ownerId
  const recorderOwners = new Set([ownerId]), liveCompanions = new Map([[101, { synthetic: true }]])
  let childRestores = 0, syncs = 0
  const restoreChildKills = new Set([() => { childRestores++ }])
  const dispose = vm.runInNewContext('(' + callbacks[0] + ')', { record, childProcess, process, observedSpawn, observedKill,
    original, originalKill, restoreSourceCleanup, restoreSnapshotCleanup, restoreChildKills, liveCompanions, recorderOwners,
    ownerId, ensure: (ok, message) => { if (!ok) throw new Error(message) }, syncBuiltinESMExports: () => { syncs++ } })
  record.disposed = false; record.dispose = dispose
  return { childProcess, process, original, originalKill, observedSpawn, observedKill, recorderOwners, liveCompanions,
    childRestores: () => childRestores, syncs: () => syncs }
}

test('source restore retries after active original removal and stays idempotent after success', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint()
  const original = fs.promises.rm, result = { original: 'source-result' }; let release
  fs.promises.rm = function (target, options) {
    return new Promise(resolve => { release = () => { fs.rmSync(target, options); resolve(result) } })
  }
  const base = fs.promises.rm, restore = installWxmlSourceCleanupObserver({ recorder: f.recorder }), installed = fs.promises.rm
  try {
    const operation = fs.promises.rm(f.project, { recursive: true, force: true })
    assert.throws(restore, /still recording/)
    assert.equal(fs.promises.rm, installed)
    release(); assert.equal(await operation, result); await Promise.all(f.recorder.pending)
    assert.ok(f.recorder.sourceCleanup)
    restore(); assert.equal(fs.promises.rm, base); restore(); assert.equal(fs.promises.rm, base)
    const foreign = () => Promise.resolve('foreign')
    fs.promises.rm = foreign; restore(); assert.equal(fs.promises.rm, foreign)
  } finally { await Promise.all(f.recorder.pending); fs.promises.rm = installed; restore(); fs.promises.rm = original; syncBuiltinESMExports() }
})

test('source restore preserves a foreign replacement and remains retryable until its own hook returns', async t => {
  const f = await fixture(t), original = fs.promises.rm
  const restore = installWxmlSourceCleanupObserver({ recorder: f.recorder }), installed = fs.promises.rm
  const foreign = () => Promise.resolve('foreign')
  try {
    fs.promises.rm = foreign
    assert.throws(restore, /lost its scoped removal ownership/)
    assert.equal(fs.promises.rm, foreign)
    fs.promises.rm = installed; restore(); assert.equal(fs.promises.rm, original)
    fs.promises.rm = foreign; restore(); assert.equal(fs.promises.rm, foreign)
  } finally { fs.promises.rm = original; syncBuiltinESMExports() }
})

for (const foreignReplacement of [false, true]) {
  test('actual recorder dispose retries its complete unwind after pending snapshot removal' + (foreignReplacement ? ' and a foreign replacement' : ''), async t => {
    const f = await fixture(t); await f.capture(); await f.checkpoint()
    const originalRm = fs.promises.rm, result = { original: 'snapshot-result' }; let release
    fs.promises.rm = function (target, options) {
      return new Promise(resolve => { release = () => { fs.rmSync(target, options); resolve(result) } })
    }
    const base = fs.promises.rm, restoreSnapshot = installOwnedSnapshotCleanupObserver({ recorder: f.recorder })
    const snapshotOnly = fs.promises.rm, restoreSource = installWxmlSourceCleanupObserver({ recorder: f.recorder })
    const installed = fs.promises.rm, hooks = actualComposedDispose(f.recorder, restoreSource, restoreSnapshot)
    try {
      const operation = fs.promises.rm(f.wrapper.path, { recursive: true, force: true })
      assert.throws(f.recorder.dispose, /active or lost/)
      assert.equal(fs.promises.rm, snapshotOnly, 'source completed its unwind before the busy snapshot refused')
      assert.equal(f.recorder.disposed, false)
      assert.equal(hooks.childProcess.spawn, hooks.observedSpawn); assert.equal(hooks.process.kill, hooks.observedKill)
      assert.equal(hooks.recorderOwners.has(f.recorder.ownerId), true)
      assert.equal(hooks.liveCompanions.size, 1); assert.equal(hooks.childRestores(), 0); assert.equal(hooks.syncs(), 0)
      release(); assert.equal(await operation, result); await Promise.all(f.recorder.pending)
      assert.ok(f.recorder.snapshots[0].cleanup)
      if (foreignReplacement) {
        const foreignRm = () => Promise.resolve('foreign')
        fs.promises.rm = foreignRm
        assert.throws(f.recorder.dispose, /active or lost/)
        assert.equal(fs.promises.rm, foreignRm, 'retry must preserve the external rm hook')
        assert.equal(f.recorder.disposed, false)
        assert.equal(hooks.childProcess.spawn, hooks.observedSpawn); assert.equal(hooks.process.kill, hooks.observedKill)
        assert.equal(hooks.recorderOwners.has(f.recorder.ownerId), true); assert.equal(hooks.childRestores(), 0)
        fs.promises.rm = snapshotOnly
      }
      f.recorder.dispose()
      assert.equal(fs.promises.rm, base)
      assert.equal(hooks.childProcess.spawn, hooks.original); assert.equal(hooks.process.kill, hooks.originalKill)
      assert.equal(hooks.recorderOwners.size, 0); assert.equal(hooks.liveCompanions.size, 0)
      assert.equal(hooks.childRestores(), 1); assert.equal(hooks.syncs(), 1); assert.equal(f.recorder.disposed, true)
      const foreignRm = () => Promise.resolve('foreign'), foreignSpawn = () => {}, foreignKill = () => {}
      fs.promises.rm = foreignRm; hooks.childProcess.spawn = foreignSpawn; hooks.process.kill = foreignKill
      f.recorder.dispose(); restoreSource(); restoreSnapshot()
      assert.equal(fs.promises.rm, foreignRm); assert.equal(hooks.childProcess.spawn, foreignSpawn); assert.equal(hooks.process.kill, foreignKill)
      assert.equal(hooks.childRestores(), 1); assert.equal(hooks.syncs(), 1)
    } finally {
      await Promise.all(f.recorder.pending)
      try {
        fs.promises.rm = installed; restoreSource()
        fs.promises.rm = snapshotOnly; restoreSnapshot()
      } finally { fs.promises.rm = originalRm; syncBuiltinESMExports() }
    }
  })
}


test('reviewed r5b WXML producer identity preserves current transaction and final cleanup validation', async t => {
  const f = await completed(t), reviewed = reviewedR5bFixture(f.identity, f.put, f.load)
  const final = rebindSyntheticSnapshotProducer(f.summary.attestation.producerFinal, reviewed.sources.wxmlProducer, f.put, f.load, reviewed.sources.snapshotTransport)
  const transaction = JSON.parse(f.load(final[0].transaction))
  const base = { build: f.build, checkout: f.checkout, members: f.members, load: f.load, identity: f.identity }
  const verify = value => verifyWxmlProducerTransaction({ ...base, transaction: value, producerRevision: reviewed.token })
  assert.throws(() => verifyWxmlProducerTransaction({ ...base, transaction }), /implementation differs/)
  assert.doesNotThrow(() => verify(transaction))
  assert.throws(() => verify({ ...transaction, transport: f.put('unreviewed transport with the same profile') }), /transport differs/ )
  assert.throws(() => verifyWxmlProducerTransaction({ ...base, transaction, producerRevision: { ...reviewed.token } }), /unknown, mixed/)
  assert.throws(() => verify({ ...transaction, producer: f.put('unknown producer with same profile') }), /complete reviewed closure/)
  const generated = structuredClone(transaction.postHelperGenerated); generated[0].artifact = f.put('unreviewed generated bytes')
  assert.throws(() => verify({ ...transaction, postHelperGenerated: generated }), /post-CLI source\/generated transition/)
  const input = { ...base, final, transactionReference: final[0].transaction, checkpointAt: f.checkpoint.attestation.capturedAt,
    recordingEndedAt: f.summary.attestation.recordingEndedAt, producerRevision: reviewed.token }
  assert.doesNotThrow(() => verifyWxmlSnapshotFinal(input))
  assert.throws(() => verifyWxmlSnapshotFinal({ ...input, producerRevision: undefined }), /implementation differs/)
  const cleanup = JSON.parse(f.load(final[0].cleanup))
  assert.throws(() => verifyWxmlSnapshotFinal({ ...input, final: [{ ...final[0], cleanup: f.put(JSON.stringify({ ...cleanup, runtimeProjectPath: '/foreign-owner' })) }] }), /cleanup belongs/)
})
