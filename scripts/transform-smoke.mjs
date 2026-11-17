#!/usr/bin/env node
/** Real pinned compiler -> development supervisor -> native-engine transforms. */
import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, platform, release, arch } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { canonicalize } from '../tools/container-manifest/src/index.ts'
import { createOwnedCommandRunner, sha256, sourceHashes } from './simulator-cli-harness.mjs'
import { installSmokeSignals, readDevSessionPaths, startDevSimulator } from './simulator-dev-harness.mjs'
import { validateCompiler } from './scrolling-smoke.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'examples/apps/transform-app')
const ROUTE = 'pages/home/index'
const WIDTH = 320, HEIGHT = 400
export const TRANSFORM_PHASES = Object.freeze(['small', 'large', 'small-again', 'rotated-small', 'none', 'reset'])
const COLORS = { white: [255, 255, 255, 255], red: [255, 0, 0, 255], blue: [0, 0, 255, 255],
  green: [0, 128, 0, 255], yellow: [255, 255, 0, 255] }
const RECTANGLES = {
  small: [134, 104, 52, 32], large: [114, 94, 92, 52], 'small-again': [134, 104, 52, 32],
  'rotated-small': [134, 136, 32, 52], none: [160, 120, 52, 32], reset: [134, 104, 52, 32],
}

export function expectedTransformStorage(phase) {
  assert.ok(TRANSFORM_PHASES.includes(phase), `unknown phase: ${phase}`)
  const large = phase === 'large', mode = phase === 'rotated-small' ? 1 : phase === 'none' ? 2 : 0
  return { large, width: large ? 80 : 40, height: large ? 40 : 20, mode,
    transform: ['translate(-50%, -50%)', 'translate(-50%, -50%) rotate(90deg)', 'none'][mode],
    taps: phase === 'small' || phase === 'reset' ? 0 : large ? 1 : 2,
    lastTarget: phase === 'small' ? '' : phase === 'reset' ? 'reset'
      : mode ? 'cycle-transform' : 'box' }
}

function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 0.001,
    `${label}: ${actual} != ${expected}`)
}

function checkRect(actual, expected, label) {
  assert.ok(actual && typeof actual === 'object', `${label}: actual selector result`)
  for (const [index, name] of ['left', 'top', 'width', 'height'].entries()) near(actual[name], expected[index], `${label}.${name}`)
  near(actual.right, expected[0] + expected[2], `${label}.right`)
  near(actual.bottom, expected[1] + expected[3], `${label}.bottom`)
}

function matrix(source, expected, label) {
  assert.equal(typeof source, 'string', label)
  const match = /^matrix\(\s*([^()]+)\s*\)$/.exec(source)
  assert.ok(match, `${label}: numeric computed matrix required: ${source}`)
  const values = match[1].split(',').map(value => Number(value.trim()))
  assert.equal(values.length, 6, label)
  for (let index = 0; index < 6; index++) near(values[index], expected[index], `${label}[${index}]`)
}

export function inspectTransformSelectors(actual, phase) {
  assert.ok(Array.isArray(actual) && actual.length === 4, 'one atomic four-selection registry batch')
  const [box, orderedA, orderedB, stage] = actual
  assert.deepEqual(actual.map(node => node.id), ['box', 'ordered-a', 'ordered-b', 'stage'])
  checkRect(box, RECTANGLES[phase], `${phase}: box`)
  checkRect(orderedA, [60, 220, 40, 10], `${phase}: translate then scale`)
  checkRect(orderedB, [210, 220, 40, 10], `${phase}: scale then translate`)
  checkRect(stage, [0, 0, 320, 280], `${phase}: stage`)
  matrix(orderedA.transform, [2, 0, 0, 1, 40, 10], 'ordered-a matrix')
  matrix(orderedB.transform, [2, 0, 0, 1, 80, 10], 'ordered-b matrix')
  assert.equal(orderedA['transform-origin'], '0px 0px')
  assert.equal(orderedB['transform-origin'], '0px 0px')
  if (phase === 'none') assert.equal(box.transform, 'none')
  else matrix(box.transform, phase === 'rotated-small' ? [0, 1, -1, 0, -26, -16]
    : [1, 0, 0, 1, phase === 'large' ? -46 : -26, phase === 'large' ? -26 : -16], `${phase}: box matrix`)
  assert.equal(box['transform-origin'], phase === 'rotated-small' ? '0px 32px' : '0px 0px')
  return actual
}

