import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { archiveCompilerBuildBytes, buildCompilerFromPinnedSource } from './conformance-compiler-build.mjs'
import { materializeCompilerUse, forkCompilerUse, sealCompilerUse, finishCompilerUse, inspectCompilerUseEvidence, createCompilerUseBuildCache, verifyCompilerBridgeProjects } from './conformance-compiler-use.mjs'
import { createSyntheticCompilerUse } from './fixtures/conformance-compiler-use.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const sourceText = "import '../dist/index.mjs';\n"
async function fixture(t, { runner = sourceText, output = "import {value} from 'fixture-external'; console.log(value);\n", sourceRepo = false, extraSource = {}, installAddendum = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conformance-compiler-use-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  await mkdir(join(source, 'e2e'), { recursive: true })
  const files = {
    '.gitignore': 'node_modules/\ndist/\n',
    'package.json': JSON.stringify({ name: 'synthetic-consumer-test', type: 'module', packageManager: `node@${process.versions.node}`, dependencies: { 'fixture-external': '1.0.0' } }),
    'fixture-lock.json': '{}',
    'e2e/case.mjs': runner,
    'e2e/worker.mjs': sourceText,
    'install.mjs': `import{mkdir,writeFile}from'node:fs/promises';await mkdir('node_modules/fixture-external',{recursive:true});await writeFile('node_modules/fixture-external/package.json',JSON.stringify({name:'fixture-external',version:'1.0.0',type:'module',exports:'./index.mjs'}));await writeFile('node_modules/fixture-external/index.mjs','export const value="fresh";');`,
    'build.mjs': `import{mkdir,writeFile}from'node:fs/promises';await mkdir('dist');await writeFile('dist/index.mjs',${JSON.stringify(output)});`,
    ...extraSource,
  }
  files['install.mjs'] += installAddendum
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(source, path, '..'), { recursive: true })
    await writeFile(join(source, path), bytes)
  }
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Synthetic consumer test']]) execFileSync('git', args, { cwd: source })
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  const result = await buildCompilerFromPinnedSource({ root, source, commit, directory: join(root, 'build-archive'), checkout: join(root, 'build-checkout'),
    profile: 'compiler-fixture-v1', fixtureCommands: { install: [process.execPath, 'install.mjs'], build: [process.execPath, 'build.mjs'] },
    fixtureOutputDirectories: ['dist'], fixtureRequiredOutputs: ['dist/index.mjs'], keepCheckout: false })
  const options = { root, directory: join(root, 'consumer-archive'), checkout: join(root, 'execution'), compilerBuild: result.reference,
    expectedCommit: commit, expectedProfile: 'compiler-fixture-v1', ...(sourceRepo ? { sourceRepo: source } : {}) }
  const context = await materializeCompilerUse(options)
  const seal = extra => sealCompilerUse({ context, caseId: 'ide-synthetic-consumer', caseSourcePath: 'e2e/case.mjs', sourceSha256: digest(runner), ...extra })
  const inspect = reference => inspectCompilerUseEvidence({ ...options, reference, caseId: 'ide-synthetic-consumer', sourceSha256: digest(runner) })
  const put = bytes => archiveCompilerBuildBytes({ root, directory: join(root, 'consumer-archive'), bytes })
  return { ...options, checkout: context.checkout, context, seal, inspect, put, runner }
}
async function child(f, environment, args = [join(f.checkout, 'e2e/case.mjs')]) {
  const child = spawn(process.execPath, args, { cwd: f.checkout, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal, pid: child.pid })) })
  return { ...result, stdout, stderr }
}
async function execute(f, args) {
  const sealed = await f.seal()
  const processResult = await child(f, sealed.environment, args)
  return { processResult, ...await finishCompilerUse({ context: f.context, processResult }) }
}

