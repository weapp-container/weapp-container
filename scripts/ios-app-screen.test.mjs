import assert from 'node:assert/strict'
import test from 'node:test'
import { captureIOSAppScreen } from './ios-app-screen.mjs'

const owner = { owned: true, installed: true, udid: 'task-simulator', bundleId: 'com.example.task', pid: 123 }
const live = { status: 0, stdout: '123 0 UIKitApplication:com.example.task[abc]', stderr: '' }
const ok = { status: 0, stdout: '', stderr: '' }
const png = Buffer.alloc(33)
Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
png.write('IHDR', 12)
png.writeUInt32BE(1206, 16)
png.writeUInt32BE(2622, 20)

test('OS screen capture retains exact app identity and differs from drawable acceptance', () => {
  const calls = []
  const results = [live, ok, live]
  const report = captureIOSAppScreen(owner, '/task/app-screen.png', args => {
    calls.push(args)
    return results.shift()
  }, () => png)
  assert.equal(report.status, 'captured')
  assert.equal(report.evidenceBoundary, 'official-simulator-composited-screen')
  assert.equal(report.width, 1206)
  assert.equal(report.height, 2622)
  assert.equal(report.pidBefore, owner.pid)
  assert.equal(report.pidAfter, owner.pid)
  assert.equal(report.foregroundVerified, false)
  assert.equal(report.presentationVerified, false)
  assert.match(report.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(calls[1], ['io', owner.udid, 'screenshot', '--type=png', '/task/app-screen.png'])
})

test('unowned or unlaunched apps never trigger simulator calls', () => {
  for (const patch of [{ owned: false }, { installed: false }, { pid: null }, { pid: -1 }]) {
    assert.throws(() => captureIOSAppScreen({ ...owner, ...patch }, 'screen.png', () => assert.fail('must not call simctl')), /task app and launch PID/)
  }
})

test('another PID cannot be accepted as the screen capture app', () => {
  assert.throws(() => captureIOSAppScreen(owner, 'screen.png', () => ({ ...live, stdout: live.stdout.replace('123', '456') })), /identity changed/)
})

test('an app exiting during capture invalidates the screen receipt', () => {
  const results = [live, ok, ok]
  assert.throws(() => captureIOSAppScreen(owner, 'screen.png', () => results.shift(), () => png), /identity changed/)
})

test('screenshot tool errors and invalid images cannot be recorded as captured', () => {
  const failed = [live, { status: 1, stderr: 'capture unavailable' }]
  assert.throws(() => captureIOSAppScreen(owner, 'screen.png', () => failed.shift()), /capture unavailable/)
  const success = [live, ok, live]
  assert.throws(() => captureIOSAppScreen(owner, 'screen.png', () => success.shift(), () => Buffer.from('not a screenshot')), /PNG image/)
})
