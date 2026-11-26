import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs } from './native-artifact-release-smoke.mjs'

test('native artifact release smoke defaults to the raw mini-program fixture', () => {
  const options = parseArgs([])
  assert.match(options.project, /examples\/apps\/community\/miniprogram-demo-text$/)
  assert.match(options.simulatorBin, /target\/release\/weapp-simulator$/)
  assert.match(options.out, /private-validation\/weapp-container\/native-artifact-release-/)
})

test('native artifact release smoke accepts explicit fixture, simulator, and output paths', () => {
  const options = parseArgs([
    '--',
    '--project', '/tmp/native project',
    '--simulator-bin', '/tmp/release simulator',
    '--out', '/tmp/native evidence',
  ])
  assert.equal(options.project, '/tmp/native project')
  assert.equal(options.simulatorBin, '/tmp/release simulator')
  assert.equal(options.out, '/tmp/native evidence')
})

test('native artifact release smoke rejects unknown, incomplete, and duplicate options', () => {
  assert.throws(() => parseArgs(['--unknown', 'value']), /Unknown option/)
  assert.throws(() => parseArgs(['--project']), /requires a value/)
  assert.throws(() => parseArgs(['--out', '/tmp/first', '--out', '/tmp/second']), /Duplicate option/)
})
