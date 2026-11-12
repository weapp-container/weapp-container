import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { archiveCompilerBuildBytes, buildCompilerFromPinnedSource } from './conformance-compiler-build.mjs'
import { materializeCompilerUse, sealCompilerUse, finishCompilerUse } from './conformance-compiler-use.mjs'
import { installStaticFixtureBuildRecorder, captureOfficialFixtureCheckpoint, flushStaticFixtureBuildRecorder, finalizeStaticFixtureBuild, inspectConformanceFixtureBuildEvidence } from './conformance-fixture-build.mjs'
import { createSyntheticFixtureBuild } from './fixtures/conformance-fixture-build.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const caseSource = '// Actual synthetic compiler/packer contract test; no official IDE assertion.\n'
async function fixture(t, { observedCompanionContract = false } = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'conformance-fixture-build-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), archive = join(root, 'build-archive'), project = join(root, 'project')
  await mkdir(join(source, 'e2e'), { recursive: true })
  const raw = {
    'app.json': JSON.stringify({ pages: ['pages/index/index'] }), 'app.js': 'App({});\n',
    'pages/index/index.js': 'Page({data:{message:"actual generated output"}});\n',
    'pages/index/index.json': '{}', 'pages/index/index.wxml': '<view>{{message}}</view>',
    'pages/index/index.wxss': 'view{color:red}',
  }
  const built = (observedCompanionContract ? 'import { observer } from "weapp-container:conformance-observer-v1";\n' : '')
    + `import{cp,mkdir,writeFile,symlink,unlink}from'node:fs/promises';import path from'node:path';export async function build(args){
    if(!['build','dev'].includes(args[0]))throw new Error('unsupported action');const project=args[0]==='dev'?process.cwd():args[1];
    await cp(path.join(project,'src'),path.join(project,'dist'),{recursive:true});
    if(process.env.STATIC_TEST_SUPPORT){await mkdir(path.join(project,'.weapp-vite'),{recursive:true});
      for(const file of ['tsconfig.json',...['tsconfig.app.json','tsconfig.node.json','tsconfig.server.json','tsconfig.shared.json','tsconfig.shared.empty.d.ts','uni-app.d.ts'].map(f=>'.weapp-vite/'+f)])await writeFile(path.join(project,file),'{}');
      if(['typed-router','adjacent-dts'].includes(process.env.STATIC_TEST_SUPPORT))await writeFile(path.join(project,'.weapp-vite/typed-router.d.ts'),'export type PagePath = "pages/index/index";');
      if(process.env.STATIC_TEST_SUPPORT==='adjacent-dts')await writeFile(path.join(project,'.weapp-vite/typed-router-extra.d.ts'),'export type Unreviewed = true;');
      if(process.env.STATIC_TEST_SUPPORT==='extra')await writeFile(path.join(project,'.weapp-vite/unreviewed.js'),'unreviewed');
      if(process.env.STATIC_TEST_SUPPORT==='original')await writeFile(path.join(project,'src/app.js'),'App({changed:true});');
      if(process.env.STATIC_TEST_SUPPORT==='symlink'){await unlink(path.join(project,'.weapp-vite/uni-app.d.ts'));await symlink(path.join(project,'src/app.js'),path.join(project,'.weapp-vite/uni-app.d.ts'));}
    }
    if(process.env.STATIC_TEST_TERM_EXIT)process.on('SIGTERM',()=>process.exit(143));
    console.log('actual tiny compiler child generated mini-program');
    if(process.env.STATIC_TEST_EXIT_143)process.exit(143);
    if(process.env.STATIC_TEST_HOLD)setInterval(()=>{},1000);
  }\n`
  const files = { '.gitignore': 'node_modules/\ndist/\n', 'package.json': JSON.stringify({ name: 'synthetic-fixture-compiler', type: 'module', packageManager: `node@${process.versions.node}` }),
    'fixture-lock.json': '{}', 'e2e/case.mjs': caseSource,
    'cli.mjs': "import{build}from'./dist/index.mjs';await build(process.argv.slice(2));\n",
    'install.mjs': "import{mkdir}from'node:fs/promises';await mkdir('node_modules');",
    'build.mjs': `import{mkdir,writeFile}from'node:fs/promises';await mkdir('dist');await writeFile('dist/index.mjs',${JSON.stringify(built)});`,
  }
  for (const [path, bytes] of Object.entries(files)) await writeFile(join(source, path), bytes)
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Synthetic actual CLI fixture']]) execFileSync('git', args, { cwd: source })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  const compiler = await buildCompilerFromPinnedSource({ root, directory: archive, checkout: join(root, 'producer-checkout'), source, commit,
    profile: 'compiler-fixture-v1', fixtureCommands: { install: [process.execPath, 'install.mjs'], build: [process.execPath, 'build.mjs'] },
    fixtureOutputDirectories: ['dist'], fixtureRequiredOutputs: ['dist/index.mjs'], keepCheckout: false })
  const compilerBuild = compiler.reference, checkout = join(root, 'consumer')
  const use = await materializeCompilerUse({ root, directory: join(root, 'consumer-archive'), checkout, compilerBuild, expectedCommit: commit, expectedProfile: 'compiler-fixture-v1' })
  const sealed = await sealCompilerUse({ context: use, caseId: 'ide-synthetic-static', sourceSha256: hash(caseSource), caseSourcePath: 'e2e/case.mjs' })
  if (observedCompanionContract) {
    // Only the actual spawn/environment contract is under test here. This
    // synthetic compiler has no reviewed insertion manifest, and this modified
    // test config cannot finalize a compiler-use or official receipt.
    const config = JSON.parse(await readFile(use.configPath, 'utf8'))
    const bytes = await readFile(new URL('./conformance-compiler-macro-observer.mjs', import.meta.url))
    const observerPath = join(use.directory, 'compiler-macro-observer.mjs')
    await writeFile(observerPath, bytes)
    config.macroObservation = { profile: 'pinned-json-macro-esm-v2-rolldown-runtime', observerPath,
      observer: archiveCompilerBuildBytes({ root, directory: use.directory, bytes }) }
    await writeFile(use.configPath, JSON.stringify(config))
  }
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(join(project, 'project.config.json'), JSON.stringify({ appid: 'touristappid', miniprogramRoot: 'dist/' }))
  for (const [path, bytes] of Object.entries(raw)) { await mkdir(join(project, 'src', path, '..'), { recursive: true }); await writeFile(join(project, 'src', path), bytes) }
  const context = { root, compilerBuild, expectedCommit: commit, expectedProfile: 'compiler-fixture-v1', caseId: 'ide-synthetic-static', sourceSha256: hash(caseSource), caseSourcePath: 'e2e/case.mjs' }
  const recorder = installStaticFixtureBuildRecorder({ ...context, directory: join(root, 'checkpoint'), compilerUseConfigPath: sealed.environment.WEAPP_CONTAINER_COMPILER_USE_CONFIG, fixtureCliPath: 'cli.mjs' })
  t.after(() => { if (!recorder.disposed) recorder.dispose() })
  const compile = async (args = [join(checkout, 'cli.mjs'), 'build', project], environment = { ...process.env, ...sealed.environment }, cwd = checkout, command = process.execPath, extraOptions = {}) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], ...extraOptions })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => accept({ exitCode, signal, pid: child.pid })) })
    return { ...result, stdout, stderr }
  }
  const runtime = () => ({ schemaVersion: 1, kind: 'wechat-devtools-runtime-baseline', status: 'passed', projectPath: project,
    recordedAt: new Date().toISOString(), installationId: 'a'.repeat(64), tool: { version: 'SYNTHETIC-TEST-ONLY', SDKVersion: 'SYNTHETIC-TEST-ONLY' }, system: { SDKVersion: 'SYNTHETIC-TEST-ONLY', platform: 'devtools' } })
  const put = value => archiveCompilerBuildBytes({ root, directory: join(root, 'mutation-archive'), bytes: typeof value === 'string' ? value : JSON.stringify(value) })
  const complete = async (environment, args, command = process.execPath) => {
    const processResult = await compile(args, environment, checkout, command); assert.equal(processResult.exitCode, 0, processResult.stderr)
    const observation = runtime(), checkpoint = await captureOfficialFixtureCheckpoint({ recorder, runtimeObservation: observation })
    await recorder.flush()
    recorder.dispose()
    const used = await finishCompilerUse({ context: use, processResult }); assert.equal(used.attestation.status, 'used', used.attestation.failure)
    const result = await finalizeStaticFixtureBuild({ ...context, directory: join(root, 'fixture-archive'), checkpoint, compilerUse: used.reference, fixtureId: 'actual-static-test' })
    return { ...result, compilerUse: used.reference, runtimeObservation: observation, checkpoint }
  }
  const inspect = (result, extra = {}) => inspectConformanceFixtureBuildEvidence({ ...context, reference: result.reference, compilerUse: result.compilerUse,
    fixture: result.fixtureValue, resources: result.resources, runtimeObservation: result.runtimeObservation, ...extra })
  return { ...context, project, checkout, use, recorder, compile, runtime, put, complete, inspect, environment: sealed.environment }
}

