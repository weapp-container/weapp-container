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
import { ISSUE1034_PRODUCER_CASE, ISSUE1034_PRODUCER_GUARDS, issue1034ProducerInvocation, verifyIssue1034ProducerTransaction,
  verifyIssue1034ProducerGuards, verifyIssue1034SnapshotFinal, verifyIssue1034SourceCleanup } from './conformance-issue1034-producer.mjs'
import { instrumentSnapshotAutomator, createObservedOwnedRm, verifySnapshotCandidateLedger } from './conformance-snapshot-transport.mjs'
import { captureOwnedSnapshot, captureOwnedSnapshotCleanup, captureOfficialFixtureCheckpoint,
  flushStaticFixtureBuildRecorder, installTemporaryProjectSourceCleanupObserver, installOwnedSnapshotCleanupObserver, verifyStaticGeneratedSupport } from './conformance-fixture-build.mjs'


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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'issue1034-producer-unit-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const checkout = path.join(root, 'checkout'), identity = ISSUE1034_PRODUCER_CASE
  const seed = path.join(checkout, 'e2e-apps/github-issues/fixtures/issue-1034')
  const write = (base, name, bytes) => { fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true }); fs.writeFileSync(path.join(base, name), bytes) }
  for (const relative of ['packages/weapp-vite', 'packages-runtime/wevu']) write(checkout, relative + '/entry.js', 'synthetic dependency\n')
  write(seed, 'project.config.json', json({ compileType: 'miniprogram', miniprogramRoot: 'dist/', srcMiniprogramRoot: 'dist/',
    libVersion: '3.17.3', setting: { packNpmManually: true, packNpmRelationList: [{}] } }))
  write(seed, 'project.private.config.json', json({ projectname: 'synthetic-issue1034', setting: { urlCheck: false },
    condition: { miniprogram: { list: [{ pathName: 'pages/native/index' }, { pathName: 'pages/vue/index' }] } } }))
  write(seed, 'src/app.ts', 'actual synthetic source must remain\n')
  write(seed, 'weapp-vite.config.ts', 'export default {}\n')
  let invocation
  const helper = vm.runInNewContext(compile(functions(source('e2e/utils/issue1034Project.ts'), ['createIssue1034Project', 'runIssue1034Command']))
    + '\n({createIssue1034Project,runIssue1034Command})', { ...fs.promises, path, process, ROOT: checkout,
    sanitizeBuildCommandEnv: () => ({ SYNTHETIC: '1' }), execa: (command, args, options) => { invocation = { command, args, options }; return Promise.resolve() } })
  const project = await helper.createIssue1034Project(), dist = path.join(project, 'dist')
  await helper.runIssue1034Command(project, 'build')
  const { args, options: { cwd } } = invocation, cliPath = args[0]
  const profile = issue1034ProducerInvocation({ ...identity, args, cliPath, cwd, checkout })
  const put = bytes => {
    bytes = Buffer.from(bytes)
    const sha256 = hash(bytes), relative = `objects/${sha256}`, file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
    return { path: relative, sha256, bytes: bytes.length }
  }
  const load = ref => { const bytes = fs.readFileSync(path.join(root, ref.path)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes); return bytes }
  const members = [], guards = ISSUE1034_PRODUCER_GUARDS.map(({ path: name }) => {
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
  write(project, '.weapp-vite/auto-routes.cache.json', json({ version: 6, synthetic: true }))
  const after = read(project)
  const raw = { 'app.json': json({ pages: ['pages/native/index', 'pages/vue/index'] }), 'app.js': 'App({});\n',
    'pages/native/index.js': 'Page({});\n', 'pages/native/index.json': '{}', 'pages/native/index.issue1034': '<view>actual synthetic native</view>',
    'pages/vue/index.js': 'Page({});\n', 'pages/vue/index.json': '{}', 'pages/vue/index.issue1034': '<view>actual synthetic vue</view>' }
  for (const [name, bytes] of Object.entries(raw)) write(dist, name, bytes)
  const build = { action: 'static-build', status: 'built', projectPath: project, outputRoot: dist, outputRelative: 'dist', producerProfile: profile,
    command: [process.execPath, ...args], cwd, pid: process.pid, observer: { pid: process.pid, threadId: 0 },
    startedAt: new Date(Date.now() - 10).toISOString(), endedAt: new Date().toISOString(), exitCode: 0, signal: null,
    outputCaptured: true, outputAbsent: true, sourceBefore: before, sourceAfter: after, generatedSupport: verifyStaticGeneratedSupport(before, after, { identity, guards, members, load }), generated: read(dist) }
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
  const verify = transaction => verifyIssue1034ProducerTransaction({ transaction, build, checkout, members, load, identity })
  const checkpoint = () => captureOfficialFixtureCheckpoint({ recorder, runtimeObservation: { projectPath: wrapper.path,
    recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64) } })
  const cleanupSource = async () => {
    const restore = installTemporaryProjectSourceCleanupObserver({ recorder })
    try { await rm(project, { recursive: true, force: true }); await Promise.all(recorder.pending); return recorder.sourceCleanup }
    finally { await Promise.all(recorder.pending); restore() }
  }
  const cleanupSnapshot = async () => {
    const restore = installOwnedSnapshotCleanupObserver({ recorder })
    try { await wrapper.cleanup(); await Promise.all(recorder.pending); return recorder.snapshots[0].cleanup }
    finally { await Promise.all(recorder.pending); restore() }
  }
  return { root, checkout, project, dist, identity, profile, args, cwd, cliPath, put, load, write, build, members, guards, recorder,
    wrapper, observation, capture, verify, checkpoint, cleanupSnapshot, cleanupSource, invocation }
}


