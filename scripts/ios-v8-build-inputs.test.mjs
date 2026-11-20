import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateIOSV8BuildInputs, IOS_V8_BUILD_INPUT_CONTRACT } from './ios-v8-build-inputs.mjs'

const valid = {
  target: IOS_V8_BUILD_INPUT_CONTRACT.target,
  architecture: IOS_V8_BUILD_INPUT_CONTRACT.simulatorArchitecture,
  archivePath: '/validation/librusty_v8.a',
  archivePin: IOS_V8_BUILD_INPUT_CONTRACT.archive.sha256,
  archiveSha256: IOS_V8_BUILD_INPUT_CONTRACT.archive.sha256,
  archiveBytes: IOS_V8_BUILD_INPUT_CONTRACT.archive.bytes,
  bindingPath: '/validation/src_binding_release_aarch64-apple-ios-sim.rs',
  bindingName: IOS_V8_BUILD_INPUT_CONTRACT.binding.file,
  bindingSha256: IOS_V8_BUILD_INPUT_CONTRACT.binding.sha256,
}

test('iOS V8 input contract blocks an unconfigured native build', () => {
  const receipt = evaluateIOSV8BuildInputs({ target: IOS_V8_BUILD_INPUT_CONTRACT.target })
  assert.equal(receipt.status, 'blocked')
  assert.deepEqual(receipt.missing, [
    'RUSTY_V8_ARCHIVE',
    'RUSTY_V8_ARCHIVE_SHA256',
    'RUSTY_V8_SRC_BINDING_PATH',
  ])
})

test('iOS V8 input contract rejects a known-bad archive pin or binding', () => {
  const archive = evaluateIOSV8BuildInputs({ ...valid, archivePin: '0'.repeat(64) })
  assert.equal(archive.status, 'failed')
  assert.match(archive.failures.join('\n'), /ARCHIVE_SHA256/)

  const binding = evaluateIOSV8BuildInputs({ ...valid, bindingName: 'src_binding_wrong_target.rs' })
  assert.equal(binding.status, 'failed')
  assert.match(binding.failures.join('\n'), /binding filename/)

  const architecture = evaluateIOSV8BuildInputs({ ...valid, architecture: 'x86_64' })
  assert.equal(architecture.status, 'failed')
  assert.match(architecture.failures.join('\n'), /simulator architecture/)
})

test('iOS V8 input contract records the matched archive, binding and GN recipe', () => {
  const receipt = evaluateIOSV8BuildInputs(valid)
  assert.equal(receipt.status, 'passed')
  assert.equal(receipt.archive.staticConsistency, 'consistent-static')
  assert.equal(receipt.archive.snapshotMagic, '0xc0de05ca')
  assert.equal(receipt.binding.file, IOS_V8_BUILD_INPUT_CONTRACT.binding.file)
  assert.equal(receipt.gn.v8_enable_lite_mode, true)
  assert.equal(receipt.gn.v8_jitless, true)
  assert.deepEqual(receipt.gn.targetFeatureChangesFromOfficialBaseline, { added: [], removed: [] })
})
