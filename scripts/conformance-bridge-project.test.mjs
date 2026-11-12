import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectCompilerBridgeProject, inspectExtraLoader, matchCompilerBridgeProjects, verifyCompilerBridgeProjects } from './conformance-compiler-use.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const checkout = '/owned/compiler-checkout'
const sourceSha256 = 'a'.repeat(64), ownerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const artifact = (path, bytes) => ({ path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) })
const identity = { runId: ownerId, caseId: 'ide-reviewed-source', sourceSha256, caseSourcePath: 'e2e/ide/reviewed.test.ts' }
const at = seconds => `2026-11-07T00:00:${String(seconds).padStart(2, '0')}.000Z`
function start(mode = 'owned-snapshot', suffix = '0123456789abcdef', pid = 300) {
  const path = join(checkout, mode === 'direct-project' ? '.tmp/e2e-projects' : '.tmp/e2e-ide-bridge-projects', suffix)
  const configSource = JSON.stringify({ appid: 'actual-app', compileType: 'miniprogram', miniprogramRoot: mode === 'direct-project' ? 'dist/' : './' })
  return { kind: 'start', ...identity, pid, ppid: 200, threadId: 0, isMainThread: true, at: at(4), cwd: checkout,
    argv: ['/actual/node', join(checkout, 'e2e/utils/automator.cli-bridge.ts'), JSON.stringify({ projectPath: path, cliPath: '/actual/devtools/cli', projectConfig: { libVersion: '3.17.3' } })],
    execArgv: ['--import', 'tsx'], bridgeProject: { projectPath: path, configFile: join(path, 'project.config.json'),
      configSource, sha256: hash(configSource), bytes: Buffer.byteLength(configSource) } }
}
function fixture({ direct = false, retry = false } = {}) {
  const store = new Map()
  const put = (path, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); const ref = artifact(path, bytes); store.set(path, bytes); return ref }
  const load = ref => { const value = store.get(ref.path); assert.ok(value, ref.path); assert.equal(hash(value), ref.sha256); assert.equal(value.length, ref.bytes); return value }
  const compilerBuild = put('compiler-build.json', {}), before = put('consumer-guard.json', {})
  const use = { ownerId, ...Object.fromEntries(['caseId', 'sourceSha256', 'caseSourcePath'].map(key => [key, identity[key]])), compilerBuild, before,
    startedAt: at(0), endedAt: at(10), checkout }
  const starts = [start(direct ? 'direct-project' : 'owned-snapshot')]
  if (retry) { const failed = start('owned-snapshot', '1111111111111111', 299); failed.at = at(3); starts.unshift(failed) }
  const observer = { pid: 200, threadId: 1 }
  const build = { pid: 250, projectPath: direct ? starts[0].bridgeProject.projectPath : join(checkout, '.tmp/e2e-projects/source'),
    outputRoot: direct ? join(starts[0].bridgeProject.projectPath, 'dist') : join(checkout, '.tmp/e2e-projects/source/dist'), endedAt: at(1),
    projectConfig: put('direct-config.json', starts[0].bridgeProject.configSource) }
  const finals = starts.filter(() => !direct).map((event, index) => {
    const transaction = put(`transaction-${index}.json`, { buildPid: build.pid, sourceRoot: build.projectPath, generatedRoot: build.outputRoot,
      observer, runtimeProjectPath: event.bridgeProject.projectPath, cliPath: '/actual/devtools/cli', capturedAt: at(2),
      snapshotFiles: [{ kind: 'file', path: 'project.config.json', artifact: put(`config-${index}.json`, event.bridgeProject.configSource) }] })
    const cleanup = put(`cleanup-${index}.json`, { transaction, observer, runtimeProjectPath: event.bridgeProject.projectPath, removedAt: at(8), projectAbsent: true })
    return { transaction, cleanup }
  })
  const checkpoint = { ...identity, compilerBuild, consumerGuard: before, build, observer,
    runtimeObservation: put('runtime.json', { projectPath: starts.at(-1).bridgeProject.projectPath, recordedAt: at(6) }),
    ...(direct ? {} : { producerTransaction: finals.at(-1).transaction }) }
  return { use, checkpoint, summary: { producerFinal: finals }, projects: starts.map(value => inspectCompilerBridgeProject(value, { checkout })), starts, store, load, put }
}
const match = f => matchCompilerBridgeProjects(f)