test('exact 1034 helper, generated cache, root-dot snapshot checkpoint and original source cleanup form one distinct transaction', async t => {
  const f = await fixture(t), captured = await f.capture(), checked = f.verify(captured.attestation)
  assert.equal(f.invocation.command, process.execPath)
  assert.equal(f.invocation.options.extendEnv, false)
  assert.equal(f.cwd, f.checkout)
  assert.equal(captured.attestation.profile, 'issue1034-static-snapshot-v1')
  assert.equal(captured.attestation.kind, 'weapp-container.issue1034-producer-transaction')
  assert.deepEqual(captured.attestation.postHelperSource, f.build.sourceAfter)
  assert.deepEqual(captured.attestation.postHelperGenerated, f.build.generated)
  assert.equal(f.build.sourceAfter.filter(item => item.kind === 'consumer-link').length, 2)
  const cache = f.build.generatedSupport.find(item => item.path === '.weapp-vite/auto-routes.cache.json')
  assert.deepEqual(cache, f.build.sourceAfter.find(item => item.path === cache.path))
  assert.equal(JSON.parse(f.load(cache.artifact)).version, 6)
  const config = JSON.parse(f.load(captured.attestation.snapshotFiles.find(item => item.path === 'project.config.json').artifact))
  assert.equal(config.miniprogramRoot, './')
  const checkpoint = await f.checkpoint()
  assert.equal(checkpoint.attestation.status, 'captured')
  assert.deepEqual(checkpoint.attestation.runtimeGenerated, checked.runtimeGenerated)
  await f.cleanupSnapshot(); await f.cleanupSource()
  const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
  assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  assert.equal(summary.attestation.finalGuard, 'owned-project-cleaned-after-captured-generation')
  verifyIssue1034SourceCleanup({ final: summary.attestation.producerSourceCleanup, transaction: captured.attestation,
    transactionReference: captured.reference, ownerId: f.recorder.ownerId, checkpointAt: checkpoint.attestation.capturedAt,
    recordingEndedAt: summary.attestation.recordingEndedAt, load: f.load })
  verifyIssue1034SnapshotFinal({ final: summary.attestation.producerFinal, transactionReference: captured.reference,
    build: f.build, identity: f.identity, checkpointAt: checkpoint.attestation.capturedAt,
    recordingEndedAt: summary.attestation.recordingEndedAt, checkout: f.checkout, members: f.members, load: f.load })
})

test('1034 invocation rejects cross-case hashes, WXML names, nested roots, extra args and prepare', async t => {
  const f = await fixture(t), good = { ...f.identity, args: f.args, cliPath: f.cliPath, cwd: f.cwd, checkout: f.checkout }
  assert.ok(issue1034ProducerInvocation(good))
  for (const bad of [
    { sourceSha256: '0'.repeat(64) }, { caseId: 'ide-wxml-transform-runtime' }, { cwd: f.project },
    { args: [f.cliPath, 'prepare', f.project] }, { args: [...f.args, '--platform', 'weapp'] },
    { args: [f.cliPath, 'build', path.join(path.dirname(f.project), 'wxml-transform-Ab1234')] },
    { args: [f.cliPath, 'build', f.project + '7'] }, { args: [f.cliPath, 'build', path.join(f.project, 'issue-1034-Ab1234')] },
  ]) assert.equal(issue1034ProducerInvocation({ ...good, ...bad }), null)
})

