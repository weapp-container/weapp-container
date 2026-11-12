#!/usr/bin/env node
/** Real compiler, ordinary Page/Component coordinate input and typed JSON dataset and mark evidence. */
import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { canonicalize } from '../tools/container-manifest/src/index.mjs'
import { createOwnedCommandRunner, sha256, sourceHashes } from './simulator-cli-harness.mjs'
import { installSmokeSignals, readDevSessionPaths, startDevSimulator } from './simulator-dev-harness.mjs'
import { validateCompiler } from './scrolling-smoke.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'examples/apps/dataset-values-app')
const WIDTH = 320, HEIGHT = 480
const initialObject = { k: 1, nested: [false, null, { value: 'before' }] }
const changedObject = { k: 2, nested: [true, null, { value: 'after' }] }
const initialArray = [7, true, null, 'x', { k: 'before' }]
const changedArray = [8, false, null, 'y', { k: 'after' }]
const dataset = changed => ({ number: 42, yes: true, no: false, nil: null, text: 'bound',
  object: changed ? changedObject : initialObject, array: changed ? changedArray : initialArray,
  userId: changed ? changedObject : initialObject, literalNumber: '42', literalFalse: 'false',
  literalNull: 'null', literalJson: '{"k":1}', empty: '', mixed: 'v=42' })
const targetMark = changed => ({ ...dataset(changed), override: changed ? changedArray : initialArray, source: 'raw' })
const parentMark = (ancestor, object) => ({ ancestor, override: object })
const eventMark = (changed, ancestor) => ({ ...targetMark(changed), ancestor })
const pageData = changed => ({ number: 42, yes: true, no: false, nil: null, text: 'bound',
  object: changed ? changedObject : initialObject, array: changed ? changedArray : initialArray,
  phase: changed ? 'changed' : 'initial', left: changed ? 160 : 0,
  captureMeta: { owner: 'capture', phase: changed ? 'after' : 'before' } })

function responseOf(batch, request) {
  assert.ok(Array.isArray(batch?.messages), 'bridge batch contains messages')
  assert.deepEqual(batch.messages.filter(message => message.op === 'error' || message.payload?.ok === false), [], 'no runtime errors')
  const responses = batch.messages.filter(message => message.kind === 'response')
  assert.equal(responses.length, 1, 'one bridge response')
  const response = responses[0]
  for (const key of ['sessionId', 'requestId', 'protocolVersion', 'op']) assert.equal(response[key], request[key], `response ${key}`)
  assert.equal(response.payload.ok, true)
  return response.payload
}

