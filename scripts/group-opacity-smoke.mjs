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
const FIXTURE = resolve(ROOT, 'examples/apps/group-opacity-app')
const WIDTH = 320, HEIGHT = 300
export const GROUP_OPACITY_PHASES = ['initial', 'restored', 'hidden-again', 'restored-again']
const BOXES = {
  group: { left:10, top:20, width:120, height:100 },
  green: { left:20, top:30, width:70, height:60 },
  blue: { left:50, top:50, width:70, height:60 },
  outer: { left:160, top:20, width:120, height:100 },
  inner: { left:170, top:30, width:90, height:70 },
  'nested-blue': { left:200, top:50, width:40, height:40 },
  ghost: { left:10, top:150, width:80, height:50 },
  'ghost-child': { left:20, top:160, width:60, height:30 },
}

export function groupOpacityData(phase) {
  assert.ok(GROUP_OPACITY_PHASES.includes(phase))
  const visible = phase === 'restored' || phase === 'restored-again'
  return { groupOpacity: visible ? 1 : 0.5, ghostOpacity: Number(visible),
    hiddenTaps: phase === 'initial' ? 0 : phase === 'restored-again' ? 2 : 1,
    resets: phase === 'hidden-again' || phase === 'restored-again' ? 1 : 0 }
}

/** Independent complete opaque RGBA plan; alpha=.5 rounds to alpha8=128.
 * A one-byte tolerance accommodates independent backend quantization. */
export function expectedGroupOpacityFrame(phase) {
  const data = groupOpacityData(phase), pixels = Buffer.alloc(WIDTH * HEIGHT * 4, 255)
  const paint = (box, color) => {
    for (let y=box.top; y<box.top+box.height; y++) for (let x=box.left; x<box.left+box.width; x++) {
      pixels.set([...color, 255], (y * WIDTH + x) * 4)
    }
  }
  paint(BOXES.group, data.groupOpacity === 1 ? [255,0,0] : [255,127,127])
  paint(BOXES.green, data.groupOpacity === 1 ? [0,255,0] : [127,255,127])
  paint(BOXES.blue, data.groupOpacity === 1 ? [0,0,255] : [127,127,255])
  paint(BOXES.outer, [255,127,127])
  paint(BOXES.inner, [191,191,127])
  paint(BOXES['nested-blue'], [191,127,191])
  if (data.ghostOpacity) { paint(BOXES.ghost, [0,255,0]); paint(BOXES['ghost-child'], [0,0,255]) }
  paint({left:10,top:240,width:70,height:30}, [51,65,85])
  paint({left:100,top:240,width:70,height:30}, [100,116,139])
  return { boxes: BOXES, pixels }
}