test('1034 exact source, helper and cache-writer guards cannot be relabeled or substituted', async t => {
  const f = await fixture(t)
  verifyIssue1034ProducerGuards({ guards: f.guards, members: f.members, load: f.load })
  for (const index of [0, 1, 5, 6]) {
    const guards = structuredClone(f.guards)
    guards[index].original = f.put(f.load(guards[index].original) + '\n// changed')
    assert.throws(() => verifyIssue1034ProducerGuards({ guards, members: f.members, load: f.load }), /original source guard differs/)
  }
})

test('exact generated data cache requires complete pinned 1034 guards and its hash remains in the source closure', async t => {
  const f = await fixture(t), options = { identity: f.identity, guards: f.guards, members: f.members, load: f.load }
  assert.deepEqual(verifyStaticGeneratedSupport(f.build.sourceBefore, f.build.sourceAfter, options), f.build.generatedSupport)
  for (const bad of [{}, { identity: { ...f.identity, sourceSha256: '0'.repeat(64) } }, { ...options, guards: [] },
    { ...options, members: f.members.filter(item => !item.path.endsWith('/persistence.ts')) }]) {
    assert.throws(() => verifyStaticGeneratedSupport(f.build.sourceBefore, f.build.sourceAfter, bad))
  }
})

for (const name of ['.weapp-vite/auto-routes.cache-extra.json', '.weapp-vite/auto-routes.cache.json.js', '.weapp-vite/adjacent.json']) {
  test(`adjacent generated path remains rejected: ${name}`, async t => {
    const f = await fixture(t)
    const after = [...f.build.sourceAfter, { path: name, kind: 'file', artifact: f.put('{}') }]
    assert.throws(() => verifyStaticGeneratedSupport(f.build.sourceBefore, after,
      { identity: f.identity, guards: f.guards, members: f.members, load: f.load }), /unreviewed support file/)
  })
}

for (const value of ['globalThis.executed=true', '[]', '{"version":5}']) {
  test(`cache cannot become executable text, array or another version: ${value}`, async t => {
    const f = await fixture(t), after = structuredClone(f.build.sourceAfter)
    after.find(item => item.path === '.weapp-vite/auto-routes.cache.json').artifact = f.put(value)
    assert.throws(() => verifyStaticGeneratedSupport(f.build.sourceBefore, after,
      { identity: f.identity, guards: f.guards, members: f.members, load: f.load }))
  })
}

test('cache acceptance does not permit an original input mutation or a dependency link at the data path', async t => {
  const f = await fixture(t), options = { identity: f.identity, guards: f.guards, members: f.members, load: f.load }
  const mutated = structuredClone(f.build.sourceAfter)
  mutated.find(item => item.path === 'src/app.ts').artifact = f.put('changed source')
  assert.throws(() => verifyStaticGeneratedSupport(f.build.sourceBefore, mutated, options), /mutated its original source/)
  const linked = structuredClone(f.build.sourceAfter)
  Object.assign(linked.find(item => item.path === '.weapp-vite/auto-routes.cache.json'), { kind: 'consumer-link', target: 'packages/weapp-vite' })
  assert.throws(() => verifyStaticGeneratedSupport(f.build.sourceBefore, linked, options), /unreviewed support file/)
})

test('1034 cannot borrow a WXML transaction kind or duplicate/substitute either source dependency link', async t => {
  const f = await fixture(t), captured = await f.capture()
  assert.throws(() => f.verify({ ...captured.attestation, kind: 'weapp-container.wxml-producer-transaction' }), /transaction profile differs/)
  for (const target of ['packages-runtime/other', 'packages/weapp-vite']) {
    const build = structuredClone(f.build), transaction = structuredClone(captured.attestation)
    build.sourceAfter.find(item => item.path === 'node_modules/wevu').target = target
    transaction.postHelperSource = build.sourceAfter
    assert.throws(() => verifyIssue1034ProducerTransaction({ transaction, build, checkout: f.checkout, members: f.members, load: f.load, identity: f.identity }), /dependency links differ/)
  }
})

test('unprofiled root-dot project stays blocked by the direct static root boundary', async t => {
  const f = await fixture(t)
  f.recorder.caseId = 'ide-unreviewed-case'
  assert.equal(await f.capture(), null)
  await assert.rejects(f.checkpoint(), /separate generated miniprogramRoot/)
})