test('a rejected GitHub producer guard cannot retain the worker recorder ownership', async t => {
  const f = await fixture(t)
  f.recorder.dispose()
  const compilerUseConfigPath = f.environment.WEAPP_CONTAINER_COMPILER_USE_CONFIG
  const original = await readFile(compilerUseConfigPath, 'utf8'), config = JSON.parse(original)
  const github = { caseId: 'ide-github-issues-runtime-issue1012',
    sourceSha256: 'c91ec602d9bc78f722f5a3d4e4930e840f4227f8d567c0ee1c88063579bb67ff',
    caseSourcePath: 'e2e/ide/github-issues.runtime.issue1012.test.ts' }
  await writeFile(compilerUseConfigPath, JSON.stringify({ ...config, ...github }))
  assert.throws(() => installStaticFixtureBuildRecorder({ ...f, ...github, directory: join(f.root, 'rejected-github'),
    compilerUseConfigPath, fixtureCliPath: 'cli.mjs' }), /requires the pinned real compiler profile/)
  await writeFile(compilerUseConfigPath, original)
  const recorder = installStaticFixtureBuildRecorder({ ...f, directory: join(f.root, 'second-recorder'),
    compilerUseConfigPath, fixtureCliPath: 'cli.mjs' })
  recorder.dispose()
})

