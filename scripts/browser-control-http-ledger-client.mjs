/** Opt-in integration client for tests/browser_control_http.rs ONLY.
 * Native fetch and node:net talk to the isolated Rust test listener. This is
 * not production authentication, a Worker, browser, presenter or GPU test. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { BrowserDevHttpControl } from '../crates/container-simulator/src/browser-dev-http-control.mjs'

const base = new URL(process.env.WEAPP_TEST_CONTROL_URL)
const runId = process.env.WEAPP_TEST_CONTROL_RUN, clientId = process.env.WEAPP_TEST_CONTROL_CLIENT
const secret = process.env.WEAPP_TEST_CONTROL_SECRET
assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:'); assert.equal(base.pathname, '/')
assert.ok(runId && clientId && secret, 'Rust must explicitly supply the isolated authenticated context')
const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const snapshotRequest = { version: '1.0', requestId: `${clientId}:control-1`, command: 'snapshot', payload: {} }
const stopRequest = { version: '1.0', requestId: `${clientId}:cleanup-1`, command: 'stop', payload: {} }
const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('isolated HTTP client deadline')), 20_000)
const options = { signal: deadline.signal }, sockets = new Map(), captures = new Map(), ackBodies = []
let dropFirstInvoke = true, dropNextAck = false, control
const headers = extra => ({ 'Content-Type': 'application/json', Origin: base.origin,
  'X-Weapp-Run-Id': runId, 'X-Weapp-Client-Id': clientId, 'X-Weapp-Dev-Secret': secret, ...extra })
async function rawPost(path, body, extra = {}) {
  const result = await fetch(new URL(path, base), { method: 'POST', headers: headers(extra), body, redirect: 'error', signal: deadline.signal })
  const value = await result.json(); return { status: result.status, value }
}
async function heldReplay() {
  const body = JSON.stringify(snapshotRequest), socket = createConnection({ host: base.hostname, port: Number(base.port) })
  const closed = new Promise(resolve => socket.once('close', resolve)); sockets.set(socket, closed)
  let abort
  try {
    await new Promise((resolve, reject) => {
      let received = Buffer.alloc(0), settled = false
      const fail = error => { if (!settled) { settled = true; reject(error) } }
      abort = () => socket.destroy(deadline.signal.reason)
      deadline.signal.addEventListener('abort', abort, { once: true })
      socket.once('error', fail); socket.once('end', () => fail(new Error('held body ended before its actual prefix')))
      socket.on('data', chunk => {
        try {
          received = Buffer.concat([received, chunk]); assert.ok(received.length <= 16 * 1024)
          const end = received.indexOf('\r\n\r\n')
          if (end >= 0 && received.length > end + 4 && !settled) {
            assert.match(received.subarray(0, end).toString(), /^HTTP\/1\.1 200 /)
            settled = true; socket.pause(); resolve()
          }
        } catch (error) { fail(error) }
      })
      socket.once('connect', () => socket.write([
        'POST /__weapp/control/replay HTTP/1.1', `Host: ${base.host}`, 'Connection: close',
        ...Object.entries(headers({ 'X-Weapp-Test-Hold-Body': '1' })).map(([key, value]) => `${key}: ${value}`),
        `Content-Length: ${Buffer.byteLength(body)}`, '', body,
      ].join('\r\n')))
      if (deadline.signal.aborted) abort()
    })
    return { socket, closed, release() { deadline.signal.removeEventListener('abort', abort); sockets.delete(socket) } }
  } catch (error) {
    socket.destroy(); await closed; deadline.signal.removeEventListener('abort', abort); sockets.delete(socket); throw error
  }
}

try {
  // The wrong-auth requests attempt the real mutating stop first. The later
  // genuine coordinator snapshot must still be unstopped and owner-less.
  for (const bad of [{ 'X-Weapp-Dev-Secret': `${secret}-wrong` }, { 'X-Weapp-Run-Id': 'other-run' }, { 'X-Weapp-Client-Id': 'other-client' }]) {
    assert.equal((await rawPost('/__weapp/control/invoke', JSON.stringify(stopRequest), bad)).status, 403)
  }
  control = new BrowserDevHttpControl({ baseUrl: base.href, runId, clientId, secret, sha256,
    fetch: async (url, init) => {
      const extra = { Origin: base.origin }
      if (url.endsWith('/invoke') && dropFirstInvoke) { extra['X-Weapp-Test-Drop-Final'] = '1'; dropFirstInvoke = false }
      if (url.endsWith('/acknowledge')) {
        const text = new TextDecoder().decode(init.body); ackBodies.push(text)
        if (dropNextAck) { extra['X-Weapp-Test-Drop-Ack'] = '1'; dropNextAck = false }
      }
      const result = await fetch(url, { ...init, headers: { ...init.headers, ...extra } })
      const rawHash = result.headers.get('X-Weapp-Test-Final-Sha256')
      if (rawHash) { assert.match(rawHash, /^[a-f0-9]{64}$/); captures.set(JSON.parse(new TextDecoder().decode(init.body)).requestId, rawHash) }
      return result
    } })

  await assert.rejects(control.invoke(snapshotRequest, options), /fetch|socket|other side|closed/i)
  assert.throws(() => control.invoke(snapshotRequest, options), { code: 'ERR_PROTOCOL_VERSION' })
  const snapshot = await control.replay(snapshotRequest, options)
  assert.equal(snapshot.status, 'ok'); assert.equal(snapshot.snapshot.stopped, false)
  assert.equal(snapshot.snapshot.ownerKey, null); assert.equal(snapshot.snapshot.runtimeReady, null); assert.equal(snapshot.snapshot.presentedReady, null)
  const rawHash = captures.get(snapshotRequest.requestId); assert.ok(rawHash)
  const wrongHash = sha256(encode(JSON.stringify(snapshot, null, 2))); assert.notEqual(wrongHash, rawHash)
  const wrong = await rawPost('/__weapp/control/acknowledge', JSON.stringify({ version: '1.0', originalRequest: JSON.stringify(snapshotRequest), finalSha256: wrongHash }))
  assert.equal(wrong.status, 409); assert.equal(wrong.value.reason, 'ack-mismatch')

  const held = await heldReplay()
  try {
    const first = control.acknowledge(snapshotRequest, snapshot, options)
    const same = control.acknowledge(snapshotRequest, snapshot, options); assert.strictEqual(first, same)
    await assert.rejects(first, error => error.code === 'ERR_HTTP' && /409/.test(error.message))
    const release = await rawPost('/__test/release-held', '{}')
    assert.equal(release.status, 200); assert.equal(release.value.released, 1)
    held.socket.resume(); await held.closed
  } finally { held.socket.destroy(); await held.closed; held.release() }

  // Compaction succeeds server-side, then the real TCP ACK reply is lost.
  dropNextAck = true
  await assert.rejects(control.acknowledge(snapshotRequest, snapshot, options), /fetch|socket|other side|closed/i)
  const confirmed = await control.acknowledge(snapshotRequest, snapshot, options)
  assert.equal(confirmed.outcome, 'already-compacted'); assert.equal(confirmed.finalSha256, rawHash)
  assert.equal(ackBodies.length, 3); assert.ok(ackBodies.every(body => body === ackBodies[0]))
  assert.equal(JSON.parse(ackBodies[0]).originalRequest, JSON.stringify(snapshotRequest))
  assert.equal(JSON.parse(ackBodies[0]).finalSha256, rawHash)
  assert.strictEqual(await control.acknowledge(snapshotRequest, snapshot, options), confirmed)
  assert.equal(ackBodies.length, 3, 'a cached ACK does not cause another fetch')
  const idempotent = await rawPost('/__weapp/control/acknowledge', ackBodies[0])
  assert.equal(idempotent.status, 200); assert.equal(idempotent.value.outcome, 'already-compacted')
  await assert.rejects(control.replay(snapshotRequest, options), error => error.code === 'ERR_HTTP' && /410/.test(error.message))

  const stopped = await control.invoke(stopRequest, options)
  assert.equal(stopped.snapshot.stopped, true); assert.equal(stopped.snapshot.ownerKey, null)
  assert.equal((await control.acknowledge(stopRequest, stopped, options)).outcome, 'compacted')
  assert.deepEqual(await control.close(), { closed: true, pendingActual: 0, cleanupFailures: 0 })
  process.stdout.write(`${JSON.stringify({ test: 'browser-control-http-ledger', passed: true, realTcp: true,
    productionAuthentication: false, worker: false, browser: false, gpu: false, snapshotAckAttempts: 3 })}\n`)
} finally {
  deadline.abort(new Error('isolated HTTP client cleanup'))
  try {
    // Register every actual close barrier before initiating owned destruction.
    const closing = [...sockets.values()]
    for (const socket of sockets.keys()) socket.destroy()
    await Promise.all(closing); sockets.clear()
    if (control) { const result = await control.close(); assert.equal(result.closed, true); assert.equal(result.pendingActual, 0) }
  } finally { clearTimeout(timer) }
}
