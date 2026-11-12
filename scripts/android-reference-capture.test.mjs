import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { captureAndroidReference } from './android-reference-capture.mjs'

// In-memory unit rasters only; these are never saved as runtime or oracle evidence.
function chunk(name, bytes) {
  const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12)
  result.writeUInt32BE(bytes.length); type.copy(result, 4); bytes.copy(result, 8)
  let crc = 0xffffffff
  for (const byte of Buffer.concat([type, bytes])) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

function fixture({ shift = 0, width = 120 } = {}) {
  const height = 200, rows = Buffer.alloc((width * 4 + 1) * height)
  const pageColor = [243, 244, 246, 255], cardColor = [255, 255, 255, 255], panelColor = [237, 246, 240, 255]
  const node = (id, bounds, color, children = []) => ({ id, bounds, opacity: 1,
    background: { red: color[0], green: color[1], blue: color[2], alpha: color[3] }, children })
  const panel = node('panel', { x: 20, y: 100, width: 60, height: 30 }, panelColor); panel.classes = ['component-panel']
  const card = node('card', { x: 10, y: 10, width: 80, height: 140 }, cardColor, [panel]); card.classes = ['card']
  const root = node('page', { x: 0, y: 0, width: 100, height: 180 }, pageColor, [card]); root.tag = 'page'
  function paint(value) {
    const { bounds, background } = value
    for (let y = Math.max(0, bounds.y + 10 + shift); y < Math.min(height, bounds.y + 10 + shift + bounds.height); y += 1) {
      for (let x = bounds.x + 10; x < bounds.x + 10 + bounds.width; x += 1) {
        rows.set([background.red, background.green, background.blue, background.alpha], y * (width * 4 + 1) + 1 + x * 4)
      }
    }
    value.children.forEach(paint)
  }
  paint(root)
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
  const sample = { width: 100, height: 180, contextId: '0xffff123456789abc', surfaceId: '0xffff123456789abd',
    framebuffer: 0, viewport: [0, 0, 100, 180], scissor: [0, 0, 100, 180] }
  const drawableObservation = { schemaVersion: 2, targetEpoch: 1, acceptedWidth: 100, acceptedHeight: 180,
    surfaceRecreationAttempted: false, surfaceRecreated: false, frameId: 3, status: 'passed',
    beforeTransition: structuredClone(sample), beforeDraw: structuredClone(sample), afterDraw: structuredClone(sample), afterSwap: structuredClone(sample) }
  const receipt = { schemaVersion: 1, status: 'ready', foreground: true, sessionId: 'capture-unit', revision: 2,
    page: { route: 'pages/home/index' }, frame: { frame_id: 3, viewport: { x: 0, y: 0, width: 100, height: 180 }, root },
    surface: { width: 100, height: 180, screenX: 10, screenY: 10, backend: 'skia-gpu-gles',
      presentationSequence: 3, presentedFrameId: 3, drawableObservation },
    windowObservation: { displayWidth: 120, displayHeight: 200, surfaceWidth: 100, surfaceHeight: 180, surfaceOrigin: { x: 10, y: 10 } } }
  return { png, receipt }
}

function harness(input = fixture()) {
  let time = 0
  const saved = [], operations = []
  return { saved, operations, input,
    options: { label: 'unit', timeoutMs: 3, pollMs: 1, now: () => time,
      assertLive: async () => { operations.push('assertLive') },
      read: async () => { operations.push('read'); return input.receipt },
      capture: async () => { operations.push('capture'); return input.png },
      save: async entry => { operations.push('save'); saved.push(entry) },
      wait: async milliseconds => { operations.push('wait'); time += milliseconds },
    } }
}

test('stable v2 frame capture saves complete evidence before returning the same successful attempt', async () => {
  const run = harness(), result = await captureAndroidReference(run.options)
  assert.deepEqual(run.operations, ['assertLive', 'read', 'capture', 'assertLive', 'read', 'save'])
  assert.equal(run.saved.length, 1); assert.equal(result, run.saved[0]); assert.equal(result.status, 'passed')
  assert.equal(result.inspection.status, 'passed'); assert.equal(result.inspection.officialVisualStatus, 'unknown')
  assert.deepEqual(result.before, result.after); assert.deepEqual(result.png, run.input.png)
  assert.notEqual(result.png, run.input.png); assert.notEqual(result.before, run.input.receipt)
  assert.equal(result.error, null); assert.equal(result.attempt, 1)
})