test('fresh archived compiler is actually loaded, with optional pinned Git metadata, and remains offline-verifiable', async t => {
  for (const sourceRepo of [false, true]) {
    const f = await fixture(t, { sourceRepo }), result = await execute(f)
    assert.equal(result.processResult.exitCode, 0, result.processResult.stderr)
    assert.match(result.processResult.stdout, /fresh/)
    assert.equal(result.attestation.status, 'used', result.attestation.failure)
    assert.deepEqual(f.inspect(result.reference).errors, [])
    await rm(f.checkout, { recursive: true })
    assert.deepEqual(f.inspect(result.reference).errors, [])
    assert.match(inspectCompilerUseEvidence({ ...f, reference: result.reference, caseId: 'ide-synthetic-consumer', sourceSha256: digest(f.runner), expectedProfile: undefined }).errors[0], /unapproved build profile/)
  }
})

test('valid producer plus retained dist, mutated dependency or extra old chunk is rejected before execution', async t => {
  for (const [path, value] of [['dist/index.mjs', 'console.log("retained")'], ['node_modules/fixture-external/index.mjs', 'export const value="retained";'], ['dist/retained.mjs', 'old extra chunk']]) {
    const f = await fixture(t)
    await writeFile(join(f.checkout, path), value)
    await assert.rejects(f.seal(), /changed|Unarchived/)
  }
})

test('actual child that never loads the compiler cannot finalize a consumer witness', async t => {
  const f = await fixture(t), result = await execute(f, ['--input-type=module', '-e', 'console.log("no compiler")'])
  assert.equal(result.processResult.exitCode, 0)
  assert.equal(result.attestation.status, 'failed')
  assert.match(result.attestation.failure, /never actually loaded/)
})

test('external retained compiler cannot accompany a valid build', async t => {
  const f = await fixture(t)
  const external = join(f.root, 'retained.mjs')
  await writeFile(external, 'console.log("unverified old dist");')
  const result = await execute(f, [external])
  assert.equal(result.attestation.status, 'failed')
  assert.match(result.attestation.failure, /unbound module/)
})

test('worker threads and spawned CLI children inherit the same actual execution witness', async t => {
  for (const runner of [
    "import{Worker}from'node:worker_threads';await new Promise((resolve,reject)=>{const worker=new Worker(new URL('./worker.mjs',import.meta.url));worker.on('error',reject);worker.on('exit',code=>code?reject(new Error(String(code))):resolve());});",
    "import{spawn}from'node:child_process';await new Promise((resolve,reject)=>{const c=spawn(process.execPath,[new URL('./worker.mjs',import.meta.url).pathname],{stdio:'inherit'});c.on('error',reject);c.on('exit',code=>code?reject(new Error(String(code))):resolve());});",
  ]) {
    const f = await fixture(t, { runner }), result = await execute(f)
    assert.equal(result.processResult.exitCode, 0, result.processResult.stderr)
    assert.equal(result.attestation.status, 'used', result.attestation.failure)
    assert.deepEqual(f.inspect(result.reference).errors, [])
  }
})

test('postexecution output/dependency mutation and input symlink escape fail closed', async t => {
  for (const variant of ['output', 'dependency', 'link']) {
    const f = await fixture(t), sealed = await f.seal()
    const processResult = await child(f, sealed.environment)
    if (variant === 'link') {
      const path = join(f.checkout, 'node_modules/fixture-external/index.mjs')
      await rm(path); await symlink(join(f.root, 'source/e2e/case.mjs'), path)
    } else await writeFile(join(f.checkout, variant === 'output' ? 'dist/index.mjs' : 'node_modules/fixture-external/index.mjs'), 'changed after actual load')
    const result = await finishCompilerUse({ context: f.context, processResult })
    assert.equal(result.attestation.status, 'failed')
    assert.match(result.attestation.failure, /changed/)
  }
})

