import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { CONFORMANCE_BASELINE as baseline } from './conformance-evidence.mjs'
import { createConformanceEvidenceModule, instrumentPinnedAutomator, instrumentPinnedDomAcceptance, instrumentPinnedIdeSetup, instrumentPinnedRecoverableSession, instrumentPinnedSharedRuntime, inventoryRetainedBuildInputs } from './conformance-devtools-isolation.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const pinned = execFileSync('git', ['show', `${baseline.compiler.commit}:e2e/utils/automator.ts`], { cwd: resolve(root, 'vendor/weapp-vite'), encoding: 'utf8' })
const pinnedSetup = execFileSync('git', ['show', `${baseline.compiler.commit}:e2e/vitest.e2e.ide.setup.ts`], { cwd: resolve(root, 'vendor/weapp-vite'), encoding: 'utf8' })
const pinnedShared = execFileSync('git', ['show', `${baseline.compiler.commit}:e2e/ide/github-issues.runtime.shared.ts`], { cwd: resolve(root, 'vendor/weapp-vite'), encoding: 'utf8' })
const pinnedRecoverable = execFileSync('git', ['show', `${baseline.compiler.commit}:e2e/utils/recoverableSession.ts`], { cwd: resolve(root, 'vendor/weapp-vite'), encoding: 'utf8' })
const pinnedDom = execFileSync('git', ['show', `${baseline.compiler.commit}:e2e/utils/domAcceptance/index.ts`], { cwd: resolve(root, 'vendor/weapp-vite'), encoding: 'utf8' })

