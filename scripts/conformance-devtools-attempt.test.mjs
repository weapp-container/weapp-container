import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONFORMANCE_BASELINE as baseline } from './conformance-evidence.mjs'
import { assertOfficialSelection, classifyConformanceFailure, createOfficialSessionRecorder, inspectConformanceAttempt, observeOfficialRuntime } from './conformance-devtools-attempt.mjs'

const tool = { version: baseline.devtoolsVersion, SDKVersion: baseline.baseLibraryVersion }
const system = { SDKVersion: baseline.baseLibraryVersion, platform: 'devtools' }
const official = (toolInfo = tool, systemInfo = system) => ({ toolInfo: async () => toolInfo, evaluate: async () => systemInfo })
const selection = () => ({ selectedVersion: baseline.devtoolsVersion, acceptedVersion: baseline.devtoolsVersion,
  packageVersion: baseline.devtoolsVersion, baseLibraryVersion: baseline.baseLibraryVersion, compilerCommit: baseline.compiler.commit,
  installationId: 'a'.repeat(64), queriedAt: '2026-11-06T10:00:00.000Z', source: 'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json', officialVersionMatches: true })

test('runtime baseline observes wx SDK separately from Tool metadata and project selection', async () => {
  const observed = await observeOfficialRuntime(official())
  assert.deepEqual(observed.tool, tool)
  assert.deepEqual(observed.system, system)
  await assert.rejects(observeOfficialRuntime(official(tool, { SDKVersion: '3.13.0' })), error =>
    error.code === 'CONFORMANCE_RUNTIME_BASELINE_MISMATCH' && /wx.getSystemInfoSync\(\).SDKVersion=3.13.0/.test(error.message))
  await assert.rejects(observeOfficialRuntime(official({ ...tool, SDKVersion: '3.13.0' })), /tool.SDKVersion=3.13.0/)
  await assert.rejects(observeOfficialRuntime(official({ ...tool, version: '2.02.2609082' })), /tool.version=2.02.2609082/)
  await assert.rejects(observeOfficialRuntime(official(tool, {})), /wx.getSystemInfoSync\(\).SDKVersion=<missing>/)
})

test('selection rejects a mixed SDK, compiler or nonofficial query provenance', () => {
  assert.equal(assertOfficialSelection(selection()).selectedVersion, baseline.devtoolsVersion)
  for (const field of ['selectedVersion', 'acceptedVersion', 'packageVersion', 'baseLibraryVersion', 'compilerCommit']) {
    assert.throws(() => assertOfficialSelection({ ...selection(), [field]: 'incorrect' }), { code: 'CONFORMANCE_SELECTION_BASELINE_MISMATCH' })
  }
  for (const [field, value] of [['installationId', 'missing'], ['queriedAt', 'unknown'], ['source', 'https://example.invalid/config.json']]) {
    assert.throws(() => assertOfficialSelection({ ...selection(), [field]: value }), { code: 'CONFORMANCE_SELECTION_PROVENANCE_MISSING' })
  }
  const historical = { ...selection(), officialVersionMatches: false, versionPolicy: 'selected-version-opt-in', selectedChannel: 'stable', officialVersion: '2.02.9912310' }
  assert.equal(assertOfficialSelection(historical), historical)
  for (const change of [{ versionPolicy: 'installed-stable' }, { selectedChannel: 'nightly' }, { officialVersion: null }, { acceptedVersion: '2.02.9912310' }]) {
    assert.throws(() => assertOfficialSelection({ ...historical, ...change }))
  }
})

test('session metadata is durable before persistence and remains inspectable after connection failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-session-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls = []
  const recorder = createOfficialSessionRecorder({ directory, cliPath: '/explicit/cli', installationId: 'a'.repeat(64),
    persistOpenedAutomatorSession: async options => {
      const before = JSON.parse(await readFile(join(directory, 'session-0000.json'), 'utf8'))
      assert.equal(before.persisted, false)
      calls.push(options)
    } })
  const metadata = { projectPath: '/owned/project', wsEndpoint: 'ws://127.0.0.1:9420', port: 9420,
    managedProject: { id: 'owned-window', journalPath: '/owned/journal' } }
  await recorder.onSessionMetadata(metadata)
  // A later Automator connect/warmup failure does not erase the early hook's
  // persisted resource address, unlike saving metadata after launch returns.
  const record = JSON.parse(await readFile(join(directory, 'session-0000.json'), 'utf8'))
  assert.equal(record.persisted, true)
  assert.deepEqual(record.managedProject, metadata.managedProject)
  assert.deepEqual(calls, [{ projectPath: '/owned/project', wsEndpoint: metadata.wsEndpoint, port: 9420,
    cliPath: '/explicit/cli', runtimeProvider: 'devtools', timeout: 30_000 }])
  await recorder.observeRuntime(official(), { projectPath: metadata.projectPath })
  assert.equal(JSON.parse(await readFile(join(directory, 'runtime-0001.json'), 'utf8')).status, 'passed')
  await assert.rejects(recorder.observeRuntime(official(tool, {})), /<missing>/)
  const mismatch = JSON.parse(await readFile(join(directory, 'runtime-0002.json'), 'utf8'))
  assert.equal(mismatch.status, 'blocked')
  assert.equal(mismatch.system.SDKVersion, null)
  await recorder.flush()
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), [])
})