test('reviewed runner patch is explicit, while indexed assertions/compiler sources cannot be patched', async t => {
  const f = await fixture(t)
  await mkdir(join(f.checkout, 'e2e/utils'))
  await writeFile(join(f.checkout, 'e2e/utils/conformanceEvidence.mjs'), 'export const helper=true;')
  const sealed = await f.seal({ patches: ['e2e/utils/conformanceEvidence.mjs'] })
  const processResult = await child(f, sealed.environment)
  const result = await finishCompilerUse({ context: f.context, processResult })
  assert.equal(result.attestation.status, 'used', result.attestation.failure)
  for (const path of ['e2e/case.mjs', 'build.mjs', 'dist/index.mjs', 'node_modules/fixture-external/index.mjs']) {
    const other = await fixture(t)
    await assert.rejects(other.seal({ patches: [path] }), /protected/)
  }
})

test('missing loader and unrelated process logs cannot stand in for the actual child', async t => {
  const f = await fixture(t), sealed = await f.seal()
  const processResult = await child(f, sealed.environment)
  const result = await finishCompilerUse({ context: f.context, processResult: { ...processResult, pid: processResult.pid + 1000000 } })
  assert.equal(result.attestation.status, 'failed')
  assert.match(result.attestation.failure, /unrelated/)
  const other = await fixture(t), missing = await execute(other, ['--input-type=module', '-e', 'console.log("no load")'])
  assert.equal(missing.attestation.status, 'failed')
})

test('archived consumer identity, loader source, output guards and case bindings are checked offline', async t => {
  const f = await fixture(t), result = await execute(f)
  assert.equal(result.attestation.status, 'used', result.attestation.failure)
  for (const mutate of [
    a => { a.caseId = 'ide-other' }, a => { a.sourceSha256 = 'f'.repeat(64) },
    a => { a.compilerBuild = { ...a.compilerBuild, sha256: 'f'.repeat(64) } },
    a => { a.preload = f.put('unreviewed preload') }, a => { a.after = f.put('{}') },
    a => { a.logs = [] }, a => { a.process.exitCode = 7 },
    a => { a.nodeOptions = '--import="/unknown.mjs"' },
  ]) {
    const changed = structuredClone(result.attestation); mutate(changed)
    assert.notDeepEqual(f.inspect(f.put(JSON.stringify(changed))).errors, [])
  }
})

test('offline consumer rejects undeclared or unsupported output policy and forged markers in every load classification', async t => {
  const f = await fixture(t), result = await execute(f)
  assert.equal(result.attestation.status, 'used', result.attestation.failure)
  const archive = value => f.put(JSON.stringify(value))
  const config = JSON.parse(readFileSync(join(f.root, result.attestation.config.path)))
  for (const outputLoadPolicy of ['unreviewed', 'sealed-esm-v1']) {
    const changed = structuredClone(result.attestation)
    changed.config = archive({ ...config, outputLoadPolicy })
    assert.match(f.inspect(archive(changed)).errors[0], /unsupported sealed output load policy/)
  }
  const events = readFileSync(join(f.root, result.attestation.logs[0].path), 'utf8').trim().split('\n').map(JSON.parse)
  const startup = structuredClone(events); startup[0].outputLoadPolicy = 'sealed-esm-v1'
  const changedStartup = structuredClone(result.attestation); changedStartup.logs[0] = f.put(startup.map(event => JSON.stringify(event)).join('\n') + '\n')
  assert.match(f.inspect(archive(changedStartup)).errors[0], /startup output load policy differs/)
  for (const classification of ['bound', 'unbound', 'observation-helper', 'runner']) {
    const altered = structuredClone(events), event = altered.find(event => event.kind === 'load' && event.path === 'dist/index.mjs')
    event.classification = classification; event.outputLoadPolicy = 'sealed-esm-v1'
    const changed = structuredClone(result.attestation); changed.logs[0] = f.put(altered.map(event => JSON.stringify(event)).join('\n') + '\n')
    assert.match(f.inspect(archive(changed)).errors[0], /raw ESM load is outside its sealed output policy/)
  }
})

