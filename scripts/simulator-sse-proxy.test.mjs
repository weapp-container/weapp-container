import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startSimulatorSseProxy } from './simulator-sse-proxy.mjs'

const cleanReport = { listenerClosed: true, activeRequests: 0, activeEventStreams: 0, activeSockets: 0 }

async function deadline(promise, label, timeoutMs = 1_500) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function until(predicate, label) {
  const expires = Date.now() + 1_500
  while (!predicate()) {
    if (Date.now() >= expires) throw new Error(`${label} timed out`)
    await delay(5)
  }
}

async function fixture() {
  const sockets = new Set()
  const requests = []
  const streams = []
  const heldResponses = []
  const server = http.createServer(async (request, response) => {
    const recorded = { path: request.url, method: request.method, headers: request.headers }
    requests.push(recorded)
    if (request.url.startsWith('/api/events')) {
      let resolveClosed
      const stream = { response, closed: new Promise(resolve => { resolveClosed = resolve }) }
      streams.push(stream)
      response.once('close', resolveClosed)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write(`retry: 10\nid: fixture-${streams.length}\nevent: ready\ndata: {"revision":${streams.length}}\n\n`)
    } else if (request.url === '/failure') {
      response.destroy()
    } else if (request.url === '/hang') {
      // Deliberately held until the proxy closes its owned upstream socket.
    } else if (request.url === '/hold') {
      heldResponses.push(response)
    } else {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      recorded.body = Buffer.concat(chunks).toString('utf8')
      response.writeHead(200, { 'content-type': 'application/json', 'x-fixture-header': 'preserved' })
      response.end(JSON.stringify(recorded))
    }
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let closed
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    streams,
    heldResponses,
    close() {
      closed ||= new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        for (const socket of sockets) socket.destroy()
      })
      return closed
    },
  }
}

async function cleanup(proxy, upstream) {
  try {
    if (proxy) assert.deepEqual(await proxy.close(), cleanReport)
  } finally {
    await upstream.close()
  }
}