test('bridge project classifier separates direct and owned-snapshot addresses without granting ownership', () => {
  assert.equal(inspectCompilerBridgeProject(start('direct-project', 'source'), { checkout }).mode, 'direct-project')
  assert.equal(inspectCompilerBridgeProject(start(), { checkout }).mode, 'owned-snapshot')
  const f = fixture(); f.summary.producerFinal = []
  assert.throws(() => match(f), /no unique captured\/finalized transaction owner/)
  assert.throws(() => verifyCompilerBridgeProjects({ ...f, witness: {} }), /opaque output/)
})

test('bridge classifier separates malformed payload/path/config/SDK diagnostics', async t => {
  const variants = {
    'bad JSON': [s => { s.argv[2] = '{' }, /payload is malformed JSON/],
    'nonobject payload': [s => { s.argv[2] = '[]' }, /payload is not an object/],
    'noncanonical path': [s => { const p = JSON.parse(s.argv[2]); p.projectPath += '/..'; s.argv[2] = JSON.stringify(p) }, /not canonical/],
    'foreign address': [s => { const p = JSON.parse(s.argv[2]); p.projectPath = '/foreign/0123456789abcdef'; s.argv[2] = JSON.stringify(p) }, /neither the reviewed direct/],
    'snapshot wrong length': [s => { const p = JSON.parse(s.argv[2]); p.projectPath = p.projectPath.slice(0, -1); s.argv[2] = JSON.stringify(p) }, /neither the reviewed direct/],
    'wrong SDK': [s => { const p = JSON.parse(s.argv[2]); p.projectConfig.libVersion = 'latest'; s.argv[2] = JSON.stringify(p) }, /payload SDK/],
    'missing observation': [s => { delete s.bridgeProject }, /config observation/],
    'crossed observed path': [s => { s.bridgeProject.projectPath += '-other' }, /config observation/],
    'crossed config file': [s => { s.bridgeProject.configFile += '-other' }, /config observation/],
    'config hash': [s => { s.bridgeProject.sha256 = '0'.repeat(64) }, /hash\/size/],
    'config bytes': [s => { s.bridgeProject.bytes++ }, /hash\/size/],
    'config JSON': [s => { const v = s.bridgeProject; v.configSource = '{'; v.sha256 = hash(v.configSource); v.bytes = 1 }, /config is malformed JSON/],
    'config app': [s => { const v = s.bridgeProject; v.configSource = '{}'; v.sha256 = hash(v.configSource); v.bytes = 2 }, /no app identity/],
  }
  for (const [name, [mutate, expected]] of Object.entries(variants)) await t.test(name, () => {
    const event = start(); mutate(event); assert.throws(() => inspectCompilerBridgeProject(event, { checkout }), expected)
  })
})

test('snapshot bridge still requires exact reviewed tsx source/package and actual same-thread resolve/load', async t => {
  const event = start(), path = 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs'
  const pkgPath = 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/package.json'
  const pkg = Buffer.from(JSON.stringify({ name: 'tsx', version: '4.23.15', exports: { '.': './dist/loader.mjs' } }))
  const members = new Map([[path, { origin: 'dependency', sha256: 'f'.repeat(64), bytes: 23 }],
    [pkgPath, { origin: 'dependency', artifact: artifact('tsx-package.json', pkg) }], ['e2e/utils/automator.cli-bridge.ts', { origin: 'source' }]])
  const resolve = { kind: 'resolve', specifier: 'tsx', url: pathToFileURL(join(checkout, path)).href, parentURL: pathToFileURL(checkout + '/').href }
  const load = { kind: 'load', path, file: join(checkout, path), classification: 'bound', sha256: 'f'.repeat(64), bytes: 23, loadedSourceSha256: 'f'.repeat(64) }
  const bridge = { kind: 'load', path: 'e2e/utils/automator.cli-bridge.ts', classification: 'bound' }
  assert.equal(inspectExtraLoader([event, resolve, load, bridge], { checkout, members, load: () => pkg }).mode, 'owned-snapshot')
  for (const [name, events] of [['no actual resolve', [event, load, bridge]], ['no actual load', [event, resolve, bridge]],
    ['transformed loader', [event, resolve, { ...load, loadedSourceSha256: '0'.repeat(64) }, bridge]], ['missing bridge source load', [event, resolve, load]]]) {
    await t.test(name, () => assert.throws(() => inspectExtraLoader(events, { checkout, members, load: () => pkg }), /actual resolve\/load|source was not loaded/))
  }
})

test('snapshot matching retains failed/retried startup observations and selects only actual runtime transaction', () => {
  const f = fixture({ retry: true }), coverage = match(f)
  assert.equal(coverage.length, 2)
  assert.equal(coverage[0].selected, false)
  assert.equal(coverage[1].selected, true)
  assert.deepEqual(coverage.map(value => value.pid), [299, 300])
  assert.ok(coverage.every(value => !Object.hasOwn(value, 'passed') && !Object.hasOwn(value, 'status')))
})

