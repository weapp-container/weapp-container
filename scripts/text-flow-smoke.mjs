#!/usr/bin/env node
/** Actual development host turns, pinned compiler bytes and native CPU pixels. */
import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { canonicalize } from '../tools/container-manifest/src/index.ts'
import { createOwnedCommandRunner, sha256, sourceHashes } from './simulator-cli-harness.mjs'
import { connectDevEvents, installSmokeSignals, readDevSessionPaths, startDevSimulator } from './simulator-dev-harness.mjs'
import { validateCompiler } from './scrolling-smoke.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'examples/apps/text-flow-app')
const WIDTH = 320, HEIGHT = 680
const RAW = '  AA\tBB\r\n CC  DD  '
const IDS = ['dynamic-raw', 'dynamic-word', 'dynamic-align', 'graphemes',
  ...['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'].map(value => `ws-${value}`),
  ...['normal', 'break-all', 'keep-all'].map(value => `wb-${value}`),
  ...['start', 'end', 'left', 'right', 'center'].map(value => `align-${value}`)]

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
export function inspectTextFlowPhase(state, snapshot, journal, engine, phase, compiler) {
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
  const ids = changed ? ['inspect-initial', 'read-initial', 'toggle', 'inspect-changed', 'read-changed']
    : ['inspect-initial', 'read-initial']
  assert.deepEqual(journal.map(record => record.request.requestId), ids)
  const coordinates = { 'inspect-initial': [180, 610], toggle: [20, 610], 'inspect-changed': [180, 610] }
  let renders = 0, lastFrame = 1
  for (const record of journal) {
    const request = record.request
    assert.equal(request.kind, 'request'); assert.equal(request.protocolVersion, '1.0'); assert.equal(request.sessionId, sessionId)
    const point = coordinates[request.requestId]
    assert.equal(request.op, point ? 'event.batch' : 'api.call', 'only the recorded public input or storage operation')
    assert.deepEqual(request.payload, point ? { events: [{ type: 'tap', x: point[0], y: point[1] }] }
      : { name: 'wx.getStorageSync', key: 'text-flow:observation' }, 'exact coordinate or storage request')
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
      assert.deepEqual(request.payload, { name: 'wx.getStorageSync', key: 'text-flow:observation' })
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
  const pixels = Buffer.from(snapshot.pixels)
  assert.equal(pixels.length, WIDTH * HEIGHT * 4)
  const actual = responseOf(journal.at(-1).bridge, journal.at(-1).request).result
  assert.deepEqual(actual.data, { phase: changed ? 'changed' : 'initial', toggles: Number(changed),
    whiteSpace: changed ? 'break-spaces' : 'normal', wordBreak: changed ? 'break-all' : 'normal',
    textAlign: changed ? 'right' : 'start', raw: RAW, longLatin: 'Supercalifragilisticexpialidocious',
    cjk: '甲乙丙丁戊己庚辛壬癸', graphemes: 'A\u0301👩‍💻🇨🇳', alignment: 'AB' })
  assert.equal(actual.route, 'pages/index/index'); assert.deepEqual(actual.trace, ['load', 'show', 'ready'])
  assert.equal(actual.geometry.length, IDS.length)
  const geometry = Object.fromEntries(actual.geometry.map(node => [node.id, node]))
  assert.deepEqual(Object.keys(geometry).sort(), [...IDS].sort())
  const near = (value, expected, label) => assert.ok(Number.isFinite(value) && Math.abs(value - expected) < 0.02,
    `${label}: ${value} != ${expected}`)
  for (const [id, node] of Object.entries(geometry)) {
    assert.equal(node['font-size'], '16px', `${id} font size`)
    assert.equal(node['line-height'], '20px', `${id} line height`)
    const ws = id.startsWith('ws-') ? id.slice(3) : id.startsWith('dynamic-') && id !== 'dynamic-align'
      ? actual.data.whiteSpace : id === 'graphemes' ? 'pre-wrap' : 'normal'
    const wb = id.startsWith('wb-') ? id.slice(3) : id.startsWith('dynamic-') && id !== 'dynamic-align'
      ? actual.data.wordBreak : id === 'graphemes' ? 'break-all' : 'normal'
    const align = id.startsWith('align-') ? id.slice(6) : id.startsWith('dynamic-') ? actual.data.textAlign : 'start'
    assert.equal(node['white-space'], ws, `${id} white-space`)
    assert.equal(node['word-break'], wb, `${id} word-break`)
    assert.equal(node['text-align'], align, `${id} text-align`)
    assert.ok(node.height >= 20 && node.height % 20 < 0.02, `${id}: integral nonempty line boxes`)
  }
  for (const id of ['ws-normal', 'ws-nowrap', 'dynamic-align', ...['start', 'end', 'left', 'right', 'center'].map(a => `align-${a}`)]) {
    near(geometry[id].height, 20, `${id} single line`)
  }
  for (const id of ['ws-pre', 'ws-pre-line']) near(geometry[id].height, 40, `${id} hard newline`)
  for (const id of ['ws-pre-wrap', 'ws-break-spaces']) assert.ok(geometry[id].height >= 40, `${id} preserves newline`)
  near(geometry['dynamic-raw'].height, changed ? 40 : 20, 'dynamic raw newline')
  if (changed) assert.ok(geometry['dynamic-word'].height >= 40, 'break-all wraps the long Latin word')
  else near(geometry['dynamic-word'].height, 20, 'normal retains unbreakable long Latin word')
  near(geometry['wb-keep-all'].height, 20, 'keep-all does not break CJK run')
  assert.ok(geometry['wb-normal'].height > 20 && geometry['wb-break-all'].height > 20, 'CJK normal/break-all wrap')
  // Inspect the actual complete native CPU RGBA, including the dynamic text
  // sample. The font is not replaced with a synthetic geometry fixture.
  const ink = []
  for (let y = 120; y < 140; y++) for (let x = 8; x < 152; x++) {
    const index = (y * WIDTH + x) * 4
    if (pixels[index] < 128 && pixels[index + 1] < 128 && pixels[index + 2] < 128) ink.push(x - 8)
  }
  assert.ok(ink.length > 0, 'dynamic alignment paints real glyph ink')
  const inkBounds = { minX: Math.min(...ink), maxX: Math.max(...ink), pixelCount: ink.length }
  if (changed) assert.ok(inkBounds.minX > 72, 'right alignment moves glyph ink to the right half')
  else assert.ok(inkBounds.maxX < 72, 'start alignment keeps glyph ink in the left half')
  return { actual, rgbaSha256: sha256(pixels), inkBounds, frameId: snapshot.frame_id }

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
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-text-flow-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 }), { command } = runner
  const signals = installSmokeSignals()
  const report = { schemaVersion: 1, status: 'failed', engines: [], cleanup: {},
    environment: { platform: process.platform, arch: process.arch, node: process.version,
      fontProvider: 'Native Skia platform/system provider; exact selected faces are not exported by this collector.' },
    pixelAssertionBoundary: 'Complete RGBA is archived and compared across engines; independent ink assertions cover only the dynamic AB alignment region. Geometry uses this host font provider. Grapheme/CJK data and line-box checks do not certify shaping, glyph coverage or complete UAX14 behavior.',
    boundary: 'Auxiliary development HTTP/SSE evidence: verified pinned compiler source/dist bytes, actual Page coordinate taps and automatic supervisor rendering, selectors and complete native Skia CPU RGBA. Each engine uses one session for both phases. Selected HTTP/SSE journal is not an exported internal startup trace or strict official conformance execution. No browser, DevTools, GPU/device or performance acceptance.' }
  const sources = async () => ({ fixture: await sourceHashes(FIXTURE), crates: await sourceHashes(resolve(ROOT, 'crates')),
    packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')), packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')),
    ...Object.fromEntries(await Promise.all(['Cargo.toml', 'Cargo.lock', 'scripts/text-flow-smoke.mjs', 'scripts/simulator-dev-harness.mjs',
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
        entry.packArtifact = await save(`${engine}-published-pack.json`, await treeBytes(pack), true)
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
        for (const phase of ['initial', 'changed']) {
          if (phase === 'changed') await tap('toggle', 20, 610)
          await tap(`inspect-${phase}`, 180, 610)
          await send(`read-${phase}`, 'api.call', { name: 'wx.getStorageSync', key: 'text-flow:observation' })
          const state = await simulator.json('/api/state'), snapshot = await simulator.json('/api/snapshot')
          const result = { name: phase, state: await save(`${engine}-${phase}.state.json`, state),
            snapshot: await save(`${engine}-${phase}.snapshot.json`, snapshot, true),
            journal: await save(`${engine}-${phase}.http-sse.json`, journal, true) }
          entry.phases.push(result)
          result.observation = inspectTextFlowPhase(state, snapshot, journal, engine, phase, manifest.compiler)
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
