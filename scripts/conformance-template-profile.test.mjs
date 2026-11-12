/** Synthetic filesystem/lifecycle tests only. No compiler, packer, SDK or UI
 * executes. The recorder harness replaces only external admission verifiers;
 * production parser, snapshots, spawn observer and independent reader run. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DIRECT_STATIC_CLI_PROFILE, TEMPLATE_STATIC_CASE, TEMPLATE_STATIC_CLI_PROFILE,
  parseStaticCliInvocation, staticFixtureInputClosure } from './conformance-static-cli-profile.mjs'
import { readTemplateSourceProject, verifyTemplateSourceMembers, verifyTemplateProjectEvidence, TEMPLATE_PRODUCER_GUARDS, verifyTemplateProducerTransaction, verifyTemplateSnapshotFinal } from './conformance-fixture-project.mjs'
import { instrumentSnapshotAutomator, snapshotConfigBytes } from './conformance-snapshot-transport.mjs'
import { inspectCompilerMacroLoads } from './conformance-compiler-observation.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const scripts = dirname(fileURLToPath(import.meta.url)), CLI = 'packages/weapp-vite/bin/weapp-vite.js'
const actualSpawn = childProcess.spawn
const identity = { ...TEMPLATE_STATIC_CASE }
const putAt = root => value => {
  const bytes = Buffer.from(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  const file = join(root, 'objects', hash(bytes)); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes)
  return { path: relative(root, file), sha256: hash(bytes), bytes: bytes.length }
}
const loadAt = root => ref => {
  const bytes = readFileSync(join(root, ref.path)); assert.equal(hash(bytes), ref.sha256); assert.equal(bytes.length, ref.bytes); return bytes
}
const write = (file, bytes) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes) }
const files = (base, prefix = '') => readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(entry => entry.isDirectory() ? files(join(base, entry.name), prefix + entry.name + '/') : [prefix + entry.name])

let harnessPromise
async function harness(t) {
  if (!harnessPromise) harnessPromise = (async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'template-recorder-harness-')))
    const stub = pathToFileURL(join(root, 'external-admission-stubs.mjs')).href
    write(join(root, 'external-admission-stubs.mjs'), `
      export { archiveCompilerBuildBytes } from ${JSON.stringify(pathToFileURL(join(scripts, 'conformance-compiler-build.mjs')).href)};
      export const COMPILER_BUILD_PROFILE='weapp-vite-core-v1';
      import {readFileSync} from 'node:fs';
      export const inspectCompilerBuildEvidence=({root})=>({errors:[],attestation:{source:{files:[{path:${JSON.stringify(CLI)}},...JSON.parse(readFileSync(root+'/synthetic-build-guards.json'))]}}});
      export const verifyCompilerBridgeProjects=()=>{throw new Error('Synthetic recorder harness never runs full bridge admission')};
      export const inspectCompilerUseEvidence=()=>{throw new Error('Synthetic recorder harness never runs full compiler-use admission')};
      export const inspectExecutionFixture=()=>{throw new Error('Synthetic recorder harness never runs packer admission')};
    `)
    let source = readFileSync(join(scripts, 'conformance-fixture-build.mjs'), 'utf8')
    for (const name of ['conformance-compiler-build.mjs', 'conformance-compiler-use.mjs', 'pack-execution-evidence.mjs'])
      source = source.replace(`from './${name}'`, `from ${JSON.stringify(stub)}`)
    for (const name of ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs'])
      source = source.replace(`from './${name}'`, `from ${JSON.stringify(pathToFileURL(join(scripts, name)).href)}`)
    source = source.replace(/from '(\.\/[^']+)'/g, (_match, file) => `from ${JSON.stringify(pathToFileURL(join(scripts, file)).href)}`)
    source += '\nexport { verifyCheckpoint, verifySummary };\n'
    write(join(root, 'recorder.mjs'), source)
    cpSync(join(scripts, 'conformance-compiler-use-preload.cjs'), join(root, 'conformance-compiler-use-preload.cjs'))
    for (const name of ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs', 'conformance-snapshot-transport.mjs']) cpSync(join(scripts, name), join(root, name))
    const module = await import(pathToFileURL(join(root, 'recorder.mjs')).href)
    return { root, module }
  })()
  const value = await harnessPromise
  t.after(() => { /* Shared immutable module cleaned by after hook below. */ })
  return value.module
}
test.after(async () => { if (harnessPromise) rmSync((await harnessPromise).root, { recursive: true, force: true }) })

