#!/usr/bin/env node
/** Actual development host turns, pinned compiler bytes and native CPU pixels. */
import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { canonicalize } from '../tools/container-manifest/src/index.mjs'
import { createOwnedCommandRunner, sha256, sourceHashes } from './simulator-cli-harness.mjs'
import { connectDevEvents, installSmokeSignals, readDevSessionPaths, startDevSimulator } from './simulator-dev-harness.mjs'
import { validateCompiler } from './scrolling-smoke.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'examples/apps/flex-order-app')
const WIDTH = 320, HEIGHT = 280
const GROUPS = { row: ['a', 'b', 'c'], column: ['a', 'b', 'c'], wrap: ['a', 'b', 'c', 'd'], stack: ['a', 'b'] }
const COLORS = { a: [220, 20, 60, 255], b: [20, 80, 220, 255], c: [0, 160, 70, 255], d: [255, 128, 0, 255] }

/** Independent fixed rectangles; no runtime frame or resolved layout is injected. */
export function expectedFlexOrderFrame(phase) {
  assert.ok(['initial', 'changed'].includes(phase))
  const changed = phase === 'changed', boxes = {}, pixels = Buffer.alloc(WIDTH * HEIGHT * 4, 255)
  const paint = (left, top, width, height, color) => {
    for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) {
      pixels.set(color, (y * WIDTH + x) * 4)
    }
  }
  const add = (id, left, top, width, height) => {
    boxes[id] = { left, top, width, height }
    paint(left, top, width, height, COLORS[id.split('-').at(-1)])
  }
  const row = changed ? ['a', 'b', 'c'] : ['b', 'c', 'a']
  for (const [index, id] of row.entries()) {
    add(`row-${id}`, 10 + index * 40, 10, 40, 30)
    add(`column-${id}`, 150, 10 + index * 30, 30, 30)
  }
  const wrap = changed ? ['a', 'b', 'c', 'd'] : ['b', 'c', 'd', 'a']
  for (const [index, id] of wrap.entries()) add(`wrap-${id}`, 10 + (index % 2) * 40, 60 + Math.floor(index / 2) * 30, 40, 30)
  for (const id of changed ? ['a', 'b'] : ['b', 'a']) add(`stack-${id}`, 10, 150, 40, 40)
  paint(10, 220, 70, 30, [51, 65, 85, 255])
  paint(100, 220, 70, 30, [100, 116, 139, 255])
  return { boxes, pixels }
}

function responseOf(batch, request) {
  assert.ok(Array.isArray(batch?.messages), 'bridge batch must contain messages')
  assert.deepEqual(batch.messages.filter(message => message.op === 'error' || message.payload?.ok === false), [], 'no runtime errors')
  const responses = batch.messages.filter(message => message.kind === 'response')
  assert.equal(responses.length, 1, 'exactly one response, including foreign responses')
  const response = responses[0]
  for (const key of ['sessionId', 'requestId', 'protocolVersion', 'op']) assert.equal(response[key], request[key], `response ${key}`)
  assert.equal(response.payload.ok, true)
  return response.payload
}

function traceSummary(state, count) {
  const summary = state.traceSummary
  assert.equal(state.traceCount, count)
  assert.equal(summary.complete, true)
  assert.equal(summary.totalRecords, count)
  assert.equal(summary.retainedRecords, count)
  assert.equal(summary.droppedRecords, 0)
  assert.equal(summary.droppedBytes, 0)
  assert.equal(summary.firstSequence, 1)
  assert.equal(summary.lastSequence, count)
  assert.equal(summary.diagnosticCode, null)
}

