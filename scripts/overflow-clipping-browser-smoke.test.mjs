import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runAcceptedFrameSmoke, runOverflowClippingSmoke } from './overflow-clipping-browser-smoke.mjs'

async function fixtureDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-clip-gate-'))
  const framesDir = join(directory, 'frames'), outDir = join(directory, 'report')
  await mkdir(framesDir)
  try { await run({ directory, framesDir, outDir }) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('incomplete engine/case exports cannot pass or create browser resources', () => fixtureDirectory(async options => {
  const fixture = { schemaVersion: 1, engine: 'quickjs', case: 'visible',
    frame: { viewport: { width: 128, height: 128 } }, samples: [{ x: 1, y: 1, rgba: [255, 0, 0, 255] }] }
  await writeFile(join(options.framesDir, 'quickjs-visible.json'), JSON.stringify(fixture))
  const report = await runOverflowClippingSmoke(options)
  assert.equal(report.status, 'failed')
  assert.match(report.error, /missing, duplicated or unexpected fixture cases/)
  assert.equal(report.url, undefined)
  assert.equal(report.browserVersion, undefined)
  assert.deepEqual(report.cleanup, {})
  assert.equal(JSON.parse(await readFile(join(options.outDir, 'report.json'))).status, 'failed')
}))

test('pre-cancelled gate releases its signal listener without opening a server or browser', () => fixtureDirectory(async options => {
  const controller = new AbortController()
  controller.abort(new Error('ERR_CANCELLED: fixture stop'))
  const report = await runOverflowClippingSmoke({ ...options, signal: controller.signal })
  assert.equal(report.status, 'failed')
  assert.match(report.error, /ERR_CANCELLED: fixture stop/)
  assert.equal(report.url, undefined)
  assert.equal(report.browserVersion, undefined)
  assert.deepEqual(report.cleanup, {})
}))

for (const expectedCases of [undefined, [], ['same', 'same'], ['']]) {
  test(`shared frame gate requires an explicit nonempty unique matrix: ${JSON.stringify(expectedCases)}`, () => fixtureDirectory(async options => {
    const report = await runAcceptedFrameSmoke({ ...options, expectedCases })
    assert.equal(report.status, 'failed')
    assert.match(report.error, /explicit expected case matrix/)
    assert.equal(report.url, undefined)
    assert.equal(report.browserVersion, undefined)
    assert.deepEqual(report.cleanup, {})
  }))
}