test('actual fresh CLI output of the opened project is packed by an archived reviewed packer and verifies offline', async t => {
  const f = await fixture(t), result = await f.complete()
  assert.equal(result.attestation.status, 'built', result.attestation.failure)
  assert.equal(result.fixtureValue.id, 'actual-static-test')
  assert.deepEqual(f.inspect(result).errors, [])
  const { schemaVersion, kind, status, ...rawObservation } = result.runtimeObservation
  assert.deepEqual(f.inspect(result, { runtimeObservation: rawObservation }).errors, [])
  await rm(f.project, { recursive: true }); await rm(join(f.root, 'fixture-archive/packer-executor'), { recursive: true })
  assert.deepEqual(f.inspect(result).errors, [])
})

test('isolated candidate: exact platform weapp and PATH node retain raw invocation and verify actual startup plus pack', async t => {
  const f = await fixture(t), args = [join(f.checkout, 'cli.mjs'), 'build', f.project, '--platform', 'weapp']
  const companion = await runCompanion(f)
  assert.equal(companion.result.exitCode, 0, companion.result.stderr)
  const result = await f.complete({ PATH: dirname(process.execPath) }, args, 'node')
  assert.equal(result.attestation.status, 'built', result.attestation.failure)
  const build = result.checkpoint.attestation.build
  assert.deepEqual(build.command, ['node', ...args])
  assert.deepEqual(build.runtimeArgv, [process.execPath, ...args])
  assert.equal(build.nodeResolution.method, 'path')
  assert.equal(build.nodeResolution.selected, process.execPath)
  assert.equal(build.nodeResolution.physical, realpathSync(process.execPath))
  assert.equal(build.nodeResolution.executable, realpathSync(process.execPath))
  assert.deepEqual(f.inspect(result).errors, [])
  const changed = structuredClone(result.attestation), checkpoint = structuredClone(result.checkpoint.attestation)
  checkpoint.build.runtimeArgv[0] = '/UNTRUSTED-NODE/selected-node'
  checkpoint.build.nodeResolution.selected = checkpoint.build.runtimeArgv[0]
  changed.checkpoint = f.put(checkpoint)
  assert.match(f.inspect(result, { reference: f.put(changed) }).errors[0], /actual root consumer executable/)
  for (const suffix of [['--platform', 'alipay'], ['--platform', 'tt'], ['--platform=weapp'], ['-p', 'weapp'],
    ['--platform', 'weapp', '--skipNpm'], ['--platform', 'weapp', '--platform', 'weapp']]) {
    const changed = structuredClone(result.attestation), checkpoint = structuredClone(result.checkpoint.attestation)
    checkpoint.build.command = [...build.command.slice(0, 4), ...suffix]
    checkpoint.build.runtimeArgv = [...build.runtimeArgv.slice(0, 4), ...suffix]
    changed.checkpoint = f.put(checkpoint)
    assert.match(f.inspect(result, { reference: f.put(changed) }).errors[0], /supported pinned static CLI\/project/)
  }
})

test('isolated candidate: other platforms, aliases, ordering and extra flags remain unsupported actual invocations', async t => {
  const variants = [
    ['--platform', 'alipay'], ['--platform', 'tt'], ['--platform', 'web'], ['--platform=weapp'], ['-p', 'weapp'],
    ['--platform', 'weapp', '--skipNpm'], ['--platform', 'weapp', '--sourcemap'],
    ['--platform', 'weapp', '--config', 'other.mjs'], ['--platform', 'weapp', '--project-config', 'other.json'],
    ['--platform', 'weapp', '--platform', 'weapp'], ['--', '--platform', 'weapp'],
  ]
  for (const suffix of variants) {
    const f = await fixture(t), args = [join(f.checkout, 'cli.mjs'), 'build', f.project, ...suffix]
    const result = await f.compile(args, { PATH: dirname(process.execPath) }, f.checkout, 'node')
    assert.equal(result.exitCode, 0, result.stderr)
    await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /no unique/)
    assert.equal(f.recorder.builds[0].status, 'blocked')
    assert.equal(f.recorder.builds[0].environment, undefined)
    assert.deepEqual(f.recorder.builds[0].command, ['node', ...args])
    f.recorder.dispose()
  }
  const f = await fixture(t)
  await f.compile([join(f.checkout, 'cli.mjs'), 'build', '--platform', 'weapp', f.project], { PATH: dirname(process.execPath) }).catch(() => {})
  await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /no unique/)
  assert.equal(f.recorder.builds[0].status, 'blocked')
  f.recorder.dispose()
})