/** Verify selected actual HTTP/SSE observations, not a fabricated startup trace. */
export function inspectFlexOrderPhase(state, snapshot, journal, engine, phase, compiler) {
  const changed = phase === 'changed', sessionId = state.sessionId
  assert.equal(state.schemaVersion, 1)
  assert.equal(state.status, 'ready')
  assert.equal(state.engine, engine)
  assert.equal(state.renderer, 'skia-raster')
  assert.equal(state.route, 'pages/index/index')
  assert.equal(state.lifecycleState, 'Active')
  assert.equal(state.revision, 1, 'one unchanged compiler generation for both phases')
  assert.ok(typeof sessionId === 'string' && sessionId.length > 0)
  assert.deepEqual(state.compiler, compiler)
  assert.deepEqual(state.diagnostics ?? [], [])
  assert.deepEqual(state.diagnosticHistory?.records ?? [], [])
  const ids = changed ? ['overlap-initial', 'inspect-initial', 'read-initial', 'toggle', 'overlap-changed', 'inspect-changed', 'read-changed']
    : ['overlap-initial', 'inspect-initial', 'read-initial']
  assert.deepEqual(journal.map(record => record.request.requestId), ids)
  const coordinates = {
    'overlap-initial': [20, 160], 'inspect-initial': [110, 230],
    toggle: [20, 230], 'overlap-changed': [20, 160], 'inspect-changed': [110, 230],
  }
  let renders = 0, lastFrame = 1
  for (const record of journal) {
    const request = record.request
    assert.equal(request.kind, 'request'); assert.equal(request.protocolVersion, '1.0'); assert.equal(request.sessionId, sessionId)
    const point = coordinates[request.requestId]
    assert.equal(request.op, point ? 'event.batch' : 'api.call', 'only the recorded public input or storage operation')
    assert.deepEqual(request.payload, point ? { events: [{ type: 'tap', x: point[0], y: point[1] }] }
      : { name: 'wx.getStorageSync', key: 'flex-order:observation' }, 'exact coordinate or storage request')
    assert.deepEqual(record.acknowledgement, { queued: true })
    responseOf(record.bridge, request)
    if (request.op === 'event.batch') {
      assert.deepEqual(Object.keys(request.payload), ['events'])
      assert.equal(request.payload.events.length, 1)
      assert.equal(request.payload.events[0].type, 'tap')
      const automatic = record.automaticRender
      assert.ok(automatic, 'each real input host turn must publish automatically')
      const responses = automatic.bridge.messages.filter(message => message.kind === 'response')
      assert.equal(responses.length, 1)
      const response = responses[0]
      const rendered = responseOf(automatic.bridge, { ...response, sessionId, protocolVersion: '1.0', op: 'render.commit' })
      assert.equal(rendered.committed, true)
      assert.equal(rendered.source, 'manifest')
      assert.equal(rendered.templateId, 'template:pages/index/index.wxml')
      assert.equal(rendered.backend, 'skia-raster')
      assert.ok(rendered.frameId > lastFrame, 'the automatic frame follows the previous accepted frame')
      assert.equal(automatic.snapshotEvent.frameId, rendered.frameId)
      assert.equal(automatic.snapshotEvent.url, '/api/snapshot')
      assert.equal(automatic.state.snapshot.frame_id, rendered.frameId)
      assert.equal(automatic.state.sessionId, sessionId)
      assert.equal(automatic.state.revision, state.revision)
      lastFrame = rendered.frameId
      renders++
    } else {
      assert.deepEqual(request.payload, { name: 'wx.getStorageSync', key: 'flex-order:observation' })
      assert.equal(record.automaticRender, undefined)
    }
  }
  traceSummary(state, 4 + journal.length + renders)
  assert.equal(snapshot.frame_id, lastFrame)
  assert.deepEqual({ frame_id: snapshot.frame_id, width: snapshot.width, height: snapshot.height, stride: snapshot.stride,
    format: snapshot.format, pixelBytes: snapshot.pixels.length }, state.snapshot)
  assert.equal(snapshot.width, WIDTH); assert.equal(snapshot.height, HEIGHT); assert.equal(snapshot.stride, WIDTH * 4)
  assert.equal(snapshot.format, 'rgba8-premultiplied')
  assert.ok(snapshot.pixels.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
  const pixels = Buffer.from(snapshot.pixels), expected = expectedFlexOrderFrame(phase)
  assert.equal(pixels.length, WIDTH * HEIGHT * 4)
  assert.equal(sha256(pixels), sha256(expected.pixels), 'every RGBA byte must match the independent solid rectangle plan')
  assert.deepEqual(pixels, expected.pixels)
  const actual = responseOf(journal.at(-1).bridge, journal.at(-1).request).result
  assert.deepEqual(actual.data, { order: changed ? -1 : 2, toggles: Number(changed) })
  assert.equal(actual.route, 'pages/index/index'); assert.deepEqual(actual.trace, ['load', 'show', 'ready'])
  assert.deepEqual(actual.domOrder, Object.fromEntries(Object.entries(GROUPS).map(([group, ids]) => [group, ids.map(id => `${group}-${id}`)])),
    'selectors must preserve declaration order while visual order changes')
  assert.deepEqual(actual.hits, (changed ? ['a', 'b'] : ['a']).map(id => ({ target: `stack-${id}`, currentTarget: `stack-${id}`, dataset: { case: id } })))
  assert.equal(actual.geometry.length, 12)
  const geometry = Object.fromEntries(actual.geometry.map(node => [node.id, node]))
  assert.deepEqual(Object.keys(geometry).sort(), Object.keys(expected.boxes).sort())
  for (const [id, box] of Object.entries(expected.boxes)) for (const [key, value] of Object.entries(box)) {
    assert.ok(Number.isFinite(geometry[id][key]) && Math.abs(geometry[id][key] - value) < 0.02, `${id}.${key}: ${geometry[id][key]} != ${value}`)
  }
  return { actual, rgbaSha256: sha256(pixels), expectedRgbaSha256: sha256(expected.pixels), frameId: snapshot.frame_id }
}

async function treeBytes(directory, prefix = '') {
  const files = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), name = prefix + entry.name
    assert.equal((await lstat(path)).isSymbolicLink(), false, `no symlink in compiler/pack artifacts: ${name}`)
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

export async function main(argv = process.argv.slice(2)) {
  const options = {}, names = new Map([['--simulator-bin', 'simulatorBin'], ['--compiler-root', 'compilerRoot'],
    ['--compiler-dist-hashes', 'compilerDistHashes'], ['--out', 'out']])
  for (let index = 0; index < argv.length; index++) {
    const name = names.get(argv[index]); assert.ok(name && argv[index + 1], `unknown or incomplete argument: ${argv[index]}`)
    options[name] = resolve(argv[++index])
  }
  for (const name of names.values()) assert.ok(options[name], `${name} is required`)
  await mkdir(dirname(options.out), { recursive: true })
  const artifacts = options.out + '.files'; await mkdir(artifacts)
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-flex-order-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 }), { command } = runner
  const signals = installSmokeSignals()
  const report = { schemaVersion: 1, status: 'failed', engines: [], cleanup: {},
    boundary: 'Auxiliary development HTTP/SSE evidence: verified pinned compiler source/dist bytes, actual Page coordinate taps and automatic supervisor rendering, selectors and complete native Skia CPU RGBA. Each engine uses one session for both phases. Selected HTTP/SSE journal is not an exported internal startup trace or strict official conformance execution. No browser, DevTools, GPU/device or performance acceptance.' }
  const sources = async () => ({ fixture: await sourceHashes(FIXTURE), crates: await sourceHashes(resolve(ROOT, 'crates')),
    packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')), packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')),
    ...Object.fromEntries(await Promise.all(['Cargo.toml', 'Cargo.lock', 'scripts/flex-order-smoke.mjs', 'scripts/simulator-dev-harness.mjs',
      'scripts/simulator-watch.mjs', 'scripts/simulator-cli-harness.mjs', 'scripts/scrolling-smoke.mjs']
      .map(async path => [path, sha256(await readFile(resolve(ROOT, path)))]))) })
  const save = async (name, value, compress = false) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + '\n')
    const path = name + (compress ? '.gz' : ''), data = compress ? gzipSync(bytes, { mtime: 0 }) : bytes
    await writeFile(resolve(artifacts, path), data)
    return { path, sha256: sha256(data), ...(compress ? { rawSha256: sha256(bytes) } : {}) }
  }
  let simulator, sse, activeEntry
  try {
    report.commit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    const commit = (await command('git', ['rev-parse', 'HEAD:vendor/weapp-vite'])).stdout.trim()
    report.sourceBefore = await sources()
    report.simulator = { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
    report.compiler = { directory: options.compilerRoot, before: await validateCompiler(options, command, commit) }
    for (const engine of ['quickjs', 'v8']) {
      const project = resolve(temporary, engine); await cp(FIXTURE, project, { recursive: true })
      const output = { stdout: '', stderr: '' }, journal = []
      const entry = { engine, phases: [] }; activeEntry = entry; report.engines.push(entry)
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
        const pack = resolve(entry.developmentSession.runRoot, 'generation-1')
        const manifestBytes = await readFile(resolve(pack, 'manifest.json')), manifest = JSON.parse(manifestBytes), blobs = {}
        assert.equal(manifest.compiler.name, 'weapp-vite'); assert.equal(manifest.compiler.platform, 'weapp')
        assert.ok(['unknown', commit].includes(manifest.compiler.commit))
        entry.compilerIdentity = { manifest: manifest.compiler, verifiedSourceCommit: commit,
          limitation: manifest.compiler.commit === 'unknown' ? 'The verified compiler is an archive without Git metadata; the existing development adapter records unknown. Byte provenance is independently checked before/after; metadata is preserved unchanged.' : null }
        entry.manifest = await save(`${engine}-manifest.json`, manifestBytes)
        entry.integrityRoot = manifest.integrity.root
        for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
          const bytes = await readFile(resolve(pack, 'blobs/sha256', name)); assert.equal(sha256(bytes), name)
          blobs[`sha256:${name}`] = [...bytes]
        }
        validatePack(manifest, blobs)
        entry.blobs = await save(`${engine}-blobs.json`, blobs, true)
        const rawRoot = entry.developmentSession.compilerOutput, raw = await treeBytes(rawRoot)
        entry.rawOutput = await sourceHashes(rawRoot)
        entry.rawOutputArtifact = await save(`${engine}-compiler-output.json`, raw, true)
        const compilerRoot = resolve(entry.developmentSession.preparationRoot, '.compiler')
        entry.remainingCompilerFiles = await save(`${engine}-remaining-compiler-files.json`, await treeBytes(compilerRoot), true)
        entry.compilerReceiptLimitation = 'The supervisor consumes and deletes receipts and temporary snapshots. No historical success receipt or temporary snapshot is claimed; the published pack is independently regenerated from the archived original compiler output and compared byte for byte.'
        entry.packHashes = await sourceHashes(pack)
        const independentPack = resolve(temporary, `${engine}-independent-pack`)
        entry.independentPackCommand = await save(`${engine}-independent-pack-command.json`, await command(process.execPath, [
          resolve(ROOT, 'tools/container-manifest/bin/container-pack.mjs'), rawRoot, '--out', independentPack,
          '--platform', 'weapp', '--compiler-commit', manifest.compiler.commit,
        ]))
        assert.deepEqual(await treeBytes(independentPack), await treeBytes(pack), 'entire published pack equals the independent raw-output pack')
        entry.independentPackHashes = await sourceHashes(independentPack)
        assert.deepEqual(entry.independentPackHashes, entry.packHashes)
        sse = await connectDevEvents(simulator.url, 120_000, { signal: signals.signal })
        const send = async (requestId, op, payload) => {
          const request = { protocolVersion: '1.0', sessionId: ready.sessionId, requestId, kind: 'request', op, payload }
          const eventPromise = sse.nextEvent('bridge', batch => batch.messages?.some(message => message.kind === 'response' && message.requestId === requestId))
          eventPromise.catch(() => {})
          const [acknowledgement, bridge] = await Promise.all([simulator.json('/api/bridge', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
          }), eventPromise])
          responseOf(bridge, request)
          const record = { request, acknowledgement, bridge }; journal.push(record)
          if (op === 'event.batch') {
            const automatic = await sse.nextEvent('bridge', batch => batch.messages?.some(message => message.kind === 'response' && message.op === 'render.commit'))
            const response = automatic.messages.find(message => message.kind === 'response' && message.op === 'render.commit')
            const frameId = response.payload.frameId
            const snapshotEvent = await sse.nextEvent('snapshot', event => event.frameId === frameId)
            const state = await simulator.waitForState(value => value.sessionId === ready.sessionId && value.snapshot?.frame_id === frameId, 'automatic input frame')
            record.automaticRender = { bridge: automatic, snapshotEvent, state }
          }
          return responseOf(bridge, request)
        }
        const tap = (id, x, y) => send(id, 'event.batch', { events: [{ type: 'tap', x, y }] })
        await tap('overlap-initial', 20, 160)
        for (const phase of ['initial', 'changed']) {
          if (phase === 'changed') { await tap('toggle', 20, 230); await tap('overlap-changed', 20, 160) }
          await tap(`inspect-${phase}`, 110, 230)
          await send(`read-${phase}`, 'api.call', { name: 'wx.getStorageSync', key: 'flex-order:observation' })
          const state = await simulator.json('/api/state'), snapshot = await simulator.json('/api/snapshot')
          const result = { name: phase, state: await save(`${engine}-${phase}.state.json`, state),
            snapshot: await save(`${engine}-${phase}.snapshot.json`, snapshot, true),
            journal: await save(`${engine}-${phase}.http-sse.json`, journal, true) }
          entry.phases.push(result)
          result.observation = inspectFlexOrderPhase(state, snapshot, journal, engine, phase, manifest.compiler)
          result.status = 'passed'
        }
        assert.notEqual(entry.phases[0].observation.rgbaSha256, entry.phases[1].observation.rgbaSha256)
        assert.deepEqual(await sourceHashes(rawRoot), entry.rawOutput)
        assert.deepEqual(await sourceHashes(pack), entry.packHashes)
        assert.deepEqual(await treeBytes(rawRoot), raw)
        entry.rawOutputUnmodified = true
        entry.status = 'passed'
      } finally {
        const cleanupErrors = []
        try { if (sse) await sse.close(); entry.sseClosed = true; sse = null } catch (error) { cleanupErrors.push(String(error)) }
        try { if (simulator) entry.cleanup = await simulator.stop(); simulator = null } catch (error) { cleanupErrors.push(String(error)) }
        try {
          if (entry.developmentSession && entry.cleanup?.processExited) {
            await assert.rejects(lstat(entry.developmentSession.preparationRoot), { code: 'ENOENT' })
            entry.cleanup.preparationRemoved = true
          }
        } catch (error) { cleanupErrors.push(`compiler preparation cleanup: ${error}`) }
        entry.finalJournal = await save(`${engine}-final.http-sse.json`, journal, true)
        entry.stdout = await save(`${engine}.stdout`, Buffer.from(output.stdout), true)
        entry.stderr = await save(`${engine}.stderr`, Buffer.from(output.stderr), true)
        if (cleanupErrors.length) { entry.status = 'failed'; entry.cleanupErrors = cleanupErrors; throw new Error(cleanupErrors.join('; ')) }
      }
    }
    assert.deepEqual(report.engines[0].phases.map(phase => phase.observation), report.engines[1].phases.map(phase => phase.observation))
    report.compiler.after = await validateCompiler(options, command, commit)
    assert.deepEqual(report.compiler.before, report.compiler.after)
    report.sourceAfter = await sources(); assert.deepEqual(report.sourceBefore, report.sourceAfter)
    assert.equal(sha256(await readFile(options.simulatorBin)), report.simulator.sha256)
    report.status = 'passed'
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (activeEntry && activeEntry.status !== 'passed') activeEntry.status = 'failed'
    if (error.result) report.failedCommand = await save('failed-command.json', error.result)
  } finally {
    const errors = []
    try { if (sse) await sse.close() } catch (error) { errors.push(String(error)) }
    try { if (simulator) await simulator.stop(); simulator = null } catch (error) { errors.push(String(error)) }
    try { assert.equal(runner.active, null); report.cleanup.commandChildrenStopped = true } catch (error) { errors.push(String(error)) }
    if (!simulator) {
      try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true } catch (error) { errors.push(String(error)) }
    } else report.cleanup.preservedTemporary = temporary
    try { runner.dispose(); signals.dispose() } catch (error) { errors.push(String(error)) }
    report.cleanup.noBrowserOrDeviceCreated = true
    if (errors.length) { report.status = 'failed'; report.cleanup.errors = errors }
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n')
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out, cleanup: report.cleanup }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