test('only beforeTransition may describe the previous drawable extent and target', async () => {
  const run = harness(), drawable = run.input.receipt.surface.drawableObservation
  drawable.surfaceRecreationAttempted = true; drawable.surfaceRecreated = true; drawable.targetEpoch = 2
  Object.assign(drawable.beforeTransition, { width: 180, height: 300, surfaceId: '0xffff123456789000', viewport: [0, 0, 180, 300] })
  assert.equal((await captureAndroidReference(run.options)).status, 'passed')
})

test('stale drawable samples, protocol, identities and viewport never earn a successful capture', async () => {
  for (const change of [
    d => { d.schemaVersion = 1 }, d => { d.status = 'failed' }, d => { d.frameId += 1 },
    d => { d.acceptedWidth += 1 }, d => { d.beforeDraw.height += 740 },
    d => { d.afterDraw.height += 1 }, d => { d.afterSwap.width += 1 },
    d => { d.afterDraw.viewport[3] += 1 }, d => { d.afterSwap.surfaceId += 1 },
    d => { d.beforeDraw.contextId += 1 }, d => { delete d.beforeTransition },
    d => { d.beforeDraw.contextId = 99101 }, d => { d.afterSwap.surfaceId = '0x00000000' },
    d => { d.beforeDraw.contextId = 'ffff123456789abc' },
    d => { for (const key of ['beforeDraw', 'afterDraw', 'afterSwap']) d[key].framebuffer = 7 },
    d => { d.surfaceRecreated = true },
  ]) {
    const run = harness(); change(run.input.receipt.surface.drawableObservation)
    await assert.rejects(captureAndroidReference({ ...run.options, timeoutMs: 1 }), error => {
      assert.equal(error.code, 'ERR_REFERENCE_CAPTURE'); assert.equal(error.attempts, 1)
      assert.equal(error.lastAttempt.error.code, 'ERR_REFERENCE_CAPTURE_DRAWABLE'); return true
    })
    assert.equal(run.saved.length, 1)
    assert.ok(run.saved.every(entry => entry.status === 'failed' && entry.png && entry.before && entry.after && entry.inspection === null))
  }
})

test('frame change around OS capture is retained and the next stable frame can succeed', async () => {
  const run = harness(), originalRead = run.options.read
  let reads = 0
  run.options.read = async () => {
    const receipt = structuredClone(await originalRead())
    if (++reads > 1) {
      receipt.frame.frame_id = 4; receipt.surface.presentedFrameId = 4
      receipt.surface.presentationSequence = 4; receipt.surface.drawableObservation.frameId = 4
    }
    return receipt
  }
  const result = await captureAndroidReference(run.options)
  assert.deepEqual(run.saved.map(entry => entry.status), ['failed', 'passed'])
  assert.equal(run.saved[0].error.code, 'ERR_REFERENCE_CAPTURE_UNSTABLE')
  assert.equal(run.saved[0].before.frame.frame_id, 3); assert.equal(run.saved[0].after.frame.frame_id, 4)
  assert.equal(result.inspection.frameId, 4)
  assert.deepEqual(run.operations.slice(0, 7), ['assertLive', 'read', 'capture', 'assertLive', 'read', 'save', 'wait'])
})

test('session, revision, presentation, Surface and frame tree changes around capture all retry', async () => {
  for (const change of [r => { r.sessionId = 'changed' }, r => { r.revision += 1 },
    r => { r.surface.presentationSequence += 1 }, r => { r.surface.screenY += 1 },
    r => { r.windowObservation.displayHeight += 1 }, r => { r.frame.root.bounds.x += 1 }]) {
    const run = harness(), originalRead = run.options.read
    let count = 0
    run.options.read = async () => { const r = structuredClone(await originalRead()); if (++count === 2) change(r); return r }
    const result = await captureAndroidReference(run.options)
    assert.equal(result.attempt, 2); assert.equal(run.saved[0].error.code, 'ERR_REFERENCE_CAPTURE_UNSTABLE')
  }
})

