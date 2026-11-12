import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { createOfficialCaseEnvironment, createOfficialStopController, inspectOfficialLoginPreflight, parseOfficialArguments, readOfficialFixtureHandoff, runChild, RUNNER_INPUTS, OFFICIAL_VITEST_EXECUTION_ARGS } from './conformance-devtools-runner.mjs'

test('runner snapshots cover every literal local helper import and data file plus computed manifest schemas', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const inputs = new Set(RUNNER_INPUTS)
  const visited = new Set()
  const visit = async path => {
    if (visited.has(path)) return
    visited.add(path)
    assert.ok(inputs.has(path), `runner provenance does not snapshot ${path}`)
    const file = resolve(root, path)
    if (!/\.[cm]?js$/.test(file)) return
    const source = await readFile(file, 'utf8')
    const dependencies = []
    const inspect = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) dependencies.push(node.arguments[0].text)
      if (ts.isNewExpression(node) && node.expression.getText(tree) === 'URL' && node.arguments?.length === 2
        && ts.isStringLiteral(node.arguments[0]) && node.arguments[1].getText(tree) === 'import.meta.url') dependencies.push(node.arguments[0].text)
      ts.forEachChild(node, inspect)
    }
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    inspect(tree)
    for (const specifier of dependencies) {
      if (!specifier.startsWith('.')) continue
      const dependency = resolve(dirname(file), specifier)
      if ((await lstat(dependency)).isFile()) await visit(relative(root, dependency).replaceAll('\\', '/'))
    }
  }
  await visit('scripts/conformance-devtools-runner.mjs')
  for (const path of ['package.json', 'docs/conformance/case-index-v1.json', 'docs/conformance/case-index-v1.sha256',
    ...[1, 2, 3].map(version => `schemas/container-manifest-v${version}.schema.json`)]) assert.ok(inputs.has(path))
  assert.equal(inputs.size, RUNNER_INPUTS.length)
})

test('official runner accepts package-manager argument forwarding', () => {
  const options = parseOfficialArguments(['--', '--case', 'ide-doctor', '--focus', 'failed-blocked', '--prepare-only', '--compiler-build', 'artifacts/fresh/compiler-build.json'])
  assert.deepEqual(options.cases, ['ide-doctor'])
  assert.equal(options.focus, 'failed-blocked')
  assert.equal(options.prepareOnly, true)
  assert.ok(options.compilerBuild.endsWith('/artifacts/fresh/compiler-build.json'))
})

test('case environment scopes the pinned fixture directory and compiler to the exact source', async () => {
  const source = 'e2e/ide/github-issues.runtime.issue1035.test.ts'
  const environment = createOfficialCaseEnvironment(source, { retained: 'yes', WEAPP_VITE_E2E_TARGET_FILE: 'ide/other.test.ts' })
  assert.equal(environment.retained, 'yes')
  assert.equal(environment.WEAPP_VITE_E2E_TARGET_FILE, 'ide/github-issues.runtime.issue1035.test.ts')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const pinned = await readFile(join(root, 'vendor/weapp-vite/e2e/ide/github-issues.runtime.shared.ts'), 'utf8')
  const select = (start, end) => {
    const begin = pinned.indexOf(start)
    const finish = pinned.indexOf(end, begin)
    assert.ok(begin >= 0 && finish > begin)
    return pinned.slice(begin, finish)
  }
  const code = select('function resolveGithubIssuesProjectId()', '\nfunction resolveGithubIssuesDistDir()')
    + select('function getNormalizedTargetFile()', '\nfunction resolveAggregateStableLaunchRoute(').replace('export function', 'function')
  const context = vm.createContext({ process: { env: environment }, E2E_TARGET_FILE_ENV: 'WEAPP_VITE_E2E_TARGET_FILE', PROJECT_ID_SAFE_RE: /[^\w.-]+/g })
  vm.runInContext(code + '\nthis.identity=resolveGithubIssuesProjectId();this.scope=resolveGithubIssuesScopedTargetFile()', context)
  assert.equal(context.identity, 'ide-github-issues.runtime.issue1035.test.ts')
  assert.equal(context.scope, 'ide/github-issues.runtime.issue1035.test.ts')
  for (const source of ['ide/test.test.ts', 'e2e/../outside.test.ts', 'e2e/ide/other.ts', 'e2e\\ide\\other.test.ts']) {
    assert.throws(() => createOfficialCaseEnvironment(source), /exact indexed/)
  }
})