/** Check every channel, including the overlap, nested and invisible regions. */
export function compareGroupOpacityPixels(pixels, phase, { strict = true } = {}) {
  const expected = expectedGroupOpacityFrame(phase).pixels
  assert.equal(pixels.length, expected.length)
  let maximumChannelError = 0, differingChannels = 0, channelsOverTolerance = 0
  const firstDifferences = []
  for (let index = 0; index < pixels.length; index++) {
    const error = Math.abs(pixels[index] - expected[index])
    maximumChannelError = Math.max(maximumChannelError, error)
    if (error) differingChannels++
    if (error > (index % 4 === 3 ? 0 : 1)) {
      channelsOverTolerance++
      if (firstDifferences.length < 16) firstDifferences.push({ x: Math.floor(index/4)%WIDTH,
        y: Math.floor(index/(WIDTH*4)), channel: index%4, actual: pixels[index], expected: expected[index] })
    }
  }
  const samples = Object.fromEntries(Object.entries({ background:[5,5], parent:[15,25], green:[25,35],
    overlap:[60,60], blue:[110,100], nestedParent:[165,25], nestedGreen:[175,35], nestedBlue:[210,60],
    ghostParent:[15,155], ghostChild:[30,170] }).map(([name,[x,y]]) => [name,[...pixels.subarray((y*WIDTH+x)*4,(y*WIDTH+x)*4+4)]]))
  if (strict) assert.equal(channelsOverTolerance, 0, `full RGBA exceeds RGB<=1/alpha exact: ${JSON.stringify(firstDifferences)}`)
  return { rgbaSha256: sha256(pixels), expectedRgbaSha256: sha256(expected), maximumChannelError,
    differingChannels, channelsOverTolerance, firstDifferences, comparisonPassed: channelsOverTolerance === 0, samples }
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
export function inspectGroupOpacityPhase(state, snapshot, journal, engine, phase, compiler) {
  const phaseIndex = GROUP_OPACITY_PHASES.indexOf(phase), data = groupOpacityData(phase), sessionId = state.sessionId
  assert.ok(phaseIndex >= 0)
  assert.equal(state.schemaVersion, 1); assert.equal(state.status, 'ready')
  assert.equal(state.engine, engine); assert.equal(state.renderer, 'skia-raster')
  assert.equal(state.route, 'pages/index/index'); assert.equal(state.lifecycleState, 'Active')
  assert.equal(state.revision, 1, 'one unchanged compiler generation for all four phases')
  assert.ok(typeof sessionId === 'string' && sessionId.length > 0)
  assert.deepEqual(state.compiler, compiler)
  assert.deepEqual(state.diagnostics ?? [], []); assert.deepEqual(state.diagnosticHistory?.records ?? [], [])
  const ids = GROUP_OPACITY_PHASES.slice(0,phaseIndex+1).flatMap(name => [
    ...(name === 'initial' ? [] : [name === 'hidden-again' ? 'reset' : `ghost-${name}`]), `inspect-${name}`, `read-${name}`])
  assert.deepEqual(journal.map(record => record.request.requestId), ids)
  let renders = 0, lastFrame = 1
  for (const record of journal) {
    const request = record.request
    assert.equal(request.kind, 'request'); assert.equal(request.protocolVersion, '1.0'); assert.equal(request.sessionId, sessionId)
    const point = request.requestId.startsWith('inspect-') ? [110,250]
      : request.requestId.startsWith('ghost-') ? [30,170] : request.requestId === 'reset' ? [20,250] : null
    assert.equal(request.op, point ? 'event.batch' : 'api.call', 'only recorded public input or storage')
    assert.deepEqual(request.payload, point ? { events: [{ type:'tap', x:point[0], y:point[1] }] }
      : { name:'wx.getStorageSync', key:'group-opacity:observation' })
    assert.deepEqual(record.acknowledgement, { queued:true }); responseOf(record.bridge,request)
    if (point) {
      const automatic = record.automaticRender
      assert.ok(automatic, 'each real input must automatically publish a supervisor frame')
      const responses = automatic.bridge.messages.filter(message => message.kind === 'response')
      assert.equal(responses.length,1)
      const response = responses[0]
      const rendered = responseOf(automatic.bridge,{...response,sessionId,protocolVersion:'1.0',op:'render.commit'})
      assert.equal(rendered.committed,true); assert.equal(rendered.source,'manifest')
      assert.equal(rendered.templateId,'template:pages/index/index.wxml'); assert.equal(rendered.backend,'skia-raster')
      assert.ok(rendered.frameId > lastFrame)
      assert.equal(automatic.snapshotEvent.frameId,rendered.frameId); assert.equal(automatic.snapshotEvent.url,'/api/snapshot')
      assert.equal(automatic.state.snapshot.frame_id,rendered.frameId); assert.equal(automatic.state.sessionId,sessionId)
      assert.equal(automatic.state.revision,state.revision)
      lastFrame=rendered.frameId; renders++
    } else assert.equal(record.automaticRender,undefined)
  }
  traceSummary(state,4+journal.length+renders)
  assert.equal(snapshot.frame_id,lastFrame)
  assert.deepEqual({frame_id:snapshot.frame_id,width:snapshot.width,height:snapshot.height,stride:snapshot.stride,
    format:snapshot.format,pixelBytes:snapshot.pixels.length},state.snapshot)
  assert.equal(snapshot.width,WIDTH); assert.equal(snapshot.height,HEIGHT); assert.equal(snapshot.stride,WIDTH*4)
  assert.equal(snapshot.format,'rgba8-premultiplied')
  assert.ok(snapshot.pixels.every(value => Number.isInteger(value) && value>=0 && value<=255))
  const pixels=Buffer.from(snapshot.pixels), pixelResult=compareGroupOpacityPixels(pixels,phase)
  const actual=responseOf(journal.at(-1).bridge,journal.at(-1).request).result
  assert.deepEqual(actual.data,data)
  assert.equal(actual.route,'pages/index/index'); assert.deepEqual(actual.trace,['load','show','ready'])
  const expectedHits=Array.from({length:data.hiddenTaps},()=>[
    {target:'ghost-child',currentTarget:'ghost-child',dataset:{case:'invisible-child'},beforeOpacity:0},
    {target:'ghost-child',currentTarget:'ghost',dataset:{case:'ancestor'}},
  ]).flat()
  assert.deepEqual(actual.hits,expectedHits,'zero-opacity ancestor keeps child targeting, dataset and bubbling')
  const expectedOpacity={group:String(data.groupOpacity),green:'',blue:'',outer:'0.5',inner:'0.5',
    'nested-blue':'',ghost:String(data.ghostOpacity),'ghost-child':'1'}
  assert.equal(actual.geometry.length,Object.keys(BOXES).length)
  const geometry=Object.fromEntries(actual.geometry.map(node=>[node.id,node]))
  assert.deepEqual(Object.keys(geometry),Object.keys(BOXES),'selection keeps declaration order including opacity0 nodes')
  const expectedBackground={group:'red',green:'lime',blue:'blue',outer:'red',inner:'lime',
    'nested-blue':'blue',ghost:'lime','ghost-child':'blue'}
  const colorForms={red:['red','#f00','#ff0000','rgb(255,0,0)','rgba(255,0,0,1)'],
    lime:['lime','#0f0','#00ff00','rgb(0,255,0)','rgba(0,255,0,1)'],
    blue:['blue','#00f','#0000ff','rgb(0,0,255)','rgba(0,0,255,1)']}
  for (const [id,box] of Object.entries(BOXES)) {
    for (const [key,value] of Object.entries(box)) assert.ok(Number.isFinite(geometry[id][key]) && Math.abs(geometry[id][key]-value)<0.02,
      `${id}.${key}: ${geometry[id][key]} != ${value}`)
    assert.equal(geometry[id].opacity,expectedOpacity[id],`${id} computed opacity`)
    assert.ok(colorForms[expectedBackground[id]].includes(geometry[id]['background-color']?.replace(/\s/g,'').toLowerCase()),`${id} declared background: ${geometry[id]['background-color']}`)
  }
  return {actual,...pixelResult,frameId:snapshot.frame_id}
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
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-group-opacity-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: 180_000 }), { command } = runner
  const signals = installSmokeSignals()
  const report = { schemaVersion: 1, status: 'failed', engines: [], cleanup: {},
    pixelAssertionBoundary: 'Every RGBA channel is independently checked against fixed group-composited rectangles with at most one byte of RGB rounding tolerance and exact alpha. QuickJS and V8 full frames must be identical. No font rasterization is present.',
    boundary: 'Auxiliary development HTTP/SSE evidence: verified pinned compiler source/dist bytes, actual Page coordinate taps and automatic supervisor rendering, selectors and complete native Skia CPU RGBA. Each engine uses one session for all four phases. Selected HTTP/SSE journal is not an exported internal startup trace or strict official conformance execution. No browser, DevTools, GPU/device or performance acceptance.' }
  const sources = async () => ({ fixture: await sourceHashes(FIXTURE), crates: await sourceHashes(resolve(ROOT, 'crates')),
    packer: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')), packerBin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')),
    ...Object.fromEntries(await Promise.all(['Cargo.toml', 'Cargo.lock', 'scripts/group-opacity-smoke.mjs', 'scripts/simulator-dev-harness.mjs',
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
        for (const phase of GROUP_OPACITY_PHASES) {
          if (phase === 'restored' || phase === 'restored-again') await tap(`ghost-${phase}`,30,170)
          if (phase === 'hidden-again') await tap('reset',20,250)
          await tap(`inspect-${phase}`,110,250)
          await send(`read-${phase}`,'api.call',{name:'wx.getStorageSync',key:'group-opacity:observation'})
          const state=await simulator.json('/api/state'), snapshot=await simulator.json('/api/snapshot')
          const result={name:phase,state:await save(`${engine}-${phase}.state.json`,state),
            snapshot:await save(`${engine}-${phase}.snapshot.json`,snapshot,true),
            journal:await save(`${engine}-${phase}.http-sse.json`,journal,true)}
          entry.phases.push(result)
          result.observation=inspectGroupOpacityPhase(state,snapshot,journal,engine,phase,manifest.compiler)
          result.status='passed'
        }
        const hashes=entry.phases.map(phase=>phase.observation.rgbaSha256)
        assert.notEqual(hashes[0],hashes[1]); assert.equal(hashes[0],hashes[2]); assert.equal(hashes[1],hashes[3])
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