function request(url, { method = 'GET', body, headers, path } = {}) {
  let handle
  const result = deadline(new Promise((resolve, reject) => {
    handle = http.request(url, { method, headers, ...(path === undefined ? {} : { path }), agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    handle.on('error', reject)
    handle.end(body)
  }), `HTTP ${method} ${url}`)
  return result.finally(() => handle.destroy())
}

async function eventStream(url, headers = {}) {
  let handle
  try {
    return await deadline(new Promise((resolve, reject) => {
      handle = http.get(`${url}/api/events?fixture=stream`, { headers, agent: false }, response => {
        let text = ''
        let resolveClosed
        const closed = new Promise(done => { resolveClosed = done })
        response.on('data', chunk => { text += chunk })
        response.on('error', () => {}) // Expected when the fault proxy severs SSE.
        response.once('close', resolveClosed)
        resolve({
          status: response.statusCode,
          get text() { return text },
          closed,
          close() { response.destroy(); handle.destroy() },
        })
      })
      handle.on('error', reject)
    }), 'open SSE')
  } catch (error) {
    handle?.destroy()
    throw error
  }
}

test('SSE transport faults close only owned streams; online restores forwarding with Last-Event-ID', { timeout: 8_000 }, async () => {
  const upstream = await fixture()
  let proxy
  let first
  let second
  try {
    proxy = await startSimulatorSseProxy(upstream.url)
    assert.equal(new URL(proxy.url).hostname, '127.0.0.1')
    first = await eventStream(proxy.url, { 'last-event-id': 'previous-revision', 'x-fixture-request': 'present' })
    assert.equal(first.status, 200)
    await until(() => first.text.includes('"revision":1'), 'initial SSE data')
    assert.equal(upstream.requests[0].headers['last-event-id'], 'previous-revision')
    assert.equal(upstream.requests[0].headers['x-fixture-request'], 'present')
    assert.equal(upstream.requests[0].path, '/api/events?fixture=stream')

    const held = request(`${proxy.url}/hold`).then(value => ({ value }), error => ({ error }))
    await until(() => upstream.heldResponses.length === 1, 'unrelated in-flight HTTP request')
    proxy.setEventsOnline(false)
    await deadline(first.closed, 'downstream SSE closure')
    await deadline(upstream.streams[0].closed, 'upstream SSE closure')
    const offline = await request(`${proxy.url}/api/events`)
    assert.equal(offline.status, 503)
    assert.equal(upstream.streams.length, 1, 'offline retries do not reach the simulator')
    upstream.heldResponses[0].end('unrelated transport survived')
    assert.equal((await held).value?.body, 'unrelated transport survived', 'fault only severs SSE transports')
    const state = await request(`${proxy.url}/api/state?revision=1`)
    assert.equal(state.status, 200, 'regular HTTP remains available during the SSE fault')
    assert.equal(JSON.parse(state.body).path, '/api/state?revision=1')

    proxy.setEventsOnline(true)
    second = await eventStream(proxy.url, { 'last-event-id': 'fixture-1' })
    await until(() => second.text.includes('"revision":2'), 'restored SSE data')
    assert.equal(upstream.requests.at(-1).headers['last-event-id'], 'fixture-1')
    assert.deepEqual(await proxy.close(), cleanReport)
    await deadline(second.closed, 'cleanup downstream SSE closure')
    await deadline(upstream.streams[1].closed, 'cleanup upstream SSE closure')
    assert.deepEqual(await proxy.close(), cleanReport, 'close is idempotent')
    await assert.rejects(request(`${proxy.url}/api/state`), { code: 'ECONNREFUSED' })
  } finally {
    first?.close()
    second?.close()
    await cleanup(proxy, upstream)
  }
})

test('all routes, JSON headers and POST bytes forward to the exact target origin', { timeout: 8_000 }, async () => {
  const upstream = await fixture()
  let proxy
  try {
    proxy = await startSimulatorSseProxy(upstream.url)
    const snapshot = await request(`${proxy.url}/api/snapshot?revision=7`)
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.headers['x-fixture-header'], 'preserved')
    assert.equal(JSON.parse(snapshot.body).path, '/api/snapshot?revision=7')
    const body = '{"op":"event.batch","payload":{"label":"小程序"}}'
    const bridge = await request(`${proxy.url}/api/bridge`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-trace-id': 'fixture' },
    })
    const forwarded = JSON.parse(bridge.body)
    assert.equal(forwarded.method, 'POST')
    assert.equal(forwarded.body, body)
    assert.equal(forwarded.headers['content-type'], 'application/json')
    assert.equal(forwarded.headers['x-trace-id'], 'fixture')
    assert.equal(forwarded.headers.host, new URL(upstream.url).host)

    const absolute = await request(proxy.url, { path: 'http://unrelated.invalid/api/state?absolute=1' })
    assert.equal(absolute.status, 200)
    assert.equal(JSON.parse(absolute.body).path, '/api/state?absolute=1')
    assert.equal(JSON.parse(absolute.body).headers.host, new URL(upstream.url).host)
    assert.throws(() => proxy.setEventsOnline('false'), /must be boolean/)
  } finally {
    await cleanup(proxy, upstream)
  }
})

test('upstream failure and an unfinished request still release every owned resource', { timeout: 8_000 }, async () => {
  const upstream = await fixture()
  let proxy
  let hanging
  try {
    proxy = await startSimulatorSseProxy(upstream.url)
    const failed = await request(`${proxy.url}/failure`)
    assert.equal(failed.status, 502)
    assert.match(failed.body, /upstream unavailable/)
    hanging = request(`${proxy.url}/hang`).then(
      () => { throw new Error('unfinished request unexpectedly completed') },
      error => error,
    )
    await until(() => upstream.requests.some(entry => entry.path === '/hang'), 'unfinished upstream request')
    assert.deepEqual(await proxy.close(), cleanReport)
    const aborted = await hanging
    assert.ok(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(aborted.code), aborted.message)
    await assert.rejects(request(`${proxy.url}/api/state`), { code: 'ECONNREFUSED' })
  } finally {
    try {
      await cleanup(proxy, upstream)
    } finally {
      if (hanging) await hanging
    }
  }
})

test('an unavailable upstream fails explicitly and target validation creates no listener', { timeout: 8_000 }, async () => {
  const upstream = await fixture()
  await upstream.close()
  let proxy
  try {
    proxy = await startSimulatorSseProxy(upstream.url)
    assert.equal((await request(`${proxy.url}/api/state`)).status, 502)
    assert.deepEqual(await proxy.close(), cleanReport)
    await assert.rejects(startSimulatorSseProxy('file:///tmp/simulator'), /HTTP\(S\)/)
    await assert.rejects(startSimulatorSseProxy('http://user:secret@127.0.0.1'), /without credentials/)
  } finally {
    await cleanup(proxy, upstream)
  }
})