async function fixture(t, { direct = false, suffix, mutation, configPatch = false, noPrivate = false, launchConfig = !direct, applyLaunchConfig = true } = {}) {
  const caseIdentity = direct ? { ...identity, caseId: 'synthetic-direct-static-case' } : identity
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'template-profile-synthetic-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = putAt(root), load = loadAt(root), checkout = join(root, 'checkout')
  const sourceRoot = direct ? join(root, 'direct-project') : join(checkout, identity.templateRelativePath)
  const cliPath = join(checkout, CLI)
  write(cliPath, '// SYNTHETIC PLACEHOLDER: never executed\n')
  write(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'weapp-vite-multi-platform-template', type: 'module', devDependencies: {} }))
  write(join(sourceRoot, direct ? 'project.config.json' : 'config/weapp/project.config.json'),
    JSON.stringify({ miniprogramRoot: direct ? 'dist/' : 'dist', compileType: 'miniprogram', libVersion: 'SYNTHETIC-ONLY' }))
  if (!direct && !noPrivate) write(join(sourceRoot, 'config/weapp/project.private.config.json'), '{"synthetic":true}')
  for (const [path, bytes] of Object.entries({ 'app.json': '{"pages":["pages/index/index"]}', 'app.js': 'App({});',
    'pages/index/index.js': 'Page({});', 'pages/index/index.json': '{}', 'pages/index/index.wxml': '<view>synthetic</view>' }))
    write(join(sourceRoot, 'src', path), bytes)
  const members = files(sourceRoot).map(path => {
    const bytes = readFileSync(join(sourceRoot, path))
    return { path: identity.templateRelativePath + '/' + path, kind: 'file', origin: configPatch && path.endsWith('project.config.json') ? 'patch' : 'source', sha256: hash(bytes), bytes: bytes.length }
  })
  const originalGuards = []
  if (!direct) for (const guard of TEMPLATE_PRODUCER_GUARDS) {
    const original = readFileSync(join(scripts, 'fixtures/template-producer-guards', guard.path.replaceAll('/', '__') + '.txt'))
    assert.equal(hash(original), guard.sha256)
    const observed = guard.path === 'e2e/utils/automator.ts' ? Buffer.from(instrumentSnapshotAutomator(original.toString('utf8'))) : original
    write(join(checkout, guard.path), observed)
    originalGuards.push({ path: guard.path, artifact: put(original) })
    members.push({ path: guard.path, kind: 'file', origin: guard.path === 'e2e/utils/automator.ts' ? 'patch' : 'source', sha256: hash(observed), bytes: observed.length })
  }
  if (launchConfig) { const bytes=readFileSync(join(scripts,'fixtures/template-producer-guards/e2e__utils__automator.cli-bridge.ts.txt'));write(join(checkout,'e2e/utils/automator.cli-bridge.ts'),bytes);members.push({path:'e2e/utils/automator.cli-bridge.ts',kind:'file',origin:'source',sha256:hash(bytes),bytes:bytes.length}) }
  write(join(root, 'synthetic-build-guards.json'), JSON.stringify(originalGuards))
  members.push({ path: CLI, kind: 'file', origin: 'source', sha256: hash(readFileSync(cliPath)), bytes: readFileSync(cliPath).length })
  const builtModule = { path: 'packages/weapp-vite/dist/index.mjs', kind: 'file', origin: 'output', sha256: 'b'.repeat(64), bytes: 5 }; members.push(builtModule)
  const before = put({ members }), directory = join(root, 'case'), configPath = join(directory, 'compiler-use-config.json')
  const config = { runId: 'synthetic-consumer', ...caseIdentity, checkout, evidenceRoot: root, membersReference: before, macroObservation: { synthetic: true } }
  write(configPath, JSON.stringify(config)); cpSync(join(scripts, 'conformance-compiler-use-preload.cjs'), join(directory, 'compiler-use-preload.cjs'))
  const args = [cliPath, 'build', sourceRoot, ...(suffix ?? (direct ? [] : ['--platform', 'weapp', '--skipNpm']))]
  const cwd = direct ? checkout : sourceRoot
  const invocation = parseStaticCliInvocation({ args, cliPath, cwd, checkout, ...identity })
  const originalSpawn = actualSpawn
  let calls = [], recorder
  childProcess.spawn = (command, actualArgs, options) => {
    calls.push({ command, args: [...actualArgs], options })
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 99001; child.exitCode = null; child.signalCode = null
    queueMicrotask(() => {
      const runtimeProject = direct ? sourceRoot : join(sourceRoot, 'dist/weapp')
      cpSync(join(sourceRoot, 'src'), join(runtimeProject, 'dist'), { recursive: true })
      if (!direct) for (const path of files(join(sourceRoot, 'config/weapp')))
        cpSync(join(sourceRoot, 'config/weapp', path), join(runtimeProject, path))
      if (mutation) mutation({ root, sourceRoot, runtimeProject, args: actualArgs })
      child.stdout.emit('data', Buffer.from('SYNTHETIC output writer; no compiler ran\n')); child.exitCode = 0; child.emit('close', 0, null)
    })
    return child
  }
  syncBuiltinESMExports()
  const api = await harness(t)
  try { recorder = api.installStaticFixtureBuildRecorder({ root, directory: join(root, 'capture'), compilerUseConfigPath: configPath,
    compilerBuild: put('SYNTHETIC build identity; admission stubbed for lifecycle unit test'), expectedCommit: 'c'.repeat(40), ...caseIdentity }) }
  catch (error) { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); throw error }
  const dispose = () => {
    if (recorder.disposed) return
    recorder.dispose(); childProcess.spawn = originalSpawn; syncBuiltinESMExports()
  }
  t.after(dispose)
  const sdkSnapshot = join(checkout, '.tmp/e2e-ide-bridge-projects/0123456789abcdef')
  const originalFlush = recorder.flush
  recorder.flush = async () => { if (!direct && fs.existsSync(sdkSnapshot)) await fs.promises.rm(sdkSnapshot, { recursive: true, force: true }); return originalFlush() }
  const compile = async ({ command = 'node', callArgs = args, callCwd = cwd, environment = { PATH: dirname(process.execPath) } } = {}) => {
    const child = childProcess.spawn(command, callArgs, { cwd: callCwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
    await Promise.all(recorder.pending)
    if (!direct && recorder.builds.at(-1)?.status === 'built') {
      const build = recorder.builds.at(-1)
      cpSync(build.outputRoot, sdkSnapshot, { recursive: true })
      const sourceFiles = build.projectOutput.filter(item => !item.path.startsWith('weapp/dist/')).map(item => ({ ...item, path: item.path.slice('weapp/'.length) }))
      for (const [path, bytes] of snapshotConfigBytes({ sourceFiles, load, allowMissingPrivateConfig: true })) write(join(sdkSnapshot, path), bytes)
      await api.captureOwnedSnapshot({ recorder, observation: { sourceProjectPath: build.runtimeProjectPath, generatedRoot: build.outputRoot,
        projectPath: sdkSnapshot, runtimeRoot: sdkSnapshot, cliPath: '/synthetic-selected-devtools/cli' } })
    }
    if(launchConfig && applyLaunchConfig && fs.existsSync(join(sdkSnapshot,'project.config.json'))){const config=JSON.parse(readFileSync(join(sdkSnapshot,'project.config.json')));config.setting.skylineRenderEnable=false;config.libVersion='3.17.3';writeFileSync(join(sdkSnapshot,'project.config.json'),JSON.stringify(config,null,2)+'\n')}
    return child
  }
  const runtime = () => ({ status: 'passed', projectPath: direct ? sourceRoot : sdkSnapshot,
    recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64), tool: { version: 'SYNTHETIC' }, system: { SDKVersion: launchConfig ? '3.17.3' : 'SYNTHETIC' } })
  const offline = checkpoint => {
    const build = checkpoint.attestation.build
    const logs = put([{ kind: 'start', pid: 110, threadId: 0, argv: [process.execPath] },
      { kind: 'start', pid: build.pid, ppid: checkpoint.attestation.observer.pid, cwd: build.cwd, argv: build.runtimeArgv, fixtureInputClosure: build.fixtureInputClosure },
      { kind: 'load', pid: build.pid, path: builtModule.path, sha256: builtModule.sha256, loadedSourceSha256: builtModule.sha256 }]
      .map(item => JSON.stringify(item)).join('\n') + '\n')
    const use = { ownerId: config.runId, ...caseIdentity, compilerBuild: checkpoint.attestation.compilerBuild, before, checkout,
      nodeOptions: build.environment.NODE_OPTIONS, logs: [logs], process: { pid: 110 }, macroObservation: {},
      startedAt: new Date(Date.parse(build.startedAt) - 1000).toISOString(), endedAt: new Date(Date.now() + 1000).toISOString() }
    const verify = c => api.verifyCheckpoint(c, use, load, 'weapp-vite-core-v1', Object.freeze(members))
    return { use, verify }
  }
  return { root, checkout, sourceRoot, cliPath, args, cwd, config, before, put, load, members, invocation, recorder, api, compile, runtime, offline, calls, dispose }
}