test('isolated candidate: foreign PATH node, executable names, shells and argv0 aliases stay blocked without changing child results', async t => {
  for (const variant of ['foreign-path', 'name-alias', 'shell', 'argv0', 'missing-path']) {
    const f = await fixture(t), args = [join(f.checkout, 'cli.mjs'), 'build', f.project, '--platform', 'weapp']
    let command = 'node', environment = { PATH: dirname(process.execPath) }, extraOptions = {}
    if (variant === 'foreign-path') {
      const directory = join(f.root, 'untrusted-bin'); await mkdir(directory)
      await writeFile(join(directory, 'node'), '#!/bin/sh\nexit 0\n'); await chmod(join(directory, 'node'), 0o755)
      environment = { PATH: directory }
    } else if (variant === 'name-alias') {
      const directory = join(f.root, 'alias-bin'); await mkdir(directory)
      await symlink(process.execPath, join(directory, 'nodejs'))
      command = 'nodejs'; environment = { PATH: directory }
    } else if (variant === 'shell') { command = process.execPath; extraOptions = { shell: true } }
    else if (variant === 'argv0') { command = process.execPath; extraOptions = { argv0: 'untrusted-node-alias' } }
    else environment = {}
    const result = await f.compile(args, environment, f.checkout, command, extraOptions).catch(error => ({ spawnError: error }))
    if (variant !== 'missing-path') assert.equal(result.exitCode, 0, result.stderr)
    await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /no unique/)
    assert.equal(f.recorder.builds[0].status, 'blocked')
    assert.equal(f.recorder.builds[0].environment, undefined)
    assert.deepEqual(f.recorder.builds[0].command, [command, ...args])
    f.recorder.dispose()
  }
})

test('isolated candidate: byte-identical copied snapshot cannot replace the actual built project identity', async t => {
  const f = await fixture(t), args = [join(f.checkout, 'cli.mjs'), 'build', f.project, '--platform', 'weapp']
  const result = await f.compile(args, { PATH: dirname(process.execPath) }, f.checkout, 'node')
  assert.equal(result.exitCode, 0, result.stderr)
  await Promise.all(f.recorder.pending)
  const snapshot = join(f.root, 'owned-snapshot-copy'); await cp(f.project, snapshot, { recursive: true })
  const observation = { ...f.runtime(), projectPath: snapshot }
  await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: observation }), /no unique/)
  assert.equal(f.recorder.builds[0].status, 'built')
  assert.equal(f.recorder.builds[0].projectPath, f.project)
  f.recorder.dispose()
})

test('preexisting generated output, another project and unproved HMR/watch checkpoints stay blocked', async t => {
  for (const variant of ['retained-output', 'other-project', 'hmr']) {
    const f = await fixture(t)
    if (variant === 'retained-output') await mkdir(join(f.project, 'dist'))
    const processResult = await f.compile(); assert.equal(processResult.exitCode, 0, processResult.stderr)
    const observation = f.runtime()
    if (variant === 'other-project') {
      const other = join(f.root, 'other-project'); await mkdir(other)
      await writeFile(join(other, 'project.config.json'), JSON.stringify({ miniprogramRoot: 'dist/' })); observation.projectPath = other
    }
    await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: observation, checkpointId: variant === 'hmr' ? 'hmr-next-generation' : 'static-initial' }), /static|generation|project/i)
    assert.equal(JSON.parse(await readFile(join(f.root, 'checkpoint/static-checkpoint.json'))).status, 'blocked')
    f.recorder.dispose()
  }
})

test('changed generated file or opened project config cannot reuse the successful CLI checkpoint', async t => {
  for (const variant of ['output', 'project-config']) {
    const f = await fixture(t), processResult = await f.compile(); assert.equal(processResult.exitCode, 0)
    await Promise.all(f.recorder.pending)
    await writeFile(join(f.project, variant === 'output' ? 'dist/app.js' : 'project.config.json'), variant === 'output' ? 'App({unrelated:true});' : JSON.stringify({ miniprogramRoot: 'other/' }))
    await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /differs|no unique/)
    f.recorder.dispose()
  }
})

