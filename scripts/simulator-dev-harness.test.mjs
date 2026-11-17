import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { connectDevEvents, installSmokeSignals, readDevSessionPaths, SimulatorHttpError, startDevSimulator } from './simulator-dev-harness.mjs'

const sleep = ms => new Promise(done => setTimeout(done, ms))

function sessionPathsFixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weapp-dev-paths-')))
  const project = resolve(root, 'project')
  const staging = resolve(project, '.weapp-container', 'owned-staging')
  const sessionId = 'owned-session'
  const runRoot = resolve(staging, 'runs', sessionId)
  const preparationRoot = realpathSync(mkdtempSync(resolve(tmpdir(), `weapp-simulator-preparation-${process.pid}-`)))
  const compilerOutput = resolve(preparationRoot, '.build-output')
  mkdirSync(runRoot, { recursive: true })
  mkdirSync(compilerOutput)
  writeFileSync(resolve(compilerOutput, 'app.json'), '{"pages":["pages/home/index"]}')
  const paths = { schemaVersion: 1, sessionId, ownerPid: process.pid, publicationRoot: realpathSync(runRoot), preparationRoot, compilerOutput }
  const write = patch => writeFileSync(resolve(runRoot, 'dev-session.json'), JSON.stringify({ ...paths, ...patch }))
  write({})
  t.after(() => {
    rmSync(preparationRoot, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  return { root, project, staging, runRoot, paths, write }
}

test('explicit raw output metadata locates preparation outside project and expires with cleanup', t => {
  const f = sessionPathsFixture(t)
  assert.deepEqual(readDevSessionPaths(f.staging, process.pid, f.project), { ...f.paths, runRoot: f.runRoot })
  assert.equal(readFileSync(resolve(f.paths.compilerOutput, 'app.json'), 'utf8'), '{"pages":["pages/home/index"]}')
  rmSync(f.paths.preparationRoot, { recursive: true })
  assert.throws(() => readDevSessionPaths(f.staging, process.pid, f.project), { code: 'ENOENT' })
  assert.ok(existsSync(resolve(f.runRoot, 'dev-session.json')), 'published provenance survives disposable preparation')
})

test('raw output metadata rejects foreign child, run, preparation and ambiguous staging ownership', t => {
  const f = sessionPathsFixture(t)
  for (const patch of [
    { schemaVersion: 2 }, { ownerPid: process.pid + 1 }, { sessionId: 'foreign-session' },
    { publicationRoot: f.root }, { preparationRoot: f.project }, { compilerOutput: f.root },
  ]) {
    f.write(patch)
    assert.throws(() => readDevSessionPaths(f.staging, process.pid, f.project), /development session|preparation/)
  }
  f.write({})
  mkdirSync(resolve(f.staging, 'runs', 'foreign-run'))
  assert.throws(() => readDevSessionPaths(f.staging, process.pid, f.project), /exactly one run/)
})

// A real, separately spawned HTTP process exercises listener ownership and
// cancellation. It understands the normal cargo/CLI arguments, so these tests
// never need to build Rust, borrow a developer port, or change process.env.
const FAKE_SIMULATOR = String.raw`
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let stateRequest = 0
const args = process.argv.slice(3)
const value = flag => args[args.indexOf(flag) + 1]
const requestedPort = Number(value('--port'))
const record = data => {
  writeFileSync(config.marker + '.pending', JSON.stringify({ pid: process.pid, args, ...data }))
  renameSync(config.marker + '.pending', config.marker)
}
record({ phase: 'starting', staging: value('--out-dir') })
if (config.exitBeforeListen) {
  process.stderr.write('fixture compiler failed before listener\n')
  process.exit(23)
}
const server = createServer((request, response) => {
  appendFileSync(config.requests, request.url + '\n')
  if (request.url === '/api/events') {
    if (config.stallSseHeaders) return
    response.writeHead(config.sseStatus || 200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    const chunks = config.sseChunks || []
    let index = 0
    const send = () => {
      if (response.destroyed || index >= chunks.length) return
      response.write(chunks[index++])
      setTimeout(send, 20)
    }
    send()
    return
  }
  if (request.url === '/api/state' && config.stallState) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"status":')
    return
  }
  if (request.url === '/api/state') {
    const observation = config.stateResponses?.[Math.min(stateRequest++, config.stateResponses.length - 1)]
    response.writeHead(observation?.status || config.stateStatus || 200, { 'content-type': 'application/json' })
    if (observation?.stall) {
      response.write('{"status":')
      return
    }
    response.end(JSON.stringify({ status: 'ready', revision: 1, sessionId: 'owned-session', pid: process.pid, ...observation?.state }))
    return
  }
  if (request.url === '/api/bridge') {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ method: request.method, payload: JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    return
  }
  response.writeHead(404)
  response.end()
})
server.on('error', error => {
  process.stderr.write(error.code + ': fixture could not bind\n')
  process.exit(24)
})
server.listen(config.bindPort ?? requestedPort, '127.0.0.1', () => {
  const actualPort = server.address().port
  const url = 'http://127.0.0.1:' + actualPort + '/'
  record({ phase: 'listening', url, staging: value('--out-dir') })
  if (config.noAnnouncement) return
  setTimeout(() => {
    const announcedUrl = config.announcedUrl || url
    const stream = config.stdoutAnnouncement ? process.stdout : process.stderr
    stream.write('weapp-simulator: web surface ' + announcedUrl + '\n')
    if (config.exitAfterAnnouncement) setTimeout(() => process.exit(0), 150)
  }, config.announceDelayMs || 0)
})
process.on('SIGTERM', () => {
  server.closeAllConnections()
  server.close(() => process.exit(0))
})
`

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function until(predicate, label) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`fixture did not reach ${label}`)
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weapp-dev-harness-')))
  const project = resolve(root, 'project with spaces')
  mkdirSync(project)
  const script = resolve(root, 'fake simulator.mjs')
  writeFileSync(script, FAKE_SIMULATOR)
  const launches = []
  const sessions = []
  t.after(async () => {
    const errors = []
    for (const session of sessions.reverse()) {
      try { await session.stop() } catch (error) { errors.push(error) }
      // A test may deliberately retain its owned publication directory;
      // these now live outside the fixture's watched project.
      rmSync(session.staging, { recursive: true, force: true })
    }
    // The marker is written by this fixture's child, never inferred from a port
    // or executable name. Reap only that child if a failed assertion interrupted
    // normal stop, and make any leak visible as a test failure.
    for (const launch of launches) {
      if (!existsSync(launch.marker)) continue
      const { pid } = JSON.parse(readFileSync(launch.marker, 'utf8'))
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL')
        errors.push(new Error(`fixture child ${pid} survived simulator cleanup`))
      }
    }
    rmSync(root, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed')
  })
  const launch = (config = {}) => {
    const index = launches.length
    const marker = resolve(root, `child-${index}.json`)
    const requestsPath = resolve(root, `requests-${index}.log`)
    const configPath = resolve(root, `config-${index}.json`)
    writeFileSync(configPath, JSON.stringify({ ...config, marker, requests: requestsPath }))
    const options = {
      root, project, timeoutMs: 2_000,
      launcher: { command: process.execPath, prefixArgs: [script, configPath] },
    }
    const result = {
      marker, options,
      info: () => existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null,
      requests: () => existsSync(requestsPath) ? readFileSync(requestsPath, 'utf8').trim().split('\n').filter(Boolean) : [],
    }
    launches.push(result)
    return result
  }
  return {
    root, project, launch,
    track(session) { sessions.push(session); return session },
    async start(config = {}, options = {}) {
      const child = launch(config)
      const session = await startDevSimulator({ ...child.options, ...options })
      sessions.push(session)
      return { ...child, session }
    },
  }
}