test('only successful current-case DOM checkpoints reach the passive observer', async () => {
  const source = ts.transpileModule(instrumentPinnedDomAcceptance(pinnedDom), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
  const body = source.slice(source.indexOf('export function createDomAcceptance')).replace('export function', 'function')
    .replaceAll('import.meta.dirname', JSON.stringify(join(root, 'vendor/weapp-vite/e2e/utils/domAcceptance')))
  const evidence = { id: 'observed', route: '/actual', nodes: [{ text: 'actual DOM value' }] }
  const observations = []
  let capture = async () => evidence
  const create = vm.runInNewContext(`${body}\ncreateDomAcceptance`, {
    structuredClone, resolveRuntimeProviderName: () => 'devtools', validateDomPlan: () => {},
    flushRuntimeConsoleSessions: async () => {}, captureDomCheckpoint: (...args) => capture(...args),
    recordConformanceDomCheckpoint: async observation => observations.push(observation),
  })
  const context = () => {
    const value = { task: { id: 'synthetic-source-flow', meta: {} } }
    value.onTestFinished = callback => { value.finish = callback }
    return value
  }
  const first = context()
  const plan = create(first, 'actual-fixture', [{ id: 'observed' }])
  assert.equal(await plan.check('observed', {}, {}), evidence)
  assert.equal(observations.length, 1)
  assert.equal(observations[0].evidence, first.task.meta.domAcceptance.evidence[0])
  assert.equal(observations[0].evidence.nodes[0].text, 'actual DOM value')
  capture = async () => { throw new Error('actual DOM assertion failed') }
  await assert.rejects(create(context(), 'failed-fixture', [{ id: 'failed' }]).check('failed', {}, {}), /actual DOM assertion failed/)
  assert.equal(observations.length, 1)
  let complete
  let started
  const capturing = new Promise(resolve => { started = resolve })
  capture = () => new Promise(resolve => { complete = resolve; started() })
  const late = context()
  const pending = create(late, 'late-fixture', [{ id: 'late' }]).check('late', {}, {})
  await capturing
  late.finish(); complete(evidence)
  await assert.rejects(pending, /completed after its case ended/)
  assert.equal(observations.length, 1)
})

test('fixed-source instrumentation pins every launch SDK and captures session before caller hook', () => {
  const result = instrumentPinnedAutomator(pinned)
  assert.match(result, /const DEFAULT_LIB_VERSION = '3\.17\.3'/)
  assert.match(result, /const mergedProjectConfig = \{ \.\.\.projectConfig, libVersion: DEFAULT_LIB_VERSION \}/)
  assert.ok(result.indexOf('await recordConformanceSession(metadata)') < result.indexOf('await callerSessionMetadata?.(metadata)'))
  assert.match(result, /assertSelectedWechatDevtoolsRuntime\(selectedTarget, miniProgram\)\)\n\s+await lifecycle.step\(\(\) => recordConformanceRuntime\(miniProgram/)
  assert.match(result, /assertSelectedWechatDevtoolsRuntime\(selectedTarget, session\)\)\n\s+await reconnectScope.step\(\(\) => recordConformanceRuntime\(session/)
  assert.equal(readFileSync(resolve(root, 'vendor/weapp-vite/e2e/utils/automator.ts'), 'utf8'), pinned)
})

test('instrumentation fails closed if upstream anchors change or are duplicated', () => {
  assert.throws(() => instrumentPinnedAutomator(pinned.replace("const DEFAULT_LIB_VERSION = '3.13.2'", "const DEFAULT_LIB_VERSION = '3.20.0'")), /anchor is missing or ambiguous/)
  assert.throws(() => instrumentPinnedAutomator(pinned + "\nconst DEFAULT_LIB_VERSION = '3.13.2'\n"), /anchor is missing or ambiguous/)
})

test('isolated root readiness gives later rendered selectors a fair share of the same deadline', async () => {
  const probe = async (source, root, rootSelectors = []) => {
    const start = source.indexOf('async function waitForRelaunchPageRoot(')
    const end = source.indexOf('\nconst disconnectedLaunchSessions', start)
    assert.ok(start >= 0 && end > start, 'pinned helper function boundary changed')
    const signatureEnd = source.indexOf(') {', start)
    const body = 'async function waitForRelaunchPageRoot(page, timeoutMs = RELAUNCH_READY_TIMEOUT, rootSelectors = [], signal) {' + source.slice(signatureEnd + 3, end)
    let elapsed = 0
    const calls = []
    const context = vm.createContext({ Date: { now: () => elapsed }, RELAUNCH_READY_TIMEOUT: 5000,
      ROUTE_READY_PAGE_ROOT_PROBE_TIMEOUT: 1500, DEFAULT_PAGE_ROOT_QUERY_TIMEOUT: 1000,
      runWithTimeout: async operation => operation(), sleep: async duration => { elapsed += duration } })
    vm.runInContext(body + '\nthis.probe = waitForRelaunchPageRoot', context)
    const result = await context.probe({
      waitForRendered: async ({ selector, timeout }) => {
        calls.push({ selector, timeout, at: elapsed })
        if (selector === root && timeout >= 5) { elapsed += 5; return `<${root}>ready</${root}>` }
        elapsed += timeout
        throw new Error('missing root')
      },
      $$: async () => [], $: async () => null, waitFor: async duration => { elapsed += duration },
    }, 1500, rootSelectors)
    return { result, calls, elapsed }
  }
  const original = await probe(pinned, 'button')
  assert.equal(original.result, null)
  assert.equal(original.calls[0].timeout, 1500)
  const patched = instrumentPinnedAutomator(pinned)
  for (const root of ['view', 'text', 'button', 'input', 'scroll-view', 'image', '*']) {
    const observed = await probe(patched, root)
    assert.equal(observed.result?.selector, root)
    assert.ok(observed.elapsed <= 1500, `${root} exceeded the original caller deadline`)
    assert.ok(observed.calls.at(-1).timeout >= 5, `${root} was starved`)
  }
  const explicit = await probe(patched, '#ready', ['#missing', '#ready'])
  assert.equal(explicit.result?.selector, '#ready')
  assert.ok(explicit.elapsed <= 1500)
})

test('managed close awaits journal release beyond the ordinary protocol timeout and preserves errors', async () => {
  const source = instrumentPinnedSharedRuntime(pinnedShared)
  const start = source.indexOf('async function closeMiniProgramSafely(')
  const end = source.indexOf('\nfunction stripAutomatorOverlay(', start)
  assert.ok(start >= 0 && end > start)
  const helper = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  let elapsed = 0
  let release
  let released = false
  let completed = false
  let disconnected = 0
  const ordinary = []
  const ownership = new WeakSet()
  const sharedSessionOwners = new WeakMap()
  const context = vm.createContext({ sharedSessionOwners, getManagedProjectSessionOwner: session => ownership.has(session),
    runAutomatorOp: async (label, operation, options) => { ordinary.push({ label, ...options, at: elapsed }); return operation() } })
  const recoverable = ts.transpileModule(instrumentPinnedRecoverableSession(pinnedRecoverable).replace('export function', 'function'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInContext(helper + recoverable + '\nthis.close=closeMiniProgramSafely;this.create=createRecoverableSession', context)
  const session = { close: async () => { await new Promise(resolve => { release = resolve }); released = true },
    disconnect: async () => { disconnected++ } }
  ownership.add(session)
  const owner = context.create(session)
  sharedSessionOwners.set(owner.session, owner)
  assert.notEqual(owner.session, session, 'exercise the pinned shared fixture Proxy boundary')
  const pending = context.close(owner.session).then(() => { assert.equal(released, true); completed = true })
  elapsed = 6700
  await Promise.resolve()
  assert.equal(completed, false, 'owned journal is still pending after the shorter generic deadline')
  assert.deepEqual(ordinary, [], 'managed close has one bounded owner instead of a competing timeout race')
  release()
  await pending
  assert.equal(completed, true)
  assert.equal(disconnected, 0)
  let replacementClosed = false
  const replacement = { close: async () => { replacementClosed = true } }
  ownership.add(replacement)
  owner.replace(replacement)
  await context.close(owner.session)
  assert.equal(replacementClosed, true, 'the current reconnect owner supplies the bounded close')
  assert.deepEqual(ordinary, [])
  await context.close({ close: async () => {} })
  assert.deepEqual(ordinary, [{ label: 'close mini program', timeoutMs: 6000, retries: 1, at: 6700 }])
  const failure = new Error('native window destruction evidence is incomplete')
  const broken = { close: async () => { throw failure }, disconnect: async () => { disconnected++ } }
  ownership.add(broken)
  await assert.rejects(context.close(broken), error => error === failure)
  assert.equal(disconnected, 1)
  assert.throws(() => instrumentPinnedSharedRuntime(pinnedShared.replace('timeoutMs: 6_000', 'timeoutMs: 7_000')), /anchor is missing or ambiguous/)
})

test('structured fatal simulator diagnostics end bridge retries while pending startup can recover', async () => {
  const execute = async (source, state) => {
    const start = source.indexOf('  const connectDeadlineAt = ')
    const end = source.indexOf('\n  if (!miniProgram)', start)
    assert.ok(start >= 0 && end > start)
    const helper = ts.transpileModule('async function connect() {\n' + source.slice(start, end) + '\nreturn miniProgram\n}',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    let elapsed = 0, scans = 0, attempts = 0
    class BootError extends Error { constructor() { super('official simulator launch catch error timeout'); this.issue = { state } } }
    const error = new BootError()
    const context = vm.createContext({ performance: { now: () => elapsed }, options: { timeout: 1000 },
      bridgeResult: { wsEndpoint: 'ws://127.0.0.1:9420' }, project: '/owned/project',
      lifecycle: { remainingMs: value => Math.min(value, 1000), throwIfAborted() {}, step: operation => operation(),
        recordFailure() {}, pause: async duration => { elapsed += duration } },
      monitor: { assertClean() { scans++; if (state === 'fatal' || scans === 1) throw error } },
      automator: { connect: async () => { attempts++; return { connected: true } } },
      DevtoolsSimulatorBootLogError: BootError, isRecoverableBridgeConnectError: () => false,
      disconnectLaunchSession: async () => {},
      DEVTOOLS_CONNECTION_CLOSED_PATTERNS: [], BRIDGE_CONNECT_TIMEOUT_PATTERN: /timeout/i,
      BRIDGE_CONNECT_FAILURE_PATTERN: /Failed connecting/i, process: { stdout: { write() {} } } })
    vm.runInContext(helper + '\nthis.connect=connect', context)
    try { return { result: await context.connect(), elapsed, scans, attempts } }
    catch (failure) { return { error: failure, elapsed, scans, attempts } }
  }
  const original = await execute(pinned, 'fatal')
  assert.ok(original.scans > 1)
  const fatal = await execute(instrumentPinnedAutomator(pinned), 'fatal')
  assert.equal(fatal.error?.issue.state, 'fatal')
  assert.equal(fatal.scans, 1)
  assert.equal(fatal.elapsed, 0)
  assert.equal(fatal.attempts, 0)
  const recovered = await execute(instrumentPinnedAutomator(pinned), 'pending')
  assert.ifError(recovered.error)
  assert.equal(recovered.result.connected, true)
  assert.equal(recovered.scans, 2)
  assert.equal(recovered.elapsed, 400)
})

test('evidence helpers import in global setup while worker setup owns the flush and scoped cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-vitest-lifecycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'utils'))
  await symlink(join(root, 'vendor/weapp-vite/node_modules'), join(directory, 'node_modules'), 'junction')
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(directory, 'utils/conformanceEvidence.mjs'), createConformanceEvidenceModule(join(root, 'scripts/conformance-devtools-attempt.mjs')))
  await writeFile(join(directory, 'worker-setup.ts'), instrumentPinnedIdeSetup(pinnedSetup))
  await writeFile(join(directory, 'utils/devtoolsProcessOwnership.ts'), `import {writeFile} from 'node:fs/promises';
    export const ensureDevtoolsProjectJournal=async()=>'synthetic-owned-journal';
    export const cleanupOwnedDevtoolsProcesses=async context=>{await writeFile(new URL('../cleanup.json',import.meta.url),JSON.stringify(context))};\n`)
  await writeFile(join(directory, 'utils/devtoolsSkip.ts'), 'export const getDevtoolsSkipReason=()=>null;export const markSuiteSkipped=()=>{};\n')
  await writeFile(join(directory, 'utils/ide-hmr-companion.ts'), 'export const registerIdeHmrCompanion=()=>{};\n')
  await writeFile(join(directory, 'utils/runtimeProvider.ts'), "export const resolveRuntimeProviderName=()=>'devtools';\n")
  await writeFile(join(directory, 'global-setup.mjs'), `
    const previous=process.env.WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR;
    process.env.WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR='/synthetic/must-not-install-during-global-import';
    try { await import('./utils/conformanceEvidence.mjs'); }
    finally { if(previous===undefined) delete process.env.WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR; else process.env.WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR=previous; }
    export default async function(){}\n`)
  await writeFile(join(directory, 'fixture.test.mjs'), "import {test,expect} from 'vitest';test('actual worker assertion executes',()=>expect(7).toBe(7));\n")
  await writeFile(join(directory, 'vitest.config.mjs'), `export default {test:{globals:true,pool:'threads',maxWorkers:1,include:['fixture.test.mjs'],globalSetup:['./global-setup.mjs'],setupFiles:['./worker-setup.ts']}};\n`)
  const suiteReport = join(directory, 'result.json')
  const env = { ...process.env, WEAPP_CONTAINER_CONFORMANCE_SESSION_DIR: join(directory, 'sessions'),
    WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH: '/synthetic/unused-cli', WEAPP_CONTAINER_CONFORMANCE_INSTALLATION_ID: '1'.repeat(64),
    WEAPP_CONTAINER_CONFORMANCE_RECIPE: '', WEAPP_CONTAINER_CONFORMANCE_EVENTS: join(directory, 'events.json') }
  execFileSync(process.execPath, [join(root, 'vendor/weapp-vite/node_modules/vitest/vitest.mjs'), 'run', '--config', './vitest.config.mjs',
    '--reporter=json', `--outputFile=${suiteReport}`], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  const report = JSON.parse(await readFile(suiteReport, 'utf8'))
  assert.equal(report.success, true)
  assert.equal(report.numPassedTests, 1)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'cleanup.json'), 'utf8')), { journalPath: 'synthetic-owned-journal', scope: 'journal' })
  // A failed passive collector preserves the original assertion result and
  // reports runner failure while still running the owned project cleanup.
  await rm(join(directory, 'cleanup.json'))
  await writeFile(join(directory, 'empty-collector.mjs'), 'export const createCollector=()=>({attach(){}});\n')
  const recipePath = join(directory, 'runtime-recipe.json')
  await writeFile(recipePath, JSON.stringify({ caseId: 'ide-synthetic-empty', sourceSha256: '1'.repeat(64), manifestIntegrity: '2'.repeat(64),
    collectorPath: join(directory, 'empty-collector.mjs'), collectorInputPaths: [] }))
  execFileSync(process.execPath, [join(root, 'vendor/weapp-vite/node_modules/vitest/vitest.mjs'), 'run', '--config', './vitest.config.mjs',
    '--reporter=json', `--outputFile=${suiteReport}`], { cwd: directory, env: { ...env, WEAPP_CONTAINER_CONFORMANCE_RECIPE: recipePath },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  assert.equal(JSON.parse(await readFile(suiteReport, 'utf8')).success, true)
  assert.equal(JSON.parse(await readFile(join(directory, 'events.json'), 'utf8')).status, 'blocked')
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'cleanup.json'), 'utf8')), { journalPath: 'synthetic-owned-journal', scope: 'journal' })
})