test('allowed helper modules are archived exact runner-inputs bytes, not arbitrary vendor escape roots', async t => {
  const f = await fixture(t), runnerInputs = join(f.root, 'run/runner-inputs')
  await mkdir(runnerInputs, { recursive: true })
  await writeFile(join(runnerInputs, 'helper.mjs'), 'export const helper=1;')
  const sealed = await f.seal({ allowedModuleRoots: [runnerInputs] })
  const processResult = await child(f, sealed.environment)
  await writeFile(join(runnerInputs, 'helper.mjs'), 'changed helper')
  const result = await finishCompilerUse({ context: f.context, processResult })
  assert.equal(result.attestation.status, 'failed')
  assert.match(result.attestation.failure, /runner input changed/)
  const other = await fixture(t)
  await assert.rejects(other.seal({ allowedModuleRoots: [join(other.root, 'source')] }), /runner-inputs/)
})

test('each serialized case can fork an owned compiler checkout with independent loader logs', async t => {
  const f = await fixture(t)
  for (const directory of ['case-one', 'case-two']) {
    const context = forkCompilerUse({ context: f.context, directory: join(f.root, directory) })
    const sealed = await sealCompilerUse({ context, caseId: 'ide-synthetic-consumer', caseSourcePath: 'e2e/case.mjs', sourceSha256: digest(f.runner) })
    const processResult = await child(f, sealed.environment)
    const result = await finishCompilerUse({ context, processResult })
    assert.equal(result.attestation.status, 'used', result.attestation.failure)
    assert.deepEqual(f.inspect(result.reference).errors, [])
  }
  assert.equal(f.context.state, 'materialized')
})

test('a child cannot select another preload even when the fresh compiler was loaded', async t => {
  const f = await fixture(t)
  const result = await execute(f, ['--import=node:fs', join(f.checkout, 'e2e/case.mjs')])
  assert.equal(result.processResult.exitCode, 0)
  assert.equal(result.attestation.status, 'failed')
  assert.match(result.attestation.failure, /extra unreviewed preload/)
})

test('opaque gate cache reuses only actually validated build closure for the exact loader and pin', async t => {
  const f = await fixture(t), result = await execute(f)
  const compilerBuildCache = createCompilerUseBuildCache()
  const reads = []
  const loadArtifact = (ref, label) => { reads.push(label); return requireRead(ref) }
  const requireRead = ref => readFileSync(join(f.root, ref.path))
  const options = { ...f, reference: result.reference, caseId: 'ide-synthetic-consumer', sourceSha256: digest(f.runner), compilerBuildCache, loadArtifact }
  assert.deepEqual(inspectCompilerUseEvidence(options).errors, [])
  const first = reads.length; reads.length = 0
  assert.deepEqual(inspectCompilerUseEvidence(options).errors, [])
  assert.ok(reads.length < first)
  assert.match(inspectCompilerUseEvidence({ ...options, compilerBuildCache: {} }).errors[0], /opaque validated cache/)
  assert.notDeepEqual(inspectCompilerUseEvidence({ ...options, expectedCommit: 'f'.repeat(40) }).errors, [])
})

test('explicit offline synthetic helper shares archived closure without weakening the real consumer reader', async t => {
  const f = await fixture(t)
  const options = { root: f.root, directory: join(f.root, 'synthetic-reader-only'), compilerBuild: f.compilerBuild,
    caseId: 'ide-synthetic-consumer', sourceSha256: digest(f.runner), caseSourcePath: 'e2e/case.mjs', startedAt: '2026-11-06T10:00:00.000Z', endedAt: '2026-11-06T10:00:01.000Z', pid: 12345 }
  const first = createSyntheticCompilerUse(options), second = createSyntheticCompilerUse({ ...options, caseId: 'ide-synthetic-consumer-two' })
  assert.deepEqual(f.inspect(first.reference).errors, [])
  assert.deepEqual(first.attestation.before, second.attestation.before)
  assert.notDeepEqual(first.attestation.config, second.attestation.config)
  assert.match(first.attestation.checkout, /SYNTHETIC.*NOT-EXECUTED/)
  assert.notDeepEqual(f.inspect(second.reference).errors, [])
})