test('valid compiler use plus an unrelated hand-authored recipe pack or resource cannot pass', async t => {
  const f = await fixture(t), result = await f.complete(); assert.equal(result.attestation.status, 'built', result.attestation.failure)
  const unrelated = structuredClone(result.fixtureValue); unrelated.id = 'unrelated-pack'
  assert.match(f.inspect(result, { fixture: unrelated }).errors[0], /unrelated hand-authored fixture/)
  const resources = structuredClone(result.resources), first = Object.keys(resources)[0]
  resources[first] = f.put('unrelated blob')
  assert.match(f.inspect(result, { resources }).errors[0], /different blob/)
  assert.notDeepEqual(f.inspect(result, { expectedCommit: 'f'.repeat(40) }).errors, [])
})

test('offline reader rejects different CLI pid, runtime installation, capture generation, packer and consumed inputs', async t => {
  const f = await fixture(t), result = await f.complete(); assert.equal(result.attestation.status, 'built', result.attestation.failure)
  for (const mutate of [
    a => { a.caseId = 'ide-other' },
    a => { a.packer.run.pid++ },
    a => { a.packer.command[a.packer.command.length - 1] = 'f'.repeat(40) },
    a => { a.packer.modules.pop() },
    a => { a.after = f.put('[]') },
    a => { const summary = JSON.parse(readFileSync(join(f.root, a.recorderSummary.path))); summary.observedCliSpawns = 2; a.recorderSummary = f.put(summary) },
    a => { a.fixture = f.put(JSON.stringify({ ...result.fixtureValue, manifest: { ...result.fixtureValue.manifest, compiler: { commit: 'f'.repeat(40) } } })) },
    a => { const c = JSON.parse(readFileSync(join(f.root, a.checkpoint.path))); c.build.pid++; a.checkpoint = f.put(c) },
    a => { const c = JSON.parse(readFileSync(join(f.root, a.checkpoint.path))); c.checkpointId = 'hmr-next-generation'; a.checkpoint = f.put(c) },
    a => { const c = JSON.parse(readFileSync(join(f.root, a.checkpoint.path))); const r = JSON.parse(readFileSync(join(f.root, c.runtimeObservation.path))); r.installationId = 'b'.repeat(64); c.runtimeObservation = f.put(r); a.checkpoint = f.put(c) },
  ]) {
    const value = structuredClone(result.attestation); mutate(value)
    assert.notDeepEqual(f.inspect(result, { reference: f.put(value) }).errors, [])
  }
})

test('only an exact recognized static CLI receives the controlled consumer environment after upstream sanitization', async t => {
  const f = await fixture(t), processResult = await f.compile(undefined, { PATH: process.env.PATH })
  assert.equal(processResult.exitCode, 0, processResult.stderr)
  const checkpoint = await captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  await f.recorder.flush()
  f.recorder.dispose()
  const used = await finishCompilerUse({ context: f.use, processResult })
  assert.equal(used.attestation.status, 'used', used.attestation.failure)
  assert.equal(checkpoint.attestation.build.environment.NODE_OPTIONS, used.attestation.nodeOptions)
})

test('later CLI build/watch and postcheckpoint edits invalidate the static proof while normal cleanup is supported', async t => {
  for (const action of ['second-build', 'watch', 'edit', 'cleanup']) {
    const f = await fixture(t), processResult = await f.compile()
    const checkpoint = await captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
    if (action === 'second-build') await f.compile()
    else if (action === 'watch') await f.compile([join(f.checkout, 'cli.mjs'), 'dev', f.project])
    else if (action === 'edit') await writeFile(join(f.project, 'dist/app.js'), 'App({changedAfterCheckpoint:true});')
    else await rm(f.project, { recursive: true })
    const summary = await flushStaticFixtureBuildRecorder({ recorder: f.recorder })
    f.recorder.dispose()
    assert.equal(summary.attestation.status, action === 'cleanup' ? 'complete' : 'blocked')
    const used = await finishCompilerUse({ context: f.use, processResult })
    if (action === 'cleanup') {
      const result = await finalizeStaticFixtureBuild({ ...f, directory: join(f.root, 'fixture-archive'), checkpoint, recorderSummary: summary, compilerUse: used.reference })
      assert.equal(result.attestation.status, 'built', result.attestation.failure)
    } else await assert.rejects(finalizeStaticFixtureBuild({ ...f, directory: join(f.root, 'fixture-archive'), checkpoint, recorderSummary: summary, compilerUse: used.reference }), /summary|consumer/)
  }
})

