#!/usr/bin/env node
/** Real portable pack -> native engine -> layout, event and RGBA evidence.
 * This raw weapp fixture is auxiliary conformance, not an official IDE run.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'
export { matchedResponse } from './simulator-cli-harness.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'conformance/fixtures/style-module-boundary')
const SESSION = 'simulator-1'
const VIEWPORT = { width: 200, height: 160 }
const ENGINES = ['quickjs', 'v8']

function parseArguments(argv) {
  const options = { out: resolve(ROOT, 'artifacts/style-module-boundary.json'), timeoutMs: 120_000 }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--') continue
    if (name === '--help' || name === '-h') return { help: true }
    if (!['--out', '--timeout', '--simulator-bin'].includes(name)) throw new Error(`Unknown option: ${name}`)
    const value = argv[++index]
    if (!value) throw new Error(`${name} requires a value`)
    if (name === '--out') options.out = resolve(value)
    if (name === '--simulator-bin') options.simulatorBin = resolve(value)
    if (name === '--timeout') options.timeoutMs = Number(value)
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error('--timeout must be >= 1000 milliseconds')
  return options
}

function request(requestId, op, payload) {
  return { protocolVersion: '1.0', sessionId: SESSION, requestId, kind: 'request', op, payload }
}

function query(phase, operation, fields) {
  return request(`${phase}-${operation}`, 'api.call', {
    name: 'wx.createSelectorQuery', selector: '#probe', all: false,
    operation: operation === 'geometry' ? 'boundingClientRect' : 'fields',
    ...(fields ? { fields } : {}),
  })
}

function queries(phase) {
  // Keep geometry and computedStyle separate: requested CSS width/height
  // intentionally share property names with numeric geometry in fields().
  return [
    query(phase, 'geometry'),
    query(phase, 'styles', { computedStyle: ['left', 'top', 'width', 'height', 'background-color'] }),
    query(phase, 'dataset', { dataset: true }),
  ]
}

export function inspectSnapshot(snapshot, box) {
  assert.equal(snapshot.width, VIEWPORT.width, 'snapshot width')
  assert.equal(snapshot.height, VIEWPORT.height, 'snapshot height')
  assert.equal(snapshot.stride, VIEWPORT.width * 4, 'RGBA stride')
  assert.ok(['rgba8', 'rgba8-premultiplied'].includes(snapshot.format), 'snapshot pixel format must be RGBA8')
  assert.ok(Array.isArray(snapshot.pixels), 'snapshot must contain actual RGBA bytes')
  assert.equal(snapshot.pixels.length, VIEWPORT.width * VIEWPORT.height * 4, 'complete snapshot pixels')
  for (const byte of snapshot.pixels) assert.ok(Number.isInteger(byte) && byte >= 0 && byte <= 255, 'valid RGBA byte')
  const rgba = [1, 3, 5].map(index => Number.parseInt(box.color.slice(index, index + 2), 16)).concat(255)
  const samples = []
  for (const [x, y] of [
    [box.left + 2, box.top + 2],
    [box.left + box.width - 3, box.top + 3],
    [box.left + 3, box.top + box.height - 3],
    [box.left + Math.floor(box.width / 2), box.top + Math.floor(box.height / 2)],
  ]) {
    const offset = y * snapshot.stride + x * 4
    const actual = snapshot.pixels.slice(offset, offset + 4)
    assert.deepEqual(actual, rgba, `actual RGBA fill at (${x},${y})`)
    samples.push({ x, y, rgba: actual })
  }
  for (const [x, y] of [[2, 2], [box.left + box.width + 2, box.top + 3], [box.left + 3, box.top + box.height + 2]]) {
    const offset = y * snapshot.stride + x * 4
    const actual = snapshot.pixels.slice(offset, offset + 4)
    assert.deepEqual(actual, [255, 255, 255, 255], `actual white outside box at (${x},${y})`)
    samples.push({ x, y, rgba: actual })
  }
  return { width: snapshot.width, height: snapshot.height, stride: snapshot.stride, format: snapshot.format,
    pixelBytes: snapshot.pixels.length, pixelSha256: sha256(Buffer.from(snapshot.pixels)), samples }
}

function inspectTrace(trace, phase, settings) {
  const records = trace.records ?? trace.events
  assert.ok(Array.isArray(records), 'trace records exist')
  for (const record of records) {
    for (const message of record.response?.messages ?? []) {
      assert.notEqual(message.op, 'error', `unexpected runtime error: ${JSON.stringify(message.payload)}`)
      assert.notEqual(message.payload?.ok, false, `unexpected request failure: ${JSON.stringify(message.payload)}`)
    }
  }
  const box = settings[phase === 'initial' ? 'initial' : 'updated']
  const geometry = matchedResponse(trace, `${phase}-geometry`, 'api.call').result
  const styles = matchedResponse(trace, `${phase}-styles`, 'api.call').result
  const dataset = matchedResponse(trace, `${phase}-dataset`, 'api.call').result?.dataset
  for (const [property, expected] of Object.entries({ left: box.left, top: box.top, width: box.width, height: box.height,
    right: box.left + box.width, bottom: box.top + box.height })) {
    assert.equal(geometry?.[property], expected, `${phase} layout ${property}`)
  }
  for (const property of ['left', 'top', 'width', 'height']) assert.equal(styles?.[property], `${box[property]}px`, `${phase} computed ${property}`)
  assert.equal(styles?.['background-color'], box.color, `${phase} computed background`)
  const expectedDataset = {
    count: phase === 'initial' ? 0 : 1, moduleIdentity: true, jsonIdentity: true,
    moduleLabel: settings.label, moduleTotal: 10,
    eventType: phase === 'initial' ? '' : 'tap', eventTarget: phase === 'initial' ? '' : 'probe',
    eventToken: phase === 'initial' ? '' : 'coordinate-hit',
  }
  assert.deepEqual(dataset, expectedDataset, `${phase} actual WXML-bound module/event data`)
  let event = null
  if (phase === 'updated') {
    const before = matchedResponse(trace, 'before-geometry', 'api.call').result
    assert.equal(before.width, settings.initial.width, 'tap starts from initial committed layout')
    assert.equal(before.height, settings.initial.height, 'tap starts from initial committed layout')
    const response = matchedResponse(trace, 'coordinate-tap', 'event.batch')
    assert.equal(response.events, 1, 'coordinate event must hit a render node')
    const hooks = response.hooks?.flatMap(result => Array.isArray(result) ? result : [result]) ?? []
    const handlers = hooks.filter(hook => hook.handler === 'changeStyle')
    assert.equal(handlers.length, 1, 'hit test must invoke declared WXML handler exactly once')
    assert.equal(handlers[0].currentTarget, 'probe', 'native hit resolves actual WXML id')
    const data = handlers[0].result
    assert.equal(data?.count, 1, 'setData changes actual page instance')
    assert.equal(data?.moduleIdentity, true, 'CJS repeated require identity')
    assert.equal(data?.jsonIdentity, true, 'JSON cached across importers')
    assert.equal(data?.eventToken, 'coordinate-hit', 'event detail reaches handler')
    assert.equal(data?.eventType, 'tap', 'event type reaches handler')
    assert.equal(data?.eventTarget, 'probe', 'event currentTarget reaches handler')
    matchedResponse(trace, 'refresh-page-state', 'render.commit')
    const renderRequest = records.find(record => record.request?.requestId === 'refresh-page-state').request
    assert.equal(Object.hasOwn(renderRequest.payload, 'data'), false, 'render must read live page data, without injected expected values')
    event = { events: response.events, hook: handlers[0] }
  }
  return { geometry, styles, dataset, event }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write('Usage: node scripts/style-module-boundary-smoke.mjs [--simulator-bin <path>] [--out <json>] [--timeout <ms>]\n')
    return
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-style-module-'))
  const report = {
    schemaVersion: 1, scope: 'style-module-boundary', status: 'failed', generatedAt: new Date().toISOString(),
    sourceCommit: null, fixture: { path: relative(ROOT, FIXTURE), sha256: null, kind: 'raw-weapp' },
    engines: [], comparison: { status: 'not-run' }, cleanup: {},
    evidenceBoundary: 'Auxiliary raw-weapp pack and native QuickJS/V8 conformance only. No official DevTools run, weapp-vite compilation, GPU surface, device, seven-host or performance acceptance is implied.',
  }
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: options.timeoutMs })
  const { command } = runner

  try {
    report.fixture.sha256 = await sourceHashes(FIXTURE)
    report.sourceCommit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.workingTreeDirty = Boolean((await command('git', ['status', '--short'])).stdout.trim())
    report.simulator = options.simulatorBin ? { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
      : { buildFeatures: ['quickjs-native', 'v8-native'], defaultFeatures: false }
    const compilerCommit = (await command('git', ['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD'])).stdout.trim()
    const pack = resolve(temporary, 'pack')
    const packed = await command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', FIXTURE, '--out', pack, '--compiler-commit', compilerCommit])
    const manifestBytes = await readFile(resolve(pack, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    const modules = Object.fromEntries(manifest.modules.map(module => [module.id, module]))
    assert.equal(modules['module:lib/helper.cjs']?.format, 'commonjs', 'packer includes CJS module')
    assert.equal(modules['module:lib/settings.json']?.format, 'json', 'packer includes JSON module')
    assert.ok(modules['module:lib/helper.cjs'].dependencies.includes('module:lib/settings.json'), 'CJS dependency graph includes JSON')
    assert.ok(modules['module:pages/index/index.js'].dependencies.includes('module:lib/helper.cjs'), 'page dependency graph includes CJS')
    const blobs = {}
    for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
      const bytes = await readFile(resolve(pack, 'blobs/sha256', name))
      assert.equal(sha256(bytes), name, 'actual content-addressed blob bytes match filename')
      blobs[`sha256:${name}`] = [...bytes]
    }
    report.pack = { manifestSha256: sha256(manifestBytes), integrityRoot: manifest.integrity.root,
      compilerCommit, rawFixtureNotCompilerOutput: true, modules: manifest.modules, command: packed.command }
    const settings = JSON.parse(await readFile(resolve(FIXTURE, 'lib/settings.json'), 'utf8'))
    for (const engine of ENGINES) {
      const engineReport = { engine, status: 'failed', phases: [] }
      report.engines.push(engineReport)
      for (const phase of ['initial', 'updated']) {
        const phaseReport = { phase, status: 'failed' }
        engineReport.phases.push(phaseReport)
        const prefix = resolve(temporary, `${engine}-${phase}`)
        try {
          const script = phase === 'initial' ? queries('initial') : [
            query('before', 'geometry'),
            request('coordinate-tap', 'event.batch', { events: [{ type: 'tap', x: 80, y: 32, detail: { token: 'coordinate-hit' } }] }),
            request('refresh-page-state', 'render.commit', { templateId: 'template:pages/index/index.wxml',
              blobs, styleIds: manifest.styles.map(style => style.id), viewport: VIEWPORT }),
            ...queries('updated'),
          ]
          await writeFile(`${prefix}.jsonl`, `${script.map(entry => JSON.stringify(entry)).join('\n')}\n`)
          const cliArgs = ['run', '--pack', pack, '--engine', engine, '--viewport', '200x160',
            '--script', `${prefix}.jsonl`, '--trace', `${prefix}.trace.json`, '--snapshot', `${prefix}.snapshot.json`, '--report', `${prefix}.report.json`]
          const executed = options.simulatorBin ? await command(options.simulatorBin, cliArgs)
            : await command(process.env.CARGO || 'cargo', ['run', '-p', 'container-simulator', '--no-default-features', '--features', 'quickjs-native,v8-native', '--locked', '--', ...cliArgs])
          phaseReport.process = Object.fromEntries(Object.entries(executed).filter(([key]) => key !== 'stdout'))
          const simulator = JSON.parse(await readFile(`${prefix}.report.json`, 'utf8'))
          const trace = JSON.parse(await readFile(`${prefix}.trace.json`, 'utf8'))
          const snapshot = JSON.parse(await readFile(`${prefix}.snapshot.json`, 'utf8'))
          phaseReport.responses = (trace.records ?? trace.events ?? []).map(record => ({
            sequence: record.sequence,
            request: { sessionId: record.request?.sessionId, requestId: record.request?.requestId, op: record.request?.op },
            response: record.response,
          }))
          phaseReport.snapshotBytesSha256 = sha256(Buffer.from(snapshot.pixels ?? []))
          assert.equal(simulator.status, 'passed', 'CLI report passes')
          assert.equal(simulator.engine, engine, 'actual requested engine, without fallback')
          assert.equal(simulator.route, 'pages/index/index', 'fixture route')
          assert.equal(simulator.lifecycleState, 'Active', 'canonical startup lifecycle')
          phaseReport.simulator = simulator
          phaseReport.observations = inspectTrace(trace, phase, settings)
          phaseReport.snapshot = inspectSnapshot(snapshot, settings[phase])
          phaseReport.status = 'passed'
        } catch (error) {
          phaseReport.error = error.stack ?? String(error)
          if (error.result) phaseReport.process = error.result
          if (runner.interrupted) throw error
        }
      }
      if (engineReport.phases.every(phase => phase.status === 'passed')) engineReport.status = 'passed'
    }
    if (report.engines.every(engine => engine.status === 'passed')) {
      const projections = report.engines.map(engine => engine.phases.map(phase => ({ phase: phase.phase,
        observations: phase.observations, snapshot: phase.snapshot })))
      assert.deepEqual(projections[0], projections[1], 'QuickJS/V8 actual geometry, CSS, events, modules and RGBA must agree')
      report.comparison = { status: 'passed', reason: 'Both engines match independently asserted layout, module, hit-test and actual RGBA expectations.' }
      report.status = 'passed'
    }
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (error.result) report.failedProcess = error.result
  } finally {
    if (runner.active) runner.stop()
    report.cleanup.childProcessClosed = runner.active === null
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true }
    catch (error) { report.cleanup.temporaryRemoved = false; report.cleanup.error = String(error); report.status = 'failed' }
    report.cleanup.noListenerOrBrowserCreated = true
    report.finishedAt = new Date().toISOString()
    if (runner.interrupted) { report.interrupted = runner.interrupted; report.status = 'failed' }
    await mkdir(dirname(options.out), { recursive: true })
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`)
    runner.dispose()
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, report: options.out, engines: report.engines.map(engine => ({ engine: engine.engine, status: engine.status })), cleanup: report.cleanup })}\n`)
  if (runner.interrupted) process.exitCode = runner.interrupted === 'SIGINT' ? 130 : 143
  else if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
