#!/usr/bin/env node
/** Replay accepted native-engine frames with pinned, real CanvasKit CPU APIs.
 * This command does not initialize a browser, WebGL or a container Web host.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CanvasKitFramePresenter } from '../examples/hosts/web-wasm/canvaskit-presenter.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CANVASKIT_HASHES = Object.freeze({
  'bin/full/canvaskit.js': '894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5',
  'bin/full/canvaskit.wasm': 'aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959',
})
const ENGINES = Object.freeze(['quickjs', 'v8'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const descriptor = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })
/** Factory for one fixed, square, fontless runtime conformance corpus.
 * Case lists and dimensions are explicit, never inferred from the exports. */
export function createSquareFrameReplay({ caseNames, size, sourceFile, sampleTolerance = 1 }) {
  assert.ok(Array.isArray(caseNames) && caseNames.length > 0)
  assert.ok(caseNames.every(name => typeof name === 'string' && /^[a-z0-9-]+$/.test(name)))
  assert.equal(new Set(caseNames).size, caseNames.length)
  assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 4096)
  assert.ok(Number.isInteger(sampleTolerance) && sampleTolerance >= 0 && sampleTolerance <= 1)
  const CASES = Object.freeze([...caseNames].sort()), SIZE = size
  const SOURCE_FILES = ['scripts/runtime-frame-replay.mjs', sourceFile,
    'examples/hosts/web-wasm/canvaskit-presenter.mjs', 'examples/hosts/web-wasm/text-flow-plan.mjs']
const expectedNames = () => ENGINES.flatMap(engine => CASES.map(name => `${engine}-${name}.json`)).sort()

async function fileBytes(path) {
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), `expected a regular, non-symlink file: ${path}`)
  return readFile(path)
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async path => [path, sha256(await fileBytes(resolve(ROOT, path)))])))
}

async function exportHashes(directory) {
  const expected = expectedNames()
  const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
  assert.deepEqual(names, expected, 'the complete fixed case × two-engine JSON export matrix is required')
  const files = expected.flatMap(name => [name, name.replace(/\.json$/, '.runtime.rgba'), name.replace(/\.json$/, '.software.rgba')]).sort()
  const result = {}
  for (const name of files) {
    const bytes = await fileBytes(resolve(directory, name))
    result[name] = { bytes: bytes.length, sha256: sha256(bytes) }
  }
  return result
}

function assertRect(rect, label) {
  assert.ok(rect && typeof rect === 'object' && !Array.isArray(rect), label)
  for (const name of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(rect[name]), `${label}.${name}`)
  assert.ok(rect.width >= 0 && rect.height >= 0, `${label}: negative size`)
}

// The GPU presenter's validate/create APIs intentionally require a live WebGL
// context. This fontless CPU harness calls only its public drawing methods on
// genuine CanvasKit surfaces; it never fabricates a GL context or GPU receipt.
function preflightFrame(frame) {
  assert.ok(frame && typeof frame === 'object')
  assert.ok(Number.isSafeInteger(frame.frame_id) && frame.frame_id >= 0)
  assertRect(frame.viewport, 'viewport')
  assert.deepEqual(frame.viewport, { x: 0, y: 0, width: SIZE, height: SIZE }, 'the runtime fixture has one fixed viewport')
  assert.deepEqual(frame.images ?? {}, {}, 'this fontless corpus has no image resources')
  const stats = { nodes: 0, textNodes: 0, glyphs: 0, drawCommands: 0,
    opacityGroups: 0, maxOpacityDepth: 0, opacityBackingBytes: 0 }
  const visit = (node, depth, opacityDepth, active) => {
    assert.ok(node && typeof node === 'object' && !Array.isArray(node))
    assert.equal(typeof node.id, 'string')
    assert.ok(++stats.nodes <= 100000 && depth <= 256, 'node/depth bound')
    assertRect(node.bounds, node.id)
    assert.ok(Number.isFinite(node.opacity) && node.opacity >= 0 && node.opacity <= 1, `${node.id}: resolved opacity`)
    assert.ok(Array.isArray(node.children), `${node.id}: children`)
    assert.ok(node.image == null, `${node.id}: image rendering is outside this corpus`)
    if (node.text != null) {
      assert.equal(typeof node.text, 'string')
      assert.equal(node.text.trim(), '', `${node.id}: text requires a separately bound font; no font is downloaded`)
      assert.ok(node.text_layout && Array.isArray(node.text_layout.glyphs) && node.text_layout.glyphs.length === 0,
        `${node.id}: whitespace must already have an accepted empty-glyph text plan`)
    }
    active = active && node.style?.display !== 'none' && node.opacity > 0
    if (active && node.opacity < 1) {
      opacityDepth++
      stats.opacityGroups++
      stats.maxOpacityDepth = Math.max(stats.maxOpacityDepth, opacityDepth)
      stats.opacityBackingBytes = Math.max(stats.opacityBackingBytes, SIZE * SIZE * 4 * opacityDepth)
      assert.ok(opacityDepth <= 32 && stats.opacityBackingBytes <= 64 * 1024 * 1024, 'opacity layer budget')
    }
    for (const child of node.children) visit(child, depth + 1, opacityDepth, active)
  }
  visit(frame.root, 0, 0, true)
  // Use the consumer's exact pure path/context preflight. It creates no GL
  // context, CanvasKit resource or fake GPU receipt and runs before drawing.
  stats.paintOrder = CanvasKitFramePresenter.prototype.preflightPaintPlan(frame)
  return stats
}

