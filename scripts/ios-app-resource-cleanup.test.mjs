import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { cleanupIOSAppResource } from './ios-app-resource-cleanup.mjs'
const owner = { owned: true, installed: true, udid: 'task-device', bundleId: 'com.example.task.unique', pid: 42 }
function fake(results) {
  const calls = []
  return { calls, run(args) { calls.push(args); assert.ok(results.length, 'unexpected command'); return results.shift() } }
}
const ok = stdout => ({ status: 0, stdout: stdout ?? '', stderr: '' })
const live = pid => `${pid} 0 UIKitApplication:${owner.bundleId}[uuid][runner]\n99 0 UIKitApplication:com.unrelated.app[uuid]\n`

test('terminates and uninstalls only the recorded task app', () => {
  const runner = fake([ok(live(42)), ok(), ok()])
  const report = cleanupIOSAppResource(owner, runner.run)
  assert.deepEqual(report.steps, ['terminated-owned-process', 'uninstalled-owned-bundle'])
  assert.equal(runner.calls[1][0], 'terminate')
  assert.equal(runner.calls[1][2], owner.bundleId)
  assert.ok(report.simulatorRetained)
})
test('already-exited task does not cause an unowned terminate', () => {
  const runner = fake([ok('99 0 UIKitApplication:com.unrelated.app[x]'), ok()])
  assert.equal(cleanupIOSAppResource(owner, runner.run).steps[0], 'already-exited')
  assert.ok(!runner.calls.some(args => args[0] === 'terminate'))
})
test('changed PID is preserved and reported', () => {
  const runner = fake([ok(live(43))])
  assert.throws(() => cleanupIOSAppResource(owner, runner.run), /identity changed/)
  assert.equal(runner.calls.length, 1)
})
test('inspection/terminate/uninstall errors cannot silently pass', () => {
  const error = { status: 1, stdout: '', stderr: 'simctl failed' }
  for (const results of [[error], [ok(live(42)), error, ok(live(42))], [ok(''), error]]) {
    const runner = fake(results)
    assert.throws(() => cleanupIOSAppResource(owner, runner.run), /failed|cannot inspect/)
  }
})
test('natural exit race retains the termination error as a warning', () => {
  const runner = fake([ok(live(42)), { status: 1, stdout: '', stderr: 'no such process' }, ok(''), ok()])
  const report = cleanupIOSAppResource(owner, runner.run)
  assert.equal(report.warnings.length, 1)
  assert.match(report.warnings[0], /no such process/)
})
test('never touches resources before successful task install or without ownership', () => {
  const runner = fake([])
  assert.equal(cleanupIOSAppResource({ ...owner, installed: false }, runner.run).status, 'passed')
  assert.throws(() => cleanupIOSAppResource({ ...owner, owned: false }, runner.run), /task-owned/)
  assert.equal(runner.calls.length, 0)
})
test('an interrupted or failed install attempt never grants uninstall or terminate authority', () => {
  const runner = fake([])
  const report = cleanupIOSAppResource({ ...owner, installed: false, installAttempted: true, pid: null }, runner.run)
  assert.equal(report.status, 'blocked-unowned')
  assert.equal(report.bundlePreserved, true)
  assert.equal(report.installationAcknowledged, false)
  assert.match(report.reason, /never acknowledged/)
  assert.deepEqual(report.steps, [])
  assert.deepEqual(runner.calls, [])
})
test('interruption before launch can remove the acknowledged install only when no process is present', () => {
  const notLaunched = { ...owner, installAttempted: true, pid: null }
  const absent = fake([ok(''), ok()])
  assert.equal(cleanupIOSAppResource(notLaunched, absent.run).status, 'passed')
  assert.equal(absent.calls.some(args => args[0] === 'terminate'), false)
  const interruptedLaunch = fake([ok(live(42))])
  assert.throws(() => cleanupIOSAppResource(notLaunched, interruptedLaunch.run), /identity changed.*preserved/)
  assert.equal(interruptedLaunch.calls.some(args => ['terminate', 'uninstall'].includes(args[0])), false)
})
test('nonboolean ownership/install flags cannot grant destructive cleanup authority', () => {
  const runner = fake([])
  assert.throws(() => cleanupIOSAppResource({ ...owner, owned: 'true' }, runner.run), /task-owned/)
  assert.equal(cleanupIOSAppResource({ ...owner, installed: 'true', installAttempted: true }, runner.run).status, 'blocked-unowned')
  assert.deepEqual(runner.calls, [])
})
test('the CLI reports an ambiguous interrupted installation as nonzero without calling simctl', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'ios-cleanup-interrupted-'))
  try {
    const ownership = resolve(directory, 'resources.json')
    const output = resolve(directory, 'cleanup.json')
    writeFileSync(ownership, JSON.stringify({ ...owner, installed: false, installAttempted: true, pid: null }))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ios-app-resource-cleanup.mjs', import.meta.url)), ownership, output], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: resolve(directory, 'no-command-binaries') },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /blocked-unowned/)
    const report = JSON.parse(readFileSync(output))
    assert.equal(report.status, 'blocked-unowned')
    assert.equal(report.bundlePreserved, true)
    assert.deepEqual(report.steps, [])
    assert.equal(report.simulatorRetained, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