test('a selected successful retry cannot hide an unowned earlier startup or select its foreign transaction', () => {
  const f = fixture({ retry: true }); f.summary.producerFinal.shift()
  assert.throws(() => match(f), /no unique captured\/finalized transaction owner/)
  const crossed = fixture({ retry: true })
  crossed.checkpoint.producerTransaction = crossed.summary.producerFinal[0].transaction
  assert.throws(() => match(crossed), /selected SDK runtime/)
})

test('snapshot closure rejects changed actual build/cleanup ownership independently of address shape', async t => {
  const variants = {
    'foreign compiled source': ['transaction', value => { value.sourceRoot = '/foreign/source' }],
    'foreign generated output': ['transaction', value => { value.generatedRoot = '/foreign/output' }],
    'foreign compiler pid': ['transaction', value => { value.buildPid++ }],
    'foreign transaction observer': ['transaction', value => { value.observer = { ...value.observer, threadId: 2 } }],
    'absent cleanup proof': ['cleanup', value => { value.projectAbsent = false }],
    'foreign cleanup observer': ['cleanup', value => { value.observer = { ...value.observer, pid: 201 } }],
    'foreign cleanup transaction': ['cleanup', value => { value.transaction = artifact('foreign-transaction.json', '{}') }],
  }
  for (const [name, [kind, mutate]] of Object.entries(variants)) await t.test(name, () => {
    const f = fixture(), prior = f.summary.producerFinal[0][kind]
    const value = JSON.parse(f.load(prior)); mutate(value)
    f.summary.producerFinal[0][kind] = f.put(`changed-${kind}.json`, value)
    assert.throws(() => match(f), /source\/build\/observer|cleanup interval/)
  })
})

test('bridge/fixture matching rejects detached owners, source, config, CLI and cleanup intervals', async t => {
  const variants = {
    'checkpoint owner': [f => { f.checkpoint.runId = 'foreign' }, /checkpoint belongs/],
    'startup owner': [f => { f.projects[0] = { ...f.projects[0], runId: 'foreign' } }, /startup belongs/],
    'startup source': [f => { f.projects[0] = { ...f.projects[0], sourceSha256: 'f'.repeat(64) } }, /startup belongs/],
    'startup time': [f => { f.projects[0] = { ...f.projects[0], at: at(11) } }, /startup belongs/],
    'duplicate startup': [f => { f.projects.push(f.projects[0]) }, /startup is duplicated/],
    'wrong parent observer': [f => { f.projects[0] = { ...f.projects[0], ppid: 201 } }, /source\/build\/observer/],
    'wrong CLI': [f => { f.projects[0] = { ...f.projects[0], cliPath: '/foreign/cli' } }, /config\/CLI/],
    'wrong config': [f => { f.projects[0] = { ...f.projects[0], sha256: '0'.repeat(64) } }, /config\/CLI/],
    'no transaction': [f => { delete f.checkpoint.producerTransaction }, /no snapshot fixture transaction/],
    'no finalized owner': [f => { f.summary.producerFinal = [] }, /no unique captured\/finalized/],
    'ambiguous owner': [f => { f.summary.producerFinal.push(f.summary.producerFinal[0]) }, /no unique captured\/finalized/],
    'startup before capture': [f => { f.projects[0] = { ...f.projects[0], at: at(1) } }, /cleanup interval/],
    'startup after cleanup': [f => { f.projects[0] = { ...f.projects[0], at: at(9) } }, /cleanup interval/],
    'selected SDK has no startup': [f => { f.projects = [] }, /selected SDK runtime/],
    'foreign selected SDK': [f => { f.checkpoint.runtimeObservation = f.put('foreign-runtime.json', { projectPath: '/foreign/project', recordedAt: at(6) }) }, /selected SDK runtime/],
  }
  for (const [name, [mutate, expected]] of Object.entries(variants)) await t.test(name, () => { const f = fixture(); mutate(f); assert.throws(() => match(f), expected) })
})

test('direct matching binds actual compiled config and cannot consume a snapshot transaction', () => {
  const f = fixture({ direct: true })
  assert.equal(match(f)[0].mode, 'direct-project')
  f.checkpoint.build.projectConfig = f.put('changed-config.json', { appid: 'other' })
  assert.throws(() => match(f), /actual compiled config/)
  const crossed = fixture({ direct: true }); crossed.checkpoint.producerTransaction = artifact('foreign.json', '{}')
  assert.throws(() => match(crossed), /actual compiled project\/observer/)
})