test('PNG geometry failures preserve unchanged bytes and recover through a bounded retry', async () => {
  const run = harness(), wrong = fixture({ width: 122 }).png
  let captures = 0
  run.options.capture = async () => ++captures === 1 ? wrong : run.input.png
  const result = await captureAndroidReference(run.options)
  assert.equal(result.attempt, 2); assert.deepEqual(run.saved[0].png, wrong)
  assert.equal(run.saved[0].error.code, 'ERR_REFERENCE_VISUAL_INPUT')
  assert.ok(run.saved[0].before && run.saved[0].after)
})

test('persistent visual failure retains every attempt and fails at the deadline', async () => {
  const run = harness(fixture({ shift: 6 }))
  await assert.rejects(captureAndroidReference(run.options), error => {
    assert.equal(error.code, 'ERR_REFERENCE_CAPTURE'); assert.equal(error.attempts, 3)
    assert.equal(error.lastAttempt, run.saved.at(-1)); return true
  })
  assert.equal(run.saved.length, 3)
  assert.ok(run.saved.every(entry => entry.inspection.status === 'failed' && entry.error.code === 'ERR_REFERENCE_CAPTURE_VISUAL'))
  assert.deepEqual(run.saved.map(entry => entry.attempt), [1, 2, 3])
  assert.equal(run.operations.filter(op => op === 'wait').length, 3)
})

test('foreign-session read and live ownership errors are saved then immediately propagated', async () => {
  for (const failingPhase of ['read', 'assertLive']) {
    const run = harness(), error = Object.assign(new Error('foreign session'), { code: 'ERR_FOREIGN_SESSION' })
    run.options[failingPhase] = async () => { throw error }
    await assert.rejects(captureAndroidReference(run.options), actual => actual === error)
    assert.equal(run.saved.length, 1); assert.equal(run.saved[0].error.code, 'ERR_FOREIGN_SESSION')
    assert.equal(run.saved[0].status, 'failed'); assert.equal(run.saved[0].after, null)
    assert.ok(!run.operations.includes('wait'))
  }
})

test('capture I/O failure still reads the after boundary, saves it, and retries', async () => {
  const run = harness(); let captures = 0
  run.options.capture = async () => { if (++captures === 1) throw new Error('capture unavailable'); return run.input.png }
  assert.equal((await captureAndroidReference(run.options)).attempt, 2)
  assert.ok(run.saved[0].before && run.saved[0].after); assert.equal(run.saved[0].png, null)
  assert.equal(run.saved[0].error.message, 'capture unavailable')
})

test('ownership loss after the screenshot preserves the acquired boundary and PNG before failing', async () => {
  for (const failingPhase of ['read', 'assertLive']) {
    const run = harness(), original = run.options[failingPhase]
    const error = Object.assign(new Error('session ownership changed after capture'), { code: 'ERR_FOREIGN_SESSION' })
    let calls = 0
    run.options[failingPhase] = async () => { if (++calls === 2) throw error; return original() }
    await assert.rejects(captureAndroidReference(run.options), actual => actual === error)
    assert.equal(run.saved.length, 1); assert.ok(run.saved[0].before && run.saved[0].png)
    assert.equal(run.saved[0].after, null); assert.equal(run.saved[0].error.code, 'ERR_FOREIGN_SESSION')
    assert.ok(!run.operations.includes('wait'))
  }
})

test('failed evidence persistence is terminal and cannot be hidden by a retry', async () => {
  for (const input of [fixture(), fixture({ shift: 6 })]) {
    const run = harness(input), error = new Error('evidence storage unavailable')
    run.options.save = async entry => { run.saved.push(entry); throw error }
    await assert.rejects(captureAndroidReference(run.options), actual => actual === error)
    assert.equal(run.saved.length, 1); assert.ok(!run.operations.includes('wait'))
  }
})

test('attempt cap also terminates if an injected retry clock stops advancing', async () => {
  const run = harness(fixture({ shift: 6 }))
  await assert.rejects(captureAndroidReference({ ...run.options, now: () => 0 }), error => error.attempts === 4)
  assert.equal(run.saved.length, 4)
})

test('invalid capture options fail before reading or capturing', async () => {
  for (const extra of [{ timeoutMs: 5001 }, { pollMs: 0 }, { label: '' }, { now: () => NaN }]) {
    const run = harness()
    await assert.rejects(captureAndroidReference({ ...run.options, ...extra }), error => error.code === 'ERR_REFERENCE_CAPTURE_INPUT')
    assert.equal(run.saved.length, 0); assert.equal(run.operations.length, 0)
  }
})