test('stop requests await owned cleanup and prevent later case execution', async () => {
  const signals = new EventEmitter()
  const stop = createOfficialStopController(signals)
  const calls = []
  let releaseCleanup
  const cleanup = new Promise(resolve => { releaseCleanup = resolve })
  const run = async () => {
    try {
      for (const id of ['active', 'not-executed']) {
        stop.throwIfRequested()
        try { calls.push(id); signals.emit('SIGINT'); signals.emit('SIGTERM') }
        finally { await cleanup; calls.push('owned-journal-released') }
        stop.throwIfRequested()
      }
    } finally { calls.push('host-and-machine-released'); stop.dispose() }
  }
  const pending = run()
  assert.deepEqual(calls, ['active'])
  assert.equal(stop.requested.signal, 'SIGINT')
  releaseCleanup()
  await assert.rejects(pending, { code: 'CONFORMANCE_RUN_STOP_REQUESTED', stage: 'runner' })
  assert.deepEqual(calls, ['active', 'owned-journal-released', 'host-and-machine-released'])
  assert.equal(signals.listenerCount('SIGINT'), 0)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
})

test('official runner diagnoses absent or substituted option values', () => {
  for (const option of ['--case', '--focus', '--out', '--cli', '--recipes', '--compiler-build']) {
    for (const argv of [[option], [option, '--prepare-only'], [option, '  ']]) {
      assert.throws(() => parseOfficialArguments(argv), new RegExp(`${option} requires a value`))
    }
  }
  assert.throws(() => parseOfficialArguments(['--focus', 'invalid']), /--focus must be/)
})

test('official child log contains the full final stdout and stderr before hashing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-child-log-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'official.log')
  const block = 'x'.repeat(256 * 1024)
  const result = await runChild(process.execPath, ['-e', `
    const {writeSync}=require('node:fs');
    const block='x'.repeat(256*1024);
    for(let index=0;index<16;index++) writeSync(1,block);
    writeSync(2,'\\nlast stderr observation\\n');
  `], { cwd: directory }, log)
  assert.equal(result.exitCode, 0)
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0)
  assert.equal(await readFile(log, 'utf8'), block.repeat(16) + '\nlast stderr observation\n')
})

test('official child refuses to overwrite an existing evidence log', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-child-existing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'official.log')
  await writeFile(log, 'retained evidence')
  await assert.rejects(runChild(process.execPath, ['-e', 'process.exit(0)'], { cwd: directory }, log), { code: 'EEXIST' })
  assert.equal(await readFile(log, 'utf8'), 'retained evidence')
})

test('official Vitest loads a TypeScript config graph without adding bundled config or execution caches', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-vitest-cache-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'scope.ts'), "export const include: string[] = ['fixture.test.mjs'];\n")
  await writeFile(join(directory, 'vitest.config.ts'), "import {include} from './scope';export default {test:{globals:true,include,maxWorkers:1}};\n")
  await writeFile(join(directory, 'fixture.test.mjs'), "test('unchanged official assertion executes',()=>expect(7).toBe(7));\n")
  const result = await runChild(process.execPath, [join(fileURLToPath(new URL('..', import.meta.url)), 'vendor/weapp-vite/node_modules/vitest/vitest.mjs'),
    'run', ...OFFICIAL_VITEST_EXECUTION_ARGS, '--config', './vitest.config.ts'], { cwd: directory }, join(directory, 'official.log'))
  assert.equal(result.exitCode, 0, await readFile(join(directory, 'official.log'), 'utf8'))
  assert.match(await readFile(join(directory, 'official.log'), 'utf8'), /1 passed/)
  await assert.rejects(lstat(join(directory, 'node_modules/.vite/vitest/CACHEDIR.TAG')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(directory, 'node_modules/.vitest-cache')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(directory, 'node_modules/.vite-temp')), { code: 'ENOENT' })
})


test('official prerequisite requires a real successful login observation', () => {
  assert.deepEqual(inspectOfficialLoginPreflight('[info] {"login":true}', { exitCode: 0 }), { status: 'passed', login: true })
  for (const output of ['', '{"islogin":true}', '{"login":true} {"login":false}']) {
    assert.throws(() => inspectOfficialLoginPreflight(output, { exitCode: 0 }), { code: 'CONFORMANCE_LOGIN_UNOBSERVED' })
  }
  assert.throws(() => inspectOfficialLoginPreflight('{"login":true}', { exitCode: 246 }), { code: 'CONFORMANCE_LOGIN_UNOBSERVED' })
  assert.throws(() => inspectOfficialLoginPreflight('{"login":false}', { exitCode: 0 }), { code: 'CONFORMANCE_LOGIN_REQUIRED' })
  assert.throws(() => inspectOfficialLoginPreflight('IDE service port disabled', { exitCode: 246 }), { code: 'CONFORMANCE_SERVICE_PORT_DISABLED' })
  assert.throws(() => inspectOfficialLoginPreflight('工具的服务端口已关闭。', { exitCode: 246 }), { code: 'CONFORMANCE_SERVICE_PORT_DISABLED' })
  assert.throws(() => inspectOfficialLoginPreflight('', { exitCode: 1, timedOut: true }), { code: 'CONFORMANCE_PREREQUISITE_TIMEOUT' })
})