test('passive fixture and trace failures preserve the official runtime return and remain runner evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-fixture-observer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'node_modules/weapp-ide-cli')
  await mkdir(cli, { recursive: true })
  await writeFile(join(cli, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
  await writeFile(join(cli, 'index.mjs'), 'export const persistOpenedAutomatorSession=()=>{};\n')
  const helper = join(directory, 'conformance-devtools-attempt.mjs')
  await writeFile(helper, `export const observation={SDKVersion:'actual-observation'};
    export const state={flushes:0};
    export const createOfficialSessionRecorder=()=>({onSessionMetadata(){},observeRuntime:async()=>observation,flush:async()=>{state.flushes++}});\n`)
  await writeFile(join(directory, 'conformance-recipes.mjs'), `export const state={attached:0,flushes:0};
    export const createRuntimeTraceCollector=async()=>({attach:async()=>{state.attached++;throw new Error('collector attach unavailable')},checkpoint:async()=>{},flush:async()=>{state.flushes++;throw new Error('collector flush incomplete')}});\n`)
  await writeFile(join(directory, 'conformance-fixture-build.mjs'), `export const state={installed:0,captured:0,flushed:0,disposed:0};
    export const installStaticFixtureBuildRecorder=()=>{state.installed++;return{flush:async()=>{state.flushed++;throw Object.assign(new Error('fixture closure changed'),{code:'SYNTHETIC_FIXTURE_FLUSH'})},dispose(){state.disposed++}}};
    export const snapshotCandidate={path:'raw-candidate',sha256:'a'.repeat(64),bytes:1};
    export const snapshotValidation={path:'rejected-validation',sha256:'b'.repeat(64),bytes:1};
    export const captureOwnedSnapshot=async()=>{throw Object.assign(new Error('snapshot candidate rejected'),{snapshotCandidate,snapshotValidation})};export const captureOwnedSnapshotCleanup=async()=>{};
    export const captureOfficialFixtureCheckpoint=async()=>{state.captured++;throw Object.assign(new Error('fixture checkpoint unavailable'),{code:'SYNTHETIC_FIXTURE_CAPTURE'})};\n`)
  const output = join(directory, 'observer-observation.json')
  const values = { WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR: directory,
    WEAPP_CONTAINER_CONFORMANCE_COMPILER_BUILD: '{}',
    WEAPP_CONTAINER_CONFORMANCE_CASE: JSON.stringify({ caseId: 'ide-synthetic-observer', sourceSha256: '1'.repeat(64) }),
    WEAPP_CONTAINER_CONFORMANCE_OBSERVER_FAILURES: output }
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const modulePath = join(directory, 'conformanceEvidence.mjs')
  await writeFile(modulePath, createConformanceEvidenceModule(helper))
  const evidence = await import(pathToFileURL(modulePath).href)
  const fixture = await import(pathToFileURL(join(directory, 'conformance-fixture-build.mjs')).href)
  const recorder = await import(pathToFileURL(helper).href)
  const collector = await import(pathToFileURL(join(directory, 'conformance-recipes.mjs')).href)
  assert.equal(fixture.state.installed, 0, 'global import cannot install the worker observer')
  evidence.startConformanceEvidence()
  evidence.startConformanceEvidence()
  assert.equal(fixture.state.installed, 1)
  await evidence.recordConformanceSnapshot({})
  assert.equal(await evidence.recordConformanceRuntime({}, {}), recorder.observation,
    'a passive fixture failure cannot replace the official runtime result')
  assert.equal(collector.state.attached, 1)
  await evidence.flushConformanceEvidence()
  assert.deepEqual(fixture.state, { installed: 1, captured: 1, flushed: 1, disposed: 1 })
  assert.equal(recorder.state.flushes, 1)
  assert.equal(collector.state.flushes, 1)
  const report = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(report.kind, 'conformance-observer-observation')
  assert.equal(report.caseId, 'ide-synthetic-observer')
  assert.deepEqual(report.failures, [
    { code: 'CONFORMANCE_FIXTURE_PROVENANCE_FAILED', message: 'snapshot candidate rejected',
      snapshotCandidate: fixture.snapshotCandidate, snapshotValidation: fixture.snapshotValidation },
    { code: 'SYNTHETIC_FIXTURE_CAPTURE', message: 'fixture checkpoint unavailable' },
    { code: 'CONFORMANCE_TRACE_COLLECTOR_ATTACH_FAILED', message: 'collector attach unavailable' },
    { code: 'CONFORMANCE_TRACE_COLLECTOR_FLUSH_FAILED', message: 'collector flush incomplete' },
    { code: 'SYNTHETIC_FIXTURE_FLUSH', message: 'fixture closure changed' },
  ])
})

test('generated worker awaits actual capture, binds its exact checkpoint, then attaches without replacing runtime results', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-captured-success-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'node_modules/weapp-ide-cli')
  await mkdir(cli, { recursive: true })
  await writeFile(join(cli, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }))
  await writeFile(join(cli, 'index.mjs'), 'export const persistOpenedAutomatorSession=()=>{};\n')
  await writeFile(join(directory, 'state.mjs'), `
    export const calls=[];
    export const observation=Object.freeze({SDKVersion:'actual-runtime-observation'});
    export const checkpoint=Object.freeze({path:'owned/static-checkpoint.json',sha256:'3'.repeat(64),bytes:71});
    export const state={};
    export const captureStarted=new Promise(resolve=>{state.captureStarted=resolve});
    export const onSessionMetadata=()=>{};
  `)
  const helper = join(directory, 'conformance-devtools-attempt.mjs')
  await writeFile(helper, `import {calls,observation,state,onSessionMetadata} from './state.mjs';
    export const createOfficialSessionRecorder=()=>({onSessionMetadata,
      observeRuntime:async(program,context)=>{calls.push('observe');state.observed={program,context};return observation},
      flush:async()=>{calls.push('recorder.flush')}
    });\n`)
  await writeFile(join(directory, 'conformance-fixture-build.mjs'), `import {calls,checkpoint,state} from './state.mjs';
    export const installStaticFixtureBuildRecorder=()=>{
      calls.push('install');
      return state.fixture={flush:async()=>{calls.push('fixture.flush')},dispose(){calls.push('fixture.dispose')}};
    };
    export const captureOwnedSnapshot=async()=>{};export const captureOwnedSnapshotCleanup=async()=>{};
    export const captureOfficialFixtureCheckpoint=async input=>{
      calls.push('capture');state.captured=input;state.captureStarted();
      await new Promise(resolve=>{state.releaseCapture=resolve});
      calls.push('capture.complete');
      return {reference:checkpoint,attestation:{reference:{...checkpoint,sha256:'f'.repeat(64)}}};
    };\n`)
  await writeFile(join(directory, 'conformance-recipes.mjs'), `import {calls,state} from './state.mjs';
    export const createRuntimeTraceCollector=async()=>({
      bindFixtureCheckpoint:reference=>{calls.push('bind');state.bound=reference},
      attach:async(program,context)=>{calls.push('attach');state.attached={program,context}},
      checkpoint:async(observation,context)=>{calls.push('checkpoint');state.dom={observation,context}},
      flush:async()=>{calls.push('collector.flush')}
    });\n`)
  const output = join(directory, 'observer-observation.json')
  const values = { WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR: directory,
    WEAPP_CONTAINER_CONFORMANCE_COMPILER_BUILD: '{}',
    WEAPP_CONTAINER_CONFORMANCE_CASE: JSON.stringify({ caseId: 'ide-synthetic-captured-success', sourceSha256: '1'.repeat(64) }),
    WEAPP_CONTAINER_CONFORMANCE_OBSERVER_FAILURES: output }
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const modulePath = join(directory, 'conformanceEvidence.mjs')
  await writeFile(modulePath, createConformanceEvidenceModule(helper))
  const evidence = await import(pathToFileURL(modulePath).href)
  const shared = await import(pathToFileURL(join(directory, 'state.mjs')).href)
  assert.deepEqual(shared.calls, [], 'global import does not install a worker recorder')
  assert.equal(evidence.recordConformanceSession, shared.onSessionMetadata)
  evidence.startConformanceEvidence()
  evidence.startConformanceEvidence()
  const program = { actualProgram: true }, context = { actualContext: true }
  let returned = false
  const pending = evidence.recordConformanceRuntime(program, context).then(value => { returned = true; return value })
  await shared.captureStarted
  assert.deepEqual(shared.calls, ['install', 'observe', 'capture'])
  assert.equal(returned, false, 'runtime recording waits for capture completion before binding or attaching')
  assert.equal(shared.state.captured.recorder, shared.state.fixture)
  assert.equal(shared.state.captured.runtimeObservation, shared.observation)
  assert.deepEqual(shared.state.observed, { program, context })
  shared.state.releaseCapture()
  assert.equal(await pending, shared.observation, 'passive capture preserves the exact runtime return object')
  assert.deepEqual(shared.calls, ['install', 'observe', 'capture', 'capture.complete', 'bind', 'attach'])
  assert.equal(shared.state.bound, shared.checkpoint, 'bind receives capture.reference itself, not the attestation or another reference')
  assert.equal(shared.state.attached.program, program)
  assert.equal(shared.state.attached.context, context)
  const dom = { evidence: { text: 'actual completed checkpoint' } }
  await evidence.recordConformanceDomCheckpoint(dom, context)
  assert.equal(shared.state.dom.observation, dom)
  assert.equal(shared.state.dom.context, context)
  await evidence.flushConformanceEvidence()
  assert.deepEqual(shared.calls, ['install', 'observe', 'capture', 'capture.complete', 'bind', 'attach', 'checkpoint',
    'recorder.flush', 'collector.flush', 'fixture.flush', 'fixture.dispose'])
  const report = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(report.kind, 'conformance-observer-observation')
  assert.equal(report.caseId, 'ide-synthetic-captured-success')
  assert.deepEqual(report.failures, [])
})