test('one pure parser preserves direct forms and recognizes only the exact pinned native template invocation', () => {
  const checkout = '/owned/checkout', sourceRoot = join(checkout, identity.templateRelativePath), cliPath = join(checkout, CLI)
  const context = { checkout, cwd: sourceRoot, cliPath, ...identity }
  const args = [cliPath, 'build', sourceRoot, '--platform', 'weapp', '--skipNpm']
  const value = parseStaticCliInvocation({ ...context, args }); assert.equal(value.profile, TEMPLATE_STATIC_CLI_PROFILE); assert.equal(value.runtimeProjectPath, sourceRoot + '/dist/weapp')
  for (const suffix of [[], ['--platform', 'weapp']]) assert.equal(parseStaticCliInvocation({ ...context, args: args.slice(0, 3).concat(suffix) }).profile, DIRECT_STATIC_CLI_PROFILE)
  for (const changed of [ { args: args.concat('--sourcemap') },
    { args: [...args.slice(0, 3), '--skipNpm', '--platform', 'weapp'] }, { args: [...args.slice(0, 4), 'alipay', '--skipNpm'] },
    { args: [...args.slice(0, 3), '--platform=weapp', '--skipNpm'] }, { args: [...args.slice(0, 3), '-p', 'weapp', '--skipNpm'] },
    { args: [...args.slice(0, 2), '/copied/template', ...args.slice(3)] }, { cwd: checkout }, { caseId: 'other' },
    { caseSourcePath: identity.caseSourcePath.replace('template.test', 'sfc-template.test') }, { sourceSha256: 'f'.repeat(64) } ]) {
    assert.equal(parseStaticCliInvocation({ ...context, args, ...changed }), null)
  }
})

test('recorder binds exact raw argv, source root, generated config and full project closure; offline reader agrees', async t => {
  const f = await fixture(t, { configPatch: true }); await f.compile()
  assert.equal(f.recorder.builds[0].status, 'built', f.recorder.builds[0].failure)
  const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const build = checkpoint.attestation.build
  assert.deepEqual(build.command, ['node', ...f.args]); assert.deepEqual(build.runtimeArgv, [process.execPath, ...f.args])
  assert.equal(build.sourceRoot, f.sourceRoot); assert.equal(build.runtimeProjectPath, join(f.sourceRoot, 'dist/weapp')); assert.notEqual(build.runtimeProjectPath, f.runtime().projectPath)
  assert.equal(build.outputRoot, join(f.sourceRoot, 'dist/weapp/dist'))
  assert.equal(build.projectConfig.sha256, build.runtimeProjectConfig.sha256)
  assert.ok(build.projectOutput.some(item => item.path === 'weapp/project.config.json'))
  assert.ok(build.projectOutput.some(item => item.path === 'weapp/dist/app.json'))
  assert.deepEqual(JSON.parse(f.load(build.fixtureInputClosure)), staticFixtureInputClosure(f.invocation, build.sourceBefore))
  f.offline(checkpoint).verify(checkpoint.attestation)
  const summary = await f.recorder.flush(); assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
})

