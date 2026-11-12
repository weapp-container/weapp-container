import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { recordedEvents } from './dataset-values-smoke.mjs'

// Every server and socket below belongs to this test; no shared listener or
// browser is borrowed. Finally cleanup also runs on assertions/timeouts.
async function ownedServer(handler) {
  const sockets = new Set(), server = createServer(handler)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      const closed = [...sockets].map(socket => new Promise(resolve => {
        if (socket.closed) resolve()
        else socket.once('close', resolve)
      }))
      for (const socket of sockets) socket.destroy()
      await Promise.all([stopped, ...closed])
      assert.equal(server.listening, false, 'owned listener is closed')
      assert.equal(sockets.size, 0, 'every owned socket is closed')
    },
  }
}

async function beforeDeadline(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

test('SSE handshake times out when a real HTTP server sends no response headers', { timeout: 5_000 }, async () => {
  let requests = 0
  const owned = await ownedServer((request, response) => {
    requests++
    assert.equal(request.url, '/api/events')
    assert.equal(request.headers.accept, 'text/event-stream')
    // Intentionally no writeHead/flushHeaders/end: the connected request is
    // accepted, but the SSE handshake never completes.
  })
  try {
    await assert.rejects(recordedEvents(owned.url, { timeoutMs: 300 }), error => {
      assert.equal(error.name, 'TimeoutError')
      assert.equal(error.code, 'ERR_SSE_CONNECT_TIMEOUT')
      assert.equal(error.timeoutMs, 300)
      assert.match(error.message, /SSE response headers/)
      return true
    })
    assert.equal(requests, 1, 'the timeout follows an actual accepted HTTP request')
  } finally { await owned.close() }
})

test('SSE connection deadline is cleared after headers and leaves an established stream alive', { timeout: 5_000 }, async () => {
  let response, stream, resolveResponseClosed
  const responseClosed = new Promise(resolve => { resolveResponseClosed = resolve })
  const owned = await ownedServer((request, outgoing) => {
    assert.equal(request.url, '/api/events')
    response = outgoing
    outgoing.once('close', resolveResponseClosed)
    outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    outgoing.flushHeaders()
    outgoing.write('event: ready\ndata: {"phase":"headers-received"}\n\n')
  })
  try {
    const timeoutMs = 200
    stream = await recordedEvents(owned.url, { timeoutMs })
    assert.deepEqual(await stream.nextEvent('ready'), { phase: 'headers-received' })
    // No pending nextEvent wait exists while the stream outlives several
    // connection deadlines. A timeout applied to the whole fetch would abort.
    await delay(timeoutMs * 3)
    assert.equal(stream.failure, null, 'accepted stream is not aborted by the handshake deadline')
    response.write('event: late\ndata: {"phase":"after-connect-deadline"}\n\n')
    assert.deepEqual(await stream.nextEvent('late'), { phase: 'after-connect-deadline' })
    assert.deepEqual(stream.events.map(event => event.type), ['ready', 'late'])
    assert.match(stream.bytes().toString(), /after-connect-deadline/)
  } finally {
    try {
      if (stream) {
        await stream.close() // Cancels the actual fetch reader before server cleanup.
        await beforeDeadline(responseClosed, 2_000, 'reader cancellation to close its HTTP response')
      }
    } finally { await owned.close() }
  }
})