test('invalid endpoints and failed persistence never produce a persisted session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-session-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let calls = 0
  const recorder = createOfficialSessionRecorder({ directory, cliPath: '/explicit/cli',
    persistOpenedAutomatorSession: async () => { calls++; throw new Error('session owner changed') } })
  await assert.rejects(recorder.onSessionMetadata({ projectPath: '/owned/project', wsEndpoint: 'ws://example.invalid:9420', port: 9420 }), { code: 'CONFORMANCE_SESSION_METADATA_INVALID' })
  assert.equal(calls, 0)
  await assert.rejects(recorder.onSessionMetadata({ projectPath: '/owned/project', wsEndpoint: 'ws://127.0.0.1:9420', port: 9420 }), { code: 'CONFORMANCE_SESSION_PERSIST_FAILED' })
  const record = JSON.parse(await readFile(join(directory, 'session-0001.json'), 'utf8'))
  assert.equal(record.persisted, false)
  assert.equal(record.error, 'session owner changed')
})

test('runner, simulator and container failures have distinct evidence domains', () => {
  const cases = [
    [new Error('Cannot claim WeChat DevTools host before task start: selected'), { stage: 'lease' }, ['blocked', 'runner']],
    [new Error('Failed connecting to ws://127.0.0.1:9420'), { stage: 'assertion' }, ['blocked', 'runner']],
    [new Error('AppService boot failed'), { stage: 'simulator' }, ['blocked', 'official-runtime']],
    [new Error('WeChat DevTools simulator boot error detected in IDE log during connect: AppService terminated; Failed connecting to ws://127.0.0.1:9420'), { stage: 'connection' }, ['blocked', 'official-runtime']],
    [new Error('expected hidden slot to be absent'), { stage: 'assertion' }, ['failed', 'official-runtime']],
    [new Error('host still selected after quit'), { stage: 'cleanup' }, ['blocked', 'runner']],
    [new Error('normalized event payload differs'), { stage: 'comparison', provider: 'container', comparedToOfficial: true }, ['failed', 'container-runtime']],
    [new Error('normalized event payload differs'), { stage: 'comparison', provider: 'container' }, ['blocked', 'runner']],
  ]
  for (const [error, context, expected] of cases) {
    const result = classifyConformanceFailure(error, context)
    assert.deepEqual([result.status, result.domain], expected)
  }
})

test('attempt validation preserves diagnostics without creating a passed oracle receipt', async () => {
  const hash = 'b'.repeat(64)
  const attempt = { schemaVersion: 1, kind: 'wechat-devtools-case-attempt', caseId: 'ide-synthetic-case', status: 'passed', provider: 'wechat-devtools',
    baselineId: baseline.id, compilerCommit: baseline.compiler.commit,
    source: { path: 'e2e/ide/synthetic.test.ts', sha256: hash, before: hash, after: hash },
    run: { startedAt: '2026-11-06T10:00:00.000Z', endedAt: '2026-11-06T10:00:01.000Z', exitCode: 0 },
    runtimeObservations: [await observeOfficialRuntime(official())], resources: { owner: 'synthetic test', machineLeaseAcquired: true, machineLeaseReleased: true,
      hostLeaseAcquired: true, hostLeaseReleased: true, ownedResourcesReleased: true, borrowedResourcesPreserved: true }, failures: [] }
  assert.deepEqual(inspectConformanceAttempt(attempt), { status: 'passed', errors: [], diagnosticOnly: true })
  const incomplete = mutate => { const value = structuredClone(attempt); mutate(value); return inspectConformanceAttempt(value) }
  assert.match(incomplete(value => { value.runtimeObservations.length = 0 }).errors.join('\n'), /actual Tool\/wx/)
  assert.match(incomplete(value => { value.resources.hostLeaseReleased = false }).errors.join('\n'), /cleanup is incomplete/)
  assert.match(incomplete(value => { value.source.after = 'c'.repeat(64) }).errors.join('\n'), /source differs/)
  assert.match(incomplete(value => { value.status = 'blocked' }).errors.join('\n'), /classified failure/)
  for (const changed of [{ signal: 'SIGTERM' }, { timedOut: true }, { assertionsExecuted: false }]) {
    assert.match(incomplete(value => { Object.assign(value.run, changed) }).errors.join('\n'), /interrupted or did not execute/)
  }
  assert.match(incomplete(value => { value.failures.push(classifyConformanceFailure(new Error('mismatch'), { stage: 'comparison', provider: 'container', comparedToOfficial: true })) }).errors.join('\n'), /cannot attribute/)
  assert.equal(incomplete(value => { value.kind = 'wechat-devtools-case-execution' }).status, 'incomplete')
})