// Preserve the entire owned SSE byte stream, including events not selected by
// the request correlation journal. The lifecycle harness owns the child/server.
export async function recordedEvents(url, { signal, timeoutMs = 120_000 } = {}) {
  const controller = new AbortController(), chunks = [], events = [], queue = []
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const connectTimeout = Object.assign(new Error(`timed out waiting for SSE response headers after ${timeoutMs} ms`), {
    name: 'TimeoutError', code: 'ERR_SSE_CONNECT_TIMEOUT', timeoutMs,
  })
  const connectTimer = setTimeout(() => controller.abort(connectTimeout), timeoutMs)
  let response
  try {
    response = await fetch(new URL('/api/events', url), { signal: requestSignal, headers: { accept: 'text/event-stream' } })
  } catch (error) {
    controller.abort()
    throw error
  } finally {
    // This deadline covers the handshake only. An accepted stream can remain
    // open across many individually bounded nextEvent waits.
    clearTimeout(connectTimer)
  }
  try {
    assert.equal(response.status, 200); assert.ok(response.body)
  } catch (error) {
    try { await response.body?.cancel() } finally { controller.abort() }
    throw error
  }
  const reader = response.body.getReader()
  let buffer = '', failure, pending, closing = false, total = 0
  const decoder = new TextDecoder()
  const satisfy = () => {
    if (!pending) return
    const index = queue.findIndex(event => event.type === pending.type && pending.predicate(event.payload))
    if (index < 0) return
    const event = queue[index]; queue.splice(0, index + 1)
    clearTimeout(pending.timer); const resolvePending = pending.resolve; pending = undefined; resolvePending(event.payload)
  }
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { if (!closing) throw new Error('owned SSE stream ended unexpectedly'); break }
        const bytes = Buffer.from(value); chunks.push(bytes); total += bytes.length
        assert.ok(total <= 16 * 1024 * 1024, 'SSE evidence byte budget')
        buffer += decoder.decode(value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
          const type = raw.match(/^event:\s*(.+)$/m)?.[1]?.trim()
          const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (type && data) {
            const event = { sequence: events.length + 1, type, payload: JSON.parse(data) }
            events.push(event); queue.push(event); satisfy()
          }
        }
        assert.ok(buffer.length <= 2 * 1024 * 1024, 'SSE event byte budget')
      }
    } catch (error) {
      if (!closing) {
        failure = error
        if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined }
      }
    }
  })()
  return {
    events, bytes: () => Buffer.concat(chunks),
    nextEvent(type, predicate = () => true) {
      if (failure) return Promise.reject(failure)
      assert.equal(pending, undefined, 'one sequential SSE waiter')
      return new Promise((resolvePending, reject) => {
        const timer = setTimeout(() => { pending = undefined; reject(new Error(`timed out waiting for SSE ${type}`)) }, timeoutMs)
        pending = { type, predicate, resolve: resolvePending, reject, timer }; satisfy()
      })
    },
    async close() {
      if (closing) return
      closing = true
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('owned SSE connection closing')); pending = undefined }
      try { await reader.cancel() } finally { controller.abort(); await pump }
    },
    get failure() { return failure?.stack ?? null },
  }
}

async function treeBytes(directory, prefix = '') {
  const files = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), name = prefix + entry.name
    assert.equal((await lstat(path)).isSymbolicLink(), false, `no compiler/pack artifact symlink: ${name}`)
    if (entry.isDirectory()) Object.assign(files, await treeBytes(path, `${name}/`))
    else { assert.ok(entry.isFile()); files[name] = [...await readFile(path)] }
  }
  return files
}