test('default direct-root producer and independent reader remain compatible without template metadata', async t => {
  const f = await fixture(t, { direct: true }); await f.compile({ command: process.execPath })
  const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  assert.equal(checkpoint.attestation.build.staticCliProfile, undefined); assert.equal(checkpoint.attestation.build.runtimeProjectPath, undefined)
  f.offline(checkpoint).verify(checkpoint.attestation)
  assert.equal((await f.recorder.flush()).attestation.status, 'complete')
})

test('preexisting output directories or broken output links cannot become a fresh template build', async t => {
  for (const linked of [false, true]) {
    const f = await fixture(t)
    if (linked) symlinkSync(join(f.root, 'missing'), join(f.sourceRoot, 'dist'))
    else mkdirSync(join(f.sourceRoot, 'dist/weapp'), { recursive: true })
    assert.throws(() => readTemplateSourceProject(f.invocation), /existed before/)
    if (!linked) {
      await f.compile(); assert.equal(f.recorder.builds[0].status, 'blocked')
      assert.match(f.recorder.builds[0].failure, /existed before/)
    }
    rmSync(join(f.sourceRoot, 'dist'), { recursive: true, force: true }); f.dispose()
  }
})

test('copied runtime roots, source roots, and mini-program roots cannot replace the actual opened generated project', async t => {
  const f = await fixture(t); await f.compile()
  const copy = join(f.root, 'copied-runtime'); cpSync(join(f.sourceRoot, 'dist/weapp'), copy, { recursive: true })
  for (const root of [copy, f.sourceRoot, join(f.sourceRoot, 'dist/weapp/dist')])
    await assert.rejects(f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: { ...f.runtime(), projectPath: root } }), /no unique|ENOENT|config|owned snapshot/)
})

test('extra flags and foreign build roots run unchanged but receive no template capture or controlled environment', async t => {
  for (const suffix of [['--platform', 'weapp', '--skipNpm', '--sourcemap'], ['--platform', 'weapp', '--skipNpm', '--skipNpm'],
    ['--platform', 'alipay', '--skipNpm'], ['--skipNpm', '--platform', 'weapp']]) {
    const f = await fixture(t, { suffix }); await f.compile()
    assert.equal(f.recorder.builds[0].status, 'blocked'); assert.equal(f.calls[0].options.env.NODE_OPTIONS, undefined)
    assert.deepEqual(f.recorder.builds[0].command, ['node', ...f.args])
    await assert.rejects(f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /no unique|ENOENT/)
    f.dispose()
  }
  const f = await fixture(t), foreignArgs = [...f.args]; foreignArgs[2] += '-copied'
  await f.compile({ callArgs: foreignArgs }); assert.equal(f.recorder.builds[0].status, 'blocked')
  assert.deepEqual(f.recorder.builds[0].command, ['node', ...foreignArgs]); assert.equal(f.calls[0].options.env.NODE_OPTIONS, undefined)
})

test('original source/config/package input mutation is rejected before, during, or after captured generation', async t => {
  for (const path of ['src/app.js', 'config/weapp/project.config.json', 'package.json']) {
    const f = await fixture(t, { mutation: ({ sourceRoot }) => writeFileSync(join(sourceRoot, path), 'changed original input') })
    await f.compile(); assert.equal(f.recorder.builds[0].status, 'blocked'); assert.match(f.recorder.builds[0].failure, /mutated its original/)
    f.dispose()
  }
  const f = await fixture(t); writeFileSync(join(f.sourceRoot, 'src/app.js'), 'pre-build unbound source')
  await f.compile(); assert.equal(f.recorder.builds[0].status, 'blocked'); assert.match(f.recorder.builds[0].failure, /sealed consumer/)
})

test('fresh generated config must match original platform config and resolve exactly to the captured mini-program', async t => {
  for (const config of [{ miniprogramRoot: '../../elsewhere', compileType: 'miniprogram' }, { miniprogramRoot: 'other', compileType: 'miniprogram' },
    { miniprogramRoot: 'dist', compileType: 'miniprogram', changed: true }]) {
    const f = await fixture(t, { mutation: ({ runtimeProject }) => writeFileSync(join(runtimeProject, 'project.config.json'), JSON.stringify(config)) })
    await f.compile(); assert.equal(f.recorder.builds[0].status, 'blocked'); assert.match(f.recorder.builds[0].failure, /root|config/i)
    f.dispose()
  }
})

test('live generated/project-config changes after build or checkpoint cannot retain the captured generation', async t => {
  for (const path of ['dist/weapp/project.config.json', 'dist/weapp/dist/app.js']) {
    const f = await fixture(t); await f.compile(); writeFileSync(join(f.sourceRoot, path), 'changed generated bytes')
    await assert.rejects(f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /JSON|differs|changed/)
    f.dispose()
  }
  const f = await fixture(t); await f.compile(); await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  writeFileSync(join(f.sourceRoot, 'src/app.js'), 'late original mutation')
  const summary = await f.recorder.flush(); assert.equal(summary.attestation.status, 'blocked'); assert.match(summary.attestation.failure, /changed/)
})