test('only the exact archived ownership and DOM observer helper patches are admitted', async t => {
  const f = await fixture(t)
  await mkdir(join(f.checkout, 'e2e/utils/domAcceptance'), { recursive: true })
  await writeFile(join(f.checkout, 'e2e/utils/recoverableSession.ts'), 'export const currentTransport=true;')
  await writeFile(join(f.checkout, 'e2e/utils/domAcceptance/index.ts'), 'export const passiveObserver=true;')
  const sealed = await f.seal({ patches: ['e2e/utils/recoverableSession.ts', 'e2e/utils/domAcceptance/index.ts'] })
  const processResult = await child(f, sealed.environment)
  const result = await finishCompilerUse({ context: f.context, processResult })
  assert.equal(result.attestation.status, 'used', result.attestation.failure)
  assert.deepEqual(f.inspect(result.reference).errors, [])
  const other = await fixture(t)
  await mkdir(join(other.checkout, 'e2e/utils/domAcceptance'), { recursive: true })
  await writeFile(join(other.checkout, 'e2e/utils/domAcceptance/checkpoint.test.ts'), 'edited assertion')
  await assert.rejects(other.seal({ patches: ['e2e/utils/domAcceptance/checkpoint.test.ts'] }), /protected/)
})

test('shared guard/patch cache avoids repeated reads but keeps case identity, exact closure and stability checks', async t => {
  const f = await fixture(t), result = await execute(f)
  const compilerBuildCache = createCompilerUseBuildCache(), reads = []
  const loadArtifact = ref => { reads.push(ref.path); return readFileSync(join(f.root, ref.path)) }
  const options = { ...f, reference: result.reference, caseId: 'ide-synthetic-consumer', sourceSha256: digest(f.runner), compilerBuildCache, loadArtifact }
  const first = inspectCompilerUseEvidence(options)
  assert.deepEqual(first.errors, [])
  assert.ok(reads.includes(result.attestation.before.path))
  reads.length = 0
  const repeated = inspectCompilerUseEvidence(options)
  assert.deepEqual(repeated.errors, [])
  assert.equal(reads.includes(result.attestation.before.path), false)
  assert.equal(reads.includes(result.attestation.after.path), false)
  assert.ok(repeated.artifactReferences.some(ref => ref.path === result.attestation.before.path))
  assert.ok(Object.isFrozen(repeated.validatedMembers))
  assert.throws(() => { repeated.validatedMembers[0].sha256 = 'f'.repeat(64) }, TypeError)
  for (const mutate of [
    a => { a.ownerId = 'f'.repeat(8) + '-ffff-ffff-ffff-ffffffffffff' },
    a => { a.caseId = 'ide-foreign-case' },
    a => { a.patches.push({ path: 'e2e/utils/recoverableSession.ts', artifact: f.put('extra reviewed path with no matching guard'), executable: false }) },
    a => { a.patches.push({ path: 'e2e/unreviewed.test.ts', artifact: f.put('edited assertion'), executable: false }) },
  ]) {
    const changed = structuredClone(result.attestation); mutate(changed)
    assert.notDeepEqual(inspectCompilerUseEvidence({ ...options, reference: f.put(JSON.stringify(changed)), caseId: changed.caseId }).errors, [])
  }
  await writeFile(join(f.root, result.attestation.before.path), 'tampered after cached verification')
  assert.match(inspectCompilerUseEvidence(options).errors[0], /Cached compiler consumer artifact changed/)
  // A fresh opaque audit must rehash, rather than borrow the previous cache.
  assert.match(inspectCompilerUseEvidence({ ...options, compilerBuildCache: createCompilerUseBuildCache() }).errors[0], /hash\/size differs/)
})