test('test-only synthetic helper exercises the same reader without replacing actual compiler/packer tests', async t => {
  const f = await fixture(t), actual = await f.complete()
  assert.equal(actual.attestation.status, 'built', actual.attestation.failure)
  const synthetic = createSyntheticFixtureBuild({ ...f, directory: join(f.root, 'SYNTHETIC-OFFLINE-READER-ONLY'), compilerUse: actual.compilerUse,
    fixture: actual.fixture, resources: actual.resources, runtimeObservation: actual.runtimeObservation, fixtureCliPath: 'cli.mjs' })
  assert.deepEqual(f.inspect({ ...actual, ...synthetic, runtimeObservation: actual.runtimeObservation }).errors, [])
  assert.notEqual(synthetic.compilerUse.sha256, actual.compilerUse.sha256)
  assert.match(synthetic.attestation.packer.executor, /SYNTHETIC-NOT-EXECUTED/)
})

test('foreign child preload cannot be silently replaced and accepted as a static build', async t => {
  const f = await fixture(t)
  const processResult = await f.compile(undefined, { PATH: process.env.PATH, NODE_OPTIONS: '--import=node:fs' })
  assert.equal(processResult.exitCode, 0)
  await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /no unique|static CLI/)
  const summary = await f.recorder.flush(); f.recorder.dispose()
  assert.equal(summary.attestation.status, 'blocked')
  assert.match(summary.attestation.actions[0].failure, /unreviewed NODE_OPTIONS/)
})

test('only seven newly generated regular support files may extend unchanged original inputs', async t => {
  const f = await fixture(t), result = await f.complete({ ...process.env, ...f.environment, STATIC_TEST_SUPPORT: 'approved' })
  assert.equal(result.attestation.status, 'built', result.attestation.failure)
  assert.equal(result.checkpoint.attestation.build.generatedSupport.length, 7)
  assert.deepEqual(f.inspect(result).errors, [])
  for (const mutate of [
    c => c.build.generatedSupport.pop(),
    c => { const item = { path: '.weapp-vite/unreviewed.js', kind: 'file', artifact: f.put('unreviewed') }; c.build.sourceAfter.push(item); c.build.generatedSupport.push(item) },
    c => { c.build.sourceAfter.find(item => item.path === 'src/app.js').artifact = f.put('changed original') },
    c => { c.build.generatedSupport[0].kind = 'consumer-link' },
  ]) {
    const a = structuredClone(result.attestation), c = structuredClone(result.checkpoint.attestation); mutate(c); a.checkpoint = f.put(c)
    assert.notDeepEqual(f.inspect(result, { reference: f.put(a) }).errors, [])
  }
})

test('extra support paths, changed original inputs, preexisting support rewrites and support symlinks are blocked', async t => {
  for (const variant of ['extra', 'original', 'preexisting', 'symlink']) {
    const f = await fixture(t)
    if (variant === 'preexisting') await writeFile(join(f.project, 'tsconfig.json'), '{"original":true}')
    const processResult = await f.compile(undefined, { ...process.env, ...f.environment, STATIC_TEST_SUPPORT: variant })
    assert.equal(processResult.exitCode, 0, processResult.stderr)
    await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /no unique|static CLI/)
    assert.match(f.recorder.builds[0].failure, /mutated|unreviewed support|unbound symlink/)
    f.recorder.dispose()
  }
})

test('the exact pinned typed-router declaration may extend unchanged originals and remains independently verified', async t => {
  const f = await fixture(t), result = await f.complete({ ...process.env, ...f.environment, STATIC_TEST_SUPPORT: 'typed-router' })
  assert.equal(result.attestation.status, 'built', result.attestation.failure)
  const support = result.checkpoint.attestation.build.generatedSupport
  assert.equal(support.length, 8)
  assert.equal(support.filter(item => item.path === '.weapp-vite/typed-router.d.ts' && item.kind === 'file').length, 1)
  assert.deepEqual(f.inspect(result).errors, [])
  const a = structuredClone(result.attestation), c = structuredClone(result.checkpoint.attestation)
  const item = { path: '.weapp-vite/typed-router-extra.d.ts', kind: 'file', artifact: f.put('export type Unreviewed = true;') }
  c.build.sourceAfter.push(item); c.build.generatedSupport.push(item); a.checkpoint = f.put(c)
  assert.match(f.inspect(result, { reference: f.put(a) }).errors[0], /unreviewed support/)
})

test('an adjacent arbitrary declaration file remains blocked by the actual static observer', async t => {
  const f = await fixture(t)
  const processResult = await f.compile(undefined, { ...process.env, ...f.environment, STATIC_TEST_SUPPORT: 'adjacent-dts' })
  assert.equal(processResult.exitCode, 0, processResult.stderr)
  await assert.rejects(captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }), /no unique|static CLI/)
  assert.match(f.recorder.builds[0].failure, /unreviewed support/)
  f.recorder.dispose()
})

