import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertNoRgbaTransport, assertRendererReceipt, parseOptions, presentationMatchesFrame, runCanvasKitDevSmoke } from './simulator-canvaskit-browser-smoke.mjs'

test('CanvasKit dev smoke requires explicit local assets and a new evidence output', () => {
  assert.throws(() => parseOptions([]), /renderer-assets/)
  assert.throws(() => parseOptions(['--renderer-assets', '/tmp/assets']), /out/)
  assert.throws(() => parseOptions(['--renderer-assets', '/tmp/assets', '--out', '/tmp/report', '--engine', 'fallback']), /quickjs or v8/)
  const options = parseOptions(['--binary', '/tmp/weapp-simulator', '--renderer-assets', '/tmp/assets', '--out', '/tmp/report', '--engine', 'v8'])
  assert.equal(options.binary, '/tmp/weapp-simulator')
  assert.equal(options.engine, 'v8')
})

const receipt = () => ({ backend: 'canvaskit-webgl2', context: { api: 'webgl2', surfaceIsGpu: true,
  physicalHardware: 'unknown', unmaskedRenderer: 'ANGLE SwiftShader' }, presentation: { gpuCompletion: 'not-waited' },
  runtimeBoundary: { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 }, cleanupErrors: [] })

test('CanvasKit receipt gate identifies software drivers without claiming physical GPU or synchronous completion', () => {
  assert.deepEqual(assertRendererReceipt(receipt()), { driver: 'ANGLE SwiftShader', softwareDriver: true, physicalHardware: 'unknown' })
  for (const mutate of [value => value.context.surfaceIsGpu = false,
    value => value.presentation.gpuCompletion = 'gl.finish',
    value => value.runtimeBoundary.softwareRgbaUploads = 1,
    value => value.runtimeBoundary.perNodeRuntimeCalls = 3,
    value => value.cleanupErrors.push('context leak')]) {
    const value = receipt(); mutate(value)
    assert.throws(() => assertRendererReceipt(value))
  }
})

test('CanvasKit transport gate rejects CPU page rasters and absent batch/ack traffic', () => {
  const requests = [{ path: '/api/render-frame' }, { path: '/api/render-presented' }]
  assertNoRgbaTransport(requests)
  for (const path of ['/api/frame', '/api/snapshot']) assert.throws(() => assertNoRgbaTransport([...requests, { path }]), /CPU page rasters/)
  assert.throws(() => assertNoRgbaTransport([{ path: '/api/render-frame' }]), /correlated/)
})

test('readback gate requires the exact server revision and transport frame after browser confirmation', () => {
  const current = { sessionId: 'session', configGeneration: 2, renderRevision: 5, sourceFrameId: 3, frameId: 8 }
  const observed = { ready: true, receipt: { ...current, frameId: 3 }, metrics: { ...current } }
  assert.equal(presentationMatchesFrame(observed, current), true)
  for (const field of ['sessionId', 'configGeneration', 'renderRevision', 'frameId']) {
    const stale = structuredClone(observed); stale.receipt[field] = field === 'sessionId' ? 'old' : 1
    assert.equal(presentationMatchesFrame(stale, current), false, field)
  }
  assert.equal(presentationMatchesFrame({ ...observed, metrics: { ...observed.metrics, frameId: 7 } }, current), false)
  assert.equal(presentationMatchesFrame({ ...observed, ready: false }, current), false)
  assert.equal(presentationMatchesFrame(undefined, current), false)
})

test('pre-aborted CanvasKit smoke retains failure evidence without launching a simulator or browser', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-remote-smoke-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const controller = new AbortController(); controller.abort(new Error('cancel test'))
  let starts = 0, launches = 0
  const report = await runCanvasKitDevSmoke({ out: join(directory, 'report'), engine: 'quickjs' }, {
    signal: controller.signal, startSimulator: () => { starts++; throw new Error('unexpected start') },
    chromium: { launch() { launches++; throw new Error('unexpected launch') } },
  })
  assert.equal(report.status, 'failed')
  assert.match(report.error.message, /cancel test/)
  assert.equal(starts, 0); assert.equal(launches, 0)
  assert.equal(JSON.parse(await readFile(join(directory, 'report/report.json'))).status, 'failed')
})