async function foreignServer(t) {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ready', revision: 999, owner: 'foreign' }))
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
  })
  const port = server.address().port
  return { port, url: `http://127.0.0.1:${port}/`, requests: () => requests }
}

test('startup waits for its own listener announcement before requesting state', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const child = f.launch({ announceDelayMs: 350 })
  let resolved = false
  const pending = startDevSimulator(child.options).then(session => { resolved = true; return session })
  const info = await until(() => child.info()?.phase === 'listening' && child.info(), 'listener without announcement')
  assert.equal(resolved, false)
  assert.deepEqual(child.requests(), [], 'the listening port is not proof of ownership')
  const session = f.track(await pending)
  assert.equal(session.url, info.url)
  const state = await session.waitForState(value => value.status === 'ready', 'first ready generation')
  assert.equal(state.pid, session.child.pid)
  assert.deepEqual(child.requests(), ['/api/state'])
  const args = child.info().args
  assert.equal(args[args.indexOf('--port') + 1], '0', 'port allocation must remain atomic')
  assert.equal(args[args.indexOf('--project') + 1], f.project)
  assert.equal(args[args.indexOf('--out-dir') + 1], session.staging)
  assert.equal(args[args.indexOf('--node-bin') + 1], process.execPath)
  assert.equal(args[args.indexOf('--engine') + 1], 'quickjs')
  assert.ok(args.includes('--locked'))
  assert.equal(args[args.indexOf('--features') + 1], 'quickjs-native')
  const posted = await session.json('/api/bridge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'diagnostic' }),
  })
  assert.deepEqual(posted, { method: 'POST', payload: { op: 'diagnostic' } })
  const firstStop = session.stop()
  assert.equal(firstStop, session.stop(), 'repeated stop shares the same completion')
  await firstStop
  assert.equal(alive(info.pid), false)
  assert.equal(existsSync(session.staging), false)
  assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
  await assert.rejects(fetch(session.url, { signal: AbortSignal.timeout(200) }))
})

