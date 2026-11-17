#!/usr/bin/env node
/** Replay the fixed Rust paint_tests corpus with real CanvasKit CPU APIs.
 * No browser, GL context, container host or device is initialized here.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CanvasKitFramePresenter } from '../examples/hosts/web-wasm/canvaskit-presenter.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 96
const TEST_SOURCE = 'crates/container-render-skia/src/paint_tests.rs'
// Reviewed against each assert_scene/assert_frame call and its finite loops.
// Zero-export tests are explicit so source additions cannot silently disappear.
const EXPECTED_EXPORTS = Object.freeze({
  typed_static_blocks_ignore_z_while_legacy_roots_keep_their_local_contract: 2,
  an_identity_transform_paints_after_a_later_ordinary_block: 2,
  transform_and_opacity_do_not_make_static_block_z_index_applicable: 2,
  relative_auto_promotes_a_high_descendant_but_explicit_zero_traps_it: 2,
  transform_opacity_and_isolation_each_trap_descendants_inside_their_context: 4,
  negative_descendants_paint_after_context_background_but_before_noncontext_background: 3,
  negative_contexts_use_numeric_levels_then_document_order: 3,
  a_static_flex_items_explicit_zero_paints_above_an_auto_item_despite_order: 2,
  flex_auto_items_allow_descendant_interleaving_while_zero_items_are_atomic: 2,
  flex_order_breaks_equal_context_levels_but_never_overrides_z_index: 3,
  positioned_paint_phase_precedes_order_comparison_with_ordinary_flex_items: 6,
  fully_transparent_contexts_still_hit_descendants_with_real_event_ancestry: 1,
  opacity_is_applied_to_the_completed_group_once_including_promoted_children: 1,
  nested_opacity_contexts_apply_each_group_alpha_exactly_once: 1,
  promoted_descendants_keep_their_positioned_ancestors_overflow_clip: 1,
  absolute_descendants_bypass_intermediate_clips_but_keep_the_containing_blocks_clip: 1,
  promoted_descendants_keep_scroll_translation_and_clip_without_double_application: 2,
  viewport_fixed_escapes_clip_and_scroll_but_keeps_opacity_and_stacking_ancestry: 2,
  hidden_ancestors_do_not_publish_promoted_contexts_or_input_targets: 1,
  the_wire_keeps_auto_zero_and_isolation_distinct: 0,
  context_boundaries_preserve_plain_sibling_backgrounds_outside_the_overlap: 1,
  replaced_content_paints_and_hits_above_later_block_backgrounds_even_when_transparent: 4,
  overdeep_paint_trees_reject_serialization_and_leave_accepted_renderers_unchanged: 0,
  hidden_typed_root_exports_a_balanced_empty_context_and_no_hits: 1,
  an_absolute_child_skips_intermediate_scroll_even_without_its_own_flow_metadata: 2,
  legacy_roots_reject_new_stacking_metadata_without_replacing_accepted_state: 0,
  legacy_anonymous_text_does_not_retarget_over_hit_testable_siblings: 0,
  f32_opacity_half_steps_keep_the_same_quantized_group_alpha_across_the_wire: 2,
})
const INPUT_FILES = Object.freeze(['expectations.json', 'frame.json', 'metadata.json', 'native.rgba', 'software.rgba'])
const SOURCE_FILES = Object.freeze(['scripts/stacking-frame-replay.mjs', TEST_SOURCE,
  'scripts/runtime-frame-replay.mjs', 'examples/hosts/web-wasm/canvaskit-presenter.mjs',
  'examples/hosts/web-wasm/text-flow-plan.mjs'])
const CANVASKIT_HASHES = Object.freeze({
  'bin/full/canvaskit.js': '894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5',
  'bin/full/canvaskit.wasm': 'aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959',
})
const CLAIMS = Object.freeze({ webHost: false, webgl: false, gpu: false, officialDevtools: false,
  physicalDevices: false, performanceAcceptance: false, javascriptEngineExecution: false,
  canvasKitHitTesting: false, fullFrameIndependentPixelOracle: false })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const descriptor = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })
const errorText = error => error?.stack || String(error)
const zeroResources = () => ({ fonts: 0, surfaces: 0, recorders: 0, pictures: 0, snapshots: 0, images: 0 })
const sanitize = test => test.replace(/[^A-Za-z0-9_-]/g, '-')
const CASES = Object.freeze(Object.entries(EXPECTED_EXPORTS).flatMap(([test, count]) =>
  Array.from({ length: count }, (_, index) => ({ test: `paint_tests::${test}`, sequence: index + 1,
    directory: `${sanitize(`paint_tests::${test}`)}-${String(index + 1).padStart(3, '0')}` }))))

async function fileBytes(path) {
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), `regular non-symlink file required: ${path}`)
  return readFile(path)
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async path =>
    [path, descriptor(path, await fileBytes(resolve(ROOT, path)))])))
}

async function exportInventory(directory) {
  const inventory = { files: {}, issues: [] }
  try {
    const root = await lstat(directory)
    assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'regular export directory required')
    assert.deepEqual((await readdir(directory)).sort(), CASES.map(item => item.directory).sort(),
      'export directories must match the fixed test × sequence inventory exactly')
  } catch (error) { inventory.issues.push(errorText(error)) }
  for (const item of CASES) {
    const path = resolve(directory, item.directory)
    try {
      const info = await lstat(path)
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), `regular case directory required: ${path}`)
      assert.deepEqual((await readdir(path)).sort(), [...INPUT_FILES].sort(), `${item.directory}: exact input files`)
    } catch (error) { inventory.issues.push(errorText(error)) }
    for (const name of INPUT_FILES) {
      const relative = `${item.directory}/${name}`
      try { inventory.files[relative] = descriptor(relative, await fileBytes(resolve(path, name))) }
      catch (error) { inventory.issues.push(errorText(error)) }
    }
  }
  return inventory
}

async function verifySourceInventory() {
  const source = (await fileBytes(resolve(ROOT, TEST_SOURCE))).toString('utf8')
  const tests = [...source.matchAll(/#\[test\]\s*fn\s+([A-Za-z0-9_]+)\s*\(/g)].map(match => match[1]).sort()
  assert.deepEqual(tests, Object.keys(EXPECTED_EXPORTS).sort(),
    'review the static export counts whenever the Rust test inventory changes')
  assert.equal(Object.keys(EXPECTED_EXPORTS).length, 28, 'the reviewed corpus has 28 test functions')
  assert.equal(CASES.length, 51, 'the reviewed scene corpus has 51 exports')
}

function preflightFrame(frame) {
  assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame))
  assert.ok(Number.isSafeInteger(frame.frame_id) && frame.frame_id >= 0)
  assert.deepEqual(frame.viewport, { x: 0, y: 0, width: SIZE, height: SIZE })
  const resources = frame.images ?? {}
  assert.ok(resources && typeof resources === 'object' && !Array.isArray(resources))
  let imageBytes = 0
  assert.ok(Object.keys(resources).length <= 1024)
  for (const [id, image] of Object.entries(resources)) {
    assert.ok(/^[A-Za-z0-9._:/-]{1,256}$/.test(id))
    assert.ok(image && Number.isInteger(image.width) && image.width > 0 && image.width <= 8192
      && Number.isInteger(image.height) && image.height > 0 && image.height <= 8192)
    const bytes = image.width * image.height * 4
    assert.ok(bytes <= 64 * 1024 * 1024 && (imageBytes += bytes) <= 128 * 1024 * 1024)
    assert.ok(Array.isArray(image.pixels) && image.pixels.length === bytes)
    for (let index = 0; index < bytes; index++) assert.ok(Number.isInteger(image.pixels[index])
      && image.pixels[index] >= 0 && image.pixels[index] <= 255, `${id}: RGBA8 byte ${index}`)
  }
  const stats = { nodes: 0, textNodes: 0, glyphs: 0, drawCommands: 0, imageNodes: 0,
    imageResources: Object.keys(resources).length, imageBytes,
    opacityGroups: 0, maxOpacityDepth: 0, opacityBackingBytes: 0 }
  const visit = (node, depth, active, opacityDepth) => {
    assert.ok(node && typeof node === 'object' && !Array.isArray(node))
    assert.equal(typeof node.id, 'string')
    assert.ok(++stats.nodes <= 100000 && depth <= 256)
    assert.ok(node.bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(node.bounds[key])))
    assert.ok(node.bounds.width >= 0 && node.bounds.height >= 0)
    assert.ok(Number.isFinite(node.opacity) && node.opacity >= 0 && node.opacity <= 1)
    assert.ok(Array.isArray(node.children))
    // This corpus is deliberately fontless. Empty text is a replaced-content
    // phase case, never evidence of glyph/font parity.
    if (node.text != null) assert.equal(node.text, '', `${node.id}: only empty text belongs to this corpus`)
    if (node.image != null) {
      assert.ok(node.image && Object.hasOwn(resources, node.image.resource), `${node.id}: image reference`)
      assert.equal(node.image.mode, 'scaleToFill', 'this fixed corpus uses scaleToFill')
      stats.imageNodes++
    }
    active = active && node.style?.display !== 'none' && node.opacity > 0
    if (active && node.opacity < 1) {
      opacityDepth++; stats.opacityGroups++
      stats.maxOpacityDepth = Math.max(stats.maxOpacityDepth, opacityDepth)
      stats.opacityBackingBytes = Math.max(stats.opacityBackingBytes, SIZE * SIZE * 4 * opacityDepth)
      assert.ok(opacityDepth <= 32 && stats.opacityBackingBytes <= 64 * 1024 * 1024)
    }
    node.children.forEach(child => visit(child, depth + 1, active, opacityDepth))
  }
  visit(frame.root, 0, true, 0)
  // Pure consumer preflight before any CanvasKit resource creation. No GL
  // stand-in is assigned and neither validate() nor submit() is called.
  stats.paintOrder = CanvasKitFramePresenter.prototype.preflightPaintPlan(frame)
  stats.cssStackingOracle = stats.paintOrder.contract === 'committed-paint-plan-v1'
  return stats
}

function comparePixels(actual, expected, label) {
  assert.equal(actual.length, SIZE * SIZE * 4, `${label}: full RGBA length`)
  assert.equal(expected.length, actual.length, `${label}: reference RGBA length`)
  const first = actual.findIndex((value, index) => value !== expected[index])
  assert.equal(first, -1, first < 0 ? label : `${label}: pixel (${Math.floor(first / 4) % SIZE},${Math.floor(first / (SIZE * 4))}), channel ${first % 4}: ${actual[first]} != ${expected[first]}`)
  return { bytesCompared: actual.length, byteIdentical: true, rgbTolerance: 0, alphaTolerance: 0 }
}

function compareSamples(pixels, samples, label) {
  return samples.map(sample => {
    const offset = (sample.y * SIZE + sample.x) * 4
    const actualRgba = [...pixels.subarray(offset, offset + 4)]
    assert.deepEqual(actualRgba, sample.rgba, `${label}: independent pixel (${sample.x},${sample.y})`)
    return { x: sample.x, y: sample.y, expectedRgba: sample.rgba, actualRgba,
      expectedHitPath: sample.hitPath }
  })
}

async function loadFixture(directory, item, receipt) {
  const bytes = Object.fromEntries(await Promise.all(INPUT_FILES.map(async name =>
    [name, await fileBytes(resolve(directory, item.directory, name))])))
  receipt.inputs = INPUT_FILES.map(name => descriptor(`${item.directory}/${name}`, bytes[name]))
  const metadata = JSON.parse(bytes['metadata.json']), frame = JSON.parse(bytes['frame.json'])
  const expectations = JSON.parse(bytes['expectations.json'])
  receipt.metadata = metadata
  assert.equal(metadata.schemaVersion, 1)
  assert.equal(metadata.test, item.test)
  assert.equal(metadata.sequence, item.sequence)
  for (const [key, filename] of [['frame', 'frame.json'], ['expectations', 'expectations.json'],
    ['native', 'native.rgba'], ['software', 'software.rgba']]) {
    assert.equal(metadata[key]?.file, filename)
    assert.equal(metadata[key].sha256, sha256(bytes[filename]), `${item.directory}: ${filename} SHA-256`)
  }
  for (const key of ['native', 'software']) {
    assert.deepEqual([metadata[key].width, metadata[key].height, metadata[key].stride, metadata[key].format],
      [SIZE, SIZE, SIZE * 4, 'rgba8-premultiplied'])
  }
  assert.equal(metadata.native.backend, 'skia-raster', 'native Skia CPU is mandatory; fallback is not evidence')
  assert.equal(metadata.native.hasNativeSurface, true)
  assert.equal(metadata.native.hasGpuSurface, false)
  assert.equal(metadata.fullFrameNativeSoftwareComparisonEnabled, true)
  assert.equal(metadata.fullFrameBytesEqual, true)
  assert.equal(expectations.schemaVersion, 1)
  assert.equal(expectations.oracleScope, 'independently fixed sample colors and DOM hit paths')
  assert.equal(expectations.fullFrameIndependentPixelOracle, false)
  assert.ok(Array.isArray(expectations.samples) && expectations.samples.length > 0)
  const coordinates = new Set()
  for (const sample of expectations.samples) {
    assert.ok(Number.isInteger(sample.x) && sample.x >= 0 && sample.x < SIZE)
    assert.ok(Number.isInteger(sample.y) && sample.y >= 0 && sample.y < SIZE)
    assert.ok(!coordinates.has(`${sample.x},${sample.y}`), 'unique sample coordinates required')
    coordinates.add(`${sample.x},${sample.y}`)
    assert.ok(Array.isArray(sample.rgba) && sample.rgba.length === 4)
    for (let index = 0; index < 4; index++) assert.ok(Number.isInteger(sample.rgba[index])
      && sample.rgba[index] >= 0 && sample.rgba[index] <= 255)
    assert.ok(Array.isArray(sample.hitPath) && sample.hitPath.every(id => typeof id === 'string'))
  }
  assert.deepEqual(metadata.observedHitPaths, expectations.samples.map(sample =>
    ({ x: sample.x, y: sample.y, path: sample.hitPath })),
  'Rust hit observations must match the independent expected paths; CanvasKit does not recompute hits')
  receipt.rustHitObservationsVerified = metadata.observedHitPaths
  receipt.stats = preflightFrame(frame)
  receipt.referenceComparison = comparePixels(bytes['native.rgba'], bytes['software.rgba'],
    `${item.directory}: native Skia CPU vs software`)
  receipt.nativeSamples = compareSamples(bytes['native.rgba'], expectations.samples, `${item.directory}: native`)
  receipt.softwareSamples = compareSamples(bytes['software.rgba'], expectations.samples, `${item.directory}: software`)
  return { frame, samples: expectations.samples, native: bytes['native.rgba'], software: bytes['software.rgba'] }
}

export async function runStackingFrameReplay(options) {
  const frames = resolve(options.frames), canvaskitDir = resolve(options.canvaskitDir), out = resolve(options.out)
  await mkdir(out, { recursive: false })
  const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
    backend: 'canvaskit-cpu-stacking-frame-replay', canvasKitVersion: '0.42.0',
    framesDirectory: frames, outputDirectory: out, expectedExports: EXPECTED_EXPORTS,
    expectedTestCount: Object.keys(EXPECTED_EXPORTS).length, expectedFixtureCount: CASES.length,
    claims: CLAIMS, fixtures: [], artifacts: [], sourceBefore: {}, sourceAfter: {},
    exportsBefore: {}, exportsAfter: {},
    scope: 'Real CanvasKit CPU replay of Rust renderer scenes with complete byte-exact native Skia/software comparisons. Only fixed sample pixels and Rust-reported hit paths are independent expectations. Legacy recursive frames are explicitly outside the CSS stacking oracle. No AppService, host, browser, WebGL, GPU, DevTools, device or performance acceptance.',
    inventoryScope: 'artifacts includes every output except report.json; the caller may hash that report separately',
    cleanup: { scope: 'harness-owned returned resources; presenter owns its internal paints and paths',
      created: zeroResources(), released: zeroResources(), failures: [] } }
  const failures = []
  let CK, font, surface
  const save = async (name, bytes) => {
    const data = Buffer.from(bytes)
    await writeFile(resolve(out, name), data, { flag: 'wx' })
    const result = descriptor(name, data); report.artifacts.push(result)
    return result
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
      resource.delete(); report.cleanup.released[kind]++
      if (local) local.released[kind]++
    } catch (error) {
      const failure = { resource: kind, error: errorText(error) }
      report.cleanup.failures.push(failure)
      if (local) local.failures.push(failure)
    }
  }
  try {
    report.sourceBefore = await sourceHashes()
    report.exportsBefore = await exportInventory(frames)
    await verifySourceInventory()
    assert.deepEqual(report.exportsBefore.issues, [], 'complete fixed export inventory required')
    const packageBytes = await fileBytes(resolve(canvaskitDir, 'package.json'))
    report.canvasKitInputs = { package: descriptor('package.json', packageBytes), files: [] }
    assert.equal(JSON.parse(packageBytes).version, '0.42.0')
    for (const [name, expected] of Object.entries(CANVASKIT_HASHES)) {
      const bytes = await fileBytes(resolve(canvaskitDir, name))
      report.canvasKitInputs.files.push(descriptor(name, bytes))
      assert.equal(sha256(bytes), expected, `pinned CanvasKit bytes: ${name}`)
    }
    report.canvasKitDirectory = canvaskitDir
    // Verify every scene, metadata hash, independent sample and pure paint
    // plan before creating any CanvasKit resource.
    const fixtures = []
    for (const item of CASES) {
      const receipt = { schemaVersion: 1, status: 'running', test: item.test, sequence: item.sequence,
        directory: item.directory, backend: report.backend, claims: CLAIMS,
        cleanup: { created: zeroResources(), released: zeroResources(), failures: [] } }
      report.fixtures.push(receipt)
      try { fixtures.push({ item, receipt, value: await loadFixture(frames, item, receipt) }) }
      catch (error) { receipt.status = 'failed'; receipt.error = errorText(error); failures.push(receipt.error) }
    }
    assert.equal(failures.length, 0, 'every exported frame must pass input verification before CPU replay')
    const init = createRequire(import.meta.url)(resolve(canvaskitDir, 'bin/full/canvaskit.js'))
    CK = await init({ locateFile: name => resolve(canvaskitDir, 'bin/full', name) })
    font = created('fonts', new CK.Font(null, 16))
    surface = created('surfaces', CK.MakeSurface(SIZE, SIZE))
    assert.equal(surface.reportBackendTypeIsGPU(), false)
    const painter = Object.create(CanvasKitFramePresenter.prototype)
    Object.assign(painter, { CK, font, canvas: { width: SIZE, height: SIZE } })
    for (const { item, receipt, value } of fixtures) {
      let recorder, picture, snapshot, images = new Map()
      try {
        receipt.surfaceIsGpuBefore = surface.reportBackendTypeIsGPU()
        assert.equal(receipt.surfaceIsGpuBefore, false)
        const original = structuredClone(value.frame)
        images = painter.createImages(value.frame)
        for (const resource of images.values()) created('images', resource, receipt.cleanup)
        recorder = created('recorders', new CK.PictureRecorder(), receipt.cleanup)
        const target = recorder.beginRecording([0, 0, SIZE, SIZE])
        assert.ok(target)
        painter.drawFrame(target, value.frame, receipt.stats, images)
        picture = created('pictures', recorder.finishRecordingAsPicture(), receipt.cleanup)
        const canvas = surface.getCanvas()
        canvas.clear(CK.TRANSPARENT); canvas.drawPicture(picture); surface.flush()
        snapshot = created('snapshots', surface.makeImageSnapshot(), receipt.cleanup)
        const pixels = snapshot.readPixels(0, 0, { width: SIZE, height: SIZE,
          colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Premul, colorSpace: CK.ColorSpace.SRGB })
        assert.ok(pixels && pixels.length === SIZE * SIZE * 4)
        const actual = Buffer.from(pixels)
        receipt.actualRgba = await save(`${item.directory}.rgba`, actual)
        const png = snapshot.encodeToBytes()
        assert.ok(png && Buffer.from(png).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        receipt.actualPng = await save(`${item.directory}.png`, png)
        receipt.nativeComparison = comparePixels(actual, value.native, `${item.directory}: CanvasKit vs native Skia CPU`)
        receipt.softwareComparison = comparePixels(actual, value.software, `${item.directory}: CanvasKit vs software`)
        receipt.samples = compareSamples(actual, value.samples, `${item.directory}: CanvasKit CPU`)
        assert.deepEqual(value.frame, original, 'replay must not alter the accepted frame')
        receipt.frameUnchanged = true
        receipt.surfaceIsGpuAfter = surface.reportBackendTypeIsGPU()
        assert.equal(receipt.surfaceIsGpuAfter, false)
        receipt.status = 'passed'
      } catch (error) {
        receipt.status = 'failed'; receipt.error = errorText(error); failures.push(receipt.error)
      } finally {
        release('snapshots', snapshot, receipt.cleanup)
        release('pictures', picture, receipt.cleanup)
        release('recorders', recorder, receipt.cleanup)
        for (const resource of images.values()) release('images', resource, receipt.cleanup)
        if (receipt.cleanup.failures.length) receipt.status = 'failed'
        await save(`${item.directory}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n')
      }
    }
    assert.equal(report.fixtures.length, CASES.length)
    assert.ok(report.fixtures.every(receipt => receipt.status === 'passed'), 'all fixed fixtures must pass')
    report.status = 'passed'
  } catch (error) { failures.push(errorText(error)); report.status = 'failed' }
  finally {
    release('surfaces', surface); release('fonts', font)
    for (const [field, action] of [['sourceAfter', sourceHashes], ['exportsAfter', () => exportInventory(frames)]]) {
      try { report[field] = await action() }
      catch (error) { failures.push(errorText(error)) }
    }
    try {
      assert.deepEqual(report.sourceAfter, report.sourceBefore, 'replay sources changed during execution')
      assert.deepEqual(report.exportsAfter, report.exportsBefore, 'Rust input exports changed during execution')
      if (report.canvasKitInputs) {
        assert.deepEqual(descriptor('package.json', await fileBytes(resolve(canvaskitDir, 'package.json'))), report.canvasKitInputs.package)
        for (const input of report.canvasKitInputs.files) assert.deepEqual(
          descriptor(input.path, await fileBytes(resolve(canvaskitDir, input.path))), input)
      }
      assert.deepEqual(report.cleanup.released, report.cleanup.created, 'CanvasKit resources remain live')
      assert.deepEqual(report.cleanup.failures, [], 'CanvasKit cleanup failures')
    } catch (error) { failures.push(errorText(error)) }
    for (const receipt of report.fixtures) if (receipt.status === 'running') receipt.status = 'blocked'
    if (failures.length) { report.status = 'failed'; report.errors = failures }
    report.finishedAt = new Date().toISOString()
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  return report
}

export async function main(argv = process.argv.slice(2)) {
  const options = {}, names = new Map([['--frames', 'frames'], ['--canvaskit-dir', 'canvaskitDir'], ['--out', 'out']])
  for (let index = 0; index < argv.length; index++) {
    const name = names.get(argv[index]), value = argv[++index]
    assert.ok(name && value && !value.startsWith('--') && !options[name],
      'Expected --frames <Rust-export-directory> --canvaskit-dir <0.42.0-package-root> --out <new-directory>, each once')
    options[name] = resolve(value)
  }
  for (const name of names.values()) assert.ok(options[name], `missing ${name}`)
  const report = await runStackingFrameReplay(options)
  process.stdout.write(JSON.stringify({ status: report.status, backend: report.backend,
    fixtures: report.fixtures.length, report: resolve(options.out, 'report.json'), errors: report.errors ?? [] }) + '\n')
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1 })
}
