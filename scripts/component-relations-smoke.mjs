#!/usr/bin/env node
/** Hand-authored native weapp -> portable pack -> actual QuickJS/V8 relations. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'conformance/fixtures/component-relations')
const PHASES = ['initial', 'mutated', 'removed', 'restored']
const VIEWPORT = { width: 200, height: 160 }
export const INITIAL_TRACE = Object.freeze([
  'parent:attached:none', 'child:attached:none', 'parent:linked:child', 'child:linked:parent',
  'page:onLoad', 'parent:ready:child', 'child:ready:parent',
])
export const REMOVED_TRACE = Object.freeze([
  ...INITIAL_TRACE, 'child:detached:parent', 'parent:unlinked:none', 'child:unlinked:none',
])
export const RESTORED_TRACE = Object.freeze([
  ...REMOVED_TRACE, 'child:attached:none', 'parent:linked:child', 'child:linked:parent', 'child:ready:parent',
])

function request(requestId, op, payload) {
  return { protocolVersion: '1.0', sessionId: 'simulator-1', requestId, kind: 'request', op, payload }
}

function call(requestId, name) {
  return request(requestId, 'module.call', { moduleId: 'module:pages/index/index.js', export: name, args: [] })
}

export function inspectSummary(summary, phase) {
  assert.ok(PHASES.includes(phase), 'recognized observation phase')
  const present = phase !== 'removed'
  const mutated = phase === 'mutated'
  const restored = phase === 'restored'
  assert.equal(summary?.launched, true, `${phase}: real App.onLaunch precedes Page.onLoad`)
  assert.deepEqual(summary.capabilities, { relations: true, getRelationNodes: true }, `${phase}: negotiated relation capabilities`)
  assert.deepEqual(summary.trace, restored ? RESTORED_TRACE : phase === 'removed' ? REMOVED_TRACE : INITIAL_TRACE,
    `${phase}: exact saved lifecycle/relation trace`)
  assert.equal(summary.showChild, present, `${phase}: actual Page.setData controls wx:if`)
  assert.equal(summary.childPresent, present, `${phase}: selection reflects mounted component`)
  assert.equal(summary.parentSurvives, true, `${phase}: held parent remains the actual selected instance`)
  assert.equal(summary.childIsInitial, phase === 'initial' || mutated, `${phase}: restored child must have a new identity`)
  assert.deepEqual(summary.parentNodes, present ? ['child'] : [], `${phase}: parent relationship table`)
  assert.deepEqual(summary.childNodes, present ? ['parent'] : [], `${phase}: child relationship table`)
  assert.equal(summary.parentRelationUsesLiveChild, present, `${phase}: parent relationship returns the actual selected child`)
  assert.equal(summary.childRelationUsesLiveParent, present, `${phase}: child relationship returns the actual selected parent`)
  assert.equal(summary.relationArrayIsFresh, true, `${phase}: callers get independent relationship arrays`)
  assert.equal(summary.relationArrayIsIsolated, true, `${phase}: mutating a returned array cannot change the graph`)
  assert.deepEqual(summary.heldChildRelations, phase === 'initial' || mutated ? ['parent'] : [], `${phase}: held disposed child has no stale relationships`)
  assert.equal(summary.childCount, present ? Number(mutated) : null, `${phase}: actual component data`)
  assert.equal(summary.childColor, present ? mutated ? '#1976d2' : '#e53935' : null, `${phase}: actual component color`)
  assert.equal(summary.heldChildCount, phase === 'initial' ? 0 : 1, `${phase}: held original instance retains its own data`)
  assert.equal(summary.childGenerations, restored ? 2 : 1, `${phase}: exactly the expected component instances were created`)
  for (const key of ['initialChildTracked', 'currentChildTracked', 'restoredChildIsFresh']) {
    assert.equal(summary[key], true, `${phase}: ${key} must use strict live instance identity`)
  }
  const callbacks = [
    ['parent', 'linked', 0, 'child'], ['child', 'linked', 0, 'parent'],
    ...(phase === 'removed' || restored ? [['parent', 'unlinked', 0, 'child'], ['child', 'unlinked', 0, 'parent']] : []),
    ...(restored ? [['parent', 'linked', 1, 'child'], ['child', 'linked', 1, 'parent']] : []),
  ].map(([label, event, childGeneration, targetLabel]) => ({ label, event, childGeneration, targetLabel,
    sourceIsLiveReference: true, targetIsLiveReference: true }))
  assert.deepEqual(summary.callbacks, callbacks, `${phase}: callback arguments and receivers are the live component objects`)
  return summary
}

function inspectCall(trace, requestId, name) {
  const payload = matchedResponse(trace, requestId, 'module.call')
  assert.equal(payload.moduleId, 'module:pages/index/index.js', `${requestId}: real page module`)
  assert.equal(payload.export, name, `${requestId}: expected exported function`)
  assert.equal(payload.result?.length, 1, `${requestId}: one native return value`)
  return payload.result[0]
}

export function inspectTrace(trace, phase) {
  assert.ok(PHASES.includes(phase), 'recognized final phase')
  const records = trace.records ?? trace.events
  assert.ok(Array.isArray(records), 'actual native trace records')
  for (const record of records) for (const message of record.response?.messages ?? []) {
    assert.notEqual(message.op, 'error', `unexpected runtime error: ${JSON.stringify(message.payload)}`)
    assert.notEqual(message.payload?.ok, false, `unexpected failed request: ${JSON.stringify(message.payload)}`)
  }
  assert.deepEqual(records.slice(0, 4).map(record => record.request?.op),
    ['app.init', 'app.lifecycle', 'page.push', 'render.commit'], 'canonical startup executes app.init -> launch -> page.push -> render.commit')
  for (const record of records.slice(0, 4)) matchedResponse(trace, record.request.requestId, record.request.op)
  assert.equal(records[1].request.payload?.event, 'launch', 'canonical startup launches the App')
  assert.equal(records[2].request.payload?.path, 'pages/index/index', 'canonical startup pushes the actual fixture route')
  let previousIndex = records.findIndex(record => record.request?.requestId === 'inspect-initial')
  assert.ok(previousIndex > 3, 'initial observation follows canonical startup render')
  const observations = { initial: inspectSummary(inspectCall(trace, 'inspect-initial', 'inspect'), 'initial') }
  for (const current of PHASES.slice(1, PHASES.indexOf(phase) + 1)) {
    if (current === 'mutated') {
      assert.deepEqual(inspectCall(trace, 'bump-held-child', 'bumpHeldChild'), {
        count: 1, sameHeldReference: true, selectedSeesSameState: true,
      }, 'calling a method on a relationship node mutates the actual selected child before return')
    } else assert.equal(inspectCall(trace, `${current}-set-data`, current === 'removed' ? 'remove' : 'restore'), true,
      `${current}: real Page.setData executed`)
    matchedResponse(trace, `render-${current}`, 'render.commit')
    const render = records.find(record => record.request?.requestId === `render-${current}`).request
    assert.equal(render.payload?.templateId, 'template:pages/index/index.wxml', `${current}: actual fixture template`)
    assert.equal(Object.hasOwn(render.payload, 'data'), false, `${current}: render reads live state, not injected expectations`)
    const actionId = current === 'mutated' ? 'bump-held-child' : `${current}-set-data`
    const actionIndex = records.findIndex(record => record.request?.requestId === actionId)
    const renderIndex = records.findIndex(record => record.request?.requestId === `render-${current}`)
    const inspectIndex = records.findIndex(record => record.request?.requestId === `inspect-${current}`)
    assert.ok(previousIndex < actionIndex && actionIndex < renderIndex && renderIndex < inspectIndex,
      `${current}: prior observation -> mutation -> render reconciliation -> observation`)
    observations[current] = inspectSummary(inspectCall(trace, `inspect-${current}`, 'inspect'), current)
    previousIndex = inspectIndex
  }
  return observations
}

export function inspectSnapshot(snapshot, phase) {
  assert.ok(PHASES.includes(phase), 'recognized snapshot phase')
  assert.equal(snapshot.width, VIEWPORT.width, 'snapshot width')
  assert.equal(snapshot.height, VIEWPORT.height, 'snapshot height')
  assert.equal(snapshot.stride, VIEWPORT.width * 4, 'snapshot RGBA stride')
  assert.ok(['rgba8', 'rgba8-premultiplied'].includes(snapshot.format), 'actual RGBA8 pixel format')
  assert.ok(Array.isArray(snapshot.pixels), 'snapshot contains actual pixel bytes')
  assert.equal(snapshot.pixels.length, VIEWPORT.width * VIEWPORT.height * 4, 'complete snapshot bytes')
  for (const byte of snapshot.pixels) assert.ok(Number.isInteger(byte) && byte >= 0 && byte <= 255, 'valid RGBA byte')
  const fill = phase === 'removed' ? [255, 255, 255, 255] : phase === 'mutated' ? [25, 118, 210, 255] : [229, 57, 53, 255]
  const samples = []
  for (const [x, y, expected] of [[28, 36, fill], [84, 36, fill], [28, 76, fill], [56, 56, fill],
    [2, 2, [255, 255, 255, 255]], [92, 36, [255, 255, 255, 255]], [28, 84, [255, 255, 255, 255]]]) {
    const rgba = snapshot.pixels.slice(y * snapshot.stride + x * 4, y * snapshot.stride + x * 4 + 4)
    assert.deepEqual(rgba, expected, `${phase}: actual component RGBA at (${x},${y})`)
    samples.push({ x, y, rgba })
  }
  return { width: snapshot.width, height: snapshot.height, stride: snapshot.stride, format: snapshot.format,
    pixelBytes: snapshot.pixels.length, pixelSha256: sha256(Buffer.from(snapshot.pixels)), samples }
}

function parseArguments(argv) {
  const options = { out: resolve(ROOT, 'artifacts/component-relations.json'), timeoutMs: 120_000 }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (name === '--') continue
    if (name === '--help' || name === '-h') return { help: true }
    if (!['--simulator-bin', '--out', '--timeout'].includes(name)) throw new Error(`Unknown option: ${name}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    if (name === '--simulator-bin') options.simulatorBin = resolve(value)
    if (name === '--out') options.out = resolve(value)
    if (name === '--timeout') options.timeoutMs = Number(value)
  }
  if (!options.simulatorBin) throw new Error('--simulator-bin is required; this smoke never starts Cargo')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout must be >= 1000 milliseconds')
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write('Usage: node scripts/component-relations-smoke.mjs --simulator-bin <path> [--out <json>] [--timeout <ms>]\n')
    return
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-relations-'))
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: options.timeoutMs })
  const { command } = runner
  const report = { schemaVersion: 1, scope: 'component-relations', status: 'failed', generatedAt: new Date().toISOString(),
    fixture: { path: relative(ROOT, FIXTURE), kind: 'hand-authored-native-weapp' }, engines: [], comparison: { status: 'not-run' }, cleanup: {},
    phaseExecution: 'Each phase is a fresh CLI session executing all preceding mutations and render commits in order; no state is shared between CLI processes.',
    savedOracle: { source: 'vendor/weapp-vite/e2e/utils/componentInstanceApiContract.ts',
      scope: 'INITIAL/REMOVED/RESTORED ancestor/descendant lifecycle trace through a projected slot and native wrapper; no fresh DevTools run.' },
    evidenceBoundary: 'Auxiliary real portable pack/native QuickJS/V8 relations and RGBA evidence. Raw fixture compiler identity is unknown; fixture source and bytes are recorded separately, not weapp-vite compilation evidence. Live identity/array isolation/pixels are local conformance contracts. No new DevTools, browser, GPU, device, seven-host or performance pass.' }
  try {
    report.sourceCommit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.workingTreeDirty = Boolean((await command('git', ['status', '--short'])).stdout.trim())
    report.fixture.sha256 = await sourceHashes(FIXTURE)
    report.simulator = { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
    const pack = resolve(temporary, 'pack')
    const packed = await command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', FIXTURE, '--out', pack, '--compiler-commit', 'unknown'])
    const bytes = await readFile(resolve(pack, 'manifest.json'))
    const manifest = JSON.parse(bytes)
    assert.equal(manifest.compiler.commit, 'unknown', 'hand-authored fixture must not claim an ambient compiler commit')
    for (const capability of ['Component.relations', 'Component.getRelationNodes']) {
      assert.equal(manifest.capabilities[capability], 'partial', 'packer declares the implemented relationship subset')
    }
    const blobs = {}
    for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
      const blob = await readFile(resolve(pack, 'blobs/sha256', name))
      assert.equal(sha256(blob), name, 'actual content-addressed blob bytes match the filename')
      blobs[`sha256:${name}`] = [...blob]
    }
    report.pack = { manifestSha256: sha256(bytes), integrityRoot: manifest.integrity.root,
      compilerCommit: 'unknown', rawFixtureNotCompilerOutput: true, command: packed.command }
    for (const engine of ['quickjs', 'v8']) {
      const entry = { engine, status: 'failed', phases: [] }
      report.engines.push(entry)
      for (const phase of PHASES) {
        const observation = { phase, status: 'failed' }
        entry.phases.push(observation)
        try {
          const script = [call('inspect-initial', 'inspect')]
          for (const current of PHASES.slice(1, PHASES.indexOf(phase) + 1)) {
            script.push(current === 'mutated' ? call('bump-held-child', 'bumpHeldChild')
              : call(`${current}-set-data`, current === 'removed' ? 'remove' : 'restore'))
            script.push(request(`render-${current}`, 'render.commit', { templateId: 'template:pages/index/index.wxml',
              blobs, styleIds: manifest.styles.map(style => style.id), viewport: VIEWPORT }))
            script.push(call(`inspect-${current}`, 'inspect'))
          }
          const prefix = resolve(temporary, `${engine}-${phase}`)
          await writeFile(`${prefix}.jsonl`, script.map(message => JSON.stringify(message)).join('\n') + '\n')
          const executed = await command(options.simulatorBin, ['run', '--pack', pack, '--engine', engine, '--viewport', '200x160',
            '--script', `${prefix}.jsonl`, '--trace', `${prefix}.trace.json`, '--snapshot', `${prefix}.snapshot.json`, '--report', `${prefix}.report.json`])
          observation.process = Object.fromEntries(Object.entries(executed).filter(([key]) => key !== 'stdout'))
          const simulator = JSON.parse(await readFile(`${prefix}.report.json`, 'utf8'))
          const traceBytes = await readFile(`${prefix}.trace.json`)
          const trace = JSON.parse(traceBytes)
          const snapshot = JSON.parse(await readFile(`${prefix}.snapshot.json`, 'utf8'))
          observation.simulator = simulator
          observation.trace = trace
          observation.traceSha256 = sha256(traceBytes)
          assert.equal(simulator.status, 'passed', 'canonical startup and script passed')
          assert.equal(simulator.engine, engine, 'actual requested engine without fallback')
          assert.equal(simulator.route, 'pages/index/index', 'actual fixture route')
          assert.equal(simulator.lifecycleState, 'Active', 'real App/Page startup')
          observation.observations = inspectTrace(trace, phase)
          observation.snapshot = inspectSnapshot(snapshot, phase)
          observation.status = 'passed'
        } catch (error) {
          observation.error = error.stack ?? String(error)
          if (error.result) observation.process = error.result
          if (runner.interrupted) throw error
        }
      }
      if (entry.phases.every(phase => phase.status === 'passed')) entry.status = 'passed'
    }
    if (report.engines.every(entry => entry.status === 'passed')) {
      const projected = report.engines.map(entry => entry.phases.map(phase => ({ phase: phase.phase,
        observations: phase.observations, snapshot: phase.snapshot })))
      assert.deepEqual(projected[0], projected[1], 'actual QuickJS/V8 lifecycle, live references, data and RGBA agree')
      report.comparison = { status: 'passed' }
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
    if (runner.interrupted) { report.interrupted = runner.interrupted; report.status = 'failed' }
    report.finishedAt = new Date().toISOString()
    try {
      await mkdir(dirname(options.out), { recursive: true })
      await writeFile(options.out, JSON.stringify(report, null, 2) + '\n')
    } finally { runner.dispose() }
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out,
    engines: report.engines.map(({ engine, status }) => ({ engine, status })), cleanup: report.cleanup }) + '\n')
  if (runner.interrupted) process.exitCode = runner.interrupted === 'SIGINT' ? 130 : 143
  else if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