test('an explicit verified compiler can be selected without changing the shared vendor checkout', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const compiler = resolve(f.root, 'clean compiler', 'bin', 'wv.mjs')
  const child = await f.start({}, { wvBin: compiler, viewport: '240x200' })
  const args = child.info().args
  assert.equal(args.filter(value => value === '--wv-bin').length, 1)
  assert.equal(args[args.indexOf('--wv-bin') + 1], compiler)
  assert.equal(args[args.indexOf('--viewport') + 1], '240x200')
  assert.ok(args.includes('--software'), 'legacy smoke deliberately selects CPU RGBA')
})

test('remote CanvasKit smoke supplies explicit assets and cannot silently enable software rendering', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const assets = resolve(f.root, 'renderer assets')
  const child = await f.start({}, { rendererAssets: assets })
  const args = child.info().args
  assert.equal(args[args.indexOf('--renderer-assets') + 1], assets)
  assert.equal(args.includes('--software'), false)
})

test('DOM smoke launches the WebView adapter without a software or CanvasKit fallback', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const child = await f.start({}, { renderer: 'webview' })
  const args = child.info().args
  assert.equal(args[args.indexOf('--renderer') + 1], 'webview')
  assert.equal(args.includes('--software'), false)
  assert.equal(args.includes('--renderer-assets'), false)
})

test('an immutable simulator binary skips Cargo while retaining listener ownership and cleanup', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const child = f.launch()
  const session = f.track(await startDevSimulator({ ...child.options, engine: 'v8',
    launcher: { ...child.options.launcher, mode: 'simulator' } }))
  const args = child.info().args
  assert.equal(args[0], 'dev')
  assert.equal(args.includes('run'), false)
  assert.equal(args.includes('--features'), false)
  assert.equal(args[args.indexOf('--engine') + 1], 'v8')
  assert.equal((await session.json('/api/state')).pid, session.child.pid)
  await session.stop()
  assert.equal(alive(child.info().pid), false)
  assert.equal(existsSync(session.staging), false)
})