export function inspectTransformPixels(snapshot, phase) {
  assert.equal(snapshot.width, WIDTH); assert.equal(snapshot.height, HEIGHT)
  assert.equal(snapshot.stride, WIDTH * 4); assert.equal(snapshot.format, 'rgba8-premultiplied')
  assert.ok(Array.isArray(snapshot.pixels) && snapshot.pixels.length === WIDTH * HEIGHT * 4)
  assert.ok(snapshot.pixels.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
  const samples = [[5, 60, 'white'], [70, 225, 'red'], [220, 225, 'blue'], [110, 225, 'white'], [180, 225, 'white']]
  if (phase === 'large') samples.push([150, 112, 'green'], [115, 110, 'red'], [118, 98, 'yellow'], [112, 112, 'white'])
  else if (phase === 'rotated-small') samples.push([150, 160, 'blue'], [135, 160, 'red'], [132, 160, 'white'], [150, 112, 'white'])
  else if (phase === 'none') samples.push([176, 136, 'blue'], [161, 138, 'red'], [164, 124, 'yellow'], [158, 136, 'white'])
  else samples.push([150, 112, 'blue'], [135, 116, 'red'], [138, 108, 'yellow'], [132, 112, 'white'])
  const observations = samples.map(([x, y, color]) => {
    const offset = y * snapshot.stride + x * 4, rgba = snapshot.pixels.slice(offset, offset + 4)
    assert.deepEqual(rgba, COLORS[color], `${phase}: independent fixed ${color} sample (${x},${y})`)
    return { x, y, expectedColor: color, rgba }
  })
  return { width: WIDTH, height: HEIGHT, stride: WIDTH * 4, format: snapshot.format,
    rgbaSha256: sha256(Buffer.from(snapshot.pixels)), assertedSampleCount: observations.length, samples: observations }
}

function responseOf(batch, request) {
  assert.ok(Array.isArray(batch?.messages), 'actual bridge batch has messages')
  assert.deepEqual(batch.messages.filter(message => message.op === 'error' || message.payload?.ok === false), [], 'no runtime error response')
  const matching = batch.messages.filter(message => message.kind === 'response' && message.requestId === request.requestId)
  assert.equal(matching.length, 1, 'exactly one correlated runtime response')
  for (const name of ['protocolVersion', 'sessionId', 'requestId', 'op']) assert.equal(matching[0][name], request[name], `response ${name}`)
  assert.equal(matching[0].payload?.ok, true)
  return matching[0].payload
}

function delay(ms, signal) {
  signal.throwIfAborted()
  return new Promise((done, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Retain all events while waiting; setData/onReady can publish several frames. */
async function openEventJournal(url, signal) {
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
  const handshakeTimer = setTimeout(() => controller.abort(new Error('owned SSE handshake timed out')), 10_000)
  let response
  try {
    response = await fetch(new URL('/api/events', url), {
      headers: { accept: 'text/event-stream' }, signal: combined,
    })
  } catch (error) { controller.abort(); throw error }
  finally { clearTimeout(handshakeTimer) }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    controller.abort()
    throw new Error(`SSE HTTP ${response.status}`)
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(), events = [], pending = new Set()
  let closed = false, failure, buffer = '', totalBytes = 0, closePromise
  const rejectPending = error => { for (const waiter of pending) { clearTimeout(waiter.timer); waiter.reject(error) }; pending.clear() }
  const pump = (async () => {
    try {
      while (!closed) {
        const chunk = await reader.read()
        if (chunk.done) { if (!closed) throw new Error('owned SSE stream ended unexpectedly'); break }
        totalBytes += chunk.value.length
        assert.ok(totalBytes <= 32 * 1024 * 1024, 'bounded full SSE journal')
        buffer += decoder.decode(chunk.value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n')
        assert.ok(buffer.length <= 4 * 1024 * 1024, 'bounded SSE event buffer')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
          const type = block.match(/^event:\s*(.+)$/m)?.[1]?.trim()
          const data = [...block.matchAll(/^data:\s?(.*)$/gm)].map(match => match[1]).join('\n')
          if (!type || !data) continue
          const event = { sequence: events.length + 1, id: block.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? null,
            type, data: JSON.parse(data), receivedAt: new Date().toISOString() }
          events.push(event)
          for (const waiter of pending) if (event.sequence > waiter.after && event.type === waiter.type && waiter.predicate(event.data)) {
            pending.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event)
          }
        }
      }
    } catch (error) { if (!closed) { failure = error; rejectPending(error) } }
  })()
  return {
    events,
    get cursor() { return events.length },
    wait(type, predicate, { after = 0, timeoutMs = 120_000 } = {}) {
      const found = events.find(event => event.sequence > after && event.type === type && predicate(event.data))
      if (found) return Promise.resolve(found)
      if (failure) return Promise.reject(failure)
      if (closed) return Promise.reject(new Error('SSE journal is closed'))
      return new Promise((resolveWaiter, reject) => {
        const waiter = { type, predicate, after, resolve: resolveWaiter, reject }
        waiter.timer = setTimeout(() => { pending.delete(waiter); reject(new Error(`timed out waiting for SSE ${type}`)) }, timeoutMs)
        pending.add(waiter)
      })
    },
    close() {
      return closePromise ??= (async () => {
        closed = true
        rejectPending(new Error('owned SSE journal closed'))
        let cleanupError
        try { await reader.cancel() } catch (error) { cleanupError = error }
        finally { controller.abort(); await pump; reader.releaseLock() }
        if (cleanupError) throw cleanupError
        if (failure && !signal.aborted) throw failure
        return { readerCancelled: true, pumpStopped: true, pendingWaiters: pending.size, bytesReceived: totalBytes, retainedEvents: events.length }
      })()
    },
  }
}

async function treeBytes(directory, prefix = '') {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), name = prefix + entry.name
    assert.equal((await lstat(path)).isSymbolicLink(), false, `no compiler/pack symlink: ${name}`)
    if (entry.isDirectory()) Object.assign(result, await treeBytes(path, `${name}/`))
    else { assert.ok(entry.isFile()); result[name] = [...await readFile(path)] }
  }
  return result
}

function validatePack(manifest, blobs) {
  const canonical = structuredClone(manifest); canonical.integrity.root = ''
  assert.equal(sha256(canonicalize(canonical)), manifest.integrity.root)
  const visit = value => {
    if (typeof value === 'string' && value.startsWith('sha256:')) assert.ok(Object.hasOwn(blobs, value), `missing ${value}`)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (key === 'sha256') assert.ok(Object.hasOwn(blobs, `sha256:${child}`), `missing ${child}`)
      visit(child)
    }
  }
  visit(manifest)
}