test('independent reader rejects forged mapping, config omission, foreign outputs, detached minis and startup/profile drift', async t => {
  const f = await fixture(t); await f.compile(); const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const offline = f.offline(checkpoint); offline.verify(checkpoint.attestation)
  for (const mutate of [
    c => { c.build.runtimeProjectPath += '-copied' }, c => { c.build.staticCliProfile.generatedRoot += '-copied' },
    c => { delete c.build.runtimeProjectConfig }, c => { c.build.projectOutput = c.build.projectOutput.filter(item => item.path !== 'weapp/project.config.json') },
    c => { c.build.projectOutput.push({ ...c.build.projectOutput[0], path: 'alipay/foreign.json' }) },
    c => { c.build.generated[0].artifact = f.put('detached generated file') },
    c => { c.build.projectConfig = f.put({ miniprogramRoot: 'dist', compileType: 'miniprogram', unbound: true }) },
    c => { c.build.command.push('--sourcemap'); c.build.runtimeArgv.push('--sourcemap') },
    c => { c.build.runtimeArgv[0] = '/foreign/node'; c.build.nodeResolution.selected = '/foreign/node' },
    c => { c.build.fixtureInputClosure = f.put({ projectPath: f.sourceRoot, sourceBefore: c.build.sourceBefore }) },
    c => { c.build.sourceBefore[0].artifact = f.put('forged original source') },
  ]) { const changed = structuredClone(checkpoint.attestation); mutate(changed); assert.throws(() => offline.verify(changed)) }
})

test('template project source members close every original input and reject unbound dependency aliases or hidden outputs', async t => {
  const f = await fixture(t); await f.compile(); const build = f.recorder.builds[0]
  const options = { profile: f.invocation, sourceBefore: build.sourceBefore, members: f.members, checkout: f.checkout, load: f.load }
  verifyTemplateSourceMembers(options)
  assert.throws(() => verifyTemplateSourceMembers({ ...options, sourceBefore: build.sourceBefore.slice(1) }), /closure/)
  assert.throws(() => verifyTemplateSourceMembers({ ...options, members: f.members.concat({ path: identity.templateRelativePath + '/dist/stale.js' }) }), /overlaps/)
  const changed = structuredClone(build.sourceBefore); changed[0] = { path: changed[0].path, kind: 'consumer-link', target: 'foreign/package' }
  assert.throws(() => verifyTemplateSourceMembers({ ...options, sourceBefore: changed }), /link/)
  verifyTemplateProjectEvidence({ build, profile: f.invocation, load: f.load, members: f.members, checkout: f.checkout })
})

test('macro reader uses the same profile metadata and original sealed inputs without admitting unrelated dynamic ESM', async t => {
  const f = await fixture(t); await f.compile(); const build = f.recorder.builds[0]
  const sourceArtifact = f.put('// SYNTHETIC unrelated dynamic source; never executed\n')
  const events = [
    { ...identity, kind: 'start', isMainThread: true, threadId: 0, execArgv: [], argv: build.runtimeArgv, cwd: build.cwd,
      fixtureInputClosure: build.fixtureInputClosure, hookWitness: 'terminal-rearm-registerHooks-v1' },
    { kind: 'hook-ready', witnessToken: 1 },
    { kind: 'load', classification: 'unbound', format: 'module', sourceArtifact, loadedSourceArtifact: sourceArtifact,
      sha256: sourceArtifact.sha256, bytes: sourceArtifact.bytes, loadedSourceSha256: sourceArtifact.sha256, witnessToken: 1, terminalResult: true },
    { kind: 'end', witnessToken: 1, observerFailed: false, exitCode: 0 },
  ].map((event, index) => ({ ...event, eventSeq: index + 1 }))
  const options = { events, observation: { profile: 'pinned-json-macro-esm-v2-rolldown-runtime', transforms: [] },
    checkout: f.checkout, members: new Map(f.members.map(item => [item.path, item])),
    sourceMembers: new Map(f.members.map(item => [item.path, item])), load: f.load }
  assert.equal(inspectCompilerMacroLoads(options).size, 0)
  for (const mutate of [
    e => { e[0].argv.push('--sourcemap') }, e => { e[0].cwd = f.checkout }, e => { e[0].sourceSha256 = 'f'.repeat(64) },
    e => { e[0].fixtureInputClosure = f.put({ projectPath: f.sourceRoot, sourceBefore: build.sourceBefore }) },
    e => { const closure = JSON.parse(f.load(build.fixtureInputClosure)); closure.staticCliProfile.runtimeProjectPath += '-copied'; e[0].fixtureInputClosure = f.put(closure) },
    e => { const closure = JSON.parse(f.load(build.fixtureInputClosure)); closure.sourceBefore[0].artifact = f.put('forged input'); e[0].fixtureInputClosure = f.put(closure) },
  ]) { const changed = structuredClone(events); mutate(changed); assert.throws(() => inspectCompilerMacroLoads({ ...options, events: changed })) }
})