function validatePack(manifest, blobs) {
  const emptyRoot = structuredClone(manifest); emptyRoot.integrity.root = ''
  assert.equal(sha256(canonicalize(emptyRoot)), manifest.integrity.root)
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

/** Deliberately run only after all raw phases have been saved, including red runs. */
export function inspectDatasetValues(entry) {
  assert.equal(entry.phases.length, 3)
  const expectedPhases = ['initial', 'moved', 'released']
  const observations = []
  for (const [index, phase] of entry.phases.entries()) {
    assert.equal(phase.name, expectedPhases[index])
    const changed = index > 0, { state, snapshot, page, component } = phase.collected
    assert.equal(state.schemaVersion, 1); assert.equal(state.status, 'ready')
    assert.equal(state.engine, entry.engine); assert.equal(state.renderer, 'skia-raster')
    assert.equal(state.route, 'pages/index/index'); assert.equal(state.lifecycleState, 'Active')
    assert.equal(state.revision, 1); assert.equal(state.sessionId, entry.sessionId)
    assert.deepEqual(state.compiler, entry.compilerIdentity.manifest)
    assert.deepEqual(state.diagnostics ?? [], []); assert.deepEqual(state.diagnosticHistory?.records ?? [], [])
    assert.deepEqual(page.data, pageData(changed)); assert.equal(page.route, 'pages/index/index')
    assert.deepEqual(page.trace, ['load', 'show', 'ready'])
    const byId = Object.fromEntries(page.nodes.map(node => [node.id, node]))
    assert.deepEqual(Object.keys(byId).sort(), ['capture-parent', 'capture-target', 'page-parent', 'page-target'])
    for (const id of ['page-target', 'capture-target']) {
      assert.deepEqual(byId[id].dataset, dataset(changed), `${entry.engine}/${phase.name}/${id}: typed JSON bindings and literal strings`)
      assert.deepEqual(byId[id].mark, targetMark(changed), 'selector returns own typed mark without ancestor merge')
    }
    assert.deepEqual(byId['page-parent'].dataset, { meta: changed ? changedObject : initialObject })
    assert.deepEqual(byId['page-parent'].mark, parentMark(changed ? changedObject : initialObject, changed ? changedObject : initialObject))
    assert.deepEqual(byId['capture-parent'].dataset, { meta: pageData(changed).captureMeta })
    assert.deepEqual(byId['capture-parent'].mark, parentMark(pageData(changed).captureMeta, changed ? changedObject : initialObject))
    assert.ok(Math.abs(byId['capture-target'].left - (changed ? 168 : 8)) < 0.02, 'handler setData moves the actual native target')
    assert.ok(Math.abs(byId['capture-target'].top - 240) < 0.02)
    assert.equal(component.nodes.length, 2)
    const componentById = Object.fromEntries(component.nodes.map(node => [node.id, node]))
    assert.deepEqual(Object.keys(componentById).sort(), ['component-parent', 'component-target'])
    assert.deepEqual(componentById['component-target'].dataset, dataset(false), 'component-scoped selector typed JSON')
    assert.deepEqual(componentById['component-target'].mark, targetMark(false), 'component selector own typed mark')
    assert.deepEqual(componentById['component-parent'].dataset, { meta: initialObject })
    assert.deepEqual(componentById['component-parent'].mark, parentMark(initialObject, initialObject))
    const componentEvents = page.events.filter(event => event.owner.startsWith('component-'))
    assert.deepEqual(componentEvents.map(event => event.owner), ['component-target', 'component-parent'])
    for (const event of componentEvents) {
      assert.equal(event.type, 'tap'); assert.equal(event.target.id, 'component-target')
      assert.equal(event.currentTarget.id, event.owner)
      assert.deepEqual(event.target.dataset, dataset(false), 'component native event target dataset')
      assert.deepEqual(event.mark, eventMark(false, initialObject), 'component native event: typed mark, inherited ancestor and nearest override')
      assert.deepEqual(event.currentTarget.dataset, event.owner === 'component-target' ? dataset(false) : { meta: initialObject })
    }
    assert.deepEqual(component.events, componentEvents)
    const pageEvents = page.events.filter(event => event.owner.startsWith('page-'))
    assert.deepEqual(pageEvents.map(event => event.owner), ['page-target', 'page-parent'])
    for (const event of pageEvents) {
      assert.equal(event.type, 'tap'); assert.equal(event.target.id, 'page-target')
      assert.equal(event.currentTarget.id, event.owner)
      assert.deepEqual(event.target.dataset, dataset(false), 'ordinary Page event target dataset')
      assert.deepEqual(event.mark, eventMark(false, initialObject), 'ordinary Page event: typed mark, inherited ancestor and nearest override')
      assert.deepEqual(event.currentTarget.dataset, event.owner === 'page-target' ? dataset(false) : { meta: initialObject })
    }
    const captured = page.events.filter(event => event.owner.startsWith('capture-'))
    const expected = index === 0 ? [] : index === 1
      ? [['capture-target', 'touchstart'], ['capture-parent', 'touchstart']]
      : [['capture-target', 'touchstart'], ['capture-parent', 'touchstart'],
        ['capture-phase', 'touchend'], ['capture-target', 'touchend'], ['capture-parent', 'touchend'],
        ['capture-target', 'tap'], ['capture-parent', 'tap']]
    assert.deepEqual(captured.map(event => [event.owner, event.type]), expected, 'original route receives the identified gesture after native layout motion')
    for (const event of captured) {
      assert.equal(event.target.id, 'capture-target')
      assert.equal(event.currentTarget.id, event.owner === 'capture-target' ? 'capture-target' : 'capture-parent')
      assert.deepEqual(event.target.dataset, dataset(false), 'captured touch target retains initial typed JSON snapshot after setData')
      assert.deepEqual(event.mark, eventMark(false, { owner: 'capture', phase: 'before' }), 'captured typed mark retains initial nearest override and inherited ancestor after setData')
      assert.deepEqual(event.currentTarget.dataset, event.owner === 'capture-target' ? dataset(false) : { meta: { owner: 'capture', phase: 'before' } }, 'captured ancestor retains initial typed JSON snapshot')
    }
    assert.equal(page.events.some(event => event.owner === 'underlay'), false, 'release is never retargeted to the newly exposed underlay')
    assert.equal(page.events.length, 4 + expected.length, 'no hidden fixture events')
    assert.equal(snapshot.width, WIDTH); assert.equal(snapshot.height, HEIGHT); assert.equal(snapshot.stride, WIDTH * 4)
    assert.equal(snapshot.frame_id, state.snapshot.frame_id); assert.equal(snapshot.format, 'rgba8-premultiplied')
    assert.equal(snapshot.pixels.length, WIDTH * HEIGHT * 4)
    assert.ok(snapshot.pixels.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
    observations.push({ page, component, rgbaSha256: sha256(Buffer.from(snapshot.pixels)) })
  }
  assert.notEqual(observations[0].rgbaSha256, observations[1].rgbaSha256, 'actual moved frame differs from initial frame')
  assert.equal(observations[1].rgbaSha256, observations[2].rgbaSha256, 'gesture release preserves moved view')
  return observations
}

export async function main(argv = process.argv.slice(2)) {
  const options = {}, names = new Map([['--simulator-bin', 'simulatorBin'], ['--compiler-root', 'compilerRoot'],
    ['--compiler-dist-hashes', 'compilerDistHashes'], ['--out', 'out']])
  for (let index = 0; index < argv.length; index++) {
    const name = names.get(argv[index]); assert.ok(name && argv[index + 1], `unknown/incomplete argument: ${argv[index]}`)
    options[name] = resolve(argv[++index])
  }
  for (const name of names.values()) assert.ok(options[name], `${name} is required`)
  await mkdir(dirname(options.out), { recursive: true })
  // Exclusive reservation prevents a green run from replacing red evidence.
  await writeFile(options.out, JSON.stringify({ status: 'collecting', officialDevTools: 'unknown' }) + '\n', { flag: 'wx' })
  const artifacts = options.out + '.files'; await mkdir(artifacts)
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-dataset-values-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 }), { command } = runner
  const signals = installSmokeSignals()
  const report = { schemaVersion: 1, status: 'failed', engines: [], cleanup: {}, failures: [],
    officialDevTools: { status: 'unknown', baseline: { ide: '2.02.2608080', libVersion: '3.17.3' },
      reason: 'This runner does not launch official DevTools. JSON dataset expectations are the container contract under test; official typed dataset behavior has not been observed here.' },
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    boundary: 'Auxiliary development HTTP/SSE evidence only. Pinned compiler source/dist validation, real ordinary Page and Component native coordinate inputs, scoped selector fields(dataset,mark), typed nearest-ancestor mark override, complete native Skia CPU RGBA, actual handler setData and identified touch-route snapshots. Full owned SSE response body and selected request correlation journal are archived. No browser/DevTools, GPU/device, performance or near-parity acceptance. JSON serializable values only; no identity, undefined, special prototype names or non-JSON types.' }
  const sources = async () => ({ fixture: await sourceHashes(FIXTURE), crates: await sourceHashes(resolve(ROOT, 'crates')),
    packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')), packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')),
    ...Object.fromEntries(await Promise.all(['Cargo.toml', 'Cargo.lock', 'scripts/dataset-values-smoke.mjs', 'scripts/simulator-dev-harness.mjs',
      'scripts/simulator-watch.mjs', 'scripts/simulator-cli-harness.mjs', 'scripts/scrolling-smoke.mjs']
      .map(async path => [path, sha256(await readFile(resolve(ROOT, path)))]))) })
  const save = async (name, value, compress = false) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + '\n')
    const path = name + (compress ? '.gz' : ''), data = compress ? gzipSync(bytes, { mtime: 0 }) : bytes
    await writeFile(resolve(artifacts, path), data, { flag: 'wx' })
    return { path, sha256: sha256(data), ...(compress ? { rawSha256: sha256(bytes) } : {}) }
  }
  const fail = (scope, error) => report.failures.push({ scope, message: error.stack ?? String(error) })
  let simulator, sse, compilerCommit
  try {
    report.commit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    compilerCommit = (await command('git', ['rev-parse', 'HEAD:vendor/weapp-vite'])).stdout.trim()
    report.sourceBefore = await sources()
    report.simulator = { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
    report.compiler = { directory: options.compilerRoot, before: await validateCompiler(options, command, compilerCommit) }
    for (const engine of ['quickjs', 'v8']) {
      const project = resolve(temporary, engine); await cp(FIXTURE, project, { recursive: true })
      const output = { stdout: '', stderr: '' }, journal = []
      const entry = { engine, status: 'failed', phases: [] }; report.engines.push(entry)
      let rawRoot, pack, raw
      try {
        simulator = await startDevSimulator({ root: ROOT, project, port: 0, engine, timeoutMs: 120_000,
          signal: signals.signal, viewport: `${WIDTH}x${HEIGHT}`,
          wvBin: resolve(options.compilerRoot, 'packages/weapp-vite/bin/weapp-vite.js'),
          launcher: { command: options.simulatorBin, mode: 'simulator' },
          onOutput: (text, stderr) => { output[stderr ? 'stderr' : 'stdout'] += text } })
        entry.process = { pid: simulator.child.pid, url: simulator.url, staging: simulator.staging,
          command: [simulator.child.spawnfile, ...simulator.child.spawnargs.slice(1)] }
        entry.developmentSession = readDevSessionPaths(simulator.staging, simulator.child.pid, project)
        const ready = await simulator.waitForState(state => state.status === 'ready' && state.revision === 1 && state.snapshot?.frame_id > 0, 'initial frame')
        entry.sessionId = ready.sessionId
        pack = resolve(entry.developmentSession.runRoot, 'generation-1')
        const manifestBytes = await readFile(resolve(pack, 'manifest.json')), manifest = JSON.parse(manifestBytes), blobs = {}
        assert.equal(manifest.compiler.name, 'weapp-vite'); assert.equal(manifest.compiler.platform, 'weapp')
        assert.ok(['unknown', compilerCommit].includes(manifest.compiler.commit))
        entry.compilerIdentity = { manifest: manifest.compiler, verifiedSourceCommit: compilerCommit,
          limitation: manifest.compiler.commit === 'unknown' ? 'Verified compiler archive lacks Git metadata; adapter unknown metadata is preserved. Raw pinned source and independent dist bytes are checked before/after.' : null }
        entry.manifest = await save(`${engine}-manifest.json`, manifestBytes); entry.integrityRoot = manifest.integrity.root
        for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
          const bytes = await readFile(resolve(pack, 'blobs/sha256', name)); assert.equal(sha256(bytes), name); blobs[`sha256:${name}`] = [...bytes]
        }
        validatePack(manifest, blobs); entry.blobs = await save(`${engine}-blobs.json`, blobs, true)
        rawRoot = entry.developmentSession.compilerOutput; raw = await treeBytes(rawRoot)
        entry.rawOutput = await sourceHashes(rawRoot); entry.rawOutputArtifact = await save(`${engine}-compiler-output.json`, raw, true)
        entry.remainingCompilerFiles = await save(`${engine}-remaining-compiler-files.json`, await treeBytes(resolve(entry.developmentSession.preparationRoot, '.compiler')), true)
        entry.compilerReceiptLimitation = 'Supervisor consumed historical receipts/snapshots; published pack is independently regenerated from original archived compiler output and compared byte for byte.'
        entry.packHashes = await sourceHashes(pack); entry.packArtifact = await save(`${engine}-published-pack.json`, await treeBytes(pack), true)
        const independentPack = resolve(temporary, `${engine}-independent-pack`)
        entry.independentPackCommand = await save(`${engine}-independent-pack-command.json`, await command(process.execPath, [
          resolve(ROOT, 'tools/container-manifest/bin/container-pack.mjs'), rawRoot, '--out', independentPack,
          '--platform', 'weapp', '--compiler-commit', manifest.compiler.commit,
        ]))
        assert.deepEqual(await treeBytes(independentPack), await treeBytes(pack), 'published pack equals independently regenerated original output')
        entry.independentPackHashes = await sourceHashes(independentPack); assert.deepEqual(entry.independentPackHashes, entry.packHashes)
        sse = await recordedEvents(simulator.url, { signal: signals.signal })
        const send = async (requestId, op, payload) => {
          const request = { protocolVersion: '1.0', sessionId: ready.sessionId, requestId, kind: 'request', op, payload }
          const record = { request }; journal.push(record)
          const eventPromise = sse.nextEvent('bridge', batch => batch.messages?.some(message => message.kind === 'response' && message.requestId === requestId))
          eventPromise.catch(() => {})
          record.acknowledgement = await simulator.json('/api/bridge', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
          })
          record.bridge = await eventPromise
          const result = responseOf(record.bridge, request)
          assert.deepEqual(record.acknowledgement, { queued: true })
          if (op === 'event.batch') {
            const bridge = await sse.nextEvent('bridge', batch => batch.messages?.some(message => message.kind === 'response' && message.op === 'render.commit'))
            const response = bridge.messages.find(message => message.kind === 'response' && message.op === 'render.commit')
            const rendered = responseOf(bridge, { ...response, sessionId: ready.sessionId, protocolVersion: '1.0' })
            assert.equal(rendered.committed, true); assert.equal(rendered.source, 'manifest'); assert.equal(rendered.backend, 'skia-raster')
            const snapshotEvent = await sse.nextEvent('snapshot', event => event.frameId === rendered.frameId)
            const state = await simulator.waitForState(value => value.sessionId === ready.sessionId && value.snapshot?.frame_id === rendered.frameId, 'automatic event frame')
            record.automaticRender = { bridge, snapshotEvent, state }
          }
          return result
        }
        const tap = (id, x, y) => send(id, 'event.batch', { events: [{ type: 'tap', x, y }] })
        const inspect = async name => {
          await tap(`inspect-component-${name}`, 184, 136)
          await tap(`inspect-page-${name}`, 24, 392)
          const page = (await send(`read-page-${name}`, 'api.call', { name: 'wx.getStorageSync', key: 'dataset-values:page' })).result
          const component = (await send(`read-component-${name}`, 'api.call', { name: 'wx.getStorageSync', key: 'dataset-values:component' })).result
          const state = await simulator.json('/api/state'), snapshot = await simulator.json('/api/snapshot')
          const collected = { state, snapshot, page, component }
          const phase = { name, status: 'collected', state: await save(`${engine}-${name}.state.json`, state),
            snapshot: await save(`${engine}-${name}.snapshot.json`, snapshot, true),
            observation: await save(`${engine}-${name}.observation.json`, { page, component }),
            journal: await save(`${engine}-${name}.http-sse.json`, journal, true) }
          // Non-enumerable raw values support delayed assertions without doubling reports.
          Object.defineProperty(phase, 'collected', { value: collected }); entry.phases.push(phase)
        }
        await tap('page-tap', 24, 40); await tap('component-tap', 24, 136)
        await inspect('initial')
        const touch = type => { const point = { identifier: 73, clientX: 24, clientY: 264, pageX: 24, pageY: 264 }
          return { type, x: 24, y: 264, timeStamp: 100, touches: type === 'touchstart' ? [point] : [], changedTouches: [point], detail: { x: 24, y: 264 } } }
        await send('capture-start', 'event.batch', { events: [touch('touchstart')] })
        await inspect('moved')
        await send('capture-release', 'event.batch', { events: [touch('touchend'), touch('tap')] })
        await inspect('released')
        assert.deepEqual(await sourceHashes(rawRoot), entry.rawOutput); assert.deepEqual(await treeBytes(rawRoot), raw)
        assert.deepEqual(await sourceHashes(pack), entry.packHashes); entry.rawOutputUnmodified = true
        entry.status = 'collected'
      } catch (error) {
        entry.error = error.stack ?? String(error); fail(`${engine}:collection`, error)
        if (error.result) entry.failedCommand = await save(`${engine}-failed-command.json`, error.result)
      } finally {
        const cleanupErrors = []
        try { if (sse) { await sse.close(); entry.sseClosed = true } } catch (error) { cleanupErrors.push(String(error)) }
        if (sse) {
          entry.sseStream = await save(`${engine}-events.sse`, sse.bytes(), true)
          entry.sseEvents = await save(`${engine}-events.json`, sse.events, true)
          if (sse.failure) { entry.sseFailure = sse.failure; fail(`${engine}:sse`, new Error(sse.failure)) }
        }
        sse = null
        try { if (simulator) { entry.cleanup = await simulator.stop(); simulator = null } } catch (error) { cleanupErrors.push(String(error)) }
        try {
          if (entry.developmentSession && entry.cleanup?.processExited) {
            await assert.rejects(lstat(entry.developmentSession.preparationRoot), { code: 'ENOENT' })
            entry.cleanup.preparationRemoved = true
          }
        } catch (error) { cleanupErrors.push(`compiler preparation cleanup: ${error}`) }
        entry.finalJournal = await save(`${engine}-final.http-sse.json`, journal, true)
        entry.stdout = await save(`${engine}.stdout`, Buffer.from(output.stdout), true)
        entry.stderr = await save(`${engine}.stderr`, Buffer.from(output.stderr), true)
        if (cleanupErrors.length) { entry.status = 'failed'; entry.cleanupErrors = cleanupErrors; fail(`${engine}:cleanup`, new Error(cleanupErrors.join('; '))) }
      }
      if (simulator) throw new Error('previous owned simulator could not be stopped; refusing another process')
    }
    // Type assertions follow complete collection for BOTH engines. A red run
    // retains old runtime behavior, all capture phases and final cleanup.
    for (const entry of report.engines) {
      if (entry.status !== 'collected') continue
      try {
        Object.defineProperty(entry, 'verifiedObservations', { value: inspectDatasetValues(entry) })
        entry.status = 'passed'; for (const phase of entry.phases) phase.status = 'passed'
      } catch (error) { entry.status = 'failed'; entry.error = error.stack ?? String(error); fail(`${entry.engine}:semantics`, error) }
    }
    if (report.engines.length === 2 && report.engines.every(entry => entry.status === 'passed')) {
      assert.deepEqual(report.engines[0].verifiedObservations, report.engines[1].verifiedObservations, 'QuickJS and V8 ordinary JSON dataset/mark, native events, nearest override, capture snapshots, selectors and pixels agree')
      report.crossEngine = 'passed'
    } else report.crossEngine = 'not-passed'
  } catch (error) {
    fail('collector', error)
    if (error.result) report.failedCommand = await save('failed-command.json', error.result)
  } finally {
    const errors = []
    try { if (sse) await sse.close() } catch (error) { errors.push(String(error)) }
    try { if (simulator) { await simulator.stop(); simulator = null } } catch (error) { errors.push(String(error)) }
    try { assert.equal(runner.active, null); report.cleanup.commandChildrenStopped = true } catch (error) { errors.push(String(error)) }
    if (report.compiler?.before && compilerCommit) {
      try { report.compiler.after = await validateCompiler(options, command, compilerCommit); assert.deepEqual(report.compiler.after, report.compiler.before) }
      catch (error) { fail('compiler-after', error) }
    }
    if (report.sourceBefore) {
      try { report.sourceAfter = await sources(); assert.deepEqual(report.sourceBefore, report.sourceAfter) }
      catch (error) { fail('source-after', error) }
    }
    if (report.simulator) {
      try { report.simulator.sha256After = sha256(await readFile(options.simulatorBin)); assert.equal(report.simulator.sha256After, report.simulator.sha256) }
      catch (error) { fail('simulator-after', error) }
    }
    if (!simulator) {
      try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true } catch (error) { errors.push(String(error)) }
    } else report.cleanup.preservedTemporary = temporary
    try { runner.dispose(); signals.dispose() } catch (error) { errors.push(String(error)) }
    report.cleanup.noBrowserOrDeviceCreated = true
    if (errors.length) { report.cleanup.errors = errors; errors.forEach(error => fail('cleanup', new Error(error))) }
    report.status = report.failures.length === 0 && report.crossEngine === 'passed' && report.engines.every(entry => entry.status === 'passed') ? 'passed' : 'failed'
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n')
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out, cleanup: report.cleanup }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
