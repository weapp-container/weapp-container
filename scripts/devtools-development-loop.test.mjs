import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs } from './devtools-development-loop-smoke.mjs'

test('development loop smoke defaults to the repository fixture and Web surface', () => {
  const options = parseArgs([])
  assert.match(options.project, /examples\/apps\/devtools-loop-app$/)
  assert.equal(options.surface, 'web')
  assert.equal(options.timeoutMs, 120_000)
  assert.match(options.reportPath, /private-validation\/weapp-container\/devtools-loop\/report\.json$/)
})

test('development loop smoke parses an existing bundle and desktop surface', () => {
  const options = parseArgs(['--project', '/tmp/mini program', '--install-root', '/tmp/DevTools Bundle', '--surface', 'desktop', '--timeout', '5000', '--out', '/tmp/loop-report.json'])
  assert.equal(options.project, '/tmp/mini program')
  assert.equal(options.installRoot, '/tmp/DevTools Bundle')
  assert.equal(options.surface, 'desktop')
  assert.equal(options.timeoutMs, 5000)
  assert.equal(options.reportPath, '/tmp/loop-report.json')
})

test('development loop smoke rejects unsafe or incomplete arguments', () => {
  assert.throws(() => parseArgs(['--unknown', 'value']), /Unknown option/)
  assert.throws(() => parseArgs(['--surface', 'mobile']), /surface must be web or desktop/)
  assert.throws(() => parseArgs(['--timeout', '999']), /at least 1000/)
  assert.throws(() => parseArgs(['--out']), /requires a value/)
  assert.throws(() => parseArgs(['--surface', 'web', '--surface', 'desktop']), /Duplicate option/)
})