test('the exact original template without a private config retains its generated IDE root and owned SDK snapshot', async t => {
  const f = await fixture(t, { noPrivate: true }); await f.compile()
  const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  assert.equal(checkpoint.attestation.build.projectOutput.some(item => item.path === 'weapp/project.private.config.json'), false)
  const transaction = JSON.parse(f.load(checkpoint.attestation.producerTransaction))
  assert.equal(transaction.sourceRoot, f.sourceRoot); assert.equal(transaction.sourceProjectPath, join(f.sourceRoot, 'dist/weapp'))
  assert.equal(transaction.runtimeProjectPath, f.runtime().projectPath); assert.equal(transaction.snapshotFiles.some(item => item.path === 'project.private.config.json'), true)
  f.offline(checkpoint).verify(checkpoint.attestation)
  const summary = await f.recorder.flush(); assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  const offline = f.offline(checkpoint)
  f.api.verifySummary(summary.attestation, checkpoint.attestation, checkpoint.reference, offline.use, f.load, Object.freeze(f.members))
})
test('byte-identical build-source and generated IDE directory replacements cannot inherit actual ownership', async t => {
  for (const kind of ['source', 'generated-ide']) {
    const f = await fixture(t); await f.compile()
    const actual = kind === 'source' ? f.sourceRoot : join(f.sourceRoot, 'dist/weapp'), saved = actual + '-owned-original'
    renameSync(actual, saved); cpSync(saved, actual, { recursive: true })
    await assert.rejects(f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /physical directory identity/)
    f.dispose()
  }
})
test('default template cannot admit generated IDE direct launch or a missing owned SDK snapshot transaction', async t => {
  const f = await fixture(t); await f.compile()
  await assert.rejects(f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: { ...f.runtime(), projectPath: join(f.sourceRoot, 'dist/weapp') } }), /owned snapshot/)
  const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const altered = structuredClone(checkpoint.attestation); delete altered.producerTransaction; delete altered.runtimeGenerated; delete altered.build.producerProfile
  assert.throws(() => f.offline(checkpoint).verify(altered), /runtime|snapshot/)
})
test('SDK snapshot replacement preserves original removal result but cannot create final cleanup admission', async t => {
  const f = await fixture(t); await f.compile(); await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const path = f.runtime().projectPath, original = path + '-owned-original'
  renameSync(path, original); cpSync(original, path, { recursive: true })
  assert.equal(await fs.promises.rm(path, { recursive: true, force: true }), undefined)
  assert.equal(fs.existsSync(path), false)
  const summary = await f.recorder.flush(); assert.equal(summary.attestation.status, 'blocked'); assert.match(summary.attestation.failure, /cleanup/)
})
test('template complete transaction and original awaited snapshot cleanup reject substituted roots, guards, transport and settlement', async t => {
  const f = await fixture(t); await f.compile(); const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const transaction = JSON.parse(f.load(checkpoint.attestation.producerTransaction)), options = { transaction, build: checkpoint.attestation.build, identity, checkout: f.checkout, members: f.members, load: f.load }
  verifyTemplateProducerTransaction(options)
  for (const mutate of [v => v.sourceProjectPath += '-copy', v => v.generatedProjectIdentity.inode = '0', v => v.guards.pop(), v => v.postHelperProjectOutput.pop(), v => v.transport = f.put('unreviewed transport'), v => v.snapshotFiles.pop()]) {
    const changed = structuredClone(transaction); mutate(changed); assert.throws(() => verifyTemplateProducerTransaction({ ...options, transaction: changed }))
  }
  const summary = await f.recorder.flush(); assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  const finalOptions = { ...options, final: summary.attestation.producerFinal, transactionReference: checkpoint.attestation.producerTransaction, runtimeConfigurationReference: checkpoint.attestation.runtimeConfiguration, checkpointAt: checkpoint.attestation.capturedAt, recordingEndedAt: summary.attestation.recordingEndedAt }
  verifyTemplateSnapshotFinal(finalOptions)
  const final = structuredClone(summary.attestation.producerFinal), cleanup = JSON.parse(f.load(final[0].cleanup)); cleanup.originalRemoval.status = 'rejected'; final[0].cleanup = f.put(cleanup)
  assert.throws(() => verifyTemplateSnapshotFinal({ ...finalOptions, final }), /original snapshot removal/)
})

test('exact original launch configuration commits complete post state and cleanup; independent reader agrees', async t => {
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const c = checkpoint.attestation, transaction = JSON.parse(f.load(c.producerTransaction)), phase = JSON.parse(f.load(c.runtimeConfiguration))
  assert.equal(phase.phase, 'sdk-checkpoint'); assert.deepEqual(phase.beforeFiles, transaction.snapshotFiles)
  assert.equal(phase.afterFiles.length, phase.beforeFiles.length)
  assert.deepEqual(phase.afterFiles.filter((item, i) => item.artifact.sha256 !== phase.beforeFiles[i].artifact.sha256).map(item => item.path), ['project.config.json'])
  assert.deepEqual(JSON.parse(f.load(phase.afterFiles.find(item => item.path === 'project.config.json').artifact)),
    { compileType: 'miniprogram', libVersion: '3.17.3', synthetic: true, simulatorType: 'wechat', simulatorPluginLibVersion: {}, miniprogramRoot: './', srcMiniprogramRoot: './', setting: { packNpmManually: false, packNpmRelationList: [], skylineRenderEnable: false }, condition: {} })
  assert.deepEqual(phase.runtimeObservation, c.runtimeObservation)
  f.offline(checkpoint).verify(c)
  const summary = await f.recorder.flush(); assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  f.api.verifySummary(summary.attestation, c, checkpoint.reference, f.offline(checkpoint).use, f.load, Object.freeze(f.members))
  assert.deepEqual(summary.attestation.producerFinal[0].runtimeConfiguration, c.runtimeConfiguration)
})