// Deliberately synthetic installed packages for offline reader adversarial
// tests. These execute real Node startup hooks/worker threads, but do not claim
// to be an official compiler or a real Vitest/Automator observation.
function reviewedInstall(files) {
  return `;for(const [path,source] of Object.entries(${JSON.stringify(files)})){await mkdir(new URL('.',new URL(path,'file://'+process.cwd()+'/')).pathname,{recursive:true});await writeFile(path,source);}`
}
const vitestRoot = 'node_modules/.pnpm/vitest@5.0.4_test-peer/node_modules/vitest'
const tsxRoot = 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx'
async function reviewedWorkerFixture(t) {
  const runner = `import{Worker}from'node:worker_threads';await new Promise((resolve,reject)=>{const worker=new Worker(new URL('../${vitestRoot}/dist/workers/threads.js',import.meta.url),{execArgv:['--experimental-import-meta-resolve','--require',new URL('../${vitestRoot}/suppress-warnings.cjs',import.meta.url).pathname,'--conditions','node','--conditions','development']});worker.on('error',reject);worker.on('exit',code=>code?reject(new Error(String(code))):resolve());});`
  return fixture(t, { runner, installAddendum: reviewedInstall({
    [`${vitestRoot}/package.json`]: JSON.stringify({ name: 'vitest', version: '5.0.4', type: 'module' }),
    [`${vitestRoot}/suppress-warnings.cjs`]: 'globalThis.reviewedWarningHookRan=true;',
    [`${vitestRoot}/dist/workers/threads.js`]: `if(!globalThis.reviewedWarningHookRan)throw Error('require did not run');await import('../../../../../../../dist/index.mjs');`,
  }) })
}
async function reviewedTsxFixture(t, { snapshot = false } = {}) {
  const f = await fixture(t, { extraSource: {
    'e2e/utils/automator.cli-bridge.ts': `import '../../dist/index.mjs';`,
  }, installAddendum: reviewedInstall({
    [`${tsxRoot}/package.json`]: JSON.stringify({ name: 'tsx', version: '4.23.15', type: 'module', exports: { '.': './dist/loader.mjs' } }),
    [`${tsxRoot}/dist/loader.mjs`]: 'globalThis.syntheticTsxStartupRan=true;',
  }) + `;await mkdir('node_modules',{recursive:true});await (await import('node:fs/promises')).symlink('.pnpm/tsx@4.23.15/node_modules/tsx','node_modules/tsx');` })
  const projectPath = join(f.checkout, snapshot ? '.tmp/e2e-ide-bridge-projects/0123456789abcdef' : '.tmp/e2e-projects/fixture-project')
  await mkdir(projectPath, { recursive: true })
  await writeFile(join(projectPath, 'project.config.json'), JSON.stringify({ appid: 'synthetic-appid' }))
  f.bridgeArgs = ['--import', 'tsx', join(f.checkout, 'e2e/utils/automator.cli-bridge.ts'), JSON.stringify({ projectPath, projectConfig: { libVersion: '3.17.3' } })]
  return f
}
function rewriteLogs(f, result, change) {
  const attestation = structuredClone(result.attestation)
  const logs = attestation.logs.map(ref => readFileSync(join(f.root, ref.path)).toString().trim().split('\n').map(line => JSON.parse(line)))
  change(logs)
  attestation.logs = logs.map(events => f.put(events.map(event => JSON.stringify(event)).join('\n') + '\n'))
  return f.put(JSON.stringify(attestation))
}

