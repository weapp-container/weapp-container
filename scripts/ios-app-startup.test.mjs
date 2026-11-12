import assert from 'node:assert/strict'
import test from 'node:test'
import { waitIOSAppStartup } from './ios-app-startup.mjs'

const owner = { owned: true, installed: true, udid: 'simulator', bundleId: 'com.example.task', pid: 42 }
const options = { sessionId: 'owned-session', engine: 'v8', timeoutMs: 1000 }
const evidence = status => Buffer.from(JSON.stringify({ status, sessionId: options.sessionId, engine: options.engine }))
function harness(records) {
  let time = 0
  let index = 0
  return {
    now: () => time,
    wait: async ms => { time += ms; index = Math.min(index + 1, records.length - 1) },
    read: async () => records[index].bytes ?? null,
    run: async () => ({ status: 0, stdout: records[index].dead ? '' : '42 0 UIKitApplication:com.example.task[owned]\n' }),
  }
}
test('startup waits for matching terminal evidence from the exact live app', async () => {
  const result = await waitIOSAppStartup(owner, options, harness([{}, { bytes: evidence('running') }, { bytes: evidence('passed') }]))
  assert.equal(result.report.status, 'passed')
  assert.equal(result.report.elapsedMs, 500)
  assert.equal(result.report.observedPid, 42)
})
test('native crash preserves initial bytes and fails immediately instead of masquerading as a screenshot error', async () => {
  const bytes = evidence('running')
  const result = await waitIOSAppStartup(owner, options, harness([{ bytes }, { bytes, dead: true }]))
  assert.equal(result.report.code, 'ERR_ENGINE')
  assert.equal(result.report.status, 'failed')
  assert.equal(result.report.elapsedMs, 250)
  assert.equal(result.report.observedPid, null)
  assert.deepEqual(result.evidenceBytes, bytes)
})
test('a completed receipt cannot pass after the app exits or changes PID', async () => {
  const io = harness([{ bytes: evidence('passed') }])
  io.run = async () => ({ status: 0, stdout: '43 0 UIKitApplication:com.example.task[other]\n' })
  const result = await waitIOSAppStartup(owner, options, io)
  assert.equal(result.report.status, 'failed')
  assert.equal(result.report.observedPid, 43)
})
test('stale session and another engine never pass startup', async () => {
  for (const changed of [{ sessionId: 'stale' }, { engine: 'quickjs' }]) {
    const bytes = Buffer.from(JSON.stringify({ status: 'passed', sessionId: options.sessionId, engine: options.engine, ...changed }))
    const result = await waitIOSAppStartup(owner, options, harness([{ bytes }]))
    assert.equal(result.report.status, 'failed')
    assert.deepEqual(result.evidenceBytes, bytes)
  }
})
test('a live app with no completed evidence reaches an explicit deadline', async () => {
  const result = await waitIOSAppStartup(owner, options, harness([{ bytes: evidence('running') }]))
  assert.equal(result.report.code, 'ERR_TIMEOUT')
  assert.equal(result.report.elapsedMs, 1000)
})
test('app failures, blocked reports, malformed JSON and observation errors stay failed', async () => {
  for (const status of ['failed', 'blocked', 'unknown']) {
    const result = await waitIOSAppStartup(owner, options, harness([{ bytes: evidence(status) }]))
    assert.notEqual(result.report.status, 'passed')
  }
  const broken = Buffer.from('{broken')
  const result = await waitIOSAppStartup(owner, options, harness([{ bytes: broken }]))
  assert.equal(result.report.status, 'failed')
  assert.deepEqual(result.evidenceBytes, broken)
  const io = harness([{}])
  io.run = async () => ({ status: 1, stderr: 'simulator unavailable' })
  assert.match((await waitIOSAppStartup(owner, options, io)).report.reason, /simulator unavailable/)
})
test('unowned apps and invalid budgets are rejected before observation', async () => {
  const io = { now: () => assert.fail('must not observe') }
  await assert.rejects(waitIOSAppStartup({ ...owner, owned: false }, options, io), /task app/)
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(waitIOSAppStartup(owner, { ...options, timeoutMs }, io), /timeout/)
  }
})