test('occupied requested port fails without querying or stopping its existing owner', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const foreign = await foreignServer(t)
  const shared = resolve(f.project, '.weapp-container', 'simulator-dev-smoke')
  mkdirSync(shared, { recursive: true })
  const sentinel = resolve(shared, 'keep.txt')
  writeFileSync(sentinel, 'belongs to a previous run')
  const child = f.launch()
  await assert.rejects(startDevSimulator({ ...child.options, port: foreign.port }), /EADDRINUSE|exited/)
  assert.equal(foreign.requests(), 0, 'neither startup nor failure cleanup may probe the existing service')
  assert.equal(alive(child.info().pid), false)
  assert.deepEqual(readdirSync(resolve(f.project, '.weapp-container')), ['simulator-dev-smoke'])
  assert.equal(readFileSync(sentinel, 'utf8'), 'belongs to a previous run')
  const response = await fetch(foreign.url, { signal: AbortSignal.timeout(500) })
  assert.equal((await response.json()).owner, 'foreign', 'the pre-existing owner remains usable')
})

test('each concurrent launch owns unique staging while old and retained directories survive', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const shared = resolve(f.project, '.weapp-container', 'simulator-dev-browser-smoke')
  mkdirSync(shared, { recursive: true })
  writeFileSync(resolve(shared, 'keep.txt'), 'developer data')
  const first = await f.start()
  const second = await f.start({}, { engine: 'v8' })
  assert.notEqual(first.session.staging, second.session.staging)
  assert.notEqual(first.session.url, second.session.url)
  assert.equal(second.info().args[second.info().args.indexOf('--features') + 1], 'quickjs-native,v8-native')
  assert.equal(second.info().args[second.info().args.indexOf('--engine') + 1], 'v8')
  await first.session.stop()
  assert.equal(existsSync(first.session.staging), false)
  assert.equal((await second.session.json('/api/state')).sessionId, 'owned-session')
  await second.session.stop({ keep: true })
  assert.equal(existsSync(second.session.staging), true)
  assert.equal(readFileSync(resolve(shared, 'keep.txt'), 'utf8'), 'developer data')
  assert.deepEqual(readdirSync(resolve(f.project, '.weapp-container')).sort(), [
    'simulator-dev-browser-smoke',
  ].sort())
})

for (const [name, config] of [
  ['no announcement', { noAnnouncement: true }],
  ['a stdout lookalike announcement', { stdoutAnnouncement: true }],
]) {
  test(`startup timeout rejects ${name} and reaps only its child`, { timeout: 5_000 }, async t => {
    const f = fixture(t)
    const child = f.launch(config)
    const started = Date.now()
    await assert.rejects(startDevSimulator({ ...child.options, timeoutMs: 300 }), /timed out.*announcement/)
    assert.ok(Date.now() - started < 2_000, 'startup timeout must include process cleanup')
    assert.deepEqual(child.requests(), [], 'a port or stdout log alone never authorizes an HTTP request')
    assert.equal(alive(child.info().pid), false)
    assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
    await assert.rejects(fetch(child.info().url, { signal: AbortSignal.timeout(200) }))
  })
}

test('an announcement with an unexpected port fails before any foreign request', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const foreign = await foreignServer(t)
  const child = f.launch({ bindPort: 0 })
  await assert.rejects(startDevSimulator({ ...child.options, port: foreign.port }), /unexpected port/)
  assert.equal(foreign.requests(), 0)
  assert.deepEqual(child.requests(), [])
  assert.equal(alive(child.info().pid), false)
  assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
})

test('invalid announced host times out without contacting the announced foreign service', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const foreign = await foreignServer(t)
  const child = f.launch({ announcedUrl: foreign.url.replace('127.0.0.1', 'localhost') })
  await assert.rejects(startDevSimulator({ ...child.options, timeoutMs: 300 }), /timed out.*announcement/)
  assert.equal(foreign.requests(), 0)
  assert.equal(alive(child.info().pid), false)
})

test('early exit and spawn failure remove only their own temporary staging', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const child = f.launch({ exitBeforeListen: true })
  await assert.rejects(startDevSimulator(child.options), /exited.*23[\s\S]*fixture compiler failed/)
  assert.equal(alive(child.info().pid), false)
  assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
  await assert.rejects(startDevSimulator({
    root: f.root, project: f.project, timeoutMs: 300,
    launcher: { command: resolve(f.root, 'missing executable'), prefixArgs: [] },
  }), /ENOENT/)
  assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
})