test('retained build inventory binds copied bytes and helper imports without claiming a pinned build', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conformance-retained-build-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const checkout = join(directory, 'checkout')
  const archive = join(directory, 'instrumentation')
  const dist = join(checkout, 'packages/compiler/dist')
  const dependencies = join(directory, 'borrowed-dependencies')
  await Promise.all([mkdir(dist, { recursive: true }), mkdir(archive), mkdir(dependencies)])
  const module = join(dist, 'index.js')
  await writeFile(module, 'retained compiled bytes; build source unknown\n')
  const helper = join(directory, 'helper.mjs')
  await writeFile(helper, "import { value } from './helper-dependency.mjs'\nconst input = new URL('./input.json', import.meta.url)\nconst root = new URL('.', import.meta.url)\n")
  await writeFile(join(directory, 'helper-dependency.mjs'), 'export const value = 1\n')
  await writeFile(join(directory, 'input.json'), '{"value":1}\n')
  const linked = join(checkout, 'node_modules')
  await symlink(dependencies, linked, 'junction')
  const inventory = await inventoryRetainedBuildInputs({ checkout, archive, helper, buildDirectories: [dist], dependencyLinks: [linked] })
  assert.equal(inventory.compilerCommit, baseline.compiler.commit)
  assert.equal(inventory.retainedBuildProvenance, 'unverified')
  assert.equal(inventory.diagnosticOnly, true)
  assert.equal(inventory.dependencyLinks[0].contentVerified, false)
  assert.equal(inventory.dependencyLinks[0].target, dependencies)
  assert.deepEqual(inventory.buildArtifacts, [{ path: 'packages/compiler/dist/index.js',
    sha256: createHash('sha256').update(await readFile(module)).digest('hex'), bytes: (await readFile(module)).length }])
  assert.equal(inventory.helperInputs.length, 3)
  assert.deepEqual(inventory.helperDirectoryContexts, [{ path: directory, kind: 'directory-context', contentVerified: false }])
  for (const input of inventory.helperInputs) {
    const snapshot = await readFile(join(archive, input.snapshot))
    assert.equal(snapshot.length, input.bytes)
    assert.equal(createHash('sha256').update(snapshot).digest('hex'), input.sha256)
  }
  await writeFile(module, 'a different retained build\n')
  const changed = await inventoryRetainedBuildInputs({ checkout, archive, helper, buildDirectories: [dist], dependencyLinks: [linked] })
  assert.notEqual(changed.buildArtifacts[0].sha256, inventory.buildArtifacts[0].sha256)
  assert.equal(changed.retainedBuildProvenance, 'unverified')
})