async function runCompanion(f, project = join(f.checkout, '.tmp/e2e-ide-hmr-companion/case.mjs')) {
  await cp(f.project, project, { recursive: true })
  const result = await f.compile([join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'], { PATH: process.env.PATH }, project)
  await rm(project, { recursive: true, force: true })
  return { project, result }
}

test('an observed compiler companion restores its exact owned loader after upstream environment sanitization', async t => {
  const f = await fixture(t, { observedCompanionContract: true })
  const project = join(f.checkout, '.tmp/e2e-ide-hmr-companion/case.mjs')
  await cp(f.project, project, { recursive: true })
  const result = await f.compile([join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'], {
    PATH: process.env.PATH, WEAPP_CONTAINER_COMPILER_FIXTURE_INPUTS: 'stale target closure must not reach companion',
  }, project)
  assert.equal(result.exitCode, 0, result.stderr)
  const action = f.recorder.builds[0]
  assert.equal(action.action, 'companion-dev')
  assert.equal(action.status, 'closed')
  assert.deepEqual(action.environment, f.environment)
  assert.equal(action.fixtureInputClosure, undefined)
  const events = (await readFile(join(f.use.logDirectory, `${result.pid}-0.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events[0].argv, [process.execPath, join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'])
  assert.equal(events[0].nodeOptions, f.environment.NODE_OPTIONS)
  assert.equal(events[0].fixtureInputClosure, undefined)
  assert.ok(events.some(event => event.kind === 'load' && event.classification === 'observation-helper'))
  assert.ok(events.some(event => event.kind === 'resolve' && event.specifier === 'weapp-container:conformance-observer-v1'))
  assert.equal(events.at(-1).observerFailed, false)
  await rm(project, { recursive: true })
  const target = await f.compile()
  assert.equal(target.exitCode, 0, target.stderr)
  await captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  const summary = await f.recorder.flush()
  assert.equal(summary.attestation.status, 'complete', summary.attestation.failure)
  assert.equal(summary.attestation.actions.length, 2)
  // Live cleanup proof precedes sealed compiler-use validation. This tiny
  // synthetic profile still cannot finalize an official macro receipt.
})

test('the companion loader restoration cannot authorize a foreign preload or another project', async t => {
  for (const foreign of ['preload', 'project']) {
    const f = await fixture(t, { observedCompanionContract: true })
    const project = join(f.checkout, '.tmp/e2e-ide-hmr-companion', foreign === 'project' ? 'unrelated.mjs' : 'case.mjs')
    await cp(f.project, project, { recursive: true })
    const result = await f.compile([join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'], {
      PATH: process.env.PATH, ...(foreign === 'preload' ? { NODE_OPTIONS: '--require=/NOT-OWNED/preload.cjs' } : {}),
    }, project)
    assert.notEqual(result.exitCode, 0)
    assert.equal(f.recorder.builds[0].status, 'blocked')
    assert.equal(f.recorder.builds[0].environment, undefined)
    await rm(project, { recursive: true })
    f.recorder.dispose()
  }
})

test('a closed removed exact owned companion is separately archived and cannot replace the target static build', async t => {
  const f = await fixture(t), companion = await runCompanion(f)
  assert.equal(companion.result.exitCode, 0, companion.result.stderr)
  const result = await f.complete()
  assert.equal(result.attestation.status, 'built', result.attestation.failure)
  assert.deepEqual(f.inspect(result).errors, [])
  const summary = JSON.parse(readFileSync(join(f.root, result.attestation.recorderSummary.path)))
  assert.equal(summary.observedCliSpawns, 2)
  assert.equal(summary.actions[0].action, 'companion-dev')
  assert.equal(summary.actions[0].projectRemoved, true)
  for (const mutate of [
    a => { a.actions[0].projectPath += '-foreign' },
    a => { a.actions[0].projectRemoved = false },
    a => { a.actions[0].status = 'running' },
    a => { a.actions[0].endedAt = a.actions[1].endedAt },
    a => { delete a.actions[0].projectRemovedBeforeTargetAt },
    a => { a.actions[0].signal = 'SIGKILL'; a.actions[0].exitCode = null },
    a => { a.actions[0].command[2] = 'build' },
    a => { a.actions[0].sourceBefore.push({ path: 'target-link', kind: 'consumer-link', target: '.tmp/project', consumerGuard: result.checkpoint.attestation.consumerGuard }) },
    a => { a.actions.push(a.actions[1]); a.observedCliSpawns++ },
  ]) {
    const a = structuredClone(result.attestation), changed = structuredClone(summary); mutate(changed); a.recorderSummary = f.put(changed)
    assert.notDeepEqual(f.inspect(result, { reference: f.put(a) }).errors, [])
  }
})

test('owned SIGTERM cleanup binds actual process and child signals to numeric and signalled exits', async t => {
  for (const variant of ['process-numeric', 'child-numeric', 'process-signal']) {
    const f = await fixture(t), project = join(f.checkout, '.tmp/e2e-ide-hmr-companion/case.mjs')
    await cp(f.project, project, { recursive: true })
    const child = spawn(process.execPath, [join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'], {
      cwd: project, env: { PATH: process.env.PATH, STATIC_TEST_HOLD: '1', ...(variant.endsWith('numeric') ? { STATIC_TEST_TERM_EXIT: '1' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })))
    try {
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
      assert.equal(variant.startsWith('child') ? child.kill('SIGTERM') : process.kill(child.pid, 'SIGTERM'), true)
      assert.deepEqual(await closed, variant.endsWith('numeric') ? { exitCode: 143, signal: null } : { exitCode: null, signal: 'SIGTERM' })
      await rm(project, { recursive: true })
      const result = await f.complete()
      assert.equal(result.attestation.status, 'built', result.attestation.failure)
      assert.deepEqual(f.inspect(result).errors, [])
      const summary = JSON.parse(readFileSync(join(f.root, result.attestation.recorderSummary.path)))
      assert.equal(summary.actions[0].cleanupRequests.length, 1)
      assert.equal(summary.actions[0].cleanupRequests[0].pid, child.pid)
      assert.equal(summary.actions[0].cleanupRequests[0].via, variant.startsWith('child') ? 'child.kill' : 'process.kill')
      for (const mutate of [
        a => { delete a.cleanupRequests },
        a => { a.cleanupRequests[0].pid++ },
        a => { a.cleanupRequests[0].success = false },
        a => { a.cleanupRequests[0].signal = 'SIGKILL' },
        a => { a.cleanupRequests[0].observer.pid++ },
        a => { a.cleanupRequests[0].via = 'inferred-exit-code' },
        a => { a.cleanupRequests[0].requestedAt = new Date(Date.parse(a.endedAt) - 4_001).toISOString() },
        a => { a.cleanupRequests[0].completedAt = new Date(Date.parse(a.endedAt) + 1).toISOString() },
      ]) {
        const changed = structuredClone(summary), attestation = structuredClone(result.attestation)
        mutate(changed.actions[0]); attestation.recorderSummary = f.put(changed)
        assert.notDeepEqual(f.inspect(result, { reference: f.put(attestation) }).errors, [])
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed }
      f.recorder.dispose()
    }
  }
})

test('numeric SIGTERM-like exit without an observed owned cleanup request stays blocked', async t => {
  const f = await fixture(t), project = join(f.checkout, '.tmp/e2e-ide-hmr-companion/case.mjs')
  await cp(f.project, project, { recursive: true })
  const result = await f.compile([join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'], { PATH: process.env.PATH, STATIC_TEST_EXIT_143: '1' }, project)
  assert.equal(result.exitCode, 143)
  assert.equal(f.recorder.builds[0].status, 'blocked')
  assert.deepEqual(f.recorder.builds[0].cleanupRequests, [])
  assert.match(f.recorder.builds[0].failure, /observed bounded owned SIGTERM/)
  await rm(project, { recursive: true })
  await f.compile()
  await captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
  assert.equal((await f.recorder.flush()).attestation.status, 'blocked')
  f.recorder.dispose()
})

test('foreign or still present companions and companion actions after target compilation remain blocked', async t => {
  for (const variant of ['foreign', 'not-removed', 'late-removal', 'after-target']) {
    const f = await fixture(t)
    if (variant === 'after-target') await f.compile()
    const project = join(f.checkout, '.tmp/e2e-ide-hmr-companion', variant === 'foreign' ? 'another-case.mjs' : 'case.mjs')
    await cp(f.project, project, { recursive: true, filter: path => !path.includes('/dist') })
    await f.compile([join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'], { PATH: process.env.PATH }, project)
    if (!['not-removed', 'late-removal'].includes(variant)) await rm(project, { recursive: true, force: true })
    if (variant !== 'after-target') await f.compile()
    if (variant === 'late-removal') await rm(project, { recursive: true, force: true })
    try { await captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() }) } catch {}
    const summary = await f.recorder.flush(); f.recorder.dispose()
    assert.equal(summary.attestation.status, 'blocked', variant)
    assert.match(summary.attestation.failure, /companion|action|target/i)
  }
})

test('a live companion never blocks checkpoint forever and cannot satisfy terminal cleanup', async t => {
  const f = await fixture(t), project = join(f.checkout, '.tmp/e2e-ide-hmr-companion/case.mjs')
  await cp(f.project, project, { recursive: true })
  const child = spawn(process.execPath, [join(f.checkout, 'cli.mjs'), 'dev', '--non-interactive'], {
    cwd: project, env: { PATH: process.env.PATH, STATIC_TEST_HOLD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    await f.compile()
    await captureOfficialFixtureCheckpoint({ recorder: f.recorder, runtimeObservation: f.runtime() })
    const summary = await f.recorder.flush()
    assert.equal(summary.attestation.status, 'blocked')
    assert.match(summary.attestation.failure, /companion/)
  } finally { child.kill('SIGTERM'); await closed; f.recorder.dispose() }
})