test('invalid engine is rejected before creating staging or starting a child', async t => {
  const f = fixture(t)
  const child = f.launch()
  await assert.rejects(startDevSimulator({ ...child.options, engine: 'unavailable-engine' }), /invalid engine/)
  assert.equal(existsSync(child.marker), false)
  assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
})

test('first stop observes a child that already exited without waiting for a missed event', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session } = await f.start({ exitAfterAnnouncement: true })
  await until(() => session.child.exitCode === 0, 'spontaneous child exit')
  const started = Date.now()
  await session.stop()
  // stop also verifies listener closure with its own 1 s HTTP deadline.
  // Windows may spend most of that budget rejecting the closed TCP port;
  // leave 500 ms for cleanup while still rejecting a missed exit event's
  // 10 s process wait. This is a lifecycle check, not TCP latency acceptance.
  assert.ok(Date.now() - started < 1_500)
  assert.equal(alive(session.child.pid), false)
  assert.equal(existsSync(session.staging), false)
  await assert.rejects(session.json('/api/state'), /exited/)
})

test('state and JSON body deadlines bound an unresponsive listener', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session } = await f.start({ stallState: true })
  let started = Date.now()
  await assert.rejects(session.json('/api/state', { timeout: 120 }), /timeout|aborted/i)
  assert.ok(Date.now() - started < 1_500)
  started = Date.now()
  await assert.rejects(session.waitForState(() => true, 'stalled initial generation', 150), /timed out waiting for stalled initial generation/)
  assert.ok(Date.now() - started < 1_500, 'polling cannot wait longer than its absolute deadline')
  await session.stop()
  assert.equal(alive(session.child.pid), false)
})

test('HTTP errors remain visible and waiting on an exited child fails promptly', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session } = await f.start({ stateStatus: 503 })
  await assert.rejects(session.json('/api/state'), error => {
    assert.ok(error instanceof SimulatorHttpError)
    assert.equal(error.code, 'ERR_SIMULATOR_HTTP')
    assert.equal(error.path, '/api/state')
    assert.equal(error.status, 503)
    assert.equal(error.method, 'GET')
    assert.match(error.message, /\/api\/state HTTP 503/)
    return true
  })
  await assert.rejects(session.waitForState(() => true, 'ready after 503', 120), /timed out.*HTTP 503/)
  await session.stop()
  const started = Date.now()
  await assert.rejects(session.waitForState(() => true, 'already exited'), /exited/)
  await session.stop()
  assert.ok(Date.now() - started < 500, 'stop and state must observe an exit event that already happened')
})

test('a final transport deadline preserves the preceding observed HTTP failure', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session, requests } = await f.start({ stateResponses: [{ status: 503 }, { stall: true }] })
  await assert.rejects(session.waitForState(() => true, '503 followed by a stalled body', 350), error => {
    assert.equal(error.code, 'ERR_SIMULATOR_STATE_TIMEOUT')
    assert.equal(error.lastHttpError.status, 503)
    assert.equal(error.lastRequestError.code, 'ERR_SIMULATOR_REQUEST_TIMEOUT')
    assert.equal(error.cause, error.lastRequestError)
    assert.match(error.message, /last HTTP failure: \/api\/state HTTP 503/)
    assert.match(error.message, /last request: \/api\/state request timed out/)
    return true
  })
  assert.equal(requests().filter(path => path === '/api/state').length, 2)
  await session.stop()
})

test('valid state JSON clears an older HTTP failure before a later transport timeout', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session, requests } = await f.start({ stateResponses: [
    { status: 503 }, { status: 200, state: { status: 'building' } }, { stall: true },
  ] })
  await assert.rejects(session.waitForState(state => state.status === 'ready', 'state after HTTP recovery', 450), error => {
    assert.equal(error.code, 'ERR_SIMULATOR_STATE_TIMEOUT')
    assert.equal(error.lastHttpError, undefined)
    assert.equal(error.lastRequestError.code, 'ERR_SIMULATOR_REQUEST_TIMEOUT')
    assert.doesNotMatch(error.message, /503/)
    assert.match(error.message, /last request: \/api\/state request timed out/)
    return true
  })
  assert.equal(requests().filter(path => path === '/api/state').length, 3)
  await session.stop()
})

