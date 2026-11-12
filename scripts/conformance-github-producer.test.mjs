/** Synthetic file transactions only. No compiler CLI, SDK, UI or watcher.
 * The positive oracle executes extracted pinned upstream helper functions. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { GITHUB_PRODUCER_CASES, GITHUB_PRODUCER_GUARDS, githubProducerInvocation, githubPostHelperBytes,
  githubSnapshotConfigBytes, instrumentGithubAutomator, instrumentGithubSharedRuntime,
  verifyGithubProducerGuards, verifyGithubProducerTransaction, verifyGithubSnapshotFinal, verifyGithubSourceFinal } from './conformance-github-producer.mjs'
import { captureOwnedGithubSnapshot, captureOwnedGithubSnapshotCleanup, captureOfficialFixtureCheckpoint,
  flushStaticFixtureBuildRecorder, installOwnedSnapshotCleanupObserver } from './conformance-fixture-build.mjs'

import { reviewedR5bFixture, rebindSyntheticSnapshotProducer } from './fixtures/conformance-reviewed-producers.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const vendor = path.join(repository, 'vendor/weapp-vite')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const json = value => JSON.stringify(value, null, 2) + '\n'
const source = name => fs.readFileSync(path.join(vendor, name), 'utf8')
const caseProfile = caseId => {
  const matches = GITHUB_PRODUCER_CASES.filter(identity => identity.caseId === caseId)
  assert.equal(matches.length, 1, 'synthetic fixture requires one exact pinned case identity')
  return matches[0]
}

function functions(text, names) {
  const tree = ts.createSourceFile('pinned.ts', text, ts.ScriptTarget.Latest, true)
  const selected = tree.statements.filter(item => ts.isFunctionDeclaration(item) && names.includes(item.name?.text))
  assert.equal(selected.length, names.length, 'pinned oracle function boundary changed')
  return selected.map(item => item.getText(tree).replace(/^export\s+/, '')).join('\n')
}
function compile(text) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText.replace(/export \{\};?\s*$/, '')
}
async function upstreamHelper(project, dist) {
  const names = ['isRecord', 'normalizeRoutePath', 'resolveAppConfigRoutes', 'resolveAppConfigRoutePaths', 'assertAppConfigPreloadRules',
    'normalizeDistAppConfigPackageAliases', 'normalizeDistConfigCustomTabBar', 'normalizeDistAppShellConfigCustomTabBar',
    'syncProjectPrivateConfigConditions', 'assertGithubIssuesAppConfigReady', 'pruneGithubIssuesBuildInputs']
  const body = functions(source('e2e/ide/github-issues.runtime.shared.ts'), names)
  const fsFunctions = functions(source('@weapp-core/shared/src/fs/index.ts'), ['normalizeJsonEncoding', 'normalizeJsonText', 'serializeJson', 'pathExists', 'remove', 'readJson', 'readJSON', 'writeJson', 'writeJSON'])
  const pinnedFs = vm.runInNewContext(compile(fsFunctions) + '\n({pathExists, remove, readJSON, writeJSON})', { nodeFs: fs.promises })
  const run = vm.runInNewContext(compile(body) + '\n(async()=>{await assertGithubIssuesAppConfigReady();await pruneGithubIssuesBuildInputs()})', {
    fs: pinnedFs, path, APP_ROOT: project, DIST_ROOT: dist, LEADING_SLASH_RE: /^\/+/, DEVTOOLS_UNUSED_BUILD_ENTRIES: ['.weapp-vite', 'node_modules', 'src'],
  })
  await run()
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

async function fixture(t, caseId = 'ide-github-issues-runtime-issue1012', { packages = false, privateConfig, appConfig, subpackage, extraGenerated = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'github-producer-unit-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const checkout = path.join(root, 'checkout'), identity = caseProfile(caseId)
  const target = identity.caseSourcePath.slice(4).replace(/[^\w.-]+/g, '-')
  const project = path.join(checkout, '.tmp/e2e-projects/github-issues', target)
  const cliPath = path.join(checkout, 'packages/weapp-vite/bin/weapp-vite.js')
  const args = [cliPath, 'build', project, '--platform', 'weapp']
  const profile = githubProducerInvocation({ ...identity, args, cliPath, cwd: project, checkout })
  const outputRelative = path.relative(project, profile.generatedRoot).split(path.sep).join('/')
  const dist = profile.generatedRoot
  const put = bytes => {
    bytes = Buffer.from(bytes)
    const sha256 = hash(bytes), relative = `objects/${sha256}`, file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
    return { path: relative, sha256, bytes: bytes.length }
  }
  const load = ref => { const bytes = fs.readFileSync(path.join(root, ref.path)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes); return bytes }
  const write = (base, name, bytes) => { fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true }); fs.writeFileSync(path.join(base, name), bytes) }
  const rawSource = {
    'package.json': json({ name: 'synthetic-input-only', dependencies: { 'actual-build-dependency': '1' } }),
    'project.config.json': json({ appid: 'SYNTHETIC', compileType: 'miniprogram', miniprogramRoot: `${outputRelative}/`, srcMiniprogramRoot: `${outputRelative}/`, libVersion: '3.17.3',
      setting: { es6: false, packNpmManually: true, packNpmRelationList: [{ packageJsonPath: './package.json', miniprogramNpmDistDir: `./${outputRelative}` }] } }),
    'project.private.config.json': json({ libVersion: '3.17.3', miniprogramRoot: `${outputRelative}/`, qcloudRoot: 'ignored-by-snapshot',
      setting: { compileHotReLoad: true, urlCheck: false }, condition: { miniprogram: { current: 8, list: [{ pathName: 'stale' }, { pathName: 'pages/index', name: 'kept exact' }] } } }),
    'src/app.ts': 'source must be pruned\n', '.weapp-vite/typed-router.d.ts': 'generated support must be pruned\n',
    'node_modules/unit-dependency.txt': 'pruned dependency tree\n', 'config/retained.json': '{"untouched":true}',
  }
  const rawGenerated = {
    'app.json': json({ pages: ['pages/index'], subPackages: packages ? [{ root: 'pkg', pages: ['detail'] }] : [],
      usingComponents: { 'custom-tab-bar': '/custom-tab-bar/index', other: '/components/other' }, tabBar: { custom: true, list: [] } }),
    '__weapp_vite_app_shell.json': json({ usingComponents: { 'custom-tab-bar': '/custom-tab-bar/index' }, tabBar: { custom: true } }),
    'app.js': 'App({});\n', 'pages/index.js': 'Page({});\n', 'pages/index.json': '{}', 'pages/index.wxml': '<view>actual synthetic bytes</view>',
  }
  if (privateConfig) rawSource['project.private.config.json'] = json(privateConfig)
  if (appConfig) rawGenerated['app.json'] = json(appConfig)
  if (subpackage) {
    const page = subpackage === 'item' ? 'login-required/index' : 'register/form'
    rawGenerated['app.json'] = json({ pages: ['pages/index'], subPackages: [{ root: 'subpackages/' + subpackage, pages: ['index', page] }] })
    rawGenerated[`subpackages/${subpackage}/weapp-shared/common.js`] = '// actual synthetic shared chunk\n'
    rawGenerated[`subpackages/${subpackage}/${page}.js`] = `Page({data:{marker:'${subpackage === 'item' ? 'item-login-required' : 'user-register-form'}:issue-340:shared'}});`
  }
  Object.assign(rawGenerated, extraGenerated)
  for (const [name, bytes] of Object.entries(rawSource)) write(project, name, bytes)
  for (const [name, bytes] of Object.entries(rawGenerated)) write(dist, name, bytes)
  const refs = values => Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ path: name, kind: 'file', artifact: put(bytes) }))
  const build = { action: 'static-build', status: 'built', projectPath: project, outputRoot: dist, outputRelative, producerProfile: profile,
    command: [process.execPath, ...args], cwd: project, pid: process.pid, observer: { pid: process.pid, threadId: 0 },
    startedAt: new Date(Date.now() - 10).toISOString(), endedAt: new Date().toISOString(), exitCode: 0, signal: null,
    outputCaptured: true, outputAbsent: true, sourceBefore: refs(rawSource), sourceAfter: refs(rawSource), generatedSupport: [], generated: refs(rawGenerated) }
  build.projectConfig = build.sourceBefore.find(item => item.path === 'project.config.json').artifact
  const members = [], guards = GITHUB_PRODUCER_GUARDS.map(({ path: name }) => {
    const original = source(name), observed = name.endsWith('/automator.ts') ? instrumentGithubAutomator(original)
      : name.endsWith('/github-issues.runtime.shared.ts') ? instrumentGithubSharedRuntime(original, identity) : original
    const artifact = put(observed)
    members.push({ path: name, kind: 'file', origin: /\/(?:automator|github-issues\.runtime\.shared)\.ts$/.test(name) ? 'patch' : 'source', sha256: artifact.sha256, bytes: artifact.bytes })
    return { path: name, original: put(original), observed: artifact }
  })
  const guard = put(JSON.stringify({ members }))
  await upstreamHelper(project, dist)
  const directoryStat = fs.lstatSync(project, { bigint: true })
  build.sourceRootIdentity = { device: directoryStat.dev.toString(), inode: directoryStat.ino.toString(), birthtimeNs: directoryStat.birthtimeNs.toString() }
  const wrapper = upstreamSnapshot(project, dist, checkout)
  const recorder = { root, directory: path.join(root, 'recorder'), put, ...identity, observer: build.observer, ownerId: 'synthetic-owner',
    staticProfileInputs: ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs'].map(name => ({ path: 'scripts/' + name, artifact: put(fs.readFileSync(new URL('./' + name, import.meta.url))) })),
    config: { checkout, runId: 'synthetic-run', membersReference: guard }, compilerBuild: put('{}'),
    builds: [build], pending: [], snapshots: [], snapshotFailures: [], producerGuards: guards }
  fs.mkdirSync(recorder.directory)
  const observation = { sourceProjectPath: project, generatedRoot: dist, projectPath: wrapper.path, runtimeRoot: wrapper.runtimeRoot, cliPath: '/synthetic/selected/cli' }
  const capture = () => captureOwnedGithubSnapshot({ recorder, observation })
  const verify = transaction => verifyGithubProducerTransaction({ transaction, build, checkout, members, load, identity })
  return { root, checkout, project, dist, identity, profile, cliPath, args, put, load, write, build, members, guards, recorder, wrapper, observation, capture, verify }
}

test('both exact case profiles verify actual pinned normalize/prune and Automator snapshot copy bytes', async t => {
  for (const caseId of ['ide-github-issues-runtime-issue1012', 'ide-github-issues-runtime-issue1014']) {
    const f = await fixture(t, caseId), captured = await f.capture(), result = f.verify(captured.attestation)
    assert.equal(result.profile.caseId, f.identity.caseId)
    assert.equal(captured.attestation.postHelperSource.some(item => /^(?:src|node_modules|\.weapp-vite)(?:\/|$)/.test(item.path)), false)
    assert.equal(result.runtimeGenerated.some(item => item.path.startsWith('project.')), false)
    const app = JSON.parse(f.load(result.runtimeGenerated.find(item => item.path === 'app.json').artifact))
    assert.deepEqual(app.subpackages, [])
    assert.equal(app.usingComponents['custom-tab-bar'], undefined)
    const config = JSON.parse(f.load(captured.attestation.snapshotFiles.find(item => item.path === 'project.config.json').artifact))
    assert.equal(config.miniprogramRoot, './')
    assert.equal(config.srcMiniprogramRoot, './')
    assert.equal(config.setting.packNpmManually, false)
    assert.deepEqual(config.setting.packNpmRelationList, [])
  }
})

test('package aliases and private launch-condition bytes follow pinned helper order even for duplicate package aliases', async t => {
  const f = await fixture(t, 'ide-github-issues-runtime-issue1012', { packages: true }), captured = await f.capture()
  assert.ok(f.verify(captured.attestation))
  const privateFile = captured.attestation.postHelperSource.find(item => item.path === 'project.private.config.json')
  const list = JSON.parse(f.load(privateFile.artifact)).condition.miniprogram.list
  assert.equal(list.filter(item => item.pathName === 'pkg/detail').length, 2, 'preserve the original helper alias iteration exactly')
})

test('actual shared fs oracle preserves retained private-route metadata and writes no helper LF while snapshot configs retain LF', async t => {
  const privateConfig = JSON.parse(source('e2e-apps/github-issues/project.private.config.json'))
  privateConfig.libVersion = '3.17.3'
  const appConfig = { pages: ['pages/block-slot/index', 'pages/issue-1012/index'], subPackages: [] }
  const f = await fixture(t, 'ide-github-issues-runtime-issue1012', { privateConfig, appConfig }), captured = await f.capture()
  f.verify(captured.attestation)
  const file = captured.attestation.postHelperSource.find(item => item.path === 'project.private.config.json'), bytes = f.load(file.artifact)
  const actual = JSON.parse(bytes), routes = new Set(appConfig.pages)
  assert.equal(bytes.at(-1), '}'.charCodeAt(0), 'pinned shared writeJSON does not append an LF')
  assert.deepEqual(actual.condition.miniprogram.list, privateConfig.condition.miniprogram.list.filter(item => routes.has(item.pathName)))
  assert.equal(actual.setting.compileHotReLoad, false)
  assert.equal(f.load(captured.attestation.postHelperGenerated.find(item => item.path === 'app.json').artifact).at(-1), '}'.charCodeAt(0))
  for (const name of ['project.config.json', 'project.private.config.json']) {
    assert.equal(f.load(captured.attestation.snapshotFiles.find(item => item.path === name).artifact).at(-1), '\n'.charCodeAt(0))
  }
})

test('failed GitHub semantic validation archives full actual source/generated/snapshot before marking the candidate rejected', async t => {
  const f = await fixture(t)
  f.write(f.project, 'project.private.config.json', '{"actualRejected":true}')
  let failure
  await assert.rejects(f.capture(), error => { failure = error; return /post-helper source\/prune bytes differ/.test(error.message) })
  const candidate = JSON.parse(f.load(failure.snapshotCandidate)), validation = JSON.parse(f.load(failure.snapshotValidation))
  assert.equal(candidate.complete, true)
  assert.equal(candidate.caseId, f.identity.caseId)
  assert.equal(candidate.observation.sourceProjectPath, f.project)
  assert.deepEqual(JSON.parse(f.load(candidate.build)).sourceAfter, f.build.sourceAfter)
  const transaction = JSON.parse(f.load(candidate.transaction))
  assert.equal(f.load(transaction.postHelperSource.find(item => item.path === 'project.private.config.json').artifact).toString(), '{"actualRejected":true}')
  assert.ok(transaction.postHelperGenerated.length)
  assert.ok(transaction.snapshotFiles.length)
  assert.equal(validation.status, 'rejected')
  assert.deepEqual(validation.transaction, candidate.transaction)
  assert.deepEqual(f.recorder.snapshots, [])
  assert.match(f.recorder.snapshotFailures.join('\n'), /post-helper source\/prune bytes differ/)
})

test('profile rejects other cases, source hashes, roots, platforms, cwd and every skipNpm shape', async t => {
  const f = await fixture(t), base = { ...f.identity, args: f.args, cliPath: f.cliPath, cwd: f.project, checkout: f.checkout }
  for (const patch of [{ caseId: 'aggregate' }, { sourceSha256: '0'.repeat(64) }, { caseSourcePath: 'e2e/ide/other.test.ts' },
    { cwd: f.checkout }, { args: [...f.args, '--skipNpm'] }, { args: [...f.args.slice(0, 4), 'alipay'] }, { args: [f.cliPath, 'build', '/foreign', '--platform', 'weapp'] }]) {
    assert.equal(githubProducerInvocation({ ...base, ...patch }), null)
  }
})

test('missing, added, renamed, pruned incorrectly or arbitrary normalized bytes fail the complete transaction', async t => {
  const f = await fixture(t), { attestation: original } = await f.capture()
  const variants = [
    value => value.snapshotFiles.pop(),
    value => value.snapshotFiles.push({ path: 'extra.js', kind: 'file', artifact: f.put('extra') }),
    value => { value.postHelperGenerated.find(item => item.path === 'app.json').artifact = f.put('{"pages":["foreign"]}') },
    value => { value.postHelperSource.find(item => item.path === 'project.private.config.json').artifact = f.put('{}') },
    value => { value.snapshotFiles.find(item => item.path === 'project.config.json').artifact = f.put('{}') },
    value => value.postHelperSource.push(f.build.sourceAfter.find(item => item.path === 'src/app.ts')),
    value => { value.postHelperSource.find(item => item.path === 'config/retained.json').path = 'config/renamed.json' },
    value => { value.snapshotFiles[0].kind = 'consumer-link' },
    value => value.snapshotFiles.push(value.snapshotFiles[0]),
  ]
  for (const change of variants) { const value = structuredClone(original); change(value); assert.throws(() => f.verify(value), /GitHub/) }
})

test('source guards require original pinned helper bytes and exact sealed observer transforms', async t => {
  const f = await fixture(t)
  verifyGithubProducerGuards({ guards: f.guards, members: f.members, load: f.load, identity: f.identity })
  for (const field of ['original', 'observed']) {
    const guards = structuredClone(f.guards); guards[0][field] = f.put('unreviewed helper')
    assert.throws(() => verifyGithubProducerGuards({ guards, members: f.members, load: f.load, identity: f.identity }), /source guard|exact reviewed transform/)
  }
  const members = structuredClone(f.members); members[1].origin = 'source'
  assert.throws(() => verifyGithubProducerGuards({ guards: f.guards, members, load: f.load, identity: f.identity }), /exact reviewed transform/)
})

test('unready app preload rules cannot acquire a normalized transaction', async t => {
  const f = await fixture(t)
  for (const preloadRule of ['bad', { foreign: { packages: [] } }, { 'pages/index': { packages: ['foreign'] } }]) {
    const build = structuredClone(f.build), item = build.generated.find(item => item.path === 'app.json')
    item.artifact = f.put(json({ ...JSON.parse(f.load(item.artifact)), preloadRule }))
    assert.throws(() => githubPostHelperBytes({ build, load: f.load }), /GitHub preloadRule/)
  }
})

test('owned snapshot metadata, producer module, root relationships and capture interval fail closed', async t => {
  const f = await fixture(t), { attestation: original } = await f.capture()
  for (const patch of [{ sourceRoot: f.checkout }, { generatedRoot: f.project }, { runtimeRoot: f.dist },
    { runtimeProjectPath: path.join(f.checkout, '.tmp/e2e-ide-bridge-projects/foreign') },
    { capturedAt: new Date(Date.parse(f.build.endedAt) - 1).toISOString() }, { observer: { pid: 1, threadId: 0 } }, { producer: f.put('substituted producer') }]) {
    assert.throws(() => f.verify({ ...structuredClone(original), ...patch }), /GitHub/)
  }
  assert.throws(() => verifyGithubProducerTransaction({ transaction: original, build: f.build, checkout: f.checkout, members: f.members, load: f.load, identity: caseProfile('ide-github-issues-runtime-issue1014') }), /another consumer case/)
  const sourceFiles = structuredClone(original.postHelperSource), config = sourceFiles.find(item => item.path === 'project.config.json')
  config.artifact = f.put(json({ ...JSON.parse(f.load(config.artifact)), pluginRoot: 'plugin' }))
  assert.throws(() => githubSnapshotConfigBytes({ sourceFiles, load: f.load }), /plugin or foreign/)
})

test('actual SDK checkpoint binds captured snapshot bytes; missing bytes and post-capture mutations stay rejected', async t => {
  const f = await fixture(t)
  const runtime = () => ({ projectPath: f.wrapper.path, recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64) })
  await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: runtime() }), /separate generated miniprogramRoot/)
  const captured = await f.capture(), checkpoint = await captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: runtime() })
  assert.deepEqual(checkpoint.attestation.producerTransaction, captured.reference)
  assert.deepEqual(checkpoint.attestation.runtimeGenerated, f.verify(captured.attestation).runtimeGenerated)
  fs.appendFileSync(path.join(f.wrapper.path, 'app.js'), '\nchanged after capture')
  await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: runtime() }), /generation changed/)
})

test('capture failures remain sticky and cannot be repaired by later synthetic snapshot metadata', async t => {
  const f = await fixture(t)
  await assert.rejects(captureOwnedGithubSnapshot({ recorder: f.recorder, observation: { ...f.observation, generatedRoot: '/foreign' } }), /no unique/)
  await f.capture()
  await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder,
    runtimeObservation: { projectPath: f.wrapper.path, recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64) } }), /snapshot observation failed/)
})

test('cleanup observation requires actual absence and offline final reader binds owner, SDK project and time', async t => {
  const f = await fixture(t), captured = await f.capture()
  const checkpoint = await captureOfficialFixtureCheckpoint({ recorder: f.recorder,
    runtimeObservation: { projectPath: f.wrapper.path, recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64) } })
  const restore = installOwnedSnapshotCleanupObserver({ recorder: f.recorder })
  let cleanupRef
  try { await f.wrapper.cleanup(); await Promise.all(f.recorder.pending); cleanupRef = f.recorder.snapshots[0].cleanup }
  finally { await Promise.all(f.recorder.pending); restore() }
  const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
  assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  const input = { final: summary.attestation.producerFinal, transactionReference: captured.reference, build: f.build,
    checkpointAt: checkpoint.attestation.capturedAt, recordingEndedAt: summary.attestation.recordingEndedAt,
    checkout: f.checkout, members: f.members, load: f.load, identity: f.identity }
  verifyGithubSnapshotFinal(input)
  const finalInput = { final: summary.attestation.producerSourceFinal, transaction: captured.attestation,
    checkpointAt: checkpoint.attestation.capturedAt, recordingEndedAt: summary.attestation.recordingEndedAt, load: f.load }
  verifyGithubSourceFinal(finalInput)
  for (const patch of [{ sourceRoot: '/foreign' }, { generatedRoot: '/foreign' },
    { capturedAt: new Date(Date.parse(checkpoint.attestation.capturedAt) - 1).toISOString() }, { generatedFiles: [] }]) {
    assert.throws(() => verifyGithubSourceFinal({ ...finalInput, final: { ...structuredClone(finalInput.final), ...patch } }), /GitHub/)
  }
  for (const patch of [{ projectAbsent: false }, { observer: { pid: 1, threadId: 0 } }, { runtimeProjectPath: '/foreign' },
    { removedAt: new Date(Date.parse(checkpoint.attestation.capturedAt) - 1).toISOString() },
    { removedAt: new Date(Date.parse(summary.attestation.recordingEndedAt) + 1).toISOString() }]) {
    const cleanup = { ...JSON.parse(f.load(cleanupRef)), ...patch }
    assert.throws(() => verifyGithubSnapshotFinal({ ...input, final: [{ transaction: captured.reference, cleanup: f.put(JSON.stringify(cleanup)) }] }), /cleanup belongs/)
  }
  assert.throws(() => verifyGithubSnapshotFinal({ ...input, final: [] }), /proof is missing/)
  assert.throws(() => verifyGithubSnapshotFinal({ ...input, transactionReference: f.put('{}') }), /omits the actual SDK/)
})

test('live cleanup rejects an existing snapshot or duplicate removal observation', async t => {
  const f = await fixture(t); await f.capture()
  await assert.rejects(captureOwnedGithubSnapshotCleanup({ recorder: f.recorder, observation: { projectPath: f.wrapper.path, phase: 'after-remove' } }), /not complete/)
  const restore = installOwnedSnapshotCleanupObserver({ recorder: f.recorder })
  try { await f.wrapper.cleanup(); await Promise.all(f.recorder.pending) }
  finally { await Promise.all(f.recorder.pending); restore() }
  await assert.rejects(captureOwnedGithubSnapshotCleanup({ recorder: f.recorder, observation: { projectPath: f.wrapper.path, phase: 'after-remove' } }), /duplicated/)
})

test('fixed observer captures before the caller snapshot hook and reports cleanup only after awaited owned removal', async () => {
  const pinned = source('e2e/utils/automator.ts'), instrumented = instrumentGithubAutomator(pinned)
  const hook = instrumented.match(/            if \(bridgeWrapperProject\?\.stopSync\) \{\n([\s\S]*?)\n            \}/)?.[1]
  assert.ok(hook)
  const calls = [], wrapper = { stopSync() {}, path: '/owned/snapshot', runtimeRoot: '/owned/snapshot', distRoot: '/source/dist' }
  let release
  const paused = new Promise(resolve => { release = resolve })
  const run = vm.runInNewContext(compile(`async function run(){${hook}}`) + '\nrun', {
    bridgeWrapperProject: wrapper, rest: { projectPath: '/source', cliPath: '/selected/cli' },
    recordConformanceSnapshot: async value => { calls.push(['capture', value]); await paused },
    onOwnedSnapshot: async value => { calls.push(['caller', value]) },
  })
  const pending = run()
  assert.equal(calls.length, 1)
  release(); await pending
  assert.deepEqual(calls.map(([name]) => name), ['capture', 'caller'])
  assert.equal(calls[0][1].sourceProjectPath, '/source')
  assert.equal(calls[0][1].generatedRoot, '/source/dist')
  assert.equal(calls[0][1].runtimeRoot, '/owned/snapshot')
  assert.equal(instrumented.includes('    await fs.promises.rm(wrapperRoot, { recursive: true, force: true })'), true)
  assert.equal(instrumented.includes("await recordConformanceSnapshotCleanup({ projectPath: wrapperRoot"), false)
  assert.throws(() => instrumentGithubAutomator(pinned.replace('              await onOwnedSnapshot?.({ projectPath: bridgeWrapperProject.path, cliPath: rest.cliPath! })', 'changed hook')), /anchor is missing or ambiguous/)
})

test('a runtime copy mutated after the SDK checkpoint cannot be removed as an unchanged captured generation', async t => {
  const f = await fixture(t); await f.capture()
  await captureOfficialFixtureCheckpoint({ recorder: f.recorder,
    runtimeObservation: { projectPath: f.wrapper.path, recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64) } })
  fs.appendFileSync(path.join(f.wrapper.path, 'pages/index.js'), '\nactual late mutation')
  await assert.rejects(captureOwnedGithubSnapshotCleanup({ recorder: f.recorder,
    observation: { projectPath: f.wrapper.path, phase: 'before-remove' } }), /changed before owned cleanup/)
  await f.wrapper.cleanup()
  await assert.rejects(captureOwnedGithubSnapshotCleanup({ recorder: f.recorder,
    observation: { projectPath: f.wrapper.path, phase: 'after-remove' } }), /not complete/)
})

test('snapshot config accepts equivalent reviewed relative roots and rejects absolute, escaping and plugin roots on every host', async t => {
  const f = await fixture(t), { attestation } = await f.capture()
  const patchConfig = (root, extra = {}, privatePatch = {}) => {
    const files = structuredClone(attestation.postHelperSource), config = files.find(item => item.path === 'project.config.json')
    const privateConfig = files.find(item => item.path === 'project.private.config.json')
    config.artifact = f.put(json({ ...JSON.parse(f.load(config.artifact)), miniprogramRoot: root, ...extra }))
    privateConfig.artifact = f.put(json({ ...JSON.parse(f.load(privateConfig.artifact)), ...privatePatch }))
    return { sourceFiles: files, load: f.load }
  }
  for (const root of ['dist', 'dist/', './dist', './dist/', '././dist//']) {
    const values = githubSnapshotConfigBytes(patchConfig(root))
    assert.equal(JSON.parse(values.get('project.config.json')).miniprogramRoot, './')
  }
  const isolatedValues = githubSnapshotConfigBytes({ ...patchConfig('dist-issue-826/'), outputRelative: 'dist-issue-826' })
  assert.equal(JSON.parse(isolatedValues.get('project.config.json')).miniprogramRoot, './')
  for (const root of ['/', '/dist', '/project/dist', '../dist', 'other/../dist', 'dist/../dist', 'other', '.', '',
    'C:\\project\\dist', 'C:/project/dist', '\\\\server\\share\\dist', 'dist\\', null]) {
    assert.throws(() => githubSnapshotConfigBytes(patchConfig(root)), /plugin or foreign/)
  }
  assert.throws(() => githubSnapshotConfigBytes(patchConfig('dist', { pluginRoot: 'plugin' })), /plugin or foreign/)
  assert.throws(() => githubSnapshotConfigBytes(patchConfig('dist', {}, { pluginRoot: 'plugin' })), /plugin or foreign/)
})


test('reviewed r5b snapshot identity still runs current strict transaction and final semantics', async t => {
  const f = await fixture(t), captured = await f.capture()
  const checkpoint = await captureOfficialFixtureCheckpoint({ recorder: f.recorder,
    runtimeObservation: { projectPath: f.wrapper.path, recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64) } })
  const restore = installOwnedSnapshotCleanupObserver({ recorder: f.recorder })
  try { await f.wrapper.cleanup(); await Promise.all(f.recorder.pending) }
  finally { await Promise.all(f.recorder.pending); restore() }
  const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
  assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  const reviewed = reviewedR5bFixture(f.identity, f.put, f.load)
  const final = rebindSyntheticSnapshotProducer(summary.attestation.producerFinal, reviewed.sources.githubProducer, f.put, f.load, reviewed.sources.snapshotTransport)
  const transaction = JSON.parse(f.load(final[0].transaction))
  const base = { build: f.build, checkout: f.checkout, members: f.members, load: f.load, identity: f.identity }
  const verify = value => verifyGithubProducerTransaction({ ...base, transaction: value, producerRevision: reviewed.token })
  assert.throws(() => verifyGithubProducerTransaction({ ...base, transaction }), /implementation differs/)
  assert.doesNotThrow(() => verify(transaction))
  assert.throws(() => verify({ ...transaction, transport: f.put('unreviewed transport with the same profile') }), /transport differs/ )
  assert.throws(() => verifyGithubProducerTransaction({ ...base, transaction, producerRevision: { ...reviewed.token } }), /unknown, mixed/)
  assert.throws(() => verify({ ...transaction, producer: f.put('unknown producer with same profile') }), /complete reviewed closure/)
  const generated = structuredClone(transaction.postHelperGenerated); generated[0].artifact = f.put('unreviewed generated bytes')
  assert.throws(() => verify({ ...transaction, postHelperGenerated: generated }), /post-helper generated bytes differ/)
  const input = { ...base, final, transactionReference: final[0].transaction, checkpointAt: checkpoint.attestation.capturedAt,
    recordingEndedAt: summary.attestation.recordingEndedAt, producerRevision: reviewed.token }
  assert.doesNotThrow(() => verifyGithubSnapshotFinal(input))
  assert.throws(() => verifyGithubSnapshotFinal({ ...input, producerRevision: undefined }), /implementation differs/)
  const cleanup = JSON.parse(f.load(final[0].cleanup))
  assert.throws(() => verifyGithubSnapshotFinal({ ...input, final: [{ ...final[0], cleanup: f.put(JSON.stringify({ ...cleanup, runtimeProjectPath: '/foreign-owner' })) }] }), /cleanup belongs/)
})

for (const kind of ['item', 'user']) {
  test('exact ' + kind + ' source tuple preserves the pinned shared helper normalize/prune and both compiled artifacts', async t => {
    const f = await fixture(t, 'ide-github-issues-runtime-subpackage-' + kind, { subpackage: kind }), captured = await f.capture(), result = f.verify(captured.attestation)
    assert.equal(hash(source(f.identity.caseSourcePath)), f.identity.sourceSha256)
    const app = JSON.parse(f.load(result.runtimeGenerated.find(item => item.path === 'app.json').artifact))
    const page = kind === 'item' ? 'login-required/index' : 'register/form'
    assert.deepEqual(app.subPackages, [{ root: 'subpackages/' + kind, pages: ['index', page] }])
    assert.deepEqual(app.subpackages, app.subPackages)
    for (const path of [`subpackages/${kind}/weapp-shared/common.js`, `subpackages/${kind}/${page}.js`]) {
      const cli = f.build.generated.find(item => item.path === path), actual = result.runtimeGenerated.find(item => item.path === path)
      assert.deepEqual(actual.artifact, cli.artifact)
    }
    assert.equal(captured.attestation.postHelperSource.some(item => /^(?:src|node_modules|\.weapp-vite)(?:\/|$)/.test(item.path)), false)
    const base = { ...f.identity, args: f.args, cliPath: f.cliPath, cwd: f.project, checkout: f.checkout }
    for (const foreign of GITHUB_PRODUCER_CASES.filter(identity => identity.caseId !== f.identity.caseId)) {
      assert.equal(githubProducerInvocation({ ...base, sourceSha256: foreign.sourceSha256 }), null)
      assert.equal(githubProducerInvocation({ ...base, caseSourcePath: foreign.caseSourcePath }), null)
      assert.equal(githubProducerInvocation({ ...base, caseId: foreign.caseId }), null)
    }
    assert.equal(githubProducerInvocation({ ...base, args: [...f.args, '--skipNpm'] }), null)
    assert.equal(githubProducerInvocation({ ...base, args: [f.cliPath, 'build', f.project] }), null)
    assert.equal(githubProducerInvocation({ ...base, cwd: f.checkout }), null)
  })
}

test('closed producer admission contains only the fifteen pinned source tuples and retains shared runtime readiness/baseline helpers', () => {
  assert.deepEqual(GITHUB_PRODUCER_CASES.map(value => value.caseId), ['ide-github-issues-runtime-issue826', 'ide-github-issues-runtime-issue941', 'ide-github-issues-runtime-issue1009', 'ide-github-issues-runtime-issue1011', 'ide-github-issues-runtime-issue1008', 'ide-github-issues-runtime-import-meta', 'ide-github-issues-runtime-issue297-302', 'ide-github-issues-runtime-issue1012', 'ide-github-issues-runtime-issue1014',
    'ide-github-issues-runtime-subpackage-item', 'ide-github-issues-runtime-subpackage-user', 'ide-github-issues-runtime-web-runtime', 'ide-github-issues-runtime-issue547', 'ide-github-issues-runtime-issue289', 'ide-github-issues-runtime-issue1013'])
  for (const identity of GITHUB_PRODUCER_CASES) assert.equal(hash(source(identity.caseSourcePath)), identity.sourceSha256)
  const shared = source('e2e/ide/github-issues.runtime.shared.ts'), observed = instrumentGithubSharedRuntime(shared)
  const names = ['relaunchPage', 'getSharedMiniProgram']
  const selected = text => {
    const tree = ts.createSourceFile('shared.ts', text, ts.ScriptTarget.Latest, true)
    return tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(tree))
  }
  assert.deepEqual(selected(observed), selected(shared), 'original launch/recovery/route readiness bodies must remain unchanged')
  assert.ok(shared.includes("miniProgram.send('Tool.getInfo', {})"))
  assert.ok(shared.includes("typeof getCurrentPages === 'function' ? getCurrentPages() : []"))
})

test('exact four-test web source uses the unchanged shared snapshot producer and preserves every compiled/vendor byte', async t => {
  const identity = caseProfile('ide-github-issues-runtime-web-runtime')
  assert.equal(identity.caseId, 'ide-github-issues-runtime-web-runtime')
  const extraGenerated = { 'weapp-vendors/a.js': 'actual vendor A', 'weapp-vendors/z.js': 'actual vendor Z' }
  for (const issue of [1186, 448, 459, 804]) for (const extension of ['wxml', 'json', 'js'])
    extraGenerated[`pages/issue-${issue}/index.${extension}`] = extension === 'json' ? '{}' : `actual synthetic ${issue}.${extension}`
  const f = await fixture(t, identity.caseId, { extraGenerated }), captured = await f.capture(), verified = f.verify(captured.attestation)
  assert.equal(hash(source(identity.caseSourcePath)), identity.sourceSha256)
  for (const [path, expected] of Object.entries(extraGenerated)) {
    const original = f.build.generated.find(item => item.path === path), actual = verified.runtimeGenerated.find(item => item.path === path)
    assert.deepEqual(actual.artifact, original.artifact)
    assert.equal(f.load(actual.artifact).toString(), expected)
  }
  const base = { ...identity, args: f.args, cliPath: f.cliPath, cwd: f.project, checkout: f.checkout }
  for (const foreign of GITHUB_PRODUCER_CASES.filter(candidate => candidate.caseId !== identity.caseId)) {
    for (const key of ['caseId', 'caseSourcePath', 'sourceSha256']) assert.equal(githubProducerInvocation({ ...base, [key]: foreign[key] }), null)
  }
  assert.equal(githubProducerInvocation({ ...base, args: [...f.args, '--skipNpm'] }), null)
})

test('new scope-family exact source tuples retain closed producer identity and command binding', () => {
  for (const caseId of ['ide-github-issues-runtime-issue547', 'ide-github-issues-runtime-issue289',
    'ide-github-issues-runtime-issue1013', 'ide-github-issues-runtime-issue297-302']) {
    const identity = caseProfile(caseId)
    const checkout = '/synthetic/checkout', target = identity.caseSourcePath.slice(4).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, ''), cwd = checkout + '/.tmp/e2e-projects/github-issues/' + target
    const base = { ...identity, checkout, cwd, cliPath: '/synthetic/cli', args: ['/synthetic/cli', 'build', cwd, '--platform', 'weapp'] }
    assert.equal(githubProducerInvocation(base)?.caseId, identity.caseId)
    assert.equal(hash(source(identity.caseSourcePath)), identity.sourceSha256)
    for (const key of ['caseId', 'caseSourcePath', 'sourceSha256']) assert.equal(githubProducerInvocation({ ...base, [key]: 'foreign' }), null)
    for (const args of [base.args.slice(0, 3), [...base.args, '--skipNpm']]) assert.equal(githubProducerInvocation({ ...base, args }), null)
  }
})

test('issue826 binds its isolated generated directory while arbitrary output roots remain rejected', () => {
  const identity = caseProfile('ide-github-issues-runtime-issue826')
  const checkout = '/synthetic/checkout'
  const target = identity.caseSourcePath.slice(4).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  const cwd = checkout + '/.tmp/e2e-projects/github-issues/' + target
  const base = { ...identity, checkout, cwd, cliPath: '/synthetic/cli', args: ['/synthetic/cli', 'build', cwd, '--platform', 'weapp'] }
  assert.equal(githubProducerInvocation(base).generatedRoot, cwd + '/dist-issue-826')
  assert.equal(githubProducerInvocation({ ...base, caseId: 'ide-github-issues-runtime-issue941' }), null)
})

test('issue826 complete snapshot transaction validates against its case-bound generated directory', async t => {
  const f = await fixture(t, 'ide-github-issues-runtime-issue826')
  const captured = await f.capture()
  const verified = f.verify(captured.attestation)
  assert.equal(f.build.outputRelative, 'dist-issue-826')
  assert.equal(f.profile.generatedRoot, path.join(f.project, 'dist-issue-826'))
  assert.ok(verified.runtimeGenerated.some(item => item.path === 'pages/index.js'))
  assert.throws(() => verifyGithubProducerTransaction({ transaction: captured.attestation, build: f.build,
    checkout: f.checkout, members: f.members, load: f.load, identity: caseProfile('ide-github-issues-runtime-issue941') }))
})


test('readiness helper instrumentation is selected by the exact import-meta source tuple and legacy guards require identity', async t => {
  const original = source('e2e/ide/github-issues.runtime.shared.ts')
  const legacy = instrumentGithubSharedRuntime(original)
  const selected = caseProfile('ide-github-issues-runtime-import-meta')
  const readiness = instrumentGithubSharedRuntime(original, selected)
  assert.notEqual(readiness, legacy)
  assert.ok(readiness.includes('const conformanceReadinessToken = recordConformanceReadinessStart('))
  assert.equal(legacy.includes('recordConformanceReadinessStart'), false)
  for (const identity of GITHUB_PRODUCER_CASES.filter(value => ![selected.caseId, 'ide-github-issues-runtime-issue1008'].includes(value.caseId))) {
    assert.equal(instrumentGithubSharedRuntime(original, identity), legacy, identity.caseId)
  }
  for (const identity of [undefined, {}, { ...selected, caseId: 'unknown' }, { ...selected, caseSourcePath: selected.caseSourcePath + '.other' },
    { ...selected, sourceSha256: '0'.repeat(64) }, { readiness: true }]) assert.equal(instrumentGithubSharedRuntime(original, identity), legacy)
  const f = await fixture(t, 'ide-github-issues-runtime-issue1012')
  assert.throws(() => verifyGithubProducerGuards({ guards: f.guards, members: f.members, load: f.load }), /exact consumer case identity/)
  assert.throws(() => verifyGithubProducerGuards({ guards: f.guards, members: f.members, load: f.load, identity: selected }), /exact reviewed transform/)
  const g = await fixture(t, selected.caseId)
  assert.doesNotThrow(() => verifyGithubProducerGuards({ guards: g.guards, members: g.members, load: g.load, identity: selected }))
  assert.throws(() => verifyGithubProducerGuards({ guards: g.guards, members: g.members, load: g.load, identity: f.identity }), /exact reviewed transform/)
})

test('issue1008 exact source tuple adds one unique route-method/readiness transform and strict original snapshot transaction', async t => {
  const identity = caseProfile('ide-github-issues-runtime-issue1008')
  const f = await fixture(t, identity.caseId), captured = await f.capture()
  assert.doesNotThrow(() => f.verify(captured.attestation))
  const original = source('e2e/ide/github-issues.runtime.shared.ts'), observed = instrumentGithubSharedRuntime(original, identity)
  assert.ok(observed.includes('return await recordConformanceRoutePageMethod('))
  assert.ok(observed.includes('const conformanceReadinessToken = recordConformanceReadinessStart('))
  assert.doesNotThrow(() => verifyGithubProducerGuards({ guards: f.guards, members: f.members, load: f.load, identity }))
  for (const foreign of GITHUB_PRODUCER_CASES.filter(value => value.caseId !== identity.caseId)) {
    assert.throws(() => verifyGithubProducerGuards({ guards: f.guards, members: f.members, load: f.load, identity: foreign }), /exact reviewed transform/)
  }
})
