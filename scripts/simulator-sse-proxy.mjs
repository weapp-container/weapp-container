import http from 'node:http'
import https from 'node:https'
import { setImmediate as nextTurn } from 'node:timers/promises'

const cleanupTimeoutMs = 3_000

/**
 * A task-owned loopback proxy for testing EventSource transport recovery.
 * Only /api/events is interrupted; every request remains pinned to targetUrl's
 * origin, including absolute-form incoming URLs. No ambient browser or server
 * resource is discovered, reused, or closed.
 */
export async function startSimulatorSseProxy(targetUrl) {
  const target = new URL(targetUrl)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new TypeError('simulator SSE proxy requires an HTTP(S) target without credentials')
  }
  const transport = target.protocol === 'https:' ? https : http
  const requests = new Set()
  const eventStreams = new Set()
  const sockets = new Map()
  let eventsOnline = true
  let closing = false
  let closePromise

  function ownSocket(socket) {
    if (sockets.has(socket)) return
    sockets.set(socket, new Promise(resolve => {
      socket.once('close', () => {
        sockets.delete(socket)
        resolve()
      })
    }))
    if (closing) socket.destroy()
  }

  function destroyExchange(exchange) {
    exchange.upstreamResponse?.destroy()
    exchange.upstreamRequest?.destroy()
    exchange.response.destroy()
  }

  function upstreamFailure(exchange) {
    const response = exchange.response
    if (closing || response.destroyed) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('simulator upstream unavailable\n')
  }

  const server = http.createServer((request, response) => {
    let incoming
    try {
      incoming = new URL(request.url, target.origin)
    } catch {
      response.writeHead(400)
      response.end('invalid request URL\n')
      return
    }
    const isEventStream = incoming.pathname === '/api/events'
    if (closing || (isEventStream && !eventsOnline)) {
      response.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '1',
        connection: 'close',
      })
      response.end('simulator event transport offline\n')
      return
    }

    const exchange = { response, upstreamRequest: undefined, upstreamResponse: undefined }
    requests.add(exchange)
    if (isEventStream) eventStreams.add(exchange)
    // A disconnected browser must not leave its upstream SSE request alive.
    response.once('close', () => {
      requests.delete(exchange)
      eventStreams.delete(exchange)
      exchange.upstreamResponse?.destroy()
      exchange.upstreamRequest?.destroy()
    })
    request.once('aborted', () => destroyExchange(exchange))
    request.on('error', () => destroyExchange(exchange))

    try {
      const upstreamRequest = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: request.method,
        path: `${incoming.pathname}${incoming.search}`,
        headers: { ...request.headers, host: target.host },
        // Do not borrow a global agent or leave a connection in its pool.
        agent: false,
      })
      exchange.upstreamRequest = upstreamRequest
      upstreamRequest.on('socket', ownSocket)
      upstreamRequest.on('error', () => upstreamFailure(exchange))
      upstreamRequest.on('response', upstreamResponse => {
        exchange.upstreamResponse = upstreamResponse
        upstreamResponse.on('error', () => upstreamFailure(exchange))
        if (closing || response.destroyed || (isEventStream && !eventsOnline)) {
          destroyExchange(exchange)
          return
        }
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
        response.flushHeaders()
        upstreamResponse.pipe(response)
      })
      request.pipe(upstreamRequest)
    } catch {
      upstreamFailure(exchange)
    }
  })
  server.on('connection', ownSocket)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()

  return {
    url: `http://127.0.0.1:${address.port}`,
    setEventsOnline(online) {
      if (typeof online !== 'boolean') throw new TypeError('events online state must be boolean')
      if (closing) return
      eventsOnline = online
      if (!online) {
        for (const exchange of eventStreams) destroyExchange(exchange)
      }
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      eventsOnline = false
      closePromise = (async () => {
        let timeout
        try {
          await Promise.race([
            (async () => {
              const listenerClosed = new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve())
              })
              for (const exchange of requests) destroyExchange(exchange)
              for (const socket of sockets.keys()) socket.destroy()
              await listenerClosed
              // A request assigned a socket on the next tick also belongs to us.
              await nextTurn()
              await Promise.all([...sockets.values()])
            })(),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('simulator SSE proxy cleanup timed out')), cleanupTimeoutMs)
            }),
          ])
        } finally {
          clearTimeout(timeout)
        }
        const report = {
          listenerClosed: !server.listening,
          activeRequests: requests.size,
          activeEventStreams: eventStreams.size,
          activeSockets: sockets.size,
        }
        if (!report.listenerClosed || report.activeRequests || report.activeEventStreams || report.activeSockets) {
          throw new Error(`simulator SSE proxy cleanup incomplete: ${JSON.stringify(report)}`)
        }
        return report
      })()
      return closePromise
    },
  }
}