test('silent SSE connection has an absolute deadline and can be closed after timeout', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session } = await f.start()
  const events = await connectDevEvents(session.url, 150)
  t.after(() => events.close())
  const started = Date.now()
  await assert.rejects(events.nextEvent('reload'), /timed out|abort/i)
  assert.ok(Date.now() - started < 1_500, 'reader.read must be interrupted even if the server sends nothing')
  await events.close()
  await events.close()
})

test('SSE parser accepts fragmented CRLF frames and closes its owned stream', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session } = await f.start({ sseChunks: [
    ': keepalive\r', '\n\r', '\nevent: ready\r\ndata: {"revision":1}\r\n\r\n',
    'event: reload\r', '\ndata: {"revision":2,"kind":"InPlace"}\r', '\n\r', '\n',
  ] })
  const events = await connectDevEvents(session.url, 1_000)
  t.after(() => events.close())
  assert.deepEqual(await events.nextEvent('ready'), { revision: 1 })
  assert.deepEqual(await events.nextEvent('reload'), { revision: 2, kind: 'InPlace' })
  await events.close()
})

test('SSE HTTP failures reject without leaving a live timer or stream', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session } = await f.start({ sseStatus: 503 })
  await assert.rejects(connectDevEvents(session.url, 100), /SSE HTTP 503/)
  await session.stop()
})

test('signal installation and disposal preserve every pre-existing process listener', () => {
  const before = new Map(['SIGINT', 'SIGTERM'].map(name => [name, process.listeners(name)]))
  const signals = installSmokeSignals()
  assert.equal(signals.signal.aborted, false)
  for (const [name, listeners] of before) assert.equal(process.listenerCount(name), listeners.length + 1)
  signals.dispose()
  signals.dispose()
  for (const [name, listeners] of before) assert.deepEqual(process.listeners(name), listeners)
})

test('an already-cancelled startup creates neither staging nor child', async t => {
  const f = fixture(t)
  const child = f.launch()
  const controller = new AbortController()
  const reason = new Error('cancelled before startup')
  controller.abort(reason)
  await assert.rejects(startDevSimulator({ ...child.options, signal: controller.signal }), error => error === reason)
  assert.equal(existsSync(child.marker), false)
  assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
})

test('stop cancels an in-flight JSON body while completing process and listener cleanup', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session, requests } = await f.start({ stallState: true })
  const rejected = assert.rejects(session.json('/api/state', { timeout: 60_000 }), /simulator stopped|abort/i)
  await until(() => requests().includes('/api/state'), 'in-flight state body')
  await session.stop()
  await rejected
  assert.equal(alive(session.child.pid), false)
  assert.equal(existsSync(session.staging), false)
})

test('external cancellation interrupts SSE headers before a stream is established', { timeout: 5_000 }, async t => {
  const f = fixture(t)
  const { session, requests } = await f.start({ stallSseHeaders: true })
  const controller = new AbortController()
  const reason = new Error('cancelled SSE handshake')
  const rejected = assert.rejects(connectDevEvents(session.url, 60_000, { signal: controller.signal }), error => error === reason)
  await until(() => requests().includes('/api/events'), 'SSE handshake')
  controller.abort(reason)
  await rejected
  await session.stop()
})

