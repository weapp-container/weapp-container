import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { inspectSnapshot, matchedResponse } from './style-module-boundary-smoke.mjs'

function responseTrace(overrides = {}) {
  return {
    schemaVersion: 1,
    records: [{
      request: { sessionId: 'simulator-1', requestId: 'geometry', op: 'api.call' },
      response: { messages: [{ kind: 'response', sessionId: 'simulator-1', requestId: 'geometry', op: 'api.call', payload: { ok: true, result: { width: 96 } }, ...overrides }] },
    }],
  }
}

test('requires a unique successful runtime response for the exact session, request and op', () => {
  assert.equal(matchedResponse(responseTrace(), 'geometry', 'api.call').result.width, 96)
  for (const invalid of [
    { sessionId: 'foreign-session' },
    { requestId: 'foreign-request' },
    { op: 'diagnostic' },
    { kind: 'event' },
    { payload: { accepted: true } },
    { payload: { ok: false, accepted: true } },
  ]) assert.throws(() => matchedResponse(responseTrace(invalid), 'geometry', 'api.call'))
  const duplicate = responseTrace()
  duplicate.records[0].response.messages.push(duplicate.records[0].response.messages[0])
  assert.throws(() => matchedResponse(duplicate, 'geometry', 'api.call'), /exactly one correlated runtime response/)
  const duplicateRequest = responseTrace()
  duplicateRequest.records.push(duplicateRequest.records[0])
  assert.throws(() => matchedResponse(duplicateRequest, 'geometry', 'api.call'), /exactly one request record/)
})

function realSnapshot() {
  const box = { left: 12, top: 16, width: 96, height: 40, color: '#e11d48' }
  const pixels = Array(200 * 160 * 4).fill(255)
  for (let y = box.top; y < box.top + box.height; y += 1) {
    for (let x = box.left; x < box.left + box.width; x += 1) {
      const offset = (y * 200 + x) * 4
      pixels.splice(offset, 4, 225, 29, 72, 255)
    }
  }
  return { box, snapshot: { width: 200, height: 160, stride: 800, format: 'rgba8-premultiplied', pixels } }
}

test('checks actual inside and outside RGBA pixels and rejects summary-only or blank snapshots', () => {
  const { snapshot, box } = realSnapshot()
  const result = inspectSnapshot(snapshot, box)
  assert.equal(result.pixelBytes, 128_000)
  assert.equal(result.samples.length, 7)
  assert.match(result.pixelSha256, /^[a-f0-9]{64}$/)
  assert.equal(inspectSnapshot({ ...snapshot, format: 'rgba8' }, box).pixelSha256, result.pixelSha256)
  assert.throws(() => inspectSnapshot({ ...snapshot, format: 'bgra8' }, box), /pixel format/)
  assert.throws(() => inspectSnapshot({ ...snapshot, pixels: undefined, pixelBytes: 128_000 }, box), /actual RGBA bytes/)
  assert.throws(() => inspectSnapshot({ ...snapshot, pixels: Array(128_000).fill(255) }, box), /actual RGBA fill/)
  const leaked = { ...snapshot, pixels: [...snapshot.pixels] }
  leaked.pixels.splice((2 * 200 + 2) * 4, 4, 225, 29, 72, 255)
  assert.throws(() => inspectSnapshot(leaked, box), /actual white outside box/)
  assert.throws(() => inspectSnapshot({ ...snapshot, pixels: snapshot.pixels.slice(4) }, box), /complete snapshot pixels/)
})

test('SIGTERM preserves a failed report and closes the owned simulator process tree and staging', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weapp-style-signal-test-'))
  const fake = resolve(directory, 'fake-simulator')
  const marker = resolve(directory, 'pids.json')
  const output = resolve(directory, 'report.json')
  let child
  let exited
  try {
    await writeFile(fake, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
// Keep the parent alive to reap its worker. Only the smoke runner's group
// signal terminates the worker; this handler deliberately never kills it.
process.on('SIGTERM', () => {
  if (worker.exitCode !== null || worker.signalCode !== null) process.exit(0);
  else worker.once('exit', () => process.exit(0));
});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, worker.pid]));
setInterval(() => {}, 1000);
`)
    await chmod(fake, 0o755)
    child = spawn(process.execPath, [fileURLToPath(new URL('./style-module-boundary-smoke.mjs', import.meta.url)),
      '--simulator-bin', fake, '--out', output, '--timeout', '10000'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    exited = new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    let pids
    const deadline = Date.now() + 5_000
    while (!pids && Date.now() < deadline) {
      try { pids = JSON.parse(await readFile(marker, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!pids) await delay(20)
    }
    assert.equal(pids?.length, 2, `owned fake process tree reached: ${stdout}\n${stderr}`)
    child.kill('SIGTERM')
    const exit = await exited
    assert.equal(exit.code, 143, `controlled SIGTERM exit: ${stdout}\n${stderr}`)
    const report = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(report.status, 'failed')
    assert.equal(report.interrupted, 'SIGTERM')
    assert.deepEqual(report.cleanup, { childProcessClosed: true, temporaryRemoved: true, noListenerOrBrowserCreated: true })
    for (const pid of pids) {
      const cleanupDeadline = Date.now() + 2_000
      let alive = true
      while (alive && Date.now() < cleanupDeadline) {
        try { process.kill(pid, 0); await delay(20) }
        catch (error) { if (error.code !== 'ESRCH') throw error; alive = false }
      }
      assert.equal(alive, false, `owned child PID ${pid} exited`)
    }
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) { child.kill('SIGTERM'); await exited }
    await rm(directory, { recursive: true, force: true })
  }
})
