import assert from 'node:assert/strict'
import test from 'node:test'
import { finishIOSBuild, hashIOSSourceFiles, inspectIOSSkiaBuildInputs } from './ios-app-execution-evidence.mjs'

const source = {
  sourceCommit: 'a'.repeat(40),
  sourceSha256: 'b'.repeat(64),
  workingTreeDirty: false,
  workingTreeScope: [],
}
const archive = {
  status: 'passed',
  engine: 'v8',
  target: 'aarch64-apple-ios-sim',
  linkedPath: '/validation/libcontainer_host_ios.a',
  sha256: 'c'.repeat(64),
}
const skiaInputs = { status: 'passed', mode: 'locked-cargo-source' }

test('iOS source inventory records deleted tracked inputs without reading them', () => {
  const files = hashIOSSourceFiles('/checkout', ['deleted.bin', 'present.bin'], {
    exists: path => path.endsWith('present.bin'),
    read: path => Buffer.from(path),
  })
  assert.match(files['deleted.bin'], /^[0-9a-f]{64}$/)
  assert.match(files['present.bin'], /^[0-9a-f]{64}$/)
  assert.notEqual(files['deleted.bin'], files['present.bin'])
})

test('V8 iOS build receipt requires and retains verified runtime inputs', () => {
  assert.throws(() => finishIOSBuild(source, source, Buffer.from('app'), 'v8', archive, 'smoke', undefined, skiaInputs), /V8 archive/)

  const engineInputs = {
    status: 'passed',
    target: 'aarch64-apple-ios-sim',
    archive: { sha256: 'd'.repeat(64) },
    binding: { sha256: 'e'.repeat(64) },
  }
  const receipt = finishIOSBuild(source, source, Buffer.from('app'), 'v8', archive, 'smoke', engineInputs, skiaInputs)
  assert.strictEqual(receipt.engineInputs, engineInputs)
  assert.strictEqual(receipt.skiaBuildInputs, skiaInputs)
  assert.equal(receipt.status, 'passed')
})

test('V8 iOS build receipt rejects target drift in runtime inputs', () => {
  assert.throws(() => finishIOSBuild(source, source, Buffer.from('app'), 'v8', archive, 'smoke', {
    status: 'passed', target: 'aarch64-apple-ios',
  }, skiaInputs), /V8 archive/)
})

test('iOS build receipt stays unknown when caller-provided Skia inputs cannot be verified', () => {
  const receipt = finishIOSBuild(source, source, Buffer.from('app'), 'quickjs', {
    ...archive, engine: 'quickjs',
  }, 'smoke', undefined, { status: 'unknown', mode: 'caller-configured' })
  assert.equal(receipt.status, 'unknown')
})

test('iOS build receipt rejects blocked or failed Skia inputs', () => {
  for (const status of ['blocked', 'failed']) {
    assert.throws(() => finishIOSBuild(source, source, Buffer.from('app'), 'quickjs', {
      ...archive, engine: 'quickjs',
    }, 'smoke', undefined, { status, mode: 'locked-cargo-source-unavailable' }), /Skia build inputs/)
  }
})

test('iOS Skia build selects the locked source and bundled GN when unconfigured', () => {
  const calls = []
  const sourceDir = '/fixture/skia-bindings/skia'
  const available = new Set([
    `${sourceDir}/.gn`,
    `${sourceDir}/bin/gn`,
    `${sourceDir}/include/core/SkTypes.h`,
    `${sourceDir}/third_party/externals/freetype/include/freetype/config/ftheader.h`,
    `${sourceDir}/third_party/externals/libpng/png.h`,
    `${sourceDir}/third_party/gn/gn`,
  ])
  const report = inspectIOSSkiaBuildInputs({
    root: '/fixture', cargoPath: '/toolchain/cargo', environment: {},
    exists: path => available.has(path),
    run: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ packages: [{
        name: 'skia-bindings', version: '0.157.0', source: 'registry+https://example.test',
        manifest_path: '/fixture/skia-bindings/Cargo.toml',
      }] }) }
    },
  })
  assert.equal(report.status, 'passed')
  assert.equal(report.mode, 'locked-cargo-source')
  assert.equal(report.sourceDir, sourceDir)
  assert.equal(report.gnCommand, `${sourceDir}/third_party/gn/gn`)
  assert.deepEqual(calls[0].args, ['metadata', '--locked', '--format-version', '1'])
})

test('iOS Skia build preserves caller-provided configuration', () => {
  const report = inspectIOSSkiaBuildInputs({
    environment: { SKIA_LIBRARY_SEARCH_PATH: '/caller/skia/lib' },
    run: () => assert.fail('locked Cargo source must not replace caller settings'),
  })
  assert.equal(report.status, 'unknown')
  assert.equal(report.mode, 'caller-configured')
  assert.equal(report.librarySearchPath, '/caller/skia/lib')
})

test('iOS Skia build treats caller tool overrides as unknown provenance', () => {
  const report = inspectIOSSkiaBuildInputs({
    environment: { SKIA_GN_COMMAND: '/caller/gn' },
    run: () => assert.fail('locked Cargo source must not replace caller settings'),
  })
  assert.equal(report.status, 'unknown')
  assert.equal(report.mode, 'caller-configured')
  assert.equal(report.gnCommand, '/caller/gn')
  assert.deepEqual(report.callerOverrides, ['SKIA_GN_COMMAND'])
})

test('iOS Skia build reports unavailable locked sources as unknown', () => {
  const report = inspectIOSSkiaBuildInputs({
    root: '/fixture', cargoPath: '/toolchain/cargo', environment: {},
    run: () => ({ status: 1, stderr: 'cargo metadata unavailable' }),
  })
  assert.equal(report.status, 'unknown')
  assert.equal(report.mode, 'locked-cargo-source-unavailable')
  assert.match(report.reason, /cargo metadata unavailable/)
})