test('launch phase rejects arbitrary runtime config, payload, helper, generated and source mutations with all operands durable', async t => {
  const mutations = [
    f => writeFileSync(join(f.runtime().projectPath, 'project.config.json'), '{"appid":"arbitrary"}'),
    f => writeFileSync(join(f.runtime().projectPath, 'app.js'), 'runtime code changed'),
    f => writeFileSync(join(f.sourceRoot, 'src/app.js'), 'source changed'),
    f => writeFileSync(join(f.sourceRoot, 'dist/weapp/dist/app.js'), 'generated changed'),
    f => writeFileSync(join(f.sourceRoot, 'dist/weapp/project.config.json'), '{"compileType":"plugin"}'),
  ]
  for (const mutate of mutations) {
    const f = await fixture(t, { launchConfig: true }); await f.compile(); mutate(f)
    await assert.rejects(f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /generation changed/)
    const c = JSON.parse(f.load(f.recorder.checkpoint)), guards = JSON.parse(f.load(c.generationGuards))
    assert.equal(c.status, 'blocked'); assert.ok(c.build); assert.ok(c.producerTransaction)
    assert.deepEqual(Object.keys(guards.closures).sort(), ['generated','project','runtime','source'])
    for (const operand of Object.values(guards.closures)) { assert.ok(operand.expected); assert.ok(operand.actual); assert.ok(operand.diff); assert.equal(typeof operand.passed, 'boolean') }
    assert.equal(guards.status, 'failed'); assert.ok(Object.values(guards.closures).some(item => item.diff.changed.length))
    f.dispose()
  }
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const c = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  for (const change of [
    transaction => { transaction.launchProjectConfig.setting.extra = true },
    transaction => { transaction.launchProjectConfig.libVersion = 'wrong' },
    transaction => { transaction.launchHelper.artifact = f.put('substituted bridge helper') },
    transaction => { delete transaction.launchHelper },
  ]) {
    const transaction = structuredClone(f.recorder.snapshots[0].value); change(transaction)
    assert.throws(() => verifyTemplateProducerTransaction({ transaction, build: c.attestation.build, checkout: f.checkout, members: f.members, load: f.load, identity }), /launch|helper/)
  }
})

test('all read errors and independent later predicates survive SDK checkpoint rejection', async t => {
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const runtimeRoot = f.runtime().projectPath
  renameSync(join(f.sourceRoot, 'dist/weapp/dist'), join(f.root, 'removed-generated'))
  writeFileSync(join(f.sourceRoot, 'src/app.js'), 'simultaneous source mutation')
  writeFileSync(join(runtimeRoot, 'app.js'), 'simultaneous runtime mutation')
  await assert.rejects(f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /generation changed/)
  const c = JSON.parse(f.load(f.recorder.checkpoint)), guards = JSON.parse(f.load(c.generationGuards))
  assert.equal(guards.closures.generated.readError.code, 'ENOENT')
  assert.equal(guards.closures.source.passed, false); assert.equal(guards.closures.runtime.passed, false); assert.equal(guards.closures.project.passed, false)
  assert.ok(guards.closures.source.diff.changed.length); assert.ok(guards.closures.runtime.diff.changed.length)
})

test('independent reader rejects omitted, forged, foreign, reordered and retimed launch transactions', async t => {
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), offline = f.offline(checkpoint)
  const phase = JSON.parse(f.load(checkpoint.attestation.runtimeConfiguration))
  for (const mutate of [
    p => { p.runtimeProjectPath += '-foreign' }, p => { p.observer.pid++ }, p => { p.configuration.setting.skylineRenderEnable = true },
    p => { p.beforeFiles.pop() }, p => { p.afterFiles.reverse() }, p => { p.afterFiles.pop() },
    p => { p.runtimeRootIdentity.inode = String(BigInt(p.runtimeRootIdentity.inode) + 1n) },
    p => { p.runtimeObservation = f.put({ ...f.runtime(), installationId: 'b'.repeat(64) }) },
    p => { p.capturedAt = '2000-01-01T00:00:00.000Z' }, p => { p.phase = 'before-cleanup' },
    p => { delete p.generationGuards }, p => { p.helper.artifact = f.put('forged') },
  ]) {
    const p = structuredClone(phase), c = structuredClone(checkpoint.attestation); mutate(p); c.runtimeConfiguration = f.put(p)
    assert.throws(() => offline.verify(c))
  }
  for (const field of ['runtimeConfiguration','generationGuards']) {
    const c=structuredClone(checkpoint.attestation);delete c[field];assert.throws(() => offline.verify(c),/omitted/)
  }
  const guards = JSON.parse(f.load(checkpoint.attestation.generationGuards))
  for(const mutate of [g=>delete g.closures.source,g=>g.closures.runtime.expected.pop(),g=>g.closures.generated.actual.pop(),g=>g.identities.runtime.before.inode='1',g=>g.closures.source.diff.added.push({path:'forged'})]){
    const g=structuredClone(guards), c=structuredClone(checkpoint.attestation);mutate(g);c.generationGuards=f.put(g);assert.throws(()=>offline.verify(c))
  }
})