test('official prerequisite timeout releases its child before returning', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-child-timeout-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = await runChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: directory, timeout: 40 }, join(directory, 'prerequisite.log'))
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, 1)
  assert.equal(result.signal, 'SIGTERM')
})

async function fixtureHandoff(t) {
  const root = await mkdtemp(join(tmpdir(), 'conformance-fixture-handoff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'case'), capture = join(directory, 'fixture-capture')
  await mkdir(join(capture, 'objects/sha256'), { recursive: true })
  const caseId = 'ide-fixture-handoff', sourceSha256 = '1'.repeat(64)
  const value = { schemaVersion: 1, kind: 'weapp-container.static-generated-checkpoint', profile: 'static-cli-v1',
    status: 'captured', ownerId: 'worker-recorder', runId: 'worker-run', caseId, sourceSha256 }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const checkpoint = { path: `case/fixture-capture/objects/sha256/${sha256}`, sha256, bytes: bytes.length }
  const alias = join(capture, 'static-checkpoint.json'), summaryFile = join(capture, 'static-recorder-summary.json')
  const summary = { schemaVersion: 1, kind: 'weapp-container.static-recorder-summary', profile: value.profile,
    status: 'complete', ownerId: value.ownerId, runId: value.runId, caseId, sourceSha256, checkpoint }
  const saveSummary = () => writeFile(summaryFile, JSON.stringify(summary))
  await writeFile(resolve(root, checkpoint.path), bytes)
  await writeFile(alias, bytes)
  await saveSummary()
  return { root, directory, caseId, sourceSha256, value, bytes, checkpoint, alias, summary, summaryFile, saveSummary }
}

test('fixture handoff preserves the exact worker reference instead of rearchiving its named alias', async t => {
  const f = await fixtureHandoff(t)
  const before = await Promise.all([readFile(f.alias), readFile(f.summaryFile), readFile(resolve(f.root, f.checkpoint.path))])
  const handoff = await readOfficialFixtureHandoff(f)
  assert.deepEqual(handoff.checkpoint, f.checkpoint)
  assert.notEqual(handoff.checkpoint.path, relative(f.root, f.alias))
  assert.equal(handoff.recorderSummary.path, 'case/fixture-capture/static-recorder-summary.json')
  assert.deepEqual(await Promise.all([readFile(f.alias), readFile(f.summaryFile), readFile(resolve(f.root, f.checkpoint.path))]), before)
})

test('fixture handoff rejects changed alias bytes and corrupted worker checkpoint bytes', async t => {
  for (const file of ['alias', 'checkpoint']) {
    const f = await fixtureHandoff(t)
    await writeFile(file === 'alias' ? f.alias : resolve(f.root, f.checkpoint.path), Buffer.concat([f.bytes, Buffer.from('\n')]))
    await assert.rejects(readOfficialFixtureHandoff(f), file === 'alias' ? /Named fixture checkpoint differs/ : /hash\/size differs/)
  }
})

test('fixture handoff rejects incomplete, foreign and malformed recorder references', async t => {
  for (const variant of ['status', 'case', 'source', 'foreign-path', 'digest', 'size', 'extra-field', 'owner', 'run']) {
    const f = await fixtureHandoff(t)
    if (variant === 'status') f.summary.status = 'blocked'
    if (variant === 'case') f.summary.caseId += '-foreign'
    if (variant === 'source') f.summary.sourceSha256 = '2'.repeat(64)
    if (variant === 'foreign-path') {
      await mkdir(join(f.root, 'foreign'), { recursive: true })
      await writeFile(join(f.root, 'foreign/checkpoint.json'), f.bytes)
      f.summary.checkpoint.path = 'foreign/checkpoint.json'
    }
    if (variant === 'digest') f.summary.checkpoint.sha256 = '3'.repeat(64)
    if (variant === 'size') f.summary.checkpoint.bytes++
    if (variant === 'extra-field') f.summary.checkpoint.inferred = true
    if (variant === 'owner') f.summary.ownerId += '-foreign'
    if (variant === 'run') f.summary.runId += '-foreign'
    await f.saveSummary()
    await assert.rejects(readOfficialFixtureHandoff(f), /Fixture handoff|hash\/size differs/, variant)
  }
})