function checkState(state, engine, sessionId) {
  assert.equal(state.schemaVersion, 1); assert.equal(state.status, 'ready')
  assert.equal(state.engine, engine); assert.equal(state.renderer, 'skia-raster')
  assert.equal(state.route, ROUTE); assert.equal(state.lifecycleState, 'Active'); assert.equal(state.revision, 1)
  assert.equal(state.sessionId, sessionId)
  assert.ok(Number.isSafeInteger(state.snapshot?.frame_id) && state.snapshot.frame_id > 0)
  assert.deepEqual((state.diagnostics ?? []).filter(value => value.severity === 'error'), [])
  assert.deepEqual((state.diagnosticHistory?.records ?? []).filter(value => value.severity === 'error'), [])
  if (state.traceSummary) assert.equal(state.traceSummary.complete, true, 'complete retained development trace')
}

function parseArguments(argv) {
  const options = {}, names = new Map([['--simulator-bin', 'simulatorBin'], ['--compiler-root', 'compilerRoot'],
    ['--compiler-dist-hashes', 'compilerDistHashes'], ['--out', 'out']])
  for (let index = 0; index < argv.length; index++) {
    const name = names.get(argv[index]), value = argv[++index]
    assert.ok(name && value && !value.startsWith('--') && !options[name], 'Expected --simulator-bin <binary> --compiler-root <pinned-archive> --compiler-dist-hashes <json> --out <new-report.json>, each once')
    options[name] = resolve(value)
  }
  for (const name of names.values()) assert.ok(options[name], `missing ${name}`)
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  await mkdir(dirname(options.out), { recursive: true })
  // A new evidence destination is required. Never replace a failed attempt.
  try { await lstat(options.out); throw new Error(`report already exists: ${options.out}`) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const artifacts = options.out + '.files'; await mkdir(artifacts)
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-transform-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 }), { command } = runner
  const signals = installSmokeSignals(), report = { schemaVersion: 1, status: 'failed', startedAt: new Date().toISOString(),
    environment: { platform: platform(), release: release(), arch: arch(), node: process.version,
      nodeExecutable: process.execPath },
    fixture: 'examples/apps/transform-app', viewport: { width: WIDTH, height: HEIGHT }, route: ROUTE,
    expectedPhases: [...TRANSFORM_PHASES], engines: [], artifacts: [], cleanup: {},
    claims: { webHost: false, browser: false, webgl: false, gpu: false, officialDevtools: false, physicalDevices: false, performanceAcceptance: false },
    selectorBoundary: 'The public wx.createSelectorQuery registry reads the accepted frame. Fixture onInspect callbacks may observe a preceding frame during setData; their data.geometry and text label are preserved in pixels/logs but are not substituted for the explicit post-frame registry result.',
    boundary: 'Actual native QuickJS/V8 development supervisor, real Page coordinate taps/setData/storage, public selector registry and automatic supervisor rendering. The software Web development surface transports native CPU RGBA; no container WebAssembly host, browser, official DevTools, GPU/device or performance acceptance. Complete RGBA bytes are retained and identical between engines; only explicitly listed font-independent interior samples are compared with fixed independent expected colors. No complete pixel oracle or exported internal startup trace is claimed.' }
  const save = async (name, value, compress = false) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + '\n')
    const path = name + (compress ? '.gz' : ''), data = compress ? gzipSync(bytes, { mtime: 0 }) : bytes
    await writeFile(resolve(artifacts, path), data, { flag: 'wx' })
    const descriptor = { path, bytes: data.length, sha256: sha256(data), ...(compress ? { rawBytes: bytes.length, rawSha256: sha256(bytes) } : {}) }
    report.artifacts.push(descriptor)
    return descriptor
  }
  const sources = async () => ({ fixture: await sourceHashes(FIXTURE), crates: await sourceHashes(resolve(ROOT, 'crates')),
    packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')), packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')),
    ...Object.fromEntries(await Promise.all(['Cargo.toml', 'Cargo.lock', 'scripts/transform-smoke.mjs', 'scripts/simulator-dev-harness.mjs',
      'scripts/simulator-watch.mjs', 'scripts/simulator-cli-harness.mjs', 'scripts/scrolling-smoke.mjs']
      .map(async path => [path, sha256(await readFile(resolve(ROOT, path)))]))) })
  let simulator, events, activeEntry
  try {
    report.environment.nodeExecutableSha256 = sha256(await readFile(process.execPath))
    report.commit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    const commit = (await command('git', ['rev-parse', 'HEAD:vendor/weapp-vite'])).stdout.trim()
    report.sourceBefore = await sources()
    report.simulator = { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
    report.compiler = { directory: options.compilerRoot, before: await validateCompiler(options, command, commit) }
    for (const engine of ['quickjs', 'v8']) {
      const project = resolve(temporary, engine); await cp(FIXTURE, project, { recursive: true })
      const output = { stdout: '', stderr: '' }, requests = []
      const entry = { engine, status: 'running', phases: [] }; activeEntry = entry; report.engines.push(entry)
      try {
        simulator = await startDevSimulator({ root: ROOT, project, port: 0, engine, timeoutMs: 120_000,
          signal: signals.signal, viewport: `${WIDTH}x${HEIGHT}`,
          wvBin: resolve(options.compilerRoot, 'packages/weapp-vite/bin/weapp-vite.js'),
          launcher: { command: options.simulatorBin, mode: 'simulator' },
          onOutput: (text, stderr) => { output[stderr ? 'stderr' : 'stdout'] += text } })
        entry.process = { pid: simulator.child.pid, url: simulator.url, staging: simulator.staging,
          command: [simulator.child.spawnfile, ...simulator.child.spawnargs.slice(1)] }
        entry.developmentSession = readDevSessionPaths(simulator.staging, simulator.child.pid, project)
        const ready = await simulator.waitForState(state => state.status === 'ready' && state.revision === 1 && state.snapshot?.frame_id > 0, 'initial accepted transform frame')
        entry.sessionId = ready.sessionId; entry.initialObservedFrameId = ready.snapshot.frame_id
        checkState(ready, engine, ready.sessionId)
        const pack = resolve(entry.developmentSession.runRoot, 'generation-1'), rawRoot = entry.developmentSession.compilerOutput
        const manifestBytes = await readFile(resolve(pack, 'manifest.json')), manifest = JSON.parse(manifestBytes), blobs = {}
        assert.equal(manifest.compiler.name, 'weapp-vite'); assert.equal(manifest.compiler.platform, 'weapp')
        assert.ok(['unknown', commit].includes(manifest.compiler.commit))
        assert.ok(manifest.routes.some(route => route.path === ROUTE))
        entry.compilerIdentity = { manifest: manifest.compiler, verifiedSourceCommit: commit,
          limitation: manifest.compiler.commit === 'unknown' ? 'Compiler archive has no Git metadata; unchanged unknown metadata is independently bound to pinned source/dist bytes before and after.' : null }
        entry.manifest = await save(`${engine}-manifest.json`, manifestBytes); entry.integrityRoot = manifest.integrity.root
        for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
          const bytes = await readFile(resolve(pack, 'blobs/sha256', name)); assert.equal(sha256(bytes), name)
          blobs[`sha256:${name}`] = [...bytes]
        }
        validatePack(manifest, blobs)
        entry.blobs = await save(`${engine}-blobs.json`, blobs, true)
        const raw = await treeBytes(rawRoot)
        entry.rawOutput = await sourceHashes(rawRoot); entry.rawOutputArtifact = await save(`${engine}-compiler-output.json`, raw, true)
        entry.remainingCompilerFiles = await save(`${engine}-remaining-compiler-files.json`, await treeBytes(resolve(entry.developmentSession.preparationRoot, '.compiler')), true)
        entry.compilerReceiptLimitation = 'Supervisor consumes/deletes historical success receipts and temporary snapshots. Original output and complete published pack are preserved, then independently repacked and byte-compared; deleted receipts are not reconstructed.'
        entry.packHashes = await sourceHashes(pack); entry.packArtifact = await save(`${engine}-published-pack.json`, await treeBytes(pack), true)
        const independentPack = resolve(temporary, `${engine}-independent-pack`)
        entry.independentPackCommand = await save(`${engine}-independent-pack-command.json`, await command(process.execPath, [
          resolve(ROOT, 'tools/container-manifest/bin/container-pack.mjs'), rawRoot, '--out', independentPack,
          '--platform', 'weapp', '--compiler-commit', manifest.compiler.commit,
        ]))
        assert.deepEqual(await treeBytes(independentPack), await treeBytes(pack), 'entire pack matches independently packed original output')
        entry.independentPackHashes = await sourceHashes(independentPack); assert.deepEqual(entry.independentPackHashes, entry.packHashes)
        events = await openEventJournal(simulator.url, signals.signal)
        let sequence = 0
        const send = async (label, op, payload) => {
          const request = { protocolVersion: '1.0', sessionId: ready.sessionId, requestId: `transform-${++sequence}-${label}`, kind: 'request', op, payload }
          const after = events.cursor
          const pending = events.wait('bridge', batch => batch.messages?.some(message => message.kind === 'response' && message.requestId === request.requestId), { after })
          pending.catch(() => {})
          const [acknowledgement, responseEvent] = await Promise.all([simulator.json('/api/bridge', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
          }), pending])
          assert.deepEqual(acknowledgement, { queued: true })
          const record = { request, acknowledgement, responseEventSequence: responseEvent.sequence, response: responseEvent.data }
          requests.push(record)
          return { payload: responseOf(responseEvent.data, request), record, after }
        }
        const stableFrame = async minimum => {
          const deadline = Date.now() + 120_000
          let last, stableSince = Date.now()
          while (Date.now() < deadline) {
            const state = await simulator.json('/api/state'); checkState(state, engine, ready.sessionId)
            const current = state.snapshot.frame_id
            if (current !== last) { last = current; stableSince = Date.now() }
            if (current >= minimum && Date.now() - stableSince >= 200) return state
            await delay(40, signals.signal)
          }
          throw new Error('transform frame did not stabilize within the observed 200 ms window')
        }
        let minimum = ready.snapshot.frame_id
        for (const phase of TRANSFORM_PHASES) {
          const phaseEntry = { name: phase, status: 'running', eventStart: events.cursor }; entry.phases.push(phaseEntry)
          if (phase !== 'small') {
            const before = await stableFrame(minimum)
            const point = phase === 'large' || phase === 'small-again' ? [150, 112] : phase === 'reset' ? [244, 22] : [148, 22]
            const sent = await send(`tap-${phase}`, 'event.batch', { events: [{ type: 'tap', x: point[0], y: point[1] }] })
            phaseEntry.tap = { x: point[0], y: point[1], requestId: sent.record.request.requestId, beforeFrameId: before.snapshot.frame_id }
            const automatic = await events.wait('bridge', batch => batch.messages?.some(message => message.kind === 'response'
              && message.sessionId === ready.sessionId && message.op === 'render.commit' && message.payload?.ok === true
              && message.payload.frameId > before.snapshot.frame_id), { after: sent.after })
            const rendered = automatic.data.messages.find(message => message.kind === 'response' && message.op === 'render.commit'
              && message.payload?.ok === true && message.payload.frameId > before.snapshot.frame_id)
            assert.ok(!requests.some(record => record.request.op === 'render.commit'), 'no injected render request')
            const snapshotEvent = await events.wait('snapshot', value => value.frameId === rendered.payload.frameId, { after: sent.after })
            minimum = rendered.payload.frameId
            phaseEntry.automaticRender = { bridgeEventSequence: automatic.sequence, response: rendered,
              snapshotEventSequence: snapshotEvent.sequence, snapshotEvent: snapshotEvent.data }
          }
          let observation
          for (let attempt = 0; attempt < 10; attempt++) {
            const before = await stableFrame(minimum)
            const queried = await send(`query-${phase}-${attempt}`, 'api.call', { name: 'wx.createSelectorQuery', queries:
              ['box', 'ordered-a', 'ordered-b', 'stage'].map(id => ({ selector: `#${id}`, operation: 'fields',
                fields: { id: true, rect: true, size: true, computedStyle: ['transform', 'transform-origin'] } })) })
            const storage = await send(`storage-${phase}-${attempt}`, 'api.call', { name: 'wx.getStorageSync', key: 'transform-app-state' })
            const state = await simulator.json('/api/state'), snapshot = await simulator.json('/api/snapshot'), after = await stableFrame(minimum)
            if ([state.snapshot?.frame_id, snapshot.frame_id, after.snapshot?.frame_id].some(id => id !== before.snapshot.frame_id)) continue
            assert.equal(queried.payload.count, 4)
            const selectors = inspectTransformSelectors(queried.payload.result, phase)
            assert.deepEqual(storage.payload.result, expectedTransformStorage(phase), `${phase}: actual Page storage and physical event target`)
            const pixels = inspectTransformPixels(snapshot, phase)
            phaseEntry.state = await save(`${engine}-${phase}.state.json`, state)
            phaseEntry.snapshot = await save(`${engine}-${phase}.snapshot.json`, snapshot, true)
            phaseEntry.rgba = await save(`${engine}-${phase}.rgba`, Buffer.from(snapshot.pixels))
            phaseEntry.requests = await save(`${engine}-${phase}.http-sse.json`, requests, true)
            phaseEntry.events = await save(`${engine}-${phase}.events.json`, events.events, true)
            phaseEntry.acceptedFrameId = snapshot.frame_id
            phaseEntry.observedStableWindowMs = 200
            observation = { selectors, storage: storage.payload.result, pixels }
            break
          }
          assert.ok(observation, `${phase}: selector/storage/snapshot share one observed stable accepted frame`)
          phaseEntry.observation = observation; phaseEntry.eventEnd = events.cursor; phaseEntry.status = 'passed'
        }
        assert.deepEqual(await sourceHashes(rawRoot), entry.rawOutput); assert.deepEqual(await treeBytes(rawRoot), raw)
        assert.deepEqual(await sourceHashes(pack), entry.packHashes); entry.rawOutputUnmodified = true
        assert.ok(requests.every(record => record.request.op === 'event.batch' || record.request.op === 'api.call'))
        entry.status = 'passed'
      } finally {
        const errors = []
        const ownedEvents = events
        try { if (events) entry.sseCleanup = await events.close(); events = null } catch (error) { errors.push(String(error)) }
        try { if (simulator) entry.cleanup = await simulator.stop(); simulator = null } catch (error) { errors.push(String(error)) }
        try {
          if (entry.developmentSession && entry.cleanup?.processExited) {
            await assert.rejects(lstat(entry.developmentSession.preparationRoot), { code: 'ENOENT' })
            entry.cleanup.preparationRemoved = true
          }
        } catch (error) { errors.push(`compiler preparation cleanup: ${error}`) }
        if (ownedEvents) entry.finalEvents = await save(`${engine}-final.events.json`, ownedEvents.events, true)
        entry.finalRequests = await save(`${engine}-final.http-sse.json`, requests, true)
        entry.stdout = await save(`${engine}.stdout`, Buffer.from(output.stdout), true)
        entry.stderr = await save(`${engine}.stderr`, Buffer.from(output.stderr), true)
        if (errors.length) { entry.status = 'failed'; entry.cleanupErrors = errors; throw new Error(errors.join('; ')) }
      }
    }
    assert.deepEqual(report.engines[0].phases.map(phase => phase.observation), report.engines[1].phases.map(phase => phase.observation), 'complete selectors/storage/full RGBA are identical across native engines')
    for (let index = 0; index < TRANSFORM_PHASES.length; index++) {
      const quickjs = await readFile(resolve(artifacts, report.engines[0].phases[index].rgba.path))
      const v8 = await readFile(resolve(artifacts, report.engines[1].phases[index].rgba.path))
      assert.ok(quickjs.equals(v8), `${TRANSFORM_PHASES[index]}: actual archived full RGBA bytes must be identical`)
    }
    report.dualEngine = { phases: TRANSFORM_PHASES.length, selectorsEqual: true, storageEqual: true, fullRgbaEqual: true }
    report.status = 'passed'
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (activeEntry && activeEntry.status !== 'passed') activeEntry.status = 'failed'
    if (error.result) report.failedCommand = await save('failed-command.json', error.result)
  } finally {
    const errors = []
    try { if (events) await events.close(); events = null } catch (error) { errors.push(`SSE cleanup: ${error}`) }
    try { if (simulator) await simulator.stop(); simulator = null } catch (error) { errors.push(`simulator cleanup: ${error}`) }
    try { assert.equal(runner.active, null); report.cleanup.commandChildrenStopped = true } catch (error) { errors.push(String(error)) }
    if (!simulator) {
      try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true } catch (error) { errors.push(String(error)) }
    } else report.cleanup.preservedTemporary = temporary
    if (report.compiler?.before) {
      try {
        report.compiler.after = await validateCompiler(options, command, report.compiler.before.pinnedCommit)
        assert.deepEqual(report.compiler.before, report.compiler.after)
      } catch (error) { errors.push(`compiler before/after: ${error.stack ?? error}`) }
    }
    try {
      report.sourceAfter = await sources(); assert.deepEqual(report.sourceBefore, report.sourceAfter)
    } catch (error) { errors.push(`source before/after: ${error.stack ?? error}`) }
    if (report.simulator) {
      try {
        report.simulator.sha256After = sha256(await readFile(options.simulatorBin))
        assert.equal(report.simulator.sha256After, report.simulator.sha256)
      } catch (error) { errors.push(`simulator before/after: ${error.stack ?? error}`) }
    }
    try {
      report.environment.nodeExecutableSha256After = sha256(await readFile(process.execPath))
      assert.equal(report.environment.nodeExecutableSha256After, report.environment.nodeExecutableSha256)
    } catch (error) { errors.push(`Node before/after: ${error.stack ?? error}`) }
    try { runner.dispose(); signals.dispose() } catch (error) { errors.push(String(error)) }
    report.cleanup.noBrowserOrDeviceCreated = true
    if (errors.length) { report.status = 'failed'; report.cleanup.errors = errors }
    report.finishedAt = new Date().toISOString()
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out, cleanup: report.cleanup }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