test('cleanup checks admitted post state and preserves genuine awaited removal after late config failure', async t => {
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const c = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const root = f.runtime().projectPath
  writeFileSync(join(root, 'project.config.json'), '{"late":"change"}')
  await fs.promises.rm(root, {recursive:true,force:true})
  assert.equal(fs.existsSync(root), false)
  assert.ok(f.recorder.snapshotFailures.some(message => /changed before owned cleanup/.test(message)))
  assert.equal((await f.recorder.flush()).attestation.status,'blocked')
})

test('failed startup cleanup can observe reviewed phase without inventing SDK identity', async t => {
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const root = f.runtime().projectPath
  await fs.promises.rm(root, {recursive:true,force:true})
  const item = f.recorder.snapshots[0], phase = JSON.parse(f.load(item.runtimeConfiguration))
  assert.equal(phase.phase,'before-cleanup');assert.equal(phase.runtimeObservation,undefined)
  assert.ok(item.cleanup);assert.equal(fs.existsSync(root),false)
})

test('bridge matcher binds exact actual startup payload, config bytes and selected SDK phase', async t => {
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const checkpoint = await f.api.captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const c = checkpoint.attestation, transaction = JSON.parse(f.load(c.producerTransaction)), config = transaction.snapshotFiles.find(item => item.path === 'project.config.json').artifact
  const summary = (await f.recorder.flush()).attestation, use = f.offline(checkpoint).use
  const project = { mode:'owned-snapshot', projectPath:transaction.runtimeProjectPath, configSource:f.load(config).toString('utf8'),sha256:config.sha256,bytes:config.bytes,
    cliPath:transaction.cliPath,projectConfig:structuredClone(transaction.launchProjectConfig),runId:use.ownerId,caseId:use.caseId,sourceSha256:use.sourceSha256,
    caseSourcePath:use.caseSourcePath,pid:99002,ppid:transaction.observer.pid,threadId:0,at:transaction.capturedAt }
  const input = {projects:[project],use,checkpoint:c,summary,load:f.load,validatedMembers:Object.freeze(f.members)}
  assert.equal(matchCompilerBridgeProjects(input)[0].selected,true)
  for(const mutate of [p=>delete p.projectConfig,p=>p.projectConfig.setting.extra=true,p=>p.projectConfig.libVersion='wrong',p=>p.configSource='{}',p=>p.at='2000-01-01T00:00:00.000Z']){
    const p=structuredClone(project);mutate(p);assert.throws(()=>matchCompilerBridgeProjects({...input,projects:[p]}))
  }
  const crossed=structuredClone(c);crossed.runtimeConfiguration=f.put('foreign phase');assert.throws(()=>matchCompilerBridgeProjects({...input,checkpoint:crossed}),/another configuration phase/)
})

test('rejected SDK-phase candidate remains archived with complete original observation and operands', async t => {
  const f = await fixture(t, { launchConfig: true }); await f.compile()
  const runtime = f.runtime();runtime.system.SDKVersion='wrong-sdk'
  await assert.rejects(f.api.captureOfficialFixtureCheckpoint({recorder:f.recorder,runtimeObservation:runtime}),/fixed SDK/)
  const checkpoint=JSON.parse(f.load(f.recorder.checkpoint))
  assert.equal(checkpoint.status,'blocked');assert.ok(checkpoint.runtimeConfigurationCandidate);assert.ok(checkpoint.generationGuards)
  const phase=JSON.parse(f.load(checkpoint.runtimeConfigurationCandidate))
  assert.deepEqual(JSON.parse(f.load(phase.runtimeObservation)),runtime)
  assert.ok(phase.beforeFiles.length);assert.ok(phase.afterFiles.length)
  const ledger=JSON.parse(readFileSync(join(f.recorder.directory,'runtime-configuration-candidates.json')))
  assert.equal(ledger.entries[0].status,'rejected');assert.deepEqual(ledger.entries[0].candidate,checkpoint.runtimeConfigurationCandidate)
  assert.match(ledger.entries[0].failure.message,/fixed SDK/)
})

test('launch failure before helper configuration cleans only exact unchanged snapshot and cannot become SDK phase', async t => {
  const f = await fixture(t,{launchConfig:true,applyLaunchConfig:false});await f.compile()
  await assert.rejects(f.api.captureOfficialFixtureCheckpoint({recorder:f.recorder,runtimeObservation:f.runtime()}),/generation changed/)
  const checkpoint=JSON.parse(f.load(f.recorder.checkpoint)),sdkGuards=JSON.parse(f.load(checkpoint.generationGuards))
  assert.equal(sdkGuards.runtimePhase,'post-launch');assert.equal(sdkGuards.closures.runtime.passed,false)
  await fs.promises.rm(f.runtime().projectPath,{recursive:true,force:true})
  const item=f.recorder.snapshots[0],phase=JSON.parse(f.load(item.runtimeConfiguration))
  assert.equal(phase.phase,'unchanged-before-cleanup');assert.equal(phase.runtimeObservation,undefined)
  assert.deepEqual(phase.beforeFiles,phase.afterFiles);assert.ok(item.cleanup)
  assert.equal((await f.recorder.flush()).attestation.status,'blocked')
})

import { matchCompilerBridgeProjects } from './conformance-compiler-use.mjs'