test('successful snapshot cleanup cannot replace the original awaited 1034 source removal', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint(); await f.cleanupSnapshot()
  const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
  assert.equal(summary.attestation.status, 'blocked')
  assert.match(summary.attestation.failure, /source cleanup is missing or incomplete/)
})

test('1034 source cleanup preserves original result and dispatches before the next microtask', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint(); await f.cleanupSnapshot()
  const original = fs.promises.rm, events = [], result = { original: 'result' }; let release
  fs.promises.rm = function (target, options) {
    events.push('original-dispatch')
    assert.equal(fs.lstatSync(target).ino.toString(), f.build.sourceRootIdentity.inode)
    return new Promise(resolve => { release = () => { fs.rmSync(target, options); resolve(result) } })
  }
  const restore = installTemporaryProjectSourceCleanupObserver({ recorder: f.recorder })
  try {
    queueMicrotask(() => events.push('microtask'))
    const removal = rm(f.project, { recursive: true, force: true })
    assert.deepEqual(events, ['original-dispatch'])
    release(); assert.equal(await removal, result)
    await Promise.all(f.recorder.pending); restore(); restore()
    assert.ok(f.recorder.sourceCleanup)
  } finally { await Promise.all(f.recorder.pending); restore(); fs.promises.rm = original; syncBuiltinESMExports() }
})

test('rejected original source rm retains its exact error and cannot create 1034 cleanup evidence', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint(); await f.cleanupSnapshot()
  const original = fs.promises.rm, failure = Object.assign(new Error('original rm rejected'), { code: 'EACCES' })
  fs.promises.rm = () => Promise.reject(failure)
  const restore = installTemporaryProjectSourceCleanupObserver({ recorder: f.recorder })
  try {
    await assert.rejects(rm(f.project, { recursive: true, force: true }), error => error === failure)
    await Promise.all(f.recorder.pending)
    assert.equal(f.recorder.sourceCleanup, undefined)
    assert.equal(fs.existsSync(f.project), true)
  } finally { restore(); fs.promises.rm = original; syncBuiltinESMExports() }
})

test('byte-identical 1034 source directory replacement cannot inherit original cleanup ownership', async t => {
  const f = await fixture(t); await f.capture(); await f.checkpoint(); await f.cleanupSnapshot()
  const restore = installTemporaryProjectSourceCleanupObserver({ recorder: f.recorder }), moved = f.project + '-moved'
  fs.renameSync(f.project, moved); fs.cpSync(moved, f.project, { recursive: true, dereference: false, verbatimSymlinks: true })
  try { await rm(f.project, { recursive: true, force: true }); await Promise.all(f.recorder.pending) }
  finally { restore() }
  assert.equal(f.recorder.sourceCleanup, undefined)
  assert.match(f.recorder.snapshotFailures.join('\n'), /physical directory identity differs/)
  assert.equal(fs.existsSync(moved), true)
})

test('cache/source changes after CLI cannot be laundered by the bridge snapshot', async t => {
  const f = await fixture(t)
  f.write(f.project, '.weapp-vite/auto-routes.cache.json', json({ version: 6, changed: true }))
  await assert.rejects(f.capture(), /post-CLI source\/generated transition is not identity/)
  assert.equal(f.recorder.snapshots.length, 0)
  const index = JSON.parse(fs.readFileSync(path.join(f.recorder.directory, 'snapshot-producer-candidates.json')))
  assert.equal(index.candidates.length, 1)
})

test('unchanged original 1034 source retains awaited miniProgram close before exact awaited temporary-source rm', () => {
  const original = source(ISSUE1034_PRODUCER_CASE.caseSourcePath)
  assert.equal(hash(original), ISSUE1034_PRODUCER_CASE.sourceSha256)
  const tree = ts.createSourceFile('original.ts', original, ts.ScriptTarget.Latest, true)
  let after
  const visit = item => {
    if (ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.getText(tree) === 'afterAll') after = item
    ts.forEachChild(item, visit)
  }
  visit(tree); assert.ok(after)
  assert.match(after.getText(tree), /await miniProgram\?\.close\(\)/)
  assert.match(after.getText(tree), /await rm\(project, \{ recursive: true, force: true \}\)/)
  assert.ok(after.getText(tree).indexOf('await miniProgram') < after.getText(tree).indexOf('await rm'))
})