function comparePixels(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: RGBA length`)
  let maximumRgbError = 0, maximumAlphaError = 0, differingChannels = 0
  for (let index = 0; index < actual.length; index++) {
    const error = Math.abs(actual[index] - expected[index]), alpha = index % 4 === 3
    if (error) differingChannels++
    if (alpha) maximumAlphaError = Math.max(maximumAlphaError, error)
    else maximumRgbError = Math.max(maximumRgbError, error)
    assert.ok(error <= (alpha ? 0 : sampleTolerance), `${label}: (${Math.floor(index / 4) % SIZE},${Math.floor(index / (SIZE * 4))}) channel ${index % 4}: ${actual[index]} != ${expected[index]}`)
  }
  return { channels: actual.length, maximumRgbError, maximumAlphaError, differingChannels,
    rgbTolerance: sampleTolerance, alphaTolerance: 0 }
}

function compareSamples(pixels, samples, label) {
  assert.ok(Array.isArray(samples) && samples.length > 0, `${label}: fixed pixel samples required`)
  return samples.map(sample => {
    assert.ok(Number.isInteger(sample.x) && sample.x >= 0 && sample.x < SIZE)
    assert.ok(Number.isInteger(sample.y) && sample.y >= 0 && sample.y < SIZE)
    assert.equal(typeof sample.target, 'string')
    assert.ok(Array.isArray(sample.rgba) && sample.rgba.length === 4
      && sample.rgba.every(channel => Number.isInteger(channel) && channel >= 0 && channel <= 255))
    const offset = (sample.y * SIZE + sample.x) * 4
    const rgba = [...pixels.subarray(offset, offset + 4)]
    for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(rgba[channel] - sample.rgba[channel]) <= (channel === 3 ? 0 : sampleTolerance),
      `${label}: fixed sample (${sample.x},${sample.y}) channel ${channel}`)
    return { x: sample.x, y: sample.y, target: sample.target, expectedRgba: sample.rgba, actualRgba: rgba }
  })
}

async function loadFixture(directory, name) {
  const jsonBytes = await fileBytes(resolve(directory, name)), value = JSON.parse(jsonBytes)
  assert.equal(value.schemaVersion, 1, name)
  assert.ok(ENGINES.includes(value.engine), name)
  assert.ok(CASES.includes(value.case), name)
  const stem = `${value.engine}-${value.case}`
  assert.equal(name, `${stem}.json`, 'filename and claimed engine/case must agree')
  assert.equal(value.officialDevtools, false)
  assert.equal(value.gpuAcceptance, false)
  assert.equal(value.sampleTolerance, sampleTolerance)
  const snapshot = value.snapshot
  assert.deepEqual([snapshot.width, snapshot.height, snapshot.stride, snapshot.format], [SIZE, SIZE, (SIZE * 4), 'rgba8-premultiplied'])
  assert.equal(snapshot.runtimeBackend, 'skia-raster', 'this run requires actual native Skia CPU reference bytes')
  assert.ok(sha(snapshot.runtimeSha256) && sha(snapshot.softwareSha256))
  const runtimeName = `${stem}.runtime.rgba`, softwareName = `${stem}.software.rgba`
  const runtime = await fileBytes(resolve(directory, runtimeName)), software = await fileBytes(resolve(directory, softwareName))
  for (const [label, bytes, expectedHash] of [
    ['runtime', runtime, snapshot.runtimeSha256], ['software', software, snapshot.softwareSha256],
  ]) {
    assert.equal(bytes.length, SIZE * SIZE * 4, `${name}: ${label} full RGBA length`)
    assert.equal(sha256(bytes), expectedHash, `${name}: ${label} SHA-256`)
    for (let index = 3; index < bytes.length; index += 4) assert.equal(bytes[index], 255, `${name}: fixture background is opaque`)
    compareSamples(bytes, value.samples, `${name}: ${label}`)
  }
  const stats = preflightFrame(value.frame)
  const referenceComparison = comparePixels(runtime, software, `${stem}: native vs software`)
  return { stem, value, runtime, software, stats, referenceComparison,
    input: descriptor(name, jsonBytes), runtimeInput: descriptor(runtimeName, runtime), softwareInput: descriptor(softwareName, software) }
}

return async function runFrameReplay(options) {
  const frames = resolve(options.frames), canvaskitDir = resolve(options.canvaskitDir), out = resolve(options.out)
  await mkdir(out, { recursive: false }) // Never overwrite an earlier successful or failed attempt.
  const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
    backend: 'canvaskit-cpu-frame-replay', canvasKitVersion: '0.42.0',
    expectedEngines: [...ENGINES], expectedCases: [...CASES], expectedFixtureCount: CASES.length * ENGINES.length,
    framesDirectory: frames, outputDirectory: out, fixtures: [], dualEngine: [], artifacts: [],
    sourceBefore: {}, sourceAfter: {}, exportsBefore: {}, exportsAfter: {},
    claims: { webHost: false, webgl: false, gpu: false, officialDevtools: false, physicalDevices: false, performanceAcceptance: false },
    scope: 'Real CanvasKit 0.42.0 software CPU drawing of complete RenderFrames accepted by native QuickJS/V8 sessions; complete premultiplied RGBA comparisons with native Skia CPU and software reference bytes. This is not execution of the container Web host or WebGL/GPU acceptance.',
    inventoryScope: 'artifacts contains every output except this report.json, whose own hash is recorded by the caller',
    cleanup: { created: { fonts: 0, surfaces: 0, recorders: 0, pictures: 0, snapshots: 0 },
      released: { fonts: 0, surfaces: 0, recorders: 0, pictures: 0, snapshots: 0 }, failures: [] } }
  let CK, font, surface
  const failures = []
  const save = async (name, bytes) => {
    const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes)
    await writeFile(resolve(out, name), data, { flag: 'wx' })
    const entry = descriptor(name, data)
    report.artifacts.push(entry)
    return entry
  }
  const created = (kind, resource, local) => {
    assert.ok(resource, `CanvasKit ${kind} allocation failed`)
    report.cleanup.created[kind]++
    if (local) local.created[kind]++
    return resource
  }
  const release = (kind, resource, local) => {
    if (!resource) return
    try {
      resource.delete()
      report.cleanup.released[kind]++
      if (local) local.released[kind]++
    } catch (error) {
      const failure = { resource: kind, message: String(error) }
      report.cleanup.failures.push(failure)
      if (local) local.failures.push(failure)
    }
  }
  try {
    report.sourceBefore = await sourceHashes()
    report.exportsBefore = await exportHashes(frames)
    const packageBytes = await fileBytes(resolve(canvaskitDir, 'package.json'))
    assert.equal(JSON.parse(packageBytes).version, '0.42.0', 'CanvasKit package version is pinned')
    report.canvasKitInputs = { package: descriptor('package.json', packageBytes), files: [] }
    for (const [path, expected] of Object.entries(CANVASKIT_HASHES)) {
      const bytes = await fileBytes(resolve(canvaskitDir, path))
      assert.equal(sha256(bytes), expected, `pinned CanvasKit bytes: ${path}`)
      report.canvasKitInputs.files.push(descriptor(path, bytes))
    }
    report.canvasKitDirectory = canvaskitDir
    const fixtures = []
    for (const name of expectedNames()) fixtures.push(await loadFixture(frames, name))
    for (const name of CASES) {
      const quickjs = fixtures.find(fixture => fixture.value.engine === 'quickjs' && fixture.value.case === name)
      const v8 = fixtures.find(fixture => fixture.value.engine === 'v8' && fixture.value.case === name)
      assert.deepEqual(quickjs.value.frame, v8.value.frame, `${name}: complete accepted frames must agree between engines`)
      assert.deepEqual(quickjs.value.samples, v8.value.samples, `${name}: expected samples must agree`)
      assert.ok(quickjs.runtime.equals(v8.runtime), `${name}: native Skia CPU engine outputs differ`)
      assert.ok(quickjs.software.equals(v8.software), `${name}: software engine outputs differ`)
    }
    const init = createRequire(import.meta.url)(resolve(canvaskitDir, 'bin/full/canvaskit.js'))
    CK = await init({ locateFile: name => resolve(canvaskitDir, 'bin/full', name) })
    // No font file is required: all accepted text leaves have zero glyphs.
    // This is a real CanvasKit font object, not a metrics/drawing substitute.
    font = created('fonts', new CK.Font(null, 16))
    surface = created('surfaces', CK.MakeSurface(SIZE, SIZE))
    assert.equal(surface.reportBackendTypeIsGPU(), false, 'only a genuine CanvasKit CPU surface is accepted')
    const painter = Object.create(CanvasKitFramePresenter.prototype)
    Object.assign(painter, { CK, font, canvas: { width: SIZE, height: SIZE } })
    const replayPixels = new Map()
    for (const fixture of fixtures) {
      const { stem, value } = fixture
      const receipt = { schemaVersion: 1, status: 'running', backend: 'canvaskit-cpu-frame-replay',
        engine: value.engine, case: value.case, frameId: value.frame.frame_id,
        input: fixture.input, runtimeInput: fixture.runtimeInput, softwareInput: fixture.softwareInput,
        runtimeBackend: value.snapshot.runtimeBackend, viewport: value.frame.viewport,
        width: SIZE, height: SIZE, stride: (SIZE * 4), format: 'rgba8-premultiplied',
        surfaceIsGpuBefore: surface.reportBackendTypeIsGPU(), surfaceIsGpuAfter: null,
        claims: { webHost: false, webgl: false, gpu: false, officialDevtools: false, physicalDevices: false, performanceAcceptance: false },
        stats: { ...fixture.stats }, referenceComparison: fixture.referenceComparison,
        cleanup: { created: { recorders: 0, pictures: 0, snapshots: 0 },
          released: { recorders: 0, pictures: 0, snapshots: 0 }, failures: [] } }
      report.fixtures.push(receipt)
      let recorder, picture, image, replayError
      try {
        assert.equal(receipt.surfaceIsGpuBefore, false)
        recorder = created('recorders', new CK.PictureRecorder(), receipt.cleanup)
        const target = recorder.beginRecording([0, 0, SIZE, SIZE])
        assert.ok(target, `${stem}: recording canvas`)
        painter.drawFrame(target, value.frame, receipt.stats, new Map())
        picture = created('pictures', recorder.finishRecordingAsPicture(), receipt.cleanup)
        const canvas = surface.getCanvas()
        canvas.clear(CK.TRANSPARENT)
        canvas.drawPicture(picture)
        surface.flush()
        image = created('snapshots', surface.makeImageSnapshot(), receipt.cleanup)
        const rgba = image.readPixels(0, 0, { width: SIZE, height: SIZE, colorType: CK.ColorType.RGBA_8888,
          alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB })
        assert.ok(rgba && rgba.length === SIZE * SIZE * 4, `${stem}: full premultiplied RGBA readback`)
        const actual = Buffer.from(rgba)
        receipt.actualRgba = await save(`${stem}.rgba`, actual)
        const png = image.encodeToBytes()
        assert.ok(png && Buffer.from(png).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${stem}: PNG encoding`)
        receipt.actualPng = await save(`${stem}.png`, png)
        receipt.surfaceIsGpuAfter = surface.reportBackendTypeIsGPU()
        assert.equal(receipt.surfaceIsGpuAfter, false)
        receipt.runtimeComparison = comparePixels(actual, fixture.runtime, `${stem}: CanvasKit CPU vs native Skia CPU`)
        receipt.softwareComparison = comparePixels(actual, fixture.software, `${stem}: CanvasKit CPU vs software`)
        receipt.samples = compareSamples(actual, value.samples, `${stem}: CanvasKit CPU`)
        replayPixels.set(stem, actual)
        receipt.status = 'passed'
      } catch (error) {
        replayError = error
        receipt.status = 'failed'; receipt.error = error.stack || String(error)
      } finally {
        release('snapshots', image, receipt.cleanup)
        release('pictures', picture, receipt.cleanup)
        release('recorders', recorder, receipt.cleanup)
        if (receipt.cleanup.failures.length) receipt.status = 'failed'
        await save(`${stem}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n')
      }
      if (replayError) throw replayError
      assert.equal(receipt.status, 'passed', `${stem}: resource cleanup failed`)
    }
    for (const name of CASES) {
      const quickjs = replayPixels.get(`quickjs-${name}`), v8 = replayPixels.get(`v8-${name}`)
      assert.ok(quickjs && v8 && quickjs.equals(v8), `${name}: CanvasKit CPU engine replays must be byte-identical`)
      report.dualEngine.push({ case: name, acceptedFramesEqual: true, nativeRgbaEqual: true,
        softwareRgbaEqual: true, replayRgbaEqual: true, replaySha256: sha256(quickjs) })
    }
    assert.equal(report.fixtures.length, report.expectedFixtureCount)
    report.status = 'passed'
  } catch (error) {
    failures.push(error.stack || String(error)); report.status = 'failed'
  } finally {
    release('surfaces', surface)
    release('fonts', font)
    for (const [field, action] of [
      ['sourceAfter', sourceHashes], ['exportsAfter', () => exportHashes(frames)],
    ]) {
      try { report[field] = await action() }
      catch (error) { failures.push(error.stack || String(error)) }
    }
    try {
      assert.deepEqual(report.sourceAfter, report.sourceBefore, 'replay source files changed during execution')
      assert.deepEqual(report.exportsAfter, report.exportsBefore, 'runtime exports changed during execution')
      if (report.canvasKitInputs) {
        assert.deepEqual(descriptor('package.json', await fileBytes(resolve(canvaskitDir, 'package.json'))), report.canvasKitInputs.package)
        for (const input of report.canvasKitInputs.files) assert.deepEqual(descriptor(input.path, await fileBytes(resolve(canvaskitDir, input.path))), input)
      }
      assert.deepEqual(report.cleanup.released, report.cleanup.created, 'CanvasKit native resources remain live')
      assert.deepEqual(report.cleanup.failures, [], 'CanvasKit resource cleanup failed')
    } catch (error) { failures.push(error.stack || String(error)) }
    if (failures.length) { report.status = 'failed'; report.errors = failures }
    report.finishedAt = new Date().toISOString()
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  return report
}

}

export async function runFrameReplayCli(run, argv = process.argv.slice(2)) {
  const options = {}, names = new Map([['--frames', 'frames'], ['--canvaskit-dir', 'canvaskitDir'], ['--out', 'out']])
  for (let index = 0; index < argv.length; index++) {
    const name = names.get(argv[index]), value = argv[++index]
    assert.ok(name && value && !value.startsWith('--') && !options[name],
      'Expected --frames <runtime-export-directory> --canvaskit-dir <0.42.0-package-root> --out <new-output-directory>, each once')
    options[name] = resolve(value)
  }
  for (const name of names.values()) assert.ok(options[name], `missing ${name}`)
  const report = await run(options)
  process.stdout.write(JSON.stringify({ status: report.status, backend: report.backend,
    fixtures: report.fixtures.length, report: resolve(options.out, 'report.json'), errors: report.errors ?? [] }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}
