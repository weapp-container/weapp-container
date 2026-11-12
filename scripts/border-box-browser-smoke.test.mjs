import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BORDER_CASES, runBorderBoxSmoke } from './border-box-browser-smoke.mjs'

async function withFixtures(run) {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-border-gate-'))
  const framesDir = join(directory, 'frames'), outDir = join(directory, 'report')
  await mkdir(framesDir)
  const write = async (engine, name, suffix = '') => writeFile(join(framesDir, `${engine}-${name}${suffix}.json`), JSON.stringify({
    schemaVersion: 1, engine, case: name, frame: { viewport: { width: 128, height: 128 } },
    samples: [{ x: 1, y: 1, rgba: [255, 0, 0, 255] }],
  }))
  try { await run({ framesDir, outDir, write }) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

for (const mode of ['missing-engine', 'missing-case', 'duplicate-case', 'unexpected-case']) {
  test(`border frame gate refuses ${mode} before server/browser allocation`, () => withFixtures(async ({ write, ...options }) => {
    for (const engine of ['quickjs', 'v8']) for (const name of BORDER_CASES) {
      if (mode === 'missing-engine' && engine === 'v8' || mode === 'missing-case' && engine === 'v8' && name === 'dynamic-after') continue
      await write(engine, name)
    }
    if (mode === 'duplicate-case') await write('v8', 'dynamic-after', '-duplicate')
    if (mode === 'unexpected-case') await write('v8', 'not-a-border-case')
    // A caller cannot weaken the fixed suite's matrix to whatever it exported.
    const report = await runBorderBoxSmoke({ ...options, expectedCases: ['asymmetric-content-box'] })
    assert.equal(report.status, 'failed')
    assert.match(report.error, /missing, duplicated or unexpected fixture cases/)
    assert.equal(report.url, undefined)
    assert.equal(report.browserVersion, undefined)
    assert.deepEqual(report.cleanup, {})
    assert.equal(JSON.parse(await readFile(join(options.outDir, 'report.json'))).status, 'failed')
  }))
}

test('border frame gate binds exactly fourteen cases to two engines, and import creates no browser', () => withFixtures(async ({ write, ...options }) => {
  assert.equal(BORDER_CASES.length, 14)
  assert.equal(Object.isFrozen(BORDER_CASES), true)
  for (const engine of ['quickjs', 'v8']) for (const name of BORDER_CASES) await write(engine, name)
  // Intentionally missing dependencies stop this contract test before a server
  // is created. No fake frames are ever submitted as browser/GPU acceptance.
  const report = await runBorderBoxSmoke(options)
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.expectedMatrix, { engines: ['quickjs', 'v8'], cases: [...BORDER_CASES].sort(), fixtures: 28 })
  assert.equal(report.url, undefined)
  assert.equal(report.browserVersion, undefined)
  assert.deepEqual(report.cleanup, {})
}))