test('synchronous controlled require witnesses the reviewed worker require before it runs', async t => {
  const f = await reviewedWorkerFixture(t), result = await execute(f)
  assert.equal(result.processResult.exitCode, 0, result.processResult.stderr)
  assert.equal(result.attestation.status, 'used', result.attestation.failure)
  assert.deepEqual(f.inspect(result.reference).errors, [])
  const threads = result.attestation.logs.map(ref => readFileSync(join(f.root, ref.path)).toString().trim().split('\n').map(JSON.parse))
    .find(events => events[0].isMainThread === false)
  assert.ok(threads.some(event => event.kind === 'resolve' && event.specifier.endsWith('/suppress-warnings.cjs')))
  assert.ok(threads.some(event => event.kind === 'load' && event.path.endsWith('/suppress-warnings.cjs') && event.loadedSourceSha256 === event.sha256))
  for (const mutate of [
    events => events.filter(event => event.kind !== 'load' || !event.path.endsWith('/suppress-warnings.cjs')),
    events => events.filter(event => event.kind !== 'resolve' || !event.specifier.endsWith('/suppress-warnings.cjs')),
    events => { events[0].execArgv[2] = 'vitest/suppress-warnings.cjs'; return events },
    events => { events[0].argv[1] = join(f.checkout, 'e2e/worker.mjs'); return events },
    events => { events[0].isMainThread = true; return events },
    events => { events[0].execArgv.push('--import', 'node:fs'); return events },
    events => { events.find(event => event.kind === 'load' && event.path.endsWith('/suppress-warnings.cjs')).loadedSourceSha256 = 'f'.repeat(64); return events },
  ]) {
    const changed = rewriteLogs(f, result, logs => {
      const index = logs.findIndex(events => events[0].isMainThread === false)
      logs[index] = mutate(logs[index])
    })
    assert.match(f.inspect(changed).errors[0], /extra unreviewed preload\/loader/)
  }
})

test('reviewed bridge startup requires exact package resolve/load plus owned project observation', async t => {
  const f = await reviewedTsxFixture(t), result = await execute(f, f.bridgeArgs)
  assert.equal(result.processResult.exitCode, 0, result.processResult.stderr)
  assert.equal(result.attestation.status, 'used', result.attestation.failure)
  assert.deepEqual(f.inspect(result.reference).errors, [])
  for (const mutate of [
    events => events.filter(event => event.kind !== 'load' || !event.path.endsWith('/tsx/dist/loader.mjs')),
    events => events.filter(event => event.kind !== 'resolve' || event.specifier !== 'tsx'),
    events => { events.find(event => event.kind === 'resolve' && event.specifier === 'tsx').url = 'file:///foreign/tsx/dist/loader.mjs'; return events },
    events => { events[0].execArgv[1] = './node_modules/tsx/dist/loader.mjs'; return events },
    events => { events[0].argv[1] = join(f.checkout, 'e2e/case.mjs'); return events },
    events => { events[0].bridgeProject.projectPath = '/foreign/project'; return events },
    events => { events[0].bridgeProject.configSource = '{}'; return events },
    events => { events[0].cwd = '/foreign'; return events },
    events => { events.find(event => event.kind === 'load' && event.path.endsWith('/tsx/dist/loader.mjs')).loadedSourceSha256 = null; return events },
  ]) {
    const changed = rewriteLogs(f, result, logs => { logs[0] = mutate(logs[0]) })
    assert.match(f.inspect(changed).errors[0], /extra unreviewed preload\/loader/)
  }
})

test('actual synthetic snapshot bridge consumption carries an opaque witness and still requires fixture ownership closure', async t => {
  const f = await reviewedTsxFixture(t, { snapshot: true }), result = await execute(f, f.bridgeArgs)
  assert.equal(result.processResult.exitCode, 0, result.processResult.stderr)
  assert.equal(result.attestation.status, 'used', result.attestation.failure)
  const checked = f.inspect(result.reference)
  assert.deepEqual(checked.errors, [])
  assert.ok(Object.isFrozen(checked.bridgeProjectWitness))
  assert.throws(() => verifyCompilerBridgeProjects({ witness: {}, use: checked.attestation }), /opaque output/)
  assert.throws(() => verifyCompilerBridgeProjects({ witness: checked.bridgeProjectWitness, use: structuredClone(checked.attestation) }), /opaque output/)
  const use = checked.attestation
  const checkpoint = { runId: use.ownerId, caseId: use.caseId, sourceSha256: use.sourceSha256, caseSourcePath: use.caseSourcePath,
    compilerBuild: use.compilerBuild, consumerGuard: use.before, build: {}, runtimeObservation: f.put('{}') }
  assert.throws(() => verifyCompilerBridgeProjects({ witness: checked.bridgeProjectWitness, use, checkpoint,
    projects: [], summary: {}, load: ref => readFileSync(join(f.root, ref.path)) }), /snapshot startup has no snapshot fixture transaction/)
})