const SIGNAL_RUNNER = String.raw`
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const { installSmokeSignals, startDevSimulator, connectDevEvents } = await import(config.harness)
const signals = installSmokeSignals()
const original = readFileSync(config.source, 'utf8')
const modified = 'temporary invalid source during smoke\n'
let simulator
let events
let state = {}
const record = next => {
  state = { ...state, ...next }
  writeFileSync(config.runnerMarker + '.pending', JSON.stringify(state))
  renameSync(config.runnerMarker + '.pending', config.runnerMarker)
}
try {
  signals.signal.throwIfAborted()
  writeFileSync(config.source, modified)
  record({ phase: 'starting', pid: process.pid })
  simulator = await startDevSimulator({ ...config.options, timeoutMs: 60_000, signal: signals.signal })
  record({ phase: config.mode, url: simulator.url, staging: simulator.staging, childPid: simulator.child.pid })
  if (config.mode === 'sse') {
    events = await connectDevEvents(simulator.url, 60_000, { signal: signals.signal })
    await events.nextEvent('reload')
  } else {
    await simulator.waitForState(() => false, 'cancelled generation', 60_000)
  }
  throw new Error('cancelled smoke unexpectedly continued')
} catch (error) {
  record({ error: error.message, signal: signals.signal.reason?.signal, code: signals.signal.reason?.code })
  if (!signals.signal.aborted) process.exitCode = 1
} finally {
  try {
    if (readFileSync(config.source, 'utf8') !== modified) throw new Error('fixture source ownership changed')
    writeFileSync(config.source, original)
    if (events) await events.close()
    const cleanup = await simulator?.stop()
    record({ phase: 'finished', finallyRan: true, cleanup })
  } finally { signals.dispose() }
}
`

for (const signalName of ['SIGINT', 'SIGTERM']) {
  for (const mode of ['startup', 'state', 'sse']) {
    test(`${signalName} during ${mode} runs finally, restores source, and releases its child and port`, {
      timeout: 5_000,
      skip: process.platform === 'win32' ? 'Windows process.kill does not deliver a catchable POSIX terminal signal' : false,
    }, async t => {
      const f = fixture(t)
      const child = f.launch(mode === 'startup' ? { noAnnouncement: true } : mode === 'state' ? { stallState: true } : {})
      const source = resolve(f.project, 'app.json')
      const original = '{"pages":["pages/index"]}\n'
      writeFileSync(source, original)
      const runnerMarker = resolve(f.root, 'signal-runner.json')
      const runnerScript = resolve(f.root, 'signal-runner.mjs')
      const runnerConfig = resolve(f.root, 'signal-runner-config.json')
      writeFileSync(runnerScript, SIGNAL_RUNNER)
      writeFileSync(runnerConfig, JSON.stringify({
        harness: pathToFileURL(resolve('scripts/simulator-dev-harness.mjs')).href,
        source, runnerMarker, options: child.options, mode,
      }))
      const runner = spawn(process.execPath, [runnerScript, runnerConfig], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      runner.stdout.on('data', chunk => { output += chunk })
      runner.stderr.on('data', chunk => { output += chunk })
      const exited = new Promise((done, reject) => {
        runner.once('error', reject)
        runner.once('exit', (code, signal) => done({ code, signal }))
      })
      t.after(async () => {
        if (runner.exitCode == null && runner.signalCode == null) runner.kill('SIGKILL')
        await exited
      })
      const info = await until(() => child.info()?.phase === 'listening' && child.info(), 'signal fixture listener')
      if (mode === 'state') await until(() => child.requests().includes('/api/state'), 'blocked JSON body')
      if (mode === 'sse') await until(() => child.requests().includes('/api/events'), 'blocked SSE read')
      assert.notEqual(readFileSync(source, 'utf8'), original, 'signal must interrupt an actual source mutation')
      assert.equal(alive(info.pid), true)
      assert.equal(runner.kill(signalName), true)
      let deadline
      let result
      try {
        result = await Promise.race([
          exited,
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`signal fixture did not finish: ${output}`)), 3_000) }),
        ])
      } finally { clearTimeout(deadline) }
      assert.deepEqual(result, { code: signalName === 'SIGINT' ? 130 : 143, signal: null }, output)
      const recorded = JSON.parse(readFileSync(runnerMarker, 'utf8'))
      assert.equal(recorded.phase, 'finished', output)
      assert.equal(recorded.finallyRan, true)
      assert.equal(recorded.signal, signalName)
      assert.equal(recorded.code, 'ERR_SMOKE_INTERRUPTED')
      assert.equal(readFileSync(source, 'utf8'), original)
      assert.equal(alive(info.pid), false, 'cancellation cannot skip child reaping')
      assert.equal(existsSync(info.staging), false)
      assert.equal(existsSync(resolve(f.project, '.weapp-container')), false)
      await assert.rejects(fetch(info.url, { signal: AbortSignal.timeout(200) }))
    })
  }
}
